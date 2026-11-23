use super::*;
use std::collections::HashSet;

pub(super) fn clean_sections(data: &mut Map<String, Value>) {
    for (section, keys) in [
        ("hotkeys", &["reset_line", "take_screenshot"][..]),
        (
            "stats",
            &["afk_timer_seconds", "reading_time_adaptive_v2"][..],
        ),
        ("screenshot", &["use_screenshot_selector"][..]),
        ("overlay", &["send_hotkey_text_to_texthooker"][..]),
        ("process_pausing", &["allowlist"][..]),
        (
            "advanced",
            &["multi_line_sentence_storage_field", "ocr_websocket_port"][..],
        ),
    ] {
        if let Some(section) = data.get_mut(section).and_then(Value::as_object_mut) {
            for key in keys {
                section.remove(*key);
            }
        }
    }
}

fn truth(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn anki(data: &mut Map<String, Value>, defaults: &Value) {
    if let Some(old) = data.remove("update_anki") {
        data.insert(
            "enabled".into(),
            json!(truth(&old) && data.get("enabled").is_none_or(truth)),
        );
    }
    for (key, overwrite) in [
        ("sentence", "overwrite_sentence"),
        ("sentence_audio", "overwrite_audio"),
        ("picture", "overwrite_picture"),
        ("word", ""),
        ("previous_sentence", ""),
        ("previous_image", ""),
        ("video", ""),
        ("sentence_furigana", ""),
        ("game_name", ""),
    ] {
        let old_key = format!("{key}_field");
        let old_name = data.remove(&old_key);
        let mut field = match data.remove(key) {
            Some(Value::Object(obj)) => Value::Object(obj),
            Some(Value::String(s)) => json!({"name":s}),
            _ => old_name
                .and_then(|s| s.as_str().map(|s| json!({"name":s})))
                .unwrap_or_else(|| json!({})),
        };
        for flag in ["enabled", "overwrite", "append"] {
            let old = data.remove(&format!("{old_key}_{flag}"));
            if field.get(flag).is_none() {
                let old = old.as_ref().filter(|v| !v.is_null()).or_else(|| {
                    (flag == "overwrite" && !overwrite.is_empty())
                        .then(|| data.get(overwrite))
                        .flatten()
                        .filter(|v| !v.is_null())
                });
                if let Some(old) = old {
                    field[flag] = json!(truth(old));
                }
            }
        }
        fill(&mut field, &defaults[key]);
        field["core"] = defaults[key]["core"].clone();
        if field["core"] == true {
            field["enabled"] = json!(true);
        }
        if truth(&field["overwrite"]) && truth(&field["append"]) {
            field["append"] = json!(false);
        }
        data.insert(key.into(), field);
    }
}

pub(super) fn profile(data: &mut Map<String, Value>, defaults: &Value, old_obs: bool) {
    if let Some(s) = data
        .get_mut("process_pausing")
        .and_then(Value::as_object_mut)
    {
        s.remove("allowlist");
    }
    if let Some(a) = data.get_mut("anki").and_then(Value::as_object_mut) {
        anki(a, &defaults["anki"]);
        data.remove("anki_overwrites");
    }
    if old_obs {
        if let Some(obs) = data.get_mut("obs").and_then(Value::as_object_mut) {
            obs.insert("get_game_from_scene".into(), json!(true));
        }
    }
    if let Some(vad) = data.get_mut("vad").and_then(Value::as_object_mut) {
        if !vad.get("firered_default_migrated").is_some_and(truth) {
            if vad
                .get("selected_vad_model_v2")
                .or_else(|| vad.get("selected_vad_model"))
                .is_none_or(|v| v.is_null() || v == "OFF" || v == "SILERO")
            {
                vad.insert("selected_vad_model_v2".into(), json!("FIRERED"));
            }
            vad.insert("firered_default_migrated".into(), json!(true));
        }
        if old_obs
            && vad
                .get("selected_vad_model")
                .is_some_and(|s| s == "WHISPER")
            && vad.get("backup_vad_model").is_some_and(|s| s == "SILERO")
        {
            vad.insert("backup_vad_model".into(), json!("OFF"));
        }
    }
    if let Some(general) = data.get_mut("general").and_then(Value::as_object_mut) {
        let port = crate::gsm_config::primary_port(general);
        general.insert("single_port".into(), json!(port));
        general.remove("texthooker_port");
        if !general.contains_key("websocket_sources") {
            let mut seen = HashSet::new();
            let mut custom = 0;
            let sources: Vec<_> = general
                .get("websocket_uri")
                .and_then(Value::as_str)
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty() && seen.insert(*s))
                .map(|uri| {
                    let port = uri.rsplit_once(':').map(|(_, p)| p.trim());
                    let name = match port {
                        Some("9001") => "Agent".into(),
                        Some("2333") => "LunaTranslator".into(),
                        Some("6677") => "Textractor".into(),
                        _ => {
                            custom += 1;
                            format!("Custom {custom}")
                        }
                    };
                    json!({"uri":uri,"name":name,"enabled":true})
                })
                .collect();
            if !sources.is_empty() {
                general.insert("websocket_sources".into(), Value::Array(sources));
            }
        }
    }
}

/// The old TOML file stays on disk. Only the settings recognized by its original
/// importer are copied into the mining profile.
pub(super) fn toml(bytes: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let old: Value = ::toml::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Reading config.toml: {e}"))?;
    let mut profile = json!({});
    for (section, fields) in [
        ("paths", &["folder_to_watch"][..]),
        (
            "anki",
            &[
                "url",
                "sentence_field",
                "sentence_audio_field",
                "word_field",
                "picture_field",
                "custom_tags",
                "add_game_tag",
            ][..],
        ),
        (
            "screenshot",
            &[
                "width",
                "height",
                "quality",
                "extension",
                "capture_backend",
                "custom_ffmpeg_settings",
            ][..],
        ),
        ("features", &["open_anki_edit"][..]),
        (
            "audio",
            &[
                "extension",
                "beginning_offset",
                "end_offset",
                "ffmpeg_reencode_options",
            ][..],
        ),
        ("obs", &["host", "port", "password"][..]),
        ("general", &["single_port", "texthooker_port"][..]),
        ("hotkeys", &["process_pause"][..]),
    ] {
        for &key in fields {
            if let Some(value) = old[section].get(key) {
                profile[section][key] = value.clone();
            }
        }
    }
    for (from, source, to, key) in [
        ("websocket", "uri", "general", "websocket_uri"),
        ("websocket", "enabled", "general", "use_websocket"),
        ("anki", "polling_rate", "anki", "polling_rate_v2"),
        (
            "anki_overwrites",
            "overwrite_audio",
            "anki",
            "overwrite_audio",
        ),
        (
            "anki_overwrites",
            "overwrite_sentence",
            "anki",
            "overwrite_sentence",
        ),
        (
            "anki_overwrites",
            "overwrite_picture",
            "anki",
            "overwrite_picture",
        ),
        (
            "features",
            "do_vosk_postprocessing",
            "features",
            "full_auto",
        ),
        (
            "features",
            "do_vosk_postprocessing",
            "vad",
            "do_vad_postprocessing",
        ),
        ("vosk", "whisper_model", "vad", "whisper_model"),
        ("vosk", "url", "vad", "vosk_url"),
        ("audio", "vosk_trim_beginning", "vad", "trim_beginning"),
    ] {
        if let Some(value) = old[from].get(source) {
            profile[to][key] = value.clone();
        }
    }
    Ok(profile)
}
