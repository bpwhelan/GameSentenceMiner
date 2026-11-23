//! Register built-in jobs and the first Tadoku cursor before the scheduler opens a profile.
use crate::{local_timestamp, Result};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDateTime, NaiveTime, Timelike};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

/// Apply the two optional jobs when vocabulary settings change. Old installs
/// may still contain the superseded word-sync job or customized schedules.
pub(crate) fn vocabulary_jobs(
    tx: &rusqlite::Transaction<'_>,
    enabled: bool,
    now: f64,
) -> Result<()> {
    tx.execute(
        "UPDATE cron_table SET enabled=0 WHERE name='anki_word_sync' AND enabled=1",
        [],
    )?;
    for (name, description, schedule) in [
        (
            "tokenize_backfill",
            "Tokenize game lines and clean up orphaned occurrences",
            "weekly",
        ),
        (
            "anki_card_sync",
            "Daily full sync of Anki notes, cards, and reviews to local cache",
            "daily",
        ),
    ] {
        if enabled {
            tx.execute(
                "INSERT INTO cron_table(name,description,schedule,enabled,next_run,created_at)
                SELECT ?1,?2,?3,1,?4,?5 WHERE NOT EXISTS(SELECT 1 FROM cron_table WHERE name=?1)",
                params![name, description, schedule, now - 60., now],
            )?;
            tx.execute(
                "UPDATE cron_table SET enabled=1,next_run=? WHERE id=(SELECT id FROM cron_table
                WHERE name=? ORDER BY id LIMIT 1) AND enabled IS NOT 1",
                params![now - 60., name],
            )?;
        } else {
            tx.execute(
                "UPDATE cron_table SET enabled=0 WHERE name=? AND enabled=1",
                [name],
            )?;
        }
    }
    Ok(())
}

struct Job<'a> {
    name: &'static str,
    description: &'static str,
    schedule: &'a str,
    deadline: f64,
    enabled: bool,
}

fn clock(raw: Option<&str>, default: (u32, u32)) -> NaiveTime {
    raw.and_then(|s| s.split_once(':'))
        .and_then(|(h, m)| NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0))
        .unwrap_or_else(|| NaiveTime::from_hms_opt(default.0, default.1, 0).unwrap())
}

fn next_daytime(now: NaiveDateTime, time: NaiveTime) -> Result<f64> {
    let today = now.date().and_time(time);
    local_timestamp(if today <= now {
        today + Duration::days(1)
    } else {
        today
    })
}

pub fn next_tadoku_run(stats: &Value, now: DateTime<Local>) -> Result<f64> {
    next_daytime(now.naive_local(), clock(stats["tadoku_daily_sync_time"].as_str(), (0, 1)))
}

/// Reconcile the recurring export with the saved wall-clock time. Enabling a
/// previously disabled job schedules its next run in the future.
pub fn configure_tadoku(conn: &Connection, stats: &Value, now: DateTime<Local>) -> Result<()> {
    let enabled = stats["tadoku_daily_sync_enabled"] == true;
    let time = clock(stats["tadoku_daily_sync_time"].as_str(), (0, 1));
    let deadline = next_tadoku_run(stats, now)?;
    let timestamp = now.timestamp_micros() as f64 / 1e6;
    let previous = conn.query_row("SELECT id,coalesce(schedule,''),CAST(next_run AS REAL),enabled=1 FROM cron_table WHERE name='tadoku_sync' ORDER BY id LIMIT 1",[],|row|Ok((
        row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<f64>>(2)?.unwrap_or(timestamp),row.get::<_,Option<bool>>(3)?.unwrap_or(false),
    ))).optional()?;
    if let Some((id, schedule, old, was_enabled)) = previous {
        let same_time = DateTime::from_timestamp_micros((old * 1e6).round() as i64)
            .map(|d| d.with_timezone(&Local).time())
            .is_some_and(|t| (t.hour(), t.minute()) == (time.hour(), time.minute()));
        let next = if !same_time || (enabled && !was_enabled) {
            deadline
        } else {
            old
        };
        if next != old || enabled != was_enabled || schedule != "daily" {
            conn.execute(
                "UPDATE cron_table SET schedule='daily',enabled=?,next_run=? WHERE id=?",
                params![enabled, next, id],
            )?;
        }
    } else {
        conn.execute("INSERT INTO cron_table(name,description,next_run,schedule,enabled,created_at) VALUES('tadoku_sync','Export incremental per-game character counts to Tadoku',?,'daily',?,?)",params![deadline,enabled,timestamp])?;
    }
    Ok(())
}

