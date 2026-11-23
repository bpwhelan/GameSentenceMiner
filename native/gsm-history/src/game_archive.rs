//! Portable ZIP archives produced by both GSM runtimes. Reading the catalog
//! skips cover art. Restores retain one sentence at a time and commit its
//! vocabulary and replacement daily aggregates in the same transaction.
mod archive_days;
pub(crate) use archive_days::merge_into;
pub mod catalog;
mod restore;
mod write;
use crate::Result;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};
use zip::ZipArchive;

const DAMAGED: &str = "Unable to read the archive file. The file may be damaged.";
const INVALID_META: &str = "Invalid archive file metadata";
const FORMAT: &str = "gsm-game-archive";

pub fn file_id(game: &str) -> String {
    format!("{:x}", Sha256::digest(game.as_bytes()))
}

#[derive(Deserialize)]
pub struct GameIdentity {
    id: String,
}

trait Identity {
    fn id(&self) -> Option<&str>;
}
impl Identity for GameIdentity {
    fn id(&self) -> Option<&str> {
        Some(&self.id)
    }
}
impl Identity for Map<String, Value> {
    fn id(&self) -> Option<&str> {
        self.get("id")?.as_str()
    }
}

pub struct Manifest<G> {
    pub game_id: String,
    pub game_name: String,
    pub line_count: u64,
    game: G,
}

fn manifest<G: DeserializeOwned + Identity>(
    zip: &mut ZipArchive<File>,
    id: &str,
) -> std::result::Result<Manifest<G>, &'static str> {
    #[derive(Deserialize)]
    struct Stored<G> {
        format: Option<String>,
        version: Option<u64>,
        game_id: Option<String>,
        game_name: Option<String>,
        line_count: Option<u64>,
        game: Option<G>,
    }
    let member = zip.by_name("manifest.json").map_err(|_| DAMAGED)?;
    let stored: Stored<G> = serde_json::from_reader(BufReader::new(member)).map_err(|e| {
        if e.is_data() {
            INVALID_META
        } else {
            DAMAGED
        }
    })?;
    if stored.format.as_deref() != Some(FORMAT) || stored.version != Some(1) {
        return Err("Unsupported archive file format");
    }
    let game_id = stored
        .game_id
        .filter(|id| !id.is_empty())
        .ok_or(INVALID_META)?;
    let game = stored
        .game
        .filter(|g| g.id() == Some(&game_id))
        .ok_or(INVALID_META)?;
    if file_id(&game_id) != id {
        return Err("Archive file identity does not match its filename");
    }
    Ok(Manifest {
        game_id,
        game_name: stored.game_name.ok_or(INVALID_META)?,
        line_count: stored.line_count.ok_or(INVALID_META)?,
        game,
    })
}

pub fn summary(path: &Path, id: &str) -> std::result::Result<Manifest<GameIdentity>, &'static str> {
    let mut zip = ZipArchive::new(File::open(path).map_err(|_| DAMAGED)?).map_err(|_| DAMAGED)?;
    manifest(&mut zip, id)
}

#[derive(Deserialize)]
struct Record {
    line: Map<String, Value>,
    #[serde(default)]
    words: Vec<(String, Option<String>, Option<String>, Value)>,
    #[serde(default)]
    kanji: Vec<String>,
    #[serde(default)]
    tokens_available: bool,
}

impl Record {
    fn id(&self) -> Result<&str> {
        self.line
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Invalid sentence in archive file".into())
    }

    fn timestamp(&self) -> Result<f64> {
        let value = self
            .line
            .get("timestamp")
            .ok_or("Missing sentence timestamp")?;
        value
            .as_f64()
            .or_else(|| value.as_str()?.trim().parse().ok())
            .filter(|n| n.is_finite())
            .ok_or_else(|| "Invalid archive sentence timestamp".into())
    }
}

fn records(zip: &mut ZipArchive<File>, mut visit: impl FnMut(Record) -> Result<()>) -> Result<()> {
    read_records(zip, |record, _| visit(record))
}

fn read_records(
    zip: &mut ZipArchive<File>,
    mut visit: impl FnMut(Record, &[u8]) -> Result<()>,
) -> Result<()> {
    let member = zip
        .by_name("game_lines.jsonl")
        .map_err(|_| "Unable to read sentences from the archive file")?;
    let mut reader = BufReader::new(member);
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line)? != 0 {
        let record: Record = serde_json::from_slice(&line)
            .map_err(|_| "Unable to read sentences from the archive file")?;
        record.id()?;
        record.timestamp()?;
        if !record
            .line
            .get("line_text")
            .is_some_and(|t| t.is_null() || t.is_string())
        {
            return Err("Invalid sentence in archive file".into());
        }
        visit(record, &line)?;
        line.clear();
    }
    Ok(())
}
