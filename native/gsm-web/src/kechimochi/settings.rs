use super::client::{normalize, DEFAULT_URL};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Serialize)]
pub(super) struct Settings {
    pub url: String,
    pub enabled: bool,
    pub schedule: String,
    pub sync_time: String,
    pub include_external_stats: bool,
    pub sync_covers: bool,
    pub adopt_matching_logs: bool,
}
const FIELDS: &[(&str, &str)] = &[
    ("url", "kechimochi_url"),
    ("enabled", "kechimochi_sync_enabled"),
    ("schedule", "kechimochi_sync_schedule"),
    ("sync_time", "kechimochi_sync_time"),
    (
        "include_external_stats",
        "kechimochi_include_external_stats",
    ),
    ("sync_covers", "kechimochi_sync_covers"),
    ("adopt_matching_logs", "kechimochi_adopt_matching_logs"),
];
impl Settings {
    pub fn read(stats: &Value) -> Self {
        Self {
            url: stats["kechimochi_url"]
                .as_str()
                .unwrap_or(DEFAULT_URL)
                .into(),
            enabled: stats["kechimochi_sync_enabled"] == true,
            schedule: stats["kechimochi_sync_schedule"]
                .as_str()
                .unwrap_or("quarter_hourly")
                .into(),
            sync_time: stats["kechimochi_sync_time"]
                .as_str()
                .unwrap_or("00:05")
                .into(),
            include_external_stats: stats["kechimochi_include_external_stats"]
                .as_bool()
                .unwrap_or(true),
            sync_covers: stats["kechimochi_sync_covers"].as_bool().unwrap_or(true),
            adopt_matching_logs: stats["kechimochi_adopt_matching_logs"] == true,
        }
    }
    pub fn validate(data: &Value) -> std::result::Result<Value, String> {
        let map = data
            .as_object()
            .ok_or("Expected Kechimochi sync settings")?;
        let mut updates = json!({});
        for (key, value) in map {
            let &(_, field) = FIELDS
                .iter()
                .find(|(name, _)| name == key)
                .ok_or("Expected Kechimochi sync settings")?;
            updates[field] = match key.as_str() {
                "url" => normalize(value)?.into(),
                "schedule"
                    if !matches!(value.as_str(), Some("quarter_hourly" | "hourly" | "daily")) =>
                {
                    return Err("Choose a 15-minute, hourly, or daily sync schedule".into())
                }
                "sync_time"
                    if !value.as_str().is_some_and(|s| {
                        s.len() == 5
                            && s.as_bytes()[2] == b':'
                            && chrono::NaiveTime::parse_from_str(s, "%H:%M").is_ok()
                    }) =>
                {
                    return Err("Sync time must be a local time in HH:MM format".into())
                }
                "schedule" | "sync_time" => value.clone(),
                _ => Value::Bool(
                    value
                        .as_bool()
                        .ok_or_else(|| format!("{key} must be true or false"))?,
                ),
            };
        }
        Ok(updates)
    }
}
