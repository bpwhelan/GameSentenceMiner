//! Game-library searches share the desktop HTTP pool. Each provider answers
//! independently so one outage still leaves the other sources usable.
mod characters;
mod detail;
mod refresh;
mod repull;
pub(crate) mod upgrade;
pub(crate) use refresh::sync;
pub(crate) mod dictionary;
mod igdb;
mod jiten;
mod link;
pub(crate) use link::link;
mod search_results;
use futures_util::{stream::FuturesUnordered, StreamExt};
use gsm_mining::gateway::{MediaSearch, StatusCode};
use reqwest::{Client, RequestBuilder};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tauri::{AppHandle, Manager};

struct Sources {
    http: Client,
    jiten: String,
    vndb: String,
    anilist: String,
    cloud: String,
}

impl Sources {
    fn new(http: Client, cloud: Option<String>) -> Self {
        let mut urls = Self {
            http,
            jiten: "https://api.jiten.moe/api/media-deck".into(),
            vndb: "https://api.vndb.org/kana".into(),
            anilist: "https://graphql.anilist.co".into(),
            cloud: cloud.unwrap_or_else(|| "https://api.gamesentenceminer.com".into()),
        };
        if std::env::var("GSM_SMOKE_TEST").as_deref() == Ok("1") {
            if let Some(port) = std::env::var("GSM_SMOKE_MEDIA_PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
            {
                let base = format!("http://127.0.0.1:{port}");
                urls.jiten = format!("{base}/media-deck");
                urls.vndb = format!("{base}/kana");
                urls.anilist = format!("{base}/graphql");
                urls.cloud = base;
            }
        }
        urls
    }

    async fn for_search(app: &AppHandle, cloud: bool) -> Self {
        let http = app
            .state::<crate::desktop_state::DesktopState>()
            .http
            .clone();
        let mut configured = None;
        if cloud {
            let path = app
                .state::<crate::settings::Settings>()
                .paths
                .active
                .join("config.json");
            if let Ok(Ok(Some(value))) = tokio::task::spawn_blocking(move || {
                let root = gsm_settings::read_object(&path)?;
                Ok::<_, String>(
                    gsm_settings::gsm_config::active_profile(&root)
                        .and_then(|p| p.get("ai")?["gsm_cloud_api_url"].as_str())
                        .map(|v| v.trim().trim_end_matches('/'))
                        .filter(|v| !v.is_empty())
                        .map(str::to_owned),
                )
            })
            .await
            {
                configured = Some(value);
            }
        }
        Self::new(http, configured)
    }

    async fn jiten_decks(&self, title: &str) -> Option<Value> {
        get_json(
            self.http
                .get(format!("{}/get-media-decks", self.jiten))
                .query(&[
                    ("titleFilter", title),
                    ("sortBy", "title"),
                    ("sortOrder", "0"),
                    ("offset", "0"),
                ]),
            10,
        )
        .await
    }

    async fn results(&self, provider: Provider, query: &str) -> Option<Group> {
        let (mut data, field, normalize) = match provider {
            Provider::Jiten => {
                let mut data = self.jiten_decks(query).await?;
                let rows = take_rows(&mut data, "/data");
                let total = data
                    .get("totalItems")
                    .cloned()
                    .unwrap_or_else(|| rows.len().into());
                return Some(Group {
                    results: rows.into_iter().map(jiten::search_result).collect(),
                    total,
                    error: None,
                });
            }
            Provider::Vndb => {
                let request=self.http.post(format!("{}/vn",self.vndb)).json(&json!({
                    "filters":["search","=",query],"fields":"id, title, alttitle, released, rating, description, image.url, developers.name",
                    "sort":"rating","reverse":true,"results":10}));
                (
                    get_json(request, 10).await?,
                    "/results",
                    search_results::vndb as fn(Value) -> Value,
                )
            }
            Provider::Igdb => {
                let data = self
                    .igdb_request("search", json!({"query":query,"limit":10}))
                    .await?;
                data["results"].as_array()?;
                (data, "/results", search_results::igdb as fn(Value) -> Value)
            }
            Provider::Anime | Provider::Manga => {
                let kind = if matches!(provider, Provider::Anime) {
                    "ANIME"
                } else {
                    "MANGA"
                };
                let request=self.http.post(&self.anilist).header("Accept","application/json")
                    .json(&json!({"query":search_results::ANILIST_QUERY,"variables":{"search":query,"type":kind}}));
                let mut data = get_json(request, 15).await?;
                if data.get("errors").is_some() {
                    return None;
                }
                let rows = take_rows(&mut data, "/data/Page/media");
                let results = rows
                    .into_iter()
                    .map(|row| search_results::anilist(row, kind))
                    .collect();
                return Some(Group::new(results));
            }
        };
        let rows = take_rows(&mut data, field);
        Some(Group::new(rows.into_iter().map(normalize).collect()))
    }
}

async fn get_json(request: RequestBuilder, seconds: u64) -> Option<Value> {
    let response = request
        .timeout(Duration::from_secs(seconds))
        .send()
        .await
        .ok()?;
    if response.status() != StatusCode::OK {
        return None;
    }
    let value: Value = response.json().await.ok()?;
    value.as_object().filter(|obj| !obj.is_empty())?;
    Some(value)
}

fn take_rows(data: &mut Value, field: &str) -> Vec<Value> {
    data.pointer_mut(field)
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .unwrap_or_default()
}

#[derive(Clone, Copy)]
enum Provider {
    Jiten,
    Vndb,
    Igdb,
    Anime,
    Manga,
}
impl Provider {
    fn key(self) -> &'static str {
        match self {
            Self::Jiten => "jiten",
            Self::Vndb => "vndb",
            Self::Igdb => "igdb",
            Self::Anime | Self::Manga => "anilist",
        }
    }
    fn unavailable(self) -> &'static str {
        match self {
            Self::Jiten => "Failed to fetch from Jiten.moe",
            Self::Vndb => "Failed to fetch from VNDB",
            Self::Igdb => "Failed to fetch from IGDB",
            Self::Anime | Self::Manga => "Failed to fetch from AniList",
        }
    }
}

