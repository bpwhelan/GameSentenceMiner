use gsm_overlay::engines::vocr::selection::{self, Tier};
use serde_json::Value;
use std::path::Path;
use tauri::Manager;
use tokio::sync::Semaphore;

static CHANGES: Semaphore = Semaphore::const_new(1);

pub(crate) fn request(base: &Path, input: &Value) -> Value {
    let change = || -> Result<(), String> {
        let data = input.as_object().ok_or("Expected a VOCR model request")?;
        let Some(model) = data.get("model") else {
            return Ok(());
        };
        let tier: Tier = serde_json::from_value(model.clone())
            .map_err(|_| "Choose a VOCR model: small, normal or large")?;
        let _slot = CHANGES
            .try_acquire()
            .map_err(|_| "Another VOCR model change is in progress. Try again shortly.")?;
        tier.select(base).map_err(|e| format!("{e:#}"))
    };
    let error = change().err();
    let mut status = selection::status(base, CHANGES.available_permits() == 0);
    if let Some(error) = error {
        status["error"] = error.into();
    }
    status
}
pub(crate) async fn invoke(app: &tauri::AppHandle, input: Value) -> Result<Value, String> {
    let base = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .clone();
    tauri::async_runtime::spawn_blocking(move || request(&base, &input))
        .await
        .map_err(|e| e.to_string())
}
