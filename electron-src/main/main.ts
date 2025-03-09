import {app, BrowserWindow, Tray, Menu, dialog} from 'electron';
import * as path from 'path';
import {spawn, ChildProcessWithoutNullStreams} from 'child_process';
import {getOrInstallPython} from "./python_downloader";
import {APP_NAME, BASE_DIR, PACKAGE_NAME} from "./util";
import {checkForUpdates} from "./update_checker";

const {autoUpdater} = require("electron-updater");
const log = require("electron-log");

let mainWindow: BrowserWindow | null;
let tray: Tray;
let pyProc: ChildProcessWithoutNullStreams;
let isQuitting = false;
let isUpdating: boolean = false;
let restartingGSM: boolean = false;
let pythonPath: string;
const originalLog = console.log;


// Enable logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = "info";

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
                updateGSM().then(() => {
                    autoUpdater.quitAndInstall();
                });
            }
        });
});

autoUpdater.on("error", (err: any) => {
    log.error("Update error: " + err.message);
});


const isDev = !app.isPackaged;

/**
 * Get the base directory for assets.
 * Handles both development and production (ASAR) environments.
 * @returns {string} - Path to the assets directory.
 */
function getAssetsDir(): string {
    return isDev
        ? path.join(__dirname, "../../electron-src/assets") // Development path
        : path.join(process.resourcesPath, "assets"); // Production (ASAR-safe)
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
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    mainWindow.loadFile(path.join(getAssetsDir(), 'index.html'));

    mainWindow.setMenu(null);

    console.log = function (...args) {
        const message = args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' ');
        mainWindow?.webContents.send('terminal-output', `${message}\r\n`);
        originalLog.apply(console, args);
    };

    mainWindow.on('close', function (event) {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
        mainWindow = null;
    })
}

async function updateGSM() {
    isUpdating = true;
    checkForUpdates(pythonPath).then(async ({updateAvailable, latestVersion}) => {
        if (updateAvailable) {
            console.log("Closing GSM...");
            closeGSM();
            console.log(`Updating GSM Python Application to ${latestVersion}...`)
            await runCommand(pythonPath, ["-m", "pip", "install", "--upgrade", "--no-warn-script-location", "git+https://github.com/bpwhelan/GameSentenceMiner.git@main"], true, true);
            restart();
        } else {
            console.log("You're already using the latest version.");
        }
    });
}

function createTray() {
    tray = new Tray(getIconPath(16)); // Replace with a valid icon path
    const contextMenu = Menu.buildFromTemplate([
        {label: 'Show Console', click: () => mainWindow?.show()},
        {label: 'Update GSM', click: () => updateGSM()},
        {label: 'Restart GSM', click: () => restartGSM()},
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


app.whenReady().then(() => {
    if (!isDev) {
        autoUpdater.checkForUpdatesAndNotify();
    }
    createWindow();
    createTray();
    getOrInstallPython().then((path) => {
        pythonPath = path;
        ensureAndRunGSM(pythonPath).then(() => {
            if (!isUpdating) {
                quit();
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

function closeGSM(): void {
    if (pyProc !== null) {
        pyProc.stdin.write('exit\n');
    }
}

function restartGSM(): void {
    restartingGSM = true;
    if (pyProc !== null) {
        pyProc.stdin.write('exit\n');
    }
    ensureAndRunGSM(pythonPath).then(() => {
        console.log('GSM Successfully Restarted!')
    });
}

function quit(): void {
    closeGSM();
    app.quit();
}

function restart(): void {
    closeGSM();
    app.relaunch();
    app.quit();
}