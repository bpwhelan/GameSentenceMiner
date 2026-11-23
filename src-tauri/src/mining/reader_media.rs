use super::{clip_capture::save_stable_replay, MiningService};
use crate::{settings::Settings, text_intake::Intake};
use gsm_mining::{
    clips::{get_clips_root, saved_selections},
    config::ProfileConfig,
    ffmpeg::MediaTools,
    gateway::StatusCode,
    reader_media::LineReplay,
    text::{now_epoch, GameLine},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::SystemTime,
};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Semaphore};

pub(super) struct Exports {
    last: Mutex<Option<(Vec<String>, Arc<ObsReplay>)>>,
    pub(super) queue: Arc<Semaphore>,
}

impl Default for Exports {
    fn default() -> Self {
        Self {
            last: Mutex::default(),
            queue: Arc::new(Semaphore::new(64)),
        }
    }
}

struct ObsReplay {
    path: PathBuf,
    stamp: (SystemTime, u64),
    remove_after_use: AtomicBool,
}

fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = path.metadata().ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

impl Drop for ObsReplay {
    fn drop(&mut self) {
        if self.remove_after_use.load(Ordering::Relaxed) && stamp(&self.path) == Some(self.stamp) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Exports {
    async fn replay(&self, app: &AppHandle, ids: &[String]) -> Result<Arc<ObsReplay>, String> {
        let mut last = self.last.lock().await;
        if let Some((key, replay)) = last.as_ref() {
            if key == ids && stamp(&replay.path) == Some(replay.stamp) {
                return Ok(replay.clone());
            }
        }
        let path = save_stable_replay(app).await?;
        let stamp = stamp(&path).ok_or("OBS replay disappeared")?;
        if let Some((key, replay)) = last.as_mut() {
            if replay.path == path && replay.stamp == stamp {
                *key = ids.to_vec();
                return Ok(replay.clone());
            }
        }
        let replay = Arc::new(ObsReplay {
            path,
            stamp,
            remove_after_use: false.into(),
        });
        *last = Some((ids.to_vec(), replay.clone()));
        Ok(replay)
    }
}

pub(crate) struct Selection {
    pub(super) line: GameLine,
    pub(super) next: Option<f64>,
    saved: Option<(PathBuf, f64)>,
}

pub(super) fn select(
    app: &AppHandle,
    service: &MiningService,
    config: &ProfileConfig,
    id: &str,
) -> Option<Selection> {
    select_many(app, service, config, &[id]).pop()
}

pub(crate) fn select_many(
    app: &AppHandle,
    service: &MiningService,
    config: &ProfileConfig,
    ids: &[&str],
) -> Vec<Selection> {
    let live = app.state::<Intake>().media_lines(app, ids);
    let cutoff = now_epoch() - config.obs.replay_buffer_duration_seconds as f64;
    let missing = ids
        .iter()
        .zip(&live)
        .filter(|(_, row)| {
            row.as_ref()
                .is_none_or(|(line, _)| line.time_epoch < cutoff)
        })
        .map(|(&id, _)| id)
        .collect::<std::collections::HashSet<_>>();
    let root = if missing.is_empty() {
        None
    } else {
        get_clips_root(config).and_then(|p| p.canonicalize().ok())
    };
    let saved = root
        .as_ref()
        .map(|p| saved_selections(p, missing))
        .unwrap_or_default();
    ids.iter()
        .copied()
        .zip(live)
        .filter_map(|(id, live)| {
            let archived = saved.get(id).and_then(|clip| {
                let folder = clip.folder.canonicalize().ok()?;
                let path = clip.clip_path.canonicalize().ok()?;
                if !folder.starts_with(root.as_ref()?)
                    || !path.starts_with(folder)
                    || !path.is_file()
                {
                    return None;
                }
                let i = clip.lines.iter().position(|line| line.id == id)?;
                service.pause_history.remember_pauses(&clip.pauses);
                Some(Selection {
                    line: clip.lines[i].clone(),
                    next: clip.lines.get(i + 1).map(|l| l.time_epoch),
                    saved: Some((path, clip.clip_end_epoch)),
                })
            });
            archived.or_else(|| {
                live.map(|(line, next)| Selection {
                    line,
                    next,
                    saved: None,
                })
            })
        })
        .collect()
}

pub(crate) fn queue(app: &AppHandle, path: &str, body: &Value) -> (StatusCode, Value) {
    let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, json!({"error":"Missing id"}));
    };
    let service = app.state::<Arc<MiningService>>().inner().clone();
    let config = match service.load_config() {
        Ok(config) => config,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, json!({"error":error})),
    };
    let Some(selection) = select(app, &service, &config, id) else {
        return (StatusCode::BAD_REQUEST, json!({"error":"Invalid id"}));
    };
    let Ok(permit) = service.exports.queue.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"Media export queue is full"}),
        );
    };
    let use_vad = body["trim_with_vad"].as_bool().unwrap_or(false);
    let reveal = body["show_in_explorer"].as_bool().unwrap_or(true);
    let screenshot = path == "/get-screenshot";
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let result = if screenshot {
            open_screenshot(&app, &service, config, selection).await
        } else {
            export_video(&app, &service, config, selection, use_vad, reveal).await
        };
        if let Err(error) = result {
            crate::desktop_log::warn(&app, "media export", &error);
        }
    });
    (
        StatusCode::OK,
        if screenshot {
            json!({})
        } else {
            json!({"queued":true,"line_id":id})
        },
    )
}

