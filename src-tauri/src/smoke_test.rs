//! Native Rust smoke verification runner for `GSM_SMOKE_TEST=1`.
//! Executes end-to-end desktop, runtime, dictionary, legacy transfer, and overlay
//! checks directly inside the Tauri process without spawning `node.exe`.

use crate::desktop_state::DesktopState;
use crate::dictionary_host::{
    apply_profile_data_directory, apply_shared_webview_options, evaluate_raw, overlay_data_path,
    use_windows_native_extensions, DictionaryManager,
};
use crate::overlay_host::{OVERLAY_MAIN_LABEL, OVERLAY_SETTINGS_LABEL};
use crate::reader_service::{DICTIONARY_SEARCH_LABEL, LOOKUP_PAGE_LABEL};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const DOCUMENT_ID: &str = "(document.__gsmSmokeDocumentId ??= crypto.randomUUID())";

#[path = "smoke/memory.rs"]
mod memory;
#[path = "smoke/archive_files.rs"]
mod archive_files;

#[path = "smoke/longplay.rs"]
mod longplay;
#[path = "smoke/pythonless.rs"]
mod pythonless;
#[path = "smoke/qt_settings.rs"]
mod qt_settings;

#[path = "smoke/model_settings.rs"]
mod model_settings;
#[path = "smoke/anki_grouping.rs"]
mod anki_grouping;
#[path = "smoke/card_review.rs"]
mod card_review;

#[cfg(windows)]
#[path = "smoke/speech.rs"]
mod speech;

#[path = "smoke/frame_selector.rs"]
mod frame_selector;

#[cfg(windows)]
pub fn own_process_tree() -> windows::core::Result<()> {
    use windows::{
        core::{Owned, PCWSTR},
        Win32::System::{JobObjects::*, Threading::GetCurrentProcess},
    };

    // WebView2 can open extension windows that Tauri does not own. Tie them to
    // the isolated test process even when the runner kills it after a timeout.
    unsafe {
        let job = Owned::new(CreateJobObjectW(None, PCWSTR::null())?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            *job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )?;
        AssignProcessToJobObject(*job, GetCurrentProcess())?;

        // This handle is not inherited. Windows closes it when the host exits.
        std::mem::forget(job);
    }
    Ok(())
}

#[cfg(windows)]
pub fn stage_jiten_extension(source: &Path, profile: &Path) -> Result<PathBuf, String> {
    let fixture = profile.join("test-extensions").join("jiten.reader");
    crate::dictionary_host::copy_dir_recursive(source, &fixture)?;
    let manifest = crate::dictionary_host::read_manifest(&fixture)?;
    let worker = manifest["background"]["service_worker"]
        .as_str()
        .ok_or("Jiten smoke fixture is missing its service worker")?;
    let worker = fixture.join(worker);
    let source = std::fs::read_to_string(&worker).map_err(|e| e.to_string())?;
    // An extension's first-install handler opens an unmanaged WebView2 window.
    // Keep its startup logic active while the smoke check opens its own page.
    std::fs::write(
        worker,
        format!("'use strict';\nchrome.runtime.openOptionsPage = async () => {{}};\n{source}"),
    )
    .map_err(|e| e.to_string())?;
    Ok(fixture)
}

pub fn spawn_if_requested(app: AppHandle) {
    let Some(result_path) = std::env::var_os("GSM_TEST_RESULT").map(PathBuf::from) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let outcome = run_smoke(&app).await;
        for window in app.webview_windows().into_values() {
            let _ = window.destroy();
        }
        let (code, payload) = match outcome {
            Ok(detail) => (0, json!({ "code": 0, "detail": detail })),
            Err(err) => {
                eprintln!("[smoke] FAILED: {err}");
                (1, json!({ "code": 1, "error": err }))
            }
        };
        if let Some(parent) = result_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&result_path, payload.to_string());
        app.exit(code);
    });
}

async fn wait_window_ready(
    app: &AppHandle,
    label: &str,
    timeout: Duration,
) -> Result<WebviewWindow, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(win) = app.get_webview_window(label) {
            if let Ok(Ok(val)) = tokio::time::timeout(
                Duration::from_millis(800),
                evaluate_raw(app, &win, "document.readyState === 'complete'"),
            )
            .await
            {
                if val.as_bool() == Some(true) {
                    return Ok(win);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(75)).await;
    }
    Err(format!(
        "Timed out waiting for window {label} to become ready"
    ))
}

async fn wait_overlay_dictionary(app: &AppHandle) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(45), async {
        while app.state::<crate::overlay_host::OverlayHost>().status()["dictionaryReady"] != true {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.map_err(|_| "Overlay dictionary did not become ready".to_owned())
}

async fn wait_hub_visibility(app: &AppHandle, visible: bool) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let handle = app.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                let result = handle
                    .get_webview_window(crate::app_lifecycle::HUB_WINDOW_LABEL)
                    .ok_or_else(|| "Closing the hub destroyed it".to_owned())
                    .and_then(|hub| hub.is_visible().map_err(|e| e.to_string()));
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
            if rx.await.map_err(|e| e.to_string())?? == visible {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| format!("Hub stopped responding while waiting for visible={visible}"))?
}

async fn smoke_close_to_tray(app: &AppHandle, hub: &WebviewWindow) -> Result<(), String> {
    service_call(
        app,
        "settings.saveSettings",
        &[json!({"quitOnWindowClose":false})],
    )
    .await?;
    crate::tray::ensure_created(app)?;
    // Native dictionary installation reloads the first Home document once.
    // Finish that startup work before asserting that tray hiding preserves it.
    crate::reader_service::attach_home_dictionary(app, hub.label()).await?;
    let mut previous_document = Value::Null;
    let mut stable = 0;
    for _ in 0..100 {
        let document = evaluate_raw(app, hub, &format!("document.readyState === 'complete' ? {DOCUMENT_ID} : null")).await?;
        if !document.is_null() && document == previous_document {
            stable += 1;
            if stable == 3 { break; }
        } else {
            stable = 0;
        }
        previous_document = document;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if stable < 3 { return Err("Home dictionary initialization did not settle".into()); }
    evaluate_raw(app, hub, "window.__gsmCloseToTrayCount = 0").await?;

    crate::tray::show_main_window(app);
    wait_hub_visibility(app, true).await?;
    // First close exercises the still-running notification; the second skips it.
    for cycle in 1..=2 {
        eprintln!("[smoke] Closing hub to tray (cycle {cycle})");
        hub.close().map_err(|e| e.to_string())?;
        wait_hub_visibility(app, false).await?;
        // Exercise both immediate reuse and the browser's reduced-memory state.
        if cycle == 2 { tokio::time::sleep(Duration::from_secs(16)).await; }
        if app
            .state::<DesktopState>()
            .quitting
            .load(std::sync::atomic::Ordering::SeqCst)
            || app.tray_by_id(crate::tray::CANONICAL_TRAY_ID).is_none()
        {
            return Err("Closing the hub stopped GSM or removed its tray icon".into());
        }
        crate::tray::show_main_window(app);
        wait_hub_visibility(app, true).await?;
        let count = evaluate_raw(app, hub, "++window.__gsmCloseToTrayCount").await?;
        if count != json!(cycle) {
            return Err(format!("Reopening the hub lost its renderer state: cycle {cycle}, count {count}"));
        }
        if evaluate_raw(app, hub, DOCUMENT_ID).await? != previous_document {
            return Err("Reopening the hub reloaded its document".into());
        }
    }
    #[cfg(windows)]
    crate::windows_notifications::close_all(app);
    Ok(())
}

async fn wait_for_jobs(app: &AppHandle, names: &'static [&'static str]) -> Result<(), String> {
    let database = app.state::<crate::settings::Settings>().paths.active.join("gsm.db");
    let history = app.state::<std::sync::Arc<gsm_history::History>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let generation = history.generation().map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let now = chrono::Local::now().timestamp() as f64;
        loop {
            let jobs = history.scheduled_jobs(&database, generation).map_err(|e| e.to_string())?;
            if names.iter().all(|&name| jobs.iter().any(|job| job.name == name && job.deadline > now)) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("Scheduled jobs did not finish: {names:?}"));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }).await.map_err(|e| e.to_string())?
}

