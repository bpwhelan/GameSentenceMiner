//! Mining history operations against the application's existing SQLite schema.
//! Reports use independent snapshots. The desktop lends the active backend a
//! single serialized writer until database close or backend disconnect.
mod anki_games;
mod anki_impact;
mod anki_coverage;
mod anki_notes;
mod anki_report_cache;
pub mod anki_sync;
pub mod capture;
pub mod exstatic;
pub mod kizuna;
pub mod kechimochi;
pub mod goal_metrics;
mod game_stats;
pub mod library;
mod goals;
pub use goals::GoalSettingsEdit;
pub use gsm_db::imports::Entry as ReadingEntry;
mod imported_stats;
pub mod characters;
mod kanji;
pub mod live;
mod maintenance;
pub mod game_archive;
mod maturity;
mod milestones;
pub mod mining;
mod novelty;
mod overview;
mod projection;
pub mod reader_history;
pub mod recycled;
mod rollup;
pub mod schedule;
mod search;
mod sessions;
pub use sessions::ReportCleaner;
mod stats;
pub mod stats_export;
pub mod tadoku;
mod tokenization;
pub mod word_index;
/// Typed inputs used by the web frontend and the desktop history broker.
pub mod reports {
    pub use super::anki_games::Report as AnkiGameQuery;
    pub use super::anki_impact::Report as AnkiImpactQuery;
    pub use super::anki_coverage::Report as AnkiCoverageQuery;
    pub use super::kanji::is_kanji;
    pub use super::maturity::Report as MaturityQuery;
    pub use super::tokenization::WordsNotInAnkiQuery;
    pub use super::game_stats::{DashboardStatsQuery, GameStatsQuery};
    pub use super::game_stats::JITEN_DIFFICULTY_LABELS;
    pub use super::overview::Range;
    pub use super::projection::{Projection, Target};
    pub use super::search::SentenceQuery;
    pub use super::search::DuplicateQuery;
    pub use super::reader_history::ReaderHistoryQuery;
    pub use super::maintenance::{ArchiveCandidate, DeduplicateQuery, LineRemoval, MaintenancePermit, RemovalSummary, TextDeletionQuery};
    pub use super::stats::local_date;
    pub use super::tokenization::{WordsQuery, KanjiQuery, TokenSearchQuery, WordDetailQuery};
}

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    error::Error,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

pub type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
fn legacy_timestamp(raw: &rusqlite::types::Value) -> Option<f64> {
    use rusqlite::types::Value as Sql;
    let text = match raw {
        Sql::Integer(n) => return Some(*n as f64),
        Sql::Real(n) => return n.is_finite().then_some(*n),
        Sql::Text(text) => text,
        _ => return None,
    };
    if let Ok(n) = text.trim().parse::<f64>() {
        return n.is_finite().then_some(n);
    }
    // Old profiles also stored Python datetime.isoformat() strings. Python
    // interprets a naive value in the machine's local zone, including a bare date.
    let iso = text.replace(' ', "T");
    if let Ok(date) = DateTime::parse_from_rfc3339(&iso) {
        return Some(date.timestamp_micros() as f64 / 1e6);
    }
    let naive = iso
        .parse::<NaiveDateTime>()
        .ok()
        .or_else(|| iso.parse::<NaiveDate>().ok()?.and_hms_opt(0, 0, 0))?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|d| d.timestamp_micros() as f64 / 1e6)
}

