mod composite;
mod lens;
mod line_cache;
#[cfg(target_os = "macos")]
mod livetext;
pub mod meiki;
mod mida;
mod oneocr;
mod remote;
mod screenai;
pub mod vocr;
use crate::pipeline::Recognition;
use anyhow::{Result, bail};
use image::RgbaImage;
use std::path::{Path, PathBuf};

/// OneOCR is shared by capture workers. Its explicit destructor can release the
/// process-wide pipeline once neither worker has used it for the idle interval.
pub fn release_idle_models(idle_for: std::time::Duration) -> bool {
    oneocr::release_idle(idle_for)
}

pub struct Engines {
    root: PathBuf,
    remote: Option<remote::Remote>,
    meiki: Option<meiki::Meiki>,
    mida: Option<mida::Finder>,
    mida_reader: Option<vocr::Vocr>,
    vocr: Option<vocr::Vocr>,
    finder: Option<vocr::Finder>,
    lens: Option<lens::Lens>,
}
impl Engines {
    pub fn new(profile: &Path) -> Self {
        Self {
            root: profile.to_owned(),
            remote: None,
            meiki: None,
            mida: None,
            mida_reader: None,
            vocr: None,
            finder: None,
            lens: None,
        }
    }
    /// Keep both passes/composite dependencies, but drop models left behind by
    /// an engine change. Recognition itself must not evict the other pass.
    pub fn retain_for(&mut self, selected: &[&str]) {
        if !selected
            .iter()
            .any(|name| matches!(*name, "meikiocr" | "meiki_text_detector"))
        {
            self.meiki = None;
        }
        if !selected
            .iter()
            .any(|name| matches!(*name, "mida_detector" | "mida_vocr"))
        {
            self.mida = None;
        }
        if !selected.contains(&"mida_vocr") {
            self.mida_reader = None;
        }
        if !selected.contains(&"vitaocr") {
            self.vocr = None;
        }
        if !selected
            .iter()
            .any(|name| matches!(*name, "vocr_detector" | "vocr_lens"))
        {
            self.finder = None;
        }
        if !selected
            .iter()
            .any(|name| matches!(*name, "lens" | "glens" | "vocr_lens"))
        {
            self.lens = None;
        }
        if !selected.iter().any(|name| matches!(*name, "bing" | "gvision")) {
            self.remote = None;
        }
    }
    pub fn recognize(
        &mut self,
        image: &RgbaImage,
        engine: &str,
        language: &str,
    ) -> Result<Recognition> {
        match engine {
            "oneocr" => oneocr::ocr_image(image),
            "screenai" => screenai::ocr_image(image),
            "lens" | "glens" => {
                if self.lens.is_none() {
                    self.lens = Some(lens::Lens::new()?);
                }
                self.lens.as_ref().unwrap().recognize(image, language)
            }
            "meikiocr" | "meiki_text_detector" => {
                let selected = meiki::selection::Detector::read(&self.root)?;
                if self.meiki.as_ref().is_none_or(|m| m.model != selected) {
                    self.meiki = Some(meiki::Meiki::with_model(&self.root.join("ocr"), selected)?);
                }
                if engine == "meiki_text_detector" {
                    Ok(Recognition {
                        detections: self.meiki.as_mut().unwrap().detect(image, 0.5)?,
                        ..Default::default()
                    })
                } else {
                    self.meiki.as_mut().unwrap().recognize(image)
                }
            }
            "mida_detector" | "mida_vocr" => {
                if self.mida.is_none() {
                    self.mida = Some(mida::Finder::new(&self.root.join("ocr"))?);
                }
                let boxes = self.mida.as_mut().unwrap().detect(image)?;
                if engine == "mida_detector" {
                    return Ok(Recognition {
                        detections: boxes.iter().map(|b| b.edges()).collect(),
                        ..Default::default()
                    });
                }
                if self.mida_reader.is_none() {
                    self.mida_reader = Some(vocr::Vocr::large_fast()?);
                }
                let mut result = self
                    .mida_reader
                    .as_mut()
                    .unwrap()
                    .read_lines(image, boxes, true)?;
                result.model = serde_json::json!({"size":"large","mode":"fast","finder":"mida","revision":vocr::selection::REVISION});
                Ok(result)
            }
            "vitaocr" => {
                let selected = vocr::selection::Tier::read(&self.root)?;
                if self.vocr.as_ref().is_none_or(|m| m.model != selected) {
                    self.vocr = Some(vocr::Vocr::new(selected)?);
                }
                let mut result = self.vocr.as_mut().unwrap().recognize(image)?;
                result.model = serde_json::json!({"size":selected,"revision":vocr::selection::REVISION,"backend":"onnx"});
                Ok(result)
            }
            "vocr_detector" => {
                if self.finder.is_none() {
                    self.finder = Some(vocr::Finder::new()?);
                }
                Ok(Recognition {
                    detections: self
                        .finder
                        .as_mut()
                        .unwrap()
                        .detect(image)?
                        .iter()
                        .map(|b| b.edges())
                        .collect(),
                    ..Default::default()
                })
            }
            "vocr_lens" => {
                if self.finder.is_none() {
                    self.finder = Some(vocr::Finder::new()?);
                }
                let boxes = self.finder.as_mut().unwrap().detect(image)?;
                let mut lines = Vec::new();
                for batch in
                    composite::pack(image, &boxes.iter().map(|b| b.edges()).collect::<Vec<_>>())
                {
                    let result = self.recognize(&batch.image, "lens", language)?;
                    lines.extend(batch.restore(result.lines));
                }
                Ok(Recognition::from_lines(lines))
            }
            #[cfg(target_os = "macos")]
            "alivetext" => livetext::recognize(image, language),
            "bing" | "gvision" => {
                if self.remote.is_none() {
                    self.remote = Some(remote::Remote::new(&self.root)?);
                }
                self.remote
                    .as_mut()
                    .unwrap()
                    .recognize(image, engine)
            }
            _ => bail!("Unsupported native overlay OCR engine: {engine}"),
        }
    }
}
#[cfg(target_os = "macos")]
fn png(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut output = std::io::Cursor::new(Vec::new());
    image.write_to(&mut output, image::ImageFormat::Png)?;
    Ok(output.into_inner())
}
