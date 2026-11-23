mod client;
use crate::{Preferences, Reply, Reports, Result};
use client::Session;
use gsm_history::tadoku::{Preview, TitleSource};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions, TryLockError},
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Sync {
    reports: Arc<Reports>,
    generation: u64,
    prefs: Arc<Preferences>,
    settings: Value,
    deduplicate: bool,
    titles: HashMap<String, String>,
    minimum: usize,
    whitelist: HashSet<String>,
    _lock: File,
}

fn descriptions(value: &Value) -> std::result::Result<HashMap<String, String>, Reply> {
    let mut titles = HashMap::new();
    if value.is_null() {
        return Ok(titles);
    }
    let invalid = || Reply::error(400, "Tadoku log descriptions must map game keys to text");
    for (key, entry) in value.as_object().ok_or_else(invalid)? {
        let title = entry.as_str().ok_or_else(invalid)?.trim();
        if key.trim().is_empty() {
            return Err(invalid());
        }
        if !(1..=255).contains(&title.chars().count()) {
            return Err(Reply::error(
                400,
                "Tadoku log titles must contain between 1 and 255 characters",
            ));
        }
        titles.insert(key.clone(), title.into());
    }
    Ok(titles)
}

fn save_cookie(
    path: &Path,
    session: &Session,
    original: &Value,
) -> std::result::Result<(), String> {
    if session.cookie.is_empty() || original.as_str() == Some(session.cookie.as_str()) {
        return Ok(());
    }
    gsm_settings::with_lock(path, || {
        let mut root = gsm_settings::read_object(path)?;
        if session.same_account(&root["stats"])
            && root["stats"]["tadoku_session_cookie"] == *original
        {
            root["stats"]["tadoku_session_cookie"] = session.cookie.clone().into();
            gsm_settings::write_atomic(path, &root)?;
        }
        Ok(())
    })
}

impl Reports {
    pub fn tadoku_login(&self) -> Reply {
        let stats = match gsm_settings::read_object(&self.config) {
            Ok(mut root) => root["stats"].take(),
            Err(e) => return Reply::error(500, &e),
        };
        let mut session = Session::new(&stats);
        if !session.configured() {
            return Reply::error(400, "Save a Tadoku email and password first");
        }
        if let Err(e) = session.login() {
            return Reply::error(401, &e.to_string());
        }
        if let Err(e) = save_cookie(&self.config, &session, &stats["tadoku_session_cookie"]) {
            return Reply::error(500, &e);
        }
        Reply {
            status: 200,
            body: json!({"authenticated":true}),
        }
    }

    pub fn prepare_tadoku(
        self: &Arc<Self>,
        body: &Value,
        scheduled: bool,
    ) -> std::result::Result<Option<Sync>, Reply> {
        if !body.is_null() && !body.is_object() {
            return Err(Reply::error(400, "Tadoku sync options must be an object"));
        }
        let titles = descriptions(&body["log_descriptions"])?;
        let generation = self.begin_file_import()?;
        let prefs = self
            .preferences()
            .map_err(|e| Reply::error(500, &e.to_string()))?;
        if prefs.cleaner.is_none() {
            return Ok(None);
        }
        let settings = gsm_settings::read_object(&self.config)
            .map_err(|e| Reply::error(500, &e))?["stats"]
            .take();
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.database.with_extension("tadoku.lock"))
            .map_err(|e| Reply::error(500, &e.to_string()))?;
        lock.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => {
                Reply::error(409, "A Tadoku sync is already queued or running")
            }
            TryLockError::Error(e) => Reply::error(500, &e.to_string()),
        })?;
        let mut whitelist = HashSet::new();
        let deduplicate = if scheduled {
            whitelist.extend(
                settings["tadoku_daily_sync_game_ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
            settings["tadoku_daily_sync_deduplicate"]
                .as_bool()
                .unwrap_or(true)
        } else {
            match &body["deduplicate"] {
                Value::Bool(b) => *b,
                Value::Null => false,
                Value::String(s) => !s.is_empty(),
                Value::Array(a) => !a.is_empty(),
                Value::Object(o) => !o.is_empty(),
                Value::Number(n) => n.as_f64() != Some(0.0),
            }
        };
        Ok(Some(Sync {
            reports: self.clone(),
            generation,
            prefs,
            settings,
            deduplicate,
            titles,
            whitelist,
            minimum: if scheduled { 5000 } else { 0 },
            _lock: lock,
        }))
    }
}

