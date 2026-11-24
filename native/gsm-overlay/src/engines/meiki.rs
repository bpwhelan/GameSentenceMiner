//! Meiki's published detection and recognition ONNX models run directly in Rust.
//! Tensor and coordinate conventions match rtr46/meikiocr (MIT).
use super::line_cache::{self, LineCache};
use crate::inference::Model;
use crate::{
    models,
    pipeline::{Recognition, TextBox},
};
use anyhow::Result;
use image::{RgbaImage, imageops};
use ort::value::Tensor;
use std::path::{Path, PathBuf};
pub mod selection;
use selection::Detector;

const REC: &str = "meiki.text.rec.v0.960x32.onnx";
const VREC: &str = "meiki.text.rec.v0.vertical.32x480.onnx";
const DETECTION_THRESHOLD: f32 = 0.5;
const MENU_DETECTION_THRESHOLD: f32 = 0.2;

fn column_gap(left: &[f64; 4], right: &[f64; 4]) -> Option<f64> {
    let height = right[3] - right[1];
    let gap = (right[0] - left[2]) / (right[2] - right[0]);
    ((-0.2..=1.7).contains(&gap)
        && (right[1] - left[1]).abs() < 0.15 * height
        && (right[3] - left[3]).abs() < 0.15 * height)
        .then_some(gap)
}

/// A grid of short numbered choices can look like several vertical columns
/// to the detector. Use the glyphs of the right column to propose cuts, and
/// accept the new rows only when horizontal OCR confirms the numbering.
fn recover_numbered_menu(
    boxes: &[([f64; 4], f32)],
    image_width: u32,
    mut read: impl FnMut([f64; 4], bool) -> Result<TextBox>,
) -> Result<Vec<TextBox>> {
    let mut columns: Vec<_> = boxes
        .iter()
        .copied()
        .filter(|(b, _)| b[3] - b[1] > 3. * (b[2] - b[0]))
        .collect();
    columns.sort_by(|a, b| b.0[0].total_cmp(&a.0[0]));
    let pairs = columns
        .iter()
        .enumerate()
        .filter_map(|(i, (right, score))| {
            // Keep the full item in the crop when a label spans adjacent columns.
            if columns[..i]
                .iter()
                .any(|(next, _)| column_gap(right, next).is_some_and(|gap| gap <= 0.5))
            {
                return None;
            }
            let (left, _) = columns[i + 1..].iter().rev().find(|(left, left_score)| {
                score.max(*left_score) >= 0.4 && column_gap(left, right).is_some()
            })?;
            Some((left, right))
        });
    for (left, right) in pairs.take(4) {
        let anchor = read(*right, true)?;
        if !(3..=9).contains(&anchor.words.len()) {
            continue;
        }
        let width = right[2] - right[0];
        let centers: Vec<_> = anchor
            .words
            .iter()
            .map(|w| (w.bounds[1] + w.bounds[3]) / 2.)
            .collect();
        if !centers
            .windows(2)
            .all(|pair| (0.6 * width..=1.6 * width).contains(&(pair[1] - pair[0])))
        {
            continue;
        }
        let margin = (0.12 * width).round();
        let x1 = (left[0] - margin).max(0.);
        let x2 = (right[2] + margin).min(f64::from(image_width));
        // Limit extra space from a detector box that extends beyond the end rows.
        let start = centers[0] - 0.6 * (centers[1] - centers[0]);
        let mut cuts = vec![start.round().max(left[1].min(right[1]))];
        cuts.extend(
            centers
                .windows(2)
                .map(|pair| ((pair[0] + pair[1]) / 2.).round()),
        );
        let end = centers[centers.len() - 1];
        let last_spacing = end - centers[centers.len() - 2];
        cuts.push(
            (end + 0.6 * last_spacing)
                .round()
                .min(left[3].max(right[3])),
        );

        let mut rows = Vec::new();
        for (i, cut) in cuts.windows(2).enumerate() {
            if cut[1] <= cut[0] {
                break;
            }
            let row = read([x1, cut[0], x2, cut[1]], false)?;
            let number = u32::from('1') + i as u32;
            let fullwidth = u32::from('１') + i as u32;
            if !row.words.first().is_some_and(|w| {
                let mut glyphs = w.text.chars();
                matches!(glyphs.next().map(u32::from), Some(n) if n == number || n == fullwidth)
                    && glyphs.next().is_none()
                    && (w.bounds[0] + w.bounds[2]) / 2. <= left[2]
            }) || !row
                .words
                .iter()
                .skip(1)
                .any(|w| w.bounds[0] >= left[2] && w.text.chars().any(char::is_alphabetic))
            {
                break;
            }
            rows.push(row);
        }
        if rows.len() == centers.len() {
            return Ok(rows);
        }
    }
    Ok(Vec::new())
}

