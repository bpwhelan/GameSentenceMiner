use crate::{
    sessions::{characters, reading_breaks, reading_seconds},
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
    today: NaiveDate,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    day_start: f64,
    day_end: f64,
    session_gap: f64,
}

#[derive(Default, Serialize)]
struct Day {
    characters: i64,
    reading_time_seconds: f64,
}

#[derive(Serialize)]
struct Entry {
    date: NaiveDate,
    timestamp: i64,
    #[serde(flatten)]
    totals: Day,
}

impl Range {
    pub(super) fn read(&self, conn: &Connection) -> Result<Value> {
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
            let mut stmt = conn.prepare(
                "SELECT CAST(timestamp AS REAL), coalesce(line_text,'') FROM game_lines
                WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp",
            )?;
            let mut lines: Vec<(f64, usize)> = stmt
                .query_map(params![self.day_start, self.day_end], |r| {
                    Ok((r.get(0)?, characters(r.get_ref(1)?.as_str()?)))
                })?
                .collect::<rusqlite::Result<_>>()?;
            archive_events(
                conn,
                Some(self.day_start),
                Some(self.day_end),
                |time, chars, _, _, _| {
                    lines.push((time, chars));
                    Ok(())
                },
            )?;
            if !lines.is_empty() {
                lines.sort_by(|a, b| a.0.total_cmp(&b.0));
                let breaks = reading_breaks(conn, self.day_start, self.day_end)?;
                let totals = days.entry(self.today).or_default();
                totals.characters += lines.iter().map(|(_, n)| *n as i64).sum::<i64>();
                for span in lines.chunk_by(|a, b| b.0 - a.0 <= self.session_gap) {
                    totals.reading_time_seconds +=
                        reading_seconds(span.windows(2).map(|p| (p[0].0, p[1].0, p[0].1)), &breaks);
                }
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
