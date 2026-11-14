//! Installation state and progress events belong to the native desktop host.
use gsm_packages::install_session::{Lease, Sessions};
use serde_json::{json, Value};
use std::{
    sync::{
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};
use tauri::{Emitter, Manager};

pub struct InstallSessions {
    pub model: Arc<Sessions>,
    wake: Mutex<Option<SyncSender<()>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    backend: Mutex<Option<(Value, Lease)>>,
}
impl InstallSessions {
    pub fn new(app: tauri::AppHandle) -> Self {
        let model = Arc::new(Sessions::default());
        let state = model.clone();
        let (tx, rx) = sync_channel(1);
        let worker = std::thread::spawn(move || {
            while rx.recv().is_ok() {
                std::thread::sleep(Duration::from_millis(120));
                while rx.try_recv().is_ok() {}
                for (channel, snapshot) in state.take_events() {
                    if channel == "install-session.finished" {
                        let paths = &app.state::<crate::settings::Settings>().paths;
                        if snapshot["origin"] == "startup" && snapshot["status"] == "completed" {
                            if let Err(error) =
                                gsm_settings::preferences::Preferences::new(&paths.active)
                                    .patch(&json!({"hasCompletedSetup":true}))
                            {
                                eprintln!("Could not save completed setup: {error}");
                            }
                        }
                        if let Err(error) = gsm_settings::write_atomic(
                            &paths.active.join("logs/install-session.log"),
                            &snapshot,
                        ) {
                            eprintln!("Could not save installation diagnostics: {error}");
                        }
                    }
                    let encoded = json!({"channel":channel,"payload":snapshot}).to_string();
                    for label in crate::desktop_state::desktop_window_labels(&app) {
                        let _ = app.emit_to(&label, "installation-session", encoded.clone());
                    }
                }
            }
        });
        Self {
            model,
            wake: Mutex::new(Some(tx)),
            worker: Mutex::new(Some(worker)),
            backend: Mutex::new(None),
        }
    }
    pub fn notify(&self) {
        if let Some(tx) = self.wake.lock().unwrap().as_ref() {
            let _ = tx.try_send(());
        }
    }
    pub fn shutdown(&self) {
        self.wake.lock().unwrap().take();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}
pub async fn retry(app: &tauri::AppHandle, _label: &str, expected: Lease) -> Value {
    let state = app.state::<InstallSessions>();
    let claim = match state.model.claim_retry(&expected) {
        Ok(claim) => claim,
        Err(error) => return json!({"success":false,"error":error}),
    };
    state.notify();
    let lease: Lease = serde_json::from_value(claim["lease"].clone()).unwrap();
    if let Some(target) = claim["target"].as_str().filter(|t| t.starts_with("native:")) {
        let ticket = claim["ticket"].as_str().unwrap_or_default();
        if state.model.accept_retry(ticket) {
            tauri::async_runtime::spawn(crate::python_ops::execute_native_retry(
                app.clone(),
                target.to_owned(),
                lease,
            ));
            return json!({"success":true});
        }
        return json!({"success":false,"error":"The installation retry ticket expired."});
    }
    let error = "Unsupported installation retry target.";
    let accepted = state.model.cancel_unaccepted_retry(&lease, error);
    state.notify();
    if accepted {
        json!({"success":true})
    } else {
        json!({"success":false,"error":error})
    }
}
pub fn observe(app: &tauri::AppHandle, event: &str, message: &Value) {
    let state = app.state::<InstallSessions>();
    if event == "process.spawned" && message["id"] == "backend" {
        let lifetime=crate::backend::snapshot(app);
        let lease=if lifetime["processRunId"]==message["runId"] {
            serde_json::from_value::<Option<Lease>>(lifetime["session"].clone()).ok().flatten()
        } else { state.model.lease() };
        *state.backend.lock().unwrap() = lease.map(|lease| (message["runId"].clone(), lease));
        return;
    }
    let Some((run, lease)) = state.backend.lock().unwrap().clone() else {
        return;
    };
    if event == "process.log" && message["id"] == "backend" && message["runId"] == run {
        state.model.append(
            &lease,
            &json!({"source":"python","stream":message["stream"],"message":message["message"]}),
        );
        state.notify();
    }
    if event != "bus.message"
        || message["src"] != "backend"
        || message["topic"] != "backend.event"
        || message["kind"] != "event"
    {
        return;
    }
    let data = &message["data"]["data"];
    match message["data"]["function"].as_str() {
        Some("install_progress") => {
            if data["session_id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && id != lease.session_id)
            {
                return;
            }
            let mut update = json!({});
            for (from, to) in [
                ("stage_id", "stageId"),
                ("status", "status"),
                ("progress_kind", "progressKind"),
                ("progress", "progress"),
                ("message", "message"),
                ("downloaded_bytes", "downloadedBytes"),
                ("total_bytes", "totalBytes"),
                ("error", "error"),
            ] {
                if let Some(value) = data.get(from) {
                    update[to] = value.clone();
                }
            }
            let _ = state.model.update(&lease, &update);
        }
        Some("initialized") => {
            let _ = state.model.update(&lease, &json!({"stageId":"backend_boot","status":"completed","progressKind":"estimated","message":"GSM backend is running."}));
            let _ = state.model.update(&lease, &json!({"stageId":"finalize","status":"completed","progressKind":"estimated","message":"Setup complete."}));
            let _ = state
                .model
                .finish(&lease, "completed", Some("Setup complete."), None);
        }
        _ => return,
    }
    state.notify();
}
