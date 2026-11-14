//! Headless native Agent host; linked only into the separate helper binary.
use crate::{
    core::{now, write_atomic},
    host::{metadata_path, read, send, HOST_ARG, OPTIONS_ARG},
    Runtime,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufReader, Read},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
#[derive(Default)]
struct Subscribers {
    clients: Vec<mpsc::SyncSender<Value>>,
    backlog: Vec<Value>,
    subscribed: bool,
}
/// Returns None for a regular desktop launch. Must run before Tauri initializes.
pub fn entry() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|s| s == HOST_ARG) {
        return None;
    }
    let result = (|| {
        use base64::Engine;
        let encoded = args
            .iter()
            .position(|s| s == OPTIONS_ARG)
            .and_then(|i| args.get(i + 1))
            .ok_or("Missing Agent options")?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|e| e.to_string())?;
        let options = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let token = std::env::var("GSM_AGENT_HOST_TOKEN").map_err(|_| "Missing Agent token")?;
        serve(options, token)
    })();
    Some(match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("Native Agent: {e}");
            1
        }
    })
}
pub fn serve(options: Value, token: String) -> Result<(), String> {
    if token.len() < 32 {
        return Err("Invalid Agent token".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let metadata = metadata_path(
        options["baseDir"]
            .as_str()
            .ok_or("Missing data directory")?,
    );
    let detached = options["detached"] == true;
    let clients: Arc<Mutex<Subscribers>> = Arc::new(Mutex::new(Subscribers::default()));
    let events = clients.clone();
    let runtime = Runtime::start(options, move |(channel, payload)| {
        let event = json!({"kind":"event","channel":channel,"payload":payload});
        let mut subscribers = events.lock().unwrap();
        if !subscribers.subscribed {
            if subscribers.backlog.len() == 256 {
                subscribers.backlog.remove(0);
            }
            subscribers.backlog.push(event.clone());
        }
        subscribers
            .clients
            .retain(|tx| tx.try_send(event.clone()).is_ok());
    })?;
    let info = json!({"version":2,"hostPid":std::process::id(),"port":listener.local_addr().unwrap().port(),"token":token,"startedAt":now()});
    write_atomic(
        &metadata,
        &serde_json::to_vec(&info).map_err(|e| e.to_string())?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&metadata, fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    if !detached {
        let weak = Arc::downgrade(&runtime);
        thread::spawn(move || {
            let _ = std::io::stdin().read(&mut [0u8; 1]);
            if let Some(runtime) = weak.upgrade() {
                runtime.stop();
            }
        });
    }
    let stopping = Arc::new(AtomicBool::new(false));
    let mut ended: Option<Instant> = None;
    loop {
        match listener.accept() {
            Ok((socket, _)) => {
                let runtime = runtime.clone();
                let token = token.clone();
                let clients = clients.clone();
                let stopping = stopping.clone();
                thread::spawn(move || {
                    if let Err(e) = connection(socket, &token, runtime, clients, stopping) {
                        eprintln!("Agent connection: {e}");
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.to_string()),
        }
        let stopped = !runtime.core.lock().unwrap().running || stopping.load(Ordering::Relaxed);
        if stopped {
            let end = ended.get_or_insert_with(Instant::now);
            let failed = runtime
                .core
                .lock()
                .unwrap()
                .start_result
                .as_ref()
                .is_some_and(|r| r["success"] == false);
            if (stopping.load(Ordering::Relaxed)
                || !failed
                || end.elapsed() > Duration::from_secs(10))
                && (runtime.wait(Duration::from_millis(5))
                    || end.elapsed() > Duration::from_secs(8))
            {
                break;
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    runtime.stop();
    if fs::read(&metadata)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|m| m["token"] == token)
    {
        let _ = fs::remove_file(metadata);
    }
    Ok(())
}
fn connection(
    mut socket: TcpStream,
    token: &str,
    runtime: Arc<Runtime>,
    clients: Arc<Mutex<Subscribers>>,
    stopping: Arc<AtomicBool>,
) -> Result<(), String> {
    socket.set_nonblocking(false).map_err(|e| e.to_string())?;
    socket.set_nodelay(true).ok();
    socket.set_read_timeout(Some(Duration::from_secs(5))).ok();
    socket.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let mut reader = BufReader::new(socket.try_clone().map_err(|e| e.to_string())?);
    let hello = read(&mut reader)?;
    if hello["kind"] != "hello" || hello["token"] != token {
        return Err("Unauthorized Agent connection".into());
    }
    send(&mut socket, &json!({"kind":"hello","success":true}))?;
    if hello["subscribe"] == true {
        let (tx, rx) = mpsc::sync_channel(512);
        {
            let mut clients = clients.lock().unwrap();
            for event in clients.backlog.drain(..) {
                let _ = tx.try_send(event);
            }
            clients.subscribed = true;
            clients.clients.push(tx);
        }
        for event in rx.try_iter() {
            send(&mut socket, &event)?;
        }
        send(
            &mut socket,
            &json!({"kind":"event","channel":"agent.state","payload":runtime.request("state",&[])?}),
        )?;
        loop {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(value) => send(&mut socket, &value)?,
                Err(mpsc::RecvTimeoutError::Timeout) => send(&mut socket, &json!({"kind":"ping"}))?,
                Err(_) => return Ok(()),
            }
        }
    }
    let request = read(&mut reader)?;
    if request["kind"] != "request" {
        return Err("Invalid Agent request".into());
    }
    let command = request["command"].as_str().unwrap_or("");
    let result = runtime.request(
        command,
        request["args"].as_array().map(Vec::as_slice).unwrap_or(&[]),
    );
    let response = match result {
        Ok(value) => json!({"kind":"response","id":request["id"],"success":true,"result":value}),
        Err(error) => json!({"kind":"response","id":request["id"],"success":false,"error":error}),
    };
    send(&mut socket, &response)?;
    if command == "stop" {
        stopping.store(true, Ordering::Relaxed)
    }
    Ok(())
}
