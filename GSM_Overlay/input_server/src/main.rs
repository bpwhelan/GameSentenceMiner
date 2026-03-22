use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use gilrs::{Axis, Button, Event, EventType, GamepadId, Gilrs};
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::File;
use std::io::{BufWriter, Cursor, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};
use sudachi::analysis::stateless_tokenizer::StatelessTokenizer;
use sudachi::analysis::{Mode as SudachiMode, Tokenize as SudachiTokenize};
use sudachi::config::Config as SudachiConfig;
use sudachi::dic::build::DictBuilder;
use sudachi::dic::dictionary::JapaneseDictionary;
use sudachi::dic::storage::{Storage as SudachiStorage, SudachiDicData};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, Mutex};
use tokio::time;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{debug, error, info, warn, Level};
use zip::ZipArchive;

/// GSM Overlay Gamepad Server (Rust)
///
/// WebSocket JSON API compatible with your Python server style.
/// - broadcasts: gamepad_connected, button, axis
/// - handles: ping, get_state
#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Args {
    /// Bind address, e.g. 127.0.0.1
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Port for the websocket server
    #[arg(long, default_value_t = 7276)]
    port: u16,
}

const SUDACHI_DICT_RELEASE: &str = "20260116";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SudachiDictionaryKind {
    Small,
    Core,
    Full,
}

impl SudachiDictionaryKind {
    fn from_value(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()) {
            Some(v) if v == "small" => Self::Small,
            Some(v) if v == "full" => Self::Full,
            _ => Self::Core,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Core => "core",
            Self::Full => "full",
        }
    }

    fn zip_sha256(self) -> &'static str {
        match self {
            Self::Small => "0ac281c48fd9273e5cdfbb7d49d1457579998b5540da711767c6f733c95a6aa9",
            Self::Core => "e80e68c8e7b17e2082341284cffefbc11fb7838b2c318ae280c1690fc1ee1e2f",
            Self::Full => "2a1eda5a0240a42f45daf8003d97df5565c5d252bb2d58e71807bbbd082f7eea",
        }
    }

    fn download_url(self) -> String {
        format!(
            "https://github.com/WorksApplications/SudachiDict/releases/download/v{}/sudachi-dictionary-{}-{}.zip",
            SUDACHI_DICT_RELEASE,
            SUDACHI_DICT_RELEASE,
            self.as_str()
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerTokenizerBackend {
    Mecab,
    Sudachi,
}

impl ServerTokenizerBackend {
    fn from_value(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()) {
            Some(v) if v == "sudachi" => Self::Sudachi,
            _ => Self::Mecab,
        }
    }

    fn token_source(self) -> &'static str {
        match self {
            Self::Mecab => "mecab",
            Self::Sudachi => "sudachi",
        }
    }
}

// ------------------------- Your numeric button layout -------------------------

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug)]
#[repr(u8)]
enum ButtonCode {
    A = 0,
    B = 1,
    X = 2,
    Y = 3,
    LB = 4,
    RB = 5,
    LT = 6, // from trigger axis or trigger button fallback
    RT = 7, // from trigger axis or trigger button fallback
    BACK = 8,
    START = 9,
    LS = 10,
    RS = 11,
    DPAD_UP = 12,
    DPAD_DOWN = 13,
    DPAD_LEFT = 14,
    DPAD_RIGHT = 15,
    GUIDE = 16,
}

fn map_button(btn: Button) -> Option<ButtonCode> {
    match btn {
        Button::South => Some(ButtonCode::A),
        Button::East => Some(ButtonCode::B),
        Button::West => Some(ButtonCode::X),
        Button::North => Some(ButtonCode::Y),

        Button::LeftTrigger => Some(ButtonCode::LB),
        Button::RightTrigger => Some(ButtonCode::RB),
        Button::LeftTrigger2 => Some(ButtonCode::LT),
        Button::RightTrigger2 => Some(ButtonCode::RT),

        Button::Select => Some(ButtonCode::BACK),
        Button::Start => Some(ButtonCode::START),

        Button::LeftThumb => Some(ButtonCode::LS),
        Button::RightThumb => Some(ButtonCode::RS),

        Button::DPadUp => Some(ButtonCode::DPAD_UP),
        Button::DPadDown => Some(ButtonCode::DPAD_DOWN),
        Button::DPadLeft => Some(ButtonCode::DPAD_LEFT),
        Button::DPadRight => Some(ButtonCode::DPAD_RIGHT),

        Button::Mode => Some(ButtonCode::GUIDE),

        _ => None,
    }
}

fn axis_name(axis: Axis) -> Option<&'static str> {
    match axis {
        Axis::LeftStickX => Some("left_x"),
        Axis::LeftStickY => Some("left_y"),
        Axis::RightStickX => Some("right_x"),
        Axis::RightStickY => Some("right_y"),
        Axis::LeftZ => Some("lt"),  // triggers commonly mapped here
        Axis::RightZ => Some("rt"), // triggers commonly mapped here
        _ => None,
    }
}

fn digital_pressed(value: f32) -> bool {
    value >= 0.5
}

fn is_stick_axis(axis: &str) -> bool {
    matches!(axis, "left_x" | "left_y" | "right_x" | "right_y")
}

fn gsm_dev_environment_enabled() -> bool {
    matches!(
        std::env::var("GSM_DEV_ENVIRONMENT"),
        Ok(v) if v.trim() == "1"
    )
}

fn init_tracing(dev_environment: bool) {
    let max_level = if dev_environment {
        Level::DEBUG
    } else {
        Level::INFO
    };
    tracing_subscriber::fmt().with_max_level(max_level).init();
}

// ------------------------------ Server state --------------------------------

#[derive(Debug, Clone)]
struct AxisSent {
    value: f32,
    time: Instant,
}

#[derive(Debug, Clone)]
struct GamepadState {
    device_name: String,
    connected: bool,

    buttons: HashMap<u8, bool>,
    axes: HashMap<String, f32>,

    // Rate limiting per axis
    last_axis_sent: HashMap<String, AxisSent>,
}

impl GamepadState {
    fn new(device_name: String) -> Self {
        let mut buttons = HashMap::new();
        for i in 0u8..=16u8 {
            buttons.insert(i, false);
        }

        let mut axes = HashMap::new();
        axes.insert("left_x".into(), 0.0);
        axes.insert("left_y".into(), 0.0);
        axes.insert("right_x".into(), 0.0);
        axes.insert("right_y".into(), 0.0);
        axes.insert("lt".into(), 0.0);
        axes.insert("rt".into(), 0.0);

        Self {
            device_name,
            connected: true,
            buttons,
            axes,
            last_axis_sent: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct Config {
    deadzone: f32,
    trigger_threshold: f32,
    axis_epsilon: f32,
    axis_min_interval: Duration,
    axis_hold_repeat_interval: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            deadzone: 0.15,
            trigger_threshold: 0.5,
            axis_epsilon: 0.02,
            axis_min_interval: Duration::from_secs_f64(1.0 / 120.0),
            axis_hold_repeat_interval: Duration::from_secs_f64(1.0 / 60.0),
        }
    }
}

#[derive(Debug, Clone)]
struct StickLogSample {
    value: f32,
    time: Instant,
}

#[derive(Debug)]
struct DevInputLogger {
    enabled: bool,
    stick_min_interval: Duration,
    stick_delta_epsilon: f32,
    last_stick_sample: HashMap<(GamepadId, &'static str), StickLogSample>,
}

impl DevInputLogger {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            stick_min_interval: Duration::from_millis(180),
            stick_delta_epsilon: 0.08,
            last_stick_sample: HashMap::new(),
        }
    }

