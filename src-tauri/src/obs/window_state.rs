//! Physical desktop coordinates for the OBS capture window and the overlay.
use super::session_target::Target;
use crate::overlay_magpie::{magpie_info_to_renderer_json, read_native_magpie_info};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    },
    UI::{
        Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN},
        WindowsAndMessaging::*,
    },
};

#[derive(Default)]
pub(super) struct Displays {
    measured: Option<Instant>,
    bounds: Vec<[i32; 4]>,
}
impl Displays {
    pub(super) fn bounds(&mut self) -> &[[i32; 4]] {
        use windows::Win32::{
            Foundation::LPARAM,
            Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR},
        };
        unsafe extern "system" fn collect(
            _: HMONITOR,
            _: HDC,
            rect: *mut RECT,
            ctx: LPARAM,
        ) -> windows::core::BOOL {
            // EnumDisplayMonitors calls synchronously for the duration of this borrow.
            let bounds = unsafe { &mut *(ctx.0 as *mut Vec<[i32; 4]>) };
            let r = unsafe { *rect };
            bounds.push([r.left, r.top, r.right - r.left, r.bottom - r.top]);
            true.into()
        }
        if self
            .measured
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(1))
        {
            let mut next: Vec<[i32; 4]> = Vec::new();
            if unsafe {
                EnumDisplayMonitors(
                    None,
                    None,
                    Some(collect),
                    LPARAM((&mut next as *mut Vec<[i32; 4]>) as isize),
                )
            }
            .as_bool()
                && !next.is_empty()
            {
                self.bounds = next;
            }
            self.measured = Some(Instant::now());
        }
        &self.bounds
    }
}

fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect).ok()?;
    }
    Some(rect)
}
fn client_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        GetClientRect(hwnd, &mut rect).ok()?;
        ClientToScreen(hwnd, &mut origin).ok().ok()?;
    }
    Some(RECT {
        left: origin.x,
        top: origin.y,
        right: origin.x + rect.right,
        bottom: origin.y + rect.bottom,
    })
}
fn rect_json(r: RECT) -> Value {
    json!({"left":r.left,"top":r.top,"right":r.right,"bottom":r.bottom,"width":r.right-r.left,"height":r.bottom-r.top})
}
fn monitor_rect(hwnd: HWND) -> Option<RECT> {
    let mut monitor = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        if !GetMonitorInfoW(
            MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
            &mut monitor,
        )
        .as_bool()
        {
            return None;
        }
    }
    Some(monitor.rcMonitor)
}
fn fullscreen(r: RECT, m: RECT) -> bool {
    r.left.abs_diff(m.left) <= 2
        && r.top.abs_diff(m.top) <= 2
        && (r.right - r.left).abs_diff(m.right - m.left) <= 2
        && (r.bottom - r.top).abs_diff(m.bottom - m.top) <= 2
}
fn is_overlay_process(class: &str, image: &std::path::Path) -> bool {
    let Some(exe) = image.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    // The lock-key indicator can keep a visible window even at zero opacity.
    exe.eq_ignore_ascii_case("OSD.exe")
        || (class.contains("Chrome")
            && matches!(
                exe.to_ascii_lowercase().as_str(),
                "gsm_overlay.exe"
                    | "obs64.exe"
                    | "obs32.exe"
                    | "streamlabs obs.exe"
                    | "xsplit.broadcaster.exe"
                    | "gamebar.exe"
                    | "nvidia share.exe"
                    | "nvcontainer.exe"
                    | "lunatranslator.exe"
                    | "jl.exesharex.exe"
            ))
}

// Keep the identity of eligible windows for text coverage diagnostics.
fn covering_window(hwnd: HWND) -> Option<(u32, String)> {
    let style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    let passthrough = WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0;
    if style & passthrough == passthrough {
        return None;
    }
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    let class = String::from_utf16_lossy(&buf[..n as usize]);
    if class.starts_with("Window_Magpie_")
        || class.starts_with("Magpie_")
        || (class.contains("Qt5") && class.contains("QWindowIcon"))
        || class.contains("CEF-OSC-WIDGET")
        || (class.contains("HwndWrapper") && class.contains("[JL;"))
    {
        return None;
    }
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    let title = String::from_utf16_lossy(&buf[..n as usize]).to_ascii_lowercase();
    if [
        "gsm overlay",
        "gsm_overlay",
        "nvidia geforce overlay",
        "rtss",
        "rivatuner",
        "sharex - screen recording",
    ]
    .iter()
    .any(|s| title.contains(s))
        || (class.contains("Chrome") && title.contains("gsm") && title.contains("overlay"))
    {
        return None;
    }
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    let ignored = super::process::image_path(pid).is_some_and(|p| is_overlay_process(&class, &p));
    (!ignored).then_some((pid, class))
}