pub use gsm_db::create_profile_if_missing;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    MigrateSchema { language: String },
    ConfigureVocabulary { enabled: bool },
    ImportReadingStats {
        clear_source: Option<String>,
        rows: Vec<gsm_db::imports::Entry>,
    },
    #[serde(alias = "writerGeneration")]
    BeginRollup,
    RebuildRollups(rollup::Rebuild),
    CalculateRollupDay(rollup::Day),
    ReplaceRollupDay(rollup::Day),
    CleanWordIndex,
    RepairWordFirstSeen(word_index::FirstSeenRepair),
    LinkGameLines,
    GameMilestones,
    MaturityHistory(maturity::Report),
    AnkiGameStats(anki_games::Report),
    AnkiReadingImpact(anki_impact::Report),
    AnkiCoverage(anki_coverage::Report),
    AnkiContentRetention(anki_games::Report),
    AnkiEarliestNote {
        parent_tag: String,
    },
    AnkiNoteKanji {
        parent_tag: String,
        word_field: String,
        start: Option<i64>,
        end: Option<i64>,
    },
    ReadingOverview(overview::Range),
    GoalsProjection(projection::Projection),
    LatestGoals,
    GoalStreak { today: NaiveDate },
    GoalReadingPace { today: NaiveDate, day_start: f64, day_end: f64, session_gap: f64 },
    CompleteGoals { today: NaiveDate },
    KanjiGrid {
        today: NaiveDate,
        start: Option<NaiveDate>,
        end: Option<NaiveDate>,
        day_start: f64,
        day_end: f64,
    },
    KanjiFrequency {
        kanji: char,
        today: NaiveDate,
    },
    GameKanji {
        game_id: String,
    },
    CloseWriter,
    CaptureLines(capture::Batch),
    ReadingBreak {
        timestamp: f64,
    },
    UpdateMinedLine(mining::MinedLine),
    GameCharacterContext {
        game_title: String,
        include_character_data: bool,
    },
    SaveGameCharacterSummary {
        game_id: String,
        summary: String,
        expected_summary: String,
    },
    TodaySessions {
        start: f64,
        end: f64,
        session_gap: f64,
    },
    MiningHeatmap {
        start: Option<f64>,
        end: Option<f64>,
        #[serde(default)]
        live_only: bool,
    },
    DailyActivity {
        today: NaiveDate,
        start: Option<NaiveDate>,
        end: Option<NaiveDate>,
        #[serde(default)]
        all_time: bool,
    },
    SearchSentences(search::SentenceQuery),
    SearchDuplicates(search::DuplicateQuery),
    ReaderHistory(reader_history::ReaderHistoryQuery),
    GamesList,
    OrphanedGames,
    DatabaseStatus,
    ImportedStats { source: Option<String> },
    ImportedStatsSummary,
    ArchivePreview { game_id: String },
    PreviewTextDeletion(maintenance::TextDeletionQuery),
    DeleteTextLines(maintenance::TextDeletionQuery),
    PreviewDeduplication(maintenance::DeduplicateQuery),
    DeduplicateLines(maintenance::DeduplicateQuery),
    TokenizationStatus,
    TokenizationWords(tokenization::WordsQuery),
    TokenizationKanji(tokenization::KanjiQuery),
    TokenizationSearch(tokenization::TokenSearchQuery),
    TokenizationWordCardData {
        word_ids: Vec<i64>,
    },
    TokenizationWordDetail(tokenization::WordDetailQuery),
    TokenizationWordsByGame {
        limit: i64,
    },
    TokenizationWordsNotInAnki(tokenization::WordsNotInAnkiQuery),
    GlobalWordNovelty(novelty::GlobalNoveltyQuery),
    GameWordNovelty(novelty::GameNoveltyQuery),
    GameStats(game_stats::GameStatsQuery),
    DashboardStats(game_stats::DashboardStatsQuery),
}

fn open(path: &Path, writes: bool) -> Result<Connection> {
    let flags = if writes {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let conn = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(Duration::from_secs(30))?;
    if writes {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "synchronous", "FULL")?;
    } else {
        conn.pragma_update(None, "temp_store", "MEMORY")?;
    }
    Ok(conn)
}

const MAX_IDLE_READERS: usize = 2;

#[derive(Default)]
pub struct History {
    writer: Mutex<Writer>,
    readers: Mutex<ReadPool>,
    reports: anki_report_cache::Cache,
}

#[derive(Default)]
struct Writer {
    active: Option<(PathBuf, Connection)>,
    generation: u64,
}

#[derive(Default)]
struct ReadPool {
    path: Option<PathBuf>,
    generation: u64,
    idle: Vec<Connection>,
}

