#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod active_game;
mod agent;
mod agent_control;
mod agent_scripts;
mod app_identity;
mod app_lifecycle;
mod assets;
mod auto_launcher;
mod backend;
mod database_startup;
mod longplay;
#[cfg(windows)]
mod browser_extensions;
#[cfg(windows)]
mod jiten_webview;
mod capture_windows;
mod commands;
mod desktop_changelog;
mod desktop_log;
mod desktop_services;
mod desktop_state;
#[cfg(all(windows, any(debug_assertions, feature = "local-build")))]
mod dev_launch;
mod browser_dictionary;
mod dictionary_host;
mod dictionary_service;
mod game_background;
mod game_metadata;
mod game_launcher;
mod game_privileges;
mod hook_updates;
mod input_server;
mod install_session;
mod launchers_ui;
mod linux_wine;
mod mining;
mod mining_settings;
mod mining_workspace;
mod card_dialog;
mod gui_dialog;
mod native_dialog;
mod recommended_anki;
mod screenshot_selector;
mod anki_cards;
mod text_correlation;
mod text_intake;
mod anki_connect;
mod anki_edit;
mod anki_group;
mod anki_media;
mod anki_poll;
mod anki_sync;
mod mining_history;
mod recycled_lines;
mod cron;
mod word_index;
mod memory;
mod native;
mod notification_audio;
mod obs;
mod obs_service;
mod ocr;
mod ocr_coordinator;
mod ocr_preview;
mod ocr_selector;
mod overlay;
mod overlay_host;
mod overlay_jiten;
mod overlay_magpie;
mod overlay_pointer;
mod overlay_preload;
mod overlay_settings;
mod overlay_tray;
mod overlay_vn_guide;
mod process_probe;
#[cfg(windows)]
mod resource_usage;
mod python_install;
mod python_ops;
mod reader_service;
mod runtime;
mod settings;
mod settings_tools;
mod live_status;
#[cfg(windows)]
mod startup_tools;
mod smoke_test;
mod sudachi_setup;
mod texthook;
mod texthook_coordinator;
mod tray;
mod update_manager;
mod window_platform;
#[cfg(windows)]
mod windows_input;
#[cfg(windows)]
mod windows_notifications;
#[cfg(windows)]
mod windows_tray;

use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

pub(crate) fn authorize(window: &tauri::WebviewWindow, token: &str) -> Result<(), String> {
    window
        .app_handle()
        .state::<desktop_state::DesktopState>()
        .authorize(window, token)
}

#[tauri::command]
async fn renderer_log(
    level: String,
    message: String,
    token: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    authorize(&window, &token)?;
    desktop_log::renderer(window.label(), &level, &message);
    Ok(())
}

#[tauri::command]
async fn desktop_call(
    mode: String,
    channel: String,
    args: Vec<Value>,
    token: String,
    window: tauri::WebviewWindow,
    desktop: State<'_, desktop_state::DesktopState>,
) -> Result<Value, String> {
    desktop.authorize(&window, &token)?;
    let scope = desktop.window_scope(window.label());
    match scope.as_deref() {
        Some("desktop") => {}
        Some("overlay") => {}
        Some("card-dialog") if mode == "invoke" &&
            (channel.starts_with("cardDialog.") || channel == "settings.getSettings") => {}
        Some("vn-guide") => {
            let allowed = matches!(
                (mode.as_str(), channel.as_str()),
                ("invoke", "vn-guide-state")
                    | ("invoke", "vn-guide-command")
                    | ("send", "vn-guide-command")
                    | ("send", "gsm-find-in-page:command")
            );
            if !allowed {
                return Err("This VN guide window cannot access that desktop channel".into());
            }
        }
        _ => return Err("This window cannot control the desktop".into()),
    }
    if !matches!(mode.as_str(), "invoke" | "send") || channel.len() > 200 || args.len() > 64 {
        return Err("Invalid desktop request".into());
    }
    if channel == "install-session.executeRetry" {
        return Err("Private desktop operation".into());
    }
    if scope.as_deref() == Some("desktop")
        && mode == "invoke"
        && window.label() == "obs-scene-conflict"
        && channel == "settings.getSettings"
    {
        return window.app_handle().state::<obs::Obs>().ui_settings();
    }
    if mode == "invoke" {
        if let Some(result) =
            desktop_services::invoke(window.app_handle(), window.label(), &channel, &args).await
        {
            return result;
        }
    } else if mode == "send"
        && desktop_services::send(window.app_handle(), window.label(), &channel, &args).await
    {
        return Ok(Value::Null);
    }
    Err(format!("Unhandled {scope:?} {mode} channel: {channel}"))
}

