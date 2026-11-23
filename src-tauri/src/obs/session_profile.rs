use serde_json::json;
use std::{path::Path, time::SystemTime};

#[derive(Default)]
pub(super) struct Profiles {
    #[cfg(windows)]
    pub(super) audio: super::game_audio::Preferences,
    pub settings: Option<super::policy::Settings>,
    resume: Option<String>,
    last: Option<(SystemTime, String, String)>,
    pub name: String,
    pub recycled_lines: bool,
    pub choices: Vec<String>,
}

impl Profiles {
    pub fn reconcile(
        &mut self,
        path: &Path,
        scene: &str,
        scene_id: &str,
        selection: Option<(&str, bool)>,
    ) -> Result<(), String> {
        let modified = || std::fs::metadata(path).ok()?.modified().ok();
        if selection.is_none()
            && self.last.as_ref().is_some_and(|(stamp, last, id)| {
                Some(*stamp) == modified() && last == scene && id == scene_id
            })
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
            let mut matches: Vec<String> = configs
                .iter()
                .filter(|(name, config)| {
                    if let Some(id) = gsm_settings::mining_scopes::scene_id(&data, name)
                        .filter(|_| !scene_id.is_empty())
                    {
                        return id == scene_id;
                    }
                    !scene.is_empty()
                        && config["scenes"].as_array().is_some_and(|scenes| {
                            scenes
                                .iter()
                                .any(|s| s.as_str().is_some_and(|s| s.trim() == scene.trim()))
                        })
                })
                .map(|(name, _)| name.clone())
                .collect();
            // A game-specific configuration takes precedence over a group binding.
            if matches
                .iter()
                .any(|n| gsm_settings::mining_scopes::parent(&data, n).is_some())
            {
                matches.retain(|n| gsm_settings::mining_scopes::parent(&data, n).is_some());
            }
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
            } else if resume.is_some() || matches.iter().any(|s| s == current) {
                current
            } else if let Some(base) =
                gsm_settings::mining_scopes::parent(&data, current).filter(|_| {
                    matches.is_empty()
                        && (scene.is_empty() || data["switch_to_default_if_not_found"] == false)
                })
            {
                base
            } else if scene.is_empty() {
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
            let renamed = !scene_id.is_empty()
                && !scene.is_empty()
                && gsm_settings::mining_scopes::scene_id(&data, &name) == Some(scene_id)
                && data["configs"][&name]["scenes"][0] != scene;
            if renamed {
                data["configs"][&name]["scenes"] = json!([scene]);
            }
            if renamed || data["current_profile"] != name {
                gsm_settings::mining_scopes::activate(&mut data, &name)?;
                gsm_settings::write_atomic(path, &data)?;
            }
            self.settings = Some(super::policy::Settings::from_profile(
                &data["configs"][&name],
            ));
            #[cfg(windows)]
            {
                self.audio = super::game_audio::Preferences::from_profile(&data["configs"][&name]);
            }
            self.recycled_lines = data["overlay"]
                .as_object()
                .or_else(|| data["configs"][&name]["overlay"].as_object())
                .and_then(|o| o.get("check_previous_lines_for_recycled_indicator"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            self.name = name;
            self.choices = choices;
            self.resume = resume;
            // Re-evaluate automatic selection on the tick following a manual resume.
            self.last = if selection.is_some() {
                None
            } else {
                modified().map(|t| (t, scene.to_owned(), scene_id.to_owned()))
            };
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_overrides_win_over_groups_and_follow_obs_renames() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let fixture = json!({"current_profile":"VN","switch_to_default_if_not_found":false,
            "configs":{"Default":{},"VN":{"scenes":["Game"]},"Custom":{"scenes":["Game"],"overlay":{"periodic":true}}},
            "profile_layers":{"version":1,"global":{},"scenes":{"Custom":{"parent":"VN","overrides":{},"sceneId":"one"}}}});
        gsm_settings::write_atomic(&path, &fixture).unwrap();
        let mut p = Profiles::default();
        p.reconcile(&path, "Game", "one", None).unwrap();
        assert_eq!(p.name, "Custom");
        assert_eq!(
            gsm_settings::read_object(&path).unwrap()["overlay"]["periodic"],
            true
        );
        p.reconcile(&path, "Renamed", "one", None).unwrap();
        assert_eq!(
            gsm_settings::read_object(&path).unwrap()["configs"]["Custom"]["scenes"],
            json!(["Renamed"])
        );
        p.reconcile(&path, "Renamed", "two", None).unwrap();
        assert_eq!(p.name, "VN");
    }
    #[test]
    fn scene_matches_manual_pause_and_ambiguous_choice() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = dir.join("config.json");
        gsm_settings::write_atomic(&path,&json!({"current_profile":"Default","configs":{"Default":{},"A":{"scenes":["Game","Shared"]},"B":{"scenes":["Shared"]}}})).unwrap();
        let mut p = Profiles::default();
        p.reconcile(&path, "Shared", "", None).unwrap();
        assert_eq!(p.choices.len(), 2);
        p.reconcile(&path, "Shared", "", Some(("B", false)))
            .unwrap();
        assert_eq!(p.name, "B");
        p.reconcile(&path, "Game", "", None).unwrap();
        assert_eq!(p.name, "A");
        p.reconcile(&path, "Game", "", Some(("B", true))).unwrap();
        p.reconcile(&path, "Missing", "", None).unwrap();
        assert_eq!(p.name, "B");
        p.reconcile(&path, "Missing", "", Some(("A", true)))
            .unwrap();
        p.reconcile(&path, "Missing", "", None).unwrap();
        assert_eq!(p.name, "Default");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
