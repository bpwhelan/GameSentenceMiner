//! Native IPC handlers for Home/Front state, Texthooker opener, Steam, VN, and Yuzu game launchers.

use crate::agent_scripts::{
    find_agent_script_by_id, list_agent_script_files, score_script_for_query,
};
use crate::desktop_services::paths_for;
use crate::desktop_state::emit_to_desktop_windows;
use crate::native::dialog_open;
use crate::obs::Obs;
use crate::ocr_coordinator::ocr_config_paths;
use crate::settings_tools::prepare_agent_scripts_dir;
use crate::texthook_coordinator;
use gsm_settings::preferences::Preferences;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub async fn open_text_feed(app: &AppHandle) -> Result<(), String> {
    let config = paths_for(app).active.join("config.json");
    let port = app.state::<std::sync::Arc<crate::mining::MiningService>>().bound_gateway_port()
        .unwrap_or_else(|| gsm_settings::gsm_config::get_configured_single_port(&config));
    tauri::async_runtime::spawn_blocking(move || crate::native::shell_open_external(&format!("http://localhost:{port}")))
        .await.map_err(|e| e.to_string())?
}

fn electron_config_path(app: &AppHandle) -> PathBuf {
    paths_for(app).active.join("electron/config.json")
}

fn read_store_object(app: &AppHandle) -> Map<String, Value> {
    let path = electron_config_path(app);
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_store_object(app: &AppHandle, map: &Map<String, Value>) -> Result<(), String> {
    let path = electron_config_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(&Value::Object(map.clone()))
        .map_err(|e| format!("Failed serializing config: {e}"))?;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    fs::write(&tmp, body).map_err(|e| format!("Failed writing {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed renaming {}: {e}", path.display())
    })
}

fn update_nested_section(
    map: &mut Map<String, Value>,
    section: &str,
    key: &str,
    value: Value,
) {
    let mut sub = map
        .get(section)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    sub.insert(key.to_owned(), value);
    map.insert(section.to_owned(), Value::Object(sub));
}

