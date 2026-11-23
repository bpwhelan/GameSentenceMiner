use super::{empty_response, report_http, Bytes, Full, Incoming, ReaderEndpoint, StatusCode};
use http::{header, Method, Request, Response};
use http_body_util::{BodyExt, Limited};
use serde_json::{json, Value};
use std::sync::Arc;

pub enum AreaRequest {
    List,
    Load(Option<String>),
    Current,
    Save(Value),
    Screenshot,
}

#[derive(Debug)]
pub enum AreaResponse {
    Json(StatusCode, Value),
    Jpeg(Vec<u8>),
}

#[derive(PartialEq)]
pub(super) enum Route {
    List,
    Config,
    Current,
    Screenshot,
}

impl Route {
    pub fn parse(path: &str) -> Option<Self> {
        Some(match path.strip_prefix("/api/ocr-area-selector/")? {
            "configs" => Self::List,
            "config" => Self::Config,
            "current-config" => Self::Current,
            "screenshot" => Self::Screenshot,
            _ => return None,
        })
    }

    pub async fn serve(
        self,
        reader: &Arc<dyn ReaderEndpoint>,
        slots: &tokio::sync::Semaphore,
        req: Request<Incoming>,
    ) -> Response<Full<Bytes>> {
        let mut builder = report_http::cors(Response::builder(), req.headers())
            .header(
                header::ALLOW,
                if self == Self::Config {
                    "GET, HEAD, POST, OPTIONS"
                } else {
                    "GET, HEAD, OPTIONS"
                },
            );
        let head = req.method() == Method::HEAD;
        let post = req.method() == Method::POST && self == Self::Config;
        if !(head || req.method() == Method::GET || post) {
            let status = if req.method() == Method::OPTIONS {
                StatusCode::OK
            } else {
                StatusCode::METHOD_NOT_ALLOWED
            };
            return builder
                .status(status)
                .body(Full::new(Bytes::new()))
                .unwrap();
        }
        let Ok(_permit) = slots.acquire().await else {
            return empty_response(StatusCode::SERVICE_UNAVAILABLE);
        };
        let operation = match self {
            Self::List => AreaRequest::List,
            Self::Current => AreaRequest::Current,
            Self::Screenshot => AreaRequest::Screenshot,
            Self::Config if post => {
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
                            || (mime.starts_with("application/") && mime.ends_with("+json"))
                    });
                let Ok(body) = Limited::new(req.into_body(), 8 << 20).collect().await else {
                    return empty_response(StatusCode::PAYLOAD_TOO_LARGE);
                };
                AreaRequest::Save(if is_json {
                    serde_json::from_slice(&body.to_bytes()).unwrap_or(Value::Null)
                } else {
                    Value::Null
                })
            }
            Self::Config => {
                let name = url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
                    .find(|(k, _)| k == "name")
                    .map(|(_, v)| v.into_owned());
                AreaRequest::Load(name)
            }
        };
        let (status, bytes) = match reader.area_selector(operation).await {
            AreaResponse::Jpeg(bytes) => {
                builder = builder
                    .header(
                        header::CACHE_CONTROL,
                        "no-store, no-cache, must-revalidate, max-age=0",
                    )
                    .header(header::CONTENT_TYPE, "image/jpeg")
                    .header(
                        header::CONTENT_DISPOSITION,
                        "inline; filename=ocr-area-source.jpg",
                    );
                (StatusCode::OK, bytes)
            }
            AreaResponse::Json(status, value) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                (status, serde_json::to_vec(&value).expect("JSON response"))
            }
        };
        builder
            .status(status)
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(Full::new(if head { Bytes::new() } else { bytes.into() }))
            .unwrap()
    }
}

impl AreaResponse {
    pub fn error(code: StatusCode, message: impl Into<String>) -> Self {
        Self::Json(code, json!({"error":message.into()}))
    }
}
