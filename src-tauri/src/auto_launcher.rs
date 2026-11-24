//! Event-driven + adaptive-timer automation coordinator for TextHook/Agent injection,
//! auto/manual OCR lifecycle, Switch emulator game detection, and overlay state sync.

use crate::agent_scripts::{
    extract_title_id, is_switch_emulator_target, resolve_agent_script, ResolveAgentScriptInput,
};
use crate::desktop_services::paths_for;
use crate::obs::Obs;
use crate::ocr_coordinator::{self, OcrCoordinator, OcrRunMode, OcrStartSource};
use crate::process_probe::{
    find_primary_pid_by_exe, pe_bitness, process_executable_path, window_title_for_pid,
};
use crate::settings_tools::{
    find_scene_launch_profile, get_game_exe_path_for_scene, prepare_agent_scripts_dir,
    read_game_settings, read_scene_profiles, resolve_agent_scripts_dir,
    set_game_exe_path_for_scene, SceneLaunchProfile,
};
use crate::texthook_coordinator::{self, TexthookCoordinator};
use gsm_settings::preferences::Preferences;
use gsm_settings::profiles::Profiles;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio::sync::Notify;

const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(5000);
const SWITCH_POLL_INTERVAL: Duration = Duration::from_millis(500);
const OBS_INACTIVITY_THRESHOLD: Duration = Duration::from_secs(180);

const SWITCH_EMULATOR_EXES: &[&str] = &[
    "yuzu.exe",
    "ryujinx.exe",
    "citron.exe",
    "eden.exe",
    "suyu.exe",
    "sudachi.exe",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DesiredOcr {
    None,
    Auto,
    Manual,
    KeepCurrent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationDecision {
    pub desired_ocr: DesiredOcr,
    pub desired_overlay: Option<bool>,
    pub should_run_texthook: bool,
}

#[derive(Clone, Debug)]
pub struct AutomationEvalInput<'a> {
    pub obs_connected: bool,
    pub scene_id: &'a str,
    pub scene_name: &'a str,
    pub profile: Option<&'a SceneLaunchProfile>,
    pub obs_ocr_scenes: &'a [String],
    pub force_manual_ocr_all_profiles: bool,
    pub ignore_active_scene_for_ocr: bool,
    pub run_manual_ocr_on_startup: bool,
    pub run_overlay_on_startup: bool,
    pub run_overlay_with_active_game: bool,
    pub any_game_active: bool,
    pub scene_game_active: bool,
    pub inactive_for_limit: bool,
    pub ocr_suppressed_for_scene: bool,
    pub ocr_running: bool,
    pub ocr_started_by_auto: bool,
    pub user_ocr_active: bool,
}

/// Evaluate pure OCR, overlay, and TextHook automation decisions for the current tick.
pub fn evaluate_automation_decision(input: &AutomationEvalInput<'_>) -> AutomationDecision {
    let has_scene = !input.scene_name.trim().is_empty() || !input.scene_id.trim().is_empty();

    let desired_overlay = if input.run_overlay_on_startup {
        Some(true)
    } else if input.run_overlay_with_active_game {
        Some(input.obs_connected && input.any_game_active)
    } else if let Some(prof) = input.profile {
        if prof.launch_overlay {
            Some(input.obs_connected && input.any_game_active)
        } else {
            Some(false)
        }
    } else {
        Some(false)
    };

    // Saved TextHook profiles can enable automation without a scene launcher.
    // Resolve that profile against the scene's actual capture before injecting.
    let should_run_texthook = input.obs_connected && has_scene;

    let desired_ocr = if input.user_ocr_active {
        DesiredOcr::KeepCurrent
    } else if input.ignore_active_scene_for_ocr && input.run_manual_ocr_on_startup {
        if input.ocr_suppressed_for_scene {
            DesiredOcr::None
        } else {
            DesiredOcr::Manual
        }
    } else if !input.obs_connected || !has_scene {
        if input.ocr_running && input.ocr_started_by_auto {
            DesiredOcr::None
        } else {
            DesiredOcr::KeepCurrent
        }
    } else if input.ocr_suppressed_for_scene {
        DesiredOcr::None
    } else if input.inactive_for_limit && !input.scene_game_active {
        DesiredOcr::None
    } else {
        let profile_ocr_mode = input.profile.map(|p| p.ocr_mode.as_str()).unwrap_or("none");
        let in_legacy_ocr_scenes = input
            .obs_ocr_scenes
            .iter()
            .any(|s| s.eq_ignore_ascii_case(input.scene_name));

        if profile_ocr_mode == "none"
            && !in_legacy_ocr_scenes
            && !input.force_manual_ocr_all_profiles
        {
            DesiredOcr::None
        } else if input.force_manual_ocr_all_profiles && profile_ocr_mode != "none" {
            DesiredOcr::Manual
        } else if profile_ocr_mode == "manual" {
            DesiredOcr::Manual
        } else if profile_ocr_mode == "auto" || in_legacy_ocr_scenes {
            if input.force_manual_ocr_all_profiles {
                DesiredOcr::Manual
            } else {
                DesiredOcr::Auto
            }
        } else {
            DesiredOcr::None
        }
    };

    AutomationDecision {
        desired_ocr,
        desired_overlay,
        should_run_texthook,
    }
}

#[derive(Default)]
struct AutoLauncherInner {
    started: bool,
    stop_flag: Arc<AtomicBool>,
    last_scene_id: String,
    last_scene_name: String,
    last_foreground_exe: String,
    last_foreground_title: String,
    last_hooked_pid: Option<u32>,
    last_hooked_game_id: String,
    last_hook_error: Option<String>,
    texthook_suppressed_scene: Option<String>,
    ocr_suppressed_scene: Option<String>,
    switch_emu_active: bool,
    no_active_game_since: Option<Instant>,
    last_overlay_desired: Option<bool>,
}

pub struct AutoLauncher {
    inner: Arc<Mutex<AutoLauncherInner>>,
    notify: Arc<Notify>,
}

impl Default for AutoLauncher {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(AutoLauncherInner::default())),
            notify: Arc::new(Notify::new()),
        }
    }
}

