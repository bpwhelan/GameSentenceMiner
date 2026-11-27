//! Mining profile configuration schema, Anki card model, and field policy helpers.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const FIRERED: &str = "FIRERED";
pub const SILERO: &str = "SILERO";
pub const WHISPER: &str = "WHISPER";
pub const OFF: &str = "OFF";

pub const AI_GEMINI: &str = "Gemini";
pub const AI_GROQ: &str = "Groq";
pub const AI_ZAI: &str = "Z.ai";
pub const AI_OPENAI: &str = "OpenAI";
pub const AI_OLLAMA: &str = "Ollama";
pub const AI_LM_STUDIO: &str = "LM Studio";
pub const AI_DEEPL: &str = "DeepL";
pub const AI_GSM_CLOUD: &str = "GSM Cloud";

pub const DEFAULT_GEMINI_MODEL: &str = "gemini-3.5-flash-lite";
pub const DEFAULT_GEMINI_BACKUP_MODEL: &str = "gemma-4-31b-it";
pub const DEFAULT_GROQ_MODEL: &str = "openai/gpt-oss-120b";
pub const DEFAULT_GROQ_BACKUP_MODEL: &str = "openai/gpt-oss-20b";
pub const GSM_CLOUD_DEFAULT_MODEL: &str = "openai/gpt-oss-120b";
pub const ANIMATED_SCREENSHOT_CODEC_DEFAULT: &str = "libsvtav1";
pub const ANIMATED_SCREENSHOT_CODECS: &[&str] = &["libsvtav1", "libaom-av1"];
pub const OPENAI_REASONING_EFFORTS: &[&str] =
    &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioFormatSpec {
    pub codec: &'static str,
    pub format: &'static str,
}

pub fn audio_format_spec(ext: &str) -> Option<AudioFormatSpec> {
    match ext.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
        "opus" => Some(AudioFormatSpec {
            codec: "libopus",
            format: "opus",
        }),
        "mp3" => Some(AudioFormatSpec {
            codec: "libmp3lame",
            format: "mp3",
        }),
        "ogg" => Some(AudioFormatSpec {
            codec: "libvorbis",
            format: "ogg",
        }),
        "aac" => Some(AudioFormatSpec {
            codec: "aac",
            format: "adts",
        }),
        "m4a" => Some(AudioFormatSpec {
            codec: "aac",
            format: "ipod",
        }),
        _ => None,
    }
}

