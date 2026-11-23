//! Native Rust single-port HTTP + WebSocket gateway on `general.single_port` (default 7275).
//! - Serves `POST /anki/events` and `POST /api/anki/events` directly in Rust via `BeaconReceiver`.
//! - Serves dashboard reports, templates and assets, forwarding remaining HTTP routes to Waitress.
//! - Transparently tunnels WebSocket upgrade requests to Python's internal WS ingress port.
mod report_http;
mod reader_ai;
mod reader_audio;
mod maintenance_jobs;
mod onboarding;
mod area_selector;
mod file_import;
mod media_search;
mod stats_export;
mod tadoku;
pub use media_search::{MetadataAction, MediaSearch};
pub use area_selector::{AreaRequest, AreaResponse};
pub use onboarding::Setup;
pub use reader_ai::AiAction;
pub use gsm_web::Reports;
pub use gsm_web::kechimochi::Start as KechimochiStart;
use gsm_web::Route;
use crate::beacon::{BeaconEventOutcome, BeaconReceiver};
use bytes::Bytes;
pub use http::StatusCode;
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

#[derive(Debug, Clone, Default)]
pub struct UpstreamTargets {
    pub http_port: Option<u16>,
    pub ws_port: Option<u16>,
    pub direct_ws_port: u16,
}

pub type ReaderSocket = tokio_tungstenite::WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;
#[derive(Clone, Copy, PartialEq)]
pub enum Channel {
    Reader,
    Plain,
    Overlay,
}
pub trait ReaderEndpoint: Send + Sync {
    fn native_only(&self) -> bool { false }
    fn update_metadata(&self, action: MetadataAction, body: Value)
        -> futures_util::future::BoxFuture<'_, (StatusCode, Value)>;
    fn search_media(&self,search:MediaSearch)->futures_util::future::BoxFuture<'_,(StatusCode,Vec<u8>)>;
    fn area_selector(&self, request: AreaRequest) -> futures_util::future::BoxFuture<'_, AreaResponse>;
    fn prepare_archive_lines(&self,_ids:Vec<String>,_generation:u64)->futures_util::future::BoxFuture<'_,Result<(),String>> {
        Box::pin(async {Err("Word index unavailable".into())})
    }
    fn reading_stats_changed(&self) -> futures_util::future::BoxFuture<'_, ()>;
    fn goals_changed(&self) {}
    fn queue_game_metadata(&self) -> bool;
    fn imported_lines(&self, dictionary: &'static str, ids: Vec<String>, generation: u64) -> futures_util::future::BoxFuture<'_,bool>;
    fn library_changed(&self) -> futures_util::future::BoxFuture<'_, ()> {
        self.reading_stats_changed()
    }
    fn stats_settings_changed(&self, _reschedule: bool) -> futures_util::future::BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn lines_removed(&self) -> futures_util::future::BoxFuture<'_, ()> {
        self.reading_stats_changed()
    }
    fn lines_rewritten(&self) -> futures_util::future::BoxFuture<'_, ()> {
        self.lines_removed()
    }
    fn audio_asset(&self, token: &str) -> Option<Arc<tempfile::TempPath>>;
    fn ai(&self, action: AiAction, input: serde_json::Value) -> futures_util::future::BoxFuture<'_, (StatusCode, serde_json::Value)>;
    fn onboarding(&self, request: Setup) -> futures_util::future::BoxFuture<'_, (StatusCode, Value)>;
    fn connect(
        &self,
        channel: Channel,
        socket: ReaderSocket,
        upstream: watch::Receiver<Option<String>>,
    ) -> futures_util::future::BoxFuture<'static, ()>;
    fn query(&self, path: &str, input: serde_json::Value) -> (StatusCode, serde_json::Value);
}

#[derive(Clone)]
pub struct GatewayState {
    pub external_port: u16,
    reader: Option<Arc<dyn ReaderEndpoint>>,
    reports: Option<Arc<Reports>>,
    report_slots: Arc<tokio::sync::Semaphore>,
    maintenance_jobs: Arc<maintenance_jobs::Jobs>,
    export_jobs: Arc<stats_export::Jobs>,
    tadoku_jobs: Arc<tadoku::Jobs>,
    ai_slots: Arc<tokio::sync::Semaphore>,
    setup_slots: Arc<tokio::sync::Semaphore>,
    media_slots: Arc<tokio::sync::Semaphore>,
    direct: u16,
    preferred_direct: u16,
    reader_upstream: watch::Sender<Option<String>>,
    pub upstream_host: String,
    pub beacon: BeaconReceiver,
    pub targets: Arc<RwLock<UpstreamTargets>>,
    pub http_client: reqwest::Client,
}

impl GatewayState {
    fn native_http_only(&self) -> bool {
        self.targets.read().is_ok_and(|targets| targets.http_port.is_none())
    }
}

pub struct GatewayHandle {
    pub bound_addr: SocketAddr,
    pub state: GatewayState,
    stop_tx: watch::Sender<bool>,
}

impl GatewayHandle {
    pub fn set_upstreams(&self, http_port: Option<u16>, ws_port: Option<u16>, direct_ws_port: u16) {
        self.state.reader_upstream.send_if_modified(|old| {
            let host = &self.state.upstream_host;
            let next = ws_port.map(|port| {
                if host.contains(':') {
                    format!("ws://[{host}]:{port}")
                } else {
                    format!("ws://{host}:{port}")
                }
            });
            if *old == next {
                false
            } else {
                *old = next;
                true
            }
        });
        if let Ok(mut guard) = self.state.targets.write() {
            guard.http_port = http_port;
            guard.ws_port = ws_port;
            guard.direct_ws_port = direct_ws_port;
        }
    }

