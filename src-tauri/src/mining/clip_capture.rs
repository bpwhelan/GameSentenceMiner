use super::MiningService;
use crate::text_intake::Intake;
use gsm_mining::{
    clips::{find_saved_folder, ClipWindow},
    ffmpeg::{wait_for_stable_file_async, MediaTools},
    gateway::StatusCode,
    text::now_epoch,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::{
    sync::{watch, Semaphore},
    time::Instant,
};

pub(super) struct Saves {
    pending: Mutex<HashSet<String>>,
    // Copy one replay at a time, after OBS captures each requested line.
    pub(super) extraction: Semaphore,
}
impl Default for Saves {
    fn default() -> Self {
        Self {
            pending: Default::default(),
            extraction: Semaphore::new(1),
        }
    }
}

pub(super) fn queue(
    app: &AppHandle,
    root: Option<&Path>,
    body: &Value,
    remove_video: bool,
) -> (StatusCode, Value) {
    let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, json!({"error":"Missing id"}));
    };
    let Some(root) = root else {
        return missing_output(app);
    };
    let intake = app.state::<Intake>();
    let changes = intake.clip_updates();
    let window = intake.clip_window(app, id, true);
    let existing = match &window {
        Some(window) => window.existing(root),
        None => find_saved_folder(root, id),
    };
    if let Some(folder) = existing {
        return (
            StatusCode::OK,
            json!({"queued":false,"already_saved":true,"line_ids":[id],"folder":folder}),
        );
    }
    let Some(window) = window else {
        return (StatusCode::BAD_REQUEST, json!({"error":"Invalid id"}));
    };
    let service = app.state::<Arc<MiningService>>().inner().clone();
    let wait = Duration::from_secs_f64(window.wait_seconds(now_epoch()));
    let reply = json!({"queued":true,"line_ids":[id],"wait_seconds":wait.as_secs_f64()});
    {
        let mut pending = service.clip_saves.pending.lock().unwrap();
        if pending.contains(id) {
            return (StatusCode::OK, reply);
        }
        if pending.len() >= 256 {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error":"Clip save queue is full"}),
            );
        }
        pending.insert(id.to_owned());
    }
    let app = app.clone();
    let root = root.to_owned();
    let id = id.to_owned();
    tauri::async_runtime::spawn(async move {
        let result = capture(&app, &service, root, window, changes, wait, remove_video).await;
        service.clip_saves.pending.lock().unwrap().remove(&id);
        let event = match result {
            Ok(folder) => json!({"event":"clip_saved","line_ids":[id],"folder":folder}),
            Err(error) => {
                crate::desktop_log::warn(&app, "clips", &error);
                json!({"event":"clip_save_failed","line_ids":[id],"error":error})
            }
        };
        app.state::<Intake>().clip_event(&event);
    });
    (StatusCode::OK, reply)
}

pub(super) fn missing_output(app:&AppHandle)->(StatusCode,Value) {
    let app=app.clone();
    tauri::async_runtime::spawn(async move {
        let _=crate::gui_dialog::open(&app,crate::gui_dialog::Dialog::Settings{
            root_tab_key:"general".into(),subtab_key:"paths".into(),
        }).await;
    });
    (StatusCode::BAD_REQUEST,json!({"error":"No output folder is set. Set an Output Folder in the Paths settings, then try again.","open_settings":true}))
}

async fn capture(
    app: &AppHandle,
    service: &MiningService,
    root: PathBuf,
    mut window: ClipWindow,
    mut changes: watch::Receiver<()>,
    wait: Duration,
    remove_video: bool,
) -> Result<PathBuf, String> {
    let deadline = Instant::now() + wait;
    loop {
        let remaining = Duration::from_secs_f64(window.wait_seconds(now_epoch()))
            .min(deadline.saturating_duration_since(Instant::now()));
        if remaining.is_zero() {
            break;
        }
        tokio::select! {
            _=tokio::time::sleep(remaining)=>break,
            result=changes.changed()=>if result.is_err(){return Err("Text Feed closed".into());}
        }
        if let Some(current) = app
            .state::<Intake>()
            .clip_window(app, &window.selected.id, false)
        {
            window = current;
        }
    }
    let replay = save_stable_replay(app).await?;
    if let Some(current) = app
        .state::<Intake>()
        .clip_window(app, &window.selected.id, false)
    {
        window = current;
    }
    let _slot = service
        .clip_saves
        .extraction
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let pause = service.pause_history.clone();
    let shared = app
        .state::<crate::settings::Settings>()
        .paths
        .shared
        .clone();
    let temp = service.temp_dir();
    tauri::async_runtime::spawn_blocking(move || {
        let media = MediaTools::discover(Some(&shared), temp);
        let result = window.save(&root, &replay, &media, &pause)?;
        if remove_video {
            // A published clip is independent of its temporary OBS replay.
            let _ = std::fs::remove_file(&replay);
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(super) async fn save_stable_replay(app: &AppHandle) -> Result<PathBuf, String> {
    let saved = app
        .state::<crate::obs::Obs>()
        .save_replay(app)
        .await
        .map_err(|e| format!("Could not save the OBS replay: {e}"))?;
    let replay = PathBuf::from(
        saved["savedReplayPath"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("OBS did not return a saved replay path")?,
    );
    if !wait_for_stable_file_async(
        replay.clone(),
        Duration::from_secs(10),
        Duration::from_millis(100),
    )
    .await
    {
        return Err("OBS replay did not finish writing".into());
    }
    Ok(replay)
}
