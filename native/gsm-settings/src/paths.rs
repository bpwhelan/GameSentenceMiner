use crate::{read_object, with_lock, write_atomic, Result};
use std::path::{Component, Path, PathBuf};

const APP_NAME: &str = "GameSentenceMiner";
const POINTER_FILE_NAME: &str = "data_dir.json";

#[derive(Clone)]
pub struct Paths {
    pub active: PathBuf,
    pub shared: PathBuf,
    pub has_profile: bool,
}

impl Paths {
    pub fn resolve() -> Result<Self> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self::resolve_with_args(&args, &cwd)
    }

    pub fn resolve_with_args(args: &[String], cwd: &Path) -> Result<Self> {
        let default = default_base_dir()?;
        let pointer = pointer_file_path()?;
        let profile = parse_profile_dir(args, std::env::var_os("GSM_PROFILE_DIR").as_deref(), cwd)?;
        let has_profile = profile.is_some();
        let installed = installed(&pointer, &default, profile.is_none())?;
        let shared = if has_profile {
            std::env::var_os("GSM_SHARED_DATA_DIR")
                .map(|raw| expand_and_normalize_dir(&raw.to_string_lossy()))
                .transpose()?
                .unwrap_or_else(|| installed.clone())
        } else {
            installed.clone()
        };
        let active = profile.unwrap_or(installed);
        if !active.is_absolute() || !shared.is_absolute() {
            return Err("Data paths must be absolute".into());
        }
        Ok(Self {
            active,
            shared,
            has_profile,
        })
    }
}

pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

pub fn default_base_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    Ok(std::env::var_os("APPDATA")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join(APP_NAME))
}

pub fn pointer_file_path() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    Ok(home.join(".config").join(APP_NAME).join(POINTER_FILE_NAME))
}

pub fn owocr_config_path(active: &Path, has_profile: bool) -> Result<PathBuf> {
    if has_profile {
        return Ok(active.join("owocr_config_gsm.ini"));
    }
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    Ok(home.join(".config").join("owocr_config_gsm.ini"))
}

pub fn default_recordings_dir(active: &Path, has_profile: bool) -> Result<PathBuf> {
    if has_profile {
        return Ok(active.join("recordings"));
    }
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    Ok(home.join("Videos").join("GSM"))
}

fn expand_tilde(raw: &str) -> Result<PathBuf> {
    if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        let home = dirs::home_dir().ok_or("Home directory unavailable")?;
        return Ok(home.join(raw.get(2..).unwrap_or("")));
    }
    Ok(PathBuf::from(raw))
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(normalized.components().next_back(), Some(Component::Normal(_))) {
                    normalized.pop();
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

pub fn normalize_data_dir(raw: &str) -> Result<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("dataDir must be an absolute folder path.".into());
    }
    let expanded = expand_tilde(trimmed)?;
    if !expanded.is_absolute() {
        return Err("dataDir must be an absolute folder path.".into());
    }
    Ok(lexical_normalize(&expanded))
}

fn expand_and_normalize_dir(raw: &str) -> Result<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("Invalid profile folder.".into());
    }
    let expanded = expand_tilde(trimmed)?;
    let abs = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(expanded)
    };
    Ok(lexical_normalize(&abs))
}

pub fn parse_profile_dir(
    args: &[String],
    env_profile: Option<&std::ffi::OsStr>,
    cwd: &Path,
) -> Result<Option<PathBuf>> {
    let mut selected: Option<String> = None;
    let mut idx = 0;
    while idx < args.len() {
        let arg = &args[idx];
        let val = if arg == "-profile" || arg == "--profile" {
            idx += 1;
            let next = args
                .get(idx)
                .ok_or_else(|| format!("{arg} requires a profile folder."))?;
            if next.starts_with('-') {
                return Err(format!("{arg} requires a profile folder."));
            }
            next.clone()
        } else if let Some(rest) = arg.strip_prefix("-profile=").or_else(|| arg.strip_prefix("--profile=")) {
            rest.to_owned()
        } else {
            idx += 1;
            continue;
        };
        if val.trim().is_empty() || val.contains('\0') {
            return Err("Invalid profile folder.".into());
        }
        selected = Some(val);
        idx += 1;
    }

    let resolved = match selected {
        Some(v) => Some(v),
        None => env_profile
            .map(|v| v.to_string_lossy().trim().to_owned())
            .filter(|v| !v.is_empty()),
    };
    let Some(raw) = resolved else {
        return Ok(None);
    };
    if raw.trim().is_empty() || raw.contains('\0') {
        return Err("Invalid profile folder.".into());
    }
    let expanded = expand_tilde(&raw)?;
    let abs = if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    };
    Ok(Some(lexical_normalize(&abs)))
}

