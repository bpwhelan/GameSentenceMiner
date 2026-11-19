//! One long-lived blocking worker, owned by Tauri state. Commands never run OCR
//! on the event loop or Tokio pool. The mailbox has one slot, with generation
//! fencing for pause, stop, reconfiguration, and superseded manual requests.
use crate::overlay::Capture;
use gsm_overlay::{
    engines::Engines,
    ocr::{self, flag, number, Stability},
    pipeline::Recognition,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(all(test, windows))]
mod benchmark;
#[path = "ocr/inputs.rs"]
mod inputs;
#[path = "ocr/keyboard.rs"]
mod keyboard;

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "snake_case")]
enum AutoActivity {
    #[default]
    Scanning,
    WaitingForContext,
    WaitingForTarget,
    NoCaptureArea,
    NoText,
    Stabilizing,
    FuriganaFiltered,
    Watching,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    cleaned: u64,
    session: String,
    config: Value,
    running: bool,
    paused: bool,
    closed: bool,
    pending: Option<String>,
    clipboard: Option<image::RgbaImage>,
    pending_ready: Option<Instant>,
    lease: Option<Instant>,
    auto_activity: AutoActivity,
    preview: Value,
    metrics: Value,
}
type Shared = Arc<(Mutex<Inner>, Condvar)>;
const CONTEXT_LEASE: Duration = Duration::from_secs(4);

impl Inner {
    fn has_current_context(&self) -> bool {
        self.lease.is_some_and(|t| t.elapsed() < CONTEXT_LEASE)
    }

    fn auto_activity(&self) -> Option<AutoActivity> {
        if !self.running || self.paused || self.config["mode"] != "auto" {
            return None;
        }
        Some(if !self.has_current_context() {
            AutoActivity::WaitingForContext
        } else if self.config["available"] != true {
            AutoActivity::WaitingForTarget
        } else {
            self.auto_activity
        })
    }
}

