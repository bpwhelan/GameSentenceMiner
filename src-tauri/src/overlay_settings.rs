//! Overlay user settings, defaults, normalization, profile scoping,
//! GSM-owned config reconciliation, and hotkey validation/accelerator parsing.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_GSM_SINGLE_PORT: u16 = 7275;
pub const OVERLAY_SETTINGS_PROFILES_ENABLED_KEY: &str = "overlaySettingsProfilesEnabled";
pub const OVERLAY_ACTIVE_PROFILE_KEY: &str = "overlayActiveProfileName";
pub const OVERLAY_PROFILE_SETTINGS_KEY: &str = "overlayProfileSettings";
pub const GUIDE_SCENE_SETTINGS_KEY: &str = "vnGuideSceneSettings";
pub const DEFAULT_GSM_PROFILE_NAME: &str = "Default";

/// Guide selection follows the OBS scene; presentation still follows overlay profiles.
pub const VN_GUIDE_SCENE_SETTING_KEYS: &[&str] = &["vnGuideEnabled", "vnGuideUrl", "vnGuideRoute"];

fn guide_selection(settings: &Map<String, Value>) -> Value {
    json!({
        "vnGuideEnabled": settings.get("vnGuideEnabled").and_then(Value::as_bool) == Some(true),
        "vnGuideUrl": settings.get("vnGuideUrl").and_then(Value::as_str).unwrap_or(""),
        "vnGuideRoute": settings.get("vnGuideRoute").and_then(Value::as_str).unwrap_or("")
    })
}

fn initialize_guide_scenes(settings: &mut Map<String, Value>) {
    if settings
        .get(GUIDE_SCENE_SETTINGS_KEY)
        .is_some_and(|v| v["scenes"].is_object())
    {
        return;
    }
    let mut legacy = Map::new();
    if settings.get(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY) == Some(&json!(true)) {
        if let Some(profiles) = settings
            .get(OVERLAY_PROFILE_SETTINGS_KEY)
            .and_then(Value::as_object)
        {
            for (name, profile) in profiles {
                if let Some(profile) = profile.as_object() {
                    legacy.insert(name.clone(), guide_selection(profile));
                }
            }
        }
        let active = settings
            .get("overlayActiveProfileName")
            .or_else(|| settings.get(OVERLAY_ACTIVE_PROFILE_KEY))
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_GSM_PROFILE_NAME);
        legacy.insert(active.into(), guide_selection(settings));
    } else {
        legacy.insert("*".into(), guide_selection(settings));
    }
    settings.insert(
        GUIDE_SCENE_SETTINGS_KEY.into(),
        json!({"scenes":{},"legacyProfiles":legacy}),
    );
}

/// Select only when the host sees a new nonempty OBS scene. Consume old selections once.
pub fn select_guide_scene(
    settings: &mut Map<String, Value>,
    scene: &str,
    profile: &str,
) -> Map<String, Value> {
    if scene.trim().is_empty() {
        return Map::new();
    }
    initialize_guide_scenes(settings);
    let store = settings
        .get_mut(GUIDE_SCENE_SETTINGS_KEY)
        .unwrap()
        .as_object_mut()
        .unwrap();
    if !store.get("legacyProfiles").is_some_and(Value::is_object) {
        store.insert("legacyProfiles".into(), json!({}));
    }
    let legacy_key = if store["legacyProfiles"].get(profile).is_some() {
        profile
    } else {
        "*"
    };
    let saved = store
        .remove("unassigned")
        .or_else(|| store["scenes"].get(scene).cloned())
        .or_else(|| store["legacyProfiles"].get(legacy_key).cloned())
        .unwrap_or_else(|| json!({}));
    store
        .get_mut("legacyProfiles")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove(legacy_key);
    let selection = guide_selection(saved.as_object().unwrap_or(&Map::new()));
    store.get_mut("scenes").unwrap()[scene] = selection.clone();
    let patch = selection.as_object().unwrap().clone();
    settings.extend(patch.clone());
    patch
}

pub fn record_guide_scene(settings: &mut Map<String, Value>, scene: Option<&str>) {
    initialize_guide_scenes(settings);
    let selection = guide_selection(settings);
    let store = settings.get_mut(GUIDE_SCENE_SETTINGS_KEY).unwrap();
    if let Some(scene) = scene.filter(|s| !s.trim().is_empty()) {
        store["scenes"][scene] = selection;
    } else {
        store["unassigned"] = selection;
    }
}

/// Global (non-profile-scoped) overlay settings keys matching `GSM_Overlay/main.js`.
pub fn is_non_profile_setting_key(key: &str) -> bool {
    matches!(
        key,
        "weburl1"
            | "weburl2"
            | "texthookerUrl"
            | "openTexthookerOnStartup"
            | "openSettingsOnStartup"
            | "hideOnStartup"
            | "hideOverlayOnStartup"
            | "pinned"
            | "dictionaryReaderSelection"
            | "overlaySettingsProfilesEnabled"
            | "overlayActiveProfile"
            | "overlayActiveProfileName"
            | "overlayProfileSettings"
            | "guideSceneSettings"
            | "vnGuideSceneSettings"
            | "vnGuideCatalogueSource"
            | "platformOverride"
            | "dismissedManualModeGames"
            | "dismissedFullscreenModeGames"
            | "showManualModeRecommendations"
            | "showExclusiveFullscreenRecommendations"
            | "pushToShowEnforcedDialogDismissed"
            | "mainBoxStartupWarningAcknowledged"
            | "localVocabularyEnabled"
            | "gamepadServerPort"
            | "gamepadJitenApiKey"
            | "gamepadJpdbApiKey"
            | "gamepadYomitanApiUrl"
            | "gamepadQuickActionsQuestion"
            | "engine_v2"
            | "monitor_to_capture"
            | "monitor_to_capture_id"
            | "periodic"
            | "periodic_interval"
            | "periodic_ratio"
            | "scan_on_mouse_move"
            | "scan_on_overlay_activation"
            | "text_appears_instantly"
            | "adaptive_ocr_retries"
            | "base_scale"
            | "inject_scanned_lines"
            | "minimum_character_size"
            | "use_ocr_result_v2"
            | "supplement_ocr_result_with_overlay"
            | "last_sent_ocr_presence_check"
            | "last_sent_ocr_presence_remove_notation"
            | "last_sent_ocr_presence_invalidate_lookups"
            | "ocr_full_screen_instead_of_obs"
            | "use_text_filtering"
            | "manual_mode_desktop_background"
            | "showRecycledIndicator"
            | "use_overlay_area_config"
            | "ocr_area_config_include_primary_areas"
            | "ocr_area_config_include_secondary_areas"
            | "ocr_area_config_use_exclusion_zones"
    )
}

