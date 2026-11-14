//! Direct renderer services. The caller has already checked the desktop window scope.
use gsm_packages::{
    anki_beacon::write_configured_anki_beacon_addon,
    changelog::PendingChangelogRecord,
    data_relocate::{perform_data_move, validate_target_dir},
    log_archive::{create_anonymized_logs_archive, list_log_files},
    log_redaction::LogRedactor,
    settings_backup::{
        create_backup_archive, get_default_backup_file_name, get_overlay_data_dir,
        normalize_settings_backup_categories, resolve_owocr_config_path, restore_backup_archive,
        BackupArchiveOptions, BackupProgressEvent, RestoreArchiveOptions,
    },
};
use gsm_settings::{
    gsm_config::{
        clamp_backup_retention, desktop_settings_snapshot, get_configured_single_port,
        get_configured_target_language, get_legacy_notification_features, gsm_backend_url,
        sync_python_display_locale,
    },
    notifications::{
        get_notification_preferences, is_notification_sound, normalize_notification_volume,
        playback_payload, save_notification_preferences,
    },
    paths::{default_base_dir, home_dir, pointer_file_path, write_data_dir_pointer, Paths},
    preferences::Preferences,
};
use serde_json::{json, Value};
use std::{
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};
use tauri::Manager;

const ANKI_BEACON_ADDON_URL: &str =
    "https://github.com/bpwhelan/AnkiBeacon/releases/latest/download/Anki.Beacon.ankiaddon";
const SETTINGS_BACKUP_PROGRESS_CHANNEL: &str = "settings-backup-progress";

pub async fn send(app: &tauri::AppHandle, label: &str, channel: &str, args: &[Value]) -> bool {
    let scope = app
        .state::<crate::desktop_state::DesktopState>()
        .window_scope(label);
    if scope.as_deref() == Some("vn-guide")
        && channel != "vn-guide-command"
        && channel != "gsm-find-in-page:command"
    {
        return false;
    }
    if channel == "gsm-find-in-page:command" {
        crate::app_lifecycle::handle_find_in_page_command(app, label, args);
        return true;
    }
    if matches!(scope.as_deref(), Some("overlay" | "vn-guide")) {
        return app
            .state::<crate::overlay_host::OverlayHost>()
            .handle_send(app, label, channel, args)
            .await;
    }
    match channel {
        "settings.iconStyleChanged" => {
            if let Some(style) = args.first().and_then(Value::as_str) {
                let _ = crate::app_identity::apply_icon_style(app, Some(style));
            }
            true
        }
        "app-close" => {
            if label == crate::app_lifecycle::HUB_WINDOW_LABEL {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::app_lifecycle::quit_app(&handle, None).await;
                });
            } else if let Some(win) = app.get_webview_window(label) {
                let _ = win.close();
            }
            true
        }
        "tab-changed" | "terminal-data" => true,
        _ => crate::ocr_coordinator::try_send(app, channel, args),
    }
}

