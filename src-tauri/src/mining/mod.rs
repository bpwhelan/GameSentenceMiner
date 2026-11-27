//! Native Rust mining runtime hosted by the Tauri desktop process.
//! Owns the single-port HTTP+WS gateway (serving AnkiBeacon directly and
//! reverse-proxying all other HTTP/WS routes to Python), AnkiConnect polling,
//! replay saving & cutting, FireRed/Silero VAD, AI prompting, and card updates.

pub mod furigana;
pub(crate) mod clip_library;
mod clip_capture;
pub(crate) mod reader_media;
pub(crate) mod media_folder;
pub(crate) mod reader_audio;
pub(crate) mod reader_ai;
pub(crate) mod overlay_ai;
pub mod pipeline;
pub mod session_review;

use crate::anki_connect::Collection;
use gsm_mining::ai::{AiService, OverlayBlocks};
use gsm_mining::beacon::{BeaconNoteEvent, BeaconReceiver};
use gsm_mining::config::ProfileConfig;
use gsm_mining::ffmpeg::MediaTools;
use gsm_mining::gateway::{start_with_services, GatewayHandle};
use gsm_mining::pause_gaps::PauseHistory;
use gsm_mining::policy::{AnkiUpdateResult, SentenceAudioCacheEntry, SentenceAudioKey};
use gsm_mining::vad::VadSystem;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Notify};

pub fn native_mining_requested() -> bool {
    if std::env::var_os("GSM_SMOKE_TEST").is_some() {
        return std::env::var("GSM_NATIVE_MINING").as_deref()==Ok("1");
    }
    true
}

pub struct WordGuard {
    words: Arc<Mutex<Vec<String>>>,
    word: String,
}

impl Drop for WordGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.words.lock() {
            if let Some(pos) = guard.iter().position(|w| w == &self.word) {
                guard.remove(pos);
            }
        }
    }
}

pub struct InFlightLineGuard {
    set: Arc<Mutex<HashSet<String>>>,
    notify: Arc<Notify>,
    line_id: String,
}

impl Drop for InFlightLineGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.set.lock() {
            guard.remove(&self.line_id);
        }
        self.notify.notify_waiters();
    }
}

#[derive(Default)]
struct CachedConfig {
    stamp: Option<(u64, std::time::SystemTime)>,
    config: Option<Arc<ProfileSnapshot>>,
}

pub(crate) struct ProfileSnapshot {
    profile: ProfileConfig,
    pub(crate) document: Value,
}

#[derive(Default)]
struct NoteClaims {
    seen_by_poller: HashSet<u64>,
    claimed: HashSet<u64>,
}

pub struct MiningService {
    ai_settings_opened: tokio::sync::Mutex<Option<Instant>>,
    overlay_translations: Mutex<overlay_ai::Queue>,
    clip_saves: clip_capture::Saves,
    exports: reader_media::Exports,
    audio_playback: reader_audio::Playback,
    enabled: bool,
    data_dir: PathBuf,
    temp_dir: PathBuf,
    config_cache: Mutex<CachedConfig>,
    intake_profile: Mutex<Option<Arc<ProfileSnapshot>>>,
    gateway_port: AtomicU16,
    gateway: Mutex<Option<GatewayHandle>>,
    beacon: BeaconReceiver,
    beacon_rx: Mutex<Option<mpsc::Receiver<BeaconNoteEvent>>>,
    pub ai: Arc<AiService>,
    character_summary_attempts: Mutex<HashMap<String, Instant>>,
    pub vad: Arc<VadSystem>,
    pub pause_history: Arc<PauseHistory>,
    pub card_lane: Arc<tokio::sync::Mutex<()>>,
    pub results: Arc<Mutex<HashMap<String, AnkiUpdateResult>>>,
    pub in_flight_lines: Arc<Mutex<HashSet<String>>>,
    pub result_notify: Arc<Notify>,
    pub sentence_audio_cache: Arc<Mutex<HashMap<SentenceAudioKey, SentenceAudioCacheEntry>>>,
    pub mismatch_prompted: Mutex<HashSet<String>>,
    note_claims: Mutex<NoteClaims>,
    seeded: AtomicBool,
    anki_connected: AtomicBool,
    anki_beacon_connected: AtomicBool,
    obs_replay_active: AtomicBool,
    words_being_processed: Arc<Mutex<Vec<String>>>,
    wake_monitor: Arc<Notify>,
    shutdown_flag: AtomicBool,
}