fn coverage(hwnd: HWND, source: HWND, bounds: RECT) -> (Vec<Value>, bool) {
    let mut rects = Vec::new();
    let mut current = hwnd;
    // A desktop can reorder while traversing. Bound the walk even if it cycles.
    for _ in 0..512 {
        let Ok(next) = (unsafe { GetWindow(current, GW_HWNDPREV) }) else {
            break;
        };
        if next == current || next == hwnd {
            break;
        }
        current = next;
        if next == source || unsafe { !IsWindowVisible(next).as_bool() || IsIconic(next).as_bool() }
        {
            continue;
        }
        let Some(r) = window_rect(next) else { continue };
        if r.left >= r.right
            || r.top >= r.bottom
            || r.left >= bounds.right
            || r.top >= bounds.bottom
            || r.right <= bounds.left
            || r.bottom <= bounds.top
        {
            continue;
        }
        let Some((pid, class)) = covering_window(next) else {
            continue;
        };
        let mut rect = rect_json(r);
        rect["hwnd"] = json!(next.0 as usize);
        rect["pid"] = json!(pid);
        rect["window_class"] = json!(class);
        rects.push(rect);
        if r.left <= bounds.left + 10
            && r.right >= bounds.right - 10
            && r.top <= bounds.top + 15
            && r.bottom >= bounds.bottom - 80
        {
            return (rects, true);
        }
    }
    (rects, false)
}

