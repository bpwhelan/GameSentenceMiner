const { app, BrowserWindow, session, screen, globalShortcut, dialog, Tray, Menu, nativeImage, protocol } = require('electron');
const { ipcMain } = require("electron");
const fs = require("fs");
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const magpie = require('./magpie');
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
const ENFORCED_PLAINTEXT_WS_URL = "ws://localhost:7275/ws/plaintext";
const ENFORCED_OVERLAY_WS_URL = "ws://localhost:7275/ws/overlay";
const DEFAULT_TEXTHOOKER_URL = "http://localhost:7275/texthooker";
const LEGACY_TEXTHOOKER_URLS = new Set([
  "http://localhost:55000/texthooker",
  "http://127.0.0.1:55000/texthooker",
]);
const GAMEPAD_SERVER_BASE_PORT = 55003;
const OVERLAY_WS_RECONNECT_DELAY_MS = 1000;
let manualHotkeyPressed = false;
let manualModeToggleState = false;
let lastManualActivity = Date.now();
let activityTimer = null;
let isDev = false;
let yomitanExt;
let jitenReaderExt;
let userSettings = {
  "fontSize": 42,
  "weburl1": ENFORCED_PLAINTEXT_WS_URL,
  "weburl2": ENFORCED_OVERLAY_WS_URL,
  "hideOnStartup": false,
  "manualMode": false,
  "manualModeType": "hold", // "hold" or "toggle"
  "showHotkey": "Shift + Space",
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
  "showTextBackground": false,
  "afkTimer": 5, // in minutes
  "showFurigana": false,
  "hideFuriganaOnStartup": false,
  "hideYomitanAfterMine": false,
  "offsetX": 0,
  "offsetY": 0,
  "dismissedFullscreenRecommendations": [], // Games for which fullscreen recommendation was dismissed
  "texthookerHotkey": "Alt+Shift+W",
  "texthookerUrl": DEFAULT_TEXTHOOKER_URL,
  "enableJitenReader": true,
  // Gamepad navigation settings
  "gamepadEnabled": true,
  "gamepadActivationMode": "modifier", // "modifier" or "toggle"
  "gamepadModifierButton": 4, // LB
  "gamepadToggleButton": 8, // Back/Select
  "gamepadConfirmButton": 0, // A
  "gamepadCancelButton": 1, // B
  "gamepadShowIndicator": true,
  "gamepadRepeatDelay": 400,
  "gamepadRepeatRate": 150,
  "gamepadServerAutoStart": true, // Auto-start Python gamepad server
  "gamepadServerPort": GAMEPAD_SERVER_BASE_PORT, // Port for Python gamepad server
  "gamepadKeyboardHotkey": "Alt+G", // Keyboard hotkey to toggle gamepad mode
  "gamepadKeyboardEnabled": true, // Enable keyboard hotkey activation
  "gamepadControllerEnabled": true, // Enable controller button activation
  "gamepadTokenMode": true, // Default to character mode (false) or token mode (true)
};

function enforceOverlayWebSocketUrls(settings) {
  let changed = false;
  if (settings.weburl1 !== ENFORCED_PLAINTEXT_WS_URL) {
    settings.weburl1 = ENFORCED_PLAINTEXT_WS_URL;
    changed = true;
  }
  if (settings.weburl2 !== ENFORCED_OVERLAY_WS_URL) {
    settings.weburl2 = ENFORCED_OVERLAY_WS_URL;
    changed = true;
  }
  return changed;
}

