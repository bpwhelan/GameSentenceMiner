//! The socket subscribes under the same lock that chooses its snapshot. Subsequent frames
//! start at that exact boundary. A lagging socket reconnects and takes a new snapshot.
use super::{Intake, Session};
use futures_util::{future::BoxFuture, SinkExt, StreamExt};
use gsm_intake::{reader::wire_record, Event};
use gsm_mining::gateway::{Channel, ReaderEndpoint, ReaderSocket, StatusCode};
use serde_json::{json, Value};
use std::collections::VecDeque;
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;
use tungstenite::{Message, Utf8Bytes};

pub struct Endpoint(pub AppHandle);
pub(super) struct Feed {
    pub clip_changes: tokio::sync::watch::Sender<()>,
    legacy: broadcast::Sender<Utf8Bytes>,
    modern: broadcast::Sender<Utf8Bytes>,
    plain: broadcast::Sender<Utf8Bytes>,
    pub overlay: broadcast::Sender<Utf8Bytes>,
    goals_dirty: bool,
    goals_running: bool,
    goals_last: Option<std::time::Instant>,
    backlog: VecDeque<Utf8Bytes>,
}
impl Default for Feed {
    fn default() -> Self {
        Self {
            clip_changes: tokio::sync::watch::channel(()).0,
            legacy: broadcast::channel(256).0,
            modern: broadcast::channel(256).0,
            plain: broadcast::channel(256).0,
            overlay: broadcast::channel(128).0,
            goals_dirty: false,
            goals_running: false,
            goals_last: None,
            backlog: VecDeque::new(),
        }
    }
}
impl Feed {
    pub(super) fn request_goals(&mut self, force: bool) {
        if self.overlay.receiver_count() > 0 {
            self.goals_dirty = true;
            if force {
                self.goals_last = None;
            }
        }
    }

