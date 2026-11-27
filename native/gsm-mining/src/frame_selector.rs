use crate::{
    config::ProfileConfig,
    ffmpeg::{first_video_stream, fraction_to_f64, MediaTools},
};
use serde::Serialize;
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tempfile::TempPath;
use tokio::sync::watch;

const PER_PAGE: i64 = 25;
const STEP: f64 = 0.5;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Position {
    pub index: i64,
    pub seconds: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub reference: f64,
    first: i64,
    min: i64,
    max: i64,
}

impl Layout {
    pub fn probe(
        media: &MediaTools,
        path: &Path,
        reference: f64,
        mode: &str,
    ) -> Result<Self, String> {
        let info = media.probe_replay(path).ok_or("Cannot read recording")?;
        let duration = info["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .ok_or("Unknown recording duration")?;
        let rate = first_video_stream(&info)
            .and_then(|stream| stream.get("avg_frame_rate"))
            .map(fraction_to_f64)
            .unwrap_or(30.0);
        Self::new(duration, rate, reference, mode)
    }
    pub fn new(duration: f64, fps: f64, reference: f64, mode: &str) -> Result<Self, String> {
        if !duration.is_finite()
            || duration <= 0.0
            || duration > i64::MAX as f64 * STEP
            || !reference.is_finite()
        {
            return Err("Invalid recording duration or screenshot timestamp".into());
        }
        let fps = if fps.is_finite() && fps > 0.0 {
            fps
        } else {
            30.0
        };
        let last = (duration - 1.0 / fps).max(0.0);
        let reference = reference.clamp(0.0, last);
        let min = (-reference / STEP).ceil() as i64;
        let max = ((last - reference) / STEP + 1e-9).floor() as i64;
        let offset = match mode {
            "middle" => PER_PAGE / 2,
            "end" => PER_PAGE - 1,
            _ => 0,
        };
        let first = min.max((-offset).min(max - PER_PAGE + 1));
        Ok(Self {
            reference,
            first,
            min,
            max,
        })
    }
    pub fn page(&self, page: i64) -> Vec<Position> {
        let Some(first) = page
            .checked_mul(PER_PAGE)
            .and_then(|p| p.checked_add(self.first))
        else {
            return Vec::new();
        };
        (first.max(self.min)
            ..first
                .saturating_add(PER_PAGE)
                .min(self.max.saturating_add(1)))
            .map(|index| Position {
                index,
                seconds: self.reference + index as f64 * STEP,
            })
            .collect()
    }
}

pub struct Preview {
    pub position: Position,
    pub path: TempPath,
}

/// A page uses a single seek. Switching pages terminates an obsolete decoder
/// before its temporary frames are removed, including on Windows.
pub async fn decode_page(
    media: &MediaTools,
    config: &ProfileConfig,
    video: &Path,
    positions: &[Position],
    directory: &Path,
    mut cancel: watch::Receiver<u64>,
    generation: u64,
) -> Result<Vec<Arc<Preview>>, String> {
    let first = positions.first().ok_or("No frames on this page")?;
    if positions.len() > PER_PAGE as usize {
        return Err("Too many frames on a page".into());
    }
    if *cancel.borrow_and_update() != generation {
        return Err("Screenshot page superseded".into());
    }
    let mut filters = vec!["fps=2:start_time=0:round=up:eof_action=pass".to_string()];
    if config.screenshot.trim_black_bars_wip {
        let media = media.clone();
        let video = video.to_path_buf();
        let seconds = first.seconds;
        let crop = tokio::task::spawn_blocking(move || media.find_black_bars(&video, seconds))
            .await
            .map_err(|e| e.to_string())?;
        filters.extend(crop);
    }
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    let frames = positions
        .iter()
        .enumerate()
        .map(|(i, &position)| {
            let path =
                TempPath::try_from_path(directory.join(format!("{prefix}_{:02}.png", i + 1)))?;
            Ok::<_, std::io::Error>(Arc::new(Preview { position, path }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut errors = tempfile::tempfile_in(directory).map_err(|e| e.to_string())?;
    let mut command = tokio::process::Command::new(&media.ffmpeg);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-ss",
            &format!("{:.6}", first.seconds),
            "-i",
        ])
        .arg(video)
        .args([
            "-an",
            "-vf",
            &filters.join(","),
            "-frames:v",
            &positions.len().to_string(),
            "-fps_mode",
            "vfr",
            "-compression_level",
            "1",
            "-threads",
            "2",
        ])
        .arg(directory.join(format!("{prefix}_%02d.png")))
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(errors.try_clone().map_err(|e| e.to_string())?);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let status = tokio::select! {
        result=child.wait()=>result.map_err(|e|e.to_string())?,
        _=cancel.changed()=>{ let _=child.kill().await;return Err("Screenshot page superseded".into());},
        _=tokio::time::sleep(Duration::from_secs(60))=>{ let _=child.kill().await;return Err("Screenshot decoding timed out".into());},
    };
    if !status.success() {
        let len = errors.metadata().map_err(|e| e.to_string())?.len();
        errors
            .seek(SeekFrom::Start(len.saturating_sub(2048)))
            .map_err(|e| e.to_string())?;
        let mut message = Vec::new();
        errors
            .read_to_end(&mut message)
            .map_err(|e| e.to_string())?;
        return Err(format!(
            "FFmpeg could not decode the screenshot page: {}",
            String::from_utf8_lossy(&message).trim()
        ));
    }
    if !frames.iter().all(|f| f.path.is_file()) {
        return Err("The recording ended before the requested frames were decoded".into());
    }
    Ok(frames)
}

/// Outputs remain owned by the caller until the entire selection is delivered.
pub struct Export {
    pub items: Vec<(PathBuf, f64)>,
}
impl Drop for Export {
    fn drop(&mut self) {
        for (path, _) in &self.items {
            let _ = std::fs::remove_file(path);
        }
    }
}
impl Export {
    pub fn release(mut self) -> Vec<(PathBuf, f64)> {
        std::mem::take(&mut self.items)
    }
}
pub fn export(
    media: &MediaTools,
    config: &ProfileConfig,
    choices: &[Arc<Preview>],
    cancelled: impl Fn() -> bool,
) -> Result<Export, String> {
    if choices.is_empty() {
        return Err("Select at least one screenshot".into());
    }
    let mut output = Export {
        items: Vec::with_capacity(choices.len()),
    };
    for frame in choices {
        if cancelled() {
            return Err("Screenshot selection cancelled".into());
        }
        let dest = media.temp_dir.join(format!(
            "selector_{}.{}",
            uuid::Uuid::new_v4().simple(),
            config.screenshot.extension
        ));
        let path = media.encode_screenshot(
            &frame.path,
            None,
            None,
            Some(&dest),
            true,
            "selector",
            config,
        );
        if path.as_ref().ok() != Some(&dest) {
            let _ = std::fs::remove_file(&dest);
        }
        let path = path?;
        output.items.push((path.clone(), frame.position.seconds));
        if !path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0) {
            return Err("Screenshot export produced an empty file".into());
        }
    }
    if cancelled() {
        return Err("Screenshot selection cancelled".into());
    }
    Ok(output)
}
