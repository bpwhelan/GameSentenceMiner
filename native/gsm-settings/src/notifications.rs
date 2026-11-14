//! Notification preferences, legacy migration, sound tones, and delivery resolution.
use crate::preferences::Preferences;
use crate::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Map, Value};

pub const NOTIFICATION_SOUNDS: [&str; 14] = [
    "soft-ping",
    "bell",
    "bubble",
    "wood",
    "glass",
    "success",
    "ascending",
    "descending",
    "double-tap",
    "chime",
    "pause-resume",
    "marimba",
    "sparkle",
    "low-knock",
];

pub const NOTIFICATION_MODES: [&str; 4] = ["off", "sound", "banner", "both"];

pub const NOTIFICATION_CATEGORY_IDS: [&str; 4] =
    ["confirmation", "cardError", "pauseResume", "appAlert"];

#[derive(Clone, Copy)]
pub struct NotificationCategoryDefault {
    pub id: &'static str,
    pub mode: &'static str,
    pub sound: &'static str,
    pub legacy_events: &'static [&'static str],
}

pub const NOTIFICATION_CATEGORIES: [NotificationCategoryDefault; 4] = [
    NotificationCategoryDefault {
        id: "confirmation",
        mode: "sound",
        sound: "soft-ping",
        legacy_events: &[
            "AnkiCardUpdated",
            "AudioGenerated",
            "ScreenshotSaved",
            "GSMReady",
        ],
    },
    NotificationCategoryDefault {
        id: "cardError",
        mode: "banner",
        sound: "double-tap",
        legacy_events: &["AnkiEnhancementFailed"],
    },
    NotificationCategoryDefault {
        id: "pauseResume",
        mode: "sound",
        sound: "pause-resume",
        legacy_events: &["GSMTextIntakePaused", "GSMTextIntakeResumed"],
    },
    NotificationCategoryDefault {
        id: "appAlert",
        mode: "banner",
        sound: "double-tap",
        legacy_events: &["Error", "CheckOBS", "PendingSessionReviews"],
    },
];

#[derive(Clone, Copy)]
pub struct NotificationEventMeta {
    pub id: &'static str,
    pub feature: Option<&'static str>,
    pub category: &'static str,
}

