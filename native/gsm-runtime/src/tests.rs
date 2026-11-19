use super::*;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[test]
fn long_running_jobs_live_until_the_requesting_backend_disconnects() {
    let (tx, _) = mpsc::channel(8);
    let mut actor = Actor::new(json!({}), tx, Arc::new(|_, _| {}));
    let (output, _rx) = mpsc::channel(8);
    actor
        .clients
        .insert("backend".into(), Client { epoch: 7, output });
    for (client, topic, data, unbounded) in [
        ("backend", "mining.cron", json!({"action":"next"}), true),
        ("backend", "anki.monitor", json!({"action":"next"}), true),
        ("backend", "anki.monitor", json!({"action":"wake"}), false),
        ("backend", "anki.sync", json!({}), true),
        ("backend", "anki.group", json!({"action":"merge"}), true),
        ("backend", "anki.cards", json!({"action":"latest"}), true),
        ("backend", "anki.cards", json!({"action":"notes"}), false),
        ("backend", "anki.sync.stop", json!({}), false),
        (
            "backend",
            "mining.history",
            json!({"operation":"rebuildRollups"}),
            true,
        ),
        ("backend", "mining.cron", json!({"action":"force"}), false),
        (
            "backend",
            "mining.history",
            json!({"operation":"closeWriter"}),
            false,
        ),
        ("other", "mining.cron", json!({"action":"next"}), false),
        ("other", "anki.sync", json!({}), false),
    ] {
        let mut message = envelope("main", topic, "request", data);
        message["src"] = json!(client);
        let key = string(&message, "id").to_owned();
        actor.route(message, 7);
        assert_eq!(actor.pending[&key].until.is_none(), unbounded);
    }
    actor.disconnect("backend", 7);
    assert_eq!(actor.pending.len(), 2);
}

fn runtime() -> Arc<Runtime> {
    Arc::new(Runtime::start(json!({}), |_, _| {}).unwrap())
}
async fn connect(runtime: &Runtime, name: &str) -> Socket {
    let info = runtime.info();
    let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{}", info["port"]))
        .await
        .unwrap();
    let mut hello = envelope(
        "main",
        "bus.hello",
        "hello",
        json!({"token":info["token"],"pid":std::process::id()}),
    );
    hello["src"] = json!(name);
    socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .unwrap();
    assert_eq!(receive(&mut socket).await["topic"], "bus.welcome");
    socket
}

#[tokio::test]
async fn stopping_broker_releases_connected_services_once() {
    let closed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events = closed.clone();
    let runtime = Runtime::start(json!({}), move |event, data| {
        if event == "bus.disconnected" {
            events.lock().unwrap().push(data["id"].clone());
        }
    })
    .unwrap();
    let _backend = connect(&runtime, "backend").await;
    runtime.shutdown();
    assert_eq!(*closed.lock().unwrap(), vec![json!("backend")]);
}

async fn receive(socket: &mut Socket) -> Value {
    let raw = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(raw.to_text().unwrap()).unwrap()
}
async fn respond(socket: &mut Socket, request: &Value, data: Value) {
    let response = json!({"v":1,"id":id(),"src":"spoofed","dst":request["src"],"topic":request["topic"],"kind":"response","corr":request["id"],"ok":true,"data":data});
    socket
        .send(Message::Text(response.to_string().into()))
        .await
        .unwrap();
}
#[tokio::test]
async fn authentication_and_reserved_main_are_rejected() {
    let runtime = runtime();
    for (name, token) in [
        ("wrong", json!("wrong")),
        ("main", runtime.info()["token"].clone()),
        ("*", runtime.info()["token"].clone()),
    ] {
        let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{}", runtime.info()["port"]))
            .await
            .unwrap();
        let mut hello = envelope("main", "bus.hello", "hello", json!({"token":token}));
        hello["src"] = json!(name);
        socket
            .send(Message::Text(hello.to_string().into()))
            .await
            .unwrap();
        let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap();
        if let Some(Ok(Message::Text(raw))) = message {
            assert_eq!(
                serde_json::from_str::<Value>(&raw).unwrap()["kind"],
                "error"
            );
        }
    }
    assert_eq!(
        runtime.call("bus.clients", json!({})).await.unwrap(),
        json!([])
    );
}
#[tokio::test]
async fn native_requests_route_without_application_service_and_pin_response_identity() {
    let runtime = runtime();
    let mut backend = connect(&runtime, "backend").await;
    let mut other = connect(&runtime, "other").await;
    let handle = runtime.clone();
    let waiting = tokio::spawn(async move {
        handle
            .call(
                "bus.request",
                json!({"dst":"backend","topic":"echo","data":{"text":"日本語🦀"},"timeoutMs":1000}),
            )
            .await
    });
    let request = receive(&mut backend).await;
    respond(&mut other, &request, json!("forged")).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!waiting.is_finished());
    respond(&mut backend, &request, request["data"].clone()).await;
    assert_eq!(waiting.await.unwrap().unwrap(), json!({"text":"日本語🦀"}));
}

