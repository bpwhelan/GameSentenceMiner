//! Compatibility boundary for Qt windows. Stateful dialogs use the live Qt
//! session. A desktop without a backend can launch a supervised one-shot host.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::sync::{watch, Mutex};

const WORKER: &str = "qt-dialog";
const SETTINGS_WORKER: &str = "qt-settings";

#[derive(Serialize, Deserialize)]
#[serde(tag = "dialog", rename_all = "camelCase", deny_unknown_fields)]
pub enum Dialog {
    Settings {
        #[serde(default)]
        root_tab_key: String,
        #[serde(default)]
        subtab_key: String,
    },
    SessionReview,
    SyncSettings,
    PromptHelp,
    RecommendedAnkiSetup,
    TextInput {
        title: String,
        label: String,
    },
    SceneSelection {
        matched_configs: Vec<String>,
    },
    ScreenCropper {
        #[serde(default)]
        transparent_mode: bool,
    },
    ScreenshotSelector {
        video_path: String,
        timestamp: f64,
        mode: Option<String>,
    },
    AreaSelector {
        #[serde(default)]
        window_name: String,
        #[serde(default)]
        use_window_as_config: bool,
        #[serde(default)]
        use_obs_screenshot: bool,
        #[serde(default)]
        overlay_config_mode: bool,
        #[serde(default)]
        live_mode: bool,
        #[serde(default)]
        single_area_mode: bool,
    },
    MonitorSelector {
        #[serde(default)]
        monitor_index: usize,
        #[serde(default)]
        overlay_config_mode: bool,
    },
    MinimumCharacterSize {
        current_size: i32,
        image_path: Option<String>,
        #[serde(default)]
        for_overlay: bool,
    },
    FuriganaPreview {
        current_sensitivity: i32,
        image_path: Option<String>,
    },
    AnkiFieldGrouping {
        expression: String,
        candidates: Vec<Value>,
        default_order: Option<String>,
        default_delete_duplicate: Option<bool>,
    },
    AnkiConfirmation {
        expression: String,
        sentence: String,
        screenshot_path: Option<String>,
        previous_screenshot_path: Option<String>,
        audio_path: Option<String>,
        translation: Option<String>,
        #[serde(default)]
        screenshot_timestamp: f64,
        #[serde(default)]
        previous_screenshot_timestamp: f64,
        #[serde(default)]
        pending_animated: bool,
        #[serde(default)]
        reusing_audio: bool,
        #[serde(default)]
        reusing_screenshot: bool,
        #[serde(default)]
        overlay_only: bool,
        #[serde(default)]
        video_path: Option<String>,
        #[serde(default)]
        start_time: Option<f64>,
        #[serde(default)]
        end_time: Option<f64>,
        #[serde(default)]
        vad_result: Option<Value>,
        #[serde(default)]
        audio_edit_context: Option<Value>,
        #[serde(default)]
        mined_line: Option<Value>,
        #[serde(default)]
        selected_lines: Option<Vec<Value>>,
        #[serde(default)]
        anki_card_creation_time: Option<String>,
    },
}

#[derive(Default)]
pub struct DialogHost {
    active: Mutex<()>,
    exit: watch::Sender<Option<Value>>,
    settings_start: Mutex<()>,
    settings_exit: watch::Sender<Option<Value>>,
    settings_shown: watch::Sender<Option<String>>,
}

impl DialogHost {
    pub fn observe(&self, event: &str, data: &Value) {
        if event == "process.exit" && data["id"] == WORKER {
            self.exit.send_replace(Some(data.clone()));
        }
        if event == "process.exit" && data["id"] == SETTINGS_WORKER {
            self.settings_exit.send_replace(Some(data.clone()));
        }
        if event == "bus.message"
            && data["src"] == SETTINGS_WORKER
            && data["dst"] == "main"
            && data["kind"] == "event"
            && data["topic"] == "gui.settings.shown"
        {
            if let Some(window) = data["data"].as_str() {
                self.settings_shown.send_replace(Some(window.to_owned()));
            }
        }
    }
}