impl Sync {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn run(self) -> Result<Value> {
        let cutoff = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
        let source = self.settings["tadoku_title_source"]
            .as_str()
            .and_then(TitleSource::parse)
            .unwrap_or(TitleSource::English);
        let preview = self.reports.history.tadoku_preview(
            &self.reports.database,
            self.generation,
            cutoff,
            source,
            self.deduplicate,
            self.prefs
                .cleaner
                .as_ref()
                .ok_or("Unsupported text cleanup expression")?,
        )?;
        let mut session = Session::new(&self.settings);
        let result = self.send(preview, &mut session);
        // An acknowledged export has already advanced its cursor. A session
        // cache write failure can be recovered by signing in on the next run.
        if let Err(error) = save_cookie(
            &self.reports.config,
            &session,
            &self.settings["tadoku_session_cookie"],
        ) {
            eprintln!("Could not persist refreshed Tadoku session: {error}");
        }
        result
    }
    fn send(&self, preview: Preview, session: &mut Session) -> Result<Value> {
        let scope: Vec<_> = preview
            .entries
            .iter()
            .filter(|g| self.whitelist.is_empty() || self.whitelist.contains(&g.game_key))
            .collect();
        let eligible: Vec<_> = scope
            .iter()
            .copied()
            .filter(|g| {
                preview
                    .game_character_totals
                    .get(&g.game_key)
                    .copied()
                    .unwrap_or(0)
                    >= self.minimum
            })
            .collect();
        let partial = self.minimum > 0 || !self.whitelist.is_empty();
        if eligible.is_empty() && partial {
            let noun = if self.whitelist.is_empty() {
                "game"
            } else {
                "whitelisted game"
            };
            let reason = if self.minimum > 0 && !scope.is_empty() {
                format!("no {noun} has 5,000 total characters")
            } else {
                format!("no {noun} has queued characters")
            };
            return Ok(
                json!({"success":true,"skipped":true,"reason":reason,"entries_sent":0,"characters_sent":0,
                "pending_characters":scope.iter().map(|g|g.characters).sum::<usize>(),"minimum_characters_per_game":self.minimum,
                "duplicates_excluded":preview.duplicates_excluded,"cursor":preview.cursor}),
            );
        }
        let mut created = Vec::<String>::new();
        let result = (|| -> Result<()> {
            if !eligible.is_empty() {
                let language = self.settings["tadoku_language_code"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("jpn")
                    .trim()
                    .to_lowercase();
                let unit = session.units(&language)?;
                let registrations = session.registrations(&language)?;
                for entry in &eligible {
                    if self.reports.history.generation()? != self.generation {
                        return Err("Database changed during Tadoku sync".into());
                    }
                    let title = self
                        .titles
                        .get(&entry.game_key)
                        .cloned()
                        .unwrap_or_else(|| entry.game_name.chars().take(255).collect());
                    let body = json!({"language_code":language,"activity_id":1,"amount":entry.characters,"unit_key":unit,
                        "tags":[entry.media_tag,"gsm"],"description":title,"registration_ids":registrations});
                    created.push(session.create(&body)?);
                }
            }
            let keys = eligible
                .iter()
                .map(|g| g.game_key.as_str())
                .collect::<Vec<_>>();
            self.reports.history.finish_tadoku(
                &self.reports.database,
                self.generation,
                preview.upper_bound,
                &keys,
                !partial,
            )
        })();
        if let Err(error) = result {
            let failed = created
                .iter()
                .rev()
                .filter(|id| session.delete(id).is_err())
                .count();
            if failed > 0 {
                return Err(
                    format!("{error}. Tadoku rollback also failed for {failed} log(s)").into(),
                );
            }
            return Err(error);
        }
        Ok(
            json!({"success":true,"entries_sent":eligible.len(),"characters_sent":eligible.iter().map(|g|g.characters).sum::<usize>(),
            "duplicates_excluded":preview.duplicates_excluded,"cursor":if partial{preview.cursor}else{preview.upper_bound}}),
        )
    }
}
