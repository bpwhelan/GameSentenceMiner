use crate::{
    stats::local_date,
    tokenization::{has_archives, table_exists},
    Result,
};
use chrono::{Local, NaiveDate, NaiveTime, TimeZone};
use flate2::read::ZlibDecoder;
use rusqlite::{params, types::ValueRef, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(untagged)]
enum ArchiveToken {
    Number(u8),
    Bool(bool),
    Null,
}

impl ArchiveToken {
    fn is_truthy(&self) -> bool {
        match self {
            Self::Number(n) => *n != 0,
            Self::Bool(b) => *b,
            Self::Null => false,
        }
    }
}

#[derive(Deserialize)]
struct ArchivedEvent(
    f64,
    usize,
    serde::de::IgnoredAny,
    serde::de::IgnoredAny,
    Option<usize>,
    ArchiveToken,
    Option<String>,
);

const DEFAULT_GAME_BUCKET_SIZE: i64 = 10_000;
const GAME_BUCKET_SIZE_OPTIONS: &[i64] = &[10_000, 25_000, 50_000, 100_000];

fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    let Ok(mut rows) = stmt.query([]) else {
        return false;
    };
    while let Ok(Some(row)) = rows.next() {
        if let Ok(name) = row.get::<_, String>(1) {
            if name == column {
                return true;
            }
        }
    }
    false
}

fn has_word_novelty_support(conn: &Connection) -> bool {
    table_exists(conn, "words")
        && table_exists(conn, "word_occurrences")
        && table_exists(conn, "game_lines")
        && table_has_column(conn, "words", "first_seen")
        && table_has_column(conn, "words", "first_seen_line_id")
        && table_has_column(conn, "game_lines", "tokenized")
}

fn build_date_labels(start: Option<NaiveDate>, end: Option<NaiveDate>) -> Vec<String> {
    let (Some(mut a), Some(mut b)) = (start, end) else {
        return Vec::new();
    };
    if b < a {
        std::mem::swap(&mut a, &mut b);
    }
    let mut labels = Vec::new();
    let mut cur = a;
    while cur <= b {
        labels.push(cur.format("%Y-%m-%d").to_string());
        let Some(next) = cur.succ_opt() else {
            break;
        };
        cur = next;
    }
    labels
}

fn build_series(labels: &[String], counts: &HashMap<String, i64>) -> (Value, i64) {
    let mut daily_new = Vec::with_capacity(labels.len());
    let mut cumulative = Vec::with_capacity(labels.len());
    let mut running = 0i64;
    for label in labels {
        let c = counts.get(label).copied().unwrap_or(0);
        running += c;
        daily_new.push(c);
        cumulative.push(running);
    }
    (
        json!({
            "labels": labels,
            "dailyNew": daily_new,
            "cumulative": cumulative,
        }),
        running,
    )
}

fn local_day_bounds(start: NaiveDate, end: NaiveDate) -> (f64, f64) {
    let (a, b) = if end < start {
        (end, start)
    } else {
        (start, end)
    };
    let start_naive = a.and_time(NaiveTime::from_hms_opt(0, 0, 0).unwrap());
    let end_naive = b.and_time(NaiveTime::from_hms_micro_opt(23, 59, 59, 999_999).unwrap());
    let s = Local
        .from_local_datetime(&start_naive)
        .earliest()
        .map(|dt| dt.timestamp() as f64)
        .unwrap_or(0.0);
    let e = Local
        .from_local_datetime(&end_naive)
        .latest()
        .map(|dt| dt.timestamp() as f64 + 0.999_999)
        .unwrap_or(f64::MAX);
    (s, e)
}