    pub fn shutdown(&self) {
        let _ = self.stop_tx.send(true);
    }
}

pub async fn start_gateway(
    bind_host: &str,
    port: u16,
    beacon: BeaconReceiver,
) -> Result<GatewayHandle, String> {
    start_with_reader(bind_host, port, beacon, None, 0).await
}

pub async fn start_with_reader(
    bind_host: &str,
    port: u16,
    beacon: BeaconReceiver,
    reader: Option<Arc<dyn ReaderEndpoint>>,
    direct_port: u16,
) -> Result<GatewayHandle, String> {
    start_with_services(bind_host, port, beacon, reader, direct_port, None).await
}

pub async fn start_with_services(
    bind_host: &str,
    port: u16,
    beacon: BeaconReceiver,
    reader: Option<Arc<dyn ReaderEndpoint>>,
    direct_port: u16,
    reports: Option<Arc<Reports>>,
) -> Result<GatewayHandle, String> {
    let host = if bind_host.trim().is_empty() {
        "127.0.0.1"
    } else {
        bind_host.trim()
    };
    let listener = TcpListener::bind((host, port))
        .await
        .map_err(|e| format!("Failed to bind Rust gateway on {host}:{port}: {e}"))?;
    let bound_addr = listener.local_addr().map_err(|e| e.to_string())?;
    let upstream_host = if matches!(host, "0.0.0.0" | "::" | "") {
        "127.0.0.1".to_string()
    } else {
        host.to_string()
    };

    // Disable automatic decompression so upstream gzip/br responses pass through byte-for-byte.
    let http_client = reqwest::Client::builder()
        .no_proxy()
        .tcp_nodelay(true)
        .pool_max_idle_per_host(16)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let direct = if reader.is_some() {
        let port = if direct_port == bound_addr.port() {
            0
        } else {
            direct_port
        };
        Some(match TcpListener::bind((host, port)).await {
            Ok(listener) => listener,
            Err(_) if port != 0 => TcpListener::bind((host, 0))
                .await
                .map_err(|e| e.to_string())?,
            Err(e) => return Err(e.to_string()),
        })
    } else {
        None
    };
    let state = GatewayState {
        reports,
        maintenance_jobs: Default::default(),
        export_jobs: Default::default(),
        tadoku_jobs: Default::default(),
        report_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        ai_slots: Arc::new(tokio::sync::Semaphore::new(8)),
        setup_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        media_slots: Arc::new(tokio::sync::Semaphore::new(16)),
        preferred_direct: direct_port,
        direct: direct
            .as_ref()
            .map(|s| s.local_addr().map(|a| a.port()))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or(0),
        reader_upstream: watch::channel(None).0,
        reader,
        external_port: bound_addr.port(),
        upstream_host,
        beacon,
        targets: Arc::new(RwLock::new(UpstreamTargets::default())),
        http_client,
    };

    let (stop_tx, stop_rx) = watch::channel(false);
    if let Some(listener) = direct {
        tokio::spawn(serve(listener, state.clone(), stop_rx.clone(), true));
    }
    tokio::spawn(serve(listener, state.clone(), stop_rx, false));
    Ok(GatewayHandle {
        bound_addr,
        state,
        stop_tx,
    })
}

async fn serve(
    listener: TcpListener,
    task_state: GatewayState,
    mut stop_rx: watch::Receiver<bool>,
    ws_only: bool,
) {
    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                if stop_rx.has_changed().is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            accept = listener.accept() => {
                let Ok((stream, peer)) = accept else {
                    continue;
                };
                let _ = stream.set_nodelay(true);
                let conn_state = task_state.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |mut req: Request<Incoming>| {
                        req.extensions_mut().insert(peer);
                        let st = conn_state.clone();
                        async move { Ok::<_, std::convert::Infallible>(reader_audio::dispatch(st, req, ws_only).await) }
                    });
                    let _ = http1::Builder::new()
                        .preserve_header_case(true)
                        .serve_connection(io, svc)
                        .with_upgrades()
                        .await;
                });
            }
        }
    }
}

fn reader_path(path: &str) -> Option<Channel> {
    match path.trim_end_matches('/').to_ascii_lowercase().as_str() {
        "" | "/jl" | "/ws/jl" | "/ws/plaintext" | "/plaintext" => Some(Channel::Plain),
        "/ws" | "/ws/texthooker" | "/hooker" | "/texthooker" | "/api/ws/text/origin" => {
            Some(Channel::Reader)
        }
        "/overlay" | "/ws/overlay" => Some(Channel::Overlay),
        _ => None,
    }
}