pub async fn invoke(
    app: &tauri::AppHandle,
    label: &str,
    channel: &str,
    args: &[Value],
) -> Option<Result<Value, String>> {
    let scope = app
        .state::<crate::desktop_state::DesktopState>()
        .window_scope(label);
    if scope.as_deref() == Some("vn-guide")
        && !matches!(channel, "vn-guide-state" | "vn-guide-command")
    {
        return Some(Err(
            "This VN guide window cannot access that desktop channel".into(),
        ));
    }
    if matches!(scope.as_deref(), Some("overlay" | "vn-guide"))
        && !(scope.as_deref() == Some("overlay")
            && matches!(channel, "settings.getTheme" | "docs.openWindow"))
    {
        return app
            .state::<crate::overlay_host::OverlayHost>()
            .handle_invoke(app, label, channel, args)
            .await;
    }
    match channel {
        "python.getPythonInfo" => Some(crate::python_install::environment(app, "info").await),
        "python.getInstalledPackages" => {
            Some(crate::python_install::environment(app, "packages").await)
        }
        "python.cleanCache" => {
            Some(crate::python_install::environment(app, "cleanCacheStrict").await)
        }
        "python.installCudaPackage" => {
            let bundled = args
                .first()
                .and_then(|v| v.get("bundledLibraries"))
                .and_then(Value::as_bool)
                == Some(true);
            Some(crate::python_ops::handle_cuda_package(app, label, true, bundled).await)
        }
        "python.uninstallCudaPackage" => {
            Some(crate::python_ops::handle_cuda_package(app, label, false, false).await)
        }
        "python.resetDependencies" => Some(Ok(crate::python_ops::run_python_maintenance(
            app,
            "reset_dependencies",
        )
        .await)),
        "python.repairGSM" => Some(Ok(
            crate::python_ops::run_python_maintenance(app, "repair").await
        )),
        "python.installCustomPackage" => {
            let req = args.first().and_then(Value::as_str).unwrap_or_default();
            Some(Ok(crate::python_ops::install_custom_package(
                app, req, false,
            )
            .await))
        }
        "python.reinstallPackage" => {
            let req = args.first().and_then(Value::as_str).unwrap_or_default();
            Some(Ok(crate::python_ops::install_custom_package(
                app, req, true,
            )
            .await))
        }
        "python.openCudaGuide" => Some(
            crate::native::shell_open_external("https://pytorch.org/get-started/locally/")
                .map(|_| Value::Null),
        ),
        "install-session.getActive" => Some(Ok(app
            .state::<crate::install_session::InstallSessions>()
            .model
            .snapshot("renderer"))),
        "install-session.retry" => {
            let lease = serde_json::from_value(args.first().cloned().unwrap_or(Value::Null));
            Some(match lease {
                Ok(lease) => Ok(crate::install_session::retry(app, label, lease).await),
                Err(error) => Err(format!("Missing installation retry identity: {error}")),
            })
        }
        channel
            if channel.starts_with("textprocess.")
                || channel.starts_with("speech-recognition.") =>
        {
            Some(
                crate::mining_workspace::invoke(
                    app,
                    channel,
                    args.first().cloned().unwrap_or(Value::Null),
                )
                .await,
            )
        }
        "capture.listWindows" => Some(
            tauri::async_runtime::spawn_blocking(|| {
                crate::capture_windows::list().map(|windows| json!(windows))
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|result| result),
        ),
        "capture.getWindowPreviews" => {
            let requests =
                match serde_json::from_value(args.first().cloned().unwrap_or_else(|| json!([]))) {
                    Ok(requests) => requests,
                    Err(error) => return Some(Err(error.to_string())),
                };
            Some(
                tauri::async_runtime::spawn_blocking(move || {
                    crate::capture_windows::previews(requests)
                })
                .await
                .map_err(|e| e.to_string())
                .and_then(|result| result),
            )
        }
        "get-platform" => Some(Ok(json!(if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        }))),
        "open-external" => {
            let url = args.first().and_then(Value::as_str).unwrap_or_default();
            Some(Ok(match crate::native::shell_open_external(url) {
                Ok(()) => json!({ "success": true }),
                Err(error) => json!({ "success": false, "error": error }),
            }))
        }
        "open-external-link" => {
            let url = args.first().and_then(Value::as_str).unwrap_or_default();
            Some(crate::native::shell_open_external(url).map(|_| Value::Null))
        }
        "docs.openWindow" => Some(handle_docs_open_window(app, label, args)),
        "show-error-box" => Some(handle_show_error_box(args).await),
        "show-message-box" => Some(handle_show_message_box(args).await),
        "state.get" | "state.set" | "state.remove" | "state.getAll" | "state.clear" => {
            Some(handle_state(app, channel, args))
        }
        "logs.openFolder" => Some(handle_logs_open_folder(app)),
        "logs.export" => Some(Ok(handle_logs_export(app).await)),
        "settings.notifications.get"
        | "settings.notifications.save"
        | "settings.notifications.preview" => Some(handle_notifications(app, channel, args).await),
        "settings.onboarding.get"
        | "settings.onboarding.save"
        | "settings.onboarding.dictionary"
        | "settings.onboarding.sudachi"
        | "settings.onboarding.language" => Some(handle_onboarding(app, channel, args).await),
        "settings.gpu" => Some(crate::python_ops::handle_gpu_settings(app, args).await),
        "settings.getSettings" => Some(handle_get_settings(app).await),
        "settings.getTheme" => Some(handle_get_theme(app).await),
        "settings.getUpdateStatus" => {
            let mgr = app
                .state::<crate::update_manager::UpdateManager>()
                .inner()
                .clone();
            Some(
                mgr.get_update_status(app)
                    .await
                    .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
            )
        }
        "settings.getAppUpdateStatus" => {
            let status = app
                .state::<crate::update_manager::UpdateManager>()
                .get_app_update_status(app);
            Some(Ok(serde_json::to_value(status).unwrap_or(Value::Null)))
        }
        "settings.getAppUpdateChangelog" => {
            let mgr = app
                .state::<crate::update_manager::UpdateManager>()
                .inner()
                .clone();
            let changelog = mgr.get_app_update_changelog(app).await;
            Some(Ok(serde_json::to_value(changelog).unwrap_or(Value::Null)))
        }
        "settings.installAppUpdate" => {
            let ver = args
                .first()
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            Some(match ver {
                None => Err("Invalid target version.".into()),
                Some(version) => {
                    let mgr = app
                        .state::<crate::update_manager::UpdateManager>()
                        .inner()
                        .clone();
                    mgr.install_app_update(app, version)
                        .await
                        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string()))
                }
            })
        }
        "settings.checkForUpdates" => {
            let mgr = app
                .state::<crate::update_manager::UpdateManager>()
                .inner()
                .clone();
            Some(
                mgr.check_for_available_updates(app, false)
                    .await
                    .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
            )
        }
        "settings.updateNow" => {
            let mgr = app
                .state::<crate::update_manager::UpdateManager>()
                .inner()
                .clone();
            Some(
                mgr.update_available_targets(app, false)
                    .await
                    .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
            )
        }
        "settings.reinstallPython" => {
            Some(Ok(crate::python_ops::handle_reinstall_python(app).await))
        }
        "settings.runPipInstall" => {
            let pkg = args.first().and_then(Value::as_str).unwrap_or_default();
            Some(Ok(crate::python_ops::handle_run_pip_install(app, pkg).await))
        }
        "settings.saveSettings" => Some(handle_save_settings(app, args).await),
        "settings.setAutoUpdateGSMApp" => Some(
            patch_bool_pref(
                app,
                "autoUpdateGSMApp",
                args.first().and_then(Value::as_bool),
            )
            .await
            .map(|_| Value::Null),
        ),
        "settings.setAutoUpdateElectron" => Some(
            patch_bool_pref(
                app,
                "autoUpdateElectron",
                args.first().and_then(Value::as_bool),
            )
            .await
            .map(|_| Value::Null),
        ),
        "settings.setStartConsoleMinimized" => Some(
            patch_bool_pref(
                app,
                "startConsoleMinimized",
                args.first().and_then(Value::as_bool),
            )
            .await
            .map(|_| Value::Null),
        ),
        "settings.focusHub" => Some(Ok(focus_hub_and_navigate(app, "settings"))),
        "settings.openTextProcessing" => Some(Ok(focus_hub_and_navigate(app, "textprocessing"))),
        "settings.openGSMSettings" => Some(handle_open_gsm_settings(app, args).await),
        "settings.selectDatabaseBackupDirectory" => Some(handle_select_backup_dir(app).await),
        "settings.createBackup" => Some(Ok(handle_create_backup(app, label, args).await)),
        "settings.restoreBackup" => Some(Ok(handle_restore_backup(app, label, args).await)),
        "settings.showUpdateChangelogPreview" => {
            Some(Ok(handle_show_update_changelog_preview(app, args)))
        }
        "changelog.getPendingDesktopUpdate" => {
            let snap = app
                .state::<crate::desktop_changelog::DesktopChangelog>()
                .get_pending_snapshot(app);
            Some(Ok(serde_json::to_value(snap).unwrap_or(Value::Null)))
        }
        "changelog.markDesktopUpdateSeen" => {
            let to_ver = args.first().and_then(Value::as_str);
            let ok = app
                .state::<crate::desktop_changelog::DesktopChangelog>()
                .mark_seen(app, to_ver);
            Some(Ok(json!({ "success": ok })))
        }
        "changelog.clearManualDisplay" => {
            app.state::<crate::desktop_changelog::DesktopChangelog>()
                .clear_manual_display(app);
            Some(Ok(Value::Null))
        }
        "changelog.applySettingChoice" => {
            let choice = args.first().and_then(Value::as_str).unwrap_or_default();
            let ok = crate::desktop_changelog::apply_setting_choice(app, choice).await;
            Some(Ok(json!({ "success": ok })))
        }
        "data.getCurrentDir" => Some(Ok(json!(
            app.state::<crate::settings::Settings>().paths.active
        ))),
        "data.getDefaultDir" => Some(default_base_dir().map(|p| json!(p))),
        "data.getPointerPath" => Some(pointer_file_path().map(|p| json!(p))),
        "data.relocate" => Some(Ok(handle_data_relocate(app, label).await)),
        "data.restoreDefault" => Some(Ok(handle_data_restore_default(app, label).await)),
        "ankiBeacon.install" => Some(Ok(handle_anki_beacon_install(app).await)),
        "settings.getGameSettings"
        | "settings.saveGameSettings"
        | "settings.getSceneLaunchProfile"
        | "settings.saveSceneLaunchProfile"
        | "settings.listAgentScripts"
        | "settings.resolveAgentScriptForScene"
        | "settings.listGSMProfiles"
        | "settings.relateSceneToProfile"
        | "settings.selectAgentPath"
        | "settings.selectAgentScriptsPath"
        | "settings.selectAgentScriptPath"
        | "settings.selectTextractorPath64"
        | "settings.selectTextractorPath32"
        | "settings.selectLunaTranslatorPath"
        | "settings.openToolReleasesPage"
        | "settings.downloadAndInstallTool" => {
            Some(crate::settings_tools::handle_ipc(app, label, channel, args).await)
        }
        channel if channel.starts_with("game-privileges.") => {
            Some(crate::game_privileges::handle_ipc(app, label, channel, args).await)
        }
        channel if channel.starts_with("game-launcher.") => {
            Some(crate::game_launcher::handle_ipc(app, label, channel, args).await)
        }
        channel if channel.starts_with("game-background.") => {
            Some(crate::game_background::handle_ipc(app, label, channel, args).await)
        }
        "get_gsm_status" => Some(crate::backend::fetch_status(app, Duration::from_secs(5)).await),
        channel
            if channel.starts_with("obs.")
                || channel.starts_with("scene-switcher.")
                || channel == "openOBS" =>
        {
            let controller = app.state::<crate::obs::Obs>().inner().clone();
            Some(controller.invoke(app, channel, args).await)
        }
        "runOverlay" => Some(
            app.state::<crate::overlay_host::OverlayHost>()
                .start(app, None, "manual")
                .await
                .map(Value::Bool),
        ),
        "setOverlayEnabled" => {
            let enabled = args.first().and_then(Value::as_bool).unwrap_or(false);
            Some(
                app.state::<crate::overlay_host::OverlayHost>()
                    .set_enabled(app, enabled)
                    .await,
            )
        }
        "getOverlayStatus" => Some(Ok(app.state::<crate::overlay_host::OverlayHost>().status())),
        "front.autoOverlaySync" => {
            let should_run = args.first().and_then(Value::as_bool).unwrap_or(false);
            Some(
                app.state::<crate::overlay_host::OverlayHost>()
                    .auto_overlay_sync(app, should_run)
                    .await,
            )
        }
        "settings.openOverlaySettings" => Some(
            app.state::<crate::overlay_host::OverlayHost>()
                .open_settings(app, None)
                .await
                .map(|()| json!({ "success": true })),
        ),
        _ => {
            if let Some(res) = crate::reader_service::try_invoke(app, label, channel, args).await {
                return Some(res);
            }
            if let Some(res) = crate::texthook_coordinator::try_invoke(app, channel, args).await {
                return Some(res);
            }
            if let Some(res) = crate::ocr_coordinator::try_invoke(app, channel, args).await {
                return Some(res);
            }
            crate::launchers_ui::try_invoke(app, channel, args).await
        }
    }
}

