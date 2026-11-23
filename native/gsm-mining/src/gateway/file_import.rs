use super::{
    empty_response, report_http, Bytes, Full, GatewayState, Incoming, Reports, StatusCode,
};
use http::{header, Method, Request, Response};
use http_body_util::BodyExt;
use multer::{Constraints, Multipart, SizeLimit};
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Cursor, SeekFrom},
    sync::Arc,
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt, BufWriter};

type Error = (StatusCode, String);
type Input = Box<dyn BufRead + Send>;

#[derive(Clone, Copy)]
pub(super) enum Format {
    Mokuro,
    ExStatic,
    Kizuna,
}

impl Format {
    pub(super) fn route(path: &str) -> Option<Self> {
        match path {
            "/api/import-mokuro" => Some(Self::Mokuro),
            "/api/import-exstatic" => Some(Self::ExStatic),
            "/api/import-kizuna" => Some(Self::Kizuna),
            _ => None,
        }
    }
}

fn multipart_error(e: multer::Error) -> Error {
    let status = match e {
        multer::Error::FieldSizeExceeded { .. } | multer::Error::StreamSizeExceeded { .. } => {
            StatusCode::PAYLOAD_TOO_LARGE
        }
        _ => StatusCode::BAD_REQUEST,
    };
    (status, e.to_string())
}
fn io_error(e: impl std::fmt::Display) -> Error {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

// Keep small files in memory. Move large files to an unnamed temporary file so
// form fields after the upload are available before the SQLite transaction.
async fn receive(mut field: multer::Field<'_>) -> Result<Input, Error> {
    const SPOOL_AT: usize = 512 * 1024;
    let mut buffer = Vec::new();
    let mut spool = None::<BufWriter<tokio::fs::File>>;
    while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
        if spool.is_none() && buffer.len() + chunk.len() > SPOOL_AT {
            let file = tokio::task::spawn_blocking(tempfile::tempfile)
                .await
                .map_err(io_error)?
                .map_err(io_error)?;
            let mut writer = BufWriter::with_capacity(64 * 1024, tokio::fs::File::from_std(file));
            writer.write_all(&buffer).await.map_err(io_error)?;
            buffer = Vec::new();
            spool = Some(writer);
        }
        if let Some(writer) = spool.as_mut() {
            writer.write_all(&chunk).await.map_err(io_error)?;
        } else {
            buffer.extend_from_slice(&chunk);
        }
    }
    if let Some(mut writer) = spool {
        writer.flush().await.map_err(io_error)?;
        let mut file = writer.into_inner();
        file.seek(SeekFrom::Start(0)).await.map_err(io_error)?;
        Ok(Box::new(BufReader::with_capacity(
            64 * 1024,
            file.into_std().await,
        )))
    } else {
        Ok(Box::new(Cursor::new(buffer)))
    }
}

async fn upload(req: Request<Incoming>, format: Format) -> Result<(Input, bool), Error> {
    let missing = |reason: &str| {
        (
            StatusCode::BAD_REQUEST,
            if matches!(format, Format::Kizuna) {
                "Please select a Kizuna CSV file".to_owned()
            } else {
                reason.to_owned()
            },
        )
    };
    let no_file = || missing("No file provided");
    let boundary = multer::parse_boundary(
        req.headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    )
    .map_err(|_| no_file())?;
    let constraints = Constraints::new().size_limit(SizeLimit::new().whole_stream(1 << 30));
    let mut parts =
        Multipart::with_constraints(req.into_body().into_data_stream(), boundary, constraints);
    let mut file = None;
    let mut clear = None;
    while let Some(field) = parts.next_field().await.map_err(multipart_error)? {
        match field.name() {
            Some("file") if file.is_none() && field.file_name().is_some() => {
                let name = field.file_name().unwrap();
                if name.is_empty() {
                    return Err(missing("No file selected"));
                }
                let (extension, description) = match format {
                    Format::Mokuro => ("json", "JSON"),
                    Format::ExStatic | Format::Kizuna => ("csv", "CSV"),
                };
                if !name
                    .rsplit_once('.')
                    .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case(extension))
                {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!("File must be a {description} file"),
                    ));
                }
                file = Some(receive(field).await?);
            }
            Some("clear_previous") if clear.is_none() && field.file_name().is_none() => {
                let mut field = field;
                let mut prefix = Vec::with_capacity(4);
                let mut excess = false;
                while let Some(bytes) = field.chunk().await.map_err(multipart_error)? {
                    if prefix.len() + bytes.len() > 4 {
                        excess = true;
                    } else {
                        prefix.extend_from_slice(&bytes);
                    }
                }
                clear = Some(!excess && prefix.eq_ignore_ascii_case(b"true"));
            }
            _ => {}
        }
    }
    Ok((file.ok_or_else(no_file)?, clear.unwrap_or(false)))
}

