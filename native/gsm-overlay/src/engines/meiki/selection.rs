use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
pub const REVISION: &str = "a9cffa4f60cbf72ddb87edf19c6f98a01cd042e6";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Detector {
    Small,
    #[default]
    Large,
}
impl Detector {
    pub fn dimensions(self) -> (u32, u32) {
        match self {
            Self::Small => (320, 192),
            Self::Large => (960, 544),
        }
    }
    pub fn filename(self) -> String {
        let (width, height) = self.dimensions();
        format!("meiki.text.detect.v0.1.{width}x{height}.onnx")
    }
    pub fn ensure(self, root: &Path) -> Result<PathBuf> {
        let digest = match self {
            Self::Small => "8cdc5daa5c13a5f93adb40ee2e53ad1a3d2f7e372584c5c665b038adeb74ae6d",
            Self::Large => "40b6a016667745cae7d3055929ae3b8b1e7716aac795f5904cd3c2c7c3b8404b",
        };
        // Earlier installs kept these same verified graphs in ocr_models.
        let legacy = root.with_file_name("ocr_models");
        let directory = if root.ends_with("ocr")
            && !root.join(self.filename()).is_file()
            && legacy.join(self.filename()).is_file()
        {
            &legacy
        } else {
            root
        };
        crate::models::pinned_model(
            directory,
            "rtr46/meiki.text.detect.v0",
            REVISION,
            &self.filename(),
            digest,
        )
    }
    pub fn read(base: &Path) -> Result<Self> {
        let file = match std::fs::File::open(base.join("ocr/meikiocr/selection.json")) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::Large),
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        file.take(65537).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 64 * 1024,
            "MeikiOCR model selection is too large"
        );
        let value: Value = serde_json::from_slice(&bytes)?;
        serde_json::from_value(value["model"].clone())
            .context("Choose a MeikiOCR detector: small or large")
    }
    pub fn select(self, base: &Path) -> Result<()> {
        self.select_validated(base, || {
            let path = self.ensure(&base.join("ocr"))?;
            crate::inference::Model::file(&path, 0)?;
            Ok(())
        })
    }
    fn select_validated(self, base: &Path, validate: impl FnOnce() -> Result<()>) -> Result<()> {
        let directory = base.join("ocr/meikiocr");
        std::fs::create_dir_all(&directory)?;
        let lock = std::fs::OpenOptions::new()
            .write(true)
            .read(true)
            .create(true)
            .truncate(false)
            .open(directory.join("selection.lock"))?;
        lock.try_lock()
            .context("Another MeikiOCR model change is in progress")?;
        validate()?;
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        serde_json::to_writer(&mut temporary, &json!({"model":self}))?;
        temporary.write_all(b"\n")?;
        temporary.flush()?;
        temporary.as_file().sync_all()?;
        temporary.persist(directory.join("selection.json"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_is_shared_and_a_failed_candidate_never_replaces_the_previous_choice() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(Detector::read(root.path()).unwrap(), Detector::Large);
        Detector::Small
            .select_validated(root.path(), || Ok(()))
            .unwrap();
        assert_eq!(Detector::read(root.path()).unwrap(), Detector::Small);
        assert!(
            Detector::Large
                .select_validated(root.path(), || anyhow::bail!("bad model"))
                .is_err()
        );
        assert_eq!(Detector::read(root.path()).unwrap(), Detector::Small);
        std::fs::write(
            root.path().join("ocr/meikiocr/selection.json"),
            r#"{"model":"normal"}"#,
        )
        .unwrap();
        assert!(Detector::read(root.path()).is_err());
        Detector::Large
            .select_validated(root.path(), || Ok(()))
            .unwrap();
        assert_eq!(Detector::read(root.path()).unwrap(), Detector::Large);
    }
}
