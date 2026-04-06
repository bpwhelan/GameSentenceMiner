const { app, BrowserWindow, session, screen, globalShortcut, dialog, Tray, Menu, nativeImage, protocol } = require('electron');
const { ipcMain } = require("electron");
const fs = require("fs");
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const bg = require('./background');
const BackendConnector = require('./backend_connector');
const { URL } = require('url');

// FIX: Register chrome-extension protocol as privileged to allow image loading and CORS in renderer
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'chrome-extension',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
]);

let dataPath = process.env.APPDATA
  ? path.join(process.env.APPDATA, "gsm_overlay") // Windows
  : path.join(os.homedir(), '.config', "gsm_overlay"); // macOS/Linux

fs.mkdirSync(dataPath, { recursive: true });
app.setPath('userData', dataPath);

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const extensionsRoot = path.join(app.getPath('userData'), 'extensions');
const extensionVersionsPath = path.join(extensionsRoot, 'versions.json');
const DEFAULT_GSM_SINGLE_PORT = 7275;
const DEFAULT_ENFORCED_PLAINTEXT_WS_URL = `ws://127.0.0.1:${DEFAULT_GSM_SINGLE_PORT}/ws/plaintext`;
const DEFAULT_ENFORCED_OVERLAY_WS_URL = `ws://127.0.0.1:${DEFAULT_GSM_SINGLE_PORT}/ws/overlay`;
const DEFAULT_TEXTHOOKER_URL = `http://127.0.0.1:${DEFAULT_GSM_SINGLE_PORT}/texthooker`;
const DEFAULT_YOMITAN_API_URL = "http://127.0.0.1:19633";
const VALID_GAMEPAD_TOKENIZER_BACKENDS = new Set(["mecab", "sudachi", "yomitan-bridge", "yomitan-api", "jiten-api", "jpdb-api"]);
const VALID_SUDACHI_DICTIONARIES = new Set(["small", "core", "full"]);
const GAMEPAD_SERVER_BASE_PORT = 7276;
const OVERLAY_WS_RECONNECT_DELAY_MS = 1000;
const OVERLAY_WS_COMMAND_OPEN_SETTINGS = "open-overlay-settings";
const DEFAULT_MANUAL_HOTKEY = "Shift + Space";
const DEFAULT_TEXTHOOKER_HOTKEY = "Alt+Shift+W";
const GSM_APPDATA = process.env.APPDATA
  ? path.join(process.env.APPDATA, "GameSentenceMiner") // Windows
  : path.join(os.homedir(), '.config', "GameSentenceMiner"); // macOS/Linux
const FIND_IN_PAGE_PRELOAD_PATH = path.join(__dirname, 'find-in-page-preload.js');
const TEXTHOOKER_HOTKEY_FALLBACKS = [
  DEFAULT_TEXTHOOKER_HOTKEY,
  "Alt+Shift+Q",
  "Alt+Shift+T",
];

function getGSMSettings() {
  const gsmSettingsPath = path.join(GSM_APPDATA, 'config.json');
  let gsmSettings = {};
  if (fs.existsSync(gsmSettingsPath)) {
    try {
      const data = fs.readFileSync(gsmSettingsPath, "utf-8");
      gsmSettings = JSON.parse(data);
    } catch (error) {
      console.error("Failed to load config.json:", error);
    }
  }
  return gsmSettings;
}

function getCurrentGSMProfileSettings(gsmSettings = getGSMSettings()) {
  const configs = gsmSettings && typeof gsmSettings === "object" ? gsmSettings.configs : null;
  if (!configs || typeof configs !== "object") {
    return {};
  }

  const currentProfileName = typeof gsmSettings.current_profile === "string"
    ? gsmSettings.current_profile
    : "Default";
  const directMatch = configs[currentProfileName];
  if (directMatch && typeof directMatch === "object") {
    return directMatch;
  }

  const defaultProfile = configs.Default;
  if (defaultProfile && typeof defaultProfile === "object") {
    return defaultProfile;
  }

  for (const candidate of Object.values(configs)) {
    if (candidate && typeof candidate === "object") {
      return candidate;
    }
  }

  return {};
}

function getGSMTransportBasePort(gsmSettings = getGSMSettings()) {
  const profileSettings = getCurrentGSMProfileSettings(gsmSettings);
  const generalSettings = profileSettings && typeof profileSettings.general === "object"
    ? profileSettings.general
    : {};
  const singlePort = Number.parseInt(generalSettings.single_port, 10);

  if (Number.isFinite(singlePort) && singlePort > 0 && singlePort <= 65535) {
    return singlePort;
  }

  return DEFAULT_GSM_SINGLE_PORT;
}

function getEnforcedOverlayTransportUrls(gsmSettings = getGSMSettings()) {
  const port = getGSMTransportBasePort(gsmSettings);
  return {
    weburl1: `ws://127.0.0.1:${port}/ws/plaintext`,
    weburl2: `ws://127.0.0.1:${port}/ws/overlay`,
    texthookerUrl: `http://127.0.0.1:${port}/texthooker`,
  };
}

let manualHotkeyPressed = false;
let manualModeToggleState = false;
let lastManualActivity = Date.now();
let activityTimer = null;
let isDev = false;
let yomitanExt;
let jitenReaderExt;
const DEFAULT_USER_SETTINGS = Object.freeze({
  "fontSize": 42,
  "weburl1": DEFAULT_ENFORCED_PLAINTEXT_WS_URL,
  "weburl2": DEFAULT_ENFORCED_OVERLAY_WS_URL,
  "hideOnStartup": true,
  "openSettingsOnStartup": true,
  "focusOverlayOnYomitanLookup": false,
  "manualMode": false,
  "manualModeType": "hold", // "hold" or "toggle"
  "manualModeRescanOnShow": false,
  "showHotkey": DEFAULT_MANUAL_HOTKEY,
  "toggleFuriganaHotkey": "Alt+F",
  "toggleWindowHotkey": "Alt+Shift+H",
  "minimizeHotkey": "Alt+Shift+J",
  "yomitanSettingsHotkey": "Alt+Shift+Y",
  "overlaySettingsHotkey": "Alt+Shift+S",
  "translateHotkey": "Alt+T",
  "autoRequestTranslation": false,
  "showRecycledIndicator": false,
  "pinned": false,
  "showReadyIndicator": true,
  "showTextIndicators": true,
  "fadeTextIndicators": false,
  "showTextBackground": false, // Legacy key; migrated to showTextIndicators/fadeTextIndicators.
  "afkTimer": 5, // in minutes
  "showFurigana": false,
  "hideFuriganaOnStartup": false,
  "furiganaScale": 0.55,
  "furiganaYOffset": -2,
  "furiganaColor": "#ffffff",
  "furiganaFontFamily": "\"Yu Gothic UI\", \"Hiragino Sans\", sans-serif",
  "furiganaFontWeight": "600",
  "furiganaOutlineColor": "#222222",
  "furiganaOutlineWidth": 1.5,
  "hideYomitanAfterMine": false,
  "offsetX": 0,
  "offsetY": 0,
  "mainBoxStartupWarningAcknowledged": false,
  "dismissedFullscreenRecommendations": [], // Games for which fullscreen recommendation was dismissed
  "texthookerHotkey": DEFAULT_TEXTHOOKER_HOTKEY,
  "texthookerUrl": DEFAULT_TEXTHOOKER_URL,
  "enableJitenReader": true,
  // Gamepad navigation settings
  // TODO CHANGE THIS TO FALSE BEFORE RELEASE
  "gamepadEnabled": true,
  "gamepadActivationMode": "modifier", // "modifier" or "toggle"
  "gamepadModifierButton": 4, // LB
  "gamepadToggleButton": 8, // Back/Select
  "gamepadConfirmButton": 0, // A
  "gamepadCancelButton": 1, // B
  "gamepadForwardEnterButton": -1, // Disabled by default; forwards Enter to target game window
  "gamepadManualOverlayScanButton": -1, // Disabled by default; triggers manual overlay scan
  "gamepadNextEntryButton": 7, // RT trigger - navigate to next Yomitan entry
  "gamepadPrevEntryButton": 6, // LT trigger - navigate to previous Yomitan entry
  "gamepadAutoConfirmSelection": true,
  "gamepadRepeatDelay": 400,
  "gamepadRepeatRate": 150,
  "gamepadServerPort": GAMEPAD_SERVER_BASE_PORT, // Port for gamepad server
  "gamepadKeyboardHotkey": "Alt+G", // Keyboard hotkey to toggle gamepad mode
  "gamepadKeyboardEnabled": true, // Enable keyboard hotkey activation
  "gamepadControllerEnabled": true, // Enable controller button activation
  "gamepadTokenMode": true, // Default to character mode (false) or token mode (true)
  "gamepadTokenizerBackend": "sudachi", // "mecab", "sudachi", "yomitan-bridge", "yomitan-api", "jiten-api", or "jpdb-api" for tokenization/furigana
  "gamepadSudachiDictionary": "core", // "small", "core", or "full" for Sudachi auto-download
  "gamepadYomitanApiUrl": DEFAULT_YOMITAN_API_URL, // Base URL for Yomitan API
  "gamepadYomitanScanLength": 10, // scanLength used for Yomitan /tokenize
  "gamepadJitenApiKey": "", // User-provided API key for Jiten/api/reader/parse
  "gamepadJpdbApiKey": "", // User-provided bearer token for JPDB /api/v1/parse
});

let userSettings = { ...DEFAULT_USER_SETTINGS };

function enforceOverlayWebSocketUrls(settings) {
  const enforcedUrls = getEnforcedOverlayTransportUrls();
  let changed = false;
  if (settings.weburl1 !== enforcedUrls.weburl1) {
    settings.weburl1 = enforcedUrls.weburl1;
    changed = true;
  }
  if (settings.weburl2 !== enforcedUrls.weburl2) {
    settings.weburl2 = enforcedUrls.weburl2;
    changed = true;
  }
  return changed;
}

function enforceTexthookerUrl(settings) {
  const { texthookerUrl } = getEnforcedOverlayTransportUrls();
  if (settings.texthookerUrl !== texthookerUrl) {
    settings.texthookerUrl = texthookerUrl;
    return true;
  }
  return false;
}

function refreshOverlayTransportSettingsFromGSM(reason = "unknown") {
  const enforcedTransportUrls = getEnforcedOverlayTransportUrls();
  const updates = {};

  if (userSettings.weburl1 !== enforcedTransportUrls.weburl1) {
    userSettings.weburl1 = enforcedTransportUrls.weburl1;
    updates.weburl1 = enforcedTransportUrls.weburl1;
  }
  if (userSettings.weburl2 !== enforcedTransportUrls.weburl2) {
    userSettings.weburl2 = enforcedTransportUrls.weburl2;
    updates.weburl2 = enforcedTransportUrls.weburl2;
  }
  if (userSettings.texthookerUrl !== enforcedTransportUrls.texthookerUrl) {
    userSettings.texthookerUrl = enforcedTransportUrls.texthookerUrl;
    updates.texthookerUrl = enforcedTransportUrls.texthookerUrl;
  }

  const changedKeys = Object.keys(updates);
  if (changedKeys.length === 0) {
    return false;
  }

  console.log(`[OverlayTransport] Refreshed enforced URLs from GSM settings (${reason})`, updates);

  if (updates.weburl1) {
    connectOverlayWebSocket("ws1", updates.weburl1);
  }
  if (updates.weburl2) {
    connectOverlayWebSocket("ws2", updates.weburl2);
    if (backend) {
      backend.connect(updates.weburl2);
    }
  }
  if (updates.texthookerUrl && texthookerWindow && !texthookerWindow.isDestroyed()) {
    waitForTexthookerUrl(texthookerWindow, updates.texthookerUrl);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("settings-updated", updates);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("settings-updated", updates);
  }

  saveSettings();
  return true;
}

function normalizeHotkeyForComparison(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function hotkeysConflict(a, b) {
  const normalizedA = normalizeHotkeyForComparison(a);
  const normalizedB = normalizeHotkeyForComparison(b);
  return !!normalizedA && normalizedA === normalizedB;
}

function pickNonConflictingTexthookerHotkey(manualHotkey, preferredHotkey) {
  const manual = String(manualHotkey || "").trim();
  const candidates = [];
  if (preferredHotkey) {
    candidates.push(preferredHotkey);
  }
  for (const candidate of TEXTHOOKER_HOTKEY_FALLBACKS) {
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    const normalizedCandidate = String(candidate || "").trim();
    if (!normalizedCandidate) continue;
    if (!hotkeysConflict(normalizedCandidate, manual)) {
      return normalizedCandidate;
    }
  }

  return "";
}

function ensureManualAndTexthookerHotkeysDistinct(source = "unknown") {
  const manualHotkey = String(userSettings.showHotkey || DEFAULT_MANUAL_HOTKEY).trim() || DEFAULT_MANUAL_HOTKEY;
  const currentTexthookerHotkey = String(userSettings.texthookerHotkey || DEFAULT_TEXTHOOKER_HOTKEY).trim() || DEFAULT_TEXTHOOKER_HOTKEY;

  userSettings.showHotkey = manualHotkey;
  userSettings.texthookerHotkey = currentTexthookerHotkey;

  if (!hotkeysConflict(manualHotkey, currentTexthookerHotkey)) {
    return false;
  }

  const replacementHotkey = pickNonConflictingTexthookerHotkey(manualHotkey, DEFAULT_TEXTHOOKER_HOTKEY);
  if (!replacementHotkey) {
    console.error(
      `[Hotkeys] Could not resolve conflict between showHotkey (${manualHotkey}) and texthookerHotkey (${currentTexthookerHotkey}) [source=${source}]`
    );
    return false;
  }

  userSettings.texthookerHotkey = replacementHotkey;
  console.warn(
    `[Hotkeys] Conflict detected for showHotkey (${manualHotkey}) and texthookerHotkey (${currentTexthookerHotkey}). ` +
    `Reassigned texthookerHotkey to ${replacementHotkey} [source=${source}]`
  );

  return true;
}

function normalizeGamepadTokenizerBackend(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (VALID_GAMEPAD_TOKENIZER_BACKENDS.has(normalized)) {
    return normalized;
  }
  return "mecab";
}

function isServerBackedGamepadTokenizerBackend(value) {
  const normalized = normalizeGamepadTokenizerBackend(value);
  return normalized === "mecab" || normalized === "sudachi";
}

function normalizeGamepadYomitanApiUrl(value) {
  const raw = String(value || "").trim();
  const fallback = DEFAULT_YOMITAN_API_URL;
  if (!raw) return fallback;
  return raw.replace(/\/+$/, "") || fallback;
}

function normalizeGamepadSudachiDictionary(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (VALID_SUDACHI_DICTIONARIES.has(normalized)) {
    return normalized;
  }
  return "core";
}

function normalizeGamepadYomitanScanLength(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return 10;
  }
  return Math.max(1, Math.min(100, numeric));
}

function normalizeGamepadJitenApiKey(value) {
  return String(value || "").trim();
}

function normalizeGamepadJpdbApiKey(value) {
  return String(value || "").trim();
}

function normalizeFuriganaScale(value) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) {
    return 0.55;
  }
  return Math.max(0.2, Math.min(2.5, numeric));
}

function normalizeFuriganaYOffset(value) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) {
    return -2;
  }
  return Math.max(-48, Math.min(48, numeric));
}

function normalizeFuriganaOutlineWidth(value) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) {
    return 1.5;
  }
  return Math.max(0, Math.min(6, numeric));
}

