//! Desktop-owned dialogue state. Backend reconnects resume from the last projected event.
pub(crate) mod bootstrap;
#[cfg(windows)]
mod clipboard_windows;
pub(crate) mod context;
mod discord;
pub(crate) mod feed;
pub(crate) mod overlay_control;
pub(crate) mod hotkeys;
mod outputs;
mod persist;
mod projection;
mod sources;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use gsm_intake::{Clock, Event, Policy, Stream};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::Notify;

const PROJECTION_CAPACITY: usize = 2048;
const REPLY_LIMIT: usize = 6 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;

#[derive(Clone, Copy)]
pub enum Producer {
    Ocr,
    Texthook,
}

#[derive(Clone, Copy, Default)]
struct Activity {
    ocr: bool,
    texthook: bool,
}
impl Activity {
    fn any(self) -> bool {
        self.ocr || self.texthook
    }
    fn set(&mut self, source: Producer, active: bool) -> bool {
        let flag = match source {
            Producer::Ocr => &mut self.ocr,
            Producer::Texthook => &mut self.texthook,
        };
        std::mem::replace(flag, active) != active
    }
}

#[derive(Default)]
struct Session {
    token: String,
    reader: gsm_intake::reader::Reader,
    feed: feed::Feed,

    native_reader: bool,
    projected: u64,
    projection: projection::Projection,
    activity: Activity,
    outputs: Option<outputs::Sender>,
    transfers: VecDeque<(String, Instant, Vec<u8>)>,
    epoch: u64,
    stream: Stream,
    latest: Option<std::sync::Arc<gsm_intake::Record>>,
    last_received_at: Option<chrono::DateTime<chrono::Utc>>,
    policy: Policy,
    sources: sources::Sources,
    retention: i64,
    finished: bool,
    events: VecDeque<Event>,
    first: u64,
    exclusions_revision: Option<(std::time::SystemTime, u64)>,
}
impl Session {
    fn change_pause(&mut self, paused: bool, now: Clock) -> bool {
        if self.policy.paused == paused {
            return false;
        }
        self.policy.paused = paused;
        if self.native_reader {
            if paused {
                let at = now.wall.timestamp_micros() as f64 / 1e6;
                self.projection.live.interrupt(at);
                if let Some(writer) = &self.projection.writer { writer.interrupt(at); }
            }
            self.stats_changed(if paused { "intake_paused" } else { "intake_resumed" });
        }
        true
    }
    fn reserve_output(
        &self,
    ) -> Result<Option<tokio::sync::mpsc::OwnedPermit<outputs::Output>>, String> {
        self.outputs
            .as_ref()
            .map(|sender| {
                sender
                    .clone()
                    .try_reserve_owned()
                    .map_err(|e| format!("Text output queue is unavailable: {e}"))
            })
            .transpose()
    }

    fn publish(
        &mut self,
        app: &tauri::AppHandle,
        events: Vec<Event>,
        mut permit: Option<tokio::sync::mpsc::OwnedPermit<outputs::Output>>,
    ) {
        for event in events {
            if let Event::Append(r) | Event::Update(r) = &event {
                self.last_received_at = Some(r.first_seen_at_utc);
                let append = matches!(event, Event::Append(_));
                let previous = self.latest.as_deref().filter(|prev| prev.scene == r.scene);
                app.state::<crate::recycled_lines::Recycled>().observe(
                    app,
                    r,
                    append,
                    previous.map(|p| p.text.as_ref()),
                );
                if append || previous.is_some_and(|p| p.line_id == r.line_id) {
                    self.latest = Some(r.clone());
                }
                // A single observation appends or revises one line. Retries and subsequent stats events do neither.
                if let Some(slot) = permit.take() {
                    slot.send(outputs::Output::new(
                        app,
                        r,
                        matches!(event, Event::Append(_)),
                    ));
                }
                crate::mining_workspace::publish_latest(
                    app,
                    json!({
                        "text":r.raw_text, "processed_text":r.text,"source":r.source_kind,
                        "source_display_name":r.source_display_name,"time":r.captured_at_utc.with_timezone(&chrono::Local)
                    }),
                );
            }
            if let Event::Expire(r) = &event {
                if self
                    .latest
                    .as_ref()
                    .is_some_and(|last| last.line_id == r.line_id)
                {
                    self.latest = None;
                }
                app.state::<crate::recycled_lines::Recycled>()
                    .expire(&r.line_id);
            }
            if self.native_reader {
                self.projected += 1;
                self.publish_reader(&event);
                if self.projection.longplay {
                    let record = match &event {
                        Event::Freeze(r) => Some(r),
                        Event::Append(r) if r.state=="frozen" => Some(r),
                        _ => None,
                    };
                    if let Some(r)=record {
                        app.state::<crate::longplay::Service>().line(r.captured_at_utc.timestamp_micros(),r.text.clone());
                    }
                }
                if let Some(reason) = self.projection.observe(app, &event) {
                    self.stats_changed(reason);
                }
            }
            let compatibility_event = matches!(event, Event::Benchmark(_) | Event::Redundant);
            if !self.native_reader
                || (compatibility_event
                    && self.epoch != 0
                    && self.epoch == app.state::<Intake>().epoch.load(Ordering::Acquire))
            {
                self.events.push_back(event);
            }
        }
    }

