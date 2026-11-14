//! Detached native host lifecycle smoke against a caller-owned test process.
use serde_json::json;
use std::{thread, time::Duration};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--launch-detached") {
        let pid: u32 = args[2].parse().unwrap();
        let dir = std::path::PathBuf::from(&args[3]);
        let exe = std::env::current_exe()
            .unwrap()
            .with_file_name(if cfg!(windows) {
                "agent_host.exe"
            } else {
                "agent_host"
            });
        let controller = gsm_agent::Controller::new(|_, _, _| {});
        let result=controller.start(exe,json!({"pid":pid,"baseDir":dir,"root":std::env::current_dir().unwrap(),"scriptPath":dir.join("probe.js"),"arch":"x64","exeName":"text_target.exe","detached":true,"flushDelayMs":0})).unwrap();
        assert_eq!(result["success"], true);
        std::fs::write(
            dir.join("original-state.json"),
            controller.state().to_string(),
        )
        .unwrap();
        controller.shutdown();
        std::process::exit(0);
    }

    let pid: u32 = std::env::args().nth(1).unwrap().parse().unwrap();
    let root = std::env::current_dir().unwrap();
    let dir = std::env::temp_dir().join(format!("gsm-agent-host-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("probe.js");
    std::fs::write(
        &script,
        "rpc.exports.ping = () => 'native'; send({cmd:'copy',text:'日本語🦀'});",
    )
    .unwrap();
    for e in std::fs::read_dir(root.join(".agent_scripts"))
        .unwrap()
        .flatten()
    {
        if e.file_name().to_string_lossy().starts_with("lib") && e.path().is_file() {
            std::fs::copy(e.path(), dir.join(e.file_name())).unwrap();
        }
    }
    let exe = std::env::current_exe()
        .unwrap()
        .with_file_name(if cfg!(windows) {
            "agent_host.exe"
        } else {
            "agent_host"
        });
    let mut launcher = std::process::Command::new(std::env::current_exe().unwrap());
    launcher
        .arg("--launch-detached")
        .arg(pid.to_string())
        .arg(&dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        launcher.creation_flags(0x08000000);
    }
    assert!(launcher.status().unwrap().success());
    let original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("original-state.json")).unwrap()).unwrap();
    let session = original["status"]["sessionId"].clone();
    thread::sleep(Duration::from_millis(300));
    let reconnected = gsm_agent::Controller::new(|_, _, _| {});
    assert!(reconnected.reconnect(dir.to_str().unwrap()).unwrap());
    assert_eq!(reconnected.state()["status"]["sessionId"], session);
    assert_eq!(
        reconnected
            .request("rpcCall", &[json!("ping"), json!([])])
            .unwrap(),
        "native"
    );
    assert!(reconnected
        .request_session("old-session", "rpcCall", &[json!("ping"), json!([])])
        .is_err());
    {
        use std::io::{Read, Write};
        let info: serde_json::Value = serde_json::from_slice(
            &std::fs::read(gsm_agent::host::metadata_path(dir.to_str().unwrap())).unwrap(),
        )
        .unwrap();
        let mut socket =
            std::net::TcpStream::connect(format!("127.0.0.1:{}", info["port"])).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        writeln!(
            socket,
            "{}",
            json!({"kind":"hello","token":"incorrect-token"})
        )
        .unwrap();
        assert!(
            matches!(socket.read(&mut [0u8; 1]), Ok(0) | Err(_)),
            "Wrong credentials must not get a response"
        );
    }
    reconnected.stop_for_update(dir.to_str().unwrap()).unwrap();
    assert!(!gsm_agent::host::metadata_path(dir.to_str().unwrap()).exists());
    let attached = gsm_agent::Controller::new(|_, _, _| {});
    assert_eq!(attached.start(exe.clone(),json!({"pid":pid,"baseDir":dir,"root":root,"scriptPath":script,"arch":"x64","exeName":"text_target.exe","detached":false})).unwrap()["success"],true);
    attached.shutdown();
    assert!(!gsm_agent::host::metadata_path(dir.to_str().unwrap()).exists());
    // Real loader startup may scan for more than five seconds.
    std::fs::write(&script, "Thread.sleep(6); rpc.exports.ping=()=>true;").unwrap();
    let slow = gsm_agent::Controller::new(|_, _, _| {});
    assert_eq!(slow.start(exe.clone(),json!({"pid":pid,"baseDir":dir,"root":root,"scriptPath":script,"arch":"x64","exeName":"text_target.exe","detached":false})).unwrap()["success"],true);
    slow.stop().unwrap();
    // Retrying Unity startup must remain cancellable and must leave the game alive.
    std::fs::write(
        &script,
        "console.warn('Mono not found!'); throw new Error('setHook undefined');",
    )
    .unwrap();
    let retry = std::sync::Arc::new(gsm_agent::Controller::new(|_, _, _| {}));
    let starter = retry.clone();
    let options = json!({"pid":pid,"baseDir":dir,"root":root,"scriptPath":script,"arch":"x64","exeName":"text_target.exe","detached":false});
    let started = thread::spawn(move || starter.start(exe, options));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while retry.state()["status"]["running"] != true && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(750));
    let stopped = std::time::Instant::now();
    retry.stop().unwrap();
    assert!(stopped.elapsed() < Duration::from_secs(12));
    assert!(started
        .join()
        .unwrap()
        .map_or(true, |result| result["success"] == false));
    assert!(!gsm_agent::host::metadata_path(dir.to_str().unwrap()).exists());
    println!("Native detached survival, reconnect, RPC, stop, attached shutdown, slow initialization and retry cancellation passed.");
    std::fs::remove_dir_all(dir).unwrap();
}
