//! Desktop commands for text processing and Windows Speech.

use gsm_settings::workspace::{normalize_scene, speech_settings, Workspace};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub struct MiningWorkspace {
    latest: Mutex<Value>,
    previews: Arc<tokio::sync::Semaphore>,
}
impl Default for MiningWorkspace {
    fn default() -> Self {
        Self {
            latest: Mutex::new(Value::Null),
            previews: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
}
fn emit(app: &tauri::AppHandle, channel: &str, payload: Value) {
    let encoded = json!({"channel":channel,"payload":payload}).to_string();
    for label in crate::desktop_state::desktop_window_labels(app) {
        let _ = app.emit_to(&label, "mining-workspace", encoded.clone());
    }
}
pub fn observe(app: &tauri::AppHandle, event: &str, message: &Value) {
    if event != "bus.message"
        || message["src"] != "backend"
        || message["topic"] != "backend.event"
        || message["kind"] != "event"
    {
        return;
    }
    let data = &message["data"]["data"];
    match message["data"]["function"].as_str().unwrap_or("") {
        "text_received" if data["text"].is_string() => {
            let mut latest = json!({});
            for key in [
                "text",
                "processed_text",
                "source",
                "source_display_name",
                "time",
            ] {
                if data[key].is_string() {
                    latest[key] = data[key].clone();
                }
            }
            *app.state::<MiningWorkspace>().latest.lock().unwrap() = latest.clone();
            emit(app, "textprocess-latest-text", latest);
        }
        "windows_speech_status" => emit(app, "speech-recognition.status", data.clone()),
        "windows_speech_log" => {
            let mut payload = data.clone();
            if let Some(msg) = payload["message"].as_str() {
                payload["message"] = json!(crate::desktop_log::ensure_origin("py:speech", msg));
            }
            emit(app, "speech-recognition.log", payload);
        }
        _ => {}
    }
}
async fn preview(app: &tauri::AppHandle, payload: Value) -> Result<Value, String> {
    if !payload["text"].is_string() || !payload["config"].is_object() {
        return Err("Preview requires text and settings".into());
    }
    let permit = app
        .state::<MiningWorkspace>()
        .previews
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Text processing preview is busy")?;
    let base = app.state::<crate::settings::Settings>().paths.active.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let language = Workspace::new(&base).target_language()?;
        let result = gsm_text_preview::process(&payload, &language)?;
        Ok(json!({"success":true,"result":result}))
    })
    .await
    .map_err(|e| e.to_string())?
}
pub async fn invoke(
    app: &tauri::AppHandle,
    channel: &str,
    payload: Value,
) -> Result<Value, String> {
    if channel == "textprocess.latestText" {
        return Ok(app
            .state::<MiningWorkspace>()
            .latest
            .lock()
            .unwrap()
            .clone());
    }
    if channel == "textprocess.preview" {
        return Ok(preview(app, payload)
            .await
            .unwrap_or_else(|error| json!({"success":false,"error":error})));
    }
    if matches!(
        channel,
        "speech-recognition.stop" | "speech-recognition.getStatus"
    ) {
        let function = if channel.ends_with(".stop") {
            "windows_speech_stop"
        } else {
            "windows_speech_get_status"
        };
        return Ok(
            json!({"success":true,"backendConnected":crate::runtime::backend_command(app,function,Value::Null).await?}),
        );
    }
    let base = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .clone();
    let operation = channel.to_owned();
    let input = payload.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let settings = Workspace::new(&base);
        match operation.as_str() {
            "textprocess.load" => settings.text(),
            "textprocess.save" => settings.save_text(&input).map(|_| json!({"success":true})),
            "textprocess.exclusions.list" => settings
                .exclusions()
                .map(|games| json!({"success":true,"games":games})),
            "textprocess.exclusions.add" | "textprocess.exclusions.remove" => settings
                .change_exclusion(
                    input["game"].as_str().unwrap_or(""),
                    input["text"].as_str().unwrap_or(""),
                    operation.ends_with(".add"),
                )
                .map(|games| json!({"success":true,"games":games})),
            "speech-recognition.loadScene" => settings.speech(&input["scene"]),
            "speech-recognition.saveScene" | "speech-recognition.start" => {
                settings.save_speech(&input["scene"], &input["settings"])
            }
            _ => Err(format!("Unknown mining workspace operation: {operation}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut result = match result {
        Ok(value) => value,
        // Loading must reject: showing defaults after a failed read could cause
        // an autosave to overwrite the user's existing profile.
        Err(error) if channel == "textprocess.load" => return Err(error),
        Err(error) => return Ok(json!({"success":false,"error":error})),
    };
    if channel == "textprocess.save" {
        let _ = crate::runtime::backend_command(app, "reload_settings", Value::Null).await;
    }
    if channel.starts_with("textprocess.exclusions.") && channel != "textprocess.exclusions.list" {
        emit(app, "textprocess-exclusions-changed", result.clone());
    }
    if channel == "speech-recognition.start" {
        let scene = normalize_scene(&payload["scene"])?;
        result["backendConnected"]=json!(crate::runtime::backend_command(app,"windows_speech_start",json!({"sceneId":scene["id"],"sceneName":scene["name"],"settings":speech_settings(&payload["settings"])})).await?);
    }
    Ok(result)
}
