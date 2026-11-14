// SPDX-License-Identifier: GPL-3.0-or-later
//! VOCR's integer luma and OpenCV-compatible line preparation.
use anyhow::{Result, ensure};
use image::{GrayImage, RgbaImage};

pub fn dimensions(width: u32, height: u32) -> Result<()> {
    ensure!(
        width > 0
            && height > 0
            && width <= 16384
            && height <= 16384
            && u64::from(width) * u64::from(height) <= 64_000_000,
        "VOCR capture dimensions are unsupported"
    );
    Ok(())
}
pub fn grey(image: &RgbaImage) -> GrayImage {
    GrayImage::from_fn(image.width(), image.height(), |x, y| {
        let p = image.get_pixel(x, y).0;
        image::Luma([
            ((77 * u32::from(p[0]) + 150 * u32::from(p[1]) + 29 * u32::from(p[2])) >> 8) as u8,
        ])
    })
}
pub fn halve(image: &GrayImage) -> GrayImage {
    GrayImage::from_fn(
        image.width().div_ceil(2),
        image.height().div_ceil(2),
        |x, y| {
            let (a, b) = (x * 2, y * 2);
            let (c, d) = (
                (a + 1).min(image.width() - 1),
                (b + 1).min(image.height() - 1),
            );
            image::Luma([((u32::from(image[(a, b)][0])
                + u32::from(image[(c, b)][0])
                + u32::from(image[(a, d)][0])
                + u32::from(image[(c, d)][0])
                + 2)
                >> 2) as u8])
        },
    )
}
pub fn resized_width(w: u32, h: u32) -> u32 {
    let num = w * 32;
    let mut q = (2 * num + h) / (2 * h);
    if (2 * num + h).is_multiple_of(2 * h) && q % 2 == 1 {
        q -= 1;
    }
    q.clamp(8, 1024)
}
pub fn prepare(image: &GrayImage, dark: bool) -> (Vec<f32>, u32) {
    let width = resized_width(image.width(), image.height());
    let padded = width.div_ceil(8) * 8;
    let horizontal = super::super::meiki::linear_coefficients(image.width(), width);
    let vertical = super::super::meiki::linear_coefficients(image.height(), 32);
    let pixels = image.as_raw();
    let stride = image.width() as usize;
    let value = |x: usize, y: usize| {
        let p = pixels[y * stride + x];
        i32::from(if dark { 255 - p } else { p })
    };
    let mut output = vec![0.; 32 * padded as usize];
    for (y, &(y0, y1, b0, b1)) in vertical.iter().enumerate() {
        for (x, &(x0, x1, a0, a1)) in horizontal.iter().enumerate() {
            let top = value(x0, y0) * a0 + value(x1, y0) * a1;
            let bottom = value(x0, y1) * a0 + value(x1, y1) * a1;
            let pixel = (((b0 * (top >> 4)) >> 16) + ((b1 * (bottom >> 4)) >> 16) + 2) >> 2;
            output[y * padded as usize + x] = pixel as f32 / 127.5 - 1.;
        }
        for x in width..padded {
            output[y * padded as usize + x as usize] =
                output[y * padded as usize + width as usize - 1];
        }
    }
    (output, width)
}
pub fn ink_profile(image: &GrayImage) -> Vec<i64> {
    let mut profile = vec![0; image.width() as usize];
    for y in 1..image.height() {
        for x in 0..image.width() {
            profile[x as usize] += i64::from(image[(x, y)][0].abs_diff(image[(x, y - 1)][0]));
        }
    }
    profile
}
