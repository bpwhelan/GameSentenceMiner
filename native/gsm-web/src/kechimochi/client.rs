use crate::Result;
use reqwest::{
    blocking::{multipart, Client, RequestBuilder},
    header::{ACCEPT, CONTENT_TYPE},
    redirect, Method, Url,
};
use serde_json::Value;
use std::{collections::HashSet, fmt, sync::OnceLock, time::Duration};

pub(super) const DEFAULT_URL: &str = "http://127.0.0.1:3031";
pub(super) fn normalize(value: &Value) -> std::result::Result<String, &'static str> {
    const INVALID: &str =
        "Use an http:// or https:// URL without credentials, query parameters, or fragments";
    let raw = value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("Enter the Kechimochi HTTP API URL")?;
    let (scheme, rest) = raw.split_once("://").ok_or(INVALID)?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https")
        || raw.chars().any(char::is_whitespace)
        || raw.contains('\\')
    {
        return Err(INVALID);
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') {
        return Err(INVALID);
    }
    let url = Url::parse(raw).map_err(|_| "Invalid Kechimochi HTTP API URL")?;
    if url.host().is_none()
        || url.port() == Some(0)
        || url.query().is_some_and(|s| !s.is_empty())
        || url.fragment().is_some_and(|s| !s.is_empty())
    {
        return Err(INVALID);
    }
    let path = rest[end..]
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    Ok(format!(
        "{scheme}://{}{}",
        authority.to_lowercase(),
        path.strip_suffix("/api").unwrap_or(path)
    ))
}

#[derive(Debug)]
pub(super) struct HttpError {
    pub code: u16,
    message: String,
}
impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for HttpError {}
const OFFLINE: &str =
    "Could not reach Kechimochi. Open it and enable its HTTP API; the next sync will retry safely.";

pub(super) struct Remote {
    base: String,
    http: &'static Client,
}
impl Remote {
    pub fn new(base: &str) -> Result<Self> {
        static HTTP: OnceLock<Client> = OnceLock::new();
        let http = if let Some(http) = HTTP.get() {
            http
        } else {
            let http = Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(30))
                .redirect(redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()?;
            HTTP.get_or_init(|| http)
        };
        Ok(Self {
            base: base.into(),
            http,
        })
    }
    fn send(
        &self,
        method: Method,
        path: &str,
        apply: impl FnOnce(RequestBuilder) -> RequestBuilder,
    ) -> Result<Value> {
        let request = self
            .http
            .request(method.clone(), format!("{}/api/{path}", self.base))
            .header(ACCEPT, "application/json")
            .header("X-Kechimochi-API", "1");
        let response = apply(request).send().map_err(|_| OFFLINE)?;
        let code = response.status();
        if !code.is_success() {
            let plain = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.split(';').next())
                .is_some_and(|s| s.trim().eq_ignore_ascii_case("text/plain"));
            let body = response.text().unwrap_or_default();
            let parsed = serde_json::from_str::<Value>(&body).ok();
            let detail = match &parsed {
                Some(Value::String(s)) => s.as_str(),
                Some(Value::Object(obj)) => ["error", "message", "detail"]
                    .into_iter()
                    .find_map(|k| obj.get(k)?.as_str())
                    .unwrap_or(""),
                None if plain => &body,
                _ => "",
            };
            let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
            let detail = if detail.chars().count() > 500 {
                format!("{}...", detail.chars().take(497).collect::<String>())
            } else {
                detail
            };
            let hint = match code.as_u16() {
                403 => "Check the HTTP API scope and allowed address in Kechimochi.",
                404 => "Check that this URL points to the Kechimochi HTTP API.",
                _ => "",
            };
            let message = [
                &format!(
                    "Kechimochi {method} {path} failed (HTTP {}).",
                    code.as_u16()
                ),
                &detail,
                hint,
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            return Err(HttpError {
                code: code.as_u16(),
                message,
            }
            .into());
        }
        response
            .json()
            .map_err(|_| "Kechimochi returned an invalid JSON response".into())
    }
    pub fn version(&self) -> Result<String> {
        self.send(Method::GET, "version", |r| r)?
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Kechimochi returned an invalid API version".into())
    }
    pub fn list(&self, path: &str) -> Result<Vec<Value>> {
        let fields: &[&str] = match path {
            "media" => &["title", "extra_data", "language", "content_type"],
            "logs" => &[
                "media_id",
                "date",
                "characters",
                "duration_minutes",
                "notes",
                "activity_type",
            ],
            _ => return Err("Unknown Kechimochi collection".into()),
        };
        let invalid = || format!("Kechimochi returned an invalid {path} list");
        let Value::Array(rows) = self.send(Method::GET, path, |r| r)? else {
            return Err(invalid().into());
        };
        let mut ids = HashSet::new();
        for row in &rows {
            let id = row["id"].as_u64().filter(|v| *v > 0).ok_or_else(invalid)?;
            if !fields.iter().all(|k| row.get(k).is_some()) {
                return Err(invalid().into());
            }
            if !ids.insert(id) {
                return Err(format!("Kechimochi returned duplicate IDs in {path}").into());
            }
        }
        Ok(rows)
    }
    pub fn save(&self, path: &str, payload: &mut Value, id: Option<u64>) -> Result<u64> {
        payload["id"] = id.into();
        if let Some(id) = id {
            self.send(Method::PUT, &format!("{path}/{id}"), |r| r.json(payload))?;
            return Ok(id);
        }
        self.send(Method::POST, path, |r| r.json(payload))?
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or_else(|| {
                format!("Kechimochi did not return the new {path} ID; retry to reconcile it").into()
            })
    }
    pub fn remove(&self, id: u64) -> Result<()> {
        self.send(Method::DELETE, &format!("logs/{id}"), |r| r)?;
        Ok(())
    }
    pub fn cover(&self, id: u64, data: Vec<u8>) -> Result<String> {
        let file = multipart::Part::bytes(data)
            .file_name("gsm-cover.jpg")
            .mime_str("image/jpeg")?;
        self.send(Method::POST, &format!("covers/{id}"), |r| {
            r.multipart(multipart::Form::new().part("file", file))
        })?["path"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Kechimochi returned an invalid cover path".into())
    }
}
