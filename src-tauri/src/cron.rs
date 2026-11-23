//! Run native jobs from database startup. When the compatibility worker
//! registers, its long poll drives the same deadline planner and can take
//! leases for jobs which still need it.
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
    local: Option<Arc<Run>>,
    ready: Option<(Database, u64)>,
    drive: Arc<AsyncMutex<()>>,
    manual_jobs: Arc<Mutex<VecDeque<&'static str>>>,
}
#[derive(Clone, Copy, Default)]
struct Control {
    epoch: Option<u64>,
    generation: u64,
    revision: u64,
}
struct Run {
    session: Option<String>,
    drive: Arc<AsyncMutex<()>>,
    manual_jobs: Arc<Mutex<VecDeque<&'static str>>>,
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
        owner.start_local();
    }
    pub fn forget_backend(&self) {
        let mut owner = self.0.lock().unwrap();
        if let Some(run) = owner.run.take() {
            run.control.send_modify(|state| state.epoch = None);
        }
        owner.start_local();
    }
    pub fn close(&self) {
        let mut owner = self.0.lock().unwrap();
        owner.manual_jobs = Arc::default();
        if let Some((db, _)) = owner.ready.take() {
            db.anki.database_closing();
        }
        owner.stop_local();
        if let Some(run) = owner.run.take() {
            run.control.send_modify(|state| state.epoch = None);
        }
    }
    pub fn force_anki(&self) -> Result<(), String> {
        self.force("anki_card_sync")
    }
    pub fn force_rollup(&self) -> Result<(), String> {
        self.force("daily_stats_rollup")
    }
    pub fn force_tokenization(&self) -> Result<(), String> {
        self.force("tokenize_backfill")
    }
    pub fn force_metadata(&self) -> Result<(), String> {
        self.force("jiten_sync")
    }
    fn force(&self, job: &'static str) -> Result<(), String> {
        let owner = self.0.lock().unwrap();
        if owner.ready.is_none() {
            return Err("The scheduled job database is unavailable".into());
        }
        if !owner.run.iter().chain(owner.local.iter()).any(|run|
            run.control.borrow().epoch.is_some() && run.priorities.contains_key(job)) {
            return Err(format!("No active scheduler handles {job}"));
        }
        let mut jobs = owner.manual_jobs.lock().unwrap();
        if jobs.len() >= 128 {
            return Err("Cron mailbox is full".into());
        }
        jobs.push_back(job);
        drop(jobs);
        for run in owner.local.iter().chain(owner.run.iter()) {
            run.control.send_modify(|_| {});
        }
        Ok(())
    }
    pub async fn drain(&self) {
        self.close();
        let drive = self.0.lock().unwrap().drive.clone();
        let _finished = drive.lock().await;
    }
    pub fn ready(&self, app: &AppHandle) -> Result<(), String> {
        let db = Database::new(app);
        let mut owner = self.0.lock().unwrap();
        let generation = db.history.generation().map_err(|e| e.to_string())?;
        owner.ready = Some((db, generation));
        owner.refresh_local(generation);
        Ok(())
    }
    pub fn refresh_generation(&self) -> Result<(), String> {
        let mut owner = self.0.lock().unwrap();
        if let Some((db, current)) = owner.ready.as_mut() {
            let generation = db.history.generation().map_err(|e| e.to_string())?;
            *current = generation;
            owner.refresh_local(generation);
        }
        Ok(())
    }
}

impl Owner {
    fn refresh_local(&mut self, generation: u64) {
        if self
            .local
            .as_ref()
            .is_some_and(|run| run.control.borrow().generation != generation)
        {
            // A replacement database can reuse row IDs. Drop retry deadlines
            // and any pending plan inherited from the previous writer.
            self.stop_local();
        }
        if let Some(run) = &self.local {
            run.control.send_modify(|state| {
                state.generation = generation;
                state.revision = state.revision.wrapping_add(1);
            });
        } else {
            self.start_local();
        }
    }