pub struct Meiki {
    root: PathBuf,
    detector: Model,
    detector_reg: super::telemetry::ModelRegistration,
    horizontal: Option<(Model, super::telemetry::ModelRegistration)>,
    vertical: Option<(Model, super::telemetry::ModelRegistration)>,
    cache: LineCache,
    pub model: Detector,
}

fn session(path: &Path) -> Result<Model> {
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 4));
    Model::file(path, threads)
}

pub fn install(root: &Path, recognition: bool) -> Result<()> {
    Detector::read(root.parent().unwrap_or(root))?.ensure(root)?;
    if recognition {
        for name in [REC, VREC] {
            models::model(root, "rtr46/meiki.txt.recognition.v0", name)?;
        }
    }
    Ok(())
}

/// RGB, CHW, zero padded on right/bottom. GSM has always supplied RGB to Meiki.
fn tensor(
    image: &RgbaImage,
    width: u32,
    height: u32,
    resized_width: u32,
    resized_height: u32,
) -> Result<Tensor<f32>> {
    resize_tensor(
        image,
        width,
        height,
        resized_width,
        resized_height,
        [0, 1, 2],
    )
}

pub(super) fn resize_tensor(
    image: &RgbaImage,
    width: u32,
    height: u32,
    resized_width: u32,
    resized_height: u32,
    channels: [usize; 3],
) -> Result<Tensor<f32>> {
    // Meiki's Python preprocessor uses cv2.INTER_LINEAR (pixel-center bilinear,
    // no downsampling antialias). imageops::Triangle uses a wider antialias
    // filter: it is slower and changes the model's input on large captures.
    // Write RGB directly to the padded CHW tensor, avoiding an RGBA resize buffer.
    let rw = resized_width.max(1).min(width);
    let rh = resized_height.max(1).min(height);
    let horizontal = linear_coefficients(image.width(), rw);
    let vertical = linear_coefficients(image.height(), rh);
    let plane = (width * height) as usize;
    let mut data = vec![0.0f32; plane * 3];
    let pixels = image.as_raw();
    let stride = image.width() as usize * 4;
    for (y, &(y0, y1, b0, b1)) in vertical.iter().enumerate() {
        for (x, &(x0, x1, a0, a1)) in horizontal.iter().enumerate() {
            for (plane_index, channel) in channels.into_iter().enumerate() {
                let top = pixels[y0 * stride + x0 * 4 + channel] as i32 * a0
                    + pixels[y0 * stride + x1 * 4 + channel] as i32 * a1;
                let bottom = pixels[y1 * stride + x0 * 4 + channel] as i32 * a0
                    + pixels[y1 * stride + x1 * 4 + channel] as i32 * a1;
                // Match OpenCV's uchar vertical pass, including its intermediate
                // truncation; a single final rounding changes some detector boxes.
                let value = (((b0 * (top >> 4)) >> 16) + ((b1 * (bottom >> 4)) >> 16) + 2) >> 2;
                data[plane_index * plane + y * width as usize + x] = value as f32 / 255.0;
            }
        }
    }
    Ok(Tensor::from_array((
        [1usize, 3, height as usize, width as usize],
        data.into_boxed_slice(),
    ))?)
}

pub(crate) fn linear_coefficients(source: u32, destination: u32) -> Vec<(usize, usize, i32, i32)> {
    let scale = source as f64 / destination as f64;
    (0..destination)
        .map(|index| {
            let position = ((index as f64 + 0.5) * scale - 0.5) as f32;
            let left = position.floor();
            let fraction = position - left;
            let first = (left as i64).clamp(0, source as i64 - 1) as usize;
            let second = (left as i64 + 1).clamp(0, source as i64 - 1) as usize;
            (
                first,
                second,
                ((1.0 - fraction) * 2048.0).round_ties_even() as i32,
                (fraction * 2048.0).round_ties_even() as i32,
            )
        })
        .collect()
}

