//! Native Rust Overlay Host: owns overlay windows, settings, hotkeys, Magpie tracking,
//! AFK/Pomodoro timers, Jiten/Local Vocabulary caches, VN-Guide controller,
//! WebSocket gateway (`/ws/overlay` + `/get_websocket_port` failover), and `gsm_overlay_server` sync.
//!
//! Replaces `GSM_Overlay/main.js` and `GSM_Overlay/backend_connector.js` completely, eliminating
//! Node.js subprocesses and Electron BrowserWindows from the overlay pipeline.

use crate::desktop_state::{self, DesktopState};
use crate::dictionary_host::{self, overlay_data_path, overlay_resources_root, DictionaryManager};
use crate::overlay_jiten::{derive_jiten_api_base, local_vocabulary_ws_request, JitenParseCache};
use crate::overlay_magpie::{
    collect_displays, cursor_captured, is_window_above, magpie_info_to_renderer_json,
    project_magpie_cursor, read_native_magpie_info, register_magpie_scaling_message,
    renderer_signature, sample_pointer, select_target_display, source_focused, DisplayInfo,
    MagpieInfo,
};
use crate::overlay_preload::{
    overlay_main_init_script, overlay_settings_init_script, overlay_simple_ipc_init_script,
    overlay_vn_guide_hud_init_script,
};
use crate::overlay_settings::{
    apply_backend_profile_state, apply_gsm_owned_config_update, backend_profile_name,
    build_profile_snapshot, default_user_settings_map, is_modifier_only_hotkey, is_mouse_hotkey,
    load_settings_from_disk, normalize_user_settings, overlay_key_to_gsm_field,
    overlay_profile_state, record_guide_scene, resolve_hotkey_conflicts, restore_active_profile,
    save_settings_atomic, select_guide_scene, to_tauri_accelerator, DEFAULT_GSM_PROFILE_NAME,
    GLOBAL_HOTKEY_KEYS, OVERLAY_ACTIVE_PROFILE_KEY, OVERLAY_PROFILE_SETTINGS_KEY,
    OVERLAY_SETTINGS_PROFILES_ENABLED_KEY, VN_GUIDE_SCENE_SETTING_KEYS,
};
use crate::overlay_vn_guide::{
    compute_vn_guide_hud_bounds, normalize_custom_page_url, parse_guide_url,
    validated_catalogue_source, GuideStore, VnGuideController,
};
use crate::{input_server, tray, window_platform};
use futures_util::{SinkExt, StreamExt};
use gsm_settings::gsm_config::get_configured_single_port;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub const OVERLAY_MAIN_LABEL: &str = "gsm-overlay-main";
pub const OVERLAY_SETTINGS_LABEL: &str = "gsm-overlay-settings";
pub const OVERLAY_OFFSET_LABEL: &str = "gsm-overlay-offset";
pub const OVERLAY_STARTUP_LABEL: &str = "gsm-overlay-startup";
pub const OVERLAY_REC_MANUAL_LABEL: &str = "gsm-overlay-rec-manual";
pub const OVERLAY_REC_FS_LABEL: &str = "gsm-overlay-rec-fs";
pub const OVERLAY_TEXTHOOKER_LABEL: &str = "gsm-overlay-texthooker";
pub const OVERLAY_VN_GUIDE_LABEL: &str = "gsm-overlay-vn-guide";
pub const OVERLAY_CUSTOM_PAGE_LABEL: &str = "gsm-custom-page";

const OVERLAY_ASSET_PREFIX: &str = "overlay";
const HOTKEY_COOLDOWN: Duration = Duration::from_millis(250);
// External companion pages can only dismiss their own window. No desktop token
// or general GSM IPC bridge is exposed to the page or to its frames.
const AUX_WINDOW_SCRIPT: &str = r#"(() => {
    if (window.top !== window) return;
    window.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            window.__TAURI_INTERNALS__?.invoke('overlay_aux_hide').catch(() => {});
        } else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); history.back(); }
        else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); history.forward(); }
        else if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) { event.preventDefault(); location.reload(); }
    }, true);
})();"#;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn normalize_external_http_url(raw: &str) -> Result<String, String> {
    if raw.chars().any(char::is_control) {
        return Err("Invalid external link.".into());
    }
    let url = url::Url::parse(raw.trim()).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP(S) links without credentials can be opened.".into());
    }
    Ok(url.into())
}

fn generate_window_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub fn effective_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn resolve_effective_platform(settings: &Map<String, Value>) -> String {
    if let Some(ov) = settings
        .get("platformOverride")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| matches!(*s, "win32" | "linux" | "darwin"))
    {
        return ov.to_string();
    }
    effective_platform().to_string()
}

fn resolve_gamepad_port(settings: &Map<String, Value>, app: Option<&AppHandle>) -> u16 {
    if let Some(app) = app {
        if let Some(p) = input_server::port(app) {
            return p;
        }
    }
    settings
        .get("gamepadServerPort")
        .and_then(Value::as_u64)
        .and_then(|v| u16::try_from(v).ok())
        .filter(|&p| p > 0)
        .unwrap_or(7276)
}

#[derive(Clone, Debug, Default)]
struct ManualHotkeyMachine {
    key_down: bool,
    hold_active: bool,
    toggle_latched: bool,
    last_signal_at: Option<Instant>,
}

impl ManualHotkeyMachine {
    #[cfg(test)]
    fn is_active(&self, toggle_mode: bool) -> bool {
        if toggle_mode {
            self.toggle_latched
        } else {
            self.hold_active
        }
    }

    /// Returns `Some(true)` when overlay manual mode activates, `Some(false)` when deactivated.
    fn handle_press(&mut self, toggle_mode: bool) -> Option<bool> {
        if self.key_down {
            return None;
        }
        self.key_down = true;
        if toggle_mode {
            self.toggle_latched = !self.toggle_latched;
            Some(self.toggle_latched)
        } else if !self.hold_active {
            self.hold_active = true;
            Some(true)
        } else {
            None
        }
    }

    fn handle_release(&mut self, toggle_mode: bool) -> Option<bool> {
        if !self.key_down && !self.hold_active {
            return None;
        }
        self.key_down = false;
        self.last_signal_at = None;
        if toggle_mode {
            None
        } else if self.hold_active {
            self.hold_active = false;
            Some(false)
        } else {
            None
        }
    }

    fn handle_tauri_shortcut_signal(&mut self, toggle_mode: bool, pressed: bool) -> Option<bool> {
        if pressed {
            self.last_signal_at = Some(Instant::now());
            self.handle_press(toggle_mode)
        } else {
            self.handle_release(toggle_mode)
        }
    }

    fn reset(&mut self) -> bool {
        let was_active = self.hold_active || self.toggle_latched;
        self.key_down = false;
        self.hold_active = false;
        self.toggle_latched = false;
        self.last_signal_at = None;
        was_active
    }
}

#[derive(Clone, Debug, Default)]
struct PomodoroState {
    enabled: bool,
    mode: String,
    active: bool,
    remaining_secs: i64,
    started: bool,
    last_tick: Option<Instant>,
}

impl PomodoroState {
    fn tick(&mut self, now: Instant, work_secs: i64, break_secs: i64) -> bool {
        if !self.enabled || !self.active {
            self.last_tick = None;
            return false;
        }
        let Some(last) = self.last_tick else {
            self.last_tick = Some(now);
            return false;
        };
        let elapsed = now.saturating_duration_since(last).as_secs() as i64;
        if elapsed == 0 {
            return false;
        }
        self.last_tick = Some(last + Duration::from_secs(elapsed as u64));
        self.remaining_secs -= elapsed;
        while self.remaining_secs <= 0 {
            self.mode = if self.mode == "work" { "break" } else { "work" }.into();
            self.remaining_secs += if self.mode == "work" {
                work_secs.max(1)
            } else {
                break_secs.max(1)
            };
        }
        true
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, Default)]
struct GameWindowState {
    state: String,
    game: Option<String>,
    pid: Option<u32>,
    fullscreen: bool,
}

#[derive(Clone, Debug)]
enum Ws2Outbound {
    CoalescedConfig(Value),
    CoalescedMagpie(Value),
    Direct(Value),
}

fn merge_config_message(pending: &mut Option<Value>, update: Value) {
    let message =
        pending.get_or_insert_with(|| json!({"type":"set-gsm-overlay-config", "settings":{}}));
    if let Some(fields) = update["settings"].as_object() {
        message["settings"]
            .as_object_mut()
            .unwrap()
            .extend(fields.clone());
    }
}

struct OverlayInner {
    running: bool,
    manually_disabled: bool,
    pending_settings_tab: Option<String>,
    pending_config: Map<String, Value>,
    capture_available: Option<bool>,
    resize_mode: bool,
    navigation_active: bool,
    translation_requested: bool,
    backend_config: Value,
    pause_sources: std::collections::HashSet<String>,
    manual_focus_deadline: Option<Instant>,
    goals_available: bool,
    last_text_payload: Value,
    shown_recommendations: std::collections::HashSet<String>,
    started_at_ms: Option<u64>,
    source: String,
    worker_gen: u64,
    overlay_data_dir: PathBuf,
    overlay_resources_dir: PathBuf,
    single_port: u16,
    user_settings: Map<String, Value>,
    profile_state: Value,
    displays: Vec<DisplayInfo>,
    selected_display_index: usize,
    manual_hotkey: ManualHotkeyMachine,
    hotkey_suppressed_for_input_test: bool,
    registered_tauri_accelerators: HashMap<String, String>,
    shortcut_cooldowns: HashMap<String, Instant>,
    manual_hotkey_backend: String,
    manual_hotkey_backend_reason: String,
    keyboard_available: bool,
    keyboard_error: Option<String>,
    yomitan_showing: bool,
    lookup_focus_owned: bool,
    startup_hidden: bool,
    pinned: bool,
    text_hover_ignoring: Option<bool>,
    is_afk: bool,
    last_ocr_activity: Instant,
    magpie_info: Option<MagpieInfo>,
    magpie_scaling_msg: u32,
    magpie_pointer_seq: u64,
    magpie_pointer_pending: Option<(u64, Instant)>,
    magpie_hovering: bool,
    pomodoro: PomodoroState,
    ws2_connected: bool,
    ws1_connected: bool,
    input_server_connected: bool,
    game_state: GameWindowState,
    target_hwnd: Option<u64>,
    last_window_state: Option<Value>,
    vn_guide_available: bool,
    vn_guide_scene: Option<String>,
    custom_page_saved_urls: HashMap<String, String>,
    main_box_shown: bool,
    ws2_tx: Option<mpsc::UnboundedSender<Ws2Outbound>>,
    input_tx: Option<mpsc::UnboundedSender<Value>>,
    active_window_tokens: Vec<String>,
}

impl Default for OverlayInner {
    fn default() -> Self {
        Self {
            running: false,
            manually_disabled: false,
            pending_settings_tab: None,
            pending_config: Map::new(),
            capture_available: None,
            resize_mode: false,
            navigation_active: false,
            translation_requested: false,
            backend_config: Value::Null,
            pause_sources: Default::default(),
            manual_focus_deadline: None,
            goals_available: false,
            last_text_payload: Value::Null,
            shown_recommendations: Default::default(),
            started_at_ms: None,
            source: "manual".into(),
            worker_gen: 0,
            overlay_data_dir: PathBuf::new(),
            overlay_resources_dir: PathBuf::new(),
            single_port: 7275,
            user_settings: default_user_settings_map(),
            profile_state: json!({
                "enabled": false,
                "activeProfileName": "Default",
                "currentGSMProfileName": "Default",
                "profiles": []
            }),
            displays: Vec::new(),
            selected_display_index: 0,
            manual_hotkey: ManualHotkeyMachine::default(),
            hotkey_suppressed_for_input_test: false,
            registered_tauri_accelerators: HashMap::new(),
            shortcut_cooldowns: HashMap::new(),
            manual_hotkey_backend: "input_server".into(),
            manual_hotkey_backend_reason: "idle".into(),
            keyboard_available: true,
            keyboard_error: None,
            yomitan_showing: false,
            lookup_focus_owned: false,
            startup_hidden: false,
            pinned: false,
            text_hover_ignoring: None,
            is_afk: false,
            last_ocr_activity: Instant::now(),
            magpie_info: None,
            magpie_scaling_msg: 0,
            magpie_pointer_seq: 0,
            magpie_pointer_pending: None,
            magpie_hovering: false,
            pomodoro: PomodoroState {
                enabled: false,
                mode: "work".into(),
                active: false,
                remaining_secs: 25 * 60,
                ..PomodoroState::default()
            },
            ws2_connected: false,
            ws1_connected: false,
            input_server_connected: false,
            game_state: GameWindowState {
                state: "closed".into(),
                ..Default::default()
            },
            target_hwnd: None,
            last_window_state: None,
            vn_guide_available: false,
            vn_guide_scene: None,
            custom_page_saved_urls: HashMap::new(),
            main_box_shown: false,
            ws2_tx: None,
            input_tx: None,
            active_window_tokens: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct OverlayHost {
    inner: Arc<Mutex<OverlayInner>>,
    reader_switch: Arc<AsyncMutex<()>>,
    lifecycle: Arc<AsyncMutex<()>>,
    tray_update: Arc<Mutex<()>>,
    vn_guide: Arc<AsyncMutex<Option<VnGuideController>>>,
    vn_catalogue: Arc<AsyncMutex<Option<GuideStore>>>,
    jiten: Arc<Mutex<Option<JitenParseCache>>>,
}

impl Default for OverlayHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(OverlayInner::default())),
            reader_switch: Arc::new(AsyncMutex::new(())),
            lifecycle: Arc::new(AsyncMutex::new(())),
            tray_update: Arc::new(Mutex::new(())),
            vn_guide: Arc::new(AsyncMutex::new(None)),
            vn_catalogue: Arc::new(AsyncMutex::new(None)),
            jiten: Arc::new(Mutex::new(None)),
        }
    }
}

