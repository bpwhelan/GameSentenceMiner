//! Native desktop runtime: authenticated local transport, correlated requests,
//! acknowledged text delivery, and owned Python process lifetimes.
mod process;
pub mod backend;
pub mod task;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, Semaphore},
};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
use uuid::Uuid;

type Reply = oneshot::Sender<Result<Value, String>>;
type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;
const LIMIT: usize = 256;
const FRAME_LIMIT: usize = 8 * 1024 * 1024;
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn envelope(dst: &str, topic: &str, kind: &str, data: Value) -> Value {
    json!({"v":1,"id":id(),"src":"main","dst":dst,"topic":topic,"kind":kind,"data":data})
}
fn valid(value: &Value) -> bool {
    value["v"] == 1
        && ["id", "src", "dst", "topic"].iter().all(|key| {
            value[*key]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 256)
        })
        && matches!(
            string(value, "kind"),
            "hello" | "event" | "command" | "request" | "response" | "ack" | "error"
        )
}

enum Command {
    Call(String, Value, Reply),
    Connect(Value, u64, mpsc::Sender<Value>, oneshot::Sender<bool>),
    Frame(String, u64, Value),
    Disconnect(String, u64),
    Log(String, String, String, String),
    Shutdown,
}
pub struct Runtime {
    tx: mpsc::Sender<Command>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    info: Value,
}
impl Runtime {
    pub fn start(
        options: Value,
        sink: impl Fn(&str, Value) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        if options["host"]
            .as_str()
            .is_some_and(|host| host != "127.0.0.1" && host != "localhost")
        {
            return Err("The desktop bus is loopback only".into());
        }
        let (tx, rx) = mpsc::channel(512);
        let commands = tx.clone();
        let (started, ready) = std::sync::mpsc::sync_channel(1);
        let sink: Sink = Arc::new(sink);
        let worker = thread::Builder::new()
            .name("gsm-runtime".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = started.send(Err(e.to_string()));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let port = options["port"].as_u64().unwrap_or(0);
                    if port > u16::MAX as u64 {
                        let _ = started.send(Err("Invalid bus port".into()));
                        return;
                    }
                    let listener = match TcpListener::bind(("127.0.0.1", port as u16)).await {
                        Ok(listener) => listener,
                        Err(e) => {
                            let _ = started.send(Err(e.to_string()));
                            return;
                        }
                    };
                    let port = listener.local_addr().unwrap().port();
                    let token = options["token"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{}{}", id(), id()));
                    let info = json!({"port":port,"token":token});
                    let _ = started.send(Ok(info.clone()));
                    Actor::new(info, commands, sink).run(listener, rx).await;
                });
            })
            .map_err(|e| e.to_string())?;
        match ready.recv().map_err(|e| e.to_string())? {
            Ok(info) => Ok(Self {
                tx,
                worker: Mutex::new(Some(worker)),
                info,
            }),
            Err(error) => {
                let _ = worker.join();
                Err(error)
            }
        }
    }
    pub fn info(&self) -> Value {
        self.info.clone()
    }
    pub async fn call(&self, action: &str, params: Value) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Call(action.into(), params, tx))
            .await
            .map_err(|_| "Native runtime stopped")?;
        rx.await.map_err(|_| "Native runtime stopped".to_string())?
    }
    pub fn submit_text(
        &self,
        payload: Value,
    ) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send(Command::Call("text.submit".into(), payload, tx))
            .map_err(|_| "Native delivery queue is busy or closed")?;
        Ok(rx)
    }
    pub fn shutdown(&self) {
        let Some(worker) = self.worker.lock().unwrap().take() else {
            return;
        };
        // Safe from either a synchronous desktop exit callback or a Tokio task.
        let tx = self.tx.clone();
        let _ = thread::spawn(move || tx.blocking_send(Command::Shutdown)).join();
        let _ = worker.join();
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct Client {
    epoch: u64,
    output: mpsc::Sender<Value>,
}
enum Destination {
    Native(Reply),
    Text(String),
    Relay { client: String, epoch: u64 },
}
struct Pending {
    dst: String,
    epoch: u64,
    topic: String,
    until: Instant,
    destination: Destination,
}
struct Observation {
    order: u64,
    payload: Value,
    due: Instant,
    request: Option<String>,
    attempts: usize,
}
struct Managed {
    spec: Value,
    run: String,
    child: Option<process::OwnedChild>,
    token: String,
    state: String,
    initialized: bool,
    stopping: bool,
    stop_due: Option<Instant>,
    restart_due: Option<Instant>,
    restarts: VecDeque<Instant>,
    stop_replies: Vec<Reply>,
    cleanup_failed: bool,
}
struct Actor {
    info: Value,
    tx: mpsc::Sender<Command>,
    sink: Sink,
    clients: HashMap<String, Client>,
    pending: HashMap<String, Pending>,
    observations: HashMap<String, Observation>,
    observation_sequence: u64,
    processes: HashMap<String, Managed>,
}
impl Actor {
    fn new(info: Value, tx: mpsc::Sender<Command>, sink: Sink) -> Self {
        Self {
            info,
            tx,
            sink,
            clients: HashMap::new(),
            pending: HashMap::new(),
            observations: HashMap::new(),
            observation_sequence: 0,
            processes: HashMap::new(),
        }
    }
    fn emit(&self, event: &str, data: Value) {
        (self.sink)(event, data);
    }
    async fn run(mut self, listener: TcpListener, mut rx: mpsc::Receiver<Command>) {
        let permits = Arc::new(Semaphore::new(128));
        let mut epoch = 0u64;
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        loop {
            tokio::select! {
                accepted = listener.accept() => if let Ok((socket,_)) = accepted {
                    if let Ok(permit) = permits.clone().try_acquire_owned() { epoch += 1; let tx = self.tx.clone(); tokio::spawn(async move { let _permit = permit; connection(socket, epoch, tx).await; }); }
                },
                command = rx.recv() => match command {
                    None | Some(Command::Shutdown) => break,
                    Some(Command::Call(action, params, reply)) => self.call(&action, params, reply),
                    Some(Command::Connect(hello, epoch, output, reply)) => { let ok = self.connect(hello, epoch, output); let _ = reply.send(ok); },
                    Some(Command::Disconnect(client, epoch)) => self.disconnect(&client, epoch),
                    Some(Command::Frame(client, epoch, mut message)) => {
                        if self.clients.get(&client).is_some_and(|c| c.epoch == epoch) { message["src"] = json!(client); self.route(message, epoch); }
                    },
                    Some(Command::Log(client, run, stream, message)) => {
                        if self.processes.get(&client).is_some_and(|p| p.run == run) { self.emit("process.log", json!({"id":client,"runId":run,"stream":stream,"message":message})); }
                    }
                },
                _ = tick.tick() => self.tick(),
            }
        }
        self.clients.clear();
        for (_, pending) in self.pending.drain() {
            if let Destination::Native(reply) = pending.destination {
                let _ = reply.send(Err("Native runtime shutting down".into()));
            }
        }
        // Dropping owned jobs/groups also reaps workers if the Python parent crashed.
        self.processes.clear();
    }
    fn connect(&mut self, hello: Value, epoch: u64, output: mpsc::Sender<Value>) -> bool {
        let client = string(&hello, "src").to_owned();
        if !valid(&hello) || hello["kind"] != "hello" || matches!(client.as_str(), "main" | "*") {
            return false;
        }
        let pid = hello["data"]["pid"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok());
        let authenticated = if let Some(process) = self.processes.get(&client) {
            process
                .child
                .as_ref()
                .is_some_and(|child| pid.is_some_and(|pid| child.owns_pid(pid)))
                && hello["data"]["token"] == process.token
        } else {
            hello["data"]["token"] == self.info["token"]
        };
        if !authenticated {
            return false;
        }
        if let Some(old) = self.clients.get(&client) {
            self.disconnect(&client, old.epoch);
        }
        let _ = output.try_send(envelope(
            &client,
            "bus.welcome",
            "ack",
            json!({"protocol":1,"runtime":"rust"}),
        ));
        self.clients
            .insert(client.clone(), Client { epoch, output });
        self.emit(
            "bus.connected",
            json!({"id":client,"pid":pid,"version":hello["data"]["version"]}),
        );
        if let Some(mut process) = self.processes.remove(&client) {
            if !process.stopping {
                self.state(&client, &mut process, "ready");
            }
            self.processes.insert(client, process);
        }
        true
    }
    fn disconnect(&mut self, client: &str, epoch: u64) {
        if !self.clients.get(client).is_some_and(|c| c.epoch == epoch) {
            return;
        }
        self.clients.remove(client);
        self.emit("bus.disconnected", json!({"id":client}));
        let requests: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.dst == client && p.epoch == epoch)
            .map(|(id, _)| id.clone())
            .collect();
        for request in requests {
            self.complete(&request, Err(format!("{client} disconnected")));
        }
        self.pending.retain(|_,p| !matches!(&p.destination, Destination::Relay { client: source, epoch: generation } if source == client && *generation == epoch));
        if let Some(mut process) = self.processes.remove(client) {
            if process.state == "ready" && !process.stopping {
                self.state(client, &mut process, "starting");
            }
            self.processes.insert(client.into(), process);
        }
    }
    fn send(&mut self, client: &str, message: Value) -> bool {
        if client == "main" {
            self.emit("bus.message", message);
            return true;
        }
        let failed = self
            .clients
            .get(client)
            .and_then(|c| c.output.try_send(message).err().map(|_| c.epoch));
        if let Some(epoch) = failed {
            self.disconnect(client, epoch);
            return false;
        }
        self.clients.contains_key(client)
    }
    fn request(&mut self, message: Value, destination: Destination, timeout: Duration) {
        let key = string(&message, "id").to_owned();
        let dst = string(&message, "dst").to_owned();
        let epoch = if dst == "main" {
            Some(0)
        } else {
            self.clients.get(&dst).map(|c| c.epoch)
        };
        let pending = Pending {
            dst: dst.clone(),
            epoch: epoch.unwrap_or(0),
            topic: string(&message, "topic").into(),
            until: Instant::now() + timeout,
            destination,
        };
        if self.pending.len() >= 512 || self.pending.contains_key(&key) {
            self.deliver_result(
                &key,
                pending,
                Err("Too many pending requests or duplicate request ID".into()),
            );
            return;
        }
        if epoch.is_none() || dst == "*" {
            self.deliver_result(&key, pending, Err(format!("{dst} is not connected")));
            return;
        }
        self.pending.insert(key.clone(), pending);
        if !self.send(&dst, message) {
            self.complete(&key, Err(format!("{dst} is not connected")));
        }
    }
    fn route(&mut self, message: Value, epoch: u64) {
        let src = string(&message, "src").to_owned();
        let dst = string(&message, "dst").to_owned();
        if src == "backend"
            && message["topic"] == "backend.event"
            && message["data"]["function"] == "initialized"
        {
            if let Some(process) = self.processes.get_mut("backend") {
                process.initialized = true;
            }
        }
        match string(&message, "kind") {
            "response" => {
                let key = string(&message, "corr");
                if self.pending.get(key).is_some_and(|p| {
                    p.dst == src && p.epoch == epoch && p.topic == message["topic"]
                }) {
                    self.complete(
                        key,
                        if message["ok"] == false {
                            Err(message["error"].as_str().unwrap_or("Request failed").into())
                        } else {
                            Ok(message["data"].clone())
                        },
                    );
                }
            }
            "request" => self.request(
                message,
                Destination::Relay { client: src, epoch },
                Duration::from_secs(300),
            ),
            "event" | "command" => {
                if dst == "*" {
                    let clients: Vec<_> = self
                        .clients
                        .keys()
                        .filter(|client| **client != src)
                        .cloned()
                        .collect();
                    for client in clients {
                        self.send(&client, message.clone());
                    }
                    self.send("main", message);
                } else {
                    self.send(&dst, message);
                }
            }
            _ => {}
        }
    }
    fn complete(&mut self, key: &str, result: Result<Value, String>) {
        if let Some(pending) = self.pending.remove(key) {
            self.deliver_result(key, pending, result);
        }
    }
    fn deliver_result(&mut self, key: &str, pending: Pending, result: Result<Value, String>) {
        match pending.destination {
            Destination::Native(reply) => {
                let _ = reply.send(result);
            }
            Destination::Relay { client, epoch } => {
                if client == "main" || self.clients.get(&client).is_some_and(|c| c.epoch == epoch) {
                    let mut response = envelope(
                        &client,
                        &pending.topic,
                        "response",
                        result.as_ref().ok().cloned().unwrap_or(Value::Null),
                    );
                    response["src"] = json!(pending.dst);
                    response["corr"] = json!(key);
                    response["ok"] = json!(result.is_ok());
                    if let Err(error) = result {
                        response["error"] = json!(error);
                    }
                    self.send(&client, response);
                }
            }
            Destination::Text(observation) => {
                if let Ok(ack) = result {
                    if ack["status"] != "backpressured"
                        && ack["observation_id"] == observation
                        && matches!(
                            string(&ack, "status"),
                            "accepted" | "duplicate" | "stale_excluded" | "rejected"
                        )
                    {
                        let payload = self.observations.remove(&observation).map(|o| o.payload);
                        self.emit(
                            "text.ack",
                            json!({"id":observation,"ack":ack,"payload":payload}),
                        );
                        return;
                    }
                }
                if let Some(item) = self.observations.get_mut(&observation) {
                    item.request = None;
                    item.due = Instant::now()
                        + Duration::from_millis([50, 100, 200, 400][item.attempts.min(3)]);
                    item.attempts += 1;
                }
            }
        }
    }
    fn call(&mut self, action: &str, params: Value, reply: Reply) {
        let result = match action {
            "bus.info" => Ok(self.info.clone()),
            "bus.clients" => Ok(json!(self.clients.keys().collect::<Vec<_>>())),
            "backend.command" => Ok(json!(self.send("backend", envelope("backend", "backend.command", "command", params)))),
            "bus.request" => {
                let message = envelope(
                    string(&params, "dst"),
                    string(&params, "topic"),
                    "request",
                    params["data"].clone(),
                );
                self.request(
                    message,
                    Destination::Native(reply),
                    Duration::from_millis(
                        params["timeoutMs"]
                            .as_u64()
                            .unwrap_or(15000)
                            .clamp(1, 3600000),
                    ),
                );
                return;
            }
            "bus.publish" => {
                let kind = if params["kind"] == "command" {
                    "command"
                } else {
                    "event"
                };
                self.route(
                    envelope(
                        string(&params, "dst"),
                        string(&params, "topic"),
                        kind,
                        params["data"].clone(),
                    ),
                    0,
                );
                Ok(Value::Null)
            }
            "bus.reply" => {
                let mut message = params;
                message["src"] = json!("main");
                message["kind"] = json!("response");
                self.route(message, 0);
                Ok(Value::Null)
            }
            "text.submit" => {
                let mut payload = params;
                let observation = payload["observationId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(id);
                if self.observations.contains_key(&observation) {
                    Ok(json!(observation))
                } else if self.observations.len() >= LIMIT {
                    Err("Text queue is full (256 observations awaiting acknowledgement)".into())
                } else if payload["text"].as_str().is_none() {
                    Err("Text observation requires text".into())
                } else {
                    payload["observationId"] = json!(observation);
                    for field in ["capturedAt", "emittedAt"] {
                        if payload[field].is_null() {
                            payload[field] = json!(now());
                        }
                    }
                    self.observation_sequence += 1;
                    self.observations.insert(
                        observation.clone(),
                        Observation {
                            order: self.observation_sequence,
                            payload,
                            due: Instant::now(),
                            request: None,
                            attempts: 0,
                        },
                    );
                    Ok(json!(observation))
                }
            }
            "text.clear" => {
                self.observations.clear();
                self.pending
                    .retain(|_, p| !matches!(p.destination, Destination::Text(_)));
                Ok(Value::Null)
            }
            "text.count" => Ok(json!(self.observations.len())),
            "process.start" => self.start_process(params),
            "process.state" => Ok(self
                .processes
                .get(string(&params, "id"))
                .map(|p| self.snapshot(string(&params, "id"), p))
                .unwrap_or(json!({"state":"stopped","pid":null}))),
            "process.priority" => match self.processes.get_mut(string(&params, "id")) {
                Some(process) if params["runId"] == process.run && process.child.is_some() => {
                    process.spec["priority"] = params["priority"].clone();
                    process
                        .child
                        .as_ref()
                        .unwrap()
                        .set_priority(string(&params, "priority"))
                        .map(|_| Value::Null)
                }
                _ => Err("Process lifetime is no longer active".into()),
            },
            "process.stop" => {
                self.stop_process(params, reply);
                return;
            }
            "process.list" => Ok(json!(self.processes.keys().collect::<Vec<_>>())),
            _ => Err(format!("Unknown native runtime operation: {action}")),
        };
        let _ = reply.send(result);
    }
    fn snapshot(&self, name: &str, process: &Managed) -> Value {
        json!({"id":name,"runId":process.run,"pid":process.child.as_ref().map(|p|p.child.id()),"state":process.state,"initialized":process.initialized})
    }
    fn state(&self, name: &str, process: &mut Managed, state: &str) {
        if process.state != state {
            process.state = state.into();
            self.emit("process.state", self.snapshot(name, process));
        }
    }
    fn spawn(&mut self, name: &str, process: &mut Managed) -> Result<(), String> {
        process.token = format!("{}{}", id(), id());
        let mut env: HashMap<String, String> = process.spec["env"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.into())))
            .collect();
        env.insert("GSM_BROKER_PORT".into(), self.info["port"].to_string());
        env.insert("GSM_BROKER_TOKEN".into(), process.token.clone());
        env.insert("GSM_CLIENT_ID".into(), name.into());
        let mut child = process::OwnedChild::spawn(&process.spec, env)?;
        for (stream, pipe) in [
            (
                "stdout",
                child
                    .child
                    .stdout
                    .take()
                    .map(|p| Box::new(p) as Box<dyn Read + Send>),
            ),
            (
                "stderr",
                child
                    .child
                    .stderr
                    .take()
                    .map(|p| Box::new(p) as Box<dyn Read + Send>),
            ),
        ] {
            if let Some(pipe) = pipe {
                read_log(
                    pipe,
                    self.tx.clone(),
                    name.into(),
                    process.run.clone(),
                    stream.into(),
                );
            }
        }
        process.child = Some(child);
        process.initialized = false;
        process.restart_due = None;
        process.stop_due = None;
        self.state(name, process, "starting");
        self.emit("process.spawned", self.snapshot(name, process));
        if process.spec["readyOn"] == "spawn" {
            self.state(name, process, "ready");
        }
        Ok(())
    }
    fn start_process(&mut self, spec: Value) -> Result<Value, String> {
        let name = string(&spec, "id").to_owned();
        if name.is_empty() || matches!(name.as_str(), "main" | "*") {
            return Err("Invalid process ID".into());
        }
        if self
            .processes
            .get(&name)
            .is_some_and(|p| p.child.is_some() || p.restart_due.is_some())
        {
            return Err(format!("{name} is already running"));
        }
        if self.clients.contains_key(&name) {
            return Err(format!("{name} already has an unmanaged connection"));
        }
        let mut process = Managed {
            spec,
            run: id(),
            child: None,
            token: String::new(),
            state: "stopped".into(),
            initialized: false,
            stopping: false,
            stop_due: None,
            restart_due: None,
            restarts: VecDeque::new(),
            stop_replies: vec![],
            cleanup_failed: false,
        };
        self.spawn(&name, &mut process)?;
        let state = self.snapshot(&name, &process);
        self.processes.insert(name, process);
        Ok(state)
    }
    fn stop_process(&mut self, params: Value, reply: Reply) {
        let name = string(&params, "id");
        let Some(mut process) = self.processes.remove(name) else {
            let _ = reply.send(Ok(Value::Null));
            return;
        };
        if params["runId"]
            .as_str()
            .is_some_and(|run| run != process.run)
        {
            let _ = reply.send(Err("Process lifetime has been replaced".into()));
            self.processes.insert(name.into(), process);
            return;
        }
        process.stop_replies.push(reply);
        if process.cleanup_failed {
            process.cleanup_failed = false;
            process.stopping = false;
        }
        if !process.stopping {
            process.stopping = true;
            process.restart_due = None;
            self.state(name, &mut process, "stopping");
            let grace = &process.spec["gracefulStop"];
            let timeout = if params["force"] == true || !self.clients.contains_key(name) {
                0
            } else {
                grace["timeoutMs"].as_u64().unwrap_or(0).min(30000)
            };
            process.stop_due = Some(Instant::now() + Duration::from_millis(timeout));
            if timeout > 0 {
                let data = params
                    .get("gracefulStopData")
                    .unwrap_or(&grace["data"])
                    .clone();
                self.send(
                    name,
                    envelope(name, string(grace, "topic"), "command", data),
                );
            }
        }
        self.processes.insert(name.into(), process);
    }
    fn tick(&mut self) {
        let now = Instant::now();
        let expired: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.until <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.complete(&id, Err("Request timed out".into()));
        }
        if self.clients.contains_key("backend") {
            // One acknowledged observation at a time preserves capture order,
            // including while the first line is backpressured or retried.
            let due: Vec<_> = self
                .observations
                .iter()
                .min_by_key(|(_, item)| item.order)
                .filter(|(_, item)| item.request.is_none() && item.due <= now)
                .map(|(id, _)| id.clone())
                .into_iter()
                .collect();
            for observation in due {
                let item = self.observations.get_mut(&observation).unwrap();
                let message = envelope(
                    "backend",
                    "text.ingress.v2",
                    "request",
                    item.payload.clone(),
                );
                item.request = Some(string(&message, "id").into());
                self.request(
                    message,
                    Destination::Text(observation),
                    Duration::from_millis(350),
                );
            }
        }
        let names: Vec<_> = self.processes.keys().cloned().collect();
        for name in names {
            let mut process = self.processes.remove(&name).unwrap();
            if process.cleanup_failed {
                self.processes.insert(name, process);
                continue;
            }
            if process.restart_due.is_some_and(|due| due <= now) {
                if let Err(error) = self.spawn(&name, &mut process) {
                    process.restart_due = None;
                    self.finish(&name, &mut process, Some(1), Some(error));
                }
            }
            if process.stopping && process.stop_due.is_some_and(|due| due <= now) {
                if let Some(child) = process.child.as_mut() {
                    if let Err(error) = child.terminate() {
                        for reply in process.stop_replies.drain(..) {
                            let _ = reply.send(Err(error.clone()));
                        }
                    }
                }
            }
            let exit = process
                .child
                .as_mut()
                .and_then(|child| child.child.try_wait().ok().flatten());
            if let Some(status) = exit {
                self.finish(&name, &mut process, status.code(), None);
            } else if process.stopping && process.child.is_none() {
                self.finish(&name, &mut process, Some(0), None);
            }
            self.processes.insert(name, process);
        }
    }
    fn finish(
        &mut self,
        name: &str,
        process: &mut Managed,
        code: Option<i32>,
        error: Option<String>,
    ) {
        // A parent exit alone does not prove that its workers released files.
        if let Some(child) = process.child.as_mut() {
            if let Err(error) = child.terminate() {
                process.cleanup_failed = true;
                process.stopping = true;
                process.restart_due = None;
                self.state(name, process, "stopping");
                self.emit("process.error", json!({"id":name,"runId":process.run,"error":format!("Could not finish owned process cleanup: {error}")}));
                for reply in process.stop_replies.drain(..) {
                    let _ = reply.send(Err(error.clone()));
                }
                return;
            }
        }
        drop(process.child.take());
        if let Some(client) = self.clients.get(name) {
            self.disconnect(name, client.epoch);
        }
        let before_initialization = !process.initialized;
        let backend_policy = name == "backend" && process.spec["recoverRuntimeCrashes"] == true;
        let policy = process.spec["autoRestart"].clone();
        if backend_policy {
            process
                .restarts
                .retain(|time| time.elapsed() < Duration::from_secs(60));
        }
        let limit = if backend_policy {
            3
        } else {
            policy["maxRetries"].as_u64().unwrap_or(3) as usize
        };
        let restart = !process.stopping
            && error.is_none()
            && code != Some(0)
            && (backend_policy && process.initialized || policy["enabled"] == true)
            && process.restarts.len() < limit;
        if !process.stopping && code != Some(0) {
            self.emit("process.crashed",json!({"id":name,"runId":process.run,"code":code,"beforeInitialization":before_initialization,"restarting":restart,"error":error}));
        }
        self.state(
            name,
            process,
            if process.stopping || code == Some(0) {
                "stopped"
            } else {
                "crashed"
            },
        );
        if restart {
            let delay = if backend_policy {
                1000
            } else {
                policy["initialDelayMs"]
                    .as_u64()
                    .unwrap_or(1000)
                    .saturating_mul(2u64.saturating_pow(process.restarts.len().min(32) as u32))
                    .min(policy["maxDelayMs"].as_u64().unwrap_or(30000))
            };
            process.restarts.push_back(Instant::now());
            process.restart_due = Some(Instant::now() + Duration::from_millis(delay));
        } else {
            process.restart_due = None;
            process.stop_due = None;
            self.emit("process.exit",json!({"id":name,"runId":process.run,"code":code,"beforeInitialization":before_initialization,"intentional":process.stopping,"error":error}));
            process.stopping = false;
            for reply in process.stop_replies.drain(..) {
                let _ = reply.send(Ok(Value::Null));
            }
        }
    }
}

