use crate::{
    mining::{MiningService, ProfileSnapshot},
    obs::Obs,
    overlay_settings::GSM_OWNED_OVERLAY_FIELD_MAP,
    settings::Settings,
};
use serde_json::{json, Map, Value};
use std::{path::Path, sync::Arc, time::SystemTime};
use tauri::{AppHandle, Manager};

fn active(doc: &Value) -> &Value {
    let name = doc["current_profile"].as_str().unwrap_or("Default");
    doc["configs"]
        .get(name)
        .or_else(|| doc["configs"].get("Default"))
        .unwrap_or(doc)
}

fn settings(doc: &Value) -> &Value {
    active(doc)
        .get("overlay")
        .filter(|v| v.is_object())
        .unwrap_or(&doc["overlay"])
}

fn profiles(doc: &Value) -> Value {
    let rows: Vec<_> = doc["configs"].as_object().into_iter().flatten().map(|(name, profile)| {
        json!({"name":name,"scenes":profile["scenes"].as_array().cloned().unwrap_or_default()})
    }).collect();
    json!({"type":"gsm-profile-state-updated","currentProfileName":doc["current_profile"].as_str().unwrap_or("Default"),"profiles":rows})
}

fn monitors(app: &AppHandle) -> Vec<Value> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            json!({"left":p.x,"top":p.y,"width":s.width,"height":s.height})
        })
        .collect()
}

fn public_settings(overlay: &Value, screens: &[Value]) -> Value {
    let fields: Map<_, _> = GSM_OWNED_OVERLAY_FIELD_MAP
        .iter()
        .filter_map(|(field, key)| Some((key.to_string(), overlay.get(*field)?.clone())))
        .collect();
    let displays: Vec<_> = screens
        .iter()
        .enumerate()
        .map(|(i, m)| {
            format!(
                "Monitor {}: left: {}, top: {}, width: {}, height: {}",
                i + 1,
                m["left"],
                m["top"],
                m["width"],
                m["height"]
            )
        })
        .collect();
    json!({"type":"gsm-overlay-config-updated","settings":fields,"monitors":displays})
}

fn coerce(field: &str, raw: &Value) -> Option<Value> {
    let string = raw.as_str().unwrap_or("").trim();
    Some(match field {
        "monitor_to_capture" | "minimum_character_size" => {
            json!(raw.as_i64().or_else(|| string.parse().ok())?)
        }
        "periodic_interval" | "periodic_ratio" => {
            let value = raw
                .as_f64()
                .or_else(|| string.parse().ok())
                .filter(|v| v.is_finite())?;
            json!(value)
        }
        "monitor_to_capture_id" | "engine_v2" | "manual_mode_desktop_background" => {
            json!(raw.as_str().or_else(|| raw.is_null().then_some(""))?)
        }
        _ => json!(match raw {
            Value::String(_) => matches!(
                string.to_ascii_lowercase().as_str(),
                "yes" | "true" | "1" | "on"
            ),
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64()? != 0.,
            Value::Null => false,
            _ => return None,
        }),
    })
}

fn monitor_id(m: &Value) -> String {
    format!(
        "bounds:{}:{}:{}:{}",
        m["left"], m["top"], m["width"], m["height"]
    )
}

