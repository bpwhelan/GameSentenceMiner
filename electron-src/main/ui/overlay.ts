import { BrowserWindow, session, screen, globalShortcut, dialog, ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getResourcesDir, isDev } from '../util.js';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// We'll import these dynamically to avoid CommonJS/ESM issues
let wanakana: any;
let Kuroshiro: any;
let KuromojiAnalyzer: any;

async function loadOverlayDependencies() {
    if (wanakana) return; // Already loaded
    
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    
    wanakana = require('wanakana');
    Kuroshiro = require('kuroshiro').default;
    KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
}

let overlayWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let yomitanSettingsWindow: BrowserWindow | null = null;
let ext: any = null;
let overlayInitialized = false;

// Background task manager
let backgroundManager: any = null;

// Overlay state
let manualHotkeyPressed = false;
let lastManualActivity = Date.now();
let activityTimer: NodeJS.Timeout | null = null;
let manualIn: any = null;
let resizeMode = false;
let yomitanShown = false;
let afkHidden = false;
let websocketStates = {
    ws1: false,
    ws2: false,
};

// Paths and settings
const dataPath = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'gsm_overlay');
fs.mkdirSync(dataPath, { recursive: true });

const settingsPath = path.join(dataPath, 'settings.json');

let userSettings = {
    fontSize: 42,
    weburl1: 'ws://localhost:55002',
    weburl2: 'ws://localhost:55499',
    hideOnStartup: false,
    magpieCompatibility: false,
    manualMode: false,
    showHotkey: 'Shift + Space',
    toggleFuriganaHotkey: 'Alt+F',
    pinned: false,
    showTextBackground: false,
    focusOnHotkey: false,
    afkTimer: 5,
    showFurigana: false,
};

// Load settings
if (fs.existsSync(settingsPath)) {
    try {
        const data = fs.readFileSync(settingsPath, 'utf-8');
        const oldUserSettings = JSON.parse(data);
        userSettings = { ...userSettings, ...oldUserSettings };
    } catch (error) {
        console.error('Failed to load overlay settings.json:', error);
    }
}

const GSM_APPDATA = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'GameSentenceMiner')
    : path.join(os.homedir(), '.config', 'GameSentenceMiner');

function getGSMSettings() {
    const gsmSettingsPath = path.join(GSM_APPDATA, 'config.json');
    let gsmSettings: any = {};
    if (fs.existsSync(gsmSettingsPath)) {
        try {
            const data = fs.readFileSync(gsmSettingsPath, 'utf-8');
            gsmSettings = JSON.parse(data);
        } catch (error) {
            console.error('Failed to load GSM config.json:', error);
        }
    }
    return gsmSettings;
}

function getGSMOverlaySettings() {
    const gsmSettings = getGSMSettings();
    if (gsmSettings.overlay) {
        return gsmSettings.overlay;
    }
    return {
        websocket_port: 55499,
        engine: 'lens',
        monitor_to_capture: 0,
        periodic: false,
        periodic_interval: 3.0,
        scan_delay: 0.25,
    };
}

function getCurrentOverlayMonitor() {
    const overlaySettings = getGSMOverlaySettings();
    return screen.getAllDisplays()[overlaySettings.monitor_to_capture] || screen.getPrimaryDisplay();
}

function saveSettings() {
    fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2));
}

function resetActivityTimer() {
    if (activityTimer) {
        clearTimeout(activityTimer);
    }

    if (userSettings.afkTimer === 0) {
        return;
    }

    activityTimer = setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            console.log('AFK timeout reached — hiding overlay text and releasing interactions');
            try {
                overlayWindow.webContents.send('afk-hide', true);
                afkHidden = true;
            } catch (e) {
                console.warn('Failed to send afk-hide to renderer:', e);
            }

            manualHotkeyPressed = false;

            try {
                if (process.platform === 'win32' || process.platform === 'darwin') {
                    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
                }
            } catch (e) {
                console.warn('Failed to setIgnoreMouseEvents on overlayWindow:', e);
            }

            try {
                overlayWindow.blur();
            } catch (e) {
                // ignore
            }
        }
    }, userSettings.afkTimer * 60 * 1000);
}