    fn stats_changed(&mut self, reason: &str) {
        if self.feed.overlay.receiver_count() > 0 {
            let payload = self.projection.payload(reason, self.policy.paused);
            let _ = self.feed.overlay.send(payload.to_string().into());
        }
    }
    fn refresh_exclusions(&mut self, directory: &std::path::Path) {
        let revision = match directory.join("sentence_exclusions.json").metadata() {
            Ok(stat) => stat.modified().ok().map(|t| (t, stat.len())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return,
        };
        if revision == self.exclusions_revision {
            return;
        }
        if let Ok(games) = gsm_settings::workspace::Workspace::new(directory).exclusions() {
            self.policy.exclusions = games
                .as_object()
                .into_iter()
                .flatten()
                .map(|(game, items)| {
                    let lines = items
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(|s| s.trim().replace("\r\n", "\n").replace('\r', "\n"))
                        .collect();
                    (game.clone(), lines)
                })
                .collect();
            self.exclusions_revision = revision;
        }
    }
    // A frozen reply lets a reader reconstruct even a single oversized OCR record
    // while newer records and revisions continue to arrive.
    fn transfer(&mut self, value: Value) -> Result<Value, String> {
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        self.transfers
            .retain(|(_, at, _)| at.elapsed() < Duration::from_secs(60));
        if self.transfers.len() >= 4 {
            return Err("Too many large text reads in progress".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let reply = json!({"transfer":id,"size":bytes.len()});
        self.transfers.push_back((id, Instant::now(), bytes));
        Ok(reply)
    }
    fn chunk(&mut self, data: &Value) -> Result<Value, String> {
        let index = self
            .transfers
            .iter()
            .position(|(id, _, _)| Some(id.as_str()) == data["transfer"].as_str())
            .ok_or("Text transfer expired")?;
        let (_, accessed, bytes) = &mut self.transfers[index];
        *accessed = Instant::now();
        let offset = data["offset"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n < bytes.len())
            .ok_or("Invalid text transfer offset")?;
        let end = bytes.len().min(offset.saturating_add(CHUNK));
        let result = Value::String(STANDARD.encode(&bytes[offset..end]));
        if end == bytes.len() {
            self.transfers.remove(index);
        }
        Ok(result)
    }
    fn tail(&self) -> u64 {
        self.first + self.events.len() as u64
    }
    fn last_received(&self) -> Option<String> {
        self.last_received_at.map(|at| at.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M:%S").to_string())
    }
    fn batch(&mut self, after: u64) -> Result<Value, String> {
        if after < self.first || after > self.tail() {
            return Err("Invalid text projection cursor".into());
        }
        self.events.drain(..(after - self.first) as usize);
        self.first = after;
        let mut rows = Vec::new();
        let mut bytes = 0;
        for event in self.events.iter().take(32) {
            let value = serde_json::to_value(event).map_err(|e| e.to_string())?;
            let size = gsm_runtime::serialized_size(&value)?;
            if !rows.is_empty() && bytes + size > REPLY_LIMIT {
                break;
            }
            bytes += size;
            rows.push(value);
        }
        let mut reply = json!({"cursor":self.first+rows.len() as u64,"sources":self.sources.status(),"accepted_lines":self.stream.accepted_lines()});
        if self.native_reader {
            reply["paused"] = json!(self.policy.paused);
            reply["last_line_received"] = json!(self.last_received());
        }
        reply["events"] = Value::Array(rows);
        if bytes > REPLY_LIMIT {
            self.transfer(reply)
        } else {
            Ok(reply)
        }
    }
}

pub struct Intake {
    today_stats: tokio::sync::Mutex<()>,
    pause_controls: Mutex<()>,
    scan: Mutex<Option<gsm_mining::text::GameLine>>,
    epoch: AtomicU64,
    state: Mutex<Session>,
    wake: Notify,
    deadline: Notify,
    clock: Instant,
}
impl Default for Intake {
    fn default() -> Self {
        Self {
            today_stats: Default::default(),
            pause_controls: Mutex::new(()),
            scan: Default::default(),
            epoch: 0.into(),
            state: Default::default(),
            wake: Default::default(),
            deadline: Default::default(),
            clock: Instant::now(),
        }
    }
}
impl Intake {
    pub(crate) fn control_pause(&self, app: &tauri::AppHandle, command: Pause) -> Result<bool, String> {
        // Complete tray and notification delivery in mutation order without holding
        // up dialogue ingestion or access to the reader snapshot.
        let _control = self.pause_controls.lock().unwrap();
        let (paused, changed, relay) = {
            let mut state = self.state.lock().unwrap();
            if !state.native_reader || state.finished { return Err("Native text intake is unavailable".into()); }
            let paused = match command {
                Pause::Get => return Ok(state.policy.paused),
                Pause::Set(value) => value,
                Pause::Toggle => !state.policy.paused,
            };
            (paused, state.change_pause(paused, self.now()), state.policy.relay)
        };
        if changed {
            self.wake.notify_one();
            crate::app_lifecycle::intake_pause_changed(app, paused, relay);
        }
        Ok(paused)
    }
    pub(crate) fn health(&self) -> Value {
        let session = self.state.lock().unwrap();
        let sender = session.outputs.as_ref();
        let capacity = sender.map_or(0, |s| s.max_capacity());
        let healthy = session.native_reader && !session.finished && sender.is_some_and(|s| !s.is_closed());
        json!({"healthy":healthy, "error":if healthy {""} else {"Text intake is unavailable"},
            "sources":session.sources.status(),"accepted_lines":session.stream.accepted_lines(),
            "cursor":session.projected,"last_line_received":session.last_received(),
            "queue_depth":capacity - sender.map_or(0, |s| s.capacity()),"queue_capacity":capacity})
    }
    fn now(&self) -> Clock {
        Clock {
            wall: Utc::now(),
            ns: self.clock.elapsed().as_nanos().min(i64::MAX as u128) as i64,
        }
    }
    pub fn connection(&self, app: &tauri::AppHandle, epoch: Option<u64>) {
        self.epoch.store(epoch.unwrap_or(0), Ordering::Release);
        if epoch.is_none() {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let intake = app.state::<Intake>();
                let mut state = intake.state.lock().unwrap();
                if !state.native_reader && state.epoch != intake.epoch.load(Ordering::Acquire) {
                    state.sources = Default::default();
                }
            });
        }
        self.wake.notify_one();
    }
    pub fn overlay_ready(&self, app: &tauri::AppHandle, scene: &str) {
        self.state.lock().unwrap().projection.flush_scan(app, scene);
    }
    pub fn active(&self) -> bool {
        let epoch = self.epoch.load(Ordering::Acquire);
        let s = self.state.lock().unwrap();
        !s.finished && (s.native_reader || (epoch != 0 && s.epoch == epoch))
    }
}
pub(crate) enum Pause { Get, Set(bool), Toggle }
pub async fn finish_desktop(app: &tauri::AppHandle) -> Result<(), String> {
    {
        let intake = app.state::<Intake>();
        let mut s = intake.state.lock().unwrap();
        if s.native_reader && !s.finished {
            s.finished = true;
            s.sources = Default::default();
            let mut events = Vec::new();
            s.stream.finish(intake.now(), &mut events);
            s.publish(app, events, None);
        }
    }
    flush_history(app).await
}
pub async fn flush_history(app: &tauri::AppHandle) -> Result<(), String> {
    let barrier = app
        .state::<Intake>()
        .state
        .lock()
        .unwrap()
        .projection
        .writer
        .as_ref()
        .map(persist::Writer::barrier);
    if let Some(rx) = barrier {
        tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .map_err(|_| "Dialogue history is still waiting to commit")?
            .map_err(|_| "History worker stopped")??;
    }
    Ok(())
}
/// Source coordinators can start before the backend connects. Preserve their state across sessions.
pub fn producer_activity(app: &tauri::AppHandle, source: Producer, active: bool) {
    let intake = app.state::<Intake>();
    let (name, command) = match source {
        Producer::Ocr => ("OCR", "ocr_status"),
        Producer::Texthook => ("Texthook", "texthook_status"),
    };
    let mut s = intake.state.lock().unwrap();
    if !s.activity.set(source, active) {
        return;
    }
    if s.outputs.is_some() {
        let blocked = s.activity.any();
        s.sources.set_inhouse(blocked);
        let clipboard = s.sources.clipboard_state();
        drop(s);
        intake.wake.notify_one();
        let status = if active { "started" } else { "stopped" };
        crate::desktop_log::info(
            app,
            "text-intake",
            format!("{name} {status}. Clipboard {clipboard}."),
        );
    } else {
        drop(s);
        // Older Python clients own clipboard intake and expect these lifecycle notifications.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::runtime::backend_command(&app, command, json!({"active":active})).await;
        });
    }
}

