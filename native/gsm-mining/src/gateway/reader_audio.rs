use super::{
    empty_response, handle_request, is_websocket_upgrade, report_http::cors, GatewayState,
};
use bytes::Bytes;
use http::{header, Method, Request, Response, StatusCode};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full};
use hyper::body::Incoming;
use std::{io, path::Path};
use tower_http::services::ServeFile;

type Body = UnsyncBoxBody<Bytes, io::Error>;

fn full(response: Response<Full<Bytes>>) -> Response<Body> {
    response.map(|b| b.map_err(|never| match never {}).boxed_unsync())
}

pub(super) async fn dispatch(
    state: GatewayState,
    req: Request<Incoming>,
    ws_only: bool,
) -> Response<Body> {
    if ws_only && !is_websocket_upgrade(req.headers()) {
        return full(empty_response(StatusCode::NOT_FOUND));
    }
    if let Some((reports, id)) = state.reports.as_ref().zip(
        req.uri()
            .path()
            .strip_prefix("/api/stats-export/jobs/")
            .and_then(|s| s.strip_suffix("/download"))
            .filter(|s| !s.is_empty() && !s.contains('/')),
    ) {
        let generation = reports.export_generation().ok();
        let file = generation.and_then(|g| state.export_jobs.file(id, g));
        if let Some(file) = file {
            if !matches!(*req.method(), Method::GET | Method::HEAD) {
                return full(super::report_http::read_json(
                    &req,
                    StatusCode::OK,
                    serde_json::Value::Null,
                ));
            }
            let builder = cors(Response::builder(), req.headers())
                .header(header::ALLOW, "GET, HEAD, OPTIONS")
                .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-cache")
                .header(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}\"", file.filename),
                );
            let etag = format!("\"{id}\"");
            return stream_file(&file.path, req, builder, etag, "Export file is not ready").await;
        }
        if state.native_http_only()
            || generation.is_some_and(|g| state.export_jobs.status(id, g).is_some())
        {
            return full(super::report_http::read_json(
                &req,
                StatusCode::CONFLICT,
                serde_json::json!({"error":"Export file is not ready"}),
            ));
        }
    }
    if let Some((reports, id)) = state.reports.as_ref().zip(
        req.uri()
            .path()
            .strip_prefix("/api/database/archive-files/")
            .and_then(|s| s.strip_suffix("/download"))
            .filter(|s| !s.contains('/')),
    ) {
        let builder =
            cors(Response::builder(), req.headers()).header(header::ALLOW, "GET, HEAD, OPTIONS");
        if !matches!(*req.method(), Method::GET | Method::HEAD) {
            let status = if req.method() == Method::OPTIONS {
                StatusCode::OK
            } else {
                StatusCode::METHOD_NOT_ALLOWED
            };
            return full(builder.status(status).body(Full::default()).unwrap());
        }
        let reports = reports.clone();
        let id = id.to_owned();
        let Ok(permit) = state.report_slots.clone().acquire_owned().await else {
            return full(empty_response(StatusCode::SERVICE_UNAVAILABLE));
        };
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            reports.archive_download(&id)
        })
        .await;
        let file = match result {
            Ok(Ok(file)) => file,
            Ok(Err((code, message))) => {
                return full(
                    builder
                        .status(code)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Full::new(Bytes::from(
                            serde_json::json!({"error":message}).to_string(),
                        )))
                        .unwrap(),
                )
            }
            Err(_) => return full(empty_response(StatusCode::INTERNAL_SERVER_ERROR)),
        };
        let meta = match tokio::fs::metadata(&file.path).await {
            Ok(meta) => meta,
            Err(_) => return full(empty_response(StatusCode::NOT_FOUND)),
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .unwrap_or_default();
        let etag = format!("\"{:x}-{:x}\"", meta.len(), modified.as_nanos());
        let builder = builder
            .header(header::CONTENT_DISPOSITION, file.disposition())
            .header(header::CACHE_CONTROL, "no-cache")
            .header(header::CONTENT_TYPE, "application/zip");
        return stream_file(
            &file.path,
            req,
            builder,
            etag,
            "No saved archive file was found",
        )
        .await;
    }
    let Some((reader, token)) = state
        .reader
        .as_ref()
        .zip(req.uri().path().strip_prefix("/texthooker/audio/"))
    else {
        return full(handle_request(state, req).await);
    };
    let builder = cors(Response::builder(), req.headers());
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        let code = if req.method() == Method::OPTIONS {
            StatusCode::OK
        } else {
            StatusCode::METHOD_NOT_ALLOWED
        };
        return full(
            builder
                .status(code)
                .header(header::ALLOW, "GET, HEAD, OPTIONS")
                .body(Full::default())
                .unwrap(),
        );
    }
    let Some(asset) = reader.audio_asset(token) else {
        return full(
            builder
                .status(StatusCode::NOT_FOUND)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Full::new(Bytes::from_static(
                    br#"{"error":"Audio token not found"}"#,
                )))
                .unwrap(),
        );
    };
    // An issued token always identifies one immutable generated file.
    let etag = format!("\"{token}\"");
    let builder = builder.header(
        header::CACHE_CONTROL,
        "no-store, no-cache, must-revalidate, max-age=0",
    );
    stream_file(
        asset.as_ref(),
        req,
        builder,
        etag,
        "Audio file no longer available",
    )
    .await
}

async fn stream_file(
    path: &Path,
    mut req: Request<Incoming>,
    builder: http::response::Builder,
    etag: String,
    missing: &str,
) -> Response<Body> {
    let builder = builder.header(header::ETAG, &etag);
    if let Some(condition) = req.headers_mut().remove(header::IF_NONE_MATCH) {
        if condition.to_str().ok().is_some_and(|s| {
            s.split(',')
                .map(str::trim)
                .any(|v| v == "*" || v.trim_start_matches("W/") == etag)
        }) {
            return full(
                builder
                    .status(StatusCode::NOT_MODIFIED)
                    .body(Full::default())
                    .unwrap(),
            );
        }
        req.headers_mut().remove(header::IF_MODIFIED_SINCE);
    }
    if let Some(condition) = req.headers().get(header::IF_RANGE) {
        let value = condition.to_str().unwrap_or_default();
        let matches = if value == etag {
            true
        } else if let Ok(date) = httpdate::parse_http_date(value) {
            tokio::fs::metadata(path)
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .is_some_and(|mtime| {
                    httpdate::HttpDate::from(mtime) <= httpdate::HttpDate::from(date)
                })
        } else {
            false
        };
        if !matches {
            req.headers_mut().remove(header::RANGE);
        }
    }
    let mut response = match ServeFile::new(path).try_call(req).await {
        Ok(response) => response.map(|b| b.boxed_unsync()),
        Err(_) => {
            return full(
                builder
                    .status(StatusCode::NOT_FOUND)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Full::new(Bytes::from(
                        serde_json::json!({"error":missing}).to_string(),
                    )))
                    .unwrap(),
            )
        }
    };
    response
        .headers_mut()
        .extend(builder.body(()).unwrap().into_parts().0.headers);
    response
}
