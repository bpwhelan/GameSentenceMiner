use super::{backup_ocr_config, reload_active_ocr, sanitize_ocr_filename, OCR_FILE_LOCK};
use caseless::Caseless;
use gsm_mining::gateway::{AreaRequest, AreaResponse, StatusCode};
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tauri::Manager;

type Result<T> = std::result::Result<T, AreaResponse>;

fn invalid(message: impl Into<String>) -> AreaResponse {
    AreaResponse::error(StatusCode::BAD_REQUEST, message)
}

fn failure(error: impl std::fmt::Display) -> AreaResponse {
    AreaResponse::error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn valid_config_name(name: &str) -> bool {
    let base = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let device = matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || base
        .strip_prefix("COM")
        .or_else(|| base.strip_prefix("LPT"))
        .is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    !(cfg!(windows) && device || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c)))
}

pub(super) fn config_path(root: &Path, name: Option<&str>) -> Result<PathBuf> {
    let raw = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("An OCR config name is required."))?;
    let name = if raw.to_ascii_lowercase().ends_with(".json") {
        raw.to_owned()
    } else {
        format!("{raw}.json")
    };
    if !valid_config_name(&name) {
        return Err(invalid("Invalid OCR config name."));
    }
    let path = root.join(&name);
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let resolved = path.canonicalize().map_err(failure)?;
            if resolved.parent() != Some(root) {
                return Err(invalid("Invalid OCR config path."));
            }
            Ok(resolved)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(path),
        Err(e) => Err(failure(e)),
    }
}

pub(super) fn read_config(path: &Path) -> Result<Value> {
    let data = fs::read(path).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            AreaResponse::error(StatusCode::NOT_FOUND, "OCR config not found.")
        } else {
            failure(e)
        }
    })?;
    let config: Value = serde_json::from_slice(&data).map_err(|e| invalid(e.to_string()))?;
    if !config.is_object() {
        return Err(invalid("OCR config must contain a JSON object."));
    }
    Ok(config)
}

fn is_area(config: &Value) -> bool {
    config["rectangles"].is_array() || config["rects"].is_array()
}

fn identity(path: &Path, config: &Value) -> Value {
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
    json!({"name":path.file_name().and_then(|v|v.to_str()), "is_overlay":stem.ends_with("_overlay"),
        "scene":config["scene"].as_str().filter(|s| !s.is_empty()).unwrap_or_else(||stem.strip_suffix("_overlay").unwrap_or(stem))})
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(m) => !m.is_empty(),
    }
}

fn integer(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| {
            v.as_f64()
                .filter(|n| *n >= i64::MIN as f64 && *n < i64::MAX as f64)
                .map(|n| n as i64)
        })
        .or_else(|| v.as_str()?.trim().parse().ok())
        .or_else(|| v.as_bool().map(i64::from))
}

fn dimensions(geometry: &Value) -> [i64; 2] {
    [
        integer(&geometry["width"])
            .filter(|x| *x > 0)
            .unwrap_or(1920),
        integer(&geometry["height"])
            .filter(|x| *x > 0)
            .unwrap_or(1080),
    ]
}

fn image_size(config: &Value) -> [i64; 2] {
    if config["window_geometry"].is_object() {
        return dimensions(&config["window_geometry"]);
    }
    if let Some(monitor) = config["rectangles"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| &r["monitor"])
        .find(|m| truthy(&m["width"]) && truthy(&m["height"]))
    {
        return dimensions(monitor);
    }
    [1920, 1080]
}

pub(super) fn coordinates(value: &Value) -> Result<[f64; 4]> {
    let values = value
        .as_array()
        .filter(|a| a.len() == 4)
        .ok_or_else(|| invalid("Each rectangle must have four coordinates."))?;
    let mut result = [0.; 4];
    for (out, value) in result.iter_mut().zip(values) {
        *out = value
            .as_f64()
            .or_else(|| value.as_str()?.trim().parse().ok())
            .or_else(|| value.as_bool().map(|b| i32::from(b) as f64))
            .filter(|v| v.is_finite())
            .ok_or_else(|| invalid("Rectangle coordinates must be finite numbers."))?;
    }
    Ok(result)
}

pub(super) fn message(response: AreaResponse) -> String {
    match response {
        AreaResponse::Json(_, body) => body["error"]
            .as_str()
            .unwrap_or("Could not read the OCR area config.")
            .to_owned(),
        AreaResponse::Jpeg(_) => "Unexpected OCR area response.".into(),
    }
}

fn rectangle(data: &Value, xywh: [f64; 4], default_index: i64) -> Result<Value> {
    let monitor = &data["monitor"];
    let mut normalized = json!({"index":default_index});
    if let Some(index) = monitor.get("index") {
        normalized["index"] = if truthy(index) {
            integer(index).ok_or_else(|| invalid("Invalid monitor index."))?
        } else {
            0
        }
        .into();
    }
    for key in ["left", "top", "width", "height"] {
        if !monitor[key].is_null() {
            normalized[key] = integer(&monitor[key])
                .ok_or_else(|| invalid("Invalid monitor geometry."))?
                .into();
        }
    }
    Ok(
        json!({"coordinates":xywh,"monitor":normalized,"is_excluded":truthy(&data["is_excluded"]),
        "is_secondary":truthy(&data["is_secondary"]),"is_exclusive":truthy(&data["is_exclusive"]),"is_black_hole":truthy(&data["is_black_hole"])}),
    )
}

