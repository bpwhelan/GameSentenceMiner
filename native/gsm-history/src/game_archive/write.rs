use super::{archive_days, file_id, manifest, read_records, GameIdentity, FORMAT};
use crate::{maintenance::MaintenancePermit, rollup, stats, History, ReportCleaner, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{types::ValueRef, Connection, Row, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufWriter, Write},
    path::Path,
};
use tempfile::NamedTempFile;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

fn column(value: ValueRef<'_>) -> Result<Value> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(n) => serde_json::Number::from_f64(n)
            .ok_or("Invalid non-finite archive value")?
            .into(),
        ValueRef::Text(s) => std::str::from_utf8(s)?.into(),
        ValueRef::Blob(bytes) => json!({"$binary":STANDARD.encode(bytes)}),
    })
}

fn object(row: &Row, fields: &[String]) -> Result<Map<String, Value>> {
    fields
        .iter()
        .enumerate()
        .map(|(i, name)| Ok((name.clone(), column(row.get_ref(i)?)?)))
        .collect()
}

fn read_game(conn: &Connection, id: &str) -> Result<Map<String, Value>> {
    let mut stmt = conn.prepare_cached("SELECT * FROM games WHERE id=?")?;
    let fields = stmt
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut rows = stmt.query([id])?;
    object(rows.next()?.ok_or("Game not found")?, &fields)
}

