use super::*;

#[derive(PartialEq, Eq, Clone, Copy)]
pub(super) enum Scope {
    Root,
    Shared,
    Profile,
}

pub(super) struct Field {
    pub scope: Scope,
    pub default: Value,
}

fn shared(key: &str) -> bool {
    matches!(
        key,
        "anki.url"
            | "audio.anki_media_collection"
            | "vad.tts_url"
            | "obs.host"
            | "obs.port"
            | "obs.password"
            | "obs.obs_path"
            | "general.single_port"
            | "general.websocket_sources"
            | "general.websocket_uri"
            | "general.texthook_max_buffer_size"
            | "advanced.localhost_bind_address"
            | "advanced.texthooker_communication_websocket_port"
            | "advanced.direct_websocket_port"
            | "advanced.plaintext_websocket_port"
            | "overlay.websocket_port"
    ) || (key.starts_with("ai.")
        && (key.ends_with("api_key")
            || key.ends_with("_url")
            || (key.starts_with("ai.gsm_cloud_") && !key.ends_with("_models"))))
        || key.starts_with("advanced.cloud_sync_")
}

fn collect(fields: &mut BTreeMap<String, Field>, key: &str, value: &Value, scope: Scope) {
    if let Some(children) = value.as_object().filter(|m| !m.is_empty()) {
        for (k, v) in children {
            collect(fields, &format!("{key}.{k}"), v, scope);
        }
    } else {
        fields.insert(
            key.into(),
            Field {
                scope: if scope == Scope::Profile && shared(key) {
                    Scope::Shared
                } else {
                    scope
                },
                default: value.clone(),
            },
        );
    }
}

pub(super) static FIELDS: LazyLock<BTreeMap<String, Field>> = LazyLock::new(|| {
    let mut fields = BTreeMap::new();
    for key in [
        "stats",
        "experimental",
        "discord",
        "switch_to_default_if_not_found",
    ] {
        collect(&mut fields, key, &MINING_DEFAULTS[key], Scope::Root);
    }
    for (key, value) in MINING_DEFAULTS["overlay"].as_object().unwrap() {
        let global = key.starts_with("monitor_to_capture") || key == "websocket_port";
        collect(
            &mut fields,
            &format!("overlay.{key}"),
            value,
            if global { Scope::Root } else { Scope::Profile },
        );
    }
    for (key, value) in MINING_DEFAULTS["configs"]["Default"].as_object().unwrap() {
        if !matches!(key.as_str(), "name" | "scenes" | "wip") {
            collect(&mut fields, key, value, Scope::Profile);
        }
    }
    for key in [
        "paths.folder_to_watch",
        "paths.output_folder",
        "audio.anki_media_collection",
        "obs.obs_path",
    ] {
        collect(&mut fields, key, &json!(""), Scope::Profile);
    }
    fields
});

pub(super) fn editable(key: &str) -> bool {
    // Derived fields, migration flags, cached model/auth state and machine
    // geometry have dedicated owners. Keep them in projections but out of forms.
    !key.ends_with("_migrated")
        && !key.ends_with(".core")
        && !matches!(
            key,
            "screenshot.use_beginning_of_line_as_screenshot"
                | "screenshot.use_new_screenshot_logic"
        )
        && !matches!(
            key,
            "anki.available_fields"
                | "anki.overwrite_audio"
                | "anki.overwrite_picture"
                | "anki.overwrite_sentence"
                | "anki.polling_rate"
                | "vad.selected_vad_model"
                | "vad.use_cpu_for_inference"
                | "advanced.screenshot_capture_backend"
                | "overlay.engine"
                | "overlay.monitor_to_capture_bounds"
                | "general.websocket_uri"
                | "audio.ffmpeg_reencode_options_to_use"
                | "screenshot.custom_ffmpeg_option_selected"
                | "ai.gsm_cloud_token_expires_at"
                | "ai.gsm_cloud_user_id"
                | "ai.gsm_cloud_access_token"
                | "ai.gsm_cloud_refresh_token"
        )
        && !(key.starts_with("anki.")
            && key.ends_with(".enabled")
            && ["sentence", "word", "picture", "sentence_audio"]
                .contains(&key.split('.').nth(1).unwrap_or("")))
}

