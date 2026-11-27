use super::{read_log, ReadLogOutcome};
use crate::log_redaction::{is_private_field, LogRedactor};
use gsm_settings::Result;
use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

// A support export reads application settings only. The data directories also
// contain browser storage, service-account credentials, databases and backups.
const PROFILE_FILES: &[&str] = &[
    "config.json",
    "shared_config.json",
    "scene_config.json",
    "obs-service.json",
    "obs-studio/config/obs-studio/plugin_config/obs-websocket/config.json",
    "electron/config.json",
    "electron/overlay_settings.json",
    "config/ocr_replacements.json",
    "config/text_replacements.json",
    "texthook/profiles.json",
    "multi-mine-window-config.json",
    "window_layout.json",
];

pub(super) struct ConfigFile {
    pub source: PathBuf,
    pub relative: PathBuf,
}

// Check each component so a link inside the profile cannot redirect a read.
fn exists_under(root: &Path, relative: &Path, directory: bool) -> Result<bool> {
    let mut path = root.to_owned();
    let target = root.join(relative);
    for part in relative {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_symlink() => return Ok(false),
            Ok(meta) if path == target => {
                return Ok(if directory {
                    meta.is_dir()
                } else {
                    meta.is_file()
                });
            }
            Ok(meta) if !meta.is_dir() => return Ok(false),
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(false)
}

pub(super) fn list_configs(root: &Path, overlay: &Path, ini: &Path) -> Result<Vec<ConfigFile>> {
    let mut files = Vec::new();
    for &name in PROFILE_FILES {
        let relative = Path::new(name);
        if exists_under(root, relative, false)? {
            files.push(ConfigFile {
                source: root.join(relative),
                relative: relative.into(),
            });
        }
    }
    if exists_under(overlay, Path::new("settings.json"), false)? {
        files.push(ConfigFile {
            source: overlay.join("settings.json"),
            relative: "overlay/settings.json".into(),
        });
    }
    if let (Some(parent), Some(name)) = (ini.parent(), ini.file_name()) {
        if exists_under(parent, name.as_ref(), false)? {
            files.push(ConfigFile {
                source: ini.into(),
                relative: "owocr_config_gsm.ini".into(),
            });
        }
    }
    let scenes = Path::new("ocr_config");
    if exists_under(root, scenes, true)? {
        for entry in fs::read_dir(root.join(scenes)).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
                && entry.file_type().map_err(|e| e.to_string())?.is_file()
            {
                files.push(ConfigFile {
                    source: path,
                    relative: scenes.join(entry.file_name()),
                });
            }
        }
    }
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(files)
}

fn redact_json(value: Value, redactor: &LogRedactor) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let clean = if is_private_field(&key) && !value.is_null() && value != "" {
                        Value::String("[REDACTED]".into())
                    } else {
                        redact_json(value, redactor)
                    };
                    (redactor.redact(&key), clean)
                })
                .collect(),
        ),
        Value::Array(array) => Value::Array(
            array
                .into_iter()
                .map(|v| redact_json(v, redactor))
                .collect(),
        ),
        Value::String(s) => Value::String(redactor.redact(&s)),
        other => other,
    }
}

// Export the active OWocr options. Discard comments and continuation lines,
// which can contain disabled credentials or fragments of a multiline secret.
fn redact_ini(text: &str, redactor: &LogRedactor) -> String {
    let mut out = String::new();
    let mut previous_indent = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with([';', '#']) {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if previous_indent.is_some_and(|previous| indent > previous) {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            previous_indent = None;
            out.push_str(&redactor.redact(trimmed));
        } else if let Some((key, value)) = trimmed.split_once(['=', ':']) {
            previous_indent = Some(indent);
            out.push_str(&redactor.redact(key.trim()));
            out.push_str(" = ");
            if is_private_field(key.trim()) && !value.trim().is_empty() {
                out.push_str("[REDACTED]");
            } else {
                out.push_str(&redactor.redact(value.trim()));
            }
        } else {
            continue;
        }
        out.push('\n');
    }
    out
}

pub(super) fn read_config(file: &ConfigFile, redactor: &LogRedactor) -> Result<String> {
    let ReadLogOutcome::Text(text) = read_log(&file.source)? else {
        return Err("file removed during export".into());
    };
    let text = text.trim_start_matches('\u{feff}');
    if file.relative.extension().is_some_and(|ext| ext == "ini") {
        return Ok(redact_ini(text, redactor));
    }
    // Never fall back to copying malformed JSON or including the parser input.
    let value = serde_json::from_str(text).map_err(|_| "invalid JSON")?;
    serde_json::to_string_pretty(&redact_json(value, redactor)).map_err(|e| e.to_string())
}
