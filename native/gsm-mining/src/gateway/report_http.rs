use super::*;
use flate2::{write::GzEncoder, Compression};
use http::header;
use std::io::Write;
use tokio::sync::Semaphore;

async fn anki_read(
    http: &reqwest::Client,
    url: &str,
    action: &str,
    params: serde_json::Value,
    timeout: u64,
) -> Option<serde_json::Value> {
    let reply = http
        .post(url)
        .timeout(std::time::Duration::from_secs(timeout))
        .json(&json!({"action":action,"version":6,"params":params}))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let mut value: serde_json::Value = reply.json().await.ok()?;
    if !value.get("error")?.is_null() {
        return None;
    }
    value
        .get_mut("result")
        .map(serde_json::Value::take)
        .filter(|v| !v.is_null())
}

async fn live_anki_kanji(http: &reqwest::Client, scope: gsm_web::KanjiLookup) -> String {
    let Some(serde_json::Value::Array(notes)) = anki_read(
        http,
        &scope.url,
        "findNotes",
        json!({"query":scope.query}),
        5,
    )
    .await
    else {
        return String::new();
    };
    let ids: Vec<i64> = notes
        .into_iter()
        .filter_map(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .filter(|id| scope.includes(*id))
        .collect();
    let mut known = std::collections::BTreeSet::new();
    for page in ids.chunks(500) {
        if let Some(serde_json::Value::Array(rows)) =
            anki_read(http, &scope.url, "notesInfo", json!({"notes":page}), 10).await
        {
            for row in &rows {
                if let Some(chars) = scope.characters(row) {
                    known.extend(chars);
                }
            }
        }
    }
    known.into_iter().collect()
}

pub(super) async fn anki_status(
    reports: Arc<Reports>,
    slots: &Arc<Semaphore>,
    http: &reqwest::Client,
    req: &Request<Incoming>,
) -> Response<Full<Bytes>> {
    let builder = cors(Response::builder(), req.headers())
        .header(header::ALLOW, "GET, HEAD, OPTIONS")
        .header("x-gsm-handler", "rust");
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
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
    let Ok(permit) = slots.clone().acquire_owned().await else {
        return empty_response(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Ok((mut status, url)) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        reports.anki_sync_status()
    })
    .await
    else {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    };
    if let Some(url) = url {
        status.anki_connect_available = anki_read(http, &url, "version", json!({}), 2)
            .await
            .is_some();
    }
    let bytes = serde_json::to_vec(&status).expect("Anki status contains only JSON primitives");
    builder
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Full::new(if req.method() == Method::HEAD {
            Bytes::new()
        } else {
            Bytes::from(bytes)
        }))
        .unwrap()
}

pub(super) async fn game_cover(
    reports: Arc<Reports>,
    slots: &Arc<Semaphore>,
    req: &Request<Incoming>,
    id: String,
) -> Response<Full<Bytes>> {
    let response = cors(Response::builder(),req.headers()).header(header::ALLOW, "GET, HEAD, OPTIONS");
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        let status = if req.method()==Method::OPTIONS {StatusCode::OK} else {StatusCode::METHOD_NOT_ALLOWED};
        return response.status(status).body(Full::new(Bytes::new())).unwrap();
    }
    let Ok(permit) = slots.clone().acquire_owned().await else {return empty_response(StatusCode::SERVICE_UNAVAILABLE)};
    let cover = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        reports.game_cover(&id)
    }).await;
    match cover {
        Ok(Ok(Some(cover))) => response.header(header::CONTENT_TYPE,cover.content_type)
            .header(header::CACHE_CONTROL,"public, max-age=86400")
            .header(header::CONTENT_SECURITY_POLICY,"sandbox; default-src 'none'; style-src 'unsafe-inline'")
            .header(header::CONTENT_LENGTH,cover.bytes.len())
            .body(Full::new(if req.method()==Method::HEAD{Bytes::new()}else{cover.bytes.into()})).unwrap(),
        Ok(Ok(None)) => response.status(404).body(Full::new(Bytes::new())).unwrap(),
        _ => response.status(500).body(Full::new(Bytes::new())).unwrap(),
    }
}

