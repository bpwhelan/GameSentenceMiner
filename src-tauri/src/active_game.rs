//! Tracks live backend `active_game_state` and foreground/emulator window updates.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveGameSnapshot {
    pub scene_name: String,
    pub active: Option<bool>,
    pub observed_at_ms: f64,
}

#[derive(Clone, Debug, Default)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct ForegroundSnapshot {
    pub hwnd: String,
    pub pid: u32,
    pub title: String,
    pub executable_name: String,
    pub observed_at: Option<Instant>,
}

#[derive(Default)]
struct State {
    active_game: Option<ActiveGameSnapshot>,
    #[cfg_attr(not(test), allow(dead_code))]
    updated_at: Option<Instant>,
}

#[derive(Default)]
pub struct ActiveGame {
    state: Mutex<State>,
}

impl ActiveGame {
    #[cfg(test)]
    pub fn has_snapshot(&self) -> bool {
        self.state.lock().unwrap().active_game.is_some()
    }

    #[cfg(test)]
    pub fn snapshot(&self) -> Option<ActiveGameSnapshot> {
        self.state.lock().unwrap().active_game.clone()
    }

    pub fn any_game_active(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .active_game
            .as_ref()
            .and_then(|s| s.active)
            == Some(true)
    }

    pub fn is_scene_active(&self, scene_name: &str) -> bool {
        let trimmed = scene_name.trim();
        if trimmed.is_empty() {
            return false;
        }
        let guard = self.state.lock().unwrap();
        let Some(ref snap) = guard.active_game else {
            return false;
        };
        snap.scene_name == trimmed && snap.active == Some(true)
    }

    pub fn update(&self, data: &Value) -> bool {
        let scene_name = data["sceneName"]
            .as_str()
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        let active = data["active"].as_bool();
        let observed_at_ms = data["observedAt"].as_f64().unwrap_or(0.0);
        let next = ActiveGameSnapshot {
            scene_name,
            active,
            observed_at_ms,
        };
        let mut guard = self.state.lock().unwrap();
        let changed = guard.active_game.as_ref().is_none_or(|prev| {
            prev.scene_name != next.scene_name || prev.active != next.active
        });
        guard.active_game = Some(next);
        guard.updated_at = Some(Instant::now());
        changed
    }

    #[cfg(test)]
    pub fn age_ms(&self) -> Option<u128> {
        self.state
            .lock()
            .unwrap()
            .updated_at
            .map(|at| at.elapsed().as_millis())
    }
}

pub fn parse_foreground_snapshot(data: &Value) -> Option<ForegroundSnapshot> {
    let obj = data.as_object()?;
    let pid = match obj.get("pid") {
        None | Some(Value::Null) => 0,
        Some(v) => u32::try_from(v.as_u64()?).ok().filter(|&p| p > 0)?,
    };
    let executable_name = obj
        .get("executableName")
        .or_else(|| obj.get("exeName"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if pid == 0 && executable_name.is_empty() && title.is_empty() {
        return None;
    }
    let hwnd = obj
        .get("hwnd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    Some(ForegroundSnapshot {
        hwnd,
        pid,
        title,
        executable_name,
        observed_at: Some(Instant::now()),
    })
}

/// Observe events emitted by `gsm-runtime` (`bus.message` -> `backend.event`).
pub fn observe(app: &tauri::AppHandle, event: &str, message: &Value) {
    if event != "bus.message"
        || message["src"] != "backend"
        || message["topic"] != "backend.event"
        || message["kind"] != "event"
    {
        return;
    }
    let function = message["data"]["function"].as_str().unwrap_or("");
    let data = &message["data"]["data"];
    match function {
        "active_game_state" => {
            use tauri::Manager;
            if let Some(state) = app.try_state::<ActiveGame>() {
                if state.update(data) {
                    crate::auto_launcher::notify_signal(app);
                }
            }
        }
        "foreground_window_changed" => {
            if let Some(snap) = parse_foreground_snapshot(data) {
                crate::auto_launcher::handle_foreground_changed(app, snap, false);
            }
        }
        "emulator_window_changed" => {
            if let Some(snap) = parse_foreground_snapshot(data) {
                crate::auto_launcher::handle_foreground_changed(app, snap, true);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn active_game_tracks_scene_and_snapshot_state() {
        let tracker = ActiveGame::default();
        assert!(!tracker.has_snapshot());
        assert!(!tracker.any_game_active());
        assert!(!tracker.is_scene_active("Clannad"));

        assert!(tracker.update(&json!({
            "sceneName": "Clannad",
            "active": true,
            "observedAt": 12345.0
        })));
        assert!(tracker.has_snapshot());
        assert!(tracker.any_game_active());
        assert!(tracker.is_scene_active("Clannad"));
        assert!(!tracker.is_scene_active("Air"));

        assert!(!tracker.update(&json!({
            "sceneName": "Clannad",
            "active": true,
            "observedAt": 12445.0
        })));
        assert!(tracker.update(&json!({
            "sceneName": "Clannad",
            "active": false,
            "observedAt": 12545.0
        })));
        assert!(!tracker.any_game_active());
        assert!(!tracker.is_scene_active("Clannad"));
        assert_eq!(tracker.snapshot().unwrap().scene_name, "Clannad");
        assert!(tracker.age_ms().is_some());
    }

    #[test]
    fn parses_foreground_and_emulator_payloads() {
        let snap = parse_foreground_snapshot(&json!({
            "hwnd": "0x1234",
            "pid": 4242,
            "title": "eden | Clannad",
            "executableName": "eden.exe"
        }))
        .expect("foreground payload parses");
        assert_eq!(snap.hwnd, "0x1234");
        assert_eq!(snap.pid, 4242);
        assert_eq!(snap.executable_name, "eden.exe");
        assert_eq!(snap.title, "eden | Clannad");
        assert!(snap.observed_at.is_some());
        assert!(parse_foreground_snapshot(&json!({"pid": -1})).is_none());
        assert!(parse_foreground_snapshot(&json!({"pid": 0})).is_none());
        assert!(parse_foreground_snapshot(&json!({})).is_none());
    }
}
