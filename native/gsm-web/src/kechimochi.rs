mod client;
mod reconcile;
mod settings;
use crate::{Preferences, Reply, Reports, Result};
use client::{normalize, Remote};
use gsm_history::kechimochi::{digest, SnapshotOptions};
use serde_json::{json, Value};
use settings::Settings;
use std::{
    fs::{File, OpenOptions, TryLockError},
    path::Path,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub enum Start {
    Ready(Reply, Option<Sync>),
    Compatibility,
}
pub struct Sync {
    reports: Arc<Reports>,
    prefs: Arc<Preferences>,
    settings: Settings,
    generation: u64,
    source: String,
    namespace: Uuid,
    destination: String,
    base: String,
    language: &'static str,
    run_key: String,
    status: Value,
    _lock: File,
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
fn lock(path: &Path) -> std::result::Result<File, Reply> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("kechimochi.lock"))
        .map_err(internal)?;
    file.try_lock().map_err(|e| match e {
        TryLockError::WouldBlock => {
            Reply::error(409, "A Kechimochi sync is already queued or running")
        }
        TryLockError::Error(e) => internal(e),
    })?;
    if file.metadata().map_err(internal)?.len() == 0 {
        file.set_len(1).map_err(internal)?;
    }
    Ok(file)
}
fn internal(e: impl std::fmt::Display) -> Reply {
    Reply::error(500, &e.to_string())
}
fn success(body: Value) -> Reply {
    Reply { status: 200, body }
}
impl Reports {
    fn kechimochi_settings(&self) -> Result<Settings> {
        Ok(Settings::read(
            &gsm_settings::read_object(&self.config)?["stats"],
        ))
    }
    pub(crate) fn kechimochi_view(&self, route: &crate::Route) -> Result<Option<Reply>> {
        let settings = self.kechimochi_settings()?;
        let generation = self.history.generation()?;
        match route {
            crate::Route::KechimochiSettings => Ok(Some(success(json!(settings)))),
            crate::Route::KechimochiPreview => {
                let prefs = self.preferences()?;
                let Some(cleaner) = prefs.cleaner.as_ref() else {
                    return Ok(None);
                };
                let snapshot = self.history.kechimochi_snapshot(
                    &self.database,
                    generation,
                    &SnapshotOptions {
                        cleaner,
                        session_gap: prefs.gap,
                        language: "",
                        include_external: settings.include_external_stats,
                    },
                );
                Ok(Some(match snapshot {
                    Ok(snapshot) => success(snapshot.preview()),
                    Err(e) => Reply::error(400, &e.to_string()),
                }))
            }
            crate::Route::KechimochiStatus => {
                let url = normalize(&json!(settings.url))?;
                // Preserve the on-disk source identity used by previous desktop versions.
                if std::env::var("GSM_DB_READ_ONLY").as_deref() != Ok("1") {
                    self.history
                        .kechimochi_identity(&self.database, generation)?;
                }
                let mut status = self
                    .history
                    .kechimochi_state(&self.database, &format!("run:{}", digest(url)))?
                    .unwrap_or_else(|| json!({"status":"idle"}));
                if matches!(status["status"].as_str(), Some("running" | "queued")) {
                    match lock(&self.database) {
                        Ok(_) => {
                            status["status"] = "interrupted".into();
                            status["error"]="The previous sync was interrupted. The next run will resume safely.".into();
                        }
                        Err(e) if e.status == 409 => (),
                        Err(e) => return Ok(Some(e)),
                    }
                }
                status["settings"] = json!(settings);
                status["next_run"] = json!(self.history.kechimochi_deadline(&self.database)?);
                Ok(Some(success(status)))
            }
            _ => Err("Unknown Kechimochi view".into()),
        }
    }
    pub fn kechimochi_test(&self, body: &Value) -> Reply {
        let Some(map) = body.as_object().filter(|o| o.keys().all(|k| k == "url")) else {
            return Reply::error(400, "Expected a Kechimochi URL");
        };
        let url = match map.get("url") {
            Some(value) => value.clone(),
            None => match self.kechimochi_settings() {
                Ok(settings) => settings.url.into(),
                Err(e) => return internal(e),
            },
        };
        let base = match normalize(&url) {
            Ok(base) => base,
            Err(e) => return Reply::error(400, e),
        };
        let connection = (|| -> Result<_> {
            let remote = Remote::new(&base)?;
            Ok(
                json!({"connected":true,"version":remote.version()?,"media_count":remote.list("media")?.len()}),
            )
        })();
        match connection {
            Ok(v) => success(v),
            Err(e) => Reply::error(502, &e.to_string()),
        }
    }
    pub fn prepare_kechimochi(
        self: &Arc<Self>,
        updates: Option<&Value>,
        scheduled: bool,
        name: fn(&str) -> &'static str,
    ) -> std::result::Result<Start, Reply> {
        let generation = self.begin_file_import()?;
        let updates = updates
            .map(Settings::validate)
            .transpose()
            .map_err(|e| Reply::error(400, &e))?;
        let prefs = self.preferences().map_err(internal)?;
        if prefs.cleaner.is_none() {
            return Ok(Start::Compatibility);
        }
        let lock = lock(&self.database)?;
        let settings = if let Some(updates) = &updates {
            gsm_settings::with_lock(&self.config, || {
                let original = gsm_settings::read_object(&self.config)?;
                let mut root = original.clone();
                if root["stats"].is_null() {
                    root["stats"] = json!({});
                }
                root["stats"]
                    .as_object_mut()
                    .ok_or("Invalid stats settings")?
                    .extend(updates.as_object().unwrap().clone());
                gsm_settings::write_atomic(&self.config, &root)?;
                if let Err(e) =
                    self.history
                        .configure_kechimochi(&self.database, generation, &root["stats"])
                {
                    gsm_settings::write_atomic(&self.config, &original)?;
                    return Err(e.to_string());
                }
                Ok(Settings::read(&root["stats"]))
            })
            .map_err(internal)?
        } else {
            self.kechimochi_settings().map_err(internal)?
        };
        let reply = success(json!(settings));
        if !settings.enabled && (updates.is_some() || scheduled) {
            return Ok(Start::Ready(reply, None));
        }
        let base = normalize(&json!(settings.url)).map_err(|e| Reply::error(400, e))?;
        let destination = digest(&base);
        let source = self
            .history
            .kechimochi_identity(&self.database, generation)
            .map_err(internal)?;
        let namespace = Uuid::parse_str(&source).map_err(internal)?;
        let run_key = format!("run:{destination}");
        let previous = self
            .history
            .kechimochi_state(&self.database, &run_key)
            .map_err(internal)?
            .unwrap_or_default();
        let id = Uuid::new_v4().simple().to_string();
        let status = json!({"run_id":id,"status":"queued","started_at":now(),"last_success_at":previous["last_success_at"],
            "phase":"Starting sync","processed":0,"total":0,"error":null});
        self.history
            .save_kechimochi_state(&self.database, generation, &run_key, &status)
            .map_err(internal)?;
        let language = name(&prefs.language);
        let work = Sync {
            reports: self.clone(),
            prefs,
            settings,
            generation,
            source,
            namespace,
            destination,
            base,
            language,
            run_key,
            status,
            _lock: lock,
        };
        let reply = if updates.is_some() {
            reply
        } else {
            Reply {
                status: 202,
                body: json!({"job_id":id,"status":"queued"}),
            }
        };
        Ok(Start::Ready(reply, Some(work)))
    }
}
impl Sync {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    fn check(&self) -> Result<()> {
        self.reports
            .history
            .check_kechimochi_generation(self.generation)
    }
    fn save(&self, key: &str, value: &Value) -> Result<()> {
        self.reports.history.save_kechimochi_state(
            &self.reports.database,
            self.generation,
            key,
            value,
        )
    }
    pub fn run(self, manual: bool) -> Result<Value> {
        let mut status = self.status.clone();
        status["status"] = "running".into();
        status["phase"] = "Connecting to Kechimochi".into();
        self.save(&self.run_key, &status)?;
        let mut last = None;
        let mut progress = |done: usize, total: usize, phase: &str| -> Result<()> {
            self.check()?;
            status["processed"] = done.into();
            status["total"] = total.into();
            status["phase"] = phase.into();
            if last.is_none_or(|t: Instant| t.elapsed() >= Duration::from_secs(1)) {
                status["updated_at"] = now().into();
                self.save(&self.run_key, &status)?;
                last = Some(Instant::now());
            }
            Ok(())
        };
        let outcome = (|| {
            let remote = Remote::new(&self.base)?;
            remote.version()?;
            progress(0, 0, "Reading all GSM history")?;
            let snapshot = self.reports.history.kechimochi_snapshot(
                &self.reports.database,
                self.generation,
                &SnapshotOptions {
                    language: self.language,
                    include_external: self.settings.include_external_stats,
                    session_gap: self.prefs.gap,
                    cleaner: self
                        .prefs
                        .cleaner
                        .as_ref()
                        .ok_or("Invalid history cleaning expression")?,
                },
            )?;
            self.reports.history.remember_kechimochi_days(
                &self.reports.database,
                self.generation,
                &snapshot.observed,
            )?;
            reconcile::sync(&self, &remote, &snapshot, progress)
        })();
        match &outcome {
            Ok(result) => {
                status["status"] = "completed".into();
                status["phase"] = "Sync complete".into();
                status["last_success_at"] = now().into();
                status["result"] = result.clone();
            }
            Err(e) => {
                status["status"] = "failed".into();
                status["phase"] = "Sync failed".into();
                status["error"] = e.to_string().into();
            }
        }
        status["updated_at"] = now().into();
        self.save(&self.run_key, &status)?;
        if manual && self.settings.enabled {
            let config = gsm_settings::read_object(&self.reports.config)?;
            self.reports.history.reschedule_kechimochi(
                &self.reports.database,
                self.generation,
                &config["stats"],
                outcome.is_err(),
            )?;
        }
        outcome
    }
}
