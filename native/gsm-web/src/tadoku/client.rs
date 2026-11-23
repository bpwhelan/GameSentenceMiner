use crate::Result;
use reqwest::{
    blocking::{Client, Response},
    header::{COOKIE, SET_COOKIE},
    Method, Url,
};
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};

static HTTP: OnceLock<Client> = OnceLock::new();
fn http() -> Result<&'static Client> {
    if let Some(http) = HTTP.get() {
        return Ok(http);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let first = attempt.previous().first();
            if attempt.previous().len() < 10
                && first.is_some_and(|u| u.origin() == attempt.url().origin())
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()?;
    Ok(HTTP.get_or_init(|| client))
}

pub(super) struct Session {
    base: Url,
    email: String,
    password: String,
    pub cookie: String,
}
impl Session {
    pub fn new(stats: &Value) -> Self {
        let port = (std::env::var("GSM_SMOKE_TEST").as_deref() == Ok("1"))
            .then(|| {
                std::env::var("GSM_SMOKE_TADOKU_PORT")
                    .ok()?
                    .parse::<u16>()
                    .ok()
            })
            .flatten();
        let origin = port.map_or_else(
            || "https://tadoku.app".into(),
            |p| format!("http://127.0.0.1:{p}"),
        );
        Self {
            base: Url::parse(&origin).expect("fixed Tadoku origin"),
            email: stats["tadoku_username"]
                .as_str()
                .unwrap_or("")
                .trim()
                .into(),
            password: stats["tadoku_password"].as_str().unwrap_or("").into(),
            cookie: stats["tadoku_session_cookie"]
                .as_str()
                .unwrap_or("")
                .trim()
                .into(),
        }
    }
    pub fn configured(&self) -> bool {
        !self.email.is_empty() && !self.password.is_empty()
    }
    pub fn same_account(&self, stats: &Value) -> bool {
        stats["tadoku_username"].as_str().unwrap_or("").trim() == self.email
            && stats["tadoku_password"].as_str() == Some(self.password.as_str())
    }
    fn cookies(&mut self, reply: &Response) {
        for header in reply.headers().get_all(SET_COOKIE) {
            let Some(value) = header
                .to_str()
                .ok()
                .and_then(|s| s.split(';').next())
                .and_then(|s| s.trim().strip_prefix("tadoku_session="))
            else {
                continue;
            };
            self.cookie = value.to_owned();
        }
    }
    pub fn login(&mut self) -> Result<()> {
        if !self.configured() {
            return Err("Tadoku email and password are not configured".into());
        }
        self.cookie.clear();
        let login = http()?
            .post(self.base.join("api/internal/identity/login")?)
            .header("Origin", self.base.origin().ascii_serialization())
            .header("Accept", "application/json")
            .json(&json!({"email":self.email,"password":self.password}))
            .send()
            .map_err(|e| format!("Could not reach Tadoku login: {e}"))?;
        if !login.status().is_success() {
            return Err(match login.status().as_u16(){
                401=>"Tadoku login failed; check the saved email and password. Use your email address, not your display name.".into(),
                429=>"Too many Tadoku sign-in attempts; wait 15 minutes before trying again".into(),
                503=>"Tadoku sign-in is temporarily unavailable; try again later".into(),
                code=>format!("Tadoku login failed (HTTP {code})").into(),
            });
        }
        self.cookies(&login);
        if self.cookie.is_empty() {
            return Err("Tadoku login did not return a browser session cookie".into());
        }
        Ok(())
    }
    fn request(
        &mut self,
        method: Method,
        segments: &[&str],
        body: Option<&Value>,
    ) -> Result<Value> {
        if !self.configured() {
            return Err("Tadoku email and password are not configured".into());
        }
        if self.cookie.is_empty() {
            self.login()?;
        }
        let mut url = self.base.join("api/internal/immersion")?;
        url.path_segments_mut()
            .expect("fixed HTTP URL")
            .extend(segments);
        let send = |cookie: &str| -> Result<Response> {
            let mut req = http()?
                .request(method.clone(), url.clone())
                .header(COOKIE, format!("tadoku_session={cookie}"));
            if let Some(body) = body {
                req = req.json(body);
            }
            req.send()
                .map_err(|e| format!("Could not reach Tadoku: {e}").into())
        };
        let mut response = send(&self.cookie)?;
        if response.status() == 401 {
            self.login()?;
            response = send(&self.cookie)?;
        }
        self.cookies(&response);
        let code = response.status();
        if !code.is_success() {
            let detail = response
                .text()?
                .trim()
                .chars()
                .take(300)
                .collect::<String>();
            return Err(if detail.is_empty() {
                format!("Tadoku returned HTTP {}", code.as_u16())
            } else {
                format!("Tadoku returned HTTP {}: {detail}", code.as_u16())
            }
            .into());
        }
        let bytes = response.bytes()?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        let result: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Tadoku returned an invalid JSON response")?;
        Ok(result)
    }
    pub fn units(&mut self, language: &str) -> Result<String> {
        let data = self.request(Method::GET, &["logs", "configuration-options"], None)?;
        let units = data["units"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|u| {
                number(&u["log_activity_id"]) == Some(1)
                    && u["name"]
                        .as_str()
                        .is_some_and(|s| s.eq_ignore_ascii_case("Character"))
            })
            .collect::<Vec<_>>();
        let unit = units
            .iter()
            .find(|u| u["language_code"] == language)
            .or_else(|| {
                units
                    .iter()
                    .find(|u| u["language_code"].as_str().unwrap_or("").is_empty())
            });
        unit.and_then(|u| u["unit_key"].as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                format!("Tadoku has no Character unit available for language '{language}'").into()
            })
    }
    pub fn registrations(&mut self, language: &str) -> Result<Vec<String>> {
        let data = self.request(Method::GET, &["contests", "ongoing-registrations"], None)?;
        let mut ids = Vec::new();
        for row in data["registrations"].as_array().into_iter().flatten() {
            let has_language = row["languages"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|v| v["code"] == language);
            let activity = row["contest"]["allowed_activities"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|v| number(&v["id"]) == Some(1));
            if has_language && activity {
                if let Some(id) = identifier(&row["id"]) {
                    ids.push(id)
                }
            }
        }
        Ok(ids)
    }
    pub fn create(&mut self, body: &Value) -> Result<String> {
        let row = self.request(Method::POST, &["logs"], Some(body))?;
        identifier(&row["id"]).ok_or_else(|| "Tadoku created a log without returning its ID".into())
    }
    pub fn delete(&mut self, id: &str) -> Result<()> {
        self.request(Method::DELETE, &["logs", id], None)
            .map(|_| ())
    }
}
fn number(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}
fn identifier(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| value.as_i64().filter(|n| *n != 0).map(|n| n.to_string()))
}