impl AutoLauncher {
    pub fn start(app: &tauri::AppHandle) {
        if std::env::var("GSM_SMOKE_TEST").is_ok() {
            return;
        }
        let Some(state) = app.try_state::<AutoLauncher>() else {
            return;
        };
        let stop_flag = {
            let mut s = state.inner.lock().unwrap();
            if s.started {
                return;
            }
            s.started = true;
            s.stop_flag = Arc::new(AtomicBool::new(false));
            s.stop_flag.clone()
        };
        let notify = state.notify.clone();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            automation_loop(app_handle, stop_flag, notify).await;
        });
    }

    pub fn stop(app: &tauri::AppHandle) {
        let Some(state) = app.try_state::<AutoLauncher>() else {
            return;
        };
        {
            let mut s = state.inner.lock().unwrap();
            s.started = false;
            s.stop_flag.store(true, Ordering::SeqCst);
        }
        state.notify.notify_waiters();
    }

    pub fn wake(&self) {
        self.notify.notify_one();
    }
}

pub fn notify_scene_changed(app: &tauri::AppHandle, scene_id: &str, scene_name: &str) {
    let Some(state) = app.try_state::<AutoLauncher>() else {
        return;
    };
    {
        let mut s = state.inner.lock().unwrap();
        if s.last_scene_name != scene_name {
            if s.ocr_suppressed_scene.as_deref() != Some(scene_name) {
                s.ocr_suppressed_scene = None;
            }
            if s.texthook_suppressed_scene.as_deref() != Some(scene_name) {
                s.texthook_suppressed_scene = None;
            }
            s.last_hooked_pid = None;
            s.last_hooked_game_id.clear();
            s.no_active_game_since = None;
        }
        s.last_scene_id = scene_id.to_owned();
        s.last_scene_name = scene_name.to_owned();
    }
    state.wake();
}

