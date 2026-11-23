use super::{
    area_selector, backup_ocr_config, reload_active_ocr, sanitize_ocr_filename, OCR_FILE_LOCK,
};
use crate::{native_dialog, obs::Obs, settings::Settings};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

pub(crate) type Windows = native_dialog::Sessions<Selector>;
static OPEN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const TOOLBAR_HEIGHT: f64 = 34.;

#[derive(Default)]
pub(crate) struct Options {
    pub window_name: String,
    pub use_window_as_config: bool,
    pub obs: bool,
    pub overlay: bool,
    pub monitor: Option<usize>,
    pub live: bool,
    pub single: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Geometry {
    left: i32,
    top: i32,
    width: u32,
    height: u32,
}

impl Geometry {
    fn at(left: i32, top: i32, (width, height): (u32, u32)) -> Self {
        Self {
            left,
            top,
            width,
            height,
        }
    }

    fn pixel(self, [x, y, w, h]: [f64; 4]) -> [f64; 4] {
        [
            f64::from(self.left) + x * f64::from(self.width),
            f64::from(self.top) + y * f64::from(self.height),
            w * f64::from(self.width),
            h * f64::from(self.height),
        ]
    }

    fn fraction(self, [x, y, w, h]: [f64; 4]) -> [f64; 4] {
        [
            (x - f64::from(self.left)) / f64::from(self.width),
            (y - f64::from(self.top)) / f64::from(self.height),
            w / f64::from(self.width),
            h / f64::from(self.height),
        ]
    }

    fn covers(self, x: f64, y: f64) -> bool {
        let [x, y, _, _] = self.fraction([x, y, 0., 0.]);
        (0. ..1.).contains(&x) && (0. ..1.).contains(&y)
    }
}

#[derive(Clone, Copy, Serialize)]
struct Display {
    index: usize,
    #[serde(flatten)]
    bounds: Geometry,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rect {
    xywh: [f64; 4],
    #[serde(default)]
    excluded: bool,
    #[serde(default)]
    secondary: bool,
    #[serde(default)]
    exclusive: bool,
    #[serde(default)]
    black_hole: bool,
    #[serde(default)]
    monitor: Option<usize>,
}

impl Rect {
    fn from_file(row: &Value, xywh: [f64; 4], monitor: Option<usize>, overlay: bool) -> Self {
        let flag = |key| row[key] == true;
        Self {
            xywh,
            monitor,
            excluded: flag("is_excluded"),
            secondary: !overlay && flag("is_secondary"),
            exclusive: !overlay && flag("is_exclusive"),
            black_hole: !overlay && flag("is_black_hole"),
        }
    }

    fn flags(&self) -> Value {
        json!({"is_excluded":self.excluded,"is_secondary":self.secondary,
            "is_exclusive":self.exclusive,"is_black_hole":self.black_hole})
    }
}

struct Space {
    // Physical capture bounds and target bounds are independent. Drawing and
    // hit-testing stay in screenshot fractions even if the window crosses DPI boundaries.
    capture: Geometry,
    target: Geometry,
    displays: Vec<Display>,
    monitor: Option<usize>,
    base_size: (u32, u32),
}

impl Space {
    fn target_rect(&self, rect: &Rect) -> [f64; 4] {
        self.target.fraction(self.capture.pixel(rect.xywh))
    }

    fn display(&self, rect: &Rect) -> Display {
        let [x, y, w, h] = self.capture.pixel(rect.xywh);
        rect.monitor
            .and_then(|i| self.displays.iter().find(|d| d.index == i))
            .or_else(|| {
                self.displays
                    .iter()
                    .find(|d| d.bounds.covers(x + w / 2., y + h / 2.))
            })
            .copied()
            .unwrap_or(self.displays[0])
    }

