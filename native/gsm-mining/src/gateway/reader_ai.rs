use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiAction {
    Translate,
    Multiple,
    Analyze,
    CharacterSummary,
    Settings,
}

impl AiAction {
    pub(super) fn route(path: &str) -> Option<Self> {
        match path {
            "/translate-line" => Some(Self::Translate),
            "/translate-multiple" => Some(Self::Multiple),
            "/analyze-line" => Some(Self::Analyze),
            "/ai/game-character-summary" => Some(Self::CharacterSummary),
            "/ai/open-settings" => Some(Self::Settings),
            _ => None,
        }
    }
}

pub(super) async fn serve(
    reader: &Arc<dyn ReaderEndpoint>,
    slots: &tokio::sync::Semaphore,
    action: AiAction,
    req: Request<Incoming>,
) -> Response<Full<Bytes>> {
    let builder =
        report_http::cors(Response::builder(), req.headers()).header("allow", "POST, OPTIONS");
    if req.method() != Method::POST {
        let code = if req.method() == Method::OPTIONS {
            StatusCode::OK
        } else {
            StatusCode::METHOD_NOT_ALLOWED
        };
        return builder.status(code).body(Full::new(Bytes::new())).unwrap();
    }
    // Queue before collecting the body so callers waiting on a slow model do not
    // each retain a fully parsed request. Stats and clip workers have separate slots.
    let Ok(_slot) = slots.acquire().await else {
        return empty_response(StatusCode::SERVICE_UNAVAILABLE);
    };
    let value = if action == AiAction::Settings {
        serde_json::Value::Null
    } else {
        let json = req
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"));
        if !json {
            return empty_response(StatusCode::UNSUPPORTED_MEDIA_TYPE);
        }
        let Ok(body) = http_body_util::Limited::new(req.into_body(), 1024 * 1024)
            .collect()
            .await
        else {
            return empty_response(StatusCode::PAYLOAD_TOO_LARGE);
        };
        serde_json::from_slice(&body.to_bytes()).unwrap_or_default()
    };
    let (status, output) = reader.ai(action, value).await;
    let (mime, body) = match output {
        serde_json::Value::String(text) if action == AiAction::Multiple && status.is_success() => {
            ("text/plain; charset=utf-8", text)
        }
        value => ("application/json", value.to_string()),
    };
    builder
        .status(status)
        .header(http::header::CONTENT_TYPE, mime)
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(Full::new(body.into()))
        .unwrap()
}
