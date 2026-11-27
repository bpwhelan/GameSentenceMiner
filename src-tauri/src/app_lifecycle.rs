//! Pure-Rust GSM desktop application lifecycle: startup, Hub window, bus/agent
//! event handling, status tray sync, notifications, and clean shutdown.

use crate::agent_control::{
    agent_relaunch_args, close_restart_warning_toast, parse_agent_restart_id,
    show_restart_warning_toast, AgentBusConnection, AgentControl, AGENT_RESTART_NOTIFICATION_ID,
};
use crate::app_identity::{
    apply_window_app_details, current_window_icon_path, refresh_icon_presentation,
    write_data_dir_registry,
};
use crate::desktop_state::{
    emit_to_desktop_windows, emit_to_window, find_hub_window, focus_window, open_docs_window,
    theme_for_app, DesktopState,
};
use crate::dictionary_host::{
    apply_profile_data_directory, apply_shared_webview_options, overlay_data_path,
};
use crate::overlay_preload::render_desktop_window_preload;
use gsm_packages::changelog::PendingChangelogRecord;
use gsm_settings::gsm_config::get_legacy_notification_features;
use gsm_settings::notifications::{
    get_notification_preferences, playback_payload, resolve_notification_delivery,
};
use gsm_settings::preferences::Preferences;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const HUB_WINDOW_LABEL: &str = "gsm-hub";
pub const APP_MENU_PREFIX: &str = "app-menu::";

const TRAY_READY_INDICATOR_MS: u64 = 10_000;
const FIRST_EPHEMERAL_NOTIFICATION_ID: i64 = 1_000_000;
const STILL_RUNNING_NOTIFICATION_ID: i64 = 941_894;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartupCliArgs {
    pub scene: Option<String>,
    pub game: Option<String>,
    pub ocr: bool,
    pub force_all_updates: bool,
    pub agent_restart_id: Option<String>,
}

impl StartupCliArgs {
    pub fn parse<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let raw: Vec<String> = args.into_iter().map(|s| s.as_ref().to_owned()).collect();
        let agent_restart_id = parse_agent_restart_id(raw.iter().map(String::as_str));
        let mut parsed = Self {
            agent_restart_id,
            ..Default::default()
        };
        let mut i = 0;
        while i < raw.len() {
            match raw[i].as_str() {
                "--scene" if i + 1 < raw.len() => {
                    parsed.scene = Some(raw[i + 1].clone());
                    i += 1;
                }
                "--game" if i + 1 < raw.len() => {
                    parsed.game = Some(raw[i + 1].clone());
                    i += 1;
                }
                "--ocr" => parsed.ocr = true,
                "--force-all-updates" => parsed.force_all_updates = true,
                _ => {}
            }
            i += 1;
        }
        parsed
    }
}

#[derive(Clone, Debug)]
enum NotificationClickAction {
    AnkiCard(i64),
    OpenPath(PathBuf),
    SessionReviews,
}

#[derive(Default)]
struct LifecycleInner {
    startup_args: Vec<String>,
    cli: StartupCliArgs,
    backend_bus_connected: bool,
    backend_status_ready: bool,
    backend_initialized: bool,
    text_intake_paused: bool,
    ready_indicator_expires_at_ms: u64,
    ready_timer_gen: u64,
    reopen_settings_after_restart: bool,
    agent_control: Option<Arc<AgentControl>>,
    pending_agent_request_id: Option<String>,
    notification_actions: HashMap<i64, NotificationClickAction>,
    #[cfg(debug_assertions)]
    dev_preview_active: bool,
}

pub struct AppLifecycle {
    inner: Mutex<LifecycleInner>,
    ocr_hook_redundant_shown: AtomicBool,
    shown_close_to_tray_notice: AtomicBool,
    agent_restart_ready_notified: AtomicBool,
    next_notification_id: AtomicI64,
    quit_lock: tokio::sync::Mutex<()>,
}