/// Mapping from GSM backend (`config.json` `overlay.*`) field names to overlay UI setting keys.
/// Mirrors `GSM_OWNED_OVERLAY_FIELDS` in `GameSentenceMiner/util/config/configuration.py`.
pub const GSM_OWNED_OVERLAY_FIELD_MAP: &[(&str, &str)] = &[
    ("engine_v2", "engine_v2"),
    ("monitor_to_capture", "monitor_to_capture"),
    ("monitor_to_capture_id", "monitor_to_capture_id"),
    ("periodic", "periodic"),
    ("periodic_interval", "periodic_interval"),
    ("periodic_ratio", "periodic_ratio"),
    ("scan_on_mouse_move", "scan_on_mouse_move"),
    ("scan_on_overlay_activation", "scan_on_overlay_activation"),
    ("text_appears_instantly", "text_appears_instantly"),
    ("adaptive_ocr_retries", "adaptive_ocr_retries"),
    ("base_scale", "base_scale"),
    ("inject_scanned_lines", "inject_scanned_lines"),
    ("minimum_character_size", "minimum_character_size"),
    ("use_ocr_result_v2", "use_ocr_result_v2"),
    (
        "supplement_ocr_result_with_overlay",
        "supplement_ocr_result_with_overlay",
    ),
    (
        "last_sent_ocr_presence_check",
        "last_sent_ocr_presence_check",
    ),
    (
        "last_sent_ocr_presence_remove_notation",
        "last_sent_ocr_presence_remove_notation",
    ),
    (
        "last_sent_ocr_presence_invalidate_lookups",
        "last_sent_ocr_presence_invalidate_lookups",
    ),
    (
        "ocr_full_screen_instead_of_obs",
        "ocr_full_screen_instead_of_obs",
    ),
    ("use_text_filtering", "use_text_filtering"),
    (
        "manual_mode_desktop_background",
        "manual_mode_desktop_background",
    ),
    (
        "check_previous_lines_for_recycled_indicator",
        "showRecycledIndicator",
    ),
    ("use_overlay_area_config", "use_overlay_area_config"),
    (
        "ocr_area_config_include_primary_areas",
        "ocr_area_config_include_primary_areas",
    ),
    (
        "ocr_area_config_include_secondary_areas",
        "ocr_area_config_include_secondary_areas",
    ),
    (
        "ocr_area_config_use_exclusion_zones",
        "ocr_area_config_use_exclusion_zones",
    ),
];

pub fn overlay_key_to_gsm_field(overlay_key: &str) -> Option<&'static str> {
    GSM_OWNED_OVERLAY_FIELD_MAP
        .iter()
        .find(|(_, k)| *k == overlay_key)
        .map(|(f, _)| *f)
}

#[allow(dead_code)]
pub fn is_gsm_owned_overlay_key(key: &str) -> bool {
    overlay_key_to_gsm_field(key).is_some()
}

pub fn default_quick_actions() -> Value {
    json!([
        "scan",
        "translate",
        "toggle-furigana",
        "toggle-translation",
        "mine",
        "texthooker"
    ])
}

