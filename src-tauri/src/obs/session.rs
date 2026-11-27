use super::{
    scenes::selector_parts,
    session_profile::Profiles,
    session_target::{self, Selector, Target},
    text, Obs,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::{watch, Notify};

const OUTPUT_PROBE_SIZE: (u32, u32) = (192, 108);
const OUTPUT_PROBE_INTERVAL: Duration = Duration::from_secs(1);
const OUTPUT_BLANK_GRACE: Duration = Duration::from_secs(15);

#[derive(Default)]
struct SceneOutputProbe {
    last_sample: Option<Instant>,
    blank_since: Option<Instant>,
    active: Option<bool>,
}

impl SceneOutputProbe {
    fn due(&self, now: Instant) -> bool {
        self.last_sample
            .is_none_or(|last| now.duration_since(last) >= OUTPUT_PROBE_INTERVAL)
    }

    fn record(&mut self, visible: Option<bool>, now: Instant) {
        self.last_sample = Some(now);
        if visible == Some(false) {
            // Keep a previously usable capture available through a fade to black.
            if now.duration_since(*self.blank_since.get_or_insert(now)) >= OUTPUT_BLANK_GRACE {
                self.active = Some(false);
            }
        } else {
            self.blank_since = None;
            self.active = visible;
        }
    }
}

fn empty(scene: &str, id: &str) -> Value {
    json!({"scene":scene,"scene_id":id,"capture_source":scene,"capture_kind":"window","source_name":"",
        "window_info":null,"target_id":null,"target_pid":null,"process_path":scene,"available":false,"obs_fallback_available":false,"active":null})
}

#[derive(Default)]
struct Control {
    generation: u64,
    connection: Option<String>,
    replay_active: Option<bool>,
    recording: Option<bool>,
    directory: Option<String>,
    replay_seconds: Option<u32>,
    profiles: Profiles,
    #[cfg(windows)]
    smoke_fixture: bool,
}

pub(super) struct Session {
    control: Mutex<Control>,
    state: watch::Sender<Value>,
    recycled: watch::Sender<crate::recycled_lines::Context>,
    wake: Notify,
    #[cfg(windows)]
    pub(super) window_hooks: std::sync::atomic::AtomicBool,
    pub(super) window_dirty: Notify,
}

impl Default for Session {
    fn default() -> Self {
        let mut state = empty("", "");
        state["revision"] = json!(0);
        state["scene_epoch"] = json!(0);
        state["profile"] = Value::Null;
        state["choices"] = json!([]);
        Self {
            control: Mutex::new(Control::default()),
            state: watch::channel(state).0,
            recycled: watch::channel(Default::default()).0,
            wake: Notify::new(),
            #[cfg(windows)]
            window_hooks: Default::default(),
            window_dirty: Notify::new(),
        }
    }
}

impl Session {
    pub(super) fn has_window_hooks(&self) -> bool {
        #[cfg(windows)]
        {
            self.window_hooks.load(std::sync::atomic::Ordering::Relaxed)
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
    pub(super) fn with_state<T>(&self, read: impl FnOnce(&Value) -> T) -> T {
        read(&self.state.borrow())
    }
    pub(super) fn is_connection(&self, id: &str) -> bool {
        self.control.lock().unwrap().connection.as_deref() == Some(id)
    }
    pub(super) fn connection(&self, id: Option<&str>, active: Option<bool>) {
        let mut control = self.control.lock().unwrap();
        if control.connection.as_deref() != id {
            control.directory = None;
            control.replay_seconds = None;
            control.recording = None;
        }
        control.connection = id.map(str::to_owned);
        control.replay_active = active;
        let state = self.state.borrow().clone();
        self.publish(state, &control);
    }
    pub(super) fn record_state(&self, id: &str, active: bool, initial: bool) -> bool {
        let mut control = self.control.lock().unwrap();
        if control.connection.as_deref() != Some(id)
            || (initial && control.recording.is_some())
            || control.recording == Some(active)
        {
            return false;
        }
        control.recording = Some(active);
        let state = self.state.borrow().clone();
        self.publish(state, &control);
        true
    }
    pub(super) fn media_settings(&self, id: &str, directory: Option<String>, seconds: Option<u32>) {
        let mut control = self.control.lock().unwrap();
        if control.connection.as_deref() != Some(id) {
            return;
        }
        if let Some(d) = directory {
            control.directory = Some(d);
        }
        if let Some(s) = seconds {
            control.replay_seconds = Some(s);
        }
        let state = self.state.borrow().clone();
        self.publish(state, &control);
    }
    fn publish(&self, mut next: Value, control: &Control) -> bool {
        self.recycled.send_if_modified(|context| {
            context.update(
                text(&next, "scene"),
                &control.profiles.name,
                control.profiles.recycled_lines,
            )
        });
        self.state.send_if_modified(|old| {
            let changed = next["scene"] != old["scene"] || next["scene_id"] != old["scene_id"];
            next["revision"] = old["revision"].clone();
            next["connected"] = json!(control.connection.is_some());
            next["connection"] = json!(control.connection);
            next["replay_active"] = json!(control.replay_active);
            next["record_active"] = json!(control.recording);
            next["record_directory"] = json!(control.directory);
            next["replay_seconds"] = json!(control.replay_seconds);
            next["scene_epoch"] =
                json!(old["scene_epoch"].as_u64().unwrap_or(0) + u64::from(changed));
            next["profile"] = json!(control.profiles.name);
            next["choices"] = if changed {
                json!([])
            } else {
                json!(control.profiles.choices)
            };
            if *old == next {
                return false;
            }
            next["revision"] = json!(old["revision"].as_u64().unwrap_or(0) + 1);
            *old = next;
            true
        })
    }
    pub(super) fn invalidate(&self, scene: Option<(&str, &str)>) {
        let mut control = self.control.lock().unwrap();
        #[cfg(windows)]
        if control.smoke_fixture {
            return;
        }
        control.generation += 1;
        let old = self.state.borrow().clone();
        let (name, id) = scene.unwrap_or((text(&old, "scene"), text(&old, "scene_id")));
        self.publish(empty(name, id), &control);
        self.wake.notify_one();
    }
}

#[derive(Debug, PartialEq)]
struct Source {
    scene: String,
    id: String,
    name: String,
    selector: Option<Selector>,
    browser_source: bool,
    inspected: bool,
}

fn selector(settings: &Value) -> Option<Selector> {
    if let Some(raw) = settings["capture_window"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        let mut fields = raw.split('\n').map(str::trim);
        return Some(Selector {
            window_id: fields.next()?.parse().ok(),
            title: fields.next().unwrap_or("").into(),
            window_class: fields.next().unwrap_or("").into(),
            exe: String::new(),
        });
    }
    let raw = settings["window"]
        .as_str()
        .filter(|s| s.matches(':').count() >= 2)?;
    if settings["capture_mode"]
        .as_str()
        .is_some_and(|s| s != "window")
    {
        return None;
    }
    let (title, window_class, exe) = selector_parts(raw);
    if title.trim().is_empty() && window_class.trim().is_empty() && exe.trim().is_empty() {
        return None;
    }
    Some(Selector {
        title: title.trim().into(),
        window_class: window_class.trim().into(),
        exe: exe.trim().into(),
        window_id: None,
    })
}

fn visual(item: &Value) -> bool {
    let kind = text(item, "inputKind");
    item["sceneItemEnabled"] != false
        && !kind.contains("audio")
        && !kind.starts_with("wasapi_")
        && !kind.starts_with("pulse_")
        && !kind.starts_with("alsa_")
        && !kind.starts_with("coreaudio_")
}

fn nonblank(data: &Value) -> Option<bool> {
    let raw = data.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.split_once(',').map_or(raw, |(_, encoded)| encoded))
        .ok()?;
    let image = image::load_from_memory(&bytes).ok()?.into_rgb8();
    Some(nonblank_pixels(&image, 1))
}

pub(super) fn nonblank_pixels(image: &image::RgbImage, step: usize) -> bool {
    let mut lo = [255u8; 3];
    let mut hi = [0u8; 3];
    for row in image.rows().step_by(step) {
        for pixel in row.step_by(step) {
            for c in 0..3 {
                lo[c] = lo[c].min(pixel[c]);
                hi[c] = hi[c].max(pixel[c]);
            }
        }
        let range = (0..3).map(|i| hi[i].saturating_sub(lo[i])).max().unwrap();
        if range > 5 && (range > 15 || *hi.iter().max().unwrap() > 30) {
            return true;
        }
    }
    false
}

impl Obs {
    pub(super) async fn scene_has_visible_output(
        &self,
        app: &tauri::AppHandle,
        scene: &str,
    ) -> Option<bool> {
        let (width, height) = OUTPUT_PROBE_SIZE;
        let data = self.screenshot(app, scene, width, height, "png").await.ok()?;
        nonblank(&data)
    }

    #[cfg(windows)]
    pub(crate) fn set_smoke_target(&self, scene: &str, hwnd: u64) {
        let session = &self.0.session;
        let mut control = session.control.lock().unwrap();
        control.smoke_fixture = true;
        let mut state = empty(scene, "smoke");
        state["available"] = json!(true);
        state["active"] = json!(true);
        state["target_id"] = json!(hwnd);
        state["target_pid"] = json!(std::process::id());
        session.publish(state, &control);
    }

    pub fn recycled_context(&self) -> watch::Receiver<crate::recycled_lines::Context> {
        self.0.session.recycled.subscribe()
    }

    pub fn game_session(&self) -> Value {
        self.0.session.state.borrow().clone()
    }
    pub(crate) fn subscribe_game_session(&self) -> watch::Receiver<Value> {
        self.0.session.state.subscribe()
    }
    pub fn refresh_session(&self) {
        self.0.session.wake.notify_one();
    }
    pub async fn wait_game_session(&self, after: Option<u64>) -> Value {
        let mut rx = self.0.session.state.subscribe();
        if after.is_some() && rx.borrow_and_update()["revision"].as_u64() == after {
            let _ = tokio::time::timeout(Duration::from_secs(8), rx.changed()).await;
        }
        let state = rx.borrow().clone();
        state
    }
    pub fn select_game_profile(&self, name: &str, epoch: Option<u64>) -> Result<Value, String> {
        let path = self.paths()?.base.join("config.json");
        let session = &self.0.session;
        let mut control = session.control.lock().unwrap();
        let state = self.game_session();
        if epoch.is_some()
            && (epoch != state["scene_epoch"].as_u64()
                || !state["choices"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == name)))
        {
            return Err("Scene changed before profile selection completed".into());
        }
        control
            .profiles
            .reconcile(&path, text(&state, "scene"), text(&state,"scene_id"), Some((name, epoch.is_none())))?;
        session.publish(state, &control);
        session.wake.notify_one();
        Ok(self.game_session())
    }
    async fn session_source(&self, app: &tauri::AppHandle) -> Result<Source, String> {
        let scene = self.current_scene(app).await?;
        let name = text(&scene, "name");
        let id = text(&scene, "id");
        if name.is_empty() {
            return Err("OBS has no program scene".into());
        }
        let mut source = Source {
            scene: name.into(),
            id: id.into(),
            name: String::new(),
            selector: None,
            browser_source: false,
            inspected: false,
        };
        let scene_selector = if id.is_empty() {
            json!({"sceneName":name})
        } else {
            json!({"sceneUuid":id})
        };
        let Ok(items) = self.items_by_selector(app, scene_selector.clone()).await else {
            return Ok(source);
        };
        let is_helper = |item: &Value| super::scenes::helper_source(name, text(item, "sourceName"));
        for item in items
            .iter()
            .filter(|item| is_helper(item) && item["sceneItemEnabled"] == true)
        {
            // A temporary device probe may be using the helper scene this tick.
            let Ok(_probe) = self.0.probe.try_lock() else {
                break;
            };
            let mut request = scene_selector.clone();
            request["sceneItemId"] = item["sceneItemId"].clone();
            request["sceneItemEnabled"] = json!(false);
            self.call(app, "SetSceneItemEnabled", request).await?;
        }
        let mut sources = items
            .iter()
            .filter(|i| visual(i) && !is_helper(i))
            .collect::<Vec<_>>();
        sources.sort_by_key(|i| match text(i, "inputKind") {
            "game_capture" => 0,
            "window_capture" | "xcomposite_input" => 1,
            "monitor_capture" | "dshow_input" => 2,
            _ => 3,
        });
        for item in sources {
            let name = text(item, "sourceName");
            if source.name.is_empty() {
                source.name = name.into();
                source.browser_source = text(item, "inputKind") == "browser_source";
            }
            if matches!(
                text(item, "inputKind"),
                "game_capture" | "window_capture" | "xcomposite_input"
            ) {
                let Ok(settings) = self.input_settings(app, item).await else {
                    return Ok(source);
                };
                if let Some(target) = selector(&settings) {
                    source.name = name.into();
                    source.browser_source = target.is_browser_source();
                    source.selector = Some(target);
                    break;
                }
            }
        }
        source.inspected = true;
        Ok(source)
    }

    pub(super) async fn sample_session(self, app: tauri::AppHandle) {
        let session = &self.0.session;
        let (settings_tx, settings_rx) = watch::channel(None);
        tauri::async_runtime::spawn(self.clone().apply_settings(app.clone(), settings_rx));
        let path = self
            .paths()
            .expect("initialized OBS")
            .base
            .join("config.json");
        let mut source: Option<Source> = None;
        let mut generation = None;
        let mut last_epoch = None;
        let mut refreshed = Instant::now();
        let mut target: Option<Target> = None;
        let mut tracked = false;
        let mut output_probe = SceneOutputProbe::default();
        let mut fit_scene = None;
        let mut dictionary_scene = String::new();
        let mut fit_at = None;
        #[cfg(windows)]
        let mut window_state = super::window_state::Sampler::default();
        #[cfg(windows)]
        let mut audio = super::game_audio::Monitor::default();
        #[cfg(windows)]
        let mut displays = super::window_state::Displays::default();
        loop {
            let (current, epoch) = {
                let control = session.control.lock().unwrap();
                (
                    control.generation,
                    session.state.borrow()["scene_epoch"].as_u64(),
                )
            };
            let connection = self.0.client.primary_id();
            let connected = connection.is_some();
            if generation != Some(current)
                || refreshed.elapsed() > Duration::from_secs(10)
                || source.as_ref().is_none_or(|s| !s.inspected)
                || !connected
            {
                let next = if connected {
                    self.session_source(&app).await.ok()
                } else {
                    None
                };
                if source != next || epoch != last_epoch {
                    target = None;
                    tracked = false;
                    output_probe = SceneOutputProbe::default();
                }
                source = next;
                generation = Some(current);
                refreshed = Instant::now();
            }
            let mut state = empty("", "");
            if let Some(s) = source.as_ref() {
                state = empty(&s.scene, &s.id);
                state["source_name"] = json!(s.name);
                state["browser_source"] = json!(s.browser_source);
                if let Some(window) = s.selector.as_ref() {
                    let selector = window.clone();
                    let previous = target.take();
                    target = tokio::task::spawn_blocking(move || {
                        session_target::resolve(&selector, previous.as_ref())
                    })
                    .await
                    .ok()
                    .flatten();
                    let mut info = json!(window);
                    info["source_name"] = json!(s.name);
                    state["window_info"] = info;
                    if let Some(t) = &target {
                        tracked = true;
                        state["target_id"] = json!(t.id);
                        state["target_pid"] = json!(t.pid);
                        state["available"] = json!(t.visible);
                        state["active"] = json!(true);
                        state["process_path"] = json!(t.path);
                        #[cfg(windows)]
                        {
                            let frame = window_state.sample(t, &window.title, displays.bounds());
                            state["window_inactive"] = json!(matches!(
                                frame["data"].as_str(),
                                Some("minimized" | "obscured" | "background")
                            ));
                            state["window_state"] = frame;
                        }
                    } else if tracked {
                        state["active"] = json!(false);
                    }
                } else if s.inspected {
                    state["capture_kind"] = json!("obs");
                }
                if s.inspected && s.name.is_empty() {
                    state["active"] = json!(false);
                } else if s.inspected && state["active"].is_null() {
                    if output_probe.due(Instant::now()) {
                        let visible = self.scene_has_visible_output(&app, &s.scene).await;
                        output_probe.record(visible, Instant::now());
                    }
                    state["active"] = json!(output_probe.active);
                    if output_probe.active == Some(true) {
                        state["available"] = json!(s.selector.is_none());
                        state["obs_fallback_available"] = json!(s.selector.is_some());
                    }
                }
            }
            #[cfg(windows)]
            {
                state["displays"] = json!(displays.bounds());
            }
            if state["window_state"].is_null() {
                let available =
                    state["available"] == true || state["obs_fallback_available"] == true;
                let status = if available {
                    "background"
                } else if tracked || !connected || state["active"] == false {
                    "closed"
                } else {
                    "unknown"
                };
                state["window_state"] = json!({"type":"window_state","data":status,"game":state["scene"],"target_hwnd":state["target_id"],"magpie_info":null,
                    "target_window_rect":null,"target_client_rect":null,"occlusion_rects":[],"is_fullscreen":false,"is_exclusive_fullscreen":false,
                    "recommend_manual_mode":false,"obs_output_active":available});
            }
            #[cfg(windows)]
            let audio_target;
            let (changed, profile_changed) = {
                let mut control = session.control.lock().unwrap();
                #[cfg(windows)]
                if control.smoke_fixture {
                    return;
                }
                if control.generation != current || connection != self.0.client.primary_id() {
                    continue;
                }
                let previous_profile = control.profiles.name.clone();
                let _ = control
                    .profiles
                    .reconcile(&path, text(&state, "scene"), text(&state,"scene_id"), None);
                let desired = control.connection.clone().zip(control.profiles.settings);
                settings_tx.send_if_modified(|previous| {
                    if *previous == desired {
                        return false;
                    }
                    *previous = desired;
                    true
                });
                let changed = session.with_state(|old| {
                    ["scene", "scene_id", "active", "target_pid"]
                        .iter()
                        .any(|key| old[*key] != state[*key])
                });
                #[cfg(windows)]
                {
                    let identity = target.as_ref()
                        .filter(|t| connected && t.pid > 1 && t.pid != std::process::id())
                        .map(|t| (t.id, t.pid));
                    audio_target = audio.policy.desired(identity, text(&state["window_state"], "data"),
                        control.profiles.audio, Instant::now());
                }
                session.publish(state, &control);
                last_epoch = session.state.borrow()["scene_epoch"].as_u64();
                (changed, previous_profile != control.profiles.name)
            };
            #[cfg(windows)]
            audio.update(&app, audio_target).await;
            if changed || profile_changed {
                crate::auto_launcher::notify_signal(&app);
            }
            let scene_name = source.as_ref().map_or("", |source| source.scene.as_str());
            if scene_name != dictionary_scene {
                dictionary_scene.clear();
                dictionary_scene.push_str(scene_name);
                crate::game_metadata::dictionary::queue(
                    &app, crate::game_metadata::dictionary::Selection::Scene(scene_name),
                );
            }
            if let Some(host) = tauri::Manager::try_state::<crate::overlay_host::OverlayHost>(&app) {
                if host.is_running() {
                    host.present_session(&app, &self.game_session()).await;
                }
            }
            if profile_changed {
                crate::mining_settings::changed(&app).await;
            }
            self.manage_replay(&app).await;
            let scene = source.as_ref().filter(|s| !s.id.is_empty()).map(|s| &s.id);
            if fit_scene.as_ref() != scene {
                fit_scene = scene.cloned();
                fit_at = scene.map(|_| Instant::now() + Duration::from_secs(2));
            }
            if fit_at.is_some_and(|at| Instant::now() >= at) {
                fit_at = None;
                if let Some(scene) = &fit_scene {
                    if let Err(error) = self.fit(&app, scene).await {
                        crate::desktop_log::warn(&app, "obs", error);
                    }
                }
            }
            tokio::select! {
                _=session.wake.notified()=>{},
                _=session.window_dirty.notified(), if target.is_some()=>{
                    tokio::time::sleep(Duration::from_millis(65)).await;
                },
                _=tokio::time::sleep(Duration::from_secs(1))=>{}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_scene_thumbnail_retains_small_bottom_text_and_corner_sprites() {
        use image::{imageops, Rgb, RgbImage};

        let mut dialogue = RgbImage::new(1920, 1080);
        // A single small 日 near the bottom of an otherwise black 1080p scene.
        for y in 0..24 {
            for x in 0..18 {
                if x < 2 || x >= 16 || y < 2 || y >= 22 || (11..13).contains(&y) {
                    dialogue.put_pixel(127 + x, 997 + y, Rgb([225; 3]));
                }
            }
        }
        let mut sprite = RgbImage::new(1920, 1080);
        imageops::replace(&mut sprite, &RgbImage::from_pixel(24, 32, Rgb([32, 64, 95])), 1891, 7);

        for scene in [dialogue, sprite] {
            let (w, h) = OUTPUT_PROBE_SIZE;
            let thumbnail = imageops::resize(&scene, w, h, imageops::FilterType::Triangle);
            let old = imageops::resize(&scene, 8, 8, imageops::FilterType::Triangle);
            assert!(!nonblank_pixels(&old, 1));

            let mut png = std::io::Cursor::new(Vec::new());
            thumbnail.write_to(&mut png, image::ImageFormat::Png).unwrap();
            let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
            assert_eq!(nonblank(&json!(format!("data:image/png;base64,{encoded}"))), Some(true));
        }
        let (w, h) = OUTPUT_PROBE_SIZE;
        let near_black = RgbImage::from_fn(w, h, |x, y| Rgb([((x + y) % 5) as u8; 3]));
        assert!(!nonblank_pixels(&RgbImage::new(w, h), 1));
        assert!(!nonblank_pixels(&near_black, 1));
        assert_eq!(nonblank(&json!("invalid")), None);
    }

    #[test]
    fn output_probe_limits_requests_and_keeps_capture_through_brief_blackouts() {
        let start = Instant::now();
        let at = |seconds| start + Duration::from_secs(seconds);
        let mut probe = SceneOutputProbe::default();
        assert!(probe.due(start));
        probe.record(Some(false), start);
        assert_eq!(probe.active, None);
        assert!(!probe.due(start + Duration::from_millis(999)));
        assert!(probe.due(at(1)));

        probe.record(Some(true), at(1));
        probe.record(Some(false), at(2));
        probe.record(Some(false), at(16));
        assert_eq!(probe.active, Some(true));
        probe.record(Some(true), at(17));
        probe.record(Some(false), at(18));
        probe.record(Some(false), at(32));
        assert_eq!(probe.active, Some(true));
        probe.record(Some(false), at(33));
        assert_eq!(probe.active, Some(false));
        probe.record(Some(true), at(34));
        assert_eq!(probe.active, Some(true));

        probe.record(Some(false), at(35));
        probe.record(None, at(49));
        probe.record(Some(false), at(50));
        assert_eq!(probe.active, None);
    }

    #[test]
    fn parses_obs_selectors_and_ignores_disabled_or_audio_sources() {
        let target = selector(&json!({"window":"Game#3A#22:Class:Game.exe"})).unwrap();
        assert_eq!(target.title, "Game:#");
        assert!(
            selector(&json!({"capture_mode":"any_fullscreen","window":"Game:Class:game.exe"}))
                .is_none()
        );
        let linux = selector(&json!({"capture_window":"10\r\n\r\nSDL"})).unwrap();
        assert_eq!(
            (
                linux.window_id,
                linux.title.as_str(),
                linux.window_class.as_str()
            ),
            (Some(10), "", "SDL")
        );
        assert!(!visual(
            &json!({"inputKind":"monitor_capture","sceneItemEnabled":false})
        ));
        assert!(!visual(
            &json!({"inputKind":"wasapi_process_output_capture"})
        ));
    }
    #[tokio::test]
    async fn disconnect_clears_target_wakes_readers_and_expires_profile_choices() {
        let obs = Obs::default();
        let s = &obs.0.session;
        let mut state = empty("Game", "a");
        state["target_id"] = json!(17);
        state["active"] = json!(true);
        s.publish(state, &s.control.lock().unwrap());
        let revision = obs.game_session()["revision"].as_u64();
        s.invalidate(Some(("", "")));
        let next = obs.wait_game_session(revision).await;
        assert_eq!(next["scene"], "");
        assert!(next["target_id"].is_null() && next["active"].is_null());
        assert_eq!(next["scene_epoch"], 2);
        assert!(next["choices"].as_array().unwrap().is_empty());
    }
}