    fn should_log_stick(
        &mut self,
        id: GamepadId,
        axis: &'static str,
        value: f32,
        now: Instant,
    ) -> bool {
        if !self.enabled {
            return false;
        }

        let key = (id, axis);
        if let Some(prev) = self.last_stick_sample.get(&key) {
            let dv = (value - prev.value).abs();
            let dt = now.duration_since(prev.time);
            if dv < self.stick_delta_epsilon && dt < self.stick_min_interval {
                return false;
            }
        }

        self.last_stick_sample
            .insert(key, StickLogSample { value, time: now });
        true
    }
}

type SharedStates = Mutex<HashMap<GamepadId, GamepadState>>;
type SharedMecab = Mutex<MecabService>;
type SharedSudachi = Mutex<SudachiService>;

struct SudachiService {
    data_dir: PathBuf,
    user_dict_dir: PathBuf,
    dictionary_kind: SudachiDictionaryKind,
    dictionary: Option<Arc<JapaneseDictionary>>,
    loaded_signature: Option<String>,
}

/// Emit a structured JSON progress message to stdout for Electron to parse.
/// Format: GSMPROGRESS:{"stage":"...","percent":N,"totalBytes":N,"error":"..."}
fn emit_sudachi_progress(stage: &str, percent: u64, total_bytes: Option<u64>, error: Option<&str>) {
    let mut msg = json!({
        "stage": stage,
        "percent": percent,
    });
    if let Some(total) = total_bytes {
        msg["totalBytes"] = json!(total);
    }
    if let Some(err) = error {
        msg["error"] = json!(err);
    }
    // Print to stdout with a recognizable prefix for Electron to parse
    println!("GSMPROGRESS:{}", msg);
}

impl SudachiService {
    fn new(
        data_dir: PathBuf,
        user_dict_dir: PathBuf,
        dictionary_kind: SudachiDictionaryKind,
    ) -> Self {
        Self {
            data_dir,
            user_dict_dir,
            dictionary_kind,
            dictionary: None,
            loaded_signature: None,
        }
    }

    async fn ensure_tokenizer(&mut self) -> Result<(), String> {
        let dict_path = self.ensure_dictionary().await?;
        let user_dict_dir = self.user_dict_dir.clone();
        let dict_path_for_user_dicts = dict_path.clone();
        let (user_dict_paths, signature) = tokio::task::spawn_blocking(move || {
            prepare_sudachi_user_dictionaries(&dict_path_for_user_dicts, &user_dict_dir)
        })
        .await
        .map_err(|e| format!("sudachi dictionary task failed: {e}"))??;
        if self.dictionary.is_some() && self.loaded_signature.as_deref() == Some(signature.as_str())
        {
            return Ok(());
        }
        let dict_path_for_load = dict_path.clone();
        let dictionary = tokio::task::spawn_blocking(move || {
            load_sudachi_dictionary(&dict_path_for_load, &user_dict_paths)
        })
        .await
        .map_err(|e| format!("sudachi dictionary task failed: {e}"))??;
        self.dictionary = Some(dictionary);
        self.loaded_signature = Some(signature);
        Ok(())
    }

    async fn ensure_dictionary(&self) -> Result<PathBuf, String> {
        let version_dir = self.data_dir.join("sudachi").join(format!(
            "v{}-{}",
            SUDACHI_DICT_RELEASE,
            self.dictionary_kind.as_str()
        ));
        let dict_path = version_dir.join(format!("system_{}.dic", self.dictionary_kind.as_str()));
        if dict_path.is_file() {
            emit_sudachi_progress("ready", 100, None, None);
            return Ok(dict_path);
        }

        fs::create_dir_all(&version_dir)
            .map_err(|e| format!("failed to create Sudachi data directory: {e}"))?;

        info!(
            "downloading Sudachi dictionary {} ({})",
            SUDACHI_DICT_RELEASE,
            self.dictionary_kind.as_str()
        );
        emit_sudachi_progress("downloading", 0, None, None);

        let client = HttpClient::builder()
            .user_agent("gsm-overlay-server/0.1.0")
            .build()
            .map_err(|e| {
                let msg = format!("failed to build Sudachi HTTP client: {e}");
                emit_sudachi_progress("error", 0, None, Some(&msg));
                msg
            })?;
        let mut response = client
            .get(self.dictionary_kind.download_url())
            .send()
            .await
            .map_err(|e| {
                let msg = format!("failed to download Sudachi dictionary: {e}");
                emit_sudachi_progress("error", 0, None, Some(&msg));
                msg
            })?;
        let status = response.status();
        if !status.is_success() {
            let msg = format!("failed to download Sudachi dictionary: HTTP {}", status);
            emit_sudachi_progress("error", 0, None, Some(&msg));
            return Err(msg);
        }

        let total_size = response.content_length();
        let mut downloaded: u64 = 0;
        let mut zip_bytes = Vec::with_capacity(total_size.unwrap_or(0) as usize);
        let mut last_progress_pct: u64 = 0;

        // Stream download with progress
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    downloaded += chunk.len() as u64;
                    zip_bytes.extend_from_slice(&chunk);
                    if let Some(total) = total_size {
                        if total > 0 {
                            let pct = (downloaded * 100) / total;
                            // Emit at most every 2% to avoid flooding
                            if pct >= last_progress_pct + 2 || pct == 100 {
                                emit_sudachi_progress("downloading", pct, total_size, None);
                                last_progress_pct = pct;
                            }
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let msg = format!("failed to read Sudachi dictionary archive: {e}");
                    emit_sudachi_progress("error", 0, total_size, Some(&msg));
                    return Err(msg);
                }
            }
        }

        emit_sudachi_progress("verifying", 100, total_size, None);
        let digest = sha256_hex(&zip_bytes);
        if digest != self.dictionary_kind.zip_sha256() {
            let msg = format!(
                "Sudachi dictionary checksum mismatch: expected {}, got {digest}",
                self.dictionary_kind.zip_sha256()
            );
            emit_sudachi_progress("error", 0, total_size, Some(&msg));
            return Err(msg);
        }

        emit_sudachi_progress("extracting", 100, total_size, None);
        let dict_path_for_extract = dict_path.clone();
        tokio::task::spawn_blocking(move || {
            extract_sudachi_dictionary(&zip_bytes, &dict_path_for_extract)
        })
        .await
        .map_err(|e| {
            let msg = format!("Sudachi extraction task failed: {e}");
            emit_sudachi_progress("error", 0, None, Some(&msg));
            msg
        })??;

        emit_sudachi_progress("done", 100, total_size, None);
        info!("Sudachi dictionary ready at {}", dict_path.display());
        Ok(dict_path)
    }

    async fn tokenize(&mut self, text: &str) -> Result<Vec<Value>, String> {
        self.ensure_tokenizer().await?;
        let dictionary = self
            .dictionary
            .as_ref()
            .ok_or_else(|| "Sudachi dictionary unavailable".to_string())?;
        let text = text.to_string();
        tokio::task::spawn_blocking({
            let dictionary = dictionary.clone();
            move || tokenize_with_sudachi(&dictionary, &text)
        })
        .await
        .map_err(|e| format!("Sudachi tokenization task failed: {e}"))?
    }

    async fn furigana(&mut self, text: &str) -> Result<Vec<Value>, String> {
        self.ensure_tokenizer().await?;
        let dictionary = self
            .dictionary
            .as_ref()
            .ok_or_else(|| "Sudachi dictionary unavailable".to_string())?;
        let text = text.to_string();
        tokio::task::spawn_blocking({
            let dictionary = dictionary.clone();
            move || furigana_with_sudachi(&dictionary, &text)
        })
        .await
        .map_err(|e| format!("Sudachi furigana task failed: {e}"))?
    }
}