    fn stop_local(&mut self) {
        if let Some(run) = self.local.take() {
            run.control.send_modify(|state| state.epoch = None);
        }
    }

    fn start_local(&mut self) {
        if self.local.is_some()
            || self
                .run
                .as_ref()
                .is_some_and(|r| r.control.borrow().epoch.is_some())
        {
            return;
        }
        let Some((db, generation)) = self.ready.clone() else {
            return;
        };
        let priorities = [
            ("daily_stats_rollup", 10),
            ("populate_games", 100),
            ("database_maintenance", 100),
            ("anki_word_sync", 100),
            ("anki_card_sync", 100),
            ("tokenize_backfill", 1000),
            ("jiten_sync", 1000),
            ("jiten_upgrader", 1000),
            ("tadoku_sync", 1000),
            ("kechimochi_sync", 1000),
            ("daily_goals_completion", 100),
            (gsm_db::JITEN_GENRE_BACKFILL, 1000),
        ]
        .into_iter()
        .map(|(name, priority)| (name.to_owned(), priority))
        .collect();
        let run = Arc::new(Run {
            session: None,
            drive: self.drive.clone(),
            manual_jobs: self.manual_jobs.clone(),
            priorities,
            retry: Duration::from_secs(60),
            refresh: Duration::from_secs(900),
            control: watch::channel(Control {
                epoch: Some(0),
                generation,
                revision: 0,
            })
            .0,
            inbox: Mutex::default(),
            driver: AsyncMutex::default(),
        });
        self.local = Some(run.clone());
        tauri::async_runtime::spawn(async move {
            let mut changed = run.control.subscribe();
            while changed.borrow_and_update().epoch.is_some() {
                if let Err(error) = run.next(db.clone(), 0, None).await {
                    if changed.borrow().epoch.is_none() {
                        break;
                    }
                    eprintln!("GSM scheduled job planner: {error}");
                    tokio::select! {
                        _ = changed.changed() => {}
                        _ = tokio::time::sleep(run.retry) => {}
                    }
                }
            }
        });
    }
}

