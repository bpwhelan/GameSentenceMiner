//! FFmpeg / FFprobe media extraction, trimming, screenshots, and animated WebP/AVIF encoding.
use crate::avif_sizing::{choose_size_parameters, sample_ranges, size_candidates, AvifParameters};
use crate::config::{
    audio_format_spec, resolve_media_tool, ProfileConfig, ANIMATED_SCREENSHOT_CODECS,
    ANIMATED_SCREENSHOT_CODEC_DEFAULT,
};
use crate::pause_gaps::{expected_gaps, remove_pause_gaps, AudioTimeline, PauseHistory};
use crate::text::{make_unique_file_name, sanitize_filename, GameLine};
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

const MAX_REPLAY_SECONDS: f64 = 3.0 * 60.0 * 60.0;
const REPLAY_INFO: &str = "format=start_time,duration:stream=codec_type,codec_name,sample_rate,channels,width,height,avg_frame_rate";
const RATIO_TOLERANCE: f64 = 0.05;
const ADAPTIVE_AVIF_BASE_CRF: i32 = 40;
const STATIC_AVIF_SVT_PRESET: u32 = 9;
const STATIC_AVIF_DEFAULT_QUALITY: i32 = 85;
const STATIC_AVIF_DEFAULT_CRF: i32 = 26;
const STATIC_AVIF_MAX_CRF: i32 = 63;
const STATIC_AVIF_AOM_CRF_SCALE: f64 = 2.0 / 3.0;

const KNOWN_ASPECT_RATIOS: &[f64] = &[
    16.0 / 9.0,
    16.0 / 10.0,
    4.0 / 3.0,
    21.0 / 9.0,
    3.0 / 2.0,
    5.0 / 4.0,
    1.0,
];

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct ProbeCacheKey {
    path: String,
    entries: String,
    stream_select: String,
    executable: String,
    size: u64,
    mtime_ns: u128,
}

type ProbeCache = HashMap<ProbeCacheKey, Arc<Mutex<Option<Value>>>>;

fn probe_cache() -> &'static Mutex<ProbeCache> {
    static CACHE: OnceLock<Mutex<ProbeCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone)]
pub struct MediaTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub temp_dir: PathBuf,
}

