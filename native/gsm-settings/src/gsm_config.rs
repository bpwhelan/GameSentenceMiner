//! Helpers for GSM root `config.json`, Python display locale syncing, and
//! desktop `electron/config.json` snapshots matching Electron's store defaults.
use crate::preferences::Preferences;
use crate::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Map, Value};
use std::path::Path;

pub const DEFAULT_GSM_SINGLE_PORT: u16 = 7275;

pub fn to_python_locale(locale: &str) -> &'static str {
    match locale.trim().to_ascii_lowercase().as_str() {
        "ja" => "ja_jp",
        "ukr" => "ukr_ua",
        "zh" => "zh_cn",
        "ko" => "ko_kr",
        "es" => "es_es",
        _ => "en_us",
    }
}

/// Syncs `electron_locale` into `<base>/config.json` (`locale` field) if the file exists.
/// Returns `Ok(true)` if the Python config changed and was persisted atomically.
pub fn sync_python_display_locale(electron_locale: &str, config_path: &Path) -> Result<bool> {
    if !config_path.exists() {
        return Ok(false);
    }
    let next_locale = to_python_locale(electron_locale);
    with_lock(config_path, || {
        let mut document = read_object(config_path)?;
        if document.get("locale").and_then(Value::as_str) == Some(next_locale) {
            return Ok(false);
        }
        if let Some(map) = document.as_object_mut() {
            map.insert("locale".into(), json!(next_locale));
        }
        write_atomic(config_path, &document)?;
        Ok(true)
    })
}

pub(crate) fn active_profile(config: &Value) -> Option<&Map<String, Value>> {
    let root = config.as_object()?;
    let Some(configs) = root.get("configs").and_then(Value::as_object) else {
        return Some(root);
    };
    let current = root
        .get("current_profile")
        .and_then(Value::as_str)
        .unwrap_or("Default");
    if let Some(profile) = configs.get(current).and_then(Value::as_object) {
        return Some(profile);
    }
    if let Some(default_profile) = configs.get("Default").and_then(Value::as_object) {
        return Some(default_profile);
    }
    configs.values().find_map(Value::as_object)
}

fn parse_port(value: &Value) -> Option<u16> {
    let raw = match value {
        Value::Number(num) => num.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    if !raw.is_finite() {
        return None;
    }
    let truncated = raw.trunc();
    if truncated <= 0.0 || truncated > u16::MAX as f64 {
        return None;
    }
    Some(truncated as u16)
}

pub fn resolve_single_port_from_config_data(config_data: &Value) -> u16 {
    let Some(profile) = active_profile(config_data) else {
        return DEFAULT_GSM_SINGLE_PORT;
    };
    let Some(general) = profile.get("general").and_then(Value::as_object) else {
        return DEFAULT_GSM_SINGLE_PORT;
    };
    if let Some(single_port) = general.get("single_port") {
        return parse_port(single_port).unwrap_or(DEFAULT_GSM_SINGLE_PORT);
    }
    general
        .get("texthooker_port")
        .and_then(parse_port)
        .unwrap_or(DEFAULT_GSM_SINGLE_PORT)
}

pub fn get_configured_single_port(config_path: &Path) -> u16 {
    match read_object(config_path) {
        Ok(data) => resolve_single_port_from_config_data(&data),
        Err(_) => DEFAULT_GSM_SINGLE_PORT,
    }
}

pub fn gsm_backend_url(config_path: &Path, route_path: &str) -> String {
    format!("http://localhost:{}{}", get_configured_single_port(config_path), route_path)
}

pub fn resolve_hachidori_enabled_from_config_data(config_data: &Value) -> bool {
    let Some(experimental) = config_data.get("experimental").and_then(Value::as_object) else {
        return false;
    };
    experimental
        .get("enable_experimental_features")
        .and_then(Value::as_bool)
        == Some(true)
        && experimental.get("enable_hachidori").and_then(Value::as_bool) == Some(true)
}

// Same accepted values as CommonLanguages in the mining profile schema.
pub fn is_learning_language(code: &str) -> bool {
    const CODES: &str = "af ak am apd ar arq ary arz as azb be bg bgc bho bm bn bo brx bs ca ceb cnr crs cs ctg cy da \
        dcc de doi dz ee el en es et eu fa fi fj fo fr ga gan gd gl gu ha hak he hi hns hr ht hu hy \
        id ig is it ja jam jv ka kea kg kk kl km kmr kn ko kok ks lb ln lo lt lua lv mad mag mai mfe \
        mg mi min mk ml mn mni mr mt my nan ne nl no nr or pap pbu pcm pl pnb ps pt ro ru rw sat sd \
        si sk skr sl sm sn so sq sr ss st su sv sw syl ta te th ti tl tn to ts twi ug uk ur uz ve vi \
        wo wuu xh yo yue zh zu";
    CODES.split_ascii_whitespace().any(|entry| entry == code)
}

pub fn save_target_language(path: &Path, language: &str) -> Result<()> {
    if !is_learning_language(language) {
        return Err("Unsupported learning language.".into());
    }
    with_lock(path, || {
        let mut doc = read_object(path)?;
        if !path.try_exists().map_err(|e| e.to_string())? {
            doc = json!({"current_profile":"Default","configs":{"Default":{}}});
        }
        let profile = if doc.get("configs").is_some() || doc.get("current_profile").is_some() {
            let current = doc["current_profile"].as_str().unwrap_or("Default").to_owned();
            let profiles = doc["configs"].as_object_mut().ok_or("Invalid profile collection")?;
            let name = if profiles.contains_key(&current) { current.as_str() } else { "Default" };
            profiles.get_mut(name).ok_or("No active profile found")?
        } else {
            // Profile-less files keep their original shape until the backend migrates them.
            &mut doc
        };
        let profile = profile.as_object_mut().ok_or("Invalid active profile")?;
        let general = profile.entry("general").or_insert_with(|| json!({}));
        let fields = general.as_object_mut().ok_or("Invalid general settings")?;
        fields.insert("target_language".into(), json!(language));
        write_atomic(path, &doc)
    })
}

pub fn get_configured_target_language(config_path: &Path) -> String {
    let Ok(config) = read_object(config_path) else {
        return "ja".into();
    };
    target_language_from_config(&config)
}

pub(crate) fn target_language_from_config(config: &Value) -> String {
    active_profile(config)
        .and_then(|profile| profile.get("general"))
        .and_then(|general| general.get("target_language"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "ja".into())
}

pub fn get_legacy_notification_features(config_path: &Path) -> Value {
    let Ok(config) = read_object(config_path) else {
        return json!({});
    };
    active_profile(&config)
        .and_then(|profile| profile.get("features"))
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}))
}

