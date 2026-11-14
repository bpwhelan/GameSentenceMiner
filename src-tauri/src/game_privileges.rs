//! Native Windows game privilege elevation monitor and UAC relaunch helper.
//!
//! Replaces the Node/PowerShell-C# probe with direct Win32 `OpenProcess`,
//! `OpenProcessToken`, `GetTokenInformation(TokenElevation)`, `GetProcessTimes`,
//! and `CreateToolhelp32Snapshot`, eliminating ~200-400 ms per check and any
//! PowerShell process spawn.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

pub const GAME_PRIVILEGE_CHECK_INTERVAL: Duration = Duration::from_secs(30);
pub const GAME_PRIVILEGE_WARNING_CHANNEL: &str = "game-privileges.warning";
pub const GAME_PRIVILEGE_TOAST_ID: i64 = -1001;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GamePrivilegeTarget {
    #[serde(default)]
    pub exe_name: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub foreground: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GamePrivilegeWarning {
    pub id: String,
    pub pid: u32,
    pub exe_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessPrivilegeRecord {
    pub pid: u32,
    pub exe_name: String,
    pub started_at: String,
    pub elevated: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeOutput {
    pub gsm_elevated: Option<bool>,
    pub processes: Vec<ProcessPrivilegeRecord>,
}

pub fn normalize_exe_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

pub fn quote_windows_argument(arg: &str) -> String {
    if !arg.is_empty() && !arg.bytes().any(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'"')) {
        return arg.to_owned();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut slashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
        } else if ch == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
            out.push('"');
            slashes = 0;
        } else {
            out.push_str(&"\\".repeat(slashes));
            out.push(ch);
            slashes = 0;
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

pub fn join_windows_command_line(args: &[String]) -> String {
    args.iter()
        .map(|arg| quote_windows_argument(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
pub fn current_process_is_elevated() -> Option<bool> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        ok.ok()?;
        Some(elevation.TokenIsElevated != 0)
    }
}

#[cfg(not(windows))]
pub fn current_process_is_elevated() -> Option<bool> {
    None
}

#[cfg(windows)]
fn read_process_privilege(pid: u32) -> Option<ProcessPrivilegeRecord> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut name_buf = [0u16; 1024];
        let mut name_len = name_buf.len() as u32;
        let exe_name = if QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(name_buf.as_mut_ptr()),
            &mut name_len,
        )
        .is_ok()
        {
            let full = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            full.rsplit(['\\', '/']).next().unwrap_or("").to_owned()
        } else {
            String::new()
        };

        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let started_at = if GetProcessTimes(
            process,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
        .is_ok()
        {
            let raw = ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64);
            raw.to_string()
        } else {
            String::new()
        };

        let mut token = HANDLE::default();
        let elevated = if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok() {
            let mut elevation = TOKEN_ELEVATION::default();
            let mut returned = 0u32;
            let got = GetTokenInformation(
                token,
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )
            .is_ok();
            let _ = CloseHandle(token);
            if got {
                Some(elevation.TokenIsElevated != 0)
            } else {
                None
            }
        } else {
            None
        };

        let _ = CloseHandle(process);
        if exe_name.is_empty() && started_at.is_empty() && elevated.is_none() {
            return None;
        }
        Some(ProcessPrivilegeRecord {
            pid,
            exe_name,
            started_at,
            elevated,
        })
    }
}

#[cfg(windows)]
pub fn probe_targets_native(targets: &[GamePrivilegeTarget]) -> ProbeOutput {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let gsm_elevated = current_process_is_elevated();
    if gsm_elevated != Some(false) {
        return ProbeOutput {
            gsm_elevated,
            processes: Vec::new(),
        };
    }

    let mut seen_pids = HashSet::new();
    let mut name_targets = HashSet::new();
    let mut records = Vec::new();

    for target in targets {
        if let Some(pid) = target.pid.filter(|p| *p > 0) {
            if seen_pids.insert(pid) {
                if let Some(record) = read_process_privilege(pid) {
                    records.push(record);
                }
            }
        } else if let Some(name) = target.exe_name.as_deref() {
            let normalized = normalize_exe_name(name);
            if !normalized.is_empty() {
                name_targets.insert(normalized);
            }
        }
    }

    if !name_targets.is_empty() {
        unsafe {
            if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                let mut entry = PROCESSENTRY32W {
                    dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                    ..Default::default()
                };
                if Process32FirstW(snapshot, &mut entry).is_ok() {
                    loop {
                        let pid = entry.th32ProcessID;
                        if pid > 0 && !seen_pids.contains(&pid) {
                            let end = entry
                                .szExeFile
                                .iter()
                                .position(|&c| c == 0)
                                .unwrap_or(entry.szExeFile.len());
                            let candidate_name =
                                normalize_exe_name(&String::from_utf16_lossy(&entry.szExeFile[..end]));
                            if name_targets.contains(&candidate_name) && seen_pids.insert(pid) {
                                if let Some(mut record) = read_process_privilege(pid) {
                                    if record.exe_name.is_empty() {
                                        record.exe_name = candidate_name;
                                    }
                                    records.push(record);
                                }
                            }
                        }
                        if Process32NextW(snapshot, &mut entry).is_err() {
                            break;
                        }
                    }
                }
                let _ = CloseHandle(snapshot);
            }
        }
    }

    ProbeOutput {
        gsm_elevated,
        processes: records,
    }
}

