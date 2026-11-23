use crate::Result;
use chrono::{DateTime, Datelike, Days, Local, NaiveDate, NaiveDateTime, TimeZone};
use flate2::read::ZlibDecoder;
use rusqlite::{params, types::ValueRef, Connection};
use serde::{de::IgnoredAny, Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

type Heatmap = BTreeMap<i32, BTreeMap<NaiveDate, usize>>;

pub fn local_date(timestamp: f64) -> Result<NaiveDate> {
    let instant = DateTime::from_timestamp(timestamp.floor() as i64, 0)
        .filter(|_| timestamp.is_finite())
        .ok_or("Invalid line timestamp")?;
    Ok(instant.with_timezone(&Local).date_naive())
}

fn line_date(value: ValueRef<'_>) -> Result<NaiveDate> {
    match value {
        ValueRef::Integer(n) => local_date(n as f64),
        ValueRef::Real(n) => local_date(n),
        ValueRef::Text(raw) => {
            let text = std::str::from_utf8(raw)?;
            if let Ok(seconds) = text.parse::<f64>() {
                return local_date(seconds);
            }
            // Older profiles stored ISO datetimes in this column.
            let iso = text.replace(' ', "T");
            if let Ok(date) = DateTime::parse_from_rfc3339(&iso) {
                return Ok(date.with_timezone(&Local).date_naive());
            }
            let naive: NaiveDateTime = iso.parse()?;
            Ok(Local
                .from_local_datetime(&naive)
                .earliest()
                .ok_or("Invalid local timestamp")?
                .date_naive())
        }
        _ => Err("Missing line timestamp".into()),
    }
}

fn has_notes(raw: Option<&str>) -> bool {
    match raw.map(str::trim) {
        None | Some("" | "[]" | "null") => false,
        Some(raw) => match serde_json::from_str(raw) {
            Ok(Value::Array(ids)) => !ids.is_empty(),
            Ok(Value::Object(items)) => !items.is_empty(),
            Ok(Value::String(text)) => !text.is_empty(),
            Ok(Value::Bool(flag)) => flag,
            Ok(Value::Number(n)) => n.as_f64() != Some(0.0),
            _ => false,
        },
    }
}

#[derive(Deserialize)]
struct ArchiveEvent(
    f64,
    usize,
    u64,
    IgnoredAny,
    IgnoredAny,
    IgnoredAny,
    IgnoredAny,
);

pub(super) fn first_archive_event_in_range(blob: &[u8], start: f64, end: f64) -> Result<Option<f64>> {
    let events: Vec<ArchiveEvent> = serde_json::from_reader(std::io::BufReader::new(ZlibDecoder::new(blob)))?;
    Ok(events.into_iter().map(|e| e.0).find(|&t| (start..=end).contains(&t)))
}

pub(super) fn mining_heatmap(
    conn: &Connection,
    start: Option<f64>,
    end: Option<f64>,
    live_only: bool,
) -> Result<Heatmap> {
    let mut counts = Heatmap::new();
    let mut add = |day: NaiveDate| {
        *counts
            .entry(day.year())
            .or_default()
            .entry(day)
            .or_default() += 1
    };
    // Keep the timestamp index usable for bounded requests and skip fetching
    // dialogue, translation and media paths unrelated to the chart.
    let (condition, bounds) = match (start, end) {
        (Some(a), Some(b)) => ("WHERE timestamp BETWEEN ? AND ?", vec![a, b]),
        (Some(a), None) => ("WHERE timestamp >= ?", vec![a]),
        (None, Some(b)) => ("WHERE timestamp <= ?", vec![b]),
        (None, None) => ("", vec![]),
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT timestamp, note_ids, audio_in_anki, screenshot_in_anki FROM game_lines {condition}"
    ))?;
    let mut rows = stmt.query(rusqlite::params_from_iter(bounds))?;
    while let Some(row) = rows.next()? {
        let media = |i| -> rusqlite::Result<bool> {
            Ok(row
                .get_ref(i)?
                .as_str_or_null()?
                .is_some_and(|s| !s.trim().is_empty()))
        };
        if media(2)? || media(3)? || has_notes(row.get_ref(1)?.as_str_or_null()?) {
            add(line_date(row.get_ref(0)?)?);
        }
    }
    if !live_only {
        archive_events(conn, start, end, |time, _, cards, _, _| {
            if cards > 0 {
                add(local_date(time)?);
            }
            Ok(())
        })?;
    }
    Ok(counts)
}

