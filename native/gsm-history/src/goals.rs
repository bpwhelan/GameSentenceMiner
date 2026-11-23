use crate::Result;
use chrono::NaiveDate;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};

pub enum GoalSettingsEdit {
    Replace(Map<String, Value>),
    Merge(Map<String, Value>),
}

fn versions(value: u8) -> Value {
    json!({"goals":value, "easyDays":value, "ankiConnect":value})
}

fn default_settings() -> Value {
    json!({
        "easyDays":{"monday":100,"tuesday":100,"wednesday":100,"thursday":100,
            "friday":100,"saturday":100,"sunday":100},
        "ankiConnect":{"deckName":""}, "customCheckboxes":{}
    })
}

fn field(text: Option<String>, fallback: impl FnOnce() -> Value) -> Value {
    text.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(fallback)
}

pub(super) fn latest(conn: &Connection) -> Result<Value> {
    let row = conn
        .query_row(
            "SELECT date,current_goals,goals_settings,goals_version FROM goals
         WHERE date!='current' ORDER BY date DESC,id ASC LIMIT 1",
            [],
            |r| {
                Ok(json!({
                    "date":r.get::<_,String>(0)?,
                    "current_goals":field(r.get(1)?,|| json!([])),
                    "goals_settings":field(r.get(2)?,|| json!({})),
                    "versions":field(r.get(3)?,|| versions(1))
                }))
            },
        )
        .optional()?;
    Ok(row.unwrap_or_else(
        || json!({"date":null,"current_goals":[],"goals_settings":{},"versions":versions(0)}),
    ))
}

pub(super) fn reading_pace(
    conn: &Connection,
    cleaner: &crate::ReportCleaner,
    today: NaiveDate,
    day_start: f64,
    day_end: f64,
    session_gap: f64,
) -> Result<Value> {
    // The published denominator is 30 calendar days. Its numerator includes
    // the previous 30 full days plus today's live reading and imports.
    let first = today
        .checked_sub_days(chrono::Days::new(30))
        .ok_or("Invalid pace window")?;
    let (mut characters, mut seconds): (i64, f64) = conn.query_row(
        "SELECT coalesce(sum(chars),0),coalesce(sum(seconds),0) FROM (
           SELECT sum(CAST(total_characters AS INTEGER)) AS chars,sum(total_reading_time_seconds) AS seconds
           FROM daily_stats_rollup WHERE date >= ?1 AND date < ?2
           UNION ALL
           SELECT sum(characters_read),sum(time_read_seconds) FROM third_party_stats WHERE date BETWEEN ?1 AND ?2
         )", [first.to_string(), today.to_string()], |r| Ok((r.get(0)?,r.get(1)?)),
    )?;
    if let Some(day) =
        crate::overview::live_day(conn, cleaner, day_start, day_end, session_gap, None)?
    {
        characters += day.characters;
        seconds += day.reading_time_seconds;
    }
    let hours = seconds / 3600.0;
    let pace = if seconds > 0.0 {
        (characters as f64 / seconds * 3600.0) as i64
    } else {
        0
    };
    Ok(json!({
        "pace_cph":pace, "total_characters":characters, "total_hours":format!("{hours:.2}").parse::<f64>()?,
        "days_analyzed":30, "average_characters_per_day":characters.max(0) / 30,
        "average_hours_per_day":format!("{:.2}",hours.max(0.0)/30.0).parse::<f64>()?,
    }))
}

