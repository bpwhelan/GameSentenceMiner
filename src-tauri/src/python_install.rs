//! Private native Python installer API for the transitional application shell.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct PythonInstall {
    pub gate: Arc<tokio::sync::Mutex<()>>,
}
pub fn project_root(app:&tauri::AppHandle)->std::path::PathBuf {
    // Isolated integration fixtures never touch the installed project or user environment.
    if cfg!(debug_assertions) && std::env::var_os("GSM_SMOKE_TEST").is_some() {
        if let Some(root)=std::env::var_os("GSM_TEST_PYTHON_PROJECT") { return root.into(); }
    }
    app.state::<crate::desktop_state::DesktopState>().app_root.clone()
}
fn update_notice(app: &tauri::AppHandle, succeeded: bool) {
    if std::env::var_os("GSM_SMOKE_TEST").is_some() {
        return;
    }
    let (title, body) = if succeeded {
        (
            "Backend Synced",
            "GameSentenceMiner backend has been synced successfully.",
        )
    } else {
        (
            "Backend Sync Failed",
            "GameSentenceMiner backend sync failed. Check logs for details.",
        )
    };
    #[cfg(windows)]
    let result = crate::windows_notifications::apply(
        app,
        &json!({"id":941892,"title":title,"body":body,"timeoutType":"default"}),
        false,
    );
    #[cfg(not(windows))]
    let result = {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .id(941892)
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    };
    if let Err(error) = result {
        eprintln!("Could not show backend update notice: {error}");
    }
}
impl PythonInstall {
    fn events(&self, app: &tauri::AppHandle, operation: Value) -> gsm_packages::python::Events {
        let app = app.clone();
        Arc::new(move |event, data| {
            let encoded = json!({
                "type": "native-python",
                "operation": operation,
                "event": event,
                "data": data,
            })
            .to_string();
            for label in crate::desktop_state::desktop_window_labels(&app) {
                let _ = app.emit_to(&label, "python-install", encoded.clone());
            }
        })
    }
}
pub async fn dispatch(app: &tauri::AppHandle, mut params: Value) -> Result<Value, String> {
    let sessions = app
        .state::<crate::install_session::InstallSessions>()
        .model
        .clone();
    // Queued work must not borrow a later retry's identity.
    let lease = if let Some(value)=params["params"].get("session") {
        serde_json::from_value::<Option<gsm_packages::install_session::Lease>>(value.clone()).map_err(|e|e.to_string())?
    } else { sessions.lease() };
    let action = params["action"].as_str().unwrap_or("").to_owned();
    let guarded = matches!(
        action.as_str(),
        "ensure"
            | "prepare"
            | "reinstall"
            | "ensurePip"
            | "ensureUv"
            | "sync"
            | "install"
            | "command"
            | "maintain"
            | "packageInstall"
    );
    let guard = if guarded
        || matches!(
            action.as_str(),
            "info" | "packages" | "updateCheck" | "cleanCacheStrict"
        ) {
        Some(app.state::<PythonInstall>().gate.clone().lock_owned().await)
    } else {
        None
    };
    if guarded {
        let live = crate::runtime::has_live_processes(app).await?;
        if live && !matches!(action.as_str(), "ensure" | "prepare") {
            return Err("Stop managed Python processes before updating their environment.".into());
        }
        params["params"]["readOnlyEnvironment"] = json!(live);
    }
    let paths = app.state::<crate::settings::Settings>().paths.clone();
    let root = project_root(app);
    let publish = app
        .state::<PythonInstall>()
        .events(app, params["params"]["operation"].clone());
    let stages = Arc::new(Mutex::new(BTreeMap::new()));
    let snapshots = stages.clone();
    let operation_stage = match action.as_str() {
        "sync" => Some("lock_sync"),
        "install" => Some("gsm_package"),
        "ensureUv" => Some("verify_runtime"),
        _ => None,
    };
    let current_stage = Mutex::new(operation_stage.map(str::to_owned));
    let session_app = app.clone();
    let events: gsm_packages::python::Events = Arc::new(move |event, data| {
        if event == "stage" {
            let mut current = current_stage.lock().unwrap();
            if data["status"] == "running" {
                *current = data["stageId"].as_str().map(str::to_owned);
            } else if current.as_deref() == data["stageId"].as_str() {
                *current = None;
            }
        }
        if let Some(lease) = &lease {
            if event == "maintenance-failed" {
                let _ = sessions.finish(
                    lease,
                    "failed",
                    Some("Python maintenance failed."),
                    data["error"].as_str(),
                );
            }
            if event == "stage" {
                let _ = sessions.update(lease, &data);
            }
            if event == "log" {
                sessions.append(
                    lease,
                    &json!({"source":"setup","stream":data["stream"],"message":data["message"]}),
                );
            }
            if event == "progress" {
                if let Some(stage) = current_stage.lock().unwrap().as_ref() {
                    let _ = sessions.update(lease, &json!({"stageId":stage,"progressKind":"estimated","progress":data["progress"],"message":data["message"]}));
                }
            }
            session_app
                .state::<crate::install_session::InstallSessions>()
                .notify();
        }
        if event == "stage" {
            if let Some(id) = data["stageId"].as_str() {
                snapshots
                    .lock()
                    .unwrap()
                    .insert(id.to_owned(), data.clone());
            }
        }
        publish(event, data);
    });
    if let Some(stage) = operation_stage {
        events(
            "stage",
            json!({"stageId":stage,"status":"running","progressKind":"estimated","progress":0.05}),
        );
    }
    let completion = events.clone();
    let notify_update = action == "maintain" && params["params"]["mode"] == "update";
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        gsm_packages::python::Python::new(&paths.shared, &root, cfg!(debug_assertions)).call(
            params["action"].as_str().unwrap_or(""),
            &params["params"],
            events,
        )
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);
    if let Some(stage) = operation_stage {
        completion(
            "stage",
            match &result {
                Ok(_) => json!({"stageId":stage,"status":"completed","progress":1}),
                Err(error) => json!({"stageId":stage,"status":"failed","error":error}),
            },
        );
    }
    if action == "maintain" {
        if let Err(error) = &result {
            completion("maintenance-failed", json!({"error":error}));
        }
    }
    if notify_update
        && result
            .as_ref()
            .map_or(true, |value| value["changed"] == true)
    {
        update_notice(app, result.is_ok());
    }
    let result = result?;
    if matches!(action.as_str(),"maintain"|"prepare")
        && result["ignoredExtras"]
            .as_array()
            .is_some_and(|values| !values.is_empty())
    {
        let paths = &app.state::<crate::settings::Settings>().paths;
        gsm_settings::preferences::Preferences::new(&paths.active)
            .patch(&json!({"pythonExtras":result["selectedExtras"]}))?;
    }
    // Final state is reliable even when compatibility progress messages were
    // dropped or arrive after the operation response. Native work never waits
    // for Node to drain the event pipe.
    let stages: Vec<Value> = stages.lock().unwrap().values().cloned().collect();
    Ok(json!({"result":result,"stages":stages}))
}

pub async fn environment(app: &tauri::AppHandle, action: &str) -> Result<Value, String> {
    let result = dispatch(app, json!({"action":action,"params":{}})).await;
    Ok(match result {
        Ok(_) if action == "cleanCacheStrict" => {
            json!({"success":true,"message":"Python cache cleaned successfully"})
        }
        Ok(reply) => reply["result"].clone(),
        Err(error) => json!({"success":false,"message":error,"packages":[]}),
    })
}