impl Default for AppLifecycle {
    fn default() -> Self {
        Self {
            inner: Mutex::new(LifecycleInner::default()),
            ocr_hook_redundant_shown: AtomicBool::new(false),
            shown_close_to_tray_notice: AtomicBool::new(false),
            agent_restart_ready_notified: AtomicBool::new(false),
            next_notification_id: AtomicI64::new(FIRST_EPHEMERAL_NOTIFICATION_ID),
            quit_lock: tokio::sync::Mutex::new(()),
        }
    }
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn is_app_menu_id(id: &str) -> bool {
    id.starts_with(APP_MENU_PREFIX)
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

pub fn default_recordings_dir(app: &AppHandle) -> PathBuf {
    let paths = &app.state::<crate::settings::Settings>().paths;
    if paths.has_profile {
        return paths.active.join("recordings");
    }
    dirs::video_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Videos")))
        .unwrap_or_else(|| paths.active.clone())
        .join("GSM")
}

fn initialize_obs_service(app: &AppHandle) {
    let root = &app.state::<DesktopState>().app_root;
    let paths = &app.state::<crate::settings::Settings>().paths;
    let recordings_dir = default_recordings_dir(app);
    let policy_path = root.join("resources/assets/obs-release-policy.json");
    if let Err(err) = app.state::<crate::obs::Obs>().initialize(
        app,
        json!({
            "baseDir": paths.active.to_string_lossy(),
            "recordingsDir": recordings_dir.to_string_lossy(),
            "policyPath": policy_path.to_string_lossy(),
            "coordinateClients": true,
        }),
    ) {
        crate::desktop_log::warn(
            app,
            "startup",
            format!("OBS initialization deferred/failed: {err}"),
        );
    }
}

fn init_notification_preferences(app: &AppHandle) {
    let active = &app.state::<crate::settings::Settings>().paths.active;
    let prefs = Preferences::new(active);
    let gsm_cfg = active.join("config.json");
    let _ = get_notification_preferences(&prefs, || get_legacy_notification_features(&gsm_cfg));
}

fn read_bool_pref(app: &AppHandle, key: &str, default: bool) -> bool {
    let active = &app.state::<crate::settings::Settings>().paths.active;
    Preferences::new(active)
        .get(key)
        .ok()
        .flatten()
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

fn read_string_pref(app: &AppHandle, key: &str) -> String {
    let active = &app.state::<crate::settings::Settings>().paths.active;
    Preferences::new(active)
        .get(key)
        .ok()
        .flatten()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Initialize core desktop infrastructure during Tauri `.setup()` with zero Node dependency.
pub fn init_startup(app: &AppHandle) -> Result<(), String> {
    let raw_args: Vec<String> = std::env::args().collect();
    let cli = StartupCliArgs::parse(raw_args.iter().skip(1));
    {
        let state = app.state::<AppLifecycle>();
        let mut inner = state.inner.lock().unwrap();
        inner.startup_args = raw_args;
        inner.cli = cli;
    }

    let paths = &app.state::<crate::settings::Settings>().paths;
    std::env::set_var("GSM_DATA_DIR", &paths.active);
    write_data_dir_registry(&paths.active, paths.has_profile);

    init_notification_preferences(app);
    initialize_obs_service(app);

    let bus_info = tauri::async_runtime::block_on(crate::runtime::dispatch(
        app,
        json!({ "action": "bus.start", "params": {"nativeTextIntake": true} }),
    ))?;

    setup_agent_control(app, &bus_info);

    if std::env::var_os("GSM_SMOKE_TEST").is_none() {
        start_desktop_session(app)?;
    } else {
        crate::smoke_test::spawn_if_requested(app.clone());
    }

    Ok(())
}

fn setup_agent_control(app: &AppHandle, bus_info: &Value) {
    let Some(port) = bus_info["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
    else {
        return;
    };
    let Some(token) = bus_info["token"].as_str().filter(|s| !s.is_empty()) else {
        return;
    };
    let active = &app.state::<crate::settings::Settings>().paths.active;
    let user_data_dir = active.join("electron");
    let root = app
        .state::<DesktopState>()
        .app_root
        .to_string_lossy()
        .into_owned();
    let restart_id = app
        .state::<AppLifecycle>()
        .inner
        .lock()
        .unwrap()
        .cli
        .agent_restart_id
        .clone();
    let control = Arc::new(AgentControl::new(
        &user_data_dir,
        root,
        !crate::LOCAL_BUILD,
        restart_id,
        AgentBusConnection {
            port,
            token: token.to_owned(),
            path: "/".into(),
        },
    ));
    app.state::<AppLifecycle>()
        .inner
        .lock()
        .unwrap()
        .agent_control = Some(control);
}

fn start_desktop_session(app: &AppHandle) -> Result<(), String> {
    app.state::<crate::update_manager::UpdateManager>()
        .bootstrap_prerelease_settings_from_metadata(app);

    let obs_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = obs_app
            .state::<crate::obs::Obs>()
            .invoke(
                &obs_app,
                "obs.ensureInstalledAndLaunch",
                &[json!({ "reason": "startup" })],
            )
            .await
        {
            crate::desktop_log::warn(
                &obs_app,
                "startup",
                format!("OBS ensure/launch warning: {err}"),
            );
        }
    });

    if let Err(err) = create_hub_window(app) {
        crate::desktop_log::error(app, "startup", format!("Failed creating hub window: {err}"));
    }

    if let Err(err) = crate::tray::ensure_created(app) {
        crate::desktop_log::warn(
            app,
            "startup",
            format!("Tray creation skipped/failed: {err}"),
        );
    }
    sync_tray_visual_state(app);

    // Refresh seasonal icons every 60s across midnight / date changes, stopping automatically on quit.
    let seasonal_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        loop {
            interval.tick().await;
            if seasonal_app
                .state::<DesktopState>()
                .quitting
                .load(Ordering::SeqCst)
            {
                break;
            }
            refresh_icon_presentation(&seasonal_app);
        }
    });

    tauri::async_runtime::spawn(boot_desktop_backend(app.clone()));
    Ok(())
}

pub(crate) async fn boot_desktop_backend(boot_app: AppHandle) {
    let shared = boot_app
        .state::<crate::settings::Settings>()
        .paths
        .shared
        .clone();
    let version = boot_app.package_info().version.to_string();
    let marker = tauri::async_runtime::spawn_blocking(move || {
        let marked_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        gsm_packages::legacy_venv::mark_retired(&shared, &version, &marked_at)
            .map_err(|error| format!("{}: {error}", shared.join("python_venv").display()))
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if let Err(error) = marker {
        crate::desktop_log::warn(
            &boot_app,
            "startup",
            format!("Could not mark the legacy Python environment: {error}"),
        );
    }
    if !read_bool_pref(&boot_app, "hasCompletedSetup", false) {
        let prefs = gsm_settings::preferences::Preferences::new(
            &boot_app.state::<crate::settings::Settings>().paths.active,
        );
        if let Err(error) = gsm_settings::onboarding::get_or_init_onboarding(&prefs) {
            crate::desktop_log::warn(&boot_app, "onboarding", error);
        }
        start_startup_install_session(&boot_app);
    }
    let lease = boot_app.state::<crate::install_session::InstallSessions>().model.lease();
    if let Err(error) = start_native_services(&boot_app, lease).await {
        crate::desktop_log::error(&boot_app, "startup", error);
    }
}

pub(crate) async fn start_native_services(app: &AppHandle, lease: Option<gsm_packages::install_session::Lease>) -> Result<(), String> {
    let sessions = app.state::<crate::install_session::InstallSessions>();
    let result: Result<Option<String>, String> = async {
        if !crate::mining::native_mining_requested() {
            return Err("Native mining is required for a Pythonless session".into());
        }
        if let Err(e) = app.state::<crate::obs::game_pause::GamePause>().recover(app) {
            crate::desktop_log::warn(app,"game pause",e);
        }
        // Database setup normally starts intake and binds the gateway before the Hub opens.
        // A retry from the installer must also recover an earlier database or port error.
        let mining = app.state::<Arc<crate::mining::MiningService>>();
        if !mining.is_enabled() {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || crate::database_startup::prepare(&handle))
                .await.map_err(|e| e.to_string())??;
        }
        if !mining.is_enabled() || !app.state::<crate::text_intake::Intake>().active() {
            return Err("The text intake service or single-port gateway failed to start. Check the desktop log.".into());
        }
        if let Some(ref lease) = lease {
            sessions.model.update(lease, &json!({"stageId":"prepare","status":"completed"}))?;
            sessions.notify();
        }
        let prepare_tools = async {
            #[cfg(windows)]
            crate::startup_tools::prepare(app, lease.clone()).await?;
            Ok::<(), String>(())
        };
        let start_obs = async {
            if std::env::var_os("GSM_SMOKE_TEST").is_some()
                || app.state::<DesktopState>().quitting.load(Ordering::SeqCst)
            {
                return None;
            }
            if let Some(ref lease) = lease {
                let _ = sessions.model.update(lease, &json!({"stageId":"obs","status":"running"}));
                sessions.notify();
            }
            let launched = app.state::<crate::obs::Obs>().launch_on_startup(app).await;
            if let Err(error) = &launched {
                crate::desktop_log::warn(app, "obs", format!("Could not start OBS: {error}"));
            }
            if let Some(ref lease) = lease {
                let update = match &launched {
                    Ok(()) => json!({"stageId":"obs","status":"completed"}),
                    Err(error) => json!({"stageId":"obs","status":"failed","error":error}),
                };
                let _ = sessions.model.update(lease, &update);
                sessions.notify();
            }
            launched.err()
        };
        // Adding a game only needs OBS. Let it start while the independent OCR
        // and media tools are downloading.
        let (tools, obs_error) = tokio::join!(prepare_tools, start_obs);
        tools?;
        if app.state::<DesktopState>().quitting.load(Ordering::SeqCst) { return Err("Desktop is shutting down".into()); }
        Ok(obs_error)
    }.await;
    if let Some(ref lease) = lease {
        match result.as_ref() {
            Ok(None) => { let _ = sessions.model.finish(lease,"completed",Some("Setup complete."),None); }
            Ok(Some(error)) | Err(error) => { let _ = sessions.model.finish(lease,"failed",Some("Desktop startup failed."),Some(error)); }
        }
        sessions.notify();
    }
    result?;
    {
        let lifecycle = app.state::<AppLifecycle>();
        let mut state = lifecycle.inner.lock().unwrap();
        state.backend_initialized = true;
        state.backend_status_ready = true;
    }
    emit_to_desktop_windows(app, "gsm-initialized", &[json!({"status":"ready"})]);
    maybe_activate_ready_tray_indicator(app);
    let _ = crate::tray::refresh_menu(app);
    crate::auto_launcher::sync_process_pausing_for_current_scene(app).await;
    process_startup_args_and_features(app).await;
    let prefs = gsm_settings::preferences::Preferences::new(&app.state::<crate::settings::Settings>().paths.active);
    let mgr = app.state::<crate::update_manager::UpdateManager>();
    mgr.check_startup_changelog(app);
    let version = app.package_info().version.to_string();
    if read_string_pref(app, "electronAppVersion") != version {
        if let Err(error) = prefs.patch(&json!({"electronAppVersion":version})) {
            crate::desktop_log::warn(app, "startup", format!("Saving desktop version: {error}"));
        }
    }
    if read_bool_pref(app, "autoUpdateGSMApp", true) {
        let _ = mgr.check_app_update_status(app, false).await;
    }
    Ok(())
}

fn start_startup_install_session(app: &AppHandle) {
    let sessions = app.state::<crate::install_session::InstallSessions>();
    let _ = sessions.model.call(
        "ensure",
        &json!({ "origin": "startup", "retry": "native:startup" }),
    );
    if let Some(ref lease) = sessions.model.lease() {
        let _ = sessions.model.update(
            lease,
            &json!({
                "stageId": "prepare",
                "status": "running",
                "progressKind": "estimated",
                "progress": 0.05,
                "message": "Preparing first-run startup workflow...",
            }),
        );
    }
    sessions.notify();
}

async fn process_startup_args_and_features(app: &AppHandle) {
    let cli = app
        .state::<AppLifecycle>()
        .inner
        .lock()
        .unwrap()
        .cli
        .clone();

    if let Some(scene) = cli.scene {
        let _ = app
            .state::<crate::obs::Obs>()
            .invoke(app, "obs.setScene", &[json!({ "name": scene })])
            .await;
    }

    if cli.force_all_updates {
        let _ = app.state::<crate::update_manager::UpdateManager>().check_app_update_status(app, true).await;
    }

    if read_bool_pref(app, "runOverlayOnStartup", false) {
        let overlay = app.state::<crate::overlay_host::OverlayHost>();
        if let Err(err) = overlay.start(app, None, "startup").await {
            crate::desktop_log::warn(
                app,
                "startup",
                format!("Failed to start overlay on startup: {err}"),
            );
        }
    }

    let path = app.state::<crate::settings::Settings>().paths.active.join("config.json");
    let doc = gsm_settings::read_object(&path).unwrap_or(Value::Null);
    let general = gsm_settings::gsm_config::active_profile(&doc).and_then(|p| p.get("general")).unwrap_or(&Value::Null);
    if general["open_config_on_startup"] == true {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::gui_dialog::open_settings(&handle,String::new(),String::new()).await {
                crate::desktop_log::warn(&handle, "settings", error);
            }
        });
    }
    if general["open_multimine_on_startup"] != false && !is_running_as_admin() {
        if let Err(error) = crate::launchers_ui::open_text_feed(app).await {
            crate::desktop_log::warn(app, "text-feed", error);
        }
    }

