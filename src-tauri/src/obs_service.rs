//! OBS v5 connection ownership. No window discovery or capture-backend policy lives here.
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{hash_map::Entry, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    time::{timeout, Instant},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

mod replay;

#[derive(Clone, Debug, Serialize)]
pub struct ObsError {
    pub message: String,
    pub code: i64,
}
impl ObsError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: -1,
        }
    }
}
type ResultValue = Result<Value, ObsError>;
type Reply = oneshot::Sender<ResultValue>;
struct Pending {
    method: String,
    reply: Reply,
    deadline: Instant,
}
enum Command {
    Call {
        method: String,
        data: Value,
        reply: Reply,
        deadline: Instant,
    },
    Close,
}
#[derive(Default)]
struct Sessions {
    clients: HashMap<String, mpsc::Sender<Command>>,
    primary: Option<String>,
    replay: replay::Replay,
}
#[derive(Clone, Default)]
pub struct ObsService(Arc<Mutex<Sessions>>);
type Event = Arc<dyn Fn(&str, Value) + Send + Sync>;

impl ObsService {
    pub fn has_primary(&self) -> bool {
        self.0.lock().unwrap().primary.is_some()
    }

    pub fn primary_id(&self) -> Option<String> {
        self.0.lock().unwrap().primary.clone()
    }

    pub async fn connect(
        &self,
        id: String,
        url: String,
        password: String,
        primary: bool,
        event: Event,
    ) -> ResultValue {
        let parsed = url::Url::parse(&url).map_err(|_| ObsError::new("Invalid OBS address"))?;
        if !matches!(parsed.scheme(), "ws" | "wss")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(ObsError::new("Invalid OBS WebSocket address"));
        }
        let (sender, receiver) = mpsc::channel(128);
        {
            let mut state = self.0.lock().unwrap();
            if state.clients.len() >= 16 || state.clients.contains_key(&id) {
                return Err(ObsError::new("OBS client limit reached"));
            }
            state.clients.insert(id.clone(), sender);
        }
        let (ready, connected) = oneshot::channel();
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            run_client(
                &service, &id, &url, &password, primary, receiver, ready, event,
            )
            .await;
            let mut state = service.0.lock().unwrap();
            state.clients.remove(&id);
            if state.primary.as_ref() == Some(&id) {
                state.primary = None;
            }
        });
        connected
            .await
            .map_err(|_| ObsError::new("OBS connection stopped"))?
    }

    pub async fn call(
        &self,
        id: &str,
        method: String,
        data: Value,
        duration: Duration,
    ) -> ResultValue {
        let sender = self
            .0
            .lock()
            .unwrap()
            .clients
            .get(id)
            .cloned()
            .ok_or_else(|| ObsError::new("OBS is not connected"))?;
        let (reply, result) = oneshot::channel();
        let deadline = Instant::now() + duration;
        sender
            .try_send(Command::Call {
                method,
                data,
                reply,
                deadline,
            })
            .map_err(|_| ObsError::new("OBS request queue is unavailable"))?;
        tokio::time::timeout_at(deadline, result)
            .await
            .map_err(|_| ObsError::new("OBS request timed out"))?
            .map_err(|_| ObsError::new("OBS disconnected before replying"))?
    }

    pub async fn primary_call(&self, method: &str, data: Value) -> ResultValue {
        let id = self
            .primary_id()
            .ok_or_else(|| ObsError::new("OBS is not connected"))?;
        self.call(
            &id,
            method.into(),
            data,
            Duration::from_secs(if method == "StopRecord" { 30 } else { 8 }),
        )
        .await
    }

    pub async fn disconnect_primary(&self) -> ResultValue {
        let id = self.0.lock().unwrap().primary.clone();
        if let Some(id) = id {
            self.disconnect(&id).await
        } else {
            Ok(Value::Null)
        }
    }

    pub async fn disconnect(&self, id: &str) -> ResultValue {
        let sender = {
            let mut state = self.0.lock().unwrap();
            if state.primary.as_deref() == Some(id) {
                state.primary = None;
            }
            state.clients.remove(id)
        };
        if let Some(sender) = sender {
            let _ = sender.send(Command::Close).await;
        }
        Ok(Value::Null)
    }
}

