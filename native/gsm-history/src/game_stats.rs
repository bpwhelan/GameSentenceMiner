use crate::{
    novelty::{build_game_word_novelty, build_global_word_novelty},
    sessions::{characters, reading_seconds},
    stats::local_date,
    tokenization::table_exists,
    Result,
};
use chrono::{Datelike, Local, NaiveDate, NaiveTime, TimeZone};
use flate2::read::ZlibDecoder;
use indexmap::IndexMap;
use rusqlite::{params, types::ValueRef, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const GAME_STATUS_VALUES: &[&str] = &["in_progress", "completed", "planned", "on_hold", "dropped"];
const JITEN_DIFFICULTY_LABELS: &[&str] = &["Beginner", "Easy", "Average", "Hard", "Expert", "Insane"];
const CHART_COLORS: &[&str] = &[
    "#3498db", "#e74c3c", "#2ecc71", "#f1c40f", "#9b59b6", "#1abc9c", "#e67e22",
];

fn format_large_number(num: f64) -> String {
    if num >= 1_000_000.0 {
        format!("{:.1}M", num / 1_000_000.0)
    } else if num >= 1_000.0 {
        format!("{:.1}K", num / 1_000.0)
    } else {
        format!("{}", num as i64)
    }
}

fn format_time_human_readable(hours: f64) -> String {
    if hours < 1.0 {
        let minutes = (hours * 60.0) as i64;
        format!("{minutes}m")
    } else if hours < 24.0 {
        let whole_hours = hours as i64;
        let minutes = ((hours - whole_hours as f64) * 60.0) as i64;
        if minutes > 0 {
            format!("{whole_hours}h {minutes}m")
        } else {
            format!("{whole_hours}h")
        }
    } else {
        let days = (hours / 24.0) as i64;
        let rem = (hours % 24.0) as i64;
        if rem > 0 {
            format!("{days}d {rem}h")
        } else {
            format!("{days}d")
        }
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn val_str(val: ValueRef<'_>) -> String {
    match val {
        ValueRef::Null => String::new(),
        ValueRef::Text(b) => String::from_utf8_lossy(b).into_owned(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Blob(b) => String::from_utf8_lossy(b).into_owned(),
    }
}

fn val_opt_f64(val: ValueRef<'_>) -> Option<f64> {
    match val {
        ValueRef::Null => None,
        ValueRef::Real(f) => Some(f),
        ValueRef::Integer(i) => Some(i as f64),
        ValueRef::Text(b) => std::str::from_utf8(b).ok()?.trim().parse::<f64>().ok(),
        ValueRef::Blob(_) => None,
    }
}

fn val_opt_i64(val: ValueRef<'_>) -> Option<i64> {
    match val {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i),
        ValueRef::Real(f) => Some(f as i64),
        ValueRef::Text(b) => {
            let s = std::str::from_utf8(b).ok()?.trim();
            if s.is_empty() {
                None
            } else {
                s.parse::<i64>()
                    .ok()
                    .or_else(|| s.parse::<f64>().ok().map(|f| f as i64))
            }
        }
        ValueRef::Blob(_) => None,
    }
}

fn parse_json_array_strings(raw: &str) -> Vec<String> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => items
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_json_array_values(raw: &str) -> Vec<Value> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

fn count_cards_raw(note_ids: &str, screenshot_in_anki: &str, audio_in_anki: &str) -> i64 {
    let trimmed = note_ids.trim();
    if !trimmed.is_empty() && trimmed != "[]" && trimmed != "null" {
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(trimmed) {
            let count = items
                .iter()
                .filter(|v| match v {
                    Value::Null => false,
                    Value::String(s) => !s.trim().is_empty(),
                    _ => true,
                })
                .count();
            if count > 0 {
                return count as i64;
            }
        } else {
            return 1;
        }
    }
    if !screenshot_in_anki.trim().is_empty() || !audio_in_anki.trim().is_empty() {
        1
    } else {
        0
    }
}

fn load_reading_breaks(conn: &Connection, start: f64, end: f64) -> Vec<f64> {
    if !table_exists(conn, "reading_breaks") {
        return Vec::new();
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT CAST(timestamp AS REAL) FROM reading_breaks \
         WHERE CAST(timestamp AS REAL) >= ?1 AND CAST(timestamp AS REAL) <= ?2 \
         ORDER BY CAST(timestamp AS REAL) ASC",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![start, end], |r| r.get::<_, f64>(0)) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

fn calc_reading_time(samples: &[(f64, usize)], session_gap: f64, breaks: &[f64]) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let mut total = 0.0;
    let mut start_idx = 0usize;
    for i in 1..samples.len() {
        let gap = samples[i].0 - samples[i - 1].0;
        let has_break = {
            let pos = breaks.partition_point(|&b| b < samples[i - 1].0);
            breaks.get(pos).is_some_and(|&b| b < samples[i].0)
        };
        if gap > session_gap || has_break {
            if i - start_idx >= 2 {
                total += reading_seconds(
                    samples[start_idx..i]
                        .windows(2)
                        .map(|w| (w[0].0, w[1].0, w[0].1)),
                    breaks,
                );
            }
            start_idx = i;
        }
    }
    if samples.len() - start_idx >= 2 {
        total += reading_seconds(
            samples[start_idx..]
                .windows(2)
                .map(|w| (w[0].0, w[1].0, w[0].1)),
            breaks,
        );
    }
    total
}

fn local_day_range(date: NaiveDate) -> (f64, f64) {
    let start_naive = date.and_time(NaiveTime::from_hms_opt(0, 0, 0).unwrap());
    let end_naive = date.and_time(NaiveTime::from_hms_micro_opt(23, 59, 59, 999_999).unwrap());
    let s = Local
        .from_local_datetime(&start_naive)
        .earliest()
        .map(|dt| dt.timestamp() as f64)
        .unwrap_or(0.0);
    let e = Local
        .from_local_datetime(&end_naive)
        .latest()
        .map(|dt| dt.timestamp() as f64 + 0.999_999)
        .unwrap_or(f64::MAX);
    (s, e)
}

#[derive(Deserialize)]
struct ArchivedLineEvent(
    f64,
    usize,
    i64,
    serde::de::IgnoredAny,
    serde::de::IgnoredAny,
    serde::de::IgnoredAny,
    serde::de::IgnoredAny,
);

struct LineSample {
    ts: f64,
    chars: usize,
    cards: i64,
    game_id: String,
    game_name: String,
}

fn fetch_live_and_archived_lines(
    conn: &Connection,
    start: Option<f64>,
    end: Option<f64>,
    game_id: Option<&str>,
) -> Result<Vec<LineSample>> {
    let mut conds: Vec<&str> = Vec::new();
    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(gid) = game_id {
        conds.push("game_id = ?");
        params_vec.push(gid.to_owned().into());
    }
    if let Some(s) = start {
        conds.push("CAST(timestamp AS REAL) >= ?");
        params_vec.push(s.into());
    }
    if let Some(e) = end {
        conds.push("CAST(timestamp AS REAL) <= ?");
        params_vec.push(e.into());
    }
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let sql = format!(
        "SELECT CAST(timestamp AS REAL), line_text, game_id, game_name, note_ids, \
                screenshot_in_anki, audio_in_anki \
         FROM game_lines {where_sql} ORDER BY CAST(timestamp AS REAL) ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params_vec.iter()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let ts = val_opt_f64(row.get_ref(0)?).unwrap_or(0.0);
        let text = val_str(row.get_ref(1)?);
        let chars = characters(&text);
        let gid = val_str(row.get_ref(2)?);
        let gname = val_str(row.get_ref(3)?);
        let note_ids = val_str(row.get_ref(4)?);
        let ss = val_str(row.get_ref(5)?);
        let au = val_str(row.get_ref(6)?);
        let cards = count_cards_raw(&note_ids, &ss, &au);
        out.push(LineSample {
            ts,
            chars,
            cards,
            game_id: gid,
            game_name: gname,
        });
    }

    if table_exists(conn, "archived_game_days") {
        let mut a_conds: Vec<&str> = Vec::new();
        let mut a_params: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(gid) = game_id {
            a_conds.push("game_id = ?");
            a_params.push(gid.to_owned().into());
        }
        if let Some(s) = start {
            if let Ok(d) = local_date(s) {
                a_conds.push("date >= ?");
                a_params.push(d.format("%Y-%m-%d").to_string().into());
            }
        }
        if let Some(e) = end {
            if let Ok(d) = local_date(e) {
                a_conds.push("date <= ?");
                a_params.push(d.format("%Y-%m-%d").to_string().into());
            }
        }
        let a_where = if a_conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", a_conds.join(" AND "))
        };
        let mut astmt = conn.prepare(&format!(
            "SELECT game_id, game_name, events FROM archived_game_days {a_where} ORDER BY date ASC, game_id ASC"
        ))?;
        let mut arows = astmt.query(rusqlite::params_from_iter(a_params.iter()))?;
        while let Some(row) = arows.next()? {
            let gid = val_str(row.get_ref(0)?);
            let gname = val_str(row.get_ref(1)?);
            let blob = row.get_ref(2)?.as_blob()?;
            let events: Vec<ArchivedLineEvent> =
                serde_json::from_reader(std::io::BufReader::new(ZlibDecoder::new(blob)))?;
            for ArchivedLineEvent(ts, chars, cards, ..) in events {
                if start.is_some_and(|s| ts < s) || end.is_some_and(|e| ts > e) {
                    continue;
                }
                out.push(LineSample {
                    ts,
                    chars,
                    cards,
                    game_id: gid.clone(),
                    game_name: gname.clone(),
                });
            }
        }
        out.sort_by(|a, b| a.ts.total_cmp(&b.ts));
    }

    Ok(out)
}

struct GameRecord {
    id: String,
    deck_id: Option<i64>,
    title_original: String,
    title_romaji: String,
    title_english: String,
    obs_scene_name: String,
    game_type: String,
    description: String,
    image: String,
    genres: Vec<String>,
    tags: Vec<String>,
    links: Vec<Value>,
    completed: bool,
    status: String,
    character_count: i64,
    difficulty: Option<i64>,
    release_date: String,
    manual_overrides: Vec<Value>,
    character_summary: String,
    vndb_id: String,
    anilist_id: String,
}

impl GameRecord {
    fn effective_status(&self) -> &str {
        if GAME_STATUS_VALUES.contains(&self.status.as_str()) {
            self.status.as_str()
        } else if self.completed {
            "completed"
        } else {
            "in_progress"
        }
    }

    fn display_title(&self) -> String {
        if !self.title_original.is_empty() {
            self.title_original.clone()
        } else if !self.title_romaji.is_empty() {
            self.title_romaji.clone()
        } else if !self.title_english.is_empty() {
            self.title_english.clone()
        } else {
            self.obs_scene_name.clone()
        }
    }
}

fn table_columns(conn: &Connection, table: &str) -> HashSet<String> {
    let mut cols = HashSet::new();
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return cols;
    };
    let Ok(mut rows) = stmt.query([]) else {
        return cols;
    };
    while let Ok(Some(row)) = rows.next() {
        if let Ok(name) = row.get::<_, String>(1) {
            cols.insert(name);
        }
    }
    cols
}

fn load_games(conn: &Connection, include_images: bool, single_id: Option<&str>) -> Result<Vec<GameRecord>> {
    if !table_exists(conn, "games") {
        return Ok(Vec::new());
    }
    let cols = table_columns(conn, "games");
    let col = |name: &str| -> String {
        if cols.contains(name) {
            name.to_owned()
        } else {
            format!("NULL AS {name}")
        }
    };
    let image_expr = if !cols.contains("image") {
        "NULL AS image".to_owned()
    } else if include_images {
        "image".to_owned()
    } else {
        "CASE WHEN image IS NOT NULL AND image != '' THEN '1' ELSE '' END AS image".to_owned()
    };
    let select_list = [
        col("id"),
        col("deck_id"),
        col("title_original"),
        col("title_romaji"),
        col("title_english"),
        col("obs_scene_name"),
        col("type"),
        col("description"),
        image_expr,
        col("genres"),
        col("tags"),
        col("links"),
        col("completed"),
        col("status"),
        col("character_count"),
        col("difficulty"),
        col("release_date"),
        col("manual_overrides"),
        col("character_summary"),
        col("vndb_id"),
        col("anilist_id"),
    ]
    .join(", ");

    let (sql, params_vec): (String, Vec<rusqlite::types::Value>) = match single_id {
        Some(gid) => (
            format!("SELECT {select_list} FROM games WHERE id = ?1"),
            vec![gid.to_owned().into()],
        ),
        None => (format!("SELECT {select_list} FROM games"), Vec::new()),
    };
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params_vec.iter()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let status_raw = val_str(row.get_ref(13)?);
        let status = if GAME_STATUS_VALUES.contains(&status_raw.as_str()) {
            status_raw
        } else {
            String::new()
        };
        let completed_col = val_opt_i64(row.get_ref(12)?).unwrap_or(0) != 0;
        let completed = if !status.is_empty() {
            status == "completed"
        } else {
            completed_col
        };
        out.push(GameRecord {
            id: val_str(row.get_ref(0)?),
            deck_id: val_opt_i64(row.get_ref(1)?),
            title_original: val_str(row.get_ref(2)?),
            title_romaji: val_str(row.get_ref(3)?),
            title_english: val_str(row.get_ref(4)?),
            obs_scene_name: val_str(row.get_ref(5)?),
            game_type: val_str(row.get_ref(6)?),
            description: val_str(row.get_ref(7)?),
            image: val_str(row.get_ref(8)?),
            genres: parse_json_array_strings(&val_str(row.get_ref(9)?)),
            tags: parse_json_array_strings(&val_str(row.get_ref(10)?)),
            links: parse_json_array_values(&val_str(row.get_ref(11)?)),
            completed,
            status,
            character_count: val_opt_i64(row.get_ref(14)?).unwrap_or(0),
            difficulty: val_opt_i64(row.get_ref(15)?),
            release_date: val_str(row.get_ref(16)?),
            manual_overrides: parse_json_array_values(&val_str(row.get_ref(17)?)),
            character_summary: val_str(row.get_ref(18)?),
            vndb_id: val_str(row.get_ref(19)?),
            anilist_id: val_str(row.get_ref(20)?),
        });
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct GameStatsQuery {
    pub game_id: String,
    pub today: NaiveDate,
    pub session_gap: f64,
    pub tokenization_enabled: bool,
}

struct LinkedTpEntry {
    title: String,
    chars: i64,
    time: f64,
    lines: i64,
}

fn load_linked_third_party(
    conn: &Connection,
    start_date: &str,
    end_date: &str,
    game_id: Option<&str>,
) -> Result<BTreeMap<String, BTreeMap<String, LinkedTpEntry>>> {
    let mut out: BTreeMap<String, BTreeMap<String, LinkedTpEntry>> = BTreeMap::new();
    if !table_exists(conn, "third_party_stats") {
        return Ok(out);
    }
    let mut sql = String::from(
        "SELECT date, game_id, MAX(label), SUM(characters_read), SUM(time_read_seconds), SUM(lines_read) \
         FROM third_party_stats WHERE game_id IS NOT NULL AND game_id != '' AND date >= ?1 AND date <= ?2",
    );
    let mut params_vec: Vec<rusqlite::types::Value> = vec![
        start_date.to_owned().into(),
        end_date.to_owned().into(),
    ];
    if let Some(gid) = game_id {
        sql.push_str(" AND game_id = ?3");
        params_vec.push(gid.to_owned().into());
    }
    sql.push_str(" GROUP BY date, game_id ORDER BY date, game_id");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params_vec.iter()))?;
    while let Some(row) = rows.next()? {
        let date = val_str(row.get_ref(0)?);
        let gid = val_str(row.get_ref(1)?);
        out.entry(date).or_default().insert(
            gid,
            LinkedTpEntry {
                title: val_str(row.get_ref(2)?),
                chars: val_opt_i64(row.get_ref(3)?).unwrap_or(0),
                time: val_opt_f64(row.get_ref(4)?).unwrap_or(0.0),
                lines: val_opt_i64(row.get_ref(5)?).unwrap_or(0),
            },
        );
    }
    Ok(out)
}

impl GameStatsQuery {
    pub fn run(&self, conn: &Connection) -> Result<Value> {
        let mut games = load_games(conn, true, Some(&self.game_id))?;
        let Some(game) = games.pop() else {
            return Ok(json!({ "not_found": true }));
        };

        let (mut min_ts, mut max_ts): (Option<f64>, Option<f64>) = conn.query_row(
            "SELECT MIN(CAST(timestamp AS REAL)), MAX(CAST(timestamp AS REAL)) \
             FROM game_lines WHERE game_id = ?1",
            [self.game_id.as_str()],
            |r| Ok((val_opt_f64(r.get_ref(0)?), val_opt_f64(r.get_ref(1)?))),
        )?;

        let mut archived_lines: i64 = 0;
        if table_exists(conn, "archived_game_days") {
            let (arch_count, arch_min, arch_max): (i64, Option<f64>, Option<f64>) = conn.query_row(
                "SELECT COALESCE(SUM(line_count), 0), MIN(first_timestamp), MAX(last_timestamp) \
                 FROM archived_game_days WHERE game_id = ?1",
                [self.game_id.as_str()],
                |r| {
                    Ok((
                        r.get(0)?,
                        val_opt_f64(r.get_ref(1)?),
                        val_opt_f64(r.get_ref(2)?),
                    ))
                },
            )?;
            archived_lines = arch_count;
            if archived_lines > 0 {
                if let Some(a_min) = arch_min {
                    min_ts = Some(min_ts.map_or(a_min, |m| m.min(a_min)));
                }
                if let Some(a_max) = arch_max {
                    max_ts = Some(max_ts.map_or(a_max, |m| m.max(a_max)));
                }
            }
        }

        let Some((min_t, max_t)) = min_ts.zip(max_ts) else {
            let nov = build_game_word_novelty(conn, &self.game_id, None, None, self.tokenization_enabled)?;
            return self.assemble_payload(
                conn,
                &game,
                archived_lines,
                0,
                0.0,
                0,
                0,
                String::new(),
                String::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                BTreeMap::new(),
                nov,
            );
        };

        let today_str = self.today.format("%Y-%m-%d").to_string();
        let first_date_d = local_date(min_t)?;
        let last_date_d = local_date(max_t)?;
        let first_date = first_date_d.format("%Y-%m-%d").to_string();
        let last_date = last_date_d.format("%Y-%m-%d").to_string();
        let nov = build_game_word_novelty(
            conn,
            &self.game_id,
            Some(first_date_d),
            Some(last_date_d),
            self.tokenization_enabled,
        )?;

        let today_lines = if last_date == today_str {
            let (ts_start, ts_end) = local_day_range(self.today);
            fetch_live_and_archived_lines(conn, Some(ts_start), Some(ts_end), Some(&self.game_id))?
        } else {
            Vec::new()
        };
        let today_breaks = if !today_lines.is_empty() {
            let (ts_start, ts_end) = local_day_range(self.today);
            load_reading_breaks(conn, ts_start, ts_end)
        } else {
            Vec::new()
        };

        // 1) Try game_daily_rollup fast path
        if table_exists(conn, "game_daily_rollup") {
            let rollup_end = if last_date < today_str {
                last_date.as_str()
            } else {
                today_str.as_str()
            };
            let mut stmt = conn.prepare(
                "SELECT date, total_characters, total_lines, total_cards_mined, total_reading_time_seconds \
                 FROM game_daily_rollup WHERE game_id = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date ASC",
            )?;
            let rollup_rows: Vec<(String, i64, i64, i64, f64)> = stmt
                .query_map(params![self.game_id.as_str(), first_date.as_str(), rollup_end], |r| {
                    Ok((
                        val_str(r.get_ref(0)?),
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        val_opt_f64(r.get_ref(4)?).unwrap_or(0.0),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            if !rollup_rows.is_empty() || !today_lines.is_empty() {
                let mut total_sentences = 0i64;
                let mut total_characters = 0i64;
                let mut total_cards = 0i64;
                let mut total_time = 0.0f64;
                let mut labels = Vec::new();
                let mut speeds = Vec::new();
                let mut chars_vec = Vec::new();
                let mut time_vec = Vec::new();
                let mut cards_vec = Vec::new();
                let mut lines_vec = Vec::new();
                let mut secs_vec = Vec::new();
                let mut idx_map: HashMap<String, usize> = HashMap::new();

                for (date, c, l, cards, sec) in rollup_rows {
                    total_characters += c;
                    total_sentences += l;
                    total_cards += cards;
                    total_time += sec;
                    let hrs = if sec > 0.0 { sec / 3600.0 } else { 0.0 };
                    let spd = if hrs > 0.0 { (c as f64 / hrs) as i64 } else { 0 };
                    idx_map.insert(date.clone(), labels.len());
                    labels.push(date);
                    speeds.push(spd);
                    chars_vec.push(c);
                    time_vec.push(round2(hrs));
                    cards_vec.push(cards);
                    lines_vec.push(l);
                    secs_vec.push(sec);
                }

                if !today_lines.is_empty() {
                    let samples: Vec<(f64, usize)> =
                        today_lines.iter().map(|l| (l.ts, l.chars)).collect();
                    let t_chars: i64 = today_lines.iter().map(|l| l.chars as i64).sum();
                    let t_cards: i64 = today_lines.iter().map(|l| l.cards).sum();
                    let t_lines = today_lines.len() as i64;
                    let t_sec = calc_reading_time(&samples, self.session_gap, &today_breaks);
                    let t_hrs = if t_sec > 0.0 { t_sec / 3600.0 } else { 0.0 };
                    let t_spd = if t_hrs > 0.0 {
                        (t_chars as f64 / t_hrs) as i64
                    } else {
                        0
                    };
                    if let Some(&idx) = idx_map.get(&today_str) {
                        total_sentences += t_lines - lines_vec[idx];
                        total_characters += t_chars - chars_vec[idx];
                        total_cards += t_cards - cards_vec[idx];
                        total_time += t_sec - secs_vec[idx];
                        speeds[idx] = t_spd;
                        chars_vec[idx] = t_chars;
                        time_vec[idx] = round2(t_hrs);
                        cards_vec[idx] = t_cards;
                        secs_vec[idx] = t_sec;
                    } else {
                        total_sentences += t_lines;
                        total_characters += t_chars;
                        total_cards += t_cards;
                        total_time += t_sec;
                        labels.push(today_str.clone());
                        speeds.push(t_spd);
                        chars_vec.push(t_chars);
                        time_vec.push(round2(t_hrs));
                        cards_vec.push(t_cards);
                        secs_vec.push(t_sec);
                    }
                }

                let mut heatmap: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
                for (i, lbl) in labels.iter().enumerate() {
                    heatmap
                        .entry(lbl[..4.min(lbl.len())].to_owned())
                        .or_default()
                        .insert(lbl.clone(), speeds[i]);
                }
                return self.assemble_payload(
                    conn,
                    &game,
                    archived_lines,
                    total_characters,
                    total_time,
                    total_cards,
                    total_sentences,
                    first_date,
                    last_date,
                    labels,
                    speeds,
                    chars_vec,
                    time_vec,
                    cards_vec,
                    secs_vec,
                    heatmap,
                    nov,
                );
            }
        }

        // 2) Try daily_stats_rollup.game_activity_data path
        let first_rollup_date: Option<String> = if table_exists(conn, "daily_stats_rollup") {
            conn.query_row("SELECT MIN(date) FROM daily_stats_rollup", [], |r| {
                r.get(0)
            })
            .ok()
            .flatten()
        } else {
            None
        };
        if let Some(ref frd) = first_rollup_date {
            if first_date.as_str() >= frd.as_str() {
                let rollup_end = if last_date < today_str {
                    last_date.as_str()
                } else {
                    today_str.as_str()
                };
                let mut stmt = conn.prepare(
                    "SELECT date, game_activity_data FROM daily_stats_rollup \
                     WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC",
                )?;
                let mut rows = stmt.query(params![first_date.as_str(), rollup_end])?;
                let mut total_sentences = 0i64;
                let mut total_characters = 0i64;
                let mut total_cards = 0i64;
                let mut total_time = 0.0f64;
                let mut labels = Vec::new();
                let mut speeds = Vec::new();
                let mut chars_vec = Vec::new();
                let mut time_vec = Vec::new();
                let mut secs_vec = Vec::new();
                let mut cards_vec = Vec::new();
                let mut heatmap: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
                let mut today_idx: Option<usize> = None;
                let mut today_rollup_totals = (0i64, 0i64, 0i64, 0.0f64);
                let mut cards_complete = true;

                while let Some(row) = rows.next()? {
                    let date = val_str(row.get_ref(0)?);
                    let raw = val_str(row.get_ref(1)?);
                    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) else {
                        continue;
                    };
                    let Some(act) = map.get(&self.game_id) else {
                        continue;
                    };
                    let dc = act.get("chars").and_then(Value::as_i64).unwrap_or(0);
                    let dl = act.get("lines").and_then(Value::as_i64).unwrap_or(0);
                    let dcards = match act.get("cards") {
                        None | Some(Value::Null) => {
                            cards_complete = false;
                            0
                        }
                        Some(v) => v.as_i64().unwrap_or(0),
                    };
                    let dsec = act.get("time").and_then(Value::as_f64).unwrap_or(0.0);
                    let dhrs = if dsec > 0.0 { dsec / 3600.0 } else { 0.0 };
                    let dspd = if dhrs > 0.0 {
                        (dc as f64 / dhrs) as i64
                    } else {
                        0
                    };
                    total_characters += dc;
                    total_sentences += dl;
                    total_cards += dcards;
                    total_time += dsec;
                    if date == today_str {
                        today_idx = Some(labels.len());
                        today_rollup_totals = (dc, dl, dcards, dsec);
                    }
                    heatmap
                        .entry(date[..4.min(date.len())].to_owned())
                        .or_default()
                        .insert(date.clone(), dspd);
                    labels.push(date);
                    speeds.push(dspd);
                    chars_vec.push(dc);
                    time_vec.push(round2(dhrs));
                    secs_vec.push(dsec);
                    cards_vec.push(dcards);
                }

                if !today_lines.is_empty() {
                    let samples: Vec<(f64, usize)> =
                        today_lines.iter().map(|l| (l.ts, l.chars)).collect();
                    let t_chars: i64 = today_lines.iter().map(|l| l.chars as i64).sum();
                    let t_cards: i64 = today_lines.iter().map(|l| l.cards).sum();
                    let t_lines = today_lines.len() as i64;
                    let t_sec = calc_reading_time(&samples, self.session_gap, &today_breaks);
                    let t_hrs = if t_sec > 0.0 { t_sec / 3600.0 } else { 0.0 };
                    let t_spd = if t_hrs > 0.0 {
                        (t_chars as f64 / t_hrs) as i64
                    } else {
                        0
                    };
                    if let Some(idx) = today_idx {
                        total_characters += t_chars - today_rollup_totals.0;
                        total_sentences += t_lines - today_rollup_totals.1;
                        total_cards += t_cards - today_rollup_totals.2;
                        total_time += t_sec - today_rollup_totals.3;
                        speeds[idx] = t_spd;
                        chars_vec[idx] = t_chars;
                        time_vec[idx] = round2(t_hrs);
                        secs_vec[idx] = t_sec;
                        cards_vec[idx] = t_cards;
                    } else {
                        total_characters += t_chars;
                        total_sentences += t_lines;
                        total_cards += t_cards;
                        total_time += t_sec;
                        labels.push(today_str.clone());
                        speeds.push(t_spd);
                        chars_vec.push(t_chars);
                        time_vec.push(round2(t_hrs));
                        secs_vec.push(t_sec);
                        cards_vec.push(t_cards);
                    }
                    heatmap
                        .entry(today_str[..4].to_owned())
                        .or_default()
                        .insert(today_str.clone(), t_spd);
                }

                if labels.first().map(String::as_str) == Some(first_date.as_str())
                    && labels.last().map(String::as_str) == Some(last_date.as_str())
                {
                    if !cards_complete {
                        let mut c_stmt = conn.prepare(
                            "SELECT CAST(timestamp AS REAL), note_ids, screenshot_in_anki, audio_in_anki \
                             FROM game_lines WHERE game_id = ?1",
                        )?;
                        let mut crows = c_stmt.query([self.game_id.as_str()])?;
                        let mut by_date: HashMap<String, i64> = HashMap::new();
                        total_cards = 0;
                        while let Some(row) = crows.next()? {
                            let ts = val_opt_f64(row.get_ref(0)?).unwrap_or(0.0);
                            let c = count_cards_raw(
                                &val_str(row.get_ref(1)?),
                                &val_str(row.get_ref(2)?),
                                &val_str(row.get_ref(3)?),
                            );
                            total_cards += c;
                            if let Ok(d) = local_date(ts) {
                                *by_date.entry(d.format("%Y-%m-%d").to_string()).or_insert(0) += c;
                            }
                        }
                        cards_vec = labels
                            .iter()
                            .map(|l| by_date.get(l).copied().unwrap_or(0))
                            .collect();
                    }
                    return self.assemble_payload(
                        conn,
                        &game,
                        archived_lines,
                        total_characters,
                        total_time,
                        total_cards,
                        total_sentences,
                        first_date,
                        last_date,
                        labels,
                        speeds,
                        chars_vec,
                        time_vec,
                        cards_vec,
                        secs_vec,
                        heatmap,
                        nov,
                    );
                }
            }
        }

        // 3) Live fallback from all game_lines for this game
        let all_lines = fetch_live_and_archived_lines(conn, None, None, Some(&self.game_id))?;
        let all_breaks = load_reading_breaks(conn, 0.0, f64::MAX);
        let total_sentences = all_lines.len() as i64;
        let mut total_characters = 0i64;
        let mut total_cards = 0i64;
        let mut all_samples = Vec::with_capacity(all_lines.len());
        let mut cards_by_date: HashMap<String, i64> = HashMap::new();
        let mut today_samples = Vec::new();
        let mut today_chars = 0i64;

        for line in &all_lines {
            total_characters += line.chars as i64;
            total_cards += line.cards;
            all_samples.push((line.ts, line.chars));
            if let Ok(d) = local_date(line.ts) {
                let ds = d.format("%Y-%m-%d").to_string();
                *cards_by_date.entry(ds.clone()).or_insert(0) += line.cards;
                if ds == today_str {
                    today_samples.push((line.ts, line.chars));
                    today_chars += line.chars as i64;
                }
            }
        }
        let total_time = calc_reading_time(&all_samples, self.session_gap, &all_breaks);

        let mut labels = Vec::new();
        let mut speeds = Vec::new();
        let mut chars_vec = Vec::new();
        let mut time_vec = Vec::new();
        let mut secs_vec = Vec::new();
        if table_exists(conn, "daily_stats_rollup") {
            let mut stmt = conn.prepare(
                "SELECT date, game_activity_data FROM daily_stats_rollup \
                 WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC",
            )?;
            let mut rows = stmt.query(params![first_date.as_str(), today_str.as_str()])?;
            while let Some(row) = rows.next()? {
                let date = val_str(row.get_ref(0)?);
                let raw = val_str(row.get_ref(1)?);
                let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if let Some(act) = map.get(&self.game_id) {
                    let dc = act.get("chars").and_then(Value::as_i64).unwrap_or(0);
                    let dsec = act.get("time").and_then(Value::as_f64).unwrap_or(0.0);
                    let dhrs = if dsec > 0.0 { dsec / 3600.0 } else { 0.0 };
                    let dspd = if dhrs > 0.0 {
                        (dc as f64 / dhrs) as i64
                    } else {
                        0
                    };
                    labels.push(date);
                    speeds.push(dspd);
                    chars_vec.push(dc);
                    time_vec.push(round2(dhrs));
                    secs_vec.push(dsec);
                }
            }
        }
        if !today_samples.is_empty() && labels.last().map(String::as_str) != Some(today_str.as_str()) {
            let t_sec = calc_reading_time(&today_samples, self.session_gap, &all_breaks);
            let t_hrs = if t_sec > 0.0 { t_sec / 3600.0 } else { 0.0 };
            let t_spd = if t_hrs > 0.0 {
                (today_chars as f64 / t_hrs) as i64
            } else {
                0
            };
            labels.push(today_str.clone());
            speeds.push(t_spd);
            chars_vec.push(today_chars);
            time_vec.push(round2(t_hrs));
            secs_vec.push(t_sec);
        }
        let cards_vec: Vec<i64> = labels
            .iter()
            .map(|l| cards_by_date.get(l).copied().unwrap_or(0))
            .collect();
        let mut heatmap: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
        for (i, lbl) in labels.iter().enumerate() {
            heatmap
                .entry(lbl[..4.min(lbl.len())].to_owned())
                .or_default()
                .insert(lbl.clone(), speeds[i]);
        }

        self.assemble_payload(
            conn,
            &game,
            archived_lines,
            total_characters,
            total_time,
            total_cards,
            total_sentences,
            first_date,
            last_date,
            labels,
            speeds,
            chars_vec,
            time_vec,
            cards_vec,
            secs_vec,
            heatmap,
            nov,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn assemble_payload(
        &self,
        conn: &Connection,
        game: &GameRecord,
        archived_lines: i64,
        mut total_characters: i64,
        mut total_time_seconds: f64,
        total_cards_mined: i64,
        mut total_sentences: i64,
        mut first_date: String,
        mut last_date: String,
        mut daily_labels: Vec<String>,
        mut daily_speed: Vec<i64>,
        mut daily_chars: Vec<i64>,
        mut daily_time: Vec<f64>,
        mut daily_cards: Vec<i64>,
        daily_secs: Vec<f64>,
        mut heatmap: BTreeMap<String, BTreeMap<String, i64>>,
        nov: Value,
    ) -> Result<Value> {
        let imported = load_linked_third_party(conn, "0001-01-01", "9999-12-31", Some(&game.id))?;
        if !imported.is_empty() {
            let mut days: BTreeMap<String, (i64, f64, i64)> = BTreeMap::new();
            for (i, d) in daily_labels.iter().enumerate() {
                let sec = daily_secs
                    .get(i)
                    .copied()
                    .unwrap_or_else(|| daily_time[i] * 3600.0);
                days.insert(d.clone(), (daily_chars[i], sec, daily_cards[i]));
            }
            for (date, by_game) in imported {
                if let Some(entry) = by_game.get(&game.id) {
                    let day = days.entry(date).or_insert((0, 0.0, 0));
                    day.0 += entry.chars;
                    day.1 += entry.time;
                    total_characters += entry.chars;
                    total_time_seconds += entry.time;
                    total_sentences += entry.lines;
                }
            }
            daily_labels = days.keys().cloned().collect();
            daily_chars = days.values().map(|v| v.0).collect();
            daily_time = days.values().map(|v| round2(v.1 / 3600.0)).collect();
            daily_cards = days.values().map(|v| v.2).collect();
            daily_speed = days
                .values()
                .map(|v| {
                    if v.1 > 0.0 {
                        (v.0 as f64 * 3600.0 / v.1) as i64
                    } else {
                        0
                    }
                })
                .collect();
            if let Some(first_lbl) = daily_labels.first() {
                if first_date.is_empty() || first_lbl < &first_date {
                    first_date = first_lbl.clone();
                }
            }
            if let Some(last_lbl) = daily_labels.last() {
                if last_date.is_empty() || last_lbl > &last_date {
                    last_date = last_lbl.clone();
                }
            }
            heatmap.clear();
            for (d, &spd) in daily_labels.iter().zip(daily_speed.iter()) {
                heatmap
                    .entry(d[..4.min(d.len())].to_owned())
                    .or_default()
                    .insert(d.clone(), spd);
            }
        }

        let total_time_hours = total_time_seconds / 3600.0;
        let reading_speed = if total_time_hours > 0.0 {
            (total_characters as f64 / total_time_hours) as i64
        } else {
            0
        };

        Ok(json!({
            "game": {
                "id": game.id,
                "archived_line_count": archived_lines,
                "deck_id": game.deck_id,
                "title_original": game.title_original,
                "title_romaji": game.title_romaji,
                "title_english": game.title_english,
                "obs_scene_name": game.obs_scene_name,
                "type": game.game_type,
                "description": game.description,
                "image": game.image,
                "genres": game.genres,
                "tags": game.tags,
                "links": game.links,
                "completed": game.completed,
                "status": game.effective_status(),
                "character_count": game.character_count,
                "difficulty": game.difficulty,
                "release_date": game.release_date,
                "manual_overrides": game.manual_overrides,
                "character_summary": game.character_summary,
                "vndb_id": game.vndb_id,
                "anilist_id": game.anilist_id,
            },
            "stats": {
                "total_characters": total_characters,
                "total_characters_formatted": format_large_number(total_characters as f64),
                "total_time_formatted": format_time_human_readable(total_time_hours),
                "total_time_hours": round2(total_time_hours),
                "total_cards_mined": total_cards_mined,
                "total_sentences": total_sentences,
                "reading_speed": reading_speed,
                "reading_speed_formatted": format_large_number(reading_speed as f64),
                "first_date": first_date,
                "last_date": last_date,
            },
            "dailySpeed": {
                "labels": daily_labels,
                "speedData": daily_speed,
                "charsData": daily_chars,
                "timeData": daily_time,
                "cardsData": daily_cards,
            },
            "heatmapData": heatmap,
            "tokenizationStatus": nov["tokenizationStatus"],
            "vocabulary": nov["vocabulary"],
        }))
    }
}

#[derive(Debug, Deserialize)]
pub struct DashboardStatsQuery {
    pub today: NaiveDate,
    pub session_gap: f64,
    #[serde(default)]
    pub filter_year: Option<String>,
    #[serde(default)]
    pub start_timestamp: Option<f64>,
    #[serde(default)]
    pub end_timestamp: Option<f64>,
    #[serde(default = "default_true")]
    pub include_tokenization: bool,
    #[serde(default)]
    pub tokenization_enabled: bool,
}

fn default_true() -> bool {
    true
}

struct RollupRow {
    date: String,
    total_lines: i64,
    total_characters: i64,
    total_sessions: i64,
    total_reading_time_seconds: f64,
    total_active_time_seconds: f64,
    longest_session_seconds: f64,
    shortest_session_seconds: f64,
    average_session_seconds: f64,
    average_reading_speed_chars_per_hour: f64,
    anki_cards_created: i64,
    hourly_activity_data: String,
    hourly_reading_speed_data: String,
    game_activity_data: String,
    genre_activity_data: String,
    type_activity_data: String,
    max_chars_in_session: i64,
}

#[derive(Default)]
struct PerGameAgg {
    title: String,
    chars: i64,
    time: f64,
    lines: i64,
    cards: i64,
}

#[derive(Default)]
struct GenreTypeAgg {
    chars: i64,
    time: f64,
    cards: i64,
}

struct TpDay {
    characters: i64,
    time_seconds: f64,
    lines: i64,
    linked: BTreeMap<String, LinkedTpEntry>,
    sessions: Option<(i64, f64, f64, f64, i64)>, // count, time, longest, shortest, max_chars
}

fn load_third_party_by_date(
    conn: &Connection,
    start_date: &str,
    end_date: &str,
) -> Result<BTreeMap<String, TpDay>> {
    let mut out: BTreeMap<String, TpDay> = BTreeMap::new();
    if !table_exists(conn, "third_party_stats") || start_date.is_empty() || end_date.is_empty() {
        return Ok(out);
    }
    let mut stmt = conn.prepare(
        "SELECT date, SUM(characters_read), SUM(time_read_seconds), SUM(lines_read) \
         FROM third_party_stats WHERE date >= ?1 AND date <= ?2 GROUP BY date",
    )?;
    let mut rows = stmt.query(params![start_date, end_date])?;
    while let Some(row) = rows.next()? {
        let date = val_str(row.get_ref(0)?);
        out.insert(
            date,
            TpDay {
                characters: val_opt_i64(row.get_ref(1)?).unwrap_or(0),
                time_seconds: val_opt_f64(row.get_ref(2)?).unwrap_or(0.0),
                lines: val_opt_i64(row.get_ref(3)?).unwrap_or(0),
                linked: BTreeMap::new(),
                sessions: None,
            },
        );
    }
    for (date, activity) in load_linked_third_party(conn, start_date, end_date, None)? {
        if let Some(day) = out.get_mut(&date) {
            day.linked = activity;
        }
    }
    let mut s_stmt = conn.prepare(
        "SELECT date, COUNT(*), SUM(time_read_seconds), MAX(time_read_seconds + 0), \
                MIN(NULLIF(time_read_seconds + 0, 0)), MAX(characters_read + 0) \
         FROM third_party_stats \
         WHERE date >= ?1 AND date <= ?2 AND source_id IS NOT NULL AND source_id != '' \
         GROUP BY date",
    )?;
    let mut s_rows = s_stmt.query(params![start_date, end_date])?;
    while let Some(row) = s_rows.next()? {
        let date = val_str(row.get_ref(0)?);
        if let Some(day) = out.get_mut(&date) {
            day.sessions = Some((
                val_opt_i64(row.get_ref(1)?).unwrap_or(0),
                val_opt_f64(row.get_ref(2)?).unwrap_or(0.0),
                val_opt_f64(row.get_ref(3)?).unwrap_or(0.0),
                val_opt_f64(row.get_ref(4)?).unwrap_or(0.0),
                val_opt_i64(row.get_ref(5)?).unwrap_or(0),
            ));
        }
    }
    Ok(out)
}

fn first_date_combined(conn: &Connection) -> Option<String> {
    let r_min: Option<String> = if table_exists(conn, "daily_stats_rollup") {
        conn.query_row("SELECT MIN(date) FROM daily_stats_rollup", [], |r| r.get(0))
            .ok()
            .flatten()
    } else {
        None
    };
    let tp_min: Option<String> = if table_exists(conn, "third_party_stats") {
        conn.query_row("SELECT MIN(date) FROM third_party_stats", [], |r| r.get(0))
            .ok()
            .flatten()
    } else {
        None
    };
    match (r_min.filter(|s| !s.is_empty()), tp_min.filter(|s| !s.is_empty())) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

impl DashboardStatsQuery {
    pub fn run(&self, conn: &Connection) -> Result<Value> {
        let today_str = self.today.format("%Y-%m-%d").to_string();
        let yesterday_str = self
            .today
            .pred_opt()
            .unwrap_or(self.today)
            .format("%Y-%m-%d")
            .to_string();

        let start_date_str = match self.start_timestamp {
            Some(ts) => local_date(ts)?.format("%Y-%m-%d").to_string(),
            None => first_date_combined(conn).unwrap_or_else(|| today_str.clone()),
        };
        let end_date_str = match self.end_timestamp {
            Some(ts) => local_date(ts)?.format("%Y-%m-%d").to_string(),
            None => today_str.clone(),
        };
        let today_in_range = end_date_str >= today_str;

        let mut rollups: Vec<RollupRow> = Vec::new();
        let historical_end = end_date_str.as_str().min(yesterday_str.as_str());
        if !start_date_str.is_empty()
            && start_date_str.as_str() <= yesterday_str.as_str()
            && table_exists(conn, "daily_stats_rollup")
        {
            let mut stmt = conn.prepare(
                "SELECT date, total_lines, total_characters, total_sessions, \
                        total_reading_time_seconds, total_active_time_seconds, \
                        longest_session_seconds, shortest_session_seconds, \
                        average_session_seconds, average_reading_speed_chars_per_hour, \
                        anki_cards_created, hourly_activity_data, hourly_reading_speed_data, \
                        game_activity_data, genre_activity_data, type_activity_data, \
                        max_chars_in_session \
                 FROM daily_stats_rollup WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC",
            )?;
            let mut rows = stmt.query(params![start_date_str.as_str(), historical_end])?;
            while let Some(row) = rows.next()? {
                rollups.push(RollupRow {
                    date: val_str(row.get_ref(0)?),
                    total_lines: val_opt_i64(row.get_ref(1)?).unwrap_or(0),
                    total_characters: val_opt_i64(row.get_ref(2)?).unwrap_or(0),
                    total_sessions: val_opt_i64(row.get_ref(3)?).unwrap_or(0),
                    total_reading_time_seconds: val_opt_f64(row.get_ref(4)?).unwrap_or(0.0),
                    total_active_time_seconds: val_opt_f64(row.get_ref(5)?).unwrap_or(0.0),
                    longest_session_seconds: val_opt_f64(row.get_ref(6)?).unwrap_or(0.0),
                    shortest_session_seconds: val_opt_f64(row.get_ref(7)?).unwrap_or(0.0),
                    average_session_seconds: val_opt_f64(row.get_ref(8)?).unwrap_or(0.0),
                    average_reading_speed_chars_per_hour: val_opt_f64(row.get_ref(9)?).unwrap_or(0.0),
                    anki_cards_created: val_opt_i64(row.get_ref(10)?).unwrap_or(0),
                    hourly_activity_data: val_str(row.get_ref(11)?),
                    hourly_reading_speed_data: val_str(row.get_ref(12)?),
                    game_activity_data: val_str(row.get_ref(13)?),
                    genre_activity_data: val_str(row.get_ref(14)?),
                    type_activity_data: val_str(row.get_ref(15)?),
                    max_chars_in_session: val_opt_i64(row.get_ref(16)?).unwrap_or(0),
                });
            }
        }

        // Load historical game_daily_rollup rows if complete coverage exists
        let mut gdr_rows: Vec<(String, String, i64, i64, i64, f64)> = Vec::new();
        if !rollups.is_empty()
            && !start_date_str.is_empty()
            && start_date_str.as_str() <= historical_end
            && table_exists(conn, "game_daily_rollup")
        {
            let mut stmt = conn.prepare(
                "SELECT date, game_id, total_characters, total_lines, total_cards_mined, total_reading_time_seconds \
                 FROM game_daily_rollup WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC, game_id ASC",
            )?;
            let mut rows = stmt.query(params![start_date_str.as_str(), historical_end])?;
            while let Some(row) = rows.next()? {
                gdr_rows.push((
                    val_str(row.get_ref(0)?),
                    val_str(row.get_ref(1)?),
                    val_opt_i64(row.get_ref(2)?).unwrap_or(0),
                    val_opt_i64(row.get_ref(3)?).unwrap_or(0),
                    val_opt_i64(row.get_ref(4)?).unwrap_or(0),
                    val_opt_f64(row.get_ref(5)?).unwrap_or(0.0),
                ));
            }
        }
        let gdr_dates: HashSet<&str> = gdr_rows.iter().map(|r| r.0.as_str()).collect();
        let use_gdr = !rollups.is_empty()
            && !gdr_rows.is_empty()
            && rollups.iter().all(|r| gdr_dates.contains(r.date.as_str()));

        // Load today's live lines + reading breaks
        let today_lines = if today_in_range {
            let (ts_s, ts_e) = local_day_range(self.today);
            fetch_live_and_archived_lines(conn, Some(ts_s), Some(ts_e), None)?
        } else {
            Vec::new()
        };
        let today_breaks = if !today_lines.is_empty() {
            let (ts_s, ts_e) = local_day_range(self.today);
            load_reading_breaks(conn, ts_s, ts_e)
        } else {
            Vec::new()
        };

        let third_party = load_third_party_by_date(conn, &start_date_str, &end_date_str)?;

        // Word novelty
        let start_d = NaiveDate::parse_from_str(&start_date_str, "%Y-%m-%d").ok();
        let end_d = NaiveDate::parse_from_str(&end_date_str, "%Y-%m-%d").ok();
        let novelty = if self.include_tokenization {
            build_global_word_novelty(conn, start_d, end_d, self.tokenization_enabled)?
        } else {
            build_global_word_novelty(conn, start_d, end_d, false)?
        };

        // Load all games without images
        let all_games = load_games(conn, false, None)?;
        let completed_games_count = all_games.iter().filter(|g| g.completed).count() as i64;
        let mut games_by_id: HashMap<&str, &GameRecord> = HashMap::with_capacity(all_games.len());
        let mut game_name_to_display: HashMap<String, String> = HashMap::new();
        let mut game_id_to_title: HashMap<String, String> = HashMap::new();
        for g in &all_games {
            if g.id.is_empty() {
                continue;
            }
            games_by_id.insert(g.id.as_str(), g);
            let title = g.display_title();
            if !title.is_empty() {
                game_id_to_title.insert(g.id.clone(), title.clone());
                game_name_to_display.insert(title.clone(), title.clone());
                if !g.obs_scene_name.is_empty() {
                    game_name_to_display.insert(g.obs_scene_name.clone(), title.clone());
                }
                if !g.title_romaji.is_empty() {
                    game_name_to_display.insert(g.title_romaji.clone(), title.clone());
                }
                if !g.title_english.is_empty() {
                    game_name_to_display.insert(g.title_english.clone(), title.clone());
                }
            }
        }

        // Aggregate rollups
        let mut r_lines = 0i64;
        let mut r_chars = 0i64;
        let mut r_sessions = 0i64;
        let mut r_time = 0.0f64;
        let mut r_active = 0.0f64;
        let mut r_longest = 0.0f64;
        let mut r_shortest: Option<f64> = None;
        let mut r_max_chars = 0i64;
        let mut r_weighted_speed = 0.0f64;
        let mut r_weighted_session = 0.0f64;
        let mut r_hourly_chars: [i64; 24] = [0; 24];
        let mut r_hourly_speed_sums: [f64; 24] = [0.0; 24];
        let mut r_hourly_speed_cnts: [i64; 24] = [0; 24];
        let mut r_game_activity: IndexMap<String, PerGameAgg> = IndexMap::new();
        let mut r_genre_activity: BTreeMap<String, GenreTypeAgg> = BTreeMap::new();
        let mut r_type_activity: BTreeMap<String, GenreTypeAgg> = BTreeMap::new();

        // Accumulator outputs
        let mut heatmap_data: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
        let mut speed_heatmap_data: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
        let mut max_reading_speed = 0i64;
        let mut max_daily_chars = 0i64;
        let mut max_daily_hours = 0.0f64;
        let mut dow_chars: [i64; 7] = [0; 7];
        let mut dow_hours: [f64; 7] = [0.0; 7];
        let mut dow_counts: [i64; 7] = [0; 7];
        let mut cards_labels: Vec<String> = Vec::with_capacity(rollups.len());
        let mut cards_totals: Vec<i64> = Vec::with_capacity(rollups.len());
        let mut mining_heatmap: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
        let mut daily_data: BTreeMap<String, BTreeMap<String, (i64, i64)>> = BTreeMap::new();
        let mut all_lines_by_date: IndexMap<String, (f64, i64)> = IndexMap::new();
        let mut rollup_dates: HashSet<&str> = HashSet::with_capacity(rollups.len());

        let mut per_game_aggregates: Option<IndexMap<String, PerGameAgg>> = None;
        if use_gdr {
            let mut agg: IndexMap<String, PerGameAgg> = IndexMap::new();
            for (date, gid, c, l, cards, sec) in &gdr_rows {
                if gid.is_empty() {
                    continue;
                }
                let title = game_id_to_title
                    .get(gid)
                    .cloned()
                    .unwrap_or_else(|| format!("Game {}", gid.chars().take(8).collect::<String>()));
                let day_entry = daily_data
                    .entry(date.clone())
                    .or_default()
                    .entry(title.clone())
                    .or_insert((0, 0));
                day_entry.0 += *l;
                day_entry.1 += *c;
                let entry = agg.entry(gid.clone()).or_default();
                entry.title = title;
                entry.chars += *c;
                entry.time += *sec;
                entry.lines += *l;
                entry.cards += *cards;
            }
            per_game_aggregates = Some(agg);
        }

        for r in &rollups {
            rollup_dates.insert(r.date.as_str());
            r_lines += r.total_lines;
            r_chars += r.total_characters;
            r_sessions += r.total_sessions;
            r_time += r.total_reading_time_seconds;
            r_active += r.total_active_time_seconds;
            if r.longest_session_seconds > r_longest {
                r_longest = r.longest_session_seconds;
            }
            if r.shortest_session_seconds > 0.0 {
                r_shortest = Some(r_shortest.map_or(r.shortest_session_seconds, |m| {
                    m.min(r.shortest_session_seconds)
                }));
            }
            if r.max_chars_in_session > r_max_chars {
                r_max_chars = r.max_chars_in_session;
            }
            if r.total_active_time_seconds > 0.0 {
                r_weighted_speed +=
                    r.average_reading_speed_chars_per_hour * r.total_active_time_seconds;
            }
            if r.total_sessions > 0 {
                r_weighted_session += r.average_session_seconds * r.total_sessions as f64;
            }

            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&r.hourly_activity_data) {
                for (k, v) in map {
                    if let (Ok(h), Some(c)) = (k.parse::<usize>(), v.as_i64()) {
                        if h < 24 {
                            r_hourly_chars[h] += c;
                        }
                    }
                }
            }
            if let Ok(Value::Object(map)) =
                serde_json::from_str::<Value>(&r.hourly_reading_speed_data)
            {
                for (k, v) in map {
                    if let (Ok(h), Some(s)) = (k.parse::<usize>(), v.as_f64()) {
                        if h < 24 && s > 0.0 {
                            r_hourly_speed_sums[h] += s;
                            r_hourly_speed_cnts[h] += 1;
                        }
                    }
                }
            }
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&r.genre_activity_data) {
                for (genre, v) in map {
                    let entry = r_genre_activity.entry(genre).or_default();
                    entry.chars += v.get("chars").and_then(Value::as_i64).unwrap_or(0);
                    entry.time += v.get("time").and_then(Value::as_f64).unwrap_or(0.0);
                    entry.cards += v.get("cards").and_then(Value::as_i64).unwrap_or(0);
                }
            }
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&r.type_activity_data) {
                for (mtype, v) in map {
                    let entry = r_type_activity.entry(mtype).or_default();
                    entry.chars += v.get("chars").and_then(Value::as_i64).unwrap_or(0);
                    entry.time += v.get("time").and_then(Value::as_f64).unwrap_or(0.0);
                    entry.cards += v.get("cards").and_then(Value::as_i64).unwrap_or(0);
                }
            }

            let year = r.date.split('-').next().unwrap_or("").to_owned();
            if self.filter_year.as_deref().is_none_or(|fy| fy == year) {
                heatmap_data
                    .entry(year.clone())
                    .or_default()
                    .insert(r.date.clone(), r.total_characters);
            }
            if r.total_reading_time_seconds > 0.0 && r.total_characters > 0 {
                let spd = (r.total_characters as f64 / (r.total_reading_time_seconds / 3600.0)) as i64;
                speed_heatmap_data
                    .entry(year.clone())
                    .or_default()
                    .insert(r.date.clone(), spd);
                if spd > max_reading_speed {
                    max_reading_speed = spd;
                }
            }
            if r.total_characters > max_daily_chars {
                max_daily_chars = r.total_characters;
            }
            let dhrs = r.total_reading_time_seconds / 3600.0;
            if dhrs > max_daily_hours {
                max_daily_hours = dhrs;
            }
            if let Ok(d) = NaiveDate::parse_from_str(&r.date, "%Y-%m-%d") {
                let dow = d.weekday().num_days_from_monday() as usize;
                dow_chars[dow] += r.total_characters;
                dow_hours[dow] += dhrs;
                dow_counts[dow] += 1;
            }
            all_lines_by_date.insert(
                r.date.clone(),
                (r.total_reading_time_seconds, r.total_characters),
            );
            cards_labels.push(r.date.clone());
            cards_totals.push(r.anki_cards_created);
            if r.anki_cards_created > 0 {
                mining_heatmap
                    .entry(year)
                    .or_default()
                    .insert(r.date.clone(), r.anki_cards_created);
            }
            if !use_gdr && !r.game_activity_data.is_empty() {
                if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&r.game_activity_data)
                {
                    for (gid, act) in map {
                        let fallback_title = act
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                format!("Game {}", gid.chars().take(8).collect::<String>())
                            });
                        let c = act.get("chars").and_then(Value::as_i64).unwrap_or(0);
                        let l = act.get("lines").and_then(Value::as_i64).unwrap_or(0);
                        let t = act.get("time").and_then(Value::as_f64).unwrap_or(0.0);
                        let day_entry = daily_data
                            .entry(r.date.clone())
                            .or_default()
                            .entry(fallback_title.clone())
                            .or_insert((0, 0));
                        day_entry.0 = l;
                        day_entry.1 = c;

                        let agg = r_game_activity.entry(gid.clone()).or_insert_with(|| PerGameAgg {
                            title: act
                                .get("title")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .unwrap_or_else(|| format!("Game {gid}")),
                            ..Default::default()
                        });
                        agg.chars += c;
                        agg.time += t;
                        agg.lines += l;
                    }
                }
            }
        }

        // Compute today's live stats
        let mut live_chars = 0i64;
        let mut live_lines_count = 0i64;
        let mut live_time = 0.0f64;
        let mut live_sessions = 0i64;
        let mut live_longest = 0.0f64;
        let mut live_shortest: Option<f64> = None;
        let mut live_max_chars = 0i64;
        let mut live_avg_session = 0.0f64;
        let mut live_avg_speed = 0.0f64;
        let mut live_genre_activity: BTreeMap<String, GenreTypeAgg> = BTreeMap::new();
        let mut live_type_activity: BTreeMap<String, GenreTypeAgg> = BTreeMap::new();

        if !today_lines.is_empty() {
            live_lines_count = today_lines.len() as i64;
            let mut session_starts = vec![0usize];
            for i in 1..today_lines.len() {
                let gap = today_lines[i].ts - today_lines[i - 1].ts;
                let has_break = {
                    let pos = today_breaks.partition_point(|&b| b < today_lines[i - 1].ts);
                    today_breaks
                        .get(pos)
                        .is_some_and(|&b| b < today_lines[i].ts)
                };
                if gap > self.session_gap || has_break {
                    session_starts.push(i);
                }
            }
            live_sessions = session_starts.len() as i64;
            for s_idx in 0..session_starts.len() {
                let a = session_starts[s_idx];
                let b = session_starts.get(s_idx + 1).copied().unwrap_or(today_lines.len());
                let slice = &today_lines[a..b];
                let s_chars: i64 = slice.iter().map(|l| l.chars as i64).sum();
                let s_time = if slice.len() >= 2 {
                    reading_seconds(
                        slice.windows(2).map(|w| (w[0].ts, w[1].ts, w[0].chars)),
                        &today_breaks,
                    )
                } else {
                    0.0
                };
                live_chars += s_chars;
                live_time += s_time;
                if s_time > live_longest {
                    live_longest = s_time;
                }
                if s_time > 0.0 {
                    live_shortest = Some(live_shortest.map_or(s_time, |m| m.min(s_time)));
                }
                if s_chars > live_max_chars {
                    live_max_chars = s_chars;
                }
            }
            if live_sessions > 0 {
                live_avg_session = live_time / live_sessions as f64;
            }
            if live_time > 0.0 {
                live_avg_speed = live_chars as f64 / (live_time / 3600.0);
            }

            // Per-game genre/type breakdown for today's live lines
            #[derive(Default)]
            struct LiveGameBucket {
                chars: i64,
                cards: i64,
                samples: Vec<(f64, usize)>,
            }
            let mut by_game_live: HashMap<&str, LiveGameBucket> = HashMap::new();
            for l in &today_lines {
                if l.game_id.is_empty() {
                    continue;
                }
                let entry = by_game_live.entry(l.game_id.as_str()).or_default();
                entry.chars += l.chars as i64;
                entry.cards += l.cards;
                entry.samples.push((l.ts, l.chars));
            }
            for (gid, bucket) in by_game_live {
                let gtime = calc_reading_time(&bucket.samples, self.session_gap, &today_breaks);
                if let Some(g) = games_by_id.get(gid) {
                    for genre in &g.genres {
                        if !genre.is_empty() {
                            let e = live_genre_activity.entry(genre.clone()).or_default();
                            e.chars += bucket.chars;
                            e.time += gtime;
                            e.cards += bucket.cards;
                        }
                    }
                    if !g.game_type.is_empty() {
                        let e = live_type_activity
                            .entry(g.game_type.trim().to_owned())
                            .or_default();
                        e.chars += bucket.chars;
                        e.time += gtime;
                        e.cards += bucket.cards;
                    }
                }
            }
        }

        // Merge third-party stats into accumulator
        for (date, tp) in &third_party {
            let year = date.split('-').next().unwrap_or("").to_owned();
            if self.filter_year.as_deref().is_none_or(|fy| fy == year) {
                *heatmap_data
                    .entry(year)
                    .or_default()
                    .entry(date.clone())
                    .or_insert(0) += tp.characters;
            }
            if let Ok(d) = NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                let dow = d.weekday().num_days_from_monday() as usize;
                dow_chars[dow] += tp.characters;
                dow_hours[dow] += tp.time_seconds / 3600.0;
                if !rollup_dates.contains(date.as_str()) {
                    dow_counts[dow] += 1;
                }
            }
            let entry = all_lines_by_date.entry(date.clone()).or_insert((0.0, 0));
            entry.0 += tp.time_seconds;
            entry.1 += tp.characters;

            let mut linked_chars = 0i64;
            for (gid, act) in &tp.linked {
                let title = game_id_to_title
                    .get(gid)
                    .cloned()
                    .unwrap_or_else(|| act.title.clone());
                let day_entry = daily_data
                    .entry(date.clone())
                    .or_default()
                    .entry(title)
                    .or_insert((0, 0));
                day_entry.0 += act.lines;
                day_entry.1 += act.chars;
                linked_chars += act.chars;
            }
            if tp.characters > linked_chars {
                let day_entry = daily_data
                    .entry(date.clone())
                    .or_default()
                    .entry("3rd Party Reading".to_owned())
                    .or_insert((0, 0));
                day_entry.1 += tp.characters - linked_chars;
            }
        }

        // Merge today's lines into daily_data
        for l in &today_lines {
            let day_str = local_date(l.ts)
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|_| today_str.clone());
            let gname = if l.game_name.is_empty() {
                "Unknown Game"
            } else {
                l.game_name.as_str()
            };
            let display = game_name_to_display
                .get(gname)
                .cloned()
                .unwrap_or_else(|| gname.to_owned());
            let entry = daily_data
                .entry(day_str)
                .or_default()
                .entry(display)
                .or_insert((0, 0));
            entry.0 += 1;
            entry.1 += l.chars as i64;
        }

        // Fallback when daily_data is empty
        if daily_data.is_empty() {
            if let (Some(s), Some(e)) = (self.start_timestamp, self.end_timestamp) {
                let fb_lines = fetch_live_and_archived_lines(conn, Some(s), Some(e), None)?;
                for l in &fb_lines {
                    let day_str = local_date(l.ts)
                        .map(|d| d.format("%Y-%m-%d").to_string())
                        .unwrap_or_else(|_| today_str.clone());
                    let gname = if l.game_name.is_empty() {
                        "Unknown Game"
                    } else {
                        l.game_name.as_str()
                    };
                    let display = game_name_to_display
                        .get(gname)
                        .cloned()
                        .unwrap_or_else(|| gname.to_owned());
                    let entry = daily_data
                        .entry(day_str)
                        .or_default()
                        .entry(display)
                        .or_insert((0, 0));
                    entry.0 += 1;
                    entry.1 += l.chars as i64;
                }
            }
            if daily_data.is_empty() {
                return Ok(json!({
                    "labels": [],
                    "datasets": [],
                    "tokenizationStatus": novelty["tokenizationStatus"],
                    "vocabularyStats": novelty["vocabularyStats"],
                    "newWordsSeries": novelty["newWordsSeries"],
                    "newWordsByGame": novelty["newWordsByGame"],
                }));
            }
        }

        // Build Chart.js datasets
        let sorted_days: Vec<String> = daily_data.keys().cloned().collect();
        let display_names: Vec<String> = {
            let mut set = BTreeSet::new();
            for day_map in daily_data.values() {
                for name in day_map.keys() {
                    set.insert(name.clone());
                }
            }
            set.into_iter().collect()
        };
        let mut datasets: Vec<Value> = Vec::with_capacity(display_names.len() * 2);
        for (i, name) in display_names.iter().enumerate() {
            let color = CHART_COLORS[i % CHART_COLORS.len()];
            let bg = format!("{color}33");
            let mut cum_lines = 0i64;
            let mut cum_chars = 0i64;
            let mut lines_series = Vec::with_capacity(sorted_days.len());
            let mut chars_series = Vec::with_capacity(sorted_days.len());
            for day in &sorted_days {
                if let Some(&(l, c)) = daily_data.get(day).and_then(|m| m.get(name)) {
                    cum_lines += l;
                    cum_chars += c;
                }
                lines_series.push(cum_lines);
                chars_series.push(cum_chars);
            }
            datasets.push(json!({
                "label": name,
                "data": lines_series,
                "borderColor": color,
                "backgroundColor": bg,
                "fill": false,
                "tension": 0.1,
                "for": "Lines Received",
            }));
            datasets.push(json!({
                "label": name,
                "data": chars_series,
                "borderColor": color,
                "backgroundColor": bg,
                "fill": false,
                "tension": 0.1,
                "hidden": true,
                "for": "Characters Read",
            }));
        }

        // Merge today's live lines into heatmap, reading speed heatmap, and mining heatmap
        if today_in_range && !today_lines.is_empty() {
            let mut today_by_date_chars: HashMap<String, i64> = HashMap::new();
            let mut today_by_date_cards: HashMap<String, i64> = HashMap::new();
            let mut today_by_date_samples: HashMap<String, Vec<(f64, usize)>> = HashMap::new();
            for l in &today_lines {
                if let Ok(d) = local_date(l.ts) {
                    let ds = d.format("%Y-%m-%d").to_string();
                    *today_by_date_chars.entry(ds.clone()).or_insert(0) += l.chars as i64;
                    if l.cards > 0 {
                        *today_by_date_cards.entry(ds.clone()).or_insert(0) += l.cards;
                    }
                    today_by_date_samples
                        .entry(ds)
                        .or_default()
                        .push((l.ts, l.chars));
                }
            }
            for (ds, chars) in &today_by_date_chars {
                let year = ds[..4.min(ds.len())].to_owned();
                if self.filter_year.as_deref().is_none_or(|fy| fy == year) {
                    *heatmap_data
                        .entry(year.clone())
                        .or_default()
                        .entry(ds.clone())
                        .or_insert(0) += *chars;
                }
                if let Some(samples) = today_by_date_samples.get(ds) {
                    let sec = calc_reading_time(samples, self.session_gap, &today_breaks);
                    if sec > 0.0 && *chars > 0 {
                        let spd = (*chars as f64 / (sec / 3600.0)) as i64;
                        if self.filter_year.as_deref().is_none_or(|fy| fy == year) {
                            speed_heatmap_data
                                .entry(year)
                                .or_default()
                                .insert(ds.clone(), spd);
                            if spd > max_reading_speed {
                                max_reading_speed = spd;
                            }
                        }
                    }
                }
            }
            for (ds, cards) in today_by_date_cards {
                let year = ds[..4.min(ds.len())].to_owned();
                *mining_heatmap
                    .entry(year)
                    .or_default()
                    .entry(ds)
                    .or_insert(0) += cards;
            }
        }

        // Combined stats (rollup + live + third_party)
        let mut c_lines = r_lines + live_lines_count;
        let mut c_chars = r_chars + live_chars;
        let mut c_time = r_time + live_time;
        let mut c_active = r_active + live_time;
        let mut c_sessions = r_sessions + live_sessions;
        let mut c_longest = r_longest.max(live_longest);
        let mut c_max_chars = r_max_chars.max(live_max_chars);
        let r_avg_speed = if r_active > 0.0 {
            r_weighted_speed / r_active
        } else {
            0.0
        };
        let r_avg_session = if r_sessions > 0 {
            r_weighted_session / r_sessions as f64
        } else {
            0.0
        };
        let mut c_avg_speed = if c_active > 0.0 {
            (r_avg_speed * r_active + live_avg_speed * live_time) / c_active
        } else {
            0.0
        };
        let mut c_avg_session = if c_sessions > 0 {
            (r_avg_session * r_sessions as f64 + live_avg_session * live_sessions as f64)
                / c_sessions as f64
        } else {
            0.0
        };
        let mut tp_total_chars = 0i64;
        let mut tp_total_time = 0.0f64;
        let mut tp_total_lines = 0i64;
        let mut tp_sess_count = 0i64;
        let mut tp_sess_time = 0.0f64;
        let mut tp_sess_longest = 0.0f64;
        let mut tp_sess_max_chars = 0i64;
        for tp in third_party.values() {
            tp_total_chars += tp.characters;
            tp_total_time += tp.time_seconds;
            tp_total_lines += tp.lines;
            if let Some((cnt, sec, longest, _shortest, mchars)) = tp.sessions {
                tp_sess_count += cnt;
                tp_sess_time += sec;
                if longest > tp_sess_longest {
                    tp_sess_longest = longest;
                }
                if mchars > tp_sess_max_chars {
                    tp_sess_max_chars = mchars;
                }
            }
        }
        if !third_party.is_empty() {
            c_chars += tp_total_chars;
            c_time += tp_total_time;
            c_active += tp_total_time;
            c_lines += tp_total_lines;
            if tp_sess_count > 0 {
                let native_dur = c_avg_session * c_sessions as f64;
                c_sessions += tp_sess_count;
                c_avg_session = (native_dur + tp_sess_time) / c_sessions as f64;
                c_longest = c_longest.max(tp_sess_longest);
                c_max_chars = c_max_chars.max(tp_sess_max_chars);
            }
            if c_active > 0.0 {
                c_avg_speed = (c_chars as f64 / c_active) * 3600.0;
            }
        }
        let _ = (c_avg_session, r_shortest, live_shortest);

        // Per-game stats (rollup + linked third_party)
        let mut pg_map: IndexMap<String, PerGameAgg> = IndexMap::new();
        let source_pg = per_game_aggregates.as_ref().unwrap_or(&r_game_activity);
        for (gid, act) in source_pg {
            pg_map.insert(
                gid.clone(),
                PerGameAgg {
                    title: act.title.clone(),
                    chars: act.chars,
                    time: act.time,
                    lines: act.lines,
                    cards: act.cards,
                },
            );
        }
        for tp in third_party.values() {
            for (gid, imp) in &tp.linked {
                let e = pg_map.entry(gid.clone()).or_insert_with(|| PerGameAgg {
                    title: imp.title.clone(),
                    ..Default::default()
                });
                e.chars += imp.chars;
                e.time += imp.time;
                e.lines += imp.lines;
            }
        }
        let mut tc_labels = Vec::new();
        let mut tc_totals = Vec::new();
        let mut rt_labels = Vec::new();
        let mut rt_totals = Vec::new();
        let mut rs_labels = Vec::new();
        let mut rs_totals = Vec::new();
        for (gid, act) in &pg_map {
            let title = game_id_to_title
                .get(gid)
                .cloned()
                .unwrap_or_else(|| act.title.clone());
            if act.chars > 0 {
                tc_labels.push(title.clone());
                tc_totals.push(act.chars);
            }
            if act.time > 0.0 {
                rt_labels.push(title.clone());
                rt_totals.push(round2(act.time / 3600.0));
                if act.chars > 0 {
                    rs_labels.push(title);
                    rs_totals.push((act.chars as f64 / (act.time / 3600.0)).round());
                }
            }
        }

        // Current game stats
        let current_game_stats = self.build_current_game_stats(
            conn,
            &today_lines,
            &today_breaks,
            &rollups,
            &today_str,
        )?;

        // All games summary
        let all_games_hours = c_time / 3600.0;
        let rounded_speed = c_avg_speed.round() as i64;
        let last_date_summary = match self.end_timestamp {
            Some(ts) => local_date(ts)?.format("%Y-%m-%d").to_string(),
            None => today_str.clone(),
        };
        let all_games_stats = json!({
            "total_characters": c_chars,
            "total_characters_formatted": format_large_number(c_chars as f64),
            "total_sentences": c_lines,
            "total_time_hours": all_games_hours,
            "total_time_formatted": format_time_human_readable(all_games_hours),
            "reading_speed": rounded_speed,
            "reading_speed_formatted": format_large_number(rounded_speed as f64),
            "sessions": c_sessions,
            "completed_games": completed_games_count,
            "current_streak": 0,
            "avg_daily_time_hours": 0,
            "avg_daily_time_formatted": "0h",
            "first_date": if start_date_str.is_empty() { today_str.clone() } else { start_date_str.clone() },
            "last_date": last_date_summary,
        });

        // Hourly data
        let hourly_activity: Vec<i64> = r_hourly_chars.to_vec();
        let hourly_speed: Vec<f64> = (0..24)
            .map(|h| {
                if r_hourly_speed_cnts[h] > 0 {
                    r_hourly_speed_sums[h] / r_hourly_speed_cnts[h] as f64
                } else {
                    0.0
                }
            })
            .collect();

        // Peak stats
        if !today_lines.is_empty() {
            if live_chars > max_daily_chars {
                max_daily_chars = live_chars;
            }
            let live_hrs = live_time / 3600.0;
            if live_hrs > max_daily_hours {
                max_daily_hours = live_hrs;
            }
        }
        let peak_daily_stats = json!({
            "max_daily_chars": max_daily_chars,
            "max_daily_hours": max_daily_hours,
        });
        let peak_session_stats = json!({
            "longest_session_hours": c_longest / 3600.0,
            "max_session_chars": c_max_chars,
        });

        // Day of week
        let dow_avg_hours: Vec<Value> = (0..7)
            .map(|i| {
                if dow_counts[i] > 0 {
                    json!(round2(dow_hours[i] / dow_counts[i] as f64))
                } else {
                    json!(0)
                }
            })
            .collect();
        let day_of_week_data = json!({
            "chars": dow_chars,
            "hours": dow_hours,
            "counts": dow_counts,
            "avg_hours": dow_avg_hours,
        });

        // Difficulty speed, game type distribution, genre/tag rankings, genre/type breakdowns
        let mut diff_groups: BTreeMap<i64, (i64, f64)> = BTreeMap::new();
        for g in &all_games {
            let Some(diff) = g.difficulty else {
                continue;
            };
            if let Some(act) = source_pg.get(&g.id) {
                let entry = diff_groups.entry(diff).or_insert((0, 0.0));
                entry.0 += act.chars;
                entry.1 += act.time;
            }
        }
        let mut diff_labels = Vec::new();
        let mut diff_speeds = Vec::new();
        for (diff, (dc, dt)) in diff_groups {
            if dt > 0.0 && dc > 0 {
                let spd = (dc as f64 / (dt / 3600.0)) as i64;
                if use_gdr {
                    diff_labels.push(format!("Difficulty {diff}"));
                    diff_speeds.push(spd);
                } else {
                    let bucket = diff.clamp(0, (JITEN_DIFFICULTY_LABELS.len() - 1) as i64) as usize;
                    diff_labels.push(JITEN_DIFFICULTY_LABELS[bucket].to_owned());
                    diff_speeds.push(spd);
                }
            }
        }
        let difficulty_speed_data = json!({ "labels": diff_labels, "speeds": diff_speeds });

        let mut type_counts: HashMap<&str, i64> = HashMap::new();
        for gid in source_pg.keys() {
            if let Some(g) = games_by_id.get(gid.as_str()) {
                if !g.game_type.is_empty() {
                    *type_counts.entry(g.game_type.as_str()).or_insert(0) += 1;
                }
            }
        }
        let mut type_list: Vec<(&str, i64)> = type_counts.into_iter().collect();
        type_list.sort_by_key(|item| std::cmp::Reverse(item.1));
        let game_type_data = json!({
            "labels": type_list.iter().map(|(t, _)| *t).collect::<Vec<_>>(),
            "counts": type_list.iter().map(|(_, c)| *c).collect::<Vec<_>>(),
        });

        let mut genre_rank_map: IndexMap<&str, (i64, f64)> = IndexMap::new();
        let mut tag_rank_map: IndexMap<&str, (i64, f64)> = IndexMap::new();
        for g in &all_games {
            let Some(act) = source_pg.get(&g.id) else {
                continue;
            };
            if act.chars <= 0 || act.time <= 0.0 {
                continue;
            }
            for genre in &g.genres {
                let e = genre_rank_map.entry(genre.as_str()).or_insert((0, 0.0));
                e.0 += act.chars;
                e.1 += act.time;
            }
            for tag in &g.tags {
                let e = tag_rank_map.entry(tag.as_str()).or_insert((0, 0.0));
                e.0 += act.chars;
                e.1 += act.time;
            }
        }
        let rank_top5 = |map: IndexMap<&str, (i64, f64)>| -> Value {
            let mut items: Vec<(&str, i64, i64)> = map
                .into_iter()
                .filter(|(_, (c, t))| *c > 0 && *t > 0.0)
                .map(|(name, (c, t))| (name, (c as f64 / (t / 3600.0)) as i64, c))
                .collect();
            let mut by_speed = items.clone();
            by_speed.sort_by_key(|item| std::cmp::Reverse(item.1));
            by_speed.truncate(5);
            items.sort_by_key(|item| std::cmp::Reverse(item.2));
            items.truncate(5);
            json!({
                "top_speed": {
                    "labels": by_speed.iter().map(|x| x.0).collect::<Vec<_>>(),
                    "speeds": by_speed.iter().map(|x| x.1).collect::<Vec<_>>(),
                },
                "top_chars": {
                    "labels": items.iter().map(|x| x.0).collect::<Vec<_>>(),
                    "chars": items.iter().map(|x| x.2).collect::<Vec<_>>(),
                },
            })
        };
        let genre_tag_data = json!({
            "genres": rank_top5(genre_rank_map),
            "tags": rank_top5(tag_rank_map),
        });

        let mut combined_genre = r_genre_activity;
        for (k, v) in live_genre_activity {
            let e = combined_genre.entry(k).or_default();
            e.chars += v.chars;
            e.time += v.time;
            e.cards += v.cards;
        }
        let mut combined_type = r_type_activity;
        for (k, v) in live_type_activity {
            let e = combined_type.entry(k).or_default();
            e.chars += v.chars;
            e.time += v.time;
            e.cards += v.cards;
        }
        let format_breakdown = |map: BTreeMap<String, GenreTypeAgg>| -> Value {
            let mut labels = Vec::with_capacity(map.len());
            let mut chars_data = Vec::with_capacity(map.len());
            let mut time_data = Vec::with_capacity(map.len());
            let mut speed_data = Vec::with_capacity(map.len());
            let mut cards_data = Vec::with_capacity(map.len());
            for (k, v) in map {
                labels.push(k);
                chars_data.push(v.chars);
                time_data.push(round2(v.time / 3600.0));
                cards_data.push(v.cards);
                speed_data.push(if v.time > 0.0 && v.chars > 0 {
                    (v.chars as f64 / (v.time / 3600.0)) as i64
                } else {
                    0
                });
            }
            json!({
                "labels": labels,
                "chars_data": chars_data,
                "time_data": time_data,
                "speed_data": speed_data,
                "cards_data": cards_data,
            })
        };
        let genre_stats = format_breakdown(combined_genre);
        let type_stats = format_breakdown(combined_type);

        // Time period averages
        let mut tp_hours = 0.0f64;
        let mut tp_chars = 0i64;
        let mut speed_sum = 0.0f64;
        let mut speed_cnt = 0i64;
        for &(rt, ch) in all_lines_by_date.values() {
            tp_hours += rt / 3600.0;
            tp_chars += ch;
            if rt > 0.0 && ch > 0 {
                speed_sum += ch as f64 / (rt / 3600.0);
                speed_cnt += 1;
            }
        }
        if today_in_range && !today_lines.is_empty() {
            let t_hrs = live_time / 3600.0;
            tp_hours += t_hrs;
            tp_chars += live_chars;
            if t_hrs > 0.0 && live_chars > 0 {
                speed_sum += live_chars as f64 / t_hrs;
                speed_cnt += 1;
            }
        }
        let mut avg_hours_per_day = 0.0;
        let mut avg_chars_per_day = 0.0;
        let mut avg_speed_per_day = 0.0;
        if tp_hours > 0.0 || tp_chars > 0 {
            if let (Ok(sd), Ok(ed)) = (
                NaiveDate::parse_from_str(&start_date_str, "%Y-%m-%d"),
                NaiveDate::parse_from_str(
                    if end_date_str.is_empty() {
                        &today_str
                    } else {
                        &end_date_str
                    },
                    "%Y-%m-%d",
                ),
            ) {
                let num_days = (ed - sd).num_days() + 1;
                if num_days > 0 {
                    avg_hours_per_day = tp_hours / num_days as f64;
                    avg_chars_per_day = tp_chars as f64 / num_days as f64;
                }
            }
            if speed_cnt > 0 {
                avg_speed_per_day = speed_sum / speed_cnt as f64;
            }
        }
        let time_period_averages = json!({
            "avgHoursPerDay": round2(avg_hours_per_day),
            "avgCharsPerDay": avg_chars_per_day as i64,
            "avgSpeedPerDay": avg_speed_per_day as i64,
            "totalHours": round2(tp_hours),
            "totalChars": tp_chars,
        });

        Ok(json!({
            "labels": sorted_days,
            "datasets": datasets,
            "cardsMinedLast30Days": {
                "labels": cards_labels,
                "totals": cards_totals,
            },
            "heatmapData": heatmap_data,
            "totalCharsPerGame": { "labels": tc_labels, "totals": tc_totals },
            "readingTimePerGame": { "labels": rt_labels, "totals": rt_totals },
            "readingSpeedPerGame": { "labels": rs_labels, "totals": rs_totals },
            "currentGameStats": current_game_stats,
            "allGamesStats": all_games_stats,
            "hourlyActivityData": hourly_activity,
            "hourlyReadingSpeedData": hourly_speed,
            "peakDailyStats": peak_daily_stats,
            "peakSessionStats": peak_session_stats,
            "readingSpeedHeatmapData": speed_heatmap_data,
            "maxReadingSpeed": max_reading_speed,
            "dayOfWeekData": day_of_week_data,
            "difficultySpeedData": difficulty_speed_data,
            "gameTypeData": game_type_data,
            "genreTagData": genre_tag_data,
            "genreStats": genre_stats,
            "typeStats": type_stats,
            "timePeriodAverages": time_period_averages,
            "miningHeatmapData": mining_heatmap,
            "tokenizationStatus": novelty["tokenizationStatus"],
            "vocabularyStats": novelty["vocabularyStats"],
            "newWordsSeries": novelty["newWordsSeries"],
            "newWordsByGame": novelty["newWordsByGame"],
        }))
    }

    fn build_current_game_stats(
        &self,
        conn: &Connection,
        today_lines: &[LineSample],
        today_breaks: &[f64],
        rollups: &[RollupRow],
        today_str: &str,
    ) -> Result<Value> {
        // Identify the most recent game line in range (or today)
        let latest: Option<(String, String, f64)> = if let Some(last) = today_lines.last() {
            Some((last.game_id.clone(), last.game_name.clone(), last.ts))
        } else {
            let mut conds: Vec<&str> = Vec::new();
            let mut p: Vec<rusqlite::types::Value> = Vec::new();
            if let Some(s) = self.start_timestamp {
                conds.push("CAST(timestamp AS REAL) >= ?");
                p.push(s.into());
            }
            if let Some(e) = self.end_timestamp {
                conds.push("CAST(timestamp AS REAL) <= ?");
                p.push(e.into());
            }
            let where_sql = if conds.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", conds.join(" AND "))
            };
            conn.query_row(
                &format!(
                    "SELECT game_id, game_name, CAST(timestamp AS REAL) FROM game_lines \
                     {where_sql} ORDER BY CAST(timestamp AS REAL) DESC LIMIT 1"
                ),
                rusqlite::params_from_iter(p.iter()),
                |r| {
                    Ok((
                        val_str(r.get_ref(0)?),
                        val_str(r.get_ref(1)?),
                        val_opt_f64(r.get_ref(2)?).unwrap_or(0.0),
                    ))
                },
            )
            .ok()
        };

        let Some((current_gid, current_gname, latest_ts)) = latest else {
            return Ok(json!({}));
        };
        let game_meta = if !current_gid.is_empty() {
            load_games(conn, true, Some(&current_gid))?.pop()
        } else {
            None
        };
        let display_name = if current_gname.is_empty() {
            game_meta
                .as_ref()
                .map(|g| g.display_title())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Unknown Game".to_owned())
        } else {
            current_gname
        };

        let mut total_chars = 0i64;
        let mut total_sentences = 0i64;
        let mut total_time = 0.0f64;
        let mut daily_activity: BTreeMap<String, i64> = BTreeMap::new();

        if !current_gid.is_empty() {
            // Check game_daily_rollup first
            let mut used_gdr_curr = false;
            if table_exists(conn, "game_daily_rollup") && !rollups.is_empty() {
                let first_r = rollups.first().unwrap().date.as_str();
                let last_r = rollups.last().unwrap().date.as_str();
                let mut stmt = conn.prepare(
                    "SELECT date, total_characters, total_lines, total_reading_time_seconds \
                     FROM game_daily_rollup WHERE game_id = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date ASC",
                )?;
                let mut rows = stmt.query(params![current_gid.as_str(), first_r, last_r])?;
                while let Some(row) = rows.next()? {
                    used_gdr_curr = true;
                    let date = val_str(row.get_ref(0)?);
                    let dc = val_opt_i64(row.get_ref(1)?).unwrap_or(0);
                    let dl = val_opt_i64(row.get_ref(2)?).unwrap_or(0);
                    let dt = val_opt_f64(row.get_ref(3)?).unwrap_or(0.0);
                    total_chars += dc;
                    total_sentences += dl;
                    total_time += dt;
                    if dc > 0 || dl > 0 || dt > 0.0 {
                        *daily_activity.entry(date).or_insert(0) += dc;
                    }
                }
            }
            if !used_gdr_curr {
                for r in rollups {
                    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&r.game_activity_data) {
                        if let Some(act) = map.get(&current_gid) {
                            let dc = act.get("chars").and_then(Value::as_i64).unwrap_or(0);
                            let dl = act.get("lines").and_then(Value::as_i64).unwrap_or(0);
                            let dt = act.get("time").and_then(Value::as_f64).unwrap_or(0.0);
                            total_chars += dc;
                            total_sentences += dl;
                            total_time += dt;
                            if dc > 0 || dl > 0 || dt > 0.0 {
                                *daily_activity.entry(r.date.clone()).or_insert(0) += dc;
                            }
                        }
                    }
                }
            }
            let curr_today: Vec<(f64, usize)> = today_lines
                .iter()
                .filter(|l| l.game_id == current_gid)
                .map(|l| (l.ts, l.chars))
                .collect();
            if !curr_today.is_empty() {
                let tc: i64 = curr_today.iter().map(|&(_, c)| c as i64).sum();
                total_chars += tc;
                total_sentences += curr_today.len() as i64;
                *daily_activity.entry(today_str.to_owned()).or_insert(0) += tc;
                total_time += calc_reading_time(&curr_today, self.session_gap, today_breaks);
            }
        }

        if total_chars <= 0 && total_sentences <= 0 && daily_activity.is_empty() {
            return Ok(json!({}));
        }

        let fallback_date = local_date(latest_ts)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|_| today_str.to_owned());
        let first_date = daily_activity
            .keys()
            .next()
            .cloned()
            .unwrap_or_else(|| fallback_date.clone());
        let last_date = daily_activity
            .keys()
            .next_back()
            .cloned()
            .unwrap_or(fallback_date);

        let total_hours = total_time / 3600.0;
        let reading_speed = if total_hours > 0.0 {
            (total_chars as f64 / total_hours) as i64
        } else {
            0
        };
        let monthly_start = self
            .today
            .checked_sub_days(chrono::Days::new(29))
            .unwrap_or(self.today)
            .format("%Y-%m-%d")
            .to_string();
        let monthly_chars: i64 = daily_activity
            .iter()
            .filter(|(d, _)| d.as_str() >= monthly_start.as_str())
            .map(|(_, &c)| c)
            .sum();

        let progress_pct = game_meta
            .as_ref()
            .filter(|g| g.character_count > 0)
            .map(|g| ((total_chars as f64 / g.character_count as f64) * 100.0).min(100.0))
            .unwrap_or(0.0);

        let mut obj = serde_json::Map::new();
        obj.insert("game_name".into(), json!(display_name));
        obj.insert("total_characters".into(), json!(total_chars));
        obj.insert(
            "total_characters_formatted".into(),
            json!(format_large_number(total_chars as f64)),
        );
        obj.insert("total_sentences".into(), json!(total_sentences));
        obj.insert("total_time_hours".into(), json!(total_hours));
        obj.insert(
            "total_time_formatted".into(),
            json!(format_time_human_readable(total_hours)),
        );
        obj.insert("reading_speed".into(), json!(reading_speed));
        obj.insert(
            "reading_speed_formatted".into(),
            json!(format_large_number(reading_speed as f64)),
        );
        obj.insert("sessions".into(), json!(daily_activity.len()));
        obj.insert("monthly_characters".into(), json!(monthly_chars));
        obj.insert(
            "monthly_characters_formatted".into(),
            json!(format_large_number(monthly_chars as f64)),
        );
        obj.insert("current_streak".into(), json!(0));
        obj.insert("first_date".into(), json!(first_date));
        obj.insert("last_date".into(), json!(last_date));
        obj.insert("daily_activity".into(), json!(daily_activity));
        obj.insert("progress_percentage".into(), json!(round1(progress_pct)));

        if let Some(g) = game_meta {
            obj.insert("game_id".into(), json!(g.id));
            obj.insert("title_original".into(), json!(g.title_original));
            obj.insert("title_romaji".into(), json!(g.title_romaji));
            obj.insert("title_english".into(), json!(g.title_english));
            obj.insert("type".into(), json!(g.game_type));
            obj.insert("description".into(), json!(g.description));
            obj.insert("image".into(), json!(g.image));
            obj.insert("game_character_count".into(), json!(g.character_count));
            obj.insert("links".into(), json!(g.links));
            obj.insert("completed".into(), json!(g.completed));
            obj.insert("genres".into(), json!(g.genres));
            obj.insert("tags".into(), json!(g.tags));
        } else {
            obj.insert("game_id".into(), json!(current_gid));
            obj.insert("title_original".into(), json!(""));
            obj.insert("title_romaji".into(), json!(""));
            obj.insert("title_english".into(), json!(""));
            obj.insert("type".into(), json!(""));
            obj.insert("description".into(), json!(""));
            obj.insert("image".into(), json!(""));
            obj.insert("game_character_count".into(), json!(0));
            obj.insert("links".into(), json!([]));
            obj.insert("completed".into(), json!(false));
            obj.insert("genres".into(), json!([]));
            obj.insert("tags".into(), json!([]));
        }
        Ok(Value::Object(obj))
    }
}
