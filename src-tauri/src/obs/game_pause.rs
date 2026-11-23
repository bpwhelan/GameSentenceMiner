use super::{process, Obs};
use crate::{mining::MiningService, settings::Settings};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(crate) struct GamePause(Mutex<State>);
#[derive(Default)]
struct State {
    scene_target: Option<(u64, String)>,
    held: Option<Hold>,
    generation: u64,
}
struct Hold {
    process: platform::Paused,
    _cancel_timeout: tokio::sync::oneshot::Sender<()>,
    scene_epoch: u64,
    pid: u32,
    sources: HashSet<String>,
    since: f64,
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
fn name(path: &str) -> &str {
    path.trim().rsplit(['/', '\\']).next().unwrap_or("")
}
fn pid(game: &Value) -> Option<u32> {
    u32::try_from(game["target_pid"].as_u64()?)
        .ok()
        .filter(|p| *p > 1 && *p != std::process::id())
}

#[cfg(target_os = "linux")]
fn wine_exe(pid: u32) -> Option<String> {
    let cmd = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let mut args = cmd
        .split(|b| *b == 0)
        .filter_map(|arg| std::str::from_utf8(arg).ok())
        .map(|s| s.trim_matches('"'))
        .filter(|s| s.to_ascii_lowercase().ends_with(".exe") && !s.starts_with('-'));
    args.clone()
        .find(|s| {
            s.to_ascii_lowercase()
                .replace('\\', "/")
                .contains("/steamapps/common/")
        })
        .or_else(|| args.next())
        .map(str::to_owned)
}

fn executable(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    if let Some(path) = wine_exe(pid) {
        return Some(path);
    }
    process::image_path(pid).map(|p| p.to_string_lossy().into_owned())
}

fn persist_name(app: &AppHandle, basename: &str) -> Result<(), String> {
    let file = app.state::<Settings>().paths.active.join("config.json");
    gsm_settings::with_lock(&file, || {
        let mut doc = gsm_settings::read_object(&file)?;
        let current = doc["current_profile"]
            .as_str()
            .unwrap_or("Default")
            .to_owned();
        let profile = if doc["configs"].is_object() {
            doc["configs"]
                .get_mut(&current)
                .ok_or("Active profile missing")?
        } else {
            &mut doc
        };
        profile["process_pausing"]["linux_target_process"] = json!(basename);
        gsm_settings::write_atomic(&file, &doc)
    })
}

pub(crate) fn linux_request(app: &AppHandle, path: &str, body: &Value) -> Result<Value, String> {
    let session = app.state::<Obs>().game_session();
    let target = name(body["target"].as_str().unwrap_or(""));
    match path {
        "/linux/detect_game_exe" => Ok(json!({"supported":cfg!(target_os="linux"), "path":
            if cfg!(target_os="linux") {pid(&session).and_then(executable).unwrap_or_default()} else {String::new()}})),
        "/linux/set_target_process" => {
            persist_name(app, target)?;
            Ok(json!({"success":true,"linux_target_process":target}))
        }
        "/linux/set_scene_target_process" => {
            if body["scene"]
                .as_str()
                .is_some_and(|s| session["scene"] != s)
            {
                return Err("Active scene changed".into());
            }
            app.state::<GamePause>().0.lock().unwrap().scene_target = Some((
                session["scene_epoch"].as_u64().unwrap_or(0),
                target.to_owned(),
            ));
            Ok(json!({"success":true,"scene_target_process":target}))
        }
        _ => Err("Unknown Linux process setting".into()),
    }
}

fn allowed_source(config: &Value, source: &str) -> bool {
    config["enabled"] == true
        && match source {
            "manual_hotkey" => config["overlay_manual_hotkey_requests_pause"] == true,
            "texthooker_hotkey" => config["overlay_texthooker_hotkey_requests_pause"] == true,
            "gamepad_navigation" => {
                config
                    .get("overlay_gamepad_navigation_requests_pause")
                    .unwrap_or(&config["overlay_manual_hotkey_requests_pause"])
                    == true
            }
            "gamepad_manual_pause" | "process_pause_hotkey" => true,
            "anki_confirmation" => config["anki_confirmation_requests_pause"] == true,
            _ => false,
        }
}

fn critical(s: &str) -> bool {
    const NAMES: &str = include_str!("pause_denylist.txt");
    NAMES
        .split_ascii_whitespace()
        .any(|v| s.eq_ignore_ascii_case(v))
}

fn finish(app: &AppHandle, state: &mut State) -> Result<(), String> {
    if let Some(hold) = &mut state.held {
        hold.process.resume()?;
        let marker = app
            .state::<Settings>()
            .paths
            .active
            .join("suspended_pids.json");
        if let Err(error) = gsm_settings::write_atomic(&marker, &json!({"pids":[]})) {
            crate::desktop_log::warn(app, "game pause", error);
        }
        let span = (hold.since, now());
        app.state::<Arc<MiningService>>()
            .pause_history
            .remember_pauses(&[span]);
        let file = app
            .state::<Settings>()
            .paths
            .active
            .join("process_pause_history.json");
        state.held = None;
        let replay_seconds = app.state::<Obs>().game_session()["replay_seconds"]
            .as_u64()
            .unwrap_or(0);
        let oldest = span.1 - replay_seconds as f64 - 600.;
        if let Err(e) = gsm_settings::with_lock(&file, || {
            let mut doc = gsm_settings::read_object(&file)?;
            if !doc["pauses"].is_array() {
                doc["pauses"] = json!([]);
            }
            let rows = doc["pauses"].as_array_mut().unwrap();
            rows.retain(|r| {
                r.get(1)
                    .and_then(Value::as_f64)
                    .is_some_and(|end| end >= oldest)
            });
            rows.push(json!([span.0, span.1]));
            gsm_settings::write_atomic(&file, &doc)
        }) {
            crate::desktop_log::warn(app, "game pause", e);
        }
    }
    Ok(())
}

impl GamePause {
    pub(crate) fn recover(&self, app: &AppHandle) -> Result<(), String> {
        let state = self.0.lock().unwrap();
        if state.held.is_some() {
            return Ok(());
        }
        let marker = app
            .state::<Settings>()
            .paths
            .active
            .join("suspended_pids.json");
        if !marker.is_file() {
            return Ok(());
        }
        let doc = gsm_settings::read_object(&marker)?;
        let mut retry = Vec::new();
        for record in doc["pids"].as_array().into_iter().flatten() {
            let Some(pid) = record["pid"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|p| *p > 1 && *p != std::process::id())
            else {
                continue;
            };
            let Some(created) = record["created"].as_f64() else {
                continue;
            };
            let Some(image) = process::image_path(pid) else {
                continue;
            };
            let Some(exe) = image.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if critical(exe)
                || !record["exe"]
                    .as_str()
                    .is_some_and(|saved| name(saved).eq_ignore_ascii_case(exe))
            {
                continue;
            }
            if let Err(e) = platform::recover(pid, &image, created) {
                crate::desktop_log::warn(app, "game pause", e);
                retry.push(record);
            }
        }
        if doc["pids"].as_array().is_some_and(|p| !p.is_empty()) {
            gsm_settings::write_atomic(&marker, &json!({"pids":retry}))?;
        }
        Ok(())
    }

