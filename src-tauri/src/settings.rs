use serde_json::{json, Value};
use tauri::Manager;
pub struct Settings {
    pub paths: gsm_settings::paths::Paths,
}
pub async fn dispatch(app: &tauri::AppHandle, params: Value) -> Result<Value, String> {
    let paths = app.state::<Settings>().paths.clone();
    let action = params["action"].as_str().unwrap_or("").to_owned();
    let args = params["params"].clone();
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let profiles = gsm_settings::profiles::Profiles::new(&paths.active);
        let preferences = gsm_settings::preferences::Preferences::new(&paths.active);
        let exe = args["exeName"].as_str().unwrap_or("");
        let scene = args["sceneId"].as_str();
        match action.as_str() {
            "preferences.snapshot" => preferences.snapshot(),
            "preferences.get" => {
                let value =
                    preferences.get(args["key"].as_str().ok_or("Missing preference key")?)?;
                Ok(json!({"exists":value.is_some(),"value":value}))
            }
            "preferences.patch" => preferences.patch(&args),
            "preferences.delete" => {
                preferences.delete(args["key"].as_str().ok_or("Missing preference key")?)?;
                Ok(Value::Null)
            }
            "paths" => Ok(json!({"active":paths.active,"shared":paths.shared})),
            "profiles.list" => profiles.list(),
            "profiles.get" => profiles.get(exe, scene),
            "profiles.upsert" | "profiles.delete" => {
                crate::texthook_coordinator::edit_hook_profile(
                    &app_handle,
                    &profiles,
                    args,
                    action == "profiles.delete",
                )
            }
            _ => Err(format!("Unknown native settings action: {action}")),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    if matches!(
        params["action"].as_str(),
        Some("profiles.upsert" | "profiles.delete")
    ) {
        let _ = crate::tray::refresh_menu(app);
    }
    Ok(result)
}
