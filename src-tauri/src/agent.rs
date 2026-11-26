//! Agent desktop adapter: native helper ownership and a narrowly scoped script
//! control window. Game scripts never receive the desktop service credential.
use serde_json::{json, Value};
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
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
fn resolve_local_runtime_archive(
    helper: &Path,
    desktop: &Path,
    root: &Path,
    filename: &str,
    cargo_target_dir: Option<&OsStr>,
) -> PathBuf {
    let mut candidates = Vec::new();
    // Prefer the archive directory recorded when this build's helpers were staged so
    // launches without CARGO_TARGET_DIR in their environment still find the archive.
    if let Ok(recorded) = fs::read_to_string(helper.with_file_name("agent-runtime-dir.txt")) {
        let trimmed = recorded.trim();
        if !trimmed.is_empty() {
            let dir = PathBuf::from(trimmed);
            let dir = if dir.is_absolute() { dir } else { root.join(dir) };
            candidates.push(dir.join(filename));
        }
    }
    if let Some(target_dir) = cargo_target_dir.filter(|v| !v.is_empty()) {
        let dir = PathBuf::from(target_dir);
        let dir = if dir.is_absolute() { dir } else { root.join(dir) };
        candidates.push(dir.join("runtime").join(filename));
    }
    for ancestor in desktop.ancestors().skip(1).take(3) {
        candidates.push(ancestor.join("runtime").join(filename));
    }
    for relative in [
        "target/runtime",
        "src-tauri/target/native-dev/runtime",
        "native/gsm-agent/target/runtime",
    ] {
        candidates.push(root.join(relative).join(filename));
    }
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .unwrap_or_else(|| candidates.into_iter().next().unwrap())
}

