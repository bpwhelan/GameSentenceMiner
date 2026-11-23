//! The remaining application service is a client of this native runtime.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::Manager;
#[derive(Clone, Default)]
pub struct Runtime(Arc<Mutex<Option<Arc<gsm_runtime::Runtime>>>>);
pub fn get(app: &tauri::AppHandle) -> Result<Arc<gsm_runtime::Runtime>, String> {
    app.state::<Runtime>().0.lock().unwrap().clone().ok_or("The native runtime has not started".into())
}
impl Runtime {
    pub fn shutdown(&self) {
        let runtime = self.0.lock().unwrap().take();
        if let Some(runtime) = runtime {
            runtime.shutdown();
        }
    }
}
pub async fn dispatch(app: &tauri::AppHandle, params: Value) -> Result<Value, String> {
    let action = params["action"].as_str().unwrap_or("");
    // A launch must not race an environment replacement or dependency sync.
    let _install_guard = if action == "process.start" {
        Some(app.state::<crate::python_install::PythonInstall>().gate.clone().try_lock_owned()
            .map_err(|_| "Python environment maintenance is in progress")?)
    } else { None };
    let args = params["params"].clone();
    let state = app.state::<Runtime>();
    if action == "bus.stop" {
        let runtime = state.0.lock().unwrap().take();
        if let Some(runtime) = runtime {
            tauri::async_runtime::spawn_blocking(move || runtime.shutdown())
                .await
                .map_err(|e| e.to_string())?;
        }
        return Ok(Value::Null);
    }
    let runtime = {
        let mut current = state.0.lock().unwrap();
        if current.is_none() && action == "bus.start" {
            let app = app.clone();
            *current = Some(Arc::new(gsm_runtime::Runtime::start(
                args.clone(),
                move |event, data| {
                    if data["id"] == "backend" {
                        if matches!(event, "bus.connected" | "bus.disconnected") {
                            let epoch = (event == "bus.connected").then(|| data["epoch"].as_u64()).flatten();
                            app.state::<crate::text_intake::Intake>().connection(&app,epoch);
                            app.state::<crate::anki_sync::SyncLane>().connection(epoch);
                            app.state::<crate::anki_poll::monitor::Monitor>().connection(epoch);
                        }
                        match event {
                            "bus.connected" => app.state::<crate::cron::Scheduler>().connection(data["epoch"].as_u64()),
                            "bus.disconnected" => app.state::<crate::cron::Scheduler>().connection(None),
                            "process.exit" => app.state::<crate::cron::Scheduler>().forget_backend(),
                            _ => {}
                        }
                    }
                    if event == "bus.disconnected" && data["id"] == "backend" {
                        if let Some(mining) = app.try_state::<Arc<crate::mining::MiningService>>() {
                            mining.clear_upstreams();
                        }
                        let desktop = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = desktop.state::<crate::word_index::WordIndex>().flush().await;
                            let _ = tauri::async_runtime::spawn_blocking(move || {
                                if crate::database_startup::close_history(&desktop).is_ok() {
                                    let _ = desktop.state::<crate::cron::Scheduler>().refresh_generation();
                                }
                            }).await;
                        });
                    }
                    if event == "process.exit" {
                        if data["id"] == "backend" {
                            app.state::<crate::anki_poll::Notes>().backend_exited();
                        }
                    }
                    if event == "process.exit" || (event == "bus.message" && data["src"] == "qt-settings") {
                        app.state::<crate::gui_dialog::DialogHost>().observe(event, &data);
                    }
                    crate::backend::observe(&app, event, &data);
                    crate::python_ops::observe_runtime_event(&app, event, &data);
                    crate::mining_workspace::observe(&app, event, &data);
                    crate::install_session::observe(&app, event, &data);
                    crate::active_game::observe(&app, event, &data);
                    if event == "text.ack" && data["payload"]["_nativeHook"] == true {
                        preview(&app, &data);
                    }
                    crate::app_lifecycle::on_runtime_event(&app, event, &data);
                },
            )?));
        }
        current
            .clone()
            .ok_or("The native runtime has not started")?
    };
    if action == "bus.start" {
        return Ok(runtime.info());
    }
    runtime.call(action, args).await
}

