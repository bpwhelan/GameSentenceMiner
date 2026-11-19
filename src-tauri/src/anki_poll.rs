//! Recent-note tracking for AnkiConnect's polling and Beacon modes.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

#[path = "anki_monitor.rs"]
pub mod monitor;

type Known = Arc<Mutex<HashSet<u64>>>;

#[derive(Default)]
pub struct Notes(Mutex<Option<(Uuid, Known)>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Mode {
    Replace,
    Extend,
    Difference,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Poll {
    session: Uuid,
    url: reqwest::Url,
    mode: Mode,
    remember: Vec<u64>,
    forget: Vec<u64>,
}

#[derive(Deserialize)]
struct Response {
    result: Option<Vec<u64>>,
    error: Option<String>,
}

impl Notes {
    pub fn backend_exited(&self) {
        if let Ok(mut active) = self.0.lock() {
            active.take();
        }
    }

    fn known(&self, session: Uuid) -> Result<Known, String> {
        let mut current = self.0.lock().map_err(|_| "Anki tracker unavailable")?;
        if current.as_ref().is_none_or(|(id, _)| *id != session) {
            *current = Some((session, Known::default()));
        }
        Ok(Arc::clone(
            &current.as_ref().ok_or("Anki tracker unavailable")?.1,
        ))
    }

    async fn recent(client: &reqwest::Client, url: &reqwest::Url) -> Result<Vec<u64>, String> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Invalid AnkiConnect URL".into());
        }
        let body = client
            .post(url.clone())
            .json(&json!({"action":"findNotes","version":6,"params":{"query":"added:1"}}))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| e.without_url().to_string())?
            .bytes()
            .await
            .map_err(|e| e.without_url().to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let response: Response = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
            if let Some(error) = response.error {
                return Err(error);
            }
            response
                .result
                .ok_or_else(|| "AnkiConnect returned no notes result".into())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn apply(
        known: Known,
        ids: Vec<u64>,
        mode: Mode,
        remember: Vec<u64>,
        forget: Vec<u64>,
    ) -> Result<Vec<u64>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let mut known = known.lock().map_err(|_| "Anki tracker unavailable")?;
            known.extend(remember);
            for id in forget {
                known.remove(&id);
            }
            if matches!(mode, Mode::Difference) {
                // A lost reply must not consume a card. The miner acknowledges
                // handled notes on its next poll. Very large imports drain over
                // successive polls so they always fit in an 8 MiB broker frame.
                let difference: Vec<_> = ids
                    .into_iter()
                    .filter(|id| !known.contains(id))
                    .take(300_000)
                    .collect();
                return Ok(difference);
            }
            if matches!(mode, Mode::Replace) {
                known.clear();
            }
            known.extend(ids);
            Ok(Vec::new())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn poll(&self, client: &reqwest::Client, poll: Poll) -> Result<Value, String> {
        let known = self.known(poll.session)?;
        let ids = Self::recent(client, &poll.url).await?;
        Ok(json!(
            Self::apply(known, ids, poll.mode, poll.remember, poll.forget).await?
        ))
    }
}