    if let Some(game) = cli.game {
        let _ = crate::game_launcher::launch(app, &game).await;
    }

    if cli.ocr {
        let _ = crate::ocr_coordinator::start_ocr(
            app,
            crate::ocr_coordinator::OcrStartSource::User,
            crate::ocr_coordinator::OcrRunMode::Auto,
        )
        .await;
    }
}

pub(crate) fn desktop_renderer_url(app: &AppHandle) -> Result<url::Url, String> {
    if let Some(dev_url) = std::env::var("VITE_DEV_SERVER_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        return url::Url::parse(dev_url.trim()).map_err(|e| e.to_string());
    }
    let raw = format!("{}/renderer/index.html", crate::assets::origin());
    let desktop = app.state::<DesktopState>();
    desktop.assets.url(&raw)
}

fn build_hub_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let mut file_builder = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("app-menu::update-gsm", "Update GSM")
                .build(app)
                .map_err(|e| e.to_string())?,
        );
    file_builder = file_builder.item(
            &MenuItemBuilder::with_id("app-menu::open-folder", "Open GSM Folder")
                .build(app)
                .map_err(|e| e.to_string())?,
        )
        .separator();

    if cfg!(windows) && !is_running_as_admin() {
        file_builder = file_builder
            .item(
                &MenuItemBuilder::with_id("app-menu::restart-as-admin", "Restart as Admin")
                    .build(app)
                    .map_err(|e| e.to_string())?,
            )
            .separator();
    }

    if !cfg!(target_os = "macos") {
        file_builder = file_builder.item(
            &MenuItemBuilder::with_id("app-menu::quit", "Quit")
                .build(app)
                .map_err(|e| e.to_string())?,
        );
    }

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(
            &MenuItemBuilder::with_id("app-menu::docs", "Open Documentation")
                .build(app)
                .map_err(|e| e.to_string())?,
        )
        .item(
            &MenuItemBuilder::with_id("app-menu::whats-changed", "What's Changed")
                .build(app)
                .map_err(|e| e.to_string())?,
        )
        .item(
            &MenuItemBuilder::with_id("app-menu::discord", "Discord")
                .build(app)
                .map_err(|e| e.to_string())?,
        )
        .item(
            &MenuItemBuilder::with_id("app-menu::export-debug-package", "Export Debug Package")
                .build(app)
                .map_err(|e| e.to_string())?,
        )
        .item(
            &MenuItemBuilder::with_id("app-menu::devtools", "Open Developer Console")
                .build(app)
                .map_err(|e| e.to_string())?,
        )
        .build()
        .map_err(|e| e.to_string())?;

    let mut menu_builder = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let app_sub = SubmenuBuilder::new(app, "GameSentenceMiner")
            .item(&PredefinedMenuItem::about(app, None, None).map_err(|e| e.to_string())?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None).map_err(|e| e.to_string())?)
            .item(&PredefinedMenuItem::hide_others(app, None).map_err(|e| e.to_string())?)
            .item(&PredefinedMenuItem::show_all(app, None).map_err(|e| e.to_string())?)
            .separator()
            .item(
                &MenuItemBuilder::with_id("app-menu::quit", "Quit")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)
                    .map_err(|e| e.to_string())?,
            )
            .build()
            .map_err(|e| e.to_string())?;
        menu_builder = menu_builder.item(&app_sub);
    }

    menu_builder = menu_builder
        .item(&file_builder.build().map_err(|e| e.to_string())?)
        .item(&help_menu);

    #[cfg(debug_assertions)]
    {
        let dev_menu = SubmenuBuilder::new(app, "Development")
            .item(
                &MenuItemBuilder::with_id(
                    "app-menu::dev-preview-update",
                    "Show Update Available (Latest Online Changelog)",
                )
                .build(app)
                .map_err(|e| e.to_string())?,
            )
            .item(
                &MenuItemBuilder::with_id("app-menu::dev-clear-preview", "Clear Update Preview")
                    .build(app)
                    .map_err(|e| e.to_string())?,
            )
            .separator()
            .item(
                &MenuItemBuilder::with_id("app-menu::dev-reload", "Reload UI")
                    .accelerator("CmdOrCtrl+R")
                    .build(app)
                    .map_err(|e| e.to_string())?,
            )
            .item(
                &MenuItemBuilder::with_id("app-menu::devtools", "Toggle Developer Tools")
                    .accelerator("F12")
                    .build(app)
                    .map_err(|e| e.to_string())?,
            )
            .build()
            .map_err(|e| e.to_string())?;
        menu_builder = menu_builder.item(&dev_menu);
    }

    menu_builder.build().map_err(|e| e.to_string())
}

pub fn create_hub_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(HUB_WINDOW_LABEL) {
        return Ok(existing);
    }

    let url = desktop_renderer_url(app)?;
    let desktop = app.state::<DesktopState>();
    let token = desktop.register_window(HUB_WINDOW_LABEL, "desktop");
    let theme = theme_for_app(app);
    let preload = render_desktop_window_preload(&token, Some(&theme));
    let profile_dir = overlay_data_path(app);
    let _ = std::fs::create_dir_all(&profile_dir);

    let (work_w, work_h) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let area = m.work_area();
            let scale = m.scale_factor().max(1.0);
            (
                (area.size.width as f64 / scale).floor(),
                (area.size.height as f64 / scale).floor(),
            )
        })
        .unwrap_or((1280.0, 1000.0));
    let width = work_w.min(1280.0).max(800.0);
    let height = work_h.min(1000.0).max(500.0);

    let version = &app.package_info().version;
    let title = format!("GameSentenceMiner v{version}");
    let menu = build_hub_menu(app)?;
    let reveal_on_load = !read_bool_pref(app, "startConsoleMinimized", false)
        && std::env::var_os("GSM_SMOKE_TEST").is_none();
    let revealed = Arc::new(AtomicBool::new(false));
    let revealed_for_load = revealed.clone();

    let builder = WebviewWindowBuilder::new(app, HUB_WINDOW_LABEL, WebviewUrl::External(url))
        .title(&title)
        .inner_size(width, height)
        .min_inner_size(800.0, 500.0)
        .visible(false)
        .menu(menu)
        .initialization_script_for_all_frames(preload)
        .on_navigation(|url| {
            crate::assets::trusted(url)
                || matches!(
                    url.scheme(),
                    "http" | "https" | "about" | "data" | "blob" | "chrome-extension"
                )
        })
        .on_new_window(|url, _| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = crate::native::shell_open_external(url.as_str());
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && reveal_on_load
                && !revealed_for_load.swap(true, Ordering::SeqCst)
            {
                let _ = window.show();
            }
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(view) = window.app_handle().get_webview_window(window.label()) {
                    crate::memory::sync_visibility(&view);
                }
            }
        });

    let builder = apply_shared_webview_options(builder);
    let builder = apply_profile_data_directory(builder, &profile_dir)?;

    let icon_path = current_window_icon_path(app);
    let builder = if icon_path.is_file() {
        match crate::native::icon_from_path(&icon_path) {
            Ok(img) => builder.icon(img).unwrap_or_else(|e| {
                crate::desktop_log::warn(app, "startup", format!("Icon attach skipped: {e}"));
                unreachable!()
            }),
            Err(_) => builder,
        }
    } else {
        builder
    };

    let window = builder.build().map_err(|e| {
        app.state::<DesktopState>()
            .unregister_window(HUB_WINDOW_LABEL);
        e.to_string()
    })?;

    if icon_path.is_file() {
        apply_window_app_details(app, &window, &icon_path);
    }

    let event_app = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(true) => {
            refresh_icon_presentation(&event_app);
        }
        WindowEvent::CloseRequested { api, .. } => {
            let desktop = event_app.state::<DesktopState>();
            if desktop.quitting.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            if read_bool_pref(&event_app, "quitOnWindowClose", false) {
                let quit_handle = event_app.clone();
                tauri::async_runtime::spawn(async move {
                    quit_app(&quit_handle, None).await;
                });
                return;
            }
            if let Some(win) = event_app.get_webview_window(HUB_WINDOW_LABEL) {
                let _ = win.hide();
                crate::memory::sync_visibility(&win);
            }
            let lifecycle = event_app.state::<AppLifecycle>();
            if !lifecycle
                .shown_close_to_tray_notice
                .swap(true, Ordering::SeqCst)
            {
                show_basic_toast(
                    &event_app,
                    STILL_RUNNING_NOTIFICATION_ID,
                    "GSM Still Running",
                    "GSM is still running in the system tray. Use the tray icon to open or exit GSM.",
                    false,
                    None,
                );
            }
        }
        WindowEvent::Destroyed => {
            event_app
                .state::<DesktopState>()
                .unregister_window(HUB_WINDOW_LABEL);
        }
        _ => {}
    });

    Ok(window)
}

