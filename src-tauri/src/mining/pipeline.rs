//! End-to-end native Rust Anki card mining pipeline.
//! Owns replay acquisition, audio/VAD/screenshot/animation/video generation,
//! AI translation, furigana, card confirmation, field grouping, AnkiConnect
//! media upload & commit, SQLite history updates, and notifications.

use super::furigana::generate_sentence_furigana;
use super::session_review::{self, epoch_to_local_iso, parse_game_line_value, PendingReviewHandle};
use super::MiningService;
use crate::anki_connect::Collection;
use crate::gui_dialog::{self, Dialog};
use gsm_history::mining::{GameCharacterInfo, MinedLine, NoteId};
use gsm_mining::ai::{is_successful_translation, CharacterContext};
use gsm_mining::clips::{get_clips_root, match_card_to_clip, replay_copy};
use gsm_mining::config::{
    find_anki_field_mismatch, persist_anki_field_repairs, AnkiCard, ProfileConfig,
};
use gsm_mining::ffmpeg::{wait_for_stable_file_async, MediaTools};
use gsm_mining::policy::{
    animated_prefetch_window, animated_requested_window, animated_target_window,
    apply_field_policy, build_selected_lines_sentence, build_sentence_audio_key,
    extract_replay_audio, field_should_write, find_same_selection_reuse_entry,
    force_set_field_value, handle_file_management, normalize_anki_sentence_line_breaks,
    prepare_anki_tags, put_selected_images_in_field, sentence_for_current_card_html,
    should_animate_screenshot, should_show_confirmation_dialog, window_contains, windows_match,
    AnkiUpdateResult, AudioEditContext, MediaAssets, ScreenshotMediaItem, ScreenshotSelection,
    SentenceAudioCacheEntry,
};
use gsm_mining::text::{
    find_matching_line, fix_overlay_whitespace, get_previous_context_line, media_filename_for_game,
    remove_html_and_cloze_tags, GameLine, SOURCE_OVERLAY,
};
use gsm_mining::vad::VadResult;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

struct MiningLog<'a> {
    app: &'a AppHandle,
    note_id: u64,
}

impl MiningLog<'_> {
    fn emit(&self, level: &str, message: std::fmt::Arguments<'_>) {
        crate::desktop_log::emit_rust(
            Some(self.app),
            "mining",
            level,
            &format!("Note {}: {message}", self.note_id),
        );
    }

    fn optional<T>(&self, stage: &str, result: Result<T, String>) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(error) => {
                self.emit("WARNING", format_args!("{stage} failed: {error}"));
                None
            }
        }
    }

    fn media_result<T>(&self, stage: &str, result: tauri::Result<Result<T, String>>) -> Option<T> {
        self.optional(stage, result.map_err(|e| e.to_string()).and_then(|r| r))
    }

    async fn upload(
        &self,
        collection: &Collection<'_>,
        kind: &str,
        path: &Path,
        filename: &str,
    ) -> Option<String> {
        let result =
            crate::anki_media::store_file(collection.client, collection.url, path, filename).await;
        if result.is_ok() {
            self.emit("DEBUG", format_args!("Uploaded {kind} to Anki"));
        }
        self.optional(&format!("{kind} upload"), result)
    }
}

fn now_epoch() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

pub(crate) async fn fetch_character_context(
    app: &AppHandle,
    service: &MiningService,
    config: &ProfileConfig,
    game_title: &str,
) -> CharacterContext {
    if game_title.trim().is_empty() {
        return CharacterContext::default();
    }
    let db_path = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("gsm.db");
    if !db_path.is_file() {
        return CharacterContext::default();
    }
    let history = app.state::<Arc<gsm_history::History>>().inner().clone();
    let title = game_title.to_string();
    let db_path_read = db_path.clone();
    let can_generate = config.ai.auto_generate_character_summary && config.ai.is_configured();
    let info: Option<GameCharacterInfo> = tauri::async_runtime::spawn_blocking(move || {
        let val = history
            .run(
                &db_path_read,
                gsm_history::Request::GameCharacterContext {
                    game_title: title,
                    include_character_data: can_generate,
                },
            )
            .ok()?;
        serde_json::from_value(val).ok()
    })
    .await
    .ok()
    .flatten();

    let Some(info) = info else {
        return CharacterContext::default();
    };
    if is_successful_translation(&info.character_summary) {
        return CharacterContext {
            summary: info.character_summary,
            names: info.character_names,
        };
    }
    if !can_generate || info.vndb_character_data.trim().is_empty() {
        return CharacterContext::default();
    }
    {
        let mut attempts = service.character_summary_attempts.lock().unwrap();
        // Automatic retries should not issue a second provider request on every dialogue line.
        let retry_after = Duration::from_secs(5 * 60);
        attempts.retain(|_, started| started.elapsed() < retry_after);
        if attempts.contains_key(&info.game_id) {
            return CharacterContext::default();
        }
        attempts.insert(info.game_id.clone(), Instant::now());
    }
    let Ok(data) = serde_json::from_str(&info.vndb_character_data) else {
        crate::desktop_log::warn(
            app,
            "mining",
            format!("Invalid character data for game {}", info.game_id),
        );
        return CharacterContext::default();
    };
    let summary = match service
        .ai
        .generate_character_summary(&config.ai, &data)
        .await
    {
        Ok(Some(summary)) => summary,
        Ok(None) => return CharacterContext::default(),
        Err(error) => {
            crate::desktop_log::warn(
                app,
                "mining",
                format!(
                    "Character summary failed for game {}: {error}",
                    info.game_id
                ),
            );
            return CharacterContext::default();
        }
    };
    let history = app.state::<Arc<gsm_history::History>>().inner().clone();
    let game_id = info.game_id.clone();
    let to_save = summary.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _ = history.run(
            &db_path,
            gsm_history::Request::SaveGameCharacterSummary {
                game_id,
                summary: to_save,
                expected_summary: info.character_summary,
            },
        );
    })
    .await;
    CharacterContext {
        summary,
        names: info.character_names,
    }
}

fn check_tags_for_should_update(card: &AnkiCard, config: &ProfileConfig) -> bool {
    let card_tags_lower: Vec<String> = card.tags.iter().map(|t| t.to_lowercase()).collect();
    if !config.anki.tags_to_check.is_empty() {
        let matched = config
            .anki
            .tags_to_check
            .iter()
            .any(|req| card_tags_lower.iter().any(|ct| ct == &req.to_lowercase()));
        if !matched {
            return false;
        }
    }
    true
}

fn game_line_to_dialog_json(line: &GameLine) -> Value {
    json!({
        "id": line.id,
        "text": line.text,
        "time": epoch_to_local_iso(line.time_epoch),
        "time_epoch": line.time_epoch,
        "scene": line.scene,
        "source": line.source,
        "source_padding": line.effective_padding(),
        "session_id": line.session_id,
        "first_seen_time": line.first_seen_time_epoch.map(epoch_to_local_iso),
        "prev_id": line.prev_id,
        "next_id": line.next_id,
        "clip_folder": line.clip_folder,
        "clip_path": line.clip_path,
    })
}

pub(crate) fn parse_screenshot_return(v: &Value) -> (String, Option<ScreenshotSelection>) {
    if let Some(s) = v.as_str() {
        return (s.to_string(), None);
    }
    if let Some(obj) = v.as_object() {
        let source_path = obj
            .get("source_path")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let items: Vec<ScreenshotMediaItem> = obj
            .get("items")
            .and_then(|x| x.as_array())
            .into_iter()
            .flatten()
            .filter_map(|item| {
                let path = item.get("path")?.as_str()?.to_string();
                let start = item.get("start").and_then(|n| n.as_f64()).unwrap_or(0.0);
                Some(ScreenshotMediaItem { path, start })
            })
            .collect();
        if !items.is_empty() {
            let primary = items[0].path.clone();
            return (primary, Some(ScreenshotSelection { source_path, items }));
        }
        return (source_path, None);
    }
    (String::new(), None)
}

pub(crate) async fn fetch_card_by_id(
    client: &reqwest::Client,
    url: &reqwest::Url,
    note_id: u64,
) -> Result<Option<AnkiCard>, String> {
    let collection = Collection { client, url };
    collection
        .call("notesInfo", json!({ "notes": [note_id] }), move |raw| {
            let arr: Vec<Value> = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
            let Some(first) = arr.first() else {
                return Ok(None);
            };
            if first.is_null() || first.as_object().is_some_and(|o| o.is_empty()) {
                return Ok(None);
            }
            AnkiCard::from_anki_connect(first).map(Some)
        })
        .await
}

pub(crate) async fn anki_active_profile(
    client: &reqwest::Client,
    url: &reqwest::Url,
) -> Result<String, String> {
    let collection = Collection { client, url };
    collection
        .call("getActiveProfile", json!({}), |raw| {
            serde_json::from_str::<String>(raw.get()).map_err(|e| e.to_string())
        })
        .await
}

async fn anki_delete_note(
    client: &reqwest::Client,
    url: &reqwest::Url,
    note_id: u64,
) -> Result<(), String> {
    let collection = Collection { client, url };
    collection
        .call("deleteNotes", json!({ "notes": [note_id] }), |_| Ok(()))
        .await
}