pub(crate) fn paths_for(app: &tauri::AppHandle) -> Paths {
    app.state::<crate::settings::Settings>().paths.clone()
}

fn downloads_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .ok()
        .or_else(|| home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(std::env::temp_dir)
}

fn current_app_version(app: &tauri::AppHandle) -> String {
    let app_root = &app.state::<crate::desktop_state::DesktopState>().app_root;
    if let Ok(raw) = std::fs::read_to_string(app_root.join("package.json")) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            if let Some(ver) = parsed.get("version").and_then(Value::as_str) {
                let trimmed = ver.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_owned();
                }
            }
        }
    }
    app.package_info().version.to_string()
}

fn is_version_prerelease(version: &str) -> bool {
    let normalized = version.trim().trim_start_matches(['v', 'V']);
    semver::Version::parse(normalized)
        .map(|v| !v.pre.is_empty())
        .unwrap_or_else(|_| normalized.contains('-'))
}

fn handle_docs_open_window(
    app: &tauri::AppHandle,
    parent_label: &str,
    args: &[Value],
) -> Result<Value, String> {
    let payload = args.first();
    let requested = payload
        .and_then(|v| v.as_str().or_else(|| v.get("url").and_then(Value::as_str)))
        .unwrap_or_default();
    match crate::desktop_state::open_docs_window(app, parent_label, requested) {
        Ok(()) => Ok(json!({ "success": true })),
        Err(error) => Ok(json!({ "success": false, "error": error })),
    }
}

async fn handle_show_error_box(args: &[Value]) -> Result<Value, String> {
    let payload = args.first().cloned().unwrap_or(Value::Null);
    let dialog_params = json!({
        "type": "error",
        "title": payload.get("title").and_then(Value::as_str).unwrap_or("Error"),
        "message": payload.get("message").and_then(Value::as_str).unwrap_or_default(),
        "detail": payload.get("detail").and_then(Value::as_str),
        "buttons": ["OK"],
    });
    crate::native::dialog_message(&dialog_params).await?;
    Ok(Value::Null)
}

async fn handle_show_message_box(args: &[Value]) -> Result<Value, String> {
    let options = args.first().cloned().unwrap_or(Value::Null);
    let response = crate::native::dialog_message(&options).await?;
    Ok(json!({ "response": response }))
}

fn handle_state(app: &tauri::AppHandle, channel: &str, args: &[Value]) -> Result<Value, String> {
    let state = &app
        .state::<crate::desktop_state::DesktopState>()
        .runtime_state;
    match channel {
        "state.get" => {
            let key = args.first().and_then(Value::as_str).unwrap_or_default();
            Ok(state.get(key).unwrap_or(Value::Null))
        }
        "state.set" => {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or("State key must be a string")?;
            let value = args.get(1).cloned().unwrap_or(Value::Null);
            state.set(key.to_owned(), value);
            Ok(Value::Null)
        }
        "state.remove" => {
            let key = args.first().and_then(Value::as_str).unwrap_or_default();
            state.remove(key);
            Ok(Value::Null)
        }
        "state.getAll" => Ok(Value::Object(state.get_all())),
        "state.clear" => {
            state.clear();
            Ok(Value::Null)
        }
        _ => Err(format!("Unsupported state channel: {channel}")),
    }
}

fn handle_logs_open_folder(app: &tauri::AppHandle) -> Result<Value, String> {
    let logs_dir = paths_for(app).active.join("logs");
    if let Err(err) = std::fs::create_dir_all(&logs_dir) {
        return Ok(json!({ "success": false, "error": err.to_string() }));
    }
    match crate::native::shell_open_path(&logs_dir) {
        Ok(()) => Ok(json!({ "success": true, "path": logs_dir })),
        Err(err) => Ok(json!({ "success": false, "error": err })),
    }
}