#[cfg(not(windows))]
pub fn probe_targets_native(_targets: &[GamePrivilegeTarget]) -> ProbeOutput {
    ProbeOutput {
        gsm_elevated: None,
        processes: Vec::new(),
    }
}

#[derive(Default)]
struct MonitorState {
    targets: HashMap<String, GamePrivilegeTarget>,
    foreground_pid: Option<u32>,
    foreground_exe: Option<String>,
    dismissed: HashSet<String>,
    current: Option<GamePrivilegeWarning>,
    published_once: bool,
    last_published_json: Option<String>,
    notified_session: Option<String>,
    toast_open: bool,
    checking: bool,
    pending_recheck: bool,
    stopped: bool,
}

#[derive(Clone, Default)]
pub struct GamePrivileges(Arc<Mutex<MonitorState>>);

fn warning_id(record: &ProcessPrivilegeRecord) -> String {
    format!("{}:{}", record.pid, record.started_at)
}

fn select_warning(
    targets: &HashMap<String, GamePrivilegeTarget>,
    fg_pid: Option<u32>,
    fg_exe: Option<&str>,
    dismissed: &HashSet<String>,
    output: &ProbeOutput,
) -> Option<GamePrivilegeWarning> {
    if output.gsm_elevated != Some(false) {
        return None;
    }

    let elevated: Vec<&ProcessPrivilegeRecord> = output
        .processes
        .iter()
        .filter(|proc| proc.elevated == Some(true) && !dismissed.contains(&warning_id(proc)))
        .collect();
    if elevated.is_empty() {
        return None;
    }

    // Prefer texthook targets, then foreground-matching processes, then newest started process.
    let mut best: Option<(i32, &ProcessPrivilegeRecord)> = None;
    for proc in elevated {
        let proc_norm = normalize_exe_name(&proc.exe_name);
        let mut score = 0i32;
        if let Some(texthook) = targets.get("texthook") {
            let pid_match = texthook.pid == Some(proc.pid);
            let name_match = texthook
                .exe_name
                .as_deref()
                .map(normalize_exe_name)
                .is_some_and(|n| !n.is_empty() && n == proc_norm);
            if pid_match || name_match {
                score += 100;
            }
        }
        if fg_pid == Some(proc.pid) {
            score += 50;
        } else if fg_exe
            .map(normalize_exe_name)
            .is_some_and(|n| !n.is_empty() && n == proc_norm)
        {
            score += 25;
        }
        let take = match best {
            None => true,
            Some((best_score, best_proc)) => {
                score > best_score
                    || (score == best_score
                        && (proc.started_at > best_proc.started_at
                            || (proc.started_at == best_proc.started_at && proc.pid > best_proc.pid)))
            }
        };
        if take {
            best = Some((score, proc));
        }
    }

    best.map(|(_, proc)| GamePrivilegeWarning {
        id: warning_id(proc),
        pid: proc.pid,
        exe_name: proc.exe_name.clone(),
    })
}