async fn open_screenshot(
    app: &AppHandle,
    service: &MiningService,
    config: ProfileConfig,
    selection: Selection,
) -> Result<(), String> {
    let input = selection.acquire(app, service).await?;
    let media = MediaTools::discover(
        Some(&app.state::<Settings>().paths.shared),
        service.temp_dir(),
    );
    let path = input.path.clone();
    let mode = config.screenshot.screenshot_timing_setting.clone();
    let remove = config.paths.remove_video;
    let (start, input) = tauri::async_runtime::spawn_blocking(move || {
        let replay = input.line_replay(&selection);
        let t = media.get_screenshot_time(
            replay.path,
            Some(replay.line),
            replay.next_line_time,
            false,
            replay.recording_end,
            &config,
        );
        (t, input)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(export) = crate::screenshot_selector::open(app, path, start, Some(mode)).await? {
        let files = export.release();
        crate::native::shell_open_path(&files.first().ok_or("No screenshot was exported")?.0)?;
    }
    input.finished(remove);
    Ok(())
}

async fn export_video(
    app: &AppHandle,
    service: &MiningService,
    config: ProfileConfig,
    selection: Selection,
    use_vad: bool,
    reveal: bool,
) -> Result<(), String> {
    let input = selection.acquire(app, service).await?;
    let _slot = service
        .clip_saves
        .extraction
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let shared = app.state::<Settings>().paths.shared.clone();
    let temp = service.temp_dir();
    let pauses = service.pause_history.clone();
    let vad = service.vad.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let media = MediaTools::discover(Some(&shared), temp);
        let replay = input.line_replay(&selection);
        let output = replay.export_video(
            &media,
            &config,
            &pauses,
            &vad,
            use_vad,
            chrono::Local::now(),
        )?;
        input.finished(config.paths.remove_video);
        if reveal {
            crate::native::shell_reveal(&output)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(super) struct Input {
    pub(super) path: PathBuf,
    end: Option<f64>,
    obs: Option<Arc<ObsReplay>>,
}

impl Selection {
    pub(super) async fn acquire(
        &self,
        app: &AppHandle,
        service: &MiningService,
    ) -> Result<Input, String> {
        if let Some((path, end)) = &self.saved {
            return Ok(Input {
                path: path.clone(),
                end: Some(*end),
                obs: None,
            });
        }
        let obs = service
            .exports
            .replay(app, std::slice::from_ref(&self.line.id))
            .await?;
        Ok(Input {
            path: obs.path.clone(),
            end: None,
            obs: Some(obs),
        })
    }
}

impl Input {
    pub(super) async fn for_group(
        app: &AppHandle,
        service: &MiningService,
        lines: &[Selection],
    ) -> Result<Self, String> {
        let first = lines
            .first()
            .ok_or("No line available to create media for.")?;
        if lines.len() == 1 || first.saved.is_some() && lines.iter().all(|s| s.saved == first.saved)
        {
            return first.acquire(app, service).await;
        }
        let ids = lines.iter().map(|s| s.line.id.clone()).collect::<Vec<_>>();
        let obs = service.exports.replay(app, &ids).await?;
        Ok(Self {
            path: obs.path.clone(),
            end: None,
            obs: Some(obs),
        })
    }
    pub(super) fn line_replay<'a>(&'a self, selection: &'a Selection) -> LineReplay<'a> {
        LineReplay {
            path: &self.path,
            recording_end: self.end,
            line: &selection.line,
            next_line_time: selection.next,
        }
    }
    pub(super) fn finished(&self, remove: bool) {
        if let Some(obs) = self.obs.as_ref().filter(|_| remove) {
            obs.remove_after_use.store(true, Ordering::Relaxed);
        }
    }
}
