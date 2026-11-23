use crate::{search::RegexMatcher, stats::local_date, Result};
use indexmap::IndexMap;
use rusqlite::{params_from_iter, types::ValueRef, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    collections::{BTreeSet, HashMap, HashSet},
};

const DELETE_CHUNK_SIZE: usize = 500;
const PREVIEW_SAMPLE_LIMIT: usize = 10;

#[derive(Default)]
pub(super) struct Deleted {
    pub count: usize,
    pub dates: BTreeSet<chrono::NaiveDate>,
    pub failed_ids: Vec<String>,
}

pub struct RemovalSummary {
    pub deleted_count: usize,
    pub failed_ids: Vec<String>,
}

pub enum LineRemoval {
    Text(TextDeletionQuery),
    StripRegex { pattern: String, case_sensitive: bool },
    Duplicates(DeduplicateQuery),
    Ids(Vec<String>),
}

impl LineRemoval {
    pub(super) fn apply(self, tx: &mut Transaction<'_>) -> Result<Option<Deleted>> {
        match self {
            Self::Text(query) => query.delete_in(tx),
            Self::StripRegex {pattern,case_sensitive} => strip_regex(tx,&pattern,case_sensitive),
            Self::Duplicates(query) => Ok(Some(query.execute_in(tx)?)),
            Self::Ids(ids) => Ok(Some(delete_selected(tx, ids)?)),
        }
    }
}

fn strip_regex(tx: &Transaction<'_>, pattern: &str, case_sensitive: bool) -> Result<Option<Deleted>> {
    use crate::sessions::PunctuationRegex;
    let Ok(regex) = pcre2::bytes::RegexBuilder::new().caseless(!case_sensitive)
        .utf(true).ucp(true).jit_if_available(true).build(&format!("(*NOTEMPTY)(?:{pattern})")) else {return Ok(None)};
    let matcher = PunctuationRegex::Perl(regex);
    let mut result = Deleted::default();
    tx.execute_batch("CREATE TEMP TABLE gsm_rewritten_lines(id TEXT PRIMARY KEY, text TEXT NOT NULL) WITHOUT ROWID")?;
    {
        let mut select = tx.prepare("SELECT CAST(id AS TEXT),line_text,timestamp FROM game_lines WHERE line_text IS NOT NULL AND line_text!=''")?;
        let mut rows = select.query([])?;
        let mut insert = tx.prepare("INSERT INTO gsm_rewritten_lines VALUES (?1,?2)")?;
        while let Some(row) = rows.next()? {
            let original = row.get_ref(1)?.as_str()?;
            if let Cow::Owned(text) = matcher.strip(original)? {
                if text!=original {
                    insert.execute(rusqlite::params![row.get_ref(0)?.as_str()?,text])?;
                    if let Some(date) = opt_f64(row.get_ref(2)?).and_then(|ts| local_date(ts).ok()) {
                        result.dates.insert(date);
                    }
                    result.count+=1;
                }
            }
        }
    }
    if result.count>0 {
        let tokenized:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('game_lines') WHERE name='tokenized')",[],|r|r.get(0))?;
        let reset=if tokenized {",tokenized=0"} else {""};
        tx.execute(&format!("UPDATE game_lines SET line_text=t.text{reset} FROM gsm_rewritten_lines t WHERE game_lines.id=t.id"),[])?;
        for table in ["word_occurrences","kanji_occurrences"] {
            if crate::stats::table_exists(tx,table)? {
                tx.execute(&format!("DELETE FROM {table} WHERE line_id IN (SELECT id FROM gsm_rewritten_lines)"),[])?;
            }
        }
    }
    tx.execute_batch("DROP TABLE gsm_rewritten_lines")?;
    Ok(Some(result))
}

fn maintenance_settings(conn: &Connection) -> Result<Value> {
    Ok(conn.query_row("SELECT vacuum_interval_days,archive_after_days,last_vacuum FROM database_maintenance WHERE id=1",[],|r|Ok(json!({
        "vacuum_interval_days":r.get::<_,i64>(0)?,"archive_after_days":r.get::<_,i64>(1)?,"last_vacuum":r.get::<_,Option<f64>>(2)?
    })))?)
}

