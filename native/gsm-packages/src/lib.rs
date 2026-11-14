pub mod anki_beacon;
pub mod changelog;
pub mod data_relocate;
pub mod engines;
pub mod install_session;
pub mod log_archive;
pub mod log_redaction;
pub mod python;
pub mod scripts;
pub mod settings_backup;
pub mod updates;
use gsm_settings::Result;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    time::Duration,
};
pub fn hash(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn client(seconds: u64) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent("GameSentenceMiner")
        .timeout(Duration::from_secs(seconds))
        .build()
        .map_err(|e| e.to_string())
}
pub fn fetch_json(url: &str) -> Result<serde_json::Value> {
    let mut last = String::new();
    for attempt in 0..2 {
        match client(30)?
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
        {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = format!("{url}: {e}");
                if e.status()
                    .is_some_and(|s| s.is_client_error() && s.as_u16() != 408 && s.as_u16() != 429)
                {
                    break;
                }
            }
        }
        if attempt == 0 {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    Err(last)
}
pub fn download(
    url: &str,
    path: &Path,
    expected: Option<&str>,
    progress: &dyn Fn(u64, Option<u64>),
) -> Result<()> {
    let mut last = String::new();
    for attempt in 0..2 {
        let result: Result<()> = (|| {
            let mut response = client(120)?
                .get(url)
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(|e| e.to_string())?;
            let total = response.content_length();
            if total.is_some_and(|n| n > 1024 * 1024 * 1024) {
                return Err("Archive exceeds 1 GiB limit".into());
            }
            let mut file = File::create(path).map_err(|e| e.to_string())?;
            let mut digest = Sha256::new();
            let mut bytes = 0;
            let mut buffer = [0; 65536];
            loop {
                let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                if bytes > 1024 * 1024 * 1024 {
                    return Err("Archive exceeds 1 GiB limit".into());
                }
                file.write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
                digest.update(&buffer[..count]);
                progress(bytes, total);
            }
            file.sync_all().map_err(|e| e.to_string())?;
            if expected.is_some_and(|expected| expected != format!("{:x}", digest.finalize())) {
                return Err("Archive SHA-256 mismatch".into());
            }
            Ok(())
        })();
        match result {
            Ok(()) => return Ok(()),
            Err(e) => last = format!("{url}: {e}"),
        }
        if attempt == 0 {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    let _ = fs::remove_file(path);
    Err(last)
}
/// Never extract links, duplicate/case-colliding paths, or paths escaping staging.
pub fn extract(
    archive: &Path,
    directory: &Path,
    expected: Option<&std::collections::HashSet<String>>,
) -> Result<()> {
    extract_with_progress(archive, directory, expected, &mut |_| {})
}

/// Safe ZIP extraction with entry progress notification.
pub fn extract_with_progress(
    archive: &Path,
    directory: &Path,
    expected: Option<&std::collections::HashSet<String>>,
    on_entry: &mut dyn FnMut(&str),
) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut expanded = 0u64;
    if zip.len() > 100000 {
        return Err("Too many archive entries".into());
    }
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_owned();
        on_entry(&name);
        if name.contains('\\')
            || name.contains(':')
            || name.starts_with('/')
            || name
                .split('/')
                .any(|s| s == "." || s == ".." || s.ends_with('.') || s.ends_with(' '))
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("Unsafe ZIP entry: {name}"));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("Duplicate ZIP entry: {name}"));
        }
        if let Some(expected) = expected {
            if !expected.contains(&name) {
                return Err(format!("Unexpected ZIP entry: {name}"));
            }
        }
        let output = directory.join(entry.enclosed_name().ok_or("Unsafe archive path")?);
        if entry.is_dir() {
            fs::create_dir_all(output).map_err(|e| e.to_string())?;
            continue;
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or("Archive too large")?;
        if expanded > 2 * 1024 * 1024 * 1024 {
            return Err("Expanded archive exceeds limit".into());
        }
        fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(output)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    Ok(())
}
