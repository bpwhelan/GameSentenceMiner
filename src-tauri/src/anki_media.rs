//! Upload mined audio, images and video without copying encoded media through IPC.
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::{
    io,
    path::PathBuf,
    time::{Duration, UNIX_EPOCH},
};
use tokio::{fs::File, io::AsyncReadExt};

// Complete triples can be encoded independently. Only the last block has padding.
const BLOCK: usize = 48 * 1024;
const SUFFIX: &[u8] = br#""}}"#;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Upload {
    path: PathBuf,
    filename: String,
    url: reqwest::Url,
    size: u64,
    modified_ns: u64,
}

pub async fn store_file(
    client: &reqwest::Client,
    url: &reqwest::Url,
    path: &std::path::Path,
    filename: &str,
) -> Result<String, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    let modified = metadata
        .modified()
        .map_err(|e| format!("mtime {}: {e}", path.display()))?;
    let modified_ns = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos() as u64;
    let upload = Upload {
        path: path.to_path_buf(),
        filename: filename.to_string(),
        url: url.clone(),
        size: metadata.len(),
        modified_ns,
    };
    let reply = store(client, upload).await?;
    if !reply["error"].is_null() {
        return Err(reply["error"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| reply["error"].to_string()));
    }
    Ok(reply["result"]
        .as_str()
        .unwrap_or(filename)
        .to_string())
}

pub async fn store(client: &reqwest::Client, upload: Upload) -> Result<Value, String> {
    let mut url = upload.url.clone();
    for _ in 0..=10 {
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Invalid AnkiConnect URL".into());
        }
        let response = post(client, &url, &upload).await?;
        if matches!(response.status().as_u16(), 307 | 308) {
            // reqwest cannot automatically rewind a streamed body. Reopen and
            // revalidate the same file only on an explicit redirect.
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("Missing AnkiConnect redirect location")?;
            url = response.url().join(location).map_err(|e| e.to_string())?;
            continue;
        }
        return response
            .error_for_status()
            .map_err(|e| e.without_url().to_string())?
            .json()
            .await
            .map_err(|e| e.without_url().to_string());
    }
    Err("Too many AnkiConnect redirects".into())
}

async fn post(
    client: &reqwest::Client,
    url: &reqwest::Url,
    upload: &Upload,
) -> Result<reqwest::Response, String> {
    let file = File::open(&upload.path).await.map_err(|e| e.to_string())?;
    let metadata = file.metadata().await.map_err(|e| e.to_string())?;
    let modified = metadata.modified().map_err(|e| e.to_string())?;
    if !metadata.is_file()
        || metadata.len() != upload.size
        || modified
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|t| t.as_nanos())
            != Some(upload.modified_ns.into())
    {
        return Err("The media file changed before it could be uploaded".into());
    }
    let name = serde_json::to_string(&upload.filename).map_err(|e| e.to_string())?;
    let prefix =
        format!(r#"{{"action":"storeMediaFile","version":6,"params":{{"filename":{name},"data":""#)
            .into_bytes();
    let length = upload
        .size
        .div_ceil(3)
        .checked_mul(4)
        .and_then(|n| n.checked_add((prefix.len() + SUFFIX.len()) as u64))
        .ok_or("Media is too large")?;
    let blocks = stream::try_unfold(
        (file, vec![0_u8; BLOCK], upload.size),
        |(mut file, mut buf, remaining)| async move {
            if remaining == 0 {
                return Ok(None);
            }
            let n = remaining.min(BLOCK as u64) as usize;
            file.read_exact(&mut buf[..n]).await?;
            let encoded = STANDARD.encode(&buf[..n]).into_bytes();
            Ok::<_, io::Error>(Some((encoded, (file, buf, remaining - n as u64))))
        },
    );
    let body = stream::iter([Ok(prefix)])
        .chain(blocks)
        .chain(stream::iter([Ok(SUFFIX.to_vec())]));
    client
        .post(url.clone())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::CONTENT_LENGTH, length)
        .body(reqwest::Body::wrap_stream(body))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())
}