async fn handle_request(state: GatewayState, mut req: Request<Incoming>) -> Response<Full<Bytes>> {
    let path = req.uri().path();
    let model_settings = matches!(path, "/api/ocr/meiki-model" | "/api/ocr/vita-model");
    if model_settings && (req.headers().contains_key(http::header::ORIGIN)
        || !req.extensions().get::<SocketAddr>().is_some_and(|peer| peer.ip().is_loopback()))
    {
        return json_response(StatusCode::FORBIDDEN, &json!({"error":"Model settings are only available from the local desktop app"}));
    }

    if let Some(reports) = &state.reports {
        let kechimochi=match path {
            "/api/kechimochi/settings" if !matches!(*req.method(),Method::GET|Method::HEAD) => Some(report_http::Action::KechimochiSettings),
            "/api/kechimochi/test"=>Some(report_http::Action::KechimochiTest),
            "/api/kechimochi/sync"=>Some(report_http::Action::KechimochiSync),
            _=>None,
        };
        if let Some(action)=kechimochi{return report_http::json_report(reports.clone(),&state,req,action).await;}
        if path == "/api/tadoku/auth/refresh" || path == "/api/tadoku/sync" {
            let action = if path.ends_with("/refresh") { report_http::Action::TadokuLogin } else { report_http::Action::TadokuSync };
            return report_http::json_report(reports.clone(), &state, req, action).await;
        }
        if let Some(id) = path.strip_prefix("/api/tadoku/jobs/").filter(|s|!s.contains('/') && !s.is_empty()) {
            let status = reports.export_generation().ok().and_then(|g|state.tadoku_jobs.status(id,g));
            if let Some(status) = status {
                return report_http::read_json(&req, StatusCode::OK, status);
            }
            if state.native_http_only() {
                return report_http::read_json(&req, StatusCode::NOT_FOUND, json!({"error":"Tadoku sync job not found"}));
            }
        }
        if path == "/api/stats-export/formats" {
            return report_http::read_json(&req, StatusCode::OK, gsm_web::export_formats());
        }
        if path == "/api/stats-export/jobs" {
            return report_http::json_report(reports.clone(), &state, req, report_http::Action::Export).await;
        }
        if let Some(id) = path.strip_prefix("/api/stats-export/jobs/").filter(|s|!s.contains('/') && !s.is_empty()) {
            let status = reports.export_generation().ok().and_then(|g|state.export_jobs.status(id,g));
            if let Some(status) = status {
                return report_http::read_json(&req, StatusCode::OK, status);
            }
            if state.native_http_only() {
                return report_http::read_json(&req, StatusCode::NOT_FOUND, json!({"error":"Export job not found"}));
            }
        }
        if let Some(edit)=gsm_web::SceneOperation::route(path) {
            return report_http::json_report(reports.clone(),&state,req,report_http::Action::Scenes(edit)).await;
        }
        if let Some(job) = gsm_web::MaintenanceJob::route(path, req.method().as_str()) {
            return report_http::json_report(
                reports.clone(),
                &state,
                req,
                report_http::Action::Job(job),
            )
            .await;
        }
        if req.method() == Method::POST
            && path
                .strip_prefix("/api/database/archive-files/")
                .and_then(|s| s.split_once('/'))
                .is_some_and(|(id, action)| {
                    !id.is_empty() && !action.is_empty() && !action.contains('/')
                })
        {
            return json_response(
                StatusCode::NOT_FOUND,
                &json!({"error":"Unknown archive file action"}),
            );
        }
        if let Some(id) = path
            .strip_prefix("/api/database/maintenance/jobs/")
            .filter(|id| !id.is_empty() && !id.contains('/'))
        {
            let found = state.maintenance_jobs.get(id);
            // In mixed mode an existing archive job may belong to Flask.
            if found.is_some()
                || state
                    .targets
                    .read()
                    .is_ok_and(|targets| targets.http_port.is_none())
            {
                let builder = report_http::cors(Response::builder(), req.headers())
                    .header("allow", "GET, HEAD, OPTIONS");
                if !matches!(*req.method(), Method::HEAD | Method::GET) {
                    let code = if req.method() == Method::OPTIONS {
                        StatusCode::OK
                    } else {
                        StatusCode::METHOD_NOT_ALLOWED
                    };
                    return builder.status(code).body(Full::default()).unwrap();
                }
                let status = if found.is_some() {
                    StatusCode::OK
                } else {
                    StatusCode::NOT_FOUND
                };
                let body = found
                    .unwrap_or_else(|| json!({"error":"Maintenance job not found"}))
                    .to_string();
                return builder
                    .status(status)
                    .header("content-type", "application/json")
                    .header("content-length", body.len())
                    .header("cache-control", "no-store")
                    .body(Full::new(if req.method() == Method::HEAD {
                        Bytes::new()
                    } else {
                        body.into()
                    }))
                    .unwrap();
            }
        }
        if path=="/api/database/maintenance" && !matches!(*req.method(),Method::GET|Method::HEAD){
            return report_http::json_report(reports.clone(), &state, req, report_http::Action::DatabaseSettings).await;
        }
        if let Some(id) = gsm_web::game_cover_route(path) {
            return report_http::game_cover(reports.clone(), &state.report_slots, &req, id).await;
        }
        if let Some(edit) = gsm_web::game_edit_route(path, req.method().as_str()) {
            return report_http::json_report(reports.clone(), &state, req, report_http::Action::Game(edit)).await;
        }
        if let Some((id, removal)) = gsm_web::game_removal_route(path, req.method().as_str()) {
            return report_http::json_report(reports.clone(), &state, req, report_http::Action::RemoveGame(id, removal)).await;
        }
        if path == "/api/settings" && !matches!(*req.method(), Method::GET | Method::HEAD) {
            return report_http::json_report(reports.clone(), &state, req, report_http::Action::StatsSettings).await;
        }
        if path == "/api/anki_sync_status" {
            return report_http::anki_status(reports.clone(), &state.report_slots, &state.http_client, &req).await;
        }
        if matches!(path,"/api/goals/progress"|"/api/goals/today-progress"|"/api/goals/projection"){
            use gsm_web::goal_progress::View;
            let view=match path {"/api/goals/progress"=>View::Overall,"/api/goals/projection"=>View::Projection,_=>View::Daily};
            return report_http::json_report(reports.clone(),&state,req,report_http::Action::GoalProgress(view)).await;
        }
        if path=="/api/goals/tomorrow-requirements"{return report_http::json_report(reports.clone(),&state,req,report_http::Action::TomorrowGoals).await;}
        if path == "/api/goals/update" {
            return report_http::json_report(reports.clone(), &state, req, report_http::Action::Goals).await;
        }
        if let Some(operation) = gsm_web::Maintenance::route(path) {
            return report_http::json_report(reports.clone(), &state, req, report_http::Action::Maintenance(operation)).await;
        }
        if let Some(format) = file_import::Format::route(path) {
            return file_import::handle(reports.clone(), &state, req, format).await;
        }
        if let Some(edit) = gsm_web::ReadingEdit::route(path, req.method().as_str()) {
            let result = report_http::json_report(reports.clone(), &state, req, report_http::Action::Reading(edit)).await;
            if result.status().is_success() && result.headers().contains_key(http::header::CONTENT_TYPE) {
                if let Some(reader) = &state.reader {
                    reader.reading_stats_changed().await;
                }
            }
            return result;
        }
        if matches!(path, "/api/yomitan-freq-dict" | "/api/yomitan-freq-index" | "/api/yomitan-index" | "/api/yomitan-dict") {
            if matches!(*req.method(), Method::GET | Method::HEAD) {
                return report_http::yomitan_dictionary(
                    reports.clone(),
                    &state.report_slots,
                    &req,
                )
                .await;
            }
            let status = if req.method() == Method::OPTIONS {
                StatusCode::OK
            } else {
                StatusCode::METHOD_NOT_ALLOWED
            };
            return Response::builder()
                .status(status)
                .header("allow", "GET, HEAD, OPTIONS")
                .header("access-control-allow-methods", "GET, HEAD, OPTIONS")
                .header("access-control-allow-origin", "*")
                .body(Full::new(Bytes::new()))
                .unwrap();
        }
    }

    if req.method() == Method::POST {
        let route = match path {
            "/api/goals/complete_todays_dailies" => Some(Route::CompleteDailies),
            "/api/database_backup" => Some(Route::DatabaseBackup),
            _ => None,
        };
        if let Some((reports, route)) = state.reports.as_ref().zip(route) {
            return report_http::serve(reports.clone(), &state.report_slots, &state.http_client, route, &req)
                .await.unwrap_or_else(|| json_response(StatusCode::INTERNAL_SERVER_ERROR, &json!({"success":false,"error":"Database operation failed"})));
        }
    }

    if matches!(*req.method(), Method::GET | Method::HEAD) && !is_websocket_upgrade(req.headers()) {
        if let Some(reports) = &state.reports {
            if let Some(response) = report_http::page(reports, &state.report_slots, &req).await {
                return response;
            }
        }
        if let Some((reports, route)) = state.reports.as_ref().zip(Route::parse(path)) {
            if let Some(response) = report_http::serve(reports.clone(), &state.report_slots, &state.http_client, route, &req).await {
                return response;
            }
        }
    }

    if let Some(reader) = &state.reader {
        if let Some(action) = MetadataAction::parse(path) {
            return media_search::link(&state, reader, req, action).await;
        }
        if matches!(path,"/api/jiten-search"|"/api/search/unified") {
            return media_search::serve(&state,reader,req).await;
        }
        if let Some(route) = area_selector::Route::parse(path) {
            return route.serve(reader, &state.report_slots, req).await;
        }
        if let Some(route) = onboarding::Route::parse(path) {
            return route.serve(reader, &state.setup_slots, req).await;
        }
        if path == "/api/anki_sync_now" {
            let builder = report_http::cors(Response::builder(), req.headers())
                .header("allow", "POST, OPTIONS").header("x-gsm-handler", "rust");
            if req.method() != Method::POST {
                let status = if req.method() == Method::OPTIONS { StatusCode::OK } else { StatusCode::METHOD_NOT_ALLOWED };
                return builder.status(status).body(Full::new(Bytes::new())).unwrap();
            }
            let (code, body) = reader.query(path, serde_json::Value::Null);
            return builder.status(code).header("content-type", "application/json")
                .body(Full::new(Bytes::from(body.to_string()))).unwrap();
        }
        if let Some(action) = AiAction::route(path) {
            return reader_ai::serve(reader, &state.ai_slots, action, req).await;
        }
        if let Some(plain) = reader_path(path).filter(|_| is_websocket_upgrade(req.headers())) {
            use tokio_tungstenite::tungstenite::{
                handshake::server::create_response, protocol::Role,
            };
            let mut request = Request::builder()
                .method(req.method())
                .uri(req.uri())
                .version(req.version())
                .body(())
                .unwrap();
            *request.headers_mut() = req.headers().clone();
            let Ok(resp) = create_response(&request) else {
                return empty_response(StatusCode::BAD_REQUEST);
            };
            let upgraded = hyper::upgrade::on(&mut req);
            let endpoint = reader.clone();
            let upstream = state.reader_upstream.subscribe();
            tokio::spawn(async move {
                if let Ok(io) = upgraded.await {
                    let ws =
                        ReaderSocket::from_raw_socket(TokioIo::new(io), Role::Server, None).await;
                    endpoint.connect(plain, ws, upstream).await;
                }
            });
            return resp.map(|_| Full::new(Bytes::new()));
        }
        let clip_route = matches!(path, "/api/clips" | "/api/clips/open" | "/api/clips/trash" | "/save-clip" | "/trim-video" | "/play-audio" | "/get-screenshot" | "/create-media");
        let status_route = path == "/get_status" || (state.native_http_only() && path == "/linux/detect_game_exe");
        let control_route = matches!(path, "/set_text_intake_paused" | "/set_stats_gathering_enabled")
            || (state.native_http_only() && matches!(path,"/linux/set_target_process" | "/linux/set_scene_target_process"));
        let head = req.method() == Method::HEAD;
        if model_settings && !matches!(*req.method(), Method::GET | Method::POST | Method::HEAD) {
            let status = if req.method() == Method::OPTIONS { StatusCode::OK } else { StatusCode::METHOD_NOT_ALLOWED };
            return Response::builder().status(status).header("allow", "GET, HEAD, POST, OPTIONS").body(Full::new(Bytes::new())).unwrap();
        }
        if clip_route || status_route || control_route {
            let read = path == "/api/clips" || status_route;
            if !(read && (req.method() == Method::GET || head)
                || !read && req.method() == Method::POST)
            {
                let status = if req.method() == Method::OPTIONS {
                    StatusCode::OK
                } else {
                    StatusCode::METHOD_NOT_ALLOWED
                };
                return report_http::cors(Response::builder(), req.headers())
                    .status(status)
                    .header(
                        http::header::ALLOW,
                        if read {
                            "GET, HEAD, OPTIONS"
                        } else {
                            "POST, OPTIONS"
                        },
                    )
                    .body(Full::new(Bytes::new()))
                    .unwrap();
            }
        }
        if model_settings || clip_route || status_route || control_route
            || (req.method() == Method::GET && matches!(path, "/get_ids" | "/data"))
            || (req.method() == Method::POST
                && matches!(path, "/update_checkbox" | "/update_checkboxes"))
        {
            if (clip_route || model_settings)
                && req.method() == Method::POST
                && !req
                    .headers()
                    .get(http::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.split(';').next())
                    .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
            {
                if model_settings {
                    return json_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, &json!({"error":"Expected JSON model settings"}));
                }
                return empty_response(StatusCode::UNSUPPORTED_MEDIA_TYPE);
            }
            let control_json = !control_route || req.headers().get(http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()).is_some_and(|v| {
                    let mime = v.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
                    mime == "application/json" || (mime.starts_with("application/") && mime.ends_with("+json"))
                });
            let builder = report_http::cors(Response::builder(), req.headers());
            let path = path.to_owned();
            let input = if req.method() == Method::POST {
                let body = http_body_util::Limited::new(req.into_body(), 1024 * 1024);
                let Ok(body) = body.collect().await else {
                    return empty_response(StatusCode::PAYLOAD_TOO_LARGE);
                };
                match serde_json::from_slice(&body.to_bytes()) {
                    Ok(value) if control_json => value,
                    _ if control_route => Value::Null,
                    _ => return empty_response(StatusCode::BAD_REQUEST),
                }
            } else if model_settings {
                json!({})
            } else {
                serde_json::Value::Null
            };
            let endpoint = reader.clone();
            let permit = if clip_route || model_settings {
                let Ok(permit) = state.report_slots.clone().acquire_owned().await else {
                    return empty_response(StatusCode::SERVICE_UNAVAILABLE);
                };
                Some(permit)
            } else {
                None
            };
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let (code, value) = endpoint.query(&path, input);
                (code, value.to_string())
            })
            .await;
            let Ok((code, body)) = result else {
                return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
            };
            return builder
                .status(code)
                .header(http::header::CONTENT_TYPE, "application/json")
                .header(http::header::CACHE_CONTROL, "no-store")
                .header(http::header::CONTENT_LENGTH, body.len())
                .body(Full::new(if head { Bytes::new() } else { body.into() }))
                .unwrap();
        }
        if req.method() == Method::GET && path == "/get_websocket_port" {
            let configured = state.preferred_direct != 0 && state.preferred_direct == state.direct;
            return json_response(
                StatusCode::OK,
                &json!({"port":if configured {state.direct}else{state.external_port},
                "direct_port":state.direct,"gateway_port":state.external_port,"gateway_active":true}),
            );
        }
    }
    // 1. Native AnkiBeacon ingress handled directly in Rust!
    if req.method() == Method::POST && matches!(path, "/anki/events" | "/api/anki/events") {
        return handle_anki_beacon(state.beacon, req).await;
    }

    if gsm_web::omitted_desktop_route(path) {
        return empty_response(StatusCode::NOT_FOUND);
    }

    // 2. WebSocket upgrade tunnel -> Python websocket_manager ingress port.
    if is_websocket_upgrade(req.headers()) {
        return handle_websocket_proxy(state, req).await;
    }

    // 3. `/get_websocket_port` returns Rust's external port directly once WS port is registered.
    if req.method() == Method::GET && path == "/get_websocket_port" {
        let targets = state.targets.read().map(|g| g.clone()).unwrap_or_default();
        if let Some(ws_port) = targets.ws_port {
            let direct_enabled = targets.direct_ws_port > 0 && targets.direct_ws_port == ws_port;
            let preferred = if direct_enabled {
                ws_port
            } else {
                state.external_port
            };
            let body = json!({
                "port": preferred,
                "direct_port": ws_port,
                "gateway_port": state.external_port,
                "gateway_active": true,
            });
            return json_response(StatusCode::OK, &body);
        }
    }

    if state.reader.as_ref().is_some_and(|reader| reader.native_only()) {
        return empty_response(StatusCode::NOT_FOUND);
    }
    proxy_http(state, req).await
}

