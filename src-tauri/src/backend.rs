//! Desktop status and compatibility responses for the retired process lifecycle.
use gsm_settings::gsm_config::get_configured_single_port;
use reqwest::header::ACCEPT_ENCODING;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

pub fn snapshot(_app: &tauri::AppHandle) -> Value {
    json!({"state":"stopped","finished":true})
}

pub async fn fetch_status(app: &tauri::AppHandle, timeout: Duration) -> Result<Value, String> {
    if app
        .state::<Arc<crate::mining::MiningService>>()
        .is_enabled()
    {
        return Ok(crate::live_status::snapshot(app));
    }
    let config_path = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("config.json");
    let port = get_configured_single_port(&config_path);
    app.state::<crate::desktop_state::DesktopState>()
        .http
        .get(format!("http://127.0.0.1:{port}/get_status"))
        // The single-port gateway can otherwise request compressed JSON on our behalf.
        .header(ACCEPT_ENCODING, "identity")
        .timeout(timeout)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())
}

pub async fn dispatch(app: &tauri::AppHandle, params: Value) -> Result<Value, String> {
    match params["action"].as_str() {
        Some("state") => Ok(snapshot(app)),
        Some("stop") => Ok(Value::Null),
        Some("start" | "restart") => Err(crate::python_install::RETIRED.into()),
        _ => Err("Unknown backend lifecycle action".into()),
    }
}