fn val_str(val: ValueRef<'_>) -> String {
    match val {
        ValueRef::Null => String::new(),
        ValueRef::Text(b) => String::from_utf8_lossy(b).into_owned(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Blob(b) => String::from_utf8_lossy(b).into_owned(),
    }
}

fn val_f64(val: ValueRef<'_>) -> Option<f64> {
    match val {
        ValueRef::Null => None,
        ValueRef::Real(f) => Some(f),
        ValueRef::Integer(i) => Some(i as f64),
        ValueRef::Text(b) => std::str::from_utf8(b).ok()?.parse::<f64>().ok(),
        ValueRef::Blob(_) => None,
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub(crate) fn tokenization_status_snapshot(conn: &Connection, enabled: bool) -> Result<Value> {
    if !enabled {
        return Ok(json!({ "enabled": false, "percentComplete": 0.0 }));
    }
    if !table_exists(conn, "game_lines") || !table_has_column(conn, "game_lines", "tokenized") {
        return Ok(json!({ "enabled": true, "percentComplete": 0.0 }));
    }
    let (mut total, mut tokenized): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN tokenized = 1 THEN 1 ELSE 0 END), 0) FROM game_lines",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if table_exists(conn, "archived_game_days") {
        let (arch_lines, arch_tok): (i64, i64) = conn.query_row(
            "SELECT COALESCE(SUM(line_count), 0), COALESCE(SUM(tokenized_lines), 0) \
             FROM archived_game_days",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        total += arch_lines;
        tokenized += arch_tok;
    }
    let pct = if total > 0 {
        round2((tokenized as f64 / total as f64) * 100.0)
    } else {
        0.0
    };
    Ok(json!({ "enabled": true, "percentComplete": pct }))
}

fn game_display_titles(conn: &Connection) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    if !table_exists(conn, "games") {
        return titles;
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, title_original, title_romaji, title_english FROM games",
    ) else {
        return titles;
    };
    let Ok(mut rows) = stmt.query([]) else {
        return titles;
    };
    while let Ok(Some(row)) = rows.next() {
        let id = row.get_ref(0).ok().map(val_str).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let orig = row.get_ref(1).ok().map(val_str).unwrap_or_default();
        let romaji = row.get_ref(2).ok().map(val_str).unwrap_or_default();
        let eng = row.get_ref(3).ok().map(val_str).unwrap_or_default();
        let title = if !orig.is_empty() {
            orig
        } else if !romaji.is_empty() {
            romaji
        } else {
            eng
        };
        if !title.is_empty() {
            titles.insert(id, title);
        }
    }
    titles
}

#[derive(Debug, Deserialize)]
pub struct GlobalNoveltyQuery {
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub tokenization_enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct GameNoveltyQuery {
    pub game_id: String,
    pub first_date: Option<NaiveDate>,
    pub last_date: Option<NaiveDate>,
    pub tokenization_enabled: bool,
}

pub(crate) fn build_global_word_novelty(
    conn: &Connection,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    tokenization_enabled: bool,
) -> Result<Value> {
    let labels = build_date_labels(start_date, end_date);
    let status = tokenization_status_snapshot(conn, tokenization_enabled)?;
    let (empty_series, _) = build_series(&labels, &HashMap::new());
    let empty = || {
        json!({
            "tokenizationStatus": status,
            "vocabularyStats": {
                "uniqueWordsSeen": 0,
                "newWordsFirstSeen": 0,
                "newWordsPer10kChars": 0.0,
            },
            "newWordsSeries": empty_series,
            "newWordsByGame": { "labels": [], "totals": [] },
        })
    };
    if !tokenization_enabled || !has_word_novelty_support(conn) {
        return Ok(empty());
    }
    let (Some(start_d), Some(end_d)) = (start_date, end_date) else {
        return Ok(empty());
    };
    if has_archives(conn) {
        return build_word_novelty_with_archives(conn, status, start_date, end_date, None);
    }

    let (start_ts, end_ts) = local_day_bounds(start_d, end_d);
    let unique_words_seen: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT wo.word_id) \
         FROM word_occurrences wo JOIN game_lines gl ON gl.id = wo.line_id \
         WHERE gl.tokenized = 1 AND CAST(gl.timestamp AS REAL) >= ?1 AND CAST(gl.timestamp AS REAL) <= ?2",
        params![start_ts, end_ts],
        |r| r.get(0),
    )?;
    let tokenized_chars: i64 = conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(COALESCE(line_text, ''))), 0) \
         FROM game_lines \
         WHERE tokenized = 1 AND CAST(timestamp AS REAL) >= ?1 AND CAST(timestamp AS REAL) <= ?2",
        params![start_ts, end_ts],
        |r| r.get(0),
    )?;
    let mut counts: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT first_seen FROM words \
             WHERE first_seen IS NOT NULL \
               AND CAST(first_seen AS REAL) >= ?1 AND CAST(first_seen AS REAL) <= ?2 \
             ORDER BY CAST(first_seen AS REAL) ASC",
        )?;
        let mut rows = stmt.query(params![start_ts, end_ts])?;
        while let Some(row) = rows.next()? {
            if let Some(ts) = val_f64(row.get_ref(0)?) {
                if let Ok(d) = local_date(ts) {
                    *counts.entry(d.format("%Y-%m-%d").to_string()).or_insert(0) += 1;
                }
            }
        }
    }
    let (series, new_words_first_seen) = build_series(&labels, &counts);
    let per_10k = if tokenized_chars > 0 {
        round1((new_words_first_seen as f64 / tokenized_chars as f64) * 10_000.0)
    } else {
        0.0
    };

    let titles = game_display_titles(conn);
    let mut ranked: Vec<(String, i64)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT gl.game_id, gl.game_name, COUNT(*) AS cnt \
             FROM words w JOIN game_lines gl ON gl.id = w.first_seen_line_id \
             WHERE w.first_seen IS NOT NULL AND gl.tokenized = 1 \
               AND CAST(w.first_seen AS REAL) >= ?1 AND CAST(w.first_seen AS REAL) <= ?2 \
             GROUP BY gl.game_id, gl.game_name",
        )?;
        let mut rows = stmt.query(params![start_ts, end_ts])?;
        while let Some(row) = rows.next()? {
            let cnt: i64 = row.get(2)?;
            if cnt <= 0 {
                continue;
            }
            let gid = val_str(row.get_ref(0)?);
            let gname = val_str(row.get_ref(1)?);
            let title = titles
                .get(&gid)
                .cloned()
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    let trimmed = gname.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_owned())
                })
                .or_else(|| {
                    let trimmed = gid.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_owned())
                });
            if let Some(t) = title {
                ranked.push((t, cnt));
            }
        }
    }
    ranked.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
            .then_with(|| a.0.cmp(&b.0))
    });
    let game_labels: Vec<String> = ranked.iter().map(|(t, _)| t.clone()).collect();
    let game_totals: Vec<i64> = ranked.iter().map(|(_, c)| *c).collect();

    Ok(json!({
        "tokenizationStatus": status,
        "vocabularyStats": {
            "uniqueWordsSeen": unique_words_seen,
            "newWordsFirstSeen": new_words_first_seen,
            "newWordsPer10kChars": per_10k,
        },
        "newWordsSeries": series,
        "newWordsByGame": {
            "labels": game_labels,
            "totals": game_totals,
        },
    }))
}

