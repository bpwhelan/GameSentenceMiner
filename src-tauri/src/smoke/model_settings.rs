use super::*;
use crate::{mining::MiningService, ocr_coordinator::try_invoke};
use std::sync::Arc;

pub(super) async fn run(app: &AppHandle) -> Result<Value, String> {
    let port = app
        .state::<Arc<MiningService>>()
        .bound_gateway_port()
        .ok_or("Gateway did not start")?;
    let url = format!("http://127.0.0.1:{port}/api/ocr/meiki-model");
    let http = &app.state::<DesktopState>().http;
    let read = || async {
        http.get(&url)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await
    };
    let initial = read().await.map_err(|e| e.to_string())?;
    if initial != json!({"model":"large","available":true,"busy":false}) {
        return Err(initial.to_string());
    }
    let changed = try_invoke(app, "ocr.meiki-model", &[json!({"model":"small"})])
        .await
        .ok_or("No OCR command")??;
    if changed != json!({"model":"small","available":true,"busy":false}) {
        return Err(changed.to_string());
    }
    let invalid: Value = http
        .post(&url)
        .json(&json!({"model":"invalid"}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if invalid["model"] != "small" || !invalid["error"].is_string() {
        return Err(invalid.to_string());
    }
    let result = read().await.map_err(|e| e.to_string())?;
    if result != changed {
        return Err(result.to_string());
    }
    let vocr_url = format!("http://127.0.0.1:{port}/api/ocr/vita-model");
    let get_vocr = || async {
        http.get(&vocr_url)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await
    };
    let original = get_vocr().await.map_err(|e| e.to_string())?;
    if original["model"] != "large"
        || original["backend"] != "onnx"
        || original["available"] != true
        || original["installed"] != json!(["normal", "small", "large"])
    {
        return Err(original.to_string());
    }
    let selected = try_invoke(app, "ocr.vita-model", &[json!({"model":"small"})])
        .await
        .ok_or("No VOCR command")??;
    let invalid: Value = http
        .post(&vocr_url)
        .json(&json!({"model":"invalid"}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if selected["model"] != "small"
        || selected["backend"] != "onnx"
        || selected["available"] != true
        || invalid["model"] != "small"
        || !invalid["error"].is_string()
        || get_vocr().await.map_err(|e| e.to_string())? != selected
    {
        return Err(format!(
            "VOCR selection {selected}, invalid request {invalid}"
        ));
    }
    Ok(json!({"meiki":changed,"vocr":selected}))
}
