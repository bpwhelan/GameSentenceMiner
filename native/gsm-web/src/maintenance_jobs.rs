use crate::{Reply, Reports};
use gsm_history::reports::{ArchiveCandidate, MaintenancePermit};
use serde_json::{json, Value};
use std::sync::Arc;

pub enum MaintenanceJob {
    Vacuum,
    DeleteArchive(String),
    RestoreArchive(String),
    ArchiveGame(String),
    ArchiveSelected,
}

pub struct ReservedMaintenance {
    job: MaintenanceJob,
    permit: MaintenancePermit,
    reports: Arc<Reports>,
    games: Vec<ArchiveCandidate>,
}

impl MaintenanceJob {
    pub fn route(path: &str, method: &str) -> Option<Self> {
        if method == "POST" || method == "OPTIONS" {
            if path == "/api/games/archive" {
                return Some(Self::ArchiveSelected);
            }
            if path.ends_with("/archive") {
                if let Some(crate::Route::ArchivePreview(id)) = crate::Route::parse(path) {
                    return Some(Self::ArchiveGame(id));
                }
            }
        }
        if path == "/api/database/vacuum" {
            return Some(Self::Vacuum);
        }
        let (id, action) = path
            .strip_prefix("/api/database/archive-files/")?
            .split_once('/')?;
        if id.is_empty() {
            return None;
        }
        match action {
            "delete" => Some(Self::DeleteArchive(id.to_owned())),
            "restore" => Some(Self::RestoreArchive(id.to_owned())),
            _ => None,
        }
    }

    pub fn changes_history(&self) -> bool {
        matches!(
            self,
            Self::RestoreArchive(_) | Self::ArchiveGame(_) | Self::ArchiveSelected
        )
    }

    pub fn supported(&self, reports: &Reports) -> gsm_history::Result<bool> {
        Ok(!self.changes_history() || reports.preferences()?.cleaner.is_some())
    }

    pub fn reserve(
        self,
        reports: Arc<Reports>,
        body: &Value,
    ) -> Result<ReservedMaintenance, Reply> {
        if let Self::DeleteArchive(id) | Self::RestoreArchive(id) = &self {
            if body["confirm"] != true {
                return Err(Reply::error(
                    400,
                    if self.changes_history() {
                        "Confirm the archive file restore operation"
                    } else {
                        "Confirm the archive file delete operation"
                    },
                ));
            }
            reports
                .archive_download(id)
                .map_err(|(code, e)| Reply::error(code, e))?;
        }
        let games = match &self {
            Self::ArchiveGame(id) => {
                let games = reports
                    .history
                    .selected_archive_games(&reports.database, &[id])
                    .map_err(|e| Reply::error(500, &e.to_string()))?
                    .ok_or_else(|| Reply::error(404, "Game not found"))?;
                if body["confirm"] != true {
                    return Err(Reply::error(
                        400,
                        "Confirm removal of the original sentences to archive this game",
                    ));
                }
                games
            }
            Self::ArchiveSelected => {
                if body["confirm"] != true {
                    return Err(Reply::error(
                        400,
                        "Confirm removal of the original sentences to archive these games",
                    ));
                }
                reports.selected_games(body)?
            }
            _ => Vec::new(),
        };
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Err(Reply::error(403, "Database is read-only"));
        }
        let permit = reports
            .history
            .try_maintenance(&reports.database)
            .map_err(|e| Reply::error(500, &e.to_string()))?
            .ok_or_else(|| Reply::error(409, "Database maintenance is already running"))?;
        Ok(ReservedMaintenance {
            job: self,
            permit,
            reports,
            games,
        })
    }
}

impl ReservedMaintenance {
    pub fn run(self) -> gsm_history::Result<Value> {
        self.run_with(|_, _| Err("Word index unavailable".into()), |_| {})
    }