#[tokio::test]
async fn backend_commands_report_delivery_and_never_replay_offline_commands() {
    let runtime = runtime();
    assert_eq!(
        runtime
            .call(
                "backend.command",
                json!({"function":"windows_speech_start"})
            )
            .await
            .unwrap(),
        false
    );
    let mut backend = connect(&runtime, "backend").await;
    assert_eq!(
        runtime
            .call("backend.command", json!({"function":"windows_speech_stop"}))
            .await
            .unwrap(),
        true
    );
    let command = receive(&mut backend).await;
    assert_eq!(command["kind"], "command");
    assert_eq!(command["topic"], "backend.command");
    assert_eq!(command["data"]["function"], "windows_speech_stop");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), backend.next())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn disconnect_fails_requests_and_reconnect_cannot_receive_stale_commands() {
    let runtime = runtime();
    let mut backend = connect(&runtime, "backend").await;
    let handle = runtime.clone();
    let waiting = tokio::spawn(async move {
        handle
            .call("bus.request", json!({"dst":"backend","topic":"slow"}))
            .await
    });
    receive(&mut backend).await;
    let mut replacement = connect(&runtime, "backend").await;
    assert!(waiting.await.unwrap().unwrap_err().contains("disconnected"));
    runtime
        .call(
            "bus.publish",
            json!({"dst":"backend","topic":"next","kind":"command"}),
        )
        .await
        .unwrap();
    assert_eq!(receive(&mut replacement).await["topic"], "next");
    assert!(runtime
        .call("bus.request", json!({"dst":"missing","topic":"never"}))
        .await
        .unwrap_err()
        .contains("not connected"));
}
#[tokio::test]
async fn text_retries_same_observation_after_backpressure_and_backend_reconnect() {
    let runtime = runtime();
    let observation = runtime
        .call("text.submit", json!({"text":"字幕","source":"texthook"}))
        .await
        .unwrap();
    assert_eq!(runtime.call("text.count", json!({})).await.unwrap(), 1);
    let mut backend = connect(&runtime, "backend").await;
    let request = receive(&mut backend).await;
    respond(
        &mut backend,
        &request,
        json!({"status":"backpressured","observation_id":observation}),
    )
    .await;
    let retry = receive(&mut backend).await;
    assert_eq!(retry["data"], request["data"]);
    drop(backend);
    let mut backend = connect(&runtime, "backend").await;
    let retry = receive(&mut backend).await;
    assert_eq!(retry["data"]["observationId"], observation);
    respond(
        &mut backend,
        &retry,
        json!({"status":"accepted","observation_id":observation}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(runtime.call("text.count", json!({})).await.unwrap(), 0);
}
#[tokio::test]
async fn text_queue_is_bounded_and_clear_cancels_retries() {
    let runtime = runtime();
    for _ in 0..LIMIT {
        runtime
            .call("text.submit", json!({"text":"line"}))
            .await
            .unwrap();
    }
    assert!(runtime
        .call("text.submit", json!({"text":"overflow"}))
        .await
        .is_err());
    runtime.call("text.clear", json!({})).await.unwrap();
    assert_eq!(runtime.call("text.count", json!({})).await.unwrap(), 0);
}
fn python() -> std::path::PathBuf {
    std::env::var_os("GSM_TEST_PYTHON")
        .map(Into::into)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(if cfg!(windows) {
                "../../.venv/Scripts/python.exe"
            } else {
                "../../.venv/bin/python"
            })
        })
}
fn spec(script: &str) -> Value {
    json!({"id":"backend","command":python(),"args":["-u","-c",script],"env":std::env::vars().collect::<HashMap<_,_>>(),"windowsHide":true,"readyOn":"spawn"})
}

