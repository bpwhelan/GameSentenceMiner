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
    use gsm_capture::desktop::DesktopBitmap;
    use std::ffi::c_void;
    use windows::{
        core::w,
        Win32::{
            Foundation::*,
            Graphics::{Dwm::*, Gdi::*},
            System::LibraryLoader::GetModuleHandleW,
            UI::{
                Controls::{
                    BeginBufferedPaint, BufferedPaintInit, BufferedPaintUnInit, EndBufferedPaint,
                    BPBF_COMPATIBLEBITMAP,
                },
                Input::KeyboardAndMouse::*,
                WindowsAndMessaging::*,
            },
        },
    };
    struct Picker {
        image: DesktopBitmap,
        dimmed: DesktopBitmap,
        start: Option<(i32, i32)>,
        point: (i32, i32),
        selected: Option<RECT>,
    }

    fn selection_rect(
        (width, height): (u32, u32),
        start: Option<(i32, i32)>,
        (x, y): (i32, i32),
    ) -> Option<RECT> {
        let (sx, sy) = start?;
        let rect = RECT {
            left: sx.min(x).clamp(0, width as i32),
            top: sy.min(y).clamp(0, height as i32),
            right: sx.max(x).clamp(0, width as i32),
            bottom: sy.max(y).clamp(0, height as i32),
        };
        (rect.right - rect.left >= 3 && rect.bottom - rect.top >= 3).then_some(rect)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn reversed_drag_clamps_to_physical_pixels_and_clicks_cancel() {
            let select = |point| {
                selection_rect((100, 50), Some((80, 40)), point)
                    .map(|r| [r.left, r.top, r.right, r.bottom])
            };
            assert_eq!(select((-10, -20)), Some([0, 0, 80, 40]));
            assert_eq!(select((81, 41)), None);
            assert_eq!(select((120, 60)), Some([80, 40, 100, 50]));
        }
    }
    impl Picker {
        fn rect(&self) -> Option<RECT> {
            selection_rect(self.image.dimensions(), self.start, self.point)
        }
        unsafe fn draw(&self, dc: HDC, dirty: RECT) {
            let Some(rect) = self.rect() else {
                self.dimmed.blit(dc, dirty);
                return;
            };
            // Compose the dirty area before publishing it so the dimmed
            // background never flashes through a selection during a drag.
            let mut buffer_dc = HDC::default();
            let buffer =
                BeginBufferedPaint(dc, &dirty, BPBF_COMPATIBLEBITMAP, None, &mut buffer_dc);
            if buffer != 0 {
                self.draw_selection(buffer_dc, dirty, rect);
                if EndBufferedPaint(buffer, true).is_ok() {
                    return;
                }
            }
            self.draw_selection(dc, dirty, rect);
        }

        unsafe fn draw_selection(&self, dc: HDC, dirty: RECT, rect: RECT) {
            self.dimmed.blit(dc, dirty);
            self.image.blit(dc, rect);
            let _ = SetDCBrushColor(dc, COLORREF(0x0030_3bff));
            let _ = FrameRect(dc, &rect, HBRUSH(GetStockObject(DC_BRUSH).0));
        }
    }

    struct BufferedPaintThread;
    impl BufferedPaintThread {
        fn init() -> Option<Self> {
            unsafe { BufferedPaintInit() }.ok().map(|()| Self)
        }
    }
    impl Drop for BufferedPaintThread {
        fn drop(&mut self) {
            let _ = unsafe { BufferedPaintUnInit() };
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
        let pointer = || {
            (
                (lparam.0 as u16 as i16) as i32,
                ((lparam.0 >> 16) as u16 as i16) as i32,
            )
        };
        match msg {
            WM_ERASEBKGND => return LRESULT(1),
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut ps);
                if !dc.0.is_null() {
                    (*state).draw(dc, ps.rcPaint);
                }
                let _ = EndPaint(hwnd, &ps);
                return LRESULT(0);
            }
            WM_LBUTTONDOWN => {
                let state = &mut *state;
                state.point = pointer();
                state.start = Some(state.point);
                SetCapture(hwnd);
            }
            WM_MOUSEMOVE => {
                let state = &mut *state;
                let old = state.rect();
                state.point = pointer();
                let new = state.rect();
                if old != new {
                    for rect in [old, new].iter().flatten() {
                        let _ = InvalidateRect(Some(hwnd), Some(rect), false);
                    }
                }
            }
            WM_LBUTTONUP => {
                let state = &mut *state;
                state.point = pointer();
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
        if cancel() {
            return Ok(None);
        }
        let started = std::time::Instant::now();
        let (snapshot, left, top) = gsm_capture::desktop::capture()?;
        let captured_ms = started.elapsed().as_secs_f64() * 1000.;
        if cancel() {
            return Ok(None);
        }
        let size = snapshot.dimensions();
        pick(snapshot, left, top, cancel, |hwnd, compose_ms| {
            ready(hwnd, size, captured_ms, compose_ms)
        })
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
        image: DesktopBitmap,
        left: i32,
        top: i32,
        cancel: &dyn Fn() -> bool,
        ready: impl FnOnce(HWND, f64),
    ) -> Result<Option<RgbaImage>, String> {
        let (w, h) = image.dimensions();
        let started = std::time::Instant::now();
        let dimmed = image.dimmed()?;
        let compose_ms = started.elapsed().as_secs_f64() * 1000.;
        if cancel() {
            return Ok(None);
        }
        let mut picker = Box::new(Picker {
            image,
            dimmed,
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
            let _buffered_paint = BufferedPaintThread::init();
            ready(hwnd, compose_ms);
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
        Ok(picker.selected.map(|r| {
            picker
                .image
                .crop_rgba([r.left as u32, r.top as u32, r.right as u32, r.bottom as u32])
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
            let bitmap = DesktopBitmap::from_rgba(&source).unwrap();
            pick(bitmap, 100, 100, &|| false, |hwnd, _| {
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
            let bitmap = DesktopBitmap::from_rgba(&source).unwrap();
            let image = pick(bitmap, 100, 100, &|| false, |hwnd, _| unsafe {
                if cancel {
                    PostMessageW(
                        Some(hwnd),
                        WM_KEYDOWN,
                        WPARAM(VK_ESCAPE.0 as usize),
                        LPARAM(0),
                    )
                    .unwrap();
                } else {
                    SendMessageW(
                        hwnd,
                        WM_LBUTTONDOWN,
                        Some(WPARAM(0)),
                        Some(LPARAM(10 | (20 << 16))),
                    );
                    let drag = |x: i32, y: i32| {
                        SendMessageW(
                            hwnd,
                            WM_MOUSEMOVE,
                            Some(WPARAM(0)),
                            Some(LPARAM((x | (y << 16)) as isize)),
                        );
                        let _ = UpdateWindow(hwnd);
                        let dc = GetDC(Some(hwnd));
                        let pixels = [GetPixel(dc, 10, 20), GetPixel(dc, 60, 60)];
                        ReleaseDC(Some(hwnd), dc);
                        pixels
                    };
                    let [border, inside] = drag(90, 80);
                    let [_, outside] = drag(40, 45);
                    let [old_border, _] = drag(11, 21);
                    let [reopened_border, restored_inside] = drag(90, 80);
                    // A locked or non-interactive desktop can reject GDI readback.
                    if inside.0 != u32::MAX {
                        assert_eq!(border.0, 0x0030_3bff);
                        assert_eq!(inside.0, 0x002a_3c3c);
                        assert_eq!(outside.0, 0x0012_1b1b);
                        assert_eq!(old_border.0, 0x0012_0904);
                        assert_eq!(reopened_border, border);
                        assert_eq!(restored_inside, inside);
                    }
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
            DesktopBitmap::from_rgba(&source).unwrap(),
            100,
            100,
            &|| cancelled.load(std::sync::atomic::Ordering::Relaxed),
            |_, _| cancelled.store(true, std::sync::atomic::Ordering::Relaxed),
        )
        .unwrap();
        assert!(
            image.is_none(),
            "stop cancels the native window through its timer"
        );
    }
}
