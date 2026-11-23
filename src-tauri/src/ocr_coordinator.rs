//! Native OCR coordinator owning OCR config/backups, replacements, model status,
//! preview captures/areas, dependency installs, furigana preview, and native/Python OCR runtime sessions.

pub(crate) mod meiki;
pub(crate) mod area_selector;
pub(crate) mod desktop_selector;
pub(crate) mod vocr;
use crate::desktop_services::paths_for;
use crate::desktop_state::emit_to_desktop_windows;
use crate::native::{dialog_message, shell_open_path};
use crate::obs::Obs;
use crate::ocr::Ocr;
use crate::python_ops;
use crate::runtime;
use gsm_settings::paths::owocr_config_path;
use gsm_settings::preferences::Preferences;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) const NATIVE_ENGINES: &[&str] = &[
    "oneocr",
    "screenai",
    "lens",
    "glens",
    "meikiocr",
    "meiki_text_detector",
    "vitaocr",
    "vocr_detector",
    "mida_detector",
    "mida_vocr",
    "vocr_lens",
    "alivetext",
    "bing",
    "gvision",
];

const MAX_AREA_BACKUPS: usize = 10;
const SCENE_CONFIG_DEBOUNCE: Duration = Duration::from_millis(500);
const CONTEXT_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(1500);
const MAX_DELIVERY_QUEUE: usize = 16;

static OCR_FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OcrRunMode {
    Auto,
    Manual,
    SsOnly,
}

impl OcrRunMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
            Self::SsOnly => "ss-only",
        }
    }

    fn runtime_mode(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual | Self::SsOnly => "manual",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OcrStartSource {
    User,
    Auto,
    #[allow(dead_code)]
    System,
}

impl OcrStartSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Auto => "auto",
            Self::System => "system",
        }
    }
}

#[derive(Clone, Debug)]
struct ActiveSession {
    id: String,
    generation: u64,
    source: OcrStartSource,
    mode: OcrRunMode,
    paused: bool,
    native: bool,
    force_stable: bool,
    last_activity: Option<Value>,
    config: Value,
    stop_flag: Arc<AtomicBool>,
}

struct PythonOcrProcess {
    generation: u64,
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct OcrState {
    generation: u64,
    active: Option<ActiveSession>,
    python_proc: Option<PythonOcrProcess>,
    delivery_queue: VecDeque<(String, String, Value)>,
    delivery_worker_active: bool,
    scene_debounce: HashMap<PathBuf, u64>,
}

#[derive(Default)]
pub struct OcrCoordinator(Arc<Mutex<OcrState>>);

impl OcrCoordinator {
    pub fn is_running(&self) -> bool {
        let state = self.0.lock().unwrap();
        state.active.is_some() || state.python_proc.is_some()
    }

    pub fn active_source(&self) -> Option<OcrStartSource> {
        self.0
            .lock()
            .unwrap()
            .active
            .as_ref()
            .map(|s| s.source.clone())
    }

    pub fn running_snapshot(&self) -> Value {
        let state = self.0.lock().unwrap();
        let active = state.active.as_ref();
        json!({
            "isRunning": active.is_some() || state.python_proc.is_some(),
            "source": active.map(|s| s.source.as_str()),
            "mode": active.map(|s| s.mode.as_str()),
        })
    }

    pub fn shutdown(&self, app: &tauri::AppHandle) {
        stop_ocr_sync(app, "app-shutdown", None);
    }
}

/// Sanitize a scene name identically to Python's `sanitize_filename` / Electron `ocr.ts`.
pub fn sanitize_ocr_filename(filename: &str) -> String {
    let cleaned: String = filename
        .chars()
        .filter(|&c| {
            !matches!(
                c,
                ' ' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\x00'..='\x1F'
            )
        })
        .collect();
    if cleaned.trim().is_empty() {
        "Default".to_owned()
    } else {
        cleaned
    }
}

/// Compute the deterministic area-config revision matching `electron-src/shared/ocr_areas.ts`.
pub fn get_ocr_area_revision(config: &Value) -> String {
    let coord = config
        .get("coordinate_system")
        .and_then(Value::as_str)
        .unwrap_or("");
    let rects = config
        .get("rectangles")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    serde_json::to_string(&(coord, rects)).unwrap_or_else(|_| "[\"\",[]]".to_owned())
}

pub fn is_native_ocr_supported(ocr_config: &Value, manual: bool) -> bool {
    if !crate::app_lifecycle::native_session_requested() && (std::env::var("GSM_DISABLE_NATIVE_OCR").as_deref() == Ok("1")
        || ocr_config.get("disableNativeOcr").and_then(Value::as_bool) == Some(true))
    {
        return false;
    }
    let settings = runtime_ocr_settings(ocr_config.clone());
    let is_engine_supported = |name: &str| NATIVE_ENGINES.contains(&name);
    let ocr1 = settings["ocr1"].as_str().unwrap_or("");
    let ocr2 = settings["ocr2"].as_str().filter(|s| !s.is_empty()).unwrap_or(ocr1);
    if (!manual && !is_engine_supported(ocr1)) || !is_engine_supported(ocr2) {
        return false;
    }
    let menu_engine = ocr_config
        .get("menuAreaOcrEngine")
        .and_then(Value::as_str)
        .unwrap_or("main");
    matches!(menu_engine, "" | "main" | "glens" | "bing") || is_engine_supported(menu_engine)
}

fn default_ocr_config() -> Value {
    json!({
        "twoPassOCR": true,
        "optimize_second_scan": true,
        "text_appears_instantly": false,
        "advanced_debug_logging": false,
        "useOnlineOcr": false,
        "ocr1": "screenai",
        "ocr2": "glens",
        "menuAreaOcrEngine": "main",
        "scanRate": 0.5,
        "language": "ja",
        "ocr_screenshots": false,
        "furigana_filter_sensitivity": 0,
        "defaultSceneFuriganaFilterSensitivity": 0,
        "gamepadHotkeysEnabled": true,
        "manualOcrHotkey": "Ctrl+Shift+G",
        "manualOcrGamepad": "",
        "manualOcrDelayMs": 0,
        "manualOcrDelayGamepadOnly": true,
        "menuOcrHotkey": "",
        "menuOcrGamepad": "",
        "areaSelectOcrHotkey": "Ctrl+Shift+O",
        "areaSelectOcrGamepad": "",
        "addAreaOcrHotkey": "Alt+Shift+N",
        "addAreaOcrGamepad": "",
        "wholeWindowOcrHotkey": "Ctrl+Shift+W",
        "wholeWindowOcrGamepad": "",
        "globalPauseHotkey": "Ctrl+Shift+P",
        "globalPauseGamepad": "",
        "sendToClipboard": false,
        "send_to_clipboard_auto": null,
        "send_to_clipboard_menu": null,
        "send_to_clipboard_area_select": null,
        "advancedMode": false,
        "base_scale": 1.0,
        "duplicate_similarity_threshold": 80,
        "change_detection_threshold": 5,
        "pile_up_prevention_wait_time": 0,
        "keep_newline": false,
        "obs_capture_preprocess": "none",
    })
}

fn read_json_object(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed serializing {}: {e}", path.display()))?;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    fs::write(&tmp, body).map_err(|e| format!("Failed writing {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed renaming {}: {e}", path.display())
    })
}

fn replace_retired_ocr_engines(config: &mut Value) {
    for (key, fallback) in [
        ("ocr1", "screenai"),
        ("ocr2", "screenai"),
        ("ocr1_advanced", "screenai"),
        ("ocr2_advanced", "screenai"),
        ("menuAreaOcrEngine", "main"),
    ] {
        if config[key].as_str().is_some_and(|engine| {
            matches!(
                engine.trim().to_ascii_lowercase().as_str(),
                "mlkitocr"
                    | "local_llm_ocr"
                    | "gemini"
                    | "ocrspace"
                    | "azure"
                    | "easyocr"
                    | "rapidocr"
                    | "groq"
                    | "paddleocr"
                    | "paddle_text_detector"
                    | "opencv_east_text_detector"
                    | "mangaocr"
                    | "mangaocrs"
            )
        }) {
            config[key] = json!(fallback);
        }
    }
}

pub fn read_ocr_config(app: &tauri::AppHandle) -> Value {
    let paths = paths_for(app);
    let _lock = OCR_FILE_LOCK.lock().unwrap();
    let store = read_json_object(&paths.active.join("electron/config.json"));
    let mut merged = default_ocr_config();
    if let (Some(base), Some(stored)) = (
        merged.as_object_mut(),
        store.get("OCR").and_then(Value::as_object),
    ) {
        for (k, v) in stored {
            base.insert(k.clone(), v.clone());
        }
        // Apply hotkeys defaults when key missing or null
        if base.get("addAreaOcrHotkey").is_none_or(Value::is_null) {
            base.insert("addAreaOcrHotkey".into(), json!("Alt+Shift+N"));
        }
    }
    replace_retired_ocr_engines(&mut merged);
    merged
}

pub fn save_ocr_config(app: &tauri::AppHandle, next: &Value) -> Result<Value, String> {
    let paths = paths_for(app);
    let config_path = paths.active.join("electron/config.json");
    let _lock = OCR_FILE_LOCK.lock().unwrap();
    let mut store = read_json_object(&config_path);
    let mut merged = default_ocr_config();
    if let Some(base) = merged.as_object_mut() {
        if let Some(existing) = store.get("OCR").and_then(Value::as_object) {
            for (k, v) in existing {
                base.insert(k.clone(), v.clone());
            }
        }
        if let Some(incoming) = next.as_object() {
            for (k, v) in incoming {
                base.insert(k.clone(), v.clone());
            }
        }
    }
    replace_retired_ocr_engines(&mut merged);
    store.insert("OCR".into(), merged.clone());
    write_json_atomic(&config_path, &Value::Object(store))?;
    Ok(merged)
}

