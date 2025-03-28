import {app, BrowserWindow, dialog, Menu, shell, Tray} from 'electron';
import * as path from 'path';
import {ChildProcessWithoutNullStreams, spawn} from 'child_process';
import {getOrInstallPython} from "./python/python_downloader.js";
import {APP_NAME, BASE_DIR, getAssetsDir, isDev, PACKAGE_NAME} from "./util.js";
import electronUpdater, {type AppUpdater} from 'electron-updater';
import {fileURLToPath} from "node:url";

import log from 'electron-log/main.js';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp, getLaunchSteamOnStart,
    getLaunchVNOnStart, getLaunchYuzuGameOnStart,
    getStartConsoleMinimized,
    setPythonPath
} from "./store.js";
import {launchYuzuGameID, openYuzuWindow} from "./launchers/yuzu.js";
import {checkForUpdates} from "./update_checker.js";
import {launchVNWorkflow, openVNWindow} from "./launchers/vn.js";
import {launchSteamGameID, openSteamWindow} from "./launchers/steam.js";
import { webSocketManager } from "./communication/websocket.js";

let mainWindow: BrowserWindow | null = null;
let tray: Tray;
let pyProc: ChildProcessWithoutNullStreams;
export let isQuitting = false;
let isUpdating: boolean = false;
let restartingGSM: boolean = false;
let pythonPath: string;
const originalLog = console.log;

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

function getAutoUpdater(): AppUpdater {
    const { autoUpdater } = electronUpdater;
    return autoUpdater;
}

async function autoUpdate() {
    const autoUpdater = getAutoUpdater();
    // Event listeners for autoUpdater
    autoUpdater.on("update-available", () => {
        log.info("Update available.");
        dialog.showMessageBox({
            type: "info",
            title: "Update Available",
            message: "A new version is available. Downloading now...",
        });
    });

    autoUpdater.on("update-downloaded", () => {
        log.info("Update downloaded.");
        dialog
            .showMessageBox({
                type: "info",
                title: "Update Ready",
                message: "A new version has been downloaded. Restart now to install, This will also attempt to update the python app?",
                buttons: ["Restart", "Later"],
            })
            .then((result) => {
                if (result.response === 0) {
                    updateGSM(false).then(() => {
                        autoUpdater.quitAndInstall();
                    });
                }
            });
    });

    autoUpdater.on("error", (err: any) => {
        log.error("Update error: " + err.message);
    });

    autoUpdater.checkForUpdatesAndNotify();
}


function getGSMModulePath(): string {
    return "GameSentenceMiner.gsm";
}

function getIconPath(size: number = 0): string {
    const filename = size ? `icon${size}.png` : "icon.png";
    return path.join(getAssetsDir(), filename);
}

/**
 * Runs a command and returns a promise that resolves when the command exits.
 * @param command The command to run.
 * @param args The arguments to pass.
 * @param stdout
 * @param stderr
 */
function runCommand(command: string, args: string[], stdout: boolean, stderr: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);

        if (stdout) {
            proc.stdout.on("data", (data) => {
                console.log(`stdout: ${data}`);
            });
        }

        if (stderr) {
            proc.stderr.on("data", (data) => {
                console.error(`stderr: ${data}`);
            });
        }


        proc.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });

        proc.on("error", (err) => {
            reject(err);
        });
    });
}

/**
 * Runs a command and returns a promise that resolves when the command exits.
 * @param command The command to run.
 * @param args The arguments to pass.
 */
function runGSM(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);

        pyProc = proc;

        proc.stdout.on('data', (data) => {
            originalLog(`stdout: ${data}`)
            if (data.toString().toLowerCase().includes("restart_for_settings_change")) {
                console.log("Restart Required for some of the settings saved to take affect! Restarting...")
                restartGSM();
                return;
            }
            mainWindow?.webContents.send('terminal-output', data.toString());
        });

        // Capture stderr (optional)
        proc.stderr.on('data', (data) => {
            mainWindow?.webContents.send('terminal-error', data.toString());
        });

        proc.on("close", (code) => {
            if (restartingGSM) {
                restartingGSM = false;
                return;
            }
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
            if (!isUpdating) {
                app.quit()
            }
        });

        proc.on("error", (err) => {
            reject(err);
        });
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        icon: getIconPath(64),
        show: !getStartConsoleMinimized(),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
        },
    });

    mainWindow.loadFile(path.join(getAssetsDir(), 'index.html'));

    const menu = Menu.buildFromTemplate([
        {
            label: "File",
            submenu: [
                {
                    label: "Open Yuzu Launcher",
                    click: () => openYuzuWindow(),
                },
                {
                    label: "Open VN Launcher",
                    click: () => openVNWindow(),
                },
                {
                    label: "Open Steam Launcher",
                    click: () => openSteamWindow(),
                },
                { type: "separator" },
                { label: "Exit", role: "quit" },
            ],
        },
        {
            label: "Help",
            submenu: [
                {
                    label: "Open Documentation",
                    click: () => {
                        shell.openExternal("https://github.com/bpwhelan/GameSentenceMiner/wiki")
                    },
                },
                {
                    label: "Discord",
                    click: () => {
                        shell.openExternal("https://discord.gg/yP8Qse6bb8")
                    },
                },
                {
                    label: "Open Developer Console",
                    click: () => {
                        mainWindow?.webContents.openDevTools();
                    },
                }
            ],
        },
    ]);

    mainWindow.setMenu(menu);

    console.log = function (...args) {
        const message = args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' ');
        mainWindow?.webContents.send('terminal-output', `${message}\r\n`);
        originalLog.apply(console, args);
    };

    mainWindow.on('close', function (event) {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
            return;
        }
        mainWindow = null;
    })
}