    pub(crate) fn release_all(&self, app: &AppHandle) {
        if let Err(e) = finish(app, &mut self.0.lock().unwrap()) {
            crate::desktop_log::warn(app, "game pause", e);
        }
    }

    pub(crate) fn request(
        &self,
        app: &AppHandle,
        source: &str,
        action: &str,
    ) -> Result<(), String> {
        let mut state = self.0.lock().unwrap();
        if action == "resume"
            || (action == "toggle"
                && state
                    .held
                    .as_ref()
                    .is_some_and(|hold| hold.sources.contains(source)))
        {
            if let Some(hold) = state.held.as_mut() {
                hold.sources.remove(source);
                if hold.sources.is_empty() {
                    finish(app, &mut state)?;
                }
            }
            return Ok(());
        }
        if action != "pause" && action != "toggle" {
            return Err("Unknown pause action".into());
        }
        let snapshot = app.state::<Arc<MiningService>>().load_snapshot()?;
        let profile = gsm_settings::gsm_config::active_profile(&snapshot.document)
            .and_then(|p| p.get("process_pausing"));
        let Some(cfg) = profile.filter(|p| allowed_source(p, source)) else {
            return Ok(());
        };
        let session = app.state::<Obs>().game_session();
        let pid = pid(&session).ok_or("No captured game process")?;
        let epoch = session["scene_epoch"].as_u64().unwrap_or(0);
        if let Some(hold) = &mut state.held {
            if hold.pid == pid && hold.scene_epoch == epoch {
                hold.sources.insert(source.to_owned());
                return Ok(());
            }
            finish(app, &mut state)?;
        }
        let image = process::image_path(pid).ok_or("Game process exited")?;
        // Pin the same executable and OBS capture that identified this game.
        if !session["process_path"]
            .as_str()
            .is_some_and(|path| process::same_path(&image, Path::new(path)))
        {
            return Err("Captured game executable changed".into());
        }
        let exe = executable(pid).unwrap_or_default();
        let image_name = image.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let exe_name = name(&exe);
        if [image_name, exe_name].iter().any(|n| {
            n.is_empty()
                || critical(n)
                || cfg["denylist"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|v| v.as_str().is_some_and(|v| v.eq_ignore_ascii_case(n)))
        }) {
            return Err("Captured executable is excluded from process pausing".into());
        }
        if cfg["require_game_exe_match"] != false {
            let expected = if cfg!(target_os = "linux") {
                state
                    .scene_target
                    .as_ref()
                    .filter(|(scene, s)| *scene == epoch && !s.is_empty())
                    .map(|(_, s)| s.as_str())
                    .or_else(|| cfg["linux_target_process"].as_str())
            } else {
                session["window_info"]["exe"].as_str()
            };
            if expected.is_some_and(|n| !n.is_empty() && !name(n).eq_ignore_ascii_case(exe_name)) {
                return Err("Game executable does not match the selected target".into());
            }
        }
        let (process, created) = platform::pause(pid, &image)?;
        let since = now();
        let marker = app
            .state::<Settings>()
            .paths
            .active
            .join("suspended_pids.json");
        gsm_settings::write_atomic(
            &marker,
            &json!({"pids":[{
                "pid":pid,"created":created,"exe":image_name,"suspended_at":since
            }]}),
        )?;

        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;
        let (cancel_timeout, mut cancelled) = tokio::sync::oneshot::channel();
        state.held = Some(Hold {
            process,
            _cancel_timeout: cancel_timeout,
            scene_epoch: epoch,
            pid,
            sources: HashSet::from([source.to_owned()]),
            since,
        });
        let timeout = Duration::from_secs_f64(
            cfg["auto_resume_seconds"]
                .as_f64()
                .unwrap_or(30.)
                .clamp(5., 86400.),
        );
        let handle = app.clone();
        let mut changes = app.state::<Obs>().subscribe_game_session();
        tauri::async_runtime::spawn(async move {
            let deadline = tokio::time::sleep(timeout);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut cancelled => return,
                    _ = &mut deadline => break,
                    result = changes.changed() => {
                        let game = changes.borrow_and_update();
                        if result.is_err() || game["scene_epoch"] != epoch || game["target_pid"]!=pid { break; }
                    }
                }
            }
            let pause = handle.state::<GamePause>();
            let mut state = pause.0.lock().unwrap();
            if state.generation == generation {
                let _ = finish(&handle, &mut state);
            }
        });
        Ok(())
    }
}

