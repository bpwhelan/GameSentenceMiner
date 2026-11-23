#[cfg(test)]
use crate::write_atomic;
use crate::Result;
use serde_json::{json, Value};
use std::path::Path;

/// Apply only edits made in the settings window. OBS can select another profile
/// and other desktop controls can update unrelated fields while the window is open.
pub fn save_edits(path: &Path, before: &Value, after: &Value) -> Result<()> {
    save(path, before, after, false)
}

/// A standalone Python editor may also explicitly switch the active profile.
pub fn save_standalone_edits(path: &Path, before: &Value, after: &Value) -> Result<()> {
    save(path, before, after, true)
}

fn save(path: &Path, before: &Value, after: &Value, allow_switch: bool) -> Result<()> {
    if !before["configs"].is_object() || after["configs"].as_object().is_none_or(|p| p.is_empty()) {
        return Err("Expected a mining profile collection".into());
    }
    if before == after {
        return Ok(());
    }
    crate::mining_scopes::update(path, |current| {
        let selected = if allow_switch && before["current_profile"] != after["current_profile"] {
            after["current_profile"].clone()
        } else {
            current["current_profile"].clone()
        };
        let version = current["version"].clone();
        merge(current, before, after)?;
        let profiles = current["configs"]
            .as_object()
            .ok_or("Invalid mining profiles")?;
        let selected = [
            selected.as_str(),
            after["current_profile"].as_str(),
            Some("Default"),
        ]
        .into_iter()
        .flatten()
        .find(|name| profiles.contains_key(*name))
        .ok_or("No active mining profile")?;
        current["current_profile"] = json!(selected);
        current["version"] = version;
        Ok(())
    })
}

pub(crate) fn merge(current: &mut Value, before: &Value, after: &Value) -> Result<()> {
    if before == after {
        return Ok(());
    }
    let (Some(old), Some(next)) = (before.as_object(), after.as_object()) else {
        if current != before && current != after {
            return Err("Setting changed while editing. Reload the form.".into());
        }
        *current = after.clone();
        return Ok(());
    };
    let dest = current
        .as_object_mut()
        .ok_or("Settings changed while editing. Reopen the settings window.")?;
    for (key, old_value) in old {
        match next.get(key) {
            Some(value) if value == old_value => {}
            Some(value) => {
                if let Some(field) = dest.get_mut(key) {
                    merge(field, old_value, value)?;
                } else if old_value.is_object() {
                    return Err(format!("Setting '{key}' was removed while editing"));
                } else {
                    // The editor materializes missing scalar defaults in memory.
                    dest.insert(key.clone(), value.clone());
                }
            }
            None => {
                if dest.get(key).is_some_and(|value| value != old_value) {
                    return Err(format!("Setting '{key}' changed while editing"));
                }
                dest.remove(key);
            }
        }
    }
    for (key, value) in next.iter().filter(|(k, _)| !old.contains_key(*k)) {
        if dest.get(key).is_some_and(|other| other != value) {
            return Err(format!("Setting '{key}' was added while editing"));
        }
        dest.insert(key.clone(), value.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_edits_can_set_an_implicit_default_but_cannot_restore_a_deleted_profile() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        let before = json!({"configs":{"Default":{},"Other":{"anki":{"enabled":true}}},"experimental":{"enable_tokenization":false}});
        let mut current = before.clone();
        current["configs"].as_object_mut().unwrap().remove("Other");
        current["experimental"] = json!({});
        write_atomic(&path, &current).unwrap();
        let mut edited = before.clone();
        edited["experimental"]["enable_tokenization"] = json!(true);
        save_edits(&path, &before, &edited).unwrap();
        let saved = crate::read_object(&path).unwrap();
        assert_eq!(saved["experimental"]["enable_tokenization"], true);
        edited["configs"]["Other"]["anki"]["enabled"] = json!(false);
        assert!(save_edits(&path, &before, &edited).is_err());
        assert_eq!(crate::read_object(&path).unwrap(), saved);
    }
    #[test]
    fn gui_save_preserves_external_edits_selection_and_unknown_fields() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        let before = json!({"current_profile":"A","configs":{"A":{"anki":{"word":"Word","deck":"old"}},"B":{}}});
        let mut current = before.clone();
        current["current_profile"] = json!("B");
        current["configs"]["A"]["anki"]["deck"] = json!("other");
        current["configs"]["A"]["anki"]["custom"] = json!([4, 3]);
        current["configs"]["C"] = json!({});
        current["version"] = json!("2026.11.0");
        write_atomic(&path, &current).unwrap();
        let mut edited = before.clone();
        edited["configs"]["A"]["anki"]["word"] = json!("Expression");
        save_edits(&path, &before, &edited).unwrap();
        current["configs"]["A"]["anki"]["word"] = json!("Expression");
        assert_eq!(crate::read_object(&path).unwrap(), current);
        save_edits(&path, &before, &edited).unwrap();
        assert_eq!(crate::read_object(&path).unwrap(), current);
    }
}
