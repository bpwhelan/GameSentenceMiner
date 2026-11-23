//! Synchronize collection data without holding a SQLite writer during HTTP.
use gsm_history::anki_sync::{self, Cache, Card, Note, Review};
use serde::Deserialize;
use serde_json::{json, value::RawValue, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::{watch, Mutex};

const STOPPED: &str = "Anki sync stopped with the backend session";

#[derive(Clone, Default)]
pub struct SyncLane {
    writer: Arc<Mutex<()>>,
    owner: watch::Sender<Option<u64>>,
    database: watch::Sender<Option<u64>>,
}

impl SyncLane {
    pub fn database_closing(&self) {
        self.database
            .send_modify(|v| *v = Some(v.unwrap_or(0).wrapping_add(1)));
    }

    pub async fn scheduled(
        &self,
        client: &reqwest::Client,
        cache: Cache,
        config: &Value,
    ) -> Result<(), String> {
        let profile = gsm_mining::config::ProfileConfig::from_config_json(config)?;
        let request = Request::full(cache.generation, profile.anki)?;
        let mut owner = self.database.subscribe();
        let _guard = tokio::select! {
            biased;
            _ = owner.changed() => return Err("Anki sync stopped because the database closed".into()),
            guard = self.writer.lock() => guard,
        };
        Sync {
            client,
            request,
            cache,
            owner,
        }
        .run()
        .await?;
        Ok(())
    }
    pub fn session(&self, epoch: u64) -> Result<watch::Receiver<Option<u64>>, String> {
        let owner = self.owner.subscribe();
        if *owner.borrow() != Some(epoch) {
            return Err(STOPPED.into());
        }
        Ok(owner)
    }

    pub fn connection(&self, epoch: Option<u64>) {
        self.owner.send_replace(epoch);
    }

    pub fn stop(&self, epoch: u64) {
        self.owner.send_if_modified(|owner| {
            if *owner != Some(epoch) {
                return false;
            }
            *owner = None;
            true
        });
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    generation: u64,
    url: reqwest::Url,
    field: String,
    query: String,
    notes: Option<Vec<i64>>,
}

impl Request {
    fn full(generation: u64, config: gsm_mining::config::AnkiConfig) -> Result<Self, String> {
        let field = config.word.name;
        let query = anki_sync::collection_query(&field, &config.note_type)
            .ok_or("Anki word field is empty")?;
        let url: reqwest::Url = config
            .url
            .parse()
            .map_err(|e| format!("Invalid AnkiConnect URL: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Invalid AnkiConnect URL".into());
        }
        Ok(Self {
            generation,
            url,
            field,
            query,
            notes: None,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireNote<'a> {
    #[serde(deserialize_with = "anki_sync::integer")]
    note_id: i64,
    #[serde(default)]
    model_name: String,
    #[serde(default, borrow)]
    fields: Option<&'a RawValue>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, rename = "mod")]
    modified: i64,
}

fn notes(raw: &RawValue, field: &str) -> Result<Vec<Note>, String> {
    #[derive(Deserialize)]
    struct Field {
        value: String,
    }
    let rows: Vec<&RawValue> = decode(raw)?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let n: WireNote = serde_json::from_str(r.get()).ok()?;
            let fields: Option<HashMap<String, &RawValue>> =
                n.fields.and_then(|raw| decode(raw).ok());
            let selected = fields
                .as_ref()
                .and_then(|values| values.get(field))
                .and_then(|data| decode::<Field>(data).ok());
            Some(Note {
                id: n.note_id,
                model: n.model_name,
                tags: n.tags,
                modified: n.modified,
                fields_json: anki_sync::cached_fields(
                    field,
                    selected.as_ref().map(|f| f.value.as_str()),
                ),
            })
        })
        .collect())
}

fn cards(raw: &RawValue) -> Result<Vec<Card>, String> {
    let rows: Vec<&RawValue> = decode(raw)?;
    Ok(rows
        .into_iter()
        .filter_map(|row| serde_json::from_str(row.get()).ok())
        .collect())
}
fn decode<'a, T: Deserialize<'a>>(raw: &'a RawValue) -> Result<T, String> {
    serde_json::from_str(raw.get()).map_err(|e| e.to_string())
}

struct Sync<'a> {
    client: &'a reqwest::Client,
    request: Request,
    cache: Cache,
    owner: watch::Receiver<Option<u64>>,
}

impl Sync<'_> {
    async fn database<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Cache) -> gsm_history::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        if self.owner.has_changed().unwrap_or(true) {
            return Err(STOPPED.into());
        }
        let cache = self.cache.clone();
        tauri::async_runtime::spawn_blocking(move || work(&cache).map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?
    }

    async fn fetch<T: Send + 'static, F>(
        &self,
        action: &str,
        params: Value,
        parser: F,
    ) -> Result<T, String>
    where
        F: FnOnce(&RawValue) -> Result<T, String> + Clone + Send + 'static,
    {
        let mut owner = self.owner.clone();
        tokio::select! {
            biased;
            _ = owner.changed() => Err(STOPPED.into()),
            reply = self.fetch_page(action, params, parser) => reply,
        }
    }

    async fn fetch_page<T: Send + 'static, F>(
        &self,
        action: &str,
        params: Value,
        parser: F,
    ) -> Result<T, String>
    where
        F: FnOnce(&RawValue) -> Result<T, String> + Clone + Send + 'static,
    {
        let body = json!({"version":6,"action":action,"params":params});
        let mut delay = 1;
        loop {
            let result =
                crate::anki_connect::attempt(self.client, &self.request.url, &body, parser.clone())
                    .await?;
            if let Some(result) = result {
                return Ok(result);
            }
            tokio::time::sleep(Duration::from_secs(delay)).await;
            self.database(Cache::check).await?;
            delay = (delay * 2).min(5);
        }
    }

    async fn ids(&self, action: &str, query: &str) -> Result<Vec<i64>, String> {
        self.fetch(action, json!({"query":query}), |r| decode(r))
            .await
            .map_err(|e| {
                if e == STOPPED {
                    e
                } else {
                    "AnkiConnect unreachable".into()
                }
            })
    }

    async fn run(&self) -> Result<Value, String> {
        self.database(Cache::check).await?;
        let full = self.request.notes.is_none();
        let (note_ids, mut card_ids) = if let Some(requested) = &self.request.notes {
            let mut scoped = Vec::new();
            let mut seen = HashSet::new();
            for page in requested.chunks(500) {
                let query = format!("({}) ({})", self.request.query, nid_query(page));
                let matches: HashSet<_> =
                    self.ids("findNotes", &query).await?.into_iter().collect();
                scoped.extend(
                    page.iter()
                        .copied()
                        .filter(|id| matches.contains(id) && seen.insert(*id)),
                );
            }
            if scoped.is_empty() {
                return Err("no matching notes in sync scope".into());
            }
            (scoped, Vec::new())
        } else {
            (
                self.ids("findNotes", &self.request.query).await?,
                self.ids("findCards", &self.request.query).await?,
            )
        };
        let mut notes_upserted = 0;
        for page in note_ids.chunks(500) {
            let field = self.request.field.clone();
            let rows = self
                .fetch("notesInfo", json!({"notes":page}), move |r| {
                    notes(r, &field)
                })
                .await;
            if let Some(mut rows) = page_result(rows, full, "notesInfo")? {
                validate_batch(&mut rows, page, full, |n| n.id, "notesInfo")?;
                notes_upserted += self.database(move |cache| cache.notes(rows)).await?;
            }
        }
        if !full {
            for page in note_ids.chunks(500) {
                card_ids.extend(self.ids("findCards", &nid_query(page)).await?);
            }
        }
        let mut cards_upserted = 0;
        for page in card_ids.chunks(500) {
            if let Some(mut rows) = page_result(
                self.fetch("cardsInfo", json!({"cards":page}), cards).await,
                full,
                "cardsInfo",
            )? {
                validate_batch(&mut rows, page, full, |c| c.card_id, "cardsInfo")?;
                cards_upserted += self.database(move |cache| cache.cards(rows)).await?;
            }
        }
        let mut reviews_upserted = 0;
        for page in card_ids.chunks(100) {
            let rows = self
                .fetch("getReviewsOfCards", json!({"cards":page}), |r| {
                    decode::<HashMap<String, Vec<Review>>>(r)
                })
                .await;
            if let Some(rows) = page_result(rows, full, "cardReviews")? {
                reviews_upserted += self
                    .database(move |cache| cache.reviews(rows, full))
                    .await?;
            }
        }
        let note_ids = Arc::new(note_ids);
        let deletion = if full {
            let live = note_ids.clone();
            Some(
                self.database(move |cache| cache.prune(&live, &card_ids))
                    .await?,
            )
        } else {
            None
        };
        let mut links = (0, 0);
        for page in note_ids.chunks(500) {
            let ids = page.to_vec();
            let field = self.request.field.clone();
            let (words, kanji) = self
                .database(move |cache| cache.links(&ids, &field))
                .await?;
            links.0 += words;
            links.1 += kanji;
        }
        let flags = self.database(Cache::flags).await?;
        let mut summary = json!({"skipped":false,"notes_upserted":notes_upserted,"cards_upserted":cards_upserted,"reviews_upserted":reviews_upserted,"word_links":links.0,"kanji_links":links.1,"flags_updated":flags});
        if let Some(deletion) = deletion {
            summary["deletion"] = json!(deletion);
        }
        Ok(summary)
    }
}

