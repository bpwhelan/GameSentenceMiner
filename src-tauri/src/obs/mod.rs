//! OBS ownership lives here: supervision, storage, installation, scene policy and devices.
//! Node's remaining application services may call this API, but are never a fallback.
mod backend;
mod area_frame;
#[cfg(windows)]
pub(crate) mod game_audio;
mod config;
mod outputs;
mod policy;
mod process;
pub(crate) mod game_pause;
mod runtime;
mod scenes;
mod session;
mod session_profile;
mod session_target;
mod switcher;
#[cfg(windows)]
mod window_events;
#[cfg(windows)]
mod window_input;
#[cfg(windows)]
mod window_state;
use crate::obs_service::{ObsError, ObsService};
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
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const RENDER_FAILURE_CONFIRM_INTERVAL: Duration = Duration::from_secs(5);
const RENDER_FAILURE_THRESHOLD: u8 = 2;
const RENDER_RESTART_COOLDOWN: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeartbeatOutcome {
    Healthy,
    Disconnected,
    RenderFailed,
}

fn classify_render_probe_result(result: &Result<Value, ObsError>) -> Option<HeartbeatOutcome> {
    match result {
        Ok(_) => Some(HeartbeatOutcome::Healthy),
        Err(error) if error.code == 702 => Some(HeartbeatOutcome::RenderFailed),
        // Scene was renamed/removed between cache read and probe; fall back to GetVersion.
        Err(error) if error.code == 600 => None,
        Err(_) => Some(HeartbeatOutcome::Disconnected),
    }
}

#[derive(Default)]
struct RenderHealthTracker {
    consecutive_failures: u8,
    last_restart: Option<Instant>,
}

impl RenderHealthTracker {
    fn heartbeat_interval(&self) -> Duration {
        if self.consecutive_failures > 0 && self.consecutive_failures < RENDER_FAILURE_THRESHOLD {
            RENDER_FAILURE_CONFIRM_INTERVAL
        } else {
            HEARTBEAT_INTERVAL
        }
    }

    fn record_healthy(&mut self) {
        self.consecutive_failures = 0;
    }

    fn reset(&mut self) {
        self.consecutive_failures = 0;
    }

    fn record_render_failure(&mut self, now: Instant) -> bool {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures < RENDER_FAILURE_THRESHOLD {
            return false;
        }
        if self
            .last_restart
            .is_some_and(|last| now.saturating_duration_since(last) < RENDER_RESTART_COOLDOWN)
        {
            return false;
        }
        true
    }

