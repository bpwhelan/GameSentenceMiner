use crate::yomitan_frequency::Response;
use crate::{Query, Reply, Reports};
use gsm_history::{characters::Game, Result};
use serde::Serialize;
use serde_json::{json, ser::Formatter, Serializer, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, BufWriter, Cursor, Write},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
mod content;
mod names;
mod portraits;

// Python's JSON format uses a signed, at least two-digit scientific exponent.
// Existing dictionaries check this digest before downloading portraits and terms.
struct RevisionFormat;
impl Formatter for RevisionFormat {
    fn write_f64<W: ?Sized + Write>(&mut self, w: &mut W, value: f64) -> io::Result<()> {
        let repr = format!("{value:?}");
        if let Some((mantissa, exponent)) = repr.split_once('e') {
            let exponent = exponent.parse::<i32>().expect("finite f64 exponent");
            write!(w, "{mantissa}e{exponent:+03}")
        } else {
            w.write_all(repr.as_bytes())
        }
    }
}

// Keep fields in lexical order to match the published revision algorithm.
#[derive(Serialize)]
struct Revision<'a> {
    game_count: usize,
    games: &'a [Game],
    spoiler_level: u8,
    version: u8,
}

fn index(games: &[Game], count: usize, spoiler: u8, port: u16) -> Result<Value> {
    let mut digest = Sha256::new();
    {
        let mut buffered = BufWriter::new(&mut digest);
        Revision {
            game_count: count,
            games,
            spoiler_level: spoiler,
            version: 2,
        }
        .serialize(&mut Serializer::with_formatter(
            &mut buffered,
            RevisionFormat,
        ))?;
        buffered.flush()?;
    }
    let digest = digest.finalize();
    let revision = format!(
        "{:016x}",
        u64::from_be_bytes(digest[..8].try_into().unwrap())
    );
    let plural = if count == 1 { "game" } else { "games" };
    let mut description =
        format!("Character names from your {count} most recently played {plural}");
    let mut separator = ": ";
    for game in games.iter().filter(|g| !g.title.is_empty()) {
        description.push_str(separator);
        description.push_str(&game.title);
        separator = ", ";
    }
    let query = format!("game_count={count}&spoiler_level={spoiler}");
    Ok(json!({
        "title":"GSM Character Dictionary","revision":revision,"format":3,"author":"GameSentenceMiner",
        "description":description,"isUpdatable":true,
        "downloadUrl":format!("http://127.0.0.1:{port}/api/yomitan-dict?{query}"),
        "indexUrl":format!("http://127.0.0.1:{port}/api/yomitan-index?{query}")
    }))
}

impl Reports {
    pub(super) fn character_index(&self, q: &Query<'_>) -> Result<Reply> {
        let count = q
            .int("game_count")
            .ok()
            .flatten()
            .filter(|n| (1..=999).contains(n))
            .unwrap_or(3) as usize;
        let spoiler = q
            .int("spoiler_level")
            .ok()
            .flatten()
            .filter(|n| (0..=2).contains(n))
            .unwrap_or(0) as u8;
        let games = self.history.character_games(&self.database, count)?;
        Ok(Reply {
            status: 200,
            body: index(&games, count, spoiler, self.preferences()?.port)?,
        })
    }

