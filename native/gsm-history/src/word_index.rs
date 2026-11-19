//! Index the committed version of captured dialogue. Dictionary analysis happens
//! between the read and write phases, outside the database writer lock.
use crate::{kanji::is_kanji, History, Result};
use rusqlite::{params, types::Value as SqlValue, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Delete expired links and repair derived metadata atomically with the cache.
pub(crate) fn cleanup(conn: &mut rusqlite::Connection) -> Result<usize> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let archived = crate::stats::table_exists(&tx, "archived_word_stats")?;
    let mut deleted = 0;
    for table in ["word_occurrences", "kanji_occurrences"] {
        deleted += tx.execute(
            &format!("DELETE FROM {table} WHERE line_id NOT IN (SELECT id FROM game_lines)"),
            [],
        )?;
    }
    let mut words =
        "DELETE FROM words WHERE id NOT IN (SELECT word_id FROM word_occurrences)".to_owned();
    if archived {
        words.push_str(" AND id NOT IN (SELECT word_id FROM archived_word_stats)");
    }
    if crate::stats::table_exists(&tx, "word_anki_links")? {
        words.push_str(" AND id NOT IN (SELECT word_id FROM word_anki_links)");
    }
    deleted += tx.execute(&words, [])?;
    repair_first_seen(&tx, archived, "id>0 AND (
            (coalesce(trim(first_seen_line_id),'')!='' AND first_seen_line_id NOT IN (SELECT id FROM game_lines))
            OR (id NOT IN (SELECT word_id FROM word_occurrences) AND (first_seen IS NOT NULL OR coalesce(trim(first_seen_line_id),'')!=''))
        )", [])?;
    let mut kanji =
        "DELETE FROM kanji WHERE id NOT IN (SELECT kanji_id FROM kanji_occurrences)".to_owned();
    if crate::stats::table_exists(&tx, "card_kanji_links")? {
        kanji.push_str(" AND id NOT IN (SELECT kanji_id FROM card_kanji_links)");
    }
    deleted += tx.execute(&kanji, [])?;
    if deleted > 0 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS word_stats_cache(
                word_id INTEGER PRIMARY KEY, occurrence_count INTEGER NOT NULL DEFAULT 0, active_global_rank INTEGER DEFAULT NULL);
            DELETE FROM word_stats_cache;
            INSERT INTO word_stats_cache(word_id,occurrence_count,active_global_rank)
            SELECT wo.word_id,count(*),wgf.rank FROM word_occurrences wo
            JOIN words w ON w.id=wo.word_id
            LEFT JOIN global_frequency_sources gfs ON gfs.is_default=1
            LEFT JOIN word_global_frequencies wgf ON wgf.source_id=gfs.id AND wgf.word=w.word
            GROUP BY wo.word_id,wgf.rank")?;
    }
    tx.commit()?;
    Ok(deleted)
}

fn repair_first_seen(
    conn: &rusqlite::Connection,
    archived: bool,
    predicate: &str,
    args: impl rusqlite::Params,
) -> Result<usize> {
    // Older occurrence tables have TEXT affinity for the foreign key while
    // words.id is INTEGER. Cast the outer key to keep the occurrence index
    // usable for each word, including on integer-schema profiles.
    let archives = if archived {
        "UNION ALL SELECT CAST(first_seen AS REAL),CAST(first_line_id AS TEXT) FROM archived_word_stats WHERE word_id=CAST(words.id AS TEXT)"
    } else {
        ""
    };
    Ok(conn.execute(
        &format!(
            "UPDATE words SET (first_seen, first_seen_line_id) = (
        SELECT ts,line FROM (
            SELECT * FROM (
                SELECT coalesce(CAST(gl.timestamp AS REAL),0.0) AS ts, gl.id AS line
                FROM word_occurrences wo JOIN game_lines gl ON gl.id=wo.line_id
                WHERE wo.word_id=CAST(words.id AS TEXT) ORDER BY CAST(gl.timestamp AS REAL),gl.id LIMIT 1
            ) {archives}
        ) ORDER BY ts,line LIMIT 1)
        WHERE {predicate}"
        ),
        args,
    )?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FirstSeenRepair {
    ids: Option<Vec<i64>>,
    only_missing: bool,
}

impl FirstSeenRepair {
    pub(crate) fn run(self, conn: &mut rusqlite::Connection) -> Result<usize> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !crate::stats::table_exists(&tx, "words")?
            || !crate::stats::table_exists(&tx, "word_occurrences")?
        {
            return Ok(0);
        }
        let archived = crate::stats::table_exists(&tx, "archived_word_stats")?;
        let filter = if self.only_missing {
            "(first_seen IS NULL OR coalesce(trim(first_seen_line_id),'')='')"
        } else {
            "1"
        };
        let count = match self.ids {
            Some(ids) => repair_first_seen(
                &tx,
                archived,
                &format!("{filter} AND id IN (SELECT value FROM json_each(?) WHERE value>0)"),
                [serde_json::to_string(&ids)?],
            )?,
            None => repair_first_seen(&tx, archived, filter, [])?,
        };
        tx.commit()?;
        Ok(count)
    }
}

