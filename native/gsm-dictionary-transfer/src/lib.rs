//! Transfer saved GSM Yomitan and Hachidori profiles to the desktop importer.
mod clone;
mod filesystem;
mod storage;
mod values;
pub use clone::{clone_chromium, CloneSummary};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};
use storage::{byte, integer, little, prefix, string, take, utf16};

pub fn identify(directory: &Path, kind: &str) -> Result<Option<String>> {
    let mut found = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.len() != 32
            || !id.bytes().all(|b| (b'a'..=b'p').contains(&b))
            || !entry.file_type()?.is_dir()
        {
            continue;
        }
        let db = storage::load(&entry.path(), false, &|_| {})?;
        let Some(raw) = record(&db, b"options")? else {
            continue;
        };
        let mut options: Value = serde_json::from_slice(&raw)?;
        if let Some(s) = options.as_str() {
            options = serde_json::from_str(s)?
        }
        if !options.is_object() {
            continue;
        }
        let matches = if options["profiles"].is_array() && options["profileCurrent"].is_i64() {
            kind == "yomitan"
        } else {
            kind=="hachidori" && db.query_row("SELECT EXISTS(SELECT 1 FROM records WHERE key IN (CAST('dictionaryState' AS BLOB),CAST('dictionaryUpdates' AS BLOB),CAST('languageSelection' AS BLOB)))",[],|r|r.get::<_,bool>(0))?
        };
        if matches {
            let mut latest = SystemTime::UNIX_EPOCH;
            for item in fs::read_dir(entry.path())? {
                let meta = item?.metadata()?;
                if meta.is_file() {
                    latest = latest.max(meta.modified()?)
                }
            }
            if found.as_ref().is_none_or(|(time, _)| latest > *time) {
                found = Some((latest, id))
            }
        }
    }
    Ok(found.map(|(_, id)| id))
}

pub(crate) fn record(db: &Connection, key: &[u8]) -> Result<Option<Vec<u8>>> {
    Ok(db
        .query_row("SELECT value FROM records WHERE key=?", [key], |r| r.get(0))
        .optional()?)
}

fn key_path(bytes: &[u8]) -> Result<Value> {
    if !bytes.starts_with(&[0, 0]) {
        return Ok(utf16(bytes, true)?.into());
    }
    let mut input = &bytes[2..];
    Ok(match byte(&mut input)? {
        0 => Value::Null,
        1 => string(&mut input)?.into(),
        2 => {
            let n = integer(&mut input)?;
            ensure!(n <= input.len() as u64, "Truncated key path");
            let mut keys = Vec::new();
            for _ in 0..n {
                keys.push(string(&mut input)?)
            }
            json!(keys)
        }
        _ => bail!("Unknown dictionary key path"),
    })
}
#[derive(Default)]
struct Store {
    props: BTreeMap<u8, Vec<u8>>,
    indexes: BTreeMap<u64, BTreeMap<u8, Vec<u8>>>,
}
#[derive(Default)]
struct Schema {
    name: String,
    version: u64,
    stores: BTreeMap<u64, Store>,
}

fn schemas(db: &Connection) -> Result<BTreeMap<u64, Schema>> {
    let mut schemas = BTreeMap::<u64, Schema>::new();
    let mut stmt = db.prepare("SELECT key,value FROM records WHERE kind=0 AND store=0")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let mut k = row.get_ref(0)?.as_blob()?;
        let (db, _, _) = prefix(&mut k)?;
        let Some((&tag, mut tail)) = k.split_first() else {
            continue;
        };
        let v = row.get_ref(1)?.as_blob()?;
        match (db, tag) {
            (0, 201) => {
                string(&mut tail)?;
                schemas.entry(little(v)?).or_default().name = string(&mut tail)?;
            }
            (1.., 4) => schemas.entry(db).or_default().version = integer(&mut &*v)?,
            (1.., 50 | 100) => {
                let store = schemas
                    .entry(db)
                    .or_default()
                    .stores
                    .entry(integer(&mut tail)?)
                    .or_default();
                let props = if tag == 50 {
                    &mut store.props
                } else {
                    store.indexes.entry(integer(&mut tail)?).or_default()
                };
                props.insert(byte(&mut tail)?, v.to_vec());
            }
            _ => {}
        }
    }
    Ok(schemas)
}