pub fn refresh(app: &AppHandle) {
    let owner = app.state::<Scheduler>();
    let owner = owner.0.lock().unwrap();
    for run in owner.local.iter().chain(owner.run.iter()) {
        run.control
            .send_modify(|s| s.revision = s.revision.wrapping_add(1));
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
        mut priorities,
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
        if !owner
            .ready
            .as_ref()
            .is_some_and(|(_, current)| *current == generation)
        {
            return Err("Database is not ready for scheduled jobs".into());
        }
        if owner
            .run
            .as_ref()
            .is_none_or(|r| r.session.as_ref() != Some(&session))
        {
            let retry = seconds(retry_seconds)?;
            let refresh = seconds(refresh_seconds)?;
            if let Some(old) = owner.run.take() {
                old.control.send_modify(|state| state.epoch = None);
            }
            let (control, _) = watch::channel(Control::default());
            priorities.insert(gsm_db::JITEN_GENRE_BACKFILL.to_owned(), 1000);
            owner.run = Some(Arc::new(Run {
                session: Some(session),
                drive: owner.drive.clone(),
                manual_jobs: owner.manual_jobs.clone(),
                priorities,
                retry,
                refresh,
                control,
                inbox: Mutex::default(),
                driver: AsyncMutex::default(),
            }));
        }
        owner.stop_local();
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
            .filter(|r| r.session.as_ref() == Some(&session))
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
                owner.start_local();
            }
            _ => {}
        }
        run
    };
    let db = Database::new(&app);
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
    app: Option<AppHandle>,
    index: crate::word_index::WordIndex,
    history: Arc<History>,
    path: PathBuf,
    default_config: PathBuf,
    anki: crate::anki_sync::SyncLane,
    http: reqwest::Client,
    runtime: crate::runtime::Runtime,
}
impl Database {
    fn new(app: &AppHandle) -> Self {
        Self {
            app: Some(app.clone()),
            index: app.state::<crate::word_index::WordIndex>().inner().clone(),
            history: app.state::<Arc<History>>().inner().clone(),
            path: app
                .state::<crate::settings::Settings>()
                .paths
                .active
                .join("gsm.db"),
            default_config: app
                .state::<crate::desktop_state::DesktopState>()
                .app_root
                .join("config.json"),
            anki: app.state::<crate::anki_sync::SyncLane>().inner().clone(),
            http: app
                .state::<crate::desktop_state::DesktopState>()
                .http
                .clone(),
            runtime: app.state::<crate::runtime::Runtime>().inner().clone(),
        }
    }
    async fn job_config(&self) -> Result<Value, String> {
        let default = self.default_config.clone();
        self.work(move |_, path| {
            let profile = path.with_file_name("config.json");
            Ok(gsm_settings::read_object(if profile.try_exists()? {
                &profile
            } else {
                &default
            })?)
        })
        .await
    }
    async fn rollup(&self, generation: u64, job: Job) -> Result<bool, String> {
        let config = self.job_config().await?;
        self.work(move |history, path| {
            let tokenized = vocabulary_enabled(&config);
            history.try_scheduled_rollup(path, generation, &job, &config["stats"], tokenized)
        })
        .await
    }
    async fn sync_tadoku(&self, generation: u64, job: Job) -> Result<bool, String> {
        let history = self.history.clone();
        self.work(move |h, path| {
            if !h.scheduled_job_current(path, generation, &job)? { return Ok(true) }
            let reports = Arc::new(gsm_mining::gateway::Reports::new(path.parent().ok_or("Missing profile directory")?, history));
            let result = match reports.prepare_tadoku(&Value::Null, true) {
                Ok(Some(work)) if work.generation() == generation => work.run().map(|_|()).map_err(|e|e.to_string()),
                Ok(Some(_)) => return Err("Database changed before Tadoku sync".into()),
                Ok(None) => return Ok(false),
                Err(reply) => Err(reply.body["error"].as_str().unwrap_or("Tadoku sync failed").to_owned()),
            };
            if let Err(error) = result {
                // Scheduled authentication and provider failures are retried at
                // the configured daily time, like the Python cron runner.
                eprintln!("Tadoku daily sync failed: {error}");
            }
            let next = if job.schedule == "daily" {
                let config = gsm_settings::read_object(&path.with_file_name("config.json"))?;
                Some(gsm_db::startup_jobs::next_tadoku_run(&config["stats"], chrono::Local::now())?)
            } else { None };
            h.finish_scheduled_job(path, generation, &job, next)?;
            Ok(true)
        }).await
    }
    async fn complete_goals(&self,generation:u64,job:Job)->Result<bool,String>{
        let history=self.history.clone();
        self.work(move |h,path|{
            if !h.scheduled_job_current(path,generation,&job)?{return Ok(true);}
            let reports=gsm_mining::gateway::Reports::new(path.parent().ok_or("Missing profile directory")?,history);
            if !reports.scheduled_goals(generation)?{return Ok(false);}
            h.finish_scheduled_job(path,generation,&job,None)?;Ok(true)
        }).await
    }
    async fn sync_kechimochi(&self,generation:u64,job:Job)->Result<bool,String>{
        let history=self.history.clone();
        self.work(move |h,path|{
            if !h.scheduled_job_current(path,generation,&job)? {return Ok(true);}
            let reports=Arc::new(gsm_mining::gateway::Reports::new(path.parent().ok_or("Missing profile directory")?,history));
            let start=reports.prepare_kechimochi(None,true,gsm_mining::config::profile_language_name);
            use gsm_mining::gateway::KechimochiStart;
            let failed=match start {
                Ok(KechimochiStart::Compatibility)=>return Ok(false),
                Ok(KechimochiStart::Ready(_,None))=>false,
                Ok(KechimochiStart::Ready(_,Some(work)))=>{
                    if work.generation()!=generation{return Err("Database changed before Kechimochi sync".into());}
                    work.run(false).is_err()
                }
                Err(reply) if reply.status==409=>return Ok(false),
                Err(reply)=>return Err(reply.body["error"].as_str().unwrap_or("Could not prepare Kechimochi sync").into())
            };
            let next=if job.id.is_some() && job.schedule!="once" {
                let config=gsm_settings::read_object(&path.with_file_name("config.json"))?;
                Some(gsm_db::startup_jobs::next_kechimochi_run(&config["stats"],chrono::Local::now(),failed)?)
            }else{None};
            h.finish_scheduled_job(path,generation,&job,next)?;Ok(true)
        }).await
    }
    async fn sync_metadata(&self, generation: u64, job: Job) -> Result<bool, String> {
        let check = job.clone();
        if !self.work(move |h,p| h.scheduled_job_current(p, generation, &check)).await? {
            return Ok(true);
        }
        if job.name == "jiten_upgrader" {
            crate::game_metadata::upgrade::run(
                self.http.clone(), self.history.clone(), self.path.clone(), generation,
            ).await?;
        } else {
            crate::game_metadata::sync(
                self.http.clone(), self.history.clone(), self.path.clone(), generation,
                self.app.as_ref(), job.name == gsm_db::JITEN_GENRE_BACKFILL,
            ).await?;
        }
        let _ = self.runtime.backend_command("game_library_changed", Value::Null).await;
        self.work(move |h, p| h.finish_scheduled_job(p, generation, &job, None)).await?;
        Ok(true)
    }
    async fn sync_anki(&self, generation: u64, job: Job) -> Result<bool, String> {
        let check = job.clone();
        if !self
            .work(move |h, p| h.scheduled_job_current(p, generation, &check))
            .await?
        {
            return Ok(true);
        }
        let config = self.job_config().await?;
        if !vocabulary_enabled(&config) {
            return Err("Anki sync skipped because tokenization is disabled".into());
        }
        let cache = gsm_history::anki_sync::Cache {
            history: self.history.clone(),
            path: self.path.clone(),
            generation,
        };
        self.anki.scheduled(&self.http, cache, &config).await?;
        let _ = self
            .runtime
            .backend_command("anki_cache_updated", Value::Null)
            .await;
        self.work(move |h, p| h.finish_scheduled_job(p, generation, &job, None))
            .await?;
        Ok(true)
    }
    async fn work<T: Send + 'static>(
        &self,
        f: impl FnOnce(&History, &std::path::Path) -> gsm_history::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let history = self.history.clone();
        let path = self.path.clone();
        tauri::async_runtime::spawn_blocking(move || f(&history, &path).map_err(|e| e.to_string()))
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

