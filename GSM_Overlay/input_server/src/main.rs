use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use gilrs::{Axis, Button, Event, EventType, GamepadId, Gilrs};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, Mutex};
use tokio::time;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

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
    #[arg(long, default_value_t = 55003)]
    port: u16,
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

type SharedStates = Mutex<HashMap<GamepadId, GamepadState>>;
type SharedMecab = Mutex<MecabService>;

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
        let mut attempts: Vec<(String, Vec<String>)> = Vec::new();
        if let Ok(custom) = std::env::var("GSM_PYTHON") {
            if !custom.trim().is_empty() {
                attempts.push((custom, Vec::new()));
            }
        }
        attempts.push(("python".to_string(), Vec::new()));
        attempts.push(("py".to_string(), vec!["-3".to_string()]));
        attempts.push(("python3".to_string(), Vec::new()));

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
    },

    #[serde(rename = "get_furigana")]
    GetFurigana {
        #[serde(default)]
        text: String,
        #[serde(default, rename = "lineIndex")]
        line_index: i64,
        #[serde(default, rename = "requestId")]
        request_id: Option<Value>,
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

// ------------------------------ Websocket ------------------------------------

async fn handle_socket(
    peer: SocketAddr,
    stream: TcpStream,
    _tx: broadcast::Sender<String>,
    mut rx: broadcast::Receiver<String>,
    states: &'static SharedStates,
    mecab: &'static SharedMecab,
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
                            Ok(ClientMsg::Tokenize { text, block_index }) => {
                                let (tokens, mecab_available) = if text.is_empty() {
                                    (Vec::new(), false)
                                } else {
                                    tokenize_via_mecab(mecab, &text).await
                                };

                                let msg = json!({
                                    "type": "tokens",
                                    "blockIndex": block_index,
                                    "text": text,
                                    "tokens": tokens,
                                    "tokenSource": "mecab",
                                    "mecabAvailable": mecab_available,
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
                            }) => {
                                let (segments, mecab_available) = if text.is_empty() {
                                    (Vec::new(), false)
                                } else {
                                    furigana_via_mecab(mecab, &text).await
                                };

                                let mut msg = json!({
                                    "type": "furigana",
                                    "lineIndex": line_index,
                                    "text": text,
                                    "segments": segments,
                                    "mecabAvailable": mecab_available,
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

        tokio::spawn(handle_socket(peer, stream, tx_clone, rx, states, mecab));
    }
}

// ------------------------------ Input loops ----------------------------------

/// Runs on a dedicated OS thread because Gilrs isn't Send.
fn gilrs_input_thread(tx: broadcast::Sender<String>, states: &'static SharedStates, cfg: Config) {
    let mut gilrs = match Gilrs::new() {
        Ok(g) => g,
        Err(e) => {
            error!("Failed to initialize gilrs: {e}");
            return;
        }
    };

    info!("gilrs initialized; waiting for gamepad input...");

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
        thread::sleep(Duration::from_millis(2));
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
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    let bind: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .expect("invalid bind addr");

    let (tx, _rx) = broadcast::channel::<String>(2048);

    // Leak states so spawned tasks can use 'static reference.
    let states: &'static SharedStates = Box::leak(Box::new(Mutex::new(HashMap::new())));
    let mecab_script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mecab_bridge.py");
    let mecab: &'static SharedMecab =
        Box::leak(Box::new(Mutex::new(MecabService::new(mecab_script))));
    {
        let mut svc = mecab.lock().await;
        if let Err(e) = svc.ensure_bridge().await {
            warn!("mecab bridge init failed; continuing without mecab: {e}");
        }
    }

    let cfg = Config::default();

    // Websocket server + axis repeat run on tokio.
    tokio::spawn(websocket_server(bind, tx.clone(), states, mecab));
    tokio::spawn(axis_repeat_loop(tx.clone(), states, cfg.clone()));

    // Gilrs input loop runs on a dedicated OS thread (Gilrs isn't Send).
    {
        let tx2 = tx.clone();
        let cfg2 = cfg.clone();
        thread::spawn(move || gilrs_input_thread(tx2, states, cfg2));
    }

    info!("startup complete");
    loop {
        time::sleep(Duration::from_secs(3600)).await;
    }
}
