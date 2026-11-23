//! Versioned, feature-scoped schema. Disabling vocabulary removes the derived
//! tables. Archive history retains its independent lifetime.
use crate::{columns, quote, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

const TABLES: &str = include_str!("../migrations/vocabulary_001_tables.sql");
const INDEXES: &str = include_str!("../migrations/vocabulary_001_indexes.sql");
type Migration = fn(&Connection) -> Result<()>;
const MIGRATIONS: &[Migration] = &[install];
const FEATURE_OBJECTS: &str = "SELECT count(*) FROM sqlite_schema WHERE name IN (
    'words','kanji','word_occurrences','kanji_occurrences','anki_notes','anki_cards','anki_reviews',
    'word_anki_links','card_kanji_links','word_stats_cache','global_frequency_sources','word_global_frequencies',
    'trg_game_lines_tokenization_cleanup')";
const DROP:&str="DROP TRIGGER IF EXISTS trg_game_lines_tokenization_cleanup;
    DROP TABLE IF EXISTS card_kanji_links; DROP TABLE IF EXISTS word_anki_links;
    DROP TABLE IF EXISTS anki_reviews; DROP TABLE IF EXISTS anki_cards; DROP TABLE IF EXISTS anki_notes;
    DROP TABLE IF EXISTS word_occurrences; DROP TABLE IF EXISTS kanji_occurrences;
    DROP TABLE IF EXISTS words; DROP TABLE IF EXISTS kanji; DROP TABLE IF EXISTS word_stats_cache;
    DROP TABLE IF EXISTS word_global_frequencies; DROP TABLE IF EXISTS global_frequency_sources;";

fn exists(c: &Connection, name: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name=?)",
        [name],
        |r| r.get(0),
    )
}

pub fn configure_desktop(c: &mut Connection, enabled: bool) -> Result<()> {
    configure_desktop_at(
        c,
        enabled,
        chrono::Utc::now().timestamp_micros() as f64 / 1e6,
    )
}

pub fn configure_desktop_at(c: &mut Connection, enabled: bool, now: f64) -> Result<()> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    apply(&tx, enabled)?;
    crate::startup_jobs::vocabulary_jobs(&tx, enabled, now)?;
    Ok(tx.commit()?)
}

fn version(c: &Connection) -> Result<i64> {
    let v = if exists(c, "gsm_feature_schemas")? {
        c.query_row(
            "SELECT version FROM gsm_feature_schemas WHERE name='vocabulary'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0)
    } else {
        0
    };
    if !(0..=MIGRATIONS.len() as i64).contains(&v) {
        return Err(format!("Unsupported vocabulary schema version {v}").into());
    }
    Ok(v)
}

fn has_tokenized(c: &Connection) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('game_lines') WHERE name='tokenized')",
        [],
        |row| row.get(0),
    )
}

fn current(c: &Connection, enabled: bool) -> Result<bool> {
    let v = version(c)?;
    let objects: i64 = c.query_row(FEATURE_OBJECTS, [], |r| r.get(0))?;
    Ok(if enabled {
        v == MIGRATIONS.len() as i64 && objects == 13
    } else {
        v == 0 && objects == 0 && has_tokenized(c)?
    })
}

