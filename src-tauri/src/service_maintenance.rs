//! Native repair, restart and install-session retry handling.

use gsm_packages::install_session::Lease;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

#[derive(Default)]
pub struct MaintenanceState {
    restart_in_flight: AtomicBool,
}

async fn stop_runtime_process_if_live(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let Ok(rt) = crate::runtime::get(app) else {
        return Ok(());
    };
    let Ok(state) = rt.call("process.state", json!({ "id": id })).await else {
        return Ok(());
    };
    if !state["pid"].is_null() {
        rt.call("process.stop", json!({ "id": id })).await?;
    }
    Ok(())
}

/// Stop managed OCR and overlay processes before maintenance.
pub async fn stop_managed_processes(app: &tauri::AppHandle) -> Result<(), String> {
    let mut errors = Vec::new();

    for id in ["ocr", "overlay"] {
        if let Err(err) = stop_runtime_process_if_live(app, id).await {
            errors.push(format!("{id}: {err}"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Failed to stop backend-related processes: {}",
            errors.join("; ")
        ))
    }
}

/// Disconnect OBS clients and stop managed processes prior to an app update.
pub async fn close_all_for_app_update(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = app
        .state::<crate::obs::Obs>()
        .inner()
        .invoke(app, "obs.close", &[])
        .await;
    stop_managed_processes(app).await
}

async fn refresh_native_services(app: &tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::database_startup::prepare(&handle)?;
        let mining = handle.state::<Arc<crate::mining::MiningService>>();
        mining.invalidate_config_cache();
        mining.refresh_profile(&handle)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Refresh the database and mining services after a restore.
pub async fn restart_gsm(app: &tauri::AppHandle) -> Result<Value, String> {
    let ops = app.state::<MaintenanceState>();
    if ops
        .restart_in_flight
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(json!("The desktop services are already restarting."));
    }

    let result = async {
        refresh_native_services(app).await?;
        Ok::<Value, String>(Value::Null)
    }
    .await;

    ops.restart_in_flight.store(false, Ordering::Release);
    result
}

fn update_stage(
    app: &tauri::AppHandle,
    lease: Option<&Lease>,
    stage_id: &str,
    status: &str,
    progress_kind: &str,
    progress: f64,
    message: &str,
) {
    let sessions = app.state::<crate::install_session::InstallSessions>();
    if let Some(lease) = lease {
        let _ = sessions.model.update(
            lease,
            &json!({
                "stageId": stage_id,
                "status": status,
                "progressKind": progress_kind,
                "progress": progress,
                "message": message,
                "error": Value::Null
            }),
        );
        sessions.notify();
    }
}

/// Repair native tools and refresh the active profile.
pub async fn repair(app: &tauri::AppHandle) -> Value {
    let sessions = app.state::<crate::install_session::InstallSessions>();
    let _ = sessions.model.call(
        "ensure",
        &json!({ "origin": "repair", "retry": "native:repair" }),
    );
    sessions.notify();
    let lease = sessions.model.lease();

    update_stage(
        app,
        lease.as_ref(),
        "prepare",
        "completed",
        "estimated",
        1.0,
        "Preparing desktop repair.",
    );

    let outcome: Result<String, String> = async {
        #[cfg(windows)]
        crate::startup_tools::prepare(app, lease.clone()).await?;
        refresh_native_services(app).await?;
        if let Some(lease) = &lease {
            let _ =
                sessions
                    .model
                    .finish(lease, "completed", Some("GSM repaired successfully."), None);
            sessions.notify();
        }
        Ok("GSM repaired successfully".into())
    }
    .await;

    match outcome {
        Ok(message) => json!({ "success": true, "message": message }),
        Err(message) => {
            if let Some(lease) = lease {
                let _ = sessions.model.finish(
                    &lease,
                    "failed",
                    Some("Desktop repair failed."),
                    Some(&message),
                );
                sessions.notify();
            }
            json!({ "success": false, "message": message })
        }
    }
}

/// Execute a registered native install-session retry target (prefixed with `"native:"`).
pub async fn execute_native_retry(app: tauri::AppHandle, target: String, lease: Lease) {
    let outcome: Result<(), String> = match target.as_str() {
        "native:repair" => {
            let res = repair(&app).await;
            if res["success"] == true {
                Ok(())
            } else {
                Err(res["message"]
                    .as_str()
                    .unwrap_or("Repair failed.")
                    .to_owned())
            }
        }
        "native:startup" => {
            crate::app_lifecycle::start_native_services(&app, Some(lease.clone())).await
        }
        _ => Err(format!("Unsupported native retry target: {target}")),
    };

    if let Err(error) = outcome {
        let sessions = app.state::<crate::install_session::InstallSessions>();
        let _ = sessions.model.finish(
            &lease,
            "failed",
            Some("Installation retry failed."),
            Some(&error),
        );
        sessions.notify();
    }
}
