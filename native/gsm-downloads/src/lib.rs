//! Delivery policy for GSM assets. The public mirrors use identical object names.
use fs2::FileExt;
use reqwest::{blocking::Client, StatusCode, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

const R2: &str = "https://r2.gamesentenceminer.com/downloads/v1";
const GITHUB: &str =
    "https://github.com/bpwhelan/GameSentenceMiner/releases/download/gsm-assets-v1";
pub const MAX_BYTES: u64 = 1024 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

pub fn hash(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(format!("{:x}", hasher.finalize()));
        }
        hasher.update(&buffer[..count]);
    }
}

#[derive(Deserialize)]
struct Asset {
    sha256: String,
    bytes: u64,
    origin: Option<String>,
}

fn catalog() -> &'static BTreeMap<String, Asset> {
    static CATALOG: OnceLock<BTreeMap<String, Asset>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../assets.json")).expect("embedded GSM asset catalog")
    })
}

pub fn contains(id: &str) -> bool {
    catalog().contains_key(id)
}

fn mirror_urls(name: &str) -> [String; 2] {
    [format!("{R2}/{name}"), format!("{GITHUB}/{name}")]
}

pub fn revision(value: &str) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && !name.ends_with('.')
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'+'))
}

/// Pinned files use their SHA-256 as the mirror key. Legacy HTTPS origins
/// retain their URL, with a URL-derived mirror key only for known GSM or
/// upstream package hosts. HTTP fixtures and custom mirrors go direct.
pub fn sources(origin: &str, expected: Option<&str>) -> Vec<String> {
    let Ok(url) = Url::parse(origin) else {
        return vec![origin.into()];
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return vec![origin.into()];
    }
    let Some(name) = url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .filter(|name| safe_name(name))
    else {
        return vec![origin.into()];
    };
    let digest = expected.filter(|hash| valid_digest(hash));
    let key = if let Some(hash) = digest {
        format!("{hash}-{name}")
    } else if matches!(
        url.host_str(),
        Some(
            "r2.gamesentenceminer.com"
                | "github.com"
                | "codeload.github.com"
                | "raw.githubusercontent.com"
                | "huggingface.co"
                | "www.ocenaudio.com"
        )
    ) && url.query().is_none()
        && !url.path().contains("/latest/")
    {
        format!("origin-{}-{name}", revision(origin))
    } else {
        return vec![origin.into()];
    };
    let [r2, github] = mirror_urls(&key);
    vec![r2, github, origin.into()]
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Checks local assets first so earlier installs and development builds keep
/// working offline. Shared cache entries are immutable and process-locked.
pub fn cached_asset(cache: &Path, id: &str, bundled: Option<&Path>) -> Option<PathBuf> {
    let asset = catalog().get(id)?;
    if let Some(path) = bundled.filter(|path| {
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.len() == asset.bytes)
    }) {
        return Some(path.to_owned());
    }
    let path = cache.join(&asset.sha256).join(id.rsplit('/').next()?);
    (path
        .metadata()
        .is_ok_and(|m| m.is_file() && m.len() == asset.bytes)
        && hash(&path).as_deref() == Ok(asset.sha256.as_str()))
    .then_some(path)
}

pub fn ensure_asset(cache: &Path, id: &str, bundled: Option<&Path>) -> Result<PathBuf> {
    let asset = catalog()
        .get(id)
        .ok_or_else(|| format!("Unknown GSM download: {id}"))?;
    let valid = |path: &Path| {
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.len() == asset.bytes)
            && hash(path).as_deref() == Ok(asset.sha256.as_str())
    };
    if let Some(path) = bundled.filter(|path| valid(path)) {
        return Ok(path.to_owned());
    }
    let name = id.rsplit('/').next().ok_or("Invalid asset name")?;
    let directory = cache.join(&asset.sha256);
    let path = directory.join(name);
    if valid(&path) {
        return Ok(path);
    }
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(format!("{name}.lock")))
        .map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    if !valid(&path) {
        let mut urls = mirror_urls(&format!("{}-{name}", asset.sha256)).to_vec();
        urls.extend(asset.origin.iter().cloned());
        transfer(&urls, &path, Some(&asset.sha256), asset.bytes, &|_, _| {})?;
    }
    Ok(path)
}

