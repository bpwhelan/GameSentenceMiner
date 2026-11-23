use gsm_mining::{
    clips::{catalog, get_clips_root, ClipFolders},
    gateway::StatusCode,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tauri::{AppHandle, Manager};

pub(crate) fn request(app: &AppHandle, path: &str, body: &Value) -> (StatusCode, Value) {
    let config = match app.state::<Arc<super::MiningService>>().load_config() {
        Ok(config) => config,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, json!({"error":error})),
    };
    let root = get_clips_root(&config);
    if path == "/save-clip" {
        return super::clip_capture::queue(app, root.as_deref(), body, config.paths.remove_video);
    }
    if path == "/api/clips" {
        return (StatusCode::OK, catalog(root.as_deref()));
    }
    let library = root.as_deref().and_then(ClipFolders::open);
    match path {
        "/api/clips/open" => {
            let Some(folder) = library
                .as_ref()
                .zip(body["id"].as_str())
                .and_then(|(library, id)| library.resolve(id))
            else {
                return (StatusCode::NOT_FOUND, json!({"error":"Clip not found."}));
            };
            match crate::native::shell_open_path(&folder) {
                Ok(()) => (StatusCode::OK, json!({"opened":true})),
                Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, json!({"error":error})),
            }
        }
        "/api/clips/trash" => {
            let Some(ids) = body["ids"].as_array().filter(|v| !v.is_empty()) else {
                return (
                    StatusCode::BAD_REQUEST,
                    json!({"error":"No clips selected."}),
                );
            };
            (
                StatusCode::OK,
                trash_many(library.as_ref(), ids, |p| {
                    trash::delete(p).map_err(|e| e.to_string())
                }),
            )
        }
        _ => (StatusCode::NOT_FOUND, json!({"error":"Unknown clip route"})),
    }
}

fn trash_many(
    library: Option<&ClipFolders>,
    ids: &[Value],
    mut recycle: impl FnMut(&Path) -> Result<(), String>,
) -> Value {
    let mut trashed = Vec::new();
    let mut failed = Vec::new();
    for id in ids {
        let Some(folder) = library
            .zip(id.as_str())
            .and_then(|(library, id)| library.resolve(id))
        else {
            failed.push(json!({"id":id,"error":"Clip not found."}));
            continue;
        };
        match recycle(&folder) {
            Ok(()) => trashed.push(id),
            Err(e) => {
                failed.push(json!({"id":id,"error":format!("Could not move it to the trash: {e}")}))
            }
        }
    }
    json!({"trashed":trashed,"failed":failed})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batch_reports_each_shell_outcome_and_continues_after_errors() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["locked", "good"] {
            let folder = dir.path().join("day").join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("manifest.json"), "{}").unwrap();
        }
        let library = ClipFolders::open(dir.path()).unwrap();
        let mut calls = Vec::new();
        let result = trash_many(
            Some(&library),
            &[json!("day/locked"), json!("../bad"), json!("day/good")],
            |folder| {
                calls.push(folder.to_owned());
                if folder.ends_with("locked") {
                    Err("locked".into())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(calls.len(), 2);
        assert_eq!(
            result,
            json!({"trashed":["day/good"],"failed":[
            {"id":"day/locked","error":"Could not move it to the trash: locked"},{"id":"../bad","error":"Clip not found."}]})
        );
    }
}
