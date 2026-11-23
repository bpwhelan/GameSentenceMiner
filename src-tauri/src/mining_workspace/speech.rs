use super::{emit, MiningWorkspace};
use crate::{desktop_state::DesktopState, obs::Obs, settings::Settings, text_intake};
use gsm_packages::speech::{embedded, env_path, Embedded};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::{Child, Command},
    sync::{oneshot, watch},
    task::{JoinHandle, JoinSet},
};

struct Session {
    cancel: oneshot::Sender<()>,
    finished: JoinHandle<()>,
}

pub(crate) struct Service {
    session: tokio::sync::Mutex<Option<Session>>,
    attachment: AtomicU64,
    status: Mutex<Value>,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            session: Default::default(),
            attachment: AtomicU64::new(1),
            status: Mutex::new(json!({"state":"idle","sceneId":"","sceneName":"",
                "backend":"","language":"","error":"","reason":""})),
        }
    }
}

impl Service {
    pub(crate) fn status(&self) -> Value {
        self.status.lock().unwrap().clone()
    }

    pub(super) fn publish(&self, app: &AppHandle) {
        emit(app, "speech-recognition.status", self.status());
    }

    fn update(&self, app: &AppHandle, state: &str, reason: &str, error: &str) {
        let mut status = self.status.lock().unwrap();
        status["state"] = json!(state);
        status["reason"] = json!(reason);
        status["error"] = json!(error);
        emit(app, "speech-recognition.status", status.clone());
    }

    async fn end(&self, app: &AppHandle, session: Session, reason: &str) {
        self.update(app, "stopping", reason, "");
        let _ = session.cancel.send(());
        let _ = session.finished.await;
        self.update(app, "idle", reason, "");
    }

    pub(crate) async fn stop(&self, app: &AppHandle, reason: &str) {
        let mut current = self.session.lock().await;
        if let Some(session) = current.take() {
            self.end(app, session, reason).await;
        } else {
            self.update(app, "idle", reason, "");
        }
    }

    pub(super) async fn start(
        &self,
        app: &AppHandle,
        scene: Value,
        settings: Value,
    ) -> Result<(), String> {
        if !cfg!(windows) {
            return Err("Windows speech recognition is only available on Windows.".into());
        }
        let mut current = self.session.lock().await;
        let scenes = app.state::<Obs>().subscribe_game_session();
        let name = scene["name"]
            .as_str()
            .ok_or("Missing scene name")?
            .to_owned();
        if !scene_matches(&scenes.borrow(), &name) {
            return Err(format!(
                "Cannot start speech recognition for '{name}' while OBS is on another scene."
            ));
        }
        if let Some(previous) = current.take() {
            self.end(app, previous, "restarted from the Speech Recognition tab")
                .await;
        }
        *self.status.lock().unwrap() = json!({"state":"starting","sceneId":scene["id"],"sceneName":name,
            "backend":settings["backend"],"language":settings["language"],"error":"","reason":""});
        self.publish(app);
        let (cancel, stopped) = oneshot::channel();
        let handle = app.clone();
        let finished = tokio::spawn(async move {
            let work = handle.state::<MiningWorkspace>();
            match run(&handle, scenes, name, settings, stopped).await {
                Ok(Exit::SceneChanged) => work.speech.update(&handle, "idle", "scene changed", ""),
                Ok(Exit::Stopped) => {}
                Err(error) => {
                    log(&handle, "error", &error);
                    work.speech.update(&handle, "error", "", &error);
                }
            }
        });
        *current = Some(Session { cancel, finished });
        Ok(())
    }
}

fn log(app: &AppHandle, level: &str, message: &str) {
    emit(
        app,
        "speech-recognition.log",
        json!({"level":level,"message":message,
        "timestamp":chrono::Utc::now().timestamp_millis()}),
    );
}