impl OverlayHost {
    fn reset_interactions(&self, app: &AppHandle) {
        let (manual, sources) = {
            let mut inner = self.inner.lock().unwrap();
            let manual = inner.manual_hotkey.reset();
            inner.navigation_active = false;
            inner.resize_mode = false;
            inner.yomitan_showing = false;
            inner.lookup_focus_owned = false;
            inner.magpie_hovering = false;
            inner.magpie_pointer_pending = None;
            inner.manual_focus_deadline = None;
            inner.text_hover_ignoring = Some(true);
            (
                manual,
                inner.pause_sources.iter().cloned().collect::<Vec<_>>(),
            )
        };
        for source in sources {
            self.set_process_pause(&source, false);
        }
        if manual {
            desktop_state::emit_to_window(
                app,
                OVERLAY_MAIN_LABEL,
                "show-overlay-hotkey",
                &[json!(false)],
            );
        }
        desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "overlay-input-reset", &[]);
        desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "magpie-pointer-reset", &[]);
        self.sync_window_ignore_mouse(app);
    }
    fn show_recommendations(&self, app: &AppHandle, state: &Value) {
        let game = state["game"].as_str().unwrap_or("").trim();
        if game.is_empty() || state["state"] == "closed" {
            return;
        }
        for (needed, preference, dismissed, label, html, title) in [
            (
                state["recommendManualMode"] == true,
                "showManualModeRecommendations",
                "dismissedManualModeGames",
                OVERLAY_REC_MANUAL_LABEL,
                "manual-mode-recommendation.html",
                "Push to Show",
            ),
            (
                state["isExclusiveFullscreen"] == true,
                "showExclusiveFullscreenRecommendations",
                "dismissedFullscreenModeGames",
                OVERLAY_REC_FS_LABEL,
                "fullscreen-mode-recommendation.html",
                "Fullscreen compatibility",
            ),
        ] {
            let should_show = {
                let mut inner = self.inner.lock().unwrap();
                needed
                    && inner.user_settings[preference] != false
                    && !(label == OVERLAY_REC_MANUAL_LABEL && Self::manual_mode(&inner))
                    && !inner.user_settings[dismissed]
                        .as_array()
                        .is_some_and(|games| {
                            games.iter().any(|saved| {
                                saved
                                    .as_str()
                                    .is_some_and(|saved| saved.eq_ignore_ascii_case(game))
                            })
                        })
                    && inner
                        .shown_recommendations
                        .insert(format!("{label}:{}", game.to_lowercase()))
            };
            if should_show {
                let _ = self.open_simple_overlay_dialog(app, label, html, title, 650.0, 680.0);
            }
        }
    }
    pub(crate) fn observe_native_payload(&self, app: &AppHandle, payload: &Value) {
        if payload["type"] != "word_coordinates" {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        inner.last_text_payload = payload.clone();
        if payload["is_final"] == true {
            if let Some(tx) = &inner.ws2_tx {
                let _ = tx.send(Ws2Outbound::Direct(
                    json!({"type":"native-overlay-result", "data":payload}),
                ));
            }
        }
        drop(inner);
        self.push_offset_data(app);
    }

    fn push_offset_data(&self, app: &AppHandle) {
        if app.get_webview_window(OVERLAY_OFFSET_LABEL).is_none() {
            return;
        }
        let payload = {
            let inner = self.inner.lock().unwrap();
            let display = Self::resolve_display(&inner);
            json!({"textData":inner.last_text_payload, "settings":inner.user_settings,
                "windowBounds":display.map(|d| json!({"width":d.bounds.width,"height":d.bounds.height}))})
        };
        desktop_state::emit_to_window(app, OVERLAY_OFFSET_LABEL, "text-data", &[payload]);
    }
    async fn refresh_dictionary(&self, app: &AppHandle, previous: String) -> Result<(), String> {
        let _guard = self.reader_switch.lock().await;
        if !self.inner.lock().unwrap().running {
            return Ok(());
        }
        {
            let mut inner = self.inner.lock().unwrap();
            // Disabling an extension can discard its popup-hidden event.
            // Do not carry the previous reader's mouse ownership into reload.
            inner.yomitan_showing = false;
            inner.lookup_focus_owned = false;
            inner.text_hover_ignoring = Some(true);
            inner.magpie_pointer_pending = None;
        }
        self.sync_window_ignore_mouse(app);
        desktop_state::emit_to_window(
            app,
            OVERLAY_SETTINGS_LABEL,
            "dictionary-reader-switching",
            &[json!(true)],
        );
        let result = async {
            let dm = app.state::<DictionaryManager>();
            let (reader, ext) = dm.load_selected_extension(app).await?;
            if reader == "hachidori" {
                dm.ensure_hachidori_engine(app, &ext).await?;
            }
            if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                dm.attach_reader_window(app, &win, &ext).await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = &result {
            {
                let mut inner = self.inner.lock().unwrap();
                inner
                    .user_settings
                    .insert("dictionaryReaderSelection".into(), json!(previous));
                Self::persist_user_settings_locked(&inner);
            }
            if let Ok((_, ext)) = app
                .state::<DictionaryManager>()
                .load_selected_extension(app)
                .await
            {
                if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                    let _ = app
                        .state::<DictionaryManager>()
                        .attach_reader_window(app, &win, &ext)
                        .await;
                }
            }
            eprintln!("[overlay] Reader switch failed: {error}");
        }
        self.push_preload_settings(app);
        self.push_settings_to_main(app);
        desktop_state::emit_to_window(
            app,
            OVERLAY_SETTINGS_LABEL,
            "dictionary-reader-switching",
            &[json!(false)],
        );
        if let Err(error) = &result {
            desktop_state::emit_to_window(
                app,
                OVERLAY_SETTINGS_LABEL,
                "dictionary-reader-error",
                &[json!(error)],
            );
        }
        result
    }
    fn set_process_pause(&self, source: &str, paused: bool) {
        let mut inner = self.inner.lock().unwrap();
        if paused {
            let profile = inner.backend_config["current_profile"]
                .as_str()
                .unwrap_or("Default");
            let config = inner.backend_config["configs"][profile]
                .get("process_pausing")
                .or_else(|| inner.backend_config.get("process_pausing"))
                .unwrap_or(&Value::Null);
            let enabled = config["enabled"] == true
                && match source {
                    "manual_hotkey" => config["overlay_manual_hotkey_requests_pause"] == true,
                    "texthooker_hotkey" => {
                        config["overlay_texthooker_hotkey_requests_pause"] == true
                    }
                    "gamepad_navigation" => {
                        config
                            .get("overlay_gamepad_navigation_requests_pause")
                            .unwrap_or(&config["overlay_manual_hotkey_requests_pause"])
                            == true
                    }
                    "gamepad_manual_pause" => true,
                    _ => false,
                };
            if !enabled || !inner.ws2_connected || !inner.pause_sources.insert(source.into()) {
                return;
            }
        } else if !inner.pause_sources.remove(source) {
            return;
        }
        if let Some(tx) = &inner.ws2_tx {
            let _ = tx.send(Ws2Outbound::Direct(json!({"type":"process-pause-request",
                "action":if paused { "pause" } else { "resume" }, "source":source})));
        }
    }

    fn restore_game_focus(&self) {
        let inner = self.inner.lock().unwrap();
        if let Some(tx) = &inner.ws2_tx {
            let _ = tx.send(Ws2Outbound::Direct(
                json!({"type":"restore-focus-request", "expected_target_hwnd":inner.target_hwnd}),
            ));
        }
    }

    fn finish_manual_focus(&self, app: &AppHandle) {
        let focus = {
            let mut inner = self.inner.lock().unwrap();
            let pending = inner.manual_focus_deadline.take().is_some();
            pending
                && Self::capture_available(&inner)
                && (inner.manual_hotkey.hold_active
                    || inner.manual_hotkey.toggle_latched
                    || inner.navigation_active)
        };
        if focus {
            if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                let _ = win.set_focusable(true);
                let _ = window_platform::apply(&win, "focus", &Value::Null);
            }
        }
    }

    fn set_navigation(&self, app: &AppHandle, active: bool) {
        let active = {
            let mut inner = self.inner.lock().unwrap();
            let active = active
                && Self::capture_available(&inner)
                && inner.user_settings["gamepadEnabled"] == true;
            if inner.navigation_active == active {
                return;
            }
            inner.navigation_active = active;
            active
        };
        self.set_process_pause("gamepad_navigation", active);
        if active {
            self.wake_activity(app);
        } else {
            self.set_process_pause("gamepad_manual_pause", false);
            desktop_state::emit_to_window(
                app,
                OVERLAY_MAIN_LABEL,
                "gamepad-pause-state",
                &[json!({"paused":false})],
            );
            self.restore_game_focus();
        }
        self.sync_window_ignore_mouse(app);
    }
    fn refresh_tray(&self, app: &AppHandle) {
        let _guard = self.tray_update.lock().unwrap();
        let (settings, running) = {
            let inner = self.inner.lock().unwrap();
            (inner.user_settings.clone(), inner.running)
        };
        if let Err(error) = crate::overlay_tray::refresh(app, &settings, running) {
            eprintln!("[overlay] Tray: {error}");
        }
    }

    pub async fn handle_tray_action(&self, app: &AppHandle, action: &str) {
        match action {
            "settings" => {
                let _ = self.open_settings(app, None).await;
            }
            "dictionary" => self.open_dictionary_settings(app, false),
            "jiten" => self.open_dictionary_settings(app, true),
            "stop" => {
                let _ = self.set_enabled(app, false).await;
            }
            "toggleWindowHotkey" => self.dispatch_app_hotkey(app, action),
            "pomodoro-toggle" | "pomodoro-reset" => {
                let mut inner = self.inner.lock().unwrap();
                inner.pomodoro.started = true;
                inner.pomodoro.last_tick = None;
                if action == "pomodoro-reset" {
                    inner.pomodoro.active = false;
                    inner.pomodoro.mode = "work".into();
                    inner.pomodoro.remaining_secs = inner.user_settings["pomodoroWorkMinutes"]
                        .as_i64()
                        .unwrap_or(25)
                        * 60;
                } else if inner.pomodoro.enabled {
                    inner.pomodoro.active = !inner.pomodoro.active;
                }
                drop(inner);
                self.emit_pomodoro_state(app);
            }
            "manualMode" | "showFurigana" | "showTextIndicators" | "fadeTextIndicators"
            | "pomodoroEnabled" | "pomodoroAutoStart" => {
                let enabled = self
                    .inner
                    .lock()
                    .unwrap()
                    .user_settings
                    .get(action)
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.apply_setting_updates(
                    app,
                    Map::from_iter([(action.into(), json!(!enabled))]),
                    false,
                );
            }
            _ => {}
        }
    }
    fn capture_available(inner: &OverlayInner) -> bool {
        inner.capture_available != Some(false)
            && (matches!(inner.game_state.state.as_str(), "active" | "background")
                || (inner.game_state.state == "obscured"
                    && (inner.yomitan_showing
                        || inner.navigation_active
                        || inner.manual_hotkey.hold_active
                        || inner.manual_hotkey.toggle_latched
                        || inner.magpie_info.as_ref().is_some_and(source_focused))))
    }

    fn manual_mode(inner: &OverlayInner) -> bool {
        resolve_effective_platform(&inner.user_settings) != "win32"
            || inner
                .user_settings
                .get("manualMode")
                .and_then(Value::as_bool)
                == Some(true)
    }

    fn routes_text_hover(inner: &OverlayInner) -> bool {
        Self::capture_available(inner)
            && !Self::manual_mode(inner)
            && !inner.resize_mode
            && !inner.navigation_active
    }

    fn mouse_policy(inner: &OverlayInner) -> (bool, bool) {
        if !Self::capture_available(inner) || inner.is_afk {
            return (true, false);
        }
        if inner.resize_mode || inner.yomitan_showing || inner.pinned {
            return (false, true);
        }
        if Self::manual_mode(inner)
            && !inner.manual_hotkey.hold_active
            && !inner.manual_hotkey.toggle_latched
            && !inner.navigation_active
        {
            return (true, false);
        }
        let ignore = if inner.magpie_info.is_some() && Self::routes_text_hover(inner) {
            !inner.magpie_hovering
        } else {
            inner.text_hover_ignoring.unwrap_or(true)
        };
        (ignore, !ignore && inner.navigation_active)
    }

    fn request_or_toggle_translation(&self, app: &AppHandle) -> Result<(), String> {
        let event = {
            let mut inner = self.inner.lock().unwrap();
            if !inner.ws2_connected {
                return Err("GSM is disconnected".into());
            }
            if inner.translation_requested {
                "toggle-translation-visibility"
            } else {
                inner.translation_requested = true;
                "request-block-translation"
            }
        };
        desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, event, &[]);
        Ok(())
    }

    fn wake_activity(&self, app: &AppHandle) {
        let was_afk = {
            let mut inner = self.inner.lock().unwrap();
            inner.last_ocr_activity = Instant::now();
            let hidden = std::mem::replace(&mut inner.startup_hidden, false);
            std::mem::replace(&mut inner.is_afk, false) || hidden
        };
        if was_afk {
            desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "afk-hide", &[json!(false)]);
            self.sync_game_visibility(app);
        }
    }
    fn http_client(app: &AppHandle) -> reqwest::Client {
        app.try_state::<DesktopState>()
            .map(|d| d.http.clone())
            .unwrap_or_default()
    }

    pub(crate) fn jiten_cache(&self, app: &AppHandle) -> JitenParseCache {
        let mut g = self.jiten.lock().unwrap();
        g.get_or_insert_with(|| JitenParseCache::new(Self::http_client(app)))
            .clone()
    }

    async fn ensure_vn_guide_initialized(&self, app: &AppHandle) {
        let data_dir = {
            self.ensure_loaded(app);
            self.inner.lock().unwrap().overlay_data_dir.clone()
        };
        let mut guard = self.vn_guide.lock().await;
        if guard.is_none() {
            *guard = Some(VnGuideController::new(Self::http_client(app), &data_dir));
        }
    }

    fn ensure_loaded(&self, app: &AppHandle) {
        if !self
            .inner
            .lock()
            .unwrap()
            .overlay_data_dir
            .as_os_str()
            .is_empty()
        {
            return;
        }
        // Monitor enumeration can dispatch to the UI thread. Never hold the host
        // mutex while waiting for it: native input callbacks use the same mutex.
        let displays = collect_displays(app);
        let mut inner = self.inner.lock().unwrap();
        if !inner.overlay_data_dir.as_os_str().is_empty() {
            return;
        }
        let data_dir = overlay_data_path(app);
        let resources_dir = overlay_resources_root(app);
        let app_root = app
            .try_state::<DesktopState>()
            .map(|d| d.app_root.clone())
            .unwrap_or_else(|| PathBuf::from("."));
        let cfg_path = app
            .try_state::<crate::settings::Settings>()
            .map(|s| s.paths.active.join("config.json"))
            .unwrap_or_else(|| app_root.join("config.json"));
        let single_port = get_configured_single_port(&cfg_path);

        let mut settings = load_settings_from_disk(&data_dir, single_port);
        inner.pending_config = settings
            .remove("pendingGsmOverlayConfig")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let _ = resolve_hotkey_conflicts(&mut settings);
        let pinned = settings
            .get("pinned")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let pomo_enabled = settings
            .get("pomodoroEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let pomo_mins = settings
            .get("pomodoroWorkMinutes")
            .and_then(Value::as_i64)
            .unwrap_or(25)
            .clamp(1, 180);

        inner.overlay_data_dir = data_dir;
        inner.overlay_resources_dir = resources_dir;
        inner.single_port = single_port;
        inner.user_settings = settings;
        inner.pinned = pinned;
        inner.pomodoro = PomodoroState {
            enabled: pomo_enabled,
            mode: "work".into(),
            active: false,
            remaining_secs: pomo_mins * 60,
            ..PomodoroState::default()
        };
        inner.displays = displays;
        let idx = inner
            .user_settings
            .get("monitor_to_capture")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        inner.selected_display_index = if idx < inner.displays.len() { idx } else { 0 };
        inner.magpie_scaling_msg = register_magpie_scaling_message();
    }

    fn mount_overlay_assets(&self, app: &AppHandle) -> Result<String, String> {
        let resources_dir = {
            self.ensure_loaded(app);
            self.inner.lock().unwrap().overlay_resources_dir.clone()
        };
        if let Some(desktop) = app.try_state::<DesktopState>() {
            desktop.assets.mount(OVERLAY_ASSET_PREFIX, &resources_dir)?;
        }
        Ok(format!(
            "{}/{OVERLAY_ASSET_PREFIX}/",
            crate::assets::origin()
        ))
    }

    fn register_window_access(&self, app: &AppHandle, label: &str, scope: &str) -> String {
        let token = generate_window_token();
        if let Some(desktop) = app.try_state::<DesktopState>() {
            desktop.register_window_with_token(label, scope, token.clone());
        }
        let mut inner = self.inner.lock().unwrap();
        if !inner.active_window_tokens.contains(&label.to_string()) {
            inner.active_window_tokens.push(label.to_string());
        }
        token
    }

    pub fn unregister_window_access(&self, app: &AppHandle, label: &str) {
        if let Some(desktop) = app.try_state::<DesktopState>() {
            desktop.unregister_window(label);
        }
        self.inner
            .lock()
            .unwrap()
            .active_window_tokens
            .retain(|l| l != label);
    }

    pub fn status(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        json!({
            "isRunning": inner.running,
            "pid": Value::Null,
            "source": inner.source,
            "phase": if inner.running { "running" } else { "stopped" },
            "startedAt": inner.started_at_ms,
        })
    }

    pub async fn set_enabled(&self, app: &AppHandle, enabled: bool) -> Result<Value, String> {
        self.inner.lock().unwrap().manually_disabled = !enabled;
        if enabled {
            self.start(app, None, "manual").await?;
        } else {
            self.stop(app).await;
        }
        let mut s = self.status();
        if let Some(obj) = s.as_object_mut() {
            obj.insert("success".into(), json!(true));
        }
        Ok(s)
    }

    pub async fn auto_overlay_sync(
        &self,
        app: &AppHandle,
        should_run: bool,
    ) -> Result<Value, String> {
        if should_run {
            let needs_start = {
                let mut inner = self.inner.lock().unwrap();
                if inner.manually_disabled {
                    false
                } else if inner.running {
                    if inner.source == "startup" {
                        inner.source = "auto-launcher".into();
                    }
                    false
                } else {
                    true
                }
            };
            if needs_start {
                self.start(app, None, "auto-launcher").await?;
            }
        } else {
            let should_stop = {
                let inner = self.inner.lock().unwrap();
                inner.running && inner.source == "auto-launcher"
            };
            if should_stop {
                self.stop(app).await;
            }
        }
        Ok(self.status())
    }

    pub async fn start(
        &self,
        app: &AppHandle,
        show_startup_override: Option<bool>,
        source: &str,
    ) -> Result<bool, String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.ensure_loaded(app);
        self.mount_overlay_assets(app)?;
        {
            let inner = self.inner.lock().unwrap();
            if inner.running {
                drop(inner);
                self.sync_game_visibility(app);
                return Ok(true);
            }
            if inner.manually_disabled && matches!(source, "auto-launcher" | "startup") {
                return Ok(false);
            }
        }

        let displays = collect_displays(app);
        let gen = {
            let mut inner = self.inner.lock().unwrap();
            inner.running = true;
            inner.started_at_ms = Some(now_ms());
            inner.source = source.to_string();
            inner.worker_gen = inner.worker_gen.saturating_add(1);
            inner.displays = displays;
            inner.last_ocr_activity = Instant::now();
            inner.is_afk = false;
            inner.startup_hidden = inner.user_settings["hideOverlayOnStartup"] == true;
            inner.worker_gen
        };

        if let Err(error) = self.ensure_main_window(app).await {
            self.stop_inner(app).await;
            return Err(error);
        }
        self.reconfigure_vn_guide(app, false).await;

        // Spawn WS2 gateway, InputServer client, AFK/Pomodoro timer, and Magpie loop
        self.spawn_ws2_worker(app.clone(), gen);
        self.spawn_ws1_worker(app.clone(), gen);
        self.spawn_input_server_worker(app.clone(), gen);
        self.spawn_maintenance_worker(app.clone(), gen);
        self.spawn_magpie_worker(app.clone(), gen);

        self.sync_all_hotkeys(app);

        let (show_startup, open_settings, open_textfeed) = {
            let inner = self.inner.lock().unwrap();
            (
                show_startup_override.unwrap_or(
                    inner
                        .user_settings
                        .get("showMainBoxStartupWarning")
                        .and_then(Value::as_bool)
                        == Some(true)
                        && !inner
                            .user_settings
                            .get("mainBoxStartupWarningAcknowledged")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                ),
                inner.user_settings["openSettingsOnStartup"] == true,
                inner.user_settings["openTexthookerOnStartup"] == true,
            )
        };
        if open_settings {
            self.open_settings(app, None).await?;
        }
        if open_textfeed {
            self.open_texthooker(app)?;
        }
        if show_startup {
            let _ = self.open_simple_overlay_dialog(
                app,
                OVERLAY_STARTUP_LABEL,
                "startup-notification.html",
                "GSM Overlay Ready",
                460.0,
                320.0,
            );
        }

        self.refresh_tray(app);
        tray::refresh_presentation(app);
        desktop_state::emit_to_desktop_windows(app, "overlay-status-changed", &[self.status()]);
        Ok(true)
    }

    pub async fn stop(&self, app: &AppHandle) {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_inner(app).await;
    }

    async fn stop_inner(&self, app: &AppHandle) {
        let sources: Vec<String> = self
            .inner
            .lock()
            .unwrap()
            .pause_sources
            .iter()
            .cloned()
            .collect();
        if !sources.is_empty() {
            let url = self.inner.lock().unwrap().user_settings["weburl2"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let release = async {
                let (mut socket, _) = connect_async(url).await.map_err(|e| e.to_string())?;
                for source in &sources {
                    socket.send(Message::Text(json!({"type":"process-pause-request","action":"resume","source":source}).to_string().into())).await.map_err(|e| e.to_string())?;
                }
                socket.close(None).await.map_err(|e| e.to_string())
            };
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), release).await,
                Ok(Ok(()))
            ) {
                eprintln!(
                    "[overlay] Could not confirm release of overlay pause sources before shutdown"
                );
            }
        }
        for source in sources {
            self.set_process_pause(&source, false);
        }
        {
            let mut inner = self.inner.lock().unwrap();
            if !inner.running {
                return;
            }
            inner.running = false;
            inner.source.clear();
            inner.started_at_ms = None;
            inner.worker_gen = inner.worker_gen.saturating_add(1);
            inner.ws2_tx = None;
            inner.input_tx = None;
            inner.ws2_connected = false;
            inner.ws1_connected = false;
            inner.input_server_connected = false;
            inner.magpie_info = None;
            inner.magpie_hovering = false;
            inner.magpie_pointer_pending = None;
            inner.yomitan_showing = false;
            inner.text_hover_ignoring = None;
            inner.target_hwnd = None;
            inner.last_window_state = None;
            inner.manual_hotkey.reset();
            inner.capture_available = None;
            inner.navigation_active = false;
            inner.resize_mode = false;
            inner.manual_focus_deadline = None;
            inner.game_state = GameWindowState {
                state: "closed".into(),
                ..Default::default()
            };
        }

        self.unregister_all_tauri_shortcuts(app);
        if let Some(overlay) = app.try_state::<crate::overlay::Overlay>() {
            let _ = overlay.command(OVERLAY_MAIN_LABEL, json!({ "action": "stop" }));
        }

        for label in [
            OVERLAY_MAIN_LABEL,
            OVERLAY_SETTINGS_LABEL,
            OVERLAY_OFFSET_LABEL,
            OVERLAY_STARTUP_LABEL,
            OVERLAY_REC_MANUAL_LABEL,
            OVERLAY_REC_FS_LABEL,
            OVERLAY_VN_GUIDE_LABEL,
            OVERLAY_CUSTOM_PAGE_LABEL,
            OVERLAY_TEXTHOOKER_LABEL,
        ] {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.destroy();
            }
            self.unregister_window_access(app, label);
        }

        self.refresh_tray(app);
        tray::refresh_presentation(app);
        desktop_state::emit_to_desktop_windows(app, "overlay-status-changed", &[self.status()]);
    }

    pub fn shutdown(&self, app: &AppHandle) {
        let mut inner = self.inner.lock().unwrap();
        inner.running = false;
        inner.worker_gen = inner.worker_gen.saturating_add(1);
        inner.ws2_tx = None;
        inner.input_tx = None;
        drop(inner);
        if let Some(overlay) = app.try_state::<crate::overlay::Overlay>() {
            let _ = overlay.command(OVERLAY_MAIN_LABEL, json!({ "action": "stop" }));
        }
        self.unregister_all_tauri_shortcuts(app);
    }

    fn resolve_display(inner: &OverlayInner) -> Option<DisplayInfo> {
        // mss, xcap and Tauri have different monitor IDs and enumeration orders.
        if let Some(bounds) = inner.user_settings.get("monitor_to_capture_bounds") {
            if let Some(display) = inner.displays.iter().find(|display| {
                bounds["left"].as_f64() == Some(display.physical_bounds.x)
                    && bounds["top"].as_f64() == Some(display.physical_bounds.y)
                    && bounds["width"].as_f64() == Some(display.physical_bounds.width)
                    && bounds["height"].as_f64() == Some(display.physical_bounds.height)
            }) {
                return Some(display.clone());
            }
        }
        let monitor_id = inner
            .user_settings
            .get("monitor_to_capture_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let monitor_idx = inner
            .user_settings
            .get("monitor_to_capture")
            .and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
            })
            .unwrap_or(inner.selected_display_index as i64);
        select_target_display(&inner.displays, monitor_idx, monitor_id)
    }

    async fn ensure_main_window(&self, app: &AppHandle) -> Result<(), String> {
        if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
            let _ = win.show();
            return Ok(());
        }

        let base_url = self.mount_overlay_assets(app)?;
        let token = self.register_window_access(app, OVERLAY_MAIN_LABEL, "overlay");
        let (overlay_data, resources_dir, display, magpie_msg, _manual_mode) = {
            let inner = self.inner.lock().unwrap();
            let disp = Self::resolve_display(&inner);
            (
                inner.overlay_data_dir.clone(),
                inner.overlay_resources_dir.clone(),
                disp,
                inner.magpie_scaling_msg,
                inner
                    .user_settings
                    .get("manualMode")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        };

        let dict = app.try_state::<DictionaryManager>();
        let loaded_ext = match dict.as_ref() {
            Some(dm) => match dm.load_selected_extension(app).await {
                Ok((reader, ext)) => {
                    if reader == "hachidori" {
                        dm.ensure_hachidori_engine(app, &ext).await?;
                    }
                    Some(ext)
                }
                Err(error) => {
                    return Err(format!(
                        "Could not initialize the overlay dictionary: {error}"
                    ))
                }
            },
            None => None,
        };
        let jiten_enabled = self.inner.lock().unwrap().user_settings["enableJitenReader"] == true;
        let jiten_ext = if jiten_enabled {
            if let Some(dm) = dict.as_ref() {
                Some(dm.load_jiten_extension(app).await?)
            } else {
                None
            }
        } else {
            None
        };
        let mut portable_extra = if !dictionary_host::use_windows_native_extensions() {
            if let (Some(dm), Some(ext)) = (dict.as_ref(), loaded_ext.as_ref()) {
                dm.portable_preload_for_window(
                    OVERLAY_MAIN_LABEL,
                    ext,
                    &format!("{base_url}index.html"),
                    1,
                )
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        if !dictionary_host::use_windows_native_extensions() {
            if let (Some(dm), Some(ext)) = (dict.as_ref(), jiten_ext.as_ref()) {
                portable_extra.push_str(&dm.portable_preload_for_window(
                    OVERLAY_MAIN_LABEL,
                    ext,
                    &format!("{base_url}index.html"),
                    1,
                ));
            }
        }
        let init_script = overlay_main_init_script(
            &token,
            &resources_dir,
            (!portable_extra.is_empty()).then_some(portable_extra.as_str()),
        );

        let url = url::Url::parse(&format!("{base_url}index.html"))
            .map_err(|e| format!("Invalid overlay URL: {e}"))?;

        let mut builder = dictionary_host::apply_shared_webview_options(
            WebviewWindowBuilder::new(app, OVERLAY_MAIN_LABEL, WebviewUrl::External(url))
                .title("GSM Overlay")
                .transparent(true)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .focusable(false)
                .shadow(false)
                .visible(false)
                .initialization_script(&init_script),
        );

        if !overlay_data.as_os_str().is_empty() {
            builder = dictionary_host::apply_profile_data_directory(builder, &overlay_data)?;
        }

        if let Some(disp) = &display {
            builder = builder
                .position(disp.bounds.x, disp.bounds.y)
                .inner_size(disp.bounds.width, disp.bounds.height);
        }

        let win = builder
            .build()
            .map_err(|e| format!("Failed creating overlay window: {e}"))?;

        let _ = window_platform::apply(&win, "frameless", &Value::Null);
        let _ = window_platform::apply(
            &win,
            "ignoreCursor",
            &json!({ "ignore": true, "forward": true }),
        );
        let _ = window_platform::apply(&win, "moveTop", &Value::Null);
        if magpie_msg != 0 {
            let _ = window_platform::apply(&win, "hookMessage", &json!(magpie_msg));
        }

        if let Some(disp) = &display {
            let _ = win.set_position(PhysicalPosition::new(
                disp.physical_bounds.x as i32,
                disp.physical_bounds.y as i32,
            ));
            let _ = win.set_size(PhysicalSize::new(
                disp.physical_bounds.width as u32,
                disp.physical_bounds.height as u32,
            ));
        }

        if let (Some(dm), Some(ext)) = (dict.as_ref(), loaded_ext.as_ref()) {
            if dictionary_host::use_windows_native_extensions() {
                dm.set_home_reader_extension(OVERLAY_MAIN_LABEL, &ext.id);
            } else {
                dm.attach_reader_window(app, &win, ext).await?;
            }
        }

        // Push initial display + settings immediately after build (and again on page ready)
        self.push_display_info(app);
        self.push_settings_to_main(app);
        Ok(())
    }

    pub async fn open_settings(&self, app: &AppHandle, tab: Option<&str>) -> Result<(), String> {
        self.ensure_loaded(app);
        self.inner.lock().unwrap().pending_settings_tab = tab.map(str::to_owned);
        let base_url = self.mount_overlay_assets(app)?;

        if let Some(win) = app.get_webview_window(OVERLAY_SETTINGS_LABEL) {
            let _ = win.show();
            let _ = win.set_focus();
            self.push_preload_settings(app);
            if let Some(t) = tab {
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_SETTINGS_LABEL,
                    "select-settings-tab",
                    &[json!(t)],
                );
            }
            return Ok(());
        }

        let token = self.register_window_access(app, OVERLAY_SETTINGS_LABEL, "overlay");
        let resources_dir = self.inner.lock().unwrap().overlay_resources_dir.clone();
        let init_script = overlay_settings_init_script(&token, &resources_dir);
        let url = url::Url::parse(&format!("{base_url}settings.html"))
            .map_err(|e| format!("Invalid settings URL: {e}"))?;

        let win = WebviewWindowBuilder::new(app, OVERLAY_SETTINGS_LABEL, WebviewUrl::External(url))
            .title("GSM Overlay Settings")
            .inner_size(980.0, 760.0)
            .min_inner_size(720.0, 520.0)
            .visible(false)
            .initialization_script(&init_script)
            .build()
            .map_err(|e| format!("Failed to create overlay settings window: {e}"))?;

        let app_clone = app.clone();
        let host_clone = self.clone();
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                host_clone.unregister_window_access(&app_clone, OVERLAY_SETTINGS_LABEL);
            }
        });

        // A renderer failure must never strand an invisible native window. Normal
        // hydration uses the ready/painted handshake; this also exposes load errors.
        let fallback_host = self.clone();
        let fallback_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if !win.is_visible().unwrap_or(true) {
                fallback_host.push_preload_settings(&fallback_app);
                let _ = win.show();
                let _ = win.set_focus();
            }
        });
        Ok(())
    }

    pub fn open_offset_helper(&self, app: &AppHandle) -> Result<(), String> {
        self.open_simple_overlay_dialog(
            app,
            OVERLAY_OFFSET_LABEL,
            "offset-helper.html",
            "Offset Helper",
            520.0,
            640.0,
        )?;
        self.push_offset_data(app);
        Ok(())
    }

    pub fn open_texthooker(&self, app: &AppHandle) -> Result<(), String> {
        self.ensure_loaded(app);
        let raw_url = {
            let inner = self.inner.lock().unwrap();
            inner
                .user_settings
                .get("texthookerUrl")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("http://127.0.0.1:{}/texthooker", inner.single_port))
        };
        let parsed =
            url::Url::parse(&raw_url).map_err(|e| format!("Invalid texthooker URL: {e}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("Texthooker URL must be http or https".into());
        }
        if let Some(win) = app.get_webview_window(OVERLAY_TEXTHOOKER_LABEL) {
            let _ = win.show();
            let _ = win.set_focus();
            self.set_process_pause("texthooker_hotkey", true);
            return Ok(());
        }
        let builder = dictionary_host::apply_shared_webview_options(WebviewWindowBuilder::new(
            app,
            OVERLAY_TEXTHOOKER_LABEL,
            WebviewUrl::External(parsed),
        ))
        .title("GSM Texthooker")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(1100.0, 760.0)
        .visible(true)
        .initialization_script(AUX_WINDOW_SCRIPT)
        .on_navigation(|url| matches!(url.scheme(), "http" | "https"));
        let directory = self.inner.lock().unwrap().overlay_data_dir.clone();
        let win = dictionary_host::apply_profile_data_directory(builder, &directory)?
            .build()
            .map_err(|e| format!("Failed opening texthooker window: {e}"))?;
        self.install_aux_window(app, &win);
        self.set_process_pause("texthooker_hotkey", true);
        Ok(())
    }

    fn install_aux_window(&self, app: &AppHandle, window: &tauri::WebviewWindow) {
        self.position_overlay_window(window);
        let _ = window_platform::apply(window, "opacity", &json!(0.95));
        let host = self.clone();
        let app = app.clone();
        let label = window.label().to_owned();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                host.hide_aux_window(&app, &label);
            }
        });
    }

    pub fn hide_aux_window(&self, app: &AppHandle, label: &str) {
        if !matches!(label, OVERLAY_CUSTOM_PAGE_LABEL | OVERLAY_TEXTHOOKER_LABEL) {
            return;
        }
        if let Some(window) = app.get_webview_window(label) {
            if label == OVERLAY_CUSTOM_PAGE_LABEL {
                if let Ok(url) = window.url() {
                    if matches!(url.scheme(), "http" | "https") {
                        let mut inner = self.inner.lock().unwrap();
                        let configured = inner.user_settings["customPageUrl"]
                            .as_str()
                            .and_then(normalize_custom_page_url);
                        if let Some(configured) = configured {
                            inner
                                .custom_page_saved_urls
                                .insert(configured.clone(), url.to_string());
                            let saved = inner
                                .user_settings
                                .entry("customPageLastUrls")
                                .or_insert_with(|| json!({}));
                            if !saved.is_object() {
                                *saved = json!({});
                            }
                            saved[configured] = json!(url.as_str());
                            Self::persist_user_settings_locked(&inner);
                        }
                    }
                }
            }
            let _ = window.hide();
        }
        if label == OVERLAY_TEXTHOOKER_LABEL {
            self.set_process_pause("texthooker_hotkey", false);
        }
        self.restore_game_focus();
        self.sync_game_visibility(app);
    }

    fn open_simple_overlay_dialog(
        &self,
        app: &AppHandle,
        label: &str,
        html_file: &str,
        title: &str,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        self.ensure_loaded(app);
        let base_url = self.mount_overlay_assets(app)?;
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.show();
            let _ = win.set_focus();
            return Ok(());
        }
        let token = self.register_window_access(app, label, "overlay");
        let init_script = overlay_simple_ipc_init_script(&token);
        let url = url::Url::parse(&format!("{base_url}{html_file}"))
            .map_err(|e| format!("Invalid dialog URL: {e}"))?;
        let loaded_host = self.clone();
        let loaded_app = app.clone();
        let loaded_label = label.to_owned();
        let win = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
            .title(title)
            .inner_size(width, height)
            .always_on_top(true)
            .visible(true)
            .initialization_script(&init_script)
            .on_page_load(move |_, event| {
                if event.event() != tauri::webview::PageLoadEvent::Finished {
                    return;
                }
                let payload = {
                    let inner = loaded_host.inner.lock().unwrap();
                    json!({"game":inner.game_state.game,"initial":inner.user_settings,
                        "runtimeState":{"manualHotkeyBackend":inner.manual_hotkey_backend,
                            "manualHotkeyKeyboardAvailable":inner.keyboard_available,
                            "manualHotkeyKeyboardError":inner.keyboard_error}})
                };
                let channel = match loaded_label.as_str() {
                    OVERLAY_REC_MANUAL_LABEL => "preload-manual-mode-recommendation",
                    OVERLAY_REC_FS_LABEL => "preload-fullscreen-mode-recommendation",
                    _ => return,
                };
                desktop_state::emit_to_window(&loaded_app, &loaded_label, channel, &[payload]);
            })
            .build()
            .map_err(|e| format!("Failed creating {label}: {e}"))?;

        let app_clone = app.clone();
        let host_clone = self.clone();
        let label_owned = label.to_string();
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                host_clone.unregister_window_access(&app_clone, &label_owned);
            }
        });
        Ok(())
    }

    fn push_display_info(&self, app: &AppHandle) {
        let disp = {
            let inner = self.inner.lock().unwrap();
            Self::resolve_display(&inner)
        };
        if let Some(d) = disp {
            if let Ok(v) = serde_json::to_value(&d) {
                desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "display-info", &[v]);
            }
        }
    }

    fn push_settings_to_main(&self, app: &AppHandle) {
        let mut settings = self.inner.lock().unwrap().user_settings.clone();
        settings.insert(
            "gamepadServerPort".into(),
            json!(resolve_gamepad_port(&settings, Some(app))),
        );
        let reader = settings
            .get("dictionaryReaderSelection")
            .cloned()
            .unwrap_or(json!("yomitan"));
        settings.insert("dictionaryReader".into(), reader);
        desktop_state::emit_to_window(
            app,
            OVERLAY_MAIN_LABEL,
            "load-settings",
            &[Value::Object(settings)],
        );
    }

    fn push_preload_settings(&self, app: &AppHandle) {
        let payload = {
            let inner = self.inner.lock().unwrap();
            let mut user_settings = inner.user_settings.clone();
            user_settings.insert(
                "gamepadServerPort".into(),
                json!(resolve_gamepad_port(&user_settings, Some(app))),
            );
            let monitor_labels: Vec<String> = inner
                .displays
                .iter()
                .enumerate()
                .map(|(i, d)| {
                    if d.label.trim().is_empty() {
                        format!(
                            "Display {} ({}x{})",
                            i + 1,
                            d.physical_size.width as i32,
                            d.physical_size.height as i32
                        )
                    } else {
                        d.label.clone()
                    }
                })
                .collect();
            let preload = json!({
                "userSettings": Value::Object(user_settings),
                "websocketStates": {
                    "ws1": if inner.ws1_connected { "connected" } else { "disconnected" },
                    "ws2": if inner.ws2_connected { "connected" } else { "disconnected" }
                },
                "defaultSettings": Value::Object(default_user_settings_map()),
                "runtimeSettings": {
                    "manualHotkeyBackend": inner.manual_hotkey_backend,
                    "manualHotkeyBackendReason": inner.manual_hotkey_backend_reason,
                    "manualHotkeyKeyboardAvailable": inner.keyboard_available,
                    "manualHotkeyKeyboardError": inner.keyboard_error,
                },
                "profileState": overlay_profile_state(&inner.user_settings, &inner.profile_state),
            });
            (preload, monitor_labels)
        };
        desktop_state::emit_to_window(
            app,
            OVERLAY_SETTINGS_LABEL,
            "gsm-overlay-monitors",
            &[json!(payload.1)],
        );
        desktop_state::emit_to_window(
            app,
            OVERLAY_SETTINGS_LABEL,
            "preload-settings",
            &[payload.0],
        );
        if let Some(tab) = self.inner.lock().unwrap().pending_settings_tab.take() {
            desktop_state::emit_to_window(
                app,
                OVERLAY_SETTINGS_LABEL,
                "select-settings-tab",
                &[json!(tab)],
            );
        }
    }

    fn broadcast_settings_update(&self, app: &AppHandle, patch: &Map<String, Value>) {
        self.refresh_tray(app);
        let mut patch = patch.clone();
        if let Some(port) = input_server::port(app) {
            patch.insert("gamepadServerPort".into(), json!(port));
        }
        let val = Value::Object(patch);
        for label in [
            OVERLAY_MAIN_LABEL,
            OVERLAY_SETTINGS_LABEL,
            OVERLAY_REC_MANUAL_LABEL,
            OVERLAY_REC_FS_LABEL,
        ] {
            if app.get_webview_window(label).is_some() {
                desktop_state::emit_to_window(app, label, "settings-updated", &[val.clone()]);
            }
        }
    }

    fn persist_user_settings_locked(inner: &OverlayInner) {
        if !inner.overlay_data_dir.as_os_str().is_empty() {
            let mut settings = inner.user_settings.clone();
            settings.insert(
                "pendingGsmOverlayConfig".into(),
                Value::Object(inner.pending_config.clone()),
            );
            if let Err(error) = save_settings_atomic(&inner.overlay_data_dir, &settings) {
                eprintln!("[overlay] Could not save overlay settings: {error}");
            }
        }
    }

    pub(crate) fn apply_setting_updates(
        &self,
        app: &AppHandle,
        updates: Map<String, Value>,
        from_gsm_backend: bool,
    ) {
        let mut gsm_sync_patch = Map::new();
        self.ensure_loaded(app);
        // Dispose auxiliary pages before replacing their configured URL so the
        // old navigation is saved under the old page, never under the new one.
        for (label, key, disable_key) in [
            (
                OVERLAY_CUSTOM_PAGE_LABEL,
                "customPageUrl",
                Some("customPageEnabled"),
            ),
            (OVERLAY_TEXTHOOKER_LABEL, "texthookerUrl", None),
        ] {
            let dispose = {
                let inner = self.inner.lock().unwrap();
                updates
                    .get(key)
                    .is_some_and(|value| inner.user_settings.get(key) != Some(value))
                    || disable_key.is_some_and(|key| updates.get(key) == Some(&json!(false)))
            };
            if dispose {
                if let Some(window) = app.get_webview_window(label) {
                    self.hide_aux_window(app, label);
                    let _ = window.destroy();
                }
            }
        }
        let previous_reader = self.inner.lock().unwrap().user_settings["dictionaryReaderSelection"]
            .as_str()
            .unwrap_or("yomitan")
            .to_owned();
        let jiten_was_enabled =
            self.inner.lock().unwrap().user_settings["enableJitenReader"] == true;
        let refreshed_displays = updates
            .keys()
            .any(|key| {
                matches!(
                    key.as_str(),
                    "monitor_to_capture" | "monitor_to_capture_id" | "monitor_to_capture_bounds"
                )
            })
            .then(|| collect_displays(app));
        let mut hotkey_changed = false;
        let mut monitor_changed = false;
        let mut vn_guide_changed = false;
        let mut pomodoro_changed = false;
        let mut applied = Map::new();

        {
            let mut inner = self.inner.lock().unwrap();
            let single_port = inner.single_port;
            let enabling_profiles = updates.get(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY)
                == Some(&json!(true))
                && inner
                    .user_settings
                    .get(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY)
                    != Some(&json!(true));
            let mut updates = updates;
            if enabling_profiles {
                let mut restored = inner.user_settings.clone();
                restore_active_profile(&mut restored);
                updates.extend(build_profile_snapshot(&restored));
            }
            for (k, v) in updates {
                if !from_gsm_backend {
                    if let Some(gsm_field) = overlay_key_to_gsm_field(&k) {
                        gsm_sync_patch.insert(gsm_field.to_string(), v.clone());
                    }
                }
                if k == "pinned" {
                    inner.pinned = v.as_bool().unwrap_or(false);
                }
                if matches!(
                    k.as_str(),
                    "monitor_to_capture" | "monitor_to_capture_id" | "monitor_to_capture_bounds"
                ) {
                    monitor_changed = true;
                }
                if k.contains("Hotkey")
                    || k == "showHotkey"
                    || k == "manualMode"
                    || k == "manualModeType"
                    || k == "routeAllHotkeysThroughInputServer"
                    || matches!(
                        k.as_str(),
                        "gamepadEnabled"
                            | "gamepadKeyboardEnabled"
                            | "gamepadDeviceBlacklist"
                            | "vnGuideEnabled"
                            | "customPageEnabled"
                            | "platformOverride"
                    )
                {
                    hotkey_changed = true;
                }
                if k.starts_with("vnGuide") {
                    vn_guide_changed = true;
                }
                if k.starts_with("pomodoro") {
                    pomodoro_changed = true;
                }
                inner.user_settings.insert(k.clone(), v.clone());
                applied.insert(k, v);
            }

            if normalize_user_settings(&mut inner.user_settings, single_port) {
                for key in [
                    "weburl1",
                    "weburl2",
                    "texthookerUrl",
                    "localVocabularyEnabled",
                ] {
                    if let Some(val) = inner.user_settings.get(key) {
                        applied.insert(key.into(), val.clone());
                    }
                }
            }

            if hotkey_changed {
                let cleared = resolve_hotkey_conflicts(&mut inner.user_settings);
                for key in cleared {
                    applied.insert(key, json!(""));
                }
            }

            if monitor_changed {
                if let Some(displays) = refreshed_displays {
                    inner.displays = displays;
                }
                let idx = inner
                    .user_settings
                    .get("monitor_to_capture")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                inner.selected_display_index = if idx < inner.displays.len() { idx } else { 0 };
            }

            if pomodoro_changed {
                let enabled = inner
                    .user_settings
                    .get("pomodoroEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let work_mins = inner
                    .user_settings
                    .get("pomodoroWorkMinutes")
                    .and_then(Value::as_i64)
                    .unwrap_or(25)
                    .clamp(1, 180);
                inner.pomodoro.enabled = enabled;
                inner.pomodoro.last_tick = None;
                if !enabled {
                    inner.pomodoro.active = false;
                }
                inner.pomodoro.mode = "work".into();
                inner.pomodoro.remaining_secs = work_mins * 60;
            }

            if inner
                .user_settings
                .get(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY)
                == Some(&json!(true))
            {
                let active = inner
                    .user_settings
                    .get(OVERLAY_ACTIVE_PROFILE_KEY)
                    .and_then(Value::as_str)
                    .unwrap_or(DEFAULT_GSM_PROFILE_NAME)
                    .to_owned();
                let snapshot = build_profile_snapshot(&inner.user_settings);
                inner
                    .user_settings
                    .entry(OVERLAY_PROFILE_SETTINGS_KEY)
                    .or_insert_with(|| json!({}))[active] = Value::Object(snapshot);
            }

            if applied
                .keys()
                .any(|key| VN_GUIDE_SCENE_SETTING_KEYS.contains(&key.as_str()))
            {
                let scene = inner.vn_guide_scene.clone();
                record_guide_scene(&mut inner.user_settings, scene.as_deref());
            }
            Self::persist_user_settings_locked(&inner);

            if !gsm_sync_patch.is_empty() {
                inner.pending_config.extend(gsm_sync_patch.clone());
                Self::persist_user_settings_locked(&inner);
                if let Some(tx) = &inner.ws2_tx {
                    let _ = tx.send(Ws2Outbound::CoalescedConfig(json!({
                        "type": "set-gsm-overlay-config",
                        "settings": Value::Object(gsm_sync_patch),
                    })));
                }
            }
        }

        if monitor_changed {
            self.reposition_main_overlay(app);
            self.push_display_info(app);
        }
        if hotkey_changed {
            self.sync_all_hotkeys(app);
            let active = self.inner.lock().unwrap().manual_hotkey.reset();
            if active {
                self.emit_manual_hotkey_state(app, false);
            }
        }
        if pomodoro_changed {
            self.emit_pomodoro_state(app);
        }
        if !applied.is_empty() {
            self.broadcast_settings_update(app, &applied);
        }
        if applied.contains_key("textHoverClickThrough")
            || applied.contains_key("manualMode")
            || applied.contains_key("pinned")
        {
            self.inner.lock().unwrap().text_hover_ignoring = Some(true);
            self.sync_window_ignore_mouse(app);
            desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "text-hover-refresh", &[]);
        }
        if applied
            .get("dictionaryReaderSelection")
            .and_then(Value::as_str)
            .is_some_and(|next| next != previous_reader)
        {
            let host = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = host.refresh_dictionary(&app, previous_reader).await {
                    eprintln!("[overlay] Dictionary switch: {error}");
                }
            });
        }
        if !jiten_was_enabled && applied.get("enableJitenReader") == Some(&json!(true)) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match app
                    .state::<DictionaryManager>()
                    .load_jiten_extension(&app)
                    .await
                {
                    Ok(_) => {
                        if let Some(window) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                            if let Ok(url) = window.url() {
                                let _ = window.navigate(url);
                            }
                        }
                    }
                    Err(error) => desktop_state::emit_to_window(
                        &app,
                        OVERLAY_SETTINGS_LABEL,
                        "dictionary-reader-error",
                        &[json!(error)],
                    ),
                }
            });
        }
        if applied.contains_key(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY) {
            self.push_preload_settings(app);
        }
        if applied.contains_key("magpieCompatibility") {
            self.refresh_magpie_state(app);
        }
        if vn_guide_changed {
            let app_c = app.clone();
            let this_c = self.clone();
            tauri::async_runtime::spawn(async move {
                this_c.reconfigure_vn_guide(&app_c, false).await;
            });
        }
    }

    fn reposition_main_overlay(&self, app: &AppHandle) {
        for label in [
            OVERLAY_MAIN_LABEL,
            OVERLAY_TEXTHOOKER_LABEL,
            OVERLAY_CUSTOM_PAGE_LABEL,
        ] {
            if let Some(window) = app.get_webview_window(label) {
                self.position_overlay_window(&window);
            }
        }
    }

    fn position_overlay_window(&self, win: &tauri::WebviewWindow) {
        let disp = {
            let inner = self.inner.lock().unwrap();
            Self::resolve_display(&inner)
        };
        if let Some(d) = disp {
            let _ = win.set_position(PhysicalPosition::new(
                d.physical_bounds.x as i32,
                d.physical_bounds.y as i32,
            ));
            let _ = win.set_size(PhysicalSize::new(
                d.physical_bounds.width as u32,
                d.physical_bounds.height as u32,
            ));
        }
    }

    fn emit_pomodoro_state(&self, app: &AppHandle) {
        let payload = {
            let inner = self.inner.lock().unwrap();
            json!({
                "enabled": inner.pomodoro.enabled,
                "phase": inner.pomodoro.mode,
                "running": inner.pomodoro.active,
                "remainingMs": inner.pomodoro.remaining_secs * 1000,
                "endTimestamp": if inner.pomodoro.active { Some(now_ms() + inner.pomodoro.remaining_secs.max(0) as u64 * 1000) } else { None },
            })
        };
        desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "pomodoro-update", &[payload]);
    }

    fn sync_window_ignore_mouse(&self, app: &AppHandle) {
        let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) else {
            return;
        };
        let (ignore, focusable) = {
            let inner = self.inner.lock().unwrap();
            Self::mouse_policy(&inner)
        };
        let _ = win.set_focusable(focusable);
        let _ = window_platform::apply(
            &win,
            "ignoreCursor",
            &json!({ "ignore": ignore, "forward": ignore }),
        );
    }

    fn sync_game_visibility(&self, app: &AppHandle) {
        let (available, afk, hidden) = {
            let inner = self.inner.lock().unwrap();
            (
                Self::capture_available(&inner),
                inner.is_afk,
                inner.startup_hidden,
            )
        };
        desktop_state::emit_to_window(
            app,
            OVERLAY_MAIN_LABEL,
            "overlay-capture-state",
            &[json!({"available":available})],
        );
        if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
            if available && !afk && !hidden {
                let _ = win.show();
            } else if !available {
                self.reset_interactions(app);
                let _ = win.hide();
                self.sync_window_ignore_mouse(app);
            }
        }
    }

    // ---------- Hotkey Registration & Dispatch ----------

    fn unregister_all_tauri_shortcuts(&self, app: &AppHandle) {
        let accels: Vec<String> = {
            let mut inner = self.inner.lock().unwrap();
            let list: Vec<String> = inner
                .registered_tauri_accelerators
                .keys()
                .cloned()
                .collect();
            inner.registered_tauri_accelerators.clear();
            list
        };
        let gs = app.global_shortcut();
        for a in accels {
            let _ = gs.unregister(a.as_str());
        }
    }

    fn sync_all_hotkeys(&self, app: &AppHandle) {
        self.unregister_all_tauri_shortcuts(app);
        if !self.inner.lock().unwrap().running {
            return;
        }

        let (show_hotkey, manual_mode, route_all, app_hotkeys, input_tx) = {
            let inner = self.inner.lock().unwrap();
            let show_hk = inner
                .user_settings
                .get("showHotkey")
                .and_then(Value::as_str)
                .unwrap_or("Shift+Space")
                .trim()
                .to_string();
            let manual = Self::manual_mode(&inner);
            let route_all = inner
                .user_settings
                .get("routeAllHotkeysThroughInputServer")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut list = Vec::new();
            for (key, default_hk) in GLOBAL_HOTKEY_KEYS {
                let enabled = match *key {
                    "gamepadKeyboardHotkey" => {
                        inner.user_settings["gamepadEnabled"] == true
                            && inner.user_settings["gamepadKeyboardEnabled"] == true
                    }
                    "customPageHotkey" => inner.user_settings["customPageEnabled"] == true,
                    "vnGuideToggleHotkey" | "vnGuideNextHotkey" | "vnGuideBackHotkey" => {
                        inner.user_settings["vnGuideEnabled"] == true
                    }
                    _ => true,
                };
                if !enabled {
                    continue;
                }
                let hk = inner
                    .user_settings
                    .get(*key)
                    .and_then(Value::as_str)
                    .unwrap_or(*default_hk)
                    .trim()
                    .to_string();
                if !hk.is_empty() {
                    list.push(((*key).to_string(), hk));
                }
            }
            (show_hk, manual, route_all, list, inner.input_tx.clone())
        };

        let mut server_app_hotkeys: Vec<Value> = Vec::new();
        let mut tauri_registered: HashMap<String, String> = HashMap::new();
        let gs = app.global_shortcut();

        // Determine manual showHotkey routing
        let manual_needs_input_server = manual_mode
            && (cfg!(windows)
                || route_all
                || is_modifier_only_hotkey(&show_hotkey)
                || is_mouse_hotkey(&show_hotkey)
                || to_tauri_accelerator(&show_hotkey).is_none());

        let mut manual_using_tauri = false;
        if manual_mode && !manual_needs_input_server {
            if let Some(accel) = to_tauri_accelerator(&show_hotkey) {
                let this_c = self.clone();
                if gs
                    .on_shortcut(accel.as_str(), move |app, _shortcut, event| {
                        this_c.on_global_shortcut_event(
                            app,
                            "showHotkey",
                            event.state == ShortcutState::Pressed,
                        );
                    })
                    .is_ok()
                {
                    tauri_registered.insert(accel, "showHotkey".into());
                    manual_using_tauri = true;
                }
            }
        }

        // Route all other app hotkeys
        for (action_key, hk_str) in app_hotkeys {
            if !route_all && !is_mouse_hotkey(&hk_str) && !is_modifier_only_hotkey(&hk_str) {
                if let Some(accel) = to_tauri_accelerator(&hk_str) {
                    if !tauri_registered.contains_key(&accel) {
                        let this_c = self.clone();
                        let act = action_key.clone();
                        if gs
                            .on_shortcut(accel.as_str(), move |app, _shortcut, event| {
                                this_c.on_global_shortcut_event(
                                    app,
                                    &act,
                                    event.state == ShortcutState::Pressed,
                                );
                            })
                            .is_ok()
                        {
                            tauri_registered.insert(accel, action_key);
                            continue;
                        }
                    }
                }
            }
            server_app_hotkeys.push(json!({ "id": action_key, "hotkey": hk_str }));
        }

        {
            let mut inner = self.inner.lock().unwrap();
            inner.registered_tauri_accelerators = tauri_registered;
            if manual_using_tauri {
                inner.manual_hotkey_backend = "electron".into();
                inner.manual_hotkey_backend_reason = "tauri-global-shortcut".into();
            } else {
                inner.manual_hotkey_backend = "input_server".into();
                inner.manual_hotkey_backend_reason = if !manual_mode {
                    "manual-mode-disabled".into()
                } else {
                    "input-server".into()
                };
            }
        }

        if let Some(tx) = input_tx {
            let devices = self
                .inner
                .lock()
                .unwrap()
                .user_settings
                .get("gamepadDeviceBlacklist")
                .cloned()
                .unwrap_or(json!([]));
            let _ = tx.send(json!({"type":"configure_device_blacklist","devices":devices}));
            let need_keyboard =
                (manual_mode && !manual_using_tauri) || !server_app_hotkeys.is_empty();
            let features = if need_keyboard {
                json!(["keyboard"])
            } else {
                json!([])
            };
            let _ = tx.send(json!({ "type": "configure_features", "features": features }));
            let _ = tx.send(json!({
                "type": "configure_manual_hotkey",
                "enabled": manual_mode && !manual_using_tauri,
                "hotkey": if manual_mode && !manual_using_tauri { show_hotkey } else { String::new() },
            }));
            let _ = tx.send(json!({
                "type": "configure_app_hotkeys",
                "hotkeys": server_app_hotkeys,
            }));
        }
    }

    fn on_global_shortcut_event(&self, app: &AppHandle, action_key: &str, pressed: bool) {
        if action_key == "showHotkey" {
            let (manual_mode, toggle_mode, suppressed, state_name) = {
                let inner = self.inner.lock().unwrap();
                let manual_mode = Self::manual_mode(&inner);
                let toggle_mode = inner
                    .user_settings
                    .get("manualModeType")
                    .and_then(Value::as_str)
                    .unwrap_or("hold")
                    .trim()
                    .eq_ignore_ascii_case("toggle");
                (
                    manual_mode,
                    toggle_mode,
                    inner.hotkey_suppressed_for_input_test,
                    inner.game_state.state.clone(),
                )
            };
            if !manual_mode || suppressed {
                return;
            }
            if pressed && !matches!(state_name.as_str(), "active" | "background") {
                return;
            }
            let transition = {
                let mut inner = self.inner.lock().unwrap();
                inner
                    .manual_hotkey
                    .handle_tauri_shortcut_signal(toggle_mode, pressed)
            };
            if let Some(active) = transition {
                self.emit_manual_hotkey_state(app, active);
            }
            return;
        }

        if !pressed {
            return;
        }
        self.dispatch_app_hotkey(app, action_key);
    }

    fn dispatch_app_hotkey(&self, app: &AppHandle, action_key: &str) {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.hotkey_suppressed_for_input_test {
                return;
            }
            let now = Instant::now();
            if inner
                .shortcut_cooldowns
                .get(action_key)
                .is_some_and(|last| now.duration_since(*last) < HOTKEY_COOLDOWN)
            {
                return;
            }
            inner.shortcut_cooldowns.insert(action_key.to_string(), now);
        }

        match action_key {
            "toggleFuriganaHotkey" => {
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_MAIN_LABEL,
                    "toggle-furigana-visibility",
                    &[],
                );
            }
            "translateHotkey" => {
                if let Err(error) = self.request_or_toggle_translation(app) {
                    desktop_state::emit_to_window(
                        app,
                        OVERLAY_MAIN_LABEL,
                        "translation-error",
                        &[json!({"error":error})],
                    );
                }
            }
            "liveStatsToggleHotkey" => {
                let next = {
                    let mut inner = self.inner.lock().unwrap();
                    let stats = inner.user_settings["showLiveStats"] != false;
                    let goals =
                        inner.user_settings["showLiveGoals"] != false && inner.goals_available;
                    let signature = |mode: &str| {
                        (
                            stats && matches!(mode, "stats" | "all"),
                            goals && matches!(mode, "goals" | "all"),
                        )
                    };
                    let current = signature(
                        inner
                            .user_settings
                            .get("liveStatsVisibilityMode")
                            .and_then(Value::as_str)
                            .unwrap_or("all"),
                    );
                    let mut modes: Vec<&str> = Vec::new();
                    for mode in ["stats", "goals", "hidden", "all"] {
                        let sig = signature(mode);
                        if (mode == "hidden" || sig != (false, false))
                            && !modes.iter().any(|m| signature(m) == sig)
                        {
                            modes.push(mode);
                        }
                    }
                    let next = modes[(modes
                        .iter()
                        .position(|m| signature(m) == current)
                        .map(|i| i + 1)
                        .unwrap_or(0))
                        % modes.len()];
                    inner
                        .user_settings
                        .insert("liveStatsVisibilityMode".into(), json!(next));
                    next
                };
                self.broadcast_settings_update(
                    app,
                    &Map::from_iter([("liveStatsVisibilityMode".into(), json!(next))]),
                );
            }
            "toggleWindowHotkey" => {
                desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "toggle-main-box", &[]);
            }
            "minimizeHotkey" => {
                let was_afk = self.inner.lock().unwrap().is_afk;
                self.wake_activity(app);
                if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                    if was_afk || win.is_minimized().unwrap_or(false) {
                        let _ = win.unminimize();
                        let _ = win.show();
                    } else {
                        let _ = win.minimize();
                    }
                }
            }
            "yomitanSettingsHotkey" => {
                self.open_dictionary_settings(app, false);
            }
            "overlaySettingsHotkey" => {
                let app_c = app.clone();
                let this_c = self.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = this_c.open_settings(&app_c, None).await;
                });
            }
            "texthookerHotkey" => {
                if app
                    .get_webview_window(OVERLAY_TEXTHOOKER_LABEL)
                    .is_some_and(|w| w.is_visible().unwrap_or(false))
                {
                    self.hide_aux_window(app, OVERLAY_TEXTHOOKER_LABEL);
                } else {
                    let _ = self.open_texthooker(app);
                }
            }
            "customPageHotkey" => {
                self.toggle_custom_page(app);
            }
            "vnGuideToggleHotkey" | "vnGuideNextHotkey" | "vnGuideBackHotkey" => {
                let action = match action_key {
                    "vnGuideToggleHotkey" => "toggle",
                    "vnGuideNextHotkey" => "next",
                    _ => "back",
                };
                let app_c = app.clone();
                let this_c = self.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = this_c.vn_guide_command(&app_c, action, None).await;
                });
            }
            "gamepadKeyboardHotkey" => {
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_MAIN_LABEL,
                    "gamepad-toggle-navigation",
                    &[json!({ "source": "hotkey" })],
                );
            }
            _ => {}
        }
    }

    fn emit_manual_hotkey_state(&self, app: &AppHandle, is_active: bool) {
        self.set_process_pause("manual_hotkey", is_active);
        let mut defer = false;
        if is_active {
            self.wake_activity(app);
            let mut inner = self.inner.lock().unwrap();
            let background = inner.user_settings["manual_mode_desktop_background"]
                .as_str()
                .unwrap_or("off");
            let neutral = inner.user_settings["manualModeInactiveBehavior"]
                == "disable-interaction"
                && inner.user_settings["manualModeDisableInteractionFocusOverlay"] != true;
            defer = background == "on_demand" && !neutral;
            if !neutral {
                inner.manual_focus_deadline =
                    Some(Instant::now() + Duration::from_millis(if defer { 650 } else { 0 }));
            }
            if let Some(tx) = &inner.ws2_tx {
                if inner.user_settings["manual_mode_desktop_background"] != "off" {
                    let _ = tx.send(Ws2Outbound::Direct(
                        json!({ "type": "manual-mode-background-request" }),
                    ));
                }
                if inner.user_settings["scan_on_overlay_activation"] == true {
                    let _ = tx.send(Ws2Outbound::Direct(json!({ "type": "manual-overlay-scan-request", "source": "overlay-activation:hotkey" })));
                }
            }
        } else {
            self.inner.lock().unwrap().manual_focus_deadline = None;
            self.restore_game_focus();
        }
        desktop_state::emit_to_window(
            app,
            OVERLAY_MAIN_LABEL,
            "show-overlay-hotkey",
            &[
                json!(is_active),
                json!({ "source": "overlay-hotkey", "deferRevealForBackground":defer }),
            ],
        );
        if is_active && !defer {
            self.finish_manual_focus(app);
        }
        self.sync_window_ignore_mouse(app);
    }

    fn open_dictionary_settings(&self, app: &AppHandle, jiten_tab: bool) {
        if jiten_tab {
            let app_c = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(dm) = app_c.try_state::<DictionaryManager>() {
                    if let Err(error) = dm.open_jiten_options(&app_c).await {
                        eprintln!("[overlay] Jiten settings: {error}");
                    }
                }
            });
            return;
        }
        let app_c = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(dm) = app_c.try_state::<DictionaryManager>() {
                if dm.open_selected_extension_options(&app_c).await.is_ok() {
                    return;
                }
            }
            if let Some(host) = app_c.try_state::<OverlayHost>() {
                let _ = host.open_settings(&app_c, Some("general")).await;
            }
        });
    }

    fn toggle_custom_page(&self, app: &AppHandle) {
        if let Some(win) = app.get_webview_window(OVERLAY_CUSTOM_PAGE_LABEL) {
            if win.is_visible().unwrap_or(false) {
                self.hide_aux_window(app, OVERLAY_CUSTOM_PAGE_LABEL);
            } else {
                let _ = win.show();
                let _ = win.set_focus();
            }
            return;
        }
        let (configured_url, saved_url, custom_profile_dir) = {
            let inner = self.inner.lock().unwrap();
            let enabled = inner
                .user_settings
                .get("customPageEnabled")
                .and_then(Value::as_bool)
                == Some(true);
            let url_str = inner
                .user_settings
                .get("customPageUrl")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if !enabled || url_str.is_empty() {
                return;
            }
            let normalized = normalize_custom_page_url(&url_str).unwrap_or_else(|| url_str.clone());
            let saved = inner
                .user_settings
                .get("customPageLastUrls")
                .and_then(|v| v.get(&normalized))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| inner.custom_page_saved_urls.get(&normalized).cloned());
            let prof = inner.overlay_data_dir.join("custom-pages");
            (url_str, saved, prof)
        };

        let Some(norm_url) =
            normalize_custom_page_url(saved_url.as_deref().unwrap_or(&configured_url))
                .or_else(|| normalize_custom_page_url(&configured_url))
        else {
            return;
        };
        let Ok(parsed) = url::Url::parse(&norm_url) else {
            return;
        };

        // Only window-local keyboard actions, with a separate web profile.
        let _ = std::fs::create_dir_all(&custom_profile_dir);
        let navigation_app = app.clone();
        let builder =
            WebviewWindowBuilder::new(app, OVERLAY_CUSTOM_PAGE_LABEL, WebviewUrl::External(parsed))
                .title("Custom Page")
                .decorations(false)
                .resizable(false)
                .initialization_script(AUX_WINDOW_SCRIPT)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(true)
                .on_navigation(|target| matches!(target.scheme(), "http" | "https"))
                .on_new_window(move |target, _| {
                    if matches!(target.scheme(), "http" | "https") {
                        if let Some(window) =
                            navigation_app.get_webview_window(OVERLAY_CUSTOM_PAGE_LABEL)
                        {
                            let _ = window.navigate(target);
                        }
                    }
                    tauri::webview::NewWindowResponse::Deny
                });
        let Ok(builder) =
            dictionary_host::apply_profile_data_directory(builder, &custom_profile_dir)
        else {
            return;
        };
        if let Ok(window) = builder.build() {
            self.install_aux_window(app, &window);
        }
    }

    // ---------- VN-Guide Async Control ----------

    async fn reconfigure_vn_guide(&self, app: &AppHandle, refresh: bool) {
        self.ensure_vn_guide_initialized(app).await;
        let snap = {
            let mut guard = self.vn_guide.lock().await;
            // Read after acquiring the controller so queued updates cannot restore stale selections.
            let settings = self.inner.lock().unwrap().user_settings.clone();
            let Some(ctrl) = guard.as_mut() else {
                return;
            };
            ctrl.configure(&settings, refresh).await
        };
        self.sync_vn_guide_hud_window(app, &snap);
        desktop_state::emit_to_window(app, OVERLAY_SETTINGS_LABEL, "vn-guide-state", &[snap]);
    }

    async fn sync_vn_guide_capture(&self, app: &AppHandle, available: bool, scene: Option<&str>) {
        self.ensure_vn_guide_initialized(app).await;
        let mut guard = self.vn_guide.lock().await;
        let Some(ctrl) = guard.as_mut() else {
            return;
        };
        let (patch, settings) = {
            let mut inner = self.inner.lock().unwrap();
            let patch = if let Some(scene) = scene
                .filter(|s| !s.trim().is_empty())
                .filter(|s| inner.vn_guide_scene.as_deref() != Some(*s))
            {
                let profile = backend_profile_name(&inner.profile_state).to_owned();
                let patch = select_guide_scene(&mut inner.user_settings, scene, &profile);
                inner.vn_guide_scene = Some(scene.to_owned());
                Self::persist_user_settings_locked(&inner);
                patch
            } else {
                Map::new()
            };
            (patch, inner.user_settings.clone())
        };
        if !patch.is_empty() {
            ctrl.set_available(false, scene);
            self.sync_vn_guide_hud_window(app, &ctrl.snapshot());
            self.broadcast_settings_update(app, &patch);
        }
        ctrl.configure(&settings, false).await;
        let changed = ctrl.set_available(available, scene);
        if changed || !patch.is_empty() {
            let snap = ctrl.snapshot();
            self.sync_vn_guide_hud_window(app, &snap);
            desktop_state::emit_to_window(app, OVERLAY_SETTINGS_LABEL, "vn-guide-state", &[snap]);
        }
    }

    async fn vn_guide_catalogue(&self, app: &AppHandle, request: &Value) -> Value {
        self.ensure_loaded(app);
        let selected = if request["chooseFolder"] == true {
            let Some(folder) = rfd::AsyncFileDialog::new()
                .set_title("Choose a guide catalogue folder")
                .pick_folder()
                .await
            else {
                return json!({"cancelled":true});
            };
            Some(folder.path().to_string_lossy().into_owned())
        } else {
            request
                .get("source")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let (saved, data_dir) = {
            let inner = self.inner.lock().unwrap();
            (
                inner
                    .user_settings
                    .get("vnGuideCatalogueSource")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                inner.overlay_data_dir.clone(),
            )
        };
        let source = match validated_catalogue_source(Some(selected.as_deref().unwrap_or(&saved))) {
            Ok(source) => source,
            Err(error) => return json!({"source":saved,"guides":[],"error":error}),
        };
        if selected.is_some() {
            self.apply_setting_updates(
                app,
                serde_json::from_value(json!({"vnGuideCatalogueSource":source})).unwrap(),
                false,
            );
        }
        // Catalogue refreshes can involve many requests; keep playback/selection responsive.
        let mut guard = self.vn_catalogue.lock().await;
        let store = guard.get_or_insert_with(|| GuideStore::new(Self::http_client(app), &data_dir));
        match store
            .list_catalogue(Some(&source), request["refresh"] == true)
            .await
        {
            Ok(result) => json!({"source":source,"guides":result.guides,"warning":result.warning}),
            Err(error) => json!({"source":source,"guides":[],"error":error}),
        }
    }

    async fn vn_guide_command(
        &self,
        app: &AppHandle,
        action: &str,
        value: Option<&Value>,
    ) -> Result<Value, String> {
        self.ensure_vn_guide_initialized(app).await;

        let mut imported = None;
        if matches!(action, "select-guide" | "choose-local" | "use-custom-page") {
            let url = match action {
                "choose-local" => {
                    let Some(folder) = rfd::AsyncFileDialog::new()
                        .set_title("Choose a game guide folder containing guide.json")
                        .pick_folder()
                        .await
                    else {
                        return Ok(self.vn_guide.lock().await.as_ref().unwrap().snapshot());
                    };
                    folder.path().to_string_lossy().into_owned()
                }
                "use-custom-page" => {
                    let current_url = app
                        .get_webview_window(OVERLAY_CUSTOM_PAGE_LABEL)
                        .and_then(|win| win.url().ok())
                        .map(|url| url.to_string());
                    let inner = self.inner.lock().unwrap();
                    let configured = inner
                        .user_settings
                        .get("customPageUrl")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let configured = normalize_custom_page_url(configured).unwrap_or_default();
                    current_url
                        .or_else(|| inner.custom_page_saved_urls.get(&configured).cloned())
                        .or_else(|| {
                            inner
                                .user_settings
                                .get("customPageLastUrls")?
                                .get(&configured)?
                                .as_str()
                                .map(str::to_owned)
                        })
                        .unwrap_or(configured)
                }
                _ => value
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_owned(),
            };
            let source = match parse_guide_url(&url) {
                Ok(source) => source,
                Err(error) => {
                    let mut snap = self.vn_guide.lock().await.as_ref().unwrap().snapshot();
                    snap["error"] = json!(error);
                    return Ok(snap);
                }
            };
            let mut patch = Map::new();
            patch.insert("vnGuideUrl".into(), json!(url));
            patch.insert("vnGuideRoute".into(), json!(""));
            patch.insert("vnGuideEnabled".into(), json!(true));
            self.apply_setting_updates(app, patch, false);
            imported = Some((url, source));
        }

        let (snap, switched_route) = {
            let mut guard = self.vn_guide.lock().await;
            let settings = self.inner.lock().unwrap().user_settings.clone();
            let ctrl = guard.as_mut().ok_or("VN Guide not initialized")?;
            if let Some((url, source)) = imported {
                let snap = ctrl.configure(&settings, false).await;
                if settings.get("vnGuideUrl").and_then(Value::as_str) == Some(&url) {
                    if let Some(step) = source
                        .step
                        .filter(|step| (*step as u64) < snap["total"].as_u64().unwrap_or(0))
                    {
                        ctrl.command("jump", Some(&json!(step)), &settings).await
                    } else {
                        (snap, None)
                    }
                } else {
                    (snap, None)
                }
            } else {
                ctrl.command(action, value, &settings).await
            }
        };
        if let Some(new_route) = switched_route {
            let mut patch = Map::new();
            patch.insert("vnGuideRoute".into(), json!(new_route));
            self.apply_setting_updates(app, patch, false);
        }
        self.sync_vn_guide_hud_window(app, &snap);
        desktop_state::emit_to_window(
            app,
            OVERLAY_SETTINGS_LABEL,
            "vn-guide-state",
            &[snap.clone()],
        );
        Ok(snap)
    }

    fn sync_vn_guide_hud_window(&self, app: &AppHandle, snap: &Value) {
        let visible = snap.get("visible").and_then(Value::as_bool) == Some(true);
        if !visible {
            if let Some(win) = app.get_webview_window(OVERLAY_VN_GUIDE_LABEL) {
                let _ = win.hide();
            }
            return;
        }
        let disp = {
            let inner = self.inner.lock().unwrap();
            Self::resolve_display(&inner)
        };
        let (ax, ay, aw, ah) = disp
            .as_ref()
            .map(|d| {
                (
                    d.work_area.x as i32,
                    d.work_area.y as i32,
                    d.work_area.width as i32,
                    d.work_area.height as i32,
                )
            })
            .unwrap_or((0, 0, 1280, 720));
        let (x, y, w, h) = compute_vn_guide_hud_bounds(ax, ay, aw, ah, snap);

        if let Some(win) = app.get_webview_window(OVERLAY_VN_GUIDE_LABEL) {
            let _ = win.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
            let _ = win.set_size(tauri::LogicalSize::new(w as f64, h as f64));
            let _ = win.show();
            desktop_state::emit_to_window(
                app,
                OVERLAY_VN_GUIDE_LABEL,
                "vn-guide-state",
                &[snap.clone()],
            );
            return;
        }

        let Ok(base_url) = self.mount_overlay_assets(app) else {
            return;
        };
        let token = self.register_window_access(app, OVERLAY_VN_GUIDE_LABEL, "vn-guide");
        let resources_dir = self.inner.lock().unwrap().overlay_resources_dir.clone();
        let init_script = overlay_vn_guide_hud_init_script(&token, &resources_dir);
        let Ok(url) = url::Url::parse(&format!("{base_url}vn_guide_hud.html")) else {
            return;
        };
        if let Ok(win) =
            WebviewWindowBuilder::new(app, OVERLAY_VN_GUIDE_LABEL, WebviewUrl::External(url))
                .title("VN Guide")
                .transparent(true)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focusable(false)
                .position(x as f64, y as f64)
                .inner_size(w as f64, h as f64)
                .visible(true)
                .initialization_script(&init_script)
                .build()
        {
            let _ = window_platform::apply(&win, "frameless", &Value::Null);
            desktop_state::emit_to_window(
                app,
                OVERLAY_VN_GUIDE_LABEL,
                "vn-guide-state",
                &[snap.clone()],
            );
        }
    }

    // ---------- Magpie & Pointer Projection ----------

    pub fn handle_window_pointer(&self, app: &AppHandle, label: &str, point: &Value) {
        if label == OVERLAY_MAIN_LABEL && self.inner.lock().unwrap().magpie_info.is_none() {
            desktop_state::emit_to_window(
                app,
                OVERLAY_MAIN_LABEL,
                "text-hover-pointer",
                std::slice::from_ref(point),
            );
        }
    }

    pub fn handle_window_event_or_message(
        &self,
        app: &AppHandle,
        label: &str,
        message: u32,
        _wparam: &str,
        _lparam: &str,
        event: Option<&str>,
    ) {
        if label != OVERLAY_MAIN_LABEL {
            return;
        }
        let scaling_msg = self.inner.lock().unwrap().magpie_scaling_msg;
        if (scaling_msg != 0 && message == scaling_msg) || event == Some("native-reorder") {
            // WinEvent can reenter while restacking. Leave its callback before
            // inspecting or changing window order.
            let host = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                host.refresh_magpie_state(&app);
            });
        }
    }

    fn refresh_magpie_state(&self, app: &AppHandle) {
        let compat_enabled = self
            .inner
            .lock()
            .unwrap()
            .user_settings
            .get("magpieCompatibility")
            .and_then(Value::as_bool)
            != Some(false);
        let target = self.inner.lock().unwrap().target_hwnd;
        let native_info = if compat_enabled {
            read_native_magpie_info().filter(|info| Some(info.source_hwnd) == target)
        } else {
            None
        };
        if let (Some(info), Some(win)) = (
            native_info.as_ref(),
            app.get_webview_window(OVERLAY_MAIN_LABEL),
        ) {
            #[cfg(windows)]
            if source_focused(info)
                && win
                    .hwnd()
                    .is_ok_and(|hwnd| is_window_above(info.hwnd, hwnd.0 as isize))
            {
                let _ = win.show();
                let _ = win.set_always_on_top(true);
                let _ = window_platform::apply(&win, "moveTop", &Value::Null);
            }
        }
        let mut inner = self.inner.lock().unwrap();
        let changed = inner.magpie_info != native_info;
        inner.magpie_info = native_info.clone();
        if !changed {
            return;
        }
        let payload = magpie_info_to_renderer_json(native_info.as_ref());
        inner.magpie_pointer_pending = None;
        if let Some(tx) = &inner.ws2_tx {
            let _ = tx.send(Ws2Outbound::CoalescedMagpie(json!({
                "type": "magpie-state-request",
            })));
        }
        drop(inner);
        desktop_state::emit_to_window(
            app,
            OVERLAY_MAIN_LABEL,
            "overlay-websocket-data",
            &[
                json!({ "type": "ws2", "data": json!({"type":"magpie-info", "info":payload}).to_string() }),
            ],
        );
        if native_info.is_none() {
            let mut inner = self.inner.lock().unwrap();
            if inner.magpie_hovering {
                inner.magpie_hovering = false;
                drop(inner);
                self.sync_window_ignore_mouse(app);
            }
            desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "magpie-pointer-reset", &[]);
        }
    }

    // ---------- Background Workers ----------

    fn spawn_ws1_worker(&self, app: AppHandle, generation: u64) {
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut backoff = 500;
            loop {
                let url = {
                    let inner = host.inner.lock().unwrap();
                    if !inner.running || inner.worker_gen != generation {
                        break;
                    }
                    inner.user_settings["weburl1"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned()
                };
                if let Ok(Ok((mut socket, _))) =
                    tokio::time::timeout(Duration::from_secs(5), connect_async(&url)).await
                {
                    backoff = 500;
                    {
                        let mut inner = host.inner.lock().unwrap();
                        if !inner.running || inner.worker_gen != generation {
                            return;
                        }
                        inner.ws1_connected = true;
                    }
                    desktop_state::emit_to_window(
                        &app,
                        OVERLAY_SETTINGS_LABEL,
                        "websocket-opened",
                        &[json!("ws1")],
                    );
                    desktop_state::emit_to_window(
                        &app,
                        OVERLAY_MAIN_LABEL,
                        "overlay-websocket-state",
                        &[json!({"type":"ws1","open":true})],
                    );
                    let mut tick = tokio::time::interval(Duration::from_secs(1));
                    loop {
                        tokio::select! {
                            _ = tick.tick() => {
                                let inner = host.inner.lock().unwrap();
                                if !inner.running || inner.worker_gen != generation { return; }
                            }
                            frame = socket.next() => match frame {
                                Some(Ok(Message::Text(text))) => desktop_state::emit_to_window(&app, OVERLAY_MAIN_LABEL, "overlay-websocket-data", &[json!({"type":"ws1","data":text.as_str()})]),
                                Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break; } },
                                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                _ => {},
                            }
                        }
                    }
                }
                {
                    let mut inner = host.inner.lock().unwrap();
                    if !inner.running || inner.worker_gen != generation {
                        return;
                    }
                    inner.ws1_connected = false;
                }
                desktop_state::emit_to_window(
                    &app,
                    OVERLAY_SETTINGS_LABEL,
                    "websocket-closed",
                    &[json!("ws1")],
                );
                desktop_state::emit_to_window(
                    &app,
                    OVERLAY_MAIN_LABEL,
                    "overlay-websocket-state",
                    &[json!({"type":"ws1","open":false})],
                );
                tokio::time::sleep(Duration::from_millis(backoff)).await;
                backoff = (backoff * 2).min(5000);
            }
        });
    }

    fn spawn_ws2_worker(&self, app: AppHandle, gen: u64) {
        let (tx, mut rx) = mpsc::unbounded_channel::<Ws2Outbound>();
        {
            self.inner.lock().unwrap().ws2_tx = Some(tx);
        }
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut backoff_ms = 500u64;
            loop {
                let (still_running, initial_url, single_port) = {
                    let inner = host.inner.lock().unwrap();
                    (
                        inner.running && inner.worker_gen == gen,
                        inner
                            .user_settings
                            .get("weburl2")
                            .and_then(Value::as_str)
                            .unwrap_or("ws://localhost:7275/ws/overlay")
                            .to_string(),
                        inner.single_port,
                    )
                };
                if !still_running {
                    break;
                }

                // Resolve URL or discover via /get_websocket_port on single_port
                let ws_url = match connect_async(&initial_url).await {
                    Ok(conn) => Ok(conn),
                    Err(first_err) => {
                        let http = OverlayHost::http_client(&app);
                        let fallback_port = http
                            .get(format!("http://127.0.0.1:{single_port}/get_websocket_port"))
                            .timeout(Duration::from_secs(2))
                            .send()
                            .await
                            .ok()
                            .and_then(|r| {
                                if r.status().is_success() {
                                    Some(r)
                                } else {
                                    None
                                }
                            });
                        if let Some(resp) = fallback_port {
                            if let Ok(json_body) = resp.json::<Value>().await {
                                let port = json_body["port"].as_u64().unwrap_or(single_port as u64);
                                let next_url = format!("ws://127.0.0.1:{port}/ws/overlay");
                                connect_async(&next_url).await
                            } else {
                                Err(first_err)
                            }
                        } else {
                            Err(first_err)
                        }
                    }
                };

                let Ok((mut socket, _)) = ws_url else {
                    {
                        let mut inner = host.inner.lock().unwrap();
                        if !inner.running || inner.worker_gen != gen {
                            return;
                        }
                        inner.ws2_connected = false;
                        inner.capture_available = Some(false);
                    }
                    host.sync_game_visibility(&app);
                    if let Some(overlay) = app.try_state::<crate::overlay::Overlay>() {
                        let _ = overlay.command(OVERLAY_MAIN_LABEL, json!({ "action": "stop" }));
                    }
                    desktop_state::emit_to_window(
                        &app,
                        OVERLAY_MAIN_LABEL,
                        "overlay-websocket-state",
                        &[json!({ "type": "ws2", "open": false })],
                    );
                    desktop_state::emit_to_window(
                        &app,
                        OVERLAY_SETTINGS_LABEL,
                        "websocket-closed",
                        &[json!("ws2")],
                    );
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 2).min(5000);
                    continue;
                };

                backoff_ms = 500;
                // Commands tied to the old focus/capture state must never replay
                // into a newly selected game. Persisted setting edits are sent below.
                while rx.try_recv().is_ok() {}
                {
                    let mut inner = host.inner.lock().unwrap();
                    if !inner.running || inner.worker_gen != gen {
                        return;
                    }
                    inner.ws2_connected = true;
                }
                desktop_state::emit_to_window(
                    &app,
                    OVERLAY_MAIN_LABEL,
                    "overlay-websocket-state",
                    &[json!({ "type": "ws2", "open": true })],
                );
                desktop_state::emit_to_window(
                    &app,
                    OVERLAY_SETTINGS_LABEL,
                    "websocket-opened",
                    &[json!("ws2")],
                );

                // Initial handshake: sync GSM-owned config + profile state
                for source in [
                    "manual_hotkey",
                    "texthooker_hotkey",
                    "gamepad_navigation",
                    "gamepad_manual_pause",
                ] {
                    let _ = socket.send(Message::Text(json!({"type":"process-pause-request","action":"resume","source":source}).to_string().into())).await;
                }
                let pending = host.inner.lock().unwrap().pending_config.clone();
                if !pending.is_empty() {
                    if socket
                        .send(Message::Text(
                            json!({"type":"set-gsm-overlay-config", "settings":pending})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .is_err()
                    {
                        continue;
                    }
                }
                let _ = socket
                    .send(Message::Text(
                        json!({ "type": "get-gsm-overlay-config" })
                            .to_string()
                            .into(),
                    ))
                    .await;
                let _ = socket
                    .send(Message::Text(
                        json!({ "type": "get-gsm-profile-state" })
                            .to_string()
                            .into(),
                    ))
                    .await;

                loop {
                    tokio::select! {
                        biased;
                        maybe_out = rx.recv() => {
                            let Some(first) = maybe_out else {
                                break;
                            };
                            // Coalesce bursty outbound messages cleanly
                            let mut latest_config: Option<Value> = None;
                            let mut latest_magpie: Option<Value> = None;
                            let mut directs: Vec<Value> = Vec::new();
                            let push_item = |item: Ws2Outbound, lc: &mut Option<Value>, lm: &mut Option<Value>, dr: &mut Vec<Value>| {
                                match item {
                                    Ws2Outbound::CoalescedConfig(v) => merge_config_message(lc, v),
                                    Ws2Outbound::CoalescedMagpie(v) => *lm = Some(v),
                                    Ws2Outbound::Direct(v) => dr.push(v),
                                }
                            };
                            push_item(first, &mut latest_config, &mut latest_magpie, &mut directs);
                            while let Ok(more) = rx.try_recv() {
                                push_item(more, &mut latest_config, &mut latest_magpie, &mut directs);
                            }
                            let mut send_ok = true;
                            for msg in directs.into_iter().chain(latest_config).chain(latest_magpie) {
                                if socket.send(Message::Text(msg.to_string().into())).await.is_err() {
                                    send_ok = false;
                                    break;
                                }
                            }
                            if !send_ok {
                                break;
                            }
                        }
                        frame = socket.next() => {
                            let still = {
                                let inner = host.inner.lock().unwrap();
                                inner.running && inner.worker_gen == gen
                            };
                            if !still {
                                let _ = socket.close(None).await;
                                return;
                            }
                            match frame {
                                Some(Ok(Message::Text(txt))) => {
                                    host.handle_ws2_text(&app, &txt).await;
                                }
                                Some(Ok(Message::Ping(p))) => {
                                    let _ = socket.send(Message::Pong(p)).await;
                                }
                                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                _ => {}
                            }
                        }
                    }
                }
                {
                    let mut inner = host.inner.lock().unwrap();
                    if !inner.running || inner.worker_gen != gen {
                        return;
                    }
                    inner.ws2_connected = false;
                    inner.capture_available = Some(false);
                }
                host.sync_game_visibility(&app);
                if let Some(overlay) = app.try_state::<crate::overlay::Overlay>() {
                    let _ = overlay.command(OVERLAY_MAIN_LABEL, json!({ "action": "stop" }));
                }
                desktop_state::emit_to_window(
                    &app,
                    OVERLAY_MAIN_LABEL,
                    "overlay-websocket-state",
                    &[json!({ "type": "ws2", "open": false })],
                );
                desktop_state::emit_to_window(
                    &app,
                    OVERLAY_SETTINGS_LABEL,
                    "websocket-closed",
                    &[json!("ws2")],
                );
            }
        });
    }

    fn sync_native_context(&self, app: &AppHandle, message: &Value) {
        if let Some(config) = message.get("config") {
            let updates = {
                let mut inner = self.inner.lock().unwrap();
                inner.target_hwnd = config["target_id"].as_u64();
                if let Some(available) = config["available"].as_bool() {
                    inner.capture_available = Some(available);
                }
                [
                    "monitor_to_capture",
                    "monitor_to_capture_id",
                    "monitor_to_capture_bounds",
                ]
                .into_iter()
                .filter_map(|key| {
                    config["settings"]
                        .get(key)
                        .filter(|v| inner.user_settings.get(key) != Some(*v))
                        .map(|value| (key.to_owned(), value.clone()))
                })
                .collect::<Map<String, Value>>()
            };
            if !updates.is_empty() {
                self.apply_setting_updates(app, updates, true);
            }
            self.sync_game_visibility(app);
        }
    }

    pub(crate) async fn handle_ws2_text(&self, app: &AppHandle, raw_txt: &str) {
        if raw_txt == "True" || raw_txt == "False" {
            self.publish_ws2_data(app, raw_txt, None).await;
            return;
        }
        let Ok(msg) = serde_json::from_str::<Value>(raw_txt) else {
            self.publish_ws2_data(app, raw_txt, None).await;
            return;
        };
        if !msg.is_object() {
            self.publish_ws2_data(app, raw_txt, None).await;
            return;
        }
        let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or("");
        match msg_type {
            "native-overlay-command" => {
                self.sync_native_context(app, &msg);
                let mut msg = msg.clone();
                if msg["config"].is_object() {
                    msg["config"]["obs"] = app
                        .try_state::<crate::obs::Obs>()
                        .and_then(|obs| obs.startup_config().ok())
                        .unwrap_or(Value::Null);
                }
                if let Some(overlay) = app.try_state::<crate::overlay::Overlay>() {
                    if app.get_webview_window(OVERLAY_MAIN_LABEL).is_some()
                        || msg["action"] == "stop"
                    {
                        if let Ok(result) = overlay.command(OVERLAY_MAIN_LABEL, msg.clone()) {
                            if result["clear"] == true {
                                crate::overlay::clear(app, OVERLAY_MAIN_LABEL);
                            }
                        }
                    }
                }
            }
            "dictionary-setup" => {
                let app_clone = app.clone();
                let msg_clone = msg.clone();
                let host = self.clone();
                tauri::async_runtime::spawn(async move {
                    let resp =
                        crate::reader_service::handle_ws2_dictionary_setup(&app_clone, &msg_clone)
                            .await;
                    let tx = host.inner.lock().unwrap().ws2_tx.clone();
                    if let Some(tx) = tx {
                        let _ = tx.send(Ws2Outbound::Direct(resp));
                    }
                });
            }
            "anki-setup-yomitan" => {
                let app_clone = app.clone();
                let msg_clone = msg.clone();
                let host = self.clone();
                tauri::async_runtime::spawn(async move {
                    let resp =
                        crate::reader_service::handle_ws2_anki_setup(&app_clone, &msg_clone).await;
                    let tx = host.inner.lock().unwrap().ws2_tx.clone();
                    if let Some(tx) = tx {
                        let _ = tx.send(Ws2Outbound::Direct(resp));
                    }
                });
            }
            "window_state" => {
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.target_hwnd = msg["target_hwnd"].as_u64();
                    inner.last_window_state = Some(msg.clone());
                    inner.game_state.state = msg["data"].as_str().unwrap_or("unknown").to_owned();
                }
                self.publish_ws2_data(app, raw_txt, Some(&msg)).await;
                self.refresh_magpie_state(app);
                self.sync_game_visibility(app);
            }
            "capture_status" => {
                let state = msg
                    .get("window_state")
                    .and_then(Value::as_str)
                    .unwrap_or("closed")
                    .to_string();
                let scene = msg
                    .get("scene_name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let avail = msg.get("available").and_then(Value::as_bool) == Some(true)
                    && state != "closed";
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.game_state.state = state.clone();
                    if scene.is_some() {
                        inner.game_state.game = scene.clone();
                    }
                    inner.vn_guide_available = avail;
                    inner.capture_available = Some(avail);
                }
                self.sync_vn_guide_capture(app, avail, scene.as_deref())
                    .await;
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_MAIN_LABEL,
                    "game-state",
                    &[json!(state)],
                );
                self.sync_game_visibility(app);
            }
            "gsm-overlay-config-updated" | "gsm_overlay_config" | "gsm-overlay-config" => {
                if let Some(cfg_map) = msg
                    .get("settings")
                    .or_else(|| msg.get("config"))
                    .unwrap_or(&msg)
                    .as_object()
                {
                    let changed_patch = {
                        let mut inner = self.inner.lock().unwrap();
                        // Do not let an older handshake overwrite edits awaiting an
                        // acknowledgement. Only matching authoritative values clear them.
                        let pending_before = inner.pending_config.len();
                        inner
                            .pending_config
                            .retain(|key, value| cfg_map.get(key) != Some(value));
                        let cfg_map: Map<String, Value> = cfg_map
                            .iter()
                            .filter(|(key, _)| !inner.pending_config.contains_key(*key))
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect();
                        let changed =
                            apply_gsm_owned_config_update(&mut inner.user_settings, &cfg_map);
                        if !changed.is_empty() || pending_before != inner.pending_config.len() {
                            Self::persist_user_settings_locked(&inner);
                        }
                        changed.into_iter().collect::<Map<String, Value>>()
                    };
                    if !changed_patch.is_empty() {
                        self.apply_setting_updates(app, changed_patch, true);
                    }
                }
            }
            "gsm-profile-state" | "gsm_profile_state" | "gsm-profile-state-updated" => {
                let state_val = msg.get("state").unwrap_or(&msg).clone();
                let mut inner = self.inner.lock().unwrap();
                inner.profile_state = state_val.clone();
                let swapped = apply_backend_profile_state(&mut inner.user_settings, &state_val);
                let ui_state = overlay_profile_state(&inner.user_settings, &state_val);
                if swapped {
                    Self::persist_user_settings_locked(&inner);
                    let snap = build_profile_snapshot(&inner.user_settings);
                    drop(inner);
                    // Profile switches must reconfigure native hotkeys, timers and windows too.
                    self.apply_setting_updates(app, snap, true);
                } else {
                    drop(inner);
                }
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_SETTINGS_LABEL,
                    "overlay-profile-state-updated",
                    &[ui_state],
                );
            }
            "translation-result" => {
                let translation = msg
                    .get("data")
                    .or_else(|| msg.get("translation"))
                    .or_else(|| msg.get("text"))
                    .cloned()
                    .unwrap_or_else(|| msg.clone());
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_MAIN_LABEL,
                    "translation-received",
                    &[translation],
                );
            }
            "translation-error" => {
                self.inner.lock().unwrap().translation_requested = false;
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_MAIN_LABEL,
                    "translation-error",
                    &[msg.clone()],
                );
            }
            "magpie-state-request" => {
                self.refresh_magpie_state(app);
            }
            "open-gsm-settings" | "open_overlay_settings" | "open-overlay-settings" => {
                let tab = msg.get("tab").and_then(Value::as_str);
                let _ = self.open_settings(app, tab).await;
            }
            "shutdown-overlay" => {
                self.stop(app).await;
            }
            "anki-confirmation-closed" => {
                let navigation = self.inner.lock().unwrap().navigation_active;
                let mut return_overlay = false;
                #[cfg(windows)]
                if navigation {
                    if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                        if let Ok(hwnd) = win.hwnd() {
                            return_overlay = msg["previousForegroundHwnd"].as_str()
                                == Some(&(hwnd.0 as usize).to_string());
                        }
                    }
                }
                if return_overlay && Self::capture_available(&self.inner.lock().unwrap()) {
                    if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                        let _ = win.set_focusable(true);
                        let _ = window_platform::apply(&win, "focus", &Value::Null);
                    }
                } else {
                    self.restore_game_focus();
                }
            }
            "restore-focus-result" => {
                if msg["success"] == true {
                    self.sync_window_ignore_mouse(app);
                }
            }
            "quick-action-result" => {}
            "live_stats_update" => {
                if msg.get("scope").and_then(Value::as_str) != Some("today")
                    && msg.get("session_active").and_then(Value::as_bool) == Some(true)
                {
                    let mut inner = self.inner.lock().unwrap();
                    let enabled = inner
                        .user_settings
                        .get("pomodoroEnabled")
                        .and_then(Value::as_bool)
                        == Some(true);
                    let auto_start = inner
                        .user_settings
                        .get("pomodoroAutoStart")
                        .and_then(Value::as_bool)
                        == Some(true);
                    if enabled && auto_start && !inner.pomodoro.started {
                        inner.pomodoro.started = true;
                        inner.pomodoro.last_tick = Some(Instant::now());
                        inner.pomodoro.enabled = true;
                        inner.pomodoro.active = true;
                        inner.pomodoro.mode = "work".into();
                        let mins = inner
                            .user_settings
                            .get("pomodoroWorkMinutes")
                            .and_then(Value::as_f64)
                            .unwrap_or(25.0)
                            .clamp(1.0, 180.0);
                        inner.pomodoro.remaining_secs = (mins * 60.0).round() as i64;
                    }
                }
                self.publish_ws2_data(app, raw_txt, Some(&msg)).await;
            }
            _ => {
                self.publish_ws2_data(app, raw_txt, Some(&msg)).await;
            }
        }
    }

    async fn publish_ws2_data(&self, app: &AppHandle, raw_txt: &str, parsed: Option<&Value>) {
        if let Some(val) = parsed {
            self.ensure_vn_guide_initialized(app).await;
            let (changed, snap) = {
                let mut guard = self.vn_guide.lock().await;
                if let Some(ctrl) = guard.as_mut() {
                    let ch = ctrl.observe(val);
                    (ch, Some(ctrl.snapshot()))
                } else {
                    (false, None)
                }
            };
            if changed {
                if let Some(s) = snap {
                    self.sync_vn_guide_hud_window(app, &s);
                    desktop_state::emit_to_window(
                        app,
                        OVERLAY_SETTINGS_LABEL,
                        "vn-guide-state",
                        &[s],
                    );
                }
            }
        }
        desktop_state::emit_to_window(
            app,
            OVERLAY_MAIN_LABEL,
            "overlay-websocket-data",
            &[json!({ "type": "ws2", "data": raw_txt })],
        );
    }

    fn spawn_input_server_worker(&self, app: AppHandle, gen: u64) {
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        {
            self.inner.lock().unwrap().input_tx = Some(tx);
        }
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut backoff_ms = 500u64;
            loop {
                let (still, port) = {
                    let inner = host.inner.lock().unwrap();
                    (
                        inner.running && inner.worker_gen == gen,
                        resolve_gamepad_port(&inner.user_settings, Some(&app)),
                    )
                };
                if !still {
                    break;
                }
                let ws_url = format!("ws://127.0.0.1:{port}");
                let Ok((mut socket, _)) = connect_async(&ws_url).await else {
                    {
                        let mut inner = host.inner.lock().unwrap();
                        if !inner.running || inner.worker_gen != gen {
                            return;
                        }
                        inner.input_server_connected = false;
                    }
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    backoff_ms = (backoff_ms * 2).min(4000);
                    continue;
                };
                backoff_ms = 500;
                while rx.try_recv().is_ok() {}
                {
                    let mut inner = host.inner.lock().unwrap();
                    if !inner.running || inner.worker_gen != gen {
                        return;
                    }
                    inner.input_server_connected = true;
                }
                // The service uses an OS-assigned port. Renderer tokenization opens its
                // own connection and must receive this endpoint after every reconnect.
                host.broadcast_settings_update(&app, &Map::new());
                host.sync_all_hotkeys(&app);

                loop {
                    tokio::select! {
                        biased;
                        maybe_out = rx.recv() => {
                            let Some(val) = maybe_out else {
                                break;
                            };
                            if socket.send(Message::Text(val.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                        frame = socket.next() => {
                            let still = {
                                let inner = host.inner.lock().unwrap();
                                inner.running && inner.worker_gen == gen
                            };
                            if !still {
                                let _ = socket.close(None).await;
                                return;
                            }
                            match frame {
                                Some(Ok(Message::Text(txt))) => {
                                    if let Ok(val) = serde_json::from_str::<Value>(&txt) {
                                        host.handle_input_server_msg(&app, &val);
                                    }
                                }
                                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                _ => {}
                            }
                        }
                    }
                }
                {
                    let mut inner = host.inner.lock().unwrap();
                    if !inner.running || inner.worker_gen != gen {
                        return;
                    }
                    inner.input_server_connected = false;
                    inner.keyboard_available = false;
                    inner.keyboard_error = Some("Input service disconnected".into());
                }
                host.reset_interactions(&app);
                host.push_preload_settings(&app);
            }
        });
    }

    fn handle_input_server_msg(&self, app: &AppHandle, msg: &Value) {
        let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or("");
        match msg_type {
            "manual_hotkey_event" => {
                let pressed = msg.get("state").and_then(Value::as_str) == Some("pressed");
                let (manual_mode, toggle_mode, suppressed, game_state) = {
                    let inner = self.inner.lock().unwrap();
                    let mm = Self::manual_mode(&inner);
                    let tm = inner
                        .user_settings
                        .get("manualModeType")
                        .and_then(Value::as_str)
                        .unwrap_or("hold")
                        .trim()
                        .eq_ignore_ascii_case("toggle");
                    (
                        mm,
                        tm,
                        inner.hotkey_suppressed_for_input_test,
                        inner.game_state.state.clone(),
                    )
                };
                if !manual_mode || suppressed {
                    return;
                }
                if pressed && !matches!(game_state.as_str(), "active" | "background") {
                    return;
                }
                let transition = {
                    let mut inner = self.inner.lock().unwrap();
                    if pressed {
                        inner.manual_hotkey.handle_press(toggle_mode)
                    } else {
                        inner.manual_hotkey.handle_release(toggle_mode)
                    }
                };
                if let Some(active) = transition {
                    self.emit_manual_hotkey_state(app, active);
                }
            }
            "app_hotkey_event" => {
                if msg.get("state").and_then(Value::as_str) == Some("pressed") {
                    if let Some(id) = msg.get("id").and_then(Value::as_str) {
                        self.dispatch_app_hotkey(app, id);
                    }
                }
            }
            "keyboard_listener_status" => {
                let avail = msg
                    .get("available")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let err = msg.get("error").and_then(Value::as_str).map(str::to_string);
                let mut inner = self.inner.lock().unwrap();
                inner.keyboard_available = avail;
                inner.keyboard_error = err;
                drop(inner);
                self.push_preload_settings(app);
            }
            "sudachi_progress" | "sudachi_status" | "sudachi_dictionary_changed" => {
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_SETTINGS_LABEL,
                    "sudachi-progress",
                    std::slice::from_ref(msg),
                );
            }
            _ => {}
        }
    }

    fn spawn_maintenance_worker(&self, app: AppHandle, gen: u64) {
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(1));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut monitor_tick = 0u8;
            loop {
                ticker.tick().await;
                let (still, afk_hide_mins, afk_already, pomo_emit) = {
                    let mut inner = host.inner.lock().unwrap();
                    if !inner.running || inner.worker_gen != gen {
                        break;
                    }
                    let afk_mins = inner
                        .user_settings
                        .get("afkTimer")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    let afk_due = afk_mins > 0.0
                        && !inner.is_afk
                        && inner.last_ocr_activity.elapsed()
                            >= Duration::from_secs_f64(afk_mins * 60.0);
                    if afk_due {
                        inner.is_afk = true;
                    }

                    let work = inner.user_settings["pomodoroWorkMinutes"]
                        .as_i64()
                        .unwrap_or(25)
                        .clamp(1, 180)
                        * 60;
                    let rest = inner.user_settings["pomodoroBreakMinutes"]
                        .as_i64()
                        .unwrap_or(5)
                        .clamp(1, 180)
                        * 60;
                    let pomo_should_emit = inner.pomodoro.tick(Instant::now(), work, rest);
                    (true, afk_due, inner.is_afk, pomo_should_emit)
                };
                if !still {
                    break;
                }
                if afk_hide_mins && afk_already {
                    desktop_state::emit_to_window(
                        &app,
                        OVERLAY_MAIN_LABEL,
                        "afk-hide",
                        &[json!(true)],
                    );
                }
                if pomo_emit {
                    host.emit_pomodoro_state(&app);
                }
                let focus_due = host
                    .inner
                    .lock()
                    .unwrap()
                    .manual_focus_deadline
                    .is_some_and(|at| Instant::now() >= at);
                if focus_due {
                    host.finish_manual_focus(&app);
                }
                monitor_tick = (monitor_tick + 1) % 5;
                if monitor_tick == 0 {
                    let displays = collect_displays(&app);
                    let changed = {
                        let mut inner = host.inner.lock().unwrap();
                        if displays.is_empty() || displays == inner.displays {
                            false
                        } else {
                            inner.displays = displays;
                            true
                        }
                    };
                    if changed {
                        host.reposition_main_overlay(&app);
                        host.push_display_info(&app);
                        host.push_preload_settings(&app);
                    }
                }
            }
        });
    }

    fn spawn_magpie_worker(&self, app: AppHandle, gen: u64) {
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut last_captured: Option<bool> = None;
            let mut idle_ticks = 0u32;
            loop {
                let (still, compat, has_magpie) = {
                    let inner = host.inner.lock().unwrap();
                    (
                        inner.running && inner.worker_gen == gen,
                        inner
                            .user_settings
                            .get("magpieCompatibility")
                            .and_then(Value::as_bool)
                            != Some(false),
                        inner.magpie_info.is_some(),
                    )
                };
                if !still {
                    break;
                }
                if !compat {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }

                // Re-probe Magpie presence periodically (~250ms idle, 16ms when actively scaled & moving)
                if !has_magpie || idle_ticks % 16 == 0 {
                    host.refresh_magpie_state(&app);
                }
                idle_ticks = idle_ticks.wrapping_add(1);

                let magpie_opt = host.inner.lock().unwrap().magpie_info.clone();
                let Some(magpie) = magpie_opt else {
                    last_captured = None;
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                };

                if !app
                    .get_webview_window(OVERLAY_MAIN_LABEL)
                    .is_some_and(|window| window.is_visible().unwrap_or(false))
                {
                    host.inner.lock().unwrap().magpie_pointer_pending = None;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }

                if let Some(sample) = sample_pointer() {
                    let captured = cursor_captured(&magpie);
                    if last_captured.is_some_and(|previous| previous != captured) {
                        last_captured = Some(captured);
                        host.inner.lock().unwrap().magpie_pointer_pending = None;
                        tokio::time::sleep(Duration::from_millis(16)).await;
                        continue;
                    }
                    last_captured = Some(captured);
                    let waiting = host
                        .inner
                        .lock()
                        .unwrap()
                        .magpie_pointer_pending
                        .is_some_and(|(_, at)| at.elapsed() < Duration::from_millis(100));
                    if !waiting {
                        if let Some((mx, my)) = if captured {
                            // An out-of-source sample must clear the previous hit.
                            project_magpie_cursor(sample.x as f64, sample.y as f64, &magpie)
                                .or(Some((-1.0e12, -1.0e12)))
                        } else {
                            Some((sample.x as f64, sample.y as f64))
                        } {
                            #[cfg(windows)]
                            let overlay_hwnd = app
                                .get_webview_window(OVERLAY_MAIN_LABEL)
                                .and_then(|w| w.hwnd().ok())
                                .map(|h| h.0 as isize)
                                .unwrap_or(0);
                            #[cfg(not(windows))]
                            let overlay_hwnd = 0;
                            if !is_window_above(magpie.hwnd, overlay_hwnd) {
                                let seq = {
                                    let mut inner = host.inner.lock().unwrap();
                                    inner.magpie_pointer_seq =
                                        inner.magpie_pointer_seq.saturating_add(1);
                                    inner.magpie_pointer_pending =
                                        Some((inner.magpie_pointer_seq, Instant::now()));
                                    inner.magpie_pointer_seq
                                };
                                let sig = renderer_signature(&magpie);
                                desktop_state::emit_to_window(
                                    &app,
                                    OVERLAY_MAIN_LABEL,
                                    "magpie-pointer",
                                    &[json!({
                                        "sequence": seq,
                                        "signature": sig,
                                        "x": mx,
                                        "y": my,
                                        "screenX": sample.x,
                                        "screenY": sample.y,
                                        "buttons": sample.buttons,
                                        "captured": captured,
                                        "shiftKey": sample.shift, "ctrlKey": sample.ctrl,
                                        "altKey": sample.alt, "metaKey": sample.meta,
                                    })],
                                );
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(16)).await;
            }
        });
    }

    // ---------- IPC Dispatch (`handle_send` / `handle_invoke`) ----------

    pub async fn handle_send(
        &self,
        app: &AppHandle,
        label: &str,
        channel: &str,
        args: &[Value],
    ) -> bool {
        self.ensure_loaded(app);
        let first = args.first().cloned().unwrap_or(Value::Null);

        match channel {
            "setting-changed" => {
                if let Some(key) = first.get("key").and_then(Value::as_str) {
                    let val = first.get("value").cloned().unwrap_or(Value::Null);
                    let mut map = Map::new();
                    map.insert(key.to_string(), val);
                    self.apply_setting_updates(app, map, false);
                }
                true
            }
            "save-settings" => {
                if let Some(obj) = first.as_object() {
                    self.apply_setting_updates(app, obj.clone(), false);
                }
                true
            }
            "set-platform-override" => {
                let mut map = Map::new();
                map.insert("platformOverride".into(), first);
                self.apply_setting_updates(app, map, false);
                true
            }
            "save-offset" => {
                if let Some(obj) = first.as_object() {
                    let mut map = Map::new();
                    if let Some(x) = obj.get("offsetX") {
                        map.insert("offsetX".into(), x.clone());
                    }
                    if let Some(y) = obj.get("offsetY") {
                        map.insert("offsetY".into(), y.clone());
                    }
                    self.apply_setting_updates(app, map, false);
                    desktop_state::emit_to_window(
                        app,
                        OVERLAY_SETTINGS_LABEL,
                        "update-offset-values",
                        &[Value::Object(obj.clone())],
                    );
                }
                true
            }
            "pinned-changed" => {
                let pinned = first.as_bool().unwrap_or(false);
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.pinned = pinned;
                    inner.user_settings.insert("pinned".into(), json!(pinned));
                    Self::persist_user_settings_locked(&inner);
                }
                self.sync_window_ignore_mouse(app);
                true
            }
            "yomitan-event" => {
                let showing = first.as_bool().unwrap_or(false);
                let (focus, restore) = {
                    let mut inner = self.inner.lock().unwrap();
                    inner.yomitan_showing = showing;
                    inner.magpie_pointer_pending = None;
                    let focus = showing
                        && inner.user_settings["focusOverlayOnYomitanLookup"] == true
                        && Self::capture_available(&inner);
                    let restore = !showing
                        && inner.lookup_focus_owned
                        && !inner.navigation_active
                        && !inner.manual_hotkey.hold_active
                        && !inner.manual_hotkey.toggle_latched;
                    inner.lookup_focus_owned = focus;
                    (focus, restore)
                };
                self.sync_window_ignore_mouse(app);
                self.sync_game_visibility(app);
                if let Some(window) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                    if focus {
                        let _ = window_platform::apply(&window, "focus", &Value::Null);
                    }
                    if restore {
                        let _ = window_platform::apply(&window, "blur", &Value::Null);
                        self.restore_game_focus();
                    }
                    let _ = window_platform::apply(&window, "moveTop", &Value::Null);
                }
                desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "text-hover-refresh", &[]);
                true
            }
            "text-hover-ignore" => {
                let ignore = first.as_bool().unwrap_or(true);
                {
                    let mut inner = self.inner.lock().unwrap();
                    let preference = args.get(1).and_then(Value::as_bool).unwrap_or(true);
                    if label != OVERLAY_MAIN_LABEL
                        || !first.is_boolean()
                        || !Self::routes_text_hover(&inner)
                        || inner.magpie_info.is_some()
                        || preference != (inner.user_settings["textHoverClickThrough"] == true)
                    {
                        return true;
                    }
                    inner.text_hover_ignoring = Some(ignore);
                }
                self.sync_window_ignore_mouse(app);
                true
            }
            "set-ignore-mouse-events" => {
                let ignore = first.as_bool().unwrap_or(true);
                {
                    let mut inner = self.inner.lock().unwrap();
                    if label != OVERLAY_MAIN_LABEL || inner.magpie_info.is_some() {
                        return true;
                    }
                    if Self::routes_text_hover(&inner) {
                        drop(inner);
                        desktop_state::emit_to_window(
                            app,
                            OVERLAY_MAIN_LABEL,
                            "text-hover-refresh",
                            &[],
                        );
                        return true;
                    }
                    inner.text_hover_ignoring = Some(ignore);
                }
                self.sync_window_ignore_mouse(app);
                true
            }
            "magpie-pointer-hit" => {
                let hit = first.get("hit").and_then(Value::as_bool).unwrap_or(false);
                let changed = {
                    let mut inner = self.inner.lock().unwrap();
                    if inner.magpie_info.is_none()
                        || inner.magpie_pointer_pending.map(|p| p.0) != first["sequence"].as_u64()
                    {
                        return true;
                    }
                    inner.magpie_pointer_pending = None;
                    // Preserve the recipient of an in-progress mouse press.
                    if sample_pointer().is_some_and(|point| point.buttons != 0) {
                        return true;
                    }
                    let c = inner.magpie_hovering != hit;
                    inner.magpie_hovering = hit;
                    c
                };
                if changed {
                    self.sync_window_ignore_mouse(app);
                }
                true
            }
            "update-window-shape" => {
                // Keep the legacy host's no-op: this rectangle describes only
                // the immediate-text box, which is 20x20 when hidden. A native
                // window region would also clip OCR, stats and dictionary popups.
                // Pointer passthrough is managed separately by mouse_policy.
                true
            }
            "text-received" => {
                self.wake_activity(app);
                self.inner.lock().unwrap().translation_requested = false;
                if first.is_object() {
                    self.inner.lock().unwrap().last_text_payload = first.clone();
                    self.push_offset_data(app);
                }
                // Feed VN guide tracker when a text frame arrives
                self.ensure_vn_guide_initialized(app).await;
                let (changed, snap) = {
                    let mut guard = self.vn_guide.lock().await;
                    if let Some(ctrl) = guard.as_mut() {
                        let ch = ctrl.observe(&first);
                        (ch, Some(ctrl.snapshot()))
                    } else {
                        (false, None)
                    }
                };
                if changed {
                    if let Some(s) = snap {
                        self.sync_vn_guide_hud_window(app, &s);
                        desktop_state::emit_to_window(
                            app,
                            OVERLAY_SETTINGS_LABEL,
                            "vn-guide-state",
                            &[s],
                        );
                    }
                }
                true
            }
            "window-state-changed" => {
                let state = first
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("closed")
                    .to_string();
                let game = first
                    .get("game")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let pid = first.get("pid").and_then(Value::as_u64).map(|p| p as u32);
                let fs = first
                    .get("isFullscreen")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.game_state = GameWindowState {
                        state: state.clone(),
                        game: game.clone(),
                        pid,
                        fullscreen: fs,
                    };
                    inner.vn_guide_available = state != "closed";
                }
                self.ensure_vn_guide_initialized(app).await;
                let (changed, snap) = {
                    let mut guard = self.vn_guide.lock().await;
                    if let Some(ctrl) = guard.as_mut() {
                        let ch = ctrl.set_available(state != "closed", game.as_deref());
                        (ch, Some(ctrl.snapshot()))
                    } else {
                        (false, None)
                    }
                };
                if changed {
                    if let Some(s) = snap {
                        self.sync_vn_guide_hud_window(app, &s);
                    }
                }
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_MAIN_LABEL,
                    "game-state",
                    &[json!(state)],
                );
                self.sync_game_visibility(app);
                self.show_recommendations(app, &first);
                true
            }
            "show" => {
                if let Some(win) = app.get_webview_window(label) {
                    let _ = win.show();
                } else if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                    let _ = win.show();
                }
                true
            }
            "hide" => {
                if let Some(win) = app.get_webview_window(label) {
                    let _ = win.hide();
                }
                true
            }
            "app-close" => {
                if label == OVERLAY_SETTINGS_LABEL {
                    if let Some(win) = app.get_webview_window(label) {
                        let _ = win.close();
                    }
                } else {
                    self.stop(app).await;
                }
                true
            }
            "app-minimize" => {
                if let Some(win) = app.get_webview_window(label) {
                    let _ = win.minimize();
                }
                true
            }
            "overlay-settings-ready" => {
                if label == OVERLAY_MAIN_LABEL {
                    self.push_display_info(app);
                    self.push_settings_to_main(app);
                    self.emit_pomodoro_state(app);
                    if !dictionary_host::use_windows_native_extensions() {
                        if let Some(dm) = app.try_state::<DictionaryManager>() {
                            if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                                if let Ok((_, ext)) = dm.load_selected_extension(app).await {
                                    let url = win.url().map(|u| u.to_string()).unwrap_or_default();
                                    let _ = win.eval(&dm.portable_preload_for_window(
                                        OVERLAY_MAIN_LABEL,
                                        &ext,
                                        &url,
                                        1,
                                    ));
                                    let _ = win.eval(&format!(
                                        "globalThis.__GSM_DICTIONARY_SELECT__?.({});",
                                        json!(ext.id)
                                    ));
                                    let _ = dm.inject_portable_content(app, &win, &ext).await;
                                }
                                let enabled = self.inner.lock().unwrap().user_settings
                                    ["enableJitenReader"]
                                    == true;
                                if enabled {
                                    if let Ok(ext) = dm.load_jiten_extension(app).await {
                                        let url =
                                            win.url().map(|u| u.to_string()).unwrap_or_default();
                                        let _ = win.eval(&dm.portable_preload_for_window(
                                            OVERLAY_MAIN_LABEL,
                                            &ext,
                                            &url,
                                            1,
                                        ));
                                        let _ = dm.inject_portable_content(app, &win, &ext).await;
                                    }
                                }
                            }
                        }
                    }
                    if self.inner.lock().unwrap().user_settings["enableJitenReader"] == true {
                        desktop_state::emit_to_window(
                            app,
                            OVERLAY_MAIN_LABEL,
                            "settings-updated",
                            &[json!({"jitenReaderLoaded":true})],
                        );
                    }
                    let previous = self.inner.lock().unwrap().last_window_state.clone();
                    if let Some(previous) = previous {
                        self.publish_ws2_data(app, &previous.to_string(), Some(&previous))
                            .await;
                    }
                    // The window is created hidden to avoid a white flash. A
                    // ready document must also be revealed when no backend
                    // state has arrived yet (including dictionary-only use).
                    self.sync_game_visibility(app);
                    self.sync_window_ignore_mouse(app);
                } else if label == OVERLAY_OFFSET_LABEL {
                    self.push_offset_data(app);
                } else {
                    self.push_preload_settings(app);
                }
                let _ = self.reconfigure_vn_guide(app, false).await;
                true
            }
            "overlay-settings-painted" => {
                if let Some(win) = app.get_webview_window(OVERLAY_SETTINGS_LABEL) {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                true
            }
            "open-settings" => {
                let tab = first
                    .as_str()
                    .or_else(|| first.get("tab").and_then(Value::as_str));
                let _ = self.open_settings(app, tab).await;
                true
            }
            "open-offset-helper" => {
                let _ = self.open_offset_helper(app);
                true
            }
            "open-yomitan-settings" => {
                self.open_dictionary_settings(app, false);
                true
            }
            "open-jiten-reader-settings" => {
                self.open_dictionary_settings(app, true);
                true
            }
            "open-ai-settings" | "open-gsm-profile-settings" => {
                if let Some(hub) = desktop_state::find_hub_window(app) {
                    let _ = hub.show();
                    let _ = desktop_state::focus_window(&hub);
                }
                if let Some(tx) = &self.inner.lock().unwrap().ws2_tx {
                    let _ = tx.send(Ws2Outbound::Direct(json!({
                        "type": "open-gsm-settings",
                        "root_tab_key": "profiles",
                        "subtab_key": if channel == "open-ai-settings" { "ai" } else { "" }
                    })));
                }
                true
            }
            "overlay-select-ocr-area" => {
                if let Some(tx) = &self.inner.lock().unwrap().ws2_tx {
                    let _ = tx.send(Ws2Outbound::Direct(json!({ "type": "select-ocr-area" })));
                }
                true
            }
            "translate-blocks" | "action-translate" => {
                let payload = if first.is_object() {
                    let mut m = first.as_object().cloned().unwrap_or_default();
                    m.insert("type".into(), json!("translate-request"));
                    Value::Object(m)
                } else {
                    json!({ "type": "translate-request" })
                };
                if let Some(tx) = &self.inner.lock().unwrap().ws2_tx {
                    let _ = tx.send(Ws2Outbound::Direct(payload));
                }
                true
            }
            "action-scan" | "gamepad-manual-overlay-scan" => {
                if let Some(tx) = &self.inner.lock().unwrap().ws2_tx {
                    let _ = tx.send(Ws2Outbound::Direct(
                        json!({ "type": "manual-overlay-scan-request", "source": "overlay" }),
                    ));
                }
                true
            }
            "action-tts" => {
                if let Some(tx) = &self.inner.lock().unwrap().ws2_tx {
                    let _ = tx.send(Ws2Outbound::Direct(
                        json!({ "type": "quick-action-request", "action": "replay-audio" }),
                    ));
                }
                true
            }
            "request-live-stats-today" => {
                if let Some(tx) = &self.inner.lock().unwrap().ws2_tx {
                    let _ = tx.send(Ws2Outbound::Direct(
                        json!({ "type": "get-live-stats-today" }),
                    ));
                }
                true
            }
            "gsm-jiten-cancel-frame" => {
                self.jiten_cache(app).cancel_frame(label);
                true
            }
            "gamepad-request-focus" => {
                self.set_navigation(app, true);
                if !self.inner.lock().unwrap().navigation_active {
                    return true;
                }
                if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                    let _ = win.set_focusable(true);
                    let _ = window_platform::apply(&win, "focus", &Value::Null);
                }
                true
            }
            "gamepad-release-focus" => {
                self.set_navigation(app, false);
                self.sync_window_ignore_mouse(app);
                if let Some(win) = app.get_webview_window(OVERLAY_MAIN_LABEL) {
                    let _ = window_platform::apply(&win, "blur", &Value::Null);
                }
                if let Some(tx) = &self.inner.lock().unwrap().ws2_tx {
                    let _ = tx.send(Ws2Outbound::Direct(
                        json!({ "type": "restore-focus-request" }),
                    ));
                }
                true
            }
            "gamepad-forward-enter" | "gamepad-forward-key" | "gamepad-forward-click" => {
                let inner = self.inner.lock().unwrap();
                if !inner.navigation_active
                    || !Self::capture_available(&inner)
                    || inner.hotkey_suppressed_for_input_test
                    || !inner.ws2_connected
                {
                    return true;
                }
                let key = if channel == "gamepad-forward-enter" {
                    Some("enter")
                } else {
                    first.as_str()
                };
                if channel != "gamepad-forward-click"
                    && !key.is_some_and(|key| matches!(key, "enter" | "space" | "ctrl" | "escape"))
                {
                    return true;
                }
                if let Some(tx) = &inner.ws2_tx {
                    let _ = tx.send(Ws2Outbound::Direct(json!({
                        "type": if channel == "gamepad-forward-click" { "send-click-request" } else { "send-key-request" },
                        "key":key,"source":"gamepad","activateWindow":true,"targetPid":inner.game_state.pid,"expected_target_hwnd":inner.target_hwnd,
                    })));
                }
                true
            }
            "gamepad-translate" => {
                let _ = self.request_or_toggle_translation(app);
                true
            }
            "gamepad-toggle-pause" => {
                if !self.inner.lock().unwrap().navigation_active {
                    return true;
                }
                let paused = self
                    .inner
                    .lock()
                    .unwrap()
                    .pause_sources
                    .contains("gamepad_manual_pause");
                self.set_process_pause("gamepad_manual_pause", !paused);
                let paused = self
                    .inner
                    .lock()
                    .unwrap()
                    .pause_sources
                    .contains("gamepad_manual_pause");
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_MAIN_LABEL,
                    "gamepad-pause-state",
                    &[json!({"paused":paused})],
                );
                true
            }
            "gamepad-input-test-active" => {
                let active = first
                    .get("active")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                {
                    self.inner.lock().unwrap().hotkey_suppressed_for_input_test = active;
                }
                desktop_state::emit_to_window(
                    app,
                    OVERLAY_MAIN_LABEL,
                    "gamepad-input-test-active",
                    &[json!({ "active": active })],
                );
                true
            }
            "overlay-main-box-shown" => {
                self.inner.lock().unwrap().main_box_shown = true;
                true
            }
            "manual-mode-recommendation-close" | "fullscreen-mode-recommendation-close" => {
                let target = if channel.starts_with("manual") {
                    OVERLAY_REC_MANUAL_LABEL
                } else {
                    OVERLAY_REC_FS_LABEL
                };
                if let Some(win) = app.get_webview_window(target) {
                    let _ = win.close();
                }
                true
            }
            "manual-mode-recommendation-dismiss" | "fullscreen-mode-recommendation-dismiss" => {
                let game = first
                    .get("game")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let is_manual = channel.starts_with("manual");
                let key = if is_manual {
                    "dismissedManualModeGames"
                } else {
                    "dismissedFullscreenModeGames"
                };
                let target_win = if is_manual {
                    OVERLAY_REC_MANUAL_LABEL
                } else {
                    OVERLAY_REC_FS_LABEL
                };
                if !game.is_empty() {
                    let mut inner = self.inner.lock().unwrap();
                    let mut arr = inner
                        .user_settings
                        .get(key)
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    if !arr.iter().any(|v| v.as_str() == Some(game.as_str())) {
                        arr.push(json!(game));
                    }
                    inner
                        .user_settings
                        .insert(key.into(), Value::Array(arr.clone()));
                    Self::persist_user_settings_locked(&inner);
                }
                if let Some(win) = app.get_webview_window(target_win) {
                    let _ = win.close();
                }
                true
            }
            "fullscreen-mode-recommendation-open-resource" => {
                let res = first.get("resource").and_then(Value::as_str).unwrap_or("");
                let url = match res {
                    "magpie" => Some("https://github.com/Blinue/Magpie"),
                    "specialK" => Some("https://www.special-k.info/"),
                    _ => None,
                };
                if let Some(u) = url {
                    let _ = crate::native::shell_open_external(u);
                }
                true
            }
            "gamepad-block-change" | "gamepad-button" | "gamepad-connected" => {
                self.wake_activity(app);
                true
            }
            "gamepad-disconnected" => {
                self.set_navigation(app, false);
                true
            }
            "gamepad-navigation-state" => {
                self.set_navigation(app, first["active"] == true);
                true
            }
            "manual-mode-background-painted" => {
                self.finish_manual_focus(app);
                true
            }
            "config-received" => {
                self.inner.lock().unwrap().backend_config = first;
                true
            }
            "live-goals-availability-changed" => {
                self.inner.lock().unwrap().goals_available =
                    first["available"] == true || first == true;
                true
            }
            "native-overlay-error" => {
                eprintln!("[overlay] Renderer: {first}");
                true
            }
            "reply-current-settings" => true,
            "translation-request-failed" => {
                self.inner.lock().unwrap().translation_requested = false;
                true
            }
            "resize-mode" => {
                let mut inner = self.inner.lock().unwrap();
                inner.resize_mode = first == true && Self::capture_available(&inner);
                drop(inner);
                self.sync_window_ignore_mouse(app);
                desktop_state::emit_to_window(app, OVERLAY_MAIN_LABEL, "text-hover-refresh", &[]);
                true
            }
            _ => false,
        }
    }

    pub async fn handle_invoke(
        &self,
        app: &AppHandle,
        label: &str,
        channel: &str,
        args: &[Value],
    ) -> Option<Result<Value, String>> {
        self.ensure_loaded(app);
        let first = args.first().cloned().unwrap_or(Value::Null);

        match channel {
            "hachidori-open-external" => {
                let valid_reader = self
                    .inner
                    .lock()
                    .unwrap()
                    .user_settings
                    .get("dictionaryReaderSelection")
                    .and_then(Value::as_str)
                    == Some("hachidori");
                if label != OVERLAY_MAIN_LABEL || !valid_reader {
                    return Some(Err("Hachidori links require its active overlay.".into()));
                }
                let result = normalize_external_http_url(first["url"].as_str().unwrap_or(""))
                    .and_then(|url| {
                        if first.get("active").is_some_and(|v| !v.is_boolean()) {
                            return Err("Invalid link activation.".into());
                        }
                        crate::native::shell_open_external(&url).map(|_| json!({"opened":true}))
                    });
                Some(result)
            }
            "overlay-native-command" => {
                let target_label = first
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or(OVERLAY_MAIN_LABEL);
                let message = first
                    .get("message")
                    .cloned()
                    .unwrap_or_else(|| first.clone());
                if app.get_webview_window(target_label).is_none() && message["action"] != "stop" {
                    return Some(Err("Overlay window is closed".into()));
                }
                self.sync_native_context(app, &message);
                let res = app
                    .state::<crate::overlay::Overlay>()
                    .command(target_label, message);
                if let Ok(ref val) = res {
                    if val["clear"] == true {
                        crate::overlay::clear(app, target_label);
                    }
                }
                Some(res)
            }
            "get-effective-platform" => {
                let settings = &self.inner.lock().unwrap().user_settings;
                Some(Ok(json!(resolve_effective_platform(settings))))
            }
            "gsm-jiten-parse" | "gsm-jiten-parse-frame" => {
                let jiten = self.jiten_cache(app);
                let (api_key, endpoint) = {
                    let s = &self.inner.lock().unwrap().user_settings;
                    (
                        first
                            .get("apiKey")
                            .or_else(|| s.get("gamepadJitenApiKey"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        first
                            .get("endpoint")
                            .and_then(Value::as_str)
                            .unwrap_or("https://api.jiten.moe/api/reader/parse")
                            .to_string(),
                    )
                };
                if let Some(texts_arr) = first.get("texts").and_then(Value::as_array) {
                    let texts: Vec<String> = texts_arr
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect();
                    Some(jiten.parse_frame(label, &texts, &api_key, &endpoint).await)
                } else {
                    let text = first.get("text").and_then(Value::as_str).unwrap_or("");
                    Some(jiten.parse(text, &api_key, &endpoint).await)
                }
            }
            "gsm-jiten-review" => {
                let jiten = self.jiten_cache(app);
                let api_key = {
                    let s = &self.inner.lock().unwrap().user_settings;
                    first
                        .get("apiKey")
                        .or_else(|| s.get("gamepadJitenApiKey"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                let endpoint = first
                    .get("endpoint")
                    .and_then(Value::as_str)
                    .unwrap_or("https://api.jiten.moe/api");
                let word_id = first.get("wordId").and_then(Value::as_i64).unwrap_or(0);
                let reading_idx = first
                    .get("readingIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let rating = first.get("rating").cloned().unwrap_or(json!(3));
                let req_id = first.get("requestId").and_then(Value::as_str);
                Some(
                    jiten
                        .review_card(word_id, reading_idx, rating, &api_key, endpoint, req_id)
                        .await,
                )
            }
            "gsm-jiten-set-vocabulary-state" => {
                let jiten = self.jiten_cache(app);
                let api_key = {
                    let s = &self.inner.lock().unwrap().user_settings;
                    first
                        .get("apiKey")
                        .or_else(|| s.get("gamepadJitenApiKey"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                let endpoint = first
                    .get("endpoint")
                    .and_then(Value::as_str)
                    .unwrap_or("https://api.jiten.moe/api");
                let word_id = first.get("wordId").and_then(Value::as_i64).unwrap_or(0);
                let reading_idx = first
                    .get("readingIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let state = first.get("state").and_then(Value::as_str).unwrap_or("");
                let req_id = first.get("requestId").and_then(Value::as_str);
                let base = derive_jiten_api_base(endpoint);
                Some(
                    jiten
                        .set_vocabulary_state(word_id, reading_idx, state, &api_key, &base, req_id)
                        .await,
                )
            }
            "gsm-local-vocabulary-parse" => {
                let port = {
                    let inner = self.inner.lock().unwrap();
                    resolve_gamepad_port(&inner.user_settings, Some(app))
                };
                let ws_url = format!("ws://127.0.0.1:{port}");
                Some(local_vocabulary_ws_request(&ws_url, first).await)
            }
            "vn-guide-state" => {
                self.ensure_vn_guide_initialized(app).await;
                let snap = {
                    let mut guard = self.vn_guide.lock().await;
                    let settings = self.inner.lock().unwrap().user_settings.clone();
                    guard.as_mut().unwrap().configure(&settings, false).await
                };
                self.sync_vn_guide_hud_window(app, &snap);
                Some(Ok(snap))
            }
            "vn-guide-command" => {
                let action = first.get("action").and_then(Value::as_str).unwrap_or("");
                if label == OVERLAY_VN_GUIDE_LABEL
                    && (!matches!(action, "next" | "back" | "hide")
                        || !self.inner.lock().unwrap().vn_guide_available)
                {
                    return Some(Ok(Value::Null));
                }
                let val = first.get("value");
                Some(self.vn_guide_command(app, action, val).await)
            }
            "vn-guide-catalogue" => Some(Ok(self.vn_guide_catalogue(app, &first).await)),
            "overlay-get-active-goals" => {
                let single_port = self.inner.lock().unwrap().single_port;
                let http = Self::http_client(app);
                let url = format!("http://127.0.0.1:{single_port}/api/goals/active");
                let res = async move {
                    let resp = http
                        .get(&url)
                        .timeout(Duration::from_secs(5))
                        .send()
                        .await
                        .map_err(|e| format!("Failed reaching GSM goals API: {e}"))?;
                    if !resp.status().is_success() {
                        return Err(format!(
                            "Goals API returned HTTP {}",
                            resp.status().as_u16()
                        ));
                    }
                    resp.json::<Value>()
                        .await
                        .map_err(|e| format!("Invalid goals JSON: {e}"))
                }
                .await;
                Some(res)
            }
            "overlay-vita-model" | "overlay-meiki-model" => {
                let single_port = self.inner.lock().unwrap().single_port;
                let endpoint = if channel == "overlay-vita-model" {
                    format!("http://127.0.0.1:{single_port}/api/ocr/vita-model")
                } else {
                    format!("http://127.0.0.1:{single_port}/api/ocr/meiki-model")
                };
                let http = Self::http_client(app);
                let has_model = first.get("model").is_some_and(|v| !v.is_null());
                let res = async move {
                    let req = if has_model {
                        http.post(&endpoint).json(&first)
                    } else {
                        http.get(&endpoint)
                    };
                    let resp = req
                        .timeout(Duration::from_secs(120))
                        .send()
                        .await
                        .map_err(|e| format!("Failed contacting model endpoint: {e}"))?;
                    let body: Value = resp
                        .json()
                        .await
                        .map_err(|e| format!("Invalid model API JSON: {e}"))?;
                    Ok(body)
                }
                .await;
                Some(res)
            }
            "sudachi-setup" => {
                let port = {
                    let inner = self.inner.lock().unwrap();
                    resolve_gamepad_port(&inner.user_settings, Some(app))
                };
                let ws_url = format!("ws://127.0.0.1:{port}");
                let prepare = first.get("action").and_then(Value::as_str) == Some("install")
                    || first.get("prepare").and_then(Value::as_bool) == Some(true);
                let dict = first
                    .get("dictionary")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Some(sudachi_setup_ws(&ws_url, prepare, dict).await)
            }
            "quick-action" => {
                let action = first
                    .as_str()
                    .or_else(|| first.get("action").and_then(Value::as_str))
                    .unwrap_or("state");
                if action == "translation" {
                    return Some(
                        self.request_or_toggle_translation(app)
                            .map(|_| json!({"success":true})),
                    );
                }
                let single_port = self.inner.lock().unwrap().single_port;
                let ws_url = format!("ws://127.0.0.1:{single_port}/ws/overlay");
                let res = quick_action_ws(&ws_url, action).await;
                Some(res)
            }
            _ => None,
        }
    }
}

async fn sudachi_setup_ws(
    ws_url: &str,
    prepare: bool,
    dictionary: Option<String>,
) -> Result<Value, String> {
    let (mut socket, _) = connect_async(ws_url)
        .await
        .map_err(|e| format!("Input server unavailable: {e}"))?;
    let cmd = if prepare {
        json!({ "type": "prepare_sudachi", "dictionary": dictionary })
    } else {
        json!({ "type": "sudachi_status" })
    };
    socket
        .send(Message::Text(cmd.to_string().into()))
        .await
        .map_err(|e| e.to_string())?;
    let timeout_res =
        tokio::time::timeout(Duration::from_secs(if prepare { 960 } else { 5 }), async {
            while let Some(frame) = socket.next().await {
                if let Ok(Message::Text(txt)) = frame {
                    if let Ok(val) = serde_json::from_str::<Value>(&txt) {
                        if val.get("type").and_then(Value::as_str) == Some("sudachi_status") {
                            let st = val.get("state").and_then(Value::as_str).unwrap_or("");
                            if !prepare || st != "installing" {
                                return Ok(val);
                            }
                        }
                    }
                }
            }
            Err("Input server disconnected during Sudachi operation".into())
        })
        .await;
    timeout_res.map_err(|_| "Timed out waiting for Sudachi status".to_string())?
}

async fn quick_action_ws(ws_url: &str, action: &str) -> Result<Value, String> {
    let req_id = format!("qa-{}", now_ms());
    let (mut socket, _) = connect_async(ws_url)
        .await
        .map_err(|e| format!("GSM overlay backend offline: {e}"))?;
    socket
        .send(Message::Text(
            json!({
                "type": "quick-action-request",
                "request_id": req_id,
                "action": action,
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|e| e.to_string())?;
    let res = tokio::time::timeout(Duration::from_secs(8), async {
        while let Some(frame) = socket.next().await {
            if let Ok(Message::Text(txt)) = frame {
                if let Ok(val) = serde_json::from_str::<Value>(&txt) {
                    if val.get("type").and_then(Value::as_str) == Some("quick-action-result")
                        && val.get("request_id").and_then(Value::as_str) == Some(req_id.as_str())
                    {
                        return Ok(val);
                    }
                }
            }
        }
        Err("Backend websocket closed before quick-action reply".into())
    })
    .await;
    res.map_err(|_| "Quick action request timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pomodoro_uses_elapsed_time_and_keeps_pause_time_out_of_countdown() {
        let now = Instant::now();
        let mut timer = PomodoroState {
            enabled: true,
            active: true,
            started: true,
            mode: "work".into(),
            remaining_secs: 4,
            last_tick: Some(now),
        };
        assert!(timer.tick(now + Duration::from_secs(6), 60, 30));
        assert_eq!(timer.mode, "break");
        assert_eq!(timer.remaining_secs, 28);
        timer.active = false;
        assert!(!timer.tick(now + Duration::from_secs(70), 60, 30));
        timer.active = true;
        assert!(!timer.tick(now + Duration::from_secs(90), 60, 30));
        timer.tick(now + Duration::from_secs(91), 60, 30);
        assert_eq!(timer.remaining_secs, 27);
    }
    use std::time::Instant;

    #[test]
    fn config_burst_preserves_fields_and_last_value() {
        let mut pending = None;
        merge_config_message(
            &mut pending,
            json!({"settings":{"engine_v2":"oneocr", "periodic_interval":2}}),
        );
        merge_config_message(
            &mut pending,
            json!({"settings":{"periodic_interval":0.7,"minimum_character_size":15}}),
        );
        assert_eq!(
            pending.unwrap(),
            json!({"type":"set-gsm-overlay-config","settings":{
            "engine_v2":"oneocr","periodic_interval":0.7,"minimum_character_size":15}})
        );
    }

    #[test]
    fn pointer_ownership_obeys_capture_and_manual_activation() {
        let mut inner = OverlayInner::default();
        inner
            .user_settings
            .insert("platformOverride".into(), json!("win32"));
        inner.game_state.state = "active".into();
        inner.capture_available = Some(true);
        inner.text_hover_ignoring = Some(false);
        assert!(OverlayHost::routes_text_hover(&inner));
        assert!(!OverlayHost::mouse_policy(&inner).0);
        inner.user_settings.insert("manualMode".into(), json!(true));
        assert!(!OverlayHost::routes_text_hover(&inner));
        assert!(OverlayHost::mouse_policy(&inner).0);
        inner.manual_hotkey.handle_press(false);
        assert!(!OverlayHost::mouse_policy(&inner).0);
        inner.capture_available = Some(false);
        inner.yomitan_showing = true;
        assert_eq!(OverlayHost::mouse_policy(&inner), (true, false));
    }

    #[test]
    fn repeated_native_keydown_does_not_toggle_off_until_released() {
        let mut machine = ManualHotkeyMachine::default();
        assert_eq!(machine.handle_tauri_shortcut_signal(true, true), Some(true));
        assert_eq!(machine.handle_tauri_shortcut_signal(true, true), None);
        assert_eq!(machine.handle_tauri_shortcut_signal(true, false), None);
        assert_eq!(
            machine.handle_tauri_shortcut_signal(true, true),
            Some(false)
        );
    }

    #[test]
    fn capture_bounds_override_unrelated_monitor_ids_and_order() {
        let mut inner = OverlayInner::default();
        let display = |id, x, primary| {
            serde_json::from_value::<DisplayInfo>(json!({
            "id": id, "label": format!("DISPLAY{id}"), "scaleFactor":1.5,
            "bounds":{"x":x / 1.5,"y":0,"width":2560,"height":1440},
            "physicalBounds":{"x":x,"y":0,"width":3840,"height":2160},
            "workArea":{"x":0,"y":0,"width":2560,"height":1400},
            "physicalWorkArea":{"x":x,"y":0,"width":3840,"height":2100},
            "size":{"width":2560,"height":1440}, "workAreaSize":{"width":2560,"height":1400},
            "physicalSize":{"width":3840,"height":2160}, "physicalWorkAreaSize":{"width":3840,"height":2100},
            "primary":primary
        })).unwrap()
        };
        inner.displays = vec![display(0, 0.0, true), display(1, -3840.0, false)];
        inner
            .user_settings
            .insert("monitor_to_capture".into(), json!(0));
        inner
            .user_settings
            .insert("monitor_to_capture_id".into(), json!("0"));
        inner.user_settings.insert(
            "monitor_to_capture_bounds".into(),
            json!({
                "left":-3840,"top":0,"width":3840,"height":2160
            }),
        );
        assert_eq!(
            OverlayHost::resolve_display(&inner)
                .unwrap()
                .physical_bounds
                .x,
            -3840.0
        );
    }

    #[test]
    fn hachidori_external_links_allow_only_plain_web_urls() {
        assert!(normalize_external_http_url("https://jisho.org/search/食べる").is_ok());
        for url in [
            "javascript:alert(1)",
            "file:///C:/secret",
            "https://user:pass@example.com",
            "https://example.com\n",
        ] {
            assert!(normalize_external_http_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn manual_hotkey_machine_handles_hold_and_toggle_modes() {
        let mut m = ManualHotkeyMachine::default();
        // Hold mode
        assert_eq!(m.handle_press(false), Some(true));
        assert_eq!(m.handle_press(false), None); // idempotent repeat
        assert!(m.is_active(false));
        assert_eq!(m.handle_release(false), Some(false));
        assert!(!m.is_active(false));

        // Toggle mode
        assert_eq!(m.handle_press(true), Some(true));
        assert_eq!(m.handle_release(true), None);
        assert!(m.is_active(true));
        assert_eq!(m.handle_press(true), Some(false));
        assert_eq!(m.handle_release(true), None);
        assert!(!m.is_active(true));
    }

    #[test]
    fn effective_platform_prefers_valid_override() {
        let mut s = default_user_settings_map();
        assert_eq!(resolve_effective_platform(&s), effective_platform());
        s.insert("platformOverride".into(), json!("linux"));
        assert_eq!(resolve_effective_platform(&s), "linux");
        s.insert("platformOverride".into(), json!("invalid_os"));
        assert_eq!(resolve_effective_platform(&s), effective_platform());
    }

    #[test]
    fn benchmark_overlay_host_hotkey_state_transitions_10k() {
        let mut m = ManualHotkeyMachine::default();
        let started = Instant::now();
        for _ in 0..10_000 {
            let _ = m.handle_press(false);
            let _ = m.handle_release(false);
        }
        let elapsed = started.elapsed();
        println!(
            "[bench] overlay_manual_hotkey_10k total_ms={:.3} ns_per_cycle={:.1}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1e9 / 10_000.0
        );
    }
}