function normalizeTexthookerUrl(settings) {
  const currentValue = (settings.texthookerUrl || "").trim();
  if (!currentValue || LEGACY_TEXTHOOKER_URLS.has(currentValue)) {
    settings.texthookerUrl = DEFAULT_TEXTHOOKER_URL;
    return true;
  }
  return false;
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
let registeredGamepadKeyboardHotkey = null;
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

function publishOverlaySocketData(type, data) {
  lastWebsocketData = data;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("overlay-websocket-data", { type, data });
  }
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

// Gamepad server management
async function startGamepadServer() {
  if (!userSettings.gamepadEnabled || !userSettings.gamepadServerAutoStart) {
    console.log('[GamepadServer] Auto-start disabled');
    return;
  }
  
  if (gamepadServerProcess || gamepadServerStarting) {
    console.log('[GamepadServer] Already running');
    return;
  }
  gamepadServerStarting = true;
  
  const { spawn } = require('child_process');
  
// Find the overlay_server.py script
  const scriptPath = isDev
    ? path.join(__dirname, 'overlay_server.py')
    : path.join(process.resourcesPath, 'overlay_server.py');
  
  if (!fs.existsSync(scriptPath)) {
    console.log('[GamepadServer] Script not found at:', scriptPath);
    gamepadServerStarting = false;
    return;
  }
  
  // Use GSM's bundled Python executable
  const gsmPythonPath = path.join(process.env.APPDATA || '', 'GameSentenceMiner', 'python_venv', 'Scripts', 'python.exe');
  
  let pythonExe = null;
  
  // First try GSM's bundled Python
  if (fs.existsSync(gsmPythonPath)) {
    pythonExe = gsmPythonPath;
    console.log('[GamepadServer] Using GSM bundled Python');
  } else {
    // Fallback to system Python
    const pythonPaths = isWindows() 
      ? ['python', 'py', 'python3', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe')]
      : ['python3', 'python'];
    
    for (const pyPath of pythonPaths) {
      try {
        const { execSync } = require('child_process');
        execSync(`${pyPath} --version`, { stdio: 'ignore' });
        pythonExe = pyPath;
        break;
      } catch (e) {
        // Try next path
      }
    }
  }
  
  if (!pythonExe) {
    console.error('[GamepadServer] Python not found. Please install Python or run GSM main app first.');
    gamepadServerStarting = false;
    return;
  }

  try {
    const selectedPort = await findAvailablePort(GAMEPAD_SERVER_BASE_PORT);
    if (userSettings.gamepadServerPort !== selectedPort) {
      userSettings.gamepadServerPort = selectedPort;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("settings-updated", { gamepadServerPort: selectedPort });
      }
      saveSettings();
    }

    console.log(`[GamepadServer] Starting with Python: ${pythonExe}`);
    console.log(`[GamepadServer] Script: ${scriptPath}`);
    console.log(`[GamepadServer] Port: ${selectedPort}`);

    gamepadServerProcess = spawn(pythonExe, [
      scriptPath,
      '--port', String(selectedPort)
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    
    gamepadServerProcess.stdout.on('data', (data) => {
      console.log(`[GamepadServer] ${data.toString().trim()}`);
    });
    
    gamepadServerProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // Filter out common "not an error" messages
      if (msg.includes('ModuleNotFoundError') || msg.includes('ImportError')) {
        console.error(`[GamepadServer] Missing dependency: ${msg}`);
        console.error('[GamepadServer] Install with: pip install inputs websockets');
      } else {
        console.error(`[GamepadServer] ${msg}`);
      }
    });
    
    gamepadServerProcess.on('close', (code) => {
      console.log(`[GamepadServer] Process exited with code ${code}`);
      gamepadServerProcess = null;
    });
    
    gamepadServerProcess.on('error', (err) => {
      console.error('[GamepadServer] Failed to start:', err);
      gamepadServerProcess = null;
    });
    
    console.log('[GamepadServer] Started successfully');
  } catch (e) {
    console.error('[GamepadServer] Error starting server:', e);
    gamepadServerProcess = null;
  } finally {
    gamepadServerStarting = false;
  }
}

function stopGamepadServer() {
  gamepadServerStarting = false;
  if (gamepadServerProcess) {
    console.log('[GamepadServer] Stopping...');
    gamepadServerProcess.kill();
    gamepadServerProcess = null;
  }
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

async function loadExtension(name) {
  const extDir = isDev ? path.join(__dirname, name) : path.join(process.resourcesPath, name);
  const extTargetDir = ensureExtensionCopy(name, extDir);
  try {
    const loadedExt = await session.defaultSession.loadExtension(extTargetDir, { allowFileAccess: true });
    console.log(`${name} extension loaded.`);
    console.log('Extension ID:', loadedExt.id);
    return loadedExt;
  } catch (e) {
    console.error(`Failed to load extension ${name}:`, e);
    return null;
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

function isManualMode() {
  if (!isWindows()) {
    return true;
  }
  return userSettings.manualMode;
}

function blurAndRestoreFocus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.blur();
    // Send message to Python backend to restore focus to target window
    if (backend && backend.connected) {
      console.log("Requesting focus restore from backend - blur");
      backend.send({
        type: 'restore-focus-request'
      });
    }
  }
}

function hideAndRestoreFocus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    // Send message to Python backend to restore focus to target window
    if (backend && backend.connected) {
      console.log("Requesting focus restore from backend - hide");
      backend.send({
        type: 'restore-focus-request'
      });
    }
  }
}

