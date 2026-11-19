// SPDX-License-Identifier: GPL-3.0-or-later
//! Portable VOCR recognition and textspot8 detection using pinned GSM assets.
mod charbox;
mod decode;
mod grad;
mod pixels;
use super::line_cache::{self, LineCache};
pub(super) use decode::Box as LineBox;
pub mod selection;
#[cfg(test)]
mod tests;

use crate::pipeline::{Recognition, TextBox};
use anyhow::{Context, Result, ensure};
use image::{RgbaImage, imageops};
use ort::{ep::CPU, session::Session, value::Tensor};
use selection::Tier;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

const SMALL: &str = "small-faithful.onnx";
const NORMAL: &str = "normal-faithful.onnx";
const LARGE: &str = "large-faithful.onnx";
const LARGE_FAST: &str = "large-fast.onnx";
const DETECTOR: &str = "textspot8-faithful.onnx";
static ASSET_LOCATIONS: OnceLock<(PathBuf, PathBuf)> = OnceLock::new();

/// The desktop host and Python share a cache. Earlier desktop installs may
/// also have a complete set of graphs on disk.
pub fn set_asset_directory(directory: PathBuf, cache: PathBuf) -> Result<()> {
    let locations = (directory, cache);
    if let Some(existing) = ASSET_LOCATIONS.get() {
        ensure!(existing == &locations, "VOCR assets are already configured");
    } else {
        ASSET_LOCATIONS
            .set(locations)
            .map_err(|_| anyhow::anyhow!("VOCR assets are already configured"))?;
    }
    Ok(())
}

fn asset_directory() -> Result<PathBuf> {
    if let Some((directory, _)) = ASSET_LOCATIONS.get() {
        return Ok(directory.clone());
    }
    if let Some(root) = std::env::var_os("GSM_APP_ROOT") {
        return Ok(PathBuf::from(root).join("GameSentenceMiner/assets/vocr"));
    }
    #[cfg(any(test, debug_assertions))]
    return Ok(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../GameSentenceMiner/assets/vocr")
    );
    #[cfg(not(any(test, debug_assertions)))]
    anyhow::bail!("The host has not configured the bundled VOCR model directory")
}