pub fn notify_foreground_changed(app: &tauri::AppHandle, exe_name: &str, title: &str) {
    let Some(state) = app.try_state::<AutoLauncher>() else {
        return;
    };
    let changed = {
        let mut s = state.inner.lock().unwrap();
        let diff = !s.last_foreground_exe.eq_ignore_ascii_case(exe_name)
            || s.last_foreground_title != title;
        if diff {
            s.last_foreground_exe = exe_name.to_owned();
            s.last_foreground_title = title.to_owned();
        }
        diff
    };
    if changed {
        state.wake();
    }
}

pub fn notify_signal(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AutoLauncher>() {
        state.wake();
    }
}

pub fn handle_foreground_changed(
    app: &tauri::AppHandle,
    snap: crate::active_game::ForegroundSnapshot,
    _emulator: bool,
) {
    notify_foreground_changed(app, &snap.executable_name, &snap.title);
}

pub fn notify_texthook_user_start(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AutoLauncher>() {
        {
            let mut s = state.inner.lock().unwrap();
            s.texthook_suppressed_scene = None;
        }
        state.wake();
    }
}

pub fn notify_texthook_user_stop(app: &tauri::AppHandle) {
    suppress_current_scene_texthook(app);
}

pub async fn sync_process_pausing_for_current_scene(app: &tauri::AppHandle) {
    crate::game_background::refresh_async(app);
    notify_signal(app);
}

pub fn suppress_current_scene_ocr(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AutoLauncher>() else {
        return;
    };
    let mut s = state.inner.lock().unwrap();
    if !s.last_scene_name.is_empty() {
        s.ocr_suppressed_scene = Some(s.last_scene_name.clone());
    }
}

pub fn suppress_current_scene_texthook(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AutoLauncher>() else {
        return;
    };
    let mut s = state.inner.lock().unwrap();
    if !s.last_scene_name.is_empty() {
        s.texthook_suppressed_scene = Some(s.last_scene_name.clone());
    }
}

fn read_electron_config(app: &tauri::AppHandle) -> Map<String, Value> {
    let paths = paths_for(app);
    fs::read_to_string(paths.active.join("electron/config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn any_switch_emu_running() -> Option<(u32, String, Option<String>)> {
    for exe in SWITCH_EMULATOR_EXES {
        if let Some(pid) = find_primary_pid_by_exe(exe) {
            let title = window_title_for_pid(pid);
            return Some((pid, (*exe).to_owned(), title));
        }
    }
    None
}

async fn sync_overlay_native(app: &tauri::AppHandle, desired: bool) {
    let Some(oh) = app.try_state::<crate::overlay_host::OverlayHost>() else {
        return;
    };
    let _ = oh.auto_overlay_sync(app, desired).await;
}

async fn automation_loop(app: tauri::AppHandle, stop_flag: Arc<AtomicBool>, notify: Arc<Notify>) {
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }
        run_automation_tick(&app).await;

        let delay = app
            .try_state::<AutoLauncher>()
            .map(|al| {
                if al.inner.lock().unwrap().switch_emu_active {
                    SWITCH_POLL_INTERVAL
                } else {
                    IDLE_POLL_INTERVAL
                }
            })
            .unwrap_or(IDLE_POLL_INTERVAL);

        tokio::select! {
            _ = notify.notified() => {},
            _ = tokio::time::sleep(delay) => {},
        }
    }
}