pub async fn open(app: &tauri::AppHandle, dialog: Dialog) -> Result<Value, String> {
    match dialog {
        Dialog::SessionReview => return crate::card_dialog::open_review(app).await,
        Dialog::RecommendedAnkiSetup => return crate::recommended_anki::open(app).await,
        Dialog::FuriganaPreview {
            current_sensitivity,
            image_path,
        } => {
            return crate::ocr_preview::open(app, current_sensitivity, image_path, false).await;
        }
        Dialog::MinimumCharacterSize {
            current_size,
            image_path,
            for_overlay,
        } => {
            return crate::ocr_preview::open(app, current_size, image_path, for_overlay).await;
        }
        Dialog::AreaSelector {
            window_name,
            use_window_as_config,
            use_obs_screenshot,
            overlay_config_mode,
            live_mode,
            single_area_mode,
        } => {
            use crate::ocr_coordinator::desktop_selector::{self, Options};
            return desktop_selector::open(
                app,
                Options {
                    window_name,
                    use_window_as_config,
                    obs: use_obs_screenshot,
                    overlay: overlay_config_mode,
                    live: live_mode,
                    single: single_area_mode,
                    ..Default::default()
                },
            )
            .await;
        }
        Dialog::MonitorSelector {
            monitor_index,
            overlay_config_mode,
        } => {
            use crate::ocr_coordinator::desktop_selector::{self, Options};
            return desktop_selector::open(
                app,
                Options {
                    monitor: Some(monitor_index),
                    overlay: overlay_config_mode,
                    ..Default::default()
                },
            )
            .await;
        }
        Dialog::AnkiConfirmation { .. } => {
            let request = serde_json::to_value(dialog).map_err(|e| e.to_string())?;
            return crate::card_dialog::open_confirmation(app, request).await;
        }
        _ => {}
    }
    if let Dialog::Settings {
        root_tab_key,
        subtab_key,
    } = dialog
    {
        return open_settings(app, root_tab_key, subtab_key).await;
    }
    if let Dialog::AnkiFieldGrouping {
        expression,
        candidates,
        default_order,
        default_delete_duplicate,
    } = dialog
    {
        return crate::anki_group::chooser::open(
            app,
            expression,
            candidates,
            default_order,
            default_delete_duplicate,
        )
        .await;
    }
    if let Dialog::ScreenshotSelector {
        video_path,
        timestamp,
        mode,
    } = dialog
    {
        let selected =
            crate::screenshot_selector::open(app, video_path.clone().into(), timestamp, mode)
                .await?;
        return Ok(match selected {
            Some(selection) => {
                json!({"source_path":video_path,"items":selection.release().into_iter().map(|(path,start)|json!({"path":path,"start":start})).collect::<Vec<_>>() })
            }
            None => Value::Null,
        });
    }
    open_dialog(app, dialog).await
}

pub(crate) async fn preview(app:&tauri::AppHandle, name:&str)->Result<(),String> {
    let request = match name {
        "test_anki_confirmation" => json!({"dialog":"ankiConfirmation","expression":"世界","sentence":"おはよう世界。","translation":"Good morning, world."}),
        "test_furigana_filter" => json!({"dialog":"furiganaPreview","current_sensitivity":50}),
        "test_area_selector" => json!({"dialog":"areaSelector","use_obs_screenshot":true}),
        "test_screen_cropper" => json!({"dialog":"screenCropper"}),
        "test_screenshot_selector" => {
            let Some(video) = rfd::AsyncFileDialog::new().add_filter("Recording",&["mp4","mkv","mov","webm"]).pick_file().await else {return Ok(());};
            json!({"dialog":"screenshotSelector","video_path":video.path(),"timestamp":0.})
        }
        _ => return Err("Unknown dialog preview".into()),
    };
    let dialog = serde_json::from_value(request).map_err(|e|e.to_string())?;
    open(app,dialog).await.map(|_|())
}

async fn open_dialog(app: &tauri::AppHandle, dialog: Dialog) -> Result<Value, String> {
    let runtime = crate::runtime::get(app)?;
    let clients = runtime.call("bus.clients", json!({})).await?;
    let live = clients
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == "backend"));
    let host = app.state::<DialogHost>();
    let _active = host
        .active
        .try_lock()
        .map_err(|_| "Another Qt dialog is open")?;
    if live {
        return runtime
            .call(
                "bus.request",
                json!({
                    "dst":"backend", "topic":"gui.dialog", "data":dialog, "timeoutMs":3_600_000
                }),
            )
            .await;
    }
    let (python, root) = prepare_host(app).await?;
    run_worker(app, dialog, &python, &root).await
}

pub(crate) async fn open_settings(
    app: &tauri::AppHandle,
    root_tab_key: String,
    subtab_key: String,
) -> Result<Value, String> {
    crate::mining_settings::open(app, root_tab_key, subtab_key).await
}

