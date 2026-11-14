//! Native desktop changelog coordinator wrapping `gsm_packages::changelog`.
use gsm_packages::changelog::{
    bundled_asset_base_url, fetch_remote_range_changelog, fetch_remote_single_changelog,
    get_desktop_update_changelog_target, make_loading_snapshot, resolve_bundled_changelog,
    ChangelogSnapshot, PendingChangelogRecord, PreferencesChangelogStore, DEFAULT_CHANGELOG_REPO,
};
use gsm_settings::preferences::Preferences;
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};
use tauri::Manager;

const REMOTE_TIMEOUT_SECS: u64 = 3;

#[derive(Default)]
struct ChangelogInner {
    snapshot: Option<ChangelogSnapshot>,
    resolving_key: Option<String>,
    manual_resolving_key: Option<String>,
    manual_request_id: u64,
}

pub struct DesktopChangelog {
    repo: String,
    inner: Mutex<ChangelogInner>,
}

impl Default for DesktopChangelog {
    fn default() -> Self {
        Self {
            repo: DEFAULT_CHANGELOG_REPO.to_owned(),
            inner: Mutex::new(ChangelogInner::default()),
        }
    }
}

pub fn dev_asset_base_url() -> &'static str {
    if cfg!(windows) {
        "http://gsm.localhost/desktop-assets/changelog/images/"
    } else {
        "gsm://localhost/desktop-assets/changelog/images/"
    }
}

// Wired in Slice 2 (startup/manual changelog + updater preview UI).
#[allow(dead_code)]
pub fn resolve_changelog_asset_base_url(app_root: &Path) -> &'static str {
    if app_root.join("assets").is_dir() {
        bundled_asset_base_url()
    } else {
        dev_asset_base_url()
    }
}

pub fn adjust_snapshot_asset_base(mut snapshot: ChangelogSnapshot, app_root: &Path) -> ChangelogSnapshot {
    let bundled = bundled_asset_base_url();
    if snapshot.asset_base_url == bundled && !app_root.join("assets").is_dir() {
        snapshot.asset_base_url = dev_asset_base_url().to_owned();
    }
    snapshot
}

pub fn is_allowed_changelog_setting_choice(choice: &str) -> bool {
    matches!(
        choice,
        "review-after-session:enable"
            | "overlay-presence-invalidation:enable"
            | "overlay-presence-invalidation:disable"
    )
}

fn version_key(record: &PendingChangelogRecord) -> String {
    format!("{}->{}", record.from_version, record.to_version)
}

fn store_for(app: &tauri::AppHandle) -> PreferencesChangelogStore {
    let active = &app.state::<crate::settings::Settings>().paths.active;
    PreferencesChangelogStore::new(Preferences::new(active))
}

fn emit_hub(app: &tauri::AppHandle, channel: &str, snapshot: Option<&ChangelogSnapshot>) {
    let Some(hub) = crate::desktop_state::find_hub_window(app) else {
        return;
    };
    let payload = match snapshot {
        Some(snap) => serde_json::to_value(snap).unwrap_or(Value::Null),
        None => Value::Null,
    };
    crate::desktop_state::emit_to_window(app, hub.label(), channel, &[payload]);
}

impl DesktopChangelog {
    pub fn get_pending_record(&self, app: &tauri::AppHandle) -> Option<PendingChangelogRecord> {
        let store = store_for(app);
        let pending = store.pending().ok().flatten()?;
        if store.has_seen(&pending.to_version).unwrap_or(false) {
            let _ = store.clear_pending(Some(&pending.to_version));
            return None;
        }
        Some(pending)
    }

    // Wired in Slice 2 (startup update check & updater preview UI).
    #[allow(dead_code)]
    pub fn check_startup_target(
        &self,
        app: &tauri::AppHandle,
        stored_version: &str,
        current_version: &str,
    ) -> Option<PendingChangelogRecord> {
        let store = store_for(app);
        let existing = self.get_pending_record(app);
        let target = get_desktop_update_changelog_target(
            stored_version,
            current_version,
            existing.as_ref(),
            |v| store.has_seen(v).unwrap_or(false),
        )?;
        self.start_desktop_update(app, target.clone());
        Some(target)
    }

