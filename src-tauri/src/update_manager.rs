//! Signed desktop updates and release channel selection.

use gsm_packages::changelog::{ChangelogSnapshot, PendingChangelogRecord};
use gsm_settings::preferences::Preferences;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

pub const APP_UPDATE_STATUS_CHANNEL: &str = "settings-app-update-status";
const GITHUB_OWNER: &str = "bpwhelan";
const GITHUB_REPO: &str = "GameSentenceMiner";
const STABLE_MANIFEST_URL: &str =
    "https://github.com/bpwhelan/GameSentenceMiner/releases/latest/download/tauri-latest.json";
const ALLOWED_RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/bpwhelan/GameSentenceMiner/releases/download/";

static CACHED_PRERELEASE_BRANCH: OnceLock<Option<String>> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub checked_at: Option<String>,
    pub error: Option<String>,
    pub checking: bool,
    pub downloading: bool,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackendUpdateStatus {
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub checked_at: Option<String>,
    pub error: Option<String>,
    pub checking: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusSnapshot {
    pub backend: BackendUpdateStatus,
    pub app: AppUpdateStatus,
    pub any_update_in_progress: bool,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: Option<String>,
    draft: Option<bool>,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Deserialize)]
struct GitHubReleaseAsset {
    name: Option<String>,
    browser_download_url: Option<String>,
}

struct UpdateManagerState {
    app_status: AppUpdateStatus,
    pending_update: Option<Update>,
    dev_preview_changelog: Option<ChangelogSnapshot>,
    dev_preview_request_id: u64,
}

struct UpdateManagerInner {
    app_version: String,
    is_checking_app: AtomicBool,
    is_downloading_app: AtomicBool,
    app_check_lock: tokio::sync::Mutex<()>,
    state: Mutex<UpdateManagerState>,
}

/// Thread-safe, zero-polling coordinator for Tauri app updates.
#[derive(Clone)]
pub struct UpdateManager(Arc<UpdateManagerInner>);

impl UpdateManager {
    pub fn new(current_version: impl Into<String>, pull_prereleases: bool) -> Self {
        let current = current_version.into();
        let channel = channel_name(pull_prereleases).to_owned();
        Self(Arc::new(UpdateManagerInner {
            app_version: current.clone(),
            is_checking_app: AtomicBool::new(false),
            is_downloading_app: AtomicBool::new(false),
            app_check_lock: tokio::sync::Mutex::new(()),
            state: Mutex::new(UpdateManagerState {
                app_status: AppUpdateStatus {
                    current_version: current,
                    latest_version: None,
                    update_available: false,
                    checked_at: None,
                    error: None,
                    checking: false,
                    downloading: false,
                    channel,
                    preview: None,
                },
                pending_update: None,
                dev_preview_changelog: None,
                dev_preview_request_id: 0,
            }),
        }))
    }

    pub fn any_update_in_progress(&self) -> bool {
        self.0.is_checking_app.load(Ordering::Acquire)
            || self.0.is_downloading_app.load(Ordering::Acquire)
    }

    /// Return current app update status with channel drift and dev preview applied.
    pub fn get_app_update_status(&self, app: &tauri::AppHandle) -> AppUpdateStatus {
        let checking = self.0.is_checking_app.load(Ordering::Acquire);
        let downloading = self.0.is_downloading_app.load(Ordering::Acquire);
        let configured_channel = channel_name(read_pull_prereleases(app)).to_owned();

        let guard = self.0.state.lock().unwrap();
        let mut status = guard.app_status.clone();
        let channel_changed = status.channel != configured_channel && !downloading;
        if channel_changed {
            status.latest_version = None;
            status.update_available = false;
            status.checked_at = None;
            status.error = None;
        }
        status.current_version = self.0.app_version.clone();
        status.checking = checking;
        status.downloading = downloading;
        if !downloading {
            status.channel = configured_channel;
        }
        apply_dev_preview(&status, guard.dev_preview_changelog.as_ref())
    }

