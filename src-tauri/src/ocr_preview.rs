use crate::{native_dialog, obs::Obs, settings::Settings};
use image::RgbaImage;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Manager};

pub(crate) type Windows = native_dialog::Sessions<Preview>;

pub(crate) struct Preview {
    image: Arc<RgbaImage>,
    source: String,
    sensitivity: i32,
    profile: PathBuf,
    language: String,
    lines: tokio::sync::OnceCell<Value>,
}

pub(crate) async fn open(
    app: &AppHandle,
    current: i32,
    path: Option<String>,
    for_overlay: bool,
) -> Result<Value, String> {
    let profile = app.state::<Settings>().paths.active.clone();
    let supplied = path.is_some();
    let (image, source) = if let Some(path) = path {
        let image = tokio::task::spawn_blocking(move || {
            image::open(path)
                .map(image::DynamicImage::into_rgba8)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        (image, String::new())
    } else {
        capture(app, &profile, for_overlay).await?
    };
    let (image, dir) = tokio::task::spawn_blocking(move || {
        let (w, h) = preview_size(image.width(), image.height());
        let image = if supplied || (w, h) == image.dimensions() {
            image
        } else {
            image::imageops::resize(&image, w, h, image::imageops::FilterType::Triangle)
        };
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        image
            .save(dir.path().join("preview.png"))
            .map_err(|e| e.to_string())?;
        Ok::<_, String>((image, dir))
    })
    .await
    .map_err(|e| e.to_string())??;
    let monitor = app.primary_monitor().map_err(|e| e.to_string())?;
    let cap = monitor
        .map(|m| {
            let area = m.work_area();
            let scale = m.scale_factor();
            (
                f64::from(area.size.width) / scale * 0.9,
                f64::from(area.size.height) / scale * 0.9,
            )
        })
        .unwrap_or((1280., 900.));
    let size = (
        (f64::from(image.width()) + 80.).min(cap.0).max(640.),
        (f64::from(image.height()) + 160.).min(cap.1).max(480.),
    );
    let config = crate::ocr_coordinator::read_ocr_config(app);
    let data = Preview {
        image: Arc::new(image),
        source,
        sensitivity: current.clamp(0, 100),
        profile,
        language: config["language"].as_str().unwrap_or("ja").to_owned(),
        lines: Default::default(),
    };
    Windows::open(
        app,
        "furigana-preview",
        "Furigana Filter Visualizer",
        size,
        data,
        Some(dir.path()),
        |b| Ok(b.min_inner_size(500., 320.)),
        |_, _, _| true,
    )
    .await
}

async fn capture(
    app: &AppHandle,
    profile: &std::path::Path,
    for_overlay: bool,
) -> Result<(RgbaImage, String), String> {
    let obs = app.state::<Obs>();
    let overlay = if for_overlay {
        gsm_settings::read_object(&profile.join("config.json"))?["overlay"].clone()
    } else {
        Value::Null
    };
    let obs_first = !for_overlay
        || cfg!(windows)
            && overlay["ocr_full_screen_instead_of_obs"] != true
            && obs.game_session()["target_client_rect"].is_object();
    let first_try = if obs_first {
        obs.area_screenshot(app).await
    } else {
        None
    };
    let screenshot = if first_try.is_some() || !for_overlay {
        first_try
    } else {
        let index = overlay["monitor_to_capture"].as_u64().unwrap_or(0);
        let monitor = tokio::task::spawn_blocking(move || {
            gsm_capture::capture(&json!({"settings":overlay}), true, &mut Default::default())
        })
        .await
        .map_err(|e| e.to_string())?;
        if let Ok((image, _, _)) = monitor {
            return Ok((image, format!("Overlay Monitor {}", index + 1)));
        }
        obs.area_screenshot(app).await
    }
    .ok_or("No active OCR screenshot source is available.")?;
    let source = obs.area_scene(app).await;
    let image = tokio::task::spawn_blocking(move || {
        image::load_from_memory(&screenshot)
            .map(image::DynamicImage::into_rgba8)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok((image, source))
}

pub(crate) fn preview_size(w: u32, h: u32) -> (u32, u32) {
    let (width, height) = (f64::from(w), f64::from(h));
    let (sx, sy) = (1280. / width, 720. / height);
    let floor_even = |value: f64| (value as u32) & !1;
    if sx.max(sy) >= 1. {
        (w, h)
    } else if sx.max(sy) <= 0.75 {
        (floor_even(width * 0.75), floor_even(height * 0.75))
    } else if sx >= sy {
        (
            1280,
            floor_even((1280. * height / width).round_ties_even()).max(720),
        )
    } else {
        (
            floor_even((720. * width / height).round_ties_even()).max(1280),
            720,
        )
    }
}

pub(crate) async fn invoke(
    app: &AppHandle,
    label: &str,
    command: &str,
    value: &Value,
) -> Result<Value, String> {
    let session = Windows::get(app, label)?;
    let data = &session.data;
    match command {
        "ocrPreview.read" => Ok(
            json!({"image":native_dialog::asset_url(label,"preview.png"),
            "width":data.image.width(),"height":data.image.height(),"source":data.source,"sensitivity":data.sensitivity}),
        ),
        "ocrPreview.detect" => data
            .lines
            .get_or_try_init(|| async {
                let (image, profile, language, policy) = (
                    data.image.clone(),
                    data.profile.clone(),
                    data.language.clone(),
                    crate::ocr_coordinator::try_read_ocr_thread_policy(app),
                );
                tokio::task::spawn_blocking(move || {
                    policy.apply_to_current_thread();
                    let mut engines =
                        gsm_overlay::engines::Engines::with_thread_policy(&profile, policy);
                    let boxes = ["lens", "oneocr", "meikiocr"].map(|name| {
                        engines
                            .recognize(&image, name, &language)
                            .map(|result| {
                                result
                                    .lines
                                    .into_iter()
                                    .map(|line| line.bounds)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default()
                    });
                    json!(boxes)
                })
                .await
                .map_err(|e| e.to_string())
            })
            .await
            .cloned(),
        "ocrPreview.title" => native_dialog::title(app, label, value),
        "ocrPreview.resolve" => {
            if !value.is_null()
                && (data.lines.get().is_none() || !value.as_u64().is_some_and(|n| n <= 100))
            {
                return Err("Invalid furigana preview selection".into());
            }
            session.resolve(value.clone());
            Ok(Value::Null)
        }
        _ => Err("Unknown furigana preview action".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn preserves_the_qt_sensitivity_pixel_scale() {
        use super::preview_size;
        assert_eq!(preview_size(1920, 1080), (1440, 810));
        assert_eq!(preview_size(1600, 900), (1280, 720));
        assert_eq!(preview_size(1600, 1200), (1280, 960));
        assert_eq!(preview_size(1200, 800), (1200, 800));
        assert_eq!(preview_size(2560, 1080), (1920, 810));
    }
}