// Magpie can be separated from its focused source by a nonactivating window.
// Respect owned dialogs and intentional topmost windows. Revalidate the source
// immediately before changing its position in the desktop stack.
fn repair_magpie(source: HWND, scaling: HWND, bounds: RECT, last: &mut Vec<usize>) {
    let mut blockers = vec![source.0 as usize, scaling.0 as usize];
    let mut current = source;
    for _ in 0..256 {
        let Ok(next) = (unsafe { GetWindow(current, GW_HWNDPREV) }) else {
            break;
        };
        if next == scaling {
            if blockers.len() > 2
                && blockers != *last
                && unsafe { GetForegroundWindow() } == source
                && window_rect(source) == Some(bounds)
                && read_native_magpie_info().is_some_and(|m| {
                    m.hwnd == scaling.0 as usize as u64 && m.source_hwnd == source.0 as usize as u64
                })
            {
                unsafe {
                    let _ = SetWindowPos(
                        source,
                        Some(HWND_TOP),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE
                            | SWP_NOSIZE
                            | SWP_NOACTIVATE
                            | SWP_NOOWNERZORDER
                            | SWP_ASYNCWINDOWPOS,
                    );
                }
            }
            *last = blockers;
            return;
        }
        if next == source || next == current {
            break;
        }
        current = next;
        if unsafe { !IsWindowVisible(next).as_bool() || IsIconic(next).as_bool() } {
            continue;
        }
        let Some(r) = window_rect(next) else { continue };
        if r.left >= bounds.right
            || r.top >= bounds.bottom
            || r.right <= bounds.left
            || r.bottom <= bounds.top
            || covering_window(next).is_none()
        {
            continue;
        }
        if unsafe { GetWindowLongW(next, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST.0 != 0
            || unsafe { GetWindow(next, GW_OWNER) }.ok() == Some(source)
        {
            break;
        }
        blockers.push(next.0 as usize);
    }
    last.clear();
}
fn sustained(start: &mut Option<Instant>, active: bool, seconds: u64) -> bool {
    if active {
        start.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(seconds)
    } else {
        *start = None;
        false
    }
}

#[derive(Default)]
pub(super) struct Sampler {
    identity: Option<(u64, u32)>,
    hidden: Option<Instant>,
    exclusive: Option<Instant>,
    last_repair: Vec<usize>,
}
impl Sampler {
    pub(super) fn sample(&mut self, target: &Target, title: &str, displays: &[[i32; 4]]) -> Value {
        let identity = Some((target.id, target.pid));
        if self.identity != identity {
            *self = Self {
                identity,
                ..Default::default()
            };
        }
        let hwnd = HWND(target.id as usize as *mut _);
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        let mut state = if pid != target.pid {
            "closed"
        } else if unsafe { IsIconic(hwnd).as_bool() } {
            "minimized"
        } else if !unsafe { IsWindowVisible(hwnd).as_bool() } {
            "closed"
        } else if unsafe { GetForegroundWindow() } == hwnd {
            "active"
        } else {
            "background"
        };
        let visible = matches!(state, "active" | "background");
        let rect = visible.then(|| window_rect(hwnd)).flatten();
        let magpie = rect
            .and_then(|_| read_native_magpie_info())
            .filter(|m| m.source_hwnd == target.id);
        let presentation = magpie
            .as_ref()
            .map_or(hwnd, |m| HWND(m.hwnd as usize as *mut _));
        if let (Some(r), true) = (rect, state == "active" && magpie.is_some()) {
            repair_magpie(hwnd, presentation, r, &mut self.last_repair);
        } else {
            self.last_repair.clear();
        }
        let bounds = magpie
            .as_ref()
            .map(|m| {
                let r = &m.window_bounds;
                RECT {
                    left: r.left as i32,
                    right: r.right as i32,
                    top: r.top as i32,
                    bottom: r.bottom as i32,
                }
            })
            .or(rect);
        let (occluders, covered) = bounds
            .map(|r| coverage(presentation, hwnd, r))
            .unwrap_or_default();
        if covered && state == "background" {
            state = "obscured";
        }
        let monitor = rect.and_then(|_| monitor_rect(hwnd));
        let capture_monitor = monitor.and_then(|m| {
            displays
                .iter()
                .position(|d| *d == [m.left, m.top, m.right - m.left, m.bottom - m.top])
        });
        let screen = if presentation == hwnd {
            monitor
        } else {
            monitor_rect(presentation)
        };
        let full = bounds.zip(screen).is_some_and(|(r, m)| fullscreen(r, m));
        let exclusive = state == "active"
            && full
            && magpie.is_none()
            && unsafe { SHQueryUserNotificationState() }
                .is_ok_and(|s| s == QUNS_RUNNING_D3D_FULL_SCREEN);
        let mut cursor = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        let hidden = state == "active"
            && unsafe { GetCursorInfo(&mut cursor) }.is_ok()
            && cursor.flags.0 & CURSOR_SHOWING.0 == 0;
        let hidden = sustained(&mut self.hidden, hidden, 3);
        json!({"type":"window_state","data":state,"target_hwnd":target.id,"game":title,"is_fullscreen":full,
            "is_exclusive_fullscreen":sustained(&mut self.exclusive,exclusive,2),"cursor_hidden":hidden,"recommend_manual_mode":hidden,
            "capture_monitor":capture_monitor,"target_window_rect":rect.map(rect_json),"target_client_rect":rect.and_then(|_|client_rect(hwnd)).map(rect_json),
            "magpie_info":magpie_info_to_renderer_json(magpie.as_ref()),"occlusion_rects":occluders})
    }
}

#[cfg(test)]
mod tests {
    use super::is_overlay_process;
    use std::path::Path;

    #[test]
    fn lock_key_osd_is_ignored_by_exact_executable_name_across_window_classes() {
        let class = "IndicatorWindow";
        assert!(is_overlay_process(class, Path::new(r"C:\Vendor\OSD.exe")));
        assert!(is_overlay_process(class, Path::new("osd.EXE")));
        assert!(!is_overlay_process(class, Path::new("GameOSD.exe")));
        assert!(!is_overlay_process(class, Path::new("obs64.exe")));
        assert!(is_overlay_process(
            "Chrome_WidgetWin_1",
            Path::new("obs64.exe")
        ));
    }
}