function showInactiveAndRestoreFocus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.showInactive();
    // Send message to Python backend to restore focus to target window
    if (backend && backend.connected) {
      console.log("Requesting focus restore from backend - showInactive");
      backend.send({
        type: 'restore-focus-request'
      });
    }
  }
}

function aggressivelyShowOverlayAndReturnFocus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  // Be intentionally aggressive here: Magpie can steal z-order during popup teardown.
  mainWindow.show();
  mainWindow.focus();
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
  const recoveryDelays = [0, 80, 180, 320];

  for (const delay of recoveryDelays) {
    setTimeout(() => {
      if (version !== yomitanRecoveryVersion) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (yomitanShown || resizeMode || manualHotkeyPressed || manualModeToggleState || gamepadNavigationActive) return;

      aggressivelyShowOverlayAndReturnFocus();

      // Return focus back to game shortly after forcing overlay to the top.
      setTimeout(() => {
        if (version !== yomitanRecoveryVersion) return;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (yomitanShown || resizeMode || manualHotkeyPressed || manualModeToggleState || gamepadNavigationActive) return;
        if (isWindows() || isMac()) {
          mainWindow.setIgnoreMouseEvents(true, { forward: true });
        }
        blurAndRestoreFocus();
      }, 25);
    }, delay);
  }
}