pub(crate) async fn open_settings_with(
    app: &tauri::AppHandle,
    root_tab_key: String,
    subtab_key: String,
    prepare: impl std::future::Future<Output = Result<(String, std::path::PathBuf), String>>,
) -> Result<Value, String> {
    let host = app.state::<DialogHost>();
    let _opening = host.settings_start.lock().await;
    if crate::runtime::backend_command(
        app,
        "open_settings",
        json!({"root_tab_key":root_tab_key,"subtab_key":subtab_key}),
    )
    .await?
    {
        return Ok(Value::Null);
    }
    let dialog = Dialog::Settings {
        root_tab_key,
        subtab_key,
    };
    let runtime = crate::runtime::get(app)?;
    let state = runtime
        .call("process.state", json!({"id":SETTINGS_WORKER}))
        .await?;
    if state["pid"].is_u64() {
        return runtime.call("bus.request", json!({"dst":SETTINGS_WORKER,"topic":"gui.settings","data":dialog,"timeoutMs":5000})).await;
    }
    let (python, root) = prepare.await?;
    let handle = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut worker = tauri::async_runtime::spawn(async move {
        run_worker_inner(&handle, dialog, &python, &root, Some(tx)).await
    });
    // Keep the supervised worker alive until its window closes, allowing card
    // confirmation and the other modal dialogs to use their own worker meanwhile.
    tokio::select! {
        result = &mut worker => result.map_err(|e| e.to_string())?,
        result = rx => match result {
            Ok(()) => Ok(Value::Null),
            Err(_) => worker.await.map_err(|e| e.to_string())?,
        }
    }
}

pub(crate) async fn prepare_host(app: &tauri::AppHandle) -> Result<(String, std::path::PathBuf), String> {
    let python = crate::python_ops::ensure_python_path(app).await?;
    let mut spec = json!({"pythonPath":python});
    crate::backend::package_defaults(app, &mut spec)?;
    let ready =
        crate::python_install::dispatch(app, json!({"action":"prepare","params":spec})).await?;
    let python = ready["result"]["pythonPath"]
        .as_str()
        .ok_or("Missing Qt interpreter path")?;
    let root = crate::backend::python_cwd(app);
    Ok((python.into(), root))
}

pub(crate) async fn run_worker(
    app: &tauri::AppHandle,
    dialog: Dialog,
    python: &str,
    root: &std::path::Path,
) -> Result<Value, String> {
    run_worker_inner(app, dialog, python, root, None).await
}

async fn run_worker_inner(
    app: &tauri::AppHandle,
    dialog: Dialog,
    python: &str,
    root: &std::path::Path,
    opened: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<Value, String> {
    let paths = &app.state::<crate::settings::Settings>().paths;
    let host = app.state::<DialogHost>();
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let request = dir.path().join("request.json");
    let result = dir.path().join("result.json");
    tokio::fs::write(
        &request,
        serde_json::to_vec(&dialog).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    let settings = opened.is_some();
    let id = if settings { SETTINGS_WORKER } else { WORKER };
    let mut exit = if settings {
        &host.settings_exit
    } else {
        &host.exit
    }
    .subscribe();
    let mut shown = host.settings_shown.subscribe();
    let mut env = gsm_packages::python::environment();
    let window = if settings {
        uuid::Uuid::new_v4().to_string()
    } else {
        String::new()
    };
    if settings {
        env.insert("GSM_QT_WINDOW_ID".into(), window.clone());
    }
    env.insert(
        "GSM_DATA_DIR".into(),
        paths.active.to_string_lossy().into_owned(),
    );
    if paths.has_profile {
        env.insert(
            "GSM_PROFILE_DIR".into(),
            paths.active.to_string_lossy().into_owned(),
        );
        env.insert(
            "GSM_SHARED_DATA_DIR".into(),
            paths.shared.to_string_lossy().into_owned(),
        );
    }
    let process = crate::runtime::dispatch(app, json!({"action":"process.start","params":{
        "id":id,"command":python,"args":["-m","GameSentenceMiner.ui.desktop_dialog",request,result],
        "cwd":root,"env":env,"windowsHide":true
    }})).await?;
    let finished = async {
        exit.wait_for(|e| e.as_ref().is_some_and(|e| e["runId"] == process["runId"]))
            .await
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "Missing dialog exit status".to_string())
    };
    tokio::pin!(finished);
    let finished = if let Some(tx) = opened {
        tokio::select! {
            result = &mut finished => result,
            _ = async { shown.wait_for(|id| id.as_deref() == Some(&window)).await.is_ok() } => {
                let _ = tx.send(());
                finished.await
            }
        }
    } else {
        finished.await
    }?;
    if finished["code"] != 0 {
        return Err(format!(
            "Qt dialog worker exited with status {}",
            finished["code"]
        ));
    }
    let bytes = tokio::fs::read(&result)
        .await
        .map_err(|e| format!("Reading Qt dialog result: {e}"))?;
    let mut reply: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if let Some(error) = reply["error"].as_str() {
        return Err(error.into());
    }
    reply
        .get_mut("value")
        .map(Value::take)
        .ok_or("Qt dialog closed without a result".into())
}