pub fn default_user_settings_map() -> Map<String, Value> {
    let mut map = Map::with_capacity(180);
    macro_rules! put {
        ($($k:literal : $v:expr),* $(,)?) => {
            $(map.insert($k.to_string(), json!($v));)*
        };
    }
    put! {
        "fontSize": 42,
        "weburl1": format!("ws://localhost:{DEFAULT_GSM_SINGLE_PORT}/ws/texthooker"),
        "weburl2": format!("ws://localhost:{DEFAULT_GSM_SINGLE_PORT}/ws/overlay"),
        "texthookerUrl": format!("http://localhost:{DEFAULT_GSM_SINGLE_PORT}/texthooker"),
        "openTexthookerOnStartup": false,
        "openSettingsOnStartup": false,
        "hideOnStartup": true,
        "hideOverlayOnStartup": false,
        "pinned": false,
        "offsetX": 0,
        "offsetY": 0,
        "showReadyIndicator": false,
        "showTextIndicators": true,
        "fadeTextIndicators": false,
        "showTextHitboxes": false,
        "showRecycledIndicator": true,
        "afkTimer": 5,
        "dictionaryReaderSelection": "yomitan",
        "focusOverlayOnYomitanLookup": false,
        "textHoverClickThrough": false,
        "hideYomitanAfterMine": false,
        "routeAllHotkeysThroughInputServer": false,
        "manualMode": false,
        "manualModeType": "hold",
        "requireGameFocusForPushToShow": true,
        "manualModeInactiveBehavior": "hide-overlay",
        "manualModeDisableInteractionFocusOverlay": false,
        "showManualModeRecommendations": true,
        "showExclusiveFullscreenRecommendations": true,
        "dismissedManualModeGames": Vec::<Value>::new(),
        "dismissedFullscreenModeGames": Vec::<Value>::new(),
        "pushToShowEnforcedDialogDismissed": true,
        "mainBoxStartupWarningAcknowledged": true,
        "showHotkey": "Shift + Space",
        "autoRequestTranslation": false,
        "translateHotkey": "Alt+T",
        "toggleFuriganaHotkey": "Alt+F",
        "toggleWindowHotkey": "Alt+Shift+H",
        "minimizeHotkey": "Alt+Shift+J",
        "yomitanSettingsHotkey": "Alt+Shift+Y",
        "overlaySettingsHotkey": "Alt+Shift+S",
        "texthookerHotkey": "Alt+Shift+W",
        "customPageEnabled": false,
        "customPageUrl": "",
        "customPageHotkey": "Alt+Shift+U",
        "vnGuideEnabled": false,
        "vnGuideUrl": "",
        "vnGuideRoute": "",
        "vnGuideMode": "auto",
        "vnGuideDisplayStyle": "card",
        "vnGuideAutoAdvance": true,
        "vnGuideClickThroughOnChoice": true,
        "vnGuideToggleHotkey": "Alt+Shift+G",
        "vnGuideNextHotkey": "Alt+Shift+Right",
        "vnGuideBackHotkey": "Alt+Shift+Left",
        "vnGuideCatalogueSource": "",
        "vnGuideSceneSettings": Value::Object(Map::new()),
        "readingLanguage": "japanese",
        "showFurigana": false,
        "hideFuriganaOnStartup": false,
        "hideFuriganaAfterSeconds": 0,
        "furiganaScale": 0.55,
        "furiganaYOffset": -2,
        "jitenHighlightOffsetY": 3,
        "jitenHighlightOpacity": 0.85,
        "furiganaColor": "#ffffff",
        "pinyinToneColors": true,
        "pinyinTone1Color": "#ff5252",
        "pinyinTone2Color": "#ffb300",
        "pinyinTone3Color": "#4caf50",
        "pinyinTone4Color": "#42a5f5",
        "pinyinTone5Color": "#e0e0e0",
        "furiganaOutlineColor": "#222222",
        "furiganaOutlineWidth": 1.5,
        "furiganaFontFamily": "\"Yu Gothic UI\", \"Hiragino Sans\", sans-serif",
        "furiganaFontWeight": "600",
        "enableJitenReader": true,
        "jitenHighlightingEnabled": false,
        "showJitenGradingButtons": false,
        "localVocabularyEnabled": false,
        "showLiveStats": true,
        "showLiveGoals": true,
        "hideCompletedGoals": true,
        "hideLiveStatsOnTextOverlap": true,
        "liveStatsToggleHotkey": "Alt+Shift+L",
        "liveStatsScope": "session",
        "liveStatsDisplayModeV2": "always",
        "liveStatsLayoutV2": "one-line",
        "liveStatsAutoHideSeconds": 5,
        "liveStatsPositionMode": "active-window",
        "liveStatsVisibilityMode": "all",
        "overlayGoals": Value::Object(Map::new()),
        "pomodoroEnabled": false,
        "pomodoroWorkMinutes": 25,
        "pomodoroBreakMinutes": 5,
        "pomodoroAutoStart": false,
        "overlaySettingsProfilesEnabled": false,
        "overlayActiveProfile": DEFAULT_GSM_PROFILE_NAME,
        "overlayProfileSettings": Value::Object(Map::new()),
        "platformOverride": Value::Null,
        "magpieCompatibility": true,
        // GSM-owned OCR defaults mirrored locally for immediate UI readiness
        "engine_v2": if cfg!(windows) { "oneocr" } else { "meikiocr" },
        "monitor_to_capture": 0,
        "monitor_to_capture_id": "",
        "periodic": false,
        "periodic_interval": 1.0,
        "periodic_ratio": 0.9,
        "scan_on_mouse_move": false,
        "scan_on_overlay_activation": true,
        "text_appears_instantly": false,
        "adaptive_ocr_retries": true,
        "base_scale": 0.75,
        "inject_scanned_lines": false,
        "minimum_character_size": 0,
        "use_ocr_result_v2": true,
        "supplement_ocr_result_with_overlay": false,
        "last_sent_ocr_presence_check": true,
        "last_sent_ocr_presence_remove_notation": true,
        "last_sent_ocr_presence_invalidate_lookups": true,
        "ocr_full_screen_instead_of_obs": false,
        "use_text_filtering": true,
        "manual_mode_desktop_background": "off",
        "use_overlay_area_config": true,
        "ocr_area_config_include_primary_areas": true,
        "ocr_area_config_include_secondary_areas": true,
        "ocr_area_config_use_exclusion_zones": true,
        // Gamepad / keyboard navigation defaults
        "gamepadEnabled": true,
        "gamepadActivationMode": "modifier",
        "gamepadModifierButton": 4,
        "gamepadToggleButton": 8,
        "gamepadConfirmButton": 0,
        "gamepadCancelButton": 1,
        "gamepadForwardEnterButton": -1,
        "gamepadForwardSpaceButton": -1,
        "gamepadForwardCtrlButton": -1,
        "gamepadForwardEscapeButton": -1,
        "gamepadForwardClickButton": -1,
        "gamepadManualOverlayScanButton": -1,
        "gamepadTranslateButton": -1,
        "gamepadPauseToggleButton": -1,
        "gamepadQuickActionsButton": 9,
        "gamepadTokenModeToggleButton": 3,
        "gamepadMineButton": 0,
        "gamepadNextEntryButton": 7,
        "gamepadPrevEntryButton": 6,
        "gamepadPrevJitenWordButton": -1,
        "gamepadNextJitenWordButton": -1,
        "gamepadNavigateUp": 12,
        "gamepadNavigateDown": 13,
        "gamepadNavigateLeft": 14,
        "gamepadNavigateRight": 15,
        "keyboardQuickActionsKey": "Tab",
        "keyboardModifierKey": Value::Null,
        "keyboardToggleKey": Value::Null,
        "keyboardConfirmKey": "Enter",
        "keyboardCancelKey": "Escape",
        "keyboardForwardEnterKey": Value::Null,
        "keyboardForwardSpaceKey": Value::Null,
        "keyboardForwardCtrlKey": Value::Null,
        "keyboardForwardEscapeKey": Value::Null,
        "keyboardForwardClickKey": Value::Null,
        "keyboardManualOverlayScanKey": Value::Null,
        "keyboardPauseToggleKey": Value::Null,
        "keyboardTokenModeToggleKey": Value::Null,
        "keyboardNextEntryKey": Value::Null,
        "keyboardPrevEntryKey": Value::Null,
        "keyboardPrevJitenWordKey": Value::Null,
        "keyboardNextJitenWordKey": Value::Null,
        "keyboardNavigateUp": "ArrowUp",
        "keyboardNavigateDown": "ArrowDown",
        "keyboardNavigateLeft": "ArrowLeft",
        "keyboardNavigateRight": "ArrowRight",
        "gamepadQuickActions": default_quick_actions(),
        "gamepadQuickActionsQuestion": "",
        "gamepadTokenMode": false,
        "gamepadFocusOverlayOnEntry": true,
        "gamepadShowModeIndicator": true,
        "gamepadShowNavigationStatus": true,
        "gamepadTokenizerBackend": "sudachi",
        "gamepadLocalTokenizerFallbackBackend": "sudachi",
        "gamepadSudachiDictionary": "core",
        "gamepadYomitanApiUrl": "http://127.0.0.1:19633",
        "gamepadYomitanScanLength": 10,
        "gamepadJitenApiKey": "",
        "gamepadJpdbApiKey": "",
        "gamepadAutoConfirmSelection": false,
        "gamepadRepeatDelay": 400,
        "gamepadRepeatRate": 150,
        "gamepadHoldNavigation": "repeat",
        "gamepadHorizontalWrap": "adjacent",
        "gamepadVerticalNavigation": "lines",
        "gamepadInitialPosition": "remember",
        "gamepadBlockJumpAnimation": false,
        "gamepadAnalogAcceleration": false,
        "gamepadControllerEnabled": true,
        "gamepadKeyboardEnabled": true,
        "gamepadXinputEnabled": true,
        "gamepadDinputEnabled": false,
        "gamepadKeyboardHotkey": "Alt+G",
        "gamepadServerPort": 7276,
    }
    map.insert(
        "liveStatsFields".to_string(),
        json!({
            "chars_per_hour": true,
            "total_characters": true,
            "active_reading_time": true,
            "raw_reading_time": true,
            "cards_mined": true
        }),
    );
    map
}

pub fn derive_gsm_urls(single_port: u16) -> (String, String, String) {
    let port = if single_port == 0 {
        DEFAULT_GSM_SINGLE_PORT
    } else {
        single_port
    };
    (
        format!("ws://localhost:{port}/ws/texthooker"),
        format!("ws://localhost:{port}/ws/overlay"),
        format!("http://localhost:{port}/texthooker"),
    )
}

pub fn settings_file_path(overlay_data_dir: &Path) -> PathBuf {
    overlay_data_dir.join("settings.json")
}

pub fn load_settings_from_disk(overlay_data_dir: &Path, single_port: u16) -> Map<String, Value> {
    let mut map = default_user_settings_map();
    let path = settings_file_path(overlay_data_dir);
    if let Ok(raw) = fs::read_to_string(&path) {
        let trimmed = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
        if let Ok(Value::Object(mut saved)) = serde_json::from_str::<Value>(trimmed) {
            migrate_legacy_settings(&mut saved);
            for (k, v) in saved {
                map.insert(k, v);
            }
        }
    }
    normalize_user_settings(&mut map, single_port);
    map
}