pub fn handle_app_menu_event(app: &AppHandle, id: &str) {
    let handle = app.clone();
    match id {
        "app-menu::update-gsm" => {
            tauri::async_runtime::spawn(async move {
                let mgr = handle
                    .state::<crate::update_manager::UpdateManager>()
                    .inner()
                    .clone();
                mgr.run_interactive_update_check(&handle, true).await;
            });
        }
        "app-menu::open-folder" => {
            let folder = app
                .state::<crate::settings::Settings>()
                .paths
                .active
                .clone();
            let _ = crate::native::shell_open_path(&folder);
        }
        "app-menu::restart-as-admin" => {
            if let Err(err) = crate::game_privileges::restart_as_admin(app) {
                crate::desktop_log::error(app, "menu", format!("Restart as admin failed: {err}"));
            }
        }
        "app-menu::quit" => {
            tauri::async_runtime::spawn(async move {
                quit_app(&handle, None).await;
            });
        }
        "app-menu::docs" => {
            let url = "https://docs.gamesentenceminer.com/docs/overview";
            if open_docs_window(app, HUB_WINDOW_LABEL, url).is_err() {
                let _ = crate::native::shell_open_external(url);
            }
        }
        "app-menu::whats-changed" => {
            if let Some(hub) = find_hub_window(app) {
                let _ = focus_window(&hub);
            }
            let version = app.package_info().version.to_string();
            app.state::<crate::desktop_changelog::DesktopChangelog>()
                .start_manual_display(
                    app,
                    PendingChangelogRecord {
                        from_version: version.clone(),
                        to_version: version,
                    },
                );
        }
        "app-menu::discord" => {
            let _ = crate::native::shell_open_external("https://discord.gg/yP8Qse6bb8");
        }
        "app-menu::export-debug-package" => {
            tauri::async_runtime::spawn(async move {
                crate::desktop_services::export_debug_package(&handle).await;
            });
        }
        "app-menu::devtools" =>
        {
            #[cfg(debug_assertions)]
            if let Some(hub) = find_hub_window(app) {
                hub.open_devtools();
            }
        }
        #[cfg(debug_assertions)]
        "app-menu::dev-preview-update" => {
            tauri::async_runtime::spawn(async move {
                let mgr = handle
                    .state::<crate::update_manager::UpdateManager>()
                    .inner()
                    .clone();
                if let Err(err) = mgr.show_dev_update_preview(&handle).await {
                    let _ = crate::native::dialog_message(&json!({
                        "type": "warning",
                        "title": "Update Preview",
                        "message": "Could not load the latest online changelog.",
                        "detail": err,
                        "buttons": ["OK"],
                    }))
                    .await;
                } else {
                    handle
                        .state::<AppLifecycle>()
                        .inner
                        .lock()
                        .unwrap()
                        .dev_preview_active = true;
                    if let Some(hub) = find_hub_window(&handle) {
                        let _ = focus_window(&hub);
                    }
                }
            });
        }
        #[cfg(debug_assertions)]
        "app-menu::dev-clear-preview" => {
            app.state::<crate::update_manager::UpdateManager>()
                .clear_dev_update_preview(app);
            app.state::<AppLifecycle>()
                .inner
                .lock()
                .unwrap()
                .dev_preview_active = false;
        }
        #[cfg(debug_assertions)]
        "app-menu::dev-reload" => {
            if let Some(hub) = find_hub_window(app) {
                if let Ok(url) = hub.url() {
                    let _ = hub.navigate(url);
                }
            }
        }
        _ => {}
    }
}

/// Handle `window_input` natively (F12 devtools + Ctrl+F / F3 / Ctrl+G / Escape find-in-page).
pub fn handle_window_input(window: &WebviewWindow, input: &Value) {
    if input["type"].as_str() != Some("keyDown") {
        return;
    }
    let key = input["key"].as_str().unwrap_or("");
    let ctrl =
        input["control"].as_bool().unwrap_or(false) || input["meta"].as_bool().unwrap_or(false);
    let shift = input["shift"].as_bool().unwrap_or(false);
    let repeat = input["isAutoRepeat"].as_bool().unwrap_or(false);

    if key.eq_ignore_ascii_case("F12") && !repeat {
        #[cfg(debug_assertions)]
        window.open_devtools();
        #[cfg(not(debug_assertions))]
        let _ = window;
        return;
    }

    let payload = if ctrl && key.eq_ignore_ascii_case("f") && !repeat {
        Some(json!({ "action": "open" }))
    } else if key.eq_ignore_ascii_case("F3") || (ctrl && key.eq_ignore_ascii_case("g")) {
        Some(json!({ "action": "next", "forward": !shift }))
    } else if key.eq_ignore_ascii_case("Escape") && !repeat {
        Some(json!({ "action": "close" }))
    } else {
        None
    };

    if let Some(data) = payload {
        emit_to_window(
            window.app_handle(),
            window.label(),
            "gsm-find-in-page:shortcut",
            &[data],
        );
    }
}

/// Handle `gsm-find-in-page:command` natively inside any GSM WebView via `window.__GSM_FIND__`.
pub fn handle_find_in_page_command(app: &AppHandle, label: &str, args: &[Value]) {
    let Some(cmd) = args.first() else {
        return;
    };
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let action = cmd["action"].as_str().unwrap_or("");
    let script = match action {
        "clear" => Some("window.__GSM_FIND__?.('')".to_owned()),
        "visibility" if cmd["visible"].as_bool() == Some(false) => {
            Some("window.__GSM_FIND__?.('')".to_owned())
        }
        "search" => {
            let text = cmd["text"].as_str().unwrap_or("");
            if text.is_empty() {
                Some("window.__GSM_FIND__?.('')".to_owned())
            } else {
                let forward = cmd["forward"].as_bool().unwrap_or(true);
                let find_next = !cmd["startNewSearch"].as_bool().unwrap_or(false);
                let match_case = cmd["matchCase"].as_bool().unwrap_or(false);
                let opts = json!({
                    "forward": forward,
                    "findNext": find_next,
                    "matchCase": match_case,
                });
                Some(format!(
                    "const r = window.__GSM_FIND__?.({}, {}); if (r) window.__GSM_DESKTOP_DISPATCH__?.('gsm-find-in-page:result', [{{ matches: r.matches ?? 0, activeMatchOrdinal: r.activeMatchOrdinal ?? 0, finalUpdate: true }}]);",
                    json!(text),
                    opts
                ))
            }
        }
        _ => None,
    };

    if let Some(body) = script {
        let _ = window.eval(&format!("(() => {{ try {{ {body} }} catch {{}} }})()"));
    }
}

pub fn handle_single_instance(app: &AppHandle, args: Vec<String>) {
    if let Some(hub) = find_hub_window(app) {
        let _ = focus_window(&hub);
    }
    let cli = StartupCliArgs::parse(args.iter().skip(1));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(scene) = cli.scene {
            let _ = handle
                .state::<crate::obs::Obs>()
                .invoke(&handle, "obs.setScene", &[json!({ "name": scene })])
                .await;
        }
        if let Some(game) = cli.game {
            let _ = crate::game_launcher::launch(&handle, &game).await;
        }
        if cli.ocr {
            let _ = crate::ocr_coordinator::start_ocr(
                &handle,
                crate::ocr_coordinator::OcrStartSource::User,
                crate::ocr_coordinator::OcrRunMode::Auto,
            )
            .await;
        }
    });
}

fn sync_tray_visual_state(app: &AppHandle) {
    let (ipc, status_ready, ready_expires, paused) = {
        let lc = app.state::<AppLifecycle>();
        let g = lc.inner.lock().unwrap();
        (
            g.backend_bus_connected || g.backend_initialized,
            g.backend_status_ready,
            g.ready_indicator_expires_at_ms,
            g.text_intake_paused,
        )
    };
    let ready_active = ready_expires > now_epoch_ms();
    crate::tray::update_backend_status(app, ipc, status_ready, ready_active, paused);
}

