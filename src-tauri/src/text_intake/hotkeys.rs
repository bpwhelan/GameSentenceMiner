use super::{Intake, Pause};
use crate::{
    obs::{game_pause::GamePause, Obs},
    ocr::{inputs::Dispatcher, keyboard::Keyboard},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

const KEYS: &[(&str, &str)] = &[
    ("play_latest_audio", "replay"),
    ("manual_overlay_scan", "scan"),
    ("copy_game_screenshot", "screenshot"),
    ("pause_text_intake", "intake"),
    ("process_pause", "pause"),
    ("mute_target_window", "mute"),
];
const PAD: &[(&str, &str)] = &[
    ("play_latest_audio_gamepad", "replay"),
    ("manual_overlay_scan_gamepad", "scan"),
    ("copy_game_screenshot_gamepad", "screenshot"),
    ("pause_text_intake_gamepad", "intake"),
    ("process_pause_gamepad", "pause"),
    ("mute_target_window_gamepad", "mute"),
];

#[derive(Default)]
pub(crate) struct Hotkeys {
    settings: watch::Sender<Value>,
    screenshot: tokio::sync::Mutex<()>,
}
impl Hotkeys {
    pub(crate) fn configure(&self, next: &Value) {
        self.settings.send_if_modified(|old| {
            if old == next {
                false
            } else {
                *old = next.clone();
                true
            }
        });
    }
    #[cfg(windows)]
    pub(crate) fn unmute_on_focus(&self) -> bool {
        self.settings.borrow()["unmute_target_window_on_focus"] != false
    }
}

async fn dispatch(app: &AppHandle, action: &str) -> Result<(), String> {
    let intake = app.state::<Intake>();
    match action {
        "intake" => {intake.control_pause(app,Pause::Toggle)?;}
        "replay" => {
            let id = {
                let s=intake.state.lock().unwrap();
                let last = s.reader.active().next_back();
                last.map(|i|s.reader.row(i).id.clone())
            }.ok_or("No captured line to replay")?;
            let (status,reply)=crate::mining::reader_audio::queue(app,&json!({"id":id,"trim_with_vad":false,"playback_mode":"native"}));
            if !status.is_success(){return Err(reply["error"].as_str().unwrap_or("Audio replay failed").into());}
        }
        "scan" => intake.overlay_event(json!({"type":"native-overlay-command","action":"scan","manual":true,"source":"hotkey"})),
        "pause" => app.state::<GamePause>().request(app,"process_pause_hotkey","toggle")?,
        "screenshot" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let keys=app.state::<Hotkeys>();
            let Ok(_guard)=keys.screenshot.try_lock() else {return Ok(())};
            let bytes=app.state::<Obs>().clipboard_screenshot(app).await?;
            let app=app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let frame=tauri::image::Image::from_bytes(&bytes).map_err(|e|e.to_string())?;
                app.clipboard().write_image(&frame).map_err(|e|e.to_string())
            }).await.map_err(|e|e.to_string())??;
        }
        #[cfg(windows)]
        "mute" => crate::obs::game_audio::toggle(app)?,
        _=>{}
    }
    Ok(())
}

pub(crate) fn start(app: &AppHandle) {
    let mut changes = app.state::<Hotkeys>().settings.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let settings = changes.borrow_and_update().clone();
            let mut keyboard = Keyboard::with_actions(&settings, KEYS);
            let keys = keyboard.keys();
            let pad = PAD.iter().any(|(k, _)| {
                settings[*k].as_str().is_some_and(|v| !v.trim().is_empty())
                    || settings[*k].as_u64().is_some()
            });
            if !keys.is_empty() || pad {
                if let Some(endpoint) = crate::input_server::url(&app) {
                    if let Ok((mut socket, _)) = tokio_tungstenite::connect_async(endpoint).await {
                        let mut dispatcher = Dispatcher::default();
                        let requests = [
                            json!({"type":"configure_features","features":if keys.is_empty() {vec![]} else {vec!["keyboard"]}}),
                            json!({"type":"configure_keyboard_subscription","keys":keys}),
                            json!({"type":"get_state"}),
                        ];
                        let mut ready = true;
                        for request in requests {
                            if socket
                                .send(Message::text(request.to_string()))
                                .await
                                .is_err()
                            {
                                ready = false;
                                break;
                            }
                        }
                        while ready {
                            let frame = tokio::select! {
                                _=changes.changed()=>break,
                                frame=socket.next()=>frame,
                            };
                            let Some(Ok(frame)) = frame else { break };
                            match frame {
                                Message::Text(raw) => {
                                    let Ok(event) = serde_json::from_str::<Value>(&raw) else {
                                        continue;
                                    };
                                    let actions = if event["type"] == "keyboard_event" {
                                        keyboard.receive(&event, true)
                                    } else if pad {
                                        dispatcher.receive_with(&event, &settings, PAD)
                                    } else {
                                        continue;
                                    };
                                    for action in actions {
                                        let handle = app.clone();
                                        tauri::async_runtime::spawn(async move {
                                            if let Err(e) = dispatch(&handle, action).await {
                                                crate::desktop_log::warn(&handle, "hotkey", e);
                                            }
                                        });
                                    }
                                }
                                Message::Ping(_) => {
                                    if socket.flush().await.is_err() {
                                        break;
                                    }
                                }
                                Message::Close(_) => break,
                                _ => {}
                            }
                        }
                        if *changes.borrow() != settings {
                            continue;
                        }
                    }
                }
                tokio::select! {
                    _=tokio::time::sleep(std::time::Duration::from_secs(2))=>{},
                    changed=changes.changed()=>if changed.is_err(){return;}
                }
            } else if changes.changed().await.is_err() {
                return;
            }
        }
    });
}