pub fn start(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        if std::env::var_os("GSM_SMOKE_TEST").is_some() {
            return;
        }
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            refresh_capture(&app_handle).await;
            let mut interval = tokio::time::interval(GAME_PRIVILEGE_CHECK_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let stopped = app_handle
                    .try_state::<GamePrivileges>()
                    .is_some_and(|gp| gp.0.lock().unwrap().stopped);
                if stopped {
                    break;
                }
                refresh_capture(&app_handle).await;
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

pub fn stop(app: &tauri::AppHandle) {
    if let Some(gp) = app.try_state::<GamePrivileges>() {
        let mut guard = gp.0.lock().unwrap();
        guard.stopped = true;
        if guard.toast_open {
            guard.toast_open = false;
            drop(guard);
            close_toast(app);
        }
    }
}

pub async fn refresh_capture(app: &tauri::AppHandle) {
    let exe_name = resolve_capture_exe_name(app).await;
    set_target(
        app,
        "capture",
        exe_name.map(|exe| GamePrivilegeTarget {
            exe_name: Some(exe),
            pid: None,
            foreground: false,
        }),
    );
}

async fn resolve_capture_exe_name(app: &tauri::AppHandle) -> Option<String> {
    let obs = app.try_state::<crate::obs::Obs>()?.inner().clone();
    let scene = obs.invoke(app, "obs.getCurrentScene", &[]).await.ok()?;
    let scene_id = scene["id"].as_str().filter(|s| !s.is_empty())?.to_owned();
    let exe = obs
        .invoke(
            app,
            "obs.getExecutableNameFromSource",
            &[Value::String(scene_id)],
        )
        .await
        .ok()?;
    exe.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub fn set_target(app: &tauri::AppHandle, source: &str, target: Option<GamePrivilegeTarget>) {
    let Some(gp) = app.try_state::<GamePrivileges>() else {
        return;
    };
    {
        let mut guard = gp.0.lock().unwrap();
        match target {
            Some(t)
                if t.pid.is_some_and(|p| p > 0)
                    || t.exe_name.as_deref().is_some_and(|n| !n.trim().is_empty()) =>
            {
                guard.targets.insert(source.to_owned(), t);
            }
            _ => {
                guard.targets.remove(source);
            }
        }
    }
    trigger_check(app);
}

pub fn handle_foreground(app: &tauri::AppHandle, pid: Option<u32>, exe_name: Option<&str>) {
    let Some(gp) = app.try_state::<GamePrivileges>() else {
        return;
    };
    let should_check = {
        let mut guard = gp.0.lock().unwrap();
        guard.foreground_pid = pid.filter(|p| *p > 0);
        guard.foreground_exe = exe_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let matches_target = guard.targets.values().any(|target| {
            (pid.is_some() && target.pid == pid)
                || exe_name.is_some_and(|fg| {
                    target
                        .exe_name
                        .as_deref()
                        .is_some_and(|t| normalize_exe_name(t) == normalize_exe_name(fg))
                })
        });
        matches_target || guard.current.is_some()
    };
    if should_check {
        trigger_check(app);
    }
}

pub fn snapshot(app: &tauri::AppHandle) -> Option<GamePrivilegeWarning> {
    app.try_state::<GamePrivileges>()
        .and_then(|gp| gp.0.lock().ok().and_then(|g| g.current.clone()))
}

pub fn dismiss(app: &tauri::AppHandle, warning_id_arg: &str) {
    let Some(gp) = app.try_state::<GamePrivileges>() else {
        return;
    };
    let id = warning_id_arg.trim();
    if id.is_empty() {
        return;
    }
    let changed = {
        let mut guard = gp.0.lock().unwrap();
        guard.dismissed.insert(id.to_owned());
        if guard.current.as_ref().is_some_and(|w| w.id == id) {
            guard.current = None;
            true
        } else {
            false
        }
    };
    if changed {
        publish_warning(app, None);
    }
}

pub fn handle_toast_activated(app: &tauri::AppHandle) {
    if snapshot(app).is_none() {
        return;
    }
    if let Some(hub) = crate::desktop_state::find_hub_window(app) {
        let _ = crate::desktop_state::focus_window(&hub);
    }
}

pub fn trigger_check(app: &tauri::AppHandle) {
    #[cfg(not(windows))]
    {
        let _ = app;
        return;
    }
    #[cfg(windows)]
    {
        let Some(gp) = app.try_state::<GamePrivileges>() else {
            return;
        };
        {
            let mut guard = gp.0.lock().unwrap();
            if guard.stopped {
                return;
            }
            if guard.checking {
                guard.pending_recheck = true;
                return;
            }
            guard.checking = true;
        }
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let (targets, fg_pid, fg_exe, dismissed) = {
                    let gp = app_handle.state::<GamePrivileges>();
                    let guard = gp.0.lock().unwrap();
                    if guard.stopped {
                        break;
                    }
                    (
                        guard.targets.clone(),
                        guard.foreground_pid,
                        guard.foreground_exe.clone(),
                        guard.dismissed.clone(),
                    )
                };
                let target_list: Vec<GamePrivilegeTarget> = targets.values().cloned().collect();
                let next_warning = if target_list.is_empty() {
                    None
                } else {
                    let probe = tauri::async_runtime::spawn_blocking(move || {
                        probe_targets_native(&target_list)
                    })
                    .await
                    .ok();
                    probe.and_then(|output| {
                        select_warning(&targets, fg_pid, fg_exe.as_deref(), &dismissed, &output)
                    })
                };

                let gp = app_handle.state::<GamePrivileges>();
                let rerun = {
                    let mut guard = gp.0.lock().unwrap();
                    guard.current = next_warning.clone();
                    let again = guard.pending_recheck && !guard.stopped;
                    guard.pending_recheck = false;
                    if !again {
                        guard.checking = false;
                    }
                    again
                };
                publish_warning(&app_handle, next_warning);
                if !rerun {
                    break;
                }
            }
        });
    }
}

