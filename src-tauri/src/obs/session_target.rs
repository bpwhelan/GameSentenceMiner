use crate::capture_windows::{self, CaptureWindow};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct Selector {
    pub title: String,
    pub window_class: String,
    pub exe: String,
    pub window_id: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Target {
    pub id: u64,
    pub pid: u32,
    pub path: String,
    pub visible: bool,
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn executable_name(path: &str) -> String {
    let name = basename(path.trim()).to_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_owned()
}

fn browser(exe: &str) -> bool {
    matches!(
        exe.trim_end_matches(".exe"),
        "chrome"
            | "msedge"
            | "brave"
            | "opera"
            | "vivaldi"
            | "chromium"
            | "arc"
            | "thorium"
            | "whale"
            | "yandex"
            | "firefox"
            | "zen"
            | "waterfox"
            | "librewolf"
            | "floorp"
            | "palemoon"
            | "torbrowser"
    )
}

fn pick(
    selector: &Selector,
    windows: &[CaptureWindow],
    foreground: Option<u64>,
    previous: Option<&Target>,
) -> Option<Target> {
    let exe = executable_name(&selector.exe);
    let title = selector.title.trim().to_lowercase();
    let mut matches = Vec::new();
    for win in windows {
        let Some(id) = win.id.split(':').nth(1).and_then(|s| s.parse::<u64>().ok()) else {
            continue;
        };
        let path = win.process_path.as_deref().unwrap_or("");
        let candidate = executable_name(path);
        let same_class = !selector.window_class.is_empty()
            && win
                .window_class
                .eq_ignore_ascii_case(&selector.window_class);
        let same_title = !title.is_empty() && win.title.trim().to_lowercase() == title;
        let pinned = previous.is_some_and(|p| p.id == id && p.pid == win.pid);
        if candidate == "ocenaudio"
            || (matches!(candidate.as_str(), "eden" | "yuzu" | "lichii")
                && win.title.to_lowercase().starts_with(&format!(
                    "{} configuration",
                    candidate.trim_end_matches(".exe")
                )))
        {
            continue;
        }
        let same_exe = !exe.is_empty() && exe == candidate;
        if browser(&exe) {
            if !same_exe
                || !same_class
                || !(pinned || (foreground == Some(id) && same_title && !win.minimized))
            {
                continue;
            }
        } else if browser(&candidate) && selector.window_id.is_none() {
            continue;
        } else if !exe.is_empty() {
            if !same_exe {
                continue;
            }
        } else if !selector.window_class.is_empty() {
            if !same_class {
                continue;
            }
        } else if !same_title {
            continue;
        }
        if win.pid == 0 {
            continue;
        }
        let score = (
            pinned,
            same_title,
            selector.window_id == Some(id),
            same_class,
            foreground == Some(id),
            win.last_focused_at,
        );
        matches.push((
            score,
            Target {
                id,
                pid: win.pid,
                path: path.into(),
                visible: !win.minimized,
            },
        ));
    }
    matches
        .into_iter()
        .max_by_key(|(score, _)| *score)
        .map(|(_, target)| target)
}

pub(super) fn resolve(selector: &Selector, previous: Option<&Target>) -> Option<Target> {
    #[cfg(windows)]
    if let Some(old) = previous {
        // An iconic exclusive-fullscreen window can disappear from enumeration.
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{
                GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
            },
        };
        let hwnd = HWND(old.id as usize as *mut _);
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == old.pid && IsWindow(Some(hwnd)).as_bool() {
                return Some(Target {
                    visible: IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool(),
                    ..old.clone()
                });
            }
        }
    }
    #[cfg(windows)]
    if matches!(
        selector.window_class.as_str(),
        "Windows.UI.Core.CoreWindow" | "ApplicationFrameWindow"
    ) {
        return uwp(selector);
    }
    let foreground = super::process::foreground().and_then(|f| f["hwnd"].as_str()?.parse().ok());
    pick(
        selector,
        &capture_windows::target_windows().ok()?,
        foreground,
        previous,
    )
}