async fn run_automation_tick(app: &tauri::AppHandle) {
    let Some(al) = app.try_state::<AutoLauncher>() else {
        return;
    };
    let paths = paths_for(app);
    let prefs = Preferences::new(&paths.active);
    let cfg = read_electron_config(app);
    let profiles = read_scene_profiles(&prefs);

    let obs_state = app.try_state::<Obs>();
    let obs_connected = obs_state
        .as_ref()
        .is_some_and(|o| o.state()["connected"] == true);

    let session = obs_state
        .as_ref()
        .map(|o| o.game_session())
        .unwrap_or_default();
    let scene_id = session["scene_id"].as_str().unwrap_or("").to_owned();
    let scene_name = session["scene"].as_str().unwrap_or("").to_owned();

    let profile = if !scene_name.is_empty() || !scene_id.is_empty() {
        find_scene_launch_profile(
            &profiles,
            (!scene_id.is_empty()).then_some(scene_id.as_str()),
            Some(scene_name.as_str()),
        )
    } else {
        None
    };

    let any_game_active = session["active"] == true;
    let scene_game_active = any_game_active && !scene_name.is_empty();

    let switch_running = tauri::async_runtime::spawn_blocking(any_switch_emu_running)
        .await
        .ok()
        .flatten();

    let (inactive_for_limit, ocr_suppressed, texthook_suppressed, prev_overlay) = {
        let mut s = al.inner.lock().unwrap();
        s.last_scene_id = scene_id.clone();
        s.last_scene_name = scene_name.clone();
        s.switch_emu_active = switch_running.is_some();

        let has_active_capture = scene_game_active || switch_running.is_some() || any_game_active;
        if obs_connected && !has_active_capture {
            if s.no_active_game_since.is_none() {
                s.no_active_game_since = Some(Instant::now());
            }
        } else {
            s.no_active_game_since = None;
        }
        let inactive_for_limit = s
            .no_active_game_since
            .is_some_and(|t| t.elapsed() >= OBS_INACTIVITY_THRESHOLD);
        (
            inactive_for_limit,
            s.ocr_suppressed_scene.as_deref() == Some(scene_name.as_str()),
            s.texthook_suppressed_scene.as_deref() == Some(scene_name.as_str()),
            s.last_overlay_desired,
        )
    };

    let obs_ocr_scenes: Vec<String> = cfg
        .get("obsOcrScenes")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    let ocr_coord = app.try_state::<OcrCoordinator>();
    let ocr_running = ocr_coord.as_ref().is_some_and(|c| c.is_running());
    let ocr_source = ocr_coord.as_ref().and_then(|c| c.active_source());
    let ocr_started_by_auto = ocr_source.as_ref() == Some(&OcrStartSource::Auto);
    let user_ocr_active = ocr_running && ocr_source.as_ref() == Some(&OcrStartSource::User);

    let decision = evaluate_automation_decision(&AutomationEvalInput {
        obs_connected,
        scene_id: &scene_id,
        scene_name: &scene_name,
        profile: profile.as_ref(),
        obs_ocr_scenes: &obs_ocr_scenes,
        force_manual_ocr_all_profiles: cfg
            .get("forceManualOcrAllProfiles")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        ignore_active_scene_for_ocr: cfg
            .get("ignoreActiveSceneForOcr")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        run_manual_ocr_on_startup: cfg
            .get("runManualOCROnStartup")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        run_overlay_on_startup: cfg
            .get("runOverlayOnStartup")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        run_overlay_with_active_game: cfg
            .get("runOverlayWithActiveGame")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        any_game_active,
        scene_game_active,
        inactive_for_limit,
        ocr_suppressed_for_scene: ocr_suppressed,
        ocr_running,
        ocr_started_by_auto,
        user_ocr_active,
    });

    // 1. Apply Overlay Decision natively in Rust
    if let Some(desired_overlay) = decision.desired_overlay {
        if prev_overlay != Some(desired_overlay) {
            al.inner.lock().unwrap().last_overlay_desired = Some(desired_overlay);
            sync_overlay_native(app, desired_overlay).await;
        }
    }

    // 2. Apply OCR Decision
    match decision.desired_ocr {
        DesiredOcr::None => {
            if ocr_running && ocr_started_by_auto {
                ocr_coordinator::stop_ocr_sync(app, "auto-launcher", Some(&OcrStartSource::Auto));
            }
        }
        DesiredOcr::Auto => {
            let need_start = ocr_coord
                .as_ref()
                .map(|c| {
                    let snap = c.running_snapshot();
                    !snap["isRunning"].as_bool().unwrap_or(false)
                        || snap["mode"].as_str() != Some("auto")
                })
                .unwrap_or(false);
            if need_start {
                let _ =
                    ocr_coordinator::start_ocr(app, OcrStartSource::Auto, OcrRunMode::Auto).await;
            }
        }
        DesiredOcr::Manual => {
            let need_start = ocr_coord
                .as_ref()
                .map(|c| {
                    let snap = c.running_snapshot();
                    !snap["isRunning"].as_bool().unwrap_or(false)
                        || snap["mode"].as_str() != Some("manual")
                })
                .unwrap_or(false);
            if need_start {
                let _ =
                    ocr_coordinator::start_ocr(app, OcrStartSource::Auto, OcrRunMode::Manual).await;
            }
        }
        DesiredOcr::KeepCurrent => {}
    }

    // 3. Apply TextHook / Agent Decision
    if decision.should_run_texthook && !texthook_suppressed {
        run_texthook_automation_step(
            app,
            &prefs,
            &al,
            &obs_state,
            &scene_id,
            &scene_name,
            profile.as_ref(),
        )
        .await;
    }
}

