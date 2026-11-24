//! Native update policy. UI clients issue requests and observe snapshots; timers,
//! staging ownership, preference changes and attachment exclusion live here.
use crate::engines::{Engines, Prepared};
use gsm_settings::{preferences::Preferences, Result};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
type Emit = Arc<dyn Fn(Value) + Send + Sync>;
struct State {
    phase: &'static str,
    error: Option<String>,
    remote: Value,
    versions: Value,
    progress: Value,
    pending: Option<(Prepared, bool)>,
}
#[derive(Default)]
struct Gate {
    reservations: HashSet<String>,
    installing: bool,
}
pub struct Updater {
    engines: Engines,
    preferences: Preferences,
    state: Mutex<State>,
    gate: Mutex<Gate>,
    busy: Arc<dyn Fn() -> bool + Send + Sync>,
    emit: Emit,
    operation: AtomicBool,
    started: AtomicBool,
    stopped: AtomicBool,
}
struct Operation(Arc<Updater>);
impl Drop for Operation {
    fn drop(&mut self) {
        self.0.operation.store(false, Ordering::SeqCst);
    }
}
pub struct Lease {
    owner: Arc<Updater>,
    token: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.owner.release(&self.token);
    }
}
impl Updater {
    pub fn new(
        engines: Engines,
        preferences: Preferences,
        busy: impl Fn() -> bool + Send + Sync + 'static,
        emit: impl Fn(Value) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            engines,
            preferences,
            state: Mutex::new(State {
                phase: "idle",
                error: None,
                remote: Value::Null,
                versions: Value::Null,
                progress: Value::Null,
                pending: None,
            }),
            gate: Mutex::new(Gate::default()),
            busy: Arc::new(busy),
            emit: Arc::new(emit),
            operation: AtomicBool::new(false),
            started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        })
    }
    fn automatic(&self) -> Result<bool> {
        Ok(self
            .preferences
            .get("autoUpdateTexthook")?
            .and_then(|v| v.as_bool())
            .unwrap_or(true))
    }
    pub fn snapshot(&self) -> Value {
        let mut result = self.engines.local_status();
        let state = self.state.lock().unwrap();
        result["phase"] = json!(state.phase);
        result["error"] = json!(state.error);
        result["progress"] = state.progress.clone();
        result["remoteVersion"] = state.remote.clone();
        if !state.versions.is_null() {
            result["availableVersions"] = state.versions.clone();
        }
        result["pendingVersion"] = state
            .pending
            .as_ref()
            .map(|(p, _)| p.manifest["version"].clone())
            .unwrap_or(Value::Null);
        result["automatic"] = json!(self.automatic().unwrap_or(false));
        result["updateAvailable"] = json!(
            result["installed"] == true
                && version(&result["remoteVersion"])
                    .zip(version(&result["version"]))
                    .is_some_and(|(a, b)| a > b)
        );
        result
    }
    fn publish(&self) {
        (self.emit)(self.snapshot());
    }
    fn phase(&self, phase: &'static str) {
        let mut state = self.state.lock().unwrap();
        state.phase = phase;
        state.error = None;
        state.progress = Value::Null;
        drop(state);
        self.publish();
    }
    fn fail(&self, error: String) -> Value {
        let mut state = self.state.lock().unwrap();
        state.phase = "error";
        state.error = Some(error.clone());
        state.progress = Value::Null;
        drop(state);
        self.publish();
        json!({"success":false,"error":error})
    }
    pub fn reserve(&self) -> Result<String> {
        let mut gate = self.gate.lock().unwrap();
        if self.stopped.load(Ordering::SeqCst)
            || gate.installing
            || (!self.engines.installed() && self.operation.load(Ordering::SeqCst))
        {
            return Err(
                "Hook engines are being prepared. Try attaching again when they are ready.".into(),
            );
        }
        let token = uuid::Uuid::new_v4().to_string();
        gate.reservations.insert(token.clone());
        Ok(token)
    }
    pub fn lease(self: &Arc<Self>) -> Result<Lease> {
        Ok(Lease {
            owner: self.clone(),
            token: self.reserve()?,
        })
    }
    pub fn release(&self, token: &str) {
        self.gate.lock().unwrap().reservations.remove(token);
    }
    pub fn shutdown(&self) {
        let _gate = self.gate.lock().unwrap();
        self.stopped.store(true, Ordering::SeqCst);
    }
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            let mut next = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let Some(owner) = weak.upgrade() else {
                    return;
                };
                if owner.stopped.load(Ordering::SeqCst) {
                    return;
                }
                if Instant::now() >= next {
                    next = Instant::now() + Duration::from_secs(6 * 60 * 60);
                    owner.spawn("checkAuto".into(), Value::Null);
                }
                owner.notify_idle();
            }
        });
    }
    pub fn notify_idle(self: &Arc<Self>) {
        if self.state.lock().unwrap().pending.is_some()
            && !self.operation.load(Ordering::SeqCst)
            && !(self.busy)()
        {
            self.spawn("apply".into(), Value::Null);
        }
    }
    pub fn ensure_installed(self: &Arc<Self>) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if self.stopped.load(Ordering::SeqCst) {
                return Err("GSM is shutting down.".into());
            }
            let installing = self.gate.lock().unwrap().installing;
            if self.engines.installed() && !installing {
                return Ok(json!({ "success": true }));
            }
            if self
                .operation
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let _operation = Operation(self.clone());
                let installing = self.gate.lock().unwrap().installing;
                if self.engines.installed() && !installing {
                    return Ok(json!({ "success": true }));
                }
                if self.stopped.load(Ordering::SeqCst) {
                    return Err("GSM is shutting down.".into());
                }
                return match self.download(false, None) {
                    Ok(val) if val["deferred"] == true => Err(
                        "Hook engines could not activate while another hook session is active."
                            .into(),
                    ),
                    Ok(val) => Ok(val),
                    Err(err) => {
                        self.fail(err.clone());
                        Err(err)
                    }
                };
            }
            if Instant::now() >= deadline {
                return Err("Timed out waiting for hook engine installation.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    pub fn spawn(
        self: &Arc<Self>,
        action: String,
        args: Value,
    ) -> std::sync::mpsc::Receiver<Value> {
        let (tx, rx) = std::sync::mpsc::channel();
        let owner = self.clone();
        if self
            .operation
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            let _ = tx.send(if action.starts_with("check") {
                self.snapshot()
            } else {
                json!({"success":false,"error":"An engine update is already in progress."})
            });
            return rx;
        }
        std::thread::spawn(move || {
            let _operation = Operation(owner.clone());
            let result = if owner.stopped.load(Ordering::SeqCst) {
                Err("GSM is shutting down.".into())
            } else {
                match action.as_str() {
                    "check" | "checkAuto" => owner.check(action == "checkAuto"),
                    "download" => owner.download(false, None),
                    "version" => match args.as_str() {
                        Some(v) if semver::Version::parse(v).is_ok() => {
                            owner.download(false, Some(v))
                        }
                        _ => Err("Invalid engine package version.".into()),
                    },
                    "apply" => owner.apply(),
                    _ => Err("Unknown update action".into()),
                }
            };
            let result = result.unwrap_or_else(|e| owner.fail(e));
            // Checks always return the UI snapshot, including offline failures.
            let result = if action.starts_with("check") {
                owner.snapshot()
            } else {
                result
            };
            drop(_operation);
            let _ = tx.send(result);
        });
        rx
    }
    pub fn set_automatic(self: &Arc<Self>, enabled: bool) -> Result<Value> {
        self.preferences
            .patch(&json!({"autoUpdateTexthook":enabled}))?;
        self.publish();
        if enabled {
            self.spawn("checkAuto".into(), Value::Null);
        } else {
            self.notify_idle();
        }
        Ok(self.snapshot())
    }
    fn check(&self, automatic: bool) -> Result<Value> {
        if self.state.lock().unwrap().pending.is_some() {
            return Ok(self.snapshot());
        }
        self.phase("checking");
        let remote = self.engines.status();
        {
            let mut state = self.state.lock().unwrap();
            state.remote = remote["remoteVersion"].clone();
            state.versions = remote["availableVersions"].clone();
        }
        if remote["remoteVersion"].is_null() {
            return Err("Could not check for engine updates.".into());
        }
        self.phase("idle");
        if automatic && self.automatic()? && remote["updateAvailable"] == true {
            self.download(true, None)?;
        }
        Ok(self.snapshot())
    }
    fn download(&self, automatic: bool, selected: Option<&str>) -> Result<Value> {
        if selected.is_none() && self.state.lock().unwrap().pending.is_some() {
            return self.apply();
        }
        let old = self.state.lock().unwrap().pending.take();
        if let Some((old, _)) = old {
            self.engines.discard(&old)?;
        }
        self.phase("downloading");
        let prepared = self.engines.prepare(selected, &|event, progress| {
            let mut state = self.state.lock().unwrap();
            state.phase = if event == "verifying" {
                "verifying"
            } else {
                "downloading"
            };
            state.progress = progress;
            drop(state);
            self.publish();
        })?;
        if selected.is_some() {
            if let Err(error) = self.preferences.patch(&json!({"autoUpdateTexthook":false})) {
                let _ = self.engines.discard(&prepared);
                return Err(error);
            }
        }
        {
            let mut state = self.state.lock().unwrap();
            if state.remote.is_null() {
                state.remote = prepared.manifest["version"].clone();
            }
            state.pending = Some((prepared, automatic));
        }
        self.apply()
    }
    fn apply(&self) -> Result<Value> {
        let pending = self.state.lock().unwrap().pending.clone();
        let Some((prepared, automatic)) = pending else {
            return Ok(json!({"success":true}));
        };
        if self.stopped.load(Ordering::SeqCst) || (automatic && !self.automatic()?) {
            self.engines.discard(&prepared)?;
            self.state.lock().unwrap().pending = None;
            self.phase("idle");
            return Ok(json!({"success":true}));
        }
        let mut gate = self.gate.lock().unwrap();
        if !gate.reservations.is_empty() || (self.busy)() {
            drop(gate);
            self.phase("waiting");
            return Ok(json!({"success":true,"deferred":true}));
        }
        if self.stopped.load(Ordering::SeqCst) {
            return Err("GSM is shutting down.".into());
        }
        gate.installing = true;
        drop(gate);
        self.phase("installing");
        let result = self.engines.activate(&prepared);
        self.gate.lock().unwrap().installing = false;
        self.state.lock().unwrap().pending = None;
        if let Err(error) = result {
            let _ = self.engines.discard(&prepared);
            return Err(error);
        }
        self.phase("idle");
        Ok(json!({"success":true}))
    }
}
fn version(value: &Value) -> Option<semver::Version> {
    semver::Version::parse(value.as_str()?).ok()
}