#[tokio::test]
async fn backpressure_preserves_capture_order() {
    let runtime = runtime();
    for text in ["first", "second", "third"] {
        runtime
            .call("text.submit", json!({"text":text,"observationId":text}))
            .await
            .unwrap();
    }
    let mut backend = connect(&runtime, "backend").await;
    let first = receive(&mut backend).await;
    assert_eq!(first["data"]["text"], "first");
    respond(
        &mut backend,
        &first,
        json!({"status":"backpressured","observation_id":"first"}),
    )
    .await;
    let retry = receive(&mut backend).await;
    assert_eq!(retry["data"]["text"], "first");
    respond(
        &mut backend,
        &retry,
        json!({"status":"accepted","observation_id":"first"}),
    )
    .await;
    for text in ["second", "third"] {
        let request = receive(&mut backend).await;
        assert_eq!(request["data"]["text"], text);
        respond(
            &mut backend,
            &request,
            json!({"status":"accepted","observation_id":text}),
        )
        .await;
    }
}
async fn state(runtime: &Runtime) -> Value {
    runtime
        .call("process.state", json!({"id":"backend"}))
        .await
        .unwrap()
}
#[tokio::test]
async fn process_stop_reaps_owned_workers_and_preserves_other_processes() {
    let events = Arc::new(Mutex::new(vec![]));
    let output = events.clone();
    let runtime = Runtime::start(json!({}), move |event, data| {
        output.lock().unwrap().push((event.to_owned(), data))
    })
    .unwrap();
    let result=runtime.call("process.start",spec("import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(90)']); print('worker='+str(p.pid),flush=True); time.sleep(90)")).await.unwrap();
    assert!(result["pid"].as_u64().unwrap() > 0);
    runtime
        .call(
            "process.priority",
            json!({"id":"backend","runId":result["runId"],"priority":"below_normal"}),
        )
        .await
        .unwrap();
    assert!(runtime
        .call(
            "process.priority",
            json!({"id":"backend","runId":"stale","priority":"high"})
        )
        .await
        .is_err());
    let mut unrelated = process::OwnedChild::spawn(
        &spec("import time; time.sleep(90)"),
        std::env::vars().collect(),
    )
    .unwrap();
    assert!(!unrelated.owns_pid(std::process::id()));

    let until = Instant::now() + Duration::from_secs(5);
    let worker = loop {
        let logs = events.lock().unwrap();
        let worker = logs.iter().find_map(|(event, data)| {
            if event == "process.log" {
                data["message"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("worker="))
                    .and_then(|s| s.trim().parse::<u32>().ok())
            } else {
                None
            }
        });
        drop(logs);
        if let Some(pid) = worker {
            break pid;
        }
        assert!(Instant::now() < until);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    #[cfg(windows)]
    let worker_handle =
        unsafe { windows_sys::Win32::System::Threading::OpenProcess(0x00100000, 0, worker) };
    assert!(runtime
        .call("process.start", spec("print('duplicate')"))
        .await
        .is_err());
    runtime
        .call(
            "process.stop",
            json!({"id":"backend","runId":result["runId"]}),
        )
        .await
        .unwrap();
    assert_eq!(state(&runtime).await["state"], "stopped");
    #[cfg(windows)]
    unsafe {
        assert!(!worker_handle.is_null());
        assert_eq!(
            windows_sys::Win32::System::Threading::WaitForSingleObject(worker_handle, 3000),
            0
        );
        windows_sys::Win32::Foundation::CloseHandle(worker_handle);
    }
    #[cfg(unix)]
    {
        let state = std::process::Command::new("ps")
            .args(["-p", &worker.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let status = String::from_utf8_lossy(&state.stdout);
        assert!(
            !state.status.success() || status.trim().is_empty() || status.trim().starts_with('Z')
        );
    }
    assert!(
        unrelated.child.try_wait().unwrap().is_none(),
        "Stopping a managed backend killed an unrelated process"
    );
}
#[tokio::test]
async fn startup_failure_does_not_enter_runtime_crash_loop() {
    let runtime = runtime();
    let mut options = spec("raise RuntimeError('startup failure')");
    options["recoverRuntimeCrashes"] = json!(true);
    runtime.call("process.start", options).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(state(&runtime).await["state"], "crashed");
    let first = state(&runtime).await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(state(&runtime).await, first);
}
