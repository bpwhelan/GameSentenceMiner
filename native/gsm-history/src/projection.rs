use crate::{overview::live_day, Result};
use chrono::{Days, NaiveDate};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize)]
pub struct Target {
    pub date: String,
    pub value: i64,
}

#[derive(Deserialize)]
pub struct Projection {
    pub today: NaiveDate,
    pub day_start: f64,
    pub day_end: f64,
    pub session_gap: f64,
    pub hours: Target,
    pub characters: Target,
    pub games: Target,
}

#[derive(Clone, Copy)]
enum Metric {
    Hours,
    Characters,
    Games,
}

impl Projection {
    fn metric(&self, kind: Metric, target: &Target, current: f64, per_day: f64) -> Value {
        // Decimal formatting has the same tie handling as Python round(x, 2).
        let rounded = |v: f64| format!("{v:.2}").parse::<f64>().unwrap_or(v);
        let daily = match kind {
            Metric::Characters => json!(per_day as i64),
            _ => json!(rounded(per_day)),
        };
        let Ok(deadline) = NaiveDate::parse_from_str(&target.date, "%Y-%m-%d") else {
            return json!({"projection":0, "daily_average":daily});
        };
        let value = |v| match kind {
            Metric::Hours => json!(rounded(v)),
            _ => json!(v as i64),
        };
        let days = (deadline - self.today).num_days() as f64;
        json!({"daily_average": daily, "current": value(current), "projection": value(current + days * per_day),
               "target_date": target.date, "target": target.value})
    }

    pub(super) fn read(&self, conn: &Connection, cleaner: &crate::sessions::ReportCleaner) -> Result<Value> {
        let any: bool =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM daily_stats_rollup)", [], |r| {
                r.get(0)
            })?;
        if !any {
            let empty = json!({"projection":0, "daily_average":0});
            return Ok(json!({"hours":empty, "characters":empty, "games":empty}));
        }
        let first = self
            .today
            .checked_sub_days(Days::new(30))
            .ok_or("Invalid projection window")?
            .to_string();
        let targeted =
            |target: &Target| NaiveDate::parse_from_str(&target.date, "%Y-%m-%d").is_ok();
        let game_target = targeted(&self.games);
        let all_time = game_target || targeted(&self.hours) || targeted(&self.characters);
        let mut stmt = conn.prepare_cached(
            "SELECT date, cast(coalesce(total_characters,0) AS INTEGER),
             cast(coalesce(total_reading_time_seconds,0) AS REAL), games_played_ids
             FROM daily_stats_rollup WHERE date>=? AND date<? ORDER BY date",
        )?;
        let mut rows = stmt.query([
            if all_time { "" } else { first.as_str() },
            &self.today.to_string(),
        ])?;
        let (mut chars, mut seconds) = (0i64, 0.0);
        let (mut recent_chars, mut recent_hours) = (0i64, 0.0);
        let (mut recent_games, mut recent_days) = (0usize, 0usize);
        let mut games = HashSet::new();
        while let Some(row) = rows.next()? {
            let recent = row.get_ref(0)?.as_str()? >= first.as_str();
            let characters: i64 = row.get(1)?;
            let time: f64 = row.get(2)?;
            chars += characters;
            seconds += time;
            if recent {
                recent_chars += characters;
                recent_hours += time / 3600.0;
                recent_days += 1;
            }
            if game_target || recent {
                let raw = row.get_ref(3)?.as_str_or_null()?.unwrap_or("");
                if !raw.is_empty() {
                    match serde_json::from_str::<Vec<String>>(raw) {
                        Ok(ids) => {
                            if recent && recent_days <= 30 {
                                recent_games += ids.len();
                            }
                            if game_target {
                                games.extend(ids);
                            }
                        }
                        Err(e) if e.is_syntax() || e.is_eof() => (),
                        Err(e) => return Err(e.into()),
                    }
                }
            }
        }
        let mut live_games = HashSet::new();
        if let Some(day) = live_day(
            conn,
            cleaner,
            self.day_start,
            self.day_end,
            self.session_gap,
            Some(&mut live_games),
        )? {
            chars += day.characters;
            seconds += day.reading_time_seconds;
            recent_chars += day.characters;
            recent_hours += day.reading_time_seconds / 3600.0;
            // The existing API takes the first 30 daily counts including days with zero games.
            if recent_days < 30 {
                recent_games += live_games.len();
            }
            if game_target {
                games.extend(live_games);
            }
        }
        Ok(json!({
            "hours": self.metric(Metric::Hours, &self.hours, seconds / 3600.0, recent_hours / 30.0),
            "characters": self.metric(Metric::Characters, &self.characters, chars as f64, recent_chars as f64 / 30.0),
            "games": self.metric(Metric::Games, &self.games, games.len() as f64, recent_games as f64 / 30.0)
        }))
    }
}