fn kechimochi_schedule(stats:&Value)-> &'static str {
    match stats["kechimochi_sync_schedule"].as_str() {
        Some("daily") => "daily",
        Some("hourly") => "hourly",
        _ => "quarter_hourly",
    }
}
pub fn next_kechimochi_run(stats:&Value,now:DateTime<Local>,retry:bool)->Result<f64> {
    let local=now.naive_local();
    let deadline = match kechimochi_schedule(stats) {
        "daily" => next_daytime(local, clock(stats["kechimochi_sync_time"].as_str(), (0, 5)))?,
        "hourly" => local_timestamp(local + Duration::hours(1))?,
        _ => local_timestamp(local + Duration::minutes(15))?,
    };
    if retry { Ok(deadline.min(local_timestamp(local+Duration::minutes(15))?)) } else {Ok(deadline)}
}

/// Apply an explicit settings save. Keep an overdue run when the schedule still matches.
pub fn configure_kechimochi(conn:&Connection,stats:&Value,now:DateTime<Local>)->Result<()> {
    let enabled=stats["kechimochi_sync_enabled"]==true;
    let schedule=kechimochi_schedule(stats);
    let next=next_kechimochi_run(stats,now,false)?;
    let timestamp=now.timestamp_micros() as f64/1e6;
    let previous=conn.query_row("SELECT id,coalesce(schedule,''),CAST(next_run AS REAL),enabled=1 FROM cron_table WHERE name='kechimochi_sync' ORDER BY id LIMIT 1",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<f64>>(2)?,r.get::<_,Option<bool>>(3)?.unwrap_or(false)))).optional()?;
    if let Some((id,was,old,was_enabled))=previous{
        let time=clock(stats["kechimochi_sync_time"].as_str(),(0,5));
        let changed_time=schedule=="daily" && old.and_then(|s|DateTime::from_timestamp_micros((s*1e6).round() as i64)).map(|d|d.with_timezone(&Local)).is_none_or(|d|(d.hour(),d.minute())!=(time.hour(),time.minute()));
        let deadline=if (enabled && !was_enabled)||schedule!=was||changed_time {next}else{old.unwrap_or(next)};
        if schedule!=was || was_enabled!=enabled || old!=Some(deadline) {
            conn.execute("UPDATE cron_table SET schedule=?,enabled=?,next_run=? WHERE id=?",params![schedule,enabled,deadline,id])?;
        }
    }else{
        conn.execute("INSERT INTO cron_table(name,description,next_run,schedule,enabled,created_at) VALUES('kechimochi_sync','Reconcile all GSM history and library metadata with Kechimochi',?,?,?,?)",params![next,schedule,enabled,timestamp])?;
    }
    Ok(())
}

