//! Start native inputs from saved preferences before the optional Python consumers attach.
use super::*;
use gsm_mining::config::ProfileConfig;

pub fn start(app: &tauri::AppHandle) {
    tauri::async_runtime::spawn(maintain(app.clone()));
}

/// Reapply saved settings without clearing live input, recent lines or pending output.
pub fn configure(
    app: &tauri::AppHandle,
    config: &ProfileConfig,
    doc: &Value,
) -> Result<(), String> {
    let p = gsm_settings::gsm_config::active_profile(doc);
    let section = |key: &str| p.and_then(|p| p.get(key)).unwrap_or(&Value::Null);
    if crate::app_lifecycle::native_session_requested() {
        if let Some(keys) = app.try_state::<super::hotkeys::Hotkeys>() { keys.configure(section("hotkeys")); }
    }
    let general = section("general");
    let (processing, language) = gsm_settings::workspace::Workspace::text_settings(doc);
    let mut sockets = serde_json::Map::new();
    if general["use_websocket"] != false {
        if let Some(items) = general["websocket_sources"].as_array() {
            for item in items.iter().filter(|v| v["enabled"] != false) {
                if let Some(uri) = item["uri"].as_str() {
                    sockets.insert(uri.into(), json!(item["name"].as_str().unwrap_or(uri)));
                }
            }
        } else if let Some(uris) = general["websocket_uri"].as_str() {
            for uri in uris.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                sockets.insert(uri.into(), json!(uri));
            }
        } else {
            for (uri, label) in [
                ("localhost:9001", "Agent"),
                ("localhost:2333", "LunaTranslator"),
                ("localhost:6677", "Textractor"),
            ] {
                sockets.insert(uri.into(), json!(label));
            }
        }
    }
    let intake = app.state::<Intake>();
    let mut s = intake.state.lock().unwrap();
    if s.outputs.is_none() {
        s.outputs = Some(outputs::start()?);
    }
    let exp = &doc["experimental"];
    let dictionary = (exp["enable_experimental_features"] == true
        && exp["enable_tokenization"] == true)
        .then(|| {
            exp["tokenization_sudachi_dictionary"]
                .as_str()
                .unwrap_or("small")
        });
    let cfg = json!({"projection":{"profile":config.name,"collect":section("advanced")["dont_collect_stats"]!=true,"longplay":config.features.generate_longplay,
        "dictionary":dictionary,"gap":doc["stats"]["session_gap_seconds"],"punctuation":doc["stats"]["extra_punctuation_regex"],
        "repetitions":doc["stats"]["regex_out_repetitions"],"discord":doc.get("discord").cloned().unwrap_or_else(||json!({"enabled":true,"show_reading_stats":"Total Characters"}))}});
    s.projection.configure(app, &cfg, &language)?;
    s.policy.processing = std::sync::Arc::new(processing);
    s.policy.language = language;
    s.policy.remove_prefix = general["remove_matching_prefix_on_subsequent_lines"] != false;
    s.policy.max_chars = general["texthook_max_buffer_size"].as_u64().unwrap_or(3000) as usize;
    s.policy.relay = section("hotkeys")["relay_outputs_when_text_intake_paused"] != false;
    s.native_reader = true;
    s.retention = (config.obs.replay_buffer_duration_seconds as i64).max(0) + 5;
    s.sources.configure(
        app,
        0,
        &json!({"both":general["use_both_clipboard_and_websocket"]==true,
        "clipboard":general["use_clipboard"]==true,"websockets":sockets,
        "output_ports":[config.general.single_port,config.advanced.direct_websocket_port]}),
    );
    Ok(())
}

async fn maintain(app: tauri::AppHandle) {
    let intake = app.state::<Intake>();
    let native = crate::app_lifecycle::native_session_requested();
    loop {
        let due = {
            let scene = app.state::<crate::obs::Obs>().current_scene_name();
            let mut guard = intake.state.lock().unwrap();
            let s = &mut *guard;
            if s.native_reader && !s.finished {
                if native {
                    s.feed.refresh_goals_if_due(&app);
                }
                if !scene.is_empty() && s.projection.live.set_scene(&scene) {
                    s.stats_changed("game_changed");
                }
                let now = intake.now();
                if s.projection
                    .live
                    .expire(now.wall.timestamp_micros() as f64 / 1e6, s.projection.gap)
                {
                    s.stats_changed("session_timeout");
                }
                let mut events = Vec::new();
                s.stream.maintain(now, s.retention, &mut events);
                if !events.is_empty() {
                    s.publish(&app, events, None);
                }
                s.stream
                    .next_speech_ns()
                    .map(|t| Duration::from_nanos(t.saturating_sub(now.ns).max(0) as u64))
            } else {
                None
            }
        };
        tokio::select! {_=intake.deadline.notified()=>{},_=tokio::time::sleep(due.unwrap_or(Duration::from_secs(1)).min(Duration::from_secs(1)))=>{}}
    }
}