    pub fn character_dictionary(&self, query: &str) -> Result<Response> {
        let q = Query(form_urlencoded::parse(query.as_bytes()).collect());
        let count = q.int("game_count").ok().flatten().unwrap_or(3);
        let spoiler = q.int("spoiler_level").ok().flatten().unwrap_or(0);
        let error = |status, body| Ok(Response::Json(Reply { status, body }));
        if !(1..=999).contains(&count) {
            return error(
                400,
                json!({"error":"Invalid game_count parameter",
            "message":format!("game_count must be between 1 and 999, got: {count}"),"action":"Please use a value between 1 and 999"}),
            );
        }
        if !(0..=2).contains(&spoiler) {
            return error(
                400,
                json!({"error":"Invalid spoiler_level parameter",
            "message":format!("spoiler_level must be between 0 and 2, got: {spoiler}"),"action":"Please use a value between 0 (None), 1 (Minor), or 2 (Major)"}),
            );
        }
        let games = self
            .history
            .character_games(&self.database, count as usize)?;
        if games.is_empty() {
            return error(
                404,
                json!({"error":"No games with valid VNDB character data found",
            "message":"None of your recently played games have populated character data from VNDB.",
            "action":"Visit the Database page → Link Games to VNDB, or play a different game that has character data available"}),
            );
        }
        let index = index(
            &games,
            count as usize,
            spoiler as u8,
            self.preferences()?.port,
        )?;
        let cache = self
            .database
            .with_file_name("cache")
            .join("character_images");
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        archive.start_file("index.json", options)?;
        serde_json::to_writer(&mut archive, &index)?;
        archive.start_file("tag_bank_1.json", options)?;
        serde_json::to_writer(
            &mut archive,
            &json!([
                ["name", "partOfSpeech", 0, "Character name", 0],
                ["main", "name", 0, "Protagonist", 0],
                ["primary", "name", 0, "Main character", 0],
                ["side", "name", 0, "Side character", 0],
                ["appears", "name", 0, "Minor appearance", 0]
            ]),
        )?;
        let mut terms = Terms {
            archive,
            count: 0,
            buffer: Vec::with_capacity(65536),
        };
        let mut portraits = BTreeMap::new();
        for game in &games {
            for role in ["main", "primary", "side", "appears"] {
                for c in game.character_data["characters"][role]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| c.is_object())
                {
                    if ["name", "name_original"]
                        .iter()
                        .all(|k| c[*k].as_str().is_none_or(str::is_empty))
                    {
                        continue;
                    }
                    let portrait = portraits::get(c, &cache);
                    let image = portrait.as_ref().map(|p| p.path.as_str());
                    let definition = content::definition(c, &game.title, image, spoiler as u8);
                    let role = c["role"].as_str().unwrap_or("");
                    let tag = if role.is_empty() {
                        "name".to_owned()
                    } else {
                        format!("name {role}")
                    };
                    let score = content::role(role).map_or(0, |r| r.0);
                    // All spellings of a character share the same serialized definition.
                    let tail = serde_json::to_vec(&(tag, "", score, [definition], 0, ""))?;
                    names::visit(c, |term, reading| terms.push(term, reading, &tail[1..]))?;
                    if let Some(p) = portrait {
                        portraits.insert(c["id"].to_string(), p);
                    }
                }
            }
        }
        if terms.count == 0 {
            let titles = games
                .iter()
                .map(|g| {
                    if g.title.is_empty() {
                        "Unknown"
                    } else {
                        &g.title
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            return error(
                404,
                json!({"error":"No character entries generated",
                "message":format!("Character data validation passed but no entries were created from: {titles}"),
                "action":"This may indicate a data format issue. Please report this on GitHub."}),
            );
        }
        terms.finish_bank()?;
        for (_, portrait) in portraits {
            terms.archive.start_file(portrait.path, options)?;
            terms.archive.write_all(&portrait.bytes)?;
        }
        Ok(Response::Archive(terms.archive.finish()?.into_inner()))
    }
}

struct Terms {
    archive: ZipWriter<Cursor<Vec<u8>>>,
    count: usize,
    buffer: Vec<u8>,
}
impl Terms {
    fn push(&mut self, term: &str, reading: &str, tail: &[u8]) -> Result<()> {
        if self.count % 10_000 == 0 {
            if self.count > 0 {
                self.finish_bank()?
            }
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)
                .compression_level(Some(1));
            self.archive.start_file(
                format!("term_bank_{}.json", self.count / 10_000 + 1),
                options,
            )?;
            self.buffer.push(b'[');
        } else {
            self.buffer.push(b',');
        }
        self.buffer.push(b'[');
        serde_json::to_writer(&mut self.buffer, term)?;
        self.buffer.push(b',');
        serde_json::to_writer(&mut self.buffer, reading)?;
        self.buffer.push(b',');
        self.buffer.extend_from_slice(tail);
        if self.buffer.len() >= 65536 {
            self.archive.write_all(&self.buffer)?;
            self.buffer.clear();
        }
        self.count += 1;
        Ok(())
    }
    fn finish_bank(&mut self) -> Result<()> {
        self.buffer.push(b']');
        self.archive.write_all(&self.buffer)?;
        self.buffer.clear();
        Ok(())
    }
}
