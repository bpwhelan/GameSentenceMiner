use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const WINDOW_LABEL: &str = "mining-settings";

#[derive(Default)]
pub struct Navigation {
    opening: tokio::sync::Mutex<()>,
    destination: Mutex<Option<Value>>,
    ready: AtomicBool,
}

fn create_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let mut url = crate::app_lifecycle::desktop_renderer_url(app)?;
    url.query_pairs_mut().append_pair("window", WINDOW_LABEL);
    let origin = url.origin();
    let page = url.path().to_owned();
    let desktop = app.state::<crate::desktop_state::DesktopState>();
    let profile = crate::dictionary_host::overlay_data_path(app);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("GameSentenceMiner")
        .inner_size(1080., 760.)
        .min_inner_size(600., 440.)
        .center()
        .visible(false)
        .on_navigation(move |next| next.origin() == origin && next.path() == page)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    let builder = crate::dictionary_host::apply_profile_data_directory(
        crate::dictionary_host::apply_shared_webview_options(builder),
        &profile,
    )?;
    let token = desktop.register_window(WINDOW_LABEL, "desktop");
    let preload = crate::overlay_preload::render_desktop_window_preload(
        &token,
        Some(&crate::desktop_state::theme_for_app(app)),
    );
    let window = builder
        .initialization_script(preload)
        .build()
        .map_err(|error| {
            desktop.unregister_window(WINDOW_LABEL);
            error.to_string()
        })?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        let state = handle.state::<Navigation>();
        let desktop = handle.state::<crate::desktop_state::DesktopState>();
        match event {
            WindowEvent::CloseRequested { api, .. }
                if state.ready.load(Ordering::Acquire)
                    && !desktop.quitting.load(Ordering::SeqCst) =>
            {
                api.prevent_close();
                crate::desktop_state::emit_to_window(
                    &handle,
                    WINDOW_LABEL,
                    "settings.mining.requestClose",
                    &[],
                );
            }
            WindowEvent::Destroyed => {
                state.ready.store(false, Ordering::Release);
                desktop.unregister_window(WINDOW_LABEL);
            }
            _ => {}
        }
    });
    Ok(window)
}

pub async fn open(app: &AppHandle, root: String, subtab: String) -> Result<Value, String> {
    match root.as_str() {
        "obs" => {
            return Ok(crate::desktop_services::focus_hub_and_navigate(
                app,
                "obs-settings",
            ))
        }
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
    let state = app.state::<Navigation>();
    let _opening = state.opening.lock().await;
    let existing = app.get_webview_window(WINDOW_LABEL);
    let navigate = !root.is_empty() || !subtab.is_empty();
    if existing.is_none() || navigate {
        // Queue before creating the webview. The first document drains this on mount.
        *state.destination.lock().unwrap() =
            navigate.then(|| json!({"root": root, "subtab": subtab}));
    }
    let window = match existing {
        Some(window) => window,
        None => create_window(app)?,
    };
    crate::desktop_state::focus_window(&window)?;
    if navigate {
        crate::desktop_state::emit_to_window(app, WINDOW_LABEL, "settings.mining.navigate", &[]);
    }
    Ok(Value::Null)
}

pub async fn invoke(
    app: &AppHandle,
    label: &str,
    channel: &str,
    request: Value,
) -> Result<Value, String> {
    let hub_obs = request["view"] == "obs"
        && matches!(
            channel,
            "settings.mining.read" | "settings.mining.apply" | "settings.mining.pickPath"
        )
        && matches!(label, "main" | "gsm-hub");
    if label != WINDOW_LABEL && !hub_obs {
        return Err("Open the mining settings window".into());
    }
    let state = app.state::<Navigation>();
    match channel {
        "settings.mining.ready" => {
            let window = app
                .get_webview_window(label)
                .ok_or("Settings window closed")?;
            if let Some(title) = request["title"].as_str() {
                window.set_title(title).map_err(|e| e.to_string())?;
            }
            state.ready.store(true, Ordering::Release);
            return Ok(state
                .destination
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Value::Null));
        }
        "settings.mining.navigation" => {
            return Ok(state
                .destination
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Value::Null));
        }
        "settings.mining.close" => {
            if let Some(window) = app.get_webview_window(label) {
                window.destroy().map_err(|e| e.to_string())?;
            }
            return Ok(Value::Null);
        }
        _ => {}
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
