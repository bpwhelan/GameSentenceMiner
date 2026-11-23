use super::{
    client::{HttpError, Remote},
    Sync,
};
use crate::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use gsm_history::kechimochi::{digest, metadata, spaced_json, Media, Snapshot};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

type Fields = Map<String, Value>;
fn fields(v: &Value) -> Fields {
    match v {
        Value::Object(m) => m.clone(),
        Value::String(s) => serde_json::from_str(s).unwrap_or_default(),
        _ => Fields::new(),
    }
}
fn marker(row: &Value) -> Fields {
    fields(
        &fields(&row["extra_data"])
            .remove("gsm_sync")
            .unwrap_or_default(),
    )
}

fn marker_text(v: &str) -> Option<(&str, &str)> {
    let (source, key) = v
        .strip_prefix("[GSM sync:")?
        .strip_suffix(']')?
        .split_once(':')?;
    let hex = |s: &str, n| {
        s.len() == n
            && s.bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
    };
    (hex(source, 32) && hex(key, 64)).then_some((source, key))
}
fn owned_log<'a>(row: &'a Value, source: &str) -> Result<Option<&'a str>> {
    let mut keys = row["notes"]
        .as_str()
        .unwrap_or("")
        .split('\n')
        .filter_map(marker_text)
        .filter_map(|(s, k)| (s == source).then_some(k));
    let key = keys.next();
    if keys.next().is_some() {
        return Err("A Kechimochi log has multiple GSM ownership markers".into());
    }
    Ok(key)
}
fn insert_owned(index: &mut HashMap<String, usize>, key: &str, i: usize) -> Result<()> {
    if !key.is_empty() && index.insert(key.to_owned(), i).is_some() {
        return Err(
            "Kechimochi contains duplicate GSM ownership markers; resolve the duplicates first"
                .into(),
        );
    }
    Ok(())
}
fn fingerprint(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        digest(s)
    } else {
        digest(v.to_string())
    }
}
fn empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Bool(b) => !*b,
        Value::Number(n) => n.as_f64() == Some(0.),
        Value::Array(a) => a.is_empty(),
        Value::Object(m) => m.is_empty(),
    }
}
fn merge(existing: &Value, desired: &Media, previous: &Value) -> (Fields, String, Value) {
    let mut extra = fields(&existing["extra_data"]);
    metadata::migrate(&mut extra);
    let old = fields(&previous["fields"]);
    let mut hashes = Fields::new();
    for (name, value) in &desired.extra_data {
        let lower = name.to_lowercase();
        let hash = fingerprint(value);
        let remote = extra
            .keys()
            .find(|k| k.to_lowercase() == lower)
            .cloned()
            .unwrap_or_else(|| name.clone());
        if extra.get(&remote).is_none_or(empty) || old.get(&lower).is_some_and(|last| last != &hash)
        {
            extra.insert(remote, value.clone());
        }
        hashes.insert(lower, hash.into());
    }
    for (name, hash) in old {
        if !hashes.contains_key(&name) {
            let remove = extra
                .iter()
                .find(|(k, v)| k.to_lowercase() == name && hash == fingerprint(v))
                .map(|(k, _)| k.clone());
            if let Some(key) = remove {
                extra.remove(&key);
            }
        }
    }
    let mut desc = existing["description"].as_str().unwrap_or("");
    let hash = digest(&desired.description);
    let old_desc = previous["description"].as_str();
    if (desc.is_empty() || old_desc.is_some_and(|x| x != hash))
        && (!desired.description.is_empty() || old_desc.is_some_and(|x| x == digest(desc)))
    {
        desc = &desired.description;
    }
    (
        extra,
        desc.into(),
        json!({"fields":hashes,"description":hash}),
    )
}
fn serialize(extra: &Fields, marker: &Fields) -> Result<String> {
    let mut marker = Value::Object(marker.clone());
    marker.sort_all_objects();
    let mut result = Value::Object(extra.clone());
    result["gsm_sync"] = spaced_json(&marker)?.into();
    result.sort_all_objects();
    spaced_json(&result)
}
fn differs(existing: &Value, payload: &Value) -> bool {
    payload
        .as_object()
        .unwrap()
        .iter()
        .any(|(k, v)| existing.get(k).unwrap_or(&Value::Null) != v)
}
fn count(result: &mut Value, key: &str) {
    result[key] = (result[key].as_u64().unwrap_or(0) + 1).into();
}
struct Library {
    rows: Vec<Value>,
    titles: HashMap<String, Vec<usize>>,
    owned: HashMap<String, usize>,
    covers: bool,
}
impl Library {
    fn new(rows: Vec<Value>, work: &Sync) -> Result<Self> {
        let mut titles = HashMap::<_, Vec<_>>::new();
        let mut owned = HashMap::new();
        for (i, row) in rows.iter().enumerate() {
            let mark = marker(row);
            if mark.get("source").is_some_and(|v| v == &work.source) {
                if let Some(key) = mark.get("key").and_then(Value::as_str) {
                    insert_owned(&mut owned, key, i)?;
                }
            }
            if let Some(title) = row["title"].as_str() {
                titles.entry(title.to_owned()).or_default().push(i);
            }
        }
        Ok(Self {
            rows,
            titles,
            owned,
            covers: work.settings.sync_covers,
        })
    }
    fn upsert(
        &mut self,
        remote: &Remote,
        work: &Sync,
        key: &str,
        desired: &Media,
        language: &str,
        result: &mut Value,
    ) -> Result<u64> {
        let hash = digest(key);
        let same_title = self
            .titles
            .get(&desired.title)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let index = self.owned.get(&hash).copied().or_else(|| {
            let mut matches = same_title.iter().copied().filter(|&i| {
                let row = &self.rows[i];
                empty(&row["variant"])
                    && row["language"] == language
                    && row["content_type"].as_str().is_some_and(|s| {
                        s.is_empty() || s == "Unknown" || s == desired.content_type
                    })
                    && !fields(&row["extra_data"]).contains_key("gsm_sync")
            });
            let first = matches.next()?;
            matches.next().is_none().then_some(first)
        });
        let existing = index.map(|i| &self.rows[i]).unwrap_or(&Value::Null);
        let mut variant = existing
            .get("variant")
            .cloned()
            .unwrap_or_else(|| "".into());
        if same_title.iter().any(|&i| {
            Some(i) != index
                && self.rows[i]
                    .get("variant")
                    .map_or(variant == "", |s| s == &variant)
        }) {
            variant = format!("GSM {}", &hash[..10]).into();
        }
        let mut mark = marker(existing);
        mark.insert("source".into(), work.source.clone().into());
        mark.insert("key".into(), hash.clone().into());
        let metadata_key = format!("metadata:{}:{hash}", work.destination);
        let previous = work
            .reports
            .history
            .kechimochi_state(&work.reports.database, &metadata_key)?
            .unwrap_or_default();
        let (extra, desc, state) = merge(existing, desired, &previous);
        let mut payload = json!(desired);
        payload["language"] = language.into();
        payload["description"] = desc.into();
        payload["variant"] = variant;
        payload["uid"] = if index.is_some() {
            existing["uid"].clone()
        } else {
            Uuid::new_v5(&work.namespace, key.as_bytes())
                .to_string()
                .into()
        };
        payload["cover_image"] = existing
            .get("cover_image")
            .cloned()
            .unwrap_or_else(|| "".into());
        payload["extra_data"] = serialize(&extra, &mark)?.into();
        let (id, i) = if let Some(i) = index {
            let id = existing["id"].as_u64().unwrap();
            if differs(existing, &payload) {
                work.check()?;
                remote.save("media", &mut payload, Some(id))?;
                if existing["title"] != desired.title {
                    if let Some(old) = existing["title"]
                        .as_str()
                        .and_then(|s| self.titles.get_mut(s))
                    {
                        old.retain(|v| *v != i);
                    }
                    self.titles
                        .entry(desired.title.clone())
                        .or_default()
                        .push(i);
                }
                self.rows[i]
                    .as_object_mut()
                    .unwrap()
                    .extend(payload.as_object().unwrap().clone());
                count(result, "media_updated");
            }
            (id, i)
        } else {
            work.check()?;
            let id = remote.save("media", &mut payload, None)?;
            payload["id"] = id.into();
            let i = self.rows.len();
            self.rows.push(payload.clone());
            self.titles
                .entry(desired.title.clone())
                .or_default()
                .push(i);
            count(result, "media_created");
            (id, i)
        };
        if previous != state {
            work.save(&metadata_key, &state)?;
        }
        if let Some(game) = desired.cover_game.as_deref().filter(|_| self.covers) {
            if let Some(raw) = work
                .reports
                .history
                .kechimochi_cover(&work.reports.database, game)?
                .filter(|s| !s.is_empty())
            {
                let encoded = raw
                    .strip_prefix("data:")
                    .and_then(|s| s.split_once(','))
                    .map_or(raw.as_str(), |(_, s)| s);
                match STANDARD.decode(encoded) {
                    Err(_) => result["warnings"].as_array_mut().unwrap().push(
                        format!("Could not decode the GSM cover for {}.", desired.title).into(),
                    ),
                    Ok(bytes) => {
                        let sha = digest(&bytes);
                        if mark.get("cover_sha256").is_none_or(|v| v != &sha)
                            || empty(&payload["cover_image"])
                        {
                            work.check()?;
                            match remote.cover(id, bytes) {
                                Ok(path) => {
                                    mark.insert("cover_sha256".into(), sha.into());
                                    payload["cover_image"] = path.into();
                                    payload["extra_data"] = serialize(&extra, &mark)?.into();
                                    work.check()?;
                                    remote.save("media", &mut payload, Some(id))?;
                                    self.rows[i]
                                        .as_object_mut()
                                        .unwrap()
                                        .extend(payload.as_object().unwrap().clone());
                                    count(result, "covers_uploaded");
                                }
                                Err(e)
                                    if e.downcast_ref::<HttpError>()
                                        .is_some_and(|err| matches!(err.code, 403 | 404)) =>
                                {
                                    self.covers = false;
                                    result["warnings"].as_array_mut().unwrap().push("Stats synced. Enable Full HTTP API scope in Kechimochi to sync covers too.".into());
                                }
                                Err(e) => return Err(e),
                            }
                        }
                    }
                }
            }
        }
        Ok(id)
    }
}

