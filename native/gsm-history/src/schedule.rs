//! Persisted schedules share the history writer's close/restore fence. Manual
//! runs have no row and therefore cannot change a recurring job's deadline.
use crate::{capture, rollup::local_timestamp, History, Result};
use chrono::{Duration, Local, NaiveDateTime};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub id: Option<i64>,
    pub name: String,
    pub deadline: f64,
    pub schedule: String,
}

impl Job {
    pub fn forced(name: String) -> Self {
        Self {
            id: None,
            name,
            deadline: 0.0,
            schedule: String::new(),
        }
    }

    pub fn direct(&self) -> bool {
        matches!(self.name.as_str(), "populate_games" | "anki_word_sync")
    }

    fn current(&self, conn: &Connection) -> Result<bool> {
        let Some(id) = self.id else { return Ok(true) };
        let mut stmt = conn.prepare_cached(
            "SELECT 1 FROM cron_table WHERE id=? AND name=? AND enabled=1
            AND coalesce(CAST(next_run AS REAL),0)=? AND coalesce(schedule,'once')=?",
        )?;
        Ok(stmt.exists(params![id, self.name, self.deadline, self.schedule])?)
    }

    fn finish(&self, conn: &Connection, override_time: Option<f64>) -> Result<()> {
        let Some(id) = self.id else { return Ok(()) };
        let now = Local::now();
        let last = now.timestamp_micros() as f64 / 1e6;
        let (next, enabled) = if let Some(next) = override_time {
            (next, true)
        } else {
            recurrence(&self.schedule, last, now.naive_local())?
        };
        let mut stmt = conn.prepare_cached("UPDATE cron_table SET last_run=?,next_run=?,enabled=?
            WHERE id=? AND name=? AND enabled=1 AND coalesce(CAST(next_run AS REAL),0)=? AND coalesce(schedule,'once')=?")?;
        stmt.execute(params![
            last,
            next,
            enabled,
            id,
            self.name,
            self.deadline,
            self.schedule
        ])?;
        Ok(())
    }
}

fn recurrence(schedule: &str, now: f64, local: NaiveDateTime) -> Result<(f64, bool)> {
    let next = match schedule {
        "minutely" => local + Duration::minutes(1),
        "quarter_hourly" => local + Duration::minutes(15),
        "hourly" => local + Duration::hours(1),
        "daily" | "weekly" | "monthly" | "yearly" => {
            let (days, hour, minute) = match schedule {
                "daily" => (1, 0, 1),
                "weekly" => (7, 3, 0),
                "monthly" => (30, 3, 0),
                _ => (365, 3, 0),
            };
            (local.date() + Duration::days(days))
                .and_hms_opt(hour, minute, 0)
                .unwrap()
        }
        // The legacy ORM normalizes unrecognized schedules to "once".
        _ => return Ok((now, false)),
    };
    Ok((local_timestamp(next)?, true))
}

impl History {
    pub fn scheduled_jobs(&self, path: &Path, generation: u64) -> Result<Vec<Job>> {
        self.with_writer_generation(path, Some(generation), |conn| {
            let mut stmt = conn.prepare_cached("SELECT id,coalesce(name,''),coalesce(CAST(next_run AS REAL),0) AS deadline,coalesce(schedule,'once')
                FROM cron_table WHERE enabled=1 ORDER BY deadline,id")?;
            let rows = stmt.query_map([], |r| Ok(Job {
                id: Some(r.get(0)?),
                name: r.get(1)?,
                deadline:r.get(2)?,
                schedule:r.get(3)?,
            }))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    pub fn run_direct_job(&self, path: &Path, generation: u64, job: &Job) -> Result<()> {
        self.with_writer_generation(path, Some(generation), |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if job.current(&tx)? {
                match job.name.as_str() {
                    "populate_games" => {
                        capture::link_game_lines_in(&tx)?;
                    }
                    "anki_word_sync" => {} // Retired; old profiles can still contain the schedule.
                    _ => return Err("Unknown native scheduled job".into()),
                }
                job.finish(&tx, None)?;
            }
            Ok(tx.commit()?)
        })
    }

    pub fn finish_scheduled_job(
        &self,
        path: &Path,
        generation: u64,
        job: &Job,
        override_time: Option<f64>,
    ) -> Result<()> {
        self.with_writer_generation(path, Some(generation), |conn| {
            job.finish(conn, override_time)
        })
    }

    pub fn scheduled_job_current(&self, path: &Path, generation: u64, job: &Job) -> Result<bool> {
        self.with_writer_generation(path, Some(generation), |conn| job.current(conn))
    }
}
