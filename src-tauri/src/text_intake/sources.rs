use super::{submit, Intake};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Error, Message},
};
use url::Url;

static SOURCE_ID: AtomicU64 = AtomicU64::new(1);
type Task = tauri::async_runtime::JoinHandle<()>;
pub enum Origin {
    Backend(u64),
    Clipboard(u64),
    Socket(String, u64),
}
struct Listener {
    id: u64,
    label: String,
    connected: Option<String>,
    task: Task,
}
impl Drop for Listener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub(super) struct Sources {
    sockets: HashMap<String, Listener>,
    clipboard: Option<(u64, Task)>,
    both: bool,
    inhouse: bool,
    epoch: u64,
    resume: std::sync::Arc<tokio::sync::Notify>,
}
impl Drop for Sources {
    fn drop(&mut self) {
        if let Some((_, task)) = self.clipboard.take() {
            task.abort();
        }
    }
}
impl Sources {
    pub(super) fn accepts(&self, origin: &Origin, epoch: u64) -> bool {
        match origin {
            Origin::Backend(e) => *e == epoch,
            Origin::Socket(url, id) => self.sockets.get(url).is_some_and(|s| s.id == *id),
            Origin::Clipboard(id) => {
                self.clipboard.as_ref().is_some_and(|(key, _)| key == id)
                    && self.clipboard_enabled()
            }
        }
    }
    fn clipboard_enabled(&self) -> bool {
        self.clipboard.is_some()
            && (self.both
                || (!self.inhouse && self.sockets.values().all(|s| s.connected.is_none())))
    }
    pub(super) fn clipboard_state(&self) -> &'static str {
        if self.clipboard.is_none() {
            "disabled"
        } else if self.clipboard_enabled() {
            "listening"
        } else {
            "paused"
        }
    }
    pub(super) fn set_inhouse(&mut self, active: bool) {
        let blocked = !self.clipboard_enabled();
        self.inhouse = active;
        if blocked && self.clipboard_enabled() {
            self.resume.notify_one();
        }
    }
    pub(super) fn status(&self) -> Value {
        let connected: HashMap<_, _> = self
            .sockets
            .values()
            .filter_map(|s| s.connected.as_ref().map(|u| (u, &s.label)))
            .collect();
        json!({"clipboard":self.clipboard_enabled(),"websockets":connected})
    }
    pub(super) fn configure(&mut self, app: &AppHandle, epoch: u64, config: &Value) {
        if epoch != self.epoch {
            *self = Self::default();
            self.epoch = epoch;
        }
        let blocked = !self.clipboard_enabled();
        self.both = config["both"] == true;
        let desired: HashMap<String, String> = config["websockets"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(uri, name)| {
                let raw = uri.trim();
                let url = Url::parse(
                    if raw.contains("://") {
                        raw.to_owned()
                    } else {
                        format!("ws://{raw}")
                    }
                    .as_str(),
                )
                .ok()?;
                if !matches!(url.scheme(), "ws" | "wss")
                    || config["output_ports"].as_array().is_some_and(|ports| {
                        ports
                            .iter()
                            .any(|p| p.as_u64() == url.port_or_known_default().map(u64::from))
                    })
                {
                    return None;
                }
                Some((url.into(), name.as_str().unwrap_or(raw).to_owned()))
            })
            .collect();
        self.sockets
            .retain(|url, s| desired.get(url) == Some(&s.label));
        for (url, label) in desired {
            self.sockets.entry(url.clone()).or_insert_with(|| {
                let id = SOURCE_ID.fetch_add(1, Ordering::Relaxed);
                let task = tauri::async_runtime::spawn(listen(app.clone(), url, label.clone(), id));
                Listener {
                    id,
                    label,
                    connected: None,
                    task,
                }
            });
        }
        if config["clipboard"] == true && self.clipboard.is_none() {
            let id = SOURCE_ID.fetch_add(1, Ordering::Relaxed);
            self.clipboard = Some((
                id,
                tauri::async_runtime::spawn(clipboard(app.clone(), id, self.resume.clone())),
            ));
        } else if config["clipboard"] != true {
            if let Some((_, task)) = self.clipboard.take() {
                task.abort();
            }
        }
        if blocked && self.clipboard_enabled() {
            self.resume.notify_one();
        }
    }
}

fn connection(app: &AppHandle, key: &str, id: u64, url: Option<&str>) {
    let intake = app.state::<Intake>();
    let mut state = intake.state.lock().unwrap();
    let blocked = !state.sources.clipboard_enabled();
    if let Some(s) = state.sources.sockets.get_mut(key).filter(|s| s.id == id) {
        s.connected = url.map(str::to_owned);
        if blocked && state.sources.clipboard_enabled() {
            state.sources.resume.notify_one();
        }
        intake.wake.notify_one();
    }
}

