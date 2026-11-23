//! Import the JSON frequency sources shipped with the word statistics page.
//! Reading JSON and sorting words precede the transaction that publishes ranks.
use crate::Result;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{value::RawValue, Value};
use std::{
    fs,
    io::{ErrorKind, Read},
    path::Path,
};

pub const DIRECTORY: &str = "GameSentenceMiner/web/templates/components/word_frequency_sources";

#[derive(Default, Deserialize)]
#[serde(default)]
struct Header {
    id: Value,
    name: Value,
    version: Value,
    source: Value,
    source_url: Value,
    default: Value,
    max_rank: Value,
    entry_count: Value,
}

#[derive(Clone, Debug, PartialEq)]
struct Source {
    id: String,
    name: String,
    version: String,
    url: String,
    default: bool,
    max_rank: i64,
    count: i64,
}

fn text(v: &Value, fallback: &str) -> String {
    match v {
        Value::String(s) if !s.is_empty() => s.trim().to_owned(),
        Value::Number(n) if n.as_f64() != Some(0.) => n.to_string(),
        Value::Bool(true) => "True".into(),
        _ => fallback.to_owned(),
    }
}

fn integer(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|x| x.abs() < i64::MAX as f64)
                .map(|x| x as i64)
        }),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(i64::from(*b)),
        _ => None,
    }
}

impl Header {
    fn source(self, path: &Path) -> Source {
        let id = text(
            &self.id,
            path.file_stem().and_then(|v| v.to_str()).unwrap_or(""),
        );
        Source {
            name: text(&self.name, &id),
            id,
            version: text(&self.version, "1"),
            url: text(&self.source, &text(&self.source_url, "")),
            default: match self.default {
                Value::String(s) => !s.is_empty(),
                Value::Number(n) => n.as_f64() != Some(0.),
                Value::Bool(b) => b,
                _ => false,
            },
            max_rank: integer(&self.max_rank).unwrap_or(0),
            count: integer(&self.entry_count).unwrap_or(0),
        }
    }
}

#[derive(Deserialize)]
struct Payload<'a> {
    #[serde(borrow)]
    entries: Vec<&'a RawValue>,
}

fn entries(bytes: &[u8]) -> Result<Vec<(String, i64)>> {
    let payload: Payload = serde_json::from_slice(bytes)?;
    let mut rows = Vec::with_capacity(payload.entries.len());
    for row in payload.entries {
        let (mut word, rank) = if let Ok(pair) = serde_json::from_str::<(String, i64)>(row.get()) {
            pair
        } else if let Ok((word, rank)) = serde_json::from_str::<(Value, Value)>(row.get()) {
            let Some(rank) = integer(&rank) else { continue };
            (text(&word, ""), rank)
        } else {
            continue;
        };
        if rank <= 0 || word.trim().is_empty() {
            continue;
        }
        if word.len() != word.trim().len() {
            word = word.trim().to_owned();
        }
        rows.push((word, rank));
    }
    rows.sort_unstable();
    rows.dedup_by(|a, b| a.0 == b.0);
    Ok(rows)
}

fn installed(conn: &Connection, id: &str) -> Result<Option<(Source, bool)>> {
    Ok(conn
        .query_row(
            "SELECT name,version,coalesce(source_url,''),is_default,max_rank,entry_count,
        EXISTS(SELECT 1 FROM word_global_frequencies WHERE source_id=?1)
        FROM global_frequency_sources WHERE id=?1",
            [id],
            |r| {
                Ok((
                    Source {
                        id: id.to_owned(),
                        name: r.get(0)?,
                        version: r.get(1)?,
                        url: r.get(2)?,
                        default: r.get(3)?,
                        max_rank: r.get(4)?,
                        count: r.get(5)?,
                    },
                    r.get(6)?,
                ))
            },
        )
        .optional()?)
}