impl History {
    pub fn manual_backup(&self, path: &Path) -> Result<(PathBuf, String)> {
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Err("Cannot backup a database opened in read-only mode.".into());
        }
        // Finish an in-flight native write, then copy on a separate connection.
        // Keeping the writer free during the snapshot lets intake continue.
        drop(self.writer.lock().map_err(|_| "History writer unavailable")?);
        gsm_db::profile::manual_backup(path)
    }

    pub fn generation(&self) -> Result<u64> {
        Ok(self
            .writer
            .lock()
            .map_err(|_| "History writer unavailable")?
            .generation)
    }

    fn with_reader<T>(
        &self,
        path: &Path,
        f: impl FnOnce(&mut Connection) -> Result<T>,
    ) -> Result<T> {
        let (mut conn, generation) = {
            let mut pool = self
                .readers
                .lock()
                .map_err(|_| "History reader pool unavailable")?;
            if pool.path.as_deref() != Some(path) {
                pool.idle.clear();
                pool.path = Some(path.to_owned());
                pool.generation = pool.generation.wrapping_add(1);
            }
            (pool.idle.pop(), pool.generation)
        };
        let mut conn = match conn.take() {
            Some(existing) => existing,
            None => open(path, false)?,
        };
        let outcome = f(&mut conn);
        let return_conn = outcome.is_ok() && conn.is_autocommit();
        if return_conn {
            let dropped = {
                let mut pool = self
                    .readers
                    .lock()
                    .map_err(|_| "History reader pool unavailable")?;
                if pool.generation == generation
                    && pool.path.as_deref() == Some(path)
                    && pool.idle.len() < MAX_IDLE_READERS
                {
                    pool.idle.push(conn);
                    None
                } else {
                    Some(conn)
                }
            };
            drop(dropped);
        } else {
            drop(conn);
        }
        outcome
    }

    fn with_writer<T>(
        &self,
        path: &Path,
        f: impl FnOnce(&mut Connection) -> Result<T>,
    ) -> Result<T> {
        self.with_writer_generation(path, None, f)
    }

    fn with_writer_generation<T>(
        &self,
        path: &Path,
        generation: Option<u64>,
        f: impl FnOnce(&mut Connection) -> Result<T>,
    ) -> Result<T> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "History writer unavailable")?;
        if generation.is_some_and(|generation| generation != writer.generation) {
            return Err("Job cancelled because the database closed".into());
        }
        if writer
            .active
            .as_ref()
            .is_none_or(|(active, _)| active != path)
        {
            writer.active = Some((path.to_owned(), open(path, true)?));
        }
        let (_, conn) = writer.active.as_mut().ok_or("History writer unavailable")?;
        f(conn)
    }

    pub fn close(&self) -> Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "History writer unavailable")?;
        writer.generation = writer.generation.wrapping_add(1);
        writer.active.take();
        drop(writer);
        let released = {
            let mut pool = self
                .readers
                .lock()
                .map_err(|_| "History reader pool unavailable")?;
            pool.generation = pool.generation.wrapping_add(1);
            pool.path = None;
            std::mem::take(&mut pool.idle)
        };
        drop(released);
        self.reports.close()
    }

    pub fn current_goals(&self, path: &Path, read_only: bool) -> Result<Option<Value>> {
        let existing = self.with_reader(path, |conn| goals::current(conn))?;
        if existing.is_some() || read_only {
            return Ok(existing);
        }
        self.with_writer(path, goals::create_current).map(Some)
    }

    pub fn update_goals(
        &self, path: &Path, goals: Option<Vec<Value>>, settings: Option<GoalSettingsEdit>,
    ) -> Result<Value> {
        self.with_writer(path, |conn| goals::update(conn, goals, settings))
    }

    pub fn today_report(&self, path: &Path, start: f64, end: f64, gap: f64, cleaner: &ReportCleaner) -> Result<Value> {
        self.with_reader(path, |conn| {
            let tx = conn.transaction()?;
            let mut report = sessions::today(&tx, start, end, gap, cleaner)?;
            report.resolve_games(&tx)?;
            Ok(serde_json::to_value(report)?)
        })
    }

    pub fn first_rollup_date(&self, path: &Path) -> Result<Option<String>> {
        self.with_reader(path, |conn| Ok(conn.query_row(
            "SELECT min(date) FROM (SELECT min(date) AS date FROM daily_stats_rollup UNION ALL SELECT min(date) FROM third_party_stats)",
            [], |r| r.get(0))?))
    }

    pub fn game_exists(&self, path: &Path, id: &str) -> Result<bool> {
        self.with_reader(path, |conn| {
            Ok(
                conn.query_row("SELECT EXISTS(SELECT 1 FROM games WHERE id=?)", [id], |r| {
                    r.get(0)
                })?,
            )
        })
    }

    pub fn anki_has_notes(&self, path: &Path) -> Result<bool> {
        self.with_reader(path, |conn| {
            if !stats::table_exists(conn, "anki_notes")? {
                return Ok(false);
            }
            Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM anki_notes)", [], |r| r.get(0))?)
        })
    }

    pub fn capture(&self, path: &Path, batch: &capture::Batch) -> Result<usize> {
        self.with_writer(path, |conn| batch.persist(conn))
    }

    pub fn reader_history_before_line(
        &self,
        path: &Path,
        query: reader_history::ReaderHistoryQuery,
        before_line_id: Option<&str>,
    ) -> Result<reader_history::ReaderHistoryPage> {
        self.with_reader(path, |conn| {
            let tx = conn.transaction()?;
            query.run_before_line(&tx, before_line_id)
        })
    }

    pub fn run(&self, path: &Path, request: Request) -> Result<Value> {
        self.run_with_cleaner(path, request, &ReportCleaner::default())
    }

    pub fn run_with_cleaner(&self, path: &Path, request: Request, cleaner: &ReportCleaner) -> Result<Value> {
        match request {
            Request::CloseWriter => {
                self.close()?;
                return Ok(Value::Null);
            }
            Request::BeginRollup => return Ok(json!(self.generation()?)),
            Request::RebuildRollups(job) => return job.run(self, path),
            _ => {}
        }
        if matches!(
            request,
            Request::MigrateSchema { .. }
                | Request::ConfigureVocabulary { .. }
                | Request::ImportReadingStats { .. }
                | Request::CompleteGoals { .. }
                | Request::UpdateMinedLine(_)
                | Request::SaveGameCharacterSummary { .. }
                | Request::ReplaceRollupDay(_)
                | Request::ReadingBreak { .. }
                | Request::CaptureLines(_)
                | Request::LinkGameLines
                | Request::CleanWordIndex
                | Request::RepairWordFirstSeen(_)
                | Request::DeleteTextLines(_)
                | Request::DeduplicateLines(_)
        ) {
            return self.with_writer(path, |conn| execute(conn, request, cleaner));
        }
        let cache_key = anki_report_cache::Key::from_request(&request);
        let read = || self.with_reader(path, |conn| execute(conn, request, cleaner));
        match cache_key {
            Some(key) => self.reports.read(path, key, read),
            None => read(),
        }
    }
}

