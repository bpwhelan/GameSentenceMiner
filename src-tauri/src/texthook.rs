//! Private application-service adapter for `gsm-texthook`.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}};
use tauri::Manager;

#[derive(Default)]
pub struct TextHook { controller: Mutex<Option<Arc<gsm_texthook::Controller>>>, generation: Arc<AtomicU64>, transition: Arc<Mutex<()>> }
impl TextHook {
    pub fn is_running(&self)->bool {self.controller.lock().unwrap().as_ref().is_some_and(|controller|controller.request("status",json!({})).map(|v|v["running"]==true).unwrap_or(true))}
    pub fn generation(&self) -> u64 { self.generation.load(Ordering::SeqCst) }
    pub fn controller(&self, app: &tauri::AppHandle) -> Arc<gsm_texthook::Controller> {
        let mut current = self.controller.lock().unwrap();
        current
            .get_or_insert_with(|| {
                let app = app.clone();
                Arc::new(gsm_texthook::Controller::new(move |event, mut data| {
                    if event == "texthook.output" { crate::runtime::observe_hook(&app, data.clone()); data["nativeIngress"] = json!(true); }
                    crate::texthook_coordinator::on_texthook_event(&app, event, data);
                }))
            })
            .clone()
    }
    pub fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(controller) = self.controller.lock().unwrap().take() {
            controller.shutdown();
        }
    }
}
pub async fn dispatch(app: &tauri::AppHandle, params: Value) -> Result<Value, String> {
    if params["action"] == "processes" {
        return tauri::async_runtime::spawn_blocking(gsm_texthook::list_processes)
            .await
            .map_err(|e| e.to_string())?;
    }
    if params["action"] == "processInfo" {
        let pid = params["params"]["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= u32::MAX as u64)
            .ok_or("Invalid process PID")? as u32;
        return tauri::async_runtime::spawn_blocking(move || gsm_texthook::process_info(pid))
            .await
            .map_err(|e| e.to_string())?;
    }
    let state = app.state::<TextHook>();
    let controller = state.controller(app);
    let generation = state.generation.clone();
    let transition = state.transition.clone();
    let action = params["action"].as_str().unwrap_or("").to_owned();
    let attachment = if action=="start" {Some(app.state::<crate::hook_updates::HookUpdates>().get(app).lease()?)}else{None};
    let serial = if action == "start" || action == "stop" { generation.fetch_add(1, Ordering::SeqCst) + 1 } else { generation.load(Ordering::SeqCst) };
    let executable = crate::agent::helper_path(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _attachment = attachment;
        let mut args = params["params"].clone();
        if action == "start" && !args["wineLaunch"].is_null() {
            args["attachPid"] = json!(gsm_agent::wine_bridge::resolve(&executable, &args, || generation.load(Ordering::SeqCst) != serial)?);
        }
        let _transition = transition.lock().unwrap();
        if (action == "start" || action == "stop") && generation.load(Ordering::SeqCst) != serial { return Err("Text hook operation cancelled".into()); }
        controller.request(&action, args)
    }).await.map_err(|e| e.to_string())?
}
