//! Offline vocabulary matching. Credentials and captured text are never stored.
use crate::jiten_rules::{self, Pin, Token};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sudachi::analysis::stateless_tokenizer::StatelessTokenizer;
use sudachi::analysis::{Mode, Tokenize};
use sudachi::dic::dictionary::JapaneseDictionary;
use unicode_normalization::UnicodeNormalization;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub spelling: String,
    #[serde(default)]
    pub reading: String,
    pub known_state: Vec<u8>,
    #[serde(default)]
    pub word_id: Option<i64>,
    #[serde(default)]
    pub reading_index: u8,
    #[serde(default)]
    pub due_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateUpdate {
    pub word_id: i64,
    #[serde(default)]
    pub reading_index: u8,
    pub known_state: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Request {
    Parse {
        texts: Vec<String>,
        sources: Vec<String>,
    },
    Replace {
        source: String,
        words: Vec<Word>,
    },
    UpdateStates {
        source: String,
        words: Vec<StateUpdate>,
    },
    Status {
        sources: Vec<String>,
    },
}

impl Request {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Parse { texts, sources } => {
                validate_sources(sources)?;
                if texts.len() > 128
                    || texts.iter().any(|s| s.len() > 64_000)
                    || texts.iter().map(String::len).sum::<usize>() > 256_000
                {
                    return Err("Local parse exceeds the text budget".into());
                }
            }
            Self::Replace { source, words } => {
                validate_source(source)?;
                if words.len() > 250_000 {
                    return Err("Vocabulary snapshot is too large".into());
                }
                for word in words {
                    validate_word(word)?;
                }
            }
            Self::UpdateStates { source, words } => {
                validate_source(source)?;
                if words.len() > 1000 {
                    return Err("Too many state updates".into());
                }
                for word in words {
                    validate_states(&word.known_state)?;
                }
            }
            Self::Status { sources } => validate_sources(sources)?,
        }
        Ok(())
    }
}

fn validate_source(source: &str) -> Result<()> {
    if source.is_empty()
        || source.len() > 128
        || !source
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ":_-".contains(c))
    {
        return Err("Invalid vocabulary source".into());
    }
    Ok(())
}

fn validate_sources(sources: &[String]) -> Result<()> {
    if sources.len() > 8 {
        return Err("Too many vocabulary sources".into());
    }
    for source in sources {
        validate_source(source)?;
    }
    Ok(())
}

fn validate_states(states: &[u8]) -> Result<()> {
    if states.is_empty() || states.len() > 8 || states.iter().any(|s| *s > 7) {
        return Err("Invalid vocabulary state".into());
    }
    Ok(())
}

fn validate_word(word: &Word) -> Result<()> {
    validate_states(&word.known_state)?;
    if word.spelling.trim().is_empty()
        || word.spelling.len() > 1024
        || word.reading.len() > 1024
        || word.word_id.is_some_and(|id| id <= 0)
    {
        return Err("Invalid vocabulary word".into());
    }
    Ok(())
}