pub(crate) fn initialized(app: &AppHandle) -> bool {
    app.state::<AppLifecycle>().inner.lock().unwrap().backend_initialized
}

pub(crate) fn intake_pause_changed(app: &AppHandle, paused: bool) {
    app.state::<AppLifecycle>().inner.lock().unwrap().text_intake_paused = paused;
    sync_tray_visual_state(app);
    let (kind, title, message) = if paused {
        ("GSMTextIntakePaused", "GSM Text Intake Paused", "Stats collection is paused. Card mining, the overlay, Text Feed, and output relays stay active. Incoming text will not update live stats, Discord activity, or the database.")
    } else {
        ("GSMTextIntakeResumed", "GSM Text Intake Resumed", "Clipboard and websocket text intake resumed.")
    };
    send_notification_for_event(app, kind, title, message, None);
}

fn mark_backend_bus_connected(app: &AppHandle) {
    let changed = {
        let lc = app.state::<AppLifecycle>();
        let mut g = lc.inner.lock().unwrap();
        if g.backend_bus_connected {
            false
        } else {
            g.backend_bus_connected = true;
            true
        }
    };
    if changed {
        maybe_activate_ready_tray_indicator(app);
        sync_tray_visual_state(app);
    }
}

fn maybe_activate_ready_tray_indicator(app: &AppHandle) {
    maybe_notify_agent_restart_ready(app);
    let timer_gen = {
        let lc = app.state::<AppLifecycle>();
        let mut g = lc.inner.lock().unwrap();
        if !(g.backend_bus_connected || g.backend_initialized) || !g.backend_status_ready || g.ready_indicator_expires_at_ms > 0
        {
            return;
        }
        g.ready_indicator_expires_at_ms = now_epoch_ms() + TRAY_READY_INDICATOR_MS;
        g.ready_timer_gen = g.ready_timer_gen.wrapping_add(1);
        g.ready_timer_gen
    };
    sync_tray_visual_state(app);

    let timer_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(TRAY_READY_INDICATOR_MS)).await;
        {
            let lc = timer_app.state::<AppLifecycle>();
            let mut g = lc.inner.lock().unwrap();
            if g.ready_timer_gen != timer_gen {
                return;
            }
            g.ready_indicator_expires_at_ms = 0;
        }
        sync_tray_visual_state(&timer_app);
    });
}

fn maybe_notify_agent_restart_ready(app: &AppHandle) {
    let lc = app.state::<AppLifecycle>();
    let (has_restart_id, ready_to_notify) = {
        let g = lc.inner.lock().unwrap();
        (
            g.cli.agent_restart_id.is_some(),
            g.backend_initialized
                && g.backend_status_ready
                && !app.state::<DesktopState>().quitting.load(Ordering::SeqCst),
        )
    };
    if !has_restart_id || !ready_to_notify {
        return;
    }
    if lc.agent_restart_ready_notified.swap(true, Ordering::SeqCst) {
        return;
    }
    send_notification_for_event(
        app,
        "GSMReady",
        "GSM Ready",
        "GSM has restarted. Your new changes are ready to try.",
        None,
    );
}

/// Observe `gsm-runtime` events (`bus.message`, etc.) directly inside Rust.
pub fn on_runtime_event(app: &AppHandle, event: &str, data: &Value) {
    if event != "bus.message" {
        return;
    }
    if data["topic"] == "gui.ocrAreaSaved"
        && data["kind"] == "event"
        && data["dst"] == "main"
        && matches!(data["src"].as_str(), Some("backend" | "qt-dialog"))
    {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { crate::ocr_coordinator::reload_active_ocr(&handle).await });
        return;
    }

    if data["src"] == "backend" && data["topic"] == "backend.event" && data["kind"] == "event" {
        let func = data["data"]["function"].as_str().unwrap_or("");
        on_backend_bus_function(app, func, &data["data"]["data"]);
        return;
    }

    if data["dst"] == "main" && data["kind"] == "request" {
        let handle = app.clone();
        let message = data.clone();
        tauri::async_runtime::spawn(async move {
            handle_agent_bus_request(&handle, message).await;
        });
    }
}

fn on_backend_bus_function(app: &AppHandle, function: &str, data: &Value) {
    match function {
        "on_connect" => mark_backend_bus_connected(app),
        "text_intake_state" => {
            let paused = data["paused"] == true;
            app.state::<AppLifecycle>()
                .inner
                .lock()
                .unwrap()
                .text_intake_paused = paused;
            sync_tray_visual_state(app);
        }
        "start_obs" => {
            let obs_app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = obs_app
                    .state::<crate::obs::Obs>()
                    .invoke(
                        &obs_app,
                        "obs.launchManaged",
                        &[json!({ "reason": "backend start_obs request" })],
                    )
                    .await;
            });
        }
        "initialized" => {
            mark_backend_bus_connected(app);
            let reopen_settings = {
                let lc = app.state::<AppLifecycle>();
                let mut g = lc.inner.lock().unwrap();
                g.backend_initialized = true;
                let reopen = g.reopen_settings_after_restart;
                g.reopen_settings_after_restart = false;
                reopen
            };
            maybe_notify_agent_restart_ready(app);
            emit_to_desktop_windows(app, "gsm-initialized", &[data.clone()]);
            let _ = crate::tray::refresh_menu(app);
            sync_tray_visual_state(app);
            if reopen_settings {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let _ =
                        crate::runtime::backend_command(&handle, "open_settings", json!({})).await;
                });
            }
        }
        "restart_python_app" => {
            let open_settings = data["open_settings"] != false;
            if open_settings {
                app.state::<AppLifecycle>()
                    .inner
                    .lock()
                    .unwrap()
                    .reopen_settings_after_restart = true;
            }
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::service_maintenance::restart_gsm(&handle).await;
            });
        }
        "ocr_hook_redundant" => {
            let lc = app.state::<AppLifecycle>();
            if lc.ocr_hook_redundant_shown.swap(true, Ordering::SeqCst) {
                return;
            }
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let detail = "Running both is usually unnecessary — the hook already captures the text.\n\n\
                    If you only kept OCR on for the overlay: the overlay is triggered by any text source, so it works from the hook alone without Auto OCR running.\n\n\
                    If you want to keep OCR on for Area Select OCR or menu text capture, I recommend using \"Manual OCR\" instead.\n\nStop OCR?";
                if let Ok(0) = crate::native::dialog_message(&json!({
                    "type": "question",
                    "buttons": ["Stop OCR", "Keep Both Running"],
                    "defaultId": 0,
                    "cancelId": 1,
                    "title": "OCR and text hook both running",
                    "message": "GSM noticed you're using a text hook and also have Auto OCR running.",
                    "detail": detail,
                }))
                .await
                {
                    crate::ocr_coordinator::stop_ocr_sync(
                        &handle,
                        "text-hook-redundancy-confirmed",
                        None,
                    );
                }
            });
        }
        "notification" if !data.is_null() => handle_python_notification(app, data),
        _ => {}
    }
}

fn handle_python_notification(app: &AppHandle, data: &Value) {
    let kind = data["type"].as_str().unwrap_or("");
    let message = data["message"].as_str().unwrap_or("");
    match kind {
        "AnkiCardUpdated" => {
            let note_id = data["noteId"].as_i64().filter(|n| *n > 0);
            let msg = if message.is_empty() {
                format!(
                    "Audio and/or Screenshot added to note: {}",
                    note_id.map(|n| n.to_string()).unwrap_or_default()
                )
            } else {
                message.to_owned()
            };
            send_notification_for_event(
                app,
                kind,
                "Anki Card Updated",
                &msg,
                note_id.map(NotificationClickAction::AnkiCard),
            );
        }
        "AnkiEnhancementFailed" => {
            let msg = if message.is_empty() {
                "Anki card enhancement failed. Check the console for details."
            } else {
                message
            };
            send_notification_for_event(app, kind, "Card error", msg, None);
        }
        "ScreenshotSaved" => {
            let path = data["path"].as_str().map(PathBuf::from);
            let msg = if message.is_empty() {
                format!(
                    "Screenshot saved to: {}",
                    path.as_ref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default()
                )
            } else {
                message.to_owned()
            };
            send_notification_for_event(
                app,
                kind,
                "Screenshot Saved",
                &msg,
                path.map(NotificationClickAction::OpenPath),
            );
        }
        "AudioGenerated" => {
            let path = data["path"].as_str().map(PathBuf::from);
            let msg = if message.is_empty() {
                format!(
                    "Audio trimmed and placed at {}",
                    path.as_ref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default()
                )
            } else {
                message.to_owned()
            };
            send_notification_for_event(
                app,
                kind,
                "Audio Generated",
                &msg,
                path.map(NotificationClickAction::OpenPath),
            );
        }
        "CheckOBS" => send_notification_for_event(app, kind, "Check OBS", message, None),
        "Error" => send_notification_for_event(app, kind, "Error", message, None),
        "GSMReady" => send_notification_for_event(app, kind, "GSM Ready", message, None),
        "PendingSessionReviews" => send_notification_for_event(
            app,
            kind,
            "Anki reviews pending",
            message,
            Some(NotificationClickAction::SessionReviews),
        ),
        "GSMTextIntakePaused" => {
            let msg = if message.is_empty() {
                "Clipboard and websocket text intake is paused."
            } else {
                message
            };
            send_notification_for_event(app, kind, "GSM Text Intake Paused", msg, None);
        }
        "GSMTextIntakeResumed" => {
            let msg = if message.is_empty() {
                "Clipboard and websocket text intake has resumed."
            } else {
                message
            };
            send_notification_for_event(app, kind, "GSM Text Intake Resumed", msg, None);
        }
        "OCRPaused" => send_notification_for_event(app, kind, "OCR paused", message, None),
        "OCRResumed" => send_notification_for_event(app, kind, "OCR resumed", message, None),
        _ => {}
    }
}

