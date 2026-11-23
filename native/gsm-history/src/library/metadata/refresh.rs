use super::{Fields, MetadataChanges};
use crate::{game_stats::GAME_STATUS_VALUES, History, Result};
use rusqlite::TransactionBehavior;
use serde_json::Value;
use std::path::Path;

pub struct RefreshGame {
    pub id: String,
    pub title: String,
    pub deck: Option<i64>,
    pub vndb: String,
    pub anilist: String,
    pub kind: String,
    pub cover_protected: bool,
    pub type_protected: bool,
    pub has_cover: bool,
}

pub struct RefreshPlan {
    pub total: usize,
    pub unlinked: usize,
    pub skipped: usize,
    pub games: Vec<RefreshGame>,
}

impl RefreshGame {
    fn matches_fields(&self, fields: &Fields) -> bool {
        let id = |key: &str| fields.values[key].as_str().unwrap_or("");
        fields.values["deck_id"].as_i64().filter(|v| *v != 0) == self.deck
            && id("vndb_id") == self.vndb
            && id("anilist_id") == self.anilist
            && (!self.vndb.is_empty()
                || self.anilist.is_empty()
                || (self.kind == "Manga") == (id("type") == "Manga"))
    }
    pub fn provider(&self) -> &'static str {
        if self.deck.is_some() {
            "jiten"
        } else if !self.vndb.is_empty() {
            "vndb"
        } else {
            "anilist"
        }
    }
}

impl History {
    pub fn metadata_refresh_plan(
        &self,
        path: &Path,
        generation: u64,
        now: f64,
        force: bool,
    ) -> Result<RefreshPlan> {
        if self.generation()? != generation {
            return Err("Database changed before metadata refresh".into());
        }
        self.with_reader(path, |db| read_refresh_plan(db, now, force))
    }

    /// Never apply a response fetched for a game that was relinked in flight.
    pub fn apply_metadata_refresh(
        &self,
        path: &Path,
        generation: u64,
        game: &RefreshGame,
        data: &Value,
        characters: Option<&Value>,
        supplemental_cover: bool,
    ) -> Result<bool> {
        self.with_writer_generation(path, Some(generation), |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(fields) = Fields::read(&tx, &game.id)? else {
                return Ok(false);
            };
            if !game.matches_fields(&fields) {
                return Ok(false);
            }
            let mut changes = MetadataChanges::default();
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
                let input = &data[if key == "type" {
                    "media_type_string"
                } else {
                    key
                }];
                let valid = match key {
                    "deck_id" | "difficulty" | "character_count" => {
                        game.deck.is_some() && !input.is_null()
                    }
                    "links" => game.deck.is_some() && super::truthy(input),
                    "image" => {
                        super::truthy(input)
                            && !(supplemental_cover && super::truthy(&fields.values["image"]))
                    }
                    _ => super::truthy(input),
                };
                if valid && !fields.overrides.iter().any(|v| v == key) {
                    changes.set(key, super::stored(input));
                }
            }
            if let Some(people) = characters {
                changes.set("vndb_character_data", serde_json::to_string(people)?.into());
            }
            changes.save(&tx, game.id.clone())?;
            tx.commit()?;
            Ok(true)
        })
    }
}

