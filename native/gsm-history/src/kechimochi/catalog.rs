use super::{metadata, Media, Snapshot};
use crate::{
    game_stats::GAME_STATUS_VALUES,
    stats_export::{activity, library},
    Result,
};
use rusqlite::Connection;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Catalog {
    ids: HashMap<String, usize>,
    scenes: HashMap<String, usize>,
    pub titles: HashMap<String, String>,
}

impl Catalog {
    pub fn read(conn: &Connection, snapshot: &mut Snapshot) -> Result<Self> {
        let mut catalog = Self::default();
        let mut stmt=conn.prepare(&format!("SELECT id,coalesce(nullif(title_original,''),nullif(title_english,''),
            nullif(title_romaji,''),nullif(obs_scene_name,''),nullif(id,''),'Untitled'),coalesce(type,''),
            coalesce(status,''),coalesce(CAST(completed AS INTEGER),0),coalesce(description,''),
            image IS NOT NULL AND image!='',CAST(character_count AS INTEGER),CAST(difficulty AS TEXT),
            {} FROM games ORDER BY rowid",library::EXTRA_COLUMNS))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let kind = row.get_ref(2)?.as_str()?;
            let mut status = row.get_ref(3)?.as_str()?;
            if !GAME_STATUS_VALUES.contains(&status) {
                status = if row.get::<_, bool>(4)? {
                    "completed"
                } else {
                    "in_progress"
                };
            }
            let mut media = Media::native(title, Some(kind), status);
            media.description = row.get(5)?;
            media.cover_game = row.get::<_, bool>(6)?.then(|| id.clone());
            media.extra_data = metadata::for_game(
                library::extra_fields(row, 9, &media.title)?,
                kind,
                row.get(7)?,
                row.get(8)?,
            );
            let scene = row.get_ref(12)?.as_str_or_null()?.unwrap_or("");
            let index = snapshot.media.insert_full(format!("game:{id}"), media).0;
            catalog.ids.insert(id, index);
            if !scene.is_empty() {
                catalog.scenes.insert(scene.into(), index);
            }
        }
        Ok(catalog)
    }

    pub fn resolve(&mut self, snapshot: &mut Snapshot, id: &str, scene: &str) -> usize {
        let group = if id.is_empty() {
            self.scenes.get(scene)
        } else {
            self.ids.get(id)
        };
        if let Some(index) = group {
            return *index;
        }
        let title = if !scene.is_empty() {
            scene.to_owned()
        } else if let Some(title) = self.titles.get(id) {
            title.clone()
        } else if id.is_empty() {
            "Unknown Game".into()
        } else {
            format!("Game {id}")
        };
        let (key, map, name) = if id.is_empty() {
            (format!("scene:{scene}"), &mut self.scenes, scene)
        } else {
            (format!("game:{id}"), &mut self.ids, id)
        };
        let index = snapshot
            .media
            .insert_full(key, Media::native(title, None, "in_progress"))
            .0;
        map.insert(name.into(), index);
        index
    }
}

impl Media {
    fn native(title: String, kind: Option<&str>, lifecycle: &str) -> Self {
        let (default_activity_type, legacy_activity) = activity::category(kind.unwrap_or(""));
        let (status, tracking_status) = match lifecycle {
            "completed" => ("Complete", "Complete"),
            "planned" => ("Planned", "Not Started"),
            "on_hold" => ("Paused", "Paused"),
            "dropped" => ("Dropped", "Dropped"),
            _ => ("Active", "Ongoing"),
        };
        Self {
            title,
            default_activity_type,
            legacy_activity,
            status,
            tracking_status,
            description: String::new(),
            content_type: library::category(kind.unwrap_or("Game")).1,
            extra_data: Default::default(),
            cover_game: None,
        }
    }
}
