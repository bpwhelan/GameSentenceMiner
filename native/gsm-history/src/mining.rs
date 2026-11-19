use crate::Result;
use rusqlite::{named_params, Connection};
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(untagged)]
enum NoteId {
    Text(String),
    Integer(i64),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MinedLine {
    line_id: String,
    screenshot_in_anki: Option<String>,
    audio_in_anki: Option<String>,
    screenshot_path: Option<String>,
    audio_path: Option<String>,
    replay_path: Option<String>,
    translation: Option<String>,
    note_id: Option<NoteId>,
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
