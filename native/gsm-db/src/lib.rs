//! Versioned migrations for the primary GSM database.
pub mod backup;
pub mod frequency;
pub mod imports;
pub mod profile;
pub mod startup_jobs;
pub mod vocabulary;
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use std::{collections::HashMap, error::Error, path::Path, time::Duration};

pub type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

pub fn open_writer(path: &Path) -> Result<Connection> {
    writer(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
}

fn writer(path: &Path, flags: OpenFlags) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, flags)?;
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    Ok(conn)
}

const CORE: &str = include_str!("../migrations/001_core.sql");
pub const JITEN_GENRE_BACKFILL: &str = "jiten_genre_backfill";
type Migration = fn(&Transaction<'_>) -> Result<()>;
const MIGRATIONS: &[Migration] = &[
    adopt_core,
    |tx| Ok(tx.execute_batch(include_str!("../migrations/002_stats_indexes.sql"))?),
    |tx| Ok(tx.execute_batch(include_str!("../migrations/003_archives.sql"))?),
    |tx| Ok(tx.execute_batch(include_str!("../migrations/004_goal_dates.sql"))?),
    |tx| Ok(tx.execute_batch(include_str!("../migrations/005_failed_character_summaries.sql"))?),
];

pub fn migrate_file(path: &Path, language: &str) -> Result<()> {
    let mut conn = writer(path, OpenFlags::default())?;
    migrate(&mut conn, language)
}

pub fn open_profile(path: &Path, language: &str) -> Result<Connection> {
    let mut conn = writer(path, OpenFlags::default())?;
    version(&conn)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&mut conn, language)?;
    Ok(conn)
}

/// Called once when a desktop opens a new profile, before its intake starts.
/// Existing profiles are upgraded after the backup and relocation checks.
pub fn create_profile_if_missing(path: &Path) -> Result<bool> {
    if path.try_exists()? {
        return Ok(false);
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => drop(file),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e.into()),
    }
    open_profile(path, "")?;
    Ok(true)
}

fn version(conn: &Connection) -> Result<usize> {
    let n = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, usize>(0))?;
    if n > MIGRATIONS.len() {
        return Err(format!("GSM database schema {n} requires a newer application").into());
    }
    Ok(n)
}

/// Inspect an existing file without creating it. Used to order an enabled
/// startup backup ahead of the first write to an older schema.
pub fn needs_upgrade(path: &Path) -> Result<bool> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(version(&conn)? < MIGRATIONS.len())
}

pub fn migrate(conn: &mut Connection, language: &str) -> Result<()> {
    let language = language.trim();
    let pending_language = !language.is_empty();
    if version(conn)? == MIGRATIONS.len() {
        // Older importers can still insert a line with no language between launches.
        if !pending_language || !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM game_lines WHERE language IS NULL OR trim(language)='')", [], |r| r.get::<_,bool>(0)
        )? { return Ok(()); }
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // A second process may have migrated the file while we waited for the lock.
    for (i, apply) in MIGRATIONS.iter().enumerate().skip(version(&tx)?) {
        apply(&tx).map_err(|e| format!("GSM database migration {} failed: {e}", i + 1))?;
        tx.pragma_update(None, "user_version", i + 1)?;
    }
    if pending_language {
        tx.execute(
            "UPDATE game_lines SET language=? WHERE language IS NULL OR trim(language)=''",
            [language],
        )?;
    }
    Ok(tx.commit()?)
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