pub(crate) async fn anki_gui_deselect_if_open(
    client: &reqwest::Client,
    url: &reqwest::Url,
    note_id: u64,
) {
    let collection = Collection { client, url };
    let selected: Vec<u64> = collection
        .call("guiSelectedNotes", json!({}), |raw| {
            Ok(serde_json::from_str::<Vec<u64>>(raw.get()).unwrap_or_default())
        })
        .await
        .unwrap_or_default();
    if selected.contains(&note_id) {
        let _ = collection
            .call("guiBrowse", json!({ "query": "nid:1" }), |_| Ok(()))
            .await;
    }
}

async fn run_post_update_gui_actions(
    client: &reqwest::Client,
    url: &reqwest::Url,
    note_id: u64,
    config: &ProfileConfig,
) {
    let collection = Collection { client, url };
    if config.features.open_anki_in_browser {
        let _ = collection
            .call(
                "guiBrowse",
                json!({ "query": format!("nid:{note_id}") }),
                |_| Ok(()),
            )
            .await;
    }
    if config.features.open_anki_edit {
        let _ = collection
            .call("guiEditNote", json!({ "note": note_id }), |_| Ok(()))
            .await;
    }
}

pub fn spawn_card_processing(
    app: AppHandle,
    service: Arc<MiningService>,
    note_id: u64,
    event: Option<gsm_mining::beacon::BeaconNoteEvent>,
) {
    if !service.claim_note(note_id) {
        crate::desktop_log::background(
            &app,
            "mining",
            format!("Note {note_id}: Skipped duplicate mining delivery"),
        );
        return;
    }
    tauri::async_runtime::spawn(async move {
        let log = MiningLog { app: &app, note_id };
        let started = Instant::now();
        let source = if event.is_some() {
            "AnkiBeacon"
        } else {
            "AnkiConnect polling"
        };
        log.emit("INFO", format_args!("Mining started via {source}"));
        if let Err(err) = process_card(&app, &service, note_id, event, &log).await {
            log.emit(
                "ERROR",
                format_args!("Mining failed after {:.2?}: {err}", started.elapsed()),
            );
            crate::app_lifecycle::notify_mining_event(
                &app,
                "AnkiEnhancementFailed",
                "Card error",
                &format!("Anki card enhancement failed: {err}"),
                None,
                None,
            );
        } else {
            log.emit(
                "DEBUG",
                format_args!("Mining processing ended after {:.2?}", started.elapsed()),
            );
        }
    });
}

