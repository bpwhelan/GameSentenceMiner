use super::{catalog::Catalog, digest, spaced_json, Activity, Media, Snapshot, SnapshotOptions};
use crate::{
    game_stats::{calc_reading_time, local_day_range},
    sessions::reading_breaks,
    stats::{archive_events, table_exists},
    stats_export::activity::minutes,
    Result,
};
use chrono::NaiveDate;
use indexmap::IndexMap;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Default)]
struct Day {
    events: bool,
    rollups: IndexMap<String, (i64, f64)>,
}
fn number(v: Option<&Value>) -> Result<f64> {
    match v {
        None => Ok(0.),
        Some(v) => v
            .as_f64()
            .or_else(|| v.as_str()?.parse().ok())
            .ok_or_else(|| "GSM contains negative or invalid activity statistics".into()),
    }
}

fn days(
    conn: &Connection,
    catalog: &mut Catalog,
    previous: &BTreeSet<String>,
) -> Result<BTreeMap<NaiveDate, Day>> {
    let mut days = BTreeMap::<NaiveDate, Day>::new();
    for sql in [
        "SELECT DISTINCT DATE(timestamp,'unixepoch','localtime') FROM game_lines",
        "SELECT DISTINCT date FROM archived_game_days",
    ] {
        if sql.contains("archived_game_days") && !table_exists(conn, "archived_game_days")? {
            continue;
        }
        let mut stmt = conn.prepare(sql)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let date = row
                .get_ref(0)?
                .as_str_or_null()?
                .ok_or("GSM contains a line with an invalid timestamp")?;
            days.entry(date.parse()?).or_default().events = true;
        }
    }
    let mut stmt=conn.prepare("SELECT date,game_id,CAST(total_characters AS TEXT),CAST(total_reading_time_seconds AS TEXT) FROM game_daily_rollup
        WHERE date BETWEEN '0001-01-01' AND '9999-12-31' ORDER BY date,game_id")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let day = days.entry(row.get_ref(0)?.as_str()?.parse()?).or_default();
        day.rollups.insert(
            row.get(1)?,
            (
                row.get_ref(2)?.as_str_or_null()?.unwrap_or("0").parse()?,
                row.get_ref(3)?.as_str_or_null()?.unwrap_or("0").parse()?,
            ),
        );
    }
    if table_exists(conn, "daily_stats_rollup")? {
        let prior: HashSet<_> = previous
            .iter()
            .filter_map(|k| k.rsplit_once(':').map(|(_, date)| date))
            .collect();
        let mut stmt=conn.prepare("SELECT date,game_activity_data,CAST(total_characters AS TEXT),CAST(total_reading_time_seconds AS TEXT) FROM daily_stats_rollup")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let date = row.get_ref(0)?.as_str()?;
            let day = days.entry(date.parse()?).or_default();
            let raw = row
                .get_ref(1)?
                .as_str_or_null()?
                .filter(|v| !v.is_empty())
                .unwrap_or("{}");
            let details: IndexMap<String, serde_json::Map<String, Value>> =
                serde_json::from_str(raw)
                    .map_err(|_| format!("Invalid GSM historical game details for {date}"))?;
            for (id, detail) in details {
                catalog.titles.entry(id.clone()).or_insert_with(|| {
                    detail
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("Game {id}"))
                });
                if let indexmap::map::Entry::Vacant(slot) = day.rollups.entry(id) {
                    slot.insert((
                        number(detail.get("chars"))? as i64,
                        number(detail.get("time"))?,
                    ));
                }
            }
            if day.rollups.is_empty() && !day.events && !prior.contains(date) {
                let chars = row.get_ref(2)?.as_str_or_null()?.unwrap_or("0").parse()?;
                let seconds = row.get_ref(3)?.as_str_or_null()?.unwrap_or("0").parse()?;
                if chars != 0 || seconds != 0. {
                    catalog.titles.insert(
                        "legacy:unattributed".into(),
                        "GSM historical activity".into(),
                    );
                    day.rollups
                        .insert("legacy:unattributed".into(), (chars, seconds));
                }
            }
        }
    }
    Ok(days)
}

fn log(
    snapshot: &mut Snapshot,
    index: usize,
    key: String,
    date: &str,
    chars: i64,
    seconds: f64,
) -> Result<()> {
    if chars < 0 || !seconds.is_finite() || seconds < 0. {
        return Err("GSM contains negative or invalid activity statistics".into());
    }
    let duration_minutes = minutes(seconds);
    if chars != 0 || duration_minutes != 0 {
        let (media_key, media) = snapshot
            .media
            .get_index(index)
            .ok_or("Missing Kechimochi activity title")?;
        snapshot.logs.insert(
            key,
            Activity {
                media_key: media_key.clone(),
                date: date.into(),
                characters: chars,
                duration_minutes,
                activity_type: media.default_activity_type,
            },
        );
    }
    Ok(())
}