    fn raw_app_update_status(&self, app: &tauri::AppHandle) -> AppUpdateStatus {
        let checking = self.0.is_checking_app.load(Ordering::Acquire);
        let downloading = self.0.is_downloading_app.load(Ordering::Acquire);
        let configured_channel = channel_name(read_pull_prereleases(app)).to_owned();

        let guard = self.0.state.lock().unwrap();
        let mut status = guard.app_status.clone();
        if status.channel != configured_channel && !downloading {
            status.latest_version = None;
            status.update_available = false;
            status.checked_at = None;
            status.error = None;
            status.channel = configured_channel;
        }
        status.current_version = self.0.app_version.clone();
        status.checking = checking;
        status.downloading = downloading;
        status.preview = None;
        status
    }

    fn emit_app_status(&self, app: &tauri::AppHandle) {
        let payload = serde_json::to_value(self.get_app_update_status(app)).unwrap_or(Value::Null);
        crate::desktop_state::emit_to_desktop_windows(app, APP_UPDATE_STATUS_CHANNEL, &[payload]);
    }

    /// Check GitHub / Tauri signed release manifest for an app update.
    pub async fn check_app_update_status(
        &self,
        app: &tauri::AppHandle,
        force: bool,
    ) -> AppUpdateStatus {
        if crate::PORTABLE_PREVIEW || self.0.is_downloading_app.load(Ordering::Acquire) {
            return self.get_app_update_status(app);
        }

        let _check_guard = self.0.app_check_lock.lock().await;
        if self.0.is_downloading_app.load(Ordering::Acquire) {
            return self.get_app_update_status(app);
        }

        let prerelease_enabled = read_pull_prereleases(app);
        let checked_channel = channel_name(prerelease_enabled).to_owned();
        self.0.is_checking_app.store(true, Ordering::Release);
        {
            let mut guard = self.0.state.lock().unwrap();
            guard.app_status.current_version = self.0.app_version.clone();
            guard.app_status.checking = true;
            guard.app_status.error = None;
            guard.app_status.channel = checked_channel.clone();
        }
        self.emit_app_status(app);

        let result: Result<(String, bool, Option<Update>), String> = async {
            let endpoint = if prerelease_enabled {
                resolve_beta_manifest_url(
                    &app.state::<crate::desktop_state::DesktopState>().http,
                    &format!("{GITHUB_OWNER}/{GITHUB_REPO}"),
                )
                .await?
            } else {
                STABLE_MANIFEST_URL.to_owned()
            };

            let url = tauri::Url::parse(&endpoint).map_err(|e| e.to_string())?;
            let updater = app
                .updater_builder()
                .endpoints(vec![url])
                .map_err(|e| e.to_string())?
                // Always inspect the signed remote version ourselves so we can apply
                // stable/beta downgrade policy cleanly in `evaluate_app_update_offer`.
                .version_comparator(|_, _| true)
                .build()
                .map_err(|e| e.to_string())?;

            let remote = updater
                .check()
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Update check returned no result.".to_string())?;

            let latest_version = normalize_version_str(&remote.version);
            let offer = evaluate_app_update_offer(
                &self.0.app_version,
                &latest_version,
                prerelease_enabled,
                force,
            );
            Ok((latest_version, offer, offer.then_some(remote)))
        }
        .await;

        self.0.is_checking_app.store(false, Ordering::Release);
        {
            let current_channel = channel_name(read_pull_prereleases(app)).to_owned();
            let mut guard = self.0.state.lock().unwrap();
            guard.app_status.checking = false;
            guard.app_status.current_version = self.0.app_version.clone();
            guard.app_status.channel = current_channel.clone();

            match result {
                Ok((latest_version, offer, pending_update)) => {
                    if checked_channel != current_channel {
                        guard.app_status.latest_version = None;
                        guard.app_status.update_available = false;
                        guard.app_status.checked_at = Some(iso_now_utc());
                        guard.app_status.error = None;
                        guard.pending_update = None;
                    } else {
                        guard.app_status.latest_version = Some(latest_version);
                        guard.app_status.update_available = offer;
                        guard.app_status.checked_at = Some(iso_now_utc());
                        guard.app_status.error = None;
                        guard.pending_update = pending_update;
                    }
                }
                Err(error) => {
                    crate::desktop_log::warn(
                        app,
                        "updater",
                        format!("Failed to check for application updates: {error}"),
                    );
                    guard.app_status.checked_at = Some(iso_now_utc());
                    guard.app_status.latest_version = None;
                    guard.app_status.update_available = false;
                    guard.pending_update = None;
                    guard.app_status.error = Some(error);
                }
            }
        }
        self.emit_app_status(app);
        self.get_app_update_status(app)
    }