impl History {
    pub fn apply_metadata_upgrade(
        &self,
        path: &Path,
        generation: u64,
        game: &RefreshGame,
        deck: i64,
        data: &Value,
        source: Option<&super::CharacterSource>,
        characters: Option<&Value>,
    ) -> Result<Option<Vec<&'static str>>> {
        self.with_writer_generation(path, Some(generation), |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(fields) = Fields::read(&tx, &game.id)? else {
                return Ok(None);
            };
            if game.deck.is_some() || !game.matches_fields(&fields) {
                return Ok(None);
            }
            let mut changes = MetadataChanges::default();
            let mut links = fields.links;
            for key in super::LINK_FIELDS {
                let Some(input) = super::link_input(key, data, true) else {
                    continue;
                };
                if fields.overrides.iter().any(|v| v == key) {
                    continue;
                }
                if key == "links" {
                    links = super::raw_links(input.clone())
                } else {
                    changes.set(key, super::stored(input))
                }
                changes
                    .reported
                    .push(if key == "type" { "game_type" } else { key });
            }
            if changes.reported.is_empty() {
                return Ok(Some(Vec::new()));
            }
            super::add_deck_link(&mut links, &deck.into());
            changes.set("links", serde_json::to_string(&links)?.into());
            match source {
                Some(super::CharacterSource::Vndb(id)) if game.vndb.is_empty() => {
                    changes.set("vndb_id", id.clone().into())
                }
                Some(super::CharacterSource::Anilist { id, .. }) if game.anilist.is_empty() => {
                    changes.set("anilist_id", id.to_string().into())
                }
                _ => {}
            }
            if let Some(people) = characters {
                changes.set("vndb_character_data", serde_json::to_string(people)?.into())
            }
            let reported = std::mem::take(&mut changes.reported);
            changes.save(&tx, game.id.clone())?;
            tx.commit()?;
            Ok(Some(reported))
        })
    }
}

fn read_refresh_plan(db: &mut rusqlite::Connection, now: f64, force: bool) -> Result<RefreshPlan> {
    let tx = db.transaction()?;
    let total = tx.query_row("SELECT count(*) FROM games", [], |r| r.get(0))?;
    // Keep covers and portrait blobs in SQLite. Only unsettled, active games
    // need a range lookup using the existing game_id index.
    let mut query=tx.prepare_cached("SELECT id,coalesce(title_original,''),nullif(cast(deck_id AS INTEGER),0),
                coalesce(vndb_id,''),coalesce(anilist_id,''),coalesce(type,''),coalesce(status,''),
                cast(coalesce(completed,0) AS INTEGER),coalesce(octet_length(image),0)>0,manual_overrides
                FROM games WHERE cast(deck_id AS INTEGER)!=0 OR coalesce(vndb_id,'')!='' OR coalesce(anilist_id,'')!=''
                ORDER BY rowid")?;
    let mut dates =
        tx.prepare_cached("SELECT min(timestamp),max(timestamp) FROM game_lines WHERE game_id=?")?;
    let mut games = Vec::new();
    let mut rows = query.query([])?;
    let mut skipped = 0;
    while let Some(row) = rows.next()? {
        let id = row.get_ref(0)?.as_str()?;
        let title = row.get_ref(1)?.as_str()?;
        let deck: Option<i64> = row.get(2)?;
        if !force {
            let status = row.get_ref(6)?.as_str()?;
            let completed = if GAME_STATUS_VALUES.contains(&status) {
                status == "completed"
            } else {
                row.get::<_, bool>(7)?
            };
            if completed {
                skipped += 1;
                continue;
            }
            if deck.is_none() || !title.is_empty() {
                let (first, last) = dates.query_row([id], |r| {
                    Ok((r.get::<_, Option<f64>>(0)?, r.get::<_, Option<f64>>(1)?))
                })?;
                if let (Some(first), Some(last)) =
                    (first.filter(|v| *v != 0.), last.filter(|v| *v != 0.))
                {
                    if now - last > 14. * 86400. || now - first > 30. * 86400. {
                        skipped += 1;
                        continue;
                    }
                }
            }
        }
        let overrides = row
            .get_ref(9)?
            .as_str()
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok());
        games.push(RefreshGame {
            id: id.into(),
            title: title.into(),
            deck,
            vndb: row.get(3)?,
            anilist: row.get(4)?,
            kind: row.get(5)?,
            has_cover: row.get(8)?,
            cover_protected: overrides
                .as_ref()
                .is_some_and(|keys| keys.iter().any(|k| k == "image")),
            type_protected: overrides.is_some_and(|keys| keys.iter().any(|k| k == "type")),
        });
    }
    if !force {
        games.sort_by_key(|g| {
            if g.deck.is_some() {
                0
            } else if !g.vndb.is_empty() {
                1
            } else {
                2
            }
        });
    }
    Ok(RefreshPlan {
        total,
        unlinked: total - games.len() - skipped,
        skipped,
        games,
    })
}