function registerManualShowHotkey(oldHotkey?: string) {
    if (!userSettings.manualMode) return;
    if (manualIn) globalShortcut.unregister(oldHotkey || userSettings.showHotkey);

    let clear: NodeJS.Timeout | null = null;

    manualIn = globalShortcut.register(userSettings.showHotkey, () => {
        if (!userSettings.manualMode) {
            globalShortcut.unregister(userSettings.showHotkey);
            return;
        }
        if (overlayWindow) {
            manualHotkeyPressed = true;
            lastManualActivity = Date.now();
            overlayWindow.webContents.send('show-overlay-hotkey', true);

            if (process.platform !== 'linux') {
                overlayWindow.webContents.send('show-overlay-hotkey', true);
                overlayWindow.setIgnoreMouseEvents(false, { forward: true });
            } else {
                overlayWindow.show();
            }

            if (userSettings.magpieCompatibility || userSettings.focusOnHotkey) {
                overlayWindow.show();
            }

            const timeToWait = clear ? 200 : 500;
            if (clear) {
                clearTimeout(clear);
            }

            clear = setTimeout(() => {
                manualHotkeyPressed = false;
                overlayWindow!.webContents.send('show-overlay-hotkey', false);
                if (!yomitanShown && !resizeMode) {
                    overlayWindow!.blur();
                    if (process.platform !== 'linux') {
                        overlayWindow!.setIgnoreMouseEvents(true, { forward: true });
                    } else {
                        overlayWindow!.hide();
                    }
                }
            }, timeToWait);
        }
    });
}

function registerToggleFuriganaHotkey(oldHotkey?: string) {
    if (oldHotkey) globalShortcut.unregister(oldHotkey);
    globalShortcut.unregister(userSettings.toggleFuriganaHotkey);
    globalShortcut.register(userSettings.toggleFuriganaHotkey || 'Alt+F', () => {
        if (overlayWindow) {
            overlayWindow.webContents.send('toggle-furigana-visibility');
        }
    });
}

async function initializeYomitan() {
    const yomitanDir = isDev
        ? path.join(__dirname, '../../../GSM_Overlay/yomitan')
        : path.join(getResourcesDir(), 'GSM_Overlay/yomitan');

    const activeManifestPath = path.join(yomitanDir, 'manifest.json');
    const staticManifestPath = path.join(yomitanDir, 'manifest_static.json');
    const markerPath = path.join(dataPath, 'migration_complete.json');
    const userSettingsExists = fs.existsSync(settingsPath);
    const isMigrated = fs.existsSync(markerPath);

    try {
        if (!fs.existsSync(staticManifestPath)) {
            console.error('manifest_static.json not found. Skipping migration logic.');
        } else {
            if (!userSettingsExists) {
                console.log('[Init] Fresh install detected. Applying static manifest.');
                fs.copyFileSync(staticManifestPath, activeManifestPath);
                fs.writeFileSync(markerPath, JSON.stringify({ status: 'fresh_install', date: Date.now() }));
            } else if (userSettingsExists && !isMigrated) {
                console.log('[Init] Existing user detected. Migration required.');

                const response = dialog.showMessageBoxSync({
                    type: 'warning',
                    buttons: ['Load Old (Backup Data)', 'Ready to Migrate'],
                    defaultId: 0,
                    cancelId: 0,
                    title: 'Yomitan Update - Action Required',
                    message: 'Internal ID Migration Required',
                    detail:
                        'To prevent data loss in future updates, we need to standardize the Yomitan Extension ID.\n\n' +
                        '• Load Old: Loads the old temporary ID. Choose this to Export your Settings and Dictionaries now.\n' +
                        '• Ready to Migrate: Choose this ONLY if you have backed up your data. This will reset Yomitan to a fresh state with the permanent ID.\n\n' +
                        'This is a one-time process.',
                });

                if (response === 0) {
                    console.log('[Init] User chose to load old version.');
                } else {
                    console.log('[Init] User ready to migrate. Swapping manifest.');
                    fs.copyFileSync(staticManifestPath, activeManifestPath);
                    fs.writeFileSync(markerPath, JSON.stringify({ status: 'migrated', date: Date.now() }));
                    app.relaunch();
                    app.exit(0);
                    return;
                }
            } else if (isMigrated) {
                console.log('[Init] Migration marker found. Enforcing static manifest.');
                fs.copyFileSync(staticManifestPath, activeManifestPath);
            }
        }
    } catch (err) {
        console.error('[Init] Error during manifest swapping logic:', err);
    }

    try {
        // Load extension using the standard API
        ext = await session.defaultSession.loadExtension(yomitanDir, { allowFileAccess: true });
        console.log('Yomitan extension loaded.');
        console.log('Extension ID:', ext.id);

        if (ext && fs.existsSync(markerPath)) {
            const markerData = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
            if (!markerData.id) {
                markerData.id = ext.id;
                fs.writeFileSync(markerPath, JSON.stringify(markerData));
            }
        }
    } catch (e) {
        console.error('Failed to load Yomitan extension:', e);
    }
}