pub fn ocr_config_paths(base_dir: &Path, scene_name: &str) -> (PathBuf, PathBuf) {
    let sanitized = sanitize_ocr_filename(scene_name);
    let dir = base_dir.join("ocr_config");
    (
        dir.join(format!("{sanitized}.json")),
        dir.join(format!("{sanitized}_config.json")),
    )
}

pub fn read_scene_areas(base_dir: &Path, scene_name: &str) -> Value {
    let (area_path, _) = ocr_config_paths(base_dir, scene_name);
    let _lock = OCR_FILE_LOCK.lock().unwrap();
    if let Ok(raw) = fs::read_to_string(&area_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if val.is_object() {
                return val;
            }
        }
    }
    json!({
        "scene": scene_name,
        "coordinate_system": "",
        "window_geometry": { "left": 0, "top": 0, "width": 0, "height": 0 },
        "rectangles": [],
    })
}

pub fn backup_ocr_config(area_path: &Path) -> Result<Option<PathBuf>, String> {
    if !area_path.is_file() {
        return Ok(None);
    }
    let scene_name = area_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Default");
    let backup_dir = area_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backup")
        .join(scene_name);
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed creating backup dir {}: {e}", backup_dir.display()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let backup_path = backup_dir.join(format!("{scene_name}_{stamp}.json"));
    fs::copy(area_path, &backup_path)
        .map_err(|e| format!("Failed backing up {}: {e}", area_path.display()))?;

    if let Ok(entries) = fs::read_dir(&backup_dir) {
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect();
        if files.len() > MAX_AREA_BACKUPS {
            files.sort();
            let remove_count = files.len() - MAX_AREA_BACKUPS;
            for old in files.into_iter().take(remove_count) {
                let _ = fs::remove_file(old);
            }
        }
    }
    Ok(Some(backup_path))
}

pub fn read_scene_settings(base_dir: &Path, scene_name: &str, ocr_config: &Value) -> Value {
    let (_, settings_path) = ocr_config_paths(base_dir, scene_name);
    let _lock = OCR_FILE_LOCK.lock().unwrap();
    if let Ok(raw) = fs::read_to_string(&settings_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if val.is_object() {
                return val;
            }
        }
    }
    let default_furi = ocr_config
        .get("defaultSceneFuriganaFilterSensitivity")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    json!({ "furigana_filter_sensitivity": default_furi })
}

fn schedule_scene_settings_write(
    state: &Arc<Mutex<OcrState>>,
    settings_path: PathBuf,
    payload: Value,
) {
    let token = {
        let mut s = state.lock().unwrap();
        let next = s
            .scene_debounce
            .get(&settings_path)
            .copied()
            .unwrap_or(0)
            .wrapping_add(1);
        s.scene_debounce.insert(settings_path.clone(), next);
        next
    };
    let shared = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SCENE_CONFIG_DEBOUNCE).await;
        let still_latest = {
            let mut s = shared.lock().unwrap();
            let current = s.scene_debounce.get(&settings_path).copied();
            if current == Some(token) {
                s.scene_debounce.remove(&settings_path);
                true
            } else {
                false
            }
        };
        if still_latest {
            let _lock = OCR_FILE_LOCK.lock().unwrap();
            let _ = write_json_atomic(&settings_path, &payload);
        }
    });
}

fn replacements_path(base_dir: &Path) -> PathBuf {
    base_dir.join("config").join("ocr_replacements.json")
}

pub fn load_ocr_replacements(base_dir: &Path) -> Value {
    let path = replacements_path(base_dir);
    let _lock = OCR_FILE_LOCK.lock().unwrap();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(map) = val
                .get("args")
                .and_then(|a| a.get("replacements"))
                .and_then(Value::as_object)
            {
                return Value::Object(map.clone());
            }
        }
    }
    json!({})
}