fn scene_matches(state: &Value, name: &str) -> bool {
    state["scene"]
        .as_str()
        .is_none_or(|s| s.is_empty() || s == name)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Target {
    hwnd: u64,
    pid: u32,
}

fn target(state: &Value) -> Option<Target> {
    let hwnd = state["target_id"].as_u64().filter(|v| *v > 0)?;
    let pid = u32::try_from(state["target_pid"].as_u64()?)
        .ok()
        .filter(|v| *v > 0)?;
    Some(Target { hwnd, pid })
}

struct Helpers {
    capture: PathBuf,
    recognizer: PathBuf,
    model: Option<Embedded>,
    license: Option<PathBuf>,
    locale: &'static str,
}

impl Helpers {
    fn locate(
        root: &Path,
        shared: &Path,
        settings: &Value,
        progress: impl Fn(u64, Option<u64>),
    ) -> Result<Self, String> {
        let find = |key, folder: &str, filename: &str| {
            env_path(key)
                .into_iter()
                .chain(
                    env_path("GSM_NATIVE_HELPER_ROOT")
                        .into_iter()
                        .chain([root.join("native")])
                        .map(|p| p.join(folder).join("bin/x64").join(filename)),
                )
                .find(|p| p.is_file())
                .ok_or_else(|| format!("Could not find {filename}"))
        };
        let sapi = settings["backend"] == "sapi";
        let locale = if settings["language"] == "en" {
            "en-US"
        } else {
            "ja-JP"
        };
        let capture = find(
            "GSM_WINDOWS_AUDIO_HELPER",
            "windows-audio-capture",
            "gsm-windows-audio-capture.exe",
        )?;
        let (key, filename) = if sapi {
            (
                "GSM_WINDOWS_SAPI_HELPER",
                "gsm-windows-speech-recognition-sapi.exe",
            )
        } else {
            (
                "GSM_WINDOWS_SPEECH_HELPER",
                "gsm-windows-speech-recognition.exe",
            )
        };
        let recognizer = find(key, "windows-speech-recognition", filename)?;
        let model = if sapi {
            None
        } else {
            Some(embedded(
                locale,
                settings["modelPath"].as_str().unwrap_or(""),
                settings["runtimePath"].as_str().unwrap_or(""),
                shared,
                root,
                &progress,
            )?)
        };
        let license = settings["licenseFile"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| env_path("GSM_WINDOWS_SPEECH_LICENSE_FILE"));
        Ok(Self {
            capture,
            recognizer,
            model,
            license,
            locale,
        })
    }

    async fn launch(&self, pid: u32) -> std::io::Result<(Child, Child)> {
        let mut capture = Command::new(&self.capture);
        capture.args([
            "--root-pid",
            &pid.to_string(),
            "--sample-rate",
            "16000",
            "--channels",
            "1",
        ]);
        let mut recognize = Command::new(&self.recognizer);
        if let Some(model) = &self.model {
            recognize
                .arg("--model-path")
                .arg(&model.model)
                .arg("--runtime-path")
                .arg(&model.runtime);
            if let Some(path) = &self.license {
                recognize.arg("--license-file").arg(path);
            }
        } else {
            recognize.args(["--language", self.locale]);
        }
        pipe_helpers(capture, recognize).await
    }
}

async fn pipe_helpers(
    mut capture: Command,
    mut recognize: Command,
) -> std::io::Result<(Child, Child)> {
    // The desktop never reads or copies PCM. Closing the producer signals EOF directly to the recognizer.
    let (reader, writer) = std::io::pipe()?;
    for cmd in [&mut capture, &mut recognize] {
        cmd.kill_on_drop(true).stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
    }
    let mut audio = capture.stdin(Stdio::null()).stdout(writer).spawn()?;
    match recognize.stdin(reader).stdout(Stdio::piped()).spawn() {
        Ok(speech) => Ok((audio, speech)),
        Err(e) => {
            let _ = audio.kill().await;
            Err(e)
        }
    }
}

enum Exit {
    Stopped,
    SceneChanged,
}

async fn run(
    app: &AppHandle,
    mut scenes: watch::Receiver<Value>,
    name: String,
    settings: Value,
    mut stopped: oneshot::Receiver<()>,
) -> Result<Exit, String> {
    let root = app.state::<DesktopState>().app_root.clone();
    let shared = app.state::<Settings>().paths.shared.clone();
    let setup = settings.clone();
    let (progress, mut updates) = watch::channel(0);
    let mut prepare = tokio::task::spawn_blocking(move || {
        Helpers::locate(&root, &shared, &setup, |bytes, total| {
            let percent = total
                .filter(|v| *v > 0)
                .map_or(0, |n| bytes.saturating_mul(100) / n);
            progress.send_if_modified(|last| {
                if percent / 10 <= *last / 10 {
                    return false;
                }
                *last = percent;
                true
            });
        })
    });
    // OBS can first publish an empty session. Once it identifies the selected
    // scene, its epoch distinguishes even a quick switch away and back.
    let mut epoch = None;
    let mut ended = |s: &Value| {
        if epoch.is_none() && s["scene"] == name {
            epoch = s["scene_epoch"].as_u64();
        }
        !scene_matches(s, &name) || epoch.is_some_and(|e| s["scene_epoch"] != e)
    };
    let helpers = loop {
        tokio::select! {
            biased;
            _ = &mut stopped => return Ok(Exit::Stopped),
            _ = scenes.wait_for(&mut ended) => return Ok(Exit::SceneChanged),
            result = &mut prepare => break result.map_err(|e| e.to_string())??,
            Ok(()) = updates.changed() => log(app, "info", &format!("Downloading Windows speech recognition bundle: {}%", *updates.borrow_and_update())),
        }
    };
    app.state::<MiningWorkspace>()
        .speech
        .update(app, "running", "", "");
    loop {
        let snapshot = scenes.borrow_and_update().clone();
        if ended(&snapshot) {
            return Ok(Exit::SceneChanged);
        }
        let Some(window) = target(&snapshot) else {
            tokio::select! {
                _ = &mut stopped => return Ok(Exit::Stopped),
                result = scenes.wait_for(|s| ended(s) || target(s).is_some()) => {
                    if result.is_err() { return Ok(Exit::Stopped); }
                    continue;
                }
            }
        };
        match helpers.launch(window.pid).await {
            Ok((mut audio, mut speech)) => {
                log(
                    app,
                    "info",
                    &format!("Speech recognition attached to PID {}.", window.pid),
                );
                let mut logs = JoinSet::new();
                for (label, stderr) in [
                    ("audio", audio.stderr.take()),
                    ("recognizer", speech.stderr.take()),
                ] {
                    if let Some(stream) = stderr {
                        logs.spawn(diagnostics(app.clone(), label, stream));
                    }
                }
                let stream = speech.stdout.take().expect("configured recognizer stdout");
                let generation = app
                    .state::<MiningWorkspace>()
                    .speech
                    .attachment
                    .fetch_add(1, Ordering::Relaxed);
                let interrupted = async {
                    tokio::select! {
                        biased;
                        _ = &mut stopped => End::Stop,
                        _ = scenes.wait_for(|s| ended(s) || target(s) != Some(window)
                            || s["scene_epoch"] != snapshot["scene_epoch"]) => End::Target,
                        // Let the recognizer drain buffered audio after capture exits.
                        // Its stdout normally reaches EOF immediately afterwards.
                        _ = async {
                            let _ = audio.wait().await;
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        } => End::Retry,
                    }
                };
                let end = listen(
                    app,
                    stream,
                    &snapshot,
                    window,
                    generation,
                    &settings,
                    interrupted,
                )
                .await
                .unwrap_or_else(|error| {
                    log(app, "error", &error);
                    End::Retry
                });
                let _ = tokio::join!(audio.kill(), speech.kill());
                match end {
                    End::Stop => return Ok(Exit::Stopped),
                    End::Target => continue,
                    End::Retry => {}
                }
            }
            Err(e) => log(
                app,
                "error",
                &format!("Could not launch Windows speech helpers: {e}"),
            ),
        }
        tokio::select! {
            _ = &mut stopped => return Ok(Exit::Stopped),
            _ = scenes.wait_for(|s| ended(s) || target(s) != Some(window)) => {},
            _ = tokio::time::sleep(Duration::from_secs(2)) => {},
        }
    }
}

async fn diagnostics(app: AppHandle, label: &str, stream: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log(&app, "debug", &format!("Windows speech {label}: {line}"));
    }
}