#[tauri::command]
fn overlay_aux_hide(window: tauri::WebviewWindow) -> Result<(), String> {
    if !matches!(
        window.label(),
        overlay_host::OVERLAY_CUSTOM_PAGE_LABEL | overlay_host::OVERLAY_TEXTHOOKER_LABEL
    ) {
        return Err("This window is not an overlay companion".into());
    }
    window
        .app_handle()
        .state::<overlay_host::OverlayHost>()
        .hide_aux_window(window.app_handle(), window.label());
    Ok(())
}

#[tauri::command]
async fn window_input(
    input: Value,
    token: String,
    window: tauri::WebviewWindow,
    desktop: State<'_, desktop_state::DesktopState>,
) -> Result<Value, String> {
    desktop.authorize(&window, &token)?;
    if desktop.window_scope(window.label()).as_deref() == Some("remote") {
        return Err("Remote page input is not accepted".into());
    }
    app_lifecycle::handle_window_input(&window, &input);
    Ok(Value::Null)
}

#[tauri::command]
async fn dictionary_call(
    params: Value,
    token: String,
    window: tauri::WebviewWindow,
    desktop: State<'_, desktop_state::DesktopState>,
) -> Result<Value, String> {
    desktop.authorize(&window, &token)?;
    if desktop.window_scope(window.label()).as_deref() == Some("remote") {
        return Err("This window cannot access dictionaries".into());
    }
    if let Some(result) = window
        .app_handle()
        .state::<dictionary_host::DictionaryManager>()
        .try_dictionary_call(window.app_handle(), &window, &params)
        .await
    {
        return result;
    }
    Err("Unsupported dictionary operation".into())
}

#[tauri::command]
async fn dictionary_selection(
    text: String,
    context: String,
    token: String,
    window: tauri::WebviewWindow,
    desktop: State<'_, desktop_state::DesktopState>,
) -> Result<Value, String> {
    desktop.authorize(&window, &token)?;
    if text.is_empty() || text.chars().count() > 200 || context.chars().count() > 20000 {
        return Err("Invalid reading selection".into());
    }
    if let Some(result) =
        reader_service::try_dictionary_selection(window.app_handle(), &text, &context).await
    {
        return result;
    }
    Err("Dictionary selection could not be handled".into())
}

#[tauri::command]
async fn evaluation_result(
    id: u64,
    result: Option<Value>,
    error: Option<String>,
    token: String,
    window: tauri::WebviewWindow,
    desktop: State<'_, desktop_state::DesktopState>,
) -> Result<(), String> {
    desktop.authorize(&window, &token)?;
    desktop.resolve_evaluation(window.label(), id, result, error)
}

#[tauri::command]
async fn desktop_clipboard(
    operation: String,
    text: Option<String>,
    token: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    desktop: State<'_, desktop_state::DesktopState>,
) -> Result<Value, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    desktop.authorize(&window, &token)?;
    if matches!(
        desktop.window_scope(window.label()).as_deref(),
        Some("remote" | "vn-guide")
    ) {
        return Err("This window cannot access the clipboard".into());
    }
    match operation.as_str() {
        "read-image" => {
            use base64::Engine;
            let image = app.clipboard().read_image().map_err(|e| e.to_string())?;
            let pixels =
                image::RgbaImage::from_raw(image.width(), image.height(), image.rgba().to_vec())
                    .ok_or("Invalid clipboard image")?;
            let mut buffer = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(pixels)
                .write_to(&mut buffer, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            Ok(json!(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(buffer.into_inner())
            )))
        }
        "read" => app
            .clipboard()
            .read_text()
            .map(Value::String)
            .map_err(|e| e.to_string()),
        "write" => app
            .clipboard()
            .write_text(text.unwrap_or_default())
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        _ => Err("Invalid clipboard operation".into()),
    }
}

