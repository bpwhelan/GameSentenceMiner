//! Application-owned dictionary entry points. The overlay is only a consumer.
//! Extension storage/profile paths deliberately stay stable across this redesign.
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub async fn handle_request(app: &AppHandle, topic: &str, request: &Value) -> Value {
    match topic {
        "dictionary.setup" => {
            crate::reader_service::handle_ws2_dictionary_setup(app, request).await
        }
        "dictionary.ankiSetup" => crate::reader_service::handle_ws2_anki_setup(app, request).await,
        _ => serde_json::json!({"success": false, "error": "Unknown dictionary request"}),
    }
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<crate::dictionary_host::DictionaryManager>();
        let result = async {
            let (reader, extension) = manager.load_selected_extension(&app).await?;
            if reader == "hachidori" {
                manager.ensure_hachidori_engine(&app, &extension).await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            // Explicit requests retry and report the error to their caller.
            eprintln!("[dictionary] Background preparation failed: {error}");
        }
    });
}
