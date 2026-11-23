use crate::{History, Result};
use rusqlite::types::ValueRef;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
pub mod names;
mod scene;
mod sudachi;

// Field order is part of the canonical JSON used by installed Yomitan dictionaries.
#[derive(Serialize)]
pub struct Game {
    pub character_data: Value,
    pub id: String,
    pub title: String,
}

impl History {
    pub fn character_games(&self, path: &Path, count: usize) -> Result<Vec<Game>> {
        self.with_reader(path, |db| {
            let tx = db.transaction()?;
            // Sort only row IDs. A character payload can include multiple full-size portraits.
            let mut recent = tx.prepare_cached(
                "SELECT g.rowid FROM games g LEFT JOIN (
                     SELECT game_id, MAX(timestamp) AS last_played FROM game_lines
                     WHERE game_id IS NOT NULL AND game_id != '' GROUP BY game_id
                 ) played ON played.game_id = g.id
                 WHERE g.vndb_character_data IS NOT NULL AND g.vndb_character_data NOT IN ('','{}')
                 ORDER BY played.last_played DESC, g.rowid LIMIT 50",
            )?;
            let mut detail = tx.prepare_cached(
                "SELECT id, COALESCE(NULLIF(title_original,''), NULLIF(title_romaji,''), title_english,''),
                 vndb_character_data FROM games WHERE rowid=?",
            )?;
            let mut games = Vec::new();
            for row in recent.query_map([], |r| r.get::<_, i64>(0))? {
                let game = detail.query_row([row?], |r| {
                    let ValueRef::Text(raw) = r.get_ref(2)? else { return Ok(None) };
                    let Ok(mut data) = serde_json::from_slice::<Value>(raw) else { return Ok(None) };
                    if !["main", "primary", "side", "appears"].iter().any(|key|
                        data["characters"][*key].as_array().is_some_and(|a| !a.is_empty())) {
                        return Ok(None);
                    }
                    data.sort_all_objects();
                    Ok(Some(Game { id: r.get(0)?, title: r.get(1)?, character_data: data }))
                })?;
                if let Some(game) = game {
                    games.push(game);
                    if games.len() == count { break; }
                }
            }
            Ok(games)
        })
    }
}