async fn pick_file(filters: Value) -> Option<String> {
    let res = dialog_open(&json!({
        "properties": ["openFile"],
        "filters": filters,
    }))
    .await
    .ok()?;
    if res["canceled"] == true {
        return None;
    }
    res["filePaths"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .map(str::to_owned)
}

async fn pick_directory() -> Option<String> {
    let res = dialog_open(&json!({
        "properties": ["openDirectory"],
    }))
    .await
    .ok()?;
    if res["canceled"] == true {
        return None;
    }
    res["filePaths"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Extract `(name, title_id)` from a Switch ROM filename like `"Game Title [0100ABCD12340000].nsp"`.
pub fn parse_rom_name_and_id(filename: &str) -> Option<(String, String)> {
    let chars: Vec<char> = filename.chars().collect();
    let mut best: Option<(usize, usize)> = None;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' || chars[i] == '(' {
            let close = if chars[i] == '[' { ']' } else { ')' };
            let mut j = i + 1;
            let mut valid = j < chars.len();
            while j < chars.len() && chars[j] != close {
                if !chars[j].is_ascii_alphanumeric() && chars[j] != '_' {
                    valid = false;
                    break;
                }
                j += 1;
            }
            if valid && j > i + 1 && j < chars.len() && chars[j] == close {
                best = Some((i, j));
                break;
            }
        }
        i += 1;
    }
    let (open_idx, close_idx) = best?;
    let name: String = chars[..open_idx].iter().collect();
    let trimmed_name = name.trim_end();
    if trimmed_name.is_empty() {
        return None;
    }
    let id: String = chars[open_idx + 1..close_idx].iter().collect();
    Some((trimmed_name.to_owned(), id))
}

pub fn scan_yuzu_games_dir(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut games = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some((title, id)) = parse_rom_name_and_id(&name) {
            let abs = fs::canonicalize(entry.path()).unwrap_or_else(|_| entry.path());
            games.push(json!({
                "id": id,
                "name": title,
                "path": abs.to_string_lossy(),
            }));
        }
    }
    games
}

fn spawn_detached(exe: &str, args: &[String], cwd: Option<&Path>) -> Result<u32, String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = cwd {
        if dir.is_dir() {
            cmd.current_dir(dir);
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed launching {exe}: {e}"))?;
    Ok(child.id())
}

async fn launch_steam_game_by_name(
    app: &AppHandle,
    name: &str,
    should_launch_agent: bool,
) -> Result<(), String> {
    let store = read_store_object(app);
    let games = store["steam"]["steamGames"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let Some(game) = games
        .into_iter()
        .find(|g| g["name"].as_str() == Some(name))
    else {
        return Err(format!("Steam game \"{name}\" not found"));
    };

    let steam_path = store["steam"]["steamPath"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let exe_override = game["executablePath"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let pid = if let Some(exe_path) = exe_override {
        spawn_detached(exe_path, &[], Path::new(exe_path).parent())?
    } else if !steam_path.is_empty() {
        let id_str = game["id"]
            .as_u64()
            .map(|n| n.to_string())
            .or_else(|| game["id"].as_str().map(str::to_owned))
            .unwrap_or_default();
        spawn_detached(
            &steam_path,
            &["-applaunch".into(), id_str],
            Path::new(&steam_path).parent(),
        )?
    } else {
        return Err("Steam path is not configured".into());
    };

    if should_launch_agent && game["runAgent"] == true {
        let delay = game["agentDelay"].as_f64().unwrap_or(5.0).clamp(0.0, 30.0);
        let script = game["script"].as_str().unwrap_or("").to_owned();
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            if delay > 0.0 {
                tokio::time::sleep(Duration::from_secs_f64(delay)).await;
            }
            let _ = texthook_coordinator::start_session(
                &app_clone,
                json!({
                    "engine": "agent",
                    "pid": pid,
                    "agentScriptPath": script,
                    "source": "launcher",
                }),
                true,
            )
            .await;
        });
    }
    Ok(())
}

async fn launch_vn_by_path(
    app: &AppHandle,
    vn_path: &str,
    should_launch_textractor: bool,
) -> Result<(), String> {
    let exe_dir = Path::new(vn_path).parent();
    let pid = spawn_detached(vn_path, &[], exe_dir)?;
    if should_launch_textractor {
        let app_clone = app.clone();
        let exe_name = Path::new(vn_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_owned();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let _ = texthook_coordinator::start_session(
                &app_clone,
                json!({
                    "engine": "textractor",
                    "pid": pid,
                    "exeName": exe_name,
                    "source": "launcher",
                }),
                true,
            )
            .await;
        });
    }
    Ok(())
}

async fn launch_yuzu_game_by_id(
    app: &AppHandle,
    game_id: &str,
    should_launch_agent: bool,
) -> Result<(), String> {
    let paths = paths_for(app);
    let store = read_store_object(app);
    let roms_path = store["yuzu"]["romsPath"].as_str().unwrap_or("");
    let emu_path = store["yuzu"]["emuPath"].as_str().unwrap_or("");
    if emu_path.trim().is_empty() {
        return Err("Yuzu emulator path is not configured".into());
    }
    let roms = scan_yuzu_games_dir(Path::new(roms_path));
    let Some(selected) = roms.into_iter().find(|g| g["id"].as_str() == Some(game_id)) else {
        return Err(format!("Yuzu game {game_id} not found"));
    };
    let rom_file = selected["path"].as_str().unwrap_or("").to_owned();
    let pid = spawn_detached(
        emu_path,
        &["-f".into(), "-g".into(), rom_file],
        Path::new(emu_path).parent(),
    )?;
    if should_launch_agent {
        let active_dir = paths.active.clone();
        let game_id_owned = game_id.to_owned();
        let script = tauri::async_runtime::spawn_blocking(move || {
            let prefs = Preferences::new(&active_dir);
            let scripts_dir = prepare_agent_scripts_dir(&prefs, &active_dir, None).dir;
            let files = list_agent_script_files(&scripts_dir);
            find_agent_script_by_id(&files, &game_id_owned).unwrap_or_default()
        })
        .await
        .unwrap_or_default();
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let _ = texthook_coordinator::start_session(
                &app_clone,
                json!({
                    "engine": "agent",
                    "pid": pid,
                    "agentScriptPath": script,
                    "source": "launcher",
                }),
                true,
            )
            .await;
        });
    }
    Ok(())
}

