//! Native WebView2 extension host, portable WebExtension host, legacy dictionary migration,
//! and pure-Rust JS expression-return script wrapper for GSM desktop dictionaries.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::Mutex as AsyncMutex;
#[cfg(test)]
use zip::ZipArchive;


const DICTIONARY_PRELOAD_TEMPLATE: &str = include_str!("../preloads/dictionary_preload.js");
const LEGACY_IMPORT_MODULE_JS: &str = include_str!("../preloads/legacy_import.mjs");

pub const EXTENSION_CONTROLLER_LABEL: &str = "gsm-dictionary-controller";
pub const HACHIDORI_ENGINE_LABEL: &str = "gsm-hachidori-engine";
#[cfg(windows)]
const YOMITAN_PUBLIC_KEY: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjhXmk6bLKLKx3W6A32aAlnbu2EyWWo4SHGclT6oLLGs4bvdpUEbFuIqXg5iHn/eXe6PTV6e1ATz5aUif06mzw7DgxkK8yqNBV/oIUrf/v5YuJbOxrZIkAu7l/ng6yb1Rw6YXL3a40sC8adF4odSHYLeThv2WJJ+LKbyP1P/dx+302OwgZa0Z9ppJZ3H7bN0MJ4CeNk/TP01zIuM/4Odz7BEHVVJlUPK6vybIjq30LuFPmDDNPCGpahCkKoOt9u/42YNa+mKkC9AAY/ZWRNByIYQonUV6g6kvoyPkf7S85dmo30Efq5dZRqMuMJyZoSuOpQOy24ShKkyYEB87/vIRUQIDAQAB";

pub const LEGACY_TRANSFER_LABEL: &str = "gsm-legacy-transfer";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedExtension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub path: PathBuf,
    pub source_path: PathBuf,
    pub manifest: Value,
    pub base: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub name: String,
    pub phase: String,
    pub records: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacySource {
    pub id: String,
    pub database: PathBuf,
    pub settings: PathBuf,
    pub filesystem: Option<PathBuf>,
}

#[cfg(test)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryZipSummary {
    pub entry_count: usize,
    pub total_uncompressed_bytes: u64,
    pub format: String,
    pub title: Option<String>,
    pub revision: Option<String>,
}

#[derive(Clone, Debug)]
struct ExtensionContext {
    extension_id: String,
    kind: String, // "background" | "offscreen" | "tab"
    url: String,
}

#[derive(Clone, Debug)]
struct ContentContext {
    url: String,
}

#[derive(Clone, Debug)]
struct ContextTarget {
    label: String,
    extension_id: String,
    kind: String,
    url: String,
}

#[derive(Clone, Debug)]
struct PortEndpoint {
    label: String,
    extension_id: String,
    frame: u64,
}

#[derive(Clone, Debug)]
struct PortState {
    source: PortEndpoint,
    targets: Vec<PortEndpoint>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRecord {
    id: u64,
    url: String,
    label: String,
    extension: String,
    state: String,
    filename: String,
}

pub struct DictionaryManager {
    portable_extensions: Mutex<HashMap<String, LoadedExtension>>,
    windows_extensions: Mutex<HashMap<String, LoadedExtension>>,
    #[cfg(windows)]
    inactive_reader: Mutex<Option<LoadedExtension>>,
    contexts: Mutex<HashMap<String, ExtensionContext>>,
    content_contexts: Mutex<HashMap<(String, String), ContentContext>>,
    ports: Mutex<HashMap<String, PortState>>,
    storage_memory: Mutex<HashMap<String, Map<String, Value>>>,
    alarms: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    downloads: Mutex<HashMap<u64, DownloadRecord>>,
    transfers: Mutex<HashMap<String, TransferProgress>>,
    home_reader_ext: Mutex<HashMap<String, String>>,
    home_reader_windows: Mutex<HashSet<String>>,
    hachidori_engine_ready: Mutex<HashSet<String>>,
    download_seq: AtomicU64,
    window_seq: AtomicU64,
    portable_lock: AsyncMutex<()>,
    windows_lock: AsyncMutex<()>,
    browser_import_lock: AsyncMutex<()>,
    hachidori_engine_lock: AsyncMutex<()>,
}

impl Default for DictionaryManager {
    fn default() -> Self {
        Self {
            portable_extensions: Mutex::new(HashMap::new()),
            windows_extensions: Mutex::new(HashMap::new()),
            #[cfg(windows)]
            inactive_reader: Mutex::new(None),
            contexts: Mutex::new(HashMap::new()),
            content_contexts: Mutex::new(HashMap::new()),
            ports: Mutex::new(HashMap::new()),
            storage_memory: Mutex::new(HashMap::new()),
            alarms: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            home_reader_ext: Mutex::new(HashMap::new()),
            home_reader_windows: Mutex::new(HashSet::new()),
            hachidori_engine_ready: Mutex::new(HashSet::new()),
            download_seq: AtomicU64::new(1),
            window_seq: AtomicU64::new(1),
            portable_lock: AsyncMutex::new(()),
            windows_lock: AsyncMutex::new(()),
            browser_import_lock: AsyncMutex::new(()),
            hachidori_engine_lock: AsyncMutex::new(()),
        }
    }
}

pub fn use_windows_native_extensions() -> bool {
    cfg!(windows) && std::env::var_os("GSM_PORTABLE_DICTIONARIES").as_deref() != Some("1".as_ref())
}

pub fn overlay_data_path(app: &AppHandle) -> PathBuf {
    if let Some(raw) = std::env::var_os("GSM_OVERLAY_DATA_PATH") {
        let path = PathBuf::from(raw);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    let paths = crate::desktop_services::paths_for(app);
    gsm_packages::settings_backup::get_overlay_data_dir(&paths.active, paths.has_profile)
}

pub fn overlay_resources_root(app: &AppHandle) -> PathBuf {
    let app_root = &app.state::<crate::desktop_state::DesktopState>().app_root;
    let direct = app_root.join("GSM_Overlay");
    if direct.join("yomitan").exists() || direct.join("hachidori").exists() || direct.exists() {
        return direct;
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("GSM_Overlay");
        if bundled.exists() {
            return bundled;
        }
    }
    app_root.join("resources").join("GSM_Overlay")
}

pub fn reader_selection(overlay_data: &Path) -> &'static str {
    let path = overlay_data.join("settings.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return "yomitan";
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return "yomitan";
    };
    if parsed["dictionaryReaderSelection"].as_str() == Some("hachidori") {
        "hachidori"
    } else {
        "yomitan"
    }
}

pub fn extension_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("yomitan") {
        "yomitan"
    } else if lower.contains("hachidori") {
        "hachidori"
    } else {
        "jiten"
    }
}

pub fn read_manifest(directory: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(directory.join("manifest.json"))
        .map_err(|e| format!("Failed to read manifest.json: {e}"))?;
    let trimmed = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    serde_json::from_str(trimmed).map_err(|e| format!("Invalid manifest.json: {e}"))
}

pub fn is_valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

pub fn extension_id_from_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(32);
    for &byte in &digest[..16] {
        out.push((b'a' + (byte >> 4)) as char);
        out.push((b'a' + (byte & 0x0f)) as char);
    }
    out
}

pub fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn canonical_path_for_hash(path: &Path) -> PathBuf {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    });
    strip_windows_verbatim_prefix(&resolved)
}

#[cfg(windows)]
fn windows_extension_path_bytes(path: &Path) -> Vec<u8> {
    let resolved = canonical_path_for_hash(path);
    let text = resolved.to_string_lossy();
    let mut chars = text.chars();
    let canonical = match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
    };
    let mut bytes = Vec::with_capacity(canonical.len() * 2);
    for code in canonical.encode_utf16() {
        bytes.extend_from_slice(&code.to_le_bytes());
    }
    bytes
}

pub fn extension_id_for_directory(directory: &Path, manifest: &Value, windows_hash: bool) -> String {
    if let Some(key) = manifest.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) {
        if let Ok(decoded) = STANDARD.decode(key) {
            return extension_id_from_bytes(&decoded);
        }
    }
    if windows_hash {
        #[cfg(windows)]
        {
            return extension_id_from_bytes(&windows_extension_path_bytes(directory));
        }
    }
    let name = directory
        .file_name()
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    let sanitized: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("gsm-{sanitized}")
}