pub(super) fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)",
        [name],
        |r| r.get(0),
    )?)
}

pub(super) fn visit_archive_events(
    blob: &[u8],
    start: Option<f64>,
    end: Option<f64>,
    mut visit: impl FnMut(f64, usize, u64) -> Result<()>,
) -> Result<()> {
    let events: Vec<ArchiveEvent> =
        serde_json::from_reader(std::io::BufReader::new(ZlibDecoder::new(blob)))?;
    for ArchiveEvent(time, chars, cards, ..) in events {
        if start.is_none_or(|s| time >= s) && end.is_none_or(|e| time <= e) {
            visit(time, chars, cards)?;
        }
    }
    Ok(())
}

pub(super) fn archive_events(
    conn: &Connection,
    start: Option<f64>,
    end: Option<f64>,
    mut visit: impl FnMut(f64, usize, u64, &str, &str) -> Result<()>,
) -> Result<()> {
    if !table_exists(conn, "archived_game_days")? {
        return Ok(());
    }
    let mut stmt =
        conn.prepare("SELECT events, game_name, game_id FROM archived_game_days WHERE date BETWEEN ? AND ? ORDER BY date, game_id")?;
    let lower = start
        .map(local_date)
        .transpose()?
        .map(|d| d.to_string())
        .unwrap_or_default();
    let upper = end
        .map(local_date)
        .transpose()?
        .map(|d| d.to_string())
        .unwrap_or_else(|| "9999-12-31".into());
    let mut rows = stmt.query(params![lower, upper])?;
    while let Some(row) = rows.next()? {
        let blob = row.get_ref(0)?.as_blob()?;
        let scene = row.get_ref(1)?.as_str()?;
        let game_id = row.get_ref(2)?.as_str()?;
        visit_archive_events(blob,start,end,|time,chars,cards| visit(time,chars,cards,scene,game_id))?;
    }
    Ok(())
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DailyActivity {
    labels: Vec<NaiveDate>,
    chars_data: Vec<i64>,
    time_data: Vec<f64>,
    speed_data: Vec<i64>,
}

pub(super) fn daily_activity(
    conn: &Connection,
    today: NaiveDate,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    all_time: bool,
) -> Result<Option<DailyActivity>> {
    let mut chart = DailyActivity::default();
    let (first, last) = match (start, end) {
        (Some(a), Some(b)) => (a.min(b), a.max(b)),
        _ if all_time => {
            let first: Option<String> = conn.query_row("SELECT min(date) FROM (SELECT min(date) AS date FROM daily_stats_rollup UNION ALL SELECT min(date) FROM third_party_stats)", [], |r| r.get(0))?;
            let Some(first) = first else {
                return Ok(Some(chart));
            };
            (first.parse()?, today)
        }
        _ => (
            today
                .checked_sub_days(Days::new(27))
                .ok_or("Invalid stats date")?,
            today,
        ),
    };
    // Leave unusually wide charts with their HTTP caller before allocating
    // several process-local copies for a bounded desktop broker frame.
    if (last - first).num_days() > 100_000 {
        return Ok(None);
    }
    let mut stmt = conn.prepare("SELECT date,CAST(total_characters AS INTEGER),CAST(total_reading_time_seconds AS REAL) FROM daily_stats_rollup WHERE date BETWEEN ? AND ? ORDER BY date")?;
    let mut rollups = stmt.query(params![first.to_string(), last.to_string()])?;
    let mut row = rollups.next()?;
    for date in first.iter_days().take_while(|d| *d <= last) {
        let mut chars = 0;
        let mut hours = 0.0;
        while let Some(record) = row {
            let recorded: NaiveDate = record.get_ref(0)?.as_str()?.parse()?;
            if recorded > date {
                break;
            }
            chars = record.get(1)?;
            hours = record.get::<_, f64>(2)? / 3600.0;
            row = rollups.next()?;
        }
        chart.labels.push(date);
        chart.chars_data.push(chars);
        // Decimal formatting rounds the actual binary value (Python round(x, 2)).
        chart.time_data.push(if hours == 0.0 {
            0.0
        } else {
            format!("{hours:.2}").parse()?
        });
        chart.speed_data.push(if hours > 0.0 && chars > 0 {
            (chars as f64 / hours) as i64
        } else {
            0
        });
    }
    Ok(Some(chart))
}
