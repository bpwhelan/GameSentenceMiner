//! Weekly vocabulary repair. The live capture lane gets a turn between each
//! dictionary batch. Neither dictionary work nor throttling holds the writer.
use super::WordIndex;
pub(crate) use gsm_settings::gsm_config::dictionary_edition;
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};

struct Options {
    enabled: bool,
    low_performance: bool,
    dictionary: String,
}

impl Options {
    fn read(path: &Path) -> Result<Self, String> {
        let doc = gsm_settings::read_object(path)?;
        let settings = &doc["experimental"];
        Ok(Self {
            enabled: settings["enable_experimental_features"] == true
                && settings["enable_tokenization"] == true,
            low_performance: settings["tokenize_low_performance"] == true,
            dictionary: dictionary_edition(&doc).to_owned(),
        })
    }
}

fn throttle(elapsed: Duration) -> Duration {
    (elapsed / 4).clamp(Duration::from_millis(50), Duration::from_secs(1))
}

impl WordIndex {
    pub(crate) async fn run_backfill(&self, generation: u64) -> Result<Value, String> {
        let _exclusive = self.backfill_lock.lock().await;
        let start = Instant::now();
        let config_path = self.path.with_file_name("config.json");
        let read_options = || {
            let path = config_path.clone();
            tauri::async_runtime::spawn_blocking(move || Options::read(&path))
        };
        let mut options = read_options().await.map_err(|e| e.to_string())??;
        if !options.enabled {
            return Ok(json!({"skipped":true, "reason":"tokenization disabled"}));
        }
        let (history, path) = (self.history.clone(), self.path.clone());
        let (cleaned, total) = tauri::async_runtime::spawn_blocking(move || {
            history.prepare_word_backfill(&path, generation)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let (mut cursor, mut attempted, mut errors, mut milestone) = (None, 0, 0, 0);
        while attempted < total {
            let page_started = Instant::now();
            let limit = (total - attempted).min(if options.low_performance { 50 } else { 250 });
            let (count, failed, after) = self
                .page(&options.dictionary, cursor, limit, Some(generation))
                .await?;
            if count == 0 {
                break;
            }
            attempted += count;
            errors += failed;
            cursor = after;
            let progress = attempted.saturating_mul(10) / total;
            if progress > milestone {
                milestone = progress;
                eprintln!(
                    "[word-index] Backfill {}% ({attempted}/{total}, {errors} errors)",
                    progress * 10
                );
            }
            if attempted == total {
                break;
            }
            if options.low_performance {
                tokio::time::sleep(throttle(page_started.elapsed())).await;
            }
            options = read_options().await.map_err(|e| e.to_string())??;
            if !options.enabled {
                break;
            }
        }
        Ok(
            json!({"skipped":false,"orphans_cleaned":cleaned,"total_lines":total,
            "attempted_lines":attempted,"processed":attempted-errors,"errors":errors,
            "elapsed_time":start.elapsed().as_secs_f64()}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weak_mode_paces_actual_work_and_honors_both_caps() {
        assert_eq!(throttle(Duration::ZERO), Duration::from_millis(50));
        assert_eq!(throttle(Duration::from_secs(2)), Duration::from_millis(500));
        assert_eq!(throttle(Duration::from_secs(20)), Duration::from_secs(1));
    }
}