/// Deterministic SHA-256 content digest across every file in an unpacked extension folder.
/// Mirrors `GSM_Overlay/extension_revision.js` byte-for-byte without per-file vector churn.
pub fn extension_content_revision(directory: &Path) -> Result<String, String> {
    fn visit(
        base: &Path,
        rel: &str,
        hasher: &mut Sha256,
        scratch: &mut Vec<u8>,
    ) -> Result<(), String> {
        let current = if rel.is_empty() {
            base.to_path_buf()
        } else {
            base.join(rel)
        };
        let mut entries = fs::read_dir(&current)
            .map_err(|e| format!("Failed to read extension dir {}: {e}", current.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read dir entry in {}: {e}", current.display()))?;
        entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
        for entry in entries {
            let file_type = entry
                .file_type()
                .map_err(|e| format!("Failed to stat {}: {e}", entry.path().display()))?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let next_rel = if rel.is_empty() {
                name_str.into_owned()
            } else {
                format!("{rel}/{name_str}")
            };
            if file_type.is_dir() {
                visit(base, &next_rel, hasher, scratch)?;
            } else if file_type.is_file() {
                scratch.clear();
                let path = entry.path();
                let mut file = fs::File::open(&path)
                    .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
                if let Ok(meta) = file.metadata() {
                    let cap = meta.len() as usize;
                    if scratch.capacity() < cap {
                        scratch.reserve(cap - scratch.capacity());
                    }
                }
                file.read_to_end(scratch)
                    .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
                let header = format!("{next_rel}\0{}\0", scratch.len());
                hasher.update(header.as_bytes());
                hasher.update(&scratch);
            }
        }
        Ok(())
    }

    let mut hasher = Sha256::new();
    let mut scratch = Vec::with_capacity(64 * 1024);
    visit(directory, "", &mut hasher, &mut scratch)?;
    let digest = hasher.finalize();
    Ok(hex_lower(&digest))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create {}: {e}", dst.display()))?;
    let entries = fs::read_dir(src)
        .map_err(|e| format!("Failed to read {}: {e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed dir entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_symlink() {
            return Err("Dictionary resource contains a symbolic link".into());
        }
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to)
                .map_err(|e| format!("Failed copying {} -> {}: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

pub fn resolve_extension_source(
    overlay_data: &Path,
    resource_root: &Path,
    reader: &str,
    native_windows: bool,
) -> Result<PathBuf, String> {
    let bundled = resource_root.join(reader);
    let profile_yomitan = std::env::var_os("GSM_PROFILE_DIR").is_some_and(|v| !v.is_empty())
        && reader == "yomitan"
        && !native_windows;
    if !cfg!(target_os = "linux") && !profile_yomitan {
        return Ok(bundled);
    }

    let root = overlay_data.join("extensions");
    let target = root.join(reader);
    let versions_file = root.join("versions.json");

    let revision = if reader == "yomitan" {
        extension_content_revision(&bundled)?
    } else {
        let manifest = read_manifest(&bundled)?;
        let version = manifest["version"].as_str().unwrap_or_default().to_string();
        let source_raw = fs::read_to_string(bundled.join("SOURCE.json")).unwrap_or_default();
        let source_val: Value = serde_json::from_str(&source_raw).unwrap_or(Value::Null);
        let commit = source_val["commit"].as_str().filter(|s| !s.is_empty());
        let sha = source_val["gsmIntegration"]["sha256"]
            .as_str()
            .filter(|s| !s.is_empty());
        let fp = [commit, sha]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(".");
        if fp.is_empty() {
            version
        } else {
            format!("{version}+{fp}")
        }
    };

    // Home and the hidden lookup view can select the same reader concurrently.
    // Finish staging it before either caller starts loading its modules.
    static INSTALL: Mutex<()> = Mutex::new(());
    let _install = INSTALL.lock().unwrap();
    let mut versions: Map<String, Value> = fs::read_to_string(&versions_file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if versions.get(reader).and_then(Value::as_str) != Some(revision.as_str())
        || !target.join("manifest.json").exists()
    {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        if target.exists() {
            let _ = fs::remove_dir_all(&target);
        }
        copy_dir_recursive(&bundled, &target)?;
        if profile_yomitan && target.join("manifest_static.json").exists() {
            fs::copy(target.join("manifest_static.json"), target.join("manifest.json"))
                .map_err(|e| e.to_string())?;
        }
        versions.insert(reader.to_string(), Value::String(revision));
        let json_bytes = serde_json::to_vec_pretty(&Value::Object(versions)).map_err(|e| e.to_string())?;
        fs::write(&versions_file, json_bytes).map_err(|e| e.to_string())?;
    }

    Ok(target)
}

/// Safe metadata/index inspector for dictionary ZIP archives (ZipSlip-safe).
#[cfg(test)]
pub fn inspect_dictionary_zip(zip_path: &Path) -> Result<DictionaryZipSummary, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open dictionary archive {}: {e}", zip_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    let entry_count = archive.len();
    let mut total_uncompressed_bytes = 0u64;
    let mut format = "unknown".to_string();
    let mut title = None;
    let mut revision = None;

    for i in 0..entry_count {
        let mut entry = archive.by_index(i).map_err(|e| format!("Corrupt ZIP entry: {e}"))?;
        let Some(rel) = entry.enclosed_name().map(PathBuf::from) else {
            return Err("Archive contains unsafe path traversal entry".into());
        };
        total_uncompressed_bytes = total_uncompressed_bytes.saturating_add(entry.size());
        if rel == Path::new("index.json") && entry.size() <= 4 * 1024 * 1024 {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if let Ok(meta) = serde_json::from_slice::<Value>(&buf) {
                title = meta["title"].as_str().map(str::to_string);
                revision = meta["revision"].as_str().map(str::to_string);
                format = if meta.get("format").is_some() || meta.get("version").is_some() {
                    "yomitan".into()
                } else {
                    "json-dictionary".into()
                };
            }
        }
    }

    Ok(DictionaryZipSummary {
        entry_count,
        total_uncompressed_bytes,
        format,
        title,
        revision,
    })
}

pub fn browser_profile_dir(directory: &Path) -> PathBuf {
    directory.join("tauri-webview").join("EBWebView").join("Default")
}

fn copy_profile_tree(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() || target.exists() {
        return Ok(());
    }
    let parent = target.parent().ok_or("Invalid target profile path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage_name = format!(
        "{}.gsm-transfer",
        target
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("profile")
    );
    let stage = parent.join(stage_name);
    if stage.exists() {
        let _ = fs::remove_dir_all(&stage);
    }

    fn copy_filtered(src: &Path, dst: &Path) -> Result<(), String> {
        let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("Dictionary profile contains a symbolic link".into());
        }
        if meta.is_dir() {
            fs::create_dir_all(dst).map_err(|e| e.to_string())?;
            for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_name() == "LOCK" {
                    continue;
                }
                copy_filtered(&entry.path(), &dst.join(entry.file_name()))?;
            }
        } else if meta.is_file() {
            fs::copy(src, dst).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    copy_filtered(source, &stage)?;
    fs::rename(&stage, target).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn prepare_windows_profile(directory: &Path) -> Result<(), String> {
    let target = browser_profile_dir(directory);
    let marker = target.join(".gsm-extension-profile-v1");
    if marker.exists() {
        return Ok(());
    }
    for (folder, is_idb) in [("IndexedDB", true), ("Local Extension Settings", false)] {
        let source = directory.join(folder);
        if !source.exists() {
            continue;
        }
        let entries = fs::read_dir(&source).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let matches = if is_idb {
                is_legacy_indexeddb_dir(&name_str)
            } else {
                is_valid_extension_id(&name_str)
            };
            if !matches {
                continue;
            }
            copy_profile_tree(&entry.path(), &target.join(folder).join(&name))?;
        }
    }
    copy_profile_tree(&directory.join("File System"), &target.join("File System"))?;
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    fs::write(
        &marker,
        "Copied extension databases and settings; original profile retained.\n",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn is_legacy_indexeddb_dir(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("chrome-extension_") else {
        return false;
    };
    if rest.len() < 32 {
        return false;
    }
    let (id, suffix) = rest.split_at(32);
    is_valid_extension_id(id)
        && matches!(suffix, "_0.indexeddb.leveldb" | "_0.indexeddb.blob")
}

pub fn find_legacy_dictionary(
    session_directory: &Path,
    extension_id: &str,
    extension_path: &Path,
) -> Option<LegacySource> {
    let mut candidates = Vec::with_capacity(6);
    candidates.push(extension_id.to_string());
    for filename in ["manifest.json", "manifest_static.json"] {
        if let Ok(raw) = fs::read_to_string(extension_path.join(filename)) {
            let trimmed = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                if let Some(key) = val.get("key").and_then(Value::as_str) {
                    if let Ok(bytes) = STANDARD.decode(key) {
                        candidates.push(extension_id_from_bytes(&bytes));
                    }
                }
            }
        }
    }
    let location = canonical_path_for_hash(extension_path);
    candidates.push(extension_id_from_bytes(location.to_string_lossy().as_bytes()));
    #[cfg(windows)]
    {
        candidates.push(extension_id_from_bytes(&windows_extension_path_bytes(&location)));
    }

    let mut seen = HashSet::new();
    for id in candidates {
        if !seen.insert(id.clone()) || !is_valid_extension_id(&id) {
            continue;
        }
        let database = session_directory
            .join("IndexedDB")
            .join(format!("chrome-extension_{id}_0.indexeddb.leveldb"));
        let settings = session_directory
            .join("Local Extension Settings")
            .join(&id);
        if database.exists() || settings.exists() {
            return Some(LegacySource {
                id,
                database,
                settings,
                filesystem: None,
            });
        }
    }
    None
}

pub async fn discover_legacy(
    _app: &AppHandle,
    session_directory: &Path,
    extension_id: &str,
    extension_name: &str,
    extension_path: &Path,
) -> Result<Option<LegacySource>, String> {
    if let Some(source) = find_legacy_dictionary(session_directory, extension_id, extension_path) {
        return Ok(Some(source));
    }
    let kind = extension_kind(extension_name);
    let settings = session_directory.join("Local Extension Settings");
    if !settings.is_dir() || !matches!(kind, "yomitan" | "hachidori") {
        return Ok(None);
    }
    let directory = session_directory.to_owned();
    tokio::task::spawn_blocking(move || {
        let id = gsm_dictionary_transfer::identify(&settings, kind).map_err(|e| e.to_string())?;
        Ok(id.map(|id| LegacySource {
            database: directory.join("IndexedDB").join(format!("chrome-extension_{id}_0.indexeddb.leveldb")),
            settings: settings.join(&id),
            filesystem: None,
            id,
        }))
    }).await.map_err(|e| e.to_string())?
}

async fn run_legacy_export(
    app: &AppHandle,
    extension_id: &str,
    extension_name: &str,
    source: &LegacySource,
    destination: &Path,
) -> Result<(), String> {
    let source = source.clone();
    let destination = destination.to_owned();
    let (id, name) = (extension_id.to_owned(), extension_name.to_owned());
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        gsm_dictionary_transfer::export(&source.database, &source.settings, source.filesystem.as_deref(),
            &destination, &|phase, records| {
                handle.state::<DictionaryManager>().set_transfer(&handle, &id, &name, phase, records);
            }).map_err(|e| format!("Could not transfer saved {name} dictionaries: {e:#}"))
    }).await.map_err(|e| e.to_string())?
}

// ============================================================================
// Pure-Rust JavaScript Expression-Return Rewriter (page_script_body)
// Replaces `acorn` in `desktop-runtime/page-script.cjs` with zero Node cost.
// ============================================================================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TokKind {
    Ident,
    Number,
    String,
    TemplateWhole,
    TemplateHead,
    TemplateMid,
    TemplateTail,
    Regex,
    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Semi,
    Comma,
    Colon,
    Dot,
    Spread,
    OptionalChain,
    Question,
    Arrow,
    Assign,
    PlusPlus,
    MinusMinus,
    PrefixUnary,
    BinaryOp,
}

#[derive(Clone, Debug)]
struct Tok {
    kind: TokKind,
    start: usize,
    end: usize,
    newline_before: bool,
    keyword: Option<Kw>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kw {
    Async,
    Await,
    Break,
    Case,
    Catch,
    Class,
    Const,
    Continue,
    Debugger,
    Default,
    Delete,
    Do,
    Else,
    Export,
    False,
    Finally,
    For,
    Function,
    If,
    Import,
    In,
    Instanceof,
    Let,
    New,
    Null,
    Of,
    Return,
    Switch,
    This,
    Throw,
    True,
    Try,
    Typeof,
    Var,
    Void,
    While,
    With,
    Yield,
}

impl Kw {
    fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "async" => Self::Async,
            "await" => Self::Await,
            "break" => Self::Break,
            "case" => Self::Case,
            "catch" => Self::Catch,
            "class" => Self::Class,
            "const" => Self::Const,
            "continue" => Self::Continue,
            "debugger" => Self::Debugger,
            "default" => Self::Default,
            "delete" => Self::Delete,
            "do" => Self::Do,
            "else" => Self::Else,
            "export" => Self::Export,
            "false" => Self::False,
            "finally" => Self::Finally,
            "for" => Self::For,
            "function" => Self::Function,
            "if" => Self::If,
            "import" => Self::Import,
            "in" => Self::In,
            "instanceof" => Self::Instanceof,
            "let" => Self::Let,
            "new" => Self::New,
            "null" => Self::Null,
            "of" => Self::Of,
            "return" => Self::Return,
            "switch" => Self::Switch,
            "this" => Self::This,
            "throw" => Self::Throw,
            "true" => Self::True,
            "try" => Self::Try,
            "typeof" => Self::Typeof,
            "var" => Self::Var,
            "void" => Self::Void,
            "while" => Self::While,
            "with" => Self::With,
            "yield" => Self::Yield,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy)]
enum Delim {
    Paren { is_cond: bool },
    Bracket,
    BraceBlock,
    BraceExpr,
    TemplateExpr,
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'$' || b >= 0x80
}

fn is_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

fn tokenize_js(source: &str) -> Result<Vec<Tok>, String> {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;
    let mut tokens: Vec<Tok> = Vec::with_capacity(len / 5 + 8);
    let mut delims: Vec<Delim> = Vec::with_capacity(16);
    let mut regex_allowed = true;
    let mut pending_newline = false;

    while i < len {
        let b = bytes[i];
        // Whitespace
        if b == b' ' || b == b'\t' || b == 0x0b || b == 0x0c {
            i += 1;
            continue;
        }
        if b == b'\r' || b == b'\n' {
            pending_newline = true;
            i += 1;
            continue;
        }
        // Unicode line separators (U+2028, U+2029) and UTF-8 whitespace
        if b >= 0x80 {
            let ch = source[i..].chars().next().unwrap();
            if ch == '\u{2028}' || ch == '\u{2029}' {
                pending_newline = true;
                i += ch.len_utf8();
                continue;
            }
            if ch.is_whitespace() {
                i += ch.len_utf8();
                continue;
            }
        }
        // Comments
        if b == b'/' && i + 1 < len {
            if bytes[i + 1] == b'/' {
                i += 2;
                while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
                    if bytes[i] >= 0x80 {
                        let ch = source[i..].chars().next().unwrap();
                        if ch == '\u{2028}' || ch == '\u{2029}' {
                            break;
                        }
                        i += ch.len_utf8();
                    } else {
                        i += 1;
                    }
                }
                continue;
            }
            if bytes[i + 1] == b'*' {
                i += 2;
                let mut closed = false;
                while i + 1 < len {
                    if bytes[i] == b'\n' || bytes[i] == b'\r' {
                        pending_newline = true;
                    } else if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        i += 2;
                        closed = true;
                        break;
                    }
                    i += 1;
                }
                if !closed {
                    return Err("Unterminated block comment in script".into());
                }
                continue;
            }
        }

        let newline_before = pending_newline;
        pending_newline = false;

        // Strings
        if b == b'\'' || b == b'"' {
            let start = i;
            let quote = b;
            i += 1;
            let mut closed = false;
            while i < len {
                let c = bytes[i];
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == b'\n' || c == b'\r' {
                    return Err("Unterminated string literal in script".into());
                }
                if c == quote {
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err("Unterminated string literal in script".into());
            }
            tokens.push(Tok {
                kind: TokKind::String,
                start,
                end: i,
                newline_before,
                keyword: None,
            });
            regex_allowed = false;
            continue;
        }

        // Template literal start
        if b == b'`' {
            let start = i;
            i += 1;
            let (end, opened_expr) = scan_template_segment(bytes, &mut i)?;
            tokens.push(Tok {
                kind: if opened_expr {
                    TokKind::TemplateHead
                } else {
                    TokKind::TemplateWhole
                },
                start,
                end,
                newline_before,
                keyword: None,
            });
            if opened_expr {
                delims.push(Delim::TemplateExpr);
                regex_allowed = true;
            } else {
                regex_allowed = false;
            }
            continue;
        }

        // Regex literal when regex is allowed
        if b == b'/' && regex_allowed {
            let start = i;
            i += 1;
            let mut in_class = false;
            let mut closed = false;
            while i < len {
                let c = bytes[i];
                if c == b'\\' {
                    if i + 1 >= len || bytes[i + 1] == b'\n' || bytes[i + 1] == b'\r' {
                        return Err("Unterminated regular expression literal".into());
                    }
                    i += 2;
                    continue;
                }
                if c == b'\n' || c == b'\r' {
                    return Err("Unterminated regular expression literal".into());
                }
                if c == b'[' {
                    in_class = true;
                } else if c == b']' && in_class {
                    in_class = false;
                } else if c == b'/' && !in_class {
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err("Unterminated regular expression literal".into());
            }
            while i < len && bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            tokens.push(Tok {
                kind: TokKind::Regex,
                start,
                end: i,
                newline_before,
                keyword: None,
            });
            regex_allowed = false;
            continue;
        }

        // Numbers (including .5)
        if b.is_ascii_digit() || (b == b'.' && i + 1 < len && bytes[i + 1].is_ascii_digit()) {
            let start = i;
            if b == b'0' && i + 1 < len && matches!(bytes[i + 1], b'x' | b'X' | b'b' | b'B' | b'o' | b'O') {
                i += 2;
                while i < len && (bytes[i].is_ascii_hexdigit() || bytes[i] == b'_') {
                    i += 1;
                }
                if i < len && bytes[i] == b'n' {
                    i += 1;
                }
            } else {
                while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
                    i += 1;
                }
                if i < len && bytes[i] == b'.' && bytes.get(i + 1) != Some(&b'.') {
                    i += 1;
                    while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
                        i += 1;
                    }
                }
                if i < len && matches!(bytes[i], b'e' | b'E') {
                    i += 1;
                    if i < len && matches!(bytes[i], b'+' | b'-') {
                        i += 1;
                    }
                    while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
                        i += 1;
                    }
                }
                if i < len && bytes[i] == b'n' {
                    i += 1;
                }
            }
            tokens.push(Tok {
                kind: TokKind::Number,
                start,
                end: i,
                newline_before,
                keyword: None,
            });
            regex_allowed = false;
            continue;
        }

        // Private identifier `#foo` or identifier / keyword
        if b == b'#' || is_ident_start(b) {
            let start = i;
            if b == b'#' {
                i += 1;
            }
            while i < len && is_ident_continue(bytes[i]) {
                i += 1;
            }
            let ident = &source[start..i];
            let kw = Kw::from_str(ident);
            let prev_is_dot = tokens
                .last()
                .is_some_and(|t| matches!(t.kind, TokKind::Dot | TokKind::OptionalChain));
            regex_allowed = if !prev_is_dot {
                matches!(
                    kw,
                    Some(
                        Kw::Return
                            | Kw::Throw
                            | Kw::Case
                            | Kw::Delete
                            | Kw::Void
                            | Kw::Typeof
                            | Kw::Await
                            | Kw::Yield
                            | Kw::In
                            | Kw::Instanceof
                            | Kw::New
                            | Kw::Of
                            | Kw::Else
                            | Kw::Do
                            | Kw::Export
                            | Kw::Default
                    )
                )
            } else {
                false
            };
            tokens.push(Tok {
                kind: TokKind::Ident,
                start,
                end: i,
                newline_before,
                keyword: kw,
            });
            continue;
        }

        // Delimiters & multi-character punctuation
        let start = i;
        match b {
            b'(' => {
                let prev = tokens.last();
                let prev2 = tokens.len().checked_sub(2).and_then(|k| tokens.get(k));
                let after_dot = prev2.is_some_and(|t| matches!(t.kind, TokKind::Dot | TokKind::OptionalChain));
                let is_cond = !after_dot
                    && prev.is_some_and(|t| {
                        matches!(t.keyword, Some(Kw::If | Kw::While | Kw::For | Kw::With))
                    });
                delims.push(Delim::Paren { is_cond });
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::LParen,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = true;
            }
            b')' => {
                let matched = match delims.pop() {
                    Some(Delim::Paren { is_cond, .. }) => is_cond,
                    _ => return Err("Unexpected closing parenthesis".into()),
                };
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::RParen,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = matched;
            }
            b'[' => {
                delims.push(Delim::Bracket);
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::LBracket,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = true;
            }
            b']' => {
                match delims.pop() {
                    Some(Delim::Bracket) => {}
                    _ => return Err("Unexpected closing bracket".into()),
                }
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::RBracket,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = false;
            }
            b'{' => {
                let is_expr = !regex_allowed
                    || tokens.last().is_some_and(|t| {
                        matches!(
                            t.kind,
                            TokKind::Assign
                                | TokKind::LParen
                                | TokKind::LBracket
                                | TokKind::Comma
                                | TokKind::Question
                                | TokKind::Arrow
                                | TokKind::PrefixUnary
                                | TokKind::Spread
                        ) || matches!(
                            t.keyword,
                            Some(Kw::Return | Kw::Throw | Kw::Await | Kw::Yield)
                        )
                    });
                delims.push(if is_expr {
                    Delim::BraceExpr
                } else {
                    Delim::BraceBlock
                });
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::LBrace,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = true;
            }
            b'}' => {
                match delims.pop() {
                    Some(Delim::TemplateExpr) => {
                        i += 1;
                        let (end, opened_expr) = scan_template_segment(bytes, &mut i)?;
                        tokens.push(Tok {
                            kind: if opened_expr {
                                TokKind::TemplateMid
                            } else {
                                TokKind::TemplateTail
                            },
                            start,
                            end,
                            newline_before,
                            keyword: None,
                        });
                        if opened_expr {
                            delims.push(Delim::TemplateExpr);
                            regex_allowed = true;
                        } else {
                            regex_allowed = false;
                        }
                        continue;
                    }
                    Some(Delim::BraceBlock) => {
                        regex_allowed = true;
                    }
                    Some(Delim::BraceExpr) => {
                        regex_allowed = false;
                    }
                    _ => return Err("Unexpected closing brace".into()),
                }
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::RBrace,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
            }
            b';' => {
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::Semi,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = true;
            }
            b',' => {
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::Comma,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = true;
            }
            b':' => {
                i += 1;
                tokens.push(Tok {
                    kind: TokKind::Colon,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = true;
            }
            b'.' => {
                if bytes.get(i..i + 3) == Some(b"...") {
                    i += 3;
                    tokens.push(Tok {
                        kind: TokKind::Spread,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = true;
                } else {
                    i += 1;
                    tokens.push(Tok {
                        kind: TokKind::Dot,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = false;
                }
            }
            b'?' => {
                if bytes.get(i + 1) == Some(&b'.') && !bytes.get(i + 2).is_some_and(u8::is_ascii_digit) {
                    i += 2;
                    tokens.push(Tok {
                        kind: TokKind::OptionalChain,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = false;
                } else if bytes.get(i..i + 3) == Some(b"??=") {
                    i += 3;
                    tokens.push(Tok {
                        kind: TokKind::Assign,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = true;
                } else if bytes.get(i + 1) == Some(&b'?') {
                    i += 2;
                    tokens.push(Tok {
                        kind: TokKind::BinaryOp,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = true;
                } else {
                    i += 1;
                    tokens.push(Tok {
                        kind: TokKind::Question,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = true;
                }
            }
            b'=' => {
                if bytes.get(i + 1) == Some(&b'>') {
                    i += 2;
                    tokens.push(Tok {
                        kind: TokKind::Arrow,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = true;
                } else if bytes.get(i..i + 3) == Some(b"===") || bytes.get(i + 1) == Some(&b'=') {
                    i += if bytes.get(i..i + 3) == Some(b"===") { 3 } else { 2 };
                    tokens.push(Tok {
                        kind: TokKind::BinaryOp,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = true;
                } else {
                    i += 1;
                    tokens.push(Tok {
                        kind: TokKind::Assign,
                        start,
                        end: i,
                        newline_before,
                        keyword: None,
                    });
                    regex_allowed = true;
                }
            }
            b'+' | b'-' => {
                let kind = if bytes.get(i + 1) == Some(&b) {
                    i += 2;
                    if b == b'+' {
                        TokKind::PlusPlus
                    } else {
                        TokKind::MinusMinus
                    }
                } else if bytes.get(i + 1) == Some(&b'=') {
                    i += 2;
                    TokKind::Assign
                } else if regex_allowed {
                    i += 1;
                    TokKind::PrefixUnary
                } else {
                    i += 1;
                    TokKind::BinaryOp
                };
                tokens.push(Tok {
                    kind,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = !matches!(kind, TokKind::PlusPlus | TokKind::MinusMinus) || regex_allowed;
            }
            b'!' | b'~' => {
                let kind = if b == b'!' && bytes.get(i..i + 3) == Some(b"!==") {
                    i += 3;
                    TokKind::BinaryOp
                } else if b == b'!' && bytes.get(i + 1) == Some(&b'=') {
                    i += 2;
                    TokKind::BinaryOp
                } else {
                    i += 1;
                    TokKind::PrefixUnary
                };
                tokens.push(Tok {
                    kind,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = true;
            }
            b'*' | b'/' | b'%' | b'^' | b'&' | b'|' | b'<' | b'>' => {
                let mut kind = TokKind::BinaryOp;
                if bytes.get(i..i + 4) == Some(b">>>=") {
                    i += 4;
                    kind = TokKind::Assign;
                } else if bytes.get(i..i + 3) == Some(b">>>") {
                    i += 3;
                } else if matches!(
                    bytes.get(i..i + 3),
                    Some(b"**=" | b"<<=" | b">>=" | b"&&=" | b"||=")
                ) {
                    i += 3;
                    kind = TokKind::Assign;
                } else if matches!(
                    bytes.get(i..i + 2),
                    Some(b"**" | b"<<" | b">>" | b"<=" | b">=" | b"&&" | b"||")
                ) {
                    i += 2;
                } else if bytes.get(i + 1) == Some(&b'=') && matches!(b, b'*' | b'/' | b'%' | b'^' | b'&' | b'|') {
                    i += 2;
                    kind = TokKind::Assign;
                } else {
                    i += 1;
                }
                tokens.push(Tok {
                    kind,
                    start,
                    end: i,
                    newline_before,
                    keyword: None,
                });
                regex_allowed = true;
            }
            other => return Err(format!("Unexpected character '{}' in script", other as char)),
        }
    }

    if !delims.is_empty() {
        return Err("Unclosed delimiter in script".into());
    }
    Ok(tokens)
}

fn scan_template_segment(bytes: &[u8], i: &mut usize) -> Result<(usize, bool), String> {
    let len = bytes.len();
    while *i < len {
        let c = bytes[*i];
        if c == b'\\' {
            *i += 2;
            continue;
        }
        if c == b'`' {
            *i += 1;
            return Ok((*i, false));
        }
        if c == b'$' && *i + 1 < len && bytes[*i + 1] == b'{' {
            *i += 2;
            return Ok((*i, true));
        }
        *i += 1;
    }
    Err("Unterminated template literal in script".into())
}

fn can_end_expression(t: &Tok) -> bool {
    matches!(
        t.kind,
        TokKind::Ident
            | TokKind::Number
            | TokKind::String
            | TokKind::TemplateWhole
            | TokKind::TemplateTail
            | TokKind::Regex
            | TokKind::RParen
            | TokKind::RBracket
            | TokKind::RBrace
            | TokKind::PlusPlus
            | TokKind::MinusMinus
    ) && !matches!(
        t.keyword,
        Some(
            Kw::Return
                | Kw::Throw
                | Kw::Case
                | Kw::Delete
                | Kw::Void
                | Kw::Typeof
                | Kw::Await
                | Kw::Yield
                | Kw::New
                | Kw::Else
                | Kw::Do
        )
    )
}

fn can_continue_on_newline(prev: &Tok, cur: &Tok) -> bool {
    if matches!(
        cur.kind,
        TokKind::Dot
            | TokKind::OptionalChain
            | TokKind::LBracket
            | TokKind::LParen
            | TokKind::TemplateWhole
            | TokKind::TemplateHead
            | TokKind::BinaryOp
            | TokKind::Assign
            | TokKind::Question
            | TokKind::Colon
            | TokKind::Comma
            | TokKind::Arrow
    ) {
        return true;
    }
    if matches!(cur.keyword, Some(Kw::In | Kw::Instanceof)) {
        return true;
    }
    // Statement cannot split inside an unclosed prefix/binary operator
    if matches!(
        prev.kind,
        TokKind::Assign
            | TokKind::BinaryOp
            | TokKind::PrefixUnary
            | TokKind::Question
            | TokKind::Colon
            | TokKind::Comma
            | TokKind::Dot
            | TokKind::OptionalChain
            | TokKind::Arrow
            | TokKind::Spread
    ) || matches!(prev.keyword, Some(Kw::Await | Kw::New | Kw::Typeof | Kw::Void | Kw::Delete))
    {
        return true;
    }
    false
}

fn skip_balanced(tokens: &[Tok], mut idx: usize) -> usize {
    let mut depth = 0usize;
    while idx < tokens.len() {
        match tokens[idx].kind {
            TokKind::LParen | TokKind::LBracket | TokKind::LBrace | TokKind::TemplateHead => {
                depth += 1;
            }
            TokKind::RParen | TokKind::RBracket | TokKind::RBrace | TokKind::TemplateWhole => {}
            TokKind::TemplateTail => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            _ => {}
        }
        if matches!(
            tokens[idx].kind,
            TokKind::RParen | TokKind::RBracket | TokKind::RBrace
        ) {
            if depth > 0 {
                depth -= 1;
            }
        } else if matches!(tokens[idx].kind, TokKind::TemplateWhole) {
            // whole template doesn't change nesting
        }
        idx += 1;
        if depth == 0 {
            break;
        }
    }
    idx
}

enum LastStmt {
    None,
    Other,
    Expression {
        stmt_start: usize,
        expr_start: usize,
        expr_end: usize,
        stmt_end: usize,
    },
}

fn skip_expression(tokens: &[Tok], start: usize) -> usize {
    let mut i = start;
    let mut depth = 0usize;
    while i < tokens.len() {
        let tok = &tokens[i];
        if depth == 0 {
            if tok.kind == TokKind::Semi {
                return i;
            }
            if i > start && tok.newline_before {
                let prev = &tokens[i - 1];
                if can_end_expression(prev) && !can_continue_on_newline(prev, tok) {
                    return i;
                }
            }
        }
        match tok.kind {
            TokKind::LParen | TokKind::LBracket | TokKind::LBrace | TokKind::TemplateHead => {
                depth += 1;
            }
            TokKind::RParen | TokKind::RBracket | TokKind::RBrace | TokKind::TemplateTail => {
                if depth > 0 {
                    depth -= 1;
                } else {
                    return i;
                }
            }
            _ => {}
        }
        i += 1;
    }
    i
}

fn parse_one_statement(tokens: &[Tok], start: usize) -> (LastStmt, usize) {
    let cur = &tokens[start];
    if cur.kind == TokKind::Semi {
        return (LastStmt::Other, start + 1);
    }
    if cur.kind == TokKind::LBrace {
        return (LastStmt::Other, skip_balanced(tokens, start));
    }
    // Label: `ident:`
    if cur.kind == TokKind::Ident
        && cur.keyword.is_none()
        && tokens.get(start + 1).is_some_and(|t| t.kind == TokKind::Colon)
    {
        let (_inner, next) = if start + 2 < tokens.len() {
            parse_one_statement(tokens, start + 2)
        } else {
            (LastStmt::Other, start + 2)
        };
        return (LastStmt::Other, next);
    }

    let is_decl_or_ctrl = match cur.keyword {
        Some(Kw::Function | Kw::Class) => true,
        Some(Kw::Async) => tokens
            .get(start + 1)
            .is_some_and(|t| t.keyword == Some(Kw::Function) && !t.newline_before),
        Some(Kw::Let) => tokens.get(start + 1).is_some_and(|t| {
            matches!(t.kind, TokKind::Ident | TokKind::LBracket | TokKind::LBrace)
        }),
        Some(Kw::Const | Kw::Var) => true,
        Some(
            Kw::If
            | Kw::For
            | Kw::While
            | Kw::Switch
            | Kw::With
            | Kw::Do
            | Kw::Try
            | Kw::Throw
            | Kw::Return
            | Kw::Break
            | Kw::Continue
            | Kw::Debugger
            | Kw::Export,
        ) => true,
        Some(Kw::Import) => !tokens
            .get(start + 1)
            .is_some_and(|t| matches!(t.kind, TokKind::LParen | TokKind::Dot)),
        _ => false,
    };

    if is_decl_or_ctrl {
        let mut i = start;
        match cur.keyword {
            Some(Kw::If) => {
                i += 1;
                if tokens.get(i).is_some_and(|t| t.kind == TokKind::LParen) {
                    i = skip_balanced(tokens, i);
                }
                if i < tokens.len() {
                    i = parse_one_statement(tokens, i).1;
                }
                if tokens.get(i).is_some_and(|t| t.keyword == Some(Kw::Else)) {
                    i += 1;
                    if i < tokens.len() {
                        i = parse_one_statement(tokens, i).1;
                    }
                }
                return (LastStmt::Other, i);
            }
            Some(Kw::For) => {
                i += 1;
                if tokens.get(i).is_some_and(|t| t.keyword == Some(Kw::Await)) {
                    i += 1;
                }
                if tokens.get(i).is_some_and(|t| t.kind == TokKind::LParen) {
                    i = skip_balanced(tokens, i);
                }
                if i < tokens.len() {
                    i = parse_one_statement(tokens, i).1;
                }
                return (LastStmt::Other, i);
            }
            Some(Kw::While | Kw::With) => {
                i += 1;
                if tokens.get(i).is_some_and(|t| t.kind == TokKind::LParen) {
                    i = skip_balanced(tokens, i);
                }
                if i < tokens.len() {
                    i = parse_one_statement(tokens, i).1;
                }
                return (LastStmt::Other, i);
            }
            Some(Kw::Switch) => {
                i += 1;
                if tokens.get(i).is_some_and(|t| t.kind == TokKind::LParen) {
                    i = skip_balanced(tokens, i);
                }
                if tokens.get(i).is_some_and(|t| t.kind == TokKind::LBrace) {
                    i = skip_balanced(tokens, i);
                }
                return (LastStmt::Other, i);
            }
            Some(Kw::Do) => {
                i += 1;
                if i < tokens.len() {
                    i = parse_one_statement(tokens, i).1;
                }
                if tokens.get(i).is_some_and(|t| t.keyword == Some(Kw::While)) {
                    i += 1;
                    if tokens.get(i).is_some_and(|t| t.kind == TokKind::LParen) {
                        i = skip_balanced(tokens, i);
                    }
                    if tokens.get(i).is_some_and(|t| t.kind == TokKind::Semi) {
                        i += 1;
                    }
                }
                return (LastStmt::Other, i);
            }
            Some(Kw::Try) => {
                i += 1;
                if tokens.get(i).is_some_and(|t| t.kind == TokKind::LBrace) {
                    i = skip_balanced(tokens, i);
                }
                if tokens.get(i).is_some_and(|t| t.keyword == Some(Kw::Catch)) {
                    i += 1;
                    if tokens.get(i).is_some_and(|t| t.kind == TokKind::LParen) {
                        i = skip_balanced(tokens, i);
                    }
                    if tokens.get(i).is_some_and(|t| t.kind == TokKind::LBrace) {
                        i = skip_balanced(tokens, i);
                    }
                }
                if tokens.get(i).is_some_and(|t| t.keyword == Some(Kw::Finally)) {
                    i += 1;
                    if tokens.get(i).is_some_and(|t| t.kind == TokKind::LBrace) {
                        i = skip_balanced(tokens, i);
                    }
                }
                return (LastStmt::Other, i);
            }
            Some(Kw::Function | Kw::Async | Kw::Class) => {
                while i < tokens.len() {
                    if tokens[i].kind == TokKind::LParen {
                        i = skip_balanced(tokens, i);
                        continue;
                    }
                    if tokens[i].kind == TokKind::LBrace {
                        i = skip_balanced(tokens, i);
                        return (LastStmt::Other, i);
                    }
                    i += 1;
                }
                return (LastStmt::Other, i);
            }
            _ => {
                // var/let/const/return/throw/break/continue/debugger/import/export
                let mut end = skip_expression(tokens, start);
                if tokens.get(end).is_some_and(|t| t.kind == TokKind::Semi) {
                    end += 1;
                }
                return (LastStmt::Other, end);
            }
        }
    }

    let expr_end_tok = skip_expression(tokens, start);
    let stmt_start = tokens[start].start;
    let expr_start = tokens[start].start;
    let expr_end = if expr_end_tok > start {
        tokens[expr_end_tok - 1].end
    } else {
        expr_start
    };
    let mut next = expr_end_tok;
    let stmt_end = if tokens.get(next).is_some_and(|t| t.kind == TokKind::Semi) {
        let e = tokens[next].end;
        next += 1;
        e
    } else {
        expr_end
    };
    (
        LastStmt::Expression {
            stmt_start,
            expr_start,
            expr_end,
            stmt_end,
        },
        next,
    )
}

/// Rewrite the final top-level JavaScript `ExpressionStatement` into `return (<expr>);`.
/// Matches `desktop-runtime/page-script.cjs::pageScriptBody`.
pub fn page_script_body(source: &str) -> Result<String, String> {
    let tokens = tokenize_js(source)?;
    let mut i = 0usize;
    let mut last = LastStmt::None;
    while i < tokens.len() {
        let (stmt, next) = parse_one_statement(&tokens, i);
        last = stmt;
        if next <= i {
            i += 1;
        } else {
            i = next;
        }
    }
    match last {
        LastStmt::Expression {
            stmt_start,
            expr_start,
            expr_end,
            stmt_end,
        } => {
            let mut out = String::with_capacity(source.len() + 16);
            out.push_str(&source[..stmt_start]);
            out.push_str("return (");
            out.push_str(&source[expr_start..expr_end]);
            out.push_str(");");
            out.push_str(&source[stmt_end..]);
            Ok(out)
        }
        LastStmt::None | LastStmt::Other => Ok(source.to_string()),
    }
}

pub fn page_script_body_lossy(source: &str) -> String {
    page_script_body(source).unwrap_or_else(|_| source.to_string())
}

// ============================================================================
// Evaluation & Window Creation Helpers
// ============================================================================

#[cfg(windows)]
async fn wait_for_chrome_extension_url(window: &WebviewWindow) {
    for _ in 0..400 {
        if window
            .url()
            .is_ok_and(|url| url.scheme() == "chrome-extension")
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub async fn evaluate_raw(
    app: &AppHandle,
    window: &WebviewWindow,
    source: &str,
) -> Result<Value, String> {
    let wrapped = page_script_body_lossy(source);
    #[cfg(windows)]
    if window
        .url()
        .is_ok_and(|url| url.scheme() == "chrome-extension")
        || (use_windows_native_extensions()
            && app
                .state::<crate::desktop_state::DesktopState>()
                .window_scope(window.label())
                .as_deref()
                == Some("dictionary"))
    {
        wait_for_chrome_extension_url(window).await;
        return crate::browser_extensions::evaluate(window, wrapped).await;
    }
    app.state::<crate::desktop_state::DesktopState>()
        .evaluate(window, &wrapped)
        .await
}

pub async fn evaluate_page_script(
    app: &AppHandle,
    window: &WebviewWindow,
    source: &str,
) -> Result<Value, String> {
    let wrapped = page_script_body(source)?;
    #[cfg(windows)]
    if window
        .url()
        .is_ok_and(|url| url.scheme() == "chrome-extension")
        || (use_windows_native_extensions()
            && app
                .state::<crate::desktop_state::DesktopState>()
                .window_scope(window.label())
                .as_deref()
                == Some("dictionary"))
    {
        wait_for_chrome_extension_url(window).await;
        return crate::browser_extensions::evaluate(window, wrapped).await;
    }
    app.state::<crate::desktop_state::DesktopState>()
        .evaluate(window, &wrapped)
        .await
}

pub(crate) fn apply_shared_webview_options<'a>(
    mut builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    builder = builder
        .disable_drag_drop_handler()
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    #[cfg(windows)]
    {
        builder = builder
            .browser_extensions_enabled(true)
            .additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required",
            );
    }
    builder
}

pub fn apply_profile_data_directory<'a>(
    mut builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    profile: &Path,
) -> Result<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>, String> {
    let dir = profile.join("tauri-webview");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.data_directory(dir);
    }
    #[cfg(target_os = "macos")]
    {
        let hash = Sha256::digest(dir.to_string_lossy().as_bytes());
        let mut id = [0u8; 16];
        id.copy_from_slice(&hash[..16]);
        builder = builder.data_store_identifier(id);
    }
    Ok(builder)
}

fn build_desktop_preload(token: &str, extra_preload: Option<&str>) -> String {
    let base = crate::overlay_preload::render_desktop_preload(token);
    match extra_preload {
        Some(extra) if !extra.is_empty() => format!("{base}\n;{extra}"),
        _ => base,
    }
}

fn legacy_import_script(base_url: &str, browser_filesystem: bool) -> String {
    let body = LEGACY_IMPORT_MODULE_JS.replace(
        "export async function importLegacyDictionary(",
        "async function importLegacyDictionary(",
    );
    let base_json = json!(base_url).to_string();
    format!(
        "(() => {{\n{body}\nglobalThis.__GSM_TRANSFER__ = {{ status: 'running', records: 0 }};\nvoid importLegacyDictionary({base_json}, {browser_filesystem}).then(result => {{ globalThis.__GSM_TRANSFER__ = {{ status: 'complete', result }}; }}, error => {{ globalThis.__GSM_TRANSFER__ = {{ status: 'failed', error: String(error) }}; }});\n}})()"
    )
}

fn current_iso_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}

impl DictionaryManager {
    /// Release per-document routing/attachment state when a view is destroyed.
    /// Shared engines and persistent dictionary storage belong to the app.
    pub fn forget_window(&self, app: &AppHandle, label: &str) {
        self.home_reader_ext.lock().unwrap().remove(label);
        self.home_reader_windows.lock().unwrap().remove(label);
        self.contexts.lock().unwrap().remove(label);
        self.content_contexts.lock().unwrap().retain(|(owner, _), _| owner != label);
        let disconnected: Vec<_> = {
            let mut ports = self.ports.lock().unwrap();
            let ids: Vec<_> = ports.iter().filter(|(_, port)| port.source.label == label || port.targets.iter().any(|target| target.label == label)).map(|(id, _)| id.clone()).collect();
            ids.into_iter().filter_map(|id| ports.remove(&id).map(|port| (id, port))).collect()
        };
        for (id, port) in disconnected {
            for recipient in std::iter::once(port.source).chain(port.targets).filter(|r| r.label != label) {
                if let Some(window) = app.get_webview_window(&recipient.label) {
                    let _ = window.eval(&format!("globalThis.__GSM_DICTIONARY_DISPATCH__?.({}, 'port-disconnect', {}, {})", json!(recipient.extension_id), json!([id, Value::Null]), recipient.frame));
                }
            }
        }
    }

    pub fn list_transfers(&self) -> Vec<Value> {
        self.transfers
            .lock()
            .unwrap()
            .values()
            .map(|t| json!(t))
            .collect()
    }

    pub fn set_transfer(&self, app: &AppHandle, id: &str, name: &str, phase: &str, records: u64) {
        self.transfers.lock().unwrap().insert(
            id.to_string(),
            TransferProgress {
                name: name.to_string(),
                phase: phase.to_string(),
                records,
            },
        );
        crate::desktop_state::emit_to_desktop_windows(app, "reader.dictionaryTransfersChanged", &[]);
    }

    pub fn clear_transfer(&self, app: &AppHandle, id: &str) {
        if self.transfers.lock().unwrap().remove(id).is_some() {
            crate::desktop_state::emit_to_desktop_windows(app, "reader.dictionaryTransfersChanged", &[]);
        }
    }

    pub(crate) fn get_home_reader_extension(&self, label: &str) -> Option<String> {
        self.home_reader_ext.lock().unwrap().get(label).cloned()
    }

    pub(crate) fn invalidate_reader_attachments(&self) {
        self.home_reader_ext.lock().unwrap().clear();
    }

    fn set_home_reader_extension(&self, label: &str, extension_id: &str) {
        self.home_reader_ext
            .lock()
            .unwrap()
            .insert(label.to_string(), extension_id.to_string());
    }

    pub fn mark_home_reader_window(&self, label: &str, enable: bool) {
        let mut set = self.home_reader_windows.lock().unwrap();
        if enable {
            set.insert(label.to_string());
        } else {
            set.remove(label);
        }
    }

    pub fn portable_preload_for_config(&self, config: &Value) -> String {
        let serialized = config.to_string();
        format!(
            "\n;{}",
            DICTIONARY_PRELOAD_TEMPLATE.replace("__GSM_DICTIONARY_CONFIG__", &serialized)
        )
    }

    fn known_portable_extensions_config(&self) -> Vec<Value> {
        self.portable_extensions
            .lock()
            .unwrap()
            .values()
            .map(|ext| {
                json!({
                    "id": ext.id,
                    "base": ext.base,
                    "manifest": ext.manifest,
                })
            })
            .collect()
    }

    fn portable_config_for(
        &self,
        ext: &LoadedExtension,
        kind: &str,
        url: &str,
        window_id: u64,
    ) -> Value {
        let effective_url = if kind == "background" {
            let entry = ext.manifest["background"]["service_worker"]
                .as_str()
                .or_else(|| ext.manifest["background"]["page"].as_str())
                .unwrap_or("background.js");
            format!("{}/{entry}", ext.base)
        } else {
            url.to_string()
        };
        json!({
            "id": ext.id,
            "manifest": ext.manifest,
            "base": ext.base,
            "kind": kind,
            "hostOrigin": crate::assets::origin(),
            "windowId": window_id,
            "url": effective_url,
            "extensions": self.known_portable_extensions_config(),
        })
    }

    pub fn portable_preload_for_window(
        &self,
        label: &str,
        ext: &LoadedExtension,
        url: &str,
        window_id: u64,
    ) -> String {
        let kind = {
            let mut contexts = self.contexts.lock().unwrap();
            let entry = contexts.entry(label.to_string()).or_insert_with(|| {
                ExtensionContext {
                    extension_id: ext.id.clone(),
                    kind: "tab".into(),
                    url: url.to_string(),
                }
            });
            entry.kind.clone()
        };
        let config = self.portable_config_for(ext, &kind, url, window_id);
        self.portable_preload_for_config(&config)
    }

    pub fn portable_extension_for_url(&self, raw_url: &str) -> Option<LoadedExtension> {
        let map = self.portable_extensions.lock().unwrap();
        if raw_url.starts_with("chrome-extension:") {
            let parsed = url::Url::parse(raw_url).ok()?;
            let id = parsed.host_str()?;
            return map.get(id).cloned();
        }
        map.values()
            .find(|ext| raw_url.starts_with(&format!("{}/", ext.base)))
            .cloned()
    }

    #[allow(dead_code)]
    pub fn find_extension_for_url_any(&self, raw_url: &str) -> Option<LoadedExtension> {
        if let Some(ext) = self.portable_extension_for_url(raw_url) {
            return Some(ext);
        }
        let map = self.windows_extensions.lock().unwrap();
        if let Ok(parsed) = url::Url::parse(raw_url) {
            if parsed.scheme() == "chrome-extension" {
                if let Some(host) = parsed.host_str() {
                    if let Some(ext) = map.get(host) {
                        return Some(ext.clone());
                    }
                }
            }
        }
        map.values()
            .find(|ext| raw_url.starts_with(&format!("{}/", ext.base)))
            .cloned()
    }

    #[allow(dead_code)]
    pub fn find_window_with_url_prefix(&self, app: &AppHandle, prefix: &str) -> Option<WebviewWindow> {
        app.webview_windows().into_values().find(|win| {
            win.url()
                .ok()
                .is_some_and(|u| u.as_str().starts_with(prefix))
        })
    }

    fn create_managed_window(
        &self,
        app: &AppHandle,
        label: &str,
        raw_url: &str,
        title: &str,
        width: f64,
        height: f64,
        show: bool,
        profile: &Path,
        scope: &str,
        extra_preload: Option<&str>,
    ) -> Result<WebviewWindow, String> {
        if let Some(existing) = app.get_webview_window(label) {
            return Ok(existing);
        }
        let desktop = app.state::<crate::desktop_state::DesktopState>();
        let parsed = desktop.assets.url(raw_url)?;
        let token = desktop.register_window(label, scope);

        let visible = show && !(cfg!(debug_assertions) && std::env::var_os("GSM_SMOKE_TEST").is_some());
        let focused = visible && std::env::var_os("GSM_SMOKE_TEST").is_none();

        let mut builder = apply_shared_webview_options(
            WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
                .title(title)
                .inner_size(width, height)
                .visible(visible)
                .focused(focused),
        );

        let preload = build_desktop_preload(&token, extra_preload);
        builder = builder.initialization_script_for_all_frames(preload);
        builder = apply_profile_data_directory(builder, profile)?;

        let dl_app = app.clone();
        let dl_label = label.to_string();
        builder = builder
            .on_download(move |_webview, event| {
                use tauri::webview::DownloadEvent;
                match event {
                    DownloadEvent::Requested { url, destination } => {
                        let filename = destination
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "dictionary-backup.zip".into());
                        let selected = if cfg!(debug_assertions)
                            && std::env::var_os("GSM_SMOKE_TEST").is_some()
                        {
                            std::env::var_os("GSM_PROFILE_DIR")
                                .map(|profile| PathBuf::from(profile).join(&filename))
                        } else {
                            rfd::FileDialog::new().set_file_name(&filename).save_file()
                        };
                        if let Some(path) = selected {
                            *destination = path;
                            true
                        } else {
                            on_download_event(&dl_app, &dl_label, &url.to_string(), None, false);
                            false
                        }
                    }
                    DownloadEvent::Finished { url, path, success } => {
                        on_download_event(
                            &dl_app,
                            &dl_label,
                            &url.to_string(),
                            path.as_deref(),
                            success,
                        );
                        true
                    }
                    _ => true,
                }
            })
            .on_navigation(|url| {
                crate::assets::trusted(url)
                    || matches!(
                        url.scheme(),
                        "chrome-extension" | "http" | "https" | "about" | "data" | "blob"
                    )
            })
            .on_new_window(|url, _| {
                if matches!(url.scheme(), "http" | "https") && !crate::assets::trusted(&url) {
                    let _ = crate::native::shell_open_external(url.as_str());
                }
                tauri::webview::NewWindowResponse::Deny
            });

        let window = builder.build().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        if use_windows_native_extensions() {
            crate::jiten_webview::install(app, &window, label == EXTENSION_CONTROLLER_LABEL)?;
        }
        let cleanup_app = app.clone();
        let cleanup_label = label.to_string();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(desktop) = cleanup_app.try_state::<crate::desktop_state::DesktopState>() {
                    desktop.unregister_window(&cleanup_label);
                }
            }
        });
        Ok(window)
    }

    pub async fn ensure_windows_controller(
        &self,
        app: &AppHandle,
        overlay_data: &Path,
    ) -> Result<WebviewWindow, String> {
        if let Some(win) = app.get_webview_window(EXTENSION_CONTROLLER_LABEL) {
            return Ok(win);
        }
        // If another native window on the overlay profile is already open, we can still
        // use or create our dedicated hidden controller window on the same data_directory.
        self.create_managed_window(
            app,
            EXTENSION_CONTROLLER_LABEL,
            "about:blank",
            "GSM Extension Controller",
            1.0,
            1.0,
            false,
            overlay_data,
            "dictionary",
            None,
        )
    }

    pub async fn load_windows_extension(
        &self,
        app: &AppHandle,
        directory: &Path,
    ) -> Result<LoadedExtension, String> {
        let _guard = self.windows_lock.lock().await;

        #[cfg(not(windows))]
        {
            let _ = (app, directory);
            return Err("WebView2 native extensions are only supported on Windows".into());
        }

        #[cfg(windows)]
        {
            let overlay_data = overlay_data_path(app);
            let canonical_source = canonical_path_for_hash(directory);
            let mut manifest = read_manifest(&canonical_source)?;
            let name = manifest["name"]
                .as_str()
                .unwrap_or("Dictionary")
                .to_string();
            let version = manifest["version"]
                .as_str()
                .unwrap_or_default()
                .to_string();

            let state_root = overlay_data.join("native-dictionaries");
            let kind = extension_kind(&name);
            let imports = state_root.join("browser-imports");
            let imported = self.browser_import_selection(app)[kind]
                .as_str()
                .filter(|id| crate::browser_dictionary::valid_id(id))
                .map(|id| imports.join(id).join("extension"))
                .filter(|dir| dir.join("manifest.json").is_file());
            let matches_selection = |ext: &LoadedExtension| {
                ext.source_path == canonical_source && ext.version == version && match &imported {
                    Some(path) => &ext.path == path,
                    None => !ext.path.starts_with(&imports),
                }
            };
            if let Some(existing) = self.windows_extensions.lock().unwrap().values()
                .find(|ext| matches_selection(ext)).cloned() {
                return Ok(existing);
            }

            prepare_windows_profile(&overlay_data)?;
            let controller = self
                .ensure_windows_controller(app, &overlay_data)
                .await
                .map_err(|e| format!("ensure_windows_controller: {e}"))?;
            let inactive = self.inactive_reader.lock().unwrap().as_ref()
                .filter(|ext| matches_selection(ext)).cloned();
            if let Some(ext) = inactive {
                // Adding the folder again reinstalls it. Re-enable the existing
                // registration so a live switch preserves its service worker.
                let installed = crate::browser_extensions::list(&controller).await?;
                if installed.as_array().is_some_and(|list| list.iter().any(|item| item["id"] == ext.id)) {
                    crate::browser_extensions::enable(&controller, ext.id.clone(), true).await?;
                    self.select_windows_extension(app, &controller, &ext).await?;
                    return Ok(ext);
                }
            }
            let mut active_dir = canonical_source.clone();
            let mut expected = extension_id_for_directory(&active_dir, &manifest, true);
            let legacy = if imported.is_none() {
                discover_legacy(app, &overlay_data, &expected, &name, &active_dir).await?
            } else {
                None
            };
            let pinned_source = if kind == "yomitan" && imported.is_none() {
                fs::read_to_string(state_root.join("yomitan-local-path.txt"))
                    .ok()
                    .map(|path| PathBuf::from(path.trim()))
                    .filter(|path| path.is_absolute() && *path != canonical_source)
                    .filter(|path| {
                        let id = extension_id_for_directory(path, &manifest, true);
                        browser_profile_dir(&overlay_data)
                            .join("IndexedDB")
                            .join(format!("chrome-extension_{id}_0.indexeddb.leveldb"))
                            .join("CURRENT")
                            .is_file()
                    })
            } else {
                None
            };
            // Chromium hashes the full path for an unkeyed extension. Keep its
            // old code path while opening the dictionary storage from the new profile.
            let retained_stage = (imported.is_none() && pinned_source.is_none() && manifest["key"].is_null()
                && matches!(kind, "yomitan" | "hachidori"))
                .then(|| gsm_packages::overlay_directory::migration_source(&overlay_data))
                .flatten()
                .and_then(|old_overlay| {
                    let folder = if kind == "yomitan" { "yomitan".as_ref() } else { canonical_source.file_name()? };
                    let directory = old_overlay.join("native-dictionaries/extensions").join(folder);
                    let id = extension_id_for_directory(&directory, &manifest, true);
                    let browser_profile = browser_profile_dir(&overlay_data);
                    let (database, settings) = crate::browser_dictionary::storage_paths(&browser_profile, &id);
                    let pending = state_root.join("transfers").join(format!("{id}.json")).is_file();
                    (pending || database.join("CURRENT").is_file() || settings.join("CURRENT").is_file())
                        .then_some((directory, pending))
                });
            let use_existing_storage = matches!(&retained_stage, Some((_, false)));
            let mut staged = false;
            if let Some(path) = imported {
                active_dir = path;
                manifest["key"] = read_manifest(&active_dir)?["key"].clone();
                staged = true;
            } else if let Some(path) = pinned_source {
                active_dir = path;
                copy_dir_recursive(&canonical_source, &active_dir)?;
                expected = extension_id_for_directory(&active_dir, &manifest, true);
            } else if let Some((path, _)) = retained_stage {
                active_dir = path;
                staged = true;
            } else if kind == "yomitan" {
                let stable_dir = state_root.join("extensions").join("yomitan");
                let old_staged_id = extension_id_for_directory(&stable_dir, &manifest, true);
                let installed = crate::browser_extensions::list(&controller).await?;
                let is_installed = |id: &str| {
                    installed.as_array().is_some_and(|items| {
                        items.iter().any(|extension| extension["id"].as_str() == Some(id))
                    })
                };
                // Keep the destination for profiles that previously loaded the
                // unkeyed extension or began a transfer to that origin.
                let uses_old_stage = is_installed(&old_staged_id)
                    || state_root.join(format!("{old_staged_id}-legacy-transfer.json")).is_file()
                    || state_root.join("transfers").join(format!("{old_staged_id}.json")).is_file();
                if uses_old_stage || !is_installed(&expected) {
                    active_dir = stable_dir;
                    staged = true;
                    if !uses_old_stage && manifest["key"].is_null() {
                        manifest["key"] = json!(YOMITAN_PUBLIC_KEY);
                    }
                }
            } else if kind == "jiten" && std::env::var_os("GSM_SMOKE_TEST").is_some() {
                active_dir =
                    crate::smoke_test::stage_jiten_extension(&canonical_source, &overlay_data)?;
            } else if legacy.as_ref().is_some_and(|source| source.id != expected) {
                let folder_name = canonical_source
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "dictionary".into());
                active_dir = state_root.join("extensions").join(folder_name);
                staged = true;
            }
            if staged {
                copy_dir_recursive(&canonical_source, &active_dir)?;
                expected = extension_id_for_directory(&active_dir, &manifest, true);
            }
            let marker = state_root.join(format!("{expected}-legacy-transfer.json"));
            let marker_format = fs::read_to_string(&marker)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v["format"].as_u64())
                .unwrap_or(0);
            let relocated = staged
                && !use_existing_storage
                && legacy.as_ref().is_some_and(|source| source.id != expected)
                && marker_format < 4;
            let direct_clone = relocated && kind == "yomitan";
            if direct_clone {
                if let Ok(list) = crate::browser_extensions::list(&controller).await {
                    if list.as_array().is_some_and(|items| {
                        items
                            .iter()
                            .any(|item| item["id"].as_str() == Some(expected.as_str()))
                    }) {
                        let _ =
                            crate::browser_extensions::enable(&controller, expected.clone(), false)
                                .await;
                    }
                }
                self.clone_windows_chromium_dictionary(
                    app,
                    &overlay_data,
                    &state_root,
                    &expected,
                    &name,
                    legacy.as_ref().unwrap(),
                )
                .await
                .map_err(|e| format!("clone_windows_chromium_dictionary(relocated): {e}"))?;
            }
            if staged {
                let active_manifest = if relocated && !direct_clone {
                    let mut transfer_manifest = json!({
                        "manifest_version": 3,
                        "name": manifest["name"],
                        "version": manifest["version"],
                        "permissions": ["storage", "unlimitedStorage"],
                        "host_permissions": ["http://gsm.localhost/*"],
                    });
                    if let Some(key) = manifest.get("key") {
                        transfer_manifest["key"] = key.clone();
                    }
                    fs::write(
                        active_dir.join("gsm-transfer.html"),
                        "<!doctype html><title>GSM dictionary transfer</title>",
                    )
                    .map_err(|e| e.to_string())?;
                    transfer_manifest
                } else {
                    if direct_clone {
                        fs::write(
                            active_dir.join("gsm-transfer.html"),
                            "<!doctype html><title>GSM dictionary transfer</title>",
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    manifest.clone()
                };
                fs::write(active_dir.join("manifest.json"), active_manifest.to_string())
                    .map_err(|e| e.to_string())?;
            }
            // A browser import disables its temporary transfer extension before
            // replacing the manifest. AddBrowserExtension can report an enabled
            // result while the profile still retains that disabled registration.
            let registrations = crate::browser_extensions::list(&controller).await?;
            let was_disabled = registrations.as_array().is_some_and(|items| {
                items.iter().any(|item| item["id"] == expected && item["enabled"] == false)
            });
            let mut installed = crate::browser_extensions::load(
                &controller,
                active_dir.to_string_lossy().into_owned(),
            )
            .await
            .map_err(|e| {
                format!(
                    "browser_extensions::load(initial, relocated={relocated}, dir={}): {e}",
                    active_dir.display()
                )
            })?;
            let installed_id = installed["id"]
                .as_str()
                .ok_or("Browser extension did not return an ID")?
                .to_string();
            if installed_id != expected {
                return Err("Browser extension identity changed unexpectedly".into());
            }
            app.state::<crate::desktop_state::DesktopState>()
                .assets
                .3
                .lock()
                .unwrap()
                .insert(installed_id.clone());

            if relocated && !direct_clone {
                let placeholder = LoadedExtension {
                    id: installed_id.clone(),
                    name: name.clone(),
                    version: version.clone(),
                    path: active_dir.clone(),
                    source_path: canonical_source.clone(),
                    manifest: manifest.clone(),
                    base: format!("chrome-extension://{installed_id}"),
                };
                self.migrate_windows_legacy(
                    app,
                    &overlay_data,
                    &state_root,
                    &placeholder,
                    legacy.as_ref(),
                )
                .await
                .map_err(|e| format!("migrate_windows_legacy(relocated): {e}"))?;
                fs::write(active_dir.join("manifest.json"), manifest.to_string())
                    .map_err(|e| e.to_string())?;
                installed = crate::browser_extensions::load(
                    &controller,
                    active_dir.to_string_lossy().into_owned(),
                )
                .await
                .map_err(|e| format!("browser_extensions::load(post-relocate): {e}"))?;
            }

            if was_disabled || installed["enabled"] != true {
                crate::browser_extensions::enable(&controller, installed_id.clone(), true)
                    .await
                    .map_err(|e| format!("browser_extensions::enable: {e}"))?;
            }
            let loaded = LoadedExtension {
                id: installed_id.clone(),
                name: installed["name"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or(name),
                version,
                path: active_dir,
                source_path: canonical_source,
                manifest,
                base: format!("chrome-extension://{installed_id}"),
            };
            self.select_windows_extension(app, &controller, &loaded).await?;
            Ok(loaded)
        }
    }

    #[cfg(windows)]
    async fn select_windows_extension(
        &self, app: &AppHandle, controller: &WebviewWindow, selected: &LoadedExtension,
    ) -> Result<(), String> {
        let desktop = app.state::<crate::desktop_state::DesktopState>();
        if matches!(extension_kind(&selected.name), "yomitan" | "hachidori") {
            let list = crate::browser_extensions::list(controller).await?;
            for other in list.as_array().into_iter().flatten() {
                let Some(id) = other["id"].as_str() else { continue };
                if id == selected.id || other["enabled"] != true
                    || !matches!(extension_kind(other["name"].as_str().unwrap_or_default()), "yomitan" | "hachidori") {
                    continue;
                }
                crate::browser_extensions::enable(controller, id.to_owned(), false).await?;
                if let Some(previous) = self.windows_extensions.lock().unwrap().remove(id) {
                    *self.inactive_reader.lock().unwrap() = Some(previous);
                }
                self.hachidori_engine_ready.lock().unwrap().remove(id);
                desktop.assets.3.lock().unwrap().remove(id);
            }
        }
        desktop.assets.3.lock().unwrap().insert(selected.id.clone());
        self.windows_extensions.lock().unwrap().insert(selected.id.clone(), selected.clone());
        Ok(())
    }

    pub async fn load_portable_extension(
        &self,
        app: &AppHandle,
        directory: &Path,
    ) -> Result<LoadedExtension, String> {
        let _guard = self.portable_lock.lock().await;
        let canonical = canonical_path_for_hash(directory);
        let manifest = read_manifest(&canonical)?;
        let id = extension_id_for_directory(&canonical, &manifest, false);
        if let Some(existing) = self.portable_extensions.lock().unwrap().get(&id).cloned() {
            return Ok(existing);
        }

        let name = manifest["name"]
            .as_str()
            .unwrap_or("Dictionary")
            .to_string();
        let version = manifest["version"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let kind = extension_kind(&name);

        let assets = app.state::<crate::desktop_state::DesktopState>().assets.clone();
        assets.mount(&id, &canonical)?;
        let base = assets.mount_dictionary(&id, kind)?;

        let extension = LoadedExtension {
            id: id.clone(),
            name,
            version,
            path: canonical.clone(),
            source_path: canonical,
            manifest: manifest.clone(),
            base: base.clone(),
        };
        self.portable_extensions
            .lock()
            .unwrap()
            .insert(id.clone(), extension.clone());
        if kind == "yomitan" {
            let config = self.portable_config_for(&extension, "popup", &format!("{base}/popup.html"), 0);
            assets.document(&id, "__gsm_popup_bridge__.js", &self.portable_preload_for_config(&config))?;
        }

        let overlay_data = overlay_data_path(app);
        let state_root = overlay_data.join("portable-dictionaries");
        if let Err(error) = self
            .migrate_portable_legacy(app, &overlay_data, &state_root, &extension)
            .await
        {
            self.portable_extensions.lock().unwrap().remove(&id);
            return Err(error);
        }

        let source = manifest["background"]["service_worker"]
            .as_str()
            .map(str::to_string);
        let scripts: Vec<String> = manifest["background"]["scripts"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_else(|| source.clone().into_iter().collect());
        let background_page = manifest["background"]["page"]
            .as_str()
            .map(str::to_string);

        if source.is_some() || !scripts.is_empty() || background_page.is_some() {
            let seq = self.window_seq.fetch_add(1, Ordering::Relaxed);
            let bg_label = format!("gsm-dict-bg-{seq}");
            let title = format!(
                "{} services",
                extension
                    .path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Dictionary")
            );
            let bg_url = if let Some(ref bg) = background_page {
                format!("chrome-extension://{id}/{bg}")
            } else {
                let is_module = manifest["background"]["type"].as_str() == Some("module");
                let script_tags: String = scripts
                    .iter()
                    .map(|file| {
                        format!(
                            "<script {} src=\"{base}/{file}\"></script>",
                            if is_module { "type=\"module\"" } else { "" }
                        )
                    })
                    .collect();
                let html = format!(
                    "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>{script_tags}"
                );
                assets.document(&id, "__gsm_background__.html", &html)?;
                format!("chrome-extension://{id}/__gsm_background__.html")
            };

            let cfg = self.portable_config_for(&extension, "background", &bg_url, seq);
            let dict_preload = self.portable_preload_for_config(&cfg);
            self.contexts.lock().unwrap().insert(
                bg_label.clone(),
                ExtensionContext {
                    extension_id: id.clone(),
                    kind: "background".into(),
                    url: bg_url.clone(),
                },
            );

            let win = self.create_managed_window(
                app,
                &bg_label,
                &bg_url,
                &title,
                1.0,
                1.0,
                false,
                &overlay_data,
                "dictionary",
                Some(&dict_preload),
            )?;
            // Background modules can register listeners after initial module imports.
            for _ in 0..80 {
                let res = evaluate_raw(app, &win,
                    "(async()=>{if (!globalThis.__GSM_DICTIONARY_BOOTED__) return false; await globalThis.__GSM_DICTIONARY_BOOTED__; return true;})()"
                ).await;
                if res == Ok(json!(true)) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        Ok(extension)
    }

    fn browser_import_selection(&self, app: &AppHandle) -> Value {
        let path = overlay_data_path(app).join("native-dictionaries/browser-import-selection.json");
        fs::read(path)
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_else(|| json!({}))
    }

    pub fn browser_import_status(&self, app: &AppHandle) -> Value {
        json!({
            "supported": use_windows_native_extensions(),
            "selection": self.browser_import_selection(app),
        })
    }

    async fn select_browser_library(
        &self,
        app: &AppHandle,
        reader: &str,
        slot: Option<String>,
    ) -> Result<Value, String> {
        let previous = self.browser_import_selection(app);
        let mut selection = previous.as_object().cloned().unwrap_or_default();
        if let Some(slot) = slot {
            selection.insert(reader.into(), json!(slot));
        } else {
            selection.remove(reader);
        }
        let selection = Value::Object(selection);
        if selection != previous {
            let path =
                overlay_data_path(app).join("native-dictionaries/browser-import-selection.json");
            gsm_settings::write_atomic(&path, &selection).map_err(|error| error.to_string())?;
            let overlay = app.state::<crate::overlay_host::OverlayHost>();
            if let Err(error) = overlay.reload_browser_dictionary(app, reader).await {
                gsm_settings::write_atomic(&path, &previous)
                    .map_err(|rollback| format!("{error}. Could not restore the previous library: {rollback}"))?;
                overlay.reload_browser_dictionary(app, reader).await
                    .map_err(|rollback| format!("{error}. Could not reload the previous library: {rollback}"))?;
                return Err(error);
            }
        }
        Ok(self.browser_import_status(app))
    }

    pub async fn use_original_browser_dictionary(
        &self,
        app: &AppHandle,
        reader: &str,
    ) -> Result<Value, String> {
        if !matches!(reader, "yomitan" | "hachidori") {
            return Err("Invalid dictionary reader".into());
        }
        let _guard = self.browser_import_lock.lock().await;
        self.select_browser_library(app, reader, None).await
    }

    #[cfg(windows)]
    pub async fn import_browser_dictionary(
        &self,
        app: &AppHandle,
        profile: PathBuf,
        source_id: String,
    ) -> Result<Value, String> {
        if !use_windows_native_extensions() {
            return Err("Browser profile import requires Windows WebView2".into());
        }
        if !crate::browser_dictionary::valid_id(&source_id) {
            return Err("Invalid browser extension ID".into());
        }
        let overlay_data = overlay_data_path(app);
        let (source, profile) = tokio::task::spawn_blocking(move || {
            let profile = fs::canonicalize(profile).map_err(|e| e.to_string())?;
            let source = crate::browser_dictionary::sources_in("", &profile)
                .into_iter()
                .find(|source| source.direct && source.id == source_id)
                .ok_or("The selected browser dictionary could not be found")?;
            Ok::<_, String>((source, profile))
        })
        .await
        .map_err(|error| error.to_string())??;
        if fs::canonicalize(&overlay_data)
            .ok()
            .is_some_and(|overlay| profile.starts_with(overlay))
        {
            return Err("Select a browser profile outside GSM's data folder".into());
        }

        let _guard = self.browser_import_lock.lock().await;
        let controller = {
            let _guard = self.windows_lock.lock().await;
            prepare_windows_profile(&overlay_data)?;
            self.ensure_windows_controller(app, &overlay_data).await?
        };
        let state_root = overlay_data.join("native-dictionaries");
        let resource_root = overlay_resources_root(app);
        let bundled = resolve_extension_source(&overlay_data, &resource_root, source.reader, true)?;
        let mut manifest = read_manifest(&bundled)?;
        let name = manifest["name"].as_str().unwrap_or("Dictionary").to_owned();
        let fingerprint = format!("{}|{}", profile.display(), source.id);
        let pending_id = extension_id_from_bytes(fingerprint.as_bytes());
        let pending = state_root
            .join("browser-imports")
            .join(format!("{pending_id}.json"));
        let slot = fs::read(&pending)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok())
            .filter(|id| crate::browser_dictionary::valid_id(id))
            .unwrap_or_else(|| extension_id_from_bytes(uuid::Uuid::new_v4().as_bytes()));
        gsm_settings::write_atomic(&pending, &json!(slot)).map_err(|error| error.to_string())?;
        let active_dir = state_root
            .join("browser-imports")
            .join(&slot)
            .join("extension");
        fs::create_dir_all(&active_dir).map_err(|e| e.to_string())?;
        let key_file = active_dir.with_file_name("public-key.json");
        let key: String = match fs::read(&key_file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let key = tokio::task::spawn_blocking(|| {
                    use rsa::pkcs8::EncodePublicKey;
                    let key = rsa::RsaPrivateKey::new(&mut rand_core::OsRng, 2048)
                        .map_err(|error| error.to_string())?;
                    let public = key
                        .to_public_key()
                        .to_public_key_der()
                        .map_err(|error| error.to_string())?;
                    Ok::<_, String>(STANDARD.encode(public.as_bytes()))
                })
                .await
                .map_err(|error| error.to_string())??;
                gsm_settings::write_atomic(&key_file, &json!(key))
                    .map_err(|error| error.to_string())?;
                key
            }
            Err(error) => return Err(error.to_string()),
        };
        manifest["key"] = json!(key);
        let id = extension_id_for_directory(&active_dir, &manifest, true);
        let completed = state_root.join(format!("{id}-legacy-transfer.json"));
        let browser_filesystem = source.reader == "hachidori";
        if !completed.is_file() {
            let (database, settings) =
                crate::browser_dictionary::storage_paths(&profile, &source.id);
            let filesystem = browser_filesystem.then(|| profile.join("File System"));
            let legacy = LegacySource {
                id: source.id,
                database,
                settings,
                filesystem,
            };
            if !browser_filesystem {
                let _ = crate::browser_extensions::enable(&controller, id.clone(), false).await;
                self.clone_windows_chromium_dictionary(
                    app,
                    &overlay_data,
                    &state_root,
                    &id,
                    &name,
                    &legacy,
                )
                .await?;
            } else {
                let mut transfer_manifest = json!({
                    "manifest_version":3, "name":"GSM Browser Transfer", "version":manifest["version"],
                    "key":manifest["key"],
                    "permissions":["storage","unlimitedStorage"],
                    "host_permissions":["http://gsm.localhost/*"],
                });
                for policy in ["cross_origin_opener_policy", "cross_origin_embedder_policy"] {
                    if let Some(value) = manifest.get(policy) {
                        transfer_manifest[policy] = value.clone();
                    }
                }
                for file in ["opfs-capability-worker.js", "error-text.js"] {
                    fs::copy(bundled.join(file), active_dir.join(file)).map_err(|error| error.to_string())?;
                }
                fs::write(
                    active_dir.join("manifest.json"),
                    transfer_manifest.to_string(),
                )
                .map_err(|e| e.to_string())?;
                fs::write(
                    active_dir.join("gsm-transfer.html"),
                    "<!doctype html><title>GSM Dictionary Transfer</title>",
                )
                .map_err(|e| e.to_string())?;
                let installed = crate::browser_extensions::load(
                    &controller,
                    active_dir.to_string_lossy().into_owned(),
                )
                .await?;
                if installed["id"].as_str() != Some(id.as_str()) {
                    return Err("Browser import extension identity changed unexpectedly".into());
                }
                crate::browser_extensions::enable(&controller, id.clone(), true).await?;
                let assets = app
                    .state::<crate::desktop_state::DesktopState>()
                    .assets
                    .clone();
                assets.3.lock().unwrap().insert(id.clone());
                let placeholder = LoadedExtension {
                    id: id.clone(),
                    name,
                    version: manifest["version"].as_str().unwrap_or_default().into(),
                    path: active_dir.clone(),
                    source_path: bundled.clone(),
                    manifest: manifest.clone(),
                    base: format!("chrome-extension://{id}"),
                };
                let result = self.run_legacy_transfer(
                    app, &overlay_data, &state_root, &placeholder, Some(&legacy), true, browser_filesystem,
                ).await;
                if result.is_ok() {
                    self.clear_transfer(app, &id);
                } else {
                    self.set_transfer(app, &id, &placeholder.name, "failed", 0);
                }
                let disabled = crate::browser_extensions::enable(&controller, id.clone(), false).await;
                assets.3.lock().unwrap().remove(&id);
                result?;
                disabled?;
            }
        }
        copy_dir_recursive(&bundled, &active_dir)?;
        fs::write(active_dir.join("manifest.json"), manifest.to_string())
            .map_err(|e| e.to_string())?;
        fs::write(
            active_dir.join("gsm-transfer.html"),
            "<!doctype html><title>GSM Dictionary Transfer</title>",
        )
        .map_err(|e| e.to_string())?;
        let status = self.select_browser_library(app, source.reader, Some(slot)).await?;
        let _ = fs::remove_file(pending);
        Ok(status)
    }

    #[cfg(windows)]
    async fn clone_windows_chromium_dictionary(
        &self,
        app: &AppHandle,
        overlay_data: &Path,
        state_root: &Path,
        extension_id: &str,
        extension_name: &str,
        source: &LegacySource,
    ) -> Result<(), String> {
        fs::create_dir_all(state_root).map_err(|e| e.to_string())?;
        let completed = state_root.join(format!("{extension_id}-legacy-transfer.json"));
        if let Ok(raw) = fs::read_to_string(&completed) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if val["format"].as_u64().unwrap_or(0) >= 4 {
                    return Ok(());
                }
            }
        }

        prepare_windows_profile(overlay_data)?;
        let (dest_database, dest_settings) =
            crate::browser_dictionary::storage_paths(&browser_profile_dir(overlay_data), extension_id);

        self.set_transfer(app, extension_id, extension_name, "importing", 0);
        let source_db = source.database.clone();
        let source_settings = source.settings.clone();
        let source_id = source.id.clone();
        let dest_id = extension_id.to_owned();
        let id_owned = extension_id.to_owned();
        let name_owned = extension_name.to_owned();
        let handle = app.clone();

        let result = tokio::task::spawn_blocking(move || {
            gsm_dictionary_transfer::clone_chromium(
                &source_db,
                &source_settings,
                &source_id,
                &dest_database,
                &dest_settings,
                &dest_id,
                &|phase, records| {
                    handle
                        .state::<DictionaryManager>()
                        .set_transfer(&handle, &id_owned, &name_owned, phase, records);
                },
            )
            .map_err(|e| format!("Could not transfer saved {name_owned} dictionaries: {e:#}"))
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|res| res);

        let summary = match result {
            Ok(summary) => summary,
            Err(error) => {
                self.set_transfer(app, extension_id, extension_name, "failed", 0);
                return Err(error);
            }
        };

        let marker = json!({
            "format": 4,
            "sourceId": source.id,
            "date": current_iso_timestamp(),
            "databases": summary.databases,
            "records": summary.records,
        });
        if let Err(error) = gsm_settings::write_atomic(&completed, &marker) {
            let error_msg = error.to_string();
            self.set_transfer(app, extension_id, extension_name, "failed", 0);
            return Err(error_msg);
        }

        let transfers_dir = state_root.join("transfers");
        let pointer = transfers_dir.join(format!("{extension_id}.json"));
        if let Ok(raw) = fs::read_to_string(&pointer) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(dir) = val["directory"].as_str().map(PathBuf::from) {
                    if let (Ok(canonical_dest), Ok(canonical_parent)) =
                        (fs::canonicalize(&dir), fs::canonicalize(&transfers_dir))
                    {
                        if canonical_dest.parent() == Some(canonical_parent.as_path()) {
                            let _ = fs::remove_dir_all(&canonical_dest);
                        }
                    }
                }
            }
        }
        let _ = fs::remove_file(&pointer);

        self.clear_transfer(app, extension_id);
        crate::desktop_log::info(
            app,
            "dictionary",
            format!(
                "Completed {} transfer ({} files cloned).",
                extension_name, summary.records
            ),
        );
        Ok(())
    }

    async fn migrate_windows_legacy(
        &self,
        app: &AppHandle,
        overlay_data: &Path,
        state_root: &Path,
        extension: &LoadedExtension,
        pre_discovered: Option<&LegacySource>,
    ) -> Result<(), String> {
        let result = self
            .run_legacy_transfer(app, overlay_data, state_root, extension, pre_discovered, true, false)
            .await;
        if result.is_ok() {
            self.clear_transfer(app, &extension.id);
        } else {
            self.set_transfer(app, &extension.id, &extension.name, "failed", 0);
        }
        result
    }

    async fn migrate_portable_legacy(
        &self,
        app: &AppHandle,
        overlay_data: &Path,
        state_root: &Path,
        extension: &LoadedExtension,
    ) -> Result<(), String> {
        let result = self
            .run_legacy_transfer(app, overlay_data, state_root, extension, None, false, false)
            .await;
        if result.is_ok() {
            self.clear_transfer(app, &extension.id);
        } else {
            self.set_transfer(app, &extension.id, &extension.name, "failed", 0);
        }
        result
    }

    async fn run_legacy_transfer(
        &self,
        app: &AppHandle,
        overlay_data: &Path,
        state_root: &Path,
        extension: &LoadedExtension,
        pre_discovered: Option<&LegacySource>,
        is_windows_native: bool,
        browser_filesystem: bool,
    ) -> Result<(), String> {
        fs::create_dir_all(state_root).map_err(|e| e.to_string())?;
        let completed = state_root.join(format!("{}-legacy-transfer.json", extension.id));
        if let Ok(raw) = fs::read_to_string(&completed) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if val["format"].as_u64().unwrap_or(0) >= 4 {
                    return Ok(());
                }
            }
        }

        let mut source = match pre_discovered.cloned() {
            Some(s) => s,
            None => {
                match discover_legacy(
                    app,
                    overlay_data,
                    &extension.id,
                    &extension.name,
                    &extension.path,
                )
                .await?
                {
                    Some(s) => s,
                    None => return Ok(()),
                }
            }
        };

        self.set_transfer(app, &extension.id, &extension.name, "reading", 0);
        if extension_kind(&extension.name) == "hachidori" && source.filesystem.is_none() {
            source.filesystem = Some(overlay_data.join("File System"));
        }

        let transfers_dir = state_root.join("transfers");
        fs::create_dir_all(&transfers_dir).map_err(|e| e.to_string())?;
        let pointer = transfers_dir.join(format!("{}.json", extension.id));

        let canonical_transfers = canonical_path_for_hash(&transfers_dir);
        let mut destination = fs::read_to_string(&pointer)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["directory"].as_str().map(PathBuf::from))
            .and_then(|p| {
                let parent = canonical_path_for_hash(p.parent()?);
                if parent == canonical_transfers {
                    return Some(p);
                }
                let old = gsm_packages::overlay_directory::migration_source(overlay_data)?;
                let old_transfers = old.join(state_root.file_name()?).join("transfers");
                if parent != canonical_path_for_hash(&old_transfers) {
                    return None;
                }
                let copied = transfers_dir.join(p.file_name()?);
                copied.join("manifest.json").is_file().then_some(copied)
            })
            .unwrap_or_else(|| {
                transfers_dir.join(format!("{}-{}", extension.id, uuid::Uuid::new_v4()))
            });

        let exported_manifest: Option<Value> = fs::read_to_string(destination.join("manifest.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        let needs_export = match &exported_manifest {
            None => true,
            Some(m) => {
                source.filesystem.is_some()
                    && m["filesystemVersion"].as_u64() != Some(1)
            }
        };
        if needs_export {
            if destination.exists() {
                destination =
                    transfers_dir.join(format!("{}-{}", extension.id, uuid::Uuid::new_v4()));
            }
            fs::write(
                &pointer,
                json!({ "directory": destination.to_string_lossy() }).to_string(),
            )
            .map_err(|e| e.to_string())?;
            crate::desktop_log::info(
                app,
                "dictionary",
                format!(
                    "Reading saved {} dictionaries. The original profile is preserved.",
                    extension.name
                ),
            );
            run_legacy_export(
                app,
                &extension.id,
                &extension.name,
                &source,
                &destination,
            )
            .await?;
        }

        self.set_transfer(app, &extension.id, &extension.name, "importing", 0);
        let mount_id = format!("transfer-{}", uuid::Uuid::new_v4());
        let assets = app.state::<crate::desktop_state::DesktopState>().assets.clone();
        assets.mount(&mount_id, &destination)?;
        let base_url = format!("{}/{}", crate::assets::origin(), mount_id);

        let transfer_url = format!(
            "chrome-extension://{}/{}",
            extension.id,
            if is_windows_native {
                "gsm-transfer.html"
            } else {
                "__gsm_migration__.html"
            }
        );

        let transfer_res: Result<Value, String> = async {
            let extra_preload = if is_windows_native {
                None
            } else {
                let cfg = self.portable_config_for(extension, "tab", &transfer_url, 999_001);
                Some(self.portable_preload_for_config(&cfg))
            };
            let seq = self.window_seq.fetch_add(1, Ordering::Relaxed);
            let label = format!("{LEGACY_TRANSFER_LABEL}-{seq}");
            let page = self.create_managed_window(
                app,
                &label,
                &transfer_url,
                "GSM Dictionary Transfer",
                320.0,
                200.0,
                false,
                overlay_data,
                "dictionary",
                extra_preload.as_deref(),
            )?;

            let result = async {
                // Wait briefly for the page document to finish initializing.
                let import_script = legacy_import_script(&base_url, browser_filesystem);
                for attempt in 0..80 {
                    match evaluate_raw(app, &page, &import_script).await {
                        Ok(_) => break,
                        Err(e) if attempt < 79 => {
                            let _ = e;
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                        Err(e) => return Err(e),
                    }
                }

                let mut final_state = Value::Null;
                while app.get_webview_window(&label).is_some() {
                    let state = evaluate_raw(app, &page, "globalThis.__GSM_TRANSFER__")
                        .await
                        .unwrap_or(Value::Null);
                    match state["status"].as_str() {
                        Some("running") => {
                            let recs = state["records"].as_u64().unwrap_or(0);
                            self.set_transfer(app, &extension.id, &extension.name, "importing", recs);
                        }
                        Some("failed") => {
                            return Err(state["error"]
                                .as_str()
                                .unwrap_or("Dictionary import failed")
                                .to_string());
                        }
                        Some("complete") => {
                            final_state = state;
                            break;
                        }
                        _ => {}
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }

                if final_state["status"].as_str() != Some("complete") {
                    return Err(
                        "Dictionary transfer was interrupted; it will resume next time.".into(),
                    );
                }

                let manifest_raw = fs::read_to_string(destination.join("manifest.json"))
                    .map_err(|e| e.to_string())?;
                let manifest: Value =
                    serde_json::from_str(&manifest_raw).map_err(|e| e.to_string())?;
                let legacy_storage = manifest["storage"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();

                if is_windows_native {
                    let set_script = format!(
                        "chrome.storage.local.set({})",
                        Value::Object(legacy_storage)
                    );
                    let _ = evaluate_raw(app, &page, &set_script).await?;
                } else {
                    let mut current = self.read_portable_storage(state_root, &extension.id, "local")?;
                    for (k, v) in legacy_storage {
                        current.insert(k, v);
                    }
                    self.write_portable_storage(state_root, &extension.id, "local", &current)?;
                }

                let res_obj = final_state["result"].as_object().cloned().unwrap_or_default();
                let records_count = res_obj.get("records").and_then(Value::as_u64).unwrap_or(0);
                let mut marker_obj = Map::new();
                marker_obj.insert("format".into(), json!(4));
                marker_obj.insert("sourceId".into(), json!(source.id));
                marker_obj.insert("date".into(), json!(current_iso_timestamp()));
                for (k, v) in res_obj {
                    marker_obj.insert(k, v);
                }
                fs::write(&completed, Value::Object(marker_obj).to_string())
                    .map_err(|e| e.to_string())?;
                crate::desktop_log::info(
                    app,
                    "dictionary",
                    format!(
                        "Completed {} transfer ({} records).",
                        extension.name, records_count
                    ),
                );
                Ok(Value::Null)
            }
            .await;

            let _ = page.destroy();
            result
        }
        .await;

        assets.unmount(&mount_id);
        transfer_res?;

        let canonical_dest = fs::canonicalize(&destination).map_err(|e| e.to_string())?;
        let canonical_parent = fs::canonicalize(&transfers_dir).map_err(|e| e.to_string())?;
        if canonical_dest.parent() != Some(canonical_parent.as_path()) {
            return Err("Unexpected dictionary transfer directory".into());
        }
        let _ = fs::remove_dir_all(&canonical_dest);
        let _ = fs::remove_file(&pointer);
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) async fn inspect_hachidori_memory(&self, app: &AppHandle) -> Result<Value, String> {
        let _guard = self.hachidori_engine_lock.try_lock()
            .map_err(|_| "The dictionary engine is starting".to_owned())?;
        let controller = app.get_webview_window(EXTENSION_CONTROLLER_LABEL)
            .ok_or("The dictionary profile is closed")?;
        let extensions = tokio::time::timeout(Duration::from_secs(1), crate::browser_extensions::list(&controller))
            .await.map_err(|_| "The dictionary profile did not respond")??;
        let id = extensions.as_array().into_iter().flatten().find_map(|extension| {
            let name = extension["name"].as_str()?;
            let id = extension["id"].as_str()?;
            (extension["enabled"] == true && extension_kind(name) == "hachidori" && is_valid_extension_id(id))
                .then_some(id)
        }).ok_or("Hachidori is disabled")?;

        // The probe page carries no imports and does not initialize a second engine.
        let url = format!("chrome-extension://{id}/gsm/memory-probe.html");
        let probe = self.create_managed_window(
            app, "gsm-hachidori-memory", &url, "Hachidori", 1.0, 1.0, false,
            &overlay_data_path(app), "dictionary", None,
        )?;
        let result = tokio::time::timeout(Duration::from_secs(8), async {
            wait_for_chrome_extension_url(&probe).await;
            let script = format!(r#"
                if (location.href !== {expected}) throw new Error('Dictionary memory page is unavailable');
                const reply = await chrome.runtime.sendMessage({{ target: 'hoshidicts-offscreen', type: 'hd_memory', requestId: crypto.randomUUID() }});
                if (reply?.ok !== true || !Number.isFinite(reply.heapBytes) || !Array.isArray(reply.dictionaries)) {{
                    throw new Error('Dictionary memory is unavailable');
                }}
                return {{
                    heapBytes: reply.heapBytes,
                    useLessRamByDefault: reply.useLessRamByDefault ?? null,
                    dictionaries: reply.dictionaries.map(({{ id, title, residentHashBytes, hashIndexStorage }}) =>
                        ({{ id, title, residentHashBytes, hashIndexStorage }})),
                }};
            "#, expected = json!(url));
            crate::browser_extensions::evaluate(&probe, script).await
        }).await;
        crate::reader_service::destroy_reader_window(app, &probe).await?;
        result.map_err(|_| "Dictionary memory inspection timed out".to_owned())?
    }

    pub async fn ensure_hachidori_engine(
        &self,
        app: &AppHandle,
        extension: &LoadedExtension,
    ) -> Result<Option<WebviewWindow>, String> {
        let _guard = self.hachidori_engine_lock.lock().await;
        if let Some(existing) = app.get_webview_window(HACHIDORI_ENGINE_LABEL) {
            if !use_windows_native_extensions()
                || existing.url().is_ok_and(|url| url.host_str() == Some(extension.id.as_str()))
            {
                return Ok(Some(existing));
            }
            crate::reader_service::destroy_reader_window(app, &existing).await?;
        }
        if self
            .hachidori_engine_ready
            .lock()
            .unwrap()
            .contains(&extension.id)
        {
            return Ok(None);
        }
        let overlay_data = overlay_data_path(app);
        let check_url = format!("chrome-extension://{}/gsm/engine-host.html", extension.id);
        let is_portable = !use_windows_native_extensions();
        let extra = if is_portable {
            let cfg = self.portable_config_for(extension, "tab", &check_url, 999_002);
            Some(self.portable_preload_for_config(&cfg))
        } else {
            None
        };
        if is_portable {
            self.contexts.lock().unwrap().insert(
                HACHIDORI_ENGINE_LABEL.to_string(),
                ExtensionContext {
                    extension_id: extension.id.clone(),
                    kind: "tab".into(),
                    url: check_url.clone(),
                },
            );
        }
        let win = self.create_managed_window(
            app,
            HACHIDORI_ENGINE_LABEL,
            &check_url,
            "GSM Hachidori Engine",
            1.0,
            1.0,
            false,
            &overlay_data,
            "dictionary",
            extra.as_deref(),
        )?;

        let mut own_engine = None;
        let mut startup_error = "Dictionary engine startup timed out".to_owned();
        for attempt in 0..80 {
            match tokio::time::timeout(
                Duration::from_secs(2),
                evaluate_raw(
                    app,
                    &win,
                    "if (typeof globalThis.GsmHachidoriEngineHost === 'undefined') { await import('./engine-host.js'); } return Boolean(await globalThis.GsmHachidoriEngineHost);",
                ),
            )
            .await
            {
                Ok(Ok(val)) => {
                    own_engine = val.as_bool();
                    break;
                }
                Ok(Err(error)) => {
                    startup_error = error;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                _ if attempt < 79 => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                _ => break,
            }
        }

        let Some(own_engine) = own_engine else {
            self.contexts.lock().unwrap().remove(HACHIDORI_ENGINE_LABEL);
            let _ = win.destroy();
            return Err(startup_error);
        };
        if own_engine {
            self.hachidori_engine_ready
                .lock()
                .unwrap()
                .insert(extension.id.clone());
            self.contexts.lock().unwrap().remove(HACHIDORI_ENGINE_LABEL);
            let _ = win.destroy();
            return Ok(None);
        }

        let offscreen_raw = format!("chrome-extension://{}/offscreen.html", extension.id);
        let assets_url = app
            .state::<crate::desktop_state::DesktopState>()
            .assets
            .url(&offscreen_raw)?;
        win.navigate(assets_url).map_err(|e| e.to_string())?;
        if is_portable {
            if let Some(context) = self.contexts.lock().unwrap().get_mut(HACHIDORI_ENGINE_LABEL) {
                context.kind = "offscreen".into();
                context.url = offscreen_raw;
            }
        }
        self.hachidori_engine_ready
            .lock()
            .unwrap()
            .insert(extension.id.clone());
        Ok(Some(win))
    }

    pub async fn load_selected_extension(
        &self,
        app: &AppHandle,
    ) -> Result<(String, LoadedExtension), String> {
        let overlay_data = overlay_data_path(app);
        let reader = reader_selection(&overlay_data).to_string();
        let resource_root = overlay_resources_root(app);
        let native_win = use_windows_native_extensions();
        let source = resolve_extension_source(&overlay_data, &resource_root, &reader, native_win)?;
        if !source.join("manifest.json").exists() {
            return Err(
                "The dictionary reader is not installed. Open Overlay settings to install it."
                    .into(),
            );
        }
        let ext = if native_win {
            self.load_windows_extension(app, &source).await?
        } else {
            self.load_portable_extension(app, &source).await?
        };
        Ok((reader, ext))
    }

    pub async fn load_jiten_extension(&self, app: &AppHandle) -> Result<LoadedExtension, String> {
        let data = overlay_data_path(app);
        let source = resolve_extension_source(&data, &overlay_resources_root(app), "jiten.reader", use_windows_native_extensions())?;
        if use_windows_native_extensions() { self.load_windows_extension(app, &source).await }
        else { self.load_portable_extension(app, &source).await }
    }

    pub async fn disable_jiten_extension(&self, app: &AppHandle) -> Result<(), String> {
        #[cfg(windows)]
        if use_windows_native_extensions() {
            let _guard = self.windows_lock.lock().await;
            let overlay_data = overlay_data_path(app);
            let Some(controller) = app.get_webview_window(EXTENSION_CONTROLLER_LABEL) else {
                return Ok(());
            };
            let _ = &overlay_data;
            let list = crate::browser_extensions::list(&controller).await?;
            if let Some(items) = list.as_array() {
                let assets = app.state::<crate::desktop_state::DesktopState>().assets.clone();
                for item in items {
                    let oid = item["id"].as_str().unwrap_or_default();
                    let enabled = item["enabled"].as_bool().unwrap_or(false);
                    let oname = item["name"].as_str().unwrap_or_default();
                    if enabled && extension_kind(oname) == "jiten" && !oid.is_empty() {
                        crate::browser_extensions::enable(&controller, oid.to_string(), false)
                            .await?;
                        self.windows_extensions.lock().unwrap().remove(oid);
                        assets.3.lock().unwrap().remove(oid);
                    }
                }
            }
            return Ok(());
        }

        let ids: Vec<String> = self
            .portable_extensions
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, ext)| extension_kind(&ext.name) == "jiten")
            .map(|(id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        let assets = app.state::<crate::desktop_state::DesktopState>().assets.clone();
        let mut labels = Vec::new();
        {
            let mut contexts = self.contexts.lock().unwrap();
            let keys: Vec<String> = contexts
                .iter()
                .filter(|(_, ctx)| ids.iter().any(|id| id == &ctx.extension_id))
                .map(|(label, _)| label.clone())
                .collect();
            for label in keys {
                contexts.remove(&label);
                labels.push(label);
            }
        }
        {
            let mut portable = self.portable_extensions.lock().unwrap();
            let mut assets_guard = assets.3.lock().unwrap();
            for id in &ids {
                portable.remove(id);
                assets_guard.remove(id);
            }
        }
        for label in labels {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.destroy();
            }
        }
        Ok(())
    }

    pub async fn reconcile_jiten_extension(&self, app: &AppHandle) -> Result<(), String> {
        let overlay_data = overlay_data_path(app);
        let raw = match fs::read_to_string(overlay_data.join("settings.json")) {
            Ok(raw) => raw,
            Err(_) => return Ok(()),
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            return Ok(());
        };
        if parsed.get("enableJitenReader").and_then(Value::as_bool) == Some(false) {
            self.disable_jiten_extension(app).await?;
        }
        Ok(())
    }

    pub async fn open_selected_extension_options(&self, app: &AppHandle) -> Result<(), String> {
        let (_, ext) = self.load_selected_extension(app).await?;
        self.open_extension_options(app, &ext).await
    }

    pub async fn open_jiten_options(&self, app: &AppHandle) -> Result<(), String> {
        let ext = self.load_jiten_extension(app).await?;
        self.open_extension_options(app, &ext).await
    }

    async fn open_extension_options(&self, app: &AppHandle, ext: &LoadedExtension) -> Result<(), String> {
        let default_page = ext.manifest["options_ui"]["page"]
            .as_str()
            .or_else(|| ext.manifest["options_page"].as_str())
            .unwrap_or("settings.html");
        let url_str = if use_windows_native_extensions() {
            format!("chrome-extension://{}/{default_page}", ext.id)
        } else {
            format!("{}/{default_page}", ext.base)
        };
        let label = format!("gsm-dict-options-{}", ext.id);
        let show =
            extension_kind(&ext.name) != "jiten" || std::env::var_os("GSM_SMOKE_TEST").is_none();
        if let Some(win) = app.get_webview_window(&label) {
            if show {
                let _ = win.show();
                let _ = win.set_focus();
            }
            return Ok(());
        }
        let extra = if use_windows_native_extensions() {
            None
        } else {
            let tab_id = stable_window_id(&label);
            let cfg = self.portable_config_for(&ext, "tab", &url_str, tab_id);
            self.contexts.lock().unwrap().insert(
                label.clone(),
                ExtensionContext {
                    extension_id: ext.id.clone(),
                    kind: "tab".into(),
                    url: url_str.clone(),
                },
            );
            Some(self.portable_preload_for_config(&cfg))
        };
        let overlay_data = overlay_data_path(app);
        self.create_managed_window(
            app,
            &label,
            &url_str,
            &ext.name,
            1000.0,
            760.0,
            show,
            &overlay_data,
            "dictionary",
            extra.as_deref(),
        )?;
        Ok(())
    }

    pub async fn attach_reader_window(
        &self,
        app: &AppHandle,
        window: &WebviewWindow,
        extension: &LoadedExtension,
    ) -> Result<(), String> {
        let label = window.label().to_string();
        let previous = self.get_home_reader_extension(&label);
        if use_windows_native_extensions() {
            if previous.as_deref() == Some(extension.id.as_str()) {
                return Ok(());
            }
            let url = window.url().map_err(|e| e.to_string())?;
            window.navigate(url).map_err(|e| e.to_string())?;
            self.set_home_reader_extension(&label, &extension.id);
            return Ok(());
        }

        self.mark_home_reader_window(&label, true);
        if let Some(prev_id) = previous {
            if prev_id != extension.id {
                self.set_home_reader_extension(&label, &extension.id);
                self.content_contexts
                    .lock()
                    .unwrap()
                    .retain(|(wlabel, _), _| wlabel != &label);
                if let Ok(url) = window.url() {
                    window.navigate(url).map_err(|e| e.to_string())?;
                    // The new document's ready handler installs its reader.
                    return Ok(());
                }
            }
        }
        self.set_home_reader_extension(&label, &extension.id);
        let cur_url = window.url().map(|u| u.to_string()).unwrap_or_default();
        let preload = self.portable_preload_for_window(&label, extension, &cur_url, 1);
        let _ = evaluate_raw(app, window, &preload).await?;
        let select = format!("globalThis.__GSM_DICTIONARY_SELECT__({})", json!(extension.id));
        let _ = evaluate_raw(app, window, &select).await?;
        self.inject_portable_content(app, window, extension).await?;
        Ok(())
    }

    pub async fn inject_portable_content(
        &self,
        app: &AppHandle,
        window: &WebviewWindow,
        extension: &LoadedExtension,
    ) -> Result<(), String> {
        let label = window.label().to_string();
        let url = window.url().map(|u| u.to_string()).unwrap_or_default();
        if self.portable_extension_for_url(&url).is_some() {
            return Ok(());
        }
        let is_bg_or_offscreen = self
            .contexts
            .lock()
            .unwrap()
            .get(&label)
            .is_some_and(|c| c.kind == "background" || c.kind == "offscreen");
        if is_bg_or_offscreen {
            return Ok(());
        }
        if !url.starts_with("file:") && !url.starts_with("gsm:") && !url.starts_with("http://gsm.localhost/") {
            return Ok(());
        }
        let key = (label.clone(), extension.id.clone());
        if self
            .content_contexts
            .lock()
            .unwrap()
            .get(&key)
            .is_some_and(|c| c.url == url)
        {
            return Ok(());
        }
        self.content_contexts.lock().unwrap().insert(
            key,
            ContentContext { url: url.clone() },
        );

        let scripts = extension.manifest["content_scripts"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for entry in scripts {
            let mut css_combined = String::new();
            if let Some(css_files) = entry["css"].as_array() {
                for file in css_files.iter().filter_map(Value::as_str) {
                    if let Ok(text) = read_extension_resource(&extension.path, file) {
                        css_combined.push_str(&text);
                        css_combined.push('\n');
                    }
                }
            }
            let mut js_combined = String::new();
            if let Some(js_files) = entry["js"].as_array() {
                for file in js_files.iter().filter_map(Value::as_str) {
                    if let Ok(text) = read_extension_resource(&extension.path, file) {
                        js_combined.push('{');
                        js_combined.push_str(&text);
                        js_combined.push_str("\n}\n");
                    }
                }
            }
            let script = format!(
                "(async()=>{{const chrome=globalThis.__GSM_DICTIONARY_CONTEXT__({}).api;const browser=chrome;const style=document.createElement('style');style.textContent={};document.head.append(style);{}}})()",
                json!(extension.id),
                json!(css_combined),
                js_combined
            );
            let _ = evaluate_raw(app, window, &script).await?;
        }
        Ok(())
    }

    fn read_portable_storage(
        &self,
        state_root: &Path,
        id: &str,
        area: &str,
    ) -> Result<Map<String, Value>, String> {
        let key = format!("{id}-{area}");
        {
            let guard = self.storage_memory.lock().unwrap();
            if let Some(existing) = guard.get(&key) {
                return Ok(existing.clone());
            }
        }
        let data = if area != "session" {
            let file = state_root.join(format!("{key}.json"));
            match fs::read_to_string(&file) {
                Ok(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string())?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
                Err(e) => return Err(e.to_string()),
            }
        } else {
            Map::new()
        };
        let mut guard = self.storage_memory.lock().unwrap();
        let entry = guard.entry(key).or_insert_with(|| data.clone());
        Ok(entry.clone())
    }

    fn write_portable_storage(
        &self,
        state_root: &Path,
        id: &str,
        area: &str,
        data: &Map<String, Value>,
    ) -> Result<(), String> {
        let key = format!("{id}-{area}");
        self.storage_memory
            .lock()
            .unwrap()
            .insert(key.clone(), data.clone());
        if area != "session" {
            fs::create_dir_all(state_root).map_err(|e| e.to_string())?;
            let file = state_root.join(format!("{key}.json"));
            let tmp = state_root.join(format!("{key}.json.tmp"));
            let serialized = serde_json::to_vec(&Value::Object(data.clone())).map_err(|e| e.to_string())?;
            fs::write(&tmp, serialized).map_err(|e| e.to_string())?;
            fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn all_portable_contexts(&self, app: &AppHandle, extension_id: &str) -> Vec<ContextTarget> {
        let mut by_label: HashMap<String, ContextTarget> = HashMap::new();
        for (label, ctx) in self.contexts.lock().unwrap().iter() {
            if ctx.extension_id == extension_id && app.get_webview_window(label).is_some() {
                by_label.insert(
                    label.clone(),
                    ContextTarget {
                        label: label.clone(),
                        extension_id: extension_id.to_string(),
                        kind: ctx.kind.clone(),
                        url: ctx.url.clone(),
                    },
                );
            }
        }
        for ((label, ext_id), ctx) in self.content_contexts.lock().unwrap().iter() {
            if ext_id == extension_id && app.get_webview_window(label).is_some() {
                by_label
                    .entry(label.clone())
                    .or_insert_with(|| ContextTarget {
                        label: label.clone(),
                        extension_id: extension_id.to_string(),
                        kind: "tab".into(),
                        url: ctx.url.clone(),
                    });
            }
        }
        by_label.into_values().collect()
    }

    async fn deliver_to_context(
        &self,
        app: &AppHandle,
        label: &str,
        extension_id: &str,
        event_type: &str,
        args: Value,
        frame: Option<u64>,
    ) -> Option<Value> {
        let win = app.get_webview_window(label)?;
        let script = format!(
            "globalThis.__GSM_DICTIONARY_DISPATCH__?.({}, {}, {}, {})",
            json!(extension_id),
            json!(event_type),
            args,
            json!(frame)
        );
        evaluate_raw(app, &win, &script).await.ok()
    }

    fn deliver_fire_and_forget(
        &self,
        app: &AppHandle,
        extension_id: &str,
        event_type: &str,
        args: Value,
    ) {
        let targets = self.all_portable_contexts(app, extension_id);
        let app = app.clone();
        let event_type = event_type.to_string();
        tauri::async_runtime::spawn(async move {
            for target in targets {
                if let Some(win) = app.get_webview_window(&target.label) {
                    let script = format!(
                        "globalThis.__GSM_DICTIONARY_DISPATCH__?.({}, {}, {}, null)",
                        json!(target.extension_id),
                        json!(event_type),
                        args
                    );
                    let _ = evaluate_raw(&app, &win, &script).await;
                }
            }
        });
    }

    fn resolve_target_window(&self, app: &AppHandle, target_id: &Value) -> Result<(WebviewWindow, u64), String> {
        if let Some(label) = target_id.as_str() {
            let win = app
                .get_webview_window(label)
                .ok_or("Target is outside this dictionary session")?;
            return Ok((win, stable_window_id(label)));
        }
        if let Some(num) = target_id.as_u64() {
            for label in app.webview_windows().keys() {
                if stable_window_id(label) == num {
                    if let Some(win) = app.get_webview_window(label) {
                        return Ok((win, num));
                    }
                }
            }
        }
        Err("Target is outside this dictionary session".into())
    }

    /// Handles `dictionary_call` directly for Rust-hosted portable extensions.
    /// Returns `None` if the extension ID is owned by Node during transitional execution.
    pub async fn try_dictionary_call(
        &self,
        app: &AppHandle,
        window: &WebviewWindow,
        params: &Value,
    ) -> Option<Result<Value, String>> {
        let id = params["extension"].as_str()?;
        let ext = self.portable_extensions.lock().unwrap().get(id).cloned()?;
        Some(self.dispatch_portable(app, window, &ext, params).await)
    }

    async fn dispatch_portable(
        &self,
        app: &AppHandle,
        window: &WebviewWindow,
        ext: &LoadedExtension,
        params: &Value,
    ) -> Result<Value, String> {
        let id = &ext.id;
        let operation = params["operation"]
            .as_str()
            .ok_or("Missing dictionary operation")?;
        let args = params["args"].as_array().cloned().unwrap_or_default();
        let frame = params["frame"].as_u64().unwrap_or(0);
        let label = window.label().to_string();
        let win_url = window.url().map(|u| u.to_string()).unwrap_or_default();
        let win_num = stable_window_id(&label);

        let kind = self
            .contexts
            .lock()
            .unwrap()
            .get(&label)
            .map(|c| c.kind.clone())
            .unwrap_or_else(|| "tab".into());

        let sender_url = if kind == "background" {
            let entry = ext.manifest["background"]["service_worker"]
                .as_str()
                .unwrap_or("background.js");
            format!("{}/{entry}", ext.base)
        } else {
            win_url.clone()
        };
        let mut sender = json!({
            "id": id,
            "url": sender_url,
            "frameId": frame,
        });
        if kind == "tab" {
            sender["tab"] = json!({
                "id": win_num,
                "windowId": win_num,
                "url": win_url,
                "active": window.is_visible().unwrap_or(false),
            });
        }

        let overlay_data = overlay_data_path(app);
        let state_root = overlay_data.join("portable-dictionaries");

        if let Some(rest) = operation.strip_prefix("storage.") {
            let mut parts = rest.splitn(2, '.');
            let area = parts.next().unwrap_or_default();
            let action = parts.next().unwrap_or_default();
            if !matches!(area, "local" | "sync" | "session") {
                return Err("Unknown storage area".into());
            }
            let mut data = self.read_portable_storage(&state_root, id, area)?;
            let keys = args.first().cloned().unwrap_or(Value::Null);
            if action == "get" {
                return Ok(match keys {
                    Value::Null => Value::Object(data),
                    Value::String(k) => {
                        let mut m = Map::new();
                        if let Some(v) = data.get(&k) {
                            m.insert(k, v.clone());
                        }
                        Value::Object(m)
                    }
                    Value::Array(arr) => {
                        let mut m = Map::new();
                        for k in arr.iter().filter_map(Value::as_str) {
                            if let Some(v) = data.get(k) {
                                m.insert(k.to_string(), v.clone());
                            }
                        }
                        Value::Object(m)
                    }
                    Value::Object(defaults) => {
                        let mut m = defaults;
                        for (k, v) in data {
                            if m.contains_key(&k) {
                                m.insert(k, v);
                            }
                        }
                        Value::Object(m)
                    }
                    _ => Value::Object(Map::new()),
                });
            }
            if action == "getBytesInUse" {
                let len = Value::Object(data).to_string().len();
                return Ok(json!(len));
            }
            let mut changes = Map::new();
            match action {
                "set" => {
                    if let Some(entries) = keys.as_object() {
                        for (k, new_val) in entries {
                            let old_val = data.get(k).cloned().unwrap_or(Value::Null);
                            changes.insert(
                                k.clone(),
                                json!({ "oldValue": old_val, "newValue": new_val }),
                            );
                            data.insert(k.clone(), new_val.clone());
                        }
                    }
                }
                "remove" | "clear" => {
                    let remove_keys: Vec<String> = if action == "clear" {
                        data.keys().cloned().collect()
                    } else if let Some(s) = keys.as_str() {
                        vec![s.to_string()]
                    } else if let Some(arr) = keys.as_array() {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    } else {
                        Vec::new()
                    };
                    for k in remove_keys {
                        if let Some(old_val) = data.remove(&k) {
                            changes.insert(k, json!({ "oldValue": old_val }));
                        }
                    }
                }
                "setAccessLevel" => return Ok(Value::Null),
                _ => return Err("Unsupported storage operation".into()),
            }
            self.write_portable_storage(&state_root, id, area, &data)?;
            self.deliver_fire_and_forget(
                app,
                id,
                "storage",
                json!([Value::Object(changes), area]),
            );
            return Ok(Value::Null);
        }

        if operation == "runtime.sendMessage" || operation == "tabs.sendMessage" {
            let (tab_id, message, options) = if operation == "tabs.sendMessage" {
                (
                    args.first().cloned().unwrap_or(Value::Null),
                    args.get(1).cloned().unwrap_or(Value::Null),
                    args.get(2).cloned().unwrap_or(Value::Null),
                )
            } else {
                (
                    Value::Null,
                    args.first().cloned().unwrap_or(Value::Null),
                    Value::Null,
                )
            };
            let tab_num = tab_id.as_u64();
            let mut targets: Vec<ContextTarget> = self
                .all_portable_contexts(app, id)
                .into_iter()
                .filter(|t| match tab_num {
                    None => t.label != label,
                    Some(tid) => stable_window_id(&t.label) == tid,
                })
                .collect();
            // Hachidori's background first resolves the request's dictionary profile.
            // Only its forwarded copy is handled by the offscreen engine.
            let prefer_kind = if message["relayed"] == true
                && message["target"].as_str() == Some("hoshidicts-offscreen")
            {
                "offscreen"
            } else {
                "background"
            };
            targets.sort_by_key(|t| if t.kind == prefer_kind { 0u8 } else { 1u8 });
            let target_frame = options["frameId"].as_u64();
            for target in targets {
                if let Some(res) = self
                    .deliver_to_context(
                        app,
                        &target.label,
                        id,
                        "message",
                        json!([message, sender]),
                        target_frame,
                    )
                    .await
                {
                    if res["handled"].as_bool() == Some(true) {
                        return Ok(res["value"].clone());
                    }
                }
            }
            return Err("Could not establish connection. Receiving end does not exist.".into());
        }

        if operation == "runtime.connect" || operation == "tabs.connect" {
            let port_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or("Missing port ID")?
                .to_string();
            let info = args.get(1).cloned().unwrap_or(Value::Null);
            let tab_num = args.get(2).and_then(Value::as_u64);
            let target_frame = info["frameId"].as_u64().unwrap_or(0);
            let targets: Vec<PortEndpoint> = self
                .all_portable_contexts(app, id)
                .into_iter()
                .filter(|t| match tab_num {
                    None => t.kind == "background",
                    Some(tid) => stable_window_id(&t.label) == tid,
                })
                .map(|t| PortEndpoint {
                    label: t.label,
                    extension_id: id.to_string(),
                    frame: target_frame,
                })
                .collect();
            if targets.is_empty() {
                return Err("No receiving dictionary context".into());
            }
            self.ports.lock().unwrap().insert(
                port_id.clone(),
                PortState {
                    source: PortEndpoint {
                        label: label.clone(),
                        extension_id: id.to_string(),
                        frame,
                    },
                    targets: targets.clone(),
                },
            );
            let port_name = info["name"].as_str().unwrap_or_default();
            for t in targets {
                let _ = self
                    .deliver_to_context(
                        app,
                        &t.label,
                        id,
                        "connect",
                        json!([port_id, port_name, sender]),
                        Some(t.frame),
                    )
                    .await;
            }
            return Ok(Value::Null);
        }

        if operation == "port.message" || operation == "port.disconnect" {
            let port_id = args.first().and_then(Value::as_str).unwrap_or_default();
            let msg = args.get(1).cloned().unwrap_or(Value::Null);
            let port = {
                let mut guard = self.ports.lock().unwrap();
                if operation == "port.disconnect" {
                    guard.remove(port_id)
                } else {
                    guard.get(port_id).cloned()
                }
            };
            let Some(port) = port else {
                return Ok(Value::Null);
            };
            let recipients = if port.source.label == label && port.source.frame == frame {
                port.targets
            } else {
                vec![port.source]
            };
            let event_name = if operation == "port.message" {
                "port-message"
            } else {
                "port-disconnect"
            };
            for r in recipients {
                let _ = self
                    .deliver_to_context(
                        app,
                        &r.label,
                        &r.extension_id,
                        event_name,
                        json!([port_id, msg]),
                        Some(r.frame),
                    )
                    .await;
            }
            return Ok(Value::Null);
        }

        if operation == "runtime.getContexts" {
            let document_urls = args.first().and_then(|v| v["documentUrls"].as_array());
            let filter_types: Option<Vec<String>> = args
                .first()
                .and_then(|v| v["contextTypes"].as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                });
            let list: Vec<Value> = self
                .all_portable_contexts(app, id)
                .into_iter()
                .filter_map(|c| {
                    let ctx_type = match c.kind.as_str() {
                        "offscreen" => "OFFSCREEN_DOCUMENT",
                        "background" => "BACKGROUND",
                        _ => "TAB",
                    };
                    if let Some(ref ft) = filter_types {
                        if !ft.iter().any(|x| x == ctx_type) {
                            return None;
                        }
                    }
                    let doc_url = if c.kind == "background" {
                        let entry = ext.manifest["background"]["service_worker"]
                            .as_str()
                            .unwrap_or("background.js");
                        format!("{}/{entry}", ext.base)
                    } else if c.url.starts_with("chrome-extension:") {
                        let path = url::Url::parse(&c.url)
                            .map(|u| u.path().to_string())
                            .unwrap_or_default();
                        format!("{}{path}", ext.base)
                    } else {
                        c.url
                    };
                    if document_urls.is_some_and(|urls| !urls.iter().any(|url| url.as_str() == Some(&doc_url))) {
                        return None;
                    }
                    Some(json!({
                        "contextType": ctx_type,
                        "documentUrl": doc_url,
                        "contextId": c.label,
                        "tabId": if c.kind == "tab" { stable_window_id(&c.label) as i64 } else { -1 },
                        "frameId": 0,
                    }))
                })
                .collect();
            return Ok(Value::Array(list));
        }

        if operation == "offscreen.createDocument" {
            let already = self
                .all_portable_contexts(app, id)
                .into_iter()
                .any(|c| c.kind == "offscreen");
            if already {
                return Ok(Value::Null);
            }
            let raw_rel = args
                .first()
                .and_then(|v| v["url"].as_str())
                .unwrap_or("offscreen.html")
                .trim_start_matches('/');
            let off_url = format!("chrome-extension://{id}/{raw_rel}");
            let seq = self.window_seq.fetch_add(1, Ordering::Relaxed);
            let off_label = format!("gsm-dict-offscreen-{seq}");
            let cfg = self.portable_config_for(ext, "offscreen", &off_url, seq);
            let extra = self.portable_preload_for_config(&cfg);
            self.contexts.lock().unwrap().insert(
                off_label.clone(),
                ExtensionContext {
                    extension_id: id.clone(),
                    kind: "offscreen".into(),
                    url: off_url.clone(),
                },
            );
            let _ = self.create_managed_window(
                app,
                &off_label,
                &off_url,
                &format!("{} Offscreen", ext.name),
                1.0,
                1.0,
                false,
                &overlay_data,
                "dictionary",
                Some(&extra),
            )?;
            return Ok(Value::Null);
        }

        if operation == "offscreen.closeDocument" {
            let targets: Vec<String> = self
                .contexts
                .lock()
                .unwrap()
                .iter()
                .filter_map(|(k, v)| {
                    (v.extension_id == *id && v.kind == "offscreen").then(|| k.clone())
                })
                .collect();
            for t in targets {
                self.contexts.lock().unwrap().remove(&t);
                if let Some(w) = app.get_webview_window(&t) {
                    let _ = w.destroy();
                }
            }
            return Ok(Value::Null);
        }

        if matches!(
            operation,
            "tabs.create" | "windows.create" | "runtime.openOptionsPage"
        ) {
            let options = args.first().cloned().unwrap_or(Value::Null);
            let default_page = ext.manifest["options_ui"]["page"]
                .as_str()
                .or_else(|| ext.manifest["options_page"].as_str())
                .unwrap_or("settings.html");
            let url_str = options["url"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("{}/{default_page}", ext.base));
            if !url_str.starts_with(&ext.base) && !url_str.starts_with("chrome-extension:") {
                crate::native::shell_open_external(&url_str)?;
                return Ok(Value::Null);
            }
            let seq = self.window_seq.fetch_add(1, Ordering::Relaxed);
            let tab_label = format!("gsm-dict-tab-{seq}");
            let tab_id = stable_window_id(&tab_label);
            let cfg = self.portable_config_for(ext, "tab", &url_str, tab_id);
            let extra = self.portable_preload_for_config(&cfg);
            self.contexts.lock().unwrap().insert(
                tab_label.clone(),
                ExtensionContext {
                    extension_id: id.clone(),
                    kind: "tab".into(),
                    url: url_str.clone(),
                },
            );
            let width = options["width"].as_f64().unwrap_or(1000.0);
            let height = options["height"].as_f64().unwrap_or(760.0);
            let show = options["active"].as_bool().unwrap_or(true);
            let _ = self.create_managed_window(
                app,
                &tab_label,
                &url_str,
                &ext.name,
                width,
                height,
                show,
                &overlay_data,
                "dictionary",
                Some(&extra),
            )?;
            return Ok(json!({
                "id": tab_id,
                "windowId": tab_id,
                "url": url_str,
                "active": true,
            }));
        }

        if operation == "tabs.query" {
            let active_filter = args.first().and_then(|v| v["active"].as_bool());
            let list: Vec<Value> = self
                .all_portable_contexts(app, id)
                .into_iter()
                .filter(|c| c.kind == "tab")
                .filter_map(|c| {
                    let w = app.get_webview_window(&c.label)?;
                    let vis = w.is_visible().unwrap_or(false);
                    if active_filter.is_some_and(|want| want != vis) {
                        return None;
                    }
                    let wid = stable_window_id(&c.label);
                    Some(json!({
                        "id": wid,
                        "windowId": wid,
                        "url": c.url,
                        "active": vis,
                    }))
                })
                .collect();
            return Ok(Value::Array(list));
        }

        if matches!(operation, "tabs.getCurrent" | "windows.getCurrent") {
            return Ok(json!({
                "id": win_num,
                "windowId": win_num,
                "url": win_url,
                "active": window.is_visible().unwrap_or(false),
            }));
        }

        if matches!(operation, "tabs.get" | "windows.get") {
            let target = args.first().unwrap_or(&Value::Null);
            let (win, wid) = self.resolve_target_window(app, target)?;
            return Ok(json!({
                "id": wid,
                "windowId": wid,
                "url": win.url().map(|u| u.to_string()).unwrap_or_default(),
                "active": win.is_visible().unwrap_or(false),
            }));
        }

        if operation == "tabs.getZoom" {
            return Ok(json!(1));
        }

        if matches!(operation, "tabs.update" | "windows.update") {
            let (target, options) = if args.first().is_some_and(Value::is_number) {
                (
                    args.first().cloned().unwrap_or(Value::Null),
                    args.get(1).cloned().unwrap_or(Value::Null),
                )
            } else {
                (
                    Value::String(label.clone()),
                    args.first().cloned().unwrap_or(Value::Null),
                )
            };
            let (win, wid) = self.resolve_target_window(app, &target)?;
            if let Some(new_url) = options["url"].as_str() {
                let parsed = app
                    .state::<crate::desktop_state::DesktopState>()
                    .assets
                    .url(new_url)?;
                win.navigate(parsed).map_err(|e| e.to_string())?;
            }
            if options["active"].as_bool() == Some(true)
                || options["focused"].as_bool() == Some(true)
            {
                let _ = crate::desktop_state::focus_window(&win);
            }
            return Ok(json!({
                "id": wid,
                "windowId": wid,
                "url": win.url().map(|u| u.to_string()).unwrap_or_default(),
            }));
        }

        if matches!(operation, "tabs.remove" | "windows.remove") {
            let items: Vec<Value> = match args.first() {
                Some(Value::Array(arr)) => arr.clone(),
                Some(single) => vec![single.clone()],
                None => Vec::new(),
            };
            for item in items {
                if let Ok((win, _)) = self.resolve_target_window(app, &item) {
                    let _ = win.close();
                }
            }
            return Ok(Value::Null);
        }

        if operation == "fetch" {
            let spec = args.first().ok_or("Missing fetch spec")?;
            let target_url = spec["url"].as_str().ok_or("Missing fetch URL")?;
            let lower = target_url.to_ascii_lowercase();
            if !lower.starts_with("http://") && !lower.starts_with("https://") {
                return Err("Only HTTP requests can leave a dictionary context".into());
            }
            if extension_kind(&ext.name) == "jiten" && crate::overlay_jiten::broker_route(target_url).is_some() {
                let header = |name: &str| -> String {
                    spec["headers"].as_array().into_iter().flatten().find_map(|pair| {
                        pair.get(0)?.as_str()?.eq_ignore_ascii_case(name).then(||pair.get(1)?.as_str().map(str::to_owned)).flatten()
                    }).unwrap_or_default()
                };
                let auth = header("Authorization");
                let mut key = header("X-Api-Key");
                if key.is_empty() && auth.get(..7).is_some_and(|prefix|prefix.eq_ignore_ascii_case("ApiKey ")) { key = auth[7..].trim().to_owned(); }
                if !key.is_empty() {
                    let request_id = header("X-GSM-Request-Id");
                    let bytes = STANDARD.decode(spec["body"].as_str().unwrap_or_default()).map_err(|_| "Invalid Jiten request encoding")?;
                    let cache = app.state::<crate::overlay_host::OverlayHost>().jiten_cache(app);
                    let result = cache.browser_request(target_url, spec["method"].as_str().unwrap_or("GET"), &key,
                        (!request_id.is_empty()).then_some(request_id.as_str()), &bytes).await;
                    let (status, body) = match result {
                        Ok(body) => (200, body),
                        Err(error) => (crate::overlay_jiten::browser_error_status(&error), json!({"error_message":"Jiten request unavailable"})),
                    };
                    return Ok(json!({"status":status,"statusText":if status==200 {"OK"} else {"Service Unavailable"},
                        "headers":[["content-type","application/json"]],"body":STANDARD.encode(body.to_string())}));
                }
            }
            let method = reqwest::Method::from_bytes(
                spec["method"].as_str().unwrap_or("GET").as_bytes(),
            )
            .map_err(|e| format!("Invalid HTTP method: {e}"))?;
            let http = app
                .state::<crate::desktop_state::DesktopState>()
                .http
                .clone();
            let mut req = http
                .request(method, target_url)
                .timeout(Duration::from_secs(120));
            if let Some(hdrs) = spec["headers"].as_array() {
                for pair in hdrs {
                    if let (Some(k), Some(v)) = (
                        pair.get(0).and_then(Value::as_str),
                        pair.get(1).and_then(Value::as_str),
                    ) {
                        req = req.header(k, v);
                    }
                }
            }
            if let Some(b64) = spec["body"].as_str().filter(|s| !s.is_empty()) {
                let bytes = STANDARD
                    .decode(b64)
                    .map_err(|e| format!("Invalid request body base64: {e}"))?;
                req = req.body(bytes);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| format!("Dictionary fetch failed: {e}"))?;
            let status = resp.status().as_u16();
            let status_text = resp.status().canonical_reason().unwrap_or("").to_string();
            let resp_headers: Vec<[String; 2]> = resp
                .headers()
                .iter()
                .filter_map(|(k, v)| {
                    v.to_str()
                        .ok()
                        .map(|val| [k.as_str().to_string(), val.to_string()])
                })
                .collect();
            let body_bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            return Ok(json!({
                "status": status,
                "statusText": status_text,
                "headers": resp_headers,
                "body": STANDARD.encode(&body_bytes),
            }));
        }

        if operation == "downloads.download" {
            let options = args.first().cloned().unwrap_or(Value::Null);
            let url = options["url"].as_str().unwrap_or_default().to_string();
            let valid_scheme = url.starts_with("blob:")
                || url.starts_with("data:")
                || url.starts_with("http:")
                || url.starts_with("https:");
            if !valid_scheme {
                return Err("Unsupported download URL".into());
            }
            let filename = options["filename"].as_str().unwrap_or_default().to_string();
            let basename = Path::new(if filename.is_empty() {
                "dictionary-backup.zip"
            } else {
                &filename
            })
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("dictionary-backup.zip")
            .to_string();
            let dl_id = self.download_seq.fetch_add(1, Ordering::Relaxed);
            self.downloads.lock().unwrap().insert(
                dl_id,
                DownloadRecord {
                    id: dl_id,
                    url: url.clone(),
                    label: label.clone(),
                    extension: id.clone(),
                    state: "in_progress".into(),
                    filename: filename.clone(),
                },
            );
            let click_script = format!(
                "(()=>{{const link=document.createElement('a');link.href={};link.download={};document.body.append(link);link.click();link.remove();}})()",
                json!(url),
                json!(basename)
            );
            let _ = evaluate_raw(app, window, &click_script).await?;
            return Ok(json!(dl_id));
        }

        if operation == "downloads.search" {
            let filter_id = args.first().and_then(|v| v["id"].as_u64());
            let items: Vec<Value> = self
                .downloads
                .lock()
                .unwrap()
                .values()
                .filter(|item| item.extension == *id && filter_id.is_none_or(|want| item.id == want))
                .map(|item| json!(item))
                .collect();
            return Ok(Value::Array(items));
        }

        if operation == "permissions.contains" || operation == "permissions.request" {
            return Ok(json!(true));
        }
        if operation == "permissions.remove" {
            return Ok(json!(false));
        }
        if operation == "permissions.getAll" {
            return Ok(json!({
                "permissions": ext.manifest["permissions"].as_array().cloned().unwrap_or_default(),
                "origins": ext.manifest["host_permissions"].as_array().cloned().unwrap_or_else(|| vec![json!("<all_urls>")]),
            }));
        }
        if operation == "commands.getAll" {
            let mut items = Vec::new();
            if let Some(cmds) = ext.manifest["commands"].as_object() {
                for (name, val) in cmds {
                    items.push(json!({
                        "name": name,
                        "description": val["description"],
                        "shortcut": val["suggested_key"]["default"].as_str().unwrap_or(""),
                    }));
                }
            }
            return Ok(Value::Array(items));
        }
        if operation == "management.getSelf" {
            return Ok(json!({
                "id": ext.id,
                "name": ext.name,
                "version": ext.version,
                "installType": "normal",
                "enabled": true,
            }));
        }

        if operation == "scripting.executeScript" {
            let spec = args.first().ok_or("Missing script spec")?;
            let (target_win, _) = self.resolve_target_window(app, &spec["target"]["tabId"])?;
            let source = if let Some(func) = spec["func"].as_str() {
                let call_args = spec["args"].as_array().cloned().unwrap_or_default();
                format!("({func})(...{})", Value::Array(call_args))
            } else {
                let files = spec["files"].as_array().cloned().unwrap_or_default();
                let mut combined = String::new();
                for f in files.iter().filter_map(Value::as_str) {
                    combined.push_str(&read_extension_resource(&ext.path, f)?);
                    combined.push('\n');
                }
                combined
            };
            let result = evaluate_page_script(app, &target_win, &source).await?;
            return Ok(json!([{ "frameId": 0, "result": result }]));
        }

        if operation == "scripting.insertCSS" {
            let spec = args.first().ok_or("Missing CSS spec")?;
            let (target_win, _) = self.resolve_target_window(app, &spec["target"]["tabId"])?;
            let css = if let Some(text) = spec["css"].as_str() {
                text.to_string()
            } else {
                let files = spec["files"].as_array().cloned().unwrap_or_default();
                let mut combined = String::new();
                for f in files.iter().filter_map(Value::as_str) {
                    combined.push_str(&read_extension_resource(&ext.path, f)?);
                    combined.push('\n');
                }
                combined
            };
            let inject = format!(
                "(()=>{{const style=document.createElement('style');style.textContent={};document.head.append(style);}})()",
                json!(css)
            );
            let _ = evaluate_raw(app, &target_win, &inject).await?;
            return Ok(Value::Null);
        }

        if operation == "alarms.create" {
            let name = args.first().and_then(Value::as_str).unwrap_or("");
            let info = args.get(1).cloned().unwrap_or(Value::Null);
            let key = format!("{id}:{name}");
            let delay_ms = if let Some(when_ms) = info["when"].as_f64() {
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as f64;
                (when_ms - now_ms).max(0.0) as u64
            } else {
                let mins = info["delayInMinutes"]
                    .as_f64()
                    .or_else(|| info["periodInMinutes"].as_f64())
                    .unwrap_or(1.0);
                (mins.max(0.0) * 60_000.0) as u64
            };
            let period_mins = info["periodInMinutes"].as_f64();
            let app_clone = app.clone();
            let ext_id = id.clone();
            let alarm_name = name.to_string();
            let join = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                loop {
                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let payload = json!([{
                        "name": alarm_name,
                        "scheduledTime": now_ms,
                        "periodInMinutes": period_mins,
                    }]);
                    app_clone
                        .state::<DictionaryManager>()
                        .deliver_fire_and_forget(&app_clone, &ext_id, "alarm", payload);
                    let Some(mins) = period_mins else {
                        break;
                    };
                    let period_ms = (mins.max(0.001) * 60_000.0) as u64;
                    tokio::time::sleep(Duration::from_millis(period_ms)).await;
                }
            });
            if let Some(prev) = self
                .alarms
                .lock()
                .unwrap()
                .insert(key, join)
            {
                prev.abort();
            }
            return Ok(Value::Null);
        }

        if operation == "alarms.clear" {
            let name = args.first().and_then(Value::as_str).unwrap_or("");
            let key = format!("{id}:{name}");
            let removed = self.alarms.lock().unwrap().remove(&key);
            if let Some(handle) = removed {
                handle.abort();
                return Ok(json!(true));
            }
            return Ok(json!(false));
        }

        if operation == "alarms.getAll" {
            let prefix = format!("{id}:");
            let list: Vec<Value> = self
                .alarms
                .lock()
                .unwrap()
                .keys()
                .filter_map(|k| k.strip_prefix(&prefix).map(|name| json!({ "name": name })))
                .collect();
            return Ok(Value::Array(list));
        }

        if matches!(
            operation,
            "scripting.getRegisteredContentScripts" | "userScripts.getScripts"
        ) {
            let data = self.read_portable_storage(&state_root, id, "session")?;
            return Ok(data
                .get("registeredScripts")
                .cloned()
                .unwrap_or_else(|| json!([])));
        }

        if matches!(
            operation,
            "scripting.registerContentScripts"
                | "userScripts.register"
                | "scripting.updateContentScripts"
                | "scripting.unregisterContentScripts"
                | "userScripts.unregister"
        ) {
            let mut data = self.read_portable_storage(&state_root, id, "session")?;
            let val = if operation.contains("unregister") {
                json!([])
            } else {
                args.first().cloned().unwrap_or_else(|| json!([]))
            };
            data.insert("registeredScripts".into(), val);
            self.write_portable_storage(&state_root, id, "session", &data)?;
            return Ok(Value::Null);
        }

        if matches!(
            operation,
            "declarativeNetRequest.getDynamicRules" | "declarativeNetRequest.getSessionRules"
        ) {
            let data = self.read_portable_storage(&state_root, id, "session")?;
            return Ok(data.get(operation).cloned().unwrap_or_else(|| json!([])));
        }

        if operation.starts_with("declarativeNetRequest.update") {
            let key = operation.replace("update", "get");
            let mut data = self.read_portable_storage(&state_root, id, "session")?;
            let rules = args
                .first()
                .and_then(|v| v.get("addRules"))
                .cloned()
                .unwrap_or_else(|| json!([]));
            data.insert(key, rules);
            self.write_portable_storage(&state_root, id, "session", &data)?;
            return Ok(Value::Null);
        }

        if operation.starts_with("action.") || operation.starts_with("contextMenus.") {
            return Ok(Value::Null);
        }

        Err(format!("Unsupported dictionary operation: {operation}"))
    }
}

pub fn on_download_event(
    app: &AppHandle,
    label: &str,
    url: &str,
    path: Option<&Path>,
    success: bool,
) {
    let manager = app.state::<DictionaryManager>();
    let updated: Option<(u64, String, String)> = {
        let mut downloads = manager.downloads.lock().unwrap();
        downloads
            .values_mut()
            .find(|item| item.url == url && item.label == label && item.state == "in_progress")
            .map(|item| {
                if let Some(p) = path {
                    item.filename = p.to_string_lossy().into_owned();
                }
                item.state = if success {
                    "complete".into()
                } else {
                    "interrupted".into()
                };
                (item.id, item.extension.clone(), item.state.clone())
            })
    };
    if let Some((id, ext_id, state)) = updated {
        manager.deliver_fire_and_forget(
            app,
            &ext_id,
            "download",
            json!([{ "id": id, "state": { "current": state } }]),
        );
    }
}

fn stable_window_id(label: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in label.as_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    (h & 0x7fff_ffff) + 1
}

fn read_extension_resource(root: &Path, rel_file: &str) -> Result<String, String> {
    if rel_file.is_empty() {
        return Err("Empty dictionary resource path".into());
    }
    let clean = Path::new(rel_file);
    for comp in clean.components() {
        if matches!(comp, Component::ParentDir | Component::RootDir | Component::Prefix(_)) {
            return Err("Dictionary resource is outside its directory".into());
        }
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let candidate = fs::canonicalize(root.join(clean))
        .map_err(|_| "Dictionary resource does not exist".to_string())?;
    if !candidate.starts_with(&canonical_root) {
        return Err("Dictionary resource is outside its directory".into());
    }
    fs::read_to_string(candidate).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::Instant;
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;

    #[test]
    fn page_script_body_matches_acorn_semantics() {
        assert_eq!(page_script_body("1 + 2").unwrap(), "return (1 + 2);");
        assert_eq!(
            page_script_body("const x = 1;\nx + 2;").unwrap(),
            "const x = 1;\nreturn (x + 2);"
        );
        assert_eq!(page_script_body("const x = 1;\nx + 2").unwrap(), "const x = 1;\nreturn (x + 2);");
        assert_eq!(page_script_body("const x = 1;").unwrap(), "const x = 1;");
        assert_eq!(page_script_body("let x = 1;").unwrap(), "let x = 1;");
        assert_eq!(page_script_body("function f() { return 1; }").unwrap(), "function f() { return 1; }");
        assert_eq!(page_script_body("async function f() { return 1; }").unwrap(), "async function f() { return 1; }");
        assert_eq!(
            page_script_body("await fetch('/')").unwrap(),
            "return (await fetch('/'));"
        );
        assert_eq!(
            page_script_body("(async () => ({ a: 1 / 2 }))()").unwrap(),
            "return ((async () => ({ a: 1 / 2 }))());"
        );
        // Empty trailing statement should not wrap
        assert_eq!(page_script_body("1;;").unwrap(), "1;;");
        // Regex vs division after condition parens and inside templates
        assert_eq!(
            page_script_body("if (cond) /abc\\/def/.test(x);\nconst s = `val=${a / b}`;\ns").unwrap(),
            "if (cond) /abc\\/def/.test(x);\nconst s = `val=${a / b}`;\nreturn (s);"
        );
        // Unclosed delimiter fails cleanly
        assert!(page_script_body("foo(1, 2").is_err());
        assert!(page_script_body("const s = `unclosed ${1`").is_err());
    }

    #[test]
    fn extension_id_and_legacy_discovery_and_windows_profile_work() {
        let dir = TempDir::new().unwrap();
        let ext_dir = dir.path().join("yomitan");
        fs::create_dir_all(&ext_dir).unwrap();
        fs::write(
            ext_dir.join("manifest.json"),
            r#"{"name":"Yomitan","version":"1.0","key":"AAECAw=="}"#,
        )
        .unwrap();
        let manifest = read_manifest(&ext_dir).unwrap();
        let id = extension_id_for_directory(&ext_dir, &manifest, false);
        assert!(is_valid_extension_id(&id));

        // Legacy profile directory
        let session_dir = dir.path().join("session");
        let idb = session_dir
            .join("IndexedDB")
            .join(format!("chrome-extension_{id}_0.indexeddb.leveldb"));
        let settings = session_dir.join("Local Extension Settings").join(&id);
        fs::create_dir_all(&idb).unwrap();
        fs::create_dir_all(&settings).unwrap();
        fs::write(settings.join("data.ldb"), b"leveldb").unwrap();
        fs::write(settings.join("LOCK"), b"lock").unwrap();

        let found = find_legacy_dictionary(&session_dir, &id, &ext_dir).unwrap();
        assert_eq!(found.id, id);

        prepare_windows_profile(&session_dir).unwrap();
        let profile = browser_profile_dir(&session_dir);
        assert!(profile.join(".gsm-extension-profile-v1").exists());
        assert!(profile
            .join("Local Extension Settings")
            .join(&id)
            .join("data.ldb")
            .exists());
        assert!(!profile
            .join("Local Extension Settings")
            .join(&id)
            .join("LOCK")
            .exists());
    }

    #[test]
    fn inspect_dictionary_zip_detects_yomitan_and_rejects_traversal() {
        let dir = TempDir::new().unwrap();
        let ok_zip = dir.path().join("dict.zip");
        {
            let file = fs::File::create(&ok_zip).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("index.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(br#"{"title":"JMDict","format":3,"revision":"2026.1"}"#)
                .unwrap();
            zip.start_file("term_bank_1.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"[]").unwrap();
            zip.finish().unwrap();
        }
        let summary = inspect_dictionary_zip(&ok_zip).unwrap();
        assert_eq!(summary.entry_count, 2);
        assert_eq!(summary.format, "yomitan");
        assert_eq!(summary.title.as_deref(), Some("JMDict"));
        assert_eq!(summary.revision.as_deref(), Some("2026.1"));
    }

    #[test]
    fn bench_page_script_body_10kb() {
        let mut script = String::with_capacity(11_000);
        for i in 0..250 {
            script.push_str(&format!(
                "const item_{i} = (x) => /re_{i}\\/ok/i.test(`v=${{x / {n}}}`);\n",
                n = i + 1
            ));
        }
        script.push_str("item_0('v=1')");
        let start = Instant::now();
        for _ in 0..100 {
            let out = page_script_body(&script).unwrap();
            assert!(out.ends_with("return (item_0('v=1'));"));
        }
        let elapsed = start.elapsed();
        eprintln!(
            "[bench] page_script_body_10k_100x total_ms={:.3} us_per_parse={:.2}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / 100.0
        );
    }

    #[test]
    fn bench_extension_content_revision_synthetic() {
        let dir = TempDir::new().unwrap();
        for i in 0..150 {
            let sub = dir.path().join(format!("dir_{}", i % 10));
            fs::create_dir_all(&sub).unwrap();
            fs::write(sub.join(format!("file_{i}.js")), vec![b'a' + (i % 26) as u8; 4096]).unwrap();
        }
        let start = Instant::now();
        let rev = extension_content_revision(dir.path()).unwrap();
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(rev.len(), 64);
        eprintln!("[bench] extension_content_revision_150_files_600kb ms={elapsed_ms:.3}");
    }

    #[test]
    fn bench_dictionary_zip_inspect_500_entries() {
        let dir = TempDir::new().unwrap();
        let zip_path = dir.path().join("bench.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = SimpleFileOptions::default();
            zip.start_file("index.json", opts).unwrap();
            zip.write_all(br#"{"title":"BenchDict","format":3,"revision":"1"}"#)
                .unwrap();
            for i in 0..500 {
                zip.start_file(format!("term_bank_{i}.json"), opts).unwrap();
                zip.write_all(b"[[\"word\",\"reading\"]]").unwrap();
            }
            zip.finish().unwrap();
        }
        let start = Instant::now();
        let summary = inspect_dictionary_zip(&zip_path).unwrap();
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(summary.entry_count, 501);
        eprintln!("[bench] dictionary_zip_inspect_501_entries ms={elapsed_ms:.3}");
    }
}