async fn run_smoke(app: &AppHandle) -> Result<Value, String> {
    if std::env::var_os("GSM_PROFILE_DIR").is_none() {
        return Err("Native smoke tests require an isolated GSM_PROFILE_DIR".into());
    }
    #[cfg(windows)]
    if std::env::var_os("GSM_FIXTURE_RESULT").is_some() {
        return run_capture_fixture(app).await;
    }
    let suite = std::env::var("GSM_SMOKE_SUITE")
        .or_else(|_| std::env::var("GSM_SMOKE_SCENARIO"))
        .unwrap_or_else(|_| "foundation".into());
    if suite == "longplay" { return longplay::run(app).await; }
    if suite == "mining-settings" {
        let timeout = Duration::from_secs(25);
        let label = crate::mining_settings::WINDOW_LABEL;
        crate::app_lifecycle::create_hub_window(app)?;
        let hub = wait_window_ready(app, crate::app_lifecycle::HUB_WINDOW_LABEL, timeout).await?;
        evaluate_raw(app, &hub, r#"window.ipcRenderer.invoke("settings.openGSMSettings", {rootTabKey:"audio"})"#).await?;
        let editor = wait_window_ready(app, label, timeout).await?;
        let result = evaluate_raw(app, &editor, include_str!("../smoke/mining_settings.js")).await?;
        if evaluate_raw(app, &hub, "!!document.querySelector('.mining-editor')").await? == true {
            return Err("Settings mounted inside the hub".into());
        }
        editor.close().map_err(|e| e.to_string())?;
        tokio::time::timeout(timeout, async {
            while app.get_webview_window(label).is_some() {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }).await.map_err(|_| "Settings window did not close")?;
        evaluate_raw(app, &hub, r#"window.ipcRenderer.invoke("settings.openGSMSettings", {rootTabKey:"audio"})"#).await?;
        let reopened = wait_window_ready(app, label, timeout).await?;
        let value = evaluate_raw(app, &reopened, r#"(async () => {
            for(let i=0; i<150; i++) {
                const field=document.getElementById('mining-field-audio.enabled');
                if (field) return field.checked;
                await new Promise(r => setTimeout(r,60));
            }
            throw Error('No audio setting after reopening');
        })()"#).await?;
        if value != result["audio"] {return Err("Saved audio setting changed after reopening".into());}
        evaluate_raw(app, &hub, r#"window.ipcRenderer.invoke("settings.openGSMSettings", {rootTabKey:"obs"})"#).await?;
        evaluate_raw(app, &hub, r#"(async () => {
            for (let i=0; i<150; i++) {
                const pane=document.querySelector('#settings-view-obs:not([hidden]) .mining-obs');
                if (pane && document.getElementById('mining-field-obs.host')) {
                    const tabs = pane.querySelectorAll('[role=tab]');
                    tabs[tabs.length-1].click();
                    await new Promise(r => setTimeout(r,60));
                    if (document.getElementById('mining-field-obs.recording_fps')) return true;
                }
                await new Promise(r => setTimeout(r,60));
            }
            throw Error('OBS connection and recording settings did not open in the hub');
        })()"#).await?;
        return Ok(result);
    }
    if suite == "pythonless" { return pythonless::run(app).await; }
    if suite == "ocr-model-settings" { return model_settings::run(app).await; }
    if suite == "anki-grouping" { return anki_grouping::run(app).await; }
    if suite == "card-review" { return card_review::run(app).await; }
    #[cfg(windows)]
    if suite == "speech" { return speech::run(app).await; }
    if suite == "clip-capture" { return longplay::clip_capture(app).await; }
    if matches!(suite.as_str(), "database" | "database-recovery" | "vocabulary") {
        let service = app.state::<std::sync::Arc<crate::mining::MiningService>>();
        if suite == "vocabulary" {
            wait_for_jobs(app, &["anki_card_sync"]).await?;
            let port = service.bound_gateway_port().ok_or("Vocabulary gateway failed to bind")?;
            let url = format!("http://127.0.0.1:{port}/api/tokenization/words/not-in-anki");
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                let report: Value = app.state::<DesktopState>().http.get(&url).send().await
                    .and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?
                    .json().await.map_err(|e| e.to_string())?;
                if report["global_rank_source"]["id"] == "jiten-global" {break;}
                if Instant::now() >= deadline {
                    return Err(format!("Vocabulary report did not load its frequency source: {report}"));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let http = &app.state::<DesktopState>().http;
            let status_url = format!("http://127.0.0.1:{port}/api/anki_sync_status");
            let read_status = || async {
                let response = http.get(&status_url).send().await.map_err(|e|e.to_string())?;
                if response.headers().get("x-gsm-handler").and_then(|v|v.to_str().ok()) != Some("rust") {
                    return Err("Anki sync status did not reach the native handler".to_owned());
                }
                response.json::<Value>().await.map_err(|e|e.to_string())
            };
            let empty = read_status().await?;
            if empty["cache_populated"] != false || empty["anki_connect_available"] != true || empty["auto_sync_enabled"] != true {
                return Err(format!("Unexpected empty Anki status: {empty}"));
            }
            let chart = |path: &'static str| async move {
                let response = http.get(format!("http://127.0.0.1:{port}/api/{path}")).send().await.map_err(|e|e.to_string())?;
                if response.headers().get("x-gsm-handler").and_then(|v|v.to_str().ok()) != Some("rust") {
                    return Err("Anki charts did not reach the native handler".to_owned());
                }
                response.json::<Value>().await.map_err(|e|e.to_string())
            };
            let coverage = chart("anki_kanji_stats?start_timestamp=100&end_timestamp=600").await?;
            if coverage["anki_kanji_count"] != 2 {return Err(format!("Live Anki coverage failed: {coverage}"));}
            let queued = http.post(format!("http://127.0.0.1:{port}/api/anki_sync_now")).send().await.map_err(|e|e.to_string())?;
            if queued.status().as_u16() != 202 || queued.json::<Value>().await.map_err(|e|e.to_string())?["status"] != "queued" {
                return Err("Manual Anki sync was not queued".into());
            }
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let filled = read_status().await?;
                if filled["note_count"] == 1 && filled["card_count"] == 1 && filled["last_synced"].is_string()
                    && filled["next_auto_sync"] == empty["next_auto_sync"] && filled["anki_connect_available"] == false { break; }
                if Instant::now() >= deadline { return Err(format!("Manual Anki sync did not finish: {filled}")); }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let charts = chart("anki_stats_combined").await?;
            if charts.as_object().map(|s|s.len()) != Some(6) || charts["kanji_stats"]["anki_kanji_count"] != 2
                || charts["earliest_date"] != 0.101 || charts["reading_impact"]["tokenization_enabled"] != true {
                return Err(format!("Unexpected combined Anki report: {charts}"));
            }
            let index: Value = http.get(format!("http://127.0.0.1:{port}/api/yomitan-freq-index")).send().await
                .and_then(|r| r.error_for_status()).map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
            let url = format!("http://127.0.0.1:{port}/api/yomitan-freq-dict");
            if index["downloadUrl"] != url { return Err(format!("Unexpected dictionary index: {index}")); }
            let archive = http.get(&url).send().await.and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
            if archive.headers().get("Content-Type").and_then(|v| v.to_str().ok()) != Some("application/zip")
                || archive.headers().get("Access-Control-Allow-Origin").and_then(|v| v.to_str().ok()) != Some("*") {
                return Err("Unexpected dictionary download headers".into());
            }
            let bytes = archive.bytes().await.map_err(|e|e.to_string())?;
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e|e.to_string())?;
            let terms: Value = serde_json::from_reader(zip.by_name("term_meta_bank_1.json").map_err(|e|e.to_string())?)
                .map_err(|e|e.to_string())?;
            if terms.as_array().map(Vec::len) != Some(1) || terms[0][1] != "freq" || terms[0][2] != 1 {
                return Err(format!("Unexpected personal dictionary terms: {terms}"));
            }
        }
        if suite == "database-recovery" {
            service_call(app, "settings.getTheme", &[]).await?;
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                let paths = &handle.state::<crate::settings::Settings>().paths;
                if handle.state::<crate::recycled_lines::Recycled>().started()
                    || crate::database_startup::prepare(&handle).is_ok() {
                    return Err("A damaged profile started its database services".into());
                }
                let database = paths.active.join("gsm.db");
                if std::fs::read(&database).map_err(|e| e.to_string())? != b"damaged profile" {
                    return Err("Failed startup changed the original database".into());
                }
                std::fs::copy(paths.active.join("replacement.db"), database).map_err(|e| e.to_string())?;
                crate::database_startup::prepare(&handle)
            }).await.map_err(|e| e.to_string())??;
        }
        let port = service.bound_gateway_port().ok_or("Native gateway failed to bind")?;
        if suite == "database" {
            wait_for_jobs(app, &["daily_stats_rollup", "populate_games"]).await?;
            let http = &app.state::<DesktopState>().http;
            let tools = format!("http://127.0.0.1:{port}/api");
            let check = |name:&str, payload:Value| {
                let request = http.post(format!("{tools}/{name}")).json(&payload);
                async move {
                    let reply = request.send().await.map_err(|e|e.to_string())?;
                    if reply.headers().get("x-gsm-handler").and_then(|v|v.to_str().ok()) != Some("rust") {
                        return Err("Database maintenance request needed the compatibility server".to_owned());
                    }
                    reply.error_for_status().map_err(|e|e.to_string())?.json::<Value>().await.map_err(|e|e.to_string())
                }
            };
            for (route, payload, key,expected) in [
                ("preview-text-deletion",json!({"exact_text":"absent-smoke-sentence"}),"count",0),
                ("search-duplicates",json!({"game":"absent-smoke-game"}),"duplicates_found",0),
                ("preview-deduplication",json!({"games":["absent-smoke-game"]}),"duplicates_count",0),
                ("deduplicate",json!({"games":["absent-smoke-game"]}),"deleted_count",0),
                ("delete-text-lines",json!({"exact_text":"absent-smoke-sentence"}),"deleted_count",0),
                ("delete-sentence-lines",json!({"line_ids":["absent-smoke-id"]}),"deleted_count",1),
            ] {
                let reply = check(route,payload).await?;
                if reply[key] != expected {return Err(format!("Unexpected {route} reply: {reply}")); }
            }
            let saved = check("settings",json!({"tadoku_username":"smoke", "tadoku_password":"test value", "tadoku_daily_sync_enabled":false, "easy_days_friday":75})).await?;
            let view:Value = http.get(format!("http://127.0.0.1:{port}/api/settings")).send().await.and_then(|r|r.error_for_status())
                .map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
            if saved["tadoku_configured"]!=true || view["easy_days_friday"]!=75 || view.get("tadoku_password").is_some() || saved.get("tadoku_password").is_some() {
                return Err("Statistics settings failed the save and read check".into());
            }
            let game = check("games",json!({"title_original":"Library smoke","image":"R0lGODlh"})).await?;
            let id = game["game"]["id"].as_str().ok_or("Created game has no ID")?;
            let game_url = format!("{tools}/games/{id}");
            archive_files::verify(http, &tools, &app.state::<crate::settings::Settings>().paths.active, id)
                .await.map_err(|e| e.to_string())?;
            for request in [
                http.put(&game_url).json(&json!({"status":"on_hold","title_english":"Smoke"})),
                http.post(format!("{game_url}/mark-complete")),
                http.get(format!("{tools}/orphaned-games")),
                http.get(format!("{tools}/games-management?sort=title")),
            ] {
                let response=request.send().await.map_err(|e|e.to_string())?;
                if response.headers().get("x-gsm-handler").and_then(|v|v.to_str().ok())!=Some("rust") {
                    return Err("Game library request reached the compatibility server".into());
                }
                response.error_for_status().map_err(|e|e.to_string())?;
            }
            let cover=http.get(format!("{game_url}/image")).send().await.map_err(|e|e.to_string())?;
            if cover.headers().get("content-type").and_then(|v|v.to_str().ok())!=Some("image/gif")
                || cover.bytes().await.map_err(|e|e.to_string())?.as_ref()!=b"GIF89a" {
                return Err("Game cover bytes or format changed".into());
            }
            let unlink:Value=http.delete(&game_url).send().await.and_then(|r|r.error_for_status()).map_err(|e|e.to_string())?
                .json().await.map_err(|e|e.to_string())?;
            if unlink["game_name"]!="Library smoke"{return Err("Library unlink failed".into());}
            let base = format!("http://127.0.0.1:{port}/api/goals");
            let reply = http.post(format!("{base}/update")).header("x-timezone", "America/New_York")
                .json(&json!({"current_goals":[{"metricType":"characters","startDate":"2026-11-01T01:15:00-04:00","endDate":"2026-11-01T01:15:00-05:00"}],
                    "partial_settings":{"easyDays":{"monday":25}}}))
                .send().await.map_err(|e| e.to_string())?;
            if reply.headers().get("x-gsm-handler").and_then(|v| v.to_str().ok()) != Some("rust") {
                return Err("Goal edit did not reach the native gateway".into());
            }
            reply.error_for_status().map_err(|e| e.to_string())?;
            let current: Value = http.get(format!("{base}/current")).send().await.and_then(|r|r.error_for_status())
                .map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
            if current["goals_settings"]["easyDays"]["monday"] != 25 || current["current_goals"][0]["metricType"] != "characters" {
                return Err(format!("Goal edit did not survive a fresh read: {current}"));
            }
        }
        let response = app.state::<DesktopState>().http.post(format!("http://127.0.0.1:{port}/api/database_backup"))
            .send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() || response.headers().get("x-gsm-handler").and_then(|v| v.to_str().ok()) != Some("rust") {
            return Err(format!("Native backup request failed: {}", response.status()));
        }
        return response.json().await.map_err(|e| e.to_string());
    }
    // Never attach test overlays to an already-running user's backend.
    let endpoint = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = endpoint.local_addr().map_err(|e| e.to_string())?.port();
    let config =
        json!({"current_profile":"Smoke", "configs":{"Smoke":{"general":{"single_port":port}}}});
    std::fs::write(
        app.state::<crate::settings::Settings>()
            .paths
            .active
            .join("config.json"),
        config.to_string(),
    )
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        while let Ok((socket, _)) = endpoint.accept().await {
            tauri::async_runtime::spawn(async move {
                use futures_util::{SinkExt, StreamExt};
                use tokio_tungstenite::tungstenite::Message;
                let Ok(mut socket) = tokio_tungstenite::accept_async(socket).await else {
                    return;
                };
                let mut settings = serde_json::Map::new();
                while let Some(Ok(frame)) = socket.next().await {
                    if let Message::Text(text) = frame {
                        let Ok(message) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        if message["event"] == "text_v2_snapshot_request" {
                            eprintln!("[smoke] Reader requested its transcript snapshot");
                            let mut snapshot = json!({"event":"text_v2_snapshot","session_id":"smoke",
                                "snapshot_sequence":1,"lines":[{"id":"home-word","text":"食べる",
                                "session_id":"smoke","sequence":1,"revision":1}]});
                            if std::env::var("GSM_SMOKE_SUITE").as_deref() == Ok("memory") {
                                snapshot["snapshot_sequence"] = json!(1000);
                                snapshot["lines"] = json!((0..1000).map(|i| json!({
                                    "id":format!("memory-{i}"),"session_id":"smoke","sequence":i+1,
                                    "revision":1,"text":"ゲームの文章を読みながら、日本語の言葉を勉強しています。",
                                    "captured_at":"2026-11-15T12:00:00Z"
                                })).collect::<Vec<_>>());
                            }
                            if socket.send(Message::Text(snapshot.to_string().into())).await.is_err() { break; }
                            continue;
                        }
                        let reply = match message["type"].as_str() {
                            Some("set-gsm-overlay-config") => {
                                if let Some(patch) = message["settings"].as_object() {
                                    settings.extend(patch.clone());
                                }
                                json!({"type":"gsm-overlay-config-updated","settings":settings})
                            }
                            Some("get-gsm-overlay-config") => {
                                json!({"type":"gsm-overlay-config-updated","settings":settings})
                            }
                            Some("quick-action-request") => {
                                json!({"type":"quick-action-result","request_id":message["request_id"],"success":true,"action":message["action"]})
                            }
                            _ => continue,
                        };
                        if socket
                            .send(Message::Text(reply.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            });
        }
    });
    if let Ok(fixture_dir) = std::env::var("GSM_LEGACY_FIXTURE") {
        if !fixture_dir.trim().is_empty() {
            return run_legacy_transfer_smoke(app, Path::new(&fixture_dir)).await;
        }
    }
    if let Ok(reader) = std::env::var("GSM_SMOKE_DICTIONARY") {
        if !reader.trim().is_empty() {
            return run_dictionary_smoke(app, reader.trim()).await;
        }
    }
    if suite == "qt-dialog" {
        let python = std::env::var("GSM_TEST_QT_PYTHON").map_err(|e| e.to_string())?;
        let root = app.state::<crate::settings::Settings>().paths.active.join("dialog-fixture");
        if std::env::var("GSM_QT_FIXTURE_MODE").as_deref() == Ok("settings") {
            return qt_settings::run(app, python, root).await;
        }
        let grouping = std::env::var_os("GSM_SMOKE_ANKI_GROUPING").is_some();
        let dialog = if grouping { anki_grouping::fixture() } else { crate::gui_dialog::Dialog::TextInput { title:"Fixture".into(), label:"Fixture".into() } };
        let live = std::env::var("GSM_QT_FIXTURE_MODE").as_deref() == Ok("live");
        let runtime = crate::runtime::get(app)?;
        if live {
            runtime.call("process.start",json!({"id":"backend","command":python,"env":gsm_packages::python::environment(),
                "args":["-m","GameSentenceMiner.ui.desktop_dialog"],"cwd":root,"windowsHide":true})).await?;
            let deadline = Instant::now()+Duration::from_secs(20);
            while !runtime.call("bus.clients",json!({})).await?.as_array().is_some_and(|v|v.iter().any(|id|id=="backend")) {
                if Instant::now()>=deadline { return Err("Qt fixture failed to connect".into()); }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let started = Instant::now();
        let answer = if live {
            crate::gui_dialog::open(app,dialog).await?
        } else {
            crate::gui_dialog::run_worker(app, dialog, &python, &root).await?
        };
        let elapsed = started.elapsed().as_secs_f64()*1000.0;
        let expected = if grouping {json!({"target_note_id":102,"order":"back","delete_duplicate":false,"overwrite":true})} else {json!("日本語")};
        if answer != expected { return Err(format!("Unexpected Qt result: {answer}")); }
        let state = runtime.call("process.state", json!({"id":"qt-dialog"})).await?;
        if !state["pid"].is_null() { return Err("Qt worker remained resident".into()); }
        if live { runtime.call("process.stop",json!({"id":"backend"})).await?; }
        return Ok(json!({"elapsed_ms":elapsed}));
    }
    run_suite_smoke(app, &suite).await
}

#[cfg(windows)]
async fn run_capture_fixture(app: &AppHandle) -> Result<Value, String> {
    let desktop = app.state::<DesktopState>();
    let directory = crate::desktop_services::paths_for(app)
        .active
        .join("capture-fixture");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    std::fs::write(directory.join("index.html"),"<!doctype html><meta charset='utf-8'><body style='margin:0;background:white;color:black;font:48px Meiryo,sans-serif'><div style='position:absolute;left:70px;top:100px'>日本語の文章を読みます。<br>今日はとても良い天気です。</div>").map_err(|e|e.to_string())?;
    desktop.assets.mount("capture-fixture", &directory)?;
    let token = desktop.register_window("capture-fixture", "smoke");
    let window = WebviewWindowBuilder::new(
        app,
        "capture-fixture",
        WebviewUrl::External(desktop.assets.url(&format!(
            "{}/capture-fixture/index.html",
            crate::assets::origin()
        ))?),
    )
    .title("GSM capture verification")
    .decorations(false)
    .inner_size(1000., 500.)
    .visible(true)
    .initialization_script(crate::overlay_preload::render_desktop_preload(&token))
    .build()
    .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(1000u32, 500u32))
        .map_err(|e| e.to_string())?;
    wait_window_ready(app, "capture-fixture", Duration::from_secs(15)).await?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize as u64;
    std::fs::write(
        std::env::var("GSM_FIXTURE_RESULT").unwrap(),
        json!({"hwnd":hwnd}).to_string(),
    )
    .map_err(|e| e.to_string())?;
    let control = std::env::var("GSM_FIXTURE_CONTROL").map_err(|e| e.to_string())?;
    let stop = std::env::var("GSM_FIXTURE_STOP").map_err(|e| e.to_string())?;
    let mut previous = String::new();
    let deadline = Instant::now() + Duration::from_secs(600);
    while !Path::new(&stop).exists() && Instant::now() < deadline {
        if let Ok(raw) = std::fs::read_to_string(&control) {
            if raw != previous {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    if let (Some(w), Some(h)) = (value["width"].as_u64(), value["height"].as_u64())
                    {
                        window
                            .set_size(tauri::PhysicalSize::new(
                                w.clamp(100, 4000) as u32,
                                h.clamp(100, 4000) as u32,
                            ))
                            .map_err(|e| e.to_string())?;
                    }
                    if value["color"].is_string() {
                        evaluate_raw(
                            app,
                            &window,
                            &format!("document.body.style.background={}", value["color"]),
                        )
                        .await?;
                    }
                    previous = raw;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    window.destroy().map_err(|e| e.to_string())?;
    Ok(json!({"fixture":"capture"}))
}

#[cfg(windows)]
async fn wait_for_smoke_show_key(app: &AppHandle) -> Result<(), String> {
    let url = crate::input_server::url(app).ok_or("Missing fixture input server")?;
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(frame)) = socket.next().await {
            let Some(status) = frame.to_text().ok().and_then(|s| serde_json::from_str::<Value>(s).ok()) else { continue };
            if status["type"] == "keyboard_listener_status" && status["configuredHotkey"] == "F23"
                && status["available"] == true {
                return Ok(());
            }
        }
        Err("Fixture input server disconnected".into())
    }).await.map_err(|_| "F23 was not registered by the fixture input server".to_owned())?
}

#[cfg(windows)]
async fn focus_dictionary_fixture(hub: &WebviewWindow) -> Result<bool, String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    hub.show().map_err(|e| e.to_string())?;
    crate::window_platform::apply(hub, "focus", &Value::Null)?;
    for _ in 0..20 {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid)) };
        if pid == std::process::id() { return Ok(true); }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(false)
}

