// SPDX-License-Identifier: MPL-2.0
//! Run the networks from an extracted Snipping Tool model set using GSM's CPU
//! inference runtime. Model paths and alphabets come from the supplied manifest.
use super::*;
use crate::{
    engines::line_cache::{self, LineCache},
    inference::Model,
    pipeline::TextBox,
};
use anyhow::{Context, ensure};
use image::imageops;
use ort::value::Tensor;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
mod detector;
mod recognizer;
use detector::Line;
use recognizer::Decoder;

pub(super) struct Engine {
    root: PathBuf,
    manifest: Value,
    detector: Model,
    classifier: Model,
    decoders: HashMap<String, Decoder>,
    cache: LineCache,
    reg: crate::engines::telemetry::ModelRegistration,
}

fn resource(root: &Path, rel: &Value) -> Result<PathBuf> {
    use std::path::Component;
    let rel = Path::new(rel.as_str().context("Missing OneOCR model path")?);
    ensure!(
        rel.components().all(|x| matches!(x, Component::Normal(_))),
        "Invalid OneOCR model path"
    );
    Ok(root.join(rel))
}
fn model(root: &Path, entry: &Value) -> Result<Model> {
    let path = resource(root, &entry["model_pack"]["onnx"]["model_path"])?;
    let threads = std::env::var("ONEOCR_ORT_INTRA_OP_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4)
        .min(std::thread::available_parallelism().map_or(4, usize::from));
    Model::file_with_pattern(&path, threads, false)
        .with_context(|| format!("Load OneOCR model {}", path.display()))
}
fn file_bytes(root: &Path, entry: &Value) -> u64 {
    resource(root, &entry["model_pack"]["onnx"]["model_path"])
        .ok()
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0)
}
fn tensor(image: &RgbaImage, bgr: bool, scale: f32) -> Result<Tensor<f32>> {
    let (w, h) = (image.width() as usize, image.height() as usize);
    let area = w * h;
    let mut pixels = vec![0.; area * 3];
    for (i, pixel) in image.pixels().enumerate() {
        for c in 0..3 {
            pixels[c * area + i] = pixel[if bgr { 2 - c } else { c }] as f32 * scale;
        }
    }
    Ok(Tensor::from_array((
        [1, 3, h, w],
        pixels.into_boxed_slice(),
    ))?)
}
const SCRIPTS: [&str; 10] = [
    "",
    "CJKPrinted",
    "LatinPrintedV2",
    "CyrillicMixed",
    "ArabicMixed",
    "DevanagariMixed",
    "GreekMixed",
    "ThaiMixed",
    "HebrewPrinted",
    "TamilPrinted",
];

impl Engine {
    pub(super) fn new() -> Result<Self> {
        let root = std::env::var_os("ONEOCR_MODELS")
            .map(PathBuf::from)
            .unwrap_or(crate::models::home()?.join(".config/oneocr/models"));
        let config = root.join("config.json");
        let manifest: Value = serde_json::from_slice(&fs::read(&config).with_context(|| {
            format!(
                "Select an extracted OneOCR model folder containing {}",
                config.display()
            )
        })?)?;
        let base_bytes = file_bytes(&root, &manifest["det_model"][0])
            .saturating_add(file_bytes(&root, &manifest["aux_mlt_cls_model"][0]));
        let ((detector, classifier), reg) = crate::engines::telemetry::ModelRegistration::measure_load(
            "oneocr",
            "OneOCR",
            Some("portable".into()),
            base_bytes,
            true,
            || Ok((model(&root, &manifest["det_model"][0])?, model(&root, &manifest["aux_mlt_cls_model"][0])?)),
        )?;
        Ok(Self {
            root,
            manifest,
            detector,
            classifier,
            decoders: HashMap::new(),
            cache: LineCache::default(),
            reg,
        })
    }

    fn classify(&mut self, image: &RgbaImage) -> Result<(usize, bool)> {
        let input = tensor(image, false, 1. / 255.)?;
        self.classifier.infer(|session| {
            let outputs = session.run(ort::inputs!["data"=>&input])?;
            let scores = outputs["script_id_score"].try_extract_tensor::<f32>()?.1;
            let (i, _) = scores
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .context("Empty OneOCR classifier result")?;
            let flip = outputs["flip_score"]
                .try_extract_tensor::<f32>()?
                .1
                .first()
                .copied()
                .unwrap_or(0.)
                < 0.;
            Ok((i, flip))
        })
    }

    fn read_line(&mut self, image: &RgbaImage, line: &Line) -> Result<Option<TextBox>> {
        let crop = line.sample(image);
        let (script, flip) = self.classify(&crop)?;
        let Some(&name) = SCRIPTS.get(script).filter(|n| !n.is_empty()) else {
            return Ok(None);
        };
        if !self.decoders.contains_key(name) {
            let entry = self.manifest["char_model"]
                .as_array()
                .and_then(|a| a.iter().find(|v| v["name"] == name))
                .context("Recognizer missing from OneOCR manifest")?;
            self.decoders
                .insert(name.to_owned(), Decoder::load(&self.root, entry)?);
        }
        let decoder = self.decoders.get_mut(name).unwrap();
        let crop = if flip {
            imageops::rotate180(&crop)
        } else {
            crop
        };
        decoder.recognize(&crop, line, flip, script)
    }

    pub(super) fn recognize(&mut self, image: &RgbaImage) -> Result<Recognition> {
        self.reg.touch();
        self.cache.begin();
        let lines = detector::detect(&mut self.detector, image, &self.manifest["det_model"][0])?;
        let mut text = Vec::with_capacity(lines.len());
        for line in lines {
            let rect = line.pixel_rect(image);
            let key = line_cache::key(image, rect, Some(line.vertical));
            // Include the sampling transform: a stable axis-aligned bounding box
            // can contain a different slanted line on a later detector pass.
            let mut hash = sha2::Sha256::new();
            use sha2::Digest;
            hash.update(key);
            for n in line.transform() {
                hash.update(n.to_le_bytes());
            }
            let key = hash.finalize().into();
            if let Some(hit) = self.cache.get(&key) {
                text.push(hit);
                continue;
            }
            if let Some(row) = self.read_line(image, &line)? {
                self.cache.insert(key, &row);
                text.push(row);
            }
        }
        Ok(Recognition::from_lines(text))
    }
}