pub fn configure(c: &mut Connection, enabled: bool) -> Result<()> {
    if current(c, enabled)? {
        return Ok(());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    apply(&tx, enabled)?;
    Ok(tx.commit()?)
}

fn apply(tx: &rusqlite::Transaction<'_>, enabled: bool) -> Result<()> {
    if current(tx, enabled)? {
        return Ok(());
    }
    if enabled {
        let previous = version(tx)? as usize;
        let objects: i64 = tx.query_row(FEATURE_OBJECTS, [], |r| r.get(0))?;
        let start = if objects == 13 { previous } else { 0 };
        tx.execute_batch("CREATE TABLE IF NOT EXISTS gsm_feature_schemas(name TEXT PRIMARY KEY,version INTEGER NOT NULL)")?;
        for (i, apply) in MIGRATIONS.iter().enumerate().skip(start) {
            apply(tx)?;
            tx.execute("INSERT INTO gsm_feature_schemas(name,version) VALUES('vocabulary',?) ON CONFLICT(name) DO UPDATE SET version=excluded.version",[i+1])?;
        }
    } else {
        if !has_tokenized(tx)? {
            tx.execute_batch("ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0")?;
        }
        tx.execute_batch(DROP)?;
        if exists(tx, "gsm_feature_schemas")? {
            tx.execute(
                "DELETE FROM gsm_feature_schemas WHERE name='vocabulary'",
                [],
            )?;
        }
    }
    Ok(())
}

fn install(c: &Connection) -> Result<()> {
    let had_words = exists(c, "words")?;
    let had_cache = exists(c, "word_stats_cache")?;
    let adopting = c.query_row(FEATURE_OBJECTS, [], |r| r.get::<_, i64>(0))? != 0;
    c.execute_batch(TABLES)?;
    // Older ORM builds added fields incrementally to nine user tables. Preserve
    // their rows, affinities and extra columns during adoption.
    if adopting {
        let reference = Connection::open_in_memory()?;
        reference.execute_batch(TABLES)?;
        for table in [
            "words",
            "kanji",
            "word_occurrences",
            "kanji_occurrences",
            "anki_notes",
            "anki_cards",
            "anki_reviews",
            "word_anki_links",
            "card_kanji_links",
        ] {
            let actual = columns(c, table)?;
            for col in columns(&reference, table)? {
                if !actual.iter().any(|other| other.name == col.name) {
                    if col.primary_key {
                        return Err(format!("Missing primary key in {table}").into());
                    }
                    c.execute_batch(&format!(
                        "ALTER TABLE {} ADD COLUMN {} {}",
                        quote(table),
                        quote(&col.name),
                        col.affinity
                    ))?;
                }
            }
        }
    }
    if !columns(c, "game_lines")?
        .iter()
        .any(|col| col.name == "tokenized")
    {
        c.execute_batch("ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0")?;
    }
    let old_kanji:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_index_list('kanji') WHERE name='idx_kanji_character' AND \"unique\"=0)",[],|r|r.get(0))?;
    if old_kanji {
        // Remap links before enforcing uniqueness. Delete only occurrences that
        // would duplicate the surviving (kanji, line) or (card, kanji) pair.
        c.execute_batch("CREATE TEMP TABLE gsm_kanji_merge(id INTEGER PRIMARY KEY, survivor INTEGER NOT NULL);
            INSERT INTO gsm_kanji_merge SELECT id, keep FROM (SELECT id,MIN(id) OVER (PARTITION BY character) AS keep FROM kanji WHERE character IS NOT NULL) WHERE id!=keep;
            DROP INDEX IF EXISTS idx_kanji_occ_unique; DROP INDEX IF EXISTS idx_card_kanji_links_unique;
            UPDATE kanji_occurrences SET kanji_id=m.survivor FROM gsm_kanji_merge m WHERE kanji_occurrences.kanji_id=CAST(m.id AS TEXT);
            UPDATE card_kanji_links SET kanji_id=m.survivor FROM gsm_kanji_merge m WHERE card_kanji_links.kanji_id=CAST(m.id AS TEXT);
            DELETE FROM kanji WHERE id IN(SELECT id FROM gsm_kanji_merge);
            DROP TABLE gsm_kanji_merge; DROP INDEX idx_kanji_character;
            DELETE FROM card_kanji_links WHERE id NOT IN(SELECT MIN(id) FROM card_kanji_links GROUP BY card_id,kanji_id);")?;
    }
    for (table, index, key) in [
        ("word_occurrences", "idx_word_occ_unique", "word_id"),
        ("kanji_occurrences", "idx_kanji_occ_unique", "kanji_id"),
    ] {
        if !exists(c, index)? {
            c.execute_batch(&format!("DELETE FROM {table} WHERE id NOT IN(SELECT MIN(id) FROM {table} GROUP BY {key},line_id)"))?;
        }
    }
    c.execute_batch(INDEXES)?;
    if exists(c, "archived_word_stats")? {
        c.execute_batch("INSERT OR IGNORE INTO words(id, word, reading, pos, in_anki, first_seen, first_seen_line_id, last_seen)
            SELECT word_id,word,reading,pos,0,first_seen,first_line_id,latest FROM (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY word_id ORDER BY first_seen,first_line_id) AS ordinal,
                    MAX(last_seen) OVER (PARTITION BY word_id) AS latest FROM archived_word_stats
            ) WHERE ordinal=1")?;
    }
    if !had_cache {
        c.execute_batch("DELETE FROM word_stats_cache;
            INSERT INTO word_stats_cache(word_id,occurrence_count,active_global_rank)
            SELECT wo.word_id,count(*),wgf.rank FROM word_occurrences wo JOIN words w ON w.id=wo.word_id
            LEFT JOIN global_frequency_sources gfs ON gfs.is_default=1
            LEFT JOIN word_global_frequencies wgf ON wgf.source_id=gfs.id AND wgf.word=w.word GROUP BY wo.word_id,wgf.rank")?;
    }
    if !had_words {
        c.execute(
            "UPDATE game_lines SET tokenized=0 WHERE tokenized IS NOT 0",
            [],
        )?;
    }
    Ok(())
}