pub fn resolve_gsm_profiles_from_config_data(config_data: &Value) -> Value {
    let Some(configs) = config_data.get("configs").and_then(Value::as_object) else {
        return json!({
            "profiles": [],
            "currentProfile": "",
            "profileScenes": {},
        });
    };
    let profiles: Vec<String> = configs.keys().cloned().collect();
    let current_profile = config_data
        .get("current_profile")
        .and_then(Value::as_str)
        .filter(|candidate| profiles.iter().any(|p| p == candidate))
        .map(ToOwned::to_owned)
        .or_else(|| profiles.first().cloned())
        .unwrap_or_default();

    let mut profile_scenes = Map::new();
    for (name, profile_data) in configs {
        let scenes = profile_data
            .get("scenes")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|s| Value::String(s.to_owned())))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        profile_scenes.insert(name.clone(), Value::Array(scenes));
    }

    json!({
        "profiles": profiles,
        "currentProfile": current_profile,
        "profileScenes": profile_scenes,
    })
}

pub fn get_gsm_profile_names(config_path: &Path) -> Value {
    match read_object(config_path) {
        Ok(data) => resolve_gsm_profiles_from_config_data(&data),
        Err(_) => json!({
            "profiles": [],
            "currentProfile": "",
            "profileScenes": {},
        }),
    }
}

pub fn clamp_backup_retention(value: f64) -> i64 {
    if !value.is_finite() {
        return 2;
    }
    (value.trunc() as i64).clamp(1, 1000)
}

fn read_bool(doc: &Value, key: &str, default: bool) -> bool {
    doc.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn read_string<'a>(doc: &'a Value, key: &str, default: &'a str) -> String {
    doc.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
        .to_owned()
}