fn message_payload(text: &str, label: &str) -> Value {
    // Only these public envelope fields can affect intake. Internal hook options and
    // lifecycle controls never come from a third-party websocket.
    let obj = text
        .trim_start()
        .starts_with('{')
        .then(|| serde_json::from_str::<Value>(text).ok())
        .flatten();
    let msg = obj.as_ref().unwrap_or(&Value::Null);
    let mut payload = json!({"text":msg["sentence"].as_str().unwrap_or(text),"sourceDisplayName":label,
        "source":msg["source"].as_str().filter(|s|!s.is_empty()).unwrap_or("external"),"observationId":uuid::Uuid::new_v4().to_string()});
    for field in ["time", "dict_from_ocr"] {
        if let Some(v) = msg.get(field) {
            payload[field] = v.clone();
        }
    }
    payload
}

async fn deliver(app: &AppHandle, payload: Value, origin: impl Fn() -> Origin) {
    loop {
        match submit(app, payload.clone(), Some(origin())).await {
            Ok(ack) if ack["status"] == "backpressured" => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Ok(_) => return,
            Err(e) => {
                crate::desktop_log::error(app, "text", e);
                return;
            }
        }
    }
}

async fn listen(app: AppHandle, key: String, label: String, id: u64) {
    let mut url = key.clone();
    let mut delay = Duration::from_secs(2);
    loop {
        let config = WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        match connect_async_with_config(&url, Some(config), true).await {
            Ok((mut socket, _)) => {
                connection(&app, &key, id, Some(&url));
                delay = Duration::from_secs(2);
                while let Some(Ok(message)) = socket.next().await {
                    let payload = match message {
                        Message::Text(s) => message_payload(&s, &label),
                        Message::Binary(s) => match std::str::from_utf8(&s) {
                            Ok(s) => message_payload(s, &label),
                            Err(_) => continue,
                        },
                        Message::Ping(_) => {
                            if socket.flush().await.is_err() {
                                break;
                            }
                            continue;
                        }
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    deliver(&app, payload, || Origin::Socket(key.clone(), id)).await;
                }
                connection(&app, &key, id, None);
            }
            Err(Error::Http(response)) if response.status() == 404 && url == key => {
                if let Ok(mut alternate) = Url::parse(&key) {
                    if alternate.path() == "/" {
                        alternate.set_path("/api/ws/text/origin");
                        url = alternate.into();
                        continue;
                    }
                }
            }
            Err(_) => {}
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(5));
    }
}

async fn read_clipboard() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| arboard::Clipboard::new().ok()?.get_text().ok())
        .await
        .ok()
        .flatten()
}

async fn clipboard(app: AppHandle, id: u64, resume: std::sync::Arc<tokio::sync::Notify>) {
    #[cfg(windows)]
    let mut listener = super::clipboard_windows::Listener::start().await;
    let mut previous = read_clipboard().await;
    loop {
        #[cfg(windows)]
        if let Some(watch) = listener.as_mut() {
            tokio::select! {
                changed=watch.changed()=>{if changed.is_err(){listener=None;}},
                _=resume.notified()=>{}
            }
        } else {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        #[cfg(not(windows))]
        tokio::select! {_=tokio::time::sleep(Duration::from_millis(200))=>{},_=resume.notified()=>{}}
        if !app
            .state::<Intake>()
            .state
            .lock()
            .unwrap()
            .sources
            .clipboard_enabled()
        {
            continue;
        }
        let mut read = read_clipboard().await;
        // Some clipboard owners announce before releasing their write lock.
        if read.is_none() {
            tokio::time::sleep(Duration::from_millis(30)).await;
            read = read_clipboard().await;
        }
        if let Some(text) = read.filter(|s| !s.is_empty() && previous.as_ref() != Some(s)) {
            let payload = json!({"source":"clipboard","sourceDisplayName":"Clipboard","text":text,"observationId":uuid::Uuid::new_v4().to_string()});
            previous = Some(text);
            deliver(&app, payload, || Origin::Clipboard(id)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_resumes_only_after_both_desktop_sources_stop() {
        use super::super::{Activity, Producer};
        let mut activity = Activity::default();
        let mut sources = Sources::default();
        sources.clipboard = Some((1, tauri::async_runtime::spawn(std::future::pending())));
        for (source, active, clipboard) in [
            (Producer::Ocr, true, "paused"),
            (Producer::Texthook, true, "paused"),
            (Producer::Ocr, false, "paused"),
            (Producer::Texthook, false, "listening"),
        ] {
            assert!(activity.set(source, active));
            assert!(!activity.set(source, active));
            sources.set_inhouse(activity.any());
            assert_eq!(sources.clipboard_state(), clipboard);
            assert_eq!(
                sources.accepts(&Origin::Clipboard(1), 0),
                clipboard == "listening"
            );
        }
        sources.both = true;
        sources.set_inhouse(true);
        assert_eq!(sources.clipboard_state(), "listening");
    }

    #[test]
    fn websocket_envelope_preserves_public_metadata_only() {
        let payload = message_payload(
            r#"{"sentence":"字幕","time":"2026-01-01T01:02:03Z","source":"ocr","dict_from_ocr":{"x":2},"_nativeHook":true}"#,
            "External",
        );
        assert_eq!(payload["text"], "字幕");
        assert_eq!(payload["dict_from_ocr"]["x"], 2);
        assert!(payload.get("_nativeHook").is_none());
        assert_eq!(message_payload("123", "External")["text"], "123");
    }
}
