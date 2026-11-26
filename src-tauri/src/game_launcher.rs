//! Native Windows game launcher, executable auto-detector, Yuzu ROM matcher,
//! and direct COM unelevated Explorer ShellExecute dispatcher.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

#[cfg(windows)]
mod steam;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameLaunchOptions {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub executable_path: String,
    #[serde(default)]
    pub rom_path: String,
    #[serde(default)]
    pub arguments: String,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub launcher_path: String,
    #[serde(default)]
    pub launcher_arguments: String,
}

fn default_mode() -> String {
    "executable".to_owned()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameLaunchCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameLaunchResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchError {
    pub code: &'static str,
    pub message: Option<String>,
}

impl LaunchError {
    fn code(code: &'static str) -> Self {
        Self {
            code,
            message: None,
        }
    }
    fn failed(message: impl Into<String>) -> Self {
        Self {
            code: "failed",
            message: Some(message.into()),
        }
    }
    fn into_result(self) -> GameLaunchResult {
        GameLaunchResult {
            success: false,
            code: Some(self.code.to_owned()),
            error: self.message,
        }
    }
}

pub fn normalize_options(value: &Value) -> GameLaunchOptions {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_owned()
    };
    let mode = if value.get("mode").and_then(Value::as_str) == Some("yuzu") {
        "yuzu".to_owned()
    } else {
        "executable".to_owned()
    };
    GameLaunchOptions {
        mode,
        executable_path: text("executablePath"),
        rom_path: text("romPath"),
        arguments: value
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned(),
        working_directory: text("workingDirectory"),
        launcher_path: text("launcherPath"),
        launcher_arguments: value
            .get("launcherArguments")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned(),
    }
}

pub fn split_windows_command_line(command: &str) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let len = chars.len();
    let mut index = 0usize;
    let mut result = Vec::new();
    let is_space = |c: char| c == ' ' || c == '\t';

    while index < len {
        while index < len && is_space(chars[index]) {
            index += 1;
        }
        if index >= len {
            break;
        }
        let mut arg = String::new();
        let mut quoted = false;
        while index < len && (quoted || !is_space(chars[index])) {
            let mut slashes = 0usize;
            while index < len && chars[index] == '\\' {
                slashes += 1;
                index += 1;
            }
            if index < len && chars[index] == '"' {
                for _ in 0..(slashes / 2) {
                    arg.push('\\');
                }
                index += 1;
                if slashes % 2 == 1 {
                    arg.push('"');
                } else if quoted && index < len && chars[index] == '"' {
                    arg.push('"');
                    index += 1;
                } else {
                    quoted = !quoted;
                }
            } else {
                for _ in 0..slashes {
                    arg.push('\\');
                }
                if index >= len || (!quoted && is_space(chars[index])) {
                    break;
                }
                arg.push(chars[index]);
                index += 1;
            }
        }
        result.push(arg);
    }
    result
}

pub fn validate_scene_id(scene_id: &str) -> Result<String, LaunchError> {
    let trimmed = scene_id.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return Err(LaunchError::code("invalidScene"));
    }
    Ok(trimmed.to_owned())
}

fn is_win_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || (bytes.len() >= 2 && (bytes[0] == b'\\' && bytes[1] == b'\\' || bytes[0] == b'/' && bytes[1] == b'/'))
}

fn win_basename_lower(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

fn win_dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    let Some(pos) = trimmed.rfind(['\\', '/']) else {
        return String::new();
    };
    if pos == 2 && trimmed.as_bytes().get(1) == Some(&b':') {
        return format!("{}\\", &trimmed[..2]);
    }
    if pos == 0 {
        return "\\".into();
    }
    trimmed[..pos].to_owned()
}

