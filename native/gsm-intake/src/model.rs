use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use gsm_text_preview::correlation::Line;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Clone, Deserialize)]
#[serde(default)]
pub struct Policy {
    pub max_chars: usize,
    pub processing: Arc<Value>,
    pub language: String,
    pub scene: String,
    pub remove_prefix: bool,
    pub paused: bool,
    pub relay: bool,
    pub benchmark: bool,
    pub exclusions: HashMap<String, HashSet<String>>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            max_chars: 3000,
            processing: Arc::new(Value::Null),
            language: String::new(),
            scene: String::new(),
            remove_prefix: true,
            paused: false,
            relay: true,
            benchmark: false,
            exclusions: HashMap::new(),
        }
    }
}

#[derive(Clone, Copy)]
pub struct Clock {
    pub wall: DateTime<Utc>,
    pub ns: i64,
}
impl Clock {
    pub fn at(ns: i64) -> Self {
        Self {
            wall: DateTime::from_timestamp_nanos(ns),
            ns,
        }
    }
}

pub(super) fn captured(value: &Value, fallback: DateTime<Utc>) -> DateTime<Utc> {
    if let Some(num) = value.as_f64() {
        let micros = num
            * if num > 10_000_000_000.0 {
                1000.0
            } else {
                1_000_000.0
            };
        return DateTime::from_timestamp_micros(micros.round() as i64).unwrap_or(fallback);
    }
    let Some(s) = value.as_str() else {
        return fallback;
    };
    let s = s.trim();
    if let Ok(stamp) = DateTime::parse_from_rfc3339(s) {
        return stamp.to_utc();
    }
    ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"]
        .iter()
        .find_map(|fmt| NaiveDateTime::parse_from_str(s, fmt).ok())
        .and_then(|d| Local.from_local_datetime(&d).earliest())
        .map(|d| d.to_utc())
        .unwrap_or(fallback)
}

pub(super) fn kind(source: &str, display: &str) -> &'static str {
    match source
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .as_str()
    {
        "texthook" | "luna" | "hooker" | "textractor" => "texthook",
        "speech"
        | "speech_recognition"
        | "windows_speech"
        | "windows_speech_recognition"
        | "mssr" => "speech_recognition",
        "manual" => "manual",
        "ocr" => "ocr",
        "ocr_manual" => "ocr_manual",
        "screen_cropper" => "screen_cropper",
        "hotkey" => "hotkey",
        "secondary" => "secondary",
        "overlay" => "overlay",
        "clipboard" => "clipboard",
        "websocket" => "websocket",
        _ => {
            let label = display.to_ascii_lowercase();
            if ["hook", "luna", "textractor"]
                .iter()
                .any(|s| label.contains(s))
            {
                "texthook"
            } else if label.contains("clipboard") {
                "clipboard"
            } else if label.contains("ocr") {
                "ocr"
            } else if label.contains("speech") && label.contains("recogn") {
                "speech_recognition"
            } else if source.is_empty() {
                "unknown"
            } else {
                "websocket"
            }
        }
    }
}

pub(super) fn automatic(kind: &str) -> bool {
    matches!(
        kind,
        "texthook" | "ocr" | "clipboard" | "websocket" | "overlay" | "unknown"
    )
}

#[derive(Clone, Serialize)]
pub struct Record {
    pub line_id: String,
    pub session_id: Arc<str>,
    pub stream_sequence: u64,
    pub revision: u64,
    pub state: &'static str,
    pub raw_text: Arc<str>,
    pub text: Arc<str>,
    pub source_kind: &'static str,
    pub source_instance: Arc<str>,
    pub source_display_name: Arc<str>,
    pub observation_ids: Vec<Arc<str>>,
    pub captured_at_utc: DateTime<Utc>,
    pub first_seen_at_utc: DateTime<Utc>,
    pub first_seen_monotonic_ns: i64,
    pub finalized_at_utc: Option<DateTime<Utc>>,
    pub stats_status: &'static str,
    pub scene: Arc<str>,
    pub copy_to_clipboard: bool,
    pub excluded_from_stats: bool,
    pub relay_only: bool,
    pub skip_overlay: bool,
    pub metadata: Arc<Value>,
}

impl Record {
    pub(super) fn line(&self) -> Line<'_> {
        Line {
            text: &self.text,
            source: self.source_kind,
            instance: &self.source_instance,
            scene: &self.scene,
            first_ns: self.first_seen_monotonic_ns,
            relay: self.relay_only,
            frozen: self.state == "frozen",
            skipped: self.stats_status == "skipped",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "record")]
pub enum Event {
    #[serde(rename = "append")]
    Append(Arc<Record>),
    #[serde(rename = "update")]
    Update(Arc<Record>),
    #[serde(rename = "freeze")]
    Freeze(Arc<Record>),
    #[serde(rename = "expire")]
    Expire(Arc<Record>),
    #[serde(rename = "stats_ready")]
    StatsReady(Arc<Record>),
    #[serde(rename = "stats_excluded")]
    StatsExcluded(Arc<Record>),
    #[serde(rename = "skip_started")]
    SkipStarted(Arc<Record>),
    #[serde(rename = "skip_ended")]
    SkipEnded(Arc<Record>),
    #[serde(rename = "benchmark")]
    Benchmark(Value),
    #[serde(rename = "redundant")]
    Redundant,
}

pub(super) fn field<'a>(p: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .find_map(|k| p.get(k).filter(|v| !v.is_null()))
        .unwrap_or(&Value::Null)
}

pub fn guard(text: &str, limit: usize) -> Result<&str, &'static str> {
    let limit = if limit == 0 { 3000 } else { limit.min(100_000) };
    let (mut open, mut close, mut end) = (0, 0, text.len());
    for (n, (i, c)) in text.char_indices().enumerate() {
        if n == limit {
            end = i
        }
        match c {
            '「' => open += 1,
            '」' => close += 1,
            _ => {}
        }
        if open > 10 && close > 10 {
            return Err("too many Japanese quote pairs");
        }
    }
    Ok(&text[..end])
}
