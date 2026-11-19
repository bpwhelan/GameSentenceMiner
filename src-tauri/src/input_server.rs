//! Native supervisor for the bundled `gsm_overlay_server` WebSocket input service.
use gsm_sudachi::{LanguageService, PipeReply, PipeRequest, PIPE_ENV, REPLY_PREFIX, REQUEST_PREFIX};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const INPUT_SERVER_HOST: &str = "127.0.0.1";
const INPUT_SERVER_READY_PREFIX: &str = "GSM_INPUT_SERVER_READY:";
const RESTART_DELAY: Duration = Duration::from_millis(1000);
const STOP_GRACE: Duration = Duration::from_millis(300);
type HelperStdin = Arc<Mutex<ChildStdin>>;

#[derive(Deserialize)]
struct ReadyPayload {
    host: String,
    port: u16,
}

#[derive(Default)]
struct InnerState {
    started: bool,
    stopping: bool,
    binary_path: Option<PathBuf>,
    port: Option<u16>,
    url: Option<String>,
    stdin: Option<HelperStdin>,
    child: Option<Arc<Mutex<Option<Child>>>>,
    running: bool,
}

struct Shared {
    state: Mutex<InnerState>,
    cv: Condvar,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            state: Mutex::new(InnerState::default()),
            cv: Condvar::new(),
        }
    }
}

#[derive(Clone, Default)]
pub struct InputServer(Arc<Shared>);

pub fn parse_ready_line(line: &str) -> Option<u16> {
    let trimmed = line.trim();
    let json_str = trimmed.strip_prefix(INPUT_SERVER_READY_PREFIX)?;
    let parsed: ReadyPayload = serde_json::from_str(json_str).ok()?;
    if parsed.host != INPUT_SERVER_HOST || parsed.port == 0 {
        return None;
    }
    Some(parsed.port)
}

fn platform_dir() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "gsm_overlay_server.exe"
    } else {
        "gsm_overlay_server"
    }
}

pub fn resolve_binary_in_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    resolve_binary_for_mode(roots, crate::LOCAL_BUILD)
}

