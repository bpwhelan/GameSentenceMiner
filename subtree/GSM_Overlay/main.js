const { app, BrowserWindow, session, screen, globalShortcut } = require('electron');
const { ipcMain } = require("electron");
const fs = require("fs");
const path = require('path');
const magpie = require('./magpie');
const bg = require('./background');

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let manualHotkeyPressed = false;
let lastManualActivity = Date.now();
let activityTimer = null;
let ext;
let userSettings = {
  "fontSize": 42,
  "weburl1": "ws://localhost:55002",
  "weburl2": "ws://localhost:55499",
  "hideOnStartup": false,
  "magpieCompatibility": false,
  "manualMode": false,
  "showHotkey": "Shift + Space",
  "pinned": false,
  "showTextBackground": false,
  "focusOnHotkey": false,
  "afkTimer": 5, // in minutes
};
let manualIn;
let resizeMode = false;
let yomitanShown = false;
let mainWindow = null;
let afkHidden = false; // true when AFK timer hid the overlay
let websocketStates = {
  "ws1": false,
  "ws2": false
};

if (fs.existsSync(settingsPath)) {
  try {
    const data = fs.readFileSync(settingsPath, "utf-8");
    oldUserSettings = JSON.parse(data)
    userSettings = { ...userSettings, ...oldUserSettings }

  } catch (error) {
    console.error("Failed to load settings.json:", e)

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
    console.log("Old Settings:", oldUserSettings);
    console.log("New Settings:", userSettings);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2))
}

function registerManualShowHotkey(oldHotkey) {
  if (!userSettings.manualMode) return;
  if (manualIn) globalShortcut.unregister(oldHotkey || userSettings.showHotkey);
  
  let clear = null;

  // Manual hotkey enters mode on press, exits after timeout
  manualIn = globalShortcut.register(userSettings.showHotkey, () => {
    // console.log("Manual hotkey pressed");
    if (!userSettings.manualMode) {
      globalShortcut.unregister(userSettings.showHotkey);
      return;
    }
    if (mainWindow) {
      // Enter manual mode and reset timer
      manualHotkeyPressed = true;
      lastManualActivity = Date.now();
      // mainWindow.show();
      mainWindow.webContents.send('show-overlay-hotkey', true);
      mainWindow.setIgnoreMouseEvents(false, { forward: true });

    if (userSettings.magpieCompatibility || userSettings.focusOnHotkey) {
      mainWindow.show();
      // mainWindow.blur();
    }

      // Clear existing timeout if any
      let timeToWait = 500
      if (clear) {
        clearTimeout(clear);
        timeToWait = 200; // Shorter timeout if already active
      }
      
      clear = setTimeout(() => {
        manualHotkeyPressed = false;
        mainWindow.webContents.send('show-overlay-hotkey', false);
        if (!yomitanShown && !resizeMode) {
          mainWindow.blur();
          mainWindow.setIgnoreMouseEvents(true, { forward: true });
        }
      }, timeToWait);
    }
  });
}

function resetActivityTimer() {
  // Clear existing timer
  if (activityTimer) {
    clearTimeout(activityTimer);
  }

  if (userSettings.afkTimer === 0) {
    return;
  }

  // Set new timer for 5 minutes
  activityTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log("AFK timeout reached — hiding overlay text and releasing interactions");
      // Use dedicated AFK IPC channel so renderer knows this is an automatic hide
      try {
        mainWindow.webContents.send('afk-hide', true);
        afkHidden = true;
      } catch (e) {
        console.warn('Failed to send afk-hide to renderer:', e);
      }

      // Ensure manual hotkey state is cleared so subsequent AFK cycles behave correctly
      manualHotkeyPressed = false;

      // Make the overlay ignore mouse events so clicks pass through
      try {
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
      } catch (e) {
        console.warn('Failed to setIgnoreMouseEvents on mainWindow:', e);
      }

      // Blur window so it doesn't steal focus
      try {
        mainWindow.blur();
      } catch (e) {
        // ignore
      }
    }
  }, userSettings.afkTimer * 60 * 1000);
}

function openSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("force-visible", true);
  }
  mainWindow.webContents.send("request-current-settings");
  ipcMain.once("reply-current-settings", (event, settings) => {
    const settingsWin = new BrowserWindow({
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

    settingsWin.webContents.setWindowOpenHandler(({ url }) => {
            const child = new BrowserWindow({
                parent: settingsWin ? settingsWin : undefined,
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

    settingsWin.removeMenu()

    settingsWin.loadFile("settings.html");
    settingsWin.on("closed", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("force-visible", false);
      }
    })
    const closedListenerFunction = (event, type) => {
      settingsWin.send("websocket-closed", type)
    }
    const openedListenerFunction = (event, type) => {
      settingsWin.send("websocket-opened", type);
    };
    ipcMain.on("websocket-closed", closedListenerFunction)
    ipcMain.on("websocket-opened", openedListenerFunction)
    console.log(websocketStates)
    settingsWin.webContents.send("preload-settings", { userSettings, websocketStates })

    settingsWin.on("closed", () => {
      ipcMain.removeListener("websocket-closed", closedListenerFunction)
      ipcMain.removeListener("websocket-opened", openedListenerFunction)
    })
    setTimeout(() => {
    settingsWin.setSize(settingsWin.getSize()[0], settingsWin.getSize()[1]);
    settingsWin.webContents.invalidate();
    settingsWin.show();
  }, 500);
  })
}

function openYomitanSettings() {
  const yomitanOptionsWin = new BrowserWindow({
      width: 1100,
      height: 600,
      webPreferences: {
        nodeIntegration: false
      }
    });

    yomitanOptionsWin.removeMenu()
    yomitanOptionsWin.loadURL(`chrome-extension://${ext.id}/settings.html`);
    // Allow search ctrl F in the settings window
    yomitanOptionsWin.webContents.on('before-input-event', (event, input) => {
      if (input.key.toLowerCase() === 'f' && input.control) {
        yomitanOptionsWin.webContents.send('focus-search');
        event.preventDefault();
      }
    });
    yomitanOptionsWin.show();
    // Force a repaint to fix blank/transparent window issue
    setTimeout(() => {
      yomitanOptionsWin.setSize(yomitanOptionsWin.getSize()[0], yomitanOptionsWin.getSize()[1]);
      yomitanOptionsWin.webContents.invalidate(); // Electron 21+ supports this
      yomitanOptionsWin.show();
    }, 500);
}

app.whenReady().then(async () => {
  // Start background manager and register periodic tasks
  bg.start();

  // magpie polling task
  bg.registerTask(async () => {
    try {
      const start = Date.now();
      const magpieInfo = await magpie.magpieGetInfo();
      const end = Date.now();
      // console.log(`Time taken to get magpie info: ${end - start}ms`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('magpie-window-info', magpieInfo);
      }
    } catch (e) {
      console.error('magpie poll failed', e);
    }
  }, 3000);

  const isDev = !app.isPackaged;
  const extPath = isDev ? path.join(__dirname, 'yomitan') : path.join(process.resourcesPath, "yomitan")
  try {
    ext = await session.defaultSession.loadExtension(extPath, { allowFileAccess: true });
    console.log('Yomitan extension loaded.');

  } catch (e) {
    console.error('Failed to load extension:', e);
  }

  globalShortcut.register('Alt+Shift+H', () => {
    // Send a message to the renderer process to toggle the main box
    if (mainWindow) {
      mainWindow.webContents.send('toggle-main-box');
    }
  });

  globalShortcut.register('Alt+Shift+J', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
        mainWindow.blur();
      }
      else mainWindow.minimize();
    }
  });

  globalShortcut.register('Alt+Shift+Y', () => {
    openYomitanSettings();
  });

  globalShortcut.register('Alt+Shift+S', () => {
    openSettings();
  });

  globalShortcut.register("Alt+Shift+M", () => {
    userSettings.magpieCompatibility = !userSettings.magpieCompatibility;
    saveSettings();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("new-magpieCompatibility", userSettings.magpieCompatibility);
    }
  })

  registerManualShowHotkey();
  

  // On press down, toggle overlay on top and focused, on release, toggle back
  // globalShortcut.register('O', () => {
  //   if (win) {
  //     win.setAlwaysOnTop(true, 'screen-saver');
  //     win.focus();
  //   }
  // }, () => {
  //   if (win) {
  //     win.setAlwaysOnTop(false);
  //   }
  // });

  // Unregister shortcuts on quit
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
    title: "",
    fullscreen: false,
    // focusable: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    },
    show: false,
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
  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    // console.log("set-ignore-mouse-events", ignore, options, resizeMode, yomitanShown);
    if (!resizeMode && !yomitanShown) {
      mainWindow.setIgnoreMouseEvents(ignore, options)
    }
    // if (ignore) {
    //   win.blur();
    // }
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
      mainWindow.setIgnoreMouseEvents(false, { forward: true });
      // win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      // win.setAlwaysOnTop(true, 'screen-saver');
      if (!manualHotkeyPressed) {
        mainWindow.blur();
      }
      // Blur again after a short delay to ensure it takes effect
      setTimeout(() => {
        if (!resizeMode && !yomitanShown && !manualHotkeyPressed) {
          mainWindow.blur();
        }
      }, 100);
    }
  })

  ipcMain.on('release-mouse', () => {
    mainWindow.blur();
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

  mainWindow.loadFile('index.html');
  if (isDev) {
    mainWindow.webContents.on('context-menu', () => {
      mainWindow.webContents.openDevTools({ mode: 'detach' });

    });
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) {
      mainWindow.openDevTools({ mode: 'detach' });
    }
    mainWindow.webContents.send("load-settings", userSettings);
    mainWindow.webContents.send("display-info", display);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    
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

  ipcMain.on("websocket-closed", (event, type) => {
    websocketStates[type] = false
  });
  ipcMain.on("websocket-opened", (event, type) => {
    websocketStates[type] = true
  });

  ipcMain.on("open-settings", () => {
    openSettings();
  });
  ipcMain.on("setting-changed", (event, { key, value }) => {
    console.log(`Setting changed: ${key} = ${value}`);
    
    // Update the userSettings object
    const oldValue = userSettings[key];
    userSettings[key] = value;
    
    // Handle special cases that need additional logic
    switch (key) {
      case "showHotkey":
        registerManualShowHotkey(oldValue);
        break;
      case "manualMode":
        registerManualShowHotkey();
        break;
      case "afkTimer":
        resetActivityTimer();
        break;
      // Add other special cases here as needed
    }
    
    // Send the updated setting to the main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("settings-updated", { [key]: value });
    }
    
    // Save settings to disk
    saveSettings();
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
  })
  ipcMain.on("hideonstartup-changed", (event, newValue) => {
    userSettings.hideOnStartup = newValue;
    mainWindow.webContents.send("settings-updated", { hideOnStartup: newValue });
    saveSettings();
  })
  ipcMain.on("magpieCompatibility-changed", (event, newValue) => {
    userSettings.magpieCompatibility = newValue;
    mainWindow.webContents.send("settings-updated", { magpieCompatibility: newValue });
    saveSettings();
  })
  ipcMain.on("manualmode-changed", (event, newValue) => {
    userSettings.manualMode = newValue;
    console.log("manualmode-changed", newValue);
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

  // let alwaysOnTopInterval;

  ipcMain.on("text-recieved", (event, text) => {
    // Reset the activity timer on text received
    resetActivityTimer();
      // If AFK previously hid the overlay, restore it now
      if (afkHidden) {
        try {
          mainWindow.webContents.send('afk-hide', false);
        } catch (e) {
          console.warn('Failed to send afk-hide (restore) to renderer:', e);
        }
        afkHidden = false;
      }
    
    // If window is minimized, restore it
    if (mainWindow.isMinimized()) {
      mainWindow.show();
      mainWindow.blur();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      
      // blur after a short delay too

      setTimeout(() => {
          mainWindow.blur();
      }, 200);
    }

    // console.log(`magpieCompatibility: ${userSettings.magpieCompatibility}`);
    if (userSettings.magpieCompatibility) {
      mainWindow.show();
      mainWindow.blur();
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
    // clearInterval(alwaysOnTopInterval);
    fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2))
  });
});