/// Builds the full `settings.getSettings` payload matching Electron `ui/settings.ts`.
pub fn desktop_settings_snapshot(preferences: &Preferences, gsm_config_path: &Path) -> Result<Value> {
    let doc = preferences.snapshot()?;
    let visible_tabs = doc
        .get("visibleTabs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("launcher"), json!("stats"), json!("console")]);

    let retention = doc
        .get("databaseBackupRetentionCount")
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
        .map(clamp_backup_retention)
        .unwrap_or(2);

    let setup_wizard_version = doc
        .get("setupWizardVersion")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let console_mode = match doc.get("consoleMode").and_then(Value::as_str) {
        Some("advanced") => "advanced",
        _ => "simple",
    };
    let ui_mode = match doc.get("uiMode").and_then(Value::as_str) {
        Some("advanced") => "advanced",
        _ => "basic",
    };

    Ok(json!({
        "autoUpdateGSMApp": read_bool(&doc, "autoUpdateGSMApp", false),
        "autoUpdateElectron": read_bool(&doc, "autoUpdateElectron", false),
        "pullPreReleases": read_bool(&doc, "pullPreReleases", false),
        "startConsoleMinimized": read_bool(&doc, "startConsoleMinimized", false),
        "customPythonPackage": doc.get("customPythonPackage").and_then(Value::as_str).unwrap_or("GameSentenceMiner"),
        "runOverlayOnStartup": read_bool(&doc, "runOverlayOnStartup", false),
        "runOverlayWithActiveGame": read_bool(&doc, "runOverlayWithActiveGame", false),
        "quitOnWindowClose": read_bool(&doc, "quitOnWindowClose", false),
        "textCaptureWizardEnabled": read_bool(&doc, "textCaptureWizardEnabled", true),
        "visibleTabs": visible_tabs,
        "statsEndpoint": read_string(&doc, "statsEndpoint", "overview"),
        "databaseBackupEnabled": doc.get("databaseBackupEnabled").and_then(Value::as_bool).unwrap_or(true),
        "databaseBackupDirectory": doc.get("databaseBackupDirectory").and_then(Value::as_str).unwrap_or("").trim(),
        "databaseBackupRetentionCount": retention,
        "singlePort": get_configured_single_port(gsm_config_path),
        "iconStyle": read_string(&doc, "iconStyle", "gsm"),
        "locale": doc.get("locale").and_then(Value::as_str).unwrap_or("en"),
        "theme": read_string(&doc, "theme", "gsm-dark"),
        "seasonalEffectsDisabled": read_bool(&doc, "seasonalEffectsDisabled", false),
        "consoleMode": console_mode,
        "setupWizardVersion": setup_wizard_version,
        "uiMode": ui_mode,
        "hasCompletedSetup": read_bool(&doc, "hasCompletedSetup", false),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn resolves_single_port_profiles_and_target_language() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        assert_eq!(get_configured_single_port(&config_path), 7275);
        assert_eq!(get_configured_target_language(&config_path), "ja");

        fs::write(
            &config_path,
            "\u{FEFF}{\"current_profile\":\"JP\",\"configs\":{\"Default\":{\"general\":{\"single_port\":7275}},\"JP\":{\"general\":{\"single_port\":8181,\"target_language\":\" ZH \"},\"scenes\":[\"Scene A\"]}}}",
        )
        .unwrap();

        assert_eq!(get_configured_single_port(&config_path), 8181);
        assert_eq!(get_configured_target_language(&config_path), "zh");
        let profiles = get_gsm_profile_names(&config_path);
        assert_eq!(profiles["currentProfile"], json!("JP"));
        assert_eq!(profiles["profileScenes"]["JP"], json!(["Scene A"]));
    }

    #[test]
    fn saves_learning_language_in_new_legacy_and_named_profiles() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        save_target_language(&path, "ko").unwrap();
        assert_eq!(read_object(&path).unwrap()["configs"]["Default"]["general"]["target_language"], "ko");
        for (before, pointer) in [
            (json!({"general":{"other":3},"extra":4}), "/general/target_language"),
            (json!({"current_profile":"Game","configs":{"Game":{"general":{"other":3}},"Default":{"general":{"target_language":"ja"}}}}), "/configs/Game/general/target_language"),
        ] {
            write_atomic(&path, &before).unwrap();
            save_target_language(&path, "yue").unwrap();
            let mut expected = before;
            let section = expected.pointer_mut(pointer.rsplit_once('/').unwrap().0).unwrap();
            section["target_language"] = json!("yue");
            assert_eq!(read_object(&path).unwrap(), expected);
            assert!(save_target_language(&path, "invalid").is_err());
            assert_eq!(read_object(&path).unwrap(), expected);
        }
        let damaged = r#"{"general":[]}"#;
        fs::write(&path, damaged).unwrap();
        assert!(save_target_language(&path, "fr").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), damaged);
    }

    #[test]
    fn syncs_python_locale_only_when_config_exists_and_value_differs() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        assert!(!sync_python_display_locale("ja", &config_path).unwrap());

        fs::write(&config_path, r#"{"locale":"en_us","other":true}"#).unwrap();
        assert!(sync_python_display_locale("ja", &config_path).unwrap());
        assert!(!sync_python_display_locale("ja", &config_path).unwrap());

        let updated = read_object(&config_path).unwrap();
        assert_eq!(updated["locale"], json!("ja_jp"));
        assert_eq!(updated["other"], json!(true));
    }

    #[test]
    fn desktop_settings_snapshot_uses_electron_defaults_when_empty() {
        let dir = tempdir().unwrap();
        let prefs = Preferences::new(dir.path());
        let config_path = dir.path().join("config.json");
        let snap = desktop_settings_snapshot(&prefs, &config_path).unwrap();
        assert_eq!(snap["singlePort"], json!(7275));
        assert_eq!(snap["locale"], json!("en"));
        assert_eq!(snap["theme"], json!("gsm-dark"));
        assert_eq!(snap["iconStyle"], json!("gsm"));
        assert_eq!(snap["databaseBackupEnabled"], json!(true));
        assert_eq!(snap["databaseBackupRetentionCount"], json!(2));
        assert_eq!(snap["textCaptureWizardEnabled"], json!(true));
        assert_eq!(snap["consoleMode"], json!("simple"));
        assert_eq!(snap["uiMode"], json!("basic"));
    }
}
