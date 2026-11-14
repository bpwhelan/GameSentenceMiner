use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
#[derive(Default)]
pub(super) struct Runtime {
    pub release: Option<Value>,
    pub phase: String,
    pub progress: Option<f64>,
    pub error: Option<String>,
    pub checked_at: Option<String>,
    pub automatic_checked: bool,
}
pub fn version(raw: &str) -> Option<[u32; 3]> {
    let parts: Vec<_> = raw.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ])
}
pub fn read_version(executable: &Path) -> Result<Option<String>, String> {
    if !executable.is_file() {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
            },
        };
        let wide: Vec<_> = executable
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
            if size == 0 {
                return Err("Could not read OBS executable version".into());
            }
            let mut buffer = vec![0u8; size as usize];
            GetFileVersionInfoW(
                PCWSTR(wide.as_ptr()),
                None,
                size,
                buffer.as_mut_ptr().cast(),
            )
            .map_err(err)?;
            let mut info = std::ptr::null_mut();
            let mut len = 0;
            let root = [92u16, 0];
            if !VerQueryValueW(
                buffer.as_ptr().cast(),
                PCWSTR(root.as_ptr()),
                &mut info,
                &mut len,
            )
            .as_bool()
                || len < (std::mem::size_of::<VS_FIXEDFILEINFO>() as u32)
            {
                return Err("OBS executable has no product version".into());
            }
            let info = &*(info as *const VS_FIXEDFILEINFO);
            return Ok(Some(format!(
                "{}.{}.{}",
                info.dwProductVersionMS >> 16,
                info.dwProductVersionMS & 65535,
                info.dwProductVersionLS >> 16
            )));
        }
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}
fn pinned(paths: &config::Paths) -> Result<Option<String>, String> {
    let policy = config::read_json(&paths.policy)?;
    if policy.get("version").is_none() {
        return Err("OBS release policy is missing".into());
    }
    if policy["version"].is_null() {
        return Ok(None);
    }
    let raw = policy["version"]
        .as_str()
        .ok_or("Invalid OBS release policy")?;
    version(raw).ok_or("Invalid OBS release policy")?;
    Ok(Some(raw.into()))
}
fn previous(paths: &config::Paths) -> PathBuf {
    paths.base.join("obs-studio.previous")
}
fn swap(paths: &config::Paths) -> PathBuf {
    paths.base.join(".obs-runtime-swap")
}
fn rename(from: &Path, to: &Path) -> Result<(), String> {
    for attempt in 0..=20 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if attempt == 20 {
                    return Err(err(error));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
    unreachable!()
}
fn remove_temporary(paths: &config::Paths, target: &Path) -> Result<(), String> {
    if target.parent() != Some(paths.base.as_path()) || target == paths.root() {
        return Err("Invalid OBS temporary path".into());
    }
    if !target.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(target).map_err(err)?;
    if meta.file_type().is_symlink() {
        return Err("Refusing OBS cleanup through a symbolic link".into());
    }
    if meta.is_dir() {
        fs::remove_dir_all(target).map_err(err)
    } else {
        fs::remove_file(target).map_err(err)
    }
}
fn recover(paths: &config::Paths) -> Result<(), String> {
    if !paths.root().exists() && previous(paths).exists() {
        rename(&previous(paths), &paths.root())?;
    }
    if swap(paths).exists() && paths.root().exists() && !previous(paths).exists() {
        rename(&swap(paths), &previous(paths))?;
    }
    Ok(())
}
const CEF: &[&str] = &[
    "obs-browser.dll",
    "obs-browser-page.exe",
    "libcef.dll",
    "chrome_elf.dll",
    "libegl.dll",
    "libglesv2.dll",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "v8_context_snapshot.bin",
    "snapshot_blob.bin",
];
const CORE: &[&str] = &[
    "aja",
    "aja-output-ui",
    "coreaudio-encoder",
    "decklink",
    "decklink-captions",
    "decklink-output-ui",
    "frontend-tools",
    "image-source",
    "obs-browser",
    "obs-ffmpeg",
    "obs-filters",
    "obs-nvenc",
    "obs-outputs",
    "obs-qsv11",
    "obs-text",
    "obs-transitions",
    "obs-vst",
    "obs-websocket",
    "obs-x264",
    "obs-webrtc",
    "nv-filters",
    "rtmp-services",
    "text-freetype2",
    "vlc-video",
    "win-capture",
    "win-dshow",
    "win-wasapi",
];
fn prune(root: &Path) -> Result<(), String> {
    fn visit(dir: &Path) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(err)? {
            let e = entry.map_err(err)?;
            let kind = e.file_type().map_err(err)?;
            if kind.is_dir() {
                visit(&e.path())?;
            } else if kind.is_file()
                && e.path()
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("pdb"))
            {
                fs::remove_file(e.path()).map_err(err)?;
            }
        }
        Ok(())
    }
    visit(root)?;
    for name in CEF {
        let file = root.join("obs-plugins/64bit").join(name);
        if file.is_file() {
            fs::remove_file(file).map_err(err)?;
        }
    }
    for relative in ["obs-plugins/64bit/locales", "data/obs-plugins/obs-browser"] {
        let target = root.join(relative);
        if target.exists() {
            fs::remove_dir_all(target).map_err(err)?;
        }
    }
    Ok(())
}
fn preserve(source: &Path, target: &Path) -> Result<(), String> {
    for name in ["config", "plugins"] {
        config::copy_tree(&source.join(name), &target.join(name), &|_| true)?;
    }
    for name in ["obs-plugins", "data/obs-plugins"] {
        let from = source.join(name);
        config::copy_tree(&from, &target.join(name), &|file| {
            let lower = file
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if lower.ends_with(".pdb") {
                return false;
            }
            let relative = file.strip_prefix(&from).unwrap_or(file);
            let depth = relative.components().count();
            if (name == "obs-plugins" && depth == 2) || (name == "data/obs-plugins" && depth == 1) {
                return !CORE.contains(&lower.trim_end_matches(".dll"))
                    && !CEF.contains(&lower.as_str())
                    && lower != "locales";
            }
            true
        })?;
    }
    config::atomic_write(&target.join("portable_mode"), b"")
}
fn extract(archive: &Path, target: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(err)?;
    fs::create_dir(target).map_err(err)?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(err)?;
        let relative = file
            .enclosed_name()
            .ok_or("OBS archive contains an unsafe path")?
            .to_path_buf();
        // Reject Unix links and Windows path syntax even when extracting on another OS.
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || relative.to_string_lossy().contains(':')
            || file.name().contains('\\')
        {
            return Err("OBS archive contains an unsafe entry".into());
        }
        let destination = target.join(relative);
        if file.is_dir() {
            fs::create_dir_all(destination).map_err(err)?;
        } else {
            fs::create_dir_all(destination.parent().unwrap()).map_err(err)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(err)?;
            std::io::copy(&mut file, &mut output).map_err(err)?;
        }
    }
    Ok(())
}
fn validate_release(release: &Value, pin: Option<&str>) -> Result<(), String> {
    let tag = text(release, "tag_name");
    if version(tag).is_none() || release["prerelease"] == true || pin.is_some_and(|p| p != tag) {
        return Err("OBS returned an unexpected stable release".into());
    }
    Ok(())
}
fn download_asset(release: &Value) -> Result<(String, String), String> {
    let suffix = if cfg!(target_arch = "aarch64") {
        "Windows-arm64.zip"
    } else {
        "Windows-x64.zip"
    };
    let asset = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| text(a, "name").ends_with(suffix))
        .ok_or("OBS Windows download is missing")?;
    let name = text(asset, "name");
    let tag = text(release, "tag_name");
    let expected =
        format!("https://github.com/obsproject/obs-studio/releases/download/{tag}/{name}");
    let digest = text(asset, "digest").to_ascii_lowercase();
    if text(asset, "browser_download_url") != expected
        || !digest.starts_with("sha256:")
        || digest.len() != 71
        || !digest[7..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("OBS release is missing an official download or SHA-256 checksum".into());
    }
    Ok((expected, digest[7..].to_owned()))
}
impl Obs {
    pub(super) fn runtime_status(&self) -> Result<Value, String> {
        let paths = self.paths()?;
        let installed = read_version(&paths.executable())?;
        let rollback = read_version(&previous(&paths).join("bin/64bit/obs64.exe"))?;
        let pin = pinned(&paths)?;
        let state = self.0.state.lock().unwrap();
        let runtime = &state.runtime;
        let target = runtime
            .release
            .as_ref()
            .and_then(|r| r["tag_name"].as_str())
            .map(str::to_owned)
            .or(pin.clone());
        let available = target.as_deref().and_then(version).is_some_and(|v| {
            installed
                .as_deref()
                .and_then(version)
                .is_none_or(|old| v > old)
        });
        Ok(
            json!({"supported":cfg!(windows),"managed":paths.managed()?,"automatic":config::read_json(&paths.desktop())?["autoUpdateOBS"]==true,"pinnedVersion":pin,"installedVersion":installed,"rollbackVersion":rollback,"targetVersion":target,"updateAvailable":available,"phase":if runtime.phase.is_empty(){"idle"}else{&runtime.phase},"progress":runtime.progress,"checkedAt":runtime.checked_at,"error":runtime.error}),
        )
    }
    fn phase(&self, app: &tauri::AppHandle, phase: &str, progress: Option<f64>) {
        {
            let mut s = self.0.state.lock().unwrap();
            s.runtime.phase = phase.into();
            s.runtime.progress = progress;
        }
        if let Ok(status) = self.runtime_status() {
            self.emit(app, "obs.runtime.progress", status);
        }
    }
    pub(super) async fn check_release(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let result = self.check_release_inner(app).await;
        if let Err(error) = &result {
            self.0.state.lock().unwrap().runtime.error = Some(error.clone());
            self.phase(app, "error", None);
        }
        result
    }
    async fn check_release_inner(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let paths = self.paths()?;
        if !paths.managed()? {
            return Ok(());
        }
        let pin = pinned(&paths)?;
        self.phase(app, "checking", None);
        let endpoint = pin
            .as_ref()
            .map(|v| format!("tags/{v}"))
            .unwrap_or("latest".into());
        let response: Value = reqwest::Client::new()
            .get(format!(
                "https://api.github.com/repos/obsproject/obs-studio/releases/{endpoint}"
            ))
            .header("User-Agent", "GameSentenceMiner")
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        validate_release(&response, pin.as_deref())?;
        {
            let mut s = self.0.state.lock().unwrap();
            s.runtime.release = Some(response);
            s.runtime.checked_at = Some(chrono::Utc::now().to_rfc3339());
            s.runtime.error = None;
        }
        self.phase(app, "idle", None);
        Ok(())
    }
    pub(super) async fn ensure_installed(&self, app: &tauri::AppHandle) -> Result<Value, String> {
        let paths = self.paths()?;
        if !paths.managed()? {
            return Ok(json!("unsupported"));
        }
        {
            let _lock = self.0.lifecycle.lock().await;
            recover(&paths)?;
        }
        let installed = paths.executable().is_file();
        let automatic = config::read_json(&paths.desktop())?["autoUpdateOBS"] == true;
        let already_checked = {
            let mut s = self.0.state.lock().unwrap();
            let old = s.runtime.automatic_checked;
            s.runtime.automatic_checked = true;
            old
        };
        if !installed || (automatic && !already_checked) {
            let result = self.update_runtime(app, false).await;
            if let Err(error) = result {
                if !installed {
                    return Err(error);
                }
                eprintln!("[OBS] Automatic update failed: {error}");
            }
        }
        paths.seed()?;
        self.emit(app,"obs.install.progress",json!({"stageId":"obs","status":"completed","progressKind":"exact","progress":1,"message":"OBS Studio is ready"}));
        Ok(json!(if installed {
            "already-installed"
        } else {
            "installed"
        }))
    }
    async fn coordinate_clients(&self, app: &tauri::AppHandle, action: &str) -> Result<(), String> {
        if !self.0.state.lock().unwrap().coordinate_clients {
            return Ok(());
        }
        match action {
            "suspend" => {
                let ocr_running = app
                    .try_state::<crate::ocr_coordinator::OcrCoordinator>()
                    .is_some_and(|ocr| ocr.is_running());
                let backend_running = crate::backend::snapshot(app)["pid"].is_u64();
                *self.0.suspended_clients.lock().unwrap() = (backend_running, ocr_running);
                if ocr_running {
                    let _ = crate::ocr_coordinator::stop_ocr_sync(app, "managed-obs-update", None);
                }
                if backend_running {
                    let _ = crate::backend::dispatch(app, json!({"action": "stop", "params": {}}))
                        .await;
                }
            }
            "resume" => {
                let (backend_running, ocr_running) = {
                    let mut guard = self.0.suspended_clients.lock().unwrap();
                    let prev = *guard;
                    *guard = (false, false);
                    prev
                };
                if backend_running {
                    crate::python_ops::ensure_and_run_gsm(
                        app,
                        None,
                        None,
                        "obs-update-resume",
                        false,
                        false,
                        false,
                    )
                    .await?;
                }
                if ocr_running {
                    let _ = crate::ocr_coordinator::start_ocr(
                        app,
                        crate::ocr_coordinator::OcrStartSource::Auto,
                        crate::ocr_coordinator::OcrRunMode::Auto,
                    )
                    .await;
                }
            }
            _ => {}
        }
        Ok(())
    }
    async fn validate_installation(
        &self,
        app: &tauri::AppHandle,
        expected: &str,
        restart: bool,
        replay: bool,
    ) -> Result<(), String> {
        self.paths()?.seed()?;
        if !restart {
            return Ok(());
        }
        self.0.suspended.store(false, Ordering::SeqCst);
        let result = self
            .launch_inner(app, json!({"ignoreOpenConfig":true}))
            .await?;
        if result["status"] != "launched" && result["status"] != "already-running" {
            return Err(format!("Updated OBS failed to launch: {result}"));
        }
        self.ready(app).await?;
        if self.call(app, "GetVersion", json!({})).await?["obsVersion"] != expected {
            return Err("Updated OBS reported an unexpected version".into());
        }
        if replay {
            if self.call(app, "GetReplayBufferStatus", json!({})).await?["outputActive"] != true {
                self.call(app, "StartReplayBuffer", json!({})).await?;
            }
            let until = Instant::now() + Duration::from_secs(10);
            loop {
                if self.call(app, "GetReplayBufferStatus", json!({})).await?["outputActive"] == true
                {
                    break;
                }
                if Instant::now() >= until {
                    return Err("Updated OBS could not resume the replay buffer".into());
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        Ok(())
    }
    pub(super) async fn update_runtime(
        &self,
        app: &tauri::AppHandle,
        rollback: bool,
    ) -> Result<Value, String> {
        let guard = self.0.lifecycle.lock().await;
        self.0.updating.store(true, Ordering::SeqCst);
        let mut coordinated = false;
        let result = self.replace_runtime(app, rollback, &mut coordinated).await;
        self.0.suspended.store(false, Ordering::SeqCst);
        self.0.updating.store(false, Ordering::SeqCst);
        drop(guard);
        let resumed = if coordinated {
            self.coordinate_clients(app, "resume").await
        } else {
            Ok(())
        };
        let result = result.and(resumed);
        if let Err(error) = result {
            self.0.state.lock().unwrap().runtime.error = Some(error.clone());
            self.phase(app, "error", None);
            return Err(error);
        }
        self.0.state.lock().unwrap().runtime.error = None;
        self.phase(app, "idle", None);
        self.runtime_status()
    }
    async fn replace_runtime(
        &self,
        app: &tauri::AppHandle,
        rollback: bool,
        coordinated: &mut bool,
    ) -> Result<(), String> {
        let paths = self.paths()?;
        recover(&paths)?;
        if !paths.managed()? {
            return Err("Updates are available only for GSM's portable OBS on Windows".into());
        }
        let staging = paths
            .base
            .join(format!(".obs-update-{}", uuid::Uuid::new_v4()));
        let archive = staging.with_extension("zip");
        let original = read_version(&paths.executable())?;
        let mut restart = false;
        let mut stopped = false;
        let mut swapped = false;
        let mut replay = false;
        let result: Result<(), String> = async {
            let target = if rollback {
                read_version(&previous(&paths).join("bin/64bit/obs64.exe"))?
                    .ok_or("No previous portable OBS is available")?
            } else {
                self.check_release(app).await?;
                if self.runtime_status()?["updateAvailable"] != true {
                    return Ok(());
                }
                let release = self
                    .0
                    .state
                    .lock()
                    .unwrap()
                    .runtime
                    .release
                    .clone()
                    .ok_or("OBS release missing")?;
                if self.running_pid(&paths)?.is_some() {
                    self.assert_idle(app).await?;
                }
                let (url, expected) = download_asset(&release)?;
                self.phase(app, "downloading", Some(0.0));
                let mut response = reqwest::Client::new()
                    .get(url)
                    .timeout(Duration::from_secs(600))
                    .send()
                    .await
                    .map_err(err)?
                    .error_for_status()
                    .map_err(err)?;
                let total = response.content_length();
                let mut received = 0u64;
                let mut hash = Sha256::new();
                let mut report = Instant::now();
                fs::create_dir_all(&paths.base).map_err(err)?;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&archive)
                    .map_err(err)?;
                while let Some(chunk) = response.chunk().await.map_err(err)? {
                    file.write_all(&chunk).map_err(err)?;
                    hash.update(&chunk);
                    received += chunk.len() as u64;
                    if report.elapsed() > Duration::from_millis(250) {
                        self.phase(
                            app,
                            "downloading",
                            total
                                .filter(|t| *t > 0)
                                .map(|t| (received as f64 / t as f64).min(1.0)),
                        );
                        report = Instant::now();
                    }
                }
                file.sync_all().map_err(err)?;
                drop(file);
                if format!("{:x}", hash.finalize()) != expected {
                    return Err("OBS archive checksum did not match".into());
                }
                self.phase(app, "extracting", None);
                let archive_copy = archive.clone();
                let stage_copy = staging.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    extract(&archive_copy, &stage_copy)?;
                    prune(&stage_copy)
                })
                .await
                .map_err(err)??;
                let tag = text(&release, "tag_name").to_owned();
                if read_version(&staging.join("bin/64bit/obs64.exe"))?.as_deref() != Some(&tag) {
                    return Err("Downloaded OBS has an unexpected version".into());
                }
                if version(&tag).unwrap()[0] >= 33 {
                    for module in ["obs-browser", "obs-websocket"] {
                        if !staging
                            .join(format!("core/{module}/{module}.dll"))
                            .is_file()
                        {
                            return Err(format!("OBS is missing required core module {module}"));
                        }
                    }
                }
                tag
            };
            restart = self.running_pid(&paths)?.is_some();
            if restart {
                self.assert_idle(app).await?;
                replay = match self.call(app, "GetReplayBufferStatus", json!({})).await {
                    Ok(v) => v["outputActive"] == true,
                    Err(e) if e.ends_with("(604)") => false,
                    Err(e) => return Err(e),
                };
            }
            self.phase(app, "stopping", None);
            self.coordinate_clients(app, "suspend").await?;
            *coordinated = true;
            if restart {
                self.assert_idle(app).await?;
                self.close_inner(app, json!({"ignoreCloseConfig":true}))
                    .await?;
            }
            stopped = true;
            self.0.suspended.store(true, Ordering::SeqCst);
            let _ = self.0.client.disconnect_primary().await;
            paths.snapshot(if rollback {
                "before OBS rollback"
            } else {
                "before OBS update"
            })?;
            self.phase(app, "installing", None);
            if rollback {
                preserve(&paths.root(), &previous(&paths))?;
                swap_installations(&paths)?;
                swapped = true;
                {
                    let _settings_lock = config::SETTINGS_LOCK.lock().unwrap();
                    let mut settings = config::read_json(&paths.desktop())?;
                    settings["autoUpdateOBS"] = json!(false);
                    config::write_json(&paths.desktop(), &settings)?;
                }
            } else {
                preserve(&paths.root(), &staging)?;
                remove_temporary(&paths, &previous(&paths))?;
                if paths.root().exists() {
                    rename(&paths.root(), &previous(&paths))?;
                }
                if let Err(error) = rename(&staging, &paths.root()) {
                    if previous(&paths).exists() {
                        rename(&previous(&paths), &paths.root())?;
                    }
                    return Err(error);
                }
                swapped = true;
            }
            self.phase(app, "validating", None);
            self.validate_installation(app, &target, restart, replay)
                .await
        }
        .await;
        let mut recovery_ok = true;
        let result = match result {
            Ok(()) => Ok(()),
            Err(error) => {
                let recovery: Result<(), String> = async {
                    if swapped && previous(&paths).exists() {
                        if self.running_pid(&paths)?.is_some() {
                            self.0.suspended.store(false, Ordering::SeqCst);
                            self.close_inner(app, json!({"ignoreCloseConfig":true}))
                                .await?;
                        }
                        if rollback {
                            swap_installations(&paths)?;
                        } else {
                            rename(&paths.root(), &staging)?;
                            rename(&previous(&paths), &paths.root())?;
                        }
                    }
                    if stopped {
                        if let Some(old) = &original {
                            self.validate_installation(app, old, restart, replay)
                                .await?;
                        }
                    }
                    Ok(())
                }
                .await;
                match recovery {
                    Ok(()) => Err(error),
                    Err(recovery) => {
                        recovery_ok = false;
                        Err(format!("{error}. Recovery failed: {recovery}. Installation copies have been retained in {}",paths.base.display()))
                    }
                }
            }
        };
        let _ = remove_temporary(&paths, &archive);
        if recovery_ok {
            let _ = remove_temporary(&paths, &staging);
        }
        result
    }
}
fn swap_installations(paths: &config::Paths) -> Result<(), String> {
    if swap(paths).exists() {
        return Err("An unfinished OBS installation swap needs recovery".into());
    }
    rename(&paths.root(), &swap(paths))?;
    if let Err(error) = rename(&previous(paths), &paths.root()) {
        rename(&swap(paths), &paths.root())?;
        return Err(error);
    }
    if let Err(error) = rename(&swap(paths), &previous(paths)) {
        // Undo the first two renames; never leave the installed directory missing.
        rename(&paths.root(), &previous(paths))?;
        rename(&swap(paths), &paths.root())?;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::config::tests::Fixture;
    use super::*;
    #[test]
    fn stable_release_and_numeric_version_policy() {
        assert!(version("33.0.10").unwrap() > version("33.0.2").unwrap());
        assert!(version("33.0.2-beta1").is_none());
        assert!(validate_release(
            &json!({"tag_name":"33.0.2","prerelease":false}),
            Some("33.0.2")
        )
        .is_ok());
        assert!(validate_release(&json!({"tag_name":"34.0.0"}), Some("33.0.2")).is_err());
        assert!(validate_release(&json!({"tag_name":"33.0.2","prerelease":true}), None).is_err());
    }
    #[test]
    fn archive_requires_official_url_and_sha256() {
        let suffix = if cfg!(target_arch = "aarch64") {
            "Windows-arm64.zip"
        } else {
            "Windows-x64.zip"
        };
        let name = format!("OBS-Studio-33.0.2-{suffix}");
        let mut release = json!({"tag_name":"33.0.2","assets":[{"name":name,"browser_download_url":format!("https://github.com/obsproject/obs-studio/releases/download/33.0.2/{name}"),"digest":format!("sha256:{}","a".repeat(64))}]});
        assert!(download_asset(&release).is_ok());
        release["assets"][0]["browser_download_url"] = json!("https://elsewhere.invalid/OBS.zip");
        assert!(download_asset(&release).is_err());
    }
    #[test]
    fn crash_recovery_keeps_last_known_installation() {
        let f = Fixture::new();
        fs::create_dir(previous(&f.0)).unwrap();
        config::atomic_write(&previous(&f.0).join("old"), b"good").unwrap();
        recover(&f.0).unwrap();
        assert!(f.0.root().join("old").is_file());
        fs::create_dir(swap(&f.0)).unwrap();
        recover(&f.0).unwrap();
        assert!(previous(&f.0).is_dir());
        assert!(!swap(&f.0).exists());
    }
    #[test]
    fn rollback_swap_can_be_reversed_without_losing_either_version() {
        let f = Fixture::new();
        fs::create_dir(f.0.root()).unwrap();
        fs::create_dir(previous(&f.0)).unwrap();
        config::atomic_write(&f.0.root().join("version"), b"new").unwrap();
        config::atomic_write(&previous(&f.0).join("version"), b"old").unwrap();
        swap_installations(&f.0).unwrap();
        assert_eq!(fs::read(f.0.root().join("version")).unwrap(), b"old");
        swap_installations(&f.0).unwrap();
        assert_eq!(fs::read(f.0.root().join("version")).unwrap(), b"new");
    }
    #[test]
    fn missing_rollback_restores_current_directory() {
        let f = Fixture::new();
        fs::create_dir(f.0.root()).unwrap();
        assert!(swap_installations(&f.0).is_err());
        assert!(f.0.root().is_dir());
        assert!(!swap(&f.0).exists());
    }
    #[test]
    fn cleanup_cannot_delete_installation_or_outside_directory() {
        let f = Fixture::new();
        assert!(remove_temporary(&f.0, &f.0.root()).is_err());
        assert!(remove_temporary(&f.0, &std::env::temp_dir()).is_err());
    }
    #[test]
    fn prune_retains_obs33_core_and_preserves_third_party_plugins() {
        let f = Fixture::new();
        let stage = f.0.base.join("stage");
        for name in [
            "core/obs-browser/obs-browser.dll",
            "core/obs-websocket/obs-websocket.dll",
            "core/obs-browser/libcef.dll",
            "obs-plugins/64bit/obs-browser.dll",
            "core/a.pdb",
        ] {
            config::atomic_write(&stage.join(name), b"file").unwrap();
        }
        prune(&stage).unwrap();
        assert!(stage.join("core/obs-browser/libcef.dll").is_file());
        assert!(!stage.join("obs-plugins/64bit/obs-browser.dll").exists());
        assert!(!stage.join("core/a.pdb").exists());
        for name in [
            "config/obs-studio/scenes.json",
            "plugins/custom/data.json",
            "obs-plugins/64bit/custom.dll",
            "obs-plugins/64bit/obs-websocket.dll",
            "data/obs-plugins/obs-browser/obsolete",
        ] {
            config::atomic_write(&f.0.root().join(name), b"user").unwrap();
        }
        preserve(&f.0.root(), &stage).unwrap();
        assert!(stage.join("obs-plugins/64bit/custom.dll").is_file());
        assert!(stage.join("config/obs-studio/scenes.json").is_file());
        assert!(!stage.join("obs-plugins/64bit/obs-websocket.dll").exists());
        assert!(!stage.join("data/obs-plugins/obs-browser/obsolete").exists());
    }
    #[test]
    fn extraction_rejects_traversal_and_never_writes_outside_staging() {
        let f = Fixture::new();
        let archive = f.0.base.join("bad.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        zip.start_file("../escape", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"no").unwrap();
        zip.finish().unwrap();
        assert!(extract(&archive, &f.0.base.join("stage")).is_err());
        assert!(!f.0.base.join("escape").exists());
    }
}