type Imported = (u64, String, i64, i64);
fn imported(row: &Value) -> Option<Imported> {
    Some((
        row["media_id"].as_u64()?,
        row["date"].as_str()?.into(),
        row["characters"].as_i64()?,
        row["duration_minutes"].as_i64()?,
    ))
}
pub(super) fn sync(
    work: &Sync,
    remote: &Remote,
    snapshot: &Snapshot,
    mut report: impl FnMut(usize, usize, &str) -> Result<()>,
) -> Result<Value> {
    let mut library = Library::new(remote.list("media")?, work)?;
    let logs = remote.list("logs")?;
    let mut owned = HashMap::new();
    let mut adoptions = HashMap::<Imported, Vec<usize>>::new();
    for (i, row) in logs.iter().enumerate() {
        if let Some(key) = owned_log(row, &work.source)? {
            insert_owned(&mut owned, key, i)?;
        } else if work.settings.adopt_matching_logs
            && row["notes"].as_str().unwrap_or("").trim().is_empty()
        {
            if let Some(k) = imported(row) {
                adoptions.entry(k).or_default().push(i);
            }
        }
    }
    let mut result = snapshot.summary();
    result["success"] = true.into();
    result["warnings"] = json!([]);
    for key in [
        "media_created",
        "media_updated",
        "logs_created",
        "logs_updated",
        "logs_deleted",
        "logs_adopted",
        "covers_uploaded",
    ] {
        result[key] = 0.into();
    }
    let total = snapshot.media.len() + snapshot.logs.len() + owned.len();
    let mut n = 0;
    let mut media_ids = HashMap::with_capacity(snapshot.media.len());
    for (key, media) in &snapshot.media {
        media_ids.insert(
            key.as_str(),
            library.upsert(remote, work, key, media, &snapshot.language, &mut result)?,
        );
        n += 1;
        report(n, total, "Syncing media library")?;
    }
    let mut claimed = HashSet::new();
    let mut wanted = HashSet::new();
    for (key, log) in &snapshot.logs {
        let hash = digest(key);
        let media = &snapshot.media[&log.media_key];
        let id = media_ids[log.media_key.as_str()];
        let mut payload = json!(log);
        payload.as_object_mut().unwrap().remove("media_key");
        payload["media_id"] = id.into();
        let owned_row = owned.get(&hash).copied();
        let mut index = owned_row;
        if index.is_none() && work.settings.adopt_matching_logs {
            let mut choices = adoptions
                .get(&(id, log.date.clone(), log.characters, log.duration_minutes))
                .into_iter()
                .flatten()
                .copied()
                .filter(|i| {
                    let activity = logs[*i]["activity_type"].as_str();
                    !claimed.contains(i)
                        && activity.is_some_and(|a| {
                            [
                                log.activity_type,
                                media.content_type,
                                &media.legacy_activity,
                                "",
                            ]
                            .contains(&a)
                        })
                });
            if let Some(i) = choices.next() {
                if choices.next().is_some() {
                    return Err("Multiple existing Kechimochi logs match one GSM activity. Resolve them before adopting CSV imports.".into());
                }
                claimed.insert(i);
                index = Some(i);
                count(&mut result, "logs_adopted");
            }
        }
        let existing = index.map(|i| &logs[i]).unwrap_or(&Value::Null);
        payload["notes"] = if owned_row.is_some() {
            existing["notes"].clone()
        } else {
            format!("[GSM sync:{}:{hash}]", work.source).into()
        };
        if index.is_none() || differs(existing, &payload) {
            work.check()?;
            remote.save("logs", &mut payload, existing["id"].as_u64())?;
            count(
                &mut result,
                if index.is_none() {
                    "logs_created"
                } else {
                    "logs_updated"
                },
            );
        }
        wanted.insert(hash);
        n += 1;
        report(n, total, "Syncing daily activity")?;
    }
    // Only previously owned logs may be deleted, after every desired upsert succeeded.
    let mut owned: Vec<_> = owned.into_iter().collect();
    owned.sort_unstable_by_key(|(_, i)| *i);
    for (key, i) in owned {
        if !wanted.contains(&key) {
            work.check()?;
            remote.remove(logs[i]["id"].as_u64().unwrap())?;
            count(&mut result, "logs_deleted");
        }
        n += 1;
        report(n, total, "Reconciling removed activity")?;
    }
    Ok(result)
}
