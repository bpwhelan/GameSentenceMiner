//! Native Game Automation settings, Agent script resolution, GSM profile mapping,
//! tool pickers, and GitHub release installer (`Agent` + `Textractor` + `textractor_websocket`).
//!
//! Replaces `electron-src/main/ui/settings.ts` game/scene/tool handlers in Rust with
//! safe temporary-staging extraction (`gsm_packages::extract`) and throttled progress events.

use gsm_packages::scripts::Scripts;
use gsm_settings::preferences::Preferences;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

pub const TOOL_DOWNLOAD_PROGRESS_CHANNEL: &str = "settings-tool-download-progress";
const SAVED_EXTENSIONS_PIPELINE_X64: &str =
    "Remove Repeated Characters>Regex Filter>Copy to Clipboard>Extra Newlines>textractor_websocket_x64>";
const SAVED_EXTENSIONS_PIPELINE_X86: &str =
    "Remove Repeated Characters>Regex Filter>Copy to Clipboard>Extra Newlines>textractor_websocket_x86>";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneLaunchProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    pub scene_name: String,
    pub text_hook_mode: String,
    pub ocr_mode: String,
    pub launch_overlay: bool,
    pub agent_script_path: String,
    pub launch_delay_seconds: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_executable_path: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSettingsSnapshot {
    pub agent_path: String,
    pub agent_scripts_path: String,
    pub textractor_path64: String,
    pub textractor_path32: String,
    pub luna_translator_path: String,
    pub launch_agent_minimized: bool,
    pub launch_textractor_minimized: bool,
    pub launch_luna_translator_minimized: bool,
    pub force_manual_ocr_all_profiles: bool,
    pub ignore_active_scene_for_ocr: bool,
    pub scene_profiles: Vec<SceneLaunchProfile>,
}

fn normalize_text_hook_mode(raw: Option<&str>) -> String {
    match raw.map(str::trim).unwrap_or("none") {
        "agent" => "agent".into(),
        "textractor" => "textractor".into(),
        "luna" => "luna".into(),
        _ => "none".into(),
    }
}

fn normalize_ocr_mode(raw: Option<&str>) -> String {
    match raw.map(str::trim).unwrap_or("none") {
        "auto" => "auto".into(),
        "manual" => "manual".into(),
        _ => "none".into(),
    }
}

fn normalize_launch_delay(raw: Option<&Value>) -> f64 {
    let val = raw.and_then(Value::as_f64).unwrap_or(0.0);
    if !val.is_finite() || val < 0.0 {
        0.0
    } else if val > 60.0 {
        60.0
    } else {
        (val * 10.0).round() / 10.0
    }
}