enum End {
    Stop,
    Target,
    Retry,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_requires_both_a_window_and_its_owner() {
        assert_eq!(
            target(&json!({"target_id":7,"target_pid":16,"active":false})),
            Some(Target { hwnd: 7, pid: 16 })
        );
        for missing in [
            json!({}),
            json!({"target_id":7}),
            json!({"target_id":0,"target_pid":16}),
        ] {
            assert_eq!(target(&missing), None);
        }
    }

    #[tokio::test]
    #[ignore = "run through scripts/benchmark_speech_pipe.py with the deterministic helper"]
    async fn speech_pipe_benchmark() {
        use std::{env, io, time::Instant};
        let helpers = Helpers::locate(
            Path::new("."),
            Path::new("."),
            &json!({"backend":"sapi","language":"ja"}),
            |_, _| {},
        )
        .unwrap();
        let wait = || {
            let mut line = String::new();
            io::stdin().read_line(&mut line).unwrap();
        };
        println!("SPEECH_READY {}", std::process::id());
        wait();
        let start = Instant::now();
        let (mut capture, mut recognize) = helpers.launch(1).await.unwrap();
        let mut lines = BufReader::new(recognize.stdout.take().unwrap()).lines();
        let mut latencies = Vec::new();
        let mut texts = Vec::new();
        while let Some(line) = lines.next_line().await.unwrap() {
            let event: Value = serde_json::from_str(&line).unwrap();
            latencies
                .push(chrono::Utc::now().timestamp_micros() - event["offset"].as_i64().unwrap());
            texts.push(event["text"].as_str().unwrap().to_owned());
        }
        assert!(capture.wait().await.unwrap().success());
        assert!(recognize.wait().await.unwrap().success());
        let burst = env::var("GSM_SPEECH_FIXTURE").unwrap() == "burst";
        let expected: Vec<_> = (0..64)
            .map(|i| format!("結果{}", if burst { i * 32 + 31 } else { i }))
            .collect();
        assert_eq!(texts, expected);
        println!(
            "SPEECH_DONE {}",
            json!({"wall_ms":start.elapsed().as_secs_f64()*1000.0,"latencies_us":latencies})
        );
        wait();
    }
}