    /// Return changelog release notes for the pending app update or active dev preview.
    pub async fn get_app_update_changelog(
        &self,
        app: &tauri::AppHandle,
    ) -> Option<ChangelogSnapshot> {
        if let Some(preview) = self.0.state.lock().unwrap().dev_preview_changelog.clone() {
            return Some(preview);
        }
        let status = self.raw_app_update_status(app);
        let latest = status.latest_version.filter(|_| status.update_available)?;
        let include_pre = status.channel == "beta";
        let changelog = app.state::<crate::desktop_changelog::DesktopChangelog>();
        Some(
            changelog
                .get_update_preview(
                    app,
                    PendingChangelogRecord {
                        from_version: status.current_version,
                        to_version: latest,
                    },
                    include_pre,
                )
                .await,
        )
    }

    /// Download, verify signature, stop backend/OBS cleanly, mark backend update flag, and install.
    pub async fn install_app_update(
        &self,
        app: &tauri::AppHandle,
        expected_version: &str,
    ) -> Result<AppUpdateStatus, String> {
        if self.0.state.lock().unwrap().dev_preview_changelog.is_some() {
            return Err("Installation is disabled for the development update preview.".into());
        }
        if self.0.is_downloading_app.load(Ordering::Acquire) {
            return Ok(self.get_app_update_status(app));
        }

        let status = self.check_app_update_status(app, false).await;
        if let Some(err) = status.error.filter(|_| status.latest_version.is_none()) {
            return Err(err);
        }
        if !status.update_available || status.latest_version.as_deref() != Some(expected_version) {
            return Err(
                "The available update has changed. Reopen the release notes and try again.".into(),
            );
        }

        self.download_and_install_update(app).await?;
        Ok(self.get_app_update_status(app))
    }

    async fn download_and_install_update(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if crate::PORTABLE_PREVIEW {
            return Err("Desktop updates are disabled in GSM Preview.".into());
        }
        let mut update = self
            .0
            .state
            .lock()
            .unwrap()
            .pending_update
            .take()
            .ok_or_else(|| "No verified update package is pending installation.".to_string())?;

        if self
            .0
            .is_downloading_app
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        {
            let mut guard = self.0.state.lock().unwrap();
            guard.app_status.downloading = true;
            guard.app_status.error = None;
        }
        self.emit_app_status(app);

        let install_res: Result<(), String> = async {
            let origin = update.download_url.clone();
            let mut result = None;
            let mirror_revision = gsm_packages::downloads::revision(&update.signature);
            for source in gsm_packages::downloads::sources(origin.as_str(), Some(&mirror_revision)) {
                update.download_url = source.parse::<url::Url>().map_err(|err| err.to_string())?;
                let mut downloaded: u64 = 0;
                let mut last_bucket = -1;
                // The plugin verifies the original update signature for every mirror.
                let attempt = update
                .download(
                    |chunk_len, content_len| {
                        downloaded = downloaded.saturating_add(chunk_len as u64);
                        if let Some(total) = content_len.filter(|&t| t > 0) {
                            let pct = ((downloaded as f64 / total as f64) * 100.0) as i32;
                            let bucket = pct / 10;
                            if bucket > last_bucket {
                                last_bucket = bucket;
                                println!(
                                    "[Updater] Download {}%: {}/{} bytes",
                                    pct.min(100),
                                    downloaded,
                                    total
                                );
                            }
                        }
                    },
                    || {},
                )
                .await;
                let done = attempt.is_ok();
                result = Some(attempt);
                if done {
                    break;
                }
            }
            let bytes = result
                .ok_or("No download source for the signed update")?
                .map_err(|e| e.to_string())?;

            crate::service_maintenance::close_all_for_app_update(app).await?;

            update.install(bytes).map_err(|e| e.to_string())?;
            // NSIS relaunches GSM itself. Unix installers replace the app on disk.
            #[cfg(not(windows))]
            app.request_restart();
            Ok(())
        }
        .await;

        if let Err(err) = install_res {
            self.0.is_downloading_app.store(false, Ordering::Release);
            {
                let mut guard = self.0.state.lock().unwrap();
                guard.app_status.downloading = false;
                guard.app_status.error = Some(err.clone());
            }
            self.emit_app_status(app);
            return Err(err);
        }

        Ok(())
    }