pub fn choose_game_executable(
    windows: &[(String, String)],
    executable_name: &str,
    title: &str,
) -> Option<String> {
    let exe_lower = executable_name.trim().to_lowercase();
    if exe_lower.is_empty() {
        return None;
    }
    let matches: Vec<&(String, String)> = windows
        .iter()
        .filter(|(path, _)| is_win_absolute(path) && win_basename_lower(path) == exe_lower)
        .collect();
    let exact_title: Vec<&(String, String)> = if title.is_empty() {
        Vec::new()
    } else {
        matches
            .iter()
            .copied()
            .filter(|(_, w_title)| w_title == title)
            .collect()
    };
    let pool = if exact_title.is_empty() {
        matches
    } else {
        exact_title
    };
    let mut unique: Vec<(&str, String)> = Vec::new();
    let mut seen = HashSet::new();
    for (path, _) in pool {
        let key = path.replace('/', "\\").to_lowercase();
        if seen.insert(key.clone()) {
            unique.push((path.as_str(), key));
        }
    }
    if unique.len() == 1 {
        Some(unique[0].0.to_owned())
    } else {
        None
    }
}

pub fn build_game_launch_command(
    options: &GameLaunchOptions,
) -> Result<GameLaunchCommand, LaunchError> {
    if [
        options.mode.as_str(),
        options.executable_path.as_str(),
        options.rom_path.as_str(),
        options.arguments.as_str(),
        options.working_directory.as_str(),
        options.launcher_path.as_str(),
        options.launcher_arguments.as_str(),
    ]
    .iter()
    .any(|field| field.contains('\0'))
    {
        return Err(LaunchError::code("invalidArguments"));
    }

    let mut game_args = Vec::new();
    if options.mode == "yuzu" {
        game_args.push("-g".into());
        game_args.push(options.rom_path.clone());
    }
    game_args.extend(split_windows_command_line(&options.arguments));

    let args = if !options.launcher_path.is_empty() {
        let template = if options.launcher_arguments.is_empty() {
            "{game} {args}"
        } else {
            options.launcher_arguments.as_str()
        };
        let mut expanded = Vec::new();
        for token in split_windows_command_line(template) {
            if token == "{args}" {
                expanded.extend(game_args.iter().cloned());
            } else if token.contains("{args}") {
                return Err(LaunchError::code("invalidArguments"));
            } else {
                expanded.push(token.replace("{game}", &options.executable_path));
            }
        }
        expanded
    } else {
        game_args
    };

    let cwd = if !options.working_directory.is_empty() {
        options.working_directory.clone()
    } else {
        win_dirname(&options.executable_path)
    };

    Ok(GameLaunchCommand {
        executable: if options.launcher_path.is_empty() {
            options.executable_path.clone()
        } else {
            options.launcher_path.clone()
        },
        args,
        cwd,
    })
}

#[derive(Default)]
struct LauncherState {
    generations: HashMap<String, u64>,
    launching: HashSet<String>,
    stopped: bool,
}

#[derive(Clone, Default)]
pub struct GameLauncher(Arc<Mutex<LauncherState>>);

pub fn start(app: &tauri::AppHandle) {
    if !cfg!(windows) || std::env::var_os("GSM_SMOKE_TEST").is_some() {
        return;
    }
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let stopped = app_handle
                .try_state::<GameLauncher>()
                .is_some_and(|s| s.0.lock().unwrap().stopped);
            if stopped {
                break;
            }
            if let Some(scene_id) = current_obs_scene_id(&app_handle).await {
                let _ = get_options(&app_handle, &scene_id).await;
            }
        }
    });
}

pub fn stop(app: &tauri::AppHandle) {
    if let Some(gl) = app.try_state::<GameLauncher>() {
        gl.0.lock().unwrap().stopped = true;
    }
}

