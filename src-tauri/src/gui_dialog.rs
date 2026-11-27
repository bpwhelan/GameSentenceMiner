//! Route desktop dialog requests to their native windows.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
    RecommendedAnkiSetup,
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
        live_mode: bool,
        #[serde(default)]
        single_area_mode: bool,
    },
    MonitorSelector {
        #[serde(default)]
        monitor_index: usize,
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
                    live: live_mode,
                    single: single_area_mode,
                    ..Default::default()
                },
            )
            .await;
        }
        Dialog::MonitorSelector { monitor_index } => {
            use crate::ocr_coordinator::desktop_selector::{self, Options};
            return desktop_selector::open(
                app,
                Options {
                    monitor: Some(monitor_index),
                    ..Default::default()
                },
            )
            .await;
        }
        Dialog::AnkiConfirmation { .. } => {
            let request = serde_json::to_value(dialog).map_err(|e| e.to_string())?;
            return crate::card_dialog::open_confirmation(app, request).await;
        }
        Dialog::Settings {
            root_tab_key,
            subtab_key,
        } => {
            return open_settings(app, root_tab_key, subtab_key).await;
        }
        Dialog::AnkiFieldGrouping {
            expression,
            candidates,
            default_order,
            default_delete_duplicate,
        } => {
            return crate::anki_group::chooser::open(
                app,
                expression,
                candidates,
                default_order,
                default_delete_duplicate,
            )
            .await;
        }
        Dialog::ScreenshotSelector {
            video_path,
            timestamp,
            mode,
        } => {
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
    }
}

pub(crate) async fn preview(app: &tauri::AppHandle, name: &str) -> Result<(), String> {
    let request = match name {
        "test_anki_confirmation" => {
            json!({"dialog":"ankiConfirmation","expression":"世界","sentence":"おはよう世界。","translation":"Good morning, world."})
        }
        "test_furigana_filter" => json!({"dialog":"furiganaPreview","current_sensitivity":50}),
        "test_area_selector" => json!({"dialog":"areaSelector","use_obs_screenshot":true}),
        "test_screenshot_selector" => {
            let Some(video) = rfd::AsyncFileDialog::new()
                .add_filter("Recording", &["mp4", "mkv", "mov", "webm"])
                .pick_file()
                .await
            else {
                return Ok(());
            };
            json!({"dialog":"screenshotSelector","video_path":video.path(),"timestamp":0.})
        }
        _ => return Err("Unknown dialog preview".into()),
    };
    let dialog = serde_json::from_value(request).map_err(|e| e.to_string())?;
    open(app, dialog).await.map(|_| ())
}

pub(crate) async fn open_settings(
    app: &tauri::AppHandle,
    root_tab_key: String,
    subtab_key: String,
) -> Result<Value, String> {
    crate::mining_settings::open(app, root_tab_key, subtab_key).await
}
