//! Native Windows background keep-rendering & gamepad-blocking controller.
//!
//! Spawns `native/game-background-hooks/bin/<arch>/<buildId>/gsm-game-background-helper.exe`
//! directly from Rust (`CREATE_NO_WINDOW`), probes matching running game windows, maintains
//! per-executable opt-in profiles in `electron/config.json` (`gameBackgroundProfiles`),
//! streams stdin `configure` / `stop` commands, and only polls when attached or an enabled
//! profile matches the active OBS capture executable.

use gsm_settings::preferences::Preferences;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio::sync::Mutex as AsyncMutex;

pub const GAME_BACKGROUND_POLL_INTERVAL: Duration = Duration::from_millis(2500);
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const HELPER_EXE_NAME: &str = "gsm-game-background-helper.exe";
const HELPER_DLL_NAME: &str = "gsm-game-background.dll";
const PROFILE_STORE_KEY: &str = "gameBackgroundProfiles";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBackgroundOptions {
    pub enabled: bool,
    pub keep_rendering: bool,
    pub block_gamepad: bool,
}

impl Default for GameBackgroundOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            keep_rendering: false,
            block_gamepad: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBackgroundTarget {
    pub pid: u32,
    pub hwnd: String,
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub special_k: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBackgroundTelemetry {
    pub effective: i64,
    pub focus_hooks: i64,
    pub window_hooks: i64,
    pub input_hooks: i64,
    pub errors: i64,
    pub focus_events: i64,
    pub input_calls: i64,
    pub blocked_calls: i64,
    pub foreground: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBackgroundState {
    pub scene_id: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<GameBackgroundTarget>,
    pub options: GameBackgroundOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<GameBackgroundTelemetry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for GameBackgroundState {
    fn default() -> Self {
        Self {
            scene_id: String::new(),
            phase: "disabled".into(),
            reason: None,
            target: None,
            options: GameBackgroundOptions::default(),
            telemetry: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct ProfileIndex {
    profiles: HashMap<String, GameBackgroundOptions>,
    enabled_basenames: HashSet<String>,
}

#[derive(Clone)]
struct ActiveAttachment {
    key: String,
    target: GameBackgroundTarget,
    options: GameBackgroundOptions,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Child>>,
    generation: u64,
}

#[derive(Default)]
struct BackgroundCore {
    profile_index: Option<ProfileIndex>,
    attached: Option<ActiveAttachment>,
    state: GameBackgroundState,
    latched_error: Option<(String, u32, String)>,
    generation: u64,
    stopped: bool,
}

#[derive(Clone, Default)]
pub struct GameBackground {
    core: Arc<Mutex<BackgroundCore>>,
    op_lock: Arc<AsyncMutex<()>>,
}

/// Normalize a Windows or POSIX path into a case-folded key for profile persistence.
pub fn normalize_profile_key(path: &str) -> String {
    let normalized = path.trim().replace('/', "\\");
    if cfg!(windows) || normalized.contains('\\') {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn exe_basename_lower(path: &str) -> String {
    path.trim()
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

/// Normalize `GameBackgroundOptions`, matching `shared/game_background.ts`.
pub fn normalize_options(raw: Option<&Value>) -> GameBackgroundOptions {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return GameBackgroundOptions::default();
    };
    let keep_rendering = obj
        .get("keepRendering")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let block_gamepad = obj
        .get("blockGamepad")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let raw_enabled = obj
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    GameBackgroundOptions {
        enabled: raw_enabled && (keep_rendering || block_gamepad),
        keep_rendering,
        block_gamepad,
    }
}

/// Disambiguate candidate running windows for an OBS capture source.
pub fn choose_target(
    candidates: &[GameBackgroundTarget],
    preferred_title: &str,
) -> (Option<GameBackgroundTarget>, Option<&'static str>) {
    if candidates.is_empty() {
        return (None, Some("notRunning"));
    }
    if candidates.len() == 1 {
        return (Some(candidates[0].clone()), None);
    }
    let trimmed = preferred_title.trim();
    if !trimmed.is_empty() {
        let exact: Vec<_> = candidates
            .iter()
            .filter(|c| c.title.trim() == trimmed)
            .collect();
        if exact.len() == 1 {
            return (Some(exact[0].clone()), None);
        }
        let lower = trimmed.to_lowercase();
        let folded: Vec<_> = candidates
            .iter()
            .filter(|c| c.title.trim().to_lowercase() == lower)
            .collect();
        if folded.len() == 1 {
            return (Some(folded[0].clone()), None);
        }
    }
    (None, Some("ambiguous"))
}

fn is_valid_build_id(build_id: &str) -> bool {
    build_id.len() == 16
        && build_id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn resolve_helper_in_root(root: &Path, arch: &str) -> Result<PathBuf, String> {
    if arch != "x64" && arch != "x86" {
        return Err(format!("Unsupported target architecture: {arch}"));
    }
    let arch_dir = root
        .join("native")
        .join("game-background-hooks")
        .join("bin")
        .join(arch);
    let manifest_path = arch_dir.join("current.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|_| format!("Missing background hook manifest: {}", manifest_path.display()))?;
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|_| format!("Invalid background hook manifest: {}", manifest_path.display()))?;
    let build_id = parsed
        .get("buildId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| is_valid_build_id(id))
        .ok_or_else(|| format!("Invalid buildId in {}", manifest_path.display()))?;
    let build_dir = arch_dir.join(build_id);
    let helper = build_dir.join(HELPER_EXE_NAME);
    let dll = build_dir.join(HELPER_DLL_NAME);
    if !helper.is_file() || !dll.is_file() {
        return Err(format!(
            "Missing native game-background-hooks binary in {}",
            build_dir.display()
        ));
    }
    Ok(helper)
}

pub fn build_available_in_root(root: &Path) -> bool {
    resolve_helper_in_root(root, "x64").is_ok() && resolve_helper_in_root(root, "x86").is_ok()
}

fn candidate_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        roots.push(res);
    }
    if let Some(state) = app.try_state::<crate::desktop_state::DesktopState>() {
        if !roots.contains(&state.app_root) {
            roots.push(state.app_root.clone());
        }
    }
    roots
}

fn find_helper_for_arch(app: &tauri::AppHandle, arch: &str) -> Result<PathBuf, String> {
    let mut last_err = None;
    for root in candidate_roots(app) {
        if build_available_in_root(&root) {
            return resolve_helper_in_root(&root, arch);
        }
        if let Err(err) = resolve_helper_in_root(&root, arch) {
            last_err = Some(err);
        }
    }
    Err(last_err.unwrap_or_else(|| "Missing game-background-hooks build".into()))
}

fn any_build_available(app: &tauri::AppHandle) -> bool {
    candidate_roots(app)
        .into_iter()
        .any(|root| build_available_in_root(&root))
}

fn load_profile_index(app: &tauri::AppHandle) -> ProfileIndex {
    let prefs = Preferences::new(&crate::desktop_services::paths_for(app).active);
    let raw = prefs.get(PROFILE_STORE_KEY).ok().flatten();
    let mut profiles = HashMap::new();
    let mut enabled_basenames = HashSet::new();
    if let Some(map) = raw.as_ref().and_then(Value::as_object) {
        for (raw_key, raw_opts) in map {
            let key = normalize_profile_key(raw_key);
            if key.is_empty() {
                continue;
            }
            let opts = normalize_options(Some(raw_opts));
            if opts.enabled {
                let base = exe_basename_lower(&key);
                if !base.is_empty() {
                    enabled_basenames.insert(base);
                }
            }
            profiles.insert(key, opts);
        }
    }
    ProfileIndex {
        profiles,
        enabled_basenames,
    }
}

fn get_or_load_profiles(app: &tauri::AppHandle, refresh_disk: bool) -> ProfileIndex {
    let state = app.state::<GameBackground>();
    if !refresh_disk {
        if let Some(cached) = &state.core.lock().unwrap().profile_index {
            return cached.clone();
        }
    }
    let loaded = load_profile_index(app);
    state.core.lock().unwrap().profile_index = Some(loaded.clone());
    loaded
}

fn persist_profile(
    app: &tauri::AppHandle,
    profile_key: &str,
    options: &GameBackgroundOptions,
) -> Result<ProfileIndex, String> {
    let prefs = Preferences::new(&crate::desktop_services::paths_for(app).active);
    let mut map = prefs
        .get(PROFILE_STORE_KEY)?
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let normalized_key = normalize_profile_key(profile_key);
    map.insert(
        normalized_key.clone(),
        serde_json::to_value(options).map_err(|e| e.to_string())?,
    );
    prefs.patch(&json!({ PROFILE_STORE_KEY: map }))?;
    let loaded = load_profile_index(app);
    app.state::<GameBackground>().core.lock().unwrap().profile_index = Some(loaded.clone());
    Ok(loaded)
}

async fn probe_targets_helper(
    helper: &Path,
    exe_name: &str,
) -> Result<Vec<GameBackgroundTarget>, String> {
    let helper_path = helper.to_path_buf();
    let exe_owned = exe_name.to_owned();
    tokio::task::spawn_blocking(move || -> Result<Vec<GameBackgroundTarget>, String> {
        let mut cmd = Command::new(&helper_path);
        cmd.arg("--probe")
            .arg("--exe")
            .arg(&exe_owned)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to run background hook probe: {e}"))?;
        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();

        // Drain stdout/stderr concurrently so large probes cannot fill OS pipe buffers.
        let out_handle = std::thread::spawn(move || -> String {
            let mut s = String::new();
            if let Some(ref mut p) = stdout_pipe {
                let _ = p.read_to_string(&mut s);
            }
            s
        });
        let err_handle = std::thread::spawn(move || -> String {
            let mut s = String::new();
            if let Some(ref mut p) = stderr_pipe {
                let _ = p.read_to_string(&mut s);
            }
            s
        });

        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) => {
                    if started.elapsed() >= PROBE_TIMEOUT {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = out_handle.join();
                        let _ = err_handle.join();
                        return Err("Timed out inspecting running game windows.".into());
                    }
                    std::thread::sleep(Duration::from_millis(15));
                }
                Err(e) => {
                    let _ = child.kill();
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err(format!("Failed while waiting on background hook probe: {e}"));
                }
            }
        };

        let stdout = out_handle.join().unwrap_or_default().trim().to_owned();
        let stderr = err_handle.join().unwrap_or_default().trim().to_owned();
        if stdout.is_empty() {
            if !status.success() {
                return Err(if stderr.is_empty() {
                    "Background hook probe failed.".into()
                } else {
                    stderr
                });
            }
            return Ok(Vec::new());
        }
        if stdout.starts_with('{') {
            if let Ok(err_obj) = serde_json::from_str::<Value>(&stdout) {
                if let Some(msg) = err_obj.get("message").and_then(Value::as_str) {
                    return Err(msg.to_owned());
                }
            }
        }
        serde_json::from_str::<Vec<GameBackgroundTarget>>(&stdout)
            .map_err(|e| format!("Invalid background probe response: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn resolve_active_capture_for_background(
    app: &tauri::AppHandle,
    requested_scene_id: Option<&str>,
) -> Option<(String, String, String)> {
    let obs = app.try_state::<crate::obs::Obs>()?.inner().clone();
    obs.capture_identity_for_scene(app, requested_scene_id).await
}

fn spawn_attachment(
    app: &tauri::AppHandle,
    helper: &Path,
    target: &GameBackgroundTarget,
    options: &GameBackgroundOptions,
    generation: u64,
) -> Result<ActiveAttachment, String> {
    let keep_flag = if options.keep_rendering { "1" } else { "0" };
    let block_flag = if options.block_gamepad { "1" } else { "0" };
    let mut cmd = Command::new(helper);
    cmd.arg("--attach")
        .arg("--pid")
        .arg(target.pid.to_string())
        .arg("--hwnd")
        .arg(&target.hwnd)
        .arg("--path")
        .arg(&target.path)
        .arg("--keep-active")
        .arg(keep_flag)
        .arg("--block-gamepad")
        .arg(block_flag)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start background hook helper: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or("Background hook helper stdin unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Background hook helper stdout unavailable")?;

    let child_arc = Arc::new(Mutex::new(child));
    let stdin_arc = Arc::new(Mutex::new(Some(stdin)));
    let key = normalize_profile_key(&target.path);

    let app_handle = app.clone();
    let target_pid = target.pid;
    let key_clone = key.clone();
    let child_wait = child_arc.clone();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut last_error: Option<String> = None;
        let mut saw_clean_stop = false;

        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or("");
            match msg_type {
                "ready" | "status" => {
                    let telemetry = GameBackgroundTelemetry {
                        effective: msg.get("effective").and_then(Value::as_i64).unwrap_or(0),
                        focus_hooks: msg.get("focusHooks").and_then(Value::as_i64).unwrap_or(0),
                        window_hooks: msg.get("windowHooks").and_then(Value::as_i64).unwrap_or(0),
                        input_hooks: msg.get("inputHooks").and_then(Value::as_i64).unwrap_or(0),
                        errors: msg.get("errors").and_then(Value::as_i64).unwrap_or(0),
                        focus_events: msg.get("focusEvents").and_then(Value::as_i64).unwrap_or(0),
                        input_calls: msg.get("inputCalls").and_then(Value::as_i64).unwrap_or(0),
                        blocked_calls: msg.get("blockedCalls").and_then(Value::as_i64).unwrap_or(0),
                        foreground: msg
                            .get("foreground")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    };
                    if let Some(bg) = app_handle.try_state::<GameBackground>() {
                        let mut guard = bg.core.lock().unwrap();
                        if guard
                            .attached
                            .as_ref()
                            .is_some_and(|a| a.generation == generation)
                        {
                            guard.state.phase = "active".into();
                            guard.state.telemetry = Some(telemetry);
                            guard.state.error = None;
                            guard.state.reason = None;
                        }
                    }
                }
                "stopped" => {
                    saw_clean_stop = true;
                }
                "error" | "fatal" => {
                    if let Some(message) = msg.get("message").and_then(Value::as_str) {
                        last_error = Some(message.to_owned());
                    }
                }
                _ => {}
            }
        }

        let status = child_wait.lock().ok().and_then(|mut c| c.wait().ok());
        if let Some(bg) = app_handle.try_state::<GameBackground>() {
            let mut guard = bg.core.lock().unwrap();
            let still_owner = guard
                .attached
                .as_ref()
                .is_some_and(|a| a.generation == generation);
            if still_owner {
                guard.attached = None;
                guard.state.telemetry = None;
                let exited_err = if let Some(msg) = last_error {
                    Some(msg)
                } else if !saw_clean_stop && status.is_some_and(|s| !s.success()) {
                    Some(format!(
                        "Background hook helper exited with status {}.",
                        status.and_then(|s| s.code()).unwrap_or(-1)
                    ))
                } else {
                    None
                };
                if let Some(message) = exited_err {
                    guard.state.phase = "error".into();
                    guard.state.error = Some(message.clone());
                    guard.latched_error = Some((key_clone, target_pid, message));
                } else if guard.state.options.enabled {
                    guard.state.phase = "waiting".into();
                } else {
                    guard.state.phase = "disabled".into();
                }
            }
        }
    });

    Ok(ActiveAttachment {
        key,
        target: target.clone(),
        options: options.clone(),
        stdin: stdin_arc,
        child: child_arc,
        generation,
    })
}

async fn configure_attachment(
    attachment: &ActiveAttachment,
    options: &GameBackgroundOptions,
) -> Result<(), String> {
    let cmd = format!(
        "configure {} {}\n",
        if options.keep_rendering { 1 } else { 0 },
        if options.block_gamepad { 1 } else { 0 }
    );
    let stdin = attachment.stdin.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut guard = stdin.lock().unwrap();
        let Some(ref mut pipe) = *guard else {
            return Err("Background hook stdin closed".into());
        };
        pipe.write_all(cmd.as_bytes())
            .map_err(|e| format!("Failed to configure background hook: {e}"))?;
        pipe.flush()
            .map_err(|e| format!("Failed to flush background hook command: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn stop_attachment(attachment: ActiveAttachment) {
    let stdin = attachment.stdin.clone();
    let child = attachment.child.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(mut guard) = stdin.lock() {
            if let Some(mut pipe) = guard.take() {
                let _ = pipe.write_all(b"stop\n");
                let _ = pipe.flush();
            }
        }
        if let Ok(mut child_guard) = child.lock() {
            let started = Instant::now();
            loop {
                match child_guard.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if started.elapsed() < Duration::from_millis(1200) => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    _ => {
                        let _ = child_guard.kill();
                        let _ = child_guard.wait();
                        break;
                    }
                }
            }
        }
    })
    .await;
}

async fn detach_current(bg: &GameBackground) {
    let prev = { bg.core.lock().unwrap().attached.take() };
    if let Some(att) = prev {
        stop_attachment(att).await;
    }
}

async fn detach_with_state(
    bg: &GameBackground,
    next: GameBackgroundState,
) -> GameBackgroundState {
    detach_current(bg).await;
    bg.core.lock().unwrap().state = next.clone();
    next
}

async fn reconcile_background(
    app: &tauri::AppHandle,
    requested_scene_id: Option<&str>,
    interactive: bool,
) -> GameBackgroundState {
    let Some(bg) = app.try_state::<GameBackground>() else {
        return GameBackgroundState::default();
    };
    let _op = bg.op_lock.lock().await;
    let stopped = bg.core.lock().unwrap().stopped;
    if stopped {
        return bg.core.lock().unwrap().state.clone();
    }

    if !cfg!(windows) {
        let next = GameBackgroundState {
            scene_id: requested_scene_id.unwrap_or_default().to_owned(),
            phase: "disabled".into(),
            reason: Some("unsupported".into()),
            ..Default::default()
        };
        bg.core.lock().unwrap().state = next.clone();
        return next;
    }

    let profile_index = get_or_load_profiles(app, false);
    let is_attached = bg.core.lock().unwrap().attached.is_some();

    // Fast exit for background ticks when nothing is attached and no profile is opted in.
    if !interactive && !is_attached && profile_index.enabled_basenames.is_empty() {
        return bg.core.lock().unwrap().state.clone();
    }

    if !any_build_available(app) {
        return detach_with_state(
            &bg,
            GameBackgroundState {
                scene_id: requested_scene_id.unwrap_or_default().to_owned(),
                phase: "blocked".into(),
                reason: Some("missingBuild".into()),
                ..Default::default()
            },
        )
        .await;
    }

    let Some((scene_id, preferred_title, exe_name)) =
        resolve_active_capture_for_background(app, requested_scene_id).await
    else {
        return detach_with_state(
            &bg,
            GameBackgroundState {
                scene_id: requested_scene_id.unwrap_or_default().to_owned(),
                phase: "disabled".into(),
                reason: Some("noCapture".into()),
                ..Default::default()
            },
        )
        .await;
    };

    if exe_name.trim().is_empty() {
        return detach_with_state(
            &bg,
            GameBackgroundState {
                scene_id,
                phase: "disabled".into(),
                reason: Some("noCapture".into()),
                ..Default::default()
            },
        )
        .await;
    }

    // Fast background skip if neither currently attached nor matching any enabled profile basename.
    let exe_lower = exe_basename_lower(&exe_name);
    if !interactive && !is_attached && !profile_index.enabled_basenames.contains(&exe_lower) {
        return GameBackgroundState {
            scene_id,
            phase: "disabled".into(),
            reason: None,
            target: None,
            options: GameBackgroundOptions::default(),
            telemetry: None,
            error: None,
        };
    }

    let probe_helper = match find_helper_for_arch(app, "x64") {
        Ok(path) => path,
        Err(err) => {
            let next = GameBackgroundState {
                scene_id,
                phase: "blocked".into(),
                reason: Some("missingBuild".into()),
                error: Some(err),
                ..Default::default()
            };
            bg.core.lock().unwrap().state = next.clone();
            return next;
        }
    };

    let candidates = match probe_targets_helper(&probe_helper, &exe_name).await {
        Ok(list) => list,
        Err(err) => {
            return detach_with_state(
                &bg,
                GameBackgroundState {
                    scene_id,
                    phase: "error".into(),
                    error: Some(err),
                    ..Default::default()
                },
            )
            .await;
        }
    };

    let (maybe_target, maybe_reason) = choose_target(&candidates, &preferred_title);
    let Some(target) = maybe_target else {
        return detach_with_state(
            &bg,
            GameBackgroundState {
                scene_id,
                phase: if maybe_reason == Some("ambiguous") {
                    "blocked".into()
                } else {
                    "disabled".into()
                },
                reason: maybe_reason.map(str::to_owned),
                ..Default::default()
            },
        )
        .await;
    };

    let key = normalize_profile_key(&target.path);
    let options = profile_index
        .profiles
        .get(&key)
        .cloned()
        .unwrap_or_default();

    if !options.enabled {
        return detach_with_state(
            &bg,
            GameBackgroundState {
                scene_id,
                phase: "disabled".into(),
                reason: None,
                target: Some(target),
                options,
                telemetry: None,
                error: None,
            },
        )
        .await;
    }

    if target.special_k {
        return detach_with_state(
            &bg,
            GameBackgroundState {
                scene_id,
                phase: "blocked".into(),
                reason: Some("specialK".into()),
                target: Some(target),
                options,
                telemetry: None,
                error: None,
            },
        )
        .await;
    }

    if target.arch != "x64" && target.arch != "x86" {
        return detach_with_state(
            &bg,
            GameBackgroundState {
                scene_id,
                phase: "blocked".into(),
                reason: Some("unsupported".into()),
                target: Some(target),
                options,
                telemetry: None,
                error: None,
            },
        )
        .await;
    }

    // Respect latched attachment error on this PID until explicit save/relaunch.
    {
        let guard = bg.core.lock().unwrap();
        if let Some((err_key, err_pid, message)) = &guard.latched_error {
            if err_key == &key && *err_pid == target.pid {
                let mut state = GameBackgroundState {
                    scene_id,
                    phase: "error".into(),
                    reason: None,
                    target: Some(target),
                    options,
                    telemetry: None,
                    error: Some(message.clone()),
                };
                if guard.state.phase == "error" {
                    state.telemetry = None;
                }
                drop(guard);
                bg.core.lock().unwrap().state = state.clone();
                return state;
            }
        }
    }

    // Check if we are already attached to this exact PID + HWND + path.
    let existing = {
        let guard = bg.core.lock().unwrap();
        guard.attached.clone()
    };
    if let Some(att) = existing {
        if att.target.pid == target.pid
            && att.target.hwnd == target.hwnd
            && att.key == key
        {
            if att.options != options {
                if let Err(err) = configure_attachment(&att, &options).await {
                    return detach_with_state(
                        &bg,
                        GameBackgroundState {
                            scene_id,
                            phase: "error".into(),
                            reason: None,
                            target: Some(target),
                            options,
                            telemetry: None,
                            error: Some(err),
                        },
                    )
                    .await;
                }
                let mut guard = bg.core.lock().unwrap();
                if let Some(active_att) = guard.attached.as_mut() {
                    active_att.options = options.clone();
                }
            }
            let mut guard = bg.core.lock().unwrap();
            guard.state.scene_id = scene_id;
            guard.state.target = Some(target);
            guard.state.options = options;
            return guard.state.clone();
        }
        detach_current(&bg).await;
    }

    let helper = match find_helper_for_arch(app, &target.arch) {
        Ok(h) => h,
        Err(err) => {
            let next = GameBackgroundState {
                scene_id,
                phase: "blocked".into(),
                reason: Some("missingBuild".into()),
                target: Some(target),
                options,
                telemetry: None,
                error: Some(err),
            };
            bg.core.lock().unwrap().state = next.clone();
            return next;
        }
    };

    let generation = {
        let mut guard = bg.core.lock().unwrap();
        guard.generation = guard.generation.saturating_add(1);
        guard.generation
    };

    match spawn_attachment(app, &helper, &target, &options, generation) {
        Ok(att) => {
            let next = GameBackgroundState {
                scene_id,
                phase: "attaching".into(),
                reason: None,
                target: Some(target),
                options,
                telemetry: None,
                error: None,
            };
            let mut guard = bg.core.lock().unwrap();
            guard.attached = Some(att);
            guard.state = next.clone();
            next
        }
        Err(err) => {
            let mut guard = bg.core.lock().unwrap();
            guard.latched_error = Some((key, target.pid, err.clone()));
            let next = GameBackgroundState {
                scene_id,
                phase: "error".into(),
                reason: None,
                target: Some(target),
                options,
                telemetry: None,
                error: Some(err),
            };
            guard.state = next.clone();
            next
        }
    }
}

pub fn start(app: &tauri::AppHandle) {
    if !cfg!(windows) || std::env::var_os("GSM_SMOKE_TEST").is_some() {
        return;
    }
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(GAME_BACKGROUND_POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let stopped = app_handle
                .try_state::<GameBackground>()
                .is_some_and(|bg| bg.core.lock().unwrap().stopped);
            if stopped {
                break;
            }
            let _ = reconcile_background(&app_handle, None, false).await;
        }
    });
}

pub fn refresh_async(app: &tauri::AppHandle) {
    if !cfg!(windows) || std::env::var_os("GSM_SMOKE_TEST").is_some() {
        return;
    }
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = reconcile_background(&app_handle, None, false).await;
    });
}

pub fn stop(app: &tauri::AppHandle) {
    let Some(bg) = app.try_state::<GameBackground>() else {
        return;
    };
    let prev = {
        let mut guard = bg.core.lock().unwrap();
        guard.stopped = true;
        guard.attached.take()
    };
    if let Some(att) = prev {
        tauri::async_runtime::spawn(async move {
            stop_attachment(att).await;
        });
    }
}

pub async fn get_state(app: &tauri::AppHandle, scene_id: Option<&str>) -> GameBackgroundState {
    reconcile_background(app, scene_id, true).await
}

pub async fn save_settings(
    app: &tauri::AppHandle,
    payload: &Value,
) -> Result<GameBackgroundState, String> {
    let scene_id = payload
        .get("sceneId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let ui_target: GameBackgroundTarget = serde_json::from_value(
        payload.get("target").cloned().unwrap_or(Value::Null),
    )
    .map_err(|_| "Target game window is required.".to_string())?;
    let options = normalize_options(payload.get("options"));

    let live = reconcile_background(app, scene_id, true).await;
    if let Some(live_target) = &live.target {
        if live_target.pid != ui_target.pid
            || live_target.hwnd != ui_target.hwnd
            || normalize_profile_key(&live_target.path) != normalize_profile_key(&ui_target.path)
        {
            return Err("Target window changed; refresh and try again.".into());
        }
    } else if options.enabled {
        return Err(
            "Target game window changed or is no longer running; try again once detected.".into(),
        );
    }

    let key = normalize_profile_key(&ui_target.path);
    persist_profile(app, &key, &options)?;

    // Explicit save clears any latched failure for this executable to allow immediate retry.
    if let Some(bg) = app.try_state::<GameBackground>() {
        let mut guard = bg.core.lock().unwrap();
        if guard
            .latched_error
            .as_ref()
            .is_some_and(|(k, _, _)| k == &key)
        {
            guard.latched_error = None;
        }
    }

    Ok(reconcile_background(app, scene_id, true).await)
}

pub async fn handle_ipc(
    app: &tauri::AppHandle,
    _label: &str,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    match channel {
        "game-background.getState" => {
            let scene_id = args.first().and_then(|v| {
                v.as_str()
                    .or_else(|| v.get("sceneId").and_then(Value::as_str))
            });
            let state = get_state(app, scene_id).await;
            serde_json::to_value(state).map_err(|e| e.to_string())
        }
        "game-background.save" => {
            let payload = args.first().ok_or("Missing game background payload")?;
            let state = save_settings(app, payload).await?;
            serde_json::to_value(state).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unsupported game background channel: {channel}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::tempdir;

    fn sample_target(pid: u32, title: &str) -> GameBackgroundTarget {
        GameBackgroundTarget {
            pid,
            hwnd: (pid + 100).to_string(),
            path: "C:\\Games\\SampleGame.exe".into(),
            title: title.into(),
            arch: "x64".into(),
            special_k: false,
        }
    }

    #[test]
    fn options_normalization_and_target_disambiguation() {
        assert_eq!(
            normalize_options(None),
            GameBackgroundOptions {
                enabled: false,
                keep_rendering: false,
                block_gamepad: true,
            }
        );
        assert_eq!(
            normalize_options(Some(&json!({ "enabled": true }))),
            GameBackgroundOptions {
                enabled: true,
                keep_rendering: false,
                block_gamepad: true,
            }
        );
        assert!(
            !normalize_options(Some(&json!({
                "enabled": true,
                "keepRendering": false,
                "blockGamepad": false
            })))
            .enabled
        );
        assert!(
            !normalize_options(Some(&json!({ "enabled": "true" }))).enabled
        );

        let a = sample_target(10, "Game A");
        let b = sample_target(20, "Game B");
        assert_eq!(choose_target(&[], "Game A"), (None, Some("notRunning")));
        assert_eq!(
            choose_target(std::slice::from_ref(&a), ""),
            (Some(a.clone()), None)
        );
        assert_eq!(
            choose_target(&[a.clone(), b.clone()], "Game A"),
            (Some(a.clone()), None)
        );
        assert_eq!(
            choose_target(&[a.clone(), b.clone()], "Unknown"),
            (None, Some("ambiguous"))
        );
        assert_eq!(
            choose_target(&[a.clone(), sample_target(30, "Game A")], "Game A"),
            (None, Some("ambiguous"))
        );
    }

    #[test]
    fn manifest_validation_and_build_availability() {
        let dir = tempdir().unwrap();
        assert!(!build_available_in_root(dir.path()));

        for arch in ["x64", "x86"] {
            let base = dir
                .path()
                .join("native")
                .join("game-background-hooks")
                .join("bin")
                .join(arch);
            let build = base.join("0123456789abcdef");
            std::fs::create_dir_all(&build).unwrap();
            std::fs::write(
                base.join("current.json"),
                r#"{"buildId":"0123456789abcdef"}"#,
            )
            .unwrap();
            std::fs::write(build.join(HELPER_EXE_NAME), b"exe").unwrap();
            std::fs::write(build.join(HELPER_DLL_NAME), b"dll").unwrap();
        }
        assert!(build_available_in_root(dir.path()));
        let resolved = resolve_helper_in_root(dir.path(), "x64").unwrap();
        assert!(resolved.to_string_lossy().contains("0123456789abcdef"));

        // Corrupt traversal buildId must fail immediately.
        let x64_manifest = dir
            .path()
            .join("native")
            .join("game-background-hooks")
            .join("bin")
            .join("x64")
            .join("current.json");
        std::fs::write(&x64_manifest, r#"{"buildId":"../../evil"}"#).unwrap();
        assert!(resolve_helper_in_root(dir.path(), "x64").is_err());
        assert!(!build_available_in_root(dir.path()));
    }

    #[test]
    fn bench_state_eval_and_helper_probe() {
        let raw = json!({ "enabled": true, "keepRendering": true, "blockGamepad": true });
        let candidates = vec![sample_target(10, "Game Title"), sample_target(20, "Other")];
        let start = Instant::now();
        let iters = 10_000u64;
        for _ in 0..iters {
            let opts = normalize_options(Some(&raw));
            let (chosen, _) = choose_target(&candidates, "Game Title");
            let state = GameBackgroundState {
                scene_id: "scene-1".into(),
                phase: "active".into(),
                reason: None,
                target: chosen,
                options: opts,
                telemetry: Some(GameBackgroundTelemetry::default()),
                error: None,
            };
            std::hint::black_box(&state);
        }
        let elapsed = start.elapsed();
        let ns_per_op = elapsed.as_nanos() as f64 / iters as f64;
        println!(
            "[bench] game_background state_eval iters={} total_ms={:.3} ns_per_op={:.1}",
            iters,
            elapsed.as_secs_f64() * 1000.0,
            ns_per_op
        );

        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        if let Ok(helper) = resolve_helper_in_root(repo_root, "x64") {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let probe_start = Instant::now();
            let result = rt
                .block_on(probe_targets_helper(&helper, "__gsm_nonexistent_bench__.exe"))
                .unwrap();
            let probe_ms = probe_start.elapsed().as_secs_f64() * 1000.0;
            assert!(result.is_empty());
            println!("[bench] game_background helper_probe ms={:.2}", probe_ms);
        }
    }
}
