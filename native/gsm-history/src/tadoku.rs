//! Per-game pending reading totals for the Tadoku preview and sync.
use crate::{History, ReportCleaner, Result};
use caseless::Caseless;
use indexmap::IndexMap;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{hash_map::Entry, HashMap},
    path::Path,
};

pub const CURSOR: &str = "tadoku_incremental";
const GAME_PREFIX: &str = "tadoku_incremental:game:";

#[derive(Clone, Copy)]
pub enum TitleSource {
    English,
    Original,
    Romaji,
}
impl TitleSource {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "english" => Some(Self::English),
            "original" => Some(Self::Original),
            "romaji" => Some(Self::Romaji),
            _ => None,
        }
    }
}

#[derive(Serialize)]
pub struct ReadingEntry {
    pub game_key: String,
    pub game_name: String,
    pub media_tag: String,
    pub characters: usize,
    pub lines: usize,
}
#[derive(Serialize)]
pub struct Preview {
    pub cursor: f64,
    pub upper_bound: f64,
    pub deduplicate: bool,
    pub duplicates_excluded: usize,
    pub game_character_totals: HashMap<String, usize>,
    pub total_entries: usize,
    pub total_characters: usize,
    pub entries: Vec<ReadingEntry>,
}

fn media_tag(kind: &str) -> String {
    let key: String = kind
        .chars()
        .default_case_fold()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    match key.as_str() {
        "visualnovel" => "vn".into(),
        "" | "videogame" | "unknown" => "game".into(),
        _ => key,
    }
}

fn game_names(conn: &Connection, source: TitleSource) -> Result<HashMap<String, (String, String)>> {
    let mut stmt=conn.prepare("SELECT id,coalesce(title_english,''),coalesce(title_original,''),coalesce(title_romaji,''),coalesce(type,'') FROM games")?;
    let mut results = HashMap::new();
    let mut rows = stmt.query([])?;
    let preferred = match source {
        TitleSource::English => 1,
        TitleSource::Original => 2,
        TitleSource::Romaji => 3,
    };
    while let Some(row) = rows.next()? {
        let mut title = "";
        for col in [preferred, 1, 2, 3] {
            title = row.get_ref(col)?.as_str()?.trim();
            if !title.is_empty() {
                break;
            }
        }
        results.insert(
            row.get(0)?,
            (title.into(), media_tag(row.get_ref(4)?.as_str()?)),
        );
    }
    Ok(results)
}

struct Game {
    name: String,
    tag: String,
    cursor: f64,
    total: usize,
    pending: usize,
    lines: usize,
    // Only deduplicated, pending text occupies this map. Comparing timestamps
    // preserves the oldest spelling if lowercasing changes the Unicode length.
    seen: HashMap<String, (f64, usize)>,
}

impl Game {
    fn add(&mut self, text: &str, time: f64, created: f64, deduplicate: bool) -> usize {
        let chars = text.chars().count();
        self.total += chars;
        if chars == 0 || created <= self.cursor {
            return 0;
        }
        if deduplicate {
            match self.seen.entry(text.to_lowercase()) {
                Entry::Occupied(mut entry) => {
                    let (previous, length) = *entry.get();
                    if time < previous {
                        self.pending = self.pending - length + chars;
                        entry.insert((time, chars));
                    }
                    return 1;
                }
                Entry::Vacant(entry) => {
                    entry.insert((time, chars));
                }
            }
        }
        self.lines += 1;
        self.pending += chars;
        0
    }
}

