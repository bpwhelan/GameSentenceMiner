use crate::Result;
use rusqlite::{params_from_iter, types::ValueRef, Connection, Row, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

const SEARCH_RESULT_TEXT_MAX_LENGTH: usize = 4000;
const REGEX_MAX_CHARS: usize = 500;
const HYDRATE_CHUNK_SIZE: usize = 500;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    #[default]
    Relevance,
    DateDesc,
    DateAsc,
    GameName,
    LengthDesc,
    LengthAsc,
    LastSeenDesc,
    LastSeenAsc,
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct SentenceQuery {
    pub query: String,
    #[serde(default)]
    pub game: Option<String>,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
    #[serde(default)]
    pub sort: SortBy,
    pub page: usize,
    pub page_size: usize,
    #[serde(default)]
    pub use_regex: bool,
    #[serde(default)]
    pub use_tokenized: bool,
}

#[derive(Debug, Deserialize)]
pub struct DuplicateQuery {
    #[serde(default)]
    pub game: Option<String>,
    #[serde(default = "default_time_window_minutes")]
    pub time_window_minutes: f64,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub ignore_time_window: bool,
}

fn default_time_window_minutes() -> f64 {
    5.0
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub id: String,
    pub sentence: String,
    pub sentence_length: usize,
    pub sentence_truncated: bool,
    pub game_name: String,
    pub timestamp: Value,
    pub translation: Option<String>,
    pub has_audio: bool,
    pub has_screenshot: bool,
}

#[derive(Debug, Serialize)]
pub struct SearchPage {
    pub results: Vec<SearchResult>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    pub total_pages: usize,
}

#[derive(Debug, Serialize)]
pub struct DuplicateResponse {
    pub results: Vec<SearchResult>,
    pub total: usize,
    pub duplicates_found: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_mode: Option<&'static str>,
}

pub(crate) enum RegexMatcher {
    Fast(regex::Regex),
    Fancy(fancy_regex::Regex),
}

impl RegexMatcher {
    pub(crate) fn compile(pattern: &str, case_sensitive: bool) -> Option<Self> {
        if let Ok(re) = regex::RegexBuilder::new(pattern)
            .case_insensitive(!case_sensitive)
            .build()
        {
            return Some(Self::Fast(re));
        }
        let fancy_pattern = if case_sensitive {
            Cow::Borrowed(pattern)
        } else {
            Cow::Owned(format!("(?i){pattern}"))
        };
        fancy_regex::RegexBuilder::new(&fancy_pattern)
            .build()
            .ok()
            .map(Self::Fancy)
    }

    #[inline]
    pub(crate) fn is_match(&self, text: &str) -> bool {
        self.try_is_match(text).unwrap_or(false)
    }

    pub(crate) fn try_is_match(&self,text:&str) -> fancy_regex::Result<bool> {
        match self {
            Self::Fast(re) => Ok(re.is_match(text)),
            Self::Fancy(re) => re.is_match(text),
        }
    }
}

/// Match SQLite's default `LIKE '%needle%'` semantics (ASCII case-insensitive,
/// non-ASCII byte-exact) when `needle` contains no `%` or `_` wildcards.
struct SubstringMatcher<'a> {
    needle: &'a str,
    lower_ascii: Option<Vec<u8>>,
}

impl<'a> SubstringMatcher<'a> {
    fn new(needle: &'a str) -> Self {
        let lower_ascii = if needle.bytes().any(|b| b.is_ascii_alphabetic()) {
            Some(needle.bytes().map(|b| b.to_ascii_lowercase()).collect())
        } else {
            None
        };
        Self {
            needle,
            lower_ascii,
        }
    }

