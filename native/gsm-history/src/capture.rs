//! Resolve scenes and record a capture or an import in a single transaction.
use crate::{stats::table_exists, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Mode {
    Capture,
    Import,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Line {
    pub id: String,
    pub text: String,
    pub scene: Option<String>,
    pub timestamp: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    mode: Mode,
    lines: Vec<Line>,
    language: String,
    dictionary: Option<String>,
}

pub(super) fn game_id(conn: &Connection, scene: &str) -> Result<String> {
    if scene.is_empty() {
        return Ok(String::new());
    }
    let mut exact = conn.prepare_cached(
        "SELECT id FROM games WHERE title_original=?1 OR obs_scene_name=?1 LIMIT 1",
    )?;
    if let Some(id) = exact.query_row([scene], |r| r.get(0)).optional()? {
        return Ok(id);
    }
    let mut historical = conn.prepare_cached("SELECT id FROM games WHERE id=(SELECT game_id FROM game_lines WHERE game_name=? AND game_id != '' LIMIT 1)")?;
    if let Some(id) = historical.query_row([scene], |r| r.get(0)).optional()? {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.prepare_cached("INSERT INTO games (id,title_original,title_romaji,title_english,type,description,image,character_count,links,completed,manual_overrides,obs_scene_name,genres,tags,character_summary,anilist_id,status)
        VALUES (?1,?2,'','','','','',0,'[]',0,'[]',?2,'[]','[]','','','')")?.execute(params![id,scene])?;
    Ok(id)
}

pub(super) fn link_game_lines(conn: &mut Connection) -> Result<serde_json::Value> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result = link_game_lines_in(&tx)?;
    tx.commit()?;
    Ok(result)
}

pub(super) fn link_game_lines_in(tx: &Connection) -> Result<serde_json::Value> {
    // The legacy summary counts every scene absent from the original-title
    // column, including scenes resolved through an existing alias.
    let mut missing = tx.prepare(
        "SELECT game_name FROM game_lines WHERE game_name != ''
        EXCEPT SELECT title_original FROM games",
    )?;
    let names = missing
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(missing);
    for scene in &names {
        game_id(tx, scene)?;
    }
    // SQLite returns the id from the row containing min(ordinal). If both
    // aliases of the same row tie, both have the same id. This matches the
    // first-seen mapping without loading cover images or rescanning every
    // captured line for each game.
    let linked = tx.execute("WITH aliases(name,id,ordinal) AS (
            SELECT title_original,id,rowid FROM games WHERE title_original!=''
            UNION ALL SELECT obs_scene_name,id,rowid FROM games WHERE obs_scene_name!=''
        ), first_game AS MATERIALIZED (SELECT name,id,min(ordinal) FROM aliases GROUP BY name)
        UPDATE game_lines SET game_id=g.id FROM first_game g
        WHERE game_lines.game_name=g.name AND (game_lines.game_id IS NULL OR game_lines.game_id='')", [])?;
    Ok(serde_json::json!({"created":names.len(),"linked":linked}))
}

pub(super) const IMPORT_LINE: &str = "INSERT INTO game_lines
    (id,game_name,line_text,timestamp,game_id,language,last_modified,created_at,
     screenshot_in_anki,audio_in_anki,screenshot_path,audio_path,replay_path,translation)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?7,'','','','','','')";

impl Batch {
    pub fn captured(lines: Vec<Line>, language: String, dictionary: Option<String>) -> Self {
        Self {
            mode: Mode::Capture,
            lines,
            language,
            dictionary,
        }
    }

    pub fn word_index(&self) -> Option<(String, Vec<String>)> {
        self.dictionary.as_ref().map(|dictionary| {
            (
                dictionary.clone(),
                self.lines.iter().map(|line| line.id.clone()).collect(),
            )
        })
    }

    pub(super) fn persist(&self, conn: &mut Connection) -> Result<usize> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
        let sql = match self.mode {
            Mode::Import => IMPORT_LINE,
            Mode::Capture => "INSERT INTO game_lines
                (id,game_name,line_text,timestamp,game_id,language,last_modified,created_at,
                 screenshot_in_anki,audio_in_anki,screenshot_path,audio_path,replay_path,translation,original_game_name)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?7,'','','','','','','')
                ON CONFLICT(id) DO UPDATE SET game_name=excluded.game_name,line_text=excluded.line_text,
                    timestamp=excluded.timestamp,game_id=excluded.game_id,language=excluded.language,last_modified=excluded.last_modified
                WHERE game_lines.line_text IS NOT excluded.line_text OR game_lines.game_name IS NOT excluded.game_name
                    OR game_lines.timestamp IS NOT excluded.timestamp OR game_lines.language IS NOT excluded.language
                    OR game_lines.game_id IS NOT excluded.game_id"
        };
        let mut scenes = HashMap::new();
        let mut stmt = tx.prepare_cached(sql)?;
        let mut count = 0;
        for line in &self.lines {
            let scene = line.scene.as_deref().unwrap_or("");
            let id = match scenes.get(scene) {
                Some(id) => id,
                None => scenes
                    .entry(scene.to_owned())
                    .or_insert(game_id(&tx, scene)?),
            };
            if matches!(self.mode, Mode::Capture) {
                let previous = tx
                    .prepare_cached("SELECT 1 FROM game_lines WHERE id=? AND line_text IS NOT ?")?
                    .exists(params![line.id, line.text])?;
                if previous {
                    invalidate_tokens(&tx, &line.id)?;
                }
            }
            count += stmt.execute(params![
                line.id,
                line.scene,
                line.text,
                line.timestamp,
                id,
                self.language,
                now
            ])?;
        }
        drop(stmt);
        tx.commit()?;
        Ok(count)
    }
}

fn invalidate_tokens(conn: &Connection, id: &str) -> Result<()> {
    // A revised frozen line can keep its media and identity. Discard only
    // token records derived from the old text, in the same transaction.
    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('game_lines') WHERE name='tokenized')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        for table in ["word_occurrences", "kanji_occurrences"] {
            if table_exists(conn, table)? {
                conn.execute(&format!("DELETE FROM {table} WHERE line_id=?"), [id])?;
            }
        }
        conn.execute("UPDATE game_lines SET tokenized=0 WHERE id=?", [id])?;
    }
    Ok(())
}
