//! Native windows for reviewing a mined note now or after the game closes.
mod editor;
mod reviews;

use crate::{desktop_state::DesktopState, mining::MiningService, settings::Settings};
use editor::Editor;
use gsm_mining::{config::ProfileConfig, ffmpeg::MediaTools, text::GameLine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const CONFIRMATION: &str = "gsm-anki-confirmation";
const REVIEW: &str = "gsm-session-review";
const CLOSE_EVENT: &str = "cardDialog.requestClose";
type SharedEditor = Arc<AsyncMutex<Editor>>;

#[derive(Default)]
pub(crate) struct Windows {
    confirmation: Mutex<Option<Confirmation>>,
    review: Mutex<HashMap<String, SharedEditor>>,
    opening_review: AsyncMutex<()>,
    opening_confirmation: AsyncMutex<()>,
    saving_review: AsyncMutex<()>,
    confirmation_disabled: AtomicBool,
    started: AtomicBool,
}

struct Confirmation {
    editor: SharedEditor,
    answer: oneshot::Sender<Value>,
    ready: Option<oneshot::Sender<()>>,
}

fn media_tools(app: &AppHandle) -> MediaTools {
    MediaTools::discover(
        Some(&app.state::<Settings>().paths.shared),
        app.state::<Arc<MiningService>>().temp_dir(),
    )
}

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn settings(app: &AppHandle) -> Value {
    let service = app.state::<Arc<MiningService>>();
    service
        .load_snapshot()
        .ok()
        .and_then(|snapshot| {
            gsm_settings::gsm_config::active_profile(&snapshot.document)
                .and_then(|p| p.get("anki"))
                .cloned()
        })
        .unwrap_or_default()
}

fn create_window(
    app: &AppHandle,
    review: bool,
    focus: bool,
    top: bool,
) -> Result<WebviewWindow, String> {
    let (label, kind, geometry, title, size, min_size) = if review {
        (
            REVIEW,
            "session-review",
            "session_review",
            "Review Anki cards after session",
            (1180., 790.),
            (810., 550.),
        )
    } else {
        (
            CONFIRMATION,
            "anki-confirmation",
            "anki_confirmation_split",
            "Confirm Anki Card Details",
            (820., 600.),
            (620., 450.),
        )
    };
    let mut url = crate::app_lifecycle::desktop_renderer_url(app)?;
    url.query_pairs_mut().append_pair("window", kind);
    if review && !focus {
        url.query_pairs_mut().append_pair("live", "1");
    }
    let origin = url.origin();
    let page = url.path().to_owned();
    let data = crate::dictionary_host::overlay_data_path(app);
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let desktop = app.state::<DesktopState>();
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min_size.0, min_size.1)
        .center()
        .visible(false)
        .focused(focus)
        .always_on_top(top)
        .on_navigation(move |url| url.origin() == origin && url.path() == page)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    let builder = crate::dictionary_host::apply_profile_data_directory(
        crate::dictionary_host::apply_shared_webview_options(builder),
        &data,
    )?;
    let token = desktop.register_window(label, "card-dialog");
    let preload = crate::overlay_preload::render_desktop_window_preload(
        &token,
        Some(&crate::desktop_state::theme_for_app(app)),
    );
    let window = builder
        .initialization_script(preload)
        .build()
        .map_err(|e| {
            desktop.unregister_window(label);
            e.to_string()
        })?;
    crate::screenshot_selector::geometry::restore_named(app, geometry, size, min_size, &window);
    let owner = app.clone();
    let handle = window.clone();
    window.on_window_event(move |event| {
        let desktop = owner.state::<DesktopState>();
        let windows = owner.state::<Windows>();
        match event {
            WindowEvent::CloseRequested { api, .. }
                if !desktop.quitting.load(Ordering::Acquire) =>
            {
                if handle.is_visible().unwrap_or(false) {
                    api.prevent_close();
                    crate::desktop_state::emit_to_window(&owner, label, CLOSE_EVENT, &[]);
                }
            }
            WindowEvent::Destroyed => {
                desktop.unregister_window(label);
                if review {
                    let editors = std::mem::take(&mut *windows.review.lock().unwrap());
                    let owner = owner.clone();
                    tauri::async_runtime::spawn(async move {
                        for editor in editors.into_values() {
                            editor.lock().await.unmount(&owner);
                        }
                    });
                } else if let Some(confirmation) = windows.confirmation.lock().unwrap().take() {
                    let _ = confirmation.answer.send(Value::Null);
                }
            }
            _ => {}
        }
    });
    Ok(window)
}

