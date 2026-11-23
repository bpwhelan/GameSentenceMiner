//! Order OBS transitions and finalized dialogue on one bounded file writer.
use gsm_mining::longplay::Recorder;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, OnceLock,
    },
    time::Instant,
};
use tauri::{AppHandle, Manager};

enum Event {
    Start(Instant, i64),
    File(Instant, i64, PathBuf, String),
    Stop(Instant, i64, Option<PathBuf>, String),
    Receipt {
        issued: Instant,
        finished: i64,
        active: bool,
        path: Option<PathBuf>,
        game: String,
    },
    Line(i64, Arc<str>),
    Finish(i64, tokio::sync::oneshot::Sender<Result<(), String>>),
}

#[derive(Default)]
pub struct Service {
    owned: AtomicBool,
    enabled: AtomicBool,
    sender: OnceLock<SyncSender<Event>>,
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_micros()
}

impl Service {
    pub fn configure(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        if enabled && self.sender.get().is_none() {
            let dir = app
                .state::<crate::settings::Settings>()
                .paths
                .active
                .join("temp");
            let (tx, rx) = sync_channel(256);
            let app = app.clone();
            std::thread::Builder::new()
                .name("gsm-longplay".into())
                .spawn(move || {
                    let mut writer = Recorder::new(dir);
                    let mut last_start = None;
                    let mut last_stop = None;
                    let mut previous_stop = None;
                    for event in rx {
                        let result = match event {
                            Event::Start(observed, at) => {
                                if !writer.active() {
                                    last_start = Some(observed);
                                }
                                writer.start(at);
                                Ok(())
                            }
                            Event::File(observed, at, path, game) => {
                                if !writer.active() {
                                    last_start = Some(observed);
                                }
                                writer.file(at, &path, &game)
                            }
                            Event::Stop(observed, at, path, game) => {
                                if writer.active() {
                                    previous_stop = last_stop.replace(observed);
                                }
                                writer.stop(at, path.as_deref(), &game)
                            }
                            Event::Receipt {
                                issued,
                                finished,
                                active,
                                path,
                                game,
                            } => {
                                if last_stop.is_some_and(|stop| issued < stop) {
                                    // A reply crossing one stop can supply the missing file path,
                                    // even if OBS has already started the next recording.
                                    if !active && previous_stop.is_none_or(|stop| issued >= stop) {
                                        writer.attach_stopped_path(path.as_deref(), &game)
                                    } else {
                                        Ok(())
                                    }
                                } else if active {
                                    writer.start(finished);
                                    Ok(())
                                } else if last_start.is_some_and(|start| issued < start) {
                                    Ok(())
                                } else {
                                    writer.stop(finished, path.as_deref(), &game)
                                }
                            }
                            Event::Line(at, text) => writer.line(at, text),
                            Event::Finish(at, done) => {
                                let _ =
                                    done.send(writer.finish_input(at).map_err(|e| e.to_string()));
                                Ok(())
                            }
                        };
                        if let Err(e) = result {
                            crate::desktop_log::warn(
                                &app,
                                "longplay",
                                format!("Could not update subtitles: {e}"),
                            );
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
            self.sender
                .set(tx)
                .map_err(|_| "Longplay writer already started")?;
        }
        self.owned.store(true, Ordering::Release);
        let previous = self.enabled.swap(enabled, Ordering::AcqRel);
        if enabled
            && !previous
            && app.state::<crate::obs::Obs>().game_session()["record_active"] == true
        {
            self.send(Event::Start(Instant::now(), now()));
        }
        Ok(())
    }

    pub fn owned(&self) -> bool {
        self.owned.load(Ordering::Acquire)
    }
    fn send(&self, event: Event) {
        if let Some(tx) = self.sender.get() {
            let _ = tx.send(event);
        }
    }
    pub fn line(&self, at: i64, text: Arc<str>) {
        self.send(Event::Line(at, text));
    }
    pub fn recording(&self, active: bool, path: Option<&str>, at: i64, game: String) {
        let path = path.filter(|s| !s.is_empty()).map(PathBuf::from);
        if active {
            if self.enabled.load(Ordering::Acquire) {
                if let Some(path) = path {
                    self.send(Event::File(Instant::now(), at, path, game));
                } else {
                    self.send(Event::Start(Instant::now(), at));
                }
            }
        } else {
            self.send(Event::Stop(Instant::now(), at, path, game));
        }
    }
    pub fn receipt(&self, issued: Instant, active: bool, path: Option<&str>, game: String) {
        if !active || self.enabled.load(Ordering::Acquire) {
            self.send(Event::Receipt {
                issued,
                finished: now(),
                active,
                path: path.filter(|s| !s.is_empty()).map(PathBuf::from),
                game,
            });
        }
    }
    pub async fn finish(&self) -> Result<(), String> {
        if let Some(tx) = self.sender.get() {
            let (done, wait) = tokio::sync::oneshot::channel();
            tx.send(Event::Finish(now(), done))
                .map_err(|e| e.to_string())?;
            wait.await.map_err(|e| e.to_string())??;
        }
        Ok(())
    }
}