    async fn maintenance(&self, generation: u64, job: Job) -> Result<bool, String> {
        let check = job.clone();
        if !self
            .work(move |h, p| h.scheduled_job_current(p, generation, &check))
            .await?
        {
            return Ok(true);
        }
        let profile = self.path.parent().ok_or("Missing database directory")?;
        let reports = Arc::new(gsm_mining::gateway::Reports::new(
            profile,
            self.history.clone(),
        ));
        let index = self.index.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs_f64();
            reports
                .scheduled_maintenance(generation, now, |ids, generation| {
                    tokio::runtime::Handle::current()
                        .block_on(index.prepare_archive_lines(ids, generation))
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        let Some(result) = result else {
            return Ok(false);
        };
        if result["archived_lines"].as_u64().unwrap_or(0) > 0 {
            let _ = self.runtime.backend_command("game_library_changed", Value::Null).await;
            let _ = self.runtime.backend_command("reading_stats_changed", Value::Null).await;
        }
        if result["success"] != true {
            return Err(format!("Database maintenance failed: {}", result["errors"]));
        }
        self.work(move |h, p| h.finish_scheduled_job(p, generation, &job, None))
            .await?;
        Ok(true)
    }
}

fn vocabulary_enabled(config: &Value) -> bool {
    let flags = &config["experimental"];
    flags["enable_experimental_features"] == true && flags["enable_tokenization"] == true
}

impl Run {
    async fn next(&self, db: Database, epoch: u64, ack: Option<Ack>) -> Result<Value, String> {
        let mut changed = self.control.subscribe();
        let mut driver = self
            .driver
            .try_lock()
            .map_err(|_| "Cron request is already active")?;
        // An attaching worker waits for any native job already running. A
        // stale plan cannot start work after the new owner gets the clock.
        let _drive = tokio::select! {
            biased;
            _ = changed.wait_for(|s| s.epoch != Some(epoch)) => return Err("Cron session was interrupted".into()),
            guard = self.drive.lock() => guard,
        };
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
            // Keep a manual HTTP request queued until its operation returns.
            // Ownership changes can interrupt a network sync between pages.
            // During an ownership change, keep queued jobs for the worker
            // that handles them. Eligible jobs behind them can still run.
            let manual = if job.is_none() {
                self.manual_jobs.lock().unwrap().iter().copied().enumerate()
                    .find(|(_,name)|self.priorities.contains_key(*name))
            } else { None };
            let job = job.or_else(||manual.map(|(_,name)| Job::forced(name.into())));
            if let Some(job) = job {
                let id = job.id;
                let result = if job.name == "tokenize_backfill" {
                    tokio::select! {
                        biased;
                        _ = changed.wait_for(|s| s.epoch != Some(epoch) || s.generation != generation) =>
                            return Err("Cron session was interrupted".into()),
                        result = db.run_word_backfill(generation, job.clone()) => result.map(|()| true),
                    }
                } else if job.name == "tadoku_sync" {
                    db.sync_tadoku(generation, job.clone()).await
                } else if job.name == "kechimochi_sync" {
                    db.sync_kechimochi(generation, job.clone()).await
                } else if job.name == "daily_goals_completion" {
                    db.complete_goals(generation,job.clone()).await
                } else if matches!(job.name.as_str(), "jiten_sync" | "jiten_upgrader" | gsm_db::JITEN_GENRE_BACKFILL) {
                    tokio::select! {
                        biased;
                        _ = changed.wait_for(|s| s.epoch != Some(epoch) || s.generation != generation) =>
                            return Err("Cron session was interrupted".into()),
                        result = db.sync_metadata(generation,job.clone()) => result,
                    }
                } else if job.name == "daily_stats_rollup" {
                    db.rollup(generation, job.clone()).await
                } else if job.name == "database_maintenance" {
                    db.maintenance(generation,job.clone()).await
                } else if job.name == "anki_card_sync" {
                    tokio::select! {
                        biased;
                        _ = changed.wait_for(|s| s.epoch != Some(epoch) || s.generation != generation) =>
                            return Err("Cron session was interrupted".into()),
                        result = db.sync_anki(generation, job.clone()) => result,
                    }
                } else if job.direct() {
                    let direct = job.clone();
                    db.work(move |h, p| h.run_direct_job(p, generation, &direct))
                        .await
                        .map(|()| true)
                } else {
                    Ok(false)
                };
                let retry = match result {
                    Ok(true) => None,
                    Ok(false) if self.session.is_some() => {
                        if let Some((index,_)) = manual {
                            self.manual_jobs.lock().unwrap().remove(index);
                        }
                        driver.lease = Some((uuid::Uuid::new_v4().to_string(), job));
                        continue;
                    }
                    Ok(false) => Some(self.refresh),
                    Err(error) => {
                        eprintln!("GSM scheduled job '{}' failed: {error}", job.name);
                        Some(self.retry)
                    }
                };
                if let Some((index,_)) = manual {
                    self.manual_jobs.lock().unwrap().remove(index);
                }
                if id.is_some() {
                    driver.reload = None;
                }
                if let Some((id, delay)) = id.zip(retry) {
                    driver.retry_at.insert(id, Instant::now() + delay);
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

    fn fixture(dir: &tempfile::TempDir) -> Database {
        let history = Arc::new(History::default());
        let path = dir.path().join("gsm.db");
        Database {
            app: None,
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
            default_config: dir.path().join("config.json"),
            http: reqwest::Client::new(),
            anki: Default::default(),
            runtime: Default::default(),
        }
    }

    #[tokio::test]
    async fn native_clock_retries_deferred_rollups_after_a_writer_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let db = fixture(&dir);
        let conn = gsm_db::open_profile(&db.path, "ja").unwrap();
        conn.execute_batch("INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES ('one','Game','猫犬',1600000000);
            INSERT INTO cron_table(name,enabled,next_run,schedule) VALUES ('daily_stats_rollup',1,1,'once'),
            ('populate_games',1,1,'once'),('jiten_sync',1,1,'once'),('jiten_upgrader',1,1,'once'),
            ('tadoku_sync',1,1,'once'),('kechimochi_sync',1,1,'once'),('daily_goals_completion',1,1,'once'),('unknown_extension_job',1,1,'once');").unwrap();
        std::fs::write(
            &db.default_config,
            r#"{"stats":{"extra_punctuation_regex":"(?<=猫+)犬"}}"#,
        )
        .unwrap();
        let scheduler = Scheduler::default();
        {
            let mut owner = scheduler.0.lock().unwrap();
            owner.ready = Some((db.clone(), 0));
            owner.start_local();
        }
        let wait_for = |name: &'static str| {
            let conn = &conn;
            async move {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !conn
                        .query_row(
                            "SELECT last_run IS NOT NULL FROM cron_table WHERE name=?",
                            [name],
                            |r| r.get::<_, bool>(0),
                        )
                        .unwrap()
                    {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap()
            }
        };
        wait_for("populate_games").await;
        assert_eq!(
            conn.query_row("SELECT count(*) FROM daily_stats_rollup", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        db.history.close().unwrap();
        std::fs::write(&db.default_config, "{}").unwrap();
        scheduler.refresh_generation().unwrap();
        wait_for("daily_stats_rollup").await;
        wait_for("jiten_sync").await;
        wait_for("jiten_upgrader").await;
        wait_for("tadoku_sync").await;
        wait_for("kechimochi_sync").await;
        wait_for("daily_goals_completion").await;
        scheduler.drain().await;
        assert_eq!(
            conn.query_row(
                "SELECT CAST(total_characters AS INTEGER) FROM daily_stats_rollup",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert!(conn
            .query_row(
                "SELECT last_run IS NULL FROM cron_table WHERE name='unknown_extension_job'",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        scheduler.connection(None);
        assert!(scheduler.0.lock().unwrap().local.is_none());
    }

    #[tokio::test]
    async fn orders_jobs_replays_unacknowledged_leases_and_interrupts_idle_wait() {
        let dir = tempfile::tempdir().unwrap();
        let db = fixture(&dir);
        let conn = Connection::open(&db.path).unwrap();
        conn.execute_batch("CREATE TABLE cron_table (id INTEGER PRIMARY KEY,name TEXT,enabled TEXT,next_run TEXT,schedule TEXT,last_run TEXT);
            INSERT INTO cron_table VALUES (1,'low','1','1','once',null),(2,'high','1','2','once',null),(3,'unknown','1','0','once',null),
            (5,'tokenize_backfill','1','0','once',null);").unwrap();
        let (control, _) = watch::channel(Control {
            epoch: Some(1),
            ..Control::default()
        });
        let run = Arc::new(Run {
            session: Some("test".into()),
            drive: Arc::default(),
            manual_jobs: Arc::default(),
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
