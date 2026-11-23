//! Settings used by the mining workspace, independent of the application service.
use crate::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Workspace {
    base: PathBuf,
}
impl Workspace {
    pub fn new(base: &Path) -> Self {
        Self { base: base.into() }
    }
    pub fn text(&self) -> Result<Value> {
        self.text_and_language().map(|(text, _)| text)
    }
    pub fn named_text(&self) -> Result<Value> {
        let doc = read_object(&self.base.join("config.json"))?;
        let name = doc["current_profile"]
            .as_str()
            .ok_or("No active profile found")?;
        Ok(json!({"name":name,"config":Self::text_settings(&doc).0}))
    }

    /// Flush a debounced edit to the profile that supplied the form, even if
    /// OBS has switched games since. Only commit the edited leaves.
    #[cfg(feature = "profile-upgrade")]
    pub fn save_named_text(&self, name: &str, before: &Value, after: &Value) -> Result<()> {
        if !before.is_object() || !after.is_object() {
            return Err("Invalid text settings".into());
        }
        let file = self.base.join("config.json");
        crate::mining_scopes::update(&file, |doc| {
            let profile = doc["configs"]
                .get_mut(name)
                .ok_or("Profile no longer exists")?;
            if profile["text_processing"].is_null() {
                profile["text_processing"] = text_defaults();
            }
            crate::profile_editor::merge(&mut profile["text_processing"], before, after)
        })
    }
    /// Read both settings from one revision of the active mining profile.
    pub fn text_and_language(&self) -> Result<(Value, String)> {
        let document = read_object(&self.base.join("config.json"))?;
        Ok(Self::text_settings(&document))
    }
    pub fn text_settings(document: &Value) -> (Value, String) {
        let text = crate::gsm_config::active_profile(document)
            .and_then(|p| p.get("text_processing"))
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(text_defaults);
        (
            text,
            crate::gsm_config::target_language_from_config(document),
        )
    }
    pub fn target_language(&self) -> Result<String> {
        let document = read_object(&self.base.join("config.json"))?;
        Ok(crate::gsm_config::target_language_from_config(&document))
    }
    pub fn save_text(&self, patch: &Value) -> Result<()> {
        if !patch.is_object() {
            return Err("Text processing settings must be an object".into());
        }
        let file = self.base.join("config.json");
        crate::mining_scopes::update(&file, |document| {
            let name = document["current_profile"]
                .as_str()
                .ok_or("No active profile found")?
                .to_owned();
            let profile = document
                .get_mut("configs")
                .and_then(|p| p.get_mut(&name))
                .filter(|p| p.is_object())
                .ok_or("No active profile found")?;
            merge(&mut profile["text_processing"], patch);
            Ok(())
        })
    }
    pub fn speech_path(&self, scene: &Value) -> Result<PathBuf> {
        let scene = normalize_scene(scene)?;
        let clean = |value: &str| {
            value
                .chars()
                .filter(|c| !c.is_ascii_control() && !" <>:\"/\\|?*".contains(*c))
                .collect::<String>()
        };
        let mut name = clean(scene["id"].as_str().unwrap());
        if name.is_empty() {
            name = clean(scene["name"].as_str().unwrap());
        }
        if name.is_empty() {
            name = "scene".into();
        }
        Ok(self
            .base
            .join("windows_speech_config")
            .join(format!("{name}.json")))
    }
    pub fn speech(&self, scene: &Value) -> Result<Value> {
        let scene = normalize_scene(scene)?;
        let file = self.speech_path(&scene)?;
        let exists = file.try_exists().map_err(|e| e.to_string())?;
        let saved = read_object(&file)?;
        Ok(
            json!({"success":true,"exists":exists,"scene":scene,"settings":speech_settings(&saved["settings"]),"configPath":file}),
        )
    }
    pub fn save_speech(&self, scene: &Value, settings: &Value) -> Result<Value> {
        let scene = normalize_scene(scene)?;
        let file = self.speech_path(&scene)?;
        with_lock(&file, || {
            let mut saved = read_object(&file)?;
            if saved.get("version").is_some_and(|v| v != 1) {
                return Err("Unsupported speech settings version".into());
            }
            saved["version"] = json!(1);
            merge(&mut saved["scene"], &scene);
            merge(&mut saved["settings"], &speech_settings(settings));
            write_atomic(&file, &saved)
        })?;
        Ok(json!({"success":true,"scene":scene,"configPath":file}))
    }
    fn exclusions_document(&self) -> Result<Value> {
        let path = self.base.join("sentence_exclusions.json");
        if !path.try_exists().map_err(|e| e.to_string())? {
            return Ok(json!({"version":1,"games":{}}));
        }
        let document = read_object(&path)?;
        if document["version"] != 1
            || !document["games"].as_object().is_some_and(|games| {
                games.values().all(|v| {
                    v.as_array()
                        .is_some_and(|entries| entries.iter().all(Value::is_string))
                })
            })
        {
            return Err("Invalid sentence exclusions file".into());
        }
        Ok(document)
    }
    pub fn exclusions(&self) -> Result<Value> {
        Ok(self.exclusions_document()?["games"].clone())
    }
    pub fn change_exclusion(&self, game: &str, text: &str, add: bool) -> Result<Value> {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let text = text.trim();
        if game.trim().is_empty() || text.is_empty() {
            return Err("Game and sentence are required".into());
        }
        with_lock(&self.base.join("sentence_exclusions.json"), || {
            let mut document = self.exclusions_document()?;
            let games = document["games"].as_object_mut().unwrap();
            let entries = games
                .entry(game)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .unwrap();
            if add {
                if !entries.iter().any(|v| v == text) {
                    entries.push(json!(text));
                }
            } else {
                entries.retain(|v| v != text);
            }
            if entries.is_empty() {
                games.remove(game);
            }
            write_atomic(&self.base.join("sentence_exclusions.json"), &document)?;
            Ok(document["games"].clone())
        })
    }
}
fn merge(target: &mut Value, patch: &Value) {
    if let Some(fields) = patch.as_object() {
        if !target.is_object() {
            *target = json!({});
        }
        for (key, value) in fields {
            merge(&mut target[key], value);
        }
    } else {
        *target = patch.clone();
    }
}
pub fn normalize_scene(scene: &Value) -> Result<Value> {
    let id = scene["id"].as_str().unwrap_or("").trim();
    let name = scene["name"].as_str().unwrap_or("").trim();
    if id.is_empty() || name.is_empty() {
        return Err("A valid OBS scene is required.".into());
    }
    Ok(json!({"id":id,"name":name}))
}
pub fn speech_settings(settings: &Value) -> Value {
    let string = |key| settings[key].as_str().unwrap_or("").trim();
    json!({"backend":if string("backend").eq_ignore_ascii_case("sapi") {"sapi"} else {"embedded"},
        "language":if string("language").to_lowercase().starts_with("en") {"en"} else {"ja"},
        "modelPath":string("modelPath"),"runtimePath":string("runtimePath"),"licenseFile":string("licenseFile")})
}
pub fn text_defaults() -> Value {
    json!({"string_replacement":{"enabled":false,"rules":[]},
        "processor_order":["string_replacement","remove_repeated_chars","remove_repeated_lines","remove_control_chars","language_filter","remove_non_japanese","remove_newlines","remove_numbers","remove_english","remove_curly_braces","remove_angle_brackets","extract_bracketed_text","extract_lines","unicode_normalize"],
        "remove_repeated_chars":false,"remove_repeated_chars_config":{"repeat_count":1,"keep_non_repeated":true},
        "remove_repeated_lines_v2":true,"remove_repeated_lines_config":{"repeat_count":1},"remove_control_chars":true,
        "language_filter":false,"language_filter_config":{"mode":"blocks"},"remove_non_japanese":false,"remove_newlines":false,
        "remove_numbers":false,"remove_english":false,"remove_curly_braces":false,"remove_angle_brackets":false,
        "extract_bracketed_text":false,"extract_lines":false,"extract_lines_config":{"max_lines":3,"from_end":true},
        "unicode_normalize":false,"unicode_normalize_config":{"form":"NFKC"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn preserves_profiles_and_unknown_settings_and_reads_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let store = Workspace::new(temp.path());
        assert_eq!(store.text().unwrap()["remove_control_chars"], true);
        assert!(store.save_text(&json!({})).is_err());
        let file = temp.path().join("config.json");
        let document = json!({"current_profile":"Game","unknown":5,"configs":{"Other":{"secret":1},"Game":{"general":{"target_language":"en"},"unknown":6,"text_processing":{"remove_control_chars":false,"extension":{"enabled":true},"string_replacement":{"future":7}}}}});
        fs::write(&file, format!("\u{feff}{}", document)).unwrap();
        let before = fs::read(&file).unwrap();
        assert_eq!(store.text().unwrap()["remove_control_chars"], false);
        assert_eq!(store.target_language().unwrap(), "en");
        assert_eq!(fs::read(&file).unwrap(), before);
        store
            .save_text(&json!({"remove_numbers":true,"string_replacement":{"enabled":true}}))
            .unwrap();
        let saved = read_object(&file).unwrap();
        assert_eq!(saved["configs"]["Other"], document["configs"]["Other"]);
        assert_eq!(saved["configs"]["Game"]["unknown"], 6);
        assert_eq!(
            saved["configs"]["Game"]["text_processing"]["string_replacement"]["future"],
            7
        );
        fs::write(&file, "{broken").unwrap();
        assert!(store.text().is_err());
        assert!(store.save_text(&json!({})).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "{broken");
    }
    #[test]
    fn speech_keeps_scene_identity_saved_choices_and_unknown_fields() {
        let temp = tempfile::tempdir().unwrap();
        let store = Workspace::new(temp.path());
        let a = json!({"id":"scene-a","name":"Game"});
        let b = json!({"id":"scene-b","name":"Game"});
        assert_ne!(
            store.speech_path(&a).unwrap(),
            store.speech_path(&b).unwrap()
        );
        assert_eq!(store.speech(&a).unwrap()["exists"], false);
        let path = store.speech_path(&a).unwrap();
        write_atomic(&path,&json!({"version":1,"other":7,"scene":{"future":9},"settings":{"future":1,"backend":"SAPI","language":"en-US"}})).unwrap();
        assert_eq!(store.speech(&a).unwrap()["settings"]["backend"], "sapi");
        assert_eq!(store.speech(&a).unwrap()["settings"]["language"], "en");
        store
            .save_speech(&a, &json!({"backend":"embedded","modelPath":" model "}))
            .unwrap();
        let saved = read_object(&path).unwrap();
        assert_eq!(saved["other"], 7);
        assert_eq!(saved["settings"]["future"], 1);
        assert_eq!(saved["settings"]["modelPath"], "model");
        assert_eq!(saved["scene"]["id"], a["id"]);
        assert_eq!(saved["scene"]["name"], a["name"]);
        assert_eq!(saved["scene"]["future"], 9);
        fs::write(&path, "bad").unwrap();
        assert!(store.save_speech(&a, &json!({})).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "bad");
        assert!(store.speech(&json!({"id":""})).is_err());
    }
    #[test]
    fn exclusions_are_exact_serialized_and_corruption_safe() {
        let temp = tempfile::tempdir().unwrap();
        let store = Workspace::new(temp.path());
        let mut threads = vec![];
        for text in ["first", "second", "first"] {
            let store = store.clone();
            threads.push(std::thread::spawn(move || {
                store.change_exclusion("Game", text, true).unwrap()
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(
            store.exclusions().unwrap()["Game"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        store
            .change_exclusion("__proto__", "  Menu\r\ntext  ", true)
            .unwrap();
        assert_eq!(
            store.exclusions().unwrap()["__proto__"],
            json!(["Menu\ntext"])
        );
        store.change_exclusion("Game", "first", false).unwrap();
        assert_eq!(store.exclusions().unwrap()["Game"], json!(["second"]));
        assert!(store.change_exclusion("Game", " ", true).is_err());
        let file = temp.path().join("sentence_exclusions.json");
        fs::write(&file, "{broken").unwrap();
        assert!(store.change_exclusion("Game", "x", true).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "{broken");
    }
}