function openYomitanSettings() {
    if (!ext) {
        console.error('Cannot open Yomitan settings: extension not loaded');
        dialog.showErrorBox('Error', 'Yomitan extension is not loaded. Please restart the overlay.');
        return;
    }
    
    if (yomitanSettingsWindow && !yomitanSettingsWindow.isDestroyed()) {
        yomitanSettingsWindow.show();
        yomitanSettingsWindow.focus();
        return;
    }
    yomitanSettingsWindow = new BrowserWindow({
        width: 1100,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
        },
    });

    yomitanSettingsWindow.removeMenu();
    yomitanSettingsWindow.loadURL(`chrome-extension://${ext.id}/settings.html`);

    yomitanSettingsWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key.toLowerCase() === 'f' && input.control) {
            yomitanSettingsWindow!.webContents.send('focus-search');
            event.preventDefault();
        }
    });

    yomitanSettingsWindow.show();

    setTimeout(() => {
        if (yomitanSettingsWindow && !yomitanSettingsWindow.isDestroyed()) {
            yomitanSettingsWindow.setSize(
                yomitanSettingsWindow.getSize()[0],
                yomitanSettingsWindow.getSize()[1]
            );
            yomitanSettingsWindow.webContents.invalidate();
            yomitanSettingsWindow.show();
        }
    }, 500);
}

function openSettings() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('force-visible', true);
    }
    overlayWindow!.webContents.send('request-current-settings');
    ipcMain.once('reply-current-settings', (event, settings) => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.show();
            settingsWindow.focus();
            return;
        }
        
        const settingsHtmlPath = isDev
            ? path.join(__dirname, '../../../GSM_Overlay/settings.html')
            : path.join(getResourcesDir(), 'assets/overlay/settings.html');

        settingsWindow = new BrowserWindow({
            width: 1200,
            height: 980,
            resizable: true,
            alwaysOnTop: true,
            title: 'Overlay Settings',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            },
        });

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

        settingsWindow.removeMenu();
        settingsWindow.loadFile(settingsHtmlPath);

        settingsWindow.on('closed', () => {
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('force-visible', false);
            }
        });

        const closedListenerFunction = (event: any, type: string) => {
            settingsWindow!.webContents.send('websocket-closed', type);
        };
        const openedListenerFunction = (event: any, type: string) => {
            settingsWindow!.webContents.send('websocket-opened', type);
        };

        ipcMain.on('websocket-closed', closedListenerFunction);
        ipcMain.on('websocket-opened', openedListenerFunction);

        settingsWindow.webContents.send('preload-settings', { userSettings, websocketStates });

        settingsWindow.on('closed', () => {
            ipcMain.removeListener('websocket-closed', closedListenerFunction);
            ipcMain.removeListener('websocket-opened', openedListenerFunction);
        });

        setTimeout(() => {
            if (settingsWindow && !settingsWindow.isDestroyed()) {
                settingsWindow.setSize(settingsWindow.getSize()[0], settingsWindow.getSize()[1]);
                settingsWindow.webContents.invalidate();
                settingsWindow.show();
            }
        }, 500);
    });
}