pub const NOTIFICATION_EVENTS: [NotificationEventMeta; 12] = [
    NotificationEventMeta {
        id: "AnkiCardUpdated",
        feature: Some("notify_on_update"),
        category: "confirmation",
    },
    NotificationEventMeta {
        id: "AudioGenerated",
        feature: Some("notify_on_audio_generated"),
        category: "confirmation",
    },
    NotificationEventMeta {
        id: "ScreenshotSaved",
        feature: Some("notify_on_screenshot_saved"),
        category: "confirmation",
    },
    NotificationEventMeta {
        id: "GSMTextIntakePaused",
        feature: Some("notify_on_text_intake_state"),
        category: "pauseResume",
    },
    NotificationEventMeta {
        id: "GSMTextIntakeResumed",
        feature: Some("notify_on_text_intake_state"),
        category: "pauseResume",
    },
    NotificationEventMeta {
        id: "OCRPaused",
        feature: None,
        category: "pauseResume",
    },
    NotificationEventMeta {
        id: "OCRResumed",
        feature: None,
        category: "pauseResume",
    },
    NotificationEventMeta {
        id: "AnkiEnhancementFailed",
        feature: Some("notify_on_anki_enhancement_failed"),
        category: "cardError",
    },
    NotificationEventMeta {
        id: "CheckOBS",
        feature: Some("notify_on_obs_warning"),
        category: "appAlert",
    },
    NotificationEventMeta {
        id: "Error",
        feature: Some("notify_on_errors"),
        category: "appAlert",
    },
    NotificationEventMeta {
        id: "GSMReady",
        feature: None,
        category: "confirmation",
    },
    NotificationEventMeta {
        id: "PendingSessionReviews",
        feature: None,
        category: "appAlert",
    },
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NotificationToneSpec {
    pub frequency: f32,
    pub duration: f32,
    pub delay: f32,
    pub end_frequency: Option<f32>,
    pub harmonic: Option<f32>,
}

impl NotificationToneSpec {
    const fn tone(frequency: f32, duration: f32) -> Self {
        Self {
            frequency,
            duration,
            delay: 0.0,
            end_frequency: None,
            harmonic: None,
        }
    }

    const fn with_delay(mut self, delay: f32) -> Self {
        self.delay = delay;
        self
    }

    const fn with_end(mut self, end_frequency: f32) -> Self {
        self.end_frequency = Some(end_frequency);
        self
    }

    const fn with_harmonic(mut self, harmonic: f32) -> Self {
        self.harmonic = Some(harmonic);
        self
    }

    pub fn to_value(self) -> Value {
        let mut object = Map::new();
        object.insert("frequency".into(), json!(self.frequency));
        object.insert("duration".into(), json!(self.duration));
        if self.delay != 0.0 {
            object.insert("delay".into(), json!(self.delay));
        }
        if let Some(end_frequency) = self.end_frequency {
            object.insert("endFrequency".into(), json!(end_frequency));
        }
        if let Some(harmonic) = self.harmonic {
            object.insert("harmonic".into(), json!(harmonic));
        }
        Value::Object(object)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotificationDelivery {
    pub banner: bool,
    pub sound: Option<&'static str>,
}

pub fn is_notification_sound(value: &str) -> bool {
    NOTIFICATION_SOUNDS.contains(&value)
}

pub fn canonical_notification_sound(value: &str) -> Option<&'static str> {
    NOTIFICATION_SOUNDS.iter().copied().find(|s| *s == value)
}

fn canonical_notification_mode(value: &str) -> Option<&'static str> {
    NOTIFICATION_MODES.iter().copied().find(|m| *m == value)
}

pub fn normalize_notification_volume(value: Option<&Value>) -> u8 {
    let Some(num) = value.and_then(Value::as_f64).filter(|v| v.is_finite()) else {
        return 15;
    };
    num.round().clamp(0.0, 100.0) as u8
}

pub fn normalize_notification_preferences(value: Option<&Value>) -> Value {
    let input = value.and_then(Value::as_object);
    let categories_obj = input.and_then(|o| o.get("categories")).and_then(Value::as_object);
    let legacy_events = input.and_then(|o| o.get("events")).and_then(Value::as_object);

    let mut normalized_categories = Map::new();
    for defaults in NOTIFICATION_CATEGORIES {
        let explicit = categories_obj
            .and_then(|cats| cats.get(defaults.id))
            .filter(|v| v.is_object());
        let legacy = legacy_events.and_then(|events| {
            defaults
                .legacy_events
                .iter()
                .filter_map(|event_name| events.get(*event_name))
                .find(|candidate| {
                    candidate
                        .as_object()
                        .is_some_and(|map| !map.is_empty())
                })
        });
        let preference = explicit.or(legacy).and_then(Value::as_object);

        let mode = preference
            .and_then(|p| p.get("mode"))
            .and_then(Value::as_str)
            .and_then(canonical_notification_mode)
            .unwrap_or(defaults.mode);

        let sound = preference
            .and_then(|p| p.get("sound"))
            .and_then(Value::as_str)
            .and_then(canonical_notification_sound)
            .filter(|candidate| *candidate != "pause-resume" || defaults.id == "pauseResume")
            .unwrap_or(defaults.sound);

        normalized_categories.insert(
            defaults.id.to_owned(),
            json!({
                "mode": mode,
                "sound": sound,
            }),
        );
    }

    json!({
        "volume": normalize_notification_volume(input.and_then(|o| o.get("volume"))),
        "categories": normalized_categories,
    })
}

pub fn migrate_legacy_notification_preferences(
    value: Option<&Value>,
    legacy_features: Option<&Value>,
) -> Value {
    let mut preferences = normalize_notification_preferences(value);
    let Some(features) = legacy_features.and_then(Value::as_object) else {
        return preferences;
    };

    if let Some(cats) = preferences
        .get_mut("categories")
        .and_then(Value::as_object_mut)
    {
        for event in NOTIFICATION_EVENTS {
            if let Some(feature) = event.feature {
                if features.get(feature).and_then(Value::as_bool) == Some(false) {
                    if let Some(cat) = cats.get_mut(event.category).and_then(Value::as_object_mut) {
                        cat.insert("mode".into(), json!("off"));
                    }
                }
            }
        }
        if features
            .get("review_after_session")
            .and_then(Value::as_object)
            .and_then(|review| review.get("notify_on_startup"))
            .and_then(Value::as_bool)
            == Some(false)
        {
            if let Some(app_alert) = cats.get_mut("appAlert").and_then(Value::as_object_mut) {
                app_alert.insert("mode".into(), json!("off"));
            }
        }
    }

    preferences
}

pub fn notification_tones(sound: &str) -> Option<&'static [NotificationToneSpec]> {
    const SOFT_PING: &[NotificationToneSpec] = &[NotificationToneSpec::tone(880.0, 0.24)];
    const BELL: &[NotificationToneSpec] =
        &[NotificationToneSpec::tone(660.0, 0.48).with_harmonic(2.76)];
    const BUBBLE: &[NotificationToneSpec] =
        &[NotificationToneSpec::tone(420.0, 0.15).with_end(960.0)];
    const WOOD: &[NotificationToneSpec] =
        &[NotificationToneSpec::tone(360.0, 0.07).with_harmonic(1.48)];
    const GLASS: &[NotificationToneSpec] =
        &[NotificationToneSpec::tone(1320.0, 0.32).with_harmonic(2.01)];
    const SUCCESS: &[NotificationToneSpec] = &[
        NotificationToneSpec::tone(660.0, 0.16),
        NotificationToneSpec::tone(880.0, 0.26).with_delay(0.12),
    ];
    const ASCENDING: &[NotificationToneSpec] = &[
        NotificationToneSpec::tone(523.25, 0.15),
        NotificationToneSpec::tone(783.99, 0.22).with_delay(0.1),
    ];
    const DESCENDING: &[NotificationToneSpec] = &[
        NotificationToneSpec::tone(783.99, 0.15),
        NotificationToneSpec::tone(523.25, 0.22).with_delay(0.1),
    ];
    const DOUBLE_TAP: &[NotificationToneSpec] = &[
        NotificationToneSpec::tone(520.0, 0.08),
        NotificationToneSpec::tone(520.0, 0.08).with_delay(0.13),
    ];
    const CHIME: &[NotificationToneSpec] = &[
        NotificationToneSpec::tone(523.25, 0.32),
        NotificationToneSpec::tone(659.25, 0.32).with_delay(0.1),
        NotificationToneSpec::tone(783.99, 0.42).with_delay(0.2),
    ];
    const MARIMBA: &[NotificationToneSpec] = &[
        NotificationToneSpec::tone(392.0, 0.14).with_harmonic(4.0),
        NotificationToneSpec::tone(523.25, 0.23)
            .with_delay(0.08)
            .with_harmonic(4.0),
    ];
    const SPARKLE: &[NotificationToneSpec] = &[
        NotificationToneSpec::tone(1046.5, 0.11),
        NotificationToneSpec::tone(1318.51, 0.13).with_delay(0.06),
        NotificationToneSpec::tone(1567.98, 0.24).with_delay(0.12),
    ];
    const LOW_KNOCK: &[NotificationToneSpec] = &[NotificationToneSpec::tone(340.0, 0.13)
        .with_end(180.0)
        .with_harmonic(2.3)];
    const PAUSE_RESUME: &[NotificationToneSpec] = &[
        NotificationToneSpec::tone(783.99, 0.15),
        NotificationToneSpec::tone(523.25, 0.22).with_delay(0.1),
        NotificationToneSpec::tone(523.25, 0.15).with_delay(0.5),
        NotificationToneSpec::tone(783.99, 0.22).with_delay(0.6),
    ];

    match sound {
        "soft-ping" => Some(SOFT_PING),
        "bell" => Some(BELL),
        "bubble" => Some(BUBBLE),
        "wood" => Some(WOOD),
        "glass" => Some(GLASS),
        "success" => Some(SUCCESS),
        "ascending" => Some(ASCENDING),
        "descending" => Some(DESCENDING),
        "double-tap" => Some(DOUBLE_TAP),
        "chime" => Some(CHIME),
        "marimba" => Some(MARIMBA),
        "sparkle" => Some(SPARKLE),
        "low-knock" => Some(LOW_KNOCK),
        "pause-resume" => Some(PAUSE_RESUME),
        _ => None,
    }
}