    fn load(&self, config: &Value, overlay: bool, monitor_only: bool) -> Vec<Rect> {
        let percentages = config["coordinate_system"] == "percentage";
        if let Some(rows) = config["rectangles"].as_array() {
            let target = if monitor_only {
                serde_json::from_value::<Geometry>(config["window_geometry"].clone())
                    .ok()
                    .filter(|g| g.width > 0 && g.height > 0)
                    .unwrap_or(self.target)
            } else {
                self.target
            };
            return rows
                .iter()
                .filter_map(|row| {
                    let mut xywh = area_selector::coordinates(&row["coordinates"]).ok()?;
                    if !percentages
                        && !config["coordinate_system"].is_null()
                        && config["coordinate_system"] != ""
                    {
                        xywh = [
                            xywh[0] / f64::from(target.width),
                            xywh[1] / f64::from(target.height),
                            xywh[2] / f64::from(target.width),
                            xywh[3] / f64::from(target.height),
                        ];
                    }
                    let xywh = self.capture.fraction(target.pixel(xywh));
                    let index = self.monitor.or_else(|| {
                        row["monitor"]["index"]
                            .as_u64()
                            .and_then(|i| i.try_into().ok())
                    });
                    Some(Rect::from_file(row, xywh, index, overlay || monitor_only))
                })
                .collect();
        }
        let index = config["monitor_index"]
            .as_u64()
            .and_then(|i| i.try_into().ok())
            .unwrap_or(0);
        let reference = self
            .displays
            .iter()
            .find(|d| d.index == index)
            .map(|d| d.bounds)
            .unwrap_or(self.capture);
        config["rects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let xywh =
                    area_selector::coordinates(&json!([row["x"], row["y"], row["w"], row["h"]]))
                        .ok()?;
                let absolute = if percentages {
                    reference.pixel(xywh)
                } else {
                    [
                        xywh[0] + f64::from(reference.left),
                        xywh[1] + f64::from(reference.top),
                        xywh[2],
                        xywh[3],
                    ]
                };
                Some(Rect::from_file(
                    row,
                    self.capture.fraction(absolute),
                    self.monitor.or(Some(index)),
                    overlay || monitor_only,
                ))
            })
            .collect()
    }