async fn handle_anki_beacon(
    beacon: BeaconReceiver,
    req: Request<Incoming>,
) -> Response<Full<Bytes>> {
    let Ok(collected) = req.into_body().collect().await else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({"error": "Failed to read request body."}),
        );
    };
    let bytes = collected.to_bytes();
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({"error": "Expected a JSON object payload."}),
        );
    };
    match beacon.handle_event(payload) {
        Ok(BeaconEventOutcome::Heartbeat) => empty_response(StatusCode::NO_CONTENT),
        Ok(BeaconEventOutcome::DuplicateNoteAdded) => empty_response(StatusCode::OK),
        Ok(BeaconEventOutcome::NoteAdded) => empty_response(StatusCode::ACCEPTED),
        Err((code, msg)) => {
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST);
            json_response(status, &json!({"error": msg}))
        }
    }
}

async fn proxy_http<B: hyper::body::Body<Data=Bytes>>(state: GatewayState, req: Request<B>) -> Response<Full<Bytes>> {
    let Some(http_port) = state.targets.read().ok().and_then(|g| g.http_port) else {
        if req.uri().path().starts_with("/static/") {return empty_response(StatusCode::NOT_FOUND);}
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            &json!({"error": "This endpoint is unavailable."}),
        );
    };

    let method = req.method().clone();
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_url = format!("http://{}:{http_port}{path_and_query}", state.upstream_host);

    let mut out_headers = reqwest::header::HeaderMap::with_capacity(req.headers().len());
    for (name, val) in req.headers() {
        // `http::HeaderName::as_str()` is guaranteed canonical lowercase ASCII.
        let lower = name.as_str();
        if HOP_BY_HOP.contains(&lower) || lower == "host" || lower == "content-length" {
            continue;
        }
        if let (Ok(rn), Ok(rv)) = (
            reqwest::header::HeaderName::from_bytes(lower.as_bytes()),
            reqwest::header::HeaderValue::from_bytes(val.as_bytes()),
        ) {
            out_headers.append(rn, rv);
        }
    }
    if let Ok(hv) =
        reqwest::header::HeaderValue::from_str(&format!("{}:{http_port}", state.upstream_host))
    {
        out_headers.insert(reqwest::header::HOST, hv);
    }

    let body_bytes = match req.into_body().collect().await {
        Ok(c) => c.to_bytes(),
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({"error": "Failed to read request body."}),
            )
        }
    };

    let req_method =
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let upstream_resp = match state
        .http_client
        .request(req_method, &target_url)
        .headers(out_headers)
        .body(body_bytes)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return json_response(
                StatusCode::BAD_GATEWAY,
                &json!({"error": "Gateway proxy failed."}),
            )
        }
    };

    let status = StatusCode::from_u16(upstream_resp.status().as_u16()).unwrap_or(StatusCode::OK);
    let resp_headers = upstream_resp.headers().clone();
    let resp_body = match upstream_resp.bytes().await {
        Ok(b) => b,
        Err(_) => {
            return json_response(
                StatusCode::BAD_GATEWAY,
                &json!({"error": "Gateway proxy failed."}),
            )
        }
    };

    let mut builder = Response::builder().status(status).header("x-gsm-handler", "python");
    for (name, val) in resp_headers.iter() {
        let lower = name.as_str();
        if HOP_BY_HOP.contains(&lower) || matches!(lower, "content-length" | "x-gsm-handler") {
            continue;
        }
        if let (Ok(hn), Ok(hv)) = (
            HeaderName::from_bytes(lower.as_bytes()),
            HeaderValue::from_bytes(val.as_bytes()),
        ) {
            builder = builder.header(hn, hv);
        }
    }
    builder
        .body(Full::new(resp_body))
        .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR))
}