pub fn playback_payload(sound: &str, volume: u8) -> Result<Value> {
    let tones = notification_tones(sound).ok_or("Unknown notification sound.")?;
    let serialized: Vec<Value> = tones.iter().copied().map(NotificationToneSpec::to_value).collect();
    Ok(json!({
        "tones": serialized,
        "volume": volume.min(100),
    }))
}

pub fn resolve_notification_delivery(
    event: &str,
    preferences: &Value,
) -> Result<NotificationDelivery> {
    let meta = NOTIFICATION_EVENTS
        .iter()
        .find(|entry| entry.id == event)
        .ok_or_else(|| format!("Unknown notification event: {event}"))?;
    let normalized = normalize_notification_preferences(Some(preferences));
    let cat = &normalized["categories"][meta.category];
    let mode = cat["mode"].as_str().unwrap_or("off");
    let sound = cat["sound"]
        .as_str()
        .and_then(canonical_notification_sound)
        .unwrap_or("soft-ping");
    let resolved_sound = if sound == "pause-resume" {
        if event.ends_with("Paused") {
            "descending"
        } else {
            "ascending"
        }
    } else {
        sound
    };
    let volume = normalized["volume"].as_u64().unwrap_or(15);
    Ok(NotificationDelivery {
        banner: mode == "banner" || mode == "both",
        sound: if volume > 0 && (mode == "sound" || mode == "both") {
            Some(resolved_sound)
        } else {
            None
        },
    })
}

