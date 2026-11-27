use super::{media_tools, settings, string};
use crate::{assets, desktop_state::DesktopState, mining::MiningService};
use gsm_mining::{
    config::{audio_format_spec, AnkiCard, ProfileConfig},
    ffmpeg::{file_mtime_epoch, MediaTools},
    policy::{build_selected_lines_sentence, AudioEditContext},
    text::{parse_iso_to_epoch, remove_html_and_cloze_tags, GameLine},
};
use rodio::Source;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager};

struct Picture {
    url: String,
    result: Value,
    export: Option<gsm_mining::frame_selector::Export>,
}

struct Audio {
    source: PathBuf,
    url: Option<String>,
    wav: Option<PathBuf>,
    duration: f64,
    initial_range: [f64; 2],
    initial_cuts: Vec<[f64; 2]>,
    filters: HashMap<AudioFilter, PathBuf>,
    source_is_condensed: bool,
    context: Option<AudioEditContext>,
    vad: Value,
}

#[derive(Clone, Copy, Default, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
enum AudioFilter {
    #[default]
    None,
    BoostQuiet,
    ReduceRumble,
    ReduceNoise,
}

impl AudioFilter {
    fn graph(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::BoostQuiet => Some("volume=6dB,alimiter=limit=0.95:level=0:latency=1"),
            Self::ReduceRumble => Some("highpass=f=100"),
            // Pad and compensate for afftdn's 25 ms latency so the waveform stays aligned.
            Self::ReduceNoise => Some(
                "apad=pad_dur=0.025,afftdn=nr=10:nf=-45,atrim=start=0.025,asetpts=PTS-STARTPTS",
            ),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Edit {
    sentence: String,
    translation: String,
    nsfw: bool,
    voice: bool,
    audio: usize,
    start: f64,
    end: f64,
    cuts: Vec<[f64; 2]>,
    #[serde(default)]
    filter: AudioFilter,
    picture: usize,
    previous_picture: usize,
    dialogue: usize,
}

pub(super) struct Dialogue {
    pub lines: Vec<GameLine>,
    pub video: Option<PathBuf>,
    pub end: Option<f64>,
    pub audio_result: Value,
    pub translation_regenerated: bool,
}

pub(super) struct Editor {
    pub request: Value,
    pub config: ProfileConfig,
    pub context: Vec<GameLine>,
    pub future: Option<(PathBuf, f64, Vec<GameLine>)>,
    pub dialogues: Vec<Dialogue>,
    pub review: bool,
    owned_replays: Vec<tempfile::TempDir>,
    label: String,
    dir: tempfile::TempDir,
    pictures: Vec<Picture>,
    previous: Vec<Picture>,
    audio: Vec<Audio>,
}

impl Editor {
    pub fn new(
        app: &AppHandle,
        request: Value,
        config: ProfileConfig,
        context: Vec<GameLine>,
        review: bool,
    ) -> Result<Self, String> {
        let dir = tempfile::Builder::new()
            .prefix("gsm-card-")
            .tempdir_in(app.state::<Arc<MiningService>>().temp_dir())
            .map_err(|e| e.to_string())?;
        let label = format!("card-media-{}", uuid::Uuid::new_v4().simple());
        let selected = request["selected_lines"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(crate::mining::session_review::parse_game_line_value)
            .collect::<Vec<_>>();
        let selected = if selected.is_empty() {
            crate::mining::session_review::parse_game_line_value(&request["mined_line"])
                .into_iter()
                .collect()
        } else {
            selected
        };
        let video = file(&request["video_path"]);
        let end = parse_iso_to_epoch(string(&request["anki_card_creation_time"]))
            .or_else(|| video.as_deref().and_then(file_mtime_epoch));
        let mut editor = Self {
            request,
            config,
            context,
            future: None,
            dialogues: vec![Dialogue {
                lines: selected,
                video,
                end,
                audio_result: Value::Null,
                translation_regenerated: false,
            }],
            review,
            owned_replays: Vec::new(),
            label,
            dir,
            pictures: Vec::new(),
            previous: Vec::new(),
            audio: Vec::new(),
        };
        let picture = editor.picture(editor.request["screenshot_path"].clone(), false);
        let previous = editor.picture(editor.request["previous_screenshot_path"].clone(), true);
        editor.pictures.push(picture);
        editor.previous.push(previous);
        let vad = editor.request["vad_result"].clone();
        let source = if editor.request["reusing_audio"] == true {
            None
        } else {
            file(&editor.request["audio_path"]).or_else(|| file(&vad["trimmed_audio_path"]))
        };
        let context = serde_json::from_value(editor.request["audio_edit_context"].clone()).ok();
        editor.add_audio(&media_tools(app), source, context, vad);
        app.state::<DesktopState>()
            .assets
            .mount(&editor.label, editor.dir.path())?;
        Ok(editor)
    }

    pub fn unmount(&self, app: &AppHandle) {
        app.state::<DesktopState>().assets.unmount(&self.label);
    }

    fn asset(&self, source: &Path, name: &str) -> Option<String> {
        let target = self.dir.path().join(name);
        std::fs::hard_link(source, &target)
            .or_else(|_| std::fs::copy(source, &target).map(|_| ()))
            .ok()?;
        Some(self.asset_url(name))
    }

    fn asset_url(&self, name: &str) -> String {
        format!("{}/{}/{name}", assets::origin(), self.label)
    }

    fn picture(&self, result: Value, previous: bool) -> Picture {
        let path = if result.is_object() {
            file(&result["items"][0]["path"])
        } else {
            file(&result)
        };
        let url = path
            .and_then(|path| {
                let extension = path.extension()?.to_str()?;
                if !extension.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return None;
                }
                let key = if previous {
                    self.previous.len()
                } else {
                    self.pictures.len()
                };
                self.asset(&path, &format!("picture-{previous}-{key}.{extension}"))
            })
            .unwrap_or_default();
        Picture {
            url,
            result,
            export: None,
        }
    }

    fn scratch_tools(&self, app: &AppHandle) -> MediaTools {
        let mut tools = media_tools(app);
        tools.temp_dir = self.dir.path().to_owned();
        tools
    }

    fn add_audio(
        &mut self,
        tools: &MediaTools,
        source: Option<PathBuf>,
        mut context: Option<AudioEditContext>,
        vad: Value,
    ) -> usize {
        let key = self.audio.len();
        let name = format!("audio-{key}.wav");
        let path = self.dir.path().join(&name);
        let prepare = |source: &Path| {
            if source
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
            {
                self.asset(source, &name)?;
            } else {
                tools.playback_wav(source, &path).ok()?;
            }
            let decoder = rodio::Decoder::try_from(std::fs::File::open(&path).ok()?).ok()?;
            Some(decoder.total_duration()?.as_secs_f64())
        };
        let condensed = source.as_ref().and_then(|_| {
            let metadata = context.as_ref()?.condensed.as_ref()?;
            let duration = prepare(&file(&vad["trimmed_audio_path"])?)?;
            let (range, cuts) = selection_from_kept(duration, &metadata.keep_ranges)?;
            Some((duration, range, cuts, metadata.source_start))
        });
        let source_is_condensed = condensed.is_some();
        let (duration, initial_range, initial_cuts) = if let Some((duration, range, cuts, start)) = condensed {
            if let Some(context) = &mut context {
                context.range_start = start;
                context.range_end = start + duration;
                context.rebase_on_selection_trim = false;
            }
            (duration, range, cuts)
        } else {
            // Remove an unusable preview before preparing the original card audio.
            let _ = std::fs::remove_file(&path);
            let duration = source.as_deref().and_then(prepare).unwrap_or_default();
            (duration, [0.0, duration], Vec::new())
        };
        self.audio.push(Audio {
            source: source.unwrap_or_default(),
            url: (duration > 0.0).then(|| self.asset_url(&name)),
            wav: (duration > 0.0).then_some(path),
            duration,
            initial_range,
            initial_cuts,
            filters: HashMap::new(),
            source_is_condensed,
            context,
            vad,
        });
        key
    }

    pub fn preferences(&self, app: &AppHandle) -> Value {
        let anki = settings(app);
        json!({
            "timer": if self.review { 0 } else { anki["auto_accept_timer"].as_u64().unwrap_or(10) },
            "autoplay": anki["autoplay_audio"] == true,
            "step": anki["confirmation_audio_step"].as_f64().filter(|s| *s > 0.0 && *s <= 5.0).unwrap_or(0.25),
            "gamepad": if anki["confirmation_gamepad_enabled"] == true { anki } else { Value::Null },
        })
    }

    pub fn form(&self, app: &AppHandle) -> Value {
        json!({
            "expression": remove_html_and_cloze_tags(string(&self.request["expression"])),
            "expressionLabel": self.config.anki.word.name,
            "sentence": self.request["sentence"], "translation": self.request["translation"],
            "picture": self.pictures[0].url, "previousPicture": self.previous[0].url,
            "animated": self.request["pending_animated"], "animatedAvif": self.request["pending_animated"] == true
                && self.config.screenshot.animated_settings.extension.eq_ignore_ascii_case("avif"),
            "reusedPicture": self.request["reusing_screenshot"], "overlayOnly": self.request["overlay_only"],
            "canScreenshot": self.dialogues[0].video.is_some(),
            "canTranslate": self.config.ai.enabled && !self.config.ai.anki_field.trim().is_empty(),
            "canTts": !matches!(self.config.vad.tts_url.as_str(), "" | "http://127.0.0.1:5050/?term=$s"),
            "audio": self.audio_form(0), "dialogue": self.dialogue_form(app, 0),
            "preferences": self.preferences(app)
        })
    }

    fn audio_form(&self, key: usize) -> Value {
        let audio = &self.audio[key];
        let context = audio.context.as_ref();
        json!({
            "id":key, "url":audio.url, "duration":audio.duration,
            "initialRange":audio.initial_range, "initialCuts":audio.initial_cuts,
            "available":!audio.source.as_os_str().is_empty(), "reused":key == 0 && self.request["reusing_audio"] == true,
            "voice":audio.vad["voice_detected"].as_bool().unwrap_or(audio.vad["success"] == true),
            "vadRan":audio.vad["success"].is_boolean(), "tts":audio.vad["tts_used"] == true,
            "fallback":context.is_some_and(|c| c.timing_fallback),
            "offset":context.map_or(0., |c| c.range_start),
            "canExpandStart":context.is_some_and(|c| c.range_start > 0.01),
            "canExpandEnd":context.is_some_and(|c| c.range_end + 0.01 < c.source_duration)
        })
    }

    fn neighbors(&self, app: &AppHandle, key: usize) -> (Option<GameLine>, Option<GameLine>) {
        let lines = &self.dialogues[key].lines;
        let (Some(first), Some(last)) = (lines.first(), lines.last()) else {
            return (None, None);
        };
        if !self.review {
            let intake = app.state::<crate::text_intake::Intake>();
            return (
                intake.review_neighbor(&first.id, false),
                intake.review_neighbor(&last.id, true),
            );
        }
        let context = self
            .future
            .as_ref()
            .map(|(_, _, lines)| lines.as_slice())
            .unwrap_or(&self.context);
        let before = context
            .iter()
            .rev()
            .find(|line| line.time_epoch < first.time_epoch);
        let after = context
            .iter()
            .find(|line| line.time_epoch > last.time_epoch);
        (before.cloned(), after.cloned())
    }

    fn dialogue_form(&self, app: &AppHandle, key: usize) -> Value {
        let dialogue = &self.dialogues[key];
        let (prev, next) = self.neighbors(app, key);
        json!({
            "id":key, "previous":prev.map(|l| l.text), "next":next.map(|l| l.text),
            "lines": dialogue.lines.iter().map(|l| &l.text).collect::<Vec<_>>(),
            "visible":!dialogue.lines.is_empty() && dialogue.video.is_some()
        })
    }

    pub async fn change(&mut self, app: &AppHandle, payload: &Value) -> Result<Value, String> {
        let key = index(&payload["dialogue"], self.dialogues.len())?;
        let direction = payload["next"]
            .as_bool()
            .ok_or("Missing dialogue direction")?;
        let (previous, next) = self.neighbors(app, key);
        let added =
            if direction { next } else { previous }.ok_or("No adjacent dialogue is available")?;
        let original = &self.dialogues[key];
        let mut lines = original.lines.clone();
        if direction {
            lines.push(added);
        } else {
            lines.insert(0, added);
        }
        let mut video = original.video.clone().ok_or("The replay is unavailable")?;
        let mut end = original.end;
        let tools = self.scratch_tools(app);
        let service = app.state::<Arc<MiningService>>();
        if let Some((path, timestamp, future_lines)) = &self.future {
            if lines
                .iter()
                .all(|line| future_lines.iter().any(|future| line.id == future.id))
                && lines
                    .iter()
                    .any(|line| !self.context.iter().any(|original| original.id == line.id))
            {
                video = path.clone();
                end = Some(*timestamp);
            }
        }
        if !self.review && end.is_some_and(|t| lines.last().unwrap().time_epoch + 0.25 > t) {
            let (dir, saved) = fresh_replay(app).await?;
            video = saved;
            end = file_mtime_epoch(&video);
            self.owned_replays.push(dir);
        }
        let card = AnkiCard {
            note_id: 0,
            tags: Vec::new(),
            cards: Vec::new(),
            model_name: String::new(),
            fields: vec![(
                self.config.anki.sentence.name.clone(),
                gsm_mining::config::AnkiCardField {
                    value: string(&self.request["sentence"]).into(),
                    order: 0,
                },
            )],
        };
        let sentence = build_selected_lines_sentence(&card, &lines, &self.config);
        let selected_end = lines.last().unwrap();
        let cutoff = if self.review {
            self.future
                .as_ref()
                .map(|(_, _, lines)| lines.as_slice())
                .unwrap_or(&self.context)
                .iter()
                .find(|l| l.time_epoch > selected_end.time_epoch)
                .map(|l| l.time_epoch)
        } else {
            app.state::<crate::text_intake::Intake>()
                .review_neighbor(&selected_end.id, true)
                .map(|l| l.time_epoch)
        };
        let mined =
            crate::mining::session_review::parse_game_line_value(&self.request["mined_line"]);
        let mut audio_result = Value::Null;
        let mut audio = index(&payload["audio"], self.audio.len())?;
        if self.config.audio.enabled && self.config.anki.sentence_audio.is_active() {
            let config = self.config.clone();
            let source = video.clone();
            let full = remove_html_and_cloze_tags(&sentence);
            let start = lines[0].clone();
            let pauses = Arc::clone(&service.pause_history);
            let mut saved_pauses = self.request["pauses"].clone();
            if let Some(array) = self.request["future_pauses"]
                .as_array()
                .filter(|_| video != self.dialogues[0].video.clone().unwrap_or_default())
            {
                saved_pauses = json!(array);
            }
            let vad = Arc::clone(&service.vad);
            let http = app.state::<DesktopState>().http.clone();
            let media = tools.clone();
            let replay = tauri::async_runtime::spawn_blocking(move || {
                let local_pauses = crate::mining::session_review::saved_pause_history(
                    &saved_pauses,
                    &media.temp_dir,
                );
                gsm_mining::policy::extract_replay_audio(
                    &media,
                    &vad,
                    local_pauses.as_ref().unwrap_or(&pauses),
                    &source,
                    &start,
                    cutoff,
                    end,
                    mined.as_ref(),
                    &full,
                    &start.scene,
                    &config,
                    Some(&http),
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            let path = file(&json!(&replay.final_audio_output))
                .or_else(|| file(&json!(&replay.vad_trimmed_audio)));
            audio_result = serde_json::to_value(&replay).map_err(|e| e.to_string())?;
            audio = self.add_audio(
                &tools,
                path,
                replay.audio_edit_context,
                audio_result["vad_result"].clone(),
            );
        }
        let mut translation = string(&payload["translation"]).to_owned();
        let mut regenerated = false;
        if payload["refreshTranslation"] == true && self.config.ai.enabled {
            if let Ok(result) = super::translate(app, &self.config, &sentence, &lines[0]).await {
                if !result.trim().is_empty() {
                    translation = result;
                    regenerated = true;
                }
            }
        }
        let key = self.dialogues.len();
        self.dialogues.push(Dialogue {
            lines,
            video: Some(video),
            end,
            audio_result,
            translation_regenerated: regenerated,
        });
        Ok(
            json!({"dialogue":self.dialogue_form(app,key), "audio":self.audio_form(audio), "sentence":sentence, "translation":translation}),
        )
    }

    pub fn refresh(&self, app: &AppHandle, payload: &Value) -> Result<Value, String> {
        Ok(self.dialogue_form(app, index(&payload["dialogue"], self.dialogues.len())?))
    }

    pub async fn select_picture(
        &mut self,
        app: &AppHandle,
        payload: &Value,
    ) -> Result<Value, String> {
        let dialogue = &self.dialogues[index(&payload["dialogue"], self.dialogues.len())?];
        let previous = payload["previous"] == true;
        let video = dialogue.video.clone().ok_or("The replay is unavailable")?;
        let field = if previous {
            "previous_screenshot_timestamp"
        } else {
            "screenshot_timestamp"
        };
        let mut time = self.request[field].as_f64().unwrap_or(0.0);
        if dialogue.video != self.dialogues[0].video {
            let tools = media_tools(app);
            if let (Some(original), Some(old_end), Some(new_end)) = (
                self.dialogues[0].video.as_deref(),
                self.dialogues[0].end,
                dialogue.end,
            ) {
                time = (time + old_end - tools.get_video_duration(original) - new_end
                    + tools.get_video_duration(&video))
                .max(0.0);
            }
        }
        let Some(export) = crate::screenshot_selector::open_with_config(
            app,
            video.clone(),
            time,
            None,
            self.config.clone(),
        )
        .await?
        else {
            return Ok(Value::Null);
        };
        let items = export
            .items
            .iter()
            .map(|(path, start)| json!({"path":path,"start":start}))
            .collect::<Vec<_>>();
        let mut picture = self.picture(json!({"source_path":video,"items":items}), previous);
        picture.export = Some(export);
        let list = if previous {
            &mut self.previous
        } else {
            &mut self.pictures
        };
        let key = list.len();
        let reply = json!({"id":key,"url":picture.url});
        list.push(picture);
        Ok(reply)
    }

    pub async fn generate_tts(
        &mut self,
        app: &AppHandle,
        payload: &Value,
    ) -> Result<Value, String> {
        let sentence = remove_html_and_cloze_tags(string(&payload["sentence"]));
        if sentence.trim().is_empty() || self.config.vad.tts_url.is_empty() {
            return Err("No text or TTS service is available".into());
        }
        let encoded: String = url::form_urlencoded::byte_serialize(sentence.as_bytes()).collect();
        let url = self.config.vad.tts_url.replace("$s", &encoded);
        let response = app
            .state::<DesktopState>()
            .http
            .get(url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| e.without_url().to_string())?;
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        let tools = self.scratch_tools(app);
        let raw = self.dir.path().join("tts-download");
        std::fs::write(&raw, bytes).map_err(|e| e.to_string())?;
        let path = render_ranges(&tools, &self.config, &raw, &[])?;
        let key = self.add_audio(
            &tools,
            Some(path),
            None,
            json!({"success":true,"tts_used":true}),
        );
        Ok(self.audio_form(key))
    }

    pub fn expand(&mut self, app: &AppHandle, payload: &Value) -> Result<Value, String> {
        let key = index(&payload["audio"], self.audio.len())?;
        let audio = &self.audio[key];
        let mut context = audio
            .context
            .clone()
            .ok_or("The source audio is unavailable")?;
        let step = self.preferences(app)["step"].as_f64().unwrap();
        let old_start = context.range_start;
        let scale = if context.rebase_on_selection_trim && audio.duration > 0.0 {
            (context.range_end - context.range_start) / audio.duration
        } else {
            1.0
        };
        let start = payload["start"]
            .as_f64()
            .unwrap_or(0.0)
            .clamp(0., audio.duration);
        let end = payload["end"]
            .as_f64()
            .unwrap_or(audio.duration)
            .clamp(start, audio.duration);
        let left = payload["left"] == true;
        if left {
            context.range_start = (context.range_start - step).max(0.0);
        } else {
            context.range_end = (context.range_end + step).min(context.source_duration);
        }
        context.rebase_on_selection_trim = false;
        context.condensed = None;
        let tools = self.scratch_tools(app);
        let rendered = render_ranges(
            &tools,
            &self.config,
            Path::new(&context.source_audio_path),
            &[[context.range_start, context.range_end]],
        )?;
        let shift = old_start - context.range_start;
        let duration = context.range_end - context.range_start;
        let expand_selection = |[start, end]: [f64; 2]| {
            if left { [0.0, end * scale + shift] } else { [start * scale, duration] }
        };
        let initial_range = expand_selection(audio.initial_range);
        let initial_cuts = audio.initial_cuts.clone();
        let key = self.add_audio(&tools, Some(rendered), Some(context), audio.vad.clone());
        let audio = &mut self.audio[key];
        let selection = expand_selection([start, end]).map(|t| t.clamp(0.0, audio.duration));
        audio.initial_range = initial_range.map(|t| t.clamp(0.0, audio.duration));
        audio.initial_cuts = initial_cuts
            .into_iter()
            .map(|cut| cut.map(|t| (t * scale + shift).clamp(0.0, audio.duration)))
            .filter(|[start, end]| end > start)
            .collect();
        Ok(json!({"audio":self.audio_form(key),"selection":selection,"shift":shift,"scale":scale}))
    }

    fn filtered_audio(
        &mut self,
        app: &AppHandle,
        key: usize,
        filter: AudioFilter,
    ) -> Result<PathBuf, String> {
        let tools = self.scratch_tools(app);
        let audio = &mut self.audio[key];
        if let Some(path) = audio.filters.get(&filter) {
            return Ok(path.clone());
        }
        let input = audio.wav.as_ref().ok_or("Audio preview is unavailable")?;
        let graph = filter.graph().ok_or("Missing audio filter")?;
        let output = tools.unique_temp_path(".wav");
        let args = vec![
            "-nostdin".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(),
            "-i".into(), input.to_string_lossy().into_owned(),
            "-af".into(), graph.into(), output.to_string_lossy().into_owned(),
        ];
        tools.run_ffmpeg_checked(&args, 0)?;
        audio.filters.insert(filter, output.clone());
        Ok(output)
    }

    pub fn audio_filter(&mut self, app: &AppHandle, payload: &Value) -> Result<Value, String> {
        let key = index(&payload["audio"], self.audio.len())?;
        let filter: AudioFilter = serde_json::from_value(payload["filter"].clone())
            .map_err(|e| e.to_string())?;
        let output = self.filtered_audio(app, key, filter)?;
        Ok(json!(self.asset_url(&output.file_name().unwrap().to_string_lossy())))
    }

    pub fn result(&mut self, app: &AppHandle, edit: Edit) -> Result<Value, String> {
        if edit.audio >= self.audio.len() {
            return Err("Invalid audio selection".into());
        }
        let reused = edit.audio == 0 && self.request["reusing_audio"] == true;
        let filtered = (edit.voice && !reused && edit.filter != AudioFilter::None)
            .then(|| self.filtered_audio(app, edit.audio, edit.filter))
            .transpose()?;
        let audio = &self.audio[edit.audio];
        let dialogue = self
            .dialogues
            .get(edit.dialogue)
            .ok_or("Invalid dialogue selection")?;
        let picture = self
            .pictures
            .get(edit.picture)
            .ok_or("Invalid screenshot selection")?;
        let previous = self
            .previous
            .get(edit.previous_picture)
            .ok_or("Invalid screenshot selection")?;
        let mut modified = edit.audio != 0;
        let mut output = PathBuf::new();
        let mut range = Value::Null;
        if edit.voice && !reused {
            if !audio.source.is_file() {
                return Err("The selected audio is unavailable".into());
            }
            output = audio.source.clone();
            if audio.duration > 0.0 {
                let keep = keep_ranges(audio.duration, edit.start, edit.end, &edit.cuts)?;
                let original = if audio.source_is_condensed {
                    keep_ranges(audio.duration, audio.initial_range[0], audio.initial_range[1], &audio.initial_cuts)?
                } else {
                    vec![[0.0, audio.duration]]
                };
                if filtered.is_some() || keep != original {
                    let input = filtered.as_deref().or(audio.wav.as_deref()).unwrap_or(&audio.source);
                    output = render_ranges(
                        &self.scratch_tools(app),
                        &self.config,
                        input,
                        &keep,
                    )?;
                    modified = true;
                }
            }
            if let Some(c) = &audio.context {
                let length = c.range_end - c.range_start;
                let scale = if c.rebase_on_selection_trim && audio.duration > 0.0 {
                    length / audio.duration
                } else {
                    1.0
                };
                let start = c.range_start + edit.start * scale;
                let end = if audio.duration > 0.0 {
                    c.range_start + edit.end * scale
                } else {
                    c.range_end
                };
                range = if let Some(timeline) = &c.timeline {
                    json!([
                        timeline.to_source(start, false),
                        timeline.to_source(end, true)
                    ])
                } else {
                    json!([start, end])
                };
            }
        }
        let mut replay = dialogue.video.clone();
        let mut current_picture = picture.result.clone();
        let mut previous_picture = previous.result.clone();
        if !self.review {
            let tools = media_tools(app);
            if output.starts_with(self.dir.path()) {
                output = handoff(&tools, &output)?;
            }
            if let Some(source) = replay.as_ref().filter(|path| {
                self.owned_replays
                    .iter()
                    .any(|dir| path.starts_with(dir.path()))
            }) {
                replay = Some(handoff(&tools, source)?);
            }
            for picture in [&mut current_picture, &mut previous_picture] {
                if picture.is_object()
                    && self.owned_replays.iter().any(|dir| {
                        Path::new(string(&picture["source_path"])).starts_with(dir.path())
                    })
                {
                    if picture["source_path"] == json!(dialogue.video) {
                        picture["source_path"] = json!(replay);
                    } else {
                        picture["source_path"] =
                            json!(handoff(&tools, Path::new(string(&picture["source_path"])))?);
                    }
                }
            }
            for (list, key) in [
                (&mut self.pictures, edit.picture),
                (&mut self.previous, edit.previous_picture),
            ] {
                if let Some(export) = list[key].export.take() {
                    export.release();
                }
            }
        }
        Ok(
            json!([edit.voice || reused,edit.sentence.trim(),edit.translation.trim(),
                current_picture,previous_picture,edit.nsfw,output,
                {"selected_lines":dialogue.lines,"line_selection_changed":edit.dialogue != 0,
                 "audio_result":dialogue.audio_result,"translation_regenerated":dialogue.translation_regenerated,
                 "audio_edit_range":range,"reusing_audio":reused,"audio_changed":modified,
                 "picture_changed":edit.picture != 0,"previous_changed":edit.previous_picture != 0,
                 "replay_path":replay}
            ]),
        )
    }
}

pub(super) fn index(value: &Value, size: usize) -> Result<usize, String> {
    value
        .as_u64()
        .and_then(|i| usize::try_from(i).ok())
        .filter(|i| *i < size)
        .ok_or_else(|| "Invalid card editor selection".into())
}

fn file(value: &Value) -> Option<PathBuf> {
    let path = PathBuf::from(value.as_str()?);
    path.is_file().then_some(path)
}

fn handoff(tools: &MediaTools, source: &Path) -> Result<PathBuf, String> {
    let suffix = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default();
    let path = tools.unique_temp_path(&suffix);
    std::fs::hard_link(source, &path)
        .or_else(|_| std::fs::copy(source, &path).map(|_| ()))
        .map_err(|e| e.to_string())?;
    Ok(path)
}

fn selection_from_kept(duration: f64, kept: &[[f64; 2]]) -> Option<([f64; 2], Vec<[f64; 2]>)> {
    let mut range: Option<[f64; 2]> = None;
    let mut cuts = Vec::new();
    for &[start, end] in kept {
        let start = start.clamp(0.0, duration);
        let end = end.clamp(start, duration);
        if start >= end {
            continue;
        }
        match &mut range {
            Some([_, last]) => {
                if start > *last {
                    cuts.push([*last, start]);
                }
                *last = end.max(*last);
            }
            None => range = Some([start, end]),
        }
    }
    Some((range?, cuts))
}

fn keep_ranges(
    duration: f64,
    start: f64,
    end: f64,
    cuts: &[[f64; 2]],
) -> Result<Vec<[f64; 2]>, String> {
    if !start.is_finite() || !end.is_finite() || cuts.len() > 100 {
        return Err("Invalid audio range".into());
    }
    let start = start.clamp(0., duration);
    let end = end.clamp(start, duration);
    let mut cuts = cuts.to_vec();
    cuts.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut cursor = start;
    let mut ranges = Vec::new();
    for [from, to] in cuts {
        if !from.is_finite() || !to.is_finite() || from >= to {
            return Err("Invalid audio cut".into());
        }
        let from = from.clamp(start, end);
        let to = to.clamp(start, end);
        if from > cursor {
            ranges.push([cursor, from]);
        }
        cursor = cursor.max(to);
    }
    if end > cursor {
        ranges.push([cursor, end]);
    }
    if ranges.is_empty() {
        return Err("The cuts remove all selected audio".into());
    }
    Ok(ranges)
}

fn render_ranges(
    tools: &MediaTools,
    config: &ProfileConfig,
    input: &Path,
    ranges: &[[f64; 2]],
) -> Result<PathBuf, String> {
    let extension = if audio_format_spec(&config.audio.extension).is_some() {
        &config.audio.extension
    } else {
        "mp3"
    };
    let spec = audio_format_spec(extension).unwrap();
    let output = tools.unique_temp_path(&format!(".{extension}"));
    let mut args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        input.to_string_lossy().into_owned(),
        "-vn".into(),
    ];
    if !ranges.is_empty() {
        let segments = ranges
            .iter()
            .enumerate()
            .map(|(i, [start, end])| {
                format!("[0:a]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS[a{i}];")
            })
            .collect::<String>();
        let names = (0..ranges.len())
            .map(|i| format!("[a{i}]"))
            .collect::<String>();
        args.extend([
            "-filter_complex".into(),
            format!("{segments}{names}concat=n={}:v=0:a=1[out]", ranges.len()),
            "-map".into(),
            "[out]".into(),
        ]);
    }
    args.extend([
        "-c:a".into(),
        spec.codec.into(),
        output.to_string_lossy().into_owned(),
    ]);
    tools.run_ffmpeg_checked(&args, 0)?;
    Ok(output)
}

async fn fresh_replay(app: &AppHandle) -> Result<(tempfile::TempDir, PathBuf), String> {
    let saved = app.state::<crate::obs::Obs>().save_replay(app).await?;
    let path = PathBuf::from(
        saved["savedReplayPath"]
            .as_str()
            .ok_or("OBS did not return a saved replay")?,
    );
    use std::time::Duration;
    if !gsm_mining::ffmpeg::wait_for_stable_file_async(
        path.clone(),
        Duration::from_secs(10),
        Duration::from_millis(100),
    )
    .await
    {
        return Err("The fresh replay could not be read".into());
    }
    let dir = tempfile::Builder::new()
        .prefix("gsm-card-replay-")
        .tempdir_in(media_tools(app).temp_dir)
        .map_err(|e| e.to_string())?;
    let replay = dir
        .path()
        .join(path.file_name().ok_or("Invalid replay file")?);
    std::fs::hard_link(&path, &replay)
        .or_else(|_| std::fs::copy(&path, &replay).map(|_| ()))
        .map_err(|e| e.to_string())?;
    if app
        .state::<Arc<MiningService>>()
        .load_config()?
        .paths
        .remove_video
    {
        let _ = std::fs::remove_file(path);
    }
    Ok((dir, replay))
}

#[cfg(test)]
mod tests {
    use super::{keep_ranges, selection_from_kept};

    #[test]
    fn audio_cuts_are_clamped_and_overlapping_cuts_remove_audio_only_once() {
        assert_eq!(
            keep_ranges(10., 2., 9., &[[5., 8.], [4., 6.], [0., 3.]]).unwrap(),
            [[3., 4.], [8., 9.]]
        );
        assert!(keep_ranges(10., 2., 9., &[[0., 10.]]).is_err());
    }

    #[test]
    fn condensed_segments_become_outer_trim_and_editable_gaps() {
        let (range, mut cuts) =
            selection_from_kept(8.0, &[[1.0, 2.0], [3.0, 4.0], [3.5, 5.0], [7.0, 9.0]]).unwrap();
        assert_eq!(range, [1.0, 8.0]);
        assert_eq!(cuts, [[2.0, 3.0], [5.0, 7.0]]);
        assert_eq!(
            keep_ranges(8.0, range[0], range[1], &cuts).unwrap(),
            [[1.0, 2.0], [3.0, 5.0], [7.0, 8.0]]
        );
        cuts[0][0] = 2.5;
        cuts.remove(1);
        assert_eq!(
            keep_ranges(8.0, 0.5, range[1], &cuts).unwrap(),
            [[0.5, 2.5], [3.0, 8.0]]
        );
    }
}