async fn connection(socket: TcpStream, epoch: u64, tx: mpsc::Sender<Command>) {
    let config = WebSocketConfig::default()
        .max_message_size(Some(FRAME_LIMIT))
        .max_frame_size(Some(FRAME_LIMIT));
    let Ok(Ok(mut socket)) = tokio::time::timeout(
        Duration::from_secs(10),
        accept_async_with_config(socket, Some(config)),
    )
    .await
    else {
        return;
    };
    let Ok(Some(Ok(Message::Text(raw)))) =
        tokio::time::timeout(Duration::from_secs(10), socket.next()).await
    else {
        return;
    };
    let Ok(hello) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let client = string(&hello, "src").to_owned();
    let (output, mut outgoing) = mpsc::channel(LIMIT);
    let (ready, accepted) = oneshot::channel();
    if tx
        .send(Command::Connect(hello, epoch, output, ready))
        .await
        .is_err()
        || !accepted.await.unwrap_or(false)
    {
        let mut error = envelope(&client, "bus.error", "error", Value::Null);
        error["error"] = json!("Invalid token or client identity");
        let _ = socket.send(Message::Text(error.to_string().into())).await;
        let _ = socket.close(None).await;
        return;
    }
    loop {
        tokio::select! {
            message=outgoing.recv()=>match message {Some(message)=>if tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Text(message.to_string().into()))).await.map_or(true, |r|r.is_err()) {break},None=>break},
            message=socket.next()=>match message {
                Some(Ok(Message::Text(raw)))=>{let Ok(message)=serde_json::from_str::<Value>(&raw) else {break}; if !valid(&message)||message["kind"]=="hello" {break;} if tx.send(Command::Frame(client.clone(),epoch,message)).await.is_err(){break;}}
                Some(Ok(Message::Ping(data)))=>{if socket.send(Message::Pong(data)).await.is_err(){break;}}
                Some(Ok(Message::Pong(_)))=>{},
                _=>break,
            }
        }
    }
    let _ = tx.send(Command::Disconnect(client, epoch)).await;
}
fn read_log(
    mut pipe: Box<dyn Read + Send>,
    tx: mpsc::Sender<Command>,
    client: String,
    run: String,
    stream: String,
) {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            let count = pipe.read(&mut buffer).unwrap_or(0);
            pending.extend_from_slice(&buffer[..count]);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(error) if error.error_len().is_none() && count > 0 => error.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid > 0 {
                let message = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                let _ = tx.try_send(Command::Log(
                    client.clone(),
                    run.clone(),
                    stream.clone(),
                    message,
                ));
            }
            if count == 0 {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests;
