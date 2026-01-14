const { app, BrowserWindow, session, screen, globalShortcut, dialog, Tray, Menu, nativeImage, protocol } = require('electron');
const { ipcMain } = require("electron");
const fs = require("fs");
const path = require('path');
const os = require('os');
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
let manualHotkeyPressed = false;
let manualModeToggleState = false;
let lastManualActivity = Date.now();
let activityTimer = null;
let isDev = false;
let ext;
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
  "toggleToolboxHotkey": "Alt+Shift+A",
  "autoRequestTranslation": false,
  "showRecycledIndicator": false,
  "pinned": false,
  "showReadyIndicator": true,
  "showTextBackground": false,
  "toolboxEnabled": false,
  "enabledTools": [],
  "toolSettings": {
    "pomodoro": {
      "workDuration": 25,        // minutes
      "shortBreakDuration": 5,   // minutes
      "longBreakDuration": 15,   // minutes
      "sessionsBeforeLongBreak": 4
    }
  },
  "afkTimer": 5, // in minutes
  "showFurigana": false,
  "hideFuriganaOnStartup": false,
  "offsetX": 0,
  "offsetY": 0,
  "dismissedFullscreenRecommendations": [], // Games for which fullscreen recommendation was dismissed
};
let manualIn;
let resizeMode = false;
let yomitanShown = false;
let toolboxVisible = false;
let mainWindow = null;
let afkHidden = false; // true when AFK timer hid the overlay
let websocketStates = {
  "ws1": false,
  "ws2": false
};

let lastWebsocketData = null;
let currentMagpieActive = false; // Track magpie state from websocket
let translationRequested = false; // Track if translation has been requested for current text