#[derive(Debug)]
struct MecabBridge {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl MecabBridge {
    async fn request(&mut self, req: &Value) -> Result<Value, String> {
        let encoded = serde_json::to_string(req).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(encoded.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())?;

        let mut line = String::new();
        let read = self
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("mecab bridge closed stdout".to_string());
        }

        serde_json::from_str::<Value>(line.trim()).map_err(|e| e.to_string())
    }
}

#[derive(Debug)]
struct MecabService {
    script_path: PathBuf,
    bridge: Option<MecabBridge>,
}

impl MecabService {
    fn new(script_path: PathBuf) -> Self {
        Self {
            script_path,
            bridge: None,
        }
    }

    async fn ensure_bridge(&mut self) -> Result<(), String> {
        if self.bridge.is_some() {
            return Ok(());
        }
        self.spawn_bridge().await
    }

    async fn spawn_bridge(&mut self) -> Result<(), String> {
        if !self.script_path.is_file() {
            return Err(format!(
                "mecab bridge script not found: {}",
                self.script_path.display()
            ));
        }

        let attempts = collect_python_attempts();

        let mut last_error = "no python candidates attempted".to_string();
        for (bin, args) in attempts {
            let mut cmd = Command::new(&bin);
            for arg in args {
                cmd.arg(arg);
            }
            cmd.arg("-X").arg("utf8");
            cmd.arg("-u")
                .arg(&self.script_path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .env("PYTHONUTF8", "1")
                .env("PYTHONIOENCODING", "utf-8");
            if let Some(script_dir) = self.script_path.parent() {
                cmd.current_dir(script_dir);
            }

            match cmd.spawn() {
                Ok(mut child) => {
                    let stdin = match child.stdin.take() {
                        Some(s) => s,
                        None => {
                            last_error = format!("{bin}: no stdin pipe");
                            let _ = child.start_kill();
                            continue;
                        }
                    };
                    let stdout = match child.stdout.take() {
                        Some(s) => s,
                        None => {
                            last_error = format!("{bin}: no stdout pipe");
                            let _ = child.start_kill();
                            continue;
                        }
                    };

                    let mut bridge = MecabBridge {
                        child,
                        stdin,
                        stdout: BufReader::new(stdout),
                    };

                    let health = time::timeout(
                        Duration::from_secs(3),
                        bridge.request(&json!({"op":"health"})),
                    )
                    .await;
                    match health {
                        Ok(Ok(resp)) => {
                            let avail = resp
                                .get("mecabAvailable")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            info!("mecab bridge started with {bin} (mecabAvailable={avail})");
                            self.bridge = Some(bridge);
                            return Ok(());
                        }
                        Ok(Err(e)) => {
                            last_error = format!("{bin}: health request failed: {e}");
                            let _ = bridge.child.start_kill();
                        }
                        Err(_) => {
                            last_error = format!("{bin}: health request timed out");
                            let _ = bridge.child.start_kill();
                        }
                    }
                }
                Err(e) => {
                    last_error = format!("{bin}: {e}");
                }
            }
        }

        Err(last_error)
    }

    async fn request(&mut self, req: Value) -> Result<Value, String> {
        self.ensure_bridge().await?;

        let result = {
            let bridge = self
                .bridge
                .as_mut()
                .ok_or_else(|| "mecab bridge unavailable".to_string())?;
            time::timeout(Duration::from_secs(5), bridge.request(&req)).await
        };

        match result {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => {
                warn!("mecab bridge request failed: {e}");
                if let Some(mut bridge) = self.bridge.take() {
                    let _ = bridge.child.start_kill();
                }
                Err(e)
            }
            Err(_) => {
                warn!("mecab bridge request timed out");
                if let Some(mut bridge) = self.bridge.take() {
                    let _ = bridge.child.start_kill();
                }
                Err("mecab bridge request timed out".to_string())
            }
        }
    }
}

fn resolve_mecab_script_path() -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut push_candidate = |path: PathBuf| {
        if seen.insert(path.clone()) {
            candidates.push(path);
        }
    };

    if let Ok(override_path) = std::env::var("GSM_MECAB_BRIDGE") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            push_candidate(PathBuf::from(trimmed));
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            push_candidate(exe_dir.join("mecab_bridge.py"));
            push_candidate(exe_dir.join("input_server").join("mecab_bridge.py"));

            if let Some(parent) = exe_dir.parent() {
                push_candidate(parent.join("mecab_bridge.py"));
                push_candidate(parent.join("input_server").join("mecab_bridge.py"));

                if let Some(grandparent) = parent.parent() {
                    push_candidate(grandparent.join("mecab_bridge.py"));
                    push_candidate(grandparent.join("input_server").join("mecab_bridge.py"));
                    push_candidate(
                        grandparent
                            .join("GSM_Overlay")
                            .join("input_server")
                            .join("mecab_bridge.py"),
                    );
                }
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        push_candidate(cwd.join("mecab_bridge.py"));
        push_candidate(cwd.join("input_server").join("mecab_bridge.py"));
        push_candidate(
            cwd.join("GSM_Overlay")
                .join("input_server")
                .join("mecab_bridge.py"),
        );
    }

    let manifest_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mecab_bridge.py");
    push_candidate(manifest_candidate.clone());

    for candidate in &candidates {
        if candidate.is_file() {
            info!("resolved mecab bridge script: {}", candidate.display());
            return candidate.clone();
        }
    }

    let checked = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(" | ");
    warn!("mecab bridge script not found; checked: {checked}");

    manifest_candidate
}

fn collect_python_attempts() -> Vec<(String, Vec<String>)> {
    let mut attempts: Vec<(String, Vec<String>)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push_attempt = |bin: String, args: Vec<String>| {
        let key = format!("{bin}\x1f{}", args.join("\x1f"));
        if seen.insert(key) {
            attempts.push((bin, args));
        }
    };

    if let Ok(custom) = std::env::var("GSM_PYTHON") {
        let custom = custom.trim();
        if !custom.is_empty() {
            push_attempt(custom.to_string(), Vec::new());
        }
    }

    if let Ok(custom) = std::env::var("PYTHON") {
        let custom = custom.trim();
        if !custom.is_empty() {
            push_attempt(custom.to_string(), Vec::new());
        }
    }

    if let Ok(venv) = std::env::var("VIRTUAL_ENV") {
        let path = if cfg!(windows) {
            PathBuf::from(&venv).join("Scripts").join("python.exe")
        } else {
            PathBuf::from(&venv).join("bin").join("python")
        };
        if path.is_file() {
            push_attempt(path.display().to_string(), Vec::new());
        }
    }

    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let appdata_python = PathBuf::from(appdata)
                .join("GameSentenceMiner")
                .join("python_venv")
                .join("Scripts")
                .join("python.exe");
            if appdata_python.is_file() {
                push_attempt(appdata_python.display().to_string(), Vec::new());
            }
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            let local_python = PathBuf::from(localappdata)
                .join("GameSentenceMiner")
                .join("python_venv")
                .join("Scripts")
                .join("python.exe");
            if local_python.is_file() {
                push_attempt(local_python.display().to_string(), Vec::new());
            }
        }
    }

    push_attempt("python".to_string(), Vec::new());
    push_attempt("py".to_string(), vec!["-3".to_string()]);
    push_attempt("python3".to_string(), Vec::new());

    attempts
}

fn preferred_server_tokenizer_backend_from_env() -> ServerTokenizerBackend {
    ServerTokenizerBackend::from_value(
        std::env::var("GSM_GAMEPAD_TOKENIZER_BACKEND")
            .ok()
            .as_deref(),
    )
}

fn sudachi_dictionary_kind_from_env() -> SudachiDictionaryKind {
    SudachiDictionaryKind::from_value(std::env::var("GSM_SUDACHI_DICT_KIND").ok().as_deref())
}