pub(super) fn read_json(
    req: &Request<Incoming>,
    status: StatusCode,
    value: Value,
) -> Response<Full<Bytes>> {
    let b = cors(Response::builder(), req.headers()).header("allow", "GET, HEAD, OPTIONS");
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        let status = if req.method() == Method::OPTIONS {
            StatusCode::OK
        } else {
            StatusCode::METHOD_NOT_ALLOWED
        };
        return b.status(status).body(Full::default()).unwrap();
    }
    let data = value.to_string();
    b.status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .header("content-length", data.len())
        .body(Full::new(if req.method() == Method::HEAD {
            Bytes::new()
        } else {
            data.into()
        }))
        .unwrap()
}

pub(super) enum Action {
    KechimochiSync,
    KechimochiSettings,
    KechimochiTest,
    TadokuLogin,
    TadokuSync,
    Export,
    Scenes(gsm_web::SceneOperation),
    Job(gsm_web::MaintenanceJob),
    Goals,
    GoalProgress(gsm_web::goal_progress::View),
    TomorrowGoals,
    Game(gsm_web::GameEdit),
    RemoveGame(String,gsm_web::GameRemoval),
    StatsSettings,
    DatabaseSettings,
    Reading(gsm_web::ReadingEdit),
    Maintenance(gsm_web::Maintenance),
}