pub fn read_enabled_ocr_replacements_entries(base_dir: &Path) -> Vec<(String, String)> {
    let path = replacements_path(base_dir);
    let _lock = OCR_FILE_LOCK.lock().unwrap();
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    if val.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    val.get("args")
        .and_then(|a| a.get("replacements"))
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

pub fn save_ocr_replacements(base_dir: &Path, replacements: &Value) -> Result<Value, String> {
    let path = replacements_path(base_dir);
    let _lock = OCR_FILE_LOCK.lock().unwrap();
    let mut current = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    current
        .entry("enabled".to_owned())
        .or_insert(Value::Bool(true));
    let mut args = current
        .get("args")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    args.insert(
        "replacements".into(),
        if replacements.is_object() {
            replacements.clone()
        } else {
            json!({})
        },
    );
    current.insert("args".into(), Value::Object(args));
    write_json_atomic(&path, &Value::Object(current))?;
    Ok(json!({ "success": true }))
}

pub async fn resolve_active_scene_name(
    app: &tauri::AppHandle,
    requested_scene: Option<&str>,
) -> String {
    if let Some(s) = requested_scene.map(str::trim).filter(|s| !s.is_empty()) {
        return s.to_owned();
    }
    if let Some(obs) = app.try_state::<Obs>() {
        if let Some(scene) = obs.game_session()["scene"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            return scene.to_owned();
        }
    }
    "Default".to_owned()
}

fn should_enable_keep_newline(ocr_config: &Value) -> bool {
    let specific: Vec<bool> = [
        "keep_newline_auto",
        "keep_newline_menu",
        "keep_newline_area_select",
    ]
    .iter()
    .filter_map(|k| ocr_config.get(*k).and_then(Value::as_bool))
    .collect();
    if !specific.is_empty() {
        return specific.into_iter().any(|v| v);
    }
    ocr_config
        .get("keep_newline")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn append_hotkey_args(args: &mut Vec<String>, ocr_config: &Value) {
    let pairs = [
        ("--area_select_ocr_hotkey", "areaSelectOcrHotkey", ""),
        ("--add_area_ocr_hotkey", "addAreaOcrHotkey", "Alt+Shift+N"),
        ("--manual_ocr_hotkey", "manualOcrHotkey", ""),
        ("--menu_ocr_hotkey", "menuOcrHotkey", ""),
        ("--whole_window_ocr_hotkey", "wholeWindowOcrHotkey", ""),
        ("--global_pause_hotkey", "globalPauseHotkey", ""),
    ];
    for (flag, key, fallback) in pairs {
        args.push(flag.into());
        args.push(
            ocr_config
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or(fallback)
                .to_owned(),
        );
    }
}

async fn build_native_ocr_config(
    app: &tauri::AppHandle,
    mode: &OcrRunMode,
    ocr_config: &Value,
    context: &Value,
    input_url: &Option<String>,
) -> Value {
    let paths = paths_for(app);
    let scene = context
        .get("scene")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "Default".to_owned());

    let areas = read_scene_areas(&paths.active, &scene);
    let scene_settings = read_scene_settings(&paths.active, &scene, ocr_config);
    let mut settings = native_ocr_settings(ocr_config, &scene_settings);
    if settings["ocr2"].as_str().is_none_or(str::is_empty) {
        settings["ocr2"] = settings["ocr1"].clone();
    }
    if *mode != OcrRunMode::Auto {
        settings["ocr1"] = settings["ocr2"].clone();
    }

    let obs_startup = app
        .try_state::<Obs>()
        .and_then(|obs| obs.startup_config().ok())
        .unwrap_or_else(|| json!({}));

    let replacements: Value = read_enabled_ocr_replacements_entries(&paths.active)
        .into_iter()
        .map(|(k, v)| json!([k, v]))
        .collect::<Vec<_>>()
        .into();

    let source_name = context.get("source_name").cloned().unwrap_or(Value::Null);
    let target_id = context.get("target_id").cloned().unwrap_or(Value::Null);
    let capture_kind = context.get("capture_kind").cloned().unwrap_or(Value::Null);
    let capture_source = context
        .get("capture_source")
        .cloned()
        .unwrap_or(Value::Null);
    let process_path = context.get("process_path").cloned().unwrap_or(Value::Null);
    let available = context
        .get("available")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    json!({
        "profile": paths.active.to_string_lossy(),
        "mode": mode.runtime_mode(),
        "screenshot_only": *mode == OcrRunMode::SsOnly,
        "settings": settings,
        "input_url": input_url,
        "obs": obs_startup,
        "areas": areas,
        "replacements": replacements,
        "scene": scene,
        "source_name": source_name,
        "target_id": target_id,
        "capture_kind": capture_kind,
        "capture_source": capture_source,
        "process_path": process_path,
        "available": available,
    })
}

fn runtime_ocr_settings(mut settings: Value) -> Value {
    if settings["advancedMode"] == false {
        settings["ocr1"] = json!("screenai");
        settings["ocr2"] = json!(if settings["useOnlineOcr"] == true { "glens" } else { "screenai" });
        settings["twoPassOCR"] = json!(true);
        settings["optimize_second_scan"] = json!(true);
    }
    settings
}

fn native_ocr_settings(ocr_config: &Value, scene_settings: &Value) -> Value {
    let mut settings = runtime_ocr_settings(ocr_config.clone());
    if let Some(obj) = settings.as_object_mut() {
        // The first heartbeat includes this value. Normalize it from the first
        // start too, or an otherwise unchanged heartbeat cancels a manual scan.
        obj.insert(
            "force_stable".into(),
            json!(ocr_config["force_stable"].as_bool().unwrap_or(false)),
        );
        if let Some(furi) = scene_settings.get("furigana_filter_sensitivity") {
            obj.insert("furigana_filter_sensitivity".into(), furi.clone());
        }
    }
    settings
}

async fn fetch_native_context(app: &tauri::AppHandle) -> Value {
    app.state::<Obs>().game_session()
}

async fn request_ocr_backend(
    rt: &gsm_runtime::Runtime,
    topic: &str,
    data: Value,
    timeout_ms: u64,
) -> Result<Value, String> {
    rt.call(
        "bus.request",
        json!({"dst":"backend", "topic":topic, "data":data, "timeoutMs":timeout_ms}),
    )
    .await
}

pub fn stop_ocr_sync(
    app: &tauri::AppHandle,
    reason: &str,
    only_if_source: Option<&OcrStartSource>,
) -> bool {
    let Some(coord) = app.try_state::<OcrCoordinator>() else {
        return false;
    };
    let (was_native, session_id, python_child, stopped) = {
        let mut s = coord.0.lock().unwrap();
        if let Some(req_source) = only_if_source {
            if s.active.as_ref().map(|a| &a.source) != Some(req_source) {
                return false;
            }
        }
        let had_active = s.active.is_some() || s.python_proc.is_some();
        if !had_active {
            return false;
        }
        s.generation += 1;
        s.delivery_queue.clear();
        let active = s.active.take();
        if let Some(ref a) = active {
            a.stop_flag.store(true, Ordering::SeqCst);
        }
        let py = s.python_proc.take();
        (
            active.as_ref().is_some_and(|a| a.native),
            active.as_ref().map(|a| a.id.clone()).unwrap_or_default(),
            py,
            true,
        )
    };
    if !stopped {
        return false;
    }

    if was_native {
        if let Some(ocr) = app.try_state::<Ocr>() {
            let _ =
                ocr.command(json!({ "action": "stop", "session": session_id, "reason": reason }));
            if matches!(reason, "app-shutdown" | "data-relocate") {
                let _ = ocr.wait_stopped();
            }
        }
        emit_to_desktop_windows(app, "ocr-ipc-stopped", &[]);
    }
    if let Some(mut py) = python_child {
        if let Some(mut stdin) = py.stdin.take() {
            let _ = writeln!(
                stdin,
                "{}",
                python_ocr_command("stop", json!({"reason":reason}))
            );
        }
        std::thread::spawn(move || {
            for _ in 0..20 {
                if let Ok(Some(_)) = py.child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = py.child.kill();
        });
    }
    emit_to_desktop_windows(app, "ocr-stopped", &[]);
    crate::text_intake::producer_activity(app, crate::text_intake::Producer::Ocr, false);
    true
}

pub async fn start_ocr(
    app: &tauri::AppHandle,
    source: OcrStartSource,
    mode: OcrRunMode,
) -> Result<(), String> {
    if !app
        .try_state::<python_ops::PythonOpsState>()
        .is_some_and(|s| s.is_backend_connected())
        && std::env::var("GSM_SMOKE_TEST").is_ok()
    {
        // Smoke tests may inspect commands without live Python backend unless requested.
    }
    if is_python_update_blocking(app) {
        return Err("Python environment maintenance is in progress.".into());
    }
    stop_ocr_sync(app, "restart", None);

    let ocr_config = read_ocr_config(app);
    if is_native_ocr_supported(&ocr_config, mode != OcrRunMode::Auto) {
        start_native_ocr(app, source, mode, ocr_config).await
    } else if crate::app_lifecycle::native_session_requested() {
        Err("The saved OCR engine is unavailable. Choose an installed engine in OCR settings.".into())
    } else {
        start_python_ocr(app, source, mode, ocr_config).await
    }
}

fn is_python_update_blocking(app: &tauri::AppHandle) -> bool {
    app.try_state::<crate::python_install::PythonInstall>()
        .map(|pi| pi.gate.try_lock().is_err())
        .unwrap_or(false)
}

async fn start_native_ocr(
    app: &tauri::AppHandle,
    source: OcrStartSource,
    mode: OcrRunMode,
    ocr_config: Value,
) -> Result<(), String> {
    let Some(coord) = app.try_state::<OcrCoordinator>() else {
        return Err("OcrCoordinator state is unavailable".into());
    };
    let Some(ocr) = app.try_state::<Ocr>() else {
        return Err("Native OCR engine is unavailable".into());
    };

    let context = fetch_native_context(app).await;
    let app_for_wait = app.clone();
    let input_url = tauri::async_runtime::spawn_blocking(move || {
        crate::input_server::wait_ready(&app_for_wait, Duration::from_secs(3))
            .map(|(_port, url)| url)
            .or_else(|| crate::input_server::url(&app_for_wait))
            .or_else(|| std::env::var("GSM_INPUT_SERVER_URL").ok())
    })
    .await
    .ok()
    .flatten();

    let config = build_native_ocr_config(app, &mode, &ocr_config, &context, &input_url).await;
    let session_id = uuid::Uuid::new_v4().to_string();
    let stop_flag = Arc::new(AtomicBool::new(false));

    let generation = {
        let mut s = coord.0.lock().unwrap();
        s.generation += 1;
        let gen = s.generation;
        s.active = Some(ActiveSession {
            id: session_id.clone(),
            generation: gen,
            source,
            mode: mode.clone(),
            paused: false,
            native: true,
            force_stable: config["settings"]["force_stable"]
                .as_bool()
                .unwrap_or(false),
            last_activity: None,
            config: config.clone(),
            stop_flag: stop_flag.clone(),
        });
        gen
    };

    match ocr.command(json!({
        "action": "start",
        "session": session_id,
        "config": config,
    })) {
        Ok(status) => {
            emit_to_desktop_windows(app, "ocr-started", &[]);
            emit_to_desktop_windows(app, "ocr-ipc-started", &[]);
            let scene = config["scene"].as_str().unwrap_or("");
            let msg = if scene.is_empty() {
                "Started native Rust OCR session.".to_owned()
            } else {
                format!("Started native Rust OCR session (scene: {scene}).")
            };
            emit_ocr_log(app, "rust:ocr", &msg);
            crate::desktop_log::background(app, "ocr", &msg);
            publish_native_status(app, &status, true);
            crate::text_intake::producer_activity(app, crate::text_intake::Producer::Ocr, true);
            spawn_context_heartbeat(app.clone(), generation, session_id, stop_flag, input_url);
            Ok(())
        }
        Err(err) => {
            let mut s = coord.0.lock().unwrap();
            if s.generation == generation {
                s.active = None;
            }
            emit_to_desktop_windows(app, "ocr-ipc-error", &[json!(err)]);
            emit_to_desktop_windows(app, "ocr-stopped", &[]);
            crate::text_intake::producer_activity(app, crate::text_intake::Producer::Ocr, false);
            Err(err)
        }
    }
}

fn spawn_context_heartbeat(
    app: tauri::AppHandle,
    generation: u64,
    session_id: String,
    stop_flag: Arc<AtomicBool>,
    input_url: Option<String>,
) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(CONTEXT_HEARTBEAT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            let Some(coord) = app.try_state::<OcrCoordinator>() else {
                break;
            };
            let current = {
                let s = coord.0.lock().unwrap();
                s.active
                    .as_ref()
                    .filter(|a| a.generation == generation && a.native)
                    .map(|a| (a.mode.clone(), a.force_stable))
            };
            let Some((mode, force_stable)) = current else {
                break;
            };

            let context = fetch_native_context(&app).await;
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            let mut ocr_config = read_ocr_config(&app);
            if let Some(obj) = ocr_config.as_object_mut() {
                obj.insert("force_stable".into(), json!(force_stable));
            }
            let current_input_url = crate::input_server::url(&app).or_else(|| input_url.clone());
            let next_config =
                build_native_ocr_config(&app, &mode, &ocr_config, &context, &current_input_url).await;

            if let Some(ocr) = app.try_state::<Ocr>() {
                match ocr.command(json!({
                    "action": "configure",
                    "session": session_id,
                    "config": next_config,
                })) {
                    Ok(status) => {
                        if let Ok(mut s) = coord.0.try_lock() {
                            if let Some(active) = s.active.as_mut() {
                                active.config = next_config;
                            }
                        }
                        publish_native_status(&app, &status, false);
                    }
                    Err(_) => break,
                }
            }
        }
    });
}

fn publish_native_status(app: &tauri::AppHandle, status: &Value, force: bool) {
    let Some(coord) = app.try_state::<OcrCoordinator>() else {
        return;
    };
    let next_activity = status.get("auto_activity").cloned();
    let changed = {
        let mut s = coord.0.lock().unwrap();
        if let Some(active) = s.active.as_mut() {
            let diff = active.last_activity != next_activity;
            active.last_activity = next_activity;
            diff
        } else {
            false
        }
    };
    if changed || force {
        emit_to_desktop_windows(app, "ocr-ipc-status", &[status.clone()]);
    }
}

