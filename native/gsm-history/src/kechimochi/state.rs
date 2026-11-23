use super::*;
use crate::stats::table_exists;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::de::DeserializeOwned;
use uuid::Uuid;

fn get<T: DeserializeOwned>(conn: &Connection, key: &str) -> Result<Option<T>> {
    if !table_exists(conn, "kechimochi_sync_state")? {
        return Ok(None);
    }
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM kechimochi_sync_state WHERE key=?",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.as_deref().map(serde_json::from_str).transpose()?)
}
fn put(conn: &Connection, key: &str, value: &impl Serialize) -> Result<()> {
    conn.execute("INSERT INTO kechimochi_sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,serde_json::to_string(value)?])?;
    Ok(())
}
fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS kechimochi_sync_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)")?;
    Ok(())
}
pub(super) fn observed(conn: &Connection) -> Result<BTreeSet<String>> {
    Ok(get(conn, "observed_native")?.unwrap_or_default())
}

impl History {
    pub fn configure_kechimochi(&self, path: &Path, generation: u64, stats: &Value) -> Result<()> {
        self.with_writer_generation(path, Some(generation), |c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            gsm_db::startup_jobs::configure_kechimochi(&tx, stats, chrono::Local::now())?;
            tx.commit()?;
            Ok(())
        })
    }
    pub fn reschedule_kechimochi(
        &self,
        path: &Path,
        generation: u64,
        stats: &Value,
        retry: bool,
    ) -> Result<()> {
        self.with_writer_generation(path,Some(generation),|c|{
            let next=gsm_db::startup_jobs::next_kechimochi_run(stats,chrono::Local::now(),retry)?;
            c.execute("UPDATE cron_table SET next_run=? WHERE id=(SELECT id FROM cron_table WHERE name='kechimochi_sync' AND enabled=1 ORDER BY id LIMIT 1)",[next])?;
            Ok(())
        })
    }
    pub fn kechimochi_deadline(&self, path: &Path) -> Result<Option<f64>> {
        self.with_reader(path,|c|Ok(c.query_row("SELECT CAST(next_run AS REAL) FROM cron_table WHERE name='kechimochi_sync' AND enabled=1 ORDER BY id LIMIT 1",[],|r|r.get(0)).optional()?.flatten()))
    }
    pub fn kechimochi_identity(&self, path: &Path, generation: u64) -> Result<String> {
        self.check_kechimochi_generation(generation)?;
        if let Some(id) = self.with_reader(path, |c| get(c, "source_id"))? {
            return Ok(id);
        }
        self.with_writer_generation(path, Some(generation), |c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            init(&tx)?;
            let id = match get(&tx, "source_id")? {
                Some(id) => id,
                None => {
                    let id = Uuid::new_v4().simple().to_string();
                    put(&tx, "source_id", &id)?;
                    id
                }
            };
            tx.commit()?;
            Ok(id)
        })
    }
    pub fn kechimochi_state(&self, path: &Path, key: &str) -> Result<Option<Value>> {
        self.with_reader(path, |c| get(c, key))
    }
    pub fn save_kechimochi_state(
        &self,
        path: &Path,
        generation: u64,
        key: &str,
        value: &Value,
    ) -> Result<()> {
        self.with_writer_generation(path, Some(generation), |c| put(c, key, value))
    }
    pub fn remember_kechimochi_days(
        &self,
        path: &Path,
        generation: u64,
        days: &BTreeSet<String>,
    ) -> Result<()> {
        self.with_writer_generation(path, Some(generation), |c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            init(&tx)?;
            let mut known = observed(&tx)?;
            if !days.is_subset(&known) {
                known.extend(days.iter().cloned());
                put(&tx, "observed_native", &known)?;
            }
            tx.commit()?;
            Ok(())
        })
    }
    pub fn kechimochi_cover(&self, path: &Path, game_id: &str) -> Result<Option<String>> {
        self.with_reader(path, |c| {
            Ok(
                c.query_row("SELECT image FROM games WHERE id=?", [game_id], |r| {
                    r.get::<_, Option<String>>(0)
                })
                .optional()?
                .flatten(),
            )
        })
    }
}
