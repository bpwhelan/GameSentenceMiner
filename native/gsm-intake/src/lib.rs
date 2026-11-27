//! Single-writer dialogue stream. Outputs are immutable record revisions, in commit order.
mod dialogue_journal;
mod model;
pub mod reader;
mod skip_detection;
mod stats;

use dialogue_journal::{Journal, Stats};
use gsm_text_preview::correlation::{classify, Decision, Incoming, Windows};
use model::{automatic, captured, field, guard, kind};
pub use model::{Clock, Event, Policy, Record};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

const WINDOWS: Windows = Windows {
    same_ns: 2_000_000_000,
    cross_ns: 5_000_000_000,
    similarity: 70.,
};

pub struct Stream {
    id: Arc<str>,
    journal: Journal<Arc<Record>>,
    speech: Option<(String, i64)>,
    detector: skip_detection::Detector,
    scene: String,
    skip_line: Option<String>,
    landing: Option<(String, i64)>,
    echoes: u32,
    filters: Option<gsm_text_preview::LineFilters>,
}
impl Default for Stream {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4().to_string().into(),
            journal: Journal::new(),
            speech: None,
            detector: Default::default(),
            scene: String::new(),
            skip_line: None,
            landing: None,
            echoes: 0,
            filters: None,
        }
    }
}
impl Stream {
    pub fn session_id(&self) -> &str {
        &self.id
    }
    pub fn record(&self, id: &str) -> Option<&Arc<Record>> {
        self.journal.get(id.as_bytes())
    }
    pub fn records(&self) -> impl ExactSizeIterator<Item = &Arc<Record>> + DoubleEndedIterator {
        self.journal.rows()
    }
    pub fn accepted_lines(&self) -> u64 {
        self.journal.sequence()
    }
    pub fn snapshot(&self, limit: Option<usize>) -> Value {
        let rows = self.journal.rows();
        let skip = rows.len().saturating_sub(limit.unwrap_or(usize::MAX));
        json!({"session_id":self.id, "snapshot_sequence":self.journal.sequence(),
            "records":rows.skip(skip).collect::<Vec<_>>()})
    }
    fn publish(
        &mut self,
        record: Record,
        append: bool,
        changed: Option<i64>,
    ) -> Arc<Record> {
        let row = Arc::new(record);
        self.journal
            .publish(
                row.line_id.as_bytes(),
                Arc::clone(&row),
                append,
                Stats {
                    status: row.stats_status,
                    frozen: row.state == "frozen",
                    observed_ns: changed.map(i128::from),
                },
            )
            .expect("stream publishes only existing revisions or fresh line IDs");
        row
    }
    pub fn freeze(&mut self, id: &str, now: Clock, events: &mut Vec<Event>) -> bool {
        if self.speech.as_ref().is_none_or(|(open, _)| open != id) {
            return false;
        }
        let mut row = (**self
            .journal
            .get(id.as_bytes())
            .expect("open speech is retained"))
        .clone();
        row.state = "frozen";
        row.revision += 1;
        row.finalized_at_utc = Some(now.wall);
        self.speech = None;
        events.push(Event::Freeze(self.publish(row, false, None)));
        true
    }
    pub fn next_speech_ns(&self) -> Option<i64> {
        self.speech.as_ref().map(|(_, due)| *due)
    }
    fn freeze_due(&mut self, now: Clock, events: &mut Vec<Event>) {
        if let Some((id, _)) = self.speech.as_ref().filter(|(_, due)| now.ns >= *due) {
            self.freeze(&id.clone(), now, events);
        }
    }
    pub fn maintain(&mut self, now: Clock, retention_seconds: i64, events: &mut Vec<Event>) {
        self.freeze_due(now, events);
        self.poll_stats(now, events);
        let cutoff = now
            .wall
            .timestamp()
            .saturating_sub(retention_seconds.max(0));
        let expired = self
            .journal
            .expire(|r| {
                Ok::<_, std::convert::Infallible>(
                    r.state == "frozen" && r.first_seen_at_utc.timestamp() < cutoff,
                )
            })
            .unwrap();
        for row in expired {
            let mut r = Arc::unwrap_or_clone(row);
            r.state = "expired";
            r.revision += 1;
            events.push(Event::Expire(Arc::new(r)));
        }
    }

    pub fn ingest(
        &mut self,
        payload: &Value,
        policy: &Policy,
        now: Clock,
        events: &mut Vec<Event>,
    ) -> Value {
        self.ingest_inner(payload, policy, now, events, false)
    }

