use image::{imageops, DynamicImage, RgbaImage};
use std::{cmp::Reverse, io::Cursor};
use tauri::image::Image;
use windows::{
    core::{w, PCWSTR},
    Win32::UI::{
        HiDpi::{GetDpiForSystem, GetDpiForWindow, GetSystemMetricsForDpi},
        WindowsAndMessaging::{FindWindowW, SM_CXSMICON},
    },
};

pub fn icon(bytes: &[u8]) -> Result<Image<'static>, String> {
    // The notification area lives on the primary taskbar, independent of GSM's windows.
    let size = unsafe {
        let taskbar_dpi = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null())
            .map_or(0, |hwnd| GetDpiForWindow(hwnd));
        let dpi = if taskbar_dpi == 0 {
            GetDpiForSystem()
        } else {
            taskbar_dpi
        };
        GetSystemMetricsForDpi(SM_CXSMICON, dpi)
    };
    image_for_size(bytes, if size > 0 { size as u32 } else { 16 })
}

fn ico_frame(bytes: &[u8], size: u32) -> Option<RgbaImage> {
    let directory = ico::IconDir::read(Cursor::new(bytes)).ok()?;
    // Prefer an exact match, then the smallest frame we can scale down.
    let entry = directory.entries().iter().min_by_key(|entry| {
        let extent = entry.width().min(entry.height());
        (
            extent < size,
            extent.abs_diff(size),
            Reverse(entry.bits_per_pixel()),
        )
    })?;
    let frame = entry.decode().ok()?;
    RgbaImage::from_raw(frame.width(), frame.height(), frame.into_rgba_data())
}

fn image_for_size(bytes: &[u8], size: u32) -> Result<Image<'static>, String> {
    let image = match ico_frame(bytes, size) {
        Some(image) => image,
        None => image::load_from_memory(bytes)
            .map_err(|error| error.to_string())?
            .into_rgba8(),
    };
    let image = if image.dimensions() == (size, size) {
        image
    } else {
        // Premultiply before filtering so fully transparent pixels can't tint the edges.
        let mut premultiplied = DynamicImage::ImageRgba8(image).into_rgba32f();
        for pixel in premultiplied.pixels_mut() {
            let [red, green, blue, alpha] = &mut pixel.0;
            *red *= *alpha;
            *green *= *alpha;
            *blue *= *alpha;
        }
        let mut resized =
            imageops::resize(&premultiplied, size, size, imageops::FilterType::Lanczos3);
        for pixel in resized.pixels_mut() {
            let [red, green, blue, alpha] = &mut pixel.0;
            if *alpha > 0.0 {
                *red /= *alpha;
                *green /= *alpha;
                *blue /= *alpha;
            }
        }
        DynamicImage::ImageRgba32F(resized).into_rgba8()
    };
    Ok(Image::new_owned(image.into_raw(), size, size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_tray_artwork_at_each_native_size() {
        for bytes in [
            include_bytes!("../../electron-src/assets/gsm.ico").as_slice(),
            include_bytes!("../../electron-src/assets/gsm-paused.ico").as_slice(),
            include_bytes!("../../GSM_Overlay/overlay.ico").as_slice(),
        ] {
            let directory = ico::IconDir::read(Cursor::new(bytes)).unwrap();
            for size in [16, 24, 32] {
                let expected = directory
                    .entries()
                    .iter()
                    .find(|entry| entry.width() == size && entry.height() == size)
                    .unwrap()
                    .decode()
                    .unwrap();
                let actual = image_for_size(bytes, size).unwrap();
                assert_eq!((actual.width(), actual.height()), (size, size));
                assert_eq!(actual.rgba(), expected.rgba_data());
            }
        }
    }

    #[test]
    fn sizes_icons_for_fractional_dpi_and_png_fallbacks() {
        for bytes in [
            include_bytes!("../../electron-src/assets/gsm-loading.ico").as_slice(),
            include_bytes!("../icons/128x128.png").as_slice(),
        ] {
            let actual = image_for_size(bytes, 20).unwrap();
            assert_eq!((actual.width(), actual.height()), (20, 20));
            assert!(actual.rgba().chunks_exact(4).any(|pixel| pixel[3] == 0));
            assert!(actual.rgba().chunks_exact(4).any(|pixel| pixel[3] == 255));
        }
    }
}
