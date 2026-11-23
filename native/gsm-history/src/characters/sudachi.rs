//! Per-game CSVs consumed by the overlay's Sudachi compiler. Project only
//! names and aliases while deserializing; character portraits can be large.
use super::names::{contains_kanji, hiragana, katakana, reading};
use crate::{History, Result};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use tempfile::NamedTempFile;

#[derive(Default, Deserialize)]
#[serde(default)]
struct Name {
    name: Option<String>,
    name_original: Option<String>,
    aliases: Option<Vec<Value>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Groups {
    main: Vec<Name>,
    primary: Vec<Name>,
    side: Vec<Name>,
    appears: Vec<Name>,
}

#[derive(Deserialize)]
struct Document {
    characters: Groups,
}

impl Name {
    fn surfaces(self, out: &mut BTreeMap<String, String>) {
        let roman = self.name.as_deref().unwrap_or("").trim();
        let name = self
            .name_original
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(roman)
            .trim();
        if name.is_empty() {
            return;
        }
        let (combined, full) = if let Some((family, given)) = name.split_once(' ') {
            let (first, second) = roman.split_once(' ').unwrap_or((roman, ""));
            (
                format!("{family}{given}"),
                format!("{}{}", reading(family, first), reading(given, second)),
            )
        } else {
            (name.to_owned(), reading(name, roman))
        };
        let full = full.replace(' ', "");
        if full.is_empty() {
            return;
        }
        let mut add = |term: String, kana: &str| {
            out.entry(term).or_insert_with(|| katakana(kana));
        };
        add(name.to_owned(), &full);
        if combined != name {
            add(combined, &full)
        }
        if contains_kanji(name) {
            add(full.clone(), &full);
            add(katakana(&full), &full);
        }
        for alias in self.aliases.into_iter().flatten() {
            if let Some(text) = alias
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && !contains_kanji(s))
            {
                let kana = hiragana(&text.replace(' ', ""));
                if !kana.is_empty() {
                    add(text.to_owned(), &kana)
                }
            }
        }
    }
}

fn row<'a>(term: &'a str, kana: &'a str) -> [&'a str; 19] {
    let cost = if term
        .chars()
        .filter(|&c| c != ' ')
        .all(|c| ('\u{30a0}'..='\u{30ff}').contains(&c))
    {
        "13759"
    } else if !term.chars().any(|c| matches!(c,'ァ'..='ヶ'|'ヽ'..='ヾ')) {
        "18269"
    } else {
        "18086"
    };
    [
        term,
        "4787",
        "4787",
        cost,
        term,
        "名詞",
        "固有名詞",
        "人名",
        "一般",
        "*",
        "*",
        kana,
        term,
        "*",
        "A",
        "*",
        "*",
        "*",
        "*",
    ]
}

#[derive(Serialize, Deserialize)]
struct Metadata {
    game_id: String,
    title: String,
    obs_scene_name: String,
    row_count: usize,
    source_hash: String,
}

impl History {
    pub fn export_sudachi_names(&self, path: &Path, id: &str, generation: u64) -> Result<bool> {
        if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', ':', '\0']) {
            return Err("Invalid game dictionary filename".into());
        }
        if self.generation()? != generation {
            return Err("Database changed before dictionary export".into());
        }
        let root = path
            .parent()
            .ok_or("Missing profile directory")?
            .join("dictionaries/sudachi");
        let meta_dir = root.join("metadata");
        fs::create_dir_all(&meta_dir)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(meta_dir.join(format!("{id}.lock")))?;
        lock.lock()?;
        let selected = self.with_reader(path, |db| {
            let mut stmt = db.prepare_cached(
                "SELECT coalesce(title_original,''),coalesce(obs_scene_name,''),vndb_character_data
                FROM games WHERE id=? AND vndb_character_data IS NOT NULL",
            )?;
            Ok(stmt
                .query_row([id], |r| {
                    let people = serde_json::from_slice::<Document>(r.get_ref(2)?.as_bytes()?).ok();
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, people))
                })
                .optional()?)
        })?;
        let Some((title, obs_scene_name, Some(doc))) = selected else {
            return Ok(false);
        };
        let mut terms = BTreeMap::new();
        let groups = doc.characters;
        for name in groups
            .main
            .into_iter()
            .chain(groups.primary)
            .chain(groups.side)
            .chain(groups.appears)
        {
            name.surfaces(&mut terms);
        }
        if terms.is_empty() {
            return Ok(false);
        }
        let rows = terms
            .iter()
            .map(|(surface, kana)| row(surface, kana))
            .collect::<Vec<_>>();
        let mut digest = Sha256::new();
        serde_json::to_writer(&mut digest, &rows)?;
        let source_hash = format!("{:x}", digest.finalize());
        let csv_dir = root.join("csv");
        let csv_path = csv_dir.join(format!("{id}.csv"));
        let meta_path = meta_dir.join(format!("{id}.json"));
        if csv_path.is_file()
            && fs::read(&meta_path)
                .ok()
                .and_then(|buf| serde_json::from_slice::<Metadata>(&buf).ok())
                .is_some_and(|stored| stored.source_hash == source_hash)
        {
            return Ok(false);
        }
        fs::create_dir_all(&csv_dir)?;
        let mut csv = NamedTempFile::new_in(&csv_dir)?;
        {
            let mut writer = csv::Writer::from_writer(csv.as_file_mut());
            for fields in &rows {
                writer.write_record(*fields)?
            }
            writer.flush()?;
        }
        let mut metadata = NamedTempFile::new_in(&meta_dir)?;
        serde_json::to_writer_pretty(
            metadata.as_file_mut(),
            &Metadata {
                game_id: id.into(),
                title,
                obs_scene_name,
                row_count: rows.len(),
                source_hash,
            },
        )?;
        metadata.flush()?;
        csv.as_file().sync_all()?;
        metadata.as_file().sync_all()?;
        self.with_writer_generation(path, Some(generation), |_| {
            // Publish the digest last. Interrupted runs will repeat the CSV write.
            csv.persist(&csv_path)?;
            metadata.persist(&meta_path)?;
            Ok(true)
        })
    }
}