fn external(
    db: &Connection,
    id: u64,
    lookup: &[u8],
    index: u64,
    root: &Path,
) -> Result<values::External> {
    let raw = record(db, lookup)?.context("Missing dictionary media metadata")?;
    let mut data = raw.as_slice();
    for i in 0..=index {
        let kind = byte(&mut data)?;
        ensure!(kind <= 1, "Unknown external dictionary object");
        let n = integer(&mut data)?;
        let mime = string(&mut data)?;
        let size = integer(&mut data)?;
        if kind == 1 {
            string(&mut data)?;
            integer(&mut data)?;
        }
        if i == index {
            let path = root.join(format!("{id:x}/{:02x}/{n:x}", n >> 8));
            return Ok(values::External { path, mime, size });
        }
    }
    bail!("Unknown dictionary blob")
}

pub(crate) fn snapshot(roots: &[&Path]) -> Result<BTreeMap<PathBuf, (u64, SystemTime)>> {
    let mut result = BTreeMap::new();
    let mut stack: Vec<_> = roots
        .iter()
        .filter(|p| p.is_dir())
        .map(PathBuf::from)
        .collect();
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            ensure!(
                !ty.is_symlink(),
                "Dictionary snapshot contains a symbolic link"
            );
            if ty.is_dir() {
                stack.push(entry.path())
            } else if ty.is_file() && entry.file_name() != "LOCK" {
                let m = entry.metadata()?;
                result.insert(entry.path(), (m.len(), m.modified()?));
            }
        }
    }
    Ok(result)
}

pub(crate) struct Export<'a> {
    dir: &'a Path,
    databases: Vec<Value>,
    batches: Vec<Value>,
    records: u64,
    last_progress: std::time::Instant,
    progress: &'a dyn Fn(&str, u64),
}
impl Export<'_> {
    fn batch(&mut self, name: &str, store: &str, entries: &[u8], count: usize) -> Result<()> {
        let file = format!("batch-{:06}.json", self.batches.len());
        let mut out = BufWriter::new(fs::File::create_new(self.dir.join(&file))?);
        out.write_all(b"[")?;
        out.write_all(entries)?;
        out.write_all(b"]")?;
        out.flush()?;
        self.batches
            .push(json!({"database":name,"store":store,"file":file,"count":count}));
        self.records += count as u64;
        if self.last_progress.elapsed() >= std::time::Duration::from_secs(1) {
            (self.progress)("exporting", self.records);
            self.last_progress = std::time::Instant::now();
        }
        Ok(())
    }
    fn store(
        &mut self,
        db: &Connection,
        id: u64,
        sid: u64,
        name: &str,
        store: &str,
        blobs: &Path,
    ) -> Result<usize> {
        let mut stmt = db.prepare(
            "SELECT key,value FROM records WHERE db=?1 AND store=?2 AND kind=1 ORDER BY key",
        )?;
        let mut rows = stmt.query([id, sid])?;
        let mut bytes = Vec::new();
        let (mut total, mut count) = (0, 0);
        while let Some(row) = rows.next()? {
            let key = row.get_ref(0)?.as_blob()?;
            let mut tail = key;
            prefix(&mut tail)?;
            let mut lookup = key.to_vec();
            lookup[key.len() - tail.len() - 1] = 3;
            let key = values::key(&mut tail, self.dir, 0)?;
            let mut data = row.get_ref(1)?.as_blob()?;
            integer(&mut data)?;
            let value = values::decode(
                data,
                self.dir,
                &|index| external(db, id, &lookup, index, blobs),
                0,
            )?;
            if count > 0 {
                bytes.push(b',')
            }
            let entry = Value::Object(
                [("key".into(), key), ("value".into(), value)]
                    .into_iter()
                    .collect(),
            );
            serde_json::to_writer(&mut bytes, &entry)?;
            total += 1;
            count += 1;
            if count == 500 || bytes.len() >= 1_048_576 {
                self.batch(name, store, &bytes, count)?;
                bytes.clear();
                count = 0;
            }
        }
        if count > 0 {
            self.batch(name, store, &bytes, count)?
        }
        Ok(total)
    }
    fn database(&mut self, db: &Connection, blobs: &Path) -> Result<()> {
        for (id, schema) in schemas(db)? {
            if schema.name.is_empty() {
                continue;
            }
            let mut stores = Vec::new();
            for (sid, s) in schema.stores {
                let Some(raw) = s.props.get(&0) else { continue };
                let name = utf16(raw, true)?;
                let count = self.store(db, id, sid, &schema.name, &name, blobs)?;
                let mut indexes = Vec::new();
                for p in s.indexes.values() {
                    if let Some(name) = p.get(&0) {
                        indexes.push(json!({"name":utf16(name,true)?,"keyPath":p.get(&2).map(|v|key_path(v)).transpose()?,"unique":p.get(&1).is_some_and(|v|v==&[1]),"multiEntry":p.get(&3).is_some_and(|v|v==&[1])}));
                    }
                }
                stores.push(json!({"id":sid,"name":name,"keyPath":s.props.get(&1).map(|v|key_path(v)).transpose()?,
                    "autoIncrement":s.props.get(&2).is_some_and(|v|v==&[1]),"nextKey":s.props.get(&7).map(|v|little(v)).transpose()?.unwrap_or(0),"count":count,"indexes":indexes}));
            }
            self.databases.push(
                json!({"id":id,"name":schema.name,"version":schema.version.max(1),"stores":stores}),
            );
        }
        Ok(())
    }
}