async fn run_client(
    service: &ObsService,
    id: &str,
    url: &str,
    password: &str,
    primary: bool,
    mut commands: mpsc::Receiver<Command>,
    ready: Reply,
    event: Event,
) {
    let handshake = async {
        // OBS can send a high-resolution screenshot as one unfragmented JSON
        // frame. Keep the connection's 64 MiB message limit for both forms.
        let config = WebSocketConfig::default()
            .max_frame_size(Some(64 << 20))
            .max_message_size(Some(64 << 20));
        let (mut socket, _) = connect_async_with_config(url, Some(config), false)
            .await
            .map_err(|_| ObsError::new("Cannot connect to OBS"))?;
        let hello = read_json(&mut socket).await?;
        if hello["op"] != 0 {
            return Err(ObsError::new("OBS did not send a v5 greeting"));
        }
        let mut identify = json!({"op":1,"d":{"rpcVersion":1,"eventSubscriptions":2047}});
        if let Some(auth) = hello["d"]["authentication"].as_object() {
            let salt = auth
                .get("salt")
                .and_then(Value::as_str)
                .ok_or_else(|| ObsError::new("Invalid OBS challenge"))?;
            let challenge = auth
                .get("challenge")
                .and_then(Value::as_str)
                .ok_or_else(|| ObsError::new("Invalid OBS challenge"))?;
            identify["d"]["authentication"] =
                json!(gsm_capture::obs::authentication(password, salt, challenge));
        }
        socket
            .send(Message::Text(identify.to_string().into()))
            .await
            .map_err(|_| ObsError::new("Cannot authenticate with OBS"))?;
        let identified = read_json(&mut socket).await?;
        if identified["op"] != 2 {
            return Err(ObsError::new("OBS authentication failed"));
        }
        Ok((
            socket,
            json!({"obsWebSocketVersion":hello["d"]["obsWebSocketVersion"],"negotiatedRpcVersion":identified["d"]["negotiatedRpcVersion"]}),
        ))
    };
    let result = tokio::select! {
        result = timeout(Duration::from_secs(5), handshake) => result.unwrap_or_else(|_|Err(ObsError::new("OBS connection timed out"))),
        _ = commands.recv() => Err(ObsError::new("OBS connection cancelled")),
    };
    let (mut socket, info) = match result {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if primary {
        let mut state = service.0.lock().unwrap();
        if state.clients.contains_key(id) {
            state.primary = Some(id.into());
        }
        drop(state);
        event("ConnectionOpened", Value::Null);
    }
    if ready.send(Ok(info)).is_err() {
        return;
    }
    let mut sequence = 0u64;
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut expiry = tokio::time::interval(Duration::from_millis(100));
    // This timer is unpolled when there are no requests. Do not replay every
    // missed tick after an idle connection receives its next request.
    expiry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let failure = loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Call { method, data, reply, deadline }) => {
                    if reply.is_closed() || deadline <= Instant::now() { continue; }
                    sequence += 1;
                    let key = sequence.to_string();
                    if method == "SaveReplayBuffer" {
                        if let Err(error) = service.0.lock().unwrap().replay.begin(id, &key) {
                            let _ = reply.send(Err(error));
                            continue;
                        }
                    }
                    let message = json!({"op":6,"d":{"requestType":method,"requestId":key,"requestData":if data.is_null(){json!({})}else{data}}});
                    if !matches!(timeout(Duration::from_secs(2), socket.send(Message::Text(message.to_string().into()))).await, Ok(Ok(_))) {
                        let error = ObsError::new("OBS request could not be sent");
                        let _ = reply.send(Err(error.clone())); break error;
                    }
                    pending.insert(key, Pending { method, reply, deadline });
                }
                Some(Command::Close) | None => { let _ = timeout(Duration::from_secs(1),socket.close(None)).await; break ObsError::new("OBS disconnected"); }
            },
            message = socket.next() => {
                let mut data = match message {
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<Value>(&text) { Ok(value) => value, Err(_) => break ObsError::new("Invalid OBS response") },
                    Some(Ok(Message::Ping(_))) => { let _ = socket.flush().await; continue; }
                    Some(Ok(Message::Close(frame))) => break ObsError { code:frame.as_ref().map(|f|u16::from(f.code) as i64).unwrap_or(-1),message:frame.map(|f|f.reason.to_string()).filter(|s|!s.is_empty()).unwrap_or_else(||"OBS connection closed".into()) },
                    Some(Ok(_)) => continue,
                    _ => break ObsError::new("OBS connection closed"),
                };
                match data["op"].as_u64() {
                    Some(5) => if let Some(name) = data["d"]["eventType"].as_str() {
                        let payload = &data["d"]["eventData"];
                        if primary && matches!(name, "ReplayBufferSaved" | "ReplayBufferStateChanged") {
                            let completion = service.0.lock().unwrap().replay.event(id, name, payload);
                            if let Some((key, result)) = completion {
                                if let Some(request) = pending.remove(&key) { let _ = request.reply.send(result); }
                            }
                        }
                        event(name, payload.clone());
                    },
                    Some(7) => route_response(service, id, &mut pending, &mut data["d"]),
                    _ => {},
                }
            },
            _ = expiry.tick(), if !pending.is_empty() => {
                let now = Instant::now();
                for (_, request) in pending.extract_if(|_, request| request.reply.is_closed() || request.deadline <= now) {
                    let _ = request.reply.send(Err(ObsError::new("OBS request timed out")));
                }
            }
        }
    };
    service.0.lock().unwrap().replay.disconnected(id);
    for request in pending.into_values() {
        let _ = request.reply.send(Err(failure.clone()));
    }
    event("ConnectionClosed", json!(failure));
}

