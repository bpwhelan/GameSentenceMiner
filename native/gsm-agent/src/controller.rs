//! Desktop-side supervisor. Owns helper processes, authenticated connections,
//! reconnects and cached state; the JavaScript service is only a facade.
use crate::host::{metadata_path, read, send, HOST_ARG, OPTIONS_ARG};
use serde_json::{json, Value};
use std::{
    fs,
    io::BufReader,
    net::{Shutdown, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
type Emit = Arc<dyn Fn(&str, Value, bool) + Send + Sync>;
fn empty() -> Value {
    json!({"status":null,"hooks":{"hooks":[],"selectedHookId":null},"startResult":null})
}
fn metadata(base: &str) -> Option<Value> {
    fs::read(metadata_path(base))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}
struct Connection {
    info: Value,
    state: Mutex<Value>,
    alive: AtomicBool,
    subscription: TcpStream,
    detached: bool,
}
impl Connection {
    fn socket(info: &Value, subscribe: bool) -> Result<(TcpStream, BufReader<TcpStream>), String> {
        let port = info["port"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or("Invalid Agent port")?;
        let token = info["token"]
            .as_str()
            .filter(|s| s.len() >= 32)
            .ok_or("Invalid Agent token")?;
        let mut socket = TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(700),
        )
        .map_err(|e| e.to_string())?;
        socket.set_nodelay(true).ok();
        socket.set_read_timeout(Some(Duration::from_secs(18))).ok();
        socket.set_write_timeout(Some(Duration::from_secs(5))).ok();
        let mut reader = BufReader::new(socket.try_clone().map_err(|e| e.to_string())?);
        send(
            &mut socket,
            &json!({"kind":"hello","token":token,"subscribe":subscribe}),
        )?;
        if read(&mut reader)?["success"] != true {
            return Err("Agent authentication failed".into());
        }
        Ok((socket, reader))
    }
    fn connect(info: Value, detached: bool, emit: Emit) -> Result<Arc<Self>, String> {
        if info["version"] != 2 {
            return Err("An older Agent host is still running; stop it before reconnecting".into());
        }
        let (socket, mut reader) = Self::socket(&info, true)?;
        let current = Arc::new(Self {
            info,
            state: Mutex::new(empty()),
            alive: AtomicBool::new(true),
            subscription: socket,
            detached,
        });
        let weak = Arc::downgrade(&current);
        thread::spawn(move || {
            while let Ok(event) = read(&mut reader) {
                let Some(c) = weak.upgrade() else { return };
                if event["kind"] != "event" {
                    continue;
                }
                let channel = event["channel"].as_str().unwrap_or("");
                let payload = event["payload"].clone();
                {
                    let mut state = c.state.lock().unwrap();
                    match channel {
                        "agent.state" => *state = payload.clone(),
                        "texthook.status" => {
                            state["status"] = if payload["running"] == true {
                                payload.clone()
                            } else {
                                Value::Null
                            }
                        }
                        "texthook.hooks" => state["hooks"] = payload.clone(),
                        _ => {}
                    }
                }
                emit(channel, payload, c.detached);
            }
            if let Some(c) = weak.upgrade() {
                c.alive.store(false, Ordering::Relaxed);
                *c.state.lock().unwrap() = empty();
                emit("texthook.status", json!({"running":false}), c.detached);
                emit(
                    "texthook.hooks",
                    json!({"hooks":[],"selectedHookId":null}),
                    c.detached,
                );
            }
        });
        Ok(current)
    }
    fn request(&self, command: &str, args: &[Value]) -> Result<Value, String> {
        let (mut socket, mut reader) = Self::socket(&self.info, false)?;
        send(
            &mut socket,
            &json!({"kind":"request","id":1,"command":command,"args":args}),
        )?;
        let response = read(&mut reader)?;
        if response["success"] != true {
            return Err(response["error"]
                .as_str()
                .unwrap_or("Agent request failed")
                .into());
        }
        let value = response["result"].clone();
        if command == "state" {
            *self.state.lock().unwrap() = value.clone()
        }
        Ok(value)
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.subscription.shutdown(Shutdown::Both);
    }
}
struct Owned {
    child: Child,
    detached: bool,
}
pub struct Controller {
    connection: Mutex<Option<Arc<Connection>>>,
    child: Mutex<Option<Owned>>,
    start_lock: Mutex<()>,
    generation: Arc<AtomicU64>,
    pending: Mutex<Option<Value>>,
    emit: Emit,
}
impl Controller {
    pub fn new(emit: impl Fn(&str, Value, bool) + Send + Sync + 'static) -> Self {
        Self {
            connection: Mutex::new(None),
            child: Mutex::new(None),
            start_lock: Mutex::new(()),
            generation: Arc::new(AtomicU64::new(0)),
            pending: Mutex::new(None),
            emit: Arc::new(emit),
        }
    }
    pub fn state(&self) -> Value {
        self.connection
            .lock()
            .unwrap()
            .as_ref()
            .filter(|c| c.alive.load(Ordering::Relaxed))
            .map(|c| c.state.lock().unwrap().clone())
            .unwrap_or_else(|| self.pending.lock().unwrap().clone().unwrap_or_else(empty))
    }
    fn emitter(&self, generation: u64) -> Emit {
        let current = self.generation.clone();
        let emit = self.emit.clone();
        Arc::new(move |channel, data, detached| {
            if current.load(Ordering::SeqCst) == generation || channel == "agent.text" {
                emit(channel, data, detached)
            }
        })
    }
    pub fn reconnect(&self, base: &str) -> Result<bool, String> {
        // Status polling and app startup can request reconnect concurrently.
        // Keep one subscription, and never replace a start/stop in progress.
        let Ok(_serial) = self.start_lock.try_lock() else {
            return Ok(self.state()["status"]["running"] == true);
        };
        let generation = self.generation.load(Ordering::SeqCst);
        if self
            .connection
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.alive.load(Ordering::Relaxed))
        {
            return Ok(self.state()["status"]["running"] == true);
        }
        let Some(info) = metadata(base) else {
            return Ok(false);
        };
        if info["version"] == 1 {
            stop_legacy(&info)?;
            (self.emit)(
                "texthook.log",
                json!({"level":"info","message":"The previous Agent host was stopped for the native migration. Start Agent again to use the Rust runtime.","ts":crate::core::now()}),
                true,
            );
            return Ok(false);
        }
        let connection = match Connection::connect(
            info,
            true,
            self.emitter(self.generation.load(Ordering::SeqCst)),
        ) {
            Ok(c) => c,
            Err(_) => return Ok(false),
        };
        let state = connection.request("state", &[])?;
        if state["status"]["agentDetached"] != true {
            return Ok(false);
        }
        let mut current = self.connection.lock().unwrap();
        if self.generation.load(Ordering::SeqCst) != generation {
            return Ok(false);
        }
        *current = Some(connection);
        Ok(state["status"]["running"] == true)
    }
    pub fn start(&self, executable: PathBuf, options: Value) -> Result<Value, String> {
        let _serial = self.start_lock.lock().unwrap();
        self.stop()?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let preview = crate::core::Core::new(options.clone())?.state();
        let base = options["baseDir"]
            .as_str()
            .ok_or("Missing Agent data directory")?;
        let detached = options["detached"] == true;
        stop_saved(base)?;
        use base64::Engine;
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&options).map_err(|e| e.to_string())?);
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        fs::create_dir_all(PathBuf::from(base).join("texthook")).map_err(|e| e.to_string())?;
        let log = fs::File::create(PathBuf::from(base).join("texthook/agent-host.log"))
            .map_err(|e| e.to_string())?;
        let mut cmd = Command::new(executable);
        cmd.args([HOST_ARG, OPTIONS_ARG, &encoded])
            .env("GSM_AGENT_HOST_TOKEN", &token)
            .stdin(if detached {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        {
            let mut owned = self.child.lock().unwrap();
            if self.generation.load(Ordering::SeqCst) != generation {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Agent startup cancelled".into());
            }
            *owned = Some(Owned { child, detached });
            *self.pending.lock().unwrap() = Some(preview);
        }
        let limit = if options["wineLaunch"].is_object() {
            360
        } else {
            40
        };
        let deadline = Instant::now() + Duration::from_secs(limit);
        let mut connected: Option<Arc<Connection>> = None;
        let result = loop {
            if self.generation.load(Ordering::SeqCst) != generation {
                break Err("Agent startup cancelled".into());
            }
            if connected.is_none() {
                if let Some(info) = metadata(base).filter(|m| m["token"] == token) {
                    if let Ok(c) = Connection::connect(info, detached, self.emitter(generation)) {
                        let mut current = self.connection.lock().unwrap();
                        if self.generation.load(Ordering::SeqCst) == generation {
                            *current = Some(c.clone());
                            connected = Some(c);
                        }
                    }
                }
            }
            if let Some(c) = &connected {
                match c.request("state", &[]) {
                    Ok(state) if state["startResult"].is_object() => {
                        if state["startResult"]["success"] == true
                            && state["status"]["running"] != true
                        {
                            break Err("Agent session ended during startup".into());
                        }
                        break Ok(state["startResult"].clone());
                    }
                    Ok(_) => {}
                    Err(e) => break Err(e),
                }
            }
            if let Some(child) = self.child.lock().unwrap().as_mut() {
                if child.child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    break Err(fs::read_to_string(
                        PathBuf::from(base).join("texthook/agent-host.log"),
                    )
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("Native Agent host exited during startup".into()));
                }
            }
            if Instant::now() >= deadline {
                break Err("Agent startup timed out".into());
            }
            thread::sleep(Duration::from_millis(40));
        };
        if result.as_ref().map_or(true, |v| v["success"] != true)
            && self.generation.load(Ordering::SeqCst) == generation
        {
            let _ = self.stop();
        }
        if self.generation.load(Ordering::SeqCst) == generation {
            self.pending.lock().unwrap().take();
        }
        result
    }
    pub fn request(&self, command: &str, args: &[Value]) -> Result<Value, String> {
        let c = self
            .connection
            .lock()
            .unwrap()
            .clone()
            .ok_or("No active Agent hook session")?;
        c.request(command, args)
    }
    pub fn request_session(
        &self,
        session: &str,
        command: &str,
        args: &[Value],
    ) -> Result<Value, String> {
        let c = self
            .connection
            .lock()
            .unwrap()
            .clone()
            .ok_or("Agent session has ended")?;
        if c.state.lock().unwrap()["status"]["sessionId"] != session {
            return Err("This Agent session has ended".into());
        }
        c.request(command, args)
    }
    pub fn stop(&self) -> Result<Value, String> {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.pending.lock().unwrap().take();
        let connection = self.connection.lock().unwrap().take();
        let mut owned = self.child.lock().unwrap().take();
        let result = connection.as_ref().map(|c| c.request("stop", &[]));
        let deadline = Instant::now() + Duration::from_secs(10);
        if let Some(child) = owned.as_mut() {
            child.child.stdin.take();
            loop {
                if child.child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    break;
                }
                if Instant::now() >= deadline {
                    child.child.kill().map_err(|e| e.to_string())?;
                    child.child.wait().map_err(|e| e.to_string())?;
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        } else if let Some(c) = &connection {
            while c.alive.load(Ordering::Relaxed) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            if c.alive.load(Ordering::Relaxed) {
                *self.connection.lock().unwrap() = connection;
                return Err(result
                    .and_then(Result::err)
                    .unwrap_or("Agent host did not stop".into()));
            }
        }
        (self.emit)(
            "texthook.status",
            json!({"running":false}),
            connection.as_ref().is_some_and(|c| c.detached),
        );
        Ok(json!({"success":true}))
    }
    pub fn stop_for_update(&self, base: &str) -> Result<Value, String> {
        self.stop()?;
        stop_saved(base)?;
        Ok(json!({"success":true}))
    }
    pub fn shutdown(&self) {
        let detached = self
            .child
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.detached)
            || self.state()["status"]["agentDetached"] == true;
        if detached {
            self.connection.lock().unwrap().take();
            self.child.lock().unwrap().take();
        } else {
            let _ = self.stop();
        }
    }
}
fn stop_saved(base: &str) -> Result<(), String> {
    let Some(info) = metadata(base) else {
        return Ok(());
    };
    if info["version"] == 1 {
        return stop_legacy(&info);
    }
    if info["version"] != 2 {
        return Err("Unknown Agent host protocol version".into());
    }
    match Connection::connect(info.clone(), true, Arc::new(|_, _, _| {})) {
        Ok(c) => {
            c.request("stop", &[])?;
            let deadline = Instant::now() + Duration::from_secs(10);
            while c.alive.load(Ordering::Relaxed) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            if c.alive.load(Ordering::Relaxed) {
                return Err("Previous Agent host did not stop".into());
            }
        }
        Err(error) => {
            if let Some(port) = info["port"].as_u64().filter(|p| *p > 0 && *p <= 65535) {
                if TcpStream::connect_timeout(
                    &format!("127.0.0.1:{port}").parse().unwrap(),
                    Duration::from_millis(700),
                )
                .is_ok()
                {
                    return Err(format!("Cannot control the existing Agent host: {error}"));
                }
            }
        }
    }
    Ok(())
}
fn stop_legacy(info: &Value) -> Result<(), String> {
    let port = info["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("Invalid legacy Agent port")?;
    let Ok(mut socket) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(700),
    ) else {
        return Ok(());
    };
    socket.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut reader = BufReader::new(socket.try_clone().map_err(|e| e.to_string())?);
    send(&mut socket, &json!({"kind":"hello","token":info["token"]}))?;
    send(
        &mut socket,
        &json!({"kind":"request","id":1,"command":"stop","args":[]}),
    )?;
    loop {
        let msg = read(&mut reader)?;
        if msg["kind"] == "response" && msg["id"] == 1 {
            if msg["success"] != true {
                return Err("The previous Agent host could not stop".into());
            }
            break;
        }
    }
    // Only authenticated protocol control is allowed for an inherited host. A
    // stale/reused PID is never a reason to terminate an unrelated process.
    use std::io::Read;
    loop {
        match reader.read(&mut [0u8; 4096]) {
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ) =>
            {
                return Ok(())
            }
            Err(e) => return Err(format!("Previous Agent host did not close: {e}")),
        }
    }
}
