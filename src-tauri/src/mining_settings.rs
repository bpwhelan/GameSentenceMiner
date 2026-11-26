use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Navigation(Mutex<Option<Value>>);

pub async fn open(app: &AppHandle, root: String, subtab: String) -> Result<Value, String> {
    match root.as_str() {
        "text_processing" => {
            return Ok(crate::desktop_services::focus_hub_and_navigate(
                app,
                "textprocessing",
            ))
        }
        "overlay" => {
            return app
                .state::<crate::overlay_host::OverlayHost>()
                .open_settings(app, None)
                .await
                .map(|_| Value::Null)
        }
        _ => {}
    }
    let hub = crate::app_lifecycle::create_hub_window(app)?;
    crate::desktop_state::focus_window(&hub)?;
    // The hub drains this after subscribing, including when a shortcut starts the webview.
    *app.state::<Navigation>().0.lock().unwrap() = Some(json!({"root": root, "subtab": subtab}));
    crate::desktop_state::emit_to_window(app, hub.label(), "settings.mining.navigate", &[]);
    Ok(Value::Null)
}

pub async fn invoke(
    app: &AppHandle,
    label: &str,
    channel: &str,
    request: Value,
) -> Result<Value, String> {
    if !matches!(label, "main" | "gsm-hub") {
        return Err("Open Settings in the desktop app".into());
    }
    if channel == "settings.mining.navigation" {
        return Ok(app.state::<Navigation>().0.lock().unwrap().take().unwrap_or(Value::Null));
    }
    if channel == "settings.mining.tools" {
        return crate::gui_dialog::open_settings_with(
            app,
            request["root"].as_str().unwrap_or("general").into(),
            request["subtab"].as_str().unwrap_or("").into(),
            crate::gui_dialog::prepare_host(app),
        )
        .await;
    }
    if channel == "settings.mining.recommendedAnki" {
        return crate::recommended_anki::open(app).await;
    }
    if channel == "settings.mining.pickPath" {
        let directory = request["directory"].as_bool().unwrap_or(false);
        let mut opts = serde_json::Map::new();
        opts.insert(
            "title".into(),
            json!(request["title"].as_str().unwrap_or(if directory {
                "Select Folder"
            } else {
                "Select File"
            })),
        );
        opts.insert(
            "properties".into(),
            json!(if directory {
                vec!["openDirectory", "createDirectory"]
            } else {
                vec!["openFile"]
            }),
        );
        if let Some(current) = request["currentPath"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let candidate = std::path::PathBuf::from(current);
            let dir = if candidate.is_dir() {
                Some(candidate)
            } else {
                candidate
                    .parent()
                    .filter(|p| p.is_dir())
                    .map(|p| p.to_path_buf())
            };
            if let Some(default_path) = dir {
                opts.insert("defaultPath".into(), json!(default_path.to_string_lossy()));
            }
        }
        let picked = crate::native::dialog_open(&Value::Object(opts)).await?;
        if picked["canceled"].as_bool() == Some(true) {
            return Ok(Value::Null);
        }
        let selected = picked["filePaths"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(Value::as_str)
            .map(|s| json!(s))
            .unwrap_or(Value::Null);
        return Ok(selected);
    }
    if channel == "settings.mining.activate" {
        let name = request["name"].as_str().ok_or("Choose a profile")?;
        app.state::<crate::obs::Obs>()
            .select_game_profile(name, None)?;
        changed(app).await;
        return Ok(Value::Null);
    }
    let file = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("config.json");
    if channel == "settings.mining.ankiChoices" {
        let url = tokio::task::spawn_blocking(move || {
            let doc = gsm_settings::read_object(&file)?;
            let active = doc["current_profile"]
                .as_str()
                .ok_or("Missing active profile")?;
            let url = doc["configs"][active]["anki"]["url"]
                .as_str()
                .ok_or("Missing AnkiConnect URL")?;
            reqwest::Url::parse(url).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        let (action, params) = match request["model"].as_str() {
            Some(model) => ("modelFieldNames", json!({"modelName":model})),
            None => ("modelNames", json!({})),
        };
        let body = json!({"version":6,"action":action,"params":params});
        let state = app.state::<crate::desktop_state::DesktopState>();
        let choices = crate::anki_connect::attempt(&state.http, &url, &body, |raw| {
            serde_json::from_str::<Vec<String>>(raw.get()).map_err(|e| e.to_string())
        })
        .await?;
        return Ok(json!(choices.unwrap_or_default()));
    }
    let editing = channel == "settings.mining.apply";
    if !editing && channel != "settings.mining.read" {
        return Err("Unknown settings action".into());
    }
    let reconnect = editing
        && request["changes"].as_array().is_some_and(|changes| {
            changes.iter().any(|c| {
                matches!(
                    c["path"].as_str(),
                    Some("obs.host" | "obs.port" | "obs.password")
                )
            })
        });
    let hook_buffer = request["changes"]
        .as_array()
        .and_then(|changes| {
            changes
                .iter()
                .find(|c| c["path"] == "general.texthook_max_buffer_size")
        })
        .and_then(|c| c["value"].as_u64());
    let result = tokio::task::spawn_blocking(move || {
        if editing {
            gsm_settings::mining_scopes::apply(&file, &request)
        } else {
            gsm_settings::mining_scopes::read(&file, &request)
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    if editing {
        changed(app).await;
        if let Some(size) = hook_buffer {
            crate::texthook_coordinator::apply_buffer_size(app, size as usize).await;
        }
        if reconnect {
            app.state::<crate::obs::Obs>()
                .connection_settings_changed()
                .await;
        }
    }
    Ok(result)
}

pub async fn changed(app: &AppHandle) {
    let handle = app.clone();
    let refresh = tokio::task::spawn_blocking(move || {
        handle
            .state::<crate::texthook_coordinator::TexthookCoordinator>()
            .invalidate_buffer_size();
        let mining = handle.state::<Arc<crate::mining::MiningService>>();
        mining.invalidate_config_cache();
        if mining.is_enabled() {
            mining.refresh_profile(&handle)?;
        }
        Ok::<(), String>(())
    })
    .await;
    if let Err(error) = refresh.map_err(|e| e.to_string()).and_then(|r| r) {
        crate::desktop_log::warn(app, "settings", error);
    }
    app.state::<crate::obs::Obs>().refresh_session();
    crate::ocr_coordinator::reload_active_ocr(app).await;
    crate::cron::refresh(app);
    let _ = crate::tray::refresh_menu(app);
    if !app
        .state::<Arc<crate::mining::MiningService>>()
        .is_enabled()
    {
        crate::desktop_state::emit_to_desktop_windows(app, "settings.mining.changed", &[]);
    }
    if !crate::app_lifecycle::native_session_requested() {
        let _ = crate::runtime::backend_command(app, "reload_settings", Value::Null).await;
    }
}