async fn process_card(
    app: &AppHandle,
    service: &Arc<MiningService>,
    note_id: u64,
    event: Option<gsm_mining::beacon::BeaconNoteEvent>,
    log: &MiningLog<'_>,
) -> Result<(), String> {
    let data_dir = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .clone();
    let config_path = data_dir.join("config.json");
    let mut config = service.load_config()?;
    if !config.anki.enabled {
        log.emit(
            "INFO",
            format_args!("Skipped because Anki mining is disabled"),
        );
        return Ok(());
    }
    let anki_url = reqwest::Url::parse(&config.anki.url)
        .map_err(|e| format!("Invalid AnkiConnect URL: {e}"))?;
    let http = app
        .state::<crate::desktop_state::DesktopState>()
        .http
        .clone();
    let collection = Collection {
        client: &http,
        url: &anki_url,
    };

    let mut card = match event
        .as_ref()
        .and_then(|e| AnkiCard::from_beacon_payload(&e.payload))
    {
        Some(c) if !c.fields.is_empty() => c,
        _ => {
            log.emit(
                "DEBUG",
                format_args!("Fetching note fields from AnkiConnect"),
            );
            match fetch_card_by_id(&http, &anki_url, note_id)
                .await
                .map_err(|error| {
                    // A failed lookup precedes all Anki writes, so a redelivery can safely resolve it again.
                    service.retry_note_lookup(note_id);
                    error
                })? {
                Some(c) => c,
                None => {
                    log.emit(
                        "INFO",
                        format_args!("Skipped because the note no longer exists in Anki"),
                    );
                    return Ok(());
                }
            }
        }
    };

    // Auto-repair capitalization / casing drift on configured Anki field names.
    let repairs = card.repair_config_fields(&mut config.anki);
    if !repairs.is_empty() {
        if log
            .optional(
                "Saving Anki field name corrections",
                persist_anki_field_repairs(&config_path, &config.name, &repairs)
                    .map_err(|e| e.to_string()),
            )
            .is_some()
        {
            log.emit(
                "DEBUG",
                format_args!("Applied {} Anki field name corrections", repairs.len()),
            );
        }
        service.invalidate_config_cache();
    }

    if !check_tags_for_should_update(&card, &config) {
        log.emit(
            "INFO",
            format_args!("Skipped by the profile's Anki tag rules"),
        );
        return Ok(());
    }

    // Warn once per (profile, model) if configured fields do not exist on this note type.
    let available_fields: Vec<String> = card.fields.iter().map(|(k, _)| k.clone()).collect();
    if let Some(mismatch) = find_anki_field_mismatch(&config, &card.model_name, &available_fields) {
        let key = format!("{}::{}", config.name, card.model_name);
        let should_prompt = service.mismatch_prompted.lock().unwrap().insert(key);
        if should_prompt {
            let missing = mismatch
                .missing_fields()
                .into_iter()
                .map(|(l, n)| format!("{l} ({n})"))
                .collect::<Vec<_>>()
                .join(", ");
            log.emit(
                "WARNING",
                format_args!(
                    "Anki field mismatch on note type '{}': missing {missing}",
                    card.model_name
                ),
            );
            let prompt_app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = gui_dialog::open(&prompt_app, Dialog::RecommendedAnkiSetup).await;
            });
        }
    }

    let word = card
        .get_field(&config.anki.word.name)
        .unwrap_or("")
        .to_string();
    let word_plain = remove_html_and_cloze_tags(&word);
    let _word_guard = service.track_word_in_progress(&word_plain);

    let card_created_epoch = now_epoch();

    let snapshot = app.state::<crate::text_intake::Intake>().mining_context();
    let obs_scene = app.state::<crate::obs::Obs>().current_scene_name();
    let game_name = if !obs_scene.is_empty() {
        obs_scene.clone()
    } else if !snapshot.current_game.trim().is_empty() {
        snapshot.current_game.clone()
    } else {
        "Unknown".to_string()
    };

    let overlay_tag = card.tags.iter().any(|t| t.eq_ignore_ascii_case("overlay"));
    let card_sentence_raw = card
        .get_field(&config.anki.sentence.name)
        .unwrap_or("")
        .to_string();
    let card_sentence_plain = remove_html_and_cloze_tags(&card_sentence_raw);

    // Match card to lines (mirrors Python's `_resolve_mined_line_for_card` & `get_matching_line`).
    let mut selected_lines: Vec<GameLine> = snapshot.selected_lines;
    let mut matched_clip = None;
    let mut all_lines = snapshot.lines;

    let replay_len = if snapshot.replay_buffer_length > 0.0 {
        snapshot.replay_buffer_length
    } else {
        config.obs.replay_buffer_duration_seconds as f64
    };
    let overlay_scan_line = snapshot.last_overlay_scan_line.filter(|scan| {
        !card_sentence_plain.is_empty()
            && gsm_mining::text::lines_match(&scan.text, &card_sentence_plain)
    });

    let candidate_pool: Vec<GameLine> = {
        let base = if !selected_lines.is_empty() {
            &selected_lines
        } else {
            &all_lines
        };
        if overlay_tag {
            let non_overlay: Vec<GameLine> = base
                .iter()
                .filter(|l| l.source.as_deref() != Some(SOURCE_OVERLAY))
                .cloned()
                .collect();
            if !non_overlay.is_empty() {
                non_overlay
            } else {
                base.clone()
            }
        } else {
            base.clone()
        }
    };

    let mut match_source = if selected_lines.is_empty() {
        "recent dialogue"
    } else {
        "selected dialogue"
    };
    let mut mined_line: Option<GameLine> = find_matching_line(
        &card,
        &config.anki,
        &candidate_pool,
        overlay_tag,
        true,
        replay_len,
        0.0,
    )
    .cloned()
    .or_else(|| {
        if let Some(scan_line) = overlay_scan_line.clone() {
            match_source = "last overlay scan";
            return Some(scan_line);
        }
        if selected_lines.is_empty() && !card_sentence_plain.is_empty() {
            if let Some(clips_root) = get_clips_root(&config) {
                if let Some((clip_line, clip)) = match_card_to_clip(&card, &config, &clips_root) {
                    all_lines = clip.lines.clone();
                    matched_clip = Some(clip);
                    match_source = "saved clip";
                    return Some(clip_line);
                }
            }
        }
        if overlay_tag && !card_sentence_plain.is_empty() {
            match_source = "overlay timing estimate";
            log.emit("WARNING", format_args!(
                    "No matching line was found within the replay buffer. \
                     Using overlay text with estimated audio and screenshot timing; review both before saving."
            ));
            return Some(GameLine {
                id: format!("overlay-{}", card.note_id),
                text: card_sentence_plain.clone(),
                time_epoch: card_created_epoch,
                index: -1,
                scene: game_name.clone(),
                source: Some(SOURCE_OVERLAY.to_string()),
                source_padding: Some(3.0),
                mined_time_epoch: Some(card_created_epoch),
                excluded_from_stats: true,
                session_id: String::new(),
                first_seen_time_epoch: Some(card_created_epoch),
                translation: String::new(),
                prev_id: None,
                next_id: None,
                clip_folder: None,
                clip_path: None,
                clip_end_time_epoch: None,
            });
        }
        match_source = "latest dialogue fallback";
        candidate_pool.last().cloned()
    });

    if let Some(ref mut ml) = mined_line {
        if ml.mined_time_epoch.is_none() {
            ml.mined_time_epoch = Some(ml.clip_end_time_epoch.unwrap_or(card_created_epoch));
        }
    }

    let Some(mined_line) = mined_line else {
        log.emit(
            "INFO",
            format_args!("Skipped because no matching dialogue line was found"),
        );
        return Ok(());
    };
    log.emit(
        "INFO",
        format_args!(
            "Selected dialogue via {match_source} (line={}, source={}, selected={})",
            mined_line.id,
            mined_line.source.as_deref().unwrap_or("unknown"),
            selected_lines.len()
        ),
    );

    let mut effective_game_name = if !mined_line.scene.trim().is_empty() {
        mined_line.scene.clone()
    } else {
        game_name
    };
    if effective_game_name.trim().is_empty() {
        effective_game_name = "Unknown".to_string();
    }

    let mut previous_line =
        get_previous_context_line(&mined_line, &selected_lines, &all_lines).cloned();
    let multi_line = selected_lines.len() > 1;
    let (initial_note_fields, written_sentence) = gsm_mining::policy::prepare_initial_card_fields(
        &mut card,
        &selected_lines,
        &mined_line,
        previous_line.as_ref(),
        None,
        &config,
    );
    let mut sentence = written_sentence
        .or_else(|| initial_note_fields.get(&config.anki.sentence.name).cloned())
        .unwrap_or_else(|| {
            if !card_sentence_raw.trim().is_empty() {
                card_sentence_raw.clone()
            } else {
                mined_line.text.clone()
            }
        });
    let mut dialog_edited_sentence = false;

    let start_line = selected_lines.first().unwrap_or(&mined_line).clone();
    let last_selected = selected_lines.last().unwrap_or(&mined_line).clone();
    let mined_cutoff_epoch = last_selected
        .clip_end_time_epoch
        .unwrap_or(card_created_epoch);
    let next_line_epoch = last_selected.next_id.as_deref().and_then(|nid| {
        all_lines
            .iter()
            .find(|l| l.id == nid && l.time_epoch < mined_cutoff_epoch)
            .map(|l| l.time_epoch)
    });

    // --- Same-line reuse check (wait if another card for this line is actively processing) ---
    let line_id = mined_line.id.clone();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let is_inflight = service.in_flight_lines.lock().unwrap().contains(&line_id);
        if !is_inflight || Instant::now() >= deadline {
            break;
        }
        let notified = service.result_notify.notified();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let _ = tokio::time::timeout(remaining, notified).await;
    }

    // Mark this line in-flight while we process it.
    let _inflight_guard = service.mark_line_in_flight(&line_id);

    let prior_result: Option<AnkiUpdateResult> =
        service.results.lock().unwrap().get(&line_id).cloned();
    let sentence_cache_key = build_sentence_audio_key(&mined_line, &selected_lines);
    let prior_selection_result: Option<(String, AnkiUpdateResult)> =
        sentence_cache_key.as_ref().and_then(|k| {
            let cache = service.sentence_audio_cache.lock().unwrap();
            let entry = find_same_selection_reuse_entry(&cache, k, &word_plain)?;
            let target_id = entry.line_id.clone();
            drop(cache);
            let res = service.results.lock().unwrap().get(&target_id).cloned()?;
            Some((target_id, res))
        });

    let mut assets = MediaAssets {
        game_name: effective_game_name.clone(),
        ..Default::default()
    };

    if !config.review_after_session_enabled() {
        if let Some(ref prev) = prior_result {
            if prev.success && prev.multi_line == multi_line && prev.word != word_plain {
                if !prev.audio_in_anki.is_empty() {
                    assets.audio_in_anki = prev.audio_in_anki.clone();
                    assets.reused_audio = true;
                    assets.reused_audio_result_id = line_id.clone();
                }
                if !prev.screenshot_in_anki.is_empty() {
                    assets.screenshot_in_anki = prev.screenshot_in_anki.clone();
                    assets.screenshot_media_in_anki = prev.screenshot_media_in_anki.clone();
                    assets.reused_screenshot = true;
                    assets.reused_screenshot_result_id = line_id.clone();
                }
                if !prev.prev_screenshot_in_anki.is_empty() {
                    assets.prev_screenshot_in_anki = prev.prev_screenshot_in_anki.clone();
                    assets.prev_screenshot_media_in_anki =
                        prev.prev_screenshot_media_in_anki.clone();
                }
            }
        }
        if let Some((ref reuse_id, ref reuse_res)) = prior_selection_result {
            if reuse_res.success {
                if !assets.reused_audio
                    && config
                        .anki
                        .reuse_audio_for_same_selected_lines_different_mined_line
                    && !reuse_res.audio_in_anki.is_empty()
                {
                    assets.audio_in_anki = reuse_res.audio_in_anki.clone();
                    assets.reused_audio = true;
                    assets.reused_audio_result_id = reuse_id.clone();
                }
                if !assets.reused_screenshot
                    && config
                        .anki
                        .reuse_screenshot_for_same_selected_lines_different_mined_line
                    && !reuse_res.screenshot_in_anki.is_empty()
                {
                    assets.screenshot_in_anki = reuse_res.screenshot_in_anki.clone();
                    assets.screenshot_media_in_anki = reuse_res.screenshot_media_in_anki.clone();
                    assets.reused_screenshot = true;
                    assets.reused_screenshot_result_id = reuse_id.clone();
                }
            }
        }
    }

    // --- Concurrent Rust AI Translation ---
    let mut ai_task = None;
    let existing_translation = if !config.ai.anki_field.is_empty() {
        card.get_field(&config.ai.anki_field)
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    let want_ai = config.ai.add_to_anki
        && !config.ai.anki_field.trim().is_empty()
        && existing_translation.trim().is_empty();
    if want_ai {
        let ai_app = app.clone();
        let ai_service = Arc::clone(service);
        let ai_cfg = config.clone();
        let ai_lines = all_lines.clone();
        let ai_sentence = if selected_lines.is_empty() {
            sentence_for_current_card_html(&card, &mined_line.text, &config.anki)
        } else {
            build_selected_lines_sentence(&card, &selected_lines, &config)
        };
        let ai_line = mined_line.clone();
        let ai_game = effective_game_name.clone();
        ai_task = Some(tauri::async_runtime::spawn(async move {
            let char_ctx = fetch_character_context(&ai_app, &ai_service, &ai_cfg, &ai_game).await;
            ai_service
                .ai
                .translate(
                    &ai_cfg,
                    &ai_lines,
                    &ai_sentence,
                    Some(&ai_line),
                    &ai_game,
                    &char_ctx,
                    None,
                    false,
                    false,
                )
                .await
        }));
    }

    // --- Determine if we need a replay video ---
    let want_audio = config.audio.enabled
        && !assets.reused_audio
        && field_should_write(&card, "sentence_audio_field", &HashMap::new(), &config.anki);
    let want_screenshot = config.screenshot.enabled
        && !assets.reused_screenshot
        && field_should_write(&card, "picture_field", &HashMap::new(), &config.anki);
    let want_prev_screenshot = config.screenshot.enabled
        && previous_line.is_some()
        && assets.prev_screenshot_in_anki.is_empty()
        && field_should_write(&card, "previous_image_field", &HashMap::new(), &config.anki);
    let want_video_field = field_should_write(&card, "video_field", &HashMap::new(), &config.anki);
    let need_replay = want_audio || want_screenshot || want_prev_screenshot || want_video_field;
    log.emit("DEBUG", format_args!(
        "Enhancement plan: audio={want_audio}, screenshot={want_screenshot}, previous_screenshot={want_prev_screenshot}, video={want_video_field}, ai={want_ai}, reused_audio={}, reused_screenshot={}",
        assets.reused_audio, assets.reused_screenshot
    ));

    let temp_dir = service.temp_dir();
    let media_tools = MediaTools::discover(
        Some(&app.state::<crate::settings::Settings>().paths.shared),
        temp_dir.clone(),
    );

    let mut video_path: Option<PathBuf> = None;
    let mut remove_video_after = false;

    if need_replay {
        let replay_started = Instant::now();
        if let Some(ref clip) = matched_clip {
            log.emit("INFO", format_args!("Preparing replay from a saved clip"));
            let clip_copy = replay_copy(clip, &temp_dir, &service.pause_history)?;
            video_path = Some(clip_copy);
            remove_video_after = true;
        } else {
            log.emit("INFO", format_args!("Requesting the OBS replay buffer"));
            let obs_res = app.state::<crate::obs::Obs>().save_replay(app).await;
            match obs_res {
                Ok(val) => {
                    if let Some(saved_path) = val["savedReplayPath"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                    {
                        let p = PathBuf::from(saved_path);
                        let _ = wait_for_stable_file_async(
                            p.clone(),
                            Duration::from_secs(10),
                            Duration::from_millis(100),
                        )
                        .await;
                        if p.is_file() {
                            video_path = Some(p);
                            remove_video_after = config.paths.remove_video;
                        }
                    }
                }
                Err(err) => {
                    log.emit(
                        "WARNING",
                        format_args!("OBS SaveReplayBuffer failed: {err}"),
                    );
                }
            }
        }
        if video_path.is_some() {
            log.emit(
                "INFO",
                format_args!("Replay ready after {:.2?}", replay_started.elapsed()),
            );
        } else {
            log.emit(
                "WARNING",
                format_args!(
                    "No replay file available after {:.2?}; continuing without new replay media",
                    replay_started.elapsed()
                ),
            );
        }
    }

    if let Some(ref vp) = video_path {
        assets.source_video_path = vp.to_string_lossy().into_owned();
    }

    // --- Serialized card processing lane (media extraction + confirmation + grouping) ---
    let mut vad_result: Option<VadResult> = None;
    let mut audio_edit_context: Option<AudioEditContext> = None;
    let mut start_time = 0.0_f64;
    let mut end_time = 0.0_f64;
    let mut ss_time = 0.0_f64;
    let mut translation = existing_translation;
    let mut use_voice = assets.reused_audio;
    let mut nsfw = false;
    let mut review_handle: Option<PendingReviewHandle> = None;
    let mut grouping_target: Option<(u64, bool, bool, bool)> = None;
    let mut animated_prefetch_task: Option<
        tauri::async_runtime::JoinHandle<Result<PathBuf, String>>,
    > = None;

    {
        let waiting_since = Instant::now();
        let _lane_guard = service.card_lane.lock().await;
        log.emit(
            "DEBUG",
            format_args!(
                "Entered card preparation after {:.2?}",
                waiting_since.elapsed()
            ),
        );

        if let Some(ref vp) = video_path {
            let extraction_started = Instant::now();
            // Parallel extraction of audio+VAD and raw PNG screenshots!
            let audio_handle = if want_audio {
                let tools_c = media_tools.clone();
                let vad_c = Arc::clone(&service.vad);
                let pauses_c = Arc::clone(&service.pause_history);
                let vp_c = vp.clone();
                let sl_c = start_line.clone();
                let ml_c = mined_line.clone();
                let full_txt = remove_html_and_cloze_tags(&sentence);
                let gn = effective_game_name.clone();
                let cfg_c = config.clone();
                let http_c = http.clone();
                Some(tauri::async_runtime::spawn_blocking(move || {
                    extract_replay_audio(
                        &tools_c,
                        &vad_c,
                        &pauses_c,
                        &vp_c,
                        &sl_c,
                        next_line_epoch,
                        Some(card_created_epoch),
                        Some(&ml_c),
                        &full_txt,
                        &gn,
                        &cfg_c,
                        Some(&http_c),
                    )
                }))
            } else {
                None
            };

            let ss_handle = if want_screenshot {
                let tools_c = media_tools.clone();
                let vp_c = vp.clone();
                let ml_c = mined_line.clone();
                let cfg_c = config.clone();
                let gn = effective_game_name.clone();
                Some(tauri::async_runtime::spawn_blocking(move || {
                    let ts = tools_c.get_screenshot_time(
                        &vp_c,
                        Some(&ml_c),
                        next_line_epoch,
                        false,
                        Some(card_created_epoch),
                        &cfg_c,
                    );
                    let raw = tools_c.get_raw_screenshot(&vp_c, ts, &gn)?;
                    Ok::<(f64, PathBuf), String>((ts, raw))
                }))
            } else {
                None
            };

            let prev_ss_handle = if want_prev_screenshot {
                if let Some(ref pl) = previous_line {
                    let tools_c = media_tools.clone();
                    let vp_c = vp.clone();
                    let pl_c = pl.clone();
                    let next_ep = Some(start_line.time_epoch);
                    let cfg_c = config.clone();
                    let gn = effective_game_name.clone();
                    Some(tauri::async_runtime::spawn_blocking(move || {
                        let ts = tools_c.get_screenshot_time(
                            &vp_c,
                            Some(&pl_c),
                            next_ep,
                            false,
                            Some(card_created_epoch),
                            &cfg_c,
                        );
                        let raw = tools_c.get_raw_screenshot(&vp_c, ts, &gn)?;
                        Ok::<(f64, PathBuf), String>((ts, raw))
                    }))
                } else {
                    None
                }
            } else {
                None
            };

            if let Some(h) = audio_handle {
                match h.await.map_err(|e| e.to_string())? {
                    Ok(res) => {
                        log.emit("DEBUG", format_args!(
                            "Audio extraction: replay={:.2}–{:.2}s, VAD={}, detected_voice={}, VAD_success={}, voice={:.2}–{:.2}s, segments={}, TTS={}, output={}",
                            res.start_time, res.end_time, res.vad_result.model,
                            res.vad_result.voice_detected, res.vad_result.success,
                            res.vad_result.start, res.vad_result.end, res.vad_result.segments.len(),
                            res.vad_result.tts_used, !res.final_audio_output.is_empty()
                        ));
                        if !res.vad_result.error.is_empty() {
                            log.emit(
                                "WARNING",
                                format_args!("VAD reported: {}", res.vad_result.error),
                            );
                        }
                        assets.audio_path = res.final_audio_output.clone();
                        start_time = res.start_time;
                        end_time = res.end_time;
                        use_voice = res.vad_result.success || !res.final_audio_output.is_empty();
                        vad_result = Some(res.vad_result);
                        audio_edit_context = res.audio_edit_context;
                    }
                    Err(e) => {
                        log.emit("WARNING", format_args!("Audio extraction failed: {e}"));
                    }
                }
            }

            if let Some(h) = ss_handle {
                match h.await.map_err(|e| e.to_string())? {
                    Ok((ts, raw_path)) => {
                        ss_time = ts;
                        assets.screenshot_timestamp = ts;
                        assets.screenshot_path = raw_path.to_string_lossy().into_owned();
                    }
                    Err(e) => {
                        log.emit("WARNING", format_args!("Screenshot extraction failed: {e}"));
                    }
                }
            }

            if let Some(h) = prev_ss_handle {
                if let Some((ts, raw_path)) =
                    log.media_result("Previous screenshot extraction", h.await)
                {
                    assets.prev_screenshot_timestamp = ts;
                    assets.prev_screenshot_path = raw_path.to_string_lossy().into_owned();
                }
            }

            // Prepare animated / video timing windows.
            let vad_s = vad_result.as_ref().map(|v| v.start).unwrap_or(0.0);
            let vad_e = vad_result
                .as_ref()
                .map(|v| v.end)
                .unwrap_or_else(|| (end_time - start_time).max(0.0));
            if want_screenshot && should_animate_screenshot(&config, vad_result.as_ref()) {
                assets.pending_animated = true;
                assets.animated = true;
                assets.animated_video_path = vp.to_string_lossy().into_owned();
                assets.animated_start_time = start_time;
                assets.animated_vad_start = vad_s;
                assets.animated_vad_end = vad_e;
            }
            if want_video_field {
                assets.pending_video = true;
                assets.video = true;
                assets.video_start_time = start_time;
                assets.video_vad_start = vad_s;
                assets.video_vad_end = vad_e;
            }
            log.emit("INFO", format_args!(
                "Replay extraction finished after {:.2?} (audio={}, screenshot={}, previous_screenshot={}, animated={}, video={})",
                extraction_started.elapsed(), !assets.audio_path.is_empty(), !assets.screenshot_path.is_empty(),
                !assets.prev_screenshot_path.is_empty(), assets.pending_animated, assets.pending_video
            ));
            log.emit(
                "DEBUG",
                format_args!(
                    "Screenshot timestamps: current={ss_time:.2}s, previous={:.2}s",
                    assets.prev_screenshot_timestamp
                ),
            );
        }

        // Resolve AI translation before confirmation dialog (or durable review save).
        if let Some(task) = ai_task.take() {
            match task.await {
                Ok(result)
                    if !result.trim().is_empty() && !result.starts_with("Processing failed:") =>
                {
                    translation = result;
                    log.emit("DEBUG", format_args!("AI translation ready"));
                }
                Ok(_) => log.emit(
                    "WARNING",
                    format_args!("AI translation returned no usable result"),
                ),
                Err(err) => log.emit("WARNING", format_args!("AI translation task failed: {err}")),
            }
        }

        let show_confirm =
            should_show_confirmation_dialog(&config, vad_result.as_ref(), assets.reused_audio);

        // Durable Session Review save (if enabled, replaces immediate confirmation dialog).
        let mut review_fallback =
            config.features.review_after_session.enabled && !assets.reused_audio;
        if review_fallback && video_path.is_some() {
            if let Some(anki_profile) = log.optional(
                "Finding the Anki profile for session review",
                anki_active_profile(&http, &anki_url).await,
            ) {
                let tools_c = media_tools.clone();
                let pauses_c = Arc::clone(&service.pause_history);
                let data_c = data_dir.clone();
                let cfg_c = config.clone();
                let card_c = card.clone();
                let assets_c = assets.clone();
                let vp_c = video_path.clone().unwrap();
                let all_c = all_lines.clone();
                let ml_c = mined_line.clone();
                let sel_c = selected_lines.clone();
                let sent_c = sentence.clone();
                let tl_c = translation.clone();
                let vad_c = vad_result.clone();
                let edit_c = audio_edit_context.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    session_review::save_pending_review(
                        &data_c,
                        &anki_profile,
                        &cfg_c,
                        &card_c,
                        &assets_c,
                        &vp_c,
                        &all_c,
                        Some(&ml_c),
                        &sel_c,
                        &sent_c,
                        &tl_c,
                        ss_time,
                        start_time,
                        end_time,
                        vad_c.as_ref(),
                        edit_c.as_ref(),
                        &tools_c,
                        &pauses_c,
                    )
                })
                .await
                {
                    Ok(Ok(handle)) => {
                        log.emit("INFO", format_args!("Saved pending session review"));
                        review_handle = Some(handle);
                        review_fallback = false;
                    }
                    Ok(Err(err)) => {
                        log.emit("WARNING", format_args!("Session review save failed: {err}"));
                    }
                    Err(err) => {
                        log.emit("WARNING", format_args!("Session review task failed: {err}"));
                    }
                }
            }
        }
        if review_fallback {
            log.emit(
                "WARNING",
                format_args!("Pending session review unavailable; opening immediate confirmation"),
            );
        }

        // Prefetch animated screenshot in the background while the confirmation dialog is open.
        if (show_confirm || review_fallback) && assets.pending_animated {
            if let Some((req_start, req_end)) = animated_requested_window(&assets) {
                log.emit(
                    "DEBUG",
                    format_args!("Prefetching animated screenshot at {req_start:.2}–{req_end:.2}s"),
                );
                assets.animated_prefetch_start = req_start;
                assets.animated_prefetch_end = req_end;
                let tools_c = media_tools.clone();
                let vp_c = PathBuf::from(&assets.animated_video_path);
                let cfg_c = config.clone();
                let gn = effective_game_name.clone();
                animated_prefetch_task = Some(tauri::async_runtime::spawn_blocking(move || {
                    tools_c.video_to_animation(&vp_c, req_start, req_end, false, &gn, &cfg_c)
                }));
            }
        }

        // --- Immediate card confirmation ---
        if show_confirm || review_fallback {
            log.emit("INFO", format_args!("Opening card confirmation"));
            let dialog = Dialog::AnkiConfirmation {
                expression: word.clone(),
                sentence: sentence.clone(),
                screenshot_path: (!assets.screenshot_path.is_empty())
                    .then(|| assets.screenshot_path.clone()),
                previous_screenshot_path: (!assets.prev_screenshot_path.is_empty())
                    .then(|| assets.prev_screenshot_path.clone()),
                audio_path: (!assets.audio_path.is_empty()).then(|| assets.audio_path.clone()),
                translation: (!translation.is_empty()).then(|| translation.clone()),
                screenshot_timestamp: ss_time,
                previous_screenshot_timestamp: assets.prev_screenshot_timestamp,
                pending_animated: assets.pending_animated,
                reusing_audio: assets.reused_audio,
                reusing_screenshot: assets.reused_screenshot,
                overlay_only: mined_line.is_overlay(),
                video_path: video_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned()),
                start_time: Some(start_time),
                end_time: Some(end_time),
                vad_result: vad_result
                    .as_ref()
                    .and_then(|v| serde_json::to_value(v).ok()),
                audio_edit_context: audio_edit_context
                    .as_ref()
                    .and_then(|c| serde_json::to_value(c).ok()),
                mined_line: Some(game_line_to_dialog_json(&mined_line)),
                selected_lines: if selected_lines.is_empty() {
                    None
                } else {
                    Some(
                        selected_lines
                            .iter()
                            .map(game_line_to_dialog_json)
                            .collect(),
                    )
                },
                anki_card_creation_time: Some(epoch_to_local_iso(card_created_epoch)),
            };

            match gui_dialog::open(app, dialog).await {
                Ok(Value::Null) => {
                    log.emit(
                        "INFO",
                        format_args!("Card confirmation closed without an update"),
                    );
                    // User closed/cancelled without updating.
                    if remove_video_after {
                        if let Some(ref vp) = video_path {
                            let _ = std::fs::remove_file(vp);
                        }
                    }
                    return Ok(());
                }
                Ok(Value::Array(items)) if items.len() >= 7 => {
                    let meta = items.get(7).cloned().unwrap_or(Value::Null);
                    if meta["action"].as_str() == Some("delete_card")
                        || meta["delete_card"].as_bool() == Some(true)
                    {
                        anki_delete_note(&http, &anki_url, note_id).await?;
                        log.emit("INFO", format_args!("Deleted note at the user's request"));
                        service.forget_note(note_id);
                        if remove_video_after {
                            if let Some(ref vp) = video_path {
                                let _ = std::fs::remove_file(vp);
                            }
                        }
                        return Ok(());
                    }
                    if meta["action"].as_str() == Some("cancel") {
                        log.emit("INFO", format_args!("Card confirmation cancelled"));
                        if remove_video_after {
                            if let Some(ref vp) = video_path {
                                let _ = std::fs::remove_file(vp);
                            }
                        }
                        return Ok(());
                    }

                    use_voice = items[0].as_bool().unwrap_or(use_voice);
                    if let Some(s) = items[1].as_str() {
                        if s != sentence {
                            dialog_edited_sentence = true;
                        }
                        sentence = gsm_mining::policy::sentence_for_current_card_html(
                            &card,
                            s,
                            &config.anki,
                        );
                    }
                    if let Some(t) = items[2].as_str() {
                        translation = t.to_string();
                    }
                    let (ss_out, ss_sel) = parse_screenshot_return(&items[3]);
                    if !ss_out.is_empty() || ss_sel.is_some() {
                        if ss_sel.is_some() {
                            assets.reused_screenshot = false;
                            assets.screenshot_in_anki.clear();
                            assets.pending_animated = false;
                        }
                        assets.screenshot_path = ss_out;
                        assets.selected_screenshots = ss_sel;
                    }
                    let (prev_out, prev_sel) = parse_screenshot_return(&items[4]);
                    if !prev_out.is_empty() || prev_sel.is_some() {
                        assets.prev_screenshot_path = prev_out;
                        assets.selected_prev_screenshots = prev_sel;
                    }
                    nsfw = items[5].as_bool().unwrap_or(false);
                    if let Some(a) = items[6].as_str() {
                        if !a.is_empty() {
                            assets.audio_path = a.to_string();
                            assets.reused_audio = false;
                        }
                    }
                    if !use_voice {
                        assets.audio_path.clear();
                        assets.audio_in_anki.clear();
                        assets.reused_audio = false;
                    }
                    if let Some(range) = meta.get("audio_edit_range").and_then(|v| v.as_array()) {
                        if range.len() == 2 {
                            if let (Some(rs), Some(re)) = (range[0].as_f64(), range[1].as_f64()) {
                                if re > rs {
                                    assets.animated_target_start = rs;
                                    assets.animated_target_end = re;
                                }
                            }
                        }
                    }
                    if meta["reusing_audio"].as_bool() == Some(false) {
                        assets.reused_audio = false;
                    }
                    if meta["line_selection_changed"] == true {
                        if let Ok(audio) = serde_json::from_value::<
                            gsm_mining::policy::ReplayAudioResult,
                        >(meta["audio_result"].clone())
                        {
                            start_time = audio.start_time;
                            end_time = audio.end_time;
                            assets.animated_start_time = start_time;
                            assets.animated_vad_start = audio.vad_result.start;
                            assets.animated_vad_end = audio.vad_result.end;
                            assets.video_start_time = start_time;
                            assets.video_vad_start = audio.vad_result.start;
                            assets.video_vad_end = audio.vad_result.end;
                        }
                        if let Some(path) = meta["replay_path"].as_str().filter(|s| !s.is_empty()) {
                            if assets.animated_video_path != path {
                                assets.animated_prefetch_start = 0.;
                                assets.animated_prefetch_end = 0.;
                                assets.animated_video_path = path.into();
                            }
                            assets.source_video_path = path.into();
                        }
                    }
                    if let Some(sel_arr) = meta.get("selected_lines").and_then(|v| v.as_array()) {
                        let parsed: Vec<GameLine> =
                            sel_arr.iter().filter_map(parse_game_line_value).collect();
                        if !parsed.is_empty() {
                            selected_lines = parsed;
                            previous_line =
                                get_previous_context_line(&mined_line, &selected_lines, &all_lines)
                                    .cloned();
                        }
                    }
                    log.emit("INFO", format_args!(
                        "Card confirmed (keep_audio={use_voice}, edited_sentence={dialog_edited_sentence}, changed_selection={})",
                        meta["line_selection_changed"] == true
                    ));
                }
                Ok(other) => {
                    if other["action"] == "delete_card" {
                        anki_delete_note(&http, &anki_url, note_id).await?;
                        log.emit("INFO", format_args!("Deleted note at the user's request"));
                        service.forget_note(note_id);
                        if remove_video_after {
                            if let Some(ref vp) = video_path {
                                let _ = std::fs::remove_file(vp);
                            }
                        }
                        return Ok(());
                    }
                    log.emit(
                        "WARNING",
                        format_args!(
                            "Unexpected card confirmation reply; proceeding with automatic values"
                        ),
                    );
                }
                Err(err) => {
                    log.emit(
                        "WARNING",
                        format_args!(
                            "Card confirmation failed; proceeding with automatic values: {err}"
                        ),
                    );
                }
            }
        } else if review_handle.is_none() {
            log.emit(
                "DEBUG",
                format_args!("Skipping card confirmation per profile policy"),
            );
        }

        // A queued review groups the final context when the user confirms it.
        if review_handle.is_none() && config.anki.field_grouping_enabled && !word_plain.is_empty() {
            let oldest_only = config.anki.field_grouping_auto_merge;
            let candidates_result = crate::anki_group::find_candidates(
                app,
                &anki_url,
                note_id,
                &word_plain,
                &config.anki.word.name,
                &card.model_name,
                &config.anki.sentence.name,
                oldest_only,
            )
            .await;
            if let Some(candidates_val) =
                log.optional("Searching for duplicate notes", candidates_result)
            {
                if let Some(candidates) = candidates_val.as_array().filter(|a| !a.is_empty()) {
                    log.emit(
                        "DEBUG",
                        format_args!(
                            "Found {} field-grouping candidates (automatic={oldest_only})",
                            candidates.len()
                        ),
                    );
                    if oldest_only {
                        if let Some(target_id) = candidates[0]["note_id"].as_u64() {
                            let back = config
                                .anki
                                .field_grouping_order
                                .eq_ignore_ascii_case("back");
                            grouping_target = Some((
                                target_id,
                                back,
                                config.anki.field_grouping_overwrite,
                                config.anki.field_grouping_delete_duplicate,
                            ));
                        }
                    } else {
                        let dialog = Dialog::AnkiFieldGrouping {
                            expression: word_plain.clone(),
                            candidates: candidates.clone(),
                            default_order: Some(config.anki.field_grouping_order.clone()),
                            default_delete_duplicate: Some(
                                config.anki.field_grouping_delete_duplicate,
                            ),
                        };
                        if let Some(choice) = log.optional(
                            "Opening field grouping",
                            gui_dialog::open(app, dialog).await,
                        ) {
                            if let Some(target_id) = choice["target_note_id"]
                                .as_u64()
                                .or_else(|| choice["note_id"].as_u64())
                            {
                                let back = choice["order"]
                                    .as_str()
                                    .unwrap_or(&config.anki.field_grouping_order)
                                    .eq_ignore_ascii_case("back");
                                let del_dup = choice["delete_duplicate"]
                                    .as_bool()
                                    .unwrap_or(config.anki.field_grouping_delete_duplicate);
                                let overwrite = choice["overwrite"]
                                    .as_bool()
                                    .unwrap_or(config.anki.field_grouping_overwrite);
                                grouping_target = Some((target_id, back, overwrite, del_dup));
                            }
                        }
                    }
                }
            }
        }
    } // <-- Card lane released here; heavy encoding & Anki upload run asynchronously!

    // --- Stage 2: Encode media, upload to AnkiConnect, commit note, update SQLite ---
    let encoding_started = Instant::now();
    // 1) Resolve animated screenshot (reuse prefetch / trim / generate) or encode static PNG
    if !assets.reused_screenshot {
        if assets.pending_animated {
            let mut anim_path: Option<PathBuf> = None;
            let prefetched = match animated_prefetch_task {
                Some(task) => log.media_result("Animated screenshot prefetch", task.await),
                None => None,
            };
            let target_win =
                animated_target_window(&assets).or_else(|| animated_requested_window(&assets));
            let prefetch_win = animated_prefetch_window(&assets);

            if let (Some(pf_path), Some(pf_win), Some(tgt_win)) =
                (prefetched.as_ref(), prefetch_win, target_win)
            {
                if windows_match(pf_win, tgt_win) {
                    log.emit(
                        "DEBUG",
                        format_args!("Using the prefetched animated screenshot"),
                    );
                    anim_path = Some(pf_path.clone());
                } else if window_contains(pf_win, tgt_win) {
                    let tools_c = media_tools.clone();
                    let src = pf_path.clone();
                    let rel_s = (tgt_win.0 - pf_win.0).max(0.0);
                    let rel_dur = (tgt_win.1 - tgt_win.0).max(0.05);
                    let gn = effective_game_name.clone();
                    let cfg_c = config.clone();
                    let task = tauri::async_runtime::spawn_blocking(move || {
                        tools_c.trim_animation(&src, rel_s, rel_dur, &gn, &cfg_c)
                    });
                    if let Some(trimmed) =
                        log.media_result("Trimming prefetched animation", task.await)
                    {
                        log.emit(
                            "DEBUG",
                            format_args!("Trimmed the prefetched animated screenshot"),
                        );
                        anim_path = Some(trimmed);
                    }
                }
            }
            if anim_path.is_none() {
                if let Some((s, e)) = target_win {
                    let tools_c = media_tools.clone();
                    let vp_c = PathBuf::from(&assets.animated_video_path);
                    let gn = effective_game_name.clone();
                    let cfg_c = config.clone();
                    log.emit(
                        "DEBUG",
                        format_args!("Encoding animated screenshot at {s:.2}–{e:.2}s"),
                    );
                    let task = tauri::async_runtime::spawn_blocking(move || {
                        tools_c.video_to_animation(&vp_c, s, e, false, &gn, &cfg_c)
                    });
                    anim_path = log.media_result("Animated screenshot encoding", task.await);
                }
            }
            if let Some(p) = anim_path.filter(|p| p.is_file()) {
                assets.screenshot_path = p.to_string_lossy().into_owned();
            } else {
                log.emit(
                    "WARNING",
                    format_args!(
                        "No animated screenshot produced; keeping any available still image"
                    ),
                );
            }
        } else if let Some(ref sel) = assets.selected_screenshots {
            let mut encoded_paths = Vec::new();
            for item in &sel.items {
                let src = PathBuf::from(&item.path);
                if src.is_file() {
                    let tools_c = media_tools.clone();
                    let cfg_c = config.clone();
                    let gn = effective_game_name.clone();
                    let vp_opt = Some(PathBuf::from(&sel.source_path));
                    let item_ts = item.start;
                    let task = tauri::async_runtime::spawn_blocking(move || {
                        tools_c.encode_screenshot(
                            &src,
                            vp_opt.as_deref(),
                            Some(item_ts),
                            None,
                            false,
                            &gn,
                            &cfg_c,
                        )
                    });
                    if let Some(enc) = log.media_result("Selected screenshot encoding", task.await)
                    {
                        encoded_paths.push(enc);
                    }
                }
            }
            for enc in &encoded_paths {
                let fname = media_filename_for_game(&enc.to_string_lossy(), &effective_game_name);
                if let Some(stored) = log
                    .upload(&collection, "selected screenshot", enc, &fname)
                    .await
                {
                    assets.screenshot_media_in_anki.push(stored);
                }
            }
            if let Some(first) = assets.screenshot_media_in_anki.first() {
                assets.screenshot_in_anki = first.clone();
            }
        } else if !assets.screenshot_path.is_empty() && Path::new(&assets.screenshot_path).is_file()
        {
            let tools_c = media_tools.clone();
            let src = PathBuf::from(&assets.screenshot_path);
            let gn = effective_game_name.clone();
            let cfg_c = config.clone();
            let vp_opt = video_path.clone();
            let task = tauri::async_runtime::spawn_blocking(move || {
                tools_c.encode_screenshot(
                    &src,
                    vp_opt.as_deref(),
                    Some(ss_time),
                    None,
                    false,
                    &gn,
                    &cfg_c,
                )
            });
            if let Some(enc) = log.media_result("Screenshot encoding", task.await) {
                assets.screenshot_path = enc.to_string_lossy().into_owned();
            }
        }

        if assets.screenshot_in_anki.is_empty()
            && !assets.screenshot_path.is_empty()
            && Path::new(&assets.screenshot_path).is_file()
        {
            let p = Path::new(&assets.screenshot_path);
            let fname = media_filename_for_game(&assets.screenshot_path, &effective_game_name);
            if let Some(stored) = log.upload(&collection, "screenshot", p, &fname).await {
                assets.screenshot_in_anki = stored;
            }
        }
    }

    // 2) Previous screenshot encode & upload
    if assets.prev_screenshot_in_anki.is_empty() {
        if let Some(ref sel) = assets.selected_prev_screenshots {
            for item in &sel.items {
                let src = PathBuf::from(&item.path);
                if src.is_file() {
                    let tools_c = media_tools.clone();
                    let cfg_c = config.clone();
                    let gn = effective_game_name.clone();
                    let vp_opt = Some(PathBuf::from(&sel.source_path));
                    let item_ts = item.start;
                    let task = tauri::async_runtime::spawn_blocking(move || {
                        tools_c.encode_screenshot(
                            &src,
                            vp_opt.as_deref(),
                            Some(item_ts),
                            None,
                            false,
                            &gn,
                            &cfg_c,
                        )
                    });
                    if let Some(enc) =
                        log.media_result("Selected previous screenshot encoding", task.await)
                    {
                        let fname = format!(
                            "prev_{}",
                            media_filename_for_game(&enc.to_string_lossy(), &effective_game_name)
                        );
                        if let Some(stored) = log
                            .upload(&collection, "selected previous screenshot", &enc, &fname)
                            .await
                        {
                            assets.prev_screenshot_media_in_anki.push(stored);
                        }
                    }
                }
            }
            if let Some(first) = assets.prev_screenshot_media_in_anki.first() {
                assets.prev_screenshot_in_anki = first.clone();
            }
        } else if !assets.prev_screenshot_path.is_empty()
            && Path::new(&assets.prev_screenshot_path).is_file()
        {
            let tools_c = media_tools.clone();
            let src = PathBuf::from(&assets.prev_screenshot_path);
            let gn = effective_game_name.clone();
            let cfg_c = config.clone();
            let vp_opt = video_path.clone();
            let prev_ts = assets.prev_screenshot_timestamp;
            let task = tauri::async_runtime::spawn_blocking(move || {
                tools_c.encode_screenshot(
                    &src,
                    vp_opt.as_deref(),
                    Some(prev_ts),
                    None,
                    false,
                    &gn,
                    &cfg_c,
                )
            });
            if let Some(enc) = log.media_result("Previous screenshot encoding", task.await) {
                let fname = format!(
                    "prev_{}",
                    media_filename_for_game(&enc.to_string_lossy(), &effective_game_name)
                );
                if let Some(stored) = log
                    .upload(&collection, "previous screenshot", &enc, &fname)
                    .await
                {
                    assets.prev_screenshot_in_anki = stored;
                    assets.prev_screenshot_path = enc.to_string_lossy().into_owned();
                }
            }
        }
    }

    // 3) Audio re-encode & upload
    if use_voice && !assets.reused_audio && !assets.audio_path.is_empty() {
        let src = PathBuf::from(&assets.audio_path);
        if src.is_file() {
            let tools_c = media_tools.clone();
            let cfg_c = config.clone();
            let gn = effective_game_name.clone();
            let final_audio = if config.audio.ffmpeg_reencode_options_to_use.is_empty() {
                src
            } else {
                let task = tauri::async_runtime::spawn_blocking(move || {
                    let opts = cfg_c.audio.ffmpeg_reencode_options_to_use.clone();
                    tools_c.reencode_file_with_user_config(&src, None, &opts, &gn, &cfg_c)
                });
                log.media_result("Audio re-encoding", task.await)
                    .unwrap_or_else(|| {
                        log.emit("DEBUG", format_args!("Falling back to the original audio"));
                        PathBuf::from(&assets.audio_path)
                    })
            };
            assets.audio_path = final_audio.to_string_lossy().into_owned();
            let fname = media_filename_for_game(&assets.audio_path, &effective_game_name);
            if let Some(stored) = log.upload(&collection, "audio", &final_audio, &fname).await {
                assets.audio_in_anki = stored;
            }
        } else {
            log.emit("WARNING", format_args!("Audio file unavailable for upload"));
        }
    }

    // 4) Optional video field clip encode & upload
    if assets.pending_video && !assets.source_video_path.is_empty() {
        let tools_c = media_tools.clone();
        let vp_c = PathBuf::from(&assets.source_video_path);
        let vs = (assets.video_start_time + assets.video_vad_start).max(0.0);
        let ve = (assets.video_start_time + assets.video_vad_end).max(vs + 0.5);
        let gn = effective_game_name.clone();
        let cfg_c = config.clone();
        let task = tauri::async_runtime::spawn_blocking(move || {
            tools_c.video_to_animation(&vp_c, vs, ve, true, &gn, &cfg_c)
        });
        if let Some(seg) = log.media_result("Video clip encoding", task.await) {
            let fname = media_filename_for_game(&seg.to_string_lossy(), &effective_game_name);
            if let Some(stored) = log.upload(&collection, "video clip", &seg, &fname).await {
                assets.video_in_anki = stored;
                assets.video_path = seg.to_string_lossy().into_owned();
            }
        }
    }
    log.emit(
        "DEBUG",
        format_args!(
            "Media encoding and uploads finished after {:.2?}",
            encoding_started.elapsed()
        ),
    );

    // --- Assemble Anki note fields ---
    let mut note_fields: HashMap<String, String> = initial_note_fields;
    let force_sentence = dialog_edited_sentence
        || (!selected_lines.is_empty()
            && mined_line.source.as_deref() != Some(gsm_mining::text::SOURCE_HOTKEY));

    if !sentence.is_empty() {
        if force_sentence || multi_line {
            force_set_field_value(&mut note_fields, "sentence_field", &sentence, &config.anki);
        } else {
            apply_field_policy(
                &mut note_fields,
                &card,
                "sentence_field",
                &sentence,
                &config.advanced.multi_line_line_break,
                &config.anki,
            );
        }
    }

    // Sentence furigana via gsm-sudachi
    if config.anki.sentence_furigana.is_active()
        && (force_sentence
            || field_should_write(&card, "sentence_furigana_field", &note_fields, &config.anki))
    {
        let language = app
            .state::<Arc<gsm_sudachi::LanguageService>>()
            .inner()
            .clone();
        let plain = remove_html_and_cloze_tags(&sentence);
        let furigana = generate_sentence_furigana(&language, &sentence, &plain).await;
        if !furigana.is_empty() {
            if force_sentence {
                force_set_field_value(
                    &mut note_fields,
                    "sentence_furigana_field",
                    &furigana,
                    &config.anki,
                );
            } else {
                apply_field_policy(
                    &mut note_fields,
                    &card,
                    "sentence_furigana_field",
                    &furigana,
                    &config.advanced.multi_line_line_break,
                    &config.anki,
                );
            }
        }
    }

    // Previous sentence (refresh if confirmation dialog changed selected lines)
    if let Some(ref pl) = previous_line {
        apply_field_policy(
            &mut note_fields,
            &card,
            "previous_sentence_field",
            &pl.text,
            &config.advanced.multi_line_line_break,
            &config.anki,
        );
    }

    // Audio field
    if !assets.audio_in_anki.is_empty() {
        let tag = format!("[sound:{}]", assets.audio_in_anki);
        apply_field_policy(
            &mut note_fields,
            &card,
            "sentence_audio_field",
            &tag,
            "",
            &config.anki,
        );
    }

    // Picture field
    if !assets.screenshot_media_in_anki.is_empty() {
        let _ = put_selected_images_in_field(
            &mut note_fields,
            &card,
            "picture_field",
            &assets.screenshot_media_in_anki,
            &config.anki,
        );
    } else if !assets.screenshot_in_anki.is_empty() {
        let _ = put_selected_images_in_field(
            &mut note_fields,
            &card,
            "picture_field",
            std::slice::from_ref(&assets.screenshot_in_anki),
            &config.anki,
        );
    }

    // Previous image field
    if !assets.prev_screenshot_media_in_anki.is_empty() {
        let _ = put_selected_images_in_field(
            &mut note_fields,
            &card,
            "previous_image_field",
            &assets.prev_screenshot_media_in_anki,
            &config.anki,
        );
    } else if !assets.prev_screenshot_in_anki.is_empty() {
        let _ = put_selected_images_in_field(
            &mut note_fields,
            &card,
            "previous_image_field",
            std::slice::from_ref(&assets.prev_screenshot_in_anki),
            &config.anki,
        );
    }

    // Video field
    if !assets.video_in_anki.is_empty() {
        apply_field_policy(
            &mut note_fields,
            &card,
            "video_field",
            &assets.video_in_anki,
            "",
            &config.anki,
        );
    }

    // Game name field
    if !effective_game_name.is_empty() {
        apply_field_policy(
            &mut note_fields,
            &card,
            "game_name_field",
            &effective_game_name,
            " ",
            &config.anki,
        );
    }

    // AI translation field
    if !translation.trim().is_empty() && !config.ai.anki_field.trim().is_empty() {
        note_fields.insert(config.ai.anki_field.clone(), translation.clone());
    }

    if overlay_tag {
        fix_overlay_whitespace(&mut card, &mut note_fields);
    }
    normalize_anki_sentence_line_breaks(&mut note_fields, &config.anki);

    if nsfw {
        assets.extra_tags.push("NSFW".to_string());
    }
    let mut tags = prepare_anki_tags(&config, &effective_game_name);
    for extra in &assets.extra_tags {
        if !extra.trim().is_empty() && !tags.iter().any(|t| t == extra) {
            tags.push(extra.clone());
        }
    }
    if assets.audio_in_anki.is_empty() && config.anki.tag_unvoiced_cards {
        if !tags.iter().any(|t| t == "unvoiced") {
            tags.push("unvoiced".to_string());
        }
    }
    let remove_overlay = config.anki.remove_overlay_tag && overlay_tag;

    // --- Commit to AnkiConnect (either field-group merge or direct updateNoteFields) ---
    let mut final_note_id = note_id;
    let commit_started = Instant::now();
    if let Some((target_id, back, overwrite, delete_duplicate)) = grouping_target {
        log.emit(
            "INFO",
            format_args!(
                "Merging fields into Anki note {target_id} (delete_duplicate={delete_duplicate})"
            ),
        );
        let picture_name = config.anki.picture.name.as_str();
        let prev_picture_name = config.anki.previous_image.name.as_str();
        let sentence_name = config.anki.sentence.name.as_str();
        let furigana_name = config.anki.sentence_furigana.name.as_str();
        let merge_fields: Vec<(String, String, bool, bool)> = note_fields
            .iter()
            .map(|(k, v)| {
                let is_img = k == picture_name || k == prev_picture_name;
                let line_breaks = k == sentence_name || k == furigana_name;
                (k.clone(), v.clone(), is_img, line_breaks)
            })
            .collect();
        crate::anki_group::merge_into(
            app,
            &anki_url,
            note_id,
            target_id,
            merge_fields,
            tags.clone(),
            back,
            overwrite,
            remove_overlay,
            delete_duplicate,
        )
        .await?;
        final_note_id = target_id;
        log.emit(
            "DEBUG",
            format_args!(
                "Anki merge completed after {:.2?}",
                commit_started.elapsed()
            ),
        );
    } else if !note_fields.is_empty() || !tags.is_empty() || remove_overlay {
        log.emit(
            "INFO",
            format_args!(
                "Updating Anki (fields={}, tags={}, remove_overlay_tag={remove_overlay})",
                note_fields.len(),
                tags.len()
            ),
        );
        anki_gui_deselect_if_open(&http, &anki_url, note_id).await;
        let note_payload = json!({
            "id": note_id,
            "fields": note_fields,
        });
        crate::anki_edit::commit_group(
            &http,
            anki_url.clone(),
            note_payload,
            tags.clone(),
            remove_overlay,
        )
        .await?;
        log.emit(
            "DEBUG",
            format_args!(
                "Anki update completed after {:.2?}",
                commit_started.elapsed()
            ),
        );
    } else {
        log.emit(
            "DEBUG",
            format_args!("No field or tag changes to send to Anki"),
        );
    }

    // Record initial update in durable session review if created
    let deferred_review = review_handle.is_some();
    let review_entry_id = review_handle
        .as_ref()
        .and_then(|h| h.folder.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if let Some(mut handle) = review_handle {
        if let Err(error) =
            session_review::record_initial_update(&mut handle, &note_fields, &assets)
        {
            log.emit(
                "WARNING",
                format_args!("Could not record the Anki update in session review: {error}"),
            );
        }
    }

    // Output folder file management
    let word_path = if let Some(ref vp) = video_path {
        let tools_c = media_tools.clone();
        let vp_c = vp.clone();
        let cfg_c = config.clone();
        let prev_wp = prior_result.as_ref().map(|r| r.word_path.clone());
        let reused = assets.reused_audio;
        let word_c = word_plain.clone();
        let mut assets_c = assets.clone();
        let task = tauri::async_runtime::spawn_blocking(move || {
            let wp = handle_file_management(
                &tools_c,
                &word_c,
                reused,
                prev_wp.as_deref(),
                &mut assets_c,
                &vp_c,
                start_time,
                end_time,
                &cfg_c,
            );
            (wp, assets_c)
        });
        let res = log.optional(
            "Preparing the mining output folder",
            task.await.map_err(|e| e.to_string()),
        );
        if let Some((wp, updated_assets)) = res {
            assets = updated_assets;
            wp.unwrap_or_default()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    // Publish AnkiUpdateResult & SentenceAudioCacheEntry and wake waiters
    let update_result = AnkiUpdateResult {
        success: true,
        audio_in_anki: assets.audio_in_anki.clone(),
        screenshot_in_anki: assets.screenshot_in_anki.clone(),
        prev_screenshot_in_anki: assets.prev_screenshot_in_anki.clone(),
        screenshot_media_in_anki: assets.screenshot_media_in_anki.clone(),
        prev_screenshot_media_in_anki: assets.prev_screenshot_media_in_anki.clone(),
        sentence_in_anki: sentence.clone(),
        multi_line,
        video_in_anki: assets.video_in_anki.clone(),
        word_path: word_path.clone(),
        word: word_plain.clone(),
        extra_tags: assets.extra_tags.clone(),
        failure_reason: String::new(),
    };
    {
        let mut map = service.results.lock().unwrap();
        if map.len() > 256 {
            map.clear();
        }
        map.insert(line_id.clone(), update_result.clone());
    }
    if let Some(key) = sentence_cache_key {
        if !assets.audio_in_anki.is_empty() {
            let mut cache = service.sentence_audio_cache.lock().unwrap();
            if cache.len() > 128 {
                cache.clear();
            }
            cache.insert(
                key,
                SentenceAudioCacheEntry {
                    line_id: line_id.clone(),
                    word: word_plain.clone(),
                    created_at: Instant::now(),
                },
            );
        }
    }
    service.result_notify.notify_waiters();

    // Update SQLite game_lines atomically via gsm-history
    if !line_id.starts_with("overlay-") {
        let mined_update = MinedLine {
            line_id: line_id.clone(),
            screenshot_in_anki: (!assets.screenshot_in_anki.is_empty())
                .then(|| assets.screenshot_in_anki.clone()),
            audio_in_anki: (!assets.audio_in_anki.is_empty()).then(|| assets.audio_in_anki.clone()),
            screenshot_path: (!assets.final_screenshot_path.is_empty())
                .then(|| assets.final_screenshot_path.clone()),
            audio_path: (!assets.final_audio_path.is_empty())
                .then(|| assets.final_audio_path.clone()),
            replay_path: (!assets.final_video_path.is_empty())
                .then(|| assets.final_video_path.clone()),
            translation: (!translation.trim().is_empty()).then(|| translation.clone()),
            note_id: Some(NoteId::Integer(final_note_id as i64)),
        };
        app.state::<crate::text_intake::Intake>()
            .persist_card(mined_update);
        if let Err(e) = crate::text_intake::flush_history(app).await {
            // Anki has already committed the card. The ordered history worker retains the update.
            log.emit(
                "WARNING",
                format_args!("History flush failed; update remains queued: {e}"),
            );
        } else {
            log.emit("DEBUG", format_args!("Saved card link to dialogue history"));
        }
    }

    app.state::<crate::text_intake::Intake>().mined(
        &line_id,
        now_epoch(),
        &translation,
        &effective_game_name,
        mined_line.excluded_from_stats,
    );

    // Notify the optional session review and compatibility UI.
    if let Ok(runtime) = crate::runtime::get(app) {
        let selected_line_ids: Vec<String> = selected_lines.iter().map(|l| l.id.clone()).collect();
        let _ = runtime
            .call(
                "bus.publish",
                json!({
                    "dst": "backend",
                    "topic": "mining.cardCompleted",
                    "data": {
                        "noteId": final_note_id,
                        "lineId": line_id,
                        "word": word_plain,
                        "sentence": sentence,
                        "audioInAnki": assets.audio_in_anki,
                        "screenshotInAnki": assets.screenshot_in_anki,
                        "translation": translation,
                        "gameName": effective_game_name,
                        "excludedFromStats": mined_line.excluded_from_stats,
                        "reviewEntryId": review_entry_id,
                        "selectedLineIds": selected_line_ids,
                    }
                }),
            )
            .await;
    }

    // Post-update Anki GUI & Desktop notifications + incremental Anki sync
    if !deferred_review {
        run_post_update_gui_actions(&http, &anki_url, final_note_id, &config).await;
    }
    crate::app_lifecycle::notify_mining_event(
        app,
        "AnkiCardUpdated",
        "Anki Card Updated",
        &format!("Audio and/or Screenshot added to note: {final_note_id}"),
        Some(final_note_id as i64),
        None,
    );
    crate::anki_sync::trigger_incremental(
        app.clone(),
        anki_url,
        config.anki.word.name.clone(),
        config.anki.parent_tag.clone(),
        vec![final_note_id as i64],
    );

    // Clean up temporary replay file if configured
    if remove_video_after {
        if let Some(ref vp) = video_path {
            let _ = std::fs::remove_file(vp);
        }
    }

    log.emit("SUCCESS", format_args!(
        "Mining completed (final_note={final_note_id}, audio={}, screenshot={}, previous_screenshot={}, video={}, pending_review={deferred_review})",
        !assets.audio_in_anki.is_empty(), !assets.screenshot_in_anki.is_empty(),
        !assets.prev_screenshot_in_anki.is_empty(), !assets.video_in_anki.is_empty()
    ));
    Ok(())
}