fn has_schema(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='global_frequency_sources')",
        [],
        |r| r.get(0),
    )
}

struct Update {
    source: Source,
    rows: Option<Vec<(String, i64)>>,
}
#[derive(Default)]
pub struct Prepared {
    sources: Vec<Update>,
    skipped_file: bool,
}

// The shipped format puts its complete manifest before the large entries
// array. Validate the prefix as a JSON object, so strings or nested members
// cannot be mistaken for its top-level entries key. Other layouts use serde
// on the complete document, including metadata placed after the entries.
fn read_header(path: &Path) -> Result<(Source, Option<Vec<u8>>)> {
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    (&mut file).take(4096).read_to_end(&mut bytes)?;
    let key = br#""entries""#;
    if let Some(at) = bytes.windows(key.len()).position(|w| w == key) {
        let mut prefix = bytes[..at].to_vec();
        prefix.extend_from_slice(br#""entries":null}"#);
        if let Ok(header) = serde_json::from_slice::<Header>(&prefix) {
            if header.id.is_string()
                && header.version.is_string()
                && header.name.is_string()
                && header.default.is_boolean()
                && header.entry_count.is_number()
                && header.max_rank.is_number()
                && (header.source_url.is_string() || header.source.is_string())
            {
                return Ok((header.source(path), None));
            }
        }
    }
    file.read_to_end(&mut bytes)?;
    Ok((
        serde_json::from_slice::<Header>(&bytes)?.source(path),
        Some(bytes),
    ))
}

fn read_source(conn: &Connection, path: &Path) -> Result<Option<Update>> {
    let (mut source, payload) = read_header(path)?;
    if source.id.is_empty() {
        return Ok(None);
    }
    if let Some((prior, true)) = installed(conn, &source.id)? {
        if source.version == prior.version && (source.count <= 0 || source.count == prior.count) {
            if source.count <= 0 {
                source.count = prior.count;
            }
            if source.max_rank <= 0 {
                source.max_rank = prior.max_rank;
            }
            return Ok(Some(Update { source, rows: None }));
        }
    }
    let bytes = match payload {
        Some(bytes) => bytes,
        None => fs::read(path)?,
    };
    source = serde_json::from_slice::<Header>(&bytes)?.source(path);
    let rows = entries(&bytes)?;
    if rows.is_empty() {
        return Ok(None);
    }
    source.count = rows.len() as i64;
    if source.max_rank <= 0 {
        source.max_rank = rows.iter().map(|r| r.1).max().unwrap_or(0);
    }
    Ok(Some(Update {
        source,
        rows: Some(rows),
    }))
}

pub fn prepare(conn: &Connection, directory: &Path) -> Result<Prepared> {
    let mut prepared = Prepared::default();
    if !has_schema(conn)? {
        return Ok(prepared);
    }
    let files = match fs::read_dir(directory) {
        Ok(files) => files,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(prepared),
        Err(e) => return Err(e.into()),
    };
    let mut paths = Vec::new();
    for file in files {
        let path = file?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            paths.push(path);
        }
    }
    paths.sort_unstable();
    for path in paths {
        match read_source(conn, &path) {
            Ok(Some(source)) => prepared.sources.push(source),
            Ok(None) => prepared.skipped_file = true,
            Err(e) if e.is::<serde_json::Error>() || e.is::<std::io::Error>() => {
                prepared.skipped_file = true;
                eprintln!("Skipping frequency source {}: {e}", path.display())
            }
            Err(e) => return Err(e),
        }
    }
    Ok(prepared)
}

pub fn sync(conn: &mut Connection, directory: &Path) -> Result<usize> {
    prepare(conn, directory)?.apply(conn)
}