pub(crate) async fn open_confirmation(app: &AppHandle, request: Value) -> Result<Value, String> {
    let windows = app.state::<Windows>();
    let _opening = windows.opening_confirmation.lock().await;
    if windows.confirmation_disabled.load(Ordering::Acquire) {
        let reused = request["reusing_audio"] == true;
        return Ok(json!([
            reused || request["vad_result"]["success"] == true,
            request["sentence"],
            request["translation"],
            request["screenshot_path"],
            request["previous_screenshot_path"],
            false,
            if reused {
                Value::Null
            } else {
                request["audio_path"].clone()
            },
            {}
        ]));
    }
    let config = app.state::<Arc<MiningService>>().load_config()?;
    let anki = settings(app);
    let focus = anki["confirmation_focus_on_show"] != false;
    let previous = (focus && anki["confirmation_restore_focus"] != false)
        .then(foreground)
        .flatten();
    let hold = crate::obs::game_pause::ConfirmationHold::new(app);
    let (answer, result) = oneshot::channel();
    let (ready, loaded) = oneshot::channel();
    let handle = app.clone();
    let editor = Arc::new(AsyncMutex::new(
        tauri::async_runtime::spawn_blocking(move || {
            Editor::new(&handle, request, config, Vec::new(), false)
        })
        .await
        .map_err(|e| e.to_string())??,
    ));
    let registered = {
        let mut active = windows.confirmation.lock().unwrap();
        if active.is_none() {
            *active = Some(Confirmation {
                editor: editor.clone(),
                answer,
                ready: Some(ready),
            });
            true
        } else {
            false
        }
    };
    if !registered {
        editor.lock().await.unmount(app);
        return Err("Anki confirmation is already open".into());
    }
    let value = match create_window(
        app,
        false,
        focus,
        anki["confirmation_always_on_top"] != false,
    ) {
        Ok(window) => {
            let value = match tokio::time::timeout(Duration::from_secs(30), loaded).await {
                Ok(Ok(())) => Ok(result.await.unwrap_or(Value::Null)),
                Ok(Err(_)) => Ok(Value::Null),
                Err(_) => Err("Anki confirmation did not load".to_owned()),
            };
            if app.get_webview_window(CONFIRMATION).is_some() {
                crate::screenshot_selector::geometry::save_named(
                    &window,
                    "anki_confirmation_split",
                );
                let _ = window.destroy();
            }
            value
        }
        Err(error) => Err(error),
    };
    windows.confirmation.lock().unwrap().take();
    editor.lock().await.unmount(app);
    drop(hold);
    if let Some(previous) = previous {
        let overlay = app.state::<crate::overlay_host::OverlayHost>();
        if !overlay.restore_after_confirmation(app, &previous.to_string()) {
            restore_foreground(previous);
        }
    }
    value
}

pub(crate) async fn open_review(app: &AppHandle) -> Result<Value, String> {
    show_review(app, ReviewTrigger::Manual).await
}

#[derive(Clone, Copy, PartialEq)]
enum ReviewTrigger {
    Manual,
    CardQueued,
    GameClosed,
}