pub(super) fn database_status(conn: &Connection) -> Result<Value> {
    let settings = maintenance_settings(conn)?;
    let storage=conn.query_row("SELECT page_count*page_size,freelist_count*page_size,
        (SELECT count(*) FROM game_lines),(SELECT coalesce(sum(line_count),0) FROM archived_game_days)
        FROM pragma_page_count,pragma_page_size,pragma_freelist_count",[],|r|Ok(json!({
            "database_bytes":r.get::<_,i64>(0)?,"reclaimable_bytes":r.get::<_,i64>(1)?,
            "raw_lines":r.get::<_,i64>(2)?,"archived_lines":r.get::<_,i64>(3)?
        })))?;
    Ok(json!({"settings":settings,"storage":storage}))
}

#[derive(Debug)]
pub struct ArchiveCandidate {
    pub id: String,
    pub name: String,
    pub raw_lines: i64,
}

pub struct MaintenancePlan {
    pub cutoff: Option<f64>,
    pub games: Vec<String>,
    pub vacuum: bool,
}

/// Dropping the file releases this profile's lock, including after a worker
/// fails. The Python scheduler takes an overlapping lock on the same file.
pub struct MaintenancePermit {
    _file: std::fs::File,
    pub(super) generation: u64,
    pub(super) database: std::path::PathBuf,
}