fn configure_obs_reader(app: &tauri::AppHandle, cmd: &mut Command) -> Result<(), String> {
    let broker = crate::runtime::get(app)?.info();
    cmd.env("GSM_PROFILE_DIR", &paths_for(app).active)
        .env("GSM_OBS_READER_PORT", broker["port"].as_u64().ok_or("Desktop bus unavailable")?.to_string())
        .env("GSM_OBS_READER_TOKEN", broker["token"].as_str().ok_or("Desktop bus unavailable")?)
        .env_remove("GSM_OBS_BACKEND_PID")
        .env_remove("GSM_BROKER_PORT")
        .env_remove("GSM_BROKER_TOKEN")
        .env_remove("GSM_CLIENT_ID");
    Ok(())
}

async fn start_python_ocr(
    app: &tauri::AppHandle,
    source: OcrStartSource,
    mode: OcrRunMode,
    ocr_config: Value,
) -> Result<(), String> {
    let python_path = python_ops::ensure_python_path(app).await?;
    let Some(coord) = app.try_state::<OcrCoordinator>() else {
        return Err("OcrCoordinator unavailable".into());
    };
    let ocr_config = runtime_ocr_settings(ocr_config);
    let lang = ocr_config["language"].as_str().unwrap_or("ja");
    let ocr1 = ocr_config["ocr1"].as_str().unwrap_or("screenai");
    let ocr2 = ocr_config["ocr2"].as_str().unwrap_or("glens");
    let two_pass = ocr_config["twoPassOCR"].as_bool().unwrap_or(true);
    let adv = ocr_config["advancedMode"].as_bool().unwrap_or(false);
    let screenshots = ocr_config["ocr_screenshots"].as_bool().unwrap_or(false);
    let send_clip = ocr_config["sendToClipboard"].as_bool().unwrap_or(false);
    let furi = ocr_config["furigana_filter_sensitivity"]
        .as_f64()
        .unwrap_or(0.0);
    let optimize = ocr_config["optimize_second_scan"].as_bool().unwrap_or(true);

    let mut args = vec![
        "-m".to_owned(),
        "GameSentenceMiner.ocr.gsm_ocr".to_owned(),
        "--language".to_owned(),
        lang.to_owned(),
    ];
    match mode {
        OcrRunMode::Auto => {
            args.extend([
                "--ocr1".into(),
                ocr1.into(),
                "--ocr2".into(),
                ocr2.into(),
                "--twopassocr".into(),
                if two_pass { "1" } else { "0" }.into(),
                "--obs_ocr".into(),
            ]);
            if screenshots && adv {
                args.push("--clipboard".into());
            }
            if optimize || !adv {
                args.push("--optimize_second_scan".into());
            }
        }
        OcrRunMode::Manual => {
            args.extend([
                "--ocr1".into(),
                ocr2.into(),
                "--ocr2".into(),
                ocr2.into(),
                "--manual".into(),
                "--obs_ocr".into(),
            ]);
            if screenshots && adv {
                args.push("--clipboard".into());
            }
        }
        OcrRunMode::SsOnly => {
            args.extend([
                "--ocr1".into(),
                ocr2.into(),
                "--ocr2".into(),
                ocr2.into(),
                "--manual".into(),
                "--obs_ocr".into(),
            ]);
            if screenshots {
                args.push("--clipboard".into());
            }
        }
    }
    if send_clip {
        args.push("--clipboard-output".into());
    }
    if furi > 0.0 {
        args.extend(["--furigana_filter_sensitivity".into(), furi.to_string()]);
    }
    append_hotkey_args(&mut args, &ocr_config);
    if should_enable_keep_newline(&ocr_config) {
        args.push("--keep_newline".into());
    }

    let mut cmd = Command::new(&python_path);
    configure_obs_reader(app, &mut cmd)?;
    cmd.args(&args)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        let hide_console = matches!(
            (&source, &mode),
            (OcrStartSource::Auto | OcrStartSource::System, _)
                | (OcrStartSource::User, OcrRunMode::SsOnly)
        );
        if hide_console {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed starting Python OCR: {e}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let session_id = uuid::Uuid::new_v4().to_string();
    let generation = {
        let mut s = coord.0.lock().unwrap();
        s.generation += 1;
        let gen = s.generation;
        s.active = Some(ActiveSession {
            id: session_id.clone(),
            generation: gen,
            source,
            mode,
            paused: false,
            native: false,
            force_stable: false,
            last_activity: None,
            config: json!({}),
            stop_flag: Arc::new(AtomicBool::new(false)),
        });
        s.python_proc = Some(PythonOcrProcess {
            generation: gen,
            child,
            stdin,
        });
        gen
    };

    emit_to_desktop_windows(app, "ocr-started", &[]);
    emit_ocr_log(app, "rust:ocr-coordinator", "Started Python OCR process.");
    crate::desktop_log::background(app, "ocr-coordinator", "Started Python OCR process.");
    crate::text_intake::producer_activity(app, crate::text_intake::Producer::Ocr, true);

    if let Some(out) = stdout {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                match parse_python_ocr_event(&line) {
                    Ok(Some((event, data))) => {
                        on_session_ocr_event(&app_clone, &session_id, false, &event, data)
                    }
                    Ok(None) => emit_ocr_log(&app_clone, "py:ocr", &line),
                    Err(error) => {
                        emit_to_desktop_windows(&app_clone, "ocr-ipc-error", &[json!(error)])
                    }
                }
            }
        });
    }
    if let Some(err) = stderr {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                emit_ocr_log(&app_clone, "py:ocr", &line);
            }
        });
    }
    let app_wait = app.clone();
    let coord_arc = coord.0.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let exited = {
            let mut s = coord_arc.lock().unwrap();
            let Some(ref mut proc_ref) = s.python_proc else {
                break;
            };
            if proc_ref.generation != generation {
                break;
            }
            match proc_ref.child.try_wait() {
                Ok(Some(_status)) => {
                    s.python_proc = None;
                    s.active = None;
                    true
                }
                Ok(None) => false,
                Err(_) => {
                    s.python_proc = None;
                    s.active = None;
                    true
                }
            }
        };
        if exited {
            emit_to_desktop_windows(&app_wait, "ocr-stopped", &[]);
            crate::text_intake::producer_activity(&app_wait, crate::text_intake::Producer::Ocr, false);
            break;
        }
    });
    Ok(())
}

fn emit_ocr_log(app: &tauri::AppHandle, origin: &str, message: &str) {
    let payload = if message.trim() == "COMMAND_FINISHED" {
        message.to_owned()
    } else {
        crate::desktop_log::ensure_origin(origin, message)
    };
    emit_to_desktop_windows(app, "ocr-log", &[json!(payload)]);
}

/// Forward events raised by `crate::ocr::Ocr` (`emit(...)`) to backend ingestion and desktop windows.
pub fn on_native_ocr_event(app: &tauri::AppHandle, session: &str, event: &str, data: Value) {
    on_session_ocr_event(app, session, true, event, data);
}

fn parse_python_ocr_event(line: &str) -> Result<Option<(String, Value)>, String> {
    let Some(raw) = line.strip_prefix("OCRMSG:") else {
        return Ok(None);
    };
    let payload: Value =
        serde_json::from_str(raw).map_err(|e| format!("Invalid OCR message: {e}"))?;
    let event = payload["event"]
        .as_str()
        .ok_or("OCR message has no event")?;
    Ok(Some((event.to_owned(), payload["data"].clone())))
}

fn python_ocr_command(action: &str, data: Value) -> String {
    let action = if action == "status" {
        "get_status"
    } else {
        action
    };
    format!("OCRCMD:{}", json!({"command":action, "data":data}))
}

fn on_session_ocr_event(
    app: &tauri::AppHandle,
    session: &str,
    native: bool,
    event: &str,
    data: Value,
) {
    if std::env::var("GSM_SMOKE_TEST").is_ok() && matches!(event, "error" | "ocr_result") {
        eprintln!("[ocr smoke] {event}: {data}");
    }
    let Some(coord) = app.try_state::<OcrCoordinator>() else {
        return;
    };
    {
        let mut s = coord.0.lock().unwrap();
        let Some(active) = s.active.as_mut() else {
            return;
        };
        if active.native != native || active.id != session {
            return;
        }
        if event == "force_stable_changed" {
            active.force_stable = data["force_stable"].as_bool().unwrap_or(false);
        }
        if event == "ocr_result" {
            if s.delivery_queue.len() >= MAX_DELIVERY_QUEUE {
                drop(s);
                emit_to_desktop_windows(
                    app,
                    "ocr-ipc-error",
                    &[json!("OCR text delivery queue is full")],
                );
                return;
            }
            s.delivery_queue
                .push_back((session.to_owned(), event.to_owned(), data));
            if !s.delivery_worker_active {
                s.delivery_worker_active = true;
                drop(s);
                spawn_ocr_result_worker(app.clone(), coord.0.clone());
            }
            return;
        }
    }

    if event == "add_ocr_area" {
        open_add_area(app.clone());
        return;
    }

    emit_to_desktop_windows(
        app,
        "ocr-ipc-message",
        &[json!({ "event": event, "data": data })],
    );
    match event {
        "started" => emit_to_desktop_windows(app, "ocr-ipc-started", &[]),
        "stopped" => emit_to_desktop_windows(app, "ocr-ipc-stopped", &[]),
        "paused" => emit_to_desktop_windows(app, "ocr-ipc-paused", &[data]),
        "unpaused" => emit_to_desktop_windows(app, "ocr-ipc-unpaused", &[data]),
        "status" => emit_to_desktop_windows(app, "ocr-ipc-status", &[data]),
        "log" => {
            if let Some(msg) = data["message"].as_str() {
                let origin = if native { "rust:ocr" } else { "py:ocr" };
                emit_ocr_log(app, origin, msg);
            }
        }
        "error" => emit_to_desktop_windows(
            app,
            "ocr-ipc-error",
            &[json!(data["error"].as_str().unwrap_or("Unknown error"))],
        ),
        "config_reloaded" => emit_to_desktop_windows(app, "ocr-ipc-config-reloaded", &[]),
        "force_stable_changed" => {
            emit_to_desktop_windows(app, "ocr-ipc-force-stable-changed", &[data])
        }
        _ => {}
    }
}