    // Wired in Slice 2 (startup update check).
    #[allow(dead_code)]
    pub fn start_desktop_update(
        &self,
        app: &tauri::AppHandle,
        record: PendingChangelogRecord,
    ) -> Option<ChangelogSnapshot> {
        let store = store_for(app);
        let app_root = app.state::<crate::desktop_state::DesktopState>().app_root.clone();

        if store.has_seen(&record.to_version).unwrap_or(false) {
            let _ = store.clear_pending(Some(&record.to_version));
            self.inner.lock().unwrap().snapshot = None;
            emit_hub(app, "changelog.snapshot", None);
            return None;
        }

        let _ = store.set_pending(&record);
        let snapshot = {
            let mut guard = self.inner.lock().unwrap();
            let needs_reset = guard.snapshot.as_ref().is_none_or(|s| {
                s.from_version != record.from_version || s.to_version != record.to_version
            });
            if needs_reset {
                let loading = adjust_snapshot_asset_base(make_loading_snapshot(&record), &app_root);
                guard.snapshot = Some(loading.clone());
                emit_hub(app, "changelog.snapshot", Some(&loading));
            }
            guard.snapshot.clone()
        };

        self.spawn_pending_resolve(app, record);
        snapshot
    }

    pub fn get_pending_snapshot(&self, app: &tauri::AppHandle) -> Option<ChangelogSnapshot> {
        let pending = self.get_pending_record(app)?;
        let app_root = app.state::<crate::desktop_state::DesktopState>().app_root.clone();

        let (snapshot, should_resolve) = {
            let mut guard = self.inner.lock().unwrap();
            let matches = guard.snapshot.as_ref().is_some_and(|s| {
                s.from_version == pending.from_version && s.to_version == pending.to_version
            });
            if !matches {
                let loading = adjust_snapshot_asset_base(make_loading_snapshot(&pending), &app_root);
                guard.snapshot = Some(loading.clone());
                (loading, true)
            } else {
                (guard.snapshot.clone().unwrap(), false)
            }
        };

        if should_resolve {
            self.spawn_pending_resolve(app, pending);
        }
        Some(snapshot)
    }

    pub fn mark_seen(&self, app: &tauri::AppHandle, to_version: Option<&str>) -> bool {
        let store = store_for(app);
        let target_version = to_version
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| store.pending().ok().flatten().map(|p| p.to_version))
            .or_else(|| self.inner.lock().unwrap().snapshot.as_ref().map(|s| s.to_version.clone()));

        let Some(version) = target_version else {
            return false;
        };

        if store.mark_seen(&version).is_err() {
            return false;
        }

