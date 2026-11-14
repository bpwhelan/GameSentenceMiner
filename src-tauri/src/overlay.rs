//! Native overlay worker. The mailbox stores one pending scan; control changes
//! invalidate an in-flight result before it can reach the webview.
use base64::{engine::general_purpose::STANDARD, Engine};
use gsm_overlay::{
    adaptive::{self, Focus, HookTiming, LearnedDelay, Region, Retry},
    engines::Engines,
    pipeline::{self, Projection, TextBox},
    presence::{self, Decision, Landing, Presence},
};
use image::RgbaImage;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
#[cfg(windows)]
pub(crate) mod wgc;
#[cfg(not(windows))]
pub(crate) use gsm_capture::Capture;
thread_local! { static OBS_CAPTURE: std::cell::RefCell<gsm_capture::obs::Capture> = std::cell::RefCell::new(gsm_capture::obs::Capture::default()); }
#[cfg(windows)]
pub(crate) use wgc::Capture;

#[derive(Default)]
struct Inner {
    generation: u64,
    label: String,
    config: Value,
    pending: Option<Value>,
    requested_at: Option<Instant>,
    background: Option<Value>,
    paused: bool,
    closed: bool,
}
#[derive(Clone)]
pub struct Overlay(Arc<(Mutex<Inner>, Condvar)>);
impl Overlay {
    pub fn new(app: tauri::AppHandle) -> Self {
        let shared = Arc::new((Mutex::new(Inner::default()), Condvar::new()));
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("gsm-overlay".into())
            .spawn(move || run(app, worker))
            .expect("Start native overlay worker");
        Self(shared)
    }
    pub fn command(&self, label: &str, message: Value) -> Result<Value, String> {
        let (lock, wake) = &*self.0;
        let mut state = lock.lock().map_err(|_| "Overlay worker stopped")?;
        let previous_generation = state.generation;
        let action = message["action"].as_str().unwrap_or("configure");
        if !matches!(
            action,
            "configure" | "scan" | "background" | "pause" | "stop"
        ) {
            return Err("Unknown overlay action".into());
        }
        if action == "stop" && state.label != label {
            return Ok(Value::Null);
        }
        if state.label != label {
            state.generation += 1;
            state.label = label.into();
        }
        if let Some(config) = message.get("config") {
            if state.config != *config {
                state.generation += 1;
                state.config = config.clone();
                if available(config) && state.pending.is_none() {
                    state.pending = Some(json!({"action":"scan","retries":0}));
                    state.requested_at = Some(Instant::now());
                }
            }
        }
        match action {
            "scan" => {
                state.generation += 1;
                state.pending = Some(message);
                state.requested_at = Some(Instant::now());
            }
            "background" => {
                state.background = Some(message);
            }
            "pause" => {
                state.generation += 1;
                state.paused = message["paused"].as_bool().unwrap_or(false);
                state.pending = None;
            }
            "stop" => {
                state.generation += 1;
                state.label.clear();
                state.pending = None;
                state.background = None;
                state.paused = false;
                state.config = Value::Null;
            }
            "configure" => {}
            _ => return Err("Unknown overlay action".into()),
        }
        wake.notify_one();
        Ok(
            json!({"generation":state.generation,"clear":previous_generation!=state.generation && (state.paused||!available(&state.config))}),
        )
    }
    pub fn shutdown(&self) {
        let (lock, wake) = &*self.0;
        let mut state = lock.lock().unwrap();
        state.closed = true;
        state.generation += 1;
        wake.notify_one();
    }
}
fn flag(config: &Value, key: &str, default: bool) -> bool {
    config["settings"][key].as_bool().unwrap_or(default)
}
fn number(config: &Value, key: &str, default: f64) -> f64 {
    config["settings"][key]
        .as_f64()
        .filter(|n| n.is_finite())
        .unwrap_or(default)
}
fn available(config: &Value) -> bool {
    config["available"].as_bool().unwrap_or(false)
}
fn emit(app: &tauri::AppHandle, label: &str, payload: Value) {
    if let Some(host) = app.try_state::<crate::overlay_host::OverlayHost>() {
        host.observe_native_payload(app, &payload);
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.eval(&format!(
            "window.__GSM_DESKTOP_DISPATCH__?.('overlay-websocket-data',[{}])",
            json!({"type":"ws2","data":payload.to_string()})
        ));
    }
}
pub fn clear(app: &tauri::AppHandle, label: &str) {
    emit(
        app,
        label,
        json!({"type":"word_coordinates","data":[],"native_layout":true,"blocks":[]}),
    );
}
fn run(app: tauri::AppHandle, shared: Arc<(Mutex<Inner>, Condvar)>) {
    let (lock, wake) = &*shared;
    let mut engines: Option<(PathBuf, Engines)> = None;
    let mut capture_state = Capture::default();
    let mut deadline = Instant::now();
    let mut quiet_until = Instant::now();
    let mut last_use = Instant::now();
    let mut last_text = String::new();
    let mut last_cursor = None;
    let mut observed_generation = 0;
    let mut watch: Option<Watch> = None;
    let mut focus = Focus::default();
    let mut focus_context = Value::Null;
    let mut last_projection = None;
    let mut learned_delay = LearnedDelay::default();
    let mut hook_context = Value::Null;
    let mut correction = gsm_overlay::correction::History::default();
    let clock = Instant::now();
    loop {
        let mut state = lock.lock().unwrap();
        if state.closed {
            break;
        }
        if !state.label.is_empty() && app.get_webview_window(&state.label).is_none() {
            state.generation += 1;
            state.label.clear();
            state.pending = None;
            state.background = None;
            state.config = Value::Null;
        }
        if state.generation != observed_generation {
            observed_generation = state.generation;
            watch = None;
            // Target/profile/visibility changes discard the previous frame.
            if !available(&state.config) || state.paused {
                emit(
                    &app,
                    &state.label,
                    json!({"type":"word_coordinates","data":[],"native_layout":true,"blocks":[]}),
                );
                last_text.clear();
            }
        }
        if focus_context != state.config {
            if focus_context["target_id"] != state.config["target_id"]
                || focus_context["scene"] != state.config["scene"]
                || focus_context["profile"] != state.config["profile"]
            {
                correction.clear();
            }
            focus.clear();
            last_projection = None;
            focus_context = state.config.clone();
        }
        if engines.is_some()
            && (state.label.is_empty()
                || (watch.is_none() && last_use.elapsed() > Duration::from_secs(300)))
        {
            engines = None;
        }
        if state.label.is_empty()
            || state.paused
            || !available(&state.config)
            || last_use.elapsed() > Duration::from_secs(30)
        {
            capture_state.clear();
            OBS_CAPTURE.with(|capture| capture.borrow_mut().clear());
        }
        let automatic = state.pending.is_none() && state.background.is_none();
        if automatic
            && !state.paused
            && available(&state.config)
            && watch.as_ref().is_some_and(|w| Instant::now() >= w.deadline)
        {
            let generation = state.generation;
            let label = state.label.clone();
            let config = state.config.clone();
            drop(state);
            let mut current = watch.take().unwrap();
            last_use = Instant::now();
            let result = poll_watch(
                &mut current,
                &config,
                &mut capture_state,
                &mut engines.as_mut().unwrap().1,
            );
            let state = lock.lock().unwrap();
            if state.generation == generation && state.label == label && !state.closed {
                match result {
                    Ok(events) => {
                        current.failures = 0;
                        if !events.is_empty() {
                            focus.clear();
                        }
                        for event in events {
                            emit(&app, &label, event);
                        }
                    }
                    Err(error) => {
                        current.failures += 1;
                        eprintln!("[overlay] Presence capture: {error}");
                    }
                }
                if current.failures < 3 && !current.stopped {
                    watch = Some(current);
                }
            }
            continue;
        }
        if automatic
            && (state.label.is_empty()
                || state.paused
                || !available(&state.config)
                || !flag(&state.config, "periodic", false)
                || Instant::now() < deadline)
        {
            drop(
                wake.wait_timeout(state, Duration::from_millis(100))
                    .unwrap(),
            );
            continue;
        }
        let request = state
            .background
            .take()
            .or_else(|| state.pending.take())
            .unwrap_or_else(|| json!({"action":"scan","retries":0}));
        let generation = state.generation;
        let label = state.label.clone();
        let config = state.config.clone();
        let paused = state.paused;
        let requested_at = state.requested_at.unwrap_or_else(Instant::now);
        drop(state);
        if label.is_empty()
            || !available(&config)
            || (paused && !request["manual"].as_bool().unwrap_or(false))
        {
            continue;
        }
        let interval =
            Duration::from_secs_f64(number(&config, "periodic_interval", 1.).clamp(0.1, 60.));
        if !automatic && request["text"].as_str().is_some_and(|t| !t.is_empty()) {
            quiet_until = Instant::now() + Duration::from_secs(8);
        }
        deadline = (Instant::now() + interval).max(quiet_until);
        if automatic && flag(&config, "scan_on_mouse_move", true) {
            let position = cursor();
            if position.is_some()
                && (position == last_cursor || !cursor_over_target(&config, position.unwrap()))
            {
                last_cursor = position;
                continue;
            }
            last_cursor = position;
        }
        let cancelled = || {
            let s = lock.lock().unwrap();
            s.closed || s.generation != generation || s.label != label
        };
        let result = (|| -> Result<(), String> {
            let profile = PathBuf::from(
                config["profile"]
                    .as_str()
                    .ok_or("Overlay profile is unavailable")?,
            );
            if engines.as_ref().is_none_or(|(p, _)| p != &profile) {
                engines = Some((profile.clone(), Engines::new(&profile)));
            }
            last_use = Instant::now();
            if request["action"] == "background" {
                if config["settings"]["manual_mode_desktop_background"] == "off" {
                    return Ok(());
                }
                let (image, _) = capture(&config, true, &mut capture_state)?;
                let mut bytes = std::io::Cursor::new(Vec::new());
                image::DynamicImage::ImageRgba8(image)
                    .write_to(&mut bytes, image::ImageFormat::Jpeg)
                    .map_err(|e| e.to_string())?;
                let state = lock.lock().unwrap();
                if state.generation == generation {
                    emit(
                        &app,
                        &label,
                        json!({"type":"manual_mode_background","image":format!("data:image/jpeg;base64,{}",STANDARD.encode(bytes.into_inner()))}),
                    );
                }
                return Ok(());
            }
            let language = config["language"].as_str().unwrap_or("ja");
            let engine = config["settings"]["engine_v2"].as_str().unwrap_or("oneocr");
            let engine = if !cfg!(windows) && matches!(engine, "oneocr" | "lens") {
                "meikiocr"
            } else {
                engine
            };
            if request["recovery"] == true {
                let mut landing = Landing::default();
                for _ in 0..8 {
                    if cancelled() {
                        return Ok(());
                    }
                    let Ok((mut image, projection)) = capture(&config, false, &mut capture_state)
                    else {
                        break;
                    };
                    mask_areas(&mut image, &projection, &config);
                    if landing.observe(&image) {
                        break;
                    }
                    if !wait_until(
                        &shared,
                        generation,
                        Instant::now() + Duration::from_millis(150),
                    ) {
                        return Ok(());
                    }
                }
            }
            let attempts = if flag(&config, "text_appears_instantly", false) {
                1
            } else {
                request["retries"].as_u64().unwrap_or(5).min(8) + 1
            };
            let reference = request["text"].as_str().unwrap_or("");
            let learn = matches!(request["source"].as_str(), Some("texthook" | "hooker"))
                && local_engine(engine)
                && !reference.is_empty()
                && request["manual"] != true
                && request["precomputed"].is_null();
            let mut hook_timing = HookTiming::new(reference);
            if learn {
                let context = json!([
                    config["scene"],
                    config["target_id"],
                    language,
                    request["source_instance"]
                ]);
                if context != hook_context {
                    learned_delay = LearnedDelay::default();
                    hook_context = context;
                }
                if !wait_until(
                    &shared,
                    generation,
                    requested_at + Duration::from_secs_f64(learned_delay.delay),
                ) {
                    return Ok(());
                }
            }
            let mut retry = Retry::new(
                reference,
                attempts as u32,
                flag(&config, "adaptive_ocr_retries", false),
            );
            loop {
                if cancelled() {
                    break;
                }
                let mut timer = gsm_overlay::timing::Timer::new("scan");
                let captured_at = Instant::now();
                let (mut image, projection) = capture(&config, false, &mut capture_state)?;
                if last_projection.as_ref() != Some(&projection) {
                    focus.clear();
                    last_projection = Some(projection.clone());
                }
                timer.mark("capture");
                mask_areas(&mut image, &projection, &config);
                timer.mark("mask");
                let minimum = number(&config, "minimum_character_size", 0.);
                let forced = request["precomputed"]["bypass_ocr"] == true
                    && request["precomputed"]["producer"]["kind"] == "engine-hook"
                    && request["precomputed"]["producer"]["version"] == 1
                    && request["precomputed"]["producer"]["integrationId"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty());
                let supplied = if flag(&config, "use_ocr_result_v2", false)
                    || flag(&config, "supplement_ocr_result_with_overlay", false)
                    || forced
                {
                    pipeline::precomputed(&request["precomputed"], &projection)
                } else {
                    None
                };
                let bypass = supplied.is_some()
                    && (forced || !flag(&config, "supplement_ocr_result_with_overlay", false));
                let mut lines = if bypass {
                    focus.clear();
                    Vec::new()
                } else {
                    let use_focus = flag(&config, "adaptive_ocr_retries", false)
                        && !flag(&config, "text_appears_instantly", false)
                        && !flag(&config, "use_overlay_area_config", false)
                        && request["manual"] != true
                        && local_engine(engine);
                    if !use_focus {
                        focus.clear();
                    }
                    recognize_frame(
                        &image,
                        &projection,
                        &config,
                        reference,
                        use_focus.then_some(&mut focus),
                        captured_at.duration_since(clock).as_secs_f64(),
                        |input| {
                            if cancelled() {
                                return Err("Scan cancelled".into());
                            }
                            engines
                                .as_mut()
                                .unwrap()
                                .1
                                .recognize(input, engine, language)
                                .map(|r| r.lines)
                                .map_err(|e| format!("{e:#}"))
                        },
                    )?
                };
                timer.mark("ocr");
                correction.apply(&mut lines, reference);
                if let Some(supplied) = supplied {
                    lines.retain(|l| !supplied.iter().any(|s| pipeline::overlaps(l, s)));
                    lines.extend(supplied);
                }
                filter_areas(&mut lines, &projection, &config);
                if cancelled() {
                    break;
                }
                let mut payload = pipeline::prepare(
                    lines,
                    language,
                    minimum,
                    flag(&config, "use_text_filtering", true),
                    &projection,
                );
                let text = payload["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|l| l["text"].as_str())
                    .collect::<String>();
                let capture_seconds = captured_at.duration_since(clock).as_secs_f64();
                if learn {
                    hook_timing.observe(&text, capture_seconds);
                }
                let step = retry.observe(&text, capture_seconds, clock.elapsed().as_secs_f64());
                let final_pass = bypass || step.finished;
                payload["is_final"] = json!(final_pass);
                payload["line_id"] = request["line_id"].clone();
                payload["latest_text"] = request["text"].clone();
                payload["source"] = request["source"].clone();
                mark_latest(&mut payload, request["text"].as_str().unwrap_or(""));
                payload["engine"] = json!(engine);
                timer.mark("grouping");
                let state = lock.lock().unwrap();
                if state.generation != generation || state.label != label {
                    break;
                }
                let grew = text != last_text
                    && !last_text.is_empty()
                    && normalized(&text).contains(&normalized(&last_text));
                if !automatic
                    || grew
                    || !similar(&text, &last_text, number(&config, "periodic_ratio", 0.9))
                {
                    watch = Watch::arm(&mut payload, &image, &projection, &config);
                    emit(&app, &label, payload);
                    last_text = text;
                }
                drop(state);
                timer.mark("dispatch");
                if final_pass {
                    if learn {
                        learned_delay.record(&hook_timing);
                    }
                    break;
                }
                if !wait_until(
                    &shared,
                    generation,
                    Instant::now() + Duration::from_secs_f64(step.delay),
                ) {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            watch = None;
            let state = lock.lock().unwrap();
            if state.generation == generation && state.label == label && !state.closed {
                eprintln!("[overlay] {error}");
                emit(
                    &app,
                    &label,
                    json!({"type":"word_coordinates","data":[],"native_layout":true,"blocks":[]}),
                );
                emit(
                    &app,
                    &label,
                    json!({"type":"native-overlay-error","error":error}),
                );
            }
            deadline = Instant::now() + Duration::from_secs(5);
        }
    }
}
fn normalized(text: &str) -> String {
    adaptive::normalize(text)
}
fn wait_until(shared: &Arc<(Mutex<Inner>, Condvar)>, generation: u64, deadline: Instant) -> bool {
    let (lock, wake) = &**shared;
    let state = lock.lock().unwrap();
    let duration = deadline.saturating_duration_since(Instant::now());
    let (state, _) = wake
        .wait_timeout_while(state, duration, |s| {
            s.generation == generation && !s.closed && Instant::now() < deadline
        })
        .unwrap();
    state.generation == generation && !state.closed
}
fn local_engine(engine: &str) -> bool {
    matches!(
        engine,
        "oneocr" | "meikiocr" | "screenai" | "vitaocr" | "alivetext"
    )
}
fn configured_region(projection: &Projection, config: &Value) -> Option<Region> {
    let (includes, _) = area_regions(projection, config);
    if includes.is_empty() {
        return Some(Region::full(projection.image_size));
    }
    includes
        .into_iter()
        .filter_map(|b| Region::from_bounds(b, projection.image_size))
        .reduce(Region::union)
}
fn recognize_frame(
    image: &RgbaImage,
    projection: &Projection,
    config: &Value,
    reference: &str,
    mut focus: Option<&mut Focus>,
    now: f64,
    mut recognize: impl FnMut(&RgbaImage) -> Result<Vec<TextBox>, String>,
) -> Result<Vec<TextBox>, String> {
    let Some(base) = configured_region(projection, config) else {
        return Ok(Vec::new());
    };
    let full = Region::full(image.dimensions());
    let learned = focus
        .as_deref()
        .and_then(|f| f.region(image.dimensions(), now));
    let mut region = if base == full {
        learned.unwrap_or(base)
    } else {
        base
    };
    let mut timer = gsm_overlay::timing::Timer::new("scan.ocr");
    timer.input(region.width(), region.height());
    let result = if region == full {
        recognize(image)
    } else {
        recognize(&region.image(image))
    };
    timer.mark(if region == full { "full" } else { "crop" });
    let mut lines = if learned.is_some()
        && base == full
        && (result.as_ref().is_err()
            || result
                .as_ref()
                .is_ok_and(|lines| Focus::needs_full(lines, reference, region, image.dimensions())))
    {
        region = full;
        timer.input(full.width(), full.height());
        let lines = recognize(image)?;
        timer.mark("reacquire");
        lines
    } else {
        result?
    };
    if region != full {
        for line in &mut lines {
            pipeline::remap_line(line, (region.left as f64, region.top as f64), (1., 1.));
        }
    }
    if let Some(focus) = focus.as_mut() {
        focus.observe(&lines, image.dimensions(), reference, now, region == full);
    }
    Ok(lines)
}
// Two missed checks confirm disappearance in roughly one second.
const PRESENCE_POLL_INTERVAL: Duration = Duration::from_millis(500);

struct Watch {
    presence: Presence,
    projection: Projection,
    payload: Value,
    deadline: Instant,
    failures: u8,
    stopped: bool,
}
impl Watch {
    fn arm(payload: &mut Value, image: &RgbaImage, p: &Projection, config: &Value) -> Option<Self> {
        if !flag(config, "last_sent_ocr_presence_check", false)
            || !(flag(config, "last_sent_ocr_presence_remove_notation", true)
                || flag(config, "last_sent_ocr_presence_invalidate_lookups", true))
        {
            return None;
        }
        let lines = payload_lines(payload, p);
        let presence = Presence::new(image, lines)?;
        payload["presence_id"] = json!(uuid::Uuid::new_v4().to_string());
        Some(Self {
            presence,
            projection: p.clone(),
            payload: payload.clone(),
            deadline: Instant::now() + PRESENCE_POLL_INTERVAL,
            failures: 0,
            stopped: false,
        })
    }
}
fn payload_lines(payload: &Value, p: &Projection) -> Vec<TextBox> {
    let mut lines: Vec<_> = payload["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(pipeline::from_legacy)
        .collect();
    let sx = p.image_size.0 as f64 / p.capture[2];
    let sy = p.image_size.1 as f64 / p.capture[3];
    for line in &mut lines {
        pipeline::remap_line(
            line,
            (
                (p.monitor[0] - p.capture[0]) * sx,
                (p.monitor[1] - p.capture[1]) * sy,
            ),
            (p.monitor[2] * sx, p.monitor[3] * sy),
        );
    }
    lines
}
fn poll_watch(
    watch: &mut Watch,
    config: &Value,
    capture_state: &mut Capture,
    engines: &mut Engines,
) -> Result<Vec<Value>, String> {
    watch.deadline = Instant::now() + PRESENCE_POLL_INTERVAL;
    let mut timer = gsm_overlay::timing::Timer::new("presence");
    let (mut image, projection) = capture(config, false, capture_state)?;
    mask_areas(&mut image, &projection, config);
    timer.mark("capture");
    let geometry_changed = projection != watch.projection;
    let was_invalidated = watch.presence.invalidated();
    let decision = if geometry_changed {
        Decision::Confirm
    } else {
        watch.presence.observe(&image)
    };
    timer.mark("visual");
    match decision {
        Decision::Unchanged => Ok(Vec::new()),
        Decision::Restore => Ok(vec![
            json!({"type":"ocr_text_revalidated","presence_id":watch.payload["presence_id"],"payload":watch.payload}),
        ]),
        Decision::Confirm => {
            // Cloud OCR is never called by a background presence check.
            let selected = config["settings"]["engine_v2"].as_str().unwrap_or("oneocr");
            let engine = if !cfg!(windows) && matches!(selected, "oneocr" | "lens") {
                "meikiocr"
            } else if local_engine(selected) {
                selected
            } else if cfg!(windows) {
                "oneocr"
            } else {
                "meikiocr"
            };
            let language = config["language"].as_str().unwrap_or("ja");
            let mut lines = recognize_frame(&image, &projection, config, "", None, 0., |input| {
                engines
                    .recognize(input, engine, language)
                    .map(|r| r.lines)
                    .map_err(|e| format!("{e:#}"))
            })
            .unwrap_or_default();
            filter_areas(&mut lines, &projection, config);
            timer.mark("confirm_ocr");
            if let Some(lines) = presence::match_lines(&watch.presence.lines, &lines) {
                let mut payload = pipeline::prepare(
                    lines,
                    language,
                    number(config, "minimum_character_size", 0.),
                    flag(config, "use_text_filtering", true),
                    &projection,
                );
                for key in [
                    "presence_id",
                    "line_id",
                    "latest_text",
                    "engine",
                    "is_final",
                ] {
                    payload[key] = watch.payload[key].clone();
                }
                mark_latest(
                    &mut payload,
                    watch.payload["latest_text"].as_str().unwrap_or(""),
                );
                if let Some(presence) = Presence::new(&image, payload_lines(&payload, &projection))
                {
                    watch.presence = presence;
                    watch.projection = projection;
                    watch.payload = payload.clone();
                    return Ok(vec![if was_invalidated {
                        json!({"type":"ocr_text_revalidated","presence_id":payload["presence_id"],"payload":payload})
                    } else {
                        payload
                    }]);
                }
            }
            watch.presence.invalidate();
            // Without a matching text location after a resize/move, the old
            // pixel reference cannot safely restore coordinates. A new scan
            // will arm a fresh monitor instead of OCR polling indefinitely.
            watch.stopped = geometry_changed;
            Ok(vec![
                json!({"type":"ocr_text_invalidated","presence_id":watch.payload["presence_id"],
                "remove_notation":flag(config,"last_sent_ocr_presence_remove_notation",true),
                "invalidate_lookups":flag(config,"last_sent_ocr_presence_invalidate_lookups",true)}),
            ])
        }
    }
}
fn mark_latest(payload: &mut Value, text: &str) {
    let reference = normalized(text);
    if reference.is_empty() {
        return;
    }
    let lines = payload["data"].as_array().cloned().unwrap_or_default();
    if let Some(blocks) = payload["blocks"].as_array_mut() {
        for block in blocks {
            let text = lines
                .iter()
                .filter(|l| l["block_id"] == block["id"])
                .filter_map(|l| l["text"].as_str())
                .collect::<String>();
            block["isLatestLine"] =
                json!(normalized(&text).contains(&reference) || similar(&text, &reference, 0.8));
        }
    }
}
fn similar(a: &str, b: &str, threshold: f64) -> bool {
    if a == b {
        return true;
    }
    let (a, b) = (normalized(a), normalized(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let metrics = gsm_overlay::text_matching::match_metrics(&a, &b, 1);
    2. * metrics.matched as f64 / (metrics.reference_len + metrics.candidate_len) as f64
        >= threshold.clamp(0., 1.)
}

pub(crate) fn capture(
    config: &Value,
    background: bool,
    _state: &mut Capture,
) -> Result<(RgbaImage, Projection), String> {
    let mut timer = gsm_overlay::timing::Timer::new("capture");
    let source = config["source_name"].as_str().filter(|s| !s.is_empty());
    let obs_allowed = !background
        && !flag(config, "ocr_full_screen_instead_of_obs", false)
        && source.is_some()
        && config["obs"].is_object();
    let capture_obs = || {
        let (bounds, capture) = gsm_capture::source_projection(config)?;
        let image = OBS_CAPTURE.with(|c| c.borrow_mut().grab(&config["obs"], source.unwrap()))?;
        Ok::<_, String>(((*image).clone(), bounds, capture))
    };
    let (image, bounds, capture) = if obs_allowed && config["capture_kind"] == "obs" {
        capture_obs()?
    } else {
        match gsm_capture::capture(config, background, _state) {
            Ok(frame) => frame,
            Err(_) if obs_allowed => capture_obs()?,
            Err(error) => return Err(error),
        }
    };
    timer.mark("crop");
    let scale = if background {
        1.
    } else {
        number(config, "base_scale", 0.75).clamp(0.25, 1.)
    };
    let image = if scale < 1. {
        image::imageops::resize(
            &image,
            (image.width() as f64 * scale).max(1.) as u32,
            (image.height() as f64 * scale).max(1.) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let projection = Projection {
        monitor: bounds,
        capture,
        image_size: image.dimensions(),
    };
    timer.mark("resize");
    Ok((image, projection))
}

fn area_regions(p: &Projection, config: &Value) -> (Vec<[f64; 4]>, Vec<[f64; 4]>) {
    if !flag(config, "use_overlay_area_config", false) {
        return (Vec::new(), Vec::new());
    }
    let area = &config["areas"];
    let Some(rectangles) = area["rectangles"].as_array() else {
        return (Vec::new(), Vec::new());
    };
    let screen = area["overlay_coordinate_space"] == "monitor";
    let source = if screen { p.monitor } else { p.capture };
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    for rectangle in rectangles {
        let Some(c) = rectangle["coordinates"].as_array().filter(|c| c.len() == 4) else {
            continue;
        };
        let mut b = [
            c[0].as_f64().unwrap_or(0.),
            c[1].as_f64().unwrap_or(0.),
            c[2].as_f64().unwrap_or(0.),
            c[3].as_f64().unwrap_or(0.),
        ];
        if area["coordinate_system"] == "percentage" {
            b[0] *= source[2];
            b[1] *= source[3];
            b[2] *= source[2];
            b[3] *= source[3];
        }
        let x = (source[0] + b[0] - p.capture[0]) * p.image_size.0 as f64 / p.capture[2];
        let y = (source[1] + b[1] - p.capture[1]) * p.image_size.1 as f64 / p.capture[3];
        let r = [
            x,
            y,
            x + b[2] * p.image_size.0 as f64 / p.capture[2],
            y + b[3] * p.image_size.1 as f64 / p.capture[3],
        ];
        if rectangle["is_excluded"] == true {
            if flag(config, "ocr_area_config_use_exclusion_zones", true) {
                excludes.push(r);
            }
        } else if flag(
            config,
            if rectangle["is_secondary"] == true {
                "ocr_area_config_include_secondary_areas"
            } else {
                "ocr_area_config_include_primary_areas"
            },
            true,
        ) {
            includes.push(r);
        }
    }
    (includes, excludes)
}
fn allowed(regions: &(Vec<[f64; 4]>, Vec<[f64; 4]>), x: f64, y: f64) -> bool {
    let contains = |r: &[f64; 4]| x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
    (regions.0.is_empty() || regions.0.iter().any(contains)) && !regions.1.iter().any(contains)
}
fn mask_areas(image: &mut RgbaImage, p: &Projection, config: &Value) {
    let regions = area_regions(p, config);
    if regions.0.is_empty() && regions.1.is_empty() {
        return;
    }
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        if !allowed(&regions, x as f64, y as f64) {
            *pixel = image::Rgba([0, 0, 0, 255]);
        }
    }
}
fn filter_areas(lines: &mut Vec<TextBox>, p: &Projection, config: &Value) {
    let regions = area_regions(p, config);
    let keep = |line: &TextBox| {
        allowed(
            &regions,
            (line.bounds[0] + line.bounds[2]) / 2.,
            (line.bounds[1] + line.bounds[3]) / 2.,
        )
    };
    lines.retain_mut(|line| {
        if line.words.is_empty() {
            return keep(line);
        }
        let count = line.words.len();
        line.words.retain(keep);
        if line.words.len() != count {
            line.text = line
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<String>();
        }
        !line.words.is_empty()
    });
}
#[cfg(windows)]
fn cursor() -> Option<(i32, i32)> {
    use windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};
    let mut point = POINT::default();
    unsafe {
        GetCursorPos(&mut point).ok()?;
    }
    Some((point.x, point.y))
}
#[cfg(not(windows))]
fn cursor() -> Option<(i32, i32)> {
    None
}
fn cursor_over_target(config: &Value, point: (i32, i32)) -> bool {
    let Some(id) = config["target_id"].as_u64() else {
        return flag(config, "ocr_full_screen_instead_of_obs", false);
    };
    xcap::Window::all()
        .ok()
        .into_iter()
        .flatten()
        .find(|w| w.id().ok().map(u64::from) == Some(id))
        .is_some_and(|w| {
            let (Ok(x), Ok(y), Ok(width), Ok(height)) = (w.x(), w.y(), w.width(), w.height())
            else {
                return false;
            };
            point.0 >= x
                && point.1 >= y
                && point.0 < x + width as i32
                && point.1 < y + height as i32
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_crop_preserves_masks_words_and_scaled_desktop_coordinates() {
        let p = Projection {
            monitor: [-1920., 0., 1920., 1080.],
            capture: [-1820., 100., 1000., 600.],
            image_size: (500, 300),
        };
        let config = json!({"settings":{"use_overlay_area_config":true},"areas":{"coordinate_system":"percentage","overlay_coordinate_space":"window","rectangles":[
            {"coordinates":[0.1,0.5,0.8,0.25],"is_excluded":false},
            {"coordinates":[0.8,0.5,0.1,0.25],"is_excluded":true}
        ]}});
        let mut image = RgbaImage::from_pixel(500, 300, image::Rgba([255; 4]));
        mask_areas(&mut image, &p, &config);
        let lines = recognize_frame(&image, &p, &config, "", None, 0., |input| {
            assert_eq!(input.dimensions(), (400, 75));
            assert_eq!(input.get_pixel(375, 30).0, [0, 0, 0, 255]);
            Ok(vec![TextBox {
                text: "日本語".into(),
                bounds: [0., 0., 200., 30.],
                words: vec![TextBox {
                    text: "日".into(),
                    bounds: [0., 0., 30., 30.],
                    ..Default::default()
                }],
                ..Default::default()
            }])
        })
        .unwrap();
        assert_eq!(lines[0].bounds, [50., 150., 250., 180.]);
        assert_eq!(lines[0].words[0].bounds, [50., 150., 80., 180.]);
        let payload = pipeline::prepare(lines, "ja", 0., false, &p);
        assert!(
            (payload["data"][0]["bounding_rect"]["x1"].as_f64().unwrap() - 200. / 1920.).abs()
                < 1e-6
        );
        let restored = payload_lines(&payload, &p);
        assert!((restored[0].bounds[0] - 50.).abs() < 1e-6);
        assert!((restored[0].bounds[1] - 150.).abs() < 1e-6);
    }
    #[test]
    fn empty_focus_crop_reacquires_on_the_same_frame() {
        let image = RgbaImage::from_pixel(1000, 600, image::Rgba([17, 31, 53, 255]));
        let p = Projection {
            monitor: [0., 0., 1000., 600.],
            capture: [0., 0., 1000., 600.],
            image_size: (1000, 600),
        };
        let old = TextBox {
            text: "日本語の文章".into(),
            bounds: [100., 440., 350., 490.],
            ..Default::default()
        };
        let moved = TextBox {
            bounds: [100., 40., 350., 90.],
            ..old.clone()
        };
        let mut focus = Focus::default();
        focus.observe(&[old], image.dimensions(), "日本語の文章", 0., true);
        let mut calls = 0;
        let lines = recognize_frame(
            &image,
            &p,
            &json!({}),
            "日本語の文章",
            Some(&mut focus),
            0.1,
            |input| {
                calls += 1;
                if calls == 1 {
                    assert!(input.height() < 600);
                    Ok(vec![])
                } else {
                    assert_eq!(input.dimensions(), image.dimensions());
                    assert_eq!(input.get_pixel(500, 100), image.get_pixel(500, 100));
                    Ok(vec![moved.clone()])
                }
            },
        )
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(lines[0].bounds, moved.bounds);
        assert!(focus.region(image.dimensions(), 0.2).unwrap().top < 100);
    }
    #[test]
    fn area_outside_the_window_does_not_scan_an_unintended_region() {
        let image = RgbaImage::new(100, 100);
        let p = Projection {
            monitor: [0., 0., 100., 100.],
            capture: [0., 0., 100., 100.],
            image_size: (100, 100),
        };
        let config = json!({"settings":{"use_overlay_area_config":true},"areas":{"rectangles":[{"coordinates":[200,200,10,10],"is_excluded":false}]}});
        assert!(
            recognize_frame(&image, &p, &config, "", None, 0., |_| panic!(
                "outside selection must not OCR the full window"
            ))
            .unwrap()
            .is_empty()
        );
    }
    #[test]
    fn a_new_scan_interrupts_a_learned_delay() {
        let actor = actor();
        let generation = actor.command("overlay", json!({"action":"scan"})).unwrap()["generation"]
            .as_u64()
            .unwrap();
        let shared = actor.0.clone();
        let worker = std::thread::spawn(move || {
            wait_until(
                &shared,
                generation,
                Instant::now() + Duration::from_secs(10),
            )
        });
        actor.command("overlay", json!({"action":"scan"})).unwrap();
        assert!(!worker.join().unwrap());
    }
    /// Run explicitly against the separate fixture window, never in normal tests.
    #[test]
    #[ignore]
    fn benchmark_overlay_stages() {
        let config: Value = serde_json::from_slice(
            &std::fs::read(
                std::env::var("GSM_OVERLAY_BENCH_CONFIG").expect("Set GSM_OVERLAY_BENCH_CONFIG"),
            )
            .unwrap(),
        )
        .unwrap();
        let mut engines = Engines::new(std::path::Path::new(config["profile"].as_str().unwrap()));
        let mut capture_state = Capture::default();
        for sample in 0..10 {
            let start = Instant::now();
            let (mut image, projection) = capture(&config, false, &mut capture_state).unwrap();
            let captured = Instant::now();
            mask_areas(&mut image, &projection, &config);
            let masked = Instant::now();
            let result = engines.recognize(&image, "meikiocr", "ja").unwrap();
            let recognized = Instant::now();
            let payload = pipeline::prepare(result.lines, "ja", 0., false, &projection);
            let grouped = Instant::now();
            println!(
                "BENCH {}",
                json!({"sample":sample,"capture_ms":captured.duration_since(start).as_secs_f64()*1000.,"mask_ms":masked.duration_since(captured).as_secs_f64()*1000.,"ocr_ms":recognized.duration_since(masked).as_secs_f64()*1000.,"grouping_ms":grouped.duration_since(recognized).as_secs_f64()*1000.,"lines":payload["data"].as_array().unwrap().len(),"size":[image.width(),image.height()]})
            );
        }
        #[cfg(windows)]
        if let Some(control) = config["fixture_control"].as_str() {
            // A static screenshot cache would be fast but incorrect. Verify the
            // persistent session observes new pixels and recreates a resized pool.
            std::fs::write(control, r##"{"color":"#123456"}"##).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let (image, _) = capture(&config, false, &mut capture_state).unwrap();
                let pixel = image.get_pixel(image.width() - 30, image.height() - 30).0;
                if pixel[..3] == [0x12, 0x34, 0x56] {
                    break;
                }
                assert!(Instant::now() < deadline, "WGC must deliver fresh frames");
                std::thread::sleep(Duration::from_millis(20));
            }
            std::fs::write(control, r#"{"width":800,"height":440}"#).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let (image, _) = capture(&config, false, &mut capture_state).unwrap();
                if image.width() == 800 && image.height() == 440 {
                    break;
                }
                assert!(Instant::now() < deadline, "WGC must follow window resizing");
                std::thread::sleep(Duration::from_millis(20));
            }
            capture_state.clear();
            let (image, _) = capture(&config, false, &mut capture_state).unwrap();
            assert_eq!(
                image.dimensions(),
                (800, 440),
                "A released session can reopen"
            );
            let mut full_screen = config.clone();
            full_screen["settings"]["ocr_full_screen_instead_of_obs"] = json!(true);
            let (image, projection) = capture(&full_screen, false, &mut capture_state).unwrap();
            assert_eq!(image.width(), projection.monitor[2] as u32);
            assert_eq!(image.height(), projection.monitor[3] as u32);
            let (image, _) = capture(&config, false, &mut capture_state).unwrap();
            assert_eq!(
                image.dimensions(),
                (800, 440),
                "Switching targets replaces the capture session"
            );
            if let Some(stop) = config["fixture_stop"].as_str() {
                let id = config["target_id"].as_u64().unwrap();
                let window = xcap::Window::all()
                    .unwrap()
                    .into_iter()
                    .find(|w| w.id().unwrap() as u64 == id)
                    .unwrap();
                let expected = (window.width().unwrap(), window.height().unwrap());
                std::fs::write(stop, "stop").unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while capture_state
                    .grab(wgc::Target::Window(id), expected)
                    .is_ok()
                {
                    assert!(
                        Instant::now() < deadline,
                        "A closed target must not serve cached frames"
                    );
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            println!("WGC freshness, resize, reopen, target switch, and closure checks passed");
        }
    }
    #[test]
    fn stable_partial_typewriter_text_keeps_retrying_for_the_hooked_sentence() {
        let mut retry = Retry::new("日本語", 6, true);
        assert!(!retry.observe("日", 0., 0.1).finished);
        assert!(!retry.observe("日本", 0.2, 0.3).finished);
        assert!(!retry.observe("日本", 1.5, 1.6).finished);
        assert!(retry.observe("日本語", 1.7, 1.8).finished);
    }
    fn actor() -> Overlay {
        Overlay(Arc::new((Mutex::new(Inner::default()), Condvar::new())))
    }
    #[test]
    fn latest_scan_wins_and_invalidates_inflight_work() {
        let actor = actor();
        let first = actor
            .command("overlay", json!({"action":"scan","text":"old"}))
            .unwrap();
        let second = actor
            .command("overlay", json!({"action":"scan","text":"new"}))
            .unwrap();
        assert!(second["generation"].as_u64() > first["generation"].as_u64());
        assert_eq!(
            actor.0 .0.lock().unwrap().pending.as_ref().unwrap()["text"],
            "new"
        );
    }
    #[test]
    fn heartbeat_does_not_cancel_a_scan_and_background_is_not_overwritten() {
        let actor = actor();
        let config = json!({"available":true});
        actor
            .command("overlay", json!({"action":"configure","config":config}))
            .unwrap();
        actor
            .command("overlay", json!({"action":"background"}))
            .unwrap();
        let scan = actor
            .command("overlay", json!({"action":"scan","text":"new"}))
            .unwrap();
        let heartbeat = actor
            .command("overlay", json!({"action":"configure","config":config}))
            .unwrap();
        assert_eq!(scan, heartbeat);
        let state = actor.0 .0.lock().unwrap();
        assert!(state.background.is_some());
        assert!(state.pending.is_some());
    }
    #[test]
    fn stop_cancels_pending_work_and_reopening_does_not_inherit_pause() {
        let actor = actor();
        actor
            .command("overlay", json!({"action":"pause","paused":true}))
            .unwrap();
        actor.command("overlay", json!({"action":"stop"})).unwrap();
        actor.command("new", json!({"action":"configure"})).unwrap();
        let state = actor.0 .0.lock().unwrap();
        assert!(!state.paused);
        assert!(state.pending.is_none());
        assert_eq!(state.label, "new");
    }
    #[test]
    fn exclusions_apply_to_pixels_and_precomputed_words() {
        let p = Projection {
            monitor: [-100., 0., 100., 100.],
            capture: [-100., 0., 100., 100.],
            image_size: (100, 100),
        };
        let config = json!({"settings":{"use_overlay_area_config":true},"areas":{"coordinate_system":"percentage","overlay_coordinate_space":"monitor","rectangles":[{"is_excluded":true,"coordinates":[0.,0.,0.5,1.]}]}});
        let mut image = RgbaImage::from_pixel(100, 100, image::Rgba([255, 255, 255, 255]));
        mask_areas(&mut image, &p, &config);
        assert_eq!(image.get_pixel(10, 10).0, [0, 0, 0, 255]);
        assert_eq!(image.get_pixel(60, 10).0, [255, 255, 255, 255]);
        let mut lines = vec![
            TextBox {
                text: "hidden".into(),
                bounds: [0., 0., 20., 20.],
                ..Default::default()
            },
            TextBox {
                text: "shown".into(),
                bounds: [60., 0., 80., 20.],
                ..Default::default()
            },
        ];
        filter_areas(&mut lines, &p, &config);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "shown");
    }
}
