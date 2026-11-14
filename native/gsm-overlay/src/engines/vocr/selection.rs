use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const REVISION: &str = "205f47ec4e56ca87c00e7dba0a61c9aaec726707";
pub const RELEASE: &str = "v0.5.0";
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Small,
    #[default]
    Normal,
    Large,
}
impl Tier {
    pub fn name(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Normal => "normal",
            Self::Large => "large",
        }
    }
    pub fn directory(root: &Path) -> Result<PathBuf> {
        let Some(override_path) = std::env::var_os("GSM_VITA_OCR_DIR").filter(|p| !p.is_empty())
        else {
            return Ok(root.join("ocr/vita-vn-ocr"));
        };
        let path = PathBuf::from(override_path);
        if let Ok(relative) = path.strip_prefix("~") {
            return Ok(crate::models::home()?.join(relative));
        }
        Ok(path)
    }
    pub fn read(root: &Path) -> Result<Self> {
        let path = Self::directory(root)?.join("installation.json");
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::Normal),
            Err(e) => return Err(e.into()),
        };
        let mut bytes = vec![];
        file.take(65537).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 65536, "VOCR model selection is too large");
        let value: Value = serde_json::from_slice(&bytes)?;
        serde_json::from_value(value["model"].clone())
            .context("Choose a VOCR model: small, normal or large")
    }
    pub fn select(self, root: &Path) -> Result<()> {
        let directory = Self::directory(root)?;
        std::fs::create_dir_all(&directory)?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("selection.lock"))?;
        lock.try_lock()
            .context("Another VOCR model change is in progress")?;
        super::Vocr::new(self)?.validate()?;
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        serde_json::to_writer(
            &mut temporary,
            &json!({"model":self,"revision":REVISION,"release":RELEASE}),
        )?;
        temporary.write_all(b"\n")?;
        temporary.flush()?;
        temporary.as_file().sync_all()?;
        temporary.persist(directory.join("installation.json"))?;
        Ok(())
    }
}
