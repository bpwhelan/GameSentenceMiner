use super::{ExportOptions, ExportPreferences};
use crate::{
    game_stats::{calc_reading_time, lines_for_day, local_day_range, timestamp_expression},
    sessions::reading_breaks,
    stats::local_date,
    Result,
};
use chrono::{Days, Local, NaiveDate};
use indexmap::IndexMap;
use rusqlite::{params, Connection};
use std::{collections::HashMap, io::Write};

struct Activity {
    date: String,
    title: String,
    media: &'static str,
    minutes: i64,
    characters: i64,
    kind: String,
}

pub(crate) fn minutes(seconds: f64) -> i64 {
    (seconds.max(0.) / 60.).round_ties_even() as i64
}

pub(crate) fn category(kind: &str) -> (&'static str, String) {
    let lower = kind.trim().to_lowercase();
    for (needle, media, activity) in [
        ("visual novel", "Playing", "Visual Novel"),
        ("anime", "Watching", "Anime"),
        ("manga", "Reading", "Manga"),
        ("web novel", "Reading", "Web Novel"),
        ("light novel", "Reading", "Light Novel"),
    ] {
        if lower.contains(needle) || (lower == "vn" && needle == "visual novel") {
            return (media, activity.into());
        }
    }
    let has = |words: &[&str]| words.iter().any(|s| lower.contains(s));
    let media = if has(&["novel", "book", "reading"]) {
        "Reading"
    } else if has(&["movie", "show", "watch"]) {
        "Watching"
    } else if has(&["music", "audio", "listen", "podcast"]) {
        "Listening"
    } else {
        "Playing"
    };
    let label = kind
        .replace(['_', '-'], " ")
        .split_whitespace()
        .map(|s| {
            if s.to_uppercase() == s {
                s.to_owned()
            } else {
                let mut letters = s.chars();
                let first = letters.next().unwrap();
                format!(
                    "{}{}",
                    first.to_uppercase(),
                    letters.as_str().to_lowercase()
                )
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let label = match label.to_lowercase().as_str() {
        "" => "Game".into(),
        "vn" => "Visual Novel".into(),
        "rpg" => "RPG".into(),
        _ => label,
    };
    (media, label)
}

#[derive(Default)]
struct Games {
    by_id: HashMap<String, (String, String, String)>,
    by_scene: HashMap<String, String>,
}
impl Games {
    fn load(conn: &Connection) -> Result<Self> {
        let mut games = Self::default();
        let mut stmt = conn.prepare(
            "SELECT id,coalesce(obs_scene_name,''),coalesce(nullif(title_original,''),
            nullif(title_english,''),title_romaji,''),coalesce(type,'') FROM games ORDER BY rowid",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let scene: String = row.get(1)?;
            if !scene.is_empty() {
                games.by_scene.insert(scene.clone(), id.clone());
            }
            games.by_id.insert(id, (row.get(2)?, scene, row.get(3)?));
        }
        Ok(games)
    }

    fn activity(
        &self,
        date: String,
        id: &str,
        scene: &str,
        seconds: f64,
        characters: i64,
    ) -> Activity {
        let game = self
            .by_id
            .get(id)
            .or_else(|| self.by_id.get(self.by_scene.get(scene)?));
        let title = [
            game.map(|g| g.0.as_str()),
            Some(scene),
            game.map(|g| g.1.as_str()),
        ]
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())
        .unwrap_or("Unknown Game");
        let (media, kind) = category(game.map_or("", |g| g.2.as_str()));
        Activity {
            date,
            title: title.into(),
            media,
            minutes: minutes(seconds),
            characters,
            kind,
        }
    }
}

struct Bucket {
    game: String,
    scene: String,
    samples: Vec<(f64, usize)>,
}
#[derive(Default)]
struct Groups(IndexMap<(NaiveDate, String), Bucket>);
impl Groups {
    fn add(&mut self, ts: f64, chars: usize, game: String, scene: String) -> Result<()> {
        let id = [&game, &scene]
            .into_iter()
            .find(|s| !s.is_empty())
            .map_or("unknown", String::as_str);
        self.0
            .entry((local_date(ts)?, id.into()))
            .or_insert_with(|| Bucket {
                game,
                scene,
                samples: Vec::new(),
            })
            .samples
            .push((ts, chars));
        Ok(())
    }

    fn activities(
        self,
        conn: &Connection,
        games: &Games,
        gap: f64,
        output: &mut Vec<Activity>,
    ) -> Result<()> {
        if self.0.is_empty() {
            return Ok(());
        }
        let first = self
            .0
            .values()
            .map(|b| b.samples[0].0)
            .fold(f64::INFINITY, f64::min);
        let last = self
            .0
            .values()
            .filter_map(|b| b.samples.last())
            .map(|s| s.0)
            .fold(f64::NEG_INFINITY, f64::max);
        let breaks = reading_breaks(conn, first, last.next_up())?;
        for ((day, _), group) in self.0 {
            let seconds = calc_reading_time(&group.samples, gap, &breaks);
            let characters = group.samples.iter().map(|v| v.1 as i64).sum();
            output.push(games.activity(
                day.to_string(),
                &group.game,
                &group.scene,
                seconds,
                characters,
            ));
        }
        Ok(())
    }
}

enum Window {
    Dates(NaiveDate, NaiveDate),
    Changed(f64),
}
impl Window {
    fn resolve(options: &ExportOptions, last: Option<f64>, today: NaiveDate) -> Result<Self> {
        let first = NaiveDate::from_ymd_opt(1, 1, 1).unwrap();
        Ok(match options.scope.as_str() {
            "all_time" => Self::Dates(first, today),
            "since_last_export" => last.map_or(Self::Dates(first, today), Self::Changed),
            "last_30_days" => Self::Dates(today - Days::new(29), today),
            "custom" => {
                let parse = |value: &Option<String>| -> Result<NaiveDate> {
                    let raw = value
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .ok_or("Custom exports require both start_date and end_date.")?;
                    raw.parse()
                        .map_err(|_| "Custom export dates must use YYYY-MM-DD.".into())
                };
                let (start, end) = (parse(&options.start_date)?, parse(&options.end_date)?);
                if end < start {
                    return Err("end_date must be on or after start_date.".into());
                }
                Self::Dates(start, end)
            }
            other => return Err(format!("Unsupported export scope: {other}").into()),
        })
    }
}

fn raw(
    conn: &Connection,
    prefs: &ExportPreferences<'_>,
    window: Window,
    groups: &mut Groups,
) -> Result<()> {
    let stamp = timestamp_expression(conn)?;
    let (clause, low, high) = match window {
        Window::Changed(last) => ("CAST(last_modified AS REAL) > ?1".into(), last, None),
        Window::Dates(start, end) => (
            format!("{stamp} BETWEEN ?1 AND ?2"),
            local_day_range(start).0,
            Some(local_day_range(end).1),
        ),
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT CAST(timestamp AS REAL),coalesce(line_text,''),coalesce(game_id,''),
        coalesce(game_name,'') FROM game_lines WHERE {clause} ORDER BY {stamp}"
    ))?;
    let mut rows = if let Some(high) = high {
        stmt.query(params![low, high])?
    } else {
        stmt.query([low])?
    };
    while let Some(row) = rows.next()? {
        groups.add(
            row.get(0)?,
            prefs.cleaner.count(row.get_ref(1)?.as_str()?)?,
            row.get(2)?,
            row.get(3)?,
        )?;
    }
    Ok(())
}

