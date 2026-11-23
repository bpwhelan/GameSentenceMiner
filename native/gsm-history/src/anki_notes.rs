use crate::{kanji::is_kanji, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::BTreeSet;

// GSM stores IDs as decimal text. Search numeric bounds and compare tag
// prefixes literally (including %, _, and non-ASCII characters).
const TAGGED: &str = "EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(n.tags) THEN n.tags ELSE '[]' END) t
    WHERE t.type='text' AND instr(t.value, ?1)=1)";

pub(super) fn earliest(conn: &Connection, parent: &str) -> Result<Value> {
    if !super::stats::table_exists(conn, "anki_notes")? {
        return Ok(json!({"earliest_date": 0}));
    }
    let sql = format!("SELECT min(CAST(n.note_id AS INTEGER)) FROM anki_notes n WHERE {TAGGED}");
    let id: Option<i64> = conn.query_row(&sql, [format!("{parent}::")], |row| row.get(0))?;
    Ok(json!({"earliest_date":id.unwrap_or_default() as f64 / 1000.0}))
}

pub(super) fn characters(
    conn: &Connection,
    parent: &str,
    field: &str,
    start: Option<i64>,
    end: Option<i64>,
) -> Result<Value> {
    Ok(Value::String(character_set(conn, parent, field, start, end)?.into_iter().collect()))
}

pub(super) fn character_set(
    conn: &Connection,
    parent: &str,
    field: &str,
    start: Option<i64>,
    end: Option<i64>,
) -> Result<BTreeSet<char>> {
    let mut characters = BTreeSet::new();
    if !field.is_empty() {
        let sql = format!(
            "SELECT n.fields_json FROM anki_notes n
            WHERE CAST(n.note_id AS INTEGER) BETWEEN ?2 AND ?3 AND {TAGGED}"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![
            format!("{parent}::"),
            start.unwrap_or(i64::MIN),
            end.unwrap_or(i64::MAX)
        ])?;
        while let Some(row) = rows.next()? {
            let Some(text) = row.get_ref(0)?.as_str_or_null()? else {
                continue;
            };
            let Ok(fields) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            if let Some(word) = fields
                .get(field)
                .and_then(|f| f.get("value"))
                .and_then(Value::as_str)
            {
                characters.extend(word.chars().filter(is_kanji));
            }
        }
    }
    Ok(characters)
}