/// Reads and migrates notification preferences atomically inside `electron/config.json`.
pub fn get_notification_preferences(
    preferences: &Preferences,
    legacy_features: impl FnOnce() -> Value,
) -> Result<Value> {
    let file = &preferences.file;
    with_lock(file, || {
        let mut document = read_object(file)?;
        let migration_version = document
            .get("notificationPreferencesMigrationVersion")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if migration_version < 2 {
            let current = document.get("notificationPreferences");
            let mut migrated = if migration_version < 1 {
                let legacy = legacy_features();
                migrate_legacy_notification_preferences(current, Some(&legacy))
            } else {
                normalize_notification_preferences(current)
            };
            if let Some(pause_sound) = migrated
                .get("categories")
                .and_then(|c| c.get("pauseResume"))
                .and_then(|p| p.get("sound"))
                .and_then(Value::as_str)
            {
                if matches!(pause_sound, "soft-ping" | "descending" | "ascending") {
                    migrated["categories"]["pauseResume"]["sound"] = json!("pause-resume");
                }
            }
            if let Some(map) = document.as_object_mut() {
                map.insert("notificationPreferences".into(), migrated.clone());
                map.insert("notificationPreferencesMigrationVersion".into(), json!(2));
            }
            write_atomic(file, &document)?;
            return Ok(migrated);
        }
        Ok(normalize_notification_preferences(
            document.get("notificationPreferences"),
        ))
    })
}

