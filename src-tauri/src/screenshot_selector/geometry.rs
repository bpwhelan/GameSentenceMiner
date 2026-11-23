use crate::settings::Settings;
use serde::Deserialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

#[derive(Clone, Copy, Deserialize)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn fit(saved: Option<Rect>, screens: &[Rect]) -> Rect {
    let primary = screens.first().copied().unwrap_or(Rect {
        x: 0.,
        y: 0.,
        w: 1280.,
        h: 900.,
    });
    let Some(r) = saved.filter(|r| r.w >= 2. && r.h >= 2.) else {
        return Rect {
            x: primary.x + primary.w * 0.05,
            y: primary.y + primary.h * 0.05,
            w: primary.w * 0.9,
            h: primary.h * 0.9,
        };
    };
    let score = |s: &Rect| {
        let dx = ((r.x + r.w).min(s.x + s.w) - r.x.max(s.x)).max(0.);
        let dy = ((r.y + r.h).min(s.y + s.h) - r.y.max(s.y)).max(0.);
        let cx = r.x + r.w / 2. - s.x - s.w / 2.;
        let cy = r.y + r.h / 2. - s.y - s.h / 2.;
        (dx * dy, -cx.mul_add(cx, cy * cy))
    };
    let s = screens
        .iter()
        .copied()
        .max_by(|a, b| {
            let (ao, ad) = score(a);
            let (bo, bd) = score(b);
            ao.total_cmp(&bo).then(ad.total_cmp(&bd))
        })
        .unwrap_or(primary);
    let w = r.w.max(720.).min(s.w);
    let h = r.h.max(520.).min(s.h);
    Rect {
        x: r.x.clamp(s.x, (s.x + s.w - w).max(s.x)),
        y: r.y.clamp(s.y, (s.y + s.h - h).max(s.y)),
        w,
        h,
    }
}

pub(super) fn restore(app: &AppHandle) -> Rect {
    fit(saved_rect(app, "screenshot_selector"), &screens(app))
}

fn saved_rect(app: &AppHandle, key: &str) -> Option<Rect> {
    let path = app
        .state::<Settings>()
        .paths
        .active
        .join("window_layout.json");
    gsm_settings::read_object(&path)
        .ok()
        .and_then(|v| serde_json::from_value(v[key].clone()).ok())
}

fn screens(app: &AppHandle) -> Vec<Rect> {
    app.primary_monitor()
        .ok()
        .flatten()
        .into_iter()
        .chain(app.available_monitors().unwrap_or_default())
        .map(|m| {
            let area = m.work_area();
            let p = area.position.to_logical::<f64>(m.scale_factor());
            let s = area.size.to_logical::<f64>(m.scale_factor());
            Rect {
                x: p.x,
                y: p.y,
                w: s.width,
                h: s.height,
            }
        })
        .collect()
}

pub(crate) fn restore_named(
    app: &AppHandle,
    key: &str,
    default: (f64, f64),
    min: (f64, f64),
    window: &WebviewWindow,
) {
    if let Some(saved) = saved_rect(app, key).filter(|r| r.w >= 2. && r.h >= 2.) {
        let screen_rects = screens(app);
        let fitted = fit(Some(saved), &screen_rects);
        let width = saved.w.max(min.0).min(fitted.w);
        let height = saved.h.max(min.1).min(fitted.h);
        let _ = window.set_size(LogicalSize::new(width, height));
        let _ = window.set_position(LogicalPosition::new(fitted.x, fitted.y));
    } else {
        let _ = window.set_size(LogicalSize::new(default.0, default.1));
    }
}

pub(super) fn save(window: &WebviewWindow) {
    save_named(window, "screenshot_selector");
}

pub(crate) fn save_named(window: &WebviewWindow, key: &str) {
    if window.is_minimized().unwrap_or(true)
        || window.is_maximized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
    {
        return;
    }
    let (Ok(p), Ok(s), Ok(scale)) = (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    let p = p.to_logical::<i32>(scale);
    let s = s.to_logical::<u32>(scale);
    if s.width < 2 || s.height < 2 {
        return;
    }
    let path = window
        .state::<Settings>()
        .paths
        .active
        .join("window_layout.json");
    if let Err(error) = gsm_settings::with_lock(&path, || {
        let mut current = gsm_settings::read_object(&path)?;
        current[key] = serde_json::json!({"x":p.x,"y":p.y,"w":s.width,"h":s.height});
        gsm_settings::write_atomic(&path, &current)
    }) {
        crate::desktop_log::warn(window.app_handle(), "screenshot selector", &error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn moves_a_disconnected_display_inside_the_nearest_work_area() {
        let left = Rect {
            x: -1920.,
            y: 0.,
            w: 1920.,
            h: 1080.,
        };
        let main = Rect {
            x: 0.,
            y: 0.,
            w: 1200.,
            h: 900.,
        };
        let saved = Rect {
            x: 3000.,
            y: -800.,
            w: 900.,
            h: 650.,
        };
        let r = fit(Some(saved), &[main, left]);
        assert_eq!((r.x, r.y, r.w, r.h), (300., 0., 900., 650.));
    }
}
