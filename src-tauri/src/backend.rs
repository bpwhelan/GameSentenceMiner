//! Native application owner for backend launch, readiness, recovery and stop.
use gsm_runtime::backend::{Backend, Call};
use gsm_settings::gsm_config::get_configured_single_port;
use reqwest::header::ACCEPT_ENCODING;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct BackendState {
    owner: Mutex<Option<Arc<Backend>>>,
    transition: tokio::sync::Mutex<()>,
}
impl BackendState {
    pub fn get(&self, app: &tauri::AppHandle) -> Arc<Backend> {
        self.owner.lock().unwrap().get_or_insert_with(|| {
            let handle=app.clone();
            let call: Call=Arc::new(move |action,args| {
                let app=handle.clone();
                Box::pin(async move { operation(&app,action,args).await })
            });
            let app=app.clone();
            Backend::new(call,Arc::new(move |event,data| {
                if event=="state" && data["state"]=="starting" {
                    if let Ok(lease)=serde_json::from_value::<gsm_packages::install_session::Lease>(data["session"].clone()) {
                        let sessions=app.state::<crate::install_session::InstallSessions>();
                        let _=sessions.model.update(&lease,&json!({"stageId":"backend_boot","status":"running","progressKind":"estimated","progress":0.15,"message":"Starting the GSM backend process..."}));
                        sessions.notify();
                    }
                }
                if event=="exit" && data["state"]=="failed" {
                    if let Ok(lease)=serde_json::from_value::<gsm_packages::install_session::Lease>(data["session"].clone()) {
                        let sessions=app.state::<crate::install_session::InstallSessions>();
                        let error=data["error"].as_str().map(str::to_owned).unwrap_or_else(||format!("Backend exited with code {}",data["code"]));
                        let _=sessions.model.finish(&lease,"failed",Some("Failed to initialize the GSM backend process."),Some(&error));
                        sessions.notify();
                    }
                }
                let message=json!({"type":"native-backend","event":event,"data":data});
                // Native observers are independent of any renderer listeners.
                let encoded = message.to_string();
                for label in crate::desktop_state::desktop_window_labels(&app) {
                    let _ = app.emit_to(&label, "backend-lifecycle", encoded.clone());
                }
                crate::app_lifecycle::on_backend_lifecycle_event(&app, event, &data);
            }))
        }).clone()
    }
}
pub fn observe(app: &tauri::AppHandle, event: &str, data: &Value) {
    let owner = app.state::<BackendState>().owner.lock().unwrap().clone();
    if let Some(owner) = owner {
        owner.observe(event, data);
    }
}
pub fn snapshot(app: &tauri::AppHandle) -> Value {
    app.state::<BackendState>().get(app).snapshot()
}