fn dictionary_smoke_key(app: &AppHandle, os_key: bool, pressed: bool) -> Result<(), String> {
    #[cfg(windows)]
    if os_key {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        if pressed {
            use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid)) };
            if pid != std::process::id() { return Err("Fixture lost foreground before F23".into()); }
        }
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT {
                wVk: VK_F23, dwFlags: if pressed { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP },
                ..Default::default()
            } },
        };
        if unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) } != 1 {
            return Err("Could not send fixture F23 transition".into());
        }
        return Ok(());
    }
    let _ = os_key;
    app.state::<crate::overlay_host::OverlayHost>().handle_input_server_msg(app, &json!({
        "type":"manual_hotkey_event", "state": if pressed { "pressed" } else { "released" }
    }));
    Ok(())
}

async fn run_dictionary_smoke(app: &AppHandle, reader: &str) -> Result<Value, String> {
    let phase = std::env::var("GSM_SMOKE_PHASE").unwrap_or_else(|_| "import".into());
    eprintln!("[smoke] {reader}/{phase}: opening Home before dictionary warmup");
    let overlay_data = overlay_data_path(app);
    std::fs::create_dir_all(&overlay_data).map_err(|e| e.to_string())?;
    std::fs::write(
        overlay_data.join("settings.json"),
        json!({ "dictionaryReaderSelection": reader, "openSettingsOnStartup": false,
            "mainBoxStartupWarningAcknowledged": true, "pushToShowEnforcedDialogDismissed": true,
            "showFurigana": false, "showTextIndicators": true, "liveStatsEnabled": true,
            "gamepadEnabled": false, "gamepadControllerEnabled": false,
            "gamepadKeyboardEnabled": false })
        .to_string(),
    )
    .map_err(|e| e.to_string())?;

    // Open Home before warming the extension, as in ordinary desktop startup.
    // An enabled shared profile must not be mistaken for an attached document.
    service_call(app, "settings.onboarding.save", &[json!({"version":1,"step":"language","status":"paused"})]).await?;
    let hub = crate::app_lifecycle::create_hub_window(app)?;
    let _ = wait_window_ready(app, hub.label(), Duration::from_secs(25)).await?;

    // Warm up the dictionary host and create the hidden lookup page.
    eprintln!("[smoke] {reader}/{phase}: preparing dictionary lookup page");
    let _ = crate::reader_service::try_invoke(app, "gsm-hub", "reader.lookup", &[json!("日本")])
        .await
        .ok_or("reader.lookup not handled")?
        .map_err(|e| format!("warmup lookup: {e}"))?;

    let host_win = wait_window_ready(app, LOOKUP_PAGE_LABEL, Duration::from_secs(30))
        .await
        .map_err(|e| format!("wait lookup page: {e}"))?;

    if reader == "hachidori" {
        evaluate_raw(
            app,
            &host_win,
            r#"(async()=>{
                for (let i = 0; i < 200; i++) {
                    const st = await chrome.runtime.sendMessage({
                        target: 'hoshidicts-offscreen',
                        type: 'hd_status',
                        requestId: `smoke-ready-${i}`
                    });
                    if (st?.ok && st.ready && !st.loading) return st;
                    await new Promise(r => setTimeout(r, 100));
                }
                throw new Error('Hachidori engine did not become ready');
            })()"#,
        )
        .await
        .map_err(|e| format!("wait hachidori ready: {e}"))?;
    }

    if phase == "import" {
        let profile_dir = std::env::var("GSM_PROFILE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                app.state::<crate::settings::Settings>()
                    .paths
                    .active
                    .clone()
            });
        let zip_bytes = std::fs::read(profile_dir.join("dictionary.zip"))
            .map_err(|e| format!("Failed reading dictionary.zip fixture: {e}"))?;
        let archive_b64 = STANDARD.encode(&zip_bytes);

        if reader == "yomitan" {
            // Close any onboarding/welcome popups so the import owns settings changes cleanly.
            for (lbl, w) in app.webview_windows() {
                if lbl != LOOKUP_PAGE_LABEL {
                    if let Ok(u) = w.url() {
                        let s = u.as_str();
                        if s.ends_with("/settings.html") || s.ends_with("/welcome.html") {
                            let _ = w.destroy();
                        }
                    }
                }
            }
            let script = format!(
                r#"(async()=>{{
                    const {{DictionaryWorker}}=await import('./js/dictionary/dictionary-worker.js');
                    const {{API}}=await import('./js/comm/api.js');
                    const {{WebExtension}}=await import('./js/extension/web-extension.js');
                    const bytes=Uint8Array.from(atob({archive}),c=>c.charCodeAt(0));
                    const imported=await new DictionaryWorker().importDictionary(
                        bytes.buffer,
                        {{prefixWildcardsSupported:false,yomitanVersion:chrome.runtime.getManifest().version}},
                        ()=>{{}}
                    );
                    const api=new API(new WebExtension());
                    const options=await api.optionsGetFull();
                    options.profiles[options.profileCurrent].options.dictionaries.push({{
                        name:'hachidori-fixture',
                        alias:'',
                        enabled:true,
                        allowSecondarySearches:false,
                        definitionsCollapsible:'not-collapsible',
                        partsOfSpeechFilter:true,
                        useDeinflections:true
                    }});
                    await api.setAllSettings(options,'native-smoke');
                    await api.triggerDatabaseUpdated('dictionary','import');
                    return {{title:imported.result?.title,errors:(imported.errors||[]).map(e=>e.message||String(e))}};
                }})()"#,
                archive = json!(archive_b64)
            );
            let imported = evaluate_raw(app, &host_win, &script).await?;
            if imported["title"].as_str() != Some("hachidori-fixture") {
                return Err(format!("Unexpected Yomitan import result: {imported}"));
            }
        } else {
            let script = format!(
                r#"(async()=>{{
                    for (let i = 0; i < 100; i++) {{
                        const st = await chrome.runtime.sendMessage({{
                            target: 'hoshidicts-offscreen',
                            type: 'hd_status',
                            requestId: `smoke-status-${{i}}`
                        }});
                        if (st?.ok && st.ready && !st.loading) break;
                        await new Promise(r => setTimeout(r, 100));
                    }}
                    const bytes=Uint8Array.from(atob({archive}),c=>c.charCodeAt(0));
                    const blobUrl=URL.createObjectURL(new Blob([bytes]));
                    try {{
                        return await chrome.runtime.sendMessage({{
                            target:'hoshidicts-offscreen',
                            type:'hd_import',
                            blobUrl,
                            fileName:'hachidori-fixture.zip',
                            requestId:'native-import'
                        }});
                    }} finally {{
                        URL.revokeObjectURL(blobUrl);
                    }}
                }})()"#,
                archive = json!(archive_b64)
            );
            let imported = evaluate_raw(app, &host_win, &script)
                .await
                .map_err(|e| format!("hachidori import eval: {e}"))?;
            if imported["ok"].as_bool() != Some(true) {
                return Err(format!("Unexpected Hachidori import result: {imported}"));
            }
        }
    }

    eprintln!("[smoke] {reader}/{phase}: checking fixture lookup");
    let lookup =
        crate::reader_service::try_invoke(app, "gsm-hub", "reader.lookup", &[json!("食べる")])
            .await
            .ok_or("reader.lookup not handled")?
            .map_err(|e| format!("lookup 食べる: {e}"))?;

    if lookup["reader"].as_str() != Some(reader) {
        return Err(format!("Expected reader {reader}, got {lookup}"));
    }
    let has_to_eat = lookup["entries"].as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["definitions"].as_array().is_some_and(|defs| {
                defs.iter()
                    .any(|d| d.as_str().is_some_and(|s| s.contains("to eat")))
            })
        })
    });
    if !has_to_eat {
        return Err(format!(
            "Dictionary lookup for 食べる missing 'to eat': {lookup}"
        ));
    }

    #[cfg(windows)]
    if reader == "hachidori" && use_windows_native_extensions() {
        let resources = evaluate_raw(app, &hub, r#"window.__GSM_INVOKE__("desktop_resource_usage", {})"#).await?;
        let webviews = resources["groups"].as_array().into_iter().flatten()
            .find(|row| row["group"] == "webview").ok_or("Missing WebView2 subtotal")?;
        let processes = webviews["processes"].as_array().ok_or("Missing WebView2 processes")?;
        let pids: std::collections::HashSet<_> = processes.iter().filter_map(|row| row["pid"].as_u64()).collect();
        if processes.len() != pids.len()
            || !processes.iter().any(|row| row["kind"] == "extension")
            || !processes.iter().any(|row| row["kind"] == "renderer" && row["windowLabels"].as_array()
                .is_some_and(|labels| labels.iter().any(|label| label == "gsm-hub")))
            || !resources["extensions"].as_array().into_iter().flatten().any(|ext| ext["kind"] == "hachidori" && ext["enabled"] == true)
        {
            return Err(format!("Unexpected WebView2 resource attribution: {resources}"));
        }
        let memory = evaluate_raw(app, &hub, r#"window.__GSM_INVOKE__("desktop_hachidori_memory", {})"#).await?;
        if memory["heapBytes"].as_u64().unwrap_or(0) == 0
            || !memory["useLessRamByDefault"].is_boolean()
            || !memory["dictionaries"].as_array().into_iter().flatten().any(|dict| {
                dict["title"] == "hachidori-fixture" && dict["residentHashBytes"].is_u64()
            })
            || app.get_webview_window("gsm-hachidori-memory").is_some()
        {
            return Err(format!("Unexpected Hachidori memory sample: {memory}"));
        }
        eprintln!("[smoke] {reader}/{phase}: verified WebView2 and dictionary memory attribution");
    }

    eprintln!("[smoke] {reader}/{phase}: checking Home Shift lookup");
    crate::reader_service::attach_home_dictionary(app, hub.label()).await?;
    let _ = wait_window_ready(app, hub.label(), Duration::from_secs(25)).await?;
    // Home renders incoming lines when the native window is presented.
    crate::desktop_state::focus_window(&hub)?;
    evaluate_raw(app, &hub, include_str!("../smoke/home.js")).await?;
    evaluate_raw(app, &hub, &format!("window.__gsmSmokeHome.lookup({})", json!(reader))).await?;
    let home_document = evaluate_raw(app, &hub, DOCUMENT_ID).await?;
    crate::reader_service::attach_home_dictionary(app, hub.label()).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    if evaluate_raw(app, &hub, DOCUMENT_ID).await? != home_document {
        return Err("Reentering Home reloaded an already attached dictionary".into());
    }
    hub.hide().map_err(|e| e.to_string())?;

    eprintln!("[smoke] {reader}/{phase}: checking overlay lookups and lifecycle");
    #[cfg(windows)]
    app.state::<crate::obs::Obs>().set_smoke_target(
        "Dictionary fixture", hub.hwnd().map_err(|e| e.to_string())?.0 as usize as u64,
    );
    let host = app.state::<crate::overlay_host::OverlayHost>();
    host.start(app, None, "smoke").await?;
    let overlay = wait_window_ready(app, OVERLAY_MAIN_LABEL, Duration::from_secs(25)).await?;
    wait_overlay_dictionary(app).await?;
    host.handle_ws2_text(
        app,
        &json!({"type":"capture_status","available":true,"window_state":"active"}).to_string(),
    )
    .await;
    if !overlay.is_visible().unwrap_or(false) {
        return Err("Dictionary fixture overlay is hidden".into());
    }
    evaluate_raw(app, &overlay, include_str!("../smoke/overlay.js")).await?;
    // The fixture owns its pointer samples. A real mouse moving elsewhere on
    // the desktop must not trigger the reader's ordinary mouse-leave auto-hide.
    #[cfg(windows)]
    crate::browser_extensions::devtools_command(&overlay, "Input.setIgnoreInputEvents", json!({"ignore":true})).await?;
    let os_key = if phase == "import" {
        host.apply_setting_updates(app, serde_json::from_value(json!({
            "manualMode":true, "manualModeType":"hybrid", "manualModeInactiveBehavior":"hide-overlay", "showHotkey":"F23",
        })).unwrap(), false);
        #[cfg(windows)]
        {
            wait_for_smoke_show_key(app).await?;
            focus_dictionary_fixture(&hub).await?
        }
        #[cfg(not(windows))]
        { false }
    } else { false };
    if phase == "import" {
        eprintln!("[smoke] hybrid shortcut via {}", if os_key { "Windows F23 input hook" } else { "input-server event replay" });
        dictionary_smoke_key(app, os_key, true)?;
        let held = evaluate_raw(app, &overlay, "window.__gsmSmokeOverlay.waitForManualState(true)").await;
        dictionary_smoke_key(app, os_key, false)?;
        held?;
        evaluate_raw(app, &overlay, "window.__gsmSmokeOverlay.waitForManualState(false)").await?;
        evaluate_raw(app, &overlay, "window.__gsmSmokeOverlay.startHybridLookup()").await?;
        dictionary_smoke_key(app, os_key, true)?;
    }
    if phase == "reopen" {
        if use_windows_native_extensions()
            && app.state::<DesktopState>()
                .window_scope(crate::dictionary_host::EXTENSION_CONTROLLER_LABEL)
                .as_deref() != Some("dictionary")
        {
            return Err("The hidden dictionary controller must use the dictionary memory policy".into());
        }
        // Cross the browser's idle-worker deadline with Home hidden. This is
        // the first popup in this overlay document, with a stationary cursor.
        tokio::time::sleep(Duration::from_secs(65)).await;
        #[cfg(not(windows))]
        dictionary_smoke_key(app, false, true)?;
    }
    let hover_ms = evaluate_raw(
        app,
        &overlay,
        &format!("(async () => {{ if ({}) await window.__gsmSmokeOverlay.waitForManualState(true); return window.__gsmSmokeOverlay.lookup({}, {{stationary:true}}); }})()",
            phase == "import" || !cfg!(windows), json!(reader)),
    )
    .await;
    if phase == "import" || !cfg!(windows) {
        dictionary_smoke_key(app, os_key, false)?;
    }
    let hover_ms = hover_ms?;
    if phase == "reopen" {
        let elapsed = hover_ms.as_u64().ok_or("Missing popup-shown event after idle")?;
        eprintln!("[smoke] {reader}: first hover after 65s idle: {elapsed} ms");
        if elapsed >= 3000 {
            return Err(format!("First {reader} hover after idle took {elapsed} ms"));
        }
    }
    if phase == "import" {
        evaluate_raw(app, &overlay, "window.__gsmSmokeOverlay.finishHybridLookup()").await?;
        hub.hide().map_err(|e| e.to_string())?;
        eprintln!("[smoke] {reader}: hybrid reveal, lookup, key release and popup dismissal passed");
        host.apply_setting_updates(app, serde_json::from_value(json!({"manualMode":false})).unwrap(), false);
        let other = if reader == "yomitan" {
            "hachidori"
        } else {
            "yomitan"
        };
        for next in [other, reader] {
            let previous_document = evaluate_raw(app, &overlay, DOCUMENT_ID).await?;
            host.apply_setting_updates(
                app,
                serde_json::from_value(json!({"dictionaryReaderSelection":next})).unwrap(),
                false,
            );
            let deadline = Instant::now() + Duration::from_secs(45);
            let mut ready = false;
            while Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(150)).await;
                if evaluate_raw(app, &overlay, &format!("document.__gsmSmokeDocumentId !== {} && document.readyState === 'complete' && typeof dictionaryReader !== 'undefined' && dictionaryReader === {}", previous_document, json!(next))).await == Ok(json!(true)) {
                    ready = true; break;
                }
            }
            if !ready {
                return Err(format!("Live dictionary switch to {next} did not finish"));
            }
        }
        // A successful setting change must retain real lookup capability.
        wait_overlay_dictionary(app).await?;
        evaluate_raw(app, &overlay, include_str!("../smoke/overlay.js")).await?;
        #[cfg(not(windows))]
        {
            // These platforms require Push to Show before OCR text is interactive.
            dictionary_smoke_key(app, false, true)?;
            evaluate_raw(app, &overlay, "window.__gsmSmokeOverlay.waitForManualState(true)").await?;
        }
        evaluate_raw(
            app,
            &overlay,
            &format!("window.__gsmSmokeOverlay.lookup({})", json!(reader)),
        )
        .await?;
        #[cfg(not(windows))]
        dictionary_smoke_key(app, false, false)?;
    }
    if reader == "hachidori" {
        // Test the user's automatic hover path too: no Shift and no artificial
        // mouse jiggle to restart a missing/cancelled dwell scan.
        evaluate_raw(app, &overlay, r#"(async()=>{
            const stored = await window.gsmHachidoriBridge.invoke('options');
            const result = await window.gsmHachidoriBridge.invoke('updateOptions', {
                baseRevision: stored?.revision ?? 0, profileId: 'ja', language: 'ja',
                options: {lookupMode:'hover', scanDelayMs:100},
            });
            if(!result.ok) throw Error('Could not configure hover fixture: '+JSON.stringify(result));
        })()"#).await?;
        // Returning to the game after opening settings used to show the HWND
        // without restoring its pointer feed. Keep the document alive here.
        for (available, state) in [(false, "closed"), (true, "active")] {
            host.handle_ws2_text(app, &json!({"type":"capture_status", "available":available,
                "window_state":state}).to_string()).await;
        }
        #[cfg(windows)]
        if crate::windows_input::forwarding_interval(&overlay).is_none() {
            return Err("Hover lookup has no native pointer feed after game reactivation".into());
        }
        #[cfg(not(windows))]
        {
            // Losing capture also releases Push to Show on the portable overlay.
            dictionary_smoke_key(app, false, true)?;
            evaluate_raw(app, &overlay, "window.__gsmSmokeOverlay.waitForManualState(true)").await?;
        }
        evaluate_raw(app, &overlay, "window.__gsmSmokeOverlay.lookup('hachidori', {shiftKey:false, stationary:true})").await?;
        #[cfg(not(windows))]
        dictionary_smoke_key(app, false, false)?;
    }
    let document = evaluate_raw(app, &overlay, DOCUMENT_ID).await?;
    host.stop(app).await;
    if overlay.is_visible().unwrap_or(true) || host.status()["isRunning"] != false {
        return Err("Disabled overlay remained active".into());
    }
    // Imports, lookups and settings belong to the app, even without an overlay.
    let after_stop = crate::reader_service::lookup_reader_dictionary(app, "食べる").await?;
    if after_stop != lookup {
        return Err(format!("Disabling overlay changed dictionary lookup from {lookup} to {after_stop}"));
    }
    let setup = crate::dictionary_service::handle_request(app, "dictionary.setup", &json!({
        "request_id":"independent-dictionary", "deadline":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() + 30_000,
        "data":{"action":"status", "language":"ja"}
    })).await;
    if setup["success"] != true { return Err(format!("Dictionary status while disabled: {setup}")); }
    let activation = Instant::now();
    host.start(app, Some(false), "smoke").await?;
    let elapsed = activation.elapsed();
    if evaluate_raw(app, &overlay, DOCUMENT_ID).await? != document {
        return Err("Warm overlay activation reloaded its document".into());
    }
    eprintln!("[architecture] {reader} warm overlay activation: {:.2} ms", elapsed.as_secs_f64() * 1000.0);
    if elapsed > Duration::from_millis(500) { return Err(format!("Warm activation exceeded 500 ms: {elapsed:?}")); }
    host.stop(app).await;

    if phase == "import" {
        let _ = crate::reader_service::try_invoke(
            app,
            "gsm-hub",
            "reader.openDictionary",
            &[json!({ "text": "食べる", "context": "日本語を食べる" })],
        )
        .await
        .ok_or("reader.openDictionary not handled")?
        .map_err(|e| format!("openDictionary: {e}"))?;
        let search_window =
            wait_window_ready(app, DICTIONARY_SEARCH_LABEL, Duration::from_secs(20))
                .await
                .map_err(|e| format!("wait search window: {e}"))?;
        if !search_window.is_visible().unwrap_or(false) {
            return Err("Dictionary search opened hidden".into());
        }
    }

    Ok(json!({ "reader": reader, "phase": phase }))
}

