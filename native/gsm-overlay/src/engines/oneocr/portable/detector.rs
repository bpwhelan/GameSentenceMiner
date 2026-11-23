// SPDX-License-Identifier: MPL-2.0
//! Decode the three levels of horizontal and vertical segment proposals. A
//! segment links to at most eight neighbours. Visit each foreground cell once.
use super::*;
use image::{Rgba, imageops::FilterType};

#[derive(Clone, Copy, Default)]
struct Point {
    x: f32,
    y: f32,
}
impl Point {
    fn dot(self, v: Point) -> f32 {
        self.x * v.x + self.y * v.y
    }
}
#[derive(Clone)]
pub(super) struct Line {
    axis: Point,
    extent: [f32; 4],
    pub vertical: bool,
    bounds: [f32; 4],
    score: f32,
}

impl Line {
    pub(super) fn transform(&self) -> [f32; 6] {
        let [a, b, c, d] = self.extent;
        [self.axis.x, self.axis.y, a, b, c, d]
    }
    fn point(&self, u: f32, v: f32) -> Point {
        let [left, top, right, bottom] = self.extent;
        let x = left + u * (right - left);
        let y = top + v * (bottom - top);
        Point {
            x: self.axis.x * x - self.axis.y * y,
            y: self.axis.y * x + self.axis.x * y,
        }
    }
    pub(super) fn bounds(&self, lo: f32, hi: f32) -> [f64; 4] {
        let mut b = [
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ];
        for p in [
            self.point(lo, 0.),
            self.point(hi, 0.),
            self.point(lo, 1.),
            self.point(hi, 1.),
        ] {
            b[0] = b[0].min(p.x);
            b[1] = b[1].min(p.y);
            b[2] = b[2].max(p.x);
            b[3] = b[3].max(p.y);
        }
        b.map(f64::from)
    }
    pub(super) fn pixel_rect(&self, image: &RgbaImage) -> [u32; 4] {
        let [x0, y0, x1, y1] = self.bounds;
        let x = (x0.floor() as u32).min(image.width() - 1);
        let y = (y0.floor() as u32).min(image.height() - 1);
        [
            x,
            y,
            (x1.ceil() as u32)
                .saturating_add(1)
                .min(image.width())
                .saturating_sub(x),
            (y1.ceil() as u32)
                .saturating_add(1)
                .min(image.height())
                .saturating_sub(y),
        ]
    }
    pub(super) fn sample(&self, image: &RgbaImage) -> RgbaImage {
        let [l, t, r, b] = self.extent;
        let width = (60. * (r - l) / (b - t).max(1.)).round().clamp(16., 4096.) as u32;
        RgbaImage::from_fn(width, 60, |x, y| {
            let p = self.point((x as f32 + 0.5) / width as f32, (y as f32 + 0.5) / 60.);
            let px = p.x.clamp(0., (image.width() - 1) as f32);
            let py = p.y.clamp(0., (image.height() - 1) as f32);
            let (x, y) = (px as u32, py as u32);
            let (xx, yy) = (
                (x + 1).min(image.width() - 1),
                (y + 1).min(image.height() - 1),
            );
            let (fx, fy) = (px - x as f32, py - y as f32);
            let mut pixel = Rgba([0, 0, 0, 255]);
            for c in 0..3 {
                let upper = image[(x, y)][c] as f32 * (1. - fx) + image[(xx, y)][c] as f32 * fx;
                let lower = image[(x, yy)][c] as f32 * (1. - fx) + image[(xx, yy)][c] as f32 * fx;
                pixel[c] = (upper * (1. - fy) + lower * fy).round() as u8;
            }
            pixel
        })
    }
}
struct Maps<'a> {
    w: usize,
    h: usize,
    scores: &'a [f32],
    links: &'a [f32],
    deltas: &'a [f32],
    level: usize,
    vertical: bool,
    scale: [f32; 2],
    size: [u32; 2],
}

