//! Weekly reading, mining and first-mature items for the Anki statistics page.
use crate::{
    anki_coverage::date_from_ms, anki_games, game_stats, maturity, sessions::reading_breaks,
    ReportCleaner, Result,
};
use caseless::Caseless;
use chrono::{Datelike, Days, NaiveDate};
use indexmap::IndexMap;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct Report {
    pub today: NaiveDate,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub lag_weeks: i64,
    pub session_gap: f64,
    pub tokenization: bool,
    pub word_field: String,
    pub parent_tag: String,
    pub details: bool,
}

#[derive(Default)]
struct Week {
    chars: i64,
    hours: f64,
    cards: i64,
}

#[derive(Default)]
struct Activity {
    title: String,
    chars: i64,
    seconds: f64,
}

type Games = IndexMap<String, Activity>;

fn monday(date: NaiveDate) -> NaiveDate {
    date - Days::new(u64::from(date.weekday().num_days_from_monday()))
}

fn hours_rounded(hours: f64) -> Result<f64> {
    // Match Python round(value, 2) at binary floating-point ties.
    Ok(format!("{hours:.2}").parse()?)
}

fn normal_name(name: &str) -> String {
    let mut result = String::with_capacity(name.len());
    let mut separate = false;
    for ch in name.chars().default_case_fold() {
        if ch.is_alphanumeric() {
            if separate {
                result.push(' ');
            }
            separate = false;
            result.push(ch);
        } else {
            separate = !result.is_empty();
        }
    }
    result
}

fn add_game(games: &mut Games, id: String, title: &str, chars: i64, seconds: f64) {
    let game = games.entry(id).or_default();
    if game.title.is_empty() {
        game.title.push_str(title);
    }
    game.chars += chars;
    game.seconds += seconds;
}

fn merge_stored(games: &mut Games, raw: &str) {
    let Ok(activity) = serde_json::from_str::<IndexMap<String, Value>>(raw) else {
        return;
    };
    for (id, data) in activity {
        let Some(fields) = data.as_object() else {
            continue;
        };
        let fallback;
        let title = match fields.get("title") {
            None => {
                fallback = format!("Game {id}");
                &fallback
            }
            Some(title) => title.as_str().unwrap_or(""),
        };
        let chars = data["chars"]
            .as_i64()
            .or_else(|| data["chars"].as_str()?.parse().ok())
            .unwrap_or(0);
        let seconds = data["time"]
            .as_f64()
            .or_else(|| data["time"].as_str()?.parse().ok())
            .unwrap_or(0.0);
        add_game(games, id, title, chars, seconds);
    }
}

impl Report {
    fn range(&self, conn: &Connection) -> Result<(NaiveDate, NaiveDate)> {
        let start = if let Some(ms) = self.start {
            date_from_ms(ms)
        } else {
            let first: Option<String> = conn
                .query_row(
                    "SELECT date FROM daily_stats_rollup ORDER BY date LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            Some(
                first
                    .and_then(|s| s.parse::<NaiveDate>().ok())
                    .filter(|d| (1..=9999).contains(&d.year()))
                    .unwrap_or(self.today),
            )
        };
        let end = self.end.map_or(Some(self.today), date_from_ms);
        Ok(match (start, end) {
            (Some(a), Some(b)) => (a.min(b).min(self.today), a.max(b).min(self.today)),
            _ => (self.today, self.today),
        })
    }

    fn live(
        &self,
        conn: &Connection,
        cleaner: &ReportCleaner,
        week: &mut Week,
        games: &mut Games,
    ) -> Result<()> {
        let start = gsm_db::local_timestamp(self.today.and_time(chrono::NaiveTime::MIN))?;
        let end = gsm_db::local_timestamp(
            self.today
                .and_hms_micro_opt(23, 59, 59, 999_999)
                .ok_or("Invalid day end")?,
        )?;
        let lines = game_stats::lines_for_day(conn, cleaner, start, end)?;
        if lines.is_empty() {
            return Ok(());
        }
        let breaks = reading_breaks(conn, start, end)?;
        let mut samples = Vec::with_capacity(lines.len());
        let mut groups: IndexMap<&str, (&str, Vec<(f64, usize)>)> = IndexMap::new();
        for line in &lines {
            week.chars += line.chars as i64;
            week.cards += line.cards;
            samples.push((line.ts, line.chars));
            if self.details && !line.game_id.trim().is_empty() {
                let (scene, samples) = groups.entry(&line.game_id).or_default();
                if scene.is_empty() {
                    *scene = &line.game_name;
                }
                samples.push((line.ts, line.chars));
            }
        }
        let seconds = |samples: &[(f64, usize)]| {
            game_stats::calc_reading_time(samples, self.session_gap, &breaks)
        };
        week.hours += seconds(&samples) / 3600.0;
        if !groups.is_empty() {
            let mut lookup = conn.prepare_cached("SELECT title_original FROM games WHERE id=?")?;
            for (id, (scene, samples)) in groups {
                let title: Option<String> =
                    lookup.query_row([id], |r| r.get(0)).optional()?.flatten();
                let title = title.filter(|s| !s.is_empty()).unwrap_or_else(|| {
                    if scene.is_empty() {
                        format!("Game {}", id.chars().take(8).collect::<String>())
                    } else {
                        scene.to_owned()
                    }
                });
                add_game(
                    games,
                    id.to_owned(),
                    &title,
                    samples.iter().map(|s| s.1 as i64).sum(),
                    seconds(&samples),
                );
            }
        }
        Ok(())
    }