pub(crate) fn notify_mining_event(
    app: &AppHandle,
    event_id: &str,
    title: &str,
    body: &str,
    note_id: Option<i64>,
    open_path: Option<PathBuf>,
) {
    let action = note_id
        .filter(|n| *n > 0)
        .map(NotificationClickAction::AnkiCard)
        .or_else(|| open_path.map(NotificationClickAction::OpenPath));
    send_notification_for_event(app, event_id, title, body, action);
}

pub(crate) fn notify_pending_reviews(app: &AppHandle, count: usize) {
    send_notification_for_event(app,"PendingSessionReviews","Anki reviews pending",
        &format!("{count} card(s) awaiting session review"),Some(NotificationClickAction::SessionReviews));
}

fn send_notification_for_event(
    app: &AppHandle,
    event_id: &str,
    title: &str,
    body: &str,
    action: Option<NotificationClickAction>,
) {
    let active = &app.state::<crate::settings::Settings>().paths.active;
    let prefs_reader = Preferences::new(active);
    let cfg_path = active.join("config.json");
    let Ok(prefs) = get_notification_preferences(&prefs_reader, || {
        get_legacy_notification_features(&cfg_path)
    }) else {
        let id = app
            .state::<AppLifecycle>()
            .next_notification_id
            .fetch_add(1, Ordering::Relaxed);
        show_basic_toast(app, id, title, body, false, action);
        return;
    };

    if let Ok(delivery) = resolve_notification_delivery(event_id, &prefs) {
        if let Some(sound) = delivery.sound {
            let volume = prefs["volume"].as_u64().unwrap_or(15).min(100) as u8;
            if let Ok(payload) = playback_payload(sound, volume) {
                if let Ok(pb) =
                    serde_json::from_value::<crate::notification_audio::Playback>(payload)
                {
                    let _ = app
                        .state::<crate::notification_audio::NotificationAudio>()
                        .play(pb);
                }
            }
        }
        if !delivery.banner {
            return;
        }
        let id = app
            .state::<AppLifecycle>()
            .next_notification_id
            .fetch_add(1, Ordering::Relaxed);
        show_basic_toast(app, id, title, body, true, action);
    } else {
        let id = app
            .state::<AppLifecycle>()
            .next_notification_id
            .fetch_add(1, Ordering::Relaxed);
        show_basic_toast(app, id, title, body, false, action);
    }
}

fn show_basic_toast(
    app: &AppHandle,
    id: i64,
    title: &str,
    body: &str,
    silent: bool,
    action: Option<NotificationClickAction>,
) {
    if let Some(act) = action {
        let lc = app.state::<AppLifecycle>();
        let mut g = lc.inner.lock().unwrap();
        // Bound stored click targets so old dismissed toast IDs never accumulate unboundedly.
        if g.notification_actions.len() > 64 {
            g.notification_actions.clear();
        }
        g.notification_actions.insert(id, act);
    }

    let icon = current_window_icon_path(app);
    let mut payload = json!({
        "id": id,
        "icon": icon.is_file().then(|| icon.to_string_lossy().into_owned()),
        "title": title,
        "body": body,
        "silent": silent,
    });
    // Drop the lifecycle lock before selecting buttons or delivering the toast.
    // An if-let / else-if chain keeps its temporary guard alive in Rust 2021,
    // so looking up the second action there would deadlock the window thread.
    let click_action = app
        .state::<AppLifecycle>()
        .inner
        .lock()
        .unwrap()
        .notification_actions
        .get(&id)
        .cloned();
    match click_action {
        Some(NotificationClickAction::AnkiCard(_)) => {
            payload["actions"] = json!([{ "type": "button", "text": "Open Card" }]);
        }
        Some(NotificationClickAction::SessionReviews) => {
            payload["actions"] = json!([{ "type": "button", "text": "Review cards" }]);
        }
        _ => {}
    }

    #[cfg(windows)]
    {
        let _ = crate::windows_notifications::apply(app, &payload, false);
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .id(id as i32)
            .title(title)
            .body(body)
            .show();
    }
}

/// Handle OS notification click/dismiss/failure without Node.
pub fn on_notification_action(app: &AppHandle, id: i64, action: &str) {
    if id == AGENT_RESTART_NOTIFICATION_ID {
        let (control, req_id, startup_args) = {
            let lc = app.state::<AppLifecycle>();
            let g = lc.inner.lock().unwrap();
            (
                g.agent_control.clone(),
                g.pending_agent_request_id.clone(),
                g.startup_args.clone(),
            )
        };
        let (Some(control), Some(req_id)) = (control, req_id) else {
            return;
        };
        if action == "0" {
            close_restart_warning_toast(app);
            if control.mark_restart_early(&req_id) {
                let args = agent_relaunch_args(
                    &startup_args.into_iter().skip(1).collect::<Vec<_>>(),
                    &req_id,
                );
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    quit_app(&handle, Some(args)).await;
                });
            }
        } else if action == "1" {
            close_restart_warning_toast(app);
            control.cancel_restart(&req_id);
        }
        return;
    }

    if matches!(action, "close" | "failed") {
        app.state::<AppLifecycle>()
            .inner
            .lock()
            .unwrap()
            .notification_actions
            .remove(&id);
        return;
    }

    let click_action = app
        .state::<AppLifecycle>()
        .inner
        .lock()
        .unwrap()
        .notification_actions
        .remove(&id);
    let Some(click_action) = click_action else {
        return;
    };

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match click_action {
            NotificationClickAction::AnkiCard(note_id) => {
                let _ = handle
                    .state::<DesktopState>()
                    .http
                    .post("http://127.0.0.1:8765/")
                    .json(&json!({
                        "action": "guiEditNote",
                        "version": 6,
                        "params": { "note": note_id }
                    }))
                    .send()
                    .await;
            }
            NotificationClickAction::OpenPath(path) => {
                let _ = crate::native::shell_open_path(&path);
            }
            NotificationClickAction::SessionReviews => {
                if let Err(error) = crate::gui_dialog::open(&handle, crate::gui_dialog::Dialog::SessionReview).await {
                    crate::desktop_log::error(&handle, "lifecycle", format!("Could not open session review: {error}"));
                }
            }
        }
    });
}

fn agent_blocked_reason(app: &AppHandle) -> Option<String> {
    if app.state::<DesktopState>().quitting.load(Ordering::SeqCst) {
        return Some("GSM is shutting down.".into());
    }
    if crate::update_manager::any_app_update_in_progress(app) {
        return Some("An update or installation is in progress.".into());
    }
    let obs_updating = app
        .try_state::<crate::obs::Obs>()
        .is_some_and(|o| o.state()["updating"] == true);
    let install_running = app
        .state::<crate::install_session::InstallSessions>()
        .model
        .call("snapshot", &json!({}))
        .ok()
        .is_some_and(|s| s["status"] == "running");
    if obs_updating || install_running {
        return Some("An update or installation is in progress.".into());
    }
    if std::env::var_os("VITE_DEV_SERVER_URL").is_some() {
        return Some(
            "Agent restarts require GSM launched directly; dev server manages its own restarts."
                .into(),
        );
    }
    None
}

