//! Desktop update changelog resolution (bundled release notes + GitHub fallback).
use crate::client;
use gsm_settings::preferences::Preferences;
use gsm_settings::Result;
use regex::Regex;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path};
use std::sync::OnceLock;

pub const DEFAULT_CHANGELOG_REPO: &str = "bpwhelan/GameSentenceMiner";
const GITHUB_RELEASES_PAGE_SIZE: usize = 100;
const MAX_GITHUB_RELEASE_PAGES: usize = 5;

pub fn bundled_asset_base_url() -> &'static str {
    #[cfg(windows)]
    {
        "http://gsm.localhost/assets/changelog/images/"
    }
    #[cfg(not(windows))]
    {
        "gsm://localhost/assets/changelog/images/"
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingChangelogRecord {
    pub from_version: String,
    pub to_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogSnapshot {
    pub from_version: String,
    pub to_version: String,
    pub status: String,
    pub source: Option<String>,
    pub title: String,
    pub markdown: String,
    pub asset_base_url: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct ChangelogManifestEntry {
    version: String,
    title: Option<String>,
    file: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct ChangelogManifest {
    #[serde(default)]
    releases: Vec<ChangelogManifestEntry>,
}

#[derive(Clone, Debug)]
struct RemoteRelease {
    version: String,
    title: Option<String>,
    changelog_url: String,
    asset_base_url: String,
}

pub fn make_loading_snapshot(record: &PendingChangelogRecord) -> ChangelogSnapshot {
    ChangelogSnapshot {
        from_version: record.from_version.clone(),
        to_version: record.to_version.clone(),
        status: "loading".into(),
        source: None,
        title: format!("What's Changed in {}", record.to_version),
        markdown: String::new(),
        asset_base_url: bundled_asset_base_url().into(),
        error: None,
    }
}

fn make_ready_snapshot(
    record: &PendingChangelogRecord,
    source: &str,
    title: Option<&str>,
    markdown: String,
    asset_base_url: Option<&str>,
    error: Option<String>,
) -> ChangelogSnapshot {
    let resolved_title = title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("What's Changed in {}", record.to_version));
    ChangelogSnapshot {
        from_version: record.from_version.clone(),
        to_version: record.to_version.clone(),
        status: "ready".into(),
        source: Some(source.into()),
        title: resolved_title,
        markdown,
        asset_base_url: asset_base_url
            .filter(|s| !s.is_empty())
            .map_or_else(|| bundled_asset_base_url().to_owned(), ToOwned::to_owned),
        error,
    }
}

fn fallback_markdown(to_version: &str) -> String {
    format!(
        "# What's Changed in {to_version}\n\nThis update is installed. Detailed release notes are not available in this build."
    )
}

fn missing_remote_markdown(version: &str) -> String {
    format!("# What's Changed in {version}\n\nDetailed release notes are not available for this version.")
}

fn strip_leading_heading(markdown: &str) -> &str {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^\s*# .*(?:\r?\n)+").unwrap());
    let trimmed = if let Some(m) = re.find(markdown) {
        &markdown[m.end()..]
    } else {
        markdown
    };
    trimmed.trim()
}

fn normalize_release_version(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix('v').or_else(|| trimmed.strip_prefix('V')) {
        if rest.as_bytes().first().is_some_and(u8::is_ascii_digit) {
            return rest.to_owned();
        }
    }
    trimmed.to_owned()
}

fn parse_version(raw: &str) -> Option<Version> {
    Version::parse(&normalize_release_version(raw)).ok()
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    match (parse_version(a), parse_version(b)) {
        (Some(va), Some(vb)) => va.cmp(&vb),
        _ => a.cmp(b),
    }
}

fn version_in_range(version: &str, from_version: &str, to_version: &str) -> bool {
    match (parse_version(version), parse_version(from_version), parse_version(to_version)) {
        (Some(v), Some(f), Some(t)) => v > f && v <= t,
        _ => normalize_release_version(version) == normalize_release_version(to_version),
    }
}

fn version_in_preview_range(version: &str, from_version: &str, to_version: &str) -> bool {
    match (parse_version(version), parse_version(from_version), parse_version(to_version)) {
        (Some(v), Some(f), Some(t)) => {
            if t <= f {
                v == t
            } else {
                v > f && v <= t
            }
        }
        _ => normalize_release_version(version) == normalize_release_version(to_version),
    }
}

fn is_safe_relative_path(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return false;
    }
    path.components()
        .all(|c| !matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
}

fn is_https_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|u| u.scheme() == "https")
}

fn is_absolute_asset_url(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.starts_with("https:")
        || lower.starts_with("http:")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("gsm-changelog:")
}

fn rewrite_markdown_images_for_base_url(markdown: &str, asset_base_url: &str) -> String {
    static IMG_RE: OnceLock<Regex> = OnceLock::new();
    let re = IMG_RE.get_or_init(|| {
        Regex::new(r#"!\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)"#).unwrap()
    });
    let Ok(base) = reqwest::Url::parse(&if asset_base_url.ends_with('/') {
        asset_base_url.to_owned()
    } else {
        format!("{asset_base_url}/")
    }) else {
        return markdown.to_owned();
    };

    re.replace_all(markdown, |caps: &regex::Captures<'_>| {
        let alt = &caps[1];
        let ref_url = &caps[2];
        let title = caps.get(3).map_or("", |m| m.as_str());
        if is_absolute_asset_url(ref_url) {
            return format!("![{alt}]({ref_url}{title})");
        }
        let clean_src = ref_url.trim_start_matches("./");
        match base.join(clean_src) {
            Ok(joined) => format!("![{alt}]({joined}{title})"),
            Err(_) => caps[0].to_owned(),
        }
    })
    .into_owned()
}

pub fn get_desktop_update_changelog_target(
    stored_version: &str,
    current_version: &str,
    existing_pending: Option<&PendingChangelogRecord>,
    is_seen: impl Fn(&str) -> bool,
) -> Option<PendingChangelogRecord> {
    if let Some(pending) = existing_pending {
        if pending.to_version == current_version && !is_seen(&pending.to_version) {
            return Some(pending.clone());
        }
    }
    if stored_version.trim().is_empty()
        || stored_version == current_version
        || is_seen(current_version)
    {
        return None;
    }
    Some(PendingChangelogRecord {
        from_version: stored_version.to_owned(),
        to_version: current_version.to_owned(),
    })
}

pub fn resolve_bundled_changelog(
    assets_dir: &Path,
    record: &PendingChangelogRecord,
    require_target: bool,
) -> Result<ChangelogSnapshot> {
    let changelog_root = assets_dir.join("changelog");
    let manifest_raw = fs::read_to_string(changelog_root.join("manifest.json"))
        .map_err(|e| e.to_string())?;
    let manifest: ChangelogManifest =
        serde_json::from_str(manifest_raw.trim_start_matches('\u{feff}'))
            .map_err(|e| e.to_string())?;

    let mut selected: Vec<&ChangelogManifestEntry> = manifest
        .releases
        .iter()
        .filter(|e| version_in_range(&e.version, &record.from_version, &record.to_version))
        .collect();
    if selected.is_empty() {
        selected = manifest
            .releases
            .iter()
            .filter(|e| e.version == record.to_version)
            .collect();
    }
    selected.sort_by(|a, b| compare_versions(&a.version, &b.version));

    if selected.is_empty()
        || (require_target && !selected.iter().any(|e| e.version == record.to_version))
    {
        return Ok(make_ready_snapshot(
            record,
            "bundled",
            None,
            fallback_markdown(&record.to_version),
            None,
            Some(format!("No bundled changelog entry found for {}.", record.to_version)),
        ));
    }

    let root_canon = fs::canonicalize(&changelog_root).map_err(|e| e.to_string())?;
    let mut sections = Vec::with_capacity(selected.len());
    for entry in &selected {
        let rel = entry
            .file
            .as_deref()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("releases/{}.md", entry.version));
        if !is_safe_relative_path(&rel) {
            return Err(format!("Unsafe bundled changelog path: {rel}"));
        }
        let target = fs::canonicalize(changelog_root.join(&rel)).map_err(|e| e.to_string())?;
        if !target.starts_with(&root_canon) {
            return Err(format!("Bundled changelog path escaped root: {rel}"));
        }
        let raw_md = fs::read_to_string(&target).map_err(|e| e.to_string())?;
        if selected.len() == 1 {
            sections.push(raw_md.trim().to_owned());
        } else {
            let title = entry.title.as_deref().unwrap_or(&entry.version);
            sections.push(format!("## {title}\n\n{}", strip_leading_heading(&raw_md)));
        }
    }

    let title = if selected.len() == 1 {
        selected[0]
            .title
            .as_deref()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("What's Changed in {}", record.to_version))
    } else {
        format!("What's Changed from {} to {}", record.from_version, record.to_version)
    };

    Ok(make_ready_snapshot(
        record,
        "bundled",
        Some(&title),
        sections.join("\n\n").trim().to_owned(),
        Some(bundled_asset_base_url()),
        None,
    ))
}

