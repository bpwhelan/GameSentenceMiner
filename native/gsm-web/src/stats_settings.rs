use crate::{Reply, Reports};
use chrono::{NaiveDate, NaiveTime};
use gsm_history::ReportCleaner;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const PUBLIC_FIELDS: &[&str] = &[
    "session_gap_seconds",
    "day_rollover_hour",
    "streak_requirement_hours",
    "reading_hours_target",
    "character_count_target",
    "games_target",
    "reading_hours_target_date",
    "character_count_target_date",
    "games_target_date",
    "cards_mined_daily_target",
    "regex_out_punctuation",
    "regex_out_repetitions",
    "extra_punctuation_regex",
    "tadoku_username",
    "tadoku_language_code",
    "tadoku_title_source",
    "tadoku_daily_sync_enabled",
    "tadoku_daily_sync_time",
    "tadoku_daily_sync_deduplicate",
    "tadoku_daily_sync_game_ids",
];
const DAYS: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

fn configured(stats: &Value) -> bool {
    ["tadoku_username", "tadoku_password"]
        .iter()
        .all(|key| stats[key].as_str().is_some_and(|s| !s.is_empty()))
}

pub(super) fn public_view(stats: &Value) -> Value {
    let defaults = gsm_settings::default_stats();
    let mut public = Map::new();
    for &key in PUBLIC_FIELDS {
        let value = stats
            .get(key)
            .filter(|v| !v.is_null())
            .unwrap_or(&defaults[key]);
        public.insert(key.into(), value.clone());
    }
    public.insert("tadoku_configured".into(), json!(configured(stats)));
    for &day in DAYS {
        let value = stats["easy_days_settings"]
            .get(day)
            .and_then(Value::as_i64)
            .unwrap_or(100);
        public.insert(format!("easy_days_{day}"), json!(value));
    }
    Value::Object(public)
}

#[derive(Default)]
struct Changes {
    fields: Map<String, Value>,
    days: Map<String, Value>,
}

enum Validation {
    Invalid(String),
    Compatibility,
}

impl From<String> for Validation {
    fn from(error: String) -> Self {
        Self::Invalid(error)
    }
}

impl From<&str> for Validation {
    fn from(error: &str) -> Self {
        Self::Invalid(error.into())
    }
}

