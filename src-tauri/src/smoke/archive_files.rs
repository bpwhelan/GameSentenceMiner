use reqwest::{header, Client, StatusCode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

pub(super) async fn verify(
    http: &Client,
    api: &str,
    profile: &Path,
    game_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let file_id = format!("{:x}", Sha256::digest(game_id.as_bytes()));
    let directory = profile.join("archives/games");
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("ゲーム--{file_id}.gsm-archive.zip"));
    let mut zip = zip::ZipWriter::new(fs::File::create(&path)?);
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())?;
    serde_json::to_writer(
        &mut zip,
        &json!({
            "format":"gsm-game-archive","version":1,"game_id":game_id,"game":{"id":game_id},
            "game_name":"ゲーム","line_count":0
        }),
    )?;
    zip.start_file("game_lines.jsonl", zip::write::SimpleFileOptions::default())?;
    drop(zip.finish()?);
    let length = path.metadata()?.len();
    let list: Value = http
        .get(format!("{api}/database/archive-files"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if !list["archives"].as_array().is_some_and(|files| {
        files.iter().any(|f| {
            f["file_id"] == file_id && f["can_restore"] == true && f["size_bytes"] == length
        })
    }) {
        return Err(format!("Missing archive in desktop catalog: {list}").into());
    }
    let url = format!("{api}/database/archive-files/{file_id}/download");
    let head = http.head(&url).send().await?.error_for_status()?;
    let headers = head.headers();
    if headers[header::CONTENT_LENGTH].to_str()?.parse::<u64>()? != length
        || headers[header::CONTENT_TYPE] != "application/zip"
        || !headers[header::CONTENT_DISPOSITION]
            .to_str()?
            .contains("filename*=UTF-8''")
        || headers["x-gsm-handler"] != "rust"
    {
        return Err("Incorrect archive download headers".into());
    }
    let cached = http
        .get(&url)
        .header(header::IF_NONE_MATCH, headers[header::ETAG].clone())
        .send()
        .await?;
    if cached.status() != StatusCode::NOT_MODIFIED {
        return Err("Archive validator did not match".into());
    }
    let part = http
        .get(&url)
        .header(header::RANGE, "bytes=0-7")
        .send()
        .await?;
    if part.status() != StatusCode::PARTIAL_CONTENT
        || part.bytes().await?.as_ref() != &fs::read(&path)?[..8]
    {
        return Err("Archive download range mismatch".into());
    }
    let preview: Value = http
        .post(format!("{api}/games/archive/preview"))
        .json(&json!({"game_ids":[game_id,game_id]}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if preview != json!({"game_count":1,"raw_lines":0}) {
        return Err(format!("Unexpected archive preview: {preview}").into());
    }
    let settings: Value = http
        .put(format!("{api}/database/maintenance"))
        .json(&json!({"vacuum_interval_days":30}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if settings["settings"]["vacuum_interval_days"] != 30 {
        return Err(format!("Unexpected retention setting: {settings}").into());
    }
    for (action, payload, expected) in [
        (
            format!("{api}/database/archive-files/{file_id}/restore"),
            json!({"confirm":true}),
            "restored_lines",
        ),
        (
            format!("{api}/database/archive-files/{file_id}/delete"),
            json!({"confirm":true}),
            "filename",
        ),
        (format!("{api}/database/vacuum"), Value::Null, "after_bytes"),
    ] {
        let response = http.post(action).json(&payload).send().await?;
        if response.status() != StatusCode::ACCEPTED
            || response.headers()["x-gsm-handler"] != "rust"
        {
            return Err(format!("Desktop maintenance job rejected: {}", response.status()).into());
        }
        let job: Value = response.json().await?;
        let status_url = format!(
            "{api}/database/maintenance/jobs/{}",
            job["id"].as_str().ok_or("Missing maintenance job id")?
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let status: Value = http
                .get(&status_url)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            if status["status"] == "completed" && status["result"].get(expected).is_some() {
                break;
            }
            if status["status"] != "running" || std::time::Instant::now() >= deadline {
                return Err(format!("Unexpected maintenance result: {status}").into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    if path.exists() || http.get(url).send().await?.status() != StatusCode::NOT_FOUND {
        return Err("Deleted ZIP remained available for download".into());
    }
    Ok(())
}