fn build_release_asset_base_url(repo: &str, version: &str) -> String {
    format!("https://github.com/{repo}/releases/download/v{version}/")
}

pub fn fetch_remote_single_changelog(
    repo: &str,
    record: &PendingChangelogRecord,
    timeout_secs: u64,
) -> Result<ChangelogSnapshot> {
    let url = format!(
        "{}changelog-v{}.json",
        build_release_asset_base_url(repo, &record.to_version),
        record.to_version
    );
    let payload: Value = client(timeout_secs)?
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| e.to_string())?;
    let markdown = payload
        .get("markdown")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Remote changelog payload did not include markdown.".to_string())?;
    let asset_base = payload
        .get("assetBaseUrl")
        .and_then(Value::as_str)
        .filter(|u| is_https_url(u))
        .unwrap_or("");
    let title = payload.get("title").and_then(Value::as_str);

    Ok(make_ready_snapshot(
        record,
        "remote",
        title,
        markdown.to_owned(),
        Some(asset_base),
        None,
    ))
}

pub fn fetch_remote_range_changelog(
    repo: &str,
    record: &PendingChangelogRecord,
    include_prereleases: bool,
    require_target: bool,
    timeout_secs: u64,
) -> Result<ChangelogSnapshot> {
    let http = client(timeout_secs)?;
    let mut unique: BTreeMap<String, RemoteRelease> = BTreeMap::new();

    for page in 1..=MAX_GITHUB_RELEASE_PAGES {
        let url = format!(
            "https://api.github.com/repos/{repo}/releases?per_page={GITHUB_RELEASES_PAGE_SIZE}&page={page}"
        );
        let resp = http
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?;
        let items: Vec<Value> = resp.json().map_err(|e| e.to_string())?;
        let count = items.len();

        for item in items {
            if item.get("draft").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let prerelease = item.get("prerelease").and_then(Value::as_bool) == Some(true);
            if prerelease && !include_prereleases {
                continue;
            }
            let Some(tag_name) = item.get("tag_name").and_then(Value::as_str) else {
                continue;
            };
            let version = normalize_release_version(tag_name);
            if version.is_empty() || unique.contains_key(&version) {
                continue;
            }
            let asset_base_url = build_release_asset_base_url(repo, &version);
            let expected_asset = format!("changelog-v{version}.json");
            let changelog_url = item
                .get("assets")
                .and_then(Value::as_array)
                .and_then(|assets| {
                    assets.iter().find_map(|a| {
                        let name = a.get("name").and_then(Value::as_str)?;
                        let dl = a.get("browser_download_url").and_then(Value::as_str)?;
                        (name == expected_asset && is_https_url(dl)).then(|| dl.to_owned())
                    })
                })
                .unwrap_or_else(|| format!("{asset_base_url}{expected_asset}"));

            unique.insert(
                version.clone(),
                RemoteRelease {
                    version,
                    title: item
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(ToOwned::to_owned),
                    changelog_url,
                    asset_base_url,
                },
            );
        }

        if count < GITHUB_RELEASES_PAGE_SIZE {
            break;
        }
    }

    let mut selected: Vec<RemoteRelease> = unique
        .into_values()
        .filter(|r| version_in_preview_range(&r.version, &record.from_version, &record.to_version))
        .collect();
    selected.sort_by(|a, b| compare_versions(&a.version, &b.version));

    if selected.is_empty()
        || (require_target && !selected.iter().any(|r| r.version == record.to_version))
    {
        return Err(format!(
            "No GitHub changelog releases found from {} to {}.",
            record.from_version, record.to_version
        ));
    }

    let mut sections = Vec::with_capacity(selected.len());
    for release in &selected {
        let fetched = http
            .get(&release.changelog_url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json::<Value>())
            .ok();
        let section = fetched
            .as_ref()
            .and_then(|payload| {
                let md = payload
                    .get("markdown")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())?;
                let base = payload
                    .get("assetBaseUrl")
                    .and_then(Value::as_str)
                    .filter(|u| is_https_url(u))
                    .unwrap_or(&release.asset_base_url);
                let title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned)
                    .or_else(|| release.title.clone())
                    .unwrap_or_else(|| format!("What's Changed in {}", release.version));
                Some((title, rewrite_markdown_images_for_base_url(md, base)))
            })
            .unwrap_or_else(|| {
                (
                    release
                        .title
                        .clone()
                        .unwrap_or_else(|| format!("What's Changed in {}", release.version)),
                    missing_remote_markdown(&release.version),
                )
            });
        sections.push(section);
    }

    let markdown = if sections.len() == 1 {
        sections[0].1.clone()
    } else {
        sections
            .iter()
            .map(|(title, md)| format!("## {title}\n\n{}", strip_leading_heading(md)))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let title = if sections.len() == 1 {
        sections[0].0.clone()
    } else {
        format!("What's Changed from {} to {}", record.from_version, record.to_version)
    };

    Ok(make_ready_snapshot(
        record,
        "remote",
        Some(&title),
        markdown,
        Some(bundled_asset_base_url()),
        None,
    ))
}

