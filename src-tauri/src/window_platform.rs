use serde_json::Value;
use tauri::WebviewWindow;

#[cfg(windows)]
pub fn is_capture_target_focused(id: u64) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as usize as u64 == id }
}

#[cfg(not(windows))]
pub fn is_capture_target_focused(id: u64) -> bool {
    #[cfg(target_os = "linux")]
    if std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland"))
        || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|s| !s.is_empty())
    {
        return false;
    }

    xcap::Window::all().is_ok_and(|windows| {
        windows.iter().any(|window| {
            window.id().is_ok_and(|candidate| u64::from(candidate) == id)
                && window.is_focused().unwrap_or(false)
        })
    })
}

// GTK, AppKit and window subclasses must be touched on their owning UI thread.
pub fn apply(window: &WebviewWindow, action: &str, value: &Value) -> Result<(), String> {
    let action = action.to_owned();
    let value = value.clone();
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let _ = tx.send(on_main(&target, &action, &value));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "linux")]
pub fn content_size(window: &WebviewWindow) -> Result<(i32, i32), String> {
    use gtk::prelude::*;
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = target
                .gtk_window()
                .map_err(|e| e.to_string())
                .and_then(|window| {
                    window
                        .child()
                        .map(|child| (child.allocated_width(), child.allocated_height()))
                        .ok_or("Window has no content".into())
                });
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn on_main(window: &WebviewWindow, action: &str, value: &Value) -> Result<(), String> {
    use windows::Win32::{Foundation::COLORREF, Graphics::Gdi::*, UI::WindowsAndMessaging::*};
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        match action {
            "frameless" => return crate::windows_input::frameless(window),
            "ignoreCursor" => return crate::windows_input::ignore(window, value),
            "focus" => {
                crate::windows_input::focus(hwnd);
            }
            "moveTop" => {
                SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                )
                .map_err(|e| e.to_string())?;
            }
            "showWithoutActivating" => {
                SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
                )
                .map_err(|e| e.to_string())?;
            }
            "blur" => {
                if GetForegroundWindow() == hwnd {
                    let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow(
                        windows::Win32::Foundation::HWND::default(),
                    );
                }
            }
            "opacity" => {
                let alpha = value
                    .as_f64()
                    .ok_or("Opacity must be a number")?
                    .clamp(0.0, 1.0);
                let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as isize);
                SetLayeredWindowAttributes(
                    hwnd,
                    COLORREF(0),
                    (alpha * 255.0).round() as u8,
                    LWA_ALPHA,
                )
                .map_err(|e| e.to_string())?;
            }
            "shape" => {
                let rectangles = value.as_array().ok_or("Shape must be an array")?;
                if rectangles.is_empty() {
                    SetWindowRgn(hwnd, None, true);
                    return Ok(());
                }
                let scale = window.scale_factor().map_err(|e| e.to_string())?;
                let region = CreateRectRgn(0, 0, 0, 0);
                for rect in rectangles {
                    let n = |key: &str| rect[key].as_f64().unwrap_or(0.0) * scale;
                    let piece = CreateRectRgn(
                        n("x") as i32,
                        n("y") as i32,
                        (n("x") + n("width")) as i32,
                        (n("y") + n("height")) as i32,
                    );
                    CombineRgn(Some(region), Some(region), Some(piece), RGN_OR);
                    let _ = DeleteObject(piece.into());
                }
                if SetWindowRgn(hwnd, Some(region), true) == 0 {
                    let _ = DeleteObject(region.into());
                    return Err("Could not apply window shape".into());
                }
            }
            "hookMessage" | "unhookMessage" => {
                return windows_hooks::change(
                    window,
                    value.as_u64().ok_or("Invalid window message")? as u32,
                    action == "hookMessage",
                )
            }
            _ => return Err(format!("Unknown window operation: {action}")),
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn on_main(window: &WebviewWindow, action: &str, value: &Value) -> Result<(), String> {
    use gtk::prelude::*;
    let widget = window.gtk_window().map_err(|e| e.to_string())?;
    match action {
        "showWithoutActivating" => {
            widget.set_focus_on_map(false);
            widget.show_all();
        }
        "opacity" => widget.set_opacity(
            value
                .as_f64()
                .ok_or("Opacity must be a number")?
                .clamp(0.0, 1.0),
        ),
        "ignoreCursor" => {
            // Tao assumes a visible/realized GTK surface. The overlay sets
            // click-through before first show, which otherwise panics there.
            widget.realize();
            if let Some(surface) = widget.window() {
                let region = gtk::cairo::Region::create();
                if value["ignore"].as_bool().unwrap_or(false) {
                    surface.input_shape_combine_region(&region, 0, 0);
                } else {
                    widget.input_shape_combine_region(None);
                }
            }
        }
        "shape" => {
            let rectangles = value.as_array().ok_or("Shape must be an array")?;
            let region = gtk::cairo::Region::create();
            if rectangles.is_empty() {
                region
                    .union_rectangle(&gtk::cairo::RectangleInt::new(
                        0,
                        0,
                        widget.allocated_width(),
                        widget.allocated_height(),
                    ))
                    .map_err(|e| e.to_string())?;
            }
            for rect in rectangles {
                let n = |key: &str| rect[key].as_f64().unwrap_or(0.0) as i32;
                region
                    .union_rectangle(&gtk::cairo::RectangleInt::new(
                        n("x"),
                        n("y"),
                        n("width"),
                        n("height"),
                    ))
                    .map_err(|e| e.to_string())?;
            }
            if let Some(surface) = widget.window() {
                surface.shape_combine_region(
                    if rectangles.is_empty() {
                        None
                    } else {
                        Some(&region)
                    },
                    0,
                    0,
                );
                surface.input_shape_combine_region(&region, 0, 0);
            }
        }
        _ => {
            return Err(format!(
                "Windows message hooks are unavailable on Linux: {action}"
            ))
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn on_main(window: &WebviewWindow, action: &str, value: &Value) -> Result<(), String> {
    let pointer = window.ns_window().map_err(|e| e.to_string())?;
    let native = unsafe { &*(pointer as *const objc2_app_kit::NSWindow) };
    match action {
        "showWithoutActivating" => native.orderBack(None),
        "opacity" => native.setAlphaValue(value.as_f64().ok_or("Opacity must be a number")?.clamp(0.0, 1.0)),
        "ignoreCursor" => native.setIgnoresMouseEvents(value["ignore"].as_bool().unwrap_or(false)),
        "focus" => { window.set_focus().map_err(|e| e.to_string())?; },
        "blur" => native.resignKeyWindow(),
        "moveTop" => native.orderFrontRegardless(),
        "frameless" => {},
        _ => return Err(format!("Window operation is unavailable on macOS: {action}")),
    }
    Ok(())
}

#[cfg(windows)]
mod windows_hooks {
    use super::*;
    use std::{
        collections::{HashMap, HashSet},
        sync::{Mutex, OnceLock},
    };
    use tauri::Manager;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                ChangeWindowMessageFilterEx, GetDesktopWindow, MSGFLT_ALLOW, WM_NCDESTROY,
            },
        },
    };
    struct Hook {
        app: tauri::AppHandle,
        label: String,
        messages: HashSet<u32>,
        reorder: usize,
    }
    static HOOKS: OnceLock<Mutex<HashMap<usize, Hook>>> = OnceLock::new();
    const SUBCLASS_ID: usize = 0x47534d;
    pub fn change(window: &WebviewWindow, message: u32, enable: bool) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let mut hooks = HOOKS.get_or_init(Default::default).lock().unwrap();
        if enable {
            unsafe {
                SetWindowSubclass(hwnd, Some(callback), SUBCLASS_ID, 0)
                    .ok()
                    .map_err(|e| e.to_string())?;
                ChangeWindowMessageFilterEx(hwnd, message, MSGFLT_ALLOW, None)
                    .map_err(|e| e.to_string())?;
            }
            hooks
                .entry(hwnd.0 as usize)
                .or_insert_with(|| Hook {
                    app: window.app_handle().clone(),
                    label: window.label().into(),
                    messages: HashSet::new(),
                    reorder: unsafe {
                        SetWinEventHook(0x8004, 0x8004, None, Some(reordered), 0, 0, 0).0 as usize
                    },
                })
                .messages
                .insert(message);
        } else if let Some(hook) = hooks.get_mut(&(hwnd.0 as usize)) {
            hook.messages.remove(&message);
            if hook.messages.is_empty() {
                if let Some(hook) = hooks.remove(&(hwnd.0 as usize)) {
                    unsafe {
                        let _ = UnhookWinEvent(HWINEVENTHOOK(hook.reorder as *mut _));
                    }
                }
                unsafe {
                    let _ = RemoveWindowSubclass(hwnd, Some(callback), SUBCLASS_ID);
                }
            }
        }
        Ok(())
    }
    unsafe extern "system" fn callback(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        let matched = if let Some(all) = HOOKS.get() {
            let mut hooks = all.lock().unwrap();
            let hit = hooks
                .get(&(hwnd.0 as usize))
                .filter(|hook| hook.messages.contains(&message))
                .map(|hook| (hook.app.clone(), hook.label.clone()));
            if message == WM_NCDESTROY {
                if let Some(hook) = hooks.remove(&(hwnd.0 as usize)) {
                    let _ = UnhookWinEvent(HWINEVENTHOOK(hook.reorder as *mut _));
                }
                let _ = RemoveWindowSubclass(hwnd, Some(callback), SUBCLASS_ID);
            }
            hit
        } else {
            None
        };
        if let Some((app, label)) = matched {
            let wparam_str = wparam.0.to_string();
            let lparam_str = (lparam.0 as usize).to_string();
            if let Some(oh) = app.try_state::<crate::overlay_host::OverlayHost>() {
                oh.handle_window_event_or_message(
                    &app,
                    &label,
                    message,
                    &wparam_str,
                    &lparam_str,
                    None,
                );
            }
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
    unsafe extern "system" fn reordered(
        handle: HWINEVENTHOOK,
        _: u32,
        hwnd: HWND,
        object: i32,
        child: i32,
        _: u32,
        _: u32,
    ) {
        if hwnd != GetDesktopWindow() || object != -4 || child != 0 {
            return;
        }
        let matched: Vec<(tauri::AppHandle, String)> = if let Some(hooks) = HOOKS.get() {
            hooks
                .lock()
                .unwrap()
                .values()
                .filter(|hook| hook.reorder == handle.0 as usize)
                .map(|hook| (hook.app.clone(), hook.label.clone()))
                .collect()
        } else {
            Vec::new()
        };
        for (app, label) in matched {
            if let Some(oh) = app.try_state::<crate::overlay_host::OverlayHost>() {
                oh.handle_window_event_or_message(&app, &label, 0, "", "", Some("native-reorder"));
            }
        }
    }
}
