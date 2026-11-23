//! Anki field policy, MediaAssets, sentence-audio reuse cache, audio extraction orchestration,
//! confirmation rules, and output-folder file management.
use crate::config::{AnkiCard, AnkiConfig, ProfileConfig};
use crate::ffmpeg::{file_mtime_epoch, MediaTools};
use crate::pause_gaps::{AudioTimeline, PauseHistory};
use crate::text::{
    combine_dialogue, fix_overlay_whitespace, html_escape_attr, lines_match, make_unique_file_name,
    media_filename_for_game, normalize_line_breaks_to_br, normalize_text_for_comparison,
    preserve_html_tags, remove_html_and_cloze_tags, sanitize_filename,
    strip_sentence_formatting_for_reuse, GameLine, SOURCE_HOTKEY,
};
use crate::vad::{VadResult, VadSystem};
use chrono::Local;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const OVERLAY_RECOVERY_AUDIO_SECONDS: f64 = 10.0;
pub const ANIMATED_TIMING_EPSILON_SECONDS: f64 = 0.02;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioEditContext {
    pub source_audio_path: String,
    pub source_duration: f64,
    pub range_start: f64,
    pub range_end: f64,
    pub rebase_on_selection_trim: bool,
    pub timeline: Option<AudioTimeline>,
    pub timing_fallback: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condensed: Option<CondensedAudioEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CondensedAudioEdit {
    pub source_start: f64,
    pub keep_ranges: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayAudioResult {
    pub final_audio_output: String,
    pub vad_result: VadResult,
    pub vad_trimmed_audio: String,
    pub start_time: f64,
    pub end_time: f64,
    pub audio_edit_context: Option<AudioEditContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotMediaItem {
    pub path: String,
    pub start: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotSelection {
    pub source_path: String,
    pub items: Vec<ScreenshotMediaItem>,
}

#[derive(Debug, Clone, Default)]
pub struct MediaAssets {
    pub audio_path: String,
    pub screenshot_path: String,
    pub prev_screenshot_path: String,
    pub selected_screenshots: Option<ScreenshotSelection>,
    pub selected_prev_screenshots: Option<ScreenshotSelection>,
    pub video_path: String,
    pub source_video_path: String,
    pub screenshot_timestamp: f64,
    pub prev_screenshot_timestamp: f64,

    pub audio_in_anki: String,
    pub reused_audio: bool,
    pub reused_audio_result_id: String,
    pub screenshot_in_anki: String,
    pub screenshot_media_in_anki: Vec<String>,
    pub reused_screenshot: bool,
    pub reused_screenshot_result_id: String,
    pub prev_screenshot_in_anki: String,
    pub prev_screenshot_media_in_anki: Vec<String>,
    pub video_in_anki: String,

    pub final_audio_path: String,
    pub final_screenshot_path: String,
    pub final_prev_screenshot_path: String,
    pub final_video_path: String,

    pub extra_tags: Vec<String>,

    pub pending_animated: bool,
    pub animated_video_path: String,
    pub animated_start_time: f64,
    pub animated_vad_start: f64,
    pub animated_vad_end: f64,
    pub animated_prefetch_path: String,
    pub animated_prefetch_start: f64,
    pub animated_prefetch_end: f64,
    pub animated_target_start: f64,
    pub animated_target_end: f64,

    pub pending_video: bool,
    pub video_start_time: f64,
    pub video_vad_start: f64,
    pub video_vad_end: f64,

    pub animated: bool,
    pub video: bool,
    pub game_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiUpdateResult {
    pub success: bool,
    pub audio_in_anki: String,
    pub screenshot_in_anki: String,
    pub prev_screenshot_in_anki: String,
    pub screenshot_media_in_anki: Vec<String>,
    pub prev_screenshot_media_in_anki: Vec<String>,
    pub sentence_in_anki: String,
    pub multi_line: bool,
    pub video_in_anki: String,
    pub word_path: String,
    pub word: String,
    pub extra_tags: Vec<String>,
    pub failure_reason: String,
}

impl AnkiUpdateResult {
    pub fn failure(reason: impl Into<String>, word: impl Into<String>) -> Self {
        Self {
            success: false,
            audio_in_anki: String::new(),
            screenshot_in_anki: String::new(),
            prev_screenshot_in_anki: String::new(),
            screenshot_media_in_anki: Vec::new(),
            prev_screenshot_media_in_anki: Vec::new(),
            sentence_in_anki: String::new(),
            multi_line: false,
            video_in_anki: String::new(),
            word_path: String::new(),
            word: word.into(),
            extra_tags: Vec::new(),
            failure_reason: reason.into(),
        }
    }
}

pub type SentenceAudioKey = (String, Vec<(String, String)>, (String, String));

#[derive(Debug, Clone)]
pub struct SentenceAudioCacheEntry {
    pub line_id: String,
    pub word: String,
    pub created_at: Instant,
}

pub fn build_sentence_audio_key(
    game_line: &GameLine,
    selected_lines: &[GameLine],
) -> Option<SentenceAudioKey> {
    let line_sig: Vec<(String, String)> = if !selected_lines.is_empty() {
        selected_lines
            .iter()
            .map(|l| {
                (
                    l.id.trim().to_string(),
                    normalize_text_for_comparison(&remove_html_and_cloze_tags(&l.text)),
                )
            })
            .filter(|(_, t)| !t.is_empty())
            .collect()
    } else if !game_line.text.is_empty() {
        vec![(
            game_line.id.trim().to_string(),
            normalize_text_for_comparison(&remove_html_and_cloze_tags(&game_line.text)),
        )]
    } else {
        Vec::new()
    };

    let mined_sig = (
        game_line.id.trim().to_string(),
        normalize_text_for_comparison(&remove_html_and_cloze_tags(&game_line.text)),
    );
    if line_sig.is_empty() || line_sig.iter().all(|(_, t)| t.is_empty()) || mined_sig.1.is_empty() {
        return None;
    }
    let sentence_sig: String = line_sig.iter().map(|(_, t)| t.as_str()).collect();
    Some((sentence_sig, line_sig, mined_sig))
}

pub fn find_same_selection_reuse_entry<'a>(
    cache: &'a HashMap<SentenceAudioKey, SentenceAudioCacheEntry>,
    reuse_key: &SentenceAudioKey,
    current_word: &str,
) -> Option<&'a SentenceAudioCacheEntry> {
    let (sentence_sig, line_sig, mined_sig) = reuse_key;
    for (k, entry) in cache {
        if k == reuse_key {
            continue;
        }
        if &k.0 == sentence_sig && &k.1 == line_sig && &k.2 != mined_sig && entry.word != current_word
        {
            return Some(entry);
        }
    }
    None
}

pub fn prune_sentence_audio_cache(
    cache: &mut HashMap<SentenceAudioKey, SentenceAudioCacheEntry>,
    replay_buffer_length: u64,
) {
    let ttl = Duration::from_secs(replay_buffer_length.saturating_add(120).max(120));
    cache.retain(|_, entry| entry.created_at.elapsed() < ttl);
}

// --- Confirmation & Animation Policy ---

pub fn should_show_confirmation_dialog(
    config: &ProfileConfig,
    vad_result: Option<&VadResult>,
    use_existing_files: bool,
) -> bool {
    if config.review_after_session_enabled() {
        return false;
    }
    if !config.anki.show_update_confirmation_dialog_v2 {
        return false;
    }
    if use_existing_files {
        return false;
    }
    if !config.anki.skip_confirmation_for_unvoiced {
        return true;
    }
    let Some(vr) = vad_result else {
        return true;
    };
    if matches!(vr.model.as_str(), "No VAD" | "OFF" | "") {
        return true;
    }
    vr.voice_detected
}

pub fn should_animate_screenshot(config: &ProfileConfig, vad_result: Option<&VadResult>) -> bool {
    if !config.screenshot.animated {
        return false;
    }
    if !config.screenshot.animated_settings.only_when_voice {
        return true;
    }
    vad_result.is_some_and(|vr| {
        vr.voice_detected
            && !vr.tts_used
            && !matches!(vr.model.as_str(), "No VAD" | "OFF" | "")
    })
}

// --- Field Policy ---

pub fn field_value_in_note_or_card(
    note_fields: &HashMap<String, String>,
    card: &AnkiCard,
    field_name: &str,
) -> String {
    if let Some(v) = note_fields.get(field_name) {
        if !v.is_empty() {
            return v.clone();
        }
    }
    card.get_field(field_name).unwrap_or("").to_string()
}

pub fn field_should_write(
    card: &AnkiCard,
    field_key: &str,
    note_fields: &HashMap<String, String>,
    anki_cfg: &AnkiConfig,
) -> bool {
    if matches!(field_key, "word_field" | "word") {
        return false;
    }
    let Some(fc) = anki_cfg.field_config(field_key) else {
        return false;
    };
    if !fc.is_active() {
        return false;
    }
    if fc.overwrite || fc.append {
        return true;
    }
    field_value_in_note_or_card(note_fields, card, &fc.name).is_empty()
}

pub fn apply_field_policy(
    note_fields: &mut HashMap<String, String>,
    card: &AnkiCard,
    field_key: &str,
    value: &str,
    append_separator: &str,
    anki_cfg: &AnkiConfig,
) -> bool {
    if matches!(field_key, "word_field" | "word") || value.is_empty() {
        return false;
    }
    let Some(fc) = anki_cfg.field_config(field_key) else {
        return false;
    };
    if !fc.is_active() {
        return false;
    }
    let existing = field_value_in_note_or_card(note_fields, card, &fc.name);
    if fc.append {
        let next = if existing.is_empty() {
            value.to_string()
        } else {
            format!("{existing}{append_separator}{value}")
        };
        note_fields.insert(fc.name.clone(), next);
        return true;
    }
    if fc.overwrite || existing.is_empty() {
        note_fields.insert(fc.name.clone(), value.to_string());
        return true;
    }
    false
}

pub fn force_set_field_value(
    note_fields: &mut HashMap<String, String>,
    field_key: &str,
    value: &str,
    anki_cfg: &AnkiConfig,
) -> bool {
    if value.is_empty() {
        return false;
    }
    let Some(fc) = anki_cfg.field_config(field_key) else {
        return false;
    };
    if !fc.is_active() {
        return false;
    }
    note_fields.insert(fc.name.clone(), value.to_string());
    true
}

pub fn image_tags(media_names: &[String]) -> String {
    media_names
        .iter()
        .map(|n| format!(r#"<img src="{}">"#, html_escape_attr(n)))
        .collect()
}

pub fn put_selected_images_in_field(
    note_fields: &mut HashMap<String, String>,
    card: &AnkiCard,
    field_key: &str,
    media_names: &[String],
    anki_cfg: &AnkiConfig,
) -> Result<(), String> {
    let fc = anki_cfg
        .field_config(field_key)
        .filter(|f| f.is_active())
        .ok_or_else(|| format!("The Anki {field_key} destination is not configured"))?;
    let current = field_value_in_note_or_card(note_fields, card, &fc.name);
    let tags = image_tags(media_names);
    let value = if fc.append {
        format!("{current}{tags}")
    } else {
        static RE_IMG: OnceLock<Regex> = OnceLock::new();
        let re = RE_IMG.get_or_init(|| Regex::new(r"(?i)<img\b[^>]*>").unwrap());
        if let Some(m) = re.find(&current) {
            format!("{}{}{}", &current[..m.start()], tags, &current[m.end()..])
        } else {
            format!("{current}{tags}")
        }
    };
    note_fields.insert(fc.name.clone(), value);
    Ok(())
}

pub fn normalize_anki_sentence_line_breaks(
    note_fields: &mut HashMap<String, String>,
    anki_cfg: &AnkiConfig,
) {
    for field_name in [
        anki_cfg.sentence.name.trim(),
        anki_cfg.sentence_furigana.name.trim(),
    ] {
        if !field_name.is_empty() {
            if let Some(val) = note_fields.get_mut(field_name) {
                *val = normalize_line_breaks_to_br(val);
            }
        }
    }
}

pub fn build_selected_lines_sentence(
    card: &AnkiCard,
    selected_lines: &[GameLine],
    config: &ProfileConfig,
) -> String {
    if selected_lines.is_empty() {
        return String::new();
    }
    let sentence_in_anki = card
        .get_field(&config.anki.sentence.name)
        .unwrap_or("");
    let stripped_anki = remove_html_and_cloze_tags(sentence_in_anki);
    let mut sentences = Vec::with_capacity(selected_lines.len());
    for line in selected_lines {
        if !sentence_in_anki.is_empty() && lines_match(&line.text, &stripped_anki) {
            sentences.push(preserve_html_tags(sentence_in_anki, &line.text));
        } else {
            sentences.push(line.text.clone());
        }
    }
    let combined = combine_dialogue(&sentences, &config.advanced.multi_line_line_break);
    if !combined.is_empty() {
        combined.concat()
    } else {
        sentences.join(&config.advanced.multi_line_line_break)
    }
}

pub fn sentence_for_current_card_html(
    card: &AnkiCard,
    sentence: &str,
    anki_cfg: &AnkiConfig,
) -> String {
    let reusable = strip_sentence_formatting_for_reuse(sentence);
    if reusable.is_empty() {
        return String::new();
    }
    let in_anki = card
        .get_field(&anki_cfg.sentence.name)
        .unwrap_or("")
        .replace(['\n', '\r'], "");
    let in_anki = in_anki.trim();
    if in_anki.is_empty() {
        reusable
    } else {
        preserve_html_tags(in_anki, &reusable)
    }
}

pub fn prepare_initial_card_fields(
    card: &mut AnkiCard,
    selected_lines: &[GameLine],
    game_line: &GameLine,
    previous_line: Option<&GameLine>,
    sentence_override: Option<&str>,
    config: &ProfileConfig,
) -> (HashMap<String, String>, Option<String>) {
    let mut note_fields = HashMap::new();
    fix_overlay_whitespace(card, &mut note_fields);

    let multi_line_sentence = if !selected_lines.is_empty() {
        build_selected_lines_sentence(card, selected_lines, config)
    } else {
        String::new()
    };
    let has_override = sentence_override.is_some_and(|s| !s.is_empty());
    let force_selected =
        !selected_lines.is_empty() && game_line.source.as_deref() != Some(SOURCE_HOTKEY);

    let mut written_sentence = None;
    if has_override
        || force_selected
        || field_should_write(card, "sentence_field", &note_fields, &config.anki)
    {
        let sentence_in_anki = card
            .get_field(&config.anki.sentence.name)
            .unwrap_or("")
            .replace(['\n', '\r'], "");
        let sentence_in_anki = sentence_in_anki.trim();

        let updated_sentence = if let Some(ov) = sentence_override.filter(|s| !s.is_empty()) {
            sentence_for_current_card_html(card, ov, &config.anki)
        } else if config.anki.sentence.append {
            if !multi_line_sentence.is_empty() {
                multi_line_sentence
            } else {
                game_line.text.clone()
            }
        } else if !multi_line_sentence.is_empty() {
            multi_line_sentence
        } else if !sentence_in_anki.is_empty() {
            preserve_html_tags(sentence_in_anki, &game_line.text)
        } else {
            game_line.text.clone()
        };

        let wrote = if has_override || force_selected {
            force_set_field_value(
                &mut note_fields,
                "sentence_field",
                &updated_sentence,
                &config.anki,
            )
        } else {
            apply_field_policy(
                &mut note_fields,
                card,
                "sentence_field",
                &updated_sentence,
                &config.advanced.multi_line_line_break,
                &config.anki,
            )
        };
        if wrote {
            written_sentence = Some(updated_sentence);
        }
    }

    if let Some(prev) = previous_line {
        if config.anki.field_is_active("previous_sentence_field") {
            apply_field_policy(
                &mut note_fields,
                card,
                "previous_sentence_field",
                &prev.text,
                &config.advanced.multi_line_line_break,
                &config.anki,
            );
        }
    }

    (note_fields, written_sentence)
}

pub fn prepare_anki_tags(config: &ProfileConfig, game_name: &str) -> Vec<String> {
    let mut tags = Vec::new();
    if config.anki.add_game_tag && !game_name.trim().is_empty() {
        let mut game = game_name.replace(' ', "").replace("::", "");
        if !config.anki.parent_tag.trim().is_empty() {
            game = format!("{}::{game}", config.anki.parent_tag.trim());
        }
        tags.push(game);
    }
    tags.extend(config.anki.custom_tags.iter().cloned());
    tags
}

// --- Animated Window Helpers ---

pub fn animated_requested_window(assets: &MediaAssets) -> Option<(f64, f64)> {
    let start = assets.animated_start_time + assets.animated_vad_start;
    let end = assets.animated_start_time + assets.animated_vad_end;
    (end > start).then_some((start, end))
}

pub fn animated_prefetch_window(assets: &MediaAssets) -> Option<(f64, f64)> {
    (assets.animated_prefetch_end > assets.animated_prefetch_start)
        .then_some((assets.animated_prefetch_start, assets.animated_prefetch_end))
}

pub fn animated_target_window(assets: &MediaAssets) -> Option<(f64, f64)> {
    (assets.animated_target_end > assets.animated_target_start)
        .then_some((assets.animated_target_start, assets.animated_target_end))
}

pub fn windows_match(a: (f64, f64), b: (f64, f64)) -> bool {
    (a.0 - b.0).abs() <= ANIMATED_TIMING_EPSILON_SECONDS
        && (a.1 - b.1).abs() <= ANIMATED_TIMING_EPSILON_SECONDS
}

pub fn window_contains(outer: (f64, f64), inner: (f64, f64)) -> bool {
    inner.0 >= outer.0 - ANIMATED_TIMING_EPSILON_SECONDS
        && inner.1 <= outer.1 + ANIMATED_TIMING_EPSILON_SECONDS
}

// --- Replay Audio Extraction + VAD + Overlay Recovery + TTS Fallback ---

pub fn build_audio_edit_context(
    media: &MediaTools,
    source_audio_path: &Path,
    start_time: f64,
    end_time: f64,
    vad_result: Option<&VadResult>,
    timeline: Option<&AudioTimeline>,
    config: &ProfileConfig,
) -> Option<AudioEditContext> {
    let source_duration = media.get_audio_length(source_audio_path);
    if source_duration <= 0.0 {
        return None;
    }
    if vad_result.is_some_and(|v| v.tts_used) {
        return None;
    }
    let mut current_start = start_time.max(0.0);
    let mut current_end = (end_time > 0.0).then_some(end_time);

    if let Some(vr) = vad_result {
        if vr.success && !matches!(vr.model.as_str(), "" | "No VAD") {
            if config.vad.trim_beginning {
                current_start += vr.start.max(0.0);
            }
            if vr.end > 0.0 {
                current_end = Some(start_time + vr.end);
            }
        }
    }
    if let Some(tl) = timeline {
        if !tl.is_empty() {
            current_start = tl.to_audio(current_start);
            current_end = current_end.map(|e| tl.to_audio(e));
        }
    }
    let final_end = current_end.unwrap_or(source_duration);
    current_start = current_start.clamp(0.0, source_duration);
    let final_end = final_end.clamp(current_start, source_duration);

    let rebase = vad_result.is_some_and(|vr| {
        !vr.tts_used
            && vr.success
            && !matches!(vr.model.as_str(), "" | "No VAD")
            && config.vad.cut_and_splice_segments
    });

    Some(AudioEditContext {
        source_audio_path: source_audio_path.to_string_lossy().into_owned(),
        source_duration,
        range_start: current_start,
        range_end: final_end,
        rebase_on_selection_trim: rebase,
        timeline: timeline.filter(|t| !t.is_empty()).cloned(),
        timing_fallback: false,
        condensed: None,
    })
}

pub fn rebase_vad_on_video(timeline: &AudioTimeline, start_time: f64, vad_result: &mut VadResult) {
    if timeline.is_empty() || !vad_result.success {
        return;
    }
    let audio_start = timeline.to_audio(start_time);
    vad_result.start = timeline.to_source(audio_start + vad_result.start, false) - start_time;
    vad_result.end = timeline.to_source(audio_start + vad_result.end, true) - start_time;
}

#[allow(clippy::too_many_arguments)]
pub fn extract_replay_audio(
    media: &MediaTools,
    vad: &VadSystem,
    pause_history: &PauseHistory,
    video_path: &Path,
    start_line: &GameLine,
    next_line_epoch: Option<f64>,
    anki_card_creation_epoch: Option<f64>,
    mined_line: Option<&GameLine>,
    full_text: &str,
    game_name: &str,
    config: &ProfileConfig,
    http_client: Option<&reqwest::Client>,
) -> Result<ReplayAudioResult, String> {
    let (source_audio, trimmed_audio, mut start_time, mut end_time, timeline) =
        media.get_audio_and_trim(
            video_path,
            start_line,
            next_line_epoch,
            anki_card_creation_epoch,
            pause_history,
            config,
        )?;
    let overlay_only = mined_line
        .unwrap_or(start_line)
        .is_overlay();

    if overlay_only {
        let has_audio = trimmed_audio.is_file() && media.get_audio_length(&trimmed_audio) > 0.0;
        if !has_audio {
            if let Some((rec_path, rec_start, rec_end)) =
                recover_overlay_audio(media, &source_audio, start_time, end_time, &timeline, config)
            {
                start_time = rec_start;
                end_time = rec_end;
                let mut edit_ctx = build_audio_edit_context(
                    media,
                    &source_audio,
                    start_time,
                    end_time,
                    None,
                    Some(&timeline),
                    config,
                );
                if let Some(ctx) = edit_ctx.as_mut() {
                    ctx.timing_fallback = true;
                }
                let rec_str = rec_path.to_string_lossy().into_owned();
                let mut vr = VadResult::new(false, 0.0, 0.0, "No VAD");
                vr.output_audio = rec_str.clone();
                vr.trimmed_audio_path = rec_str.clone();
                return Ok(ReplayAudioResult {
                    final_audio_output: rec_str.clone(),
                    vad_result: vr,
                    vad_trimmed_audio: rec_str,
                    start_time,
                    end_time,
                    audio_edit_context: edit_ctx,
                });
            }
            return Ok(ReplayAudioResult {
                final_audio_output: String::new(),
                vad_result: VadResult::new(false, 0.0, 0.0, "No VAD"),
                vad_trimmed_audio: String::new(),
                start_time,
                end_time,
                audio_edit_context: None,
            });
        }
    }

    if !config.vad.do_vad_postprocessing {
        let final_out = if trimmed_audio.is_file() {
            trimmed_audio.to_string_lossy().into_owned()
        } else {
            String::new()
        };
        let mut vr = VadResult::new(true, start_time, end_time, "No VAD");
        vr.output_audio = final_out.clone();
        let edit_ctx = build_audio_edit_context(
            media,
            &source_audio,
            start_time,
            end_time,
            None,
            Some(&timeline),
            config,
        );
        return Ok(ReplayAudioResult {
            final_audio_output: final_out.clone(),
            vad_result: vr,
            vad_trimmed_audio: final_out,
            start_time,
            end_time,
            audio_edit_context: edit_ctx,
        });
    }

    let vad_out_path = make_unique_file_name(&media.temp_dir.join(format!(
        "{}.{}",
        sanitize_filename(game_name),
        config.audio.extension
    )));
    let mut vad_result = vad.trim_audio_with_vad(
        media,
        &trimmed_audio,
        &vad_out_path,
        Some(start_line),
        next_line_epoch.is_some(),
        config,
    );
    rebase_vad_on_video(&timeline, start_time, &mut vad_result);
    let trimmed_str = trimmed_audio.to_string_lossy().into_owned();
    if vad_result.success && vad_result.trimmed_audio_path.is_empty() {
        vad_result.trimmed_audio_path = trimmed_str.clone();
    }

    let mut final_audio_output = String::new();
    if !vad_result.success {
        if overlay_only
            || (config.anki.show_update_confirmation_dialog_v2
                && !config.anki.skip_confirmation_for_unvoiced)
        {
            vad_result.trimmed_audio_path = trimmed_str.clone();
            if trimmed_audio.is_file() {
                final_audio_output = trimmed_str.clone();
            }
        }
        if config.vad.add_audio_on_no_results {
            if trimmed_audio.is_file() {
                final_audio_output = trimmed_str.clone();
                vad_result.output_audio = trimmed_str.clone();
                vad_result.success = true;
            }
        } else if config.vad.use_tts_as_fallback {
            if let Some(client) = http_client {
                let text_to_tts = if full_text.is_empty() {
                    start_line.text.as_str()
                } else {
                    full_text
                };
                let url = config.vad.tts_url.replace("$s", text_to_tts);
                if let Ok(bytes) = fetch_tts_sync(client, &url) {
                    let tts_path = media.temp_dir.join(format!(
                        "{}_tts_{}.opus",
                        sanitize_filename(game_name),
                        uuid::Uuid::new_v4().simple()
                    ));
                    if std::fs::write(&tts_path, &bytes).is_ok() {
                        let s = tts_path.to_string_lossy().into_owned();
                        vad_result.output_audio = s.clone();
                        vad_result.tts_used = true;
                        vad_result.success = true;
                        final_audio_output = s;
                    }
                }
            }
        }
    }

    if !vad_result.output_audio.is_empty() && Path::new(&vad_result.output_audio).is_file() {
        final_audio_output = vad_result.output_audio.clone();
    }
    let vad_trimmed = if !final_audio_output.is_empty() && Path::new(&final_audio_output).is_file() {
        final_audio_output.clone()
    } else {
        final_audio_output.clear();
        String::new()
    };

    let mut edit_ctx = build_audio_edit_context(
        media,
        &source_audio,
        start_time,
        end_time,
        Some(&vad_result),
        Some(&timeline),
        config,
    );
    if let Some(ctx) = &mut edit_ctx {
        if !vad_result.condensed_ranges.is_empty() && !final_audio_output.is_empty() {
            ctx.condensed = Some(CondensedAudioEdit {
                source_start: timeline.to_audio(start_time),
                keep_ranges: std::mem::take(&mut vad_result.condensed_ranges),
            });
        }
    }

    Ok(ReplayAudioResult {
        final_audio_output,
        vad_result,
        vad_trimmed_audio: vad_trimmed,
        start_time,
        end_time,
        audio_edit_context: edit_ctx,
    })
}

fn recover_overlay_audio(
    media: &MediaTools,
    source_audio: &Path,
    start_time: f64,
    end_time: f64,
    timeline: &AudioTimeline,
    config: &ProfileConfig,
) -> Option<(PathBuf, f64, f64)> {
    let source_dur = if source_audio.is_file() {
        media.get_audio_length(source_audio)
    } else {
        0.0
    };
    if source_dur <= 0.0 {
        return None;
    }
    let est_start = if timeline.is_empty() {
        start_time
    } else {
        timeline.to_audio(start_time)
    };
    let audio_end = if end_time > 0.0 {
        let e = if timeline.is_empty() {
            end_time
        } else {
            timeline.to_audio(end_time)
        };
        e.clamp(0.0, source_dur)
    } else {
        (est_start.max(0.0) + OVERLAY_RECOVERY_AUDIO_SECONDS).min(source_dur)
    };
    let audio_start = (audio_end - OVERLAY_RECOVERY_AUDIO_SECONDS).max(0.0);
    if audio_end <= audio_start {
        return None;
    }
    let rec_path = media.unique_temp_path(&format!("_overlay_recovery.{}", config.audio.extension));
    media
        .trim_audio(
            source_audio,
            audio_start,
            audio_end,
            &rec_path,
            true,
            0.0,
            0.0,
            config,
        )
        .ok()?;
    if !rec_path.is_file() || media.get_audio_length(&rec_path) <= 0.0 {
        return None;
    }
    let src_start = if timeline.is_empty() {
        audio_start
    } else {
        timeline.to_source(audio_start, false)
    };
    let src_end = if timeline.is_empty() {
        audio_end
    } else {
        timeline.to_source(audio_end, true)
    };
    Some((rec_path, src_start, src_end))
}

fn fetch_tts_sync(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let handle = tokio::runtime::Handle::try_current().map_err(|e| e.to_string())?;
    let client = client.clone();
    let url = url.to_string();
    tokio::task::block_in_place(|| {
        handle.block_on(async move {
            let resp = client
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            Ok(bytes.to_vec())
        })
    })
}

// --- Output Folder File Management ---

#[allow(clippy::too_many_arguments)]
pub fn handle_file_management(
    media: &MediaTools,
    tango: &str,
    reuse_audio: bool,
    previous_word_path: Option<&str>,
    assets: &mut MediaAssets,
    video_path: &Path,
    start_time: f64,
    end_time: f64,
    config: &ProfileConfig,
) -> Option<String> {
    if config.paths.output_folder.trim().is_empty() || !config.paths.copy_temp_files_to_output_folder
    {
        return None;
    }
    let now = Local::now();
    let word_dir = Path::new(&config.paths.output_folder)
        .join(now.format("%Y-%m").to_string())
        .join(now.format("%d").to_string())
        .join(sanitize_filename(tango));
    if std::fs::create_dir_all(&word_dir).is_err() {
        return None;
    }

    let copy_media = |src: &str, previous: bool, game_name: &str| -> Option<String> {
        let mut fname = media_filename_for_game(src, game_name);
        if previous {
            fname = format!("prev_{fname}");
        }
        let dst = word_dir.join(fname);
        std::fs::copy(src, &dst)
            .ok()
            .map(|_| dst.to_string_lossy().into_owned())
    };

    if reuse_audio {
        if let Some(prev_dir) = previous_word_path.filter(|p| Path::new(p).is_dir()) {
            let _ = copy_dir_flat(Path::new(prev_dir), &word_dir);
        }
    } else {
        let g = assets.game_name.clone();
        if !assets.audio_path.is_empty() && Path::new(&assets.audio_path).is_file() {
            if let Some(p) = copy_media(&assets.audio_path, false, &g) {
                assets.final_audio_path = p;
            }
        }
        if !assets.screenshot_path.is_empty() && Path::new(&assets.screenshot_path).is_file() {
            if let Some(p) = copy_media(&assets.screenshot_path, false, &g) {
                assets.final_screenshot_path = p;
            }
        }
        if let Some(sel) = &assets.selected_screenshots {
            for item in sel.items.iter().skip(1) {
                if Path::new(&item.path).is_file() {
                    let _ = copy_media(&item.path, false, &g);
                }
            }
        }
        if !assets.prev_screenshot_path.is_empty()
            && Path::new(&assets.prev_screenshot_path).is_file()
        {
            if let Some(p) = copy_media(&assets.prev_screenshot_path, true, &g) {
                assets.final_prev_screenshot_path = p;
            }
        }
        if let Some(sel) = &assets.selected_prev_screenshots {
            for item in sel.items.iter().skip(1) {
                if Path::new(&item.path).is_file() {
                    let _ = copy_media(&item.path, true, &g);
                }
            }
        }
        if !assets.video_path.is_empty() && Path::new(&assets.video_path).is_file() {
            if let Some(p) = copy_media(&assets.video_path, false, &g) {
                assets.final_video_path = p;
            }
        } else if config.paths.copy_trimmed_replay_to_output_folder && video_path.is_file() {
            if let Ok(trimmed) =
                media.trim_replay_for_gameline(video_path, start_time, end_time, true)
            {
                if trimmed.is_file() {
                    if let Some(p) = copy_media(&trimmed.to_string_lossy(), false, &g) {
                        assets.final_video_path = p;
                    }
                }
            }
        }
    }

    let _ = file_mtime_epoch(&word_dir);
    Some(word_dir.to_string_lossy().into_owned())
}

fn copy_dir_flat(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            let target = dst.join(entry.file_name());
            let _ = std::fs::copy(&path, &target);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AnkiCardField;

    #[test]
    fn field_policy_overwrite_append_and_preserve() {
        let mut cfg = AnkiConfig::default();
        cfg.sentence.overwrite = false;
        cfg.sentence.append = true;
        let card = AnkiCard {
            note_id: 1,
            tags: vec![],
            fields: vec![(
                "Sentence".into(),
                AnkiCardField {
                    value: "Old".into(),
                    order: 0,
                },
            )],
            cards: vec![2],
            model_name: "Lapis".into(),
        };
        let mut fields = HashMap::new();
        assert!(apply_field_policy(&mut fields, &card, "sentence_field", "New", "<br>", &cfg));
        assert_eq!(fields["Sentence"], "Old<br>New");

        cfg.sentence.append = false;
        let mut fields2 = HashMap::new();
        assert!(!apply_field_policy(&mut fields2, &card, "sentence_field", "New", "<br>", &cfg));
        assert!(!fields2.contains_key("Sentence"));
    }

    #[test]
    fn confirmation_dialog_skip_unvoiced_logic() {
        let mut cfg = ProfileConfig::default();
        cfg.anki.show_update_confirmation_dialog_v2 = true;
        cfg.anki.skip_confirmation_for_unvoiced = true;
        let unvoiced = VadResult::new(false, 0.0, 0.0, "FIRERED");
        assert!(!should_show_confirmation_dialog(&cfg, Some(&unvoiced), false));
        let voiced = VadResult::new(true, 0.1, 1.0, "FIRERED");
        assert!(should_show_confirmation_dialog(&cfg, Some(&voiced), false));
        let no_vad = VadResult::new(true, 0.0, 1.0, "No VAD");
        assert!(should_show_confirmation_dialog(&cfg, Some(&no_vad), false));
    }
}