pub(super) fn current(conn: &Connection) -> Result<Option<Value>> {
    let entry = conn
        .query_row(
            "SELECT current_goals,goals_settings,last_updated FROM goals
         WHERE date='current' ORDER BY id LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((goals, settings, updated)) = entry else {
        return Ok(None);
    };
    let updated = crate::legacy_timestamp(&updated);
    let mut settings = field(settings, || json!({}));
    if let Some(map) = settings.as_object_mut() {
        if let Value::Object(defaults) = default_settings() {
            for (key, value) in defaults {
                map.entry(key).or_insert(value);
            }
        }
    } else {
        settings = default_settings();
    }
    Ok(Some(
        json!({"current_goals":field(goals, || json!([])), "goals_settings":settings, "last_updated":updated}),
    ))
}

fn ensure_current(conn: &Connection, now: f64) -> Result<()> {
    conn.execute(
        "INSERT INTO goals(date,current_goals,goals_settings,last_updated,goals_version)
         SELECT 'current','[]',?,?,? WHERE NOT EXISTS(SELECT 1 FROM goals WHERE date='current')",
        (default_settings().to_string(), now, versions(1).to_string()),
    )?;
    Ok(())
}

fn now_seconds() -> Result<f64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs_f64())
}

pub(super) fn create_current(conn: &mut Connection) -> Result<Value> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    ensure_current(&tx, now_seconds()?)?;
    let value = current(&tx)?.ok_or("Current goals row missing after initialization")?;
    tx.commit()?;
    Ok(value)
}

pub(super) fn update(
    conn: &mut Connection,
    goals: Option<Vec<Value>>,
    edit: Option<GoalSettingsEdit>,
) -> Result<Value> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now_seconds()?;
    let row = tx.query_row(
        "SELECT id,CASE WHEN ? THEN goals_settings END FROM goals WHERE date='current' ORDER BY id LIMIT 1",
        [matches!(edit, Some(GoalSettingsEdit::Merge(_)))],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
    ).optional()?;
    let (id, old_settings) = if let Some(row) = row {
        row
    } else {
        ensure_current(&tx, now)?;
        (tx.last_insert_rowid(), Some(default_settings().to_string()))
    };
    let settings = match edit {
        Some(GoalSettingsEdit::Replace(map)) => Some(Value::Object(map)),
        Some(GoalSettingsEdit::Merge(patch)) => {
            let mut base: Map<String, Value> = old_settings
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            for (key, value) in patch {
                if let Value::Object(part) = value {
                    if let Some(Value::Object(nested)) = base.get_mut(&key) {
                        nested.extend(part);
                    } else {
                        base.insert(key, Value::Object(part));
                    }
                } else {
                    base.insert(key, value);
                }
            }
            Some(Value::Object(base))
        }
        None => None,
    };
    tx.execute(
        "UPDATE goals SET current_goals=coalesce(?,current_goals),goals_settings=coalesce(?,goals_settings),last_updated=? WHERE id=?",
        (goals.map(|g| Value::Array(g).to_string()), settings.map(|s| s.to_string()), now.to_string(), id),
    )?;
    tx.commit()?;
    Ok(json!({"success":true,"last_updated":now}))
}

pub(super) fn complete(conn: &mut Connection, today: NaiveDate) -> Result<Value> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let value=complete_in(&tx,today)?;
    tx.commit()?;
    Ok(value)
}

fn complete_in(tx:&rusqlite::Transaction<'_>,today:NaiveDate)->Result<Value>{
    let date = today.to_string();
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM goals WHERE date=?)",
        [&date],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(
            json!({"success":false,"error":"Dailies already completed for today","date":today}),
        );
    }
    let entry = tx.query_row(
        "SELECT id,current_goals,goals_settings FROM goals WHERE date='current' ORDER BY id LIMIT 1",
        [], |r| Ok((r.get::<_,i64>(0)?,r.get(1)?,r.get(2)?)),
    ).optional()?;
    let Some((id, goals, settings)) = entry else {
        return Ok(
            json!({"success":false,"error":"No current goals found. Please set up your goals first."}),
        );
    };
    let mut settings = field(settings, || json!({}));
    let settings_map = settings
        .as_object_mut()
        .ok_or("Invalid current goals settings")?;
    // Preserve the existing completion response: calculate against history before
    // inserting today. The first completion starts with a one-day streak.
    let report = streak(tx, today)?;
    let (count, longest) = if report.last_completion_date.is_none() {
        (1, 1)
    } else {
        (report.streak, report.longest_streak)
    };
    settings_map.insert("longestStreak".into(), longest.into());
    let settings = settings.to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs_f64();
    tx.execute("INSERT INTO goals(date,current_goals,goals_settings,last_updated,goals_version) VALUES(?,?,?,?,?)",
        (&date,field(goals,|| json!([])).to_string(),&settings,now,versions(1).to_string()))?;
    tx.execute(
        "UPDATE goals SET goals_settings=?,last_updated=? WHERE id=?",
        (&settings, now, id),
    )?;
    Ok(
        json!({"success":true,"date":today,"streak":count,"longest_streak":longest,
        "message":format!("Dailies completed! Current streak: {count} days")}),
    )
}