async fn current_obs_scene_id(app: &tauri::AppHandle) -> Option<String> {
    let obs = app.try_state::<crate::obs::Obs>()?.inner().clone();
    let scene = obs.invoke(app, "obs.getCurrentScene", &[]).await.ok()?;
    scene["id"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

async fn detect_executable(app: &tauri::AppHandle, scene_id: &str) -> Option<String> {
    let scene_id = validate_scene_id(scene_id).ok()?;
    let obs = app.try_state::<crate::obs::Obs>()?.inner().clone();
    let exe = obs
        .invoke(
            app,
            "obs.getExecutableNameFromSource",
            &[Value::String(scene_id.clone())],
        )
        .await
        .ok()?
        .as_str()
        .unwrap_or("")
        .to_owned();
    if exe.trim().is_empty() {
        return None;
    }
    let title = obs
        .invoke(app, "obs.getWindowTitleFromSource", &[Value::String(scene_id)])
        .await
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();

    let windows = tauri::async_runtime::spawn_blocking(crate::capture_windows::list)
        .await
        .ok()?
        .ok()?;
    let pairs: Vec<(String, String)> = windows
        .into_iter()
        .filter_map(|w| w.process_path.map(|path| (path, w.title)))
        .collect();
    choose_game_executable(&pairs, &exe, &title)
}

fn load_profile(app: &tauri::AppHandle, scene_id: &str) -> Option<GameLaunchOptions> {
    let prefs = gsm_settings::preferences::Preferences::new(&crate::desktop_services::paths_for(app).active);
    let profiles = prefs.get("gameLaunchProfiles").ok().flatten()?;
    let raw = profiles.get(scene_id)?;
    if raw.is_object() {
        Some(normalize_options(raw))
    } else {
        None
    }
}

fn save_profile(
    app: &tauri::AppHandle,
    scene_id: &str,
    options: &GameLaunchOptions,
) -> Result<(), String> {
    let prefs = gsm_settings::preferences::Preferences::new(&crate::desktop_services::paths_for(app).active);
    let mut profiles = prefs
        .get("gameLaunchProfiles")
        .ok()
        .flatten()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    profiles.insert(
        scene_id.to_owned(),
        serde_json::to_value(options).map_err(|e| e.to_string())?,
    );
    prefs
        .patch(&json!({ "gameLaunchProfiles": profiles }))
        .map(|_| ())
}

fn legacy_yuzu_defaults(app: &tauri::AppHandle, scene_id: &str) -> Option<GameLaunchOptions> {
    let prefs = gsm_settings::preferences::Preferences::new(&crate::desktop_services::paths_for(app).active);
    let config = prefs.get("yuzu").ok().flatten()?;
    let emu_path = config.get("emuPath").and_then(Value::as_str)?.trim().to_owned();
    let roms_path = config.get("romsPath").and_then(Value::as_str)?.trim().to_owned();
    let title_id = config
        .get("games")
        .and_then(Value::as_array)?
        .iter()
        .find(|game| game["scene"]["id"].as_str() == Some(scene_id))
        .and_then(|game| game.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    if emu_path.is_empty() || roms_path.is_empty() {
        return None;
    }
    let needle = format!("[{}]", title_id.to_lowercase());
    let entries = std::fs::read_dir(&roms_path).ok()?;
    let mut matches = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.contains(&needle) {
                matches.push(path.to_string_lossy().into_owned());
            }
        }
    }
    if matches.len() != 1 {
        return None;
    }
    Some(GameLaunchOptions {
        mode: "yuzu".into(),
        executable_path: emu_path,
        rom_path: matches.remove(0),
        ..Default::default()
    })
}

pub async fn get_options(app: &tauri::AppHandle, scene_id_raw: &str) -> GameLaunchOptions {
    let Ok(scene_id) = validate_scene_id(scene_id_raw) else {
        return GameLaunchOptions::default();
    };
    let saved = load_profile(app, &scene_id);
    if let Some(opts) = &saved {
        if !opts.executable_path.is_empty() {
            return opts.clone();
        }
    }
    if let Some(yuzu) = legacy_yuzu_defaults(app, &scene_id) {
        return yuzu;
    }
    let gen = app
        .state::<GameLauncher>()
        .0
        .lock()
        .unwrap()
        .generations
        .get(&scene_id)
        .copied()
        .unwrap_or(0);
    let detected = if cfg!(windows) {
        detect_executable(app, &scene_id).await
    } else {
        None
    };
    let Some(path) = detected else {
        return saved.unwrap_or_default();
    };
    // Guard against concurrent manual save while detection was in flight.
    let current_gen = app
        .state::<GameLauncher>()
        .0
        .lock()
        .unwrap()
        .generations
        .get(&scene_id)
        .copied()
        .unwrap_or(0);
    if current_gen != gen {
        return load_profile(app, &scene_id).unwrap_or_else(|| saved.unwrap_or_default());
    }
    let mut merged = saved.unwrap_or_default();
    merged.executable_path = path;
    let _ = save_profile(app, &scene_id, &merged);
    merged
}

pub fn save_options(
    app: &tauri::AppHandle,
    scene_id_raw: &str,
    raw: &Value,
) -> Result<GameLaunchOptions, LaunchError> {
    if !cfg!(windows) {
        return Err(LaunchError::code("unsupported"));
    }
    let scene_id = validate_scene_id(scene_id_raw)?;
    let options = normalize_options(raw);
    let _ = build_game_launch_command(&options)?;
    {
        let gl = app.state::<GameLauncher>();
        let mut guard = gl.0.lock().unwrap();
        let next = guard.generations.get(&scene_id).copied().unwrap_or(0) + 1;
        guard.generations.insert(scene_id.clone(), next);
    }
    save_profile(app, &scene_id, &options).map_err(LaunchError::failed)?;
    Ok(options)
}

pub async fn launch(app: &tauri::AppHandle, scene_id_raw: &str) -> GameLaunchResult {
    if !cfg!(windows) {
        return LaunchError::code("unsupported").into_result();
    }
    let scene_id = match validate_scene_id(scene_id_raw) {
        Ok(id) => id,
        Err(err) => return err.into_result(),
    };
    {
        let gl = app.state::<GameLauncher>();
        let mut guard = gl.0.lock().unwrap();
        if !guard.launching.insert(scene_id.clone()) {
            return LaunchError::failed("Launch already in progress for this scene.").into_result();
        }
    }
    let res = launch_inner(app, &scene_id).await;
    app.state::<GameLauncher>()
        .0
        .lock()
        .unwrap()
        .launching
        .remove(&scene_id);
    match res {
        Ok(_pid) => GameLaunchResult {
            success: true,
            code: None,
            error: None,
        },
        Err(err) => err.into_result(),
    }
}

async fn launch_inner(app: &tauri::AppHandle, scene_id: &str) -> Result<u32, LaunchError> {
    let options = get_options(app, scene_id).await;
    if options.executable_path.is_empty() || !Path::new(&options.executable_path).is_file() {
        return Err(LaunchError::code("missingExecutable"));
    }
    if options.mode == "yuzu"
        && (options.rom_path.is_empty() || !Path::new(&options.rom_path).is_file())
    {
        return Err(LaunchError::code("missingRom"));
    }
    if !options.launcher_path.is_empty() && !Path::new(&options.launcher_path).is_file() {
        return Err(LaunchError::code("missingLauncher"));
    }
    if !options.working_directory.is_empty()
        && !Path::new(&options.working_directory).is_dir()
    {
        return Err(LaunchError::code("invalidWorkingDirectory"));
    }
    let command = build_game_launch_command(&options)?;
    #[cfg(windows)]
    let command = tauri::async_runtime::spawn_blocking(move || {
        let mut command = command;
        steam::route_launch(&options, &mut command, || {
            steamlocate::SteamDir::locate().ok()
        });
        command
    })
    .await
    .map_err(|e| LaunchError::failed(e.to_string()))?;
    if crate::game_privileges::current_process_is_elevated() == Some(true) {
        launch_via_desktop_com(command).await
    } else {
        tauri::async_runtime::spawn_blocking(move || spawn_direct(&command))
            .await
            .map_err(|e| LaunchError::failed(e.to_string()))?
    }
}

fn spawn_direct(command: &GameLaunchCommand) -> Result<u32, LaunchError> {
    let mut cmd = Command::new(&command.executable);
    cmd.args(&command.args);
    if !command.cwd.is_empty() && Path::new(&command.cwd).is_dir() {
        cmd.current_dir(&command.cwd);
    }
    let child = cmd.spawn().map_err(|e| LaunchError::failed(e.to_string()))?;
    Ok(child.id())
}

#[cfg(windows)]
fn dispatch_explorer_shell_execute(
    executable: &Path,
    params: &str,
    cwd: &Path,
) -> Result<(), String> {
    use windows::core::{Interface, BSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Shell::{
        IShellDispatch2, IShellFolderViewDual2, IShellWindows, IWebBrowserApp, ShellWindows,
        CSIDL_DESKTOP, SWC_DESKTOP, SWFO_NEEDDISPATCH,
    };

    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let _guard = ComGuard(hr.is_ok());
        if hr.is_err() && hr != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
            return Err(format!("COM initialization failed: {hr:?}"));
        }
        let windows: IShellWindows =
            CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let mut hwnd = HWND::default();
        let disp = windows
            .FindWindowSW(
                &VARIANT::from(CSIDL_DESKTOP as i32),
                &VARIANT::default(),
                SWC_DESKTOP,
                &mut hwnd as *mut HWND as *mut i32,
                SWFO_NEEDDISPATCH,
            )
            .map_err(|_| "No desktop user is available to launch the game.".to_owned())?;
        let browser: IWebBrowserApp = disp
            .cast()
            .map_err(|_| "No desktop user is available to launch the game.".to_owned())?;
        let doc = browser
            .Document()
            .map_err(|_| "No desktop user is available to launch the game.".to_owned())?;
        let folder_view: IShellFolderViewDual2 = doc
            .cast()
            .map_err(|_| "No desktop user is available to launch the game.".to_owned())?;
        let app_disp = folder_view
            .Application()
            .map_err(|_| "No desktop user is available to launch the game.".to_owned())?;
        let shell: IShellDispatch2 = app_disp
            .cast()
            .map_err(|_| "No desktop user is available to launch the game.".to_owned())?;

        let file_bstr = BSTR::from(executable.to_string_lossy().as_ref());
        let args_var = VARIANT::from(BSTR::from(params));
        let dir_var = VARIANT::from(BSTR::from(cwd.to_string_lossy().as_ref()));
        let op_var = VARIANT::from(BSTR::from("open"));
        let show_var = VARIANT::from(0i32);
        shell
            .ShellExecute(&file_bstr, &args_var, &dir_var, &op_var, &show_var)
            .map_err(|e| format!("Desktop shell launch failed: {e}"))?;
        Ok(())
    }
}

