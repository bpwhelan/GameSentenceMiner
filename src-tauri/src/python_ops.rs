//! Native Python runtime & GPU configuration coordinator.
//!
//! Owns `settings.gpu`, `python.installCudaPackage`, `python.uninstallCudaPackage`,
//! `python.resetDependencies`, `python.repairGSM`, `python.installCustomPackage`,
//! `python.reinstallPackage`, `python.openCudaGuide`, `settings.reinstallPython`,
//! `settings.runPipInstall`, and managed backend/python stop & launch coordination.

use gsm_packages::install_session::Lease;
use gsm_settings::preferences::Preferences;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::sync::Notify;

pub const GPU_INSTALL_PROGRESS_CHANNEL: &str = "settings-gpu-install-progress";
const DISABLE_GPU_INSTALLS: bool = false;
const VALID_GPU_ENGINES: [&str; 3] = ["meiki", "firered", "whisper"];
const GPU_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const GPU_REQUEST_TIMEOUT_MS: u64 = 15_000;

/// Shared state tracking backend bus readiness and in-flight GPU/restart operations.
pub struct PythonOpsState {
    backend_connected: AtomicBool,
    backend_connected_notify: Notify,
    gpu_changing: AtomicBool,
    restart_in_flight: AtomicBool,
}

impl Default for PythonOpsState {
    fn default() -> Self {
        Self {
            backend_connected: AtomicBool::new(false),
            backend_connected_notify: Notify::new(),
            gpu_changing: AtomicBool::new(false),
            restart_in_flight: AtomicBool::new(false),
        }
    }
}

impl PythonOpsState {
    pub fn is_backend_connected(&self) -> bool {
        self.backend_connected.load(Ordering::Acquire)
    }

    /// Observe events emitted by `gsm-runtime` (`bus.connected` / `bus.disconnected`).
    pub fn observe_runtime_event(&self, event: &str, data: &Value) {
        if data["id"].as_str() != Some("backend") {
            return;
        }
        match event {
            "bus.connected" => {
                self.backend_connected.store(true, Ordering::Release);
                self.backend_connected_notify.notify_waiters();
            }
            "bus.disconnected" => {
                self.backend_connected.store(false, Ordering::Release);
            }
            _ => {}
        }
    }

    async fn wait_for_backend_connected(
        &self,
        app: &tauri::AppHandle,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.is_backend_connected() || query_backend_bus_connected(app).await {
                self.backend_connected.store(true, Ordering::Release);
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(
                    "GSM did not reconnect after changing the GPU runtime. Reopen GSM to retry."
                        .into(),
                );
            }
            let _ = tokio::time::timeout(remaining.min(Duration::from_secs(2)), self.backend_connected_notify.notified()).await;
        }
    }
}

/// Observe a runtime bus/process event inside `src-tauri` with zero polling overhead.
pub fn observe_runtime_event(app: &tauri::AppHandle, event: &str, data: &Value) {
    if let Some(state) = app.try_state::<PythonOpsState>() {
        state.observe_runtime_event(event, data);
    }
}

async fn query_backend_bus_connected(app: &tauri::AppHandle) -> bool {
    let Ok(rt) = crate::runtime::get(app) else {
        return false;
    };
    let Ok(clients) = rt.call("bus.clients", json!({})).await else {
        return false;
    };
    clients
        .as_array()
        .is_some_and(|list| list.iter().any(|entry| entry.as_str() == Some("backend")))
}

/// Validate a `settings.gpu` IPC request payload against allowed engine keys and types.
pub fn validate_gpu_request(request: &Value) -> Result<(Option<Value>, bool), String> {
    let obj = request
        .as_object()
        .ok_or_else(|| "Invalid GPU request".to_string())?;
    let refresh = obj.get("refresh").and_then(Value::as_bool).unwrap_or(false);
    let settings = match obj.get("settings") {
        None | Some(Value::Null) => None,
        Some(val) => {
            let map = val
                .as_object()
                .ok_or_else(|| "Invalid GPU settings".to_string())?;
            for (key, value) in map {
                if !VALID_GPU_ENGINES.contains(&key.as_str()) || !value.is_boolean() {
                    return Err("Invalid GPU settings".to_string());
                }
            }
            Some(val.clone())
        }
    };
    Ok((settings, refresh))
}

