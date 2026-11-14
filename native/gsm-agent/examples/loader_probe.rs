//! Exercises the production loader against an explicitly supplied test PID.
use serde_json::json;
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pid: u32 = args[1].parse().unwrap();
    let root = std::env::current_dir().unwrap();
    let data = std::env::temp_dir().join(format!("gsm-agent-probe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data).unwrap();
    let script = data.join("probe.js");
    std::fs::write(&script,r#"
localStorage.setItem('test', '日本語🦀');
if (localStorage.getItem('test') !== '日本語🦀') throw new Error('Storage round trip failed');
rpc.exports.add = (a,b) => a+b;
recv('test', function(message) { send({cmd:'copy',text:message.args[0]}); });
send({cmd:'copy',text:'Native Agent loader 日本語🦀'});
send({cmd:'loadHtml',text:'<html><body>Native Agent UI</body></html>',fileName:'probe.html'});
Interceptor.attach(Module.getExportByName('gdi32.dll', 'TextOutW'), {onEnter(args){send({cmd:'copy',text:args[3].readUtf16String(args[4].toInt32())});}});
"#).unwrap();
    // The real loader expects its companion libraries beside the game script.
    for entry in std::fs::read_dir(root.join(".agent_scripts"))
        .unwrap()
        .flatten()
    {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("lib") && entry.path().is_file() {
            std::fs::copy(entry.path(), data.join(name)).unwrap();
        }
    }
    let (tx, rx) = mpsc::channel();
    let runtime=gsm_agent::Runtime::start(json!({"pid":pid,"root":root,"baseDir":data,"scriptPath":script,"exeName":"text_target.exe","arch":"x64","source":"user","flushDelayMs":0}),move|event|{let _=tx.send(event);}).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut ready = false;
    let mut output = false;
    while Instant::now() < deadline {
        if let Ok((channel, payload)) = rx.recv_timeout(Duration::from_millis(100)) {
            println!("{channel}: {payload}");
            if channel == "agent.text"
                && payload["text"]
                    .as_str()
                    .is_some_and(|s| s.contains("GSM native hook 日本語🦀"))
            {
                output = true
            }
        }
        let state = runtime.request("state", &[]).unwrap();
        if state["startResult"]["success"] == true {
            ready = true
        }
        if state["startResult"]["success"] == false {
            panic!("{state}")
        }
        if ready && output {
            break;
        }
    }
    assert!(
        ready && output,
        "Real loader and GDI capture must both work"
    );
    assert_eq!(
        runtime
            .request("rpcCall", &[json!("add"), json!([3, 4])])
            .unwrap(),
        json!(7)
    );
    runtime
        .request("rpcSend", &[json!("test"), json!(["UI send 日本語"])])
        .unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    let mut received = false;
    while Instant::now() < until {
        if let Ok((channel, payload)) = rx.recv_timeout(Duration::from_millis(100)) {
            if channel == "agent.text" && payload["text"] == "UI send 日本語" {
                received = true;
                break;
            }
        }
    }
    assert!(received, "Script UI send must reach rpc.on");
    assert!(runtime.request("ui", &[]).unwrap()["html"]
        .as_str()
        .unwrap()
        .contains("Native Agent UI"));
    runtime.stop();
    assert!(runtime.wait(Duration::from_secs(8)), "Clean teardown");
    println!("Native Agent loader, text, storage, UI RPC and teardown passed.");
    std::fs::remove_dir_all(data).unwrap();
}