fn verified_model(directory: &Path, filename: &str) -> Result<Vec<u8>> {
    let hashes = [
        (
            LARGE_FAST,
            "c1a36ae7313d3ff39a2100bbd6aa88509836fb22e947d08c2b5d8fe06e47c4bc",
        ),
        (
            SMALL,
            "b8a7207d8323c9468833676fdf09199bf793644b126db9038862d2d7b41ee36e",
        ),
        (
            NORMAL,
            "8e067c0e2ea895813367d84f492a268618ef2885dc01c536e95ef90ede28c9ac",
        ),
        (
            LARGE,
            "b67831a53fef77510d931fb00f4b05bd0b4ee588692cf1f4ca2da695c04eb0a2",
        ),
        (
            DETECTOR,
            "030c4a7441b5bd92cb0812a86cb00ada19ee0cade8b48af602552fc8fcb9ed28",
        ),
    ];
    let (_, hash) = hashes
        .iter()
        .find(|(name, _)| *name == filename)
        .context("Unknown VOCR model")?;
    let bundled = directory.join(filename);
    let model = match ASSET_LOCATIONS.get() {
        Some((_, cache)) => gsm_downloads::ensure_asset(cache, &format!("vocr/{filename}"), Some(&bundled))
            .map_err(anyhow::Error::msg)
            .with_context(|| format!("Download VOCR model {filename}"))?,
        None => bundled,
    };
    let bytes = std::fs::read(model).with_context(|| format!("Read VOCR model {filename}"))?;
    ensure!(
        format!("{:x}", Sha256::digest(&bytes)) == *hash,
        "VOCR model checksum failed"
    );
    Ok(bytes)
}
pub fn verify_bundled() -> Result<()> {
    let directory = asset_directory()?;
    for filename in [SMALL, NORMAL, LARGE, LARGE_FAST, DETECTOR] {
        verified_model(&directory, filename)?;
    }
    Ok(())
}
fn session(filename: &str, kind: &str, source: &str) -> Result<(Session, Value)> {
    // Verify the bytes actually used by this session, including subsequent
    // loads, so missing or modified resources cannot silently change the model.
    let bytes = verified_model(&asset_directory()?, filename)?;
    let load = || -> ort::Result<Session> {
        Session::builder()?
            .with_no_environment_execution_providers()?
            .with_execution_providers([CPU::default().build().error_on_failure()])?
            .with_intra_threads(1)?
            .with_inter_threads(1)?
            .with_intra_op_spinning(false)?
            .with_inter_op_spinning(false)?
            .commit_from_memory(&bytes)
    };
    let session = load().context("Load bundled VOCR model")?;
    let metadata: Value = serde_json::from_str(
        &session
            .metadata()?
            .custom("gsm_vocr")
            .context("VOCR model metadata is missing")?,
    )?;
    ensure!(
        metadata["kind"] == kind
            && metadata["revision"] == selection::REVISION
            && metadata["export_version"] == 1
            && metadata["mode"]
                == if filename == LARGE_FAST {
                    "fast"
                } else {
                    "faithful"
                }
            && metadata["source_sha256"] == source,
        "VOCR model metadata is incompatible"
    );
    Ok((session, metadata))
}
pub struct Finder {
    session: Session,
    tags: usize,
}
impl Finder {
    pub fn new() -> Result<Self> {
        let (session, data) = session(
            DETECTOR,
            "detector",
            "e129d41adfa02c658a7d13d6f98064e6ab6ce9a2bc8c7a56da700a21357b5e1c",
        )?;
        ensure!(
            data["stride"] == 4
                && data["tags"] == 4
                && data["min_cells"] == 2
                && data["conf_min"] == 1,
            "Unsupported VOCR detector geometry"
        );
        Ok(Self { session, tags: 4 })
    }
    fn detect_maps(&mut self, grey: &image::GrayImage) -> Result<(Vec<i64>, usize, usize)> {
        let reduced = pixels::halve(grey);
        let (height, width) = (reduced.height() as usize, reduced.width() as usize);
        let input = Tensor::from_array((
            [1usize, 1, height, width],
            reduced
                .into_raw()
                .into_iter()
                .map(|p| p as f32 - 128.)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        ))?;
        let result = self.session.run(ort::inputs!["image"=>&input])?;
        let (shape, values) = result["head"].try_extract_tensor::<f32>()?;
        decode::maps(values, shape, height, width, self.tags)
    }
    pub fn detect(&mut self, image: &RgbaImage) -> Result<Vec<decode::Box>> {
        pixels::dimensions(image.width(), image.height())?;
        let scale = (960. / image.width() as f64)
            .min(544. / image.height() as f64)
            .min(1.);
        let (width, height) = (
            (image.width() as f64 * scale).round().max(1.) as u32,
            (image.height() as f64 * scale).round().max(1.) as u32,
        );
        let grey = if (width, height) == image.dimensions() {
            pixels::grey(image)
        } else {
            pixels::grey(&imageops::resize(
                image,
                width,
                height,
                imageops::FilterType::Lanczos3,
            ))
        };
        let (maps, rows, cols) = self.detect_maps(&grey)?;
        let mut found = decode::spot(&maps, 4 + self.tags, rows, cols, &grey)?;
        if found.truncated {
            found = grad::find(&grey);
            ensure!(
                !found.truncated,
                "VOCR gradient line finder exceeded its 16-line limit"
            );
        }
        let (sx, sy) = (
            image.width() as f64 / width as f64,
            image.height() as f64 / height as f64,
        );
        for b in &mut found.boxes {
            let right = (((b.x + b.w) as f64 * sx + 0.999) as i64).min(image.width() as i64);
            let bottom = (((b.y + b.h) as f64 * sy + 0.999) as i64).min(image.height() as i64);
            b.x = (b.x as f64 * sx) as i64;
            b.y = (b.y as f64 * sy) as i64;
            b.w = right - b.x;
            b.h = bottom - b.y;
        }
        Ok(found.boxes)
    }
}
struct Recognizer {
    session: Session,
    vocab: Vec<String>,
}
impl Recognizer {
    fn new(tier: Tier, fast: bool) -> Result<Self> {
        let (bytes, hash) = match tier {
            Tier::Small => (
                SMALL,
                "864bbd196d5bc5d3a7bd7918cf7274b3503dfe65d440017ef0781ea7e7ba37d2",
            ),
            Tier::Normal => (
                NORMAL,
                "107cf084cc0c1a3a61ce4c3f9b9cf6b31d6dff80f0a1bdb94afd3f7ee9ae3bc9",
            ),
            Tier::Large => (
                if fast { LARGE_FAST } else { LARGE },
                "65310013e8f990886e4e8097b2fe55eb98cdf082d7193eea510601fc0ac26c82",
            ),
        };
        let (session, data) = session(bytes, "recognizer", hash)?;
        ensure!(
            data["tier"] == tier.name()
                && data["height"] == 32
                && data["stride"] == 8
                && data["max_width"] == 1024,
            "Unsupported VOCR recognizer geometry"
        );
        let vocab: Vec<String> = serde_json::from_value(data["vocab"].clone())?;
        ensure!(
            !vocab.is_empty() && vocab.len() <= 65536 && vocab.iter().all(|v| v.len() <= 16),
            "Invalid VOCR vocabulary"
        );
        Ok(Self { session, vocab })
    }
    fn recognize(&mut self, image: &RgbaImage, dark: Option<bool>) -> Result<TextBox> {
        let grey = pixels::grey(image);
        let dark = dark.unwrap_or_else(|| {
            decode::dark(
                &grey,
                &LineBox {
                    w: image.width() as i64,
                    h: image.height() as i64,
                    ..Default::default()
                },
            ) != 0
        });
        let (input, width) = pixels::prepare(&grey, dark);
        let input = Tensor::from_array((
            [1usize, 1, 32, width.div_ceil(8) as usize * 8],
            input.into_boxed_slice(),
        ))?;
        let output = self.session.run(ort::inputs!["image"=>&input])?;
        let (_, best) = output["best"].try_extract_tensor::<i64>()?;
        ensure!(
            best.len() <= 256
                && best
                    .iter()
                    .all(|&v| v >= 0 && (v as usize) < self.vocab.len()),
            "Invalid VOCR character output"
        );
        let boxes = charbox::positions(
            best,
            image.width() as i64,
            image.height() as i64,
            width as i64,
            &pixels::ink_profile(&grey),
        );
        let words: Vec<_> = boxes
            .iter()
            .map(|b| TextBox {
                text: self.vocab[b.cls as usize].clone(),
                bounds: [
                    b.x0 as f64 / 16.,
                    0.,
                    b.x1 as f64 / 16.,
                    image.height() as f64,
                ],
                ..Default::default()
            })
            .collect();
        Ok(TextBox {
            text: words.iter().map(|c| c.text.as_str()).collect(),
            bounds: [0., 0., image.width() as f64, image.height() as f64],
            words,
            vertical: false,
        })
    }
}
pub struct Vocr {
    pub model: Tier,
    finder: Option<Finder>,
    cache: LineCache,
    recognizer: Option<Recognizer>,
}
impl Vocr {
    pub fn new(model: Tier) -> Result<Self> {
        Ok(Self {
            model,
            finder: Some(Finder::new()?),
            cache: LineCache::default(),
            recognizer: None,
        })
    }
    pub(super) fn large_fast() -> Result<Self> {
        Ok(Self {
            model: Tier::Large,
            finder: None,
            cache: LineCache::default(),
            recognizer: Some(Recognizer::new(Tier::Large, true)?),
        })
    }
    pub fn validate(&mut self) -> Result<()> {
        if self.recognizer.is_none() {
            self.recognizer = Some(Recognizer::new(self.model, false)?);
        }
        Ok(())
    }
    pub fn recognize(&mut self, image: &RgbaImage) -> Result<Recognition> {
        let found = self
            .finder
            .as_mut()
            .context("VOCR reader requires an external line detector")?
            .detect(image)?;
        self.read_lines(image, found, false)
    }
    pub(super) fn read_lines(
        &mut self,
        image: &RgbaImage,
        found: Vec<LineBox>,
        infer_polarity: bool,
    ) -> Result<Recognition> {
        self.validate()?;
        self.cache.begin();
        let mut lines = vec![];
        for b in found {
            // VOCR's recognizer is horizontal. Detector-only workflows retain
            // vertical boxes for engines that support them (including Lens).
            if b.vertical != 0 {
                continue;
            }
            let polarity = (!infer_polarity).then_some(b.dark != 0);
            let key = line_cache::key(
                image,
                [b.x as u32, b.y as u32, b.w as u32, b.h as u32],
                polarity,
            );
            if let Some(hit) = self.cache.get(&key) {
                lines.push(hit);
                continue;
            }
            let crop = imageops::crop_imm(image, b.x as u32, b.y as u32, b.w as u32, b.h as u32)
                .to_image();
            let mut line = self
                .recognizer
                .as_mut()
                .unwrap()
                .recognize(&crop, polarity)?;
            line.bounds = b.edges();
            for c in &mut line.words {
                c.bounds[0] += b.x as f64;
                c.bounds[2] += b.x as f64;
                c.bounds[1] += b.y as f64;
                c.bounds[3] += b.y as f64;
            }
            self.cache.insert(key, &line);
            lines.push(line);
        }
        Ok(Recognition::from_lines(lines))
    }
}