async fn handle_websocket_proxy(
    state: GatewayState,
    req: Request<Incoming>,
) -> Response<Full<Bytes>> {
    let Some(ws_port) = state.targets.read().ok().and_then(|g| g.ws_port) else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            &json!({"error": "WebSocket backend is still starting."}),
        );
    };

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();

    let mut upstream = match TcpStream::connect((state.upstream_host.as_str(), ws_port)).await {
        Ok(s) => s,
        Err(_) => {
            return json_response(
                StatusCode::BAD_GATEWAY,
                &json!({"error": "WebSocket upstream unavailable."}),
            )
        }
    };
    let _ = upstream.set_nodelay(true);

    // Build HTTP/1.1 Upgrade request to upstream websocket server.
    let mut handshake = format!(
        "GET {path_and_query} HTTP/1.1\r\nHost: {}:{ws_port}\r\n",
        state.upstream_host
    );
    for (name, val) in req.headers() {
        if name.as_str().eq_ignore_ascii_case("host") {
            continue;
        }
        if let Ok(v) = val.to_str() {
            handshake.push_str(&format!("{}: {v}\r\n", name.as_str()));
        }
    }
    handshake.push_str("\r\n");

    if upstream.write_all(handshake.as_bytes()).await.is_err() {
        return json_response(
            StatusCode::BAD_GATEWAY,
            &json!({"error": "WebSocket upgrade write failed."}),
        );
    }

    // Read upstream HTTP/1.1 status + response headers.
    let mut reader = BufReader::new(upstream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).await.is_err() {
        return json_response(
            StatusCode::BAD_GATEWAY,
            &json!({"error": "WebSocket upgrade read failed."}),
        );
    }
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(502);

    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_GATEWAY));
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if trimmed.is_empty() {
                    break;
                }
                if let Some((k, v)) = trimmed.split_once(':') {
                    builder = builder.header(k.trim(), v.trim());
                }
            }
        }
    }

    if status_code != 101 {
        return builder
            .body(Full::new(Bytes::new()))
            .unwrap_or_else(|_| empty_response(StatusCode::BAD_GATEWAY));
    }

    // Preserve any bytes already buffered from upstream after the 101 headers!
    let leftover = reader.buffer().to_vec();
    let mut upstream_stream = reader.into_inner();
    let upgrade_future = hyper::upgrade::on(req);

    tokio::spawn(async move {
        if let Ok(upgraded) = upgrade_future.await {
            let mut client_io = TokioIo::new(upgraded);
            if !leftover.is_empty() && client_io.write_all(&leftover).await.is_err() {
                return;
            }
            let _ = tokio::io::copy_bidirectional(&mut client_io, &mut upstream_stream).await;
        }
    });

    builder
        .body(Full::new(Bytes::new()))
        .unwrap_or_else(|_| empty_response(StatusCode::SWITCHING_PROTOCOLS))
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let has_upgrade_conn = headers
        .get(http::header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("upgrade"));
    let is_ws = headers
        .get(http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    has_upgrade_conn && is_ws
}

