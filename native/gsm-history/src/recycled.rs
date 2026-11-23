//! The overlay's bounded per-scene history. Read only text, one borrowed SQLite row at a time.
#[path = "../../gsm-native/src/recycled_index.rs"]
mod recycled_index;
#[path = "recycled_unicode.rs"]
mod unicode;

use recycled_index::{Index, Key};
use rusqlite::{Connection, OpenFlags};
use smallvec::SmallVec;
use std::{collections::HashMap, path::Path};
use uuid::Uuid;

const LIMIT: usize = 10_000;
const MINIMUM: usize = 10;

pub fn same_scan(left:&str,right:&str)->bool {
    let normalize=|c:&char| !unicode::ignored(*c as u32);
    let mut a=left.chars().filter(normalize).peekable();
    a.peek().is_some() && a.eq(right.chars().filter(normalize))
}

fn key(text: &str) -> Option<Key> {
    if text.len() < MINIMUM {
        return None;
    }
    let mut kept = SmallVec::<[u32; 80]>::new();
    let mut largest = 0;
    for ch in text.chars() {
        let cp = u32::from(ch);
        if !unicode::ignored(cp) {
            kept.push(cp);
            largest = largest.max(cp);
        }
    }
    if kept.len() < MINIMUM {
        return None;
    }
    let width = if largest <= 0xff {
        1
    } else if largest <= 0xffff {
        2
    } else {
        4
    };
    let mut packed = Key::with_capacity(1 + width * kept.len());
    packed.push(width as u8);
    for cp in kept {
        packed.extend_from_slice(&cp.to_le_bytes()[..width]);
    }
    Some(packed)
}

pub struct Lines {
    index: Index,
    pending: Option<(Uuid, Option<Key>)>,
    // Remember the verdict at receipt, so a delayed scan cannot match its own line.
    // Expiry follows the intake journal and keeps this independent of the size of the DB.
    verdicts: HashMap<Uuid, bool>,
}

impl Default for Lines {
    fn default() -> Self {
        Self {
            index: Index::new(LIMIT),
            pending: None,
            verdicts: HashMap::new(),
        }
    }
}