async fn smoke_jiten_broker(app: &AppHandle) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let endpoint = format!(
        "http://{}/private/api/reader/parse",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    let server = tauri::async_runtime::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let body = json!({"tokens":[[{"wordId":1,"readingIndex":0,"start":0,"length":1}]],"vocabulary":[{"wordId":1,"readingIndex":0,"knownState":[0]}]}).to_string();
            let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
        }
    });
    let outcome = async {
        let cache = app.state::<crate::overlay_host::OverlayHost>().jiten_cache(app);
        let initial = cache.parse("猫", "smoke-key", &endpoint).await?;
        let hits = cache.stats().cache_hits;
        let dictionaries = app.state::<DictionaryManager>();
        let extension = dictionaries.load_jiten_extension(app).await?;
        dictionaries.open_jiten_options(app).await?;
        let label = format!("gsm-dict-options-{}", extension.id);
        let options = wait_window_ready(app,&label,Duration::from_secs(20)).await?;
        if options.is_visible().map_err(|e| e.to_string())? {
            return Err("Jiten smoke test opened a visible settings window".into());
        }
        let result = evaluate_raw(app,&options,&format!(r#"(async()=>{{const response=await fetch({},{{method:'POST',headers:{{'Authorization':'ApiKey smoke-key','Content-Type':'application/json'}},body:JSON.stringify({{text:['猫']}})}}); return await response.json();}})()"#,json!(endpoint))).await;
        let _ = options.destroy();
        if result? != initial || cache.stats().cache_hits <= hits { return Err("Jiten extension request bypassed the shared overlay cache".into()); }
        Ok(())
    }.await;
    server.abort();
    outcome
}

async fn run_legacy_transfer_smoke(app: &AppHandle, fixture_dir: &Path) -> Result<Value, String> {
    let phase = std::env::var("GSM_SMOKE_PHASE").unwrap_or_else(|_| "import".into());
    let source_raw = std::fs::read_to_string(fixture_dir.join("fixture.json"))
        .map_err(|e| format!("Failed reading fixture.json: {e}"))?;
    let source: Value = serde_json::from_str(&source_raw).map_err(|e| e.to_string())?;
    let mut profile_path = PathBuf::from(
        source["profile"]
            .as_str()
            .ok_or("Missing fixture profile")?,
    );
    let ext_path = PathBuf::from(
        source["extensionPath"]
            .as_str()
            .ok_or("Missing fixture extensionPath")?,
    );
    let kind = source["kind"].as_str().unwrap_or("yomitan");
    let source_id = source["id"].as_str().unwrap_or("");
    if matches!(phase.as_str(), "browser-import" | "browser-reopen") {
        #[cfg(not(windows))]
        return Err("Browser import smoke requires Windows WebView2".into());
        #[cfg(windows)]
        {
            let destination = fixture_dir.join("browser-import-destination");
            std::fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            std::env::set_var("GSM_OVERLAY_DATA_PATH", &destination);
            let manager = app.state::<DictionaryManager>();
            std::fs::write(destination.join("settings.json"), json!({"dictionaryReaderSelection":kind}).to_string())
                .map_err(|error| error.to_string())?;
            let original = if phase == "browser-import" {
                let (_, original) = manager.load_selected_extension(app).await?;
                if kind == "hachidori" {
                    manager.ensure_hachidori_engine(app, &original).await?;
                }
                let overlay = apply_profile_data_directory(
                    apply_shared_webview_options(WebviewWindowBuilder::new(app, OVERLAY_MAIN_LABEL,
                        WebviewUrl::External("about:blank".parse().unwrap())).visible(false)),
                    &destination,
                )?.build().map_err(|error| error.to_string())?;
                manager.attach_reader_window(app, &overlay, &original).await?;
                let status = manager.import_browser_dictionary(app, profile_path, source_id.into()).await?;
                if status["selection"][kind].as_str().is_none() {
                    return Err(format!("Browser import did not select its library: {status}"));
                }
                Some(original.id)
            } else {
                None
            };
            let (reader, extension) = manager.load_selected_extension(app).await?;
            if reader != kind || extension.id == source_id || !extension.path.starts_with(destination.join("native-dictionaries/browser-imports")) {
                return Err("Browser import is not active in its own origin".into());
            }
            if let Some(original) = &original {
                if &extension.id == original || manager.get_home_reader_extension(OVERLAY_MAIN_LABEL).as_deref() != Some(extension.id.as_str()) {
                    return Err("Browser import did not reattach the active overlay".into());
                }
            }
            let label = "gsm-browser-import-smoke";
            let desktop = app.state::<DesktopState>();
            let token = desktop.register_window(label, "dictionary");
            let url = desktop.assets.url(&format!("chrome-extension://{}/gsm-transfer.html", extension.id))?;
            let builder = apply_shared_webview_options(WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
                .visible(false)
                .initialization_script_for_all_frames(crate::overlay_preload::render_desktop_preload(&token)));
            let page = apply_profile_data_directory(builder, &destination)?.build().map_err(|error| error.to_string())?;
            wait_window_ready(app, label, Duration::from_secs(20)).await?;
            let completed = destination.join("native-dictionaries")
                .join(format!("{}-legacy-transfer.json", extension.id));
            let summary: Value = serde_json::from_slice(&std::fs::read(completed).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let idbfs = summary["filesystemBackend"] == "idbfs";
            verify_transferred_indexeddb(app, &page, kind, &phase, idbfs).await?;
            if kind == "hachidori" && idbfs {
                let text = evaluate_raw(app, &page, r#"(async () => {
                    const request = ref => new Promise((resolve, reject) => {
                        ref.onsuccess = () => resolve(ref.result);
                        ref.onerror = () => reject(ref.error);
                    });
                    const db = await request(indexedDB.open('/dicts'));
                    const file = await request(db.transaction('FILE_DATA').objectStore('FILE_DATA')
                        .get('/dicts/.hdw-generation-fixture/日本語/index.json'));
                    db.close();
                    return new TextDecoder().decode(file.contents);
                })()"#).await?;
                if text != "日本語 dictionary" {
                    return Err(format!("Browser import IDBFS verification failed: {text}"));
                }
            }
            let _ = page.destroy();
            desktop.unregister_window(label);
            if phase == "browser-reopen" {
                let status = manager.use_original_browser_dictionary(app, kind).await?;
                let (_, original) = manager.load_selected_extension(app).await?;
                if original.id == extension.id || !status["selection"][kind].is_null() {
                    return Err(format!("Could not switch back to the original dictionary: {status}"));
                }
            }
            return Ok(json!({"reader":reader, "id":extension.id, "filesystemBackend":summary["filesystemBackend"]}));
        }
    }
    let mut expected_staged_id = None;
    if matches!(phase.as_str(), "overlay-move-import" | "overlay-move-reopen") {
        let old_stage = profile_path.join("native-dictionaries/extensions/yomitan");
        std::fs::create_dir_all(&old_stage).map_err(|error| error.to_string())?;
        let manifest = crate::dictionary_host::read_manifest(&ext_path)?;
        let id = crate::dictionary_host::extension_id_for_directory(&old_stage, &manifest, true);
        if phase == "overlay-move-import" {
            let transfers = profile_path.join("native-dictionaries/transfers");
            std::fs::create_dir_all(&transfers).map_err(|error| error.to_string())?;
            // Simulate an installation that selected its unpacked ID before fixed keys.
            std::fs::write(transfers.join(format!("{id}.json")), "{}")
                .map_err(|error| error.to_string())?;
        } else {
            let overlay = fixture_dir.join("GameSentenceMiner/Overlay");
            gsm_packages::overlay_directory::copy_profile(&profile_path, &overlay)?;
            profile_path = overlay;
        }
        expected_staged_id = Some(id);
    }
    std::env::set_var("GSM_OVERLAY_DATA_PATH", &profile_path);

    let dm = app.state::<DictionaryManager>();
    let desktop = app.state::<DesktopState>();

    if use_windows_native_extensions() {
        #[cfg(windows)]
        {
            let ext = dm.load_windows_extension(app, &ext_path).await?;
            if let Some(expected) = expected_staged_id {
                if ext.id != expected {
                    return Err(format!("Overlay move changed the extension ID from {expected} to {}", ext.id));
                }
            }
            let url = format!("chrome-extension://{}/index.html", ext.id);
            let parsed = desktop.assets.url(&url)?;
            let label = "gsm-transfer-win-smoke";
            let token = desktop.register_window(label, "dictionary");
            let preload = crate::overlay_preload::render_desktop_preload(&token);
            let mut builder = apply_shared_webview_options(
                WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
                    .visible(false)
                    .initialization_script_for_all_frames(preload),
            );
            builder = apply_profile_data_directory(builder, &profile_path)?;
            let page = builder.build().map_err(|e| e.to_string())?;
            let _ = wait_window_ready(app, label, Duration::from_secs(20)).await?;
            if phase == "probe-existing" {
                if ext.id != source_id {
                    return Err(format!("Expected existing dictionary ID {source_id}, loaded {}", ext.id));
                }
                let counts = evaluate_raw(app, &page, r#"(async () => {
                    const request = value => new Promise((resolve, reject) => {
                        value.onsuccess = () => resolve(value.result);
                        value.onerror = () => reject(value.error);
                    });
                    const counts = {};
                    for (const {name} of await indexedDB.databases()) {
                        const db = await request(indexedDB.open(name));
                        for (const store of db.objectStoreNames) {
                            if (store === 'terms' || store === 'dictionaries')
                                counts[store] = await request(db.transaction(store).objectStore(store).count());
                        }
                        db.close();
                    }
                    return counts;
                })()"#).await?;
                if counts["dictionaries"].as_u64().unwrap_or(0) == 0
                    || counts["terms"].as_u64().unwrap_or(0) == 0
                {
                    return Err(format!("Existing dictionary data was not readable: {counts}"));
                }
                return Ok(json!({"id":ext.id,"counts":counts}));
            }
            verify_transferred_indexeddb(app, &page, kind, &phase, false).await?;
            let _ = page.destroy();
            desktop.unregister_window(label);
            return Ok(json!({ "mode": "windows-native", "kind": kind, "phase": phase }));
        }
    }

    if phase != "reopen" {
        if kind == "hachidori" {
            let portable_dir = profile_path.join("portable-dictionaries");
            std::fs::create_dir_all(&portable_dir).map_err(|e| e.to_string())?;
            let manifest: Value = serde_json::from_str(
                &std::fs::read_to_string(ext_path.join("manifest.json"))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let id = if manifest.get("key").and_then(Value::as_str).is_some() {
                source_id
            } else {
                "gsm-upgraded-extension"
            };
            std::fs::write(
                portable_dir.join(format!("{id}-local.json")),
                json!({
                    "dictionaryState": { "dictionaries": [] },
                    "options": { "language": "en", "enabled": false },
                    "nativeOnly": true
                })
                .to_string(),
            )
            .map_err(|e| e.to_string())?;
        }

        desktop.assets.mount("fixture-prepare", &ext_path)?;
        let _ = desktop.assets.mount_dictionary("fixture-prepare", kind)?;
        let prep_url = desktop
            .assets
            .url("chrome-extension://fixture-prepare/__gsm_migration__.html")?;
        let prep_label = "gsm-transfer-prep";
        let prep_token = desktop.register_window(prep_label, "dictionary");
        let prep_preload = crate::overlay_preload::render_desktop_preload(&prep_token);
        let mut prep_builder = apply_shared_webview_options(
            WebviewWindowBuilder::new(app, prep_label, WebviewUrl::External(prep_url))
                .visible(false)
                .initialization_script_for_all_frames(prep_preload),
        );
        prep_builder = apply_profile_data_directory(prep_builder, &profile_path)?;
        let prep_win = prep_builder.build().map_err(|e| e.to_string())?;
        let _ = wait_window_ready(app, prep_label, Duration::from_secs(20)).await?;
        let _ = evaluate_raw(
            app,
            &prep_win,
            r#"(async()=>{
                const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
                const opening=indexedDB.open('gsm-migration-fixture',3);opening.onupgradeneeded=()=>opening.result.createObjectStore('terms');
                (await request(opening)).close();
                const logs=indexedDB.open('hachidori-debug-log',1);logs.onupgradeneeded=()=>logs.result.createObjectStore('events');
                const db=await request(logs);const tx=db.transaction('events','readwrite');tx.objectStore('events').put('native diagnostic','native');
                await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
            })()"#,
        )
        .await?;
        let _ = prep_win.destroy();
        desktop.unregister_window(prep_label);
        desktop.assets.unmount("fixture-prepare");
    }

    let ext = dm.load_portable_extension(app, &ext_path).await?;
    let target_url = format!("{}/__gsm_migration__.html", ext.base);
    let parsed = desktop.assets.url(&target_url)?;
    let label = "gsm-transfer-portable-smoke";
    let token = desktop.register_window(label, "dictionary");
    let preload_base = crate::overlay_preload::render_desktop_preload(&token);
    let dict_preload = dm.portable_preload_for_window(label, &ext, &target_url, 999_050);
    let mut builder = apply_shared_webview_options(
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
            .visible(false)
            .initialization_script_for_all_frames(format!("{preload_base}\n;{dict_preload}")),
    );
    builder = apply_profile_data_directory(builder, &profile_path)?;
    let page = builder.build().map_err(|e| e.to_string())?;
    let _ = wait_window_ready(app, label, Duration::from_secs(20)).await?;

    let summary_path = profile_path
        .join("portable-dictionaries")
        .join(format!("{}-legacy-transfer.json", ext.id));
    let summary: Value = serde_json::from_str(
        &std::fs::read_to_string(&summary_path)
            .map_err(|e| format!("Missing transfer summary: {e}"))?,
    )
    .map_err(|e| e.to_string())?;
    let expected_records = if kind == "hachidori" { 7 } else { 3 };
    if summary["records"].as_u64() != Some(expected_records) {
        return Err(format!("Unexpected transfer record count: {summary}"));
    }

    verify_transferred_indexeddb(app, &page, kind, &phase, true).await?;
    let _ = page.destroy();
    desktop.unregister_window(label);
    Ok(json!({ "mode": "portable", "kind": kind, "phase": phase }))
}