    pub(super) fn refresh_goals_if_due(&mut self, app: &AppHandle) {
        if !self.goals_dirty || self.goals_running || self.overlay.receiver_count() == 0
            || self.goals_last.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(30)) {
            return;
        }
        self.goals_dirty = false;
        self.goals_running = true;
        self.goals_last = Some(std::time::Instant::now());
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let snapshot = goals_snapshot(&handle);
            let intake = handle.state::<Intake>();
            let mut session = intake.state.lock().unwrap();
            session.feed.goals_running = false;
            if let Some(frame) = snapshot {
                let _ = session.feed.overlay.send(frame);
            }
        });
    }

    pub fn control(&self, value: &Value) {
        if self.legacy.receiver_count() + self.modern.receiver_count() != 0 {
            let frame: Utf8Bytes = value.to_string().into();
            let _ = self.legacy.send(frame.clone());
            let _ = self.modern.send(frame);
        }
    }
}
impl Session {
    pub(super) fn publish_reader(&mut self, event: &Event) {
        if self.reader.observe(event) {
            self.feed.control(&json!({"event":"reset_checkboxes"}));
        }
        let (kind, r) = match event {
            Event::Append(r) => ("append", r),
            Event::Update(r) => ("update", r),
            Event::Freeze(r) => ("freeze", r),
            Event::StatsReady(r) | Event::StatsExcluded(r) => ("update", r),
            Event::Expire(r) => ("expire", r),
            _ => return,
        };
        if self.feed.modern.receiver_count() > 0 {
            let _ = self.feed.modern.send(
                json!({"event":format!("text_v2_{kind}"),"data":wire_record(r)})
                    .to_string()
                    .into(),
            );
        }
        if matches!(
            event,
            Event::Append(_) | Event::Update(_) | Event::Freeze(_)
        ) {
            if self.feed.clip_changes.receiver_count() > 0 {
                self.feed.clip_changes.send_replace(());
            }
            if self.feed.legacy.receiver_count() > 0 {
                let i = self
                    .reader
                    .get(&r.line_id)
                    .expect("reader observed this revision");
                let frame = json!({"event":"text_received","sentence":r.text,"data":self.reader.row(i).legacy(self.reader.checked(i))});
                let _ = self.feed.legacy.send(frame.to_string().into());
            }
            let plain: Utf8Bytes = r.text.to_string().into();
            if let Err(broadcast::error::SendError(frame)) = self.feed.plain.send(plain) {
                if self.feed.backlog.len() == 100 {
                    self.feed.backlog.pop_front();
                }
                self.feed.backlog.push_back(frame);
            }
        }
    }
}
impl ReaderEndpoint for Endpoint {
    fn native_only(&self) -> bool {
        crate::app_lifecycle::native_session_requested()
    }
    fn goals_changed(&self) {
        self.0.state::<Intake>().state.lock().unwrap().feed.request_goals(true);
    }
    fn update_metadata(&self, action: gsm_mining::gateway::MetadataAction, body: Value)
        -> BoxFuture<'_, (StatusCode, Value)> {
        Box::pin(crate::game_metadata::link(&self.0, action, body))
    }
    fn search_media(&self,search:gsm_mining::gateway::MediaSearch)->BoxFuture<'_,(StatusCode,Vec<u8>)>{
        Box::pin(crate::game_metadata::search(&self.0,search))
    }
    fn area_selector(&self, request: gsm_mining::gateway::AreaRequest) -> BoxFuture<'_, gsm_mining::gateway::AreaResponse> {
        Box::pin(crate::ocr_coordinator::area_selector::request(&self.0, request))
    }
    fn prepare_archive_lines(
        &self,
        ids: Vec<String>,
        generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.0
                .state::<crate::word_index::WordIndex>()
                .prepare_archive_lines(ids, generation)
                .await
        })
    }
    fn library_changed(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {
            let _ = crate::runtime::backend_command(&self.0, "game_library_changed", Value::Null).await;
        })
    }
    fn stats_settings_changed(&self,reschedule:bool) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.goals_changed();
            if reschedule {
                crate::cron::refresh(&self.0);
            }
            let _ = crate::runtime::backend_command(&self.0,"stats_settings_changed",Value::Null).await;
        })
    }
    fn lines_removed(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {
            if let Err(error) = self.0.state::<crate::cron::Scheduler>().force_rollup() {
                crate::desktop_log::warn(&self.0,"database",error);
            }
            self.reading_stats_changed().await;
        })
    }
    fn reading_stats_changed(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {
            self.goals_changed();
            let _ = crate::runtime::backend_command(&self.0, "reading_stats_changed", Value::Null).await;
        })
    }
    fn lines_rewritten(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {
            if let Err(error) = self.0.state::<crate::cron::Scheduler>().force_tokenization() {
                crate::desktop_log::warn(&self.0, "database", error);
            }
            self.lines_removed().await;
        })
    }
    fn queue_game_metadata(&self) -> bool {
        self.0.state::<crate::cron::Scheduler>().force_metadata().is_ok()
    }
    fn imported_lines(&self, dictionary: &'static str, ids: Vec<String>, generation:u64) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            if !ids.is_empty() {
                self.0.state::<crate::word_index::WordIndex>().enqueue_at(dictionary,ids,Some(generation));
            }
            let queued = self.0.state::<crate::cron::Scheduler>().force_rollup();
            if let Err(error) = &queued {
                crate::desktop_log::warn(&self.0, "database", error);
            }
            self.library_changed().await;
            self.reading_stats_changed().await;
            queued.is_ok()
        })
    }
    fn audio_asset(&self, token: &str) -> Option<std::sync::Arc<tempfile::TempPath>> {
        crate::mining::reader_audio::asset(&self.0, token)
    }
    fn ai(&self, action: gsm_mining::gateway::AiAction, input: Value) -> BoxFuture<'_, (StatusCode, Value)> {
        Box::pin(crate::mining::reader_ai::request(&self.0, action, input))
    }
    fn onboarding(&self, request: gsm_mining::gateway::Setup) -> BoxFuture<'_, (StatusCode, Value)> {
        Box::pin(crate::desktop_services::onboarding_http(&self.0, request))
    }
    fn connect(
        &self,
        channel: Channel,
        socket: ReaderSocket,
        upstream: tokio::sync::watch::Receiver<Option<String>>,
    ) -> BoxFuture<'static, ()> {
        let app = self.0.clone();
        Box::pin(async move {
            if channel == Channel::Overlay {
                let _ = overlay_socket(&app, socket, upstream).await;
            } else {
                let _ = serve(&app, channel == Channel::Plain, socket, upstream).await;
            }
        })
    }
    fn query(&self, path: &str, body: Value) -> (StatusCode, Value) {
        if path.starts_with("/linux/") {
            return match crate::obs::game_pause::linux_request(&self.0,path,&body) {
                Ok(value) => (StatusCode::OK,value),
                Err(error) => (StatusCode::INTERNAL_SERVER_ERROR,json!({"success":false,"error":error})),
            };
        }
        if path == "/get_status" {
            return (StatusCode::OK, crate::live_status::snapshot(&self.0));
        }
        if path == "/set_text_intake_paused" {
            let Some(paused) = body["paused"].as_bool() else { return bad("'paused' must be a boolean"); };
            return match self.0.state::<Intake>().control_pause(&self.0, super::Pause::Set(paused)) {
                Ok(value) => (StatusCode::OK, json!({"paused":value})),
                Err(error) => (StatusCode::SERVICE_UNAVAILABLE, json!({"error":error})),
            };
        }
        if path == "/set_stats_gathering_enabled" {
            let Some(enabled) = body["enabled"].as_bool() else { return bad("'enabled' must be a boolean"); };
            self.0.state::<Intake>().state.lock().unwrap().projection.collect = enabled;
            return (StatusCode::OK, json!({"enabled":enabled}));
        }
        if matches!(path, "/api/ocr/meiki-model" | "/api/ocr/vita-model") {
            let base = &self.0.state::<crate::settings::Settings>().paths.active;
            let reply = if path == "/api/ocr/meiki-model" {crate::ocr_coordinator::meiki::request(base, &body)}
                else {crate::ocr_coordinator::vocr::request(base, &body)};
            return (StatusCode::OK, reply);
        }
        if path == "/api/anki_sync_now" {
            return match self.0.state::<crate::cron::Scheduler>().force_anki() {
                Ok(()) => (StatusCode::ACCEPTED, json!({"status":"queued", "message":"Anki sync has been queued.",
                    "queued_at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros,false)})),
                Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, json!({"status":"error","error":error})),
            };
        }
        if path == "/create-media" {
            return crate::mining::media_folder::queue(&self.0,&body);
        }
        if path == "/play-audio" {
            return crate::mining::reader_audio::queue(&self.0, &body);
        }
        if matches!(path,"/trim-video"|"/get-screenshot") {
            return crate::mining::reader_media::queue(&self.0,path,&body);
        }
        if matches!(path, "/api/clips" | "/api/clips/open" | "/api/clips/trash" | "/save-clip") {
            return crate::mining::clip_library::request(&self.0, path, &body);
        }
        let intake = self.0.state::<Intake>();
        let mut s = intake.state.lock().unwrap();
        match path {
            "/get_ids" => (
                StatusCode::OK,
                s.reader.state(s.stream.session_id(), s.policy.paused),
            ),
            "/data" => {
                let rows: Vec<_> = s
                    .reader
                    .rows()
                    .map(|(i, r)| (r.clone(), s.reader.checked(i)))
                    .collect();
                drop(s);
                (
                    StatusCode::OK,
                    Value::Array(
                        rows.iter()
                            .map(|(r, selected)| {
                                let mut row = r.legacy(*selected);
                                // Flask historically serializes this local, naive datetime as an HTTP date.
                                row["time"] = json!(r
                                    .captured
                                    .with_timezone(&chrono::Local)
                                    .format("%a, %d %b %Y %H:%M:%S GMT")
                                    .to_string());
                                row
                            })
                            .collect(),
                    ),
                )
            }
            "/update_checkbox" | "/update_checkboxes" => {
                let single = path == "/update_checkbox";
                let mut updates = Vec::new();
                if single {
                    let Some(id) = body["id"].as_str() else {
                        return bad("Missing id");
                    };
                    let Some(i) = s.reader.get(id) else {
                        return (StatusCode::NOT_FOUND, json!({"error":"Invalid id"}));
                    };
                    let checked = match body.get("checked") {
                        Some(Value::Bool(b)) => *b,
                        None => !s.reader.checked(i),
                        _ => return bad("'checked' must be a boolean"),
                    };
                    updates.push((id, checked));
                } else {
                    let Some(items) = body["updates"].as_array().filter(|v| v.len() <= 10_000)
                    else {
                        return bad("Provide a list of selection updates");
                    };
                    let mut positions = std::collections::HashMap::new();
                    for item in items {
                        let (Some(id), Some(checked)) = (
                            item["id"].as_str().filter(|id| !id.is_empty()),
                            item["checked"].as_bool(),
                        ) else {
                            return bad("Each update needs a line id and boolean checked state");
                        };
                        let slot = *positions.entry(id).or_insert_with(|| {
                            updates.push((id, checked));
                            updates.len() - 1
                        });
                        updates[slot].1 = checked;
                    }
                }
                let mut updated = Vec::new();
                let mut events = vec![];
                for (id, checked) in updates {
                    if s.reader.select(id, checked) {
                        updated.push(id);
                        if checked {
                            s.stream.freeze(id, intake.now(), &mut events);
                        }
                    }
                }
                s.publish(&self.0, events, None);
                intake.wake.notify_one();
                let selected = s.reader.selected_ids();
                (
                    StatusCode::OK,
                    if single {
                        json!({"message":"Event updated successfully","selected_ids":selected})
                    } else {
                        json!({"selected_ids":selected,"updated_ids":updated})
                    },
                )
            }
            _ => (StatusCode::NOT_FOUND, Value::Null),
        }
    }
}
fn bad(error: &str) -> (StatusCode, Value) {
    (StatusCode::BAD_REQUEST, json!({"error":error}))
}

/// The public socket handles overlay translations and stats directly. Other commands
/// reach the backend through its registered internal address.
type BackendSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Target = tokio::sync::watch::Receiver<Option<String>>;

impl Intake {
    pub(crate) fn overlay_event(&self, event: Value) {
        let frame = event.to_string().into();
        let _ = self.state.lock().unwrap().feed.overlay.send(frame);
    }
}

async fn local_overlay_request(app: &AppHandle, frame: &Utf8Bytes) -> bool {
    #[derive(serde::Deserialize)]
    struct Header<'a> {
        #[serde(rename = "type", borrow)]
        kind: std::borrow::Cow<'a, str>,
    }
    // Other commands can contain large OCR results. Skip their payloads without
    // constructing a JSON tree before forwarding the original frame upstream.
    let Ok(header) = serde_json::from_str::<Header>(frame) else { return false };
    if !matches!(header.kind.as_ref(), "translate-request" | "quick-action-request") {
        if !crate::app_lifecycle::native_session_requested() { return false; }
        return super::overlay_control::request(app, header.kind.as_ref(), frame.as_str()).await;
    }
    let Ok(request) = serde_json::from_str(frame) else { return false };
    if header.kind == "translate-request" {
        crate::mining::overlay_ai::submit(app, request);
    } else {
        let app = app.clone();
        if tauri::async_runtime::spawn_blocking(move || quick_action(&app, &request)).await.is_err() { return false; }
    }
    true
}