    /// Keep the backend version field in sync with the desktop for older renderers.
    pub async fn get_update_status(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<UpdateStatusSnapshot, String> {
        let version = app.package_info().version.to_string();
        Ok(UpdateStatusSnapshot {
            backend: BackendUpdateStatus {
                current_version: Some(version.clone()),
                latest_version: Some(version),
                update_available: false, checked_at: None, error: None, checking: false,
            },
            app: self.get_app_update_status(app),
            any_update_in_progress: self.any_update_in_progress(),
        })
    }

    /// Check GitHub desktop releases.
    pub async fn check_for_available_updates(
        &self,
        app: &tauri::AppHandle,
        force_dev: bool,
    ) -> Result<UpdateStatusSnapshot, String> {
        let _ = self.check_app_update_status(app, force_dev).await;
        self.get_update_status(app).await
    }

    /// Check all targets and download/install any available desktop app update (`settings.updateNow`).
    pub async fn update_available_targets(
        &self,
        app: &tauri::AppHandle,
        force_dev: bool,
    ) -> Result<UpdateStatusSnapshot, String> {
        let status = self.check_for_available_updates(app, force_dev).await?;
        if status.app.update_available && status.app.preview != Some(true) {
            self.download_and_install_update(app).await?;
        }
        self.get_update_status(app).await
    }

    /// Trigger the interactive tray "Update GSM" prompt + background download/install.
    pub async fn run_interactive_update_check(&self, app: &tauri::AppHandle, force_update: bool) {
        let status = self.check_app_update_status(app, force_update).await;
        if status.error.is_some() || status.downloading || !status.update_available {
            return;
        }
        let Ok(0) = crate::native::dialog_message(&json!({
            "type": "question",
            "title": "Update Available",
            "message": "A new version of the GSM Application is available. Would you like to download and install it now?",
            "buttons": ["Yes", "No"],
        }))
        .await
        else {
            return;
        };

        if let Err(err) = self.download_and_install_update(app).await {
            let _ = crate::native::dialog_message(&json!({
                "type": "error",
                "title": "Update Error",
                "message": "Downloaded app update could not be finalized. Restart and try again.",
                "detail": err,
                "buttons": ["OK"],
            }))
            .await;
        }
    }

    /// Populate dev-only update preview banner without modifying real updater state.
    // Wired to native menu actions in Slice 6.
    #[allow(dead_code)]
    pub async fn show_dev_update_preview(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let req_id = {
            let mut guard = self.0.state.lock().unwrap();
            guard.dev_preview_request_id += 1;
            guard.dev_preview_request_id
        };
        let include_pre = read_pull_prereleases(app);
        let changelog = app.state::<crate::desktop_changelog::DesktopChangelog>();
        let snapshot = changelog
            .get_latest_online_preview(app, &self.0.app_version, include_pre)
            .await?;

        {
            let mut guard = self.0.state.lock().unwrap();
            if guard.dev_preview_request_id != req_id {
                return Ok(());
            }
            guard.dev_preview_changelog = Some(snapshot);
        }
        self.emit_app_status(app);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn clear_dev_update_preview(&self, app: &tauri::AppHandle) {
        {
            let mut guard = self.0.state.lock().unwrap();
            guard.dev_preview_request_id += 1;
            guard.dev_preview_changelog = None;
        }
        self.emit_app_status(app);
    }

    /// Startup hook: check post-update changelog + auto-enable beta flag if bundled prerelease.
    // Wired into native startup flow in Slice 6 alongside full Node host removal.
    #[allow(dead_code)]
    pub fn bootstrap_prerelease_settings_from_metadata(&self, app: &tauri::AppHandle) {
        let active = &app.state::<crate::settings::Settings>().paths.active;
        let prefs = Preferences::new(active);
        let all = prefs.snapshot().unwrap_or_else(|_| json!({}));
        if all["preReleaseMetadataAutoEnableApplied"].as_bool() == Some(true) {
            return;
        }
        if resolve_prerelease_branch(app).is_none() {
            return;
        }
        let mut patch = serde_json::Map::new();
        if all["pullPreReleases"].as_bool() != Some(true) {
            patch.insert("pullPreReleases".into(), json!(true));
        }
        patch.insert("preReleaseMetadataAutoEnableApplied".into(), json!(true));
        let _ = prefs.patch(&Value::Object(patch));
    }

    /// Check whether a desktop version upgrade requires showing post-update changelog notes.
    // Wired into native startup flow in Slice 6 alongside full Node host removal.
    #[allow(dead_code)]
    pub fn check_startup_changelog(&self, app: &tauri::AppHandle) -> bool {
        let active = &app.state::<crate::settings::Settings>().paths.active;
        let prefs = Preferences::new(active);
        let stored_version = prefs
            .get("electronAppVersion")
            .ok()
            .flatten()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        app.state::<crate::desktop_changelog::DesktopChangelog>()
            .check_startup_target(app, &stored_version, &self.0.app_version)
            .is_some()
    }
}

pub fn any_app_update_in_progress(app: &tauri::AppHandle) -> bool {
    app.try_state::<UpdateManager>()
        .is_some_and(|mgr| mgr.any_update_in_progress())
}

pub fn resolve_prerelease_branch(app: &tauri::AppHandle) -> Option<String> {
    CACHED_PRERELEASE_BRANCH
        .get_or_init(|| {
            let state = app.state::<crate::desktop_state::DesktopState>();
            let resources = app.path().resource_dir().ok();
            read_prerelease_branch_from_dirs(&state.app_root, &state.assets_dir(), resources.as_deref())
        })
        .clone()
}

pub fn read_prerelease_branch_from_dirs(
    app_root: &Path,
    assets_dir: &Path,
    resources_dir: Option<&Path>,
) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::with_capacity(4);
    if let Some(res) = resources_dir {
        candidates.push(res.join("prerelease.json"));
        candidates.push(res.join("assets").join("prerelease.json"));
    }
    candidates.push(assets_dir.join("prerelease.json"));
    candidates.push(app_root.join("electron-src").join("assets").join("prerelease.json"));

    for candidate in candidates {
        let Ok(raw) = std::fs::read(&candidate) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_slice::<Value>(&raw) else {
            continue;
        };
        if let Some(branch) = parsed["branch"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
            return Some(branch.to_owned());
        }
    }
    None
}

pub fn channel_name(pull_prereleases: bool) -> &'static str {
    if pull_prereleases {
        "beta"
    } else {
        "latest"
    }
}