pub(crate) async fn review_queued(app: &AppHandle, mined: &ProfileConfig) -> Result<(), String> {
    let current = app.state::<Arc<MiningService>>().load_config()?;
    if current.name == mined.name
        && current.anki.url == mined.anki.url
        && current.review_after_session_enabled()
        && current.features.review_after_session.open_on_card_queued
    {
        show_review(app, ReviewTrigger::CardQueued).await?;
    }
    Ok(())
}

async fn show_review(app: &AppHandle, trigger: ReviewTrigger) -> Result<Value, String> {
    let windows = app.state::<Windows>();
    let _open = windows.opening_review.lock().await;
    if let Some(window) = app.get_webview_window(REVIEW) {
        if trigger == ReviewTrigger::CardQueued {
            crate::desktop_state::emit_to_window(app, REVIEW, "cardDialog.queueChanged", &[]);
        } else if trigger == ReviewTrigger::Manual && window.is_visible().unwrap_or(false) {
            crate::desktop_state::focus_window(&window)?;
        }
    } else {
        create_window(app, true, trigger != ReviewTrigger::CardQueued, false)?;
    }
    Ok(Value::Null)
}

pub(crate) fn start(app: &AppHandle) {
    if app.state::<Windows>().started.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let desktop = app.state::<DesktopState>();
        let obs = app.state::<crate::obs::Obs>();
        let windows = app.state::<Windows>();
        let service = app.state::<Arc<MiningService>>();
        let startup_count = reviews::count(&app);
        if startup_count > 0 {
            crate::app_lifecycle::notify_pending_reviews(&app, startup_count);
        }
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut scene = String::new();
        let mut was_active = false;
        let mut closed_since = None;
        let mut replay_stopped = None;
        let mut future_done = HashMap::new();
        while !desktop.quitting.load(Ordering::Acquire) {
            interval.tick().await;
            let snapshot = obs.game_session();
            let now = Instant::now();
            if snapshot["replay_active"] == false {
                let stopped = replay_stopped.get_or_insert(now);
                if now.duration_since(*stopped) >= Duration::from_secs(15 * 60) {
                    windows
                        .confirmation_disabled
                        .store(false, Ordering::Release);
                }
            } else {
                replay_stopped = None;
            }
            let Ok(cfg) = service.load_config() else {
                continue;
            };
            let review = &cfg.features.review_after_session;
            let name = string(&snapshot["scene"]);
            if scene != name {
                scene = name.into();
                was_active = false;
                closed_since = None;
            }
            match snapshot["active"].as_bool() {
                Some(true) => {
                    was_active = true;
                    closed_since = None;
                    if review.enabled
                        && review.max_future_context_lines > 0
                        && snapshot["replay_active"] == true
                    {
                        reviews::capture_future(
                            &app,
                            &cfg,
                            &scene,
                            snapshot["replay_seconds"].as_f64(),
                            &mut future_done,
                        )
                        .await;
                    }
                }
                Some(false) if was_active => {
                    let closed = closed_since.get_or_insert(now);
                    if now.duration_since(*closed).as_secs() >= 3
                        && windows.confirmation.lock().unwrap().is_none()
                        && service.card_lane.try_lock().is_ok()
                    {
                        was_active = false;
                        if review.enabled && reviews::count(&app) > 0 {
                            let result = if review.open_on_card_queued {
                                show_review(&app, ReviewTrigger::GameClosed).await
                            } else {
                                open_review(&app).await
                            };
                            if let Err(error) = result {
                                crate::desktop_log::warn(&app, "session review", error);
                            }
                        }
                    }
                }
                _ => {
                    closed_since = None;
                }
            }
        }
    });
}