function normalizeFuriganaColor(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeFuriganaFontFamily(value) {
  const normalized = String(value || "").trim();
  return normalized || "\"Yu Gothic UI\", \"Hiragino Sans\", sans-serif";
}

function normalizeFuriganaFontWeight(value) {
  const normalized = String(value || "").trim();
  return normalized || "600";
}

function normalizeFuriganaSettings(settings) {
  let changed = false;

  const normalizedScale = normalizeFuriganaScale(settings.furiganaScale);
  if (settings.furiganaScale !== normalizedScale) {
    settings.furiganaScale = normalizedScale;
    changed = true;
  }

  const normalizedYOffset = normalizeFuriganaYOffset(settings.furiganaYOffset);
  if (settings.furiganaYOffset !== normalizedYOffset) {
    settings.furiganaYOffset = normalizedYOffset;
    changed = true;
  }

  const normalizedColor = normalizeFuriganaColor(settings.furiganaColor, "#ffffff");
  if (settings.furiganaColor !== normalizedColor) {
    settings.furiganaColor = normalizedColor;
    changed = true;
  }

  const normalizedFontFamily = normalizeFuriganaFontFamily(settings.furiganaFontFamily);
  if (settings.furiganaFontFamily !== normalizedFontFamily) {
    settings.furiganaFontFamily = normalizedFontFamily;
    changed = true;
  }

  const normalizedFontWeight = normalizeFuriganaFontWeight(settings.furiganaFontWeight);
  if (settings.furiganaFontWeight !== normalizedFontWeight) {
    settings.furiganaFontWeight = normalizedFontWeight;
    changed = true;
  }

  const normalizedOutlineColor = normalizeFuriganaColor(settings.furiganaOutlineColor, "#222222");
  if (settings.furiganaOutlineColor !== normalizedOutlineColor) {
    settings.furiganaOutlineColor = normalizedOutlineColor;
    changed = true;
  }

  const normalizedOutlineWidth = normalizeFuriganaOutlineWidth(settings.furiganaOutlineWidth);
  if (settings.furiganaOutlineWidth !== normalizedOutlineWidth) {
    settings.furiganaOutlineWidth = normalizedOutlineWidth;
    changed = true;
  }

  return changed;
}

function normalizeGamepadTokenizerSettings(settings) {
  let changed = false;

  const normalizedBackend = normalizeGamepadTokenizerBackend(settings.gamepadTokenizerBackend);
  if (settings.gamepadTokenizerBackend !== normalizedBackend) {
    settings.gamepadTokenizerBackend = normalizedBackend;
    changed = true;
  }

  const normalizedYomitanApiUrl = normalizeGamepadYomitanApiUrl(settings.gamepadYomitanApiUrl);
  if (settings.gamepadYomitanApiUrl !== normalizedYomitanApiUrl) {
    settings.gamepadYomitanApiUrl = normalizedYomitanApiUrl;
    changed = true;
  }

  const normalizedSudachiDictionary = normalizeGamepadSudachiDictionary(settings.gamepadSudachiDictionary);
  if (settings.gamepadSudachiDictionary !== normalizedSudachiDictionary) {
    settings.gamepadSudachiDictionary = normalizedSudachiDictionary;
    changed = true;
  }

  const normalizedScanLength = normalizeGamepadYomitanScanLength(settings.gamepadYomitanScanLength);
  if (settings.gamepadYomitanScanLength !== normalizedScanLength) {
    settings.gamepadYomitanScanLength = normalizedScanLength;
    changed = true;
  }

  const normalizedJitenApiKey = normalizeGamepadJitenApiKey(settings.gamepadJitenApiKey);
  if (settings.gamepadJitenApiKey !== normalizedJitenApiKey) {
    settings.gamepadJitenApiKey = normalizedJitenApiKey;
    changed = true;
  }

  const normalizedJpdbApiKey = normalizeGamepadJpdbApiKey(settings.gamepadJpdbApiKey);
  if (settings.gamepadJpdbApiKey !== normalizedJpdbApiKey) {
    settings.gamepadJpdbApiKey = normalizedJpdbApiKey;
    changed = true;
  }

  return changed;
}

let isTexthookerMode = false;
let manualIn;
let resizeMode = false;
let yomitanShown = false;
let gamepadNavigationActive = false; // True while renderer gamepad navigation keeps overlay focused
let mainWindow = null;
let afkHidden = false; // true when AFK timer hid the overlay
let websocketStates = {
  "ws1": false,
  "ws2": false
};

let lastWebsocketData = null;
let currentMagpieActive = false; // Track magpie state from websocket
let translationRequested = false; // Track if translation has been requested for current text
let yomitanRecoveryVersion = 0; // Cancels stale async recovery attempts when popup state flips quickly
let lastFocusRestoreRequestAt = 0;
let lastYomitanEventAt = 0;
let yomitanForegroundActive = false;

const FOCUS_RESTORE_THROTTLE_MS = 150;
const YOMITAN_STATE_STALE_TIMEOUT_MS = 12000;
const FIND_IN_PAGE_COMMAND_CHANNEL = 'gsm-find-in-page:command';
const FIND_IN_PAGE_RESULT_CHANNEL = 'gsm-find-in-page:result';
const FIND_IN_PAGE_SHORTCUT_CHANNEL = 'gsm-find-in-page:shortcut';

let yomitanSettingsWindow = null;
let jitenReaderSettingsWindow = null;
let settingsWindow = null;
let offsetHelperWindow = null;
let texthookerWindow = null;
let texthookerLoadToken = 0;
let tray = null;
let platformOverride = null;
let backend = null;
let gamepadServerProcess = null;
let gamepadServerStarting = false;
let gamepadServerStartPromise = null;
let gamepadServerStopPromise = null;
let gamepadServerLifecycleVersion = 0;
let registeredGamepadKeyboardHotkey = null;
let gamepadInputTestActive = false;
const findInPageStateByWebContentsId = new Map();
const overlayWebSockets = {
  ws1: { socket: null, url: null, reconnectTimer: null },
  ws2: { socket: null, url: null, reconnectTimer: null },
};

function publishOverlaySocketState(type, isOpen) {
  websocketStates[type] = !!isOpen;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("overlay-websocket-state", { type, open: !!isOpen });
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(isOpen ? "websocket-opened" : "websocket-closed", type);
  }
}

function getFindInPageState(contents) {
  const webContentsId = contents.id;
  let state = findInPageStateByWebContentsId.get(webContentsId);
  if (!state) {
    state = {
      requestId: null,
      lastText: '',
      matchCase: false,
      visible: false,
    };
    findInPageStateByWebContentsId.set(webContentsId, state);
  }
  return state;
}

function clearFindInPage(contents, action = 'clearSelection') {
  const state = getFindInPageState(contents);
  try {
    contents.stopFindInPage(action);
  } catch (error) {
    console.warn('[FindInPage] Failed to stop find request:', error);
  }
  state.requestId = null;
  contents.send(FIND_IN_PAGE_RESULT_CHANNEL, {
    requestId: 0,
    activeMatchOrdinal: 0,
    matches: 0,
    finalUpdate: true,
    cleared: true,
  });
}

function performFindInPage(contents, payload = {}) {
  const state = getFindInPageState(contents);
  const text = String(payload.text || '').trim();
  if (!text) {
    state.lastText = '';
    state.matchCase = false;
    clearFindInPage(contents);
    return;
  }

  const forward = payload.forward !== false;
  const matchCase = !!payload.matchCase;
  const startNewSearch = (
    !!payload.startNewSearch ||
    state.lastText !== text ||
    state.matchCase !== matchCase
  );

  state.lastText = text;
  state.matchCase = matchCase;
  state.requestId = contents.findInPage(text, {
    forward,
    findNext: startNewSearch,
    matchCase,
  });
}

function handleFindInPageShortcut(browserWindow, input) {
  if (!browserWindow || browserWindow.isDestroyed()) {
    return false;
  }

  const { webContents } = browserWindow;
  const state = getFindInPageState(webContents);
  const key = String(input.key || '').toLowerCase();
  const controlOrMeta = !!(input.control || input.meta);

  if (controlOrMeta && key === 'f') {
    webContents.send(FIND_IN_PAGE_SHORTCUT_CHANNEL, {
      action: state.visible ? 'hide' : 'show',
    });
    return true;
  }

  if (key === 'escape' && state.visible) {
    webContents.send(FIND_IN_PAGE_SHORTCUT_CHANNEL, { action: 'hide' });
    return true;
  }

  if (state.lastText && (key === 'f3' || (controlOrMeta && key === 'g'))) {
    performFindInPage(webContents, {
      text: state.lastText,
      matchCase: state.matchCase,
      forward: !input.shift,
      startNewSearch: false,
    });
    return true;
  }

  return false;
}

function enableFindInPage(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) {
    return;
  }

  const { webContents } = browserWindow;
  const webContentsId = webContents.id;
  getFindInPageState(webContents);

  webContents.on('found-in-page', (_event, result) => {
    const state = getFindInPageState(webContents);
    if (state.requestId === null || result.requestId !== state.requestId) {
      return;
    }
    webContents.send(FIND_IN_PAGE_RESULT_CHANNEL, result);
  });

  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return;
    }
    if (handleFindInPageShortcut(browserWindow, input)) {
      event.preventDefault();
    }
  });

  browserWindow.on('closed', () => {
    findInPageStateByWebContentsId.delete(webContentsId);
  });
}

function publishOverlaySocketData(type, data) {
  lastWebsocketData = data;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("overlay-websocket-data", { type, data });
  }
  sendOffsetHelperData();
}

function handleOverlayWebSocketControlMessage(type, data) {
  if (type !== "ws2" || data === "True" || data === "False") {
    return false;
  }

  let message;
  try {
    message = JSON.parse(data);
  } catch (_error) {
    return false;
  }

  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === OVERLAY_WS_COMMAND_OPEN_SETTINGS) {
    console.log("[OverlayWS] Opening overlay settings from backend request");
    openSettings();
    return true;
  }

  return false;
}

function scheduleOverlayWebSocketReconnect(type) {
  const state = overlayWebSockets[type];
  if (!state || !state.url || state.reconnectTimer) {
    return;
  }

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectOverlayWebSocket(type, state.url);
  }, OVERLAY_WS_RECONNECT_DELAY_MS);
}

function closeOverlayWebSocket(type, options = {}) {
  const state = overlayWebSockets[type];
  if (!state) {
    return;
  }

  const clearUrl = !!options.clearUrl;
  const allowReconnect = !!options.allowReconnect;

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    try {
      socket.removeAllListeners();
      socket.close();
    } catch (e) {
      console.warn(`[OverlayWS] Failed to close ${type} socket:`, e);
    }
  }

  publishOverlaySocketState(type, false);
  if (clearUrl) {
    state.url = null;
  } else if (allowReconnect) {
    scheduleOverlayWebSocketReconnect(type);
  }
}

function connectOverlayWebSocket(type, url) {
  const state = overlayWebSockets[type];
  if (!state) {
    return;
  }

  let normalizedUrl = null;
  try {
    normalizedUrl = new URL(url).toString();
  } catch (e) {
    console.warn(`[OverlayWS] Invalid URL for ${type}:`, url);
    closeOverlayWebSocket(type, { clearUrl: true, allowReconnect: false });
    return;
  }

  if (
    state.url === normalizedUrl &&
    state.socket &&
    (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  closeOverlayWebSocket(type, { clearUrl: false, allowReconnect: false });
  state.url = normalizedUrl;

  console.log(`[OverlayWS] Connecting ${type} -> ${normalizedUrl}`);
  const socket = new WebSocket(normalizedUrl);
  state.socket = socket;

  socket.on("open", () => {
    if (state.socket !== socket) return;
    console.log(`[OverlayWS] Connected ${type}`);
    publishOverlaySocketState(type, true);
  });

  socket.on("message", (payload) => {
    if (state.socket !== socket) return;
    const data = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
    if (handleOverlayWebSocketControlMessage(type, data)) {
      return;
    }
    publishOverlaySocketData(type, data);
  });

  socket.on("close", (code, reason) => {
    if (state.socket !== socket) return;
    state.socket = null;
    publishOverlaySocketState(type, false);
    const reasonText = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
    console.log(`[OverlayWS] Closed ${type} (code=${code}${reasonText ? `, reason=${reasonText}` : ""})`);
    scheduleOverlayWebSocketReconnect(type);
  });

  socket.on("error", (err) => {
    if (state.socket !== socket) return;
    console.error(`[OverlayWS] Error on ${type}:`, err.message);
  });
}

function startOverlayWebSockets() {
  connectOverlayWebSocket("ws1", userSettings.weburl1);
  connectOverlayWebSocket("ws2", userSettings.weburl2);
}

function stopOverlayWebSockets() {
  closeOverlayWebSocket("ws1", { clearUrl: true, allowReconnect: false });
  closeOverlayWebSocket("ws2", { clearUrl: true, allowReconnect: false });
}

function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", () => {
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, host);
  });
}