fn browser_config(path: &Path, config: &Value) -> Result<Value> {
    let [width, height] = image_size(config);
    let pixels =
        truthy(&config["coordinate_system"]) && config["coordinate_system"] != "percentage";
    let modern = config["rectangles"].as_array();
    let index = if modern.is_none() && truthy(&config["monitor_index"]) {
        integer(&config["monitor_index"]).ok_or_else(|| invalid("Invalid monitor index."))?
    } else {
        0
    };
    let mut rects = Vec::new();
    for row in modern
        .or_else(|| config["rects"].as_array())
        .into_iter()
        .flatten()
        .filter(|v| v.is_object())
    {
        let mut coords = if modern.is_some() {
            coordinates(&row["coordinates"])?
        } else {
            coordinates(&json!([row["x"], row["y"], row["w"], row["h"]]))?
        };
        if pixels {
            for (i, x) in coords.iter_mut().enumerate() {
                *x /= if i % 2 == 0 { width } else { height } as f64;
            }
        }
        rects.push(rectangle(row, coords, index)?);
    }
    let mut out = identity(path, config);
    out["image_size"] = json!({"width":width,"height":height});
    out["rectangles"] = rects.into();
    Ok(out)
}

fn save(path: &Path, body: &Value) -> Result<Value> {
    let mut config = if path.try_exists().map_err(failure)? {
        read_config(path)?
    } else {
        json!({})
    };
    let info = identity(path, &config);
    let items = body["rectangles"]
        .as_array()
        .ok_or_else(|| invalid("rectangles must be a list."))?;
    let mut rects = Vec::with_capacity(items.len());
    for item in items {
        if !item.is_object() {
            return Err(invalid("Each rectangle must be an object."));
        }
        let [x, y, w, h] = coordinates(&item["coordinates"])?;
        let x = x.clamp(0., 1.);
        let y = y.clamp(0., 1.);
        let w = w.clamp(0., 1. - x);
        let h = h.clamp(0., 1. - y);
        if w <= 0. || h <= 0. {
            return Err(invalid(
                "Rectangle width and height must be greater than zero.",
            ));
        }
        let mut rect = rectangle(item, [x, y, w, h], 0)?;
        if info["is_overlay"] == true {
            for flag in ["is_secondary", "is_exclusive", "is_black_hole"] {
                rect[flag] = false.into();
            }
        }
        rects.push(rect);
    }
    let obj = config.as_object_mut().expect("object checked on read");
    obj.remove("rects");
    obj.remove("monitor_index");
    config["coordinate_system"] = "percentage".into();
    config["scene"] = info["scene"].clone();
    config["rectangles"] = rects.into();
    if !config["window_geometry"].is_object() {
        let [width, height] = dimensions(&body["image_size"]);
        config["window_geometry"] = json!({"left":0,"top":0,"width":width,"height":height});
    }
    let response = browser_config(path, &config)?;
    backup_ocr_config(path).map_err(failure)?;
    gsm_settings::write_atomic(path, &config).map_err(failure)?;
    Ok(json!({"message":format!("Saved {} OCR areas.",items.len()),"config":response}))
}

