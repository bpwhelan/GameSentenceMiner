//! A bounded, ordered lane for mining vocabulary. The committed line itself
//! is the durable backlog. Capture never waits for a dictionary or for space.
mod backfill;
pub(crate) use backfill::dictionary_edition;
use gsm_history::{
    word_index::{Cursor, Word},
    History,
};
use gsm_sudachi::{mining::analysis_text, LanguageService};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::Manager;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

const BATCH: usize = 32;
type Reply = oneshot::Sender<Result<usize, String>>;

enum Job {
    Lines {
        dictionary: String,
        ids: Vec<String>,
        reply: Option<Reply>,
        generation: Option<u64>,
        _budget: Option<OwnedSemaphorePermit>,
    },
    Flush(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct WordIndex {
    path: PathBuf,
    history: Arc<History>,
    backfill_lock: Arc<tokio::sync::Mutex<()>>,
    sender: mpsc::Sender<Job>,
    pending_bytes: Arc<Semaphore>,
}

impl WordIndex {
    pub fn start(path: PathBuf, history: Arc<History>, language: Arc<LanguageService>) -> Self {
        let (sender, mut receiver) = mpsc::channel(4096);
        let service = Self {
            path: path.clone(),
            history: history.clone(),
            backfill_lock: Arc::default(),
            sender,
            pending_bytes: Arc::new(Semaphore::new(8 * 1024 * 1024)),
        };
        tauri::async_runtime::spawn(async move {
            while let Some(job) = receiver.recv().await {
                match job {
                    Job::Lines {
                        dictionary,
                        ids,
                        reply,
                        generation,
                        _budget,
                    } => {
                        let mut errors = 0;
                        let mut interrupted = None;
                        let mut ids = ids.into_iter();
                        while ids.len() > 0 {
                            let batch: Vec<_> = ids.by_ref().take(BATCH).collect();
                            let count = batch.len();
                            match index(&path, &history, &language, &dictionary, batch, generation)
                                .await
                            {
                                Ok(failed) => errors += failed,
                                Err(error) => {
                                    if generation.is_some() {
                                        interrupted = Some(error);
                                        break;
                                    }
                                    errors += count;
                                    eprintln!("[word-index] {error}");
                                }
                            }
                        }
                        if let Some(reply) = reply {
                            let _ = reply.send(interrupted.map_or(Ok(errors), Err));
                        }
                    }
                    Job::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        service
    }

    pub fn enqueue(&self, dictionary: &str, ids: Vec<String>) {
        // Queue the entire import in original order. Limit resident ID storage
        // independently of its line count and analyze in small transactions.
        let bytes = ids.iter().map(String::capacity).sum::<usize>()
            + ids.capacity() * std::mem::size_of::<String>();
        let permit = self
            .pending_bytes
            .clone()
            .try_acquire_many_owned(u32::try_from(bytes).unwrap_or(u32::MAX));
        if let Ok(permit) = permit {
            let job = Job::Lines {
                dictionary: dictionary.to_owned(),
                ids,
                reply: None,
                generation: None,
                _budget: Some(permit),
            };
            if self.sender.try_send(job).is_ok() {
                return;
            }
        }
        eprintln!("[word-index] Capture backlog full. Saved lines remain eligible for backfill.");
    }

    pub async fn flush(&self) -> Result<(), String> {
        let (done, wait) = oneshot::channel();
        self.sender
            .send(Job::Flush(done))
            .await
            .map_err(|_| "Word index stopped")?;
        wait.await.map_err(|_| "Word index stopped".into())
    }

    async fn backfill(
        &self,
        dictionary: &str,
        ids: Vec<String>,
        generation: Option<u64>,
    ) -> Result<usize, String> {
        let mut errors = 0;
        let mut ids = ids.into_iter();
        while ids.len() > 0 {
            let (reply, wait) = oneshot::channel();
            let ids: Vec<_> = ids.by_ref().take(BATCH).collect();
            self.sender
                .send(Job::Lines {
                    dictionary: dictionary.to_owned(),
                    ids,
                    reply: Some(reply),
                    generation,
                    _budget: None,
                })
                .await
                .map_err(|_| "Word index stopped")?;
            errors += wait.await.map_err(|_| "Word index stopped")??;
        }
        Ok(errors)
    }

    async fn page(
        &self,
        dictionary: &str,
        after: Option<Cursor>,
        limit: usize,
        generation: Option<u64>,
    ) -> Result<(usize, usize, Option<Cursor>), String> {
        let (history, path) = (self.history.clone(), self.path.clone());
        let (ids, cursor) = tauri::async_runtime::spawn_blocking(move || {
            history.next_word_page(&path, after, limit, generation)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let attempted = ids.len();
        let errors = self.backfill(dictionary, ids, generation).await?;
        Ok((attempted, errors, cursor))
    }
}

async fn index(
    path: &std::path::Path,
    history: &Arc<History>,
    language: &LanguageService,
    dictionary: &str,
    ids: Vec<String>,
    generation: Option<u64>,
) -> Result<usize, String> {
    let (history, path) = (history.clone(), path.to_owned());
    let (history, path, lines) = tauri::async_runtime::spawn_blocking(move || {
        let lines = history
            .pending_words(&path, &ids, generation)
            .map_err(|e| e.to_string())?;
        Ok::<_, String>((history, path, lines))
    })
    .await
    .map_err(|e| e.to_string())??;
    if lines.is_empty() {
        return Ok(0);
    }
    // Empty and markup-only lines have no words, including before dictionary setup.
    let dictionary = if lines
        .iter()
        .any(|line| !analysis_text(&line.text).is_empty())
    {
        Some(language.mining_dictionary(dictionary).await)
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut ready = Vec::with_capacity(lines.len());
        let mut errors = 0;
        let mut last_error = None;
        for mut line in lines {
            let text = analysis_text(&line.text);
            if !text.is_empty() {
                let result = match dictionary.as_ref() {
                    Some(Ok(dict)) => dict.visit_words(&text, |word, reading, pos| {
                        line.words.push(Word {
                            headword: word.into(),
                            reading: reading.into(),
                            pos: pos.into(),
                        });
                    }),
                    Some(Err(error)) => Err(error.clone()),
                    None => Err("Sudachi dictionary unavailable".into()),
                };
                if let Err(error) = result {
                    errors += 1;
                    last_error = Some(error);
                    continue;
                }
            }
            ready.push(line);
        }
        errors += history
            .store_words(&path, ready, generation)
            .map_err(|e| e.to_string())?;
        if let Some(error) = last_error {
            eprintln!("[word-index] {errors} pending lines: {error}");
        }
        Ok(errors)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Flush,
    RunBackfill {
        generation: u64,
    },
    Backfill {
        dictionary: String,
        after: Option<gsm_history::word_index::Cursor>,
        limit: usize,
    },
}

pub async fn request(app: &tauri::AppHandle, data: Value) -> Result<Value, String> {
    let index = app.state::<WordIndex>();
    match serde_json::from_value(data).map_err(|e| e.to_string())? {
        Request::RunBackfill { generation } => index.run_backfill(generation).await,
        Request::Flush => {
            index.flush().await?;
            Ok(Value::Null)
        }
        Request::Backfill {
            dictionary,
            after,
            limit,
        } => {
            if !(1..=250).contains(&limit) {
                return Err("Invalid word index page size".into());
            }
            let (attempted, errors, cursor) = index.page(&dictionary, after, limit, None).await?;
            Ok(json!({"attempted":attempted,"errors":errors,"after":cursor}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn missing_dictionary_keeps_real_text_pending_but_indexes_removed_markup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gsm.db");
        let language = Arc::new(LanguageService::new(
            directory.path().into(),
            directory.path().join("user"),
        ));
        let history = Arc::new(History::default());
        let index = WordIndex::start(path.clone(), history.clone(), language);
        // An unavailable database must report failure and never create an empty
        // profile database. Barriers still complete after a failed work item.
        assert_eq!(
            index
                .backfill("small", vec!["absent".into()], None)
                .await
                .unwrap(),
            1
        );
        index.flush().await.unwrap();
        assert!(!path.exists());
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE game_lines(id TEXT PRIMARY KEY,line_text TEXT,timestamp REAL,tokenized INTEGER);
            CREATE TABLE words(id INTEGER PRIMARY KEY,word TEXT UNIQUE,reading TEXT,pos TEXT,in_anki INTEGER,first_seen REAL,first_seen_line_id TEXT,last_seen REAL);
            CREATE TABLE kanji(id INTEGER PRIMARY KEY,character TEXT UNIQUE);
            CREATE TABLE word_occurrences(word_id INTEGER,line_id TEXT);
            CREATE TABLE kanji_occurrences(kanji_id INTEGER,line_id TEXT);
            INSERT INTO game_lines VALUES('a','[sound:声]',1,0),('b','猫',1,0);").unwrap();
        index.enqueue("small", vec!["a".into(), "b".into()]);
        index.flush().await.unwrap();
        assert_eq!(
            db.query_row("SELECT id FROM game_lines WHERE tokenized=1", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "a"
        );
        assert_eq!(
            db.query_row("SELECT character FROM kanji", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "声"
        );
        assert_eq!(
            index
                .backfill("small", vec!["a".into(), "b".into()], None)
                .await
                .unwrap(),
            1
        );
        let config = directory.path().join("config.json");
        assert_eq!(index.run_backfill(0).await.unwrap()["skipped"], true);
        std::fs::write(&config, "{").unwrap();
        assert!(index.run_backfill(0).await.is_err());
        std::fs::write(
            &config,
            r#"{"experimental":{"enable_experimental_features":true,"enable_tokenization":true}}"#,
        )
        .unwrap();
        let result = index.run_backfill(0).await.unwrap();
        assert_eq!(result["attempted_lines"], 1);
        assert_eq!(result["processed"], 0);
        assert_eq!(result["errors"], 1);
        db.execute(
            "UPDATE game_lines SET line_text='[sound:猫]' WHERE id='b'",
            [],
        )
        .unwrap();
        assert_eq!(index.run_backfill(0).await.unwrap()["processed"], 1);
        assert_eq!(index.run_backfill(0).await.unwrap()["attempted_lines"], 0);
    }
}