async function findAvailablePort(startPort = GAMEPAD_SERVER_BASE_PORT) {
  for (let port = startPort; port <= 65535; port++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting at ${startPort}`);
}

function getGamepadServerExecutableName() {
  return isWindows() ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
}

function getPackagedGamepadServerCandidates() {
  const executableName = getGamepadServerExecutableName();
  return [
    path.join(process.resourcesPath, 'bin', process.platform, executableName),
    path.join(process.resourcesPath, 'bin', executableName),
    path.join(process.resourcesPath, executableName),
  ];
}

function getDevGamepadServerCandidates() {
  const executableName = getGamepadServerExecutableName();
  return [
    path.join(__dirname, 'input_server', 'target', 'debug', 'deps', executableName),
    path.join(__dirname, 'input_server', 'target', 'debug', executableName),
    path.join(__dirname, 'input_server', 'target', 'release', executableName),
    path.join(__dirname, 'input_server', 'target', 'release', 'deps', executableName),
    path.join(__dirname, executableName),
  ];
}

function resolveGamepadServerExecutable() {
  const candidates = isDev
    ? getDevGamepadServerCandidates()
    : getPackagedGamepadServerCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { executablePath: candidate, candidates };
    }
  }
  return { executablePath: null, candidates };
}

function shouldRunGamepadServer(settings = userSettings) {
  if (settings.gamepadEnabled) {
    return true;
  }

  return (
    settings.showFurigana === true &&
    isServerBackedGamepadTokenizerBackend(settings.gamepadTokenizerBackend)
  );
}

function syncGamepadServerState(reason = "unknown") {
  if (shouldRunGamepadServer()) {
    console.log(`[GamepadServer] Ensuring server is running (${reason})`);
    void startGamepadServer(reason);
    return;
  }

  console.log(`[GamepadServer] Stopping server because it is not needed (${reason})`);
  void stopGamepadServer(reason);
}

// Gamepad server management
async function startGamepadServer(reason = "unknown") {
  if (!shouldRunGamepadServer()) {
    console.log('[GamepadServer] Server not required by current settings');
    return;
  }

  if (gamepadServerStartPromise) {
    return gamepadServerStartPromise;
  }

  const lifecycleVersion = gamepadServerLifecycleVersion;
  const startPromise = (async () => {
    if (gamepadServerStopPromise) {
      await gamepadServerStopPromise;
    }

    if (!shouldRunGamepadServer()) {
      console.log(`[GamepadServer] Start skipped because server is no longer needed (${reason})`);
      return;
    }

    if (lifecycleVersion !== gamepadServerLifecycleVersion) {
      console.log(`[GamepadServer] Start request became stale before launch (${reason})`);
      return;
    }

    if (gamepadServerProcess || gamepadServerStarting) {
      console.log('[GamepadServer] Already running');
      return;
    }

    gamepadServerStarting = true;

    const { spawn } = require('child_process');
    const { executablePath, candidates } = resolveGamepadServerExecutable();
    if (!executablePath) {
      console.error('[GamepadServer] Rust server binary not found. Checked paths:');
      candidates.forEach((candidate) => console.error(`  - ${candidate}`));
      return;
    }

    try {
      const configuredPort = Number.parseInt(userSettings.gamepadServerPort, 10);
      const preferredPort = Number.isFinite(configuredPort) && configuredPort > 0 && configuredPort <= 65535
        ? configuredPort
        : GAMEPAD_SERVER_BASE_PORT;
      const selectedPort = await findAvailablePort(preferredPort);

      if (!shouldRunGamepadServer()) {
        console.log(`[GamepadServer] Start aborted after port probe because server is no longer needed (${reason})`);
        return;
      }

      if (lifecycleVersion !== gamepadServerLifecycleVersion) {
        console.log(`[GamepadServer] Start request became stale after port probe (${reason})`);
        return;
      }

      if (selectedPort !== preferredPort) {
        console.warn(
          `[GamepadServer] Port ${preferredPort} unavailable, falling back to ${selectedPort}`
        );
      }
      if (userSettings.gamepadServerPort !== selectedPort) {
        userSettings.gamepadServerPort = selectedPort;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("settings-updated", { gamepadServerPort: selectedPort });
        }
        saveSettings();
      }

      console.log(`[GamepadServer] Starting Rust server binary: ${executablePath}`);
      console.log(`[GamepadServer] Port: ${selectedPort}`);

      const serverProcess = spawn(executablePath, [
        '--host', '127.0.0.1',
        '--port', String(selectedPort)
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
          GSM_OVERLAY_DATA_PATH: app.getPath('userData'),
          GSM_GAMEPAD_TOKENIZER_BACKEND: normalizeGamepadTokenizerBackend(userSettings.gamepadTokenizerBackend),
          GSM_SUDACHI_DICT_KIND: normalizeGamepadSudachiDictionary(userSettings.gamepadSudachiDictionary),
        },
      });

      gamepadServerProcess = serverProcess;

      serverProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('GSMPROGRESS:')) {
            try {
              const progressData = JSON.parse(trimmed.slice('GSMPROGRESS:'.length));
              if (settingsWindow && !settingsWindow.isDestroyed()) {
                settingsWindow.webContents.send('sudachi-progress', progressData);
              }
            } catch (e) {
              console.warn('[GamepadServer] Failed to parse progress message:', trimmed);
            }
          } else {
            console.log(`[GamepadServer] ${trimmed}`);
          }
        }
      });

      serverProcess.stderr.on('data', (data) => {
        console.error(`[GamepadServer] ${data.toString().trim()}`);
      });

      serverProcess.on('close', (code) => {
        console.log(`[GamepadServer] Process exited with code ${code}`);
        if (gamepadServerProcess === serverProcess) {
          gamepadServerProcess = null;
        }
      });

      serverProcess.on('error', (err) => {
        console.error('[GamepadServer] Failed to start:', err);
        if (gamepadServerProcess === serverProcess) {
          gamepadServerProcess = null;
        }
      });

      console.log('[GamepadServer] Started successfully');
    } catch (e) {
      console.error('[GamepadServer] Error starting server:', e);
      gamepadServerProcess = null;
    } finally {
      gamepadServerStarting = false;
    }
  })();

  let wrappedStartPromise = null;
  wrappedStartPromise = startPromise.finally(() => {
    if (gamepadServerStartPromise === wrappedStartPromise) {
      gamepadServerStartPromise = null;
    }
  });

  gamepadServerStartPromise = wrappedStartPromise;
  return wrappedStartPromise;
}

async function stopGamepadServer(reason = "unknown") {
  gamepadServerLifecycleVersion += 1;
  gamepadServerStarting = false;

  if (gamepadServerStopPromise) {
    return gamepadServerStopPromise;
  }

  const pendingStartPromise = gamepadServerStartPromise;
  const serverProcess = gamepadServerProcess;
  if (!serverProcess) {
    if (pendingStartPromise) {
      await pendingStartPromise;
    }
    return;
  }

  console.log(`[GamepadServer] Stopping (${reason})...`);

  let stopPromise = null;
  stopPromise = new Promise((resolve) => {
    let settled = false;

    const finish = (details) => {
      if (settled) return;
      settled = true;

      if (gamepadServerProcess === serverProcess) {
        gamepadServerProcess = null;
      }
      if (gamepadServerStopPromise === stopPromise) {
        gamepadServerStopPromise = null;
      }

      if (details) {
        console.log(`[GamepadServer] Stop completed (${reason}): ${details}`);
      }
      resolve();
    };

    serverProcess.once('close', (code, signal) => {
      finish(`close code=${code} signal=${signal || 'none'}`);
    });
    serverProcess.once('exit', (code, signal) => {
      finish(`exit code=${code} signal=${signal || 'none'}`);
    });
    serverProcess.once('error', (err) => {
      console.error('[GamepadServer] Stop error:', err);
      finish('error');
    });

    try {
      const killed = serverProcess.kill();
      if (!killed) {
        finish('kill returned false');
      }
    } catch (err) {
      console.error('[GamepadServer] Failed to kill process:', err);
      finish('kill threw');
    }
  });

  gamepadServerStopPromise = stopPromise;
  return stopPromise;
}

async function restartGamepadServer(reason = "unknown") {
  console.log(`[GamepadServer] Restart requested (${reason})`);
  await stopGamepadServer(reason);
  if (!shouldRunGamepadServer()) {
    console.log(`[GamepadServer] Restart skipped because server is not needed (${reason})`);
    return;
  }
  return startGamepadServer(`${reason}:restart`);
}

const OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY = "manual_hotkey";
const OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY = "texthooker_hotkey";
const OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION = "gamepad_navigation";
const overlayPauseSourceActive = {
  [OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY]: false,
  [OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY]: false,
  [OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION]: false,
};
const overlayDevServerUrl = process.env.GSM_OVERLAY_DEV_SERVER_URL || '';

function getOverlayPageUrl(relativePath) {
  if (!isDev || !overlayDevServerUrl) {
    return null;
  }
  const baseUrl = overlayDevServerUrl.endsWith('/') ? overlayDevServerUrl : `${overlayDevServerUrl}/`;
  return new URL(relativePath, baseUrl).toString();
}

function loadOverlayPage(win, relativePath) {
  const pageUrl = getOverlayPageUrl(relativePath);
  if (pageUrl) {
    return win.loadURL(pageUrl);
  }
  return win.loadFile(relativePath);
}

const EXTENSION_READY_TIMEOUT_MS = 15000;

function getExtensionSessionApi() {
  const extensionsApi = session.defaultSession?.extensions;
  if (extensionsApi) {
    return {
      events: extensionsApi,
      loadExtension: (extensionPath, options) => extensionsApi.loadExtension(extensionPath, options),
      removeExtension: (extensionId) => extensionsApi.removeExtension(extensionId),
    };
  }

  return {
    events: session.defaultSession,
    loadExtension: (extensionPath, options) => session.defaultSession.loadExtension(extensionPath, options),
    removeExtension: (extensionId) => session.defaultSession.removeExtension(extensionId),
  };
}

async function loadExtension(name) {
  const extDir = isDev ? path.join(__dirname, name) : path.join(process.resourcesPath, name);
  const extTargetDir = ensureExtensionCopy(name, extDir);
  const extensionApi = getExtensionSessionApi();
  const observedReadyIds = new Set();
  let readyTimeout = null;
  let resolveReady;
  let loadedExt = null;
  const onExtensionReady = (_event, extension) => {
    const extensionId = extension && typeof extension.id === 'string' ? extension.id : null;
    if (!extensionId) {
      return;
    }
    observedReadyIds.add(extensionId);
    if (loadedExt && extensionId === loadedExt.id) {
      clearTimeout(readyTimeout);
      resolveReady();
    }
  };
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
    readyTimeout = setTimeout(() => {
      console.warn(`[Extensions] Timed out waiting for ${name} extension-ready event after ${EXTENSION_READY_TIMEOUT_MS}ms`);
      resolve();
    }, EXTENSION_READY_TIMEOUT_MS);
  });

  try {
    extensionApi.events.on('extension-ready', onExtensionReady);
    loadedExt = await extensionApi.loadExtension(extTargetDir, { allowFileAccess: true });
    if (observedReadyIds.has(loadedExt.id)) {
      clearTimeout(readyTimeout);
      resolveReady();
    }
    await readyPromise;
    console.log(`${name} extension loaded.`);
    console.log('Extension ID:', loadedExt.id);
    return loadedExt;
  } catch (e) {
    console.error(`Failed to load extension ${name}:`, e);
    return null;
  } finally {
    clearTimeout(readyTimeout);
    extensionApi.events.off('extension-ready', onExtensionReady);
  }
}

function readExtensionVersions() {
  if (!fs.existsSync(extensionVersionsPath)) {
    return {};
  }
  try {
    const data = fs.readFileSync(extensionVersionsPath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.warn(`Failed to read extension versions file: ${extensionVersionsPath}`, e);
    return {};
  }
}

function writeExtensionVersions(versions) {
  fs.mkdirSync(extensionsRoot, { recursive: true });
  fs.writeFileSync(extensionVersionsPath, JSON.stringify(versions, null, 2));
}

function readExtensionPackageVersion(dirPath) {
  const pkgPath = path.join(dirPath, 'manifest.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(data);
    return pkg && pkg.version ? String(pkg.version) : null;
  } catch (e) {
    console.warn(`Failed to read manifest.json at ${pkgPath}`, e);
    return null;
  }
}

function ensureExtensionCopy(name, sourceDir) {
  if (!isLinux()) {
    return sourceDir;
  }
  fs.mkdirSync(extensionsRoot, { recursive: true });
  const targetDir = path.join(extensionsRoot, name);
  const versions = readExtensionVersions();
  const sourceVersion = readExtensionPackageVersion(sourceDir);
  const storedVersion = versions[name] || null;

  let shouldCopy = false;
  if (!fs.existsSync(targetDir)) {
    shouldCopy = true;
  } else if (sourceVersion && sourceVersion !== storedVersion) {
    shouldCopy = true;
  }

  if (shouldCopy) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`Failed to remove existing extension directory: ${targetDir}`, e);
    }
    try {
      fs.cpSync(sourceDir, targetDir, { recursive: true });
      console.log(`[Extensions] Copied ${name} to appdata (${targetDir})`);
      if (sourceVersion) {
        versions[name] = sourceVersion;
        writeExtensionVersions(versions);
      }
    } catch (e) {
      console.error(`[Extensions] Failed to copy ${name} from ${sourceDir} to ${targetDir}`, e);
    }
  }

  return targetDir;
}

ipcMain.on('set-platform-override', (event, platform) => {
  platformOverride = platform;
  // Re-open settings window to reflect the new platform
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    openSettings();
  }
});

ipcMain.handle('get-effective-platform', async (event) => {
  return platformOverride || process.platform;
});

function isWindows() {
  return process.platform === 'win32';
}

function isLinux() {
  return process.platform === 'linux';
}

if (isLinux() && !fs.existsSync(settingsPath)) {
  userSettings.manualModeType = "toggle";
}

function isMac() {
  return process.platform === 'darwin';
}

function getWindowsFramelessWindowOptions() {
  if (!isWindows()) {
    return {};
  }

  return {
    // Electron keeps the native WS_THICKFRAME style by default on Windows
    // frameless windows, which can let the title bar/frame leak back in.
    thickFrame: false,
    roundedCorners: false,
  };
}

function getOverlayAppIconPath() {
  return path.join(__dirname, isWindows() ? 'overlay.ico' : 'overlay-256.png');
}

function getOverlayTrayIconPath() {
  return path.join(__dirname, isWindows() ? 'overlay.ico' : 'overlay-24.png');
}

function isManualMode() {
  if (!isWindows()) {
    return true;
  }
  return userSettings.manualMode;
}

function isYomitanStateLikelyStale() {
  if (!yomitanShown) {
    return false;
  }

  const ageMs = Date.now() - lastYomitanEventAt;
  return ageMs >= YOMITAN_STATE_STALE_TIMEOUT_MS;
}

function requestBackendFocusRestore(source, options = {}) {
  if (!backend || !backend.connected) {
    return false;
  }

  const force = !!options.force;
  const now = Date.now();
  if (!force && (now - lastFocusRestoreRequestAt) < FOCUS_RESTORE_THROTTLE_MS) {
    console.log(`[FocusRestore] Throttled backend restore request (${source})`);
    return false;
  }

  lastFocusRestoreRequestAt = now;
  console.log(`Requesting focus restore from backend - ${source}`);
  backend.send({
    type: 'restore-focus-request'
  });
  return true;
}

function blurAndRestoreFocus(options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.blur();
    requestBackendFocusRestore("blur", options);
  }
}

function hideAndRestoreFocus(options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    requestBackendFocusRestore("hide", options);
  }
}

function showInactiveAndRestoreFocus(options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    ensureMainWindowIsOnConnectedDisplay("showInactiveAndRestoreFocus");
    mainWindow.showInactive();
    requestBackendFocusRestore("showInactive", options);
  }
}

function reassertOverlayTopmostWithoutFocus(source = "overlay-reassert") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  ensureMainWindowIsOnConnectedDisplay(source);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (typeof mainWindow.showInactive === "function") {
    mainWindow.showInactive();
  } else {
    mainWindow.show();
  }
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (typeof mainWindow.moveTop === "function") {
    try {
      mainWindow.moveTop();
    } catch (e) {
      // Ignore - moveTop may not be available on all Electron/platform combos.
    }
  }
}

function aggressivelyShowOverlayAndReturnFocus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  reassertOverlayTopmostWithoutFocus("aggressivelyShowOverlayAndReturnFocus");
  mainWindow.focus();
}

function focusOverlayForYomitanLookup() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  yomitanForegroundActive = true;
  const focusDelays = [0, 50, 120, 240];
  for (const delay of focusDelays) {
    setTimeout(() => {
      if (!yomitanForegroundActive || !yomitanShown) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;

      ensureMainWindowIsOnConnectedDisplay("yomitan-lookup-focus");
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      if (isWindows() || isMac()) {
        mainWindow.setIgnoreMouseEvents(false, { forward: true });
      }

      aggressivelyShowOverlayAndReturnFocus();
      try {
        mainWindow.webContents.focus();
      } catch (e) {
        // Ignore focus failures during rapid window transitions.
      }
    }, delay);
  }
}

function restoreOverlayAfterYomitanLookup() {
  const wasForegroundedForYomitan = yomitanForegroundActive;
  yomitanForegroundActive = false;

  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Preserve existing manual/gamepad/resize interaction states.
  if (manualHotkeyPressed || manualModeToggleState || gamepadNavigationActive || resizeMode) {
    return;
  }

  if (isWindows() || isMac()) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  if (!isWindows() && !isMac()) {
    hideAndRestoreFocus();
    return;
  }

  if (mainWindow.isFocused() || wasForegroundedForYomitan) {
    blurAndRestoreFocus();
  }

  if (currentMagpieActive) {
    scheduleYomitanCloseRecovery();
  }
}

function aggressivelyFocusOverlayForGamepadNavigation() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const focusDelays = [0, 50, 120, 240, 380];
  for (const delay of focusDelays) {
    setTimeout(() => {
      if (!gamepadNavigationActive) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;

      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      // While navigating with controller, prefer direct overlay interaction over click-through.
      if (isWindows() || isMac()) {
        mainWindow.setIgnoreMouseEvents(false, { forward: true });
      }

      aggressivelyShowOverlayAndReturnFocus();
      try {
        mainWindow.webContents.focus();
      } catch (e) {
        // Ignore focus failures during rapid z-order races.
      }
    }, delay);
  }
}

function requestGamepadNavigationToggleFromMain(source = "unknown") {
  if (!userSettings.gamepadEnabled) {
    console.log(`[Gamepad] Ignoring toggle request from ${source}: gamepad disabled`);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log(`[Gamepad] Ignoring toggle request from ${source}: main window unavailable`);
    return;
  }

  const previousState = !!gamepadNavigationActive;
  console.log(`[Gamepad] Toggle requested from ${source}; previous active=${previousState}`);
  mainWindow.webContents.send("gamepad-toggle-navigation");

  // If renderer misses the first IPC during rapid focus/window transitions, retry once.
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (gamepadNavigationActive === previousState) {
      console.log(`[Gamepad] Toggle state unchanged after first request from ${source}; retrying`);
      mainWindow.webContents.send("gamepad-toggle-navigation");
    }
  }, 120);
}

function setGamepadNavigationModeActive(active, triggerSource = "unknown") {
  const nextActive = !!active;
  gamepadNavigationActive = nextActive;

  if (nextActive) {
    showOverlayUsingManualFlow(`Gamepad ${triggerSource} Activate`, OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION);
    aggressivelyFocusOverlayForGamepadNavigation();
    return;
  }

  const manualActivationStillActive = !!(manualHotkeyPressed || manualModeToggleState);
  if (manualActivationStillActive) {
    requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION);
    console.log(`[Gamepad] Deactivated from ${triggerSource}; keeping overlay visible due manual activation`);
    return;
  }

  hideOverlayUsingManualFlow(`Gamepad ${triggerSource} Deactivate`, OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION);
}

function scheduleYomitanCloseRecovery() {
  const version = ++yomitanRecoveryVersion;
  const recoveryDelays = [60, 180];

  for (const delay of recoveryDelays) {
    setTimeout(() => {
      if (version !== yomitanRecoveryVersion) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (yomitanShown || resizeMode || manualHotkeyPressed || manualModeToggleState || gamepadNavigationActive) return;
      if (isWindows() || isMac()) {
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
      }
      reassertOverlayTopmostWithoutFocus("yomitan-close-recovery");
    }, delay);
  }
}

const hasPersistedOverlaySettings = fs.existsSync(settingsPath);
let shouldPersistOverlaySettings = false;
if (hasPersistedOverlaySettings) {
  try {
    const data = fs.readFileSync(settingsPath, "utf-8");
    const oldUserSettings = JSON.parse(data);
    userSettings = { ...DEFAULT_USER_SETTINGS, ...userSettings, ...oldUserSettings };

    if (!Object.prototype.hasOwnProperty.call(oldUserSettings, "hideOnStartup")) {
      userSettings.hideOnStartup = true;
      shouldPersistOverlaySettings = true;
    }

    if (!Object.prototype.hasOwnProperty.call(oldUserSettings, "openSettingsOnStartup")) {
      userSettings.openSettingsOnStartup = true;
      shouldPersistOverlaySettings = true;
    }

    const hasShowTextIndicatorsSetting = Object.prototype.hasOwnProperty.call(oldUserSettings, "showTextIndicators");
    if (!hasShowTextIndicatorsSetting) {
      if (Object.prototype.hasOwnProperty.call(oldUserSettings, "showTextBackground")) {
        userSettings.showTextIndicators = true;
        userSettings.fadeTextIndicators = !!oldUserSettings.showTextBackground;
      } else {
        userSettings.showTextIndicators = true;
        userSettings.fadeTextIndicators = false;
      }
      shouldPersistOverlaySettings = true;
    } else if (!Object.prototype.hasOwnProperty.call(oldUserSettings, "fadeTextIndicators")) {
      userSettings.fadeTextIndicators = false;
      shouldPersistOverlaySettings = true;
    }

    if (!Object.prototype.hasOwnProperty.call(oldUserSettings, "mainBoxStartupWarningAcknowledged")) {
      userSettings.mainBoxStartupWarningAcknowledged = false;
      shouldPersistOverlaySettings = true;
    }

    if (isWindows()) {
      userSettings.offsetX = 0;
      userSettings.offsetY = 0;
    } else {
      userSettings.manualMode = true;
      userSettings.magpieCompatibility = false;
    }
  } catch (error) {
    console.error("Failed to load settings.json:", error)

  }
}

const websocketEndpointsNormalized = enforceOverlayWebSocketUrls(userSettings);
const texthookerUrlNormalized = enforceTexthookerUrl(userSettings);
const furiganaSettingsNormalized = normalizeFuriganaSettings(userSettings);
const gamepadTokenizerSettingsNormalized = normalizeGamepadTokenizerSettings(userSettings);
const hotkeyConflictResolvedOnLoad = ensureManualAndTexthookerHotkeysDistinct("settings-load");
if (websocketEndpointsNormalized || texthookerUrlNormalized || furiganaSettingsNormalized || gamepadTokenizerSettingsNormalized || hotkeyConflictResolvedOnLoad) {
  shouldPersistOverlaySettings = true;
}
if (hasPersistedOverlaySettings && shouldPersistOverlaySettings) {
  saveSettings();
}

function getGSMOverlaySettings() {
  let gsmSettings = getGSMSettings();
  if (gsmSettings.overlay) {
    return gsmSettings.overlay;
  }
  return {
    websocket_port: 7276,
    engine: "lens",
    monitor_to_capture: 0,
    periodic: false,
    periodic_interval: 3.0,
    scan_delay: 0.25
  }
}

let lastDisplaySyncSignature = "";
let pendingDisplaySyncTimer = null;
let lastDisplayFallbackWarningKey = "";

function coerceMonitorIndex(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function getEmergencyFallbackDisplay() {
  const primary = screen.getPrimaryDisplay();
  if (primary) {
    return primary;
  }

  const displays = screen.getAllDisplays();
  if (displays.length > 0) {
    return displays[0];
  }

  return {
    id: "virtual-fallback",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
  };
}

function resolveOverlayMonitorSelection(options = {}) {
  const logFallback = !!options.logFallback;
  const displays = screen.getAllDisplays();
  const fallbackDisplay = getEmergencyFallbackDisplay();

  if (!Array.isArray(displays) || displays.length === 0) {
    return {
      display: fallbackDisplay,
      displays: [fallbackDisplay],
      requestedIndex: 0,
      selectedIndex: 0,
      usedFallback: true,
    };
  }

  const overlaySettings = getGSMOverlaySettings();
  const requestedIndex = coerceMonitorIndex(overlaySettings.monitor_to_capture);
  const selectedIndex = Math.min(Math.max(requestedIndex, 0), displays.length - 1);
  const usedFallback = selectedIndex !== requestedIndex;
  const selectedDisplay = displays[selectedIndex] || fallbackDisplay;

  if (usedFallback && logFallback) {
    const warningKey = `${requestedIndex}->${selectedIndex}|${displays.length}`;
    if (warningKey !== lastDisplayFallbackWarningKey) {
      console.warn(
        `[DisplaySync] monitor_to_capture=${requestedIndex} is invalid for ${displays.length} display(s). Using index ${selectedIndex}.`
      );
      lastDisplayFallbackWarningKey = warningKey;
    }
  } else if (!usedFallback) {
    lastDisplayFallbackWarningKey = "";
  }

  return {
    display: selectedDisplay,
    displays,
    requestedIndex,
    selectedIndex,
    usedFallback,
  };
}

function getCurrentOverlayMonitor(options = {}) {
  return resolveOverlayMonitorSelection(options).display;
}

function getOverlayBoundsForDisplay(display) {
  const safeDisplay = display || getEmergencyFallbackDisplay();
  const safeBounds = safeDisplay.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
  const width = Math.max(1, Math.floor(Number(safeBounds.width) || 0));
  const rawHeight = Math.max(1, Math.floor(Number(safeBounds.height) || 0));
  const height = rawHeight > 1 ? rawHeight - 1 : rawHeight;
  return {
    x: Math.floor(Number(safeBounds.x) || 0),
    y: Math.floor(Number(safeBounds.y) || 0),
    width,
    height,
  };
}

function normalizeDisplayRect(rect, fallback = { x: 0, y: 0, width: 1920, height: 1080 }) {
  const source = rect || fallback;
  return {
    x: Math.floor(Number(source.x) || 0),
    y: Math.floor(Number(source.y) || 0),
    width: Math.max(1, Math.floor(Number(source.width) || 0)),
    height: Math.max(1, Math.floor(Number(source.height) || 0)),
  };
}

function normalizeDisplaySize(size, fallbackRect) {
  const fallback = fallbackRect || { width: 1920, height: 1080 };
  const source = size || fallback;
  return {
    width: Math.max(1, Math.floor(Number(source.width) || 0)),
    height: Math.max(1, Math.floor(Number(source.height) || 0)),
  };
}

function toPhysicalDisplayRect(rect) {
  const dipRect = normalizeDisplayRect(rect);
  if (typeof screen.dipToScreenRect === "function") {
    try {
      return normalizeDisplayRect(screen.dipToScreenRect(null, dipRect), dipRect);
    } catch (e) {
      console.warn("[DisplaySync] Failed to convert DIP rect to physical pixels:", e);
    }
  }
  return dipRect;
}

function buildOverlayDisplayInfo(display) {
  const safeDisplay = display || getEmergencyFallbackDisplay();
  const dipBounds = normalizeDisplayRect(safeDisplay.bounds);
  const dipWorkArea = normalizeDisplayRect(safeDisplay.workArea, dipBounds);
  const physicalBounds = toPhysicalDisplayRect(dipBounds);
  const physicalWorkArea = toPhysicalDisplayRect(dipWorkArea);

  return {
    id: safeDisplay.id,
    label: safeDisplay.label || "",
    scaleFactor: Number(safeDisplay.scaleFactor) || 1,
    bounds: dipBounds,
    workArea: dipWorkArea,
    size: normalizeDisplaySize(safeDisplay.size, dipBounds),
    workAreaSize: normalizeDisplaySize(safeDisplay.workAreaSize, dipWorkArea),
    physicalBounds,
    physicalWorkArea,
    physicalSize: {
      width: physicalBounds.width,
      height: physicalBounds.height,
    },
    physicalWorkAreaSize: {
      width: physicalWorkArea.width,
      height: physicalWorkArea.height,
    },
  };
}

function rectanglesOverlap(a, b) {
  if (!a || !b) return false;
  return (
    a.x < (b.x + b.width) &&
    (a.x + a.width) > b.x &&
    a.y < (b.y + b.height) &&
    (a.y + a.height) > b.y
  );
}

function isWindowVisibleOnAnyDisplay(win) {
  if (!win || win.isDestroyed()) {
    return false;
  }
  const displays = screen.getAllDisplays();
  if (!Array.isArray(displays) || displays.length === 0) {
    return true;
  }
  const windowBounds = win.getBounds();
  return displays.some((display) => rectanglesOverlap(windowBounds, display.bounds));
}

function getOverlayDisplaySyncSignature() {
  const selection = resolveOverlayMonitorSelection();
  const selected = selection.display || getEmergencyFallbackDisplay();
  const selectedBounds = selected.bounds || { x: 0, y: 0, width: 0, height: 0 };
  const topology = selection.displays
    .map((display) => {
      const b = display.bounds || { x: 0, y: 0, width: 0, height: 0 };
      return `${display.id}:${b.x}:${b.y}:${b.width}:${b.height}:${display.scaleFactor || 1}`;
    })
    .join("|");
  return `${selection.selectedIndex}|${selected.id}|${selectedBounds.x}:${selectedBounds.y}:${selectedBounds.width}:${selectedBounds.height}|${topology}`;
}

function applyBoundsIfNeeded(win, bounds, label, reason) {
  if (!win || win.isDestroyed()) {
    return false;
  }

  try {
    const currentBounds = win.getBounds();
    const unchanged = (
      currentBounds.x === bounds.x &&
      currentBounds.y === bounds.y &&
      currentBounds.width === bounds.width &&
      currentBounds.height === bounds.height
    );
    if (unchanged) {
      return false;
    }
    win.setBounds(bounds);
    return true;
  } catch (e) {
    console.warn(`[DisplaySync] Failed to update ${label} bounds (${reason}):`, e);
    return false;
  }
}

function syncOverlayWindowsToCurrentMonitor(reason = "unknown", options = {}) {
  const includeMain = options.includeMain !== false;
  const includeTexthooker = options.includeTexthooker !== false;
  const includeOffsetHelper = options.includeOffsetHelper !== false;
  const forceSendDisplayInfo = !!options.forceSendDisplayInfo;

  const selection = resolveOverlayMonitorSelection({ logFallback: true });
  const display = selection.display || getEmergencyFallbackDisplay();
  const bounds = getOverlayBoundsForDisplay(display);
  let updated = false;

  if (includeMain) {
    updated = applyBoundsIfNeeded(mainWindow, bounds, "mainWindow", reason) || updated;
  }
  if (includeTexthooker) {
    updated = applyBoundsIfNeeded(texthookerWindow, bounds, "texthookerWindow", reason) || updated;
  }
  if (includeOffsetHelper) {
    updated = applyBoundsIfNeeded(offsetHelperWindow, bounds, "offsetHelperWindow", reason) || updated;
  }

  if ((updated || forceSendDisplayInfo) && mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("display-info", buildOverlayDisplayInfo(display));
    } catch (e) {
      console.warn(`[DisplaySync] Failed to send display-info (${reason}):`, e);
    }
  }

  return { updated, display, bounds, selection };
}

function ensureMainWindowIsOnConnectedDisplay(reason = "unknown") {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (isWindowVisibleOnAnyDisplay(mainWindow)) {
    return false;
  }

  console.warn(`[DisplaySync] Main overlay window is off-screen. Recovering bounds (${reason}).`);
  syncOverlayWindowsToCurrentMonitor(`offscreen-recovery:${reason}`, { forceSendDisplayInfo: true });
  return true;
}

function scheduleOverlayDisplaySync(reason = "unknown") {
  if (pendingDisplaySyncTimer) {
    clearTimeout(pendingDisplaySyncTimer);
  }

  pendingDisplaySyncTimer = setTimeout(() => {
    pendingDisplaySyncTimer = null;
    syncOverlayWindowsToCurrentMonitor(reason);
    lastDisplaySyncSignature = getOverlayDisplaySyncSignature();
    ensureMainWindowIsOnConnectedDisplay(reason);
  }, 120);
}

let gsmSettings = getGSMSettings();

function shouldOverlayHotkeyRequestPause(source) {
  const currentSettings = getGSMSettings();
  const experimentalEnabled = !!(currentSettings.experimental && currentSettings.experimental.enable_experimental_features);
  const processPausing = currentSettings.process_pausing || {};
  if (!experimentalEnabled || !processPausing.enabled) {
    return false;
  }

  switch (source) {
    case OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY:
      return !!processPausing.overlay_manual_hotkey_requests_pause;
    case OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY:
      return !!processPausing.overlay_texthooker_hotkey_requests_pause;
    case OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION:
      if (typeof processPausing.overlay_gamepad_navigation_requests_pause === "boolean") {
        return !!processPausing.overlay_gamepad_navigation_requests_pause;
      }
      // Backward compatibility for configs created before dedicated gamepad flag.
      return !!processPausing.overlay_manual_hotkey_requests_pause;
    default:
      return false;
  }
}

function sendOverlayPauseRequest(action, source) {
  if (!backend) {
    console.warn(`[ProcessPause] Backend unavailable, cannot send ${action} request for source=${source}`);
    return false;
  }

  console.log(`[ProcessPause] Sending ${action} request for source=${source}`);
  backend.send({
    type: "process-pause-request",
    action,
    source,
  });
  return true;
}

function requestOverlayPauseForSource(source) {
  if (!shouldOverlayHotkeyRequestPause(source)) {
    console.log(`[ProcessPause] Skipping pause request for source=${source} (disabled in config)`);
    return;
  }

  if (overlayPauseSourceActive[source]) {
    return;
  }

  if (sendOverlayPauseRequest("pause", source)) {
    overlayPauseSourceActive[source] = true;
  }
}

function requestOverlayResumeForSource(source) {
  const wasActive = !!overlayPauseSourceActive[source];
  const shouldRequestByConfig = shouldOverlayHotkeyRequestPause(source);
  overlayPauseSourceActive[source] = false;

  if (!wasActive && !shouldRequestByConfig) {
    return;
  }

  sendOverlayPauseRequest("resume", source);
}

function releaseAllOverlayPauseRequests() {
  requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
  requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY);
  requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION);
}

function requestManualOverlayScan(source = "overlay") {
  const safeSource = String(source || "overlay");
  if (!backend || !backend.connected) {
    console.warn(`[OverlayScan] Cannot request manual overlay scan: backend not connected (source=${safeSource})`);
    return false;
  }

  backend.send({
    type: "manual-overlay-scan-request",
    source: safeSource,
  });
  console.log(`[OverlayScan] Manual overlay scan requested (source=${safeSource})`);
  return true;
}

function showOverlayUsingManualFlow(triggerSource, pauseSource = OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  console.log(`[OverlayActivation] Attempting SHOW (${triggerSource})... Current State: ${isOverlayVisible ? "Visible" : "Hidden"}`);
  ensureMainWindowIsOnConnectedDisplay(`manual-show:${triggerSource}`);

  // Always register the pause source even if already visible.
  requestOverlayPauseForSource(pauseSource);

  if (isOverlayVisible) {
    console.log("[OverlayActivation] Blocked: Overlay is already visible.");
    return false;
  }

  isOverlayVisible = true;
  mainWindow.webContents.send('show-overlay-hotkey', true);

  if (!isLinux()) {
    mainWindow.setIgnoreMouseEvents(false, { forward: true });
  } else {
    mainWindow.show();
  }

  // Mirror manual-mode behavior: bring overlay forward when manual flow is active.
  if (currentMagpieActive || isManualMode()) {
    mainWindow.show();
  }

  return true;
}

function hideOverlayUsingManualFlow(triggerSource, pauseSource = OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  console.log(`[OverlayActivation] Attempting HIDE (${triggerSource})... Current State: ${isOverlayVisible ? "Visible" : "Hidden"}`);

  // Always release the pause source even if overlay visibility is already false.
  requestOverlayResumeForSource(pauseSource);

  if (!isOverlayVisible) {
    console.log("[OverlayActivation] Blocked: Overlay is already hidden.");
    return false;
  }

  isOverlayVisible = false;
  mainWindow.webContents.send('show-overlay-hotkey', false);

  if (!yomitanShown && !resizeMode) {
    if (!isLinux()) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    hideAndRestoreFocus();
  } else {
    console.log(`[OverlayActivation] Skipping Focus Restore. Yomitan: ${yomitanShown}, Resize: ${resizeMode}`);
  }

  return true;
}

function saveSettings() {
  try {
    let oldUserSettings = null;
    if (fs.existsSync(settingsPath)) {
      try {
        const data = fs.readFileSync(settingsPath, "utf-8");
        oldUserSettings = JSON.parse(data);
      } catch (e) {
        console.warn(`[Settings] Existing settings file is unreadable JSON; continuing with overwrite at ${settingsPath}:`, e.message);
      }
    }

    if (isWindows()) {
      userSettings.offsetX = 0;
      userSettings.offsetY = 0;
    } else {
      userSettings.manualMode = true;
      userSettings.magpieCompatibility = false;
    }

    if (oldUserSettings) {
      console.log("Old Settings:", oldUserSettings);
      console.log("New Settings:", userSettings);
    }

    fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2), "utf-8");
  } catch (e) {
    console.error(`[Settings] Failed to save settings to ${settingsPath}:`, e);
  }
}

let holdHeartbeat = null; // Store the interval ID
let lastKeyActivity = 0;  // Timestamp of last key press
let isOverlayVisible = false; // Internal tracking to prevent redundant calls

const TEXTHOOKER_CONNECTIVITY_INTERVAL_MS = 5000;
let texthookerLoadInterval = null;
let texthookerLoadInFlight = false;

function clearManualActivationState(reason = "manual-reset") {
  if (holdHeartbeat) {
    console.log(`[ManualMode] Clearing holdHeartbeat interval (${reason})`);
    clearInterval(holdHeartbeat);
    holdHeartbeat = null;
  }

  manualHotkeyPressed = false;
  manualModeToggleState = false;
  isOverlayVisible = false;
}

function restoreAutomaticOverlayPassThrough(reason = "auto-reset") {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (resizeMode || yomitanShown || gamepadNavigationActive || yomitanForegroundActive) {
    console.log(
      `[OverlayReset] Skipping automatic pass-through reset (${reason}) ` +
      `resizeMode=${resizeMode} yomitanShown=${yomitanShown} ` +
      `gamepadNavigationActive=${gamepadNavigationActive} yomitanForegroundActive=${yomitanForegroundActive}`
    );
    return;
  }

  if (currentMagpieActive) {
    reassertOverlayTopmostWithoutFocus(`auto-pass-through:${reason}`);
  } else {
    mainWindow.show();
  }

  if (!isLinux()) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function checkConnectivity(url) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      console.error('Invalid URL:', url);
      resolve(false);
      return;
    }

    const httpModule = parsedUrl.protocol === 'https:' ? require('https') : require('http');
    const req = httpModule.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'HEAD',
      timeout: 5000
    }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.abort();
      resolve(false);
    });
    req.end();
  });
}

async function attemptTexthookerLoad(url) {
  if (!texthookerWindow || texthookerWindow.isDestroyed()) {
    return false;
  }
  if (texthookerLoadInFlight) {
    return false;
  }
  texthookerLoadInFlight = true;
  try {
    if (!url) {
      return false;
    }
    const isConnected = await checkConnectivity(url);
    if (!isConnected) {
      console.log(`[Texthooker] ${url} still unreachable`);
      return false;
    }
    console.log(`[Texthooker] Connectivity confirmed, loading ${url}`);
    await texthookerWindow.loadURL(url);
    return true;
  } catch (err) {
    console.error('[Texthooker] Failed to load URL:', err);
    return false;
  } finally {
    texthookerLoadInFlight = false;
  }
}

function stopTexthookerLoadTimer() {
  if (texthookerLoadInterval) {
    clearInterval(texthookerLoadInterval);
    texthookerLoadInterval = null;
  }
}

function scheduleTexthookerLoad(url) {
  stopTexthookerLoadTimer();
  if (!texthookerWindow || texthookerWindow.isDestroyed() || !url) {
    return;
  }

  const tryLoad = async () => {
    const loaded = await attemptTexthookerLoad(url);
    if (loaded) {
      stopTexthookerLoadTimer();
    }
  };

  tryLoad().catch((error) => {
    console.error('[Texthooker] Initial load attempt failed:', error);
  });

  texthookerLoadInterval = setInterval(() => {
    tryLoad().catch((error) => {
      console.error('[Texthooker] Connectivity retry failed:', error);
    });
  }, TEXTHOOKER_CONNECTIVITY_INTERVAL_MS);
}

function createTexthookerWindow() {
  if (texthookerWindow && !texthookerWindow.isDestroyed()) {
    return;
  }

  refreshOverlayTransportSettingsFromGSM("createTexthookerWindow");

  const display = getCurrentOverlayMonitor({ logFallback: true });
  const overlayBounds = getOverlayBoundsForDisplay(display);

  texthookerWindow = new BrowserWindow({
    x: overlayBounds.x,
    y: overlayBounds.y,
    width: overlayBounds.width,
    height: overlayBounds.height,
    icon: getOverlayAppIconPath(),
    transparent: true,
    frame: false,
    ...getWindowsFramelessWindowOptions(),
    show: false,
    alwaysOnTop: true,
    resizable: false,
    title: "GSM Texthooker",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false, // Prevents sleeping
    },
  });

  waitForTexthookerUrl(texthookerWindow, userSettings.texthookerUrl || DEFAULT_TEXTHOOKER_URL);
  texthookerWindow.setOpacity(0.95);

  texthookerWindow.on('closed', () => {
    texthookerLoadToken += 1;
    if (isTexthookerMode) {
      isTexthookerMode = false;
      requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY);
    }
    texthookerWindow = null;
  });

  texthookerWindow.on('show', () => {
    texthookerWindow.setAlwaysOnTop(true, "screen-saver");
  });
}

function waitForTexthookerUrl(win, targetUrl) {
  if (!win || win.isDestroyed()) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (e) {
    console.warn(`[TexthookerMode] Invalid URL, loading directly: ${targetUrl}`);
    win.loadURL(targetUrl);
    return;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    win.loadURL(targetUrl);
    return;
  }

  const token = ++texthookerLoadToken;
  const pollIntervalMs = 500;
  const requestTimeoutMs = 1000;

  const attempt = () => {
    if (!win || win.isDestroyed() || token !== texthookerLoadToken) return;

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.request(targetUrl, { method: 'GET' }, (res) => {
      const status = res.statusCode || 0;
      res.resume();

      if (status >= 200 && status < 400) {
        console.log(`[TexthookerMode] URL reachable, loading: ${targetUrl}`);
        win.loadURL(targetUrl);
        return;
      }

      console.log(`[TexthookerMode] URL not ready (status ${status}), retrying...`);
      setTimeout(attempt, pollIntervalMs);
    });

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', (err) => {
      if (token !== texthookerLoadToken) return;
      console.log(`[TexthookerMode] URL not ready (${err.message}), retrying...`);
      setTimeout(attempt, pollIntervalMs);
    });

    req.setTimeout(requestTimeoutMs);
    req.end();
  };

  console.log(`[TexthookerMode] Waiting for URL: ${targetUrl}`);
  attempt();
}

function registerTexthookerHotkey(oldHotkey) {
  const conflictResolved = ensureManualAndTexthookerHotkeysDistinct("registerTexthookerHotkey");
  const texthookerHotkey = String(userSettings.texthookerHotkey || DEFAULT_TEXTHOOKER_HOTKEY).trim() || DEFAULT_TEXTHOOKER_HOTKEY;
  userSettings.texthookerHotkey = texthookerHotkey;

  if (oldHotkey && !hotkeysConflict(oldHotkey, userSettings.showHotkey)) {
    globalShortcut.unregister(oldHotkey);
  }
  globalShortcut.unregister(texthookerHotkey);

  if (conflictResolved) {
    console.warn(`[TexthookerMode] Hotkey conflict resolved; using ${texthookerHotkey}`);
  }

  const registered = globalShortcut.register(texthookerHotkey, () => {
    if (!texthookerWindow || texthookerWindow.isDestroyed()) {
      createTexthookerWindow();
    }

    // Safety check for mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return;

    isTexthookerMode = !isTexthookerMode;

    if (isTexthookerMode) {
      console.log("[TexthookerMode] Showing...");
      requestOverlayPauseForSource(OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY);

      // Sync bounds before showing
      const display = getCurrentOverlayMonitor({ logFallback: true });
      const overlayBounds = getOverlayBoundsForDisplay(display);
      texthookerWindow.setBounds(overlayBounds);

      if (!isLinux()) {
        console.log("[TexthookerMode] ACTION: setIgnoreMouseEvents(false)");
        texthookerWindow.setIgnoreMouseEvents(false, { forward: true });
      }

      texthookerWindow.show();
      texthookerWindow.setAlwaysOnTop(true, "screen-saver");
      texthookerWindow.focus();

      console.log("[TexthookerMode] ACTION: Forcing Focus");
      texthookerWindow.show(); // Call show again to force focus like manual mode

      // Hide main window to avoid interference
      mainWindow.hide();

    } else {
      console.log("[TexthookerMode] Hiding...");
      requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY);
      texthookerWindow.hide();

      // Go back to whatever mode it was in before
      if (isManualMode()) {
        if (isOverlayVisible) {
          mainWindow.show();
          if (!isLinux()) {
            mainWindow.setIgnoreMouseEvents(false, { forward: true });
          }
        } else {
          // Mirror manual mode release flow
          if (!yomitanShown && !resizeMode) {
            if (!isLinux()) {
              mainWindow.setIgnoreMouseEvents(true, { forward: true });
            }
            console.log("[TexthookerMode] ACTION: calling hideAndRestoreFocus()");
            hideAndRestoreFocus();
          }
        }
      } else {
        // Automatic mode
        mainWindow.show();
        if (!isLinux()) {
          mainWindow.setIgnoreMouseEvents(true, { forward: true });
        }
        blurAndRestoreFocus();
      }
    }
  });

  if (!registered) {
    console.warn(`[TexthookerMode] Failed to register texthooker hotkey: ${texthookerHotkey}`);
  }
}

function registerManualShowHotkey(oldHotkey) {
  const conflictResolved = ensureManualAndTexthookerHotkeysDistinct("registerManualShowHotkey");
  if (conflictResolved) {
    registerTexthookerHotkey();
  }

  if (!isManualMode()) {
    console.log("[ManualHotkey] Not in manual mode, skipping registration.");
    return;
  }

  // clean up old shortcut
  if (manualIn) {
    console.log(`[ManualHotkey] Unregistering old hotkey: ${oldHotkey || userSettings.showHotkey}`);
    const unregisterTarget = oldHotkey || userSettings.showHotkey;
    if (!hotkeysConflict(unregisterTarget, userSettings.texthookerHotkey)) {
      globalShortcut.unregister(unregisterTarget);
    }
  }

  console.log(`[ManualHotkey] Registering hotkey: ${userSettings.showHotkey} | Mode: ${userSettings.manualModeType}`);

  // Helper: Consolidated Show Logic
  const showOverlay = (triggerSource) => {
    const shown = showOverlayUsingManualFlow(`ManualHotkey ${triggerSource}`, OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
    if (shown && userSettings.manualModeRescanOnShow) {
      requestManualOverlayScan("manual-mode-enter");
    }
  };

  // Helper: Consolidated Hide Logic
  const hideOverlay = (triggerSource) => {
    hideOverlayUsingManualFlow(`ManualHotkey ${triggerSource}`, OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
  };

  manualIn = globalShortcut.register(userSettings.showHotkey, () => {
    const now = Date.now();
    // console.log(`[ManualHotkey] RAW TRIGGER at ${now}`); // Uncomment if you want to see raw OS repeat rate

    // 1. Safety Checks
    if (!isManualMode()) {
      console.log("[ManualHotkey] Detected non-manual mode inside callback, unregistering.");
      globalShortcut.unregister(userSettings.showHotkey);
      return;
    }
    if (!mainWindow) return;

    manualHotkeyPressed = true;
    lastManualActivity = now;
    lastKeyActivity = now;

    // 2. TOGGLE MODE
    if (userSettings.manualModeType === "toggle") {
      // For toggle, we usually rely on key-up logic or a debounce, 
      // but since globalShortcut is KeyDown only, we throttle simplisticly.
      // This part might need a 'canToggle' flag if it bounces, but let's log it first.
      if (holdHeartbeat) {
        clearInterval(holdHeartbeat);
        holdHeartbeat = null;
      }
      console.log("[ManualHotkey] Toggle Logic Triggered");
      manualModeToggleState = !manualModeToggleState;
      if (isOverlayVisible) {
        hideOverlay("Toggle Press");
      } else {
        showOverlay("Toggle Press");
      }

      setTimeout(() => manualHotkeyPressed = false, 100);
    }

    // 3. HOLD MODE (Heartbeat Strategy)
    else {
      // If the overlay isn't up yet, show it immediately
      if (!isOverlayVisible) {
        showOverlay("Hold Start");

        // Start a heartbeat to check if the user stopped pressing
        if (holdHeartbeat) {
          console.log("[ManualHotkey] Clearing existing heartbeat interval");
          clearInterval(holdHeartbeat);
        }

        console.log("[ManualHotkey] Starting Heartbeat Interval");
        holdHeartbeat = setInterval(() => {
          const checkTime = Date.now();
          const timeSincePress = checkTime - lastKeyActivity;

          // console.log(`[ManualHotkey] Heartbeat Tick: ${timeSincePress}ms since last signal`);

          const holdReleaseThreshold = 750;
          if (timeSincePress > holdReleaseThreshold) {
            console.log(`[ManualHotkey] RELEASE DETECTED. Time since press: ${timeSincePress}ms`);
            hideOverlay("Hold Release");
            manualHotkeyPressed = false;
            clearInterval(holdHeartbeat);
            holdHeartbeat = null;
          }
        }, 100); // Check every 100ms
      } else {
        // If visible, we just updated lastKeyActivity, effectively "feeding the watchdog"
        // console.log("[ManualHotkey] Key Held - Refreshed activity timestamp");
      }
    }
  });

  if (!manualIn) {
    console.warn(`[ManualHotkey] Failed to register hotkey: ${userSettings.showHotkey}`);
  }
}

// DISABLED AFK TIMER FOR NOW
function resetActivityTimer() {
  // // Clear existing timer
  // if (activityTimer) {
  //   clearTimeout(activityTimer);
  // }

  // if (userSettings.afkTimer === 0) {
  //   return;
  // }

  // // Set new timer for 5 minutes
  // activityTimer = setTimeout(() => {
  //   if (mainWindow && !mainWindow.isDestroyed()) {
  //     console.log("AFK timeout reached — hiding overlay text and releasing interactions");
  //     // Use dedicated AFK IPC channel so renderer knows this is an automatic hide
  //     try {
  //       mainWindow.webContents.send('afk-hide', true);
  //       afkHidden = true;
  //     } catch (e) {
  //       console.warn('Failed to send afk-hide to renderer:', e);
  //     }

  //     // Ensure manual hotkey state is cleared so subsequent AFK cycles behave correctly
  //     manualHotkeyPressed = false;

  //     // Make the overlay ignore mouse events so clicks pass through
  //     try {
  //       if (isWindows || isMac()) {
  //         mainWindow.setIgnoreMouseEvents(true, { forward: true });
  //       }
  //     } catch (e) {
  //       console.warn('Failed to setIgnoreMouseEvents on mainWindow:', e);
  //     }

  //     // Blur window so it doesn't steal focus
  //     try {
  //       blurAndRestoreFocus();
  //     } catch (e) {
  //       // ignore
  //     }
  //   }
  // }, userSettings.afkTimer * 60 * 1000);
}

function openSettings() {
  refreshOverlayTransportSettingsFromGSM("openSettings");
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("force-visible", true);
  }
  mainWindow.webContents.send("request-current-settings");
  ipcMain.once("reply-current-settings", (event, settings) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = new BrowserWindow({
      width: 1200,
      height: 980,
      icon: getOverlayAppIconPath(),
      resizable: true,
      alwaysOnTop: true,
      title: "Overlay Settings",
      webPreferences: {
        preload: FIND_IN_PAGE_PRELOAD_PATH,
        nodeIntegration: true,
        contextIsolation: false
      },
    });
    enableFindInPage(settingsWindow);

    settingsWindow.webContents.on('context-menu', () => {
      if (isDev) {
        settingsWindow.webContents.openDevTools({ mode: 'detach' });
      }
    });
    // settingsWindow.webContents.openDevTools({ mode: 'detach' });

    settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
      const child = new BrowserWindow({
        parent: settingsWindow ? settingsWindow : undefined,
        show: true,
        width: 1200,
        height: 980,
        icon: getOverlayAppIconPath(),
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          devTools: true,
          nodeIntegrationInSubFrames: true,
          backgroundThrottling: false,
        },
      });
      child.setMenu(null);
      child.loadURL(url);
      return { action: 'deny' };
    });

    settingsWindow.removeMenu()

    loadOverlayPage(settingsWindow, "settings.html");
    settingsWindow.webContents.once("did-finish-load", () => {
      if (!settingsWindow || settingsWindow.isDestroyed()) return;
      settingsWindow.webContents.send("preload-settings", {
        userSettings,
        websocketStates,
        defaultSettings: DEFAULT_USER_SETTINGS,
      });
    });
    settingsWindow.on("closed", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("force-visible", false);
      }
    })
    console.log(websocketStates)
    setTimeout(() => {
      settingsWindow.setSize(settingsWindow.getSize()[0], settingsWindow.getSize()[1]);
      settingsWindow.webContents.invalidate();
      settingsWindow.show();
    }, 500);
  })
}

function openYomitanSettings() {
  if (yomitanSettingsWindow && !yomitanSettingsWindow.isDestroyed()) {
    yomitanSettingsWindow.show();
    yomitanSettingsWindow.focus();
    return;
  }
  yomitanSettingsWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    icon: getOverlayAppIconPath(),
    webPreferences: {
      preload: FIND_IN_PAGE_PRELOAD_PATH,
      nodeIntegration: false
    }
  });
  enableFindInPage(yomitanSettingsWindow);

  yomitanSettingsWindow.webContents.on('context-menu', () => {
    if (isDev) {
      yomitanSettingsWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  yomitanSettingsWindow.removeMenu()
  yomitanSettingsWindow.loadURL(`chrome-extension://${yomitanExt.id}/settings.html`);
  yomitanSettingsWindow.show();
  // Force a repaint to fix blank/transparent window issue
  setTimeout(() => {
    yomitanSettingsWindow.setSize(yomitanSettingsWindow.getSize()[0], yomitanSettingsWindow.getSize()[1]);
    yomitanSettingsWindow.webContents.invalidate(); // Electron 21+ supports this
    yomitanSettingsWindow.show();
  }, 500);
}

function openJitenReaderSettings() {
  if (jitenReaderSettingsWindow && !jitenReaderSettingsWindow.isDestroyed()) {
    jitenReaderSettingsWindow.show();
    jitenReaderSettingsWindow.focus();
    return;
  }
  if (!jitenReaderExt) {
    console.error("Jiten Reader extension not loaded");
    dialog.showErrorBox('Error', 'Jiten Reader extension is not loaded. Please ensure it is enabled in settings and wait a moment.');
    return;
  }
  jitenReaderSettingsWindow = new BrowserWindow({
    width: 1100,
    height: 600,
    icon: getOverlayAppIconPath(),
    webPreferences: {
      nodeIntegration: false
    }
  });

  jitenReaderSettingsWindow.removeMenu()
  jitenReaderSettingsWindow.loadURL(`chrome-extension://${jitenReaderExt.id}/views/settings.html`);
  // Allow search ctrl F in the settings window
  jitenReaderSettingsWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key.toLowerCase() === 'f' && input.control) {
      jitenReaderSettingsWindow.webContents.send('focus-search');
      event.preventDefault();
    }
  });
  jitenReaderSettingsWindow.show();
  // Force a repaint to fix blank/transparent window issue
  setTimeout(() => {
    jitenReaderSettingsWindow.setSize(jitenReaderSettingsWindow.getSize()[0], jitenReaderSettingsWindow.getSize()[1]);
    jitenReaderSettingsWindow.webContents.invalidate(); // Electron 21+ supports this
    jitenReaderSettingsWindow.show();
  }, 500);
}