/// Validate a GPU status response returned by the Python backend.
pub fn validate_gpu_status_response(result: Value) -> Result<Value, String> {
    let Some(obj) = result.as_object() else {
        return Err("Invalid GPU response".into());
    };
    if let Some(err) = obj.get("error") {
        let message = err
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| err.to_string());
        return Err(message);
    }
    if !obj.contains_key("settings") || !obj.contains_key("diagnostics") {
        return Err("Invalid GPU status".into());
    }
    Ok(result)
}

/// Handle `settings.gpu` directly in Rust over the `gsm-runtime` message bus.
pub async fn handle_gpu_settings(app: &tauri::AppHandle, args: &[Value]) -> Result<Value, String> {
    let raw_request = args.first().filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({}));
    let (settings, refresh) = validate_gpu_request(&raw_request)?;

    let ops = app.state::<PythonOpsState>();
    if !ops.is_backend_connected() && !query_backend_bus_connected(app).await {
        return Err("The GSM backend is not connected.".into());
    }

    let mut data = serde_json::Map::new();
    if let Some(s) = settings {
        data.insert("settings".into(), s);
    }
    data.insert("refresh".into(), json!(refresh));

    let response = crate::runtime::get(app)?
        .call(
            "bus.request",
            json!({
                "dst": "backend",
                "topic": "gpu.settings",
                "data": Value::Object(data),
                "timeoutMs": GPU_REQUEST_TIMEOUT_MS,
            }),
        )
        .await?;

    validate_gpu_status_response(response)
}

/// Compute requested Python extras for installing or removing CUDA runtime support.
pub fn compute_cuda_extras(
    current_extras: &[String],
    install: bool,
    bundled_libraries: bool,
) -> Vec<String> {
    if install {
        let mut next: Vec<String> = current_extras.to_vec();
        next.push("gpu".into());
        if bundled_libraries {
            next.push("gpu-libs".into());
        }
        next
    } else {
        current_extras
            .iter()
            .filter(|extra| extra.as_str() != "gpu" && extra.as_str() != "gpu-libs")
            .cloned()
            .collect()
    }
}

