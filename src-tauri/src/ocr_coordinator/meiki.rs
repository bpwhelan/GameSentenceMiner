use gsm_overlay::engines::meiki::selection::Detector;
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;
use tokio::sync::Semaphore;

// Changes run on the blocking pool. Polling the status never waits for a
// model download or ORT session construction.
static CHANGES: Semaphore = Semaphore::const_new(1);

pub(crate) fn request(base: &Path, input: &Value) -> Value {
    let change = || -> Result<(), String> {
        let data = input
            .as_object()
            .ok_or("Expected a MeikiOCR model request")?;
        let Some(model) = data.get("model") else {
            return Ok(());
        };
        let detector: Detector = serde_json::from_value(model.clone())
            .map_err(|_| "Choose a MeikiOCR detector: small or large")?;
        let _slot = CHANGES
            .try_acquire()
            .map_err(|_| "Another MeikiOCR model change is in progress. Try again shortly.")?;
        detector.select(base).map_err(|e| format!("{e:#}"))
    };
    let change = change();
    let current = Detector::read(base);
    let error = change
        .err()
        .or_else(|| current.as_ref().err().map(ToString::to_string));
    let mut status = json!({"model": current.unwrap_or_default(), "available": true, "busy": CHANGES.available_permits() == 0});
    if let Some(error) = error {
        status["error"] = Value::String(error);
    }
    status
}

pub(crate) async fn invoke(app: &tauri::AppHandle, input: Value) -> Result<Value, String> {
    let base = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .clone();
    tauri::async_runtime::spawn_blocking(move || request(&base, &input))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires the isolated model fixture from scripts/benchmark_meiki_settings.py"]
    fn benchmark() {
        use std::{
            io::{self, BufRead},
            time::Instant,
        };
        let base = std::path::PathBuf::from(std::env::var_os("GSM_DATA_DIR").unwrap());
        let handler = if std::env::var("GSM_BENCH_MODEL_ENGINE").as_deref() == Ok("vocr") {
            super::super::vocr::request
        } else {
            request
        };
        println!("ready {}", std::process::id());
        for line in io::stdin().lock().lines() {
            let (operation, count, _): (String, u32, bool) =
                serde_json::from_str(&line.unwrap()).unwrap();
            let input = if operation == "select" {
                json!({"model":"small"})
            } else {
                json!({})
            };
            let now = Instant::now();
            let mut result = Value::Null;
            for _ in 0..count {
                result = handler(&base, &input);
            }
            println!(
                "{}",
                json!({"ms":now.elapsed().as_secs_f64()*1000.0/f64::from(count),"result":result})
            );
        }
    }
}
