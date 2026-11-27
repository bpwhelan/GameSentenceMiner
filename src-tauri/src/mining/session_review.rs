//! Durable Session Review persistence & audio/future-replay helpers.
//! Reads and writes the same durable format as legacy session reviews.

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use gsm_mining::config::{AnkiCard, ProfileConfig};
use gsm_mining::ffmpeg::{file_mtime_epoch, MediaTools};
use gsm_mining::pause_gaps::PauseHistory;
use gsm_mining::policy::{extract_replay_audio, AudioEditContext, MediaAssets};
use gsm_mining::text::{parse_iso_to_epoch, GameLine};
use gsm_mining::vad::{VadResult, VadSystem};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use uuid::Uuid;

static IN_FLIGHT: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Debug)]
pub struct PendingReviewHandle {
    pub folder: PathBuf,
    pub data: Value,
}

impl Drop for PendingReviewHandle {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap().remove(&self.folder);
    }
}

pub(crate) fn initializing(folder: &Path) -> bool {
    IN_FLIGHT.lock().unwrap().contains(folder)
}

fn review_root(data_dir: &Path) -> PathBuf {
    data_dir.join("session_review")
}

pub(crate) fn saved_pause_history(value: &Value, work: &Path) -> Option<PauseHistory> {
    let spans = serde_json::from_value::<Vec<(f64, f64)>>(value.clone()).ok()?;
    let history = PauseHistory::new(work);
    history.remember_pauses(&spans);
    Some(history)
}