fn configured_hook_engine<'a>(
    profile: Option<&'a SceneLaunchProfile>,
    saved: &'a Value,
) -> Option<&'a str> {
    let has = |key: &str| saved[key].as_str().is_some_and(|s| !s.trim().is_empty());
    if saved["autoHook"] == true {
        match saved["engine"].as_str() {
            Some("agent") if has("agentScriptPath") => return Some("agent"),
            Some(engine @ ("luna" | "textractor"))
                if has("hookId") || has("hookFunction") || has("manualHookCode") =>
            {
                return Some(engine)
            }
            _ => {}
        }
    }
    profile
        .map(|p| p.text_hook_mode.as_str())
        .filter(|mode| matches!(*mode, "agent" | "luna" | "textractor"))
}

fn keep_hook_session(status: &Value, options: &Value, same_game: bool) -> bool {
    status["running"] == true
        && (!matches!(status["source"].as_str(), Some("auto" | "auto-launcher"))
            || (same_game
                && status["pid"] == options["pid"]
                && status["engine"] == options["engine"]
                && (options["engine"] != "agent"
                    || status["agentScriptPath"] == options["agentScriptPath"])))
}

fn script_matches_game(script: &str, game_id: Option<&str>) -> bool {
    let script_id = extract_title_id(None, Some(script), None).0;
    match (script_id.as_deref(), game_id) {
        (Some(expected), Some(actual)) => expected.eq_ignore_ascii_case(actual),
        _ => true,
    }
}