const hasPersistedOverlaySettings = fs.existsSync(settingsPath);
if (hasPersistedOverlaySettings) {
  try {
    const data = fs.readFileSync(settingsPath, "utf-8");
    oldUserSettings = JSON.parse(data)
    userSettings = { ...userSettings, ...oldUserSettings }
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
const texthookerUrlNormalized = normalizeTexthookerUrl(userSettings);
if (hasPersistedOverlaySettings && (websocketEndpointsNormalized || texthookerUrlNormalized)) {
  saveSettings();
}

const GSM_APPDATA = process.env.APPDATA
  ? path.join(process.env.APPDATA, "GameSentenceMiner") // Windows
  : path.join(os.homedir(), '.config', "GameSentenceMiner"); // macOS/Linux

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

function getCurrentOverlayMonitor() {
  const overlaySettings = getGSMOverlaySettings();
  return screen.getAllDisplays()[overlaySettings.monitor_to_capture];
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

function showOverlayUsingManualFlow(triggerSource, pauseSource = OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  console.log(`[OverlayActivation] Attempting SHOW (${triggerSource})... Current State: ${isOverlayVisible ? "Visible" : "Hidden"}`);

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
  if (fs.existsSync(settingsPath)) {
    const data = fs.readFileSync(settingsPath, "utf-8");
    oldUserSettings = JSON.parse(data);
    if (isWindows()) {
      userSettings.offsetX = 0;
      userSettings.offsetY = 0;
    } else {
      userSettings.manualMode = true;
      userSettings.magpieCompatibility = false;
    }
    console.log("Old Settings:", oldUserSettings);
    console.log("New Settings:", userSettings);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2))
}

let holdHeartbeat = null; // Store the interval ID
let lastKeyActivity = 0;  // Timestamp of last key press
let isOverlayVisible = false; // Internal tracking to prevent redundant calls

const TEXTHOOKER_CONNECTIVITY_INTERVAL_MS = 5000;
let texthookerLoadInterval = null;
let texthookerLoadInFlight = false;

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

  const display = getCurrentOverlayMonitor();

  texthookerWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height - 1,
    transparent: true,
    frame: false,
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
  if (oldHotkey) globalShortcut.unregister(oldHotkey);
  globalShortcut.unregister(userSettings.texthookerHotkey);

  globalShortcut.register(userSettings.texthookerHotkey || "Alt+Shift+Q", () => {
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
      const display = getCurrentOverlayMonitor();
      texthookerWindow.setBounds({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height - 1,
      });

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
}

function registerManualShowHotkey(oldHotkey) {
  if (!isManualMode()) {
    console.log("[ManualHotkey] Not in manual mode, skipping registration.");
    return;
  }

  // clean up old shortcut
  if (manualIn) {
    console.log(`[ManualHotkey] Unregistering old hotkey: ${oldHotkey || userSettings.showHotkey}`);
    globalShortcut.unregister(oldHotkey || userSettings.showHotkey);
  }

  console.log(`[ManualHotkey] Registering hotkey: ${userSettings.showHotkey} | Mode: ${userSettings.manualModeType}`);

  // Helper: Consolidated Show Logic
  const showOverlay = (triggerSource) => {
    showOverlayUsingManualFlow(`ManualHotkey ${triggerSource}`, OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
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
      resizable: true,
      alwaysOnTop: true,
      title: "Overlay Settings",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
    });

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
    settingsWindow.on("closed", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("force-visible", false);
      }
    })
    console.log(websocketStates)
    settingsWindow.webContents.send("preload-settings", { userSettings, websocketStates })
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
    height: 600,
    webPreferences: {
      nodeIntegration: false
    }
  });

  yomitanSettingsWindow.removeMenu()
  yomitanSettingsWindow.loadURL(`chrome-extension://${yomitanExt.id}/settings.html`);
  // Allow search ctrl F in the settings window
  yomitanSettingsWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key.toLowerCase() === 'f' && input.control) {
      yomitanSettingsWindow.webContents.send('focus-search');
      event.preventDefault();
    }
  });
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

function openOffsetHelper() {
  if (offsetHelperWindow && !offsetHelperWindow.isDestroyed()) {
    offsetHelperWindow.show();
    offsetHelperWindow.focus();
    return;
  }
  // Use the same bounds as the main window
  const display = getCurrentOverlayMonitor();
  offsetHelperWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height - 1,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    titleBarStyle: 'hidden',
    title: "Offset Helper",
    fullscreen: false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  console.log(display.bounds);
  console.log(offsetHelperWindow.getBounds());

  loadOverlayPage(offsetHelperWindow, "offset-helper.html");

  offsetHelperWindow.webContents.on('did-finish-load', () => {
    if (lastWebsocketData) {
      // The data from the websocket is a string, so we need to parse it
      let parsedData = {};
      try {
        parsedData = JSON.parse(lastWebsocketData);
      } catch (e) {
        // If it's not a JSON string, we can't do much with it
        console.error("Could not parse websocket data for offset helper:", e);
        // Send something to at least open the window with some text
        parsedData = { sentence: lastWebsocketData };
      }
      offsetHelperWindow.webContents.send('text-data', {
        textData: parsedData,
        settings: userSettings,
        windowBounds: { width: display.bounds.width, height: display.bounds.height - 1 }
      });
    }
  });

  offsetHelperWindow.on("closed", () => {
    offsetHelperWindow = null;
  });
}

