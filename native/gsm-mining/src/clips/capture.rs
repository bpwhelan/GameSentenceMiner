use super::{directories, folders, GameLine, PauseHistory, MANIFEST_NAME};
use crate::{
    ffmpeg::{file_mtime_epoch, MediaTools},
    text::sanitize_filename,
};
use chrono::{DateTime, Local};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

#[derive(Deserialize)]
struct SelectedLine {
    id: String,
    #[serde(default)]
    role: Option<String>,
}
#[derive(Deserialize)]
struct ManifestLines {
    lines: Vec<SelectedLine>,
}

fn selects(folder: &Path, id: &str) -> bool {
    fs::read(folder.join(MANIFEST_NAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ManifestLines>(&bytes).ok())
        .is_some_and(|manifest| {
            manifest
                .lines
                .iter()
                .any(|l| l.role.as_deref() == Some("selected") && l.id == id)
        })
}

pub fn find_saved_folder(root: &Path, id: &str) -> Option<PathBuf> {
    folders(root).find(|folder| selects(folder, id))
}

pub struct ClipWindow {
    pub selected: GameLine,
    pub before: Vec<GameLine>,
    pub after: Vec<GameLine>,
}

fn local_time(epoch: f64) -> DateTime<Local> {
    DateTime::from_timestamp_micros((epoch * 1e6).round() as i64)
        .unwrap_or_default()
        .with_timezone(&Local)
}

impl ClipWindow {
    fn lines(&self) -> impl Iterator<Item = (&GameLine, &'static str)> {
        self.before
            .iter()
            .map(|l| (l, "previous"))
            .chain(std::iter::once((&self.selected, "selected")))
            .chain(self.after.iter().map(|l| (l, "next")))
    }
    fn bounds(&self) -> (f64, f64) {
        let t = self.selected.time_epoch;
        let (start, end) = self.lines().fold((t, t), |(min, max), (l, _)| {
            (min.min(l.time_epoch), max.max(l.time_epoch))
        });
        (start - 2., end + 2.)
    }
    pub fn wait_seconds(&self, now: f64) -> f64 {
        let (_, mut end) = self.bounds();
        if self.after.len() < 2 {
            end = end.max(self.selected.time_epoch + 20.);
        }
        (end - now).clamp(0., 20.)
    }
    pub fn offsets(&self, replay_end: f64, length: f64) -> Result<(f64, f64), String> {
        if length <= 0. || !length.is_finite() {
            return Err("Could not read the OBS replay duration.".into());
        }
        let origin = replay_end - length;
        if self.selected.time_epoch < origin {
            return Err(
                "The line is older than the replay buffer, so its clip can no longer be saved."
                    .into(),
            );
        }
        let (start, end) = self.bounds();
        let (start, end) = ((start - origin).max(0.), (end - origin).min(length));
        if end <= start {
            return Err("The selected line is outside this OBS replay.".into());
        }
        Ok((start, end))
    }
    pub fn entries(&self, start: f64, end: f64) -> Vec<Value> {
        self.lines()
            .filter(|(line, role)| *role == "selected" || (start..=end).contains(&line.time_epoch))
            .map(|(line, role)| {
                json!({
                    "id": line.id,
                    "text": line.text,
                    "time": local_time(line.time_epoch).format("%Y-%m-%dT%H:%M:%S%.6f").to_string(),
                    "role": role,
                    "scene": line.scene,
                    "source": line.source,
                    "source_padding": line.effective_padding()
                })
            })
            .collect()
    }
    fn folder_prefix(&self, root: &Path) -> (PathBuf, String) {
        let date = local_time(
            self.selected
                .first_seen_time_epoch
                .unwrap_or(self.selected.time_epoch),
        );
        (
            root.join(date.format("%Y-%m-%d").to_string()),
            date.format("%H-%M-%S-%3f_").to_string(),
        )
    }
    pub fn existing(&self, root: &Path) -> Option<PathBuf> {
        let (day, prefix) = self.folder_prefix(root);
        directories(&day).into_iter().find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|s| s.starts_with(&prefix))
                && selects(p, &self.selected.id)
        })
    }
    pub fn save(
        &self,
        root: &Path,
        replay: &Path,
        media: &MediaTools,
        history: &PauseHistory,
    ) -> Result<PathBuf, String> {
        if let Some(folder) = self.existing(root) {
            return Ok(folder);
        }
        let replay_end =
            file_mtime_epoch(replay).ok_or("Could not read OBS replay modification time")?;
        let length = media.get_video_duration(replay);
        let (start, end) = self.offsets(replay_end, length)?;
        let (day, prefix) = self.folder_prefix(root);
        let err = |e: io::Error| e.to_string();
        fs::create_dir_all(&day).map_err(err)?;
        let staged = tempfile::Builder::new()
            .prefix(".gsm-clip-writing-")
            .tempdir_in(&day)
            .map_err(err)?;
        let name = format!(
            "clip.{}",
            replay
                .extension()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("mkv")
        );
        let video = staged.path().join(&name);
        let actual = media
            .copy_replay_segment(replay, start, end, &video)
            .ok_or("FFmpeg could not copy the selected replay segment")?;
        let clip_length = media.get_video_duration(&video);
        if clip_length <= 0. {
            return Err("FFmpeg produced an empty clip".into());
        }
        let clip_start = replay_end - length + actual;
        let clip_end = clip_start + clip_length;
        let modified = Duration::try_from_secs_f64(clip_end)
            .ok()
            .and_then(|t| UNIX_EPOCH.checked_add(t))
            .ok_or("Invalid clip timestamp")?;
        fs::OpenOptions::new()
            .write(true)
            .open(&video)
            .and_then(|f| f.set_modified(modified))
            .map_err(err)?;
        let manifest = json!({"lines":self.entries(clip_start,clip_end),"clip":{"file":name,
            "end_time":local_time(clip_end).format("%Y-%m-%dT%H:%M:%S%.6f").to_string()},"pauses":history.get_pauses_between(clip_start,clip_end)});
        let manifest_path = staged.path().join("ready.json");
        fs::write(&manifest_path, manifest.to_string()).map_err(err)?;

        let label = sanitize_filename(self.selected.text.trim())
            .chars()
            .take(32)
            .collect::<String>();
        let label = if label.trim().is_empty() {
            "line"
        } else {
            label.trim()
        };
        let stem = format!("{prefix}{label}");
        let mut folder = day.join(&stem);
        for suffix in 2.. {
            match fs::create_dir(&folder) {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    folder = day.join(format!("{stem}_{suffix}"))
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        // A manifest is the commit marker. Interrupted exports never appear as saved clips.
        let final_video = folder.join(name);
        if let Err(e) = fs::rename(&video, &final_video) {
            let _ = fs::remove_dir(&folder);
            return Err(e.to_string());
        }
        if let Err(e) = fs::rename(manifest_path, folder.join(MANIFEST_NAME)) {
            let _ = fs::remove_file(final_video);
            let _ = fs::remove_dir(&folder);
            return Err(e.to_string());
        }
        Ok(folder)
    }
}
