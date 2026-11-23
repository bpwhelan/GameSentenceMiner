use super::*;
use gsm_web::{ExportFile, ExportWork, Reply};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, SystemTime},
};
use uuid::Uuid;

struct Job {
    status: Value,
    generation: u64,
    file: Option<Arc<ExportFile>>,
}

pub(super) struct Jobs {
    entries: Mutex<HashMap<Uuid, Arc<Mutex<Job>>>>,
    slot: Arc<tokio::sync::Semaphore>,
}

impl Default for Jobs {
    fn default() -> Self {
        Self {
            entries: Default::default(),
            slot: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
}

impl Jobs {
    fn lookup(&self, id: &str, generation: u64) -> Option<Arc<Mutex<Job>>> {
        let id = id.parse::<Uuid>().ok()?;
        let job = self.entries.lock().ok()?.get(&id)?.clone();
        let matches = job.lock().ok()?.generation == generation;
        matches.then_some(job)
    }

    pub(super) fn file(&self, id: &str, generation: u64) -> Option<Arc<ExportFile>> {
        self.lookup(id, generation)?.lock().ok()?.file.clone()
    }

    pub(super) fn status(&self, id: &str, generation: u64) -> Option<Value> {
        Some(self.lookup(id, generation)?.lock().ok()?.status.clone())
    }

    pub(super) fn start(self: &Arc<Self>, work: ExportWork) -> Reply {
        let id = Uuid::new_v4();
        let status = json!({"job_id":id,"format":work.format(),"status":"queued","progress":0,"message":"Queued","row_count":0});
        let job = Arc::new(Mutex::new(Job {
            status: status.clone(),
            generation: work.generation(),
            file: None,
        }));
        self.entries.lock().unwrap().insert(id, job.clone());
        let slot = self.slot.clone();
        let book = Arc::downgrade(self);
        tokio::spawn(async move {
            let child = job.clone();
            let permit = slot.acquire_owned().await.expect("export queue is open");
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                work.write(|progress, message| {
                    let mut job = child.lock().unwrap();
                    job.status["status"] = "running".into();
                    job.status["progress"] = progress.into();
                    job.status["message"] = message.into();
                })
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|v| v.map_err(|e| e.to_string()));
            {
                let mut job = job.lock().unwrap();
                job.status["progress"] = 100.into();
                job.status["completed_at"] = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64()
                    .into();
                match result {
                    Ok(file) => {
                        job.status["status"] = "completed".into();
                        job.status["message"] = if file.first_incremental {"Export complete. No previous successful export was found, so all-time data was exported."} else {"Export complete."}.into();
                        job.status["row_count"] = file.rows.into();
                        job.status["filename"] = file.filename.clone().into();
                        job.status["download_url"] =
                            format!("/api/stats-export/jobs/{id}/download").into();
                        job.file = Some(Arc::new(file));
                    }
                    Err(error) => {
                        job.status["status"] = "failed".into();
                        job.status["message"] = "Export failed.".into();
                        job.status["error"] = error.into();
                    }
                }
            }
            drop(job);
            tokio::time::sleep(Duration::from_secs(3600)).await;
            if let Some(book) = book.upgrade() {
                book.entries.lock().unwrap().remove(&id);
            }
        });
        Reply {
            status: 202,
            body: status,
        }
    }
}
