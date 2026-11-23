use super::{
    add_deck_link, igdb_slug, link_url, merge_links, raw_links, stored, truthy, Fields,
    MetadataChanges,
};
use crate::{History, Result};
use rusqlite::TransactionBehavior;
use serde_json::{json, Value};
use std::path::Path;

pub struct RepullTarget {
    pub id: String,
    pub generation: u64,
    pub deck: Option<i64>,
    pub vndb: String,
    pub anilist: String,
    pub igdb: Option<String>,
    pub manga: bool,
    pub fetch_cover: bool,
}

impl RepullTarget {
    fn from_fields(id: &str, generation: u64, fields: &Fields) -> Self {
        Self {
            id: id.to_owned(),
            generation,
            deck: fields.values["deck_id"].as_i64().filter(|v| *v != 0),
            vndb: fields.values["vndb_id"].as_str().unwrap_or("").into(),
            anilist: fields.values["anilist_id"].as_str().unwrap_or("").into(),
            igdb: fields
                .links
                .iter()
                .filter_map(link_url)
                .find_map(igdb_slug)
                .map(|slug| format!("https://www.igdb.com/games/{slug}")),
            manga: fields.values["type"]
                .as_str()
                .is_some_and(|kind| kind.eq_ignore_ascii_case("Manga")),
            fetch_cover: !fields.overrides.iter().any(|v| v == "image"),
        }
    }
    pub fn linked(&self) -> bool {
        self.deck.is_some()
            || !self.vndb.is_empty()
            || !self.anilist.is_empty()
            || self.igdb.is_some()
    }
    fn same_sources(&self, other: &Self) -> bool {
        self.deck == other.deck
            && self.vndb == other.vndb
            && self.anilist == other.anilist
            && self.igdb == other.igdb
            && (self.anilist.is_empty() || self.manga == other.manga)
    }
}

#[derive(Default)]
pub struct RepullSources {
    pub jiten: Option<Value>,
    pub vndb: Option<Value>,
    pub igdb: Option<Value>,
    pub anilist: Option<Value>,
    pub image: Option<(&'static str, String)>,
    pub characters: Option<Value>,
}

impl History {
    pub fn begin_game_repull(&self, path: &Path, id: &str) -> Result<Option<RepullTarget>> {
        let generation = self.generation()?;
        self.with_reader(path, |conn| {
            Ok(Fields::read(conn, id)?.map(|row| RepullTarget::from_fields(id, generation, &row)))
        })
    }
    pub fn finish_game_repull(
        &self,
        path: &Path,
        target: RepullTarget,
        sources: RepullSources,
    ) -> Result<Option<Value>> {
        self.with_writer_generation(path, Some(target.generation), |db| {
            write_repull(db, target, sources)
        })
    }
}

fn write_repull(
    db: &mut rusqlite::Connection,
    target: RepullTarget,
    sources: RepullSources,
) -> Result<Option<Value>> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(fields) = Fields::read(&tx, &target.id)? else {
        return Ok(None);
    };
    if !target.same_sources(&RepullTarget::from_fields(
        &target.id,
        target.generation,
        &fields,
    )) {
        return Err("Game links changed during metadata refresh".into());
    }
    let priority = [
        sources.jiten.as_ref(),
        sources.vndb.as_ref(),
        sources.igdb.as_ref(),
        sources.anilist.as_ref(),
    ];
    let mut used = Vec::new();
    for (name, source) in [
        ("jiten", &sources.jiten),
        ("vndb", &sources.vndb),
        ("anilist", &sources.anilist),
        ("igdb", &sources.igdb),
    ] {
        if source.is_some() {
            used.push(name.to_owned())
        }
    }
    let locked = |key: &str| fields.overrides.iter().any(|v| v == key);
    let mut skipped = Vec::new();
    for key in [
        "deck_id",
        "title_original",
        "title_romaji",
        "title_english",
        "type",
        "description",
        "difficulty",
        "character_count",
        "links",
        "release_date",
        "genres",
        "tags",
        "image",
    ] {
        if locked(key) {
            skipped.push(key)
        }
    }
    let incoming = if locked("links") {
        Vec::new()
    } else {
        merge_links(
            priority
                .iter()
                .flatten()
                .flat_map(|row| raw_links(row["links"].clone())),
        )
    };
    let has_incoming_links = !incoming.is_empty();
    let mut changes = MetadataChanges::default();
    let mut title = fields.values["title_original"].as_str().unwrap_or("");
    let mut deck = &fields.values["deck_id"];
    for key in [
        "difficulty",
        "character_count",
        "genres",
        "tags",
        "links",
        "deck_id",
        "title_original",
        "title_romaji",
        "title_english",
        "description",
        "release_date",
        "type",
    ] {
        if locked(key) {
            continue;
        }
        if key == "links" {
            if has_incoming_links {
                changes.reported.push("links")
            }
            continue;
        }
        let input = match key {
            "difficulty" | "character_count" => sources
                .jiten
                .as_ref()
                .and_then(|j| j.get(key))
                .filter(|v| !v.is_null()),
            "deck_id" => sources
                .jiten
                .as_ref()
                .and_then(|j| j.get(key))
                .filter(|v| truthy(v)),
            "type"
                if sources
                    .jiten
                    .as_ref()
                    .and_then(|j| j["media_type_string"].as_str())
                    .is_none_or(str::is_empty)
                    && sources.vndb.is_some() =>
            {
                changes.set("type", "Visual Novel".to_owned().into());
                changes.reported.push("game_type");
                continue;
            }
            "type" => priority
                .iter()
                .flatten()
                .find_map(|row| row.get("media_type_string").filter(|v| truthy(v))),
            _ => priority
                .iter()
                .flatten()
                .find_map(|row| row.get(key).filter(|v| truthy(v))),
        };
        if let Some(input) = input {
            if key == "deck_id" {
                deck = input
            }
            if key == "title_original" {
                title = input.as_str().unwrap_or("")
            }
            changes.set(key, stored(input));
            changes
                .reported
                .push(if key == "type" { "game_type" } else { key });
        }
    }
    if !locked("links") {
        let write = has_incoming_links || target.deck.is_some();
        let mut links = if has_incoming_links {
            merge_links(fields.links.into_iter().chain(incoming))
        } else {
            fields.links
        };
        if target.deck.is_some() {
            add_deck_link(&mut links, deck)
        }
        if write {
            changes.set("links", serde_json::to_string(&links)?.into())
        }
    }
    if let Some((origin, image)) = sources.image.filter(|_| !locked("image")) {
        changes.set("image", image.into());
        changes.reported.push("image");
        if !used.iter().any(|s| s == origin) {
            used.push(format!("{origin} (image)"))
        }
    }
    if let Some(people) = sources.characters {
        changes.set(
            "vndb_character_data",
            serde_json::to_string(&people)?.into(),
        )
    }
    let message = if changes.reported.is_empty() {
        format!("No fields updated - all fields are manually overridden for \"{title}\"")
    } else {
        format!("Successfully repulled data for \"{title}\"")
    };
    let reply = json!({"success":true,"message":message,"sources_used":used,"updated_fields":changes.reported,
                "skipped_fields":skipped,"deck_id":deck,"vndb_id":target.vndb,"anilist_id":target.anilist,"igdb_url":target.igdb});
    changes.save(&tx, target.id)?;
    tx.commit()?;
    Ok(Some(reply))
}
