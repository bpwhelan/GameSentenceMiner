//! Full 13-category settings & database backup/restore archive engine.
use crate::extract_with_progress;
use gsm_settings::paths::{default_base_dir, owocr_config_path};
use gsm_settings::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

pub const BACKUP_FORMAT_VERSION: u32 = 1;
pub const MANIFEST_NAME: &str = "gsm-backup-manifest.json";

const GSM_ARCHIVE_ROOT: &str = "GameSentenceMiner";
const OVERLAY_ARCHIVE_ROOT: &str = "gsm_overlay";
const HOME_ARCHIVE_ROOT: &str = "home";
const OWOCR_HOME_RELATIVE_PATH: &str = ".config/owocr_config_gsm.ini";

pub const SETTINGS_BACKUP_CATEGORY_IDS: [&str; 13] = [
    "database",
    "python-settings",
    "desktop-settings",
    "overlay-settings",
    "scene-config",
    "ocr-configs",
    "obs-config",
    "text-hook-settings",
    "window-layouts",
    "plugins",
    "agent-scripts",
    "user-scripts",
    "yomitan",
];

const GSM_TOP_LEVEL_FILES: &[&str] = &[
    "config.json",
    "gsm.db",
    "gsm.db-shm",
    "gsm.db-wal",
    "multi-mine-window-config.json",
    "plugins.py",
    "scene_config.json",
    "shared_config.json",
    "window_layout.json",
];

const GSM_TRAVERSABLE_DIRS: &[&str] = &[
    "agent-scripts",
    "config",
    "electron",
    "obs-studio",
    "ocr_config",
    "scripts",
    "texthook",
];

const ELECTRON_SETTINGS_FILES: &[&str] = &["config.json", "overlay_settings.json"];

const OBS_EXCLUDED_CONFIG_DIRS: &[&str] =
    &[".sentinel", "crashes", "logs", "profiler_data", "updates"];

const TEXTHOOK_SETTINGS_FILES: &[&str] = &["profiles.json", "texthook_manifest.json"];

const OVERLAY_TOP_LEVEL_FILES: &[&str] = &["migration_complete.json", "Preferences", "settings.json"];

const OVERLAY_STORAGE_DIRS: &[&str] = &[
    "IndexedDB",
    "Local Extension Settings",
    "Local Storage",
    "Partitions",
    "WebStorage",
];

const OVERLAY_EXCLUDED_DIRS: &[&str] = &[
    "blob_storage",
    "Cache",
    "Code Cache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GPUCache",
    "Network",
    "Service Worker",
    "Session Storage",
    "Shared Dictionary",
];