impl MaintenancePermit {
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl crate::History {
    pub fn scheduled_maintenance_plan(
        &self,
        path: &std::path::Path,
        now: f64,
    ) -> Result<MaintenancePlan> {
        self.with_reader(path,|conn|{
            let tx=conn.transaction()?;
            let (interval,age,last):(i64,i64,Option<f64>)=tx.query_row("SELECT vacuum_interval_days,archive_after_days,last_vacuum FROM database_maintenance WHERE id=1",[],
                |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            let mut plan=MaintenancePlan{cutoff:None,games:Vec::new(),vacuum:interval>0 && last.is_none_or(|last|now-last>=interval as f64*86400.0)};
            if age>0{
                let instant=chrono::DateTime::from_timestamp_micros((now*1e6) as i64).ok_or("Invalid maintenance timestamp")?;
                let local=instant.with_timezone(&chrono::Local).naive_local().checked_sub_days(chrono::Days::new(age as u64)).ok_or("Invalid retention period")?;
                let cutoff=gsm_db::local_timestamp(local)?;
                let mut q=tx.prepare("SELECT g.id FROM games g JOIN game_lines gl ON gl.game_id=g.id
                    WHERE g.status='completed' OR (coalesce(g.status,'')='' AND g.completed=1)
                    GROUP BY g.id HAVING max(CAST(gl.timestamp AS REAL))<?")?;
                let rows=q.query_map([cutoff],|r|r.get(0))?;
                plan.games=rows.collect::<rusqlite::Result<_>>()?;
                plan.cutoff=Some(cutoff);
            }
            Ok(plan)
        })
    }
    pub fn pending_archive_lines(
        &self,
        permit: &MaintenancePermit,
        game: &str,
        after: Option<&str>,
    ) -> Result<Vec<String>> {
        self.with_writer_generation(&permit.database, Some(permit.generation), |conn| {
            let mut q = conn.prepare_cached(
                "SELECT id FROM game_lines WHERE game_id=?1 AND coalesce(tokenized,0)=0
                AND (?2 IS NULL OR id>?2) ORDER BY id LIMIT 256",
            )?;
            let rows = q.query_map(rusqlite::params![game, after], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }
    pub fn try_maintenance(&self, path: &std::path::Path) -> Result<Option<MaintenancePermit>> {
        use std::fs::{OpenOptions, TryLockError};
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_extension("maintenance.lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(MaintenancePermit {
                _file: file,
                database: path.to_owned(),
                generation: self.generation()?,
            })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(error)) => Err(error.into()),
        }
    }

    pub fn vacuum(&self, permit: &MaintenancePermit) -> Result<Value> {
        self.with_writer_generation(&permit.database, Some(permit.generation), |conn| {
            let logical_size = |conn: &Connection| conn.query_row(
                "SELECT page_count * page_size FROM pragma_page_count, pragma_page_size", [], |r| r.get::<_, i64>(0)
            );
            let before = logical_size(conn)?;
            conn.execute_batch("VACUUM")?;
            let after = logical_size(conn)?;
            conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))?;
            conn.execute("INSERT INTO database_maintenance(id,last_vacuum) VALUES(1,unixepoch('subsec'))
                ON CONFLICT(id) DO UPDATE SET last_vacuum=excluded.last_vacuum", [])?;
            Ok(json!({"before_bytes":before,"after_bytes":after,"reclaimed_bytes":(before-after).max(0)}))
        })
    }
    pub fn save_maintenance_settings(
        &self,
        path: &std::path::Path,
        vacuum: Option<i64>,
        archive: Option<i64>,
    ) -> Result<Value> {
        self.with_writer(path,|conn|{
            let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            tx.execute("INSERT OR IGNORE INTO database_maintenance(id) VALUES(1)",[])?;
            tx.execute("UPDATE database_maintenance SET vacuum_interval_days=coalesce(?1,vacuum_interval_days),
                archive_after_days=coalesce(?2,archive_after_days) WHERE id=1",rusqlite::params![vacuum,archive])?;
            let settings=maintenance_settings(&tx)?;
            tx.commit()?;
            Ok(settings)
        })
    }

    pub fn selected_archive_games(
        &self,
        path: &std::path::Path,
        ids: &[&str],
    ) -> Result<Option<Vec<ArchiveCandidate>>> {
        self.with_reader(path,|conn|{
            // json_each preserves selection order and uses the primary-key and
            // line-owner indexes without a query per 200 selected games.
            let mut query=conn.prepare_cached("SELECT g.id,coalesce(nullif(g.title_original,''),g.id),
                (SELECT count(*) FROM game_lines WHERE game_id=g.id)
                FROM json_each(?) selection JOIN games g ON g.id=selection.value ORDER BY selection.key")?;
            let rows=query.query_map([serde_json::to_string(ids)?],|r|Ok(ArchiveCandidate{id:r.get(0)?,name:r.get(1)?,raw_lines:r.get(2)?}))?;
            let games=rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((games.len()==ids.len()).then_some(games))
        })
    }
}

pub(super) fn archive_preview(conn: &Connection, game_id: &str) -> Result<Value> {
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM games WHERE id=?)",
        [game_id],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(json!({"not_found":true}));
    }
    Ok(conn.query_row("SELECT (SELECT count(*) FROM game_lines WHERE game_id=?1),
        coalesce(sum(line_count),0),coalesce(sum(character_count),0),min(first_timestamp),max(last_timestamp),
        max(archived_at),coalesce(sum(tokenized_lines),0) FROM archived_game_days WHERE game_id=?1",[game_id],|r|Ok(json!({
            "raw_lines":r.get::<_,i64>(0)?,"archived_lines":r.get::<_,i64>(1)?,"archived_characters":r.get::<_,i64>(2)?,
            "first_timestamp":r.get::<_,Option<f64>>(3)?,"last_timestamp":r.get::<_,Option<f64>>(4)?,
            "archived_at":r.get::<_,Option<f64>>(5)?,"tokenized_lines":r.get::<_,i64>(6)?
        })))?)
}

#[derive(Debug, Serialize)]
pub struct GameListEntry {
    pub name: String,
    pub sentence_count: i64,
    pub first_entry_date: String,
    pub last_entry_date: String,
    pub last_entry_timestamp: f64,
    pub total_characters: i64,
    pub date_range: String,
}

#[derive(Debug, Serialize)]
pub struct GamesListResponse {
    pub games: Vec<GameListEntry>,
}

