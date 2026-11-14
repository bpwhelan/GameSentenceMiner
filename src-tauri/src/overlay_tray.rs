use serde_json::{Map, Value};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub const ID: &str = "gsm-overlay-tray";

pub fn refresh(
    app: &AppHandle,
    settings: &Map<String, Value>,
    running: bool,
) -> Result<(), String> {
    if !running {
        while app.remove_tray_by_id(ID).is_some() {}
        return Ok(());
    }
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    for (id, title) in [
        ("toggleWindowHotkey", "Toggle Window"),
        ("settings", "Overlay Settings"),
        ("dictionary", "Dictionary Settings"),
        ("jiten", "Jiten Reader Settings"),
    ] {
        menu.append(
            &MenuItem::with_id(app, format!("overlay::{id}"), title, true, None::<&str>)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for (key, title) in [
        ("manualMode", "Push to Show"),
        ("showFurigana", "Show Furigana"),
        ("showTextIndicators", "Show Text Indicators"),
        ("fadeTextIndicators", "Fade Text Indicators"),
    ] {
        let checked = settings.get(key).and_then(Value::as_bool).unwrap_or(false);
        menu.append(
            &CheckMenuItem::with_id(
                app,
                format!("overlay::{key}"),
                title,
                true,
                checked,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    let pomodoro = Submenu::new(app, "Pomodoro", true).map_err(|e| e.to_string())?;
    for (key, title) in [
        ("pomodoroEnabled", "Enabled"),
        ("pomodoroAutoStart", "Auto-start with reading session"),
    ] {
        pomodoro
            .append(
                &CheckMenuItem::with_id(
                    app,
                    format!("overlay::{key}"),
                    title,
                    true,
                    settings.get(key).and_then(Value::as_bool).unwrap_or(false),
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
    }
    for (id, title) in [
        ("pomodoro-toggle", "Start / Pause / Resume"),
        ("pomodoro-reset", "Reset"),
    ] {
        pomodoro
            .append(
                &MenuItem::with_id(
                    app,
                    format!("overlay::{id}"),
                    title,
                    settings["pomodoroEnabled"] == true,
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
    }
    menu.append(&pomodoro).map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "overlay::stop", "Turn off overlay", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(ID) {
        return tray.set_menu(Some(menu)).map_err(|e| e.to_string());
    }
    let root = crate::dictionary_host::overlay_resources_root(app);
    let icon_path = [
        root.join(if cfg!(windows) {
            "overlay.ico"
        } else {
            "overlay-24.png"
        }),
        crate::app_identity::current_tray_icon_path(app, None),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .ok_or("Overlay tray icon missing")?;
    TrayIconBuilder::with_id(ID)
        .icon(crate::native::tray_icon_from_path(&icon_path)?)
        .tooltip("GSM Overlay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if let Some(action) = event.id.as_ref().strip_prefix("overlay::") {
                dispatch(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => dispatch(tray.app_handle(), "toggleWindowHotkey"),
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => dispatch(tray.app_handle(), "settings"),
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn dispatch(app: &AppHandle, action: &str) {
    let app = app.clone();
    let action = action.to_owned();
    tauri::async_runtime::spawn(async move {
        if let Some(host) = app.try_state::<crate::overlay_host::OverlayHost>() {
            host.handle_tray_action(&app, &action).await;
        }
    });
}
