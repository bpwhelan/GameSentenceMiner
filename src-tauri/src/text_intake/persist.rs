//! Producer admission limits outstanding writes. A dedicated worker keeps database I/O off the intake lock. A barrier orders
//! card updates and database close behind accepted writes. Consecutive captures share a transaction.
use gsm_history::{
    capture::{Batch, Line},
    History, Request,
};
use gsm_intake::Record;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
#[derive(Clone, Default, PartialEq)]
pub struct Options {
    pub language: String,
    pub dictionary: Option<String>,
}
enum Job {
    Line(Arc<Record>, Arc<Options>),
    Break(f64),
    Mined(gsm_history::mining::MinedLine),
    Barrier(tokio::sync::oneshot::Sender<Result<(), String>>),
}
pub struct Writer {
    closed: AtomicBool,
    tx: mpsc::Sender<Job>,
    outstanding: Arc<AtomicUsize>,
}
impl Writer {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel();
        let outstanding = Arc::new(AtomicUsize::new(0));
        let counter = outstanding.clone();
        let app = app.clone();
        std::thread::Builder::new()
            .name("gsm-dialogue-history".into())
            .spawn(move || worker(app, rx, counter))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            tx,
            outstanding,
            closed: false.into(),
        })
    }
    pub fn busy(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
            || self.outstanding.load(Ordering::Relaxed) >= super::PROJECTION_CAPACITY
    }
    fn send(&self, job: Job) {
        self.outstanding.fetch_add(1, Ordering::Relaxed);
        if self.tx.send(job).is_err() {
            self.closed.store(true, Ordering::Relaxed);
            self.outstanding.fetch_sub(1, Ordering::Relaxed);
        }
    }
    pub fn capture(&self, r: &Arc<Record>, options: &Arc<Options>) {
        self.send(Job::Line(r.clone(), options.clone()));
    }
    pub fn mined(&self, update: gsm_history::mining::MinedLine) {
        self.send(Job::Mined(update));
    }
    pub fn interrupt(&self, at: f64) {
        self.send(Job::Break(at));
    }
    pub fn barrier(&self) -> tokio::sync::oneshot::Receiver<Result<(), String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.send(Job::Barrier(tx));
        rx
    }
}
fn retry<T>(app: &AppHandle, mut write: impl FnMut() -> gsm_history::Result<T>) -> T {
    let mut wait = Duration::from_millis(50);
    let mut report = Instant::now();
    loop {
        match write() {
            Ok(value) => return value,
            Err(e) => {
                if Instant::now() >= report {
                    crate::desktop_log::error(
                        app,
                        "text-intake",
                        format!("Dialogue history unavailable. Pending writes retained: {e}"),
                    );
                    report = Instant::now() + Duration::from_secs(30);
                }
                std::thread::sleep(wait);
                wait = (wait * 2).min(Duration::from_secs(2));
            }
        }
    }
}
fn worker(app: AppHandle, rx: mpsc::Receiver<Job>, outstanding: Arc<AtomicUsize>) {
    let db = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("gsm.db");
    let history = app.state::<Arc<History>>().inner().clone();
    let mut queue = VecDeque::with_capacity(64);
    while let Ok(job) = rx.recv() {
        queue.push_back(job);
        queue.extend(rx.try_iter().take(63));
        while let Some(job) = queue.pop_front() {
            let completed = match job {
                Job::Barrier(tx) => {
                    let _ = tx.send(Ok(()));
                    1
                }
                Job::Mined(update) => {
                    retry(&app, || {
                        history.run(&db, Request::UpdateMinedLine(update.clone()))
                    });
                    1
                }
                Job::Break(timestamp) => {
                    retry(&app, || {
                        history.run(&db, Request::ReadingBreak { timestamp })
                    });
                    1
                }
                Job::Line(first, options) => {
                    let make_line = |r: Arc<Record>| Line {
                        id: r.line_id.clone(),
                        text: r.text.to_string(),
                        scene: Some(r.scene.to_string()),
                        timestamp: r.captured_at_utc.timestamp_micros() as f64 / 1e6,
                    };
                    let mut lines = vec![make_line(first)];
                    while matches!(queue.front(),Some(Job::Line(_,opts)) if opts==&options) {
                        if let Some(Job::Line(r, _)) = queue.pop_front() {
                            lines.push(make_line(r));
                        }
                    }
                    let count = lines.len();
                    let batch = Batch::captured(
                        lines,
                        options.language.clone(),
                        options.dictionary.clone(),
                    );
                    let index = batch.word_index();
                    retry(&app, || history.capture(&db, &batch));
                    app.state::<super::Intake>().state.lock().unwrap().feed.request_goals(false);
                    if let Some((dict, ids)) = index {
                        app.state::<crate::word_index::WordIndex>()
                            .enqueue(&dict, ids);
                    }
                    count
                }
            };
            outstanding.fetch_sub(completed, Ordering::Relaxed);
        }
    }
}
