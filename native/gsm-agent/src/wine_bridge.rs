//! Short-lived native Wine PID resolver. Frida stays outside the desktop binary.
//! The parent pipe is a lease: closing it cancels startup and releases the server.
use serde_json::Value;
#[cfg(feature = "runtime")]
use serde_json::json;
use std::{
    io::{BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub fn resolve(
    executable: &Path,
    options: &Value,
    cancelled: impl Fn() -> bool,
) -> Result<u32, String> {
    let mut command = Command::new(executable);
    command
        .arg("--gsm-wine-bridge")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let result = (|| {
        writeln!(child.stdin.as_mut().unwrap(), "{options}").map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(crate::host::read(&mut BufReader::new(stdout)));
        });
        let deadline = Instant::now() + Duration::from_secs(330);
        loop {
            if cancelled() {
                return Err("Wine bridge startup cancelled".into());
            }
            if Instant::now() >= deadline {
                return Err("Wine bridge startup timed out".into());
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(result) => {
                    let value = result?;
                    if let Some(error) = value["error"].as_str() {
                        return Err(error.into());
                    }
                    return value["pid"]
                        .as_u64()
                        .filter(|p| *p > 0 && *p <= u32::MAX as u64)
                        .map(|p| p as u32)
                        .ok_or("Wine bridge returned no target PID".into());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Wine bridge closed".into())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    })();
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

#[cfg(feature = "runtime")]
pub fn entry() -> i32 {
    use crate::frida::{Cancellation, Context, Device};
    let mut input = BufReader::new(std::io::stdin());
    let options = match crate::host::read(&mut input) {
        Ok(value) => value,
        Err(_) => return 2,
    };
    let cancel = Cancellation::new();
    let watch = cancel.clone();
    std::thread::spawn(move || {
        let _ = crate::host::read(&mut input);
        watch.cancel();
    });
    let result = (|| -> Result<u32, String> {
        let name = options["exeName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing Wine executable name")?;
        let context = Context::new();
        let wine = crate::wine::launch(&options, &cancel, &|_| {})?
            .ok_or("Missing Wine launch context")?;
        let device = Device::open(Some(&wine.address), &cancel)?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if cancel.cancelled() {
                return Err("Wine bridge startup cancelled".into());
            }
            let matches: Vec<_> = device
                .processes(&cancel)?
                .into_iter()
                .filter(|(_, exe)| exe.eq_ignore_ascii_case(name))
                .collect();
            match matches.as_slice() {
                [(pid, _)] => return Ok(*pid),
                [] => {},
                _ => return Err(format!("More than one {name} is running in this Wine prefix; close the extra instance before attaching")),
            }
            if Instant::now() >= deadline {
                return Err(format!("{name} was not found in the game's Wine prefix"));
            }
            context.tick();
            std::thread::sleep(Duration::from_millis(100));
        }
    })(); // Release the temporary server before returning the PID.
    let value = match &result {
        Ok(pid) => json!({"pid":pid}),
        Err(error) => json!({"error":error}),
    };
    let _ = writeln!(std::io::stdout(), "{value}");
    if result.is_ok() {
        0
    } else {
        1
    }
}