fn default_overlay_data_dir() -> PathBuf {
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let trimmed = appdata.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("gsm_overlay");
            }
        }
    } else {
        if let Ok(config_home) = std::env::var("XDG_CONFIG_HOME") {
            let trimmed = config_home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("gsm_overlay");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join(".config").join("gsm_overlay");
            }
        }
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("gsm_overlay")
}

fn resolve_sudachi_data_dir() -> PathBuf {
    default_gsm_app_data_dir()
}

fn default_gsm_app_data_dir() -> PathBuf {
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let trimmed = appdata.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("GameSentenceMiner");
            }
        }
    } else {
        if let Ok(config_home) = std::env::var("XDG_CONFIG_HOME") {
            let trimmed = config_home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("GameSentenceMiner");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed)
                    .join(".config")
                    .join("GameSentenceMiner");
            }
        }
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("GameSentenceMiner")
}

fn resolve_sudachi_user_dicts_dir() -> PathBuf {
    if let Ok(path) = std::env::var("GSM_SUDACHI_USER_DICTS_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    default_gsm_app_data_dir()
        .join("dictionaries")
        .join("sudachi")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn extract_sudachi_dictionary(zip_bytes: &[u8], dict_path: &Path) -> Result<(), String> {
    let parent = dict_path
        .parent()
        .ok_or_else(|| format!("invalid Sudachi dictionary path: {}", dict_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create Sudachi parent directory: {e}"))?;

    let file_name = dict_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "invalid Sudachi dictionary filename: {}",
                dict_path.display()
            )
        })?;
    let partial_path = dict_path.with_file_name(format!("{file_name}.part"));
    if partial_path.exists() {
        let _ = fs::remove_file(&partial_path);
    }

    let reader = Cursor::new(zip_bytes);
    let mut archive =
        ZipArchive::new(reader).map_err(|e| format!("failed to open Sudachi zip archive: {e}"))?;

    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| format!("failed to read Sudachi zip entry {idx}: {e}"))?;
        if entry.is_dir() {
            continue;
        }

        let entry_name = entry.name().replace('\\', "/");
        if !entry_name.ends_with(".dic") || !entry_name.contains("system_") {
            continue;
        }

        let mut out = fs::File::create(&partial_path)
            .map_err(|e| format!("failed to create Sudachi dictionary file: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("failed to extract Sudachi dictionary: {e}"))?;
        out.flush()
            .map_err(|e| format!("failed to flush Sudachi dictionary: {e}"))?;
        fs::rename(&partial_path, dict_path)
            .map_err(|e| format!("failed to finalize Sudachi dictionary file: {e}"))?;
        return Ok(());
    }

    Err("Sudachi archive did not contain a system_*.dic entry".to_string())
}

fn file_timestamp_secs(path: &Path) -> Result<u64, String> {
    let modified = fs::metadata(path)
        .map_err(|e| format!("failed to read metadata for {}: {e}", path.display()))?
        .modified()
        .map_err(|e| format!("failed to read modified time for {}: {e}", path.display()))?;
    let duration = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("invalid modified time for {}: {e}", path.display()))?;
    Ok(duration.as_secs())
}

fn should_rebuild_user_dictionary(csv_path: &Path, dic_path: &Path) -> Result<bool, String> {
    if !dic_path.is_file() {
        return Ok(true);
    }

    Ok(file_timestamp_secs(csv_path)? > file_timestamp_secs(dic_path)?)
}

fn collect_sorted_paths(dir: &Path, extension: &str) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    for entry in
        fs::read_dir(dir).map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?
    {
        let entry = entry.map_err(|e| format!("failed to read directory entry: {e}"))?;
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case(extension))
            .unwrap_or(false)
        {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn compile_user_dictionary(
    csv_path: &Path,
    dic_path: &Path,
    system_dictionary: &Arc<JapaneseDictionary>,
) -> Result<(), String> {
    if let Some(parent) = dic_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "failed to create Sudachi user dictionary directory {}: {e}",
                parent.display()
            )
        })?;
    }

    let partial_path = dic_path.with_extension("dic.part");
    if partial_path.exists() {
        let _ = fs::remove_file(&partial_path);
    }

    let file = File::create(&partial_path).map_err(|e| {
        format!(
            "failed to create temporary Sudachi user dictionary {}: {e}",
            partial_path.display()
        )
    })?;
    let mut writer = BufWriter::with_capacity(16 * 1024, file);
    let mut builder = DictBuilder::new_user(system_dictionary.as_ref());
    let description = csv_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| format!("GSM user dictionary ({value})"))
        .unwrap_or_else(|| "GSM user dictionary".to_string());
    builder.set_description(description);
    builder.read_lexicon(csv_path).map_err(|e| {
        format!(
            "failed to read Sudachi user dictionary CSV {}: {e}",
            csv_path.display()
        )
    })?;
    builder.resolve().map_err(|e| {
        format!(
            "failed to resolve Sudachi user dictionary CSV {}: {e}",
            csv_path.display()
        )
    })?;
    builder.compile(&mut writer).map_err(|e| {
        format!(
            "failed to compile Sudachi user dictionary CSV {}: {e}",
            csv_path.display()
        )
    })?;
    writer.flush().map_err(|e| {
        format!(
            "failed to flush Sudachi user dictionary {}: {e}",
            dic_path.display()
        )
    })?;
    fs::rename(&partial_path, dic_path).map_err(|e| {
        format!(
            "failed to finalize Sudachi user dictionary {}: {e}",
            dic_path.display()
        )
    })?;
    Ok(())
}

fn build_dictionary_signature(
    dict_path: &Path,
    user_dict_paths: &[PathBuf],
) -> Result<String, String> {
    let system_meta = fs::metadata(dict_path)
        .map_err(|e| format!("failed to read metadata for {}: {e}", dict_path.display()))?;
    let system_stamp = file_timestamp_secs(dict_path)?;
    let mut parts = vec![format!(
        "{}:{}:{}",
        dict_path.display(),
        system_meta.len(),
        system_stamp
    )];

    for path in user_dict_paths {
        let meta = fs::metadata(path)
            .map_err(|e| format!("failed to read metadata for {}: {e}", path.display()))?;
        let stamp = file_timestamp_secs(path)?;
        parts.push(format!("{}:{}:{}", path.display(), meta.len(), stamp));
    }

    Ok(parts.join("|"))
}

fn prepare_sudachi_user_dictionaries(
    dict_path: &Path,
    user_dict_dir: &Path,
) -> Result<(Vec<PathBuf>, String), String> {
    let csv_dir = user_dict_dir.join("csv");
    let dic_dir = user_dict_dir.join("dic");
    let csv_paths = collect_sorted_paths(&csv_dir, "csv")?;

    if csv_paths.is_empty() {
        return Ok((Vec::new(), build_dictionary_signature(dict_path, &[])?));
    }

    fs::create_dir_all(&dic_dir)
        .map_err(|e| format!("failed to create Sudachi user dictionary directory: {e}"))?;
    let system_dictionary = load_sudachi_dictionary(dict_path, &[])?;
    let mut compiled_paths = Vec::new();

    for csv_path in csv_paths {
        let Some(stem) = csv_path.file_stem().and_then(|value| value.to_str()) else {
            warn!(
                "skipping Sudachi user dictionary CSV with invalid filename: {}",
                csv_path.display()
            );
            continue;
        };
        let dic_path = dic_dir.join(format!("{stem}.dic"));
        let rebuild = should_rebuild_user_dictionary(&csv_path, &dic_path)?;
        if rebuild {
            if dic_path.exists() {
                let _ = fs::remove_file(&dic_path);
            }
            match compile_user_dictionary(&csv_path, &dic_path, &system_dictionary) {
                Ok(()) => info!(
                    "compiled Sudachi user dictionary {} -> {}",
                    csv_path.display(),
                    dic_path.display()
                ),
                Err(error) => {
                    warn!("{error}");
                    let _ = fs::remove_file(&dic_path);
                    continue;
                }
            }
        }

        if dic_path.is_file() {
            compiled_paths.push(dic_path);
        }
    }

    compiled_paths.sort();
    let signature = build_dictionary_signature(dict_path, &compiled_paths)?;
    Ok((compiled_paths, signature))
}

