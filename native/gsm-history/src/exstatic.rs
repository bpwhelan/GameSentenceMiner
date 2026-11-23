//! Import ExStatic sentence IDs while recognizing exports from older GSM versions.
use crate::{capture, History, Result};
use rusqlite::{params, TransactionBehavior};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    io::{self, BufRead, Read},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub struct InvalidCsv(pub String);
impl fmt::Display for InvalidCsv {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for InvalidCsv {}

pub struct Imported {
    pub count: usize,
    pub games: Vec<String>,
    pub warnings: Vec<String>,
    pub index_ids: Vec<String>,
}

fn csv_error(error: csv::Error) -> InvalidCsv {
    if matches!(error.kind(), csv::ErrorKind::Utf8 { .. }) {
        InvalidCsv("File encoding error. Please ensure the CSV is UTF-8 encoded.".into())
    } else {
        InvalidCsv(format!("CSV parsing error: {error}"))
    }
}

#[derive(Copy, Clone)]
enum FieldState {
    Start,
    Quoted,
    AfterQuote,
    Plain,
}

// ExStatic's DictReader enables skipinitialspace. Remove leading ASCII spaces
// before parsing each field, including a quoted field after a comma. Spaces
// and line breaks inside quoted dialogue are part of the sentence.
struct SkipInitialSpace<R> {
    reader: R,
    state: FieldState,
}
impl<R: BufRead> Read for SkipInitialSpace<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            let input = self.reader.fill_buf()?;
            if input.is_empty() {
                return Ok(0);
            }
            let mut written = 0;
            let mut consumed = 0;
            for &byte in input {
                use FieldState::*;
                consumed += 1;
                self.state = match (self.state, byte) {
                    (Start, b' ') => continue,
                    (Start | AfterQuote, b'"') => Quoted,
                    (Quoted, b'"') => AfterQuote,
                    (Quoted, _) => Quoted,
                    (_, b',' | b'\r' | b'\n') => Start,
                    _ => Plain,
                };
                out[written] = byte;
                written += 1;
                if written == out.len() {
                    break;
                }
            }
            self.reader.consume(consumed);
            if written != 0 {
                return Ok(written);
            }
        }
    }
}

const HEADERS: [&str; 5] = ["uuid", "given_identifier", "name", "line", "time"];
fn columns(record: &csv::StringRecord) -> std::result::Result<[usize; 5], InvalidCsv> {
    if record.is_empty() {
        return Err(InvalidCsv("Empty CSV file".into()));
    }
    let mut columns = [0; 5];
    let mut missing = BTreeSet::new();
    for (slot, key) in columns.iter_mut().zip(HEADERS) {
        if let Some(index) = record
            .iter()
            .enumerate()
            .filter_map(|(i, h)| (h.trim() == key).then_some(i))
            .last()
        {
            *slot = index;
        } else {
            missing.insert(key);
        }
    }
    if missing.is_empty() {
        return Ok(columns);
    }
    let found = record.iter().map(str::trim).collect::<BTreeSet<_>>();
    if found.contains("client") && found.contains("chars_read") {
        return Err(InvalidCsv("This appears to be an ExStatic stats CSV. Please upload the ExStatic lines CSV file instead. The lines CSV should contain columns: uuid, given_identifier, name, line, time".into()));
    }
    Err(InvalidCsv(format!(
        "Invalid CSV format. Missing required columns: {}. Expected format: {}. Found headers: {}",
        missing.into_iter().collect::<Vec<_>>().join(", "),
        HEADERS.join(", "),
        found.into_iter().collect::<Vec<_>>().join(", ")
    )))
}

impl History {
    pub fn import_exstatic(
        &self,
        path: &Path,
        generation: u64,
        mut file: impl BufRead,
        language: &str,
        index: bool,
    ) -> Result<Imported> {
        if file.fill_buf()?.starts_with(&[0xef, 0xbb, 0xbf]) {
            file.consume(3);
        }
        let mut csv = csv::ReaderBuilder::new()
            .flexible(true)
            .from_reader(SkipInitialSpace {
                reader: file,
                state: FieldState::Start,
            });
        let cols = columns(csv.headers().map_err(csv_error)?)?;
        self.with_writer_generation(path, Some(generation), |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let imported = read_lines(&tx, csv, cols, language, index)?;
            tx.commit()?;
            Ok(imported)
        })
    }
}

fn read_lines(
    tx: &rusqlite::Transaction,
    mut csv: csv::Reader<impl Read>,
    columns: [usize; 5],
    language: &str,
    index: bool,
) -> Result<Imported> {
    // Only pre-existing text-based IDs can satisfy a legacy match. Each such
    // ID accounts for one occurrence, even if the dialogue repeats in a game.
    tx.execute_batch(
        "CREATE TEMP TABLE exstatic_seen(id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE) WITHOUT ROWID",
    )?;
    let mut exists = tx.prepare_cached(
        "SELECT 1 FROM game_lines WHERE id=?1 UNION ALL
         SELECT 1 FROM temp.exstatic_seen WHERE id=?1 LIMIT 1",
    )?;
    let mut legacy = tx.prepare_cached(
        "SELECT 1 FROM game_lines WHERE id=?1
         AND NOT EXISTS(SELECT 1 FROM temp.exstatic_seen WHERE id=?1 OR legacy_id=?1)",
    )?;
    let mut seen = tx.prepare_cached("INSERT INTO temp.exstatic_seen(id,legacy_id) VALUES(?,?)")?;
    let mut insert = tx.prepare_cached(capture::IMPORT_LINE)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
    let mut games = BTreeMap::new();
    let mut warnings = Vec::new();
    let mut index_ids = Vec::new();
    let mut count = 0;
    let mut record = csv::StringRecord::new();
    let mut row_number = 0;
    while csv.read_record(&mut record).map_err(csv_error)? {
        let row = row_number;
        row_number += 1;
        let fields = columns.map(|column| record.get(column).unwrap_or("").trim());
        if let Some(i) = fields.iter().position(|s| s.is_empty()) {
            let name = ["UUID", "given identifier", "name", "line text", "time"][i];
            warnings.push(format!("Row {row}: Missing {name}"));
            continue;
        }
        let [uuid, identifier, game, line, raw] = fields;
        let id = format!("{uuid}|{identifier}");
        if exists.exists([&id])? {
            continue;
        }
        let old = format!("{uuid}|{line}");
        if legacy.exists([&old])? {
            seen.execute(params![id, old])?;
            continue;
        }
        let Ok(timestamp) = raw.parse::<f64>() else {
            warnings.push(format!("Row {row}: Invalid time format: {raw}"));
            continue;
        };
        if !(-62135596800.0..253402300800.0).contains(&timestamp) {
            warnings.push(format!("Row {row}: Timestamp out of range: {raw}"));
            continue;
        }
        // datetime.fromtimestamp rounds only the fractional second to microseconds.
        let timestamp = timestamp.trunc() + (timestamp.fract() * 1e6).round_ties_even() / 1e6;
        if !games.contains_key(game) {
            games.insert(game.to_owned(), capture::game_id(tx, game)?);
        }
        insert.execute(params![
            id,
            game,
            line,
            timestamp,
            games[game],
            language,
            now
        ])?;
        seen.execute(params![id, Option::<&str>::None])?;
        if index {
            index_ids.push(id);
        }
        count += 1;
    }
    tx.execute_batch("DROP TABLE temp.exstatic_seen")?;
    Ok(Imported {
        count,
        games: games.into_keys().collect(),
        warnings,
        index_ids,
    })
}
