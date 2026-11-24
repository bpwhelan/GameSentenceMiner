use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};

/// A catalog entry is metadata only. OBS selectors belong to the consumer.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureWindow {
    pub id: String,
    pub pid: u32,
    pub title: String,
    pub process_path: Option<String>,
    pub window_class: String,
    pub minimized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_focused_at: Option<u64>,
}

static HISTORY: OnceLock<Mutex<Vec<(String, u32, u64)>>> = OnceLock::new();
static PREVIEWS: Mutex<()> = Mutex::new(());

pub fn record_focus(snapshot: &Value) {
    let (Some(hwnd), Some(pid), Some(at)) = (
        snapshot["hwnd"].as_str(),
        snapshot["pid"].as_u64(),
        snapshot["capturedAt"].as_u64(),
    ) else {
        return;
    };
    let hwnd = if let Some(hex) = hwnd.strip_prefix("0x") {
        u64::from_str_radix(hex, 16).ok()
    } else {
        hwnd.parse::<u64>().ok()
    };
    let Some(hwnd) = hwnd else {
        return;
    };
    let id = format!("window:{hwnd}:{pid}");
    let mut history = HISTORY.get_or_init(Default::default).lock().unwrap();
    if history
        .iter()
        .any(|(key, _, previous)| key == &id && *previous >= at)
    {
        return;
    }
    history.retain(|(key, _, _)| key != &id);
    history.push((id, pid as u32, at));
    if history.len() > 256 {
        history.remove(0);
    }
}

fn metadata(window: &xcap::Window) -> Option<CaptureWindow> {
    let id = window.id().ok()?;
    let pid = window.pid().ok()?;
    let title = window.title().ok()?;
    if pid == std::process::id() || pid == 0 {
        return None;
    }
    #[cfg(windows)]
    let window_class = window_class(id)?;
    #[cfg(not(windows))]
    let window_class = window.app_name().unwrap_or_default();
    let id = format!("window:{id}:{pid}");
    let last_focused_at = HISTORY
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .iter()
        .find(|(key, _, _)| key == &id)
        .map(|(_, _, at)| *at);
    Some(CaptureWindow {
        id,
        pid,
        title,
        process_path: process_path(pid),
        window_class,
        minimized: window.is_minimized().unwrap_or(true),
        last_focused_at,
    })
}

#[cfg(windows)]
fn window_class(id: u32) -> Option<String> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            GetClassNameW, GetWindow, GetWindowLongW, GWL_EXSTYLE, GW_OWNER, WS_EX_APPWINDOW,
            WS_EX_TOOLWINDOW,
        },
    };
    let hwnd = HWND(id as usize as *mut _);
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if style & WS_EX_APPWINDOW.0 == 0
            && (style & WS_EX_TOOLWINDOW.0 != 0
                || GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()))
        {
            return None;
        }
        let mut class = [0u16; 256];
        let length = GetClassNameW(hwnd, &mut class);
        if length <= 0 {
            return None;
        }
        let class = String::from_utf16_lossy(&class[..length as usize]);
        if matches!(
            class.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        ) {
            return None;
        }
        Some(class)
    }
}

pub fn list() -> Result<Vec<CaptureWindow>, String> {
    Ok(target_windows()?
        .into_iter()
        .filter(|window| !window.title.trim().is_empty())
        .collect())
}

pub(crate) fn target_windows() -> Result<Vec<CaptureWindow>, String> {
    // No capture/portal is started just to populate a picker.
    #[cfg(target_os = "linux")]
    if std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland")) {
        return Ok(Vec::new());
    }
    Ok(xcap::Window::all()
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(metadata)
        .collect())
}

#[derive(Deserialize)]
pub struct PreviewRequest {
    value: String,
    source: CaptureWindow,
}

fn same_window(requested: &CaptureWindow, current: &CaptureWindow) -> bool {
    requested.id == current.id
        && requested.pid == current.pid
        && requested.title == current.title
        && requested.process_path.is_some()
        && requested.process_path == current.process_path
        && requested.window_class == current.window_class
        && !current.minimized
}

pub fn previews(requests: Vec<PreviewRequest>) -> Result<Value, String> {
    if requests.len() > 128 {
        return Err("Too many preview targets".into());
    }
    // Keep the existing Windows-only preview policy: no automatic permission/portal prompts.
    if !cfg!(windows) || requests.is_empty() {
        return Ok(json!([]));
    }
    let _guard = PREVIEWS.lock().unwrap();
    let windows = xcap::Window::all().map_err(|e| e.to_string())?;
    let mut capture = gsm_capture::Capture::default();
    let mut results = Vec::new();
    for request in requests {
        let Some(window) = windows
            .iter()
            .find(|w| metadata(w).is_some_and(|current| same_window(&request.source, &current)))
        else {
            continue;
        };
        let Ok(image) = gsm_capture::window_image(window, &mut capture) else {
            continue;
        };
        // Re-check after acquisition too: windows can close or change title during capture.
        if !metadata(window).is_some_and(|current| same_window(&request.source, &current)) {
            continue;
        }
        let image = image::DynamicImage::ImageRgba8(image)
            .thumbnail(320, 180)
            .to_rgb8();
        let mut bytes = Vec::new();
        if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 75)
            .encode_image(&image)
            .is_err()
        {
            continue;
        }
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        results.push(
            json!({"value":request.value,"imageData":format!("data:image/jpeg;base64,{encoded}")}),
        );
    }
    Ok(json!(results))
}

/// Resolve a window's owner without loading a second native addon in Node.
/// Inaccessible or exited processes have no path and are never guessed by name.
#[cfg(windows)]
pub fn process_path(pid: u32) -> Option<String> {
    use windows::{
        core::PWSTR,
        Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

#[cfg(target_os = "linux")]
pub fn process_path(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
pub fn process_path(pid: u32) -> Option<String> {
    crate::process_probe::process_executable_path(pid).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_reject_recycled_handles_changed_titles_and_inaccessible_owners() {
        let original = CaptureWindow {
            id: "window:42:7".into(),
            pid: 7,
            title: "月姫".into(),
            process_path: Some("game.exe".into()),
            window_class: "Game".into(),
            minimized: false,
            last_focused_at: None,
        };
        assert!(same_window(&original, &original));
        let mut changed = original.clone();
        changed.pid = 8;
        assert!(!same_window(&original, &changed));
        changed = original.clone();
        changed.title = "Other game".into();
        assert!(!same_window(&original, &changed));
        changed = original.clone();
        changed.process_path = None;
        assert!(!same_window(&original, &changed));
        changed = original.clone();
        changed.minimized = true;
        assert!(!same_window(&original, &changed));
    }

    #[test]
    fn focus_history_is_monotonic_and_scoped_to_process_identity() {
        record_focus(&json!({"hwnd":"0x2a","pid":7,"capturedAt":200}));
        record_focus(&json!({"hwnd":"42","pid":7,"capturedAt":100}));
        let history = HISTORY.get().unwrap().lock().unwrap();
        assert!(history.contains(&("window:42:7".into(), 7, 200)));
        assert!(!history.iter().any(|(id, _, _)| id == "window:42:8"));
    }

    #[test]
    fn resolves_the_actual_process_executable() {
        let expected = std::env::current_exe().unwrap().canonicalize().unwrap();
        let actual = std::path::PathBuf::from(process_path(std::process::id()).unwrap())
            .canonicalize()
            .unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn does_not_guess_an_inaccessible_process() {
        assert_eq!(process_path(u32::MAX), None);
    }
}