        let mut guard = self.inner.lock().unwrap();
        if guard.snapshot.as_ref().is_none_or(|s| s.to_version == version) {
            guard.snapshot = None;
            drop(guard);
            emit_hub(app, "changelog.snapshot", None);
        }
        true
    }

    // Wired in Slice 2 (manual changelog command / tray action).
    #[allow(dead_code)]
    pub fn start_manual_display(
        &self,
        app: &tauri::AppHandle,
        record: PendingChangelogRecord,
    ) -> ChangelogSnapshot {
        self.start_manual_internal(app, record, false, false)
    }

    pub fn start_update_preview(
        &self,
        app: &tauri::AppHandle,
        record: PendingChangelogRecord,
        include_prereleases: Option<bool>,
    ) -> ChangelogSnapshot {
        let pre = include_prereleases.unwrap_or_else(|| {
            semver::Version::parse(record.to_version.trim_start_matches(['v', 'V']))
                .is_ok_and(|v| !v.pre.is_empty())
        });
        self.start_manual_internal(app, record, true, pre)
    }

    pub fn clear_manual_display(&self, app: &tauri::AppHandle) {
        {
            let mut guard = self.inner.lock().unwrap();
            guard.manual_request_id += 1;
            guard.manual_resolving_key = None;
        }
        emit_hub(app, "changelog.manualSnapshot", None);
    }

    // Wired in Slice 2 (online changelog preview / updater).
    #[allow(dead_code)]
    pub async fn get_latest_online_preview(
        &self,
        app: &tauri::AppHandle,
        current_version: &str,
        include_prereleases: bool,
    ) -> Result<ChangelogSnapshot, String> {
        let repo = self.repo.clone();
        let current = current_version.to_owned();
        let app_root = app.state::<crate::desktop_state::DesktopState>().app_root.clone();
        let client = app
            .state::<crate::desktop_state::DesktopState>()
            .http
            .clone();

        // Fetch GitHub releases via async client to find the latest matching version,
        // then resolve its full snapshot via the shared `gsm_packages` helper.
        let url = format!(
            "https://api.github.com/repos/{repo}/releases?per_page=30&page=1"
        );
        let resp = client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?;
        let items: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
        let latest = items
            .into_iter()
            .filter(|item| item.get("draft").and_then(Value::as_bool) != Some(true))
            .filter(|item| {
                include_prereleases
                    || item.get("prerelease").and_then(Value::as_bool) != Some(true)
            })
            .filter_map(|item| {
                let raw = item.get("tag_name")?.as_str()?;
                let normalized = raw.trim().trim_start_matches(['v', 'V']).to_owned();
                let parsed = semver::Version::parse(&normalized).ok()?;
                Some((parsed, normalized))
            })
            .max_by(|(a, _), (b, _)| a.cmp(b))
            .map(|(_, ver)| ver)
            .ok_or_else(|| "No online release was found for the selected update channel.".to_string())?;

        let record = PendingChangelogRecord {
            from_version: current,
            to_version: latest,
        };
        let snap = tokio::task::spawn_blocking(move || {
            fetch_remote_single_changelog(&repo, &record, REMOTE_TIMEOUT_SECS)
        })
        .await
        .map_err(|e| e.to_string())??;

        Ok(adjust_snapshot_asset_base(snap, &app_root))
    }

    pub async fn get_update_preview(
        &self,
        app: &tauri::AppHandle,
        record: PendingChangelogRecord,
        include_prereleases: bool,
    ) -> ChangelogSnapshot {
        let repo = self.repo.clone();
        let state = app.state::<crate::desktop_state::DesktopState>();
        let app_root = state.app_root.clone();
        let assets_dir = state.assets_dir();

        let rec_remote = record.clone();
        if let Ok(Ok(snap)) = tokio::task::spawn_blocking(move || {
            fetch_remote_range_changelog(&repo, &rec_remote, include_prereleases, true, REMOTE_TIMEOUT_SECS)
        })
        .await
        {
            return adjust_snapshot_asset_base(snap, &app_root);
        }

        let rec_bundled = record.clone();
        if let Ok(Ok(bundled)) = tokio::task::spawn_blocking(move || {
            resolve_bundled_changelog(&assets_dir, &rec_bundled, true)
        })
        .await
        {
            if bundled.error.is_none() {
                return adjust_snapshot_asset_base(bundled, &app_root);
            }
        }

        let mut failed = adjust_snapshot_asset_base(make_loading_snapshot(&record), &app_root);
        failed.status = "failed".into();
        failed.error = Some("Release notes could not be loaded.".into());
        failed
    }

    fn spawn_pending_resolve(&self, app: &tauri::AppHandle, record: PendingChangelogRecord) {
        let key = version_key(&record);
        {
            let mut guard = self.inner.lock().unwrap();
            if guard.resolving_key.as_deref() == Some(key.as_str()) {
                return;
            }
            guard.resolving_key = Some(key.clone());
        }

        let app_handle = app.clone();
        let repo = self.repo.clone();
        let state = app.state::<crate::desktop_state::DesktopState>();
        let app_root = state.app_root.clone();
        let assets_dir = state.assets_dir();

        tauri::async_runtime::spawn(async move {
            let rec_b = record.clone();
            let bundled = tokio::task::spawn_blocking(move || {
                resolve_bundled_changelog(&assets_dir, &rec_b, false)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);

            let changelog = app_handle.state::<DesktopChangelog>();
            let is_still_current = || {
                changelog
                    .get_pending_record(&app_handle)
                    .is_some_and(|p| p.from_version == record.from_version && p.to_version == record.to_version)
            };

            if is_still_current() {
                let snap = match bundled {
                    Ok(s) => adjust_snapshot_asset_base(s, &app_root),
                    Err(err) => {
                        let mut fallback = adjust_snapshot_asset_base(make_loading_snapshot(&record), &app_root);
                        fallback.status = "ready".into();
                        fallback.source = Some("bundled".into());
                        fallback.markdown = format!(
                            "# What's Changed in {}\n\nThis update is installed. Detailed release notes are not available in this build.",
                            record.to_version
                        );
                        fallback.error = Some(err);
                        fallback
                    }
                };
                changelog.inner.lock().unwrap().snapshot = Some(snap.clone());
                emit_hub(&app_handle, "changelog.snapshot", Some(&snap));

                let rec_r = record.clone();
                let remote = tokio::task::spawn_blocking(move || {
                    fetch_remote_single_changelog(&repo, &rec_r, REMOTE_TIMEOUT_SECS)
                })
                .await;
                if let Ok(Ok(remote_snap)) = remote {
                    if is_still_current() {
                        let adjusted = adjust_snapshot_asset_base(remote_snap, &app_root);
                        changelog.inner.lock().unwrap().snapshot = Some(adjusted.clone());
                        emit_hub(&app_handle, "changelog.snapshot", Some(&adjusted));
                    }
                }
            }

            let mut guard = changelog.inner.lock().unwrap();
            if guard.resolving_key.as_deref() == Some(key.as_str()) {
                guard.resolving_key = None;
            }
        });
    }

    fn start_manual_internal(
        &self,
        app: &tauri::AppHandle,
        record: PendingChangelogRecord,
        remote_range: bool,
        include_prereleases: bool,
    ) -> ChangelogSnapshot {
        let app_root = app.state::<crate::desktop_state::DesktopState>().app_root.clone();
        let assets_dir = app.state::<crate::desktop_state::DesktopState>().assets_dir();
        let loading = adjust_snapshot_asset_base(make_loading_snapshot(&record), &app_root);

        let request_id = {
            let mut guard = self.inner.lock().unwrap();
            guard.manual_request_id += 1;
            let id = guard.manual_request_id;
            guard.manual_resolving_key = Some(format!("{id}:{}", version_key(&record)));
            id
        };
        emit_hub(app, "changelog.manualSnapshot", Some(&loading));

        let app_handle = app.clone();
        let repo = self.repo.clone();
        let key = format!("{request_id}:{}", version_key(&record));

        tauri::async_runtime::spawn(async move {
            let rec_b = record.clone();
            let bundled = tokio::task::spawn_blocking(move || {
                resolve_bundled_changelog(&assets_dir, &rec_b, false)
            })
            .await;

            let changelog = app_handle.state::<DesktopChangelog>();
            let is_current = || changelog.inner.lock().unwrap().manual_request_id == request_id;

            if is_current() {
                if let Ok(Ok(s)) = bundled {
                    let snap = adjust_snapshot_asset_base(s, &app_root);
                    emit_hub(&app_handle, "changelog.manualSnapshot", Some(&snap));
                }

                let rec_r = record.clone();
                let remote = tokio::task::spawn_blocking(move || {
                    if remote_range {
                        fetch_remote_range_changelog(
                            &repo,
                            &rec_r,
                            include_prereleases,
                            false,
                            REMOTE_TIMEOUT_SECS,
                        )
                    } else {
                        fetch_remote_single_changelog(&repo, &rec_r, REMOTE_TIMEOUT_SECS)
                    }
                })
                .await;

                if let Ok(Ok(remote_snap)) = remote {
                    if is_current() {
                        let adjusted = adjust_snapshot_asset_base(remote_snap, &app_root);
                        emit_hub(&app_handle, "changelog.manualSnapshot", Some(&adjusted));
                    }
                }
            }

            let mut guard = changelog.inner.lock().unwrap();
            if guard.manual_resolving_key.as_deref() == Some(key.as_str()) {
                guard.manual_resolving_key = None;
            }
        });

        loading
    }
}

