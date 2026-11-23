//! Data folder relocation validation, safe copy without overwrites, and OBS path retargeting.
use crate::settings_backup::get_overlay_data_dir;
use gsm_settings::paths::{is_legacy_database_migration_pending, write_data_dir_pointer};
use gsm_settings::{read_object, with_lock, write_atomic, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub const RELOCATED_DATA_PATHS: [&str; 17] = [
    "config",
    "config.json",
    "electron/config.json",
    "electron/overlay_settings.json",
    "gsm.db",
    "gsm.db-shm",
    "gsm.db-wal",
    "multi-mine-window-config.json",
    "obs-service.json",
    "obs-studio/config",
    "ocr_config",
    "plugins.py",
    "scene_config.json",
    "shared_config.json",
    "texthook/profiles.json",
    "texthook/texthook_manifest.json",
    "window_layout.json",
];

const OBS_RUNTIME_CONFIG_DIRS: &[&str] =
    &[".sentinel", "crashes", "logs", "profiler_data", "updates"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelocateProgress {
    pub phase: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ValidateTargetResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
struct RelocationEntry {
    label: &'static str,
    source: PathBuf,
    destination: PathBuf,
}

fn path_exists_no_follow(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.to_string()),
    }
}

fn strip_windows_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn canonicalize_or_lexical(path: &Path) -> PathBuf {
    let mut norm = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(norm.components().next_back(), Some(Component::Normal(_))) {
                    norm.pop();
                }
            }
            other => norm.push(other.as_os_str()),
        }
    }

    let mut suffix = Vec::new();
    let mut probe = norm.as_path();
    while !probe.exists() {
        let Some(name) = probe.file_name() else {
            break;
        };
        suffix.push(name.to_os_string());
        let Some(parent) = probe.parent() else {
            break;
        };
        probe = parent;
    }

    let mut resolved = if probe.exists() {
        fs::canonicalize(probe)
            .map(strip_windows_verbatim)
            .unwrap_or_else(|_| probe.to_path_buf())
    } else {
        norm
    };
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    resolved
}

fn same_or_nested_path(parent: &Path, candidate: &Path) -> (bool, bool) {
    #[cfg(windows)]
    {
        let p_norm = PathBuf::from(parent.to_string_lossy().to_ascii_lowercase());
        let c_norm = PathBuf::from(candidate.to_string_lossy().to_ascii_lowercase());
        (p_norm == c_norm, c_norm.starts_with(&p_norm))
    }
    #[cfg(not(windows))]
    {
        (parent == candidate, candidate.starts_with(parent))
    }
}

fn existing_relocation_entries(
    old_dir: &Path,
    new_dir: &Path,
    has_profile: bool,
) -> Result<Vec<RelocationEntry>> {
    let mut entries = Vec::new();
    for rel in RELOCATED_DATA_PATHS {
        let source = old_dir.join(rel);
        if path_exists_no_follow(&source)? {
            entries.push(RelocationEntry {
                label: rel,
                source,
                destination: new_dir.join(rel),
            });
        }
    }
    let old_overlay = get_overlay_data_dir(old_dir, has_profile).join("settings.json");
    let new_overlay = crate::overlay_directory::destination(new_dir, has_profile).join("settings.json");
    if canonicalize_or_lexical(&old_overlay) != canonicalize_or_lexical(&new_overlay)
        && path_exists_no_follow(&old_overlay)?
    {
        entries.push(RelocationEntry {
            label: "overlay settings",
            source: old_overlay,
            destination: new_overlay,
        });
    }
    Ok(entries)
}

fn find_destination_conflict(
    old_dir: &Path,
    new_dir: &Path,
    has_profile: bool,
) -> Result<Option<String>> {
    for rel in RELOCATED_DATA_PATHS {
        if path_exists_no_follow(&new_dir.join(rel))? {
            return Ok(Some(rel.to_owned()));
        }
    }
    for entry in existing_relocation_entries(old_dir, new_dir, has_profile)? {
        if path_exists_no_follow(&entry.destination)? {
            return Ok(Some(entry.label.to_owned()));
        }
    }
    Ok(None)
}

