//! Native agent restart coordinator (`agent-control.json` + countdown + OS toast).
// Wired onto the native runtime message bus in Slice 6.
#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const AGENT_RESTART_ARG: &str = "--gsm-agent-restarted=";
const MIN_DELAY_SECONDS: u64 = 5;
const MAX_DELAY_SECONDS: u64 = 300;
const DEFAULT_DELAY_SECONDS: u64 = 30;
const MAX_REASON_LEN: usize = 300;
pub const AGENT_RESTART_NOTIFICATION_ID: i64 = 900_001;

pub fn parse_agent_restart_id<'a, I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    args.into_iter()
        .find_map(|arg| arg.strip_prefix(AGENT_RESTART_ARG))
        .map(str::to_owned)
}

pub fn agent_relaunch_args(args: &[String], request_id: &str) -> Vec<String> {
    let mut out: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with(AGENT_RESTART_ARG))
        .cloned()
        .collect();
    out.push(format!("{AGENT_RESTART_ARG}{request_id}"));
    out
}

pub fn validate_restart_request(data: &Value) -> Result<(u64, String), String> {
    let obj = data
        .as_object()
        .ok_or_else(|| "Restart options must be an object.".to_string())?;

    let delay_seconds = match obj.get("delaySeconds") {
        None | Some(Value::Null) => DEFAULT_DELAY_SECONDS,
        Some(v) => {
            let n = v.as_u64().filter(|_| v.is_u64()).ok_or_else(|| {
                "The warning delay must be a whole number from 5 to 300 seconds.".to_string()
            })?;
            if !(MIN_DELAY_SECONDS..=MAX_DELAY_SECONDS).contains(&n) {
                return Err(
                    "The warning delay must be a whole number from 5 to 300 seconds.".into(),
                );
            }
            n
        }
    };

    let reason = match obj.get("reason") {
        None | Some(Value::Null) => "New changes are ready to try.".to_owned(),
        Some(v) => {
            let s = v.as_str().ok_or_else(|| {
                "The restart reason must contain 1 to 300 characters.".to_string()
            })?;
            let trimmed = s.trim();
            if trimmed.is_empty() || s.len() > MAX_REASON_LEN {
                return Err("The restart reason must contain 1 to 300 characters.".into());
            }
            trimmed.to_owned()
        }
    };

    Ok((delay_seconds, reason))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBusConnection {
    pub port: u16,
    pub token: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentControlDescriptor {
    pub version: u32,
    pub instance_id: String,
    pub pid: u32,
    pub app_path: String,
    pub is_packaged: bool,
    pub restart_id: Option<String>,
    pub cancelled_restart_id: Option<String>,
    pub port: u16,
    pub token: String,
    pub path: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRestartReservation {
    pub request_id: String,
    pub restart_at: u64,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

#[derive(Default)]
struct PendingRestart {
    request_id: String,
    restart_at: u64,
    reason: String,
    started: bool,
    cancelled: bool,
    early_requested: bool,
    timer_armed: bool,
    abort_timer: Option<tokio::sync::watch::Sender<bool>>,
}

struct AgentControlInner {
    descriptor: AgentControlDescriptor,
    disposed: bool,
    pending: Option<PendingRestart>,
}

pub struct AgentControl {
    filename: PathBuf,
    inner: Arc<Mutex<AgentControlInner>>,
}

impl AgentControl {
    pub fn new(
        user_data_path: &Path,
        app_path: String,
        is_packaged: bool,
        restart_id: Option<String>,
        connection: AgentBusConnection,
    ) -> Self {
        let filename = user_data_path.join("agent-control.json");
        let descriptor = AgentControlDescriptor {
            version: 1,
            instance_id: uuid::Uuid::new_v4().to_string(),
            pid: std::process::id(),
            app_path,
            is_packaged,
            restart_id,
            cancelled_restart_id: None,
            port: connection.port,
            token: connection.token,
            path: connection.path,
            error: None,
        };
        let control = Self {
            filename,
            inner: Arc::new(Mutex::new(AgentControlInner {
                descriptor,
                disposed: false,
                pending: None,
            })),
        };
        let _ = control.save();
        control
    }

    pub fn filename(&self) -> &Path {
        &self.filename
    }

    pub fn save(&self) -> Result<(), String> {
        let descriptor = {
            let guard = self.inner.lock().unwrap();
            guard.descriptor.clone()
        };
        write_descriptor_atomic(&self.filename, &descriptor)
    }

    pub fn status(&self, ready: bool, blocked_reason: Option<String>) -> Value {
        let guard = self.inner.lock().unwrap();
        let d = &guard.descriptor;
        let restarting = guard.pending.is_some();
        let blocked = if guard.disposed {
            Some("GSM is shutting down.".to_owned())
        } else {
            blocked_reason
        };
        json!({
            "instanceId": d.instance_id,
            "pid": d.pid,
            "appPath": d.app_path,
            "isPackaged": d.is_packaged,
            "restartId": d.restart_id,
            "cancelledRestartId": d.cancelled_restart_id,
            "ready": !guard.disposed && !restarting && d.error.is_none() && ready,
            "restarting": restarting,
            "blockedReason": blocked,
            "error": d.error,
        })
    }

    pub fn fail(&self, reason: &str) {
        let descriptor = {
            let mut guard = self.inner.lock().unwrap();
            if let Some(mut pending) = guard.pending.take() {
                if let Some(tx) = pending.abort_timer.take() {
                    let _ = tx.send(true);
                }
            }
            guard.descriptor.error = Some(reason.to_owned());
            guard.descriptor.clone()
        };
        let _ = write_descriptor_atomic(&self.filename, &descriptor);
    }

    /// Reserves a restart countdown slot before displaying the OS toast so
    /// concurrent requests coalesce onto one countdown/notification.
    pub fn reserve_restart(
        &self,
        data: &Value,
        blocked_reason: Option<&str>,
    ) -> Result<(AgentRestartReservation, bool), String> {
        let (delay_seconds, reason) = validate_restart_request(data)?;
        let (already_pending, descriptor) = {
            let mut guard = self.inner.lock().unwrap();
            if guard.disposed {
                return Err("GSM is shutting down.".into());
            }
            if let Some(blocked) = blocked_reason {
                return Err(blocked.to_owned());
            }
            if let Some(existing) = &guard.pending {
                return Ok((
                    AgentRestartReservation {
                        request_id: existing.request_id.clone(),
                        restart_at: existing.restart_at,
                        reason: existing.reason.clone(),
                        cancelled: existing.cancelled.then_some(true),
                    },
                    false,
                ));
            }
            let request_id = uuid::Uuid::new_v4().to_string();
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let restart_at = now_ms + delay_seconds * 1000;
            guard.descriptor.error = None;
            guard.descriptor.cancelled_restart_id = None;
            guard.pending = Some(PendingRestart {
                request_id: request_id.clone(),
                restart_at,
                reason: reason.clone(),
                ..Default::default()
            });
            (
                AgentRestartReservation {
                    request_id,
                    restart_at,
                    reason,
                    cancelled: None,
                },
                guard.descriptor.clone(),
            )
        };
        write_descriptor_atomic(&self.filename, &descriptor)?;
        Ok((already_pending, true))
    }

    pub fn mark_restart_early(&self, request_id: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if guard.disposed {
            return false;
        }
        let Some(pending) = guard.pending.as_mut() else {
            return false;
        };
        if pending.request_id != request_id || pending.started || pending.cancelled {
            return false;
        }
        pending.early_requested = true;
        if pending.timer_armed {
            pending.started = true;
            if let Some(tx) = pending.abort_timer.take() {
                let _ = tx.send(true);
            }
            true
        } else {
            false
        }
    }

    pub fn cancel_restart(&self, request_id: &str) -> bool {
        let descriptor = {
            let mut guard = self.inner.lock().unwrap();
            if guard.disposed {
                return false;
            }
            let Some(pending) = guard.pending.as_mut() else {
                return false;
            };
            if pending.request_id != request_id || pending.started || pending.cancelled {
                return false;
            }
            pending.cancelled = true;
            if let Some(tx) = pending.abort_timer.take() {
                let _ = tx.send(true);
            }
            guard.descriptor.cancelled_restart_id = Some(request_id.to_owned());
            guard.pending = None;
            guard.descriptor.clone()
        };
        let _ = write_descriptor_atomic(&self.filename, &descriptor);
        true
    }

    pub fn arm_timer(
        &self,
        request_id: &str,
        tx: tokio::sync::watch::Sender<bool>,
    ) -> Result<(bool, bool), String> {
        let mut guard = self.inner.lock().unwrap();
        if guard.disposed {
            return Err("GSM shut down while displaying the restart warning.".into());
        }
        let Some(pending) = guard.pending.as_mut() else {
            return Ok((false, true));
        };
        if pending.request_id != request_id {
            return Ok((false, pending.cancelled));
        }
        if pending.cancelled {
            return Ok((false, true));
        }
        if pending.early_requested {
            pending.started = true;
            return Ok((true, false));
        }
        pending.timer_armed = true;
        pending.abort_timer = Some(tx);
        Ok((false, false))
    }

    pub fn clear_pending_if_unshown(&self, request_id: &str) {
        let mut guard = self.inner.lock().unwrap();
        if guard
            .pending
            .as_ref()
            .is_some_and(|p| p.request_id == request_id && !p.timer_armed)
        {
            guard.pending = None;
        }
    }

    pub fn dispose(&self) {
        let (instance_id, has_error) = {
            let mut guard = self.inner.lock().unwrap();
            if guard.disposed {
                return;
            }
            guard.disposed = true;
            if let Some(mut pending) = guard.pending.take() {
                if let Some(tx) = pending.abort_timer.take() {
                    let _ = tx.send(true);
                }
            }
            (
                guard.descriptor.instance_id.clone(),
                guard.descriptor.error.is_some(),
            )
        };

        if !has_error {
            if let Ok(raw) = fs::read_to_string(&self.filename) {
                if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                    if val.get("instanceId").and_then(Value::as_str) == Some(instance_id.as_str()) {
                        let _ = fs::remove_file(&self.filename);
                    }
                }
            }
        }
    }
}

pub fn build_restart_notification_payload(
    icon_path: Option<&Path>,
    reason: &str,
    seconds: u64,
) -> Value {
    json!({
        "id": AGENT_RESTART_NOTIFICATION_ID,
        "icon": icon_path.map(|p| p.to_string_lossy().into_owned()),
        "title": "GSM restarting soon",
        "body": format!("GSM will restart in {seconds} seconds to load new changes.\n{reason}"),
        "silent": false,
        "timeoutType": "never",
        "actions": [
            { "type": "button", "text": "Restart Now" },
            { "type": "button", "text": "Cancel Restart" },
        ]
    })
}

pub fn show_restart_warning_toast(
    app: &tauri::AppHandle,
    reason: &str,
    seconds: u64,
) -> Result<(), String> {
    let icon = crate::app_identity::current_window_icon_path(app);
    let payload = build_restart_notification_payload(
        icon.is_file().then_some(icon.as_path()),
        reason,
        seconds,
    );
    #[cfg(windows)]
    {
        crate::windows_notifications::apply(app, &payload, false)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, payload);
        Ok(())
    }
}

pub fn close_restart_warning_toast(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        let _ = crate::windows_notifications::apply(
            app,
            &json!({ "id": AGENT_RESTART_NOTIFICATION_ID }),
            true,
        );
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
    let _ = Duration::from_secs(0);
}

fn write_descriptor_atomic(filename: &Path, descriptor: &AgentControlDescriptor) -> Result<(), String> {
    if let Some(parent) = filename.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = filename.with_extension(format!("json.{}.tmp", descriptor.instance_id));
    let bytes = serde_json::to_vec(descriptor).map_err(|e| e.to_string())?;
    let write_res = write_private_file(&tmp, &bytes).and_then(|()| {
        fs::rename(&tmp, filename).map_err(|e| e.to_string())
    });
    if write_res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_res
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_and_replaces_agent_restart_relaunch_arg() {
        let input = vec![
            "--profile".to_owned(),
            "jp".to_owned(),
            "--gsm-agent-restarted=old-id".to_owned(),
        ];
        assert_eq!(
            parse_agent_restart_id(input.iter().map(String::as_str)).as_deref(),
            Some("old-id")
        );
        assert_eq!(
            agent_relaunch_args(&input, "new-id"),
            vec![
                "--profile".to_owned(),
                "jp".to_owned(),
                "--gsm-agent-restarted=new-id".to_owned(),
            ]
        );
    }

    #[test]
    fn validates_restart_delay_and_reason_bounds() {
        assert_eq!(
            validate_restart_request(&json!({})).unwrap(),
            (30, "New changes are ready to try.".to_owned())
        );
        assert!(validate_restart_request(&json!([])).is_err());
        assert!(validate_restart_request(&json!({ "delaySeconds": 4 })).is_err());
        assert!(validate_restart_request(&json!({ "delaySeconds": 301 })).is_err());
        assert!(validate_restart_request(&json!({ "delaySeconds": 10.5 })).is_err());
        assert!(validate_restart_request(&json!({ "reason": "   " })).is_err());
        assert!(validate_restart_request(&json!({ "reason": "x".repeat(301) })).is_err());
        assert_eq!(
            validate_restart_request(&json!({ "delaySeconds": 15, "reason": " Fix bug " })).unwrap(),
            (15, "Fix bug".to_owned())
        );
    }

    #[test]
    fn agent_control_lifecycle_persists_cancels_and_preserves_errors() {
        let dir = tempdir().unwrap();
        let ctl = AgentControl::new(
            dir.path(),
            "C:\\app".into(),
            false,
            Some("prev".into()),
            AgentBusConnection {
                port: 12345,
                token: "secret".into(),
                path: "/ws".into(),
            },
        );
        assert!(ctl.filename().is_file());

        let (res1, first) = ctl.reserve_restart(&json!({ "delaySeconds": 20 }), None).unwrap();
        assert!(first);
        let (res2, second) = ctl.reserve_restart(&json!({ "delaySeconds": 5 }), None).unwrap();
        assert!(!second);
        assert_eq!(res1.request_id, res2.request_id);

        assert!(ctl.cancel_restart(&res1.request_id));
        let status = ctl.status(true, None);
        assert_eq!(status["cancelledRestartId"], res1.request_id);
        assert_eq!(status["restarting"], false);

        // Normal dispose deletes matching descriptor.
        ctl.dispose();
        assert!(!ctl.filename().exists());

        // Error state keeps descriptor alive for CLI diagnostics on exit.
        let ctl2 = AgentControl::new(
            dir.path(),
            "C:\\app".into(),
            false,
            None,
            AgentBusConnection {
                port: 12345,
                token: "secret".into(),
                path: "/ws".into(),
            },
        );
        ctl2.fail("Restart timed out");
        ctl2.dispose();
        assert!(ctl2.filename().is_file());
    }
}