    fn per_game(&self, conn: &Connection, games: Games) -> Result<Vec<Value>> {
        if games.is_empty() {
            return Ok(Vec::new());
        }
        let mut totals = HashMap::<String, (i64, f64)>::new();
        for game in games.into_values() {
            let name = normal_name(&game.title);
            if !name.is_empty() {
                let entry = totals.entry(name).or_default();
                entry.0 += game.chars;
                entry.1 += game.seconds / 3600.0;
            }
        }
        let reports = anki_games::Report {
            parent_tag: self.parent_tag.clone(),
            start: self.start,
            end: self.end,
        }
        .read(conn, anki_games::Grouping::Game)?;
        let mut matched = Vec::new();
        for game in reports.as_array().into_iter().flatten() {
            let Some(name) = game["game_name"].as_str() else {
                continue;
            };
            let Some(&(chars, hours)) = totals.get(&normal_name(name)) else {
                continue;
            };
            let cards = game["card_count"].as_i64().unwrap_or(0);
            if chars > 0 && cards > 0 {
                matched.push((std::cmp::Reverse((chars,cards)), json!({"game_name":name, "reading_chars":chars,
                    "reading_hours":hours_rounded(hours)?, "card_count":cards,"retention_pct":game["retention_pct"],
                    "avg_time_per_card":game["avg_time_per_card"],"total_reviews":game["total_reviews"]})));
            }
        }
        matched.sort_by_key(|(key, _)| *key);
        Ok(matched.into_iter().map(|(_, row)| row).collect())
    }

    pub(super) fn read(&self, conn: &Connection, cleaner: &ReportCleaner) -> Result<Value> {
        let (start, end) = self.range(conn)?;
        let first = monday(start);
        let index = |day: NaiveDate| ((day - first).num_days() / 7) as usize;
        let labels: Vec<_> = (0..=index(end))
            .map(|i| first + Days::new(i as u64 * 7))
            .collect();
        let mut weeks: Vec<_> = labels.iter().map(|_| Week::default()).collect();
        let mut games = Games::new();
        let activity_column = if self.details {
            "game_activity_data"
        } else {
            "NULL"
        };
        let mut stmt = conn.prepare_cached(&format!("SELECT date,coalesce(CAST(total_characters AS INTEGER),0),
            coalesce(CAST(total_reading_time_seconds AS REAL),0),coalesce(CAST(anki_cards_created AS INTEGER),0),{activity_column}
            FROM daily_stats_rollup WHERE date BETWEEN ? AND ? AND date<? ORDER BY date"))?;
        let mut rows = stmt.query(params![
            start.to_string(),
            end.to_string(),
            self.today.to_string()
        ])?;
        while let Some(row) = rows.next()? {
            let Ok(day) = row.get_ref(0)?.as_str()?.parse::<NaiveDate>() else {
                continue;
            };
            if !(start..=end).contains(&day) {
                continue;
            }
            let week = &mut weeks[index(day)];
            week.chars += row.get::<_, i64>(1)?;
            week.hours += row.get::<_, f64>(2)? / 3600.0;
            week.cards += row.get::<_, i64>(3)?;
            if let Some(raw) = row.get_ref(4)?.as_str_or_null()? {
                merge_stored(&mut games, raw);
            }
        }
        if end == self.today {
            self.live(conn, cleaner, &mut weeks[index(end)], &mut games)?;
        }
        let zeros = || (vec![0; weeks.len()], vec![0; weeks.len()]);
        let (words, kanji) = if self.tokenization {
            maturity::Report::daily(self.word_field.clone(), self.today)
                .weekly_counts(conn, start, end)
                .unwrap_or_else(|_| zeros())
        } else {
            zeros()
        };
        let lag = if self.lag_weeks == 0 {
            3
        } else {
            self.lag_weeks.max(1)
        } as usize;
        let shifted = |counts: &[usize]| {
            (0..counts.len())
                .map(|i| counts.get(i.saturating_add(lag)).copied())
                .collect::<Vec<_>>()
        };
        let hours = weeks
            .iter()
            .map(|w| hours_rounded(w.hours))
            .collect::<Result<Vec<_>>>()?;
        let pairs: Vec<_> = (0..if self.details { weeks.len().saturating_sub(lag) } else { 0 }).map(|i| {
            let target = i+lag;
            json!({"source_label":labels[i],"target_label":labels[target],"reading_chars":weeks[i].chars,
                "reading_hours":hours[i],"cards_mined":weeks[i].cards,"mature_words":words[target],"mature_kanji":kanji[target]})
        }).collect();
        Ok(
            json!({"start_date":start,"end_date":end,"lag_weeks":lag,"tokenization_enabled":self.tokenization,
            "labels":labels,"reading_chars":weeks.iter().map(|w|w.chars).collect::<Vec<_>>(),"reading_hours":hours,
            "cards_mined":weeks.iter().map(|w|w.cards).collect::<Vec<_>>(),"mature_words":words,"mature_kanji":kanji,
            "lagged_mature_words":shifted(&words),"lagged_mature_kanji":shifted(&kanji),"lagged_pairs":pairs,
            "per_game":self.per_game(conn, games)?}),
        )
    }
}