    #[inline]
    fn is_match(&self, haystack: &str) -> bool {
        let Some(ref needle) = self.lower_ascii else {
            return haystack.contains(self.needle);
        };
        let hay = haystack.as_bytes();
        let nlen = needle.len();
        if nlen == 0 {
            return true;
        }
        if hay.len() < nlen {
            return false;
        }
        let first = needle[0];
        let first_upper = first.to_ascii_uppercase();
        let limit = hay.len() - nlen;
        let mut i = 0;
        while i <= limit {
            let b = hay[i];
            if (b == first || b == first_upper)
                && hay[i..i + nlen]
                    .iter()
                    .zip(needle.iter())
                    .all(|(h, n)| h.to_ascii_lowercase() == *n)
            {
                return true;
            }
            i += 1;
        }
        false
    }
}

fn truncate_sentence(raw: &str) -> (String, usize, bool) {
    if raw.len() <= SEARCH_RESULT_TEXT_MAX_LENGTH {
        let char_len = raw.chars().count();
        return (raw.to_owned(), char_len, false);
    }
    let mut split_byte = None;
    let mut char_len = 0usize;
    for (byte_idx, _) in raw.char_indices() {
        if char_len == SEARCH_RESULT_TEXT_MAX_LENGTH {
            split_byte = Some(byte_idx);
        }
        char_len += 1;
    }
    match split_byte {
        Some(idx) => (raw[..idx].to_owned(), char_len, true),
        None => (raw.to_owned(), char_len, false),
    }
}

fn value_to_string(val: ValueRef<'_>) -> String {
    match val {
        ValueRef::Null => String::new(),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Blob(bytes) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

fn value_to_f64(val: ValueRef<'_>) -> f64 {
    match val {
        ValueRef::Null => 0.0,
        ValueRef::Real(f) => f,
        ValueRef::Integer(i) => i as f64,
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0),
        ValueRef::Blob(_) => 0.0,
    }
}

fn value_is_truthy_str(val: ValueRef<'_>) -> bool {
    match val {
        ValueRef::Null => false,
        ValueRef::Text(bytes) => !bytes.is_empty(),
        ValueRef::Blob(bytes) => !bytes.is_empty(),
        ValueRef::Integer(i) => i != 0,
        ValueRef::Real(f) => f != 0.0,
    }
}

fn serialize_timestamp(ts: f64) -> Value {
    if ts == 0.0 || !ts.is_finite() {
        json!(0)
    } else {
        json!(ts)
    }
}

fn search_result_from_row(row: &Row<'_>, offset: usize) -> rusqlite::Result<SearchResult> {
    let id = value_to_string(row.get_ref(offset)?);
    let raw_sentence = value_to_string(row.get_ref(offset + 1)?);
    let (sentence, sentence_length, sentence_truncated) = truncate_sentence(&raw_sentence);
    let raw_game = value_to_string(row.get_ref(offset + 2)?);
    let game_name = if raw_game.is_empty() {
        "Unknown Game".to_owned()
    } else {
        raw_game
    };
    let ts = value_to_f64(row.get_ref(offset + 3)?);
    let raw_translation = value_to_string(row.get_ref(offset + 4)?);
    let translation = if raw_translation.is_empty() {
        None
    } else {
        Some(raw_translation)
    };
    let has_audio = value_is_truthy_str(row.get_ref(offset + 5)?);
    let has_screenshot = value_is_truthy_str(row.get_ref(offset + 6)?);
    Ok(SearchResult {
        id,
        sentence,
        sentence_length,
        sentence_truncated,
        game_name,
        timestamp: serialize_timestamp(ts),
        translation,
        has_audio,
        has_screenshot,
    })
}

fn hydrate_by_rowids(conn: &Connection, rowids: &[i64]) -> Result<Vec<SearchResult>> {
    if rowids.is_empty() {
        return Ok(Vec::new());
    }
    let mut by_rowid: HashMap<i64, SearchResult> = HashMap::with_capacity(rowids.len());
    for chunk in rowids.chunks(HYDRATE_CHUNK_SIZE) {
        let mut sql = String::from(
            "SELECT rowid, id, line_text, game_name, timestamp, translation, audio_path, screenshot_path \
             FROM game_lines WHERE rowid IN (",
        );
        for i in 0..chunk.len() {
            if i > 0 {
                sql.push(',');
            }
            sql.push('?');
        }
        sql.push(')');
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(chunk.iter().copied()))?;
        while let Some(row) = rows.next()? {
            let rowid: i64 = row.get(0)?;
            let item = search_result_from_row(row, 1)?;
            by_rowid.insert(rowid, item);
        }
    }
    let mut ordered = Vec::with_capacity(rowids.len());
    for rowid in rowids {
        if let Some(item) = by_rowid.remove(rowid) {
            ordered.push(item);
        }
    }
    Ok(ordered)
}