pub fn epoch_to_local_iso(epoch: f64) -> String {
    let secs = epoch.trunc() as i64;
    let nanos = ((epoch.fract().abs()) * 1e9).round() as u32;
    DateTime::<Utc>::from_timestamp(secs, nanos.min(999_999_999))
        .map(|dt| {
            dt.with_timezone(&Local)
                .naive_local()
                .format("%Y-%m-%dT%H:%M:%S%.6f")
                .to_string()
        })
        .unwrap_or_else(|| Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S%.6f").to_string())
}

fn media_copy_name(source: &Path) -> String {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let name = source.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let raw = if ext.eq_ignore_ascii_case(".png") && (name.contains("_raw") || name.contains("frame_"))
    {
        "_raw"
    } else {
        ""
    };
    format!("{}{raw}{ext}", Uuid::new_v4().simple())
}

fn line_entry_json(line: &GameLine, role: &str) -> Value {
    let mut obj = json!({
        "id": line.id,
        "text": line.text,
        "time": epoch_to_local_iso(line.time_epoch),
        "scene": line.scene,
        "source": line.source,
        "role": role,
    });
    if let Some(first) = line.first_seen_time_epoch {
        obj["first_seen_time"] = json!(epoch_to_local_iso(first));
    }
    if !line.session_id.is_empty() {
        obj["session_id"] = json!(line.session_id);
    }
    obj
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let staged = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&staged, text).map_err(|e| format!("write {}: {e}", staged.display()))?;
    fs::rename(&staged, path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

fn keep_file(
    folder: &Path,
    copied: &mut HashMap<String, String>,
    source_path: &str,
    link: bool,
) -> String {
    if source_path.is_empty() {
        return String::new();
    }
    let source = Path::new(source_path);
    if !source.is_file() {
        return String::new();
    }
    let key = source.to_string_lossy().to_string();
    if let Some(existing) = copied.get(&key) {
        return existing.clone();
    }
    let name = media_copy_name(source);
    let target = folder.join(&name);
    let ok = if link {
        fs::hard_link(source, &target).is_ok() || fs::copy(source, &target).is_ok()
    } else {
        fs::copy(source, &target).is_ok()
    };
    if ok {
        copied.insert(key, name.clone());
        name
    } else {
        String::new()
    }
}

#[allow(clippy::too_many_arguments)]
pub fn save_pending_review(
    data_dir: &Path,
    anki_profile: &str,
    config: &ProfileConfig,
    card: &AnkiCard,
    assets: &MediaAssets,
    video_path: &Path,
    all_lines: &[GameLine],
    game_line: Option<&GameLine>,
    selected_lines: &[GameLine],
    sentence: &str,
    translation: &str,
    ss_time: f64,
    start_time: f64,
    end_time: f64,
    vad_result: Option<&VadResult>,
    audio_edit_context: Option<&AudioEditContext>,
    tools: &MediaTools,
    pauses: &PauseHistory,
) -> Result<PendingReviewHandle, String> {
    if !video_path.is_file() {
        return Err("The replay could not be saved for later review.".into());
    }
    if anki_profile.trim().is_empty() {
        return Err("AnkiConnect could not identify the active Anki profile.".into());
    }
    let id = Uuid::new_v4().simple().to_string();
    let folder = review_root(data_dir).join(&id);
    fs::create_dir_all(&folder).map_err(|e| format!("create review folder: {e}"))?;
    IN_FLIGHT.lock().unwrap().insert(folder.clone());

    let result: Result<PendingReviewHandle, String> = (|| {
        let mut copied = HashMap::new();
        let replay_name = keep_file(&folder, &mut copied, &video_path.to_string_lossy(), true);
        let capture_end_epoch = file_mtime_epoch(video_path)
            .ok_or_else(|| format!("stat {}", video_path.display()))?;
        let duration = tools.get_video_duration(video_path).max(0.0);
        let capture_start_epoch = capture_end_epoch - duration;

        let selected: Vec<&GameLine> = if !selected_lines.is_empty() {
            selected_lines.iter().collect()
        } else if let Some(gl) = game_line {
            vec![gl]
        } else {
            Vec::new()
        };
        let selected_ids: HashSet<&str> = selected.iter().map(|l| l.id.as_str()).collect();

        let mut included: HashMap<String, GameLine> = HashMap::new();
        for l in &selected {
            included.insert(l.id.clone(), (*l).clone());
        }
        if let Some(gl) = game_line {
            included.insert(gl.id.clone(), gl.clone());
        }
        for l in all_lines {
            if duration > 0.0
                && l.time_epoch >= capture_start_epoch
                && l.time_epoch <= capture_end_epoch
            {
                included.entry(l.id.clone()).or_insert_with(|| l.clone());
            }
        }
        let mut sorted_lines: Vec<GameLine> = included.into_values().collect();
        sorted_lines.sort_by(|a, b| a.time_epoch.total_cmp(&b.time_epoch));

        let pause_spans: Vec<[f64; 2]> = pauses
            .get_pauses_between(capture_start_epoch, capture_end_epoch)
            .into_iter()
            .map(|(a, b)| [a, b])
            .collect();

        let manifest = json!({
            "clip": {
                "file": replay_name,
                "end_time": epoch_to_local_iso(capture_end_epoch),
            },
            "lines": sorted_lines.iter().map(|l| {
                let role = if selected_ids.contains(l.id.as_str()) { "selected" } else { "context" };
                line_entry_json(l, role)
            }).collect::<Vec<_>>(),
            "pauses": pause_spans,
        });
        fs::write(
            folder.join("manifest.json"),
            serde_json::to_string(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("write manifest.json: {e}"))?;

        let edit_data = audio_edit_context.map(|ctx| {
            let mut val = serde_json::to_value(ctx).unwrap_or(Value::Null);
            val["source_audio_path"] =
                json!(keep_file(&folder, &mut copied, &ctx.source_audio_path, false));
            val
        });
        let vad_data = vad_result.map(|v| {
            let mut val = serde_json::to_value(v).unwrap_or(Value::Null);
            val["output_audio"] = json!(keep_file(&folder, &mut copied, &v.output_audio, false));
            val["trimmed_audio_path"] =
                json!(keep_file(&folder, &mut copied, &v.trimmed_audio_path, false));
            val
        });

        let fields_map: serde_json::Map<String, Value> = card
            .fields
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.value.clone())))
            .collect();
        let scene = game_line
            .map(|l| l.scene.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| assets.game_name.clone());

        let video_params = if assets.pending_video {
            json!({
                "video_path": assets.source_video_path,
                "start_time": assets.video_start_time,
                "vad_start": assets.video_vad_start,
                "vad_end": assets.video_vad_end,
            })
        } else {
            json!({})
        };

        let data = json!({
            "version": 1,
            "status": "pending",
            "created_at": Local::now().to_rfc3339(),
            "profile_name": config.name,
            "anki_url": config.anki.url,
            "anki_profile": anki_profile,
            "anki_config": serde_json::to_value(&config.anki).unwrap_or_default(),
            "note_id": card.note_id,
            "model_name": card.model_name,
            "audio_config": serde_json::to_value(&config.audio).unwrap_or_default(),
            "screenshot_config": serde_json::to_value(&config.screenshot).unwrap_or_default(),
            "translation_field": if config.ai.enabled { &config.ai.anki_field } else { "" },
            "expression": card.get_field(&config.anki.word.name).unwrap_or(""),
            "sentence": sentence,
            "translation": translation,
            "scene": scene,
            "line_id": game_line.map(|l| l.id.clone()),
            "selected_ids": selected.iter().map(|l| l.id.clone()).collect::<Vec<_>>(),
            "fields": fields_map,
            "tags": card.tags,
            "screenshot": keep_file(&folder, &mut copied, &assets.screenshot_path, false),
            "previous_screenshot": keep_file(&folder, &mut copied, &assets.prev_screenshot_path, false),
            "audio": keep_file(&folder, &mut copied, &assets.audio_path, false),
            "vad": vad_data,
            "audio_edit_context": edit_data,
            "screenshot_time": ss_time,
            "previous_screenshot_time": assets.prev_screenshot_timestamp,
            "start_time": start_time,
            "end_time": end_time,
            "pending_animated": assets.pending_animated,
            "pending_video": assets.pending_video,
            "video_params": video_params,
            "owned_media": [],
            "cleanup_pending": [],
        });

        atomic_write_json(&folder.join("review.json"), &data)?;
        Ok(PendingReviewHandle {
            folder: folder.clone(),
            data,
        })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&folder);
        IN_FLIGHT.lock().unwrap().remove(&folder);
    }
    result
}

