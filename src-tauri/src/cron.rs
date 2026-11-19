//! The authenticated backend pulls a lease only for jobs still implemented
//! there. Between leases the desktop sleeps until a deadline or a command.
use gsm_history::{schedule::Job, History};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tokio::sync::{watch, Mutex as AsyncMutex};

#[derive(Default)]
pub struct Scheduler(Mutex<Owner>);
#[derive(Default)]
struct Owner {
    epoch: Option<u64>,
    run: Option<Arc<Run>>,
}
#[derive(Clone, Copy, Default)]
struct Control {
    epoch: Option<u64>,
    generation: u64,
    revision: u64,
}
struct Run {
    session: String,
    priorities: HashMap<String, u32>,
    retry: Duration,
    refresh: Duration,
    control: watch::Sender<Control>,
    inbox: Mutex<Inbox>,
    driver: AsyncMutex<Driver>,
}
#[derive(Default)]
struct Inbox {
    sequence: u64,
    forced: VecDeque<String>,
}
#[derive(Default)]
struct Driver {
    revision: Option<u64>,
    scheduled: VecDeque<Job>,
    reload: Option<Instant>,
    retry_at: HashMap<i64, Instant>,
    lease: Option<(String, Job)>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Start {
        priorities: HashMap<String, u32>,
        retry_seconds: f64,
        refresh_seconds: f64,
    },
    Force {
        sequence: u64,
        name: String,
    },
    Refresh,
    Stop {
        ack: Option<Ack>,
    },
    Next {
        ack: Option<Ack>,
    },
}
#[derive(Deserialize)]
struct Ack {
    lease: String,
    finished: bool,
    next_run: Option<f64>,
}
#[derive(Deserialize)]
struct Request {
    session: String,
    #[serde(flatten)]
    command: Command,
}

impl Scheduler {
    fn owner(&self, epoch: u64) -> Result<std::sync::MutexGuard<'_, Owner>, String> {
        let owner = self.0.lock().unwrap();
        if owner.epoch != Some(epoch) {
            return Err("Cron connection has expired".into());
        }
        Ok(owner)
    }
    pub fn connection(&self, epoch: Option<u64>) {
        let mut owner = self.0.lock().unwrap();
        owner.epoch = epoch;
        if let Some(run) = &owner.run {
            run.control.send_modify(|state| state.epoch = None);
        }
    }
    pub fn close(&self) {
        if let Some(run) = self.0.lock().unwrap().run.take() {
            run.control.send_modify(|state| state.epoch = None);
        }
    }
}

fn seconds(value: f64) -> Result<Duration, String> {
    let duration = Duration::try_from_secs_f64(value).map_err(|e| e.to_string())?;
    if duration.is_zero() || Instant::now().checked_add(duration).is_none() {
        return Err("Invalid scheduler interval".into());
    }
    Ok(duration)
}

fn enqueue(run: &Run, sequence: u64, name: String) -> Result<(), String> {
    let mut inbox = run.inbox.lock().unwrap();
    if sequence <= inbox.sequence {
        return Ok(());
    }
    if !run.priorities.contains_key(&name) {
        return Err("Unknown scheduled job".into());
    }
    if inbox.forced.len() >= 128 {
        return Err("Cron mailbox is full".into());
    }
    inbox.forced.push_back(name);
    inbox.sequence = sequence;
    run.control.send_modify(|_| {});
    Ok(())
}