fn total_pages(total: usize, page_size: usize) -> usize {
    if total == 0 || page_size == 0 {
        0
    } else {
        total.div_ceil(page_size)
    }
}

fn select_page<T, F>(items: &mut [T], offset: usize, page_size: usize, mut cmp: F) -> &[T]
where
    F: FnMut(&T, &T) -> Ordering,
{
    let total = items.len();
    if offset >= total || page_size == 0 {
        return &[];
    }
    let end = offset.saturating_add(page_size).min(total);
    if end < total {
        items.select_nth_unstable_by(end, &mut cmp);
    }
    let prefix = &mut items[..end];
    if offset > 0 {
        prefix.select_nth_unstable_by(offset, &mut cmp);
    }
    let page = &mut prefix[offset..end];
    page.sort_unstable_by(cmp);
    page
}

impl SentenceQuery {
    pub fn run(&self, tx: &Transaction<'_>) -> Result<Value> {
        let page = self.page.max(1);
        let page_size = self.page_size.clamp(1, 100_000_000);
        let game = self.game.as_deref().filter(|g| !g.is_empty());

        if self.use_tokenized {
            match self.run_tokenized(tx, game, page, page_size) {
                Ok(result) => return Ok(serde_json::to_value(result)?),
                Err(TokenizedError::SchemaMissing) => {
                    // Fall through to LIKE/regex search, matching Python behavior.
                }
                Err(TokenizedError::Other(err)) => return Err(err),
            }
        }

        let (use_regex, query): (bool, &str) =
            if self.use_regex && (self.query == ".*" || self.query == "^.*$") {
                (false, "")
            } else {
                (self.use_regex, self.query.as_str())
            };

        if use_regex {
            if query.chars().count() > REGEX_MAX_CHARS {
                return Ok(json!({ "fallback": "regexTooLong" }));
            }
            let Some(matcher) = RegexMatcher::compile(query, false) else {
                return Ok(json!({ "fallback": "invalidRegex" }));
            };
            let result = self.run_regex(tx, &matcher, game, page, page_size)?;
            return Ok(serde_json::to_value(result)?);
        }

        let result = self.run_like(tx, query, game, page, page_size)?;
        Ok(serde_json::to_value(result)?)
    }

