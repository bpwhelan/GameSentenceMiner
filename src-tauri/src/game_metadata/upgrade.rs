use super::{characters, Sources};
use gsm_history::{library::RefreshGame, History};
use gsm_mining::gateway::StatusCode;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::time::Instant;

static RUN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl Sources {
    async fn linked_deck(&self, kind: u8, id: &str) -> Option<i64> {
        if id.is_empty() {
            return None;
        }
        let mut url = reqwest::Url::parse(&self.jiten).ok()?;
        url.path_segments_mut()
            .ok()?
            .extend(["by-link-id", &kind.to_string(), id]);
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        if response.status() != StatusCode::OK {
            return None;
        }
        let body: Value = response.json().await.ok()?;
        let deck = |item: &Value| item.as_i64().or_else(|| item["deckId"].as_i64());
        if let Some(rows) = body.as_array() {
            rows.iter().find_map(deck)
        } else {
            deck(&body)
        }
    }

    async fn upgrade_game(
        &self,
        game: RefreshGame,
        history: Arc<History>,
        path: PathBuf,
        generation: u64,
    ) -> Value {
        let mut detail = json!({"game_id":game.id,"name":game.title,"vndb_id":game.vndb,"anilist_id":game.anilist,
            "upgraded":false,"deck_id":null,"source":null,"error":null});
        let (deck, source) = if let Some(id) = self.linked_deck(2, &game.vndb).await {
            (id, "vndb")
        } else if let Some(id) = self.linked_deck(4, &game.anilist).await {
            (id, "anilist")
        } else {
            detail["reason"] = "Not found on Jiten".into();
            return detail;
        };
        detail["deck_id"] = deck.into();
        detail["source"] = source.into();
        let mut data = match self.deck_detail(deck).await {
            Ok(data) => data,
            Err(message) => {
                detail["error"] = message.into();
                return detail;
            }
        };
        let origin = characters::from_jiten(&data);
        let (image, people) = tokio::join!(
            async {
                let url = data["cover_name"]
                    .as_str()
                    .filter(|s| !game.cover_protected && !s.is_empty())?;
                self.jiten_cover(url).await
            },
            async { self.characters(origin.as_ref()?).await }
        );
        if let Some(image) = image {
            data["image"] = image.into()
        }
        match tokio::task::spawn_blocking(move || {
            history.apply_metadata_upgrade(
                &path,
                generation,
                &game,
                deck,
                &data,
                origin.as_ref(),
                people.as_ref(),
            )
        })
        .await
        {
            Ok(Ok(Some(fields))) if !fields.is_empty() => {
                detail["upgraded"] = true.into();
                detail["updated_fields"] = json!(fields);
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => detail["error"] = e.to_string().into(),
            Err(e) => detail["error"] = e.to_string().into(),
        }
        detail
    }
}

pub(crate) async fn run(
    http: reqwest::Client,
    history: Arc<History>,
    path: PathBuf,
    generation: u64,
) -> Result<Value, String> {
    let _guard = RUN.lock().await;
    let start = Instant::now();
    let db = history.clone();
    let file = path.clone();
    let plan =
        tokio::task::spawn_blocking(move || db.metadata_refresh_plan(&file, generation, 0., true))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
    let linked = plan.games.iter().filter(|g| g.deck.is_some()).count();
    let api = Sources::new(http, None);
    let mut details = Vec::new();
    let mut upgraded = 0;
    let mut failed = 0;
    let mut next = start;
    for game in plan.games.into_iter().filter(|g| g.deck.is_none()) {
        tokio::time::sleep_until(next).await;
        if history.generation().map_err(|e| e.to_string())? != generation {
            return Err("Database changed before Jiten upgrade".into());
        }
        next = Instant::now() + Duration::from_secs(1);
        let result = api
            .upgrade_game(game, history.clone(), path.clone(), generation)
            .await;
        upgraded += usize::from(result["upgraded"] == true);
        failed += usize::from(result["error"].is_string());
        details.push(result);
    }
    let count = details.len();
    Ok(
        json!({"total_checked":count,"upgraded_to_jiten":upgraded,"already_on_jiten":linked,
        "not_found_on_jiten":count-upgraded-failed,"failed":failed,"details":details,"elapsed_time":start.elapsed().as_secs_f64()}),
    )
}

pub(super) async fn run_api(app: &AppHandle) -> (StatusCode, Value) {
    let history = app.state::<Arc<History>>().inner().clone();
    let path = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("gsm.db");
    let http = app
        .state::<crate::desktop_state::DesktopState>()
        .http
        .clone();
    let result = match history.generation() {
        Ok(generation) => run(http, history, path, generation).await,
        Err(e) => Err(e.to_string()),
    };
    match result {
        Ok(result) => (StatusCode::OK, json!({"status":"success","result":result})),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"status":"error","error":e}),
        ),
    }
}
