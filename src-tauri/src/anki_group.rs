//! Search for older exact matches and merge into the current version of the chosen note.
pub(crate) mod chooser;
mod markup;

use crate::anki_connect::Collection;
use caseless::Caseless;
use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct MergeLane(Mutex<()>);

#[derive(Deserialize)]
struct Request {
    url: reqwest::Url,
    #[serde(flatten)]
    command: Command,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Command {
    Candidates(Search),
    Merge(Merge),
}

#[derive(Deserialize)]
struct Search {
    source: u64,
    word: String,
    word_field: String,
    model: String,
    sentence_field: String,
    oldest_only: bool,
}

#[derive(Deserialize)]
struct Merge {
    source: u64,
    target: u64,
    fields: Vec<Field>,
    tags: Vec<String>,
    back: bool,
    overwrite: bool,
    remove_overlay: bool,
    delete_duplicate: bool,
}

#[derive(Deserialize)]
struct Field {
    name: String,
    value: String,
    image: bool,
    line_breaks: bool,
}

#[derive(Serialize)]
struct Candidate {
    note_id: u64,
    sentence: String,
    tags: Vec<String>,
    model_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note<'a> {
    #[serde(deserialize_with = "unsigned_id")]
    note_id: u64,
    #[serde(default)]
    model_name: String,
    #[serde(default, borrow)]
    tags: Option<&'a RawValue>,
    #[serde(borrow, default)]
    fields: HashMap<String, &'a RawValue>,
}

fn unsigned_id<'de, D: serde::Deserializer<'de>>(de: D) -> Result<u64, D::Error> {
    gsm_history::anki_sync::integer(de)?
        .try_into()
        .map_err(serde::de::Error::custom)
}

fn id_list(raw: &RawValue) -> Result<Vec<u64>, String> {
    #[derive(Deserialize)]
    struct Id(#[serde(deserialize_with = "gsm_history::anki_sync::integer")] i64);
    let ids: Option<Vec<Id>> = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
    Ok(ids
        .into_iter()
        .flatten()
        .filter_map(|id| id.0.try_into().ok())
        .collect())
}

impl Note<'_> {
    fn field(&self, name: &str) -> Result<String, String> {
        let Some(raw) = self.fields.get(name) else {
            return Ok(String::new());
        };
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Content {
            Field { value: Option<String> },
            Text(String),
            Empty,
        }
        match serde_json::from_str(raw.get()).map_err(|e| e.to_string())? {
            Content::Field { value } => Ok(value.unwrap_or_default()),
            Content::Text(value) => Ok(value),
            Content::Empty => Ok(String::new()),
        }
    }
}

impl Search {
    fn choices(
        &self,
        r: &RawValue,
        requested: &[u64],
    ) -> Result<(Option<u64>, Vec<Candidate>), String> {
        let rows: Option<Vec<Note>> = serde_json::from_str(r.get()).map_err(|e| e.to_string())?;
        let mut choices = Vec::new();
        let mut oldest: Option<u64> = None;
        for note in rows.into_iter().flatten() {
            let note_model = note.model_name.trim_matches(markup::space);
            if requested.binary_search(&note.note_id).is_err()
                || (!self.model.is_empty() && !note_model.is_empty() && self.model != note_model)
                || markup::word(&note.field(&self.word_field)?) != self.word
            {
                continue;
            }
            if self.oldest_only {
                oldest = Some(oldest.map_or(note.note_id, |old| old.min(note.note_id)));
                continue;
            }
            choices.push(Candidate {
                note_id: note.note_id,
                sentence: if self.sentence_field.is_empty() {
                    String::new()
                } else {
                    markup::plain(&note.field(&self.sentence_field)?)
                        .trim_matches(markup::space)
                        .to_owned()
                },
                model_name: if note_model.is_empty() {
                    self.model.clone()
                } else {
                    note_model.to_owned()
                },
                tags: note
                    .tags
                    .map(|raw| serde_json::from_str(raw.get()))
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .unwrap_or_default(),
            });
        }
        Ok((oldest, choices))
    }
}

impl Collection<'_> {
    async fn search(&self, mut search: Search) -> Result<Value, String> {
        let normalized = markup::word(&search.word);
        if normalized.is_empty() || search.word_field.is_empty() {
            return Ok(json!([]));
        }
        let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let mut query = String::new();
        if !search.model.is_empty() {
            query = format!("note:\"{}\" ", escape(&search.model));
        }
        query.push_str(&format!(
            "\"{}:{}\"",
            escape(&search.word_field),
            escape(&search.word)
        ));
        search.word = normalized;
        let search = Arc::new(search);
        let mut ids: Vec<u64> = self
            .call("findNotes", json!({"query":query}), id_list)
            .await?;
        ids.retain(|&id| id > 0 && id < search.source);
        ids.sort_unstable();
        let mut matches = Vec::new();
        let mut remaining = ids.as_slice();
        // The chooser needs all matches. Automatic mode often finds the oldest
        // match in the first few notes. Grow the read if early candidates miss.
        const MAX_PAGE: usize = 512;
        let mut page_size = if search.oldest_only { 8 } else { MAX_PAGE };
        while !remaining.is_empty() {
            let (page, rest) = remaining.split_at(page_size.min(remaining.len()));
            remaining = rest;
            page_size = (page_size * 8).min(MAX_PAGE);
            let spec = search.clone();
            let requested = page.to_vec();
            let found = self
                .call("notesInfo", json!({"notes": page}), move |r| {
                    // Older add-ons may return nonstandard field values. The local
                    // chooser can read them without repeating a write.
                    Ok(spec.choices(r, &requested).ok())
                })
                .await?;
            let Some((oldest, mut choices)) = found else {
                return Ok(Value::Null);
            };
            if let Some(first) = oldest {
                return Ok(json!([{"note_id":first}]));
            }
            matches.append(&mut choices);
        }
        tauri::async_runtime::spawn_blocking(move || {
            matches.sort_by_key(|c| c.note_id);
            gsm_runtime::bounded_reply(json!(matches))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn merge(&self, merge: Merge) -> Result<Value, String> {
        if merge.source == 0 || merge.target == 0 || merge.target == merge.source {
            return Err("Field grouping requires two different valid Anki note IDs.".into());
        }
        let merge = Arc::new(merge);
        let spec = merge.clone();
        let note = self
            .call("notesInfo", json!({"notes":[merge.target]}), move |r| {
                let Ok(notes) = serde_json::from_str::<Vec<Note>>(r.get()) else {
                    return Ok(None);
                };
                let target = notes
                    .first()
                    .filter(|n| n.note_id == spec.target)
                    .ok_or_else(|| {
                        format!(
                            "The selected original Anki note {} no longer exists.",
                            spec.target
                        )
                    })?;
                build(&spec, target)
            })
            .await?;
        // The local reader accepts historical field shapes and arbitrary-precision
        // group numbers. This fallback precedes all edits.
        let Some(note) = note else {
            return Ok(Value::Null);
        };
        let selected: Vec<u64> = self.call("guiSelectedNotes", json!({}), id_list).await?;
        if selected.contains(&merge.target) {
            self.call("guiBrowse", json!({"query":"nid:1"}), |_| Ok(()))
                .await?;
        }
        let tags = merge_tags(&merge.tags);
        crate::anki_edit::commit_group(
            self.client,
            self.url.clone(),
            note,
            tags,
            merge.remove_overlay,
        )
        .await?;
        if merge.delete_duplicate {
            self.call("deleteNotes", json!({"notes":[merge.source]}), |_| Ok(()))
                .await?;
        }
        Ok(Value::Bool(true))
    }
}

fn merge_tags(tags: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    tags.iter()
        .filter_map(|raw| {
            let tag = raw.trim_matches(markup::space);
            let key: String = tag.chars().default_case_fold().collect();
            (!matches!(key.as_str(), "" | "leech" | "marked" | "potential_leech")
                && seen.insert(key))
            .then(|| tag.to_owned())
        })
        .collect()
}

fn build(spec: &Merge, target: &Note) -> Result<Option<Value>, String> {
    let (mut min, mut max) = (target.note_id, target.note_id);
    let mut pairs = Vec::with_capacity(spec.fields.len());
    for field in &spec.fields {
        let Ok(prior) = target.field(&field.name) else {
            return Ok(None);
        };
        for value in [&field.value, &prior] {
            if markup::bounds(value, &mut min, &mut max).is_none() {
                return Ok(None);
            }
        }
        pairs.push((field, prior));
    }
    let shift = spec.back && min <= 1;
    let prior_id = if shift {
        target.note_id.max(2)
    } else {
        target.note_id
    };
    let new_id = if shift {
        if max == u64::MAX {
            return Ok(None);
        }
        1
    } else if spec.back {
        min - 1
    } else if spec.source > max {
        spec.source
    } else if let Some(next) = max.checked_add(1) {
        next
    } else {
        return Ok(None);
    };
    let mut fields = serde_json::Map::new();
    for (field, prior) in pairs {
        let source = if shift {
            markup::shift_ids(&field.value)
        } else {
            (&*field.value).into()
        };
        let prior = if shift {
            markup::shift_ids(&prior)
        } else {
            prior.as_str().into()
        };
        if source.trim_matches(markup::space).is_empty()
            && prior.trim_matches(markup::space).is_empty()
        {
            continue;
        }
        let mut value = if spec.overwrite && !source.trim_matches(markup::space).is_empty() {
            source.into_owned()
        } else {
            let mut out = String::with_capacity(prior.len() + source.len() + 96);
            let old = (prior.as_ref(), prior_id);
            let new = (source.as_ref(), new_id);
            for (text, id) in if spec.back { [old, new] } else { [new, old] } {
                markup::append(&mut out, text, id, field.image);
            }
            out
        };
        if field.line_breaks && value.contains(['\n', '\r']) {
            value = value.replace("\r\n", "<br>").replace(['\n', '\r'], "<br>");
        }
        fields.insert(field.name.clone(), Value::String(value));
    }
    if fields.is_empty() {
        return Err("No configured context fields contained data to merge.".into());
    }
    Ok(Some(json!({"id":spec.target,"fields":fields})))
}

pub(crate) async fn find_candidates(
    app: &AppHandle,
    url: &reqwest::Url,
    source: u64,
    word: &str,
    word_field: &str,
    model: &str,
    sentence_field: &str,
    oldest_only: bool,
) -> Result<Value, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Invalid AnkiConnect URL".into());
    }
    let desktop = app.state::<crate::desktop_state::DesktopState>();
    let anki = Collection {
        client: &desktop.http,
        url,
    };
    anki.search(Search {
        source,
        word: word.to_string(),
        word_field: word_field.to_string(),
        model: model.to_string(),
        sentence_field: sentence_field.to_string(),
        oldest_only,
    })
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn merge_into(
    app: &AppHandle,
    url: &reqwest::Url,
    source: u64,
    target: u64,
    fields: Vec<(String, String, bool, bool)>,
    tags: Vec<String>,
    back: bool,
    overwrite: bool,
    remove_overlay: bool,
    delete_duplicate: bool,
) -> Result<Value, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Invalid AnkiConnect URL".into());
    }
    let desktop = app.state::<crate::desktop_state::DesktopState>();
    let anki = Collection {
        client: &desktop.http,
        url,
    };
    let lane = app.state::<MergeLane>();
    let _guard = lane.0.lock().await;
    anki.merge(Merge {
        source,
        target,
        fields: fields
            .into_iter()
            .map(|(name, value, image, line_breaks)| Field {
                name,
                value,
                image,
                line_breaks,
            })
            .collect(),
        tags,
        back,
        overwrite,
        remove_overlay,
        delete_duplicate,
    })
    .await
}

pub async fn request(app: &AppHandle, epoch: u64, data: Value) -> Result<Value, String> {
    let request: Request = serde_json::from_value(data).map_err(|e| e.to_string())?;
    if !matches!(request.url.scheme(), "http" | "https") {
        return Err("Invalid AnkiConnect URL".into());
    }
    let mut owner = app.state::<crate::anki_sync::SyncLane>().session(epoch)?;
    let desktop = app.state::<crate::desktop_state::DesktopState>();
    let anki = Collection {
        client: &desktop.http,
        url: &request.url,
    };
    tokio::select! {
        biased;
        _ = owner.changed() => Err("Anki grouping stopped with the backend session".into()),
        result = async {
            match request.command {
                Command::Candidates(search) => anki.search(search).await,
                Command::Merge(merge) => {
                    let lane = app.state::<MergeLane>();
                    let _guard = lane.0.lock().await;
                    anki.merge(merge).await
                }
            }
        } => result,
    }
}