fn execute(conn: &mut Connection, request: Request, cleaner: &ReportCleaner) -> Result<Value> {
    match request {
        Request::LatestGoals => goals::latest(conn),
        Request::GoalReadingPace { today, day_start, day_end, session_gap } => {
            let tx = conn.transaction()?;
            goals::reading_pace(&tx, cleaner, today, day_start, day_end, session_gap)
        }
        Request::CompleteGoals { today } => goals::complete(conn, today),
        Request::GoalStreak { today } => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(goals::streak(&tx, today)?)?)
        }
        Request::GoalsProjection(query) => {
            let tx = conn.transaction()?;
            query.read(&tx, cleaner)
        }
        Request::ImportedStats { source } => imported_stats::list(conn, source.as_deref()),
        Request::ImportedStatsSummary => imported_stats::summary(conn),
        Request::DatabaseStatus => {
            let tx = conn.transaction()?;
            maintenance::database_status(&tx)
        }
        Request::ArchivePreview { game_id } => {
            let tx = conn.transaction()?;
            maintenance::archive_preview(&tx, &game_id)
        }
        Request::MigrateSchema { language } => {
            gsm_db::migrate(conn, &language)?;
            Ok(Value::Null)
        }
        Request::ConfigureVocabulary { enabled } => {
            gsm_db::vocabulary::configure_desktop(conn, enabled)?;
            Ok(Value::Null)
        }
        Request::ImportReadingStats { clear_source, rows } => {
            Ok(gsm_db::imports::import(conn, clear_source.as_deref(), &rows)?.into())
        }
        Request::BeginRollup | Request::RebuildRollups(_) => {
            unreachable!("handled by writer lifecycle")
        }
        Request::CalculateRollupDay(day) => {
            let tx = conn.transaction()?;
            rollup::allow_regex_fallback(day.calculate(&tx))
        }
        Request::ReplaceRollupDay(day) => rollup::allow_regex_fallback(day.replace(conn)),
        Request::CleanWordIndex => Ok(json!(word_index::cleanup(conn)?)),
        Request::RepairWordFirstSeen(repair) => Ok(json!(repair.run(conn)?)),
        Request::LinkGameLines => capture::link_game_lines(conn),
        Request::MaturityHistory(report) => {
            let tx = conn.transaction()?;
            report.read(&tx)
        }
        Request::AnkiGameStats(report) => {
            let tx = conn.transaction()?;
            report.read(&tx, anki_games::Grouping::Game)
        }
        Request::AnkiReadingImpact(report) => {
            let tx = conn.transaction()?;
            report.read(&tx, cleaner)
        }
        Request::AnkiCoverage(report) => {
            let tx = conn.transaction()?;
            report.read(&tx, cleaner)
        }
        Request::AnkiContentRetention(report) => {
            let tx = conn.transaction()?;
            report.read(&tx, anki_games::Grouping::Content)
        }
        Request::AnkiEarliestNote { parent_tag } => anki_notes::earliest(conn, &parent_tag),
        Request::AnkiNoteKanji {
            parent_tag,
            word_field,
            start,
            end,
        } => anki_notes::characters(conn, &parent_tag, &word_field, start, end),
        Request::GameMilestones => {
            let tx = conn.transaction()?;
            milestones::read(&tx)
        }
        Request::ReadingOverview(range) => {
            let tx = conn.transaction()?;
            range.read(&tx, cleaner)
        }
        Request::KanjiGrid {
            today,
            start,
            end,
            day_start,
            day_end,
        } => {
            let tx = conn.transaction()?;
            kanji::dashboard(&tx, today, start, end, day_start, day_end, cleaner)
        }
        Request::KanjiFrequency { kanji, today } => kanji::frequency(conn, kanji, today),
        Request::GameKanji { game_id } => {
            let tx = conn.transaction()?;
            kanji::game(&tx, &game_id)
        }
        Request::CloseWriter => unreachable!("handled by writer lifecycle"),
        Request::ReadingBreak { timestamp } => {
            conn.execute_batch("CREATE TABLE IF NOT EXISTS stats_reading_breaks (id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT)")?;
            conn.execute(
                "INSERT INTO stats_reading_breaks(timestamp) VALUES (?1)",
                [timestamp],
            )?;
            Ok(Value::Null)
        }
        Request::CaptureLines(batch) => Ok(json!(batch.persist(conn)?)),
        Request::TodaySessions {
            start,
            end,
            session_gap,
        } => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(sessions::today(
                &tx,
                start,
                end,
                session_gap,
                cleaner,
            )?)?)
        }
        Request::UpdateMinedLine(line) => Ok(json!(line.update(conn)?)),
        Request::GameCharacterContext { game_title, include_character_data } => Ok(serde_json::to_value(
            mining::game_character_context(conn, &game_title, include_character_data)?,
        )?),
        Request::SaveGameCharacterSummary { game_id, summary, expected_summary } => Ok(json!(
            mining::save_game_character_summary(conn, &game_id, &summary, &expected_summary)?
        )),
        Request::MiningHeatmap { start, end, live_only } => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(stats::mining_heatmap(
                &tx, start, end, live_only,
            )?)?)
        }
        Request::DailyActivity {
            today,
            start,
            end,
            all_time,
        } => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(stats::daily_activity(
                &tx, today, start, end, all_time,
            )?)?)
        }
        Request::SearchSentences(query) => {
            let tx = conn.transaction()?;
            query.run(&tx)
        }
        Request::SearchDuplicates(query) => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(query.run(&tx)?)?)
        }
        Request::ReaderHistory(query) => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(query.run(&tx)?)?)
        }
        Request::OrphanedGames => library::orphaned(conn),
        Request::GamesList => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(maintenance::games_list(&tx)?)?)
        }
        Request::PreviewTextDeletion(query) => {
            let tx = conn.transaction()?;
            query.preview(&tx)
        }
        Request::DeleteTextLines(query) => query.delete(conn),
        Request::PreviewDeduplication(query) => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(query.preview(&tx)?)?)
        }
        Request::DeduplicateLines(query) => Ok(serde_json::to_value(query.execute(conn)?)?),
        Request::TokenizationStatus => {
            let tx = conn.transaction()?;
            tokenization::status(&tx)
        }
        Request::TokenizationWords(query) => {
            let tx = conn.transaction()?;
            query.run(&tx)
        }
        Request::TokenizationKanji(query) => {
            let tx = conn.transaction()?;
            query.run(&tx)
        }
        Request::TokenizationSearch(query) => {
            let tx = conn.transaction()?;
            query.run(&tx)
        }
        Request::TokenizationWordCardData { word_ids } => {
            let tx = conn.transaction()?;
            tokenization::word_card_data(&tx, &word_ids)
        }
        Request::TokenizationWordDetail(query) => {
            let tx = conn.transaction()?;
            query.run(&tx)
        }
        Request::TokenizationWordsByGame { limit } => {
            let tx = conn.transaction()?;
            tokenization::words_by_game(&tx, limit)
        }
        Request::TokenizationWordsNotInAnki(query) => {
            let tx = conn.transaction()?;
            query.run(&tx)
        }
        Request::GlobalWordNovelty(query) => {
            let tx = conn.transaction()?;
            novelty::build_global_word_novelty(
                &tx,
                query.start_date,
                query.end_date,
                query.tokenization_enabled,
            )
        }
        Request::GameWordNovelty(query) => {
            let tx = conn.transaction()?;
            novelty::build_game_word_novelty(
                &tx,
                &query.game_id,
                query.first_date,
                query.last_date,
                query.tokenization_enabled,
            )
        }
        Request::GameStats(query) => {
            let tx = conn.transaction()?;
            query.run(&tx, cleaner)
        }
        Request::DashboardStats(query) => {
            let tx = conn.transaction()?;
            query.run(&tx, cleaner)
        }
    }
}