#[cfg(windows)]
async fn launch_via_desktop_com(command: GameLaunchCommand) -> Result<u32, LaunchError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let helper_exe = crate::game_privileges::resolved_executable_for_relaunch()
        .map_err(LaunchError::failed)?;
    let workdir = helper_exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| LaunchError::failed(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| LaunchError::failed(e.to_string()))?
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let launch_args = crate::game_privileges::join_windows_command_line(&[
        "--unelevated-launch".into(),
        port.to_string(),
        token.clone(),
    ]);

    std::thread::Builder::new()
        .name("gsm-com-launch".into())
        .spawn(move || dispatch_explorer_shell_execute(&helper_exe, &launch_args, &workdir))
        .map_err(|e| LaunchError::failed(e.to_string()))?;

    let (stream, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .map_err(|_| LaunchError::failed("The desktop launcher did not respond in time."))?
        .map_err(|e| LaunchError::failed(e.to_string()))?;

    let (reader_half, mut writer_half) = stream.into_split();
    let mut reader = BufReader::new(reader_half);

    let mut auth_line = String::new();
    tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut auth_line))
        .await
        .map_err(|_| LaunchError::failed("Desktop launcher authentication timed out."))?
        .map_err(|e| LaunchError::failed(e.to_string()))?;
    if auth_line.trim() != token {
        return Err(LaunchError::failed(
            "Desktop launcher authentication failed.",
        ));
    }

    let payload = json!({
        "executable": command.executable,
        "args": command.args,
        "cwd": command.cwd,
    });
    let mut encoded = serde_json::to_vec(&payload).map_err(|e| LaunchError::failed(e.to_string()))?;
    encoded.push(b'\n');
    writer_half
        .write_all(&encoded)
        .await
        .map_err(|e| LaunchError::failed(e.to_string()))?;
    writer_half
        .flush()
        .await
        .map_err(|e| LaunchError::failed(e.to_string()))?;

    let mut reply_line = String::new();
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut reply_line))
        .await
        .map_err(|_| LaunchError::failed("Timed out waiting for launched game status."))?
        .map_err(|e| LaunchError::failed(e.to_string()))?;

    let response: Value = serde_json::from_str(reply_line.trim())
        .map_err(|_| LaunchError::failed("Invalid response from Windows game launcher."))?;
    if let Some(error) = response.get("error").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Err(LaunchError::failed(error));
    }
    let Some(pid) = response.get("pid").and_then(Value::as_u64).filter(|p| *p > 0) else {
        return Err(LaunchError::failed(
            "Invalid game process ID from Windows launcher.",
        ));
    };
    Ok(pid as u32)
}