pub async fn request(app: AppHandle, epoch: u64, data: Value) -> Result<Value, String> {
    let Request { session, command } = serde_json::from_value(data).map_err(|e| e.to_string())?;
    let scheduler = app.state::<Scheduler>();
    if let Command::Start {
        priorities,
        retry_seconds,
        refresh_seconds,
    } = command
    {
        let history = app.state::<Arc<History>>().inner().clone();
        let generation = tauri::async_runtime::spawn_blocking(move || {
            history.generation().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        let mut owner = scheduler.owner(epoch)?;
        if owner.run.as_ref().is_none_or(|r| r.session != session) {
            let retry = seconds(retry_seconds)?;
            let refresh = seconds(refresh_seconds)?;
            if let Some(old) = owner.run.take() {
                old.control.send_modify(|state| state.epoch = None);
            }
            let (control, _) = watch::channel(Control::default());
            owner.run = Some(Arc::new(Run {
                session,
                priorities,
                retry,
                refresh,
                control,
                inbox: Mutex::default(),
                driver: AsyncMutex::default(),
            }));
        }
        owner.run.as_ref().unwrap().control.send_modify(|state| {
            state.epoch = Some(epoch);
            state.generation = generation;
            state.revision = state.revision.wrapping_add(1);
        });
        return Ok(Value::Null);
    }
    let run = {
        let mut owner = scheduler.owner(epoch)?;
        let run = owner
            .run
            .as_ref()
            .filter(|r| r.session == session)
            .ok_or("Cron session has expired")?
            .clone();
        if run.control.borrow().epoch != Some(epoch) {
            return Err("Cron connection requires registration".into());
        }
        match command {
            Command::Refresh => {
                run.control
                    .send_modify(|state| state.revision = state.revision.wrapping_add(1));
                return Ok(Value::Null);
            }
            Command::Force { sequence, name } => {
                enqueue(&run, sequence, name)?;
                return Ok(Value::Null);
            }
            Command::Stop { .. } => {
                owner.run.take();
                run.control.send_modify(|state| state.epoch = None);
            }
            _ => {}
        }
        run
    };
    let db = Database {
        index: app.state::<crate::word_index::WordIndex>().inner().clone(),
        history: app.state::<Arc<History>>().inner().clone(),
        path: app
            .state::<crate::settings::Settings>()
            .paths
            .active
            .join("gsm.db"),
    };
    match command {
        Command::Next { ack } => run.next(db, epoch, ack).await,
        Command::Stop { ack } => {
            let mut driver = run.driver.lock().await;
            let generation = run.control.borrow().generation;
            driver.acknowledge(&db, generation, ack, run.retry).await?;
            Ok(Value::Null)
        }
        _ => unreachable!(),
    }
}

#[derive(Clone)]
struct Database {
    index: crate::word_index::WordIndex,
    history: Arc<History>,
    path: PathBuf,
}
impl Database {
    async fn work<T: Send + 'static>(
        &self,
        f: impl FnOnce(&History, &std::path::Path) -> gsm_history::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let db = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            f(&db.history, &db.path).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn run_word_backfill(&self, generation: u64, job: Job) -> Result<(), String> {
        let check = job.clone();
        if self
            .work(move |h, p| h.scheduled_job_current(p, generation, &check))
            .await?
        {
            self.index.run_backfill(generation).await?;
            self.work(move |h, p| h.finish_scheduled_job(p, generation, &job, None))
                .await?;
        }
        Ok(())
    }
}

impl Run {
    async fn next(&self, db: Database, epoch: u64, ack: Option<Ack>) -> Result<Value, String> {
        let mut changed = self.control.subscribe();
        let mut driver = self
            .driver
            .try_lock()
            .map_err(|_| "Cron request is already active")?;
        let mut ack = ack;
        loop {
            let control = *changed.borrow_and_update();
            if control.epoch != Some(epoch) {
                return Err("Cron session was interrupted".into());
            }
            let generation = control.generation;
            if ack.is_some() {
                driver
                    .acknowledge(&db, generation, ack.take(), self.retry)
                    .await?;
                continue;
            }
            if let Some((lease, job)) = &driver.lease {
                return Ok(json!({"lease":lease,"job":job}));
            }
            if driver.revision != Some(control.revision) {
                driver.scheduled.clear();
                driver.reload = None;
                driver.revision = Some(control.revision);
            }
            if driver.scheduled.is_empty() && driver.reload.is_none_or(|at| at <= Instant::now()) {
                let jobs = db.work(move |h, p| h.scheduled_jobs(p, generation)).await?;
                driver.plan(jobs, self);
                continue;
            }
            let job = driver.scheduled.pop_front().or_else(|| {
                self.inbox
                    .lock()
                    .unwrap()
                    .forced
                    .pop_front()
                    .map(Job::forced)
            });
            if let Some(job) = job {
                let id = job.id;
                let result = if job.name == "tokenize_backfill" {
                    tokio::select! {
                        biased;
                        _ = changed.wait_for(|s| s.epoch != Some(epoch) || s.generation != generation) =>
                            return Err("Cron session was interrupted".into()),
                        result = db.run_word_backfill(generation, job) => result,
                    }
                } else if job.direct() {
                    db.work(move |h, p| h.run_direct_job(p, generation, &job))
                        .await
                } else {
                    driver.lease = Some((uuid::Uuid::new_v4().to_string(), job));
                    continue;
                };
                if let Err(error) = result {
                    eprintln!("GSM scheduled job failed: {error}");
                    if let Some(id) = id {
                        driver.retry_at.insert(id, Instant::now() + self.retry);
                    }
                }
                if id.is_some() {
                    driver.reload = None;
                }
                continue;
            }
            let deadline = driver.reload.expect("plan provides a deadline");
            tokio::select! {
                result=changed.changed()=>{result.map_err(|_|"Cron session closed")?;}
                _=tokio::time::sleep_until(deadline.into())=>{}
            }
        }
    }
}

impl Driver {
    async fn acknowledge(
        &mut self,
        db: &Database,
        generation: u64,
        ack: Option<Ack>,
        retry: Duration,
    ) -> Result<(), String> {
        let Some(((token, job), ack)) = self.lease.as_ref().zip(ack) else {
            return Ok(());
        };
        if *token != ack.lease {
            return Ok(());
        }
        if let Some(id) = job.id {
            if ack.finished {
                let job = job.clone();
                db.work(move |h, p| h.finish_scheduled_job(p, generation, &job, ack.next_run))
                    .await?;
            } else {
                self.retry_at.insert(id, Instant::now() + retry);
            }
            self.reload = None;
        }
        self.lease = None;
        Ok(())
    }
    fn plan(&mut self, jobs: Vec<Job>, run: &Run) {
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let now = Instant::now();
        let mut wake = now + run.refresh;
        self.retry_at.retain(|_, at| *at > now);
        for job in jobs {
            if !run.priorities.contains_key(&job.name) {
                continue;
            }
            if let Some(at) = job.id.and_then(|id| self.retry_at.get(&id)) {
                wake = wake.min(*at);
                continue;
            }
            if job.deadline <= wall {
                self.scheduled.push_back(job);
            } else {
                wake = wake.min(
                    now + Duration::from_secs_f64(
                        (job.deadline - wall).min(run.refresh.as_secs_f64()),
                    ),
                );
            }
        }
        self.scheduled
            .make_contiguous()
            .sort_by_key(|j| run.priorities[&j.name]);
        self.reload = Some(wake);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[tokio::test]
    async fn orders_jobs_replays_unacknowledged_leases_and_interrupts_idle_wait() {
        let dir = tempfile::tempdir().unwrap();
        let history = Arc::new(History::default());
        let path = dir.path().join("gsm.db");
        let db = Database {
            index: crate::word_index::WordIndex::start(
                path.clone(),
                history.clone(),
                Arc::new(gsm_sudachi::LanguageService::new(
                    dir.path().into(),
                    dir.path().join("user"),
                )),
            ),
            history,
            path,
        };
        let conn = Connection::open(&db.path).unwrap();
        conn.execute_batch("CREATE TABLE cron_table (id INTEGER PRIMARY KEY,name TEXT,enabled TEXT,next_run TEXT,schedule TEXT,last_run TEXT);
            INSERT INTO cron_table VALUES (1,'low','1','1','once',null),(2,'high','1','2','once',null),(3,'unknown','1','0','once',null),
            (5,'tokenize_backfill','1','0','once',null);").unwrap();
        let (control, _) = watch::channel(Control {
            epoch: Some(1),
            ..Control::default()
        });
        let run = Arc::new(Run {
            session: "test".into(),
            priorities: HashMap::from([
                ("low".into(), 100),
                ("high".into(), 10),
                ("tokenize_backfill".into(), 1),
            ]),
            retry: Duration::from_secs(60),
            refresh: Duration::from_secs(900),
            control,
            inbox: Mutex::default(),
            driver: AsyncMutex::default(),
        });
        let receipt = |v: &Value, finished| {
            Some(Ack {
                lease: v["lease"].as_str().unwrap().into(),
                finished,
                next_run: None,
            })
        };
        enqueue(&run, 1, "high".into()).unwrap();
        enqueue(&run, 1, "high".into()).unwrap();
        let first = run.next(db.clone(), 1, None).await.unwrap();
        assert_eq!(first["job"]["id"], 2);
        assert!(conn
            .query_row(
                "SELECT last_run IS NOT NULL AND enabled=0 FROM cron_table WHERE id=5",
                [],
                |row| row.get::<_, bool>(0)
            )
            .unwrap());
        run.control.send_modify(|s| s.epoch = Some(2));
        assert!(run.next(db.clone(), 1, None).await.is_err());
        assert_eq!(run.next(db.clone(), 2, None).await.unwrap(), first);
        let second = run
            .next(db.clone(), 2, receipt(&first, true))
            .await
            .unwrap();
        assert_eq!(second["job"]["id"], 1);
        assert_eq!(
            run.next(db.clone(), 2, receipt(&first, true))
                .await
                .unwrap(),
            second
        );
        let forced = run
            .next(db.clone(), 2, receipt(&second, false))
            .await
            .unwrap();
        assert!(forced["job"]["id"].is_null());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM cron_table WHERE enabled=1", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            2
        );
        let pull = run.next(db.clone(), 2, receipt(&forced, true));
        tokio::pin!(pull);
        assert!(tokio::time::timeout(Duration::from_millis(40), &mut pull)
            .await
            .is_err());
        conn.execute(
            "INSERT INTO cron_table VALUES (4,'high','1','0.5','once',null)",
            [],
        )
        .unwrap();
        run.control.send_modify(|s| s.revision += 1);
        let edited = tokio::time::timeout(Duration::from_secs(3), pull)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(edited["job"]["id"], 4);
        let waiting = run.next(db, 2, receipt(&edited, true));
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_millis(40), &mut waiting)
                .await
                .is_err()
        );
        run.control.send_modify(|s| s.epoch = None);
        assert!(tokio::time::timeout(Duration::from_secs(3), waiting)
            .await
            .unwrap()
            .is_err());
    }
}