fn resolve_binary_for_mode(roots: &[PathBuf], development: bool) -> Option<PathBuf> {
    let bin = binary_name();
    let plat = platform_dir();
    if development {
        // Source checkouts can retain helpers from older packaged releases that
        // do not implement the current keyboard/Sudachi message protocol.
        for root in roots {
            for profile in ["release", "debug"] {
                let candidate = root
                    .join("GSM_Overlay/input_server/target")
                    .join(profile)
                    .join(bin);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        return None;
    }
    for root in roots {
        for candidate in [
            root.join("GSM_Overlay").join(bin),
            root.join("GSM_Overlay/input_server/bin")
                .join(plat)
                .join(bin),
            root.join("GSM_Overlay/input_server/bin").join(bin),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    if crate::LOCAL_BUILD {
        if let Ok(exe) = std::env::current_exe() {
            #[cfg(all(windows, any(debug_assertions, feature = "local-build")))]
            let binary = match crate::dev_launch::helper_path(&exe, binary_name()) {
                Ok(binary) => binary,
                Err(error) => {
                    crate::desktop_log::warn(app, "input-server", format!("{error}"));
                    return None;
                }
            };
            #[cfg(not(all(windows, any(debug_assertions, feature = "local-build"))))]
            let binary = exe.with_file_name(binary_name());
            if binary.is_file() { return Some(binary); }
        }
    }
    let mut roots = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir);
    }
    if let Some(state) = app.try_state::<crate::desktop_state::DesktopState>() {
        if !roots.iter().any(|r| r == &state.app_root) {
            roots.push(state.app_root.clone());
        }
    }
    resolve_binary_in_roots(&roots)
}

pub fn start_background(app: &tauri::AppHandle) {
    let Some(server) = app.try_state::<InputServer>() else {
        return;
    };
    if let Ok(env_url) = std::env::var("GSM_INPUT_SERVER_URL") {
        if !env_url.trim().is_empty() && std::env::var("GSM_SMOKE_TEST").is_ok() {
            return;
        }
    }
    let Some(binary) = resolve_binary(app) else {
        crate::desktop_log::warn(
            app,
            "input-server",
            "Bundled gsm_overlay_server binary not found",
        );
        return;
    };
    let shared = server.0.clone();
    let paths = &app.state::<crate::settings::Settings>().paths;
    let env = service_environment(
        &paths.active,
        &gsm_packages::settings_backup::get_overlay_data_dir(&paths.active, paths.has_profile),
    );
    {
        let mut guard = shared.state.lock().unwrap();
        if guard.started || guard.stopping {
            return;
        }
        guard.started = true;
        guard.binary_path = Some(binary.clone());
    }
    let language = app.state::<Arc<LanguageService>>().inner().clone();
    let app_handle = app.clone();
    std::thread::Builder::new()
        .name("gsm-input-server".into())
        .spawn(move || supervisor_loop(Some(app_handle), shared, binary, env, language))
        .ok();
}

pub fn url(app: &tauri::AppHandle) -> Option<String> {
    app.try_state::<InputServer>()
        .and_then(|s| s.0.state.lock().ok().and_then(|g| g.url.clone()))
}

pub fn port(app: &tauri::AppHandle) -> Option<u16> {
    app.try_state::<InputServer>()
        .and_then(|s| s.0.state.lock().ok().and_then(|g| g.port))
}

pub fn wait_ready(app: &tauri::AppHandle, timeout: Duration) -> Option<(u16, String)> {
    let server = app.try_state::<InputServer>()?;
    let deadline = Instant::now() + timeout;
    let mut guard = server.0.state.lock().ok()?;
    loop {
        if let (Some(port), Some(url)) = (guard.port, guard.url.clone()) {
            return Some((port, url));
        }
        if guard.stopping || !guard.started {
            return None;
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return None;
        };
        let (next, res) = server.0.cv.wait_timeout(guard, remaining).ok()?;
        guard = next;
        if res.timed_out() && guard.url.is_none() {
            return None;
        }
    }
}

pub fn apply_env(app: &tauri::AppHandle, env: &mut HashMap<String, String>) {
    let Some(server) = app.try_state::<InputServer>() else {
        return;
    };
    let Ok(guard) = server.0.state.lock() else {
        return;
    };
    if let (Some(port), Some(url)) = (guard.port, guard.url.as_ref()) {
        env.insert("GSM_INPUT_SERVER_MANAGED".into(), "1".into());
        env.insert("GSM_INPUT_SERVER_PORT".into(), port.to_string());
        env.insert("GSM_INPUT_SERVER_URL".into(), url.clone());
    }
}

pub fn stop(app: &tauri::AppHandle) {
    let Some(server) = app.try_state::<InputServer>() else {
        return;
    };
    stop_shared(&server.0);
}

fn stop_shared(shared: &Arc<Shared>) {
    let (stdin, child_ref) = {
        let mut guard = shared.state.lock().unwrap();
        guard.stopping = true;
        guard.port = None;
        guard.url = None;
        shared.cv.notify_all();
        (guard.stdin.take(), guard.child.clone())
    };
    if let Some(pipe) = stdin {
        let mut pipe = pipe.lock().unwrap();
        let _ = pipe.write_all(b"quit\n");
        let _ = pipe.flush();
    }
    let deadline = Instant::now() + STOP_GRACE;
    {
        let mut guard = shared.state.lock().unwrap();
        while guard.running {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let (next, _) = shared.cv.wait_timeout(guard, remaining).unwrap();
            guard = next;
        }
    }
    if let Some(child_arc) = child_ref {
        if let Ok(mut slot) = child_arc.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn service_environment(data: &Path, overlay: &Path) -> HashMap<String, String> {
    [
        ("GSM_OVERLAY_DATA_PATH", data.join("gsm_overlay")),
        ("GSM_SUDACHI_DATA_PATH", data.to_path_buf()),
        (
            "GSM_SUDACHI_USER_DICTS_PATH",
            data.join("dictionaries/sudachi"),
        ),
        ("GSM_GAMEPAD_SETTINGS_PATH", overlay.join("settings.json")),
    ]
    .into_iter()
    .map(|(key, path)| (key.into(), path.to_string_lossy().into_owned()))
    .collect()
}

fn spawn_server_process(
    binary: &Path,
    port: u16,
    env: &HashMap<String, String>,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(binary);
    cmd.args(["--host", INPUT_SERVER_HOST, "--port", &port.to_string()])
        .envs(env)
        .env(PIPE_ENV, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(parent) = binary.parent() {
        cmd.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.spawn()
}

fn reply_to_language_request(
    app: Option<&tauri::AppHandle>,
    body: &str,
    language: &Arc<LanguageService>,
    pipe: &HelperStdin,
) {
    let Ok(PipeRequest { id, request }) = serde_json::from_str(body) else {
        crate::desktop_log::emit_rust(app, "input-server", "WARNING", "Invalid desktop language request");
        return;
    };
    let language = language.clone();
    let pipe = pipe.clone();
    tauri::async_runtime::spawn(async move {
        let result = language.execute(request).await;
        let reply = PipeReply { id, result };
        if let Ok(body) = serde_json::to_string(&reply) {
            tauri::async_runtime::spawn_blocking(move || {
                let mut pipe = pipe.lock().unwrap();
                let _ = writeln!(pipe, "{REPLY_PREFIX}{body}").and_then(|_| pipe.flush());
            });
        }
    });
}

fn supervisor_loop(
    app: Option<tauri::AppHandle>,
    shared: Arc<Shared>,
    binary: PathBuf,
    env: HashMap<String, String>,
    language: Arc<LanguageService>,
) {
    // Existing Python clients retain their launch environment across service crashes.
    let mut requested_port = 0;
    loop {
        if shared.state.lock().unwrap().stopping {
            break;
        }
        let mut child = match spawn_server_process(&binary, requested_port, &env) {
            Ok(child) => child,
            Err(error) => {
                crate::desktop_log::emit_rust(
                    app.as_ref(),
                    "input-server",
                    "ERROR",
                    &format!("Failed to launch {}: {error}", binary.display()),
                );
                let guard = shared.state.lock().unwrap();
                if guard.stopping {
                    break;
                }
                let _ = shared.cv.wait_timeout(guard, RESTART_DELAY);
                continue;
            }
        };

        let stdin = child.stdin.take().map(|pipe| Arc::new(Mutex::new(pipe)));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let child_arc = Arc::new(Mutex::new(Some(child)));
        {
            let mut guard = shared.state.lock().unwrap();
            if guard.stopping {
                drop(guard);
                if let Some(mut c) = child_arc.lock().unwrap().take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                break;
            }
            guard.stdin = stdin.clone();
            guard.child = Some(child_arc.clone());
            guard.running = true;
            guard.port = None;
            guard.url = None;
            shared.cv.notify_all();
        }

        let stderr_app = app.clone();
        let stderr_handle = stderr.map(|pipe| {
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        crate::desktop_log::emit_rust(
                            stderr_app.as_ref(),
                            "input-server",
                            "BACKGROUND",
                            trimmed,
                        );
                    }
                }
            })
        });

        let stdout_shared = shared.clone();
        let stdout_app = app.clone();
        let language = language.clone();
        let stdout_handle = stdout.map(|pipe| {
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    if let Some(port) = parse_ready_line(&line) {
                        let mut guard = stdout_shared.state.lock().unwrap();
                        if !guard.stopping {
                            let url = format!("ws://{INPUT_SERVER_HOST}:{port}");
                            guard.port = Some(port);
                            guard.url = Some(url.clone());
                            stdout_shared.cv.notify_all();
                            drop(guard);
                            crate::desktop_log::emit_rust(
                                stdout_app.as_ref(),
                                "input-server",
                                "BACKGROUND",
                                &format!("Listening on {url}"),
                            );
                        }
                    } else if let (Some(body), Some(stdin)) =
                        (line.strip_prefix(REQUEST_PREFIX), stdin.as_ref())
                    {
                        reply_to_language_request(stdout_app.as_ref(), body, &language, stdin);
                    }
                }
            })
        });

        if let Some(h) = stdout_handle {
            let _ = h.join();
        }
        if let Some(h) = stderr_handle {
            let _ = h.join();
        }
        let status = {
            let mut slot = child_arc.lock().unwrap();
            slot.take().and_then(|mut c| c.wait().ok())
        };
        let should_stop = {
            let mut guard = shared.state.lock().unwrap();
            if let Some(port) = guard.port {
                requested_port = port;
            }
            guard.stdin = None;
            guard.child = None;
            guard.port = None;
            guard.url = None;
            guard.running = false;
            shared.cv.notify_all();
            guard.stopping
        };
        if should_stop {
            break;
        }
        if let Some(status) = status {
            crate::desktop_log::emit_rust(
                app.as_ref(),
                "input-server",
                "WARNING",
                &format!("Exited unexpectedly ({status}); restarting"),
            );
        }
        let guard = shared.state.lock().unwrap();
        if guard.stopping {
            break;
        }
        let _ = shared.cv.wait_timeout(guard, RESTART_DELAY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_uses_compiled_helper_instead_of_stale_packaged_copy() {
        let root =
            std::env::temp_dir().join(format!("gsm-input-resolution-{}", uuid::Uuid::new_v4()));
        let bundled = root
            .join("GSM_Overlay/input_server/bin")
            .join(platform_dir())
            .join(binary_name());
        let compiled = root
            .join("GSM_Overlay/input_server/target/release")
            .join(binary_name());
        for file in [&bundled, &compiled] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, []).unwrap();
        }
        assert_eq!(
            resolve_binary_for_mode(&[root.clone()], true),
            Some(compiled.clone())
        );
        assert_eq!(
            resolve_binary_for_mode(&[root.clone()], false),
            Some(bundled)
        );
        std::fs::remove_file(compiled).unwrap();
        assert_eq!(resolve_binary_for_mode(&[root.clone()], true), None);
        let cleanup = root.canonicalize().unwrap();
        assert!(cleanup.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        std::fs::remove_dir_all(cleanup).unwrap();
    }

    #[test]
    fn input_service_uses_active_data_and_overlay_directories() {
        let root = PathBuf::from("test-profile");
        let overlay = root.join("overlay");
        let env = service_environment(&root, &overlay);
        assert_eq!(env["GSM_SUDACHI_DATA_PATH"], root.to_string_lossy());
        assert_eq!(
            env["GSM_GAMEPAD_SETTINGS_PATH"],
            overlay.join("settings.json").to_string_lossy()
        );
    }

    #[test]
    fn parses_valid_ready_line_and_rejects_invalid_hosts_or_ports() {
        assert_eq!(
            parse_ready_line(r#"GSM_INPUT_SERVER_READY:{"host":"127.0.0.1","port":49152}"#),
            Some(49152)
        );
        assert_eq!(
            parse_ready_line(r#"  GSM_INPUT_SERVER_READY:{"host":"127.0.0.1","port":8080}  "#),
            Some(8080)
        );
        assert_eq!(
            parse_ready_line(r#"GSM_INPUT_SERVER_READY:{"host":"0.0.0.0","port":49152}"#),
            None
        );
        assert_eq!(
            parse_ready_line(r#"GSM_INPUT_SERVER_READY:{"host":"127.0.0.1","port":0}"#),
            None
        );
        assert_eq!(parse_ready_line("not ready"), None);
    }

    #[test]
    fn supervisor_starts_real_input_server_and_stops_cleanly_benchmark() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let Some(binary) = resolve_binary_in_roots(&[root]) else {
            return;
        };
        let shared = Arc::new(Shared::default());
        shared.state.lock().unwrap().started = true;
        shared.state.lock().unwrap().binary_path = Some(binary.clone());

        // A different selection in the helper's profile makes local fallback
        // distinguishable from a reply generated inside this desktop process.
        let data = tempfile::tempdir().unwrap();
        let helper_data = tempfile::tempdir().unwrap();
        let fixture = std::env::var_os("GSM_TEST_SUDACHI_DICTIONARY");
        let edition = if fixture.is_some() { "small" } else { "full" };
        for (folder, selection) in [(data.path(), edition), (helper_data.path(), "core")] {
            std::fs::create_dir(folder.join("sudachi")).unwrap();
            std::fs::write(folder.join("sudachi/selection.txt"), selection).unwrap();
        }
        if let Some(source) = fixture.as_ref() {
            let directory = data.path().join("sudachi/v20260116-small");
            std::fs::create_dir(&directory).unwrap();
            let dictionary = directory.join("system_small.dic");
            if std::fs::hard_link(source, &dictionary).is_err() {
                std::fs::copy(source, dictionary).unwrap();
            }
        }
        std::fs::write(
            helper_data.path().join("settings.json"),
            r#"{"gamepadXinputEnabled":false,"gamepadDinputEnabled":false}"#,
        )
        .unwrap();
        let language = Arc::new(LanguageService::new(
            data.path().to_path_buf(),
            data.path().join("user"),
        ));
        let started_at = Instant::now();
        let supervisor_shared = shared.clone();
        let env = service_environment(helper_data.path(), helper_data.path());
        let handle =
            std::thread::spawn(move || supervisor_loop(None, supervisor_shared, binary, env, language));

        let deadline = Instant::now() + Duration::from_secs(5);
        let ready = {
            let mut guard = shared.state.lock().unwrap();
            loop {
                if let (Some(port), Some(url)) = (guard.port, guard.url.clone()) {
                    break Some((port, url, started_at.elapsed()));
                }
                let Some(rem) = deadline.checked_duration_since(Instant::now()) else {
                    break None;
                };
                let (next, _) = shared.cv.wait_timeout(guard, rem).unwrap();
                guard = next;
            }
        };
        let replies = ready.as_ref().map(|(port, url, _)| -> Result<_, String> {
            use tungstenite::{client, Message};

            let stream = std::net::TcpStream::connect((INPUT_SERVER_HOST, *port))
                .map_err(|error| error.to_string())?;
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .map_err(|error| error.to_string())?;
            let (mut socket, _) = client(url.as_str(), stream).map_err(|error| error.to_string())?;
            let mut request = |payload: &str, response_type: &str| {
                socket
                    .send(Message::Text(payload.into()))
                    .map_err(|error| error.to_string())?;
                for _ in 0..16 {
                    let message = socket.read().map_err(|error| error.to_string())?;
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(
                        message.to_text().unwrap_or(""),
                    ) {
                        if value["type"] == response_type {
                            return Ok(value);
                        }
                    }
                }
                Err(format!("No {response_type} returned through the input server"))
            };
            let status = request(r#"{"type":"sudachi_status"}"#, "sudachi_status")?;
            request(
                r#"{"type":"configure_features","features":["sudachi"]}"#,
                "service_features_changed",
            )?;
            let tokens = request(
                r#"{"type":"tokenize","requestId":"managed","text":"猫が来た。"}"#,
                "tokens",
            )?;
            Ok((status, tokens))
        });
        stop_shared(&shared);
        let _ = handle.join();

        let (port, url, elapsed) = ready.expect("gsm_overlay_server should become ready");
        assert!(port > 0);
        assert_eq!(url, format!("ws://127.0.0.1:{port}"));
        let (status, tokens) = replies.unwrap().unwrap();
        assert_eq!(status["dictionary"], edition);
        assert_eq!(tokens["requestId"], "managed");
        if fixture.is_some() {
            assert_eq!(status["state"], "ready");
            assert_eq!(tokens["sudachiAvailable"], true);
            assert_eq!(tokens["tokens"][0]["word"], "猫");
        } else {
            assert_eq!(status["state"], "setup_required");
            assert_eq!(tokens["setupRequired"], true);
        }
        println!(
            "[bench] input_server startup ready_ms={:.2}",
            elapsed.as_secs_f64() * 1000.0
        );
    }
}
