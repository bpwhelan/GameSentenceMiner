//! Personal Yomitan dictionary. Keep at most one uncompressed term bank in memory.
use crate::{Reply, Reports};
use gsm_history::Result;
use serde_json::{json, Value};
use std::io::{Cursor, Write};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const BANK_SIZE: usize = 10_000;

#[derive(serde::Serialize)]
struct ReadingFrequency<'a> {
    frequency: i64,
    reading: &'a str,
}

pub enum Response {
    Json(Reply),
    Archive(Vec<u8>),
}

impl Reports {
    pub fn yomitan_frequency(&self, index_only: bool) -> Response {
        self.frequency_response(index_only).unwrap_or_else(|error| {
            Response::Json(Reply::error(
                500,
                &format!("Failed to generate frequency dictionary: {error}"),
            ))
        })
    }

    fn frequency_response(&self, index_only: bool) -> Result<Response> {
        let prefs = self.preferences()?;
        if !prefs.tokenization {
            return Ok(Response::Json(Reply::error(
                404,
                "Tokenization must be enabled to use the frequency dictionary",
            )));
        }
        let index = index(prefs.port);
        if index_only {
            return Ok(Response::Json(Reply {
                status: 200,
                body: index,
            }));
        }
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        archive.start_file("index.json", options)?;
        serde_json::to_writer(&mut archive, &index)?;
        let mut bank = Vec::new();
        let mut term_count = 0;
        let mut bank_number = 1;
        let mut finish = |bank: &mut Vec<u8>| -> Result<()> {
            bank.push(b']');
            archive.start_file(format!("term_meta_bank_{bank_number}.json"), options)?;
            archive.write_all(bank)?;
            bank_number += 1;
            bank.clear();
            Ok(())
        };
        self.history
            .visit_word_frequencies(&self.database, |word, reading, count| {
                bank.push(if bank.is_empty() { b'[' } else { b',' });
                if let Some(reading) = reading.filter(|s| !s.is_empty()) {
                    serde_json::to_writer(
                        &mut bank,
                        &(
                            word,
                            "freq",
                            ReadingFrequency {
                                reading,
                                frequency: count,
                            },
                        ),
                    )?;
                } else {
                    serde_json::to_writer(&mut bank, &(word, "freq", count))?;
                }
                term_count += 1;
                if term_count % BANK_SIZE == 0 {
                    finish(&mut bank)?;
                }
                Ok(())
            })?;
        if term_count == 0 {
            return Ok(Response::Json(Reply::error(
                404,
                "No frequency data available. Play some games with tokenization enabled.",
            )));
        }
        if !bank.is_empty() {
            finish(&mut bank)?;
        }
        Ok(Response::Archive(archive.finish()?.into_inner()))
    }
}

fn index(port: u16) -> Value {
    json!({
        "title": "GSM Frequency Dictionary", "revision": chrono::Utc::now().timestamp().to_string(),
        "format": 3, "frequencyMode": "occurrence-based", "author": "GameSentenceMiner",
        "description": "Word frequency data from your GSM database",
        "downloadUrl": format!("http://127.0.0.1:{port}/api/yomitan-freq-dict"),
        "indexUrl": format!("http://127.0.0.1:{port}/api/yomitan-freq-index"), "isUpdatable":true
    })
}
