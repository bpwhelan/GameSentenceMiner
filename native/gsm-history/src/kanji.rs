use crate::{stats::table_exists, Result};
use chrono::NaiveDate;
use indexmap::IndexMap;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::cmp::Reverse;

pub(super) fn frequency(conn: &Connection, kanji: char, today: NaiveDate) -> Result<Value> {
    // Skip malformed legacy rollups and match the exact character, including
    // supplementary ideographs and characters with special JSON-path syntax.
    let key = format!("$.{}", serde_json::to_string(&kanji)?);
    let count: i64 = conn.query_row(
        "SELECT coalesce(sum(CASE WHEN json_valid(kanji_frequency_data)
        THEN json_extract(kanji_frequency_data,?1) END),0) FROM daily_stats_rollup WHERE date<=?2",
        params![key, today.to_string()],
        |row| row.get(0),
    )?;
    Ok(json!({"kanji":kanji, "count":count}))
}

pub(super) fn game(conn: &Connection, game_id: &str) -> Result<Value> {
    if !conn
        .prepare("SELECT 1 FROM games WHERE id=?")?
        .exists([game_id])?
    {
        return Ok(json!({"error":"Game not found"}));
    }
    let mut counts = IndexMap::<String, u64>::new();
    if table_exists(conn, "archived_game_days")? {
        let mut archive = conn.prepare(
            "SELECT j.key, j.value FROM archived_game_days d, json_each(d.raw_kanji) j
            WHERE d.game_id=? ORDER BY d.date, j.id",
        )?;
        let mut rows = archive.query([game_id])?;
        while let Some(row) = rows.next()? {
            *counts.entry(row.get(0)?).or_default() += row.get::<_, u64>(1)?;
        }
    }
    let mut live = IndexMap::<char, u64>::new();
    let mut stmt = conn.prepare("SELECT line_text FROM game_lines WHERE game_id=?")?;
    let mut rows = stmt.query([game_id])?;
    while let Some(row) = rows.next()? {
        if let Some(text) = row.get_ref(0)?.as_str_or_null()? {
            for ch in text.chars().filter(is_kanji) {
                *live.entry(ch).or_default() += 1;
            }
        }
    }
    // Within equal final frequencies the API keeps archive insertion order,
    // followed by the stable frequency order of the live grid.
    live.sort_by_cached_key(|_, n| Reverse(*n));
    for (ch, n) in live {
        *counts.entry(ch.to_string()).or_default() += n;
    }
    Ok(grid(counts))
}

pub fn is_kanji(ch: &char) -> bool {
    matches!(*ch as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0x20000..=0x2a6df)
}

pub(super) fn increment(counts: &mut IndexMap<String, u64>, key: &str, n: u64) {
    if let Some(existing) = counts.get_mut(key) {
        *existing += n;
    } else {
        counts.insert(key.to_owned(), n);
    }
}

pub(super) fn dashboard(
    conn: &Connection,
    today: NaiveDate,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    day_start: f64,
    day_end: f64,
    cleaner: &crate::sessions::ReportCleaner,
) -> Result<Value> {
    Ok(grid(dashboard_counts(conn, today, start, end, day_start, day_end, cleaner)?))
}

pub(super) fn dashboard_counts(
    conn: &Connection,
    today: NaiveDate,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    day_start: f64,
    day_end: f64,
    cleaner: &crate::sessions::ReportCleaner,
) -> Result<IndexMap<String, u64>> {
    let mut counts = IndexMap::new();
    // Order days once. Expanding every JSON object into SQL rows makes
    // SQLite sort the entire year's character counts into a temporary table.
    let mut historical = conn.prepare(
        "SELECT kanji_frequency_data FROM daily_stats_rollup
        WHERE date BETWEEN ?1 AND ?2 AND date < ?3 ORDER BY date",
    )?;
    let mut rows = historical.query(params![
        start.map(|d| d.to_string()).unwrap_or_default(),
        end.unwrap_or(today).to_string(),
        today.to_string()
    ])?;
    while let Some(row) = rows.next()? {
        let Some(raw) = row.get_ref(0)?.as_str_or_null()? else {
            continue;
        };
        if let Ok(day) = serde_json::from_str::<IndexMap<String, u64>>(raw) {
            for (ch, n) in day {
                *counts.entry(ch).or_default() += n;
            }
        }
    }
    if end.is_none_or(|day| day >= today) {
        let mut live = IndexMap::new();
        let mut sql=String::from("SELECT CAST(timestamp AS REAL) t,0 archived,'' game,0 ordinal,line_text text,0 frequency
            FROM game_lines WHERE timestamp BETWEEN ?1 AND ?2");
        let has_archives = table_exists(conn, "archived_game_days")?;
        if has_archives {
            sql.push_str(
                " UNION ALL SELECT CAST(d.first_timestamp AS REAL),1,d.game_id,j.id,j.key,j.value
                FROM archived_game_days d,json_each(d.kanji) j WHERE d.date=?3",
            );
        }
        sql.push_str(" ORDER BY t,archived,game,ordinal");
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = if has_archives {
            stmt.query(params![day_start, day_end, today.to_string()])?
        } else {
            stmt.query(params![day_start, day_end])?
        };
        let mut buffer = [0u8; 4];
        while let Some(row) = rows.next()? {
            let Some(text) = row.get_ref(4)?.as_str_or_null()? else {
                continue;
            };
            if row.get::<_, bool>(1)? {
                increment(&mut live, text, row.get(5)?);
            } else {
                let mut add_kanji = |text: &str| {
                    for ch in text.chars().filter(is_kanji) {
                        increment(&mut live, ch.encode_utf8(&mut buffer), 1);
                    }
                };
                if cleaner.changes_kanji() {
                    cleaner.visit(text, add_kanji)?;
                } else {
                    add_kanji(text);
                }
            }
        }
        live.sort_by_cached_key(|_, n| Reverse(*n));
        for (ch, n) in live {
            increment(&mut counts, &ch, n);
        }
    }
    Ok(counts)
}

fn grid(mut counts: IndexMap<String, u64>) -> Value {
    counts.sort_by_cached_key(|_, n| Reverse(*n));
    let max = counts.first().map_or(0, |(_, v)| *v);
    let data: Vec<_> = counts
        .into_iter()
        .map(|(kanji, n)| json!({"kanji":kanji,"frequency":n,"color":color(n,max)}))
        .collect();
    json!({"unique_count":data.len(),"max_frequency":max,"kanji_data":data})
}

fn color(count: u64, max: u64) -> String {
    const STOPS: [[i16; 3]; 4] = [[230, 52, 46], [230, 220, 46], [59, 230, 47], [46, 230, 224]];
    if count == 0 {
        return "#ebedf0".into();
    }
    if count > 300 || count == max {
        return "#2ee6e0".into();
    }
    let ratio = (count as f64 / max as f64).sqrt() * 3.0;
    let segment = (ratio as usize).min(2);
    let from = STOPS[segment];
    let to = STOPS[segment + 1];
    let rgb = std::array::from_fn(|i| {
        (f64::from(from[i]) + ratio.fract() * f64::from(to[i] - from[i])) as u8
    });
    let [r, g, b] = rgb;
    format!("#{r:02x}{g:02x}{b:02x}")
}