function createTray() {
  // Use one of the yomitan icons for the tray
  const iconPath = path.join(__dirname, 'yomitan', 'images', 'icon32.png');
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

        // Clear any manual mode state
        if (holdHeartbeat) {
          console.log("[ManualMode] Clearing holdHeartbeat interval");
          clearInterval(holdHeartbeat);
          holdHeartbeat = null;
        }
        manualHotkeyPressed = false;

        // When turning OFF manual mode, restore the overlay to visible state
        if (!menuItem.checked) {
          console.log("[ManualMode] Disabling manual mode via tray - restoring overlay visibility");
          requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
          isOverlayVisible = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            if (!isLinux()) {
              mainWindow.setIgnoreMouseEvents(false, { forward: true });
            }
          }
        } else {
          // When turning ON manual mode, reset visibility flag
          isOverlayVisible = false;
        }

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
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("settings-updated", { showFurigana: menuItem.checked });
        }
        saveSettings();
        updateTrayMenu();
      }
    },
    {
      label: 'Show Text Border',
      type: 'checkbox',
      checked: userSettings.showTextBackground,
      click: (menuItem) => {
        userSettings.showTextBackground = menuItem.checked;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("settings-updated", { showTextBackground: menuItem.checked });
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

  // magpie polling task - DEPRECATED: Now receiving magpie info via websocket
  // Commenting out since magpie info is now sent from Python via websocket
  // bg.registerTask(async () => {
  //   try {
  //     const start = Date.now();
  //     const magpieInfo = await magpie.magpieGetInfo();
  //     const end = Date.now();
  //     if (mainWindow && !mainWindow.isDestroyed()) {
  //       mainWindow.webContents.send('magpie-window-info', magpieInfo);
  //     }
  //   } catch (e) {
  //     console.error('magpie poll failed', e);
  //   }
  // }, 3000);

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

    if (!userSettings.gamepadKeyboardEnabled) {
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

  // Start gamepad server (Python process) if enabled
  startGamepadServer();

  app.on('will-quit', () => {
    releaseAllOverlayPauseRequests();
    globalShortcut.unregisterAll();
    stopOverlayWebSockets();
    stopGamepadServer();
  });

  let display = getCurrentOverlayMonitor();

  console.log(display);

  console.log("Display:", display);

  mainWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height - 1,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    titleBarStyle: 'hidden',
    title: "GSM Overlay",
    fullscreen: false,
    // focusable: false,
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const child = new BrowserWindow({
      parent: mainWindow ? mainWindow : undefined,
      show: true,
      width: 1200,
      height: 980,
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
      const newDisplay = getCurrentOverlayMonitor();
      mainWindow.setBounds({
        x: newDisplay.bounds.x,
        y: newDisplay.bounds.y,
        width: newDisplay.bounds.width,
        height: newDisplay.bounds.height - 1,
      });
      display = newDisplay;
    }
  }, 100);

  // Detect Changes in display every 10 seconds via background manager
  bg.registerTask(() => {
    try {
      const newDisplay = getCurrentOverlayMonitor();
      if (newDisplay.id !== display.id) {
        console.log("Display changed:", newDisplay);
        display = newDisplay;
        const newBounds = {
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width + 1,
          height: display.bounds.height + 1,
        };

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setBounds(newBounds);
        }

        if (texthookerWindow && !texthookerWindow.isDestroyed()) {
          texthookerWindow.setBounds(newBounds);
        }
      }
    } catch (e) {
      console.error('display check failed', e);
    }
  }, 500);

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, "screen-saver");

  let currentShape = {
    x: 0,
    y: 0,
    width: display.bounds.width,
    height: display.bounds.height
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
    if (!resizeMode && !yomitanShown) {
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
    yomitanShown = state;
    if (state) {
      if (isWindows() || isMac()) {
        mainWindow.setIgnoreMouseEvents(false, { forward: true });
      }
      // win.setAlwaysOnTop(true, 'screen-saver');
    } else {
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
      if (!resizeMode) {
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
    mainWindow.show();
    if (isDev) {
      // mainWindow.openDevTools({ mode: 'detach' });
    }
    mainWindow.webContents.send("load-settings", userSettings);
    mainWindow.webContents.send("display-info", display);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');

    if (isWindows() || isMac()) {
      // Windows and macOS - use setIgnoreMouseEvents
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      hideAndRestoreFocus();
    }

    // Start the activity timer
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
    // TODO: Implement scan functionality
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
          showInactiveAndRestoreFocus();
          mainWindow.setAlwaysOnTop(true, 'screen-saver');
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
        // Game window is minimized - minimize overlay too
        if (!mainWindow.isMinimized()) {
          mainWindow.minimize();
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
  ipcMain.on("open-offset-helper", () => {
    openOffsetHelper();
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
    console.log(`Setting changed: ${key} = ${value}`);
    if (key === "weburl1") {
      value = ENFORCED_PLAINTEXT_WS_URL;
    } else if (key === "weburl2") {
      value = ENFORCED_OVERLAY_WS_URL;
    }
    const oldValue = userSettings[key];
    userSettings[key] = value;
    switch (key) {
      case "showHotkey":
        registerManualShowHotkey(oldValue);
        break;
      case "manualMode":
        registerManualShowHotkey();
        break;
      case "manualModeType":
        if (isLinux() && value === "hold") {
          console.warn("[ManualHotkey] Hold mode can be unreliable on Linux (globalShortcut has no key-up and no repeat on many setups).");
        }
        registerManualShowHotkey();
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
        registerTexthookerHotkey(oldValue);
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
                    session.defaultSession.removeExtension(jitenReaderExt.id);
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
        // Start or stop server based on enabled state
        if (value && userSettings.gamepadServerAutoStart) {
          startGamepadServer();
        } else if (!value) {
          stopGamepadServer();
          setGamepadNavigationModeActive(false, "settings-gamepad-disabled");
        }
        break;
      case "gamepadServerAutoStart":
        console.log(`[Gamepad] Setting changed: ${key} = ${value}`);
        if (value && userSettings.gamepadEnabled && !gamepadServerProcess) {
          startGamepadServer();
        }
        break;
      case "gamepadServerPort":
        console.log(`[Gamepad] Setting changed: ${key} = ${value}`);
        // Restart server if port changed
        if (gamepadServerProcess) {
          stopGamepadServer();
          setTimeout(() => startGamepadServer(), 500);
        }
        break;
      case "gamepadActivationMode":
      case "gamepadModifierButton":
      case "gamepadToggleButton":
      case "gamepadConfirmButton":
      case "gamepadCancelButton":
      case "gamepadShowIndicator":
      case "gamepadRepeatDelay":
      case "gamepadRepeatRate":
      case "gamepadControllerEnabled":
        // These settings are handled by the renderer's GamepadHandler
        // Just save and forward - no main process action needed
        console.log(`[Gamepad] Setting changed: ${key} = ${value}`);
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
    userSettings.weburl1 = ENFORCED_PLAINTEXT_WS_URL;
    mainWindow.webContents.send("settings-updated", { weburl1: ENFORCED_PLAINTEXT_WS_URL });
    connectOverlayWebSocket("ws1", ENFORCED_PLAINTEXT_WS_URL);
    saveSettings();
  })
  ipcMain.on("weburl2-changed", (event, newurl) => {
    userSettings.weburl2 = ENFORCED_OVERLAY_WS_URL;
    mainWindow.webContents.send("settings-updated", { weburl2: ENFORCED_OVERLAY_WS_URL });
    connectOverlayWebSocket("ws2", ENFORCED_OVERLAY_WS_URL);
    saveSettings();
    if (backend) backend.connect(ENFORCED_OVERLAY_WS_URL);
  })
  ipcMain.on("hideonstartup-changed", (event, newValue) => {
    userSettings.hideOnStartup = newValue;
    mainWindow.webContents.send("settings-updated", { hideOnStartup: newValue });
    saveSettings();
  })
  ipcMain.on("manualmode-changed", (event, newValue) => {
    userSettings.manualMode = newValue;
    console.log("manualmode-changed", newValue);

    // Safety: Clear heartbeat interval and reset state when toggling manual mode
    // to prevent overlay from getting locked in an inconsistent state
    if (holdHeartbeat) {
      console.log("[ManualMode] Clearing holdHeartbeat interval");
      clearInterval(holdHeartbeat);
      holdHeartbeat = null;
    }
    manualHotkeyPressed = false;

    // When turning OFF manual mode, restore the overlay to visible state
    if (!newValue) {
      console.log("[ManualMode] Disabling manual mode - restoring overlay visibility");
      requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);
      isOverlayVisible = false; // Reset the flag since we're leaving manual mode
      // Ensure the window is visible and mouse events are enabled
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (!isLinux()) {
          mainWindow.setIgnoreMouseEvents(false, { forward: true });
        }
      }
    } else {
      // When turning ON manual mode, reset visibility flag
      isOverlayVisible = false;
    }

    mainWindow.webContents.send("settings-updated", { manualMode: newValue });
    saveSettings();
    registerManualShowHotkey();
  });

  ipcMain.on("showHotkey-changed", (event, newValue) => {
    let oldValue = userSettings.showHotkey;
    userSettings.showHotkey = newValue;
    mainWindow.webContents.send("settings-updated", { showHotkey: newValue });
    saveSettings();
    registerManualShowHotkey(oldValue);
  });

  ipcMain.on("pinned-changed", (event, newValue) => {
    userSettings.pinned = newValue;
    mainWindow.webContents.send("settings-updated", { pinned: newValue });
    saveSettings();
  });

  ipcMain.on("showTextBackground-changed", (event, newValue) => {
    userSettings.showTextBackground = newValue;
    mainWindow.webContents.send("settings-updated", { showTextBackground: newValue });
    saveSettings();
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
      showInactiveAndRestoreFocus();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');


      // blur after a short delay too

      setTimeout(() => {
        blurAndRestoreFocus();
      }, 200);
    }

    // console.log(`magpieCompatibility: ${userSettings.magpieCompatibility}`);
    // Use currentMagpieActive from websocket instead of userSettings.magpieCompatibility
    if (currentMagpieActive && !isManualMode()) {
      showInactiveAndRestoreFocus();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

      setTimeout(() => {
        blurAndRestoreFocus();
      }, 200);
    }
    //   // Slightly adjust position to workaround Magpie stealing focus
    //   win.show();
    //   win.setAlwaysOnTop(true, 'screen-saver');
    //   win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // //   const ensureOnTop = setInterval(() => {
    // //   if (win && !win.isDestroyed()) {
    // //     try {
    // //       win.setAlwaysOnTop(true, 'screen-saver');
    // //       win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // //     } catch (error) {
    // //       console.error("Error maintaining always-on-top:", error);
    // //       clearInterval(ensureOnTop);
    // //     }
    // //   } else {
    // //     clearInterval(ensureOnTop);
    // //   }
    // // }, 100); // Check every 2 seconds instead of 100ms for better performance
    // }

    // Ensure window stays on top when text is received
    // win.setAlwaysOnTop(true, 'screen-saver');
    // win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Don't blur immediately - let the overlay stay accessible briefly
    // setTimeout(() => {
    //   if (!yomitanShown && !resizeMode) {
    //     win.blur();
    //   }
    // }, 100);

    // Periodically ensure always-on-top status is maintained
    // Some applications can steal focus and break overlay behavior
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

  // Handler to manually send navigation commands (can be triggered from other sources)
  ipcMain.on("gamepad-navigate", (event, direction) => {
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
    fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2))
  });
});
