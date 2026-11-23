use gsm_web::{tadoku::Sync, Reply};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Jobs(Mutex<HashMap<Uuid, (u64, Value)>>);

impl Jobs {
    pub fn status(&self, id: &str, generation: u64) -> Option<Value> {
        let jobs = self.0.lock().ok()?;
        let (epoch, status) = jobs.get(&id.parse().ok()?)?;
        (*epoch == generation).then(|| status.clone())
    }
    pub fn start(self: &Arc<Self>, work: Sync) -> Reply {
        let generation = work.generation();
        let id = Uuid::new_v4();
        let initial =
            json!({"job_id":id.simple().to_string(),"status":"queued","result":null,"error":null});
        {
            let mut jobs = self.0.lock().unwrap();
            jobs.retain(|_, (epoch, _)| *epoch == generation);
            jobs.insert(id, (generation, initial.clone()));
        }
        let book = self.clone();
        tokio::spawn(async move {
            if let Some((_, record)) = book.0.lock().unwrap().get_mut(&id) {
                record["status"] = "running".into();
            }
            let outcome =
                tokio::task::spawn_blocking(move || work.run().map_err(|e| e.to_string()))
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|v| v);
            if let Some((_, record)) = book.0.lock().unwrap().get_mut(&id) {
                match outcome {
                    Ok(result) => {
                        record["status"] = "completed".into();
                        record["result"] = result;
                    }
                    Err(error) => {
                        record["status"] = "failed".into();
                        record["error"] = error.into();
                    }
                }
            }
        });
        Reply {
            status: 202,
            body: initial,
        }
    }
}
