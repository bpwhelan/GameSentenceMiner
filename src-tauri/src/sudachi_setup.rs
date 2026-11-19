//! Dictionary setup for the desktop wizard and overlay. The native input
//! service owns installation, selection, and dictionary-change broadcasts.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub async fn request(
    url: &str,
    install: bool,
    edition: Option<&str>,
    configured: Option<&str>,
) -> Result<Value, String> {
    let exchange = async {
        let (mut socket, _) = connect_async(url).await.map_err(|e| e.to_string())?;
        if let Some(dictionary) = configured {
            // The service applies the legacy profile preference only if no
            // explicit dictionary selection has been persisted.
            let configure = json!({"type":"configure_sudachi", "dictionary":dictionary});
            socket
                .send(Message::Text(configure.to_string().into()))
                .await
                .map_err(|e| e.to_string())?;
        }
        let command = if install {
            json!({"type":"prepare_sudachi", "dictionary":edition})
        } else {
            json!({"type":"sudachi_status"})
        };
        socket
            .send(Message::Text(command.to_string().into()))
            .await
            .map_err(|e| e.to_string())?;
        while let Some(frame) = socket.next().await {
            if let Message::Text(body) = frame.map_err(|e| e.to_string())? {
                let reply: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
                if reply["type"] == "sudachi_status" && (!install || reply["state"] != "installing")
                {
                    let _ = socket.close(None).await;
                    return Ok(reply);
                }
            }
        }
        Err("Input server disconnected during Sudachi setup".into())
    };
    tokio::time::timeout(Duration::from_secs(if install { 960 } else { 5 }), exchange)
        .await
        .map_err(|_| "Sudachi setup timed out".to_string())?
}

#[derive(Default)]
struct InstallState {
    running: bool,
    error: Option<String>,
}

#[derive(Default)]
pub struct SudachiSetup(Arc<Mutex<InstallState>>);

impl SudachiSetup {
    pub async fn handle(&self, app: &tauri::AppHandle, payload: &Value) -> Result<Value, String> {
        let install = match payload["action"].as_str() {
            Some("status") => false,
            Some("install") => true,
            _ => return Err("Invalid Sudachi setup action.".into()),
        };
        let edition = match payload.get("dictionary") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if matches!(s.as_str(), "small" | "core" | "full") => {
                Some(s.clone())
            }
            _ => return Err("Invalid Sudachi dictionary edition.".into()),
        };
        let installing = json!({"state":"installing"});
        if self.0.lock().unwrap().running {
            return Ok(installing);
        }
        let Some(url) = crate::input_server::url(app) else {
            return Ok(json!({"state":"error","error":"Native input service is unavailable."}));
        };
        let path = crate::desktop_services::paths_for(app)
            .active
            .join("config.json");
        let configured = tokio::task::spawn_blocking(move || {
            let doc = gsm_settings::read_object(&path)?;
            Ok::<_, String>(crate::word_index::dictionary_edition(&doc).to_owned())
        })
        .await
        .map_err(|e| e.to_string())??;
        let last_error = {
            let mut state = self.0.lock().unwrap();
            if state.running {
                return Ok(installing);
            }
            if install {
                state.running = true;
                state.error = None;
            }
            state.error.clone()
        };
        if install {
            let state = self.0.clone();
            tauri::async_runtime::spawn(async move {
                let result = request(&url, true, edition.as_deref(), Some(&configured)).await;
                let mut state = state.lock().unwrap();
                state.running = false;
                state.error = match result {
                    Ok(reply) if reply["state"] == "ready" => None,
                    Ok(reply) => Some(
                        reply["error"]
                            .as_str()
                            .unwrap_or("Dictionary setup failed. Retry setup.")
                            .into(),
                    ),
                    Err(error) => Some(error),
                };
            });
            return Ok(installing);
        }
        let mut status = request(&url, false, None, Some(&configured))
            .await
            .unwrap_or_else(|error| json!({"state":"error","error":error}));
        if let Some(error) = last_error {
            status["state"] = json!("error");
            status["error"] = json!(error);
        }
        Ok(status)
    }
}
