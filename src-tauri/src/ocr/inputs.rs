//! Native clipboard and controller input. One bounded image mailbox, no polling
//! while OCR is stopped. Controller events use the existing Rust input service.
use super::*;
use std::collections::{HashMap, HashSet};
use std::net::TcpStream;
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};
const BINDINGS: [(&str, &str); 6] = [
    ("manualOcrGamepad", "manual_ocr"),
    ("menuOcrGamepad", "menu_ocr"),
    ("areaSelectOcrGamepad", "area_select_ocr"),
    ("wholeWindowOcrGamepad", "whole_window_ocr"),
    ("addAreaOcrGamepad", "add_ocr_area"),
    ("globalPauseGamepad", "toggle_pause"),
];
fn binding(value: &Value) -> HashSet<u8> {
    let owned = value.as_i64().map(|v| v.to_string());
    let text = value.as_str().or(owned.as_deref()).unwrap_or("");
    text.split('+')
        .filter_map(|part| {
            let normalized = part
                .chars()
                .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
                .collect::<String>()
                .to_uppercase();
            match normalized.as_str() {
                "A" => Some(0),
                "B" => Some(1),
                "X" => Some(2),
                "Y" => Some(3),
                "LB" => Some(4),
                "RB" => Some(5),
                "LT" => Some(6),
                "RT" => Some(7),
                "BACK" | "SELECT" | "BACK/SELECT" => Some(8),
                "START" => Some(9),
                "LS" => Some(10),
                "RS" => Some(11),
                "DPADUP" => Some(12),
                "DPADDOWN" => Some(13),
                "DPADLEFT" => Some(14),
                "DPADRIGHT" => Some(15),
                "GUIDE" | "HOME" | "MODE" => Some(16),
                _ => part.trim().parse::<u8>().ok().filter(|v| *v <= 16),
            }
        })
        .collect()
}
#[derive(Default)]
pub(crate) struct Dispatcher {
    pressed: HashMap<String, HashSet<u8>>,
    active: HashSet<(String, usize)>,
}
impl Dispatcher {
    fn receive(&mut self, message: &Value, settings: &Value) -> Vec<&'static str> {
        self.receive_with(message,settings,&BINDINGS)
    }
    pub(crate) fn receive_with(&mut self, message: &Value, settings: &Value, bindings: &[(&str,&'static str)]) -> Vec<&'static str> {
        let Some(device) = message["device"].as_str() else {
            return vec![];
        };
        let kind = message["type"].as_str().unwrap_or("");
        if kind == "gamepad_disconnected" {
            self.pressed.remove(device);
            self.active.retain(|(d, _)| d != device);
            return vec![];
        }
        let pressed = self.pressed.entry(device.into()).or_default();
        match kind {
            "gamepad_connected" | "gamepad_state" => {
                let buttons = if kind == "gamepad_connected" {
                    &message["state"]["buttons"]
                } else {
                    &message["buttons"]
                };
                *pressed = buttons
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(_, v)| **v == true)
                    .filter_map(|(k, _)| k.parse().ok())
                    .collect();
            }
            "button" => {
                if let Some(button) = message["button"].as_u64().filter(|v| *v <= 16) {
                    if message["pressed"] == true {
                        pressed.insert(button as u8);
                    } else {
                        pressed.remove(&(button as u8));
                    }
                }
            }
            _ => return vec![],
        }
        let mut actions = Vec::new();
        for (index, (key, action)) in bindings.iter().enumerate() {
            let buttons = binding(&settings[*key]);
            let key = (device.into(), index);
            if !buttons.is_empty() && buttons.is_subset(pressed) {
                if self.active.insert(key) && kind == "button" {
                    actions.push(*action);
                }
            } else {
                self.active.remove(&key);
            }
        }
        actions
    }
}
fn connect(url: &str, keys: &[String]) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid input service URL")?;
    // The existing input server is local, with an ephemeral advertised port.
    if parsed.host_str() != Some("127.0.0.1") {
        return Err("Input service must be local".into());
    }
    let stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", parsed.port().unwrap_or(7276))
            .parse()
            .unwrap(),
        Duration::from_secs(1),
    )
    .map_err(|_| "Input service unavailable")?;
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|e| e.to_string())?;
    let (mut socket, _) = tungstenite::client(url, MaybeTlsStream::Plain(stream))
        .map_err(|_| "Input service handshake failed")?;
    for request in [
        json!({"type":"configure_features","features":if keys.is_empty(){vec![]}else{vec!["keyboard"]}}),
        json!({"type":"configure_keyboard_subscription","keys":keys}),
        json!({"type":"get_state"}),
    ] {
        socket
            .send(Message::Text(request.to_string().into()))
            .map_err(|_| "Input service disconnected")?;
    }
    Ok(socket)
}
pub fn start(app: tauri::AppHandle, worker: Ocr) {
    std::thread::Builder::new()
        .name("gsm-ocr-input".into())
        .spawn(move || run(app, worker))
        .expect("Start native OCR input worker");
}
fn run(app: tauri::AppHandle, worker: Ocr) {
    let mut socket = None;
    let mut connected = String::new();
    let mut dispatcher = Dispatcher::default();
    let mut keyboard = super::keyboard::Keyboard::default();
    let mut clipboard = None;
    let mut previous = None;
    let mut last_clip = Instant::now();
    let mut retry = Instant::now();
    let mut last_error = String::new();
    let mut previous_settings = Value::Null;
    loop {
        let (lock, wake) = &*worker.0;
        let state = lock.lock().unwrap();
        if state.closed {
            return;
        }
        let settings = state.config["settings"].clone();
        if settings != previous_settings {
            dispatcher = Dispatcher::default();
            keyboard = super::keyboard::Keyboard::new(&settings);
            previous_settings = settings.clone();
            // Reconnect to replace this client's key/feature lease atomically.
            socket = None;
            retry = Instant::now();
        }
        let keys = keyboard.keys();
        let pad = state.running
            && flag(
                &settings,
                "gamepadHotkeysEnabled",
                BINDINGS
                    .iter()
                    .any(|(key, _)| !binding(&settings[*key]).is_empty()),
            );
        let listen = pad || !keys.is_empty();
        let clip = state.running
            && !state.paused
            && (settings["advancedMode"] == true || state.config["screenshot_only"] == true)
            && settings["ocr_screenshots"] == true;
        if !state.running
            || (!listen && !clip)
            || !state.lease.is_some_and(|t| t.elapsed() < CONTEXT_LEASE)
        {
            socket = None;
            clipboard = None;
            dispatcher = Dispatcher::default();
            keyboard = super::keyboard::Keyboard::new(&settings);
            previous = None;
            drop(wake.wait(state).unwrap());
            continue;
        }
        let session = state.session.clone();
        let generation = state.generation;
        let target = state.config["target_id"].as_u64();
        let endpoint = state.config["input_url"].as_str().unwrap_or("").to_owned();
        drop(state);
        let mut received_input = false;
        if listen {
            if connected != endpoint {
                socket = None;
                connected = endpoint;
                retry = Instant::now();
            }
            if socket.is_none() && Instant::now() >= retry && !connected.is_empty() {
                match connect(&connected, &keys) {
                    Ok(s) => {
                        socket = Some(s);
                        dispatcher = Dispatcher::default();
                        keyboard = super::keyboard::Keyboard::new(&settings);
                        last_error.clear();
                    }
                    Err(error) => {
                        if error != last_error {
                            let s = lock.lock().unwrap();
                            emit(&app, &s, "error", json!({"error":error}));
                            last_error = error;
                        }
                    }
                }
                retry = Instant::now() + Duration::from_secs(2);
            }
            if let Some(ws) = socket.as_mut() {
                match ws.read() {
                    Ok(Message::Text(message)) => {
                        received_input = true;
                        if let Ok(message) = serde_json::from_str::<Value>(&message) {
                            let is_keyboard = message["type"] == "keyboard_event";
                            let actions = if is_keyboard {
                                keyboard.receive(&message, super::keyboard::target_visible(target))
                            } else if pad {
                                dispatcher.receive(&message, &settings)
                            } else {
                                vec![]
                            };
                            for action in actions {
                                let s = lock.lock().unwrap();
                                if !s.running
                                    || s.session != session
                                    || s.config["target_id"].as_u64() != target
                                    || !s.lease.is_some_and(|t| t.elapsed() < CONTEXT_LEASE)
                                {
                                    continue;
                                }
                                if action == "add_ocr_area" {
                                    emit(&app, &s, action, Value::Null);
                                } else {
                                    drop(s);
                                    let delay = if action == "manual_ocr"
                                        && (!is_keyboard
                                            || !flag(&settings, "manualOcrDelayGamepadOnly", false))
                                    {
                                        number(&settings, "manualOcrDelayMs", 0.) as u64
                                    } else {
                                        0
                                    };
                                    match worker.command(
                                        json!({"action":action,"session":session,"delayMs":delay}),
                                    ) {
                                        Ok(status) => {
                                            let state = lock.lock().unwrap();
                                            if state.session == session && state.running {
                                                emit(&app, &state, "status", status);
                                                if action == "toggle_pause" {
                                                    emit(
                                                        &app,
                                                        &state,
                                                        if state.paused {
                                                            "paused"
                                                        } else {
                                                            "unpaused"
                                                        },
                                                        json!({"paused":state.paused}),
                                                    );
                                                }
                                            }
                                        }
                                        Err(error) => {
                                            let state = lock.lock().unwrap();
                                            if state.session == session && state.running {
                                                emit(&app, &state, "error", json!({"error":error}));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(tungstenite::Error::Io(e))
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                        ) => {}
                    Err(_) | Ok(Message::Close(_)) => {
                        socket = None;
                        dispatcher = Dispatcher::default();
                    }
                    Ok(_) => received_input = true,
                }
            }
        } else {
            socket = None;
        }
        if clip && last_clip.elapsed() >= Duration::from_millis(250) {
            last_clip = Instant::now();
            if clipboard.is_none() {
                clipboard = arboard::Clipboard::new().ok();
            }
            if let Some(clipboard) = clipboard.as_mut() {
                #[cfg(windows)]
                let changed = {
                    let sequence = unsafe {
                        windows::Win32::System::DataExchange::GetClipboardSequenceNumber()
                    };
                    let changed = previous.is_some() && previous != Some(sequence as u64);
                    previous = Some(sequence as u64);
                    changed
                };
                #[cfg(not(windows))]
                let changed = true;
                if changed && clipboard.get_text().ok().as_deref() != Some("*ocr_ignore*") {
                    if let Ok(image) = clipboard.get_image() {
                        if image.width.saturating_mul(image.height) <= 32_000_000 {
                            if let Some(image) = image::RgbaImage::from_raw(
                                image.width as u32,
                                image.height as u32,
                                image.bytes.into_owned(),
                            ) {
                                #[cfg(not(windows))]
                                {
                                    let hash = image_hash(&image);
                                    if previous == Some(hash) {
                                        continue;
                                    }
                                    previous = Some(hash);
                                }
                                let mut s = lock.lock().unwrap();
                                if s.generation == generation && s.running && !s.paused {
                                    s.generation += 1;
                                    s.pending = Some("clipboard_ocr".into());
                                    s.pending_ready = None;
                                    s.clipboard = Some(image);
                                    wake.notify_all();
                                }
                            }
                        }
                    }
                }
            }
        }
        wait_for_input(&worker.0, listen, received_input);
    }
}

fn wait_for_input(shared: &Shared, listen: bool, received_input: bool) {
    // A moving controller can send hundreds of axis messages per second even
    // when OCR's gamepad bindings are disabled. Drain queued messages promptly;
    // the socket's bounded read timeout already waits when there is no input.
    // The outer loop still checks shutdown, context, and clipboard every pass.
    if received_input {
        return;
    }
    let (lock, wake) = &**shared;
    let s = lock.lock().unwrap();
    drop(
        wake.wait_timeout(s, Duration::from_millis(if listen { 10 } else { 250 }))
            .unwrap(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_hotkey_is_not_delayed_by_controller_axis_traffic() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            for index in 0..240 {
                socket
                    .send(Message::Text(
                        json!({"type":"axis","device":"pad","axis":"left_x","value":index})
                            .to_string()
                            .into(),
                    ))
                    .unwrap();
            }
            socket
                .send(Message::Text(
                    json!({"type":"keyboard_event","key":"F15","pressed":true,"modifiers":{}})
                        .to_string()
                        .into(),
                ))
                .unwrap();
        });
        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (mut socket, _) =
            tungstenite::client(format!("ws://{address}"), MaybeTlsStream::Plain(stream)).unwrap();
        let shared = Arc::new((Mutex::new(Inner::default()), Condvar::new()));
        let mut keyboard =
            super::super::keyboard::Keyboard::new(&json!({"areaSelectOcrHotkey":"F15"}));
        let started = Instant::now();
        let mut actions = Vec::new();
        for _ in 0..241 {
            let Message::Text(message) = socket.read().unwrap() else {
                panic!("Expected input");
            };
            let message: Value = serde_json::from_str(&message).unwrap();
            actions.extend(keyboard.receive(&message, true));
            wait_for_input(&shared, true, true);
        }
        server.join().unwrap();
        assert_eq!(actions, ["area_select_ocr"]);
        eprintln!(
            "Area-select hotkey after 240 controller messages: {:?}",
            started.elapsed()
        );
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "Hotkey waited {:?} behind controller traffic",
            started.elapsed()
        );
    }
    #[test]
    fn chords_are_device_local_edge_triggered_and_snapshots_do_not_fire() {
        let settings = json!({"manualOcrGamepad":"LB+A"});
        let mut d = Dispatcher::default();
        assert!(d
            .receive(
                &json!({"type":"gamepad_state","device":"one","buttons":{"4":true,"0":true}}),
                &settings
            )
            .is_empty());
        assert!(d
            .receive(
                &json!({"type":"button","device":"one","button":0,"pressed":true}),
                &settings
            )
            .is_empty());
        d.receive(
            &json!({"type":"button","device":"one","button":0,"pressed":false}),
            &settings,
        );
        assert!(d
            .receive(
                &json!({"type":"button","device":"two","button":0,"pressed":true}),
                &settings
            )
            .is_empty());
        assert_eq!(
            d.receive(
                &json!({"type":"button","device":"one","button":0,"pressed":true}),
                &settings
            ),
            vec!["manual_ocr"]
        );
        assert!(binding(&json!(-1)).is_empty());
    }
}