fn check_directory_writable(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let probe = dir.join(format!(".gsm-write-probe-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .map_err(|e| e.to_string())?;
    file.write_all(b"").map_err(|e| e.to_string())?;
    drop(file);
    let _ = fs::remove_file(probe);
    Ok(())
}

pub fn validate_target_dir(
    old_dir: &Path,
    new_dir: &Path,
    pointer_path: &Path,
    has_profile: bool,
) -> ValidateTargetResult {
    if has_profile {
        return ValidateTargetResult {
            ok: false,
            error: Some(
                "The data folder cannot be relocated while using -profile. Relaunch with the desired profile folder.".into(),
            ),
        };
    }
    match is_legacy_database_migration_pending(pointer_path, old_dir, has_profile) {
        Ok(true) => {
            return ValidateTargetResult {
                ok: false,
                error: Some(
                    "GSM must finish repairing its database before changing folders. Start the GSM backend or restart GSM, then try again.".into(),
                ),
            };
        }
        Ok(false) => {}
        Err(err) => {
            return ValidateTargetResult {
                ok: false,
                error: Some(err),
            };
        }
    }

    let resolved_old = canonicalize_or_lexical(old_dir);
    let resolved_new = canonicalize_or_lexical(new_dir);
    let (is_same, is_nested) = same_or_nested_path(&resolved_old, &resolved_new);
    if is_same {
        return ValidateTargetResult {
            ok: false,
            error: Some("The selected folder is already the current data location.".into()),
        };
    }
    if is_nested {
        return ValidateTargetResult {
            ok: false,
            error: Some("The new location cannot be inside the current data folder.".into()),
        };
    }

    if let Err(err) = check_directory_writable(new_dir) {
        return ValidateTargetResult {
            ok: false,
            error: Some(format!("Cannot write to the selected folder: {err}")),
        };
    }

    match find_destination_conflict(old_dir, new_dir, has_profile) {
        Ok(Some(conflict)) => ValidateTargetResult {
            ok: false,
            error: Some(format!(
                "The selected folder already contains {conflict}. Remove it or choose another folder; GSM will not overwrite or delete files."
            )),
        },
        Ok(None) => ValidateTargetResult {
            ok: true,
            error: None,
        },
        Err(err) => ValidateTargetResult {
            ok: false,
            error: Some(format!("Cannot inspect the selected folder: {err}")),
        },
    }
}

fn should_copy_obs_config_rel(rel: &Path) -> bool {
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        return true;
    }
    if parts[0] == "obs-studio"
        && parts
            .get(1)
            .is_some_and(|p| OBS_RUNTIME_CONFIG_DIRS.contains(&p.as_str()))
    {
        return false;
    }
    !(parts[0] == "obs-studio"
        && parts.get(1).is_some_and(|p| p == "plugin_config")
        && parts.get(2).is_some_and(|p| p == "advanced-scene-switcher")
        && parts.last().is_some_and(|p| p == ".running"))
}

fn copy_entry_no_overwrite(source: &Path, destination: &Path, is_obs_config: bool) -> Result<()> {
    fn visit(
        src_root: &Path,
        src: &Path,
        dst: &Path,
        rel: &Path,
        is_obs_config: bool,
    ) -> Result<()> {
        if is_obs_config && !rel.as_os_str().is_empty() && !should_copy_obs_config_rel(rel) {
            return Ok(());
        }
        let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Ok(());
        }
        if meta.file_type().is_dir() {
            fs::create_dir_all(dst).map_err(|e| e.to_string())?;
            for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name();
                visit(
                    src_root,
                    &src.join(&name),
                    &dst.join(&name),
                    &rel.join(&name),
                    is_obs_config,
                )?;
            }
            return Ok(());
        }
        if meta.file_type().is_file() {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut src_file = File::open(src).map_err(|e| e.to_string())?;
            let mut dst_file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(dst)
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut src_file, &mut dst_file).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    visit(source, source, destination, Path::new(""), is_obs_config)
}

fn is_win_style_path(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || raw.starts_with(r"\\")
}

fn split_win_components(raw: &str) -> Option<(String, Vec<String>)> {
    let normalized = raw.replace('/', "\\");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        let drive = format!("{}:\\", (bytes[0] as char).to_ascii_uppercase());
        let rest: Vec<String> = normalized[3..]
            .split('\\')
            .filter(|s| !s.is_empty() && *s != ".")
            .fold(Vec::new(), |mut acc, part| {
                if part == ".." {
                    acc.pop();
                } else {
                    acc.push(part.to_owned());
                }
                acc
            });
        return Some((drive, rest));
    }
    None
}