fn filename(title: &str, id: &str) -> String {
    let sanitized: String = title
        .chars()
        .map(|c| {
            if c < ' ' || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let title: String = sanitized
        .trim_matches([' ', '.'])
        .chars()
        .take(60)
        .collect();
    format!("game-{title}--{id}.gsm-archive.zip")
}

fn write_live(
    conn: &Connection,
    writer: &mut impl Write,
    game: &str,
    have_tokens: bool,
) -> Result<u64> {
    let mut stmt = conn.prepare("SELECT * FROM game_lines WHERE game_id=? ORDER BY id")?;
    let fields = stmt
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut words = if have_tokens {
        Some(conn.prepare_cached(
            "SELECT w.word,w.reading,w.pos,w.in_anki
        FROM word_occurrences o JOIN words w ON w.id=o.word_id WHERE o.line_id=?",
        )?)
    } else {
        None
    };
    let mut kanji = if have_tokens {
        Some(conn.prepare_cached(
            "SELECT k.character FROM kanji_occurrences o
        JOIN kanji k ON k.id=o.kanji_id WHERE o.line_id=?",
        )?)
    } else {
        None
    };
    let mut rows = stmt.query([game])?;
    let mut count = 0;
    while let Some(row) = rows.next()? {
        let line = object(row, &fields)?;
        let id = line
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Missing archive sentence ID")?;
        let mut saved_words = Vec::new();
        if let Some(words) = words.as_mut() {
            let mut found = words.query([id])?;
            while let Some(r) = found.next()? {
                saved_words.push([
                    column(r.get_ref(0)?)?,
                    column(r.get_ref(1)?)?,
                    column(r.get_ref(2)?)?,
                    column(r.get_ref(3)?)?,
                ]);
            }
        }
        let characters = match kanji.as_mut() {
            Some(kanji) => kanji
                .query_map([id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            None => Vec::new(),
        };
        let available = have_tokens
            && line
                .get("tokenized")
                .is_some_and(|v| v == 1 || v == "1" || v == true);
        serde_json::to_writer(
            &mut *writer,
            &json!({"line":line,"words":saved_words,"kanji":characters,"tokens_available":available}),
        )?;
        writer.write_all(b"\n")?;
        count += 1;
    }
    Ok(count)
}

fn stage(
    conn: &Connection,
    game: Map<String, Value>,
    title: &str,
    destination: &Path,
    previous: Option<&Path>,
    have_tokens: bool,
) -> Result<(NamedTempFile, Value)> {
    let game_id = game["id"].as_str().ok_or("Invalid game ID")?;
    let id = file_id(game_id);
    let mut tmp = NamedTempFile::new_in(destination.parent().ok_or("Missing archive directory")?)?;
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    let mut count = 0u64;
    {
        let mut output = ZipWriter::new(BufWriter::new(tmp.as_file_mut()));
        output.start_file("game_lines.jsonl", options.large_file(true))?;
        if let Some(previous) = previous {
            let mut prior = ZipArchive::new(File::open(previous)?)?;
            let metadata = manifest::<GameIdentity>(&mut prior, &id)?;
            let mut seen = HashSet::new();
            let mut current = conn.prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM game_lines WHERE game_id=?1 AND id=?2)",
            )?;
            read_records(&mut prior, |record, raw| {
                let row_id = record.id()?;
                if !current.query_row([game_id, row_id], |r| r.get::<_, bool>(0))? {
                    output.write_all(raw)?;
                    if !raw.ends_with(b"\n") {
                        output.write_all(b"\n")?;
                    }
                    count += 1;
                }
                if !seen.insert(row_id.to_owned()) {
                    return Err("Duplicate sentence IDs in archive file".into());
                }
                Ok(())
            })?;
            if seen.len() as u64 != metadata.line_count {
                return Err("Archive file sentence count does not match its metadata".into());
            }
        }
        count += write_live(conn, &mut output, game_id, have_tokens)?;
        output.start_file("manifest.json", options)?;
        serde_json::to_writer(
            &mut output,
            &json!({"format":FORMAT,"version":1,"game_id":game_id,"game_name":title,"game":game,
            "line_count":count,"updated_at":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs_f64()}),
        )?;
        output.finish()?.flush()?;
    }
    let mut verified = ZipArchive::new(tmp.reopen()?)?;
    for index in 0..verified.len() {
        io::copy(&mut verified.by_index(index)?, &mut io::sink())?;
    }
    tmp.as_file().sync_all()?;
    let file = json!({"file_id":id,"filename":destination.file_name().and_then(|n|n.to_str()).ok_or("Invalid archive filename")?,
        "line_count":count,"size_bytes":tmp.as_file().metadata()?.len()});
    Ok((tmp, file))
}

impl History {
    pub fn archive_game(
        &self,
        permit: &MaintenancePermit,
        game_id: &str,
        completed_before: Option<f64>,
        cleaner: &ReportCleaner,
        gap: f64,
        tokenized: bool,
    ) -> Result<Value> {
        self.with_writer_generation(&permit.database, Some(permit.generation), |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let game = read_game(&tx, game_id)?;
            let title = game["title_original"].as_str().filter(|s| !s.is_empty()).unwrap_or(game_id).to_owned();
            let (count, last): (u64, Option<f64>) = tx.query_row(
                "SELECT count(*),max(CAST(timestamp AS REAL)) FROM game_lines WHERE game_id=?",
                [game_id], |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let completed = match game["status"].as_str() {
                Some(status) if crate::game_stats::GAME_STATUS_VALUES.contains(&status) => status == "completed",
                _ => game["completed"] == 1 || game["completed"] == true || game["completed"] == "1",
            };
            if count == 0 || completed_before.is_some_and(|cutoff| !completed || last.is_none_or(|v| v >= cutoff)) {
                return Ok(json!({"game_id": game_id, "archived_lines": 0}));
            }
            let have_tokens: bool = tx.query_row(
                "SELECT count(*)=4 FROM sqlite_schema WHERE type='table'
                 AND name IN ('words','word_occurrences','kanji','kanji_occurrences')", [], |r| r.get(0),
            )?;
            if tokenized {
                let pending = !have_tokens || tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM game_lines WHERE game_id=? AND coalesce(tokenized,0)!=1)",
                    [game_id], |r| r.get::<_, bool>(0),
                )?;
                if pending {
                    return Err("Tokenization failed. No sentences were archived; retry after fixing tokenization.".into());
                }
            }
            let directory = permit.database.with_file_name("archives").join("games");
            fs::create_dir_all(&directory)?;
            let id = file_id(game_id);
            let previous = super::catalog::existing(&directory, &id)?;
            let destination = previous.clone().unwrap_or_else(|| directory.join(filename(&title, &id)));
            let scene = game["obs_scene_name"].as_str().unwrap_or("").to_owned();
            let (staged, file) = stage(&tx, game, &title, &destination, previous.as_deref(), have_tokens)?;
            // A verified copy remains downloadable even if the database rolls
            // back. The next attempt replaces duplicate IDs with the live rows.
            gsm_db::backup::publish(staged, &destination)?;
            let dates = archive_days::store(&tx, game_id, &scene, &title, cleaner, have_tokens)?;
            tx.execute("DELETE FROM game_lines WHERE game_id=?", [game_id])?;
            for table in ["word_occurrences", "kanji_occurrences"] {
                if stats::table_exists(&tx, table)? {
                    tx.execute(&format!("DELETE FROM {table} WHERE line_id NOT IN (SELECT id FROM game_lines)"), [])?;
                }
            }
            rollup::replace_dates(&tx, dates, cleaner, gap, tokenized)?;
            tx.commit()?;
            Ok(json!({"game_id":game_id, "archived_lines":count, "archive_file":file}))
        })
    }
}