pub async fn backend_command(app: &tauri::AppHandle, function: &str, data: Value) -> Result<bool, String> {
    app.state::<Runtime>().backend_command(function, data).await
}

impl Runtime {
    pub async fn backend_command(&self, function: &str, data: Value) -> Result<bool, String> {
        let runtime = self.0.lock().unwrap().clone();
        match runtime {
            Some(runtime) => runtime.call("backend.command", json!({"function":function,"data":data})).await
                .map(|value| value == true),
            None => Ok(false),
        }
    }
}

pub async fn has_live_processes(app:&tauri::AppHandle)->Result<bool,String>{
    let runtime=app.state::<Runtime>().0.lock().unwrap().clone();
    let Some(runtime)=runtime else{return Ok(false)};
    for id in runtime.call("process.list",json!({})).await?.as_array().into_iter().flatten(){
        let state=runtime.call("process.state",json!({"id":id})).await?;
        if state["pid"].as_u64().is_some()||matches!(state["state"].as_str(),Some("starting"|"restarting"|"stopping")){return Ok(true);}
    }Ok(false)
}

/// Hook output travels directly from native capture to native delivery. The
/// application service only receives the resulting preview notification.
pub fn observe_hook(app: &tauri::AppHandle, mut payload: Value) {
    let Some(runtime) = app.state::<Runtime>().0.lock().unwrap().clone() else {
        return;
    };
    let hook = payload["hookId"].as_str().unwrap_or("");
    let engine = payload["engine"].as_str().unwrap_or("hook").to_owned();
    let exe = payload["exeName"].as_str().unwrap_or("");
    let source = if hook.is_empty() {
        format!("{engine}:{exe}")
    } else {
        hook.to_owned()
    };
    let display = [
        engine.to_owned(),
        exe.to_owned(),
        if hook.is_empty() {
            String::new()
        } else {
            format!("#{hook}")
        },
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    payload["source"] = json!("texthook");
    payload["sourceInstance"] = json!(source);
    payload["sourceDisplayName"] = json!(display);
    payload["revisionWindowMs"] = json!(0);
    payload["mergeFragments"] = json!(false);
    payload["_nativeHook"] = json!(true);
    if engine != "agent" {
        payload["_hookGeneration"] = json!(app.state::<crate::texthook::TextHook>().generation());
    }
    if let Some(raw_text) = payload["text"].as_str() {
        let max_buf = app
            .try_state::<crate::texthook_coordinator::TexthookCoordinator>()
            .map(|c| c.get_max_buffer_size(&crate::desktop_services::paths_for(app).active))
            .unwrap_or(500);
        let Some((sanitized, _truncated)) =
            crate::texthook_coordinator::sanitize_texthook_text(raw_text, max_buf)
        else {
            return;
        };
        payload["text"] = json!(sanitized);
    }
    let result = runtime.submit_text(payload);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match result {
            Ok(reply) => reply
                .await
                .map_err(|_| "Native runtime closed".to_owned())
                .and_then(|r| r),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            crate::texthook_coordinator::on_texthook_log_error(&app, &error);
        }
    });
}
fn preview(app: &tauri::AppHandle, data: &Value) {
    let payload = &data["payload"];
    let ack = &data["ack"];
    if !ack["processed_text"].is_string() || !ack["raw_text"].is_string() {
        return;
    }
    if payload["engine"] == "agent" {
        if app.state::<crate::agent::Agent>().current_state()["status"]["sessionId"]
            != payload["sessionId"]
        {
            return;
        }
    } else if payload["_hookGeneration"].as_u64()
        != Some(app.state::<crate::texthook::TextHook>().generation())
    {
        return;
    } else {
        crate::texthook_coordinator::observe_hook_ack(app, payload, ack);
    }
    let processed = json!({
        "text": ack["processed_text"],
        "originalText": ack["raw_text"],
        "hookId": payload["hookId"],
        "sessionId": payload["sessionId"],
        "ts": payload["capturedAt"]
    });
    crate::texthook_coordinator::on_texthook_processed(app, processed.clone());
}