struct Column {
    name: String,
    affinity: String,
    default: Option<String>,
    primary_key: bool,
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<Column>> {
    let mut stmt = conn.prepare("SELECT name,type,dflt_value,pk FROM pragma_table_info(?)")?;
    let cols = stmt
        .query_map([table], |r| {
            Ok(Column {
                name: r.get(0)?,
                affinity: r.get(1)?,
                default: r.get(2)?,
                primary_key: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(cols)
}

fn adopt_core(tx: &Transaction<'_>) -> Result<()> {
    let mut existing = tx.prepare("SELECT name FROM sqlite_schema WHERE type='table'")?;
    let tables = existing
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tx.execute_batch(CORE)?;
    if !tables.is_empty() {
        // Read column definitions from the baseline itself. Only historical databases
        // pay for introspection; new tables already have the exact current layout.
        let reference = Connection::open_in_memory()?;
        reference.execute_batch(CORE)?;
        let mut backfill_scenes = false;
        let mut backfill_metadata = false;
        for table in tables {
            let expected = columns(&reference, &table)?;
            if expected.is_empty() {
                continue;
            }
            let actual = columns(tx, &table)?
                .into_iter()
                .map(|c| (c.name.to_ascii_lowercase(), c))
                .collect::<HashMap<_, _>>();
            for col in expected {
                let previous = actual.get(&col.name);
                if col.primary_key && !previous.is_some_and(|c| c.primary_key) {
                    return Err(format!("Incompatible primary key in {table}").into());
                }
                if table == "game_lines" && col.name == "timestamp" {
                    if previous.is_some() && actual.contains_key("timestamp_old") {
                        tx.execute_batch("UPDATE game_lines SET timestamp=timestamp_old WHERE timestamp IS NULL AND timestamp_old IS NOT NULL")?;
                    }
                    if previous.is_none() && actual.contains_key("timestamp_old") {
                        tx.execute_batch(
                            "ALTER TABLE game_lines RENAME COLUMN timestamp_old TO timestamp",
                        )?;
                        convert_timestamp(tx)?;
                        continue;
                    }
                    if previous.is_some_and(|c| !c.affinity.eq_ignore_ascii_case("REAL")) {
                        convert_timestamp(tx)?;
                    }
                }
                if previous.is_none() {
                    let mut sql = format!(
                        "ALTER TABLE {} ADD COLUMN {} {}",
                        quote(&table),
                        quote(&col.name),
                        col.affinity
                    );
                    if let Some(default) = col.default {
                        sql.push_str(" DEFAULT ");
                        sql.push_str(&default);
                    }
                    tx.execute_batch(&sql)?;
                    if table == "games" && matches!(col.name.as_str(), "genres" | "tags") {
                        backfill_metadata = true;
                    }
                    if table == "games" && col.name == "obs_scene_name" {
                        // Populate after every legacy table has acquired its missing columns.
                        backfill_scenes = true;
                    }
                }
            }
        }
        if backfill_scenes {
            tx.execute_batch("WITH scenes AS MATERIALIZED (SELECT game_id,game_name,MIN(rowid) FROM game_lines GROUP BY game_id)
                UPDATE games SET obs_scene_name=(SELECT game_name FROM scenes WHERE game_id=games.id);")?;
        }
        if backfill_metadata {
            // The legacy migration refreshed every linked game, including
            // completed games. Commit the work with the new columns so a
            // closing desktop can resume it without network I/O under DDL.
            tx.execute("INSERT INTO cron_table(name,description,schedule,enabled,next_run,created_at)
                SELECT ?1,'Populate genres and tags on previously linked games','once',1,unixepoch(),unixepoch()
                WHERE EXISTS(SELECT 1 FROM games WHERE CAST(deck_id AS INTEGER)!=0 OR vndb_id!='' OR anilist_id!='')
                AND NOT EXISTS(SELECT 1 FROM cron_table WHERE name=?1)",[JITEN_GENRE_BACKFILL])?;
        }
        repair_cron_dates(tx)?;
    }
    tx.execute_batch(include_str!("../migrations/001_tracking.sql"))?;
    Ok(())
}

fn repair_cron_dates(tx: &Transaction<'_>) -> Result<()> {
    let now = Local::now().timestamp_micros() as f64 / 1e6;
    for field in ["last_run", "next_run", "created_at"] {
        let mut read = tx.prepare(&format!(
            "SELECT id, {field} FROM cron_table WHERE typeof({field})='text' AND {field} != ''"
        ))?;
        let mut repairs = Vec::new();
        let mut rows = read.query([])?;
        while let Some(row) = rows.next()? {
            let text: String = row.get(1)?;
            if text.parse::<f64>().is_ok() {
                continue;
            }
            let iso = text.replace(' ', "T");
            let parsed = DateTime::parse_from_rfc3339(&iso)
                .ok()
                .map(|t| t.timestamp_micros())
                .or_else(|| {
                    let dt = iso
                        .parse::<NaiveDateTime>()
                        .ok()
                        .or_else(|| iso.parse::<NaiveDate>().ok()?.and_hms_opt(0, 0, 0))?;
                    Local
                        .from_local_datetime(&dt)
                        .earliest()
                        .map(|t| t.timestamp_micros())
                });
            let value = parsed
                .map(|us| us as f64 / 1e6)
                .or_else(|| (field != "last_run").then_some(now));
            repairs.push((row.get::<_, i64>(0)?, value));
        }
        if !repairs.is_empty() {
            let mut update = tx.prepare(&format!("UPDATE cron_table SET {field}=? WHERE id=?"))?;
            for (id, value) in repairs {
                update.execute((value, id))?;
            }
        }
    }
    Ok(())
}

// Retain secondary indexes, triggers, unrelated columns and rowids during the
// TEXT to REAL upgrade. SQLite affinity preserves unparseable historical text.
fn convert_timestamp(tx: &Transaction<'_>) -> Result<()> {
    let mut stmt = tx.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='game_lines' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY rowid")?;
    let objects = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (kind, name, _) in &objects {
        tx.execute_batch(&format!("DROP {kind} {}", quote(name)))?;
    }
    tx.execute_batch(
        "ALTER TABLE game_lines ADD COLUMN gsm_timestamp_real REAL;
        UPDATE game_lines SET gsm_timestamp_real=timestamp;
        ALTER TABLE game_lines DROP COLUMN timestamp;
        ALTER TABLE game_lines RENAME COLUMN gsm_timestamp_real TO timestamp;",
    )?;
    for (_, _, sql) in objects {
        tx.execute_batch(&sql)?;
    }
    Ok(())
}

pub fn local_timestamp(local: chrono::NaiveDateTime) -> Result<f64> {
    let fraction = f64::from(local.and_utc().timestamp_subsec_micros()) / 1e6;
    if let Some(instant) = Local.from_local_datetime(&local).earliest() {
        return Ok(instant.timestamp() as f64 + fraction);
    }
    // For a skipped local midnight Python's fold=0 uses the offset before
    // the gap. This also handles whole skipped dates after a dateline change.
    for hours in 1..=48 {
        let before = local
            .checked_sub_signed(chrono::Duration::hours(hours))
            .ok_or("Invalid local midnight")?;
        if let Some(instant) = Local.from_local_datetime(&before).latest() {
            return Ok(
                (local.and_utc().timestamp() - i64::from(instant.offset().local_minus_utc()))
                    as f64
                    + fraction,
            );
        }
    }
    Err("Cannot resolve local midnight".into())
}