fn checked<'a>(
    service: &'a Intake,
    epoch: u64,
) -> Result<std::sync::MutexGuard<'a, Session>, String> {
    let state = service.state.lock().unwrap();
    if epoch == 0 || service.epoch.load(Ordering::Acquire) != epoch {
        Err("Text connection was replaced".into())
    } else {
        Ok(state)
    }
}
fn held_control(target: Option<u64>) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::UI::{
            Input::KeyboardAndMouse::GetAsyncKeyState, WindowsAndMessaging::GetForegroundWindow,
        };
        if target.is_none_or(|id| id == 0 || unsafe { GetForegroundWindow() }.0 as u64 != id) {
            return false;
        }
        let down = |key| unsafe { GetAsyncKeyState(key) } < 0;
        down(0x11)
            && ![0x10, 0x12, 0x5b, 0x5c]
                .into_iter()
                .chain(0x30..=0x5a)
                .any(down)
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        false
    }
}

pub async fn submit(
    app: &tauri::AppHandle,
    payload: Value,
    source: Option<sources::Origin>,
) -> Result<Value, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || ingest(&app, payload, source))
        .await
        .map_err(|e| e.to_string())?
}

fn ingest(
    app: &tauri::AppHandle,
    mut payload: Value,
    source: Option<sources::Origin>,
) -> Result<Value, String> {
    let service = app.state::<Intake>();
    let mut state = service.state.lock().unwrap();
    let id = payload
        .get("observationId")
        .or_else(|| payload.get("observation_id"));
    if (!state.native_reader
        && (state.epoch == 0 || state.epoch != service.epoch.load(Ordering::Acquire)))
        || state.finished
        || state
            .projection
            .writer
            .as_ref()
            .is_some_and(persist::Writer::busy)
        || (state.events.len() >= PROJECTION_CAPACITY
            && (!state.native_reader || service.epoch.load(Ordering::Acquire) != 0))
    {
        return Ok(
            json!({"status":"backpressured","observation_id":id,"reason":"text projection unavailable or full"}),
        );
    }
    if source
        .as_ref()
        .is_some_and(|s| !state.sources.accepts(s, state.epoch))
    {
        return Ok(
            json!({"status":"rejected","observation_id":id,"reason":"text source was disabled"}),
        );
    }
    let permit = match state.reserve_output() {
        Ok(permit) => permit,
        Err(reason) => {
            return Ok(json!({"status":"backpressured","observation_id":id,"reason":reason}))
        }
    };
    let obs = app.state::<crate::obs::Obs>().game_session();
    if let Some(epoch) = payload["speech_scene_epoch"].as_u64() {
        if obs["scene_epoch"] != epoch || obs["target_id"] != payload["metadata"]["window_hwnd"]
            || obs["target_pid"] != payload["metadata"]["window_pid"] {
            return Ok(json!({"status":"rejected","observation_id":id,"reason":"speech capture target changed"}));
        }
    }
    if payload["ocr_scene"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && obs["scene"].as_str() != Some(s))
    {
        return Ok(json!({"status":"rejected","observation_id":id,"reason":"stale OCR scene"}));
    }
    if !payload.is_object() {
        return Err("Text observation must be an object".into());
    }
    // Automatic lines can settle after the user turns statistics back on.
    // Keep their eligibility with the observation through that delay.
    if state.native_reader && !state.projection.collect {
        payload["exclude_from_stats"] = json!(true);
    }
    if !matches!(
        payload["source"].as_str(),
        Some("overlay" | "manual" | "speech_recognition" | "speech")
    ) && held_control(obs["target_id"].as_u64())
    {
        if !payload["metadata"].is_object() {
            payload["metadata"] = json!({});
        }
        payload["metadata"]["skip_control_active"] = json!(true);
    }
    let mut events = Vec::new();
    let now = service.now();
    let state = &mut *state;
    state.refresh_exclusions(&app.state::<crate::settings::Settings>().paths.active);
    if let Some(scene) = obs["scene"].as_str().filter(|s| !s.is_empty()) {
        state.policy.scene = scene.into();
    }
    let mut ack = state
        .stream
        .ingest(&payload, &state.policy, now, &mut events);
    state.publish(app, events, permit);
    ack["cursor"] = json!(state.tail());
    if !state.native_reader || !state.events.is_empty() {
        service.wake.notify_one();
    }
    if state.native_reader && state.stream.next_speech_ns().is_some() {
        service.deadline.notify_one();
    }
    Ok(ack)
}