pub(super) async fn json_report(
    reports: Arc<Reports>,
    state: &GatewayState,
    req: Request<Incoming>,
    action: Action,
) -> Response<Full<Bytes>> {
    let (method, allow) = match &action {
        Action::Job(gsm_web::MaintenanceJob::ArchiveGame(_)) => (Method::POST,"GET, HEAD, POST, OPTIONS"),
        Action::DatabaseSettings => (Method::PUT,"GET, HEAD, PUT, OPTIONS"),
        Action::Game(gsm_web::GameEdit::Update(_)) => (Method::PUT, "PUT, DELETE, OPTIONS"),
        Action::RemoveGame(_,gsm_web::GameRemoval::Unlink) => (Method::DELETE,"PUT, DELETE, OPTIONS"),
        Action::RemoveGame(_,gsm_web::GameRemoval::DeleteLines) => (Method::DELETE,"DELETE, OPTIONS"),
        Action::Reading(edit) if edit.deletes() => (Method::DELETE, "DELETE, OPTIONS"),
        Action::KechimochiSettings | Action::StatsSettings | Action::Reading(gsm_web::ReadingEdit::Add) => (Method::POST, "GET, HEAD, POST, OPTIONS"),
        _ => (Method::POST, "POST, OPTIONS"),
    };
    let bodyless = method == Method::DELETE || matches!(action, Action::KechimochiSync | Action::TadokuLogin | Action::Game(gsm_web::GameEdit::Complete(_)) | Action::Job(gsm_web::MaintenanceJob::Vacuum));
    let response = cors(Response::builder(), req.headers()).header(header::ALLOW, allow);
    if req.method() != method {
        let status = if req.method() == Method::OPTIONS {
            StatusCode::OK
        } else {
            StatusCode::METHOD_NOT_ALLOWED
        };
        return response
            .status(status)
            .body(Full::new(Bytes::new()))
            .unwrap();
    }
    let timezone = req
        .headers()
        .get("x-timezone")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let json = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .is_some_and(|s| {
            let s = s.trim().to_ascii_lowercase();
            s == "application/json" || (s.starts_with("application/") && s.ends_with("+json"))
        });
    if !bodyless && !json && !matches!(action, Action::KechimochiTest | Action::KechimochiSettings | Action::TadokuSync | Action::Export | Action::Job(_)) {
        return response
            .status(StatusCode::UNSUPPORTED_MEDIA_TYPE)
            .body(Full::new(Bytes::new()))
            .unwrap();
    }
    let Ok(permit) = state.report_slots.clone().acquire_owned().await else {
        return empty_response(StatusCode::SERVICE_UNAVAILABLE);
    };
    // Retain the deployed Waitress body limit for JSON imports.
    let (parts,body) = req.into_parts();
    let bytes = if bodyless { Bytes::new() } else {
        match http_body_util::Limited::new(body, 1 << 30).collect().await {
            Ok(buffer) => buffer.to_bytes(),
            Err(_) => return response.status(StatusCode::PAYLOAD_TOO_LARGE).body(Full::new(Bytes::new())).unwrap(),
        }
    };
    let retained = bytes.clone();
    let maintenance = matches!(action,Action::Maintenance(_));
    let goals = matches!(action, Action::Goals);
    let settings = matches!(action,Action::StatsSettings);
    let scenes = matches!(action,Action::Scenes(_));
    let library = matches!(action,Action::Game(_) | Action::RemoveGame(_, _));
    let remove_game = matches!(action,Action::RemoveGame(_, _));
    let jobs = state.maintenance_jobs.clone();
    let exports = state.export_jobs.clone();
    let tadoku_jobs = state.tadoku_jobs.clone();
    let reader = state.reader.clone();
    let reply = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let body = serde_json::from_slice(&bytes).unwrap_or_default();
        match action {
            Action::KechimochiTest => Some(reports.kechimochi_test(if json {&body}else{&Value::Null})),
            Action::KechimochiSettings | Action::KechimochiSync => {
                let settings=matches!(action,Action::KechimochiSettings);
                match reports.prepare_kechimochi(settings.then_some(if json {&body}else{&Value::Null}),false,crate::config::profile_language_name){
                    Ok(gsm_web::kechimochi::Start::Ready(reply,work))=>{
                        tokio::spawn(async move {
                            if let Some(work)=work {let _=tokio::task::spawn_blocking(move ||work.run(true)).await;}
                            if let Some(reader)=reader{reader.stats_settings_changed(true).await;}
                        });
                        Some(reply)
                    }
                    Ok(gsm_web::kechimochi::Start::Compatibility)=>None,Err(reply)=>Some(reply),
                }
            }
            Action::TadokuLogin => Some(reports.tadoku_login()),
            Action::TadokuSync => match reports.prepare_tadoku(if json {&body} else {&Value::Null},false) {
                Ok(Some(work)) => Some(tadoku_jobs.start(work)),
                Ok(None) => None,
                Err(reply) => Some(reply),
            },
            Action::Export => match reports.prepare_export(if json {&body} else {&Value::Null}, crate::config::profile_language_name) {
                Ok(Some(work)) => Some(exports.start(work)),
                Ok(None) => None,
                Err(reply) => Some(reply),
            },
            Action::Scenes(edit) => reports.edit_scenes(edit, &body),
            Action::Job(job) => jobs.start(reports, job, if json {body} else {Value::Null}, reader),
            Action::Reading(edit) => Some(reports.edit_reading_stats(edit, body)),
            Action::Goals => Some(reports.update_goals(body, timezone.as_deref())),
            Action::GoalProgress(view) => reports.goal_progress(view,&body,timezone.as_deref()),
            Action::TomorrowGoals=>reports.tomorrow_goals(&body,timezone.as_deref()),
            Action::StatsSettings => reports.save_stats_settings(body),
            Action::DatabaseSettings => Some(reports.save_maintenance_settings(body)),
            Action::Game(edit) => Some(reports.edit_game(edit,body)),
            Action::RemoveGame(id, removal) => reports.remove_game(&id,removal),
            Action::Maintenance(operation) => reports.maintenance(operation, body),
        }
    })
    .await;
    let Ok(reply) = reply else {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let Some(reply) = reply else {
        if settings && state.reader.as_ref().is_some_and(|r| r.native_only()) {
            return json_response(StatusCode::BAD_REQUEST, &json!({"error":"The desktop could not compile this punctuation expression."}));
        }
        return proxy_http(state.clone(),Request::from_parts(parts,Full::new(retained))).await;
    };
    if goals && reply.status == 200 {
        if let Some(reader) = &state.reader {
            reader.goals_changed();
        }
    }
    if maintenance && reply.status == 200 {
        if let Some(reader) = &state.reader {
            if reply.body["updated_count"].as_u64().unwrap_or(0) > 0 {
                reader.lines_rewritten().await;
            } else if reply.body["deleted_count"].as_u64().unwrap_or(0) > 0 {
                reader.lines_removed().await;
            }
        }
    }
    if settings && reply.status==200 {
        if let Some(reader) = &state.reader {
            let reschedule = reply.body.get("tadoku_daily_sync_enabled").is_some() || reply.body.get("tadoku_daily_sync_time").is_some();
            reader.stats_settings_changed(reschedule).await;
        }
    }
    if scenes && (reply.body["migrated_count"].as_u64().unwrap_or(0)>0 || reply.body["lines_moved"].as_u64().unwrap_or(0)>0 || reply.body["successful_games"].as_array().is_some_and(|a|!a.is_empty())) {
        if let Some(reader)=&state.reader {
            reader.library_changed().await;
            reader.lines_removed().await;
        }
    }
    if library && (200..300).contains(&reply.status) {
        if let Some(reader) = &state.reader {
            reader.library_changed().await;
            if remove_game && reply.body.get("message").is_some() {
                reader.lines_removed().await;
            }
        }
    }
    response
        .status(reply.status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(reply.body.to_string())))
        .unwrap()
}

