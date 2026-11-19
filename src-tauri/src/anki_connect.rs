//! One AnkiConnect attempt. Only an explicit collection-busy response is retryable.
use serde::Deserialize;
use serde_json::{json, value::RawValue, Value};
use std::time::Duration;

pub const BUSY: &str = "A collection operation is active.";

pub struct Collection<'a> {
    pub client: &'a reqwest::Client,
    pub url: &'a reqwest::Url,
}

impl Collection<'_> {
    pub async fn call<T: Send + 'static>(
        &self,
        action: &str,
        params: Value,
        parse: impl FnOnce(&RawValue) -> Result<T, String> + Clone + Send + 'static,
    ) -> Result<T, String> {
        let body = json!({"version":6, "action":action, "params":params});
        let mut delay = 1;
        loop {
            if let Some(reply) = attempt(self.client, self.url, &body, parse.clone()).await? {
                return Ok(reply);
            }
            tokio::time::sleep(Duration::from_secs(delay)).await;
            delay = (delay * 2).min(5);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply<'a> {
    #[serde(borrow)]
    result: &'a RawValue,
    error: Value,
}

pub async fn attempt<T: Send + 'static>(
    client: &reqwest::Client,
    url: &reqwest::Url,
    body: &Value,
    parse: impl FnOnce(&RawValue) -> Result<T, String> + Send + 'static,
) -> Result<Option<T>, String> {
    let bytes = client
        .post(url.clone())
        .json(body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.without_url().to_string())?
        .bytes()
        .await
        .map_err(|e| e.without_url().to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let reply: Reply = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if reply.error == BUSY {
            return Ok(None);
        }
        if !reply.error.is_null() {
            return Err(reply
                .error
                .as_str()
                .unwrap_or("AnkiConnect rejected request")
                .to_owned());
        }
        parse(reply.result).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
