use super::{
    empty_response, report_http, Bytes, Full, GatewayState, Incoming, ReaderEndpoint, StatusCode,
};
use http::{header, Method, Request, Response};
use serde_json::json;
use std::sync::Arc;

pub enum MetadataAction {
    Repull(String),
    LinkJiten(String),
    LinkIgdb(String),
    Upgrade,
}

impl MetadataAction {
    pub(super) fn parse(path: &str) -> Option<Self> {
        if path == "/api/cron/jiten-upgrader/run" {
            return Some(Self::Upgrade);
        }
        if let Some(id) = gsm_web::game_action_id(path, "/link-jiten") {
            return Some(Self::LinkJiten(id));
        }
        if let Some(id) = gsm_web::game_action_id(path, "/link-igdb") {
            return Some(Self::LinkIgdb(id));
        }
        gsm_web::game_action_id(path, "/repull-jiten").map(Self::Repull)
    }
}

pub enum MediaSearch {
    Jiten(String),
    Unified { query: String, sources: Vec<String> },
}

pub(super) async fn link(
    state: &GatewayState,
    reader: &Arc<dyn ReaderEndpoint>,
    req: Request<Incoming>,
    action: MetadataAction,
) -> Response<Full<Bytes>> {
    use http_body_util::{BodyExt, Limited};
    let builder = report_http::cors(Response::builder(), req.headers())
        .header(header::ALLOW, "POST, OPTIONS");
    if req.method() != Method::POST {
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
    let Ok(_permit) = state.media_slots.acquire().await else {
        return empty_response(StatusCode::SERVICE_UNAVAILABLE);
    };
    let json = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| {
            let mime = v.trim().to_ascii_lowercase();
            mime == "application/json"
                || (mime.starts_with("application/") && mime.ends_with("+json"))
        });
    let value = if json
        && matches!(
            action,
            MetadataAction::LinkJiten(_) | MetadataAction::LinkIgdb(_)
        ) {
        let Ok(buf) = Limited::new(req.into_body(), 1 << 30).collect().await else {
            return empty_response(StatusCode::PAYLOAD_TOO_LARGE);
        };
        serde_json::from_slice(&buf.to_bytes()).unwrap_or_default()
    } else {
        serde_json::Value::Null
    };
    let (status, body) = reader.update_metadata(action, value).await;
    if status.is_success() {
        reader.library_changed().await;
    }
    builder
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(serde_json::to_vec(&body).unwrap().into()))
        .unwrap()
}

pub(super) async fn serve(
    state: &GatewayState,
    reader: &Arc<dyn ReaderEndpoint>,
    req: Request<Incoming>,
) -> Response<Full<Bytes>> {
    let builder = report_http::cors(Response::builder(), req.headers())
        .header(header::ALLOW, "GET, HEAD, OPTIONS");
    let head = req.method() == Method::HEAD;
    if !head && req.method() != Method::GET {
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
    let parsed = url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes());
    let param = |key: &str| {
        parsed
            .clone()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_owned())
    };
    let request = if req.uri().path() == "/api/jiten-search" {
        param("title")
            .filter(|s| !s.is_empty())
            .map(MediaSearch::Jiten)
            .ok_or("Title parameter is required")
    } else {
        param("q")
            .filter(|s| !s.is_empty())
            .map(|query| {
                let mut sources = Vec::new();
                for name in param("sources")
                    .as_deref()
                    .unwrap_or("jiten,vndb,igdb,anilist")
                    .split(',')
                {
                    let name = name.trim().to_ascii_lowercase();
                    if !sources.contains(&name) {
                        sources.push(name);
                    }
                }
                MediaSearch::Unified { query, sources }
            })
            .ok_or("Query parameter 'q' is required")
    };
    let (status, body) = match request {
        Ok(search) => {
            let Ok(_permit) = state.media_slots.acquire().await else {
                return empty_response(StatusCode::SERVICE_UNAVAILABLE);
            };
            reader.search_media(search).await
        }
        Err(reason) => (
            StatusCode::BAD_REQUEST,
            json!({"error":reason}).to_string().into_bytes(),
        ),
    };
    builder
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, body.len())
        .body(Full::new(if head { Bytes::new() } else { body.into() }))
        .unwrap()
}
