use crate::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Value};
use std::path::PathBuf;

pub struct Profiles {
    pub file: PathBuf,
}
impl Profiles {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            file: root.into().join("texthook/profiles.json"),
        }
    }
    pub fn list(&self) -> Result<Value> {
        Ok(normalized(&read_object(&self.file)?))
    }
    pub fn get(&self, exe: &str, scene: Option<&str>) -> Result<Value> {
        let all = self.list()?;
        Ok(all
            .get(key(exe, scene))
            .or_else(|| all.get(key(exe, None)))
            .cloned()
            .unwrap_or(Value::Null))
    }
    pub fn upsert(&self, patch: Value) -> Result<Value> {
        let exe = patch["exeName"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or("Missing profile executable")?;
        let target = key(exe, patch["sceneId"].as_str());
        with_lock(&self.file, || {
            let mut all = read_object(&self.file)?;
            let map = all.as_object_mut().unwrap();
            // Preserve legacy key spelling and all fields not changed by this edit.
            let existing = map
                .keys()
                .find(|k| k.to_lowercase() == target)
                .cloned()
                .unwrap_or(target);
            let mut value = map
                .get(&existing)
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or(json!({}));
            for (key, field) in patch.as_object().ok_or("Expected profile object")? {
                value[key] = field.clone();
            }
            value["exeName"] = json!(exe.trim().to_lowercase());
            value["flushDelayMs"] = json!(delay(&value["flushDelayMs"]));
            value["lastUsed"] = json!(now());
            map.insert(existing, value.clone());
            write_atomic(&self.file, &all)?;
            Ok(normalize(&value).unwrap())
        })
    }
    pub fn delete(&self, exe: &str, scene: Option<&str>) -> Result<()> {
        let target = key(exe, scene);
        with_lock(&self.file, || {
            let mut all = read_object(&self.file)?;
            all.as_object_mut()
                .unwrap()
                .retain(|k, _| k.to_lowercase() != target);
            write_atomic(&self.file, &all)
        })
    }
}
fn key(exe: &str, scene: Option<&str>) -> String {
    match scene.map(str::trim).filter(|s| !s.is_empty()) {
        Some(scene) => format!("scene:{}", scene.to_lowercase()),
        None => exe.trim().to_lowercase(),
    }
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn delay(value: &Value) -> u64 {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(100.0)
        .round()
        .clamp(0.0, 5000.0) as u64
}
fn normalized(all: &Value) -> Value {
    Value::Object(
        all.as_object()
            .unwrap()
            .iter()
            .filter_map(|(key, value)| normalize(value).map(|v| (key.to_lowercase(), v)))
            .collect(),
    )
}
pub fn normalize(value: &Value) -> Option<Value> {
    let exe = value["exeName"].as_str()?.trim();
    if exe.is_empty() {
        return None;
    }
    let mut result = value.clone();
    result["exeName"] = json!(exe.to_lowercase());
    let engine = match value["engine"].as_str() {
        Some("agent") => "agent",
        Some("textractor") => "textractor",
        Some("mages") => "mages",
        _ => "luna",
    };
    result["engine"] = json!(engine);
    result["autoHook"] = json!(value["autoHook"] != false);
    result["flushDelayMs"] = json!(delay(&value["flushDelayMs"]));
    for field in [
        "hookId",
        "hookFunction",
        "manualHookCode",
        "agentScriptPath",
    ] {
        result[field] = value[field]
            .as_str()
            .map(|s| {
                json!(if matches!(field, "manualHookCode" | "agentScriptPath") {
                    s.trim()
                } else {
                    s
                })
            })
            .unwrap_or(Value::Null);
    }
    result["agentDetached"] = json!(engine == "agent" && value["agentDetached"] != false);
    result["copyToClipboard"] = json!(value["copyToClipboard"] == true);
    result["lastUsed"] = value["lastUsed"]
        .as_u64()
        .map_or(json!(now()), |v| json!(v));
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_lookup_falls_back_to_legacy_executable_profile() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = Profiles::new(dir.path());
        profiles
            .upsert(json!({"exeName":"Game.EXE", "engine":"agent", "agentScriptPath":"game.js"}))
            .unwrap();
        assert_eq!(
            profiles.get("GAME.exe", Some("new-scene")).unwrap()["agentScriptPath"],
            "game.js"
        );
        profiles.upsert(json!({"exeName":"game.exe", "sceneId":"New-Scene", "engine":"luna", "autoHook":false})).unwrap();
        let scene = profiles.get("game.exe", Some("NEW-SCENE")).unwrap();
        assert_eq!(scene["engine"], "luna");
        assert_eq!(scene["autoHook"], false);
    }
}
