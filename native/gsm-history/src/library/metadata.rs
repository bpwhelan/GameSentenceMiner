use super::{stored, truthy, History, Result};
use rusqlite::{
    params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, TransactionBehavior,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};
mod refresh;
mod repull;
pub use refresh::{RefreshGame, RefreshPlan};
pub use repull::{RepullSources, RepullTarget};

pub fn igdb_slug(value: &str) -> Option<&str> {
    let value = value.trim().split(['?', '#']).next()?;
    let path = match value.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?.1,
        None => value,
    };
    let mut parts = path.split('/').filter(|s| !s.is_empty());
    let first = parts.next()?;
    let slug = if first == "games" {
        parts.next()?
    } else if parts.clone().next().is_none() {
        first
    } else {
        parts.skip_while(|s| *s != "games").nth(1)?
    };
    (!slug.trim().is_empty()).then(|| slug.trim())
}

fn raw_links(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        Value::String(s) => serde_json::from_str(&s).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn link_url(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value["url"].as_str())
        .filter(|s| !s.is_empty())
}

fn merge_links(items: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter_map(|item| {
            let url = link_url(&item)?.trim().to_lowercase();
            if url.is_empty() || !seen.insert(url) {
                return None;
            }
            Some(if item.is_string() {
                json!({"url":item,"linkType":1})
            } else {
                item
            })
        })
        .collect()
}

fn add_deck_link(links: &mut Vec<Value>, deck: &Value) {
    let id = deck
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| deck.to_string());
    let item = json!({"url":format!("https://jiten.moe/decks/media/{id}/detail"),"linkType":99,"deckId":deck});
    if let Some(old) = links
        .iter_mut()
        .find(|v| link_url(v).is_some_and(|s| s.contains("jiten.moe/deck")))
    {
        *old = item
    } else {
        links.push(item)
    }
}

const LINK_FIELDS: [&str; 13] = [
    "deck_id",
    "title_original",
    "title_romaji",
    "title_english",
    "type",
    "description",
    "release_date",
    "links",
    "genres",
    "tags",
    "difficulty",
    "character_count",
    "image",
];

fn link_input<'a>(key: &str, data: &'a Value, jiten: bool) -> Option<&'a Value> {
    let input = &data[if key == "type" {
        "media_type_string"
    } else {
        key
    }];
    let allowed = match key {
        "difficulty" | "character_count" => jiten && !input.is_null(),
        "deck_id" => jiten && truthy(input),
        _ => truthy(input),
    };
    allowed.then_some(input)
}

struct Fields {
    values: Value,
    links: Vec<Value>,
    overrides: Vec<Value>,
    linked: bool,
}

impl Fields {
    fn read(conn: &Connection, id: &str) -> Result<Option<Self>> {
        let mut query = conn.prepare_cached(
            "SELECT json_object('title_original',title_original,'title_romaji',title_romaji,
                 'title_english',title_english,'type',type,'description',description,'release_date',release_date,
                 'image',coalesce(octet_length(image),0),'obs_scene_name',obs_scene_name,
                 'deck_id',cast(nullif(deck_id,'') AS INTEGER),'vndb_id',vndb_id,'anilist_id',anilist_id,
                 'difficulty',cast(nullif(difficulty,'') AS REAL),'character_count',cast(character_count AS INTEGER),
                 'genres',genres,'tags',tags), coalesce(links,'[]'),coalesce(manual_overrides,'[]')
             FROM games WHERE id=?"
        )?;
        let row = query
            .query_row([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .optional()?;
        let Some((raw, old_links, overrides)) = row else {
            return Ok(None);
        };
        let mut values: Value = serde_json::from_str(&raw)?;
        for key in ["genres", "tags"] {
            values[key] = values[key]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .filter(Value::is_array)
                .unwrap_or_else(|| json!([]));
        }
        let links = raw_links(serde_json::from_str(&old_links).unwrap_or_default());
        let linked = ["deck_id", "vndb_id", "anilist_id"]
            .iter()
            .any(|k| truthy(&values[*k]))
            || links
                .iter()
                .any(|item| link_url(item).and_then(igdb_slug).is_some());
        Ok(Some(Self {
            values,
            links,
            overrides: serde_json::from_str(&overrides).unwrap_or_default(),
            linked,
        }))
    }
    fn protected(&self, key: &str, overwrite: bool) -> bool {
        if overwrite || !self.overrides.iter().any(|v| v == key) {
            return false;
        }
        if self.linked {
            return true;
        }
        match key {
            "links" => self.links.iter().any(|v| link_url(v).is_some()),
            "difficulty" | "deck_id" => !self.values[key].is_null(),
            other => match &self.values[other] {
                Value::String(s) => !s.trim().is_empty(),
                v => truthy(v),
            },
        }
    }
}

pub struct MetadataLink {
    id: String,
    pub generation: u64,
    overwrite: bool,
    pub fetch_cover: bool,
}

impl History {
    pub fn begin_metadata_link(
        &self,
        path: &Path,
        id: &str,
        overwrite: bool,
    ) -> Result<Option<MetadataLink>> {
        let generation = self.generation()?;
        self.with_reader(path, |conn| {
            Ok(Fields::read(conn, id)?.map(|fields| MetadataLink {
                id: id.into(),
                generation,
                overwrite,
                fetch_cover: !fields.protected("image", overwrite),
            }))
        })
    }
    pub fn finish_metadata_link(
        &self,
        path: &Path,
        link: MetadataLink,
        data: Value,
        provider: MetadataProvider,
    ) -> Result<Option<Value>> {
        self.with_writer_generation(path, Some(link.generation), |conn| {
            write_link(conn, link, data, provider)
        })
    }
}

pub enum CharacterSource {
    Vndb(String),
    Anilist { id: i64, manga: bool },
}

pub enum MetadataProvider {
    Igdb,
    Jiten {
        source: Option<CharacterSource>,
        characters: Option<Value>,
    },
}

#[derive(Default)]
struct MetadataChanges {
    columns: Vec<&'static str>,
    values: Vec<SqlValue>,
    reported: Vec<&'static str>,
}

impl MetadataChanges {
    fn set(&mut self, column: &'static str, value: SqlValue) {
        self.columns.push(column);
        self.values.push(value);
    }