fn route_response(
    service: &ObsService,
    connection: &str,
    pending: &mut HashMap<String, Pending>,
    data: &mut Value,
) {
    let Some(Value::String(key)) = data.get_mut("requestId").map(Value::take) else {
        return;
    };
    let Some(method) = data["requestType"].as_str() else {
        return;
    };
    let replay_save = method == "SaveReplayBuffer";
    let entry = pending.entry(key);
    match &entry {
        Entry::Occupied(slot) if slot.get().method != method => return,
        // A timed-out save still owns its untagged file event. Drain its
        // matching acknowledgement even after the caller has gone away.
        Entry::Vacant(_) if !replay_save => return,
        _ => {}
    }
    let result = if data["requestStatus"]["result"] == true {
        Ok(data
            .get_mut("responseData")
            .map(Value::take)
            .unwrap_or_else(|| json!({})))
    } else {
        Err(ObsError {
            code: data["requestStatus"]["code"].as_i64().unwrap_or(-1),
            message: data["requestStatus"]["comment"]
                .as_str()
                .unwrap_or("OBS request failed")
                .into(),
        })
    };
    let result = if replay_save {
        service
            .0
            .lock()
            .unwrap()
            .replay
            .reply(connection, entry.key(), result)
    } else {
        Some(result)
    };
    if let (Entry::Occupied(slot), Some(result)) = (entry, result) {
        let _ = slot.remove().reply.send(result);
    }
}

