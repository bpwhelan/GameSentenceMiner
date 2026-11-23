use super::{load_games, GameRecord, JITEN_DIFFICULTY_LABELS};
use crate::{capture, History, Result};
use chrono::{NaiveDate, NaiveTime};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

#[derive(Default)]
struct Profile {
    lines: i64,
    characters: i64,
    raw: i64,
    archived: i64,
    archived_at: Option<f64>,
    first: Option<f64>,
    last: Option<f64>,
    names: Vec<String>,
}

fn minimum(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.into_iter().chain(b).reduce(f64::min)
}

fn maximum(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.into_iter().chain(b).reduce(f64::max)
}

fn profiles(conn: &Connection) -> Result<HashMap<String, Profile>> {
    let last_date: Option<String> =
        conn.query_row("SELECT max(date) FROM daily_stats_rollup", [], |r| r.get(0))?;
    let start_day = last_date
        .map(|date| -> Result<NaiveDate> {
            date.parse::<NaiveDate>()?
                .succ_opt()
                .ok_or_else(|| "Invalid last rollup date".into())
        })
        .transpose()?;
    let start = start_day
        .map(|d| gsm_db::local_timestamp(d.and_time(NaiveTime::MIN)))
        .transpose()?;
    let mut records = HashMap::new();
    // One pass per data source. Day summaries already store the exact totals
    // of their compressed events. Only a day straddling the cutoff (a profile
    // opened in a different time zone) needs its event stream decoded.
    let mut query=conn.prepare(
        "WITH historical AS (
            SELECT a.key AS id,sum(json_extract(a.value,'$.lines')) AS lines,sum(json_extract(a.value,'$.chars')) AS chars,
                min(d.date) AS first,max(d.date) AS last
            FROM daily_stats_rollup d,json_each(CASE WHEN json_valid(d.game_activity_data) THEN d.game_activity_data END) a
            WHERE a.type='object' AND typeof(a.key)='text' GROUP BY a.key
         ), raw AS (
            SELECT game_id,count(*) AS total,
                count(*) FILTER(WHERE ?1 IS NULL OR timestamp>=?1) AS lines,
                sum(length(line_text)) FILTER(WHERE ?1 IS NULL OR timestamp>=?1) AS chars,
                min(timestamp) AS first,max(timestamp) AS last FROM game_lines WHERE game_id!='' GROUP BY game_id
         ), archived AS (
            SELECT game_id,sum(line_count) AS total,
                sum(line_count) FILTER(WHERE ?1 IS NULL OR (date>=?2 AND first_timestamp>=?1)) AS lines,
                sum(character_count) FILTER(WHERE ?1 IS NULL OR (date>=?2 AND first_timestamp>=?1)) AS chars,
                min(first_timestamp) AS first,max(last_timestamp) AS last,max(archived_at) AS at
            FROM archived_game_days GROUP BY game_id
         ), imported AS (
            SELECT game_id,sum(lines_read) AS lines,sum(characters_read) AS chars,min(timestamp) AS first,max(timestamp) AS last
            FROM third_party_stats WHERE game_id!='' GROUP BY game_id
         )
         SELECT g.id,coalesce(h.lines,0)+coalesce(r.lines,0)+coalesce(a.lines,0)+coalesce(i.lines,0),
           coalesce(h.chars,0)+coalesce(r.chars,0)+coalesce(a.chars,0)+coalesce(i.chars,0),
           coalesce(r.total,0),coalesce(a.total,0),a.at,h.first,h.last,r.first,r.last,a.first,a.last,i.first,i.last
         FROM games g LEFT JOIN historical h ON h.id=g.id LEFT JOIN raw r ON r.game_id=g.id
         LEFT JOIN archived a ON a.game_id=g.id LEFT JOIN imported i ON i.game_id=g.id"
    )?;
    let day = start_day.map(|d| d.to_string());
    let mut rows = query.query(params![start, day])?;
    while let Some(r) = rows.next()? {
        let fallback = |col, end: bool| -> Result<Option<f64>> {
            r.get::<_, Option<String>>(col)?
                .map(|s| {
                    let date = s.parse::<NaiveDate>()?;
                    Ok(gsm_db::local_timestamp(if end {
                        date.and_hms_micro_opt(23, 59, 59, 999999).unwrap()
                    } else {
                        date.and_time(NaiveTime::MIN)
                    })?)
                })
                .transpose()
        };
        let timestamp = |column| r.get_ref(column).map(super::val_opt_f64);
        let first = match minimum(timestamp(8)?, timestamp(10)?) {
            Some(value) => Some(value),
            None => fallback(6, false)?,
        };
        let last = match maximum(timestamp(9)?, timestamp(11)?) {
            Some(value) => Some(value),
            None => fallback(7, true)?,
        };
        records.insert(
            r.get::<_, String>(0)?,
            Profile {
                lines: r.get(1)?,
                characters: r.get(2)?,
                raw: r.get(3)?,
                archived: r.get(4)?,
                archived_at: r.get(5)?,
                first: minimum(first, timestamp(12)?),
                last: maximum(last, timestamp(13)?),
                names: Vec::new(),
            },
        );
    }
    if let Some(start) = start {
        let mut partial=conn.prepare("SELECT game_id,events FROM archived_game_days WHERE date>=? AND first_timestamp<? AND last_timestamp>=?")?;
        let mut rows = partial.query(params![day, start, start])?;
        while let Some(row) = rows.next()? {
            if let Some(profile) = records.get_mut(row.get_ref(0)?.as_str()?) {
                crate::stats::visit_archive_events(
                    row.get_ref(1)?.as_blob()?,
                    Some(start),
                    None,
                    |_, chars, _| {
                        profile.lines += 1;
                        profile.characters += chars as i64;
                        Ok(())
                    },
                )?;
            }
        }
    }
    let mut aliases = conn.prepare(
        "SELECT game_id,game_name FROM game_lines WHERE game_id!='' AND game_name!=''
        GROUP BY game_id,game_name ORDER BY game_name COLLATE NOCASE",
    )?;
    let mut rows = aliases.query([])?;
    while let Some(row) = rows.next()? {
        if let Some(profile) = records.get_mut(row.get_ref(0)?.as_str()?) {
            profile.names.push(row.get(1)?);
        }
    }
    Ok(records)
}