fn preview(
    conn: &Connection,
    cursor: f64,
    cutoff: f64,
    source: TitleSource,
    deduplicate: bool,
    cleaner: &ReportCleaner,
) -> Result<Preview> {
    let mut names = game_names(conn, source)?;
    let mut cursor_query=conn.prepare("SELECT format_key,CAST(last_successful_export_at AS REAL)
        FROM stats_export_state WHERE format_key GLOB 'tadoku_incremental:game:*' AND last_successful_export_at IS NOT NULL")?;
    let mut cursors = cursor_query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?[GAME_PREFIX.len()..].to_owned(),
                r.get::<_, f64>(1)?,
            ))
        })?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    let mut groups = IndexMap::<String, Option<Game>>::new();
    let mut stmt = conn.prepare(
        "SELECT coalesce(game_id,''),coalesce(nullif(game_name,''),'Unknown Game'),
        coalesce(line_text,''),CAST(coalesce(timestamp,0) AS REAL),CAST(created_at AS REAL)
        FROM game_lines WHERE CAST(created_at AS REAL)<=? ORDER BY rowid",
    )?;
    let mut rows = stmt.query([cutoff])?;
    let mut duplicates = 0;
    while let Some(row) = rows.next()? {
        let id = row.get_ref(0)?.as_str()?.trim();
        let scene = row.get_ref(1)?.as_str()?;
        let key = if id.is_empty() {
            std::borrow::Cow::Owned(format!("scene:{scene}"))
        } else {
            std::borrow::Cow::Borrowed(id)
        };
        let group = match groups.get_index_of(key.as_ref()) {
            Some(index) => groups.get_index_mut(index).unwrap().1,
            None => {
                let (mut name, tag) = if !key.starts_with("scene:") {
                    names.remove(key.as_ref())
                } else {
                    None
                }
                .unwrap_or_else(|| (String::new(), "game".into()));
                if name.is_empty() {
                    name = scene.into();
                }
                let user_name = name.trim();
                let known = !user_name.is_empty()
                    && !user_name
                        .chars()
                        .default_case_fold()
                        .eq("unknown game".chars());
                let lower = cursors.remove(key.as_ref()).unwrap_or(cursor).max(cursor);
                groups.entry(key.into_owned()).or_insert_with(|| {
                    known.then(|| Game {
                        name,
                        tag,
                        cursor: lower,
                        total: 0,
                        pending: 0,
                        lines: 0,
                        seen: HashMap::new(),
                    })
                })
            }
        };
        if let Some(game) = group {
            let timestamp = row.get(3)?;
            let created = row.get(4)?;
            duplicates += cleaner.visit(row.get_ref(2)?.as_str()?, |s| {
                game.add(s, timestamp, created, deduplicate)
            })?;
        }
    }
    let mut totals = HashMap::new();
    let mut entries = Vec::new();
    for (key, game) in groups {
        let Some(game) = game else { continue };
        if game.total != 0 {
            totals.insert(key.clone(), game.total);
        }
        if game.lines != 0 {
            entries.push(ReadingEntry {
                game_key: key,
                game_name: game.name,
                media_tag: game.tag,
                characters: game.pending,
                lines: game.lines,
            });
        }
    }
    entries.sort_by_cached_key(|entry| {
        entry
            .game_key
            .chars()
            .default_case_fold()
            .collect::<String>()
    });
    Ok(Preview {
        cursor,
        upper_bound: cutoff,
        deduplicate,
        duplicates_excluded: duplicates,
        game_character_totals: totals,
        total_entries: entries.len(),
        total_characters: entries.iter().map(|e| e.characters).sum(),
        entries,
    })
}

impl History {
    pub fn finish_tadoku(
        &self,
        path: &Path,
        generation: u64,
        cutoff: f64,
        keys: &[&str],
        global: bool,
    ) -> Result<()> {
        self.with_writer_generation(path,Some(generation),|db|{
            let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            {
                let mut upsert=tx.prepare_cached("INSERT INTO stats_export_state(format_key,last_successful_export_at,created_at,updated_at)
                    VALUES(?1,?2,?2,?2) ON CONFLICT(format_key) DO UPDATE SET last_successful_export_at=?2,updated_at=?2
                    WHERE last_successful_export_at IS NULL OR CAST(last_successful_export_at AS REAL) < ?2")?;
                for key in keys {upsert.execute(rusqlite::params![format!("{GAME_PREFIX}{key}"),cutoff])?;}
                if global {upsert.execute(rusqlite::params![CURSOR,cutoff])?;}
            }
            Ok(tx.commit()?)
        })
    }

    pub fn tadoku_preview(
        &self,
        path: &Path,
        generation: u64,
        cutoff: f64,
        source: TitleSource,
        deduplicate: bool,
        cleaner: &ReportCleaner,
    ) -> Result<Preview> {
        if self.generation()? != generation {
            return Err("Database changed before Tadoku preview".into());
        }
        let read = || {
            self.with_reader(path,|db|{
            let tx=db.transaction()?;
            let cursor:Option<f64>=tx.query_row("SELECT CAST(last_successful_export_at AS REAL) FROM stats_export_state WHERE format_key=?",
                [CURSOR],|r|r.get(0)).optional()?.flatten();
            cursor.map(|c|preview(&tx,c,cutoff,source,deduplicate,cleaner)).transpose()
        })
        };
        if let Some(ready) = read()? {
            return Ok(ready);
        }
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Err("Database is read-only".into());
        }
        self.with_writer_generation(path,Some(generation),|db|{
            db.execute("INSERT INTO stats_export_state(format_key,last_successful_export_at,created_at,updated_at)
                VALUES(?1,?2,?2,?2) ON CONFLICT(format_key) DO UPDATE SET last_successful_export_at=?2,updated_at=?2
                WHERE last_successful_export_at IS NULL",rusqlite::params![CURSOR,cutoff])?;
            Ok(())
        })?;
        read()?.ok_or_else(|| "Tadoku cursor missing after initialization".into())
    }
}