pub fn save_settings_atomic(
    overlay_data_dir: &Path,
    settings: &Map<String, Value>,
) -> Result<(), String> {
    gsm_settings::write_atomic(
        &settings_file_path(overlay_data_dir),
        &Value::Object(settings.clone()),
    )
}

fn migrate_legacy_settings(saved: &mut Map<String, Value>) {
    for (old, new) in [
        (
            "dismissedFullscreenRecommendations",
            "dismissedManualModeGames",
        ),
        (
            "dismissedExclusiveFullscreenRecommendations",
            "dismissedFullscreenModeGames",
        ),
    ] {
        if !saved.contains_key(new) {
            if let Some(value) = saved.get(old).cloned() {
                saved.insert(new.into(), value);
            }
        }
    }
    if !saved.contains_key("showTextIndicators") {
        saved.insert("showTextIndicators".into(), json!(true));
        saved.insert(
            "fadeTextIndicators".into(),
            json!(saved
                .get("showTextBackground")
                .and_then(Value::as_bool)
                .unwrap_or(false)),
        );
    }
    if let Some(profiles) = saved
        .get_mut(OVERLAY_PROFILE_SETTINGS_KEY)
        .and_then(Value::as_object_mut)
    {
        for profile in profiles.values_mut().filter_map(Value::as_object_mut) {
            migrate_legacy_settings(profile);
        }
    }
    if let Some(devices) = saved
        .get("gamepadDeviceBlacklist")
        .and_then(Value::as_array)
    {
        let mut names = HashSet::new();
        let devices = devices
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .filter(|name| names.insert(name.to_lowercase()))
            .map(|s| json!(s))
            .collect();
        saved.insert("gamepadDeviceBlacklist".into(), Value::Array(devices));
    }
}

fn clamp_i64(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    let Some(val) = value else {
        return fallback;
    };
    let n = val
        .as_f64()
        .or_else(|| val.as_str().and_then(|s| s.trim().parse::<f64>().ok()));
    match n {
        Some(v) if v.is_finite() => (v.round() as i64).clamp(min, max),
        _ => fallback,
    }
}

fn clamp_f64(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    let Some(val) = value else {
        return fallback;
    };
    let n = val
        .as_f64()
        .or_else(|| val.as_str().and_then(|s| s.trim().parse::<f64>().ok()));
    match n {
        Some(v) if v.is_finite() => v.clamp(min, max),
        _ => fallback,
    }
}

fn norm_bool(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => true,
            "false" | "0" | "no" => false,
            _ => fallback,
        },
        Some(Value::Number(n)) => n.as_i64().unwrap_or(if fallback { 1 } else { 0 }) != 0,
        _ => fallback,
    }
}

fn norm_enum(value: Option<&Value>, valid: &[&str], fallback: &str) -> String {
    let s = value
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim()
        .to_ascii_lowercase();
    if valid.iter().any(|candidate| *candidate == s) {
        s
    } else {
        fallback.to_string()
    }
}

fn norm_color(value: Option<&Value>, fallback: &str) -> String {
    let s = value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if s.is_empty() {
        fallback.to_string()
    } else {
        s
    }
}

