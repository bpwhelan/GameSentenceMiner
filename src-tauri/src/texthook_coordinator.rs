//! Native Rust coordinator for integrated TextHook/Agent sessions, sanitization,
//! profile/exe resolution, engine updates, and desktop window events.

use crate::desktop_services::paths_for;
use crate::desktop_state::emit_to_desktop_windows;
use crate::native::dialog_open;
use crate::process_probe::{find_primary_pid_by_exe, pe_bitness, process_executable_path};
use crate::settings_tools::{get_game_exe_path_for_scene, set_game_exe_path_for_scene};
use gsm_settings::gsm_config::get_configured_target_language;
use gsm_settings::preferences::Preferences;
use gsm_settings::profiles::Profiles;
use gsm_settings::{read_object, write_atomic};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

pub const DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE: usize = 3000;
pub const MAX_TEXT_HOOK_MAX_BUFFER_SIZE: usize = 100_000;
pub const HARD_TEXT_HOOK_REJECTION_LIMIT: usize = 10_000;
pub const MAX_JAPANESE_QUOTE_PAIRS: usize = 10;
const HOOK_BATCH_DELAY: Duration = Duration::from_millis(200);
const HOOK_AUTO_SAVE_LINES: usize = 3;

pub fn normalize_max_buffer_size(value: Option<&Value>) -> usize {
    let parsed = value.and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
    });
    match parsed {
        Some(n) if n.is_finite() && n >= 1.0 => {
            (n.round() as usize).min(MAX_TEXT_HOOK_MAX_BUFFER_SIZE)
        }
        _ => DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE,
    }
}

pub fn has_excessive_japanese_quote_pairs(text: &str) -> bool {
    let mut open = 0usize;
    let mut close = 0usize;
    for ch in text.chars() {
        if ch == '「' {
            open += 1;
        } else if ch == '」' {
            close += 1;
        }
        if open > MAX_JAPANESE_QUOTE_PAIRS && close > MAX_JAPANESE_QUOTE_PAIRS {
            return true;
        }
    }
    false
}

/// Sanitize outgoing hook text matching JS UTF-16 `.length` semantics.
pub fn sanitize_texthook_text(text: &str, max_buffer_size: usize) -> Option<(String, bool)> {
    let utf16_len = text.encode_utf16().count();
    if utf16_len > HARD_TEXT_HOOK_REJECTION_LIMIT || has_excessive_japanese_quote_pairs(text) {
        return None;
    }
    let limit = max_buffer_size.clamp(1, MAX_TEXT_HOOK_MAX_BUFFER_SIZE);
    if utf16_len <= limit {
        return Some((text.to_owned(), false));
    }
    let mut out = String::with_capacity(limit);
    let mut count = 0usize;
    for ch in text.chars() {
        let units = ch.len_utf16();
        if count + units > limit {
            break;
        }
        out.push(ch);
        count += units;
    }
    Some((out, true))
}

/// Merge cumulative typewriter prefixes just like `appendHookFragment`.
#[cfg(test)]
pub fn append_hook_fragment(pending: &mut Vec<Value>, mut payload: Value) {
    let next_text = payload["text"].as_str().unwrap_or("").to_owned();
    if let Some(prev) = pending.last_mut() {
        let prev_text = prev["text"].as_str().unwrap_or("");
        if next_text.starts_with(prev_text) {
            if prev.get("capturedAt").is_some_and(|v| !v.is_null()) {
                payload["capturedAt"] = prev["capturedAt"].clone();
            }
            *prev = payload;
            return;
        }
        if prev_text.starts_with(&next_text) {
            return;
        }
    }
    pending.push(payload);
}

struct HookDiscovery {
    session_id: String,
    batches: Option<mpsc::Sender<()>>,
    latest: Value,
}

impl HookDiscovery {
    fn start(app: &AppHandle, session_id: &str) -> Self {
        let (batches, receiver) = mpsc::channel(1);
        tauri::async_runtime::spawn(run_hook_discovery(
            app.clone(),
            session_id.to_owned(),
            receiver,
            batches.downgrade(),
        ));
        Self {
            session_id: session_id.to_owned(),
            batches: Some(batches),
            latest: Value::Null,
        }
    }

    fn stop(&mut self) {
        self.batches = None;
    }
}

struct PendingHookSave {
    session_id: String,
    selection_revision: u64,
    profile: Value,
    lines: Vec<String>,
    queued: bool,
}

impl PendingHookSave {
    fn new(selection: &Value) -> Option<Self> {
        let exe = selection["profile"]["exeName"].as_str()?.trim();
        if exe.is_empty() || exe.starts_with("pid:") {
            return None;
        }
        Some(Self {
            session_id: selection["sessionId"].as_str()?.to_owned(),
            selection_revision: selection["selectionRevision"].as_u64()?,
            profile: selection["profile"].clone(),
            lines: Vec::with_capacity(HOOK_AUTO_SAVE_LINES),
            queued: false,
        })
    }

    fn record_line(&mut self, payload: &Value, ack: &Value) -> bool {
        if self.queued
            || payload["sessionId"] != self.session_id
            || payload["selectionRevision"] != self.selection_revision
            || payload["hookId"] != self.profile["hookId"]
            || ack["status"] != "accepted"
        {
            return false;
        }
        let text = ack["processed_text"].as_str().unwrap_or("").trim();
        if text.is_empty() || self.lines.iter().any(|line| line == text) {
            return false;
        }
        if self.lines.len() < HOOK_AUTO_SAVE_LINES {
            self.lines.push(text.to_owned());
        }
        self.queued = self.lines.len() == HOOK_AUTO_SAVE_LINES;
        self.queued
    }

    fn matches_profile(&self, exe: &str, scene: Option<&str>) -> bool {
        let (profile_exe, profile_scene) = parse_profile_identity(Some(&self.profile));
        match (profile_scene.as_deref(), scene) {
            (Some(a), Some(b)) => a.to_lowercase() == b.to_lowercase(),
            (None, None) => profile_exe.to_lowercase() == exe.to_lowercase(),
            _ => false,
        }
    }

    fn save(&self, profiles: &Profiles, status: &Value) -> Result<Value, String> {
        let mut patch = self.profile.clone();
        let (exe, scene) = parse_profile_identity(Some(&patch));
        let existing = profiles.get(&exe, scene.as_deref())?;
        // Inherit the auto-attach preference when there is only an executable profile.
        if let Some(auto_hook) = existing["autoHook"].as_bool() {
            patch["autoHook"] = json!(auto_hook);
        }
        for field in ["flushDelayMs", "copyToClipboard"] {
            if let Some(setting) = status.get(field) {
                patch[field] = setting.clone();
            }
        }
        profiles.upsert(patch)
    }
}

#[derive(Default)]
struct State {
    active_engine: Option<String>,
    active_exe_name: Option<String>,
    active_pid: Option<u32>,
    active_scene_id: Option<String>,
    agent_script_path: Option<String>,
    source: String,
    generation: u64,
    last_status: Value,
    last_hooks: Value,
    discovery: Option<HookDiscovery>,
    pending_hook_save: Option<PendingHookSave>,
    max_buffer_size: Option<usize>,
    last_reported_backend_active: Option<bool>,
}

pub struct TexthookCoordinator {
    state: Mutex<State>,
    expecting_internal_stop: AtomicBool,
}

impl Default for TexthookCoordinator {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                last_status: json!({ "running": false }),
                last_hooks: json!({ "hooks": [], "selectedHookId": Value::Null }),
                ..Default::default()
            }),
            expecting_internal_stop: AtomicBool::new(false),
        }
    }
}