pub(super) fn native(
    conn: &Connection,
    snapshot: &mut Snapshot,
    catalog: &mut Catalog,
    previous: &BTreeSet<String>,
    options: &SnapshotOptions<'_>,
) -> Result<()> {
    let days = days(conn, catalog, previous)?;
    let breaks = reading_breaks(conn, -f64::MAX, f64::MAX)?;
    let mut live=conn.prepare("SELECT coalesce(game_id,''),coalesce(game_name,''),coalesce(line_text,''),timestamp FROM game_lines WHERE timestamp>=? AND timestamp<? ORDER BY timestamp,id")?;
    for (date, day) in days {
        let iso = date.to_string();
        if day.events {
            let (start, end) = local_day_range(date);
            let next = local_day_range(date.succ_opt().ok_or("Invalid GSM activity date")?).0;
            let mut buckets = IndexMap::<usize, Vec<(f64, usize)>>::new();
            let mut rows = live.query(params![start, next])?;
            while let Some(row) = rows.next()? {
                let index = catalog.resolve(
                    snapshot,
                    row.get_ref(0)?.as_str()?.trim(),
                    row.get_ref(1)?.as_str()?,
                );
                buckets.entry(index).or_default().push((
                    row.get(3)?,
                    options.cleaner.count(row.get_ref(2)?.as_str()?)?,
                ));
            }
            archive_events(conn, Some(start), Some(end), |t, chars, _, scene, id| {
                let index = catalog.resolve(snapshot, id, scene);
                buckets.entry(index).or_default().push((t, chars));
                Ok(())
            })?;
            for (index, mut samples) in buckets {
                // Live rows and each archived group are internally ordered, but can overlap.
                samples.sort_by(|a, b| a.0.total_cmp(&b.0));
                let chars = samples.iter().map(|s| s.1 as i64).sum();
                let seconds = calc_reading_time(&samples, options.session_gap, &breaks);
                let key = format!(
                    "native:{}:{iso}",
                    snapshot.media.get_index(index).unwrap().0
                );
                snapshot.observed.insert(key.clone());
                log(snapshot, index, key, &iso, chars, seconds)?;
            }
        }
        for (id, (chars, seconds)) in day.rollups {
            let index = catalog.resolve(snapshot, &id, "");
            let key = format!(
                "native:{}:{iso}",
                snapshot.media.get_index(index).unwrap().0
            );
            if !snapshot.observed.contains(&key) && !previous.contains(&key) {
                log(snapshot, index, key, &iso, chars, seconds)?;
            }
        }
    }
    Ok(())
}

pub(super) fn external(conn: &Connection, snapshot: &mut Snapshot) -> Result<()> {
    let mut stmt=conn.prepare("SELECT id,date,coalesce(source,''),coalesce(label,''),coalesce(CAST(characters_read AS TEXT),'0'),coalesce(CAST(time_read_seconds AS TEXT),'0')
        FROM third_party_stats WHERE date BETWEEN '0001-01-01' AND '9999-12-31' ORDER BY date,id")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let date: NaiveDate = row.get_ref(1)?.as_str()?.parse()?;
        let source = row.get_ref(2)?.as_str()?;
        let title = [row.get_ref(3)?.as_str()?, source, "External Activity"]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap();
        let key = format!("external:{}", digest(spaced_json(&[source, title])?));
        let entry = snapshot.media.entry(key);
        let index = entry.index();
        entry.or_insert_with(|| Media {
            title: title.into(),
            default_activity_type: "Reading",
            status: "Active",
            tracking_status: "Ongoing",
            description: String::new(),
            content_type: if source == "mokuro" {
                "Manga"
            } else {
                "Unknown"
            },
            extra_data: [("gsm_external_source".into(), source.into())]
                .into_iter()
                .collect(),
            cover_game: None,
            legacy_activity: if source.trim().eq_ignore_ascii_case("mokuro") {
                "Book"
            } else {
                "Reading"
            }
            .into(),
        });
        log(
            snapshot,
            index,
            format!("external:{id}"),
            &date.to_string(),
            row.get_ref(4)?.as_str()?.parse()?,
            row.get_ref(5)?.as_str()?.parse()?,
        )?;
    }
    Ok(())
}
