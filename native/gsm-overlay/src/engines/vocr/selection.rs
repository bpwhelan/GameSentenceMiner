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
        let path = Self::selection_directory(root)?.join("installation.json");
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
    fn selection_directory(root: &Path) -> Result<PathBuf> {
        if std::env::var_os("GSM_PROFILE_DIR").is_some_and(|p| !p.is_empty())
            || std::env::var_os("GSM_NATIVE_SHARED_DATA_DIR")
                .is_some_and(|shared| Path::new(&shared) != root)
        {
            Ok(root.join("ocr/vita-vn-ocr"))
        } else {
            Self::directory(root)
        }
    }
    pub fn select(self, root: &Path) -> Result<()> {
        let directory = Self::selection_directory(root)?;
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

// Only status polling reuses checks. Creating a session always hashes the bytes it loads.
#[derive(PartialEq, Eq)]
struct VerifiedFile {
    path: PathBuf,
    len: u64,
    modified: std::time::SystemTime,
}

type StatusCache = std::sync::Mutex<std::collections::BTreeMap<&'static str, VerifiedFile>>;
static VERIFIED: std::sync::LazyLock<StatusCache> = std::sync::LazyLock::new(StatusCache::default);

fn verified_for_status(
    cache: &StatusCache,
    name: &'static str,
    path: PathBuf,
    expected: &str,
) -> Result<bool> {
    let metadata = match path.metadata() {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    let fingerprint = VerifiedFile {
        modified: metadata.modified()?,
        len: metadata.len(),
        path,
    };
    if cache.lock().unwrap_or_else(|e| e.into_inner()).get(name) == Some(&fingerprint) {
        return Ok(true);
    }
    crate::models::verify_sha256(&fingerprint.path, expected)?;
    let current = fingerprint.path.metadata()?;
    if current.len() == fingerprint.len && current.modified()? == fingerprint.modified {
        cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name, fingerprint);
    }
    Ok(true)
}

fn installed_tiers() -> Result<Vec<Tier>> {
    let assets = super::asset_directory()?;
    let installed = |name: &'static str| -> Result<bool> {
        let bundled = assets.join(name);
        let path = if bundled.try_exists()? {
            Some(bundled)
        } else {
            super::ASSET_LOCATIONS.get().and_then(|(_, cache)| {
                gsm_downloads::asset_cache_path(cache, &format!("vocr/{name}"))
            })
        };
        match path {
            Some(path) => verified_for_status(&VERIFIED, name, path, super::model_hash(name)?),
            None => Ok(false),
        }
    };
    let mut tiers = Vec::with_capacity(3);
    if installed(super::DETECTOR)? {
        for (tier, file) in [
            (Tier::Normal, super::NORMAL),
            (Tier::Small, super::SMALL),
            (Tier::Large, super::LARGE),
        ] {
            if installed(file)? {
                tiers.push(tier);
            }
        }
    }
    Ok(tiers)
}

pub fn status(root: &Path, busy: bool) -> Value {
    let mut status = json!({"model":"normal","available":false,"busy":busy,"installed":[],"revision":REVISION,"release":RELEASE,"supported":true,"backend":"onnx"});
    let result = Tier::read(root).and_then(|selected| {
        status["model"] = json!(selected);
        let installed = installed_tiers()?;
        status["available"] = installed.contains(&selected).into();
        status["installed"] = json!(installed);
        Ok(())
    });
    if let Err(error) = result {
        status["error"] = format!("{error:#}").into();
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_file_invalidates_status() -> Result<()> {
        let cache = StatusCache::default();
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("fixture");
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        std::fs::write(&path, b"abc")?;
        assert!(verified_for_status(
            &cache,
            "fixture",
            path.clone(),
            expected
        )?);
        assert!(verified_for_status(
            &cache,
            "fixture",
            path.clone(),
            expected
        )?);
        std::fs::write(&path, b"xyz")?;
        std::fs::File::options()
            .write(true)
            .open(&path)?
            .set_modified(
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000),
            )?;
        assert!(verified_for_status(&cache, "fixture", path, expected).is_err());
        Ok(())
    }
}
