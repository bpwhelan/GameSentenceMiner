use serde_json::json;
use std::{path::Path, time::SystemTime};

#[derive(Default)]
pub(super) struct Profiles {
    resume: Option<String>,
    last: Option<(SystemTime, String)>,
    pub name: String,
    pub choices: Vec<String>,
}

impl Profiles {
    pub fn reconcile(
        &mut self,
        path: &Path,
        scene: &str,
        selection: Option<(&str, bool)>,
    ) -> Result<(), String> {
        let modified = || std::fs::metadata(path).ok()?.modified().ok();
        if selection.is_none()
            && self
                .last
                .as_ref()
                .is_some_and(|(stamp, last)| Some(*stamp) == modified() && last == scene)
        {
            return Ok(());
        }
        gsm_settings::with_lock(path, || {
            let mut data = gsm_settings::read_object(path)?;
            let configs = data["configs"]
                .as_object()
                .ok_or("No mining profiles configured")?;
            let current = data["current_profile"]
                .as_str()
                .filter(|s| configs.contains_key(*s))
                .unwrap_or("Default");
            let matches: Vec<String> = configs
                .iter()
                .filter(|(_, config)| {
                    !scene.is_empty()
                        && config["scenes"].as_array().is_some_and(|scenes| {
                            scenes
                                .iter()
                                .any(|s| s.as_str().is_some_and(|s| s.trim() == scene.trim()))
                        })
                })
                .map(|(name, _)| name.clone())
                .collect();
            let mut resume = self.resume.clone().filter(|s| configs.contains_key(s));
            let mut choices = Vec::new();
            let name = if let Some((name, manual)) = selection {
                if !configs.contains_key(name)
                    || (!manual && (resume.is_some() || !matches.iter().any(|s| s == name)))
                {
                    return Err("Profile selection is no longer available".into());
                }
                if manual && current != name {
                    if resume.as_deref() == Some(name) {
                        resume = None
                    } else if resume.is_none() {
                        resume = Some(current.to_owned())
                    }
                }
                name
            } else if resume.is_some() || scene.is_empty() || matches.iter().any(|s| s == current) {
                current
            } else if matches.len() == 1 {
                &matches[0]
            } else if matches.is_empty()
                && data["switch_to_default_if_not_found"] != false
                && configs.contains_key("Default")
            {
                "Default"
            } else {
                choices = matches.clone();
                current
            }
            .to_owned();
            if data["current_profile"] != name {
                data["current_profile"] = json!(name);
                gsm_settings::write_atomic(path, &data)?;
            }
            self.name = name;
            self.choices = choices;
            self.resume = resume;
            // Re-evaluate automatic selection on the tick following a manual resume.
            self.last = if selection.is_some() {
                None
            } else {
                modified().map(|t| (t, scene.to_owned()))
            };
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scene_matches_manual_pause_and_ambiguous_choice() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = dir.join("config.json");
        gsm_settings::write_atomic(&path,&json!({"current_profile":"Default","configs":{"Default":{},"A":{"scenes":["Game","Shared"]},"B":{"scenes":["Shared"]}}})).unwrap();
        let mut p = Profiles::default();
        p.reconcile(&path, "Shared", None).unwrap();
        assert_eq!(p.choices.len(), 2);
        p.reconcile(&path, "Shared", Some(("B", false))).unwrap();
        assert_eq!(p.name, "B");
        p.reconcile(&path, "Game", None).unwrap();
        assert_eq!(p.name, "A");
        p.reconcile(&path, "Game", Some(("B", true))).unwrap();
        p.reconcile(&path, "Missing", None).unwrap();
        assert_eq!(p.name, "B");
        p.reconcile(&path, "Missing", Some(("A", true))).unwrap();
        p.reconcile(&path, "Missing", None).unwrap();
        assert_eq!(p.name, "Default");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
