use crate::{anki_games, open, Request, Result};
use rusqlite::Connection;
use serde_json::Value;
use std::{
    mem::discriminant,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(PartialEq)]
pub(super) enum Key {
    Earliest(String),
    Kanji(String, String, Option<i64>, Option<i64>),
    Retention(anki_games::Report),
}

impl Key {
    pub(super) fn from_request(request: &Request) -> Option<Self> {
        match request {
            Request::AnkiEarliestNote { parent_tag } => Some(Self::Earliest(parent_tag.clone())),
            Request::AnkiNoteKanji {
                parent_tag,
                word_field,
                start,
                end,
            } => Some(Self::Kanji(
                parent_tag.clone(),
                word_field.clone(),
                *start,
                *end,
            )),
            Request::AnkiContentRetention(report) => Some(Self::Retention(report.clone())),
            _ => None,
        }
    }
}

// SQLite's data_version is comparable only on the same connection. This
// read-only observer never holds a transaction between requests. Cold queries
// run on independent readers so simultaneous dashboard sections can overlap.
struct Observer {
    path: PathBuf,
    connection: Connection,
    version: Option<i64>,
    snapshot: Arc<()>,
    results: Vec<(Key, Value)>,
}

#[derive(Default)]
pub(super) struct Cache(Mutex<Option<Observer>>);

impl Cache {
    pub(super) fn close(&self) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| "Anki report cache unavailable")?
            .take();
        Ok(())
    }

    pub(super) fn read(
        &self,
        path: &Path,
        key: Key,
        query: impl FnOnce() -> Result<Value>,
    ) -> Result<Value> {
        let snapshot = {
            let mut state = self.0.lock().map_err(|_| "Anki report cache unavailable")?;
            if state.as_ref().is_none_or(|o| o.path != path) {
                *state = Some(Observer {
                    path: path.to_owned(),
                    connection: open(path, false)?,
                    version: None,
                    snapshot: Arc::new(()),
                    results: Vec::new(),
                });
            }
            let observer = state.as_mut().ok_or("Missing Anki report observer")?;
            let version: i64 =
                observer
                    .connection
                    .pragma_query_value(None, "data_version", |r| r.get(0))?;
            if observer.version != Some(version) {
                observer.version = Some(version);
                observer.results.clear();
                observer.snapshot = Arc::new(());
            }
            if let Some((_, value)) = observer.results.iter().find(|(stored, _)| stored == &key) {
                return Ok(value.clone());
            }
            Arc::clone(&observer.snapshot)
        };
        let value = query()?;
        if !value.is_null() {
            let mut state = self.0.lock().map_err(|_| "Anki report cache unavailable")?;
            if let Some(observer) = state
                .as_mut()
                .filter(|o| Arc::ptr_eq(&o.snapshot, &snapshot))
            {
                // Keep only the latest filter selection for each of the three reports.
                observer
                    .results
                    .retain(|(old, _)| discriminant(old) != discriminant(&key));
                observer.results.push((key, value.clone()));
            }
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Barrier;

    #[test]
    fn old_snapshot_finishing_late_cannot_replace_a_newer_report() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gsm.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE updates(id INTEGER)")
            .unwrap();
        let cache = Cache::default();
        let barrier = Barrier::new(2);
        let key = || Key::Earliest("Game".into());
        std::thread::scope(|s| {
            let old = s.spawn(|| {
                cache
                    .read(&path, key(), || {
                        barrier.wait();
                        barrier.wait();
                        Ok(json!(1))
                    })
                    .unwrap()
            });
            barrier.wait();
            db.execute("INSERT INTO updates VALUES(2)", []).unwrap();
            assert_eq!(cache.read(&path, key(), || Ok(json!(2))).unwrap(), 2);
            barrier.wait();
            assert_eq!(old.join().unwrap(), 1);
        });
        assert_eq!(
            cache
                .read(&path, key(), || panic!("expected newer cached value"))
                .unwrap(),
            2
        );
    }
}