/// Called on a blocking worker, only when a new Agent/Wine session needs Frida.
pub fn helper_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let name = "agent-runtime.json";
    let shared = &app.state::<crate::settings::Settings>().paths.shared;
    let runtime = gsm_packages::agent_runtime::AgentRuntime::new(shared);
    let executable = if crate::LOCAL_BUILD {
        let desktop = std::env::current_exe().map_err(|e| e.to_string())?;
        #[cfg(all(windows, any(debug_assertions, feature = "local-build")))]
        let helper = crate::dev_launch::helper_path(&desktop, name)?;
        #[cfg(not(all(windows, any(debug_assertions, feature = "local-build"))))]
        let helper = desktop.with_file_name(name);
        let manifest = gsm_packages::agent_runtime::Manifest::read(&helper)?;
        let root = &app.state::<crate::desktop_state::DesktopState>().app_root;
        let filename = manifest.archive.url.rsplit('/').next().ok_or("Missing runtime archive name")?;
        let archive = resolve_local_runtime_archive(
            &helper,
            &desktop,
            root,
            filename,
            std::env::var_os("CARGO_TARGET_DIR").as_deref(),
        );
        runtime.ensure_from_archive(&manifest, &archive).map_err(|error| {
            if !archive.is_file() {
                format!(
                    "Local Agent runtime archive not found at {} ({error}). Run `npm run build:helpers` or `npm run build:tauri`.",
                    archive.display()
                )
            } else {
                error
            }
        })?
    } else {
        let root = &app.state::<crate::desktop_state::DesktopState>().app_root;
        let manifest = gsm_packages::agent_runtime::Manifest::read(&root.join("native/agent-runtime.json"))?;
        if crate::PORTABLE_PREVIEW {
            return runtime.ensure_from_archive(&manifest, &root.join("native/agent-runtime.zip"));
        }
        let needs_download = !runtime.is_cached(&manifest);
        if needs_download {
            crate::desktop_state::emit_to_desktop_windows(
                app,
                "texthook.engineDownloadStarted",
                &[json!({ "engine": "agent" })],
            );
        }
        let progress = std::sync::atomic::AtomicU64::new(u64::MAX);
        let ensured = runtime.ensure(&manifest, &|bytes, total| {
            let percent = total.filter(|n| *n > 0).map(|n| bytes.saturating_mul(100) / n).unwrap_or(0).min(100);
            let step = percent / 10;
            if progress.swap(step, std::sync::atomic::Ordering::Relaxed) != step {
                crate::texthook_coordinator::on_agent_event(app, "texthook.log", json!({
                    "level":"info", "message":format!("[rust:agent] Downloading Agent / Frida runtime… {percent}%"),
                    "ts":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
                }), false);
            }
        });
        if needs_download {
            let payload = match &ensured {
                Ok(_) => json!({ "success": true }),
                Err(error) => json!({ "success": false, "error": error }),
            };
            crate::desktop_state::emit_to_desktop_windows(
                app,
                "texthook.engineDownloadComplete",
                &[payload],
            );
        }
        ensured?
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
    if action == "start" {
        args["root"] = json!(app.state::<crate::desktop_state::DesktopState>().app_root);
        args["sharedDir"] = json!(app.state::<crate::settings::Settings>().paths.shared);
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {let _attachment=attachment; match action.as_str() {
        "state" => Ok(controller.state()),
        "start" => controller.start_with(args, || helper_path(&app)),
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
    let preload = format!(
        "{}\n;{}",
        include_str!("../preloads/agent_preload.js")
            .replace("__GSM_AGENT_TOKEN__", &json!(token).to_string())
            .replace("__GSM_AGENT_SESSION__", &json!(id).to_string()),
        crate::overlay_preload::DISABLE_READER_SCOPE_JS
    );
    desktop.register_window_with_token(&label, "agent-ui", token);
    let title = PathBuf::from(content["scriptPath"].as_str().unwrap_or("Agent"));
    let title = title.file_name().unwrap_or_default().to_string_lossy();
    let origin = url.origin();
    let prefix = format!("/{label}/");
    let overlay_data = crate::dictionary_host::overlay_data_path(app);
    let builder = crate::dictionary_host::apply_shared_webview_options(
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
            .title(format!("Agent UI - {title}"))
            .inner_size(800., 720.)
            .min_inner_size(800., 500.)
            .initialization_script(preload)
            .on_navigation(move |url| url.origin() == origin && url.path().starts_with(&prefix)),
    );
    let window = crate::dictionary_host::apply_profile_data_directory(builder, &overlay_data)?
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

#[cfg(test)]
mod tests {
    use super::resolve_local_runtime_archive;
    use std::{ffi::OsStr, fs, path::PathBuf};

    #[test]
    fn resolves_local_runtime_archive_across_target_layouts() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let snapshot = root.join("src-tauri/target/desktop-runs/win32-x64-01234567890123456789");
        fs::create_dir_all(&snapshot).unwrap();
        let helper = snapshot.join("agent-runtime.json");
        let desktop = snapshot.join("gsm-desktop.exe");
        let filename = "gsm-agent-runtime-win32-x64-test.zip";

        let legacy = root.join("native/gsm-agent/target/runtime").join(filename);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"legacy").unwrap();
        assert_eq!(
            resolve_local_runtime_archive(&helper, &desktop, root, filename, None),
            legacy
        );

        let workspace = root.join("target/runtime").join(filename);
        fs::create_dir_all(workspace.parent().unwrap()).unwrap();
        fs::write(&workspace, b"workspace").unwrap();
        assert_eq!(
            resolve_local_runtime_archive(&helper, &desktop, root, filename, None),
            workspace
        );

        let dev_target = root.join("custom-dev-target");
        let dev_desktop = dev_target.join("debug/gsm-desktop.exe");
        let dev_archive = dev_target.join("runtime").join(filename);
        fs::create_dir_all(dev_archive.parent().unwrap()).unwrap();
        fs::write(&dev_archive, b"dev").unwrap();
        assert_eq!(
            resolve_local_runtime_archive(
                &dev_desktop.with_file_name("agent-runtime.json"),
                &dev_desktop,
                root,
                filename,
                None,
            ),
            dev_archive
        );

        let env_target = root.join("shared-target");
        let env_archive = env_target.join("runtime").join(filename);
        fs::create_dir_all(env_archive.parent().unwrap()).unwrap();
        fs::write(&env_archive, b"env").unwrap();
        assert_eq!(
            resolve_local_runtime_archive(
                &helper,
                &desktop,
                root,
                filename,
                Some(OsStr::new("shared-target")),
            ),
            env_archive
        );

        let recorded_dir = root.join("recorded-runtime");
        let recorded_archive = recorded_dir.join(filename);
        fs::create_dir_all(&recorded_dir).unwrap();
        fs::write(&recorded_archive, b"recorded").unwrap();
        fs::write(
            helper.with_file_name("agent-runtime-dir.txt"),
            format!("{}\n", recorded_dir.display()),
        )
        .unwrap();
        assert_eq!(
            resolve_local_runtime_archive(&helper, &desktop, root, filename, None),
            recorded_archive
        );

        let missing = "missing.zip";
        assert_eq!(
            resolve_local_runtime_archive(&helper, &desktop, root, missing, None),
            PathBuf::from(&recorded_dir).join(missing)
        );
    }
}