fn update_settings(app: &AppHandle, request: &Value, screens: &[Value]) -> Result<Value, String> {
    let path = app.state::<Settings>().paths.active.join("config.json");
    let mut fields = request["settings"].as_object().cloned().unwrap_or_default();
    if let Some(key) = request["key"].as_str() {
        fields.insert(key.to_owned(), request["value"].clone());
    }
    let mut rejected = Vec::new();
    let result = gsm_settings::mining_scopes::update(&path, |doc| {
        let mut overlay = settings(doc).clone();
        let mut applied = false;
        let mut resolve_monitor = false;
        let mut prefer_index = false;
        for (key, raw) in fields {
            let field = GSM_OWNED_OVERLAY_FIELD_MAP
                .iter()
                .find(|(f, k)| *f == key || *k == key)
                .map(|(f, _)| *f);
            match field.and_then(|f| coerce(f, &raw).map(|v| (f, v))) {
                Some((f, v)) => {
                    resolve_monitor |= matches!(f, "monitor_to_capture" | "monitor_to_capture_id");
                    prefer_index |= f == "monitor_to_capture";
                    overlay[f] = v;
                    applied = true;
                }
                None => rejected.push(key),
            }
        }
        if !applied && rejected.is_empty() {
            rejected.push("No supported settings were supplied".into());
        }
        if resolve_monitor && !screens.is_empty() {
            let index = (!prefer_index)
                .then(|| {
                    screens
                        .iter()
                        .position(|m| overlay["monitor_to_capture_id"] == monitor_id(m))
                })
                .flatten()
                .or_else(|| {
                    overlay["monitor_to_capture"]
                        .as_u64()
                        .and_then(|v| usize::try_from(v).ok())
                })
                .filter(|i| *i < screens.len())
                .unwrap_or(0);
            overlay["monitor_to_capture"] = json!(index);
            overlay["monitor_to_capture_id"] = json!(monitor_id(&screens[index]));
            overlay["monitor_to_capture_bounds"] = screens[index].clone();
        }
        if applied && overlay != *settings(doc) {
            let name = doc["current_profile"]
                .as_str()
                .unwrap_or("Default")
                .to_owned();
            if doc["configs"][&name].is_object() {
                doc["configs"][&name]["overlay"] = overlay.clone();
            }
            doc["overlay"] = overlay.clone();
        }
        Ok(public_settings(&overlay, screens))
    })?;
    app.state::<Obs>().refresh_session();
    let mut response = result;
    if let Some(id) = request.get("request_id") {
        response["request_id"] = id.clone();
        response["success"] = json!(rejected.is_empty());
        if !rejected.is_empty() {
            response["error"] = json!(format!("Rejected settings: {}", rejected.join(", ")));
        }
    }
    Ok(response)
}

type FileStamp = Option<(u64, SystemTime)>;
fn stamp(path: &Path) -> FileStamp {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()?))
}

#[derive(Default)]
pub(crate) struct CaptureConfig {
    profile: Option<Arc<ProfileSnapshot>>,
    target: Value,
    files: [FileStamp; 2],
}

