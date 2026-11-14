//! Native system tray, status icon presentation, and dynamic GSM profile menu.
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub const CANONICAL_TRAY_ID: &str = "gsm-tray";
const MENU_PREFIX: &str = "tray::";

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum TrayVisualState {
    Loading,
    Ready,
    Paused,
    Normal,
}

impl TrayVisualState {
    pub fn from_status(
        python_ipc_connected: bool,
        backend_status_ready: bool,
        ready_indicator_active: bool,
        text_intake_paused: bool,
    ) -> Self {
        if !python_ipc_connected || !backend_status_ready {
            Self::Loading
        } else if text_intake_paused {
            Self::Paused
        } else if ready_indicator_active {
            Self::Ready
        } else {
            Self::Normal
        }
    }

    pub fn suffix(self) -> Option<&'static str> {
        match self {
            Self::Loading => Some("loading"),
            Self::Ready => Some("ready"),
            Self::Paused => Some("paused"),
            Self::Normal => None,
        }
    }

    pub fn tooltip(self) -> &'static str {
        match self {
            Self::Loading => "GameSentenceMiner (Starting up)",
            Self::Ready => "GameSentenceMiner (Ready)",
            Self::Paused => "GameSentenceMiner (Text Intake Paused)",
            Self::Normal => "GameSentenceMiner",
        }
    }
}

#[derive(Default)]
pub struct TrayState {
    inner: Mutex<TrayInner>,
}

struct TrayInner {
    visual_state: TrayVisualState,
    custom_tooltip: Option<String>,
    profile_names: Vec<String>,
    current_profile: String,
    destroyed: bool,
}

impl Default for TrayInner {
    fn default() -> Self {
        Self {
            visual_state: TrayVisualState::Normal,
            custom_tooltip: None,
            profile_names: Vec::new(),
            current_profile: String::new(),
            destroyed: false,
        }
    }
}

pub fn is_tray_menu_id(id: &str) -> bool {
    id.starts_with(MENU_PREFIX)
}

