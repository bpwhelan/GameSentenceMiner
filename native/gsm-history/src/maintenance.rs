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
                query
                    .exact_text
                    .iter()
                    .map(|t| t.to_lowercase())
                    .collect()
            };
            return Some(Self::Exact {
                case_sensitive: query.case_sensitive,
                targets,
            });
        }
        Some(Self::Empty)
    }

    #[inline]
    fn matches(&self, text: &str) -> bool {
        match self {
            Self::Regex(matcher) => matcher.is_match(text),
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
        }
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
        let mut stmt =
            tx.prepare("SELECT line_text FROM game_lines WHERE line_text IS NOT NULL AND line_text != ''")?;
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
            if text.is_empty() || !filter.matches(text) {
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
        let Some(filter) = TextFilter::compile(self) else {
            return Ok(json!({ "fallback": "invalidRegex" }));
        };
        if matches!(filter, TextFilter::Empty) {
            return Ok(json!({
                "deleted_count": 0,
                "failed_ids": [],
                "affected_dates": [],
            }));
        }
        let tx = conn.transaction()?;
        let mut rowids: Vec<i64> = Vec::new();
        let mut affected_dates: BTreeSet<String> = BTreeSet::new();
        {
            let mut stmt = tx.prepare(
                "SELECT rowid, line_text, timestamp \
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
                if text.is_empty() || !filter.matches(text) {
                    continue;
                }
                rowids.push(row.get(0)?);
                if let Some(ts) = opt_f64(row.get_ref(2)?) {
                    if let Ok(date) = local_date(ts) {
                        affected_dates.insert(date.format("%Y-%m-%d").to_string());
                    }
                }
            }
        }
        let deleted_count = delete_rowids(&tx, &rowids)?;
        tx.commit()?;
        Ok(json!({
            "deleted_count": deleted_count,
            "failed_ids": [],
            "affected_dates": affected_dates.into_iter().collect::<Vec<_>>(),
        }))
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
        if self.games.is_empty() {
            return Ok(DeduplicateResponse {
                deleted_count: 0,
                failed_ids: Vec::new(),
            });
        }
        let tx = conn.transaction()?;
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
        let deleted_count = delete_rowids(&tx, &to_delete)?;
        tx.commit()?;
        Ok(DeduplicateResponse {
            deleted_count,
            failed_ids: Vec::new(),
        })
    }
}

fn delete_rowids(tx: &Transaction<'_>, rowids: &[i64]) -> Result<usize> {
    if rowids.is_empty() {
        return Ok(0);
    }
    let mut deleted = 0usize;
    for chunk in rowids.chunks(DELETE_CHUNK_SIZE) {
        let mut sql = String::from("DELETE FROM game_lines WHERE rowid IN (");
        for i in 0..chunk.len() {
            if i > 0 {
                sql.push(',');
            }
            sql.push('?');
        }
        sql.push(')');
        deleted += tx.execute(&sql, params_from_iter(chunk.iter().copied()))?;
    }
    Ok(deleted)
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