fn load_sudachi_dictionary(
    dict_path: &Path,
    user_dict_paths: &[PathBuf],
) -> Result<Arc<JapaneseDictionary>, String> {
    let dictionary_bytes =
        fs::read(dict_path).map_err(|e| format!("failed to read Sudachi dictionary: {e}"))?;
    let config = SudachiConfig::new_embedded()
        .map_err(|e| format!("failed to build Sudachi embedded config: {e}"))?
        .with_system_dic(dict_path.to_path_buf());
    let mut storage = SudachiDicData::new(SudachiStorage::Owned(dictionary_bytes));
    for user_dict_path in user_dict_paths {
        let user_dict_bytes = fs::read(user_dict_path).map_err(|e| {
            format!(
                "failed to read Sudachi user dictionary {}: {e}",
                user_dict_path.display()
            )
        })?;
        storage.add_user(SudachiStorage::Owned(user_dict_bytes));
    }
    let dictionary = JapaneseDictionary::from_cfg_storage_with_embedded_chardef(&config, storage)
        .map_err(|e| format!("failed to load Sudachi dictionary: {e}"))?;
    Ok(Arc::new(dictionary))
}

fn has_kanji(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(
            ch as u32,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2A6DF
        )
    })
}

fn katakana_to_hiragana(text: &str) -> String {
    text.chars()
        .map(|ch| match ch as u32 {
            0x30A1..=0x30F6 => char::from_u32((ch as u32) - 0x60).unwrap_or(ch),
            _ => ch,
        })
        .collect()
}

fn tokenize_with_sudachi(
    dictionary: &Arc<JapaneseDictionary>,
    text: &str,
) -> Result<Vec<Value>, String> {
    let tokenizer = StatelessTokenizer::new(dictionary.clone());
    let morphemes = tokenizer
        .tokenize(text, SudachiMode::B, false)
        .map_err(|e| format!("Sudachi tokenize failed: {e}"))?;

    let mut tokens = Vec::with_capacity(morphemes.len());
    for morpheme in morphemes.iter() {
        let word = morpheme.surface().to_string();
        if word.trim().is_empty() {
            continue;
        }

        let reading = morpheme.reading_form();
        let headword = morpheme.dictionary_form();
        let pos = morpheme.part_of_speech().join(",");
        let mut token = json!({
            "word": word,
            "start": morpheme.begin_c(),
            "end": morpheme.end_c(),
            "headword": headword,
            "pos": pos,
        });
        if !reading.is_empty() {
            token["reading"] = json!(reading);
        }
        tokens.push(token);
    }

    Ok(tokens)
}

fn furigana_with_sudachi(
    dictionary: &Arc<JapaneseDictionary>,
    text: &str,
) -> Result<Vec<Value>, String> {
    let tokenizer = StatelessTokenizer::new(dictionary.clone());
    let morphemes = tokenizer
        .tokenize(text, SudachiMode::B, false)
        .map_err(|e| format!("Sudachi furigana tokenize failed: {e}"))?;

    let mut segments = Vec::with_capacity(morphemes.len());
    for morpheme in morphemes.iter() {
        let segment_text = morpheme.surface().to_string();
        let mut reading = None;
        if has_kanji(&segment_text) {
            let converted = katakana_to_hiragana(morpheme.reading_form());
            if !converted.is_empty() && converted != segment_text {
                reading = Some(converted);
            }
        }

        segments.push(json!({
            "text": segment_text,
            "start": morpheme.begin_c(),
            "end": morpheme.end_c(),
            "hasReading": reading.is_some(),
            "reading": reading,
        }));
    }

    Ok(segments)
}

// ------------------------------ JSON messages --------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientMsg {
    #[serde(rename = "ping")]
    Ping,

    #[serde(rename = "get_state")]
    GetState,

    #[serde(rename = "tokenize")]
    Tokenize {
        #[serde(default)]
        text: String,
        #[serde(default, rename = "blockIndex")]
        block_index: i64,
        #[serde(default)]
        backend: Option<String>,
    },

    #[serde(rename = "get_furigana")]
    GetFurigana {
        #[serde(default)]
        text: String,
        #[serde(default, rename = "lineIndex")]
        line_index: i64,
        #[serde(default, rename = "requestId")]
        request_id: Option<Value>,
        #[serde(default)]
        backend: Option<String>,
    },

    #[serde(other)]
    Unknown,
}

fn normalize_stick(v: f32, deadzone: f32) -> f32 {
    if v.abs() < deadzone {
        0.0
    } else {
        v.clamp(-1.0, 1.0)
    }
}

fn normalize_trigger(v: f32) -> f32 {
    // Robust mapping:
    // If v is already 0..1 keep it; else assume -1..1 and map to 0..1.
    if (0.0..=1.0).contains(&v) {
        v
    } else {
        ((v + 1.0) * 0.5).clamp(0.0, 1.0)
    }
}

fn should_send_axis(
    st: &mut GamepadState,
    axis: &str,
    value: f32,
    cfg: &Config,
    now: Instant,
) -> bool {
    if let Some(prev) = st.last_axis_sent.get(axis) {
        let dv = (value - prev.value).abs();
        let dt = now.duration_since(prev.time);
        if dv < cfg.axis_epsilon && dt < cfg.axis_min_interval {
            return false;
        }
    }
    st.last_axis_sent
        .insert(axis.to_string(), AxisSent { value, time: now });
    true
}

fn send_broadcast(tx: &broadcast::Sender<String>, payload: String, label: &str) {
    match tx.send(payload) {
        Ok(receivers) => debug!("broadcast {label} to {receivers} subscriber(s)"),
        Err(_) => warn!("broadcast {label} dropped: no websocket subscribers"),
    }
}

fn fallback_tokens(text: &str) -> Vec<Value> {
    text.chars()
        .enumerate()
        .filter(|(_, ch)| !ch.is_whitespace())
        .map(|(i, ch)| {
            json!({
                "word": ch.to_string(),
                "start": i,
                "end": i + 1,
            })
        })
        .collect()
}

fn fallback_furigana(text: &str) -> Vec<Value> {
    vec![json!({
        "text": text,
        "start": 0,
        "end": text.chars().count(),
        "hasReading": false,
        "reading": Value::Null,
    })]
}

async fn tokenize_via_mecab(mecab: &'static SharedMecab, text: &str) -> (Vec<Value>, bool) {
    let req = json!({
        "op": "tokenize",
        "text": text,
    });

    let response = {
        let mut bridge = mecab.lock().await;
        bridge.request(req).await
    };

    match response {
        Ok(resp) => {
            let mecab_available = resp
                .get("mecabAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let tokens = resp
                .get("tokens")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| fallback_tokens(text));
            (tokens, mecab_available)
        }
        Err(e) => {
            warn!("tokenize via mecab failed: {e}");
            (fallback_tokens(text), false)
        }
    }
}