pub(crate) fn build_game_word_novelty(
    conn: &Connection,
    game_id: &str,
    first_date: Option<NaiveDate>,
    last_date: Option<NaiveDate>,
    tokenization_enabled: bool,
) -> Result<Value> {
    let labels = build_date_labels(first_date, last_date);
    let status = tokenization_status_snapshot(conn, tokenization_enabled)?;
    let (empty_series, _) = build_series(&labels, &HashMap::new());
    let empty = || {
        json!({
            "tokenizationStatus": status,
            "vocabulary": {
                "uniqueWordsInGame": 0,
                "globallyNewWordsFromGame": 0,
                "noveltyRate": 0.0,
                "newWordsPer10kChars": 0.0,
                "series": empty_series,
                "defaultBucketSize": DEFAULT_GAME_BUCKET_SIZE,
                "bucketSizeOptions": GAME_BUCKET_SIZE_OPTIONS,
                "totalTokenizedChars": 0,
                "newWordCharacterPositions": [],
            },
        })
    };
    if !tokenization_enabled || game_id.is_empty() || !has_word_novelty_support(conn) {
        return Ok(empty());
    }
    if has_archives(conn) {
        return build_word_novelty_with_archives(conn, status, first_date, last_date, Some(game_id));
    }

    let unique_words: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT wo.word_id) \
         FROM word_occurrences wo JOIN game_lines gl ON gl.id = wo.line_id \
         WHERE gl.game_id = ?1 AND gl.tokenized = 1",
        [game_id],
        |r| r.get(0),
    )?;
    let tokenized_chars: i64 = conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(COALESCE(line_text, ''))), 0) \
         FROM game_lines WHERE game_id = ?1 AND tokenized = 1",
        [game_id],
        |r| r.get(0),
    )?;
    let mut counts: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT w.first_seen \
             FROM words w JOIN game_lines gl ON gl.id = w.first_seen_line_id \
             WHERE w.first_seen IS NOT NULL AND gl.game_id = ?1 \
             ORDER BY CAST(w.first_seen AS REAL) ASC",
        )?;
        let mut rows = stmt.query([game_id])?;
        while let Some(row) = rows.next()? {
            if let Some(ts) = val_f64(row.get_ref(0)?) {
                if let Ok(d) = local_date(ts) {
                    *counts.entry(d.format("%Y-%m-%d").to_string()).or_insert(0) += 1;
                }
            }
        }
    }
    let (series, globally_new) = build_series(&labels, &counts);
    let novelty_rate = if unique_words > 0 {
        round1((globally_new as f64 / unique_words as f64) * 100.0)
    } else {
        0.0
    };
    let per_10k = if tokenized_chars > 0 {
        round1((globally_new as f64 / tokenized_chars as f64) * 10_000.0)
    } else {
        0.0
    };

    // Compute cumulative character positions for new words in this game.
    let mut cumulative = 0i64;
    let mut line_end_positions: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, LENGTH(COALESCE(line_text, '')) \
             FROM game_lines WHERE game_id = ?1 AND tokenized = 1 \
             ORDER BY CAST(timestamp AS REAL) ASC, id ASC",
        )?;
        let mut rows = stmt.query([game_id])?;
        while let Some(row) = rows.next()? {
            let id = val_str(row.get_ref(0)?);
            let chars: i64 = row.get(1)?;
            cumulative += chars;
            line_end_positions.insert(id, cumulative);
        }
    }
    let mut positions: Vec<i64> = Vec::new();
    if !line_end_positions.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT w.first_seen_line_id \
             FROM words w JOIN game_lines gl ON gl.id = w.first_seen_line_id \
             WHERE w.first_seen_line_id IS NOT NULL AND gl.game_id = ?1 AND gl.tokenized = 1 \
             ORDER BY CAST(w.first_seen AS REAL) ASC, w.first_seen_line_id ASC",
        )?;
        let mut rows = stmt.query([game_id])?;
        while let Some(row) = rows.next()? {
            let lid = val_str(row.get_ref(0)?);
            if let Some(&pos) = line_end_positions.get(&lid) {
                positions.push(pos);
            }
        }
    }

    Ok(json!({
        "tokenizationStatus": status,
        "vocabulary": {
            "uniqueWordsInGame": unique_words,
            "globallyNewWordsFromGame": globally_new,
            "noveltyRate": novelty_rate,
            "newWordsPer10kChars": per_10k,
            "series": series,
            "defaultBucketSize": DEFAULT_GAME_BUCKET_SIZE,
            "bucketSizeOptions": GAME_BUCKET_SIZE_OPTIONS,
            "totalTokenizedChars": cumulative,
            "newWordCharacterPositions": positions,
        },
    }))
}