impl TexthookCoordinator {
    pub fn automation_status(&self) -> Value {
        let g = self.state.lock().unwrap();
        json!({"running":g.last_status["running"], "source":g.source,
            "engine":g.active_engine, "pid":g.active_pid, "sceneId":g.active_scene_id,
            "agentScriptPath":g.agent_script_path})
    }
    pub fn active_identity(&self) -> (Option<String>, Option<u32>, Option<String>) {
        let g = self.state.lock().unwrap();
        (
            g.active_exe_name.clone(),
            g.active_pid,
            g.active_scene_id.clone(),
        )
    }

    pub fn get_max_buffer_size(&self, active_dir: &Path) -> usize {
        {
            let g = self.state.lock().unwrap();
            if let Some(cached) = g.max_buffer_size {
                return cached;
            }
        }
        let loaded = load_max_buffer_size(&active_dir.join("config.json"));
        let mut g = self.state.lock().unwrap();
        g.max_buffer_size = Some(loaded);
        loaded
    }
}

fn load_max_buffer_size(gsm_config_path: &Path) -> usize {
    let Ok(root) = read_object(gsm_config_path) else {
        return DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;
    };
    let configs = root.get("configs").and_then(Value::as_object);
    if let Some(configs) = configs {
        let active_name = root
            .get("current_profile")
            .or_else(|| root.get("profile"))
            .and_then(Value::as_str);
        if let Some(name) = active_name {
            if let Some(val) = configs
                .get(name)
                .and_then(|p| p.get("general"))
                .and_then(|g| g.get("texthook_max_buffer_size"))
            {
                return normalize_max_buffer_size(Some(val));
            }
        }
        if let Some((_, first)) = configs.iter().next() {
            if let Some(val) = first
                .get("general")
                .and_then(|g| g.get("texthook_max_buffer_size"))
            {
                return normalize_max_buffer_size(Some(val));
            }
        }
    }
    normalize_max_buffer_size(
        root.get("general")
            .and_then(|g| g.get("texthook_max_buffer_size")),
    )
}

fn save_max_buffer_size(gsm_config_path: &Path, value: usize) -> Result<(), String> {
    let mut root = read_object(gsm_config_path).unwrap_or_else(|_| json!({}));
    let Some(obj) = root.as_object_mut() else {
        return Err("Invalid GSM config object".into());
    };
    let mut updated = false;
    if let Some(configs) = obj.get_mut("configs").and_then(Value::as_object_mut) {
        for profile in configs.values_mut() {
            let Some(profile_obj) = profile.as_object_mut() else {
                continue;
            };
            let general = profile_obj
                .entry("general".to_owned())
                .or_insert_with(|| json!({}));
            if let Some(gen_obj) = general.as_object_mut() {
                gen_obj.insert("texthook_max_buffer_size".into(), json!(value));
                updated = true;
            }
        }
    }
    if !updated {
        let general = obj.entry("general".to_owned()).or_insert_with(|| json!({}));
        if let Some(gen_obj) = general.as_object_mut() {
            gen_obj.insert("texthook_max_buffer_size".into(), json!(value));
        }
    }
    write_atomic(gsm_config_path, &root)
}

pub fn engine_cli_path(shared_dir: &Path, engine: &str, arch: &str) -> PathBuf {
    let base = gsm_packages::engines::Engines::new(shared_dir).runtime_dir();
    match engine {
        "textractor" => {
            let dir = if arch == "x86" { "_x86" } else { "_x64" };
            base.join("textractor_builds")
                .join(dir)
                .join("TextractorCLI.exe")
        }
        "luna" => {
            let bin = if arch == "x86" {
                "LunaHostCLI32.exe"
            } else {
                "LunaHostCLI64.exe"
            };
            base.join("luna_builds").join(bin)
        }
        _ => PathBuf::new(),
    }
}

fn resolve_cli_for_pid(shared_dir: &Path, engine: &str, pid: u32) -> (String, Option<PathBuf>) {
    let bitness = process_executable_path(pid)
        .map(|p| pe_bitness(&p))
        .unwrap_or("unknown");
    let primary_arch = if bitness == "x86" { "x86" } else { "x64" };
    let secondary_arch = if primary_arch == "x64" { "x86" } else { "x64" };
    let primary = engine_cli_path(shared_dir, engine, primary_arch);
    if primary.is_file() {
        return (primary_arch.to_owned(), Some(primary));
    }
    let secondary = engine_cli_path(shared_dir, engine, secondary_arch);
    if secondary.is_file() {
        return (secondary_arch.to_owned(), Some(secondary));
    }
    (primary_arch.to_owned(), None)
}

fn sync_backend_texthook_status(app: &AppHandle, active: bool) {
    let should_send = {
        let Some(coord) = app.try_state::<TexthookCoordinator>() else {
            return;
        };
        let mut g = coord.state.lock().unwrap();
        if g.last_reported_backend_active == Some(active) {
            return;
        }
        g.last_reported_backend_active = Some(active);
        true
    };
    if should_send {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::runtime::backend_command(
                &app_clone,
                "texthook_status",
                json!({ "active": active }),
            )
            .await;
        });
    }
}

pub fn on_texthook_event(app: &AppHandle, event: &str, mut data: Value) {
    if let Some(coord) = app.try_state::<TexthookCoordinator>() {
        let mut g = coord.state.lock().unwrap();
        if event == "texthook.status" {
            let running = data["running"] == true;
            if !running {
                g.discovery = None;
                g.pending_hook_save = None;
                if g.active_engine.as_deref() != Some("agent") {
                    g.active_engine = None;
                    g.active_pid = None;
                    g.active_exe_name = None;
                    g.active_scene_id = None;
                }
            } else {
                let mut merged = data.clone();
                if let Some(obj) = merged.as_object_mut() {
                    obj.entry("engine".to_owned())
                        .or_insert_with(|| json!(g.active_engine.as_deref().unwrap_or("")));
                    obj.entry("pid".to_owned())
                        .or_insert_with(|| json!(g.active_pid));
                    obj.entry("exeName".to_owned())
                        .or_insert_with(|| json!(g.active_exe_name.as_deref().unwrap_or("")));
                    obj.entry("sceneId".to_owned())
                        .or_insert_with(|| json!(g.active_scene_id.as_deref().unwrap_or("")));
                    obj.entry("source".to_owned())
                        .or_insert_with(|| json!(g.source));
                    obj.insert(
                        "maxBufferSize".into(),
                        json!(coord_max_buffer_unlocked(app, &g)),
                    );
                }
                data = merged;
                if let Some(id) = data["sessionId"].as_str().filter(|id| {
                    g.discovery
                        .as_ref()
                        .is_none_or(|current| current.session_id != *id)
                }) {
                    g.discovery = Some(HookDiscovery::start(app, id));
                    g.pending_hook_save = None;
                }
                if data["selectedHookId"].is_string() {
                    if let Some(discovery) = g.discovery.as_mut() {
                        discovery.stop();
                    }
                }
            }
            if g.active_engine.as_deref() != Some("agent") || running {
                g.last_status = data.clone();
            }
        } else if event == "texthook.hooks" {
            g.last_hooks = data.clone();
        } else if event == "texthook.hookSelected" {
            if let Some(discovery) = g
                .discovery
                .as_mut()
                .filter(|discovery| data["sessionId"] == discovery.session_id)
            {
                discovery.stop();
                g.pending_hook_save = PendingHookSave::new(&data);
            }
        } else if event == "texthook.samplesChanged" {
            if let Some(batches) = g
                .discovery
                .as_ref()
                .filter(|discovery| data.as_str() == Some(discovery.session_id.as_str()))
                .and_then(|discovery| discovery.batches.as_ref())
            {
                let _ = batches.try_send(());
            }
        }
    }

    if event == "texthook.status" {
        let running = data["running"] == true;
        sync_backend_texthook_status(app, running);
        if !running {
            crate::game_privileges::set_target(app, "texthook", None);
            crate::auto_launcher::notify_signal(app);
        }
    }

    match event {
        "texthook.status"
        | "texthook.hooks"
        | "texthook.text"
        | "texthook.log"
        | "texthook.agentError" => {
            emit_to_desktop_windows(app, event, &[data]);
        }
        _ => {}
    }
}