pub(crate) async fn invoke(
    app: &AppHandle,
    label: &str,
    channel: &str,
    payload: &Value,
) -> Result<Value, String> {
    let review = match label {
        REVIEW => true,
        CONFIRMATION => false,
        _ => return Err("Card editor command requires its own window".into()),
    };
    let windows = app.state::<Windows>();
    let id = string(&payload["entry"]);
    let window = app
        .get_webview_window(label)
        .ok_or("Card editor window is closed")?;
    match channel {
        "cardDialog.ready" => {
            if let Some(title) = payload["title"].as_str() {
                window.set_title(title).map_err(|e| e.to_string())?;
            }
            if std::env::var_os("GSM_SMOKE_TEST").is_none() && !window.is_visible().unwrap_or(false)
            {
                let live_review = review && payload["live"] == true;
                if live_review {
                    crate::window_platform::apply(&window, "showWithoutActivating", &Value::Null)?;
                } else {
                    window.show().map_err(|e| e.to_string())?;
                }
                if !live_review && (review || settings(app)["confirmation_focus_on_show"] != false)
                {
                    let _ = window.set_focus();
                }
            }
            if !review {
                if let Some(ready) = windows
                    .confirmation
                    .lock()
                    .unwrap()
                    .as_mut()
                    .and_then(|session| session.ready.take())
                {
                    let _ = ready.send(());
                }
            }
            return Ok(Value::Null);
        }
        "cardDialog.close" => {
            if review {
                crate::screenshot_selector::geometry::save_named(&window, "session_review");
                window.destroy().map_err(|e| e.to_string())?;
            } else {
                let choice = if payload["delete"] == true {
                    json!({"action":"delete_card"})
                } else {
                    Value::Null
                };
                finish_confirmation(&windows, choice);
            }
            return Ok(Value::Null);
        }
        "cardDialog.list" if review => return reviews::list(app),
        "cardDialog.inputService" => return Ok(json!(crate::input_server::url(app))),
        "cardDialog.cleanup" if review => {
            let _save = windows.saving_review.lock().await;
            return reviews::retry_cleanup(app).await;
        }
        "cardDialog.openInAnki" if review => {
            let _save = windows.saving_review.lock().await;
            return reviews::open_in_anki(app, id).await;
        }
        "cardDialog.discard" if review => {
            let _save = windows.saving_review.lock().await;
            let result = reviews::discard(app, id, payload["delete"] == true).await?;
            release_editor(app, &windows, id).await;
            return Ok(result);
        }
        "cardDialog.disableSession" if !review => {
            windows
                .confirmation_disabled
                .store(payload["enabled"] == true, Ordering::Release);
            return Ok(Value::Null);
        }
        "cardDialog.autoplay" => {
            let file = app.state::<Settings>().paths.active.join("config.json");
            let target = app.state::<Arc<MiningService>>().load_config()?.name;
            let enabled = payload["enabled"] == true;
            tauri::async_runtime::spawn_blocking(move || {
                let state = gsm_settings::mining_scopes::read(&file,&json!({"target":target}))?;
                let field = state["fields"].as_array().into_iter().flatten()
                    .find(|field|field["path"] == "anki.autoplay_audio").ok_or("Audio autoplay setting is unavailable")?;
                gsm_settings::mining_scopes::apply(&file,&json!({"op":"edit","target":target,"changes":[
                    {"path":"anki.autoplay_audio","value":enabled,"before":field["value"],"pinned":field["pinned"]}]}))
            }).await.map_err(|e| e.to_string())??;
            app.state::<Arc<MiningService>>().invalidate_config_cache();
            return Ok(Value::Null);
        }
        _ => {}
    }
    let editor = if review {
        let existing = windows.review.lock().unwrap().get(id).cloned();
        match existing {
            Some(editor) => editor,
            None if channel == "cardDialog.form" => {
                let _open = windows.opening_review.lock().await;
                let existing = windows.review.lock().unwrap().get(id).cloned();
                if let Some(editor) = existing {
                    editor
                } else {
                    let handle = app.clone();
                    let entry = id.to_owned();
                    let editor = tauri::async_runtime::spawn_blocking(move || {
                        reviews::editor(&handle, &entry)
                    })
                    .await
                    .map_err(|e| e.to_string())??;
                    if app.get_webview_window(label).is_none() {
                        editor.unmount(app);
                        return Err("Card editor window is closed".into());
                    }
                    let editor = Arc::new(AsyncMutex::new(editor));
                    windows
                        .review
                        .lock()
                        .unwrap()
                        .insert(id.into(), editor.clone());
                    editor
                }
            }
            None => return Err("Select a card to review".into()),
        }
    } else {
        windows
            .confirmation
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.editor.clone())
            .ok_or("Anki confirmation is closed")?
    };
    match channel {
        "cardDialog.form" => Ok(editor.lock().await.form(app)),
        "cardDialog.context" => {
            let mut editor = editor.lock().await;
            if review {
                reviews::refresh_future(app, id, &mut editor)?;
            }
            editor.refresh(app, payload)
        }
        "cardDialog.picture" => editor.lock().await.select_picture(app, payload).await,
        "cardDialog.dialogue" => editor.lock().await.change(app, payload).await,
        "cardDialog.tts" => editor.lock().await.generate_tts(app, payload).await,
        "cardDialog.expand" | "cardDialog.audioFilter" => {
            let handle = app.clone();
            let payload = payload.clone();
            let expand = channel == "cardDialog.expand";
            tauri::async_runtime::spawn_blocking(move || {
                let mut editor = editor.blocking_lock();
                if expand {
                    editor.expand(&handle, &payload)
                } else {
                    editor.audio_filter(&handle, &payload)
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "cardDialog.save" => {
            let edit = serde_json::from_value::<editor::Edit>(payload["edit"].clone())
                .map_err(|e| e.to_string())?;
            let _save = if review {
                Some(windows.saving_review.lock().await)
            } else {
                None
            };
            let handle = app.clone();
            let copy = editor.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                copy.blocking_lock().result(&handle, edit)
            })
            .await
            .map_err(|e| e.to_string())??;
            if review {
                let result = reviews::save(app, id, &editor.lock().await.config, result).await?;
                release_editor(app, &windows, id).await;
                Ok(result)
            } else {
                finish_confirmation(&windows, result);
                Ok(Value::Null)
            }
        }
        _ => Err("Unknown card editor command".into()),
    }
}

async fn release_editor(app: &AppHandle, windows: &Windows, id: &str) {
    let editor = windows.review.lock().unwrap().remove(id);
    if let Some(editor) = editor {
        editor.lock().await.unmount(app);
    }
}

fn finish_confirmation(windows: &Windows, value: Value) {
    if let Some(confirmation) = windows.confirmation.lock().unwrap().take() {
        let _ = confirmation.answer.send(value);
    }
}

async fn translate(
    app: &AppHandle,
    config: &ProfileConfig,
    sentence: &str,
    line: &GameLine,
) -> Result<String, String> {
    let service = app.state::<Arc<MiningService>>();
    let (_, lines) = app
        .state::<crate::text_intake::Intake>()
        .dialogue_context(&line.id, 12);
    let character =
        crate::mining::pipeline::fetch_character_context(app, &service, config, &line.scene).await;
    let translated = service
        .ai
        .translate(
            config,
            &lines,
            &gsm_mining::text::remove_html_and_cloze_tags(sentence),
            Some(line),
            &line.scene,
            &character,
            None,
            false,
            false,
        )
        .await;
    if gsm_mining::ai::is_successful_translation(&translated) {
        Ok(translated)
    } else {
        Err(translated)
    }
}

#[cfg(windows)]
fn foreground() -> Option<usize> {
    let hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    (!hwnd.0.is_null()).then_some(hwnd.0 as usize)
}
#[cfg(not(windows))]
fn foreground() -> Option<usize> {
    None
}

#[cfg(windows)]
fn restore_foreground(previous: usize) {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow},
    };
    let target = HWND(previous as _);
    unsafe {
        if IsWindow(Some(target)).as_bool() {
            let _ = SetForegroundWindow(target);
        }
    }
}
#[cfg(not(windows))]
fn restore_foreground(_: usize) {}
