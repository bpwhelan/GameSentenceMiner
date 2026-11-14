//! Agent desktop adapter: native helper ownership and a narrowly scoped script
//! control window. Game scripts never receive the desktop service credential.
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::Manager;
#[derive(Default)]
pub struct Agent(Mutex<Option<Arc<gsm_agent::Controller>>>);
impl Agent {
    pub fn current_state(&self) -> Value { self.0.lock().unwrap().as_ref().map(|controller| controller.state()).unwrap_or(Value::Null) }
    pub fn controller(&self, app: &tauri::AppHandle) -> Arc<gsm_agent::Controller> {
        self.0.lock().unwrap().get_or_insert_with(||{
            let app=app.clone();Arc::new(gsm_agent::Controller::new(move|event,mut data,detached|{
                if event=="agent.text" { crate::runtime::observe_hook(&app,data.clone()); data["nativeIngress"]=json!(true); }
                crate::texthook_coordinator::on_agent_event(&app,event,data.clone(),detached);
                if event=="agent-ui.rpc-event"{if let Some(id)=data["sessionId"].as_str(){if let Some(window)=app.get_webview_window(&format!("agent-ui-{id}")){let _=window.eval(&format!("window.__GSM_AGENT_EVENT__?.({data});"));}}}
                if event=="agent-ui.changed"{if let Some(id)=data["sessionId"].as_str(){if app.get_webview_window(&format!("agent-ui-{id}")).is_some(){let app=app.clone();tauri::async_runtime::spawn(async move{let _=show_ui(&app,true).await;});}}}
                if event=="texthook.status"&&data["running"]!=true{for(label,window)in app.webview_windows(){if label.starts_with("agent-ui-"){let _=window.close();}}}
            }))
        }).clone()
    }
    pub fn shutdown(&self) {
        if let Some(controller) = self.0.lock().unwrap().take() {
            controller.shutdown()
        }
    }
}
pub fn helper_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "gsm-agent-host.exe"
    } else {
        "gsm-agent-host"
    };
    let executable = if cfg!(debug_assertions) {
        std::env::current_exe()
            .map_err(|e| e.to_string())?
            .with_file_name(name)
    } else {
        app.state::<crate::desktop_state::DesktopState>()
            .app_root
            .join("native/gsm-agent")
            .join(name)
    };
    Ok(executable)
}
pub async fn dispatch(app: &tauri::AppHandle, params: Value) -> Result<Value, String> {
    let controller = app.state::<Agent>().controller(app);
    let action = params["action"].as_str().unwrap_or("").to_owned();
    let attachment = if action=="start" {Some(app.state::<crate::hook_updates::HookUpdates>().get(app).lease()?)}else{None};
    let mut args = params["params"].clone();
    if action == "showUi" {
        return show_ui(app, false).await.map(|_| json!({"success":true}));
    }
    let executable = helper_path(app)?;
    if action == "start" {
        args["root"] = json!(app.state::<crate::desktop_state::DesktopState>().app_root);
    }
    tauri::async_runtime::spawn_blocking(move || {let _attachment=attachment; match action.as_str() {
        "state" => Ok(controller.state()),
        "start" => controller.start(executable, args),
        "stop" => controller.stop(),
        "stopForUpdate" => controller.stop_for_update(
            args["baseDir"]
                .as_str()
                .ok_or("Missing Agent data directory")?,
        ),
        "reconnect" => controller
            .reconnect(
                args["baseDir"]
                    .as_str()
                    .ok_or("Missing Agent data directory")?,
            )
            .map(Value::Bool),
        "setFlushDelay" | "setCopyToClipboard" | "setMaxBufferSize" => {
            if controller.state()["status"].is_null() {
                Ok(json!({"success":true}))
            } else {
                controller.request(&action, &[args["value"].clone()])
            }
        }
        "rpcCall" | "rpcSend" => {
            controller.request(&action, &[args["func"].clone(), args["args"].clone()])
        }
        _ => Err(format!("Unknown Agent action: {action}")),
    }})
    .await
    .map_err(|e| e.to_string())?
}
async fn show_ui(app: &tauri::AppHandle, refresh: bool) -> Result<(), String> {
    let controller = app.state::<Agent>().controller(app);
    let content = tauri::async_runtime::spawn_blocking(move || controller.request("ui", &[]))
        .await
        .map_err(|e| e.to_string())??;
    let id = content["sessionId"]
        .as_str()
        .ok_or("Agent session has ended")?;
    let label = format!("agent-ui-{id}");
    let html = content["html"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("This Agent script does not provide a control window")?;
    let desktop = app.state::<crate::desktop_state::DesktopState>();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(&label);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let page = dir.join("index.html");
    fs::write(&page, html).map_err(|e| e.to_string())?;
    desktop.assets.mount(&label, &dir)?;
    let url = desktop.assets.url(
        url::Url::from_file_path(page)
            .map_err(|_| "Invalid Agent UI path")?
            .as_str(),
    )?;
    if let Some(window) = app.get_webview_window(&label) {
        if refresh {
            window.navigate(url).map_err(|e| e.to_string())?;
        } else {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if refresh {
        return Ok(());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let preload = include_str!("../preloads/agent_preload.js")
        .replace("__GSM_AGENT_TOKEN__", &json!(token).to_string())
        .replace("__GSM_AGENT_SESSION__", &json!(id).to_string());
    desktop.register_window_with_token(&label, "agent-ui", token);
    let title = PathBuf::from(content["scriptPath"].as_str().unwrap_or("Agent"));
    let title = title.file_name().unwrap_or_default().to_string_lossy();
    let origin = url.origin();
    let prefix = format!("/{label}/");
    let window = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
        .title(format!("Agent UI - {title}"))
        .inner_size(800., 720.)
        .min_inner_size(800., 500.)
        .initialization_script(preload)
        .on_navigation(move |url| url.origin() == origin && url.path().starts_with(&prefix))
        .build()
        .map_err(|e| e.to_string())?;
    let app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(desktop) = app.try_state::<crate::desktop_state::DesktopState>() {
                desktop.unregister_window(&label);
                desktop.assets.unmount(&label);
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn agent_ui_call(
    window: tauri::WebviewWindow,
    token: String,
    session: String,
    method: String,
    func: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    crate::authorize(&window, &token)?;
    if window.label() != format!("agent-ui-{session}")
        || !matches!(method.as_str(), "rpcCall" | "rpcSend")
        || func.len() > 512
        || args.len() > 128
    {
        return Err("Invalid Agent script request".into());
    }
    let controller = window
        .app_handle()
        .state::<Agent>()
        .controller(window.app_handle());
    if controller.state()["status"]["sessionId"] != session {
        return Err("This Agent session has ended".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        controller.request_session(&session, &method, &[json!(func), json!(args)])
    })
    .await
    .map_err(|e| e.to_string())?
}
