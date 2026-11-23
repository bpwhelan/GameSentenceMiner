//! Chromium's origin-private filesystem used by the older Hachidori extension.
use super::*;
use std::collections::{BTreeSet, HashMap};

struct Entry {
    parent: u64,
    data: String,
    name: String,
    time: u64,
}
fn text(input: &mut &[u8]) -> Result<String> {
    let len = usize::try_from(little(take(input, 4)?)?)?;
    let value = std::str::from_utf8(take(input, len)?)?.to_owned();
    take(input, (4 - len % 4) % 4)?;
    Ok(value)
}
fn entries(db: &Connection) -> Result<HashMap<u64, Entry>> {
    let mut entries = HashMap::new();
    let mut stmt = db.prepare("SELECT key,value FROM records")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let key = row.get_ref(0)?.as_blob()?;
        if key.is_empty() || !key.iter().all(u8::is_ascii_digit) {
            continue;
        }
        let id = std::str::from_utf8(key)?.parse()?;
        let mut input = row.get_ref(1)?.as_blob()?;
        let len = little(take(&mut input, 4)?)?;
        ensure!(input.len() as u64 == len, "Invalid saved filesystem record");
        let parent = little(take(&mut input, 8)?)?;
        let data = text(&mut input)?;
        let name = text(&mut input)?;
        let time = little(take(&mut input, 8)?)?;
        entries.insert(
            id,
            Entry {
                parent,
                data,
                name,
                time,
            },
        );
    }
    Ok(entries)
}
fn logical_name(mut id: u64, entries: &HashMap<u64, Entry>) -> Result<String> {
    let mut visited = BTreeSet::new();
    let mut parts = Vec::new();
    while id != 0 {
        ensure!(visited.insert(id), "Cyclic dictionary filesystem hierarchy");
        let entry = entries
            .get(&id)
            .context("Missing dictionary filesystem parent")?;
        ensure!(
            !entry.name.is_empty()
                && !matches!(entry.name.as_str(), "." | "..")
                && !entry.name.contains(['/', '\\', '\0']),
            "Invalid dictionary filename"
        );
        parts.push(entry.name.as_str());
        id = entry.parent;
    }
    parts.reverse();
    Ok(format!("/dicts/{}", parts.join("/")))
}
pub(super) fn export(out: &mut Export<'_>, source: &Path, origin: &str) -> Result<()> {
    if !source.join("Origins").is_dir() {
        return Ok(());
    }
    let origins = storage::load(&source.join("Origins"), false, &|_| {})?;
    let Some(folder) = record(&origins, format!("ORIGIN:{origin}").as_bytes())? else {
        return Ok(());
    };
    ensure!(
        !folder.is_empty() && folder.iter().all(u8::is_ascii_digit),
        "Invalid dictionary origin"
    );
    ensure!(
        !out.databases.iter().any(|d| d["name"] == "/dicts"),
        "Conflicting saved dictionary filesystems"
    );
    let root = source.canonicalize()?;
    let folder = root.join(std::str::from_utf8(&folder)?);
    let mut names = BTreeSet::new();
    for kind in ["t", "p"] {
        let base = folder.join(kind);
        if !base.join("Paths").is_dir() {
            continue;
        }
        let base = base.canonicalize()?;
        ensure!(
            base.starts_with(&root),
            "Invalid dictionary filesystem directory"
        );
        let db = storage::load(&base.join("Paths"), false, &|_| {})?;
        let records = entries(&db)?;
        for (&id, entry) in &records {
            if id == 0 {
                continue;
            }
            let name = logical_name(id, &records)?;
            ensure!(names.insert(name.clone()), "Duplicate dictionary filename");
            let time = (i64::try_from(entry.time)? - 11_644_473_600_000_000) as f64 / 1000.;
            let mut props = vec![
                json!(["timestamp", values::date(time)?]),
                json!([
                    "mode",
                    if entry.data.is_empty() {
                        0o40755
                    } else {
                        0o100644
                    }
                ]),
            ];
            if !entry.data.is_empty() {
                let data = base.join(entry.data.replace('\\', "/")).canonicalize()?;
                ensure!(
                    data.starts_with(&base) && data.is_file(),
                    "Invalid saved dictionary data path"
                );
                props.push(json!([
                    "contents",
                    values::binary(out.dir, fs::File::open(data)?, "Uint8Array")?
                ]));
            }
            let row = json!({"key":name,"value":{"$gsm":"object","value":props}});
            out.batch("/dicts", "FILE_DATA", &serde_json::to_vec(&row)?, 1)?;
        }
    }
    if !names.is_empty() {
        out.databases.push(json!({"name":"/dicts","version":21,"stores":[{"name":"FILE_DATA","keyPath":null,"autoIncrement":false,"count":names.len(),"indexes":[{"name":"timestamp","keyPath":"timestamp","unique":false,"multiEntry":false}]}]}));
    }
    Ok(())
}
