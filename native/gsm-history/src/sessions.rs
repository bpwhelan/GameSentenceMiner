//! Today's reading sessions. Timestamps and counts are sufficient for the
//! adaptive pace estimate, including days where the source text was archived.
use crate::{
    stats::{archive_events, table_exists},
    Result,
};
use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{collections::HashMap, sync::LazyLock};

struct Line {
    time: f64,
    chars: usize,
    id: Option<String>,
    scene: String,
    game_id: String,
}

pub(super) fn characters(text: &str) -> usize {
    with_clean_text(text, None, |clean| clean.chars().count())
}

pub(super) const PUNCTUATION_PATTERN: &str = r"[\p{P}\p{S}\p{Z}]";
pub(super) fn with_clean_text<T>(
    text: &str,
    custom: Option<&Regex>,
    visit: impl FnOnce(&str) -> T,
) -> T {
    static PUNCTUATION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\p{P}\p{S}\p{Z}]+").unwrap());
    let stripped = custom.unwrap_or(&PUNCTUATION).replace_all(text, "");
    visit(stripped.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)))
}

fn active_seconds(lines: &[Line], breaks: &[f64]) -> f64 {
    reading_seconds(
        lines.windows(2).map(|p| (p[0].time, p[1].time, p[0].chars)),
        breaks,
    )
}

pub(super) fn reading_seconds(
    pairs: impl Iterator<Item = (f64, f64, usize)> + Clone,
    breaks: &[f64],
) -> f64 {
    let mut next_break = pairs
        .clone()
        .next()
        .map_or(0, |(start, _, _)| breaks.partition_point(|&b| b < start));
    let gaps = pairs.filter_map(move |(start, end, chars)| {
        while next_break < breaks.len() && breaks[next_break] < start {
            next_break += 1;
        }
        if breaks.get(next_break).is_some_and(|&b| b < end) {
            return None;
        }
        Some((end - start, chars as f64))
    });
    let mut speeds: Vec<f64> = gaps
        .clone()
        .filter(|&(gap, chars)| (1.0..=300.0).contains(&gap) && chars >= 5.0)
        .map(|(gap, chars)| chars / gap)
        .collect();
    let n = speeds.len();
    let pace = if n == 0 {
        0.0
    } else {
        let (lower, mid, _) = speeds.select_nth_unstable_by(n / 2, f64::total_cmp);
        if n.is_multiple_of(2) {
            (lower.iter().copied().fold(0.0, f64::max) + *mid) / 2.0
        } else {
            *mid
        }
    };
    // Compensated sum keeps long sessions in step with Python's built-in sum.
    let (mut total, mut correction) = (0.0_f64, 0.0);
    for (gap, chars) in gaps {
        if chars == 0.0 {
            continue;
        }
        let cap = if pace > 0.0 {
            chars / pace * 2.5
        } else {
            chars * 3.0
        };
        let value = gap.min(cap.clamp(2.0, 300.0));
        let next = total + value;
        correction += if total >= value {
            (total - next) + value
        } else {
            (value - next) + total
        };
        total = next;
    }
    total + correction
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    start_time: f64,
    end_time: f64,
    game_name: String,
    game_id: Option<String>,
    total_chars: usize,
    total_seconds: f64,
    chars_per_hour: u64,
    lines: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Today {
    today_total_chars: usize,
    today_chars_per_hour: u64,
    today_total_hours: f64,
    today_sessions: usize,
    sessions: Vec<Session>,
}

fn speed(chars: usize, seconds: f64) -> u64 {
    if seconds > 0.0 {
        (chars as f64 / (seconds / 3600.0)).round_ties_even() as u64
    } else {
        0
    }
}

pub(super) fn today(conn: &Connection, start: f64, end: f64, session_gap: f64) -> Result<Today> {
    let mut stmt = conn.prepare("SELECT CAST(timestamp AS REAL), coalesce(line_text,''), id,
        coalesce(game_name,''), coalesce(game_id,'') FROM game_lines WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp")?;
    let mut lines = stmt
        .query_map(params![start, end], |r| {
            Ok(Line {
                time: r.get(0)?,
                chars: characters(r.get_ref(1)?.as_str()?),
                id: Some(r.get(2)?),
                scene: r.get(3)?,
                game_id: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    archive_events(
        conn,
        Some(start),
        Some(end),
        |time, chars, _, scene, game_id| {
            lines.push(Line {
                time,
                chars,
                id: None,
                scene: scene.into(),
                game_id: game_id.into(),
            });
            Ok(())
        },
    )?;
    lines.sort_by(|a, b| a.time.total_cmp(&b.time));

    let breaks = reading_breaks(conn, start, end)?;
    let mut games = HashMap::new();
    let mut aliases = HashMap::new();
    if !lines.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id,coalesce(title_original,''),coalesce(obs_scene_name,'') FROM games",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let scene: String = row.get(2)?;
            for alias in [&scene, &title].into_iter().filter(|s| !s.is_empty()) {
                aliases.entry(alias.clone()).or_insert_with(|| id.clone());
            }
            games.insert(id, title);
        }
    }
    // First sighting of a scene fixes its display identity for this response.
    let mut names = HashMap::new();
    for line in &mut lines {
        let (name, id) = names.entry(line.scene.clone()).or_insert_with(|| {
            let id = (!line.scene.is_empty())
                .then(|| {
                    games.get_key_value(&line.game_id).or_else(|| {
                        aliases
                            .get(&line.scene)
                            .and_then(|id| games.get_key_value(id))
                    })
                })
                .flatten();
            let name = id
                .map(|(_, title)| title.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(&line.scene);
            (
                (if name.is_empty() {
                    "Unknown Game"
                } else {
                    name
                })
                .to_owned(),
                id.map(|(id, _)| id.clone()).unwrap_or_default(),
            )
        });
        line.scene.clone_from(name);
        line.game_id.clone_from(id);
    }
    let total_chars = lines.iter().map(|l| l.chars).sum();
    let mut total_seconds = 0.0;
    let mut sessions = vec![];
    for span in lines.chunk_by(|a, b| b.time - a.time <= session_gap) {
        // Daily pace spans game changes; displayed sessions learn their own pace.
        let seconds = active_seconds(span, &breaks);
        total_seconds += seconds;
        for group in span.chunk_by(|a, b| a.scene == b.scene) {
            let first = &group[0];
            let seconds = if group.len() == span.len() {
                seconds
            } else {
                active_seconds(group, &breaks)
            };
            let chars = group.iter().map(|l| l.chars).sum();
            sessions.push(Session {
                start_time: first.time,
                end_time: group[group.len() - 1].time,
                game_name: first.scene.clone(),
                game_id: (!first.game_id.is_empty()).then(|| first.game_id.clone()),
                total_chars: chars,
                total_seconds: seconds,
                chars_per_hour: speed(chars, seconds),
                lines: group.iter().filter_map(|l| l.id.clone()).collect(),
            });
        }
    }
    Ok(Today {
        today_total_chars: total_chars,
        today_chars_per_hour: speed(total_chars, total_seconds),
        today_total_hours: format!("{:.2}", total_seconds / 3600.0).parse()?,
        today_sessions: sessions.len(),
        sessions,
    })
}

pub(super) fn reading_breaks(conn: &Connection, start: f64, end: f64) -> Result<Vec<f64>> {
    if !table_exists(conn, "stats_reading_breaks")? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare("SELECT CAST(timestamp AS REAL) AS t FROM stats_reading_breaks WHERE CAST(timestamp AS REAL) >= ? AND CAST(timestamp AS REAL) < ? ORDER BY t")?;
    let rows = stmt.query_map(params![start, end], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