pub(super) async fn yomitan_dictionary(
    reports: Arc<Reports>,
    slots: &Arc<Semaphore>,
    req: &Request<Incoming>,
) -> Response<Full<Bytes>> {
    use gsm_web::yomitan_frequency::Response as Dictionary;
    let head = req.method() == Method::HEAD;
    let uri = req.uri().clone();
    let Ok(permit) = slots.clone().acquire_owned().await else {
        return empty_response(StatusCode::SERVICE_UNAVAILABLE);
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut builder = Response::builder()
            .header("x-gsm-handler", "rust")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
        let query = uri.query().unwrap_or("");
        let dictionary = match uri.path() {
            "/api/yomitan-index" => reports.read(Route::CharacterIndex, query)
                .and_then(|r| r.ok_or_else(|| "Missing character index".into())).map(Dictionary::Json),
            "/api/yomitan-dict" => reports.character_dictionary(query),
            path => Ok(reports.yomitan_frequency(path == "/api/yomitan-freq-index")),
        };
        let bytes = match dictionary.unwrap_or_else(|e| Dictionary::Json(gsm_web::Reply {
            status:500, body:json!({"error":format!("Failed to generate dictionary: {e}")}),
        })) {
            Dictionary::Json(reply) => {
                builder = builder
                    .status(reply.status)
                    .header(header::CONTENT_TYPE, "application/json");
                reply.body.to_string().into_bytes()
            }
            Dictionary::Archive(bytes) => {
                builder = builder
                    .header(header::CONTENT_TYPE, "application/zip")
                    .header(
                        header::CONTENT_DISPOSITION,
                        if uri.path() == "/api/yomitan-dict" { "attachment; filename=gsm_characters.zip" }
                        else { "attachment; filename=gsm_frequency.zip" },
                    );
                bytes
            }
        };
        builder
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(Full::new(if head {
                Bytes::new()
            } else {
                Bytes::from(bytes)
            }))
            .unwrap()
    })
    .await
    .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR))
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(','))
        .any(|entry| {
            let mut parts = entry.split(';');
            parts
                .next()
                .is_some_and(|s| s.trim().eq_ignore_ascii_case("gzip"))
                && parts.all(|p| {
                    p.trim()
                        .strip_prefix("q=")
                        .is_none_or(|q| q.parse::<f32>().is_ok_and(|n| n > 0.0 && n <= 1.0))
                })
        })
}

