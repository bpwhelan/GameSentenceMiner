//! Immediate desktop snapshots for native selection windows. Streaming game
//! capture continues to use shared WGC sessions; a snapshot needs no session.
use super::DesktopSnapshot;
use image::RgbaImage;
use windows::Win32::{
    Graphics::Gdi::*,
    UI::{HiDpi::*, WindowsAndMessaging::*},
};

struct DpiScope(DPI_AWARENESS_CONTEXT);
impl Drop for DpiScope {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            unsafe {
                SetThreadDpiAwarenessContext(self.0);
            }
        }
    }
}

#[derive(Default)]
struct Surface {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.0.is_null() && self.previous.0 as isize != -1 {
                SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.0.is_null() {
                let _ = DeleteObject(self.bitmap.into());
            }
            if !self.memory.0.is_null() {
                let _ = DeleteDC(self.memory);
            }
            if !self.screen.0.is_null() {
                ReleaseDC(None, self.screen);
            }
        }
    }
}

pub fn snapshot() -> Result<DesktopSnapshot, String> {
    unsafe {
        let _dpi = DpiScope(SetThreadDpiAwarenessContext(
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        ));
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 0
            || height <= 0
            || width > 32767
            || height > 32767
            || width as u64 * height as u64 > 64_000_000
        {
            return Err("Desktop dimensions are invalid or too large for area selection".into());
        }
        let mut surface = Surface {
            screen: GetDC(None),
            ..Default::default()
        };
        if surface.screen.0.is_null() {
            return Err("Could not access the desktop surface".into());
        }
        surface.memory = CreateCompatibleDC(Some(surface.screen));
        if surface.memory.0.is_null() {
            return Err("Could not create a desktop snapshot surface".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down physical desktop pixels
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        surface.bitmap = CreateDIBSection(
            Some(surface.screen),
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )
        .map_err(|e| format!("Could not allocate desktop snapshot: {e}"))?;
        if bits.is_null() {
            return Err("Desktop snapshot has no pixel buffer".into());
        }
        surface.previous = SelectObject(surface.memory, surface.bitmap.into());
        if surface.previous.0.is_null() || surface.previous.0 as isize == -1 {
            return Err("Could not select desktop snapshot surface".into());
        }
        let length = width as usize * height as usize * 4;
        // Keep gaps between differently-sized displays deterministic.
        std::ptr::write_bytes(bits.cast::<u8>(), 0, length);
        BitBlt(
            surface.memory,
            0,
            0,
            width,
            height,
            Some(surface.screen),
            left,
            top,
            SRCCOPY | CAPTUREBLT,
        )
        .map_err(|e| format!("Desktop snapshot failed: {e}"))?;
        // Required before reading a DIB's memory after GDI drawing.
        GdiFlush()
            .ok()
            .map_err(|e| format!("Desktop snapshot did not finish: {e}"))?;
        let mut pixels = std::slice::from_raw_parts(bits.cast::<u8>(), length).to_vec();
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        let image = RgbaImage::from_raw(width as u32, height as u32, pixels)
            .ok_or("Desktop snapshot dimensions changed")?;
        Ok(DesktopSnapshot { left, top, image })
    }
}
