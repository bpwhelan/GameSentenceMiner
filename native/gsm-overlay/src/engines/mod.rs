mod composite;
mod lens;
#[cfg(target_os = "macos")]
mod livetext;
pub mod meiki;
mod oneocr;
mod remote;
mod screenai;
pub mod vocr;
use crate::pipeline::Recognition;
use anyhow::{Result, bail};
use image::RgbaImage;
use std::path::{Path, PathBuf};

pub struct Engines {
    root: PathBuf,
    remote: Option<remote::Remote>,
    options: serde_json::Value,
    meiki: Option<meiki::Meiki>,
    vocr: Option<vocr::Vocr>,
    finder: Option<vocr::Finder>,
    lens: Option<lens::Lens>,
}
impl Engines {
    pub fn new(profile: &Path) -> Self {
        Self {
            root: profile.to_owned(),
            remote: None,
            options: serde_json::Value::Null,
            meiki: None,
            vocr: None,
            finder: None,
            lens: None,
        }
    }
    pub fn configure(&mut self, options: &serde_json::Value) {
        let next = serde_json::json!({"engine_config_path":options["engine_config_path"],"engine_defaults":options["engine_defaults"]});
        if self.options != next {
            self.remote = None;
            self.options = next;
        }
    }
    pub fn recognize(
        &mut self,
        image: &RgbaImage,
        engine: &str,
        language: &str,
    ) -> Result<Recognition> {
        match engine {
            "oneocr" => {
                crate::models::ensure_oneocr()?;
                oneocr::ocr_image(image)
            }
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
            "vitaocr" => {
                let selected = vocr::selection::Tier::read(&self.root)?;
                if self.vocr.as_ref().is_none_or(|m| m.model != selected) {
                    self.vocr = Some(vocr::Vocr::new(selected)?);
                }
                let mut result = self.vocr.as_mut().unwrap().recognize(image)?;
                result.model =
                    serde_json::json!({"size":selected,"revision":vocr::selection::REVISION});
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
            "bing" | "mlkitocr" | "azure" | "gvision" | "ocrspace" | "gemini" | "local_llm_ocr" => {
                if self.remote.is_none() {
                    self.remote = Some(remote::Remote::new(&self.root, &self.options)?);
                }
                self.remote
                    .as_mut()
                    .unwrap()
                    .recognize(image, engine, language)
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
