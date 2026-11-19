use crate::{anki_notes, kanji::is_kanji, Result};
use chrono::{DateTime, Local, NaiveDate, NaiveTime, TimeZone};
use rusqlite::{params, params_from_iter, types::ValueRef, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
};

const WORD_STATS_CACHE_TABLE: &str = "word_stats_cache";
const VOCAB_ONLY_EXCLUDED_POS: &[&str] = &["助詞", "助動詞", "フィラー", "接頭詞", "連体詞"];
const VOCAB_ONLY_EXCLUDED_WORDS: &[&str] = &["こと", "よう", "もの"];
const CJK_WORD_GLOB_PATTERN: &str = "*[一-龯㐀-䶿ぁ-ゖゝゞァ-ヺーｦ-ﾟ가-힣]*";
const UNKNOWN_GAME_LABEL: &str = "Unknown game";

pub(crate) fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

pub(crate) fn has_archives(conn: &Connection) -> bool {
    table_exists(conn, "archived_game_days")
        && conn
            .query_row("SELECT 1 FROM archived_game_days LIMIT 1", [], |_| Ok(()))
            .is_ok()
}

fn has_word_stats_cache(conn: &Connection) -> bool {
    table_exists(conn, WORD_STATS_CACHE_TABLE) && !has_archives(conn)
}

fn word_occurrence_source(archived: bool) -> &'static str {
    if archived {
        "SELECT wo.word_id, gl.game_id, gl.game_name, CAST(gl.timestamp AS REAL) AS timestamp, \
                gl.tokenized, 1 AS frequency \
         FROM word_occurrences wo JOIN game_lines gl ON gl.id = wo.line_id \
         UNION ALL \
         SELECT a.word_id, a.game_id, d.game_name, a.first_seen, 1, a.frequency \
         FROM archived_word_stats a JOIN archived_game_days d \
         ON d.game_id = a.game_id AND d.date = a.date"
    } else {
        "SELECT wo.word_id, gl.game_id, gl.game_name, CAST(gl.timestamp AS REAL) AS timestamp, \
                gl.tokenized, 1 AS frequency \
         FROM word_occurrences wo JOIN game_lines gl ON gl.id = wo.line_id"
    }
}

fn kanji_occurrence_source(archived: bool) -> &'static str {
    if archived {
        "SELECT k.character, gl.game_id, CAST(gl.timestamp AS REAL) AS timestamp, 1 AS frequency \
         FROM kanji_occurrences ko JOIN kanji k ON k.id = ko.kanji_id \
         JOIN game_lines gl ON gl.id = ko.line_id \
         UNION ALL \
         SELECT j.key, d.game_id, d.first_timestamp, j.value \
         FROM archived_game_days d, json_each(d.token_kanji) j"
    } else {
        "SELECT k.character, gl.game_id, CAST(gl.timestamp AS REAL) AS timestamp, 1 AS frequency \
         FROM kanji_occurrences ko JOIN kanji k ON k.id = ko.kanji_id \
         JOIN game_lines gl ON gl.id = ko.line_id"
    }
}

fn expand_pos_shorthand(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "content" => out.extend(
                ["名詞", "動詞", "形容詞", "副詞"]
                    .iter()
                    .map(|s| (*s).to_owned()),
            ),
            "particles" => out.extend(["助詞", "助動詞"].iter().map(|s| (*s).to_owned())),
            _ => out.push(part.to_owned()),
        }
    }
    out
}

fn opt_i64(val: ValueRef<'_>) -> Option<i64> {
    match val {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i),
        ValueRef::Real(f) => Some(f as i64),
        ValueRef::Text(bytes) => {
            let s = std::str::from_utf8(bytes).ok()?.trim();
            if s.is_empty() {
                None
            } else {
                s.parse::<i64>()
                    .ok()
                    .or_else(|| s.parse::<f64>().ok().map(|f| f as i64))
            }
        }
        ValueRef::Blob(_) => None,
    }
}

fn val_string(val: ValueRef<'_>) -> String {
    match val {
        ValueRef::Null => String::new(),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Blob(bytes) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

#[derive(Debug, Clone, Serialize)]
struct CardMeta {
    deck_name: Option<String>,
    interval: Option<i64>,
    due: Option<i64>,
}

fn get_card_data_for_words(conn: &Connection, word_ids: &[i64]) -> HashMap<i64, CardMeta> {
    if word_ids.is_empty()
        || !table_exists(conn, "word_anki_links")
        || !table_exists(conn, "anki_cards")
    {
        return HashMap::new();
    }
    let mut map: HashMap<i64, CardMeta> = HashMap::with_capacity(word_ids.len());
    for chunk in word_ids.chunks(500) {
        let mut sql = String::from(
            "SELECT wal.word_id, ac.deck_name, ac.interval, ac.due \
             FROM word_anki_links wal \
             JOIN anki_cards ac ON ac.note_id = wal.note_id \
             WHERE wal.word_id IN (",
        );
        for i in 0..chunk.len() {
            if i > 0 {
                sql.push(',');
            }
            sql.push('?');
        }
        sql.push_str(") ORDER BY wal.word_id, ac.card_id");
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return HashMap::new();
        };
        let Ok(mut rows) = stmt.query(params_from_iter(chunk.iter().copied())) else {
            return HashMap::new();
        };
        while let Ok(Some(row)) = rows.next() {
            let Ok(wid) = row.get::<_, i64>(0) else {
                continue;
            };
            if map.contains_key(&wid) {
                continue;
            }
            let deck_name = match row.get_ref(1) {
                Ok(ValueRef::Null) | Err(_) => None,
                Ok(v) => Some(val_string(v)),
            };
            let interval = row.get_ref(2).ok().and_then(opt_i64);
            let due = row.get_ref(3).ok().and_then(opt_i64);
            map.insert(
                wid,
                CardMeta {
                    deck_name,
                    interval,
                    due,
                },
            );
        }
    }
    map
}

pub fn status(tx: &Transaction<'_>) -> Result<Value> {
    let (total, tokenized): (i64, i64) = tx.query_row(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN tokenized = 1 THEN 1 ELSE 0 END), 0) FROM game_lines",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let untokenized = total - tokenized;
    let pct = if total > 0 {
        let raw = ((tokenized as f64 / total as f64) * 10000.0).round() / 100.0;
        json!(raw)
    } else {
        json!(0)
    };
    let total_words: i64 = tx.query_row("SELECT COUNT(*) FROM words", [], |r| r.get(0))?;
    let total_kanji: i64 = tx.query_row("SELECT COUNT(*) FROM kanji", [], |r| r.get(0))?;
    Ok(json!({
        "enabled": true,
        "total_lines": total,
        "tokenized_lines": tokenized,
        "untokenized_lines": untokenized,
        "percent_complete": pct,
        "total_words": total_words,
        "total_kanji": total_kanji,
    }))
}