pub fn record_initial_update(
    handle: &mut PendingReviewHandle,
    updated_fields: &HashMap<String, String>,
    assets: &MediaAssets,
) -> Result<(), String> {
    if let Some(fields_obj) = handle.data.get_mut("fields").and_then(|v| v.as_object_mut()) {
        for (k, v) in updated_fields {
            fields_obj.insert(k.clone(), Value::String(v.clone()));
        }
    }
    let mut owned: Vec<String> = [
        assets.audio_in_anki.as_str(),
        assets.screenshot_in_anki.as_str(),
        assets.prev_screenshot_in_anki.as_str(),
        assets.video_in_anki.as_str(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .map(str::to_owned)
    .collect();
    owned.extend(assets.screenshot_media_in_anki.iter().cloned());
    owned.extend(assets.prev_screenshot_media_in_anki.iter().cloned());
    owned.sort();
    owned.dedup();
    handle.data["owned_media"] = json!(owned);
    atomic_write_json(&handle.folder.join("review.json"), &handle.data)
}

fn parse_epoch_value(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    let s = v.as_str()?;
    parse_iso_to_epoch(s)
}

pub fn parse_game_line_value(v: &Value) -> Option<GameLine> {
    if let Ok(line) = serde_json::from_value::<GameLine>(v.clone()) {
        return Some(line);
    }
    let id = v["id"].as_str()?.to_string();
    let text = v["text"].as_str().unwrap_or("").to_string();
    let time_epoch = parse_epoch_value(&v["time_epoch"])
        .or_else(|| parse_epoch_value(&v["time"]))
        .unwrap_or_else(|| Local::now().timestamp() as f64);
    Some(GameLine {
        id,
        text,
        time_epoch,
        index: v["index"].as_i64().unwrap_or(0),
        scene: v["scene"].as_str().unwrap_or("").to_string(),
        source: v["source"].as_str().map(str::to_owned),
        source_padding: v["source_padding"].as_f64(),
        mined_time_epoch: parse_epoch_value(&v["mined_time_epoch"])
            .or_else(|| parse_epoch_value(&v["mined_time"])),
        excluded_from_stats: v["excluded_from_stats"].as_bool().unwrap_or(false),
        session_id: v["session_id"].as_str().unwrap_or("").to_string(),
        first_seen_time_epoch: parse_epoch_value(&v["first_seen_time_epoch"])
            .or_else(|| parse_epoch_value(&v["first_seen_time"])),
        translation: v["translation"].as_str().unwrap_or("").to_string(),
        prev_id: v["prev_id"].as_str().map(str::to_owned),
        next_id: v["next_id"].as_str().map(str::to_owned),
        clip_folder: v["clip_folder"].as_str().map(str::to_owned),
        clip_path: v["clip_path"].as_str().map(str::to_owned),
        clip_end_time_epoch: parse_epoch_value(&v["clip_end_time_epoch"])
            .or_else(|| parse_epoch_value(&v["clip_end_time"])),
    })
}

/// Extract audio for a SessionReviewWindow dialogue selection change using Rust
/// FFmpeg + PauseHistory + FireRed/Silero VAD.
pub fn extract_audio_for_review(
    payload: &Value,
    config: &ProfileConfig,
    tools: &MediaTools,
    pauses: &PauseHistory,
    vad: &VadSystem,
    http_client: &reqwest::Client,
) -> Result<Value, String> {
    let video_path = PathBuf::from(
        payload["video_path"]
            .as_str()
            .ok_or("missing video_path")?,
    );
    let game_line =
        parse_game_line_value(&payload["game_line"]).ok_or("invalid game_line")?;
    let next_line_epoch = parse_epoch_value(&payload["next_line_time"]);
    let anki_card_creation_epoch = parse_epoch_value(&payload["anki_card_creation_time"]);
    let mined_line = payload
        .get("mined_line")
        .and_then(parse_game_line_value);
    let full_text = payload["full_text"].as_str().unwrap_or(&game_line.text);
    let game_name = payload["game_name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(&game_line.scene);
    let result = extract_replay_audio(
        tools,
        vad,
        pauses,
        &video_path,
        &game_line,
        next_line_epoch,
        anki_card_creation_epoch,
        mined_line.as_ref(),
        full_text,
        game_name,
        config,
        Some(http_client),
    )?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// Capture a saved replay into one or more pending session review entries'
/// `future/` folders (matching `session_review_context.py::capture_replay`).
pub fn attach_future_replay(
    data_dir: &Path,
    video_path: &Path,
    targets: &[Value],
    tools: &MediaTools,
    pauses: &PauseHistory,
) -> Result<usize, String> {
    if !video_path.is_file() || targets.is_empty() {
        return Ok(0);
    }
    let capture_end_epoch = file_mtime_epoch(video_path)
        .ok_or_else(|| format!("stat {}", video_path.display()))?;
    let duration = tools.get_video_duration(video_path).max(0.0);
    let capture_start_epoch = capture_end_epoch - duration;
    let pause_spans: Vec<[f64; 2]> = pauses
        .get_pauses_between(capture_start_epoch, capture_end_epoch)
        .into_iter()
        .map(|(a, b)| [a, b])
        .collect();
    let root = review_root(data_dir);
    let mut attached = 0usize;

    let parse_line_epoch = |line: &Value| -> Option<f64> {
        let s = line["time"].as_str()?;
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
            .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
            .ok()
            .and_then(|ndt| Local.from_local_datetime(&ndt).single())
            .map(|dt| dt.timestamp() as f64 + f64::from(dt.timestamp_subsec_nanos()) * 1e-9)
            .or_else(|| parse_iso_to_epoch(s))
    };

    for target in targets {
        let Some(entry_id) = target["entry_id"].as_str() else {
            continue;
        };
        let entry_folder = root.join(entry_id);
        let review_json_path = entry_folder.join("review.json");
        let Ok(raw_review) = fs::read_to_string(&review_json_path) else {
            continue;
        };
        let Ok(review_val) = serde_json::from_str::<Value>(&raw_review) else {
            continue;
        };
        if review_val["status"].as_str() != Some("pending") || entry_folder.join("future").exists() {
            continue;
        }
        let original_lines = target["original_lines"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let future_lines = target["future_lines"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let selected_ids: HashSet<String> = review_val["selected_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();

        let required_ok = original_lines
            .iter()
            .filter(|l| {
                l["id"]
                    .as_str()
                    .is_some_and(|id| selected_ids.contains(id))
            })
            .chain(future_lines.iter())
            .all(|l| {
                parse_line_epoch(l)
                    .is_some_and(|t| t >= capture_start_epoch && t <= capture_end_epoch)
            });
        if !required_ok {
            continue;
        }

        let staging = root.join(format!("future-{}", Uuid::new_v4().simple()));
        let staged = staging.join("future");
        if fs::create_dir_all(&staged).is_err() {
            continue;
        }
        let ext = video_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{e}"))
            .unwrap_or_else(|| ".mp4".into());
        let dest_name = format!("replay{ext}");
        let dest = staged.join(&dest_name);
        let copied = fs::hard_link(video_path, &dest).is_ok() || fs::copy(video_path, &dest).is_ok();
        if copied {
            let mut merged: HashMap<String, Value> = HashMap::new();
            for l in original_lines.into_iter().chain(future_lines.into_iter()) {
                if let Some(id) = l["id"].as_str() {
                    merged.insert(id.to_string(), l);
                }
            }
            let mut filtered: Vec<Value> = merged
                .into_values()
                .filter(|l| {
                    parse_line_epoch(l)
                        .is_some_and(|t| t >= capture_start_epoch && t <= capture_end_epoch)
                })
                .collect();
            filtered.sort_by(|a, b| {
                parse_line_epoch(a)
                    .unwrap_or(0.0)
                    .total_cmp(&parse_line_epoch(b).unwrap_or(0.0))
            });
            let manifest = json!({
                "clip": {
                    "file": dest_name,
                    "end_time": epoch_to_local_iso(capture_end_epoch),
                },
                "lines": filtered,
                "pauses": pause_spans,
            });
            if let Ok(text) = serde_json::to_string(&manifest) {
                if fs::write(staged.join("manifest.json"), text).is_ok()
                    && !entry_folder.join("future").exists()
                    && fs::rename(&staged, entry_folder.join("future")).is_ok()
                {
                    attached += 1;
                }
            }
        }
        let _ = fs::remove_dir_all(&staging);
    }
    Ok(attached)
}
