use crate::{
    sessions::{ReportCleaner, reading_breaks, reading_seconds},
    stats::archive_events,
    Result,
};
use chrono::{Local, NaiveDate, NaiveTime, TimeZone};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Range {
    pub today: NaiveDate,
    pub start: Option<NaiveDate>,
    pub end: Option<NaiveDate>,
    pub day_start: f64,
    pub day_end: f64,
    pub session_gap: f64,
}

#[derive(Default, Serialize)]
pub(super) struct Day {
    pub characters: i64,
    pub reading_time_seconds: f64,
}

#[derive(Serialize)]
struct Entry {
    date: NaiveDate,
    timestamp: i64,
    #[serde(flatten)]
    totals: Day,
}

impl Range {
    pub(super) fn read(&self, conn: &Connection, cleaner: &ReportCleaner) -> Result<Value> {
        let mut days = BTreeMap::<NaiveDate, Day>::new();
        let mut stmt = conn.prepare(
            "SELECT date, CAST(coalesce(total_characters,0) AS INTEGER), CAST(coalesce(total_reading_time_seconds,0) AS REAL)
             FROM daily_stats_rollup WHERE date BETWEEN ?1 AND ?2 AND date < ?3
             UNION ALL
             SELECT date, CAST(coalesce(sum(characters_read),0) AS INTEGER), coalesce(sum(time_read_seconds),0)
             FROM third_party_stats WHERE date BETWEEN ?1 AND ?2 GROUP BY date",
        )?;
        let mut rows = stmt.query(params![
            self.start.map(|d| d.to_string()).unwrap_or_default(),
            self.end.unwrap_or(self.today).to_string(),
            self.today.to_string()
        ])?;
        while let Some(row) = rows.next()? {
            let totals = days.entry(row.get_ref(0)?.as_str()?.parse()?).or_default();
            totals.characters += row.get::<_, i64>(1)?;
            totals.reading_time_seconds += row.get::<_, f64>(2)?;
        }
        // The dashboard includes today's entire local day when the end date reaches today.
        if self.end.is_none_or(|end| end >= self.today) {
            if let Some(day) = live_day(conn, cleaner, self.day_start, self.day_end, self.session_gap, None)?
            {
                let totals = days.entry(self.today).or_default();
                totals.characters += day.characters;
                totals.reading_time_seconds += day.reading_time_seconds;
            }
        }
        let mut entries = Vec::with_capacity(days.len());
        for (date, totals) in days {
            let Some(midnight) = Local
                .from_local_datetime(&date.and_time(NaiveTime::MIN))
                .earliest()
            else {
                // A timezone transition skipped local midnight. Let the existing route
                // apply the platform's mktime normalization to this historical date.
                return Ok(Value::Null);
            };
            entries.push(Entry {
                date,
                timestamp: midnight.timestamp(),
                totals,
            });
        }
        Ok(serde_json::to_value(entries)?)
    }
}

/// Return the pieces of the live rollup needed by the overview and projections.
/// A caller interested only in reading time and characters need not load game IDs.
pub(super) fn live_day(
    conn: &Connection,
    cleaner: &ReportCleaner,
    start: f64,
    end: f64,
    session_gap: f64,
    mut games: Option<&mut std::collections::HashSet<String>>,
) -> Result<Option<Day>> {
    let game_column = if games.is_some() { "game_id" } else { "NULL" };
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT CAST(timestamp AS REAL),coalesce(line_text,''),{game_column} FROM game_lines
         WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp"
    ))?;
    let mut rows = stmt.query(params![start, end])?;
    let mut lines = Vec::new();
    let mut chars = 0i64;
    let mut push = |time, count, id: &str| {
        if let Some(ids) = games.as_deref_mut() {
            if !id.trim().is_empty() && !ids.contains(id) {
                ids.insert(id.to_owned());
            }
        }
        lines.push((time, count));
        chars += count as i64;
    };
    while let Some(row) = rows.next()? {
        push(
            row.get::<_, f64>(0)?,
            cleaner.count(row.get_ref(1)?.as_str()?)?,
            row.get_ref(2)?.as_str_or_null()?.unwrap_or(""),
        );
    }
    let mut archived = false;
    archive_events(conn, Some(start), Some(end), |time, count, _, _, id| {
        archived = true;
        push(time, count, id);
        Ok(())
    })?;
    if lines.is_empty() {
        return Ok(None);
    }
    if archived {
        lines.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    let breaks = reading_breaks(conn, start, end)?;
    let seconds = lines
        .chunk_by(|a, b| b.0 - a.0 <= session_gap)
        .map(|span| reading_seconds(span.windows(2).map(|p| (p[0].0, p[1].0, p[0].1)), &breaks))
        .sum();
    Ok(Some(Day {
        characters: chars,
        reading_time_seconds: seconds,
    }))
}
