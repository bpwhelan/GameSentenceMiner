//! Windows input ownership is separate from visibility and foreground focus.
//! Rebuilding Tao window styles to change passthrough recreates the composited
//! surface and can flash the desktop. Keep that surface and change only hit testing.
use crate::overlay_magpie::{sample_pointer, PointerSample};
use crate::overlay_pointer::PointerPacer;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tauri::{Manager, WebviewWindow};
use windows::Win32::{
    Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::{Dwm::*, Gdi::ScreenToClient},
    System::Threading::{AttachThreadInput, GetCurrentThreadId},
    UI::{
        HiDpi::GetDpiForWindow,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::*,
    },
};

const SUBCLASS: usize = 0x47534d49;
const TIMER: usize = 0x47534d50;
struct InputState {
    app: tauri::AppHandle,
    label: String,
    ignore: bool,
    forward: bool,
    frameless: bool,
    layered: bool,
    pointer: PointerPacer<ViewportPointer>,
    timer_ms: Option<u32>,
}

#[derive(Clone, PartialEq)]
struct ViewportPointer {
    sample: PointerSample,
    x: f64,
    y: f64,
}
static WINDOWS: OnceLock<Mutex<HashMap<usize, InputState>>> = OnceLock::new();

fn install(window: &WebviewWindow) -> Result<HWND, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        SetWindowSubclass(hwnd, Some(callback), SUBCLASS, 0)
            .ok()
            .map_err(|e| e.to_string())?;
    }
    WINDOWS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(hwnd.0 as usize)
        .or_insert_with(|| InputState {
            app: window.app_handle().clone(),
            label: window.label().into(),
            ignore: false,
            forward: false,
            frameless: false,
            layered: false,
            pointer: PointerPacer::default(),
            timer_ms: None,
        });
    Ok(hwnd)
}

pub fn frameless(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = install(window)?;
    WINDOWS
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .get_mut(&(hwnd.0 as usize))
        .unwrap()
        .frameless = true;
    unsafe {
        // Windows 11 otherwise outlines even transparent fullscreen overlays.
        // Older Windows may not support these attributes.
        let square = DWMWCP_DONOTROUND;
        let no_border: u32 = 0xfffffffe; // DWMWA_COLOR_NONE
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &square as *const _ as _,
            4,
        );
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &no_border as *const _ as _, 4);
        let no_frame = DWMNCRP_DISABLED;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_NCRENDERING_POLICY,
            &no_frame as *const _ as _,
            4,
        );
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_STYLE,
            style & !((WS_CAPTION | WS_THICKFRAME).0 as isize),
        );
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Runs on the actual HWND's UI thread, not the Node service's thread. No
// simulated Alt key and no repeated focus change when already foreground.
pub unsafe fn focus(hwnd: HWND) {
    if !IsWindowVisible(hwnd).as_bool() || GetForegroundWindow() == hwnd {
        return;
    }
    let foreground = GetWindowThreadProcessId(GetForegroundWindow(), None);
    let current = GetCurrentThreadId();
    let attached = foreground != 0
        && foreground != current
        && AttachThreadInput(current, foreground, true).as_bool();
    let _ = SetForegroundWindow(hwnd);
    if attached {
        let _ = AttachThreadInput(current, foreground, false);
    }
}

pub fn ignore(window: &WebviewWindow, value: &Value) -> Result<(), String> {
    let hwnd = install(window)?;
    let ignore = value["ignore"].as_bool().unwrap_or(false);
    let forward = value["forward"].as_bool().unwrap_or(false);
    unsafe {
        {
            let mut windows = WINDOWS.get().unwrap().lock().unwrap();
            let state = windows.get_mut(&(hwnd.0 as usize)).unwrap();
            if state.forward != forward {
                state.pointer = PointerPacer::default();
            }
            state.ignore = ignore;
            state.forward = forward;
            state.layered = true;
        }
        let before = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let after = (before | WS_EX_LAYERED.0 as isize) & !(WS_EX_TRANSPARENT.0 as isize)
            | if ignore {
                WS_EX_TRANSPARENT.0 as isize
            } else {
                0
            };
        if before != after {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, after);
        }
        if before & WS_EX_LAYERED.0 as isize == 0 {
            SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA)
                .map_err(|e| e.to_string())?;
        }
        sync_pointer_timer(hwnd)?;
    }
    Ok(())
}