async fn verify_transferred_indexeddb(
    app: &AppHandle,
    page: &WebviewWindow,
    kind: &str,
    phase: &str,
    portable: bool,
) -> Result<(), String> {
    let result = evaluate_raw(
        app,
        page,
        r#"(async()=>{
            const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
            const db=await request(indexedDB.open('gsm-migration-fixture'));
            const tx=db.transaction(['terms','media','compound'],'readwrite');
            const term=await request(tx.objectStore('terms').get(1));
            const media=await request(tx.objectStore('media').get('sample'));
            const compound=await request(tx.objectStore('compound').get(['食べる','たべる']));
            const deleted=await request(tx.objectStore('terms').get(99));
            const nextKey=await request(tx.objectStore('terms').add({expression:'next'}));
            db.close();
            return {
                term,
                compound,
                deleted:deleted??null,
                nextKey,
                date:media.date.toISOString(),
                bytes:[...media.bytes],
                blob:await media.blob.text(),
                mime:media.blob.type,
                large:media.large.toString()
            };
        })()"#,
    )
    .await?;

    let expected_next = if matches!(phase, "reopen" | "overlay-move-reopen" | "browser-reopen") { 101 } else { 100 };
    if result["term"]["definition"].as_str() != Some("to eat")
        || result["compound"]["value"].as_i64() != Some(42)
        || !result["deleted"].is_null()
        || result["nextKey"].as_i64() != Some(expected_next)
        || result["date"].as_str() != Some("2026-01-02T03:04:05.000Z")
        || result["blob"].as_str() != Some("日本語")
        || result["mime"].as_str() != Some("text/plain")
    {
        return Err(format!(
            "Transferred IndexedDB verification failed: {result}"
        ));
    }

    if !portable && kind == "hachidori" {
        let opfs = evaluate_raw(
            app,
            page,
            r#"(async()=>{
                const root=await navigator.storage.getDirectory();
                const generation=await root.getDirectoryHandle('.hdw-generation-fixture');
                const dictionary=await generation.getDirectoryHandle('日本語');
                const file=await (await dictionary.getFileHandle('index.json')).getFile();
                const names=[];
                for await(const [name] of dictionary) names.push(name);
                return {text:await file.text(),names};
            })()"#,
        )
        .await?;
        if opfs["text"].as_str() != Some("日本語 dictionary") {
            return Err(format!("OPFS verification failed: {opfs}"));
        }
    }
    Ok(())
}

/// Exercise the real coordinator, capture worker, local recognition and result
/// delivery. The backend is isolated so no test text reaches the user's history.
#[cfg(windows)]
async fn run_ocr_flow_smoke(app: &AppHandle, bus_info: &Value) -> Result<Value, String> {
    use crate::ocr_coordinator::{self, OcrRunMode, OcrStartSource};
    use tokio_tungstenite::tungstenite::Message;
    let desktop = app.state::<DesktopState>();
    let token = desktop.register_window("gsm-ocr-smoke-target", "smoke");
    let paths = crate::desktop_services::paths_for(app);
    let fixture = paths.active.join("ocr-smoke");
    std::fs::create_dir_all(&fixture).map_err(|e| e.to_string())?;
    std::fs::write(fixture.join("index.html"), "<!doctype html><meta charset='utf-8'><body style='margin:0;background:white;color:black;font:48px Meiryo,sans-serif;padding:50px'>日本語の文章を読みます</body>").map_err(|e| e.to_string())?;
    desktop.assets.mount("ocr-smoke", &fixture)?;
    let url = desktop
        .assets
        .url(&format!("{}/ocr-smoke/index.html", crate::assets::origin()))?;
    let window = WebviewWindowBuilder::new(app, "gsm-ocr-smoke-target", WebviewUrl::External(url))
        .title("GSM OCR verification")
        .inner_size(850.0, 360.0)
        .visible(true)
        .initialization_script_for_all_frames(crate::overlay_preload::render_desktop_preload(
            &token,
        ))
        .build()
        .map_err(|e| e.to_string())?;
    wait_window_ready(app, "gsm-ocr-smoke-target", Duration::from_secs(15)).await?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize as u64;
    let scene = "Native OCR Smoke";
    app.state::<crate::obs::Obs>().set_smoke_target(scene,hwnd);
    let area_path = paths.active.join("ocr_config/NativeOCRSmoke.json");
    std::fs::create_dir_all(area_path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&area_path, json!({"scene":scene,"coordinate_system":"percentage","rectangles":[{"coordinates":[0.0,0.0,1.0,1.0],"is_excluded":false}]}).to_string()).map_err(|e| e.to_string())?;
    let engine = std::env::var("GSM_SMOKE_OCR_ENGINE").unwrap_or_else(|_| "oneocr".into());
    const SCAN_RATE_SECONDS: f64 = 0.5;
    ocr_coordinator::save_ocr_config(
        app,
        &json!({"ocr1":engine,"ocr2":engine,"twoPassOCR":true,"scanRate":SCAN_RATE_SECONDS,"text_appears_instantly":false,"base_scale":1.0,"disableNativeOcr":false,"sendToClipboard":false,"manualOcrHotkey":"","wholeWindowOcrHotkey":"","areaSelectOcrHotkey":"","addAreaOcrHotkey":"","globalPauseHotkey":""}),
    )?;
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}", bus_info["port"]))
            .await
            .map_err(|e| e.to_string())?;
    socket.send(Message::Text(json!({"v":1,"id":"hello-ocr","src":"backend","dst":"main","kind":"hello","topic":"bus.hello","data":{"token":bus_info["token"]}}).to_string().into())).await.map_err(|e| e.to_string())?;
    let welcome = socket
        .next()
        .await
        .ok_or("No backend welcome")?
        .map_err(|e| e.to_string())?;
    if serde_json::from_str::<Value>(welcome.to_text().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?["topic"]
        != "bus.welcome"
    {
        return Err("OCR smoke backend was not welcomed".into());
    }
    let (result_tx, mut result_rx) = tokio::sync::mpsc::channel(2);
    let server = tauri::async_runtime::spawn(async move {
        while let Some(Ok(message)) = socket.next().await {
            let Ok(request) = serde_json::from_str::<Value>(message.to_text().unwrap_or("")) else {
                continue;
            };
            if request["kind"] != "request" {
                continue;
            }
            let data = match request["topic"].as_str() {
                Some("ocr.native.result") => {
                    let _ = result_tx.send(request["data"].clone()).await;
                    json!({"status":"accepted"})
                }
                _ => continue,
            };
            if socket.send(Message::Text(json!({"v":1,"id":uuid::Uuid::new_v4().to_string(),"src":"backend","dst":"main","kind":"response","topic":request["topic"],"corr":request["id"],"ok":true,"data":data}).to_string().into())).await.is_err() { break; }
        }
    });
    let outcome = async {
        if std::env::var("GSM_SMOKE_SUITE").as_deref() == Ok("ocr-hotkeys") {
            // Use a separate shortcut from the user's live F15 binding. A smoke
            // profile must not open a second selector in their running game.
            ocr_coordinator::save_ocr_config(app, &json!({"areaSelectOcrHotkey":"F24", "gamepadHotkeysEnabled":false}))?;
            ocr_coordinator::start_ocr(app, OcrStartSource::User, OcrRunMode::Manual).await?;
            window.set_focus().map_err(|e| e.to_string())?;
            tokio::time::sleep(Duration::from_secs(2)).await;
            use windows::{core::w, Win32::{Foundation::{LPARAM, WPARAM}, UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*}}};
            let triggered_at = Instant::now();
            let input = [KEYBD_EVENT_FLAGS(0), KEYEVENTF_KEYUP].map(|flags| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_F24, dwFlags: flags, ..Default::default() } },
            });
            if unsafe { SendInput(&input, std::mem::size_of::<INPUT>() as i32) } != 2 {
                return Err("Could not inject F24 into the OCR fixture".into());
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                // Several GSM instances may own a selector. Search all matching
                // windows so a live instance cannot hide this fixture's result.
                let mut after = None;
                while let Ok(picker) = unsafe { FindWindowExW(None, after, w!("GsmNativeOcrSelection"), None) } {
                    let mut owner = 0;
                    unsafe { GetWindowThreadProcessId(picker, Some(&mut owner)); }
                    if owner == std::process::id() {
                        unsafe { PostMessageW(Some(picker), WM_KEYDOWN, WPARAM(VK_ESCAPE.0 as usize), LPARAM(0)) }.map_err(|e| e.to_string())?;
                        let latency_ms = triggered_at.elapsed().as_millis();
                        eprintln!("[smoke] Area selector opened after {latency_ms}ms");
                        return Ok(json!({"hotkey":"F24","areaSelectorOpened":true,"latencyMs":latency_ms,"controllerHotkeysEnabled":false}));
                    }
                    after = Some(picker);
                }
                if Instant::now() >= deadline {
                    return Err("F24 did not open the native area selector for a visible capture target".into());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        // Both manual and automatic scanning must traverse the same native path.
        let mut results = Vec::new();
        for mode in [OcrRunMode::Manual, OcrRunMode::Auto] {
            ocr_coordinator::start_ocr(app, OcrStartSource::User, mode.clone()).await?;
            if mode == OcrRunMode::Manual {
                ocr_coordinator::try_send(app, "ocr.manual-ocr", &[]);
            }
            let payload = tokio::time::timeout(Duration::from_secs(45), result_rx.recv())
                .await
                .map_err(|_| "Native OCR produced no result within 45 seconds")?
                .ok_or("OCR smoke backend closed")?;
            let text = payload["text"].as_str().unwrap_or("");
            if !text.contains("日本語") || payload["ocr_scene"] != scene {
                return Err(format!(
                    "Native OCR returned unexpected text or scene: {payload}"
                ));
            }
            let captured_at = payload["capturedAt"].as_u64().ok_or("Missing OCR capture time")?;
            let emitted_at = payload["emittedAt"].as_u64().ok_or("Missing OCR emission time")?;
            let last_scan_ms = payload["metrics"]["total_ms"].as_f64().ok_or("Missing OCR scan duration")?;
            let time_before_last_scan = emitted_at.saturating_sub(captured_at) as f64 - last_scan_ms;
            if captured_at > emitted_at
                || (mode == OcrRunMode::Auto && time_before_last_scan < SCAN_RATE_SECONDS * 1000. / 2.)
            {
                return Err(format!("Native OCR did not preserve the first capture time: {payload}"));
            }
            results.push(json!({"mode":mode.as_str(),"text":text}));
            ocr_coordinator::stop_ocr_sync(app, "smoke", None);
        }
        Ok(json!({"ocr":results,"runtime":"native"}))
    }
    .await;
    ocr_coordinator::stop_ocr_sync(app, "smoke-cleanup", None);
    server.abort();
    let _ = window.close();
    desktop.unregister_window("gsm-ocr-smoke-target");
    desktop.assets.unmount("ocr-smoke");
    outcome
}