    fn save(mut self, conn: &Connection, id: String) -> Result<()> {
        if !self.columns.is_empty() {
            let columns = self.columns.join(",");
            let bindings = (1..=self.columns.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(",");
            self.values.push(id.into());
            let sql = format!("UPDATE games SET ({columns})=({bindings}) WHERE id=?{} AND ({columns}) IS NOT ({bindings})",self.values.len());
            conn.execute(&sql, params_from_iter(self.values))?;
        }
        Ok(())
    }
}

fn write_link(
    conn: &mut Connection,
    link: MetadataLink,
    data: Value,
    provider: MetadataProvider,
) -> Result<Option<Value>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Overrides and the scene can change while provider requests are in flight.
    let Some(fields) = Fields::read(&tx, &link.id)? else {
        return Ok(None);
    };
    let mut changes = MetadataChanges::default();
    let mut merged_links = fields.links.clone();
    let jiten = matches!(provider, MetadataProvider::Jiten { .. });
    for key in LINK_FIELDS {
        let Some(input) = link_input(key, &data, jiten) else {
            continue;
        };
        if fields.protected(key, link.overwrite) {
            continue;
        }
        if key == "links" {
            merged_links = merge_links(merged_links.into_iter().chain(raw_links(input.clone())));
        } else {
            changes.set(key, stored(input));
        }
        changes
            .reported
            .push(if key == "type" { "game_type" } else { key });
    }
    let write_links = changes.reported.contains(&"links");
    let reply = match provider {
        MetadataProvider::Igdb => {
            if write_links {
                changes.set("links", serde_json::to_string(&merged_links)?.into())
            }
            let title = if changes.reported.contains(&"title_original") {
                &data
            } else {
                &fields.values
            };
            let title = title["title_original"].as_str().unwrap_or("");
            json!({"success":true,"message":format!("Game linked to IGDB metadata for \"{title}\""),
                        "updated_fields":changes.reported, "manual_overrides":fields.overrides,
                        "overwrite_metadata":link.overwrite,"warning":"IGDB does not include character data."})
        }
        MetadataProvider::Jiten { source, characters } => {
            let deck = &data["deck_id"];
            let deck_id = deck
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| deck.to_string());
            let include_deck = !fields.overrides.iter().any(|v| v == "links");
            if include_deck {
                add_deck_link(&mut merged_links, deck);
            }
            if write_links || include_deck {
                changes.set("links", serde_json::to_string(&merged_links)?.into());
            }
            if let Some(source) = source {
                match source {
                    CharacterSource::Vndb(id) => changes.set("vndb_id", id.into()),
                    CharacterSource::Anilist { id, .. } => {
                        changes.set("anilist_id", id.to_string().into())
                    }
                }
                if let Some(people) = characters {
                    changes.set(
                        "vndb_character_data",
                        serde_json::to_string(&people)?.into(),
                    );
                }
            }
            let mut scene = fields.values["obs_scene_name"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            if scene.is_empty() {
                let prior: Option<String> = tx
                    .query_row(
                        "SELECT game_name FROM game_lines WHERE game_id=? LIMIT 1",
                        [&link.id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();
                if let Some(prior) = prior.filter(|s| !s.is_empty()) {
                    changes.set("obs_scene_name", prior.clone().into());
                    scene = prior;
                } else {
                    scene = fields.values["title_original"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                }
            }
            tx.execute(
                "UPDATE game_lines SET game_id=?1 WHERE game_name=?2 AND game_id IS NOT ?1",
                (&link.id, &scene),
            )?;
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM game_lines WHERE game_id=?",
                [&link.id],
                |r| r.get(0),
            )?;
            json!({"success":true,"message":format!("Game linked to jiten.moe deck {deck_id}"),
                        "updated_fields":changes.reported,"manual_overrides":fields.overrides,
                        "overwrite_metadata":link.overwrite,"lines_updated":count})
        }
    };
    changes.save(&tx, link.id)?;
    tx.commit()?;
    Ok(Some(reply))
}