pub(crate) struct ConfirmationHold(AppHandle);
impl ConfirmationHold {
    pub(crate) fn new(app: &AppHandle) -> Self {
        let _ = app
            .state::<GamePause>()
            .request(app, "anki_confirmation", "pause");
        Self(app.clone())
    }
}
impl Drop for ConfirmationHold {
    fn drop(&mut self) {
        let _ = self
            .0
            .state::<GamePause>()
            .request(&self.0, "anki_confirmation", "resume");
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SUSPEND_RESUME,
        },
    };
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSuspendProcess(process: *mut std::ffi::c_void) -> i32;
        fn NtResumeProcess(process: *mut std::ffi::c_void) -> i32;
    }
    pub(super) struct Paused(Option<OwnedHandle>);
    fn target(pid: u32, image: &Path) -> Result<(OwnedHandle, f64), String> {
        let h = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SUSPEND_RESUME,
                false,
                pid,
            )
        }
        .map_err(|e| e.to_string())?;
        let h = unsafe { OwnedHandle::from_raw_handle(h.0) };
        // An open process handle pins its PID until both verification and resume complete.
        if process::image_path(pid).as_deref() != Some(image) {
            return Err("Game process changed".into());
        }
        use windows::Win32::{Foundation::FILETIME, System::Threading::GetProcessTimes};
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        unsafe {
            GetProcessTimes(
                HANDLE(h.as_raw_handle()),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        }
        .map_err(|e| e.to_string())?;
        let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        Ok((h, (ticks as f64 / 10_000_000.) - 11_644_473_600.))
    }
    pub(super) fn recover(pid: u32, image: &Path, expected: f64) -> Result<(), String> {
        let (handle, created) = target(pid, image)?;
        if (created - expected).abs() < 0.00001 {
            Paused(Some(handle)).resume()?;
        }
        Ok(())
    }
    pub(super) fn pause(pid: u32, image: &Path) -> Result<(Paused, f64), String> {
        let (h, created) = target(pid, image)?;
        if unsafe { NtSuspendProcess(h.as_raw_handle()) } < 0 {
            return Err("Windows could not pause the captured game".into());
        }
        Ok((Paused(Some(h)), created))
    }
    impl Paused {
        pub(super) fn resume(&mut self) -> Result<(), String> {
            if let Some(h) = &self.0 {
                let status = unsafe { NtResumeProcess(h.as_raw_handle()) };
                let mut exit_code = 259;
                if status < 0
                    && unsafe {
                        windows::Win32::System::Threading::GetExitCodeProcess(
                            HANDLE(h.as_raw_handle()),
                            &mut exit_code,
                        )
                    }
                    .is_ok()
                    && exit_code == 259
                {
                    return Err("Windows could not resume the captured game".into());
                }
            }
            self.0.take();
            Ok(())
        }
    }
    impl Drop for Paused {
        fn drop(&mut self) {
            let _ = self.resume();
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use rustix::process::{geteuid, pidfd_open, pidfd_send_signal, Pid, PidfdFlags, Signal};
    use std::os::{fd::OwnedFd, unix::fs::MetadataExt};
    pub(super) struct Paused(Option<OwnedFd>);
    fn target(pid: u32, image: &Path) -> Result<(OwnedFd, f64, String), String> {
        let fd = pidfd_open(
            Pid::from_raw(pid as i32).ok_or("Game process exited")?,
            PidfdFlags::empty(),
        )
        .map_err(|e| e.to_string())?;
        let proc = std::path::PathBuf::from(format!("/proc/{pid}"));
        if proc.metadata().map_err(|e| e.to_string())?.uid() != geteuid().as_raw()
            || process::image_path(pid).as_deref() != Some(image)
        {
            return Err("Captured game process changed".into());
        }
        let status = std::fs::read_to_string(proc.join("status")).map_err(|e| e.to_string())?;
        let stat = std::fs::read_to_string(proc.join("stat")).map_err(|e| e.to_string())?;
        let ticks = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(19))
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or("Game start time unavailable")?;
        let boot = std::fs::read_to_string("/proc/stat")
            .map_err(|e| e.to_string())?
            .lines()
            .find_map(|l| l.strip_prefix("btime ")?.parse::<u64>().ok())
            .ok_or("Boot time unavailable")?;
        Ok((
            fd,
            boot as f64 + ticks as f64 / rustix::param::clock_ticks_per_second() as f64,
            status,
        ))
    }
    pub(super) fn recover(pid: u32, image: &Path, expected: f64) -> Result<(), String> {
        let (fd, created, status) = target(pid, image)?;
        if (created - expected).abs() < 0.00001
            && status
                .lines()
                .find_map(|s| s.strip_prefix("State:"))
                .is_some_and(|s| s.trim_start().starts_with('T'))
        {
            Paused(Some(fd)).resume()?;
        }
        Ok(())
    }
    pub(super) fn pause(pid: u32, image: &Path) -> Result<(Paused, f64), String> {
        let (fd, created, status) = target(pid, image)?;
        if status
            .lines()
            .find_map(|s| s.strip_prefix("State:"))
            .is_some_and(|s| s.trim_start().starts_with(['T', 't']))
        {
            return Err("Game is already paused".into());
        }
        pidfd_send_signal(&fd, Signal::STOP).map_err(|e| e.to_string())?;
        Ok((Paused(Some(fd)), created))
    }
    impl Paused {
        pub(super) fn resume(&mut self) -> Result<(), String> {
            if let Some(fd) = &self.0 {
                if let Err(e) = pidfd_send_signal(fd, Signal::CONT) {
                    if e != rustix::io::Errno::SRCH {
                        return Err(e.to_string());
                    }
                }
            }
            self.0.take();
            Ok(())
        }
    }
    impl Drop for Paused {
        fn drop(&mut self) {
            let _ = self.resume();
        }
    }
}
#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use super::*;
    pub(super) struct Paused;
    pub(super) fn recover(_: u32, _: &Path, _: f64) -> Result<(), String> {
        Ok(())
    }
    pub(super) fn pause(_: u32, _: &Path) -> Result<(Paused, f64), String> {
        Err("Process pausing is unavailable on this platform".into())
    }
    impl Paused {
        pub(super) fn resume(&mut self) -> Result<(), String> {
            Ok(())
        }
    }
}
