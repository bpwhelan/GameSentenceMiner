use gsm_settings::{paths::default_base_dir, read_object, with_lock, write_atomic, Result};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub const WINDOWS_DIRECTORY: &str = "Overlay";
const LEGACY_DIRECTORY: &str = "gsm_overlay";
pub const SOURCE_MARKER: &str = ".gsm-overlay-location.json";

fn legacy_directory(base: &Path, has_profile: bool) -> Option<PathBuf> {
    let default = default_base_dir().ok()?;
    if has_profile || default != base {
        return None;
    }
    Some(default.parent()?.join(LEGACY_DIRECTORY))
}

/// The destination never resolves to a legacy sibling, even when it still exists.
pub fn destination(base: &Path, has_profile: bool) -> PathBuf {
    if cfg!(windows) && !has_profile {
        let target = base.join(WINDOWS_DIRECTORY);
        if target.exists()
            || legacy_directory(base, false).is_some()
            || !base.join(LEGACY_DIRECTORY).is_dir()
        {
            return target;
        }
    }
    base.join(LEGACY_DIRECTORY)
}

pub fn resolve(base: &Path, has_profile: bool) -> PathBuf {
    let target = destination(base, has_profile);
    if !target.exists() || !cfg!(windows) {
        if let Some(source) =
            legacy_directory(base, has_profile).filter(|path| !cfg!(windows) || path.is_dir())
        {
            return source;
        }
    }
    target
}

