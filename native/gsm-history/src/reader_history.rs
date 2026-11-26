//! Cursor-paged per-game dialogue history for the Home reading feed.
use crate::{stats::table_exists, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params_from_iter, types::ValueRef, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

pub const DEFAULT_READER_HISTORY_LIMIT: usize = 40;
pub const MAX_READER_HISTORY_LIMIT: usize = 100;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderHistoryQuery {
    pub scene: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub before_timestamp: Option<f64>,
    #[serde(default)]
    pub before_rowid: Option<i64>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub all_matches: bool,
}

fn default_limit() -> usize {
    DEFAULT_READER_HISTORY_LIMIT
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderHistoryCursor {
    pub before_timestamp: f64,
    pub before_rowid: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderHistoryLine {
    pub id: String,
    pub text: String,
    pub scene: String,
    pub captured_at: String,
    pub timestamp: f64,
    pub rowid: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderHistoryPage {
    pub lines: Vec<ReaderHistoryLine>,
    pub has_more: bool,
    pub next_cursor: Option<ReaderHistoryCursor>,
}

fn empty_page() -> ReaderHistoryPage {
    ReaderHistoryPage {
        lines: Vec::new(),
        has_more: false,
        next_cursor: None,
    }
}

fn value_to_string(val: ValueRef<'_>) -> String {
    match val {
        ValueRef::Null => String::new(),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Blob(bytes) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

fn value_to_f64(val: ValueRef<'_>) -> f64 {
    match val {
        ValueRef::Null => 0.0,
        ValueRef::Real(f) if f.is_finite() => f,
        ValueRef::Integer(i) => i as f64,
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .ok()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|f| f.is_finite())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

fn format_timestamp(ts: f64) -> String {
    if !ts.is_finite() || ts <= 0.0 {
        return String::new();
    }
    let micros = (ts * 1_000_000.0).round() as i64;
    DateTime::<Utc>::from_timestamp_micros(micros)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn escape_like(needle: &str) -> String {
    let mut out = String::with_capacity(needle.len() + 2);
    out.push('%');
    for ch in needle.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('%');
    out
}

impl ReaderHistoryQuery {
    pub fn run(&self, tx: &Transaction<'_>) -> Result<ReaderHistoryPage> {
        self.run_before_line(tx, None)
    }

    pub(crate) fn run_before_line(
        &self,
        tx: &Transaction<'_>,
        before_line_id: Option<&str>,
    ) -> Result<ReaderHistoryPage> {
        let scene = self.scene.trim();
        if scene.is_empty() || !table_exists(tx, "game_lines")? {
            return Ok(empty_page());
        }
        let limit = self.limit.clamp(1, MAX_READER_HISTORY_LIMIT);

        let resolved_game_id: Option<String> = if table_exists(tx, "games")? {
            tx.query_row(
                "SELECT id FROM games WHERE obs_scene_name = ?1 OR title_original = ?1 \
                 ORDER BY CASE WHEN obs_scene_name = ?1 THEN 0 ELSE 1 END, rowid LIMIT 1",
                [scene],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .filter(|id| !id.is_empty())
        } else {
            None
        };

        let mut where_sql = String::from("WHERE line_text IS NOT NULL AND line_text != ''");
        let mut params: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(game_id) = resolved_game_id {
            where_sql.push_str(
                " AND (game_id = ? OR (game_name = ? AND (game_id IS NULL OR game_id = '')))",
            );
            params.push(game_id.into());
            params.push(scene.to_owned().into());
        } else {
            where_sql.push_str(" AND game_name = ?");
            params.push(scene.to_owned().into());
        }

        let needle = self.query.as_deref().map(str::trim).filter(|q| !q.is_empty());
        let all_matches = self.all_matches && needle.is_some();
        if let Some(needle) = needle {
            where_sql.push_str(" AND line_text LIKE ? ESCAPE '\\'");
            params.push(escape_like(needle).into());
        }

        let anchor = if let Some(id) = before_line_id {
            let id = rusqlite::types::Value::Text(id.to_owned());
            let sql = format!(
                "SELECT COALESCE(CAST(timestamp AS REAL), 0.0), rowid FROM game_lines {where_sql} AND id = ?"
            );
            tx.query_row(
                &sql,
                params_from_iter(params.iter().chain(std::iter::once(&id))),
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
        } else {
            None
        };
        let (before_ts, before_rowid) = anchor
            .map(|(ts, id)| (Some(ts), Some(id)))
            .unwrap_or((self.before_timestamp.filter(|v| v.is_finite()), self.before_rowid));
        if let (Some(before_ts), Some(before_rowid)) = (before_ts, before_rowid) {
            where_sql.push_str(
                " AND (COALESCE(CAST(timestamp AS REAL), 0.0) < ? \
                 OR (COALESCE(CAST(timestamp AS REAL), 0.0) = ? AND rowid < ?))",
            );
            params.push(before_ts.into());
            params.push(before_ts.into());
            params.push(before_rowid.into());
        } else if let Some(before_ts) = before_ts {
            where_sql.push_str(" AND COALESCE(CAST(timestamp AS REAL), 0.0) < ?");
            params.push(before_ts.into());
        }

        let sql = format!(
            "SELECT rowid, id, line_text, COALESCE(CAST(timestamp AS REAL), 0.0), translation \
             FROM game_lines {where_sql} \
             ORDER BY COALESCE(CAST(timestamp AS REAL), 0.0) DESC, rowid DESC \
             LIMIT ?"
        );
        // SQLite accepts -1 for an unlimited result. Blank searches stay paged.
        params.push((if all_matches { -1 } else { (limit + 1) as i64 }).into());

        let mut stmt = tx.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(params.iter()))?;
        let mut collected = Vec::with_capacity(limit + 1);
        while let Some(row) = rows.next()? {
            let rowid: i64 = row.get(0)?;
            let id = value_to_string(row.get_ref(1)?);
            let text = value_to_string(row.get_ref(2)?);
            if id.is_empty() || text.is_empty() {
                continue;
            }
            let timestamp = value_to_f64(row.get_ref(3)?);
            let translation_raw = value_to_string(row.get_ref(4)?);
            let translation = if translation_raw.is_empty() {
                None
            } else {
                Some(translation_raw)
            };
            collected.push(ReaderHistoryLine {
                id,
                text,
                scene: scene.to_owned(),
                captured_at: format_timestamp(timestamp),
                timestamp,
                rowid,
                translation,
            });
        }

        let has_more = !all_matches && collected.len() > limit;
        if has_more {
            collected.truncate(limit);
        }

        let next_cursor = collected.last().map(|oldest| ReaderHistoryCursor {
            before_timestamp: oldest.timestamp,
            before_rowid: oldest.rowid,
        });

        // Reverse from newest-first SQL order to chronological display order (oldest -> newest).
        collected.reverse();

        Ok(ReaderHistoryPage {
            lines: collected,
            has_more,
            next_cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE games (
                id TEXT PRIMARY KEY,
                title_original TEXT,
                obs_scene_name TEXT
             );
             CREATE TABLE game_lines (
                id TEXT PRIMARY KEY,
                game_name TEXT,
                line_text TEXT,
                timestamp REAL,
                game_id TEXT,
                translation TEXT
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn filters_by_linked_game_and_pages_chronologically_without_gaps_or_dupes() {
        let mut conn = setup_db();
        conn.execute(
            "INSERT INTO games (id, title_original, obs_scene_name) VALUES ('g1', 'Steins;Gate', 'SG Scene')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO games (id, title_original, obs_scene_name) VALUES ('g2', 'Other Game', 'Other Scene')",
            [],
        )
        .unwrap();

        // Insert 5 lines for g1 (including two sharing the exact same timestamp and one unlinked by game_name)
        // plus lines for g2 that must never appear.
        let rows = [
            ("l1", "SG Scene", "Line 1", 100.0, "g1", ""),
            ("other1", "Other Scene", "Other 1", 105.0, "g2", ""),
            ("l2", "Old Name", "Line 2", 200.0, "g1", "Trans 2"),
            ("l3", "SG Scene", "Line 3", 200.0, "g1", ""),
            ("l4", "SG Scene", "Line 4", 300.0, "", ""),
            ("l5", "SG Scene", "Line 5", 400.0, "g1", ""),
            ("other2", "Other Scene", "Other 2", 450.0, "g2", ""),
        ];
        for (id, gname, text, ts, gid, tl) in rows {
            conn.execute(
                "INSERT INTO game_lines (id, game_name, line_text, timestamp, game_id, translation) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, gname, text, ts, gid, tl],
            )
            .unwrap();
        }

        let tx = conn.transaction().unwrap();
        let page1 = ReaderHistoryQuery {
            scene: "SG Scene".into(),
            limit: 2,
            before_timestamp: None,
            before_rowid: None,
            all_matches: false,
            query: None,
        }
        .run(&tx)
        .unwrap();
        assert_eq!(
            page1.lines.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["l4", "l5"]
        );
        assert!(page1.has_more);
        let c1 = page1.next_cursor.unwrap();

        let page2 = ReaderHistoryQuery {
            scene: "SG Scene".into(),
            limit: 2,
            before_timestamp: Some(c1.before_timestamp),
            before_rowid: Some(c1.before_rowid),
            all_matches: false,
            query: None,
        }
        .run(&tx)
        .unwrap();
        assert_eq!(
            page2.lines.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["l2", "l3"]
        );
        assert_eq!(page2.lines[0].translation.as_deref(), Some("Trans 2"));
        assert!(page2.has_more);
        let c2 = page2.next_cursor.unwrap();

        let page3 = ReaderHistoryQuery {
            scene: "SG Scene".into(),
            limit: 2,
            before_timestamp: Some(c2.before_timestamp),
            before_rowid: Some(c2.before_rowid),
            all_matches: false,
            query: None,
        }
        .run(&tx)
        .unwrap();
        assert_eq!(
            page3.lines.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["l1"]
        );
        assert!(!page3.has_more);
    }

    #[test]
    fn searches_the_whole_game_but_keeps_an_empty_search_paged() {
        let mut conn = setup_db();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<125)
             INSERT INTO game_lines(id, game_name, line_text, timestamp)
             SELECT 'id'||i, 'Game', '100% 猫', i FROM n;
             INSERT INTO game_lines(id, game_name, line_text, timestamp) VALUES
             ('different', 'Game', '1000 猫', 126), ('other', 'Other', '100% 猫', 127);",
        ).unwrap();
        let tx = conn.transaction().unwrap();
        let mut query: ReaderHistoryQuery = serde_json::from_value(serde_json::json!({
            "scene":"Game", "query":"100%", "allMatches":true, "limit":2
        })).unwrap();
        let matches = query.run(&tx).unwrap();
        assert_eq!(matches.lines.len(), 125);
        assert_eq!(matches.lines[0].id, "id1");
        assert_eq!(matches.lines[124].id, "id125");
        assert!(!matches.has_more);
        query.query = Some(" ".into());
        let latest = query.run(&tx).unwrap();
        assert_eq!(latest.lines.len(), 2);
        assert!(latest.has_more);
    }

    #[test]
    fn supports_search_query_and_empty_scene() {
        let mut conn = setup_db();
        conn.execute(
            "INSERT INTO game_lines (id, game_name, line_text, timestamp, game_id, translation) \
             VALUES ('a', 'GameA', '猫が好き', 100.0, '', ''), \
                    ('b', 'GameA', '犬が好き', 200.0, '', ''), \
                    ('c', 'GameB', '猫がいる', 300.0, '', '')",
            [],
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        let empty = ReaderHistoryQuery {
            scene: "   ".into(),
            limit: 40,
            before_timestamp: None,
            before_rowid: None,
            all_matches: false,
            query: None,
        }
        .run(&tx)
        .unwrap();
        assert!(empty.lines.is_empty());
        assert!(!empty.has_more);

        let matched = ReaderHistoryQuery {
            scene: "GameA".into(),
            limit: 40,
            before_timestamp: None,
            before_rowid: None,
            all_matches: false,
            query: Some("猫".into()),
        }
        .run(&tx)
        .unwrap();
        assert_eq!(
            matched.lines.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["a"]
        );
    }

    #[test]
    fn anchors_saved_pages_on_the_oldest_live_line_in_the_same_game() {
        let mut conn = setup_db();
        conn.execute_batch(
            "INSERT INTO game_lines (id, game_name, line_text, timestamp) VALUES
             ('old', 'Game A', 'Old', 10), ('before', 'Game A', 'Before', 20),
             ('anchor', 'Game A', 'Anchor', 20), ('later', 'Game A', 'Later', 20),
             ('other', 'Game B', 'Other', 10);",
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        let query = ReaderHistoryQuery {
            scene: "Game A".into(),
            limit: 40,
            before_timestamp: None,
            before_rowid: None,
            all_matches: false,
            query: None,
        };
        let page = query.run_before_line(&tx, Some("anchor")).unwrap();
        assert_eq!(
            page.lines.iter().map(|line| line.id.as_str()).collect::<Vec<_>>(),
            ["old", "before"],
        );
        let page = query.run_before_line(&tx, Some("other")).unwrap();
        assert_eq!(page.lines.len(), 4);
    }
}