#[cfg(not(windows))]
async fn run_ocr_flow_smoke(_app: &AppHandle, _bus_info: &Value) -> Result<Value, String> {
    Err("The local OneOCR flow check requires Windows".into())
}

async fn run_suite_smoke(app: &AppHandle, suite: &str) -> Result<Value, String> {
    if suite == "memory" {
        return memory::run(app).await;
    }
    if !matches!(
        suite,
        "runtime"
            | "foundation"
            | "home"
            | "windows"
            | "settings"
            | "workspace"
            | "overlay"
            | "services"
            | "obs"
            | "texthook"
            | "agent"
            | "ocr"
            | "ocr-flow"
            | "ocr-hotkeys"
            | "input"
            | "notifications"
    ) {
        return Err(format!("Unknown native smoke suite: {suite}"));
    }
    let bus_info =
        crate::runtime::dispatch(app, json!({ "action": "bus.info", "params": {} })).await?;
    if bus_info["port"].as_u64().unwrap_or(0) == 0
        || bus_info["token"].as_str().unwrap_or("").is_empty()
    {
        return Err(format!("Invalid runtime bus info: {bus_info}"));
    }

    // Verify core native desktop services directly in Rust.
    let settings = crate::desktop_services::invoke(app, "gsm-hub", "settings.getSettings", &[])
        .await
        .ok_or("settings.getSettings not handled")??;
    if !settings.is_object() {
        return Err("settings.getSettings did not return an object".into());
    }
    let obs_status = crate::desktop_services::invoke(app, "gsm-hub", "obs.state", &[])
        .await
        .ok_or("obs.state not handled")??;
    if !obs_status.is_object() {
        return Err("obs.state did not return an object".into());
    }
    let texthook_state = crate::desktop_services::invoke(app, "gsm-hub", "texthook.getStatus", &[])
        .await
        .ok_or("texthook.getStatus not handled")??;
    if !texthook_state.is_object() {
        return Err("texthook.getStatus did not return an object".into());
    }
    let agent_state = crate::agent::dispatch(app, json!({ "action": "state" })).await?;
    if !agent_state.is_object() {
        return Err("agent.getState did not return an object".into());
    }
    let ocr_state = crate::desktop_services::invoke(app, "gsm-hub", "ocr.get-running-state", &[])
        .await
        .ok_or("ocr.get-running-state not handled")??;
    if !ocr_state.is_object() {
        return Err("ocr.get-running-state did not return an object".into());
    }

    if matches!(suite, "ocr-flow" | "ocr-hotkeys") {
        return run_ocr_flow_smoke(app, &bus_info).await;
    }

    if suite == "home" {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let paths = crate::desktop_services::paths_for(app);
        std::fs::write(
            paths.active.join("config.json"),
            json!({"current_profile":"VN","configs":{
                "Default":{"general":{"single_port":9}},
                "VN":{"general":{"single_port":port,"texthooker_port":9}}
            }})
            .to_string(),
        )
        .map_err(|e| e.to_string())?;
        let server = tauri::async_runtime::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut request = BufReader::new(stream).lines();
            assert!(request
                .next_line()
                .await
                .unwrap()
                .unwrap()
                .starts_with("GET /get_status "));
            let mut accepts_identity = false;
            while let Some(line) = request.next_line().await.unwrap() {
                if line.is_empty() {
                    break;
                }
                accepts_identity |= line.split_once(':').is_some_and(|(name, value)| {
                    name.eq_ignore_ascii_case("accept-encoding") && value.trim() == "identity"
                });
            }
            // The single-port gateway can negotiate Brotli when Accept-Encoding is absent.
            let json = br#"{"ready":true,"obs_connected":true,"anki_connected":true}"#;
            let brotli = STANDARD
                .decode("GzgAWATqZKlfid+K0cxGEA1swIFbkEYw+rABR5FlHG53hNB+TKzd0PWuxAc=")
                .unwrap();
            let (encoding, body): (&str, &[u8]) = if accepts_identity {
                ("", json)
            } else {
                ("Content-Encoding: br\r\n", &brotli)
            };
            let mut stream = request.into_inner().into_inner();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{encoding}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(body).await.unwrap();
        });
        let status = crate::desktop_services::invoke(app, "gsm-hub", "get_gsm_status", &[])
            .await
            .ok_or("get_gsm_status not handled")??;
        server.await.map_err(|e| e.to_string())?;
        if status["ready"] != true
            || status["obs_connected"] != true
            || status["anki_connected"] != true
        {
            return Err(format!(
                "Home status did not use the active single-port backend: {status}"
            ));
        }
    }

    if suite == "input" {
        let input_app = app.clone();
        let (_, url) = tauri::async_runtime::spawn_blocking(move || {
            crate::input_server::wait_ready(&input_app, Duration::from_secs(20))
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Native input server did not start")?;
        let (mut socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| e.to_string())?;
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"type":"ping"}).to_string().into(),
            ))
            .await
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(message)) = socket.next().await {
                if message
                    .to_text()
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .is_some_and(|value| value["type"] == "pong")
                {
                    return Ok(());
                }
            }
            Err("Native input server closed without replying".to_string())
        })
        .await
        .map_err(|_| "Native input server did not answer ping")??;
        let _ = socket.close(None).await;
    }
    if suite == "notifications" {
        let current = service_call(app, "settings.notifications.get", &[]).await?;
        let mut preferences = current["preferences"].clone();
        preferences["volume"] = json!(37);
        service_call(app, "settings.notifications.save", &[preferences.clone()]).await?;
        let saved = service_call(app, "settings.notifications.get", &[]).await?;
        if saved["preferences"] != preferences {
            return Err("Notification preferences did not round-trip".into());
        }
    }
    if suite == "settings" {
        service_call(app, "settings.saveSettings", &[json!({"theme":"light"})]).await?;
        if service_call(app, "settings.getTheme", &[]).await? != "light" {
            return Err("Native theme persistence failed".into());
        }
        let status = service_call(
            app,
            "settings.onboarding.dictionary",
            &[json!({"action":"select","reader":"hachidori"})],
        )
        .await?;
        if status["reader"] != "hachidori" {
            return Err("Onboarding dictionary selection failed".into());
        }
        let status = service_call(
            app,
            "settings.onboarding.dictionary",
            &[json!({"action":"status"})],
        )
        .await?;
        if status["reader"] != "hachidori" {
            return Err("Onboarding dictionary status failed".into());
        }
    }
    if matches!(suite, "services" | "texthook") {
        let profile = crate::desktop_services::paths_for(app).active;
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let file = profile.join("config.json");
            let write = |config: Value| std::fs::write(&file, config.to_string()).map_err(|e| e.to_string());
            let mut config = json!({"current_profile":"Game", "configs":{
                "Game":{"text_processing":{"processor_order":["language_filter"],"language_filter":true},
                        "general":{"target_language":"ja"}},
                "Other":{"text_processing":{"processor_order":["language_filter"],"language_filter":true},
                         "general":{"target_language":"en"}}
            }});
            let mut finder = gsm_text_preview::HookFinder::new(profile);
            let snapshot = json!({"hooks":[{"id":"game","samples":["日本語\nEnglish"]}]});
            let blocks = ["日本語".to_owned(), "English".to_owned()];
            for (name, expected) in [("Game", "日本語"), ("Other", "English")] {
                config["current_profile"] = json!(name);
                write(config.clone())?;
                let ranked = finder.rank(&snapshot, &blocks, || false)?;
                if ranked[0]["tier"] != "exact" || ranked[0]["output"] != expected {
                    return Err(format!("Hook Finder used the wrong profile: {ranked}"));
                }
            }
            Ok(())
        }).await.map_err(|e| e.to_string())??;
    }
    if suite == "workspace" {
        let paths = crate::desktop_services::paths_for(app);
        std::fs::write(
            paths.active.join("config.json"),
            // Keep an OBS scene outside this fixture from switching the active
            // profile between saving its language and checking the preview.
            json!({"current_profile":"Preview","switch_to_default_if_not_found":false,"configs":{
                "Default":{"general":{"target_language":"ja"}},
                "Preview":{"general":{"target_language":"ja"}}
            },"experimental":{"tokenization_sudachi_dictionary":"core"}})
            .to_string(),
        )
        .map_err(|error| error.to_string())?;
        let entry = json!({"game":"Native smoke", "text":"食べる"});
        service_call(app, "textprocess.exclusions.add", &[entry.clone()]).await?;
        let listed = service_call(app, "textprocess.exclusions.list", &[]).await?;
        if !listed.to_string().contains("食べる") {
            return Err("Workspace exclusion was not saved".into());
        }
        service_call(app, "textprocess.exclusions.remove", &[entry]).await?;
        let listed = service_call(app, "textprocess.exclusions.list", &[]).await?;
        if listed.to_string().contains("食べる") {
            return Err("Workspace exclusion was not removed".into());
        }
    }

    if matches!(
        suite,
        "foundation" | "home" | "windows" | "settings" | "workspace" | "overlay"
    ) {
        let hub = crate::app_lifecycle::create_hub_window(app)?;
        let _ = wait_window_ready(app, hub.label(), Duration::from_secs(20)).await?;
        let bridge_check = evaluate_raw(
            app,
            &hub,
            "({ hasIpc: typeof window.ipcRenderer?.invoke === 'function', hasFind: typeof window.__GSM_FIND__ === 'function' })",
        )
        .await?;
        if bridge_check["hasIpc"].as_bool() != Some(true)
            || bridge_check["hasFind"].as_bool() != Some(true)
        {
            return Err(format!("Hub preload bridge check failed: {bridge_check}"));
        }
        if suite == "workspace" {
            let saved = evaluate_raw(app, &hub,
                "window.ipcRenderer.invoke('settings.onboarding.language', 'ko')").await?;
            if saved != json!({"success":true,"language":"ko"}) {
                return Err(format!("Learning language save failed: {saved}"));
            }
            let preview = evaluate_raw(app, &hub, r#"window.ipcRenderer.invoke('textprocess.preview', {
                text: 'MENU\r\nSpeaker: 「한국어 HP 10！」 Next\r\n日本語',
                config: { language_filter: true, language_filter_config: { mode: 'trim' } }
            })"#).await?;
            if preview != json!({"success":true,"result":"「한국어"}) {
                return Err(format!("Text Processing preview without Python failed: {preview}"));
            }
            let poll = "window.ipcRenderer.invoke('settings.onboarding.sudachi', {action:'status'})";
            let status = evaluate_raw(app, &hub, poll).await?;
            if status["state"] != "setup_required" || status["dictionary"] != "core" {
                return Err(format!("Unexpected fresh Sudachi status: {status}"));
            }
            if let Some(dictionary) = std::env::var_os("GSM_TEST_SUDACHI_DICTIONARY") {
                let release = status["release"].as_str().ok_or("Missing Sudachi release")?;
                let dir = crate::desktop_services::paths_for(app).active
                    .join("sudachi").join(format!("v{release}-small"));
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                std::fs::copy(dictionary, dir.join("system_small.dic")).map_err(|e| e.to_string())?;
                let started = evaluate_raw(app, &hub,
                    "window.ipcRenderer.invoke('settings.onboarding.sudachi', {action:'install',dictionary:'small'})").await?;
                if started["state"] != "installing" { return Err(format!("Install failed: {started}")); }
                let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
                loop {
                    let status = evaluate_raw(app, &hub, poll).await?;
                    if status["state"] == "ready" && status["dictionary"] == "small" { break; }
                    if status["state"] != "installing" || tokio::time::Instant::now() >= deadline {
                        return Err(format!("Sudachi installation did not become ready: {status}"));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
        if suite == "windows" {
            smoke_close_to_tray(app, &hub).await?;
        }
    }

    if suite == "overlay" {
        // This suite drives capture transitions itself. An unrelated live OBS
        // disconnect must not close the fixture window in the middle of a check.
        #[cfg(windows)]
        let fixture_hwnd = {
            let window = crate::app_lifecycle::create_hub_window(app)?;
            let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize as u64;
            app.state::<crate::obs::Obs>().set_smoke_target("Guide game", hwnd);
            Some(hwnd)
        };
        #[cfg(not(windows))]
        let fixture_hwnd: Option<u64> = None;
        let overlay_data = overlay_data_path(app);
        std::fs::create_dir_all(&overlay_data).map_err(|e| e.to_string())?;
        let guide_catalogue = overlay_data.join("test-catalogue");
        let guide_game = guide_catalogue.join("test-game");
        std::fs::create_dir_all(&guide_game).map_err(|e| e.to_string())?;
        for (file, data) in [
            (
                "catalog.json",
                json!({"vndb_id":"v93","title":"Test VN guide"}),
            ),
            (
                "guide.json",
                json!({"vndb_id":"v93","title":"Test VN guide","routes":[
                    {"id":"first","title":"First route","reviewed":true},
                    {"id":"second","title":"Second route","reviewed":true}
                ]}),
            ),
            (
                "route_first.json",
                json!([{"simpleJp":"公園に行く"},{"simpleJp":"図書館に行く"}]),
            ),
            ("route_second.json", json!([{"simpleJp":"家に帰る"}])),
        ] {
            std::fs::write(guide_game.join(file), data.to_string()).map_err(|e| e.to_string())?;
        }
        std::fs::write(
            overlay_data.join("settings.json"),
            json!({
                "dictionaryReaderSelection": "hachidori",
                "pushToShowEnforcedDialogDismissed": true,
                "mainBoxStartupWarningAcknowledged": true,
                "openSettingsOnStartup": false,
                "hideOnStartup": true,
                "manualMode": true,
                "showHotkey": "Control+Alt+Shift+F11",
                "enableJitenReader": true,
                "gamepadEnabled": false,
                "gamepadControllerEnabled": false,
                "gamepadKeyboardEnabled": false,
                "routeAllHotkeysThroughInputServer": false
                ,"vnGuideCatalogueSource":guide_catalogue.to_string_lossy()
            })
            .to_string(),
        )
        .map_err(|e| e.to_string())?;

        let host = app.state::<crate::overlay_host::OverlayHost>();
        host.prepare(app).await?;
        let prepared = wait_window_ready(app, OVERLAY_MAIN_LABEL, Duration::from_secs(25)).await?;
        if prepared.is_visible().unwrap_or(true) || host.status()["isRunning"] != false {
            return Err("Preparing the overlay activated it".into());
        }
        host.handle_send(app, OVERLAY_MAIN_LABEL, "show", &[]).await;
        host.handle_send(app, OVERLAY_MAIN_LABEL, "gamepad-request-focus", &[]).await;
        host.handle_send(app, OVERLAY_MAIN_LABEL, "set-ignore-mouse-events", &[json!(false)]).await;
        if prepared.is_visible().unwrap_or(true) { return Err("Disabled overlay accepted a stale show request".into()); }
        let inactive_capture = host.handle_invoke(app, OVERLAY_MAIN_LABEL, "overlay-native-command", &[json!({"action":"start"})]).await;
        if !matches!(inactive_capture, Some(Err(_))) { return Err("Prepared overlay accepted capture before activation".into()); }
        let started = crate::desktop_services::invoke(app, "gsm-hub", "runOverlay", &[])
            .await
            .ok_or("runOverlay not handled")??;
        if started.as_bool() != Some(true) {
            return Err(format!("Expected runOverlay to return true, got {started}"));
        }
        let status = crate::desktop_services::invoke(app, "gsm-hub", "getOverlayStatus", &[])
            .await
            .ok_or("getOverlayStatus not handled")??;
        if status["isRunning"].as_bool() != Some(true) || !status["pid"].is_null() {
            return Err(format!("Unexpected overlay status: {status}"));
        }
        let main_win = wait_window_ready(app, OVERLAY_MAIN_LABEL, Duration::from_secs(25)).await?;
        wait_overlay_dictionary(app).await?;
        let initialized = evaluate_raw(
            app,
            &main_win,
            r#"(async()=>{
            for(let i=0;i<100;i++) {
                if(display?.physicalBounds?.width>0 && manualMode===true) return true;
                await new Promise(resolve=>setTimeout(resolve,50));
            }
            throw Error('Overlay did not receive its initial display and settings');
        })()"#,
        )
        .await?;
        if initialized != true {
            return Err("Overlay initialization failed".into());
        }
        let port = crate::input_server::port(app).ok_or("Input service endpoint missing")?;
        let endpoint = evaluate_raw(app, &main_win, "gamepadSettings.serverUrl").await?;
        if endpoint.as_str() != Some(format!("ws://localhost:{port}").as_str()) {
            return Err(format!(
                "Overlay tokenizer received stale input endpoint: {endpoint}"
            ));
        }
        let host = app.state::<crate::overlay_host::OverlayHost>();
        #[cfg(windows)]
        smoke_overlay_unclipped(app, &main_win).await?;
        let jiten_ready = evaluate_raw(app, &main_win, r#"new Promise((resolve,reject)=>{
            const requestId='native-smoke-jiten';
            const listener=event=>{if(event.source===window && event.data?.type==='gsm-jiten-settings-response' && event.data.requestId===requestId) {
                window.removeEventListener('message',listener); clearInterval(retry); clearTimeout(timeout); resolve(true);
            }};
            window.addEventListener('message',listener);
            const retry=setInterval(()=>window.postMessage({type:'gsm-jiten-settings-request',requestId},'*'),100);
            const timeout=setTimeout(()=>{clearInterval(retry);window.removeEventListener('message',listener);reject(Error('Jiten settings bridge did not load alongside the dictionary'));},8000);
        })"#).await?;
        if jiten_ready != true {
            return Err("Jiten bridge unavailable".into());
        }
        smoke_jiten_broker(app).await?;
        host.apply_setting_updates(app, serde_json::from_value(json!({
            "overlaySettingsProfilesEnabled":true,"overlayProfileSettings":{"VN":{"fontSize":72}}
        })).unwrap(), true);
        host.handle_ws2_text(
            app,
            &json!({"type":"gsm-profile-state-updated","currentProfileName":"VN",
            "profiles":[{"name":"Default","scenes":[]},{"name":"VN","scenes":["Game"]}]})
            .to_string(),
        )
        .await;
        let profile_font = evaluate_raw(app, &main_win, r#"(async()=>{for(let i=0;i<50;i++){
            if(document.getElementById('text').style.fontSize==='72px') return true; await new Promise(r=>setTimeout(r,20));} return false;})()"#).await?;
        if profile_font != true {
            return Err("Overlay did not apply backend profile settings".into());
        }
        let state = evaluate_raw(
            app,
            &main_win,
            "({ shell: window.gsmEnv?.shell, pinyin: window.require?.('pinyin-pro')?.pinyin('中文') })",
        )
        .await?;
        if state["shell"].as_str() != Some("tauri") || state["pinyin"].as_str() != Some("zhōng wén")
        {
            return Err(format!("Unexpected overlay window environment: {state}"));
        }

        let open_res =
            crate::desktop_services::invoke(app, "gsm-hub", "settings.openOverlaySettings", &[])
                .await
                .ok_or("settings.openOverlaySettings not handled")??;
        if open_res["success"].as_bool() != Some(true) {
            return Err(format!("openOverlaySettings failed: {open_res}"));
        }
        let settings_win =
            wait_window_ready(app, OVERLAY_SETTINGS_LABEL, Duration::from_secs(20)).await?;
        let mut visible = false;
        // A hidden WebKit view may defer paint until the 3s first-open fallback.
        for _ in 0..200 {
            if settings_win.is_visible().map_err(|e| e.to_string())? {
                visible = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if !visible {
            return Err("First-open overlay settings stayed hidden".into());
        }
        if app.tray_by_id(crate::overlay_tray::ID).is_none() {
            return Err("Overlay tray was not created".into());
        }
        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::*;
            host.apply_setting_updates(app, serde_json::from_value(json!({"overlaySettingsHotkey":"Control+Alt+Shift+F10","routeAllHotkeysThroughInputServer":false})).unwrap(),false);
            settings_win.hide().map_err(|e| e.to_string())?;
            let keys = [VK_CONTROL, VK_MENU, VK_SHIFT, VK_F10];
            let input: Vec<INPUT> = keys
                .iter()
                .copied()
                .map(|key| (key, KEYBD_EVENT_FLAGS(0)))
                .chain(keys.iter().rev().copied().map(|key| (key, KEYEVENTF_KEYUP)))
                .map(|(key, flags)| INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: key,
                            dwFlags: flags,
                            ..Default::default()
                        },
                    },
                })
                .collect();
            if unsafe { SendInput(&input, std::mem::size_of::<INPUT>() as i32) }
                != input.len() as u32
            {
                return Err("Could not inject the overlay settings shortcut".into());
            }
            for _ in 0..80 {
                if settings_win.is_visible().unwrap_or(false) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            if !settings_win.is_visible().unwrap_or(false) {
                return Err("Native settings shortcut did not reveal Overlay Settings".into());
            }
        }
        host.open_settings(app, Some("hotkeys")).await?;
        let hotkeys = evaluate_raw(
            app,
            &settings_win,
            r#"(async()=>{for(let i=0;i<40;i++) {
            if(window.GSMSettingsNavigation?.activePage?.id === 'interaction-hotkeys') return true;
            await new Promise(r=>setTimeout(r,25));
        } return false;})()"#,
        )
        .await?;
        if hotkeys != true {
            return Err("Overlay settings did not select Hotkeys".into());
        }
        smoke_vn_guide(app, &settings_win).await?;

        let theme =
            crate::desktop_services::invoke(app, OVERLAY_SETTINGS_LABEL, "settings.getTheme", &[])
                .await
                .ok_or("Overlay theme channel was not routed")??;
        if theme.as_str().is_none() {
            return Err(format!("Invalid overlay theme: {theme}"));
        }
        for monitor in crate::overlay_magpie::collect_displays(app).iter().rev() {
            let bounds = &monitor.physical_bounds;
            app.state::<crate::overlay_host::OverlayHost>().handle_ws2_text(app, &json!({
                "type":"native-overlay-command", "action":"configure", "config":{
                    "available":false, "settings":{
                        "monitor_to_capture":0,"monitor_to_capture_id":"0",
                        "monitor_to_capture_bounds":{"left":bounds.x,"top":bounds.y,"width":bounds.width,"height":bounds.height}
                    }
                }
            }).to_string()).await;
            let mut matched = false;
            for _ in 0..40 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let position = main_win.outer_position().map_err(|e| e.to_string())?;
                let size = main_win.inner_size().map_err(|e| e.to_string())?;
                let rendered = evaluate_raw(app, &main_win, "display?.physicalBounds").await?;
                if position.x == bounds.x as i32
                    && position.y == bounds.y as i32
                    && size.width == bounds.width as u32
                    && size.height == bounds.height as u32
                    && rendered["x"].as_f64() == Some(bounds.x)
                    && rendered["y"].as_f64() == Some(bounds.y)
                {
                    matched = true;
                    break;
                }
            }
            if !matched {
                return Err(format!(
                    "Overlay failed to follow monitor {}",
                    monitor.label
                ));
            }
        }
        evaluate_raw(app, &main_win, include_str!("../smoke/overlay.js")).await?;
        evaluate_raw(app, &main_win, "window.__gsmSmokeOverlay.geometry()").await?;
        host.handle_ws2_text(
            app,
            &json!({"type":"capture_status","available":true,"window_state":"active"}).to_string(),
        )
        .await;
        evaluate_raw(app, &main_win, r#"(() => {
            window.__gsmNativePointerSamples = 0;
            require('electron').ipcRenderer.on('text-hover-pointer', () => window.__gsmNativePointerSamples++);
        })()"#).await?;
        for state in [
            "obscured",
            "active",
            "minimized",
            "background",
            "closed",
            "active",
        ] {
            let previous_samples = evaluate_raw(app, &main_win, "window.__gsmNativePointerSamples").await?;
            host.present_session(app, &json!({
                "scene":"Guide game", "available": !matches!(state, "closed" | "minimized"),
                "window_state":{"type":"window_state", "data":state, "game":"Guide game",
                    "target_hwnd":fixture_hwnd, "occlusion_rects":[]}
            })).await;
            let expected = matches!(state, "active" | "background");
            let mut matched = false;
            for _ in 0..40 {
                tokio::time::sleep(Duration::from_millis(25)).await;
                if main_win.is_visible().map_err(|e| e.to_string())? == expected {
                    matched = true;
                    break;
                }
            }
            if !matched {
                return Err(format!("Overlay visibility did not follow {state}"));
            }
            #[cfg(windows)]
            if crate::windows_input::forwarding_interval(&main_win).is_some() != expected {
                return Err(format!("Overlay pointer forwarding did not follow game state {state}"));
            }
            #[cfg(windows)]
            if expected {
                evaluate_raw(app, &main_win, &format!(r#"(async()=>{{
                    for(let i=0;i<40;i++) {{
                        if(window.__gsmNativePointerSamples > {previous_samples}) return true;
                        await new Promise(r=>setTimeout(r,25));
                    }}
                    throw Error('No real native hover samples after returning to {state}');
                }})()"#)).await?;
            }
        }

        host.apply_setting_updates(app, serde_json::from_value(json!({
            "manualMode":false, "showLiveStats":true, "liveStatsScope":"today", "liveStatsDisplayModeV2":"always"
        })).unwrap(), true);
        host.handle_ws2_text(app, &json!({
            "type":"live_stats_update","scope":"today","reason":"refresh","game_name":"Guide game",
            "updated_at":chrono::Utc::now().timestamp_micros() as f64 / 1e6,"period_end":chrono::Utc::now().timestamp()+3600,
            "values":{"total_characters":927}
        }).to_string()).await;
        evaluate_raw(app, &main_win, r#"(async()=>{
            for(let i=0;i<40;i++) {
                const chars = document.querySelector('#gsm-live-stats.gsm-live-stats-visible [data-field-key="total_characters"]');
                if (chars?.dataset.text === '927' && chars.getBoundingClientRect().width > 0) return true;
                await new Promise(resolve=>setTimeout(resolve,50));
            }
            const widget = document.getElementById('gsm-live-stats');
            throw Error('Daily characters did not appear in the game overlay: ' +
                JSON.stringify({classes: widget?.className, characters: widget?.querySelector('[data-field-key="total_characters"]')?.dataset.text}));
        })()"#).await?;
        eprintln!("[smoke] Captured window transitions and visible Today character total passed");

        #[cfg(windows)]
        smoke_overlay_clickthrough(app, &main_win).await?;

        host.apply_setting_updates(app, serde_json::from_value(json!({
            "manualMode":true, "manualModeInactiveBehavior":"hide-overlay",
            "manual_mode_desktop_background":"off", "gamepadEnabled":true,
            "gamepadControllerEnabled":false, "gamepadKeyboardEnabled":false,
            "gamepadAutoConfirmSelection":false, "gamepadFocusOverlayOnEntry":false,
            "scan_on_overlay_activation":false,
        })).unwrap(), true);
        evaluate_raw(app, &main_win, include_str!("../smoke/gamepad_activation.js")).await?;
        eprintln!("[smoke] Controller navigation revealed manual overlay without a manual hotkey, exited, and reentered");

        let stopped =
            crate::desktop_services::invoke(app, "gsm-hub", "setOverlayEnabled", &[json!(false)])
                .await
                .ok_or("setOverlayEnabled not handled")??;
        if stopped["isRunning"].as_bool() != Some(false) {
            return Err(format!(
                "setOverlayEnabled(false) did not stop overlay: {stopped}"
            ));
        }
        #[cfg(windows)]
        if crate::windows_input::forwarding_interval(&main_win).is_some() {
            return Err("Disabled overlay still polls the mouse".into());
        }
        if app.tray_by_id(crate::overlay_tray::ID).is_some() {
            return Err("Overlay tray survived stop".into());
        }
        if app
            .get_webview_window(crate::overlay_host::OVERLAY_TEXTHOOKER_LABEL)
            .is_some()
        {
            return Err("Overlay Text Feed survived stop".into());
        }
    }

    Ok(json!({ "suite": suite }))
}

