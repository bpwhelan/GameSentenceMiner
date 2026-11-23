use super::{dictionary, Sources};
use gsm_history::{
    library::{CharacterSource, RefreshGame},
    History,
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::time::Instant;

fn character_source(game: &RefreshGame, manga: bool) -> Option<CharacterSource> {
    if game.vndb.is_empty() {
        game.anilist
            .parse()
            .ok()
            .map(|id| CharacterSource::Anilist { id, manga })
    } else {
        let id = game.vndb.trim().to_lowercase();
        Some(CharacterSource::Vndb(if id.starts_with('v') {
            id
        } else {
            format!("v{id}")
        }))
    }
}

struct Refresh {
    metadata: Value,
    supplemental: bool,
    characters: Option<Value>,
    reason: Option<&'static str>,
}

impl Sources {
    pub(super) async fn cover_from(&self, source: &CharacterSource) -> Option<String> {
        let row = self.detail(source).await?;
        self.thumbnail(row["cover_url"].as_str()?).await
    }

    async fn refresh_game(&self, game: &RefreshGame, clock: &mut ProviderClock) -> Refresh {
        clock.wait(game.provider(), Duration::from_secs(1)).await;
        let manga = game.kind == "Manga";
        let mut supplemental = false;
        let mut data = if let Some(id) = game.deck {
            let mut data = self.deck_detail(id).await.unwrap_or_default();
            if data.is_object() {
                if let Some(kind) = data["media_type"].as_i64().filter(|&v| v != 0) {
                    data["media_type_string"] = match kind {
                        1 => "Anime",
                        2 => "Manga",
                        7 => "Visual Novel",
                        _ => "Unknown",
                    }
                    .into();
                } else {
                    data["media_type_string"] = Value::Null
                }
                if !game.cover_protected {
                    let image =
                        if let Some(url) = data["cover_name"].as_str().filter(|s| !s.is_empty()) {
                            self.jiten_cover(url).await
                        } else {
                            None
                        };
                    if let Some(image) = image {
                        data["image"] = image.into()
                    } else if !game.has_cover {
                        let mut image = None;
                        if let Some(source) = character_source(game, manga) {
                            image = self.cover_from(&source).await;
                        }
                        if image.is_none() && !game.vndb.is_empty() {
                            if let Ok(id) = game.anilist.parse() {
                                image = self
                                    .cover_from(&CharacterSource::Anilist { id, manga })
                                    .await;
                            }
                        }
                        if let Some(image) = image {
                            data["image"] = image.into();
                            supplemental = true
                        }
                    }
                }
            }
            data
        } else if let Some(source) = character_source(game, manga) {
            let mut data = self.detail(&source).await.unwrap_or_default();
            if let Some(url) = data["cover_url"].as_str().filter(|_| !game.cover_protected) {
                if let Some(image) = self.thumbnail(url).await {
                    data["image"] = image.into()
                }
            }
            data
        } else {
            Value::Null
        };
        // Jiten refresh uses the stored type for the character request after
        // applying any non-overridden media type update.
        let new_kind = data["media_type_string"]
            .as_str()
            .filter(|s| !s.is_empty() && !game.type_protected);
        let source = character_source(game, new_kind.map_or(manga, |s| s == "Manga"));
        let (characters, reason) = if let Some(source) = source {
            let (provider, reason) = match source {
                CharacterSource::Vndb(_) => ("vndb", "jiten-update:vndb-character-data"),
                CharacterSource::Anilist { .. } => {
                    ("anilist", "jiten-update:anilist-character-data")
                }
            };
            clock.wait(provider, Duration::from_millis(500)).await;
            (self.characters(&source).await, Some(reason))
        } else {
            (None, None)
        };
        // Short-lived HTTP-only fields do not need to cross the SQLite worker boundary.
        if let Some(obj) = data.as_object_mut() {
            obj.remove("cover_url");
            obj.remove("cover_name");
        }
        Refresh {
            metadata: data,
            supplemental,
            characters,
            reason,
        }
    }
}

#[derive(Default)]
struct ProviderClock(HashMap<&'static str, Instant>);
impl ProviderClock {
    async fn wait(&mut self, provider: &'static str, interval: Duration) {
        if let Some(previous) = self.0.get(provider) {
            tokio::time::sleep_until(*previous + interval).await;
        }
        self.0.insert(provider, Instant::now());
    }
}

pub(crate) async fn sync(
    http: reqwest::Client,
    history: Arc<History>,
    path: PathBuf,
    generation: u64,
    app: Option<&AppHandle>,
    force: bool,
) -> Result<(), String> {
    let db = history.clone();
    let file = path.clone();
    let plan = tokio::task::spawn_blocking(move || {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs_f64();
        db.metadata_refresh_plan(&file, generation, now, force)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let sources = Sources::new(http, None);
    let mut clock = ProviderClock::default();
    for game in plan.games {
        let response = sources.refresh_game(&game, &mut clock).await;
        if response.metadata.is_null() && response.characters.is_none() {
            continue;
        }
        let reason = response.reason.filter(|_| response.characters.is_some());
        let id = game.id.clone();
        let db = history.clone();
        let file = path.clone();
        let saved = tokio::task::spawn_blocking(move || {
            db.apply_metadata_refresh(
                &file,
                generation,
                &game,
                &response.metadata,
                response.characters.as_ref(),
                response.supplemental,
            )
        })
        .await
        .map_err(|e| e.to_string())?;
        match saved {
            Ok(true) => {
                if let (Some(app), Some(reason)) = (app, reason) {
                    notify_characters(app, &id, generation, reason)
                }
            }
            Ok(false) => {}
            Err(e) => {
                if history.generation().map_err(|e| e.to_string())? != generation {
                    return Err(e.to_string());
                }
                if let Some(app) = app {
                    crate::desktop_log::warn(
                        app,
                        "metadata",
                        format!("Could not refresh {id}: {e}"),
                    )
                }
            }
        }
    }
    Ok(())
}

pub(super) fn notify_characters(app: &AppHandle, id: &str, generation: u64, reason: &str) {
    dictionary::queue(app, dictionary::Selection::Game(id, generation));
    app.state::<crate::text_intake::Intake>()
        .overlay_event(json!({
            "type":"yomitan_character_dictionary_changed","reason":reason,"game_id":id
        }));
}
