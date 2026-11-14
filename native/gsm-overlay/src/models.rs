use anyhow::{Context, Result, bail, ensure};

/// Resolve dependencies beside the selected OCR DLL without changing the
/// desktop process's DLL search path (WebView2 and other engines share it).
/// # Safety
/// The caller must uphold the loaded library's ABI and lifetime requirements.
pub unsafe fn load_library(path: &std::path::Path) -> Result<libloading::Library> {
    #[cfg(windows)]
    {
        Ok(
            unsafe { libloading::os::windows::Library::load_with_flags(path, 0x100 | 0x1000)? }
                .into(),
        )
    }
    #[cfg(not(windows))]
    {
        Ok(unsafe { libloading::Library::new(path)? })
    }
}
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

pub fn home() -> Result<PathBuf> {
    directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .context("Cannot determine home directory")
}

pub fn http_client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .user_agent("GameSentenceMiner-Rust-OCR/0.1")
        .build()?)
}

pub fn download(url: &str, destination: &Path) -> Result<()> {
    std::fs::create_dir_all(destination.parent().context("Missing download directory")?)?;
    let temporary = destination.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        crate::logging::info(format!(
            "Downloading {}",
            destination
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        ));
        let mut response = http_client()?.get(url).send()?.error_for_status()?;
        let length = response.content_length();
        let mut output = std::fs::File::create(&temporary)?;
        let bytes = std::io::copy(&mut response, &mut output)?;
        output.flush()?;
        if bytes == 0 || length.is_some_and(|len| len != bytes) {
            bail!("Incomplete model download");
        }
        output.sync_all()?;
        drop(output);
        std::fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub fn model(root: &Path, repo: &str, name: &str) -> Result<PathBuf> {
    let destination = root.join(name);
    if destination.is_file() {
        return Ok(destination);
    }
    // Reuse data from an earlier GSM installation without importing any Python packages.
    let cache = std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".cache/huggingface/hub"));
    let snapshots = cache
        .join(format!("models--{}", repo.replace('/', "--")))
        .join("snapshots");
    if let Ok(entries) = std::fs::read_dir(snapshots) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(name);
            if candidate.is_file() {
                std::fs::create_dir_all(root)?;
                std::fs::copy(candidate, &destination)?;
                return Ok(destination);
            }
        }
    }
    download(
        &format!("https://huggingface.co/{repo}/resolve/main/{name}"),
        &destination,
    )?;
    Ok(destination)
}

pub fn verify_sha256(path: &Path, expected: &str) -> Result<()> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    ensure!(
        format!("{:x}", hasher.finalize()) == expected,
        "Model checksum failed: {}",
        path.display()
    );
    Ok(())
}

/// Preserve existing files on a failed download or validation. Models are
/// immutable at their pinned revision and shared with earlier GSM installs.
pub fn pinned_model(
    root: &Path,
    repo: &str,
    revision: &str,
    name: &str,
    digest: &str,
) -> Result<PathBuf> {
    let destination = root.join(name);
    if destination.is_file() {
        verify_sha256(&destination, digest)?;
        return Ok(destination);
    }
    std::fs::create_dir_all(root)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(format!("{name}.lock")))?;
    lock.try_lock()
        .context("This model is being installed by another GSM operation; retry shortly")?;
    if destination.is_file() {
        verify_sha256(&destination, digest)?;
        return Ok(destination);
    }
    let cache = std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".cache/huggingface/hub"));
    let cached = cache
        .join(format!("models--{}", repo.replace('/', "--")))
        .join("snapshots")
        .join(revision)
        .join(name);
    let temporary = tempfile::NamedTempFile::new_in(root)?;
    if cached.is_file() {
        verify_sha256(&cached, digest)?;
        std::fs::copy(cached, temporary.path())?;
    } else {
        download(
            &format!("https://huggingface.co/{repo}/resolve/{revision}/{name}"),
            temporary.path(),
        )?;
    }
    verify_sha256(temporary.path(), digest)?;
    temporary.as_file().sync_all()?;
    temporary.persist(&destination)?;
    Ok(destination)
}

fn extract_archive(url: &str, root: &Path) -> Result<()> {
    std::fs::create_dir_all(root)?;
    let archive_path = root.join(format!("download-{}.zip", uuid::Uuid::new_v4()));
    download(url, &archive_path)?;
    let result = (|| -> Result<()> {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&archive_path)?)?;
        for i in 0..archive.len() {
            let mut item = archive.by_index(i)?;
            if item.is_dir() {
                continue;
            }
            let relative = item
                .enclosed_name()
                .context("Unsafe path in OCR model archive")?;
            let output = root.join(relative);
            std::fs::create_dir_all(output.parent().context("Missing archive parent")?)?;
            let mut bytes = Vec::new();
            item.read_to_end(&mut bytes)?;
            let tmp = output.with_extension("part");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(tmp, output)?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(archive_path);
    result
}

pub fn ensure_oneocr() -> Result<()> {
    if !cfg!(windows) {
        bail!("OneOCR local recognition requires Windows");
    }
    let root = home()?.join(".config/oneocr");
    let files = ["oneocr.dll", "oneocr.onemodel", "onnxruntime.dll"];
    if files.iter().all(|f| root.join(f).is_file()) {
        return Ok(());
    }
    extract_archive("https://r2.gamesentenceminer.com/oneocr.zip", &root)?;
    if !files.iter().all(|f| root.join(f).is_file()) {
        bail!("OneOCR download is missing required files");
    }
    Ok(())
}

pub fn screenai_library() -> &'static str {
    if cfg!(windows) {
        "chrome_screen_ai.dll"
    } else if cfg!(target_os = "macos") {
        "libchromescreenai.dylib"
    } else {
        "libchromescreenai.so"
    }
}
pub fn ensure_screenai() -> Result<PathBuf> {
    let root = home()?.join(".config/screen_ai");
    let find = || {
        [root.clone(), root.join("resources")]
            .into_iter()
            .find(|p| {
                p.join(screenai_library()).is_file() && p.join("files_list_ocr.txt").is_file()
            })
    };
    if let Some(path) = find() {
        return Ok(path);
    }
    let platform = if cfg!(windows) {
        "windows-amd64"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-amd64"
        }
    } else {
        "linux"
    };
    extract_archive(
        &format!("https://r2.gamesentenceminer.com/screenai/screen-ai-{platform}.zip"),
        &root,
    )?;
    find().context("ScreenAI archive is missing its runtime or manifest")
}