pub async fn fetch_status(app: &tauri::AppHandle, timeout: Duration) -> Result<Value, String> {
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
    let state = app.state::<BackendState>();
    let owner = state.get(app);
    let action = params["action"].as_str().unwrap_or("");
    if action == "state" {
        return Ok(owner.snapshot());
    }
    if action == "stop" {
        return owner.stop(params["params"]["runId"].as_str()).await;
    }
    let _transition = state
        .transition
        .try_lock()
        .map_err(|_| "A backend launch transition is already in progress")?;
    if action == "restart" {
        owner.stop(None).await?;
    }
    if !matches!(action, "start" | "restart") {
        return Err("Unknown backend lifecycle action".into());
    }
    // Do not take over an unmanaged or separately launched backend.
    let live = crate::runtime::get(app)?
        .call("process.state", json!({"id":"backend"}))
        .await?;
    if live["pid"].as_u64().is_some()
        || matches!(
            live["state"].as_str(),
            Some("starting" | "restarting" | "stopping")
        )
    {
        return Err("The backend is already running".into());
    }
    let mut spec = params["params"]
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or(json!({}));
    let paths = &app.state::<crate::settings::Settings>().paths;
    if spec.get("extras").is_none() {
        spec["extras"] = gsm_settings::preferences::Preferences::new(&paths.active)
            .get("pythonExtras")?
            .unwrap_or(json!([]));
    }
    if spec.get("isPreRelease").is_none() {
        let root = &app.state::<crate::desktop_state::DesktopState>().app_root;
        spec["isPreRelease"] = json!([
            root.join("prerelease.json"),
            root.join("assets/prerelease.json"),
            root.join("electron-src/assets/prerelease.json")
        ]
        .iter()
        .any(|p| std::fs::read(p)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|v| v["branch"].as_str().is_some_and(|s| !s.trim().is_empty()))));
    }
    spec["session"] = serde_json::to_value(
        app.state::<crate::install_session::InstallSessions>()
            .model
            .lease(),
    )
    .map_err(|e| e.to_string())?;
    owner.start(spec)
}
async fn operation(app: &tauri::AppHandle, action: &str, args: Value) -> Result<Value, String> {
    match action {
        "prepare" => {
            crate::python_install::dispatch(app, json!({"action":"prepare","params":args}))
                .await
                .map(|v| v["result"].clone())
        }
        "repair" => {
            let runtime = crate::runtime::get(app)?;
            // Only owned Python trees are stopped. Native capture and hook
            // engines do not need to be dismantled to repair Python packages.
            for id in runtime
                .call("process.list", json!({}))
                .await?
                .as_array()
                .into_iter()
                .flatten()
            {
                runtime.call("process.stop", json!({"id":id})).await?;
            }
            crate::python_install::dispatch(app,json!({"action":"maintain","params":{
                "mode":"startup_repair","pythonPath":args["prepared"]["pythonPath"],"extras":args["prepared"]["selectedExtras"],"session":args["spec"]["session"]
            }})).await.map(|v|v["result"].clone())
        }
        "launch" => {
            static SIMULATED: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if (std::env::var("GSM_SIMULATE_STARTUP_FAILURE_ONCE").as_deref() == Ok("1")
                || std::env::args().any(|arg| arg == "--simulate-startup-failure-once"))
                && !SIMULATED.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                return Err("Simulated failure before starting GSM".into());
            }
            let _guard = app
                .state::<crate::python_install::PythonInstall>()
                .gate
                .clone()
                .lock_owned()
                .await;
            let root = app.state::<crate::desktop_state::DesktopState>().app_root.clone();
            let paths = &app.state::<crate::settings::Settings>().paths;
            let mut env = gsm_packages::python::environment();
            let input_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::input_server::wait_ready(&input_app, std::time::Duration::from_secs(5))
            }).await.map_err(|e| e.to_string())?;
            crate::input_server::apply_env(app, &mut env);
            env.insert("GSM_ELECTRON".into(), "1".into());
            env.insert("GSM_NATIVE_OVERLAY".into(), "1".into());
            env.insert(
                "GSM_DATA_DIR".into(),
                paths.active.to_string_lossy().into_owned(),
            );
            env.insert(
                "GSM_NATIVE_HELPER_ROOT".into(),
                root.join("native").to_string_lossy().into_owned(),
            );
            env.insert(
                "GSM_INSTALL_SESSION_ID".into(),
                args["spec"]["session"]["sessionId"]
                    .as_str()
                    .unwrap_or("")
                    .into(),
            );
            let mut argv = vec!["-m", "GameSentenceMiner.gsm"];
            if cfg!(debug_assertions) {
                argv.push("--dev");
            }
            let cwd = if crate::python_install::project_root(app) != root {
                paths.active.clone()
            } else {
                root
            };
            crate::runtime::get(app)?.call("process.start",json!({"id":"backend","command":args["prepared"]["pythonPath"],
                "args":argv,"cwd":cwd,"env":env,"windowsHide":true,"recoverRuntimeCrashes":true,
                "gracefulStop":{"topic":"backend.command","data":{"function":"quit"},"timeoutMs":5000}})).await
        }
        "stop" => {
            crate::runtime::get(app)?
                .call(
                    "process.stop",
                    json!({"id":"backend","runId":args["runId"]}),
                )
                .await
        }
        _ => Err("Unknown backend operation".into()),
    }
}