pub fn games_list(tx: &Transaction<'_>) -> Result<GamesListResponse> {
    let mut stmt = tx.prepare(
        "SELECT
            game_name,
            COUNT(*) AS sentence_count,
            MIN(CAST(timestamp AS REAL)) AS first_timestamp,
            MAX(CAST(timestamp AS REAL)) AS last_timestamp,
            COALESCE(SUM(LENGTH(COALESCE(line_text, ''))), 0) AS total_characters
         FROM game_lines
         WHERE game_name IS NOT NULL AND game_name != ''
         GROUP BY game_name
         ORDER BY total_characters DESC, game_name COLLATE NOCASE ASC",
    )?;
    let mut rows = stmt.query([])?;
    let mut games = Vec::new();
    while let Some(row) = rows.next()? {
        let name: String = row.get(0)?;
        let sentence_count: i64 = row.get(1)?;
        let first_ts: f64 = row.get(2)?;
        let last_ts: f64 = row.get(3)?;
        let total_characters: i64 = row.get(4)?;
        let min_date = local_date(first_ts)?.format("%Y-%m-%d").to_string();
        let max_date = local_date(last_ts)?.format("%Y-%m-%d").to_string();
        let date_range = if min_date != max_date {
            format!("{min_date} to {max_date}")
        } else {
            min_date.clone()
        };
        games.push(GameListEntry {
            name,
            sentence_count,
            first_entry_date: min_date,
            last_entry_date: max_date,
            last_entry_timestamp: last_ts,
            total_characters,
            date_range,
        });
    }
    Ok(GamesListResponse { games })
}

#[derive(Debug, Deserialize)]
pub struct TextDeletionQuery {
    #[serde(default)]
    pub regex_pattern: Option<String>,
    #[serde(default)]
    pub exact_text: Vec<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub use_regex: bool,
}

enum TextFilter {
    Regex(RegexMatcher),
    Exact {
        case_sensitive: bool,
        targets: Vec<String>,
    },
    Empty,
}

impl TextFilter {
    fn compile(query: &TextDeletionQuery) -> Option<Self> {
        if let Some(pattern) = query.regex_pattern.as_deref().filter(|p| !p.is_empty()) {
            if query.use_regex {
                return RegexMatcher::compile(pattern, query.case_sensitive).map(Self::Regex);
            }
        }
        if !query.exact_text.is_empty() {
            let targets = if query.case_sensitive {
                query.exact_text.clone()
            } else {
                query.exact_text.iter().map(|t| t.to_lowercase()).collect()
            };
            return Some(Self::Exact {
                case_sensitive: query.case_sensitive,
                targets,
            });
        }
        Some(Self::Empty)
    }

    #[inline]
    fn matches(&self, text: &str) -> Result<bool> {
        Ok(match self {
            Self::Regex(matcher) => matcher.try_is_match(text)?,
            Self::Exact {
                case_sensitive,
                targets,
            } => {
                if *case_sensitive {
                    targets.iter().any(|t| text.contains(t.as_str()))
                } else {
                    let lower = text.to_lowercase();
                    targets.iter().any(|t| lower.contains(t.as_str()))
                }
            }
            Self::Empty => false,
        })
    }
}

impl TextDeletionQuery {
    pub fn preview(&self, tx: &Transaction<'_>) -> Result<Value> {
        let Some(filter) = TextFilter::compile(self) else {
            return Ok(json!({ "fallback": "invalidRegex" }));
        };
        if matches!(filter, TextFilter::Empty) {
            return Ok(json!({ "count": 0, "samples": [] }));
        }
        let mut stmt = tx.prepare(
            "SELECT line_text FROM game_lines WHERE line_text IS NOT NULL AND line_text != ''",
        )?;
        let mut rows = stmt.query([])?;
        let mut seen: HashSet<String> = HashSet::new();
        let mut samples: Vec<String> = Vec::with_capacity(PREVIEW_SAMPLE_LIMIT);
        while let Some(row) = rows.next()? {
            let ValueRef::Text(bytes) = row.get_ref(0)? else {
                continue;
            };
            let Ok(text) = std::str::from_utf8(bytes) else {
                continue;
            };
            if text.is_empty() || !filter.matches(text)? {
                continue;
            }
            if !seen.contains(text) {
                let owned = text.to_owned();
                if samples.len() < PREVIEW_SAMPLE_LIMIT {
                    samples.push(owned.clone());
                }
                seen.insert(owned);
            }
        }
        Ok(json!({
            "count": seen.len(),
            "samples": samples,
        }))
    }