pub fn write_data_dir_pointer(pointer: &Path, data_dir: &Path, has_profile: bool) -> Result<()> {
    if has_profile {
        return Err("The data folder cannot be changed while using -profile. Relaunch with the desired profile folder.".into());
    }
    let normalized = normalize_data_dir(&data_dir.to_string_lossy())?;
    let payload = serde_json::json!({
        "version": 2,
        "dataDir": normalized,
    });
    with_lock(pointer, || write_atomic(pointer, &payload))
}

pub fn is_legacy_database_migration_pending(
    pointer: &Path,
    data_dir: &Path,
    has_profile: bool,
) -> Result<bool> {
    if has_profile {
        return Ok(false);
    }
    let value = read_object(pointer)?;
    let Some(legacy) = value.get("legacyDatabaseDir").filter(|v| !v.is_null()) else {
        return Ok(false);
    };
    if legacy.as_str().ok_or("Invalid legacyDatabaseDir")?.is_empty() {
        return Ok(false);
    }
    let Some(pointer_dir) = value.get("dataDir").and_then(|v| v.as_str()) else {
        return Ok(false);
    };
    let selected = normalize_data_dir(pointer_dir)?;
    Ok(same_directory(&selected, &normalize_data_dir(&data_dir.to_string_lossy())?))
}

pub fn same_directory(a: &Path, b: &Path) -> bool {
    a == b || a.canonicalize().ok().zip(b.canonicalize().ok()).is_some_and(|(a,b)| a == b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_profile_args_and_validates_inputs() {
        let cwd = Path::new("/work");
        assert_eq!(parse_profile_dir(&[], None, cwd).unwrap(), None);
        assert_eq!(
            parse_profile_dir(&["--profile=profiles/jp".into()], None, cwd).unwrap(),
            Some(lexical_normalize(&cwd.join("profiles/jp")))
        );
        assert!(parse_profile_dir(&["-profile".into()], None, cwd).is_err());
        assert!(parse_profile_dir(&["-profile".into(), "--flag".into()], None, cwd).is_err());
    }

    #[test]
    fn writes_and_detects_legacy_migration_pointer() {
        let dir = tempdir().unwrap();
        let pointer = dir.path().join("data_dir.json");
        let target = dir.path().join("custom");
        write_data_dir_pointer(&pointer, &target, false).unwrap();
        assert!(!is_legacy_database_migration_pending(&pointer, &target, false).unwrap());
        assert!(write_data_dir_pointer(&pointer, &target, true).is_err());

        write_atomic(
            &pointer,
            &serde_json::json!({
                "version": 2,
                "dataDir": target,
                "legacyDatabaseDir": dir.path().join("old")
            }),
        )
        .unwrap();
        assert!(is_legacy_database_migration_pending(&pointer, &target, false).unwrap());
        assert!(!is_legacy_database_migration_pending(&pointer, &target, true).unwrap());
    }
}
pub fn installed(pointer: &Path, default: &Path, migrate: bool) -> Result<PathBuf> {
    let legacy = default.join("data_dir.json");
    let mut value = if pointer.exists() {
        read_object(pointer)?
    } else {
        read_object(&legacy).unwrap_or(serde_json::json!({}))
    };
    let Some(raw) = value["dataDir"].as_str() else {
        if pointer.exists() {
            return Err("Invalid saved data directory".into());
        }
        return Ok(default.into());
    };
    let path = if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        dirs::home_dir()
            .ok_or("Home directory unavailable")?
            .join(raw.get(2..).unwrap_or(""))
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() {
        if !pointer.exists() {
            return Ok(default.into());
        }
        return Err("Saved data directory must be absolute".into());
    }
    if migrate && (!pointer.exists() || (pointer == legacy && value["version"] != 2)) {
        value["version"] = serde_json::json!(2);
        if path != default {
            value["legacyDatabaseDir"] = serde_json::json!(default);
        }
        with_lock(pointer, || {
            if !pointer.exists() || pointer == legacy {
                write_atomic(pointer, &value)?;
            }
            Ok(())
        })?;
    }
    Ok(path)
}
