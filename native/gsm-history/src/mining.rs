use crate::Result;
use rusqlite::{named_params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum NoteId {
    Text(String),
    Integer(i64),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MinedLine {
    pub line_id: String,
    pub screenshot_in_anki: Option<String>,
    pub audio_in_anki: Option<String>,
    pub screenshot_path: Option<String>,
    pub audio_path: Option<String>,
    pub replay_path: Option<String>,
    pub translation: Option<String>,
    pub note_id: Option<NoteId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameCharacterInfo {
    pub game_id: String,
    pub character_summary: String,
    pub character_names: Vec<Vec<String>>,
    pub vndb_character_data: String,
}

#[derive(Deserialize)]
struct CharacterNames {
    name: Option<String>,
    name_original: Option<String>,
    aliases: Option<Vec<serde_json::Value>>,
}

fn read_character_names(data: &[u8]) -> Vec<Vec<String>> {
    // Read only names, even when the character records contain embedded portraits.
    #[derive(Deserialize)]
    struct Cast<T> {
        characters: T,
    }
    let entries = serde_json::from_slice::<
        Cast<std::collections::BTreeMap<String, Vec<CharacterNames>>>,
    >(data)
    .map(|cast| cast.characters.into_values().flatten().collect::<Vec<_>>())
    .or_else(|_| {
        serde_json::from_slice::<Cast<Vec<CharacterNames>>>(data).map(|cast| cast.characters)
    })
    .unwrap_or_default();
    entries
        .into_iter()
        .map(|entry| {
            // Keep both canonical-name positions so the matcher can distinguish aliases.
            [
                entry.name_original.unwrap_or_default(),
                entry.name.unwrap_or_default(),
            ]
            .into_iter()
            .chain(entry.aliases.into_iter().flatten().filter_map(|alias| {
                alias
                    .as_str()
                    .or_else(|| alias["name"].as_str())
                    .map(str::to_owned)
            }))
            .collect()
        })
        .collect()
}

impl crate::History {
    pub fn character_data_for_game(
        &self,
        path: &std::path::Path,
        game_id: &str,
    ) -> Result<Option<String>> {
        self.with_reader(path, |conn| {
            Ok(conn
                .query_row(
                    "SELECT coalesce(vndb_character_data, '') FROM games WHERE id = ?1",
                    [game_id],
                    |row| row.get(0),
                )
                .optional()?)
        })
    }
}

pub(super) fn game_character_context(
    conn: &Connection,
    game_title: &str,
    include_character_data: bool,
) -> Result<Option<GameCharacterInfo>> {
    let trimmed = game_title.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let row = conn
        .query_row(
            "SELECT id, coalesce(character_summary, ''),
                CASE WHEN ?2 OR coalesce(character_summary, '') != '' THEN vndb_character_data END
             FROM games
             WHERE obs_scene_name = ?1 OR title_original = ?1
             ORDER BY CASE WHEN obs_scene_name = ?1 THEN 0 ELSE 1 END
             LIMIT 1",
            (trimmed, include_character_data),
            |r| {
                let character_data = r.get_ref(2)?.as_str().unwrap_or_default();
                Ok(GameCharacterInfo {
                    game_id: r.get(0)?,
                    character_summary: r.get(1)?,
                    character_names: read_character_names(character_data.as_bytes()),
                    vndb_character_data: if include_character_data {
                        character_data.to_owned()
                    } else {
                        String::new()
                    },
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub(super) fn save_game_character_summary(
    conn: &Connection,
    game_id: &str,
    summary: &str,
    expected_summary: &str,
) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE games SET character_summary = ?1
         WHERE id = ?2 AND coalesce(character_summary, '') = ?3",
        [summary, game_id, expected_summary],
    )?;
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_updates_game_character_context_by_scene_or_title() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE games (
                id TEXT PRIMARY KEY,
                obs_scene_name TEXT,
                title_original TEXT,
                character_summary TEXT,
                vndb_character_data TEXT
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO games VALUES ('g1', 'VN Scene', '原題', '', '{\"characters\":[]}')",
            [],
        )
        .unwrap();

        let ctx = game_character_context(&conn, "VN Scene", true)
            .unwrap()
            .unwrap();
        assert_eq!(ctx.game_id, "g1");
        assert_eq!(ctx.character_summary, "");
        assert_eq!(ctx.vndb_character_data, "{\"characters\":[]}");

        assert!(save_game_character_summary(&conn, "g1", "Heroine: Alice", "").unwrap());
        assert!(!save_game_character_summary(&conn, "g1", "Stale generation", "").unwrap());
        let updated = game_character_context(&conn, "原題", false)
            .unwrap()
            .unwrap();
        assert_eq!(updated.character_summary, "Heroine: Alice");
        assert!(updated.vndb_character_data.is_empty());
    }
}

impl MinedLine {
    pub(super) fn update(self, conn: &mut Connection) -> Result<bool> {
        // One atomic UPDATE preserves tokenization, sync triggers, and media
        // written by a second card finishing against the same line. Legacy
        // rows can store NULL, an empty string or invalid JSON for note_ids.
        let mut update = conn.prepare_cached(
            "UPDATE game_lines SET
                screenshot_in_anki=coalesce(:shot_anki,screenshot_in_anki),
                audio_in_anki=coalesce(:audio_anki,audio_in_anki),
                screenshot_path=coalesce(:shot,screenshot_path),
                audio_path=coalesce(:audio,audio_path),
                replay_path=coalesce(:replay,replay_path),
                translation=coalesce(:translation,translation),
                note_ids=CASE
                    WHEN :note IS NULL THEN note_ids
                    WHEN NOT json_valid(coalesce(note_ids,'')) THEN json_array(:note)
                    WHEN json_type(note_ids) = 'null' THEN json_array(:note)
                    WHEN json_type(note_ids) != 'array' THEN
                        CASE WHEN json_extract(note_ids,'$') = :note THEN json_array(:note)
                             ELSE json_array(json(note_ids),:note) END
                    WHEN EXISTS (SELECT 1 FROM json_each(note_ids) WHERE value = :note) THEN note_ids
                    ELSE json_insert(note_ids,'$[#]',:note) END,
                last_modified=:now
             WHERE id=:id")?;
        let note = self.note_id.map(|id| match id {
            NoteId::Text(text) => rusqlite::types::Value::Text(text),
            NoteId::Integer(id) => rusqlite::types::Value::Integer(id),
        });
        let changed = update.execute(named_params! {
            ":shot_anki":self.screenshot_in_anki, ":audio_anki":self.audio_in_anki,
            ":shot":self.screenshot_path, ":audio":self.audio_path, ":replay":self.replay_path,
            ":translation":self.translation, ":note":note, ":id":self.line_id,
            ":now":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64(),
        })?;
        Ok(changed > 0)
    }
}