async fn handle_logs_export(app: &tauri::AppHandle) -> Value {
    let logs_dir = paths_for(app).active.join("logs");
    if !logs_dir.exists() {
        let _ = crate::native::dialog_message(&json!({
            "type": "error",
            "title": "No Logs Found",
            "message": "No logs directory found. No logs have been generated yet.",
            "buttons": ["OK"],
        }))
        .await;
        return json!({ "success": true });
    }

    let files = match tokio::task::spawn_blocking({
        let dir = logs_dir.clone();
        move || list_log_files(&dir)
    })
    .await
    {
        Ok(Ok(f)) => f,
        Ok(Err(err)) => {
            let _ = crate::native::dialog_message(&json!({
                "type": "error",
                "title": "Export Failed",
                "message": format!("Failed to export logs: {err}"),
                "buttons": ["OK"],
            }))
            .await;
            return json!({ "success": true });
        }
        Err(err) => return json!({ "success": false, "error": err.to_string() }),
    };

    if files.is_empty() {
        let _ = crate::native::dialog_message(&json!({
            "type": "error",
            "title": "No Log Files",
            "message": "No log files found in the logs directory.",
            "buttons": ["OK"],
        }))
        .await;
        return json!({ "success": true });
    }

    let date_tag = chrono::Utc::now().format("%Y-%m-%d");
    let default_path = downloads_dir(app).join(format!("GSM_Logs_Anonymized_{date_tag}.zip"));
    let Ok(save) = crate::native::dialog_save(&json!({
        "title": "Save Anonymized GSM Logs",
        "defaultPath": default_path,
        "filters": [{ "name": "ZIP Archive", "extensions": ["zip"] }],
    }))
    .await
    else {
        return json!({ "success": false, "error": "Failed to open save dialog." });
    };

    if save
        .get("canceled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return json!({ "success": true });
    }
    let Some(output_path) = save
        .get("filePath")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
    else {
        return json!({ "success": true });
    };

    let export_result = tokio::task::spawn_blocking({
        let out = output_path.clone();
        move || create_anonymized_logs_archive(&logs_dir, &out, &LogRedactor::default())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);

    match export_result {
        Ok(()) => {
            if let Ok(idx) = crate::native::dialog_message(&json!({
                "type": "info",
                "title": "Anonymized Logs Exported",
                "message": format!("Anonymized logs successfully exported to:\n{}", output_path.display()),
                "detail": "Detected usernames, home paths, computer names, email/IP addresses, and common credentials were redacted before creating the ZIP, including compressed log history. Your original logs are unchanged.\n\nAutomatic redaction may miss personal details in free text. Review the exported logs before sharing.",
                "buttons": ["OK", "Open Folder"],
            }))
            .await
            {
                if idx == 1 {
                    let _ = crate::native::shell_reveal(&output_path);
                }
            }
            json!({ "success": true })
        }
        Err(err) => {
            let _ = crate::native::dialog_message(&json!({
                "type": "error",
                "title": "Export Failed",
                "message": format!("Failed to export logs: {err}"),
                "buttons": ["OK"],
            }))
            .await;
            json!({ "success": true })
        }
    }
}

async fn handle_notifications(
    app: &tauri::AppHandle,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    let paths = paths_for(app);
    match channel {
        "settings.notifications.get" => {
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let prefs = Preferences::new(&paths.active);
                let gsm_config_path = paths.active.join("config.json");
                let value = get_notification_preferences(&prefs, || {
                    get_legacy_notification_features(&gsm_config_path)
                })?;
                Ok(json!({ "preferences": value }))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.notifications.save" => {
            let input = args.first().cloned().unwrap_or(Value::Null);
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let prefs = Preferences::new(&paths.active);
                let gsm_config_path = paths.active.join("config.json");
                save_notification_preferences(&prefs, &input, || {
                    get_legacy_notification_features(&gsm_config_path)
                })
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.notifications.preview" => {
            let input = args.first().cloned().unwrap_or(Value::Null);
            let sound = input
                .get("sound")
                .and_then(Value::as_str)
                .filter(|s| is_notification_sound(s))
                .ok_or_else(|| "Unknown notification sound.".to_string())?
                .to_owned();
            let volume = normalize_notification_volume(input.get("volume"));
            let payload = playback_payload(&sound, volume)?;
            let playback: crate::notification_audio::Playback =
                serde_json::from_value(payload).map_err(|e| e.to_string())?;
            let audio_handle = app.clone();
            tokio::task::spawn_blocking(move || {
                audio_handle
                    .state::<crate::notification_audio::NotificationAudio>()
                    .play(playback)
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        _ => Err(format!("Unsupported notification channel: {channel}")),
    }
}

async fn handle_onboarding(
    app: &tauri::AppHandle,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    let paths = paths_for(app);
    match channel {
        "settings.onboarding.dictionary" => {
            let payload = args.first().cloned().unwrap_or(Value::Null);
            let action = payload["action"].as_str().unwrap_or("");
            if !matches!(action, "status" | "install" | "open" | "select") {
                return Err("Invalid dictionary setup action.".into());
            }
            let mut data = payload
                .as_object()
                .cloned()
                .ok_or("Invalid dictionary setup request.")?;
            data.insert(
                "language".into(),
                json!(get_configured_target_language(
                    &paths.active.join("config.json")
                )),
            );
            let result = crate::reader_service::handle_ws2_dictionary_setup(app, &json!({
                "request_id": uuid::Uuid::new_v4().to_string(),
                "deadline": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() + 120_000,
                "data": data,
            })).await;
            if result["success"] != true {
                return Err(result["error"]
                    .as_str()
                    .unwrap_or("Dictionary setup failed.")
                    .to_owned());
            }
            let status = result["status"].clone();
            if status["restarting"] == true {
                let host = app.state::<crate::overlay_host::OverlayHost>();
                let previous = host.status();
                if previous["isRunning"] == true {
                    host.stop(app).await;
                    host.start(
                        app,
                        Some(false),
                        previous["source"].as_str().unwrap_or("manual"),
                    )
                    .await?;
                }
            }
            Ok(status)
        }
        "settings.onboarding.get" => {
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let prefs = Preferences::new(&paths.active);
                let progress = gsm_settings::onboarding::get_or_init_onboarding(&prefs)?;
                let target_language =
                    get_configured_target_language(&paths.active.join("config.json"));
                let locale = prefs
                    .get("locale")?
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "en".into());
                Ok(json!({
                    "progress": progress,
                    "targetLanguage": target_language,
                    "locale": locale,
                }))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.onboarding.save" => {
            let value = args.first().cloned().unwrap_or(Value::Null);
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let prefs = Preferences::new(&paths.active);
                let progress = gsm_settings::onboarding::save_onboarding(&prefs, &value)?;
                Ok(json!({ "success": true, "progress": progress }))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "settings.onboarding.sudachi" => {
            let payload = args.first().cloned().unwrap_or(Value::Null);
            let url = gsm_backend_url(&paths.active.join("config.json"), "/api/onboarding/sudachi");
            let client = app
                .state::<crate::desktop_state::DesktopState>()
                .http
                .clone();
            let resp = client
                .post(&url)
                .timeout(Duration::from_secs(10))
                .json(&payload)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("HTTP {status}: {body}"));
            }
            Ok(body)
        }
        "settings.onboarding.language" => {
            let lang = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| "Invalid learning language.".to_string())?
                .to_owned();
            let url = gsm_backend_url(
                &paths.active.join("config.json"),
                "/api/onboarding/language",
            );
            let client = app
                .state::<crate::desktop_state::DesktopState>()
                .http
                .clone();
            let resp = client
                .post(&url)
                .timeout(Duration::from_secs(10))
                .json(&json!({ "language": lang }))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("HTTP {status}: {body}"));
            }
            Ok(body)
        }
        _ => Err(format!("Unsupported onboarding channel: {channel}")),
    }
}

