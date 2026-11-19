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

pub struct Meiki {
    root: PathBuf,
    detector: Model,
    horizontal: Option<Model>,
    vertical: Option<Model>,
    cache: LineCache,
    pub model: Detector,
}

fn session(path: &Path) -> Result<Model> {
    Model::file(path, 0)
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
        let detector = session(&path)?;
        Ok(Self {
            root: root.to_path_buf(),
            detector,
            horizontal: None,
            vertical: None,
            cache: LineCache::default(),
            model,
        })
    }
    pub fn detect(&mut self, image: &RgbaImage, threshold: f32) -> Result<Vec<[f64; 4]>> {
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
                detections.push(b);
            }
        }
        detections.sort_by(|a, b| a[1].total_cmp(&b[1]));
        Ok(detections)
    }

    pub fn recognize(&mut self, image: &RgbaImage) -> Result<Recognition> {
        let mut timer = crate::timing::Timer::new("meiki");
        let boxes = self.detect(image, 0.5)?;
        timer.mark("detection");
        self.cache.begin();
        let mut lines = Vec::new();
        for bbox in boxes {
            let [x1, y1, x2, y2] = bbox;
            let (w, h) = ((x2 - x1) as u32, (y2 - y1) as u32);
            let vertical = h > w;
            let key = line_cache::key(image, [x1 as u32, y1 as u32, w, h], None);
            if let Some(line) = self.cache.get(&key) {
                if !line.text.is_empty() {
                    lines.push(line);
                }
                continue;
            }
            let target = if vertical {
                &mut self.vertical
            } else {
                &mut self.horizontal
            };
            if target.is_none() {
                let session = session(&models::model(
                    &self.root,
                    "rtr46/meiki.txt.recognition.v0",
                    if vertical { VREC } else { REC },
                )?)?;
                *target = Some(session);
            }
            let session = target.as_mut().unwrap();
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
                let sizes = Tensor::from_array((
                    [1usize, 2],
                    vec![tw as i64, th as i64].into_boxed_slice(),
                ))?;
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
            if !line.text.is_empty() {
                lines.push(line);
            }
        }
        timer.mark("recognition");
        Ok(Recognition::from_lines(lines))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
