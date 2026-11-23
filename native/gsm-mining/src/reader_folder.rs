use crate::{
    config::ProfileConfig, ffmpeg::MediaTools, pause_gaps::PauseHistory, reader_media::LineReplay,
    text::sanitize_filename, vad::VadSystem,
};
use chrono::{DateTime, Local};
use std::path::{Path, PathBuf};

/// Assemble files on the destination volume. Reserving a fresh directory at
/// publication prevents two simultaneous exports from replacing one another.
pub struct Folder {
    stage: tempfile::TempDir,
    day: PathBuf,
    base: String,
}
impl Folder {
    pub fn new(root: &Path, text: &str, now: DateTime<Local>) -> Result<Self, String> {
        let name = sanitize_filename(text.trim())
            .chars()
            .take(32)
            .collect::<String>();
        let name = if name.trim().is_empty() {
            "line"
        } else {
            name.trim()
        };
        let base = format!("{name}_{}", now.format("%H-%M-%S"));
        let day = root.join(now.format("%Y-%m/%d").to_string());
        std::fs::create_dir_all(&day).map_err(|e| e.to_string())?;
        let stage = tempfile::Builder::new()
            .prefix(".gsm-media-")
            .tempdir_in(&day)
            .map_err(|e| e.to_string())?;
        std::fs::write(stage.path().join("sentence.txt"), text).map_err(|e| e.to_string())?;
        Ok(Self { stage, day, base })
    }
    pub fn screenshot(&self, file: &Path) -> Result<(), String> {
        let output = self
            .stage
            .path()
            .join(file.file_name().ok_or("Screenshot is missing a filename")?);
        std::fs::copy(file, &output).map_err(|e| {
            let _ = std::fs::remove_file(output);
            e.to_string()
        })?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn finish(
        self,
        replay: LineReplay<'_>,
        audio_cutoff: Option<f64>,
        media: &MediaTools,
        config: &ProfileConfig,
        pauses: &PauseHistory,
        models: &VadSystem,
        use_vad: bool,
        mut warn: impl FnMut(String),
    ) -> Result<PathBuf, String> {
        let tools = MediaTools {
            temp_dir: self.stage.path().to_owned(),
            ..media.clone()
        };
        if config.audio.enabled {
            let audio = LineReplay {
                next_line_time: audio_cutoff,
                ..replay
            };
            let result = audio
                .audio(&tools, config, pauses, models, use_vad)
                .and_then(|file| {
                    let output = self
                        .stage
                        .path()
                        .join("output")
                        .with_extension(file.extension().ok_or("Missing audio format")?);
                    std::fs::rename(&file, output).map_err(|e| e.to_string())
                });
            if let Err(error) = result {
                warn(error);
            }
        }
        if config.paths.copy_trimmed_replay_to_output_folder {
            let stem = replay
                .path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("replay");
            let path = self.stage.path().join(format!("trimmed_{stem}.mp4"));
            if let Err(error) = replay.save_video(&tools, config, pauses, models, use_vad, &path) {
                warn(error);
            }
        }
        publish(self.stage.path(), &self.day, &self.base)
    }
}

fn publish(staged: &Path, day: &Path, base: &str) -> Result<PathBuf, String> {
    let mut files = std::fs::read_dir(staged)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|e| e.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    files.sort_by_key(|name| name == "sentence.txt");
    let mut destination = day.join(base);
    loop {
        match std::fs::create_dir(&destination) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                destination = day.join(format!("{base}_{}", uuid::Uuid::new_v4().simple()))
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    for (i, name) in files.iter().enumerate() {
        if let Err(e) = std::fs::rename(staged.join(name), destination.join(name)) {
            for moved in &files[..i] {
                let _ = std::fs::remove_file(destination.join(moved));
            }
            let _ = std::fs::remove_dir(&destination);
            return Err(e.to_string());
        }
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simultaneous_exports_preserve_existing_folders_and_names() {
        let root = tempfile::tempdir().unwrap();
        let existing = root.path().join("same");
        std::fs::create_dir(&existing).unwrap();
        std::thread::scope(|threads| {
            for text in ["first", "second"] {
                let day = root.path();
                threads.spawn(move || {
                    let stage = tempfile::tempdir_in(day).unwrap();
                    std::fs::write(stage.path().join("sentence.txt"), text).unwrap();
                    let dir = publish(stage.path(), day, "same").unwrap();
                    assert_eq!(
                        std::fs::read_to_string(dir.join("sentence.txt")).unwrap(),
                        text
                    );
                });
            }
        });
        assert_eq!(std::fs::read_dir(existing).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 3);
    }
}