pub fn download(
    origin: &str,
    path: &Path,
    expected: Option<&str>,
    limit: u64,
    progress: &dyn Fn(u64, Option<u64>),
) -> Result<()> {
    transfer(&sources(origin, expected), path, expected, limit, progress)
}

fn transfer(
    urls: &[String],
    path: &Path,
    expected: Option<&str>,
    limit: u64,
    progress: &dyn Fn(u64, Option<u64>),
) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let client = Client::builder()
        .user_agent("GameSentenceMiner")
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let mut errors = Vec::new();
    let mut output = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    for (index, url) in urls.iter().enumerate() {
        let attempts = if index + 1 == urls.len() { 2 } else { 1 };
        for attempt in 0..attempts {
            output.as_file_mut().set_len(0).map_err(|e| e.to_string())?;
            output.rewind().map_err(|e| e.to_string())?;
            match receive(
                &client,
                url,
                output.as_file_mut(),
                expected,
                limit,
                progress,
            ) {
                Ok(()) => {
                    output.as_file().sync_all().map_err(|e| e.to_string())?;
                    output.persist(path).map_err(|e| e.to_string())?;
                    return Ok(());
                }
                Err((message, retry)) => {
                    let host = Url::parse(url)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_owned));
                    errors.push(format!(
                        "{}: {message}",
                        host.as_deref().unwrap_or("Invalid URL")
                    ));
                    if !retry || attempt + 1 == attempts {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        }
    }
    Err(errors.join("; "))
}

fn receive(
    client: &Client,
    url: &str,
    output: &mut fs::File,
    expected: Option<&str>,
    limit: u64,
    progress: &dyn Fn(u64, Option<u64>),
) -> std::result::Result<(), (String, bool)> {
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| (e.without_url().to_string(), true))?;
    let status = response.status();
    if status != StatusCode::OK {
        let retry = status.is_server_error() || matches!(status.as_u16(), 408 | 429);
        return Err((format!("HTTP {status}"), retry));
    }
    let total = response.content_length();
    let mut digest = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 65536];
    let oversized = || (format!("Download exceeds the {limit}-byte limit"), false);
    if total.is_some_and(|size| size > limit) {
        return Err(oversized());
    }
    progress(0, total);
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|e| (e.to_string(), true))?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > limit {
            return Err(oversized());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| (e.to_string(), false))?;
        digest.update(&buffer[..count]);
        progress(bytes, total);
    }
    if bytes == 0 || total.is_some_and(|length| length != bytes) {
        return Err(("Incomplete download".into(), true));
    }
    if expected.is_some_and(|expected| expected != format!("{:x}", digest.finalize())) {
        return Err(("Download SHA-256 mismatch".into(), false));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::BufRead, net::TcpListener};

    fn server(body: &'static [u8]) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/test.bin", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(&socket);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
        });
        (url, worker)
    }

    #[test]
    fn rejects_bad_bytes_then_uses_the_next_mirror() {
        let (bad, first) = server(b"bad");
        let (good, second) = server(b"correct");
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("asset");
        fs::write(&target, b"prior").unwrap();
        transfer(
            &[bad, good],
            &target,
            Some(&revision("correct")),
            32,
            &|_, _| {},
        )
        .unwrap();
        first.join().unwrap();
        second.join().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"correct");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn leaves_existing_file_intact_after_a_failed_download() {
        let (origin, worker) = server(b"too big");
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("asset");
        fs::write(&target, b"prior").unwrap();
        let error = download(&origin, &target, None, 4, &|_, _| {}).unwrap_err();
        worker.join().unwrap();
        assert!(error.contains("4-byte limit"));
        assert_eq!(fs::read(&target).unwrap(), b"prior");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn content_keys_match_the_release_mirrors() {
        let origin =
            "https://github.com/bpwhelan/GameSentenceMiner/releases/download/v1.2.3/model.onnx";
        let digest = revision("model");
        assert_eq!(
            sources(origin, Some(&digest)),
            vec![
                format!("{R2}/{digest}-model.onnx"),
                format!("{GITHUB}/{digest}-model.onnx"),
                origin.into()
            ]
        );
        assert_eq!(
            sources(
                "https://github.com/owner/repo/releases/latest/download/model.onnx",
                None
            )
            .len(),
            1
        );
        for (id, asset) in catalog() {
            assert!(safe_name(id.rsplit('/').next().unwrap()));
            assert!(valid_digest(&asset.sha256) && (1..=MAX_BYTES).contains(&asset.bytes));
        }
    }
}