impl Meiki {
    pub fn new(root: &Path) -> Result<Self> {
        Self::with_model(root, Detector::read(root.parent().unwrap_or(root))?)
    }
    pub fn with_model(root: &Path, model: Detector) -> Result<Self> {
        let path = model.ensure(root)?;
        let file_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let (width, height) = model.dimensions();
        let (detector, detector_reg) = super::telemetry::ModelRegistration::measure_load(
            "meiki_detector",
            "MeikiOCR Detector",
            Some(format!("{width}x{height}")),
            file_bytes,
            true,
            || session(&path),
        )?;
        Ok(Self {
            root: root.to_path_buf(),
            detector,
            detector_reg,
            horizontal: None,
            vertical: None,
            cache: LineCache::default(),
            model,
        })
    }
    pub fn detect(&mut self, image: &RgbaImage, threshold: f32) -> Result<Vec<[f64; 4]>> {
        Ok(self
            .detect_with_scores(image, threshold)?
            .into_iter()
            .map(|(bounds, _)| bounds)
            .collect())
    }

    fn detect_with_scores(
        &mut self,
        image: &RgbaImage,
        threshold: f32,
    ) -> Result<Vec<([f64; 4], f32)>> {
        self.detector_reg.touch();
        let mut timer = crate::timing::Timer::new("meiki.detect");
        let (w, h) = image.dimensions();
        let (det_width, det_height) = self.model.dimensions();
        let scale = (det_width as f64 / w as f64).min(det_height as f64 / h as f64);
        let input = tensor(
            image,
            det_width,
            det_height,
            (w as f64 * scale) as u32,
            (h as f64 * scale) as u32,
        )?;
        let sizes = Tensor::from_array((
            [1usize, 2],
            vec![
                (det_width as f64 / scale) as i64,
                (det_height as f64 / scale) as i64,
            ]
            .into_boxed_slice(),
        ))?;
        timer.mark("preprocess");
        let (boxes, scores) = self.detector.infer(|session| {
            let outputs = session.run(ort::inputs![&input, &sizes])?;
            Ok((
                outputs[1].try_extract_tensor::<f32>()?.1.to_vec(),
                outputs[2].try_extract_tensor::<f32>()?.1.to_vec(),
            ))
        })?;
        timer.mark("inference");
        let mut detections = Vec::new();
        for (bbox, score) in boxes.chunks_exact(4).zip(&scores) {
            if *score <= threshold {
                continue;
            }
            let b = [
                (bbox[0] as f64).clamp(0.0, w as f64).floor(),
                (bbox[1] as f64).clamp(0.0, h as f64).floor(),
                (bbox[2] as f64).clamp(0.0, w as f64).floor(),
                (bbox[3] as f64).clamp(0.0, h as f64).floor(),
            ];
            if b[2] > b[0] && b[3] > b[1] {
                detections.push((b, *score));
            }
        }
        detections.sort_by(|a, b| a.0[1].total_cmp(&b.0[1]));
        Ok(detections)
    }

    pub fn recognize(&mut self, image: &RgbaImage) -> Result<Recognition> {
        let mut timer = crate::timing::Timer::new("meiki");
        let boxes = self.detect_with_scores(image, MENU_DETECTION_THRESHOLD)?;
        timer.mark("detection");
        self.cache.begin();
        // Recovery is optional, including when one of its recognizers is unavailable.
        let mut lines = recover_numbered_menu(&boxes, image.width(), |bounds, vertical| {
            self.recognize_line(image, bounds, vertical)
        })
        .unwrap_or_default();
        let menu = lines
            .first()
            .zip(lines.last())
            .map(|(first, last)| TextBox {
                bounds: [
                    first.bounds[0],
                    first.bounds[1],
                    last.bounds[2],
                    last.bounds[3],
                ],
                ..Default::default()
            });
        for (bbox, score) in boxes {
            if score <= DETECTION_THRESHOLD
                || menu.as_ref().is_some_and(|menu| {
                    let detection = TextBox {
                        bounds: bbox,
                        ..Default::default()
                    };
                    crate::pipeline::overlaps(&detection, menu)
                })
            {
                continue;
            }
            let vertical = bbox[3] - bbox[1] > bbox[2] - bbox[0];
            let line = self.recognize_line(image, bbox, vertical)?;
            if !line.text.is_empty() {
                lines.push(line);
            }
        }
        lines.sort_by(|a, b| a.bounds[1].total_cmp(&b.bounds[1]));
        timer.mark("recognition");
        Ok(Recognition::from_lines(lines))
    }