let yomitanSettingsWindow = null;
let settingsWindow = null;
let offsetHelperWindow = null;
let tray = null;
let platformOverride = null;
let backend = null;

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

    if (!yomitanShown && !resizeMode && !toolboxVisible) {
      if (!isLinux()) {
        console.log("[ManualHotkey] ACTION: setIgnoreMouseEvents(true)");
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
      }
      console.log("[ManualHotkey] ACTION: calling hideAndRestoreFocus()");
      hideAndRestoreFocus();
    } else {
      console.log(`[ManualHotkey] Skipping Focus Restore. Yomitan: ${yomitanShown}, Resize: ${resizeMode}, Toolbox: ${toolboxVisible}`);
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

          // Threshold: 450ms
          if (timeSincePress > 600) {
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

    settingsWindow.loadFile("settings.html");
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
  yomitanSettingsWindow.loadURL(`chrome-extension://${ext.id}/settings.html`);
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

  offsetHelperWindow.loadFile("offset-helper.html");

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
    dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['OK'],
      defaultId: 0,
      title: 'GSM Overlay - Manual Mode Enforced',
      message: 'Overlay requires hotkey to show text for lookups on macOS and Linux due to platform limitations.\n\n' +
        'Use the configured hotkey: ' + userSettings.showHotkey + ' to show/hide the overlay as needed.',
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
      else if (userSettingsExists && !isMigrated) {
        console.log("[Init] Existing user detected. Migration required.");

        const response = dialog.showMessageBoxSync({
          type: 'warning',
          buttons: ['Load Old (Backup Data)', 'Ready to Migrate'],
          defaultId: 0,
          cancelId: 0,
          title: 'Yomitan Update - Action Required',
          message: 'Internal ID Migration Required',
          detail: 'To prevent data loss in future updates, we need to standardize the Yomitan Extension ID.\n\n' +
            '• Load Old: Loads the old temporary ID. Choose this to Export your Settings and Dictionaries now.\n' +
            '• Ready to Migrate: Choose this ONLY if you have backed up your data. This will reset Yomitan to a fresh state with the permanent ID.\n\n' +
            'This is a one-time process.'
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

  try {
    ext = await session.defaultSession.loadExtension(extDir, { allowFileAccess: true });
    console.log('Yomitan extension loaded.');
    console.log('Extension ID:', ext.id);

    // If migration marker exists, update it with the actual ID for debugging
    if (fs.existsSync(markerPath)) {
      const markerData = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      if (!markerData.id) {
        markerData.id = ext.id;
        fs.writeFileSync(markerPath, JSON.stringify(markerData));
      }
    }

  } catch (e) {
    console.error('Failed to load extension:', e);
  }

  // Create system tray icon
  createTray();

  // Register toggle window hotkey
  function registerToggleWindowHotkey(oldHotkey) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.toggleWindowHotkey);
    const hotkey = userSettings.toggleWindowHotkey || "Alt+Shift+H";
    const registered = globalShortcut.register(hotkey, () => {
      console.log(`Toggle window hotkey (${hotkey}) pressed`);
      if (mainWindow) {
        mainWindow.webContents.send('toggle-main-box');
      }
    });
    if (registered) {
      console.log(`Successfully registered toggle window hotkey: ${hotkey}`);
    } else {
      console.error(`Failed to register toggle window hotkey: ${hotkey}. It may be in use by another application.`);
    }
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

  // Register toolbox toggle hotkey
  function registerToggleToolboxHotkey(oldHotkey) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.toggleToolboxHotkey);
    globalShortcut.register(userSettings.toggleToolboxHotkey || "Alt+Shift+T", () => {
      console.log("Toolbox hotkey pressed");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toggle-toolbox');
      }
    });
  }

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

  registerToggleToolboxHotkey();

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
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setBounds({
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width + 1,
            height: display.bounds.height + 1,
          });
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
    // console.log("set-ignore-mouse-events", ignore, options, resizeMode, yomitanShown, toolboxVisible);
    // Don't allow click-through when toolbox is visible
    if (toolboxVisible && ignore) {
      return;
    }
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

    yomitanShown = state;
    if (state) {
      if (isWindows() || isMac()) {
        mainWindow.setIgnoreMouseEvents(false, { forward: true });
      }
      // win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      if (manualHotkeyPressed && manualModeToggleState) {
        return;
      }
      if (toolboxVisible) {
        return; // Don't restore click-through while toolbox is visible
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
      // Blur again after a short delay to ensure it takes effect
      setTimeout(() => {
        if (!resizeMode && !yomitanShown && !manualHotkeyPressed && !manualModeToggleState) {
          // Use currentMagpieActive from websocket instead of userSettings.magpieCompatibility
          if (currentMagpieActive) {
            showInactiveAndRestoreFocus();
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
          }
          blurAndRestoreFocus();
        }
      }, 100);
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

  mainWindow.loadFile('index.html');
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

  // Toolbox data persistence
  const toolboxDataPath = path.join(app.getPath('userData'), 'toolbox.json');

  function readToolboxData() {
    try {
      if (fs.existsSync(toolboxDataPath)) {
        return JSON.parse(fs.readFileSync(toolboxDataPath, 'utf-8'));
      }
    } catch (error) {
      console.error('Failed to read toolbox.json:', error);
    }
    return { tools: {} };
  }

  function writeToolboxData(data) {
    try {
      fs.writeFileSync(toolboxDataPath, JSON.stringify(data, null, 2));
      return true;
    } catch (error) {
      console.error('Failed to write toolbox.json:', error);
      return false;
    }
  }

  ipcMain.handle('toolbox-data-read', async (event, { toolId, gameKey }) => {
    const data = readToolboxData();
    return gameKey ? data.tools?.[toolId]?.[gameKey] : data.tools?.[toolId] || {};
  });

  ipcMain.handle('toolbox-data-write', async (event, { toolId, gameKey, value }) => {
    const data = readToolboxData();
    if (!data.tools) data.tools = {};
    if (!data.tools[toolId]) data.tools[toolId] = {};
    data.tools[toolId][gameKey] = { ...value, lastModified: Date.now() };
    return writeToolboxData(data);
  });

  ipcMain.on("toolbox-visibility-changed", (event, visible) => {
    console.log('Toolbox visibility:', visible);
    toolboxVisible = visible;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (visible) {
        // Allow mouse interaction when toolbox is visible
        mainWindow.setIgnoreMouseEvents(false, { forward: true });
      } else {
        // Restore click-through when toolbox is hidden
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
      }
    }
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

  ipcMain.on("window-state-changed", (event, { state, game, game_id, magpieActive, isFullscreen, recommendManualMode }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // Update the tracked magpie state
    currentMagpieActive = magpieActive || false;

    console.log(`Window state changed to: ${state} for game: ${game}, magpie active: ${currentMagpieActive}, fullscreen: ${isFullscreen}`);

    // Send game state to renderer to control action panel visibility
    mainWindow.webContents.send("game-state", state);

    // Notify renderer of game change with both display name and UUID
    if (game) {
      mainWindow.webContents.send("game-changed", { game, game_id });
    }

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
      case "toggleToolboxHotkey":
        registerToggleToolboxHotkey(oldValue);
        break;
      case "toolboxEnabled":
      case "enabledTools":
      case "toolSettings":
        // Settings already updated in userSettings, just saved
        // Renderer will receive update via settings-updated broadcast
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