pub async fn apply_setting_choice(app: &tauri::AppHandle, choice: &str) -> bool {
    if !is_allowed_changelog_setting_choice(choice) {
        return false;
    }
    crate::runtime::backend_command(app, "apply_changelog_setting_choice", json!({ "choice": choice }))
        .await
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn validates_changelog_setting_choice_allowlist() {
        assert!(is_allowed_changelog_setting_choice("review-after-session:enable"));
        assert!(is_allowed_changelog_setting_choice("overlay-presence-invalidation:enable"));
        assert!(is_allowed_changelog_setting_choice("overlay-presence-invalidation:disable"));
        assert!(!is_allowed_changelog_setting_choice("arbitrary-setting:delete"));
        assert!(!is_allowed_changelog_setting_choice(""));
    }

    #[test]
    fn rewrites_asset_base_url_for_dev_checkout_when_assets_dir_absent() {
        let dir = tempdir().unwrap();
        let snap = make_loading_snapshot(&PendingChangelogRecord {
            from_version: "1.0.0".into(),
            to_version: "1.1.0".into(),
        });
        let dev_adjusted = adjust_snapshot_asset_base(snap.clone(), dir.path());
        assert_eq!(dev_adjusted.asset_base_url, dev_asset_base_url());

        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        let pkg_adjusted = adjust_snapshot_asset_base(snap, dir.path());
        assert_eq!(pkg_adjusted.asset_base_url, bundled_asset_base_url());
    }
}