fn config_request(profile: &Path, request: AreaRequest, scene: &str) -> Result<Value> {
    let root = profile.join("ocr_config");
    fs::create_dir_all(&root).map_err(failure)?;
    let root = root.canonicalize().map_err(failure)?;
    match request {
        AreaRequest::List => {
            let mut files = Vec::new();
            for entry in fs::read_dir(&root).map_err(failure)? {
                let entry = entry.map_err(failure)?;
                let name = entry.file_name();
                let Some(name) = name
                    .to_str()
                    .filter(|s| s.to_ascii_lowercase().ends_with(".json"))
                else {
                    continue;
                };
                // read_dir already supplies the file type on Windows. Resolve
                // links explicitly and avoid two extra filesystem lookups for
                // each ordinary config in the gallery.
                let path = match entry.file_type() {
                    Ok(kind) if kind.is_file() && valid_config_name(name) => entry.path(),
                    Ok(kind) if kind.is_symlink() => match config_path(&root, Some(name)) {
                        Ok(path) => path,
                        Err(_) => continue,
                    },
                    _ => continue,
                };
                if let Ok(config) = read_config(&path) {
                    if is_area(&config) {
                        files.push(identity(&entry.path(), &config));
                    }
                }
            }
            files.sort_by_cached_key(|m| {
                m["name"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .default_case_fold()
                    .collect::<String>()
            });
            Ok(json!({"configs":files}))
        }
        AreaRequest::Load(name) => {
            let path = config_path(&root, name.as_deref())?;
            let config = read_config(&path)?;
            if !is_area(&config) {
                return Err(invalid("The selected file is not an OCR area config."));
            }
            browser_config(&path, &config)
        }
        AreaRequest::Current => {
            let scene = sanitize_ocr_filename(scene);
            let path = config_path(&root, Some(scene.trim()))?;
            let _lock = OCR_FILE_LOCK.lock().map_err(failure)?;
            let config = if path.try_exists().map_err(failure)? {
                let config = read_config(&path)?;
                if !is_area(&config) {
                    return Err(invalid("The current scene file is not an OCR area config."));
                }
                config
            } else {
                let initial =
                    json!({"scene":scene.trim(),"coordinate_system":"percentage","rectangles":[]});
                gsm_settings::write_atomic(&path, &initial).map_err(failure)?;
                initial
            };
            browser_config(&path, &config)
        }
        AreaRequest::Save(body) => {
            if !body.is_object() {
                return Err(invalid("A JSON request body is required."));
            }
            let path = config_path(&root, body["name"].as_str())?;
            let _lock = OCR_FILE_LOCK.lock().map_err(failure)?;
            save(&path, &body)
        }
        AreaRequest::Screenshot => unreachable!("screenshots go directly to OBS"),
    }
}

pub(crate) async fn request(app: &tauri::AppHandle, operation: AreaRequest) -> AreaResponse {
    if matches!(operation, AreaRequest::Screenshot) {
        return match app.state::<crate::obs::Obs>().area_screenshot(app).await {
            Some(bytes) => AreaResponse::Jpeg(bytes),
            None => AreaResponse::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "No active OBS video source is available.",
            ),
        };
    }
    let scene = if matches!(operation, AreaRequest::Current) {
        app.state::<crate::obs::Obs>().area_scene(app).await
    } else {
        String::new()
    };
    let saved = matches!(operation, AreaRequest::Save(_));
    let base = super::paths_for(app).active;
    match tokio::task::spawn_blocking(move || config_request(&base, operation, &scene)).await {
        Ok(Ok(body)) => {
            if saved {
                reload_active_ocr(app).await;
            }
            AreaResponse::Json(StatusCode::OK, body)
        }
        Ok(Err(response)) => response,
        Err(e) => failure(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_edits_legacy_pixels_and_keeps_the_saved_geometry_and_backup() {
        let profile = tempfile::tempdir().unwrap();
        let directory = profile.path().join("ocr_config");
        fs::create_dir(&directory).unwrap();
        let name = "日本語_overlay.json";
        let legacy = json!({"scene":"日本語","metadata":{"lang":"ja"},"coordinate_system":"pixels","monitor_index":2,
            "window_geometry":{"left":-800,"top":10,"width":800,"height":600},
            "rects":[{"x":80,"y":60,"w":400,"h":300,"is_excluded":true}]});
        let file = directory.join(name);
        fs::write(&file, legacy.to_string()).unwrap();
        fs::write(directory.join("bad.json"), b"[}").unwrap();
        fs::write(directory.join("settings.json"), b"{}").unwrap();
        let call = |op| config_request(profile.path(), op, "Test/Game: Scene");
        let list = call(AreaRequest::List).unwrap();
        assert_eq!(
            list["configs"],
            json!([{"name":name,"scene":"日本語","is_overlay":true}])
        );
        let loaded = call(AreaRequest::Load(Some(name.into()))).unwrap();
        assert_eq!(
            loaded["rectangles"][0]["coordinates"],
            json!([0.1, 0.1, 0.5, 0.5])
        );
        assert_eq!(loaded["rectangles"][0]["monitor"]["index"], 2);
        let edited=call(AreaRequest::Save(json!({"name":name,"rectangles":[{"coordinates":[0.5,-0.2,0.8,0.5],"is_excluded":true,"is_secondary":true}]}))).unwrap();
        assert_eq!(
            edited["config"]["image_size"],
            json!({"width":800,"height":600})
        );
        let saved = read_config(&file).unwrap();
        assert_eq!(saved["metadata"], legacy["metadata"]);
        assert_eq!(saved["window_geometry"], legacy["window_geometry"]);
        assert!(saved.get("rects").is_none() && saved.get("monitor_index").is_none());
        assert_eq!(
            saved["rectangles"][0]["coordinates"],
            json!([0.5, 0.0, 0.5, 0.5])
        );
        assert_eq!(saved["rectangles"][0]["is_secondary"], false);
        assert_eq!(saved["rectangles"][0]["is_excluded"], true);
        let backup = fs::read_dir(directory.join("backup/日本語_overlay"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(read_config(&backup).unwrap(), legacy);
        assert!(call(AreaRequest::Save(
            json!({"name":name,"rectangles":[{"coordinates":[1,0,0,1]}]})
        ))
        .is_err());
        assert_eq!(read_config(&file).unwrap(), saved);
        assert!(matches!(
            call(AreaRequest::Load(Some("../another".into()))),
            Err(AreaResponse::Json(StatusCode::BAD_REQUEST, _))
        ));
        let current = call(AreaRequest::Current).unwrap();
        assert_eq!(current["name"], "TestGameScene.json");
        assert_eq!(call(AreaRequest::Current).unwrap(), current);
        assert!(!directory.join("backup/TestGameScene").exists());
    }
}