fn publish_warning(app: &tauri::AppHandle, warning: Option<GamePrivilegeWarning>) {
    let Some(gp) = app.try_state::<GamePrivileges>() else {
        return;
    };
    let serialized = serde_json::to_string(&warning).unwrap_or_else(|_| "null".into());
    enum ToastAction {
        None,
        Show(GamePrivilegeWarning),
        Close,
    }
    let (emit_ipc, toast_action) = {
        let mut guard = gp.0.lock().unwrap();
        let emit_ipc = !guard.published_once
            || guard.last_published_json.as_deref() != Some(&serialized);
        if emit_ipc {
            guard.published_once = true;
            guard.last_published_json = Some(serialized);
        }
        let toast_action = match &warning {
            Some(w) if guard.notified_session.as_deref() != Some(&w.id) => {
                guard.notified_session = Some(w.id.clone());
                guard.toast_open = true;
                ToastAction::Show(w.clone())
            }
            None if guard.toast_open => {
                guard.toast_open = false;
                ToastAction::Close
            }
            _ => ToastAction::None,
        };
        (emit_ipc, toast_action)
    };

    if emit_ipc {
        let payload = warning
            .as_ref()
            .and_then(|w| serde_json::to_value(w).ok())
            .unwrap_or(Value::Null);
        crate::desktop_state::emit_to_desktop_windows(
            app,
            GAME_PRIVILEGE_WARNING_CHANNEL,
            &[payload],
        );
    }

    match toast_action {
        ToastAction::Show(w) => show_toast(app, &w),
        ToastAction::Close => close_toast(app),
        ToastAction::None => {}
    }
}

