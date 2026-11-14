//! Native Rust coordinator for integrated TextHook/Agent sessions, sanitization,
//! profile/exe resolution, engine updates, and desktop window events.

use crate::desktop_services::paths_for;
use crate::desktop_state::emit_to_desktop_windows;
use crate::native::dialog_open;
use crate::process_probe::{find_primary_pid_by_exe, pe_bitness, process_executable_path};
use crate::settings_tools::{get_game_exe_path_for_scene, set_game_exe_path_for_scene};
use gsm_settings::preferences::Preferences;
use gsm_settings::profiles::Profiles;
use gsm_settings::{read_object, write_atomic};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE: usize = 3000;
pub const MAX_TEXT_HOOK_MAX_BUFFER_SIZE: usize = 100_000;
pub const HARD_TEXT_HOOK_REJECTION_LIMIT: usize = 10_000;
pub const MAX_JAPANESE_QUOTE_PAIRS: usize = 10;

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
    let base = shared_dir.join("texthook");
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
            }
            if g.active_engine.as_deref() != Some("agent") || running {
                g.last_status = data.clone();
            }
        } else if event == "texthook.hooks" {
            g.last_hooks = data.clone();
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

pub fn on_texthook_log_error(app: &AppHandle, message: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    emit_to_desktop_windows(
        app,
        "texthook.log",
        &[json!({ "level": "error", "message": message, "ts": ts })],
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
                });
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
            Ok(json!({ "maxBufferSize": max_buffer }))
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
        "texthook.selectHook" => {
            let hook_id = args.first().and_then(Value::as_str).unwrap_or("");
            crate::texthook::dispatch(
                app,
                json!({ "action": "select", "params": { "hookId": hook_id } }),
            )
            .await
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
            if text.is_empty() { Ok(json!({"success":false})) }
            else if let Some((text, truncated)) = sanitize_texthook_text(text, app.state::<TexthookCoordinator>().get_max_buffer_size(&paths_for(app).active)) {
                crate::runtime::get(app)?;
                crate::runtime::observe_hook(app, json!({"text":text,"hookId":"dev-large-payload", "hookFunction":"dev-large-payload","engine":"luna","exeName":"dev-large-payload","copyToClipboard":false}));
                Ok(json!({"success":true,"truncated":truncated}))
            } else { Ok(json!({"success":false,"blockedByHardLimit":text.encode_utf16().count()>HARD_TEXT_HOOK_REJECTION_LIMIT,"limit":HARD_TEXT_HOOK_REJECTION_LIMIT})) }
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
            Profiles::new(&paths_for(app).active).upsert(payload)
        }
        "texthook.deleteProfile" => {
            let (exe, scene) = parse_profile_identity(args.first());
            Profiles::new(&paths_for(app).active)
                .delete(&exe, scene.as_deref())
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
    use serde_json::json;

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
