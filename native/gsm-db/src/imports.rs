//! Replace a source and insert its validated entries under one commit.
use crate::Result;
use rusqlite::{Connection, TransactionBehavior};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(serde::Deserialize)]
pub struct Entry {
    pub date: String,
    pub characters: i64,
    pub seconds: f64,
    pub source: String,
    pub label: String,
}

const INSERT: &str =
    "INSERT INTO third_party_stats(date,characters_read,time_read_seconds,source,label,
    created_at,game_id,lines_read,source_id) VALUES(?,?,?,?,?,?,'',0,'')";

pub fn add(conn: &Connection, entry: &Entry) -> Result<i64> {
    let created = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
    conn.execute(
        INSERT,
        (
            &entry.date,
            entry.characters,
            entry.seconds,
            &entry.source,
            &entry.label,
            created,
        ),
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn import_file(path: &Path, clear_source: Option<&str>, entries: &[Entry]) -> Result<usize> {
    let mut conn = crate::open_writer(path)?;
    import(&mut conn, clear_source, entries)
}

pub fn import(
    conn: &mut Connection,
    clear_source: Option<&str>,
    entries: &[Entry],
) -> Result<usize> {
    let created = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let cleared = match clear_source {
        Some(source) => tx.execute("DELETE FROM third_party_stats WHERE source=?", [source])?,
        None => 0,
    };
    {
        let mut insert = tx.prepare(INSERT)?;
        for row in entries {
            insert.execute((
                &row.date,
                row.characters,
                row.seconds,
                &row.source,
                &row.label,
                created,
            ))?;
        }
    }
    tx.commit()?;
    Ok(cleared)
}