impl CaptureConfig {
    pub(crate) fn refresh(&mut self, app: &AppHandle) -> Result<Vec<Value>, String> {
        let base = &app.state::<Settings>().paths.active;
        let snapshot = app.state::<Arc<MiningService>>().load_snapshot()?;
        let session = app.state::<Obs>().game_session();
        let scene = session["scene"].as_str().unwrap_or("");
        let source = session["source_name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(scene);
        let fallback = session["obs_fallback_available"] == true;
        let target = json!({"scene":scene,"target_id":session["target_id"],"source_name":source,
            "browser_source":session["browser_source"] == true,
            "capture_kind":if fallback { json!("obs") } else { session["capture_kind"].clone() },
            "available":fallback || session["available"]==true});
        let name = crate::ocr_coordinator::sanitize_ocr_filename(scene);
        let dir = base.join("ocr_config");
        let area_file = dir.join(format!("{name}_overlay.json"));
        let prefs_file = dir.join(format!("{name}_overlay_settings.json"));
        let files = [stamp(&area_file), stamp(&prefs_file)];
        let profile_changed = self
            .profile
            .as_ref()
            .is_none_or(|old| !Arc::ptr_eq(old, &snapshot));
        if !profile_changed && self.target == target && self.files == files {
            return Ok(Vec::new());
        }
        let doc = &snapshot.document;
        let profile = active(doc);
        let overlay = settings(doc);
        let mut config = target.clone();
        let prefs = gsm_settings::read_object(&prefs_file)
            .ok()
            .filter(|prefs| prefs.as_object().is_some_and(|m| !m.is_empty()))
            .or_else(|| gsm_settings::read_object(&area_file).ok());
        config["settings"] = overlay.clone();
        // Older OCR area files can carry a per-scene size. An explicit
        // override in the scoped editor takes precedence for that game.
        let name = doc["current_profile"].as_str().unwrap_or("Default");
        if let Some(size) = prefs.as_ref()
            .and_then(|prefs| prefs.get("minimum_character_size"))
            .and_then(|v| coerce("minimum_character_size", v))
            .filter(|_|doc["profile_layers"]["scenes"][name]["overrides"].get("overlay.minimum_character_size").is_none())
        {
            config["settings"]["minimum_character_size"] = size;
        }
        if profile["advanced"]["screenshot_capture_backend_v2"] == "obs" {
            config["capture_kind"] = json!("obs");
        }
        config["language"] = profile["general"]["target_language"].clone();
        config["profile"] = json!(base);
        let mut updates = Vec::new();
        if profile_changed {
            updates.push(profiles(doc));
            updates.push(public_settings(overlay, &monitors(app)));
        }
        updates.push(json!({"type":"native-overlay-command","action":"configure","config":config}));
        self.profile = Some(snapshot);
        self.target = target;
        self.files = files;
        Ok(updates)
    }
}

pub(super) async fn request(app: &AppHandle, kind: &str, frame: &str) -> bool {
    use crate::gui_dialog::{open, Dialog};
    let intake = app.state::<super::Intake>();
    match kind {
        "process-pause-request" => {
            let Ok(req) = serde_json::from_str::<Value>(frame) else { return false };
            if !matches!(req["action"].as_str(), Some("pause" | "resume")) {
                return false;
            }
            let source = req["source"].as_str().unwrap_or("");
            if !matches!(
                source,
                "manual_hotkey"
                    | "texthooker_hotkey"
                    | "gamepad_navigation"
                    | "gamepad_manual_pause"
            ) {
                return false;
            }
            if let Err(e) = app.state::<crate::obs::game_pause::GamePause>().request(
                app,
                source,
                req["action"].as_str().unwrap_or(""),
            ) {
                crate::desktop_log::warn(app, "game pause", e);
                return false;
            }
        }
        "get-live-stats-today" => {
            let Ok(_query) = intake.today_stats.try_lock() else { return true };
            let request: Value = serde_json::from_str(frame).unwrap_or(Value::Null);
            let reason = request["reason"].as_str().unwrap_or("refresh");
            let scene = app.state::<Obs>().current_scene_name();
            let (live, mut frame) = {
                let mut session = intake.state.lock().unwrap();
                let paused = session.policy.paused;
                (session.projection.live.today(), session.projection.payload(reason, paused))
            };
            let at = chrono::Local::now();
            let game = scene.clone();
            let handle = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let config = handle.state::<Arc<MiningService>>().load_snapshot()?;
                let db = handle.state::<Settings>().paths.active.join("gsm.db");
                live.restore(&handle.state::<Arc<gsm_history::History>>(), &db, &game, at, &config.document["stats"])
                    .map_err(|e| e.to_string())
            }).await;
            match result {
                Ok(Ok(Value::Object(daily))) => {
                    if app.state::<Obs>().current_scene_name() == scene {
                        frame.as_object_mut().unwrap().extend(daily);
                        intake.overlay_event(frame);
                    }
                }
                failure => {
                    crate::desktop_log::warn(app, "overlay", format!("Could not read today's stats: {failure:?}"));
                    return false;
                }
            }
        }
        "get-gsm-profile-state" | "get-gsm-overlay-config" | "set-gsm-overlay-config" => {
            let Ok(req) = serde_json::from_str::<Value>(frame) else { return false };
            let handle = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let doc = handle.state::<Arc<MiningService>>().load_snapshot()?;
                match req["type"].as_str() {
                    Some("get-gsm-profile-state") => Ok(profiles(&doc.document)),
                    Some("get-gsm-overlay-config") => {
                        Ok(public_settings(settings(&doc.document), &monitors(&handle)))
                    }
                    _ => update_settings(&handle, &req, &monitors(&handle)),
                }
            })
            .await;
            match result {
                Ok(Ok(event)) => intake.overlay_event(event),
                Ok(Err(e)) => {
                    crate::desktop_log::warn(app, "overlay", e);
                    return false;
                }
                Err(_) => return false,
            }
        }
        "manual-overlay-scan-request" | "manual-mode-background-request" => {
            let action = if kind == "manual-overlay-scan-request" {
                "scan"
            } else {
                "background"
            };
            intake.overlay_event(json!({"type":"native-overlay-command","action":action,"manual":true,"source":"hotkey","retries":0}));
        }
        "open-gsm-settings" => {
            let Ok(req) = serde_json::from_str::<Value>(frame) else { return false };
            let handle = app.clone();
            let dialog = Dialog::Settings {
                root_tab_key: req["root_tab_key"].as_str().unwrap_or("profiles").into(),
                subtab_key: req["subtab_key"].as_str().unwrap_or("").into(),
            };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = open(&handle, dialog).await {
                    crate::desktop_log::warn(&handle, "overlay", e);
                }
            });
        }
        _ => return false,
    }
    true
}