pub fn request_relaunch(app: &tauri::AppHandle, extra_args: Vec<String>) {
    if let Some(desktop) = app.try_state::<desktop_state::DesktopState>() {
        desktop.set_relaunch(extra_args);
    }
    app.exit(0);
}

#[cfg(windows)]
fn wait_for_relaunch_parent_pid(raw_args: &[String]) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let mut pid = None;
    let mut iter = raw_args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if arg == "--wait-pid" {
            pid = iter.next().and_then(|v| v.parse::<u32>().ok());
            break;
        } else if let Some(val) = arg.strip_prefix("--wait-pid=") {
            pid = val.parse::<u32>().ok();
            break;
        }
    }
    let Some(pid) = pid.filter(|p| *p > 0) else {
        return;
    };
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            let _ = WaitForSingleObject(handle, 15_000);
            let _ = CloseHandle(handle);
        }
    }
}

const LOCAL_BUILD: bool = cfg!(any(debug_assertions, feature = "local-build"));
const PORTABLE_PREVIEW: bool = cfg!(feature = "portable-preview");

fn app_root_override() -> Option<PathBuf> {
    std::env::var_os("GSM_APP_ROOT")
        .map(PathBuf::from)
        .or_else(|| {
            LOCAL_BUILD.then(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .to_path_buf()
            })
        })
}

