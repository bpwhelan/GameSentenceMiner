//! AnkiConnect's collection is authoritative. Each fetched page commits
//! independently; pruning is a separate operation after a complete full fetch.
use crate::{kanji::is_kanji, History, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct Cache {
    pub history: Arc<History>,
    pub path: PathBuf,
    pub generation: u64,
}

pub fn collection_query(field: &str, note_type: &str) -> Option<String> {
    let field = field.trim();
    if field.is_empty() { return None; }
    let mut query = format!("{field}:_*");
    let note_type = note_type.trim();
    if !note_type.is_empty() {
        query.push_str(&format!(" note:\"{}\"", note_type.replace('"', "\\\"")));
    }
    Some(query)
}

#[derive(Default, Serialize)]
pub struct SyncStatus {
    last_synced: Option<String>,
    pub cache_populated: bool,
    pub anki_connect_available: bool,
    note_count: i64,
    card_count: i64,
    auto_sync_enabled: bool,
    auto_sync_schedule: Option<String>,
    next_auto_sync: Option<String>,
}

fn utc_iso(seconds: f64) -> Option<String> {
    let micros = (seconds * 1e6).round_ties_even();
    if !micros.is_finite() || micros.abs() > i64::MAX as f64 {
        return None;
    }
    let timestamp = chrono::DateTime::from_timestamp_micros(micros as i64)?;
    let precision = if timestamp.timestamp_subsec_micros() == 0 {
        chrono::SecondsFormat::Secs
    } else {
        chrono::SecondsFormat::Micros
    };
    Some(timestamp.to_rfc3339_opts(precision, false))
}

impl History {
    pub fn anki_sync_status(&self, path: &std::path::Path) -> Result<SyncStatus> {
        self.with_reader(path, |conn| {
            let tx = conn.transaction()?;
            let (note_count, last, card_count): (i64, Option<String>, i64) = tx.query_row(
                "SELECT count(*), CAST(max(synced_at) AS TEXT), (SELECT count(*) FROM anki_cards) FROM anki_notes",
                [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
            )?;
            let last_synced = last.map(|s| -> Result<_> {
                utc_iso(s.parse()?).ok_or_else(|| "Invalid Anki sync timestamp".into())
            }).transpose()?;
            let mut status = SyncStatus { last_synced, note_count, card_count, cache_populated: note_count > 0, ..Default::default() };
            // Old profiles can have an Anki cache without an automatic sync job.
            if let Some((enabled, schedule, next)) = tx.query_row(
                "SELECT coalesce(enabled=1,0),coalesce(schedule,''),next_run
                 FROM cron_table WHERE name='anki_card_sync' ORDER BY id LIMIT 1", [],
                |r| Ok((r.get::<_,bool>(0)?,r.get::<_,String>(1)?,r.get(2)?)),
            ).optional().unwrap_or_default() {
                status.auto_sync_enabled = enabled;
                status.auto_sync_schedule = Some(schedule);
                status.next_auto_sync = crate::legacy_timestamp(&next).and_then(utc_iso);
            }
            Ok(status)
        })
    }
}

pub struct Note {
    pub id: i64,
    pub model: String,
    pub fields_json: String,
    pub tags: Vec<String>,
    pub modified: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    #[serde(deserialize_with = "integer")]
    pub card_id: i64,
    #[serde(default, deserialize_with = "integer")]
    note: i64,
    #[serde(default)]
    deck_name: String,
    #[serde(default)]
    queue: i64,
    #[serde(default, rename = "type")]
    kind: i64,
    #[serde(default)]
    due: i64,
    #[serde(default)]
    interval: i64,
    #[serde(default)]
    factor: i64,
    #[serde(default)]
    reps: i64,
    #[serde(default)]
    lapses: i64,
}

pub fn integer<'de, D: serde::Deserializer<'de>>(de: D) -> std::result::Result<i64, D::Error> {
    struct Id;
    impl serde::de::Visitor<'_> for Id {
        type Value = i64;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a signed integer or its decimal string")
        }
        fn visit_i64<E>(self, value: i64) -> std::result::Result<i64, E> {
            Ok(value)
        }
        fn visit_u64<E: serde::de::Error>(self, value: u64) -> std::result::Result<i64, E> {
            i64::try_from(value).map_err(E::custom)
        }
        fn visit_str<E: serde::de::Error>(self, value: &str) -> std::result::Result<i64, E> {
            value.parse().map_err(E::custom)
        }
    }
    de.deserialize_any(Id)
}