function parseOffsetHelperTextData(rawData) {
  if (rawData === null || rawData === undefined || rawData === "") {
    return null;
  }

  if (typeof rawData !== "string") {
    return rawData;
  }

  try {
    return JSON.parse(rawData);
  } catch (e) {
    return { sentence: rawData };
  }
}

function sendOffsetHelperData(windowBounds = null) {
  if (!offsetHelperWindow || offsetHelperWindow.isDestroyed()) {
    return;
  }

  const bounds = windowBounds || offsetHelperWindow.getBounds();
  const safeBounds = {
    width: Number(bounds?.width) || 0,
    height: Number(bounds?.height) || 0,
  };

  try {
    offsetHelperWindow.webContents.send("text-data", {
      textData: parseOffsetHelperTextData(lastWebsocketData),
      settings: {
        offsetX: userSettings.offsetX || 0,
        offsetY: userSettings.offsetY || 0,
        fontSize: userSettings.fontSize || 42,
      },
      windowBounds: safeBounds,
      receivedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[OffsetHelper] Failed to send helper data:", e);
  }
}

function openOffsetHelper() {
  if (offsetHelperWindow && !offsetHelperWindow.isDestroyed()) {
    ensureMainWindowIsOnConnectedDisplay("openOffsetHelper-existing");
    syncOverlayWindowsToCurrentMonitor("openOffsetHelper-existing", { includeMain: false, includeTexthooker: false, includeOffsetHelper: true });
    sendOffsetHelperData();
    offsetHelperWindow.show();
    offsetHelperWindow.focus();
    return;
  }
  // Use the same bounds as the main window
  const display = getCurrentOverlayMonitor({ logFallback: true });
  const overlayBounds = getOverlayBoundsForDisplay(display);
  offsetHelperWindow = new BrowserWindow({
    x: overlayBounds.x,
    y: overlayBounds.y,
    width: overlayBounds.width,
    height: overlayBounds.height,
    icon: getOverlayAppIconPath(),
    transparent: true,
    frame: false,
    ...getWindowsFramelessWindowOptions(),
    alwaysOnTop: true,
    resizable: false,
    titleBarStyle: 'hidden',
    title: "Offset Helper",
    fullscreen: false,
    skipTaskbar: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  offsetHelperWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  offsetHelperWindow.setAlwaysOnTop(true, "screen-saver");
  if (typeof offsetHelperWindow.moveTop === "function") {
    try {
      offsetHelperWindow.moveTop();
    } catch (e) {
      console.warn("[OffsetHelper] Failed to move window to top:", e);
    }
  }

  console.log(display.bounds);
  console.log(offsetHelperWindow.getBounds());

  loadOverlayPage(offsetHelperWindow, "offset-helper.html");

  offsetHelperWindow.webContents.on('did-finish-load', () => {
    sendOffsetHelperData({ width: overlayBounds.width, height: overlayBounds.height });
  });

  offsetHelperWindow.on("show", () => {
    try {
      offsetHelperWindow.setAlwaysOnTop(true, "screen-saver");
      offsetHelperWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (e) {
      console.warn("[OffsetHelper] Failed to reassert topmost state:", e);
    }
  });

  offsetHelperWindow.on("closed", () => {
    offsetHelperWindow = null;
  });
}

function createTray() {
  const iconPath = getOverlayTrayIconPath();
  const trayIcon = nativeImage.createFromPath(iconPath);

  tray = new Tray(trayIcon);
  tray.setToolTip('GSM Overlay');

  updateTrayMenu();

  tray.on('click', () => {
    openSettings();
  });

  // Double-click to toggle main window
  tray.on('double-click', () => {
    if (mainWindow) {
      ensureMainWindowIsOnConnectedDisplay("tray-double-click");
      mainWindow.webContents.send('toggle-main-box');
    }
  });
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Toggle Window (Alt+Shift+H)',
      click: () => {
        if (mainWindow) {
          ensureMainWindowIsOnConnectedDisplay("tray-toggle-window");
          mainWindow.webContents.send('toggle-main-box');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => openSettings()
    },
    {
      label: 'Yomitan Settings',
      click: () => openYomitanSettings()
    },
    {
      label: 'Jiten Reader Settings',
      click: () => openJitenReaderSettings()
    },
    { type: 'separator' },
    {
      label: 'Manual Mode',
      type: 'checkbox',
      checked: isManualMode(),
      click: (menuItem) => {
        userSettings.manualMode = menuItem.checked;
        clearManualActivationState("tray:manualMode");
        requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
        restoreAutomaticOverlayPassThrough("tray:manualMode");

        registerManualShowHotkey();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("settings-updated", { manualMode: menuItem.checked });
        }
        saveSettings();
        updateTrayMenu();
      }
    },
    {
      label: 'Show Furigana',
      type: 'checkbox',
      checked: userSettings.showFurigana,
      click: (menuItem) => {
        userSettings.showFurigana = menuItem.checked;
        syncGamepadServerState("tray:showFurigana");
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("settings-updated", { showFurigana: menuItem.checked });
        }
        saveSettings();
        updateTrayMenu();
      }
    },
    {
      label: 'Show Text Indicators',
      type: 'checkbox',
      checked: userSettings.showTextIndicators !== false,
      click: (menuItem) => {
        userSettings.showTextIndicators = menuItem.checked;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("settings-updated", { showTextIndicators: menuItem.checked });
        }
        saveSettings();
        updateTrayMenu();
      }
    },
    {
      label: 'Fade Text Indicators',
      type: 'checkbox',
      checked: userSettings.fadeTextIndicators === true,
      enabled: userSettings.showTextIndicators !== false,
      click: (menuItem) => {
        userSettings.fadeTextIndicators = menuItem.checked;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("settings-updated", { fadeTextIndicators: menuItem.checked });
        }
        saveSettings();
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}



app.whenReady().then(async () => {
  if (isMac() && app.dock) {
    app.dock.setIcon(getOverlayAppIconPath());
  }

  if (!isWindows()) {
    userSettings.manualMode = true; // enforce manual mode on non-Windows platforms
    // Show a warning for now saying that automatic mode is not supported, and to show the overlay manually, use the hotkey
    // Use electron dialog to show a message box
    const manualModeNote = isLinux()
      ? 'Note: Hold mode can feel a bit weird on Linux; toggle is recommended.'
      : '';
    dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['OK'],
      defaultId: 0,
      title: 'GSM Overlay - Manual Mode Enforced',
      message: 'Overlay requires hotkey to show text for lookups on macOS and Linux due to platform limitations.\n\n' +
        'Use the configured hotkey: ' + userSettings.showHotkey + ' to show/hide the overlay as needed.' +
        (manualModeNote ? '\n\n' + manualModeNote : ''),
    });
  }

  // ===========================================================
  // MANIFEST SWITCHING & MIGRATION LOGIC
  // ===========================================================

  isDev = !app.isPackaged;
  const extDir = isDev ? path.join(__dirname, 'yomitan') : path.join(process.resourcesPath, "yomitan");

  // 1. Define Paths
  // 'manifest.json' is what Electron reads.
  // 'manifest_static.json' is the version WITH the key (must be present in folder).
  // 'manifest_no_key.json' is implied as the default state of manifest.json in repo.
  const activeManifestPath = path.join(extDir, 'manifest.json');
  const staticManifestPath = path.join(extDir, 'manifest_static.json');

  const markerPath = path.join(dataPath, 'migration_complete.json');
  const userSettingsExists = fs.existsSync(settingsPath);
  const isMigrated = fs.existsSync(markerPath);
  const skipMigrationConfirmationInLinux = true;

  // DO LINUX FIRST, and then windows later if we need it...
  if (isLinux()) {
    if (skipMigrationConfirmationInLinux) {
      try {
        if (!fs.existsSync(staticManifestPath)) {
          console.error("manifest_static.json not found. Skipping migration logic.");
        } else {
          console.log("[Init] Linux detected. Auto-migrating to static manifest.");
          fs.copyFileSync(staticManifestPath, activeManifestPath);
          // Create marker file if not exists
          if (!fs.existsSync(markerPath)) {
            fs.writeFileSync(markerPath, JSON.stringify({ status: "migrated", date: Date.now() }));
          }
        }
      } catch (err) {
        console.error("[Init] Error during Linux manifest swapping logic:", err);
      }
    } else {

      try {
        if (!fs.existsSync(staticManifestPath)) {
          console.error("manifest_static.json not found. Skipping migration logic.");
        } else {

          // SCENARIO A: Fresh Install
          // If settings.json does NOT exist, this is a new user. 
          // Put them on the Static ID immediately. No questions asked.
          if (!userSettingsExists) {
            console.log("[Init] Fresh install detected. Applying static manifest.");
            fs.copyFileSync(staticManifestPath, activeManifestPath);
            // Create marker so we know they are "Done"
            fs.writeFileSync(markerPath, JSON.stringify({ status: "fresh_install", date: Date.now() }));
          }

          // SCENARIO B: Existing User, Not Migrated
          else if ((userSettingsExists && !isMigrated)) {
            console.log("[Init] Existing user detected. Migration required.");

            // Keep the confirmation flow for non-Linux platforms if this logic is expanded later,
            // but skip it on Linux to auto-migrate to the keyed extension.
            const shouldPromptForMigration = !isLinux();

            if (shouldPromptForMigration) {
              let detail = 'To prevent data loss in future updates, we need to standardize the Yomitan Extension ID.\n\n';
              if (isLinux()) {
                detail += 'This is especially important in Linux since the AppImage seems to regenerate the ID on each update.\n\n';
              }
              detail += '• Load Old: Loads the old temporary ID. Choose this to Export your Settings and Dictionaries now.\n' +
                '• Ready to Migrate: Choose this ONLY if you have backed up your data. This will reset Yomitan to a fresh state with the permanent ID.\n\n' +
                'This is a one-time process.';

              const response = dialog.showMessageBoxSync({
                type: 'warning',
                buttons: ['Load Old (Backup Data)', 'Ready to Migrate'],
                defaultId: 0,
                cancelId: 0,
                title: 'IMPORTANT: Yomitan Update - Action Required',
                message: 'Internal ID Migration Required',
                detail: detail
              });

              if (response === 0) {
                // USER CHOSE: LOAD OLD (Backup Data)
                // Ensure we are running the manifest WITHOUT the key.
                // In your repo, manifest.json usually has no key. 
                // If for some reason it has a key (leftover), we assume the user handles it or 
                // we could restore a no-key version if we had a backup. 
                // For now, assuming manifest.json IS the old version default.
                console.log("[Init] User chose to load old version.");
                // Proceed to load extension normally below...
              } else {
                // USER CHOSE: READY TO MIGRATE
                console.log("[Init] User ready to migrate. Swapping manifest.");

                // 1. Overwrite active manifest with the Static Key version
                fs.copyFileSync(staticManifestPath, activeManifestPath);

                // 2. Create Marker File
                fs.writeFileSync(markerPath, JSON.stringify({ status: "migrated", date: Date.now() }));

                // 3. Relaunch to ensure Electron loads the new Manifest ID cleanly
                app.relaunch();
                app.exit(0);
                return; // Halt execution
              }
            } else {
              console.log("[Init] Linux detected. Auto-migrating without confirmation.");

              // 1. Overwrite active manifest with the Static Key version
              fs.copyFileSync(staticManifestPath, activeManifestPath);

              // 2. Create Marker File
              fs.writeFileSync(markerPath, JSON.stringify({ status: "migrated", date: Date.now() }));

              // 3. Relaunch to ensure Electron loads the new Manifest ID cleanly
              app.relaunch();
              app.exit(0);
              return; // Halt execution
            }
          }

          // SCENARIO C: Already Migrated
          else if (isMigrated) {
            // Ensure the manifest is still the Static one. 
            // (e.g. if user updated the app and a new default manifest.json overwrote the static one)
            // We compare content or just blindly overwrite to be safe.
            console.log("[Init] Migration marker found. Enforcing static manifest.");
            fs.copyFileSync(staticManifestPath, activeManifestPath);
          }
        }
      } catch (err) {
        console.error("[Init] Error during manifest swapping logic:", err);
      }
    }
  }

  // ===========================================================
  // END MIGRATION LOGIC
  // ===========================================================


  // Start background manager and register periodic tasks
  bg.start();

  yomitanExt = await loadExtension('yomitan');
  if (userSettings.enableJitenReader) {
    jitenReaderExt = await loadExtension('jiten.reader');
  }

  // If migration marker exists, update it with the actual ID for debugging
  if (fs.existsSync(markerPath)) {
    const markerData = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    if (!markerData.id && yomitanExt) {
      markerData.id = yomitanExt.id;
      fs.writeFileSync(markerPath, JSON.stringify(markerData));
    }
  }

  // Create system tray icon
  createTray();

  // Register toggle window hotkey
  function registerToggleWindowHotkey(oldHotkey) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.toggleWindowHotkey);
    globalShortcut.register(userSettings.toggleWindowHotkey || "Alt+Shift+H", () => {
      if (mainWindow) {
        ensureMainWindowIsOnConnectedDisplay("hotkey-toggle-window");
        mainWindow.webContents.send('toggle-main-box');
      }
    });
  }
  registerToggleWindowHotkey();

  // Register minimize hotkey
  function registerMinimizeHotkey(oldHotkey) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.minimizeHotkey);
    globalShortcut.register(userSettings.minimizeHotkey || "Alt+Shift+J", () => {
      if (mainWindow) {
        resetActivityTimer();
        if (afkHidden) {
          try {
            mainWindow.webContents.send('afk-hide', false);
          } catch (e) {
            console.warn('Failed to send afk-hide (restore) to renderer:', e);
          }
          afkHidden = false;
        }
        else if (mainWindow.isMinimized()) {
          ensureMainWindowIsOnConnectedDisplay("hotkey-minimize-restore");
          mainWindow.showInactive();
        }
        else mainWindow.minimize();
      }
    });
  }
  registerMinimizeHotkey();

  // Register yomitan settings hotkey
  function registerYomitanSettingsHotkey(oldHotkey) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.yomitanSettingsHotkey);
    globalShortcut.register(userSettings.yomitanSettingsHotkey || "Alt+Shift+Y", () => {
      openYomitanSettings();
    });
  }
  registerYomitanSettingsHotkey();

  // Register overlay settings hotkey
  function registerOverlaySettingsHotkey(oldHotkey) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.overlaySettingsHotkey);
    globalShortcut.register(userSettings.overlaySettingsHotkey || "Alt+Shift+S", () => {
      openSettings();
    });
  }
  registerOverlaySettingsHotkey();

  // Register translate hotkey
  function registerTranslateHotkey(oldHotkey) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.translateHotkey);
    globalShortcut.register(userSettings.translateHotkey || "Alt+T", () => {
      console.log("Translate hotkey pressed");

      // If translation has been requested, just toggle visibility
      if (translationRequested) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('toggle-translation-visibility');
        }
      } else {
        // First press - request translation from backend
        if (backend && backend.connected) {
          backend.send({ type: "translate-request" });
          translationRequested = true;
        } else {
          console.error("Backend not connected. Cannot translate.");
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('translation-error', 'Backend not connected');
          }
        }
      }
    });
  }
  registerTranslateHotkey();

  // Register toggle furigana hotkey
  function registerToggleFuriganaHotkey(oldHotkey) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.toggleFuriganaHotkey);
    globalShortcut.register(userSettings.toggleFuriganaHotkey || "Alt+F", () => {
      if (mainWindow) {
        mainWindow.webContents.send("toggle-furigana-visibility");
      }
    });
  }
  registerToggleFuriganaHotkey();
  
  function registerGamepadKeyboardHotkey(oldHotkey) {
    const keysToUnregister = new Set([
      oldHotkey,
      registeredGamepadKeyboardHotkey,
      userSettings.gamepadKeyboardHotkey,
    ]);

    for (const key of keysToUnregister) {
      if (!key) continue;
      try {
        globalShortcut.unregister(key);
      } catch (e) {
        console.warn(`[Gamepad] Failed to unregister keyboard hotkey ${key}:`, e);
      }
    }

    registeredGamepadKeyboardHotkey = null;

    if (!userSettings.gamepadEnabled || !userSettings.gamepadKeyboardEnabled) {
      console.log('[Gamepad] Keyboard navigation hotkey disabled');
      return;
    }

    const requestedHotkey = (userSettings.gamepadKeyboardHotkey || '').trim();
    if (!requestedHotkey) {
      console.log('[Gamepad] Keyboard navigation hotkey empty; skipping registration');
      return;
    }

    const registerAndReport = (hotkey) => {
      const ret = globalShortcut.register(hotkey, () => {
        requestGamepadNavigationToggleFromMain(`keyboard:${hotkey}`);
      });
      if (ret) {
        registeredGamepadKeyboardHotkey = hotkey;
        console.log(`[Gamepad] Keyboard hotkey registered: ${hotkey}`);
      }
      return ret;
    };

    if (!registerAndReport(requestedHotkey)) {
      console.log(`[Gamepad] Keyboard hotkey registration failed for ${requestedHotkey}`);
      if (requestedHotkey !== "Alt+G" && registerAndReport("Alt+G")) {
        userSettings.gamepadKeyboardHotkey = "Alt+G";
        saveSettings();
        console.log('[Gamepad] Fell back to default keyboard hotkey Alt+G');
      }
    }
  }
  registerGamepadKeyboardHotkey();

  createTexthookerWindow();
  registerTexthookerHotkey();
  registerManualShowHotkey();

  // Initialize backend connector
  backend = new BackendConnector(ipcMain, () => mainWindow);
  backend.connect(userSettings.weburl2);

  // Start gamepad server (Rust process) if enabled
  void startGamepadServer("app-whenReady");

  app.on('will-quit', () => {
    releaseAllOverlayPauseRequests();
    globalShortcut.unregisterAll();
    stopOverlayWebSockets();
    void stopGamepadServer("app-will-quit");
    if (pendingDisplaySyncTimer) {
      clearTimeout(pendingDisplaySyncTimer);
      pendingDisplaySyncTimer = null;
    }
  });

  let display = getCurrentOverlayMonitor({ logFallback: true });
  let displayBounds = getOverlayBoundsForDisplay(display);

  console.log(display);

  console.log("Display:", display);

  mainWindow = new BrowserWindow({
    x: displayBounds.x,
    y: displayBounds.y,
    width: displayBounds.width,
    height: displayBounds.height,
    icon: getOverlayAppIconPath(),
    transparent: true,
    frame: false,
    ...getWindowsFramelessWindowOptions(),
    alwaysOnTop: true,
    resizable: false,
    titleBarStyle: 'hidden',
    title: "GSM Overlay",
    fullscreen: false,
    focusable: true,
    // skipTaskbar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      allowRunningInsecureContent: true,
      allowFileAccess: true,
      allowFileAccessFromFileURLs: true,
      backgroundThrottling: false, // Required for gamepad polling when unfocused
    },
    // show: false,
  });
  lastDisplaySyncSignature = getOverlayDisplaySyncSignature();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const child = new BrowserWindow({
      parent: mainWindow ? mainWindow : undefined,
      show: true,
      width: 1200,
      height: 980,
      icon: getOverlayAppIconPath(),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        devTools: true,
        nodeIntegrationInSubFrames: true,
        backgroundThrottling: false,
      },
    });
    child.setMenu(null);
    child.loadURL(url);
    return { action: 'deny' };
  });

  // Set bounds again to fix potential issue with wrong size on start
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const syncResult = syncOverlayWindowsToCurrentMonitor("startup-resync", { forceSendDisplayInfo: true });
      display = syncResult.display;
      displayBounds = syncResult.bounds;
      lastDisplaySyncSignature = getOverlayDisplaySyncSignature();
    }
  }, 100);

  const onDisplayChanged = (changeType, changedDisplay, changedMetrics) => {
    const changedDisplayId = changedDisplay && changedDisplay.id ? changedDisplay.id : "unknown";
    const metricsSuffix = Array.isArray(changedMetrics) && changedMetrics.length > 0
      ? `:${changedMetrics.join(",")}`
      : "";
    scheduleOverlayDisplaySync(`electron-${changeType}:${changedDisplayId}${metricsSuffix}`);
  };

  screen.on("display-added", (_event, newDisplay) => {
    onDisplayChanged("display-added", newDisplay);
  });

  screen.on("display-removed", (_event, oldDisplay) => {
    onDisplayChanged("display-removed", oldDisplay);
  });

  screen.on("display-metrics-changed", (_event, changedDisplay, changedMetrics) => {
    onDisplayChanged("display-metrics-changed", changedDisplay, changedMetrics);
  });

  // Fallback polling for monitor topology + config monitor index changes.
  bg.registerTask(() => {
    try {
      const currentSignature = getOverlayDisplaySyncSignature();
      const offscreen = mainWindow && !mainWindow.isDestroyed() && !isWindowVisibleOnAnyDisplay(mainWindow);
      if (currentSignature !== lastDisplaySyncSignature || offscreen) {
        lastDisplaySyncSignature = currentSignature;
        scheduleOverlayDisplaySync(offscreen ? "background-offscreen-recovery" : "background-display-change");
      }
    } catch (e) {
      console.error('[DisplaySync] Background monitor check failed', e);
    }
  }, 500);

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, "screen-saver");

  let currentShape = {
    x: 0,
    y: 0,
    width: displayBounds.width,
    height: displayBounds.height
  };

  ipcMain.on('update-window-shape', (event, shape) => {
    // if (process.platform !== 'win32') {
    //   currentShape = shape;
    //   // update clickable area on Linux
    //   mainWindow.setShape([shape]);
    // }
  });

  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    // console.log("set-ignore-mouse-events", ignore, options, resizeMode, yomitanShown);
    const forceMagpieRelease = !!(options && options.forceMagpieRelease);
    if (forceMagpieRelease && ignore && isYomitanStateLikelyStale()) {
      console.warn(`[MagpieCompat] Clearing stale Yomitan state before mouse release (age=${Date.now() - lastYomitanEventAt}ms)`);
      yomitanShown = false;
      yomitanRecoveryVersion += 1;
    }

    if (!resizeMode && (!yomitanShown || (forceMagpieRelease && ignore))) {
      // if ignore is false a button or element on the Overlay was clicked and we do not want to click-through
      if (!isWindows() && !isMac()) {
        // On Linux, forwarding mouse click-through is currently unsupported
        // https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#click-through-windows

        if (ignore) return; // do nothing (click-through window)
      } else {
        mainWindow.setIgnoreMouseEvents(ignore, options);
      }

      if (ignore) {
        // win.blur();
      }
    }
  });

  ipcMain.on("hide", (event, state) => {
    mainWindow.minimize();
  });

  ipcMain.on("show", (event, state) => {
    ensureMainWindowIsOnConnectedDisplay("ipc-show");
    syncOverlayWindowsToCurrentMonitor("ipc-show");
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  });

  ipcMain.on("resize-mode", (event, state) => {
    resizeMode = state;
  })


  ipcMain.on("yomitan-event", (event, state) => {
    // Reset the activity timer on yomitan interaction
    resetActivityTimer();

    // Invalidate pending close-recovery attempts whenever popup state flips.
    yomitanRecoveryVersion += 1;
    lastYomitanEventAt = Date.now();
    yomitanShown = state;
    if (state) {
      if (userSettings.focusOverlayOnYomitanLookup) {
        focusOverlayForYomitanLookup();
      } else {
        yomitanForegroundActive = false;
        if (isWindows() || isMac()) {
          mainWindow.setIgnoreMouseEvents(false, { forward: true });
        }
      }
    } else {
      if (yomitanForegroundActive || userSettings.focusOverlayOnYomitanLookup) {
        restoreOverlayAfterYomitanLookup();
        return;
      }

      // Preserve pre-regression manual behavior: closing Yomitan should not change
      // overlay visibility/focus state while manual hold/toggle is active.
      if (manualHotkeyPressed || manualModeToggleState) {
        return;
      }

      if (isWindows() || isMac()) {
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
      }

      // Keep existing gamepad-close behavior unchanged.
      if (gamepadNavigationActive) {
        return;
      }

      if (!isWindows() && !isMac()) {
        hideAndRestoreFocus();
      }
      // win.setAlwaysOnTop(true, 'screen-saver');
      if (!resizeMode && mainWindow.isFocused()) {
        blurAndRestoreFocus();
      }
      // Magpie can race z-order after popup close; reassert top layer without extra focus handoff.
      if (currentMagpieActive) {
        scheduleYomitanCloseRecovery();
      }
    }
  })

  ipcMain.on('release-mouse', () => {
    blurAndRestoreFocus();
    setTimeout(() => mainWindow.focus(), 50);
  });


  // Fix for ghost title bar
  // https://github.com/electron/electron/issues/39959#issuecomment-1758736966
  mainWindow.on('blur', () => {
    mainWindow.setBackgroundColor('#00000000')
  })

  mainWindow.on('focus', () => {
    mainWindow.setBackgroundColor('#00000000')
  })

  // Update tray menu when window visibility changes
  mainWindow.on('show', () => {
    updateTrayMenu();
  });

  mainWindow.on('hide', () => {
    updateTrayMenu();
  });

  mainWindow.on('minimize', () => {
    updateTrayMenu();
  });

  mainWindow.on('restore', () => {
    updateTrayMenu();
  });

  loadOverlayPage(mainWindow, 'index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    startOverlayWebSockets();
  });
  if (isDev) {
    mainWindow.webContents.on('context-menu', () => {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
    // openSettings();
  }
  mainWindow.once('ready-to-show', () => {
    const syncResult = syncOverlayWindowsToCurrentMonitor("ready-to-show", { forceSendDisplayInfo: true });
    display = syncResult.display;
    displayBounds = syncResult.bounds;
    lastDisplaySyncSignature = getOverlayDisplaySyncSignature();
    ensureMainWindowIsOnConnectedDisplay("ready-to-show");
    mainWindow.show();
    if (isDev) {
      // mainWindow.openDevTools({ mode: 'detach' });
    }
    mainWindow.webContents.send("load-settings", userSettings);
    mainWindow.webContents.send("display-info", buildOverlayDisplayInfo(display));
    mainWindow.webContents.send("gamepad-input-test-active", { active: gamepadInputTestActive });
    mainWindow.setAlwaysOnTop(true, 'screen-saver');

    if (isWindows() || isMac()) {
      // Windows and macOS - use setIgnoreMouseEvents
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      hideAndRestoreFocus();
    }

    // Start the activity timer
    if (userSettings.openSettingsOnStartup) {
      openSettings();
    }
    resetActivityTimer();
  });

  ipcMain.on("app-close", () => {
    app.quit();
  });

  ipcMain.on("app-minimize", () => {
    mainWindow.minimize();
  });

  ipcMain.on("open-yomitan-settings", () => {
    openYomitanSettings();
  });

  ipcMain.on("open-jiten-reader-settings", () => {
    openJitenReaderSettings();
  });

  // Action panel button handlers
  ipcMain.on("action-scan", () => {
    console.log("Action: Scan requested from overlay");
    requestManualOverlayScan("overlay-action-panel");
  });

  ipcMain.on("action-translate", () => {
    console.log("Action: Translate requested from overlay");
    if (backend && backend.connected) {
      translationRequested = true;
      backend.send({ type: "translate-request" });
    } else {
      console.error("Backend not connected. Cannot translate.");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('translation-error', 'Backend not connected');
      }
    }
  });

  ipcMain.on("action-tts", () => {
    console.log("Action: TTS requested from overlay");
    // TODO: Implement TTS functionality
  });

  ipcMain.on("window-state-changed", (event, { state, game, magpieActive, isFullscreen, recommendManualMode }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (isTexthookerMode) return;

    // Update the tracked magpie state
    currentMagpieActive = magpieActive || false;

    console.log(`Window state changed to: ${state} for game: ${game}, magpie active: ${currentMagpieActive}, fullscreen: ${isFullscreen}`);

    // Send game state to renderer to control action panel visibility
    mainWindow.webContents.send("game-state", state);

    // Forward fullscreen recommendation to renderer if applicable
    // if (recommendManualMode && !isManualMode()) {
    //   console.log("Fullscreen detected - recommending manual mode");
    //   mainWindow.webContents.send("recommend-manual-mode", { game });
    // }

    switch (state) {
      case "active":
        if (isManualMode()) {
          return; // Do nothing in manual mode
        }
        ensureMainWindowIsOnConnectedDisplay("window-state-active");
        console.log("[WindowState] Active - Game has focus");
        // Game window is active/focused - show overlay normally
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
          blurAndRestoreFocus();
          afkHidden = false;
        } else if (!mainWindow.isVisible()) {
          // Window was hidden (e.g., by obscured state) - restore it
          mainWindow.show();
          blurAndRestoreFocus();
          mainWindow.setAlwaysOnTop(true, 'screen-saver');
        } else if (magpieActive) {
          reassertOverlayTopmostWithoutFocus("window-state-active-magpie");
        }
        break;

      case "background":
        // Do nothing - let overlay maintain current state when game loses focus
        console.log("[WindowState] Background - Game visible but not focused (no action)");
        break;

      case "obscured":
        if (isManualMode()) {
          return; // Do nothing in manual mode
        }
        console.log("[WindowState] Obscured - Game completely covered by other windows");
        // Game window is completely hidden by other windows - hide overlay
        if (!yomitanShown && !resizeMode && !mainWindow.isMinimized()) {
          mainWindow.hide();
        }
        break;

      case "minimized":
        console.log("[WindowState] Minimized - Game window minimized");
        // Avoid minimizing the topmost frameless overlay window here; on Windows
        // that can surface/focus the overlay while the game is being minimized.
        // Hiding keeps it out of the way, and the "active" path restores it.
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        }
        break;

      case "closed":
        // Game window is closed - hide overlay
        mainWindow.hide();
        break;

      case "unknown":
        // Unknown state - don't change anything
        console.log("Unknown window state, no action taken");
        break;

      default:
        console.warn(`Unhandled window state: ${state}`);
    }
  });

  ipcMain.on("open-settings", () => {
    openSettings();
  });
  ipcMain.on("gamepad-input-test-active", (event, payload) => {
    gamepadInputTestActive = !!(payload && payload.active);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gamepad-input-test-active", { active: gamepadInputTestActive });
    }
  });
  ipcMain.on("open-offset-helper", () => {
    openOffsetHelper();
  });

  ipcMain.on(FIND_IN_PAGE_COMMAND_CHANNEL, (event, payload = {}) => {
    const contents = event.sender;
    const state = getFindInPageState(contents);

    switch (payload.action) {
      case 'search':
        performFindInPage(contents, payload);
        break;
      case 'clear':
        clearFindInPage(contents);
        break;
      case 'visibility':
        state.visible = !!payload.visible;
        break;
      default:
        break;
    }
  });

  ipcMain.on("save-offset", (event, { offsetX, offsetY }) => {
    userSettings.offsetX = offsetX;
    userSettings.offsetY = offsetY;
    saveSettings();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("settings-updated", { offsetX, offsetY });
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("update-offset-values", { offsetX, offsetY });
      settingsWindow.show();
      settingsWindow.focus();
    } else {
      openSettings();
    }
  });

  ipcMain.on("setting-changed", (event, { key, value }) => {
    const sanitizedLogValue = (key === "gamepadJitenApiKey" || key === "gamepadJpdbApiKey") ? "***" : value;
    console.log(`Setting changed: ${key} = ${sanitizedLogValue}`);
    const enforcedTransportUrls = getEnforcedOverlayTransportUrls();
    if (key === "weburl1") {
      value = enforcedTransportUrls.weburl1;
    } else if (key === "weburl2") {
      value = enforcedTransportUrls.weburl2;
    } else if (key === "texthookerUrl") {
      value = enforcedTransportUrls.texthookerUrl;
    } else if (key === "showTextBackground") {
      // Legacy key mapping for older settings UIs.
      const indicatorEnabled = !!value;
      userSettings.showTextIndicators = indicatorEnabled;
      userSettings.fadeTextIndicators = indicatorEnabled;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("settings-updated", {
          showTextIndicators: indicatorEnabled,
          fadeTextIndicators: indicatorEnabled,
        });
      }
      saveSettings();
      updateTrayMenu();
      return;
    }
    if (key === "gamepadTokenizerBackend") {
      value = normalizeGamepadTokenizerBackend(value);
    } else if (key === "gamepadSudachiDictionary") {
      value = normalizeGamepadSudachiDictionary(value);
    } else if (key === "gamepadYomitanApiUrl") {
      value = normalizeGamepadYomitanApiUrl(value);
    } else if (key === "gamepadYomitanScanLength") {
      value = normalizeGamepadYomitanScanLength(value);
    } else if (key === "gamepadJitenApiKey") {
      value = normalizeGamepadJitenApiKey(value);
    } else if (key === "gamepadJpdbApiKey") {
      value = normalizeGamepadJpdbApiKey(value);
    } else if (key === "furiganaScale") {
      value = normalizeFuriganaScale(value);
    } else if (key === "furiganaYOffset") {
      value = normalizeFuriganaYOffset(value);
    } else if (key === "furiganaColor") {
      value = normalizeFuriganaColor(value, "#ffffff");
    } else if (key === "furiganaFontFamily") {
      value = normalizeFuriganaFontFamily(value);
    } else if (key === "furiganaFontWeight") {
      value = normalizeFuriganaFontWeight(value);
    } else if (key === "furiganaOutlineColor") {
      value = normalizeFuriganaColor(value, "#222222");
    } else if (key === "furiganaOutlineWidth") {
      value = normalizeFuriganaOutlineWidth(value);
    }
    const oldValue = userSettings[key];
    userSettings[key] = value;
    switch (key) {
      case "showHotkey":
        {
          const resolved = ensureManualAndTexthookerHotkeysDistinct("setting-changed:showHotkey");
          registerManualShowHotkey(oldValue);
          if (resolved) {
            registerTexthookerHotkey();
          }
        }
        break;
      case "manualMode":
        clearManualActivationState("setting-changed:manualMode");
        requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
        restoreAutomaticOverlayPassThrough("setting-changed:manualMode");
        registerManualShowHotkey();
        break;
      case "manualModeType":
        clearManualActivationState("setting-changed:manualModeType");
        requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
        restoreAutomaticOverlayPassThrough("setting-changed:manualModeType");
        if (isLinux() && value === "hold") {
          console.warn("[ManualHotkey] Hold mode can be unreliable on Linux (globalShortcut has no key-up and no repeat on many setups).");
        }
        registerManualShowHotkey();
        break;
      case "focusOverlayOnYomitanLookup":
        if (value && yomitanShown) {
          focusOverlayForYomitanLookup();
        } else if (!value) {
          yomitanForegroundActive = false;
        }
        break;
      case "afkTimer":
        resetActivityTimer();
        break;
      case "toggleFuriganaHotkey":
        registerToggleFuriganaHotkey(oldValue);
        break;
      case "toggleWindowHotkey":
        registerToggleWindowHotkey(oldValue);
        break;
      case "minimizeHotkey":
        registerMinimizeHotkey(oldValue);
        break;
      case "yomitanSettingsHotkey":
        registerYomitanSettingsHotkey(oldValue);
        break;
      case "overlaySettingsHotkey":
        registerOverlaySettingsHotkey(oldValue);
        break;
      case "translateHotkey":
        registerTranslateHotkey(oldValue);
        break;
      case "texthookerHotkey":
        {
          const resolved = ensureManualAndTexthookerHotkeysDistinct("setting-changed:texthookerHotkey");
          registerTexthookerHotkey(oldValue);
          if (resolved && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("settings-updated", { texthookerHotkey: userSettings.texthookerHotkey });
          }
        }
        break;
      case "texthookerUrl":
        if (texthookerWindow && !texthookerWindow.isDestroyed()) {
          waitForTexthookerUrl(texthookerWindow, value);
        }
        break;
      case "weburl1":
        connectOverlayWebSocket("ws1", value);
        break;
      case "weburl2":
        connectOverlayWebSocket("ws2", value);
        if (backend) backend.connect(value);
        break;
      case "enableJitenReader":
        if (value) {
            // Enable
            if (!jitenReaderExt) {
                loadExtension('jiten.reader').then(ext => {
                    jitenReaderExt = ext;
                    console.log("Jiten Reader enabled and loaded.");
                });
            }
        } else {
            // Disable
            if (jitenReaderExt) {
                try {
                    getExtensionSessionApi().removeExtension(jitenReaderExt.id);
                    jitenReaderExt = null;
                    console.log("Jiten Reader disabled and unloaded.");
                } catch (e) {
                    console.error("Failed to unload Jiten Reader:", e);
                }
            }
        }
        break;
      // Gamepad settings - forward to renderer for GamepadHandler to process
      case "gamepadEnabled":
        console.log(`[Gamepad] Setting changed: ${key} = ${value}`);
        if (!value) {
          stopGamepadServer();
          setGamepadNavigationModeActive(false, "settings-gamepad-disabled");
        }
        syncGamepadServerState("setting-changed:gamepadEnabled");
        registerGamepadKeyboardHotkey();
        break;
      case "gamepadServerPort":
        console.log(`[Gamepad] Setting changed: ${key} = ${value}`);
        // Restart server if port changed
        void restartGamepadServer("setting-changed:gamepadServerPort");
        break;
      case "gamepadActivationMode":
      case "gamepadModifierButton":
      case "gamepadToggleButton":
      case "gamepadConfirmButton":
      case "gamepadCancelButton":
      case "gamepadForwardEnterButton":
      case "gamepadManualOverlayScanButton":
      case "gamepadNextEntryButton":
      case "gamepadPrevEntryButton":
      case "gamepadAutoConfirmSelection":
      case "gamepadRepeatDelay":
      case "gamepadRepeatRate":
      case "gamepadControllerEnabled":
      case "gamepadTokenizerBackend":
      case "gamepadSudachiDictionary":
      case "gamepadYomitanApiUrl":
      case "gamepadYomitanScanLength":
      case "gamepadJitenApiKey":
      case "gamepadJpdbApiKey":
        // These settings are handled by the renderer's GamepadHandler
        // Just save and forward - no main process action needed
        console.log(`[Gamepad] Setting changed: ${key} = ${(key === "gamepadJitenApiKey" || key === "gamepadJpdbApiKey") ? "***" : value}`);
        if (key === "gamepadTokenizerBackend" || key === "gamepadSudachiDictionary") {
          void restartGamepadServer(`setting-changed:${key}`);
          syncGamepadServerState("setting-changed:gamepadTokenizerBackend");
        }
        break;
      case "showFurigana":
        syncGamepadServerState("setting-changed:showFurigana");
        break;
      case "gamepadKeyboardEnabled":
      case "gamepadKeyboardHotkey":
        console.log(`[Gamepad] Keyboard setting changed: ${key} = ${value}`);
        // Re-register hotkey if keyboard enabled or hotkey changed
        registerGamepadKeyboardHotkey(oldValue);
        break;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("settings-updated", { [key]: value });
    }
    saveSettings();
    updateTrayMenu();
  });

  // Legacy handlers for backward compatibility - can be removed after transition
  ipcMain.on("fontsize-changed", (event, newsize) => {
    userSettings.fontSize = newsize;
    mainWindow.webContents.send("settings-updated", { fontSize: newsize });
    saveSettings();
  })
  ipcMain.on("weburl1-changed", (event, newurl) => {
    const enforcedTransportUrls = getEnforcedOverlayTransportUrls();
    userSettings.weburl1 = enforcedTransportUrls.weburl1;
    mainWindow.webContents.send("settings-updated", { weburl1: enforcedTransportUrls.weburl1 });
    connectOverlayWebSocket("ws1", enforcedTransportUrls.weburl1);
    saveSettings();
  })
  ipcMain.on("weburl2-changed", (event, newurl) => {
    const enforcedTransportUrls = getEnforcedOverlayTransportUrls();
    userSettings.weburl2 = enforcedTransportUrls.weburl2;
    mainWindow.webContents.send("settings-updated", { weburl2: enforcedTransportUrls.weburl2 });
    connectOverlayWebSocket("ws2", enforcedTransportUrls.weburl2);
    saveSettings();
    if (backend) backend.connect(enforcedTransportUrls.weburl2);
  })
  ipcMain.on("hideonstartup-changed", (event, newValue) => {
    userSettings.hideOnStartup = newValue;
    mainWindow.webContents.send("settings-updated", { hideOnStartup: newValue });
    saveSettings();
  })
  ipcMain.on("manualmode-changed", (event, newValue) => {
    userSettings.manualMode = newValue;
    console.log("manualmode-changed", newValue);
    clearManualActivationState("legacy:manualmode-changed");
    requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
    restoreAutomaticOverlayPassThrough("legacy:manualmode-changed");

    mainWindow.webContents.send("settings-updated", { manualMode: newValue });
    saveSettings();
    registerManualShowHotkey();
  });

  ipcMain.on("showHotkey-changed", (event, newValue) => {
    let oldValue = userSettings.showHotkey;
    userSettings.showHotkey = newValue;
    const resolved = ensureManualAndTexthookerHotkeysDistinct("legacy:showHotkey-changed");
    mainWindow.webContents.send("settings-updated", { showHotkey: newValue });
    if (resolved) {
      mainWindow.webContents.send("settings-updated", { texthookerHotkey: userSettings.texthookerHotkey });
    }
    saveSettings();
    registerManualShowHotkey(oldValue);
    if (resolved) {
      registerTexthookerHotkey();
    }
  });

  ipcMain.on("pinned-changed", (event, newValue) => {
    userSettings.pinned = newValue;
    mainWindow.webContents.send("settings-updated", { pinned: newValue });
    saveSettings();
  });

  ipcMain.on("showTextBackground-changed", (event, newValue) => {
    const indicatorEnabled = !!newValue;
    userSettings.showTextIndicators = indicatorEnabled;
    userSettings.fadeTextIndicators = indicatorEnabled;
    mainWindow.webContents.send("settings-updated", {
      showTextIndicators: indicatorEnabled,
      fadeTextIndicators: indicatorEnabled,
    });
    saveSettings();
    updateTrayMenu();
  });

  ipcMain.on("config-received", (event, config) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      activeWindow = config.activeWindow || false;
    }
  });

  ipcMain.handle('get-system-info', (event) => {
    const systemInfo = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCores: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    };
    return systemInfo;
  });

  // let alwaysOnTopInterval;

  ipcMain.on("text-received", (event, text) => {
    if (isTexthookerMode) return;
    // Reset the activity timer on text received
    resetActivityTimer();
    // Reset translation state on new text
    translationRequested = false;
    // If AFK previously hid the overlay, restore it now
    if (afkHidden) {
      try {
        mainWindow.webContents.send('afk-hide', false);
      } catch (e) {
        console.warn('Failed to send afk-hide (restore) to renderer:', e);
      }
      afkHidden = false;
    }

    // === AUTO TRANSLATE (only for JSON-parsable array data) ===
    if (userSettings.autoRequestTranslation && backend && backend.connected) {
      let shouldTranslate = false;
      try {
        let parsed = typeof text === 'string' ? JSON.parse(text) : text;
        if (Array.isArray(parsed.data) && parsed.data.every(item => item.text && item.bounding_rect)) {
          shouldTranslate = true;
        }
      } catch (e) {
        // Not JSON, do not auto-translate
      }
      if (shouldTranslate) {
        translationRequested = true;
        backend.send({ type: "translate-request" });
      }
    }

    // If window is minimized, restore it
    if (mainWindow.isMinimized() && !isManualMode()) {
      reassertOverlayTopmostWithoutFocus("text-received-minimized");
    }

    // When Magpie is active, ensure overlay stays on top (Magpie can steal z-order)
    if (currentMagpieActive && !isManualMode()) {
      reassertOverlayTopmostWithoutFocus("text-received-magpie");

      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (!mainWindow.isFocused()) return;
        blurAndRestoreFocus();
      }, 120);
    }
  });

  // ==================== Gamepad IPC Handlers ====================
  // These handlers receive events from the renderer's GamepadHandler
  
  ipcMain.on("gamepad-connected", (event, gamepad) => {
    console.log(`[Gamepad] Controller connected: ${gamepad.id}`);
  });

  ipcMain.on("gamepad-disconnected", (event, index) => {
    console.log(`[Gamepad] Controller disconnected: index ${index}`);
  });

  ipcMain.on("gamepad-button", (event, data) => {
    // Receives all button press/release events from the gamepad
    // Can be used for custom button bindings or logging
    // data: { button, value, gamepad, pressed }
    if (data.pressed) {
      console.log(`[Gamepad] Button ${data.button} pressed on gamepad ${data.gamepad}`);
    }
  });

  ipcMain.on("gamepad-block-change", (event, blockIndex) => {
    // Receives block navigation events
    console.log(`[Gamepad] Navigated to block ${blockIndex}`);
  });

  ipcMain.on("gamepad-navigation-state", (event, data) => {
    const active = !!(data && data.active);
    setGamepadNavigationModeActive(active, "renderer-navigation-state");
    console.log(`[GamepadHandler] Navigation state from renderer: ${active ? "active" : "inactive"}`);
  });

  // Handler to manually toggle gamepad navigation mode (can be bound to a global hotkey)
  ipcMain.on("gamepad-toggle-navigation", () => {
    requestGamepadNavigationToggleFromMain("ipc:gamepad-toggle-navigation");
  });
  
  // Handler for gamepad requesting focus
  ipcMain.on("gamepad-request-focus", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      setGamepadNavigationModeActive(true, "renderer-request-focus");
      console.log('[GamepadHandler] Overlay window focused');
    }
  });
  
  // Handler for gamepad releasing focus
  ipcMain.on("gamepad-release-focus", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      setGamepadNavigationModeActive(false, "renderer-release-focus");
      console.log('[GamepadHandler] Overlay window focus released');
    }
  });

  ipcMain.on("gamepad-forward-enter", () => {
    if (!backend || !backend.connected) {
      console.warn("[Gamepad] Cannot forward Enter: backend is not connected");
      return;
    }

    backend.send({
      type: "send-key-request",
      key: "enter",
      source: "gamepad",
      activateWindow: true,
    });
  });

  ipcMain.on("gamepad-manual-overlay-scan", () => {
    requestManualOverlayScan("gamepad");
  });

  // Handler to manually send navigation commands (can be triggered from other sources)
  ipcMain.on("gamepad-navigate", (event, direction) => {
    if (!userSettings.gamepadEnabled) {
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gamepad-navigate", direction);
    }
  });

  app.on("before-quit", () => {
    // Clear activity timer on quit
    if (activityTimer) {
      clearTimeout(activityTimer);
    }
    // Destroy tray icon
    if (tray) {
      tray.destroy();
    }
    // clearInterval(alwaysOnTopInterval);
    saveSettings();
  });
});