pub fn on_agent_event(app: &AppHandle, event: &str, mut data: Value, detached: bool) {
    if let Some(coord) = app.try_state::<TexthookCoordinator>() {
        let mut g = coord.state.lock().unwrap();
        if event == "texthook.status" {
            let running = data["running"] == true;
            if let Some(obj) = data.as_object_mut() {
                obj.entry("engine".to_owned())
                    .or_insert_with(|| json!("agent"));
                obj.insert("agentDetached".into(), json!(detached));
                obj.insert(
                    "maxBufferSize".into(),
                    json!(coord_max_buffer_unlocked(app, &g)),
                );
                if !running {
                    obj.remove("pid");
                }
            }
            if !running && g.active_engine.as_deref() == Some("agent") {
                g.active_engine = None;
                g.active_pid = None;
                g.active_exe_name = None;
                g.active_scene_id = None;
            }
            if g.active_engine.is_none() || g.active_engine.as_deref() == Some("agent") {
                g.last_status = data.clone();
            }
        } else if event == "texthook.hooks" {
            g.last_hooks = data.clone();
        } else if event == "agent.text" {
            // `agent.text` raw preview corresponds to JS `texthook.text` before Python processing.
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let text_payload = json!({
                "hookId": data["hookId"].as_str().unwrap_or("agent"),
                "text": data["text"].as_str().unwrap_or(""),
                "ts": data["capturedAt"].as_u64().unwrap_or(ts),
                "sessionId": data["sessionId"],
            });
            drop(g);
            emit_to_desktop_windows(app, "texthook.text", &[text_payload]);
            return;
        }
    }

    if event == "texthook.status" {
        let running = data["running"] == true;
        sync_backend_texthook_status(app, running);
        if !running {
            crate::game_privileges::set_target(app, "texthook", None);
            crate::auto_launcher::notify_signal(app);
        }
    }

    match event {
        "texthook.status"
        | "texthook.hooks"
        | "texthook.text"
        | "texthook.log"
        | "texthook.agentError" => {
            emit_to_desktop_windows(app, event, &[data]);
        }
        _ => {}
    }
}

pub fn on_texthook_processed(app: &AppHandle, data: Value) {
    emit_to_desktop_windows(app, "texthook.processed", &[data]);
}

pub fn observe_hook_ack(app: &AppHandle, payload: &Value, ack: &Value) {
    let coord = app.state::<TexthookCoordinator>();
    let (session_id, selection_revision) = {
        let mut g = coord.state.lock().unwrap();
        let Some(save) = g.pending_hook_save.as_mut() else {
            return;
        };
        if !save.record_line(payload, ack) {
            return;
        }
        (save.session_id.clone(), save.selection_revision)
    };

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let coord = app.state::<TexthookCoordinator>();
        let profiles = Profiles::new(&paths_for(&app).active);
        let result = {
            let mut g = coord.state.lock().unwrap();
            let Some(save) = g.pending_hook_save.as_ref().filter(|save| {
                save.session_id == session_id && save.selection_revision == selection_revision
            }) else {
                return;
            };
            let result = save.save(&profiles, &g.last_status);
            if result.is_ok() {
                g.pending_hook_save = None;
            } else if let Some(save) = g.pending_hook_save.as_mut() {
                save.queued = false;
            }
            result
        };
        if let Err(error) = result {
            on_texthook_log_error(&app, &format!("Could not save selected hook: {error}"));
        }
    });
}

pub fn on_texthook_log_error(app: &AppHandle, message: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let tagged = crate::desktop_log::ensure_origin("rust:texthook-coordinator", message);
    crate::desktop_log::error(app, "texthook-coordinator", message);
    emit_to_desktop_windows(
        app,
        "texthook.log",
        &[json!({ "level": "error", "message": tagged, "ts": ts })],
    );
}

fn coord_max_buffer_unlocked(app: &AppHandle, state: &State) -> usize {
    if let Some(v) = state.max_buffer_size {
        return v;
    }
    load_max_buffer_size(&paths_for(app).active.join("config.json"))
}

pub fn get_status_snapshot(app: &AppHandle) -> Value {
    let paths = paths_for(app);
    let max_buffer = app
        .try_state::<TexthookCoordinator>()
        .map(|c| c.get_max_buffer_size(&paths.active))
        .unwrap_or(DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE);

    let agent_state = app
        .try_state::<crate::agent::Agent>()
        .map(|a| a.current_state())
        .unwrap_or_else(|| json!({}));
    if agent_state["status"]["running"] == true {
        let mut status = agent_state["status"].clone();
        if let Some(obj) = status.as_object_mut() {
            obj.entry("engine".to_owned())
                .or_insert_with(|| json!("agent"));
            obj.insert("maxBufferSize".into(), json!(max_buffer));
        }
        return status;
    }

    let coord_running = app
        .try_state::<TexthookCoordinator>()
        .map(|c| {
            let g = c.state.lock().unwrap();
            if g.last_status["running"] == true {
                Some(g.last_status.clone())
            } else {
                None
            }
        })
        .flatten();
    if let Some(mut s) = coord_running {
        if let Some(obj) = s.as_object_mut() {
            obj.insert("maxBufferSize".into(), json!(max_buffer));
        }
        return s;
    }

    json!({
        "running": false,
        "maxBufferSize": max_buffer,
    })
}

pub fn get_list_hooks_snapshot(app: &AppHandle) -> Value {
    let agent_state = app
        .try_state::<crate::agent::Agent>()
        .map(|a| a.current_state())
        .unwrap_or_else(|| json!({}));
    if agent_state["status"]["running"] == true && agent_state["hooks"].is_object() {
        return agent_state["hooks"].clone();
    }
    if let Some(coord) = app.try_state::<TexthookCoordinator>() {
        let g = coord.state.lock().unwrap();
        if g.last_hooks.is_object() {
            return g.last_hooks.clone();
        }
    }
    json!({ "hooks": [], "selectedHookId": Value::Null })
}

fn apply_saved_hook_options(mut options: Value, profile: &Value) -> Value {
    for key in ["flushDelayMs", "copyToClipboard"] {
        if options[key].is_null() && !profile[key].is_null() {
            options[key] = profile[key].clone();
        }
    }
    if profile["engine"] == options["engine"] {
        for key in ["agentScriptPath", "agentDetached"] {
            if options[key].is_null() || options[key] == "" {
                options[key] = profile[key].clone();
            }
        }
        if profile["autoHook"] == true {
            for (key, saved_key) in [
                ("autoSelectHookId", "hookId"),
                ("autoSelectHookFunction", "hookFunction"),
                ("autoSelectProcessorOverrides", "processorOverrides"),
                ("manualHookCode", "manualHookCode"),
            ] {
                if options[key].is_null() {
                    options[key] = profile[saved_key].clone();
                }
            }
        }
    }
    options
}

