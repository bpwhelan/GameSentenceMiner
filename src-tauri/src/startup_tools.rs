use crate::{install_session::InstallSessions, settings::Settings};
use gsm_packages::install_session::Lease;
use serde_json::{json, Value};
use std::{
    cell::Cell,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub async fn prepare(app: &AppHandle, lease: Option<Lease>) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let shared = &app.state::<Settings>().paths.shared;
        let sessions = app.state::<InstallSessions>();
        let report = |stage: &str, mut update: Value| {
            if let Some(lease) = &lease {
                update["stageId"] = json!(stage);
                let _ = sessions.model.update(lease, &update);
                sessions.notify();
            }
        };
        for (stage, label) in [("ffmpeg", "FFmpeg"), ("oneocr", "OneOCR")] {
            report(stage, json!({"status":"running","progressKind":"indeterminate","message":format!("Checking {label} runtime files...")}));
            let last = Cell::new(None::<Instant>);
            let progress = |done: u64, total: Option<u64>| {
                if lease.is_none() || (Some(done) != total && last.get().is_some_and(|t| t.elapsed() < Duration::from_millis(200))) {
                    return;
                }
                last.set(Some(Instant::now()));
                report(stage, json!({"status":"running","progressKind":"bytes","message":format!("Downloading {label}..."),
                    "progress":total.filter(|&n| n != 0).map(|n| done as f64 / n as f64),"downloadedBytes":done,"totalBytes":total}));
            };
            let result = if stage == "ffmpeg" {
                gsm_packages::ffmpeg::ensure_windows(shared, &progress)
            } else {
                gsm_overlay::models::oneocr::directory()
                    .and_then(|root| gsm_overlay::models::oneocr::prepare(&root, &progress))
                    .map_err(|e| format!("{e:#}"))
            };
            match result {
                Ok(installed) => report(stage, json!({"status":if installed { "completed" } else { "skipped" }, "progress":1,"message":format!("{label} runtime is ready.")})),
                Err(error) => {
                    let message = format!("{label} installation failed: {error}");
                    report(stage, json!({"status":"failed","error":error,"message":message}));
                    return Err(message);
                }
            }
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