/// Normalize & migrate a loaded or updated settings map in place. Returns `true` if modified.
pub fn normalize_user_settings(settings: &mut Map<String, Value>, single_port: u16) -> bool {
    let before = settings.clone();
    if !settings.contains_key(OVERLAY_ACTIVE_PROFILE_KEY) {
        if let Some(active) = settings.remove("overlayActiveProfile") {
            settings.insert(OVERLAY_ACTIVE_PROFILE_KEY.into(), active);
        }
    }
    let defaults = default_user_settings_map();
    for (k, v) in &defaults {
        settings.entry(k.clone()).or_insert_with(|| v.clone());
    }

    let (ws1, ws2, texthooker) = derive_gsm_urls(single_port);
    settings.insert("weburl1".into(), json!(ws1));
    settings.insert("weburl2".into(), json!(ws2));
    settings.insert("texthookerUrl".into(), json!(texthooker));

    // Local vocabulary stays off until explicitly supported cleanly in production
    if settings
        .get("localVocabularyEnabled")
        .and_then(Value::as_bool)
        != Some(false)
    {
        settings.insert("localVocabularyEnabled".into(), json!(false));
    }

    settings.insert(
        "fontSize".into(),
        json!(clamp_i64(settings.get("fontSize"), 42, 8, 200)),
    );
    settings.insert(
        "afkTimer".into(),
        json!(clamp_i64(settings.get("afkTimer"), 5, 0, 60)),
    );
    settings.insert(
        "dictionaryReaderSelection".into(),
        json!(norm_enum(
            settings.get("dictionaryReaderSelection"),
            &["yomitan", "hachidori"],
            "yomitan"
        )),
    );
    settings.insert(
        "manualModeType".into(),
        json!(norm_enum(
            settings.get("manualModeType"),
            &["hold", "hybrid", "toggle"],
            "hold"
        )),
    );
    settings.insert(
        "requireGameFocusForPushToShow".into(),
        json!(norm_bool(settings.get("requireGameFocusForPushToShow"), true)),
    );
    settings.insert(
        "manualModeInactiveBehavior".into(),
        json!(norm_enum(
            settings.get("manualModeInactiveBehavior"),
            &["hide-overlay", "disable-interaction"],
            "hide-overlay"
        )),
    );
    settings.insert(
        "readingLanguage".into(),
        json!(norm_enum(
            settings.get("readingLanguage"),
            &["japanese", "chinese"],
            "japanese"
        )),
    );
    settings.insert(
        "platformOverride".into(),
        match settings.get("platformOverride").and_then(Value::as_str) {
            Some("win32" | "linux" | "darwin") => settings["platformOverride"].clone(),
            _ => Value::Null,
        },
    );

    // Live Stats normalization
    settings.insert(
        "showLiveStats".into(),
        json!(norm_bool(settings.get("showLiveStats"), true)),
    );
    settings.insert(
        "showLiveGoals".into(),
        json!(norm_bool(settings.get("showLiveGoals"), true)),
    );
    settings.insert(
        "hideCompletedGoals".into(),
        json!(norm_bool(settings.get("hideCompletedGoals"), true)),
    );
    settings.insert(
        "hideLiveStatsOnTextOverlap".into(),
        json!(norm_bool(settings.get("hideLiveStatsOnTextOverlap"), true)),
    );
    settings.insert(
        "liveStatsScope".into(),
        json!(norm_enum(
            settings.get("liveStatsScope"),
            &["session", "today"],
            "session"
        )),
    );
    settings.insert(
        "liveStatsDisplayModeV2".into(),
        json!(norm_enum(
            settings.get("liveStatsDisplayModeV2"),
            &["always", "new-line"],
            "always"
        )),
    );
    settings.insert(
        "liveStatsLayoutV2".into(),
        json!(norm_enum(
            settings.get("liveStatsLayoutV2"),
            &["stacked", "one-line"],
            "one-line"
        )),
    );
    settings.insert(
        "liveStatsAutoHideSeconds".into(),
        json!(clamp_i64(
            settings.get("liveStatsAutoHideSeconds"),
            5,
            0,
            60
        )),
    );
    settings.insert(
        "liveStatsPositionMode".into(),
        json!(norm_enum(
            settings.get("liveStatsPositionMode"),
            &["active-window", "overlay"],
            "active-window"
        )),
    );
    settings.insert(
        "liveStatsVisibilityMode".into(),
        json!(norm_enum(
            settings.get("liveStatsVisibilityMode"),
            &["all", "stats", "goals", "hidden"],
            "all"
        )),
    );
    let mut fields = Map::new();
    let existing_fields = settings.get("liveStatsFields").and_then(Value::as_object);
    for key in [
        "chars_per_hour",
        "total_characters",
        "active_reading_time",
        "raw_reading_time",
        "cards_mined",
    ] {
        let enabled = existing_fields
            .and_then(|m| m.get(key))
            .map(|v| norm_bool(Some(v), true))
            .unwrap_or(true);
        fields.insert(key.into(), json!(enabled));
    }
    settings.insert("liveStatsFields".into(), Value::Object(fields));

    // Pomodoro normalization
    settings.insert(
        "pomodoroEnabled".into(),
        json!(norm_bool(settings.get("pomodoroEnabled"), false)),
    );
    settings.insert(
        "pomodoroAutoStart".into(),
        json!(norm_bool(settings.get("pomodoroAutoStart"), false)),
    );
    settings.insert(
        "pomodoroWorkMinutes".into(),
        json!(clamp_i64(settings.get("pomodoroWorkMinutes"), 25, 1, 180)),
    );
    settings.insert(
        "pomodoroBreakMinutes".into(),
        json!(clamp_i64(settings.get("pomodoroBreakMinutes"), 5, 1, 180)),
    );

    // Furigana & Pinyin appearance
    settings.insert(
        "furiganaScale".into(),
        json!(clamp_f64(settings.get("furiganaScale"), 0.55, 0.2, 2.5)),
    );
    settings.insert(
        "furiganaYOffset".into(),
        json!(clamp_f64(
            settings.get("furiganaYOffset"),
            -2.0,
            -48.0,
            48.0
        )),
    );
    settings.insert(
        "jitenHighlightOffsetY".into(),
        json!(clamp_f64(
            settings.get("jitenHighlightOffsetY"),
            3.0,
            -48.0,
            48.0
        )),
    );
    settings.insert(
        "hideFuriganaAfterSeconds".into(),
        json!(clamp_i64(
            settings.get("hideFuriganaAfterSeconds"),
            0,
            0,
            60
        )),
    );
    settings.insert(
        "furiganaOutlineWidth".into(),
        json!(clamp_f64(
            settings.get("furiganaOutlineWidth"),
            1.5,
            0.0,
            6.0
        )),
    );
    settings.insert(
        "furiganaColor".into(),
        json!(norm_color(settings.get("furiganaColor"), "#ffffff")),
    );
    settings.insert(
        "furiganaOutlineColor".into(),
        json!(norm_color(settings.get("furiganaOutlineColor"), "#222222")),
    );
    for (key, def) in [
        ("pinyinTone1Color", "#ff5252"),
        ("pinyinTone2Color", "#ffb300"),
        ("pinyinTone3Color", "#4caf50"),
        ("pinyinTone4Color", "#42a5f5"),
        ("pinyinTone5Color", "#e0e0e0"),
    ] {
        settings.insert(key.into(), json!(norm_color(settings.get(key), def)));
    }

    // Tokenizer & Gamepad settings
    settings.insert(
        "gamepadActivationMode".into(),
        json!(norm_enum(
            settings.get("gamepadActivationMode"),
            &["modifier", "toggle"],
            "modifier"
        )),
    );
    settings.insert(
        "gamepadTokenizerBackend".into(),
        json!(norm_enum(
            settings.get("gamepadTokenizerBackend"),
            &[
                "sudachi",
                "yomitan-bridge",
                "yomitan-api",
                "jiten-api",
                "jpdb-api"
            ],
            "sudachi"
        )),
    );
    settings.insert(
        "gamepadLocalTokenizerFallbackBackend".into(),
        json!(norm_enum(
            settings.get("gamepadLocalTokenizerFallbackBackend"),
            &["sudachi"],
            "sudachi"
        )),
    );
    settings.insert(
        "gamepadSudachiDictionary".into(),
        json!(norm_enum(
            settings.get("gamepadSudachiDictionary"),
            &["small", "core", "full"],
            "core"
        )),
    );
    let yomitan_url = settings
        .get("gamepadYomitanApiUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string();
    settings.insert(
        "gamepadYomitanApiUrl".into(),
        json!(if yomitan_url.is_empty() {
            "http://127.0.0.1:19633".to_string()
        } else {
            yomitan_url
        }),
    );
    settings.insert(
        "gamepadYomitanScanLength".into(),
        json!(clamp_i64(
            settings.get("gamepadYomitanScanLength"),
            10,
            1,
            100
        )),
    );
    settings.insert(
        "gamepadServerPort".into(),
        json!(clamp_i64(
            settings.get("gamepadServerPort"),
            7276,
            1024,
            65535
        )),
    );

    // Migrate selections before profile normalization removes scene-owned keys.
    if !settings
        .get("vnGuideMode")
        .and_then(Value::as_str)
        .is_some_and(|v| matches!(v, "auto" | "always" | "hotkey"))
    {
        settings.insert("vnGuideMode".into(), json!("auto"));
    }
    if !settings
        .get("vnGuideDisplayStyle")
        .and_then(Value::as_str)
        .is_some_and(|v| matches!(v, "card" | "text"))
    {
        settings.insert("vnGuideDisplayStyle".into(), json!("card"));
    }
    initialize_guide_scenes(settings);
    normalize_profiles_container(settings, &defaults);
    *settings != before
}

fn normalize_profiles_container(settings: &mut Map<String, Value>, defaults: &Map<String, Value>) {
    let profiles_enabled = settings
        .get(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY)
        .and_then(Value::as_bool)
        == Some(true);
    settings.insert(
        OVERLAY_SETTINGS_PROFILES_ENABLED_KEY.into(),
        json!(profiles_enabled),
    );
    let active_profile = settings
        .get(OVERLAY_ACTIVE_PROFILE_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_GSM_PROFILE_NAME)
        .to_string();
    settings.insert(OVERLAY_ACTIVE_PROFILE_KEY.into(), json!(active_profile));

    let raw_profiles = settings
        .remove(OVERLAY_PROFILE_SETTINGS_KEY)
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();

    let mut normalized_profiles = Map::new();
    for (raw_name, raw_snapshot) in raw_profiles {
        let name = raw_name.trim();
        let norm_name = if name.is_empty() {
            DEFAULT_GSM_PROFILE_NAME
        } else {
            name
        };
        let mut cleaned = Map::new();
        if let Value::Object(obj) = raw_snapshot {
            for (k, v) in obj {
                if defaults.contains_key(&k)
                    && !VN_GUIDE_SCENE_SETTING_KEYS.contains(&k.as_str())
                    && !is_non_profile_setting_key(&k)
                {
                    cleaned.insert(k, v);
                }
            }
        }
        cleaned
            .entry("hideCompletedGoals".to_string())
            .or_insert_with(|| defaults["hideCompletedGoals"].clone());
        cleaned
            .entry("hideLiveStatsOnTextOverlap".to_string())
            .or_insert_with(|| defaults["hideLiveStatsOnTextOverlap"].clone());
        cleaned.insert(
            "requireGameFocusForPushToShow".into(),
            json!(norm_bool(cleaned.get("requireGameFocusForPushToShow"), true)),
        );
        normalized_profiles.insert(norm_name.to_string(), Value::Object(cleaned));
    }
    settings.insert(
        OVERLAY_PROFILE_SETTINGS_KEY.into(),
        Value::Object(normalized_profiles),
    );
}

pub fn build_profile_snapshot(settings: &Map<String, Value>) -> Map<String, Value> {
    let defaults = default_user_settings_map();
    let mut snapshot = Map::new();
    for key in defaults.keys() {
        if !VN_GUIDE_SCENE_SETTING_KEYS.contains(&key.as_str()) && !is_non_profile_setting_key(key)
        {
            if let Some(val) = settings.get(key) {
                snapshot.insert(key.clone(), val.clone());
            }
        }
    }
    snapshot
}

/// Apply incoming `gsm-overlay-config-updated` values onto `settings`, returning changed keys.
pub fn apply_gsm_owned_config_update(
    settings: &mut Map<String, Value>,
    gsm_settings_obj: &Map<String, Value>,
) -> Vec<(String, Value)> {
    let mut changed = Vec::new();
    for (key, value) in gsm_settings_obj {
        // Inbound keys may already be overlay_key (from serialize_gsm_owned_overlay) or field_name.
        let target_key = GSM_OWNED_OVERLAY_FIELD_MAP
            .iter()
            .find(|(field, ok)| *field == key.as_str() || *ok == key.as_str())
            .map(|(_, ok)| *ok)
            .unwrap_or(key.as_str());
        if settings.get(target_key) != Some(value) {
            settings.insert(target_key.to_string(), value.clone());
            changed.push((target_key.to_string(), value.clone()));
        }
    }
    changed
}

pub fn backend_profile_name(state: &Value) -> &str {
    state
        .get("currentProfileName")
        .or_else(|| state.get("currentGSMProfileName"))
        .or_else(|| state.get("activeProfileName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(DEFAULT_GSM_PROFILE_NAME)
}

pub fn overlay_profile_state(settings: &Map<String, Value>, backend: &Value) -> Value {
    let current = backend_profile_name(backend);
    let active = settings
        .get(OVERLAY_ACTIVE_PROFILE_KEY)
        .and_then(Value::as_str)
        .unwrap_or(current);
    let snapshots = settings
        .get(OVERLAY_PROFILE_SETTINGS_KEY)
        .and_then(Value::as_object);
    let profiles: Vec<Value> = backend["profiles"].as_array().into_iter().flatten().map(|profile| {
        let name = profile["name"].as_str().unwrap_or("");
        json!({"name":name,"scenes":profile["scenes"],"active":name==active,
            "current":name==current,"hasOverlaySettings":snapshots.is_some_and(|p| p.contains_key(name))})
    }).collect();
    json!({"enabled":settings.get(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY)==Some(&json!(true)),
        "activeProfileName":active,"currentGSMProfileName":current,"profiles":profiles})
}

pub fn apply_backend_profile_state(settings: &mut Map<String, Value>, backend: &Value) -> bool {
    reconcile_active_profile(settings, backend_profile_name(backend))
}

pub fn restore_active_profile(settings: &mut Map<String, Value>) {
    let active = settings
        .get(OVERLAY_ACTIVE_PROFILE_KEY)
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_GSM_PROFILE_NAME)
        .to_owned();
    let snapshot = settings
        .get(OVERLAY_PROFILE_SETTINGS_KEY)
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(&active))
        .and_then(Value::as_object)
        .cloned();
    if let Some(snapshot) = snapshot {
        for (key, value) in snapshot {
            if !is_non_profile_setting_key(&key)
                && !VN_GUIDE_SCENE_SETTING_KEYS.contains(&key.as_str())
            {
                settings.insert(key, value);
            }
        }
    } else {
        let snapshot = build_profile_snapshot(settings);
        settings
            .entry(OVERLAY_PROFILE_SETTINGS_KEY)
            .or_insert_with(|| json!({}))[active] = Value::Object(snapshot);
    }
}

/// Switch active overlay profile when `overlaySettingsProfilesEnabled` is enabled.
/// Returns `true` if settings values changed.
pub fn reconcile_active_profile(settings: &mut Map<String, Value>, target_profile: &str) -> bool {
    let norm_target = target_profile.trim();
    let target = if norm_target.is_empty() {
        DEFAULT_GSM_PROFILE_NAME
    } else {
        norm_target
    };
    let current = settings
        .get(OVERLAY_ACTIVE_PROFILE_KEY)
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_GSM_PROFILE_NAME)
        .to_string();
    if current == target {
        return false;
    }

    let enabled = settings
        .get(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY)
        .and_then(Value::as_bool)
        == Some(true);
    if !enabled {
        settings.insert(OVERLAY_ACTIVE_PROFILE_KEY.into(), json!(target));
        return true;
    }

    // Save outgoing snapshot
    let outgoing = build_profile_snapshot(settings);
    let mut profiles = settings
        .get(OVERLAY_PROFILE_SETTINGS_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    profiles.insert(current, Value::Object(outgoing));

    // Seed target if missing, otherwise overlay its scoped keys
    if let Some(Value::Object(incoming)) = profiles.get(target).cloned() {
        for (k, v) in incoming {
            if !VN_GUIDE_SCENE_SETTING_KEYS.contains(&k.as_str()) && !is_non_profile_setting_key(&k)
            {
                settings.insert(k, v);
            }
        }
    } else {
        profiles.insert(
            target.to_string(),
            Value::Object(build_profile_snapshot(settings)),
        );
    }

    settings.insert(OVERLAY_ACTIVE_PROFILE_KEY.into(), json!(target));
    settings.insert(OVERLAY_PROFILE_SETTINGS_KEY.into(), Value::Object(profiles));
    true
}

/// All global hotkey setting keys checked for conflicts.
pub const GLOBAL_HOTKEY_KEYS: &[(&str, &str)] = &[
    ("toggleFuriganaHotkey", "Alt+F"),
    ("translateHotkey", "Alt+T"),
    ("liveStatsToggleHotkey", "Alt+Shift+L"),
    ("toggleWindowHotkey", "Alt+Shift+H"),
    ("minimizeHotkey", "Alt+Shift+J"),
    ("yomitanSettingsHotkey", "Alt+Shift+Y"),
    ("overlaySettingsHotkey", "Alt+Shift+S"),
    ("texthookerHotkey", "Alt+Shift+W"),
    ("customPageHotkey", "Alt+Shift+U"),
    ("vnGuideToggleHotkey", "Alt+Shift+G"),
    ("vnGuideNextHotkey", "Alt+Shift+Right"),
    ("vnGuideBackHotkey", "Alt+Shift+Left"),
    ("gamepadKeyboardHotkey", "Alt+G"),
];

pub fn normalize_hotkey_for_comparison(raw: &str) -> String {
    raw.split('+')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("+")
}

pub fn is_mouse_hotkey(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.contains("mouse4")
        || lower.contains("mouse5")
        || lower.contains("xbutton1")
        || lower.contains("xbutton2")
}

pub fn is_modifier_only_hotkey(raw: &str) -> bool {
    let tokens: Vec<String> = raw
        .split('+')
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return false;
    }
    tokens.iter().all(|t| {
        matches!(
            t.as_str(),
            "shift"
                | "lshift"
                | "rshift"
                | "left shift"
                | "right shift"
                | "ctrl"
                | "control"
                | "lctrl"
                | "rctrl"
                | "alt"
                | "lalt"
                | "ralt"
                | "meta"
                | "super"
                | "win"
                | "command"
                | "cmd"
                | "commandorcontrol"
        )
    })
}

