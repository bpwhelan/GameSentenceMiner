//! A persistent WGC session. Keep only the latest GPU frame; copy pixels to the
//! CPU when OCR asks, rather than rebuilding capture or reading back at 60+ FPS.
use image::RgbaImage;
use std::{
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use windows::{
    core::{factory, IInspectable, Interface},
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{
            Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
            GraphicsCaptureSession,
        },
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::{HMODULE, HWND},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::*,
            Dxgi::IDXGIDevice,
            Gdi::{MonitorFromPoint, HMONITOR, MONITOR_DEFAULTTONEAREST},
        },
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
        },
    },
};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Target {
    Window(u64),
    Monitor(usize),
}
impl Target {
    pub fn monitor(bounds: [f64; 4]) -> Self {
        let point = windows::Win32::Foundation::POINT {
            x: (bounds[0] + bounds[2] / 2.) as i32,
            y: (bounds[1] + bounds[3] / 2.) as i32,
        };
        Self::Monitor(unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) }.0 as usize)
    }
}
// Weak registry entries do not keep capture alive after its final consumer stops.
type Handle = Arc<Mutex<Session>>;
fn registry() -> &'static Mutex<std::collections::HashMap<Target, std::sync::Weak<Mutex<Session>>>>
{
    static SESSIONS: std::sync::OnceLock<
        Mutex<std::collections::HashMap<Target, std::sync::Weak<Mutex<Session>>>>,
    > = std::sync::OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}