fn is_running_as_admin() -> bool {
    #[cfg(windows)]
    unsafe {
        windows::Win32::UI::Shell::IsUserAnAdmin().as_bool()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(hub) = crate::desktop_state::find_hub_window(app) {
        let _ = crate::desktop_state::focus_window(&hub);
    }
}

pub fn build_tray_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let paths = &app.state::<crate::settings::Settings>().paths;
    let profiles_json =
        gsm_settings::gsm_config::get_gsm_profile_names(&paths.active.join("config.json"));
    let profile_names: Vec<String> = profiles_json["profiles"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let current_profile = profiles_json["currentProfile"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    {
        let tray_state = app.state::<TrayState>();
        let mut guard = tray_state.inner.lock().unwrap();
        guard.profile_names = profile_names.clone();
        guard.current_profile = current_profile.clone();
    }

    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "tray::open-settings", "Open Settings", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "tray::open-texthooker", "Open Text Feed", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let profile_submenu = Submenu::new(app, "Switch Profile", true).map_err(|e| e.to_string())?;
    if profile_names.is_empty() {
        profile_submenu
            .append(
                &MenuItem::with_id(
                    app,
                    "tray::no-profiles",
                    "No Profiles Found",
                    false,
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
    } else {
        for (idx, name) in profile_names.iter().enumerate() {
            profile_submenu
                .append(
                    &CheckMenuItem::with_id(
                        app,
                        format!("tray::profile::{idx}"),
                        name,
                        true,
                        *name == current_profile,
                        None::<&str>,
                    )
                    .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }
    }
    menu.append(&profile_submenu).map_err(|e| e.to_string())?;

    if cfg!(debug_assertions) {
        let dev_submenu = Submenu::new(app, "Test Windows", true).map_err(|e| e.to_string())?;
        for (id, label) in [
            ("tray::dev::test_anki_confirmation", "Anki Confirmation Dialog"),
            ("tray::dev::test_screenshot_selector", "Screenshot Selector"),
            ("tray::dev::test_furigana_filter", "Furigana Filter Preview"),
            ("tray::dev::test_area_selector", "Area Selector"),
            ("tray::dev::test_screen_cropper", "Screen Cropper"),
        ] {
            dev_submenu
                .append(
                    &MenuItem::with_id(app, id, label, true, None::<&str>)
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }
        menu.append(&dev_submenu).map_err(|e| e.to_string())?;
    }

    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "tray::update-gsm", "Update GSM", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(
            app,
            "tray::restart-python",
            "Restart Python App",
            true,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "tray::open-gsm-folder", "Open GSM Folder", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    if cfg!(windows) && !is_running_as_admin() {
        menu.append(
            &MenuItem::with_id(
                app,
                "tray::restart-as-admin",
                "Restart as Admin",
                true,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }

    if cfg!(debug_assertions) {
        menu.append(
            &MenuItem::with_id(app, "tray::restart-app", "Restart App", true, None::<&str>)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }

    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "tray::quit", "Exit", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(menu)
}

pub fn update_backend_status(
    app: &tauri::AppHandle,
    ipc: bool,
    status_ready: bool,
    ready_active: bool,
    paused: bool,
) {
    let next = TrayVisualState::from_status(ipc, status_ready, ready_active, paused);
    let changed = {
        let Some(tray_state) = app.try_state::<TrayState>() else {
            return;
        };
        let mut guard = tray_state.inner.lock().unwrap();
        if guard.visual_state == next {
            false
        } else {
            guard.visual_state = next;
            true
        }
    };
    if changed {
        refresh_presentation(app);
    }
}

pub fn ensure_created(app: &tauri::AppHandle) -> Result<(), String> {
    if app.tray_by_id(CANONICAL_TRAY_ID).is_some() {
        refresh_menu(app)?;
        refresh_presentation(app);
        return Ok(());
    }
    let state = {
        let tray_state = app.state::<TrayState>();
        let mut guard = tray_state.inner.lock().unwrap();
        guard.destroyed = false;
        guard.visual_state
    };
    let icon_path = crate::app_identity::current_tray_icon_path(app, state.suffix());
    if !icon_path.is_file() {
        return Err(format!("Tray icon not found at {}", icon_path.display()));
    }
    let icon = crate::native::tray_icon_from_path(&icon_path)?;
    let menu = build_tray_menu(app)?;
    let _tray = TrayIconBuilder::with_id(CANONICAL_TRAY_ID)
        .icon(icon)
        .tooltip(state.tooltip())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn refresh_menu(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(CANONICAL_TRAY_ID) else {
        return Ok(());
    };
    let menu = build_tray_menu(app)?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())
}

pub fn destroy(app: &tauri::AppHandle) {
    app.state::<TrayState>().inner.lock().unwrap().destroyed = true;
    app.remove_tray_by_id(CANONICAL_TRAY_ID);
}

pub fn refresh_presentation(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(CANONICAL_TRAY_ID) else {
        return;
    };
    let (visual_state, custom_tooltip) = {
        let tray_state = app.state::<TrayState>();
        let guard = tray_state.inner.lock().unwrap();
        (guard.visual_state, guard.custom_tooltip.clone())
    };
    let icon_path = crate::app_identity::current_tray_icon_path(app, visual_state.suffix());
    if icon_path.is_file() {
        if let Ok(image) = crate::native::tray_icon_from_path(&icon_path) {
            let _ = tray.set_icon(Some(image));
        }
    }
    let tip = custom_tooltip
        .as_deref()
        .unwrap_or_else(|| visual_state.tooltip());
    let _ = tray.set_tooltip(Some(tip));
}

pub fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    let handle = app.clone();
    match id {
        "tray::open-settings" => {
            tauri::async_runtime::spawn(async move {
                let sent = crate::runtime::backend_command(&handle, "open_settings", json!({}))
                    .await
                    .unwrap_or(false);
                if !sent {
                    show_main_window(&handle);
                }
            });
        }
        "tray::open-texthooker" => {
            tauri::async_runtime::spawn(async move {
                let _ = crate::runtime::backend_command(&handle, "open_texthooker", json!({})).await;
            });
        }
        "tray::open-gsm-folder" => {
            let folder = app.state::<crate::settings::Settings>().paths.active.clone();
            let _ = crate::native::shell_open_path(&folder);
        }
        id if id.starts_with("tray::profile::") => {
            let Ok(idx) = id["tray::profile::".len()..].parse::<usize>() else {
                return;
            };
            let (profile_name, is_current) = {
                let tray_state = app.state::<TrayState>();
                let guard = tray_state.inner.lock().unwrap();
                let name = guard.profile_names.get(idx).cloned();
                let is_curr = name.as_deref() == Some(guard.current_profile.as_str());
                (name, is_curr)
            };
            let Some(profile_name) = profile_name else {
                return;
            };
            if is_current {
                return;
            }
            tauri::async_runtime::spawn(async move {
                if crate::runtime::backend_command(
                    &handle,
                    "switch_profile",
                    json!({ "profile_name": profile_name }),
                )
                .await
                .unwrap_or(false)
                {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    let _ = refresh_menu(&handle);
                }
            });
        }
        id if id.starts_with("tray::dev::") => {
            let fn_name = id["tray::dev::".len()..].to_owned();
            tauri::async_runtime::spawn(async move {
                let _ = crate::runtime::backend_command(&handle, &fn_name, json!({})).await;
            });
        }
        "tray::update-gsm" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let mgr = handle
                    .state::<crate::update_manager::UpdateManager>()
                    .inner()
                    .clone();
                mgr.run_interactive_update_check(&handle, true).await;
            });
        }
        "tray::restart-python" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::python_ops::restart_gsm(&handle).await;
            });
        }
        "tray::restart-as-admin" => {
            if let Err(err) = crate::game_privileges::restart_as_admin(app) {
                eprintln!("[tray] restart-as-admin failed: {err}");
            }
        }
        "tray::restart-app" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::app_lifecycle::quit_app(&handle, Some(Vec::new())).await;
            });
        }
        "tray::quit" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::app_lifecycle::quit_app(&handle, None).await;
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_visual_state_and_tooltips_match_electron_priority() {
        assert_eq!(
            TrayVisualState::from_status(false, true, true, true),
            TrayVisualState::Loading
        );
        assert_eq!(
            TrayVisualState::from_status(true, false, true, false),
            TrayVisualState::Loading
        );
        assert_eq!(
            TrayVisualState::from_status(true, true, true, true),
            TrayVisualState::Paused
        );
        assert_eq!(
            TrayVisualState::from_status(true, true, true, false),
            TrayVisualState::Ready
        );
        assert_eq!(
            TrayVisualState::from_status(true, true, false, false),
            TrayVisualState::Normal
        );
        assert_eq!(
            TrayVisualState::Paused.tooltip(),
            "GameSentenceMiner (Text Intake Paused)"
        );
        assert_eq!(TrayVisualState::Normal.suffix(), None);
        assert_eq!(TrayVisualState::Loading.suffix(), Some("loading"));
    }

    #[test]
    fn recognizes_tray_menu_prefix() {
        assert!(is_tray_menu_id("tray::open-settings"));
        assert!(is_tray_menu_id("tray::profile::0"));
        assert!(!is_tray_menu_id("menu-1"));
    }
}
