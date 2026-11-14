//! Backend startup is a native lifetime, including preparation and one bounded
//! initialization repair. UI clients observe it; they never advance its steps.
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type Call =
    Arc<dyn Fn(&'static str, Value) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;
pub type Publish = Arc<dyn Fn(&str, Value) + Send + Sync>;

struct Attempt {
    id: String,
    spec: Value,
    phase: &'static str,
    run: Option<String>,
    pid: Value,
    launching: bool,
    ever_ready: bool,
    spawned_at: Instant,
    cancelled: bool,
    finished: bool,
    exit: Option<Value>,
    error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Fixture {
        owner: Arc<Backend>,
        launches: Arc<AtomicUsize>,
        repairs: Arc<AtomicUsize>,
        events: Arc<Mutex<Vec<(String, Value)>>>,
    }
    fn fixture(mode: &'static str) -> Fixture {
        let holder = Arc::new(Mutex::new(std::sync::Weak::<Backend>::new()));
        let launches = Arc::new(AtomicUsize::new(0));
        let repairs = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(vec![]));
        let (h, l, r) = (holder.clone(), launches.clone(), repairs.clone());
        let call: Call = Arc::new(move |action, args| {
            let (h, l, r) = (h.clone(), l.clone(), r.clone());
            Box::pin(async move {
                let owner = h.lock().unwrap().upgrade().unwrap();
                match action {
                    "prepare" => {
                        if mode == "slow_prepare" {
                            tokio::time::sleep(Duration::from_millis(80)).await;
                        }
                        if mode == "prepare_failure" {
                            return Err("prepare failed".into());
                        }
                        Ok(json!({"pythonPath":"python"}))
                    }
                    "repair" => {
                        r.fetch_add(1, Ordering::SeqCst);
                        if mode == "repair_failure" {
                            Err("offline".into())
                        } else {
                            Ok(json!({"pythonPath":"repaired-python"}))
                        }
                    }
                    "launch" => {
                        let n = l.fetch_add(1, Ordering::SeqCst);
                        let run = format!("process-{n}");
                        owner.observe(
                            "process.spawned",
                            &json!({"id":"backend","runId":run,"pid":100+n}),
                        );
                        if mode == "ready"
                            || mode == "runtime_failure"
                            || (mode == "repair_once" && n == 1)
                        {
                            owner.observe("bus.message", &json!({"src":"backend","kind":"event","topic":"backend.event","data":{"function":"initialized"}}));
                        }
                        if matches!(
                            mode,
                            "repair_once" | "repair_failure" | "always_fails" | "runtime_failure"
                        ) && !(mode == "repair_once" && n == 1)
                        {
                            owner.observe("process.exit", &json!({"id":"backend","runId":run,"code":1,"beforeInitialization":true}));
                        }
                        Ok(json!({"runId":run}))
                    }
                    "stop" => {
                        owner.observe("process.exit", &json!({"id":"backend","runId":args["runId"],"code":0,"intentional":true}));
                        Ok(Value::Null)
                    }
                    _ => unreachable!(),
                }
            })
        });
        let output = events.clone();
        let owner = Backend::new(
            call,
            Arc::new(move |e, v| output.lock().unwrap().push((e.into(), v))),
        );
        *holder.lock().unwrap() = Arc::downgrade(&owner);
        Fixture {
            owner,
            launches,
            repairs,
            events,
        }
    }
    async fn until(f: &Fixture, state: &str) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while f.owner.snapshot()["state"] != state {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn initialization_failure_gets_exactly_one_native_repair() {
        let f = fixture("repair_once");
        let lifetime = f.owner.start(json!({})).unwrap();
        until(&f, "ready").await;
        assert_eq!(f.launches.load(Ordering::SeqCst), 2);
        assert_eq!(f.repairs.load(Ordering::SeqCst), 1);
        assert!(f.events.lock().unwrap().iter().all(|(e, _)| e != "exit"));
        assert_eq!(f.owner.snapshot()["runId"], lifetime["runId"]);
        f.owner.stop(None).await.unwrap();
        assert_eq!(
            f.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(e, _)| e == "exit")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn exhaustion_and_failed_repair_cannot_start_another_repair_loop() {
        for mode in ["always_fails", "repair_failure", "prepare_failure"] {
            let f = fixture(mode);
            f.owner.start(json!({})).unwrap();
            until(&f, "failed").await;
            assert_eq!(
                f.repairs.load(Ordering::SeqCst),
                usize::from(mode != "prepare_failure")
            );
            assert_eq!(
                f.launches.load(Ordering::SeqCst),
                if mode == "always_fails" {
                    2
                } else if mode == "prepare_failure" {
                    0
                } else {
                    1
                }
            );
        }
    }
    #[tokio::test]
    async fn runtime_crash_never_reinstalls_dependencies_even_if_replacement_cannot_initialize() {
        let f = fixture("runtime_failure");
        f.owner.start(json!({})).unwrap();
        until(&f, "failed").await;
        assert_eq!(f.repairs.load(Ordering::SeqCst), 0);
        assert_eq!(f.owner.snapshot()["initialized"], true);
    }
    #[tokio::test]
    async fn stop_during_preparation_prevents_a_late_launch_and_rejects_duplicates() {
        let f = fixture("slow_prepare");
        let first = f.owner.start(json!({})).unwrap();
        assert!(f.owner.start(json!({})).is_err());
        f.owner
            .stop(Some(first["runId"].as_str().unwrap()))
            .await
            .unwrap();
        assert_eq!(f.launches.load(Ordering::SeqCst), 0);
        assert_eq!(f.repairs.load(Ordering::SeqCst), 0);
        assert_eq!(f.owner.snapshot()["state"], "stopped");
    }
    #[tokio::test]
    async fn stale_stop_and_old_process_events_cannot_end_the_current_lifetime() {
        let f = fixture("ready");
        let old = f.owner.start(json!({})).unwrap();
        until(&f, "ready").await;
        f.owner.stop(None).await.unwrap();
        f.owner.start(json!({})).unwrap();
        until(&f, "ready").await;
        f.owner.stop(old["runId"].as_str()).await.unwrap();
        f.owner.observe(
            "process.exit",
            &json!({"id":"backend","runId":"process-0","code":1}),
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(f.owner.snapshot()["state"], "ready");
        f.owner.stop(None).await.unwrap();
    }
    #[tokio::test]
    async fn readiness_timeout_reaps_the_child_without_package_repair() {
        let f = fixture("hang");
        f.owner.start(json!({"readyTimeoutMs":40})).unwrap();
        until(&f, "failed").await;
        assert_eq!(f.repairs.load(Ordering::SeqCst), 0);
        assert!(f.owner.snapshot()["error"]
            .as_str()
            .unwrap()
            .contains("initializing"));
    }
    #[tokio::test]
    async fn failed_cleanup_blocks_launch_until_stop_successfully_reaps_the_tree() {
        let f = fixture("ready");
        f.owner.start(json!({})).unwrap();
        until(&f, "ready").await;
        f.owner.observe(
            "process.error",
            &json!({"id":"backend","runId":"process-0","error":"cleanup denied"}),
        );
        until(&f, "failed").await;
        assert_eq!(f.owner.snapshot()["pid"], 100);
        assert!(f.owner.start(json!({})).is_err());
        assert_eq!(f.repairs.load(Ordering::SeqCst), 0);
        f.owner.stop(None).await.unwrap();
        assert!(f.owner.snapshot()["pid"].is_null());
        f.owner.start(json!({})).unwrap();
        until(&f, "ready").await;
        f.owner.stop(None).await.unwrap();
    }
    #[tokio::test]
    async fn crash_replacement_has_its_own_readiness_deadline_without_package_repair() {
        let f = fixture("ready");
        f.owner.start(json!({"readyTimeoutMs":100})).unwrap();
        until(&f, "ready").await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        f.owner.observe(
            "process.spawned",
            &json!({"id":"backend","runId":"process-0","pid":101}),
        );
        until(&f, "failed").await;
        assert_eq!(f.repairs.load(Ordering::SeqCst), 0);
        assert!(f.owner.snapshot()["pid"].is_null());
    }
}
impl Attempt {
    fn snapshot(&self) -> Value {
        json!({"id":"backend","runId":self.id,"processRunId":self.run,"pid":self.pid,
            "state":self.phase,"initialized":self.ever_ready,"finished":self.finished,
            "intentional":self.cancelled,"error":self.error,"session":self.spec["session"]})
    }
}

pub struct Backend {
    current: Mutex<Option<Attempt>>,
    call: Call,
    publish: Publish,
}
impl Backend {
    pub fn new(call: Call, publish: Publish) -> Arc<Self> {
        Arc::new(Self {
            current: Mutex::new(None),
            call,
            publish,
        })
    }
    pub fn snapshot(&self) -> Value {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .map(Attempt::snapshot)
            .unwrap_or(json!({"state":"stopped","finished":true}))
    }
    pub fn start(self: &Arc<Self>, spec: Value) -> Result<Value, String> {
        let snapshot = {
            let mut current = self.current.lock().unwrap();
            if current
                .as_ref()
                .is_some_and(|a| !a.finished || a.pid.is_number())
            {
                return Err("The backend already has an active launch or process.".into());
            }
            let attempt = Attempt {
                id: uuid::Uuid::new_v4().to_string(),
                spec: spec.clone(),
                phase: "preparing",
                run: None,
                pid: Value::Null,
                launching: false,
                ever_ready: false,
                spawned_at: Instant::now(),
                cancelled: false,
                finished: false,
                exit: None,
                error: None,
            };
            let snapshot = attempt.snapshot();
            *current = Some(attempt);
            snapshot
        };
        (self.publish)("state", snapshot.clone());
        let owner = self.clone();
        let id = snapshot["runId"].as_str().unwrap().to_owned();
        tokio::spawn(async move {
            let result = owner.run(&id, spec).await;
            owner.finish(&id, result);
        });
        Ok(snapshot)
    }
    fn cancelled(&self, id: &str) -> bool {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|a| a.id != id || a.cancelled)
    }
    fn phase(&self, id: &str, phase: &'static str) {
        let snapshot = {
            let mut current = self.current.lock().unwrap();
            let Some(a) = current.as_mut().filter(|a| a.id == id) else {
                return;
            };
            a.phase = phase;
            a.snapshot()
        };
        (self.publish)("state", snapshot);
    }
    async fn run(&self, id: &str, spec: Value) -> Result<Value, String> {
        let mut prepared = (self.call)("prepare", spec.clone()).await?;
        for attempt in 0..=1 {
            if self.cancelled(id) {
                return Ok(json!({"code":0,"intentional":true}));
            }
            self.phase(id, "starting");
            {
                let mut current = self.current.lock().unwrap();
                let a = current.as_mut().unwrap();
                a.launching = true;
                a.run = None;
                a.exit = None;
                a.pid = Value::Null;
            }
            let launched = (self.call)("launch", json!({"spec":spec,"prepared":prepared})).await;
            let outcome = match launched {
                Ok(_) => self.wait_process(id, &spec).await,
                Err(error) => Ok(json!({"code":1,"error":error,"beforeInitialization":true})),
            }?;
            let ever_ready = self
                .current
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|a| a.ever_ready);
            if self.cancelled(id)
                || outcome["intentional"] == true
                || outcome["code"] == 0
                || ever_ready
                || attempt == 1
                || spec["repairOnFailure"] == false
            {
                return Ok(outcome);
            }
            self.phase(id, "repairing");
            prepared = (self.call)("repair", json!({"spec":spec,"prepared":prepared}))
                .await
                .map_err(|e| format!("Backend repair failed: {e}"))?;
        }
        unreachable!()
    }
    async fn wait_process(&self, id: &str, spec: &Value) -> Result<Value, String> {
        let timeout = Duration::from_millis(spec["readyTimeoutMs"].as_u64().unwrap_or(600_000));
        let mut stop_sent = false;
        loop {
            let (exit, cancelled, ready, run, elapsed) = {
                let current = self.current.lock().unwrap();
                let a = current
                    .as_ref()
                    .filter(|a| a.id == id)
                    .ok_or("Backend lifetime replaced")?;
                (
                    a.exit.clone(),
                    a.cancelled,
                    a.phase == "ready",
                    a.run.clone(),
                    a.spawned_at.elapsed(),
                )
            };
            if let Some(exit) = exit {
                return Ok(exit);
            }
            if cancelled && !stop_sent {
                (self.call)("stop", json!({"runId":run})).await?;
                stop_sent = true;
            } else if !ready && !cancelled && elapsed >= timeout {
                (self.call)("stop", json!({"runId":run})).await?;
                // A hung initializer is not evidence of damaged dependencies.
                return Err(
                    "The backend did not finish initializing before its startup deadline.".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    fn finish(&self, id: &str, result: Result<Value, String>) {
        let snapshot = {
            let mut current = self.current.lock().unwrap();
            let Some(a) = current.as_mut().filter(|a| a.id == id) else {
                return;
            };
            let outcome = result.unwrap_or_else(|error| json!({"code":1,"error":error}));
            a.finished = true;
            a.launching = false;
            a.error = outcome["error"].as_str().map(str::to_owned);
            if a.error.is_none() && !a.cancelled && outcome["code"] != 0 {
                a.error = Some(format!("Backend exited with code {}", outcome["code"]));
            }
            a.phase = if (a.cancelled && a.error.is_none()) || outcome["code"] == 0 {
                "stopped"
            } else {
                "failed"
            };
            let mut snapshot = a.snapshot();
            snapshot["code"] = outcome["code"].clone();
            snapshot["beforeInitialization"] = json!(!a.ever_ready);
            snapshot
        };
        (self.publish)("exit", snapshot);
    }
    /// Cancellation survives an in-flight installer. Wait for its safe boundary
    /// and for native process-tree cleanup; never launch after acknowledging stop.
    pub async fn stop(&self, expected: Option<&str>) -> Result<Value, String> {
        let (id, cleanup) = {
            let mut current = self.current.lock().unwrap();
            let Some(a) = current.as_mut() else {
                return Ok(Value::Null);
            };
            if expected.is_some_and(|id| a.id != id) {
                return Ok(Value::Null);
            }
            if a.finished && !a.pid.is_number() {
                return Ok(a.snapshot());
            }
            a.cancelled = true;
            (a.id.clone(), if a.finished { a.run.clone() } else { None })
        };
        if let Some(run) = cleanup {
            (self.call)("stop", json!({"runId":run})).await?;
            let mut current = self.current.lock().unwrap();
            if let Some(a) = current.as_mut().filter(|a| a.id == id) {
                a.pid = Value::Null;
                a.error = None;
                a.phase = "stopped";
            }
        }
        loop {
            let snapshot = self.snapshot();
            if snapshot["runId"] != id || snapshot["finished"] == true {
                if let Some(error) = snapshot["error"].as_str() {
                    return Err(error.to_owned());
                }
                return Ok(snapshot);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    /// Called before forwarding runtime events to any compatibility client.
    pub fn observe(&self, event: &str, data: &Value) {
        let forwarded = {
            let mut current = self.current.lock().unwrap();
            let Some(a) = current.as_mut().filter(|a| !a.finished) else {
                return;
            };
            if event == "bus.message"
                && data["src"] == "backend"
                && data["topic"] == "backend.event"
                && data["kind"] == "event"
                && data["data"]["function"] == "initialized"
                && a.run.is_some()
            {
                a.ever_ready = true;
                a.phase = "ready";
                Some(("ready", a.snapshot()))
            } else if data["id"] == "backend" {
                if event == "process.spawned" && a.launching {
                    a.run = data["runId"].as_str().map(str::to_owned);
                    a.launching = false;
                }
                if data["runId"].as_str() != a.run.as_deref() {
                    return;
                }
                let mut payload = data.clone();
                payload["runId"] = json!(a.id);
                match event {
                    "process.spawned" => {
                        a.pid = data["pid"].clone();
                        a.phase = "starting";
                        a.spawned_at = Instant::now();
                        Some(("spawned", payload))
                    }
                    "process.log" => Some(("log", payload)),
                    "process.crashed" => Some(("crashed", payload)),
                    "process.exit" => {
                        a.pid = Value::Null;
                        a.exit = Some(data.clone());
                        None
                    }
                    // Cleanup failures must be surfaced without attempting repair.
                    "process.error" => {
                        a.exit = Some(json!({"code":1,"error":data["error"],"intentional":true}));
                        None
                    }
                    _ => None,
                }
            } else {
                None
            }
        };
        if let Some((event, payload)) = forwarded {
            (self.publish)(event, payload);
        }
    }
}