fn spawn_ocr_result_worker(app: tauri::AppHandle, shared: Arc<Mutex<OcrState>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let item = {
                let mut s = shared.lock().unwrap();
                match s.delivery_queue.pop_front() {
                    Some(next) => Some(next),
                    None => {
                        s.delivery_worker_active = false;
                        None
                    }
                }
            };
            let Some((session_id, event_name, payload)) = item else {
                break;
            };
            let valid = {
                let s = shared.lock().unwrap();
                s.active.as_ref().is_some_and(|a| a.id == session_id)
            };
            if !valid {
                continue;
            }
            let ack = match runtime::get(&app) {
                Ok(rt) => if app.state::<crate::text_intake::Intake>().active() {
                    loop {
                        let receipt = crate::text_intake::submit(&app, payload.clone(), None).await;
                        if !matches!(&receipt, Ok(ack) if ack["status"] == "backpressured") {
                            break receipt;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        if !shared.lock().unwrap().active.as_ref().is_some_and(|a| a.id == session_id) {
                            break Err("OCR session ended during text delivery".into());
                        }
                    }
                } else {
                    request_ocr_backend(&rt, "ocr.native.result", payload.clone(), 5000).await
                }
                    .unwrap_or_else(|e| json!({ "status": "error", "reason": e })),
                Err(e) => {
                    emit_to_desktop_windows(&app, "ocr-ipc-error", &[json!(e)]);
                    continue;
                }
            };
            let excluded = ack["reason"]
                .as_str()
                .is_some_and(|r| r.contains("excluded"));
            if !matches!(ack["status"].as_str(), Some("accepted" | "duplicate")) && !excluded {
                let msg = ack["reason"].as_str().unwrap_or("OCR text delivery failed");
                emit_to_desktop_windows(&app, "ocr-ipc-error", &[json!(msg)]);
                continue;
            }
            let mut forwarded = payload;
            if excluded {
                if let Some(obj) = forwarded.as_object_mut() {
                    obj.insert("excluded".into(), json!(true));
                }
            }
            emit_to_desktop_windows(
                &app,
                "ocr-ipc-message",
                &[json!({ "event": event_name, "data": forwarded })],
            );
        }
    });
}

pub async fn reload_active_ocr(app: &tauri::AppHandle) {
    let Some(coord) = app.try_state::<OcrCoordinator>() else {
        return;
    };
    let active_info = {
        let s = coord.0.lock().unwrap();
        s.active
            .as_ref()
            .map(|a| (a.id.clone(), a.mode.clone(), a.native, a.force_stable))
    };
    let Some((session_id, mode, is_native, force_stable)) = active_info else {
        return;
    };
    if is_native {
        let context = fetch_native_context(app).await;
        let mut ocr_config = read_ocr_config(app);
        if let Some(obj) = ocr_config.as_object_mut() {
            obj.insert("force_stable".into(), json!(force_stable));
        }
        let input_url =
            crate::input_server::url(app).or_else(|| std::env::var("GSM_INPUT_SERVER_URL").ok());
        let next_config =
            build_native_ocr_config(app, &mode, &ocr_config, &context, &input_url).await;
        if let Some(ocr) = app.try_state::<Ocr>() {
            if ocr
                .command(json!({
                    "action": "configure",
                    "session": session_id,
                    "config": next_config,
                }))
                .is_ok()
            {
                if let Ok(mut s) = coord.0.try_lock() {
                    if let Some(active) = s.active.as_mut() {
                        active.config = next_config;
                    }
                }
                emit_to_desktop_windows(app, "ocr-ipc-config-reloaded", &[]);
            }
        }
    } else {
        let mut s = coord.0.lock().unwrap();
        if let Some(ref mut py) = s.python_proc {
            if let Some(ref mut stdin) = py.stdin {
                let _ = writeln!(stdin, r#"{{"command":"reload_config"}}"#);
            }
        }
    }
}

fn send_runtime_ocr_command(app: &tauri::AppHandle, action: &str, data: Value) {
    let Some(coord) = app.try_state::<OcrCoordinator>() else {
        emit_to_desktop_windows(app, "ocr-ipc-error", &[json!("No active OCR process")]);
        return;
    };
    let info = {
        let s = coord.0.lock().unwrap();
        s.active.as_ref().map(|a| (a.id.clone(), a.native))
    };
    let Some((session_id, is_native)) = info else {
        emit_to_desktop_windows(app, "ocr-ipc-error", &[json!("No active OCR process")]);
        return;
    };
    if is_native {
        if let Some(ocr) = app.try_state::<Ocr>() {
            let mut msg = json!({ "action": action, "session": session_id });
            if let Some(obj) = msg.as_object_mut() {
                if let Some(extra) = data.as_object() {
                    for (k, v) in extra {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
            match ocr.command(msg) {
                Ok(res) => {
                    publish_native_status(app, &res, action == "status");
                    if action == "force_stable_changed"
                        || action == "toggle_force_stable"
                        || action == "set_force_stable"
                    {
                        let fs = res["force_stable"].as_bool().unwrap_or(false);
                        if let Some(active) = coord.0.lock().unwrap().active.as_mut() {
                            active.force_stable = fs;
                        }
                        emit_to_desktop_windows(
                            app,
                            "ocr-ipc-force-stable-changed",
                            &[json!({ "force_stable": fs })],
                        );
                    }
                    if matches!(action, "pause" | "unpause" | "toggle_pause") {
                        let paused = res["paused"].as_bool().unwrap_or(false);
                        if let Some(active) = coord.0.lock().unwrap().active.as_mut() {
                            active.paused = paused;
                        }
                        emit_to_desktop_windows(
                            app,
                            if paused {
                                "ocr-ipc-paused"
                            } else {
                                "ocr-ipc-unpaused"
                            },
                            &[res],
                        );
                    }
                }
                Err(e) => emit_to_desktop_windows(app, "ocr-ipc-error", &[json!(e)]),
            }
        }
    } else {
        let mut s = coord.0.lock().unwrap();
        if let Some(ref mut py) = s.python_proc {
            if let Some(ref mut stdin) = py.stdin {
                let line = python_ocr_command(action, data);
                let _ = writeln!(stdin, "{line}");
            }
        }
    }
}

async fn run_screen_selector(
    app: &tauri::AppHandle,
    live: bool,
    add_area: bool,
) -> Result<bool, String> {
    let result = desktop_selector::open(
        app,
        desktop_selector::Options {
            obs: true,
            live,
            single: add_area,
            ..Default::default()
        },
    )
    .await;
    emit_to_desktop_windows(app, "ocr-log", &[json!("COMMAND_FINISHED")]);
    result.map(|value| !value.is_null())
}

fn open_add_area(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_screen_selector(&app, false, true).await {
            emit_ocr_log(&app, "rust:ocr-coordinator", &error);
        }
    });
}

pub async fn scan_scene_text(
    app: &tauri::AppHandle,
    scene: &str,
    capture: Arc<Mutex<gsm_capture::obs::Capture>>,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<Vec<String>, String> {
    let app = app.clone();
    let scene = scene.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        if cancelled() {
            return Ok(Vec::new());
        }
        let config = read_ocr_config(&app);
        let profile = paths_for(&app).active;
        let obs = app.state::<Obs>().startup_config()?;
        let language = config["language"].as_str().unwrap_or("ja");
        let frame = capture.lock().unwrap().grab(&obs, &scene)?;
        if cancelled() {
            return Ok(Vec::new());
        }
        let recognition = gsm_overlay::engines::Engines::new(&profile)
            .recognize(&frame, "screenai", language)
            .map_err(|err| err.to_string())?;
        Ok(gsm_overlay::pipeline::text_blocks(recognition, language))
    })
    .await
    .map_err(|err| err.to_string())?
}

async fn handle_get_preview(app: &tauri::AppHandle, req: Value) -> Value {
    let paths = paths_for(app);
    let scene_name =
        resolve_active_scene_name(app, req.get("sceneName").and_then(Value::as_str)).await;
    let scene_id = req
        .get("sceneId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let area_config = read_scene_areas(&paths.active, &scene_name);
    let revision = get_ocr_area_revision(&area_config);
    let include_boxes = req
        .get("includeBoxes")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut capture = match runtime::get(app) {
        Ok(rt) => rt
            .call(
                "bus.request",
                json!({
                    "dst": "backend",
                    "topic": "capture.preview",
                    "data": { "sceneId": scene_id, "sceneName": scene_name },
                    "timeoutMs": 5000,
                }),
            )
            .await
            .ok(),
        Err(_) => None,
    };
    if capture.as_ref().is_none_or(Value::is_null) {
        let context = fetch_native_context(app).await;
        let ocr_config = read_ocr_config(app);
        let input_url = crate::input_server::url(app);
        let native_cfg =
            build_native_ocr_config(app, &OcrRunMode::Auto, &ocr_config, &context, &input_url)
                .await;
        let preview_req = json!({ "sceneId": scene_id, "sceneName": scene_name });
        if let Ok(Ok(native_cap)) = tauri::async_runtime::spawn_blocking(move || {
            crate::ocr::capture_preview(native_cfg, preview_req)
        })
        .await
        {
            if !native_cap.is_null() {
                capture = Some(native_cap);
            }
        }
    }

    let boxes_payload = if include_boxes {
        let native_preview = app
            .try_state::<Ocr>()
            .and_then(|o| o.command(json!({ "action": "preview" })).ok())
            .filter(|v| !v.is_null());
        if let Some(p) = native_preview {
            Some(p)
        } else if let Ok(rt) = runtime::get(app) {
            rt.call(
                "bus.request",
                json!({
                    "dst": "backend",
                    "topic": "ocr.preview",
                    "data": { "enabled": true, "sceneName": scene_name },
                    "timeoutMs": 5000,
                }),
            )
            .await
            .ok()
        } else {
            None
        }
    } else {
        None
    };

    json!({
        "ok": true,
        "sceneName": scene_name,
        "config": area_config,
        "revision": revision,
        "capture": capture,
        "boxes": boxes_payload,
    })
}

async fn handle_save_preview_areas(app: &tauri::AppHandle, req: Value) -> Value {
    let paths = paths_for(app);
    let scene_name =
        resolve_active_scene_name(app, req.get("sceneName").and_then(Value::as_str)).await;
    let (area_path, _) = ocr_config_paths(&paths.active, &scene_name);
    let expected_revision = req.get("expectedRevision").and_then(Value::as_str);

    let saved = {
        let _lock = OCR_FILE_LOCK.lock().unwrap();
        let existing: Value = fs::read_to_string(&area_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .filter(|v: &Value| v.is_object())
            .unwrap_or_else(|| {
                json!({
                    "scene": scene_name,
                    "coordinate_system": "",
                    "window_geometry": { "left": 0, "top": 0, "width": 0, "height": 0 },
                    "rectangles": [],
                })
            });
        let current_rev = get_ocr_area_revision(&existing);
        if let Some(expected) = expected_revision {
            if expected != current_rev {
                return json!({
                    "ok": false,
                    "error": "conflict",
                    "revision": current_rev,
                    "config": existing,
                });
            }
        }
        let _ = backup_ocr_config(&area_path);

        let mut next = existing;
        if let Some(obj) = next.as_object_mut() {
            obj.insert("scene".into(), json!(scene_name));
            if let Some(cs) = req.get("coordinate_system") {
                obj.insert("coordinate_system".into(), cs.clone());
            } else if let Some(cs) = req.get("coordinateSystem") {
                obj.insert("coordinate_system".into(), cs.clone());
            }
            if let Some(rects) = req.get("rectangles") {
                obj.insert("rectangles".into(), rects.clone());
            }
            if let Some(geom) = req.get("window_geometry") {
                obj.insert("window_geometry".into(), geom.clone());
            }
        }
        if let Err(e) = write_json_atomic(&area_path, &next) {
            return json!({ "ok": false, "error": e });
        }
        next
    };

    reload_active_ocr(app).await;
    json!({
        "ok": true,
        "revision": get_ocr_area_revision(&saved),
        "config": saved,
    })
}

async fn run_python_streaming_to_ocr_log(
    app: &tauri::AppHandle,
    python_path: &str,
    args: Vec<String>,
) -> Result<(), String> {
    let app_clone = app.clone();
    let py = python_path.to_owned();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&py);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed starting uv/pip: {e}"))?;
        let stderr_handle = child.stderr.take().map(|err| {
            let app_err = app_clone.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    emit_ocr_log(&app_err, "py:ocr-deps", &line);
                }
            })
        });
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                emit_ocr_log(&app_clone, "py:ocr-deps", &line);
            }
        }
        if let Some(h) = stderr_handle {
            let _ = h.join();
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Command exited with code {:?}", status.code()))
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    res
}