pub(super) async fn serve(
    reports: Arc<Reports>,
    slots: &Arc<Semaphore>,
    http: &reqwest::Client,
    route: Route,
    req: &Request<Incoming>,
) -> Option<Response<Full<Bytes>>> {
    let query = req.uri().query().unwrap_or("").to_owned();
    let gzip = accepts_gzip(req.headers());
    let head = req.method() == Method::HEAD;
    let permit = slots.clone().acquire_owned().await.ok()?;
    let live = if matches!(route, Route::AnkiCoverage | Route::AnkiCombined) {
        let db = reports.clone();
        let args = query.clone();
        let combined = route == Route::AnkiCombined;
        let lookup = tokio::task::spawn_blocking(move || db.kanji_lookup(combined, &args))
            .await
            .ok()?
            .ok()?;
        Some(match lookup {
            Some(scope) => live_anki_kanji(http, scope).await,
            None => String::new(),
        })
    } else {
        None
    };
    let deprecated = route == Route::GamesList;
    let export = route == Route::ExportMissingWords;
    let timezone = req
        .headers()
        .get("x-timezone")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    // JSON encoding and compression can be substantial for a game with a cover.
    // Keep both off Tokio workers, under the same bound as the SQLite snapshots.
    let (status, bytes, compressed, csv) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut reply = if route == Route::DatabaseBackup {
            reports.backup()
        } else if route == Route::CompleteDailies {
            reports
                .complete_goals(timezone.as_deref())
                .unwrap_or_else(|_| gsm_web::Reply {
                    status: 500,
                    body: json!({"success":false,"error":"Failed to complete dailies"}),
                })
        } else if let Some(characters) = live {
            reports.anki_chart(route, &query, &characters).ok()??
        } else {
            let is_game_stats = matches!(route, Route::GameStats(_));
            match reports.read_with_timezone(route, &query, timezone.as_deref()) {
                Ok(reply) => reply?,
                Err(error) if is_game_stats => {
                    eprintln!("[rust:stats] Game statistics failed: {error}");
                    gsm_web::Reply {
                        status: 500,
                        body: json!({"error":"Failed to load game statistics"}),
                    }
                }
                Err(_) => return None,
            }
        };
        let csv = export && reply.status == 200;
        let bytes = if csv {
            let serde_json::Value::String(data) = reply.body["csv"].take() else {
                return None;
            };
            data.into_bytes()
        } else {
            serde_json::to_vec(&reply.body).ok()?
        };
        let (bytes, compressed) = encode(bytes, gzip)?;
        Some((reply.status, bytes, compressed, csv))
    })
    .await
    .ok()??;
    let mut response = Response::builder()
        .status(status)
        .header(
            header::CONTENT_TYPE,
            if csv {
                "text/csv; charset=utf-8"
            } else {
                "application/json"
            },
        )
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::VARY, "Origin, Accept-Encoding");
    if compressed {
        response = response.header(header::CONTENT_ENCODING, "gzip");
    }
    response = cors(response, req.headers());
    if csv {
        response = response.header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"gsm_words_not_in_anki.csv\"",
        );
    }
    if deprecated && status == 200 {
        response = response
            .header("deprecation", "true")
            .header("x-deprecation-notice", "Use /api/games-management instead");
    }
    response
        .body(Full::new(if head {
            Bytes::new()
        } else {
            Bytes::from(bytes)
        }))
        .ok()
}

fn embedded_asset(asset: gsm_web::pages::Asset, cache: &str, headers: &HeaderMap, head: bool) -> Option<Response<Full<Bytes>>> {
    let gzip = asset.gzip.filter(|_| accepts_gzip(headers));
    let bytes = gzip.unwrap_or(asset.bytes);
    let etag = if gzip.is_some() { asset.gzip_etag } else { asset.etag };
    let modified = std::time::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(asset.modified))?;
    let mut response = cors(Response::builder(),headers)
        .header(header::VARY,"Accept-Encoding, Origin")
        .header(header::CACHE_CONTROL,cache)
        .header(header::ACCEPT_RANGES,"bytes")
        .header(header::LAST_MODIFIED,httpdate::fmt_http_date(modified))
        .header(header::ETAG,etag);
    let get = |key| headers.get::<http::header::HeaderName>(key).and_then(|v| v.to_str().ok());
    let tags_match = |tags: &str, weak: bool| tags.split(',').map(str::trim)
        .any(|s| s=="*" || s==etag || (weak && s.strip_prefix("W/")==Some(etag)));
    let date = |s: &str| httpdate::parse_http_date(s).ok();
    let failed = if let Some(tags) = get(header::IF_MATCH) { !tags_match(tags,false) }
        else { get(header::IF_UNMODIFIED_SINCE).and_then(date).is_some_and(|d| modified>d) };
    if failed { return response.status(412).body(Full::default()).ok(); }
    let fresh = if let Some(tags) = get(header::IF_NONE_MATCH) { tags_match(tags,true) }
        else { get(header::IF_MODIFIED_SINCE).and_then(date).is_some_and(|d| modified<=d) };
    if fresh { return response.status(304).body(Full::default()).ok(); }
    let range_valid = get(header::IF_RANGE).is_none_or(|s| s==etag || date(s).is_some_and(|d| d==modified));
    let mut data = Bytes::from_static(bytes);
    if let Some(raw) = get(header::RANGE).filter(|s| range_valid && s.starts_with("bytes=")) {
        if bytes.is_empty() {return response.status(416).header(header::CONTENT_RANGE,"bytes */0").body(Full::default()).ok();}
        let size = bytes.len() as u64;
        let ranges = http_range_header::parse_range_header(raw).and_then(|parsed| parsed.validate(size))
            .or_else(|err| match err {
                http_range_header::RangeUnsatisfiableError::FileSuffixOutOfBounds if !raw.contains(',') => Ok(vec![0..=size-1]),
                other => Err(other),
            });
        match ranges.as_deref() {
            Ok([one]) if !bytes.is_empty() => {
                response = response.status(206).header(header::CONTENT_RANGE,format!("bytes {}-{}/{}",one.start(),one.end(),bytes.len()));
                data = data.slice((*one.start() as usize)..=(*one.end() as usize));
            }
            _ => return response.status(416).header(header::CONTENT_RANGE,format!("bytes */{}",bytes.len())).body(Full::default()).ok(),
        }
    }
    if gzip.is_some() { response = response.header(header::CONTENT_ENCODING,"gzip"); }
    response.header(header::CONTENT_TYPE,asset.content_type).header(header::CONTENT_LENGTH,data.len())
        .body(Full::new(if head {Bytes::new()} else {data})).ok()
}

