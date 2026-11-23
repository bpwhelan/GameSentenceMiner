use crate::Result;
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Map, Value};
use std::path::Path;

impl crate::History {
    pub fn import_reading_at(
        &self,
        path: &Path,
        generation: u64,
        clear: Option<&str>,
        rows: &[crate::ReadingEntry],
    ) -> Result<usize> {
        self.with_writer_generation(path, Some(generation), |conn| {
            gsm_db::imports::import(conn, clear, rows)
        })
    }

    pub fn add_reading_entry(&self, path: &Path, entry: &crate::ReadingEntry) -> Result<i64> {
        self.with_writer(path, |conn| gsm_db::imports::add(conn, entry))
    }

    pub fn delete_reading_entry(&self, path: &Path, id: i64) -> Result<bool> {
        self.with_writer(path, |conn| {
            Ok(conn.execute("DELETE FROM third_party_stats WHERE id=?", [id])? > 0)
        })
    }

    pub fn delete_reading_source(&self, path: &Path, source: &str) -> Result<usize> {
        self.with_writer(path, |conn| {
            Ok(conn.execute("DELETE FROM third_party_stats WHERE source=?", [source])?)
        })
    }
}

pub(super) fn list(conn: &Connection, source: Option<&str>) -> Result<Value> {
    let columns = "SELECT id, coalesce(date,''), characters_read, time_read_seconds,
        coalesce(source,''), coalesce(label,''), created_at, coalesce(game_id,''),
        lines_read, timestamp FROM third_party_stats";
    let sql = match source {
        Some(_) => format!("{columns} WHERE source=? ORDER BY date,id"),
        None => format!("{columns} ORDER BY id"),
    };
    let mut statement = conn.prepare_cached(&sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(source))?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        let integer = |i| -> Result<Option<i64>> {
            Ok(match row.get_ref(i)? {
                ValueRef::Integer(n) => Some(n),
                ValueRef::Real(n) => Some(n as i64),
                value => value.as_str_or_null()?.map(str::parse).transpose()?,
            })
        };
        let number = |i| -> Result<Option<f64>> {
            Ok(match row.get_ref(i)? {
                ValueRef::Integer(n) => Some(n as f64),
                ValueRef::Real(n) => Some(n),
                value => value.as_str_or_null()?.map(str::parse).transpose()?,
            })
        };
        entries.push(json!({
            "id": row.get::<_, i64>(0)?, "date": row.get::<_, String>(1)?,
            "characters_read": integer(2)?, "time_read_seconds": number(3)?,
            "source": row.get::<_, String>(4)?, "label": row.get::<_, String>(5)?,
            "created_at": number(6)?, "game_id": row.get::<_, String>(7)?,
            "lines_read": integer(8)?.unwrap_or(0), "timestamp": number(9)?
        }));
    }
    let mut result = json!({"count":entries.len()});
    result["entries"] = Value::Array(entries);
    Ok(result)
}

pub(super) fn summary(conn: &Connection) -> Result<Value> {
    let mut statement = conn.prepare_cached(
        "SELECT source, count(*), coalesce(sum(characters_read),0), coalesce(sum(time_read_seconds),0)
         FROM third_party_stats GROUP BY source",
    )?;
    let mut rows = statement.query([])?;
    let (mut count, mut characters, mut seconds) = (0_i64, 0_i64, 0.0);
    let mut by_source = Map::new();
    while let Some(row) = rows.next()? {
        let source = row.get::<_, Option<String>>(0)?.filter(|s| !s.is_empty());
        let n: i64 = row.get(1)?;
        let chars: i64 = row.get(2)?;
        let time: f64 = row.get(3)?;
        count += n;
        characters = characters
            .checked_add(chars)
            .ok_or("Imported character total overflow")?;
        seconds += time;
        by_source.insert(
            source.unwrap_or_else(|| "unknown".into()),
            json!({"count":n, "characters":chars, "time_seconds":time}),
        );
    }
    Ok(json!({"total_entries":count, "total_characters":characters,
        "total_time_seconds":seconds, "by_source":by_source}))
}
