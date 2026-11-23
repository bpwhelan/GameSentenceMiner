use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub browser: String,
    pub profile: String,
    pub directory: PathBuf,
    pub id: String,
    pub reader: &'static str,
    pub direct: bool,
}

fn read_json(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or(Value::Null)
}

fn reader(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    if name.contains("yomitan") {
        Some("yomitan")
    } else if name.contains("hachidori") {
        Some("hachidori")
    } else {
        None
    }
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| (b'a'..=b'p').contains(&c))
}

fn manifest_reader(manifest: &Value, base: &Path) -> Option<&'static str> {
    let name = manifest["name"].as_str()?;
    let Some(message) = name
        .strip_prefix("__MSG_")
        .and_then(|s| s.strip_suffix("__"))
    else {
        return reader(name);
    };
    let locale = manifest["default_locale"].as_str().unwrap_or("en");
    if !locale
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    {
        return None;
    }
    let messages = read_json(&base.join("_locales").join(locale).join("messages.json"));
    reader(messages[message]["message"].as_str()?)
}

fn subdirs(path: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_type().ok()?.is_dir().then(|| entry.path()))
}

pub fn sources_in(browser: &str, profile: &Path) -> Vec<Source> {
    let label = profile
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut found = BTreeMap::new();
    for settings in ["Preferences", "Secure Preferences"] {
        let preferences = read_json(&profile.join(settings));
        if let Some(extensions) = preferences["extensions"]["settings"].as_object() {
            for (id, extension) in extensions {
                if !valid_id(id) {
                    continue;
                }
                let manifest = &extension["manifest"];
                let base = extension["path"]
                    .as_str()
                    .map(PathBuf::from)
                    .unwrap_or_default();
                let base = profile.join("Extensions").join(base);
                if let Some(kind) = manifest_reader(manifest, &base) {
                    found.insert(id.clone(), kind);
                }
            }
        }
    }
    for extension in subdirs(&profile.join("Extensions")) {
        let Some(id) = extension
            .file_name()
            .and_then(|id| id.to_str())
            .filter(|id| valid_id(id))
        else {
            continue;
        };
        if found.contains_key(id) {
            continue;
        }
        for version in subdirs(&extension) {
            if let Some(kind) =
                manifest_reader(&read_json(&version.join("manifest.json")), &version)
            {
                found.insert(id.to_owned(), kind);
                break;
            }
        }
    }

    let mut result: Vec<_> = found
        .into_iter()
        .filter_map(|(id, reader)| {
            let (database, settings) = storage_paths(profile, &id);
            (database.join("CURRENT").is_file() || settings.join("CURRENT").is_file()).then(|| {
                Source {
                    browser: browser.into(),
                    profile: label.clone(),
                    directory: profile.into(),
                    id,
                    reader,
                    direct: true,
                }
            })
        })
        .collect();
    let firefox = read_json(&profile.join("extensions.json"));
    for addon in firefox["addons"].as_array().into_iter().flatten() {
        if let Some(reader) = addon["defaultLocale"]["name"].as_str().and_then(reader) {
            if let Some(id) = addon["id"].as_str() {
                result.push(Source {
                    browser: browser.into(),
                    profile: label.clone(),
                    directory: profile.into(),
                    id: id.into(),
                    reader,
                    direct: false,
                });
            }
        }
    }
    result
}

pub fn storage_paths(profile: &Path, id: &str) -> (PathBuf, PathBuf) {
    (
        profile
            .join("IndexedDB")
            .join(format!("chrome-extension_{id}_0.indexeddb.leveldb")),
        profile.join("Local Extension Settings").join(id),
    )
}

pub fn discover() -> Vec<Source> {
    let mut result = Vec::new();
    let mut scan_root = |browser: &str, root: PathBuf| {
        result.extend(sources_in(browser, &root));
        for profile in subdirs(&root) {
            if profile != root
                && (profile.join("Preferences").is_file()
                    || profile.join("extensions.json").is_file())
            {
                result.extend(sources_in(browser, &profile));
            }
        }
    };
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        for (browser, relative) in [
            ("Chrome", "Google/Chrome/User Data"),
            ("Chrome Beta", "Google/Chrome Beta/User Data"),
            ("Chrome Canary", "Google/Chrome SxS/User Data"),
            ("Edge", "Microsoft/Edge/User Data"),
            ("Brave", "BraveSoftware/Brave-Browser/User Data"),
            ("Vivaldi", "Vivaldi/User Data"),
            ("Chromium", "Chromium/User Data"),
        ] {
            scan_root(browser, local.join(relative));
        }
    }
    if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
        for (browser, relative) in [
            ("Opera", "Opera Software/Opera Stable"),
            ("Opera GX", "Opera Software/Opera GX Stable"),
            ("Firefox", "Mozilla/Firefox/Profiles"),
        ] {
            scan_root(browser, roaming.join(relative));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_localized_extensions_only_when_storage_exists() {
        let profile = tempfile::tempdir().unwrap();
        let id = "abcdefghijklmnopabcdefghijklmnop";
        let (database, _) = storage_paths(profile.path(), id);
        let extension = profile.path().join("Extensions").join(id).join("1.0");
        fs::create_dir_all(extension.join("_locales/en")).unwrap();
        fs::write(
            extension.join("manifest.json"),
            r#"{"name":"__MSG_name__","default_locale":"en"}"#,
        )
        .unwrap();
        fs::write(
            extension.join("_locales/en/messages.json"),
            r#"{"name":{"message":"Yomitan Popup Dictionary"}}"#,
        )
        .unwrap();
        assert!(sources_in("Edge", profile.path()).is_empty());
        fs::create_dir_all(&database).unwrap();
        fs::write(database.join("CURRENT"), "MANIFEST-000001").unwrap();
        let sources = sources_in("Edge", profile.path());
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].reader, "yomitan");
        assert_eq!(sources[0].id, id);
    }
}
