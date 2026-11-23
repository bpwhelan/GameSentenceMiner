use super::{characters, Sources};
use gsm_history::{
    library::{CharacterSource, MetadataProvider},
    History,
};
use gsm_mining::gateway::{MetadataAction, StatusCode};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

type Reply = (StatusCode, Value);

pub(super) fn error(status: StatusCode, reason: impl std::fmt::Display) -> Reply {
    (status, json!({"error":reason.to_string()}))
}

pub(super) fn database_reply<T>(
    result: Result<gsm_history::Result<Option<T>>, tokio::task::JoinError>,
) -> Result<T, Reply> {
    let failed = |e: String| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to link game: {e}"),
        )
    };
    result
        .map_err(|e| failed(e.to_string()))?
        .map_err(|e| failed(e.to_string()))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Game not found"))
}

fn enabled(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

pub(crate) async fn link(app: &AppHandle, action: MetadataAction, mut body: Value) -> Reply {
    if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
        return error(StatusCode::FORBIDDEN, "Database is read-only");
    }
    let (id, igdb) = match action {
        MetadataAction::Repull(id) => return super::repull::repull(app, id).await,
        MetadataAction::Upgrade => return super::upgrade::run_api(app).await,
        MetadataAction::LinkJiten(id) => (id, false),
        MetadataAction::LinkIgdb(id) => (id, true),
    };
    if body.as_object().is_none_or(|o| o.is_empty()) {
        return error(StatusCode::BAD_REQUEST, "No data provided");
    }
    let lookup = body["igdb_url"].as_str().unwrap_or("").trim();
    if igdb && lookup.is_empty() {
        return error(StatusCode::BAD_REQUEST, "igdb_url is required");
    }
    if !igdb && !enabled(&body["deck_id"]) {
        return error(StatusCode::BAD_REQUEST, "deck_id is required");
    }
    let overwrite = enabled(&body["overwrite_metadata"]);
    let db = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("gsm.db");
    let history = app.state::<Arc<History>>().inner().clone();
    let reader = history.clone();
    let path = db.clone();
    let game_id = id.clone();
    let link = match database_reply(
        tokio::task::spawn_blocking(move || reader.begin_metadata_link(&path, &game_id, overwrite))
            .await,
    ) {
        Ok(link) => link,
        Err(reply) => return reply,
    };
    let sources = Sources::for_search(app, igdb).await;
    let mut reason = None;
    let (metadata, provider) = if igdb {
        let Some(mut data) = sources.igdb_metadata(lookup).await else {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch metadata from IGDB",
            );
        };
        if let Some(url) = data["cover_url"].as_str().filter(|_| link.fetch_cover) {
            if let Some(image) = sources.igdb_cover(url).await {
                data["image"] = image.into()
            }
        }
        (data, MetadataProvider::Igdb)
    } else {
        let mut data = body
            .as_object_mut()
            .unwrap()
            .remove("jiten_data")
            .unwrap_or_else(|| json!({}));
        if let Some(fields) = data.as_object_mut() {
            // The linking form supplies the cover URL. Only a successful
            // download can replace the stored image.
            fields.remove("image");
        } else {
            return error(StatusCode::BAD_REQUEST, "jiten_data must be an object");
        }
        data["deck_id"] = body["deck_id"].take();
        let source = characters::from_jiten(&data);
        let (image, people) = tokio::join!(
            async {
                sources
                    .jiten_cover(
                        data["cover_name"]
                            .as_str()
                            .filter(|s| link.fetch_cover && !s.is_empty())?,
                    )
                    .await
            },
            async { sources.characters(source.as_ref()?).await }
        );
        if let Some(image) = image {
            data["image"] = image.into()
        }
        if people.is_some() {
            reason = match source {
                Some(CharacterSource::Vndb(_)) => Some("jiten-link:vndb-character-data"),
                Some(CharacterSource::Anilist { .. }) => Some("jiten-link:anilist-character-data"),
                None => None,
            }
        }
        (
            data,
            MetadataProvider::Jiten {
                source,
                characters: people,
            },
        )
    };
    let generation = link.generation;
    let result = tokio::task::spawn_blocking(move || {
        history.finish_metadata_link(&db, link, metadata, provider)
    })
    .await;
    match database_reply(result) {
        Ok(reply) => {
            if !igdb {
                if let Err(e) = app.state::<crate::cron::Scheduler>().force_rollup() {
                    crate::desktop_log::warn(app, "metadata", e);
                }
            }
            if let Some(reason) = reason {
                super::refresh::notify_characters(app, &id, generation, reason);
            }
            (StatusCode::OK, reply)
        }
        Err(reply) => reply,
    }
}