static CREATED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static READBACKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static REUSED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn statistics() -> [u64; 3] {
    use std::sync::atomic::Ordering::Relaxed;
    [
        CREATED.load(Relaxed),
        READBACKS.load(Relaxed),
        REUSED.load(Relaxed),
    ]
}
pub struct Capture {
    session: Option<(Target, Handle)>,
    consumer: u64,
}
impl Default for Capture {
    fn default() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Self {
            session: None,
            consumer: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.clear();
    }
}
impl Capture {
    // Session pacing is shared: don't let a slow OCR consumer throttle another
    // subscriber. Pull-only CPU readback remains independent of GPU callbacks.
    pub fn set_interval(&self, interval: Duration) {
        if let Some((_, session)) = &self.session {
            let mut session = session.lock().unwrap();
            if session.consumers.insert(self.consumer, interval) != Some(interval) {
                session.pace();
            }
        }
    }
    pub fn clear(&mut self) {
        if let Some((_, session)) = self.session.take() {
            let mut session = session.lock().unwrap();
            session.consumers.remove(&self.consumer);
            session.pace();
        }
    }
    pub fn grab_shared(
        &mut self,
        target: Target,
        expected: (u32, u32),
    ) -> Result<Arc<RgbaImage>, String> {
        if let Target::Window(id) = target {
            use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow};
            let hwnd = HWND(id as usize as *mut _);
            if unsafe { !IsWindow(Some(hwnd)).as_bool() || IsIconic(hwnd).as_bool() } {
                self.clear();
                return Err("Capture target is closed or minimized".into());
            }
        }
        if self.session.as_ref().is_none_or(|(t, _)| *t != target) {
            self.clear();
            let mut registry = registry().lock().unwrap();
            registry.retain(|_, s| s.strong_count() > 0);
            let shared = if let Some(shared) = registry.get(&target).and_then(|s| s.upgrade()) {
                shared
            } else {
                let shared = Arc::new(Mutex::new(Session::new(target)?));
                registry.insert(target, Arc::downgrade(&shared));
                CREATED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                shared
            };
            {
                let mut session = shared.lock().unwrap();
                session
                    .consumers
                    .insert(self.consumer, Duration::from_millis(16));
                session.pace();
            }
            self.session = Some((target, shared));
        }
        let result = self
            .session
            .as_ref()
            .unwrap()
            .1
            .lock()
            .unwrap()
            .grab(expected);
        if result.is_err() {
            let mut registry = registry().lock().unwrap();
            // Another subscriber may already have replaced this failed session.
            // Never evict its replacement when our older handle reports failure.
            if registry.get(&target).is_some_and(|registered| {
                std::sync::Weak::ptr_eq(
                    registered,
                    &Arc::downgrade(&self.session.as_ref().unwrap().1),
                )
            }) {
                registry.remove(&target);
            }
            drop(registry);
            self.clear();
        }
        result
    }
    pub fn grab(&mut self, target: Target, expected: (u32, u32)) -> Result<RgbaImage, String> {
        self.grab_shared(target, expected)
            .map(|image| (*image).clone())
    }
}
#[derive(Default)]
struct Latest {
    frame: Option<Direct3D11CaptureFrame>,
    closed: bool,
    sequence: u64,
}
impl Latest {
    fn discard(&mut self) {
        if let Some(frame) = self.frame.take() {
            let _ = frame.Close();
        }
    }
}
struct Session {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    item: GraphicsCaptureItem,
    frame_token: i64,
    closed_token: i64,
    latest: Arc<(Mutex<Latest>, Condvar)>,
    staging: Option<(u32, u32, ID3D11Texture2D)>,
    cached: Option<(u64, Arc<RgbaImage>)>,
    consumers: std::collections::HashMap<u64, Duration>,
}
// D3D11 device is multithread-capable; immediate context access is exclusively
// serialized by the session mutex. WinRT frame pool is free-threaded; callbacks
// touch only Latest. No COM context pointer escapes the session.
unsafe impl Send for Session {}
impl Session {
    fn pace(&self) {
        let interval = self
            .consumers
            .values()
            .min()
            .copied()
            .unwrap_or(Duration::from_millis(100));
        let _ = self
            .session
            .SetMinUpdateInterval(windows::Foundation::TimeSpan {
                Duration: (interval.as_nanos() / 100).min(i64::MAX as u128) as i64,
            });
    }
    fn new(target: Target) -> Result<Self, String> {
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(|e| format!("WGC factory: {e}"))?;
        let item: GraphicsCaptureItem = unsafe {
            match target {
                Target::Window(id) => interop
                    .CreateForWindow(HWND(id as usize as *mut _))
                    .map_err(|e| format!("WGC CreateForWindow({id:#x}): {e}"))?,
                Target::Monitor(id) => interop
                    .CreateForMonitor(HMONITOR(id as *mut _))
                    .map_err(|e| format!("WGC CreateForMonitor({id:#x}): {e}"))?,
            }
        };
        let (mut device, mut context) = (None, None);
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|e| format!("WGC D3D11CreateDevice: {e}"))?;
        }
        let device = device.unwrap();
        let context = context.unwrap();
        let dxgi: IDXGIDevice = device.cast().map_err(|e| format!("WGC dxgi cast: {e}"))?;
        let runtime_device: IDirect3DDevice = unsafe {
            CreateDirect3D11DeviceFromDXGIDevice(&dxgi)
                .map_err(|e| format!("WGC CreateDirect3D11DeviceFromDXGIDevice: {e}"))?
        }
        .cast()
        .map_err(|e| format!("WGC IDirect3DDevice cast: {e}"))?;
        let size = item.Size().map_err(|e| format!("WGC item.Size: {e}"))?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &runtime_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            3,
            size,
        )
        .map_err(|e| format!("WGC CreateFreeThreaded({}x{}): {e}", size.Width, size.Height))?;
        let runtime_device = windows::core::AgileReference::new(&runtime_device)
            .map_err(|e| format!("WGC AgileReference: {e}"))?;
        let session = pool
            .CreateCaptureSession(&item)
            .map_err(|e| format!("WGC CreateCaptureSession: {e}"))?;
        let latest = Arc::new((Mutex::new(Latest::default()), Condvar::new()));
        // Construct the owner before registering callbacks so failures clean up.
        let mut this = Self {
            device,
            context,
            pool,
            session,
            item,
            frame_token: 0,
            closed_token: 0,
            latest: latest.clone(),
            staging: None,
            cached: None,
            consumers: Default::default(),
        };
        let frame_size = Mutex::new(size);
        this.frame_token = this.pool.FrameArrived(&TypedEventHandler::<
            Direct3D11CaptureFramePool,
            IInspectable,
        >::new({
            let latest = latest.clone();
            move |pool, _| {
                let Some(pool) = pool.as_ref() else {
                    return Ok(());
                };
                let (lock, wake) = &*latest;
                let mut state = lock.lock().unwrap();
                if state.closed {
                    return Ok(());
                }
                let result = (|| -> windows::core::Result<()> {
                    let frame = pool.TryGetNextFrame()?;
                    let size = frame.ContentSize()?;
                    let mut previous_size = frame_size.lock().unwrap();
                    state.discard();
                    if size != *previous_size {
                        let _ = frame.Close();
                        // Release all outstanding frames before recreating the pool.
                        if size.Width > 0 && size.Height > 0 {
                            pool.Recreate(
                                &runtime_device.resolve()?,
                                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                                3,
                                size,
                            )?;
                            *previous_size = size;
                        }
                    } else {
                        state.sequence += 1;
                        state.frame = Some(frame);
                    }
                    Ok(())
                })();
                if result.is_err() {
                    state.closed = true;
                    state.discard();
                }
                wake.notify_all();
                Ok(())
            }
        }))
        .map_err(|e| format!("WGC FrameArrived: {e}"))?;
        this.closed_token = this.item.Closed(&TypedEventHandler::<
            GraphicsCaptureItem,
            IInspectable,
        >::new(move |_, _| {
            let (lock, wake) = &*latest;
            let mut state = lock.lock().unwrap();
            state.closed = true;
            state.discard();
            wake.notify_all();
            Ok(())
        }))
        .map_err(|e| format!("WGC Closed: {e}"))?;
        let _ = this.session.SetIsBorderRequired(false);
        let _ = this.session.SetIsCursorCaptureEnabled(false);
        this.session
            .StartCapture()
            .map_err(|e| format!("WGC StartCapture: {e}"))?;
        Ok(this)
    }
    fn grab(&mut self, expected: (u32, u32)) -> Result<Arc<RgbaImage>, String> {
        let (lock, wake) = &*self.latest;
        let matches = |frame: &Direct3D11CaptureFrame| {
            frame
                .ContentSize()
                .is_ok_and(|size| (size.Width as u32, size.Height as u32) == expected)
        };
        let (state, _) = wake
            .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(2), |s| {
                !s.closed && !s.frame.as_ref().is_some_and(matches)
            })
            .unwrap();
        if state.closed {
            return Err("Windows Graphics Capture target closed".into());
        }
        let frame = state
            .frame
            .as_ref()
            .ok_or("Timed out waiting for a WGC frame")?;
        if !matches(frame) {
            return Err("WGC target geometry changed during capture".into());
        }
        if let Some((sequence, image)) = &self.cached {
            if *sequence == state.sequence && image.dimensions() == expected {
                REUSED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return Ok(image.clone());
            }
        }
        // Keep the frame locked until the readback is finished: a cloned WinRT
        // reference alone would not prevent the callback from calling Close().
        let mut read = || -> windows::core::Result<RgbaImage> {
            let size = frame.ContentSize()?;
            let (width, height) = (size.Width as u32, size.Height as u32);
            let source: ID3D11Texture2D = unsafe {
                frame
                    .Surface()?
                    .cast::<IDirect3DDxgiInterfaceAccess>()?
                    .GetInterface()?
            };
            if self
                .staging
                .as_ref()
                .is_none_or(|(w, h, _)| (*w, *h) != (width, height))
            {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe {
                    source.GetDesc(&mut desc);
                }
                desc.Width = width;
                desc.Height = height;
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.MiscFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                let mut staging = None;
                unsafe {
                    self.device
                        .CreateTexture2D(&desc, None, Some(&mut staging))?;
                }
                self.staging = Some((width, height, staging.unwrap()));
            }
            let staging = &self.staging.as_ref().unwrap().2;
            let region = D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: width,
                bottom: height,
                back: 1,
            };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            let mut image = RgbaImage::new(width, height);
            unsafe {
                self.context
                    .CopySubresourceRegion(staging, 0, 0, 0, 0, &source, 0, Some(&region));
                self.context
                    .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                for (y, row) in image
                    .as_mut()
                    .chunks_exact_mut(width as usize * 4)
                    .enumerate()
                {
                    let source = std::slice::from_raw_parts(
                        (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                        row.len(),
                    );
                    row.copy_from_slice(source);
                }
                self.context.Unmap(staging, 0);
            }
            for pixel in image.as_mut().chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            Ok(image)
        };
        let image = Arc::new(read().map_err(|e| format!("WGC readback failed: {e}"))?);
        READBACKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.cached = Some((state.sequence, image.clone()));
        Ok(image)
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        {
            let mut state = self.latest.0.lock().unwrap();
            state.closed = true;
            state.discard();
            self.latest.1.notify_all();
        }
        // Never hold the callback mutex while closing the WinRT objects.
        if self.frame_token != 0 {
            let _ = self.pool.RemoveFrameArrived(self.frame_token);
        }
        if self.closed_token != 0 {
            let _ = self.item.RemoveClosed(self.closed_token);
        }
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}