impl MediaTools {
    pub fn discover(app_dir: Option<&Path>, temp_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&temp_dir);
        Self {
            ffmpeg: resolve_media_tool("ffmpeg", app_dir),
            ffprobe: resolve_media_tool("ffprobe", app_dir),
            temp_dir,
        }
    }

    fn base_ffmpeg_args(&self, loglevel: &str) -> Vec<String> {
        vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            loglevel.into(),
            "-nostdin".into(),
        ]
    }

    fn run_ffmpeg(
        &self,
        args: &[String],
        retries: usize,
        capture_stdout: bool,
    ) -> Result<Output, String> {
        let mut last_err = String::new();
        for attempt in 0..=retries {
            let mut cmd = Command::new(&self.ffmpeg);
            cmd.args(args)
                .stdin(Stdio::null())
                .stdout(if capture_stdout {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stderr(Stdio::piped());
            hide_window(&mut cmd);
            match cmd.output() {
                Ok(out) if out.status.success() => return Ok(out),
                Ok(out) => {
                    last_err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    if attempt == retries {
                        return Ok(out);
                    }
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt == retries {
                        return Err(format!("Failed to spawn ffmpeg: {last_err}"));
                    }
                }
            }
        }
        Err(last_err)
    }

    pub fn run_ffmpeg_checked(&self, args: &[String], retries: usize) -> Result<Output, String> {
        let out = self.run_ffmpeg(args, retries, false)?;
        if out.status.success() {
            Ok(out)
        } else {
            Err(format!(
                "FFmpeg exited with {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    pub fn probe_json(
        &self,
        file_path: &Path,
        entries: &str,
        stream_select: &str,
    ) -> Option<Value> {
        let abs = std::fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
        let cache_key = std::fs::metadata(&abs).ok().map(|meta| {
            let mtime_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            ProbeCacheKey {
                path: abs.to_string_lossy().into_owned(),
                entries: entries.to_string(),
                stream_select: stream_select.to_string(),
                executable: self.ffprobe.to_string_lossy().into_owned(),
                size: meta.len(),
                mtime_ns,
            }
        });

        let entry = cache_key.and_then(|key| {
            let mut cache = probe_cache().lock().ok()?;
            if cache.len() >= 256 && !cache.contains_key(&key) {
                cache.clear();
            }
            Some(Arc::clone(cache.entry(key).or_default()))
        });
        if let Some(entry) = entry {
            // Mining audio and screenshots can probe the same replay at the same time.
            // Serialize only matching probes and leave failed probes eligible for retry.
            if let Ok(mut cached) = entry.lock() {
                if cached.is_none() {
                    *cached = self.run_probe_json(file_path, entries, stream_select);
                }
                return cached.clone();
            }
        }
        self.run_probe_json(file_path, entries, stream_select)
    }

    fn run_probe_json(&self, file_path: &Path, entries: &str, stream_select: &str) -> Option<Value> {
        let mut cmd = Command::new(&self.ffprobe);
        cmd.args(["-v", "error"]);
        if !stream_select.is_empty() {
            cmd.args(["-select_streams", stream_select]);
        }
        cmd.args(["-show_entries", entries, "-of", "json"])
            .arg(file_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_window(&mut cmd);
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        serde_json::from_slice(&out.stdout).ok()
    }

    pub(crate) fn probe_replay(&self, file_path: &Path) -> Option<Value> {
        self.probe_json(file_path, REPLAY_INFO, "")
    }

    pub fn get_video_duration(&self, file_path: &Path) -> f64 {
        if let Some(info) = self.probe_replay(file_path) {
            return info
                .get("format")
                .and_then(|f| f.get("duration"))
                .and_then(value_as_f64)
                .filter(|d| d.is_finite() && *d >= 0.0)
                .unwrap_or(0.0);
        }
        // A successful probe already asked for duration. Try the text writer only
        // when the JSON probe itself failed.
        let mut cmd = Command::new(&self.ffprobe);
        cmd.args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(file_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        hide_window(&mut cmd);
        cmd.output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok())
            .filter(|d| d.is_finite() && *d >= 0.0)
            .unwrap_or(0.0)
    }

    pub fn get_audio_length(&self, file_path: &Path) -> f64 {
        if let Some(wav_dur) = fast_wav_duration(file_path) {
            return wav_dur;
        }
        self.get_video_duration(file_path)
    }

    pub fn get_audio_codec(&self, video_path: &Path) -> Option<String> {
        let info = self.probe_replay(video_path)?;
        info.get("streams")?
            .as_array()?
            .iter().find(|s| s["codec_type"] == "audio")?
            .get("codec_name")?
            .as_str()
            .map(str::to_owned)
    }

    pub fn get_video_dimensions(&self, video_path: &Path) -> Option<(u32, u32)> {
        let info = self.probe_replay(video_path)?;
        let s = first_video_stream(&info)?;
        let w = s.get("width")?.as_u64()? as u32;
        let h = s.get("height")?.as_u64()? as u32;
        if w > 0 && h > 0 {
            Some((w, h))
        } else {
            None
        }
    }

    pub fn get_format_start_time(&self, file_path: &Path) -> Option<f64> {
        let info = self.probe_replay(file_path)?;
        info.get("format")?
            .get("start_time")
            .and_then(value_as_f64)
    }

    pub fn get_video_timings(
        &self,
        video_path: &Path,
        game_line: &GameLine,
        anki_card_creation_epoch: Option<f64>,
        config: &ProfileConfig,
    ) -> (f64, f64, f64, f64) {
        let file_mod_time = anki_card_creation_epoch
            .unwrap_or_else(|| file_mtime_epoch(video_path).unwrap_or_else(crate::text::now_epoch));
        let file_length = self.get_video_duration(video_path);
        let time_delta = file_mod_time - game_line.time_epoch;
        let total_seconds = file_length - time_delta;
        let total_seconds_after_offset = total_seconds + config.audio.beginning_offset;

        if total_seconds < 0.0 || total_seconds >= file_length {
            let fallback = (file_length - 30.0).max(0.0);
            return (fallback, 0.0, fallback, file_length);
        }
        (
            total_seconds_after_offset,
            total_seconds,
            total_seconds_after_offset,
            file_length,
        )
    }

    pub fn get_screenshot_time(
        &self,
        video_path: &Path,
        game_line: Option<&GameLine>,
        next_line_epoch: Option<f64>,
        default_beginning: bool,
        anki_card_creation_epoch: Option<f64>,
        config: &ProfileConfig,
    ) -> f64 {
        let file_length = self.get_video_duration(video_path);
        let file_mod_time = anki_card_creation_epoch
            .unwrap_or_else(|| file_mtime_epoch(video_path).unwrap_or_else(crate::text::now_epoch));
        let line_time = game_line
            .map(|l| l.time_epoch)
            .unwrap_or(file_mod_time);
        let line_timestamp = file_length - (file_mod_time - line_time);
        let offset = config.screenshot.seconds_after_line;

        let t = match config.screenshot.screenshot_timing_setting.as_str() {
            "beginning" => line_timestamp + offset,
            "middle" => {
                if let Some(next_t) = next_line_epoch {
                    line_timestamp + ((next_t - line_time) / 2.0) + offset
                } else {
                    (file_length - ((file_length - line_timestamp) / 2.0)) + offset
                }
            }
            "end" => {
                if let Some(next_t) = next_line_epoch {
                    line_timestamp + (next_t - line_time) - offset
                } else {
                    file_length - offset
                }
            }
            _ => line_timestamp + offset,
        };

        if t < 0.0 || t > file_length {
            if default_beginning {
                1.0
            } else {
                (file_length - offset).max(0.0)
            }
        } else {
            t
        }
    }

    pub fn extract_audio_without_pauses(
        &self,
        video_path: &Path,
        output_audio: &Path,
        recording_end_epoch: Option<f64>,
        pause_history: &PauseHistory,
        config: &ProfileConfig,
    ) -> Option<AudioTimeline> {
        let recording_end = recording_end_epoch
            .or_else(|| file_mtime_epoch(video_path))
            .unwrap_or_else(crate::text::now_epoch);
        let pauses = pause_history.get_pauses_between(recording_end - MAX_REPLAY_SECONDS, recording_end);
        if pauses.is_empty() {
            return None;
        }
        let probe = self.probe_replay(video_path)?;
        let mut audio = probe.get("streams")?.as_array()?.iter().filter(|s| s["codec_type"] == "audio");
        let stream = audio.next()?;
        if audio.next().is_some() {
            return None;
        }
        let duration = probe
            .get("format")
            .and_then(|f| f.get("duration"))
            .and_then(value_as_f64)?;
        let gaps = expected_gaps(&pauses, recording_end, duration);
        if gaps.is_empty() {
            return None;
        }
        let sample_rate = stream.get("sample_rate").and_then(value_as_u64)? as usize;
        let channels = stream.get("channels").and_then(value_as_u64)? as usize;
        if sample_rate == 0 || channels == 0 {
            return None;
        }

        let mut decode_args = self.base_ffmpeg_args("error");
        decode_args.extend([
            "-i".into(),
            video_path.to_string_lossy().into_owned(),
            "-map".into(),
            "0:a:0".into(),
            "-f".into(),
            "f32le".into(),
            "-".into(),
        ]);
        let decoded = self.run_ffmpeg(&decode_args, 0, true).ok()?;
        if !decoded.status.success() {
            return None;
        }
        let sample_count = decoded.stdout.len() / 4;
        let mut samples = Vec::with_capacity(sample_count);
        for chunk in decoded.stdout.chunks_exact(4) {
            samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        drop(decoded);
        let (cleaned, timeline) = remove_pause_gaps(&samples, channels, sample_rate, &gaps);
        drop(samples);
        if timeline.is_empty() {
            return None;
        }

        let spec = audio_format_spec(&config.audio.extension)?;
        let mut encode_args = self.base_ffmpeg_args("error");
        encode_args.extend([
            "-f".into(),
            "f32le".into(),
            "-ar".into(),
            sample_rate.to_string(),
            "-ac".into(),
            channels.to_string(),
            "-i".into(),
            "-".into(),
            "-c:a".into(),
            spec.codec.into(),
            "-f".into(),
            spec.format.into(),
            output_audio.to_string_lossy().into_owned(),
        ]);
        let mut cmd = Command::new(&self.ffmpeg);
        cmd.args(&encode_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_window(&mut cmd);
        let mut child = cmd.spawn().ok()?;
        if let Some(mut stdin) = child.stdin.take() {
            // Stream in fixed 64 KiB chunks instead of allocating a second multi-MB byte buffer.
            let mut chunk_buf = [0u8; 65536];
            for samples_chunk in cleaned.chunks(16384) {
                let byte_len = samples_chunk.len() * 4;
                for (i, &s) in samples_chunk.iter().enumerate() {
                    chunk_buf[i * 4..(i + 1) * 4].copy_from_slice(&s.to_le_bytes());
                }
                if stdin.write_all(&chunk_buf[..byte_len]).is_err() {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(output_audio);
                    return None;
                }
            }
        }
        drop(cleaned);
        let status = child.wait().ok()?;
        if status.success() {
            Some(timeline)
        } else {
            let _ = std::fs::remove_file(output_audio);
            None
        }
    }

    pub fn get_audio_and_trim(
        &self,
        video_path: &Path,
        game_line: &GameLine,
        next_line_epoch: Option<f64>,
        anki_card_creation_epoch: Option<f64>,
        pause_history: &PauseHistory,
        config: &ProfileConfig,
    ) -> Result<(PathBuf, PathBuf, f64, f64, AudioTimeline), String> {
        let target_ext = &config.audio.extension;
        let mut untrimmed = self.unique_temp_path(&format!("_untrimmed.{target_ext}"));
        let timeline = match self.extract_audio_without_pauses(
            video_path,
            &untrimmed,
            anki_card_creation_epoch,
            pause_history,
            config,
        ) {
            Some(t) => t,
            None => {
                let codec = self.get_audio_codec(video_path);
                if codec.as_deref() != Some(target_ext.as_str()) {
                    untrimmed = self.unique_temp_path("_untrimmed.mka");
                }
                let mut args = self.base_ffmpeg_args("error");
                args.extend([
                    "-i".into(),
                    video_path.to_string_lossy().into_owned(),
                    "-map".into(),
                    if untrimmed.extension().is_some_and(|e| e == "mp3" || e == "aac") {
                        "0:a:0".into()
                    } else {
                        "0:a".into()
                    },
                    "-c:a".into(),
                    "copy".into(),
                    untrimmed.to_string_lossy().into_owned(),
                ]);
                self.run_ffmpeg_checked(&args, 0)?;
                AudioTimeline::default()
            }
        };

        let (trimmed, start_time, end_time) = self.trim_audio_based_on_last_line(
            &untrimmed,
            video_path,
            game_line,
            next_line_epoch,
            anki_card_creation_epoch,
            &timeline,
            config,
        )?;
        Ok((untrimmed, trimmed, start_time, end_time, timeline))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn trim_audio_based_on_last_line(
        &self,
        untrimmed_audio: &Path,
        video_path: &Path,
        game_line: &GameLine,
        next_line_epoch: Option<f64>,
        anki_card_creation_epoch: Option<f64>,
        timeline: &AudioTimeline,
        config: &ProfileConfig,
    ) -> Result<(PathBuf, f64, f64), String> {
        let ext = &config.audio.extension;
        let trimmed = self.unique_temp_path(&format!(".{ext}"));
        let (mut start_trim_time, total_seconds, _after_offset, file_length) =
            self.get_video_timings(video_path, game_line, anki_card_creation_epoch, config);
        let source_padding = game_line.effective_padding();
        start_trim_time = (start_trim_time - source_padding).max(0.0);
        let audio_start = timeline.to_audio(start_trim_time);

        let mut end_trim_seconds = 0.0;
        let mut audio_end = 0.0;
        if let Some(next_t) = next_line_epoch {
            if next_t > game_line.time_epoch && total_seconds != 0.0 {
                end_trim_seconds = total_seconds
                    + (next_t - game_line.time_epoch)
                    + config.audio.pre_vad_end_offset;
                audio_end = timeline.to_audio(end_trim_seconds);
            }
        } else if config.audio.pre_vad_end_offset < 0.0 {
            end_trim_seconds = file_length + config.audio.pre_vad_end_offset;
            audio_end = timeline.to_audio(end_trim_seconds);
        }

        let mut args = self.base_ffmpeg_args("error");
        let is_mka = untrimmed_audio
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("mka"));
        if is_mka {
            args.extend([
                "-ss".into(),
                format!("{audio_start}"),
                "-i".into(),
                untrimmed_audio.to_string_lossy().into_owned(),
            ]);
            if audio_end > 0.0 {
                args.extend(["-t".into(), format!("{:.3}", (audio_end - audio_start).max(0.0))]);
            }
            let codec = audio_format_spec(ext).map(|s| s.codec).unwrap_or("libmp3lame");
            // MP3 and ADTS can carry only one soundtrack. A multi-track OBS replay
            // still retains all tracks in the intermediate Matroska recording.
            let streams = if matches!(ext.as_str(), "mp3" | "aac") { "0:a:0" } else { "0:a" };
            args.extend(["-map".into(), streams.into(), "-c:a".into(), codec.into()]);
        } else {
            args.extend([
                "-i".into(),
                untrimmed_audio.to_string_lossy().into_owned(),
                "-ss".into(),
                format!("{audio_start}"),
            ]);
            if audio_end > 0.0 {
                args.extend(["-to".into(), format!("{audio_end:.3}")]);
            }
            args.extend(["-c".into(), "copy".into()]);
        }
        args.push(trimmed.to_string_lossy().into_owned());
        let _ = self.run_ffmpeg(&args, 0, false);
        Ok((trimmed, start_trim_time, end_trim_seconds))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn trim_audio(
        &self,
        input_audio: &Path,
        start_time: f64,
        end_time: f64,
        output_audio: &Path,
        trim_beginning: bool,
        fade_in_duration: f64,
        fade_out_duration: f64,
        config: &ProfileConfig,
    ) -> Result<(), String> {
        let mut args = self.base_ffmpeg_args("error");
        args.extend([
            "-i".into(),
            input_audio.to_string_lossy().into_owned(),
            "-vn".into(),
        ]);
        let mut fade_in_start = 0.0;
        if trim_beginning && start_time > 0.0 {
            args.extend(["-ss".into(), format!("{start_time:.2}")]);
            fade_in_start = start_time;
        }
        let mut fade_filters = Vec::new();
        if fade_in_duration > 0.0 {
            fade_filters.push(format!(
                "afade=t=in:st={fade_in_start:.2}:d={fade_in_duration}"
            ));
        }
        if fade_out_duration > 0.0 && end_time > fade_out_duration {
            fade_filters.push(format!(
                "afade=t=out:st={:.2}:d={fade_out_duration}",
                end_time - fade_out_duration
            ));
        }
        if end_time > 0.0 {
            args.extend(["-to".into(), format!("{end_time:.2}")]);
        }
        if !fade_filters.is_empty() {
            args.extend(["-af".into(), fade_filters.join(",")]);
        }
        let out_ext = output_audio
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let in_ext = input_audio
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let convert_format = audio_format_spec(&out_ext).is_some() && in_ext != out_ext;
        if !fade_filters.is_empty() || convert_format {
            let codec = audio_format_spec(&out_ext)
                .or_else(|| audio_format_spec(&config.audio.extension))
                .map(|s| s.codec)
                .unwrap_or("libmp3lame");
            args.extend(["-c:a".into(), codec.into()]);
        } else {
            args.extend(["-c".into(), "copy".into()]);
        }
        args.push(output_audio.to_string_lossy().into_owned());
        self.run_ffmpeg_checked(&args, 0)?;
        Ok(())
    }

    /// Preserve the soundtrack's channel count and sample rate for Text Feed playback.
    pub fn playback_wav(&self, input: &Path, output: &Path) -> Result<(), String> {
        let mut args = self.base_ffmpeg_args("error");
        args.extend(["-y".into(), "-i".into(), input.to_string_lossy().into_owned(), "-vn".into(), output.to_string_lossy().into_owned()]);
        self.run_ffmpeg_checked(&args, 0).map(|_| ())
    }

    /// Feed VAD the same PCM samples as a 16 kHz mono WAV, directly from stdout.
    pub(crate) fn decode_vad_audio(
        &self,
        input_audio: &Path,
        use_filters: bool,
    ) -> Result<Vec<i16>, String> {
        let run = |filter: Option<&str>| -> Result<Output, String> {
            let mut args = self.base_ffmpeg_args("error");
            args.extend([
                "-i".into(),
                input_audio.to_string_lossy().into_owned(),
                "-vn".into(),
                "-ar".into(),
                "16000".into(),
                "-ac".into(),
                "1".into(),
            ]);
            if let Some(f) = filter {
                args.extend(["-af".into(), f.into()]);
            }
            args.extend([
                "-c:a".into(),
                "pcm_s16le".into(),
                "-f".into(),
                "s16le".into(),
                "pipe:1".into(),
            ]);
            self.run_ffmpeg(&args, 0, true)
        };
        let primary = if cfg!(target_os = "linux") {
            "afftdn"
        } else {
            "afftdn,dialoguenhance"
        };
        let mut out = run(use_filters.then_some(primary))?;
        if use_filters && !out.status.success() && primary != "afftdn" {
            out = run(Some("afftdn"))?;
        }
        if use_filters && out.status.success() && out.stdout.is_empty() {
            out = run(None)?;
        }
        if !out.status.success() {
            return Err(format!(
                "FFmpeg failed to decode audio for VAD: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        if out.stdout.is_empty() || out.stdout.len() % 2 != 0 {
            return Err(format!(
                "FFmpeg produced invalid PCM audio from '{}'",
                input_audio.display()
            ));
        }
        Ok(out
            .stdout
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
            .collect())
    }

    pub fn combine_audio_files(
        &self,
        audio_files: &[PathBuf],
        output_file: &Path,
        config: &ProfileConfig,
    ) -> Result<(), String> {
        if audio_files.is_empty() {
            return Err("No audio files provided for combination".into());
        }
        let list_path = self.unique_temp_path("_concat.txt");
        {
            let mut f = std::fs::File::create(&list_path).map_err(|e| e.to_string())?;
            for p in audio_files {
                let escaped = p.to_string_lossy().replace('\'', "'\\''");
                writeln!(f, "file '{escaped}'").map_err(|e| e.to_string())?;
            }
        }
        let spec = audio_format_spec(&config.audio.extension);
        let codec = spec.map(|s| s.codec).unwrap_or("libopus");
        let mut args = self.base_ffmpeg_args("error");
        args.extend([
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            list_path.to_string_lossy().into_owned(),
            "-vn".into(),
            "-c:a".into(),
            codec.into(),
        ]);
        if let Some(s) = spec {
            args.extend(["-f".into(), s.format.into()]);
        }
        args.push(output_file.to_string_lossy().into_owned());
        let res = self.run_ffmpeg(&args, 0, false);
        let _ = std::fs::remove_file(&list_path);
        let out = res?;
        if !out.status.success()
            || !output_file.is_file()
            || std::fs::metadata(output_file).map(|m| m.len()).unwrap_or(0) == 0
            || self.get_audio_length(output_file) <= 0.0
        {
            return Err(format!(
                "Failed to combine audio segments into {}",
                output_file.display()
            ));
        }
        Ok(())
    }

    pub fn reencode_file_with_user_config(
        &self,
        input_file: &Path,
        final_output: Option<&Path>,
        user_options: &str,
        game_name: &str,
        config: &ProfileConfig,
    ) -> Result<PathBuf, String> {
        let dest = match final_output {
            Some(p) => p.to_path_buf(),
            None => make_unique_file_name(
                &self
                    .temp_dir
                    .join(format!("{}.{}", sanitize_filename(game_name), config.audio.extension)),
            ),
        };
        let stem = input_file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let ext = input_file
            .extension()
            .and_then(|s| s.to_str())
            .map(|e| format!(".{e}"))
            .unwrap_or_default();
        let temp_file = input_file
            .parent()
            .unwrap_or(&self.temp_dir)
            .join(format!("{stem}_temp{ext}"));

        let extra = shell_words::split(user_options).unwrap_or_default();
        let mut args = self.base_ffmpeg_args("error");
        args.extend([
            "-i".into(),
            input_file.to_string_lossy().into_owned(),
            "-map".into(),
            "0:a".into(),
        ]);
        args.extend(extra);
        if let Some(spec) = audio_format_spec(&config.audio.extension) {
            args.extend(["-f".into(), spec.format.into()]);
        }
        args.push(temp_file.to_string_lossy().into_owned());
        let out = self.run_ffmpeg(&args, 0, false)?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&temp_file);
            return Ok(input_file.to_path_buf());
        }
        replace_file_with_retry(&temp_file, &dest, 5)?;
        Ok(dest)
    }

    pub fn get_raw_screenshot(
        &self,
        video_file: &Path,
        screenshot_timing: f64,
        game_name: &str,
    ) -> Result<PathBuf, String> {
        let t = if screenshot_timing == 0.0 {
            1.0
        } else {
            screenshot_timing
        };
        let output_image = make_unique_file_name(
            &self
                .temp_dir
                .join(format!("{}_raw.png", sanitize_filename(game_name))),
        );
        let mut args = self.base_ffmpeg_args("error");
        args.extend([
            "-abort_on".into(),
            "empty_output".into(),
            "-ss".into(),
            format!("{t}"),
            "-i".into(),
            video_file.to_string_lossy().into_owned(),
            "-vframes".into(),
            "1".into(),
            "-compression_level".into(),
            "1".into(),
            output_image.to_string_lossy().into_owned(),
        ]);
        self.run_ffmpeg_checked(&args, 0)?;
        Ok(output_image)
    }

    pub fn find_black_bars(&self, video_file: &Path, screenshot_timing: f64) -> Option<String> {
        let (orig_w, orig_h) = self.get_video_dimensions(video_file)?;
        let ss_seek = (screenshot_timing - 0.5).max(0.0);
        let mut args = self.base_ffmpeg_args("info");
        args.extend([
            "-nostats".into(),
            "-ss".into(),
            format!("{ss_seek}"),
            "-i".into(),
            video_file.to_string_lossy().into_owned(),
            "-t".into(),
            "1".into(),
            "-an".into(),
            "-vf".into(),
            "cropdetect=limit=16:round=2".into(),
            "-frames:v".into(),
            "8".into(),
            "-f".into(),
            "null".into(),
            "-".into(),
        ]);
        let out = self.run_ffmpeg(&args, 0, false).ok()?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        static RE_CROP: OnceLock<Regex> = OnceLock::new();
        let re = RE_CROP.get_or_init(|| Regex::new(r"crop=(\d+):(\d+):(\d+):(\d+)").unwrap());
        let last = re.captures_iter(&stderr).last()?;
        let cw: u32 = last[1].parse().ok()?;
        let ch: u32 = last[2].parse().ok()?;
        if cw == orig_w && ch == orig_h {
            return None;
        }
        let area_ratio = (cw as f64 * ch as f64) / (orig_w as f64 * orig_h as f64);
        let is_pillarbox_only = ch + 2 >= orig_h;
        if area_ratio < 0.25 && !is_pillarbox_only {
            return None;
        }
        let orig_aspect = orig_w as f64 / orig_h as f64;
        let crop_aspect = cw as f64 / ch as f64;
        let aspect_diff = (orig_aspect - crop_aspect).abs() / orig_aspect;
        if aspect_diff > 0.30 && !is_pillarbox_only {
            let matches_known = KNOWN_ASPECT_RATIOS
                .iter()
                .any(|&r| (crop_aspect - r).abs() / r < RATIO_TOLERANCE);
            if !matches_known {
                return None;
            }
        }
        Some(last[0].to_string())
    }

    pub fn encode_screenshot(
        &self,
        input_image: &Path,
        source_video_path: Option<&Path>,
        screenshot_timing: Option<f64>,
        output_path: Option<&Path>,
        already_processed: bool,
        game_name: &str,
        config: &ProfileConfig,
    ) -> Result<PathBuf, String> {
        let output_image = match output_path {
            Some(p) => p.to_path_buf(),
            None => make_unique_file_name(&self.temp_dir.join(format!(
                "{}.{}",
                sanitize_filename(game_name),
                config.screenshot.extension
            ))),
        };
        let (pre_args, post_args) =
            parse_custom_ffmpeg_settings(&config.screenshot.custom_ffmpeg_settings);
        let mut base = self.base_ffmpeg_args("error");
        base.extend(pre_args);
        base.extend(["-i".into(), input_image.to_string_lossy().into_owned()]);

        if !already_processed {
            let filters = self.build_screenshot_filters(
                source_video_path,
                screenshot_timing,
                true,
                config,
            );
            if !filters.is_empty() {
                base.extend(["-vf".into(), filters.join(",")]);
            }
        }

        let has_custom = !config.screenshot.custom_ffmpeg_settings.trim().is_empty();
        let output_args = if has_custom {
            post_args
        } else {
            vec![
                "-q:v".into(),
                config.screenshot.quality.clone(),
                "-pix_fmt".into(),
                "yuvj420p".into(),
            ]
        };

        match self.run_static_screenshot_command(
            &base,
            &output_args,
            &output_image,
            &config.screenshot.quality,
            !has_custom,
            0,
        ) {
            Ok(()) => Ok(output_image),
            Err(err) => {
                if is_ext(&output_image, "webp") {
                    let fallback =
                        make_unique_file_name(&output_image.with_extension("jpeg"));
                    let mut fb = base;
                    fb.extend([
                        "-q:v".into(),
                        config.screenshot.quality.clone(),
                        "-pix_fmt".into(),
                        "yuvj420p".into(),
                        fallback.to_string_lossy().into_owned(),
                    ]);
                    self.run_ffmpeg_checked(&fb, 0)?;
                    return Ok(fallback);
                }
                Err(err)
            }
        }
    }

    pub fn video_to_animation(
        &self,
        input_path: &Path,
        start: f64,
        end: f64,
        audio: bool,
        game_name: &str,
        config: &ProfileConfig,
    ) -> Result<PathBuf, String> {
        if end <= start {
            return Err("end time must be after start time".into());
        }
        let duration = (end - start).max(0.05);
        let settings = &config.screenshot.animated_settings;
        let codec = settings.extension.to_ascii_lowercase();
        let target_ext = if audio {
            "webm"
        } else if codec == "webp" {
            "webp"
        } else {
            "avif"
        };
        let output_path = make_unique_file_name(&self.temp_dir.join(format!(
            "{}.{target_ext}",
            sanitize_filename(game_name)
        )));

        let mut fps = settings.fps;
        let mut max_width = settings.max_width;
        let mut quality = settings.scaled_quality;
        let use_size_target = codec == "avif" && !audio && settings.target_size_kb > 0;
        if codec == "avif" && !audio && settings.adaptive_avif && !use_size_target {
            let (efps, ew, eq) = adaptive_avif_settings(duration, fps, max_width, quality);
            fps = efps;
            max_width = ew;
            quality = eq;
        }

        let mut crop_filters = Vec::new();
        if config.screenshot.trim_black_bars_wip {
            if let Some(crop) = self.find_black_bars(input_path, start) {
                crop_filters.push(crop);
            }
        }
        let hwaccel = if codec == "avif" {
            extract_hwaccel_args(&config.screenshot.custom_ffmpeg_settings)
        } else {
            Vec::new()
        };

        let build_cmd = |encode_fps: u32, encode_width: u32, clip_start: f64, clip_dur: f64| {
            let mut vf = crop_filters.clone();
            if encode_fps > 0 {
                let rounding = if use_size_target {
                    ":round=up:start_time=0"
                } else {
                    ""
                };
                vf.push(format!("fps={encode_fps}{rounding}"));
            }
            if encode_width > 0 {
                if use_size_target {
                    vf.push(format!("scale='2*trunc(min({encode_width},iw)/2)':-2"));
                } else {
                    vf.push(format!("scale={encode_width}:-1"));
                }
            }
            vf.push("pad=ceil(iw/2)*2:ceil(ih/2)*2".into());

            let mut cmd = self.base_ffmpeg_args("error");
            cmd.extend(["-ss".into(), format!("{clip_start}")]);
            cmd.extend(hwaccel.clone());
            cmd.extend([
                "-i".into(),
                input_path.to_string_lossy().into_owned(),
                "-t".into(),
                format!("{clip_dur}"),
                "-vf".into(),
                vf.join(","),
            ]);
            if !audio {
                cmd.push("-an".into());
            }
            cmd
        };

        let output_args: Vec<String> = if settings.faststart {
            vec!["-movflags".into(), "+faststart".into()]
        } else {
            Vec::new()
        };

        if use_size_target {
            self.run_size_target_avif(
                input_path,
                &output_path,
                start,
                duration,
                AvifParameters {
                    fps: fps.max(1),
                    width: max_width,
                    crf: quality.min(63),
                },
                (settings.target_size_kb as u64) * 1024,
                &settings.size_priority,
                &settings.codec,
                settings.encoder_fallback,
                &output_args,
                &build_cmd,
            )?;
            return Ok(output_path);
        }

        let mut cmd = build_cmd(fps, max_width, start, duration);
        if audio {
            cmd.extend(av1_encoder_args(&settings.codec, quality));
            cmd.extend([
                "-c:a".into(),
                "libopus".into(),
                "-b:a".into(),
                "128k".into(),
                "-f".into(),
                "webm".into(),
                output_path.to_string_lossy().into_owned(),
            ]);
            self.run_ffmpeg_checked(&cmd, 0)?;
        } else if codec == "webp" {
            cmd.extend([
                "-c:v".into(),
                "libwebp".into(),
                "-lossless".into(),
                "0".into(),
                "-q:v".into(),
                quality.to_string(),
                "-compression_level".into(),
                "6".into(),
                "-preset".into(),
                "picture".into(),
                "-loop".into(),
                "0".into(),
                "-threads".into(),
                "0".into(),
                output_path.to_string_lossy().into_owned(),
            ]);
            self.run_ffmpeg_checked(&cmd, 0)?;
        } else {
            self.run_av1_with_fallback(
                &cmd,
                &settings.codec,
                quality,
                &output_args,
                &output_path,
                settings.encoder_fallback,
            )?;
        }
        Ok(output_path)
    }

    pub fn trim_animation(
        &self,
        input_path: &Path,
        start_offset: f64,
        duration: f64,
        game_name: &str,
        config: &ProfileConfig,
    ) -> Result<PathBuf, String> {
        if duration <= 0.0 {
            return Err("duration must be positive".into());
        }
        let settings = &config.screenshot.animated_settings;
        let codec = input_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or(&settings.extension)
            .to_ascii_lowercase();
        let output_path = make_unique_file_name(
            &self
                .temp_dir
                .join(format!("{}.{codec}", sanitize_filename(game_name))),
        );
        let mut cmd = self.base_ffmpeg_args("error");
        if start_offset > 0.0 {
            cmd.extend(["-ss".into(), format!("{start_offset:.3}")]);
        }
        cmd.extend(["-i".into(), input_path.to_string_lossy().into_owned()]);
        cmd.extend(self.avif_animation_stream_map_args(input_path, &codec));
        cmd.extend(["-t".into(), format!("{duration:.3}"), "-an".into()]);
        let mut vf = vec!["pad=ceil(iw/2)*2:ceil(ih/2)*2".to_string()];
        if settings.fps > 0 {
            vf.insert(0, format!("fps={}", settings.fps));
        }
        cmd.extend(["-vf".into(), vf.join(",")]);

        if codec == "webp" {
            cmd.extend([
                "-c:v".into(),
                "libwebp".into(),
                "-lossless".into(),
                "0".into(),
                "-q:v".into(),
                settings.scaled_quality.to_string(),
                "-compression_level".into(),
                "6".into(),
                "-preset".into(),
                "picture".into(),
                "-loop".into(),
                "0".into(),
                "-threads".into(),
                "0".into(),
                output_path.to_string_lossy().into_owned(),
            ]);
            self.run_ffmpeg_checked(&cmd, 0)?;
        } else {
            let out_args = if settings.faststart {
                vec!["-movflags".into(), "+faststart".into()]
            } else {
                Vec::new()
            };
            self.run_av1_with_fallback(
                &cmd,
                &settings.codec,
                settings.scaled_quality,
                &out_args,
                &output_path,
                settings.encoder_fallback,
            )?;
        }
        Ok(output_path)
    }

    pub fn trim_replay_for_gameline(
        &self,
        video_path: &Path,
        start_time: f64,
        end_time: f64,
        accurate: bool,
    ) -> Result<PathBuf, String> {
        let stem = video_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("replay");
        let preferred = self.temp_dir.join(format!("trimmed_{stem}.mp4"));
        self.save_trimmed_replay(video_path, start_time, end_time, accurate, &preferred)
    }

    /// Encode beside the destination so publishing the finished MP4 only needs a rename.
    pub fn save_trimmed_replay(
        &self, video_path: &Path, start_time: f64, end_time: f64, accurate: bool, destination: &Path,
    ) -> Result<PathBuf, String> {
        let directory = destination.parent().ok_or("Missing video output directory")?;
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let mut staged = tempfile::Builder::new().prefix(".gsm-trim-").suffix(".mp4")
            .tempfile_in(directory).map_err(|e| e.to_string())?;
        let mut args = self.base_ffmpeg_args("error");
        args.extend([
            "-y".into(), // Only the exclusively created staging file may be overwritten.
            "-abort_on".into(),
            "empty_output".into(),
            "-ss".into(),
            format!("{start_time}"),
            "-i".into(),
            video_path.to_string_lossy().into_owned(),
        ]);
        let dur = end_time - start_time;
        if dur > 0.0 {
            args.extend(["-t".into(), format!("{dur}")]);
        }
        if accurate {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "veryfast".into(),
                "-c:a".into(),
                "aac".into(),
            ]);
        } else {
            args.extend(["-c:v".into(), "copy".into(), "-c:a".into(), "copy".into()]);
        }
        args.push(staged.path().to_string_lossy().into_owned());
        let output = self.run_ffmpeg(&args, 0, false)?;
        if !output.status.success() {
            return Err(format!("FFmpeg could not trim the replay: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        if staged.as_file().metadata().map_err(|e| e.to_string())?.len() == 0 {
            return Err("FFmpeg produced an empty video".into());
        }
        let mut path = destination.to_owned();
        loop {
            match staged.persist_noclobber(&path) {
                Ok(_) => return Ok(path),
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    staged = e.file;
                    let stem = destination.file_stem().and_then(|s| s.to_str()).unwrap_or("replay");
                    path = directory.join(format!("{stem}_{}.mp4", uuid::Uuid::new_v4().simple()));
                }
                Err(e) => return Err(e.error.to_string()),
            }
        }
    }

    pub fn copy_replay_segment(
        &self,
        video_path: &Path,
        start_time: f64,
        end_time: f64,
        output_path: &Path,
    ) -> Option<f64> {
        let stem = output_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("clip");
        let ext = output_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("mkv");
        let staged = output_path
            .parent()
            .unwrap_or(&self.temp_dir)
            .join(format!("{stem}.staging.{ext}"));

        let mut args1 = self.base_ffmpeg_args("error");
        args1.extend([
            "-ss".into(),
            format!("{start_time}"),
            "-to".into(),
            format!("{end_time}"),
            "-i".into(),
            video_path.to_string_lossy().into_owned(),
            "-map".into(),
            "0".into(),
            "-c".into(),
            "copy".into(),
            "-copyts".into(),
            "-y".into(),
            staged.to_string_lossy().into_owned(),
        ]);
        let staged_start = if self.run_ffmpeg_checked(&args1, 0).is_ok() && staged.is_file() {
            self.get_format_start_time(&staged)
        } else {
            None
        };
        let result = if let Some(ss) = staged_start {
            let mut args2 = self.base_ffmpeg_args("error");
            args2.extend([
                "-i".into(),
                staged.to_string_lossy().into_owned(),
                "-map".into(),
                "0".into(),
                "-c".into(),
                "copy".into(),
                "-y".into(),
                output_path.to_string_lossy().into_owned(),
            ]);
            if self.run_ffmpeg_checked(&args2, 0).is_ok() && output_path.is_file() {
                let source_start = self.get_format_start_time(video_path).unwrap_or(0.0);
                Some((ss - source_start).max(0.0))
            } else {
                None
            }
        } else {
            None
        };
        let _ = std::fs::remove_file(&staged);
        result
    }

    pub fn unique_temp_path(&self, suffix: &str) -> PathBuf {
        let id = uuid::Uuid::new_v4().simple().to_string();
        self.temp_dir.join(format!("gsm_{id}{suffix}"))
    }

    fn build_screenshot_filters(
        &self,
        source_video_path: Option<&Path>,
        screenshot_timing: Option<f64>,
        use_negative_two: bool,
        config: &ProfileConfig,
    ) -> Vec<String> {
        let mut vf = Vec::new();
        if config.screenshot.trim_black_bars_wip {
            if let (Some(v), Some(t)) = (source_video_path, screenshot_timing) {
                if let Some(crop) = self.find_black_bars(v, t) {
                    vf.push(crop);
                }
            }
        }
        if config.screenshot.width != 0 || config.screenshot.height != 0 {
            let default = if use_negative_two { -2 } else { -1 };
            let w = if config.screenshot.width != 0 {
                config.screenshot.width
            } else {
                default
            };
            let h = if config.screenshot.height != 0 {
                config.screenshot.height
            } else {
                default
            };
            vf.push(format!("scale={w}:{h}"));
        }
        vf
    }

    fn run_static_screenshot_command(
        &self,
        base: &[String],
        output_args: &[String],
        output_path: &Path,
        quality: &str,
        use_fast_avif: bool,
        retries: usize,
    ) -> Result<(), String> {
        if use_fast_avif && is_ext(output_path, "avif") {
            let mut last_err = String::new();
            for encoder in ["libsvtav1", "libaom-av1"] {
                let mut cmd = base.to_vec();
                cmd.extend(static_avif_encoder_args(encoder, quality));
                cmd.push(output_path.to_string_lossy().into_owned());
                let enc_retries = if encoder == "libsvtav1" { 0 } else { retries };
                match self.run_ffmpeg(&cmd, enc_retries, false) {
                    Ok(out) if out.status.success() => return Ok(()),
                    Ok(out) => {
                        last_err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    }
                    Err(e) => last_err = e,
                }
                let _ = std::fs::remove_file(output_path);
            }
            return Err(format!("Static AVIF encoding failed: {last_err}"));
        }
        let mut cmd = base.to_vec();
        cmd.extend_from_slice(output_args);
        cmd.push(output_path.to_string_lossy().into_owned());
        self.run_ffmpeg_checked(&cmd, retries)?;
        Ok(())
    }

    fn run_av1_with_fallback(
        &self,
        base: &[String],
        encoder: &str,
        quality: u32,
        output_args: &[String],
        output_path: &Path,
        fallback_enabled: bool,
    ) -> Result<(), String> {
        let primary = normalize_av1_encoder(encoder);
        let mut cmd = base.to_vec();
        cmd.extend(av1_encoder_args(primary, quality));
        cmd.extend_from_slice(output_args);
        cmd.push(output_path.to_string_lossy().into_owned());
        match self.run_ffmpeg_checked(&cmd, 0) {
            Ok(_) => Ok(()),
            Err(primary_err) => {
                let fallback = fallback_av1_encoder(primary);
                if !fallback_enabled || fallback == primary {
                    return Err(primary_err);
                }
                let _ = std::fs::remove_file(output_path);
                let mut fb_cmd = base.to_vec();
                fb_cmd.extend(av1_encoder_args(fallback, quality));
                fb_cmd.extend_from_slice(output_args);
                fb_cmd.push(output_path.to_string_lossy().into_owned());
                self.run_ffmpeg_checked(&fb_cmd, 0)?;
                Ok(())
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run_size_target_avif<F>(
        &self,
        input_path: &Path,
        output_path: &Path,
        start: f64,
        mut duration: f64,
        mut caps: AvifParameters,
        target_bytes: u64,
        priority: &str,
        av1_encoder: &str,
        fallback_enabled: bool,
        output_args: &[String],
        build_cmd: &F,
    ) -> Result<(), String>
    where
        F: Fn(u32, u32, f64, f64) -> Vec<String>,
    {
        let info = self.probe_replay(input_path).unwrap_or(Value::Null);
        let stream = first_video_stream(&info);
        let source_width = stream
            .and_then(|s| s.get("width"))
            .and_then(value_as_u64)
            .unwrap_or(0) as u32;
        let source_fps = stream
            .and_then(|s| s.get("avg_frame_rate"))
            .map(fraction_to_f64)
            .unwrap_or(0.0);
        let mut width = if caps.width > 0 { caps.width } else { source_width };
        if source_width > 0 {
            width = width.min(source_width);
        }
        if width == 0 {
            return Err("Cannot estimate AVIF size without a source or configured width".into());
        }
        let fps = if source_fps > 0.0 {
            caps.fps.min((source_fps.floor() as u32).max(1))
        } else {
            caps.fps
        };
        caps = AvifParameters {
            fps: fps.max(1),
            width: ((width / 2) * 2).max(2),
            crf: caps.crf.min(63),
        };
        let source_dur = info
            .get("format")
            .and_then(|f| f.get("duration"))
            .and_then(value_as_f64)
            .unwrap_or(0.0);
        if source_dur > 0.0 {
            duration = duration.min(source_dur - start);
        }
        if !duration.is_finite() || duration <= 0.0 {
            return Err("Animation window must overlap the source video".into());
        }
        let candidates = size_candidates(caps, priority);
        let primary = normalize_av1_encoder(av1_encoder);
        let mut encoders = vec![primary];
        if fallback_enabled {
            let fb = fallback_av1_encoder(primary);
            if fb != primary {
                encoders.push(fb);
            }
        }
        for (idx, encoder) in encoders.iter().enumerate() {
            let attempt = (|| -> Result<(), String> {
                let scratch = tempfile::Builder::new()
                    .prefix("gsm-avif-size-")
                    .tempdir_in(&self.temp_dir)
                    .map_err(|e| e.to_string())?;
                let sample_path = scratch.path().join("sample.avif");
                let encode = |params: AvifParameters, s: f64, d: f64, out: &Path| -> Result<(), String> {
                    let mut cmd = build_cmd(params.fps, params.width, s, d);
                    cmd.extend(["-abort_on".into(), "empty_output".into()]);
                    if out == sample_path {
                        cmd.push("-y".into());
                    }
                    cmd.extend(av1_encoder_args(encoder, params.crf));
                    cmd.extend_from_slice(output_args);
                    cmd.push(out.to_string_lossy().into_owned());
                    self.run_ffmpeg_checked(&cmd, 0)?;
                    Ok(())
                };
                let (params, _) = choose_size_parameters(&candidates, target_bytes, |p| {
                    let mut total_bytes = 0u64;
                    let mut sampled_dur = 0.0f64;
                    for (ss, sd) in sample_ranges(start, duration) {
                        encode(p, ss, sd, &sample_path)?;
                        let len = std::fs::metadata(&sample_path)
                            .map_err(|e| e.to_string())?
                            .len();
                        if len == 0 {
                            return Err("AVIF size sample was empty".into());
                        }
                        total_bytes += len;
                        sampled_dur += sd;
                    }
                    Ok(((total_bytes as f64) * duration / sampled_dur).ceil() as u64)
                })?;
                encode(params, start, duration, output_path)
            })();
            match attempt {
                Ok(()) => return Ok(()),
                Err(err) if idx + 1 == encoders.len() => return Err(err),
                Err(_) => {
                    let _ = std::fs::remove_file(output_path);
                }
            }
        }
        Err("AVIF size target encoding failed".into())
    }

    fn avif_animation_stream_map_args(&self, input_path: &Path, codec: &str) -> Vec<String> {
        if codec != "avif" {
            return Vec::new();
        }
        let Some(info) = self.probe_json(
            input_path,
            "stream=index,nb_frames,duration,avg_frame_rate:stream_tags=handler_name",
            "v",
        ) else {
            return Vec::new();
        };
        let Some(streams) = info.get("streams").and_then(Value::as_array) else {
            return Vec::new();
        };
        if streams.len() < 2 {
            return Vec::new();
        }
        let score = |s: &Value| {
            let nb_frames = s.get("nb_frames").and_then(value_as_u64).unwrap_or(0);
            let dur = s.get("duration").and_then(value_as_f64).unwrap_or(0.0);
            let fps = s.get("avg_frame_rate").map(fraction_to_f64).unwrap_or(0.0);
            let handler = s
                .get("tags")
                .and_then(|t| t.get("handler_name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            (
                nb_frames > 1,
                dur > 0.0,
                fps > 1.0,
                handler == "PictureHandler",
                (fps * 1000.0) as i64,
            )
        };
        let Some(selected) = streams.iter().max_by_key(|s| score(s)) else {
            return Vec::new();
        };
        let sc = score(selected);
        if !(sc.0 || sc.1 || sc.2 || sc.3) {
            return Vec::new();
        }
        match selected.get("index").and_then(value_as_u64) {
            Some(idx) => vec!["-map".into(), format!("0:{idx}")],
            None => Vec::new(),
        }
    }
}

pub fn wait_for_stable_file(path: &Path, timeout: Duration, check_interval: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    let mut last_size: Option<u64> = None;
    while std::time::Instant::now() < deadline {
        if let Ok(meta) = std::fs::metadata(path) {
            let size = meta.len();
            if last_size == Some(size) && std::fs::File::open(path).is_ok() {
                return true;
            }
            last_size = Some(size);
        } else {
            last_size = None;
        }
        std::thread::sleep(check_interval);
    }
    false
}

pub async fn wait_for_stable_file_async(
    path: PathBuf,
    timeout: Duration,
    check_interval: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_size: Option<u64> = None;
    while tokio::time::Instant::now() < deadline {
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            let size = meta.len();
            if last_size == Some(size) && tokio::fs::File::open(&path).await.is_ok() {
                return true;
            }
            last_size = Some(size);
        } else {
            last_size = None;
        }
        tokio::time::sleep(check_interval).await;
    }
    false
}

pub fn file_mtime_epoch(path: &Path) -> Option<f64> {
    let dur = std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?;
    Some(dur.as_secs_f64())
}

fn fast_wav_duration(path: &Path) -> Option<f64> {
    if !is_ext(path, "wav") {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12usize;
    let mut byte_rate = 0u32;
    let mut data_size = 0u32;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]);
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= data.len() {
            byte_rate = u32::from_le_bytes([
                data[body + 8],
                data[body + 9],
                data[body + 10],
                data[body + 11],
            ]);
        } else if id == b"data" {
            data_size = size;
            break;
        }
        pos = body.saturating_add(size as usize + (size as usize % 2));
    }
    if byte_rate > 0 {
        Some(data_size as f64 / byte_rate as f64)
    } else {
        None
    }
}

fn replace_file_with_retry(src: &Path, dst: &Path, retries: usize) -> Result<(), String> {
    for attempt in 0..retries {
        match std::fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            Err(_) => {
                if std::fs::copy(src, dst).is_ok() {
                    let _ = std::fs::remove_file(src);
                    return Ok(());
                }
                if attempt + 1 < retries {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
    }
    Err(format!(
        "Failed to replace {} with {}",
        dst.display(),
        src.display()
    ))
}

fn is_ext(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case(ext))
}

pub fn parse_custom_ffmpeg_settings(custom: &str) -> (Vec<String>, Vec<String>) {
    if custom.trim().is_empty() {
        return (Vec::new(), Vec::new());
    }
    let parts = shell_words::split(custom).unwrap_or_default();
    if parts.len() >= 2 {
        for idx in 0..parts.len() - 1 {
            let low = parts[idx].to_ascii_lowercase();
            if (low == "-hwaccel" || low == "--hwaccel") && !parts[idx + 1].starts_with('-') {
                let pre = vec![parts[idx].clone(), parts[idx + 1].clone()];
                let mut post = parts[..idx].to_vec();
                post.extend_from_slice(&parts[idx + 2..]);
                return (pre, post);
            }
        }
    }
    (Vec::new(), parts)
}

pub fn extract_hwaccel_args(custom: &str) -> Vec<String> {
    if custom.trim().is_empty() {
        return Vec::new();
    }
    let parts = shell_words::split(custom).unwrap_or_default();
    for (idx, part) in parts.iter().enumerate() {
        let low = part.to_ascii_lowercase();
        if low == "-hwaccel" || low == "--hwaccel" {
            let mut out = vec![part.clone()];
            if let Some(next) = parts.get(idx + 1) {
                if !next.starts_with('-') {
                    out.push(next.clone());
                }
            }
            return out;
        }
        if low.starts_with("-hwaccel=") || low.starts_with("--hwaccel=") {
            return vec![part.clone()];
        }
    }
    Vec::new()
}

fn normalize_av1_encoder(encoder: &str) -> &'static str {
    for &c in ANIMATED_SCREENSHOT_CODECS {
        if c == encoder {
            return c;
        }
    }
    ANIMATED_SCREENSHOT_CODEC_DEFAULT
}

fn fallback_av1_encoder(encoder: &str) -> &'static str {
    let norm = normalize_av1_encoder(encoder);
    ANIMATED_SCREENSHOT_CODECS
        .iter()
        .copied()
        .find(|&c| c != norm)
        .unwrap_or(norm)
}

fn av1_encoder_args(encoder: &str, quality: u32) -> Vec<String> {
    if normalize_av1_encoder(encoder) == "libsvtav1" {
        vec![
            "-c:v".into(),
            "libsvtav1".into(),
            "-crf".into(),
            quality.to_string(),
            "-preset".into(),
            "8".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]
    } else {
        vec![
            "-c:v".into(),
            "libaom-av1".into(),
            "-cpu-used".into(),
            "6".into(),
            "-crf".into(),
            quality.to_string(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]
    }
}

pub fn static_avif_crf(quality: &str) -> i32 {
    let q = quality
        .trim()
        .parse::<i32>()
        .unwrap_or(STATIC_AVIF_DEFAULT_QUALITY)
        .clamp(0, 100);
    if q <= STATIC_AVIF_DEFAULT_QUALITY {
        let crf_range = (STATIC_AVIF_MAX_CRF - STATIC_AVIF_DEFAULT_CRF) as f64;
        (STATIC_AVIF_MAX_CRF as f64 - (q as f64) * crf_range / STATIC_AVIF_DEFAULT_QUALITY as f64)
            .round() as i32
    } else {
        let high_range = (100 - STATIC_AVIF_DEFAULT_QUALITY) as f64;
        (STATIC_AVIF_DEFAULT_CRF as f64 * (100 - q) as f64 / high_range).round() as i32
    }
}

fn static_avif_encoder_args(encoder: &str, quality: &str) -> Vec<String> {
    let crf = static_avif_crf(quality);
    if encoder == "libsvtav1" {
        vec![
            "-c:v".into(),
            "libsvtav1".into(),
            "-preset".into(),
            STATIC_AVIF_SVT_PRESET.to_string(),
            "-crf".into(),
            crf.to_string(),
            "-pix_fmt".into(),
            "yuv420p10le".into(),
        ]
    } else {
        let aom_crf = (crf as f64 * STATIC_AVIF_AOM_CRF_SCALE).round() as i32;
        vec![
            "-c:v".into(),
            "libaom-av1".into(),
            "-still-picture".into(),
            "1".into(),
            "-cpu-used".into(),
            "6".into(),
            "-crf".into(),
            aom_crf.to_string(),
            "-pix_fmt".into(),
            "yuv420p10le".into(),
        ]
    }
}

fn adaptive_avif_settings(duration: f64, fps: u32, max_width: u32, quality: u32) -> (u32, u32, u32) {
    let tiers: &[(f64, f64, f64, i32)] = &[
        (10.0, 0.50, 0.75, 5),
        (5.0, 0.80, 5.0 / 6.0, 2),
        (0.0, 1.00, 1.00, 0),
    ];
    let (fm, wm, co) = tiers
        .iter()
        .find(|&&(min_d, _, _, _)| duration > min_d)
        .map(|&(_, fm, wm, co)| (fm, wm, co))
        .unwrap_or((1.0, 1.0, 0));
    let base_fps = if fps > 0 { fps } else { 30 };
    let efps = ((base_fps as f64 * fm).round() as u32).max(1);
    let ew = if max_width > 0 {
        ((max_width as f64 * wm).round() as u32).max(2)
    } else {
        0
    };
    let base_q = if quality > 0 {
        quality as i32
    } else {
        ADAPTIVE_AVIF_BASE_CRF
    };
    let eq = (base_q + co).clamp(0, 63) as u32;
    (efps, ew, eq)
}

fn value_as_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
}

fn value_as_u64(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
}

pub(crate) fn first_video_stream(info: &Value) -> Option<&Value> {
    info.get("streams")?
        .as_array()?
        .iter()
        .find(|stream| stream["codec_type"] == "video")
}

pub(crate) fn fraction_to_f64(v: &Value) -> f64 {
    let Some(s) = v.as_str() else {
        return value_as_f64(v).unwrap_or(0.0);
    };
    if let Some((num, den)) = s.split_once('/') {
        let n = num.trim().parse::<f64>().unwrap_or(0.0);
        let d = den.trim().parse::<f64>().unwrap_or(0.0);
        if d != 0.0 {
            return n / d;
        }
    }
    s.trim().parse::<f64>().unwrap_or(0.0)
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_video_trim_cannot_return_an_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let tools = MediaTools {
            ffmpeg: dir.path().join("missing-ffmpeg"),
            ffprobe: dir.path().join("missing-ffprobe"),
            temp_dir: dir.path().into(),
        };
        let old = dir.path().join("trimmed_game.mp4");
        std::fs::write(&old, b"older clip").unwrap();
        assert!(tools.trim_replay_for_gameline(&dir.path().join("game.mkv"), 0., 1., true).is_err());
        assert_eq!(std::fs::read(&old).unwrap(), b"older clip");
    }

    #[test]
    #[ignore = "requires FFmpeg on PATH"]
    fn replay_exports_require_media_packets() {
        let dir = tempfile::tempdir().unwrap();
        let tools = MediaTools::discover(None, dir.path().into());
        let source = dir.path().join("source.mp4");
        let destination = dir.path().join("trimmed.mp4");
        let mut fixture = tools.base_ffmpeg_args("error");
        fixture.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "color=s=64x64:r=10:d=1".into(),
            "-c:v".into(),
            "mpeg4".into(),
            source.to_string_lossy().into_owned(),
        ]);
        tools.run_ffmpeg_checked(&fixture, 0).unwrap();

        assert!(tools
            .save_trimmed_replay(&source, 2.0, 3.0, true, &destination)
            .is_err());
        assert!(!destination.exists());
        assert!(tools.get_raw_screenshot(&source, 2.0, "test").is_err());

        let clip = tools
            .save_trimmed_replay(&source, 0.0, 0.5, true, &destination)
            .unwrap();
        assert!(tools.get_video_duration(&clip) > 0.0);
        assert!(tools.get_raw_screenshot(&source, 0.2, "test").unwrap().is_file());
        let layout = crate::frame_selector::Layout::probe(&tools, &source, 1.0, "beginning")
            .unwrap();
        assert!((layout.reference - 0.9).abs() < 1e-6);
    }

    #[test]
    #[ignore = "requires FFmpeg on PATH"]
    fn vad_pipe_matches_wav_samples() {
        let dir = tempfile::tempdir().unwrap();
        let tools = MediaTools::discover(None, dir.path().into());
        let source = dir.path().join("source.wav");
        let wav = dir.path().join("resampled.wav");
        let mut fixture = tools.base_ffmpeg_args("error");
        fixture.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*660*t):s=48000:d=1".into(),
            source.to_string_lossy().into_owned(),
        ]);
        tools.run_ffmpeg_checked(&fixture, 0).unwrap();

        for use_filters in [false, true] {
            let mut args = tools.base_ffmpeg_args("error");
            args.extend([
                "-y".into(),
                "-i".into(),
                source.to_string_lossy().into_owned(),
                "-vn".into(),
                "-ar".into(),
                "16000".into(),
                "-ac".into(),
                "1".into(),
            ]);
            if use_filters {
                let filters = if cfg!(target_os = "linux") {
                    "afftdn"
                } else {
                    "afftdn,dialoguenhance"
                };
                args.extend(["-af".into(), filters.into()]);
            }
            args.extend([
                "-c:a".into(),
                "pcm_s16le".into(),
                wav.to_string_lossy().into_owned(),
            ]);
            tools.run_ffmpeg_checked(&args, 0).unwrap();
            let expected = crate::vad::load_pcm16_mono_wav(&wav).unwrap();
            let actual = tools.decode_vad_audio(&source, use_filters).unwrap();
            assert_eq!(actual.len(), expected.len());
            assert!(actual.iter().eq(&expected), "PCM samples differ");
        }
    }

    #[test]
    fn static_avif_crf_matches_python_curve() {
        assert_eq!(static_avif_crf("85"), 26);
        assert_eq!(static_avif_crf("100"), 0);
        assert_eq!(static_avif_crf("0"), 63);
    }

    #[test]
    fn custom_ffmpeg_hwaccel_splitting() {
        let (pre, post) = parse_custom_ffmpeg_settings("-hwaccel cuda -q:v 80");
        assert_eq!(pre, vec!["-hwaccel", "cuda"]);
        assert_eq!(post, vec!["-q:v", "80"]);
        assert_eq!(extract_hwaccel_args("-hwaccel=vaapi -vf scale=1280:-1"), vec!["-hwaccel=vaapi"]);
    }
}