pub async fn request(app: &tauri::AppHandle, epoch: u64, mut data: Value) -> Result<Value, String> {
    let service = app.state::<Intake>();
    let action = data["action"].as_str().unwrap_or("").to_owned();
    let now = service.now();
    if action == "controlPause" {
        drop(checked(&service, epoch)?);
        let command = match data["operation"].as_str() {
            Some("get") => Pause::Get,
            Some("set") => Pause::Set(data["paused"].as_bool().ok_or("Missing pause state")?),
            Some("toggle") => Pause::Toggle,
            _ => return Err("Unknown pause operation".into()),
        };
        return Ok(json!(service.control_pause(app, command)?));
    }
    if action == "submit" {
        {
            let state = checked(&service, epoch)?;
            if state.epoch != epoch {
                return Err("Text intake is starting".into());
            }
        }
        return submit(
            app,
            data["payload"].take(),
            Some(sources::Origin::Backend(epoch)),
        )
        .await;
    }
    if action == "readerHttp" {
        use gsm_mining::gateway::ReaderEndpoint;
        {
            let state = checked(&service, epoch)?;
            if !state.native_reader || state.epoch != epoch {
                return Err("Native reader unavailable".into());
            }
        }
        let body = data["body"].take();
        let (status, body) =
            feed::Endpoint(app.clone()).query(data["path"].as_str().unwrap_or(""), body);
        let reply = json!({"status":status.as_u16(),"body":body});
        if gsm_runtime::serialized_size(&reply)? > REPLY_LIMIT {
            return checked(&service, epoch)?.transfer(reply);
        }
        return Ok(reply);
    }
    if action == "next" {
        let after = data["after"].as_u64().ok_or("Missing projection cursor")?;
        let wait = {
            let state = &mut *checked(&service, epoch)?;
            if state.epoch != epoch {
                return Err("Text intake is starting".into());
            }
            let mut events = Vec::new();
            if !state.native_reader {
                state.stream.maintain(now, state.retention, &mut events);
                state.publish(app, events, None);
            }
            if after != state.tail() || state.finished {
                return state.batch(after);
            }
            // Commit the cursor before waiting, freeing capacity for blocked producers.
            state.events.drain(..(after - state.first) as usize);
            state.first = after;
            let due = state
                .stream
                .next_speech_ns()
                .unwrap_or(i64::MAX)
                .saturating_sub(now.ns)
                .max(0);
            Duration::from_nanos(due as u64).min(Duration::from_secs(1))
        };
        let _ = tokio::time::timeout(wait, service.wake.notified()).await;
        let state = &mut *checked(&service, epoch)?;
        let mut events = Vec::new();
        if !state.native_reader {
            state
                .stream
                .maintain(service.now(), state.retention, &mut events);
            state.publish(app, events, None);
        }
        return state.batch(after);
    }
    let state = &mut *checked(&service, epoch)?;
    if action == "start" {
        let token = data["session"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing backend session")?;
        if state.token != token && !state.native_reader {
            service.scan.lock().unwrap().take();
            app.state::<crate::recycled_lines::Recycled>()
                .reset_session();
            *state = Session {
                token: token.into(),
                activity: state.activity,
                outputs: state.outputs.take(),
                ..Default::default()
            };
        }
        if state.token != token {
            state.first = 0;
            state.events.clear();
            state.token = token.into();
        }
        state.epoch = epoch;
    } else if state.epoch != epoch {
        return Err("Text intake is starting".into());
    }
    match action.as_str() {
        "start" | "configure" => {
            let mut policy: Policy =
                serde_json::from_value(data["policy"].take()).map_err(|e| e.to_string())?;
            policy.exclusions = std::mem::take(&mut state.policy.exclusions);
            if action == "configure" || state.native_reader {
                policy.paused = state.policy.paused;
            }
            if action == "configure" {
                policy.benchmark = state.policy.benchmark;
            }
            if data["native_reader"] == true || state.native_reader {
                state.projection.configure(app, &data, &policy.language)?;
            }
            state.policy = policy;
            state.retention = data["retention"].as_i64().unwrap_or(305).max(5);
            let source_epoch = if state.native_reader || data["native_reader"] == true {
                0
            } else {
                epoch
            };
            state.sources.configure(app, source_epoch, &data["sources"]);
            if action == "start" {
                state.native_reader |= data["native_reader"] == true;
                if data["desktop_outputs"] == true {
                    let first = state.outputs.is_none();
                    if first {
                        state.outputs = Some(outputs::start()?);
                    }
                    state.sources.set_inhouse(state.activity.any());
                    if first {
                        let clipboard = state.sources.clipboard_state();
                        let activity = state.activity;
                        let mode = |active| if active { "active" } else { "inactive" };
                        let message = format!(
                            "Rust text intake ready. OCR {}, texthook {}, clipboard {clipboard}.",
                            mode(activity.ocr),
                            mode(activity.texthook)
                        );
                        crate::desktop_log::info(app, "text-intake", message);
                    }
                    return Ok(json!({"desktop_outputs":true}));
                }
                state.outputs = None;
                state
                    .sources
                    .set_inhouse(data["sources"]["inhouse"] == true);
            }
            Ok(json!(true))
        }
        "inhouse" => {
            if state.outputs.is_none() {
                state.sources.set_inhouse(data["active"] == true);
            }
            Ok(json!(true))
        }
        "pause" => {
            let paused = data["paused"] == true;
            state.change_pause(paused, now);
            Ok(json!(true))
        }
        "benchmark" => {
            state.policy.benchmark = data["enabled"] == true;
            Ok(json!(state.tail()))
        }
        "readerLines" | "readerStats" | "readerDaily" => {
            let value = match action.as_str() {
                "readerLines" => state.line_rows(
                    data["scope"].as_str().unwrap_or("active"),
                    data["id"].as_str().unwrap_or(""),
                ),
                "readerDaily" => {
                    json!({"stats":state.projection.live.values(),"lines":state.projection.live.lines()})
                }
                _ => {
                    let paused = state.policy.paused;
                    state.projection.payload("refresh", paused)
                }
            };
            if gsm_runtime::serialized_size(&value)? > REPLY_LIMIT {
                state.transfer(value)
            } else {
                Ok(value)
            }
        }
        "readerScan" => Ok(json!(service.scan.lock().unwrap().as_ref())),
        "readerControl" => {
            state.feed.control(&data["message"]);
            Ok(Value::Null)
        }
        "readerReset" => {
            state.reader.reset_selection();
            state.feed.control(&json!({"event":"reset_checkboxes"}));
            Ok(Value::Null)
        }
        "chunk" => state.chunk(&data),
        "snapshot" => {
            let value = state
                .stream
                .snapshot(data["limit"].as_u64().map(|n| n as usize));
            if gsm_runtime::serialized_size(&value)? > REPLY_LIMIT {
                state.transfer(value)
            } else {
                Ok(value)
            }
        }
        "freeze" | "recover" | "finish" => {
            let permit = if action == "recover" {
                state.reserve_output()?
            } else {
                None
            };
            let mut events = Vec::new();
            let changed = match action.as_str() {
                "freeze" => {
                    state
                        .stream
                        .freeze(data["id"].as_str().unwrap_or(""), now, &mut events)
                }
                "recover" => {
                    data["scene"] == state.policy.scene
                        && state.stream.recover(
                            data["text"].as_str().unwrap_or(""),
                            &state.policy,
                            now,
                            &mut events,
                        )
                }
                _ => {
                    if state.native_reader {
                        return Ok(json!({"changed":false,"cursor":state.tail()}));
                    }
                    state.finished = true;
                    state.sources = Default::default();
                    state.stream.finish(now, &mut events);
                    true
                }
            };
            state.publish(app, events, permit);
            service.wake.notify_one();
            Ok(json!({"changed":changed,"cursor":state.tail()}))
        }
        _ => Err("Unknown text intake operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_output_queue_backpressures_before_a_record_is_committed() {
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        let state = Session {
            outputs: Some(sender),
            ..Default::default()
        };
        let slot = state.reserve_output().unwrap();
        assert!(state.reserve_output().is_err());
        assert_eq!(state.stream.accepted_lines(), 0);
        drop(slot);
        assert!(state.reserve_output().unwrap().is_some());
    }

    #[test]
    fn acknowledged_cursor_survives_retries_and_rejects_stale_readers() {
        let mut s = Session::default();
        s.events.extend((0..40).map(|i| Event::Benchmark(json!(i))));
        let page = s.batch(0).unwrap();
        assert_eq!(page["cursor"], 32);
        assert_eq!(s.batch(0).unwrap(), page);
        assert_eq!(s.batch(32).unwrap()["events"][0]["record"], 32);
        assert!(s.batch(0).is_err());
        assert!(s.batch(41).is_err());
        assert_eq!(s.batch(40).unwrap()["events"], json!([]));
    }

    #[test]
    fn oversized_event_can_be_reassembled_before_acknowledgement() {
        let mut s = Session::default();
        let huge = "q".repeat(REPLY_LIMIT + 1);
        s.events.push_back(Event::Benchmark(json!(huge)));
        let header = s.batch(0).unwrap();
        let mut buffer = Vec::new();
        while buffer.len() < header["size"].as_u64().unwrap() as usize {
            let chunk = s
                .chunk(&json!({"transfer":header["transfer"],"offset":buffer.len()}))
                .unwrap();
            buffer.extend(STANDARD.decode(chunk.as_str().unwrap()).unwrap());
        }
        assert!(s.transfers.is_empty());
        let page: Value = serde_json::from_slice(&buffer).unwrap();
        assert_eq!(page["events"][0]["record"], huge);
        assert_eq!(
            s.batch(page["cursor"].as_u64().unwrap()).unwrap()["events"],
            json!([])
        );
    }
}