/// Convert a UI hotkey string (e.g. `"Ctrl+Shift+Space"`) into a canonical `tauri-plugin-global-shortcut`
/// accelerator if it has a non-modifier, non-mouse primary key. Returns `None` for empty, mouse, or
/// modifier-only combinations (which must be handled via `gsm_overlay_server`).
pub fn to_tauri_accelerator(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || is_mouse_hotkey(trimmed) || is_modifier_only_hotkey(trimmed) {
        return None;
    }
    let mut parts = Vec::new();
    let mut has_main_key = false;
    for part in trimmed.split('+') {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        let lower = token.to_ascii_lowercase();
        let mapped = match lower.as_str() {
            "ctrl" | "control" | "lctrl" | "rctrl" => "Control".to_string(),
            "shift" | "lshift" | "rshift" => "Shift".to_string(),
            "alt" | "lalt" | "ralt" | "option" => "Alt".to_string(),
            "meta" | "super" | "win" | "cmd" | "command" => "Super".to_string(),
            "commandorcontrol" | "cmdorctrl" => "CommandOrControl".to_string(),
            "space" | " " => {
                has_main_key = true;
                "Space".to_string()
            }
            "esc" | "escape" => {
                has_main_key = true;
                "Escape".to_string()
            }
            "return" | "enter" => {
                has_main_key = true;
                "Enter".to_string()
            }
            "up" | "arrowup" => {
                has_main_key = true;
                "ArrowUp".to_string()
            }
            "down" | "arrowdown" => {
                has_main_key = true;
                "ArrowDown".to_string()
            }
            "left" | "arrowleft" => {
                has_main_key = true;
                "ArrowLeft".to_string()
            }
            "right" | "arrowright" => {
                has_main_key = true;
                "ArrowRight".to_string()
            }
            other => {
                has_main_key = true;
                if other.len() == 1 {
                    other.to_ascii_uppercase()
                } else {
                    // Preserve F1..F24, Tab, Backspace, etc.
                    let mut chars = other.chars();
                    match chars.next() {
                        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                        None => continue,
                    }
                }
            }
        };
        if !parts.contains(&mapped) {
            parts.push(mapped);
        }
    }
    if has_main_key {
        Some(parts.join("+"))
    } else {
        None
    }
}