async fn furigana_via_mecab(mecab: &'static SharedMecab, text: &str) -> (Vec<Value>, bool) {
    let req = json!({
        "op": "get_furigana",
        "text": text,
    });

    let response = {
        let mut bridge = mecab.lock().await;
        bridge.request(req).await
    };

    match response {
        Ok(resp) => {
            let mecab_available = resp
                .get("mecabAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let segments = resp
                .get("segments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| fallback_furigana(text));
            (segments, mecab_available)
        }
        Err(e) => {
            warn!("furigana via mecab failed: {e}");
            (fallback_furigana(text), false)
        }
    }
}

async fn tokenize_via_sudachi(sudachi: &'static SharedSudachi, text: &str) -> (Vec<Value>, bool) {
    let response = {
        let mut service = sudachi.lock().await;
        service.tokenize(text).await
    };

    match response {
        Ok(tokens) => (tokens, true),
        Err(e) => {
            warn!("tokenize via sudachi failed: {e}");
            (fallback_tokens(text), false)
        }
    }
}

async fn furigana_via_sudachi(sudachi: &'static SharedSudachi, text: &str) -> (Vec<Value>, bool) {
    let response = {
        let mut service = sudachi.lock().await;
        service.furigana(text).await
    };

    match response {
        Ok(segments) => (segments, true),
        Err(e) => {
            warn!("furigana via sudachi failed: {e}");
            (fallback_furigana(text), false)
        }
    }
}

// ------------------------------ Websocket ------------------------------------

async fn handle_socket(
    peer: SocketAddr,
    stream: TcpStream,
    _tx: broadcast::Sender<String>,
    mut rx: broadcast::Receiver<String>,
    states: &'static SharedStates,
    mecab: &'static SharedMecab,
    sudachi: &'static SharedSudachi,
) {
    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            warn!("ws accept error from {peer}: {e}");
            return;
        }
    };

    info!("client connected: {peer}");

    let (mut ws_sink, mut ws_stream) = ws.split();

    // Immediately send current state snapshot.
    // Clone data first so we don't hold the mutex while awaiting socket writes.
    let snapshot = {
        let guard = states.lock().await;
        guard
            .values()
            .map(|st| (st.device_name.clone(), st.buttons.clone(), st.axes.clone()))
            .collect::<Vec<_>>()
    };
    for (device_name, buttons, axes) in snapshot {
        let msg = json!({
            "type": "gamepad_connected",
            "device": device_name,
            "state": {
                "buttons": buttons,
                "axes": axes,
            }
        });
        if ws_sink.send(Message::Text(msg.to_string())).await.is_err() {
            info!("client {peer} disconnected during initial snapshot");
            return;
        }
    }

    loop {
        tokio::select! {
            // Server broadcast to this client
            b = rx.recv() => {
                match b {
                    Ok(text) => {
                        if ws_sink.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("client {peer} lagged; dropped {n} messages");
                    }
                    Err(_) => break,
                }
            }

            // Client -> server
            m = ws_stream.next() => {
                match m {
                    Some(Ok(Message::Text(text))) => {
                        let parsed: Result<ClientMsg, _> = serde_json::from_str(&text);
                        match parsed {
                            Ok(ClientMsg::Ping) => {
                                let _ = ws_sink.send(Message::Text(json!({"type":"pong"}).to_string())).await;
                            }
                            Ok(ClientMsg::GetState) => {
                                let snapshot = {
                                    let guard = states.lock().await;
                                    guard
                                        .values()
                                        .map(|st| (st.device_name.clone(), st.buttons.clone(), st.axes.clone()))
                                        .collect::<Vec<_>>()
                                };

                                for (device_name, buttons, axes) in snapshot {
                                    let msg = json!({
                                        "type": "gamepad_state",
                                        "device": device_name,
                                        "buttons": buttons,
                                        "axes": axes,
                                    });
                                    if ws_sink.send(Message::Text(msg.to_string())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Ok(ClientMsg::Tokenize {
                                text,
                                block_index,
                                backend,
                            }) => {
                                let selected_backend =
                                    ServerTokenizerBackend::from_value(backend.as_deref());
                                let (tokens, mecab_available, sudachi_available) = if text.is_empty() {
                                    (Vec::new(), false, false)
                                } else {
                                    match selected_backend {
                                        ServerTokenizerBackend::Mecab => {
                                            let (tokens, available) =
                                                tokenize_via_mecab(mecab, &text).await;
                                            (tokens, available, false)
                                        }
                                        ServerTokenizerBackend::Sudachi => {
                                            let (tokens, available) =
                                                tokenize_via_sudachi(sudachi, &text).await;
                                            (tokens, false, available)
                                        }
                                    }
                                };

                                let msg = json!({
                                    "type": "tokens",
                                    "blockIndex": block_index,
                                    "text": text,
                                    "tokens": tokens,
                                    "tokenSource": selected_backend.token_source(),
                                    "mecabAvailable": mecab_available,
                                    "sudachiAvailable": sudachi_available,
                                    "yomitanApiAvailable": false,
                                });
                                if ws_sink.send(Message::Text(msg.to_string())).await.is_err() {
                                    break;
                                }
                            }
                            Ok(ClientMsg::GetFurigana {
                                text,
                                line_index,
                                request_id,
                                backend,
                            }) => {
                                let selected_backend =
                                    ServerTokenizerBackend::from_value(backend.as_deref());
                                let (segments, mecab_available, sudachi_available) = if text.is_empty() {
                                    (Vec::new(), false, false)
                                } else {
                                    match selected_backend {
                                        ServerTokenizerBackend::Mecab => {
                                            let (segments, available) =
                                                furigana_via_mecab(mecab, &text).await;
                                            (segments, available, false)
                                        }
                                        ServerTokenizerBackend::Sudachi => {
                                            let (segments, available) =
                                                furigana_via_sudachi(sudachi, &text).await;
                                            (segments, false, available)
                                        }
                                    }
                                };

                                let mut msg = json!({
                                    "type": "furigana",
                                    "lineIndex": line_index,
                                    "text": text,
                                    "segments": segments,
                                    "mecabAvailable": mecab_available,
                                    "sudachiAvailable": sudachi_available,
                                    "yomitanApiAvailable": false,
                                });
                                if let Some(req_id) = request_id {
                                    msg["requestId"] = req_id;
                                }

                                if ws_sink.send(Message::Text(msg.to_string())).await.is_err() {
                                    break;
                                }
                            }
                            _ => {
                                // ignore unknown messages
                            }
                        }
                    }
                    Some(Ok(Message::Ping(_))) => {
                        let _ = ws_sink.send(Message::Pong(Vec::new())).await;
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        warn!("client {peer} ws error: {e}");
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    info!("client disconnected: {peer}");
}

async fn websocket_server(
    bind: SocketAddr,
    tx: broadcast::Sender<String>,
    states: &'static SharedStates,
    mecab: &'static SharedMecab,
    sudachi: &'static SharedSudachi,
) {
    let listener = TcpListener::bind(bind).await.expect("bind failed");
    info!("server running at ws://{bind}");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                error!("accept error: {e}");
                continue;
            }
        };

        let rx = tx.subscribe();
        let tx_clone = tx.clone();

        tokio::spawn(handle_socket(
            peer, stream, tx_clone, rx, states, mecab, sudachi,
        ));
    }
}

// ------------------------------ Input loops ----------------------------------

/// Runs on a dedicated OS thread because Gilrs isn't Send.
fn gilrs_input_thread(
    tx: broadcast::Sender<String>,
    states: &'static SharedStates,
    cfg: Config,
    dev_environment: bool,
) {
    let mut gilrs = match Gilrs::new() {
        Ok(g) => g,
        Err(e) => {
            error!("Failed to initialize gilrs: {e}");
            return;
        }
    };
    let mut dev_logger = DevInputLogger::new(dev_environment);

    info!("gilrs initialized; waiting for gamepad input...");
    if dev_environment {
        info!(
            "dev gamepad logging enabled (GSM_DEV_ENVIRONMENT=1): raw events on, stick-axis logs sampled"
        );
    }

    // Pre-populate any already-connected pads.
    // IMPORTANT: don't hold a non-Send iterator across async awaits (we're on a thread anyway).
    let connected: Vec<(GamepadId, String)> = gilrs
        .gamepads()
        .filter(|(_, gp)| gp.is_connected())
        .map(|(id, gp)| (id, gp.name().to_string()))
        .collect();

    // Use blocking_lock() since we're on a plain thread.
    for (id, name) in connected {
        let mut guard = states.blocking_lock();
        if !guard.contains_key(&id) {
            guard.insert(id, GamepadState::new(name.clone()));
            drop(guard);

            let msg = json!({
                "type": "gamepad_connected",
                "device": name,
            });
            send_broadcast(&tx, msg.to_string(), "gamepad_connected(startup)");
            info!("gamepad detected at startup: {name}");
        }
    }

    // Poll loop
    loop {
        while let Some(Event { id, event, .. }) = gilrs.next_event() {
            let now = Instant::now();
            let device_name = gilrs.gamepad(id).name().to_string();

            if dev_logger.enabled {
                match &event {
                    EventType::ButtonPressed(btn, _) => {
                        debug!("dev input raw: device={device_name} event=ButtonPressed button={btn:?}");
                    }
                    EventType::ButtonReleased(btn, _) => {
                        debug!("dev input raw: device={device_name} event=ButtonReleased button={btn:?}");
                    }
                    EventType::ButtonChanged(btn, value, _) => {
                        debug!(
                            "dev input raw: device={device_name} event=ButtonChanged button={btn:?} value={:.3}",
                            *value
                        );
                    }
                    EventType::AxisChanged(ax, raw, _) => {
                        if let Some(name) = axis_name(*ax) {
                            let normalized = if matches!(name, "lt" | "rt") {
                                normalize_trigger(*raw)
                            } else {
                                normalize_stick(*raw, cfg.deadzone)
                            };
                            if !is_stick_axis(name)
                                || dev_logger.should_log_stick(id, name, normalized, now)
                            {
                                debug!(
                                    "dev input raw: device={device_name} event=AxisChanged axis={name} raw={:.3} normalized={:.3}",
                                    *raw,
                                    normalized
                                );
                            }
                        } else {
                            debug!(
                                "dev input raw: device={device_name} event=AxisChanged axis={ax:?} raw={:.3}",
                                *raw
                            );
                        }
                    }
                    EventType::Connected => {
                        debug!("dev input raw: device={device_name} event=Connected");
                    }
                    EventType::Disconnected => {
                        debug!("dev input raw: device={device_name} event=Disconnected");
                    }
                    other => {
                        debug!("dev input raw: device={device_name} event={other:?}");
                    }
                }
            }

            // Ensure state exists
            {
                let mut guard = states.blocking_lock();
                guard
                    .entry(id)
                    .or_insert_with(|| GamepadState::new(device_name.clone()));
            }

            match event {
                EventType::Connected => {
                    let mut guard = states.blocking_lock();
                    let st = guard
                        .entry(id)
                        .or_insert_with(|| GamepadState::new(device_name.clone()));
                    st.connected = true;
                    st.device_name = device_name.clone();
                    drop(guard);

                    let msg = json!({
                        "type": "gamepad_connected",
                        "device": device_name,
                    });
                    send_broadcast(&tx, msg.to_string(), "gamepad_connected");
                    info!("gamepad connected: {}", gilrs.gamepad(id).name());
                }

                EventType::Disconnected => {
                    let mut guard = states.blocking_lock();
                    if let Some(st) = guard.get_mut(&id) {
                        st.connected = false;
                    }
                    drop(guard);
                    let msg = json!({
                        "type": "gamepad_disconnected",
                        "device": device_name,
                    });
                    send_broadcast(&tx, msg.to_string(), "gamepad_disconnected");
                    info!("gamepad disconnected: {device_name}");
                }

                EventType::ButtonPressed(btn, _) | EventType::ButtonReleased(btn, _) => {
                    if let Some(code) = map_button(btn) {
                        let pressed = matches!(event, EventType::ButtonPressed(_, _));

                        let mut guard = states.blocking_lock();
                        if let Some(st) = guard.get_mut(&id) {
                            st.device_name = device_name.clone();

                            if matches!(code, ButtonCode::LT | ButtonCode::RT) {
                                let axis_name = if matches!(code, ButtonCode::LT) {
                                    "lt"
                                } else {
                                    "rt"
                                };
                                st.axes
                                    .insert(axis_name.to_string(), if pressed { 1.0 } else { 0.0 });
                            }

                            let old = *st.buttons.get(&(code as u8)).unwrap_or(&false);
                            if old != pressed {
                                st.buttons.insert(code as u8, pressed);

                                let mut msg = json!({
                                    "type": "button",
                                    "device": st.device_name,
                                    "button": code as u8,
                                    "pressed": pressed,
                                    "name": format!("{:?}", code),
                                });
                                if matches!(code, ButtonCode::LT | ButtonCode::RT) {
                                    msg["value"] = json!(if pressed { 1.0 } else { 0.0 });
                                }
                                drop(guard);
                                send_broadcast(&tx, msg.to_string(), "button");
                                info!("button event: device={device_name} button={code:?} pressed={pressed}");
                            }
                        }
                    }
                }

                EventType::ButtonChanged(btn, value, _) => {
                    if let Some(code) = map_button(btn) {
                        let pressed = if matches!(code, ButtonCode::LT | ButtonCode::RT) {
                            value > cfg.trigger_threshold
                        } else {
                            digital_pressed(value)
                        };

                        let mut guard = states.blocking_lock();
                        if let Some(st) = guard.get_mut(&id) {
                            st.device_name = device_name.clone();

                            if matches!(code, ButtonCode::LT | ButtonCode::RT) {
                                let axis_name = if matches!(code, ButtonCode::LT) {
                                    "lt"
                                } else {
                                    "rt"
                                };
                                let trigger_value = normalize_trigger(value);
                                st.axes.insert(axis_name.to_string(), trigger_value);
                            }

                            let old = *st.buttons.get(&(code as u8)).unwrap_or(&false);
                            if old != pressed {
                                st.buttons.insert(code as u8, pressed);

                                let mut msg = json!({
                                    "type": "button",
                                    "device": st.device_name,
                                    "button": code as u8,
                                    "pressed": pressed,
                                    "name": format!("{:?}", code),
                                });
                                if matches!(code, ButtonCode::LT | ButtonCode::RT) {
                                    msg["value"] = json!(normalize_trigger(value));
                                }
                                drop(guard);
                                send_broadcast(&tx, msg.to_string(), "button(analog)");
                                info!(
                                    "button event (analog): device={device_name} button={code:?} pressed={pressed} value={value:.3}"
                                );
                            }
                        }
                    } else {
                        debug!("unmapped button change: device={device_name} button={btn:?} value={value:.3}");
                    }
                }

                EventType::AxisChanged(ax, raw, _) => {
                    if matches!(ax, Axis::DPadX | Axis::DPadY) {
                        let mut guard = states.blocking_lock();
                        let mut outgoing: Vec<String> = Vec::new();

                        if let Some(st) = guard.get_mut(&id) {
                            st.device_name = device_name.clone();

                            let dpad_updates: [(ButtonCode, bool, &str); 2] = match ax {
                                Axis::DPadX => [
                                    (ButtonCode::DPAD_LEFT, raw < -0.5, "DPAD_LEFT"),
                                    (ButtonCode::DPAD_RIGHT, raw > 0.5, "DPAD_RIGHT"),
                                ],
                                Axis::DPadY => [
                                    (ButtonCode::DPAD_UP, raw < -0.5, "DPAD_UP"),
                                    (ButtonCode::DPAD_DOWN, raw > 0.5, "DPAD_DOWN"),
                                ],
                                _ => unreachable!(),
                            };

                            for (code, pressed, name) in dpad_updates {
                                let old = *st.buttons.get(&(code as u8)).unwrap_or(&false);
                                if old != pressed {
                                    st.buttons.insert(code as u8, pressed);
                                    outgoing.push(
                                        json!({
                                            "type": "button",
                                            "device": st.device_name,
                                            "button": code as u8,
                                            "pressed": pressed,
                                            "name": name,
                                        })
                                        .to_string(),
                                    );
                                }
                            }
                        }
                        drop(guard);
                        for msg in outgoing {
                            send_broadcast(&tx, msg, "button(dpad_axis)");
                        }
                        continue;
                    }

                    if let Some(name) = axis_name(ax) {
                        let mut guard = states.blocking_lock();
                        if let Some(st) = guard.get_mut(&id) {
                            st.device_name = device_name.clone();

                            let value = match name {
                                "lt" | "rt" => normalize_trigger(raw),
                                _ => normalize_stick(raw, cfg.deadzone),
                            };

                            st.axes.insert(name.to_string(), value);

                            // Triggers also act like buttons past threshold
                            if name == "lt" {
                                let lt_pressed = value > cfg.trigger_threshold;
                                let old =
                                    *st.buttons.get(&(ButtonCode::LT as u8)).unwrap_or(&false);
                                if old != lt_pressed {
                                    st.buttons.insert(ButtonCode::LT as u8, lt_pressed);

                                    let msg = json!({
                                        "type": "button",
                                        "device": st.device_name,
                                        "button": ButtonCode::LT as u8,
                                        "pressed": lt_pressed,
                                        "name": "LT",
                                        "value": value,
                                    });
                                    drop(guard);
                                    send_broadcast(&tx, msg.to_string(), "button(trigger_lt)");
                                    info!("button event: device={device_name} button=LT pressed={lt_pressed} value={value:.3}");
                                    continue;
                                }
                            } else if name == "rt" {
                                let rt_pressed = value > cfg.trigger_threshold;
                                let old =
                                    *st.buttons.get(&(ButtonCode::RT as u8)).unwrap_or(&false);
                                if old != rt_pressed {
                                    st.buttons.insert(ButtonCode::RT as u8, rt_pressed);

                                    let msg = json!({
                                        "type": "button",
                                        "device": st.device_name,
                                        "button": ButtonCode::RT as u8,
                                        "pressed": rt_pressed,
                                        "name": "RT",
                                        "value": value,
                                    });
                                    drop(guard);
                                    send_broadcast(&tx, msg.to_string(), "button(trigger_rt)");
                                    info!("button event: device={device_name} button=RT pressed={rt_pressed} value={value:.3}");
                                    continue;
                                }
                            }

                            if should_send_axis(st, name, value, &cfg, now) {
                                let msg = json!({
                                    "type": "axis",
                                    "device": st.device_name,
                                    "axis": name,
                                    "value": value,
                                });
                                drop(guard);
                                send_broadcast(&tx, msg.to_string(), "axis");
                                debug!(
                                    "axis event: device={device_name} axis={name} value={value:.3}"
                                );
                            }
                        }
                    } else {
                        debug!(
                            "unmapped axis change: device={device_name} axis={ax:?} value={raw:.3}"
                        );
                    }
                }

                other => {
                    debug!("ignored event from {device_name}: {other:?}");
                }
            }
        }

        // Prevent busy spin when idle
        thread::sleep(Duration::from_millis(4));
    }
}

async fn axis_repeat_loop(
    tx: broadcast::Sender<String>,
    states: &'static SharedStates,
    cfg: Config,
) {
    let stick_axes = ["left_x", "left_y", "right_x", "right_y"];

    loop {
        let now = Instant::now();

        {
            let mut guard = states.lock().await;
            for (_id, st) in guard.iter_mut() {
                if !st.connected {
                    continue;
                }

                for axis in stick_axes {
                    let value = *st.axes.get(axis).unwrap_or(&0.0);

                    // Only rebroadcast if held away from 0
                    if value.abs() < cfg.deadzone {
                        continue;
                    }

                    if should_send_axis(st, axis, value, &cfg, now) {
                        let msg = json!({
                            "type": "axis",
                            "device": st.device_name,
                            "axis": axis,
                            "value": value,
                        });
                        send_broadcast(&tx, msg.to_string(), "axis_repeat");
                    }
                }
            }
        }

        time::sleep(cfg.axis_hold_repeat_interval).await;
    }
}

// ---------------------------------- main ------------------------------------

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let dev_environment = gsm_dev_environment_enabled();
    init_tracing(dev_environment);
    let args = Args::parse();
    if dev_environment {
        info!(
            "GSM_DEV_ENVIRONMENT=1 detected; enabling verbose gamepad logging with sampled stick-axis logs"
        );
    }

    let bind: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .expect("invalid bind addr");

    let (tx, _rx) = broadcast::channel::<String>(2048);

    // Leak states so spawned tasks can use 'static reference.
    let states: &'static SharedStates = Box::leak(Box::new(Mutex::new(HashMap::new())));
    let mecab_script = resolve_mecab_script_path();
    let mecab: &'static SharedMecab =
        Box::leak(Box::new(Mutex::new(MecabService::new(mecab_script))));
    let sudachi_data_dir = resolve_sudachi_data_dir();
    let sudachi_user_dict_dir = resolve_sudachi_user_dicts_dir();
    let sudachi_dictionary_kind = sudachi_dictionary_kind_from_env();
    let sudachi: &'static SharedSudachi = Box::leak(Box::new(Mutex::new(SudachiService::new(
        sudachi_data_dir,
        sudachi_user_dict_dir,
        sudachi_dictionary_kind,
    ))));
    {
        let mut svc = mecab.lock().await;
        if let Err(e) = svc.ensure_bridge().await {
            warn!("mecab bridge init failed; continuing without mecab: {e}");
        }
    }
    if preferred_server_tokenizer_backend_from_env() == ServerTokenizerBackend::Sudachi {
        let mut svc = sudachi.lock().await;
        if let Err(e) = svc.ensure_tokenizer().await {
            warn!("sudachi init failed; continuing without sudachi: {e}");
        }
    }

    let cfg = Config::default();

    // Websocket server + axis repeat run on tokio.
    tokio::spawn(websocket_server(bind, tx.clone(), states, mecab, sudachi));
    tokio::spawn(axis_repeat_loop(tx.clone(), states, cfg.clone()));

    // Gilrs input loop runs on a dedicated OS thread (Gilrs isn't Send).
    {
        let tx2 = tx.clone();
        let cfg2 = cfg.clone();
        thread::spawn(move || gilrs_input_thread(tx2, states, cfg2, dev_environment));
    }

    info!("startup complete");
    loop {
        time::sleep(Duration::from_secs(3600)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn katakana_readings_convert_to_hiragana() {
        assert_eq!(katakana_to_hiragana("キンチョウ"), "きんちょう");
        assert_eq!(katakana_to_hiragana("ゲーム"), "げーむ");
    }

    #[test]
    fn kanji_detection_matches_japanese_text() {
        assert!(has_kanji("緊張気味"));
        assert!(!has_kanji("きんちょう"));
    }

    #[test]
    fn tokenizer_backend_defaults_to_mecab() {
        assert_eq!(
            ServerTokenizerBackend::from_value(Some("sudachi")),
            ServerTokenizerBackend::Sudachi
        );
        assert_eq!(
            ServerTokenizerBackend::from_value(Some("mecab")),
            ServerTokenizerBackend::Mecab
        );
        assert_eq!(
            ServerTokenizerBackend::from_value(Some("unknown")),
            ServerTokenizerBackend::Mecab
        );
        assert_eq!(
            ServerTokenizerBackend::from_value(None),
            ServerTokenizerBackend::Mecab
        );
    }
}
