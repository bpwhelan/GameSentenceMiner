//! Compatibility boundary for Qt windows. Stateful dialogs use the live Qt
//! session. A desktop without a backend can launch a supervised one-shot host.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::sync::{watch, Mutex};

const WORKER: &str = "qt-dialog";

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
    },
}

#[derive(Default)]
pub struct DialogHost {
    active: Mutex<()>,
    exit: watch::Sender<Option<Value>>,
}

impl DialogHost {
    pub fn observe(&self, event: &str, data: &Value) {
        if event == "process.exit" && data["id"] == WORKER {
            self.exit.send_replace(Some(data.clone()));
        }
    }
}

pub async fn open(app: &tauri::AppHandle, dialog: Dialog) -> Result<Value, String> {
    let selector = matches!(
        dialog,
        Dialog::AreaSelector { .. } | Dialog::MonitorSelector { .. }
    );
    let selection = open_dialog(app, dialog).await?;
    if selector && !selection.is_null() {
        crate::ocr_coordinator::reload_active_ocr(app).await;
    }
    Ok(selection)
}

async fn open_dialog(app: &tauri::AppHandle, dialog: Dialog) -> Result<Value, String> {
    let runtime = crate::runtime::get(app)?;
    let clients = runtime.call("bus.clients", json!({})).await?;
    let live = clients
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == "backend"));
    if live {
        // Settings must install the active backend's hotkey/profile save hooks.
        let command = match &dialog {
            Dialog::Settings {
                root_tab_key,
                subtab_key,
            } => Some((
                "open_settings",
                json!({ "root_tab_key":root_tab_key, "subtab_key":subtab_key }),
            )),
            Dialog::SessionReview => Some(("open_session_review", Value::Null)),
            _ => None,
        };
        if let Some((function, data)) = command {
            if !crate::runtime::backend_command(app, function, data).await? {
                return Err("Qt session disconnected".into());
            }
            return Ok(Value::Null);
        }
    }
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
    let python = crate::python_ops::ensure_python_path(app).await?;
    let mut spec = json!({"pythonPath":python});
    crate::backend::package_defaults(app, &mut spec)?;
    let ready =
        crate::python_install::dispatch(app, json!({"action":"prepare","params":spec})).await?;
    let python = ready["result"]["pythonPath"]
        .as_str()
        .ok_or("Missing Qt interpreter path")?;
    let root = crate::backend::python_cwd(app);
    run_worker(app, dialog, python, &root).await
}

pub(crate) async fn run_worker(
    app: &tauri::AppHandle,
    dialog: Dialog,
    python: &str,
    root: &std::path::Path,
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
    let mut exit = host.exit.subscribe();
    let mut env = gsm_packages::python::environment();
    env.insert(
        "GSM_DATA_DIR".into(),
        paths.active.to_string_lossy().into_owned(),
    );
    let process = crate::runtime::dispatch(app, json!({"action":"process.start","params":{
        "id":WORKER,"command":python,"args":["-m","GameSentenceMiner.ui.desktop_dialog",request,result],
        "cwd":root,"env":env,"windowsHide":true
    }})).await?;
    let finished = exit
        .wait_for(|event| {
            event
                .as_ref()
                .is_some_and(|e| e["runId"] == process["runId"])
        })
        .await
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Missing dialog exit status")?;
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
