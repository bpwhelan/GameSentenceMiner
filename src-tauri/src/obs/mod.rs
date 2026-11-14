//! OBS ownership lives here: supervision, storage, installation, scene policy and devices.
//! Node's remaining application services may call this API, but are never a fallback.
mod config;
mod process;
mod runtime;
mod scenes;
mod switcher;
use crate::obs_service::ObsService;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::Mutex as AsyncMutex;
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn first(args: &[Value]) -> Value {
    args.first().cloned().unwrap_or(Value::Null)
}
#[derive(Default)]
struct State {
    paths: Option<config::Paths>,
    coordinate_clients: bool,
    launch_status: String,
    pid: Option<u32>,
    switcher: switcher::Switcher,
    runtime: runtime::Runtime,
    probe_enabled: bool,
    probes_clean: bool,
    devices: Option<(Instant, Value)>,
}
#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    client: ObsService,
    connecting: AsyncMutex<()>,
    lifecycle: AsyncMutex<()>,
    probe: AsyncMutex<()>,
    scene_edit: AsyncMutex<()>,
    suspended_clients: Mutex<(bool, bool)>,
    updating: AtomicBool,
    suspended: AtomicBool,
    started: AtomicBool,
}
#[derive(Clone, Default)]
pub struct Obs(Arc<Inner>);
impl Obs {
    fn paths(&self) -> Result<config::Paths, String> {
        self.0
            .state
            .lock()
            .unwrap()
            .paths
            .clone()
            .ok_or("OBS service has not been initialized".into())
    }
    pub fn ui_settings(&self) -> Result<Value, String> {
        let data = config::read_json(&self.paths()?.base.join("electron/config.json"))?;
        Ok(
            json!({"locale":data["locale"],"theme":data["theme"],"seasonalEffectsDisabled":data["seasonalEffectsDisabled"]}),
        )
    }
    pub fn settings(&self) -> Result<Value, String> {
        config::read_json(&self.paths()?.desktop())
    }
    pub fn startup_config(&self) -> Result<Value, String> {
        let paths = self.paths()?;
        let settings = paths.settings()?;
        let (address, password) = paths.connection()?;
        let url = url::Url::parse(&address).map_err(err)?;
        let command = settings["obs_path"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| paths.executable().to_string_lossy().into_owned());
        Ok(
            json!({"host":url.host_str(),"port":url.port().unwrap_or(7274),"password":password,"openObs":settings["open_obs"]!=false,"closeObs":settings["close_obs"]!=false,"disableRecording":settings["disable_recording"]==true,"allowAutomaticUpdates":settings["allow_automatic_updates"]==true,"obsPath":command}),
        )
    }
    pub fn state(&self) -> Value {
        let state = self.0.state.lock().unwrap();
        json!({"connected":self.0.client.has_primary(),"updating":self.0.updating.load(Ordering::SeqCst),"launchStatus":state.launch_status})
    }
    pub fn initialize(&self, app: &tauri::AppHandle, params: Value) -> Result<Value, String> {
        let paths = config::Paths {
            base: text(&params, "baseDir").into(),
            recordings: text(&params, "recordingsDir").into(),
            policy: text(&params, "policyPath").into(),
        };
        if !paths.base.is_absolute()
            || !paths.recordings.is_absolute()
            || !paths.policy.is_absolute()
        {
            return Err("OBS paths must be absolute".into());
        }
        {
            let mut state = self.0.state.lock().unwrap();
            if let Some(existing) = &state.paths {
                if existing.base != paths.base {
                    return Err("OBS data directory cannot change while running".into());
                }
            } else {
                paths.import_settings()?;
                state.paths = Some(paths);
                state.coordinate_clients = params["coordinateClients"] == true;
            }
        }
        if !self.0.started.swap(true, Ordering::SeqCst) {
            let controller = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                controller.maintain(app).await;
            });
        }
        Ok(self.state())
    }
    fn emit(&self, app: &tauri::AppHandle, event: &str, data: Value) {
        if event == "obs.sceneChanged" {
            let scene_id = data["id"].as_str().unwrap_or("").to_owned();
            let scene_name = data["name"].as_str().unwrap_or("").to_owned();
            crate::auto_launcher::notify_scene_changed(app, &scene_id, &scene_name);
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::game_privileges::refresh_capture(&app_handle).await;
                crate::game_background::refresh_async(&app_handle);
            });
        }
        crate::desktop_state::emit_to_desktop_windows(app, event, &[data]);
    }
    async fn ensure_connection(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.0.client.has_primary() {
            return Ok(());
        }
        let _guard = self.0.connecting.lock().await;
        if self.0.client.has_primary() {
            return Ok(());
        }
        if self.0.suspended.load(Ordering::SeqCst) {
            return Err("OBS is being updated or closed".into());
        }
        let (url, password) = self.paths()?.connection()?;
        let controller = self.clone();
        let event_app = app.clone();
        let events = Arc::new(move |name: &str, data: Value| {
            if name == "CurrentProgramSceneChanged" {
                controller.scene_event(&event_app, &data);
            }
            if name == "CurrentSceneCollectionChanged" {
                controller
                    .0
                    .state
                    .lock()
                    .unwrap()
                    .switcher
                    .collection
                    .clear();
                controller.0.state.lock().unwrap().devices = None;
            }
            if name == "ConnectionClosed" {
                controller.0.state.lock().unwrap().devices = None;
                controller.emit(&event_app, "obs.connection", json!(false));
            }
        });
        // Disconnect a timed-out actor before replacing it. Never resend scene mutations.
        let _ = self.0.client.disconnect_primary().await;
        self.0
            .client
            .connect(
                uuid::Uuid::new_v4().to_string(),
                url,
                password,
                true,
                events,
            )
            .await
            .map_err(|e| e.message)?;
        {
            let mut state = self.0.state.lock().unwrap();
            state.switcher.connected_at = Some(Instant::now());
            state.probes_clean = false;
            state.switcher.collection.clear();
        }
        self.emit(app, "obs.connection", json!(true));
        Ok(())
    }
    async fn call(
        &self,
        app: &tauri::AppHandle,
        method: &str,
        data: Value,
    ) -> Result<Value, String> {
        self.ensure_connection(app).await?;
        self.0
            .client
            .primary_call(method, data)
            .await
            .map_err(|e| format!("OBS {}: {} ({})", method, e.message, e.code))
    }
    async fn maintain(self, app: tauri::AppHandle) {
        let mut backoff = 1;
        let mut next_connect = Instant::now();
        let mut heartbeat = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if self.0.suspended.load(Ordering::SeqCst) || self.0.updating.load(Ordering::SeqCst) {
                continue;
            }
            if !self.0.client.has_primary() {
                if Instant::now() < next_connect {
                    continue;
                }
                if self.ensure_connection(&app).await.is_err() {
                    next_connect = Instant::now() + Duration::from_secs(backoff);
                    backoff = (backoff * 2).min(30);
                    continue;
                }
                backoff = 1;
                heartbeat = Instant::now();
            }
            if heartbeat.elapsed() > Duration::from_secs(30) {
                if self.call(&app, "GetVersion", json!({})).await.is_err() {
                    let _ = self.0.client.disconnect_primary().await;
                    continue;
                }
                heartbeat = Instant::now();
            }
            let needs_cleanup = !self.0.state.lock().unwrap().probes_clean;
            if needs_cleanup {
                let _ = self.cleanup_helpers(&app).await;
            }
            if let Err(error) = self.tick_switcher(&app).await {
                eprintln!("[OBS scene switcher] {error}");
            }
        }
    }
    async fn ready(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            match self.call(app, "GetSceneList", json!({})).await {
                Ok(_) => return Ok(()),
                Err(error) => {
                    if Instant::now() >= until {
                        return Err(error);
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }
    fn running_pid(&self, paths: &config::Paths) -> Result<Option<u32>, String> {
        let (executable, _) = match paths.launch_command(false) {
            Ok(command) => command,
            Err(_) => return Ok(None),
        };
        let remembered = self.0.state.lock().unwrap().pid.or_else(|| {
            std::fs::read_to_string(paths.base.join("obs_pid.txt"))
                .ok()?
                .trim()
                .parse()
                .ok()
        });
        process::find(&executable, remembered)
    }
    async fn launch(&self, app: &tauri::AppHandle, options: Value) -> Result<Value, String> {
        let _guard = self.0.lifecycle.lock().await;
        self.launch_inner(app, options).await
    }
    async fn launch_inner(&self, app: &tauri::AppHandle, options: Value) -> Result<Value, String> {
        let paths = self.paths()?;
        let settings = paths.settings()?;
        if settings["open_obs"] == false && options["ignoreOpenConfig"] != true {
            return Ok(json!({"status":"skipped"}));
        }
        let command = paths.launch_command(options["allowPathFallback"] == true);
        let (executable, mut args) = match command {
            Ok(c) => c,
            Err(error) => {
                self.0.state.lock().unwrap().launch_status = "missing".into();
                return Ok(json!({"status":"missing","error":error}));
            }
        };
        let remembered = self.0.state.lock().unwrap().pid;
        if let Some(pid) = process::find(&executable, remembered)? {
            let migration = self.migration_pending(&paths)?;
            if options["forceRestart"] != true
                && (!migration || self.assert_idle(app).await.is_err())
            {
                self.0.state.lock().unwrap().launch_status = "already-running".into();
                return Ok(json!({"status":"already-running","pid":pid}));
            }
            self.close_inner(app, json!({"ignoreCloseConfig":true}))
                .await?;
        }
        paths.seed()?;
        if paths.managed()? {
            paths.snapshot("before OBS startup and scene-switcher migration")?;
            self.migrate(&paths)?;
            for name in [
                ".sentinel",
                "plugin_config/advanced-scene-switcher/.running",
            ] {
                let file = paths.obs().join(name);
                if file.is_file() {
                    std::fs::remove_file(file).map_err(err)?;
                }
            }
            paths.prepare_port()?;
        }
        args.extend(["--disable-shutdown-check".into(), "--portable".into()]);
        if settings["allow_automatic_updates"] != true {
            args.push("--disable-updater".into());
        }
        let pid = process::start(&executable, &args)?;
        config::atomic_write(&paths.base.join("obs_pid.txt"), pid.to_string().as_bytes())?;
        {
            let mut state = self.0.state.lock().unwrap();
            state.pid = Some(pid);
            state.launch_status = "launched".into();
        }
        self.0.suspended.store(false, Ordering::SeqCst);
        Ok(json!({"status":"launched","pid":pid}))
    }
    async fn assert_idle(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let record = self.call(app, "GetRecordStatus", json!({})).await?;
        let stream = self.call(app, "GetStreamStatus", json!({})).await?;
        if record["outputActive"] != false || stream["outputActive"] != false {
            return Err("Stop recording or streaming before updating OBS".into());
        }
        Ok(())
    }
    async fn close_inner(&self, app: &tauri::AppHandle, options: Value) -> Result<Value, String> {
        let result = self.close_inner_impl(app, options).await;
        if result.is_err() {
            self.0.suspended.store(false, Ordering::SeqCst);
        }
        return result;
    }
    async fn close_inner_impl(
        &self,
        app: &tauri::AppHandle,
        options: Value,
    ) -> Result<Value, String> {
        let paths = self.paths()?;
        let settings = paths.settings()?;
        if settings["close_obs"] == false && options["ignoreCloseConfig"] != true {
            return Ok(json!({"status":"skipped"}));
        }
        let Some(pid) = self.running_pid(&paths)? else {
            return Ok(json!({"status":"not-running"}));
        };
        let (executable, _) = paths.launch_command(false)?;
        if self.call(app, "GetStreamStatus", json!({})).await?["outputActive"] != false {
            return Err("Stop streaming before closing OBS".into());
        }
        // Keep automatic selection and recovery out of output finalization.
        // The existing connection remains available to controlled shutdown.
        self.0.suspended.store(true, Ordering::SeqCst);
        for (status, stop) in [
            ("GetRecordStatus", "StopRecord"),
            ("GetReplayBufferStatus", "StopReplayBuffer"),
        ] {
            match self.call(app, status, json!({})).await {
                Ok(value) if value["outputActive"] == true => {
                    match self.call(app, stop, json!({})).await {
                        Ok(_) => {}
                        Err(error) if error.ends_with("(501)") => {}
                        Err(error) => return Err(error),
                    }
                }
                Ok(value) if value["outputActive"] == false => {}
                Err(error) if status == "GetReplayBufferStatus" && error.ends_with("(604)") => {}
                Err(error) => return Err(error),
                _ => return Err("Could not confirm OBS output state".into()),
            }
        }
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            let record = self.call(app, "GetRecordStatus", json!({})).await?;
            let replay = self.call(app, "GetReplayBufferStatus", json!({})).await;
            let replay_stopped = match replay {
                Ok(v) => v["outputActive"] == false,
                Err(e) if e.ends_with("(604)") => true,
                Err(e) => return Err(e),
            };
            if record["outputActive"] == false && replay_stopped {
                break;
            }
            if Instant::now() >= until {
                return Err("OBS outputs did not stop".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        paths.snapshot("before OBS shutdown")?;
        self.0.suspended.store(true, Ordering::SeqCst);
        let result = process::close(pid, &executable).await;
        if let Err(error) = result {
            self.0.suspended.store(false, Ordering::SeqCst);
            return Err(error);
        }
        self.0
            .client
            .disconnect_primary()
            .await
            .map_err(|e| e.message)?;
        {
            let mut state = self.0.state.lock().unwrap();
            state.pid = None;
            state.launch_status = "closed".into();
        }
        let _ = std::fs::remove_file(paths.base.join("obs_pid.txt"));
        paths.snapshot("after OBS shutdown")?;
        self.emit(app, "obs.connection", json!(false));
        Ok(json!({"status":"closed","pid":pid}))
    }
    pub async fn invoke(
        &self,
        app: &tauri::AppHandle,
        channel: &str,
        args: &[Value],
    ) -> Result<Value, String> {
        let arg = first(args);
        if self.0.updating.load(Ordering::SeqCst)
            && matches!(
                channel,
                "obs.connect"
                    | "obs.saveReplay"
                    | "obs.startRecording"
                    | "obs.switchScene"
                    | "obs.switchScene.id"
                    | "obs.createScene"
                    | "obs.createScene.Game"
                    | "obs.renameScene"
                    | "obs.removeScene"
                    | "obs.switchSceneCaptureMode"
            )
        {
            return Err("Wait for the OBS update to finish".into());
        }
        match channel {
            "obs.state" => Ok(self.state()),
            "obs.connect" => {
                self.0.suspended.store(false, Ordering::SeqCst);
                self.ensure_connection(app).await?;
                Ok(Value::Null)
            }
            "obs.ready" => {
                self.ready(app).await?;
                Ok(Value::Null)
            }
            "obs.ensureInstalled" => self.ensure_installed(app).await,
            "obs.ensureInstalledAndLaunch" => {
                let installed = self.ensure_installed(app).await?;
                if installed == "failed" {
                    return Err("OBS installation failed".into());
                }
                self.launch(app, arg).await
            }
            "obs.launch" | "openOBS" | "obs.launchManaged" => {
                let options = if channel == "obs.launchManaged" {
                    arg
                } else {
                    json!({"ignoreOpenConfig":true,"allowPathFallback":true})
                };
                let result = self.launch(app, options).await?;
                if channel == "openOBS" {
                    if let Some(pid) = result["pid"].as_u64() {
                        process::show(pid as u32)?;
                    }
                }
                Ok(result)
            }
            "obs.close" => {
                let _guard = self.0.lifecycle.lock().await;
                self.close_inner(app, arg).await
            }
            "obs.runtime.wait" => {
                let _guard = self.0.lifecycle.lock().await;
                Ok(Value::Null)
            }
            "obs.runtime.status" => self.runtime_status(),
            "obs.runtime.check" => {
                let _guard = self.0.lifecycle.lock().await;
                self.check_release(app).await?;
                self.runtime_status()
            }
            "obs.runtime.update" | "obs.runtime.rollback" => {
                self.update_runtime(app, channel.ends_with("rollback"))
                    .await
            }
            "obs.runtime.setAutomatic" => {
                let _lock = config::SETTINGS_LOCK.lock().unwrap();
                let enabled = arg
                    .as_bool()
                    .ok_or("OBS automatic updates must be true or false")?;
                let paths = self.paths()?;
                let mut data = config::read_json(&paths.desktop())?;
                data["autoUpdateOBS"] = json!(enabled);
                config::write_json(&paths.desktop(), &data)?;
                self.runtime_status()
            }
            channel if channel.starts_with("scene-switcher.") => {
                self.switcher_command(app, channel, arg).await
            }
            _ => self.scene_command(app, channel, arg).await,
        }
    }

    pub(crate) async fn capture_identity_for_scene(
        &self,
        app: &tauri::AppHandle,
        requested_scene_id: Option<&str>,
    ) -> Option<(String, String, String)> {
        let scene_id = match requested_scene_id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => id.to_owned(),
            None => self.current_scene(app).await.ok()?["id"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_owned(),
        };
        let (title, exe) = self.source_identity(app, &scene_id).await.ok()?;
        Some((scene_id, title, exe))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_install_has_no_running_process_and_can_reach_download() {
        let f = config::tests::Fixture::new();
        let controller = Obs::default();
        controller.0.state.lock().unwrap().paths = Some(f.0.clone());
        assert_eq!(controller.running_pid(&f.0).unwrap(), None);
    }
}