const RUNTIME_FILE_NAMES: &[&str] = &["LOCK", "LOG.old"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgressEvent {
    pub operation: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    pub roots: Vec<String>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub categories: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupArchiveResult {
    pub file_path: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub roots: Vec<String>,
    pub categories: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreArchiveResult {
    pub file_count: usize,
    pub total_bytes: u64,
    pub roots: Vec<String>,
    pub categories: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct BackupArchiveOptions {
    pub output_path: PathBuf,
    pub base_dir: PathBuf,
    pub overlay_dir: PathBuf,
    pub home_config_path: PathBuf,
    pub database_snapshot_path: Option<PathBuf>,
    pub categories: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct RestoreArchiveOptions {
    pub archive_path: PathBuf,
    pub base_dir: PathBuf,
    pub overlay_dir: PathBuf,
    pub home_config_path: PathBuf,
    pub categories: Option<Vec<String>>,
}

pub fn normalize_settings_backup_categories(
    requested: Option<&[String]>,
    default_to_all: bool,
) -> Vec<String> {
    let Some(items) = requested else {
        return if default_to_all {
            SETTINGS_BACKUP_CATEGORY_IDS
                .iter()
                .map(|s| (*s).to_owned())
                .collect()
        } else {
            Vec::new()
        };
    };
    let selected: HashSet<&str> = items.iter().map(String::as_str).collect();
    SETTINGS_BACKUP_CATEGORY_IDS
        .iter()
        .filter(|cat| selected.contains(**cat))
        .map(|s| (*s).to_owned())
        .collect()
}

pub fn get_overlay_data_dir(base_dir: &Path, has_profile: bool) -> PathBuf {
    let is_default_base = !has_profile
        && default_base_dir()
            .ok()
            .is_some_and(|def| def == base_dir);
    if is_default_base {
        let root = std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| gsm_settings::paths::home_dir().map(|h| h.join(".config")))
            .unwrap_or_else(|| base_dir.to_path_buf());
        root.join("gsm_overlay")
    } else {
        base_dir.join("gsm_overlay")
    }
}

pub fn resolve_owocr_config_path(base_dir: &Path, has_profile: bool) -> Result<PathBuf> {
    owocr_config_path(base_dir, has_profile)
}

pub fn get_default_backup_file_name(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("GSM_Backup_{}.zip", format_iso_filename_stamp(secs))
}

fn format_iso_utc(secs: u64) -> String {
    let (year, month, day, hour, min, sec) = decompose_utc(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.000Z")
}

fn format_iso_filename_stamp(secs: u64) -> String {
    let (year, month, day, hour, min, sec) = decompose_utc(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}-{min:02}-{sec:02}")
}

fn decompose_utc(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = (rem / 3600) as u32;
    let min = ((rem % 3600) / 60) as u32;
    let sec = (rem % 60) as u32;

    // Howard Hinnant's civil-from-days conversion.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d, hour, min, sec)
}

fn is_sqlite_database_file(name: &str) -> bool {
    matches!(name, "gsm.db" | "gsm.db-shm" | "gsm.db-wal")
}

fn is_runtime_file_name(name: &str) -> bool {
    if RUNTIME_FILE_NAMES.contains(&name) {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".tmp")
        || lower.ends_with(".temp")
        || lower.ends_with('~')
        || lower == "thumbs.db"
        || lower == ".ds_store"
}

fn split_archive_parts(relative: &str) -> Vec<&str> {
    relative
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect()
}

fn normalize_archive_rel(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(seg) => Some(seg.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn gsm_backup_category(relative: &str) -> Option<&'static str> {
    let parts = split_archive_parts(relative);
    let first = *parts.first()?;
    let second = parts.get(1).copied();
    if is_sqlite_database_file(first) {
        return Some("database");
    }
    match (first, second) {
        ("config.json" | "shared_config.json" | "config", _) => Some("python-settings"),
        ("electron", Some("config.json")) => Some("desktop-settings"),
        ("electron", Some("overlay_settings.json")) => Some("overlay-settings"),
        ("scene_config.json", _) => Some("scene-config"),
        ("ocr_config", _) => Some("ocr-configs"),
        ("obs-studio", _) => Some("obs-config"),
        ("texthook", _) => Some("text-hook-settings"),
        ("multi-mine-window-config.json" | "window_layout.json", _) => Some("window-layouts"),
        ("plugins.py", _) => Some("plugins"),
        ("agent-scripts", _) => Some("agent-scripts"),
        ("scripts", _) => Some("user-scripts"),
        _ => None,
    }
}

fn overlay_backup_category(relative: &str) -> Option<&'static str> {
    let parts = split_archive_parts(relative);
    let first = *parts.first()?;
    if OVERLAY_STORAGE_DIRS.contains(&first) {
        return Some("yomitan");
    }
    if OVERLAY_TOP_LEVEL_FILES.contains(&first) {
        return Some("overlay-settings");
    }
    None
}

fn archive_backup_category(archive_path: &str) -> Option<&'static str> {
    let parts = split_archive_parts(archive_path);
    let root = *parts.first()?;
    let rel = parts[1..].join("/");
    match root {
        GSM_ARCHIVE_ROOT => gsm_backup_category(&rel),
        OVERLAY_ARCHIVE_ROOT => overlay_backup_category(&rel),
        HOME_ARCHIVE_ROOT => Some("ocr-configs"),
        _ => None,
    }
}

pub fn should_include_gsm_backup_path(relative: &str, is_dir: bool) -> bool {
    let parts = split_archive_parts(relative);
    let Some(&first) = parts.first() else {
        return false;
    };
    if first == "gsm_overlay" {
        return false;
    }
    if parts.len() == 1 {
        return if is_dir {
            GSM_TRAVERSABLE_DIRS.contains(&first)
        } else {
            GSM_TOP_LEVEL_FILES.contains(&first) || is_sqlite_database_file(first)
        };
    }
    let second = parts[1];
    match first {
        "electron" => parts.len() == 2 && !is_dir && ELECTRON_SETTINGS_FILES.contains(&second),
        "ocr_config" => {
            if second == "backup" {
                return false;
            }
            is_dir || !is_runtime_file_name(parts[parts.len() - 1])
        }
        "obs-studio" => {
            if second != "config" {
                return false;
            }
            if parts.len() >= 4 && OBS_EXCLUDED_CONFIG_DIRS.contains(&parts[3]) {
                return false;
            }
            is_dir || !is_runtime_file_name(parts[parts.len() - 1])
        }
        "texthook" => parts.len() == 2 && !is_dir && TEXTHOOK_SETTINGS_FILES.contains(&second),
        "config" | "agent-scripts" | "scripts" => {
            is_dir || !is_runtime_file_name(parts[parts.len() - 1])
        }
        _ => false,
    }
}

pub fn should_include_overlay_backup_path(relative: &str, is_dir: bool) -> bool {
    let parts = split_archive_parts(relative);
    let Some(&first) = parts.first() else {
        return false;
    };
    if parts.len() == 1 {
        return if is_dir {
            OVERLAY_STORAGE_DIRS.contains(&first) && !OVERLAY_EXCLUDED_DIRS.contains(&first)
        } else {
            OVERLAY_TOP_LEVEL_FILES.contains(&first)
        };
    }
    if OVERLAY_STORAGE_DIRS.contains(&first) {
        return is_dir || !is_runtime_file_name(parts[parts.len() - 1]);
    }
    false
}

#[derive(Clone, Debug)]
struct CollectedFile {
    absolute_path: PathBuf,
    archive_path: String,
    size: u64,
}

#[derive(Clone, Debug)]
struct RestoreFile {
    source_path: PathBuf,
    destination_path: PathBuf,
    display_path: String,
}

fn walk_root_filtered<F>(
    root_dir: &Path,
    archive_root: &str,
    include: F,
) -> Result<Vec<CollectedFile>>
where
    F: Fn(&str, bool) -> bool,
{
    if !root_dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    fn visit<F: Fn(&str, bool) -> bool>(
        root: &Path,
        rel_dir: &Path,
        archive_root: &str,
        include: &F,
        out: &mut Vec<CollectedFile>,
    ) -> Result<()> {
        let dir = if rel_dir.as_os_str().is_empty() {
            root.to_path_buf()
        } else {
            root.join(rel_dir)
        };
        let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            let rel = rel_dir.join(entry.file_name());
            let rel_norm = normalize_archive_rel(&rel);
            if file_type.is_dir() {
                if include(&rel_norm, true) {
                    visit(root, &rel, archive_root, include, out)?;
                }
            } else if file_type.is_file() && include(&rel_norm, false) {
                let abs = root.join(&rel);
                let size = entry.metadata().map_err(|e| e.to_string())?.len();
                out.push(CollectedFile {
                    absolute_path: abs,
                    archive_path: format!("{archive_root}/{rel_norm}"),
                    size,
                });
            }
        }
        Ok(())
    }
    visit(root_dir, Path::new(""), archive_root, &include, &mut files)?;
    Ok(files)
}

fn unit_progress(completed: usize, total: usize) -> Option<f64> {
    if total == 0 {
        None
    } else {
        Some((completed as f64 / total as f64).clamp(0.0, 1.0))
    }
}

pub fn create_backup_archive(
    options: &BackupArchiveOptions,
    mut on_progress: impl FnMut(BackupProgressEvent),
) -> Result<BackupArchiveResult> {
    on_progress(BackupProgressEvent {
        operation: "create".into(),
        phase: "scanning".into(),
        file_name: None,
        completed: Some(0),
        total: None,
        progress: None,
    });

    let categories =
        normalize_settings_backup_categories(options.categories.as_deref(), true);
    let selected: HashSet<&str> = categories.iter().map(String::as_str).collect();
    let use_db_snapshot =
        selected.contains("database") && options.database_snapshot_path.is_some();

    let mut collected = Vec::new();
    let mut roots = BTreeSet::new();

    let gsm_files: Vec<CollectedFile> = walk_root_filtered(
        &options.base_dir,
        GSM_ARCHIVE_ROOT,
        |rel, is_dir| {
            let first = rel.split('/').next().unwrap_or("");
            if use_db_snapshot && !is_dir && is_sqlite_database_file(first) {
                return false;
            }
            should_include_gsm_backup_path(rel, is_dir)
        },
    )?
    .into_iter()
    .filter(|f| {
        archive_backup_category(&f.archive_path)
            .is_some_and(|cat| selected.contains(cat))
    })
    .collect();
    if !gsm_files.is_empty() {
        roots.insert("gsm".to_owned());
        collected.extend(gsm_files);
    }

    let overlay_files: Vec<CollectedFile> = walk_root_filtered(
        &options.overlay_dir,
        OVERLAY_ARCHIVE_ROOT,
        should_include_overlay_backup_path,
    )?
    .into_iter()
    .filter(|f| {
        archive_backup_category(&f.archive_path)
            .is_some_and(|cat| selected.contains(cat))
    })
    .collect();
    if !overlay_files.is_empty() {
        roots.insert("overlay".to_owned());
        collected.extend(overlay_files);
    }

    if let Some(snapshot_path) = options
        .database_snapshot_path
        .as_ref()
        .filter(|_| use_db_snapshot)
    {
        let meta = fs::metadata(snapshot_path)
            .map_err(|_| "The verified database snapshot is missing.".to_string())?;
        if !meta.is_file() {
            return Err("The verified database snapshot is missing.".into());
        }
        roots.insert("gsm".to_owned());
        collected.push(CollectedFile {
            absolute_path: snapshot_path.clone(),
            archive_path: format!("{GSM_ARCHIVE_ROOT}/gsm.db"),
            size: meta.len(),
        });
    }

    if selected.contains("ocr-configs") && options.home_config_path.exists() {
        if let Ok(meta) = fs::metadata(&options.home_config_path) {
            if meta.is_file() {
                roots.insert("home".to_owned());
                collected.push(CollectedFile {
                    absolute_path: options.home_config_path.clone(),
                    archive_path: format!("{HOME_ARCHIVE_ROOT}/{OWOCR_HOME_RELATIVE_PATH}"),
                    size: meta.len(),
                });
            }
        }
    }

    collected.sort_by(|a, b| a.archive_path.cmp(&b.archive_path));
    let total_bytes: u64 = collected.iter().map(|f| f.size).sum();
    let roots_vec: Vec<String> = roots.into_iter().collect();
    let created_at = format_iso_utc(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    );
    let manifest = BackupManifest {
        format: "gsm-settings-backup".into(),
        version: BACKUP_FORMAT_VERSION,
        created_at,
        roots: roots_vec.clone(),
        file_count: collected.len(),
        total_bytes,
        categories: categories.clone(),
    };

    let out_parent = options
        .output_path
        .parent()
        .ok_or("Missing backup output directory")?;
    fs::create_dir_all(out_parent).map_err(|e| e.to_string())?;
    let total = collected.len();
    on_progress(BackupProgressEvent {
        operation: "create".into(),
        phase: "archiving".into(),
        file_name: None,
        completed: Some(0),
        total: Some(total),
        progress: unit_progress(0, total),
    });

    let temp_output = out_parent.join(format!(".gsm-backup-{}.zip.tmp", uuid::Uuid::new_v4()));
    let write_res = (|| -> Result<()> {
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_output)
            .map_err(|e| e.to_string())?;
        let zip_options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(6));
        let mut writer = ZipWriter::new(file);

        let manifest_bytes =
            serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        writer
            .start_file(MANIFEST_NAME, zip_options)
            .map_err(|e| e.to_string())?;
        writer
            .write_all(&manifest_bytes)
            .map_err(|e| e.to_string())?;

        let mut buf = vec![0u8; 64 * 1024];
        for (idx, item) in collected.iter().enumerate() {
            writer
                .start_file(&item.archive_path, zip_options)
                .map_err(|e| e.to_string())?;
            let mut src = File::open(&item.absolute_path).map_err(|e| e.to_string())?;
            loop {
                let n = std::io::Read::read(&mut src, &mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                writer.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            }
            let completed = idx + 1;
            on_progress(BackupProgressEvent {
                operation: "create".into(),
                phase: "archiving".into(),
                file_name: Some(item.archive_path.clone()),
                completed: Some(completed),
                total: Some(total),
                progress: unit_progress(completed, total),
            });
        }

        let finished = writer.finish().map_err(|e| e.to_string())?;
        finished.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&temp_output);
        return Err(err);
    }
    if options.output_path.exists() {
        fs::remove_file(&options.output_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp_output, &options.output_path).map_err(|e| {
        let _ = fs::remove_file(&temp_output);
        e.to_string()
    })?;

    on_progress(BackupProgressEvent {
        operation: "create".into(),
        phase: "done".into(),
        file_name: None,
        completed: Some(total),
        total: Some(total),
        progress: Some(1.0),
    });

    Ok(BackupArchiveResult {
        file_path: options.output_path.to_string_lossy().into_owned(),
        file_count: total,
        total_bytes,
        roots: roots_vec,
        categories,
    })
}

fn parse_manifest(value: &Value) -> Result<BackupManifest> {
    let Some(obj) = value.as_object() else {
        return Err("The selected archive is missing a GSM backup manifest.".into());
    };
    if obj.get("format").and_then(Value::as_str) != Some("gsm-settings-backup")
        || obj.get("version").and_then(Value::as_u64) != Some(u64::from(BACKUP_FORMAT_VERSION))
        || !obj.get("roots").is_some_and(Value::is_array)
    {
        return Err("The selected archive is not a supported GSM settings backup.".into());
    }
    let roots: Vec<String> = obj["roots"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .filter(|r| matches!(*r, "gsm" | "overlay" | "home"))
        .map(ToOwned::to_owned)
        .collect();
    let cats_raw: Option<Vec<String>> = obj.get("categories").and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect()
    });
    Ok(BackupManifest {
        format: "gsm-settings-backup".into(),
        version: BACKUP_FORMAT_VERSION,
        created_at: obj
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        roots,
        file_count: obj.get("fileCount").and_then(Value::as_u64).unwrap_or(0) as usize,
        total_bytes: obj.get("totalBytes").and_then(Value::as_u64).unwrap_or(0),
        categories: normalize_settings_backup_categories(cats_raw.as_deref(), true),
    })
}

fn remove_if_exists(path: &Path) -> Result<()> {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if meta.file_type().is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

fn clear_children_except(target_dir: &Path, excluded: &[&str]) -> Result<()> {
    if !target_dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(target_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if excluded.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        remove_if_exists(&entry.path())?;
    }
    Ok(())
}

fn prepare_gsm_restore_target(
    source_dir: &Path,
    base_dir: &Path,
    selected: &HashSet<&str>,
) -> Result<()> {
    if !source_dir.exists() {
        return Ok(());
    }
    for &file_name in GSM_TOP_LEVEL_FILES {
        if let Some(cat) = gsm_backup_category(file_name) {
            if selected.contains(cat) && source_dir.join(file_name).exists() {
                if file_name == "gsm.db" {
                    // Replace atomically in copy_restore_files.
                    continue;
                }
                remove_if_exists(&base_dir.join(file_name))?;
            }
        }
    }
    for (dir_name, cat) in [
        ("config", "python-settings"),
        ("agent-scripts", "agent-scripts"),
        ("scripts", "user-scripts"),
    ] {
        if selected.contains(cat) && source_dir.join(dir_name).exists() {
            remove_if_exists(&base_dir.join(dir_name))?;
        }
    }
    if selected.contains("ocr-configs") && source_dir.join("ocr_config").exists() {
        let ocr_dir = base_dir.join("ocr_config");
        fs::create_dir_all(&ocr_dir).map_err(|e| e.to_string())?;
        clear_children_except(&ocr_dir, &["backup"])?;
    }
    if source_dir.join("electron").exists() {
        let electron_dir = base_dir.join("electron");
        fs::create_dir_all(&electron_dir).map_err(|e| e.to_string())?;
        for &file_name in ELECTRON_SETTINGS_FILES {
            if let Some(cat) = gsm_backup_category(&format!("electron/{file_name}")) {
                if selected.contains(cat) {
                    remove_if_exists(&electron_dir.join(file_name))?;
                }
            }
        }
    }
    let obs_source = source_dir.join("obs-studio/config/obs-studio");
    if selected.contains("obs-config") && obs_source.exists() {
        let obs_target = base_dir.join("obs-studio/config/obs-studio");
        fs::create_dir_all(&obs_target).map_err(|e| e.to_string())?;
        clear_children_except(&obs_target, OBS_EXCLUDED_CONFIG_DIRS)?;
    }
    if selected.contains("text-hook-settings") && source_dir.join("texthook").exists() {
        let texthook_dir = base_dir.join("texthook");
        fs::create_dir_all(&texthook_dir).map_err(|e| e.to_string())?;
        for &file_name in TEXTHOOK_SETTINGS_FILES {
            remove_if_exists(&texthook_dir.join(file_name))?;
        }
    }
    Ok(())
}

fn prepare_overlay_restore_target(
    source_dir: &Path,
    overlay_dir: &Path,
    selected: &HashSet<&str>,
) -> Result<()> {
    if !source_dir.exists() {
        return Ok(());
    }
    fs::create_dir_all(overlay_dir).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if let Some(cat) = overlay_backup_category(&name_str) {
            if selected.contains(cat) {
                remove_if_exists(&overlay_dir.join(name))?;
            }
        }
    }
    Ok(())
}

fn collect_restore_files(
    source_dir: &Path,
    dest_dir: &Path,
    display_root: &str,
    selected: &HashSet<&str>,
) -> Result<Vec<RestoreFile>> {
    if !source_dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    fn visit(
        source_root: &Path,
        dest_root: &Path,
        rel_dir: &Path,
        display_root: &str,
        selected: &HashSet<&str>,
        out: &mut Vec<RestoreFile>,
    ) -> Result<()> {
        let cur = if rel_dir.as_os_str().is_empty() {
            source_root.to_path_buf()
        } else {
            source_root.join(rel_dir)
        };
        for entry in fs::read_dir(&cur).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            if ft.is_symlink() {
                continue;
            }
            let rel = rel_dir.join(entry.file_name());
            if ft.is_dir() {
                visit(source_root, dest_root, &rel, display_root, selected, out)?;
            } else if ft.is_file() {
                let rel_norm = normalize_archive_rel(&rel);
                let display_path = format!("{display_root}/{rel_norm}");
                if archive_backup_category(&display_path)
                    .is_some_and(|cat| selected.contains(cat))
                {
                    out.push(RestoreFile {
                        source_path: source_root.join(&rel),
                        destination_path: dest_root.join(&rel),
                        display_path,
                    });
                }
            }
        }
        Ok(())
    }
    visit(source_dir, dest_dir, Path::new(""), display_root, selected, &mut files)?;
    files.sort_by(|a, b| a.display_path.cmp(&b.display_path));
    Ok(files)
}

fn copy_restore_files(
    files: &[RestoreFile],
    on_progress: &mut impl FnMut(BackupProgressEvent),
) -> Result<()> {
    let total = files.len();
    for (idx, file) in files.iter().enumerate() {
        on_progress(BackupProgressEvent {
            operation: "restore".into(),
            phase: "restoring".into(),
            file_name: Some(file.display_path.clone()),
            completed: Some(idx),
            total: Some(total),
            progress: unit_progress(idx, total),
        });
        if let Some(parent) = file.destination_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if file.display_path == format!("{GSM_ARCHIVE_ROOT}/gsm.db") {
            let parent = file.destination_path.parent().unwrap();
            let temp_db = parent.join(format!(".gsm.db.{}.tmp", uuid::Uuid::new_v4()));
            let copy_res = (|| -> Result<()> {
                fs::copy(&file.source_path, &temp_db).map_err(|e| e.to_string())?;
                let handle = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&temp_db)
                    .map_err(|e| e.to_string())?;
                handle.sync_all().map_err(|e| e.to_string())?;
                drop(handle);
                if file.destination_path.exists() {
                    fs::remove_file(&file.destination_path).map_err(|e| e.to_string())?;
                }
                fs::rename(&temp_db, &file.destination_path).map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Err(err) = copy_res {
                let _ = fs::remove_file(&temp_db);
                return Err(err);
            }
        } else {
            fs::copy(&file.source_path, &file.destination_path).map_err(|e| e.to_string())?;
        }
        let completed = idx + 1;
        on_progress(BackupProgressEvent {
            operation: "restore".into(),
            phase: "restoring".into(),
            file_name: Some(file.display_path.clone()),
            completed: Some(completed),
            total: Some(total),
            progress: unit_progress(completed, total),
        });
    }
    Ok(())
}

struct StagingDirGuard(PathBuf);
impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn restore_backup_archive(
    options: &RestoreArchiveOptions,
    mut on_progress: impl FnMut(BackupProgressEvent),
) -> Result<RestoreArchiveResult> {
    let categories =
        normalize_settings_backup_categories(options.categories.as_deref(), true);
    let selected: HashSet<&str> = categories.iter().map(String::as_str).collect();
    let staging_path = std::env::temp_dir().join(format!(
        "gsm-settings-restore-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&staging_path).map_err(|e| e.to_string())?;
    let extract_guard = StagingDirGuard(staging_path);
    let extract_dir_path = &extract_guard.0;

    on_progress(BackupProgressEvent {
        operation: "restore".into(),
        phase: "extracting".into(),
        file_name: None,
        completed: Some(0),
        total: None,
        progress: None,
    });

    extract_with_progress(&options.archive_path, extract_dir_path, None, &mut |name| {
        if name != MANIFEST_NAME && !name.ends_with('/') {
            on_progress(BackupProgressEvent {
                operation: "restore".into(),
                phase: "extracting".into(),
                file_name: Some(name.to_owned()),
                completed: None,
                total: None,
                progress: None,
            });
        }
    })?;

    let manifest_raw = fs::read_to_string(extract_dir_path.join(MANIFEST_NAME))
        .map_err(|_| "The selected archive is missing a GSM backup manifest.".to_string())?;
    let manifest_val: Value =
        serde_json::from_str(manifest_raw.trim_start_matches('\u{feff}'))
            .map_err(|e| e.to_string())?;
    let manifest = parse_manifest(&manifest_val)?;

    let gsm_source = extract_dir_path.join(GSM_ARCHIVE_ROOT);
    let overlay_source = extract_dir_path.join(OVERLAY_ARCHIVE_ROOT);
    let home_source = extract_dir_path.join(HOME_ARCHIVE_ROOT);
    let mut restore_files = Vec::new();

    if manifest.roots.iter().any(|r| r == "gsm") {
        prepare_gsm_restore_target(&gsm_source, &options.base_dir, &selected)?;
        restore_files.extend(collect_restore_files(
            &gsm_source,
            &options.base_dir,
            GSM_ARCHIVE_ROOT,
            &selected,
        )?);
    }
    if manifest.roots.iter().any(|r| r == "overlay") {
        prepare_overlay_restore_target(&overlay_source, &options.overlay_dir, &selected)?;
        restore_files.extend(collect_restore_files(
            &overlay_source,
            &options.overlay_dir,
            OVERLAY_ARCHIVE_ROOT,
            &selected,
        )?);
    }
    if manifest.roots.iter().any(|r| r == "home") && selected.contains("ocr-configs") {
        let src_home = home_source.join(OWOCR_HOME_RELATIVE_PATH);
        if src_home.is_file() {
            restore_files.push(RestoreFile {
                source_path: src_home,
                destination_path: options.home_config_path.clone(),
                display_path: format!("{HOME_ARCHIVE_ROOT}/{OWOCR_HOME_RELATIVE_PATH}"),
            });
        }
    }

    restore_files.sort_by(|a, b| a.display_path.cmp(&b.display_path));
    let total = restore_files.len();
    on_progress(BackupProgressEvent {
        operation: "restore".into(),
        phase: "restoring".into(),
        file_name: None,
        completed: Some(0),
        total: Some(total),
        progress: unit_progress(0, total),
    });
    copy_restore_files(&restore_files, &mut on_progress)?;

    on_progress(BackupProgressEvent {
        operation: "restore".into(),
        phase: "done".into(),
        file_name: None,
        completed: Some(total),
        total: Some(total),
        progress: Some(1.0),
    });

    Ok(RestoreArchiveResult {
        file_count: total,
        total_bytes: manifest.total_bytes,
        roots: manifest.roots,
        categories,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::tempdir;

    fn write_rel(root: &Path, rel: &str, contents: &[u8]) {
        let target = root.join(rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, contents).unwrap();
    }

    #[test]
    fn archives_verified_snapshot_without_wal_or_shm_and_restores_preserving_excluded_dirs() {
        let dir = tempdir().unwrap();
        let src_base = dir.path().join("src_base");
        let src_overlay = dir.path().join("src_overlay");
        let src_home = dir.path().join("src_home/.config/owocr_config_gsm.ini");
        let out_zip = dir.path().join("backup.zip");
        let snapshot = dir.path().join("snapshot.db");

        fs::write(&snapshot, b"verified-snapshot").unwrap();
        write_rel(&src_base, "config.json", br#"{"gsm":true}"#);
        write_rel(&src_base, "gsm.db", b"live-db");
        write_rel(&src_base, "gsm.db-wal", b"wal");
        write_rel(&src_base, "gsm.db-shm", b"shm");
        write_rel(&src_base, "current_pid.txt", b"123");
        write_rel(&src_base, "ocr_config/Game.json", br#"{"areas":[]}"#);
        write_rel(&src_base, "ocr_config/backup/Game/old.json", br#"{"old":true}"#);
        write_rel(&src_base, "obs-studio/config/obs-studio/global.ini", b"global");
        write_rel(&src_base, "obs-studio/config/obs-studio/logs/obs.txt", b"log");
        write_rel(&src_base, "obs-studio/bin/64bit/obs64.exe", b"exe");
        write_rel(&src_base, "texthook/profiles.json", br#"{"profiles":[]}"#);
        write_rel(&src_base, "texthook/luna_builds/LunaHost64.dll", b"dll");
        write_rel(&src_overlay, "settings.json", br#"{"fontSize":42}"#);
        write_rel(&src_overlay, "IndexedDB/ext.leveldb/000003.log", b"leveldb");
        write_rel(&src_overlay, "IndexedDB/ext.leveldb/LOCK", b"lock");
        write_rel(&src_overlay, "Cache/Cache_Data/data_0", b"cache");
        write_rel(
            src_home.parent().unwrap().parent().unwrap(),
            ".config/owocr_config_gsm.ini",
            b"[general]\nwebsocket_port = 7331\n",
        );

        let mut create_events = Vec::new();
        let created = create_backup_archive(
            &BackupArchiveOptions {
                output_path: out_zip.clone(),
                base_dir: src_base,
                overlay_dir: src_overlay,
                home_config_path: src_home,
                database_snapshot_path: Some(snapshot),
                categories: None,
            },
            |ev| create_events.push(ev),
        )
        .unwrap();

        assert_eq!(created.roots, vec!["gsm", "home", "overlay"]);
        assert_eq!(create_events.first().unwrap().phase, "scanning");
        assert_eq!(create_events.last().unwrap().phase, "done");

        let dst_base = dir.path().join("dst_base");
        let dst_overlay = dir.path().join("dst_overlay");
        let dst_home = dir.path().join("dst_home/.config/owocr_config_gsm.ini");
        write_rel(&dst_base, "ocr_config/Extra.json", b"stale");
        write_rel(&dst_base, "ocr_config/backup/Keep/k.json", b"keep");
        write_rel(&dst_base, "obs-studio/config/obs-studio/logs/obs.txt", b"keep-log");
        write_rel(&dst_overlay, "Cache/Cache_Data/data_0", b"keep-cache");
        write_rel(&dst_overlay, "IndexedDB/ext.leveldb/stale.log", b"stale");

        let restored = restore_backup_archive(
            &RestoreArchiveOptions {
                archive_path: out_zip,
                base_dir: dst_base.clone(),
                overlay_dir: dst_overlay.clone(),
                home_config_path: dst_home.clone(),
                categories: None,
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(restored.roots, vec!["gsm", "home", "overlay"]);

        assert_eq!(fs::read(dst_base.join("gsm.db")).unwrap(), b"verified-snapshot");
        assert!(!dst_base.join("gsm.db-wal").exists());
        assert!(!dst_base.join("current_pid.txt").exists());
        assert!(!dst_base.join("ocr_config/Extra.json").exists());
        assert!(dst_base.join("ocr_config/backup/Keep/k.json").exists());
        assert!(dst_base.join("obs-studio/config/obs-studio/logs/obs.txt").exists());
        assert!(!dst_base.join("texthook/luna_builds/LunaHost64.dll").exists());
        assert!(dst_overlay.join("Cache/Cache_Data/data_0").exists());
        assert!(!dst_overlay.join("IndexedDB/ext.leveldb/stale.log").exists());
        assert!(fs::read_to_string(dst_home).unwrap().contains("7331"));
    }

    #[test]
    #[ignore = "Release benchmark: cargo test --release --manifest-path native/gsm-packages/Cargo.toml bench_settings_backup_roundtrip -- --ignored --nocapture"]
    fn bench_settings_backup_roundtrip() {
        let dir = tempdir().unwrap();
        let src_base = dir.path().join("base");
        let src_overlay = dir.path().join("overlay");
        let src_home = dir.path().join("home/owocr_config_gsm.ini");
        let out_zip = dir.path().join("backup.zip");
        // Simulate ~8 MiB mixed SQLite DB + JSON settings + Yomitan LevelDB shards.
        write_rel(&src_base, "gsm.db", &vec![b'D'; 6 * 1024 * 1024]);
        for i in 0..100 {
            write_rel(
                &src_base,
                &format!("ocr_config/game_{i}.json"),
                &format!(r#"{{"game":{i},"areas":[{{"x":10,"y":20,"w":800,"h":200}}]}}"#).into_bytes(),
            );
            write_rel(
                &src_overlay,
                &format!("IndexedDB/ext.leveldb/{i:06}.ldb"),
                &vec![b'Y'; 16 * 1024],
            );
        }

        let t0 = Instant::now();
        let created = create_backup_archive(
            &BackupArchiveOptions {
                output_path: out_zip.clone(),
                base_dir: src_base,
                overlay_dir: src_overlay,
                home_config_path: src_home,
                database_snapshot_path: None,
                categories: None,
            },
            |_| {},
        )
        .unwrap();
        let archive_elapsed = t0.elapsed();

        let dst_base = dir.path().join("restore_base");
        let dst_overlay = dir.path().join("restore_overlay");
        let dst_home = dir.path().join("restore_home/owocr_config_gsm.ini");
        let t1 = Instant::now();
        let restored = restore_backup_archive(
            &RestoreArchiveOptions {
                archive_path: out_zip.clone(),
                base_dir: dst_base,
                overlay_dir: dst_overlay,
                home_config_path: dst_home,
                categories: None,
            },
            |_| {},
        )
        .unwrap();
        let restore_elapsed = t1.elapsed();
        let zip_mb = fs::metadata(&out_zip).unwrap().len() as f64 / (1024.0 * 1024.0);
        println!(
            "bench_settings_backup_roundtrip: files={} raw={:.2} MiB zip={:.2} MiB create={:.2?} restore={:.2?}",
            restored.file_count,
            created.total_bytes as f64 / (1024.0 * 1024.0),
            zip_mb,
            archive_elapsed,
            restore_elapsed
        );
    }
}