pub fn export(
    source: &Path,
    settings: &Path,
    filesystem: Option<&Path>,
    destination: &Path,
    progress: &dyn Fn(&str, u64),
) -> Result<()> {
    ensure!(
        source.is_dir() || settings.is_dir(),
        "No saved dictionary was found"
    );
    ensure!(
        !destination.exists(),
        "Dictionary transfer destination is already in use"
    );
    let parent = destination.parent().context("Missing transfer directory")?;
    let staging = tempfile::tempdir_in(parent)?;
    let dir = staging.path();
    fs::create_dir(dir.join("blobs"))?;
    let blobs = source.with_extension("blob");
    let mut roots = vec![source, settings, &blobs];
    roots.extend(filesystem);
    let before = snapshot(&roots)?;
    let mut out = Export {
        dir,
        databases: Vec::new(),
        batches: Vec::new(),
        records: 0,
        last_progress: std::time::Instant::now(),
        progress,
    };
    if source.is_dir() {
        let db = storage::load(source, true, &|records| progress("reading", records))?;
        progress("exporting", 0);
        out.database(&db, &blobs)?;
    }
    let mut storage = Map::new();
    if settings.is_dir() {
        let db = storage::load(settings, false, &|_| {})?;
        let mut stmt = db.prepare("SELECT key,value FROM records")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            storage.insert(
                std::str::from_utf8(row.get_ref(0)?.as_blob()?)?.into(),
                serde_json::from_slice(row.get_ref(1)?.as_blob()?)?,
            );
        }
    }
    if let Some(files) = filesystem {
        let origin = source
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_suffix(".indexeddb.leveldb"))
            .context("Invalid dictionary origin")?;
        filesystem::export(&mut out, files, origin)?
    }
    ensure!(
        before == snapshot(&roots)?,
        "Saved dictionaries changed during transfer. Close the older app and retry."
    );
    let mut manifest = json!({"format":1,"snapshotId":uuid::Uuid::new_v4().simple().to_string(),"databases":out.databases,"batches":out.batches,"storage":storage});
    if filesystem.is_some() {
        manifest["filesystemVersion"] = 1.into()
    }
    fs::write(dir.join("manifest.json"), serde_json::to_vec(&manifest)?)?;
    fs::rename(dir, destination)?;
    Ok(())
}