/// Saves normalized notification preferences atomically inside `electron/config.json`.
pub fn save_notification_preferences(
    preferences: &Preferences,
    input: &Value,
    legacy_features: impl FnOnce() -> Value,
) -> Result<Value> {
    // Run any pending one-time migration first so migration version reaches 2 cleanly.
    let _ = get_notification_preferences(preferences, legacy_features)?;
    let normalized = normalize_notification_preferences(Some(input));
    preferences.patch(&json!({
        "notificationPreferences": normalized.clone(),
        "notificationPreferencesMigrationVersion": 2,
    }))?;
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn migrates_disabled_python_switches_once_and_preserves_subsequent_edits() {
        let dir = tempdir().unwrap();
        let prefs = Preferences::new(dir.path());
        let mut calls = 0;

        let migrated = get_notification_preferences(&prefs, || {
            calls += 1;
            json!({
                "notify_on_audio_generated": false,
                "notify_on_anki_enhancement_failed": false,
            })
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(migrated["categories"]["confirmation"]["mode"], json!("off"));
        assert_eq!(migrated["categories"]["cardError"]["mode"], json!("off"));

        let saved = save_notification_preferences(
            &prefs,
            &json!({
                "volume": 12,
                "categories": {
                    "confirmation": { "mode": "sound", "sound": "bell" }
                }
            }),
            || {
                calls += 1;
                json!({ "notify_on_text_intake_state": false })
            },
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(saved["volume"], json!(12));
        assert_eq!(
            saved["categories"]["confirmation"],
            json!({ "mode": "sound", "sound": "bell" })
        );

        let reloaded = get_notification_preferences(&prefs, || {
            calls += 1;
            json!({})
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(reloaded, saved);
    }

    #[test]
    fn restores_paired_pause_resume_tones_for_v1_only_once() {
        let dir = tempdir().unwrap();
        let prefs = Preferences::new(dir.path());
        prefs
            .patch(&json!({
                "notificationPreferencesMigrationVersion": 1,
                "notificationPreferences": {
                    "categories": {
                        "pauseResume": { "mode": "sound", "sound": "soft-ping" }
                    }
                }
            }))
            .unwrap();

        let upgraded = get_notification_preferences(&prefs, || json!({})).unwrap();
        assert_eq!(
            upgraded["categories"]["pauseResume"]["sound"],
            json!("pause-resume")
        );

        let explicit = save_notification_preferences(
            &prefs,
            &json!({
                "categories": {
                    "pauseResume": { "mode": "sound", "sound": "soft-ping" }
                }
            }),
            || json!({}),
        )
        .unwrap();
        assert_eq!(
            explicit["categories"]["pauseResume"]["sound"],
            json!("soft-ping")
        );
    }

    #[test]
    fn resolves_pause_resume_delivery_and_rejects_pause_resume_on_other_categories() {
        let normalized = normalize_notification_preferences(Some(&json!({
            "volume": 40,
            "categories": {
                "confirmation": { "mode": "both", "sound": "pause-resume" },
                "pauseResume": { "mode": "sound", "sound": "pause-resume" },
            }
        })));
        assert_eq!(
            normalized["categories"]["confirmation"]["sound"],
            json!("soft-ping")
        );

        let paused = resolve_notification_delivery("GSMTextIntakePaused", &normalized).unwrap();
        assert_eq!(
            paused,
            NotificationDelivery {
                banner: false,
                sound: Some("descending"),
            }
        );
        let resumed = resolve_notification_delivery("OCRPaused", &normalized).unwrap();
        assert_eq!(resumed.sound, Some("descending"));
        let ocr_resumed = resolve_notification_delivery("OCRResumed", &normalized).unwrap();
        assert_eq!(ocr_resumed.sound, Some("ascending"));
    }

    #[test]
    fn builds_playback_payload_for_all_tones() {
        for sound in NOTIFICATION_SOUNDS {
            let payload = playback_payload(sound, 50).unwrap();
            assert!(!payload["tones"].as_array().unwrap().is_empty());
            assert_eq!(payload["volume"], json!(50));
        }
        assert!(playback_payload("invalid", 50).is_err());
    }
}
