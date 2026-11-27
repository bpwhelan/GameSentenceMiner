//! Process-wide capture sessions shared by all native consumers.
#[cfg(windows)]
mod wgc;
#[cfg(windows)]
pub use wgc::{statistics, Capture, Target};
pub mod obs;
/// One-shot thumbnails use the same session registry as long-lived consumers.
pub fn window_image(window: &xcap::Window, state: &mut Capture) -> Result<RgbaImage, String> {
    #[cfg(windows)]
    {
        capture_window(
            &serde_json::json!({"target_id":window.id().map_err(|e|e.to_string())?}),
            state,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        window.capture_image().map_err(|e| e.to_string())
    }
}
pub fn monitor_image(monitor: &xcap::Monitor, state: &mut Capture) -> Result<RgbaImage, String> {
    #[cfg(windows)]
    {
        let bounds = [
            monitor.x().map_err(|e| e.to_string())? as f64,
            monitor.y().map_err(|e| e.to_string())? as f64,
            monitor.width().map_err(|e| e.to_string())? as f64,
            monitor.height().map_err(|e| e.to_string())? as f64,
        ];
        state.grab(
            Target::monitor(bounds),
            (bounds[2] as u32, bounds[3] as u32),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        monitor.capture_image().map_err(|e| e.to_string())
    }
}
#[cfg(windows)]
pub mod desktop;
/// Fresh physical desktop pixels, with the virtual desktop's possibly negative origin.
pub struct DesktopSnapshot {
    pub left: i32,
    pub top: i32,
    pub image: RgbaImage,
}
/// A one-shot desktop read, with no persistent capture session or idle work.
#[cfg(windows)]
pub fn desktop_snapshot() -> Result<DesktopSnapshot, String> {
    let (bitmap, left, top) = desktop::capture()?;
    let (width, height) = bitmap.dimensions();
    Ok(DesktopSnapshot {
        left,
        top,
        image: bitmap.crop_rgba([0, 0, width, height]),
    })
}
#[cfg(not(windows))]
pub fn desktop_snapshot() -> Result<DesktopSnapshot, String> {
    let frames = xcap::Monitor::all()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|m| {
            Ok((
                m.x().map_err(|e| e.to_string())?,
                m.y().map_err(|e| e.to_string())?,
                m.capture_image().map_err(|e| e.to_string())?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let left = frames
        .iter()
        .map(|(x, _, _)| *x)
        .min()
        .ok_or("No desktop displays")?;
    let top = frames.iter().map(|(_, y, _)| *y).min().unwrap();
    let right = frames
        .iter()
        .map(|(x, _, i)| *x as i64 + i.width() as i64)
        .max()
        .unwrap();
    let bottom = frames
        .iter()
        .map(|(_, y, i)| *y as i64 + i.height() as i64)
        .max()
        .unwrap();
    let (width, height) = ((right - left as i64) as u32, (bottom - top as i64) as u32);
    if width as u64 * height as u64 > 64_000_000 || width > 32767 || height > 32767 {
        return Err("Desktop is too large for area selection".into());
    }
    let mut image = RgbaImage::new(width, height);
    for (x, y, frame) in frames {
        image::imageops::replace(&mut image, &frame, (x - left) as i64, (y - top) as i64);
    }
    Ok(DesktopSnapshot { left, top, image })
}

use image::RgbaImage;

pub fn scale_for_ocr(image: RgbaImage, scale: f64) -> RgbaImage {
    use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};

    if scale >= 1. || image.is_empty() {
        return image;
    }
    let width = (image.width() as f64 * scale).max(1.) as u32;
    let height = (image.height() as f64 * scale).max(1.) as u32;
    let mut scaled = RgbaImage::new(width, height);
    // Match the previous triangle filter with independent RGBA channels.
    let options = ResizeOptions::new()
        .resize_alg(ResizeAlg::Convolution(FilterType::Bilinear))
        .use_alpha(false);
    if Resizer::new()
        .resize(&image, &mut scaled, &options)
        .is_err()
    {
        return image::imageops::resize(
            &image,
            width,
            height,
            image::imageops::FilterType::Triangle,
        );
    }
    scaled
}

#[cfg(windows)]
pub fn crop_client(
    image: RgbaImage,
    outer: [f64; 4],
    id: u64,
) -> Result<(RgbaImage, [f64; 4]), String> {
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        UI::WindowsAndMessaging::GetClientRect,
    };
    let hwnd = HWND(id as usize as *mut _);
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        GetClientRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
        ClientToScreen(hwnd, &mut origin)
            .ok()
            .map_err(|e| e.to_string())?;
    }
    let client = [
        origin.x as f64,
        origin.y as f64,
        (rect.right - rect.left) as f64,
        (rect.bottom - rect.top) as f64,
    ];
    let sx = image.width() as f64 / outer[2];
    let sy = image.height() as f64 / outer[3];
    let x = ((client[0] - outer[0]) * sx).round().max(0.) as u32;
    let y = ((client[1] - outer[1]) * sy).round().max(0.) as u32;
    let w = (client[2] * sx).round().max(0.) as u32;
    let h = (client[3] * sy).round().max(0.) as u32;
    if w == 0 || h == 0 || x + w > image.width() || y + h > image.height() {
        return Err("Game client geometry changed during capture".into());
    }
    if x == 0 && y == 0 && w == image.width() && h == image.height() {
        return Ok((image, client));
    }
    Ok((
        image::imageops::crop_imm(&image, x, y, w, h).to_image(),
        client,
    ))
}
#[cfg(not(windows))]
pub fn crop_client(
    image: RgbaImage,
    outer: [f64; 4],
    _id: u64,
) -> Result<(RgbaImage, [f64; 4]), String> {
    Ok((image, outer))
}

use serde_json::Value;
#[cfg(not(windows))]
#[derive(Default)]
pub struct Capture;
#[cfg(not(windows))]
impl Capture {
    pub fn clear(&mut self) {}
}
fn monitor(config: &Value) -> Result<xcap::Monitor, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let b = &config["settings"]["monitor_to_capture_bounds"];
    let id = config["settings"]["monitor_to_capture_id"]
        .as_str()
        .unwrap_or("");
    monitors
        .iter()
        .find(|m| {
            (!id.is_empty() && m.id().ok().map(|n| n.to_string()).as_deref() == Some(id))
                || (b["left"].as_i64() == m.x().ok().map(i64::from)
                    && b["top"].as_i64() == m.y().ok().map(i64::from)
                    && b["width"].as_u64() == m.width().ok().map(u64::from))
        })
        .cloned()
        .or_else(|| {
            monitors
                .get(
                    config["settings"]["monitor_to_capture"]
                        .as_f64()
                        .unwrap_or(0.)
                        .max(0.) as usize,
                )
                .cloned()
        })
        .ok_or("Selected overlay monitor is unavailable".into())
}
/// Geometry for an OBS frame, without taking an additional desktop screenshot.
pub fn source_projection(config: &Value) -> Result<([f64; 4], [f64; 4]), String> {
    let m = monitor(config)?;
    let bounds = [
        m.x().map_err(|e| e.to_string())? as f64,
        m.y().map_err(|e| e.to_string())? as f64,
        m.width().map_err(|e| e.to_string())? as f64,
        m.height().map_err(|e| e.to_string())? as f64,
    ];
    let Some(id) = config["target_id"].as_u64().filter(|id| *id != 0) else {
        return Ok((bounds, bounds));
    };
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::{HWND, POINT, RECT},
            Graphics::Gdi::ClientToScreen,
            UI::WindowsAndMessaging::{GetClientRect, IsIconic, IsWindow},
        };
        let hwnd = HWND(id as usize as *mut _);
        let mut rect = RECT::default();
        let mut origin = POINT::default();
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() || IsIconic(hwnd).as_bool() {
                return Err("Capture target is closed or minimized".into());
            }
            GetClientRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
            ClientToScreen(hwnd, &mut origin)
                .ok()
                .map_err(|e| e.to_string())?;
        }
        Ok((
            bounds,
            [
                origin.x as f64,
                origin.y as f64,
                (rect.right - rect.left) as f64,
                (rect.bottom - rect.top) as f64,
            ],
        ))
    }
    #[cfg(not(windows))]
    {
        let window = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id().ok().map(u64::from) == Some(id))
            .ok_or("Capture target closed")?;
        Ok((
            bounds,
            [
                window.x().map_err(|e| e.to_string())? as f64,
                window.y().map_err(|e| e.to_string())? as f64,
                window.width().map_err(|e| e.to_string())? as f64,
                window.height().map_err(|e| e.to_string())? as f64,
            ],
        ))
    }
}
pub fn capture(
    config: &Value,
    background: bool,
    _state: &mut Capture,
) -> Result<(RgbaImage, [f64; 4], [f64; 4]), String> {
    let monitor = monitor(config)?;
    let err = |e: xcap::XCapError| e.to_string();
    let bounds = [
        monitor.x().map_err(err)? as f64,
        monitor.y().map_err(err)? as f64,
        monitor.width().map_err(err)? as f64,
        monitor.height().map_err(err)? as f64,
    ];
    let (image, capture) = if background || config["target_id"].is_null() {
        #[cfg(windows)]
        let image = {
            _state.grab(
                wgc::Target::monitor(bounds),
                (bounds[2] as u32, bounds[3] as u32),
            )?
        };
        #[cfg(not(windows))]
        let image = monitor.capture_image().map_err(err)?;
        (image, bounds)
    } else {
        let id = config["target_id"]
            .as_u64()
            .ok_or("Select a game window before scanning the overlay")?;
        let window = xcap::Window::all()
            .map_err(err)?
            .into_iter()
            .find(|w| w.id().ok().map(u64::from) == Some(id))
            .ok_or("Overlay game window is closed")?;
        if window.is_minimized().map_err(err)? {
            return Err("Overlay game window is minimized".into());
        }
        let capture = [
            window.x().map_err(err)? as f64,
            window.y().map_err(err)? as f64,
            window.width().map_err(err)? as f64,
            window.height().map_err(err)? as f64,
        ];
        #[cfg(windows)]
        let image = _state.grab(
            wgc::Target::Window(id),
            (capture[2] as u32, capture[3] as u32),
        )?;
        #[cfg(not(windows))]
        let image = window.capture_image().map_err(err)?;
        crop_client(image, capture, id)?
    };
    Ok((image, bounds, capture))
}