fn quick_action(app: &AppHandle, request: &Value) {
    let intake = app.state::<Intake>();
    let result = (|| {
        let action = request["action"].as_str().unwrap_or("");
        if action == "toggle-intake" { intake.control_pause(app, super::Pause::Toggle)?; }
        let (id, paused) = {
            let s = intake.state.lock().unwrap();
            let last = s.reader.active().next_back().map(|i| s.reader.row(i).id.clone());
            (last, s.policy.paused)
        };
        match action {
            "state" | "toggle-intake" => {}
            "replay-audio" => {
                let id = id.as_deref().ok_or("No captured line available to replay yet.")?;
                let (code, reply) = crate::mining::reader_audio::queue(app, &json!({"id":id,"trim_with_vad":false,"playback_mode":"native"}));
                if !code.is_success() { return Err(reply["error"].as_str().unwrap_or("Audio playback failed").to_owned()); }
            }
            _ => return Err("Unknown quick action".into()),
        }
        Ok(json!({"success":true,"paused":paused,"canReplay":id.is_some()}))
    })();
    let mut response = result.unwrap_or_else(|error| json!({"success":false,"error":error}));
    response["type"] = json!("quick-action-result");
    response["request_id"] = request["request_id"].clone();
    intake.overlay_event(response);
}