    fn recognize_line(
        &mut self,
        image: &RgbaImage,
        bbox: [f64; 4],
        vertical: bool,
    ) -> Result<TextBox> {
        let [x1, y1, x2, y2] = bbox;
        let (w, h) = ((x2 - x1) as u32, (y2 - y1) as u32);
        let key = line_cache::key(image, [x1 as u32, y1 as u32, w, h], Some(vertical));
        if let Some(line) = self.cache.get(&key) {
            return Ok(line);
        }
        let target = if vertical {
            &mut self.vertical
        } else {
            &mut self.horizontal
        };
        if target.is_none() {
            let model_name = if vertical { VREC } else { REC };
            let rec_path = models::model(&self.root, "rtr46/meiki.txt.recognition.v0", model_name)?;
            let file_bytes = std::fs::metadata(&rec_path).map(|m| m.len()).unwrap_or(0);
            let (id, label) = if vertical {
                ("meiki_rec_vertical", "MeikiOCR Vertical Rec")
            } else {
                ("meiki_rec_horizontal", "MeikiOCR Horizontal Rec")
            };
            let (session, reg) = super::telemetry::ModelRegistration::measure_load(
                id,
                label,
                None,
                file_bytes,
                true,
                || session(&rec_path),
            )?;
            *target = Some((session, reg));
        }
        let (session, reg) = target.as_mut().unwrap();
        reg.touch();
        let (tw, th) = if vertical { (32, 480) } else { (960, 32) };
        let mut segments = vec![(y1 as u32, y2 as u32)];
        // Long vertical lines overlap by 64 model pixels; NMS below merges them.
        if vertical && h as f64 * 32.0 / w as f64 > 480.0 {
            segments.clear();
            let span = 420.0 * w as f64 / 32.0;
            let stride = 356.0 * w as f64 / 32.0;
            let mut y = y1;
            while y + span < y2 {
                segments.push((y.round() as u32, (y + span).round() as u32));
                y += stride;
            }
            segments.push(((y2 - span).round() as u32, y2 as u32));
        }
        let mut candidates: Vec<(f32, TextBox)> = Vec::new();
        for (sy1, sy2) in segments {
            let crop = imageops::crop_imm(image, x1 as u32, sy1, w, sy2 - sy1).to_image();
            let scale = (tw as f64 / w as f64).min(th as f64 / (sy2 - sy1) as f64);
            let (rw, rh) = (
                (w as f64 * scale).round().max(1.0) as u32,
                ((sy2 - sy1) as f64 * scale).round().max(1.0) as u32,
            );
            let input = tensor(&crop, tw, th, rw, rh)?;
            let sizes =
                Tensor::from_array(([1usize, 2], vec![tw as i64, th as i64].into_boxed_slice()))?;
            let (labels, boxes, scores) = session.infer(|session| {
                let outputs = session.run(ort::inputs![&input, &sizes])?;
                let labels: Vec<i64> =
                    if let Ok((_, labels)) = outputs[0].try_extract_tensor::<i32>() {
                        labels.iter().map(|v| *v as i64).collect()
                    } else {
                        outputs[0].try_extract_tensor::<i64>()?.1.to_vec()
                    };
                Ok((
                    labels,
                    outputs[1].try_extract_tensor::<f32>()?.1.to_vec(),
                    outputs[2].try_extract_tensor::<f32>()?.1.to_vec(),
                ))
            })?;
            for ((label, bb), score) in labels.iter().zip(boxes.chunks_exact(4)).zip(&scores) {
                if *score < 0.1 || bb[0] >= rw as f32 || bb[1] >= rh as f32 {
                    continue;
                }
                let Some(ch) = char::from_u32(*label as u32) else {
                    continue;
                };
                let bx1 = x1 + (bb[0].max(0.0) as f64 / rw as f64) * w as f64;
                let bx2 = x1 + (bb[2].min(rw as f32) as f64 / rw as f64) * w as f64;
                let by1 = sy1 as f64 + (bb[1].max(0.0) as f64 / rh as f64) * (sy2 - sy1) as f64;
                let by2 =
                    sy1 as f64 + (bb[3].min(rh as f32) as f64 / rh as f64) * (sy2 - sy1) as f64;
                candidates.push((
                    *score,
                    TextBox {
                        text: ch.to_string(),
                        bounds: [bx1, by1, bx2, by2],
                        vertical,
                        ..Default::default()
                    },
                ));
            }
        }
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut accepted: Vec<TextBox> = Vec::new();
        let axis = if vertical { 1 } else { 0 };
        for (_, candidate) in candidates {
            let b = candidate.bounds;
            if accepted.iter().any(|a| {
                let a = a.bounds;
                let overlap = (b[axis + 2].min(a[axis + 2]) - b[axis].max(a[axis])).max(0.0);
                overlap
                    / (b[axis + 2] - b[axis])
                        .min(a[axis + 2] - a[axis])
                        .max(0.001)
                    > 0.3
            }) {
                continue;
            }
            accepted.push(candidate);
        }
        accepted.sort_by(|a, b| a.bounds[axis].total_cmp(&b.bounds[axis]));
        let text = accepted.iter().map(|c| c.text.as_str()).collect::<String>();
        let line = TextBox {
            text,
            bounds: bbox,
            words: accepted,
            vertical,
        };
        self.cache.insert(key, &line);
        Ok(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aligned_numbered_choices_recover_horizontal_rows() -> Result<()> {
        let columns = [
            ([54., 49., 110., 401.], 0.44),
            ([133., 47., 265., 403.], 0.41),
            ([200., 52., 264., 402.], 0.35),
        ];
        let mut read = |bounds: [f64; 4], vertical: bool| {
            let words = if vertical {
                assert_eq!(bounds, columns[2].0);
                (0..5)
                    .map(|i| TextBox {
                        text: "字".into(),
                        bounds: [
                            200.,
                            55. + f64::from(i) * 70.,
                            264.,
                            115. + f64::from(i) * 70.,
                        ],
                        ..Default::default()
                    })
                    .collect()
            } else {
                let index = ((bounds[1] - 49.) / 70.).round() as usize;
                let name = ["純夏", "冥夜", "壬姫", "千鶴", "彩峰"][index];
                vec![
                    TextBox {
                        text: (index + 1).to_string(),
                        bounds: [60., bounds[1], 95., bounds[3]],
                        ..Default::default()
                    },
                    TextBox {
                        text: name.into(),
                        bounds: [140., bounds[1], 260., bounds[3]],
                        ..Default::default()
                    },
                ]
            };
            Ok(TextBox {
                text: words.iter().map(|word| word.text.as_str()).collect(),
                bounds,
                words,
                vertical,
            })
        };

        let rows = recover_numbered_menu(&columns, 377, &mut read)?;
        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            ["1純夏", "2冥夜", "3壬姫", "4千鶴", "5彩峰"]
        );
        assert!(rows.iter().all(|row| !row.vertical && row.words.len() == 2));

        let rows = recover_numbered_menu(&columns, 377, |bounds, vertical| {
            let mut line = read(bounds, vertical)?;
            if !vertical && line.words[0].text == "3" {
                line.words[0].text = "文".into();
            }
            Ok(line)
        })?;
        assert!(rows.is_empty());
        Ok(())
    }

    #[test]
    fn detection_resize_matches_opencv_linear_sampling_and_rgb_padding() {
        let image = RgbaImage::from_fn(8, 6, |x, y| {
            image::Rgba([
                (x * 20 + y * 7) as u8,
                ((x * 31 + y * 19) % 256) as u8,
                (200 - x * 9 - y * 3) as u8,
                255,
            ])
        });
        // cv2.resize(..., (3, 2), interpolation=cv2.INTER_LINEAR), used by meikiocr.
        let expected = [
            24, 45, 189, 77, 128, 166, 130, 210, 142, 45, 102, 180, 98, 185, 157, 151, 11, 133,
        ];
        let value = tensor(&image, 5, 4, 3, 2).unwrap();
        let (_, data) = value.try_extract_tensor::<f32>().unwrap();
        for channel in 0..3 {
            for y in 0..4 {
                for x in 0..5 {
                    let expected = if x < 3 && y < 2 {
                        expected[(y * 3 + x) * 3 + channel] as f32 / 255.0
                    } else {
                        0.0
                    };
                    assert_eq!(
                        data[channel * 20 + y * 5 + x],
                        expected,
                        "channel={channel}, x={x}, y={y}"
                    );
                }
            }
        }
    }

    #[test]
    fn bilinear_rounding_matches_opencv_for_fractional_rows() {
        let image = RgbaImage::from_fn(8, 6, |x, y| {
            image::Rgba([
                (x * 20 + y * 7) as u8,
                ((x * 31 + y * 19) % 256) as u8,
                (200 - x * 9 - y * 3) as u8,
                255,
            ])
        });
        let expected = [
            7, 14, 196, 39, 63, 182, 72, 113, 168, 104, 163, 153, 136, 212, 139, 18, 42, 192, 50,
            92, 177, 82, 142, 163, 114, 191, 149, 146, 241, 134, 28, 71, 187, 60, 120, 173, 93,
            170, 159, 125, 213, 144, 157, 71, 130, 39, 99, 183, 71, 149, 168, 103, 199, 154, 135,
            223, 140, 167, 42, 125,
        ];
        let value = tensor(&image, 5, 4, 5, 4).unwrap();
        let (_, data) = value.try_extract_tensor::<f32>().unwrap();
        for channel in 0..3 {
            for i in 0..20 {
                assert_eq!(
                    data[channel * 20 + i],
                    expected[i * 3 + channel] as f32 / 255.0
                );
            }
        }
    }
}
