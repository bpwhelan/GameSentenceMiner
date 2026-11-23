use super::{
    scenes::{helper_source, video},
    text, Obs,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

impl Obs {
    pub(crate) async fn area_scene(&self, app: &tauri::AppHandle) -> String {
        let scene = self.current_scene_name();
        if !scene.is_empty() {
            return scene;
        }
        // A browser can open immediately after startup, before the first session sample.
        self.current_scene(app)
            .await
            .ok()
            .and_then(|v| v["name"].as_str().map(str::to_owned))
            .unwrap_or_default()
    }
    #[cfg(windows)]
    fn area_window_frame(&self, session: &Value, validate: bool) -> Option<Vec<u8>> {
        let id = session["target_id"].as_u64()?;
        let pid = u32::try_from(session["target_pid"].as_u64()?).ok()?;
        self.checked_hwnd(id, pid)?;
        let config = self.paths().ok()?.profile().ok()?;
        let backend = config["advanced"]["screenshot_capture_backend_v2"]
            .as_str()
            .unwrap_or("auto")
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_");
        if matches!(backend.as_str(), "obs" | "obs_websocket" | "websocket") {
            return None;
        }
        let image = gsm_capture::capture_window(session, &mut Default::default()).ok()?;
        self.checked_hwnd(id, pid)?;
        let rgb = image::DynamicImage::ImageRgba8(image).into_rgb8();
        if validate && !frame_has_content(&rgb) {
            return None;
        }
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
            .encode_image(&rgb)
            .ok()?;
        Some(bytes)
    }
    pub(crate) async fn clipboard_screenshot(&self, app: &tauri::AppHandle) -> Result<Vec<u8>,String> {
        let scene = self.current_scene(app).await?;
        let name = scene["name"].as_str().filter(|s| !s.is_empty()).ok_or("No active OBS scene")?;
        let result = self.call(app,"GetSourceScreenshot",json!({"sourceName":name,"imageFormat":"png"})).await?;
        let encoded = result["imageData"].as_str().and_then(|s| s.split_once(',')).ok_or("OBS returned no screenshot")?.1;
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD,encoded).map_err(|e|e.to_string())
    }
    pub(crate) async fn area_screenshot(&self, app: &tauri::AppHandle) -> Option<Vec<u8>> {
        let scene = self.current_scene(app).await.ok()?;
        let scene_name = scene["name"].as_str()?;
        self.area_screenshot_for(app, scene_name).await
    }
    pub(crate) async fn area_screenshot_for(
        &self,
        app: &tauri::AppHandle,
        scene_name: &str,
    ) -> Option<Vec<u8>> {
        let items = self
            .items_by_selector(app, json!({"sceneName":scene_name}))
            .await
            .ok()?;
        let mut candidates: Vec<_> = items
            .iter()
            .filter(|item| video(text(item, "inputKind")) && item["sceneItemEnabled"] != false)
            .collect();
        if candidates.is_empty() {
            candidates.push(items.first()?);
        }
        let session = self.game_session();
        let preferred = if session["scene"] == scene_name {
            text(&session, "source_name")
        } else {
            ""
        };
        candidates.sort_by_key(|item| {
            let source = text(item, "sourceName");
            let rank = match text(item, "inputKind") {
                "game_capture" => 0,
                "window_capture" | "xcomposite_input" => 1,
                "monitor_capture" => 2,
                _ => 3,
            };
            (
                !helper_source(scene_name, source),
                source != preferred,
                rank,
            )
        });
        let multiple = candidates.len() > 1;
        for item in candidates {
            let Some(name) = item["sourceName"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let validate = multiple && !helper_source(scene_name, name);
            #[cfg(windows)]
            if name == preferred && session["target_id"].is_u64() {
                let obs = self.clone();
                let state = session.clone();
                if let Ok(Some(frame)) =
                    tokio::task::spawn_blocking(move || obs.area_window_frame(&state, validate))
                        .await
                {
                    return Some(frame);
                }
            }
            let Ok(mut response) = self
                .call(
                    app,
                    "GetSourceScreenshot",
                    json!({"sourceName":name,"imageFormat":"jpg","imageCompressionQuality":90}),
                )
                .await
            else {
                continue;
            };
            let Value::String(data) = response["imageData"].take() else {
                continue;
            };
            let frame = tokio::task::spawn_blocking(move || {
                let bytes = STANDARD.decode(data.split_once(',')?.1).ok()?;
                if !bytes.starts_with(&[0xff, 0xd8]) {
                    return None;
                }
                if validate {
                    let frame =
                        image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
                            .ok()?
                            .into_rgb8();
                    if !frame_has_content(&frame) {
                        return None;
                    }
                }
                Some(bytes)
            })
            .await
            .ok()
            .flatten();
            if frame.is_some() {
                return frame;
            }
        }
        None
    }
}

fn frame_has_content(frame: &image::RgbImage) -> bool {
    let step = (frame.width().min(frame.height()) / 4).clamp(1, 64) as usize;
    super::session::nonblank_pixels(frame, step)
}
