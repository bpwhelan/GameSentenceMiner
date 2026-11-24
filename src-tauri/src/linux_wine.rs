//! Linux Wine/Proton/UMU/Bottles launch resolution and Flatpak sandbox diagnostics.
//!
//! A Windows hooker must run under the same Wine/Proton installation and prefix as
//! the target game. When the game is sandboxed inside Flatpak (such as Bottles
//! Flatpak), we inspect `/proc`, `bottle.yml`, sanitized runtime paths, and
//! host `wineserver` socket reachability before spawning any helper.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LauncherKind {
    Wine,
    Umu,
}

impl LauncherKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wine => "wine",
            Self::Umu => "umu",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WineLaunchContext {
    pub linux_pid: u32,
    pub wine_prefix: String,
    pub launcher_path: String,
    pub launcher_kind: LauncherKind,
    pub env: BTreeMap<String, String>,
    pub flatpak_id: Option<String>,
    pub environ_unreadable: bool,
    pub wineserver_reachable: Option<bool>,
    pub sandbox_blocked_reason: Option<String>,
}

impl WineLaunchContext {
    pub fn to_json(&self) -> Value {
        json!({
            "linuxPid": self.linux_pid,
            "winePrefix": self.wine_prefix,
            "launcherPath": self.launcher_path,
            "launcherKind": self.launcher_kind.as_str(),
            "env": self.env,
        })
    }
}

// Explicit allowlist: Proton/Wine container variables must come from the target
// game's environment rather than GSM's own process environment.
const WINE_ENV_KEYS: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "PWD",
    "LANG",
    "LANGUAGE",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
    "XDG_CONFIG_DIRS",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "WINE",
    "WINEPREFIX",
    "WINELOADER",
    "WINELOADERNOEXEC",
    "WINESERVER",
    "WINEDLLPATH",
    "WINEDLLOVERRIDES",
    "WINEFSYNC",
    "WINEESYNC",
    "WINEDEBUG",
    "WINEARCH",
    "WINE_CRASH_REPORT_DIR",
    "WINE_LARGE_ADDRESS_AWARE",
    "WINEPRELOADRESERVE",
    "WINE_GST_REGISTRY_DIR",
    "PROTONPATH",
    "PROTON_VERB",
    "PROTON_LOG",
    "PROTON_DUMP_DEBUG_COMMANDS",
    "PROTON_CRASH_REPORT_DIR",
    "PROTONFIXES_DISABLE",
    "GAMEID",
    "STORE",
    "UMU_ID",
    "UMU_LOG",
    "UMU_RUNTIME_UPDATE",
    "UMU_FOLDERS_PATH",
    "UMU_CONTAINER_NSENTER",
    "UMU_NO_RUNTIME",
    "STEAM_COMPAT_PROTON",
    "STEAM_COMPAT_APP_ID",
    "STEAM_COMPAT_CLIENT_INSTALL_PATH",
    "STEAM_COMPAT_DATA_PATH",
    "STEAM_COMPAT_INSTALL_PATH",
    "STEAM_COMPAT_MOUNTS",
    "STEAM_COMPAT_TOOL_PATHS",
    "STEAM_COMPAT_FLAGS",
    "STEAM_COMPAT_LIBRARY_PATHS",
    "STEAM_COMPAT_SHADER_PATH",
    "STEAM_COMPAT_TRANSCODED_MEDIA_PATH",
    "STEAM_COMPAT_MEDIA_PATH",
    "STEAM_COMPAT_RUNTIME",
    "PROTON_USE_XALIA",
    "STEAM_RUNTIME",
    "STEAM_RUNTIME_LIBRARY_PATH",
    "STEAM_RUNTIME_LIBRARY_PATHS",
    "PRESSURE_VESSEL_APP_LAUNCHER",
    "PRESSURE_VESSEL_APPID",
    "PRESSURE_VESSEL_FILESYSTEMS",
    "PRESSURE_VESSEL_RUNTIME",
    "PRESSURE_VESSEL_RUNTIME_BASE",
    "PRESSURE_VESSEL_SHELL",
    "PRESSURE_VESSEL_IMPORT_VARS",
    "PRESSURE_VESSEL_EXPORT_VARS",
    "PRESSURE_VESSEL_VERBOSE",
    "PRESSURE_VESSEL_ARCHITECTURES",
    "PRESSURE_VESSEL_COPY_RUNTIME",
    "LD_LIBRARY_PATH",
    "DXVK_ASYNC",
    "DXVK_CONFIG_FILE",
    "DXVK_CONFIG",
    "DXVK_HUD",
    "DXVK_LOG_PATH",
    "VKD3D_CONFIG",
    "VKD3D_DEBUG",
    "VKD3D_FEATURE_LEVEL",
    "VKD3D_SHADER_DEBUG",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_PATH_1_0",
];