fn read_python_extras(app: &tauri::AppHandle) -> Vec<String> {
    let active = &app.state::<crate::settings::Settings>().paths.active;
    let Ok(Some(val)) = Preferences::new(active).get("pythonExtras") else {
        return Vec::new();
    };
    val.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn write_python_extras(app: &tauri::AppHandle, extras: &[String]) -> Result<(), String> {
    let active = &app.state::<crate::settings::Settings>().paths.active;
    Preferences::new(active).patch(&json!({ "pythonExtras": extras }))?;
    Ok(())
}

/// Return the managed Python executable path, installing/adopting it if needed.
pub async fn ensure_python_path(app: &tauri::AppHandle) -> Result<String, String> {
    let reply =
        crate::python_install::dispatch(app, json!({ "action": "ensure", "params": {} })).await?;
    let path = reply["result"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Managed Python path could not be resolved.".to_string())?;
    let active = &app.state::<crate::settings::Settings>().paths.active;
    let _ = Preferences::new(active).patch(&json!({ "pythonPath": path }));
    Ok(path)
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

/// Stop all managed Python processes (backend, OCR, overlay) cleanly in Rust.
pub async fn close_all_python_processes(
    app: &tauri::AppHandle,
    close_gsm: bool,
) -> Result<(), String> {
    let mut errors = Vec::new();

    for id in ["ocr", "overlay"] {
        if let Err(err) = stop_runtime_process_if_live(app, id).await {
            errors.push(format!("{id}: {err}"));
        }
    }

    if close_gsm {
        if let Err(err) = crate::backend::dispatch(app, json!({ "action": "stop", "params": {} })).await {
            errors.push(format!("backend: {err}"));
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

/// Disconnect OBS clients and stop all Python processes prior to an app update.
pub async fn close_all_for_app_update(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = app
        .state::<crate::obs::Obs>()
        .inner()
        .invoke(app, "obs.close", &[])
        .await;
    close_all_python_processes(app, true).await
}

/// Launch or restart the managed GSM backend natively through `src-tauri::backend`.
pub async fn ensure_and_run_gsm(
    app: &tauri::AppHandle,
    python_path: Option<String>,
    known_installed_version: Option<String>,
    origin: &str,
    track_install_session: bool,
    repair_on_failure: bool,
    restart: bool,
) -> Result<(), String> {
    if crate::app_lifecycle::native_session_requested() {
        let handle = app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            crate::database_startup::prepare(&handle)?;
            let mining = handle.state::<Arc<crate::mining::MiningService>>();
            mining.invalidate_config_cache();
            mining.refresh_profile(&handle)?;
            Ok(())
        }).await.map_err(|e| e.to_string())?;
    }
    if crate::update_manager::any_app_update_in_progress(app) {
        // Note: explicit update bypasses should wait before calling ensure_and_run_gsm.
    }
    let resolved_python = match python_path.filter(|s| !s.trim().is_empty()) {
        Some(path) => path,
        None => ensure_python_path(app).await?,
    };
    let extras = read_python_extras(app);
    let is_pre_release = crate::update_manager::resolve_prerelease_branch(app).is_some();

    let action = if restart { "restart" } else { "start" };
    let spec = json!({
        "pythonPath": resolved_python,
        "extras": extras,
        "knownInstalledVersion": known_installed_version,
        "isPreRelease": is_pre_release,
        "repairOnFailure": repair_on_failure,
        "origin": origin,
        "trackInstallSession": track_install_session,
    });
    let _ = crate::backend::dispatch(
        app,
        json!({ "action": action, "params": spec }),
    )
    .await?;
    Ok(())
}

/// Restart the managed GSM Python backend process cleanly.
pub async fn restart_gsm(app: &tauri::AppHandle) -> Result<Value, String> {
    let ops = app.state::<PythonOpsState>();
    if ops
        .restart_in_flight
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(json!("The Python backend is already restarting."));
    }

    let result = async {
        ensure_and_run_gsm(app, None, None, "restart", false, true, true).await?;
        Ok::<Value, String>(Value::Null)
    }
    .await;

    ops.restart_in_flight.store(false, Ordering::Release);
    result
}

struct GpuGuard<'a>(&'a AtomicBool);
impl Drop for GpuGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn emit_gpu_phase(app: &tauri::AppHandle, window_label: &str, phase: &str) {
    crate::desktop_state::emit_to_window(
        app,
        window_label,
        GPU_INSTALL_PROGRESS_CHANNEL,
        &[json!({ "phase": phase })],
    );
}

/// Install or uninstall CUDA GPU Python runtime support (`python.installCudaPackage` / `uninstallCudaPackage`).
pub async fn handle_cuda_package(
    app: &tauri::AppHandle,
    window_label: &str,
    install: bool,
    bundled_libraries: bool,
) -> Result<Value, String> {
    if DISABLE_GPU_INSTALLS {
        let title = if install {
            "GPU install disabled"
        } else {
            "GPU uninstall disabled"
        };
        let message = if install {
            "GPU installation is currently disabled in this build. (Likely needs more testing)"
        } else {
            "GPU uninstallation is currently disabled in this build. (Likely needs more testing)"
        };
        let _ = crate::native::dialog_message(&json!({
            "type": "info",
            "title": title,
            "message": message,
            "buttons": ["OK"]
        }))
        .await;
        return Ok(json!({
            "success": false,
            "message": if install { "GPU install disabled" } else { "GPU uninstall disabled" }
        }));
    }

    let outcome: Result<String, String> = async {
        let python_path = ensure_python_path(app).await?;
        let current_extras = read_python_extras(app);
        let requested_extras = compute_cuda_extras(&current_extras, install, bundled_libraries);

        let resolved = crate::python_install::dispatch(
            app,
            json!({ "action": "extras", "params": { "extras": requested_extras } }),
        )
        .await?;
        let selected_extras: Vec<String> = resolved["result"]["selectedExtras"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();

        if install && !selected_extras.iter().any(|e| e == "gpu") {
            return Err(
                "The \"gpu\" extra is not available in the bundled lockfile. Update the app before enabling GPU support."
                    .into(),
            );
        }

        let ops = app.state::<PythonOpsState>();
        if ops
            .gpu_changing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("A GPU runtime change is already in progress.".into());
        }
        let _guard = GpuGuard(&ops.gpu_changing);

        emit_gpu_phase(app, window_label, "stopping");
        close_all_python_processes(app, true).await?;

        emit_gpu_phase(app, window_label, "installing");
        let apply_result: Result<(), String> = async {
            crate::python_install::dispatch(
                app,
                json!({ "action": "ensureUv", "params": { "pythonPath": python_path } }),
            )
            .await?;
            crate::python_install::dispatch(
                app,
                json!({
                    "action": "sync",
                    "params": { "pythonPath": python_path, "extras": selected_extras, "checkOnly": false }
                }),
            )
            .await?;
            write_python_extras(app, &selected_extras)?;
            Ok(())
        }
        .await;

        emit_gpu_phase(app, window_label, "starting");
        let start_result: Result<(), String> = async {
            ensure_and_run_gsm(
                app,
                Some(python_path),
                None,
                "gpu_runtime",
                false,
                true,
                false,
            )
            .await?;
            ops.wait_for_backend_connected(app, GPU_STARTUP_TIMEOUT)
                .await?;
            Ok(())
        }
        .await;

        match (apply_result, start_result) {
            (Err(apply_err), Err(start_err)) => Err(format!(
                "GPU runtime change failed and GSM could not restart: {apply_err}; {start_err}"
            )),
            (Err(apply_err), Ok(())) => Err(apply_err),
            (Ok(()), Err(start_err)) => Err(start_err),
            (Ok(()), Ok(())) => Ok(if install {
                "GPU inference runtime installed and verified successfully".into()
            } else {
                "CPU ONNX Runtime restored successfully".into()
            }),
        }
    }
    .await;

    Ok(match outcome {
        Ok(message) => json!({ "success": true, "message": message }),
        Err(error) => {
            let prefix = if install {
                "Failed to install CUDA GPU support"
            } else {
                "Failed to uninstall CUDA GPU support"
            };
            json!({ "success": false, "message": format!("{prefix}: {error}") })
        }
    })
}

fn retry_target_for_origin(origin: &str) -> String {
    format!("native:{origin}")
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

/// Run `python.repairGSM` or `python.resetDependencies` cleanly inside Rust.
pub async fn run_python_maintenance(app: &tauri::AppHandle, origin: &str) -> Value {
    let sessions = app.state::<crate::install_session::InstallSessions>();
    let _ = sessions.model.call(
        "ensure",
        &json!({ "origin": origin, "retry": retry_target_for_origin(origin) }),
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
        "Manual dependency workflow prepared.",
    );

    let outcome: Result<String, String> = async {
        if origin == "repair" && crate::app_lifecycle::native_session_requested() {
            #[cfg(windows)]
            crate::startup_tools::prepare(app, lease.clone()).await?;
            ensure_and_run_gsm(app, None, None, origin, false, false, false).await?;
            if let Some(lease) = &lease {
                let _ = sessions.model.finish(lease, "completed", Some("GSM repaired successfully."), None);
                sessions.notify();
            }
            return Ok("GSM repaired successfully".into());
        }
        close_all_python_processes(app, true).await?;
        let extras = read_python_extras(app);
        let res = crate::python_install::dispatch(
            app,
            json!({
                "action": "maintain",
                "params": { "mode": origin, "extras": extras }
            }),
        )
        .await?;
        let py_path = res["result"]["pythonPath"]
            .as_str()
            .map(str::to_owned)
            .filter(|s| !s.is_empty());
        ensure_and_run_gsm(app, py_path, None, origin, true, false, false).await?;
        Ok(if origin == "repair" {
            "GSM repaired successfully".into()
        } else {
            "Python dependencies reset successfully".into()
        })
    }
    .await;

    match outcome {
        Ok(message) => json!({ "success": true, "message": message }),
        Err(message) => {
            if let Some(lease) = lease {
                let _ = sessions.model.finish(
                    &lease,
                    "failed",
                    Some("Python maintenance failed."),
                    Some(&message),
                );
                sessions.notify();
            }
            json!({ "success": false, "message": message })
        }
    }
}

/// Install or reinstall a custom pip requirement (`python.installCustomPackage` / `reinstallPackage`).
pub async fn install_custom_package(
    app: &tauri::AppHandle,
    requirement: &str,
    reinstall: bool,
) -> Value {
    let req = requirement.trim();
    if req.is_empty() {
        return json!({ "success": false, "message": "Package requirement must not be empty." });
    }
    let outcome: Result<Value, String> = async {
        close_all_python_processes(app, true).await?;
        let python_path = ensure_python_path(app).await?;
        let reply = crate::python_install::dispatch(
            app,
            json!({
                "action": "packageInstall",
                "params": { "pythonPath": python_path, "requirement": req, "reinstall": reinstall }
            }),
        )
        .await?;
        restart_gsm(app).await?;
        Ok(reply["result"].clone())
    }
    .await;

    match outcome {
        Ok(val) if val.is_object() => val,
        Ok(_) => json!({ "success": true, "message": format!("Installed {req}") }),
        Err(message) => json!({ "success": false, "message": message }),
    }
}

/// Handle `settings.reinstallPython` confirmation dialog and reinstall workflow.
pub async fn handle_reinstall_python(app: &tauri::AppHandle) -> Value {
    let Ok(choice) = crate::native::dialog_message(&json!({
        "type": "warning",
        "title": "Reinstall Python",
        "message": "Are you sure you want to reinstall Python? This will remove the current installation and install a fresh copy.",
        "buttons": ["Yes", "No"],
    }))
    .await
    else {
        return Value::Null;
    };
    if choice != 0 {
        return Value::Null;
    }

    match crate::python_install::dispatch(app, json!({ "action": "reinstall", "params": {} }))
        .await
    {
        Ok(_) => json!({ "success": true, "message": "Python reinstalled successfully." }),
        Err(_) => json!({ "success": false, "message": "Failed to reinstall Python." }),
    }
}

/// Handle `settings.runPipInstall` (`{ success: true }` / `{ success: false, error }`).
pub async fn handle_run_pip_install(app: &tauri::AppHandle, package: &str) -> Value {
    let result = install_custom_package(app, package, false).await;
    if result["success"].as_bool() == Some(true) {
        json!({ "success": true })
    } else {
        json!({
            "success": false,
            "error": result["message"].as_str().unwrap_or("Failed to run pip install")
        })
    }
}

/// Execute a registered native install-session retry target (prefixed with `"native:"`).
pub async fn execute_native_retry(app: tauri::AppHandle, target: String, lease: Lease) {
    let outcome: Result<(), String> = match target.as_str() {
        "native:repair" => {
            let res = run_python_maintenance(&app, "repair").await;
            if res["success"] == true {
                Ok(())
            } else {
                Err(res["message"]
                    .as_str()
                    .unwrap_or("Repair failed.")
                    .to_owned())
            }
        }
        "native:reset_dependencies" => {
            let res = run_python_maintenance(&app, "reset_dependencies").await;
            if res["success"] == true {
                Ok(())
            } else {
                Err(res["message"]
                    .as_str()
                    .unwrap_or("Reset dependencies failed.")
                    .to_owned())
            }
        }
        "native:startup" if crate::app_lifecycle::native_session_requested() =>
            crate::app_lifecycle::start_native_services(&app, Some(lease.clone())).await,
        "native:startup" => ensure_and_run_gsm(&app, None, None, "startup", true, true, false).await,
        "native:backend_update" => {
            let updater = app.state::<crate::update_manager::UpdateManager>().inner().clone();
            updater.update_gsm(&app, false, false).await;
            if updater.last_backend_update_was_successful() {
                Ok(())
            } else {
                Err(updater
                    .last_backend_update_failure_reason()
                    .unwrap_or_else(|| "Backend update retry failed.".into()))
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_gpu_requests_like_electron_service() {
        assert!(validate_gpu_request(&json!("bad")).is_err());
        assert!(validate_gpu_request(&json!([])).is_err());
        assert!(validate_gpu_request(&json!({ "settings": { "unknown": true } })).is_err());
        assert!(validate_gpu_request(&json!({ "settings": { "meiki": "yes" } })).is_err());

        let (settings, refresh) =
            validate_gpu_request(&json!({ "settings": { "meiki": true, "whisper": false }, "refresh": true }))
                .unwrap();
        assert_eq!(settings, Some(json!({ "meiki": true, "whisper": false })));
        assert!(refresh);

        let (none_settings, default_refresh) = validate_gpu_request(&json!({})).unwrap();
        assert_eq!(none_settings, None);
        assert!(!default_refresh);
    }

    #[test]
    fn validates_gpu_status_responses() {
        assert!(validate_gpu_status_response(json!("str")).is_err());
        assert!(validate_gpu_status_response(json!({ "error": "boom" })).is_err());
        assert!(validate_gpu_status_response(json!({ "settings": {} })).is_err());
        let ok = json!({ "settings": {}, "diagnostics": {}, "availability": {}, "runtime": {} });
        assert_eq!(validate_gpu_status_response(ok.clone()).unwrap(), ok);
    }

    #[test]
    fn computes_cuda_extras_for_install_and_uninstall() {
        assert_eq!(
            compute_cuda_extras(&["oneocr".into()], true, false),
            vec!["oneocr", "gpu"]
        );
        assert_eq!(
            compute_cuda_extras(&["oneocr".into()], true, true),
            vec!["oneocr", "gpu", "gpu-libs"]
        );
        assert_eq!(
            compute_cuda_extras(&["oneocr".into(), "gpu".into(), "gpu-libs".into()], false, false),
            vec!["oneocr"]
        );
    }
}