    pub fn delete(&self, conn: &mut Connection) -> Result<Value> {
        let tx = conn.transaction()?;
        let deleted = self.delete_in(&tx)?;
        tx.commit()?;
        Ok(match deleted {
            Some(result) => {
                json!({"deleted_count": result.count, "affected_dates": result.dates, "failed_ids":[]})
            }
            None => json!({"fallback":"invalidRegex"}),
        })
    }

    fn delete_in(&self, tx: &Transaction<'_>) -> Result<Option<Deleted>> {
        let Some(filter) = TextFilter::compile(self) else {
            return Ok(None);
        };
        if matches!(filter, TextFilter::Empty) {
            return Ok(Some(Deleted::default()));
        }
        let mut rowids: Vec<i64> = Vec::new();
        {
            let mut stmt = tx.prepare(
                "SELECT rowid, line_text \
                 FROM game_lines WHERE line_text IS NOT NULL AND line_text != ''",
            )?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let ValueRef::Text(bytes) = row.get_ref(1)? else {
                    continue;
                };
                let Ok(text) = std::str::from_utf8(bytes) else {
                    continue;
                };
                if text.is_empty() || !filter.matches(text)? {
                    continue;
                }
                rowids.push(row.get(0)?);
            }
        }
        Ok(Some(delete_rowids(tx, &rowids)?))
    }
}

#[derive(Debug, Deserialize)]
pub struct DeduplicateQuery {
    pub games: Vec<String>,
    #[serde(default = "default_time_window_minutes")]
    pub time_window_minutes: f64,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub preserve_newest: bool,
    #[serde(default)]
    pub ignore_time_window: bool,
}

fn default_time_window_minutes() -> f64 {
    5.0
}

#[derive(Debug, Serialize)]
pub struct DuplicateSample {
    pub text: String,
    pub occurrences: usize,
}

#[derive(Debug, Serialize)]
pub struct PreviewDeduplicationResponse {
    pub duplicates_count: usize,
    pub games_affected: usize,
    pub samples: Vec<DuplicateSample>,
}

#[derive(Debug, Serialize)]
pub struct DeduplicateResponse {
    pub deleted_count: usize,
    pub failed_ids: Vec<String>,
}

fn build_dedup_select(games: &[String]) -> (String, Vec<rusqlite::types::Value>) {
    let all = games.iter().any(|g| g == "all");
    if all {
        (
            "SELECT rowid, COALESCE(NULLIF(game_name, ''), 'Unknown Game') AS g, \
                    line_text, COALESCE(CAST(timestamp AS REAL), 0.0) AS ts \
             FROM game_lines \
             ORDER BY g ASC, ts ASC, rowid ASC"
                .to_owned(),
            Vec::new(),
        )
    } else {
        let mut unique: Vec<&str> = Vec::with_capacity(games.len());
        let mut seen: HashSet<&str> = HashSet::with_capacity(games.len());
        for g in games {
            if seen.insert(g.as_str()) {
                unique.push(g.as_str());
            }
        }
        let mut sql = String::from(
            "SELECT rowid, COALESCE(NULLIF(game_name, ''), 'Unknown Game') AS g, \
                    line_text, COALESCE(CAST(timestamp AS REAL), 0.0) AS ts \
             FROM game_lines WHERE game_name IN (",
        );
        for i in 0..unique.len() {
            if i > 0 {
                sql.push(',');
            }
            sql.push('?');
        }
        sql.push_str(") ORDER BY g ASC, ts ASC, rowid ASC");
        let params = unique.into_iter().map(|g| g.to_owned().into()).collect();
        (sql, params)
    }
}

impl DeduplicateQuery {
    pub fn preview(&self, tx: &Transaction<'_>) -> Result<PreviewDeduplicationResponse> {
        if self.games.is_empty() {
            return Ok(PreviewDeduplicationResponse {
                duplicates_count: 0,
                games_affected: 0,
                samples: Vec::new(),
            });
        }
        let (sql, params) = build_dedup_select(&self.games);
        let time_window_seconds = self.time_window_minutes * 60.0;
        let mut stmt = tx.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(params.iter()))?;

