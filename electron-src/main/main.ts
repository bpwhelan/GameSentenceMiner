import {app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray, Notification} from 'electron';
import * as path from 'path';
import {ChildProcessWithoutNullStreams, spawn} from 'child_process';
import {getOrInstallPython} from "./python/python_downloader.js";
import {APP_NAME, BASE_DIR, getAssetsDir, getGSMBaseDir, isDev, PACKAGE_NAME} from "./util.js";
import electronUpdater, {type AppUpdater} from 'electron-updater';
import {fileURLToPath} from "node:url";

import log from 'electron-log/main.js';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp, getCustomPythonPackage, getLaunchSteamOnStart,
    getLaunchVNOnStart, getLaunchYuzuGameOnStart,
    getStartConsoleMinimized,
    setPythonPath
} from "./store.js";
import {launchYuzuGameID, openYuzuWindow, registerYuzuIPC} from "./ui/yuzu.js";
import {checkForUpdates} from "./update_checker.js";
import {launchVNWorkflow, openVNWindow, registerVNIPC} from "./ui/vn.js";
import {launchSteamGameID, openSteamWindow, registerSteamIPC} from "./ui/steam.js";
import {webSocketManager} from "./communication/websocket.js";
import {openOBSWindow, registerOBSIPC} from "./ui/obs.js";
import {registerSettingsIPC} from "./ui/settings.js";
import {registerOCRUtilsIPC} from "./ui/ocr.js";
import * as fs from "node:fs";
import {registerFrontPageIPC} from "./ui/front.js";

export let mainWindow: BrowserWindow | null = null;
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
    const {autoUpdater} = electronUpdater;
    return autoUpdater;
}

function registerIPC() {
    registerVNIPC();
    registerYuzuIPC();
    registerOBSIPC();
    registerSteamIPC();
    registerSettingsIPC();
    registerOCRUtilsIPC();
    registerFrontPageIPC();
}

async function autoUpdate() {
    const autoUpdater = getAutoUpdater();
    // autoUpdater.on("update-available", () => {
    //     log.info("Update available.");
    //     dialog.showMessageBox({
    //         type: "info",
    //         title: "Update Available",
    //         message: "A new version is available. Downloading now...",
    //     });
    // });

    autoUpdater.on("update-downloaded", () => {
        log.info("Update downloaded.");
        const updateFilePath = path.join(BASE_DIR, 'update_python.flag');
        fs.writeFileSync(updateFilePath, '');
        autoUpdater.quitAndInstall();
    });

    autoUpdater.on("error", (err: any) => {
        log.error("Update error: " + err.message);
    });

    // await autoUpdater.checkForUpdatesAndNotify();
    await autoUpdater.checkForUpdates().then((result) => {
        if (result !== null && result.updateInfo.version !== app.getVersion()) {
            log.info("Update available.");
            dialog.showMessageBox({
                type: "question",
                title: "Update Available",
                message: "A new version of the GSM Application is available. Would you like to download and install it now?",
                buttons: ["Yes", "No"],
            }).then(async (result) => {
                if (result.response === 0) { // "Yes" button
                    await updateGSM(true, false)
                    await autoUpdater.downloadUpdate();
                } else {
                    log.info("User chose not to download the update.");
                }
            });
        } else {
            console.log("No update available. Current version: " + app.getVersion());
        }
    });
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
async function runCommand(command: string, args: string[], stdout: boolean, stderr: boolean): Promise<void> {
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

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        icon: getIconPath(32),
        show: !getStartConsoleMinimized(),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
            nodeIntegrationInSubFrames: true
        },
        title: `${APP_NAME} v${app.getVersion()}`,
    });

    registerIPC();

    mainWindow.loadFile(path.join(getAssetsDir(), 'index.html'));

    const menu = Menu.buildFromTemplate([
        {
            label: "File",
            submenu: [
                {label: 'Update GSM', click: () => update(true, false)},
                {label: 'Restart GSM', click: () => restartGSM()},
                {label: "Open GSM Folder", click: () => shell.openPath(BASE_DIR)},
                {type: "separator"},
                {label: 'Quit', click: async () => await quit()},
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
//             createTray();
            return;
        }
        mainWindow = null;
    })
}

