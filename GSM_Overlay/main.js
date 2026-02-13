const { app, BrowserWindow, session, screen, globalShortcut, dialog, Tray, Menu, nativeImage, protocol } = require('electron');
const { ipcMain } = require("electron");
const fs = require("fs");
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const magpie = require('./magpie');
const bg = require('./background');
const wanakana = require('wanakana');
const Kuroshiro = require("kuroshiro").default;
const KuromojiAnalyzer = require("kuroshiro-analyzer-kuromoji");
const BackendConnector = require('./backend_connector');

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
let manualHotkeyPressed = false;
let manualModeToggleState = false;
let lastManualActivity = Date.now();
let activityTimer = null;
let isDev = false;
let yomitanExt;
let jitenReaderExt;
let userSettings = {
  "fontSize": 42,
  "weburl1": "ws://localhost:55002",
  "weburl2": "ws://localhost:55499",
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
  "offsetX": 0,
  "offsetY": 0,
  "dismissedFullscreenRecommendations": [], // Games for which fullscreen recommendation was dismissed
  "texthookerHotkey": "Alt+Shift+W",
  "texthookerUrl": "http://localhost:55000/texthooker",
};
let isTexthookerMode = false;
let manualIn;
let resizeMode = false;
let yomitanShown = false;
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
const OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY = "manual_hotkey";
const OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY = "texthooker_hotkey";
const overlayPauseSourceActive = {
  [OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY]: false,
  [OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY]: false,
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
        type: 'restore-focus-request',
        delay: 500,
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

function scheduleYomitanCloseRecovery() {
  const version = ++yomitanRecoveryVersion;
  const recoveryDelays = [0, 80, 180, 320];

  for (const delay of recoveryDelays) {
    setTimeout(() => {
      if (version !== yomitanRecoveryVersion) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (yomitanShown || resizeMode || manualHotkeyPressed || manualModeToggleState) return;

      aggressivelyShowOverlayAndReturnFocus();

      // Return focus back to game shortly after forcing overlay to the top.
      setTimeout(() => {
        if (version !== yomitanRecoveryVersion) return;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (yomitanShown || resizeMode || manualHotkeyPressed || manualModeToggleState) return;
        if (isWindows() || isMac()) {
          mainWindow.setIgnoreMouseEvents(true, { forward: true });
        }
        blurAndRestoreFocus();
      }, 25);
    }, delay);
  }
}

if (fs.existsSync(settingsPath)) {
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
    websocket_port: 55499,
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
    default:
      return false;
  }
}

function sendOverlayPauseRequest(action, source) {
  if (!backend) {
    console.warn(`[ProcessPause] Backend unavailable, cannot send ${action} request for source=${source}`);
    return false;
  }

  backend.send({
    type: "process-pause-request",
    action,
    source,
  });
  return true;
}

