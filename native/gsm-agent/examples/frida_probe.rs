use gsm_agent::frida::*;
use serde_json::json;
fn main() -> Result<(), String> {
    println!("Native Frida {}", gsm_agent::version());
    let pid = std::env::args()
        .nth(1)
        .ok_or("Supply the owned fixture PID")?
        .parse()
        .map_err(|_| "Invalid PID")?;
    let context = Context::new();
    let cancel = Cancellation::new();
    let device = Device::open(None, &cancel)?;
    let session = device.attach(pid, &cancel)?;
    let seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let output = seen.clone();
    let script = session.script(
        "send({cmd:'eval',key:1}); recv('1', r=>send({text:r.result})).wait();",
        "GSM native proof",
        &cancel,
        move |reply, message, _| {
            if message["payload"]["cmd"] == "eval" {
                reply
                    .post(json!({"type":"1","result":"日本語🦀"}), None)
                    .unwrap();
            }
            if message["payload"]["text"] == "日本語🦀" {
                output.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            println!("{message}");
        },
    )?;
    eprintln!("Loading");
    script.load(&cancel)?;
    eprintln!("Loaded");
    for _ in 0..100 {
        if seen.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        context.tick();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(seen.load(std::sync::atomic::Ordering::SeqCst));
    eprintln!("Unloading");
    script.unload(&cancel)?;
    eprintln!("Detaching");
    session.detach(&cancel)?;
    eprintln!("Detached");
    drop(script);
    eprintln!("Script dropped");
    drop(session);
    eprintln!("Session dropped");
    drop(device);
    eprintln!("Closed");
    Ok(())
}