fn main() {
    let raw_args: Vec<String> = std::env::args().collect();
    if let Some(code) = game_launcher::maybe_run_unelevated_helper(&raw_args) {
        std::process::exit(code);
    }
    #[cfg(windows)]
    {
        wait_for_relaunch_parent_pid(&raw_args);
        if std::env::var_os("GSM_SMOKE_TEST").is_some() {
            if let Err(error) = smoke_test::own_process_tree() {
                desktop_log::stderr_only(
                    "main",
                    "ERROR",
                    format!("Could not isolate the smoke test process tree: {error}"),
                );
                std::process::exit(1);
            }
        }
    }
    #[cfg(all(windows, any(debug_assertions, feature = "local-build")))]
    match dev_launch::bootstrap(&raw_args) {
        Ok(Some(code)) => std::process::exit(code),
        Ok(None) => {}
        Err(error) => {
            desktop_log::stderr_only("main", "ERROR", format!("Could not launch GSM: {error}"));
            std::process::exit(1);
        }
    }
    let relaunch = Arc::new(Mutex::new(None));
    let setup_relaunch = relaunch.clone();
    let mut context = tauri::generate_context!();
    // Tauri owns the dev server address; legacy page guards consume the same
    // origin until the remaining compatibility views have moved to commands.
    #[cfg(debug_assertions)]
    if let Some(url) = &context.config().build.dev_url {
        std::env::set_var("VITE_DEV_SERVER_URL", url.as_str());
    }
    // Explicit profiles have independent service ownership, including when
    // their folder was selected on the command line rather than in the env.
    let mut profile = std::env::var("GSM_PROFILE_DIR").ok();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if matches!(arg.as_str(), "--profile" | "-profile") {
            profile = Some(
                args.next()
                    .filter(|path| !path.trim().is_empty() && !path.starts_with('-'))
                    .expect("--profile requires a profile folder"),
            );
        } else if arg.starts_with("--profile=") || arg.starts_with("-profile=") {
            profile = arg.split_once('=').map(|(_, path)| path.into());
        }
    }
    if let Some(profile) = profile {
        assert!(!profile.trim().is_empty(), "Profile folder cannot be empty");
        let path = if profile == "~" || profile.starts_with("~/") || profile.starts_with("~\\") {
            dirs::home_dir()
                .expect("Home directory")
                .join(profile.get(2..).unwrap_or(""))
        } else {
            PathBuf::from(&profile)
        };
        let absolute = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .expect("Working directory")
                .join(path)
        };
        std::fs::create_dir_all(&absolute).expect("Create profile folder");
        let normalized = absolute
            .canonicalize()
            .unwrap_or(absolute)
            .to_string_lossy()
            .into_owned();
        std::env::set_var("GSM_PROFILE_DIR", &normalized);
        let normalized = if cfg!(windows) {
            normalized.to_lowercase()
        } else {
            normalized
        };
        let hash = normalized
            .bytes()
            .fold(0xcbf29ce484222325u64, |hash, byte| {
                (hash ^ (byte as u64)).wrapping_mul(0x100000001b3)
            });
        context
            .config_mut()
            .identifier
            .push_str(&format!(".profile{hash:x}"));
    }
    let assets = Arc::new(assets::Assets::default());
    let protocol_assets = assets.clone();
    let yomitan_assets = assets.clone();
    let hachidori_assets = assets.clone();
    let jiten_assets = assets.clone();
    let mut builder = tauri::Builder::default();
    if std::env::var_os("GSM_SMOKE_TEST").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            app_lifecycle::handle_single_instance(app, args);
        }));
    }
    let application = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .register_uri_scheme_protocol("gsm", move |_context, request| {
            protocol_assets.response(request)
        })
        .register_asynchronous_uri_scheme_protocol("gsm-yomitan", move |_context, request, responder| {
            if assets::yomitan_font_request(&request) {
                let assets = yomitan_assets.clone();
                tauri::async_runtime::spawn_blocking(move || responder.respond(assets.response(request)));
            } else {
                responder.respond(yomitan_assets.response(request));
            }
        })
        .register_uri_scheme_protocol("gsm-hachidori", move |_context, request| {
            hachidori_assets.response(request)
        })
        .register_uri_scheme_protocol("gsm-jiten", move |_context, request| {
            jiten_assets.response(request)
        })
        .setup(move |app| {
            use tauri_plugin_notification::NotificationExt;
            let handle = app.handle().clone();
            app.notification().on_action(move |action| {
                if let Some(notification) = action.notification() {
                    app_lifecycle::on_notification_action(
                        &handle,
                        i64::from(notification.id()),
                        action.action_id(),
                    );
                }
            })?;
            let root = match app_root_override() {
                Some(root) => root,
                None => app.path().resource_dir()?.join("app"),
            };
            gsm_overlay::engines::vocr::set_asset_directory(
                root.join("GameSentenceMiner/assets/vocr"),
                gsm_packages::download_cache().map_err(std::io::Error::other)?,
            )
            .map_err(std::io::Error::other)?;
            for (id, relative) in [
                ("renderer", "dist/renderer"),
                ("overlay", "GSM_Overlay"),
                ("assets", "assets"),
                ("desktop-assets", "electron-src/assets"),
            ] {
                if root.join(relative).is_dir() {
                    assets
                        .mount(id, &root.join(relative))
                        .map_err(std::io::Error::other)?;
                }
            }
            app.manage(overlay::Overlay::new(app.handle().clone()));
            app.manage(ocr::Ocr::new(app.handle().clone()));
            app.manage(notification_audio::NotificationAudio::default());
            app.manage(obs::Obs::default());
            app.manage(obs::game_pause::GamePause::default());
            app.manage(text_intake::hotkeys::Hotkeys::default());
            app.manage(longplay::Service::default());
            app.manage(texthook::TextHook::default());
            app.manage(agent::Agent::default());
            app.manage(runtime::Runtime::default());
            app.manage(text_intake::Intake::default());
            app.manage(backend::BackendState::default());
            app.manage(mining_workspace::MiningWorkspace::default());
            app.manage(gui_dialog::DialogHost::default());
            app.manage(card_dialog::Windows::default());
            app.manage(mining_settings::Navigation::default());
            app.manage(anki_group::chooser::GroupingWindows::default());
            app.manage(screenshot_selector::Selectors::default());
            app.manage(recommended_anki::Windows::default());
            app.manage(ocr_preview::Windows::default());
            app.manage(ocr_coordinator::desktop_selector::Windows::default());
            let history = std::sync::Arc::new(gsm_history::History::default());
            app.manage(history.clone());
            app.manage(database_startup::Vocabulary::default());
            app.manage(cron::Scheduler::default());
            app.manage(anki_poll::Notes::default());
            app.manage(anki_poll::monitor::Monitor::default());
            app.manage(anki_sync::SyncLane::default());
            app.manage(anki_group::MergeLane::default());
            app.manage(python_install::PythonInstall::default());
            let paths = gsm_settings::paths::Paths::resolve().map_err(std::io::Error::other)?;
            desktop_log::init(paths.active.join("logs"));
            if std::env::var_os("GSM_OVERLAY_DATA_PATH").is_none() {
                match gsm_packages::overlay_directory::consolidate(&paths.active, paths.has_profile) {
                    Ok(true) => desktop_log::info(app.handle(), "overlay", "Copied overlay data into the GSM data folder."),
                    Ok(false) => {}
                    Err(error) => desktop_log::warn(app.handle(), "overlay", format!("Kept the legacy overlay profile: {error}")),
                }
            }
            recycled_lines::register(app.handle(), paths.active.join("gsm.db"));
            desktop_log::info(
                app.handle(),
                "startup",
                format!(
                    "Desktop session started (v{}, PID {}, data: {})",
                    app.package_info().version,
                    std::process::id(),
                    paths.active.display()
                ),
            );
            let language = std::sync::Arc::new(gsm_sudachi::LanguageService::new(
                paths.active.clone(), paths.active.join("dictionaries/sudachi"),
            ));
            tauri::async_runtime::spawn(gsm_sudachi::LanguageService::unload_when_idle(std::sync::Arc::downgrade(&language)));
            app.manage(word_index::WordIndex::start(paths.active.join("gsm.db"), history, language.clone()));
            app.manage(language);
            std::env::set_var("GSM_NATIVE_OVERLAY", "1");
            std::env::set_var("GSM_NATIVE_DATA_DIR", &paths.active);
            std::env::set_var("GSM_NATIVE_SHARED_DATA_DIR", &paths.shared);
            let profile_dir = paths.has_profile.then(|| paths.active.clone());
            let pull_pre = gsm_settings::preferences::Preferences::new(&paths.active)
                .get("pullPreReleases")
                .ok()
                .flatten()
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let pkg_version = app.package_info().version.to_string();
            let active_dir = paths.active.clone();
            app.manage(settings::Settings { paths });
            let desktop_state = desktop_state::DesktopState::with_runtime(
                root.clone(),
                profile_dir,
                assets.clone(),
                setup_relaunch,
            );
            let mining_http = desktop_state.http.clone();
            app.manage(desktop_state);
            ocr_coordinator::sync_overlay_thread_policy(
                app.handle(),
                &ocr_coordinator::read_ocr_config(app.handle()),
            );
            app.manage(mining::MiningService::new(&root, active_dir, mining_http));
            app.manage(app_lifecycle::AppLifecycle::default());
            app.manage(app_identity::IconPresentation::new());
            app.manage(tray::TrayState::default());
            app.manage(desktop_changelog::DesktopChangelog::default());
            app.manage(python_ops::PythonOpsState::default());
            app.manage(update_manager::UpdateManager::new(pkg_version, pull_pre));
            app_identity::init_process_identity(app.handle());
            app.manage(install_session::InstallSessions::new(app.handle().clone()));
            app.manage(hook_updates::HookUpdates::default());
            app.manage(input_server::InputServer::default());
            app.manage(sudachi_setup::SudachiSetup::default());
            app.manage(game_privileges::GamePrivileges::default());
            app.manage(game_launcher::GameLauncher::default());
            app.manage(game_background::GameBackground::default());
            app.manage(texthook_coordinator::TexthookCoordinator::default());
            app.manage(ocr_coordinator::OcrCoordinator::default());
            app.manage(auto_launcher::AutoLauncher::default());
            app.manage(dictionary_host::DictionaryManager::default());
            app.manage(reader_service::ReaderState::default());
            app.manage(overlay_host::OverlayHost::default());
            memory::start(app.handle());
            input_server::start_background(app.handle());
            if app_lifecycle::native_session_requested() { text_intake::hotkeys::start(app.handle()); }
            if let Err(error) = database_startup::prepare(app.handle()) {
                app.state::<backend::BackendState>().invalidate_prepared_database();
                desktop_log::error(app.handle(), "database", format!("Database startup failed. Settings and backup restore remain available. {error}"));
            }
            app_lifecycle::init_startup(app.handle()).map_err(std::io::Error::other)?;
            if std::env::var_os("GSM_SMOKE_TEST").is_none() {
                card_dialog::start(app.handle());
                dictionary_service::start(app.handle());
                // Presentation is allocated by OverlayHost::start on first use.
                app.state::<hook_updates::HookUpdates>()
                    .get(app.handle())
                    .start();
                game_privileges::start(app.handle());
                game_launcher::start(app.handle());
                game_background::start(app.handle());
                auto_launcher::AutoLauncher::start(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::overlay_lifecycle,
            commands::dictionary_service,
            commands::backend_lifecycle,
            commands::desktop_resource_usage,
            commands::desktop_hachidori_memory,
            commands::open_python_dialog,
            commands::python_environment,
            commands::installation_session,
            commands::mining_workspace,
            commands::hook_profiles,
            commands::hook_updates,
            agent::agent_ui_call,
            desktop_call,
            dictionary_call,
            dictionary_selection,
            desktop_clipboard,
            evaluation_result,
            renderer_log,
            window_input,
            overlay_aux_hide
        ])
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if tray::is_tray_menu_id(id) {
                tray::handle_menu_event(app, id);
            } else if app_lifecycle::is_app_menu_id(id) {
                app_lifecycle::handle_app_menu_event(app, id);
            }
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::Focused(true) => {
                    if let Some(view) = app.get_webview_window(window.label()) {
                        memory::restore(&view);
                        memory::sync_visibility(&view);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    memory::forget(app, window.label());
                    if let Some(manager) = app.try_state::<dictionary_host::DictionaryManager>() {
                        manager.forget_window(app, window.label());
                    }
                    if let Some(desktop) = app.try_state::<desktop_state::DesktopState>() {
                        desktop.unregister_window(window.label());
                    }
                }
                _ => {}
            }
        })
        .build(context)
        .expect("Could not start GSM");
    let code = application.run_return(|app, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            app_lifecycle::handle_single_instance(app, Vec::new());
        }
        tauri::RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        tauri::RunEvent::Exit => {
            app.state::<obs::game_pause::GamePause>().release_all(app);
            #[cfg(windows)]
            obs::game_audio::shutdown(app);
            if let Err(e)=tauri::async_runtime::block_on(text_intake::finish_desktop(app)){desktop_log::error(app,"text-intake",e);}
            auto_launcher::AutoLauncher::stop(app);
            app.state::<overlay_host::OverlayHost>().shutdown(app);
            app.state::<ocr_coordinator::OcrCoordinator>().shutdown(app);
            game_background::stop(app);
            game_launcher::stop(app);
            game_privileges::stop(app);
            input_server::stop(app);
            app.state::<hook_updates::HookUpdates>().shutdown();
            app.state::<cron::Scheduler>().close();
            app.state::<agent::Agent>().shutdown();
            app.state::<texthook::TextHook>().shutdown();
            app.state::<overlay::Overlay>().shutdown();
            app.state::<ocr::Ocr>().shutdown();
            if let Some(mining) = app.try_state::<Arc<mining::MiningService>>() {
                mining.shutdown();
            }
            app.state::<runtime::Runtime>().shutdown();
            app.state::<install_session::InstallSessions>().shutdown();
        }
        _ => {}
    });
    if let Some(args) = relaunch.lock().unwrap().take() {
        let mut executable = std::env::current_exe().expect("Desktop executable");
        if LOCAL_BUILD {
            if let Some(root) = app_root_override() {
                let directory = root.join("src-tauri/target/desktop-runs");
                let platform = if cfg!(windows) {
                    "win32"
                } else if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    "linux"
                };
                let arch = if cfg!(target_arch = "x86_64") {
                    "x64"
                } else if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    std::env::consts::ARCH
                };
                if let Ok(record) = std::fs::read(directory.join(format!("{platform}-{arch}.json")))
                {
                    if let Ok(record) = serde_json::from_slice::<Value>(&record) {
                        if let Some(candidate) = record["executable"]
                            .as_str()
                            .and_then(|path| PathBuf::from(path).canonicalize().ok())
                        {
                            if directory
                                .canonicalize()
                                .is_ok_and(|base| candidate.starts_with(base))
                                && candidate.is_file()
                            {
                                executable = candidate;
                            }
                        }
                    }
                }
            }
        }
        let mut command = Command::new(executable);
        command.args(game_privileges::clean_relaunch_args(&args));
        #[cfg(windows)]
        command.arg(format!("--wait-pid={}", std::process::id()));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        if let Err(error) = command.spawn() {
            desktop_log::stderr_only("main", "ERROR", format!("Could not restart GSM: {error}"));
            std::process::exit(1);
        }
    }
    std::process::exit(code);
}
