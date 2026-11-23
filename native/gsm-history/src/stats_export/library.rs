use crate::{game_stats::GAME_STATUS_VALUES, Result};
use indexmap::IndexMap;
use rusqlite::{Connection, Row};
use serde::Serialize;
use serde_json::{ser::Formatter, Value};
use std::{
    collections::HashSet,
    io::{self, Write},
};

pub(crate) fn category(kind: &str) -> (&'static str, &'static str) {
    let kind = kind.trim().to_lowercase();
    let has = |terms: &[&str]| terms.iter().any(|term| kind.contains(term));
    if kind == "vn" || has(&["visual novel"]) {
        ("Playing", "Visual Novel")
    } else if has(&["anime"]) {
        ("Watching", "Anime")
    } else if has(&["manga"]) {
        ("Reading", "Manga")
    } else if has(&["web novel"]) {
        ("Reading", "WebNovel")
    } else if has(&["light novel"]) || kind == "novel" {
        ("Reading", "Novel")
    } else if has(&["nonfiction", "non-fiction"]) {
        ("Reading", "NonFiction")
    } else if has(&["movie", "film"]) {
        ("Watching", "Movie")
    } else if has(&["drama"]) {
        ("Watching", "Drama")
    } else if has(&["stream"]) {
        ("Watching", "Livestream")
    } else if has(&["youtube"]) {
        ("Watching", "Youtube Video")
    } else if has(&["audio", "music", "podcast"]) {
        ("Listening", "Audio")
    } else if has(&["book", "novel", "reading"]) {
        ("Reading", "Novel")
    } else if has(&["game", "rpg"]) {
        ("Playing", "Videogame")
    } else {
        ("None", "Unknown")
    }
}

// The CSV's Extra Data field is JSON with the legacy json.dumps spacing.
struct SpacedJson;
impl Formatter for SpacedJson {
    fn begin_array_value<W: ?Sized + Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        if !first {
            w.write_all(b", ")?;
        }
        Ok(())
    }
    fn begin_object_key<W: ?Sized + Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.begin_array_value(w, first)
    }
    fn begin_object_value<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        w.write_all(b": ")
    }
}

fn text<'a>(row: &'a Row<'_>, col: usize) -> rusqlite::Result<&'a str> {
    Ok(row.get_ref(col)?.as_str_or_null()?.unwrap_or(""))
}

fn array(s: &str) -> Vec<Value> {
    serde_json::from_str(s).unwrap_or_default()
}

pub(crate) const EXTRA_COLUMNS: &str =
    "CAST(vndb_id AS TEXT),CAST(anilist_id AS TEXT),CAST(deck_id AS TEXT),
    obs_scene_name,release_date,title_romaji,title_english,genres,tags,links";

pub(crate) fn extra_fields(
    row: &Row<'_>,
    first: usize,
    title: &str,
) -> Result<IndexMap<&'static str, Value>> {
    let mut fields = IndexMap::<_, Value>::new();
    for (col, key) in [(0, "vNDB_ID"), (1, "aniList_ID")] {
        let value = text(row, first + col)?;
        if !value.is_empty() {
            fields.insert(key, value.into());
        }
    }
    if let Ok(id) = text(row, first + 2)?.trim().parse::<i64>() {
        fields.insert("deck_id", id.into());
    }
    for (col, key) in [
        (3, "obs_scene_name"),
        (4, "release_date"),
        (5, "title_romaji"),
        (6, "title_english"),
    ] {
        let value = text(row, first + col)?;
        if !value.is_empty() && (col < 5 || value != title) {
            fields.insert(key, value.into());
        }
    }
    for (col, key) in [(7, "genres"), (8, "tags")] {
        let values = array(text(row, first + col)?);
        if !values.is_empty() {
            fields.insert(key, values.into());
        }
    }
    let mut seen = HashSet::new();
    let links = array(text(row, first + 9)?)
        .into_iter()
        .filter_map(|entry| {
            let url = entry
                .as_str()
                .or_else(|| entry.get("url")?.as_str())?
                .trim();
            (!url.is_empty() && seen.insert(url.to_lowercase())).then(|| Value::from(url))
        })
        .collect::<Vec<_>>();
    if !links.is_empty() {
        fields.insert("links", links.into());
    }
    Ok(fields)
}

pub fn spaced_json(fields: &impl Serialize) -> Result<String> {
    let mut out = Vec::new();
    fields.serialize(&mut serde_json::Serializer::with_formatter(
        &mut out, SpacedJson,
    ))?;
    Ok(String::from_utf8(out)?)
}

pub(super) fn write(
    conn: &Connection,
    csv: &mut csv::Writer<impl Write>,
    language: &str,
    progress: &mut impl FnMut(u8, &str),
) -> Result<usize> {
    csv.write_record([
        "Title",
        "Media Type",
        "Status",
        "Language",
        "Description",
        "Content Type",
        "Extra Data",
        "Cover Image (Base64)",
    ])?;
    // Sort lightweight keys. Only the current cover or description is read
    // into memory, and each indexed activity lookup can stop at its first row.
    let mut keys = conn.prepare("SELECT rowid,coalesce(nullif(title_original,''),nullif(title_english,''),
        nullif(title_romaji,''),nullif(obs_scene_name,''),nullif(id,''),'Untitled') FROM games ORDER BY rowid")?;
    let mut titles = keys
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    titles.sort_by_cached_key(|(_, title)| title.to_lowercase());
    let mut detail = conn.prepare(&format!("SELECT type,description,image,status,CAST(completed AS INTEGER),{EXTRA_COLUMNS},
        EXISTS(SELECT 1 FROM game_lines WHERE game_id=games.id AND trim(game_id)!='' AND timestamp IS NOT NULL)
        FROM games WHERE rowid=?"))?;
    let total = titles.len();
    for (i, (id, title)) in titles.into_iter().enumerate() {
        let mut rows = detail.query([id])?;
        let row = rows.next()?.ok_or("Game missing from export snapshot")?;
        let (media, content) = category(text(row, 0)?);
        let lifecycle = text(row, 3)?;
        let complete = if GAME_STATUS_VALUES.contains(&lifecycle) {
            lifecycle == "completed"
        } else {
            row.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0
        };
        let status = if complete {
            "Complete"
        } else if row.get::<_, bool>(15)? {
            "Ongoing"
        } else {
            "Not Started"
        };
        let cover = text(row, 2)?.trim();
        let cover = cover
            .strip_prefix("data:")
            .and_then(|s| s.split_once(','))
            .map_or(cover, |(_, s)| s.trim());
        csv.write_record([
            &title,
            media,
            status,
            language,
            text(row, 1)?,
            content,
            &spaced_json(&extra_fields(row, 5, &title)?)?,
            cover,
        ])?;
        if (i + 1) % 50 == 0 || i + 1 == total {
            progress(
                (15 + 80 * (i + 1) / total) as u8,
                &format!("Wrote {}/{total} library rows.", i + 1),
            );
        }
    }
    Ok(total)
}