    fn ingest_inner(
        &mut self,
        payload: &Value,
        policy: &Policy,
        now: Clock,
        events: &mut Vec<Event>,
        recovered: bool,
    ) -> Value {
        let id = field(payload, &["observation_id", "observationId"])
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let reject =
            |reason: &str| json!({"observation_id":id,"status":"rejected","reason":reason});
        let Some(raw) = payload["text"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| payload["sentence"].as_str())
            .filter(|s| !s.trim().is_empty())
        else {
            return reject("text is required");
        };
        let raw = if recovered {
            raw
        } else {
            match guard(raw, policy.max_chars) {
                Ok(t) => t,
                Err(e) => return reject(e),
            }
        };
        if !recovered
            && policy.exclusions.get(&policy.scene).is_some_and(|set| {
                let raw = raw.trim();
                if raw.contains('\r') {
                    set.contains(&raw.replace("\r\n", "\n").replace('\r', "\n"))
                } else {
                    set.contains(raw)
                }
            })
        {
            return reject("sentence excluded for this game");
        }
        let source = payload["source"].as_str().unwrap_or("texthook");
        let name = field(payload, &["source_display_name", "sourceDisplayName"])
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(source);
        let source_kind = kind(source, name);
        let instance: Arc<str> = field(payload, &["source_instance", "sourceInstance", "hookId"])
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(name)
            .into();
        let stamp = captured(
            field(payload, &["captured_at", "capturedAt", "time"]),
            now.wall,
        );
        let mut metadata = payload["metadata"].as_object().cloned().unwrap_or_default();
        for key in [
            "dict_from_ocr",
            "hookId",
            "hookFunction",
            "engine",
            "exeName",
            "ocr_engine",
            "ocr_scene",
            "ocr_model",
            "ocr_finder",
        ] {
            if let Some(v) = payload.get(key) {
                metadata.insert(key.into(), v.clone());
            }
        }
        metadata.insert("scene".into(), json!(policy.scene));
        if !recovered
            && policy.benchmark
            && !matches!(
                source_kind,
                "clipboard" | "websocket" | "unknown" | "speech_recognition"
            )
        {
            events.push(Event::Benchmark(json!({"source":source_kind,"text":raw,"captured_at":stamp,"source_instance":instance,"scene":policy.scene,"observation_id":id,"metadata":metadata})));
            if source_kind == "ocr"
                || (source_kind == "overlay"
                    && metadata.get("overlay_manual") != Some(&Value::Bool(true)))
            {
                return reject("automatic OCR recorded for benchmark");
            }
        }
        let overrides = if source_kind == "texthook" && payload["_nativeHook"] == true {
            &payload["processorOverrides"]
        } else {
            &Value::Null
        };
        let processed = if recovered {
            raw.to_owned()
        } else {
            if self
                .filters
                .as_ref()
                .is_none_or(|f| !f.matches(&policy.processing, &policy.language))
            {
                let filters = match gsm_text_preview::LineFilters::new(
                    policy.processing.clone(),
                    &policy.language,
                ) {
                    Ok(filters) => filters,
                    Err(e) => return reject(&e),
                };
                self.filters = Some(filters);
            }
            match self.filters.as_ref().unwrap().process(raw, overrides) {
                Ok(s) => s,
                Err(e) => return reject(&e),
            }
        };
        self.freeze_due(now, events);
        self.poll_stats(now, events);
        if self.scene != policy.scene {
            self.change_scene(&policy.scene, now, events);
        }
        let mut ack = json!({"observation_id":id,"raw_text":raw,"processed_text":processed,"reason":"","line_id":null,"stream_sequence":null,"revision":null,"matched_source":null});
        if !self.journal.observe(id.as_bytes(), 20_000) {
            ack["status"] = json!("duplicate");
            ack["reason"] = json!("idempotent retry");
            return ack;
        }
        if processed.is_empty() {
            ack["status"] = json!("rejected");
            ack["reason"] = json!("empty processed text");
            return ack;
        }
        let speech = source_kind == "speech_recognition";
        let metadata = Arc::new(Value::Object(metadata));
        let landing = metadata["skip_landing_confirmed"] == true;
        let excluded = policy.paused || payload["exclude_from_stats"] == true;
        let track = automatic(source_kind) && !excluded && !landing;
        let scene: Arc<str> = policy.scene.as_str().into();
        let newest = self.journal.latest();
        let open = self
            .speech
            .as_ref()
            .and_then(|(id, _)| self.journal.get(id.as_bytes()));
        let input = Incoming {
            text: &processed,
            source: source_kind,
            instance: &instance,
            scene: &scene,
            now_ns: now.ns,
            relay: policy.paused,
            prefix: false,
            merge: speech,
            final_speech: metadata["speech_final"] == true,
            landing,
        };
        let decision = classify(
            &input,
            newest.map(|r| r.line()).as_ref(),
            open.map(|r| r.line()).as_ref(),
            None,
            self.next_speech_ns(),
            &WINDOWS,
        );
        let copy = field(payload, &["copyToClipboard", "copy_to_clipboard"]) == true;
        let skip_overlay = payload["skip_overlay"] == true;
        let (row, append) = match decision {
            Decision::Append(suffix) => {
                if speech {
                    if let Some((id, _)) = self.speech.clone() {
                        self.freeze(&id, now, events);
                    }
                }
                let stats_status = if track {
                    if self.detector.confirmed {
                        "skipped"
                    } else {
                        "pending"
                    }
                } else if self.journal.has_pending() && !excluded {
                    "pending_manual"
                } else {
                    "accepted"
                };
                let raw_text: Arc<str> = raw.into();
                let text = suffix.unwrap_or(&processed);
                let text = if text == raw {
                    raw_text.clone()
                } else {
                    text.into()
                };
                (
                    Record {
                        line_id: Uuid::new_v4().to_string(),
                        session_id: self.id.clone(),
                        stream_sequence: self.journal.sequence() + 1,
                        revision: 1,
                        state: if speech { "provisional" } else { "frozen" },
                        raw_text,
                        text,
                        source_kind,
                        source_instance: instance.clone(),
                        source_display_name: name.into(),
                        observation_ids: vec![id.as_str().into()],
                        captured_at_utc: stamp,
                        first_seen_at_utc: now.wall,
                        first_seen_monotonic_ns: now.ns,
                        finalized_at_utc: (!speech).then_some(now.wall),
                        stats_status,
                        scene,
                        copy_to_clipboard: copy,
                        excluded_from_stats: excluded || stats_status == "skipped",
                        relay_only: policy.paused,
                        skip_overlay,
                        metadata,
                    },
                    true,
                )
            }
            Decision::Revise => {
                let mut row = (**open.expect("classification requires open speech")).clone();
                row.revision += 1;
                row.raw_text = raw.into();
                row.text = processed.as_str().into();
                row.source_display_name = name.into();
                row.observation_ids.push(id.as_str().into());
                row.captured_at_utc = row.captured_at_utc.min(stamp);
                row.copy_to_clipboard |= copy;
                row.excluded_from_stats &= excluded;
                row.relay_only &= policy.paused;
                row.skip_overlay &= skip_overlay;
                row.metadata = metadata;
                if row.stats_status == "pending" {
                    row.stats_status = "pending_manual";
                }
                (row, false)
            }
            other => {
                let (action, reason, _) = other.wire();
                let matched = if action == "duplicate_open" {
                    open
                } else {
                    newest
                }
                .expect("matched row exists");
                ack["status"] = json!("duplicate");
                ack["reason"] = json!(reason);
                ack["matched_source"] = json!(matched.source_kind);
                complete(&mut ack, matched);
                if source_kind == "ocr" && matched.source_kind == "texthook" && self.echoes < 3 {
                    self.echoes += 1;
                    if self.echoes == 3 {
                        events.push(Event::Redundant);
                    }
                }
                return ack;
            }
        };
        if speech {
            let ms = field(payload, &["revision_window_ms", "revisionWindowMs"])
                .as_i64()
                .unwrap_or(100)
                .max(0);
            self.speech = Some((
                row.line_id.clone(),
                now.ns.saturating_add(ms.saturating_mul(1_000_000)),
            ));
        }
        let row = self.publish(row, append, Some(now.ns));
        events.push(if append {
            Event::Append(row.clone())
        } else {
            Event::Update(row.clone())
        });
        self.landing = None;
        if track {
            self.observe_skip(&row, &processed, now, events);
        }
        ack["status"] = json!("accepted");
        complete(&mut ack, &row);
        ack
    }
}
fn complete(ack: &mut Value, row: &Record) {
    ack["line_id"] = json!(row.line_id);
    ack["stream_sequence"] = json!(row.stream_sequence);
    ack["revision"] = json!(row.revision);
}