// Call only on the HWND's UI thread. Idempotent updates avoid postponing a timer
// on every ownership reply. Hidden/minimized/disabled overlays have no timer.
unsafe fn sync_pointer_timer(hwnd: HWND) -> Result<(), String> {
    let visible = IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool();
    let mut windows = WINDOWS.get().unwrap().lock().unwrap();
    let Some(state) = windows.get_mut(&(hwnd.0 as usize)) else {
        return Ok(());
    };
    let next = (state.forward && visible)
        .then(|| state.pointer.interval(Instant::now()).as_millis() as u32);
    if state.timer_ms == next {
        return Ok(());
    }
    if let Some(interval) = next {
        if SetTimer(Some(hwnd), TIMER, interval, None) == 0 {
            return Err("Could not start mouse forwarding".into());
        }
    } else {
        let _ = KillTimer(Some(hwnd), TIMER);
        state.pointer = PointerPacer::default();
    }
    state.timer_ms = next;
    Ok(())
}

unsafe fn forward_pointer(hwnd: HWND) {
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return;
    }
    let Some(sample) = sample_pointer() else {
        return;
    };
    let mut position = POINT {
        x: sample.x,
        y: sample.y,
    };
    if !ScreenToClient(hwnd, &mut position).as_bool() {
        return;
    }
    let scale = GetDpiForWindow(hwnd).max(96) as f64 / 96.0;
    let point = ViewportPointer {
        sample,
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
    };
    let notification = WINDOWS.get().and_then(|windows| {
        let mut windows = windows.lock().unwrap();
        let state = windows.get_mut(&(hwnd.0 as usize))?;
        let now = Instant::now();
        if !state.forward || !state.pointer.observe(point.clone(), now) {
            return None;
        }
        state.pointer.published(now);
        Some((state.app.clone(), state.label.clone()))
    });
    // No JSON allocations or WebView calls on unchanged high-frequency ticks.
    if let Some((app, label)) = notification {
        if let Some(host) = app.try_state::<crate::overlay_host::OverlayHost>() {
            host.handle_window_pointer(
                &app,
                &label,
                &json!({
                    "x": point.x, "y": point.y, "buttons": point.sample.buttons,
                    "shiftKey": point.sample.shift, "ctrlKey": point.sample.ctrl,
                    "altKey": point.sample.alt, "metaKey": point.sample.meta,
                }),
            );
        }
    }
}

// Used by the isolated native smoke suite to verify timer suspension without
// moving the user's physical mouse or depending on its current position.
pub(crate) fn forwarding_interval(window: &WebviewWindow) -> Option<u32> {
    let hwnd = window.hwnd().ok()?;
    WINDOWS
        .get()?
        .lock()
        .ok()?
        .get(&(hwnd.0 as usize))?
        .timer_ms
}

unsafe extern "system" fn callback(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if matches!(message, WM_NCPAINT | WM_NCACTIVATE) {
        let frameless = WINDOWS.get().is_some_and(|windows| {
            windows
                .lock()
                .unwrap()
                .get(&(hwnd.0 as usize))
                .is_some_and(|state| state.frameless)
        });
        if frameless {
            // No intermediate non-client paint while Windows activates/reveals
            // the full-screen transparent HWND.
            return LRESULT(if message == WM_NCACTIVATE { 1 } else { 0 });
        }
    }
    if message == WM_NCDESTROY {
        if let Some(windows) = WINDOWS.get() {
            windows.lock().unwrap().remove(&(hwnd.0 as usize));
        }
        let _ = KillTimer(Some(hwnd), TIMER);
        let _ = RemoveWindowSubclass(hwnd, Some(callback), SUBCLASS);
    } else if message == WM_STYLECHANGING {
        if let Some(state) = WINDOWS
            .get()
            .and_then(|windows| windows.lock().ok())
            .and_then(|windows| {
                windows
                    .get(&(hwnd.0 as usize))
                    .map(|state| (state.ignore, state.layered, state.frameless))
            })
        {
            // Other legitimate window changes must preserve the surface too.
            let style = &mut *(lparam.0 as *mut STYLESTRUCT);
            if wparam.0 as i32 == GWL_EXSTYLE.0 && state.1 {
                style.styleNew = (style.styleNew | WS_EX_LAYERED.0) & !WS_EX_TRANSPARENT.0
                    | if state.0 { WS_EX_TRANSPARENT.0 } else { 0 };
            }
            if wparam.0 as i32 == GWL_STYLE.0 && state.2 {
                style.styleNew &= !(WS_CAPTION | WS_THICKFRAME).0;
            }
        }
    } else if message == WM_TIMER && wparam.0 == TIMER {
        forward_pointer(hwnd);
        let _ = sync_pointer_timer(hwnd);
        return LRESULT(0);
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if matches!(message, WM_WINDOWPOSCHANGED | WM_SIZE) {
        let _ = sync_pointer_timer(hwnd);
    }
    result
}