async function update(shouldRestart: boolean = false, force = false): Promise<void> {
    await updateGSM(shouldRestart, force)
    await autoUpdate()
}

async function updateGSM(shouldRestart: boolean = false, force = false): Promise<void> {
    isUpdating = true;
    const {updateAvailable, latestVersion} = await checkForUpdates();
    if (updateAvailable || force) {
        if (pyProc) {
            await closeGSM();
        }
        console.log(`Updating GSM Python Application to ${latestVersion}...`)
        try {
            await runCommand(pythonPath, ["-m", "pip", "install", "--upgrade", "--no-warn-script-location", getCustomPythonPackage()], true, true);
        } catch (err) {
            console.error("Failed to install custom Python package. Falling back to default package: GameSentenceMiner, forcing upgrade.", err);
            await runCommand(pythonPath, ["-m", "pip", "install", "--upgrade", "--no-warn-script-location", "GameSentenceMiner"], true, true);
        }
        if (shouldRestart) {
            ensureAndRunGSM(pythonPath).then(r => {
                console.log('GSM Successfully Restarted!')
            });
        }
    } else {
        console.log("You're already using the latest version.");
    }
}

function createTray() {
    tray = new Tray(getIconPath(32)); // Replace with a valid icon path
    const contextMenu = Menu.buildFromTemplate([
        {label: 'Update GSM', click: () => update(true, false)},
        {label: 'Restart GSM', click: () => restartGSM()},
        {label: "Open GSM Folder", click: () => shell.openPath(BASE_DIR)},
        {label: 'Quit', click: () => quit()},
    ]);

    tray.setToolTip('GameSentenceMiner');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        showWindow()
    });
}

function showWindow() {
    mainWindow?.show();
//     tray.destroy();
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
async function ensureAndRunGSM(pythonPath: string, retry = 1): Promise<void> {
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
        if (isDev && retry > 0) {
            console.log("Retrying installation of GameSentenceMiner...");
            await runCommand(pythonPath, ["-m", "pip", "install", "--no-warn-script-location", '.'], true, true);
            console.log("after run command")
            await ensureAndRunGSM(pythonPath, retry - 1);
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
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
        createWindow().then(async () => {
            createTray();
            getOrInstallPython().then(async (pyPath: string) => {
                pythonPath = pyPath;
                setPythonPath(pythonPath);
                if (fs.existsSync(path.join(BASE_DIR, 'update_python.flag'))) {
                    await updateGSM(false, true);
                    if (fs.existsSync(path.join(BASE_DIR, 'update_python.flag'))) {
                        fs.unlinkSync(path.join(BASE_DIR, 'update_python.flag'));
                    }
                }
                ensureAndRunGSM(pythonPath).then(async () => {
                    if (!isUpdating) {
                        quit();
                    }
                });
            });

            checkForUpdates().then(({updateAvailable, latestVersion}) => {
                if (updateAvailable) {
                    const notification = new Notification({
                        title: 'Update Available',
                        body: `A new version of ${APP_NAME} python package is available: ${latestVersion}. Click here to update.`,
                        timeoutType: 'default',
                    });

                    notification.on('click', async () => {
                        console.log("Notification Clicked, Updating GSM...");
                        await updateGSM(true).then(() => {
                        });
                    });

                    notification.show();
                    setTimeout(() => notification.close(), 5000); // Close after 5 seconds
                }
            });
        });

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

async function closeGSM(): Promise<void> {
    restartingGSM = true;
    const messageSent = await webSocketManager.sendQuitMessage();
    if (messageSent) {
        console.log("Quit message sent to GSM.");
    } else {
        console.log("Killing");
        pyProc?.kill();
    }
}

async function restartGSM(): Promise<void> {
    restartingGSM = true;
    webSocketManager.sendQuitMessage().then(() => {
        ensureAndRunGSM(pythonPath).then(() => {
            console.log('GSM Successfully Restarted!')
        });
    });
}

async function quit(): Promise<void> {
    if (pyProc != null) {
        await closeGSM();
        app.quit();
    } else {
        app.quit();
    }
}

async function restart(): Promise<void> {
    await closeGSM();
    app.relaunch();
    app.quit();
}