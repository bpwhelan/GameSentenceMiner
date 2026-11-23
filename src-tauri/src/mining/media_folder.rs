use super::{
    clip_capture::missing_output,
    reader_media::{select_many, Input, Selection},
    MiningService,
};
use crate::{settings::Settings, text_intake::Intake};
use gsm_mining::{config::ProfileConfig, ffmpeg::MediaTools, gateway::StatusCode};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager};

pub(crate) fn queue(app: &AppHandle, body: &Value) -> (StatusCode, Value) {
    let service = app.state::<Arc<MiningService>>().inner().clone();
    let config = match service.load_config() {
        Ok(c) => c,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, json!({"error":error})),
    };
    if config.paths.output_folder.trim().is_empty() {
        return missing_output(app);
    }
    let ids = body["ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    let mut lines = select_many(app, &service, &config, &ids);
    if lines.is_empty() {
        let defaults = app.state::<Intake>().default_media_ids();
        lines = select_many(
            app,
            &service,
            &config,
            &defaults.iter().map(String::as_str).collect::<Vec<_>>(),
        );
    }
    if lines.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            json!({"error":"No line available to create media for."}),
        );
    }
    let Ok(permit) = service.exports.queue.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"Media export queue is full"}),
        );
    };
    let reply = json!({"queued":true,"count":lines.len()});
    let use_vad = body["trim_with_vad"].as_bool().unwrap_or(false);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let result = create(&app, &service, config, lines, use_vad)
            .await
            .and_then(|path| crate::native::shell_open_path(&path));
        if let Err(error) = result {
            crate::desktop_log::warn(&app, "media export", &error);
        }
    });
    (StatusCode::OK, reply)
}

pub(crate) async fn create(
    app: &AppHandle,
    service: &MiningService,
    config: ProfileConfig,
    lines: Vec<Selection>,
    use_vad: bool,
) -> Result<PathBuf, String> {
    let first = lines.first().ok_or("No lines selected")?;
    let now = chrono::Local::now();
    let full_text = lines
        .iter()
        .map(|s| s.line.text.as_str())
        .collect::<String>();
    let folder = gsm_mining::reader_folder::Folder::new(
        Path::new(&config.paths.output_folder),
        &full_text,
        now,
    )?;
    let input = Input::for_group(app, service, &lines).await?;
    let media = MediaTools::discover(
        Some(&app.state::<Settings>().paths.shared),
        service.temp_dir(),
    );
    if config.screenshot.enabled {
        let tools = media.clone();
        let replay = input.line_replay(first);
        let (video, end, line, next) = (
            replay.path.to_owned(),
            replay.recording_end,
            first.line.clone(),
            first.next,
        );
        let settings = config.clone();
        let timestamp = tauri::async_runtime::spawn_blocking(move || {
            tools.get_screenshot_time(&video, Some(&line), next, false, end, &settings)
        })
        .await
        .map_err(|e| e.to_string())?;
        match crate::screenshot_selector::open(
            app,
            input.path.clone(),
            timestamp,
            Some(config.screenshot.screenshot_timing_setting.clone()),
        )
        .await
        {
            Ok(Some(exports)) => {
                for (file, _) in &exports.items {
                    if let Err(error) = folder.screenshot(file) {
                        crate::desktop_log::warn(app, "media export", &error);
                    }
                }
            }
            Ok(None) => {}
            Err(error) => crate::desktop_log::warn(app, "media export", &error),
        }
    }
    let _slot = service
        .clip_saves
        .extraction
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let models = service.vad.clone();
    let pauses = service.pause_history.clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let first = &lines[0];
        let last = lines.last().unwrap();
        let cutoff = last
            .next
            .filter(|&n| last.line.mined_time_epoch.is_some_and(|mined| n < mined));
        let destination = folder.finish(
            input.line_replay(first),
            cutoff,
            &media,
            &config,
            &pauses,
            &models,
            use_vad,
            |e| crate::desktop_log::warn(&app, "media export", &e),
        )?;
        input.finished(config.paths.remove_video);
        Ok(destination)
    })
    .await
    .map_err(|e| e.to_string())?
}