fn historical(
    conn: &Connection,
    games: &Games,
    start: NaiveDate,
    end: NaiveDate,
    output: &mut Vec<Activity>,
) -> Result<usize> {
    let mut stmt = conn.prepare("SELECT date,game_id, CAST(coalesce(total_reading_time_seconds,0) AS REAL),
        CAST(coalesce(total_characters,0) AS INTEGER) FROM game_daily_rollup WHERE date BETWEEN ? AND ? ORDER BY date,game_id")?;
    let mut rows = stmt.query([start.to_string(), end.to_string()])?;
    let before = output.len();
    while let Some(row) = rows.next()? {
        output.push(games.activity(
            row.get(0)?,
            row.get_ref(1)?.as_str()?,
            "",
            row.get(2)?,
            row.get(3)?,
        ));
    }
    Ok(output.len() - before)
}

fn external(conn: &Connection, window: Window, output: &mut Vec<Activity>) -> Result<()> {
    let clause = match window {
        Window::Dates(..) => "date BETWEEN ? AND ? ORDER BY date",
        Window::Changed(_) => "CAST(created_at AS REAL)>? ORDER BY CAST(created_at AS REAL)",
    };
    let mut stmt = conn.prepare(&format!("SELECT date,coalesce(nullif(label,''),nullif(source,''),'External Activity'),
        coalesce(source,''),CAST(coalesce(time_read_seconds,0) AS REAL),CAST(coalesce(characters_read,0) AS INTEGER)
        FROM third_party_stats WHERE {clause}"))?;
    let mut rows = match window {
        Window::Dates(start, end) => stmt.query([start.to_string(), end.to_string()])?,
        Window::Changed(last) => stmt.query([last])?,
    };
    while let Some(row) = rows.next()? {
        let source = row.get_ref(2)?.as_str()?;
        let kind = if source.trim().eq_ignore_ascii_case("mokuro") {
            "Book"
        } else {
            "Reading"
        };
        output.push(Activity {
            date: row.get(0)?,
            title: row.get(1)?,
            media: "Reading",
            kind: kind.into(),
            minutes: minutes(row.get(3)?),
            characters: row.get(4)?,
        });
    }
    Ok(())
}

pub(super) fn write(
    conn: &Connection,
    csv: &mut csv::Writer<impl Write>,
    options: &ExportOptions,
    prefs: &ExportPreferences<'_>,
    last: Option<f64>,
    progress: &mut impl FnMut(u8, &str),
) -> Result<usize> {
    let today = Local::now().date_naive();
    let window = Window::resolve(options, last, today)?;
    let games = Games::load(conn)?;
    let mut output = Vec::new();
    let mut groups = Groups::default();
    progress(10, "Loading reading activity.");
    match window {
        Window::Changed(last) => raw(conn, prefs, Window::Changed(last), &mut groups)?,
        Window::Dates(start, end) => {
            let past = end.min(today - Days::new(1));
            if start <= past && historical(conn, &games, start, past, &mut output)? == 0 {
                raw(conn, prefs, Window::Dates(start, past), &mut groups)?;
            }
            if (start..=end).contains(&today) {
                let (start, end) = local_day_range(today);
                for line in lines_for_day(conn, prefs.cleaner, start, end)? {
                    groups.add(line.ts, line.chars, line.game_id, line.game_name)?;
                }
            }
        }
    }
    groups.activities(conn, &games, prefs.session_gap, &mut output)?;
    if options.include_external_stats {
        progress(80, "Loading external activity.");
        external(conn, window, &mut output)?;
    }
    output.sort_by_cached_key(|r| {
        (
            r.date.clone(),
            r.title.to_lowercase(),
            r.kind.to_lowercase(),
        )
    });
    progress(94, "Writing activity rows to CSV.");
    csv.write_record([
        "Date",
        "Log Name",
        "Media Type",
        "Duration",
        "Language",
        "Characters",
        "Activity Type",
    ])?;
    for row in &output {
        csv.write_record([
            &row.date,
            &row.title,
            row.media,
            &row.minutes.to_string(),
            prefs.language,
            &row.characters.to_string(),
            &row.kind,
        ])?;
    }
    Ok(output.len())
}