    fn run_tokenized(
        &self,
        tx: &Transaction<'_>,
        game: Option<&str>,
        page: usize,
        page_size: usize,
    ) -> std::result::Result<SearchPage, TokenizedError> {
        let word_id: Option<i64> = match tx.query_row(
            "SELECT id FROM words WHERE word = ?1 LIMIT 1",
            [self.query.as_str()],
            |row| row.get(0),
        ) {
            Ok(id) => Some(id),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(err) if is_schema_error(&err) => return Err(TokenizedError::SchemaMissing),
            Err(err) => return Err(TokenizedError::Other(err.into())),
        };

        let Some(word_id) = word_id else {
            return Ok(SearchPage {
                results: Vec::new(),
                total: 0,
                page,
                page_size,
                total_pages: 0,
            });
        };

        let mut where_sql = String::from("WHERE wo.word_id = ?");
        let mut params: Vec<rusqlite::types::Value> = vec![word_id.into()];
        if let Some(g) = game {
            where_sql.push_str(" AND gl.game_name = ?");
            params.push(g.to_owned().into());
        }
        if let Some(start) = self.start {
            where_sql.push_str(" AND CAST(gl.timestamp AS REAL) >= ?");
            params.push(start.into());
        }
        if let Some(end) = self.end {
            where_sql.push_str(" AND CAST(gl.timestamp AS REAL) <= ?");
            params.push(end.into());
        }

        let count_sql = format!(
            "SELECT COUNT(*) FROM game_lines gl \
             INNER JOIN word_occurrences wo ON gl.id = wo.line_id {where_sql}"
        );
        let total: usize = match tx.query_row(&count_sql, params_from_iter(params.iter()), |row| {
            row.get::<_, i64>(0)
        }) {
            Ok(c) => c.max(0) as usize,
            Err(err) if is_schema_error(&err) => return Err(TokenizedError::SchemaMissing),
            Err(err) => return Err(TokenizedError::Other(err.into())),
        };

        let offset = page.saturating_sub(1).saturating_mul(page_size);
        if total == 0 || offset >= total {
            return Ok(SearchPage {
                results: Vec::new(),
                total,
                page,
                page_size,
                total_pages: total_pages(total, page_size),
            });
        }

        let order_sql = match self.sort {
            SortBy::LastSeenDesc => {
                "ORDER BY (SELECT COALESCE(w.last_seen, 0) FROM words w WHERE w.id = wo.word_id) DESC"
            }
            SortBy::LastSeenAsc => {
                "ORDER BY (SELECT COALESCE(w.last_seen, 0) FROM words w WHERE w.id = wo.word_id) ASC"
            }
            SortBy::DateAsc => "ORDER BY gl.timestamp ASC",
            SortBy::GameName => "ORDER BY gl.game_name, gl.timestamp DESC",
            SortBy::LengthDesc => "ORDER BY LENGTH(gl.line_text) DESC",
            SortBy::LengthAsc => "ORDER BY LENGTH(gl.line_text) ASC",
            SortBy::DateDesc | SortBy::Relevance | SortBy::Other => "ORDER BY gl.timestamp DESC",
        };

        let select_sql = format!(
            "SELECT gl.id, gl.line_text, gl.game_name, gl.timestamp, gl.translation, gl.audio_path, gl.screenshot_path \
             FROM game_lines gl INNER JOIN word_occurrences wo ON gl.id = wo.line_id \
             {where_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        params.push((page_size as i64).into());
        params.push((offset as i64).into());

        let mut stmt = tx.prepare(&select_sql).map_err(|err| {
            if is_schema_error(&err) {
                TokenizedError::SchemaMissing
            } else {
                TokenizedError::Other(err.into())
            }
        })?;
        let mut rows = stmt
            .query(params_from_iter(params.iter()))
            .map_err(|err| TokenizedError::Other(err.into()))?;
        let mut results = Vec::with_capacity(page_size.min(total - offset));
        while let Some(row) = rows.next().map_err(|err| TokenizedError::Other(err.into()))? {
            results.push(
                search_result_from_row(row, 0).map_err(|err| TokenizedError::Other(err.into()))?,
            );
        }

        Ok(SearchPage {
            results,
            total,
            page,
            page_size,
            total_pages: total_pages(total, page_size),
        })
    }

    fn run_regex(
        &self,
        tx: &Transaction<'_>,
        matcher: &RegexMatcher,
        game: Option<&str>,
        page: usize,
        page_size: usize,
    ) -> Result<SearchPage> {
        self.run_streaming_filter(tx, game, page, page_size, true, |text| {
            matcher.is_match(text)
        })
    }

    fn run_streaming_filter<F>(
        &self,
        tx: &Transaction<'_>,
        game: Option<&str>,
        page: usize,
        page_size: usize,
        skip_zero_ts_on_date_filter: bool,
        mut matches: F,
    ) -> Result<SearchPage>
    where
        F: FnMut(&str) -> bool,
    {
        let mut where_sql = String::from("WHERE line_text IS NOT NULL AND line_text != ''");
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(g) = game {
            where_sql.push_str(" AND game_name = ?");
            params.push(g.to_owned().into());
        }
        if self.start.is_some() || self.end.is_some() {
            if skip_zero_ts_on_date_filter {
                where_sql.push_str(
                    " AND timestamp IS NOT NULL AND timestamp != '' AND CAST(timestamp AS REAL) != 0.0",
                );
            }
            if let Some(start) = self.start {
                where_sql.push_str(" AND CAST(timestamp AS REAL) >= ?");
                params.push(start.into());
            }
            if let Some(end) = self.end {
                where_sql.push_str(" AND CAST(timestamp AS REAL) <= ?");
                params.push(end.into());
            }
        }

        let offset = page.saturating_sub(1).saturating_mul(page_size);
        let (total, page_rowids) = match self.sort {
            SortBy::GameName => {
                let sql = format!(
                    "SELECT rowid, line_text, COALESCE(game_name, ''), COALESCE(CAST(timestamp AS REAL), 0.0) \
                     FROM game_lines {where_sql}"
                );
                let mut stmt = tx.prepare(&sql)?;
                let mut rows = stmt.query(params_from_iter(params.iter()))?;
                let mut hits: Vec<(String, f64, i64)> = Vec::new();
                while let Some(row) = rows.next()? {
                    let ValueRef::Text(bytes) = row.get_ref(1)? else {
                        continue;
                    };
                    let Ok(text) = std::str::from_utf8(bytes) else {
                        continue;
                    };
                    if text.is_empty() || !matches(text) {
                        continue;
                    }
                    let rowid: i64 = row.get(0)?;
                    let g = value_to_string(row.get_ref(2)?);
                    let ts = value_to_f64(row.get_ref(3)?);
                    hits.push((g, ts, rowid));
                }
                let total = hits.len();
                let selected = select_page(&mut hits, offset, page_size, |a, b| {
                    a.0.cmp(&b.0)
                        .then_with(|| b.1.total_cmp(&a.1))
                        .then_with(|| a.2.cmp(&b.2))
                });
                let rowids = selected.iter().map(|h| h.2).collect::<Vec<_>>();
                (total, rowids)
            }
            SortBy::LengthDesc | SortBy::LengthAsc => {
                let sql = format!("SELECT rowid, line_text FROM game_lines {where_sql}");
                let mut stmt = tx.prepare(&sql)?;
                let mut rows = stmt.query(params_from_iter(params.iter()))?;
                let mut hits: Vec<(usize, i64)> = Vec::new();
                while let Some(row) = rows.next()? {
                    let ValueRef::Text(bytes) = row.get_ref(1)? else {
                        continue;
                    };
                    let Ok(text) = std::str::from_utf8(bytes) else {
                        continue;
                    };
                    if text.is_empty() || !matches(text) {
                        continue;
                    }
                    let rowid: i64 = row.get(0)?;
                    hits.push((text.chars().count(), rowid));
                }
                let total = hits.len();
                let desc = self.sort == SortBy::LengthDesc;
                let selected = select_page(&mut hits, offset, page_size, |a, b| {
                    let primary = if desc { b.0.cmp(&a.0) } else { a.0.cmp(&b.0) };
                    primary.then_with(|| a.1.cmp(&b.1))
                });
                let rowids = selected.iter().map(|h| h.1).collect::<Vec<_>>();
                (total, rowids)
            }
            SortBy::DateAsc
            | SortBy::DateDesc
            | SortBy::Relevance
            | SortBy::LastSeenDesc
            | SortBy::LastSeenAsc
            | SortBy::Other => {
                let sql = format!(
                    "SELECT rowid, line_text, COALESCE(CAST(timestamp AS REAL), 0.0) \
                     FROM game_lines {where_sql}"
                );
                let mut stmt = tx.prepare(&sql)?;
                let mut rows = stmt.query(params_from_iter(params.iter()))?;
                let mut hits: Vec<(f64, i64)> = Vec::new();
                while let Some(row) = rows.next()? {
                    let ValueRef::Text(bytes) = row.get_ref(1)? else {
                        continue;
                    };
                    let Ok(text) = std::str::from_utf8(bytes) else {
                        continue;
                    };
                    if text.is_empty() || !matches(text) {
                        continue;
                    }
                    let rowid: i64 = row.get(0)?;
                    let ts = value_to_f64(row.get_ref(2)?);
                    hits.push((ts, rowid));
                }
                let total = hits.len();
                let asc = self.sort == SortBy::DateAsc;
                let selected = select_page(&mut hits, offset, page_size, |a, b| {
                    let primary = if asc {
                        a.0.total_cmp(&b.0)
                    } else {
                        b.0.total_cmp(&a.0)
                    };
                    primary.then_with(|| a.1.cmp(&b.1))
                });
                let rowids = selected.iter().map(|h| h.1).collect::<Vec<_>>();
                (total, rowids)
            }
        };

        let results = hydrate_by_rowids(tx, &page_rowids)?;
        Ok(SearchPage {
            results,
            total,
            page,
            page_size,
            total_pages: total_pages(total, page_size),
        })
    }

    fn run_like(
        &self,
        tx: &Transaction<'_>,
        query: &str,
        game: Option<&str>,
        page: usize,
        page_size: usize,
    ) -> Result<SearchPage> {
        // Avoid two full-table SQLite LIKE scans (COUNT + ORDER BY) when the
        // query has no SQLite wildcards by scanning once in Rust.
        if !query.is_empty() && !query.contains('%') && !query.contains('_') {
            let matcher = SubstringMatcher::new(query);
            return self.run_streaming_filter(tx, game, page, page_size, false, |text| {
                matcher.is_match(text)
            });
        }
        let mut where_sql = String::from("WHERE ");
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        if query.is_empty() {
            where_sql.push_str("line_text IS NOT NULL AND line_text != ''");
        } else {
            where_sql.push_str("line_text LIKE ?");
            params.push(format!("%{query}%").into());
        }
        if let Some(g) = game {
            where_sql.push_str(" AND game_name = ?");
            params.push(g.to_owned().into());
        }
        if let Some(start) = self.start {
            where_sql.push_str(" AND CAST(timestamp AS REAL) >= ?");
            params.push(start.into());
        }
        if let Some(end) = self.end {
            where_sql.push_str(" AND CAST(timestamp AS REAL) <= ?");
            params.push(end.into());
        }

        let count_sql = format!("SELECT COUNT(*) FROM game_lines {where_sql}");
        let total: usize = tx
            .query_row(&count_sql, params_from_iter(params.iter()), |row| {
                row.get::<_, i64>(0)
            })?
            .max(0) as usize;

        let offset = page.saturating_sub(1).saturating_mul(page_size);
        if total == 0 || offset >= total {
            return Ok(SearchPage {
                results: Vec::new(),
                total,
                page,
                page_size,
                total_pages: total_pages(total, page_size),
            });
        }

        let order_sql = match self.sort {
            SortBy::DateDesc => "ORDER BY CAST(timestamp AS REAL) DESC",
            SortBy::DateAsc => "ORDER BY CAST(timestamp AS REAL) ASC",
            SortBy::GameName => "ORDER BY game_name, timestamp DESC",
            SortBy::LengthDesc => "ORDER BY LENGTH(line_text) DESC",
            SortBy::LengthAsc => "ORDER BY LENGTH(line_text) ASC",
            SortBy::Relevance | SortBy::LastSeenDesc | SortBy::LastSeenAsc | SortBy::Other => {
                "ORDER BY timestamp DESC"
            }
        };

        let select_sql = format!(
            "SELECT id, line_text, game_name, timestamp, translation, audio_path, screenshot_path \
             FROM game_lines {where_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        params.push((page_size as i64).into());
        params.push((offset as i64).into());

        let mut stmt = tx.prepare(&select_sql)?;
        let mut rows = stmt.query(params_from_iter(params.iter()))?;
        let mut results = Vec::with_capacity(page_size.min(total - offset));
        while let Some(row) = rows.next()? {
            results.push(search_result_from_row(row, 0)?);
        }

        Ok(SearchPage {
            results,
            total,
            page,
            page_size,
            total_pages: total_pages(total, page_size),
        })
    }
}

impl DuplicateQuery {
    pub fn run(&self, tx: &Transaction<'_>) -> Result<DuplicateResponse> {
        let game = self.game.as_deref().filter(|g| !g.is_empty());
        let (sql, params): (&str, Vec<rusqlite::types::Value>) = match game {
            Some(g) => (
                "SELECT rowid, COALESCE(NULLIF(game_name, ''), 'Unknown Game') AS g, \
                        line_text, COALESCE(CAST(timestamp AS REAL), 0.0) AS ts \
                 FROM game_lines WHERE game_name = ?1 \
                 ORDER BY g ASC, ts ASC, rowid ASC",
                vec![g.to_owned().into()],
            ),
            None => (
                "SELECT rowid, COALESCE(NULLIF(game_name, ''), 'Unknown Game') AS g, \
                        line_text, COALESCE(CAST(timestamp AS REAL), 0.0) AS ts \
                 FROM game_lines \
                 ORDER BY g ASC, ts ASC, rowid ASC",
                Vec::new(),
            ),
        };

        let time_window_seconds = self.time_window_minutes * 60.0;
        let mut stmt = tx.prepare(sql)?;
        let mut rows = stmt.query(params_from_iter(params.iter()))?;

        let mut has_any_rows = false;
        let mut current_game = String::new();
        let mut seen_all: HashSet<String> = HashSet::new();
        let mut last_seen: HashMap<String, f64> = HashMap::new();
        let mut duplicates: Vec<(String, f64, i64)> = Vec::new();

        while let Some(row) = rows.next()? {
            has_any_rows = true;
            let rowid: i64 = row.get(0)?;
            let row_game = match row.get_ref(1)? {
                ValueRef::Text(bytes) => std::str::from_utf8(bytes).unwrap_or("Unknown Game"),
                _ => "Unknown Game",
            };
            if row_game != current_game {
                current_game.clear();
                current_game.push_str(row_game);
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

            let ts = value_to_f64(row.get_ref(3)?);
            let norm: Cow<'_, str> = if self.case_sensitive {
                Cow::Borrowed(text)
            } else {
                Cow::Owned(text.to_lowercase())
            };

            if self.ignore_time_window {
                if seen_all.contains(norm.as_ref()) {
                    duplicates.push((norm.into_owned(), ts, rowid));
                } else {
                    seen_all.insert(norm.into_owned());
                }
            } else {
                if let Some(prev_ts) = last_seen.get_mut(norm.as_ref()) {
                    if ts - *prev_ts <= time_window_seconds {
                        duplicates.push((norm.into_owned(), ts, rowid));
                    }
                    *prev_ts = ts;
                } else {
                    last_seen.insert(norm.into_owned(), ts);
                }
            }
        }

        if !has_any_rows {
            return Ok(DuplicateResponse {
                results: Vec::new(),
                total: 0,
                duplicates_found: 0,
                search_mode: None,
            });
        }

        duplicates.sort_unstable_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.total_cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
        });

        let rowids: Vec<i64> = duplicates.iter().map(|d| d.2).collect();
        let results = hydrate_by_rowids(tx, &rowids)?;
        let count = results.len();
        Ok(DuplicateResponse {
            results,
            total: count,
            duplicates_found: count,
            search_mode: Some("duplicates"),
        })
    }
}

enum TokenizedError {
    SchemaMissing,
    Other(Box<dyn std::error::Error + Send + Sync>),
}

fn is_schema_error(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(_, Some(msg)) => {
            msg.contains("no such table") || msg.contains("no such column")
        }
        _ => false,
    }
}