fn integer(v: &Value, label: &str, min: i64, max: i64, bounds: &str) -> Result<Value, Validation> {
    let number = match v {
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => n.as_f64().map(|n| n as i64),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .ok_or_else(|| format!("{label} must be a valid integer"))?;
    if !(min..=max).contains(&number) {
        return Err(format!("{label} must be between {bounds}").into());
    }
    Ok(json!(number))
}

fn boolean(v: &Value, key: &str) -> Result<bool, Validation> {
    v.as_bool()
        .ok_or_else(|| format!("{key} must be a boolean value").into())
}

fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, Validation> {
    v.as_str()
        .ok_or_else(|| format!("{key} must be a string value").into())
}

fn validate_punctuation(pattern: &str) -> Result<(), Validation> {
    if ReportCleaner::compile(pattern, false).is_some() {
        return Ok(());
    }
    // Python regex also accepts extensions such as nested sets, fuzzy bounds
    // and inline flags. An unfamiliar dialect must reach its original parser
    // before anything else from the same request is written.
    let mut in_class = false;
    let mut previous_quantifier = false;
    for ch in pattern.chars() {
        match ch {
            '\\' | '{' | '}' | ':' | '&' | '~' => return Err(Validation::Compatibility),
            '[' if in_class => return Err(Validation::Compatibility),
            '[' => in_class = true,
            ']' => in_class = false,
            _ => {}
        }
        let quantifier = !in_class && matches!(ch, '*' | '+' | '?');
        if previous_quantifier && quantifier {
            return Err(Validation::Compatibility);
        }
        previous_quantifier = quantifier;
    }
    if pattern.contains("(?")
        || pattern.contains("--")
        || pattern.contains("[]")
        || pattern.contains("[^]")
    {
        return Err(Validation::Compatibility);
    }
    regex::Regex::new(pattern)
        .map(|_| ())
        .map_err(|error| match error {
            regex::Error::Syntax(_) => {
                Validation::Invalid("extra_punctuation_regex must be a valid regex".into())
            }
            _ => Validation::Compatibility,
        })
}

impl Changes {
    fn parse(body: &Value) -> Result<Self, Validation> {
        if body.as_object().is_none_or(|m| m.is_empty()) {
            return Err("No data provided".into());
        }
        let mut changes = Self::default();
        let fields = &mut changes.fields;
        for (key, label, min, max, bounds) in [
            (
                "session_gap_seconds",
                "Session gap",
                0,
                7200,
                "0 and 7200 seconds (0 to 2 hours)",
            ),
            ("day_rollover_hour", "Day rollover hour", 0, 23, "0 and 23"),
            (
                "reading_hours_target",
                "Reading hours target",
                1,
                10000,
                "1 and 10,000 hours",
            ),
            (
                "character_count_target",
                "Character count target",
                1000,
                1_000_000_000,
                "1,000 and 1,000,000,000 characters",
            ),
            ("games_target", "Games target", 1, 1000, "1 and 1,000"),
            (
                "cards_mined_daily_target",
                "Cards mined daily target",
                0,
                1000,
                "0 and 1,000",
            ),
        ] {
            if !body[key].is_null() {
                fields.insert(key.into(), integer(&body[key], label, min, max, bounds)?);
            }
        }
        let streak = &body["streak_requirement_hours"];
        if !streak.is_null() {
            let value = streak
                .as_f64()
                .or_else(|| streak.as_str()?.trim().parse().ok())
                .or_else(|| streak.as_bool().map(|b| i64::from(b) as f64))
                .ok_or("Streak requirement must be a valid number")?;
            if !(0.01..=24.0).contains(&value) {
                return Err("Streak requirement must be between 0.01 and 24 hours".into());
            }
            fields.insert("streak_requirement_hours".into(), json!(value));
        }
        for (key, label) in [
            ("reading_hours_target_date", "Reading hours"),
            ("character_count_target_date", "Character count"),
            ("games_target_date", "Games"),
        ] {
            if body[key].is_null() {
                continue;
            }
            let valid = body[key].as_str().is_some_and(|s| {
                s.is_empty()
                    || (s
                        .split('-')
                        .next()
                        .is_some_and(|year| year.len() == 4 && year != "0000")
                        && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok())
            });
            if !valid {
                return Err(format!("{label} target date must be in YYYY-MM-DD format").into());
            }
            fields.insert(key.into(), body[key].clone());
        }
        for key in [
            "regex_out_punctuation",
            "regex_out_repetitions",
            "tadoku_daily_sync_enabled",
            "tadoku_daily_sync_deduplicate",
        ] {
            if !body[key].is_null() {
                fields.insert(key.into(), json!(boolean(&body[key], key)?));
            }
        }
        let key = "extra_punctuation_regex";
        if !body[key].is_null() {
            let pattern = string(&body[key], key)?.trim();
            if pattern.chars().count() > 500 {
                return Err("extra_punctuation_regex must be 500 characters or fewer".into());
            }
            validate_punctuation(pattern)?;
            fields.insert(key.into(), json!(pattern));
        }
        for (key, limit, error) in [
            ("tadoku_username", 320, "Tadoku email is too long"),
            ("tadoku_password", 1024, "Tadoku password is too long"),
        ] {
            if body[key].is_null() {
                continue;
            }
            let value = string(&body[key], key)?;
            let value = if key == "tadoku_username" {
                value.trim()
            } else {
                value
            };
            if value.chars().count() > limit {
                return Err(error.into());
            }
            if key != "tadoku_password" || !value.is_empty() {
                fields.insert(key.into(), json!(value));
            }
        }
        let key = "tadoku_clear_credentials";
        if !body[key].is_null() && boolean(&body[key], key)? {
            fields.insert("tadoku_username".into(), json!(""));
            fields.insert("tadoku_password".into(), json!(""));
        }
        let key = "tadoku_language_code";
        if !body[key].is_null() {
            let code = body[key]
                .as_str()
                .map(str::trim)
                .filter(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_alphabetic()))
                .ok_or("Tadoku language code must be a three-letter ISO 639-3 code")?;
            fields.insert(key.into(), json!(code.to_ascii_lowercase()));
        }
        let key = "tadoku_title_source";
        if !body[key].is_null() {
            if !matches!(body[key].as_str(), Some("english" | "original" | "romaji")) {
                return Err("Tadoku title source must be english, original, or romaji".into());
            }
            fields.insert(key.into(), body[key].clone());
        }
        let key = "tadoku_daily_sync_time";
        if !body[key].is_null() {
            if !body[key].as_str().is_some_and(|s| {
                s.len() == 5
                    && s.as_bytes()[2] == b':'
                    && s.bytes()
                        .enumerate()
                        .all(|(i, b)| i == 2 || b.is_ascii_digit())
                    && NaiveTime::parse_from_str(s, "%H:%M").is_ok()
            }) {
                return Err("Tadoku automatic sync time must use HH:MM format".into());
            }
            fields.insert(key.into(), body[key].clone());
        }
        let key = "tadoku_daily_sync_game_ids";
        if !body[key].is_null() {
            let error = "Tadoku automatic sync game whitelist must contain valid game IDs";
            let ids = body[key]
                .as_array()
                .filter(|v| v.len() <= 1000)
                .ok_or(error)?;
            let mut seen = HashSet::new();
            let mut list = Vec::new();
            for id in ids {
                let id = id
                    .as_str()
                    .map(str::trim)
                    .filter(|id| !id.is_empty() && id.chars().count() <= 512)
                    .ok_or(error)?;
                if seen.insert(id) {
                    list.push(id);
                }
            }
            fields.insert(key.into(), json!(list));
        }
        for &day in DAYS {
            let value = &body[format!("easy_days_{day}")];
            if !value.is_null() {
                let label = format!("{}{} easy days setting", day[..1].to_uppercase(), &day[1..]);
                changes
                    .days
                    .insert(day.into(), integer(value, &label, 0, 100, "0 and 100")?);
            }
        }
        if fields.is_empty() && changes.days.is_empty() {
            return Err("No valid settings provided".into());
        }
        Ok(changes)
    }

    fn save(mut self, reports: &Reports) -> Result<Reply, String> {
        let reschedule = self.fields.contains_key("tadoku_daily_sync_enabled")
            || self.fields.contains_key("tadoku_daily_sync_time");
        gsm_settings::with_lock(&reports.config, || {
            let mut root = gsm_settings::read_object(&reports.config)?;
            let stats = &mut root["stats"];
            if stats.is_null() {
                *stats = json!({});
            }
            if !stats.is_object() {
                return Err("Expected a stats settings object".into());
            }
            let reset_cookie = self.fields.contains_key("tadoku_password")
                || self
                    .fields
                    .get("tadoku_username")
                    .is_some_and(|u| u != &stats["tadoku_username"]);
            let mut changed = false;
            for (key, value) in &self.fields {
                if stats[key] != *value {
                    stats[key] = value.clone();
                    changed = true;
                }
            }
            if reset_cookie && stats["tadoku_session_cookie"] != "" {
                stats["tadoku_session_cookie"] = json!("");
                changed = true;
            }
            if !self.days.is_empty() {
                let days = &mut stats["easy_days_settings"];
                if days.is_null() {
                    *days = json!({});
                }
                if !days.is_object() {
                    return Err("Expected an easy days settings object".into());
                }
                for (key, value) in self.days {
                    if days[&key] != value {
                        days[key] = value;
                        changed = true;
                    }
                }
            }
            let has_credentials = configured(stats);
            if changed {
                gsm_settings::write_atomic(&reports.config, &root)?;
            }
            if reschedule {
                reports
                    .history
                    .configure_tadoku(&reports.database, &root["stats"])
                    .map_err(|e| e.to_string())?;
            }
            self.fields.remove("tadoku_password");
            self.fields
                .insert("message".into(), json!("Settings saved successfully"));
            self.fields
                .insert("tadoku_configured".into(), json!(has_credentials));
            Ok(Reply {
                status: 200,
                body: Value::Object(self.fields),
            })
        })
    }
}

impl Reports {
    pub fn save_stats_settings(&self, body: Value) -> Option<Reply> {
        let changes = match Changes::parse(&body) {
            Ok(changes) => changes,
            Err(Validation::Invalid(error)) => return Some(Reply::error(400, &error)),
            Err(Validation::Compatibility) => return None,
        };
        let reply = changes
            .save(self)
            .unwrap_or_else(|_| Reply::error(500, "Failed to save settings"));
        *self.preferences.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Some(reply)
    }
}
