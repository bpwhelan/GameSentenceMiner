use serde_json::Value;
use tauri::{AppHandle, Manager};

pub async fn request(app: AppHandle, data: Value) -> Result<Value, String> {
    if data["operation"] == "closeWriter" {
        app.state::<crate::cron::Scheduler>().close();
        app.state::<crate::word_index::WordIndex>().flush().await?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let request = serde_json::from_value(data).map_err(|e| e.to_string())?;
        let index = match &request {
            gsm_history::Request::CaptureLines(batch) => batch.word_index(),
            _ => None,
        };
        let path = app
            .state::<crate::settings::Settings>()
            .paths
            .active
            .join("gsm.db");
        let result = app
            .state::<std::sync::Arc<gsm_history::History>>()
            .run(&path, request)
            .map_err(|e| e.to_string())?;
        if let Some((dictionary, ids)) = index {
            app.state::<crate::word_index::WordIndex>()
                .enqueue(&dictionary, ids);
        }
        gsm_runtime::bounded_reply(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