fn open_game_config_window(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("game-config") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let desktop = app.state::<crate::desktop_state::DesktopState>();
    let root = &desktop.app_root;
    let url_str = desktop
        .assets
        .url(&root.join("assets/game_config.html").to_string_lossy())
        .map(|u| u.to_string())
        .unwrap_or_default();
    let parsed: url::Url = url_str
        .parse()
        .map_err(|e| format!("Invalid game_config URL: {e}"))?;
    let token = uuid::Uuid::new_v4().to_string();
    let preload = crate::overlay_preload::render_desktop_preload(&token);
    desktop.register_window_with_token("game-config", "desktop", token);
    let win = WebviewWindowBuilder::new(app, "game-config", WebviewUrl::External(parsed))
        .title("Game Configuration")
        .inner_size(1280.0, 1000.0)
        .min_inner_size(800.0, 500.0)
        .initialization_script(preload)
        .build()
        .map_err(|e| format!("Failed opening game config window: {e}"))?;
    let _ = win.show();
    Ok(())
}

pub async fn try_invoke(
    app: &AppHandle,
    channel: &str,
    args: &[Value],
) -> Option<Result<Value, String>> {
    match channel {
        // --- Front Page State & Helpers ---
        "front.saveState" => {
            let incoming = args.first().cloned().unwrap_or_else(|| json!({}));
            let mut store = read_store_object(app);
            let mut next_state = store
                .get("frontPageState")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(obj) = incoming.as_object() {
                for (k, v) in obj {
                    if k != "hookableGames" && k != "ocrGames" {
                        next_state.insert(k.clone(), v.clone());
                    }
                }
            }
            store.insert("frontPageState".into(), Value::Object(next_state));
            Some(Ok(match write_store_object(app, &store) {
                Ok(()) => json!({ "status": "success", "message": "State saved successfully" }),
                Err(e) => json!({ "status": "error", "message": format!("Failed to save state: {e}") }),
            }))
        }
        "front.getSavedState" => {
            let store = read_store_object(app);
            let mut state = store
                .get("frontPageState")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let steam_games = store["steam"]["steamGames"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let yuzu_games = store["yuzu"]["games"]
                .as_array()
                .cloned()
                .unwrap_or_default();

            let mut launchable = vec![json!({
                "name": "Game",
                "id": "0",
                "type": "none",
                "isHeader": true,
                "scene": Value::Null,
            })];
            for g in steam_games {
                launchable.push(json!({
                    "name": g["name"],
                    "id": g["id"].as_u64().map(|n| n.to_string()).unwrap_or_else(|| g["id"].as_str().unwrap_or("").to_owned()),
                    "type": "steam",
                    "scene": g["scene"],
                }));
            }
            launchable.push(json!({
                "name": "Yuzu",
                "id": "0",
                "type": "none",
                "isHeader": true,
                "scene": Value::Null,
            }));
            for g in yuzu_games {
                launchable.push(json!({
                    "name": g["name"],
                    "id": g["id"],
                    "type": "yuzu",
                    "scene": g["scene"],
                }));
            }
            state.insert("launchableGames".into(), Value::Array(launchable));
            Some(Ok(Value::Object(state)))
        }
        "front.getAllOCRConfigs" => {
            let paths = paths_for(app);
            let scenes = if let Some(obs) = app.try_state::<Obs>() {
                obs.invoke(app, "obs.getScenes", &[])
                    .await
                    .ok()
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let mut out = Vec::new();
            for scene in scenes {
                let name = scene["name"]
                    .as_str()
                    .or_else(|| scene.as_str())
                    .unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                let (cfg_path, _) = ocr_config_paths(&paths.active, name);
                if cfg_path.is_file() {
                    out.push(json!({
                        "scene": scene,
                        "configPath": cfg_path.to_string_lossy(),
                    }));
                }
            }
            Some(Ok(Value::Array(out)))
        }
        "openTexthooker" => {
            Some(open_text_feed(app).await.map(|_| Value::Null))
        }

        // --- Steam ---
        "steam.getSteamGames" => {
            let store = read_store_object(app);
            Some(Ok(store["steam"]["steamGames"]
                .as_array()
                .map(|a| Value::Array(a.clone()))
                .unwrap_or_else(|| json!([]))))
        }
        "steam.getSteamLaunchOnStart" | "steam.getLaunchOnStart" => {
            let store = read_store_object(app);
            Some(Ok(store["steam"]["launchSteamOnStart"]
                .as_i64()
                .map(|n| json!(n))
                .unwrap_or_else(|| json!(0))))
        }
        "steam.setSteamLaunchOnStart" => {
            let game_id = args.first().cloned().unwrap_or_else(|| json!(0));
            let mut store = read_store_object(app);
            update_nested_section(&mut store, "steam", "launchSteamOnStart", game_id);
            Some(Ok(write_store_object(app, &store).map(|_| Value::Null).unwrap_or(Value::Null)))
        }
        "steam.getLastSteamGameLaunched" => {
            let store = read_store_object(app);
            Some(Ok(store["steam"]["lastGameLaunched"].clone()))
        }
        "steam.launchSteamGame" => {
            let req = args.first().cloned().unwrap_or_else(|| json!({}));
            let name = req["name"].as_str().unwrap_or("");
            let should_agent = req["shouldLaunchAgent"].as_bool().unwrap_or(true);
            let res = launch_steam_game_by_name(app, name, should_agent).await;
            if res.is_ok() {
                let mut store = read_store_object(app);
                update_nested_section(&mut store, "steam", "lastGameLaunched", json!(name));
                let _ = write_store_object(app, &store);
            }
            Some(Ok(match res {
                Ok(()) => json!({ "status": "success", "message": "Game launched successfully" }),
                Err(e) => json!({ "status": "error", "message": e }),
            }))
        }
        "steam.setSteamPath" => {
            let picked = pick_file(json!([
                {"name": "Executables", "extensions": ["exe"]},
                {"name": "All Files", "extensions": ["*"]}
            ]))
            .await;
            if let Some(p) = picked {
                let mut store = read_store_object(app);
                update_nested_section(&mut store, "steam", "steamPath", json!(p.clone()));
                let _ = write_store_object(app, &store);
                return Some(Ok(json!({ "status": "success", "message": p })));
            }
            Some(Ok(json!({ "status": "canceled" })))
        }
        "steam.setAgentPath" | "yuzu.setAgentPath" => {
            let picked = pick_file(json!([
                {"name": "Executables", "extensions": ["exe"]},
                {"name": "All Files", "extensions": ["*"]}
            ]))
            .await;
            if let Some(p) = picked {
                let mut store = read_store_object(app);
                store.insert("agentPath".into(), json!(p.clone()));
                let _ = write_store_object(app, &store);
                return Some(Ok(json!({ "status": "success", "message": p })));
            }
            Some(Ok(json!({ "status": "canceled" })))
        }
        "steam.getExecutablePath" => {
            let picked = pick_file(json!([
                {"name": "Executables", "extensions": ["exe"]},
                {"name": "All Files", "extensions": ["*"]}
            ]))
            .await;
            Some(Ok(match picked {
                Some(p) => json!({ "status": "success", "path": p }),
                None => json!({ "status": "canceled" }),
            }))
        }
        "steam.removeSteamGame" => {
            let name = args.first().and_then(Value::as_str).unwrap_or("");
            let mut store = read_store_object(app);
            let games: Vec<Value> = store["steam"]["steamGames"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|g| g["name"].as_str() != Some(name))
                .collect();
            update_nested_section(&mut store, "steam", "steamGames", Value::Array(games));
            Some(Ok(match write_store_object(app, &store) {
                Ok(()) => json!({ "status": "success", "message": "Game removed successfully" }),
                Err(_) => json!({ "status": "error", "message": "Failed to remove game" }),
            }))
        }
        "steam.showGameConfigDialog" => {
            Some(Ok(match open_game_config_window(app) {
                Ok(()) => json!({ "status": "success" }),
                Err(e) => json!({ "status": "error", "message": e }),
            }))
        }
        "steam.saveSteamGame" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let mut store = read_store_object(app);
            let mut games = store["steam"]["steamGames"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            games.push(json!({
                "id": config["steamId"],
                "name": config["gameName"],
                "processName": config["executableName"],
                "script": config["scriptPath"],
                "scene": config["scene"],
                "executablePath": config["executablePath"],
                "runAgent": config["runAgent"],
                "runTextractor": config["runTextractor"],
                "agentDelay": config["agentDelay"],
            }));
            update_nested_section(&mut store, "steam", "steamGames", Value::Array(games));
            let res = match write_store_object(app, &store) {
                Ok(()) => {
                    emit_to_desktop_windows(app, "steamGamesUpdated", &[]);
                    if let Some(w) = app.get_webview_window("game-config") {
                        let _ = w.hide();
                    }
                    json!({ "status": "success", "message": "Configuration saved successfully!" })
                }
                Err(_) => json!({ "status": "error", "message": "Failed to save configuration" }),
            };
            Some(Ok(res))
        }
        "steam.getAgentScriptPath" => {
            let game_name = args.first().and_then(Value::as_str).unwrap_or("").to_owned();
            let paths = paths_for(app);
            let active_dir = paths.active.clone();
            let (scripts_dir, files) = tauri::async_runtime::spawn_blocking(move || {
                let prefs = Preferences::new(&active_dir);
                let scripts_dir = prepare_agent_scripts_dir(&prefs, &active_dir, None).dir;
                let files = list_agent_script_files(&scripts_dir);
                (scripts_dir, files)
            })
            .await
            .unwrap_or_default();
            let mut best_path: Option<String> = None;
            let mut best_score = 1.0_f64;
            for f in files {
                let s = score_script_for_query(&game_name, &f);
                if s < best_score
                    || (s == best_score && best_path.as_deref().is_some_and(|p| f.as_str() < p))
                {
                    best_score = s;
                    best_path = Some(f);
                }
            }
            let picked = dialog_open(&json!({
                "properties": ["openFile"],
                "defaultPath": best_path.unwrap_or_else(|| scripts_dir.to_string_lossy().into_owned()),
                "filters": [
                    {"name": "Executables", "extensions": ["js"]},
                    {"name": "All Files", "extensions": ["*"]}
                ],
            }))
            .await
            .ok();
            let selected = picked
                .filter(|v| v["canceled"] != true)
                .and_then(|v| v["filePaths"].as_array().and_then(|a| a.first()).and_then(Value::as_str).map(str::to_owned));
            Some(Ok(selected.map(Value::String).unwrap_or(Value::Null)))
        }

        // --- VN ---
        "vn.getVNs" => {
            let store = read_store_object(app);
            Some(Ok(store["VN"]["vns"]
                .as_array()
                .map(|a| Value::Array(a.clone()))
                .unwrap_or_else(|| json!([]))))
        }
        "vn.launchVN" => {
            let req = args.first().cloned().unwrap_or_else(|| json!({}));
            let vn_path = req["path"].as_str().unwrap_or("");
            let should_textractor = req["shouldLaunchTextractor"].as_bool().unwrap_or(false);
            let res = launch_vn_by_path(app, vn_path, should_textractor).await;
            if res.is_ok() {
                let mut store = read_store_object(app);
                update_nested_section(&mut store, "VN", "lastVNLaunched", json!(vn_path));
                let _ = write_store_object(app, &store);
            }
            Some(Ok(match res {
                Ok(()) => json!({ "status": "success", "message": "VN launched successfully" }),
                Err(e) => json!({ "status": "error", "message": e }),
            }))
        }
        "vn.addVN" => {
            let scene = args.first().cloned().unwrap_or(Value::Null);
            let picked = pick_file(json!([
                {"name": "Executables", "extensions": ["exe"]},
                {"name": "All Files", "extensions": ["*"]}
            ]))
            .await;
            if let Some(p) = picked {
                let mut store = read_store_object(app);
                let mut vns = store["VN"]["vns"].as_array().cloned().unwrap_or_default();
                vns.push(json!({ "path": p, "scene": scene }));
                update_nested_section(&mut store, "VN", "vns", Value::Array(vns));
                let _ = write_store_object(app, &store);
                return Some(Ok(json!({ "status": "success", "path": p })));
            }
            Some(Ok(json!({ "status": "canceled" })))
        }
        "vn.removeVN" => {
            let vn_path = args.first().and_then(Value::as_str).unwrap_or("");
            let mut store = read_store_object(app);
            let vns: Vec<Value> = store["VN"]["vns"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|v| v["path"].as_str() != Some(vn_path))
                .collect();
            update_nested_section(&mut store, "VN", "vns", Value::Array(vns));
            let _ = write_store_object(app, &store);
            Some(Ok(json!({ "status": "success" })))
        }
        "vn.setTextractorPath" => {
            let picked = pick_file(json!([
                {"name": "Executables", "extensions": ["exe"]},
                {"name": "All Files", "extensions": ["*"]}
            ]))
            .await;
            if let Some(p) = picked {
                let mut store = read_store_object(app);
                update_nested_section(&mut store, "VN", "textractorPath", json!(p.clone()));
                store.insert("textractorPath64".into(), json!(p.clone()));
                store.insert("textractorPath".into(), json!(p.clone()));
                let _ = write_store_object(app, &store);
                return Some(Ok(json!({ "status": "success", "path": p })));
            }
            Some(Ok(json!({ "status": "canceled" })))
        }
        "vn.setVNLaunchOnStart" => {
            let val = args.first().and_then(Value::as_str).unwrap_or("");
            let mut store = read_store_object(app);
            update_nested_section(&mut store, "VN", "launchVNOnStart", json!(val));
            let _ = write_store_object(app, &store);
            Some(Ok(Value::Null))
        }
        "vn.getVNLaunchOnStart" => {
            let store = read_store_object(app);
            Some(Ok(store["VN"]["launchVNOnStart"]
                .as_str()
                .map(|s| json!(s))
                .unwrap_or_else(|| json!(""))))
        }
        "vn.getLastVNLaunched" => {
            let store = read_store_object(app);
            Some(Ok(store["VN"]["lastVNLaunched"]
                .as_str()
                .map(|s| json!(s))
                .unwrap_or_else(|| json!(""))))
        }

        // --- Yuzu ---
        "yuzu.getYuzuGames" => {
            let store = read_store_object(app);
            let dir = store["yuzu"]["romsPath"].as_str().unwrap_or("");
            Some(Ok(Value::Array(scan_yuzu_games_dir(Path::new(dir)))))
        }
        "yuzu.getConfiguredYuzuGames" => {
            let store = read_store_object(app);
            Some(Ok(store["yuzu"]["games"]
                .as_array()
                .map(|a| Value::Array(a.clone()))
                .unwrap_or_else(|| json!([]))))
        }
        "yuzu.addToHomeBtn" => {
            let req = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = req["id"].as_str().unwrap_or("").to_owned();
            let mut store = read_store_object(app);
            let mut games: Vec<Value> = store["yuzu"]["games"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|g| g["id"].as_str() != Some(id.as_str()))
                .collect();
            games.push(req);
            update_nested_section(&mut store, "yuzu", "games", Value::Array(games));
            let _ = write_store_object(app, &store);
            Some(Ok(Value::Null))
        }
        "yuzu.removeFromHomeBtn" => {
            let id = args.first().and_then(Value::as_str).unwrap_or("");
            let mut store = read_store_object(app);
            let games: Vec<Value> = store["yuzu"]["games"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|g| g["id"].as_str() != Some(id))
                .collect();
            update_nested_section(&mut store, "yuzu", "games", Value::Array(games));
            let _ = write_store_object(app, &store);
            Some(Ok(Value::Null))
        }
        "yuzu.setAgentScriptsPath" => {
            if let Some(dir) = pick_directory().await {
                let mut store = read_store_object(app);
                store.insert("agentScriptsPath".into(), json!(dir.clone()));
                let _ = write_store_object(app, &store);
                return Some(Ok(json!({ "status": "success", "path": dir })));
            }
            Some(Ok(json!({ "status": "canceled" })))
        }
        "yuzu.setYuzuPath" => {
            if let Some(p) = pick_file(json!([
                {"name": "Executables", "extensions": ["exe"]},
                {"name": "All Files", "extensions": ["*"]}
            ]))
            .await
            {
                let mut store = read_store_object(app);
                update_nested_section(&mut store, "yuzu", "emuPath", json!(p.clone()));
                let _ = write_store_object(app, &store);
                return Some(Ok(json!({ "status": "success", "path": p })));
            }
            Some(Ok(json!({ "status": "canceled" })))
        }
        "yuzu.setRomsPath" => {
            if let Some(dir) = pick_directory().await {
                let mut store = read_store_object(app);
                update_nested_section(&mut store, "yuzu", "romsPath", json!(dir.clone()));
                let _ = write_store_object(app, &store);
                return Some(Ok(json!({ "status": "success", "path": dir })));
            }
            Some(Ok(json!({ "status": "canceled" })))
        }
        "yuzu.launchYuzuGame" => {
            let req = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = req["id"].as_str().unwrap_or("");
            let should_agent = req["shouldLaunchAgent"].as_bool().unwrap_or(true);
            let res = launch_yuzu_game_by_id(app, id, should_agent).await;
            if res.is_ok() {
                let mut store = read_store_object(app);
                update_nested_section(&mut store, "yuzu", "lastGameLaunched", json!(id));
                let _ = write_store_object(app, &store);
            }
            Some(Ok(match res {
                Ok(()) => json!({ "status": "success", "message": "Game launched successfully" }),
                Err(e) => json!({ "status": "error", "message": e }),
            }))
        }
        "yuzu.setYuzuLaunchOnStart" => {
            let val = args.first().and_then(Value::as_str).unwrap_or("");
            let mut store = read_store_object(app);
            update_nested_section(&mut store, "yuzu", "launchGameOnStart", json!(val));
            let _ = write_store_object(app, &store);
            Some(Ok(Value::Null))
        }
        "yuzu.getYuzuLaunchOnStart" => {
            let store = read_store_object(app);
            Some(Ok(store["yuzu"]["launchGameOnStart"]
                .as_str()
                .map(|s| json!(s))
                .unwrap_or_else(|| json!(""))))
        }
        "yuzu.getLastYuzuGameLaunched" => {
            let store = read_store_object(app);
            Some(Ok(store["yuzu"]["lastGameLaunched"]
                .as_str()
                .map(|s| json!(s))
                .unwrap_or_else(|| json!(""))))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn parses_switch_rom_filenames() {
        assert_eq!(
            parse_rom_name_and_id("Steins Gate Elite [0100ABC000123000].nsp"),
            Some(("Steins Gate Elite".into(), "0100ABC000123000".into()))
        );
        assert_eq!(
            parse_rom_name_and_id("Tsukihime (0100999888777000).xci"),
            Some(("Tsukihime".into(), "0100999888777000".into()))
        );
        assert_eq!(parse_rom_name_and_id("readme.txt"), None);
    }

    #[test]
    fn benchmark_yuzu_rom_dir_scan() {
        let dir = std::env::temp_dir().join(format!("gsm-yuzu-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..200 {
            let path = dir.join(format!("Game Title {i} [0100{:012X}].nsp", i + 1));
            fs::write(path, b"").unwrap();
        }
        let t0 = Instant::now();
        let scanned = scan_yuzu_games_dir(&dir);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(scanned.len(), 200);
        println!("[bench] launchers_ui yuzu_scan_200_roms ms={ms:.3}");
        let _ = fs::remove_dir_all(&dir);
    }
}