// Reader input is the legacy backend command queue. It never feeds captured dialogue.
async fn relay_input(base: Option<String>, frame: Utf8Bytes) -> bool {
    let Some(base) = base else { return false };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let (mut upstream, _) = tokio_tungstenite::connect_async(format!("{base}/ws/texthooker"))
            .await
            .ok()?;
        upstream.send(Message::Text(frame)).await.ok()?;
        while let Some(Ok(msg)) = upstream.next().await {
            if let Message::Text(ack) = msg {
                if ack == "True" || ack == "False" {
                    return Some(ack == "True");
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
    .unwrap_or(false)
}

async fn attach(target: &mut Target) -> Option<BackendSocket> {
    loop {
        let base = target.borrow_and_update().clone();
        if let Some(base) = base {
            tokio::select! {
                result=tokio_tungstenite::connect_async(format!("{base}/ws/overlay"))=>{
                    if let Ok((socket,_))=result{return Some(socket);}
                }
                changed=target.changed()=>{changed.ok()?; continue;}
            }
            tokio::select! {
                _=tokio::time::sleep(std::time::Duration::from_secs(1))=>{},
                changed=target.changed()=>{changed.ok()?;}
            }
        } else {
            target.changed().await.ok()?;
        }
    }
}

fn goals_snapshot(app: &AppHandle) -> Option<Utf8Bytes> {
    let reports = gsm_mining::gateway::Reports::new(
        &app.state::<crate::settings::Settings>().paths.active,
        app.state::<std::sync::Arc<gsm_history::History>>().inner().clone(),
    );
    match reports.live_goals() {
        Ok(snapshot) => snapshot.map(|v| v.to_string().into()),
        Err(error) => {
            crate::desktop_log::warn(app, "goals", error.to_string());
            None
        }
    }
}

async fn overlay_socket(
    app: &AppHandle,
    mut socket: ReaderSocket,
    mut target: Target,
) -> Result<(), tungstenite::Error> {
    let intake = app.state::<Intake>();
    let (mut rx, initial) = {
        let mut s = intake.state.lock().unwrap();
        let paused = s.policy.paused;
        (
            s.feed.overlay.subscribe(),
            s.projection.payload("connect", paused),
        )
    };
    write_client(&mut socket, Message::text(initial.to_string())).await?;
    if crate::app_lifecycle::native_session_requested() {
        let handle = app.clone();
        if let Ok(Some(frame)) = tauri::async_runtime::spawn_blocking(move || goals_snapshot(&handle)).await {
            write_client(&mut socket, Message::Text(frame)).await?;
        }
    }
    loop {
        let upstream = {
            let joining = attach(&mut target);
            tokio::pin!(joining);
            loop {
                tokio::select! {
                    stream=&mut joining=>break stream,
                    frame=rx.recv()=>match frame{Ok(v)=>write_client(&mut socket,Message::Text(v)).await?,Err(_)=>return Ok(())},
                    msg=socket.next()=>match msg.transpose()?{
                        None|Some(Message::Close(_))=>return Ok(()),
                        Some(Message::Ping(_))=>socket.flush().await?,
                        Some(Message::Text(frame))=>{
                            let ack = if local_overlay_request(app, &frame).await { "True" } else { "False" };
                            write_client(&mut socket, Message::text(ack)).await?;
                        },_=>{}
                    }
                }
            }
        };
        let Some(mut upstream) = upstream else {
            return Ok(());
        };
        loop {
            tokio::select! {
                frame=rx.recv()=>match frame{Ok(v)=>write_client(&mut socket,Message::Text(v)).await?,Err(_)=>return Ok(())},
                changed=target.changed()=>{if changed.is_err(){return Ok(());} break;},
                msg=upstream.next()=>match msg{Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,Some(Ok(msg))=>write_client(&mut socket,msg).await?},
                msg=socket.next()=>match msg.transpose()?{
                    None|Some(Message::Close(_))=>return Ok(()),
                    Some(Message::Text(frame)) if local_overlay_request(app,&frame).await=>write_client(&mut socket,Message::text("True")).await?,
                    Some(msg)=>{if upstream.send(msg).await.is_err(){break;}}
                }
            }
        }
    }
}
async fn write_client(socket: &mut ReaderSocket, msg: Message) -> Result<(), tungstenite::Error> {
    tokio::time::timeout(std::time::Duration::from_secs(10), socket.send(msg))
        .await
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))?
}

/// Negotiate a snapshot and subscribe under the same lock. JSON encoding happens after
/// releasing the journal, so even a reconnect requesting 1,000 rows cannot stall intake.
fn snapshot(intake: &Intake, input: &Value, rx: &mut broadcast::Receiver<Utf8Bytes>) -> String {
    let (session, sequence, records) = {
        let s = intake.state.lock().unwrap();
        *rx = s.feed.modern.subscribe();
        let rows = s.stream.records();
        let skip = rows
            .len()
            .saturating_sub(gsm_intake::reader::snapshot_limit(input));
        (
            s.stream.session_id().to_owned(),
            s.stream.accepted_lines(),
            rows.skip(skip).cloned().collect::<Vec<_>>(),
        )
    };
    json!({"event":"text_v2_snapshot","session_id":session,"snapshot_sequence":sequence,
        "lines":records.iter().map(|r|wire_record(r)).collect::<Vec<_>>()})
    .to_string()
}

async fn serve(
    app: &AppHandle,
    plain: bool,
    mut socket: ReaderSocket,
    upstream: Target,
) -> Result<(), tungstenite::Error> {
    let intake = app.state::<Intake>();
    let (mut rx, backlog) = {
        let mut s = intake.state.lock().unwrap();
        if plain {
            (
                s.feed.plain.subscribe(),
                std::mem::take(&mut s.feed.backlog),
            )
        } else {
            (s.feed.legacy.subscribe(), VecDeque::new())
        }
    };
    for frame in backlog {
        write_client(&mut socket, Message::Text(frame)).await?;
    }
    loop {
        tokio::select! {
            frame=rx.recv()=> {
                let Ok(frame)=frame else{
                    let close=tungstenite::protocol::CloseFrame {
                        code:tungstenite::protocol::frame::coding::CloseCode::Again,
                        reason:"Resume from reader snapshot".into()
                    };
                    write_client(&mut socket,Message::Close(Some(close))).await?;
                    break;
                };
                write_client(&mut socket,Message::Text(frame)).await?;
            }
            msg=socket.next()=> {
                let reply=match msg.transpose()?{
                    None|Some(Message::Close(_))=>break,
                    Some(Message::Ping(_))=>{socket.flush().await?;continue;}
                    Some(Message::Text(_)) if plain=>"False".into(),
                    Some(Message::Text(raw))=>{
                        let input:Value=serde_json::from_str(&raw).unwrap_or(Value::Null);
                        match input["event"].as_str(){
                            Some("text_v2_snapshot_request")=>snapshot(&intake,&input,&mut rx),
                            Some("textfeed_session_sync_request")=>{
                                let s=intake.state.lock().unwrap();
                                s.reader.sync(s.stream.session_id(),&input).to_string()
                            }
                            _=>{
                                let base=upstream.borrow().clone();
                                if relay_input(base,raw).await {"True"}else{"False"}.into()
                            }
                        }
                    }
                    _=>continue,
                };
                write_client(&mut socket,Message::text(reply)).await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_and_fast_consumers_have_independent_cursors() {
        let mut s = Session::default();
        let mut slow = s.feed.modern.subscribe();
        let mut fast = s.feed.modern.subscribe();
        for i in 0..300 {
            let mut events = vec![];
            s.stream.ingest(
                &json!({"source":"manual","text":format!("line {i}")}),
                &s.policy,
                gsm_intake::Clock {
                    wall: chrono::Utc::now(),
                    ns: i,
                },
                &mut events,
            );
            for event in events {
                s.publish_reader(&event);
            }
            let message: Value =
                serde_json::from_slice(fast.try_recv().unwrap().as_bytes()).unwrap();
            assert_eq!(message["data"]["stream_sequence"], i + 1);
        }
        assert!(matches!(
            slow.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        assert_eq!(s.stream.records().len(), 300);
        assert_eq!(s.feed.backlog.len(), 100);
    }
}