fn nid_query(ids: &[i64]) -> String {
    ids.iter()
        .map(|id| format!("nid:{id}"))
        .collect::<Vec<_>>()
        .join(" OR ")
}
fn validate_batch<T>(
    rows: &mut Vec<T>,
    requested: &[i64],
    strict: bool,
    id: impl Fn(&T) -> i64,
    action: &str,
) -> Result<(), String> {
    let mut missing: HashSet<_> = requested.iter().copied().collect();
    rows.retain(|row| missing.remove(&id(row)));
    if strict && !missing.is_empty() {
        return Err(format!(
            "{action} did not return {} requested records",
            missing.len()
        ));
    }
    Ok(())
}
fn page_result<T>(
    result: Result<T, String>,
    strict: bool,
    action: &str,
) -> Result<Option<T>, String> {
    match result {
        Ok(page) => Ok(Some(page)),
        Err(error) if error == STOPPED => Err(error),
        Err(error) if strict => Err(format!("{action} failed via AnkiConnect: {error}")),
        Err(error) => {
            eprintln!("[anki-sync] Skipping {action} page: {error}");
            Ok(None)
        }
    }
}

pub(crate) fn trigger_incremental(
    app: AppHandle,
    url: reqwest::Url,
    word_field: String,
    parent_tag: String,
    note_ids: Vec<i64>,
) {
    if note_ids.is_empty()
        || word_field.trim().is_empty()
        || !matches!(url.scheme(), "http" | "https")
    {
        return;
    }
    let query = if parent_tag.trim().is_empty() {
        format!("\"{}:_*\"", word_field.replace('"', "\\\""))
    } else {
        format!(
            "tag:{} \"{}:_*\"",
            parent_tag.trim(),
            word_field.replace('"', "\\\"")
        )
    };
    tauri::async_runtime::spawn(async move {
        let lane = app.state::<SyncLane>();
        let owner = lane.owner.subscribe();
        let _guard = lane.writer.lock().await;
        let history = app.state::<Arc<gsm_history::History>>().inner().clone();
        let generation = match history.generation() {
            Ok(gen_id) => gen_id,
            Err(_) => return,
        };
        let path = app
            .state::<crate::settings::Settings>()
            .paths
            .active
            .join("gsm.db");
        if !path.is_file() {
            return;
        }
        let state = app.state::<crate::desktop_state::DesktopState>();
        let sync = Sync {
            client: &state.http,
            request: Request {
                generation,
                url,
                field: word_field,
                query,
                notes: Some(note_ids),
            },
            cache: Cache {
                history,
                path,
                generation,
            },
            owner,
        };
        if let Err(err) = sync.run().await {
            crate::desktop_log::info(
                &app,
                "anki-sync",
                format!("Incremental sync skipped: {err}"),
            );
        }
    });
}

