//! Bounded one-shot native jobs. Children and any descendants belong to an
//! owned process group/job; timeouts never kill a process found by name or PID.
use crate::process::OwnedChild;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
pub type Progress = Arc<dyn Fn(&str, &[u8]) + Send + Sync>;
pub fn run(
    spec: Value,
    env: HashMap<String, String>,
    input: Vec<u8>,
    timeout: Duration,
    limit: usize,
) -> Result<Output, String> {
    run_with_progress(spec, env, input, timeout, limit, Arc::new(|_, _| {}))
}
pub fn run_with_progress(
    mut spec: Value,
    env: HashMap<String, String>,
    input: Vec<u8>,
    timeout: Duration,
    limit: usize,
    progress: Progress,
) -> Result<Output, String> {
    if input.len() > limit {
        return Err("Native task input exceeds the size limit".into());
    }
    spec["stdin"] = Value::Bool(true);
    let mut child = OwnedChild::spawn(&spec, env)?;
    let overflow = Arc::new(AtomicBool::new(false));
    fn reader(
        mut pipe: impl Read + Send + 'static,
        limit: usize,
        overflow: Arc<AtomicBool>,
        stream: &'static str,
        progress: Progress,
    ) -> thread::JoinHandle<Result<Vec<u8>, String>> {
        thread::spawn(move || {
            let mut output = Vec::new();
            let mut chunk = [0; 8192];
            loop {
                let count = match pipe.read(&mut chunk) {
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    result => result.map_err(|error| error.to_string())?,
                };
                if count == 0 {
                    return Ok(output);
                }
                progress(stream, &chunk[..count]);
                let keep = count.min(limit.saturating_sub(output.len()));
                output.extend_from_slice(&chunk[..keep]);
                if keep < count {
                    overflow.store(true, Ordering::Release);
                }
            }
        })
    }
    let stdout = reader(
        child.child.stdout.take().ok_or("Missing task stdout")?,
        limit,
        overflow.clone(),
        "stdout",
        progress.clone(),
    );
    let stderr = reader(
        child.child.stderr.take().ok_or("Missing task stderr")?,
        limit,
        overflow.clone(),
        "stderr",
        progress,
    );
    let mut stdin = child.child.stdin.take().ok_or("Missing task stdin")?;
    let writer = thread::spawn(move || stdin.write_all(&input).map_err(|e| e.to_string()));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if overflow.load(Ordering::Acquire) {
            break Err("Native task output exceeds the size limit".to_owned());
        }
        match child.child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(error) => break Err(error.to_string()),
        }
        if Instant::now() >= deadline {
            break Err("Native task timed out".to_owned());
        }
        thread::sleep(Duration::from_millis(10));
    };
    // Reap descendants before joining readers; inherited pipe handles must not
    // keep a completed or timed-out task waiting indefinitely.
    child.terminate()?;
    let written = writer.join();
    let stdout = stdout.join();
    let stderr = stderr.join();
    // Closing a pipe during termination can also fail a reader. Report the
    // reason the task was stopped after all three workers have finished.
    let status = status?;
    if overflow.load(Ordering::Acquire) {
        return Err("Native task output exceeds the size limit".into());
    }
    if status.success() {
        written.map_err(|_| "Task input worker stopped")??;
    }
    Ok(Output {
        code: status.code(),
        stdout: stdout.map_err(|_| "Task output worker stopped")??,
        stderr: stderr.map_err(|_| "Task error worker stopped")??,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn run_fixture(mode: &str, timeout: Duration, limit: usize) -> Result<Output, String> {
        run(
            json!({"command":std::env::current_exe().unwrap(),"args":["--ignored","--exact","task::tests::task_fixture","--nocapture"]}),
            std::env::vars()
                .chain([("GSM_TASK_FIXTURE".into(), mode.into())])
                .collect(),
            b"hello".to_vec(),
            timeout,
            limit,
        )
    }
    #[test]
    #[ignore = "owned subprocess fixture"]
    fn task_fixture() {
        match std::env::var("GSM_TASK_FIXTURE").unwrap().as_str() {
            "timeout" => thread::sleep(Duration::from_secs(30)),
            "overflow" => {
                for _ in 0..10000 {
                    println!("{}", "x".repeat(1024));
                }
            }
            "error" => {
                eprintln!("fixture failure");
                std::process::exit(7)
            }
            _ => {
                let mut value = String::new();
                std::io::stdin().read_to_string(&mut value).unwrap();
                println!("echo:{value}");
            }
        }
    }
    #[test]
    fn task_input_output_errors_and_timeouts() {
        let output = run_fixture("echo", Duration::from_secs(5), 4096).unwrap();
        assert_eq!(output.code, Some(0));
        assert!(String::from_utf8_lossy(&output.stdout).contains("echo:hello"));
        let output = run_fixture("error", Duration::from_secs(5), 4096).unwrap();
        assert_eq!(output.code, Some(7));
        assert!(String::from_utf8_lossy(&output.stderr).contains("fixture failure"));
        assert!(run_fixture("timeout", Duration::from_millis(100), 4096)
            .err()
            .unwrap()
            .contains("timed out"));
        let error = run_fixture("overflow", Duration::from_secs(5), 4096).err().unwrap();
        assert!(error.contains("size limit"), "{error}");
    }
}