pub(super) fn options(key: &str) -> &'static [&'static str] {
    match key {
        "audio.extension" => &["opus", "mp3", "ogg", "aac", "m4a"],
        "screenshot.extension" => &["webp", "avif", "png", "jpeg"],
        "screenshot.screenshot_timing_setting" => &["beginning", "middle", "end"],
        "screenshot.animated_settings.codec" => &["libsvtav1", "libaom-av1"],
        "screenshot.animated_settings.size_priority" => &["balanced", "prefer_fps", "prefer_quality"],
        "anki.field_grouping_order" => &["front", "back"],
        "advanced.screenshot_capture_backend_v2" => &["auto", "obs", "wgc"],
        "discord.icon" => &["GSM", "Cute", "Jacked", "Cursed"],
        "discord.show_reading_stats" => &[
            "None",
            "Characters per Hour",
            "Total Characters",
            "Cards Mined",
            "Active Reading Time",
        ],
        "ai.provider" => &[
            "Gemini",
            "Groq",
            "OpenAI",
            "Ollama",
            "LM Studio",
            "DeepL",
            "Z.ai",
            "GSM Cloud",
        ],
        "ai.prompt_preset" => &[
            "",
            "translation",
            "sentence",
            "grammar",
            "vocabulary",
            "nuance",
            "context",
        ],
        "ai.open_ai_reasoning_effort" => &[
            "", "none", "minimal", "low", "medium", "high", "xhigh", "max",
        ],
        "vad.whisper_model" => &["tiny", "base", "small", "medium", "large", "turbo"],
        "vad.selected_vad_model_v2" => &["SILERO", "FIRERED", "WHISPER"],
        "vad.backup_vad_model" => &["OFF", "SILERO", "FIRERED", "WHISPER"],
        "experimental.tokenization_backend" => &["sudachi"],
        "experimental.tokenization_sudachi_dictionary" => &["small", "core", "full"],
        "overlay.engine_v2" => &[
            "oneocr",
            "lens",
            "meikiocr",
            "screenai",
            "vitaocr",
            "mida_vocr",
            "vocr_lens",
        ],
        "overlay.manual_mode_desktop_background" => &["off", "on_demand"],
        "text_processing.unicode_normalize_config.form" => &["NFC", "NFD", "NFKC", "NFKD"],
        _ => &[],
    }
}
// Preserve older saved choices while keeping the provider picker consistent with desktop preview flags.
pub(super) fn available_options(key: &str, doc: &Value, current: &Value) -> Value {
    if matches!(key, "general.native_language" | "general.target_language") {
        return json!(crate::gsm_config::learning_languages().collect::<Vec<_>>());
    }
    if key != "ai.provider" {
        return json!(options(key));
    }
    let preview = std::env::var("GSM_CLOUD_AI_PREVIEW").is_ok_and(|flag| {
        matches!(
            flag.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    });
    let signed_in = doc[LAYERS]["global"]["ai.gsm_cloud_access_token"]
        .as_str()
        .is_some_and(|token| !token.trim().is_empty());
    json!(options(key)
        .iter()
        .copied()
        .filter(|name| current == *name
            || match *name {
                "Z.ai" => false,
                "GSM Cloud" => preview && signed_in,
                _ => true,
            })
        .collect::<Vec<_>>())
}
pub(super) fn range(key: &str) -> Option<(f64, f64)> {
    match key {
        "general.single_port" | "obs.port" => Some((1., 65535.)),
        "general.texthook_max_buffer_size" => Some((1., 100000.)),
        "screenshot.quality" => Some((0., 100.)),
        "screenshot.animated_settings.fps" => Some((10., 30.)),
        "screenshot.animated_settings.max_width" => Some((0., 3840.)),
        "screenshot.animated_settings.quality" => Some((0., 10.)),
        "screenshot.animated_settings.target_size_kb" => Some((0., 102400.)),
        "obs.replay_buffer_duration_seconds" => Some((1., 86400.)),
        "obs.recording_fps" => Some((1., 120.)),
        "advanced.wgc_capture_fps" => Some((1., 60.)),
        "advanced.mute_game_on_background_delay_seconds" => Some((0., 300.)),
        "stats.day_rollover_hour" => Some((0., 23.)),
        "discord.inactivity_timer" => Some((120., 900.)),
        "features.review_after_session.max_future_context_lines" => Some((0., 100.)),
        "process_pausing.auto_resume_seconds" => Some((5., 300.)),
        "overlay.periodic_ratio" | "ai.top_p" => Some((0., 1.)),
        k if k.ends_with("_port") => Some((0., 65535.)),
        _ => None,
    }
}
pub(super) fn validate_value(key: &str, value: &Value, default: &Value) -> Result<()> {
    let valid = match default {
        Value::Bool(_) => value.is_boolean(),
        Value::Number(n) if n.is_i64() || n.is_u64() => value.is_i64() || value.is_u64(),
        Value::Number(_) => value.is_number(),
        Value::String(_) => value.is_string(),
        Value::Array(_) if key == "general.websocket_sources" => {
            value.as_array().is_some_and(|a| {
                a.iter().all(|v| {
                    v["uri"].as_str().is_some_and(|s| !s.trim().is_empty())
                        && v["name"].is_string()
                        && v["enabled"].is_boolean()
                })
            })
        }
        Value::Array(_) if key == "stats.tadoku_daily_sync_game_ids" => value
            .as_array()
            .is_some_and(|a| a.iter().all(|v| v.is_string() || v.is_i64())),
        Value::Array(_) if key == "text_processing.string_replacement.rules" => value
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_object)),
        Value::Array(_) => value
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string)),
        _ => false,
    };
    if !valid {
        return Err(format!("Invalid value for {key}"));
    }
    if let Some((low, high)) = range(key) {
        if !value.as_f64().is_some_and(|n| (low..=high).contains(&n)) {
            return Err(format!("Value for {key} must be between {low} and {high}"));
        }
    }
    if !options(key).is_empty() && !options(key).contains(&value.as_str().unwrap_or("")) {
        return Err(format!("Invalid choice for {key}"));
    }
    if matches!(key, "general.target_language" | "general.native_language")
        && !crate::gsm_config::is_learning_language(value.as_str().unwrap_or(""))
    {
        return Err(format!("Invalid language code for {key}"));
    }
    Ok(())
}
