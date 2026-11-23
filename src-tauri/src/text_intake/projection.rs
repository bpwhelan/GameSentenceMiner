use super::discord::Presence;
use super::persist::{Options, Writer};
use gsm_history::live::{Cleaner, Live};
use gsm_intake::Event;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(super) struct Projection {
    pub writer: Option<Writer>,
    options: Arc<Options>,
    pub collect: bool,
    configured_collection: Option<bool>,
    collection_profile: String,
    pub longplay: bool,
    interrupted: bool,
    pub live: Live,
    cleaner: Cleaner,
    pub gap: f64,
    pub presence: Presence,
    pub pending_mined: std::collections::HashMap<String, Vec<gsm_history::mining::MinedLine>>,
    pending_scan: Option<Arc<gsm_intake::Record>>,
}
impl Projection {
    pub fn configure(
        &mut self,
        app: &AppHandle,
        data: &Value,
        language: &str,
    ) -> Result<(), String> {
        let cfg = &data["projection"];
        let collect = cfg["collect"] != false;
        let profile_changed = cfg["profile"].as_str().is_some_and(|name| name != self.collection_profile);
        if self.configured_collection != Some(collect) || profile_changed {
            self.configured_collection = Some(collect);
            self.collect = collect;
        }
        if let Some(name) = cfg["profile"].as_str() { self.collection_profile = name.into(); }
        self.longplay = cfg["longplay"] == true;
        app.state::<crate::longplay::Service>().configure(app,self.longplay)?;
        self.gap = cfg["gap"].as_f64().unwrap_or(1800.);
        self.cleaner.configure(
            cfg["punctuation"].as_str().unwrap_or(""),
            cfg["repetitions"] == true,
        );
        self.options = Arc::new(Options {
            language: language.into(),
            dictionary: cfg["dictionary"].as_str().map(str::to_owned),
        });
        self.presence.configure(&cfg["discord"]);
        if self.writer.is_none() {
            self.writer = Some(Writer::open(app)?);
        }
        Ok(())
    }
    pub fn payload(&mut self, reason: &str, paused: bool) -> Value {
        let mut v = self.live.values();
        v["type"] = json!("live_stats_update");
        v["reason"] = json!(reason);
        v["updated_at"] = json!(chrono::Utc::now().timestamp_micros() as f64 / 1e6);
        v["text_intake_paused"] = json!(paused);
        v["fields"] = json!([
            {"key":"chars_per_hour","label":"Chars/hour","format":"integer","default_visible":true},
            {"key":"total_characters","label":"Characters","format":"integer","default_visible":true},
            {"key":"active_reading_time","label":"Active time","format":"duration","default_visible":true},
            {"key":"raw_reading_time","label":"Raw time","format":"duration","default_visible":true},
            {"key":"cards_mined","label":"Cards mined","format":"integer","default_visible":true}
        ]);
        v
    }
    pub fn flush_scan(&mut self, app: &AppHandle, scene: &str) {
        let Some(r) = self.pending_scan.as_ref() else {
            return;
        };
        if r.scene.as_ref() != scene {
            self.pending_scan = None;
            return;
        }
        let actor = app.state::<crate::overlay::Overlay>();
        if !actor.ready_for_line(scene)
            || !app.state::<crate::overlay_host::OverlayHost>().is_running()
        {
            return;
        }
        let r = self.pending_scan.take().unwrap();
        let cmd = json!({"action":"scan","line_id":r.line_id,"line_scene":r.scene,"text":r.text,
            "precomputed":r.metadata.get("dict_from_ocr"),"source_instance":r.source_instance,"source":r.source_kind,"retries":5,
            "manual":matches!(r.source_kind,"hotkey"|"manual"|"ocr_manual"|"screen_cropper"|"secondary")});
        let _ = actor.command(crate::overlay_host::OVERLAY_MAIN_LABEL, cmd);
    }
    pub fn observe(&mut self, app: &AppHandle, event: &Event) -> Option<&'static str> {
        let overlay = |msg: Value| {
            let host = app.state::<crate::overlay_host::OverlayHost>();
            if host.is_running() {
                let label = crate::overlay_host::OVERLAY_MAIN_LABEL;
                let actor = app.state::<crate::overlay::Overlay>();
                if actor.command(label, msg).is_ok_and(|r| r["clear"] == true) {
                    crate::overlay::clear(app, label);
                }
            }
        };
        let (r, changed) = match event {
            Event::Expire(r) => {
                self.pending_mined.remove(&r.line_id);
                if self
                    .pending_scan
                    .as_ref()
                    .is_some_and(|p| p.line_id == r.line_id)
                {
                    self.pending_scan = None;
                }
                return None;
            }
            Event::SkipStarted(_) | Event::SkipEnded(_) => {
                self.pending_scan = None;
                self.interrupted = false;
                let start = matches!(event, Event::SkipStarted(_));
                overlay(json!({"action":"pause","paused":start}));
                if let Event::SkipEnded(r) = event {
                    if r.metadata["skip_context_reset"] != true {
                        overlay(json!({"action":"scan","recovery":true,"retries":5}));
                    }
                }
                return None;
            }
            Event::StatsExcluded(r) => {
                self.pending_mined.remove(&r.line_id);
                if self.collect && !self.interrupted {
                    let at = r.first_seen_at_utc.timestamp_micros() as f64 / 1e6;
                    self.live.interrupt(at);
                    if let Some(w) = &self.writer {
                        w.interrupt(at);
                    }
                }
                self.interrupted = true;
                return None;
            }
            Event::Append(r) | Event::Update(r) => {
                if r.stats_status != "skipped" {
                    if !r.skip_overlay {
                        self.pending_scan = Some(r.clone());
                        self.flush_scan(app, &r.scene);
                    }
                    if !r.relay_only {
                        self.presence.activity(app, &r.scene);
                    }
                }
                (r, true)
            }
            Event::StatsReady(r) => (r, true),
            Event::Freeze(r) => (r, false),
            _ => return None,
        };
        if !self.collect || r.excluded_from_stats || r.stats_status != "accepted" {
            return None;
        }
        if r.state == "frozen"
            && !matches!(event, Event::Update(_))
            && !r.scene.to_ascii_lowercase().contains("nostatspls")
        {
            if let Some(writer) = &self.writer {
                writer.capture(r, &self.options);
                for update in self.pending_mined.remove(&r.line_id).into_iter().flatten() {
                    writer.mined(update);
                }
            }
        }
        changed
            .then(|| {
                self.live.observe(
                    &r.line_id,
                    &r.text,
                    &r.scene,
                    r.first_seen_at_utc.timestamp_micros() as f64 / 1e6,
                    r.revision,
                    &self.cleaner,
                    self.gap,
                )
            })
            .flatten()
    }
}