async fn sync_locked_ocr_env(app: &tauri::AppHandle, python_path: &str) -> Result<(), String> {
    let paths = paths_for(app);
    let extras = Preferences::new(&paths.active)
        .get("pythonExtras")
        .ok()
        .flatten()
        .unwrap_or_else(|| json!(["base"]));
    let selection = gsm_packages::python::Python::new(
        &paths.shared,
        &crate::python_install::project_root(app),
        crate::LOCAL_BUILD,
    )
    .call("extras", &json!({ "extras": extras }), Arc::new(|_, _| {}))?;
    crate::python_install::dispatch(
        app,
        json!({
            "action": "sync",
            "params": {
                "pythonPath": python_path,
                "extras": selection["selectedExtras"],
                "checkOnly": false,
                "options": {}
            }
        }),
    )
    .await
    .map(|_| ())
}

async fn run_furigana_preview(
    app: &tauri::AppHandle,
    sensitivity: Option<f64>,
) -> Result<Value, String> {
    let current = sensitivity
        .or_else(|| read_ocr_config(app)["furigana_filter_sensitivity"].as_f64())
        .unwrap_or_default()
        .clamp(0., 100.) as i32;
    let selected = crate::ocr_preview::open(app, current, None, false).await?;
    if !selected.is_null() {
        emit_to_desktop_windows(app, "furigana-script-result", &[selected.clone()]);
    }
    Ok(selected)
}

