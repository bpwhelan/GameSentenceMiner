//! Immediate desktop snapshots for native selection windows. Streaming game
//! capture continues to use shared WGC sessions; a snapshot needs no session.
use image::RgbaImage;
use windows::Win32::{
    Foundation::RECT,
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

/// A top-down 32-bit BGR bitmap that can be drawn directly by GDI.
pub struct DesktopBitmap {
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    width: u32,
    height: u32,
}
impl Drop for DesktopBitmap {
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
        }
    }
}

impl DesktopBitmap {
    fn new(width: u32, height: u32, compatible_with: Option<HDC>) -> Result<Self, String> {
        if width == 0
            || height == 0
            || width > 32767
            || height > 32767
            || width as u64 * height as u64 > 64_000_000
        {
            return Err("Desktop dimensions are invalid or too large for area selection".into());
        }
        let mut surface = Self {
            memory: HDC::default(),
            bitmap: HBITMAP::default(),
            previous: HGDIOBJ::default(),
            bits: std::ptr::null_mut(),
            width,
            height,
        };
        unsafe {
            surface.memory = CreateCompatibleDC(compatible_with);
            if surface.memory.0.is_null() {
                return Err("Could not create a desktop snapshot surface".into());
            }
            let mut bits = std::ptr::null_mut();
            surface.bitmap =
                CreateDIBSection(None, &surface.info(), DIB_RGB_COLORS, &mut bits, None, 0)
                    .map_err(|e| format!("Could not allocate desktop snapshot: {e}"))?;
            if bits.is_null() {
                return Err("Desktop snapshot has no pixel buffer".into());
            }
            surface.bits = bits.cast();
            surface.previous = SelectObject(surface.memory, surface.bitmap.into());
            if surface.previous.0.is_null() || surface.previous.0 as isize == -1 {
                return Err("Could not select desktop snapshot surface".into());
            }
            // Keep any gaps between differently-sized displays deterministic.
            std::ptr::write_bytes(surface.bits, 0, surface.byte_len());
        }
        Ok(surface)
    }

    pub fn from_rgba(image: &RgbaImage) -> Result<Self, String> {
        let mut bitmap = Self::new(image.width(), image.height(), None)?;
        for (rgb, bgr) in image.pixels().zip(bitmap.bytes_mut().chunks_exact_mut(4)) {
            bgr.copy_from_slice(&[rgb[2], rgb[1], rgb[0], 0]);
        }
        Ok(bitmap)
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn info(&self) -> BITMAPINFO {
        BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: self.width as i32,
                biHeight: -(self.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn byte_len(&self) -> usize {
        self.width as usize * self.height as usize * 4
    }

    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.bits, self.byte_len()) }
    }

    fn bytes_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.bits, self.byte_len()) }
    }

    pub fn dimmed(&self) -> Result<Self, String> {
        let mut bitmap = Self::new(self.width, self.height, Some(self.memory))?;
        fn dim(channel: u8) -> u8 {
            (u16::from(channel) * 45 / 100) as u8
        }
        for (bright, dark) in self
            .bytes()
            .chunks_exact(4)
            .zip(bitmap.bytes_mut().chunks_exact_mut(4))
        {
            dark.copy_from_slice(&[dim(bright[0]), dim(bright[1]), dim(bright[2]), 0]);
        }
        Ok(bitmap)
    }

    pub fn crop_rgba(&self, [left, top, right, bottom]: [u32; 4]) -> RgbaImage {
        assert!(left <= right && top <= bottom && right <= self.width && bottom <= self.height);
        let pixels = self.bytes();
        RgbaImage::from_fn(right - left, bottom - top, |x, y| {
            let start = ((top + y) * self.width + left + x) as usize * 4;
            image::Rgba([pixels[start + 2], pixels[start + 1], pixels[start], 255])
        })
    }

    /// Paint a rectangle with matching source and destination coordinates.
    ///
    /// # Safety
    /// The destination must be a valid GDI device context on this thread.
    pub unsafe fn blit(&self, dc: HDC, rect: RECT) {
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if BitBlt(
            dc,
            rect.left,
            rect.top,
            width,
            height,
            Some(self.memory),
            rect.left,
            rect.top,
            SRCCOPY,
        )
        .is_err()
        {
            // A window DC can belong to a different display device.
            StretchDIBits(
                dc,
                rect.left,
                rect.top,
                width,
                height,
                rect.left,
                // GDI specifies the source scan offset from the bottom.
                self.height as i32 - rect.bottom,
                width,
                height,
                Some(self.bits.cast()),
                &self.info(),
                DIB_RGB_COLORS,
                SRCCOPY,
            );
        }
    }
}

/// Capture fresh desktop pixels and their physical virtual-desktop origin.
pub fn capture() -> Result<(DesktopBitmap, i32, i32), String> {
    unsafe {
        let _dpi = DpiScope(SetThreadDpiAwarenessContext(
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        ));
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let screen = GetDC(None);
        if screen.0.is_null() {
            return Err("Could not access the desktop surface".into());
        }
        let captured =
            DesktopBitmap::new(width as u32, height as u32, Some(screen)).and_then(|bitmap| {
                BitBlt(
                    bitmap.memory,
                    0,
                    0,
                    width,
                    height,
                    Some(screen),
                    left,
                    top,
                    SRCCOPY | CAPTUREBLT,
                )
                .map_err(|e| format!("Desktop snapshot failed: {e}"))?;
                // Required before reading the DIB's memory after GDI drawing.
                GdiFlush()
                    .ok()
                    .map_err(|e| format!("Desktop snapshot did not finish: {e}"))?;
                Ok((bitmap, left, top))
            });
        ReleaseDC(None, screen);
        captured
    }
}
