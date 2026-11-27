//! Own the on-disk mining profile before consumers open the database or start inputs.
mod legacy;
pub use crate::profile_editor::save_edits;
use crate::{gsm_config::active_profile, paths::Paths, with_lock, write_atomic, Result};
use crate::MINING_DEFAULTS as DEFAULTS;
use pep440_rs::Version;
use serde_json::{json, Map, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn prepare(paths: &Paths, app_root: &Path, version: &str) -> Result<bool> {
    prepare_with_overlay(paths, app_root, version, None)
}

pub fn prepare_with_overlay(
    paths: &Paths,
    app_root: &Path,
    version: &str,
    overlay_file: Option<&Path>,
) -> Result<bool> {
    let path = paths.active.join("config.json");
    with_lock(&path, || {
        let local = read_optional(&path)?;
        let imported = if local.is_none() {
            read_optional(&app_root.join("config.json"))?
        } else {
            None
        };
        let mut document = match local.as_ref().or(imported.as_ref()) {
            Some(bytes) => {
                match serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes)) {
                    Ok(value) => value,
                    Err(_) => {
                        backup_invalid(&path, bytes)?;
                        json!({})
                    }
                }
            }
            None => match read_optional(&app_root.join("config.toml"))? {
                Some(bytes) => legacy::toml(&bytes)?,
                None => json!({}),
            },
        };
        let previous = document.clone();
        migrate(&mut document, paths, version)?;
        crate::mining_scopes::prepare(&mut document, &previous, &path)?;
        if previous["experimental"]["enable_experimental_features"] == true
            && previous["experimental"]["enable_hachidori"] == true
        {
            if let Some(file) = overlay_file {
                with_lock(file, || {
                    let mut overlay = crate::read_object(file)?;
                    if !matches!(
                        overlay["dictionaryReaderSelection"].as_str(),
                        Some("yomitan" | "hachidori")
                    ) {
                        overlay["dictionaryReaderSelection"] = json!("hachidori");
                        write_atomic(file, &overlay)?;
                    }
                    Ok(())
                })?;
            }
        }
        if local.is_some() && previous == document {
            return Ok(false);
        }
        write_atomic(&path, &document)?;
        Ok(true)
    })
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Reading {}: {e}", path.display())),
    }
}

fn backup_invalid(path: &Path, bytes: &[u8]) -> Result<()> {
    use io::Write;
    let mut backup = path.with_extension("json.bak");
    loop {
        match fs::File::create_new(&backup) {
            Ok(mut file) => {
                return file
                    .write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| format!("Backing up {}: {e}", path.display()))
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                backup = path.with_extension(format!("json.{}.bak", uuid::Uuid::new_v4()));
            }
            Err(e) => return Err(format!("Creating {}: {e}", backup.display())),
        }
    }
}

fn portable_path(path: PathBuf) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return format!("//{}", unc.replace('\\', "/"));
        }
        return text
            .strip_prefix(r"\\?\")
            .unwrap_or(&text)
            .replace('\\', "/");
    }
    #[cfg(not(windows))]
    text.into_owned()
}

fn defaults(paths: &Paths) -> Result<(Value, Value)> {
    let mut root = DEFAULTS.clone();
    let mut profile = root["configs"]["Default"].take();
    root.as_object_mut().unwrap().remove("configs");
    let recordings = crate::paths::default_recordings_dir(&paths.active, paths.has_profile)?;
    profile["paths"]["folder_to_watch"] = json!(portable_path(recordings.clone()));
    profile["paths"]["output_folder"] = json!(portable_path(recordings.join("Output")));
    let data = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(dirs::data_dir)
    } else {
        dirs::home_dir().map(|p| p.join(".local/share"))
    }
    .ok_or("Anki data directory unavailable")?;
    profile["audio"]["anki_media_collection"] =
        json!(portable_path(data.join("Anki2/User 1/collection.media")));
    let obs = if cfg!(windows) {
        portable_path(paths.active.join("obs-studio/bin/64bit/obs64.exe"))
    } else if cfg!(target_os = "macos") {
        "/opt/homebrew/bin/obs".into()
    } else {
        "/usr/bin/obs".into()
    };
    profile["obs"]["obs_path"] = json!(obs);
    if !cfg!(windows) {
        root["overlay"]["engine_v2"] = json!("meikiocr");
        profile["audio"]["ffmpeg_reencode_options"] = json!("");
        profile["audio"]["ffmpeg_reencode_options_to_use"] = json!("");
    }
    Ok((root, profile))
}