pub fn migration_source(overlay: &Path) -> Option<PathBuf> {
    read_object(&overlay.join(SOURCE_MARKER))
        .ok()?
        .get("previousDirectory")?
        .as_str()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// Run before any overlay or WebView opens the profile. A failed or
/// interrupted copy leaves the old folder available to the resolver.
pub fn consolidate(base: &Path, has_profile: bool) -> Result<bool> {
    if !cfg!(windows) {
        return Ok(false);
    }
    let Some(source) = legacy_directory(base, has_profile).filter(|path| path.is_dir()) else {
        return Ok(false);
    };
    let target = base.join(WINDOWS_DIRECTORY);
    if target.exists() {
        return Ok(false);
    }
    with_lock(&target, || {
        if target.exists() {
            return Ok(false);
        }
        copy_profile(&source, &target)?;
        Ok(true)
    })
}

#[derive(PartialEq, Eq)]
enum Entry {
    Directory,
    File { size: u64, modified: SystemTime },
}

fn is_scratch(parent: &Path, name: &str, is_dir: bool) -> bool {
    if parent.as_os_str().is_empty() {
        let persistent = if is_dir {
            [
                "IndexedDB",
                "Local Extension Settings",
                "Local Storage",
                "File System",
                "WebStorage",
                "blob_storage",
                "Partitions",
                "Service Worker",
                "extensions",
                "tauri-webview",
                "native-dictionaries",
                "portable-dictionaries",
                "custom-pages",
            ]
            .contains(&name)
        } else {
            name.ends_with(".json")
                || matches!(name, "Preferences" | "Secure Preferences" | "Local State")
        };
        return !persistent;
    }
    if (parent == Path::new("native-dictionaries/transfers")
        || parent == Path::new("portable-dictionaries/transfers"))
        && name.starts_with(".tmp")
    {
        return true;
    }
    let cache = [
        "Cache",
        "Code Cache",
        "GPUCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
        "ShaderCache",
        "GrShaderCache",
        "GraphiteDawnCache",
        "Crashpad",
    ];
    let browser_location = parent.starts_with("tauri-webview") || parent.starts_with("Partitions");
    browser_location && is_dir && cache.contains(&name)
        || parent == Path::new("tauri-webview/EBWebView")
            && matches!(
                name,
                "SingletonLock" | "SingletonCookie" | "SingletonSocket" | "lockfile"
            )
}

fn snapshot(root: &Path) -> Result<BTreeMap<PathBuf, Entry>> {
    fn scan(root: &Path, dir: &Path, files: &mut BTreeMap<PathBuf, Entry>) -> Result<()> {
        for item in fs::read_dir(root.join(dir)).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name();
            let ty = item.file_type().map_err(|e| e.to_string())?;
            if is_scratch(dir, &name.to_string_lossy(), ty.is_dir()) {
                continue;
            }
            let rel = dir.join(&name);
            if ty.is_dir() {
                files.insert(rel.clone(), Entry::Directory);
                scan(root, &rel, files)?;
            } else if ty.is_file() {
                let metadata = item.metadata().map_err(|e| e.to_string())?;
                files.insert(
                    rel,
                    Entry::File {
                        size: metadata.len(),
                        modified: metadata.modified().map_err(|e| e.to_string())?,
                    },
                );
            } else {
                return Err(format!(
                    "Unsupported file in the overlay profile: {}",
                    rel.display()
                ));
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    scan(root, Path::new(""), &mut files)?;
    Ok(files)
}

pub fn copy_profile(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err(format!(
            "Overlay data already exists at {}",
            destination.display()
        ));
    }
    let parent = destination
        .parent()
        .ok_or("Missing overlay data parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage = tempfile::Builder::new()
        .prefix(".gsm-overlay-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let files = snapshot(source)?;
    for (relative, entry) in &files {
        let output = stage.path().join(relative);
        match entry {
            Entry::Directory => fs::create_dir_all(output).map_err(|e| e.to_string())?,
            Entry::File { size, .. } => {
                let input = source.join(relative);
                let copied = fs::copy(&input, &output).map_err(|e| {
                    format!("Could not copy overlay file {}: {e}", relative.display())
                })?;
                if copied != *size {
                    return Err(format!(
                        "Overlay file changed during copy: {}",
                        relative.display()
                    ));
                }
            }
        }
    }
    if snapshot(source)? != files {
        return Err("Overlay data changed during the copy. Close any standalone overlay and restart GSM to retry.".into());
    }
    let previous = migration_source(source).unwrap_or_else(|| source.to_owned());
    write_atomic(
        &stage.path().join(SOURCE_MARKER),
        &json!({"previousDirectory":previous}),
    )?;
    if destination.exists() {
        return Err(format!(
            "Overlay data already exists at {}",
            destination.display()
        ));
    }
    fs::rename(stage.path(), destination).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_persistent_overlay_state_and_keeps_the_legacy_profile() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join(LEGACY_DIRECTORY);
        let target = temp
            .path()
            .join("GameSentenceMiner")
            .join(WINDOWS_DIRECTORY);
        let store = "tauri-webview/EBWebView/Default/IndexedDB";
        fs::create_dir_all(legacy.join(store)).unwrap();
        fs::write(legacy.join(store).join("000001.ldb"), b"dictionary").unwrap();
        fs::write(legacy.join("settings.json"), b"settings").unwrap();
        fs::create_dir_all(legacy.join("Code Cache")).unwrap();
        fs::write(legacy.join("overlay-chromium.log"), b"scratch").unwrap();
        fs::create_dir_all(legacy.join("File System/000")).unwrap();
        fs::write(legacy.join("File System/000/content"), b"hachidori").unwrap();
        fs::create_dir_all(legacy.join("native-dictionaries/transfers/.tmpIncomplete")).unwrap();

        copy_profile(&legacy, &target).unwrap();
        assert_eq!(fs::read(target.join("settings.json")).unwrap(), b"settings");
        assert_eq!(
            fs::read(target.join(store).join("000001.ldb")).unwrap(),
            b"dictionary"
        );
        assert_eq!(migration_source(&target), Some(legacy.clone()));
        assert!(legacy.join("settings.json").exists());
        assert!(!target.join("Code Cache").exists());
        assert!(!target.join("overlay-chromium.log").exists());
        assert_eq!(
            fs::read(target.join("File System/000/content")).unwrap(),
            b"hachidori"
        );
        assert!(!target
            .join("native-dictionaries/transfers/.tmpIncomplete")
            .exists());
        assert!(copy_profile(&legacy, &target).is_err());
    }
}
