use super::{
    link::{database_reply, error},
    refresh::notify_characters,
    Sources,
};
use gsm_history::{
    library::{CharacterSource, RepullSources, RepullTarget},
    History,
};
use gsm_mining::gateway::StatusCode;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

impl Sources {
    async fn repull_image(
        &self,
        target: &RepullTarget,
        sources: &RepullSources,
    ) -> Option<(&'static str, String)> {
        if !target.fetch_cover {
            return None;
        }
        if let Some(url) = sources
            .jiten
            .as_ref()
            .and_then(|row| row["cover_name"].as_str())
            .filter(|s| !s.is_empty())
        {
            if let Some(image) = self.jiten_cover(url).await {
                return Some(("jiten", image));
            }
        }
        if !target.vndb.is_empty() {
            let image = if let Some(url) = sources
                .vndb
                .as_ref()
                .and_then(|row| row["cover_url"].as_str())
            {
                self.thumbnail(url).await
            } else {
                self.cover_from(&CharacterSource::Vndb(target.vndb.clone()))
                    .await
            };
            if let Some(image) = image {
                return Some(("vndb", image));
            }
        }
        if let Some(url) = sources
            .igdb
            .as_ref()
            .and_then(|row| row["cover_url"].as_str())
        {
            if let Some(image) = self.igdb_cover(url).await {
                return Some(("igdb", image));
            }
        }
        if let Ok(id) = target.anilist.parse() {
            let image = if let Some(url) = sources
                .anilist
                .as_ref()
                .and_then(|row| row["cover_url"].as_str())
            {
                self.thumbnail(url).await
            } else {
                self.cover_from(&CharacterSource::Anilist {
                    id,
                    manga: target.manga,
                })
                .await
            };
            if let Some(image) = image {
                return Some(("anilist", image));
            }
        }
        None
    }
}

pub(super) async fn repull(app: &AppHandle, id: String) -> (StatusCode, Value) {
    let history = app.state::<Arc<History>>().inner().clone();
    let db = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("gsm.db");
    let reader = history.clone();
    let path = db.clone();
    let game = id.clone();
    let target = match database_reply(
        tokio::task::spawn_blocking(move || reader.begin_game_repull(&path, &game)).await,
    ) {
        Ok(target) => target,
        Err(reply) => return reply,
    };
    if !target.linked() {
        return error(StatusCode::BAD_REQUEST,"Game is not linked to any data source (Jiten, VNDB, AniList, or IGDB). Please link it first.");
    }
    let api = Sources::for_search(app, target.igdb.is_some()).await;
    let vn = (!target.vndb.is_empty()).then(|| {
        let id = target.vndb.trim().to_lowercase();
        CharacterSource::Vndb(if id.starts_with('v') {
            id
        } else {
            format!("v{id}")
        })
    });
    let anime = target
        .anilist
        .parse()
        .ok()
        .map(|id| CharacterSource::Anilist {
            id,
            manga: target.manga,
        });
    let (jiten, vndb, igdb, anilist) = tokio::join!(
        async { api.deck_detail(target.deck?).await.ok() },
        async { api.detail(vn.as_ref()?).await },
        async { api.igdb_metadata(target.igdb.as_deref()?).await },
        async { api.detail(anime.as_ref()?).await }
    );
    let mut sources = RepullSources {
        jiten,
        vndb,
        igdb,
        anilist,
        ..Default::default()
    };
    let source = vn.as_ref().or(anime.as_ref());
    let (image, characters) = tokio::join!(api.repull_image(&target, &sources), async {
        api.characters(source?).await
    });
    let reason = characters.as_ref().and(source).map(|s| match s {
        CharacterSource::Vndb(_) => "jiten-repull:vndb-character-data",
        CharacterSource::Anilist { .. } => "jiten-repull:anilist-character-data",
    });
    sources.image = image;
    sources.characters = characters;
    let generation = target.generation;
    let result =
        tokio::task::spawn_blocking(move || history.finish_game_repull(&db, target, sources)).await;
    match result {
        Ok(Ok(Some(reply))) => {
            if let Some(reason) = reason {
                notify_characters(app, &id, generation, reason)
            }
            (StatusCode::OK, reply)
        }
        Ok(Ok(None)) => error(StatusCode::NOT_FOUND, "Game not found"),
        Ok(Err(e)) if e.to_string() == "Game links changed during metadata refresh" => {
            error(StatusCode::CONFLICT, e)
        }
        Ok(Err(e)) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to repull data: {e}"),
        ),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to repull data: {e}"),
        ),
    }
}
