//! Native installation state. Producers hold an attempt lease, so a delayed
//! download or backend event cannot modify a replacement installation.
use gsm_settings::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const STAGES: &[(&str, &str, u64)] = &[
    ("prepare", "Preparing install session", 2),
    ("uv", "Installing uv runtime", 6),
    ("python", "Installing Python runtime", 15),
    ("venv", "Creating virtual environment", 8),
    ("verify_runtime", "Verifying Python runtime", 5),
    ("lock_sync", "Syncing lockfile dependencies", 20),
    ("gsm_package", "Installing GSM backend package", 5),
    ("backend_boot", "Starting backend process", 4),
    ("obs", "Installing OBS dependencies", 18),
    ("ffmpeg", "Installing FFmpeg", 10),
    ("oneocr", "Installing OneOCR", 6),
    ("finalize", "Finalizing setup", 1),
];
const LOG_LIMIT: usize = 250;
const TEXT_LIMIT: usize = 4096;
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub session_id: String,
    pub attempt: u64,
}
#[derive(Clone)]
struct Record {
    snapshot: Value,
    retry: Option<String>,
}
impl Record {
    fn lease(&self) -> Lease {
        Lease {
            session_id: self.snapshot["id"].as_str().unwrap().into(),
            attempt: self.snapshot["attempt"].as_u64().unwrap(),
        }
    }
}
struct Retry {
    ticket: String,
    lease: Lease,
    expires: u64,
    accepted: bool,
}
#[derive(Default)]
struct State {
    active: Option<Record>,
    last: Option<Record>,
    retry: Option<Retry>,
    revision: u64,
    log_counter: u64,
    dirty: bool,
    finished: VecDeque<Value>,
}
#[derive(Default)]
pub struct Sessions {
    state: Mutex<State>,
}
fn bounded(text: &str) -> String {
    text.chars().take(TEXT_LIMIT).collect()
}
fn stages() -> Value {
    json!(STAGES.iter().map(|(id,label,weight)|json!({
    "id":id,"label":label,"weight":weight,"status":"pending","progressKind":"indeterminate",
    "progress":null,"message":"","downloadedBytes":null,"totalBytes":null,"startedAt":null,"finishedAt":null,"error":null
})).collect::<Vec<_>>())
}
fn rebuild(snapshot: &mut Value) {
    let stages = snapshot["stages"].as_array().unwrap();
    let current = stages
        .iter()
        .rev()
        .find(|s| s["status"] == "running")
        .or_else(|| stages.iter().rev().find(|s| s["status"] == "failed"));
    let id = current.map(|s| s["id"].clone()).unwrap_or(Value::Null);
    let message = current
        .or_else(|| {
            stages
                .iter()
                .rev()
                .find(|s| s["status"] == "completed" || s["status"] == "skipped")
        })
        .map(|s| {
            if s["status"] == "failed" && s["error"].is_string() {
                s["error"].clone()
            } else {
                s["message"].clone()
            }
        })
        .filter(|s| s.as_str().is_some_and(|s| !s.is_empty()))
        .unwrap_or_else(|| snapshot["error"].clone());
    let progress: f64 = stages
        .iter()
        .map(|s| {
            s["weight"].as_f64().unwrap()
                * if s["status"] == "completed" || s["status"] == "skipped" {
                    1.0
                } else {
                    s["progress"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0)
                }
        })
        .sum::<f64>()
        / 100.0;
    snapshot["currentStageId"] = id;
    snapshot["currentMessage"] = if message.is_string() {
        message
    } else {
        json!("")
    };
    snapshot["overallProgress"] = json!(progress.clamp(0.0, 1.0));
}
impl State {
    fn touch(&mut self) {
        self.revision += 1;
        self.dirty = true;
        if let Some(record) = &mut self.active {
            record.snapshot["revision"] = json!(self.revision);
        }
    }
    fn matches(&self, lease: &Lease) -> bool {
        self.active.as_ref().is_some_and(|r| r.lease() == *lease)
    }
    fn start(&mut self, origin: &str, retry: Option<String>, ensure: bool, time: u64) -> Value {
        if ensure
            && self
                .active
                .as_ref()
                .is_some_and(|r| r.snapshot["origin"] == origin)
        {
            if let Some(retry) = retry {
                let record = self.active.as_mut().unwrap();
                record.retry = Some(retry);
                record.snapshot["retryAvailable"] = json!(true);
                self.touch();
            }
            return self.active.as_ref().unwrap().snapshot.clone();
        }
        let old = if self
            .last
            .as_ref()
            .is_some_and(|r| r.snapshot["origin"] == origin && r.snapshot["status"] == "failed")
        {
            self.last.take()
        } else {
            None
        };
        let record = if let Some(mut record) = old {
            record.snapshot["attempt"] = json!(record.snapshot["attempt"].as_u64().unwrap() + 1);
            record.snapshot["status"] = json!("running");
            record.snapshot["finishedAt"] = Value::Null;
            record.snapshot["error"] = Value::Null;
            for stage in record.snapshot["stages"].as_array_mut().unwrap() {
                if stage["status"] == "completed" || stage["status"] == "skipped" {
                    stage["error"] = Value::Null;
                    continue;
                }
                let id = stage["id"].clone();
                *stage = stages()
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["id"] == id)
                    .unwrap()
                    .clone();
            }
            let logs = record.snapshot["logs"].as_array_mut().unwrap();
            if logs.len() > 200 {
                logs.drain(..logs.len() - 200);
            }
            if retry.is_some() {
                record.retry = retry;
            }
            record
        } else {
            Record {
                snapshot: json!({"id":uuid::Uuid::new_v4().to_string(),"attempt":1,"revision":0,"origin":origin,"status":"running",
            "startedAt":time,"finishedAt":null,"currentStageId":null,"overallProgress":0,"currentMessage":"","error":null,
            "stages":stages(),"logs":[]}),
                retry,
            }
        };
        self.active = Some(record);
        self.retry = None;
        let record = self.active.as_mut().unwrap();
        record.snapshot["retryAvailable"] = json!(record.retry.is_some());
        rebuild(&mut record.snapshot);
        self.touch();
        self.active.as_ref().unwrap().snapshot.clone()
    }
    fn finish(
        &mut self,
        status: &str,
        message: Option<&str>,
        error: Option<&str>,
        time: u64,
    ) -> Value {
        let Some(mut record) = self.active.take() else {
            return Value::Null;
        };
        record.snapshot["status"] = json!(status);
        record.snapshot["finishedAt"] = json!(time);
        record.snapshot["error"] = if status == "failed" {
            json!(bounded(
                error
                    .or(record.snapshot["error"].as_str())
                    .or(message)
                    .unwrap_or("Installation failed.")
            ))
        } else {
            Value::Null
        };
        let failure = record.snapshot["error"].clone();
        for stage in record.snapshot["stages"].as_array_mut().unwrap() {
            if status == "completed"
                && (stage["status"] == "pending" || stage["status"] == "running")
            {
                stage["status"] = json!("skipped");
                stage["progress"] = json!(1);
                stage["finishedAt"] = json!(time);
            } else if status == "failed" && stage["status"] == "running" {
                stage["status"] = json!("failed");
                stage["error"] = failure.clone();
                stage["finishedAt"] = json!(time);
            }
        }
        rebuild(&mut record.snapshot);
        if let Some(message) = message {
            record.snapshot["currentMessage"] = json!(bounded(message));
        }
        self.revision += 1;
        record.snapshot["revision"] = json!(self.revision);
        self.retry = None;
        self.dirty = false;
        let result = record.snapshot.clone();
        self.last = Some(record);
        if self.finished.len() == 32 {
            self.finished.pop_front();
        }
        self.finished.push_back(result.clone());
        result
    }
}
impl Sessions {
    pub fn lease(&self) -> Option<Lease> {
        self.state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .map(Record::lease)
    }
    pub fn snapshot(&self, which: &str) -> Value {
        let state = self.state.lock().unwrap();
        let record = match which {
            "active" => state.active.as_ref(),
            "last" => state.last.as_ref(),
            _ => state.active.as_ref().or(state.last.as_ref()),
        };
        record.map(|r| r.snapshot.clone()).unwrap_or(Value::Null)
    }
    pub fn take_events(&self) -> Vec<(&'static str, Value)> {
        let mut state = self.state.lock().unwrap();
        let mut events = state
            .finished
            .drain(..)
            .map(|s| ("install-session.finished", s))
            .collect::<Vec<_>>();
        if state.dirty {
            state.dirty = false;
            if let Some(record) = &state.active {
                events.push(("install-session.snapshot", record.snapshot.clone()));
            }
        }
        events
    }
    pub fn update(&self, lease: &Lease, update: &Value) -> Result<bool> {
        let mut state = self.state.lock().unwrap();
        if !state.matches(lease) {
            return Ok(false);
        }
        let record = state.active.as_mut().unwrap();
        let stage = record.snapshot["stages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["id"] == update["stageId"])
            .ok_or("Unknown installation stage")?;
        if let Some(status) = update.get("status").and_then(Value::as_str) {
            if !["pending", "running", "completed", "skipped", "failed"].contains(&status) {
                return Err("Invalid installation stage status".into());
            }
        }
        if let Some(kind) = update.get("progressKind").and_then(Value::as_str) {
            if !["bytes", "estimated", "indeterminate"].contains(&kind) {
                return Err("Invalid installation progress kind".into());
            }
        }
        for key in ["status", "progressKind", "message", "error"] {
            if let Some(value) = update.get(key) {
                if let Some(text) = value.as_str() {
                    stage[key] = json!(bounded(text));
                } else if key == "error" && value.is_null() {
                    stage[key] = Value::Null;
                }
            }
        }
        for key in ["progress", "downloadedBytes", "totalBytes"] {
            if let Some(value) = update.get(key) {
                stage[key] = value
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .map(|n| {
                        json!(if key == "progress" {
                            n.clamp(0.0, 1.0)
                        } else {
                            n.max(0.0)
                        })
                    })
                    .unwrap_or(Value::Null);
            }
        }
        let status = stage["status"].as_str().unwrap().to_owned();
        if status == "running" && stage["startedAt"].is_null() {
            stage["startedAt"] = json!(now());
        }
        if ["completed", "skipped", "failed"].contains(&status.as_str()) {
            stage["finishedAt"] = json!(now());
        } else {
            stage["finishedAt"] = Value::Null;
        }
        if status == "completed" || status == "skipped" {
            stage["progress"] = json!(1);
            stage["error"] = Value::Null;
        }
        if status == "failed" {
            record.snapshot["error"] = stage["error"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| json!(s))
                .unwrap_or_else(|| stage["message"].clone());
        }
        rebuild(&mut record.snapshot);
        state.touch();
        Ok(true)
    }
    pub fn append(&self, lease: &Lease, entry: &Value) -> bool {
        let mut state = self.state.lock().unwrap();
        if !state.matches(lease) {
            return false;
        }
        let Some(message) = entry["message"].as_str() else {
            return false;
        };
        state.log_counter += 1;
        let mut log = json!({"id":format!("install-log-{}",state.log_counter),"createdAt":now(),"message":bounded(message)});
        for key in ["level", "source", "stream"] {
            if let Some(value) = entry[key].as_str() {
                log[key] = json!(bounded(value));
            }
        }
        let logs = state.active.as_mut().unwrap().snapshot["logs"]
            .as_array_mut()
            .unwrap();
        logs.push(log);
        if logs.len() > LOG_LIMIT {
            logs.drain(..logs.len() - LOG_LIMIT);
        }
        state.touch();
        true
    }
    pub fn finish(
        &self,
        lease: &Lease,
        status: &str,
        message: Option<&str>,
        error: Option<&str>,
    ) -> Result<Value> {
        if !["completed", "failed"].contains(&status) {
            return Err("Invalid installation result".into());
        }
        let mut state = self.state.lock().unwrap();
        if !state.matches(lease) {
            return Ok(Value::Null);
        }
        Ok(state.finish(status, message, error, now()))
    }
    pub fn claim_retry(&self, expected: &Lease) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        if state.active.is_some() {
            return Err("An installation is already running.".into());
        }
        let record = state
            .last
            .as_ref()
            .filter(|r| r.lease() == *expected && r.snapshot["status"] == "failed")
            .ok_or("This installation is no longer available to retry.")?;
        let target = record
            .retry
            .clone()
            .ok_or("This installation cannot be retried in the current session.")?;
        let origin = record.snapshot["origin"].as_str().unwrap().to_owned();
        state.start(&origin, None, false, now());
        let lease = state.active.as_ref().unwrap().lease();
        let ticket = uuid::Uuid::new_v4().to_string();
        state.retry = Some(Retry {
            ticket: ticket.clone(),
            lease: lease.clone(),
            expires: now() + 10000,
            accepted: false,
        });
        Ok(json!({"target":target,"ticket":ticket,"lease":lease}))
    }
    pub fn accept_retry(&self, ticket: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        let valid = state.retry.as_ref().is_some_and(|r| {
            !r.accepted && r.ticket == ticket && r.expires >= now() && state.matches(&r.lease)
        });
        if valid {
            state.retry.as_mut().unwrap().accepted = true;
        }
        valid
    }
    /// A delayed transport acknowledgement must not cancel work that already
    /// redeemed its claim. Both acceptance and timeout use the same state lock.
    pub fn cancel_unaccepted_retry(&self, lease: &Lease, error: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.last.as_ref().is_some_and(|r| r.lease() == *lease)
            || state
                .retry
                .as_ref()
                .is_some_and(|r| r.lease == *lease && r.accepted)
        {
            return true;
        }
        if state.matches(lease) {
            state.finish("failed", Some(error), Some(error), now());
        }
        false
    }
    pub fn call(&self, action: &str, args: &Value) -> Result<Value> {
        match action {
            "active" | "last" | "renderer" => Ok(self.snapshot(action)),
            "start" | "ensure" => {
                let origin = args["origin"].as_str().unwrap_or("");
                if !["startup", "repair", "reset_dependencies", "backend_update"].contains(&origin)
                {
                    return Err("Invalid installation origin".into());
                }
                let retry = args["retry"].as_str().map(bounded);
                Ok(self
                    .state
                    .lock()
                    .unwrap()
                    .start(origin, retry, action == "ensure", now()))
            }
            "update" | "log" | "finish" => {
                let lease = if args["lease"].is_object() {
                    Some(serde_json::from_value(args["lease"].clone()).map_err(|e| e.to_string())?)
                } else {
                    self.lease()
                };
                let Some(lease) = lease else {
                    return Ok(Value::Null);
                };
                match action {
                    "update" => self.update(&lease, &args["update"]).map(|v| json!(v)),
                    "log" => Ok(json!(self.append(&lease, &args["entry"]))),
                    _ => self.finish(
                        &lease,
                        args["status"].as_str().unwrap_or(""),
                        args["message"].as_str(),
                        args["error"].as_str(),
                    ),
                }
            }
            "acceptRetry" => Ok(json!(
                self.accept_retry(args["ticket"].as_str().unwrap_or(""))
            )),
            _ => Err("Unknown installation session operation".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn start(s: &Sessions, origin: &str) -> Lease {
        s.call("start", &json!({"origin":origin,"retry":"callback"}))
            .unwrap();
        s.lease().unwrap()
    }
    #[test]
    fn weighted_progress_nulls_and_terminal_results() {
        let sessions = Sessions::default();
        let lease = start(&sessions, "startup");
        sessions
            .update(&lease, &json!({"stageId":"prepare","status":"completed"}))
            .unwrap();
        assert_eq!(sessions.snapshot("active")["overallProgress"], 0.02);
        sessions.update(&lease,&json!({"stageId":"python","status":"running","progress":0.5,"message":"Installing Python"})).unwrap();
        assert_eq!(sessions.snapshot("active")["overallProgress"], 0.095);
        assert_eq!(
            sessions.snapshot("active")["currentMessage"],
            "Installing Python"
        );
        sessions
            .update(
                &lease,
                &json!({"stageId":"python","progress":null,"progressKind":"indeterminate"}),
            )
            .unwrap();
        assert!(sessions.snapshot("active")["stages"][2]["progress"].is_null());
        sessions
            .finish(&lease, "completed", Some("Ready"), None)
            .unwrap();
        assert!(sessions.snapshot("active").is_null());
        assert_eq!(sessions.snapshot("renderer")["status"], "completed");
        assert_eq!(sessions.snapshot("renderer")["overallProgress"], 1.0);
        let events = sessions.take_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "install-session.finished");
    }
    #[test]
    fn retry_preserves_completed_work_and_rejects_old_attempts_and_double_clicks() {
        let sessions = Sessions::default();
        let old = start(&sessions, "repair");
        sessions
            .update(&old, &json!({"stageId":"uv","status":"skipped"}))
            .unwrap();
        sessions
            .update(
                &old,
                &json!({"stageId":"lock_sync","status":"failed","error":"network timeout"}),
            )
            .unwrap();
        sessions.finish(&old, "failed", None, None).unwrap();
        let claim = sessions.claim_retry(&old).unwrap();
        let current = sessions.lease().unwrap();
        assert_eq!(current.session_id, old.session_id);
        assert_eq!(current.attempt, 2);
        assert_eq!(
            sessions.snapshot("active")["stages"][1]["status"],
            "skipped"
        );
        assert_eq!(
            sessions.snapshot("active")["stages"][5]["status"],
            "pending"
        );
        assert!(sessions.claim_retry(&old).is_err());
        assert!(sessions.accept_retry(claim["ticket"].as_str().unwrap()));
        assert!(!sessions.accept_retry(claim["ticket"].as_str().unwrap()));
        assert!(!sessions
            .update(&old, &json!({"stageId":"lock_sync","status":"completed"}))
            .unwrap());
        assert!(!sessions.append(&old, &json!({"message":"late output"})));
        assert!(sessions
            .finish(&old, "completed", None, None)
            .unwrap()
            .is_null());
        assert_eq!(sessions.snapshot("active")["status"], "running");
    }
    #[test]
    fn coalesces_progress_and_bounds_unicode_logs() {
        let sessions = Sessions::default();
        let lease = start(&sessions, "reset_dependencies");
        for _ in 0..300 {
            sessions.append(&lease, &json!({"message":"字幕🦀".repeat(5000)}));
        }
        let snapshot = sessions.snapshot("active");
        assert_eq!(snapshot["logs"].as_array().unwrap().len(), 250);
        assert_eq!(
            snapshot["logs"][0]["message"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            4096
        );
        assert_eq!(sessions.take_events().len(), 1);
        assert!(sessions.take_events().is_empty());
        assert!(sessions
            .update(&lease, &json!({"stageId":"wrong"}))
            .is_err());
        assert!(sessions
            .update(&lease, &json!({"stageId":"uv","status":"wrong"}))
            .is_err());
    }
    #[test]
    fn an_expired_retry_cannot_run_later() {
        let sessions = Sessions::default();
        let lease = start(&sessions, "startup");
        sessions
            .finish(&lease, "failed", Some("Offline"), None)
            .unwrap();
        let claim = sessions.claim_retry(&lease).unwrap();
        sessions
            .state
            .lock()
            .unwrap()
            .retry
            .as_mut()
            .unwrap()
            .expires = 0;
        assert!(!sessions.accept_retry(claim["ticket"].as_str().unwrap()));
    }
    #[test]
    fn timeout_cancels_unaccepted_work_but_preserves_accepted_work() {
        let sessions = Sessions::default();
        let first = start(&sessions, "repair");
        sessions.finish(&first, "failed", None, None).unwrap();
        let rejected = sessions.claim_retry(&first).unwrap();
        let lease = sessions.lease().unwrap();
        assert!(!sessions.cancel_unaccepted_retry(&lease, "Timed out"));
        assert!(!sessions.accept_retry(rejected["ticket"].as_str().unwrap()));
        assert_eq!(sessions.snapshot("renderer")["status"], "failed");
        let accepted = sessions.claim_retry(&lease).unwrap();
        let lease = sessions.lease().unwrap();
        assert!(sessions.accept_retry(accepted["ticket"].as_str().unwrap()));
        assert!(sessions.cancel_unaccepted_retry(&lease, "Late response"));
        assert_eq!(sessions.snapshot("active")["status"], "running");
        sessions.finish(&lease, "completed", None, None).unwrap();
        assert!(sessions.cancel_unaccepted_retry(&lease, "Late response"));
        assert_eq!(sessions.snapshot("renderer")["status"], "completed");
    }
}