fn relocated_managed_obs_path(configured: &str, old_dir: &Path, new_dir: &Path) -> Option<String> {
    let old_str = old_dir.to_string_lossy();
    let new_str = new_dir.to_string_lossy();
    if is_win_style_path(configured) && is_win_style_path(&old_str) && is_win_style_path(&new_str) {
        let (old_drive, mut old_parts) = split_win_components(&old_str)?;
        old_parts.push("obs-studio".into());
        let (cfg_drive, cfg_parts) = split_win_components(configured)?;
        if old_drive != cfg_drive || cfg_parts.len() < old_parts.len() {
            return None;
        }
        let matches = old_parts
            .iter()
            .zip(cfg_parts.iter())
            .all(|(a, b)| a.eq_ignore_ascii_case(b));
        if !matches {
            return None;
        }
        let (new_drive, mut new_parts) = split_win_components(&new_str)?;
        new_parts.push("obs-studio".into());
        new_parts.extend(cfg_parts[old_parts.len()..].iter().cloned());
        return Some(format!("{new_drive}{}", new_parts.join("\\")));
    }

    let cfg_path = Path::new(configured);
    if !cfg_path.is_absolute() {
        return None;
    }
    let old_obs = old_dir.join("obs-studio");
    let rel = cfg_path.strip_prefix(&old_obs).ok()?;
    Some(new_dir.join("obs-studio").join(rel).to_string_lossy().into_owned())
}

fn retarget_profile_obs_path(profile: &mut Value, old_dir: &Path, new_dir: &Path) -> bool {
    let Some(obs) = profile.get_mut("obs").and_then(Value::as_object_mut) else {
        return false;
    };
    let Some(configured) = obs
        .get("obs_path")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Some(relocated) = relocated_managed_obs_path(configured, old_dir, new_dir) else {
        return false;
    };
    if relocated == configured {
        return false;
    }
    obs.insert("obs_path".into(), Value::String(relocated));
    true
}

pub fn retarget_copied_managed_obs_paths(old_dir: &Path, new_dir: &Path) -> Result<()> {
    let copied_config = new_dir.join("config.json");
    if !copied_config.exists() {
        return Ok(());
    }
    with_lock(&copied_config, || {
        let mut parsed = read_object(&copied_config)?;
        let mut changed = retarget_profile_obs_path(&mut parsed, old_dir, new_dir);
        if let Some(configs) = parsed.get_mut("configs").and_then(Value::as_object_mut) {
            for profile in configs.values_mut() {
                if retarget_profile_obs_path(profile, old_dir, new_dir) {
                    changed = true;
                }
            }
        }
        if changed {
            write_atomic(&copied_config, &parsed)?;
        }
        Ok(())
    })
}