pub fn read_pull_prereleases(app: &tauri::AppHandle) -> bool {
    let active = &app.state::<crate::settings::Settings>().paths.active;
    Preferences::new(active)
        .get("pullPreReleases")
        .ok()
        .flatten()
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn normalize_version_str(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).to_owned()
}

/// Evaluate whether `latest_version` should be offered as an update from `current_version`.
pub fn evaluate_app_update_offer(
    current_version: &str,
    latest_version: &str,
    prerelease_enabled: bool,
    force: bool,
) -> bool {
    let current_norm = normalize_version_str(current_version);
    let latest_norm = normalize_version_str(latest_version);

    let parsed_current = semver::Version::parse(&current_norm).ok();
    let parsed_latest = semver::Version::parse(&latest_norm).ok();

    let is_newer = match (&parsed_latest, &parsed_current) {
        (Some(latest), Some(current)) => latest > current,
        _ => latest_norm != current_norm,
    };
    let current_is_prerelease = parsed_current
        .as_ref()
        .is_some_and(|version| !version.pre.is_empty());
    let should_offer_downgrade_to_stable =
        !prerelease_enabled && current_is_prerelease && latest_norm != current_norm;
    let disallow_prerelease_downgrade = prerelease_enabled
        && matches!((&parsed_latest, &parsed_current), (Some(l), Some(c)) if l < c);

    !disallow_prerelease_downgrade && (force || is_newer || should_offer_downgrade_to_stable)
}