#[cfg(windows)]
fn uwp(selector: &Selector) -> Option<Target> {
    use windows::core::w;
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            FindWindowExW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        },
    };
    let mut previous = None;
    let mut fallback = None;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        while let Ok(frame) = FindWindowExW(None, previous, w!("ApplicationFrameWindow"), None) {
            previous = Some(frame);
            if !IsWindowVisible(frame).as_bool() {
                continue;
            }
            let mut pid = 0;
            GetWindowThreadProcessId(frame, Some(&mut pid));
            let mut child: Option<HWND> = None;
            let mut app_path = None;
            while let Ok(next) = FindWindowExW(Some(frame), child, None, None) {
                child = Some(next);
                let mut child_pid = 0;
                GetWindowThreadProcessId(next, Some(&mut child_pid));
                if child_pid != pid {
                    app_path = capture_windows::process_path(child_pid);
                    if app_path.is_some() {
                        break;
                    }
                }
            }
            let mut buffer = [0u16; 1024];
            let n = GetWindowTextW(frame, &mut buffer);
            let title = String::from_utf16_lossy(&buffer[..n as usize]).to_lowercase();
            let wanted = selector.title.trim().to_lowercase();
            if app_path.as_deref().map_or(
                !wanted.is_empty()
                    && !title.is_empty()
                    && (title == wanted
                        || (wanted.len() > 3
                            && (title.contains(&wanted) || wanted.contains(&title)))),
                |p| executable_name(p) == executable_name(&selector.exe),
            ) {
                let target = Target {
                    id: frame.0 as usize as u64,
                    pid,
                    path: app_path.unwrap_or_default(),
                    visible: !IsIconic(frame).as_bool(),
                };
                if frame == GetForegroundWindow() {
                    return Some(target);
                }
                if fallback.is_none() {
                    fallback = Some(target);
                }
            }
        }
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window(id: u32, pid: u32, title: &str, class: &str, exe: &str) -> CaptureWindow {
        CaptureWindow {
            id: format!("window:{id}:{pid}"),
            pid,
            title: title.into(),
            window_class: class.into(),
            process_path: Some(exe.into()),
            minimized: false,
            last_focused_at: None,
        }
    }
    #[test]
    fn browser_requires_focused_title_then_pins_window_and_process() {
        let selector = Selector {
            title: "Lesson".into(),
            window_class: "Chrome_WidgetWin_1".into(),
            exe: "Chrome.EXE".into(),
            window_id: None,
        };
        let mut windows = vec![
            window(3, 31, "Lesson", "Chrome_WidgetWin_1", "chrome.exe"),
            window(4, 32, "Mail", "Chrome_WidgetWin_1", "chrome.exe"),
        ];
        assert!(pick(&selector, &windows, Some(4), None).is_none());
        let pinned = pick(&selector, &windows, Some(3), None).unwrap();
        windows[0].title = "New tab".into();
        windows[0].minimized = true;
        let kept = pick(&selector, &windows, Some(4), Some(&pinned)).unwrap();
        assert_eq!(kept.id, pinned.id);
        assert!(!kept.visible);
        windows[0].pid += 1;
        assert!(pick(&selector, &windows, Some(4), Some(&pinned)).is_none());
    }
    #[test]
    fn x11_rematches_a_restarted_untitled_window_by_class() {
        let selector = Selector {
            window_id: Some(1),
            window_class: "game".into(),
            ..Default::default()
        };
        let windows = [
            window(1, 50, "Other", "other", "other"),
            window(5, 51, "", "Game", "game"),
        ];
        assert_eq!(pick(&selector, &windows, None, None).unwrap().id, 5);
    }
    #[test]
    fn emulator_settings_and_unrelated_processes_do_not_match() {
        let selector = Selector {
            title: "Game".into(),
            window_class: "Qt".into(),
            exe: "EDEN".into(),
            window_id: None,
        };
        let windows = [
            window(1, 11, "Eden Configuration - Settings", "Qt", "eden.exe"),
            window(2, 22, "Game", "Qt", "other.exe"),
        ];
        assert!(pick(&selector, &windows, None, None).is_none());
    }
}