fn empty_response(status: StatusCode) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .unwrap()
}

fn json_response(status: StatusCode, value: &serde_json::Value) -> Response<Full<Bytes>> {
    let body = serde_json::to_vec(value).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn report_http_contract_without_upstream() {
        use http::header;
        use hyper::client::conn::http1::handshake;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gsm.db");
        gsm_db::create_profile_if_missing(&path).unwrap();
        std::fs::write(dir.path().join("config.json"),
            r#"{"stats":{"extra_punctuation_regex":"【.*?】"}}"#).unwrap();
        gsm_db::open_writer(&path).unwrap().execute_batch(
            "INSERT INTO game_lines(id,game_name,line_text,timestamp)
             VALUES('one','Story','【話者】読む。',unixepoch())",
        ).unwrap();
        let reports = Arc::new(Reports::new(dir.path(), Default::default()));
        let (beacon, _rx) = BeaconReceiver::new(4);
        let gateway = start_with_services("127.0.0.1", 0, beacon, None, 0, Some(reports))
            .await
            .unwrap();
        let (client, server) = tokio::io::duplex(16 * 1024);
        let state = gateway.state.clone();
        let task = tokio::spawn(async move {
            http1::Builder::new().serve_connection(TokioIo::new(server), service_fn(move |req| {
                    let state=state.clone();
                    async move{Ok::<_, std::convert::Infallible>(handle_request(state,req).await)}
                })).await.unwrap()
        });
        let (mut client, driver) = handshake(TokioIo::new(client)).await.unwrap();
        tokio::spawn(driver);
        let body = || Full::new(Bytes::new());
        for (path, status) in [("/api/yomitan-index", 200), ("/api/yomitan-dict",404)] {
            let response = client.send_request(Request::get(path).body(body()).unwrap()).await.unwrap();
            assert_eq!(response.status().as_u16(),status);
            assert_eq!(response.headers()["x-gsm-handler"],"rust");
            assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],"*");
            response.collect().await.unwrap();
        }
        let request = Request::get("/api/stats").body(body()).unwrap();
        let response = client.send_request(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-gsm-handler"], "rust");
        let dashboard: serde_json::Value = serde_json::from_slice(
            &response.collect().await.unwrap().to_bytes(),
        ).unwrap();
        assert_eq!(dashboard["allGamesStats"]["total_characters"], 2);
        let manual = json!({"date":"2026-11-21","characters_read":"5"});
        let batch = json!({"clear_source":"manual","entries":[manual,{"date":"2026-02-30","source":"fixture"},
            {"date":"2026-11-20","time_read_seconds":7.5,"source":"日記"}]});
        for (url, payload, status) in [("/api/third-party-stats", &manual, 201), ("/api/import-stats", &batch, 200)] {
            let response = client.send_request(Request::post(url).header(header::CONTENT_TYPE,"application/json")
                .body(Full::new(Bytes::from(payload.to_string()))).unwrap()).await.unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(response.headers()["x-gsm-handler"], "rust");
            let result: serde_json::Value = serde_json::from_slice(&response.collect().await.unwrap().to_bytes()).unwrap();
            if status == 201 { assert_eq!(result["entry"]["label"],"Manual entry"); }
            else { assert_eq!((result["imported_count"].as_i64(), result["cleared_count"].as_i64(),result["skipped_count"].as_i64()),(Some(1),Some(1),Some(2))); }
        }
        for (tail, status) in [("1",404),("source/%E6%97%A5%E8%A8%98",200)] {
            let response = client.send_request(Request::delete(format!("/api/third-party-stats/{tail}")).body(body()).unwrap()).await.unwrap();
            assert_eq!(response.status().as_u16(),status);
            let result: serde_json::Value = serde_json::from_slice(&response.collect().await.unwrap().to_bytes()).unwrap();
            if status == 200 { assert_eq!(result["deleted_count"],1); }
        }
        let response = client.send_request(Request::post("/api/database_backup").body(body()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-gsm-handler"], "rust");
        let export: serde_json::Value = serde_json::from_slice(&response.collect().await.unwrap().to_bytes()).unwrap();
        let exported = std::path::Path::new(export["backup_path"].as_str().unwrap());
        assert_eq!(exported.parent(), Some(dir.path().join("backup").as_path()));
        assert_eq!(gsm_db::open_writer(exported).unwrap().query_row(
            "SELECT line_text FROM game_lines WHERE id='one'", [], |r| r.get::<_,String>(0)
        ).unwrap(), "【話者】読む。");
        let request = Request::get("/api/kanji-frequency?kanji=invalid")
            .header(header::ORIGIN, "http://localhost:5173")
            .body(body())
            .unwrap();
        let response = client.send_request(request).await.unwrap();
        assert_eq!(response.status(), 400);
        assert_eq!(response.headers()["x-gsm-handler"], "rust");
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://localhost:5173"
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&response.collect().await.unwrap().to_bytes())
                .unwrap(),
            json!({"error":"Invalid kanji parameter"})
        );
        let request = Request::head("/static/js/shared.js")
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(body())
            .unwrap();
        let response = client.send_request(request).await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
        assert!(
            response.headers()[header::CONTENT_LENGTH]
                .to_str()
                .unwrap()
                .parse::<usize>()
                .unwrap()
                > 0
        );
        let tag = response.headers()[header::ETAG].clone();
        assert!(response.collect().await.unwrap().to_bytes().is_empty());
        let request = Request::get("/static/js/shared.js")
            .header(header::IF_NONE_MATCH, tag)
            .body(body())
            .unwrap();
        assert_eq!(client.send_request(request).await.unwrap().status(), 304);
        let request = Request::get("/api/kanji-sorting-configs")
            .body(body())
            .unwrap();
        let response = client.send_request(request).await.unwrap();
        assert_eq!(response.status(), 200);
        let configs: serde_json::Value =
            serde_json::from_slice(&response.collect().await.unwrap().to_bytes()).unwrap();
        assert!(!configs["configs"].as_array().unwrap().is_empty());
        let current = Request::get("/api/goals/current").body(body()).unwrap();
        assert_eq!(client.send_request(current).await.unwrap().status(), 200);
        let edit = Request::post("/api/goals/update")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-timezone", "America/New_York")
            .body(Full::new(Bytes::from_static(br#"{"current_goals":[{"startDate":"2026-11-01T01:15","endDate":"2026-11-01T02:15"}]}"#)))
            .unwrap();
        let reply = client.send_request(edit).await.unwrap();
        assert_eq!(reply.status(), 400);
        assert_eq!(reply.headers()["x-gsm-handler"], "rust");
        let edit = Request::post("/api/goals/update")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from_static(br#"{"partial_settings":{"ankiConnect":{"deckName":"Test"}}}"#)))
            .unwrap();
        let reply = client.send_request(edit).await.unwrap();
        assert_eq!(reply.status(), 200);
        let current = client.send_request(Request::get("/api/goals/current").body(body()).unwrap()).await.unwrap();
        let current: serde_json::Value = serde_json::from_slice(&current.collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(current["goals_settings"]["ankiConnect"]["deckName"], "Test");
        let timezone = "Pacific/Kiritimati";
        let date = (chrono::Utc::now() + chrono::Duration::hours(14)).date_naive();
        let done = Request::post("/api/goals/complete_todays_dailies")
            .header("x-timezone", timezone).body(body()).unwrap();
        let reply = client.send_request(done).await.unwrap();
        assert_eq!(reply.status(), 200);
        let data: serde_json::Value = serde_json::from_slice(&reply.collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(data["date"], date.to_string());
        let done = Request::post("/api/goals/complete_todays_dailies")
            .header("x-timezone", timezone).body(body()).unwrap();
        assert_eq!(client.send_request(done).await.unwrap().status(), 400);
        drop(client);
        task.await.unwrap();
        gateway.shutdown();
    }

    #[tokio::test]
    async fn gateway_handles_beacon_natively_and_proxies_other_http() {
        // Mock Python Waitress server
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_port = upstream.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = upstream.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let body = r#"{"proxied":true}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = s.write_all(resp.as_bytes()).await;
                });
            }
        });

        let (beacon, mut rx) = BeaconReceiver::new(16);
        let gw = start_gateway("127.0.0.1", 0, beacon).await.unwrap();
        gw.set_upstreams(Some(up_port), Some(7299), 0);
        let base = format!("http://127.0.0.1:{}", gw.bound_addr.port());
        let client = reqwest::Client::new();

        // An older installed compatibility backend can still serve Flasgger.
        for path in [
            "/api/docs", "/api/docs/", "/apispec.json", "/apidocs/index.html",
            "/flasgger_static/swagger-ui-bundle.js", "/oauth2-redirect.html",
            "/api/debug-db", "/%61pi/docs",
        ] {
            for method in [Method::GET, Method::HEAD] {
                let response = client.request(method, format!("{base}{path}")).send().await.unwrap();
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            }
        }
        assert_eq!(client.get(format!("{base}/api/docs-extra")).send().await.unwrap().status(), 200);
        for path in ["/clear_history","/clear_history/","/%63lear_history"] {
            let response=client.post(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
        assert_eq!(client.post(format!("{base}/clear_history_extra")).send().await.unwrap().status(), 200);

        // 1. Heartbeat -> 204
        let hb = client
            .post(format!("{base}/anki/events"))
            .json(&json!({"event": "heartbeat", "session_id": "s1", "heartbeat_interval_seconds": 15}))
            .send()
            .await
            .unwrap();
        assert_eq!(hb.status().as_u16(), 204);

        // 2. Note added -> 202, duplicate -> 200
        let n1 = client
            .post(format!("{base}/api/anki/events"))
            .json(&json!({"event": "note_added", "session_id": "s1", "note_id": 777}))
            .send()
            .await
            .unwrap();
        assert_eq!(n1.status().as_u16(), 202);
        let n2 = client
            .post(format!("{base}/api/anki/events"))
            .json(&json!({"event": "note_added", "session_id": "s1", "note_id": 777}))
            .send()
            .await
            .unwrap();
        assert_eq!(n2.status().as_u16(), 200);
        assert_eq!(rx.recv().await.unwrap().note_id, 777);

        // 3. Other HTTP route -> proxied to upstream
        let px: serde_json::Value = client
            .get(format!("{base}/get_status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(px["proxied"], true);

        // 4. /get_websocket_port -> reports Rust gateway port
        let ws_info: serde_json::Value = client
            .get(format!("{base}/get_websocket_port"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ws_info["gateway_active"], true);
        assert_eq!(ws_info["port"], gw.bound_addr.port());
        assert_eq!(ws_info["direct_port"], 7299);

        gw.shutdown();
    }
}
