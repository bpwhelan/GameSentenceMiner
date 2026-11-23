//! A consistent view of local activity and the durable identity used to reconcile it.
mod activity;
mod catalog;
pub mod metadata;
mod state;

pub use crate::stats_export::library::spaced_json;
use crate::{History, ReportCleaner, Result};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

pub fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value))
}

pub struct SnapshotOptions<'a> {
    pub language: &'a str,
    pub include_external: bool,
    pub session_gap: f64,
    pub cleaner: &'a ReportCleaner,
}

#[derive(Serialize)]
pub struct Media {
    pub title: String,
    pub default_activity_type: &'static str,
    pub status: &'static str,
    pub tracking_status: &'static str,
    pub description: String,
    pub content_type: &'static str,
    pub extra_data: serde_json::Map<String, Value>,
    #[serde(skip)]
    pub cover_game: Option<String>,
    #[serde(skip)]
    pub legacy_activity: String,
}

#[derive(Serialize)]
pub struct Activity {
    pub media_key: String,
    pub date: String,
    pub characters: i64,
    pub duration_minutes: i64,
    pub activity_type: &'static str,
}

#[derive(Default)]
pub struct Snapshot {
    pub language: String,
    pub media: IndexMap<String, Media>,
    pub logs: IndexMap<String, Activity>,
    pub observed: BTreeSet<String>,
}

impl Snapshot {
    pub fn summary(&self) -> Value {
        let dates = self.logs.values().map(|row| row.date.as_str());
        json!({"media_count":self.media.len(),"activity_count":self.logs.len(),
            "characters":self.logs.values().map(|v| v.characters).sum::<i64>(),
            "duration_minutes":self.logs.values().map(|v| v.duration_minutes).sum::<i64>(),
            "first_date":dates.clone().min(),"last_date":dates.max()})
    }

    pub fn preview(&self) -> Value {
        let mut rows: Vec<_> = self.logs.values().enumerate().collect();
        // Only the earliest 100 are returned. Original order breaks ties for imported rows.
        let key = |(i, a): &(usize, &Activity), (j, b): &(usize, &Activity)| {
            (&a.date, &a.media_key, i).cmp(&(&b.date, &b.media_key, j))
        };
        if rows.len() > 100 {
            rows.select_nth_unstable_by(100, key);
            rows.truncate(100);
        }
        rows.sort_unstable_by(key);
        let mut summary = self.summary();
        summary["entries"] = Value::Array(
            rows.into_iter()
                .map(|(_, row)| {
                    let mut entry = json!(row);
                    entry["title"] = json!(self.media[&row.media_key].title);
                    entry
                })
                .collect(),
        );
        summary
    }
}

impl History {
    pub fn kechimochi_snapshot(
        &self,
        path: &Path,
        generation: u64,
        opts: &SnapshotOptions<'_>,
    ) -> Result<Snapshot> {
        self.check_kechimochi_generation(generation)?;
        let snapshot = self.with_reader(path, |conn| {
            let tx = conn.transaction()?;
            let previous = state::observed(&tx)?;
            let mut result = Snapshot {
                language: opts.language.into(),
                ..Default::default()
            };
            let mut catalog = catalog::Catalog::read(&tx, &mut result)?;
            activity::native(&tx, &mut result, &mut catalog, &previous, opts)?;
            if opts.include_external {
                activity::external(&tx, &mut result)?;
            }
            tx.commit()?;
            Ok(result)
        })?;
        self.check_kechimochi_generation(generation)?;
        Ok(snapshot)
    }
    pub fn check_kechimochi_generation(&self, generation: u64) -> Result<()> {
        if self.generation()? != generation {
            return Err("Job cancelled because the database closed".into());
        }
        Ok(())
    }
}