pub fn perform_data_move(
    old_dir: &Path,
    new_dir: &Path,
    pointer_path: &Path,
    has_profile: bool,
    mut on_progress: impl FnMut(RelocateProgress),
) -> Result<()> {
    on_progress(RelocateProgress {
        phase: "validating".into(),
        message: "Checking the new data location…".into(),
        completed: None,
        total: None,
    });
    let validation = validate_target_dir(old_dir, new_dir, pointer_path, has_profile);
    if !validation.ok {
        return Err(validation
            .error
            .unwrap_or_else(|| "The selected data folder is not valid.".into()));
    }

    let entries = existing_relocation_entries(old_dir, new_dir, has_profile)?;
    let total = entries.len();
    for (idx, entry) in entries.iter().enumerate() {
        on_progress(RelocateProgress {
            phase: "copying".into(),
            message: format!("Copying {}…", entry.label),
            completed: Some(idx),
            total: Some(total),
        });
        copy_entry_no_overwrite(
            &entry.source,
            &entry.destination,
            entry.label == "obs-studio/config",
        )?;
    }

    on_progress(RelocateProgress {
        phase: "finalizing".into(),
        message: "Updating the GSM data location…".into(),
        completed: Some(total),
        total: Some(total),
    });
    retarget_copied_managed_obs_paths(old_dir, new_dir)?;
    write_data_dir_pointer(pointer_path, new_dir, has_profile)?;

    on_progress(RelocateProgress {
        phase: "done".into(),
        message: "Data location updated. Restarting…".into(),
        completed: Some(total),
        total: Some(total),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn validates_relocation_targets_and_rejects_nested_or_conflicting_dirs() {
        let dir = tempdir().unwrap();
        let old_dir = dir.path().join("old");
        let nested = old_dir.join("sub");
        let new_dir = dir.path().join("new");
        let pointer = dir.path().join("data_dir.json");
        fs::create_dir_all(&old_dir).unwrap();

        assert!(!validate_target_dir(&old_dir, &old_dir, &pointer, false).ok);
        assert!(!validate_target_dir(&old_dir, &nested, &pointer, false).ok);
        assert!(!validate_target_dir(&old_dir, &new_dir, &pointer, true).ok);
        assert!(validate_target_dir(&old_dir, &new_dir, &pointer, false).ok);

        fs::write(new_dir.join("config.json"), b"{}").unwrap();
        let conflict = validate_target_dir(&old_dir, &new_dir, &pointer, false);
        assert!(!conflict.ok);
        assert!(conflict.error.unwrap().contains("config.json"));
    }

    #[test]
    fn moves_data_filters_obs_runtime_retargets_obs_path_and_updates_pointer() {
        let dir = tempdir().unwrap();
        let old_dir = dir.path().join("old_data");
        let new_dir = dir.path().join("new_data");
        let pointer = dir.path().join("data_dir.json");

        fs::create_dir_all(old_dir.join("obs-studio/config/obs-studio/logs")).unwrap();
        fs::create_dir_all(old_dir.join("obs-studio/config/obs-studio/plugin_config/advanced-scene-switcher")).unwrap();
        fs::write(old_dir.join("obs-studio/config/obs-studio/global.ini"), b"ini").unwrap();
        fs::write(old_dir.join("obs-studio/config/obs-studio/logs/obs.txt"), b"skip").unwrap();
        fs::write(
            old_dir.join("obs-studio/config/obs-studio/plugin_config/advanced-scene-switcher/.running"),
            b"lock",
        )
        .unwrap();
        fs::write(old_dir.join("gsm.db"), b"sqlite").unwrap();

        let managed_obs = old_dir
            .join("obs-studio")
            .join("bin")
            .join("64bit")
            .join("obs64.exe");
        let expected_moved_obs = new_dir
            .join("obs-studio")
            .join("bin")
            .join("64bit")
            .join("obs64.exe");
        fs::write(
            old_dir.join("config.json"),
            serde_json::to_vec_pretty(&json!({
                "current_profile": "Default",
                "configs": {
                    "Default": { "obs": { "obs_path": managed_obs } },
                    "External": { "obs": { "obs_path": r"D:\Program Files\obs-studio\obs64.exe" } }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let mut phases = Vec::new();
        perform_data_move(&old_dir, &new_dir, &pointer, false, |p| phases.push(p.phase)).unwrap();

        assert_eq!(phases.first().map(String::as_str), Some("validating"));
        assert_eq!(phases.last().map(String::as_str), Some("done"));
        assert!(new_dir.join("gsm.db").exists());
        assert!(new_dir.join("obs-studio/config/obs-studio/global.ini").exists());
        assert!(!new_dir.join("obs-studio/config/obs-studio/logs/obs.txt").exists());
        assert!(!new_dir.join("obs-studio/config/obs-studio/plugin_config/advanced-scene-switcher/.running").exists());

        let moved_cfg = read_object(&new_dir.join("config.json")).unwrap();
        assert_eq!(
            moved_cfg["configs"]["Default"]["obs"]["obs_path"],
            json!(expected_moved_obs)
        );
        assert_eq!(
            moved_cfg["configs"]["External"]["obs"]["obs_path"],
            json!(r"D:\Program Files\obs-studio\obs64.exe")
        );

        let pointer_doc = read_object(&pointer).unwrap();
        assert_eq!(pointer_doc["version"], json!(2));
        assert_eq!(pointer_doc["dataDir"], json!(new_dir));
    }

    #[test]
    fn retargets_windows_style_paths_cross_platform() {
        let relocated = relocated_managed_obs_path(
            r"C:/Users/Alice/AppData/Roaming/GameSentenceMiner/obs-studio/bin/64bit/obs64.exe",
            Path::new(r"C:\Users\Alice\AppData\Roaming\GameSentenceMiner"),
            Path::new(r"D:\GSMData"),
        );
        assert_eq!(
            relocated.as_deref(),
            Some(r"D:\GSMData\obs-studio\bin\64bit\obs64.exe")
        );
    }
}
