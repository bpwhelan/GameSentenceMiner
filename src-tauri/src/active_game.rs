//! Foreground and emulator notifications for desktop automation.
use serde_json::Value;
use std::time::Instant;

#[derive(Clone, Debug, Default)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct ForegroundSnapshot {
    pub hwnd: String,
    pub pid: u32,
    pub title: String,
    pub executable_name: String,
    pub observed_at: Option<Instant>,
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