pub async fn request(app: &AppHandle, epoch: u64, payload: Value) -> Result<Value, String> {
    let request: Request = serde_json::from_value(payload).map_err(|e| e.to_string())?;
    if !matches!(request.url.scheme(), "http" | "https") {
        return Err("Invalid AnkiConnect URL".into());
    }
    let lane = app.state::<SyncLane>();
    let stopped = || json!({"skipped":true,"reason":STOPPED});
    let Ok(mut owner) = lane.session(epoch) else {
        return Ok(stopped());
    };
    let _session = tokio::select! {
        biased;
        _ = owner.changed() => return Ok(stopped()),
        guard = lane.writer.lock() => guard,
    };
    let state = app.state::<crate::desktop_state::DesktopState>();
    let cache = Cache {
        history: app.state::<Arc<gsm_history::History>>().inner().clone(),
        path: app
            .state::<crate::settings::Settings>()
            .paths
            .active
            .join("gsm.db"),
        generation: request.generation,
    };
    Ok(Sync {
        client: &state.http,
        request,
        cache,
        owner,
    }
    .run()
    .await
    .unwrap_or_else(|reason| json!({"skipped":true,"reason":reason})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_scope_uses_the_configured_word_field_and_quoted_note_type() {
        let mut config = gsm_mining::config::AnkiConfig::default();
        config.word.name = " 単語 ".into();
        config.note_type = r#"  Mining "A"  "#.into();
        let request = Request::full(17, config.clone()).unwrap();
        assert_eq!(request.query, r#"単語:_* note:"Mining \"A\"""#);
        assert_eq!(request.field, " 単語 ");
        assert!(request.notes.is_none());
        config.word.name.clear();
        assert!(Request::full(18, config).is_err());
    }

    #[tokio::test]
    async fn shutdown_interrupts_a_pending_anki_request_and_old_stops_cannot_cancel_a_reconnect() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let lane = SyncLane::default();
        lane.connection(Some(8));
        let client = reqwest::Client::new();
        let sync = Sync {
            client: &client,
            request: Request {
                url,
                generation: 0,
                field: "Word".into(),
                query: "Word:_*".into(),
                notes: None,
            },
            cache: Cache {
                path: Default::default(),
                generation: 0,
                history: Default::default(),
            },
            owner: lane.owner.subscribe(),
        };
        let stop = async {
            let _connection = listener.accept().await.unwrap();
            lane.stop(8);
            lane.connection(Some(9));
            lane.stop(8);
            assert_eq!(*lane.owner.borrow(), Some(9));
        };
        let work = async { sync.ids("findNotes", "Word:_*").await };
        let (reply, ()) =
            tokio::time::timeout(Duration::from_secs(3), async { tokio::join!(work, stop) })
                .await
                .expect("backend shutdown must wake a pending Anki request");
        assert_eq!(reply.unwrap_err(), STOPPED);
    }

    #[test]
    fn note_pages_keep_only_the_configured_value_and_accept_missing_fields() {
        let input = RawValue::from_string(
            json!([
                {"noteId":"10","tags":["日本"],"fields":{
                    "a.b":{"value":"猫","order":3},"Audio":{"value":"[sound:foo.mp3]"}
                }},
                {"noteId":11,"fields":null}, {"noteId":12,"fields":{"a.b":{"value":17}}},
                {}, null
            ])
            .to_string(),
        )
        .unwrap();
        let rows = notes(&input, "a.b").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].id, 10);
        assert_eq!(rows[0].fields_json, r#"{"a.b":{"value":"猫"}}"#);
        assert_eq!(rows[0].tags, ["日本"]);
        assert!(rows[1..].iter().all(|n| n.fields_json == "{}"));
    }

    #[test]
    fn full_pages_require_every_requested_id_before_writing() {
        let input = RawValue::from_string(
            json!([
                {"cardId":"84","question":"unused"}, {"cardId":84}, {"cardId":99}, {}
            ])
            .to_string(),
        )
        .unwrap();
        let mut rows = cards(&input).unwrap();
        assert!(validate_batch(&mut rows, &[84, 85], true, |c| c.card_id, "cardsInfo").is_err());
        assert_eq!(rows.len(), 1);
        let mut rows = cards(&input).unwrap();
        validate_batch(&mut rows, &[84, 85], false, |c| c.card_id, "cardsInfo").unwrap();
        assert_eq!(rows.iter().map(|c| c.card_id).collect::<Vec<_>>(), [84]);
    }
}
