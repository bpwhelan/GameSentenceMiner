//! Setup onboarding progress schema and persistence.
use crate::preferences::Preferences;
use crate::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Value};

pub const ONBOARDING_VERSION: i64 = 2;
pub const ONBOARDING_STEPS: [&str; 5] = ["language", "dictionary", "game", "capture", "finish"];
pub const ONBOARDING_STATUSES: [&str; 3] = ["active", "paused", "completed"];

pub fn initial_onboarding_progress(existing_installation: bool) -> Value {
    json!({
        "version": ONBOARDING_VERSION,
        "step": "language",
        "status": if existing_installation { "paused" } else { "active" },
    })
}

pub fn normalize_onboarding_progress(value: &Value) -> Result<Value> {
    let Some(obj) = value.as_object() else {
        return Err("Invalid setup progress.".into());
    };
    let step = obj
        .get("step")
        .and_then(Value::as_str)
        .filter(|s| ONBOARDING_STEPS.contains(s))
        .ok_or_else(|| "Invalid setup progress.".to_string())?;
    let status = obj
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| ONBOARDING_STATUSES.contains(s))
        .ok_or_else(|| "Invalid setup progress.".to_string())?;
    Ok(json!({
        "version": ONBOARDING_VERSION,
        "step": step,
        "status": status,
    }))
}

pub fn get_or_init_onboarding(preferences: &Preferences) -> Result<Value> {
    let file = &preferences.file;
    with_lock(file, || {
        let mut document = read_object(file)?;
        if let Some(existing) = document.get("onboarding").filter(|v| !v.is_null()) {
            if let Ok(normalized) = normalize_onboarding_progress(existing) {
                return Ok(normalized);
            }
        }
        let has_completed = document
            .get("hasCompletedSetup")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let wizard_version = document
            .get("setupWizardVersion")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let initial = initial_onboarding_progress(has_completed || wizard_version > 0);
        if let Some(map) = document.as_object_mut() {
            map.insert("onboarding".into(), initial.clone());
        }
        write_atomic(file, &document)?;
        Ok(initial)
    })
}

pub fn save_onboarding(preferences: &Preferences, progress: &Value) -> Result<Value> {
    let normalized = normalize_onboarding_progress(progress)?;
    preferences.patch(&json!({ "onboarding": normalized.clone() }))?;
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn initializes_new_and_existing_installations_correctly() {
        let dir = tempdir().unwrap();
        let prefs = Preferences::new(dir.path());
        assert_eq!(
            get_or_init_onboarding(&prefs).unwrap(),
            json!({ "version": 2, "step": "language", "status": "active" })
        );

        let dir_existing = tempdir().unwrap();
        let prefs_existing = Preferences::new(dir_existing.path());
        prefs_existing
            .patch(&json!({ "hasCompletedSetup": true }))
            .unwrap();
        assert_eq!(
            get_or_init_onboarding(&prefs_existing).unwrap(),
            json!({ "version": 2, "step": "language", "status": "paused" })
        );
    }

    #[test]
    fn validates_and_persists_updates() {
        let dir = tempdir().unwrap();
        let prefs = Preferences::new(dir.path());
        assert!(normalize_onboarding_progress(&json!({ "step": "unknown", "status": "active" })).is_err());
        let saved = save_onboarding(
            &prefs,
            &json!({ "version": 1, "step": "capture", "status": "paused" }),
        )
        .unwrap();
        assert_eq!(
            saved,
            json!({ "version": 2, "step": "capture", "status": "paused" })
        );
        assert_eq!(get_or_init_onboarding(&prefs).unwrap(), saved);
    }
}