fn igdb_link(link: &Value) -> bool {
    let raw = link
        .as_str()
        .or_else(|| link["url"].as_str())
        .unwrap_or("")
        .trim();
    let path = raw.split(['?', '#']).next().unwrap_or("");
    let path = if let Some((_, tail)) = path.split_once("://") {
        tail.split_once('/').map(|(_, path)| path).unwrap_or("")
    } else if let Some(tail) = path.strip_prefix("//") {
        tail.split_once('/').map(|(_, path)| path).unwrap_or("")
    } else {
        path
    };
    let mut parts = path.split('/').filter(|s| !s.is_empty());
    let first = parts.next();
    if first.is_none() {
        return false;
    }
    if parts.clone().next().is_none() {
        return first.is_some_and(|s| !s.trim().is_empty());
    }
    let mut parts = first.into_iter().chain(parts);
    parts.any(|s| s == "games") && parts.next().is_some_and(|s| !s.trim().is_empty())
}

fn library_row(g: GameRecord, p: Profile) -> Value {
    let linked = g.deck_id.is_some_and(|id| id != 0)
        || !g.vndb_id.is_empty()
        || !g.anilist_id.is_empty()
        || g.links.iter().any(igdb_link);
    json!({
        "id":g.id,"title_original":g.title_original,"title_romaji":g.title_romaji,"title_english":g.title_english,
        "type":g.game_type,"description":g.description,"has_image":!g.image.is_empty(),"deck_id":g.deck_id,
        "vndb_id":g.vndb_id,"anilist_id":g.anilist_id,"difficulty":g.difficulty,
        "difficulty_label":g.difficulty.map(|d|JITEN_DIFFICULTY_LABELS[d.clamp(0,5) as usize]),
        "completed":g.completed,"status":g.effective_status(),"is_linked":linked,
        "has_manual_overrides":!g.manual_overrides.is_empty(),"manual_overrides":g.manual_overrides,
        "line_count":p.lines,"mined_character_count":p.characters,"jiten_character_count":g.character_count,
        "raw_line_count":p.raw,"archived_line_count":p.archived,"archived_at":p.archived_at,
        "start_date":p.first,"last_played":p.last,"links":g.links,"release_date":g.release_date,
        "genres":g.genres,"tags":g.tags,"obs_scene_name":g.obs_scene_name,"character_summary":g.character_summary,"game_names":p.names
    })
}

fn list(conn: &Connection, sort: &str) -> Result<Value> {
    let mut profiles = profiles(conn)?;
    let mut rows = Vec::new();
    for game in load_games(conn, false, None)? {
        let profile = profiles.remove(&game.id).unwrap_or_default();
        rows.push(library_row(game, profile));
    }
    match sort {
        "title" => rows.sort_by(|a, b| {
            a["title_original"]
                .as_str()
                .cmp(&b["title_original"].as_str())
        }),
        "last_played" => rows.sort_by(|a, b| {
            b["last_played"]
                .as_f64()
                .unwrap_or_default()
                .total_cmp(&a["last_played"].as_f64().unwrap_or_default())
        }),
        key => {
            let field = if key == "line_count" {
                "line_count"
            } else {
                "mined_character_count"
            };
            rows.sort_by_key(|r| std::cmp::Reverse(r[field].as_i64().unwrap_or_default()));
        }
    }
    let linked = rows.iter().filter(|r| r["is_linked"] == true).count();
    Ok(
        json!({"summary":{"total_games":rows.len(),"linked_games":linked,"unlinked_games":rows.len()-linked},"games":rows}),
    )
}

impl History {
    pub fn games_management(&self, path: &Path, sort: &str, read_only: bool) -> Result<Value> {
        let sort = match sort {
            "title" => "title",
            "last_played" => "last_played",
            "line_count" => "line_count",
            _ => "character_count",
        };
        let key = crate::anki_report_cache::Key::Library(sort, read_only);
        self.reports.read(path, key, || {
            self.read_games_management(path, sort, read_only)
        })
    }

    fn read_games_management(&self, path: &Path, sort: &str, read_only: bool) -> Result<Value> {
        let ready = self.with_reader(path, |conn| {
            let tx = conn.transaction()?;
            let needs_linking = !read_only && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM game_lines WHERE game_name!='' AND (game_id IS NULL OR game_id=''))",
                [], |row| row.get::<_, bool>(0),
            )?;
            if needs_linking {return Ok(None);}
            list(&tx, sort).map(Some)
        })?;
        if let Some(value) = ready {
            return Ok(value);
        }
        self.with_writer(path, capture::link_game_lines)?;
        self.with_reader(path, |conn| {
            let tx = conn.transaction()?;
            list(&tx, sort)
        })
    }
}