function setupOverlayIPC() {
    // IPC handlers for wanakana and kuroshiro
    const kuroshiro = new Kuroshiro();
    kuroshiro
        .init(new KuromojiAnalyzer())
        .then(() => {
            console.log('Kuroshiro initialized');
        })
        .catch((err: any) => {
            console.error('Kuroshiro initialization failed:', err);
        });

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
            console.error('Kuroshiro conversion error:', err);
            throw err;
        }
    });

    ipcMain.on('update-window-shape', (event, shape) => {
        if (process.platform !== 'win32' && overlayWindow) {
            // update clickable area on Linux
            overlayWindow.setShape([shape]);
        }
    });

    ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
        if (!resizeMode && !yomitanShown && overlayWindow) {
            if (process.platform !== 'win32') {
                if (ignore) return;
                // On Linux, set clickable area
            } else {
                overlayWindow.setIgnoreMouseEvents(ignore, options);
            }

            if (ignore) {
                // overlayWindow.blur();
            }
        }
    });

    ipcMain.on('hide', (event, state) => {
        if (overlayWindow) overlayWindow.minimize();
    });

    ipcMain.on('show', (event, state) => {
        if (overlayWindow) {
            overlayWindow.show();
            overlayWindow.setAlwaysOnTop(true, 'screen-saver');
            overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
    });

    ipcMain.on('resize-mode', (event, state) => {
        resizeMode = state;
    });

    ipcMain.on('yomitan-event', (event, state) => {
        resetActivityTimer();
        yomitanShown = state;
        if (overlayWindow) {
            if (state) {
                if (process.platform === 'win32' || process.platform === 'darwin') {
                    overlayWindow.setIgnoreMouseEvents(false, { forward: true });
                }
            } else {
                if (process.platform === 'win32' || process.platform === 'darwin') {
                    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
                }
                if (!manualHotkeyPressed) {
                    overlayWindow.blur();
                }
                setTimeout(() => {
                    if (!resizeMode && !yomitanShown && !manualHotkeyPressed && overlayWindow) {
                        overlayWindow.blur();
                    }
                }, 100);
            }
        }
    });

    ipcMain.on('release-mouse', () => {
        if (overlayWindow) {
            overlayWindow.blur();
            setTimeout(() => overlayWindow!.focus(), 50);
        }
    });

    ipcMain.on('app-close', () => {
        app.quit();
    });

    ipcMain.on('app-minimize', () => {
        if (overlayWindow) overlayWindow.minimize();
    });

    ipcMain.on('open-yomitan-settings', () => {
        openYomitanSettings();
    });

    ipcMain.on('websocket-closed', (event, type) => {
        websocketStates[type as keyof typeof websocketStates] = false;
    });

    ipcMain.on('websocket-opened', (event, type) => {
        websocketStates[type as keyof typeof websocketStates] = true;
    });

    ipcMain.on('open-settings', () => {
        openSettings();
    });

    ipcMain.on('setting-changed', (event, { key, value }) => {
        console.log(`Setting changed: ${key} = ${value}`);
        const oldValue = (userSettings as any)[key];
        (userSettings as any)[key] = value;
        switch (key) {
            case 'showHotkey':
                registerManualShowHotkey(oldValue);
                break;
            case 'manualMode':
                registerManualShowHotkey();
                break;
            case 'afkTimer':
                resetActivityTimer();
                break;
            case 'toggleFuriganaHotkey':
                registerToggleFuriganaHotkey(oldValue);
                break;
        }
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('settings-updated', { [key]: value });
        }
        saveSettings();
    });

    ipcMain.on('text-received', (event, text) => {
        resetActivityTimer();
        if (afkHidden) {
            try {
                overlayWindow!.webContents.send('afk-hide', false);
            } catch (e) {
                console.warn('Failed to send afk-hide (restore) to renderer:', e);
            }
            afkHidden = false;
        }

        if (overlayWindow && overlayWindow.isMinimized()) {
            overlayWindow.show();
            overlayWindow.blur();
            overlayWindow.setAlwaysOnTop(true, 'screen-saver');
            overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

            setTimeout(() => {
                if (overlayWindow) overlayWindow.blur();
            }, 200);
        }

        if (userSettings.magpieCompatibility && overlayWindow) {
            overlayWindow.show();
            overlayWindow.blur();
        }
    });

    app.on('before-quit', () => {
        if (activityTimer) {
            clearTimeout(activityTimer);
        }
        saveSettings();
    });
}