    fn record_restart(&mut self, now: Instant) {
        self.consecutive_failures = 0;
        self.last_restart = Some(now);
    }
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
    #[cfg(windows)]
    audio: Mutex<game_audio::Audio>,
    images: backend::Images,
    // A socket can finish closing after its replacement has opened. Serialize
    // the identity check and publication across the two socket actors.
    event_order: Mutex<()>,
    policy: Mutex<policy::ReplayPolicy>,
    session: session::Session,
    state: Mutex<State>,
    client: ObsService,
    connecting: AsyncMutex<()>,
    lifecycle: tokio::sync::RwLock<()>,
    recording: AsyncMutex<()>,
    probe: AsyncMutex<()>,
    scene_edit: AsyncMutex<()>,
    scene_switch_requested: tokio::sync::Notify,
    suspended_clients: Mutex<bool>,
    updating: AtomicBool,
    suspended: AtomicBool,
    shutting_down: AtomicBool,
    started: AtomicBool,
    replay_buffer_active: AtomicBool,
}
#[derive(Clone, Default)]
pub struct Obs(Arc<Inner>);
pub(crate) fn is_reader(client: &Value) -> bool {
    client
        .as_str()
        .and_then(|s| s.strip_prefix("obs-reader-"))
        .and_then(|pid| pid.parse::<u32>().ok())
        .is_some_and(|pid| pid != 0)
}
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
            #[cfg(windows)]
            if let Err(error) = window_events::start(app, self.clone()) {
                crate::desktop_log::warn(app, "window", error);
            }
            let sampler = self.clone();
            tauri::async_runtime::spawn(sampler.sample_session(app.clone()));
            #[cfg(windows)]
            tauri::async_runtime::spawn(self.clone().run_scene_switcher(app.clone()));
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
    pub(crate) async fn connection_settings_changed(&self) {
        let _guard = self.0.connecting.lock().await;
        let _ = self.0.client.disconnect_primary().await;
        self.refresh_session();
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
        let paths = self.paths()?;
        if std::env::var_os("GSM_SMOKE_TEST").is_some() && paths.settings()?["port"].is_null() {
            return Err("Smoke tests require an explicit OBS endpoint".into());
        }
        let (url, password) = paths.connection()?;
        let controller = self.clone();
        let event_app = app.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let event_id = id.clone();
        let (record_tx, mut record_rx) = tokio::sync::mpsc::channel(128);
        let record_app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(data) = record_rx.recv().await {
                let _ =
                    crate::runtime::backend_command(&record_app, "obs_record_event", data).await;
            }
        });
        let events = Arc::new(move |name: &str, data: Value| {
            let _order = controller.0.event_order.lock().unwrap();
            if name == "ConnectionOpened" {
                if controller.0.client.primary_id().as_deref() != Some(&event_id) {
                    return;
                }
                *controller.0.policy.lock().unwrap() = policy::ReplayPolicy::default();
                controller.0.session.connection(Some(&event_id), None);
                return;
            }
            if !controller.0.session.is_connection(&event_id) {
                return;
            }
            if matches!(name, "RecordStateChanged" | "RecordFileChanged") {
                if let Some(active) = data["outputActive"].as_bool() {
                    controller.0.session.record_state(&event_id, active, false);
                }
                if controller.longplay_event(&event_app,name,&data) {
                    return;
                }
                if let Err(error) = record_tx.try_send(json!({"event":name,"data":data})) {
                    crate::desktop_log::warn(
                        &event_app,
                        "obs",
                        format!("Could not deliver {name} to the subtitle writer: {error}"),
                    );
                }
                return;
            }
            match name {
                "CurrentProgramSceneChanged" => controller
                    .0
                    .session
                    .invalidate(Some((text(&data, "sceneName"), text(&data, "sceneUuid")))),
                "CurrentSceneCollectionChanged" | "ConnectionClosed" => {
                    controller.0.session.invalidate(Some(("", "")))
                }
                "SceneNameChanged"
                | "SceneItemCreated"
                | "SceneItemRemoved"
                | "SceneItemEnableStateChanged"
                    if controller.0.session.with_state(|s| {
                        data["sceneUuid"] == s["scene_id"]
                            || data["sceneName"] == s["scene"]
                            || data["oldSceneName"] == s["scene"]
                    }) =>
                {
                    controller.0.session.invalidate(None)
                }
                "InputSettingsChanged" | "InputNameChanged"
                    if controller.0.session.with_state(|s| {
                        data["inputName"] == s["source_name"]
                            || data["oldInputName"] == s["source_name"]
                    }) =>
                {
                    controller.0.session.invalidate(None)
                }
                _ => {}
            }
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
            if name == "ReplayBufferStateChanged" {
                let active = data["outputActive"].as_bool().unwrap_or(false);
                controller.0.policy.lock().unwrap().observe(active);
                controller
                    .0
                    .session
                    .connection(Some(&event_id), Some(active));
                controller
                    .0
                    .replay_buffer_active
                    .store(active, Ordering::SeqCst);
                if let Some(mining) = event_app.try_state::<Arc<crate::mining::MiningService>>() {
                    mining.set_obs_replay_active(active);
                }
            }
            if name == "ConnectionClosed" {
                *controller.0.policy.lock().unwrap() = policy::ReplayPolicy::default();
                controller.0.session.connection(None, None);
                controller
                    .0
                    .replay_buffer_active
                    .store(false, Ordering::SeqCst);
                if let Some(mining) = event_app.try_state::<Arc<crate::mining::MiningService>>() {
                    mining.set_obs_replay_active(false);
                }
                controller.0.state.lock().unwrap().devices = None;
                controller.emit(&event_app, "obs.connection", json!(false));
            }
        });
        // Disconnect a timed-out actor before replacing it. Never resend scene mutations.
        let _ = self.0.client.disconnect_primary().await;
        self.0
            .client
            .connect(id.clone(), url, password, true, events)
            .await
            .map_err(|e| e.message)?;
        {
            let mut state = self.0.state.lock().unwrap();
            state.switcher.connected_at = Some(Instant::now());
            state.probes_clean = false;
            state.switcher.collection.clear();
        }
        self.emit(app, "obs.connection", json!(true));
        self.refresh_session();
        let probe_obs = self.clone();
        let probe_app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(status) = probe_obs
                .0
                .client
                .call(
                    &id,
                    "GetRecordStatus".into(),
                    Value::Null,
                    Duration::from_secs(8),
                )
                .await
            {
                if let Some(active) = status["outputActive"].as_bool() {
                    let _order = probe_obs.0.event_order.lock().unwrap();
                    if probe_obs.0.session.record_state(&id, active, true) {
                        // OBS reports elapsed recording time in milliseconds on reconnection.
                        let elapsed = if active { status["outputDuration"].as_i64().unwrap_or(0).max(0) } else { 0 };
                        let start = crate::longplay::now().saturating_sub(elapsed.saturating_mul(1000));
                        probe_app.state::<crate::longplay::Service>().recording(active,None,start,probe_obs.current_scene_name());
                    }
                }
            }
        });
        Ok(())
    }
    pub(crate) fn longplay_event(&self, app: &tauri::AppHandle, name: &str, data: &Value) -> bool {
        let service = app.state::<crate::longplay::Service>();
        if !service.owned() {
            return false;
        }
        let now = crate::longplay::now();
        match name {
            "RecordFileChanged" => {
                if let Some(path) = data["newOutputPath"].as_str().filter(|s| !s.is_empty()) {
                    service.recording(true, Some(path), now, self.current_scene_name());
                }
            }
            "RecordStateChanged" => {
                if matches!(
                    data["outputState"].as_str(),
                    Some("OBS_WEBSOCKET_OUTPUT_STARTED" | "OBS_WEBSOCKET_OUTPUT_STOPPED") | None
                ) {
                    if let Some(active) = data["outputActive"].as_bool() {
                        service.recording(
                            active,
                            data["outputPath"].as_str(),
                            now,
                            self.current_scene_name(),
                        );
                    }
                }
            }
            _ => return false,
        }
        true
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
        let mut render_health = RenderHealthTracker::default();
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if self.0.suspended.load(Ordering::SeqCst) || self.0.updating.load(Ordering::SeqCst) {
                continue;
            }
            if !self.0.client.has_primary() {
                render_health.reset();
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
            if heartbeat.elapsed() > render_health.heartbeat_interval() {
                match self.probe_heartbeat(&app).await {
                    HeartbeatOutcome::Healthy => {
                        render_health.record_healthy();
                        heartbeat = Instant::now();
                    }
                    HeartbeatOutcome::Disconnected => {
                        render_health.reset();
                        let _ = self.0.client.disconnect_primary().await;
                        continue;
                    }
                    HeartbeatOutcome::RenderFailed => {
                        let now = Instant::now();
                        heartbeat = now;
                        if render_health.record_render_failure(now) {
                            if self.assert_idle(&app).await.is_ok() {
                                crate::desktop_log::warn(
                                    &app,
                                    "obs",
                                    "OBS failed consecutive render health checks (code 702); restarting OBS.",
                                );
                                match self
                                    .launch(
                                        &app,
                                        json!({"forceRestart": true, "forceKillOnTimeout": true}),
                                    )
                                    .await
                                {
                                    Ok(_) => {
                                        render_health.record_restart(Instant::now());
                                        next_connect = Instant::now() + Duration::from_secs(2);
                                        backoff = 1;
                                        continue;
                                    }
                                    Err(error) => {
                                        render_health.record_restart(Instant::now());
                                        crate::desktop_log::warn(
                                            &app,
                                            "obs",
                                            format!("Could not restart OBS after render failure: {error}"),
                                        );
                                    }
                                }
                            } else {
                                render_health.reset();
                                crate::desktop_log::warn(
                                    &app,
                                    "obs",
                                    "OBS render health check failed (code 702), but streaming or recording is active; skipping auto-restart.",
                                );
                            }
                        }
                    }
                }
            }
            let needs_cleanup = !self.0.state.lock().unwrap().probes_clean;
            if needs_cleanup {
                let _ = self.cleanup_helpers(&app).await;
            }
            if cfg!(windows) && !self.0.session.has_window_hooks() {
                if let Some(snapshot) = process::foreground() {
                    self.foreground(&app, snapshot);
                }
            }
        }
    }
    fn can_auto_restart_managed_obs(&self) -> bool {
        let Ok(paths) = self.paths() else {
            return false;
        };
        if !paths.managed().unwrap_or(false) {
            return false;
        }
        paths
            .settings()
            .is_ok_and(|settings| settings["open_obs"] != false)
    }
    async fn probe_heartbeat(&self, app: &tauri::AppHandle) -> HeartbeatOutcome {
        if self.can_auto_restart_managed_obs() {
            let scene = self.current_scene_name();
            if !scene.is_empty() {
                let result = self
                    .0
                    .client
                    .primary_call(
                        "GetSourceScreenshot",
                        json!({
                            "sourceName": scene,
                            "imageFormat": "png",
                            "imageWidth": 8,
                            "imageHeight": 8,
                        }),
                    )
                    .await;
                match classify_render_probe_result(&result) {
                    Some(outcome) => return outcome,
                    // Scene may have just been renamed/deleted; verify connection with GetVersion.
                    None => {}
                }
            }
        }
        if self.call(app, "GetVersion", json!({})).await.is_ok() {
            HeartbeatOutcome::Healthy
        } else {
            HeartbeatOutcome::Disconnected
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
    pub(crate) async fn launch_on_startup(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let paths = self.paths()?;
        if paths.settings()?["open_obs"] == false {
            return Ok(());
        }
        if paths.managed()? && !paths.executable().is_file() {
            self.ensure_installed(app).await?;
        }
        let result = self.launch(app, json!({})).await?;
        if result["status"] == "missing" {
            return Err(result["error"].as_str().unwrap_or("OBS not found").into());
        }
        Ok(())
    }

    async fn launch(&self, app: &tauri::AppHandle, options: Value) -> Result<Value, String> {
        let _guard = self.0.lifecycle.write().await;
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
            self.close_inner(
                app,
                json!({
                    "ignoreCloseConfig": true,
                    "forceKillOnTimeout": options["forceKillOnTimeout"] == true,
                }),
            )
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
        let force_kill = options["forceKillOnTimeout"] == true;
        let result = process::close_with_options(pid, &executable, force_kill).await;
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
                let _guard = self.0.lifecycle.write().await;
                self.close_inner(app, arg).await
            }
            "obs.runtime.wait" => {
                let _guard = self.0.lifecycle.write().await;
                Ok(Value::Null)
            }
            "obs.runtime.status" => self.runtime_status(),
            "obs.runtime.check" => {
                let _guard = self.0.lifecycle.write().await;
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

    pub(crate) fn is_replay_buffer_active(&self) -> bool {
        self.0.replay_buffer_active.load(Ordering::SeqCst)
    }

    pub(crate) fn current_scene_name(&self) -> String {
        self.game_session()["scene"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string()
    }

    async fn refresh_replay_buffer_state(&self, app: &tauri::AppHandle, id: &str) {
        let Ok(reply) = self
            .0
            .client
            .call(
                id,
                "GetReplayBufferStatus".into(),
                Value::Null,
                Duration::from_secs(1),
            )
            .await
        else {
            return;
        };
        let Some(active) = reply["outputActive"].as_bool() else {
            return;
        };
        let _order = self.0.event_order.lock().unwrap();
        let mut policy = self.0.policy.lock().unwrap();
        if !self.0.session.is_connection(id) {
            return;
        }
        let active = *policy.active.get_or_insert(active);
        self.0.session.connection(Some(id), Some(active));
        self.0.replay_buffer_active.store(active, Ordering::SeqCst);
        if let Some(mining) = app.try_state::<Arc<crate::mining::MiningService>>() {
            mining.set_obs_replay_active(active);
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

    #[test]
    fn classifies_render_probe_responses() {
        assert_eq!(
            classify_render_probe_result(&Ok(json!({"imageData": "data:image/png;base64,"}))),
            Some(HeartbeatOutcome::Healthy)
        );
        assert_eq!(
            classify_render_probe_result(&Err(ObsError {
                code: 702,
                message: "Failed to render screenshot.".into(),
            })),
            Some(HeartbeatOutcome::RenderFailed)
        );
        assert_eq!(
            classify_render_probe_result(&Err(ObsError {
                code: 600,
                message: "No source was found by the name of `OldScene`.".into(),
            })),
            None
        );
        assert_eq!(
            classify_render_probe_result(&Err(ObsError::new("OBS request timed out"))),
            Some(HeartbeatOutcome::Disconnected)
        );
    }

    #[test]
    fn render_health_requires_consecutive_failures_and_respects_cooldown() {
        let mut tracker = RenderHealthTracker::default();
        let start = Instant::now();
        assert_eq!(tracker.heartbeat_interval(), HEARTBEAT_INTERVAL);

        // First failure shortens interval to confirm quickly without restarting yet.
        assert!(!tracker.record_render_failure(start));
        assert_eq!(tracker.heartbeat_interval(), RENDER_FAILURE_CONFIRM_INTERVAL);

        // A healthy probe clears a transient single failure.
        tracker.record_healthy();
        assert_eq!(tracker.heartbeat_interval(), HEARTBEAT_INTERVAL);
        assert!(!tracker.record_render_failure(start + Duration::from_secs(1)));

        // Second consecutive failure triggers a restart.
        let second = start + Duration::from_secs(6);
        assert!(tracker.record_render_failure(second));
        tracker.record_restart(second);
        assert_eq!(tracker.heartbeat_interval(), HEARTBEAT_INTERVAL);

        // Within cooldown, consecutive failures do not trigger another restart.
        let during_cooldown = second + Duration::from_secs(60);
        assert!(!tracker.record_render_failure(during_cooldown));
        assert!(!tracker.record_render_failure(during_cooldown + Duration::from_secs(5)));
        assert_eq!(tracker.heartbeat_interval(), HEARTBEAT_INTERVAL);

        // After cooldown expires, recovery is allowed again.
        let after_cooldown = second + RENDER_RESTART_COOLDOWN + Duration::from_secs(1);
        assert!(tracker.record_render_failure(after_cooldown));
    }
}