pub const LAUNCHER_COMMS: &[&str] = &[
    "wine",
    "wine64",
    "wineserver",
    "wine-preloader",
    "wine64-preloader",
    "winedevice.exe",
    "services.exe",
    "plugplay.exe",
    "svchost.exe",
    "rpcss.exe",
    "conhost.exe",
    "explorer.exe",
    "start.exe",
    "steam.exe",
    "steamwebhelper",
    "gameoverlayui",
    "pv-bwrap",
    "pv-adverb",
    "pressure-vessel-wrap",
    "bwrap",
    "flatpak",
    "bottles",
    "bottles-cli",
    "reaper",
    "proton",
    "python",
    "python3",
    "umu-run",
    "umu",
];

pub fn basename_lower(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub fn is_launcher_comm(comm_lower: &str) -> bool {
    LAUNCHER_COMMS.contains(&comm_lower)
}

pub fn cmdline_matches_exe(cmdline: &[String], comm: &str, target_basename: &str) -> bool {
    if target_basename.is_empty() {
        return false;
    }
    let normalized_comm = comm.trim().to_ascii_lowercase();
    if normalized_comm == target_basename {
        return true;
    }
    // /proc/<pid>/comm is truncated to 15 bytes on Linux.
    if !normalized_comm.is_empty()
        && normalized_comm.len() >= 15
        && target_basename.starts_with(&normalized_comm)
    {
        return true;
    }
    cmdline
        .iter()
        .any(|arg| basename_lower(arg) == target_basename)
}

fn split_nul_strings(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

pub fn read_proc_cmdline(pid: u32, proc_root: &Path) -> Vec<String> {
    fs::read(proc_root.join(pid.to_string()).join("cmdline"))
        .map(|b| split_nul_strings(&b))
        .unwrap_or_default()
}

pub fn read_proc_comm(pid: u32, proc_root: &Path) -> String {
    fs::read_to_string(proc_root.join(pid.to_string()).join("comm"))
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

pub fn read_proc_environ(
    pid: u32,
    proc_root: &Path,
) -> Result<BTreeMap<String, String>, std::io::Error> {
    let bytes = fs::read(proc_root.join(pid.to_string()).join("environ"))?;
    let mut env = BTreeMap::new();
    for entry in split_nul_strings(&bytes) {
        if let Some((k, v)) = entry.split_once('=') {
            if !k.is_empty() {
                env.insert(k.to_owned(), v.to_owned());
            }
        }
    }
    Ok(env)
}

pub fn read_proc_resident_pages(pid: u32, proc_root: &Path) -> u64 {
    let Ok(statm) = fs::read_to_string(proc_root.join(pid.to_string()).join("statm")) else {
        return 0;
    };
    statm
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
}

fn read_proc_parent_pid(pid: u32, proc_root: &Path) -> Option<u32> {
    let stat = fs::read_to_string(proc_root.join(pid.to_string()).join("stat")).ok()?;
    let close = stat.rfind(')')?;
    let ppid = stat
        .get(close + 1..)?
        .split_whitespace()
        .nth(1)?
        .parse::<u32>()
        .ok()?;
    (ppid > 0 && ppid != pid).then_some(ppid)
}

pub fn find_linux_game_pid(exe_path: &str, proc_root: &Path, self_pid: u32) -> Option<u32> {
    let target_basename = basename_lower(exe_path);
    if target_basename.is_empty() {
        return None;
    }
    let Ok(entries) = fs::read_dir(proc_root) else {
        return None;
    };

    let mut best: Option<(u64, u32)> = None;
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        let comm = read_proc_comm(pid, proc_root);
        let cmdline = read_proc_cmdline(pid, proc_root);
        if (cmdline.is_empty() && comm.is_empty())
            || !cmdline_matches_exe(&cmdline, &comm, &target_basename)
        {
            continue;
        }
        let comm_lower = comm.to_ascii_lowercase();
        if is_launcher_comm(&comm_lower) && comm_lower != target_basename {
            continue;
        }
        let rss = read_proc_resident_pages(pid, proc_root);
        if best.is_none_or(|(best_rss, _)| rss > best_rss) {
            best = Some((rss, pid));
        }
    }
    best.map(|(_, pid)| pid)
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn resolve_from_path(command: &str, search_path: &str) -> Option<PathBuf> {
    if command.is_empty() {
        return None;
    }
    let p = Path::new(command);
    if p.is_absolute() {
        return Some(p.to_path_buf());
    }
    for dir in search_path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn existing_executable(value: &str, search_path: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let candidate = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        resolve_from_path(value, search_path)?
    };
    is_executable_file(&candidate).then(|| candidate.to_string_lossy().into_owned())
}

fn is_flatpak_internal_path(value: &str) -> bool {
    value == "/app"
        || value.starts_with("/app/")
        || value.starts_with("/usr/lib/extensions/")
}

fn candidate_wine_paths(root: &str) -> Vec<PathBuf> {
    if root.is_empty() {
        return Vec::new();
    }
    let base = Path::new(root);
    vec![
        base.join("bin").join("wine"),
        base.join("files").join("bin").join("wine"),
        base.join("dist").join("bin").join("wine"),
        base.join("bin").join("wine64"),
        base.join("files").join("bin").join("wine64"),
        base.join("dist").join("bin").join("wine64"),
    ]
}

fn derive_wine_from_tool_paths(env: &BTreeMap<String, String>, search_path: &str) -> Option<String> {
    for key in ["PROTONPATH", "STEAM_COMPAT_TOOL_PATHS", "STEAM_COMPAT_MOUNTS"] {
        if let Some(val) = env.get(key) {
            for root in val.split(':').filter(|s| !s.is_empty()) {
                for candidate in candidate_wine_paths(root) {
                    let s = candidate.to_string_lossy();
                    if let Some(found) = existing_executable(&s, search_path) {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

fn parse_bottle_runner_name(yaml: &str) -> Option<String> {
    for raw_line in yaml.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("Runner:") {
            let value = rest
                .trim()
                .trim_matches(|c| c == '\'' || c == '"')
                .trim();
            if !value.is_empty() && !value.eq_ignore_ascii_case("null") {
                return Some(value.to_owned());
            }
        }
    }
    None
}

fn derive_bottles_runner_wine(
    wine_prefix: &str,
    game_env: &BTreeMap<String, String>,
    search_path: &str,
) -> Option<String> {
    if wine_prefix.is_empty() {
        return None;
    }
    let prefix_path = Path::new(wine_prefix);
    let bottle_yml = fs::read_to_string(prefix_path.join("bottle.yml")).ok()?;
    let runner_name = parse_bottle_runner_name(&bottle_yml)?;

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(parent) = prefix_path.parent() {
        if parent
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("bottles"))
        {
            if let Some(grandparent) = parent.parent() {
                roots.push(grandparent.to_path_buf());
            }
        }
    }
    for key in ["XDG_DATA_HOME", "HOST_XDG_DATA_HOME"] {
        if let Some(xdg) = game_env.get(key).filter(|s| !s.is_empty()) {
            roots.push(Path::new(xdg).join("bottles"));
        }
    }
    if let Some(home) = game_env.get("HOME").filter(|s| !s.is_empty()) {
        roots.push(
            Path::new(home)
                .join(".var")
                .join("app")
                .join("com.usebottles.bottles")
                .join("data")
                .join("bottles"),
        );
        roots.push(Path::new(home).join(".local").join("share").join("bottles"));
    }

    let mut seen = HashSet::new();
    for root in roots {
        if !seen.insert(root.clone()) {
            continue;
        }
        let runner_dir = root.join("runners").join(&runner_name);
        for candidate in candidate_wine_paths(&runner_dir.to_string_lossy()) {
            let s = candidate.to_string_lossy();
            if let Some(found) = existing_executable(&s, search_path) {
                return Some(found);
            }
        }
    }
    None
}

fn is_umu_command(value: &str) -> bool {
    let name = basename_lower(value);
    name == "umu-run" || name == "umu"
}

fn derive_umu_from_process(
    proc_root: &Path,
    linux_pid: u32,
    env: &BTreeMap<String, String>,
    search_path: &str,
) -> Option<String> {
    let mut launched_by_umu = false;
    for key in ["WINELOADER", "WINE"] {
        if let Some(value) = env.get(key) {
            if is_umu_command(value) {
                launched_by_umu = true;
                if let Some(launcher) = existing_executable(value, search_path) {
                    return Some(launcher);
                }
            }
        }
    }

    let mut current_pid = linux_pid;
    let mut visited = HashSet::new();
    for _ in 0..12 {
        if current_pid <= 1 || !visited.insert(current_pid) {
            break;
        }
        let Some(parent_pid) = read_proc_parent_pid(current_pid, proc_root) else {
            break;
        };
        current_pid = parent_pid;
        let comm = read_proc_comm(current_pid, proc_root).to_ascii_lowercase();
        let args = read_proc_cmdline(current_pid, proc_root);
        if is_umu_command(&comm) {
            launched_by_umu = true;
        }
        for arg in args.into_iter().filter(|a| is_umu_command(a)) {
            launched_by_umu = true;
            if let Some(launcher) = existing_executable(&arg, search_path) {
                return Some(launcher);
            }
        }
    }

    if !launched_by_umu {
        return None;
    }

    if let Some(found) = existing_executable("umu-run", search_path) {
        return Some(found);
    }
    for candidate in ["/usr/bin/umu-run", "/usr/local/bin/umu-run"] {
        if let Some(found) = existing_executable(candidate, search_path) {
            return Some(found);
        }
    }
    if let Some(home) = env.get("HOME").filter(|s| !s.is_empty()) {
        let local_umu = Path::new(home).join(".local/bin/umu-run");
        if let Some(found) = existing_executable(&local_umu.to_string_lossy(), search_path) {
            return Some(found);
        }
    }
    None
}

fn derive_wine_from_process(
    proc_root: &Path,
    linux_pid: u32,
    env: &BTreeMap<String, String>,
    wine_prefix: &str,
    search_path: &str,
) -> String {
    let mut fallback_env_loader: Option<String> = None;
    for key in ["WINELOADER", "WINE"] {
        if let Some(val) = env.get(key).filter(|s| !s.is_empty()) {
            if let Some(exec) = existing_executable(val, search_path) {
                return exec;
            }
            if fallback_env_loader.is_none() && !is_flatpak_internal_path(val) {
                let resolved = if Path::new(val).is_absolute() {
                    val.clone()
                } else {
                    resolve_from_path(val, search_path)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|| val.clone())
                };
                fallback_env_loader = Some(resolved);
            }
        }
    }

    if let Some(wineserver) = env
        .get("WINESERVER")
        .and_then(|s| existing_executable(s, search_path))
    {
        if let Some(parent) = Path::new(&wineserver).parent() {
            for name in ["wine", "wine64"] {
                let sibling = parent.join(name);
                if let Some(found) = existing_executable(&sibling.to_string_lossy(), search_path) {
                    return found;
                }
            }
        }
    }

    if let Some(from_tools) = derive_wine_from_tool_paths(env, search_path) {
        return from_tools;
    }

    if let Some(from_bottles) = derive_bottles_runner_wine(wine_prefix, env, search_path) {
        return from_bottles;
    }

    if let Ok(image) = fs::read_link(proc_root.join(linux_pid.to_string()).join("exe")) {
        if let Some(parent) = image.parent() {
            for name in ["wine", "wine64"] {
                let sibling = parent.join(name);
                if let Some(found) = existing_executable(&sibling.to_string_lossy(), search_path) {
                    return found;
                }
            }
        }
    }

    for name in ["wine", "wine64"] {
        if let Some(found) = existing_executable(name, search_path) {
            return found;
        }
    }

    fallback_env_loader.unwrap_or_default()
}

fn flatpak_app_from_path(raw: &str) -> Option<String> {
    let norm = raw.replace('\\', "/");
    let marker = "/.var/app/";
    let idx = norm.find(marker)?;
    let rest = &norm[idx + marker.len()..];
    let app_id = rest.split('/').next().unwrap_or("").trim();
    (!app_id.is_empty()).then(|| app_id.to_owned())
}

fn parse_flatpak_info_name(contents: &str) -> Option<String> {
    let mut in_app = false;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_app = line.eq_ignore_ascii_case("[Application]");
            continue;
        }
        if in_app {
            if let Some(name) = line.strip_prefix("name=") {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_owned());
                }
            }
        }
    }
    None
}

pub fn detect_flatpak_id(
    proc_root: &Path,
    linux_pid: u32,
    game_env: &BTreeMap<String, String>,
    wine_prefix: &str,
) -> Option<String> {
    if let Some(id) = game_env
        .get("FLATPAK_ID")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return Some(id.to_owned());
    }
    let mut saw_container_flatpak = game_env
        .get("container")
        .is_some_and(|v| v.trim() == "flatpak");

    let mut current_pid = linux_pid;
    let mut visited = HashSet::new();
    for _ in 0..12 {
        if current_pid <= 1 || !visited.insert(current_pid) {
            break;
        }
        let Some(parent_pid) = read_proc_parent_pid(current_pid, proc_root) else {
            break;
        };
        current_pid = parent_pid;
        if let Ok(parent_env) = read_proc_environ(current_pid, proc_root) {
            if let Some(id) = parent_env
                .get("FLATPAK_ID")
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                return Some(id.to_owned());
            }
            if parent_env
                .get("container")
                .is_some_and(|v| v.trim() == "flatpak")
            {
                saw_container_flatpak = true;
            }
        }
    }

    if let Some(id) = flatpak_app_from_path(wine_prefix) {
        return Some(id);
    }
    if let Some(xdg_data) = game_env.get("XDG_DATA_HOME") {
        if let Some(id) = flatpak_app_from_path(xdg_data) {
            return Some(id);
        }
    }

    if let Ok(info) =
        fs::read_to_string(proc_root.join(linux_pid.to_string()).join("root/.flatpak-info"))
    {
        if let Some(name) = parse_flatpak_info_name(&info) {
            return Some(name);
        }
    }

    saw_container_flatpak.then(|| "flatpak".to_owned())
}

