//! Locate the Windows Live Captions assets and atomically install an offline or downloaded bundle.
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;
const BUNDLE: &str = "DirectLiveCaptions";
const CORE: &str = "Microsoft.CognitiveServices.Speech.core.dll";
const DEFAULT_URL: &str = "https://r2.gamesentenceminer.com/DirectLiveCaptions.zip";

pub fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
}

fn roots(base: &Path) -> [PathBuf; 2] {
    [base.join(BUNDLE), base.to_owned()]
}

fn model(root: &Path, locale: &str) -> Option<PathBuf> {
    if root.join("sr.ini").is_file() {
        return Some(root.into());
    }
    let prefix = format!("microsoftwindows.speech.{}.1_", locale.to_ascii_lowercase());
    fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with(&prefix)
        })
        .map(|e| e.path())
        .filter(|p| p.join("sr.ini").is_file())
        .min()
}

fn complete(root: &Path) -> bool {
    root.join(CORE).is_file()
        && ["en-US", "ja-JP", "zh-CN"]
            .iter()
            .filter_map(|locale| model(root, locale))
            .any(|p| p.join("svad.quantized.onnx").is_file())
}

/// An explicit file URL belongs to the caller. Downloaded archives are temporary.
pub fn prepare_bundle(
    cache: &Path,
    url: &str,
    progress: &dyn Fn(u64, Option<u64>),
) -> Result<PathBuf> {
    let existing = || roots(cache).into_iter().find(|p| complete(p));
    if let Some(root) = existing() {
        return Ok(root);
    }
    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(cache.join(".install.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    if let Some(root) = existing() {
        return Ok(root);
    }
    let stage = tempfile::tempdir_in(cache).map_err(|e| e.to_string())?;
    let url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let cached_zip = cache.join("DirectLiveCaptions.zip");
    let local = url.scheme() == "file";
    let archive = if local {
        if url
            .host_str()
            .is_some_and(|host| !host.eq_ignore_ascii_case("localhost"))
        {
            return Err("A local speech bundle must use a local file path.".into());
        }
        url.to_file_path()
            .map_err(|_| "Invalid local speech bundle path")?
    } else if cached_zip.is_file() {
        cached_zip.clone()
    } else {
        let path = stage.path().join("download.zip");
        crate::downloads::download(
            url.as_str(),
            &path,
            None,
            crate::downloads::MAX_BYTES,
            progress,
        )?;
        path
    };
    let unpack = stage.path().join("unpacked");
    let extract = || {
        let size = archive.metadata().map_err(|e| e.to_string())?.len();
        if size > crate::downloads::MAX_BYTES {
            return Err("The Windows speech bundle exceeds the archive size limit".to_owned());
        }
        if local {
            progress(size, Some(size));
        }
        crate::extract_with_entry_limit(&archive, &unpack, None, 4096, &mut |_| {})?;
        roots(&unpack)
            .into_iter()
            .find(|p| complete(p))
            .ok_or_else(|| "Speech bundle is missing its runtime or model packages".into())
    };
    let source = extract();
    if !local && archive == cached_zip {
        let _ = fs::remove_file(cached_zip);
    }
    let source = source?;
    let target = cache.join(BUNDLE);
    if target.exists() {
        let invalid = cache.join(format!(".{BUNDLE}.invalid-{}", uuid::Uuid::new_v4()));
        rename_retry(&target, &invalid).map_err(|e| e.to_string())?;
        if let Err(e) = rename_retry(&source, &target) {
            rename_retry(&invalid, &target)
                .map_err(|restore| format!("{e}; restore failed: {restore}"))?;
            return Err(e.to_string());
        }
    } else {
        rename_retry(&source, &target).map_err(|e| e.to_string())?;
    }
    Ok(target)
}

fn rename_retry(from: &Path, to: &Path) -> io::Result<()> {
    for delay in [40, 80, 160, 320, 640] {
        match fs::rename(from, to) {
            Err(e) if cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33)) => {
                std::thread::sleep(Duration::from_millis(delay))
            }
            result => return result,
        }
    }
    fs::rename(from, to)
}

#[cfg(windows)]
fn installed_model(locale: &str) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    // Get-AppxPackage also works for non-elevated users without access to WindowsApps.
    let script =
        format!("(Get-AppxPackage -Name 'MicrosoftWindows.Speech.{locale}.1').InstallLocation");
    let query = || {
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .ok()?;
        let started = Instant::now();
        while matches!(child.try_wait(), Ok(None)) {
            if started.elapsed() >= Duration::from_secs(5) {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let output = child.wait_with_output().ok()?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .map(PathBuf::from)
            .find(|p| p.join("sr.ini").is_file())
    };
    query().or_else(|| model(Path::new(r"C:\Program Files\WindowsApps"), locale))
}

pub struct Embedded {
    pub model: PathBuf,
    pub runtime: PathBuf,
}

pub fn embedded(
    locale: &str,
    configured_model: &str,
    configured_runtime: &str,
    shared: &Path,
    app_root: &Path,
    progress: &dyn Fn(u64, Option<u64>),
) -> Result<Embedded> {
    if !matches!(locale, "ja-JP" | "en-US") {
        return Err("Unsupported Windows speech locale".into());
    }
    let cache =
        env_path("GSM_WINDOWS_SPEECH_CACHE_DIR").unwrap_or_else(|| shared.join("windows-speech"));
    let configured = |path: &str| (!path.is_empty()).then(|| PathBuf::from(path));
    let model_paths = [
        configured(configured_model),
        env_path("GSM_WINDOWS_SPEECH_MODEL_PATH"),
    ];
    let runtime_paths = [
        configured(configured_runtime),
        env_path("GSM_WINDOWS_SPEECH_RUNTIME_PATH"),
    ];
    let mut fallback_error = None;
    if model_paths.iter().all(Option::is_none) || runtime_paths.iter().all(Option::is_none) {
        let url = env::var("GSM_WINDOWS_SPEECH_BUNDLE_URL")
            .ok()
            .filter(|s| !s.trim().is_empty());
        fallback_error =
            prepare_bundle(&cache, url.as_deref().unwrap_or(DEFAULT_URL), progress).err();
    }
    let bases = [
        cache,
        app_root.to_owned(),
        app_root.join("GameSentenceMiner"),
    ];
    let search = |overrides: [Option<PathBuf>; 2]| {
        overrides
            .into_iter()
            .flatten()
            .chain(bases.clone())
            .flat_map(|base| roots(&base))
            .collect::<Vec<_>>()
    };
    let mut selected = search(model_paths).iter().find_map(|p| model(p, locale));
    if selected.is_none() {
        #[cfg(windows)]
        {
            selected = installed_model(locale);
        }
    }
    let model = selected.ok_or_else(|| {
        fallback_error.unwrap_or_else(|| format!("No Windows speech model found for {locale}"))
    })?;
    let runtime = search(runtime_paths)
        .into_iter()
        .chain(std::iter::once(PathBuf::from(
            r"C:\Windows\SystemApps\MicrosoftWindows.Client.Core_cw5n1h2txyewy\LiveCaptions",
        )))
        .find(|p| p.join(CORE).is_file())
        .ok_or("Live Captions runtime not found")?;
    Ok(Embedded { model, runtime })
}