pub fn apply_dev_preview(
    status: &AppUpdateStatus,
    preview: Option<&ChangelogSnapshot>,
) -> AppUpdateStatus {
    let Some(changelog) = preview.filter(|_| !status.downloading) else {
        return status.clone();
    };
    AppUpdateStatus {
        current_version: changelog.from_version.clone(),
        latest_version: Some(changelog.to_version.clone()),
        update_available: true,
        checked_at: status.checked_at.clone(),
        error: None,
        checking: false,
        downloading: status.downloading,
        channel: status.channel.clone(),
        preview: Some(true),
    }
}

async fn resolve_beta_manifest_url(
    client: &reqwest::Client,
    repo: &str,
) -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{repo}/releases?per_page=30&page=1");
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to query GitHub releases: {e}"))?;
    let releases: Vec<GitHubRelease> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub releases: {e}"))?;
    select_best_beta_manifest_url(&releases).ok_or_else(|| {
        "No signed native update manifest (tauri-latest.json) was found on recent releases.".into()
    })
}

fn select_best_beta_manifest_url(releases: &[GitHubRelease]) -> Option<String> {
    releases
        .iter()
        .filter(|rel| rel.draft != Some(true))
        .filter_map(|rel| {
            let tag = rel.tag_name.as_deref()?;
            let ver = semver::Version::parse(&normalize_version_str(tag)).ok()?;
            let expected_url = format!("{ALLOWED_RELEASE_DOWNLOAD_PREFIX}{tag}/tauri-latest.json");
            let manifest_url = rel
                .assets
                .iter()
                .find(|asset| asset.name.as_deref() == Some("tauri-latest.json"))
                .and_then(|asset| asset.browser_download_url.as_deref())
                .filter(|url| *url == expected_url)?
                .to_owned();
            Some((ver, manifest_url))
        })
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, url)| url)
}