fn show_toast(app: &tauri::AppHandle, warning: &GamePrivilegeWarning) {
    #[cfg(windows)]
    {
        if std::env::var_os("GSM_SMOKE_TEST").is_some() {
            return;
        }
        let app_clone = app.clone();
        let params = json!({
            "id": GAME_PRIVILEGE_TOAST_ID,
            "title": format!("{} is running as administrator", warning.exe_name),
            "body": "GSM is running normally and may not capture, hook text, overlay, or detect hotkeys. Click to restart GSM as administrator.",
            "silent": false,
        });
        tauri::async_runtime::spawn(async move {
            let _ = crate::windows_notifications::apply(&app_clone, &params, false);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, warning);
    }
}

fn close_toast(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::windows_notifications::apply(
                &app_clone,
                &json!({ "id": GAME_PRIVILEGE_TOAST_ID }),
                true,
            );
        });
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

pub fn resolved_executable_for_relaunch() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(root) = std::env::var_os("GSM_APP_ROOT") {
            let dir = Path::new(&root).join("src-tauri/target/desktop-runs");
            let prefix = format!(
                "{}-{}-",
                if cfg!(windows) {
                    "win32"
                } else if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    "linux"
                },
                if cfg!(target_arch = "x86_64") {
                    "x64"
                } else if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    std::env::consts::ARCH
                }
            );
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(&prefix) {
                        let candidate = entry.path().join("gsm-desktop.exe");
                        if candidate.is_file() {
                            return Ok(candidate);
                        }
                    }
                }
            }
        }
    }
    std::env::current_exe().map_err(|e| e.to_string())
}

pub fn clean_relaunch_args(raw: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(raw.len());
    let mut skip_next = false;
    for arg in raw {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--wait-pid" {
            skip_next = true;
            continue;
        }
        if arg.starts_with("--wait-pid=") {
            continue;
        }
        out.push(arg.clone());
    }
    out
}

#[cfg(windows)]
pub fn restart_as_admin(app: &tauri::AppHandle) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let executable = resolved_executable_for_relaunch()?;
    let pid = std::process::id();
    let existing: Vec<String> = std::env::args().skip(1).collect();
    let mut args = vec!["--wait-pid".to_owned(), pid.to_string()];
    args.extend(clean_relaunch_args(&existing));
    let param_str = join_windows_command_line(&args);

    let verb = HSTRING::from("runas");
    let file = HSTRING::from(executable.as_os_str());
    let params = HSTRING::from(param_str.as_str());
    let workdir = executable.parent().map(|p| HSTRING::from(p.as_os_str()));

    let hinst = unsafe {
        ShellExecuteW(
            None,
            &verb,
            &file,
            &params,
            workdir
                .as_ref()
                .map(|w| PCWSTR::from_raw(w.as_ptr()))
                .unwrap_or_else(PCWSTR::null),
            SW_SHOWNORMAL,
        )
    };
    if (hinst.0 as isize) <= 32 {
        return Err(format!(
            "Elevated relaunch was canceled or denied (ShellExecute code {})",
            hinst.0 as isize
        ));
    }
    app.exit(0);
    Ok(())
}

#[cfg(not(windows))]
pub fn restart_as_admin(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("Restarting as administrator is only supported on Windows.".into())
}

