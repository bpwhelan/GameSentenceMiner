use crate::Result;
use rusqlite::{Connection, Statement};
use serde_json::{json, Value};

// Selecting the endpoints before fetching cover images and first-played times
// bounds image memory to two games and avoids one history query per game.
pub(super) fn read(conn: &Connection) -> Result<Value> {
    let mut dates = conn.prepare(
        "SELECT rowid, release_date FROM games WHERE release_date IS NOT NULL ORDER BY rowid",
    )?;
    let mut rows = dates.query([])?;
    let mut oldest = None::<(i64, String)>;
    let mut newest = None::<(i64, String)>;
    while let Some(row) = rows.next()? {
        let release = row.get_ref(1)?.as_str()?;
        if release.trim().is_empty() {
            continue;
        }
        let date = release.split('T').next().unwrap_or(release);
        if oldest.as_ref().is_none_or(|(_, d)| date < d.as_str()) {
            oldest = Some((row.get(0)?, date.to_owned()));
        }
        if newest.as_ref().is_none_or(|(_, d)| date >= d.as_str()) {
            newest = Some((row.get(0)?, date.to_owned()));
        }
    }
    let (Some((first_id, first_date)), Some((last_id, last_date))) = (oldest, newest) else {
        return Ok(json!({}));
    };
    let mut details = conn.prepare(
        "SELECT coalesce(title_original,''), coalesce(title_romaji,''), coalesce(title_english,''),
        coalesce(type,''), coalesce(image,''), release_date, CAST(difficulty AS INTEGER),
        (SELECT CAST(MIN(timestamp) AS REAL) FROM game_lines WHERE game_id=games.id)
        FROM games WHERE rowid=?",
    )?;
    let first = entry(&mut details, first_id, &first_date)?;
    let last = if first_id == last_id {
        first.clone()
    } else {
        entry(&mut details, last_id, &last_date)?
    };
    Ok(json!({"oldest_game":first,"newest_game":last}))
}

fn entry(stmt: &mut Statement<'_>, id: i64, date: &str) -> Result<Value> {
    const LABELS: [&str; 6] = ["Beginner", "Easy", "Average", "Hard", "Expert", "Insane"];
    let mut rows = stmt.query([id])?;
    let row = rows
        .next()?
        .ok_or("Game disappeared from the read transaction")?;
    let first_played = row
        .get::<_, Option<f64>>(7)?
        .filter(|t| *t != 0.0)
        .map(crate::stats::local_date)
        .transpose()?
        .map_or_else(|| "Unknown".into(), |d| d.to_string());
    let difficulty: Option<i64> = row.get(6)?;
    Ok(json!({
        "title_original":row.get_ref(0)?.as_str()?, "title_romaji":row.get_ref(1)?.as_str()?,
        "title_english":row.get_ref(2)?.as_str()?, "type":row.get_ref(3)?.as_str()?,
        "image":row.get_ref(4)?.as_str()?, "release_date":date, "release_date_full":row.get_ref(5)?.as_str()?,
        "first_played":first_played, "difficulty":difficulty, "difficulty_label":difficulty.map(|n| LABELS[n.clamp(0,5) as usize])
    }))
}