impl Maps<'_> {
    fn line(&self, group: &[usize], score: f32) -> Option<Line> {
        let stride = (1 << self.level) as f32;
        let size = self.w * self.h;
        let mut corners = Vec::with_capacity(group.len());
        let mut direction = Point::default();
        for &i in group {
            let cx = (i % self.w) as f32 * stride + (stride - 1.) * 0.5;
            let cy = (i / self.w) as f32 * stride + (stride - 1.) * 0.5;
            let span = stride * 8. - 1.;
            let q: [Point; 4] = std::array::from_fn(|j| Point {
                x: ((cx + self.deltas[(2 * j) * size + i] * span) * self.scale[0])
                    .clamp(0., (self.size[0] - 1) as f32),
                y: ((cy + self.deltas[(2 * j + 1) * size + i] * span) * self.scale[1])
                    .clamp(0., (self.size[1] - 1) as f32),
            });
            let end = if self.vertical { 3 } else { 1 };
            direction.x += q[end].x - q[0].x;
            direction.y += q[end].y - q[0].y;
            corners.push(q);
        }
        let norm = direction.x.hypot(direction.y);
        if norm < 1e-5 {
            return None;
        }
        let axis = Point {
            x: direction.x / norm,
            y: direction.y / norm,
        };
        let down = Point {
            x: -axis.y,
            y: axis.x,
        };
        let mut ext = [
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ];
        for p in corners.into_iter().flatten() {
            let u = p.dot(axis);
            let v = p.dot(down);
            ext[0] = ext[0].min(u);
            ext[1] = ext[1].min(v);
            ext[2] = ext[2].max(u);
            ext[3] = ext[3].max(v);
        }
        if ext[2] - ext[0] < 2. || ext[3] - ext[1] < 2. {
            return None;
        }
        let mut line = Line {
            axis,
            extent: ext,
            vertical: self.vertical,
            bounds: [0.; 4],
            score,
        };
        line.bounds = line.bounds(0., 1.).map(|v| v as f32);
        Some(line)
    }
    fn decode(&self, threshold: f32, line_threshold: f32, out: &mut Vec<Line>) {
        let size = self.w * self.h;
        let mut seen = vec![false; size];
        let mut queue = Vec::new();
        const DIRECTIONS: [(isize, isize); 8] = [
            (-1, -1),
            (-1, 0),
            (-1, 1),
            (0, -1),
            (0, 1),
            (1, -1),
            (1, 0),
            (1, 1),
        ];
        for start in 0..size {
            if seen[start] || self.scores[start] < threshold {
                continue;
            }
            queue.clear();
            queue.push(start);
            seen[start] = true;
            let mut cursor = 0;
            let mut total = 0.;
            while cursor < queue.len() {
                let i = queue[cursor];
                cursor += 1;
                total += self.scores[i];
                let (y, x) = (i / self.w, i % self.w);
                for (k, (dy, dx)) in DIRECTIONS.iter().enumerate() {
                    let (Some(y), Some(x)) = (y.checked_add_signed(*dy), x.checked_add_signed(*dx))
                    else {
                        continue;
                    };
                    if y >= self.h || x >= self.w {
                        continue;
                    }
                    let j = y * self.w + x;
                    if !seen[j]
                        && self.scores[j] >= threshold
                        && (self.links[k * size + i] >= 0.8
                            || self.links[(7 - k) * size + j] >= 0.8)
                    {
                        seen[j] = true;
                        queue.push(j);
                    }
                }
            }
            let score = total / queue.len() as f32;
            if score >= line_threshold {
                if let Some(line) = self.line(&queue, score) {
                    out.push(line);
                }
            }
        }
    }
}

pub(super) fn detect(model: &mut Model, image: &RgbaImage, cfg: &Value) -> Result<Vec<Line>> {
    let (ow, oh) = image.dimensions();
    ensure!(ow > 0 && oh > 0, "Empty OneOCR input");
    let scale = 1.5_f32
        .min(1152. / ow.max(oh) as f32)
        .min(768. / ow.min(oh) as f32);
    let align = cfg["image_resize_factor"]
        .as_u64()
        .unwrap_or(32)
        .clamp(1, 128) as u32;
    let dim = |n: u32| {
        let v = (n as f32 * scale).round() as u32;
        if cfg["use_floor_resize"] == true {
            (v / align).max(1) * align
        } else {
            v.div_ceil(align).max(1) * align
        }
    };
    let (w, h) = (dim(ow), dim(oh));
    let resized = imageops::resize(image, w, h, FilterType::Triangle);
    let input = tensor(&resized, true, 1.)?;
    let info = Tensor::from_array(([1usize, 3], vec![h as f32, w as f32, 1.].into_boxed_slice()))?;
    let mut proposals = model.infer(|session| {
        let outputs = session.run(ort::inputs!["data"=>&input,"im_info"=>&info])?;
        let mut lines = Vec::new();
        for level in 2..=4 {
            for (label, vertical) in [("hori", false), ("vert", true)] {
                let suffix = format!("{label}_fpn{level}");
                let (shape, scores) =
                    outputs[format!("scores_{suffix}").as_str()].try_extract_tensor::<f32>()?;
                ensure!(shape.len() == 4, "Invalid detector score shape");
                let (fh, fw) = (shape[2] as usize, shape[3] as usize);
                let links = outputs[format!("link_scores_{suffix}").as_str()]
                    .try_extract_tensor::<f32>()?
                    .1;
                let deltas = outputs[format!("bbox_deltas_{suffix}").as_str()]
                    .try_extract_tensor::<f32>()?
                    .1;
                ensure!(
                    fw * fh == scores.len()
                        && links.len() == 8 * scores.len()
                        && deltas.len() == links.len(),
                    "Invalid detector outputs"
                );
                let maps = Maps {
                    w: fw,
                    h: fh,
                    scores,
                    links,
                    deltas,
                    level,
                    vertical,
                    size: [ow, oh],
                    scale: [ow as f32 / w as f32, oh as f32 / h as f32],
                };
                let threshold = cfg["segment_conf_threshold"].as_f64().unwrap_or(0.7) as f32;
                let confidence = cfg["textline_conf_threshold"][format!("P{level}")]
                    .as_f64()
                    .unwrap_or(0.7) as f32;
                maps.decode(threshold, confidence, &mut lines);
            }
        }
        Ok(lines)
    })?;
    proposals.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep: Vec<Line> = Vec::new();
    for line in proposals.into_iter().take(1000) {
        let overlap = |other: &Line| {
            let (a, b) = (line.bounds, other.bounds);
            let common = (a[2].min(b[2]) - a[0].max(b[0])).max(0.)
                * (a[3].min(b[3]) - a[1].max(b[1])).max(0.);
            let area = |a: [f32; 4]| (a[2] - a[0]) * (a[3] - a[1]);
            common > area(a).min(area(b)) * 0.7
        };
        if !keep.iter().any(overlap) {
            keep.push(line);
        }
    }
    let vertical_page = keep.iter().filter(|l| l.vertical).count() * 2 > keep.len();
    keep.sort_by(|a, b| {
        if vertical_page {
            b.bounds[0]
                .total_cmp(&a.bounds[0])
                .then(a.bounds[1].total_cmp(&b.bounds[1]))
        } else {
            a.bounds[1]
                .total_cmp(&b.bounds[1])
                .then(a.bounds[0].total_cmp(&b.bounds[0]))
        }
    });
    Ok(keep)
}