    fn output(&self, rects: &[Rect]) -> Value {
        json!(rects
            .iter()
            .map(|rect| {
                let mut row = rect.flags();
                let [x, y, w, h] = if self.monitor.is_some() {
                    let [x, y, w, h] = self.capture.pixel(rect.xywh);
                    [
                        x - f64::from(self.capture.left),
                        y - f64::from(self.capture.top),
                        w,
                        h,
                    ]
                    .map(f64::trunc)
                } else {
                    self.target_rect(rect)
                };
                row["x"] = json!(x);
                row["y"] = json!(y);
                row["width"] = json!(w);
                row["height"] = json!(h);
                row
            })
            .collect::<Vec<_>>())
    }
}

struct Opening {
    space: Space,
    rects: Vec<Rect>,
    scene: String,
    path: PathBuf,
}

pub(crate) struct Selector {
    options: Options,
    dir: Arc<tempfile::TempDir>,
    opening: tokio::sync::OnceCell<Opening>,
    file_lane: tokio::sync::Mutex<()>,
    refresh_lane: tokio::sync::Mutex<()>,
    ready: AtomicBool,
    revision: AtomicU64,
}

pub(crate) async fn open(app: &AppHandle, options: Options) -> Result<Value, String> {
    let _open = OPEN
        .try_lock()
        .map_err(|_| "An OCR area selector is already open.")?;
    let title = if options.single {
        "OCR — Add new area"
    } else {
        "OCR Area Selector"
    };
    let fixed = options.overlay || options.monitor.is_some();
    let dir = Arc::new(tempfile::tempdir().map_err(|e| e.to_string())?);
    let selector = Selector {
        options,
        dir: dir.clone(),
        opening: Default::default(),
        file_lane: Default::default(),
        refresh_lane: Default::default(),
        ready: AtomicBool::new(false),
        revision: AtomicU64::new(0),
    };
    Windows::open(
        app,
        "ocr-area-selector",
        title,
        (740., 430.),
        selector,
        Some(dir.path()),
        |builder| {
            Ok(builder
                .min_inner_size(320., 160.)
                .always_on_top(fixed)
                .decorations(!fixed)
                .visible(false))
        },
        |app, label, data| {
            if !data.ready.load(Ordering::Acquire) {
                return true;
            }
            crate::desktop_state::emit_to_window(app, label, "ocrArea.requestClose", &[]);
            false
        },
    )
    .await
}

pub(crate) async fn invoke(
    app: &AppHandle,
    label: &str,
    command: &str,
    value: &Value,
) -> Result<Value, String> {
    let session = Windows::get(app, label)?;
    let selector = &session.data;
    let options = &selector.options;
    let root = app.state::<Settings>().paths.active.join("ocr_config");
    let image_url = |revision| {
        format!(
            "{}?revision={revision}",
            native_dialog::asset_url(label, &frame_name(revision))
        )
    };
    if command == "ocrArea.title" {
        return native_dialog::title(app, label, value);
    }
    if command == "ocrArea.options" {
        return Ok(
            json!({"obs":options.obs,"single":options.single,"overlay":options.overlay,
            "monitorOnly":options.monitor.is_some(),"live":options.live && !options.single,
            "help":read_help(&root)}),
        );
    }
    if command == "ocrArea.capture" {
        let captured = selector
            .opening
            .get_or_try_init(|| initialize(app, label, selector, &root))
            .await;
        if std::env::var_os("GSM_SMOKE_TEST").is_none() {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        let initial = captured?;
        selector.ready.store(true, Ordering::Release);
        let (width, height) = initial.space.base_size;
        return Ok(
            json!({"image":image_url(0),"rects":initial.rects,"width":width,"height":height,"monitor":initial.space.monitor}),
        );
    }
    if command == "ocrArea.help" {
        let _lock = OCR_FILE_LOCK.lock().map_err(|e| e.to_string())?;
        let path = root.join("selector_ui_state.json");
        let mut state = gsm_settings::read_object(&path).unwrap_or_else(|_| json!({}));
        state["instructions_visible"] = json!(value == true);
        gsm_settings::write_atomic(&path, &state)?;
        return Ok(Value::Null);
    }
    if command == "ocrArea.cancel" {
        session.resolve(Value::Null);
        return Ok(Value::Null);
    }
    let initial = selector
        .opening
        .get()
        .ok_or("No screenshot has been captured")?;
    if command == "ocrArea.refresh" && options.obs {
        let _lane = selector
            .refresh_lane
            .try_lock()
            .map_err(|_| "OBS refresh is already running")?;
        let bytes = app
            .state::<Obs>()
            .area_screenshot_for(app, &initial.scene)
            .await
            .ok_or("Could not refresh the OBS screenshot.")?;
        let revision = selector.revision.fetch_add(1, Ordering::Relaxed) + 1;
        tokio::fs::write(selector.dir.path().join(frame_name(revision)), bytes)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(json!(image_url(revision)));
    }
    if matches!(
        command,
        "ocrArea.save" | "ocrArea.finish" | "ocrArea.dismiss"
    ) {
        let _lane = selector.file_lane.lock().await;
        let rects = submitted(&value["rects"], options)?;
        if command != "ocrArea.dismiss" {
            save(initial, options, &rects)?;
            reload_active_ocr(app).await;
        }
        if command != "ocrArea.save" {
            let output = if options.single && command == "ocrArea.dismiss" {
                Value::Null
            } else {
                initial.space.output(&rects)
            };
            session.resolve(output);
        }
        return Ok(Value::Null);
    }
    Err("Unknown OCR area selector action".into())
}

fn frame_name(revision: u64) -> String {
    format!("frame-{}.jpg", revision % 3)
}

fn read_help(root: &Path) -> bool {
    gsm_settings::read_object(&root.join("selector_ui_state.json"))
        .ok()
        .and_then(|state| state["instructions_visible"].as_bool())
        .unwrap_or(true)
}

fn display_bounds(monitor: &xcap::Monitor) -> Result<Geometry, String> {
    let err = |e: xcap::XCapError| e.to_string();
    Ok(Geometry::at(
        monitor.x().map_err(err)?,
        monitor.y().map_err(err)?,
        (
            monitor.width().map_err(err)?,
            monitor.height().map_err(err)?,
        ),
    ))
}

fn desktop_frame(options: &Options) -> Result<(image::RgbaImage, Space), String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let displays = monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            Ok(Display {
                index,
                bounds: display_bounds(monitor)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let first = displays
        .first()
        .ok_or("No desktop displays are available")?;
    let (image, capture, target, monitor) = if let Some(index) = options.monitor {
        let display = displays.get(index).unwrap_or(first);
        let image = gsm_capture::monitor_image(&monitors[display.index], &mut Default::default())?;
        (image, display.bounds, display.bounds, Some(display.index))
    } else {
        let windows = xcap::Window::all().map_err(|e| e.to_string())?;
        let title_matches = |w: &xcap::Window, exact| {
            w.title().is_ok_and(|title| {
                !options.window_name.is_empty()
                    && if exact {
                        title == options.window_name
                    } else {
                        title.contains(&options.window_name)
                    }
            })
        };
        let window = windows
            .iter()
            .find(|w| title_matches(w, true))
            .or_else(|| windows.iter().find(|w| title_matches(w, false)))
            .ok_or_else(|| format!("Could not find window '{}'.", options.window_name))?;
        let err = |e: xcap::XCapError| e.to_string();
        let target = Geometry::at(
            window.x().map_err(err)?,
            window.y().map_err(err)?,
            (
                window.width().map_err(err)?.max(1),
                window.height().map_err(err)?.max(1),
            ),
        );
        let shot = gsm_capture::desktop_snapshot()?;
        let capture = Geometry::at(shot.left, shot.top, shot.image.dimensions());
        (shot.image, capture, target, None)
    };
    let base_size = crate::ocr_preview::preview_size(image.width(), image.height());
    Ok((
        image,
        Space {
            capture,
            target,
            displays,
            monitor,
            base_size,
        },
    ))
}

async fn initialize(
    app: &AppHandle,
    label: &str,
    selector: &Selector,
    root: &Path,
) -> Result<Opening, String> {
    let options = &selector.options;
    if let Some(window) = app.get_webview_window(label) {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e| e.to_string())?;
            // Keep the selector out of the captured desktop on a retry.
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }
    let obs = app.state::<Obs>();
    let scene = if options.obs {
        obs.current_scene(app).await?["name"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    } else {
        obs.area_scene(app).await
    };
    let (space, bytes) = if options.obs {
        let mut frame = None;
        for attempt in 0..3 {
            Windows::get(app, label)?;
            frame = obs.area_screenshot_for(app, &scene).await;
            if frame.is_some() {
                break;
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        let bytes = frame
            .ok_or("Failed to get an OBS screenshot. Is the game running and visible in OBS?")?;
        let reader =
            image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Jpeg);
        let size = reader.into_dimensions().map_err(|e| e.to_string())?;
        let bounds = Geometry::at(0, 0, size);
        let game = obs.game_session();
        let target = if options.overlay && game["scene"] == scene {
            serde_json::from_value::<Geometry>(game["target_client_rect"].clone())
                .ok()
                .filter(|g| g.width > 0 && g.height > 0)
                .unwrap_or(bounds)
        } else {
            bounds
        };
        let space = Space {
            capture: target,
            target,
            displays: vec![Display { index: 0, bounds }],
            monitor: None,
            base_size: crate::ocr_preview::preview_size(size.0, size.1),
        };
        (space, bytes)
    } else {
        let session = Windows::get(app, label)?;
        tokio::task::spawn_blocking(move || {
            let (image, space) = desktop_frame(&session.data.options)?;
            let (w, h) = space.base_size;
            let image = image::DynamicImage::ImageRgba8(image);
            let image = if (w, h) == (image.width(), image.height()) {
                image
            } else {
                image.resize_exact(w, h, image::imageops::FilterType::Triangle)
            };
            let mut bytes = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
                .encode_image(&image.into_rgb8())
                .map_err(|e| e.to_string())?;
            Ok::<_, String>((space, bytes))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    tokio::fs::write(selector.dir.path().join(frame_name(0)), bytes)
        .await
        .map_err(|e| e.to_string())?;
    let name = sanitize_ocr_filename(
        if options.use_window_as_config && !options.overlay && options.monitor.is_none() {
            &options.window_name
        } else {
            &scene
        },
    );
    let suffix = if options.overlay || options.monitor.is_some() {
        "_overlay.json"
    } else {
        ".json"
    };
    let name = format!("{name}{suffix}");
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = area_selector::config_path(&root, Some(&name)).map_err(area_selector::message)?;
    let config = if path.exists() {
        area_selector::read_config(&path).map_err(area_selector::message)?
    } else {
        json!({})
    };
    let rects = if options.monitor.is_some() && !options.overlay {
        Vec::new()
    } else {
        space.load(&config, options.overlay, options.monitor.is_some())
    };
    fit_window(app, label, options, &space)?;
    Ok(Opening {
        space,
        rects,
        scene,
        path,
    })
}

fn fit_window(
    app: &AppHandle,
    label: &str,
    options: &Options,
    space: &Space,
) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or("OCR area selector closed")?;
    let monitor = if !options.obs || options.overlay {
        let [x, y, _, _] = space.target.pixel([0.5, 0.5, 0., 0.]);
        window.monitor_from_point(x, y).ok().flatten()
    } else {
        None
    };
    let monitor = monitor.or_else(|| window.primary_monitor().ok().flatten());
    let (width, height) = (f64::from(space.base_size.0), f64::from(space.base_size.1));
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let cap_w = f64::from(work.size.width) / scale * 0.98;
        let cap_h = f64::from(work.size.height) / scale * 0.98;
        let fit = (cap_w / width)
            .min((cap_h - TOOLBAR_HEIGHT) / height)
            .min(1.);
        let (w, h) = (width * fit, height * fit + TOOLBAR_HEIGHT);
        let x = work.position.x + ((f64::from(work.size.width) - w * scale) / 2.) as i32;
        let y = work.position.y + ((f64::from(work.size.height) - h * scale) / 2.) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = window.set_size(LogicalSize::new(w, h));
    } else {
        let _ = window.set_size(LogicalSize::new(width, height + TOOLBAR_HEIGHT));
    }
    if options.overlay || options.monitor.is_some() {
        let _ = window.set_resizable(false);
    } else {
        let aspect = width / height;
        let _ = window.set_min_size(Some(LogicalSize::new(
            320.,
            TOOLBAR_HEIGHT + (320. / aspect).round(),
        )));
        let handle = window.clone();
        window.on_window_event(move |event| {
            let WindowEvent::Resized(size) = event else {
                return;
            };
            if size.width == 0
                || size.height == 0
                || handle.is_maximized().unwrap_or(false)
                || handle.is_fullscreen().unwrap_or(false)
            {
                return;
            }
            let scale = handle.scale_factor().unwrap_or(1.);
            if let Ok(Some(monitor)) = handle.current_monitor() {
                let available = monitor.work_area().size;
                let tolerance = (32. * scale) as u32;
                if size.width >= available.width.saturating_sub(tolerance)
                    && size.height >= available.height.saturating_sub(tolerance)
                {
                    return;
                }
            }
            let h = (TOOLBAR_HEIGHT * scale + f64::from(size.width) / aspect).round() as u32;
            if h.abs_diff(size.height) > 1 {
                let _ = handle.set_size(PhysicalSize::new(size.width, h));
            }
        });
    }
    Ok(())
}

fn submitted(value: &Value, options: &Options) -> Result<Vec<Rect>, String> {
    let mut rects: Vec<Rect> = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    if options.single && rects.len() != 1 && !rects.is_empty() {
        return Err("Only one OCR area can be added at a time.".into());
    }
    for rect in &mut rects {
        let [_, _, w, h] = rect.xywh;
        if w <= 0. || h <= 0. {
            return Err("Invalid OCR area dimensions".into());
        }
        if options.overlay || options.monitor.is_some() {
            rect.secondary = false;
            rect.exclusive = false;
            rect.black_hole = false;
        }
        if options.monitor.is_some() && !options.overlay {
            rect.excluded = false;
        }
    }
    Ok(rects)
}

fn save(initial: &Opening, options: &Options, rects: &[Rect]) -> Result<(), String> {
    if options.single && rects.len() != 1 {
        return Err("Draw one OCR area to save.".into());
    }
    let _lock = OCR_FILE_LOCK.lock().map_err(|e| e.to_string())?;
    let path = &initial.path;
    let mut config = if path.exists() {
        area_selector::read_config(path).map_err(area_selector::message)?
    } else {
        json!({})
    };
    let old = config.clone();
    let space = &initial.space;
    if options.single
        && old.as_object().is_some_and(|obj| !obj.is_empty())
        && (old["coordinate_system"] != "percentage" || !old["rectangles"].is_array())
    {
        return Err("Existing OCR areas must use percentage coordinates.".into());
    }
    if let Some(monitor) = space.monitor {
        config.as_object_mut().unwrap().remove("rectangles");
        config.as_object_mut().unwrap().remove("window_geometry");
        config["monitor_index"] = json!(monitor);
        config["rects"] = json!(rects
            .iter()
            .map(|row| {
                let [x, y, w, h] = row.xywh;
                json!({"x":x,"y":y,"w":w,"h":h,"is_excluded":row.excluded})
            })
            .collect::<Vec<_>>());
    } else {
        let mut rows = if options.single {
            old["rectangles"].as_array().cloned().unwrap_or_default()
        } else {
            Vec::with_capacity(rects.len())
        };
        rows.extend(rects.iter().map(|rect| {
            let mut row = rect.flags();
            row["coordinates"] = json!(space.target_rect(rect));
            row["monitor"] = json!(space.display(rect));
            row
        }));
        config.as_object_mut().unwrap().remove("rects");
        config.as_object_mut().unwrap().remove("monitor_index");
        if !options.single || config["window_geometry"].is_null() {
            config["window_geometry"] = json!(space.target);
        }
        if !options.single || config["scene"].is_null() {
            config["scene"] = json!(initial.scene);
        }
        config["rectangles"] = json!(rows);
    }
    config["coordinate_system"] = "percentage".into();
    if config != old {
        backup_ocr_config(path)?;
        gsm_settings::write_atomic(path, &config)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_projection_keeps_negative_origins_and_center_monitor() {
        let capture = Geometry::at(-1920, 0, (4480, 1440));
        let target = Geometry::at(320, 120, (1600, 900));
        let space = Space {
            capture,
            target,
            base_size: (2240, 720),
            monitor: None,
            displays: vec![
                Display {
                    index: 0,
                    bounds: Geometry::at(0, 0, (2560, 1440)),
                },
                Display {
                    index: 1,
                    bounds: Geometry::at(-1920, 0, (1920, 1080)),
                },
            ],
        };
        let xywh = capture.fraction(target.pixel([-1.0, 0.25, 0.25, 0.5]));
        let rect = Rect::from_file(&Value::Null, xywh, None, false);
        assert_eq!(space.display(&rect).index, 1);
        for (actual, expect) in space
            .target_rect(&rect)
            .into_iter()
            .zip([-1.0, 0.25, 0.25, 0.5])
        {
            assert!((actual - expect).abs() < 1e-12);
        }
    }

    #[test]
    fn append_keeps_concurrent_rectangles_and_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("Game.json");
        let bounds = Geometry::at(0, 0, (1920, 1080));
        let initial = Opening {
            scene: "Game".into(),
            path: path.clone(),
            rects: vec![],
            space: Space {
                capture: bounds,
                target: bounds,
                base_size: (1440, 810),
                monitor: None,
                displays: vec![Display { index: 0, bounds }],
            },
        };
        let current = json!({"scene":"Game","coordinate_system":"percentage","extra":true,
            "rectangles":[{"coordinates":[0.1,0.2,0.3,0.4],"is_secondary":true}]});
        gsm_settings::write_atomic(&path, &current).unwrap();
        let options = Options {
            single: true,
            ..Default::default()
        };
        let new_rect = Rect::from_file(
            &json!({"is_black_hole":true}),
            [0.25, 0.5, 0.5, 0.25],
            None,
            false,
        );
        save(&initial, &options, &[new_rect]).unwrap();
        let edited = gsm_settings::read_object(&path).unwrap();
        assert_eq!(edited["extra"], true);
        assert_eq!(edited["rectangles"][0], current["rectangles"][0]);
        assert_eq!(
            edited["rectangles"][1]["coordinates"],
            json!([0.25, 0.5, 0.5, 0.25])
        );
        assert_eq!(edited["rectangles"][1]["is_black_hole"], true);
    }
}