impl Prepared {
    pub fn apply(self, conn: &mut Connection) -> Result<usize> {
        if self.sources.is_empty() {
            return Ok(0);
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !has_schema(&tx)? {
            return Ok(0);
        }
        let declared = self.sources.iter().find(|s| s.source.default);
        let active = if let Some(update) = declared {
            update.source.id.clone()
        } else if self.skipped_file {
            // An unreadable replacement must not move cached ranks to a
            // different dictionary while the previous default remains usable.
            tx.query_row("SELECT id FROM global_frequency_sources WHERE is_default=1 ORDER BY name,id LIMIT 1",[],|r|r.get(0))
                .optional()?.unwrap_or_else(|| self.sources[0].source.id.clone())
        } else {
            self.sources[0].source.id.clone()
        };
        let mut ranks_changed = tx.execute(
            "UPDATE global_frequency_sources SET is_default=0 WHERE is_default!=0 AND id!=?",
            [&active],
        )? != 0;
        let mut refreshed = 0;
        for Update { mut source, rows } in self.sources {
            source.default = source.id == active;
            let prior = installed(&tx, &source.id)?;
            let current = prior.as_ref().is_some_and(|(v, has)| {
                *has && v.version == source.version && v.count == source.count
            });
            if !current {
                let rows =
                    rows.ok_or("Frequency source changed while its import was being prepared")?;
                publish_rows(&tx, &source.id, &rows)?;
                refreshed += 1;
            } else if prior.as_ref().is_some_and(|(v, _)| v == &source) {
                continue;
            }
            if source.default && (!current || !prior.is_some_and(|(v, _)| v.default)) {
                ranks_changed = true;
            }
            tx.execute("INSERT INTO global_frequency_sources(id,name,version,source_url,is_default,max_rank,entry_count,synced_at)
                VALUES(?,?,?,?,?,?,?,unixepoch('subsec')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,
                source_url=excluded.source_url,is_default=excluded.is_default,max_rank=excluded.max_rank,entry_count=excluded.entry_count,synced_at=excluded.synced_at",
                params![source.id,source.name,source.version,source.url,source.default,source.max_rank,source.count])?;
        }
        tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_word_global_frequencies_rank ON word_global_frequencies(source_id,rank)")?;
        if ranks_changed {
            tx.execute("UPDATE word_stats_cache SET active_global_rank=(SELECT f.rank FROM words w
                JOIN word_global_frequencies f ON f.word=w.word AND f.source_id=? WHERE w.id=word_stats_cache.word_id)",[active])?;
        }
        tx.commit()?;
        Ok(refreshed)
    }
}

fn publish_rows(conn: &Connection, source: &str, rows: &[(String, i64)]) -> Result<()> {
    // Both sequences are in SQLite BINARY order. Finish the cursor before
    // writing to its table. Most words survive dictionary version upgrades.
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut next = 0;
    {
        let mut query=conn.prepare("SELECT word,rank FROM word_global_frequencies WHERE source_id=? ORDER BY word COLLATE BINARY")?;
        let mut old = query.query([source])?;
        while let Some(row) = old.next()? {
            let word = row.get_ref(0)?.as_str()?;
            while next < rows.len() && rows[next].0.as_str() < word {
                changed.push(next);
                next += 1;
            }
            if next < rows.len() && rows[next].0 == word {
                if rows[next].1 != row.get::<_, i64>(1)? {
                    changed.push(next);
                }
                next += 1;
            } else {
                removed.push(word.to_owned());
            }
        }
    }
    let mut delete =
        conn.prepare("DELETE FROM word_global_frequencies WHERE source_id=? AND word=?")?;
    for word in removed {
        delete.execute(params![source, word])?;
    }
    let mut upsert = conn.prepare(
        "INSERT INTO word_global_frequencies(source_id,word,rank) VALUES(?,?,?)
        ON CONFLICT(source_id,word) DO UPDATE SET rank=excluded.rank",
    )?;
    for index in changed.into_iter().chain(next..rows.len()) {
        let (word, rank) = &rows[index];
        upsert.execute(params![source, word, rank])?;
    }
    Ok(())
}