pub fn normalize_gemini_model_name(model_name: &str) -> String {
    let trimmed = model_name.trim().trim_start_matches("models/");
    if trimmed.is_empty() {
        return String::new();
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("gemini-2.") {
        return DEFAULT_GEMINI_MODEL.to_string();
    }
    match lowered.as_str() {
        "gemini-3-flash" => "gemini-3-flash-preview".to_string(),
        "gemini-3-pro" => "gemini-3-pro-preview".to_string(),
        _ => trimmed.to_string(),
    }
}

mod languages;
pub use languages::{language_display_name, profile_language_name};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnkiFieldConfig {
    pub name: String,
    pub enabled: bool,
    pub overwrite: bool,
    pub append: bool,
    #[serde(default)]
    pub core: bool,
}

impl AnkiFieldConfig {
    pub fn normalize(&mut self) {
        if self.core {
            self.enabled = true;
        }
        if self.overwrite && self.append {
            self.append = false;
        }
    }

    pub fn is_active(&self) -> bool {
        self.enabled && !self.name.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralConfig {
    pub native_language: String,
    pub target_language: String,
    pub single_port: u16,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            native_language: "en".into(),
            target_language: "ja".into(),
            single_port: 7275,
        }
    }
}

impl GeneralConfig {
    pub fn native_language_name(&self) -> &'static str {
        language_display_name(&self.native_language)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathsConfig {
    pub folder_to_watch: String,
    pub output_folder: String,
    pub copy_temp_files_to_output_folder: bool,
    pub open_output_folder_on_card_creation: bool,
    pub copy_trimmed_replay_to_output_folder: bool,
    pub remove_video: bool,
    pub remove_audio: bool,
    pub remove_screenshot: bool,
}

impl Default for PathsConfig {
    fn default() -> Self {
        Self {
            folder_to_watch: String::new(),
            output_folder: String::new(),
            copy_temp_files_to_output_folder: false,
            open_output_folder_on_card_creation: false,
            copy_trimmed_replay_to_output_folder: false,
            remove_video: true,
            remove_audio: false,
            remove_screenshot: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiConfig {
    pub enabled: bool,
    pub show_update_confirmation_dialog_v2: bool,
    pub skip_confirmation_for_unvoiced: bool,
    pub auto_accept_timer: i64,
    pub url: String,
    pub note_type: String,
    pub sentence: AnkiFieldConfig,
    pub sentence_audio: AnkiFieldConfig,
    pub picture: AnkiFieldConfig,
    pub word: AnkiFieldConfig,
    pub previous_sentence: AnkiFieldConfig,
    pub previous_image: AnkiFieldConfig,
    pub video: AnkiFieldConfig,
    pub sentence_furigana: AnkiFieldConfig,
    pub game_name: AnkiFieldConfig,
    pub custom_tags: Vec<String>,
    pub tags_to_check: Vec<String>,
    pub add_game_tag: bool,
    pub polling_rate_v2: u64,
    pub parent_tag: String,
    pub reuse_audio_for_same_selected_lines_different_mined_line: bool,
    pub reuse_screenshot_for_same_selected_lines_different_mined_line: bool,
    pub field_grouping_enabled: bool,
    pub field_grouping_auto_merge: bool,
    pub field_grouping_order: String,
    pub field_grouping_delete_duplicate: bool,
    pub field_grouping_additional_fields: Vec<String>,
    pub field_grouping_overwrite: bool,
    pub tag_unvoiced_cards: bool,
    pub remove_overlay_tag: bool,
}

impl Default for AnkiConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            show_update_confirmation_dialog_v2: true,
            skip_confirmation_for_unvoiced: false,
            auto_accept_timer: 10,
            url: "http://127.0.0.1:8765".into(),
            note_type: String::new(),
            sentence: AnkiFieldConfig {
                name: "Sentence".into(),
                enabled: true,
                overwrite: true,
                append: false,
                core: true,
            },
            sentence_audio: AnkiFieldConfig {
                name: "SentenceAudio".into(),
                enabled: true,
                overwrite: true,
                append: false,
                core: true,
            },
            picture: AnkiFieldConfig {
                name: "Picture".into(),
                enabled: true,
                overwrite: true,
                append: false,
                core: true,
            },
            word: AnkiFieldConfig {
                name: "Expression".into(),
                enabled: true,
                overwrite: true,
                append: false,
                core: true,
            },
            previous_sentence: AnkiFieldConfig {
                name: String::new(),
                enabled: true,
                overwrite: false,
                append: false,
                core: false,
            },
            previous_image: AnkiFieldConfig {
                name: String::new(),
                enabled: true,
                overwrite: true,
                append: false,
                core: false,
            },
            video: AnkiFieldConfig {
                name: String::new(),
                enabled: true,
                overwrite: true,
                append: false,
                core: false,
            },
            sentence_furigana: AnkiFieldConfig {
                name: "SentenceFurigana".into(),
                enabled: true,
                overwrite: true,
                append: false,
                core: false,
            },
            game_name: AnkiFieldConfig {
                name: String::new(),
                enabled: true,
                overwrite: true,
                append: false,
                core: false,
            },
            custom_tags: vec!["GSM".into()],
            tags_to_check: Vec::new(),
            add_game_tag: true,
            polling_rate_v2: 1000,
            parent_tag: "Game".into(),
            reuse_audio_for_same_selected_lines_different_mined_line: true,
            reuse_screenshot_for_same_selected_lines_different_mined_line: false,
            field_grouping_enabled: false,
            field_grouping_auto_merge: false,
            field_grouping_order: "front".into(),
            field_grouping_delete_duplicate: true,
            field_grouping_additional_fields: vec![
                "SentenceTranslation".into(),
                "MiscInfo".into(),
                "Tag".into(),
            ],
            field_grouping_overwrite: false,
            tag_unvoiced_cards: false,
            remove_overlay_tag: false,
        }
    }
}

impl AnkiConfig {
    pub fn field_config(&self, key: &str) -> Option<&AnkiFieldConfig> {
        match key {
            "sentence_field" | "sentence" => Some(&self.sentence),
            "sentence_audio_field" | "sentence_audio" => Some(&self.sentence_audio),
            "picture_field" | "picture" => Some(&self.picture),
            "word_field" | "word" => Some(&self.word),
            "previous_sentence_field" | "previous_sentence" => Some(&self.previous_sentence),
            "previous_image_field" | "previous_image" => Some(&self.previous_image),
            "video_field" | "video" => Some(&self.video),
            "sentence_furigana_field" | "sentence_furigana" => Some(&self.sentence_furigana),
            "game_name_field" | "game_name" => Some(&self.game_name),
            _ => None,
        }
    }

    pub fn field_config_mut(&mut self, key: &str) -> Option<&mut AnkiFieldConfig> {
        match key {
            "sentence_field" | "sentence" => Some(&mut self.sentence),
            "sentence_audio_field" | "sentence_audio" => Some(&mut self.sentence_audio),
            "picture_field" | "picture" => Some(&mut self.picture),
            "word_field" | "word" => Some(&mut self.word),
            "previous_sentence_field" | "previous_sentence" => Some(&mut self.previous_sentence),
            "previous_image_field" | "previous_image" => Some(&mut self.previous_image),
            "video_field" | "video" => Some(&mut self.video),
            "sentence_furigana_field" | "sentence_furigana" => Some(&mut self.sentence_furigana),
            "game_name_field" | "game_name" => Some(&mut self.game_name),
            _ => None,
        }
    }

    pub fn field_is_active(&self, key: &str) -> bool {
        self.field_config(key).is_some_and(AnkiFieldConfig::is_active)
    }

    pub fn base_polling_rate_seconds(&self) -> f64 {
        ((self.polling_rate_v2 as f64) / 1000.0).max(0.1)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewAfterSessionConfig {
    pub enabled: bool,
    pub open_on_card_queued: bool,
    pub max_future_context_lines: i64,
}

impl Default for ReviewAfterSessionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            open_on_card_queued: true,
            max_future_context_lines: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeaturesConfig {
    pub open_anki_edit: bool,
    pub open_anki_in_browser: bool,
    pub browser_query: String,
    pub generate_longplay: bool,
    pub review_after_session: ReviewAfterSessionConfig,
}

impl Default for FeaturesConfig {
    fn default() -> Self {
        Self {
            open_anki_edit: false,
            open_anki_in_browser: false,
            browser_query: String::new(),
            generate_longplay: false,
            review_after_session: ReviewAfterSessionConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimatedScreenshotConfig {
    pub fps: u32,
    pub extension: String,
    pub codec: String,
    pub quality: u32,
    pub max_width: u32,
    pub adaptive_avif: bool,
    pub target_size_kb: u32,
    pub size_priority: String,
    pub only_when_voice: bool,
    pub faststart: bool,
    pub encoder_fallback: bool,
    pub scaled_quality: u32,
}

impl Default for AnimatedScreenshotConfig {
    fn default() -> Self {
        let mut cfg = Self {
            fps: 15,
            extension: "avif".into(),
            codec: ANIMATED_SCREENSHOT_CODEC_DEFAULT.into(),
            quality: 8,
            max_width: 960,
            adaptive_avif: false,
            target_size_kb: 0,
            size_priority: "balanced".into(),
            only_when_voice: false,
            faststart: true,
            encoder_fallback: true,
            scaled_quality: 28,
        };
        cfg.normalize();
        cfg
    }
}

impl AnimatedScreenshotConfig {
    pub fn normalize(&mut self) {
        self.extension = "avif".into();
        self.fps = self.fps.clamp(1, 60);
        self.quality = self.quality.min(10);
        self.max_width = self.max_width.min(3840);
        self.target_size_kb = self.target_size_kb.min(102_400);
        if !matches!(
            self.size_priority.as_str(),
            "prefer_fps" | "prefer_quality" | "balanced"
        ) {
            self.size_priority = "balanced".into();
        }
        if !ANIMATED_SCREENSHOT_CODECS.contains(&self.codec.as_str()) {
            self.codec = ANIMATED_SCREENSHOT_CODEC_DEFAULT.into();
        }
        self.scaled_quality = Self::scale_quality(self.quality, &self.extension, &self.codec);
    }

    pub fn scale_quality(q: u32, extension: &str, av1_encoder: &str) -> u32 {
        let q = q.min(10);
        match extension {
            "webp" => 60 + q * 2,
            "avif" => {
                if av1_encoder == "libsvtav1" {
                    (45.0 - (q as f64) * 2.1) as u32
                } else {
                    (45.0 - (q as f64) * 3.5) as u32
                }
            }
            _ => q,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotConfig {
    pub enabled: bool,
    pub quality: String,
    pub extension: String,
    pub custom_ffmpeg_settings: String,
    pub animated: bool,
    pub animated_settings: AnimatedScreenshotConfig,
    pub seconds_after_line: f64,
    pub screenshot_timing_setting: String,
    pub trim_black_bars_wip: bool,
}

impl Default for ScreenshotConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            quality: "85".into(),
            extension: "avif".into(),
            custom_ffmpeg_settings: String::new(),
            animated: false,
            animated_settings: AnimatedScreenshotConfig::default(),
            seconds_after_line: 1.0,
            screenshot_timing_setting: "beginning".into(),
            trim_black_bars_wip: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    pub enabled: bool,
    pub extension: String,
    pub beginning_offset: f64,
    pub end_offset: f64,
    pub pre_vad_end_offset: f64,
    pub ffmpeg_reencode_options: String,
    pub ffmpeg_reencode_options_to_use: String,
    pub external_tool: String,
    pub anki_media_collection: String,
    pub external_tool_enabled: bool,
}

impl Default for AudioConfig {
    fn default() -> Self {
        let default_reencode = if cfg!(windows) {
            r#"-c:a {encoder} -f {format} -af "afade=t=in:d=0.005""#.to_string()
        } else {
            String::new()
        };
        let mut cfg = Self {
            enabled: true,
            extension: "mp3".into(),
            beginning_offset: -0.5,
            end_offset: 0.5,
            pre_vad_end_offset: 0.0,
            ffmpeg_reencode_options: default_reencode,
            ffmpeg_reencode_options_to_use: String::new(),
            external_tool: String::new(),
            anki_media_collection: default_anki_media_collection_path(),
            external_tool_enabled: true,
        };
        cfg.normalize();
        cfg
    }
}

impl AudioConfig {
    pub fn normalize(&mut self) {
        let spec = audio_format_spec(&self.extension);
        let fmt = if spec.is_some() {
            self.extension.as_str()
        } else {
            "mp3"
        };
        let codec = spec.map(|s| s.codec).unwrap_or("libmp3lame");
        self.ffmpeg_reencode_options_to_use = self
            .ffmpeg_reencode_options
            .replace("{format}", fmt)
            .replace("{encoder}", codec);
        if self.anki_media_collection.trim().is_empty() {
            self.anki_media_collection = default_anki_media_collection_path();
        }
    }
}

pub fn default_anki_media_collection_path() -> String {
    #[cfg(windows)]
    {
        if let Some(base) = dirs::data_dir() {
            return base
                .join("Anki2")
                .join("User 1")
                .join("collection.media")
                .to_string_lossy()
                .into_owned();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(base) = dirs::data_dir() {
            return base
                .join("Anki2")
                .join("User 1")
                .join("collection.media")
                .to_string_lossy()
                .into_owned();
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(base) = dirs::data_local_dir() {
            return base
                .join("Anki2")
                .join("User 1")
                .join("collection.media")
                .to_string_lossy()
                .into_owned();
        }
    }
    String::new()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObsConfig {
    pub replay_buffer_duration_seconds: u64,
    pub get_game_from_scene: bool,
    pub disable_recording: bool,
}

impl Default for ObsConfig {
    fn default() -> Self {
        Self {
            replay_buffer_duration_seconds: 300,
            get_game_from_scene: true,
            disable_recording: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub do_vad_postprocessing: bool,
    pub selected_vad_model_v2: String,
    pub backup_vad_model: String,
    pub trim_beginning: bool,
    pub beginning_offset: f64,
    pub adaptive_preroll: bool,
    pub add_audio_on_no_results: bool,
    pub use_tts_as_fallback: bool,
    pub tts_url: String,
    pub cut_and_splice_segments: bool,
    pub splice_padding: f64,
    pub preload_vad_model: bool,
    pub short_audio_min_seconds: f64,
    pub short_audio_seconds_per_char: f64,
    pub firered_smooth_window_size: usize,
    pub firered_speech_threshold: f32,
    pub firered_min_speech_frame: usize,
    pub firered_max_speech_frame: usize,
    pub firered_min_silence_frame: usize,
    pub firered_merge_silence_frame: usize,
    pub firered_extend_speech_frame: usize,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            do_vad_postprocessing: true,
            selected_vad_model_v2: FIRERED.into(),
            backup_vad_model: OFF.into(),
            trim_beginning: false,
            beginning_offset: -0.25,
            adaptive_preroll: false,
            add_audio_on_no_results: false,
            use_tts_as_fallback: false,
            tts_url: "http://127.0.0.1:5050/?term=$s".into(),
            cut_and_splice_segments: false,
            splice_padding: 0.1,
            preload_vad_model: true,
            short_audio_min_seconds: 0.5,
            short_audio_seconds_per_char: 0.05,
            firered_smooth_window_size: 5,
            firered_speech_threshold: 0.4,
            firered_min_speech_frame: 20,
            firered_max_speech_frame: 2000,
            firered_min_silence_frame: 20,
            firered_merge_silence_frame: 0,
            firered_extend_speech_frame: 0,
        }
    }
}

impl VadConfig {
    pub fn normalize(&mut self) {
        if self.selected_vad_model_v2 == WHISPER {
            self.selected_vad_model_v2 = FIRERED.into();
        }
        if self.backup_vad_model == WHISPER || self.selected_vad_model_v2 == self.backup_vad_model {
            self.backup_vad_model = OFF.into();
        }
    }

    pub fn is_firered(&self) -> bool {
        self.selected_vad_model_v2 == FIRERED || self.backup_vad_model == FIRERED
    }

    pub fn is_silero(&self) -> bool {
        self.selected_vad_model_v2 == SILERO || self.backup_vad_model == SILERO
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub enabled: bool,
    pub auto_generate_character_summary: bool,
    pub anki_field: String,
    pub deepl_api_key: String,
    pub deepl_target_lang: String,
    pub provider: String,
    pub gemini_model: String,
    pub gemini_backup_model: String,
    pub groq_model: String,
    pub groq_backup_model: String,
    pub gemini_api_key: String,
    pub groq_api_key: String,
    pub zai_api_key: String,
    pub zai_model: String,
    pub zai_backup_model: String,
    pub open_ai_url: String,
    pub open_ai_model: String,
    pub open_ai_backup_model: String,
    pub open_ai_api_key: String,
    pub open_ai_reasoning_effort: String,
    pub ollama_url: String,
    pub ollama_model: String,
    pub ollama_backup_model: String,
    pub lm_studio_url: String,
    pub lm_studio_model: String,
    pub lm_studio_backup_model: String,
    pub lm_studio_api_key: String,
    pub gsm_cloud_api_url: String,
    pub gsm_cloud_access_token: String,
    pub gsm_cloud_models: Vec<String>,
    pub use_canned_translation_prompt: bool,
    pub use_canned_context_prompt: bool,
    pub custom_prompt: String,
    pub custom_texthooker_prompt: String,
    pub custom_full_prompt: String,
    pub prompt_preset: String,
    pub dialogue_context_length: i32,
    pub temperature: f64,
    pub max_output_tokens: u32,
    pub top_p: f64,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_generate_character_summary: false,
            anki_field: String::new(),
            deepl_api_key: String::new(),
            deepl_target_lang: "EN".into(),
            provider: AI_GEMINI.into(),
            gemini_model: DEFAULT_GEMINI_MODEL.into(),
            gemini_backup_model: DEFAULT_GEMINI_BACKUP_MODEL.into(),
            groq_model: DEFAULT_GROQ_MODEL.into(),
            groq_backup_model: DEFAULT_GROQ_BACKUP_MODEL.into(),
            gemini_api_key: String::new(),
            groq_api_key: String::new(),
            zai_api_key: String::new(),
            zai_model: "glm-4.7-flash".into(),
            zai_backup_model: String::new(),
            open_ai_url: String::new(),
            open_ai_model: String::new(),
            open_ai_backup_model: String::new(),
            open_ai_api_key: String::new(),
            open_ai_reasoning_effort: String::new(),
            ollama_url: "http://localhost:11434".into(),
            ollama_model: "llama3".into(),
            ollama_backup_model: String::new(),
            lm_studio_url: "http://localhost:1234/v1".into(),
            lm_studio_model: String::new(),
            lm_studio_backup_model: String::new(),
            lm_studio_api_key: "lm-studio".into(),
            gsm_cloud_api_url: "https://api.gamesentenceminer.com".into(),
            gsm_cloud_access_token: String::new(),
            gsm_cloud_models: vec![GSM_CLOUD_DEFAULT_MODEL.into()],
            use_canned_translation_prompt: true,
            use_canned_context_prompt: false,
            custom_prompt: String::new(),
            custom_texthooker_prompt: String::new(),
            custom_full_prompt: String::new(),
            prompt_preset: String::new(),
            dialogue_context_length: 10,
            temperature: 0.3,
            max_output_tokens: 4096,
            top_p: 0.9,
        }
    }
}

impl AiConfig {
    pub fn is_configured(&self) -> bool {
        match self.provider.as_str() {
            AI_GEMINI => !self.gemini_api_key.is_empty() && !self.gemini_model.is_empty(),
            AI_GROQ => !self.groq_api_key.is_empty() && !self.groq_model.is_empty(),
            AI_ZAI => !self.zai_api_key.trim().is_empty() && !self.zai_model.trim().is_empty(),
            AI_OPENAI => !self.open_ai_api_key.is_empty() && !self.open_ai_model.is_empty() && !self.open_ai_url.is_empty(),
            AI_OLLAMA => !self.ollama_model.is_empty() && !self.ollama_url.is_empty(),
            AI_LM_STUDIO => !self.lm_studio_model.is_empty() && !self.lm_studio_url.is_empty(),
            AI_GSM_CLOUD => !self.gsm_cloud_access_token.is_empty(),
            AI_DEEPL => !self.deepl_api_key.is_empty(),
            _ => false,
        }
    }
    pub fn normalize(&mut self, legacy_api_key: &str) {
        self.provider = match self.provider.trim().to_ascii_lowercase().as_str() {
            "gemini" => AI_GEMINI.into(),
            "groq" => AI_GROQ.into(),
            "z.ai" | "zai" => AI_ZAI.into(),
            "openai" => AI_OPENAI.into(),
            "ollama" => AI_OLLAMA.into(),
            "deepl" => AI_DEEPL.into(),
            "lm_studio" | "lm studio" => AI_LM_STUDIO.into(),
            "gsm_cloud" | "gsm cloud" => AI_GSM_CLOUD.into(),
            _ => self.provider.trim().to_string(),
        };
        if self.gemini_api_key.is_empty() && !legacy_api_key.is_empty() {
            self.gemini_api_key = legacy_api_key.to_string();
        }
        if matches!(self.gemini_model.as_str(), "RECOMMENDED" | "OTHER") {
            self.gemini_model = DEFAULT_GEMINI_MODEL.into();
        }
        if self.gemini_backup_model == "RECOMMENDED" {
            self.gemini_backup_model = DEFAULT_GEMINI_BACKUP_MODEL.into();
        }
        if matches!(self.gemini_backup_model.as_str(), "OTHER" | "OFF") {
            self.gemini_backup_model.clear();
        }
        if matches!(self.groq_model.as_str(), "RECOMMENDED" | "OTHER") {
            self.groq_model = DEFAULT_GROQ_MODEL.into();
        }
        if self.groq_backup_model == "RECOMMENDED" {
            self.groq_backup_model = DEFAULT_GROQ_BACKUP_MODEL.into();
        }
        if matches!(self.groq_backup_model.as_str(), "OTHER" | "OFF") {
            self.groq_backup_model.clear();
        }
        for backup in [
            &mut self.open_ai_backup_model,
            &mut self.ollama_backup_model,
            &mut self.lm_studio_backup_model,
        ] {
            if backup == OFF {
                backup.clear();
            }
        }
        if self.deepl_api_key == OFF {
            self.deepl_api_key.clear();
        }
        self.zai_api_key = self.zai_api_key.trim().to_string();
        self.zai_model = self.zai_model.trim().to_string();
        if self.zai_model.is_empty() {
            self.zai_model = "glm-4.7-flash".into();
        }
        self.zai_backup_model = self.zai_backup_model.trim().to_string();
        if self.zai_backup_model == OFF || self.zai_backup_model == self.zai_model {
            self.zai_backup_model.clear();
        }
        self.open_ai_reasoning_effort = self.open_ai_reasoning_effort.trim().to_ascii_lowercase();
        if !OPENAI_REASONING_EFFORTS.contains(&self.open_ai_reasoning_effort.as_str()) {
            self.open_ai_reasoning_effort.clear();
        }
        self.gsm_cloud_api_url = self.gsm_cloud_api_url.trim().trim_end_matches('/').to_string();

        let previous_gemini_backup = self
            .gemini_backup_model
            .trim()
            .trim_start_matches("models/")
            .to_ascii_lowercase();
        self.gemini_model = normalize_gemini_model_name(&self.gemini_model);
        self.gemini_backup_model = normalize_gemini_model_name(&self.gemini_backup_model);
        if self.gemini_backup_model == self.gemini_model {
            self.gemini_backup_model = if previous_gemini_backup.starts_with("gemini-2.") {
                DEFAULT_GEMINI_BACKUP_MODEL.into()
            } else {
                String::new()
            };
        }
        if self.groq_backup_model == self.groq_model {
            self.groq_backup_model.clear();
        }
        if self.open_ai_backup_model == self.open_ai_model {
            self.open_ai_backup_model.clear();
        }
        if self.ollama_backup_model == self.ollama_model {
            self.ollama_backup_model.clear();
        }
        if self.lm_studio_backup_model == self.lm_studio_model {
            self.lm_studio_backup_model.clear();
        }
    }

    pub fn gsm_cloud_primary_model(&self) -> String {
        self.gsm_cloud_models
            .iter()
            .find(|m| !m.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| GSM_CLOUD_DEFAULT_MODEL.into())
    }

    pub fn gsm_cloud_openai_base_url(&self) -> String {
        let base = self.gsm_cloud_api_url.trim_end_matches('/');
        let base = if base.is_empty() { "https://api.gamesentenceminer.com" } else { base };
        format!("{base}/api/cloud/openai/v1")
    }

    pub fn model_for_provider(&self) -> String {
        match self.provider.as_str() {
            AI_GEMINI => self.gemini_model.clone(),
            AI_GROQ => self.groq_model.clone(),
            AI_ZAI => self.zai_model.clone(),
            AI_GSM_CLOUD => self.gsm_cloud_primary_model(),
            AI_OPENAI => self.open_ai_model.clone(),
            AI_OLLAMA => self.ollama_model.clone(),
            AI_LM_STUDIO => self.lm_studio_model.clone(),
            AI_DEEPL => "deepl".into(),
            _ => String::new(),
        }
    }

    pub fn backup_model_for_provider(&self) -> String {
        match self.provider.as_str() {
            AI_GEMINI => self.gemini_backup_model.clone(),
            AI_GROQ => self.groq_backup_model.clone(),
            AI_ZAI => self.zai_backup_model.clone(),
            AI_OPENAI => self.open_ai_backup_model.clone(),
            AI_OLLAMA => self.ollama_backup_model.clone(),
            AI_LM_STUDIO => self.lm_studio_backup_model.clone(),
            _ => String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancedConfig {
    #[serde(default)]
    pub multi_line_line_break: String,
    pub localhost_bind_address: String,
    pub direct_websocket_port: u16,
    pub texthooker_communication_websocket_port: u16,
    pub plaintext_websocket_port: u16,
    pub slowest_polling_rate: u64,
    pub longest_sleep_time: f64,
}

impl Default for AdvancedConfig {
    fn default() -> Self {
        Self {
            multi_line_line_break: "<br>".into(),
            localhost_bind_address: "127.0.0.1".into(),
            direct_websocket_port: 0,
            texthooker_communication_websocket_port: 7276,
            plaintext_websocket_port: 0,
            slowest_polling_rate: 5000,
            longest_sleep_time: 5.0,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileConfig {
    pub name: String,
    pub general: GeneralConfig,
    pub paths: PathsConfig,
    pub anki: AnkiConfig,
    pub features: FeaturesConfig,
    pub screenshot: ScreenshotConfig,
    pub audio: AudioConfig,
    pub obs: ObsConfig,
    pub vad: VadConfig,
    pub ai: AiConfig,
    pub advanced: AdvancedConfig,
}

impl ProfileConfig {
    pub fn review_after_session_enabled(&self) -> bool {
        self.anki.enabled && self.features.review_after_session.enabled
    }

    pub fn load_active(config_path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(config_path).map_err(|e| e.to_string())?;
        let json = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
        let root: Value = serde_json::from_slice(json).map_err(|e| e.to_string())?;
        Self::from_config_json(&root)
    }

    pub fn from_config_json(root: &Value) -> Result<Self, String> {
        let current = root
            .get("current_profile")
            .and_then(Value::as_str)
            .unwrap_or("Default");
        let profile = gsm_settings::gsm_config::active_profile(root);
        let Some(profile) = profile else {
            return Ok(Self {
                name: current.into(),
                ..Self::default()
            });
        };
        Ok(Self::from_profile_object(current, profile))
    }

    pub fn from_profile_object(name: &str, p: &Map<String, Value>) -> Self {
        let mut cfg = Self {
            name: get_str(p, "name").unwrap_or_else(|| name.to_string()),
            ..Self::default()
        };

        if let Some(g) = p.get("general").and_then(Value::as_object) {
            if let Some(v) = get_str(g, "native_language") {
                cfg.general.native_language = v;
            }
            if let Some(v) = get_str(g, "target_language") {
                cfg.general.target_language = v;
            }
            cfg.general.single_port = gsm_settings::gsm_config::primary_port(g);
        }

        if let Some(paths) = p.get("paths").and_then(Value::as_object) {
            if let Some(v) = get_str(paths, "folder_to_watch") {
                cfg.paths.folder_to_watch = v;
            }
            if let Some(v) = get_str(paths, "output_folder") {
                cfg.paths.output_folder = v;
            }
            if let Some(v) = get_bool(paths, "copy_temp_files_to_output_folder") {
                cfg.paths.copy_temp_files_to_output_folder = v;
            }
            if let Some(v) = get_bool(paths, "open_output_folder_on_card_creation") {
                cfg.paths.open_output_folder_on_card_creation = v;
            }
            if let Some(v) = get_bool(paths, "copy_trimmed_replay_to_output_folder") {
                cfg.paths.copy_trimmed_replay_to_output_folder = v;
            }
            if let Some(v) = get_bool(paths, "remove_video") {
                cfg.paths.remove_video = v;
            }
            if let Some(v) = get_bool(paths, "remove_audio") {
                cfg.paths.remove_audio = v;
            }
            if let Some(v) = get_bool(paths, "remove_screenshot") {
                cfg.paths.remove_screenshot = v;
            }
        }

        if let Some(a) = p.get("anki").and_then(Value::as_object) {
            if let Some(v) = get_bool(a, "enabled") {
                cfg.anki.enabled = v;
            }
            if let Some(v) = get_bool(a, "show_update_confirmation_dialog_v2") {
                cfg.anki.show_update_confirmation_dialog_v2 = v;
            }
            if let Some(v) = get_bool(a, "skip_confirmation_for_unvoiced") {
                cfg.anki.skip_confirmation_for_unvoiced = v;
            }
            if let Some(v) = get_i64(a, "auto_accept_timer") {
                cfg.anki.auto_accept_timer = v;
            }
            if let Some(v) = get_str(a, "url") {
                cfg.anki.url = v;
            }
            if let Some(v) = get_str(a, "note_type") {
                cfg.anki.note_type = v;
            }
            let legacy_ow_sentence = get_bool(a, "overwrite_sentence");
            let legacy_ow_audio = get_bool(a, "overwrite_audio");
            let legacy_ow_picture = get_bool(a, "overwrite_picture");
            parse_anki_field(a, "sentence", "sentence_field", legacy_ow_sentence, &mut cfg.anki.sentence);
            parse_anki_field(a, "sentence_audio", "sentence_audio_field", legacy_ow_audio, &mut cfg.anki.sentence_audio);
            parse_anki_field(a, "picture", "picture_field", legacy_ow_picture, &mut cfg.anki.picture);
            parse_anki_field(a, "word", "word_field", None, &mut cfg.anki.word);
            parse_anki_field(a, "previous_sentence", "previous_sentence_field", None, &mut cfg.anki.previous_sentence);
            parse_anki_field(a, "previous_image", "previous_image_field", None, &mut cfg.anki.previous_image);
            parse_anki_field(a, "video", "video_field", None, &mut cfg.anki.video);
            parse_anki_field(a, "sentence_furigana", "sentence_furigana_field", None, &mut cfg.anki.sentence_furigana);
            parse_anki_field(a, "game_name", "game_name_field", None, &mut cfg.anki.game_name);

            if let Some(tags) = get_string_list(a, "custom_tags") {
                cfg.anki.custom_tags = tags;
            }
            if let Some(tags) = get_string_list(a, "tags_to_check") {
                cfg.anki.tags_to_check = tags;
            }
            if let Some(v) = get_bool(a, "add_game_tag") {
                cfg.anki.add_game_tag = v;
            }
            if let Some(v) = get_u64(a, "polling_rate_v2") {
                cfg.anki.polling_rate_v2 = v;
            }
            if let Some(v) = get_str(a, "parent_tag") {
                cfg.anki.parent_tag = v;
            }
            if let Some(v) = get_bool(a, "reuse_audio_for_same_selected_lines_different_mined_line")
            {
                cfg.anki.reuse_audio_for_same_selected_lines_different_mined_line = v;
            }
            if let Some(v) =
                get_bool(a, "reuse_screenshot_for_same_selected_lines_different_mined_line")
            {
                cfg.anki.reuse_screenshot_for_same_selected_lines_different_mined_line = v;
            }
            if let Some(v) = get_bool(a, "field_grouping_enabled") {
                cfg.anki.field_grouping_enabled = v;
            }
            if let Some(v) = get_bool(a, "field_grouping_auto_merge") {
                cfg.anki.field_grouping_auto_merge = v;
            }
            if let Some(v) = get_str(a, "field_grouping_order") {
                let norm = v.trim().to_ascii_lowercase();
                cfg.anki.field_grouping_order = if matches!(norm.as_str(), "front" | "back") {
                    norm
                } else {
                    "front".into()
                };
            }
            if let Some(v) = get_bool(a, "field_grouping_delete_duplicate") {
                cfg.anki.field_grouping_delete_duplicate = v;
            }
            if let Some(raw) = a.get("field_grouping_additional_fields") {
                let mut seen = HashSet::new();
                let mut out = Vec::new();
                let items: Vec<String> = match raw {
                    Value::Array(arr) => arr
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                    Value::String(s) => s.split(',').map(str::to_owned).collect(),
                    _ => Vec::new(),
                };
                for item in items {
                    let t = item.trim().to_string();
                    if !t.is_empty() && seen.insert(t.to_lowercase()) {
                        out.push(t);
                    }
                }
                cfg.anki.field_grouping_additional_fields = out;
            }
            if let Some(v) = get_bool(a, "field_grouping_overwrite") {
                cfg.anki.field_grouping_overwrite = v;
            }
            if let Some(v) = get_bool(a, "tag_unvoiced_cards") {
                cfg.anki.tag_unvoiced_cards = v;
            }
            if let Some(v) = get_bool(a, "remove_overlay_tag") {
                cfg.anki.remove_overlay_tag = v;
            }
        }

        if let Some(f) = p.get("features").and_then(Value::as_object) {
            if let Some(v) = get_bool(f, "open_anki_edit") {
                cfg.features.open_anki_edit = v;
            }
            if let Some(v) = get_bool(f, "open_anki_in_browser") {
                cfg.features.open_anki_in_browser = v;
            }
            if let Some(v) = get_str(f, "browser_query") {
                cfg.features.browser_query = v;
            }
            if let Some(v) = get_bool(f, "generate_longplay") {
                cfg.features.generate_longplay = v;
            }
            if let Some(r) = f.get("review_after_session").and_then(Value::as_object) {
                if let Some(v) = get_bool(r, "enabled") {
                    cfg.features.review_after_session.enabled = v;
                }
                if let Some(v) = get_bool(r, "open_on_card_queued") {
                    cfg.features.review_after_session.open_on_card_queued = v;
                }
                if let Some(v) = get_i64(r, "max_future_context_lines") {
                    cfg.features.review_after_session.max_future_context_lines = v;
                }
            }
        }

        if let Some(s) = p.get("screenshot").and_then(Value::as_object) {
            if let Some(v) = get_bool(s, "enabled") {
                cfg.screenshot.enabled = v;
            }
            if let Some(v) = get_str_or_num(s, "quality") {
                cfg.screenshot.quality = v;
            }
            if let Some(v) = get_str(s, "extension") {
                cfg.screenshot.extension = v;
            }
            if let Some(v) = get_str(s, "custom_ffmpeg_settings") {
                cfg.screenshot.custom_ffmpeg_settings = v;
            }
            if let Some(v) = get_bool(s, "animated") {
                cfg.screenshot.animated = v;
            }
            if let Some(v) = get_f64(s, "seconds_after_line") {
                cfg.screenshot.seconds_after_line = v;
            }
            if let Some(v) = get_str(s, "screenshot_timing_setting") {
                if !v.is_empty() {
                    cfg.screenshot.screenshot_timing_setting = v;
                }
            } else if get_bool(s, "use_beginning_of_line_as_screenshot") == Some(true) {
                cfg.screenshot.screenshot_timing_setting = "beginning".into();
            } else if get_bool(s, "use_new_screenshot_logic") == Some(true) {
                cfg.screenshot.screenshot_timing_setting = "middle".into();
            }
            if let Some(v) = get_bool(s, "trim_black_bars_wip") {
                cfg.screenshot.trim_black_bars_wip = v;
            }
            if let Some(am) = s.get("animated_settings").and_then(Value::as_object) {
                if let Some(v) = get_u64(am, "fps") {
                    cfg.screenshot.animated_settings.fps = v as u32;
                }
                if let Some(v) = get_str(am, "codec") {
                    cfg.screenshot.animated_settings.codec = v;
                }
                if let Some(v) = get_u64(am, "quality") {
                    cfg.screenshot.animated_settings.quality = v as u32;
                }
                if let Some(v) = get_u64(am, "max_width") {
                    cfg.screenshot.animated_settings.max_width = v as u32;
                }
                if let Some(v) = get_bool(am, "adaptive_avif") {
                    cfg.screenshot.animated_settings.adaptive_avif = v;
                }
                if let Some(v) = get_u64(am, "target_size_kb") {
                    cfg.screenshot.animated_settings.target_size_kb = v as u32;
                }
                if let Some(v) = get_str(am, "size_priority") {
                    cfg.screenshot.animated_settings.size_priority = v;
                }
                if let Some(v) = get_bool(am, "only_when_voice") {
                    cfg.screenshot.animated_settings.only_when_voice = v;
                }
                if let Some(v) = get_bool(am, "faststart") {
                    cfg.screenshot.animated_settings.faststart = v;
                }
                if let Some(v) = get_bool(am, "encoder_fallback") {
                    cfg.screenshot.animated_settings.encoder_fallback = v;
                }
                cfg.screenshot.animated_settings.normalize();
            }
        }

        if let Some(au) = p.get("audio").and_then(Value::as_object) {
            if let Some(v) = get_bool(au, "enabled") {
                cfg.audio.enabled = v;
            }
            if let Some(v) = get_str(au, "extension") {
                cfg.audio.extension = v;
            }
            if let Some(v) = get_f64(au, "beginning_offset") {
                cfg.audio.beginning_offset = v;
            }
            if let Some(v) = get_f64(au, "end_offset") {
                cfg.audio.end_offset = v;
            }
            if let Some(v) = get_f64(au, "pre_vad_end_offset") {
                cfg.audio.pre_vad_end_offset = v;
            }
            if let Some(v) = get_str(au, "ffmpeg_reencode_options") {
                cfg.audio.ffmpeg_reencode_options = v;
            }
            if let Some(v) = get_str(au, "external_tool") {
                cfg.audio.external_tool = v;
            }
            if let Some(v) = get_str(au, "anki_media_collection") {
                cfg.audio.anki_media_collection = v;
            }
            if let Some(v) = get_bool(au, "external_tool_enabled") {
                cfg.audio.external_tool_enabled = v;
            }
            cfg.audio.normalize();
        }

        if let Some(o) = p.get("obs").and_then(Value::as_object) {
            if let Some(v) = get_u64(o, "replay_buffer_duration_seconds") {
                cfg.obs.replay_buffer_duration_seconds = v.clamp(1, 86_400);
            }
            if let Some(v) = get_bool(o, "disable_recording") {
                cfg.obs.disable_recording = v;
            }
        }

        if let Some(v) = p.get("vad").and_then(Value::as_object) {
            if let Some(b) = get_bool(v, "do_vad_postprocessing") {
                cfg.vad.do_vad_postprocessing = b;
            }
            if let Some(s) = get_str(v, "selected_vad_model_v2") {
                cfg.vad.selected_vad_model_v2 = s;
            }
            if let Some(s) = get_str(v, "backup_vad_model") {
                cfg.vad.backup_vad_model = s;
            }
            if let Some(b) = get_bool(v, "trim_beginning") {
                cfg.vad.trim_beginning = b;
            }
            if let Some(x) = get_f64(v, "beginning_offset") {
                cfg.vad.beginning_offset = x;
            }
            if let Some(b) = get_bool(v, "adaptive_preroll") {
                cfg.vad.adaptive_preroll = b;
            }
            if let Some(b) = get_bool(v, "add_audio_on_no_results") {
                cfg.vad.add_audio_on_no_results = b;
            }
            if let Some(b) = get_bool(v, "use_tts_as_fallback") {
                cfg.vad.use_tts_as_fallback = b;
            }
            if let Some(s) = get_str(v, "tts_url") {
                cfg.vad.tts_url = s;
            }
            if let Some(b) = get_bool(v, "cut_and_splice_segments") {
                cfg.vad.cut_and_splice_segments = b;
            }
            if let Some(x) = get_f64(v, "splice_padding") {
                cfg.vad.splice_padding = x;
            }
            if let Some(b) = get_bool(v, "preload_vad_model") {
                cfg.vad.preload_vad_model = b;
            }
            if let Some(x) = get_f64(v, "short_audio_min_seconds") {
                cfg.vad.short_audio_min_seconds = x;
            }
            if let Some(x) = get_f64(v, "short_audio_seconds_per_char") {
                cfg.vad.short_audio_seconds_per_char = x;
            }
            if let Some(n) = get_u64(v, "firered_smooth_window_size") {
                cfg.vad.firered_smooth_window_size = n as usize;
            }
            if let Some(x) = get_f64(v, "firered_speech_threshold") {
                cfg.vad.firered_speech_threshold = x as f32;
            }
            if let Some(n) = get_u64(v, "firered_min_speech_frame") {
                cfg.vad.firered_min_speech_frame = n as usize;
            }
            if let Some(n) = get_u64(v, "firered_max_speech_frame") {
                cfg.vad.firered_max_speech_frame = n as usize;
            }
            if let Some(n) = get_u64(v, "firered_min_silence_frame") {
                cfg.vad.firered_min_silence_frame = n as usize;
            }
            if let Some(n) = get_u64(v, "firered_merge_silence_frame") {
                cfg.vad.firered_merge_silence_frame = n as usize;
            }
            if let Some(n) = get_u64(v, "firered_extend_speech_frame") {
                cfg.vad.firered_extend_speech_frame = n as usize;
            }
            cfg.vad.normalize();
        }

        if let Some(ai) = p.get("ai").and_then(Value::as_object) {
            cfg.ai.enabled = get_bool(ai, "enabled").unwrap_or(false) || get_bool(ai, "add_to_anki").unwrap_or(false);
            let legacy_api_key = get_str(ai, "api_key").unwrap_or_default();
            if let Some(v) = get_bool(ai, "auto_generate_character_summary") {
                cfg.ai.auto_generate_character_summary = v;
            }
            if let Some(v) = get_str(ai, "anki_field") {
                cfg.ai.anki_field = v;
            }
            if let Some(v) = get_str(ai, "deepl_api_key") {
                cfg.ai.deepl_api_key = v;
            }
            if let Some(v) = get_str(ai, "deepl_target_lang") {
                cfg.ai.deepl_target_lang = v;
            }
            if let Some(v) = get_str(ai, "provider") {
                cfg.ai.provider = v;
            }
            if let Some(v) = get_str(ai, "gemini_model") {
                cfg.ai.gemini_model = v;
            }
            if let Some(v) = get_str(ai, "gemini_backup_model") {
                cfg.ai.gemini_backup_model = v;
            }
            if let Some(v) = get_str(ai, "groq_model") {
                cfg.ai.groq_model = v;
            }
            if let Some(v) = get_str(ai, "groq_backup_model") {
                cfg.ai.groq_backup_model = v;
            }
            if let Some(v) = get_str(ai, "gemini_api_key") {
                cfg.ai.gemini_api_key = v;
            }
            if let Some(v) = get_str(ai, "groq_api_key") {
                cfg.ai.groq_api_key = v;
            }
            if let Some(v) = get_str(ai, "zai_api_key") {
                cfg.ai.zai_api_key = v;
            }
            if let Some(v) = get_str(ai, "zai_model") {
                cfg.ai.zai_model = v;
            }
            if let Some(v) = get_str(ai, "zai_backup_model") {
                cfg.ai.zai_backup_model = v;
            }
            if let Some(v) = get_str(ai, "open_ai_url") {
                cfg.ai.open_ai_url = v;
            }
            if let Some(v) = get_str(ai, "open_ai_model") {
                cfg.ai.open_ai_model = v;
            }
            if let Some(v) = get_str(ai, "open_ai_backup_model") {
                cfg.ai.open_ai_backup_model = v;
            }
            if let Some(v) = get_str(ai, "open_ai_api_key") {
                cfg.ai.open_ai_api_key = v;
            }
            if let Some(v) = get_str(ai, "open_ai_reasoning_effort") {
                cfg.ai.open_ai_reasoning_effort = v;
            }
            if let Some(v) = get_str(ai, "ollama_url") {
                cfg.ai.ollama_url = v;
            }
            if let Some(v) = get_str(ai, "ollama_model") {
                cfg.ai.ollama_model = v;
            }
            if let Some(v) = get_str(ai, "ollama_backup_model") {
                cfg.ai.ollama_backup_model = v;
            }
            if let Some(v) = get_str(ai, "lm_studio_url") {
                cfg.ai.lm_studio_url = v;
            }
            if let Some(v) = get_str(ai, "lm_studio_model") {
                cfg.ai.lm_studio_model = v;
            }
            if let Some(v) = get_str(ai, "lm_studio_backup_model") {
                cfg.ai.lm_studio_backup_model = v;
            }
            if let Some(v) = get_str(ai, "lm_studio_api_key") {
                cfg.ai.lm_studio_api_key = v;
            }
            if let Some(v) = get_str(ai, "gsm_cloud_api_url") {
                cfg.ai.gsm_cloud_api_url = v;
            }
            if let Some(v) = get_str(ai, "gsm_cloud_access_token") {
                cfg.ai.gsm_cloud_access_token = v;
            }
            if let Some(list) = get_string_list(ai, "gsm_cloud_models") {
                cfg.ai.gsm_cloud_models = list;
            }
            if let Some(v) = get_bool(ai, "use_canned_translation_prompt") {
                cfg.ai.use_canned_translation_prompt = v;
            }
            if let Some(v) = get_bool(ai, "use_canned_context_prompt") {
                cfg.ai.use_canned_context_prompt = v;
            }
            if let Some(v) = get_str(ai, "custom_prompt") {
                cfg.ai.custom_prompt = v;
            }
            if let Some(v) = get_str(ai, "custom_texthooker_prompt") {
                cfg.ai.custom_texthooker_prompt = v;
            }
            if let Some(v) = get_str(ai, "custom_full_prompt") {
                cfg.ai.custom_full_prompt = v;
            }
            if let Some(v) = get_str(ai, "prompt_preset") {
                cfg.ai.prompt_preset = v;
            }
            if let Some(v) = get_i64(ai, "dialogue_context_length") {
                cfg.ai.dialogue_context_length = v as i32;
            }
            if let Some(v) = get_f64(ai, "temperature") {
                cfg.ai.temperature = v;
            }
            if let Some(v) = get_u64(ai, "max_output_tokens") {
                cfg.ai.max_output_tokens = v as u32;
            }
            if let Some(v) = get_f64(ai, "top_p") {
                cfg.ai.top_p = v;
            }
            cfg.ai.normalize(&legacy_api_key);
        }

        if let Some(adv) = p.get("advanced").and_then(Value::as_object) {
            if let Some(v) = get_str(adv, "multi_line_line_break") {
                cfg.advanced.multi_line_line_break = v;
            }
            if let Some(v) = get_str(adv, "localhost_bind_address") {
                if !v.trim().is_empty() {
                    cfg.advanced.localhost_bind_address = v;
                }
            }
            if let Some(v) = get_u64(adv, "direct_websocket_port").filter(|&n| n <= u16::MAX as u64)
            {
                cfg.advanced.direct_websocket_port = v as u16;
            }
            if let Some(v) = get_u64(adv, "texthooker_communication_websocket_port")
                .filter(|&n| n > 0 && n <= u16::MAX as u64)
            {
                cfg.advanced.texthooker_communication_websocket_port = v as u16;
            }
            if let Some(v) = get_i64(adv, "plaintext_websocket_port") {
                cfg.advanced.plaintext_websocket_port = if v == -1 {
                    cfg.advanced.texthooker_communication_websocket_port.saturating_add(1)
                } else if v >= 0 && v <= u16::MAX as i64 {
                    v as u16
                } else {
                    0
                };
            }
            if let Some(v) = get_u64(adv, "slowest_polling_rate") {
                cfg.advanced.slowest_polling_rate = v;
            }
            if let Some(v) = get_f64(adv, "longest_sleep_time") {
                cfg.advanced.longest_sleep_time = v;
            }
        }

        cfg
    }
}

fn parse_anki_field(
    anki: &Map<String, Value>,
    key: &str,
    legacy_key: &str,
    legacy_overwrite: Option<bool>,
    target: &mut AnkiFieldConfig,
) {
    if let Some(v) = anki.get(key) {
        match v {
            Value::Object(obj) => {
                if let Some(name) = get_str(obj, "name") {
                    target.name = name;
                }
                if let Some(enabled) = get_bool(obj, "enabled") {
                    target.enabled = enabled;
                }
                if let Some(overwrite) = get_bool(obj, "overwrite") {
                    target.overwrite = overwrite;
                }
                if let Some(append) = get_bool(obj, "append") {
                    target.append = append;
                }
            }
            Value::String(s) => {
                target.name = s.clone();
            }
            _ => {}
        }
    } else if let Some(s) = get_str(anki, legacy_key) {
        target.name = s;
        if let Some(ow) = legacy_overwrite {
            target.overwrite = ow;
        }
    }
    target.normalize();
}

fn get_str(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn get_str_or_num(map: &Map<String, Value>, key: &str) -> Option<String> {
    match map.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn get_bool(map: &Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

fn get_i64(map: &Map<String, Value>, key: &str) -> Option<i64> {
    match map.get(key)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn get_u64(map: &Map<String, Value>, key: &str) -> Option<u64> {
    get_i64(map, key).and_then(|v| u64::try_from(v).ok())
}

fn get_f64(map: &Map<String, Value>, key: &str) -> Option<f64> {
    match map.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn get_string_list(map: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    map.get(key).and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiCardField {
    pub value: String,
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiCard {
    pub note_id: u64,
    pub tags: Vec<String>,
    /// Ordered field entries preserving AnkiConnect's original field order.
    pub fields: Vec<(String, AnkiCardField)>,
    pub cards: Vec<u64>,
    pub model_name: String,
}

const WORD_ALTERNATIVES: &[&str] = &["Front", "Word", "TargetWord", "Expression"];
const SENTENCE_ALTERNATIVES: &[&str] = &["Example", "Context", "Back", "Sentence"];
const PICTURE_ALTERNATIVES: &[&str] = &[
    "Image",
    "Visual",
    "Media",
    "Picture",
    "Screenshot",
    "AnswerImage",
];
const AUDIO_ALTERNATIVES: &[&str] = &["SentenceAudio"];
const FURIGANA_ALTERNATIVES: &[&str] = &["SentenceFurigana"];

impl AnkiCard {
    pub fn has_field(&self, name: &str) -> bool {
        self.fields.iter().any(|(k, _)| k == name)
    }

    pub fn get_field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, f)| f.value.as_str())
    }

    pub fn set_field_value(&mut self, name: &str, value: String) {
        if let Some((_, f)) = self.fields.iter_mut().find(|(k, _)| k == name) {
            f.value = value;
        }
    }

    pub fn field_names(&self) -> Vec<String> {
        self.fields.iter().map(|(k, _)| k.clone()).collect()
    }

    pub fn is_overlay_mine(&self) -> bool {
        self.tags
            .iter()
            .any(|t| t.trim().eq_ignore_ascii_case("overlay"))
    }

    pub fn check_tags_for_should_update(&self, anki: &AnkiConfig) -> bool {
        if anki.tags_to_check.is_empty() {
            return true;
        }
        let wanted: HashSet<String> = anki
            .tags_to_check
            .iter()
            .map(|t| t.to_lowercase())
            .collect();
        self.tags.iter().any(|t| wanted.contains(&t.to_lowercase()))
    }

    /// Parse AnkiConnect's `notesInfo` row object.
    pub fn from_anki_connect(value: &Value) -> Result<Self, String> {
        let note_id = value
            .get("noteId")
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
            })
            .ok_or("Missing or invalid noteId")?;
        let tags = value
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let cards = value
            .get("cards")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| {
                        v.as_u64()
                            .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let model_name = value
            .get("modelName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut fields = Vec::new();
        if let Some(obj) = value.get("fields").and_then(Value::as_object) {
            for (k, v) in obj {
                let val = v
                    .get("value")
                    .and_then(Value::as_str)
                    .or_else(|| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let order = v.get("order").and_then(Value::as_i64).unwrap_or(0);
                fields.push((k.clone(), AnkiCardField { value: val, order }));
            }
        }
        Ok(Self {
            note_id,
            tags,
            fields,
            cards,
            model_name,
        })
    }

    /// Parse AnkiBeacon full-note `note_added` payload. Returns `None` if incomplete
    /// (caller should fall back to `notesInfo`).
    pub fn from_beacon_payload(payload: &Value) -> Option<Self> {
        let obj = payload.as_object()?;
        let note_id = obj
            .get("note_id")
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
            })
            .filter(|&id| id > 0)?;
        let fields_obj = obj.get("fields")?.as_object()?;
        if fields_obj.is_empty() {
            return None;
        }
        let mut fields = Vec::with_capacity(fields_obj.len());
        for (order, (name, val)) in fields_obj.iter().enumerate() {
            let text = val.as_str()?;
            fields.push((
                name.clone(),
                AnkiCardField {
                    value: text.to_string(),
                    order: order as i64,
                },
            ));
        }
        let tags_arr = obj.get("tags")?.as_array()?;
        let mut tags = Vec::with_capacity(tags_arr.len());
        for t in tags_arr {
            tags.push(t.as_str()?.to_string());
        }
        let cards_arr = obj.get("card_ids")?.as_array()?;
        let mut cards = Vec::with_capacity(cards_arr.len());
        for c in cards_arr {
            let id = c.as_u64().filter(|&n| n > 0)?;
            cards.push(id);
        }
        let model_name = obj.get("note_type_name")?.as_str()?.to_string();
        Some(Self {
            note_id,
            tags,
            fields,
            cards,
            model_name,
        })
    }

    /// Repair configured field names via case-insensitive match or known alternatives.
    /// Returns a map of `config_attr -> new_field_name` for any repaired fields.
    pub fn repair_config_fields(&self, anki: &mut AnkiConfig) -> HashMap<&'static str, String> {
        let mut repairs = HashMap::new();
        let checks: [(&'static str, &[&str], bool); 5] = [
            ("word", WORD_ALTERNATIVES, true),
            ("sentence", SENTENCE_ALTERNATIVES, true),
            ("picture", PICTURE_ALTERNATIVES, true),
            ("sentence_audio", AUDIO_ALTERNATIVES, true),
            ("sentence_furigana", FURIGANA_ALTERNATIVES, false),
        ];
        for (key, alts, check_if_empty) in checks {
            let current = anki
                .field_config(key)
                .map(|f| f.name.clone())
                .unwrap_or_default();
            if !check_if_empty && current.is_empty() {
                continue;
            }
            if self.has_field(&current) {
                continue;
            }
            if let Some(found) = self.find_alternative_field(&current, alts) {
                if let Some(fc) = anki.field_config_mut(key) {
                    fc.name = found.clone();
                    fc.normalize();
                }
                repairs.insert(key, found);
            }
        }
        repairs
    }

    fn find_alternative_field(&self, configured: &str, alternatives: &[&str]) -> Option<String> {
        for (k, _) in &self.fields {
            if k.eq_ignore_ascii_case(configured) {
                return Some(k.clone());
            }
        }
        for alt in alternatives {
            for (k, _) in &self.fields {
                if k.eq_ignore_ascii_case(alt) {
                    return Some(k.clone());
                }
            }
        }
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnkiFieldMismatch {
    pub profile_name: String,
    pub anki_url: String,
    pub configured_note_type: String,
    pub model_name: String,
    pub available_fields: Vec<String>,
    pub mappings: Vec<(String, String)>,
}

impl AnkiFieldMismatch {
    pub fn missing_fields(&self) -> Vec<(String, String)> {
        self.mappings
            .iter()
            .filter(|(_, name)| !self.available_fields.iter().any(|f| f == name))
            .cloned()
            .collect()
    }

    pub fn blocks_mining(&self) -> bool {
        self.missing_fields()
            .iter()
            .any(|(label, _)| label == "Word" || label == "Sentence")
    }
}

pub fn find_anki_field_mismatch(
    config: &ProfileConfig,
    model_name: &str,
    fields: &[String],
) -> Option<AnkiFieldMismatch> {
    let mut mappings = vec![
        ("Word".to_string(), config.anki.word.name.clone()),
        ("Sentence".to_string(), config.anki.sentence.name.clone()),
    ];
    if !config.anki.sentence_audio.name.is_empty() && config.audio.enabled {
        mappings.push((
            "Sentence audio".to_string(),
            config.anki.sentence_audio.name.clone(),
        ));
    }
    if !config.anki.picture.name.is_empty() && config.screenshot.enabled {
        mappings.push(("Picture".to_string(), config.anki.picture.name.clone()));
    }
    let mut available_fields = fields.to_vec();
    available_fields.sort();
    let issue = AnkiFieldMismatch {
        profile_name: config.name.clone(),
        anki_url: config.anki.url.trim().to_string(),
        configured_note_type: config.anki.note_type.clone(),
        model_name: model_name.to_string(),
        available_fields,
        mappings,
    };
    if issue.missing_fields().is_empty() {
        None
    } else {
        Some(issue)
    }
}

/// Apply repaired Anki field names back into `config.json` atomically.
pub fn persist_anki_field_repairs(
    config_path: &Path,
    profile_name: &str,
    repairs: &HashMap<&'static str, String>,
) -> Result<(), String> {
    if repairs.is_empty() || !config_path.is_file() {
        return Ok(());
    }
    gsm_settings::mining_scopes::update(config_path, |root| {
        let Some(anki) = root
            .get_mut("configs")
            .and_then(Value::as_object_mut)
            .and_then(|c| c.get_mut(profile_name))
            .and_then(Value::as_object_mut)
            .and_then(|p| p.get_mut("anki"))
            .and_then(Value::as_object_mut)
        else {
            return Ok(());
        };
        for (key, new_name) in repairs {
            match anki.get_mut(*key) {
                Some(Value::Object(obj)) => {
                    obj.insert("name".into(), Value::String(new_name.clone()));
                }
                _ => {
                    anki.insert((*key).to_string(), serde_json::json!({ "name": new_name }));
                }
            }
        }
        Ok(())
    })
}

/// Resolve `ffmpeg` / `ffprobe` executable paths matching GSM's Windows bundled layout + PATH.
pub fn resolve_media_tool(tool: &str, app_dir: Option<&Path>) -> PathBuf {
    let exe_name = if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    };
    if let Some(dir) = app_dir {
        for rel in [
            PathBuf::from("ffmpeg").join(&exe_name),
            PathBuf::from("ffmpeg").join("bin").join(&exe_name),
            PathBuf::from(&exe_name),
        ] {
            let candidate = dir.join(rel);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for entry in std::env::split_paths(&path_var) {
            let candidate = entry.join(&exe_name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from(exe_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn live_review_defaults_on_and_can_be_disabled_per_profile() {
        for (review, expected) in [
            (json!({"enabled": true}), true),
            (json!({"enabled": true, "open_on_card_queued": false}), false),
        ] {
            let profile = json!({"features": {"review_after_session": review}});
            let parsed = ProfileConfig::from_profile_object("Game", profile.as_object().unwrap());
            assert_eq!(parsed.features.review_after_session.open_on_card_queued, expected);
        }
    }

    #[test]
    fn parses_profile_defaults_and_normalizes_fields() {
        let doc = json!({
            "current_profile": "VN",
            "configs": {
                "VN": {
                    "anki": {
                        "sentence": {"name": "Sentence", "enabled": false, "overwrite": true, "append": true},
                        "field_grouping_additional_fields": "MiscInfo, Tag, miscinfo"
                    },
                    "screenshot": {
                        "width": 1280,
                        "height": 0,
                        "animated_settings": {"quality": 8, "codec": "libsvtav1"}
                    },
                    "ai": {
                        "provider": "gemini",
                        "api_key": "legacy-key",
                        "gemini_model": "gemini-2.5-flash",
                        "gemini_backup_model": "gemini-2.5-pro"
                    }
                }
            }
        });
        let cfg = ProfileConfig::from_config_json(&doc).unwrap();
        assert_eq!(cfg.name, "VN");
        assert!(cfg.anki.sentence.enabled); // core fields forced enabled
        assert!(cfg.anki.sentence.overwrite);
        assert!(!cfg.anki.sentence.append); // overwrite + append clears append
        assert_eq!(
            cfg.anki.field_grouping_additional_fields,
            vec!["MiscInfo", "Tag"]
        );
        assert_eq!(cfg.screenshot.animated_settings.scaled_quality, 28);
        assert_eq!(cfg.ai.provider, AI_GEMINI);
        assert_eq!(cfg.ai.gemini_api_key, "legacy-key");
        assert_eq!(cfg.ai.gemini_model, DEFAULT_GEMINI_MODEL);
        assert_eq!(cfg.ai.gemini_backup_model, DEFAULT_GEMINI_BACKUP_MODEL);
    }

    #[test]
    fn card_field_repair_and_mismatch() {
        let card = AnkiCard::from_anki_connect(&json!({
            "noteId": 123,
            "modelName": "Lapis",
            "tags": ["Mining"],
            "cards": [456],
            "fields": {
                "Front": {"value": "猫", "order": 0},
                "sentence": {"value": "猫がいる", "order": 1},
                "Image": {"value": "", "order": 2}
            }
        }))
        .unwrap();
        let mut cfg = ProfileConfig::default();
        let repairs = card.repair_config_fields(&mut cfg.anki);
        assert_eq!(repairs.get("word").map(String::as_str), Some("Front"));
        assert_eq!(repairs.get("sentence").map(String::as_str), Some("sentence"));
        assert_eq!(repairs.get("picture").map(String::as_str), Some("Image"));
        let mismatch = find_anki_field_mismatch(&cfg, "Lapis", &card.field_names()).unwrap();
        assert!(!mismatch.blocks_mining()); // Word & Sentence matched; only SentenceAudio missing
        assert_eq!(
            mismatch.missing_fields(),
            vec![("Sentence audio".into(), "SentenceAudio".into())]
        );
    }

    #[test]
    fn beacon_payload_validation_rejects_incomplete() {
        assert!(AnkiCard::from_beacon_payload(&json!({
            "note_id": 10,
            "fields": {},
            "tags": [],
            "card_ids": [1],
            "note_type_name": "Lapis"
        }))
        .is_none());
        let card = AnkiCard::from_beacon_payload(&json!({
            "note_id": 10,
            "fields": {"Expression": "本", "Sentence": "本を読む"},
            "tags": ["overlay"],
            "card_ids": [11],
            "note_type_name": "Lapis"
        }))
        .unwrap();
        assert_eq!(card.note_id, 10);
        assert!(card.is_overlay_mine());
        assert_eq!(card.get_field("Expression"), Some("本"));
    }
}
