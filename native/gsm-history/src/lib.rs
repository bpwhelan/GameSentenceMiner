//! Mining history operations against the application's existing SQLite schema.
//! Reports use independent snapshots. The desktop lends the active backend a
//! single serialized writer until database close or backend disconnect.
mod anki_games;
mod anki_notes;
mod anki_report_cache;
pub mod anki_sync;
mod capture;
mod game_stats;
mod kanji;
mod maintenance;
mod maturity;
mod milestones;
mod mining;
mod novelty;
mod overview;
mod rollup;
pub mod schedule;
mod search;
mod sessions;
mod stats;
mod tokenization;
pub mod word_index;

use chrono::NaiveDate;
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

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
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
    UpdateMinedLine(mining::MinedLine),
    TodaySessions {
        start: f64,
        end: f64,
        session_gap: f64,
    },
    MiningHeatmap {
        start: Option<f64>,
        end: Option<f64>,
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
    GamesList,
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

    pub fn run(&self, path: &Path, request: Request) -> Result<Value> {
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
            Request::UpdateMinedLine(_)
                | Request::ReplaceRollupDay(_)
                | Request::CaptureLines(_)
                | Request::LinkGameLines
                | Request::CleanWordIndex
                | Request::RepairWordFirstSeen(_)
                | Request::DeleteTextLines(_)
                | Request::DeduplicateLines(_)
        ) {
            return self.with_writer(path, |conn| execute(conn, request));
        }
        let cache_key = anki_report_cache::Key::from_request(&request);
        let read = || self.with_reader(path, |conn| execute(conn, request));
        match cache_key {
            Some(key) => self.reports.read(path, key, read),
            None => read(),
        }
    }
}

fn execute(conn: &mut Connection, request: Request) -> Result<Value> {
    match request {
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
            range.read(&tx)
        }
        Request::KanjiGrid {
            today,
            start,
            end,
            day_start,
            day_end,
        } => {
            let tx = conn.transaction()?;
            kanji::dashboard(&tx, today, start, end, day_start, day_end)
        }
        Request::KanjiFrequency { kanji, today } => kanji::frequency(conn, kanji, today),
        Request::GameKanji { game_id } => {
            let tx = conn.transaction()?;
            kanji::game(&tx, &game_id)
        }
        Request::CloseWriter => unreachable!("handled by writer lifecycle"),
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
            )?)?)
        }
        Request::UpdateMinedLine(line) => Ok(json!(line.update(conn)?)),
        Request::MiningHeatmap { start, end } => {
            let tx = conn.transaction()?;
            Ok(serde_json::to_value(stats::mining_heatmap(
                &tx, start, end,
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
            query.run(&tx)
        }
        Request::DashboardStats(query) => {
            let tx = conn.transaction()?;
            query.run(&tx)
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
            .with_reader(&path, |c| Ok(c.query_row("SELECT v FROM t", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(first, 1);
        assert_eq!(history.readers.lock().unwrap().idle.len(), 1);

        // External write must be visible on the reused pooled reader.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("UPDATE t SET v = 2", []).unwrap();
        }
        let second: i64 = history
            .with_reader(&path, |c| Ok(c.query_row("SELECT v FROM t", [], |r| r.get(0))?))
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
