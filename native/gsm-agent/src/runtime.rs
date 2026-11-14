//! Frida owns one thread in a dedicated native helper. Cancellation remains
//! available while a script is blocked in a synchronous loader call.
use crate::{
    core::{Core, Event},
    frida::{Cancellation, Context, Device},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
type Reply = mpsc::Sender<Result<Value, String>>;
enum Command {
    Rpc(String, Vec<Value>, Reply),
    Send(String, Vec<Value>, Reply),
}
pub struct Runtime {
    pub core: Arc<Mutex<Core>>,
    cancel: Arc<Cancellation>,
    commands: mpsc::Sender<Command>,
    done: Mutex<mpsc::Receiver<()>>,
}
impl Runtime {
    pub fn start(
        options: Value,
        emit: impl Fn(Event) + Send + Sync + 'static,
    ) -> Result<Arc<Self>, String> {
        let core = Arc::new(Mutex::new(Core::new(options)?));
        let cancel = Cancellation::new();
        let (tx, rx) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        let runtime = Arc::new(Self {
            core: core.clone(),
            cancel: cancel.clone(),
            commands: tx,
            done: Mutex::new(done),
        });
        thread::Builder::new()
            .name("agent-frida".into())
            .spawn(move || {
                let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(emit);
                let result = run(&core, &cancel, rx, emit.clone());
                {
                    let mut c = core.lock().unwrap();
                    if let Err(e) = result {
                        eprintln!("Agent runtime: {e}");
                        c.fail(&e, cancel.cancelled())
                    } else if c.running {
                        c.stop()
                    }
                }
                drain(&core, &emit);
                let _ = finished.send(());
            })
            .map_err(|e| e.to_string())?;
        Ok(runtime)
    }
    pub fn stop(&self) {
        self.cancel.cancel();
    }
    pub fn wait(&self, timeout: Duration) -> bool {
        self.done.lock().unwrap().recv_timeout(timeout).is_ok()
    }
    pub fn request(&self, command: &str, args: &[Value]) -> Result<Value, String> {
        match command {
            "state" => Ok(self.core.lock().unwrap().state()),
            "stop" => {
                self.stop();
                Ok(json!({"success":true}))
            }
            "ui" => {
                let c = self.core.lock().unwrap();
                Ok(
                    json!({"html":c.ui,"fileName":c.ui_filename,"sessionId":c.id,"scriptPath":c.script}),
                )
            }
            "setFlushDelay" | "setCopyToClipboard" | "setMaxBufferSize" => {
                let key = match command {
                    "setFlushDelay" => "flushDelayMs",
                    "setCopyToClipboard" => "copyToClipboard",
                    _ => "maxBufferSize",
                };
                Ok(self
                    .core
                    .lock()
                    .unwrap()
                    .configure(key, args.first().cloned().unwrap_or(Value::Null)))
            }
            "rpcCall" | "rpcSend" => {
                let name = args
                    .first()
                    .and_then(Value::as_str)
                    .ok_or("Missing Agent RPC function")?
                    .to_owned();
                let values = args
                    .get(1)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let (reply, wait) = mpsc::channel();
                let cmd = if command == "rpcCall" {
                    Command::Rpc(name, values, reply)
                } else {
                    Command::Send(name, values, reply)
                };
                self.commands
                    .send(cmd)
                    .map_err(|_| "Agent session has ended")?;
                wait.recv_timeout(Duration::from_secs(15))
                    .map_err(|_| "Agent RPC timed out")?
            }
            _ => Err(format!("Unknown Agent command: {command}")),
        }
    }
}
fn drain(core: &Arc<Mutex<Core>>, emit: &Arc<dyn Fn(Event) + Send + Sync>) {
    let events = core.lock().unwrap().drain();
    for event in events {
        emit(event)
    }
}
fn run(
    core: &Arc<Mutex<Core>>,
    cancel: &Arc<Cancellation>,
    commands: mpsc::Receiver<Command>,
    emit: Arc<dyn Fn(Event) + Send + Sync>,
) -> Result<(), String> {
    let context = Context::new();
    let options = core.lock().unwrap().options.clone();
    let _wine = crate::wine::launch(&options, cancel, &|message| {
        core.lock().unwrap().log(message, "info")
    })?;
    let address = _wine.as_ref().map(|w| w.address.as_str());
    let device = Device::open(address, cancel)?;
    let pid = if _wine.is_some() {
        let exe = options["exeName"].as_str().unwrap_or("").to_lowercase();
        device
            .processes(cancel)?
            .into_iter()
            .find(|(_, name)| name.to_lowercase() == exe)
            .map(|p| p.0)
            .ok_or("Could not find the game inside Wine")?
    } else {
        options["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= u32::MAX as u64)
            .ok_or("Invalid Agent target PID")? as u32
    };
    let session = device.attach(pid, cancel)?;
    let (source, name) = {
        let mut c = core.lock().unwrap();
        c.status_event();
        c.log(
            &format!(
                "Agent runtime: native Rust / Frida {}",
                crate::FRIDA_VERSION
            ),
            "info",
        );
        (
            format!(
                "{}\n{}\n;send({{cmd:'__gsm_agent_initialized'}});",
                include_str!("../assets/compat.js"),
                fs::read_to_string(&c.loader).map_err(|e| e.to_string())?
            ),
            format!(
                "GSM Agent: {}",
                c.script.file_name().unwrap_or_default().to_string_lossy()
            ),
        )
    };
    let pending: Arc<Mutex<HashMap<u64, (Instant, Reply)>>> = Arc::new(Mutex::new(HashMap::new()));
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut next_rpc = 1u64;
    let script = loop {
        if cancel.cancelled() {
            return Err("Agent startup cancelled".into());
        }
        let attempt = core.lock().unwrap().begin_attempt();
        let state = core.clone();
        let responses = pending.clone();
        let callback_emit = emit.clone();
        let script = session.script(&source, &name, cancel, move |poster, message, data| {
            if message["type"] == "send" && message["payload"][0] == "frida:rpc" {
                let p = &message["payload"];
                if let Some((_, reply)) = p[1]
                    .as_u64()
                    .and_then(|id| responses.lock().unwrap().remove(&id))
                {
                    let result = if p[2] == "ok" {
                        Ok(if let Some(bytes) = &data {
                            let buffer = json!({"type":"Buffer","data":bytes});
                            if p.as_array().is_some_and(|p| p.len() > 4) {
                                json!([p[4], buffer])
                            } else {
                                buffer
                            }
                        } else {
                            p[3].clone()
                        })
                    } else {
                        Err(p[3].as_str().unwrap_or("Agent RPC failed").to_owned())
                    };
                    let _ = reply.send(result);
                }
                return;
            }
            let echo = matches!(
                message["payload"]["cmd"].as_str(),
                Some("loadHtml" | "rpc_send" | "rpc_invoke" | "re_attach")
            );
            let reply = state
                .lock()
                .unwrap()
                .message(attempt, message, data.as_deref());
            if let Some(reply) = reply {
                let _ = poster.post(reply, if echo { data.as_deref() } else { None });
            }
            drain(&state, &callback_emit);
        })?;
        let loaded = script.load(cancel);
        let initialized_by = Instant::now() + Duration::from_secs(5);
        while loaded.is_ok() && !cancel.cancelled() && Instant::now() < initialized_by {
            context.tick();
            drain(core, &emit);
            if core
                .lock()
                .unwrap()
                .initialization
                .as_ref()
                .is_none_or(|i| i.completed)
            {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        if cancel.cancelled() {
            return Err("Agent startup cancelled".into());
        }
        let error = loaded
            .err()
            .or_else(|| core.lock().unwrap().init_error())
            .or_else(|| {
                core.lock().unwrap().initialization.as_ref().and_then(|i| {
                    (!i.completed).then(|| "Agent loader did not finish initializing".into())
                })
            });
        let Some(error) = error else {
            core.lock().unwrap().ready();
            break script;
        };
        let retry = Instant::now() < deadline && core.lock().unwrap().retryable(&error);
        let _ = script.unload(cancel);
        drop(script);
        if !retry {
            return Err(error);
        }
        core.lock()
            .unwrap()
            .log("Unity is still loading; waiting for Agent hooks…", "info");
        drain(core, &emit);
        let until = Instant::now() + Duration::from_millis(500);
        while Instant::now() < until && !cancel.cancelled() {
            context.tick();
            thread::sleep(Duration::from_millis(10));
        }
    };
    drain(core, &emit);
    while !cancel.cancelled() && !session.detached() && !core.lock().unwrap().stop_requested {
        context.tick();
        core.lock().unwrap().tick();
        drain(core, &emit);
        pending.lock().unwrap().retain(|_, (created, reply)| {
            if created.elapsed() >= Duration::from_secs(15) {
                let _ = reply.send(Err("Agent RPC timed out".into()));
                false
            } else {
                true
            }
        });
        for command in commands.try_iter() {
            match command {
                Command::Rpc(name, args, reply) => {
                    let id = next_rpc;
                    next_rpc += 1;
                    pending.lock().unwrap().insert(id, (Instant::now(), reply));
                    if let Err(e) = script.post(json!(["frida:rpc", id, "call", name, args])) {
                        if let Some((_, reply)) = pending.lock().unwrap().remove(&id) {
                            let _ = reply.send(Err(e));
                        }
                    }
                }
                Command::Send(name, args, reply) => {
                    let result = script
                        .post(json!({"type":name,"args":args}))
                        .map(|_| json!({"success":true}));
                    let _ = reply.send(result);
                }
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
    for (_, (_, reply)) in pending.lock().unwrap().drain() {
        let _ = reply.send(Err("Agent session ended".into()));
    }
    core.lock().unwrap().stop();
    drain(core, &emit);
    // Use a fresh cancellable for teardown after startup/runtime cancellation.
    let cleanup = Cancellation::new();
    let _ = script.unload(&cleanup);
    drop(script);
    let _ = session.detach(&cleanup);
    drop(session);
    drop(device);
    Ok(())
}
