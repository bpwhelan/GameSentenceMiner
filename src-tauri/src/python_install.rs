//! Compatibility replies for clients requesting the retired managed environment.
use serde_json::{json, Value};

pub const RETIRED: &str = "The managed Python environment is disabled in this desktop session.";

pub async fn dispatch(_: &tauri::AppHandle, _: Value) -> Result<Value, String> {
    Err(RETIRED.into())
}

pub async fn environment(_: &tauri::AppHandle, _: &str) -> Result<Value, String> {
    Ok(json!({"success":false,"message":RETIRED,"packages":[]}))
}