async fn send_bus_reply(app: &AppHandle, req: &Value, result: Result<Value, String>) {
    let Ok(rt) = crate::runtime::get(app) else {
        return;
    };
    let mut reply = json!({
        "dst": req["src"],
        "topic": req["topic"],
        "corr": req["id"],
        "ok": result.is_ok(),
        "data": Value::Null,
    });
    match result {
        Ok(data) => reply["data"] = data,
        Err(err) => reply["error"] = Value::String(err),
    }
    let _ = rt.call("bus.reply", reply).await;
}

async fn handle_agent_bus_request(app: &AppHandle, mut req: Value) {
    let topic = req["topic"].as_str().unwrap_or("");
    if topic == "settings.profile.save" {
        let result = if req["src"] == "qt-settings" || req["src"] == "backend" {
            let handle = app.clone();
            let data = req["data"].take();
            tokio::task::spawn_blocking(move || {
                let path = handle.state::<crate::settings::Settings>().paths.active.join("config.json");
                gsm_settings::profile_config::save_edits(&path,&data["before"],&data["after"])?;
                Ok(Value::Null)
            }).await.unwrap_or_else(|e| Err(e.to_string()))
        } else { Err("Settings editor required".into()) };
        let saved = result.is_ok();
        send_bus_reply(app, &req, result).await;
        if saved {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move { crate::mining_settings::changed(&handle).await; });
        }
        return;
    }
    if topic == "text.intake" || topic == "text.intake.hook" {
        let result = match (topic, req["src"].as_str(), req["connectionEpoch"].as_u64()) {
            ("text.intake", Some("backend"), Some(epoch)) => crate::text_intake::request(app, epoch, req["data"].take()).await,
            ("text.intake.hook", Some("main"), _) => crate::text_intake::submit(app, req["data"].take(), None).await,
            _ => Err("Invalid text intake sender".into()),
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if matches!(
        topic,
        "mining.gateway.register"
            | "mining.replayState"
            | "mining.configChanged"
            | "mining.status"
            | "mining.ai"
            | "mining.sessionReview"
    ) {
        let result = if req["src"] == "backend" {
            let mining = app
                .state::<Arc<crate::mining::MiningService>>()
                .inner()
                .clone();
            mining.handle_request(app, topic, req["data"].clone()).await
        } else {
            Err("Mining backend required".into())
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if topic == "text.classify" {
        let result = if req["src"] == "backend" {
            let input = req["data"].take();
            tauri::async_runtime::spawn_blocking(move || crate::text_correlation::request(&input))
                .await.map_err(|e| e.to_string()).and_then(|r| r)
        } else {
            Err("Mining backend required".into())
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if matches!(topic, "anki.group" | "anki.cards") {
        let result = match (req["src"].as_str(), req["connectionEpoch"].as_u64()) {
            (Some("backend"), Some(epoch)) if topic == "anki.cards" => {
                crate::anki_cards::request(app, epoch, req["data"].clone()).await
            }
            (Some("backend"), Some(epoch)) => crate::anki_group::request(app, epoch, req["data"].clone()).await,
            _ => Err("Mining backend required".into()),
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if matches!(topic, "anki.sync" | "anki.sync.stop") {
        let result = match (req["src"].as_str(), req["connectionEpoch"].as_u64()) {
            (Some("backend"), Some(epoch)) if topic == "anki.sync.stop" => {
                app.state::<crate::anki_sync::SyncLane>().stop(epoch);
                Ok(Value::Null)
            }
            (Some("backend"), Some(epoch)) => crate::anki_sync::request(app, epoch, req["data"].clone()).await,
            _ => Err("Mining backend required".into()),
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if topic == "mining.cron" {
        let result = match (req["src"].as_str(), req["connectionEpoch"].as_u64()) {
            (Some("backend"), Some(epoch)) => crate::cron::request(app.clone(), epoch, req["data"].clone()).await,
            _ => Err("Mining backend required".into()),
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if topic == "anki.edit" {
        let result = if req["src"] == "backend" {
            match serde_json::from_value(req["data"].clone()) {
                Ok(edit) => crate::anki_edit::commit(&app.state::<DesktopState>().http, edit).await,
                Err(e) => Err(e.to_string()),
            }
        } else {
            Err("Mining backend required".into())
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if topic == "anki.storeMedia" {
        let result = if req["src"] != "backend" {
            Err("Mining backend required".into())
        } else {
            match serde_json::from_value(req["data"].clone()) {
                Ok(upload) => crate::anki_media::store(&app.state::<DesktopState>().http, upload).await,
                Err(error) => Err(error.to_string()),
            }
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if topic == "anki.monitor" {
        let result = match (req["src"].as_str(), req["connectionEpoch"].as_u64()) {
            (Some("backend"), Some(epoch)) => match serde_json::from_value(req["data"].clone()) {
                Ok(command) => app.state::<crate::anki_poll::monitor::Monitor>()
                    .request(epoch, command, &app.state::<crate::anki_poll::Notes>(), &app.state::<DesktopState>().http).await,
                Err(e) => Err(e.to_string()),
            },
            _ => Err("Mining backend required".into()),
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if topic == "anki.poll" {
        let result = if req["src"] != "backend" {
            Err("Mining backend required".into())
        } else {
            match serde_json::from_value(req["data"].clone()) {
                Ok(poll) => app.state::<crate::anki_poll::Notes>().poll(&app.state::<DesktopState>().http, poll).await,
                Err(e) => Err(e.to_string()),
            }
        };
        send_bus_reply(app,&req,result).await;
        return;
    }
    if topic == "mining.history" {
        let result = if req["src"] == "backend" {
            crate::mining_history::request(app.clone(), req["data"].clone()).await
        } else {
            Err("Mining backend required".into())
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if topic == "mining.wordIndex" {
        let result = if req["src"] == "backend" {
            crate::word_index::request(app, req["data"].clone()).await
        } else {
            Err("Mining backend required".into())
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if matches!(topic, "game.session" | "game.profile.select") {
        let obs = app.state::<crate::obs::Obs>();
        let result = if req["src"] != "backend"
            && !(topic == "game.session" && crate::obs::is_reader(&req["src"]))
        {
            Err("Mining backend required".into())
        } else if topic == "game.session" {
            Ok(obs.wait_game_session(req["data"]["after"].as_u64()).await)
        } else {
            let result = obs.select_game_profile(
                req["data"]["name"].as_str().unwrap_or(""),
                req["data"]["scene_epoch"].as_u64(),
            );
            if result.is_ok() {
                crate::mining_settings::changed(app).await;
            }
            result
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    if matches!(
        topic,
        "obs.outputs"
            | "obs.request"
            | "obs.imageChunk"
            | "obs.configure"
            | "obs.lifecycle"
            | "game.windowInput"
    ) {
        let reader = crate::obs::is_reader(&req["src"]);
        let result = if req["src"] == "backend"
            || (reader
                && (topic == "obs.imageChunk"
                    || (topic == "obs.request"
                        && req["data"]["method"]
                            .as_str()
                            .is_some_and(|m| m.starts_with("Get")))))
        {
            let obs = app.state::<crate::obs::Obs>();
            match topic {
                #[cfg(windows)]
                "game.windowInput" => obs.target_input(&req["data"]).await,
                #[cfg(not(windows))]
                "game.windowInput" => Ok(Value::Bool(false)),
                "obs.outputs" => obs.mining_output(app, &req["data"], now_epoch_ms()).await,
                "obs.configure" => { obs.refresh_session(); Ok(Value::Null) },
                "obs.lifecycle" => match req["data"]["action"].as_str() {
                    Some("close") => obs.invoke(app,"obs.close",&[]).await,
                    Some(action @ ("start"|"restart")) => obs.invoke(app,"obs.launchManaged",&[json!({"forceRestart":action=="restart","ignoreOpenConfig":true,"allowPathFallback":true})]).await,
                    _ => Err("Unknown OBS lifecycle action".into()),
                },
                _ => obs.backend_request(topic, &req["data"]).await,
            }
        } else {
            Err("Desktop OBS request is unavailable for this client".into())
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    // Backend dictionary requests have an application lifetime. They must not
    // depend on either the overlay socket or agent restart support being active.
    if matches!(topic, "dictionary.setup" | "dictionary.ankiSetup") {
        let result = if req["src"] != "backend" {
            Err("Only the backend can request dictionary setup".into())
        } else {
            Ok(crate::dictionary_service::handle_request(app, topic, &req["data"]).await)
        };
        send_bus_reply(app, &req, result).await;
        return;
    }
    let control = app
        .state::<AppLifecycle>()
        .inner
        .lock()
        .unwrap()
        .agent_control
        .clone();
    let Some(control) = control else {
        send_bus_reply(
            app,
            &req,
            Err("Agent restart control is unavailable.".into()),
        )
        .await;
        return;
    };

    match topic {
        "app.agent.status" => {
            let (ready, blocked) = {
                let lc = app.state::<AppLifecycle>();
                let g = lc.inner.lock().unwrap();
                let owner_ready = app.state::<Arc<crate::mining::MiningService>>().is_enabled();
                (
                    g.backend_initialized
                        && g.backend_status_ready
                        && owner_ready
                        && !app.state::<DesktopState>().quitting.load(Ordering::SeqCst),
                    agent_blocked_reason(app),
                )
            };
            send_bus_reply(app, &req, Ok(control.status(ready, blocked))).await;
        }
        "app.agent.restart" => {
            let blocked = agent_blocked_reason(app);
            let res = control.reserve_restart(&req["data"], blocked.as_deref());
            let (reservation, is_new) = match res {
                Ok(pair) => pair,
                Err(err) => {
                    send_bus_reply(app, &req, Err(err)).await;
                    return;
                }
            };
            if is_new {
                app.state::<AppLifecycle>()
                    .inner
                    .lock()
                    .unwrap()
                    .pending_agent_request_id = Some(reservation.request_id.clone());

                let seconds = (reservation.restart_at.saturating_sub(now_epoch_ms()) + 999) / 1000;
                if let Err(err) =
                    show_restart_warning_toast(app, &reservation.reason, seconds.max(1))
                {
                    control.clear_pending_if_unshown(&reservation.request_id);
                    send_bus_reply(app, &req, Err(err)).await;
                    return;
                }
                let (tx, mut rx) = tokio::sync::watch::channel(false);
                match control.arm_timer(&reservation.request_id, tx) {
                    Ok((early, cancelled)) => {
                        if !cancelled {
                            let req_id = reservation.request_id.clone();
                            let startup_args = app
                                .state::<AppLifecycle>()
                                .inner
                                .lock()
                                .unwrap()
                                .startup_args
                                .clone();
                            if early {
                                close_restart_warning_toast(app);
                                let args = agent_relaunch_args(
                                    &startup_args.into_iter().skip(1).collect::<Vec<_>>(),
                                    &req_id,
                                );
                                let handle = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    quit_app(&handle, Some(args)).await;
                                });
                            } else {
                                let delay_ms =
                                    reservation.restart_at.saturating_sub(now_epoch_ms());
                                let timer_app = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    tokio::select! {
                                        _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {
                                            close_restart_warning_toast(&timer_app);
                                            if control.mark_restart_early(&req_id) || true {
                                                let args = agent_relaunch_args(
                                                    &startup_args.into_iter().skip(1).collect::<Vec<_>>(),
                                                    &req_id,
                                                );
                                                quit_app(&timer_app, Some(args)).await;
                                            }
                                        }
                                        _ = rx.changed() => {}
                                    }
                                });
                            }
                        }
                    }
                    Err(err) => {
                        close_restart_warning_toast(app);
                        send_bus_reply(app, &req, Err(err)).await;
                        return;
                    }
                }
            }
            send_bus_reply(app, &req, Ok(json!(reservation))).await;
        }
        _ => {
            send_bus_reply(
                app,
                &req,
                Err(format!("Unsupported main request topic: {topic}")),
            )
            .await;
        }
    }
}

fn hide_user_facing_shutdown_surfaces(app: &AppHandle) {
    app.state::<DesktopState>()
        .quitting
        .store(true, Ordering::SeqCst);
    {
        let lc = app.state::<AppLifecycle>();
        let mut g = lc.inner.lock().unwrap();
        g.ready_timer_gen = g.ready_timer_gen.wrapping_add(1);
        g.ready_indicator_expires_at_ms = 0;
    }
    if let Some(hub) = app.get_webview_window(HUB_WINDOW_LABEL) {
        let _ = hub.hide();
    }
    crate::tray::destroy(app);
}

async fn stop_all_subsystems(app: &AppHandle, reason: &str) -> Result<(), String> {
    app.state::<crate::mining_workspace::MiningWorkspace>().speech.stop(app, reason).await;
    if let Some(obs) = app.try_state::<crate::obs::Obs>() {
        let _ = tokio::time::timeout(
            Duration::from_secs(60),
            obs.invoke(app, "obs.runtime.wait", &[]),
        )
        .await;
    }

    crate::auto_launcher::AutoLauncher::stop(app);
    app.state::<crate::cron::Scheduler>().drain().await;
    crate::game_privileges::stop(app);
    crate::game_background::stop(app);
    crate::game_launcher::stop(app);
    app.state::<crate::hook_updates::HookUpdates>().shutdown();
    app.state::<crate::overlay_host::OverlayHost>()
        .stop(app)
        .await;
    app.state::<crate::overlay_host::OverlayHost>()
        .shutdown(app);
    let _ = crate::ocr_coordinator::stop_ocr_sync(app, reason, None);
    app.state::<crate::ocr_coordinator::OcrCoordinator>()
        .shutdown(app);
    app.state::<crate::texthook::TextHook>().shutdown();
    app.state::<crate::agent::Agent>().shutdown();
    app.state::<crate::overlay::Overlay>().shutdown();
    app.state::<crate::ocr::Ocr>().shutdown();

    let mut errors = Vec::new();
    if let Err(e)=crate::text_intake::finish_desktop(app).await{errors.push(e);}
    #[cfg(windows)]
    crate::obs::game_audio::shutdown(app);
    if let Some(obs) = app.try_state::<crate::obs::Obs>() {
        if let Err(error) = obs.shutdown_mining(app).await {
            crate::desktop_log::warn(app,"obs",error);
        }
    }
    if let Err(error) = app.state::<crate::longplay::Service>().finish().await { errors.push(error); }
    if let Err(err) = crate::service_maintenance::stop_managed_processes(app).await {
        errors.push(err);
    }
    crate::input_server::stop(app);

    if let Some(obs) = app.try_state::<crate::obs::Obs>() {
        match obs
            .invoke(app, "obs.close", &[json!({ "reason": reason })])
            .await
        {
            Ok(result) if result["status"] == "failed" => {
                errors.push(
                    result["error"]
                        .as_str()
                        .unwrap_or("OBS could not close safely.")
                        .to_owned(),
                );
            }
            Err(err) => errors.push(err),
            Ok(_) => {}
        }
    }

    if let Some(mining) = app.try_state::<Arc<crate::mining::MiningService>>() {
        mining.shutdown();
    }
    app.state::<crate::runtime::Runtime>().shutdown();
    app.state::<crate::install_session::InstallSessions>()
        .shutdown();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Stop every managed child process/handle prior to data-folder relocation without quitting.
pub async fn stop_for_relocation(app: &AppHandle) -> Result<(), String> {
    stop_all_subsystems(app, "data relocation").await
}

/// Gracefully tear down all subsystems, tray/windows, and optionally schedule relaunch.
pub async fn quit_app(app: &AppHandle, relaunch_args: Option<Vec<String>>) {
    let lc = app.state::<AppLifecycle>();
    let _guard = lc.quit_lock.lock().await;
    hide_user_facing_shutdown_surfaces(app);

    let cleanup_res = stop_all_subsystems(app, "app quit").await;
    if let Some(args) = relaunch_args {
        if let Err(ref err) = cleanup_res {
            crate::desktop_log::error(
                app,
                "shutdown",
                format!("Cleanup failed before restart: {err}"),
            );
            if let Some(control) = lc.inner.lock().unwrap().agent_control.clone() {
                control.fail(
                    "GSM could not stop all background processes; restart cancelled. Check the GSM logs before starting again.",
                );
            }
        } else {
            app.state::<DesktopState>().set_relaunch(args);
        }
    }

    if let Some(control) = lc.inner.lock().unwrap().agent_control.take() {
        control.dispose();
    }

    #[cfg(windows)]
    crate::windows_notifications::close_all(app);

    let exit_code = if cleanup_res.is_ok() { 0 } else { 1 };
    app.exit(exit_code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_startup_cli_flags_and_agent_restart_id() {
        let parsed = StartupCliArgs::parse([
            "--scene",
            "VN Scene",
            "--game=clannad",
            "--game",
            "420",
            "--ocr",
            "--gsm-agent-restarted=req-123",
        ]);
        assert_eq!(parsed.scene.as_deref(), Some("VN Scene"));
        assert_eq!(parsed.game.as_deref(), Some("420"));
        assert!(parsed.ocr);
        assert!(!parsed.force_all_updates);
        assert_eq!(parsed.agent_restart_id.as_deref(), Some("req-123"));
    }
}