/// Clear any global hotkey that collides with `showHotkey` or an earlier key.
pub fn resolve_hotkey_conflicts(settings: &mut Map<String, Value>) -> Vec<String> {
    let mut seen: HashMap<String, &str> = HashMap::new();
    let mut cleared = Vec::new();
    let show_hotkey = settings
        .get("showHotkey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let norm_show = normalize_hotkey_for_comparison(&show_hotkey);
    if !norm_show.is_empty() {
        seen.insert(norm_show, "showHotkey");
    }

    let mut seen_norm: HashSet<String> = seen.keys().cloned().collect();
    for (key, _) in GLOBAL_HOTKEY_KEYS {
        let cur = settings
            .get(*key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if cur.is_empty() {
            continue;
        }
        let norm = normalize_hotkey_for_comparison(&cur);
        if !seen_norm.insert(norm) {
            settings.insert((*key).into(), json!(""));
            cleared.push((*key).to_string());
        }
    }
    cleared
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_click_through_defaults_off_and_loads_saved_choices() {
        let directory = tempfile::tempdir().unwrap();
        let read_preference = || load_settings_from_disk(directory.path(), 7275)["textHoverClickThrough"].as_bool();
        assert_eq!(read_preference(), Some(false));
        for enabled in [true, false] {
            let saved = json!({"textHoverClickThrough": enabled});
            fs::write(settings_file_path(directory.path()), saved.to_string()).unwrap();
            assert_eq!(read_preference(), Some(enabled));
        }
    }

    #[test]
    fn imports_legacy_dismissals_indicators_and_controller_names_before_defaults() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("settings.json"),
            json!({
                "showTextBackground":true,"dismissedFullscreenRecommendations":["Game A"],
                "dismissedExclusiveFullscreenRecommendations":["Game B"],
                "gamepadDeviceBlacklist":[" Pad ","pad","",9],"showHotkey":""
            })
            .to_string(),
        )
        .unwrap();
        let settings = load_settings_from_disk(directory.path(), 7275);
        assert_eq!(settings["showTextIndicators"], true);
        assert_eq!(settings["fadeTextIndicators"], true);
        assert_eq!(settings["dismissedManualModeGames"], json!(["Game A"]));
        assert_eq!(settings["dismissedFullscreenModeGames"], json!(["Game B"]));
        assert_eq!(settings["gamepadDeviceBlacklist"], json!(["Pad"]));
        assert_eq!(settings["showHotkey"], "");
        save_settings_atomic(directory.path(), &settings).unwrap();
        assert_eq!(load_settings_from_disk(directory.path(), 7275), settings);
    }
    use std::time::Instant;

    #[test]
    fn regression_vn_guide_profile_scope() {
        let mut settings = default_user_settings_map();
        settings.insert("vnGuideEnabled".into(), json!(true));
        settings.insert("vnGuideMode".into(), json!("always"));
        settings.insert("vnGuideCatalogueSource".into(), json!("C:\\guides"));
        settings.insert("vnGuideSceneSettings".into(), json!({"scenes":{}}));
        let profile = build_profile_snapshot(&settings);
        assert!(!profile.contains_key("vnGuideEnabled"));
        assert!(!profile.contains_key("vnGuideUrl"));
        assert!(!profile.contains_key("vnGuideSceneSettings"));
        assert!(!profile.contains_key("vnGuideCatalogueSource"));
        assert_eq!(profile["vnGuideMode"], "always");
    }

    #[test]
    fn guide_scenes_restore_existing_selections_and_survive_profiles_and_restarts() {
        let mut settings = default_user_settings_map();
        settings.insert(GUIDE_SCENE_SETTINGS_KEY.into(), json!({"scenes":{
            "Muv-Luv EXTRA":{"vnGuideEnabled":true,"vnGuideUrl":"fork/muv-luv-extra/","vnGuideRoute":"sumika"},
            "Other game":{"vnGuideEnabled":false,"vnGuideUrl":"","vnGuideRoute":""}
        },"legacyProfiles":{}}));
        normalize_user_settings(&mut settings, 7275);
        select_guide_scene(&mut settings, "Muv-Luv EXTRA", "Default");
        assert_eq!(settings["vnGuideUrl"], "fork/muv-luv-extra/");
        settings.insert(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY.into(), json!(true));
        reconcile_active_profile(&mut settings, "Other profile");
        assert_eq!(settings["vnGuideEnabled"], true);
        assert_eq!(settings["vnGuideRoute"], "sumika");
        settings.insert("vnGuideRoute".into(), json!("meiya"));
        record_guide_scene(&mut settings, Some("Muv-Luv EXTRA"));
        select_guide_scene(&mut settings, "Other game", "Other profile");
        assert_eq!(settings["vnGuideEnabled"], false);
        let mut restarted: Map<String, Value> =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        normalize_user_settings(&mut restarted, 7275);
        select_guide_scene(&mut restarted, "Muv-Luv EXTRA", "Default");
        assert_eq!(restarted["vnGuideRoute"], "meiya");
        select_guide_scene(&mut restarted, "New game", "Default");
        assert_eq!(restarted["vnGuideUrl"], "");
    }

    #[test]
    fn guide_scene_migration_and_selection_before_capture_are_consumed_once() {
        let mut settings = default_user_settings_map();
        settings.insert("vnGuideUrl".into(), json!("old-guide"));
        settings.insert("vnGuideEnabled".into(), json!(true));
        normalize_user_settings(&mut settings, 7275);
        select_guide_scene(&mut settings, "First", "Default");
        assert_eq!(settings["vnGuideUrl"], "old-guide");
        select_guide_scene(&mut settings, "Second", "Default");
        assert_eq!(settings["vnGuideEnabled"], false);
        settings.insert("vnGuideUrl".into(), json!("chosen-before-OBS"));
        record_guide_scene(&mut settings, None);
        normalize_user_settings(&mut settings, 7275);
        select_guide_scene(&mut settings, "Second", "Default");
        assert_eq!(settings["vnGuideUrl"], "chosen-before-OBS");
        select_guide_scene(&mut settings, "Third", "Default");
        assert_eq!(settings["vnGuideUrl"], "");
    }

    #[test]
    fn enforces_single_port_urls_and_normalizes_bounds() {
        let mut map = default_user_settings_map();
        map.insert("fontSize".into(), json!(999));
        map.insert("pomodoroWorkMinutes".into(), json!(-5));
        map.insert("furiganaScale".into(), json!(8.0));
        map.insert("localVocabularyEnabled".into(), json!(true));
        assert!(normalize_user_settings(&mut map, 9001));
        assert_eq!(map["fontSize"], json!(200));
        assert_eq!(map["pomodoroWorkMinutes"], json!(1));
        assert_eq!(map["furiganaScale"], json!(2.5));
        assert_eq!(map["localVocabularyEnabled"], json!(false));
        assert_eq!(map["weburl1"], json!("ws://localhost:9001/ws/texthooker"));
        assert_eq!(map["weburl2"], json!("ws://localhost:9001/ws/overlay"));
        assert_eq!(
            map["texthookerUrl"],
            json!("http://localhost:9001/texthooker")
        );
    }

    #[test]
    fn hotkey_translation_and_conflict_resolution() {
        assert_eq!(
            to_tauri_accelerator("Shift + Space").as_deref(),
            Some("Shift+Space")
        );
        assert_eq!(to_tauri_accelerator("Mouse4"), None);
        assert_eq!(to_tauri_accelerator("Ctrl+Shift"), None);

        let mut map = default_user_settings_map();
        map.insert("showHotkey".into(), json!("Alt+Shift+H"));
        let cleared = resolve_hotkey_conflicts(&mut map);
        assert_eq!(cleared, vec!["toggleWindowHotkey".to_string()]);
        assert_eq!(map["toggleWindowHotkey"], json!(""));
    }

    #[test]
    fn profiles_isolate_and_reconcile() {
        let mut map = default_user_settings_map();
        map.insert(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY.into(), json!(true));
        map.insert("fontSize".into(), json!(56));
        assert!(reconcile_active_profile(&mut map, "GameB"));
        assert_eq!(map[OVERLAY_ACTIVE_PROFILE_KEY], json!("GameB"));
        map.insert("fontSize".into(), json!(30));
        assert!(reconcile_active_profile(&mut map, DEFAULT_GSM_PROFILE_NAME));
        assert_eq!(map["fontSize"], json!(56));
        assert!(reconcile_active_profile(&mut map, "GameB"));
        assert_eq!(map["fontSize"], json!(30));
    }

    #[test]
    fn backend_profile_state_restores_saved_settings_and_exposes_ui_state() {
        let mut settings = default_user_settings_map();
        settings.insert(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY.into(), json!(true));
        settings.insert(
            OVERLAY_PROFILE_SETTINGS_KEY.into(),
            json!({"VN":{"fontSize":72}}),
        );
        let backend = json!({"type":"gsm-profile-state-updated","currentProfileName":"VN",
            "profiles":[{"name":"Default","scenes":[]},{"name":"VN","scenes":["Game"]}]});
        assert!(apply_backend_profile_state(&mut settings, &backend));
        assert_eq!(settings["fontSize"], 72);
        let ui = overlay_profile_state(&settings, &backend);
        assert_eq!(ui["enabled"], true);
        assert_eq!(ui["activeProfileName"], "VN");
        assert_eq!(ui["currentGSMProfileName"], "VN");
        assert_eq!(ui["profiles"][1]["hasOverlaySettings"], true);
        settings.insert("fontSize".into(), json!(61));
        assert!(!apply_backend_profile_state(&mut settings, &backend));
        assert_eq!(settings["fontSize"], 61);
    }

    #[test]
    fn enabling_profiles_restores_current_profile_without_overwriting_it() {
        let mut settings = default_user_settings_map();
        settings.insert(OVERLAY_ACTIVE_PROFILE_KEY.into(), json!("VN"));
        settings.insert(
            OVERLAY_PROFILE_SETTINGS_KEY.into(),
            json!({"VN":{"fontSize":72}}),
        );
        let backend = json!({"currentProfileName":"VN","profiles":[{"name":"VN","scenes":[]}]});
        assert!(!apply_backend_profile_state(&mut settings, &backend));
        settings.insert(OVERLAY_SETTINGS_PROFILES_ENABLED_KEY.into(), json!(true));
        restore_active_profile(&mut settings);
        assert_eq!(settings["fontSize"], 72);
    }

    #[test]
    fn benchmark_normalize_overlay_settings_100x() {
        let base = default_user_settings_map();
        let started = Instant::now();
        for _ in 0..100 {
            let mut m = base.clone();
            normalize_user_settings(&mut m, 7275);
        }
        let elapsed = started.elapsed();
        println!(
            "[bench] normalize_overlay_settings_100x total_ms={:.3} us_per_call={:.2}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / 100.0
        );
    }
}