#[derive(Deserialize)]
pub struct Review {
    #[serde(default, deserialize_with = "integer")]
    id: i64,
    #[serde(default)]
    ease: i64,
    #[serde(default)]
    ivl: i64,
    #[serde(default, rename = "lastIvl")]
    last_ivl: i64,
    #[serde(default)]
    time: i64,
}

#[derive(Default, Serialize)]
pub struct Deletion {
    stale_notes: usize,
    stale_cards: usize,
    deleted_card_kanji_links: usize,
    deleted_word_anki_links: usize,
    deleted_reviews: usize,
    deleted_cards: usize,
    deleted_notes: usize,
}

impl Cache {
    pub fn check(&self) -> Result<()> {
        if self.history.generation()? != self.generation {
            return Err("Anki sync cancelled because the database closed".into());
        }
        Ok(())
    }

    fn write<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.history
            .with_writer_generation(&self.path, Some(self.generation), |conn| {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let result = f(&tx)?;
                tx.commit()?;
                Ok(result)
            })
    }

    pub fn notes(&self, notes: Vec<Note>) -> Result<usize> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
        self.write(|tx| {
            let mut insert = tx.prepare_cached(
                "INSERT OR REPLACE INTO anki_notes(note_id,model_name,fields_json,tags,mod,synced_at)
                 VALUES(?,?,?,?,?,?)",
            )?;
            for note in &notes {
                insert.execute(params![
                    note.id, note.model, note.fields_json, serde_json::to_string(&note.tags)?,
                    note.modified, now
                ])?;
            }
            Ok(notes.len())
        })
    }

    pub fn cards(&self, cards: Vec<Card>) -> Result<usize> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
        self.write(|tx| {
            let mut insert = tx.prepare_cached(
                "INSERT OR REPLACE INTO anki_cards(card_id,note_id,deck_name,queue,type,due,
                 interval,factor,reps,lapses,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            )?;
            for card in &cards {
                insert.execute(params![
                    card.card_id,
                    card.note,
                    card.deck_name,
                    card.queue,
                    card.kind,
                    card.due,
                    card.interval,
                    card.factor,
                    card.reps,
                    card.lapses,
                    now
                ])?;
            }
            Ok(cards.len())
        })
    }

    pub fn reviews(&self, reviews: HashMap<String, Vec<Review>>, strict: bool) -> Result<usize> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
        self.write(|tx| {
            let mut lookup = tx.prepare_cached(
                "SELECT CAST(note_id AS INTEGER) FROM anki_cards WHERE card_id=?",
            )?;
            let mut insert = tx.prepare_cached(
                "INSERT OR REPLACE INTO anki_reviews(review_id,card_id,note_id,review_time,
                 ease,interval,last_interval,time_taken,synced_at) VALUES(?,?,?,?,?,?,?,?,?)",
            )?;
            let mut count = 0;
            for (key, rows) in reviews {
                let Ok(card) = key.parse::<i64>() else {
                    continue;
                };
                let note_id: Option<i64> =
                    lookup.query_row([card], |r| r.get(0)).optional()?.flatten();
                let Some(note_id) = note_id else {
                    if strict {
                        return Err(format!(
                            "Skipping reviews for card {card}: note_id mapping is missing"
                        )
                        .into());
                    }
                    continue;
                };
                for review in rows {
                    insert.execute(params![
                        format!("{card}_{}", review.id),
                        card,
                        note_id,
                        review.id,
                        review.ease,
                        review.ivl,
                        review.last_ivl,
                        review.time,
                        now
                    ])?;
                    count += 1;
                }
            }
            Ok(count)
        })
    }

    pub fn prune(&self, notes: &[i64], cards: &[i64]) -> Result<Deletion> {
        self.write(|tx| {
            // Match the TEXT affinity of legacy schema keys. Temporary tables
            // participate in this transaction and disappear on rollback.
            tx.execute_batch(
                "CREATE TEMP TABLE sync_live_notes(id TEXT PRIMARY KEY) WITHOUT ROWID;
                 CREATE TEMP TABLE sync_live_cards(id TEXT PRIMARY KEY) WITHOUT ROWID;
                 CREATE TEMP TABLE sync_stale_notes(id TEXT PRIMARY KEY) WITHOUT ROWID;
                 CREATE TEMP TABLE sync_stale_cards(id TEXT PRIMARY KEY) WITHOUT ROWID;",
            )?;
            for (sql, ids) in [
                ("INSERT OR IGNORE INTO sync_live_notes VALUES(?)", notes),
                ("INSERT OR IGNORE INTO sync_live_cards VALUES(?)", cards),
            ] {
                let mut insert = tx.prepare(sql)?;
                for id in ids {
                    insert.execute([id])?;
                }
            }
            tx.execute_batch(
                "INSERT INTO sync_stale_notes SELECT note_id FROM anki_notes
                 WHERE note_id NOT IN sync_live_notes;
                 INSERT INTO sync_stale_cards SELECT card_id FROM anki_cards
                 WHERE card_id NOT IN sync_live_cards OR note_id IN sync_stale_notes;",
            )?;
            let deleted_card_kanji_links = tx.execute(
                "DELETE FROM card_kanji_links WHERE card_id IN sync_stale_cards",
                [],
            )?;
            let deleted_word_anki_links = tx.execute(
                "DELETE FROM word_anki_links WHERE note_id IN sync_stale_notes",
                [],
            )?;
            let deleted_reviews = tx.execute(
                "DELETE FROM anki_reviews WHERE card_id IN sync_stale_cards",
                [],
            )?;
            let deleted_cards = tx.execute(
                "DELETE FROM anki_cards WHERE card_id IN sync_stale_cards",
                [],
            )?;
            let deleted_notes = tx.execute(
                "DELETE FROM anki_notes WHERE note_id IN sync_stale_notes",
                [],
            )?;
            // Full rebuilds also repair links whose parent disappeared before this run.
            tx.execute_batch(
                "DELETE FROM word_anki_links WHERE NOT EXISTS(
                     SELECT 1 FROM anki_notes n WHERE n.note_id=word_anki_links.note_id);
                 DELETE FROM card_kanji_links WHERE NOT EXISTS(
                     SELECT 1 FROM anki_cards c JOIN anki_notes n ON n.note_id=c.note_id
                     WHERE c.card_id=card_kanji_links.card_id);
                 DROP TABLE sync_live_notes;
                 DROP TABLE sync_live_cards;
                 DROP TABLE sync_stale_cards;
                 DROP TABLE sync_stale_notes;",
            )?;
            Ok(Deletion {
                stale_notes: deleted_notes,
                stale_cards: deleted_cards,
                deleted_card_kanji_links,
                deleted_word_anki_links,
                deleted_reviews,
                deleted_cards,
                deleted_notes,
            })
        })
    }

    pub fn links(&self, ids: &[i64], field: &str) -> Result<(usize, usize)> {
        // Release the writer between groups so foreground mining writes can run.
        self.write(|tx| {
            let mut note_fields = tx.prepare_cached("SELECT fields_json FROM anki_notes WHERE note_id=?")?;
            let mut word = tx.prepare_cached("SELECT id FROM words WHERE word=?")?;
            let mut remove_word = tx.prepare_cached(
                "DELETE FROM word_anki_links WHERE note_id=? AND (word_id IS NULL OR word_id IS NOT ?)",
            )?;
            let mut add_word = tx.prepare_cached(
                "INSERT INTO word_anki_links(word_id,note_id) SELECT ?1,?2 WHERE NOT EXISTS(
                 SELECT 1 FROM word_anki_links WHERE word_id=?1 AND note_id=?2)",
            )?;
            let mut find_kanji = tx.prepare_cached("SELECT id FROM kanji WHERE character=?")?;
            let mut new_kanji = tx.prepare_cached("INSERT INTO kanji(character) VALUES(?)")?;
            let mut cards = tx.prepare_cached("SELECT CAST(card_id AS INTEGER) FROM anki_cards WHERE note_id=?")?;
            let mut existing = tx.prepare_cached(
                "SELECT rowid, CASE WHEN kanji_id=CAST(CAST(kanji_id AS INTEGER) AS TEXT)
                 THEN CAST(kanji_id AS INTEGER) END FROM card_kanji_links WHERE card_id=?",
            )?;
            let mut unlink = tx.prepare_cached("DELETE FROM card_kanji_links WHERE rowid=?")?;
            let mut link = tx.prepare_cached("INSERT INTO card_kanji_links(card_id,kanji_id) VALUES(?,?)")?;
            let mut kanji_ids = HashMap::<char,i64>::new();
            let mut wanted = HashSet::new();
            let mut present = HashSet::new();
            let mut obsolete = Vec::new();
            let (mut words, mut characters) = (0, 0);
            for id in ids {
                let raw: Option<String> = note_fields.query_row([id], |r| r.get(0)).optional()?.flatten();
                let fields = raw.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok());
                let value = fields.as_ref()
                    .and_then(|v| v.get(field)?.get("value")?.as_str())
                    .unwrap_or("")
                    .trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c));
                let word_id: Option<i64> = if value.is_empty() {
                    None
                } else {
                    word.query_row([value], |r| r.get(0)).optional()?
                };
                remove_word.execute(params![id, word_id])?;
                if let Some(word_id) = word_id {
                    add_word.execute(params![word_id, id])?;
                    words += 1;
                }
                wanted.clear();
                for ch in value.chars().filter(is_kanji) {
                    let key = match kanji_ids.entry(ch) {
                        std::collections::hash_map::Entry::Occupied(entry) => *entry.get(),
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            let mut buf = [0; 4];
                            let text: &str = ch.encode_utf8(&mut buf);
                            let key = match find_kanji.query_row([text], |r| r.get(0)).optional()? {
                                Some(id) => id,
                                None => {
                                    new_kanji.execute([text])?;
                                    tx.last_insert_rowid()
                                }
                            };
                            *entry.insert(key)
                        }
                    };
                    wanted.insert(key);
                }

                let mut card_rows = cards.query([id])?;
                while let Some(row) = card_rows.next()? {
                    let card: i64 = row.get(0)?;
                    present.clear();
                    obsolete.clear();
                    let mut current = existing.query([card])?;
                    while let Some(row) = current.next()? {
                        match row.get::<_, Option<i64>>(1)? {
                            Some(key) if wanted.contains(&key) && present.insert(key) => (),
                            _ => obsolete.push(row.get::<_, i64>(0)?),
                        }
                    }
                    drop(current);
                    for rowid in &obsolete {
                        unlink.execute([rowid])?;
                    }
                    for key in wanted.difference(&present) {
                        link.execute(params![card, key])?;
                    }
                    characters += wanted.len();
                }
            }
            Ok((words, characters))
        })
    }

    pub fn flags(&self) -> Result<usize> {
        self.write(|tx| {
            tx.execute_batch(
                "UPDATE words SET in_anki=1 WHERE in_anki IS NOT 1
                 AND id IN (SELECT word_id FROM word_anki_links WHERE word_id IS NOT NULL);
                 UPDATE words SET in_anki=0 WHERE in_anki IS NOT 0
                 AND id NOT IN (SELECT word_id FROM word_anki_links WHERE word_id IS NOT NULL);",
            )?;
            // Existing callers report the number of words considered.
            Ok(tx.query_row("SELECT count(*) FROM words", [], |r| r.get(0))?)
        })
    }
}

pub fn cached_fields(field: &str, value: Option<&str>) -> String {
    value
        .map(|text| json!({(field):{"value":text}}).to_string())
        .unwrap_or_else(|| "{}".into())
}
