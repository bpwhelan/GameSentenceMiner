//! Finish relocation and schema work before any service can retain a handle to gsm.db.
use chrono::Local;
use gsm_settings::{
    gsm_config::{active_profile, clamp_backup_retention},
    paths::{pointer_file_path, Paths},
    preferences::Preferences,
};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

#[derive(Default)]
pub struct Vocabulary {
    revision: AtomicU64,
    refresh: Mutex<()>,
}

pub fn close_history(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<crate::anki_sync::SyncLane>().database_closing();
    let service = app.state::<Vocabulary>();
    service.revision.fetch_add(1, Ordering::AcqRel);
    // A restore can replace the file as soon as close returns. Wait for a
    // dictionary reader already in use and invalidate every queued refresh.
    let _refresh = service.refresh.lock().unwrap_or_else(|e| e.into_inner());
    app.state::<Arc<gsm_history::History>>()
        .close()
        .map_err(|e| e.to_string())
}

pub fn schedule_vocabulary(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    crate::cron::refresh(app);
    let service = app.state::<Vocabulary>();
    let revision = service.revision.fetch_add(1, Ordering::AcqRel) + 1;
    if !enabled {
        return Ok(());
    }
    let history = app.state::<Arc<gsm_history::History>>().inner().clone();
    let generation = history.generation().map_err(|e| e.to_string())?;
    let path = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("gsm.db");
    let directory = app
        .state::<crate::desktop_state::DesktopState>()
        .app_root
        .join(gsm_db::frequency::DIRECTORY);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<Vocabulary>();
        let _refresh = service.refresh.lock().unwrap_or_else(|e| e.into_inner());
        if service.revision.load(Ordering::Acquire) != revision {
            return;
        }
        if let Err(error) = history.refresh_vocabulary(&path, &directory, generation) {
            crate::desktop_log::warn(
                &app,
                "database",
                format!("Vocabulary refresh failed: {error}"),
            );
        }
    });
    Ok(())
}

struct DailyBackup {
    directory: PathBuf,
    keep: usize,
}

impl DailyBackup {
    fn configured(root: &Path, app_root: &Path) -> Result<Option<Self>, String> {
        if std::env::var("GSM_DISABLE_DB_BACKUP").as_deref() == Ok("1") {
            return Ok(None);
        }
        let prefs = Preferences::new(root).snapshot()?;
        if prefs["databaseBackupEnabled"] != true {
            return Ok(None);
        }
        let keep = match &prefs["databaseBackupRetentionCount"] {
            v if v.is_number() => v.as_f64().map(clamp_backup_retention),
            v if v.is_boolean() => Some(1),
            v => v
                .as_str()
                .and_then(|s| s.trim().parse::<i64>().ok())
                .map(|i| i.clamp(1, 1000)),
        }
        .unwrap_or(2) as usize;
        let directory = match prefs["databaseBackupDirectory"]
            .as_str()
            .unwrap_or("")
            .trim()
        {
            "" => root.join("backup/database"),
            raw => backup_directory(raw, app_root)?,
        };
        Ok(Some(Self { directory, keep }))
    }

    fn run(&self, app: &tauri::AppHandle, database: &Path) {
        match gsm_db::profile::daily_backup(
            database,
            &self.directory,
            Local::now().date_naive(),
            self.keep,
        ) {
            Ok(Some(path)) => crate::desktop_log::info(
                app,
                "database",
                format!("Created backup {}", path.display()),
            ),
            Ok(None) => {}
            Err(e) => crate::desktop_log::warn(
                app,
                "database",
                format!("Daily database backup failed: {e}"),
            ),
        }
    }
}

fn backup_directory(raw: &str, root: &Path) -> Result<PathBuf, String> {
    // Some old JSON preferences contain interpreted Windows escape characters.
    let mut value = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\x07' => value.push_str("/a"),
            '\x08' => value.push_str("/b"),
            '\x0c' => value.push_str("/f"),
            '\n' => value.push_str("/n"),
            '\r' => value.push_str("/r"),
            '\t' => value.push_str("/t"),
            '\x0b' => value.push_str("/v"),
            _ => value.push(ch),
        }
    }
    if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        return gsm_settings::paths::normalize_data_dir(&value);
    }
    Ok(root.join(value))
}