#[cfg(not(windows))]
async fn launch_via_desktop_com(command: GameLaunchCommand) -> Result<u32, LaunchError> {
    spawn_direct(&command)
}

/// Invoked at the very start of `main()` when Explorer launches an elevated
/// session's one-shot unelevated helper. Must return fast without initializing Tauri.
pub fn maybe_run_unelevated_helper(args: &[String]) -> Option<i32> {
    let idx = args.iter().position(|arg| arg == "--unelevated-launch")?;
    let port: u16 = args.get(idx + 1)?.parse().ok()?;
    let token = args.get(idx + 2)?;
    let code = match run_unelevated_helper(port, token) {
        Ok(()) => 0,
        Err(_) => 1,
    };
    Some(code)
}

fn run_unelevated_helper(port: u16, token: &str) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;

    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().map_err(|e| format!("{e}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.write_all(format!("{token}\n").as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut spec_line = String::new();
    reader.read_line(&mut spec_line).map_err(|e| e.to_string())?;
    let spec: Value = serde_json::from_str(spec_line.trim()).map_err(|e| e.to_string())?;
    let executable = spec["executable"].as_str().unwrap_or("");
    let cwd = spec["cwd"].as_str().unwrap_or("");
    let args: Vec<String> = spec["args"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let cmd = GameLaunchCommand {
        executable: executable.to_owned(),
        args,
        cwd: cwd.to_owned(),
    };
    let reply = match spawn_direct(&cmd) {
        Ok(pid) => json!({ "pid": pid }),
        Err(err) => json!({ "error": err.message.unwrap_or_else(|| err.code.to_owned()) }),
    };
    let mut out = serde_json::to_vec(&reply).map_err(|e| e.to_string())?;
    out.push(b'\n');
    stream.write_all(&out).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn handle_ipc(
    app: &tauri::AppHandle,
    _label: &str,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    let scene_id = args.first().and_then(Value::as_str).unwrap_or("");
    match channel {
        "game-launcher.getOptions" => {
            let options = get_options(app, scene_id).await;
            serde_json::to_value(options).map_err(|e| e.to_string())
        }
        "game-launcher.detect" => {
            if !cfg!(windows) {
                return Ok(Value::Null);
            }
            Ok(detect_executable(app, scene_id)
                .await
                .map(Value::String)
                .unwrap_or(Value::Null))
        }
        "game-launcher.save" => {
            let raw = args.get(1).cloned().unwrap_or(Value::Null);
            let res = match save_options(app, scene_id, &raw) {
                Ok(_) => GameLaunchResult {
                    success: true,
                    code: None,
                    error: None,
                },
                Err(err) => err.into_result(),
            };
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "game-launcher.launch" => {
            let res = launch(app, scene_id).await;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "game-launcher.browse" => {
            let kind = args.first().and_then(Value::as_str).unwrap_or("executable");
            if !cfg!(windows) {
                return Err("Game launching is only supported on Windows (unsupported).".into());
            }
            let params = match kind {
                "directory" => json!({ "properties": ["openDirectory"] }),
                "rom" => json!({
                    "properties": ["openFile"],
                    "filters": [
                        { "name": "Switch ROM", "extensions": ["nsp", "xci", "nca", "nro", "nso"] },
                        { "name": "All files", "extensions": ["*"] },
                    ]
                }),
                _ => json!({
                    "properties": ["openFile"],
                    "filters": [
                        { "name": "Windows executable", "extensions": ["exe", "com"] },
                        { "name": "All files", "extensions": ["*"] },
                    ]
                }),
            };
            let result = crate::native::dialog_open(&params).await?;
            let path = if result["canceled"] == true {
                Value::Null
            } else {
                result["filePaths"][0].clone()
            };
            Ok(path)
        }
        _ => Err(format!("Unknown game-launcher channel: {channel}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn splits_commands_and_expands_launcher_templates() {
        assert_eq!(
            split_windows_command_line(r#"--title "月姫 & friends" "" --flag=$VALUE"#),
            vec!["--title", "月姫 & friends", "", "--flag=$VALUE"]
        );

        let game = r"C:\Games\月姫 Remake\game.exe";
        let launcher = r"C:\Tools\Locale Emulator\LEProc.exe";
        let opts = GameLaunchOptions {
            mode: "executable".into(),
            executable_path: game.into(),
            rom_path: String::new(),
            arguments: r#"--save "D:\Save Files" --literal={game}"#.into(),
            working_directory: r"D:\Working Folder".into(),
            launcher_path: launcher.into(),
            launcher_arguments: r#"-run "{game}" {args}"#.into(),
        };
        let built = build_game_launch_command(&opts).unwrap();
        assert_eq!(built.executable, launcher);
        assert_eq!(
            built.args,
            vec!["-run", game, "--save", r"D:\Save Files", "--literal={game}"]
        );
        assert_eq!(built.cwd, r"D:\Working Folder");

        let bad = GameLaunchOptions {
            launcher_path: launcher.into(),
            launcher_arguments: "--args={args}".into(),
            ..opts.clone()
        };
        assert_eq!(
            build_game_launch_command(&bad).unwrap_err().code,
            "invalidArguments"
        );
    }

    #[test]
    fn matches_unique_captured_window_path() {
        let game = r"C:\Games\月姫 Remake\game.exe".to_owned();
        let windows = vec![
            (game.clone(), "月姫".to_owned()),
            (r"D:\Other\game.exe".to_owned(), "Other game".to_owned()),
        ];
        assert_eq!(choose_game_executable(&windows, "GAME.EXE", "月姫"), Some(game.clone()));
        assert_eq!(choose_game_executable(&windows, "game.exe", "Unknown"), None);
        assert_eq!(choose_game_executable(&windows, "different.exe", "月姫"), None);
        assert_eq!(
            choose_game_executable(
                &[
                    (game.clone(), "Game".into()),
                    (game.to_uppercase(), "Options".into()),
                    ("game.exe".into(), "Game".into()),
                ],
                "game.exe",
                ""
            ),
            Some(game)
        );
    }

    #[test]
    fn command_split_and_launch_build_benchmark() {
        let opts = GameLaunchOptions {
            mode: "yuzu".into(),
            executable_path: r"C:\Yuzu\yuzu.exe".into(),
            rom_path: r"D:\ROMs\Game [0100ABCD].nsp".into(),
            arguments: r#"--fullscreen --lang "ja-JP" --extra "a \"b\" c""#.into(),
            working_directory: String::new(),
            launcher_path: r"C:\Tools\LEProc.exe".into(),
            launcher_arguments: r#"-run "{game}" {args}"#.into(),
        };
        let t0 = Instant::now();
        for _ in 0..10_000 {
            let cmd = build_game_launch_command(&opts).unwrap();
            std::hint::black_box(cmd);
        }
        let ns = t0.elapsed().as_secs_f64() * 1_000_000_000.0 / 10_000.0;
        println!("[bench] build_game_launch_command ns_per_call={ns:.1}");
    }
}