pub async fn handle_ipc(
    app: &tauri::AppHandle,
    label: &str,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    match channel {
        "game-privileges.getWarning" => {
            Ok(serde_json::to_value(snapshot(app)).unwrap_or(Value::Null))
        }
        "game-privileges.dismiss" => {
            if let Some(id) = args.first().and_then(Value::as_str) {
                dismiss(app, id);
            }
            Ok(Value::Null)
        }
        "game-privileges.restartAsAdmin" => {
            if !is_trusted_desktop_hub_or_desktop(label) {
                return Err("Only the GSM desktop window can restart GSM as administrator.".into());
            }
            let Some(requested_id) = args.first().and_then(Value::as_str) else {
                return Ok(Value::Null);
            };
            if snapshot(app).as_ref().is_none_or(|w| w.id != requested_id) {
                return Ok(Value::Null);
            }
            restart_as_admin(app)?;
            Ok(Value::Null)
        }
        _ => Err(format!("Unknown game-privileges channel: {channel}")),
    }
}

fn is_trusted_desktop_hub_or_desktop(label: &str) -> bool {
    !label.is_empty()
        && !label.starts_with("docs-")
        && !label.starts_with("agent-ui-")
        && !label.contains("overlay")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn normalizes_names_quotes_args_and_prioritizes_texthook_and_foreground() {
        assert_eq!(normalize_exe_name(r"C:\Games\Test\Game.EXE"), "game.exe");
        assert_eq!(normalize_exe_name(""), "");
        assert_eq!(
            join_windows_command_line(&[
                "--name".into(),
                r#"Sam "Hero" & C:\dir\"#.into(),
                "".into()
            ]),
            r#"--name "Sam \"Hero\" & C:\dir\\" """#
        );

        let mut targets = HashMap::new();
        targets.insert(
            "capture".into(),
            GamePrivilegeTarget {
                exe_name: Some("cap.exe".into()),
                pid: None,
                foreground: false,
            },
        );
        targets.insert(
            "texthook".into(),
            GamePrivilegeTarget {
                exe_name: Some("hook.exe".into()),
                pid: Some(200),
                foreground: false,
            },
        );
        let probe = ProbeOutput {
            gsm_elevated: Some(false),
            processes: vec![
                ProcessPrivilegeRecord {
                    pid: 100,
                    exe_name: "cap.exe".into(),
                    started_at: "9999".into(),
                    elevated: Some(true),
                },
                ProcessPrivilegeRecord {
                    pid: 200,
                    exe_name: "hook.exe".into(),
                    started_at: "1000".into(),
                    elevated: Some(true),
                },
            ],
        };
        let dismissed = HashSet::new();
        let warning = select_warning(&targets, None, None, &dismissed, &probe).unwrap();
        assert_eq!(warning.pid, 200);
        assert_eq!(warning.exe_name, "hook.exe");

        let mut dismissed_hook = HashSet::new();
        dismissed_hook.insert("200:1000".into());
        let fallback = select_warning(&targets, None, None, &dismissed_hook, &probe).unwrap();
        assert_eq!(fallback.pid, 100);
    }

    #[cfg(windows)]
    #[test]
    fn win32_direct_privilege_probe_benchmark() {
        let current_pid = std::process::id();
        let t0 = Instant::now();
        let mut ok_count = 0usize;
        for _ in 0..100 {
            if let Some(rec) = read_process_privilege(current_pid) {
                assert_eq!(rec.pid, current_pid);
                assert!(!rec.exe_name.is_empty());
                assert!(!rec.started_at.is_empty());
                assert!(rec.elevated.is_some());
                ok_count += 1;
            }
        }
        let pid_us = t0.elapsed().as_secs_f64() * 1_000_000.0 / 100.0;
        assert_eq!(ok_count, 100);

        let exe_name = read_process_privilege(current_pid).unwrap().exe_name;
        let targets = vec![GamePrivilegeTarget {
            exe_name: Some(exe_name),
            pid: None,
            foreground: false,
        }];
        let t1 = Instant::now();
        for _ in 0..20 {
            let _ = probe_targets_native(&targets);
        }
        let scan_ms = t1.elapsed().as_secs_f64() * 1000.0 / 20.0;
        println!("[bench] win32_privilege_probe direct_pid_us={pid_us:.1} snapshot_scan_ms={scan_ms:.2}");
    }
}