pub fn prepare(app: &tauri::AppHandle) -> Result<(), String> {
    let paths = &app.state::<crate::settings::Settings>().paths;
    let app_root = &app.state::<crate::desktop_state::DesktopState>().app_root;
    // Desktop setup runs before the supervised backend. Later calls come from
    // the serialized backend launch path, including retries after a restore.
    let starting = !app.state::<crate::recycled_lines::Recycled>().started();
    if starting && !paths.has_profile && std::env::var("GSM_DB_READ_ONLY").as_deref() != Ok("1") {
        gsm_db::profile::recover_legacy_database(&pointer_file_path()?, &paths.active, false)
            .map_err(|e| e.to_string())?;
    }
    if std::env::var("GSM_DB_READ_ONLY").as_deref() != Ok("1") {
        gsm_settings::profile_config::prepare(paths, app_root, &app.package_info().version.to_string())?;
    }
    prepare_current(app, paths, app_root)?;
    if std::env::var("GSM_DB_READ_ONLY").as_deref() != Ok("1") {
        app.state::<crate::cron::Scheduler>().ready(app)?;
    }
    if starting {
        crate::recycled_lines::start(app);
    }
    let mining = app.state::<std::sync::Arc<crate::mining::MiningService>>();
    if !mining.is_enabled() { mining.start(app); }
    Ok(())
}

fn prepare_current(app: &tauri::AppHandle, paths: &Paths, app_root: &Path) -> Result<(), String> {
    if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
        return Ok(());
    }
    let database = paths.active.join("gsm.db");
    std::fs::create_dir_all(&paths.active).map_err(|e| e.to_string())?;
    let mut backup = DailyBackup::configured(&paths.active, app_root).unwrap_or_else(|e| {
        crate::desktop_log::warn(
            app,
            "database",
            format!("Could not read backup preferences: {e}"),
        );
        None
    });
    if backup.is_some()
        && database.try_exists().map_err(|e| e.to_string())?
        && gsm_db::needs_upgrade(&database).map_err(|e| e.to_string())?
    {
        if let Some(policy) = backup.take() {
            policy.run(app, &database);
        }
    }
    let path = paths.active.join("config.json");
    let path = if path.try_exists().map_err(|e| e.to_string())? {
        path
    } else {
        app_root.join("config.json")
    };
    let config = gsm_settings::read_object(&path).unwrap_or_else(|e| {
        crate::desktop_log::warn(
            app,
            "database",
            format!("Using default startup settings: {e}"),
        );
        serde_json::Value::Null
    });
    let language = active_profile(&config)
        .and_then(|p| p.get("general"))
        .and_then(|g| g["target_language"].as_str())
        .unwrap_or("ja");
    let mut conn = gsm_db::open_profile(&database, language)
        .map_err(|e| format!("Opening {}: {e}", database.display()))?;
    gsm_db::startup_jobs::initialize(&mut conn, &config["stats"], Local::now())
        .map_err(|e| format!("Initializing background jobs: {e}"))?;
    // A missing or unreadable configuration is insufficient evidence for
    // dropping an existing profile's derived vocabulary and Anki tables.
    if let Some(experimental) = config["experimental"].as_object() {
        let master = experimental
            .get("enable_experimental_features")
            .and_then(|v| v.as_bool());
        let words = experimental
            .get("enable_tokenization")
            .and_then(|v| v.as_bool());
        let enabled = match (master, words) {
            (Some(false), _) | (_, Some(false)) => Some(false),
            (Some(true), Some(true)) => Some(true),
            _ => None,
        };
        if let Some(enabled) = enabled {
            gsm_db::vocabulary::configure_desktop(&mut conn, enabled)
                .map_err(|e| format!("Configuring vocabulary: {e}"))?;
            schedule_vocabulary(app, enabled)?;
        }
    }
    if let Some(policy) = backup {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || policy.run(&handle, &database));
    }
    Ok(())
}