impl Lines {
    pub fn load(path: &Path, scene: &str, full_scene: bool) -> crate::Result<Self> {
        // A short-lived reader also releases SQLite's page cache when the load completes.
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // This reader makes one pass. A small private page cache covers the B-tree walk.
        conn.pragma_update(None, "cache_size", -256)?;
        let mut result = Self::default();
        // Materialize/sort row IDs only. Fetch the potentially large text column AFTER sorting.
        let mut query = conn.prepare(if full_scene {
            "SELECT line_text FROM game_lines WHERE game_name=?1 ORDER BY rowid"
        } else {
            "SELECT g.line_text FROM (
                SELECT rid FROM (
                    SELECT rowid AS rid, timestamp FROM game_lines WHERE game_name=?1
                    ORDER BY timestamp DESC, rowid DESC LIMIT ?2
                ) ORDER BY timestamp, rid LIMIT -1
            ) AS ordered CROSS JOIN game_lines AS g ON g.rowid=ordered.rid"
        })?;
        query.raw_bind_parameter(1, scene)?;
        if !full_scene {
            query.raw_bind_parameter(2, LIMIT as i64)?;
        }
        let mut rows = query.raw_query();
        while let Some(row) = rows.next()? {
            let value = row.get_ref(0)?;
            if !matches!(value, rusqlite::types::ValueRef::Null) {
                if let Some(key) = key(value.as_str()?) {
                    result.index.add(key);
                }
            }
        }
        Ok(result)
    }
    pub fn len(&self) -> usize {
        self.index.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn contains(&self, text: &str) -> bool {
        !self.is_empty() && key(text).is_some_and(|k| self.index.contains(&k))
    }
    pub fn observe(&mut self, id: Uuid, text: &str, append: bool, previous: Option<&str>) {
        if append {
            // A toggle or profile reload can occur between two accepted lines.
            // In that case the intake journal still owns the predecessor.
            let prior_key = match self.pending.take() {
                Some((_, key)) => key,
                None => previous.and_then(key),
            };
            if let Some(key) = prior_key {
                self.index.add(key);
            }
        }
        let normalized = key(text);
        let seen = normalized.as_ref().is_some_and(|k| self.index.contains(k));
        self.verdicts.insert(id, seen);
        if append || self.pending.as_ref().is_some_and(|(last, _)| *last == id) {
            self.pending = Some((id, normalized));
        }
    }
    pub fn verdict(&self, id: &str, text: &str) -> bool {
        Uuid::parse_str(id)
            .ok()
            .and_then(|id| self.verdicts.get(&id))
            .copied()
            .unwrap_or_else(|| self.contains(text))
    }
    pub fn break_sequence(&mut self) {
        self.pending = None;
    }
    pub fn expire(&mut self, id: Uuid) {
        self.verdicts.remove(&id);
        if self.pending.as_ref().is_some_and(|(last, _)| *last == id) {
            self.pending = None;
        }
    }
    pub fn apply_loaded_history(&mut self, mut loaded: Self) {
        for key in std::mem::take(&mut self.index) {
            loaded.index.add(Key::from_vec(key.into_vec()));
        }
        self.index = loaded.index;
    }
    pub fn reset_session(&mut self) {
        self.pending = None;
        self.verdicts = HashMap::new();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_unicode_keys_and_revised_live_lines() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let mut lines = Lines::default();
        lines.observe(first, "draft pending edit", true, None);
        lines.observe(first, "Hello, World", false, None);
        assert!(!lines.verdict(&first.to_string(), "HelloWorld"));
        lines.observe(second, "Hello\u{1c}World\u{3002}", true, None);
        assert!(lines.verdict(&second.to_string(), "HelloWorld"));
        assert!(!lines.verdict(&first.to_string(), "HelloWorld"));
        assert!(!lines.contains("draft pending edit"));
        assert!(!lines.contains("helloworld"));
        assert!(!lines.contains("Hello+World"));
        assert_eq!(key("123456789\u{ff01}"), None);
        assert_eq!(key("123456789\u{1f431}\u{3002}"), key("123456789\u{1f431}"));
        assert_ne!(key("1234567890"), key("\u{ff11}234567890"));
        lines.expire(second);
        assert!(lines.pending.is_none());
        lines.observe(Uuid::new_v4(), "scene switch", true, None);
        lines.break_sequence();
        lines.observe(Uuid::new_v4(), "next sentence", true, None);
        assert!(!lines.contains("scene switch"));
        lines.reset_session();
        assert!(lines.pending.is_none() && lines.verdicts.is_empty());
        assert!(lines.contains("HelloWorld"));
    }

    #[test]
    fn recent_load_limits_rows_full_load_limits_distinct_keys_and_hits_do_not_renew() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("gsm.db");
        let mut writer = Connection::open(&db).unwrap();
        writer
            .execute_batch(
                "CREATE TABLE game_lines(game_name TEXT, timestamp REAL, line_text TEXT)",
            )
            .unwrap();
        let tx = writer.transaction().unwrap();
        {
            let mut insert = tx
                .prepare("INSERT INTO game_lines VALUES (?1,?2,?3)")
                .unwrap();
            for i in 0..=LIMIT {
                insert
                    .execute(rusqlite::params![
                        "Scene",
                        1,
                        format!("sentence number {i}")
                    ])
                    .unwrap();
            }
            insert
                .execute(rusqlite::params!["Scene", 2, "sentence number 1"])
                .unwrap();
            insert.execute(rusqlite::params!["Scene", 2, "a"]).unwrap();
            insert
                .execute(rusqlite::params!["Scene", 2, Option::<String>::None])
                .unwrap();
            insert
                .execute(rusqlite::params!["Other", 3, "unrelated scene text"])
                .unwrap();
            // Inserted last, but outside the newest timestamp window.
            insert
                .execute(rusqlite::params![
                    "Scene",
                    0,
                    "old timestamp late insertion"
                ])
                .unwrap();
        }
        tx.commit().unwrap();
        let recent = Lines::load(&db, "Scene", false).unwrap();
        assert_eq!(recent.len(), LIMIT - 2);
        assert!(recent.contains("sentence number 1") && recent.contains("sentence number 10000"));
        assert!(
            !recent.contains("sentence number 3")
                && !recent.contains("old timestamp late insertion")
        );
        let full = Lines::load(&db, "Scene", true).unwrap();
        assert_eq!(full.len(), LIMIT);
        assert!(full.contains("old timestamp late insertion"));
        assert!(!full.contains("sentence number 1") && !full.contains("unrelated scene text"));
        assert!(Lines::load(&db, "Missing", false).unwrap().is_empty());
        let absent = dir.path().join("missing.db");
        assert!(Lines::load(&absent, "Scene", true).is_err());
        assert!(!absent.exists());
    }

    #[test]
    fn retry_merges_live_history_without_forgetting_pending_verdicts() {
        let mut live = Lines::default();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        live.observe(a, "first live sentence", true, None);
        live.observe(b, "second live sentence", true, None);
        let mut stored = Lines::default();
        stored.index.add(key("stored sentence").unwrap());
        live.apply_loaded_history(stored);
        assert!(live.contains("first live sentence") && live.contains("stored sentence"));
        assert!(!live.verdict(&a.to_string(), "first live sentence"));
        assert!(!live.contains("second live sentence"));
        live.observe(Uuid::new_v4(), "third live sentence", true, None);
        assert!(live.contains("second live sentence"));
        live.reset_session();
        live.observe(
            Uuid::new_v4(),
            "after enabling",
            true,
            Some("accepted while disabled"),
        );
        assert!(live.contains("accepted while disabled"));
    }
}