pub async fn try_invoke(
    app: &tauri::AppHandle,
    channel: &str,
    args: &[Value],
) -> Option<Result<Value, String>> {
    match channel {
        "ocr.open-temp-folder" => {
            let path = crate::desktop_services::paths_for(app).active.join("temp");
            Some(std::fs::create_dir_all(&path).map_err(|e| e.to_string())
                .and_then(|_| crate::native::shell_open_path(&path).map(|_| json!({"success":true}))))
        }
        "ocr.meiki-model" => Some(meiki::invoke(app, args.first().cloned().unwrap_or_else(|| json!({}))).await),
        "ocr.vita-model" => Some(vocr::invoke(app, args.first().cloned().unwrap_or_else(|| json!({}))).await),
        "ocr.get-preview" => Some(Ok(handle_get_preview(
            app,
            args.first().cloned().unwrap_or_else(|| json!({})),
        )
        .await)),
        "ocr.save-preview-areas" => Some(Ok(handle_save_preview_areas(
            app,
            args.first().cloned().unwrap_or_else(|| json!({})),
        )
        .await)),
        "ocr-replacements.load" => {
            let paths = paths_for(app);
            Some(Ok(load_ocr_replacements(&paths.active)))
        }
        "ocr-replacements.save" => {
            let paths = paths_for(app);
            let repl = args.first().cloned().unwrap_or_else(|| json!({}));
            let res = match save_ocr_replacements(&paths.active, &repl) {
                Ok(v) => v,
                Err(e) => return Some(Ok(json!({ "success": false, "error": e }))),
            };
            reload_active_ocr(app).await;
            Some(Ok(res))
        }
        "ocr.open-config-json" => {
            let paths = paths_for(app);
            let scene = resolve_active_scene_name(app, None).await;
            let (area_path, _) = ocr_config_paths(&paths.active, &scene);
            Some(match shell_open_path(&area_path) {
                Ok(()) => Ok(json!({ "success": true, "path": area_path })),
                Err(e) => Ok(json!({ "success": false, "error": e })),
            })
        }
        "ocr.open-config-folder" => {
            let paths = paths_for(app);
            let dir = paths.active.join("ocr_config");
            let _ = fs::create_dir_all(&dir);
            Some(match shell_open_path(&dir) {
                Ok(()) => Ok(json!({ "success": true, "path": dir })),
                Err(e) => Ok(json!({ "success": false, "error": e })),
            })
        }
        "ocr.open-global-owocr-config" => {
            let paths = paths_for(app);
            let config_path = owocr_config_path(&paths.active, paths.has_profile)
                .unwrap_or_else(|_| paths.active.join("owocr_config.ini"));
            if !config_path.exists() {
                if let Some(p) = config_path.parent() {
                    let _ = fs::create_dir_all(p);
                }
                let _ = fs::write(&config_path, "# OWOCR Global Configuration\n");
            }
            Some(match shell_open_path(&config_path) {
                Ok(()) => Ok(json!({ "success": true, "path": config_path })),
                Err(e) => Ok(json!({ "success": false, "error": e })),
            })
        }
        "ocr.getActiveOCRConfig" => {
            let paths = paths_for(app);
            let scene = resolve_active_scene_name(app, None).await;
            Some(Ok(read_scene_areas(&paths.active, &scene)))
        }
        "ocr.getActiveSceneSettings" => {
            let paths = paths_for(app);
            let scene = resolve_active_scene_name(app, None).await;
            let ocr_cfg = read_ocr_config(app);
            Some(Ok(read_scene_settings(&paths.active, &scene, &ocr_cfg)))
        }
        "ocr.getActiveOCRConfigWindowName" => {
            let scene = resolve_active_scene_name(app, None).await;
            Some(Ok(json!(sanitize_ocr_filename(&scene))))
        }
        "ocr.get-ocr-config" => Some(Ok(read_ocr_config(app))),
        "ocr.get-running-state" => {
            let snap = app
                .try_state::<OcrCoordinator>()
                .map(|c| c.running_snapshot())
                .unwrap_or_else(|| json!({ "isRunning": false, "source": null, "mode": null }));
            Some(Ok(snap))
        }
        "run-furigana-window" => {
            Some(run_furigana_preview(app, args.first().and_then(Value::as_f64)).await)
        }
        "ocr.export-ocr-config" => {
            let paths = paths_for(app);
            let scene = resolve_active_scene_name(app, None).await;
            let areas = read_scene_areas(&paths.active, &scene);
            let export_payload = json!({
                "coordinate_system": areas["coordinate_system"],
                "window_geometry": areas["window_geometry"],
                "rectangles": areas["rectangles"],
            });
            let pretty = serde_json::to_string_pretty(&export_payload).unwrap_or_default();
            Some(match app.clipboard().write_text(pretty) {
                Ok(()) => Ok(json!({
                    "success": true,
                    "message": "OCR config (rectangles & coordinate system) exported to clipboard"
                })),
                Err(e) => Ok(json!({ "success": false, "message": format!("{e}") })),
            })
        }
        "ocr.import-ocr-config" => {
            let Ok(text) = app.clipboard().read_text() else {
                return Some(Ok(
                    json!({ "success": false, "message": "Clipboard read failed" }),
                ));
            };
            if text.trim().is_empty() {
                return Some(Ok(
                    json!({ "success": false, "message": "Clipboard is empty" }),
                ));
            }
            let Ok(imported) = serde_json::from_str::<Value>(&text) else {
                return Some(Ok(
                    json!({ "success": false, "message": "Invalid JSON in clipboard" }),
                ));
            };
            if !imported.get("rectangles").is_some_and(Value::is_array) {
                return Some(Ok(
                    json!({ "success": false, "message": "Clipboard JSON does not contain valid rectangles array" }),
                ));
            }
            let paths = paths_for(app);
            let scene = resolve_active_scene_name(app, None).await;
            let (area_path, _) = ocr_config_paths(&paths.active, &scene);
            let save_res = {
                let _lock = OCR_FILE_LOCK.lock().unwrap();
                let _ = backup_ocr_config(&area_path);
                let mut current = fs::read_to_string(&area_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .filter(|v: &Value| v.is_object())
                    .unwrap_or_else(|| json!({ "scene": scene }));
                if let Some(obj) = current.as_object_mut() {
                    obj.insert("scene".into(), json!(scene));
                    obj.insert("rectangles".into(), imported["rectangles"].clone());
                    if let Some(cs) = imported.get("coordinate_system") {
                        obj.insert("coordinate_system".into(), cs.clone());
                    }
                    if let Some(wg) = imported.get("window_geometry") {
                        obj.insert("window_geometry".into(), wg.clone());
                    }
                }
                write_json_atomic(&area_path, &current)
            };
            reload_active_ocr(app).await;
            Some(match save_res {
                Ok(()) => {
                    Ok(json!({ "success": true, "message": "OCR config imported successfully" }))
                }
                Err(e) => Ok(json!({ "success": false, "message": e })),
            })
        }
        _ => None,
    }
}

pub fn try_send(app: &tauri::AppHandle, channel: &str, args: &[Value]) -> bool {
    let app = app.clone();
    let args = args.to_vec();
    match channel {
        "ocr.start-ocr" => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_ocr(&app, OcrStartSource::User, OcrRunMode::Auto).await {
                    emit_to_desktop_windows(&app, "ocr-ipc-error", &[json!(e)]);
                }
            });
            true
        }
        "ocr.start-ocr-ss-only" => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_ocr(&app, OcrStartSource::User, OcrRunMode::SsOnly).await {
                    emit_to_desktop_windows(&app, "ocr-ipc-error", &[json!(e)]);
                }
            });
            true
        }
        "ocr.kill-ocr" => {
            crate::auto_launcher::suppress_current_scene_ocr(&app);
            if app
                .try_state::<OcrCoordinator>()
                .is_some_and(|c| c.is_running())
            {
                emit_ocr_log(&app, "rust:ocr-coordinator", "Stopping OCR process...");
                stop_ocr_sync(&app, "user-stop-request", None);
            }
            true
        }
        "ocr.restart-ocr" => {
            emit_ocr_log(&app, "rust:ocr-coordinator", "Restarting OCR Process...");
            tauri::async_runtime::spawn(async move {
                let (src, mode) = app
                    .try_state::<OcrCoordinator>()
                    .and_then(|c| {
                        c.0.lock()
                            .unwrap()
                            .active
                            .as_ref()
                            .map(|a| (a.source.clone(), a.mode.clone()))
                    })
                    .unwrap_or((OcrStartSource::User, OcrRunMode::Auto));
                if let Err(e) = start_ocr(&app, src, mode).await {
                    emit_to_desktop_windows(&app, "ocr-ipc-error", &[json!(e)]);
                }
            });
            true
        }
        "ocr.stdin" => true,
        "ocr.save-ocr-config" => {
            let next = args.first().cloned().unwrap_or_else(|| json!({}));
            tauri::async_runtime::spawn(async move {
                if save_ocr_config(&app, &next).is_ok() {
                    let paths = paths_for(&app);
                    let scene = resolve_active_scene_name(&app, None).await;
                    let (_, settings_path) = ocr_config_paths(&paths.active, &scene);
                    if let Some(furi) = next
                        .get("furigana_filter_sensitivity")
                        .and_then(Value::as_f64)
                    {
                        if let Some(coord) = app.try_state::<OcrCoordinator>() {
                            schedule_scene_settings_write(
                                &coord.0,
                                settings_path,
                                json!({ "furigana_filter_sensitivity": furi }),
                            );
                        }
                    }
                    reload_active_ocr(&app).await;
                }
            });
            true
        }
        "ocr.pause" => {
            send_runtime_ocr_command(&app, "pause", json!({}));
            true
        }
        "ocr.unpause" => {
            send_runtime_ocr_command(&app, "unpause", json!({}));
            true
        }
        "ocr.toggle-pause" => {
            send_runtime_ocr_command(&app, "toggle_pause", json!({}));
            true
        }
        "ocr.manual-ocr" => {
            send_runtime_ocr_command(&app, "manual_ocr", json!({}));
            true
        }
        "ocr.menu-ocr" => {
            send_runtime_ocr_command(&app, "menu_ocr", json!({}));
            true
        }
        "ocr.whole-window-ocr" => {
            send_runtime_ocr_command(&app, "whole_window_ocr", json!({}));
            true
        }
        "ocr.area-select-ocr" => {
            send_runtime_ocr_command(&app, "area_select_ocr", json!({}));
            true
        }
        "ocr.add-area" => {
            open_add_area(app);
            true
        }
        "ocr.get-status" => {
            send_runtime_ocr_command(&app, "status", json!({}));
            true
        }
        "ocr.reload-config" => {
            tauri::async_runtime::spawn(async move {
                reload_active_ocr(&app).await;
            });
            true
        }
        "ocr.toggle-force-stable" => {
            send_runtime_ocr_command(&app, "toggle_force_stable", json!({}));
            true
        }
        "ocr.set-force-stable" => {
            let enabled = args.first().and_then(Value::as_bool).unwrap_or(false);
            send_runtime_ocr_command(&app, "set_force_stable", json!({ "enabled": enabled }));
            true
        }
        "ocr.run-screen-selector" => {
            tauri::async_runtime::spawn(async move {
                match run_screen_selector(&app, true, false).await {
                    Ok(success) => emit_to_desktop_windows(
                        &app,
                        "ocr-screen-selector-finished",
                        &[json!({ "success": success })],
                    ),
                    Err(error) => emit_to_desktop_windows(
                        &app,
                        "ocr-screen-selector-finished",
                        &[json!({ "success": false, "error": error })],
                    ),
                }
            });
            true
        }
        "ocr.install-recommended-deps" | "ocr.install-selected-dep" | "ocr.uninstall-selected-dep"
            if crate::app_lifecycle::native_session_requested() => true,
        "ocr.install-recommended-deps" => {
            tauri::async_runtime::spawn(async move {
                let _ = python_ops::close_all_python_processes(&app, false).await;
                let Ok(py) = python_ops::ensure_python_path(&app).await else {
                    emit_ocr_log(&app, "rust:ocr-coordinator", "Python executable not found.");
                    return;
                };
                #[cfg(windows)]
                {
                    emit_ocr_log(&app, "rust:ocr-coordinator", "Downloading OneOCR files...");
                    let _ = run_python_streaming_to_ocr_log(
                        &app,
                        &py,
                        vec![
                            "-m".into(),
                            "GameSentenceMiner.util.downloader.oneocr_dl".into(),
                        ],
                    )
                    .await;
                }
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    "Restoring recommended dependencies from the lockfile...",
                );
                let _ = sync_locked_ocr_env(&app, &py).await;
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    "\x1b[32mRecommended dependencies restored successfully!\x1b[0m",
                );
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    "\x1b[32mYou can now close this console.\x1b[0m",
                );
            });
            true
        }
        "ocr.install-selected-dep" => {
            let dep = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned();
            if dep.is_empty() {
                return true;
            }
            tauri::async_runtime::spawn(async move {
                let _ = python_ops::close_all_python_processes(&app, false).await;
                let Ok(py) = python_ops::ensure_python_path(&app).await else {
                    return;
                };
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    &format!("Installing {dep} dependencies..."),
                );
                let uv_args: Vec<String> = if dep.contains("numpy") {
                    vec![
                        "-m".into(),
                        "uv".into(),
                        "--no-progress".into(),
                        "pip".into(),
                        "install".into(),
                        "--no-deps".into(),
                        "numpy==2.2.6".into(),
                    ]
                } else {
                    let mut v = vec!["-m".into(), "uv".into(), "--no-progress".into()];
                    v.extend(dep.split_whitespace().map(str::to_owned));
                    v
                };
                let _ = run_python_streaming_to_ocr_log(&app, &py, uv_args).await;
                let _ = sync_locked_ocr_env(&app, &py).await;
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    &format!("\x1b[32mInstalled {dep} successfully.\x1b[0m"),
                );
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    "\x1b[32mYou can now close this console.\x1b[0m",
                );
            });
            true
        }
        "ocr.uninstall-selected-dep" => {
            let dep = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned();
            if dep.is_empty() {
                return true;
            }
            tauri::async_runtime::spawn(async move {
                let Ok(choice) = dialog_message(&json!({
                    "type": "warning",
                    "title": "Confirm Uninstall",
                    "message": format!("Are you sure you want to uninstall the dependency: {dep}?"),
                    "buttons": ["Yes", "No"],
                    "defaultId": 1,
                    "cancelId": 1,
                }))
                .await
                else {
                    return;
                };
                if choice != 0 {
                    emit_ocr_log(
                        &app,
                        "rust:ocr-coordinator",
                        &format!("Uninstall canceled for {dep}."),
                    );
                    return;
                }
                let _ = python_ops::close_all_python_processes(&app, false).await;
                let Ok(py) = python_ops::ensure_python_path(&app).await else {
                    return;
                };
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    &format!("Uninstalling {dep} dependencies..."),
                );
                let mut uv_args = vec![
                    "-m".into(),
                    "uv".into(),
                    "--no-progress".into(),
                    "pip".into(),
                    "uninstall".into(),
                ];
                uv_args.extend(dep.split_whitespace().map(str::to_owned));
                let _ = run_python_streaming_to_ocr_log(&app, &py, uv_args).await;
                let _ = sync_locked_ocr_env(&app, &py).await;
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    &format!("\x1b[32mUninstalled {dep} successfully.\x1b[0m"),
                );
                emit_ocr_log(
                    &app,
                    "rust:ocr-coordinator",
                    "\x1b[32mYou can now close this console.\x1b[0m",
                );
            });
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn python_fallback_messages_and_commands_preserve_the_wire_protocol() {
        let (event, data) = parse_python_ocr_event(
            "OCRMSG:{\"event\":\"ocr_result\",\"data\":{\"text\":\"日本語\"}}",
        )
        .unwrap()
        .unwrap();
        assert_eq!(event, "ocr_result");
        assert_eq!(data["text"], "日本語");
        assert!(parse_python_ocr_event("log: OCRMSG:{}").unwrap().is_none());
        assert!(parse_python_ocr_event("OCRMSG:broken").is_err());
        let command = python_ocr_command("status", json!({}));
        let payload: Value =
            serde_json::from_str(command.strip_prefix("OCRCMD:").unwrap()).unwrap();
        assert_eq!(payload["command"], "get_status");
    }

    #[test]
    fn advanced_defaults_to_two_pass_lens_and_basic_follows_online_switch() {
        let mut cfg = default_ocr_config();
        cfg["advancedMode"] = json!(true);
        let advanced = runtime_ocr_settings(cfg.clone());
        assert_eq!(advanced["ocr1"], "screenai");
        assert_eq!(advanced["ocr2"], "glens");
        assert_eq!(advanced["twoPassOCR"], true);
        assert_eq!(advanced["optimize_second_scan"], true);
        cfg["ocr2"] = json!("bing");
        cfg["twoPassOCR"] = json!(false);
        assert_eq!(runtime_ocr_settings(cfg.clone()), cfg);
        cfg["advancedMode"] = json!(false);
        assert_eq!(runtime_ocr_settings(cfg.clone())["ocr2"], "screenai");
        cfg["useOnlineOcr"] = json!(true);
        let online = runtime_ocr_settings(cfg);
        assert_eq!(online["ocr2"], "glens");
        assert_eq!(online["twoPassOCR"], true);
    }

    #[test]
    fn retired_selections_fall_back_without_changing_supported_engines() {
        let mut config = json!({
            "ocr1": "  MLKitOCR ",
            "ocr2": "gvision",
            "ocr1_advanced": "oneocr",
            "ocr2_advanced": "mangaocrs",
            "menuAreaOcrEngine": "gemini",
        });
        replace_retired_ocr_engines(&mut config);
        assert_eq!(config["ocr1"], "screenai");
        assert_eq!(config["ocr2"], "gvision");
        assert_eq!(config["ocr1_advanced"], "oneocr");
        assert_eq!(config["ocr2_advanced"], "screenai");
        assert_eq!(config["menuAreaOcrEngine"], "main");
    }

    #[test]
    fn initial_native_settings_equal_first_heartbeat_settings() {
        let initial = default_ocr_config();
        let mut heartbeat = initial.clone();
        heartbeat["force_stable"] = json!(false);
        let scene = json!({"furigana_filter_sensitivity":0});
        assert_eq!(
            native_ocr_settings(&initial, &scene),
            native_ocr_settings(&heartbeat, &scene)
        );
    }

    #[test]
    fn existing_scene_areas_are_loaded_with_legacy_filenames() {
        let directory =
            std::env::temp_dir().join(format!("gsm-ocr-areas-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("ocr_config")).unwrap();
        let saved = json!({"scene":"Muv-Luv EXTRA", "coordinate_system":"percentage", "rectangles":[{"coordinates":[0.1,0.2,0.7,0.3]}]});
        fs::write(
            directory.join("ocr_config/Muv-LuvEXTRA.json"),
            saved.to_string(),
        )
        .unwrap();
        assert_eq!(read_scene_areas(&directory, "Muv-Luv EXTRA"), saved);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sanitize_and_area_revision_match_ts_contracts() {
        assert_eq!(
            sanitize_ocr_filename("Steins;Gate: Zero?"),
            "Steins;GateZero"
        );
        assert_eq!(sanitize_ocr_filename("Muv-Luv EXTRA"), "Muv-LuvEXTRA");
        assert_eq!(sanitize_ocr_filename("<>:\"/\\|?*"), "Default");

        let empty = json!({});
        assert_eq!(get_ocr_area_revision(&empty), "[\"\",[]]");
        let populated = json!({
            "coordinate_system": "percentage",
            "rectangles": [{"id": 1, "coordinates": [0.1, 0.2, 0.3, 0.4]}],
        });
        assert_eq!(
            get_ocr_area_revision(&populated),
            serde_json::to_string(&("percentage", populated["rectangles"].as_array().unwrap()))
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ocr_results_reach_backend_over_native_bus() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        let rt = gsm_runtime::Runtime::start(json!({}), |_, _| {}).unwrap();
        let info = rt.info();
        let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{}", info["port"]))
            .await
            .unwrap();
        socket.send(Message::Text(json!({"v":1,"id":"hello","src":"backend","dst":"main","topic":"bus.hello","kind":"hello","data":{"token":info["token"]}}).to_string().into())).await.unwrap();
        let welcome = socket.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(welcome.to_text().unwrap()).unwrap()["topic"],
            "bus.welcome"
        );
        let server = tokio::spawn(async move {
            let topic = "ocr.native.result";
            let raw = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let request: Value = serde_json::from_str(raw.to_text().unwrap()).unwrap();
            assert_eq!(request["topic"], topic);
            assert_eq!(request["data"]["text"], "認識した文章");
            socket.send(Message::Text(json!({"v":1,"id":uuid::Uuid::new_v4().to_string(),"src":"backend","dst":"main","topic":topic,"kind":"response","corr":request["id"],"ok":true,"data":{"status":"accepted"}}).to_string().into())).await.unwrap();
        });
        let ack = request_ocr_backend(
            &rt,
            "ocr.native.result",
            json!({"text":"認識した文章", "ocr_scene":"Muv-Luv EXTRA"}),
            2000,
        )
        .await
        .unwrap();
        assert_eq!(ack["status"], "accepted");
        server.await.unwrap();
        rt.shutdown();
    }

    #[test]
    fn native_ocr_engine_support_check() {
        let cfg = json!({ "ocr1": "oneocr", "ocr2": "glens", "menuAreaOcrEngine": "main" });
        assert!(is_native_ocr_supported(&cfg, false));
        assert!(is_native_ocr_supported(&cfg, true));
        let unsupported = json!({ "ocr1": "tesseract", "ocr2": "glens" });
        assert!(!is_native_ocr_supported(&unsupported, false));
        assert!(is_native_ocr_supported(&unsupported, true));
    }

    #[test]
    fn benchmark_ocr_config_revision_and_backup() {
        let dir = std::env::temp_dir().join(format!("gsm-ocr-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let area_path = dir.join("ocr_config").join("GameA.json");
        let cfg = json!({
            "scene": "GameA",
            "coordinate_system": "percentage",
            "rectangles": (0..12).map(|i| json!({"id": i, "coordinates": [0.1, 0.1, 0.8, 0.2]})).collect::<Vec<_>>(),
        });
        write_json_atomic(&area_path, &cfg).unwrap();

        let rev_start = Instant::now();
        for _ in 0..5_000 {
            let _ = std::hint::black_box(get_ocr_area_revision(&cfg));
        }
        let rev_ms = rev_start.elapsed().as_secs_f64() * 1000.0;

        let backup_start = Instant::now();
        for _ in 0..15 {
            backup_ocr_config(&area_path).unwrap();
        }
        let backup_ms = backup_start.elapsed().as_secs_f64() * 1000.0;
        let backups: Vec<_> = fs::read_dir(dir.join("ocr_config/backup/GameA"))
            .unwrap()
            .flatten()
            .collect();
        assert!(backups.len() <= MAX_AREA_BACKUPS);
        println!(
            "[bench] ocr_coordinator revision_5k_ms={rev_ms:.3} backup_15_rotated_ms={backup_ms:.3}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
