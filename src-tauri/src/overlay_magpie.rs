//! Native Windows Magpie scaling integration, high-frequency cursor projection,
//! Z-order arbitration, and multi-monitor coordinate mapping.
//!
//! Replaces `GSM_Overlay/magpie_native.js`, `GSM_Overlay/magpie_session.js`,
//! and `koffi`/`node-window-manager` in `GSM_Overlay/main.js`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Monitor};

#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{HWND, POINT},
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON, VK_XBUTTON1, VK_XBUTTON2,
            },
            WindowsAndMessaging::{
                FindWindowW, GetForegroundWindow, GetPhysicalCursorPos, GetPropW, GetWindow,
                GetWindowLongW, IsWindow, IsWindowVisible, RegisterWindowMessageW, GWL_EXSTYLE,
                GW_HWNDPREV, WS_EX_TRANSPARENT,
            },
        },
    },
};

pub const MAGPIE_SCALING_WINDOW_CLASS: &str = "Window_Magpie_967EB565-6F73-4E94-AE53-00CC42592A22";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectF64 {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeF64 {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: usize,
    pub label: String,
    pub scale_factor: f64,
    pub bounds: RectF64,
    pub work_area: RectF64,
    pub size: SizeF64,
    pub work_area_size: SizeF64,
    pub physical_bounds: RectF64,
    pub physical_work_area: RectF64,
    pub physical_size: SizeF64,
    pub physical_work_area_size: SizeF64,
    pub primary: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MagpieInfo {
    pub hwnd: u64,
    pub source_hwnd: u64,
    pub window_bounds: EdgeRect,
    pub source_window_bounds: EdgeRect,
    pub magpie_window_top_edge_position: f64,
    pub magpie_window_bottom_edge_position: f64,
    pub magpie_window_left_edge_position: f64,
    pub magpie_window_right_edge_position: f64,
    pub source_window_left_edge_position: f64,
    pub source_window_top_edge_position: f64,
    pub source_window_right_edge_position: f64,
    pub source_window_bottom_edge_position: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EdgeRect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl EdgeRect {
    #[inline]
    pub fn width(self) -> f64 {
        (self.right - self.left).max(0.0)
    }

    #[inline]
    pub fn height(self) -> f64 {
        (self.bottom - self.top).max(0.0)
    }

    #[inline]
    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PointerSample {
    pub x: i32,
    pub y: i32,
    pub buttons: u8,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

#[cfg(windows)]
fn wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
pub fn register_magpie_scaling_message() -> u32 {
    let name = wide_null("MagpieScalingChanged");
    unsafe { RegisterWindowMessageW(PCWSTR(name.as_ptr())) }
}

#[cfg(not(windows))]
pub fn register_magpie_scaling_message() -> u32 {
    0
}

#[cfg(windows)]
fn read_prop_i32(hwnd: HWND, prop: &str) -> f64 {
    let w = wide_null(prop);
    let handle = unsafe { GetPropW(hwnd, PCWSTR(w.as_ptr())) };
    // Zero is a valid screen edge; Magpie stores signed LONGs as HANDLEs.
    (handle.0 as isize as i32) as f64
}

#[cfg(windows)]
pub fn read_native_magpie_info() -> Option<MagpieInfo> {
    let class = wide_null(MAGPIE_SCALING_WINDOW_CLASS);
    let hwnd = unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR::null()).ok()? };
    if hwnd.0.is_null() || !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return None;
    }
    if !unsafe { IsWindowVisible(hwnd).as_bool() } {
        return None;
    }

    let src_handle = unsafe {
        let w = wide_null("Magpie.SrcHWND");
        GetPropW(hwnd, PCWSTR(w.as_ptr()))
    };
    let source_hwnd = src_handle.0 as usize as u64;

    let dest_left = read_prop_i32(hwnd, "Magpie.DestLeft");
    let dest_top = read_prop_i32(hwnd, "Magpie.DestTop");
    let dest_right = read_prop_i32(hwnd, "Magpie.DestRight");
    let dest_bottom = read_prop_i32(hwnd, "Magpie.DestBottom");
    let src_left = read_prop_i32(hwnd, "Magpie.SrcLeft");
    let src_top = read_prop_i32(hwnd, "Magpie.SrcTop");
    let src_right = read_prop_i32(hwnd, "Magpie.SrcRight");
    let src_bottom = read_prop_i32(hwnd, "Magpie.SrcBottom");

    if source_hwnd == 0
        || dest_right <= dest_left
        || dest_bottom <= dest_top
        || src_right <= src_left
        || src_bottom <= src_top
    {
        return None;
    }

    Some(MagpieInfo {
        hwnd: hwnd.0 as usize as u64,
        source_hwnd,
        window_bounds: EdgeRect {
            left: dest_left,
            top: dest_top,
            right: dest_right,
            bottom: dest_bottom,
        },
        source_window_bounds: EdgeRect {
            left: src_left,
            top: src_top,
            right: src_right,
            bottom: src_bottom,
        },
        magpie_window_top_edge_position: dest_top,
        magpie_window_bottom_edge_position: dest_bottom,
        magpie_window_left_edge_position: dest_left,
        magpie_window_right_edge_position: dest_right,
        source_window_left_edge_position: src_left,
        source_window_top_edge_position: src_top,
        source_window_right_edge_position: src_right,
        source_window_bottom_edge_position: src_bottom,
    })
}

#[cfg(not(windows))]
pub fn read_native_magpie_info() -> Option<MagpieInfo> {
    None
}

/// Normalize external `magpie-info` payloads from Python backend or JS.
#[cfg(test)]
pub fn normalize_magpie_info(value: &Value) -> Option<MagpieInfo> {
    if value.is_null() {
        return None;
    }
    let obj = value.as_object()?;
    let dl = obj
        .get("magpieWindowLeftEdgePosition")
        .or_else(|| obj.get("magpie_window_left_edge_position"))
        .and_then(Value::as_f64)?;
    let dt = obj
        .get("magpieWindowTopEdgePosition")
        .or_else(|| obj.get("magpie_window_top_edge_position"))
        .and_then(Value::as_f64)?;
    let dr = obj
        .get("magpieWindowRightEdgePosition")
        .or_else(|| obj.get("magpie_window_right_edge_position"))
        .and_then(Value::as_f64)?;
    let db = obj
        .get("magpieWindowBottomEdgePosition")
        .or_else(|| obj.get("magpie_window_bottom_edge_position"))
        .and_then(Value::as_f64)?;
    if !dl.is_finite()
        || !dt.is_finite()
        || !dr.is_finite()
        || !db.is_finite()
        || dr <= dl
        || db <= dt
    {
        return None;
    }
    let sl = obj
        .get("sourceWindowLeftEdgePosition")
        .or_else(|| obj.get("source_window_left_edge_position"))
        .and_then(Value::as_f64)
        .unwrap_or(dl);
    let st = obj
        .get("sourceWindowTopEdgePosition")
        .or_else(|| obj.get("source_window_top_edge_position"))
        .and_then(Value::as_f64)
        .unwrap_or(dt);
    let sr = obj
        .get("sourceWindowRightEdgePosition")
        .or_else(|| obj.get("source_window_right_edge_position"))
        .and_then(Value::as_f64)
        .unwrap_or(dr);
    let sb = obj
        .get("sourceWindowBottomEdgePosition")
        .or_else(|| obj.get("source_window_bottom_edge_position"))
        .and_then(Value::as_f64)
        .unwrap_or(db);
    Some(MagpieInfo {
        hwnd: obj.get("hwnd").and_then(Value::as_u64).unwrap_or(0),
        source_hwnd: obj
            .get("source_hwnd")
            .or_else(|| obj.get("sourceHwnd"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        window_bounds: EdgeRect {
            left: dl,
            top: dt,
            right: dr,
            bottom: db,
        },
        source_window_bounds: EdgeRect {
            left: sl,
            top: st,
            right: sr,
            bottom: sb,
        },
        magpie_window_top_edge_position: dt,
        magpie_window_bottom_edge_position: db,
        magpie_window_left_edge_position: dl,
        magpie_window_right_edge_position: dr,
        source_window_left_edge_position: sl,
        source_window_top_edge_position: st,
        source_window_right_edge_position: sr,
        source_window_bottom_edge_position: sb,
    })
}

pub fn magpie_info_to_renderer_json(info: Option<&MagpieInfo>) -> Value {
    let Some(info) = info else {
        return Value::Null;
    };
    json!({
        "source_hwnd": info.source_hwnd,
        "scaling_hwnd": info.hwnd,
        "magpieWindowTopEdgePosition": info.magpie_window_top_edge_position,
        "magpieWindowBottomEdgePosition": info.magpie_window_bottom_edge_position,
        "magpieWindowLeftEdgePosition": info.magpie_window_left_edge_position,
        "magpieWindowRightEdgePosition": info.magpie_window_right_edge_position,
        "sourceWindowLeftEdgePosition": info.source_window_left_edge_position,
        "sourceWindowTopEdgePosition": info.source_window_top_edge_position,
        "sourceWindowRightEdgePosition": info.source_window_right_edge_position,
        "sourceWindowBottomEdgePosition": info.source_window_bottom_edge_position,
    })
}

/// Sample physical cursor position and mouse button bitmask with zero heap allocations.
#[cfg(windows)]
pub fn sample_pointer() -> Option<PointerSample> {
    let mut pt = POINT::default();
    if unsafe { GetPhysicalCursorPos(&mut pt) }.is_err() {
        return None;
    }
    let mut buttons = 0u8;
    unsafe {
        if (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 {
            buttons |= 1;
        }
        if (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000) != 0 {
            buttons |= 2;
        }
        if (GetAsyncKeyState(VK_MBUTTON.0 as i32) as u16 & 0x8000) != 0 {
            buttons |= 4;
        }
        if (GetAsyncKeyState(VK_XBUTTON1.0 as i32) as u16 & 0x8000) != 0 {
            buttons |= 8;
        }
        if (GetAsyncKeyState(VK_XBUTTON2.0 as i32) as u16 & 0x8000) != 0 {
            buttons |= 16;
        }
    }
    Some(PointerSample {
        x: pt.x,
        y: pt.y,
        buttons,
        shift: unsafe { GetAsyncKeyState(0x10) < 0 },
        ctrl: unsafe { GetAsyncKeyState(0x11) < 0 },
        alt: unsafe { GetAsyncKeyState(0x12) < 0 },
        meta: unsafe { GetAsyncKeyState(0x5b) < 0 || GetAsyncKeyState(0x5c) < 0 },
    })
}

#[cfg(not(windows))]
pub fn sample_pointer() -> Option<PointerSample> {
    None
}

/// Returns `true` if `candidate_hwnd` sits higher in Z-order than `overlay_hwnd`.
#[cfg(windows)]
pub fn is_window_above(candidate_hwnd: u64, overlay_hwnd: isize) -> bool {
    if candidate_hwnd == 0 || overlay_hwnd == 0 {
        return false;
    }
    let mut cursor = HWND(overlay_hwnd as *mut _);
    for _ in 0..1024 {
        let Ok(prev) = (unsafe { GetWindow(cursor, GW_HWNDPREV) }) else {
            return false;
        };
        if prev.0.is_null() {
            return false;
        }
        if prev.0 as usize as u64 == candidate_hwnd {
            return true;
        }
        cursor = prev;
    }
    false
}

#[cfg(not(windows))]
pub fn is_window_above(_candidate_hwnd: u64, _overlay_hwnd: isize) -> bool {
    false
}

pub fn renderer_signature(info: &MagpieInfo) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
        info.source_hwnd,
        info.hwnd,
        info.source_window_bounds.left,
        info.source_window_bounds.top,
        info.source_window_bounds.right,
        info.source_window_bounds.bottom,
        info.window_bounds.left,
        info.window_bounds.top,
        info.window_bounds.right,
        info.window_bounds.bottom
    )
}

#[cfg(windows)]
pub fn source_focused(info: &MagpieInfo) -> bool {
    unsafe { GetForegroundWindow().0 as usize as u64 == info.source_hwnd }
}
#[cfg(not(windows))]
pub fn source_focused(_: &MagpieInfo) -> bool {
    false
}

#[cfg(windows)]
pub fn cursor_captured(info: &MagpieInfo) -> bool {
    unsafe {
        GetWindowLongW(HWND(info.hwnd as usize as *mut _), GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT.0
            != 0
    }
}
#[cfg(not(windows))]
pub fn cursor_captured(_: &MagpieInfo) -> bool {
    false
}

/// Magpie warps its captured cursor into source pixels. Project those pixel
/// centers forward into the scaled destination, matching CursorManager.
#[inline]
pub fn project_magpie_cursor(x: f64, y: f64, info: &MagpieInfo) -> Option<(f64, f64)> {
    if !info.source_window_bounds.contains(x, y) {
        return None;
    }
    let dest_w = info.window_bounds.width();
    let dest_h = info.window_bounds.height();
    let src_w = info.source_window_bounds.width();
    let src_h = info.source_window_bounds.height();
    if dest_w <= 0.0 || dest_h <= 0.0 || src_w <= 0.0 || src_h <= 0.0 {
        return None;
    }
    let mapped_x = info.window_bounds.left
        + ((x - info.source_window_bounds.left) / (src_w - 1.).max(1.) * (dest_w - 1.)).round();
    let mapped_y = info.window_bounds.top
        + ((y - info.source_window_bounds.top) / (src_h - 1.).max(1.) * (dest_h - 1.)).round();
    Some((mapped_x, mapped_y))
}

pub fn monitor_to_display_info(
    id: usize,
    monitor: &Monitor,
    primary_pos: Option<tauri::PhysicalPosition<i32>>,
) -> DisplayInfo {
    let scale = monitor.scale_factor();
    let phys_pos = monitor.position();
    let phys_size = monitor.size();
    let log_pos = phys_pos.to_logical::<f64>(scale);
    let log_size = phys_size.to_logical::<f64>(scale);
    let work = monitor.work_area();
    let work_log_pos = work.position.to_logical::<f64>(scale);
    let work_log_size = work.size.to_logical::<f64>(scale);

    DisplayInfo {
        id,
        label: monitor.name().cloned().unwrap_or_default(),
        scale_factor: scale,
        bounds: RectF64 {
            x: log_pos.x,
            y: log_pos.y,
            width: log_size.width.max(1.0),
            height: log_size.height.max(1.0),
        },
        work_area: RectF64 {
            x: work_log_pos.x,
            y: work_log_pos.y,
            width: work_log_size.width.max(1.0),
            height: work_log_size.height.max(1.0),
        },
        size: SizeF64 {
            width: log_size.width.max(1.0),
            height: log_size.height.max(1.0),
        },
        work_area_size: SizeF64 {
            width: work_log_size.width.max(1.0),
            height: work_log_size.height.max(1.0),
        },
        physical_bounds: RectF64 {
            x: phys_pos.x as f64,
            y: phys_pos.y as f64,
            width: (phys_size.width as f64).max(1.0),
            height: (phys_size.height as f64).max(1.0),
        },
        physical_work_area: RectF64 {
            x: work.position.x as f64,
            y: work.position.y as f64,
            width: (work.size.width as f64).max(1.0),
            height: (work.size.height as f64).max(1.0),
        },
        physical_size: SizeF64 {
            width: (phys_size.width as f64).max(1.0),
            height: (phys_size.height as f64).max(1.0),
        },
        physical_work_area_size: SizeF64 {
            width: (work.size.width as f64).max(1.0),
            height: (work.size.height as f64).max(1.0),
        },
        primary: primary_pos.is_some_and(|p| p == *phys_pos),
    }
}

pub fn collect_displays(app: &AppHandle) -> Vec<DisplayInfo> {
    let Ok(monitors) = app.available_monitors() else {
        return Vec::new();
    };
    let primary_pos = app.primary_monitor().ok().flatten().map(|m| *m.position());
    monitors
        .iter()
        .enumerate()
        .map(|(idx, m)| monitor_to_display_info(idx, m, primary_pos))
        .collect()
}

pub fn select_target_display(
    displays: &[DisplayInfo],
    monitor_index: i64,
    monitor_id: &str,
) -> Option<DisplayInfo> {
    if displays.is_empty() {
        return None;
    }
    let trimmed_id = monitor_id.trim();
    if !trimmed_id.is_empty() {
        if let Some(found) = displays
            .iter()
            .find(|d| d.label == trimmed_id || d.id.to_string() == trimmed_id)
        {
            return Some(found.clone());
        }
    }
    if monitor_index >= 0 {
        if let Some(found) = displays.get(monitor_index as usize) {
            return Some(found.clone());
        }
    }
    displays
        .iter()
        .find(|d| d.primary)
        .cloned()
        .or_else(|| displays.first().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn projects_magpie_cursor_accurately() {
        let info = MagpieInfo {
            hwnd: 123,
            source_hwnd: 456,
            window_bounds: EdgeRect {
                left: 0.0,
                top: 0.0,
                right: 3840.0,
                bottom: 2160.0,
            },
            source_window_bounds: EdgeRect {
                left: 100.0,
                top: 200.0,
                right: 1380.0,
                bottom: 920.0,
            },
            ..Default::default()
        };
        assert_eq!(project_magpie_cursor(100.0, 200.0, &info), Some((0.0, 0.0)));
        assert_eq!(
            project_magpie_cursor(1379.0, 919.0, &info),
            Some((3839.0, 2159.0))
        );
        assert!(project_magpie_cursor(-1.0, 100.0, &info).is_none());
    }

    #[test]
    fn magpie_renderer_signature_and_negative_monitor_projection_agree() {
        let info = MagpieInfo {
            hwnd: 123,
            source_hwnd: 456,
            source_window_bounds: EdgeRect {
                left: -1200.0,
                top: 100.0,
                right: -200.0,
                bottom: 800.0,
            },
            window_bounds: EdgeRect {
                left: -3840.0,
                top: 0.0,
                right: 0.0,
                bottom: 2160.0,
            },
            ..Default::default()
        };
        assert_eq!(
            renderer_signature(&info),
            "456:123:-1200:100:-200:800:-3840:0:0:2160"
        );
        let payload = magpie_info_to_renderer_json(Some(&info));
        assert_eq!(payload["source_hwnd"], 456);
        assert_eq!(payload["scaling_hwnd"], 123);
        assert_eq!(
            project_magpie_cursor(-1200.0, 100.0, &info),
            Some((-3840.0, 0.0))
        );
        assert_eq!(
            project_magpie_cursor(-201.0, 799.0, &info),
            Some((-1.0, 2159.0))
        );
    }

    #[test]
    fn normalizes_python_magpie_payload() {
        let raw = json!({
            "magpieWindowLeftEdgePosition": 0,
            "magpieWindowTopEdgePosition": 0,
            "magpieWindowRightEdgePosition": 1920,
            "magpieWindowBottomEdgePosition": 1080,
            "sourceWindowLeftEdgePosition": 10,
            "sourceWindowTopEdgePosition": 20,
            "sourceWindowRightEdgePosition": 1290,
            "sourceWindowBottomEdgePosition": 740,
        });
        let info = normalize_magpie_info(&raw).unwrap();
        assert_eq!(info.window_bounds.width(), 1920.0);
        assert_eq!(info.source_window_bounds.height(), 720.0);
    }

    #[test]
    fn benchmark_magpie_projection_100k_samples() {
        let info = MagpieInfo {
            window_bounds: EdgeRect {
                left: 0.0,
                top: 0.0,
                right: 2560.0,
                bottom: 1440.0,
            },
            source_window_bounds: EdgeRect {
                left: 320.0,
                top: 180.0,
                right: 1600.0,
                bottom: 900.0,
            },
            ..Default::default()
        };
        let started = Instant::now();
        let mut acc = 0.0f64;
        for i in 0..100_000 {
            let x = (i % 2560) as f64;
            let y = ((i * 7) % 1440) as f64;
            if let Some((mx, my)) = project_magpie_cursor(x, y, &info) {
                acc += mx + my;
            }
        }
        let elapsed = started.elapsed();
        assert!(acc > 0.0);
        println!(
            "[bench] project_magpie_cursor_100k total_ms={:.3} ns_per_sample={:.1}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1e9 / 100_000.0
        );
    }
}