/// Use the authoritative HWND directly, without enumerating desktop windows
/// or monitors on every OCR tick.
#[cfg(windows)]
pub fn capture_window(config: &Value, state: &mut Capture) -> Result<image::RgbaImage, String> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::{IsIconic, IsWindow},
    };
    let id = config["target_id"]
        .as_u64()
        .filter(|id| *id != 0)
        .ok_or("No game capture target")?;
    let hwnd = HWND(id as usize as *mut _);
    let mut bounds = RECT::default();
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() || IsIconic(hwnd).as_bool() {
            state.clear();
            return Err("Game capture target is closed or minimized".into());
        }
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut bounds as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .map_err(|e| e.to_string())?;
    }
    let (w, h) = (bounds.right - bounds.left, bounds.bottom - bounds.top);
    if w <= 0 || h <= 0 {
        return Err("Game capture target has no visible client area".into());
    }
    let image = state.grab(Target::Window(id), (w as u32, h as u32))?;
    crop_client(
        image,
        [bounds.left as f64, bounds.top as f64, w as f64, h as f64],
        id,
    )
    .map(|(image, _)| image)
}

#[cfg(not(windows))]
pub fn capture_window(config: &Value, state: &mut Capture) -> Result<image::RgbaImage, String> {
    capture(config, false, state).map(|(image, _, _)| image)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_resize_preserves_triangle_filter_and_frame_dimensions() {
        let image = RgbaImage::from_fn(65, 37, |x, y| {
            image::Rgba([
                (x * 7) as u8,
                (y * 11) as u8,
                ((x + y) * 5) as u8,
                (x * y) as u8,
            ])
        });
        let original = scale_for_ocr(image.clone(), 1.);
        assert_eq!(original, image);
        for scale in [0.25, 0.5, 0.75, 0.95] {
            let width = (image.width() as f64 * scale) as u32;
            let height = (image.height() as f64 * scale) as u32;
            let expected = image::imageops::resize(
                &image,
                width,
                height,
                image::imageops::FilterType::Triangle,
            );
            let actual = scale_for_ocr(image.clone(), scale);
            assert_eq!(actual.dimensions(), expected.dimensions());
            assert!(actual
                .as_raw()
                .iter()
                .zip(expected.as_raw())
                .all(|(a, b)| a.abs_diff(*b) <= 1));
        }
    }
}
