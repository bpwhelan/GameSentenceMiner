// SPDX-License-Identifier: GPL-3.0-or-later
//! rtr46's MIDA horizontal detector. Geometry follows the meikipop MIDA provider
//! at 0bb61ca117667faccb485f034e5e6b1d489569c0 (adapted from vita-vn-ocr).
use super::{meiki, vocr::LineBox};
use crate::{inference::Model, models};
use anyhow::{Result, ensure};
use image::RgbaImage;
use std::path::Path;

pub(super) struct Finder(Model);

impl Finder {
    pub fn new(root: &Path) -> Result<Self> {
        let path = models::pinned_model(
            root,
            "rtr46/mida",
            "0805742410e7d4daf797ff4993e4ad9b53d95a04",
            "mida_l_alpha_v0.0.2.onnx",
            "7a09988b2596ef3fda2e5dfa815bfebbba6d3dcc385cc905cbb329cd8c95a4fa",
        )?;
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(4));
        Ok(Self(Model::file(&path, threads)?))
    }
    pub fn detect(&mut self, image: &RgbaImage) -> Result<Vec<LineBox>> {
        let (w, h) = image.dimensions();
        ensure!(w > 0 && h > 0, "Empty MIDA input");
        let scale = (960. / w as f64).min(544. / h as f64);
        let height = (h as f64 * scale).round_ties_even().max(1.) as u32;
        let width = (w as f64 * height as f64 / h as f64)
            .round_ties_even()
            .clamp(1., 1920.) as u32;
        let input = meiki::resize_tensor(image, width, height, width, height, [2, 1, 0])?;
        self.0.infer(|session| {
            let output = session.run(ort::inputs!["images" => &input])?;
            let (shape, maps) = output["maps"].try_extract_tensor::<f32>()?;
            let (rows, cols) = (height.div_ceil(8) as usize, width.div_ceil(8) as usize);
            ensure!(
                shape.as_ref() == [1, 4, rows as i64, cols as i64],
                "Unexpected MIDA output shape"
            );
            Ok(decode(maps, rows, cols, (width, height), (w, h)))
        })
    }
}

fn decode(
    maps: &[f32],
    rows: usize,
    cols: usize,
    input: (u32, u32),
    source: (u32, u32),
) -> Vec<LineBox> {
    let plane = rows * cols;
    let (fx, fy) = (
        input.0 as f64 / source.0 as f64,
        input.1 as f64 / source.1 as f64,
    );
    let end_pad = (4. * source.1 as f64 / 544.).round_ties_even().max(2.);
    let mut active: Vec<_> = maps[..plane].iter().map(|k| *k > 0.).collect();
    let mut stack = Vec::new();
    let mut lines = Vec::new();
    for seed in 0..plane {
        if !std::mem::take(&mut active[seed]) {
            continue;
        }
        stack.push(seed);
        let (mut left, mut right) = (cols, 0);
        let (mut top, mut bottom, mut orientation, mut count) = (0., 0., 0., 0);
        while let Some(i) = stack.pop() {
            let (y, x) = (i / cols, i % cols);
            let centre = (8 * y) as f64 + 3.5;
            top += centre - 8. * f64::from(maps[2 * plane + i]);
            bottom += centre + 8. * f64::from(maps[3 * plane + i]);
            orientation += f64::from(maps[plane + i]);
            count += 1;
            left = left.min(x);
            right = right.max(x + 1);
            let mut visit = |n: usize| {
                if std::mem::take(&mut active[n]) {
                    stack.push(n);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x + 1 < cols {
                visit(i + 1);
            }
            if y > 0 {
                visit(i - cols);
            }
            if y + 1 < rows {
                visit(i + cols);
            }
        }
        if count < 2 || orientation > 0. {
            continue;
        }
        top /= f64::from(count) * fy;
        bottom /= f64::from(count) * fy;
        if bottom - top < 1. {
            continue;
        }
        let grow = 0.4 * (bottom - top) * fy / fx + end_pad;
        let x = ((left * 8) as f64 / fx - grow).floor().max(0.) as i64;
        let y = top.floor().max(0.) as i64;
        let x1 = ((right * 8) as f64 / fx + grow).ceil().min(source.0 as f64) as i64;
        let y1 = bottom.ceil().min(source.1 as f64) as i64;
        if x1 > x && y1 > y {
            lines.push(LineBox {
                x,
                y,
                w: x1 - x,
                h: y1 - y,
                ..Default::default()
            });
        }
    }
    lines.sort_by_key(|b| (b.y, b.x));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn horizontal_components_are_clipped_and_mapped_to_source_pixels() {
        // A two-cell line touches the left edge. A separate vertical pair
        // and an isolated positive cell should produce no boxes.
        let mut maps = vec![0.; 4 * 12];
        for i in [0, 1, 6, 10, 3] {
            maps[i] = 1.;
        }
        for i in [6, 10] {
            maps[12 + i] = 2.;
        }
        maps[36..].fill(1.);
        let lines = decode(&maps, 3, 4, (32, 24), (64, 48));
        assert_eq!(
            lines.iter().map(LineBox::edges).collect::<Vec<_>>(),
            [[0., 7., 41., 23.]]
        );
    }
}