#[derive(Debug, Deserialize)]
pub struct WordsQuery {
    pub limit: i64,
    pub offset: i64,
    #[serde(default)]
    pub days: Option<i64>,
    #[serde(default)]
    pub game_id: Option<String>,
    #[serde(default)]
    pub pos: Option<String>,
    #[serde(default)]
    pub exclude_pos: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
}

impl WordsQuery {
    pub fn run(&self, tx: &Transaction<'_>) -> Result<Value> {
        let limit = self.limit.min(500);
        let offset = self.offset;
        let game_id = self.game_id.as_deref().filter(|s| !s.is_empty());
        let search = self.search.as_deref().filter(|s| !s.is_empty());

        let mut conditions = vec!["w.pos NOT IN ('記号', 'その他')".to_owned()];
        let mut params: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(days) = self.days {
            conditions.push("gl.timestamp >= CAST(strftime('%s', 'now', ?) AS REAL)".to_owned());
            params.push(format!("-{days} days").into());
        }
        if let Some(gid) = game_id {
            conditions.push("gl.game_id = ?".to_owned());
            params.push(gid.to_owned().into());
        }
        if let Some(pos_raw) = self.pos.as_deref().filter(|s| !s.is_empty()) {
            let vals = expand_pos_shorthand(pos_raw);
            if !vals.is_empty() {
                let ph = vec!["?"; vals.len()].join(",");
                conditions.push(format!("w.pos IN ({ph})"));
                params.extend(vals.into_iter().map(Into::into));
            }
        }
        if let Some(exc_raw) = self.exclude_pos.as_deref().filter(|s| !s.is_empty()) {
            let vals = expand_pos_shorthand(exc_raw);
            if !vals.is_empty() {
                let ph = vec!["?"; vals.len()].join(",");
                conditions.push(format!("w.pos NOT IN ({ph})"));
                params.extend(vals.into_iter().map(Into::into));
            }
        }
        if let Some(q) = search {
            conditions.push("w.word LIKE ?".to_owned());
            params.push(format!("%{q}%").into());
        }

        struct FreqWordRow {
            id: i64,
            word: String,
            reading: String,
            pos: String,
            freq: i64,
        }

        let use_cache = has_word_stats_cache(tx) && self.days.is_none() && game_id.is_none();
        let (rows, total_count): (Vec<FreqWordRow>, i64) = if use_cache {
            let where_sql = format!("{} AND ws.occurrence_count > 0", conditions.join(" AND "));
            let count_sql = format!(
                "SELECT COUNT(*) FROM {WORD_STATS_CACHE_TABLE} ws JOIN words w ON w.id = ws.word_id WHERE {where_sql}"
            );
            let total: i64 =
                tx.query_row(&count_sql, params_from_iter(params.iter()), |r| r.get(0))?;
            let query_sql = format!(
                "SELECT w.id, w.word, w.reading, w.pos, ws.occurrence_count AS freq \
                 FROM {WORD_STATS_CACHE_TABLE} ws JOIN words w ON w.id = ws.word_id \
                 WHERE {where_sql} ORDER BY freq DESC, w.word ASC, w.id ASC LIMIT ? OFFSET ?"
            );
            params.push(limit.into());
            params.push(offset.into());
            let mut stmt = tx.prepare(&query_sql)?;
            let mapped = stmt
                .query_map(params_from_iter(params.iter()), |r| {
                    Ok(FreqWordRow {
                        id: r.get(0)?,
                        word: val_string(r.get_ref(1)?),
                        reading: val_string(r.get_ref(2)?),
                        pos: val_string(r.get_ref(3)?),
                        freq: r.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            (mapped, total)
        } else {
            let src = word_occurrence_source(has_archives(tx));
            let where_sql = conditions.join(" AND ");
            let count_sql = format!(
                "SELECT COUNT(DISTINCT w.id) FROM ({src}) gl JOIN words w ON w.id = gl.word_id WHERE {where_sql}"
            );
            let total: i64 =
                tx.query_row(&count_sql, params_from_iter(params.iter()), |r| r.get(0))?;
            let query_sql = format!(
                "SELECT w.id, w.word, w.reading, w.pos, SUM(gl.frequency) AS freq \
                 FROM ({src}) gl JOIN words w ON w.id = gl.word_id \
                 WHERE {where_sql} GROUP BY w.id ORDER BY freq DESC LIMIT ? OFFSET ?"
            );
            params.push(limit.into());
            params.push(offset.into());
            let mut stmt = tx.prepare(&query_sql)?;
            let mapped = stmt
                .query_map(params_from_iter(params.iter()), |r| {
                    Ok(FreqWordRow {
                        id: r.get(0)?,
                        word: val_string(r.get_ref(1)?),
                        reading: val_string(r.get_ref(2)?),
                        pos: val_string(r.get_ref(3)?),
                        freq: r.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            (mapped, total)
        };

        let word_ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        let card_data = get_card_data_for_words(tx, &word_ids);
        let words: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                let mut obj = serde_json::Map::new();
                obj.insert("word".into(), json!(row.word));
                obj.insert("reading".into(), json!(row.reading));
                obj.insert("pos".into(), json!(row.pos));
                obj.insert("frequency".into(), json!(row.freq));
                if let Some(cd) = card_data.get(&row.id) {
                    obj.insert("deck_name".into(), json!(cd.deck_name));
                    obj.insert("interval".into(), json!(cd.interval));
                    obj.insert("due".into(), json!(cd.due));
                }
                Value::Object(obj)
            })
            .collect();

        Ok(json!({
            "words": words,
            "total": total_count,
            "limit": limit,
            "offset": offset,
        }))
    }
}

#[derive(Debug, Deserialize)]
pub struct KanjiQuery {
    pub limit: i64,
    pub offset: i64,
    #[serde(default)]
    pub days: Option<i64>,
    #[serde(default)]
    pub game_id: Option<String>,
}

impl KanjiQuery {
    pub fn run(&self, tx: &Transaction<'_>) -> Result<Value> {
        let limit = self.limit.min(500);
        let offset = self.offset;
        let game_id = self.game_id.as_deref().filter(|s| !s.is_empty());

        let mut conditions: Vec<&str> = Vec::new();
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(days) = self.days {
            conditions.push("gl.timestamp >= CAST(strftime('%s', 'now', ?) AS REAL)");
            params.push(format!("-{days} days").into());
        }
        if let Some(gid) = game_id {
            conditions.push("gl.game_id = ?");
            params.push(gid.to_owned().into());
        }
        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" AND {}", conditions.join(" AND "))
        };
        let src = kanji_occurrence_source(has_archives(tx));
        let count_sql = format!(
            "SELECT COUNT(DISTINCT gl.character) FROM ({src}) gl WHERE 1=1{where_clause}"
        );
        let total: i64 = tx.query_row(&count_sql, params_from_iter(params.iter()), |r| r.get(0))?;
        let query_sql = format!(
            "SELECT gl.character, SUM(gl.frequency) AS freq \
             FROM ({src}) gl WHERE 1=1{where_clause} \
             GROUP BY gl.character ORDER BY freq DESC LIMIT ? OFFSET ?"
        );
        params.push(limit.into());
        params.push(offset.into());
        let mut stmt = tx.prepare(&query_sql)?;
        let kanji: Vec<Value> = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                Ok(json!({
                    "character": val_string(r.get_ref(0)?),
                    "frequency": r.get::<_, i64>(1)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(json!({
            "kanji": kanji,
            "total": total,
            "limit": limit,
            "offset": offset,
        }))
    }
}

#[derive(Debug, Deserialize)]
pub struct TokenSearchQuery {
    pub query: String,
    pub limit: i64,
    pub offset: i64,
    #[serde(default)]
    pub game_ids: Vec<String>,
    #[serde(default)]
    pub has_game_scope: bool,
}

impl TokenSearchQuery {
    pub fn run(&self, tx: &Transaction<'_>) -> Result<Value> {
        let limit = self.limit.min(200);
        let offset = self.offset;
        let word_row: Option<(i64, String, String, String)> = match tx.query_row(
            "SELECT id, word, reading, pos FROM words WHERE word = ?1",
            [self.query.as_str()],
            |r| {
                Ok((
                    r.get(0)?,
                    val_string(r.get_ref(1)?),
                    val_string(r.get_ref(2)?),
                    val_string(r.get_ref(3)?),
                ))
            },
        ) {
            Ok(row) => Some(row),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(err) => return Err(err.into()),
        };

        let Some((word_id, word, reading, pos)) = word_row else {
            return Ok(json!({
                "query": self.query,
                "lines": [],
                "total": 0,
                "limit": limit,
                "offset": offset,
            }));
        };
        let word_obj = json!({ "word": word, "reading": reading, "pos": pos });

        if self.has_game_scope && self.game_ids.is_empty() {
            return Ok(json!({
                "query": self.query,
                "word": word_obj,
                "lines": [],
                "total": 0,
                "limit": limit,
                "offset": offset,
            }));
        }

        let mut where_conditions = vec!["wo.word_id = ?".to_owned()];
        let mut params: Vec<rusqlite::types::Value> = vec![word_id.into()];
        if !self.game_ids.is_empty() {
            let ph = vec!["?"; self.game_ids.len()].join(",");
            where_conditions.push(format!("gl.game_id IN ({ph})"));
            params.extend(self.game_ids.iter().cloned().map(Into::into));
        }
        let where_sql = where_conditions.join(" AND ");

        let count_sql = format!(
            "SELECT COUNT(*) FROM game_lines gl JOIN word_occurrences wo ON gl.id = wo.line_id WHERE {where_sql}"
        );
        let total: i64 = tx.query_row(&count_sql, params_from_iter(params.iter()), |r| r.get(0))?;

        let select_sql = format!(
            "SELECT gl.id, gl.line_text, gl.timestamp, gl.game_name \
             FROM game_lines gl JOIN word_occurrences wo ON gl.id = wo.line_id \
             WHERE {where_sql} ORDER BY gl.timestamp DESC LIMIT ? OFFSET ?"
        );
        params.push(limit.into());
        params.push(offset.into());
        let mut stmt = tx.prepare(&select_sql)?;
        let lines: Vec<Value> = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                let ts = match r.get_ref(2)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Real(f) => json!(f),
                    ValueRef::Integer(i) => json!(i),
                    ValueRef::Text(b) => json!(String::from_utf8_lossy(b)),
                    ValueRef::Blob(_) => Value::Null,
                };
                let game_name = match r.get_ref(3)? {
                    ValueRef::Null => Value::Null,
                    v => json!(val_string(v)),
                };
                Ok(json!({
                    "id": val_string(r.get_ref(0)?),
                    "text": val_string(r.get_ref(1)?),
                    "timestamp": ts,
                    "game_name": game_name,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(json!({
            "query": self.query,
            "word": word_obj,
            "lines": lines,
            "total": total,
            "limit": limit,
            "offset": offset,
        }))
    }
}

pub fn word_card_data(tx: &Transaction<'_>, word_ids: &[i64]) -> Result<Value> {
    if word_ids.is_empty() {
        return Ok(json!({ "cards": [] }));
    }
    let card_data = get_card_data_for_words(tx, word_ids);
    let mut cards = Vec::with_capacity(card_data.len());
    for &wid in word_ids {
        if let Some(cd) = card_data.get(&wid) {
            cards.push(json!({
                "word_id": wid,
                "deck_name": cd.deck_name,
                "interval": cd.interval,
                "due": cd.due,
            }));
        }
    }
    Ok(json!({ "cards": cards }))
}

#[derive(Debug, Deserialize)]
pub struct WordDetailQuery {
    pub word: String,
    #[serde(default)]
    pub game_ids: Vec<String>,
    #[serde(default)]
    pub has_game_scope: bool,
}

impl WordDetailQuery {
    pub fn run(&self, tx: &Transaction<'_>) -> Result<Value> {
        let use_cached = has_word_stats_cache(tx) && !self.has_game_scope;
        let row: Option<(i64, String, String, String, i64)> = if use_cached {
            match tx.query_row(
                &format!(
                    "SELECT w.id, w.word, w.reading, w.pos, COALESCE(ws.occurrence_count, 0) \
                     FROM words w LEFT JOIN {WORD_STATS_CACHE_TABLE} ws ON ws.word_id = w.id \
                     WHERE w.word = ?1"
                ),
                [self.word.as_str()],
                |r| {
                    Ok((
                        r.get(0)?,
                        val_string(r.get_ref(1)?),
                        val_string(r.get_ref(2)?),
                        val_string(r.get_ref(3)?),
                        r.get(4)?,
                    ))
                },
            ) {
                Ok(v) => Some(v),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(err) => return Err(err.into()),
            }
        } else {
            match tx.query_row(
                "SELECT id, word, reading, pos FROM words WHERE word = ?1",
                [self.word.as_str()],
                |r| {
                    Ok((
                        r.get(0)?,
                        val_string(r.get_ref(1)?),
                        val_string(r.get_ref(2)?),
                        val_string(r.get_ref(3)?),
                        0i64,
                    ))
                },
            ) {
                Ok(v) => Some(v),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(err) => return Err(err.into()),
            }
        };

        let Some((word_id, word, reading, pos, cached_total)) = row else {
            return Ok(json!({ "not_found": true }));
        };

        let mut scope_conditions = vec!["gl.word_id = ?".to_owned()];
        let mut scope_params: Vec<rusqlite::types::Value> = vec![word_id.into()];
        if !self.game_ids.is_empty() {
            let ph = vec!["?"; self.game_ids.len()].join(",");
            scope_conditions.push(format!("gl.game_id IN ({ph})"));
            scope_params.extend(self.game_ids.iter().cloned().map(Into::into));
        }
        let scope_where = scope_conditions.join(" AND ");
        let src = word_occurrence_source(has_archives(tx));

        let total_occurrences: i64 = if use_cached {
            cached_total
        } else if self.has_game_scope && self.game_ids.is_empty() {
            0
        } else {
            tx.query_row(
                &format!("SELECT COALESCE(SUM(gl.frequency), 0) FROM ({src}) gl WHERE {scope_where}"),
                params_from_iter(scope_params.iter()),
                |r| r.get(0),
            )?
        };

        let games: Vec<Value> = if self.has_game_scope && self.game_ids.is_empty() {
            Vec::new()
        } else {
            let mut stmt = tx.prepare(&format!(
                "SELECT gl.game_name, SUM(gl.frequency) AS freq \
                 FROM ({src}) gl WHERE {scope_where} \
                 GROUP BY gl.game_name ORDER BY freq DESC LIMIT 10"
            ))?;
            let mapped = stmt
                .query_map(params_from_iter(scope_params.iter()), |r| {
                    let gname = match r.get_ref(0)? {
                        ValueRef::Null => Value::Null,
                        v => json!(val_string(v)),
                    };
                    Ok(json!({
                        "game_name": gname,
                        "frequency": r.get::<_, i64>(1)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            mapped
        };

        let card_data = get_card_data_for_words(tx, &[word_id]);
        let mut result = serde_json::Map::new();
        result.insert("word".into(), json!(word));
        result.insert("reading".into(), json!(reading));
        result.insert("pos".into(), json!(pos));
        result.insert("total_occurrences".into(), json!(total_occurrences));
        result.insert("games".into(), json!(games));
        if let Some(cd) = card_data.get(&word_id) {
            result.insert("deck_name".into(), json!(cd.deck_name));
            result.insert("interval".into(), json!(cd.interval));
            result.insert("due".into(), json!(cd.due));
        }
        Ok(Value::Object(result))
    }
}

pub fn words_by_game(tx: &Transaction<'_>, limit: i64) -> Result<Value> {
    let limit = limit.min(100);
    let src = word_occurrence_source(has_archives(tx));
    let mut stmt = tx.prepare(&format!(
        "SELECT gl.game_name, COUNT(DISTINCT gl.word_id) AS unique_words \
         FROM ({src}) gl JOIN words w ON w.id = gl.word_id \
         WHERE w.pos NOT IN ('記号', 'その他') \
         GROUP BY gl.game_name ORDER BY unique_words DESC LIMIT ?1"
    ))?;
    let games: Vec<Value> = stmt
        .query_map([limit], |r| {
            let gname = match r.get_ref(0)? {
                ValueRef::Null => Value::Null,
                v => json!(val_string(v)),
            };
            Ok(json!({
                "game_name": gname,
                "unique_words": r.get::<_, i64>(1)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({ "games": games }))
}

#[derive(Debug, Clone, Serialize)]
struct GlobalFrequencySource {
    id: String,
    name: String,
    version: String,
    source_url: String,
    max_rank: i64,
}

fn active_global_frequency_source(conn: &Connection) -> Result<Option<GlobalFrequencySource>> {
    if !table_exists(conn, "global_frequency_sources") {
        return Ok(None);
    }
    match conn.query_row(
        "SELECT id, name, version, source_url, max_rank \
         FROM global_frequency_sources \
         ORDER BY is_default DESC, name ASC, id ASC LIMIT 1",
        [],
        |r| {
            Ok(GlobalFrequencySource {
                id: val_string(r.get_ref(0)?),
                name: val_string(r.get_ref(1)?),
                version: val_string(r.get_ref(2)?),
                source_url: val_string(r.get_ref(3)?),
                max_rank: opt_i64(r.get_ref(4)?).unwrap_or(0),
            })
        },
    ) {
        Ok(src) => Ok(Some(src)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[derive(Debug, Deserialize)]
pub struct WordsNotInAnkiQuery {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default = "default_sort_col")]
    pub sort_col: String,
    #[serde(default = "default_sort_order")]
    pub sort_order: String,
    #[serde(default)]
    pub global_rank_min: Option<i64>,
    #[serde(default)]
    pub global_rank_max: Option<i64>,
    #[serde(default)]
    pub pos_filter: Option<String>,
    #[serde(default)]
    pub exclude_pos: Option<String>,
    #[serde(default)]
    pub vocab_only: bool,
    #[serde(default = "default_script_filter")]
    pub script_filter: String,
    #[serde(default)]
    pub game_ids: Vec<String>,
    #[serde(default)]
    pub has_game_scope: bool,
    #[serde(default)]
    pub start_timestamp: Option<i64>,
    #[serde(default)]
    pub end_timestamp: Option<i64>,
    #[serde(default)]
    pub frequency_min: Option<i64>,
    #[serde(default)]
    pub frequency_max: Option<i64>,
    #[serde(default)]
    pub has_missing_anki_kanji: bool,
    #[serde(default)]
    pub parent_tag: String,
    #[serde(default)]
    pub word_field: String,
    pub today: NaiveDate,
    #[serde(default)]
    pub export_csv: bool,
}

fn default_sort_col() -> String {
    "frequency".to_owned()
}
fn default_sort_order() -> String {
    "desc".to_owned()
}
fn default_script_filter() -> String {
    "all".to_owned()
}

struct WordRow {
    word_id: i64,
    word: String,
    reading: String,
    pos: String,
    frequency: i64,
    global_rank: Option<i64>,
}

fn full_day_local_range(start_ms: Option<i64>, end_ms: Option<i64>) -> Option<(NaiveDate, NaiveDate)> {
    let (s_ms, e_ms) = (start_ms?, end_ms?);
    let s_secs = (s_ms as f64 / 1000.0).max(0.0);
    let e_secs = (e_ms as f64 / 1000.0).max(0.0);
    let s_whole = s_secs.floor() as i64;
    let s_nanos = ((s_secs - s_secs.floor()) * 1e9).round() as u32;
    let e_whole = e_secs.floor() as i64;
    let e_nanos = ((e_secs - e_secs.floor()) * 1e9).round() as u32;
    let s_dt = DateTime::from_timestamp(s_whole, s_nanos.min(999_999_999))?
        .with_timezone(&Local);
    let e_dt = DateTime::from_timestamp(e_whole, e_nanos.min(999_999_999))?
        .with_timezone(&Local);
    let min_time = NaiveTime::from_hms_opt(0, 0, 0)?;
    let end_threshold = NaiveTime::from_hms_micro_opt(23, 59, 59, 900_000)?;
    if s_dt.time() == min_time && e_dt.time() >= end_threshold {
        Some((s_dt.date_naive(), e_dt.date_naive()))
    } else {
        None
    }
}

fn local_midnight_ts(date: NaiveDate) -> Option<f64> {
    let naive = date.and_hms_opt(0, 0, 0)?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|dt| dt.timestamp() as f64)
}

impl WordsNotInAnkiQuery {
    fn has_timestamp_scope(&self) -> bool {
        self.start_timestamp.is_some() || self.end_timestamp.is_some()
    }

    fn word_conditions(&self) -> (Vec<String>, Vec<rusqlite::types::Value>) {
        let mut conditions = vec![
            "(w.in_anki = 0 OR w.in_anki IS NULL)".to_owned(),
            "w.pos NOT IN ('記号', 'その他')".to_owned(),
        ];
        let mut params: Vec<rusqlite::types::Value> = Vec::new();

        if self.vocab_only {
            let pos_ph = vec!["?"; VOCAB_ONLY_EXCLUDED_POS.len()].join(",");
            conditions.push(format!("w.pos NOT IN ({pos_ph})"));
            params.extend(VOCAB_ONLY_EXCLUDED_POS.iter().map(|s| (*s).to_owned().into()));
            let word_ph = vec!["?"; VOCAB_ONLY_EXCLUDED_WORDS.len()].join(",");
            conditions.push(format!("w.word NOT IN ({word_ph})"));
            params.extend(VOCAB_ONLY_EXCLUDED_WORDS.iter().map(|s| (*s).to_owned().into()));
        }
        if self.script_filter == "cjk" {
            conditions.push("w.word GLOB ?".to_owned());
            params.push(CJK_WORD_GLOB_PATTERN.to_owned().into());
        } else if self.script_filter == "non_cjk" {
            conditions.push("w.word NOT GLOB ?".to_owned());
            params.push(CJK_WORD_GLOB_PATTERN.to_owned().into());
        }
        if let Some(pos_raw) = self.pos_filter.as_deref().filter(|s| !s.is_empty()) {
            let vals = expand_pos_shorthand(pos_raw);
            if !vals.is_empty() {
                let ph = vec!["?"; vals.len()].join(",");
                conditions.push(format!("w.pos IN ({ph})"));
                params.extend(vals.into_iter().map(Into::into));
            }
        }
        if let Some(exc_raw) = self.exclude_pos.as_deref().filter(|s| !s.is_empty()) {
            let vals = expand_pos_shorthand(exc_raw);
            if !vals.is_empty() {
                let ph = vec!["?"; vals.len()].join(",");
                conditions.push(format!("w.pos NOT IN ({ph})"));
                params.extend(vals.into_iter().map(Into::into));
            }
        }
        if let Some(q) = self.search.as_deref().filter(|s| !s.is_empty()) {
            conditions.push("(w.word LIKE ? OR w.reading LIKE ?)".to_owned());
            let like = format!("%{q}%");
            params.push(like.clone().into());
            params.push(like.into());
        }
        (conditions, params)
    }

    fn occurrence_conditions(&self) -> (Vec<String>, Vec<rusqlite::types::Value>) {
        let mut conditions = Vec::new();
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(start_ms) = self.start_timestamp {
            conditions.push("gl.timestamp >= ?".to_owned());
            params.push((start_ms as f64 / 1000.0).max(0.0).into());
        }
        if let Some(end_ms) = self.end_timestamp {
            conditions.push("gl.timestamp <= ?".to_owned());
            params.push((end_ms as f64 / 1000.0).max(0.0).into());
        }
        if self.has_game_scope {
            if self.game_ids.is_empty() {
                conditions.push("1 = 0".to_owned());
            } else {
                let ph = vec!["?"; self.game_ids.len()].join(",");
                conditions.push(format!("gl.game_id IN ({ph})"));
                params.extend(self.game_ids.iter().cloned().map(Into::into));
            }
        }
        (conditions, params)
    }

    fn load_rollup_frequencies(&self, tx: &Transaction<'_>) -> Result<Option<HashMap<String, i64>>> {
        if self.has_game_scope {
            return Ok(None);
        }
        let Some((start_date, end_date)) = full_day_local_range(self.start_timestamp, self.end_timestamp) else {
            return Ok(None);
        };
        let mut frequencies: HashMap<String, i64> = HashMap::new();
        let yesterday = self.today.pred_opt().unwrap_or(self.today);
        let historical_end = end_date.min(yesterday);
        let mut used_rollups = false;

        if start_date <= historical_end {
            if !table_exists(tx, "daily_stats_rollup") {
                return Ok(None);
            }
            let mut stmt = tx.prepare(
                "SELECT word_frequency_data FROM daily_stats_rollup \
                 WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC",
            )?;
            let mut rows = stmt.query(params![
                start_date.format("%Y-%m-%d").to_string(),
                historical_end.format("%Y-%m-%d").to_string()
            ])?;
            let mut count = 0usize;
            while let Some(row) = rows.next()? {
                count += 1;
                if let ValueRef::Text(bytes) = row.get_ref(0)? {
                    if let Ok(raw) = std::str::from_utf8(bytes) {
                        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) {
                            for (word, val) in map {
                                if let Some(n) = val.as_i64() {
                                    *frequencies.entry(word).or_insert(0) += n;
                                }
                            }
                        }
                    }
                }
            }
            if count == 0 {
                return Ok(None);
            }
            used_rollups = true;
        }

        let includes_today = start_date <= self.today && self.today <= end_date;
        if includes_today {
            if let (Some(today_start), Some(tomorrow_start)) = (
                local_midnight_ts(self.today),
                self.today.succ_opt().and_then(local_midnight_ts),
            ) {
                let untokenized: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM game_lines WHERE timestamp >= ?1 AND timestamp < ?2 AND tokenized = 0",
                    params![today_start, tomorrow_start],
                    |r| r.get(0),
                )?;
                if untokenized == 0 {
                    let mut stmt = tx.prepare(
                        "SELECT w.word, COUNT(*) AS freq \
                         FROM word_occurrences wo \
                         JOIN words w ON w.id = wo.word_id \
                         JOIN game_lines gl ON gl.id = wo.line_id \
                         WHERE gl.timestamp >= ?1 AND gl.timestamp < ?2 \
                           AND w.pos NOT IN ('記号', 'その他') \
                         GROUP BY w.word",
                    )?;
                    let mut rows = stmt.query(params![today_start, tomorrow_start])?;
                    while let Some(row) = rows.next()? {
                        let word = val_string(row.get_ref(0)?);
                        let freq: i64 = row.get(1)?;
                        *frequencies.entry(word).or_insert(0) += freq;
                    }
                }
                if table_exists(tx, "archived_word_stats") {
                    let today_str = self.today.format("%Y-%m-%d").to_string();
                    let tomorrow_str = self
                        .today
                        .succ_opt()
                        .unwrap_or(self.today)
                        .format("%Y-%m-%d")
                        .to_string();
                    let mut stmt = tx.prepare(
                        "SELECT word, SUM(frequency) FROM archived_word_stats \
                         WHERE date >= ?1 AND date < ?2 AND pos NOT IN ('記号', 'その他') \
                         GROUP BY word",
                    )?;
                    let mut rows = stmt.query(params![today_str, tomorrow_str])?;
                    while let Some(row) = rows.next()? {
                        let word = val_string(row.get_ref(0)?);
                        let freq: i64 = row.get(1)?;
                        *frequencies.entry(word).or_insert(0) += freq;
                    }
                }
            }
        }

        if !used_rollups && !includes_today {
            return Ok(None);
        }
        Ok(Some(frequencies))
    }

    fn load_candidates(
        &self,
        tx: &Transaction<'_>,
        active_source: Option<&GlobalFrequencySource>,
    ) -> Result<Vec<WordRow>> {
        if let Some(freqs) = self.load_rollup_frequencies(tx)? {
            let (conditions, cond_params) = self.word_conditions();
            let where_sql = conditions.join(" AND ");
            let (join_sql, rank_sql, mut params): (&str, &str, Vec<rusqlite::types::Value>) =
                match active_source {
                    Some(src) => (
                        "LEFT JOIN word_global_frequencies wgf ON wgf.word = w.word AND wgf.source_id = ?",
                        "wgf.rank",
                        vec![src.id.clone().into()],
                    ),
                    None => ("", "NULL", Vec::new()),
                };
            params.extend(cond_params);
            let sql = format!(
                "SELECT w.id, w.word, w.reading, w.pos, {rank_sql} \
                 FROM words w {join_sql} WHERE {where_sql}"
            );
            let mut stmt = tx.prepare(&sql)?;
            let mut rows = stmt.query(params_from_iter(params.iter()))?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let word = val_string(row.get_ref(1)?);
                let Some(&freq) = freqs.get(&word) else {
                    continue;
                };
                if freq <= 0 {
                    continue;
                }
                out.push(WordRow {
                    word_id: row.get(0)?,
                    word,
                    reading: val_string(row.get_ref(2)?),
                    pos: val_string(row.get_ref(3)?),
                    frequency: freq,
                    global_rank: opt_i64(row.get_ref(4)?),
                });
            }
            return Ok(out);
        }

        let (mut conditions, mut cond_params) = self.word_conditions();
        let use_cache =
            has_word_stats_cache(tx) && !self.has_timestamp_scope() && !self.has_game_scope;

        if use_cache {
            let where_sql = format!("ws.occurrence_count > 0 AND {}", conditions.join(" AND "));
            let sql = format!(
                "SELECT w.id, w.word, w.reading, w.pos, ws.occurrence_count, ws.active_global_rank \
                 FROM {WORD_STATS_CACHE_TABLE} ws JOIN words w ON w.id = ws.word_id WHERE {where_sql}"
            );
            let mut stmt = tx.prepare(&sql)?;
            let mapped = stmt
                .query_map(params_from_iter(cond_params.iter()), |r| {
                    Ok(WordRow {
                        word_id: r.get(0)?,
                        word: val_string(r.get_ref(1)?),
                        reading: val_string(r.get_ref(2)?),
                        pos: val_string(r.get_ref(3)?),
                        frequency: r.get(4)?,
                        global_rank: opt_i64(r.get_ref(5)?),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(mapped);
        }

        let (occ_conds, occ_params) = self.occurrence_conditions();
        conditions.extend(occ_conds);
        cond_params.extend(occ_params);

        let (join_sql, rank_sql, group_rank_sql, mut params): (
            &str,
            &str,
            &str,
            Vec<rusqlite::types::Value>,
        ) = match active_source {
            Some(src) => (
                "LEFT JOIN word_global_frequencies wgf ON wgf.word = w.word AND wgf.source_id = ?",
                "wgf.rank",
                ", wgf.rank",
                vec![src.id.clone().into()],
            ),
            None => ("", "NULL", "", Vec::new()),
        };
        params.extend(cond_params);

        let src = word_occurrence_source(has_archives(tx));
        let where_sql = conditions.join(" AND ");
        let sql = format!(
            "SELECT w.id, w.word, w.reading, w.pos, SUM(gl.frequency) AS frequency, {rank_sql} \
             FROM ({src}) gl JOIN words w ON w.id = gl.word_id {join_sql} \
             WHERE {where_sql} GROUP BY w.id, w.word, w.reading, w.pos{group_rank_sql}"
        );
        let mut stmt = tx.prepare(&sql)?;
        let mapped = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                Ok(WordRow {
                    word_id: r.get(0)?,
                    word: val_string(r.get_ref(1)?),
                    reading: val_string(r.get_ref(2)?),
                    pos: val_string(r.get_ref(3)?),
                    frequency: r.get(4)?,
                    global_rank: opt_i64(r.get_ref(5)?),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(mapped)
    }

    pub fn run(&self, tx: &Transaction<'_>) -> Result<Value> {
        let active_source = active_global_frequency_source(tx)?;
        if self.has_game_scope && self.game_ids.is_empty() {
            if self.export_csv {
                return Ok(json!({ "csv": "\u{feff}word,reading,pos,frequency,global_rank\n" }));
            }
            return Ok(json!({
                "words": [],
                "total": 0,
                "limit": self.limit,
                "offset": self.offset,
                "frequency_bounds": { "min": Value::Null, "max": Value::Null },
                "global_rank_bounds": { "min": Value::Null, "max": Value::Null },
                "global_rank_source": active_source,
            }));
        }

        let has_global_rank = active_source.is_some();
        let effective_sort = if self.sort_col == "global_rank" && !has_global_rank {
            "frequency"
        } else {
            self.sort_col.as_str()
        };

        let mut entries = self.load_candidates(tx, active_source.as_ref())?;

        if self.has_missing_anki_kanji && table_exists(tx, "anki_notes") {
            let has_notes = tx
                .query_row("SELECT 1 FROM anki_notes LIMIT 1", [], |_| Ok(()))
                .is_ok();
            if has_notes {
                let parent = if self.parent_tag.trim().is_empty() {
                    "Game"
                } else {
                    self.parent_tag.trim()
                };
                let kanji_val = anki_notes::characters(tx, parent, self.word_field.trim(), None, None)?;
                let anki_kanji: HashSet<char> = kanji_val
                    .as_str()
                    .map(|s| s.chars().collect())
                    .unwrap_or_default();
                entries.retain(|e| e.word.chars().any(|c| is_kanji(&c) && !anki_kanji.contains(&c)));
            }
        }

        let (freq_min_bound, freq_max_bound) = entries.iter().fold((None, None), |(lo, hi), e| {
            let f = e.frequency;
            (
                Some(lo.map_or(f, |m: i64| m.min(f))),
                Some(hi.map_or(f, |m: i64| m.max(f))),
            )
        });

        if let Some(fmin) = self.frequency_min {
            entries.retain(|e| e.frequency >= fmin);
        }
        if let Some(fmax) = self.frequency_max {
            entries.retain(|e| e.frequency <= fmax);
        }

        let (rank_min_bound, rank_max_bound) = if has_global_rank {
            entries
                .iter()
                .filter_map(|e| e.global_rank)
                .fold((None, None), |(lo, hi), r| {
                    (
                        Some(lo.map_or(r, |m: i64| m.min(r))),
                        Some(hi.map_or(r, |m: i64| m.max(r))),
                    )
                })
        } else {
            (None, None)
        };

        if has_global_rank
            && (effective_sort == "global_rank"
                || self.global_rank_min.is_some()
                || self.global_rank_max.is_some())
        {
            entries.retain(|e| e.global_rank.is_some());
        }
        if let Some(rmin) = self.global_rank_min {
            entries.retain(|e| e.global_rank.is_some_and(|r| r >= rmin));
        }
        if let Some(rmax) = self.global_rank_max {
            entries.retain(|e| e.global_rank.is_some_and(|r| r <= rmax));
        }

        let total_count = entries.len();
        let desc = !self.sort_order.eq_ignore_ascii_case("asc");
        let cmp = |a: &WordRow, b: &WordRow| -> Ordering {
            let primary = match effective_sort {
                "global_rank" => {
                    let ord = a.global_rank.cmp(&b.global_rank);
                    if desc { ord.reverse() } else { ord }
                }
                "word" => {
                    let ord = a.word.cmp(&b.word);
                    let ord = if desc { ord.reverse() } else { ord };
                    return ord
                        .then_with(|| a.reading.cmp(&b.reading))
                        .then_with(|| a.word_id.cmp(&b.word_id));
                }
                "reading" => {
                    let ord = a.reading.cmp(&b.reading);
                    if desc { ord.reverse() } else { ord }
                }
                "pos" => {
                    let ord = a.pos.cmp(&b.pos);
                    if desc { ord.reverse() } else { ord }
                }
                _ => {
                    let ord = a.frequency.cmp(&b.frequency);
                    if desc { ord.reverse() } else { ord }
                }
            };
            primary
                .then_with(|| a.word.cmp(&b.word))
                .then_with(|| a.word_id.cmp(&b.word_id))
        };

        let slice: &[WordRow] = match self.limit {
            Some(limit) => {
                if self.offset >= total_count || limit == 0 {
                    &[]
                } else {
                    let end = self.offset.saturating_add(limit).min(total_count);
                    if end < total_count {
                        entries.select_nth_unstable_by(end, cmp);
                    }
                    let prefix = &mut entries[..end];
                    if self.offset > 0 {
                        prefix.select_nth_unstable_by(self.offset, cmp);
                    }
                    let page = &mut prefix[self.offset..end];
                    page.sort_unstable_by(cmp);
                    page
                }
            }
            None => {
                entries.sort_unstable_by(cmp);
                &entries
            }
        };

        if self.export_csv {
            return self.build_csv(tx, slice);
        }

        let words: Vec<Value> = slice
            .iter()
            .map(|e| {
                json!({
                    "word_id": e.word_id,
                    "word": e.word,
                    "reading": e.reading,
                    "pos": e.pos,
                    "frequency": e.frequency,
                    "global_rank": e.global_rank,
                })
            })
            .collect();

        Ok(json!({
            "words": words,
            "total": total_count,
            "limit": self.limit,
            "offset": self.offset,
            "frequency_bounds": { "min": freq_min_bound, "max": freq_max_bound },
            "global_rank_bounds": { "min": rank_min_bound, "max": rank_max_bound },
            "global_rank_source": active_source,
        }))
    }

    fn build_csv(&self, tx: &Transaction<'_>, rows: &[WordRow]) -> Result<Value> {
        let mut game_names: BTreeSet<String> = BTreeSet::new();
        let mut sentence_lists: HashMap<i64, BTreeMap<String, Vec<String>>> = HashMap::new();
        let mut seen_texts: HashMap<(i64, String), HashSet<String>> = HashMap::new();

        if !rows.is_empty() {
            let (occ_conds, occ_params) = self.occurrence_conditions();
            let word_ids: Vec<i64> = rows.iter().map(|r| r.word_id).collect();
            for chunk in word_ids.chunks(500) {
                let ph = vec!["?"; chunk.len()].join(",");
                let mut where_parts = vec![format!("wo.word_id IN ({ph})")];
                where_parts.extend(occ_conds.iter().cloned());
                let sql = format!(
                    "SELECT wo.word_id, COALESCE(NULLIF(TRIM(gl.game_name), ''), ?) AS export_game_name, gl.line_text \
                     FROM word_occurrences wo JOIN game_lines gl ON gl.id = wo.line_id \
                     WHERE {} \
                     ORDER BY wo.word_id ASC, export_game_name ASC, gl.timestamp DESC, gl.id DESC",
                    where_parts.join(" AND ")
                );
                let mut params: Vec<rusqlite::types::Value> =
                    Vec::with_capacity(1 + chunk.len() + occ_params.len());
                params.push(UNKNOWN_GAME_LABEL.to_owned().into());
                params.extend(chunk.iter().copied().map(Into::into));
                params.extend(occ_params.iter().cloned());
                let mut stmt = tx.prepare(&sql)?;
                let mut qrows = stmt.query(params_from_iter(params.iter()))?;
                while let Some(qrow) = qrows.next()? {
                    let wid: i64 = qrow.get(0)?;
                    let gname = val_string(qrow.get_ref(1)?);
                    let gname = if gname.is_empty() {
                        UNKNOWN_GAME_LABEL.to_owned()
                    } else {
                        gname
                    };
                    let text = val_string(qrow.get_ref(2)?);
                    if text.is_empty() {
                        continue;
                    }
                    let seen = seen_texts.entry((wid, gname.clone())).or_default();
                    if seen.insert(text.clone()) {
                        game_names.insert(gname.clone());
                        sentence_lists
                            .entry(wid)
                            .or_default()
                            .entry(gname)
                            .or_default()
                            .push(text);
                    }
                }
            }
        }

        let mut sorted_games: Vec<String> = game_names.into_iter().collect();
        sorted_games.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));

        let mut csv = String::from("\u{feff}word,reading,pos,frequency,global_rank");
        for g in &sorted_games {
            csv.push(',');
            write_csv_field(&mut csv, g);
        }
        csv.push('\n');

        for row in rows {
            write_csv_field(&mut csv, &row.word);
            csv.push(',');
            write_csv_field(&mut csv, &row.reading);
            csv.push(',');
            write_csv_field(&mut csv, &row.pos);
            csv.push(',');
            csv.push_str(&row.frequency.to_string());
            csv.push(',');
            if let Some(rank) = row.global_rank {
                csv.push_str(&rank.to_string());
            }
            let cells = sentence_lists.get(&row.word_id);
            for g in &sorted_games {
                csv.push(',');
                if let Some(lines) = cells.and_then(|c| c.get(g)) {
                    let joined = lines.join("\n");
                    write_csv_field(&mut csv, &joined);
                }
            }
            csv.push('\n');
        }
        Ok(json!({ "csv": csv }))
    }
}

fn write_csv_field(out: &mut String, field: &str) {
    if field.contains([',', '"', '\n', '\r']) {
        out.push('"');
        for ch in field.chars() {
            if ch == '"' {
                out.push_str("\"\"");
            } else {
                out.push(ch);
            }
        }
        out.push('"');
    } else {
        out.push_str(field);
    }
}