impl MiningService {
    pub fn new(app_root: &Path, data_dir: PathBuf, http: reqwest::Client) -> Arc<Self> {
        let enabled = native_mining_requested();
        let temp_dir = data_dir.join("temp");
        let _ = std::fs::create_dir_all(&temp_dir);
        let (beacon, beacon_rx) = BeaconReceiver::new(256);
        let asset_roots = vec![
            app_root.join("resources/assets"),
            data_dir.join("assets"),
        ];
        Arc::new(Self {
            ai_settings_opened: Default::default(),
            overlay_translations: Default::default(),
            clip_saves: Default::default(),
            exports: Default::default(),
            audio_playback: Default::default(),
            enabled,
            data_dir: data_dir.clone(),
            temp_dir,
            config_cache: Mutex::new(CachedConfig::default()),
            intake_profile: Mutex::new(None),
            gateway_port: AtomicU16::new(0),
            gateway: Mutex::new(None),
            beacon,
            beacon_rx: Mutex::new(Some(beacon_rx)),
            ai: Arc::new(AiService::new(http)),
            character_summary_attempts: Mutex::default(),
            vad: Arc::new(
                VadSystem::new(asset_roots)
                    .with_memory_probe(current_process_private_working_set),
            ),
            pause_history: Arc::new(PauseHistory::new(&data_dir)),
            card_lane: Arc::new(tokio::sync::Mutex::new(())),
            results: Arc::new(Mutex::new(HashMap::new())),
            in_flight_lines: Arc::new(Mutex::new(HashSet::new())),
            result_notify: Arc::new(Notify::new()),
            sentence_audio_cache: Arc::new(Mutex::new(HashMap::new())),
            mismatch_prompted: Mutex::new(HashSet::new()),
            note_claims: Mutex::default(),
            seeded: AtomicBool::new(false),
            anki_connected: AtomicBool::new(false),
            anki_beacon_connected: AtomicBool::new(false),
            obs_replay_active: AtomicBool::new(false),
            words_being_processed: Arc::new(Mutex::new(Vec::new())),
            wake_monitor: Arc::new(Notify::new()),
            shutdown_flag: AtomicBool::new(false),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled && self.bound_gateway_port().is_some()
    }

    pub fn bound_gateway_port(&self) -> Option<u16> {
        let p = self.gateway_port.load(Ordering::SeqCst);
        (p > 0).then_some(p)
    }

    pub fn temp_dir(&self) -> PathBuf {
        let _ = std::fs::create_dir_all(&self.temp_dir);
        self.temp_dir.clone()
    }

    /// Return the active `ProfileConfig`, caching across poll ticks when `config.json`
    /// metadata `(len, modified_ns)` is unchanged so idle polling performs zero file reads/parses.
    pub fn load_config(&self) -> Result<ProfileConfig, String> {
        Ok(self.load_snapshot()?.profile.clone())
    }

    pub(crate) fn load_snapshot(&self) -> Result<Arc<ProfileSnapshot>, String> {
        let mut cache = self.config_cache.lock().unwrap();
        let config_path = self.data_dir.join("config.json");
        let stamp = match std::fs::metadata(&config_path) {
            Ok(meta) => Some((meta.len(), meta.modified().map_err(|e| e.to_string())?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("Reading {}: {e}",config_path.display())),
        };
        if stamp == cache.stamp {
            if let Some(config) = &cache.config {
                return Ok(config.clone());
            }
        }
        let document = gsm_settings::read_object(&config_path)?;
        let profile = ProfileConfig::from_config_json(&document)?;
        let loaded = Arc::new(ProfileSnapshot {profile,document});
        cache.stamp = stamp;
        cache.config = Some(loaded.clone());
        Ok(loaded)
    }

    pub(crate) fn refresh_profile(&self, app: &AppHandle) -> Result<Arc<ProfileSnapshot>,String> {
        let mut current = self.intake_profile.lock().unwrap();
        let next = self.load_snapshot()?;
        if !current.as_ref().is_some_and(|old| Arc::ptr_eq(old,&next)) {
            crate::text_intake::bootstrap::configure(app,&next.profile,&next.document)?;
            crate::desktop_state::emit_to_desktop_windows(app,"settings.mining.changed",&[]);
            *current=Some(next.clone());
        }
        Ok(next)
    }

    pub fn invalidate_config_cache(&self) {
        if let Ok(mut guard) = self.config_cache.lock() {
            guard.stamp = None;
            guard.config = None;
        }
    }

    pub fn set_obs_replay_active(&self, active: bool) {
        self.obs_replay_active.store(active, Ordering::SeqCst);
        self.wake_monitor.notify_one();
    }

    pub fn forget_note(&self, note_id: u64) {
        if let Ok(mut notes) = self.note_claims.lock() {
            notes.seen_by_poller.remove(&note_id);
        }
    }

    fn claim_note(&self, note_id: u64) -> bool {
        let mut notes = self.note_claims.lock().unwrap();
        notes.seen_by_poller.insert(note_id);
        notes.claimed.insert(note_id)
    }

    fn retry_note_lookup(&self, note_id: u64) {
        let mut notes = self.note_claims.lock().unwrap();
        // Clear receipts from both sources while a new attempt is still excluded.
        self.beacon.forget_note(note_id);
        notes.seen_by_poller.remove(&note_id);
        notes.claimed.remove(&note_id);
    }

    pub fn track_word_in_progress(&self, word: &str) -> WordGuard {
        let label = word.to_string();
        if !label.is_empty() {
            if let Ok(mut words) = self.words_being_processed.lock() {
                words.push(label.clone());
            }
        }
        WordGuard {
            words: Arc::clone(&self.words_being_processed),
            word: label,
        }
    }

    pub fn mark_line_in_flight(&self, line_id: &str) -> InFlightLineGuard {
        let id = line_id.to_string();
        if let Ok(mut set) = self.in_flight_lines.lock() {
            set.insert(id.clone());
        }
        InFlightLineGuard {
            set: Arc::clone(&self.in_flight_lines),
            notify: Arc::clone(&self.result_notify),
            line_id: id,
        }
    }

    pub fn status_snapshot(&self) -> Value {
        let words = self
            .words_being_processed
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        json!({
            "native_mining": self.is_enabled(),
            "anki_connected": self.anki_connected.load(Ordering::SeqCst),
            "anki_beacon_connected": self.anki_beacon_connected.load(Ordering::SeqCst),
            "obs_replay_active": self.obs_replay_active.load(Ordering::SeqCst),
            "words_being_processed": words,
            "gateway_port": self.bound_gateway_port(),
        })
    }

    pub fn clear_upstreams(&self) {
        if let Ok(guard) = self.gateway.lock() {
            if let Some(ref handle) = *guard {
                handle.set_upstreams(None, None, 0);
            }
        }
    }

    pub fn start(self: &Arc<Self>, app: &AppHandle) {
        if !self.enabled {
            return;
        }
        let snapshot = match self.load_snapshot() {
            Ok(s) => s,
            Err(error) => {crate::desktop_log::error(app,"settings",error); return;}
        };
        let cfg = &snapshot.profile;
        let bind_host = cfg.advanced.localhost_bind_address.clone();
        let port = if cfg.general.single_port == 0 {
            7275
        } else {
            cfg.general.single_port
        };

        let beacon = self.beacon.clone();
        let reader = crate::text_intake::feed::Endpoint(app.clone());
        let direct = cfg.advanced.direct_websocket_port;
        let direct = if direct == cfg.advanced.texthooker_communication_websocket_port {0} else {direct};
        let reports = Some(Arc::new(gsm_mining::gateway::Reports::new(
            &self.data_dir,
            app.state::<Arc<gsm_history::History>>().inner().clone(),
        )));
        let gateway_res = tauri::async_runtime::block_on(async move {
            start_with_services(&bind_host, port, beacon, Some(Arc::new(reader)), direct, reports).await
        });
        match gateway_res {
            Ok(handle) => {
                if let Err(e) = self.refresh_profile(app) {
                    handle.shutdown();
                    crate::desktop_log::error(app,"text-intake",e);
                    return;
                }
                crate::text_intake::bootstrap::start(app);
                let actual_port = handle.bound_addr.port();
                self.gateway_port.store(actual_port, Ordering::SeqCst);
                *self.gateway.lock().unwrap() = Some(handle);
                crate::desktop_log::info(
                    app,
                    "mining",
                    format!("Native Rust single-port gateway listening on port {actual_port}"),
                );
            }
            Err(err) => {
                crate::desktop_log::warn(
                    app,
                    "mining",
                    format!("Native Rust gateway failed to bind port {port}: {err}"),
                );
                return;
            }
        }

        if let Some(rx) = self.beacon_rx.lock().unwrap().take() {
            let service = Arc::clone(self);
            let monitor_app = app.clone();
            tauri::async_runtime::spawn(async move {
                service.run_monitor_loop(monitor_app, rx).await;
            });
        }
    }

    pub fn shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::SeqCst);
        self.wake_monitor.notify_waiters();
        if let Ok(mut guard) = self.gateway.lock() {
            if let Some(handle) = guard.take() {
                handle.shutdown();
            }
        }
    }

    async fn run_monitor_loop(
        self: Arc<Self>,
        app: AppHandle,
        mut beacon_rx: mpsc::Receiver<BeaconNoteEvent>,
    ) {
        let beacon_wake = self.beacon.wake_notifier();
        let mut last_availability_probe = Instant::now() - Duration::from_secs(60);
        let mut config_error = None;
        let mut monitor_mode = None;

        while !self.shutdown_flag.load(Ordering::SeqCst) {
            let snapshot = match self.refresh_profile(&app) {
                Ok(settings) => { config_error = None; settings }
                Err(error) => {
                    if config_error.as_ref() != Some(&error) {
                        crate::desktop_log::warn(&app,"settings",&error);
                        config_error = Some(error);
                    }
                    let previous = self.intake_profile.lock().unwrap().clone();
                    let Some(previous) = previous else { break };
                    previous
                }
            };
            let config = &snapshot.profile;
            let poll_ms = config.anki.polling_rate_v2.max(250);
            let beacon_active = self.beacon.is_heartbeat_fresh();
            let mode = if !config.anki.enabled {
                "disabled"
            } else if beacon_active {
                "AnkiBeacon"
            } else {
                "AnkiConnect polling"
            };
            if monitor_mode != Some(mode) {
                crate::desktop_log::background(&app, "mining", format!("Anki monitor mode: {mode}"));
                monitor_mode = Some(mode);
            }
            self.anki_beacon_connected
                .store(beacon_active, Ordering::SeqCst);

            if config.anki.enabled {
                while let Ok(evt) = beacon_rx.try_recv() {
                    self.handle_beacon_event(&app, evt);
                }
                if let Ok(url) = reqwest::Url::parse(&config.anki.url) {
                    let http = app.state::<crate::desktop_state::DesktopState>().http.clone();
                    if beacon_active {
                        self.anki_connected.store(true, Ordering::SeqCst);
                        // Seed the polling baseline without claiming notes from Beacon.
                        if !self.seeded.load(Ordering::SeqCst) {
                            if let Ok(ids) = fetch_recent_note_ids(&http, &url).await {
                                self.note_claims.lock().unwrap().seen_by_poller.extend(ids);
                                self.seeded.store(true, Ordering::SeqCst);
                            }
                        }
                    } else {
                        let replay_active = self.obs_replay_active.load(Ordering::SeqCst)
                            || app.state::<crate::obs::Obs>().is_replay_buffer_active();
                        let should_poll_notes = replay_active
                            || config.obs.disable_recording
                            || !self.seeded.load(Ordering::SeqCst);
                        if should_poll_notes {
                            match fetch_recent_note_ids(&http, &url).await {
                                Ok(ids) => {
                                    self.anki_connected.store(true, Ordering::SeqCst);
                                    let new_ids = {
                                        let mut notes = self.note_claims.lock().unwrap();
                                        let seen = &mut notes.seen_by_poller;
                                        if !self.seeded.swap(true, Ordering::SeqCst) {
                                            seen.extend(ids);
                                            Vec::new()
                                        } else {
                                            let mut diff = Vec::new();
                                            for id in ids {
                                                if seen.insert(id) {
                                                    diff.push(id);
                                                }
                                            }
                                            diff
                                        }
                                    };
                                    // Avoid flooding if user imported a huge deck all at once.
                                    if new_ids.len() <= 5 {
                                        for id in new_ids {
                                            pipeline::spawn_card_processing(
                                                app.clone(),
                                                Arc::clone(&self),
                                                id,
                                                None,
                                            );
                                        }
                                    } else {
                                        crate::desktop_log::info(
                                            &app,
                                            "mining",
                                            format!(
                                                "Skipped bulk Anki import of {} notes",
                                                new_ids.len()
                                            ),
                                        );
                                    }
                                }
                                Err(_) => {
                                    self.anki_connected.store(false, Ordering::SeqCst);
                                }
                            }
                        } else if last_availability_probe.elapsed() >= Duration::from_secs(5) {
                            last_availability_probe = Instant::now();
                            let ok = probe_anki_version(&http, &url).await;
                            self.anki_connected.store(ok, Ordering::SeqCst);
                        }
                    }
                }
            }

            let sleep_dur = if beacon_active {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(poll_ms)
            };

            tokio::select! {
                _ = tokio::time::sleep(sleep_dur) => {}
                _ = self.wake_monitor.notified() => {}
                _ = beacon_wake.notified() => {}
                maybe_evt = beacon_rx.recv(), if config.anki.enabled => {
                    if let Some(evt) = maybe_evt {
                        self.handle_beacon_event(&app, evt);
                    }
                }
            }
        }
    }

    fn handle_beacon_event(self: &Arc<Self>, app: &AppHandle, evt: BeaconNoteEvent) {
        self.anki_connected.store(true, Ordering::SeqCst);
        self.anki_beacon_connected.store(true, Ordering::SeqCst);
        pipeline::spawn_card_processing(app.clone(), Arc::clone(self), evt.note_id, Some(evt));
    }

    pub async fn handle_request(
        self: &Arc<Self>,
        app: &AppHandle,
        topic: &str,
        data: Value,
    ) -> Result<Value, String> {
        match topic {
            "mining.gateway.register" => {
                let http_port = data["httpPort"]
                    .as_u64()
                    .and_then(|p| u16::try_from(p).ok())
                    .filter(|&p| p > 0);
                let ws_port = data["wsPort"]
                    .as_u64()
                    .and_then(|p| u16::try_from(p).ok())
                    .filter(|&p| p > 0);
                let direct_ws_port = data["directWsPort"]
                    .as_u64()
                    .and_then(|p| u16::try_from(p).ok())
                    .unwrap_or(0);
                if let Ok(guard) = self.gateway.lock() {
                    if let Some(ref handle) = *guard {
                        handle.set_upstreams(http_port, ws_port, direct_ws_port);
                    }
                }
                Ok(json!({
                    "ok": true,
                    "gatewayPort": self.bound_gateway_port(),
                }))
            }
            "mining.replayState" => {
                let active = data["active"].as_bool().unwrap_or(false);
                self.set_obs_replay_active(active);
                Ok(json!({ "active": active }))
            }
            "mining.configChanged" => {
                self.invalidate_config_cache();
                self.wake_monitor.notify_one();
                Ok(json!({ "ok": true }))
            }
            "mining.status" => Ok(self.status_snapshot()),
            "mining.ai" => self.handle_ai_request(app, data).await,
            "mining.sessionReview" => self.handle_session_review_request(app, data).await,
            _ => Err(format!("Unsupported mining topic: {topic}")),
        }
    }

    async fn handle_ai_request(&self, app: &AppHandle, data: Value) -> Result<Value, String> {
        let action = data["action"].as_str().unwrap_or("");
        let config = self
            .load_config()
            .map_err(|e| format!("Failed loading GSM config: {e}"))?;
        let parse_lines = |v: &Value| -> Vec<gsm_mining::text::GameLine> {
            v.as_array()
                .into_iter()
                .flatten()
                .filter_map(session_review::parse_game_line_value)
                .collect()
        };

        match action {
            "translate" => {
                let lines = parse_lines(&data["lines"]);
                let sentence = data["sentence"].as_str().unwrap_or("");
                let current_line = data
                    .get("current_line")
                    .and_then(session_review::parse_game_line_value);
                let game_title = data["game_title"].as_str().unwrap_or("");
                let custom_prompt = data["custom_prompt"].as_str();
                let force_refresh = data["force_refresh"].as_bool().unwrap_or(false);
                let translation_only = data["translation_only"].as_bool().unwrap_or(false);
                let char_ctx =
                    pipeline::fetch_character_context(app, self, &config, game_title).await;
                let text = self
                    .ai
                    .translate(
                        &config,
                        &lines,
                        sentence,
                        current_line.as_ref(),
                        game_title,
                        &char_ctx,
                        custom_prompt,
                        force_refresh,
                        translation_only,
                    )
                    .await;
                Ok(json!({ "text": text }))
            }
            "analyze" => {
                let lines = parse_lines(&data["lines"]);
                let sentence = data["sentence"].as_str().unwrap_or("");
                let current_line = data
                    .get("current_line")
                    .and_then(session_review::parse_game_line_value);
                let game_title = data["game_title"].as_str().unwrap_or("");
                let mode = data["mode"].as_str().unwrap_or("sentence");
                let question = data["question"].as_str().unwrap_or("");
                let text = self
                    .ai
                    .analyze(
                        &config,
                        &lines,
                        sentence,
                        current_line.as_ref(),
                        game_title,
                        mode,
                        question,
                    )
                    .await?;
                Ok(json!({ "text": text }))
            }
            "overlayTranslate" => {
                let lines = parse_lines(&data["lines"]);
                let game_title = data["game_title"].as_str().unwrap_or("");
                let validated = OverlayBlocks::parse(&data["blocks"])?;
                let translated = self
                    .ai
                    .translate_overlay_blocks(&config, &lines, &validated, game_title)
                    .await?;
                Ok(json!({ "blocks": translated }))
            }
            "rawPrompt" => {
                let prompt = data["prompt"].as_str().unwrap_or("");
                let kind = data["request_kind"].as_str().unwrap_or("custom");
                let text = self
                    .ai
                    .generate_raw_prompt(&config.ai, prompt.to_string(), kind)
                    .await?;
                Ok(json!({ "text": text }))
            }
            "characterSummary" => {
                let summary = match self
                    .ai
                    .generate_character_summary(&config.ai, &data["character_data"])
                    .await
                {
                    Ok(summary) => summary,
                    Err(error) => {
                        crate::desktop_log::warn(app, "mining", format!("Character summary request failed: {error}"));
                        None
                    }
                };
                Ok(json!({ "text": summary }))
            }
            _ => Err(format!("Unknown mining.ai action: {action}")),
        }
    }

    async fn handle_session_review_request(
        &self,
        app: &AppHandle,
        data: Value,
    ) -> Result<Value, String> {
        let action = data["action"].as_str().unwrap_or("");
        let config = ProfileConfig::load_active(&self.data_dir.join("config.json"))
            .map_err(|e| format!("Failed loading GSM config: {e}"))?;
        let tools = MediaTools::discover(Some(&app.state::<crate::settings::Settings>().paths.shared), self.temp_dir());
        let pauses = Arc::clone(&self.pause_history);
        let vad = Arc::clone(&self.vad);
        let http = app.state::<crate::desktop_state::DesktopState>().http.clone();

        match action {
            "extractAudio" => tauri::async_runtime::spawn_blocking(move || {
                session_review::extract_audio_for_review(
                    &data, &config, &tools, &pauses, &vad, &http,
                )
            })
            .await
            .map_err(|e| e.to_string())?,
            "captureFutureReplay" => {
                let targets = data["targets"].as_array().cloned().unwrap_or_default();
                if targets.is_empty() {
                    return Ok(json!({ "attached": 0 }));
                }
                let saved = app.state::<crate::obs::Obs>().save_replay(app).await?;
                let saved_path = saved["savedReplayPath"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or("OBS SaveReplayBuffer did not return a replay path")?;
                let video_path = PathBuf::from(saved_path);
                let _ = gsm_mining::ffmpeg::wait_for_stable_file_async(
                    video_path.clone(),
                    Duration::from_secs(10),
                    Duration::from_millis(100),
                )
                .await;
                let data_dir = self.data_dir.clone();
                let remove_video = config.paths.remove_video;
                let attached = tauri::async_runtime::spawn_blocking(move || {
                    let count = session_review::attach_future_replay(
                        &data_dir,
                        &video_path,
                        &targets,
                        &tools,
                        &pauses,
                    )?;
                    if remove_video {
                        let _ = std::fs::remove_file(&video_path);
                    }
                    Ok::<usize, String>(count)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "attached": attached }))
            }
            _ => Err(format!("Unknown mining.sessionReview action: {action}")),
        }
    }
}

async fn fetch_recent_note_ids(
    client: &reqwest::Client,
    url: &reqwest::Url,
) -> Result<Vec<u64>, String> {
    let collection = Collection { client, url };
    collection
        .call("findNotes", json!({ "query": "added:1" }), |raw| {
            serde_json::from_str::<Vec<u64>>(raw.get()).map_err(|e| e.to_string())
        })
        .await
}

async fn probe_anki_version(client: &reqwest::Client, url: &reqwest::Url) -> bool {
    client
        .post(url.clone())
        .json(&json!({ "action": "version", "version": 6 }))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .is_ok()
}

#[cfg(windows)]
fn current_process_private_working_set() -> Option<u64> {
    crate::resource_usage::current_process_private_working_set()
}

#[cfg(not(windows))]
fn current_process_private_working_set() -> Option<u64> {
    None
}