pub struct Line {
    id: String,
    pub text: String,
    timestamp: Option<f64>,
    pub words: Vec<Word>,
}

pub struct Word {
    pub headword: String,
    pub reading: String,
    pub pos: String,
}

#[derive(Deserialize, Serialize)]
pub struct Cursor {
    id: String,
    timestamp: Option<Timestamp>,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum Timestamp {
    Number(f64),
    Text(String),
}

impl History {
    /// Cleanup has its own transaction. A damaged legacy cache need not stop
    /// indexing if the remaining backlog is readable.
    pub fn prepare_word_backfill(&self, path: &Path, generation: u64) -> Result<(usize, usize)> {
        self.with_writer_generation(path, Some(generation), |conn| {
            let cleaned = cleanup(conn).unwrap_or_else(|error| {
                eprintln!("[word-index] Orphan cleanup failed: {error}");
                0
            });
            let count = conn.query_row(
                "SELECT count(*) FROM game_lines WHERE tokenized=0",
                [],
                |row| row.get(0),
            )?;
            Ok((cleaned, count))
        })
    }

    pub fn next_word_page(
        &self,
        path: &Path,
        after: Option<Cursor>,
        limit: usize,
        generation: Option<u64>,
    ) -> Result<(Vec<String>, Option<Cursor>)> {
        self.with_writer_generation(path, generation, |conn| {
            let mut args = vec![SqlValue::Integer(limit as i64)];
            let range = match after {
                None => "",
                Some(Cursor {
                    id,
                    timestamp: None,
                }) => {
                    args.push(id.into());
                    "AND (timestamp IS NOT NULL OR id>?2)"
                }
                Some(Cursor {
                    id,
                    timestamp: Some(timestamp),
                }) => {
                    args.push(match timestamp {
                        Timestamp::Number(n) => n.into(),
                        Timestamp::Text(s) => s.into(),
                    });
                    args.push(id.into());
                    "AND (timestamp,id)>(?2,?3)"
                }
            };
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT id,timestamp FROM game_lines WHERE tokenized=0
                {range} ORDER BY timestamp,id LIMIT ?1"
            ))?;
            let mut rows = stmt.query(rusqlite::params_from_iter(args))?;
            let mut ids = Vec::with_capacity(limit);
            let mut timestamp = None;
            while let Some(row) = rows.next()? {
                ids.push(row.get::<_, String>(0)?);
                timestamp = match row.get(1)? {
                    SqlValue::Integer(n) => Some(Timestamp::Number(n as f64)),
                    SqlValue::Real(n) => Some(Timestamp::Number(n)),
                    SqlValue::Text(s) => Some(Timestamp::Text(s)),
                    SqlValue::Null => None,
                    _ => return Err("Invalid timestamp in word index".into()),
                };
            }
            let cursor = ids.last().map(|id| Cursor {
                id: id.clone(),
                timestamp,
            });
            Ok((ids, cursor))
        })
    }

    pub fn pending_words(
        &self,
        path: &Path,
        ids: &[String],
        generation: Option<u64>,
    ) -> Result<Vec<Line>> {
        self.with_writer_generation(path, generation, |conn| {
            let mut select = conn.prepare_cached(
                "SELECT coalesce(CAST(line_text AS TEXT),''), CAST(nullif(timestamp,'') AS REAL)
                FROM game_lines WHERE id=? AND coalesce(tokenized,0)=0",
            )?;
            let mut lines = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(line) = select
                    .query_row([id], |row| {
                        Ok(Line {
                            id: id.clone(),
                            text: row.get(0)?,
                            timestamp: row.get(1)?,
                            words: Vec::new(),
                        })
                    })
                    .optional()?
                {
                    lines.push(line);
                }
            }
            Ok(lines)
        })
    }

    pub fn store_words(
        &self,
        path: &Path,
        lines: Vec<Line>,
        generation: Option<u64>,
    ) -> Result<usize> {
        if lines.is_empty() {
            return Ok(0);
        }
        self.with_writer_generation(path, generation, |conn| match store_batch(conn, &lines) {
            Ok(()) => Ok(0),
            Err(error)
                if lines.len() > 1
                    && error.sqlite_error_code()
                        == Some(rusqlite::ErrorCode::ConstraintViolation) =>
            {
                // The batch transaction rolled back. Isolate a bad legacy row so
                // its valid neighbours can complete without rerunning Sudachi.
                let mut failed = 0;
                for line in &lines {
                    if let Err(error) = store_batch(conn, std::slice::from_ref(line)) {
                        if error.sqlite_error_code()
                            != Some(rusqlite::ErrorCode::ConstraintViolation)
                        {
                            return Err(error.into());
                        }
                        failed += 1;
                        eprintln!("[word-index] Skipped line {}: {error}", line.id);
                    }
                }
                Ok(failed)
            }
            Err(error) => Err(error.into()),
        })
    }
}