pub(super) async fn page(
    reports: &Arc<Reports>,
    slots: &Arc<Semaphore>,
    req: &Request<Incoming>,
) -> Option<Response<Full<Bytes>>> {
    use gsm_web::pages::{asset, Page};
    let path = req.uri().path();
    let head = req.method() == Method::HEAD;
    if let Some(target) = match path {
        "/" => Some("/texthooker"),
        "/database" => Some("/tools"),
        _ => None,
    } {
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, target)
            .body(Full::new(Bytes::new()))
            .ok();
    }
    if let Some(asset) = asset(path) {
        let cache = if path.ends_with(".css") || path.ends_with(".js") {
            "no-cache, no-store, must-revalidate"
        } else if path.starts_with("/api/")
            || path == "/texthooker"
            || path.ends_with(".webmanifest")
        {
            "no-cache"
        } else {
            "public, max-age=2592000, immutable"
        };
        return embedded_asset(asset, cache, req.headers(), head);
    }
    let page = Page::parse(path)?;
    let reports = reports.clone();
    let permit = slots.clone().acquire_owned().await.ok()?;
    let gzip = accepts_gzip(req.headers());
    let (status, bytes, compressed) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let html = page.render(&reports).ok()?;
        let status = if html.is_some() { 200 } else { 404 };
        let data = html.unwrap_or_else(|| "Game not found".into()).into_bytes();
        let (bytes, compressed) = encode(data, gzip)?;
        Some((status, bytes, compressed))
    })
    .await
    .ok()??;
    let mut response = cors(
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::VARY, "Origin, Accept-Encoding")
            .header(header::CONTENT_LENGTH, bytes.len()),
        req.headers(),
    );
    if compressed {
        response = response.header(header::CONTENT_ENCODING, "gzip");
    }
    response
        .body(Full::new(if head {
            Bytes::new()
        } else {
            Bytes::from(bytes)
        }))
        .ok()
}

fn encode(bytes: Vec<u8>, gzip: bool) -> Option<(Vec<u8>, bool)> {
    if gzip && bytes.len() >= 500 {
        let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
        gz.write_all(&bytes).ok()?;
        Some((gz.finish().ok()?, true))
    } else {
        Some((bytes, false))
    }
}

pub(super) fn cors(
    response: http::response::Builder,
    headers: &HeaderMap,
) -> http::response::Builder {
    let response = response.header("x-gsm-handler", "rust");
    if let Some(origin) = headers.get(header::ORIGIN).filter(|o| {
        matches!(
            o.as_bytes(),
            b"http://localhost:5173"
                | b"http://127.0.0.1:5173"
                | b"http://localhost:5174"
                | b"http://127.0.0.1:5174"
        )
    }) {
        response
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                "GET,POST,PUT,DELETE,OPTIONS",
            )
            .header(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                "Content-Type, Authorization, X-Timezone",
            )
            .header(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, "true")
    } else {
        response
    }
}