fn normalize(text: &str) -> String {
    text.trim().nfkc().collect()
}
fn normalize_reading(text: &str) -> String {
    normalize(text)
        .chars()
        .map(|c| {
            if ('\u{30a1}'..='\u{30f6}').contains(&c) {
                char::from_u32(c as u32 - 0x60).unwrap()
            } else {
                c
            }
        })
        .collect()
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub struct Store {
    db: Connection,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS vocabulary_sources (source TEXT PRIMARY KEY, synced_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS vocabulary_words (
                source TEXT NOT NULL, identity TEXT NOT NULL, spelling TEXT NOT NULL, reading TEXT NOT NULL,
                word_id INTEGER, reading_index INTEGER NOT NULL, states TEXT NOT NULL, due_at INTEGER,
                PRIMARY KEY(source, identity));
            CREATE INDEX IF NOT EXISTS vocabulary_spelling ON vocabulary_words(source, spelling, reading);
            CREATE INDEX IF NOT EXISTS vocabulary_jiten_id ON vocabulary_words(source, word_id, reading_index);")
            .map_err(|e| e.to_string())?;
        Ok(Self { db })
    }

    pub fn execute(
        &mut self,
        request: Request,
        dictionary: Option<Arc<JapaneseDictionary>>,
    ) -> Result<Value> {
        request.validate()?;
        match request {
            Request::Parse { texts, sources } => {
                let rules = jiten_rules::metadata()?;
                if texts.is_empty() {
                    return Ok(
                        json!({ "tokens": [], "tokenSource": "local-sudachi", "offsetEncoding": "utf-16", "rules": rules }),
                    );
                }
                let dictionary = dictionary.ok_or("Sudachi dictionary unavailable")?;
                let tokens = texts
                    .iter()
                    .map(|text| self.parse(dictionary.clone(), text, &sources))
                    .collect::<Result<Vec<_>>>()?;
                Ok(
                    json!({ "tokens": tokens, "tokenSource": "local-sudachi", "offsetEncoding": "utf-16", "rules": rules }),
                )
            }
            Request::Replace { source, words } => {
                self.replace(&source, words)?;
                self.status(&[source])
            }
            Request::UpdateStates { source, words } => {
                self.update_states(&source, words)?;
                self.status(&[source])
            }
            Request::Status { sources } => self.status(&sources),
        }
    }

    fn replace(&mut self, source: &str, words: Vec<Word>) -> Result<()> {
        validate_source(source)?;
        for word in &words {
            validate_word(word)?;
        }
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM vocabulary_words WHERE source=?1", [source])
            .map_err(|e| e.to_string())?;
        {
            let mut insert = tx
                .prepare_cached(
                    "INSERT INTO vocabulary_words
                (source, identity, spelling, reading, word_id, reading_index, states, due_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|e| e.to_string())?;
            for word in words {
                let spelling = normalize(&word.spelling);
                let reading = normalize_reading(&word.reading);
                let identity = match word.word_id {
                    Some(id) => format!("{id}:{}", word.reading_index),
                    None => serde_json::to_string(&(&spelling, &reading)).unwrap(),
                };
                insert
                    .execute(params![
                        source,
                        identity,
                        spelling,
                        reading,
                        word.word_id,
                        word.reading_index,
                        serde_json::to_string(&word.known_state).unwrap(),
                        word.due_at
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.execute(
            "INSERT INTO vocabulary_sources(source, synced_at) VALUES (?1, ?2)
            ON CONFLICT(source) DO UPDATE SET synced_at=excluded.synced_at",
            params![source, now()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    fn update_states(&mut self, source: &str, words: Vec<StateUpdate>) -> Result<()> {
        validate_source(source)?;
        for word in &words {
            validate_states(&word.known_state)?;
        }
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        for word in words {
            // A successful remote mutation supersedes the cached schedule. The next
            // snapshot supplies a new due date; never reuse a pre-review due date.
            tx.execute("UPDATE vocabulary_words SET states=?1, due_at=NULL WHERE source=?2 AND word_id=?3 AND reading_index=?4",
                params![serde_json::to_string(&word.known_state).unwrap(), source, word.word_id, word.reading_index]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    fn status(&self, sources: &[String]) -> Result<Value> {
        let mut result = Vec::new();
        for source in sources {
            let synced: Option<i64> = self
                .db
                .query_row(
                    "SELECT synced_at FROM vocabulary_sources WHERE source=?1",
                    [source],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let count: i64 = self
                .db
                .query_row(
                    "SELECT count(*) FROM vocabulary_words WHERE source=?1",
                    [source],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            result.push(json!({ "source": source, "count": count, "syncedAt": synced }));
        }
        Ok(json!({ "sources": result }))
    }

    #[cfg(test)]
    fn find(
        &self,
        sources: &[String],
        spellings: &[&str],
        reading: &str,
        timestamp: i64,
    ) -> Result<Option<Word>> {
        self.find_with_pin(sources, spellings, reading, timestamp, None)
    }

    fn find_with_pin(
        &self,
        sources: &[String],
        spellings: &[&str],
        reading: &str,
        timestamp: i64,
        pin: Option<Pin>,
    ) -> Result<Option<Word>> {
        let reading = normalize_reading(reading);
        let mut query = self
            .db
            .prepare_cached(
                "SELECT spelling, reading, states, word_id, reading_index, due_at
            FROM vocabulary_words WHERE source=?1 AND spelling=?2 AND (reading=?3 OR reading='')
            AND (?4 IS NULL OR word_id IS NULL OR (word_id=?4 AND (?5 IS NULL OR reading_index=?5)))
            ORDER BY (reading=?3) DESC LIMIT 2",
            )
            .map_err(|e| e.to_string())?;
        let mut by_id = self.db.prepare_cached(
            "SELECT spelling, reading, states, word_id, reading_index, due_at
            FROM vocabulary_words WHERE source=?1 AND word_id=?2
            AND ((?3 IS NOT NULL AND reading_index=?3) OR (?3 IS NULL AND (reading=?4 OR reading='')))
            ORDER BY (reading=?4) DESC LIMIT 2"
        ).map_err(|e| e.to_string())?;
        for source in sources {
            if let Some(pin) = pin {
                let rows = by_id
                    .query_map(
                        params![source, pin.word_id, pin.reading_index, reading],
                        read_word,
                    )
                    .map_err(|e| e.to_string())?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                if let Some(word) = resolve_rows(&rows, timestamp) {
                    return Ok(Some(word));
                }
            }
            for spelling in spellings {
                let rows = query
                    .query_map(
                        params![
                            source,
                            normalize(spelling),
                            reading,
                            pin.map(|p| p.word_id),
                            pin.and_then(|p| p.reading_index)
                        ],
                        read_word,
                    )
                    .map_err(|e| e.to_string())?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                if let Some(word) = resolve_rows(&rows, timestamp) {
                    return Ok(Some(word));
                }
            }
        }
        Ok(None)
    }

    fn parse(
        &self,
        dictionary: Arc<JapaneseDictionary>,
        text: &str,
        sources: &[String],
    ) -> Result<Vec<Value>> {
        let tokenizer = StatelessTokenizer::new(dictionary);
        let morphemes = tokenizer
            .tokenize(text, Mode::B, false)
            .map_err(|e| format!("Sudachi parse failed: {e}"))?;
        // Sudachi exposes byte/codepoint offsets. Renderer DOM ranges use UTF-16.
        let mut offsets = vec![0; text.len() + 1];
        let mut utf16 = 0;
        for (byte, ch) in text.char_indices() {
            offsets[byte] = utf16;
            utf16 += ch.len_utf16();
        }
        offsets[text.len()] = utf16;
        let timestamp = now();
        let mut tokens = Vec::new();
        // Keep punctuation and whitespace until after rewriting: several Jiten
        // corrections need clause-boundary context. Rewrites keep raw byte spans.
        let raw = morphemes
            .iter()
            .map(|m| Token {
                surface: m.surface().to_string(),
                headword: m.dictionary_form().to_string(),
                normalized: m.normalized_form().to_string(),
                reading: m.reading_form().to_string(),
                pos: m.part_of_speech().to_vec(),
                start: m.begin(),
                end: m.end(),
                pin: None,
                lookup_lemma: true,
                applied_rules: Vec::new(),
            })
            .collect();
        for mut token in jiten_rules::apply(raw, text)? {
            if token.is_boundary() {
                continue;
            }
            let base = if token.lookup_lemma {
                &token.headword
            } else {
                &token.surface
            };
            // Inflected surface readings (食べた → タベ) cannot identify the
            // dictionary form (食べる → タベル). Derive that reading locally.
            let lemma_reading = if base != &token.surface || token.reading.is_empty() {
                tokenizer
                    .tokenize(base, Mode::B, false)
                    .map_err(|e| e.to_string())?
                    .iter()
                    .map(|m| m.reading_form().to_string())
                    .collect::<String>()
            } else {
                token.reading.clone()
            };
            if token.reading.is_empty() {
                token.reading.clone_from(&lemma_reading);
            }
            let spellings = if token.lookup_lemma {
                vec![token.headword.as_str(), token.normalized.as_str()]
            } else {
                vec![token.surface.as_str()]
            };
            let word =
                self.find_with_pin(sources, &spellings, &lemma_reading, timestamp, token.pin)?;
            let word = match word {
                Some(word) => Some(word),
                None => self.find_with_pin(
                    sources,
                    &[&token.surface],
                    &token.reading,
                    timestamp,
                    token.pin,
                )?,
            };
            // A rule pin may correct a homograph without supplying its spelling.
            // Use the imported identity's spelling when that identity was resolved.
            if let (Some(pin), Some(word)) = (token.pin, &word) {
                if word.word_id == Some(pin.word_id) {
                    token.headword.clone_from(&word.spelling);
                    token.normalized.clone_from(&word.spelling);
                }
            }
            tokens.push(json!({ "word": token.surface, "start": offsets[token.start], "end": offsets[token.end],
                "headword": token.headword, "normalizedForm": token.normalized, "reading": token.reading, "pos": token.pos,
                "appliedRules": token.applied_rules,
                "knownState": word.as_ref().map(|w| w.known_state.clone()).unwrap_or_else(|| vec![0]),
                "wordId": word.as_ref().and_then(|w| w.word_id), "readingIndex": word.as_ref().map(|w| w.reading_index) }));
        }
        Ok(tokens)
    }
}

fn read_word(row: &rusqlite::Row<'_>) -> rusqlite::Result<Word> {
    let states: String = row.get(2)?;
    Ok(Word {
        spelling: row.get(0)?,
        reading: row.get(1)?,
        known_state: serde_json::from_str(&states).unwrap_or_else(|_| vec![0]),
        word_id: row.get(3)?,
        reading_index: row.get(4)?,
        due_at: row.get(5)?,
    })
}

fn resolve_rows(rows: &[Word], timestamp: i64) -> Option<Word> {
    let mut word = rows.first()?.clone();
    if rows.len() > 1 && rows[1].reading == word.reading {
        // Even a pinned word ID can have multiple reading indices. Never guess
        // the pair needed for grading when the readings are indistinguishable.
        word.word_id = None;
        if rows[1].known_state != word.known_state {
            word.known_state = vec![0];
            word.due_at = None;
        }
    }
    if let Some(due) = word.due_at {
        word.known_state.retain(|s| *s != 4);
        if due <= timestamp && !word.known_state.iter().any(|s| [3, 5, 6, 7].contains(s)) {
            word.known_state.push(4);
        }
    }
    Some(word)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(spelling: &str, reading: &str, state: u8) -> Word {
        Word {
            spelling: spelling.into(),
            reading: reading.into(),
            known_state: vec![state],
            word_id: None,
            reading_index: 0,
            due_at: None,
        }
    }

    #[test]
    fn rewrite_pins_require_a_confirmed_reading_and_preserve_source_precedence() {
        let mut db = Store::open(":memory:").unwrap();
        let mut first = entry("屑", "くず", 1);
        first.word_id = Some(1246510);
        first.reading_index = 2;
        let mut second = first.clone();
        second.reading_index = 3;
        second.known_state = vec![5];
        db.replace("jiten:a", vec![first.clone(), second]).unwrap();
        db.replace("jiten:b", vec![first]).unwrap();
        let sources = vec!["jiten:a".into(), "jiten:b".into()];
        let pin = Pin {
            word_id: 1246510,
            reading_index: None,
        };
        let ambiguous = db
            .find_with_pin(&sources, &["クズ"], "クズ", 0, Some(pin))
            .unwrap()
            .unwrap();
        assert_eq!(ambiguous.word_id, None);
        assert_eq!(ambiguous.known_state, vec![0]);
        let confirmed = db
            .find_with_pin(
                &sources,
                &["クズ"],
                "クズ",
                0,
                Some(Pin {
                    reading_index: Some(3),
                    ..pin
                }),
            )
            .unwrap()
            .unwrap();
        assert_eq!(confirmed.word_id, Some(1246510));
        assert_eq!(confirmed.reading_index, 3);
        assert_eq!(confirmed.known_state, vec![5]);
        assert!(db
            .find_with_pin(&sources, &["屑"], "ちり", 0, Some(pin))
            .unwrap()
            .is_none());
        assert!(db
            .find_with_pin(
                &sources,
                &["屑"],
                "くず",
                0,
                Some(Pin {
                    reading_index: Some(0),
                    ..pin
                })
            )
            .unwrap()
            .is_none());
        assert!(db
            .find_with_pin(
                &sources,
                &["屑"],
                "くず",
                0,
                Some(Pin {
                    word_id: 999,
                    reading_index: None
                })
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn snapshots_are_atomic_and_sources_are_isolated() {
        let mut db = Store::open(":memory:").unwrap();
        db.replace("jiten:a", vec![entry("猫", "ネコ", 5)]).unwrap();
        db.replace("anki:a", vec![entry("犬", "", 2)]).unwrap();
        assert!(db.replace("jiten:a", vec![entry("犬", "", 99)]).is_err());
        assert_eq!(
            db.find(&["jiten:a".into()], &["猫"], "ねこ", 0)
                .unwrap()
                .unwrap()
                .known_state,
            vec![5]
        );
        db.replace("jiten:a", vec![]).unwrap();
        assert!(db
            .find(&["jiten:a".into()], &["猫"], "ねこ", 0)
            .unwrap()
            .is_none());
        assert!(db
            .find(&["anki:a".into()], &["犬"], "いぬ", 0)
            .unwrap()
            .is_some());
    }

    #[test]
    fn readings_disambiguate_homographs_and_sources_have_explicit_precedence() {
        let mut db = Store::open(":memory:").unwrap();
        db.replace(
            "jiten:a",
            vec![entry("生", "なま", 5), entry("猫", "ねこ", 1)],
        )
        .unwrap();
        db.replace("anki:a", vec![entry("猫", "", 2)]).unwrap();
        let sources = vec!["jiten:a".into(), "anki:a".into()];
        assert!(db.find(&sources, &["生"], "せい", 0).unwrap().is_none());
        assert_eq!(
            db.find(&sources, &["猫"], "ネコ", 0)
                .unwrap()
                .unwrap()
                .known_state,
            vec![1]
        );
        assert_eq!(normalize_reading("ﾈｺ"), "ねこ");
    }

    #[test]
    fn due_states_advance_offline_and_suspended_words_do_not_become_due() {
        let mut db = Store::open(":memory:").unwrap();
        let mut cat = entry("猫", "ねこ", 2);
        cat.due_at = Some(100);
        let mut dog = entry("犬", "いぬ", 2);
        dog.known_state.push(7);
        dog.due_at = Some(100);
        db.replace("jiten:a", vec![cat, dog]).unwrap();
        let sources = vec!["jiten:a".into()];
        assert_eq!(
            db.find(&sources, &["猫"], "ねこ", 99)
                .unwrap()
                .unwrap()
                .known_state,
            vec![2]
        );
        assert_eq!(
            db.find(&sources, &["猫"], "ねこ", 100)
                .unwrap()
                .unwrap()
                .known_state,
            vec![2, 4]
        );
        assert_eq!(
            db.find(&sources, &["犬"], "いぬ", 100)
                .unwrap()
                .unwrap()
                .known_state,
            vec![2, 7]
        );
    }

    #[test]
    fn stored_identity_survives_restart_and_updates_only_its_account() {
        let path = std::env::temp_dir().join(format!(
            "gsm-vocabulary-test-{}-{}.sqlite3",
            std::process::id(),
            now()
        ));
        {
            let mut db = Store::open(&path).unwrap();
            let mut cat = entry("猫", "ねこ", 1);
            cat.word_id = Some(123);
            db.replace("jiten:a", vec![cat.clone()]).unwrap();
            db.replace("jiten:b", vec![cat]).unwrap();
            db.update_states(
                "jiten:a",
                vec![StateUpdate {
                    word_id: 123,
                    reading_index: 0,
                    known_state: vec![5],
                }],
            )
            .unwrap();
        }
        {
            let db = Store::open(&path).unwrap();
            assert_eq!(
                db.find(&["jiten:a".into()], &["猫"], "ねこ", 0)
                    .unwrap()
                    .unwrap()
                    .known_state,
                vec![5]
            );
            assert_eq!(
                db.find(&["jiten:b".into()], &["猫"], "ねこ", 0)
                    .unwrap()
                    .unwrap()
                    .known_state,
                vec![1]
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn duplicate_snapshot_rolls_back_the_delete_and_invalid_requests_are_bounded() {
        let mut db = Store::open(":memory:").unwrap();
        db.replace("test", vec![entry("猫", "ねこ", 5)]).unwrap();
        assert!(db
            .replace("test", vec![entry("犬", "いぬ", 1), entry("犬", "いぬ", 2)])
            .is_err());
        assert!(db
            .find(&["test".into()], &["猫"], "ねこ", 0)
            .unwrap()
            .is_some());
        assert!(Request::Parse {
            texts: vec!["a".repeat(256_001)],
            sources: vec![]
        }
        .validate()
        .is_err());
        assert!(Request::Status {
            sources: vec!["../bad".into()]
        }
        .validate()
        .is_err());
        let empty = db
            .execute(
                Request::Parse {
                    texts: vec![],
                    sources: vec![],
                },
                None,
            )
            .unwrap();
        assert_eq!(empty["tokens"], json!([]));
    }

    #[test]
    #[ignore = "requires GSM_TEST_SUDACHI_DICTIONARY pointing to an installed system dictionary"]
    fn real_sudachi_applies_jiten_rules_before_matching_saved_words() {
        let path = std::env::var("GSM_TEST_SUDACHI_DICTIONARY").unwrap();
        let dictionary = crate::load_sudachi_dictionary(Path::new(&path), &[]).unwrap();
        let mut db = Store::open(":memory:").unwrap();
        let mut scum = entry("屑", "くず", 5);
        scum.word_id = Some(1246510);
        scum.reading_index = 1;
        let mut arrowroot = entry("葛", "くず", 2);
        arrowroot.word_id = Some(999);
        let mut listen = entry("いいか", "いいか", 2);
        listen.word_id = Some(2555520);
        db.replace("jiten:test", vec![scum, arrowroot, listen])
            .unwrap();
        db.replace("anki:test", vec![entry("葛", "くず", 5)])
            .unwrap();
        let text = "😀 クズ。いいか！";
        let tokens = db
            .parse(dictionary.clone(), text, &["jiten:test".into()])
            .unwrap();
        let scum = tokens.iter().find(|t| t["word"] == "クズ").unwrap();
        assert_eq!(scum["wordId"], 1246510);
        assert_eq!(scum["readingIndex"], 1);
        assert_eq!(scum["knownState"], json!([5]));
        assert_eq!(scum["headword"], "屑");
        assert_eq!(scum["appliedRules"], json!(["kuzu"]));
        let listen = tokens.iter().find(|t| t["word"] == "いいか").unwrap();
        assert_eq!(listen["knownState"], json!([2]));
        assert_eq!(listen["appliedRules"], json!(["iika-listen"]));
        let no_match = db
            .parse(dictionary.clone(), "クズ", &["anki:test".into()])
            .unwrap();
        assert_eq!(no_match[0]["knownState"], json!([0]));
        assert_eq!(no_match[0]["wordId"], Value::Null);
        let empty = db.parse(dictionary, text, &[]).unwrap();
        assert_eq!(
            tokens.iter().map(|t| &t["word"]).collect::<Vec<_>>(),
            empty.iter().map(|t| &t["word"]).collect::<Vec<_>>()
        );
        let units: Vec<u16> = text.encode_utf16().collect();
        for token in tokens {
            assert_eq!(
                String::from_utf16(
                    &units[token["start"].as_u64().unwrap() as usize
                        ..token["end"].as_u64().unwrap() as usize]
                )
                .unwrap(),
                token["word"].as_str().unwrap()
            );
        }
    }

    #[test]
    #[ignore = "requires GSM_TEST_SUDACHI_DICTIONARY pointing to an installed system dictionary"]
    fn real_sudachi_matches_inflections_and_preserves_utf16_offsets() {
        let path = std::env::var("GSM_TEST_SUDACHI_DICTIONARY").unwrap();
        let dictionary = crate::load_sudachi_dictionary(Path::new(&path), &[]).unwrap();
        let mut db = Store::open(":memory:").unwrap();
        db.replace(
            "test",
            vec![entry("猫", "ねこ", 2), entry("食べる", "たべる", 5)],
        )
        .unwrap();
        let text = "😀 猫は食べた。\n猫";
        let tokens = db.parse(dictionary, text, &["test".into()]).unwrap();
        let cat = tokens.iter().find(|token| token["word"] == "猫").unwrap();
        assert_eq!(cat["start"], 3);
        assert_eq!(cat["end"], 4);
        assert_eq!(cat["knownState"], json!([2]));
        let verb = tokens
            .iter()
            .find(|token| token["headword"] == "食べる")
            .unwrap();
        assert_eq!(verb["knownState"], json!([5]));
        let units: Vec<u16> = text.encode_utf16().collect();
        for token in tokens {
            let start = token["start"].as_u64().unwrap() as usize;
            let end = token["end"].as_u64().unwrap() as usize;
            assert_eq!(
                String::from_utf16(&units[start..end]).unwrap(),
                token["word"].as_str().unwrap()
            );
        }
    }
}
