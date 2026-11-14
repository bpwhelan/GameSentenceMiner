//! Frozen desktop selection, following OneShotOCR's native pixel-buffer design:
//! https://github.com/bpwhelan/OneShotOCR/blob/c87f413ce502e2ff2e0c1b0fb5eb41b33abefa42/src/overlay.rs
//! Win32 owns this window and message loop. No webview, JavaScript, or HTML.
use image::RgbaImage;

#[cfg(not(windows))]
pub fn select(_cancel: &dyn Fn() -> bool) -> Result<Option<RgbaImage>, String> {
    Err("Native area selection is currently available on Windows".into())
}
#[cfg(windows)]
pub fn select(cancel: &dyn Fn() -> bool) -> Result<Option<RgbaImage>, String> {
    win::select(cancel)
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::ffi::c_void;
    use windows::{
        core::w,
        Win32::{
            Foundation::*,
            Graphics::{Dwm::*, Gdi::*},
            System::LibraryLoader::GetModuleHandleW,
            UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
        },
    };
    struct Picker {
        image: RgbaImage,
        bright: Vec<u32>,
        dark: Vec<u32>,
        paint: Vec<u32>,
        start: Option<(i32, i32)>,
        point: (i32, i32),
        selected: Option<[u32; 4]>,
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn reversed_drag_clamps_to_physical_pixels_and_clicks_cancel() {
            let mut p = Picker {
                image: RgbaImage::new(100, 50),
                bright: vec![],
                dark: vec![],
                paint: vec![],
                start: Some((80, 40)),
                point: (-10, -20),
                selected: None,
            };
            assert_eq!(p.rect(), Some([0, 0, 80, 40]));
            p.point = (81, 41);
            assert_eq!(p.rect(), None);
            p.point = (120, 60);
            assert_eq!(p.rect(), Some([80, 40, 100, 50]));
        }
    }
    impl Picker {
        fn rect(&self) -> Option<[u32; 4]> {
            let (sx, sy) = self.start?;
            let (x, y) = self.point;
            let w = self.image.width() as i32;
            let h = self.image.height() as i32;
            let r = [
                sx.min(x).clamp(0, w) as u32,
                sy.min(y).clamp(0, h) as u32,
                sx.max(x).clamp(0, w) as u32,
                sy.max(y).clamp(0, h) as u32,
            ];
            (r[2] - r[0] >= 3 && r[3] - r[1] >= 3).then_some(r)
        }
        unsafe fn draw(&mut self, hwnd: HWND) {
            self.paint.copy_from_slice(&self.dark);
            let width = self.image.width() as usize;
            if let Some([x, y, r, b]) = self.rect() {
                for row in y..b {
                    let offset = row as usize * width;
                    self.paint[offset + x as usize..offset + r as usize]
                        .copy_from_slice(&self.bright[offset + x as usize..offset + r as usize]);
                    self.paint[offset + x as usize] = 0x00ff3b30;
                    self.paint[offset + r as usize - 1] = 0x00ff3b30;
                }
                for col in x..r {
                    self.paint[y as usize * width + col as usize] = 0x00ff3b30;
                    self.paint[(b as usize - 1) * width + col as usize] = 0x00ff3b30;
                }
            }
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut ps);
            let mut info = BITMAPINFO::default();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: self.image.width() as i32,
                biHeight: -(self.image.height() as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            StretchDIBits(
                dc,
                0,
                0,
                self.image.width() as i32,
                self.image.height() as i32,
                0,
                0,
                self.image.width() as i32,
                self.image.height() as i32,
                Some(self.paint.as_ptr().cast()),
                &info,
                DIB_RGB_COLORS,
                SRCCOPY,
            );
            let _ = EndPaint(hwnd, &ps);
        }
    }
    unsafe extern "system" fn procedure(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Picker;
        if state.is_null() {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let state = &mut *state;
        match msg {
            WM_ERASEBKGND => return LRESULT(1),
            WM_PAINT => {
                state.draw(hwnd);
                return LRESULT(0);
            }
            WM_LBUTTONDOWN => {
                state.point = (
                    (lparam.0 as u16 as i16) as i32,
                    ((lparam.0 >> 16) as u16 as i16) as i32,
                );
                state.start = Some(state.point);
                SetCapture(hwnd);
            }
            WM_MOUSEMOVE => {
                state.point = (
                    (lparam.0 as u16 as i16) as i32,
                    ((lparam.0 >> 16) as u16 as i16) as i32,
                );
                if state.start.is_some() {
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
            }
            WM_LBUTTONUP => {
                state.point = (
                    (lparam.0 as u16 as i16) as i32,
                    ((lparam.0 >> 16) as u16 as i16) as i32,
                );
                state.selected = state.rect();
                let _ = ReleaseCapture();
                let _ = DestroyWindow(hwnd);
            }
            WM_RBUTTONDOWN | WM_CLOSE => {
                let _ = DestroyWindow(hwnd);
            }
            WM_KEYDOWN if wparam.0 == VK_ESCAPE.0 as usize => {
                let _ = DestroyWindow(hwnd);
            }
            WM_DESTROY => {
                let _ = KillTimer(Some(hwnd), 1);
                PostQuitMessage(0);
            }
            _ => return DefWindowProcW(hwnd, msg, wparam, lparam),
        }
        LRESULT(0)
    }
    pub fn select(cancel: &dyn Fn() -> bool) -> Result<Option<RgbaImage>, String> {
        select_ready(cancel, |_, _, _, _| {})
    }
    fn select_ready(
        cancel: &dyn Fn() -> bool,
        ready: impl FnOnce(HWND, (u32, u32), f64, f64),
    ) -> Result<Option<RgbaImage>, String> {
        // Tauri windows may use logical units; the native picker and capture
        // always use physical pixels, including mixed-DPI/negative-origin displays.
        let _dpi = DpiScope::new();
        let started = std::time::Instant::now();
        let snapshot = gsm_capture::desktop_snapshot()?;
        let captured_ms = started.elapsed().as_secs_f64() * 1000.;
        if cancel() {
            return Ok(None);
        }
        let size = snapshot.image.dimensions();
        pick(
            snapshot.image,
            snapshot.left,
            snapshot.top,
            cancel,
            |hwnd| ready(hwnd, size, captured_ms, 0.),
        )
    }

    struct DpiScope(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT);
    impl DpiScope {
        fn new() -> Self {
            Self(unsafe {
                windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(
                    windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                )
            })
        }
    }
    impl Drop for DpiScope {
        fn drop(&mut self) {
            if !self.0 .0.is_null() {
                unsafe {
                    windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(self.0);
                }
            }
        }
    }
    fn pick(
        image: RgbaImage,
        left: i32,
        top: i32,
        cancel: &dyn Fn() -> bool,
        ready: impl FnOnce(HWND),
    ) -> Result<Option<RgbaImage>, String> {
        let (w, h) = image.dimensions();
        let bright: Vec<_> = image
            .pixels()
            .map(|p| (p[0] as u32) << 16 | (p[1] as u32) << 8 | p[2] as u32)
            .collect();
        let dark: Vec<_> = image
            .pixels()
            .map(|p| {
                ((p[0] as u32 * 45 / 100) << 16)
                    | ((p[1] as u32 * 45 / 100) << 8)
                    | (p[2] as u32 * 45 / 100)
            })
            .collect();
        let mut picker = Box::new(Picker {
            image,
            paint: dark.clone(),
            bright,
            dark,
            start: None,
            point: (0, 0),
            selected: None,
        });
        unsafe {
            let instance = HINSTANCE(GetModuleHandleW(None).map_err(|e| e.to_string())?.0);
            let class = w!("GsmNativeOcrSelection");
            let cursor = LoadCursorW(None, IDC_CROSS).map_err(|e| e.to_string())?;
            let wc = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: instance,
                lpszClassName: class,
                hCursor: cursor,
                ..Default::default()
            };
            // The single worker reuses this class on each invocation.
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                class,
                w!("GSM OCR"),
                WS_POPUP,
                left,
                top,
                w as i32,
                h as i32,
                None,
                None,
                Some(instance),
                Some((&mut *picker as *mut Picker).cast::<c_void>()),
            )
            .map_err(|e| e.to_string())?;
            let disable = 1i32;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &disable as *const _ as *const c_void,
                4,
            );
            SetTimer(Some(hwnd), 1, 100, None);
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);
            let _ = InvalidateRect(Some(hwnd), None, false);
            let _ = UpdateWindow(hwnd);
            ready(hwnd);
            let mut message = MSG::default();
            loop {
                let received = GetMessageW(&mut message, None, 0, 0).0;
                if received <= 0 {
                    break;
                }
                if cancel() {
                    picker.selected = None;
                    let _ = DestroyWindow(hwnd);
                } else {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = DestroyWindow(hwnd);
            }
        }
        Ok(picker.selected.map(|[x, y, r, b]| {
            image::imageops::crop_imm(&picker.image, x, y, r - x, b - y).to_image()
        }))
    }
    #[cfg(test)]
    #[test]
    #[ignore = "Briefly opens and closes real desktop selectors; writes timing and CPU measurements"]
    fn selector_activation_benchmark() {
        use std::time::{Duration, Instant};
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        fn cpu() -> f64 {
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            unsafe {
                GetProcessTimes(
                    GetCurrentProcess(),
                    &mut created,
                    &mut exited,
                    &mut kernel,
                    &mut user,
                )
                .unwrap();
            }
            let seconds = |v: FILETIME| {
                (((v.dwHighDateTime as u64) << 32) | v.dwLowDateTime as u64) as f64 / 10_000_000.
            };
            seconds(kernel) + seconds(user)
        }
        let path = std::env::var("GSM_SELECTOR_BENCH_OUT").expect("benchmark output path");
        let count = std::env::var("GSM_SELECTOR_BENCH_COUNT")
            .ok()
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(12);
        let original = unsafe { GetForegroundWindow() };
        let mut samples = Vec::new();
        let wall = Instant::now();
        let before = cpu();
        for _ in 0..count {
            let started = Instant::now();
            let used = cpu();
            let result = select_ready(&|| false, |hwnd, size, capture_ms, compose_ms| {
                let ready_ms = started.elapsed().as_secs_f64() * 1000.;
                unsafe { let _ = DwmFlush(); }
                let presented_ms = started.elapsed().as_secs_f64() * 1000.;
                samples.push(serde_json::json!({"size":size,"capture_ms":capture_ms,"compose_ms":compose_ms,"ready_ms":ready_ms,"presented_ms":presented_ms,"cpu_ms":(cpu()-used)*1000.}));
                unsafe { PostMessageW(Some(hwnd), WM_KEYDOWN, WPARAM(VK_ESCAPE.0 as usize), LPARAM(0)).unwrap(); }
            }).unwrap();
            assert!(result.is_none());
            std::thread::sleep(Duration::from_millis(150));
        }
        unsafe {
            let _ = SetForegroundWindow(original);
        }
        let elapsed = wall.elapsed().as_secs_f64();
        let used = cpu() - before;
        let logical_cpus = std::thread::available_parallelism().unwrap().get();
        let result = serde_json::json!({"samples":samples,"wall_seconds":elapsed,"cpu_seconds":used,"logical_cpus":logical_cpus,"total_machine_percent":used/elapsed*100./logical_cpus as f64});
        std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        println!("SELECTORBENCH {result}");
    }
    #[cfg(test)]
    #[test]
    fn desktop_snapshot_is_fresh_opaque_and_does_not_start_sessions_or_leak_gdi() {
        use windows::Win32::System::Threading::{
            GetCurrentProcess, GetGuiResources, GR_GDIOBJECTS,
        };
        let _dpi = DpiScope::new();
        for color in [[200u8, 100, 50, 255], [40, 180, 220, 255]] {
            let source = RgbaImage::from_pixel(200, 120, image::Rgba(color));
            pick(source, 100, 100, &|| false, |hwnd| {
                unsafe {
                    let _ = DwmFlush();
                }
                let sessions = gsm_capture::statistics()[0];
                let Ok(warm) = gsm_capture::desktop_snapshot() else {
                    // Non-interactive/locked Windows sessions reject desktop DC BitBlt with E_ACCESSDENIED.
                    unsafe {
                        PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).unwrap();
                    }
                    return;
                };
                drop(warm); // warm OS bookkeeping
                let resources = unsafe { GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) };
                for _ in 0..6 {
                    let snapshot = gsm_capture::desktop_snapshot().unwrap();
                    let pixel = snapshot
                        .image
                        .get_pixel((110 - snapshot.left) as u32, (120 - snapshot.top) as u32);
                    assert_eq!(
                        *pixel,
                        image::Rgba([
                            (color[0] as u32 * 45 / 100) as u8,
                            (color[1] as u32 * 45 / 100) as u8,
                            (color[2] as u32 * 45 / 100) as u8,
                            255
                        ])
                    );
                    assert_eq!(gsm_capture::statistics()[0], sessions);
                }
                assert_eq!(
                    unsafe { GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) },
                    resources
                );
                unsafe {
                    PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).unwrap();
                }
            })
            .unwrap();
        }
    }
    #[cfg(test)]
    #[test]
    fn native_window_paints_selects_cancels_and_reopens() {
        // Drive this test's own HWND message loop, not the user's mouse or any
        // external window. This exercises the real GDI surface and destruction.
        let _dpi = DpiScope::new();
        let source = RgbaImage::from_fn(200, 120, |x, y| image::Rgba([x as u8, y as u8, 42, 255]));
        for cancel in [true, false, true, false] {
            let image = pick(source.clone(), 100, 100, &|| false, |hwnd| unsafe {
                if cancel {
                    PostMessageW(
                        Some(hwnd),
                        WM_KEYDOWN,
                        WPARAM(VK_ESCAPE.0 as usize),
                        LPARAM(0),
                    )
                    .unwrap();
                } else {
                    PostMessageW(
                        Some(hwnd),
                        WM_LBUTTONDOWN,
                        WPARAM(0),
                        LPARAM(10 | (20 << 16)),
                    )
                    .unwrap();
                    PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(0), LPARAM(90 | (80 << 16)))
                        .unwrap();
                    PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), LPARAM(90 | (80 << 16)))
                        .unwrap();
                }
            })
            .unwrap();
            if cancel {
                assert!(image.is_none());
            } else {
                let image = image.unwrap();
                assert_eq!(image.dimensions(), (80, 60));
                assert_eq!(image.get_pixel(0, 0), source.get_pixel(10, 20));
                assert_eq!(image.get_pixel(79, 59), source.get_pixel(89, 79));
            }
        }
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let image = pick(
            source,
            100,
            100,
            &|| cancelled.load(std::sync::atomic::Ordering::Relaxed),
            |_| cancelled.store(true, std::sync::atomic::Ordering::Relaxed),
        )
        .unwrap();
        assert!(
            image.is_none(),
            "stop cancels the native window through its timer"
        );
    }
}