    pub fn run_with(
        self,
        prepare: impl Fn(Vec<String>, u64) -> Result<(), String>,
        progress: impl Fn(Value),
    ) -> gsm_history::Result<Value> {
        let reports = &self.reports;
        match &self.job {
            MaintenanceJob::ArchiveGame(id) => self.archive(id, None, &prepare),
            MaintenanceJob::ArchiveSelected => {
                let (mut total, mut archived, mut skipped) = (0, 0, 0);
                let mut successful = Vec::new();
                let mut failed = Vec::new();
                for (index, game) in self.games.iter().enumerate() {
                    progress(
                        json!({"total_games":self.games.len(),"completed_games":index,"current_game":game.name}),
                    );
                    match self.archive(&game.id, None, &prepare) {
                        Ok(item) => {
                            let count = item["archived_lines"]
                                .as_u64()
                                .ok_or("Archive record count missing")?;
                            total += count;
                            if count > 0 {
                                archived += 1;
                            } else {
                                skipped += 1;
                            }
                            successful.push(&game.id);
                        }
                        Err(e) => failed.push(
                            json!({"game_id":game.id,"game_name":game.name,"error":e.to_string()}),
                        ),
                    }
                    progress(
                        json!({"completed_games":index+1,"current_game":null,"archived_lines":total}),
                    );
                }
                Ok(
                    json!({"archived_games":archived,"archived_lines":total,"skipped_games":skipped,
                    "failed_games":failed,"successful_game_ids":successful}),
                )
            }
            MaintenanceJob::Vacuum => reports.history.vacuum(&self.permit),
            MaintenanceJob::RestoreArchive(id) => {
                let file = reports.archive_download(id).map_err(|(_, msg)| msg)?;
                let prefs = reports.preferences()?;
                let cleaner = prefs
                    .cleaner
                    .as_ref()
                    .ok_or("The statistics cleaning rule changed while the restore was starting")?;
                reports.history.restore_archive(
                    &self.permit,
                    &file.path,
                    id,
                    cleaner,
                    prefs.gap,
                    prefs.tokenization,
                )
            }
            MaintenanceJob::DeleteArchive(id) => {
                let file = reports.archive_download(id).map_err(|(_, msg)| msg)?;
                // Remove the directory entry that the user selected, even if
                // it is a link to another file inside the archive directory.
                std::fs::remove_file(reports.archive_directory().join(&file.filename))?;
                Ok(json!({"filename":file.filename}))
            }
        }
    }

    fn archive(
        &self,
        id: &str,
        cutoff: Option<f64>,
        prepare: &impl Fn(Vec<String>, u64) -> Result<(), String>,
    ) -> gsm_history::Result<Value> {
        let prefs = self.reports.preferences()?;
        let cleaner = prefs
            .cleaner
            .as_ref()
            .ok_or("The statistics cleaning rule changed while the archive was starting")?;
        if prefs.tokenization {
            let mut after = None;
            loop {
                let ids = self.reports.history.pending_archive_lines(
                    &self.permit,
                    id,
                    after.as_deref(),
                )?;
                let Some(last) = ids.last() else { break };
                after = Some(last.clone());
                prepare(ids, self.permit.generation())?;
            }
        }
        self.reports.history.archive_game(
            &self.permit,
            id,
            cutoff,
            cleaner,
            prefs.gap,
            prefs.tokenization,
        )
    }
}

impl Reports {
    pub fn scheduled_maintenance(
        self: Arc<Self>,
        generation: u64,
        now: f64,
        prepare: impl Fn(Vec<String>, u64) -> Result<(), String>,
    ) -> gsm_history::Result<Option<Value>> {
        let Some(permit) = self.history.try_maintenance(&self.database)? else {
            return Ok(Some(
                json!({"success":true,"skipped":true,"reason":"Maintenance already running"}),
            ));
        };
        if permit.generation() != generation {
            return Err("Job cancelled because the database closed".into());
        }
        let plan = self
            .history
            .scheduled_maintenance_plan(&self.database, now)?;
        if plan.games.is_empty() && !plan.vacuum {
            return Ok(Some(
                json!({"success":true,"archived_games":0,"archived_lines":0,"errors":[]}),
            ));
        }
        if !plan.games.is_empty() && self.preferences()?.cleaner.is_none() {
            return Ok(None);
        }
        let work = ReservedMaintenance {
            job: MaintenanceJob::ArchiveSelected,
            games: Vec::new(),
            reports: self,
            permit,
        };
        let (mut games, mut lines) = (0, 0);
        let mut errors = Vec::new();
        for id in plan.games {
            match work.archive(&id, plan.cutoff, &prepare) {
                Ok(result) => {
                    let count = result["archived_lines"]
                        .as_u64()
                        .ok_or("Archive record count missing")?;
                    lines += count;
                    games += usize::from(count > 0);
                }
                Err(e) => errors.push(format!("{id}: {e}")),
            }
        }
        let mut result = json!({"success":errors.is_empty(),"archived_games":games,"archived_lines":lines,"errors":errors});
        if plan.vacuum {
            result["vacuum"] = work.reports.history.vacuum(&work.permit)?;
        }
        Ok(Some(result))
    }
}