async fn listen(
    app: &AppHandle,
    stream: impl AsyncRead + Unpin,
    snapshot: &Value,
    window: Target,
    generation: u64,
    settings: &Value,
    interrupted: impl std::future::Future<Output = End>,
) -> Result<End, String> {
    let mut lines = BufReader::new(stream).lines();
    let mut utterance = 0u64;
    tokio::pin!(interrupted);
    loop {
        let line = tokio::select! {
            biased;
            reason = &mut interrupted => return Ok(reason),
            line = lines.next_line() => line.map_err(|e| e.to_string())?,
        };
        let Some(line) = line else {
            return Ok(End::Retry);
        };
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event["type"] == "error" {
            log(
                app,
                "error",
                event["message"]
                    .as_str()
                    .unwrap_or("Windows speech recognition error"),
            );
        }
        let Some(text) = event["text"]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty() && event["type"] == "recognition")
        else {
            continue;
        };
        let final_text = event["final"] == true;
        log(
            app,
            "result",
            &format!("[{}] {text}", if final_text { "final" } else { "partial" }),
        );
        let process_name = snapshot["process_path"]
            .as_str()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|file| file.to_str())
            .unwrap_or("");
        let mut payload = json!({
            "text": text,
            "source": "speech_recognition",
            "source_display_name": "Windows Speech Recognition",
            "observation_id": uuid::Uuid::new_v4(),
            "speech_scene_epoch": snapshot["scene_epoch"],
            "source_instance": format!("windows-speech:{}:{generation}:{utterance}", window.pid),
            "revision_window_ms": 2500,
            "metadata": {
                "speech_backend": settings["backend"],
                "speech_final": final_text,
                "window_hwnd": window.hwnd,
                "window_pid": window.pid,
                "window_title": snapshot["window_info"]["title"].as_str().unwrap_or(""),
                "window_process_name": process_name,
                "window_process_path": snapshot["process_path"]
            }
        });
        for key in ["offset", "duration"] {
            if let Some(n) = event[key].as_i64() {
                payload["metadata"][format!("speech_{key}")] = json!(n);
            }
        }
        loop {
            let ack = text_intake::submit(app, payload.clone(), None).await?;
            if ack["status"] != "backpressured" {
                break;
            }
            tokio::select! {
                biased;
                reason = &mut interrupted => return Ok(reason),
                _ = tokio::time::sleep(Duration::from_millis(25)) => {},
            }
        }
        utterance += u64::from(final_text);
    }
}