impl crate::History {
    pub fn goal_cron_last_run(&self,path:&std::path::Path)->Result<Option<f64>>{
        self.with_reader(path,|c|{
            let value=c.query_row("SELECT last_run FROM cron_table WHERE name='daily_goals_completion' ORDER BY id LIMIT 1",[],|r|r.get::<_,rusqlite::types::Value>(0)).optional()?;
            Ok(value.as_ref().and_then(crate::legacy_timestamp))
        })
    }
    pub fn goals_completed_on(&self,path:&std::path::Path,day:NaiveDate)->Result<bool>{
        self.with_reader(path,|c|Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM goals WHERE date=?)",[day.to_string()],|r|r.get(0))?))
    }
    pub fn complete_scheduled_goals(&self,path:&std::path::Path,generation:u64,day:NaiveDate,source:&Value)->Result<bool>{
        self.with_writer_generation(path,Some(generation),|c|{
            let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            // A goals edit during evaluation invalidates the decision to award that day's streak.
            if current(&tx)?.as_ref()!=Some(source){return Ok(false);}
            complete_in(&tx,day)?;
            tx.commit()?;Ok(true)
        })
    }
}

#[derive(Default, serde::Serialize)]
pub(super) struct Streak {
    streak: i64,
    longest_streak: i64,
    last_completion_date: Option<String>,
}

pub(super) fn streak(conn: &Connection, today: NaiveDate) -> Result<Streak> {
    let latest = conn.query_row(
        "SELECT date,goals_settings FROM goals WHERE date!='current' ORDER BY date DESC,id ASC LIMIT 1",
        [], |r| Ok((r.get::<_,String>(0)?,r.get(1)?)),
    ).optional()?;
    let Some((last, settings)) = latest else {
        return Ok(Streak::default());
    };
    let settings = field(settings, || json!({}));
    let record = match settings.get("longestStreak") {
        Some(value) => value.as_i64().ok_or("Unsupported historical streak")?,
        None => 0,
    };
    let Ok(last_day) = NaiveDate::parse_from_str(&last, "%Y-%m-%d") else {
        return Ok(Streak {
            streak: 1,
            longest_streak: record.max(1),
            last_completion_date: Some(last),
        });
    };
    let mut count = 0;
    if last_day == today || Some(last_day) == today.pred_opt() {
        // Walk the covering index until the first gap. Reading dates alone avoids
        // loading the goals and settings documents for every historical completion.
        let mut stmt = conn.prepare_cached(
            "SELECT date FROM goals WHERE date<=? AND date!='current' ORDER BY date DESC,id ASC",
        )?;
        let mut rows = stmt.query([&last])?;
        let mut expected = Some(last_day);
        while let Some(row) = rows.next()? {
            let day = NaiveDate::parse_from_str(row.get_ref(0)?.as_str()?, "%Y-%m-%d")?;
            if Some(day) != expected {
                break;
            }
            count += 1;
            expected = day.pred_opt();
        }
    }
    Ok(Streak {
        streak: count,
        longest_streak: record.max(count),
        last_completion_date: Some(last),
    })
}