fn sanitize_flatpak_host_env(env: &mut BTreeMap<String, String>, host_path: &str) {
    if let Some(ld) = env.get("LD_LIBRARY_PATH").cloned() {
        let filtered: Vec<&str> = ld
            .split(':')
            .filter(|entry| !entry.is_empty() && !is_flatpak_internal_path(entry))
            .collect();
        if filtered.is_empty() {
            env.remove("LD_LIBRARY_PATH");
        } else {
            env.insert("LD_LIBRARY_PATH".into(), filtered.join(":"));
        }
    }

    let mut path_entries: Vec<String> = env
        .get("PATH")
        .map(|p| {
            p.split(':')
                .filter(|entry| !entry.is_empty() && !is_flatpak_internal_path(entry))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    for entry in host_path.split(':').filter(|s| !s.is_empty()) {
        if !path_entries.iter().any(|existing| existing == entry) {
            path_entries.push(entry.to_owned());
        }
    }
    if path_entries.is_empty() {
        env.remove("PATH");
    } else {
        env.insert("PATH".into(), path_entries.join(":"));
    }
}

/// Map a Windows-style Wine drive path (e.g. `Z:\home\...` or `C:\game\game.exe`)
/// to its corresponding Linux host path for PE bitness detection.
pub fn resolve_wine_drive_path(exe_path: &str, wine_prefix: &str) -> PathBuf {
    let trimmed = exe_path.trim().trim_matches('"');
    let normalized = trimmed.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = normalized[3..].trim_start_matches('/');
        if !wine_prefix.trim().is_empty() {
            let prefix_dir = Path::new(wine_prefix.trim());
            let dosdevice_path = prefix_dir
                .join("dosdevices")
                .join(format!("{drive}:"))
                .join(rest);
            if dosdevice_path.exists() {
                return dosdevice_path;
            }
            if drive == 'c' {
                let drive_c_path = prefix_dir.join("drive_c").join(rest);
                if drive_c_path.exists() {
                    return drive_c_path;
                }
            }
        }
        if drive == 'z' {
            return PathBuf::from(format!("/{rest}"));
        }
    }
    PathBuf::from(trimmed)
}

pub fn wineserver_socket_exists_for_dev_ino(
    dev: u64,
    ino: u64,
    uid: u32,
    search_dirs: &[PathBuf],
) -> bool {
    let server_dir_name = format!("server-{dev:x}-{ino:x}");
    let wine_dir_name = format!(".wine-{uid}");
    for dir in search_dirs {
        let socket = dir.join(&wine_dir_name).join(&server_dir_name).join("socket");
        if fs::symlink_metadata(&socket).is_ok() {
            return true;
        }
    }
    false
}

fn wineserver_search_dirs(env: &BTreeMap<String, String>, host_tmp: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push_unique = |p: PathBuf| {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    };
    if let Some(tmp) = host_tmp {
        push_unique(tmp.to_path_buf());
    } else {
        push_unique(PathBuf::from("/tmp"));
    }
    for key in ["WINE_TMPDIR", "TMPDIR", "XDG_RUNTIME_DIR"] {
        if let Some(val) = env.get(key).filter(|s| !s.is_empty()) {
            let p = PathBuf::from(val);
            if p.is_dir() {
                push_unique(p);
            }
        }
    }
    dirs
}

#[cfg(target_os = "linux")]
fn check_host_wineserver_reachable(
    wine_prefix: &str,
    env: &BTreeMap<String, String>,
) -> Option<bool> {
    use std::os::unix::fs::MetadataExt;
    if wine_prefix.is_empty() {
        return None;
    }
    let meta = fs::metadata(wine_prefix).ok()?;
    let uid = rustix::process::geteuid().as_raw();
    let dirs = wineserver_search_dirs(env, None);
    Some(wineserver_socket_exists_for_dev_ino(
        meta.dev(),
        meta.ino(),
        uid,
        &dirs,
    ))
}

#[cfg(not(target_os = "linux"))]
fn check_host_wineserver_reachable(
    _wine_prefix: &str,
    _env: &BTreeMap<String, String>,
) -> Option<bool> {
    None
}

fn compute_sandbox_blocked_reason(
    flatpak_id: Option<&str>,
    launcher_kind: LauncherKind,
    environ_unreadable: bool,
    wineserver_reachable: Option<bool>,
) -> Option<String> {
    if environ_unreadable {
        return Some(
            "Could not read the running game's Linux process environment (/proc/<pid>/environ). \
             The game may be running inside an isolated container/Flatpak sandbox or under another user."
                .to_owned(),
        );
    }
    if let Some(id) = flatpak_id {
        if launcher_kind == LauncherKind::Wine && wineserver_reachable == Some(false) {
            let app_hint = if id == "com.usebottles.bottles" {
                "Bottles Flatpak (com.usebottles.bottles)"
            } else {
                id
            };
            return Some(format!(
                "This game is running inside {app_hint}, whose Flatpak sandbox isolates its wineserver \
                 socket (/tmp) and process namespace from the host. GSM cannot attach Agent, LunaHook, \
                 or Textractor across that sandbox boundary. Play the game outside Flatpak (Steam/Proton, \
                 native Lutris, native Bottles, or system Wine), or run standalone Agent/Textractor inside the same Bottle."
            ));
        }
    }
    None
}

pub fn enrich_flatpak_wine_error(launch: &WineLaunchContext, error: &str) -> String {
    let Some(id) = launch.flatpak_id.as_deref() else {
        return error.to_owned();
    };
    let lower = error.to_ascii_lowercase();
    if lower.contains("flatpak") || lower.contains("sandbox") {
        return error.to_owned();
    }
    if lower.contains("wine")
        || lower.contains("not found in the game's wine prefix")
        || lower.contains("could not find the game inside wine")
        || lower.contains("exited before connecting")
        || lower.contains("did not start")
    {
        return format!(
            "{error} — The game is running inside Flatpak ({id}), which commonly isolates wineserver \
             and PID namespaces from host GSM. Try running the game via Steam/Proton, native Lutris, \
             native Bottles, or system Wine, or run standalone Agent/Textractor inside the same Bottle."
        );
    }
    error.to_owned()
}

pub fn resolve_wine_launch(
    exe_path: &str,
    proc_root: &Path,
    self_pid: u32,
    linux_pid_override: Option<u32>,
) -> WineLaunchContext {
    let host_path = std::env::var("PATH").unwrap_or_default();
    resolve_wine_launch_with(
        exe_path,
        proc_root,
        self_pid,
        linux_pid_override,
        &host_path,
        check_host_wineserver_reachable,
    )
}

pub fn resolve_wine_launch_with(
    exe_path: &str,
    proc_root: &Path,
    self_pid: u32,
    linux_pid_override: Option<u32>,
    host_path: &str,
    socket_probe: impl FnOnce(&str, &BTreeMap<String, String>) -> Option<bool>,
) -> WineLaunchContext {
    let linux_pid = linux_pid_override
        .filter(|&pid| pid > 0)
        .or_else(|| find_linux_game_pid(exe_path, proc_root, self_pid))
        .unwrap_or(0);

    let (game_env, environ_unreadable) = if linux_pid > 0 {
        match read_proc_environ(linux_pid, proc_root) {
            Ok(env) => (env, false),
            Err(err) => {
                let unreadable = err.kind() == std::io::ErrorKind::PermissionDenied;
                (BTreeMap::new(), unreadable)
            }
        }
    } else {
        (BTreeMap::new(), false)
    };

    let mut env = BTreeMap::new();
    for key in WINE_ENV_KEYS {
        if let Some(value) = game_env.get(*key).filter(|v| !v.is_empty()) {
            env.insert((*key).to_owned(), value.clone());
        }
    }
    // Preserve locale overrides (e.g. LC_ALL=ja_JP.UTF-8) for Japanese VNs.
    for (key, value) in &game_env {
        if key.starts_with("LC_") && !value.is_empty() {
            env.insert(key.clone(), value.clone());
        }
    }

    let mut wine_prefix = env.get("WINEPREFIX").cloned().unwrap_or_default();
    if wine_prefix.is_empty() {
        if let Some(compat) = env.get("STEAM_COMPAT_DATA_PATH") {
            wine_prefix = Path::new(compat)
                .join("pfx")
                .to_string_lossy()
                .into_owned();
        }
    }
    if !wine_prefix.is_empty() {
        env.insert("WINEPREFIX".into(), wine_prefix.clone());
    }

    let flatpak_id = if linux_pid > 0 {
        detect_flatpak_id(proc_root, linux_pid, &game_env, &wine_prefix)
    } else {
        None
    };

    let search_path = match (env.get("PATH").map(String::as_str), host_path) {
        (Some(p), "") => p.to_owned(),
        (Some(p), h) => format!("{p}:{h}"),
        (None, h) => h.to_owned(),
    };

    let umu_runner = if linux_pid > 0 {
        derive_umu_from_process(proc_root, linux_pid, &game_env, &search_path)
    } else {
        None
    };
    let launcher_path = umu_runner.unwrap_or_else(|| {
        if linux_pid > 0 {
            derive_wine_from_process(proc_root, linux_pid, &game_env, &wine_prefix, &search_path)
        } else {
            String::new()
        }
    });
    let launcher_kind = if is_umu_command(&launcher_path) {
        LauncherKind::Umu
    } else {
        LauncherKind::Wine
    };

    if launcher_kind == LauncherKind::Umu {
        env.insert("PROTON_VERB".into(), "run".into());
        if !env.contains_key("UMU_FOLDERS_PATH") && flatpak_id.is_some() {
            let data_home = game_env
                .get("HOST_XDG_DATA_HOME")
                .filter(|s| !s.is_empty())
                .cloned()
                .or_else(|| {
                    env.get("HOME")
                        .filter(|s| !s.is_empty())
                        .map(|h| Path::new(h).join(".local/share").to_string_lossy().into_owned())
                });
            if let Some(dh) = data_home {
                env.insert("UMU_FOLDERS_PATH".into(), dh);
            }
        }
    } else if flatpak_id.is_some() {
        sanitize_flatpak_host_env(&mut env, host_path);
    }

    let wineserver_reachable = if linux_pid > 0 && flatpak_id.is_some() && launcher_kind == LauncherKind::Wine {
        socket_probe(&wine_prefix, &env)
    } else {
        None
    };

    let sandbox_blocked_reason = compute_sandbox_blocked_reason(
        flatpak_id.as_deref(),
        launcher_kind,
        environ_unreadable,
        wineserver_reachable,
    );

    WineLaunchContext {
        linux_pid,
        wine_prefix,
        launcher_path,
        launcher_kind,
        env,
        flatpak_id,
        environ_unreadable,
        wineserver_reachable,
        sandbox_blocked_reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_exec(path: &Path) -> String {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_string_lossy().into_owned()
    }

    fn write_proc(
        proc_root: &Path,
        pid: u32,
        cmdline: &[&str],
        comm: &str,
        environ: &[(&str, &str)],
        parent_pid: u32,
        resident_pages: u64,
    ) {
        let dir = proc_root.join(pid.to_string());
        fs::create_dir_all(&dir).unwrap();
        let cmd_bytes: Vec<u8> = cmdline
            .iter()
            .flat_map(|arg| arg.as_bytes().iter().copied().chain([0u8]))
            .collect();
        fs::write(dir.join("cmdline"), cmd_bytes).unwrap();
        fs::write(dir.join("comm"), format!("{comm}\n")).unwrap();
        let env_bytes: Vec<u8> = environ
            .iter()
            .flat_map(|(k, v)| format!("{k}={v}\0").into_bytes())
            .collect();
        fs::write(dir.join("environ"), env_bytes).unwrap();
        fs::write(
            dir.join("statm"),
            format!("{} {resident_pages} 0 0 0 0 0\n", resident_pages + 100),
        )
        .unwrap();
        fs::write(
            dir.join("stat"),
            format!("{pid} ({comm}) S {parent_pid} 0 0 0\n"),
        )
        .unwrap();
    }

    #[test]
    fn finds_highest_rss_game_pid_and_ignores_launchers_and_truncation() {
        let root = tempdir().unwrap();
        write_proc(root.path(), 100, &["LongGameExecutableName.exe"], "wineserver", &[], 1, 99999);
        write_proc(
            root.path(),
            101,
            &["Z:\\games\\LongGameExecutableName.exe"],
            "LongGameExecuta",
            &[],
            1,
            50,
        );
        write_proc(
            root.path(),
            102,
            &["Z:\\games\\LongGameExecutableName.exe"],
            "LongGameExecuta",
            &[],
            1,
            80000,
        );
        assert_eq!(
            find_linux_game_pid("LongGameExecutableName.exe", root.path(), 1),
            Some(102)
        );
        assert_eq!(find_linux_game_pid("LongGameExecutableName.exe", root.path(), 102), Some(101));
    }

    #[test]
    fn resolves_plain_wine_and_steam_proton_contexts() {
        let root = tempdir().unwrap();
        write_proc(
            root.path(),
            200,
            &["wine", "game.exe"],
            "game.exe",
            &[
                ("WINEPREFIX", "/home/u/.wine"),
                ("WINELOADER", "/opt/wine/bin/wine"),
                ("LC_ALL", "ja_JP.UTF-8"),
                ("SECRET", "do-not-copy"),
            ],
            1,
            5000,
        );
        let ctx = resolve_wine_launch_with("game.exe", root.path(), 1, None, "", |_, _| None);
        assert_eq!(ctx.linux_pid, 200);
        assert_eq!(ctx.wine_prefix, "/home/u/.wine");
        assert_eq!(ctx.launcher_path, "/opt/wine/bin/wine");
        assert_eq!(ctx.launcher_kind, LauncherKind::Wine);
        assert_eq!(ctx.env.get("LC_ALL").map(String::as_str), Some("ja_JP.UTF-8"));
        assert!(!ctx.env.contains_key("SECRET"));

        write_proc(
            root.path(),
            201,
            &["proton-game.exe"],
            "proton-game.exe",
            &[("STEAM_COMPAT_DATA_PATH", "/steam/compatdata/42")],
            1,
            5000,
        );
        let pctx = resolve_wine_launch_with("proton-game.exe", root.path(), 1, None, "", |_, _| None);
        assert_eq!(
            PathBuf::from(&pctx.wine_prefix),
            Path::new("/steam/compatdata/42").join("pfx")
        );
        assert_eq!(pctx.env.get("WINEPREFIX"), Some(&pctx.wine_prefix));
    }

    #[test]
    fn resolves_umu_and_flatpak_umu_folders_path() {
        let root = tempdir().unwrap();
        let umu = write_exec(&root.path().join("lutris/umu-run"));
        write_proc(
            root.path(),
            300,
            &["game.exe"],
            "game.exe",
            &[
                ("WINE", &umu),
                ("container", "flatpak"),
                ("FLATPAK_ID", "net.lutris.Lutris"),
                ("HOME", "/home/deck"),
                ("HOST_XDG_DATA_HOME", "/home/deck/.local/share"),
                ("XDG_DATA_HOME", "/home/deck/.var/app/net.lutris.Lutris/data"),
                ("PROTON_VERB", "waitforexitandrun"),
            ],
            1,
            5000,
        );
        let ctx = resolve_wine_launch_with("game.exe", root.path(), 1, None, "", |_, _| Some(false));
        assert_eq!(ctx.launcher_path, umu);
        assert_eq!(ctx.launcher_kind, LauncherKind::Umu);
        assert_eq!(ctx.env.get("PROTON_VERB").map(String::as_str), Some("run"));
        assert_eq!(
            ctx.env.get("UMU_FOLDERS_PATH").map(String::as_str),
            Some("/home/deck/.local/share")
        );
        // UMU launches from the host so it is NOT blocked even when FLATPAK_ID was inherited.
        assert!(ctx.sandbox_blocked_reason.is_none());
    }

    #[test]
    fn resolves_bottles_runner_and_blocks_isolated_bottles_flatpak_sandbox() {
        let root = tempdir().unwrap();
        let bottles_data = root.path().join("home/.var/app/com.usebottles.bottles/data/bottles");
        let prefix = bottles_data.join("bottles/VisualNovels");
        fs::create_dir_all(&prefix).unwrap();
        fs::write(prefix.join("bottle.yml"), "Name: VisualNovels\nRunner: soda-9.0-1\n").unwrap();
        let runner_wine = write_exec(
            &bottles_data
                .join("runners")
                .join("soda-9.0-1")
                .join("bin")
                .join("wine"),
        );
        let host_bin = root.path().join("usr-bin");
        write_exec(&host_bin.join("wine"));

        write_proc(
            root.path(),
            400,
            &["vn.exe"],
            "vn.exe",
            &[
                ("WINEPREFIX", &prefix.to_string_lossy()),
                ("WINELOADER", "/app/bin/wine"),
                ("PATH", "/app/bin:/usr/bin"),
                ("LD_LIBRARY_PATH", "/app/lib:/usr/lib/extensions/vulkan/lib:/usr/lib64"),
                ("FLATPAK_ID", "com.usebottles.bottles"),
                ("container", "flatpak"),
            ],
            1,
            5000,
        );

        let blocked = resolve_wine_launch_with(
            "vn.exe",
            root.path(),
            1,
            None,
            &host_bin.to_string_lossy(),
            |_, _| Some(false),
        );
        assert_eq!(blocked.flatpak_id.as_deref(), Some("com.usebottles.bottles"));
        assert_eq!(PathBuf::from(&blocked.launcher_path), PathBuf::from(&runner_wine));
        assert_eq!(blocked.launcher_kind, LauncherKind::Wine);
        assert_eq!(
            blocked.env.get("LD_LIBRARY_PATH").map(String::as_str),
            Some("/usr/lib64")
        );
        assert!(blocked
            .env
            .get("PATH")
            .is_some_and(|p| !p.contains("/app/bin") && p.contains(&*host_bin.to_string_lossy())));
        assert!(blocked
            .sandbox_blocked_reason
            .as_deref()
            .is_some_and(|msg| msg.contains("Bottles Flatpak") && msg.contains("wineserver")));

        // When wineserver socket IS reachable (e.g. host-shared /tmp), it proceeds without blocking.
        let allowed = resolve_wine_launch_with(
            "vn.exe",
            root.path(),
            1,
            None,
            &host_bin.to_string_lossy(),
            |_, _| Some(true),
        );
        assert!(allowed.sandbox_blocked_reason.is_none());
        let enriched = enrich_flatpak_wine_error(&allowed, "vn.exe was not found in the game's Wine prefix");
        assert!(enriched.contains("com.usebottles.bottles"));
    }

    #[test]
    fn detects_flatpak_from_var_app_prefix_and_parent_and_maps_wine_drive_paths() {
        let root = tempdir().unwrap();
        let prefix = root.path().join("home/.var/app/com.usebottles.bottles/data/bottles/bottles/VN");
        let drive_c = prefix.join("drive_c");
        fs::create_dir_all(drive_c.join("Games")).unwrap();
        let c_exe = drive_c.join("Games").join("MyGame.exe");
        fs::write(&c_exe, b"MZ").unwrap();

        write_proc(root.path(), 500, &["bwrap"], "bwrap", &[("FLATPAK_ID", "com.usebottles.bottles")], 1, 10);
        write_proc(
            root.path(),
            501,
            &["vn.exe"],
            "vn.exe",
            &[("WINEPREFIX", &prefix.to_string_lossy())],
            500,
            1000,
        );

        let ctx = resolve_wine_launch_with("vn.exe", root.path(), 1, None, "", |_, _| Some(false));
        assert_eq!(ctx.flatpak_id.as_deref(), Some("com.usebottles.bottles"));
        assert!(ctx.sandbox_blocked_reason.is_some());

        assert_eq!(
            resolve_wine_drive_path(r"C:\Games\MyGame.exe", &prefix.to_string_lossy()),
            c_exe
        );
        #[cfg(unix)]
        {
            let dos_c = prefix.join("dosdevices").join("c:");
            fs::create_dir_all(dos_c.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink("../drive_c", &dos_c).unwrap();
            assert_eq!(
                resolve_wine_drive_path(r"C:\Games\MyGame.exe", &prefix.to_string_lossy()),
                dos_c.join("Games").join("MyGame.exe")
            );
        }
        assert_eq!(
            resolve_wine_drive_path(r"Z:\home\deck\game.exe", &prefix.to_string_lossy()),
            PathBuf::from("/home/deck/game.exe")
        );
    }

    #[test]
    fn checks_wineserver_socket_reachability_by_dev_and_ino() {
        let dir = tempdir().unwrap();
        let tmp_dir = dir.path().join("tmp");
        let socket = tmp_dir.join(".wine-1000/server-fe01-1234abcd/socket");
        assert!(!wineserver_socket_exists_for_dev_ino(
            0xfe01,
            0x1234_abcd,
            1000,
            std::slice::from_ref(&tmp_dir)
        ));
        fs::create_dir_all(socket.parent().unwrap()).unwrap();
        fs::write(&socket, b"").unwrap();
        assert!(wineserver_socket_exists_for_dev_ino(
            0xfe01,
            0x1234_abcd,
            1000,
            std::slice::from_ref(&tmp_dir)
        ));
    }
}
