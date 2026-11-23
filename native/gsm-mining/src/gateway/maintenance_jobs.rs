use gsm_web::{MaintenanceJob, Reply, Reports};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Jobs(Mutex<VecDeque<(Uuid, Value)>>);

impl Jobs {
    pub(super) fn get(&self, id: &str) -> Option<Value> {
        let id = Uuid::parse_str(id).ok()?;
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| key == &id)
            .map(|(_, status)| status.clone())
    }

    pub(super) fn start(
        self: &Arc<Self>,
        reports: Arc<Reports>,
        job: MaintenanceJob,
        body: Value,
        reader: Option<Arc<dyn super::ReaderEndpoint>>,
    ) -> Option<Reply> {
        match job.supported(&reports) {
            Ok(true) => {}
            Ok(false) => return None,
            Err(e) => {
                return Some(Reply {
                    status: 500,
                    body: json!({"error":e.to_string()}),
                })
            }
        }
        let refresh = job.changes_history();
        let work = match job.reserve(reports, &body) {
            Ok(work) => work,
            Err(reply) => return Some(reply),
        };
        let id = Uuid::new_v4();
        let body = json!({"id":id.to_string(), "status":"running"});
        {
            let mut jobs = self.0.lock().unwrap();
            if jobs.len() == 20 {
                jobs.pop_front();
            }
            jobs.push_back((id, body.clone()));
        }
        let book = self.clone();
        tokio::spawn(async move {
            let worker_book = book.clone();
            let index = reader.clone();
            let result = tokio::task::spawn_blocking(move || {
                work.run_with(
                    |ids, generation| {
                        let index = index.as_ref().ok_or("Word index unavailable")?;
                        tokio::runtime::Handle::current()
                            .block_on(index.prepare_archive_lines(ids, generation))
                    },
                    |progress| {
                        let mut jobs = worker_book.0.lock().unwrap();
                        if let Some((_, entry)) = jobs.iter_mut().find(|(key, _)| *key == id) {
                            if let (Some(entry), Value::Object(fields)) =
                                (entry.as_object_mut(), progress)
                            {
                                entry.extend(fields);
                            }
                        }
                    },
                )
                .map_err(|e| e.to_string())
            })
            .await;
            let result = result.map_err(|e| e.to_string()).and_then(|v| v);
            if refresh && result.is_ok() {
                if let Some(reader) = reader {
                    reader.library_changed().await;
                    reader.reading_stats_changed().await;
                }
            }
            if let Some((_, entry)) = book
                .0
                .lock()
                .unwrap()
                .iter_mut()
                .find(|(key, _)| *key == id)
            {
                match result {
                    Ok(result) => {
                        entry["result"] = result;
                        entry["status"] = "completed".into();
                    }
                    Err(message) => {
                        entry["error"] = message.into();
                        entry["status"] = "failed".into();
                    }
                }
            }
        });
        Some(Reply { status: 202, body })
    }
}