        let mut current_game = String::new();
        let mut game_had_duplicate = false;
        let mut games_affected = 0usize;
        let mut duplicates_count = 0usize;
        let mut seen_all: HashSet<String> = HashSet::new();
        let mut last_seen: HashMap<String, f64> = HashMap::new();
        let mut samples: IndexMap<String, DuplicateSample> =
            IndexMap::with_capacity(PREVIEW_SAMPLE_LIMIT);

        while let Some(row) = rows.next()? {
            let row_game = match row.get_ref(1)? {
                ValueRef::Text(bytes) => std::str::from_utf8(bytes).unwrap_or("Unknown Game"),
                _ => "Unknown Game",
            };
            if row_game != current_game {
                current_game.clear();
                current_game.push_str(row_game);
                game_had_duplicate = false;
                seen_all.clear();
                last_seen.clear();
            }

            let ValueRef::Text(bytes) = row.get_ref(2)? else {
                continue;
            };
            let Ok(text) = std::str::from_utf8(bytes) else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            let ts = opt_f64(row.get_ref(3)?).unwrap_or(0.0);
            let norm: Cow<'_, str> = if self.case_sensitive {
                Cow::Borrowed(text)
            } else {
                Cow::Owned(text.to_lowercase())
            };

            let is_dup = if self.ignore_time_window {
                if seen_all.contains(norm.as_ref()) {
                    true
                } else {
                    seen_all.insert(norm.as_ref().to_owned());
                    false
                }
            } else if let Some(prev_ts) = last_seen.get_mut(norm.as_ref()) {
                let dup = ts - *prev_ts <= time_window_seconds;
                *prev_ts = ts;
                dup
            } else {
                last_seen.insert(norm.as_ref().to_owned(), ts);
                false
            };

            if is_dup {
                duplicates_count += 1;
                if !game_had_duplicate {
                    game_had_duplicate = true;
                    games_affected += 1;
                }
                if let Some(sample) = samples.get_mut(norm.as_ref()) {
                    sample.occurrences += 1;
                } else if samples.len() < PREVIEW_SAMPLE_LIMIT {
                    samples.insert(
                        norm.into_owned(),
                        DuplicateSample {
                            text: text.to_owned(),
                            occurrences: 2,
                        },
                    );
                }
            }
        }

        Ok(PreviewDeduplicationResponse {
            duplicates_count,
            games_affected,
            samples: samples.into_values().collect(),
        })
    }

    pub fn execute(&self, conn: &mut Connection) -> Result<DeduplicateResponse> {
        let tx = conn.transaction()?;
        let result = self.execute_in(&tx)?;
        tx.commit()?;
        Ok(DeduplicateResponse {
            deleted_count: result.count,
            failed_ids: Vec::new(),
        })
    }

    fn execute_in(&self, tx: &Transaction<'_>) -> Result<Deleted> {
        if self.games.is_empty() {
            return Ok(Deleted::default());
        }
        let (sql, params) = build_dedup_select(&self.games);
        let time_window_seconds = self.time_window_minutes * 60.0;
        let mut to_delete: Vec<i64> = Vec::new();
        {
            let mut stmt = tx.prepare(&sql)?;
            let mut rows = stmt.query(params_from_iter(params.iter()))?;

            let mut current_game = String::new();
            let mut seen_all: HashMap<String, i64> = HashMap::new();
            let mut kept_window: HashMap<String, (f64, i64)> = HashMap::new();

            while let Some(row) = rows.next()? {
                let rowid: i64 = row.get(0)?;
                let row_game = match row.get_ref(1)? {
                    ValueRef::Text(bytes) => std::str::from_utf8(bytes).unwrap_or("Unknown Game"),
                    _ => "Unknown Game",
                };
                if row_game != current_game {
                    current_game.clear();
                    current_game.push_str(row_game);
                    seen_all.clear();
                    kept_window.clear();
                }

                let ValueRef::Text(bytes) = row.get_ref(2)? else {
                    continue;
                };
                let Ok(text) = std::str::from_utf8(bytes) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                let ts = opt_f64(row.get_ref(3)?).unwrap_or(0.0);
                let norm: Cow<'_, str> = if self.case_sensitive {
                    Cow::Borrowed(text)
                } else {
                    Cow::Owned(text.to_lowercase())
                };

                if self.ignore_time_window {
                    if let Some(prev_rowid) = seen_all.get_mut(norm.as_ref()) {
                        if self.preserve_newest {
                            to_delete.push(*prev_rowid);
                            *prev_rowid = rowid;
                        } else {
                            to_delete.push(rowid);
                        }
                    } else {
                        seen_all.insert(norm.into_owned(), rowid);
                    }
                } else if let Some((prev_ts, prev_rowid)) = kept_window.get_mut(norm.as_ref()) {
                    if ts - *prev_ts <= time_window_seconds {
                        if self.preserve_newest {
                            to_delete.push(*prev_rowid);
                            *prev_ts = ts;
                            *prev_rowid = rowid;
                        } else {
                            to_delete.push(rowid);
                        }
                    } else {
                        *prev_ts = ts;
                        *prev_rowid = rowid;
                    }
                } else {
                    kept_window.insert(norm.into_owned(), (ts, rowid));
                }
            }
        }
        delete_rowids(tx, &to_delete)
    }
}