#[derive(Serialize)]
struct Group {
    results: Vec<Value>,
    total: Value,
    error: Option<&'static str>,
}
impl Group {
    fn new(results: Vec<Value>) -> Self {
        Self {
            total: results.len().into(),
            results,
            error: None,
        }
    }
    fn empty(error: &'static str) -> Self {
        Self {
            total: 0.into(),
            results: Vec::new(),
            error: Some(error),
        }
    }
}

pub(crate) async fn search(app: &AppHandle, search: MediaSearch) -> (StatusCode, Vec<u8>) {
    let cloud =
        matches!(&search,MediaSearch::Unified{sources,..} if sources.iter().any(|s|s=="igdb"));
    let clients = Sources::for_search(app, cloud).await;
    match search {
        MediaSearch::Jiten(query) => {
            let Some(mut data) = clients.jiten_decks(&query).await else {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    br#"{"error":"Failed to search jiten.moe database"}"#.to_vec(),
                );
            };
            let rows: Vec<_> = take_rows(&mut data, "/data")
                .into_iter()
                .map(jiten::normalize)
                .collect();
            let body = json!({"results":rows,"total_items":data.get("totalItems").cloned().unwrap_or(0.into())});
            (StatusCode::OK, serde_json::to_vec(&body).unwrap())
        }
        MediaSearch::Unified { query, sources } => {
            (StatusCode::OK, unified(&clients, &query, &sources).await)
        }
    }
}

async fn unified(clients: &Sources, query: &str, sources: &[String]) -> Vec<u8> {
    let mut work = FuturesUnordered::new();
    for provider in [
        Provider::Jiten,
        Provider::Vndb,
        Provider::Igdb,
        Provider::Anime,
        Provider::Manga,
    ] {
        if sources.iter().any(|s| s == provider.key()) {
            work.push(async move {
                (
                    provider,
                    clients
                        .results(provider, query)
                        .await
                        .unwrap_or_else(|| Group::empty(provider.unavailable())),
                )
            });
        }
    }
    let mut groups = BTreeMap::<&str, Group>::new();
    let mut order = Vec::new();
    while let Some((provider, group)) = work.next().await {
        let key = provider.key();
        if let Some(combined) = groups.get_mut(key) {
            combined.results.extend(group.results);
            combined.total = combined.results.len().into();
            combined.error = combined.error.or(group.error);
        } else {
            order.push(key);
            groups.insert(key, group);
        }
    }
    for key in sources.iter().map(String::as_str) {
        groups.entry(key).or_insert_with(|| {
            order.push(key);
            Group::empty("No results")
        });
    }
    // The API exposes the same results twice. Borrow them during serialization
    // so the nested raw provider records only occupy the heap once.
    #[derive(Serialize)]
    struct Unified<'a> {
        results: Vec<&'a Value>,
        by_source: &'a BTreeMap<&'a str, Group>,
        query: &'a str,
        sources_searched: Vec<&'a str>,
    }
    let flat = order
        .iter()
        .flat_map(|key| groups[key].results.iter())
        .collect();
    serde_json::to_vec(&Unified {
        results: flat,
        by_source: &groups,
        query,
        sources_searched: order,
    })
    .unwrap()
}