fn build_word_novelty_with_archives(
    conn: &Connection,
    status: Value,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    game_id: Option<&str>,
) -> Result<Value> {
    let start_ts = start_date
        .and_then(|d| {
            Local
                .from_local_datetime(&d.and_hms_opt(0, 0, 0)?)
                .earliest()
                .map(|dt| dt.timestamp() as f64)
        })
        .unwrap_or(0.0);
    let end_ts = end_date
        .and_then(|d| d.succ_opt())
        .and_then(|d| {
            Local
                .from_local_datetime(&d.and_hms_opt(0, 0, 0)?)
                .earliest()
                .map(|dt| dt.timestamp() as f64)
        })
        .unwrap_or_else(|| Local::now().timestamp() as f64);

    struct Rec {
        id: String,
        game_id: String,
        ts: f64,
        raw_chars: i64,
    }
    let mut records: Vec<Rec> = Vec::new();

    if table_exists(conn, "archived_game_days") {
        let mut stmt = conn.prepare("SELECT game_id, events FROM archived_game_days")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let gid = val_str(row.get_ref(0)?);
            let blob = row.get_ref(1)?.as_blob()?;
            let events: Vec<ArchivedEvent> =
                serde_json::from_reader(std::io::BufReader::new(ZlibDecoder::new(blob)))?;
            for ev in events {
                if !ev.5.is_truthy() {
                    continue;
                }
                if let Some(lid) = ev.6 {
                    let raw = ev.4.unwrap_or(ev.1) as i64;
                    records.push(Rec {
                        id: lid,
                        game_id: gid.clone(),
                        ts: ev.0,
                        raw_chars: raw,
                    });
                }
            }
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id, game_id, CAST(timestamp AS REAL), LENGTH(COALESCE(line_text, '')) \
             FROM game_lines WHERE tokenized = 1",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            records.push(Rec {
                id: val_str(row.get_ref(0)?),
                game_id: val_str(row.get_ref(1)?),
                ts: val_f64(row.get_ref(2)?).unwrap_or(0.0),
                raw_chars: row.get(3)?,
            });
        }
    }
    records.sort_by(|a, b| a.ts.total_cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
    let by_id: HashMap<&str, usize> = records
        .iter()
        .enumerate()
        .map(|(i, r)| (r.id.as_str(), i))
        .collect();

    let chars: i64 = records
        .iter()
        .filter(|r| {
            r.ts >= start_ts
                && r.ts < end_ts
                && game_id.is_none_or(|gid| r.game_id == gid)
        })
        .map(|r| r.raw_chars)
        .sum();

    let src = "SELECT wo.word_id, gl.game_id, CAST(gl.timestamp AS REAL) AS timestamp, gl.tokenized \
               FROM word_occurrences wo JOIN game_lines gl ON gl.id = wo.line_id \
               UNION ALL \
               SELECT a.word_id, a.game_id, a.first_seen, 1 FROM archived_word_stats a";
    let unique: i64 = match game_id {
        Some(gid) => conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT word_id) FROM ({src}) \
                 WHERE tokenized = 1 AND timestamp >= ?1 AND timestamp < ?2 AND game_id = ?3"
            ),
            params![start_ts, end_ts, gid],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT word_id) FROM ({src}) \
                 WHERE tokenized = 1 AND timestamp >= ?1 AND timestamp < ?2"
            ),
            params![start_ts, end_ts],
            |r| r.get(0),
        )?,
    };

    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut games_counts: HashMap<String, i64> = HashMap::new();
    let mut new_ids: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT first_seen, first_seen_line_id FROM words WHERE first_seen IS NOT NULL",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let Some(ts) = val_f64(row.get_ref(0)?) else {
                continue;
            };
            let lid = val_str(row.get_ref(1)?);
            let Some(&idx) = by_id.get(lid.as_str()) else {
                continue;
            };
            let origin = &records[idx];
            if ts < start_ts || ts >= end_ts || game_id.is_some_and(|gid| origin.game_id != gid) {
                continue;
            }
            if let Ok(d) = local_date(ts) {
                *counts.entry(d.format("%Y-%m-%d").to_string()).or_insert(0) += 1;
            }
            *games_counts.entry(origin.game_id.clone()).or_insert(0) += 1;
            new_ids.push(lid);
        }
    }

    let labels = build_date_labels(start_date, end_date);
    let (series, _) = build_series(&labels, &counts);
    let new_count: i64 = counts.values().sum();
    let per_10k = if chars > 0 {
        round1((new_count as f64 / chars as f64) * 10_000.0)
    } else {
        0.0
    };

    if game_id.is_none() {
        let titles = game_display_titles(conn);
        let mut ranked: Vec<(String, i64)> = games_counts
            .into_iter()
            .map(|(gid, n)| {
                let title = titles.get(&gid).cloned().unwrap_or(gid);
                (title, n)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        return Ok(json!({
            "tokenizationStatus": status,
            "vocabularyStats": {
                "uniqueWordsSeen": unique,
                "newWordsFirstSeen": new_count,
                "newWordsPer10kChars": per_10k,
            },
            "newWordsSeries": series,
            "newWordsByGame": {
                "labels": ranked.iter().map(|(t, _)| t).collect::<Vec<_>>(),
                "totals": ranked.iter().map(|(_, n)| *n).collect::<Vec<_>>(),
            },
        }));
    }

    let gid = game_id.unwrap();
    let mut total = 0i64;
    let mut pos_map: HashMap<&str, i64> = HashMap::new();
    for rec in &records {
        if rec.game_id == gid {
            total += rec.raw_chars;
            pos_map.insert(rec.id.as_str(), total);
        }
    }
    let mut positions: Vec<i64> = new_ids
        .iter()
        .filter_map(|lid| pos_map.get(lid.as_str()).copied())
        .collect();
    positions.sort_unstable();
    let novelty_rate = if unique > 0 {
        round1((new_count as f64 / unique as f64) * 100.0)
    } else {
        0.0
    };

    Ok(json!({
        "tokenizationStatus": status,
        "vocabulary": {
            "uniqueWordsInGame": unique,
            "globallyNewWordsFromGame": new_count,
            "noveltyRate": novelty_rate,
            "newWordsPer10kChars": per_10k,
            "series": series,
            "defaultBucketSize": DEFAULT_GAME_BUCKET_SIZE,
            "bucketSizeOptions": GAME_BUCKET_SIZE_OPTIONS,
            "totalTokenizedChars": total,
            "newWordCharacterPositions": positions,
        },
    }))
}