async fn handle_get_settings(app: &tauri::AppHandle) -> Result<Value, String> {
    let paths = paths_for(app);
    tokio::task::spawn_blocking(move || {
        desktop_settings_snapshot(
            &Preferences::new(&paths.active),
            &paths.active.join("config.json"),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn handle_get_theme(app: &tauri::AppHandle) -> Result<Value, String> {
    let paths = paths_for(app);
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let theme = Preferences::new(&paths.active)
            .get("theme")?
            .and_then(|v| v.as_str().map(str::to_owned))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "gsm-dark".into());
        Ok(json!(theme))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn patch_bool_pref(
    app: &tauri::AppHandle,
    key: &'static str,
    value: Option<bool>,
) -> Result<(), String> {
    let Some(val) = value else {
        return Ok(());
    };
    let paths = paths_for(app);
    tokio::task::spawn_blocking(move || {
        Preferences::new(&paths.active)
            .patch(&json!({ key: val }))
            .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn handle_save_settings(app: &tauri::AppHandle, args: &[Value]) -> Result<Value, String> {
    let mut payload = args
        .first()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let paths = paths_for(app);

    if let Some(requested_pre) = payload.get("pullPreReleases").and_then(Value::as_bool) {
        let paths_read = paths.clone();
        let current_pre = tokio::task::spawn_blocking(move || -> Result<bool, String> {
            Ok(Preferences::new(&paths_read.active)
                .get("pullPreReleases")?
                .and_then(|v| v.as_bool())
                .unwrap_or(false))
        })
        .await
        .map_err(|e| e.to_string())??;

        if requested_pre != current_pre {
            let app_is_pre = is_version_prerelease(&current_app_version(app));
            let requires_cross_channel =
                (requested_pre && !app_is_pre) || (!requested_pre && app_is_pre);
            if requires_cross_channel {
                let response = crate::native::dialog_message(&json!({
                    "type": "question",
                    "buttons": ["Yes", "No"],
                    "defaultId": 0,
                    "cancelId": 1,
                    "title": if requested_pre { "Switch to Beta Updates" } else { "Switch to Stable Updates" },
                    "message": if requested_pre {
                        "Enable beta updates and queue the update now?"
                    } else {
                        "Disable beta updates and queue the stable update now?"
                    },
                    "detail": if requested_pre {
                        "A backend update will be queued for the next launch. Restart GSM to apply it."
                    } else {
                        "A stable backend update will be queued for the next launch. Restart GSM to apply it."
                    },
                }))
                .await?;
                if response == 0 {
                    let flag_path = paths.active.join("update_python.flag");
                    match std::fs::write(&flag_path, "") {
                        Ok(()) => {
                            let _ = crate::native::dialog_message(&json!({
                                "type": "info",
                                "buttons": ["OK"],
                                "title": "Update Queued",
                                "message": "GameSentenceMiner queued an update for the next launch.",
                                "detail": "Restart GSM to apply the queued update.",
                            }))
                            .await;
                        }
                        Err(_) => {
                            let _ = crate::native::dialog_message(&json!({
                                "type": "error",
                                "buttons": ["OK"],
                                "title": "Queue Failed",
                                "message": "Failed to queue update marker.",
                                "detail": "Restart GSM and run an update manually from the tray menu.",
                            }))
                            .await;
                        }
                    }
                } else {
                    payload.insert("pullPreReleases".into(), json!(current_pre));
                }
            }
        }
    }

    let paths_write = paths.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Result<SaveOutcome, String> {
        let prefs = Preferences::new(&paths_write.active);
        let current_doc = prefs.snapshot()?;
        let mut patch = serde_json::Map::new();

        for bool_key in [
            "autoUpdateGSMApp",
            "pullPreReleases",
            "startConsoleMinimized",
            "runOverlayOnStartup",
            "runOverlayWithActiveGame",
            "quitOnWindowClose",
            "textCaptureWizardEnabled",
            "databaseBackupEnabled",
            "seasonalEffectsDisabled",
            "hasCompletedSetup",
        ] {
            if let Some(val) = payload.get(bool_key).and_then(Value::as_bool) {
                patch.insert(bool_key.into(), json!(val));
            }
        }
        if let Some(v) = payload.get("customPythonPackage").and_then(Value::as_str) {
            patch.insert("customPythonPackage".into(), json!(v));
        }
        if let Some(v) = payload.get("statsEndpoint").and_then(Value::as_str) {
            patch.insert(
                "statsEndpoint".into(),
                json!(if v.is_empty() { "overview" } else { v }),
            );
        }
        if let Some(v) = payload
            .get("databaseBackupDirectory")
            .and_then(Value::as_str)
        {
            patch.insert("databaseBackupDirectory".into(), json!(v.trim()));
        }
        if let Some(v) = payload
            .get("databaseBackupRetentionCount")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
        {
            patch.insert(
                "databaseBackupRetentionCount".into(),
                json!(clamp_backup_retention(v)),
            );
        }
        let icon_style_changed = payload.get("iconStyle").and_then(Value::as_str).map(|v| {
            let next = if v.is_empty() { "gsm" } else { v };
            patch.insert("iconStyle".into(), json!(next));
            next.to_owned()
        });
        let prev_theme = current_doc
            .get("theme")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("gsm-dark")
            .to_owned();
        let next_theme = payload
            .get("theme")
            .and_then(Value::as_str)
            .map(|v| if v.is_empty() { "gsm-dark" } else { v }.to_owned())
            .filter(|t| t != &prev_theme);
        if let Some(ref t) = next_theme {
            patch.insert("theme".into(), json!(t));
        }
        let next_visible_tabs = payload
            .get("visibleTabs")
            .and_then(Value::as_array)
            .cloned();
        if let Some(ref tabs) = next_visible_tabs {
            patch.insert("visibleTabs".into(), Value::Array(tabs.clone()));
        }
        let next_locale = payload
            .get("locale")
            .and_then(Value::as_str)
            .map(|l| if l.is_empty() { "en" } else { l }.to_owned());
        if let Some(ref loc) = next_locale {
            patch.insert("locale".into(), json!(loc));
        }
        if let Some(v) = payload.get("consoleMode").and_then(Value::as_str) {
            if v == "simple" || v == "advanced" {
                patch.insert("consoleMode".into(), json!(v));
            }
        }
        if let Some(v) = payload.get("uiMode").and_then(Value::as_str) {
            if v == "basic" || v == "advanced" {
                patch.insert("uiMode".into(), json!(v));
            }
        }
        if let Some(v) = payload
            .get("setupWizardVersion")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
        {
            patch.insert("setupWizardVersion".into(), json!(v));
        }

        let seasonal_updated = patch.contains_key("seasonalEffectsDisabled");
        if !patch.is_empty() {
            prefs.patch(&Value::Object(patch))?;
        }

        let gsm_config_path = paths_write.active.join("config.json");
        let did_sync_locale = match next_locale.as_deref() {
            Some(loc) => sync_python_display_locale(loc, &gsm_config_path)?,
            None => false,
        };
        let snapshot = desktop_settings_snapshot(&prefs, &gsm_config_path)?;
        Ok(SaveOutcome {
            snapshot,
            next_theme,
            next_visible_tabs,
            seasonal_updated,
            icon_style_changed,
            did_sync_locale,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Some(tabs) = outcome.next_visible_tabs {
        crate::desktop_state::emit_to_desktop_windows(
            app,
            "settings.visibleTabsChanged",
            &[Value::Array(tabs)],
        );
    }
    if let Some(theme) = outcome.next_theme {
        for label in [
            crate::overlay_host::OVERLAY_SETTINGS_LABEL,
            crate::overlay_host::OVERLAY_MAIN_LABEL,
        ] {
            crate::desktop_state::emit_to_window(
                app,
                label,
                "settings.themeChanged",
                &[json!(theme)],
            );
        }
        crate::desktop_state::emit_to_desktop_windows(
            app,
            "settings.themeChanged",
            &[Value::String(theme)],
        );
    }
    if outcome.icon_style_changed.is_some() || outcome.seasonal_updated {
        let _ = crate::app_identity::apply_icon_style(app, None);
    }
    if outcome.did_sync_locale {
        let _ = crate::runtime::backend_command(app, "reload_settings", json!({})).await;
    }

    Ok(json!({ "success": true, "settings": outcome.snapshot }))
}

struct SaveOutcome {
    snapshot: Value,
    next_theme: Option<String>,
    next_visible_tabs: Option<Vec<Value>>,
    seasonal_updated: bool,
    icon_style_changed: Option<String>,
    did_sync_locale: bool,
}

fn focus_hub_and_navigate(app: &tauri::AppHandle, tab: &str) -> Value {
    let Some(hub) = crate::desktop_state::find_hub_window(app) else {
        return json!({ "success": false });
    };
    let _ = crate::desktop_state::focus_window(&hub);
    crate::desktop_state::emit_to_window(app, hub.label(), "app.navigateToTab", &[json!(tab)]);
    json!({ "success": true })
}

async fn handle_open_gsm_settings(app: &tauri::AppHandle, args: &[Value]) -> Result<Value, String> {
    let target = args.first().and_then(Value::as_object);
    let root_tab_key = target
        .and_then(|o| o.get("rootTabKey"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let subtab_key = target
        .and_then(|o| o.get("subtabKey"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let _ = crate::runtime::backend_command(
        app,
        "open_settings",
        json!({
            "root_tab_key": root_tab_key,
            "subtab_key": subtab_key,
        }),
    )
    .await;
    Ok(Value::Null)
}

async fn handle_select_backup_dir(app: &tauri::AppHandle) -> Result<Value, String> {
    let paths = paths_for(app);
    let active = paths.active.clone();
    let configured = tokio::task::spawn_blocking(move || -> String {
        Preferences::new(&active)
            .get("databaseBackupDirectory")
            .ok()
            .flatten()
            .and_then(|v| v.as_str().map(|s| s.trim().to_owned()))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();

    let default_path = if configured.is_empty() {
        paths.active.join("backup").join("database")
    } else {
        PathBuf::from(configured)
    };

    let result = crate::native::dialog_open(&json!({
        "title": "Choose Database Backup Folder",
        "defaultPath": default_path,
        "properties": ["openDirectory", "createDirectory"],
    }))
    .await?;

    let canceled = result
        .get("canceled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let first = result
        .get("filePaths")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(Value::as_str);

    match (canceled, first) {
        (false, Some(directory)) => Ok(json!({ "canceled": false, "directory": directory })),
        _ => Ok(json!({ "canceled": true })),
    }
}

fn requested_backup_categories(payload: Option<&Value>) -> Vec<String> {
    let Some(obj) = payload.and_then(Value::as_object) else {
        return normalize_settings_backup_categories(None, true);
    };
    let Some(raw_categories) = obj.get("categories") else {
        return normalize_settings_backup_categories(None, true);
    };
    let items: Vec<String> = raw_categories
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    normalize_settings_backup_categories(Some(&items), false)
}

fn emit_backup_progress(app: &tauri::AppHandle, label: &str, progress: &BackupProgressEvent) {
    if let Ok(val) = serde_json::to_value(progress) {
        crate::desktop_state::emit_to_window(app, label, SETTINGS_BACKUP_PROGRESS_CHANNEL, &[val]);
    }
}

fn path_within_backup_root(candidate: &Path, backup_root: &Path) -> bool {
    let lex_norm = |p: &Path| -> PathBuf {
        let mut out = PathBuf::new();
        for c in p.components() {
            match c {
                Component::CurDir => {}
                Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }
        out
    };
    let norm_cand = std::fs::canonicalize(candidate).unwrap_or_else(|_| lex_norm(candidate));
    let norm_root = std::fs::canonicalize(backup_root).unwrap_or_else(|_| lex_norm(backup_root));
    norm_cand.starts_with(&norm_root)
}

async fn handle_create_backup(app: &tauri::AppHandle, label: &str, args: &[Value]) -> Value {
    let mut database_snapshot_path: Option<PathBuf> = None;
    let outcome = create_backup_inner(app, label, args.first(), &mut database_snapshot_path).await;
    if let Some(ref snapshot_path) = database_snapshot_path {
        let _ = std::fs::remove_file(snapshot_path);
    }
    match outcome {
        Ok(val) => val,
        Err(error) => {
            emit_backup_progress(
                app,
                label,
                &BackupProgressEvent {
                    operation: "create".into(),
                    phase: "error".into(),
                    file_name: None,
                    completed: None,
                    total: None,
                    progress: None,
                },
            );
            json!({ "success": false, "error": error })
        }
    }
}

async fn create_backup_inner(
    app: &tauri::AppHandle,
    label: &str,
    payload: Option<&Value>,
    database_snapshot_path: &mut Option<PathBuf>,
) -> Result<Value, String> {
    let categories = requested_backup_categories(payload);
    if categories.is_empty() {
        return Err("Select at least one item to include in the backup.".into());
    }
    let default_name = get_default_backup_file_name(SystemTime::now());
    let save = crate::native::dialog_save(&json!({
        "title": "Save GSM Settings Backup",
        "defaultPath": downloads_dir(app).join(default_name),
        "filters": [{ "name": "ZIP Archive", "extensions": ["zip"] }],
    }))
    .await?;

    if save
        .get("canceled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Ok(json!({ "success": false, "canceled": true }));
    }
    let Some(raw_path) = save
        .get("filePath")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(json!({ "success": false, "canceled": true }));
    };

    let output_path = if raw_path.to_ascii_lowercase().ends_with(".zip") {
        PathBuf::from(raw_path)
    } else {
        PathBuf::from(format!("{raw_path}.zip"))
    };

    let paths = paths_for(app);
    if categories.iter().any(|c| c == "database") {
        let port = get_configured_single_port(&paths.active.join("config.json"));
        let client = app
            .state::<crate::desktop_state::DesktopState>()
            .http
            .clone();
        let resp = client
            .post(format!("http://127.0.0.1:{port}/api/database_backup"))
            .timeout(Duration::from_secs(120))
            .json(&json!({}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Database backup failed (HTTP {status})"));
        }
        let candidate = body
            .get("backup_path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "The GSM backend did not return a verified database snapshot.".to_string()
            })?;
        let candidate_path = PathBuf::from(candidate);
        let backup_root = paths.active.join("backup");
        if !path_within_backup_root(&candidate_path, &backup_root) {
            return Err(
                "The GSM backend returned a database snapshot outside the backup folder.".into(),
            );
        }
        *database_snapshot_path = Some(candidate_path);
    }

    let options = BackupArchiveOptions {
        output_path,
        base_dir: paths.active.clone(),
        overlay_dir: get_overlay_data_dir(&paths.active, paths.has_profile),
        home_config_path: resolve_owocr_config_path(&paths.active, paths.has_profile)?,
        database_snapshot_path: database_snapshot_path.clone(),
        categories: Some(categories),
    };

    let app_handle = app.clone();
    let label_owned = label.to_owned();
    let backup = tokio::task::spawn_blocking(move || {
        create_backup_archive(&options, |progress| {
            emit_backup_progress(&app_handle, &label_owned, &progress);
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Ok(idx) = crate::native::dialog_message(&json!({
        "type": "info",
        "title": "Backup Created",
        "message": "GSM settings backup created successfully.",
        "detail": format!("{}\n\nFiles: {}", backup.file_path, backup.file_count),
        "buttons": ["OK", "Open Folder"],
        "defaultId": 0,
    }))
    .await
    {
        if idx == 1 {
            let _ = crate::native::shell_reveal(Path::new(&backup.file_path));
        }
    }

    let mut result = serde_json::to_value(&backup).unwrap_or_else(|_| json!({}));
    if let Some(obj) = result.as_object_mut() {
        obj.insert("success".into(), json!(true));
    }
    Ok(result)
}

async fn handle_restore_backup(app: &tauri::AppHandle, label: &str, args: &[Value]) -> Value {
    let mut stopped_python = false;
    match restore_backup_inner(app, label, args.first(), &mut stopped_python).await {
        Ok(val) => val,
        Err(error) => {
            if stopped_python {
                emit_backup_progress(
                    app,
                    label,
                    &BackupProgressEvent {
                        operation: "restore".into(),
                        phase: "restarting-python".into(),
                        file_name: None,
                        completed: None,
                        total: None,
                        progress: None,
                    },
                );
                let _ = crate::python_ops::restart_gsm(app).await;
            }
            emit_backup_progress(
                app,
                label,
                &BackupProgressEvent {
                    operation: "restore".into(),
                    phase: "error".into(),
                    file_name: None,
                    completed: None,
                    total: None,
                    progress: None,
                },
            );
            json!({ "success": false, "error": error })
        }
    }
}

async fn restore_backup_inner(
    app: &tauri::AppHandle,
    label: &str,
    payload: Option<&Value>,
    stopped_python: &mut bool,
) -> Result<Value, String> {
    let categories = requested_backup_categories(payload);
    if categories.is_empty() {
        return Err("Select at least one item to restore.".into());
    }

    let open = crate::native::dialog_open(&json!({
        "title": "Restore GSM Settings Backup",
        "properties": ["openFile"],
        "filters": [{ "name": "ZIP Archive", "extensions": ["zip"] }],
    }))
    .await?;

    if open
        .get("canceled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Ok(json!({ "success": false, "canceled": true }));
    }
    let Some(archive_path) = open
        .get("filePaths")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
    else {
        return Ok(json!({ "success": false, "canceled": true }));
    };

    let confirm = crate::native::dialog_message(&json!({
        "type": "warning",
        "title": "Restore GSM Settings Backup",
        "message": "Restore this GSM settings backup?",
        "detail": format!(
            "This overwrites the {} selected backup categories when they are present in the archive. GSM Python processes, the overlay, and Electron-managed OBS will be stopped automatically.",
            categories.len()
        ),
        "buttons": ["Restore", "Cancel"],
        "defaultId": 1,
        "cancelId": 1,
    }))
    .await?;
    if confirm != 0 {
        return Ok(json!({ "success": false, "canceled": true }));
    }

    emit_backup_progress(
        app,
        label,
        &BackupProgressEvent {
            operation: "restore".into(),
            phase: "stopping-python".into(),
            file_name: None,
            completed: None,
            total: None,
            progress: None,
        },
    );
    *stopped_python = true;
    crate::python_ops::close_all_python_processes(app, true).await?;

    emit_backup_progress(
        app,
        label,
        &BackupProgressEvent {
            operation: "restore".into(),
            phase: "stopping-obs".into(),
            file_name: None,
            completed: None,
            total: None,
            progress: None,
        },
    );
    let obs_close = app
        .state::<crate::obs::Obs>()
        .inner()
        .clone()
        .invoke(
            app,
            "obs.close",
            &[json!({ "ignoreCloseConfig": true, "reason": "settings restore" })],
        )
        .await?;
    if obs_close.get("status").and_then(Value::as_str) == Some("failed") {
        let msg = obs_close
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Unknown error");
        return Err(format!("Failed to stop OBS before restore: {msg}"));
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    let paths = paths_for(app);
    let options = RestoreArchiveOptions {
        archive_path,
        base_dir: paths.active.clone(),
        overlay_dir: get_overlay_data_dir(&paths.active, paths.has_profile),
        home_config_path: resolve_owocr_config_path(&paths.active, paths.has_profile)?,
        categories: Some(categories),
    };

    let app_handle = app.clone();
    let label_owned = label.to_owned();
    let restored = tokio::task::spawn_blocking(move || {
        restore_backup_archive(&options, |progress| {
            emit_backup_progress(&app_handle, &label_owned, &progress);
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    emit_backup_progress(
        app,
        label,
        &BackupProgressEvent {
            operation: "restore".into(),
            phase: "restarting-python".into(),
            file_name: None,
            completed: None,
            total: None,
            progress: None,
        },
    );
    *stopped_python = false;
    crate::python_ops::restart_gsm(app).await?;

    emit_backup_progress(
        app,
        label,
        &BackupProgressEvent {
            operation: "restore".into(),
            phase: "done".into(),
            file_name: None,
            completed: Some(restored.file_count),
            total: Some(restored.file_count),
            progress: Some(1.0),
        },
    );

    if let Ok(0) = crate::native::dialog_message(&json!({
        "type": "info",
        "title": "Backup Restored",
        "message": "GSM settings backup restored successfully.",
        "detail": "The GSM Python backend has been restarted. Restart the desktop app now so restored desktop settings are loaded.",
        "buttons": ["Restart Now", "Later"],
        "defaultId": 0,
        "cancelId": 1,
    }))
    .await
    {
        crate::request_relaunch(app, Vec::new());
    }

    let mut result = serde_json::to_value(&restored).unwrap_or_else(|_| json!({}));
    if let Some(obj) = result.as_object_mut() {
        obj.insert("success".into(), json!(true));
        obj.insert("restartRequired".into(), json!(true));
    }
    Ok(result)
}

fn handle_show_update_changelog_preview(app: &tauri::AppHandle, args: &[Value]) -> Value {
    let Some(obj) = args.first().and_then(Value::as_object) else {
        return Value::Null;
    };
    let from = obj
        .get("fromVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let to = obj
        .get("toVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if from.is_empty() || to.is_empty() {
        return Value::Null;
    }
    let include_pre = obj.get("includePrereleases").and_then(Value::as_bool);
    let snap = app
        .state::<crate::desktop_changelog::DesktopChangelog>()
        .start_update_preview(
            app,
            PendingChangelogRecord {
                from_version: from.to_owned(),
                to_version: to.to_owned(),
            },
            include_pre,
        );
    serde_json::to_value(snap).unwrap_or(Value::Null)
}

async fn handle_data_relocate(app: &tauri::AppHandle, _label: &str) -> Value {
    let paths = paths_for(app);
    if paths.has_profile {
        return json!({
            "success": false,
            "error": "This launch uses -profile. Close GSM and launch with a different profile folder to change it.",
        });
    }

    let Ok(picked) = crate::native::dialog_open(&json!({
        "title": "Choose a new GSM data folder",
        "properties": ["openDirectory", "createDirectory"],
    }))
    .await
    else {
        return json!({ "success": false, "canceled": true });
    };

    if picked
        .get("canceled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return json!({ "success": false, "canceled": true });
    }
    let Some(new_dir) = picked
        .get("filePaths")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
    else {
        return json!({ "success": false, "canceled": true });
    };

    let Ok(pointer_path) = pointer_file_path() else {
        return json!({ "success": false, "error": "Could not determine GSM pointer path." });
    };
    let validation = validate_target_dir(&paths.active, &new_dir, &pointer_path, paths.has_profile);
    if !validation.ok {
        return json!({ "success": false, "error": validation.error });
    }

    let Ok(confirm) = crate::native::dialog_message(&json!({
        "type": "warning",
        "buttons": ["Copy and Restart", "Cancel"],
        "defaultId": 0,
        "cancelId": 1,
        "title": "Change GSM Data Folder",
        "message": format!("Copy GSM configs and database to:\n{}", new_dir.display()),
        "detail": "GSM will copy its desktop and overlay settings, then stop and restart. Chromium session/storage and Yomitan data will not be copied, so export/import Yomitan dictionaries yourself. Source files will not be deleted; remove them manually after verifying the new folder.",
    }))
    .await
    else {
        return json!({ "success": false, "canceled": true });
    };
    if confirm != 0 {
        return json!({ "success": false, "canceled": true });
    }

    let emit_progress = |phase: &str, message: &str| {
        if let Some(hub) = crate::desktop_state::find_hub_window(app) {
            crate::desktop_state::emit_to_window(
                app,
                hub.label(),
                "data.relocate.progress",
                &[json!({ "phase": phase, "message": message })],
            );
        }
    };

    emit_progress("validating", "Stopping GSM…");
    if let Err(err) = crate::app_lifecycle::stop_for_relocation(app).await {
        return json!({ "success": false, "error": err });
    }

    let app_handle = app.clone();
    let old_dir = paths.active.clone();
    let dst_dir = new_dir.clone();
    let move_res = tokio::task::spawn_blocking(move || {
        perform_data_move(&old_dir, &dst_dir, &pointer_path, false, |progress| {
            if let Some(hub) = crate::desktop_state::find_hub_window(&app_handle) {
                if let Ok(val) = serde_json::to_value(&progress) {
                    crate::desktop_state::emit_to_window(
                        &app_handle,
                        hub.label(),
                        "data.relocate.progress",
                        &[val],
                    );
                }
            }
        })
    })
    .await;

    match move_res {
        Ok(Ok(())) => {
            crate::app_identity::write_data_dir_registry(&new_dir, false);
            crate::request_relaunch(app, Vec::new());
            json!({ "success": true })
        }
        Ok(Err(err)) => json!({ "success": false, "error": err }),
        Err(err) => json!({ "success": false, "error": err.to_string() }),
    }
}

async fn handle_data_restore_default(app: &tauri::AppHandle, _label: &str) -> Value {
    let paths = paths_for(app);
    if paths.has_profile {
        return json!({
            "success": false,
            "error": "This launch uses -profile. Close GSM and launch without -profile to use your normal data folder.",
        });
    }
    let Ok(default_dir) = default_base_dir() else {
        return json!({ "success": false, "error": "Could not resolve default GSM data folder." });
    };
    if paths.active == default_dir {
        return json!({ "success": true });
    }

    let Ok(confirm) = crate::native::dialog_message(&json!({
        "type": "warning",
        "buttons": ["Use Original Folder and Restart", "Cancel"],
        "defaultId": 0,
        "cancelId": 1,
        "title": "Use Original GSM Data Folder",
        "message": format!("Return to the original GSM data folder:\n{}", default_dir.display()),
        "detail": format!(
            "GSM will use the data already stored in this folder. Changes from the current custom folder will not be copied. The custom folder will remain untouched:\n{}",
            paths.active.display()
        ),
    }))
    .await
    else {
        return json!({ "success": false, "canceled": true });
    };
    if confirm != 0 {
        return json!({ "success": false, "canceled": true });
    }

    let emit_progress = |phase: &str, message: &str| {
        if let Some(hub) = crate::desktop_state::find_hub_window(app) {
            crate::desktop_state::emit_to_window(
                app,
                hub.label(),
                "data.relocate.progress",
                &[json!({ "phase": phase, "message": message })],
            );
        }
    };

    emit_progress("validating", "Stopping GSM…");
    if let Err(err) = crate::app_lifecycle::stop_for_relocation(app).await {
        return json!({ "success": false, "error": err });
    }

    emit_progress("finalizing", "Restoring the original GSM data folder…");
    let Ok(pointer_path) = pointer_file_path() else {
        return json!({ "success": false, "error": "Could not determine GSM pointer path." });
    };
    if let Err(err) = write_data_dir_pointer(&pointer_path, &default_dir, false) {
        return json!({ "success": false, "error": err });
    }
    crate::app_identity::write_data_dir_registry(&default_dir, false);
    emit_progress("done", "Original GSM data folder restored. Restarting…");
    crate::request_relaunch(app, Vec::new());
    json!({ "success": true })
}

async fn handle_anki_beacon_install(app: &tauri::AppHandle) -> Value {
    let install_dir = std::env::temp_dir().join("GameSentenceMiner");
    let file_path = install_dir.join("Anki.Beacon.ankiaddon");
    let gsm_port = get_configured_single_port(&paths_for(app).active.join("config.json"));
    let client = app
        .state::<crate::desktop_state::DesktopState>()
        .http
        .clone();

    let res: Result<PathBuf, String> = async {
        std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
        let resp = client
            .get(ANKI_BEACON_ADDON_URL)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?;
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let out_path = file_path.clone();
        tokio::task::spawn_blocking(move || {
            write_configured_anki_beacon_addon(&bytes, &out_path, gsm_port)
        })
        .await
        .map_err(|e| e.to_string())??;
        crate::native::shell_open_path(&file_path)?;
        Ok(file_path)
    }
    .await;

    match res {
        Ok(path) => json!({ "success": true, "filePath": path }),
        Err(error) => json!({ "success": false, "error": error }),
    }
}