async fn run_texthook_automation_step(
    app: &tauri::AppHandle,
    prefs: &Preferences,
    al: &AutoLauncher,
    obs_state: &Option<tauri::State<'_, Obs>>,
    scene_id: &str,
    scene_name: &str,
    profile: Option<&SceneLaunchProfile>,
) {
    let paths = paths_for(app);
    let game_settings = read_game_settings(prefs);
    let th_coord = app.try_state::<TexthookCoordinator>();

    // Determine target executable / window title from profile, OBS source, or Switch emulator
    let mut target_pid: Option<u32> = None;
    let mut exe_name = String::new();
    let mut window_title = String::new();

    // Only the active scene may select a process; an unrelated open emulator
    // must never take priority over its capture.
    if let Some(obs) = obs_state {
        if let Some((_, _, obs_exe)) = obs.capture_identity_for_scene(app, Some(scene_id)).await {
            target_pid = find_primary_pid_by_exe(&obs_exe);
            exe_name = obs_exe;
            window_title = target_pid
                .and_then(window_title_for_pid)
                .unwrap_or_default();
        }
    }

    if target_pid.is_none() {
        let saved_exe = profile
            .and_then(|p| p.game_executable_path.as_deref())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| get_game_exe_path_for_scene(prefs, scene_name));
        if !saved_exe.is_empty() {
            let base = Path::new(&saved_exe)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&saved_exe)
                .to_owned();
            if let Some(pid) = find_primary_pid_by_exe(&base) {
                target_pid = Some(pid);
                exe_name = base;
                window_title = window_title_for_pid(pid).unwrap_or_default();
            }
        }
    }

    let Some(pid) = target_pid else {
        return;
    };
    let saved = Profiles::new(&paths.active)
        .get(&exe_name, Some(scene_id))
        .unwrap_or(Value::Null);
    let Some(engine) = configured_hook_engine(profile, &saved) else {
        return;
    };

    // Persist discovered executable path cleanly for future restarts if missing
    if let Some(exe_path) = process_executable_path(pid) {
        let is_wine_launcher = exe_path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| crate::linux_wine::is_launcher_comm(&n.to_ascii_lowercase()));
        if !is_wine_launcher && get_game_exe_path_for_scene(prefs, scene_name).is_empty() {
            let _ = set_game_exe_path_for_scene(prefs, scene_name, &exe_path.to_string_lossy());
        }
    }

    let (current_switch_id, _is_switch) = extract_title_id(
        None,
        (!window_title.is_empty()).then_some(window_title.as_str()),
        (!exe_name.is_empty()).then_some(exe_name.as_str()),
    );

    let switch_target = is_switch_emulator_target(Some(&exe_name), Some(&window_title));
    let previous_game = al.inner.lock().unwrap().last_hooked_game_id.clone();
    if switch_target && previous_game != current_switch_id.as_deref().unwrap_or("") {
        let owns_old_session = th_coord.as_ref().is_some_and(|c| {
            let status = c.automation_status();
            status["running"] == true
                && status["pid"] == pid
                && matches!(status["source"].as_str(), Some("auto" | "auto-launcher"))
        });
        if owns_old_session {
            let _ = texthook_coordinator::stop_session(app, true).await;
        }
    }
    if switch_target && current_switch_id.is_none() {
        return;
    }

    #[cfg(target_os = "linux")]
    {
        let body = json!({"scene":scene_name,"target":exe_name});
        if crate::app_lifecycle::native_session_requested() {
            let _ = crate::obs::game_pause::linux_request(app,"/linux/set_scene_target_process",&body);
        } else {
            let url = gsm_settings::gsm_config::gsm_backend_url(&paths_for(app).active.join("config.json"),"/linux/set_scene_target_process");
            let _ = app.state::<crate::desktop_state::DesktopState>().http.post(url).json(&body)
                .timeout(std::time::Duration::from_secs(2)).send().await;
        }
    }

    let mut launch_opts = json!({
        "engine": engine,
        "pid": pid,
        "exeName": exe_name,
        "sceneId": scene_id,
        "source": "auto",
    });

    if engine == "agent" {
        let scripts_dir = {
            let active_dir = paths.active.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let prefs = Preferences::new(&active_dir);
                prepare_agent_scripts_dir(&prefs, &active_dir, None).dir
            })
            .await
            .unwrap_or_else(|_| resolve_agent_scripts_dir(prefs, &paths.active, None))
        };
        let saved_script = (saved["engine"] == "agent" && saved["autoHook"] == true)
            .then(|| saved["agentScriptPath"].as_str())
            .flatten();
        let script_path = if let Some(path) = saved_script
            .or_else(|| profile.map(|p| p.agent_script_path.as_str()))
            .filter(|p| !p.trim().is_empty())
        {
            path.to_owned()
        } else {
            let resolved = resolve_agent_script(&ResolveAgentScriptInput {
                scripts_path: scripts_dir.to_string_lossy().into_owned(),
                scene_name: Some(scene_name.to_owned()),
                window_title: (!window_title.is_empty()).then_some(window_title.clone()),
                process_name: (!exe_name.is_empty()).then_some(exe_name.clone()),
                explicit_game_id: current_switch_id.clone(),
            });
            resolved.path.unwrap_or_default()
        };
        if switch_target
            && (script_path.is_empty()
                || !script_matches_game(&script_path, current_switch_id.as_deref()))
        {
            return;
        }
        if !script_path.is_empty() {
            launch_opts["agentScriptPath"] = json!(script_path);
        }
        launch_opts["agentPath"] = json!(game_settings.agent_path);
    } else if matches!(engine, "textractor" | "luna") {
        let arch = process_executable_path(pid)
            .map(|p| pe_bitness(&p))
            .unwrap_or("x64");
        launch_opts["arch"] = json!(arch);
    }

    let same_game =
        al.inner.lock().unwrap().last_hooked_game_id == current_switch_id.as_deref().unwrap_or("");
    if th_coord
        .as_ref()
        .is_some_and(|c| keep_hook_session(&c.automation_status(), &launch_opts, same_game))
    {
        return;
    }

    let delay = profile.map_or(0.0, |p| p.launch_delay_seconds);
    if delay > 0.0 {
        tokio::time::sleep(Duration::from_secs_f64(delay.clamp(0.0, 60.0))).await;
    }
    // A delayed launch must not attach after a scene/game switch or manual stop.
    if let Some(obs) = obs_state {
        let current = obs.game_session();
        if current["scene_id"].as_str() != Some(scene_id) {
            return;
        }
    }
    if find_primary_pid_by_exe(&exe_name) != Some(pid) {
        return;
    }
    if current_switch_id.is_some()
        && extract_title_id(None, window_title_for_pid(pid).as_deref(), Some(&exe_name)).0
            != current_switch_id
    {
        return;
    }
    {
        let s = al.inner.lock().unwrap();
        if s.stop_flag.load(Ordering::SeqCst)
            || s.texthook_suppressed_scene.as_deref() == Some(scene_name)
        {
            return;
        }
    }

    match texthook_coordinator::start_session(app, launch_opts, true).await {
        Ok(_) => {
            let mut s = al.inner.lock().unwrap();
            s.last_hooked_pid = Some(pid);
            s.last_hooked_game_id = current_switch_id.unwrap_or_default();
            s.last_hook_error = None;
        }
        Err(error) => {
            let message = format!("Auto hook for {scene_name} ({engine}): {error}");
            let mut s = al.inner.lock().unwrap();
            if s.last_hook_error.as_ref() != Some(&message) {
                s.last_hook_error = Some(message.clone());
                drop(s);
                texthook_coordinator::on_texthook_log_error(app, &message);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_profiles_enable_all_supported_hooks_without_scene_launchers() {
        let disabled_launcher = sample_profile("none", "manual", false);
        for engine in ["agent", "luna", "textractor"] {
            let saved = json!({"engine":engine, "autoHook":true, "agentScriptPath":"game.js", "hookFunction":"TextOutW"});
            assert_eq!(configured_hook_engine(None, &saved), Some(engine));
            assert_eq!(
                configured_hook_engine(Some(&disabled_launcher), &saved),
                Some(engine)
            );
            let mut disabled = saved.clone();
            disabled["autoHook"] = json!(false);
            assert_eq!(
                configured_hook_engine(Some(&disabled_launcher), &disabled),
                None
            );
        }
        assert_eq!(
            configured_hook_engine(None, &json!({"engine":"agent","autoHook":true})),
            None
        );
    }

    #[test]
    fn auto_hooks_preserve_manual_sessions_and_refresh_changed_scripts_or_games() {
        let desired = json!({"engine":"agent","pid":123,"agentScriptPath":"next.js"});
        let mut active = json!({"running":true,"source":"user","engine":"luna","pid":99});
        assert!(keep_hook_session(&active, &desired, false));
        active = desired.clone();
        active["running"] = json!(true);
        active["source"] = json!("auto");
        assert!(keep_hook_session(&active, &desired, true));
        assert!(!keep_hook_session(&active, &desired, false));
        active["agentScriptPath"] = json!("old.js");
        assert!(!keep_hook_session(&active, &desired, true));
        assert!(script_matches_game(
            "NS_0100123456789000_Game.js",
            Some("0100123456789000")
        ));
        assert!(!script_matches_game(
            "NS_0100123456789000_Game.js",
            Some("0100999999999000")
        ));
    }

    fn sample_profile(text_hook_mode: &str, ocr_mode: &str, overlay: bool) -> SceneLaunchProfile {
        SceneLaunchProfile {
            scene_id: Some("scene-1".into()),
            scene_name: "Steins;Gate".into(),
            text_hook_mode: text_hook_mode.into(),
            ocr_mode: ocr_mode.into(),
            launch_overlay: overlay,
            agent_script_path: String::new(),
            launch_delay_seconds: 0.0,
            game_executable_path: None,
        }
    }

    #[test]
    fn automation_decision_handles_suppression_inactivity_and_modes() {
        let p_auto = sample_profile("textractor", "auto", true);
        let scenes = vec!["OtherScene".to_owned()];

        let d = evaluate_automation_decision(&AutomationEvalInput {
            obs_connected: true,
            scene_id: "s1",
            scene_name: "Steins;Gate",
            profile: Some(&p_auto),
            obs_ocr_scenes: &scenes,
            force_manual_ocr_all_profiles: false,
            ignore_active_scene_for_ocr: false,
            run_manual_ocr_on_startup: false,
            run_overlay_on_startup: false,
            run_overlay_with_active_game: true,
            any_game_active: true,
            scene_game_active: true,
            inactive_for_limit: false,
            ocr_suppressed_for_scene: false,
            ocr_running: false,
            ocr_started_by_auto: false,
            user_ocr_active: false,
        });
        assert_eq!(d.desired_ocr, DesiredOcr::Auto);
        assert_eq!(d.desired_overlay, Some(true));
        assert!(d.should_run_texthook);

        // Saved TextHook profiles are independent of legacy scene launch modes.
        let no_launcher_hook = sample_profile("none", "manual", false);
        let saved_profile_tick = evaluate_automation_decision(&AutomationEvalInput {
            obs_connected: true,
            scene_id: "s1",
            scene_name: "Steins;Gate",
            profile: Some(&no_launcher_hook),
            obs_ocr_scenes: &[],
            force_manual_ocr_all_profiles: false,
            ignore_active_scene_for_ocr: false,
            run_manual_ocr_on_startup: false,
            run_overlay_on_startup: false,
            run_overlay_with_active_game: false,
            any_game_active: true,
            scene_game_active: true,
            inactive_for_limit: false,
            ocr_suppressed_for_scene: false,
            ocr_running: false,
            ocr_started_by_auto: false,
            user_ocr_active: false,
        });
        assert!(saved_profile_tick.should_run_texthook);

        let suppressed = evaluate_automation_decision(&AutomationEvalInput {
            ocr_suppressed_for_scene: true,
            ..AutomationEvalInput {
                obs_connected: true,
                scene_id: "s1",
                scene_name: "Steins;Gate",
                profile: Some(&p_auto),
                obs_ocr_scenes: &scenes,
                force_manual_ocr_all_profiles: false,
                ignore_active_scene_for_ocr: false,
                run_manual_ocr_on_startup: false,
                run_overlay_on_startup: false,
                run_overlay_with_active_game: true,
                any_game_active: false,
                scene_game_active: false,
                inactive_for_limit: false,
                ocr_suppressed_for_scene: false,
                ocr_running: true,
                ocr_started_by_auto: true,
                user_ocr_active: false,
            }
        });
        assert_eq!(suppressed.desired_ocr, DesiredOcr::None);
        assert_eq!(suppressed.desired_overlay, Some(false));
    }

    #[test]
    fn benchmark_automation_decision_50k_evals() {
        let p = sample_profile("agent", "auto", true);
        let scenes = vec!["SceneA".to_owned(), "Steins;Gate".to_owned()];
        let input = AutomationEvalInput {
            obs_connected: true,
            scene_id: "s1",
            scene_name: "Steins;Gate",
            profile: Some(&p),
            obs_ocr_scenes: &scenes,
            force_manual_ocr_all_profiles: false,
            ignore_active_scene_for_ocr: false,
            run_manual_ocr_on_startup: false,
            run_overlay_on_startup: false,
            run_overlay_with_active_game: true,
            any_game_active: true,
            scene_game_active: true,
            inactive_for_limit: false,
            ocr_suppressed_for_scene: false,
            ocr_running: true,
            ocr_started_by_auto: true,
            user_ocr_active: false,
        };
        let t0 = Instant::now();
        for _ in 0..50_000 {
            let _ = std::hint::black_box(evaluate_automation_decision(&input));
        }
        let elapsed = t0.elapsed();
        println!(
            "[bench] auto_launcher decision_50k total_ms={:.3} ns_per_eval={:.1}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_nanos() as f64 / 50_000.0
        );
    }
}