#[cfg(test)]
mod read_pool_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn read_pool_observes_external_writes_and_releases_handles_on_close() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gsm.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("CREATE TABLE t(v INTEGER)", []).unwrap();
            conn.execute("INSERT INTO t VALUES (1)", []).unwrap();
        }
        let history = Arc::new(History::default());
        let first: i64 = history
            .with_reader(&path, |c| {
                Ok(c.query_row("SELECT v FROM t", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(first, 1);
        assert_eq!(history.readers.lock().unwrap().idle.len(), 1);

        // External write must be visible on the reused pooled reader.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("UPDATE t SET v = 2", []).unwrap();
        }
        let second: i64 = history
            .with_reader(&path, |c| {
                Ok(c.query_row("SELECT v FROM t", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(second, 2);
        assert_eq!(history.readers.lock().unwrap().idle.len(), 1);

        // In-flight reader running across close() must NOT return its handle to the pool.
        let entered = Arc::new(Barrier::new(2));
        let proceed = Arc::new(Barrier::new(2));
        let h = Arc::clone(&history);
        let p = path.clone();
        let b1 = Arc::clone(&entered);
        let b2 = Arc::clone(&proceed);
        let worker = std::thread::spawn(move || {
            h.with_reader(&p, |c| {
                b1.wait();
                b2.wait();
                Ok(c.query_row("SELECT v FROM t", [], |r| r.get::<_, i64>(0))?)
            })
            .unwrap()
        });
        entered.wait();
        history.close().unwrap();
        proceed.wait();
        assert_eq!(worker.join().unwrap(), 2);
        assert_eq!(history.readers.lock().unwrap().idle.len(), 0);

        // File can be removed cleanly on Windows after close().
        std::fs::remove_file(&path).unwrap();
    }
}