/// Arrays and user maps are whole settings. Only supply missing fields in schema objects.
fn fill(target: &mut Value, defaults: &Value) {
    if let (Some(dest), Some(src)) = (target.as_object_mut(), defaults.as_object()) {
        for (key, value) in src {
            match dest.get_mut(key) {
                Some(old) if key != "easy_days_settings" => fill(old, value),
                None => {
                    dest.insert(key.clone(), value.clone());
                }
                _ => {}
            }
        }
    }
}

fn migrate(doc: &mut Value, paths: &Paths, version: &str) -> Result<()> {
    let (mut global, profile) = defaults(paths)?;
    // A missing tokenization preference must not drop an existing vocabulary database.
    if doc["experimental"].get("enable_tokenization").is_none()
        && paths.active.join("gsm.db").try_exists().map_err(|e| e.to_string())?
    {
        global["experimental"].as_object_mut().unwrap().remove("enable_tokenization");
    }
    let root = doc
        .as_object_mut()
        .ok_or("Expected a mining configuration object")?;
    if !root.contains_key("configs") {
        let global_keys = global.as_object().unwrap();
        let mut flat = Map::new();
        for (k, v) in std::mem::take(root) {
            if global_keys.contains_key(&k) {
                root.insert(k, v);
            } else {
                flat.insert(k, v);
            }
        }
        root.insert("configs".into(), json!({"Default":flat}));
    }
    if !doc["overlay"].is_object() {
        if let Some(saved) = active_profile(doc)
            .and_then(|p| p.get("overlay"))
            .filter(|v| v.is_object())
        {
            doc["overlay"] = saved.clone();
        }
    }
    legacy::retire_mining_settings(doc);
    let root = doc.as_object_mut().unwrap();
    let pausing = root.remove("process_pausing").filter(Value::is_object);
    root.remove("default_config_change_decisions");
    legacy::clean_sections(root);
    let previous_version = root
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| !v.contains("0.0.0"))
        .and_then(|v| v.parse::<Version>().ok());
    let before = |bound: [u64; 3]| {
        previous_version
            .as_ref()
            .is_some_and(|v| v < &Version::new(bound))
    };
    let old_obs = before([2, 18, 0]);
    if before([2026, 6, 5]) && doc["stats"]["session_gap_seconds"] == 3600 {
        doc["stats"]["session_gap_seconds"] = json!(1800);
    }
    fill(doc, &global);
    let requested = doc["current_profile"]
        .as_str()
        .unwrap_or("Default")
        .to_string();
    let overlay = doc["overlay"].clone();
    let profiles = doc["configs"]
        .as_object_mut()
        .ok_or("Invalid mining profile collection")?;
    if profiles.is_empty() {
        profiles.insert("Default".into(), json!({}));
    }
    let selected = if profiles.contains_key(&requested) {
        requested
    } else if profiles.contains_key("Default") {
        "Default".into()
    } else {
        profiles.keys().next().unwrap().clone()
    };
    for (name, entry) in profiles {
        let p = entry
            .as_object_mut()
            .ok_or_else(|| format!("Invalid mining profile: {name}"))?;
        legacy::clean_sections(p);
        if let Some(value) = &pausing {
            p.entry("process_pausing").or_insert_with(|| value.clone());
        }
        legacy::profile(p, &profile, old_obs);
        fill(entry, &profile);
        entry["name"] = json!(name);
        if *name == selected {
            entry["overlay"] = overlay.clone();
        } else if entry.get("overlay").is_none() {
            entry["overlay"] = global["overlay"].clone();
        }
    }
    doc["current_profile"] = json!(selected);
    doc["version"] = json!(version);
    Ok(())
}