function requestOverlayPauseForSource(source) {
  if (!shouldOverlayHotkeyRequestPause(source)) {
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

  waitForTexthookerUrl(texthookerWindow, userSettings.texthookerUrl || "http://localhost:55000/texthooker");
  texthookerWindow.setOpacity(0.95);

  texthookerWindow.on('closed', () => {
    texthookerLoadToken += 1;
    if (isTexthookerMode) {
      isTexthookerMode = false;
      requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY);
    }
    texthookerWindow = null;
  });

  // Ensure it stays on top when shown
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
    console.log(`[ManualHotkey] Attempting SHOW (${triggerSource})... Current State: ${isOverlayVisible ? "Visible" : "Hidden"}`);

    if (isOverlayVisible) {
      console.log("[ManualHotkey] Blocked: Overlay is already visible.");
      return;
    }

    isOverlayVisible = true;
    console.log("[ManualHotkey] ACTION: Sending 'show-overlay-hotkey' true");
    mainWindow.webContents.send('show-overlay-hotkey', true);
    requestOverlayPauseForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);

    if (!isLinux()) {
      console.log("[ManualHotkey] ACTION: setIgnoreMouseEvents(false)");
      mainWindow.setIgnoreMouseEvents(false, { forward: true });
    } else {
      console.log("[ManualHotkey] ACTION: mainWindow.show() (Linux)");
      mainWindow.show();
    }

    // Only force focus if strictly necessary
    if (currentMagpieActive || isManualMode()) {
      console.log("[ManualHotkey] ACTION: Forcing Focus (Magpie active or Manual Mode)");
      mainWindow.show();
    }
  };

  // Helper: Consolidated Hide Logic
  const hideOverlay = (triggerSource) => {
    console.log(`[ManualHotkey] Attempting HIDE (${triggerSource})... Current State: ${isOverlayVisible ? "Visible" : "Hidden"}`);

    if (!isOverlayVisible) {
      console.log("[ManualHotkey] Blocked: Overlay is already hidden.");
      return;
    }

    isOverlayVisible = false;
    console.log("[ManualHotkey] ACTION: Sending 'show-overlay-hotkey' false");
    mainWindow.webContents.send('show-overlay-hotkey', false);
    requestOverlayResumeForSource(OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY);

    if (!yomitanShown && !resizeMode) {
      if (!isLinux()) {
        console.log("[ManualHotkey] ACTION: setIgnoreMouseEvents(true)");
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
      }
      console.log("[ManualHotkey] ACTION: calling hideAndRestoreFocus()");
      hideAndRestoreFocus();
    } else {
      console.log(`[ManualHotkey] Skipping Focus Restore. Yomitan: ${yomitanShown}, Resize: ${resizeMode}`);
    }
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
    const closedListenerFunction = (event, type) => {
      settingsWindow.send("websocket-closed", type)
    }
    const openedListenerFunction = (event, type) => {
      settingsWindow.send("websocket-opened", type);
    };
    ipcMain.on("websocket-closed", closedListenerFunction)
    ipcMain.on("websocket-opened", openedListenerFunction)
    console.log(websocketStates)
    settingsWindow.webContents.send("preload-settings", { userSettings, websocketStates })

    settingsWindow.on("closed", () => {
      ipcMain.removeListener("websocket-closed", closedListenerFunction)
      ipcMain.removeListener("websocket-opened", openedListenerFunction)
    })
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
    dialog.showErrorBox('Error', 'Jiten Reader extension is not loaded. Please restart the overlay.');
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
  jitenReaderExt = await loadExtension('jiten.reader');

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

  createTexthookerWindow();
  registerTexthookerHotkey();
  registerManualShowHotkey();

  // Initialize kuroshiro for furigana conversion
  const kuroshiro = new Kuroshiro();
  kuroshiro.init(new KuromojiAnalyzer()).then(() => {
    console.log("Kuroshiro initialized");
  }).catch(err => {
    console.error("Kuroshiro initialization failed:", err);
  });

  // Initialize backend connector
  backend = new BackendConnector(ipcMain, () => mainWindow);
  backend.connect(userSettings.weburl2);

  // IPC handlers for wanakana and kuroshiro
  ipcMain.handle('wanakana-stripOkurigana', (event, text, options) => {
    return wanakana.stripOkurigana(text, options);
  });

  ipcMain.handle('wanakana-isKanji', (event, text) => {
    return wanakana.isKanji(text);
  });

  ipcMain.handle('wanakana-isHiragana', (event, text) => {
    return wanakana.isHiragana(text);
  });

  ipcMain.handle('wanakana-isKatakana', (event, text) => {
    return wanakana.isKatakana(text);
  });


  ipcMain.handle('kuroshiro-convert', async (event, text, options) => {
    try {
      return await kuroshiro.convert(text, options);
    } catch (err) {
      console.error("Kuroshiro conversion error:", err);
      throw err;
    }
  });

  app.on('will-quit', () => {
    releaseAllOverlayPauseRequests();
    globalShortcut.unregisterAll();
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
      if (manualHotkeyPressed || manualModeToggleState) {
        return;
      }
      if (isWindows() || isMac()) {
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
      } else {
        hideAndRestoreFocus();
      }
      // win.setAlwaysOnTop(true, 'screen-saver');
      if (!manualHotkeyPressed && !manualModeToggleState && !resizeMode) {
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
  if (isDev) {
    mainWindow.webContents.on('context-menu', () => {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
    openSettings();
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) {
      mainWindow.openDevTools({ mode: 'detach' });
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

  ipcMain.on("websocket-closed", (event, type) => {
    websocketStates[type] = false
  });
  ipcMain.on("websocket-opened", (event, type) => {
    websocketStates[type] = true
  });

  ipcMain.on("websocket-data", (event, data) => {
    lastWebsocketData = data;
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
      case "weburl2":
        if (backend) backend.connect(value);
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
    userSettings.weburl1 = newurl;
    mainWindow.webContents.send("settings-updated", { weburl1: newurl });
    saveSettings();
  })
  ipcMain.on("weburl2-changed", (event, newurl) => {
    userSettings.weburl2 = newurl;
    mainWindow.webContents.send("settings-updated", { weburl2: newurl });
    saveSettings();
    if (backend) backend.connect(newurl);
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
