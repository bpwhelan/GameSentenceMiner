//! Usage: injection_smoke <asset texthook directory> <owned text_target.exe>
//! This driver, the fixture and the live session all run without Node.
use gsm_texthook::Controller;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::{Child, Command},
    sync::mpsc,
    time::{Duration, Instant},
};
struct OwnedTarget(Child);
impl Drop for OwnedTarget {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().ok_or("Missing engines directory")?).canonicalize()?;
    let target = PathBuf::from(args.next().ok_or("Missing target executable")?).canonicalize()?;
    for name in ["luna", "textractor"] {
        let mut command = Command::new(&target);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut target = OwnedTarget(command.spawn()?);
        let pid = target.0.id();
        let arch = gsm_texthook::process_info(pid)?["arch"]
            .as_str()
            .ok_or("No architecture")?
            .to_owned();
        let path = if name == "luna" {
            root.join(format!(
                "luna_builds/LunaHostCLI{}.exe",
                if arch == "x86" { "32" } else { "64" }
            ))
        } else {
            root.join(format!("textractor_builds/_{arch}/TextractorCLI.exe"))
        };
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let controller = Controller::new(move |channel, value| {
            let _ = tx.send((channel.into(), value));
        });
        // The bundled Textractor x64 generic TextOutW hook interprets its pointer
        // as a character. Use a string H-code for this fixture's fourth argument
        // (R9). This also verifies native delayed manual-code attachment.
        let manual = if name == "textractor" && arch == "x64" {
            Some("HQN-54@0:gdi32.dll:TextOutW")
        } else {
            None
        };
        let options = json!({"engine":name,"cliPath":path,"cliPaths":{"x86":root.join("luna_builds/LunaHostCLI32.exe"),"x64":root.join("luna_builds/LunaHostCLI64.exe")},"pid":pid,"exeName":"text_target.exe","arch":arch,"flushDelayMs":50,"source":"user","maxBufferSize":3000,"manualHookCode":manual});
        controller.request("start", options.clone())?;
        assert!(
            controller.request("start", options.clone()).is_err(),
            "concurrent start must fail"
        );
        let deadline = Instant::now() + Duration::from_secs(35);
        let mut selected = false;
        let mut received = false;
        let mut logs = std::collections::VecDeque::new();
        while Instant::now() < deadline {
            if let Ok((event, data)) = rx.recv_timeout(Duration::from_millis(100)) {
                if event == "texthook.log" {
                    logs.push_back(data["message"].clone());
                    if logs.len() > 10 {
                        logs.pop_front();
                    }
                }
                if event == "texthook.hooks" && !selected {
                    if let Some(hook) = data["hooks"].as_array().and_then(|hooks| {
                        hooks.iter().find(|h| {
                            h["preview"]
                                .as_str()
                                .is_some_and(|s| s.contains("GSM native hook"))
                        })
                    }) {
                        assert_eq!(
                            controller.request("select", json!({"hookId":hook["id"]}))?,
                            true
                        );
                        selected = true;
                    }
                }
                if event == "texthook.output"
                    && data["text"]
                        .as_str()
                        .is_some_and(|s| s.contains("GSM native hook 日本語🦀"))
                {
                    received = true;
                    break;
                }
            }
        }
        assert!(received,"{name} did not capture Japanese text from our fixture: selected={selected}, hooks={}, logs={logs:?}",controller.request("hooks",Value::Null)?);
        assert_eq!(controller.request("status", Value::Null)?["arch"], arch);
        controller.request("stop", Value::Null)?;
        assert_eq!(controller.request("status", Value::Null)?["running"], false);
        assert!(
            target.0.try_wait()?.is_none(),
            "stopping hook must not kill target"
        );
        controller.request("start", options)?;
        target.0.kill()?;
        target.0.wait()?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while controller.request("status", Value::Null)?["running"] == true
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            controller.request("status", Value::Null)?["running"],
            false,
            "target exit must stop engine"
        );
        controller.shutdown();
        println!("PASS: {name} {arch} native attach, Japanese/emoji output, select, stop, reattach and target exit");
    }
    Ok(())
}
