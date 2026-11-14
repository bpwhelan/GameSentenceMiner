use crate::{
    protocol::{Event, Session},
    target::Target,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;
type Reply = mpsc::SyncSender<Result<Value, String>>;
struct Request {
    action: String,
    params: Value,
    reply: Reply,
}
/// Serializes every lifecycle transition. Pipe readers carry a generation so
/// output or exit from a replaced engine can never mutate its successor.
pub struct Controller {
    sender: Mutex<Option<mpsc::SyncSender<Request>>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}
impl Controller {
    pub fn new(sink: impl Fn(&str, Value) + Send + Sync + 'static) -> Self {
        let (sender, rx) = mpsc::sync_channel(64);
        let sink: Sink = Arc::new(sink);
        let worker = thread::spawn(move || Actor::new(sink).run(rx));
        Self {
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
        }
    }
    pub fn request(&self, action: &str, params: Value) -> Result<Value, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("Text hook service has stopped")?
            .send(Request {
                action: action.into(),
                params,
                reply: tx,
            })
            .map_err(|_| "Text hook worker closed")?;
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "Text hook request timed out")?
    }
    pub fn shutdown(&self) {
        self.sender.lock().unwrap().take();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct Output {
    generation: u64,
    bytes: Vec<u8>,
    stderr: bool,
}
struct Engine {
    child: Child,
    target: Target,
    session: Session,
    started: Instant,
    manual_sent: bool,
    show_sent: bool,
    stderr: String,
}
impl Engine {
    fn write(&mut self, text: &str) -> Result<(), String> {
        let bytes = text
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        self.child
            .stdin
            .as_mut()
            .ok_or("Hook engine input closed")?
            .write_all(&bytes)
            .map_err(|e| e.to_string())
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        // This is always our own child, never the target game or a process name.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Actor {
    engine: Option<Engine>,
    generation: u64,
    sink: Sink,
    output: mpsc::Receiver<Output>,
    output_tx: mpsc::SyncSender<Output>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn read_pipe(
    mut pipe: impl Read + Send + 'static,
    tx: mpsc::SyncSender<Output>,
    generation: u64,
    stderr: bool,
) {
    thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        loop {
            match pipe.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx
                        .send(Output {
                            generation,
                            bytes: bytes[..n].to_vec(),
                            stderr,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
}
impl Actor {
    fn new(sink: Sink) -> Self {
        let (output_tx, output) = mpsc::sync_channel(64);
        Self {
            engine: None,
            generation: 0,
            sink,
            output,
            output_tx,
        }
    }
    fn log(&self, message: impl Into<String>) {
        (self.sink)(
            "texthook.log",
            json!({"message":message.into(),"level":"info","ts":now()}),
        );
    }
    fn status(&self) -> Value {
        self.engine
            .as_ref()
            .map(|e| e.session.status())
            .unwrap_or(json!({"running":false}))
    }
    fn publish_status(&self) {
        (self.sink)("texthook.status", self.status());
    }
    fn start(&mut self, options: Value) -> Result<Value, String> {
        if self.engine.is_some() {
            return Err("A text hook session is already running.".into());
        }
        if !matches!(options["engine"].as_str(), Some("luna" | "textractor")) {
            return Err("Unsupported native CLI engine".into());
        }
        let pid = options["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= u32::MAX as u64)
            .ok_or("Invalid target PID")? as u32;
        let attach_pid = options["attachPid"].as_u64().unwrap_or(pid as u64);
        if attach_pid == 0 || attach_pid > u32::MAX as u64 {
            return Err("Invalid attach PID".into());
        }
        let target = Target::open(pid)?;
        if !target.alive() {
            return Err("The target process has exited.".into());
        }
        let cli = Path::new(
            options["cliPath"]
                .as_str()
                .ok_or("Missing hook engine path")?,
        );
        if !cli.is_absolute() || !cli.is_file() {
            return Err(format!("Hook engine not found: {}", cli.display()));
        }
        let launcher = options["launcherPath"].as_str().filter(|s| !s.is_empty());
        let mut command = Command::new(launcher.unwrap_or_else(|| cli.to_str().unwrap()));
        if launcher.is_some() {
            command.arg(cli);
        }
        command
            .current_dir(cli.parent().unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(env) = options["env"].as_object() {
            for (k, v) in env {
                if let Some(v) = v.as_str() {
                    command.env(k, v);
                }
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
            let mut paths = vec![cli.parent().unwrap().to_path_buf()];
            paths.extend(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            ));
            if let Ok(path) = std::env::join_paths(paths) {
                command.env("PATH", path);
            }
        }
        let child = command
            .spawn()
            .map_err(|e| format!("Could not launch hook engine: {e}"))?;
        self.generation += 1;
        let mut engine = Engine {
            child,
            target,
            session: Session::new(options.clone()),
            started: Instant::now(),
            manual_sent: false,
            show_sent: false,
            stderr: String::new(),
        };
        read_pipe(
            engine.child.stdout.take().unwrap(),
            self.output_tx.clone(),
            self.generation,
            false,
        );
        read_pipe(
            engine.child.stderr.take().unwrap(),
            self.output_tx.clone(),
            self.generation,
            true,
        );
        engine.write(&format!("attach -P{attach_pid}\n"))?;
        self.engine = Some(engine);
        self.log(format!(
            "Attached {} ({}) to {} (PID {pid}).",
            options["engine"].as_str().unwrap(),
            options["arch"].as_str().unwrap_or("unknown"),
            options["exeName"].as_str().unwrap_or("game")
        ));
        self.publish_status();
        (self.sink)("texthook.hooks", json!({"hooks":[],"selectedHookId":null}));
        Ok(json!({"success":true,"pid":pid,"exeName":options["exeName"],"arch":options["arch"]}))
    }
    fn stop(&mut self, publish: bool) {
        if let Some(engine) = self.engine.as_mut() {
            engine.session.flush();
        }
        // Flush once before publishing stopped; no pending timer survives this.
        let _ = self.deliver(false);
        if let Some(mut engine) = self.engine.take() {
            let pid = engine.session.options["attachPid"]
                .as_u64()
                .or(engine.session.options["pid"].as_u64())
                .unwrap_or_default();
            let _ = engine.write(&format!("detach -P{pid}\n"));
            engine.child.stdin.take();
            let deadline = Instant::now() + Duration::from_millis(250);
            while Instant::now() < deadline && matches!(engine.child.try_wait(), Ok(None)) {
                thread::sleep(Duration::from_millis(10));
            }
            drop(engine);
        }
        if publish {
            self.publish_status();
            (self.sink)("texthook.hooks", json!({"hooks":[],"selectedHookId":null}));
        }
    }
    fn deliver(&mut self, recover: bool) -> Result<(), String> {
        let events = self
            .engine
            .as_mut()
            .map(|e| e.session.drain())
            .unwrap_or_default();
        let mut required = None;
        for event in events {
            match event {
                Event::Text(v) => {
                    (self.sink)("texthook.output", v.clone());
                    (self.sink)(
                        "texthook.text",
                        json!({"hookId":v["hookId"],"text":v["text"],"ts":now()}),
                    );
                }
                Event::Hooks(v) => (self.sink)("texthook.hooks", v),
                Event::Log(v) => self.log(v),
                Event::Command(v) => {
                    if let Some(e) = self.engine.as_mut() {
                        e.write(&v)?;
                    }
                }
                Event::Architecture(v) => required = Some(v),
            }
        }
        if let Some(arch) = required.filter(|_| recover) {
            let options = &self.engine.as_ref().unwrap().session.options;
            if options["arch"] != arch && options["architectureFallbackAttempted"] != true {
                let mut next = options.clone();
                let path = options["cliPaths"][&arch]
                    .as_str()
                    .ok_or("Alternate hook engine is missing")?
                    .to_owned();
                next["arch"] = json!(arch);
                next["cliPath"] = json!(path);
                next["architectureFallbackAttempted"] = json!(true);
                self.log(format!("Retrying hook attachment as {arch}."));
                self.stop(false);
                self.start(next)?;
            }
        }
        Ok(())
    }
    fn request(&mut self, action: &str, params: Value) -> Result<Value, String> {
        match action {
            "start" => self.start(params),
            "stop" => {
                self.stop(true);
                Ok(json!({"success":true}))
            }
            "status" => Ok(self.status()),
            "hooks" => Ok(self
                .engine
                .as_ref()
                .map(|e| e.session.hooks())
                .unwrap_or(json!({"hooks":[],"selectedHookId":null}))),
            "select" => {
                let result = self.engine.as_mut().is_some_and(|e| {
                    e.session
                        .select(params["hookId"].as_str().unwrap_or(""), now())
                });
                self.deliver(true)?;
                self.publish_status();
                Ok(json!(result))
            }
            "manual" => {
                let e = self.engine.as_mut().ok_or("No active text hook session.")?;
                e.write(&e.session.manual(params["code"].as_str().unwrap_or(""))?)?;
                Ok(json!({"success":true}))
            }
            "configure" => {
                if let Some(e) = self.engine.as_mut() {
                    for key in ["flushDelayMs", "copyToClipboard", "maxBufferSize"] {
                        if let Some(value) = params.get(key) {
                            e.session.configure(key, value.clone(), now());
                        }
                    }
                    self.deliver(true)?;
                    self.publish_status();
                }
                Ok(json!({"success":true}))
            }
            _ => Err(format!("Unknown text hook action: {action}")),
        }
    }
    fn pump(&mut self) -> Result<(), String> {
        // Bounded work per iteration keeps stop responsive even if a game floods stdout.
        for _ in 0..16 {
            let Ok(output) = self.output.try_recv() else {
                break;
            };
            if output.generation != self.generation {
                continue;
            }
            if let Some(e) = self.engine.as_mut() {
                if output.stderr {
                    e.stderr.push_str(&String::from_utf8_lossy(&output.bytes));
                    while let Some(pos) = e.stderr.find('\n') {
                        let line = e.stderr[..pos].trim().to_owned();
                        e.stderr.drain(..=pos);
                        e.session.diagnostic(&line);
                    }
                    if e.stderr.len() > 16_384 {
                        e.session.diagnostic(&e.stderr);
                        e.stderr.clear();
                    }
                } else {
                    e.session.feed(&output.bytes, now());
                }
            }
            self.deliver(true)?;
        }
        let mut ended = false;
        if let Some(e) = self.engine.as_mut() {
            e.session.tick(now());
            if !e.show_sent && e.started.elapsed() >= Duration::from_secs(1) {
                e.show_sent = true;
                if e.session.options["engine"] == "luna" {
                    e.write("showall\n")?;
                }
            }
            if !e.manual_sent && e.started.elapsed() >= Duration::from_millis(1500) {
                e.manual_sent = true;
                if let Some(code) = e.session.options["manualHookCode"]
                    .as_str()
                    .filter(|c| !c.is_empty())
                {
                    e.write(&e.session.manual(code)?)?;
                }
            }
            ended = !e.target.alive() || e.child.try_wait().map_err(|e| e.to_string())?.is_some();
        }
        self.deliver(true)?;
        if ended {
            self.log("Hook engine or target exited.");
            self.stop(true);
        }
        Ok(())
    }
    fn run(mut self, rx: mpsc::Receiver<Request>) {
        loop {
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(request) => {
                    let result = self.request(&request.action, request.params);
                    if let Err(e) = &result {
                        self.log(e.clone());
                    }
                    let _ = request.reply.send(result);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Err(error) = self.pump() {
                self.log(format!("Hook session failed: {error}"));
                self.stop(true);
            }
        }
        self.stop(true);
    }
}