/// Re-opening a profile retains completed exports, user-disabled jobs and overdue retries.
pub fn initialize(conn: &mut Connection, stats: &Value, now: DateTime<Local>) -> Result<()> {
    let timestamp = now.timestamp_micros() as f64 / 1e6;
    let local = now.naive_local();
    let km_enabled = stats["kechimochi_sync_enabled"] == true;
    let km_schedule = kechimochi_schedule(stats);
    let km_deadline = next_kechimochi_run(stats,now,false)?;
    let until_sunday = if local.weekday().num_days_from_sunday() == 0 && local.hour() >= 3 {
        7
    } else {
        (7 - local.weekday().num_days_from_sunday()) % 7
    };
    let sunday = (local.date() + Duration::days(i64::from(until_sunday)))
        .and_hms_opt(3, 0, 0)
        .unwrap();
    let hour = local.date().and_hms_opt(local.hour(), 0, 0).unwrap() + Duration::hours(1);
    let yesterday = local_timestamp(local - Duration::days(1))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO stats_export_state(format_key,last_successful_export_at,created_at,updated_at)
        VALUES('tadoku_incremental',?1,?1,?1) ON CONFLICT(format_key) DO UPDATE SET
        last_successful_export_at=excluded.last_successful_export_at,updated_at=excluded.updated_at
        WHERE stats_export_state.last_successful_export_at IS NULL",
        [timestamp],
    )?;
    tx.execute(
        "DELETE FROM cron_table WHERE name IN ('plugins','user_plugins')",
        [],
    )?;
    let mut existing = tx.prepare(
        "SELECT id,coalesce(schedule,''),CAST(next_run AS REAL),enabled=1 FROM cron_table
        WHERE name=? ORDER BY id LIMIT 1",
    )?;
    let mut insert = tx.prepare(
        "INSERT INTO cron_table(name,description,next_run,schedule,enabled,created_at)
        VALUES(?,?,?,?,?,?)",
    )?;
    let jobs = [
        Job {
            name: "jiten_sync",
            description: "Automatically update all linked games from jiten.moe database (respects manual overrides)",
            schedule: "daily",
            deadline: yesterday,
            enabled: true,
        },
        Job {
            name: "populate_games",
            description: "One-time auto-creation of game records from game_lines (runs before rollup)",
            schedule: "weekly",
            deadline: local_timestamp(local-Duration::minutes(2))?,
            enabled: true,
        },
        Job {
            name: "daily_stats_rollup",
            description: "Roll up daily statistics for all dates up to yesterday",
            schedule: "daily",
            deadline: local_timestamp(local-Duration::minutes(1))?,
            enabled: true,
        },
        Job {
            name: "jiten_upgrader",
            description: "Weekly check for games with VNDB/AniList IDs to auto-link to Jiten.moe",
            schedule: "weekly",
            deadline: local_timestamp(sunday)?,
            enabled: true,
        },
        Job {
            name: "daily_goals_completion",
            description: "Hourly check to auto-complete daily goals and update streak",
            schedule: "hourly",
            deadline: local_timestamp(hour)?,
            enabled: true,
        },
        Job {
            name: "database_maintenance",
            description: "Optional database cleanup and game archiving",
            schedule: "daily",
            deadline: timestamp+300.0,
            enabled: true,
        },
        Job {
            name: "kechimochi_sync",
            description: "Reconcile all GSM history and library metadata with Kechimochi",
            schedule: km_schedule,
            deadline: if km_enabled {timestamp} else {km_deadline},
            enabled: km_enabled,
        },
    ];
    for job in jobs {
        let previous = existing
            .query_row([job.name], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<f64>>(2)?.unwrap_or(timestamp),
                    r.get::<_, Option<bool>>(3)?.unwrap_or(false),
                ))
            })
            .optional()?;
        let Some((id, schedule, deadline, enabled)) = previous else {
            insert.execute(params![
                job.name,
                job.description,
                job.deadline,
                job.schedule,
                job.enabled,
                timestamp
            ])?;
            continue;
        };
        let (new_deadline, new_enabled) = match job.name {
            "jiten_sync" if schedule != "daily" => (yesterday, enabled),
            "kechimochi_sync" => (
                if km_enabled && !enabled {
                    timestamp
                } else if schedule != km_schedule {
                    km_deadline
                } else {
                    deadline
                },
                km_enabled,
            ),
            _ => continue,
        };
        if schedule != job.schedule || enabled != new_enabled || deadline != new_deadline {
            tx.execute(
                "UPDATE cron_table SET schedule=?,enabled=?,next_run=? WHERE id=?",
                params![job.schedule, new_enabled, new_deadline, id],
            )?;
        }
    }
    drop((existing, insert));
    configure_tadoku(&tx, stats, now)?;
    Ok(tx.commit()?)
}
