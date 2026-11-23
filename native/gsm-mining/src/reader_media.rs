use crate::{
    config::ProfileConfig,
    ffmpeg::MediaTools,
    pause_gaps::PauseHistory,
    policy::rebase_vad_on_video,
    text::{sanitize_filename, GameLine},
    vad::VadSystem,
};
use chrono::{DateTime, Local};
use std::path::{Path, PathBuf};

/// An OBS replay uses its modification time. A saved clip carries its original
/// recording end in the manifest, even if it was copied to a different disk.
pub struct LineReplay<'a> {
    pub path: &'a Path,
    pub recording_end: Option<f64>,
    pub line: &'a GameLine,
    pub next_line_time: Option<f64>,
}

impl LineReplay<'_> {
    pub fn audio(
        &self,
        media: &MediaTools,
        config: &ProfileConfig,
        pauses: &PauseHistory,
        vad: &VadSystem,
        use_vad: bool,
    ) -> Result<tempfile::TempPath, String> {
        let scratch = tempfile::tempdir_in(&media.temp_dir).map_err(|e| e.to_string())?;
        let tools = MediaTools {
            temp_dir: scratch.path().to_owned(),
            ..media.clone()
        };
        let (_, trimmed, _, _, _) = tools.get_audio_and_trim(
            self.path,
            self.line,
            self.next_line_time,
            self.recording_end,
            pauses,
            config,
        )?;
        let wav = scratch.path().join("playback.wav");
        media.playback_wav(&trimmed, &wav)?;
        let mut output = wav;
        if use_vad && config.vad.do_vad_postprocessing {
            let target = scratch
                .path()
                .join(format!("voice.{}", config.audio.extension));
            let result = vad.trim_audio_with_vad(
                &tools,
                &output,
                &target,
                Some(self.line),
                self.next_line_time.is_some(),
                config,
            );
            let candidate = PathBuf::from(result.output_audio);
            if candidate.is_file() {
                output = candidate;
            }
        }
        // Keep only the playable file while the line is cached. The full extracted
        // soundtrack, intermediate trim and model inputs can be released now.
        let ext = output.extension().and_then(|s| s.to_str()).unwrap_or("wav");
        let asset = tempfile::Builder::new()
            .prefix("gsm-audio-")
            .suffix(&format!(".{ext}"))
            .tempfile_in(&media.temp_dir)
            .map_err(|e| e.to_string())?
            .into_temp_path();
        std::fs::rename(output, &asset).map_err(|e| e.to_string())?;
        Ok(asset)
    }

    pub fn export_video(
        &self,
        media: &MediaTools,
        config: &ProfileConfig,
        pauses: &PauseHistory,
        vad: &VadSystem,
        use_vad: bool,
        now: DateTime<Local>,
    ) -> Result<PathBuf, String> {
        let dir = if config.paths.output_folder.is_empty() {
            media.temp_dir.clone()
        } else {
            Path::new(&config.paths.output_folder).join(now.format("%Y-%m/%d").to_string())
        };
        let name: String = sanitize_filename(self.line.text.trim())
            .chars()
            .take(48)
            .collect();
        let name = if name.trim().is_empty() {
            "replay"
        } else {
            name.trim()
        };
        let destination = dir.join(format!("{}_{name}.mp4", now.format("%H-%M-%S")));
        self.save_video(media, config, pauses, vad, use_vad, &destination)
    }

    pub fn save_video(
        &self,
        media: &MediaTools,
        config: &ProfileConfig,
        pauses: &PauseHistory,
        vad: &VadSystem,
        use_vad: bool,
        destination: &Path,
    ) -> Result<PathBuf, String> {
        let (base, position, _, length) =
            media.get_video_timings(self.path, self.line, self.recording_end, config);
        if length <= 0.0 {
            return Err("Could not read the replay duration".into());
        }
        let mut start = (base - self.line.effective_padding()).max(0.0);
        let mut end = match self
            .next_line_time
            .filter(|&t| t > self.line.time_epoch && position != 0.0)
        {
            Some(next) => {
                position + (next - self.line.time_epoch) + config.audio.pre_vad_end_offset
            }
            None => length + config.audio.pre_vad_end_offset.min(0.0),
        };
        if use_vad && config.vad.do_vad_postprocessing {
            if let Some((from, to)) = self.voice_window(media, config, pauses, vad) {
                start = (start + from).max(0.0);
                end = start + to;
            }
        }
        end = end.min(length);
        if !start.is_finite() || !end.is_finite() || end <= start {
            return Err("The selected line has no video within the replay".into());
        }
        media.save_trimmed_replay(self.path, start, end, true, destination)
    }

    fn voice_window(
        &self,
        media: &MediaTools,
        config: &ProfileConfig,
        pauses: &PauseHistory,
        vad: &VadSystem,
    ) -> Option<(f64, f64)> {
        // VAD can produce intermediate audio in several formats. Drop every
        // intermediate together after reading its timings or on model failure.
        let scratch = tempfile::tempdir_in(&media.temp_dir).ok()?;
        let tools = MediaTools {
            temp_dir: scratch.path().to_path_buf(),
            ..media.clone()
        };
        let (_, trimmed, base, _, timeline) = tools
            .get_audio_and_trim(
                self.path,
                self.line,
                self.next_line_time,
                self.recording_end,
                pauses,
                config,
            )
            .ok()?;
        let output = scratch
            .path()
            .join(format!("voice.{}", config.audio.extension));
        let mut result = vad.trim_audio_with_vad(
            &tools,
            &trimmed,
            &output,
            Some(self.line),
            self.next_line_time.is_some(),
            config,
        );
        rebase_vad_on_video(&timeline, base, &mut result);
        result.success.then_some((result.start, result.end))
    }
}