fn store_batch(conn: &mut rusqlite::Connection, lines: &[Line]) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        // Claim exactly the revision we analyzed. The flag, occurrences and
        // trigger-maintained counts roll back together on any failure.
        let mut claim = tx.prepare_cached(
            "UPDATE game_lines SET tokenized=1 WHERE id=?1
                    AND coalesce(tokenized,0)=0 AND coalesce(CAST(line_text AS TEXT),'')=?2
                    AND CAST(nullif(timestamp,'') AS REAL) IS ?3",
        )?;
        let mut word = tx.prepare_cached("INSERT INTO words
                    (word,reading,pos,in_anki,first_seen,first_seen_line_id,last_seen)
                    VALUES (?1,?2,?3,0,?4,CASE WHEN ?4 IS NOT NULL THEN ?5 END,max(0,?4))
                    ON CONFLICT(word) DO UPDATE SET
                    first_seen=CASE WHEN ?4 IS NULL THEN first_seen ELSE coalesce(CAST(first_seen AS REAL),?4) END,
                    first_seen_line_id=CASE WHEN ?4 IS NOT NULL AND coalesce(trim(CAST(first_seen_line_id AS TEXT)),'')=''
                        THEN ?5 ELSE first_seen_line_id END,
                    last_seen=CASE WHEN ?4 IS NULL THEN last_seen ELSE max(coalesce(CAST(last_seen AS REAL),0),?4) END
                    RETURNING id")?;
        let mut word_occ = tx.prepare_cached(
            "INSERT OR IGNORE INTO word_occurrences(word_id,line_id) VALUES (?,?)",
        )?;
        let mut kanji = tx.prepare_cached("INSERT OR IGNORE INTO kanji(character) VALUES (?)")?;
        let mut kanji_occ = tx.prepare_cached(
            "INSERT OR IGNORE INTO kanji_occurrences(kanji_id,line_id)
                    SELECT id,?2 FROM kanji WHERE character=?1",
        )?;
        for line in lines {
            if claim.execute(params![line.id, line.text, line.timestamp])? == 0 {
                continue;
            }
            for token in &line.words {
                let id: i64 = word.query_row(
                    params![
                        token.headword,
                        token.reading,
                        token.pos,
                        line.timestamp,
                        line.id
                    ],
                    |row| row.get(0),
                )?;
                word_occ.execute(params![id, line.id])?;
            }
            let mut utf8 = [0; 4];
            for ch in line.text.chars().filter(is_kanji) {
                let s: &str = ch.encode_utf8(&mut utf8);
                kanji.execute([s])?;
                kanji_occ.execute(params![s, line.id])?;
            }
        }
    }
    tx.commit()
}