#[cfg(windows)]
async fn smoke_overlay_clickthrough(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT};
    let ignores_cursor = || -> Result<bool, String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        Ok(unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_TRANSPARENT.0 as isize != 0)
    };
    let host = app.state::<crate::overlay_host::OverlayHost>();
    host.apply_setting_updates(app, serde_json::from_value(json!({
        "manualMode":false, "pinned":false, "textHoverClickThrough":true,
        "focusOverlayOnYomitanLookup":false,
    })).unwrap(), true);
    evaluate_raw(app, window, r#"(async()=>{for(let i=0;i<100;i++){
        if(!manualMode && textHoverClickThrough) return true;
        await new Promise(r=>setTimeout(r,20));
    } throw Error('Clickthrough settings were not delivered');})()"#).await?;
    evaluate_raw(app, window, include_str!("../smoke/clickthrough.js")).await?;
    host.handle_send(app, OVERLAY_MAIN_LABEL, "yomitan-event", &[json!(true)]).await;
    // Held-button routing is covered by text_hover tests. The user's real
    // buttons are not held here; WebView may emit genuine enter/leave events
    // when its native ownership changes, so do not fake an OS drag.
    for (target, buttons, expected_ignore) in [
        ("text", 0, true), ("popup", 0, false), ("text", 0, true),
    ] {
        evaluate_raw(app, window, &format!("window.__gsmClickthrough.point({}, {buttons})", json!(target))).await?;
        let mut matched = false;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(25)).await;
            if ignores_cursor()? == expected_ignore { matched = true; break; }
        }
        if !matched { return Err(format!("Native clickthrough failed over {target} with buttons={buttons}")); }
        if crate::windows_input::forwarding_interval(window).is_none() {
            return Err("Pointer feed stopped while the overlay was interactive".into());
        }
    }
    host.apply_setting_updates(app, serde_json::from_value(json!({"textHoverClickThrough":false})).unwrap(), true);
    evaluate_raw(app, window, r#"(async()=>{for(let i=0;i<100;i++){
        if(!textHoverClickThrough) return window.__gsmClickthrough.point('text');
        await new Promise(r=>setTimeout(r,20));
    } throw Error('Clickthrough preference was not delivered');})()"#).await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    if ignores_cursor()? {
        return Err("Disabling clickthrough did not restore text interaction".into());
    }
    // The VN guide fixture selected the route starting with 家に帰る. Keep the
    // pointer stationary over text and let detection alone change its recipient.
    let menu = json!({"type":"word_coordinates","is_final":true,"line_id":"pointer-menu","data":[
        {"text":"家に帰る","bounding_rect":{"x1":0.4,"y1":0.40,"x3":0.6,"y3":0.44}},
        {"text":"公園に行く","bounding_rect":{"x1":0.4,"y1":0.54,"x3":0.6,"y3":0.58}}
    ]});
    for (frame, expected_ignore) in [(menu, true), (json!({"type":"overlay_clear"}), false)] {
        host.handle_send(app, OVERLAY_MAIN_LABEL, "text-received", &[frame]).await;
        let deadline = Instant::now() + Duration::from_secs(2);
        while ignores_cursor()? != expected_ignore {
            if Instant::now() >= deadline {
                return Err(format!("VN Guide choice did not set native click-through to {expected_ignore}"));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    evaluate_raw(app, window, "window.__gsmClickthrough.cleanup()").await?;
    host.handle_send(app, OVERLAY_MAIN_LABEL, "yomitan-event", &[json!(false)]).await;
    // Let visibility messages complete before checking the actual native timer.
    for visible in [false, true, false, true] {
        if visible { window.show() } else { window.hide() }.map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        if crate::windows_input::forwarding_interval(window).is_some() != visible {
            return Err(format!("Pointer timer did not follow visible={visible}"));
        }
    }
    eprintln!("[smoke] Clickthrough: popup hit testing, preference, native forwarding, hide/show timer lifecycle passed");
    Ok(())
}

#[cfg(windows)]
async fn smoke_overlay_unclipped(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{CreateRectRgn, DeleteObject, GetRgnBox, GetWindowRgn},
    };

    let host = app.state::<crate::overlay_host::OverlayHost>();
    // The legacy preload reports only the immediate-text box. Hidden, it is
    // just 20x20 pixels of padding; shown, it still excludes OCR and widgets.
    for shape in [
        json!({"x":0,"y":0,"width":20,"height":20}),
        json!({"x":120,"y":240,"width":400,"height":80}),
    ] {
        if !host
            .handle_send(
                app,
                OVERLAY_MAIN_LABEL,
                "update-window-shape",
                &[shape.clone()],
            )
            .await
        {
            return Err("Legacy overlay shape message was not handled".into());
        }
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe {
            let region = CreateRectRgn(0, 0, 0, 0);
            if region.is_invalid() {
                return Err("Could not inspect the native overlay region".into());
            }
            let kind = GetWindowRgn(hwnd, region);
            let mut bounds = RECT::default();
            GetRgnBox(region, &mut bounds);
            let _ = DeleteObject(region.into());
            // GetWindowRgn returns ERROR (0) when no clipping region is set.
            if kind.0 != 0 {
                return Err(format!(
                    "Legacy text-box shape {shape} clipped the overlay to {},{},{},{}",
                    bounds.left, bounds.top, bounds.right, bounds.bottom
                ));
            }
        }
    }
    Ok(())
}

async fn service_call(app: &AppHandle, channel: &str, args: &[Value]) -> Result<Value, String> {
    crate::desktop_services::invoke(app, "gsm-hub", channel, args)
        .await
        .ok_or_else(|| format!("Native service did not handle {channel}"))?
}

async fn smoke_vn_guide(app: &AppHandle, settings_win: &WebviewWindow) -> Result<(), String> {
    let host = app.state::<crate::overlay_host::OverlayHost>();
    host.handle_ws2_text(app, &json!({"type":"capture_status","scene_name":"Guide game","available":true,"window_state":"active"}).to_string()).await;
    let picked = evaluate_raw(app, settings_win, r#"(async()=>{
        const ipc=require('electron').ipcRenderer;
        const select=document.getElementById('vn-guide-catalogue');
        for(let i=0;i<100 && select.options.length<2;i++) await new Promise(r=>setTimeout(r,50));
        if(select.options.length!==2 || !select.options[1].text.includes('Test VN guide'))
            throw Error('The picker ignored the saved local catalogue: '+document.getElementById('vn-guide-catalogue-status')?.textContent);
        select.value=select.options[1].value;
        select.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<100;i++){
            const state=await ipc.invoke('vn-guide-state');
            if(state.enabled && state.total===2 && !document.getElementById('vn-guide-next').disabled) return state;
            await new Promise(r=>setTimeout(r,50));
        }
        throw Error('Selecting a guide did not enable and load it: '+document.getElementById('vn-guide-status').textContent);
    })()"#).await?;
    if picked["routeId"] != "first" || picked["text"] != "公園に行く" || picked["visible"] != false
    {
        return Err(format!("Unexpected imported guide state: {picked}"));
    }
    // Window titles and OBS scene names are different identities. Both the
    // backend event and its renderer echo must preserve a manual guide preview.
    for (action, index) in [("toggle", 0), ("next", 1)] {
        evaluate_raw(app, settings_win, &format!(
            "require('electron').ipcRenderer.invoke('vn-guide-command',{{action:'{action}'}})"
        )).await?;
        for title in ["Test game window", "Test game window - Power Save Mode"] {
            host.handle_ws2_text(app, &json!({
                "type":"window_state", "data":"active", "game":title
            }).to_string()).await;
            host.handle_send(app, crate::overlay_host::OVERLAY_MAIN_LABEL,
                "window-state-changed", &[json!({"state":"active", "game":title})]).await;
            host.handle_ws2_text(app, &json!({"type":"capture_status",
                "scene_name":"Guide game", "available":true, "window_state":"active"
            }).to_string()).await;
            let state = evaluate_raw(app, settings_win,
                "require('electron').ipcRenderer.invoke('vn-guide-state')").await?;
            if state["visible"] != true || state["index"] != index {
                return Err(format!("Guide {action} preview was cancelled by a window-title update: {state}"));
            }
        }
        evaluate_raw(app, settings_win, r#"(async()=>{
            const ipc=require('electron').ipcRenderer;
            await ipc.invoke('vn-guide-command',{action:'jump',value:0});
            return ipc.invoke('vn-guide-command',{action:'hide'});
        })()"#).await?;
    }
    host.handle_ws2_text(app, &json!({"type":"word_coordinates","is_final":true,"line_id":"guide-choice","presence_id":"guide-choice","data":[
        {"text":"公園に行く","bounding_rect":{"x1":0.4,"y1":0.40,"x3":0.6,"y3":0.44}},
        {"text":"家に帰る","bounding_rect":{"x1":0.4,"y1":0.48,"x3":0.6,"y3":0.52}}
    ]}).to_string()).await;
    let detected = evaluate_raw(
        app,
        settings_win,
        "require('electron').ipcRenderer.invoke('vn-guide-state')",
    )
    .await?;
    if detected["detected"] != true || detected["visible"] != true {
        return Err(format!(
            "Guide did not detect the OCR choice menu: {detected}"
        ));
    }
    let hud = wait_window_ready(
        app,
        crate::overlay_host::OVERLAY_VN_GUIDE_LABEL,
        Duration::from_secs(20),
    )
    .await?;
    let hud_text = evaluate_raw(app, &hud, r#"(async()=>{for(let i=0;i<50;i++){
        if(document.body.textContent.includes('公園に行く')) return true;await new Promise(r=>setTimeout(r,40));}return false;})()"#).await?;
    if hud_text != true {
        return Err("Detected guide choice did not reach its HUD".into());
    }
    // Exercise the migrated native window policy through the real settings UI.
    for style in ["text", "card"] {
        evaluate_raw(app, settings_win, &format!(r#"(async()=>{{
            const select=document.getElementById('vnGuideDisplayStyle');
            select.value='{style}';select.dispatchEvent(new Event('change',{{bubbles:true}}));
            for(let i=0;i<100;i++){{
                const state=await require('electron').ipcRenderer.invoke('vn-guide-state');
                if(state.displayStyle==='{style}')return true;
                await new Promise(r=>setTimeout(r,50));
            }}throw Error('Guide appearance setting did not apply');
        }})()"#)).await?;
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT,
            };
            let hwnd = hud.hwnd().map_err(|e| e.to_string())?;
            let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
            let passthrough = ex_style & WS_EX_TRANSPARENT.0 as isize != 0;
            if passthrough != (style == "text") {
                return Err(format!("Guide {style} appearance has incorrect click-through behavior"));
            }
            if ex_style & WS_EX_LAYERED.0 as isize == 0 {
                return Err(format!("Guide {style} appearance lost its transparent native surface"));
            }
        }
    }
    host.handle_ws2_text(app, &json!({"type":"word_coordinates","is_final":true,"line_id":"guide-dialogue","presence_id":"guide-dialogue","data":[
        {"text":"公園に着いた。","bounding_rect":{"x1":0.2,"y1":0.8,"x3":0.5,"y3":0.84}}
    ]}).to_string()).await;
    let advanced = evaluate_raw(
        app,
        settings_win,
        "require('electron').ipcRenderer.invoke('vn-guide-state')",
    )
    .await?;
    if advanced["index"] != 1 {
        return Err(format!("Guide did not advance after choice: {advanced}"));
    }
    // No state queries or fresh game frames: maintenance itself must expire the HUD.
    let deadline = Instant::now() + Duration::from_secs(7);
    while hud.is_visible().unwrap_or(false) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if hud.is_visible().unwrap_or(false) {
        return Err("Guide confirmation did not expire without incoming game text".into());
    }
    // Reveal the next instruction after its confirmation, then exercise actual HUD buttons.
    evaluate_raw(
        app,
        settings_win,
        "require('electron').ipcRenderer.invoke('vn-guide-command',{action:'next'})",
    )
    .await?;
    for (action, index) in [("back", 0), ("next", 1)] {
        evaluate_raw(
            app,
            &hud,
            &format!(
                r#"(async()=>{{
            const button=document.getElementById('{action}');
            for(let i=0;i<50 && button.disabled;i++)await new Promise(r=>setTimeout(r,40));
            if(button.disabled)throw Error('HUD button remained disabled: {action}');
            button.click();return true;
        }})()"#
            ),
        )
        .await?;
        let state = evaluate_raw(app, settings_win, &format!(r#"(async()=>{{
            for(let i=0;i<50;i++){{const state=await require('electron').ipcRenderer.invoke('vn-guide-state');
                if(state.index==={index})return true;await new Promise(r=>setTimeout(r,40));}}
            return false;
        }})()"#)).await?;
        if state != true {
            return Err(format!(
                "HUD {action} command did not change guide progress"
            ));
        }
    }
    for (scene, enabled) in [("Other game", false), ("Guide game", true)] {
        host.handle_ws2_text(app, &json!({"type":"capture_status","scene_name":scene,"available":false,"window_state":"closed"}).to_string()).await;
        let state = evaluate_raw(
            app,
            settings_win,
            "require('electron').ipcRenderer.invoke('vn-guide-state')",
        )
        .await?;
        if state["enabled"] != enabled || (enabled && state["index"] != 1) {
            return Err(format!(
                "Guide selection/progress did not follow scene {scene}: {state}"
            ));
        }
    }
    let invalid = evaluate_raw(app, settings_win, "require('electron').ipcRenderer.invoke('vn-guide-command',{action:'select-guide',value:'invalid'})").await?;
    if invalid["error"].as_str().is_none_or(str::is_empty) || invalid["total"] != 2 {
        return Err(format!(
            "Invalid guide selection did not preserve the loaded guide: {invalid}"
        ));
    }
    let route = evaluate_raw(app, settings_win, r#"(async()=>{
        const select=document.getElementById('vnGuideRoute');select.value='second';select.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<100;i++){const state=await require('electron').ipcRenderer.invoke('vn-guide-state');
            if(state.routeId==='second' && state.total===1)return state;await new Promise(r=>setTimeout(r,50));}
        throw Error('Route picker did not load second route');
    })()"#).await?;
    if route["text"] != "家に帰る" {
        return Err(format!("Unexpected route: {route}"));
    }
    Ok(())
}