pub(super) async fn handle(
    reports: Arc<Reports>,
    state: &GatewayState,
    req: Request<Incoming>,
    format: Format,
) -> Response<Full<Bytes>> {
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
    let Ok(permit) = state.report_slots.clone().acquire_owned().await else {
        return empty_response(StatusCode::SERVICE_UNAVAILABLE);
    };
    let result = async {
        let owner = reports.clone();
        let gen = tokio::task::spawn_blocking(move || owner.begin_file_import())
            .await
            .map_err(io_error)?;
        let generation = match gen {
            Ok(value) => value,
            Err(reply) => return Ok(reply),
        };
        let (file, clear) = upload(req, format).await?;
        match format {
            Format::Mokuro => {
                let reply = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    reports.import_mokuro(generation, file, clear)
                })
                .await
                .map_err(io_error)?;
                if reply.status == 200
                    && (reply.body["cleared_count"].as_u64().unwrap_or(0) > 0
                        || reply.body["imported_count"].as_u64().unwrap_or(0) > 0)
                {
                    if let Some(reader) = &state.reader {
                        reader.reading_stats_changed().await;
                    }
                }
                Ok(reply)
            }
            Format::ExStatic => {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    reports.import_exstatic(generation, file)
                })
                .await
                .map_err(io_error)?;
                let mut imported = match result {
                    Ok(value) => value,
                    Err(reply) => return Ok(reply),
                };
                let queued = if let Some(reader) = &state.reader {
                    let (dictionary, ids) = imported.take_index_ids();
                    reader.imported_lines(dictionary, ids, generation).await
                } else {
                    false
                };
                Ok(imported.reply(queued))
            }
            Format::Kizuna => {
                let result=tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    reports.import_kizuna(generation,file,clear)
                }).await.map_err(io_error)?;
                let mut body=match result {Ok(value)=>value, Err(reply)=>return Ok(reply)};
                let needs_metadata=body["vndb_games_count"].as_u64().unwrap_or(0)>0;
                let mut queued=false;
                if let Some(reader)=&state.reader {
                    if needs_metadata {queued=reader.queue_game_metadata();}
                    if body["imported_count"] != 0 || body["cleared_count"] != 0 {
                        reader.library_changed().await;
                        reader.reading_stats_changed().await;
                    }
                }
                let (status,message)=if !needs_metadata {
                    ("not_needed","No new VNDB-linked sessions to refresh.")
                }else if queued{
                    ("queued","VNDB metadata refresh queued.")
                }else{
                    ("failed","Import saved, but metadata refresh could not be queued. Run Game Data Update from Background Tasks.")
                };
                body["metadata_refresh_status"]=status.into();
                body["metadata_refresh_message"]=message.into();
                body["message"]=format!("Imported {} Kizuna sessions from {} games.",body["imported_count"],body["games_count"]).into();
                Ok(gsm_web::Reply{status:200,body})
            }
        }
    }
    .await;
    let (status, body) = match result {
        Ok(reply) => (reply.status, reply.body),
        Err((status, message)) => (status.as_u16(), json!({"error":message})),
    };
    builder
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(
            serde_json::to_vec(&body).expect("JSON response").into(),
        ))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{beacon::BeaconReceiver, gateway::start_with_services};

    #[tokio::test]
    async fn reads_large_multipart_mokuro_uploads_with_trailing_options() {
        let profile = tempfile::tempdir().unwrap();
        let path = profile.path().join("gsm.db");
        let db = gsm_db::open_profile(&path, "ja").unwrap();
        db.execute(
            "INSERT INTO third_party_stats(source,date) VALUES('mokuro','2021-01-01')",
            [],
        )
        .unwrap();
        let reports = Arc::new(Reports::new(profile.path(), Default::default()));
        let gateway = start_with_services(
            "127.0.0.1",
            0,
            BeaconReceiver::new(4).0,
            None,
            0,
            Some(reports),
        )
        .await
        .unwrap();
        let url = format!("http://{}/api/import-mokuro", gateway.bound_addr);
        let content = json!({"uuid":{"volume_title":"古い本","chars":12,"addedOn":"2025-03-11","cover":"x".repeat(650_000)}});
        let multipart=format!("--form\r\nContent-Disposition: form-data; name=\"file\"; filename=\"volume-data.json\"\r\nContent-Type: application/json\r\n\r\n\u{feff}{content}\r\n--form\r\nContent-Disposition: form-data; name=\"clear_previous\"\r\n\r\nTRUE\r\n--form--\r\n");
        let response = reqwest::Client::new()
            .post(url)
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=\"form\"",
            )
            .body(multipart)
            .send()
            .await
            .unwrap();
        assert_eq!(response.headers()["x-gsm-handler"], "rust");
        assert_eq!(response.status(), StatusCode::OK);
        let result = response.json::<serde_json::Value>().await.unwrap();
        assert_eq!(result["imported_count"], 1);
        assert_eq!(result["cleared_count"], 1);
        assert_eq!(
            db.query_row(
                "SELECT label FROM third_party_stats WHERE source='mokuro'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "古い本"
        );
        gateway.shutdown();
    }
}
