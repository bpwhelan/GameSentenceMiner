use super::{empty_response, report_http, Bytes, Full, Incoming, ReaderEndpoint, StatusCode};
use http::{header, Method, Request, Response};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::Arc;

pub enum Setup {
    Language(String),
    Dictionary {
        action: String,
        reader: Option<String>,
    },
    Sudachi {
        install: bool,
        edition: Option<String>,
    },
}

pub(super) enum Route {
    Language,
    Dictionary,
    Sudachi,
}

impl Route {
    pub fn parse(path: &str) -> Option<Self> {
        match path {
            "/api/onboarding/language" => Some(Self::Language),
            "/api/onboarding/dictionary" => Some(Self::Dictionary),
            "/api/onboarding/sudachi" => Some(Self::Sudachi),
            _ => None,
        }
    }

    fn validate(&self, body: &Value) -> Result<Setup, &'static str> {
        let action = body["action"].as_str();
        match self {
            Self::Language => {
                let language = body["language"]
                    .as_str()
                    .filter(|s| gsm_settings::gsm_config::is_learning_language(s))
                    .ok_or("Unsupported learning language.")?;
                Ok(Setup::Language(language.into()))
            }
            Self::Dictionary => {
                let action = action
                    .filter(|s| matches!(*s, "status" | "install" | "open" | "select"))
                    .ok_or("Invalid dictionary setup action.")?;
                let reader = if action == "select" {
                    let reader = body["reader"]
                        .as_str()
                        .filter(|s| matches!(*s, "yomitan" | "hachidori"))
                        .ok_or("Invalid dictionary reader.")?;
                    Some(reader.into())
                } else {
                    None
                };
                Ok(Setup::Dictionary {
                    action: action.into(),
                    reader,
                })
            }
            Self::Sudachi => {
                let install = match action {
                    Some("status") => false,
                    Some("install") => true,
                    _ => return Err("Invalid Sudachi setup action."),
                };
                let edition = match &body["dictionary"] {
                    Value::Null => None,
                    Value::String(s) if matches!(s.as_str(), "small" | "core" | "full") => {
                        Some(s.clone())
                    }
                    _ => return Err("Invalid Sudachi dictionary edition."),
                };
                Ok(Setup::Sudachi { install, edition })
            }
        }
    }

    pub async fn serve(
        self,
        reader: &Arc<dyn ReaderEndpoint>,
        slots: &tokio::sync::Semaphore,
        req: Request<Incoming>,
    ) -> Response<Full<Bytes>> {
        let builder = report_http::cors(Response::builder(), req.headers())
            .header(header::ALLOW, "POST, OPTIONS");
        if req.method() != Method::POST {
            let code = if req.method() == Method::OPTIONS {
                StatusCode::OK
            } else {
                StatusCode::METHOD_NOT_ALLOWED
            };
            return builder.status(code).body(Full::new(Bytes::new())).unwrap();
        }
        let is_json = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                let mime = v
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                mime == "application/json"
                    || mime.starts_with("application/") && mime.ends_with("+json")
            });
        let Ok(_permit) = slots.acquire().await else {
            return empty_response(StatusCode::SERVICE_UNAVAILABLE);
        };
        let value = if is_json {
            let Ok(body) = http_body_util::Limited::new(req.into_body(), 1024 * 1024)
                .collect()
                .await
            else {
                return empty_response(StatusCode::PAYLOAD_TOO_LARGE);
            };
            serde_json::from_slice(&body.to_bytes()).unwrap_or_default()
        } else {
            Value::Null
        };
        let (status, result) = match self.validate(&value) {
            Ok(request) => reader.onboarding(request).await,
            Err(error) => (StatusCode::BAD_REQUEST, json!({"error":error})),
        };
        builder
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Full::new(result.to_string().into()))
            .unwrap()
    }
}