export async function launchOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        console.log('Overlay is already running.');
        return;
    }

    // Load CommonJS dependencies first
    await loadOverlayDependencies();

    if (!overlayInitialized) {
        // Initialize Yomitan extension first
        await initializeYomitan();

        // Setup IPC handlers
        setupOverlayIPC();

        // Setup background manager
        const { createRequire } = await import('module');
        const require = createRequire(import.meta.url);
        const bgPath = isDev
            ? path.join(__dirname, '../../../electron-src/main/overlay/overlay_background.cjs')
            : path.join(__dirname, '../../electron-src/main/overlay/overlay_background.cjs');
        backgroundManager = require(bgPath);
        backgroundManager.start();

        // Setup global shortcuts
        globalShortcut.register('Alt+Shift+H', () => {
            if (overlayWindow) {
                overlayWindow.webContents.send('toggle-main-box');
            }
        });

        globalShortcut.register('Alt+Shift+J', () => {
            if (overlayWindow) {
                resetActivityTimer();
                if (afkHidden) {
                    try {
                        overlayWindow.webContents.send('afk-hide', false);
                    } catch (e) {
                        console.warn('Failed to send afk-hide (restore) to renderer:', e);
                    }
                    afkHidden = false;
                } else if (overlayWindow.isMinimized()) {
                    overlayWindow.restore();
                    overlayWindow.blur();
                } else overlayWindow.minimize();
            }
        });

        globalShortcut.register('Alt+Shift+Y', () => {
            openYomitanSettings();
        });

        globalShortcut.register('Alt+Shift+S', () => {
            openSettings();
        });

        globalShortcut.register('Alt+Shift+M', () => {
            userSettings.magpieCompatibility = !userSettings.magpieCompatibility;
            saveSettings();
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('new-magpieCompatibility', userSettings.magpieCompatibility);
            }
        });

        registerToggleFuriganaHotkey();
        registerManualShowHotkey();

        overlayInitialized = true;
    }

    const display = getCurrentOverlayMonitor();
    console.log('Display:', display);

    const preloadPath = isDev
        ? path.join(__dirname, '../../../electron-src/main/overlay/overlay_preload.cjs')
        : path.join(__dirname, '../../electron-src/main/overlay/overlay_preload.cjs');

    const indexPath = isDev
        ? path.join(__dirname, '../../../GSM_Overlay/index.html')
        : path.join(getResourcesDir(), 'assets/overlay/index.html');

    overlayWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height - 1,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        titleBarStyle: 'hidden',
        title: 'GSM Overlay',
        fullscreen: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            preload: preloadPath,
            webSecurity: false,
        },
        show: false,
    });

    setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            const newDisplay = getCurrentOverlayMonitor();
            overlayWindow.setBounds({
                x: newDisplay.bounds.x,
                y: newDisplay.bounds.y,
                width: newDisplay.bounds.width,
                height: newDisplay.bounds.height - 1,
            });
        }
    }, 100);

    // Monitor display changes
    backgroundManager.registerTask(
        () => {
            try {
                if (!overlayWindow || overlayWindow.isDestroyed()) {
                    return;
                }
                const newDisplay = getCurrentOverlayMonitor();
                const currentBounds = overlayWindow.getBounds();
                if (
                    currentBounds.x !== newDisplay.bounds.x ||
                    currentBounds.y !== newDisplay.bounds.y
                ) {
                    console.log('Display changed:', newDisplay);
                    overlayWindow.setBounds({
                        x: newDisplay.bounds.x,
                        y: newDisplay.bounds.y,
                        width: newDisplay.bounds.width + 1,
                        height: newDisplay.bounds.height + 1,
                    });
                }
            } catch (e) {
                console.error('display check failed', e);
            }
        },
        500
    );

    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');

    overlayWindow.on('blur', () => {
        if (overlayWindow) overlayWindow.setBackgroundColor('#00000000');
    });

    overlayWindow.on('focus', () => {
        if (overlayWindow) overlayWindow.setBackgroundColor('#00000000');
    });

    overlayWindow.loadFile(indexPath);

    if (isDev) {
        overlayWindow.webContents.on('context-menu', () => {
            if (overlayWindow) overlayWindow.webContents.openDevTools({ mode: 'detach' });
        });
    }

    overlayWindow.once('ready-to-show', () => {
        if (overlayWindow) {
            overlayWindow.show();
            if (isDev) {
                overlayWindow.webContents.openDevTools({ mode: 'detach' });
            }
            overlayWindow.webContents.send('load-settings', userSettings);
            overlayWindow.webContents.send('display-info', display);
            overlayWindow.setAlwaysOnTop(true, 'screen-saver');

            if (process.platform === 'win32') {
                overlayWindow.setIgnoreMouseEvents(true, { forward: true });
            }

            resetActivityTimer();
        }
    });

    console.log('Overlay window created');
}

export function getOverlayWindow() {
    return overlayWindow;
}