fn delete_rowids(tx: &Transaction<'_>, rowids: &[i64]) -> Result<Deleted> {
    let mut deleted = 0usize;
    let mut dates = BTreeSet::new();
    for chunk in rowids.chunks(DELETE_CHUNK_SIZE) {
        let mut sql = String::from("DELETE FROM game_lines WHERE rowid IN (");
        for i in 0..chunk.len() {
            if i > 0 {
                sql.push(',');
            }
            sql.push('?');
        }
        sql.push_str(") RETURNING timestamp");
        let mut stmt = tx.prepare_cached(&sql)?;
        let mut rows = stmt.query(params_from_iter(chunk.iter()))?;
        while let Some(row) = rows.next()? {
            deleted += 1;
            if let Some(date) = opt_f64(row.get_ref(0)?).and_then(|ts| local_date(ts).ok()) {
                dates.insert(date);
            }
        }
    }
    Ok(Deleted {
        count: deleted,
        dates,
        failed_ids: Vec::new(),
    })
}

fn delete_selected(tx: &mut Transaction<'_>, ids: Vec<String>) -> Result<Deleted> {
    let mut unique = HashSet::new();
    let ids: Vec<_> = ids
        .iter()
        .map(String::as_str)
        .filter(|id| !id.is_empty() && unique.insert(*id))
        .collect();
    let mut result = Deleted::default();
    for chunk in ids.chunks(DELETE_CHUNK_SIZE) {
        match delete_selected_chunk(tx, chunk) {
            Ok(dates) => {
                // Successful statements count the requested unique IDs, including
                // rows already removed by a previous request.
                result.count += chunk.len();
                result.dates.extend(dates);
            }
            Err(_) if !tx.is_autocommit() => {
                for id in chunk {
                    match delete_selected_chunk(tx, std::slice::from_ref(id)) {
                        Ok(dates) => {
                            result.count += 1;
                            result.dates.extend(dates);
                        }
                        Err(_) if !tx.is_autocommit() => result.failed_ids.push((*id).into()),
                        Err(error) => return Err(error),
                    }
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}

fn delete_selected_chunk(
    tx: &mut Transaction<'_>,
    ids: &[&str],
) -> Result<BTreeSet<chrono::NaiveDate>> {
    let savepoint = tx.savepoint()?;
    let mut dates = BTreeSet::new();
    {
        let mut stmt = savepoint.prepare_cached("DELETE FROM game_lines WHERE id IN (SELECT value FROM json_each(?)) RETURNING timestamp")?;
        let mut rows = stmt.query([serde_json::to_string(ids)?])?;
        while let Some(row) = rows.next()? {
            if let Some(date) = opt_f64(row.get_ref(0)?).and_then(|ts| local_date(ts).ok()) {
                dates.insert(date);
            }
        }
    }
    savepoint.commit()?;
    Ok(dates)
}

fn opt_f64(val: ValueRef<'_>) -> Option<f64> {
    match val {
        ValueRef::Null => None,
        ValueRef::Real(f) => Some(f),
        ValueRef::Integer(i) => Some(i as f64),
        ValueRef::Text(bytes) => std::str::from_utf8(bytes).ok()?.parse::<f64>().ok(),
        ValueRef::Blob(_) => None,
    }
}