async fn read_json(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ResultValue {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str(&text)
                    .map_err(|_| ObsError::new("Invalid OBS greeting"))
            }
            Some(Ok(Message::Ping(_))) => {
                socket
                    .flush()
                    .await
                    .map_err(|_| ObsError::new("OBS connection closed"))?;
            }
            Some(Ok(Message::Close(frame))) => {
                return Err(ObsError {
                    code: frame
                        .as_ref()
                        .map(|f| u16::from(f.code) as i64)
                        .unwrap_or(-1),
                    message: frame
                        .map(|f| f.reason.to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "OBS authentication failed".into()),
                })
            }
            Some(Ok(_)) => {}
            _ => return Err(ObsError::new("OBS handshake connection closed")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    type Server = tungstenite::WebSocket<TcpStream>;
    fn send(socket: &mut Server, value: Value) {
        socket
            .send(tungstenite::Message::Text(value.to_string().into()))
            .unwrap();
    }
    fn receive(socket: &mut Server) -> Value {
        serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap()
    }
    fn fixture(
        work: impl FnOnce(Server) + Send + 'static,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            send(
                &mut socket,
                json!({"op":0,"d":{"rpcVersion":1,"authentication":{"salt":"salt","challenge":"challenge"}}}),
            );
            let identity = receive(&mut socket);
            assert_eq!(
                identity["d"]["authentication"],
                gsm_capture::obs::authentication("password", "salt", "challenge")
            );
            assert_eq!(identity["d"]["eventSubscriptions"], 2047);
            send(&mut socket, json!({"op":2,"d":{"negotiatedRpcVersion":1}}));
            work(socket);
        });
        (url, worker)
    }
    fn reply(socket: &mut Server, request: &Value, data: Value) {
        send(
            socket,
            json!({"op":7,"d":{"requestType":request["d"]["requestType"],"requestId":request["d"]["requestId"],"requestStatus":{"result":true,"code":100},"responseData":data}}),
        );
    }
    #[test]
    fn authenticates_correlates_concurrent_requests_and_delivers_events_and_errors() {
        let (url, server) = fixture(|mut socket| {
            let first = receive(&mut socket);
            let second = receive(&mut socket);
            send(
                &mut socket,
                json!({"op":5,"d":{"eventType":"CurrentProgramSceneChanged","eventData":{"sceneName":"月姫"}}}),
            );
            reply(&mut socket, &second, second["d"]["requestData"].clone());
            reply(&mut socket, &first, first["d"]["requestData"].clone());
            let failed = receive(&mut socket);
            send(
                &mut socket,
                json!({"op":7,"d":{"requestType":failed["d"]["requestType"],"requestId":failed["d"]["requestId"],"requestStatus":{"result":false,"code":600,"comment":"No source was found"}}}),
            );
            let _ = socket.read();
        });
        tauri::async_runtime::block_on(async {
            let service = ObsService::default();
            let events = Arc::new(Mutex::new(Vec::new()));
            let recorded = events.clone();
            service
                .connect(
                    "main".into(),
                    url,
                    "password".into(),
                    true,
                    Arc::new(move |event, data| {
                        recorded.lock().unwrap().push((event.to_owned(), data))
                    }),
                )
                .await
                .unwrap();
            assert!(service.has_primary());
            let (a, b) = tokio::join!(
                service.primary_call("First", json!({"n":1})),
                service.primary_call("Second", json!({"n":2}))
            );
            assert_eq!(a.unwrap()["n"], 1);
            assert_eq!(b.unwrap()["n"], 2);
            let error = service
                .primary_call("Missing", json!({}))
                .await
                .unwrap_err();
            assert_eq!(error.code, 600);
            assert_eq!(error.message, "No source was found");
            assert!(events
                .lock()
                .unwrap()
                .iter()
                .any(|(name, data)| name == "CurrentProgramSceneChanged"
                    && data["sceneName"] == "月姫"));
            service.disconnect("main").await.unwrap();
            assert!(!service.has_primary());
        });
        server.join().unwrap();
    }
    #[test]
    fn ignores_mislabeled_unknown_and_duplicate_responses() {
        let (url, server) = fixture(|mut socket| {
            let first = receive(&mut socket);
            let second = receive(&mut socket);
            for invalid in [json!("GetRecordStatus"), Value::Null] {
                let mut wrong = first.clone();
                wrong["d"]["requestType"] = invalid;
                reply(&mut socket, &wrong, json!("wrong operation"));
            }
            let mut unknown = second.clone();
            unknown["d"]["requestId"] = json!("unknown");
            reply(&mut socket, &unknown, json!("unknown request"));
            reply(&mut socket, &second, second["d"]["requestData"].clone());
            reply(&mut socket, &second, json!("duplicate"));
            reply(&mut socket, &first, first["d"]["requestData"].clone());
            let _ = socket.read();
        });
        tauri::async_runtime::block_on(async {
            let service = ObsService::default();
            service
                .connect(
                    "main".into(),
                    url,
                    "password".into(),
                    true,
                    Arc::new(|_, _| {}),
                )
                .await
                .unwrap();
            let (a, b) = tokio::join!(
                service.primary_call("GetInputSettings", json!({"inputName":"first"})),
                service.primary_call("GetInputSettings", json!({"inputName":"second"}))
            );
            assert_eq!(a.unwrap(), json!({"inputName":"first"}));
            assert_eq!(b.unwrap(), json!({"inputName":"second"}));
            service.disconnect_primary().await.unwrap();
        });
        server.join().unwrap();
    }
    #[test]
    fn replay_save_waits_for_its_ack_and_saved_event_in_either_order() {
        let (url, server) = fixture(|mut socket| {
            let saved = |socket: &mut Server, path: &str| {
                send(
                    socket,
                    json!({"op":5,"d":{"eventType":"ReplayBufferSaved","eventData":{"savedReplayPath":path}}}),
                )
            };
            saved(&mut socket, "manual.mkv");
            // A round trip ensures the unsolicited event was consumed while idle.
            let barrier = receive(&mut socket);
            reply(&mut socket, &barrier, json!({}));
            let first = receive(&mut socket);
            assert_eq!(first["d"]["requestType"], "SaveReplayBuffer");
            saved(&mut socket, "card one.mov");
            reply(&mut socket, &first, json!({}));
            let second = receive(&mut socket);
            reply(&mut socket, &second, json!({}));
            saved(&mut socket, "clip two.mkv");
            let _ = socket.read();
        });
        tauri::async_runtime::block_on(async {
            let service = ObsService::default();
            service
                .connect(
                    "main".into(),
                    url,
                    "password".into(),
                    true,
                    Arc::new(|_, _| {}),
                )
                .await
                .unwrap();
            service
                .primary_call("GetVersion", Value::Null)
                .await
                .unwrap();
            for path in ["card one.mov", "clip two.mkv"] {
                let result = service
                    .primary_call("SaveReplayBuffer", Value::Null)
                    .await
                    .unwrap();
                assert_eq!(result["savedReplayPath"], path);
            }
            service.disconnect_primary().await.unwrap();
        });
        server.join().unwrap();
    }

    #[test]
    fn timed_out_mutations_are_not_replayed_and_late_replies_do_not_complete_other_requests() {
        let (url, server) = fixture(|mut socket| {
            let first = receive(&mut socket);
            assert_eq!(first["d"]["requestType"], "SaveReplayBuffer");
            std::thread::sleep(Duration::from_millis(120));
            reply(&mut socket, &first, json!({"stale":true}));
            let second = receive(&mut socket);
            assert_eq!(second["d"]["requestType"], "GetVersion");
            reply(&mut socket, &second, json!({"version":"test"}));
            let _ = socket.read();
        });
        tauri::async_runtime::block_on(async {
            let service = ObsService::default();
            service
                .connect(
                    "test".into(),
                    url,
                    "password".into(),
                    false,
                    Arc::new(|_, _| {}),
                )
                .await
                .unwrap();
            assert!(service
                .call(
                    "test",
                    "SaveReplayBuffer".into(),
                    json!({}),
                    Duration::from_millis(40)
                )
                .await
                .is_err());
            assert_eq!(
                service
                    .call(
                        "test",
                        "GetVersion".into(),
                        json!({}),
                        Duration::from_secs(2)
                    )
                    .await
                    .unwrap()["version"],
                "test"
            );
            service.disconnect("test").await.unwrap();
        });
        server.join().unwrap();
    }
    #[test]
    fn expired_replay_drains_its_untagged_file_before_the_next_save() {
        let (url, server) = fixture(|mut socket| {
            let first = receive(&mut socket);
            let status = receive(&mut socket);
            assert_eq!(first["d"]["requestType"], "SaveReplayBuffer");
            assert_eq!(status["d"]["requestType"], "GetRecordStatus");
            reply(&mut socket, &first, json!({}));
            reply(&mut socket, &status, json!({"outputActive": true}));
            let barrier = receive(&mut socket);
            assert_eq!(barrier["d"]["requestType"], "GetVersion");
            let saved = |socket: &mut Server, path| {
                send(
                    socket,
                    json!({"op":5,"d":{"eventType":"ReplayBufferSaved","eventData":{"savedReplayPath":path}}}),
                )
            };
            saved(&mut socket, "expired.mkv");
            reply(&mut socket, &barrier, json!({}));
            let next = receive(&mut socket);
            saved(&mut socket, "next.mkv");
            reply(&mut socket, &next, json!({}));
            let _ = socket.read();
        });
        tauri::async_runtime::block_on(async {
            let service = ObsService::default();
            service
                .connect(
                    "main".into(),
                    url,
                    "password".into(),
                    true,
                    Arc::new(|_, _| {}),
                )
                .await
                .unwrap();
            let error = service
                .call(
                    "main",
                    "SaveReplayBuffer".into(),
                    Value::Null,
                    Duration::from_millis(80),
                )
                .await
                .unwrap_err();
            assert!(error.message.contains("timed out"));
            // Let the actor remove the expired caller before OBS acknowledges it.
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert_eq!(
                service
                    .primary_call("GetRecordStatus", Value::Null)
                    .await
                    .unwrap()["outputActive"],
                true
            );
            assert!(service
                .primary_call("SaveReplayBuffer", Value::Null)
                .await
                .unwrap_err()
                .message
                .contains("previous OBS replay"));
            service
                .primary_call("GetVersion", Value::Null)
                .await
                .unwrap();
            let next = service
                .primary_call("SaveReplayBuffer", Value::Null)
                .await
                .unwrap();
            assert_eq!(next["savedReplayPath"], "next.mkv");
            service.disconnect_primary().await.unwrap();
        });
        server.join().unwrap();
    }
    #[test]
    fn connection_loss_rejects_outstanding_requests() {
        let (url, server) = fixture(|mut socket| {
            let _ = receive(&mut socket);
        });
        tauri::async_runtime::block_on(async {
            let service = ObsService::default();
            service
                .connect(
                    "lost".into(),
                    url,
                    "password".into(),
                    true,
                    Arc::new(|_, _| {}),
                )
                .await
                .unwrap();
            assert!(service.primary_call("GetVersion", json!({})).await.is_err());
        });
        server.join().unwrap();
    }
    #[test]
    fn disconnect_cancels_an_incomplete_handshake() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        tauri::async_runtime::block_on(async {
            let service = ObsService::default();
            let connecting =
                service.connect("cancel".into(), url, "".into(), true, Arc::new(|_, _| {}));
            let cancel = async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                service.disconnect("cancel").await.unwrap();
            };
            let (result, _) = tokio::join!(connecting, cancel);
            assert!(result.unwrap_err().message.contains("cancelled"));
            assert!(!service.has_primary());
        });
    }
}