pub async fn start_session(
    app: &AppHandle,
    options: Value,
    internal: bool,
) -> Result<Value, String> {
    let engine = options["engine"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("textractor")
        .to_ascii_lowercase();
    let exe_name = options["exeName"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let scene_id = options["sceneId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let pid = match options["pid"]
        .as_u64()
        .and_then(|p| u32::try_from(p).ok())
        .filter(|&p| p > 0)
    {
        Some(p) => p,
        None => {
            let exe = exe_name.as_deref().ok_or_else(|| {
                "Select an active game capture or enter a target exeName.".to_owned()
            })?;
            find_primary_pid_by_exe(exe)
                .ok_or_else(|| format!("Target process \"{exe}\" is not running."))?
        }
    };

    let paths = paths_for(app);
    let profile =
        Profiles::new(&paths.active).get(exe_name.as_deref().unwrap_or(""), scene_id.as_deref())?;
    let mut options = options;
    options["engine"] = json!(engine);
    let options = apply_saved_hook_options(options, &profile);
    if internal
        && app.try_state::<TexthookCoordinator>().is_some_and(|c| {
            let status = c.automation_status();
            status["running"] == true
                && !matches!(status["source"].as_str(), Some("auto" | "auto-launcher"))
        })
    {
        return Err("A manually started hook session is active.".into());
    }
    if get_status_snapshot(app)["running"] == true {
        stop_session(app, true).await?;
    }
    let max_buffer = app
        .try_state::<TexthookCoordinator>()
        .map(|c| c.get_max_buffer_size(&paths.active))
        .unwrap_or(DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE);

    let flush_delay = options["flushDelayMs"].as_u64().unwrap_or(100).min(5000);
    let copy_to_clipboard = options["copyToClipboard"] == true;
    let source = options["source"]
        .as_str()
        .unwrap_or(if internal { "auto" } else { "user" })
        .to_owned();

    let resolved_exe = exe_name.clone().unwrap_or_else(|| {
        process_executable_path(pid)
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| format!("pid:{pid}"))
    });

    crate::game_privileges::set_target(
        app,
        "texthook",
        Some(crate::game_privileges::GamePrivilegeTarget {
            exe_name: Some(resolved_exe.clone()),
            pid: Some(pid),
            foreground: false,
        }),
    );

    let result = if engine == "agent" {
        let script_path = options["agentScriptPath"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Agent mode requires selecting an Agent script.".to_owned())?;
        let arch = process_executable_path(pid)
            .map(|p| pe_bitness(&p))
            .filter(|&b| b == "x86" || b == "x64")
            .unwrap_or("x64");
        let agent_path = Preferences::new(&paths.active)
            .get("agentPath")
            .ok()
            .flatten()
            .and_then(|v| v.as_str().map(str::trim).map(str::to_owned))
            .unwrap_or_default();
        let start_params = json!({
            "action": "start",
            "params": {
                "baseDir": paths.active,
                "pid": pid,
                "exeName": resolved_exe,
                "arch": arch,
                "scriptPath": script_path,
                "agentScriptsPath": Preferences::new(&paths.active).get("agentScriptsPath").ok().flatten().and_then(|v| v.as_str().map(str::to_owned)),
                "agentPath": agent_path,
                "sceneId": scene_id,
                "source": source,
                "flushDelayMs": flush_delay,
                "copyToClipboard": copy_to_clipboard,
                "maxBufferSize": max_buffer,
                "detached": options["agentDetached"].as_bool().unwrap_or(cfg!(windows)),
            }
        });
        crate::agent::dispatch(app, start_params).await
    } else if matches!(engine.as_str(), "textractor" | "luna") {
        let (arch, cli_path) = resolve_cli_for_pid(&paths.shared, &engine, pid);
        let cli_path = cli_path.ok_or_else(|| {
            format!("Hook engine ({engine} {arch}) is not installed. Download hook engines from the TextHook tab.")
        })?;
        let start_params = json!({
            "action": "start",
            "params": {
                "engine": engine,
                "pid": pid,
                "exeName": resolved_exe,
                "sceneId": scene_id,
                "source": source,
                "cliPath": cli_path,
                "flushDelayMs": flush_delay,
                "copyToClipboard": copy_to_clipboard,
                "maxBufferSize": max_buffer,
                "manualHookCode": options["manualHookCode"],
                "autoSelectHookId": options["autoSelectHookId"],
                "autoSelectHookFunction": options["autoSelectHookFunction"],
                "autoSelectProcessorOverrides": options["autoSelectProcessorOverrides"],
            }
        });
        crate::texthook::dispatch(app, start_params).await
    } else {
        Err(format!("Unsupported text hook engine: {engine}"))
    };

    match result {
        Ok(val) if val.get("success").and_then(Value::as_bool) != Some(false) => {
            if let Some(coord) = app.try_state::<TexthookCoordinator>() {
                let mut g = coord.state.lock().unwrap();
                g.generation += 1;
                g.active_engine = Some(engine.clone());
                g.active_exe_name = Some(resolved_exe.clone());
                g.active_pid = Some(pid);
                g.active_scene_id = scene_id.clone();
                g.agent_script_path = options["agentScriptPath"].as_str().map(str::to_owned);
                g.source = source.clone();
                if !val["sessionId"].is_string() || g.last_status["sessionId"] != val["sessionId"] {
                    g.last_status = json!({
                        "running": true,
                        "engine": engine,
                        "pid": pid,
                        "exeName": resolved_exe,
                        "sceneId": scene_id,
                        "source": source,
                        "flushDelayMs": flush_delay,
                        "copyToClipboard": copy_to_clipboard,
                        "maxBufferSize": max_buffer,
                        "sessionId": val["sessionId"],
                    });
                }
            }
            if !internal {
                crate::auto_launcher::notify_texthook_user_start(app);
            }
            sync_backend_texthook_status(app, true);
            Ok(json!({ "success": true, "status": get_status_snapshot(app), "raw": val }))
        }
        Ok(val) => {
            crate::game_privileges::set_target(app, "texthook", None);
            let err = val["error"]
                .as_str()
                .unwrap_or("Failed to start text hook session")
                .to_owned();
            Err(err)
        }
        Err(err) => {
            crate::game_privileges::set_target(app, "texthook", None);
            Err(err)
        }
    }
}

pub async fn stop_session(app: &AppHandle, internal: bool) -> Result<Value, String> {
    if !internal {
        crate::auto_launcher::suppress_current_scene_texthook(app);
    }
    let active_engine = app
        .try_state::<TexthookCoordinator>()
        .and_then(|c| c.state.lock().unwrap().active_engine.clone());

    if let Some(coord) = app.try_state::<TexthookCoordinator>() {
        coord
            .expecting_internal_stop
            .store(internal, Ordering::SeqCst);
    }

    if active_engine.as_deref() == Some("agent")
        || app
            .try_state::<crate::agent::Agent>()
            .is_some_and(|a| a.current_state()["status"]["running"] == true)
    {
        let _ = crate::agent::dispatch(app, json!({ "action": "stop", "params": {} })).await;
    }

    if active_engine.as_deref() != Some("agent")
        || app
            .try_state::<crate::texthook::TextHook>()
            .is_some_and(|t| t.is_running())
    {
        let _ = crate::texthook::dispatch(app, json!({ "action": "stop", "params": {} })).await;
    }

    if let Some(coord) = app.try_state::<TexthookCoordinator>() {
        let mut g = coord.state.lock().unwrap();
        g.active_engine = None;
        g.active_pid = None;
        g.active_exe_name = None;
        g.active_scene_id = None;
        g.last_status = json!({ "running": false });
        g.last_hooks = json!({ "hooks": [], "selectedHookId": Value::Null });
        g.discovery = None;
        g.pending_hook_save = None;
        coord.expecting_internal_stop.store(false, Ordering::SeqCst);
    }

    crate::game_privileges::set_target(app, "texthook", None);
    sync_backend_texthook_status(app, false);
    if !internal {
        crate::auto_launcher::notify_texthook_user_stop(app);
    }
    emit_to_desktop_windows(app, "texthook.status", &[get_status_snapshot(app)]);
    Ok(json!({ "success": true }))
}

fn parse_profile_identity(arg: Option<&Value>) -> (String, Option<String>) {
    match arg {
        Some(Value::String(exe)) => (exe.trim().to_owned(), None),
        Some(Value::Object(map)) => (
            map.get("exeName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned(),
            map.get("sceneId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        ),
        _ => (String::new(), None),
    }
}

pub fn edit_hook_profile(
    app: &AppHandle,
    profiles: &Profiles,
    patch: Value,
    delete: bool,
) -> Result<Value, String> {
    let (exe, scene) = parse_profile_identity(Some(&patch));
    // Serialize explicit changes with automatic saves for the selected hook.
    let coord = app.try_state::<TexthookCoordinator>();
    let mut state = coord.as_ref().map(|c| c.state.lock().unwrap());
    let result = if delete {
        profiles.delete(&exe, scene.as_deref())?;
        Value::Null
    } else {
        profiles.upsert(patch)?
    };
    if let Some(g) = state.as_mut() {
        if g.pending_hook_save
            .as_ref()
            .is_some_and(|save| save.matches_profile(&exe, scene.as_deref()))
        {
            g.pending_hook_save = None;
        }
    }
    Ok(result)
}

async fn active_scene(app: &AppHandle) -> Result<Value, String> {
    app.state::<crate::obs::Obs>()
        .invoke(app, "obs.getActiveScene", &[])
        .await
}

async fn next_hook_batch(receiver: &mut mpsc::Receiver<()>) -> bool {
    if receiver.recv().await.is_none() || receiver.is_closed() {
        return false;
    }
    // Give the game time to draw the dialogue, and collapse changes from other hooks.
    tokio::time::sleep(HOOK_BATCH_DELAY).await;
    let _ = receiver.try_recv();
    !receiver.is_closed()
}

async fn run_hook_discovery(
    app: AppHandle,
    session_id: String,
    mut receiver: mpsc::Receiver<()>,
    batches: mpsc::WeakSender<()>,
) {
    let capture = Arc::new(Mutex::new(gsm_capture::obs::Capture::default()));
    let finder = Arc::new(Mutex::new(gsm_text_preview::HookFinder::new(paths_for(&app).active)));
    while next_hook_batch(&mut receiver).await {
        match compare_hook_batch(&app, &session_id, capture.clone(), finder.clone(), batches.clone()).await {
            Ok(result) => {
                publish_recommendations(&app, &session_id, result);
            }
            Err(error) => {
                if publish_recommendations(&app, &session_id, json!({"status":"error"})) {
                    on_texthook_log_error(&app, &format!("ScreenAI hook comparison: {error}"));
                }
            }
        }
    }
}

fn publish_recommendations(app: &AppHandle, session_id: &str, mut next: Value) -> bool {
    if next.is_null() {
        return false;
    }
    next["sessionId"] = json!(session_id);
    {
        let coord = app.state::<TexthookCoordinator>();
        let mut g = coord.state.lock().unwrap();
        let Some(discovery) = g
            .discovery
            .as_mut()
            .filter(|current| current.session_id == session_id && current.batches.is_some())
        else {
            return false;
        };
        if discovery.latest == next || (next["status"] == "scanning" && !discovery.latest.is_null())
        {
            return false;
        }
        discovery.latest = next.clone();
    }
    emit_to_desktop_windows(app, "texthook.recommendations", &[next]);
    true
}

async fn compare_hook_batch(
    app: &AppHandle,
    session_id: &str,
    capture: Arc<Mutex<gsm_capture::obs::Capture>>,
    finder: Arc<Mutex<gsm_text_preview::HookFinder>>,
    batches: mpsc::WeakSender<()>,
) -> Result<Value, String> {
    let cancelled = || batches.strong_count() == 0;
    let scene = active_scene(app).await?;
    if cancelled() {
        return Ok(Value::Null);
    }
    let (Some(name), Some(scene_id)) = (
        scene["name"].as_str().filter(|name| !name.is_empty()),
        scene["id"].as_str().filter(|id| !id.is_empty()),
    ) else {
        return Ok(json!({"status":"noScene"}));
    };
    let samples = crate::texthook::dispatch(app, json!({"action":"discoverySnapshot"})).await?;
    if cancelled() || samples["sessionId"] != session_id || samples["selectedHookId"].is_string() {
        return Ok(Value::Null);
    }
    if samples["sceneId"]
        .as_str()
        .is_some_and(|expected| !expected.is_empty() && expected != scene_id)
    {
        return Ok(json!({"status":"stale"}));
    }

    publish_recommendations(
        app,
        session_id,
        json!({"status":"scanning","sceneId":scene_id}),
    );
    let during_capture = batches.clone();
    let blocks = crate::ocr_coordinator::scan_scene_text(app, name, capture, move || {
        during_capture.strong_count() == 0
    })
    .await?;
    if cancelled() {
        return Ok(Value::Null);
    }
    if blocks.is_empty() {
        return Ok(json!({"status":"noText","sceneId":scene_id}));
    }
    let during_ranking = batches.clone();
    let matches = tauri::async_runtime::spawn_blocking(move || {
        finder.lock().map_err(|_| "Hook Finder worker failed")?
            .rank(&samples, &blocks, || during_ranking.strong_count() == 0)
    })
    .await
    .map_err(|err| err.to_string())?;
    if cancelled() {
        return Ok(Value::Null);
    }
    let matches = matches?;
    if active_scene(app).await?["id"] != scene_id {
        return Ok(json!({"status":"stale"}));
    }
    Ok(json!({"status":"ok","sceneId":scene_id,"matches":matches}))
}

pub async fn try_invoke(
    app: &AppHandle,
    channel: &str,
    args: &[Value],
) -> Option<Result<Value, String>> {
    if !channel.starts_with("texthook.") {
        return None;
    }
    try_invoke_inner(app, channel, args).await.transpose()
}

async fn try_invoke_inner(
    app: &AppHandle,
    channel: &str,
    args: &[Value],
) -> Result<Option<Value>, String> {
    let result: Result<Value, String> = match channel {
        "texthook.getStatus" => Ok(get_status_snapshot(app)),
        "texthook.getSettings" => {
            let paths = paths_for(app);
            let max_buffer = app
                .try_state::<TexthookCoordinator>()
                .map(|c| c.get_max_buffer_size(&paths.active))
                .unwrap_or(DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE);
            let target_language = get_configured_target_language(&paths.active.join("config.json"));
            Ok(json!({ "maxBufferSize": max_buffer, "targetLanguage": target_language }))
        }
        "texthook.setMaxBufferSize" => {
            let max_buffer = normalize_max_buffer_size(args.first());
            let paths = paths_for(app);
            let config_path = paths.active.join("config.json");
            let save_res =
                tokio::task::spawn_blocking(move || save_max_buffer_size(&config_path, max_buffer))
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|r| r);
            match save_res {
                Ok(()) => {
                    if let Some(coord) = app.try_state::<TexthookCoordinator>() {
                        coord.state.lock().unwrap().max_buffer_size = Some(max_buffer);
                    }
                    let _ = crate::texthook::dispatch(
                        app,
                        json!({ "action": "configure", "params": { "maxBufferSize": max_buffer } }),
                    )
                    .await;
                    let _ = crate::agent::dispatch(
                        app,
                        json!({ "action": "setMaxBufferSize", "params": { "value": max_buffer } }),
                    )
                    .await;
                    Ok(json!({ "success": true, "maxBufferSize": max_buffer }))
                }
                Err(error) => Ok(json!({ "success": false, "error": error })),
            }
        }
        "texthook.getActiveCapture" => {
            let obs_state = app.try_state::<crate::obs::Obs>();
            let capture = if let Some(ref obs) = obs_state {
                obs.capture_identity_for_scene(app, None).await
            } else {
                None
            };
            let (scene_id, title, exe) = match capture {
                Some((id, title, exe)) => (Some(id), Some(title), Some(exe)),
                None => (None, None, None),
            };
            let exe_name = exe.as_deref().unwrap_or("");
            let pid = if !exe_name.is_empty() {
                find_primary_pid_by_exe(exe_name)
            } else {
                None
            };
            let active_scene_name = if let Some(ref obs) = obs_state {
                obs.invoke(app, "obs.getActiveScene", &[])
                    .await
                    .ok()
                    .and_then(|v| v["name"].as_str().map(str::to_owned))
            } else {
                None
            };
            let configured_exe = active_scene_name
                .as_deref()
                .map(|name| {
                    get_game_exe_path_for_scene(&Preferences::new(&paths_for(app).active), name)
                })
                .unwrap_or_default();
            Ok(json!({
                "sceneId": scene_id,
                "sceneName": active_scene_name,
                "windowTitle": title,
                "exeName": exe,
                "pid": pid,
                "gameExePath": configured_exe,
            }))
        }
        "texthook.start" => {
            let opts = args.first().cloned().unwrap_or_else(|| json!({}));
            match start_session(app, opts, false).await {
                Ok(v) => Ok(v),
                Err(e) => Ok(json!({ "success": false, "error": e })),
            }
        }
        "texthook.stop" => stop_session(app, false).await,
        "texthook.getRecommendations" => Ok(app
            .state::<TexthookCoordinator>()
            .state
            .lock()
            .unwrap()
            .discovery
            .as_ref()
            .map(|discovery| discovery.latest.clone())
            .unwrap_or(Value::Null)),
        "texthook.selectHook" => {
            let hook_id = args.first().and_then(Value::as_str).unwrap_or("");
            let mut params = json!({"hookId":hook_id});
            if let Some(recommendation) = args.get(1) {
                if !recommendation["sessionId"].is_string()
                    || !recommendation["sceneId"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
                    || recommendation["sceneId"] != active_scene(app).await?["id"]
                {
                    return Ok(Some(json!({"success":false})));
                }
                params["sessionId"] = recommendation["sessionId"].clone();
                if recommendation["processorOverrides"].is_object() {
                    params["processorOverrides"] = recommendation["processorOverrides"].clone();
                }
            }
            let success =
                crate::texthook::dispatch(app, json!({"action":"select","params":params})).await?
                    == true;
            Ok(json!({
                "success":success,
                "processorOverrides":get_status_snapshot(app)["processorOverrides"],
            }))
        }
        "texthook.attachManualHook" => {
            let code = args.first().and_then(Value::as_str).unwrap_or("");
            crate::texthook::dispatch(
                app,
                json!({ "action": "manual", "params": { "code": code } }),
            )
            .await
        }
        "texthook.setFlushDelay" => {
            let delay = args
                .first()
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .unwrap_or(100.0)
                .round()
                .clamp(0.0, 5000.0) as u64;
            if get_status_snapshot(app)["engine"] == "agent" {
                crate::agent::dispatch(
                    app,
                    json!({ "action": "setFlushDelay", "params": { "value": delay } }),
                )
                .await
            } else {
                crate::texthook::dispatch(
                    app,
                    json!({ "action": "configure", "params": { "flushDelayMs": delay } }),
                )
                .await
            }
        }
        "texthook.setCopyToClipboard" => {
            let copy = args.first().and_then(Value::as_bool).unwrap_or(false);
            if get_status_snapshot(app)["engine"] == "agent" {
                crate::agent::dispatch(
                    app,
                    json!({ "action": "setCopyToClipboard", "params": { "value": copy } }),
                )
                .await
            } else {
                crate::texthook::dispatch(
                    app,
                    json!({ "action": "configure", "params": { "copyToClipboard": copy } }),
                )
                .await
            }
        }
        "texthook.listHooks" => Ok(get_list_hooks_snapshot(app)),
        "texthook.devSendLargePayload" => {
            let text = args.first().and_then(Value::as_str).unwrap_or("");
            if text.is_empty() {
                Ok(json!({"success":false}))
            } else if let Some((text, truncated)) = sanitize_texthook_text(
                text,
                app.state::<TexthookCoordinator>()
                    .get_max_buffer_size(&paths_for(app).active),
            ) {
                crate::runtime::get(app)?;
                crate::runtime::observe_hook(
                    app,
                    json!({"text":text,"hookId":"dev-large-payload", "hookFunction":"dev-large-payload","engine":"luna","exeName":"dev-large-payload","copyToClipboard":false}),
                );
                Ok(json!({"success":true,"truncated":truncated}))
            } else {
                Ok(
                    json!({"success":false,"blockedByHardLimit":text.encode_utf16().count()>HARD_TEXT_HOOK_REJECTION_LIMIT,"limit":HARD_TEXT_HOOK_REJECTION_LIMIT}),
                )
            }
        }
        "texthook.builtInHookTargets" => Ok(json!([])),
        "texthook.advance" => Ok(json!({
            "success": false,
            "error": "Built-in engine hooks are unavailable."
        })),
        "texthook.showAgentUi" => {
            crate::agent::dispatch(app, json!({ "action": "showUi", "params": {} })).await
        }
        "texthook.agentUiRpcCall" => {
            let func = args.first().and_then(Value::as_str).unwrap_or("");
            let rpc_args = args
                .get(1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            crate::agent::dispatch(
                app,
                json!({ "action": "rpcCall", "params": { "func": func, "args": rpc_args } }),
            )
            .await
        }
        "texthook.agentUiRpcSend" => {
            let func = args.first().and_then(Value::as_str).unwrap_or("");
            let rpc_args = args
                .get(1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            crate::agent::dispatch(
                app,
                json!({ "action": "rpcSend", "params": { "func": func, "args": rpc_args } }),
            )
            .await
        }
        "texthook.getProfile" => {
            let (exe, scene) = parse_profile_identity(args.first());
            Profiles::new(&paths_for(app).active).get(&exe, scene.as_deref())
        }
        "texthook.saveProfile" => {
            let mut payload = args.first().cloned().unwrap_or_else(|| json!({}));
            if payload["exeName"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
            {
                let (exe, pid, scene_id) = app
                    .try_state::<TexthookCoordinator>()
                    .map(|c| c.active_identity())
                    .unwrap_or((None, None, None));
                let fallback_exe = exe.or_else(|| {
                    pid.and_then(|p| {
                        process_executable_path(p).and_then(|path| {
                            path.file_name().map(|n| n.to_string_lossy().into_owned())
                        })
                    })
                });
                if let Some(exe_name) = fallback_exe {
                    payload["exeName"] = json!(exe_name);
                }
                if payload["sceneId"].is_null() {
                    if let Some(id) = scene_id {
                        payload["sceneId"] = json!(id);
                    }
                }
            }
            crate::settings::dispatch(app, json!({"action":"profiles.upsert","params":payload}))
                .await
        }
        "texthook.deleteProfile" => {
            let (exe, scene) = parse_profile_identity(args.first());
            crate::settings::dispatch(
                app,
                json!({"action":"profiles.delete","params":{"exeName":exe,"sceneId":scene}}),
            )
            .await
            .map(|_| json!({ "success": true }))
        }
        "texthook.getAllProfiles" => Profiles::new(&paths_for(app).active).list(),
        "texthook.getGameExePath" => {
            let scene_name = args.first().and_then(Value::as_str).unwrap_or("");
            let path =
                get_game_exe_path_for_scene(&Preferences::new(&paths_for(app).active), scene_name);
            Ok(json!(path))
        }
        "texthook.setGameExePath" => {
            let obj = args.first().and_then(Value::as_object);
            let scene_name = obj
                .and_then(|m| m.get("sceneName"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned();
            let exe_path = obj
                .and_then(|m| m.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned();
            if scene_name.is_empty() {
                Ok(json!({ "success": false, "error": "sceneName is required" }))
            } else {
                match set_game_exe_path_for_scene(
                    &Preferences::new(&paths_for(app).active),
                    &scene_name,
                    &exe_path,
                ) {
                    Ok(()) => {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            crate::auto_launcher::sync_process_pausing_for_current_scene(
                                &app_clone,
                            )
                            .await;
                        });
                        Ok(json!({ "success": true }))
                    }
                    Err(e) => Ok(json!({ "success": false, "error": e })),
                }
            }
        }
        "texthook.browseGameExe" => {
            let selected = dialog_open(&json!({
                "title": "Select the game executable",
                "properties": ["openFile"],
                "filters": [
                    { "name": "Executables", "extensions": ["exe"] },
                    { "name": "All Files", "extensions": ["*"] }
                ]
            }))
            .await?;
            let canceled = selected["canceled"].as_bool().unwrap_or(false);
            let path = selected["filePaths"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if canceled || path.is_empty() {
                Ok(json!({ "canceled": true, "path": "" }))
            } else {
                Ok(json!({ "canceled": false, "path": path }))
            }
        }
        "texthook.autoDetectGameExe" => {
            let config_path = paths_for(app).active.join("config.json");
            let url =
                gsm_settings::gsm_config::gsm_backend_url(&config_path, "/linux/detect_game_exe");
            let http = app
                .state::<crate::desktop_state::DesktopState>()
                .http
                .clone();
            match http
                .get(&url)
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await
            {
                Ok(resp) => {
                    let data: Value = resp.json().await.unwrap_or_else(|_| json!({}));
                    let path = data["path"].as_str().unwrap_or("").to_owned();
                    Ok(json!({ "path": path }))
                }
                Err(err) => Ok(json!({ "path": "", "error": err.to_string() })),
            }
        }
        "texthook.getEngineStatus" => {
            crate::hook_updates::dispatch(app, "state", Value::Null).await
        }
        "texthook.checkEngineUpdates" => {
            crate::hook_updates::dispatch(app, "check", Value::Null).await
        }
        "texthook.installEngineVersion" => {
            let version = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| "Invalid engine package version.".to_owned())?;
            emit_to_desktop_windows(
                app,
                "texthook.engineDownloadStarted",
                &[json!({ "version": version })],
            );
            let res = crate::hook_updates::dispatch(app, "version", json!(version)).await;
            emit_to_desktop_windows(
                app,
                "texthook.engineDownloadComplete",
                &[json!({ "ok": res.is_ok() })],
            );
            res
        }
        "texthook.downloadEngines" => {
            emit_to_desktop_windows(app, "texthook.engineDownloadStarted", &[json!({})]);
            let res = crate::hook_updates::dispatch(app, "download", Value::Null).await;
            emit_to_desktop_windows(
                app,
                "texthook.engineDownloadComplete",
                &[json!({ "ok": res.is_ok() })],
            );
            res
        }
        "texthook.setAutomaticEngineUpdates" => {
            let enabled = args
                .first()
                .and_then(Value::as_bool)
                .ok_or_else(|| "Expected an automatic updates preference.".to_owned())?;
            crate::hook_updates::dispatch(app, "automatic", json!(enabled)).await
        }
        _ => return Ok(None),
    };
    result.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hook_discovery_waits_for_events_and_coalesces_while_busy() {
        let (sender, mut receiver) = mpsc::channel(1);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), next_hook_batch(&mut receiver))
                .await
                .is_err()
        );

        sender.try_send(()).unwrap();
        let (ready, ()) = tokio::join!(next_hook_batch(&mut receiver), async {
            tokio::task::yield_now().await;
            sender.try_send(()).unwrap();
            assert!(sender.try_send(()).is_err());
        });
        assert!(ready);
        assert!(receiver.is_empty());

        // Text that arrives during OCR becomes the next batch.
        sender.try_send(()).unwrap();
        assert!(next_hook_batch(&mut receiver).await);
        sender.try_send(()).unwrap();
        drop(sender);
        assert!(!next_hook_batch(&mut receiver).await);
    }

    #[tokio::test]
    async fn hook_selection_cancels_ocr_work_and_keeps_the_last_recommendations() {
        let (batches, mut receiver) = mpsc::channel(1);
        let worker = batches.downgrade();
        batches.try_send(()).unwrap();
        let latest = json!({"status":"ok","matches":[{"hookId":"43","tier":"filtered"}]});
        let mut discovery = HookDiscovery {
            session_id: "1".into(),
            batches: Some(batches),
            latest: latest.clone(),
        };
        discovery.stop();
        assert_eq!(worker.strong_count(), 0);
        assert!(!next_hook_batch(&mut receiver).await);
        assert_eq!(discovery.latest, latest);
    }

    #[test]
    fn hook_autosave_requires_three_distinct_accepted_lines_from_the_selection() {
        let mut save = PendingHookSave::new(&json!({
            "sessionId":"3", "selectionRevision":2,
            "profile":{"exeName":"game.exe", "hookId":"43"},
        }))
        .unwrap();
        let output = json!({"sessionId":"3", "selectionRevision":2, "hookId":"43"});
        let accepted = |text: &str| json!({"status":"accepted", "processed_text":text});
        assert!(!save.record_line(&output, &accepted(" ")));
        let mut stale = output.clone();
        stale["selectionRevision"] = json!(1);
        assert!(!save.record_line(&stale, &accepted("From a previous selection")));
        stale["selectionRevision"] = json!(2);
        stale["sessionId"] = json!("2");
        assert!(!save.record_line(&stale, &accepted("From a previous attachment")));
        assert!(!save.record_line(
            &output,
            &json!({"status":"duplicate","processed_text":"Duplicate"})
        ));
        assert!(!save.record_line(&output, &accepted("First line")));
        assert!(!save.record_line(&output, &accepted("First line ")));
        assert!(!save.record_line(&output, &accepted("Second line")));
        assert!(save.record_line(&output, &accepted("Third line")));
        assert!(!save.record_line(&output, &accepted("Fourth line")));
    }

    #[test]
    fn hook_autosave_retains_filters_in_the_scene_and_preserves_auto_attach_preference() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = Profiles::new(dir.path());
        profiles
            .upsert(json!({"exeName":"game.exe","autoHook":false,"hookId":"old"}))
            .unwrap();
        let processor_overrides = json!({"remove_control_chars":true,"language_filter":true,"language_filter_mode":"trim"});
        let save = PendingHookSave::new(&json!({
            "sessionId":"3", "selectionRevision":2,
            "profile":{"exeName":"game.exe","sceneId":"game-scene","engine":"luna","hookId":"43",
                "hookFunction":"TextOutW","processorOverrides":processor_overrides},
        }))
        .unwrap();
        assert!(save.matches_profile("GAME.exe", Some("GAME-SCENE")));
        assert!(!save.matches_profile("game.exe", Some("another-scene")));
        let saved = save
            .save(
                &profiles,
                &json!({"flushDelayMs":150,"copyToClipboard":true}),
            )
            .unwrap();
        assert_eq!(saved["autoHook"], false);
        assert_eq!(saved["processorOverrides"], processor_overrides);
        assert_eq!(saved["flushDelayMs"], 150);
        assert_eq!(saved["copyToClipboard"], true);
        assert_eq!(profiles.get("game.exe", None).unwrap()["hookId"], "old");
        assert_eq!(profiles.get("game.exe", Some("game-scene")).unwrap(), saved);
    }

    use serde_json::json;

    const ENGINE_CLIS: &[(&str, &str, &str)] = &[
        ("luna", "x86", "luna_builds/LunaHostCLI32.exe"),
        ("luna", "x64", "luna_builds/LunaHostCLI64.exe"),
        (
            "textractor",
            "x86",
            "textractor_builds/_x86/TextractorCLI.exe",
        ),
        (
            "textractor",
            "x64",
            "textractor_builds/_x64/TextractorCLI.exe",
        ),
    ];

    #[test]
    fn engine_cli_paths_support_legacy_installations() {
        let dir = tempfile::tempdir().unwrap();
        for &(engine, arch, relative) in ENGINE_CLIS {
            let cli = dir.path().join("texthook").join(relative);
            std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
            std::fs::write(&cli, b"legacy").unwrap();
            assert_eq!(engine_cli_path(dir.path(), engine, arch), cli);
        }
    }

    #[test]
    fn engine_cli_paths_follow_the_selected_package() {
        use gsm_packages::engines::{Engines, SENTINELS};

        let dir = tempfile::tempdir().unwrap();
        let engines = Engines::new(dir.path());
        // Old files must not override the package selected by the updater.
        for relative in SENTINELS {
            let legacy = engines.root.join(relative);
            std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
            std::fs::write(legacy, b"legacy").unwrap();
        }
        for package in ["a".repeat(32), "b".repeat(32)] {
            let package_directory = format!("packages/{package}");
            let root = engines.root.join(&package_directory);
            for relative in SENTINELS {
                let file = root.join(relative);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, b"package").unwrap();
            }
            write_atomic(
                &engines.root.join("texthook_manifest.json"),
                &json!({
                    "version": "1.0.4",
                    "packageDirectory": package_directory,
                    "files": SENTINELS.iter().map(|path| json!({
                        "path": path, "sha256": "0".repeat(64)
                    })).collect::<Vec<_>>()
                }),
            )
            .unwrap();
            assert!(engines.installed());
            for &(engine, arch, relative) in ENGINE_CLIS {
                assert_eq!(
                    engine_cli_path(dir.path(), engine, arch),
                    root.join(relative)
                );
            }
            for engine in ["luna", "textractor"] {
                let (_, cli) = resolve_cli_for_pid(dir.path(), engine, std::process::id());
                assert!(cli.unwrap().starts_with(&root));
            }
        }
    }

    #[test]
    fn saved_hook_settings_use_native_engine_option_names() {
        for engine in ["luna", "textractor"] {
            let profile = json!({"engine":engine,"autoHook":true,"hookId":"43","hookFunction":"TextOutW (921:0)","manualHookCode":"HS@401000","flushDelayMs":250,"copyToClipboard":true});
            let options = apply_saved_hook_options(json!({"engine":engine}), &profile);
            assert_eq!(options["autoSelectHookId"], "43");
            assert_eq!(options["autoSelectHookFunction"], "TextOutW (921:0)");
            assert_eq!(options["manualHookCode"], "HS@401000");
            assert_eq!(options["flushDelayMs"], 250);
            assert_eq!(options["copyToClipboard"], true);
            let explicit = apply_saved_hook_options(
                json!({"engine":engine,"flushDelayMs":0,"copyToClipboard":false}),
                &profile,
            );
            assert_eq!(explicit["flushDelayMs"], 0);
            assert_eq!(explicit["copyToClipboard"], false);
            let mut disabled = profile.clone();
            disabled["autoHook"] = json!(false);
            assert!(
                apply_saved_hook_options(json!({"engine":engine}), &disabled)["autoSelectHookId"]
                    .is_null()
            );
            assert!(
                apply_saved_hook_options(json!({"engine":"agent"}), &profile)["manualHookCode"]
                    .is_null()
            );
        }
        let options = apply_saved_hook_options(
            json!({"engine":"agent"}),
            &json!({"engine":"agent","agentScriptPath":"saved.js","agentDetached":false}),
        );
        assert_eq!(options["agentScriptPath"], "saved.js");
        assert_eq!(options["agentDetached"], false);
    }

    #[test]
    fn sanitize_and_buffer_rules_match_legacy_contract() {
        assert_eq!(
            normalize_max_buffer_size(None),
            DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE
        );
        assert_eq!(
            normalize_max_buffer_size(Some(&json!(0))),
            DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE
        );
        assert_eq!(
            normalize_max_buffer_size(Some(&json!(999_999))),
            MAX_TEXT_HOOK_MAX_BUFFER_SIZE
        );
        assert_eq!(normalize_max_buffer_size(Some(&json!("1234.6"))), 1235);

        let too_long = "あ".repeat(HARD_TEXT_HOOK_REJECTION_LIMIT + 1);
        assert!(sanitize_texthook_text(&too_long, 3000).is_none());

        let too_many_quotes = "「a」".repeat(MAX_JAPANESE_QUOTE_PAIRS + 1);
        assert!(sanitize_texthook_text(&too_many_quotes, 3000).is_none());

        let (trunc, did_trunc) = sanitize_texthook_text("こんにちは世界", 5).unwrap();
        assert_eq!(trunc, "こんにちは");
        assert!(did_trunc);

        let mut buf = Vec::new();
        append_hook_fragment(&mut buf, json!({"text": "こ", "capturedAt": 100}));
        append_hook_fragment(&mut buf, json!({"text": "こん", "capturedAt": 110}));
        append_hook_fragment(&mut buf, json!({"text": "別行", "capturedAt": 200}));
        assert_eq!(buf.len(), 2);
        assert_eq!(buf[0]["text"], "こん");
        assert_eq!(buf[0]["capturedAt"], 100);
        assert_eq!(buf[1]["text"], "別行");
    }

    #[test]
    fn save_and_load_max_buffer_size_roundtrips_config() {
        let dir = std::env::temp_dir().join(format!(
            "gsm-texthook-cfg-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.json");
        std::fs::write(
            &cfg,
            r#"{"current_profile":"Default","configs":{"Default":{"general":{}}}}"#,
        )
        .unwrap();

        save_max_buffer_size(&cfg, 4567).unwrap();
        assert_eq!(load_max_buffer_size(&cfg), 4567);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