async function updateGSM(shouldRestart: boolean = false): Promise<void> {
    isUpdating = true;
    checkForUpdates().then(async ({updateAvailable, latestVersion}) => {
        if (updateAvailable) {
            console.log("Update available. Closing GSM...");
            closeGSM();
            console.log(`Updating GSM Python Application to ${latestVersion}...`)
            await runCommand(pythonPath, ["-m", "pip", "install", "--upgrade", "--no-warn-script-location", "git+https://github.com/bpwhelan/GameSentenceMiner.git@main"], true, true);
            if (shouldRestart) {
                restart();
            } else {
                ensureAndRunGSM(pythonPath)
            }
        } else {
            console.log("You're already using the latest version.");
        }
    });
}

function createTray() {
    tray = new Tray(getIconPath(16)); // Replace with a valid icon path
    const contextMenu = Menu.buildFromTemplate([
        {label: 'Show Console', click: () => mainWindow?.show()},
        {label: 'Update GSM', click: () => updateGSM(false)},
        {label: 'Restart GSM', click: () => restartGSM()},
        {label: "Open GSM Folder", click: () => shell.openPath(BASE_DIR)},
        {label: 'Quit', click: () => quit()},
    ]);

    tray.setToolTip('GameSentenceMiner');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        mainWindow?.show();
    });
}

async function isPackageInstalled(pythonPath: string, packageName: string): Promise<boolean> {
    try {
        await runCommand(pythonPath, ["-m", "pip", "show", packageName], false, false);
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensures GameSentenceMiner is installed before running it.
 */
async function ensureAndRunGSM(pythonPath: string): Promise<void> {
    const isInstalled = await isPackageInstalled(pythonPath, PACKAGE_NAME);

    if (!isInstalled) {
        console.log(`${APP_NAME} is not installed. Installing now...`);
        try {
            await runCommand(pythonPath, ["-m", "pip", "install", "--no-warn-script-location", PACKAGE_NAME], true, true);
            console.log("Installation complete.");
        } catch (err) {
            console.error("Failed to install package:", err);
            process.exit(1);
        }
    }

    console.log("Starting GameSentenceMiner...");
    try {
        return await runGSM(pythonPath, ["-m", getGSMModulePath()]);
    } catch (err) {
        console.error("Failed to start GameSentenceMiner:", err);
    }
    restartingGSM = false;
}

app.setPath('userData', path.join(BASE_DIR, 'electron'));

if (!app.requestSingleInstanceLock()) {
    app.whenReady().then(() => {
        dialog.showMessageBoxSync({
            type: 'warning',
            title: 'GSM Running',
            message: 'Another instance of GSM is already running.',
            buttons: ['OK']
        });
        app.quit()
    });
} else {

    app.whenReady().then(async () => {
        if (!isDev && getAutoUpdateElectron()) {
            await autoUpdate()
        }
        if (getLaunchVNOnStart()) {
            dialog.showMessageBox(mainWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 0,
                title: 'Launch Game',
                message: 'Do you want to launch the pre-configured VN?',
            }).then(async (response) => {
                if (response.response === 0) {
                    await launchVNWorkflow(getLaunchVNOnStart());
                }
            });
        }
        if (getLaunchYuzuGameOnStart()) {
            dialog.showMessageBox(mainWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 0,
                title: 'Launch Game',
                message: 'Do you want to launch the pre-configured Yuzu Game?',
            }).then(async (response) => {
                if (response.response === 0) {
                    await launchYuzuGameID(getLaunchYuzuGameOnStart());
                }
            });
        }
        if (getLaunchSteamOnStart()) {
            dialog.showMessageBox(mainWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 0,
                title: 'Launch Game',
                message: 'Do you want to launch the pre-configured Steam Game?',
            }).then(async (response) => {
                if (response.response === 0) {
                    await launchSteamGameID(getLaunchSteamOnStart());
                }
            });
        }
        createWindow();
        createTray();
        getOrInstallPython().then(async (path: string) => {
            pythonPath = path;
            setPythonPath(pythonPath);
            ensureAndRunGSM(pythonPath).then(async () => {
                if (!isUpdating) {
                    quit();
                }
            });
        });
        if (getAutoUpdateGSMApp()) {
            console.log("Checking for Updates...")
            await updateGSM();
        }


        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                quit();
            }
        });

        app.on('before-quit', () => {
            isQuitting = true;
        });
    });
}

function closeGSM(): void {
    webSocketManager.sendQuitMessage();
}

function restartGSM(): void {
    restartingGSM = true;
    webSocketManager.sendQuitMessage();
    ensureAndRunGSM(pythonPath).then(() => {
        console.log('GSM Successfully Restarted!')
    });
}

function quit(): void {
    webSocketManager.sendQuitMessage();
    app.quit();
}

function restart(): void {
    closeGSM();
    app.relaunch();
    app.quit();
}