/// Persistent seen/pending changelog state backed by `electron/config.json`.
pub struct PreferencesChangelogStore {
    preferences: Preferences,
}

impl PreferencesChangelogStore {
    pub fn new(preferences: Preferences) -> Self {
        Self { preferences }
    }

    pub fn pending(&self) -> Result<Option<PendingChangelogRecord>> {
        let Some(val) = self.preferences.get("pendingDesktopChangelog")? else {
            return Ok(None);
        };
        if val.is_null() {
            return Ok(None);
        }
        Ok(serde_json::from_value(val).ok())
    }

    pub fn set_pending(&self, record: &PendingChangelogRecord) -> Result<()> {
        self.preferences
            .patch(&json!({ "pendingDesktopChangelog": record }))?;
        Ok(())
    }

    pub fn clear_pending(&self, to_version: Option<&str>) -> Result<()> {
        let Some(current) = self.pending()? else {
            return Ok(());
        };
        if to_version.is_none_or(|v| current.to_version == v) {
            self.preferences
                .patch(&json!({ "pendingDesktopChangelog": Value::Null }))?;
        }
        Ok(())
    }

    pub fn seen_versions(&self) -> Result<HashSet<String>> {
        let Some(val) = self.preferences.get("desktopChangelogSeenVersions")? else {
            return Ok(HashSet::new());
        };
        Ok(val
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn has_seen(&self, version: &str) -> Result<bool> {
        Ok(self.seen_versions()?.contains(version))
    }

    pub fn mark_seen(&self, version: &str) -> Result<()> {
        let mut versions: Vec<String> = self
            .preferences
            .get("desktopChangelogSeenVersions")?
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(ToOwned::to_owned))
            .collect();
        if !versions.iter().any(|v| v == version) {
            versions.push(version.to_owned());
            if versions.len() > 50 {
                let excess = versions.len() - 50;
                versions.drain(0..excess);
            }
        }
        self.preferences
            .patch(&json!({ "desktopChangelogSeenVersions": versions }))?;
        self.clear_pending(Some(version))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolves_ranged_bundled_entries_and_blocks_traversal() {
        let dir = tempdir().unwrap();
        let changelog = dir.path().join("changelog");
        let releases = changelog.join("releases");
        fs::create_dir_all(&releases).unwrap();
        fs::write(releases.join("2.1.0.md"), "# Release 2.1.0\n\n- Added A\n").unwrap();
        fs::write(releases.join("2.2.0.md"), "# Release 2.2.0\n\n- Added B\n").unwrap();
        fs::write(
            changelog.join("manifest.json"),
            r#"{"releases":[{"version":"2.0.0"},{"version":"2.1.0","title":"v2.1"},{"version":"2.2.0","title":"v2.2"}]}"#,
        )
        .unwrap();

        let snap = resolve_bundled_changelog(
            dir.path(),
            &PendingChangelogRecord {
                from_version: "2.0.0".into(),
                to_version: "2.2.0".into(),
            },
            false,
        )
        .unwrap();
        assert_eq!(snap.status, "ready");
        assert!(snap.markdown.contains("## v2.1"));
        assert!(snap.markdown.contains("Added A"));
        assert!(snap.markdown.contains("## v2.2"));
        assert!(snap.markdown.contains("Added B"));

        // Traversal rejection
        fs::write(
            changelog.join("manifest.json"),
            r#"{"releases":[{"version":"9.9.9","file":"../secret.md"}]}"#,
        )
        .unwrap();
        assert!(resolve_bundled_changelog(
            dir.path(),
            &PendingChangelogRecord {
                from_version: "1.0.0".into(),
                to_version: "9.9.9".into(),
            },
            true,
        )
        .is_err());
    }

    #[test]
    fn rewrites_relative_markdown_images_and_tracks_seen_versions() {
        let rewritten = rewrite_markdown_images_for_base_url(
            "Look: ![demo](./shot.png \"preview\") and ![ext](https://cdn.example/a.png)",
            "https://github.com/bpwhelan/GameSentenceMiner/releases/download/v2.2.0/",
        );
        assert!(rewritten.contains(
            "https://github.com/bpwhelan/GameSentenceMiner/releases/download/v2.2.0/shot.png"
        ));
        assert!(rewritten.contains("https://cdn.example/a.png"));

        let dir = tempdir().unwrap();
        let store = PreferencesChangelogStore::new(Preferences::new(dir.path()));
        let rec = PendingChangelogRecord {
            from_version: "2.1.0".into(),
            to_version: "2.2.0".into(),
        };
        store.set_pending(&rec).unwrap();
        assert_eq!(store.pending().unwrap(), Some(rec.clone()));
        store.mark_seen("2.2.0").unwrap();
        assert!(store.has_seen("2.2.0").unwrap());
        assert_eq!(store.pending().unwrap(), None);
        assert!(get_desktop_update_changelog_target("2.1.0", "2.2.0", None, |v| {
            store.has_seen(v).unwrap()
        })
        .is_none());
    }
}