#[derive(Clone)]
pub struct Ocr(Shared);
impl Ocr {
    pub fn new(app: tauri::AppHandle) -> Self {
        let shared = Arc::new((Mutex::new(Inner::default()), Condvar::new()));
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("gsm-ocr".into())
            .spawn({
                let app = app.clone();
                move || run(app, worker)
            })
            .expect("Start OCR worker");
        let this = Self(shared);
        inputs::start(app, this.clone());
        this
    }
    pub fn command(&self, message: Value) -> Result<Value, String> {
        let (lock, wake) = &*self.0;
        let mut s = lock.lock().map_err(|_| "OCR worker failed")?;
        let action = message["action"].as_str().ok_or("Missing OCR action")?;
        if action == "status" {
            return Ok(status(&s));
        }
        if action == "preview" {
            return Ok(s.preview.clone());
        }
        if s.closed {
            return Err("OCR worker has shut down".into());
        }
        if action != "start" && message["session"].as_str() != Some(&s.session) {
            return Err("Obsolete OCR session".into());
        }
        match action {
            "start" | "configure" => {
                let config = &message["config"];
                validate(config)?;
                if action == "start" {
                    s.session = message["session"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Missing OCR session")?
                        .into();
                    s.running = true;
                    s.paused = false;
                }
                // An unchanged heartbeat can renew a lease, but must never
                // make an in-flight scan from an expired lease current again.
                if s.config != *config
                    || action == "start"
                    || (s.running && !s.has_current_context())
                {
                    s.generation += 1;
                    s.config = config.clone();
                    s.pending = None;
                    s.clipboard = None;
                    s.pending_ready = None;
                    s.auto_activity = AutoActivity::Scanning;
                    s.preview = Value::Null;
                }
                s.lease = Some(Instant::now());
            }
            "stop" => {
                s.generation += 1;
                s.running = false;
                s.pending = None;
                s.clipboard = None;
                s.pending_ready = None;
                s.preview = Value::Null;
            }
            "pause" | "unpause" | "toggle_pause" => {
                s.paused = match action {
                    "pause" => true,
                    "unpause" => false,
                    _ => !s.paused,
                };
                s.generation += 1;
                s.pending = None;
                s.clipboard = None;
                s.pending_ready = None;
                s.preview = Value::Null;
            }
            "manual_ocr" | "menu_ocr" | "whole_window_ocr" | "area_select_ocr"
            | "clipboard_ocr" => {
                if !s.running {
                    return Err("OCR is stopped".into());
                }
                s.generation += 1;
                s.pending = Some(action.into());
                s.pending_ready = Some(
                    Instant::now()
                        + Duration::from_millis(
                            message["delayMs"].as_u64().unwrap_or(0).min(10000),
                        ),
                );
            }
            "toggle_force_stable" | "set_force_stable" => {
                let enabled = if action == "set_force_stable" {
                    message["enabled"].as_bool().unwrap_or(false)
                } else {
                    !flag(&s.config["settings"], "force_stable", false)
                };
                s.config["settings"]["force_stable"] = json!(enabled);
                s.generation += 1;
            }
            _ => return Err(format!("Unknown native OCR command: {action}")),
        }
        wake.notify_all();
        Ok(status(&s))
    }
    pub fn wait_stopped(&self) -> Result<(), String> {
        let (lock, wake) = &*self.0;
        let s = lock.lock().map_err(|_| "OCR worker failed")?;
        let generation = s.generation;
        let (s, timeout) = wake
            .wait_timeout_while(s, Duration::from_secs(30), |s| {
                s.cleaned < generation && !s.running
            })
            .map_err(|_| "OCR worker failed")?;
        if timeout.timed_out() && s.cleaned < generation {
            Err("OCR is still finishing an inference; shutdown was not acknowledged".into())
        } else {
            Ok(())
        }
    }
    pub fn shutdown(&self) {
        let (lock, wake) = &*self.0;
        let mut s = lock.lock().unwrap();
        s.closed = true;
        s.running = false;
        s.generation += 1;
        s.pending = None;
        s.clipboard = None;
        s.pending_ready = None;
        wake.notify_all();
    }
}
fn status(s: &Inner) -> Value {
    json!({"isRunning":s.running,"paused":s.paused,"manual":s.config["mode"]=="manual",
        "current_engine":s.config["settings"]["ocr2"],"scan_rate":number(&s.config["settings"],"scanRate",0.5),
        "force_stable":flag(&s.config["settings"],"force_stable",false),"runtime":"rust",
        "auto_activity":s.auto_activity(),"metrics":s.metrics})
}
fn validate(config: &Value) -> Result<(), String> {
    if !config["profile"].is_string() || !config["settings"].is_object() {
        return Err("Invalid OCR configuration".into());
    }
    for key in ["ocr1", "ocr2"] {
        if !config["settings"][key]
            .as_str()
            .is_some_and(|name| crate::ocr_coordinator::NATIVE_ENGINES.contains(&name))
        {
            return Err(format!("Engine {key} has no native implementation"));
        }
    }
    if !matches!(config["mode"].as_str(), Some("auto" | "manual")) {
        return Err("Invalid OCR mode".into());
    }
    Ok(())
}
fn emit(app: &tauri::AppHandle, s: &Inner, event: &str, data: Value) {
    crate::ocr_coordinator::on_native_ocr_event(app, &s.session, event, data);
}
fn milliseconds() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
pub fn capture_preview(config: Value, request: Value) -> Result<Value, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    static LOCK: Mutex<()> = Mutex::new(());
    let Ok(_guard) = LOCK.try_lock() else {
        return Ok(Value::Null);
    };
    if request["sceneName"] != config["scene"] || config["available"] != true {
        return Ok(Value::Null);
    }
    let mut capture = Capture::default();
    let mut obs = gsm_capture::obs::Capture::default();
    let image = if config["capture_kind"] == "obs" {
        (*obs.grab(
            &config["obs"],
            config["capture_source"].as_str().unwrap_or(""),
        )?)
        .clone()
    } else {
        capture_frame(&config, &mut capture)?
    };
    let image = image::DynamicImage::ImageRgba8(image)
        .thumbnail(960, 720)
        .into_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 70)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"sceneId":request["sceneId"],"sceneName":config["scene"],"sourceName":config["source_name"],"width":image.width(),"height":image.height(),"imageData":format!("data:image/jpeg;base64,{}",STANDARD.encode(bytes)),"capturedAt":milliseconds(),"boxes":[]}),
    )
}
fn run(app: tauri::AppHandle, shared: Shared) {
    let (lock, wake) = &*shared;
    let mut engines: Option<(PathBuf, Engines)> = None;
    let mut last_inference = Instant::now();
    let mut capture = Capture::default();
    let mut obs_capture = gsm_capture::obs::Capture::default();
    let mut gate = Stability::default();
    let mut previous = Vec::<String>::new();
    let mut generation = 0;
    let mut deadline = Instant::now();
    let mut last_error = String::new();
    let mut settled_frame = None;
    let mut pending_frame: Option<(ocr::Prepared, Recognition, u128, (u32, u32))> = None;
    let (mut captured_frames, mut inference_calls, mut unchanged_frames) = (0u64, 0u64, 0u64);
    loop {
        let mut s = lock.lock().unwrap();
        if s.closed {
            capture.clear();
            obs_capture.clear();
            return;
        }
        if !s.running {
            capture.clear();
            obs_capture.clear();
            engines = None;
            gate = Stability::default();
            previous.clear();
            settled_frame = None;
            pending_frame = None;
            s.cleaned = s.generation;
            wake.notify_all();
            drop(wake.wait(s).unwrap());
            continue;
        }
        let leased = s.has_current_context();
        let available = leased && s.config["available"] == true;
        // Manual requests may run while automatic OCR is paused. The picker
        // captures the desktop itself and does not require an active game.
        let pick = matches!(
            s.pending.as_deref(),
            Some("area_select_ocr" | "clipboard_ocr")
        );
        let automatic = s.config["mode"] == "auto" && !s.paused && available;
        if !leased || (!pick && (!available || (!automatic && s.pending.is_none()))) {
            capture.clear();
            obs_capture.clear();
            // A paused/manual session must not retain full-resolution frame
            // history, or keep its private ONNX models alive indefinitely.
            gate = Stability::default();
            settled_frame = None;
            pending_frame = None;
            if last_inference.elapsed() >= Duration::from_secs(60) { engines = None; }
            drop(wake.wait_timeout(s, Duration::from_secs(5)).unwrap());
            continue;
        }
        if generation != s.generation {
            generation = s.generation;
            gate = Stability::default();
            previous.clear();
            capture.clear();
            obs_capture.clear();
            deadline = Instant::now();
            last_error.clear();
            settled_frame = None;
            pending_frame = None;
            priority(
                s.config["settings"]["processPriority"]
                    .as_str()
                    .unwrap_or("normal"),
            );
        }
        if s.pending.is_none() && Instant::now() < deadline {
            // Release capture when the context lease expires, even at a slow
            // scan rate and after the service disappears without sending stop.
            let wait = deadline
                .saturating_duration_since(Instant::now())
                .min(CONTEXT_LEASE.saturating_sub(s.lease.unwrap().elapsed()));
            drop(wake.wait_timeout(s, wait).unwrap());
            continue;
        }
        if let Some(ready) = s.pending_ready {
            if Instant::now() < ready {
                let wait = ready
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(250));
                drop(wake.wait_timeout(s, wait).unwrap());
                continue;
            }
        }
        let clipboard = s.clipboard.take();
        let action = s.pending.take().unwrap_or_else(|| "auto".into());
        let automatic = action == "auto";
        let config = s.config.clone();
        drop(s);
        let settings = &config["settings"];
        let period = Duration::from_secs_f64(number(settings, "scanRate", 0.5).clamp(0.1, 60.));
        let start = Instant::now();
        let mut captured_at = milliseconds();
        let profile = PathBuf::from(config["profile"].as_str().unwrap_or_default());
        if engines.as_ref().is_none_or(|(p, _)| *p != profile) {
            engines = Some((profile.clone(), Engines::new(&profile)));
        }
        let mut activity = None;
        let result = (|| -> Result<Option<(Recognition, Value)>, String> {
            let (image, mut dimensions) = if action == "clipboard_ocr" {
                let image = clipboard.ok_or("Clipboard image is no longer available")?;
                let dimensions = image.dimensions();
                (image, dimensions)
            } else if action == "area_select_ocr" {
                let Some(image) = crate::ocr_selector::select(&shared_cancel(&shared, generation))?
                else {
                    return Ok(None);
                };
                let dimensions = image.dimensions();
                (image, dimensions)
            } else {
                if config["target_id"].is_null() && config["capture_kind"] != "obs" {
                    return Err("Waiting for a game capture target".into());
                }
                let image = if config["capture_kind"] == "obs" {
                    (*obs_capture.grab(
                        &config["obs"],
                        config["capture_source"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .or(config["scene"].as_str())
                            .unwrap_or(""),
                    )?)
                    .clone()
                } else {
                    capture_frame(&config, &mut capture)?
                };
                #[cfg(windows)]
                capture.set_interval(period.min(Duration::from_millis(100)));
                let dimensions = image.dimensions();
                (image, dimensions)
            };
            let capture_ms = start.elapsed().as_secs_f64() * 1000.;
            captured_frames += 1;
            let Some(mut prepared) = ocr::prepare(
                &image,
                &config["areas"],
                action == "menu_ocr",
                matches!(
                    action.as_str(),
                    "whole_window_ocr" | "area_select_ocr" | "clipboard_ocr"
                ),
                settings,
            ) else {
                activity = Some(AutoActivity::NoCaptureArea);
                return Ok(None);
            };
            let engine = engines.as_mut().unwrap();
            let frame_hash = image_hash(&prepared.image);
            if automatic && pending_frame.is_none() && settled_frame == Some(frame_hash) {
                unchanged_frames += 1;
                return Ok(None);
            }
            let language = settings["language"].as_str().unwrap_or("ja");
            let two = automatic && flag(settings, "twoPassOCR", true);
            let first = settings["ocr1"].as_str().unwrap_or("screenai");
            let main = settings["ocr2"].as_str().unwrap_or("glens");
            let selected = if matches!(action.as_str(), "menu_ocr" | "area_select_ocr")
                && matches!(
                    settings["menuAreaOcrEngine"].as_str(),
                    Some("glens" | "bing")
                ) {
                settings["menuAreaOcrEngine"].as_str().unwrap()
            } else {
                main
            };
            // A temporary menu/clipboard action must not evict the configured
            // automatic passes and force a reload on the next frame.
            let configured_first = if config["mode"] == "auto" && flag(settings, "twoPassOCR", true) {
                first
            } else {
                main
            };
            engine.1.retain_for(&[configured_first, main, selected]);
            let ocr_start = Instant::now();
            let scale = if two {
                number(settings, "base_scale", 0.75).clamp(0.25, 1.)
            } else {
                1.
            };
            let scaled;
            let first_image = if scale < 1. {
                scaled = image::imageops::resize(
                    &prepared.image,
                    (prepared.image.width() as f64 * scale).round().max(1.) as u32,
                    (prepared.image.height() as f64 * scale).round().max(1.) as u32,
                    image::imageops::FilterType::Triangle,
                );
                &scaled
            } else {
                &prepared.image
            };
            inference_calls += 1;
            let mut recognized = engine
                .1
                .recognize(first_image, if two { first } else { selected }, language)
                .map_err(|e| e.to_string())?;
            if scale < 1. {
                let (sx, sy) = (
                    prepared.image.width() as f64 / first_image.width() as f64,
                    prepared.image.height() as f64 / first_image.height() as f64,
                );
                for line in &mut recognized.lines {
                    gsm_overlay::pipeline::remap_line(line, (0., 0.), (sx, sy));
                }
                for b in &mut recognized.detections {
                    b[0] *= sx;
                    b[2] *= sx;
                    b[1] *= sy;
                    b[3] *= sy;
                }
            }
            let first_ms = ocr_start.elapsed().as_secs_f64() * 1000.;
            if !current(&shared, generation) {
                return Ok(None);
            }
            if two {
                // A detector's boxes can stay identical while dialogue changes.
                // Its stability identity must include pixels, not just geometry.
                let mut stability = recognized.clone();
                if matches!(first, "vocr_detector" | "meiki_text_detector" | "mida_detector")
                    && !stability.detections.is_empty()
                {
                    stability.text =
                        fingerprint(&prepared.image, &stability.detections).to_string();
                }
                let empty = stability.text.trim().is_empty() && stability.detections.is_empty();
                let ready = gate.observe(&stability, start, captured_at, settings);
                // Keep the candidate's onset even when a later image supplies the OCR text.
                captured_at = gate.first_seen_at().unwrap_or(captured_at);
                if empty && pending_frame.is_some() {
                    // Retain only one candidate frame so a fast-disappearing
                    // subtitle can still finish its second pass.
                    let (old_image, old_result, at, size) = pending_frame.take().unwrap();
                    prepared = old_image;
                    recognized = old_result;
                    captured_at = at;
                    dimensions = size;
                } else if !ready {
                    if empty {
                        activity = Some(AutoActivity::NoText);
                        settled_frame = Some(frame_hash);
                    }
                    pending_frame = if gate.pending() {
                        activity = Some(AutoActivity::Stabilizing);
                        Some((prepared, recognized, captured_at, dimensions))
                    } else {
                        None
                    };
                    return Ok(None);
                } else {
                    pending_frame = None;
                }
            }
            if two && (first != selected || scale < 1.) {
                let crop = if flag(settings, "optimize_second_scan", true) {
                    ocr::second_pass_crop(&prepared.image, &recognized)
                } else {
                    None
                };
                inference_calls += 1;
                recognized = engine
                    .1
                    .recognize(
                        crop.as_ref().map(|c| &c.0).unwrap_or(&prepared.image),
                        selected,
                        language,
                    )
                    .map_err(|e| {
                        gate.retry();
                        e.to_string()
                    })?;
                if let Some((_, x, y)) = crop {
                    for line in &mut recognized.lines {
                        gsm_overlay::pipeline::remap_line(line, (x as f64, y as f64), (1., 1.));
                    }
                }
            }
            let all_text_filtered = ocr::finish(
                &mut recognized,
                &prepared,
                settings,
                &config["replacements"],
                automatic,
            )?;
            let empty = recognized.text.trim().is_empty();
            if automatic {
                settled_frame = Some(frame_hash);
                activity = Some(if all_text_filtered {
                    AutoActivity::FuriganaFiltered
                } else if empty {
                    AutoActivity::NoText
                } else {
                    AutoActivity::Watching
                });
            }
            if empty {
                return Ok(None);
            }
            let chunks: Vec<_> = recognized.lines.iter().map(|l| l.text.clone()).collect();
            if automatic && ocr::duplicate(&previous, &chunks, settings) {
                return Ok(None);
            }
            previous = chunks;
            Ok(Some((
                recognized,
                json!({"engine":selected,"size":dimensions,"capturedAt":captured_at,"capture_ms":capture_ms,"first_pass_ms":first_ms,"ocr_ms":ocr_start.elapsed().as_secs_f64()*1000.,"total_ms":start.elapsed().as_secs_f64()*1000.}),
            )))
        })();
        last_inference = Instant::now();
        // No catch-up bursts when inference takes longer than the scan interval.
        deadline = Instant::now() + period;
        let mut s = lock.lock().unwrap();
        if s.generation != generation || !s.running || s.closed || !s.has_current_context() {
            continue;
        }
        if let Some(activity) = activity.filter(|_| automatic) {
            s.auto_activity = activity;
        }
        match result {
            Ok(Some((result, metrics))) => {
                last_error.clear();
                s.metrics = metrics.clone();
                let size = &metrics["size"];
                let (w, h) = (
                    size[0].as_f64().unwrap_or(1.),
                    size[1].as_f64().unwrap_or(1.),
                );
                if !matches!(action.as_str(), "area_select_ocr" | "clipboard_ocr") {
                    s.preview = json!({"sceneName":config["scene"],"sourceName":config["source_name"],"sourceWidth":w,"sourceHeight":h,
                        "boxes":result.lines.iter().take(200).map(|l|{let [x,y,r,b]=l.bounds;json!({"text":l.text,"points":[[x/w,y/h],[r/w,y/h],[r/w,b/h],[x/w,b/h]]})}).collect::<Vec<_>>()});
                }
                let category = match action.as_str() {
                    "menu_ocr" => "menu",
                    "area_select_ocr" => "area_select",
                    _ => "auto",
                };
                let keep = flag(
                    settings,
                    &format!("keep_newline_{category}"),
                    !flag(settings, "advancedMode", false) || flag(settings, "keep_newline", false),
                );
                let copy = flag(
                    settings,
                    &format!("send_to_clipboard_{category}"),
                    flag(settings, "sendToClipboard", false),
                );
                let text = if keep {
                    result.text
                } else {
                    result.text.replace('\n', "")
                };
                let source = match action.as_str() {
                    "auto" => "ocr",
                    "menu_ocr" => "secondary",
                    "whole_window_ocr" => "manual",
                    "area_select_ocr" => "screen_cropper",
                    _ => "ocr_manual",
                };
                let geometry = if matches!(action.as_str(), "area_select_ocr" | "clipboard_ocr") {
                    Value::Null
                } else {
                    json!({"schema":"gsm_overlay_coords_v1","coordinate_space":{"mode":"source_content","source_width":w,"source_height":h},"lines":result.lines.iter().map(legacy_line).collect::<Vec<_>>()})
                };
                emit(
                    &app,
                    &s,
                    "ocr_result",
                    json!({"text":text,"sentence":text,"source":source,"sourceInstance":"gsm-native-ocr","sourceDisplayName":"GSM OCR",
                    "observationId":uuid::Uuid::new_v4().to_string(),"capturedAt":metrics["capturedAt"],"emittedAt":milliseconds(),
                    "ocr_engine":metrics["engine"],"ocr_scene":config["scene"],"exclusion_game":config["scene"],"process_path":config["process_path"],
                    "copyToClipboard":copy,"ocr_model":result.model,"dict_from_ocr":geometry,"metrics":metrics}),
                );
            }
            Ok(None) => {}
            Err(error) => {
                if error != last_error {
                    emit(&app, &s, "error", json!({"error":error}));
                    last_error = error;
                }
                deadline = Instant::now() + period.max(Duration::from_secs(1));
            }
        }
        s.metrics["captured_frames"] = json!(captured_frames);
        s.metrics["inference_calls"] = json!(inference_calls);
        s.metrics["unchanged_frames"] = json!(unchanged_frames);
        if flag(&s.config["settings"], "force_stable", false) {
            s.config["settings"]["force_stable"] = json!(false);
            emit(
                &app,
                &s,
                "force_stable_changed",
                json!({"force_stable":false}),
            );
        }
    }
}
fn current(shared: &Shared, generation: u64) -> bool {
    let s = shared.0.lock().unwrap();
    s.generation == generation && s.running && !s.closed && s.has_current_context()
}
fn legacy_line(line: &gsm_overlay::pipeline::TextBox) -> Value {
    let [x, y, r, b] = line.bounds;
    json!({"text":line.text,"bounding_rect":{"x1":x,"y1":y,"x2":r,"y2":y,"x3":r,"y3":b,"x4":x,"y4":b},"words":line.words.iter().map(legacy_line).collect::<Vec<_>>()})
}
fn shared_cancel(shared: &Shared, generation: u64) -> impl Fn() -> bool + use<> {
    let shared = shared.clone();
    move || !current(&shared, generation)
}
fn fingerprint(image: &image::RgbaImage, boxes: &[[f64; 4]]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    for b in boxes {
        for y in (b[1].max(0.) as u32..(b[3] as u32).min(image.height())).step_by(3) {
            for x in (b[0].max(0.) as u32..(b[2] as u32).min(image.width())).step_by(3) {
                image.get_pixel(x, y).0.hash(&mut hash);
            }
        }
    }
    hash.finish()
}
fn image_hash(image: &image::RgbaImage) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    image.dimensions().hash(&mut hash);
    image.as_raw().hash(&mut hash);
    hash.finish()
}
use gsm_capture::capture_window as capture_frame;
#[cfg(windows)]
fn priority(value: &str) {
    use windows::Win32::System::Threading::*;
    let value = match value {
        "low" => THREAD_PRIORITY_LOWEST,
        "below_normal" => THREAD_PRIORITY_BELOW_NORMAL,
        "above_normal" => THREAD_PRIORITY_ABOVE_NORMAL,
        "high" => THREAD_PRIORITY_HIGHEST,
        _ => THREAD_PRIORITY_NORMAL,
    };
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), value);
    }
}
#[cfg(not(windows))]
fn priority(_value: &str) {}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value {
        json!({"profile":"test","mode":"auto","settings":{"ocr1":"screenai","ocr2":"screenai"}})
    }
    #[test]
    fn renewed_capture_context_invalidates_work_from_an_expired_lease() {
        let ocr = Ocr(Arc::new((Mutex::new(Inner::default()), Condvar::new())));
        let mut config = config();
        let start = ocr
            .command(json!({"action":"start","session":"one","config":config}))
            .unwrap();
        assert_eq!(start["auto_activity"], "waiting_for_target");

        config["available"] = json!(true);
        let refresh = json!({"action":"configure","session":"one","config":config});
        ocr.command(refresh.clone()).unwrap();
        let before = {
            let mut state = ocr.0 .0.lock().unwrap();
            state.lease = Some(Instant::now() - CONTEXT_LEASE);
            state.generation
        };
        let waiting = ocr.command(json!({"action":"status"})).unwrap();
        assert_eq!(waiting["auto_activity"], "waiting_for_context");
        let resumed = ocr.command(refresh).unwrap();
        assert_eq!(resumed["auto_activity"], "scanning");
        assert!(!current(&ocr.0, before));
    }
    #[test]
    fn mailbox_is_bounded_and_obsolete_sessions_cannot_control_new_runs() {
        let ocr = Ocr(Arc::new((Mutex::new(Inner::default()), Condvar::new())));
        ocr.command(json!({"action":"start","session":"one","config":config()}))
            .unwrap();
        let before = ocr.0 .0.lock().unwrap().generation;
        for _ in 0..100 {
            ocr.command(json!({"action":"manual_ocr","session":"one"}))
                .unwrap();
        }
        assert_eq!(
            ocr.0 .0.lock().unwrap().pending.as_deref(),
            Some("manual_ocr")
        );
        assert!(!current(&ocr.0, before));
        ocr.command(json!({"action":"start","session":"two","config":config()}))
            .unwrap();
        assert!(ocr
            .command(json!({"action":"stop","session":"one"}))
            .is_err());
        assert!(ocr.0 .0.lock().unwrap().running);
        let before = ocr.0 .0.lock().unwrap().generation;
        ocr.command(json!({"action":"configure","session":"two","config":config()}))
            .unwrap();
        assert_eq!(
            before,
            ocr.0 .0.lock().unwrap().generation,
            "lease heartbeats must not cancel scans"
        );
        assert!(current(&ocr.0, before));
        ocr.0 .0.lock().unwrap().lease = Some(Instant::now() - Duration::from_secs(5));
        assert!(
            !current(&ocr.0, before),
            "lost service cancels in-flight OCR and the picker"
        );
    }
}