/// Howard Hinnant civil-from-days UTC timestamp in RFC3339 millisecond precision.
pub fn iso_now_utc() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = dur.as_secs();
    let millis = dur.subsec_millis();
    let days = (total_secs / 86_400) as i64;
    let rem = total_secs % 86_400;
    let hour = rem / 3_600;
    let min = (rem % 3_600) / 60;
    let sec = rem % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn evaluates_stable_beta_and_downgrade_update_rules() {
        // Newer stable
        assert!(evaluate_app_update_offer("2026.10.0", "2026.11.0", false, false));
        // Equal without force
        assert!(!evaluate_app_update_offer("2026.11.0", "2026.11.0", false, false));
        // Force reinstall/reoffer
        assert!(evaluate_app_update_offer("2026.11.0", "2026.11.0", false, true));
        // Downgrade from beta prerelease back to stable is allowed on stable channel
        assert!(evaluate_app_update_offer("2026.11.0-beta.1", "2026.10.0", false, false));
        // Downgrade from newer stable to older prerelease on beta channel is blocked
        assert!(!evaluate_app_update_offer("2026.12.0", "2026.11.0-beta.2", true, false));
        // Upgrading from prerelease 1 -> 2 on beta channel
        assert!(evaluate_app_update_offer("2026.11.0-beta.1", "2026.11.0-beta.2", true, false));
    }

    #[test]
    fn beta_clients_pick_the_newest_published_preview_with_its_own_manifest() {
        let release = |tag: &str, asset_tag: &str| GitHubRelease {
            tag_name: Some(tag.into()),
            draft: Some(false),
            assets: vec![GitHubReleaseAsset {
                name: Some("tauri-latest.json".into()),
                browser_download_url: Some(format!("{ALLOWED_RELEASE_DOWNLOAD_PREFIX}{asset_tag}/tauri-latest.json")),
            }],
        };
        let latest = "v2026.11.1-preview.10";
        let releases = [
            release("v2026.11.2-preview.1", "v2026.11.0"),
            release("v2026.11.1-preview.9", "v2026.11.1-preview.9"),
            release(latest, latest),
            release("v2026.11.0", "v2026.11.0"),
        ];
        assert_eq!(select_best_beta_manifest_url(&releases), Some(format!(
            "{ALLOWED_RELEASE_DOWNLOAD_PREFIX}{latest}/tauri-latest.json"
        )));
        assert!(evaluate_app_update_offer("2026.11.1-preview.9", latest, true, false));
        assert!(!evaluate_app_update_offer(latest, latest, true, false));
    }

    #[test]
    fn selects_highest_non_draft_beta_release_with_verified_manifest_url() {
        let releases = vec![
            GitHubRelease {
                tag_name: Some("v2026.12.0-beta.1".into()),
                draft: Some(true), // Draft must be ignored
                assets: vec![GitHubReleaseAsset {
                    name: Some("tauri-latest.json".into()),
                    browser_download_url: Some(
                        "https://github.com/bpwhelan/GameSentenceMiner/releases/download/v2026.12.0-beta.1/tauri-latest.json".into(),
                    ),
                }],
            },
            GitHubRelease {
                tag_name: Some("v2026.11.0-beta.2".into()),
                draft: Some(false),
                assets: vec![GitHubReleaseAsset {
                    name: Some("tauri-latest.json".into()),
                    browser_download_url: Some("https://evil.example.com/tauri-latest.json".into()), // Must be rejected
                }],
            },
            GitHubRelease {
                tag_name: Some("v2026.11.0-beta.1".into()),
                draft: Some(false),
                assets: vec![GitHubReleaseAsset {
                    name: Some("tauri-latest.json".into()),
                    browser_download_url: Some(
                        "https://github.com/bpwhelan/GameSentenceMiner/releases/download/v2026.11.0-beta.1/tauri-latest.json".into(),
                    ),
                }],
            },
        ];

        assert_eq!(
            select_best_beta_manifest_url(&releases).as_deref(),
            Some("https://github.com/bpwhelan/GameSentenceMiner/releases/download/v2026.11.0-beta.1/tauri-latest.json")
        );
    }

    #[test]
    fn resolves_prerelease_branch_from_resource_and_asset_locations() {
        let dir = TempDir::new().unwrap();
        let res = dir.path().join("res");
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&res).unwrap();
        std::fs::create_dir_all(&assets).unwrap();

        std::fs::write(assets.join("prerelease.json"), r#"{"branch":"next"}"#).unwrap();
        assert_eq!(
            read_prerelease_branch_from_dirs(dir.path(), &assets, Some(&res)).as_deref(),
            Some("next")
        );
    }

    #[test]
    fn applies_dev_preview_except_while_downloading() {
        let base = AppUpdateStatus {
            current_version: "2026.11.0".into(),
            latest_version: None,
            update_available: false,
            checked_at: None,
            error: Some("old err".into()),
            checking: false,
            downloading: false,
            channel: "latest".into(),
            preview: None,
        };
        let snap = ChangelogSnapshot {
            from_version: "2026.10.0".into(),
            to_version: "2026.11.1".into(),
            status: "ready".into(),
            source: Some("remote".into()),
            title: "What's Changed".into(),
            markdown: "## Changes".into(),
            asset_base_url: "gsm://localhost/assets/".into(),
            error: None,
        };

        let previewed = apply_dev_preview(&base, Some(&snap));
        assert!(previewed.update_available);
        assert_eq!(previewed.latest_version.as_deref(), Some("2026.11.1"));
        assert_eq!(previewed.preview, Some(true));
        assert_eq!(previewed.error, None);

        let downloading = AppUpdateStatus {
            downloading: true,
            ..base
        };
        let unchanged = apply_dev_preview(&downloading, Some(&snap));
        assert!(!unchanged.update_available);
        assert_eq!(unchanged.preview, None);
    }

    #[test]
    fn formats_valid_rfc3339_utc_timestamp() {
        let ts = iso_now_utc();
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.len(), 24);
        assert_eq!(&ts[10..11], "T");
    }
}
