use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct HookUpdates(Mutex<Option<Arc<gsm_packages::updates::Updater>>>);
impl HookUpdates {
    pub fn get(&self, app: &tauri::AppHandle) -> Arc<gsm_packages::updates::Updater> {
        self.0
            .lock()
            .unwrap()
            .get_or_insert_with(|| {
                let paths = app.state::<crate::settings::Settings>().paths.clone();
                let busy_app = app.clone();
                let event_app = app.clone();
                gsm_packages::updates::Updater::new(
                    gsm_packages::engines::Engines::new(&paths.shared),
                    gsm_settings::preferences::Preferences::new(&paths.active),
                    move || {
                        busy_app.state::<crate::texthook::TextHook>().is_running()
                            || busy_app.state::<crate::agent::Agent>().current_state()["status"]
                                ["running"]
                                == true
                    },
                    move |state| {
                        for label in crate::desktop_state::desktop_window_labels(&event_app) {
                            let _ = event_app.emit_to(label, "hook-updates", state.clone());
                        }
                    },
                )
            })
            .clone()
    }
    pub fn shutdown(&self) {
        if let Some(updater) = self.0.lock().unwrap().as_ref() {
            updater.shutdown();
        }
    }
}
pub async fn dispatch(app: &tauri::AppHandle, action: &str, args: Value) -> Result<Value, String> {
    let updater = app.state::<HookUpdates>().get(app);
    match action {
        "state" => Ok(updater.snapshot()),
        "start" => {
            updater.start();
            Ok(Value::Null)
        }
        "idle" => {
            updater.notify_idle();
            Ok(Value::Null)
        }
        "shutdown" => {
            updater.shutdown();
            Ok(Value::Null)
        }
        "reserve" => updater.reserve().map(|s| json!(s)),
        "release" => {
            updater.release(args["token"].as_str().ok_or("Missing attachment token")?);
            Ok(Value::Null)
        }
        "automatic" => updater.set_automatic(
            args.as_bool()
                .ok_or("Expected an automatic updates preference")?,
        ),
        "check" | "download" | "version" => {
            let reply = updater.spawn(action.to_owned(), args);
            tauri::async_runtime::spawn_blocking(move || reply.recv().map_err(|e| e.to_string()))
                .await
                .map_err(|e| e.to_string())?
        }
        _ => Err("Unknown native update operation".into()),
    }
}