pub fn normalize_scene_profile(raw: &Value) -> Option<SceneLaunchProfile> {
    let obj = raw.as_object()?;
    let scene_obj = obj.get("scene").and_then(Value::as_object);
    let scene_id = obj
        .get("sceneId")
        .or_else(|| obj.get("id"))
        .or_else(|| scene_obj.and_then(|s| s.get("id")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let scene_name = obj
        .get("sceneName")
        .or_else(|| obj.get("name"))
        .or_else(|| scene_obj.and_then(|s| s.get("name")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_owned();
    if scene_id.is_none() && scene_name.is_empty() {
        return None;
    }
    Some(SceneLaunchProfile {
        scene_id,
        scene_name,
        text_hook_mode: normalize_text_hook_mode(
            obj.get("textHookMode").and_then(Value::as_str),
        ),
        ocr_mode: normalize_ocr_mode(obj.get("ocrMode").and_then(Value::as_str)),
        launch_overlay: obj
            .get("launchOverlay")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        agent_script_path: obj
            .get("agentScriptPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned(),
        launch_delay_seconds: normalize_launch_delay(obj.get("launchDelaySeconds")),
        game_executable_path: obj
            .get("gameExecutablePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    })
}

pub fn read_scene_profiles(prefs: &Preferences) -> Vec<SceneLaunchProfile> {
    let raw = prefs
        .get("sceneLaunchProfiles")
        .ok()
        .flatten()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    raw.iter().filter_map(normalize_scene_profile).collect()
}

pub fn write_scene_profiles(
    prefs: &Preferences,
    profiles: &[SceneLaunchProfile],
) -> Result<(), String> {
    prefs
        .patch(&json!({ "sceneLaunchProfiles": profiles }))
        .map(|_| ())
}

pub fn read_game_settings(prefs: &Preferences) -> GameSettingsSnapshot {
    let snap = prefs.snapshot().unwrap_or_else(|_| json!({}));
    let str_key = |k: &str| {
        snap.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned()
    };
    let bool_key = |k: &str| snap.get(k).and_then(Value::as_bool).unwrap_or(false);
    GameSettingsSnapshot {
        agent_path: str_key("agentPath"),
        agent_scripts_path: str_key("agentScriptsPath"),
        textractor_path64: str_key("textractorPath64"),
        textractor_path32: str_key("textractorPath32"),
        luna_translator_path: str_key("lunaTranslatorPath"),
        launch_agent_minimized: bool_key("launchAgentMinimized"),
        launch_textractor_minimized: bool_key("launchTextractorMinimized"),
        launch_luna_translator_minimized: bool_key("launchLunaTranslatorMinimized"),
        force_manual_ocr_all_profiles: bool_key("forceManualOcrAllProfiles"),
        ignore_active_scene_for_ocr: bool_key("ignoreActiveSceneForOcr"),
        scene_profiles: read_scene_profiles(prefs),
    }
}

fn save_game_settings(prefs: &Preferences, input: &Value) -> Result<Value, String> {
    let Some(obj) = input.as_object() else {
        return Err("Invalid game settings payload.".into());
    };
    let mut patch = serde_json::Map::new();
    for str_key in [
        "agentPath",
        "agentScriptsPath",
        "textractorPath64",
        "textractorPath32",
        "lunaTranslatorPath",
    ] {
        if let Some(val) = obj.get(str_key).and_then(Value::as_str) {
            patch.insert(str_key.into(), Value::String(val.trim().to_owned()));
        }
    }
    for bool_key in [
        "launchAgentMinimized",
        "launchTextractorMinimized",
        "launchLunaTranslatorMinimized",
        "forceManualOcrAllProfiles",
        "ignoreActiveSceneForOcr",
    ] {
        if let Some(val) = obj.get(bool_key).and_then(Value::as_bool) {
            patch.insert(bool_key.into(), Value::Bool(val));
        }
    }
    if let Some(arr) = obj.get("sceneProfiles").and_then(Value::as_array) {
        let normalized: Vec<SceneLaunchProfile> =
            arr.iter().filter_map(normalize_scene_profile).collect();
        patch.insert(
            "sceneLaunchProfiles".into(),
            serde_json::to_value(normalized).map_err(|e| e.to_string())?,
        );
    }
    if !patch.is_empty() {
        prefs.patch(&Value::Object(patch))?;
    }
    let updated = read_game_settings(prefs);
    let mut out = serde_json::to_value(updated).map_err(|e| e.to_string())?;
    if let Some(map) = out.as_object_mut() {
        map.insert("success".into(), Value::Bool(true));
    }
    Ok(out)
}

fn extract_scene_query(arg: Option<&Value>) -> (Option<String>, Option<String>) {
    let Some(val) = arg else {
        return (None, None);
    };
    if let Some(s) = val.as_str() {
        let trimmed = s.trim();
        return (
            (!trimmed.is_empty()).then(|| trimmed.to_owned()),
            None,
        );
    }
    let scene_obj = val.get("scene").unwrap_or(val);
    let id = scene_obj
        .get("id")
        .or_else(|| val.get("sceneId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let name = scene_obj
        .get("name")
        .or_else(|| val.get("sceneName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    (id, name)
}

pub fn find_scene_launch_profile(
    profiles: &[SceneLaunchProfile],
    scene_id: Option<&str>,
    scene_name: Option<&str>,
) -> Option<SceneLaunchProfile> {
    if let Some(id) = scene_id.filter(|s| !s.is_empty()) {
        if let Some(found) = profiles
            .iter()
            .find(|p| p.scene_id.as_deref() == Some(id))
        {
            return Some(found.clone());
        }
    }
    if let Some(name) = scene_name.filter(|s| !s.is_empty()) {
        if let Some(found) = profiles.iter().find(|p| p.scene_name == name) {
            return Some(found.clone());
        }
        let lower = name.to_lowercase();
        if let Some(found) = profiles
            .iter()
            .find(|p| p.scene_name.to_lowercase() == lower)
        {
            return Some(found.clone());
        }
    }
    None
}

pub fn upsert_scene_launch_profile(
    profiles: &mut Vec<SceneLaunchProfile>,
    mut next: SceneLaunchProfile,
) {
    let existing_idx = profiles.iter().position(|p| {
        if let (Some(a), Some(b)) = (&next.scene_id, &p.scene_id) {
            return a == b;
        }
        !next.scene_name.is_empty() && p.scene_name == next.scene_name
    });
    if let Some(idx) = existing_idx {
        if next.game_executable_path.is_none() {
            next.game_executable_path = profiles[idx].game_executable_path.clone();
        }
        profiles[idx] = next;
    } else {
        profiles.push(next);
    }
}

pub fn get_game_exe_path_for_scene(prefs: &Preferences, scene_name: &str) -> String {
    let trimmed = scene_name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let profiles = read_scene_profiles(prefs);
    find_scene_launch_profile(&profiles, None, Some(trimmed))
        .and_then(|p| p.game_executable_path)
        .unwrap_or_default()
}

pub fn set_game_exe_path_for_scene(
    prefs: &Preferences,
    scene_name: &str,
    exe_path: &str,
) -> Result<(), String> {
    let trimmed = scene_name.trim();
    if trimmed.is_empty() {
        return Err("sceneName is required".into());
    }
    let mut profiles = read_scene_profiles(prefs);
    let normalized_path = exe_path.trim().to_owned();
    if let Some(existing) = profiles.iter_mut().find(|p| p.scene_name == trimmed) {
        existing.game_executable_path = if normalized_path.is_empty() {
            None
        } else {
            Some(normalized_path)
        };
    } else {
        profiles.push(SceneLaunchProfile {
            scene_id: None,
            scene_name: trimmed.to_owned(),
            text_hook_mode: "none".into(),
            ocr_mode: "none".into(),
            launch_overlay: false,
            agent_script_path: String::new(),
            launch_delay_seconds: 0.0,
            game_executable_path: if normalized_path.is_empty() {
                None
            } else {
                Some(normalized_path)
            },
        });
    }
    write_scene_profiles(prefs, &profiles)
}

pub fn resolve_agent_scripts_dir(
    prefs: &Preferences,
    active_dir: &Path,
    override_hint: Option<&str>,
) -> PathBuf {
    let try_path = |raw: &str| -> Option<PathBuf> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let p = PathBuf::from(trimmed);
        if p.is_file() {
            return p.parent().map(Path::to_path_buf);
        }
        if p.is_dir() {
            return Some(p);
        }
        None
    };

    if let Some(hint) = override_hint {
        if let Some(found) = try_path(hint) {
            return found;
        }
    }
    let snap = read_game_settings(prefs);
    if let Some(found) = try_path(&snap.agent_scripts_path) {
        return found;
    }
    if !snap.agent_path.is_empty() {
        if let Some(agent_dir) = Path::new(&snap.agent_path).parent() {
            for candidate in [agent_dir.join("data").join("scripts"), agent_dir.join("scripts")] {
                if candidate.is_dir() {
                    return candidate;
                }
            }
        }
    }
    Scripts::new(active_dir).directory()
}

fn default_browse_directory(existing: &str, prefer_dir: bool) -> Option<String> {
    let trimmed = existing.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if prefer_dir && path.is_dir() {
        return Some(trimmed.to_owned());
    }
    if path.is_file() || !prefer_dir {
        if let Some(parent) = path.parent() {
            if parent.exists() {
                return Some(parent.to_string_lossy().into_owned());
            }
        }
    }
    path.exists().then(|| trimmed.to_owned())
}

async fn pick_and_optionally_save_path(
    app: &tauri::AppHandle,
    pref_key: Option<&'static str>,
    title: &str,
    directory: bool,
    filters: Vec<Value>,
    override_initial: Option<&str>,
) -> Result<Value, String> {
    let paths = crate::desktop_services::paths_for(app);
    let current = if let Some(over) = override_initial.filter(|s| !s.trim().is_empty()) {
        over.trim().to_owned()
    } else if let Some(key) = pref_key {
        let p = paths.clone();
        tokio::task::spawn_blocking(move || {
            Preferences::new(&p.active)
                .get(key)
                .ok()
                .flatten()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        })
        .await
        .map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    let mut properties = vec![if directory {
        "openDirectory"
    } else {
        "openFile"
    }];
    if directory {
        properties.push("createDirectory");
    }

    let mut opts = serde_json::Map::new();
    opts.insert("title".into(), json!(title));
    opts.insert("properties".into(), json!(properties));
    if !filters.is_empty() {
        opts.insert("filters".into(), Value::Array(filters));
    }
    if let Some(default_path) = default_browse_directory(&current, directory) {
        opts.insert("defaultPath".into(), json!(default_path));
    }

    let result = crate::native::dialog_open(&Value::Object(opts)).await?;
    let canceled = result
        .get("canceled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let selected = result
        .get("filePaths")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    if canceled || selected.is_none() {
        return Ok(json!({ "status": "canceled" }));
    }
    let chosen = selected.unwrap();

    if let Some(key) = pref_key {
        let p = paths;
        let val = chosen.clone();
        tokio::task::spawn_blocking(move || {
            Preferences::new(&p.active)
                .patch(&json!({ key: val }))
                .map(|_| ())
        })
        .await
        .map_err(|e| e.to_string())??;
    }

    Ok(json!({ "status": "success", "path": chosen }))
}

fn releases_url_for_tool(tool: &str) -> Result<&'static str, String> {
    match tool.trim() {
        "agent" => Ok("https://github.com/0xDC00/agent/releases"),
        "textractor" => Ok("https://github.com/Chenx221/Textractor/releases"),
        "luna" => Ok("https://github.com/HIllya51/LunaTranslator/releases"),
        other => Err(format!("Unknown tool: {other}")),
    }
}

fn match_agent_asset_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(mid) = lower
        .strip_prefix("agent-v")
        .and_then(|s| s.strip_suffix("-win32-x64.zip"))
    else {
        return false;
    };
    !mid.is_empty() && mid.bytes().all(|b| b.is_ascii_digit() || b == b'.')
}

fn match_textractor_asset_name(name: &str) -> bool {
    let Some(mid) = name
        .strip_prefix("Textractor_")
        .and_then(|s| s.strip_suffix(".zip"))
    else {
        return false;
    };
    !mid.is_empty() && mid.bytes().all(|b| b.is_ascii_digit())
}

fn emit_download_progress(
    app: &tauri::AppHandle,
    label: &str,
    tool: &str,
    stage: &str,
    message: &str,
    progress: Option<f64>,
) {
    crate::desktop_state::emit_to_window(
        app,
        label,
        TOOL_DOWNLOAD_PROGRESS_CHANNEL,
        &[json!({
            "tool": tool,
            "stage": stage,
            "message": message,
            "progress": progress,
        })],
    );
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((from_dir, to_dir)) = stack.pop() {
        std::fs::create_dir_all(&to_dir).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(&from_dir).map_err(|e| e.to_string())?.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            let src_path = entry.path();
            let dst_path = to_dir.join(entry.file_name());
            if ft.is_dir() {
                stack.push((src_path, dst_path));
            } else if ft.is_file() {
                std::fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn unwrap_single_root(dir: &Path) -> PathBuf {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return dir.to_path_buf();
    };
    let items: Vec<_> = entries.flatten().collect();
    if items.len() == 1 && items[0].path().is_dir() {
        items[0].path()
    } else {
        dir.to_path_buf()
    }
}

fn find_file_case_insensitive(root: &Path, filename: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file()
                && path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case(filename))
            {
                return Some(path);
            }
        }
    }
    None
}

fn find_arch_exe(root: &Path, arch: &str, filename: &str) -> Option<PathBuf> {
    let direct = root.join(arch).join(filename);
    if direct.is_file() {
        return Some(direct);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file()
                && path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case(filename))
                && path
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .is_some_and(|p| p.eq_ignore_ascii_case(arch))
            {
                return Some(path);
            }
        }
    }
    None
}

pub fn update_saved_extensions_content(existing: Option<&str>, plugin_name: &str) -> String {
    let mut base = existing.unwrap_or("").trim().to_owned();
    let canonical = if plugin_name.ends_with("x86") {
        SAVED_EXTENSIONS_PIPELINE_X86
    } else {
        SAVED_EXTENSIONS_PIPELINE_X64
    };
    if base.is_empty() {
        return canonical.to_owned();
    }
    if base.contains(plugin_name) {
        return base;
    }
    if !base.ends_with('>') {
        base.push('>');
    }
    format!("{base}{plugin_name}>")
}

struct StagingCleanup(PathBuf);
impl Drop for StagingCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn handle_download_and_install_tool(
    app: &tauri::AppHandle,
    label: &str,
    tool: &str,
) -> Result<Value, String> {
    if tool != "agent" && tool != "textractor" {
        return Err(format!("Download not supported for tool: {tool}"));
    }
    let tool_label = if tool == "agent" { "Agent" } else { "Textractor" };
    emit_download_progress(
        app,
        label,
        tool,
        "preparing",
        &format!("Select installation folder for {tool_label}..."),
        None,
    );

    let paths = crate::desktop_services::paths_for(app);
    let default_root = paths.active.clone();
    let folder_res = crate::native::dialog_open(&json!({
        "title": format!("Select Install Folder for {tool_label}"),
        "defaultPath": default_root,
        "properties": ["openDirectory", "createDirectory"],
    }))
    .await?;

    let canceled = folder_res
        .get("canceled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let selected_dir = folder_res
        .get("filePaths")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    if canceled || selected_dir.is_none() {
        return Ok(json!({ "status": "canceled", "tool": tool }));
    }
    let selected_dir = selected_dir.unwrap();
    let destination_dir = if selected_dir
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(tool_label))
    {
        selected_dir
    } else {
        selected_dir.join(tool_label)
    };

    let app_handle = app.clone();
    let label_owned = label.to_owned();
    let tool_owned = tool.to_owned();

    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let staging = paths
            .active
            .join("temp")
            .join(format!("tool-install-{tool_owned}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let _cleanup = StagingCleanup(staging.clone());

        emit_download_progress(
            &app_handle,
            &label_owned,
            &tool_owned,
            "fetch_release",
            &format!("Checking latest {tool_label} release on GitHub..."),
            None,
        );

        let api_url = if tool_owned == "agent" {
            "https://api.github.com/repos/0xDC00/agent/releases/latest"
        } else {
            "https://api.github.com/repos/Chenx221/Textractor/releases/latest"
        };
        let releases_url = releases_url_for_tool(&tool_owned)?;
        let release = gsm_packages::fetch_json(api_url)?;
        let release_tag = release
            .get("tag_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();

        let matched_asset = release
            .get("assets")
            .and_then(Value::as_array)
            .and_then(|assets| {
                assets.iter().find(|asset| {
                    let Some(name) = asset.get("name").and_then(Value::as_str) else {
                        return false;
                    };
                    if tool_owned == "agent" {
                        match_agent_asset_name(name)
                    } else {
                        match_textractor_asset_name(name)
                    }
                })
            })
            .cloned();

        let Some(asset) = matched_asset else {
            let _ = crate::native::shell_open_external(releases_url);
            return Ok(json!({
                "status": "asset_not_found",
                "tool": tool_owned,
                "releaseTag": release_tag,
                "releasePageUrl": releases_url,
                "message": format!("No matching {tool_label} archive found in release {release_tag}. Opened releases page."),
            }));
        };

        let asset_name = asset
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let download_url = asset
            .get("browser_download_url")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Missing download URL for {asset_name}"))?;

        let archive_path = staging.join("archive.zip");
        let last_emit = AtomicU64::new(0);
        emit_download_progress(
            &app_handle,
            &label_owned,
            &tool_owned,
            "download_archive",
            &format!("Downloading {asset_name}..."),
            Some(0.0),
        );
        gsm_packages::download(download_url, &archive_path, None, &|done, total| {
            let now = now_millis();
            let prev = last_emit.load(Ordering::Relaxed);
            if now.saturating_sub(prev) >= 120 {
                last_emit.store(now, Ordering::Relaxed);
                let frac = total
                    .filter(|t| *t > 0)
                    .map(|t| (done as f64 / t as f64).clamp(0.0, 1.0));
                emit_download_progress(
                    &app_handle,
                    &label_owned,
                    &tool_owned,
                    "download_archive",
                    &format!("Downloading {asset_name}..."),
                    frac,
                );
            }
        })?;

        emit_download_progress(
            &app_handle,
            &label_owned,
            &tool_owned,
            "extract_archive",
            &format!("Extracting {asset_name}..."),
            None,
        );
        let extract_dir = staging.join("extracted");
        std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
        gsm_packages::extract(&archive_path, &extract_dir, None)?;
        let content_root = unwrap_single_root(&extract_dir);
        copy_dir_recursive(&content_root, &destination_dir)?;

        let prefs = Preferences::new(&paths.active);
        if tool_owned == "agent" {
            let exe = find_file_case_insensitive(&destination_dir, "Agent.exe")
                .ok_or_else(|| format!("Agent.exe not found inside {}", destination_dir.display()))?;
            emit_download_progress(
                &app_handle,
                &label_owned,
                &tool_owned,
                "download_data",
                "Syncing managed Agent scripts...",
                None,
            );
            let scripts_mgr = Scripts::new(&paths.active);
            if let Err(err) = scripts_mgr.ensure(false) {
                crate::desktop_log::warn(
                    &app_handle,
                    "settings",
                    format!("Agent script library sync warning: {err}"),
                );
            }
            let default_scripts_dir = scripts_mgr.directory();
            let exe_str = exe.to_string_lossy().into_owned();
            let current_scripts = prefs
                .get("agentScriptsPath")
                .ok()
                .flatten()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let resolved_scripts_str = if current_scripts.trim().is_empty() {
                default_scripts_dir.to_string_lossy().into_owned()
            } else {
                current_scripts
            };
            prefs.patch(&json!({
                "agentPath": exe_str,
                "agentScriptsPath": resolved_scripts_str,
            }))?;

            emit_download_progress(
                &app_handle,
                &label_owned,
                &tool_owned,
                "finalize",
                "Agent installation complete.",
                Some(1.0),
            );
            return Ok(json!({
                "status": "success",
                "tool": tool_owned,
                "destinationPath": destination_dir,
                "releaseTag": release_tag,
                "assetName": asset_name,
                "paths": {
                    "agentPath": exe_str,
                    "agentScriptsPath": resolved_scripts_str,
                }
            }));
        }

        // Textractor: locate x64/x86 executables and install textractor_websocket plugins.
        let exe64 = find_arch_exe(&destination_dir, "x64", "Textractor.exe");
        let exe32 = find_arch_exe(&destination_dir, "x86", "Textractor.exe");

        emit_download_progress(
            &app_handle,
            &label_owned,
            &tool_owned,
            "install_plugins",
            "Installing textractor_websocket extensions...",
            None,
        );
        if let Ok(ws_release) =
            gsm_packages::fetch_json("https://api.github.com/repos/kuroahna/textractor_websocket/releases/latest")
        {
            if let Some(assets) = ws_release.get("assets").and_then(Value::as_array) {
                for (arch, exe_opt, plugin_name) in [
                    ("x64", &exe64, "textractor_websocket_x64"),
                    ("x86", &exe32, "textractor_websocket_x86"),
                ] {
                    let Some(arch_exe) = exe_opt else {
                        continue;
                    };
                    let arch_dir = arch_exe.parent().unwrap();
                    let expected_zip = format!("{plugin_name}.zip");
                    let Some(ws_url) = assets
                        .iter()
                        .find(|a| {
                            a.get("name")
                                .and_then(Value::as_str)
                                .is_some_and(|n| n.eq_ignore_ascii_case(&expected_zip))
                        })
                        .and_then(|a| a.get("browser_download_url").and_then(Value::as_str))
                    else {
                        continue;
                    };
                    let ws_zip = staging.join(format!("ws_{arch}.zip"));
                    let ws_dir = staging.join(format!("ws_{arch}"));
                    std::fs::create_dir_all(&ws_dir).map_err(|e| e.to_string())?;
                    if gsm_packages::download(ws_url, &ws_zip, None, &|_, _| {}).is_ok()
                        && gsm_packages::extract(&ws_zip, &ws_dir, None).is_ok()
                    {
                        for entry in std::fs::read_dir(&ws_dir).into_iter().flatten().flatten() {
                            let src = entry.path();
                            if src.is_file()
                                && src
                                    .extension()
                                    .and_then(|e| e.to_str())
                                    .is_some_and(|e| e.eq_ignore_ascii_case("dll"))
                            {
                                let _ = std::fs::copy(&src, arch_dir.join(entry.file_name()));
                            }
                        }
                        let saved_ext_path = arch_dir.join("SavedExtensions.txt");
                        let existing = std::fs::read_to_string(&saved_ext_path).ok();
                        let updated = update_saved_extensions_content(
                            existing.as_deref(),
                            plugin_name,
                        );
                        let _ = std::fs::write(&saved_ext_path, updated);
                    }
                }
            }
        }

        let mut patch = serde_json::Map::new();
        let mut resp_paths = serde_json::Map::new();
        if let Some(p64) = exe64 {
            let s = p64.to_string_lossy().into_owned();
            patch.insert("textractorPath64".into(), Value::String(s.clone()));
            resp_paths.insert("textractorPath64".into(), Value::String(s));
        }
        if let Some(p32) = exe32 {
            let s = p32.to_string_lossy().into_owned();
            patch.insert("textractorPath32".into(), Value::String(s.clone()));
            resp_paths.insert("textractorPath32".into(), Value::String(s));
        }
        if !patch.is_empty() {
            prefs.patch(&Value::Object(patch))?;
        }

        emit_download_progress(
            &app_handle,
            &label_owned,
            &tool_owned,
            "finalize",
            "Textractor installation complete.",
            Some(1.0),
        );
        Ok(json!({
            "status": "success",
            "tool": tool_owned,
            "destinationPath": destination_dir,
            "releaseTag": release_tag,
            "assetName": asset_name,
            "paths": resp_paths,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn handle_ipc(
    app: &tauri::AppHandle,
    label: &str,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    let paths = crate::desktop_services::paths_for(app);
    match channel {
        "settings.getGameSettings" => {
            tokio::task::spawn_blocking(move || {
                serde_json::to_value(read_game_settings(&Preferences::new(&paths.active)))
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.saveGameSettings" => {
            let input = args.first().cloned().unwrap_or(Value::Null);
            tokio::task::spawn_blocking(move || {
                save_game_settings(&Preferences::new(&paths.active), &input)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.getSceneLaunchProfile" => {
            let (scene_id, scene_name) = extract_scene_query(args.first());
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let profiles = read_scene_profiles(&Preferences::new(&paths.active));
                match find_scene_launch_profile(
                    &profiles,
                    scene_id.as_deref(),
                    scene_name.as_deref(),
                ) {
                    Some(found) => serde_json::to_value(found).map_err(|e| e.to_string()),
                    None => Ok(Value::Null),
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.saveSceneLaunchProfile" => {
            let payload = args.first().cloned().unwrap_or(Value::Null);
            let profile = normalize_scene_profile(&payload)
                .ok_or_else(|| "A valid OBS scene is required.".to_string())?;
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let prefs = Preferences::new(&paths.active);
                let mut profiles = read_scene_profiles(&prefs);
                upsert_scene_launch_profile(&mut profiles, profile.clone());
                write_scene_profiles(&prefs, &profiles)?;
                Ok(json!({ "success": true, "profile": profile }))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.listAgentScripts" => {
            let override_path = args
                .first()
                .and_then(|v| v.as_str().or_else(|| v.get("path").and_then(Value::as_str)))
                .map(str::to_owned);
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let prefs = Preferences::new(&paths.active);
                let dir = resolve_agent_scripts_dir(
                    &prefs,
                    &paths.active,
                    override_path.as_deref(),
                );
                let scripts = crate::agent_scripts::list_agent_script_files(&dir);
                Ok(json!({
                    "status": "success",
                    "path": dir.to_string_lossy(),
                    "scripts": scripts,
                }))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.resolveAgentScriptForScene" => {
            let payload = args.first().cloned().unwrap_or(Value::Null);
            let (scene_id, mut scene_name) = extract_scene_query(Some(&payload));
            let explicit_game_id = payload
                .get("explicitGameId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let scripts_override = payload
                .get("scriptsPath")
                .or_else(|| payload.get("path"))
                .and_then(Value::as_str)
                .map(str::to_owned);

            let (mut window_title, mut process_name) = (None::<String>, None::<String>);
            if let Some(obs) = app.try_state::<crate::obs::Obs>() {
                let obs = obs.inner().clone();
                if let Some((_sid, title, exe)) = obs
                    .capture_identity_for_scene(app, scene_id.as_deref())
                    .await
                {
                    if !title.trim().is_empty() {
                        window_title = Some(title);
                    }
                    if !exe.trim().is_empty() {
                        process_name = Some(exe);
                    }
                }
                if scene_name.is_none() {
                    if let Ok(cur) = obs.invoke(app, "obs.getCurrentScene", &[]).await {
                        scene_name = cur["name"].as_str().map(str::to_owned);
                    }
                }
            }

            let sid_for_profile = scene_id.clone();
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let prefs = Preferences::new(&paths.active);
                if process_name.is_none() {
                    if let Some(sid) = sid_for_profile.as_deref() {
                        if let Some(lp) = prefs
                            .get("gameLaunchProfiles")
                            .ok()
                            .flatten()
                            .and_then(|v| v.get(sid).cloned())
                        {
                            let exe_or_rom = lp
                                .get("romPath")
                                .and_then(Value::as_str)
                                .filter(|s| !s.trim().is_empty())
                                .or_else(|| lp.get("executablePath").and_then(Value::as_str));
                            if let Some(val) = exe_or_rom {
                                process_name = Some(val.to_owned());
                            }
                        }
                    }
                }
                let dir = resolve_agent_scripts_dir(
                    &prefs,
                    &paths.active,
                    scripts_override.as_deref(),
                );
                let result = crate::agent_scripts::resolve_agent_script(
                    &crate::agent_scripts::ResolveAgentScriptInput {
                        scripts_path: dir.to_string_lossy().into_owned(),
                        scene_name,
                        window_title,
                        process_name,
                        explicit_game_id,
                    },
                );
                serde_json::to_value(result).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.listGSMProfiles" => {
            let config_path = paths.active.join("config.json");
            tokio::task::spawn_blocking(move || gsm_settings::mining_scopes::base_profiles(&config_path))
                .await
                .map_err(|e| e.to_string())?
        }
        "settings.relateSceneToProfile" => {
            let payload = args.first().cloned().unwrap_or(Value::Null);
            let scene_name = payload
                .get("sceneName")
                .or_else(|| payload.get("scene"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Scene name is required.")?
                .to_owned();
            let profile_name = payload
                .get("profileName")
                .or_else(|| payload.get("profile_name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Profile name is required.")?
                .to_owned();
            let create_new = payload
                .get("createNew")
                .or_else(|| payload.get("create_new"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let path = paths.active.join("config.json");
            tokio::task::spawn_blocking(move || gsm_settings::mining_scopes::relate_scene(&path,&scene_name,&profile_name,create_new))
                .await.map_err(|e|e.to_string())??;
            crate::mining_settings::changed(app).await;
            Ok(json!({"success":true,"result":null}))
        }
        "settings.selectAgentPath" => {
            pick_and_optionally_save_path(
                app,
                Some("agentPath"),
                "Select Agent Executable",
                false,
                vec![json!({ "name": "Executables", "extensions": ["exe"] })],
                None,
            )
            .await
        }
        "settings.selectAgentScriptsPath" => {
            pick_and_optionally_save_path(
                app,
                Some("agentScriptsPath"),
                "Select Agent Scripts Folder",
                true,
                Vec::new(),
                None,
            )
            .await
        }
        "settings.selectAgentScriptPath" => {
            let hint = args
                .first()
                .and_then(|v| v.as_str().or_else(|| v.get("path").and_then(Value::as_str)))
                .map(str::to_owned);
            pick_and_optionally_save_path(
                app,
                None,
                "Select Agent Script",
                false,
                vec![json!({ "name": "Agent Scripts", "extensions": ["js", "mjs", "cjs"] })],
                hint.as_deref(),
            )
            .await
        }
        "settings.selectTextractorPath64" => {
            pick_and_optionally_save_path(
                app,
                Some("textractorPath64"),
                "Select Textractor x64 Executable",
                false,
                vec![json!({ "name": "Executables", "extensions": ["exe"] })],
                None,
            )
            .await
        }
        "settings.selectTextractorPath32" => {
            pick_and_optionally_save_path(
                app,
                Some("textractorPath32"),
                "Select Textractor x86 Executable",
                false,
                vec![json!({ "name": "Executables", "extensions": ["exe"] })],
                None,
            )
            .await
        }
        "settings.selectLunaTranslatorPath" => {
            pick_and_optionally_save_path(
                app,
                Some("lunaTranslatorPath"),
                "Select LunaTranslator Executable",
                false,
                vec![json!({ "name": "Executables", "extensions": ["exe"] })],
                None,
            )
            .await
        }
        "settings.openToolReleasesPage" => {
            let tool = args
                .first()
                .and_then(|v| v.as_str().or_else(|| v.get("tool").and_then(Value::as_str)))
                .unwrap_or("");
            let url = releases_url_for_tool(tool)?;
            crate::native::shell_open_external(url)?;
            Ok(json!({ "status": "success", "url": url }))
        }
        "settings.downloadAndInstallTool" => {
            let tool = args
                .first()
                .and_then(|v| v.as_str().or_else(|| v.get("tool").and_then(Value::as_str)))
                .unwrap_or("");
            handle_download_and_install_tool(app, label, tool).await
        }
        _ => Err(format!("Unsupported settings tool channel: {channel}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalizes_and_upserts_scene_launch_profiles() {
        let dir = tempdir().unwrap();
        let prefs = Preferences::new(dir.path());
        save_game_settings(
            &prefs,
            &json!({
                "agentPath": " C:\\Agent\\Agent.exe ",
                "launchAgentMinimized": true,
            }),
        )
        .unwrap();
        let snap = read_game_settings(&prefs);
        assert_eq!(snap.agent_path, "C:\\Agent\\Agent.exe");
        assert!(snap.launch_agent_minimized);

        let first = normalize_scene_profile(&json!({
            "scene": { "id": "s1", "name": "Game One" },
            "textHookMode": "agent",
            "ocrMode": "auto",
            "launchOverlay": true,
            "agentScriptPath": " C:\\scripts\\a.js ",
            "launchDelaySeconds": 120
        }))
        .unwrap();
        assert_eq!(first.launch_delay_seconds, 60.0);

        let mut list = vec![];
        upsert_scene_launch_profile(&mut list, first);
        assert_eq!(list.len(), 1);
        assert!(find_scene_launch_profile(&list, Some("s1"), None).is_some());
        assert!(find_scene_launch_profile(&list, None, Some("game one")).is_some());

        let updated = normalize_scene_profile(&json!({
            "scene": { "id": "s1", "name": "Game One" },
            "textHookMode": "textractor",
            "ocrMode": "manual",
            "launchOverlay": false,
            "agentScriptPath": "",
            "launchDelaySeconds": -5
        }))
        .unwrap();
        upsert_scene_launch_profile(&mut list, updated);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].text_hook_mode, "textractor");
        assert_eq!(list[0].launch_delay_seconds, 0.0);
    }

    #[test]
    fn validates_github_tool_assets_and_saved_extensions() {
        assert!(match_agent_asset_name("agent-v0.1.7-win32-x64.zip"));
        assert!(!match_agent_asset_name("agent-v0.1.7-linux-x64.zip"));
        assert!(match_textractor_asset_name("Textractor_12345.zip"));
        assert!(!match_textractor_asset_name("Textractor_src.zip"));

        assert_eq!(
            update_saved_extensions_content(None, "textractor_websocket_x64"),
            SAVED_EXTENSIONS_PIPELINE_X64
        );
        assert_eq!(
            update_saved_extensions_content(Some("Copy to Clipboard"), "textractor_websocket_x86"),
            "Copy to Clipboard>textractor_websocket_x86>"
        );
        assert_eq!(
            update_saved_extensions_content(Some(SAVED_EXTENSIONS_PIPELINE_X64), "textractor_websocket_x64"),
            SAVED_EXTENSIONS_PIPELINE_X64
        );
    }
}
