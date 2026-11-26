use super::{Ocr, OcrCoordinator};
use crate::obs::Obs;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{io::Cursor, time::SystemTime};
use tauri::Manager;

const JPEG_PREFIX: &str = "data:image/jpeg;base64,";

struct Thumbnail {
    data: String,
    width: u32,
    height: u32,
    source_size: Option<(u32, u32)>,
}

impl Thumbnail {
    fn from_window(context: &Value) -> Option<Self> {
        let image = gsm_capture::capture_window(context, &mut Default::default()).ok()?;
        let source_size = Some(image.dimensions());
        let image = image::DynamicImage::ImageRgba8(image);
        let image = if image.width() > 960 || image.height() > 720 {
            image.thumbnail(960, 720)
        } else {
            image
        }
        .into_rgb8();
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 70)
            .encode_image(&image)
            .ok()?;
        Some(Self {
            data: format!("{JPEG_PREFIX}{}", STANDARD.encode(bytes)),
            width: image.width(),
            height: image.height(),
            source_size,
        })
    }

    fn from_obs(data: String) -> Option<Self> {
        // Read the dimensions from the compressed JPEG. Pass OBS's bytes straight through.
        if data.len() > 3_000_000 {
            return None;
        }
        let bytes = STANDARD.decode(data.strip_prefix(JPEG_PREFIX)?).ok()?;
        let (width, height) =
            image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg)
                .into_dimensions()
                .ok()?;
        Some(Self {
            data,
            width,
            height,
            source_size: None,
        })
    }

    fn frame(self, context: &Value, geometry: Value) -> Value {
        let boxes = matching_boxes(context, self.width, self.height, geometry);
        let mut frame = json!({
            "sceneId":context["scene_id"], "sceneName":context["scene"], "sourceName":context["source_name"],
            "sourceSize":self.source_size,"width":self.width, "height":self.height, "boxes":boxes,
            "capturedAt":SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis()
        });
        frame["imageData"] = Value::String(self.data);
        frame
    }
}

fn matching_boxes(context: &Value, width: u32, height: u32, mut geometry: Value) -> Vec<Value> {
    let w = geometry["sourceWidth"].as_f64().unwrap_or_default();
    let h = geometry["sourceHeight"].as_f64().unwrap_or_default();
    if geometry["sceneName"] != context["scene"]
        || geometry["sourceName"] != context["source_name"]
        || w <= 0.
        || h <= 0.
        || (w / h - f64::from(width) / f64::from(height)).abs() > 0.03
    {
        return Vec::new();
    }
    let Value::Array(boxes) = geometry["boxes"].take() else {
        return Vec::new();
    };
    boxes
        .into_iter()
        .take(200)
        .filter(|b| {
            let Some(points) = b["points"].as_array() else {
                return false;
            };
            points.len() == 4
                && points.iter().all(|point| {
                    let Some(xy) = point.as_array() else {
                        return false;
                    };
                    xy.len() == 2
                        && xy
                            .iter()
                            .all(|v| v.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)))
                })
        })
        .collect()
}

async fn geometry(app: &tauri::AppHandle, scene: &Value) -> Value {
    let coord = app.state::<OcrCoordinator>();
    let python_pid = coord
        .0
        .lock()
        .unwrap()
        .python_proc
        .as_ref()
        .map(|p| p.child.id());
    if let Some(pid) = python_pid {
        if let Ok(rt) = crate::runtime::get(app) {
            return rt
                .call(
                    "bus.request",
                    json!({
                        "dst":format!("obs-reader-{pid}"), "topic":"ocr.preview",
                        "data":{"enabled":true,"sceneName":scene}, "timeoutMs":1000
                    }),
                )
                .await
                .unwrap_or_default();
        }
    }
    app.state::<Ocr>()
        .command(json!({"action":"preview"}))
        .unwrap_or_default()
}

pub(super) async fn get(app: &tauri::AppHandle, request: &Value) -> Option<Value> {
    // A scene switch or second desktop window cannot queue work behind a slow capture.
    static CAPTURE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = CAPTURE.try_lock().ok()?;
    let obs = app.state::<Obs>();
    let context = obs.game_session();
    let scene = request["sceneName"].as_str().filter(|s| !s.is_empty())?;
    let id = request["sceneId"].as_str().filter(|s| !s.is_empty())?;
    if context["scene"] != scene || context["scene_id"] != id {
        return None;
    }
    let window = context["capture_kind"] == "window"
        && context["target_id"].is_u64()
        && context["available"] == true;
    let thumbnail = if window {
        let context = context.clone();
        tokio::task::spawn_blocking(move || Thumbnail::from_window(&context))
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let thumbnail = match thumbnail {
        Some(frame) => frame,
        None => {
            let source = if context["capture_kind"] == "obs" {
                // OBS-backed OCR sees the composed scene, including its transforms.
                context["capture_source"].as_str()
            } else {
                context["source_name"].as_str()
            }?;
            if source.is_empty() {
                return None;
            }
            Thumbnail::from_obs(obs.preview_jpeg(app, source).await?)?
        }
    };
    let geometry = if request["includeBoxes"] == true {
        geometry(app, &context["scene"]).await
    } else {
        Value::Null
    };
    let current = obs.game_session();
    if [
        "scene_epoch",
        "scene_id",
        "scene",
        "source_name",
        "target_id",
        "target_pid",
        "capture_kind",
        "capture_source",
    ]
    .iter()
    .any(|key| current[*key] != context[*key])
    {
        return None;
    }
    Some(thumbnail.frame(&context, geometry))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obs_jpeg_is_forwarded_with_its_actual_dimensions_and_matching_boxes() {
        let image = image::RgbImage::new(32, 48);
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&image)
            .unwrap();
        let data = format!("{JPEG_PREFIX}{}", STANDARD.encode(jpeg));
        let context = json!({"scene_id":"id","scene":"Game","source_name":"Capture"});
        let good = json!({"text":"line","points":[[0,0],[1,0],[1,1],[0,1]]});
        let mut geometry = json!({"sceneName":"Game","sourceName":"Capture","sourceWidth":320,
            "sourceHeight":480,"boxes":[good,{"points":[0,0,1,1]}]});
        let frame = Thumbnail::from_obs(data.clone())
            .unwrap()
            .frame(&context, geometry.clone());
        assert_eq!(frame["imageData"], data);
        assert_eq!(
            (frame["width"].as_u64(), frame["height"].as_u64()),
            (Some(32), Some(48))
        );
        assert_eq!(frame["boxes"], json!([good]));
        geometry["sourceName"] = json!("Other");
        assert!(matching_boxes(&context, 32, 48, geometry.clone()).is_empty());
        geometry["sourceName"] = json!("Capture");
        assert!(matching_boxes(&context, 48, 32, geometry).is_empty());
        assert!(Thumbnail::from_obs(format!("{JPEG_PREFIX}YQ==")).is_none());
    }
}
