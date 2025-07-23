import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    MenuItem,
    shell,
    Tray,
    Notification,
} from 'electron';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { getOrInstallPython } from './python/python_downloader.js';
import {
    APP_NAME,
    BASE_DIR,
    execFileAsync,
    getAssetsDir,
    getGSMBaseDir,
    isConnected,
    isDev,
    PACKAGE_NAME,
} from './util.js';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import { fileURLToPath } from 'node:url';

import log from 'electron-log/main.js';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp,
    getCustomPythonPackage,
    getLaunchSteamOnStart,
    getLaunchVNOnStart,
    getLaunchYuzuGameOnStart,
    getPullPreReleases,
    getStartConsoleMinimized,
    setPythonPath,
    setWindowName,
} from './store.js';
import { launchYuzuGameID, openYuzuWindow, registerYuzuIPC } from './ui/yuzu.js';
import { checkForUpdates } from './update_checker.js';
import { launchVNWorkflow, openVNWindow, registerVNIPC } from './ui/vn.js';
import { launchSteamGameID, openSteamWindow, registerSteamIPC } from './ui/steam.js';
import { webSocketManager } from './communication/websocket.js';
import { getOBSConnection, openOBSWindow, registerOBSIPC, setOBSScene } from './ui/obs.js';
import { registerSettingsIPC, window_transparency_process } from './ui/settings.js';
import { registerOCRUtilsIPC, startOCR } from './ui/ocr.js';
import * as fs from 'node:fs';
import { registerFrontPageIPC } from './ui/front.js';
import { execFile } from 'node:child_process';

export let mainWindow: BrowserWindow | null = null;
let tray: Tray;
let pyProc: ChildProcessWithoutNullStreams;
export let isQuitting = false;
let isUpdating: boolean = false;
let restartingGSM: boolean = false;
let pythonPath: string;
let pythonUpdating: boolean = false;
const originalLog = console.log;

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

function getAutoUpdater(): AppUpdater {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = false; // Disable auto download
    autoUpdater.allowPrerelease = getPullPreReleases(); // Enable pre-releases
    autoUpdater.allowDowngrade = true; // Allow downgrades
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

    autoUpdater.on('update-downloaded', async () => {
        log.info('Update downloaded.');
        const updateFilePath = path.join(BASE_DIR, 'update_python.flag');
        fs.writeFileSync(updateFilePath, '');

        while (pythonUpdating) {
            await new Promise((resolve) => setTimeout(resolve, 100)); // Wait for 100ms
        }

        autoUpdater.quitAndInstall();
    });

    autoUpdater.on('error', (err: any) => {
        log.error('Update error: ' + err.message);
    });

    // await autoUpdater.checkForUpdatesAndNotify();
    await autoUpdater.checkForUpdates().then((result) => {
        if (result !== null && result.updateInfo.version !== app.getVersion()) {
            log.info('Update available.');
            dialog
                .showMessageBox({
                    type: 'question',
                    title: 'Update Available',
                    message:
                        'A new version of the GSM Application is available. Would you like to download and install it now?',
                    buttons: ['Yes', 'No'],
                })
                .then(async (result) => {
                    if (result.response === 0) {
                        // "Yes" button
                        await autoUpdater.downloadUpdate();
                    } else {
                        log.info('User chose not to download the update.');
                    }
                });
        } else {
            console.log('No update available. Current version: ' + app.getVersion());
        }
    });
}

function getGSMModulePath(): string {
    return 'GameSentenceMiner.gsm';
}

function getIconPath(size: number = 0): string {
    const filename = size ? `icon${size}.png` : 'icon.png';
    return path.join(getAssetsDir(), filename);
}

/**
 * Runs a command and returns a promise that resolves when the command exits.
 * @param command The command to run.
 * @param args The arguments to pass.
 * @param stdout
 * @param stderr
 */
async function runCommand(
    command: string,
    args: string[],
    stdout: boolean,
    stderr: boolean
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);

        if (stdout) {
            proc.stdout.on('data', (data) => {
                console.log(`stdout: ${data}`);
            });
        }

        if (stderr) {
            proc.stderr.on('data', (data) => {
                console.error(`stderr: ${data}`);
            });
        }

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });

        proc.on('error', (err) => {
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
            originalLog(`stdout: ${data}`);
            if (data.toString().toLowerCase().includes('restart_for_settings_change')) {
                console.log(
                    'Restart Required for some of the settings saved to take affect! Restarting...'
                );
                restartGSM();
                return;
            }
            mainWindow?.webContents.send('terminal-output', data.toString());
        });

        // Capture stderr (optional)
        proc.stderr.on('data', (data) => {
            mainWindow?.webContents.send('terminal-error', data.toString());
        });

        proc.on('close', (code) => {
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
                app.quit();
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 1000,
        icon: getIconPath(32),
        show: !getStartConsoleMinimized(),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
            nodeIntegrationInSubFrames: true,
            backgroundThrottling: false,
        },
        title: `${APP_NAME} v${app.getVersion()}`,
    });

    registerIPC();

    mainWindow.loadFile(path.join(getAssetsDir(), 'index.html'));

    const menu = Menu.buildFromTemplate([
        {
            label: 'File',
            submenu: [
                { label: 'Update GSM', click: () => update(true, false) },
                { label: 'Restart GSM', click: () => restartGSM() },
                { label: 'Open GSM Folder', click: () => shell.openPath(BASE_DIR) },
                { type: 'separator' },
                { label: 'Quit', click: async () => await quit() },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Open Documentation',
                    click: () => {
                        shell.openExternal('https://github.com/bpwhelan/GameSentenceMiner/wiki');
                    },
                },
                {
                    label: 'Discord',
                    click: () => {
                        shell.openExternal('https://discord.gg/yP8Qse6bb8');
                    },
                },
                {
                    label: 'Open Developer Console',
                    click: () => {
                        mainWindow?.webContents.openDevTools();
                    },
                },
            ],
        },
    ]);

    if (isDev) {
        menu.append(
            new MenuItem({
                label: 'Refresh',
                click: () => {
                    if (mainWindow) {
                        mainWindow.reload();
                    }
                },
            })
        );
    }

    mainWindow.setMenu(menu);

    console.log = function (...args) {
        const message = args
            .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg))
            .join(' ');
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
    });
}

async function update(shouldRestart: boolean = false, force = false): Promise<void> {
    await updateGSM(shouldRestart, force);
    await autoUpdate();
}

async function updateGSM(shouldRestart: boolean = false, force = false): Promise<void> {
    isUpdating = true;
    pythonUpdating = true;
    const { updateAvailable, latestVersion } = await checkForUpdates();
    if (updateAvailable || force) {
        if (pyProc) {
            await closeGSM();
        }
        console.log(`Updating GSM Python Application to ${latestVersion}...`);
        try {
            await runCommand(
                pythonPath,
                ['-m', 'pip', 'install', '--upgrade', 'setuptools', 'wheel'],
                true,
                true
            );
            await runCommand(
                pythonPath,
                [
                    '-m',
                    'pip',
                    'install',
                    '--upgrade',
                    '--no-warn-script-location',
                    getCustomPythonPackage(),
                ],
                true,
                true
            );
        } catch (err) {
            console.error(
                'Failed to install custom Python package. Falling back to default package: GameSentenceMiner, forcing upgrade.',
                err
            );
            await runCommand(
                pythonPath,
                [
                    '-m',
                    'pip',
                    'install',
                    '--upgrade',
                    '--no-warn-script-location',
                    'GameSentenceMiner',
                ],
                true,
                true
            );
        }
        console.log('Update completed successfully.');
        new Notification({
            title: 'Update Successful',
            body: `${APP_NAME} has been updated successfully.`,
            timeoutType: 'default',
        }).show();
        if (shouldRestart) {
            ensureAndRunGSM(pythonPath).then((r) => {
                console.log('GSM Successfully Restarted!');
            });
        }
    } else {
        console.log("You're already using the latest version.");
    }
    pythonUpdating = false;
}

function createTray() {
    tray = new Tray(getIconPath(32)); // Replace with a valid icon path
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Update GSM', click: () => update(true, false) },
        { label: 'Restart GSM', click: () => restartGSM() },
        { label: 'Open GSM Folder', click: () => shell.openPath(BASE_DIR) },
        { label: 'Quit', click: () => quit() },
    ]);

    tray.setToolTip('GameSentenceMiner');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        showWindow();
    });
}

function showWindow() {
    mainWindow?.show();
    //     tray.destroy();
}

async function isPackageInstalled(pythonPath: string, packageName: string): Promise<boolean> {
    try {
        await runCommand(pythonPath, ['-m', 'pip', 'show', packageName], false, false);
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
            await runCommand(
                pythonPath,
                ['-m', 'pip', 'install', '--no-warn-script-location', PACKAGE_NAME],
                true,
                true
            );
            console.log('Installation complete.');
        } catch (err) {
            console.error('Failed to install package:', err);
            process.exit(1);
        }
    }

    console.log('Starting GameSentenceMiner...');
    try {
        return await runGSM(pythonPath, ['-m', getGSMModulePath()]);
    } catch (err) {
        console.error('Failed to start GameSentenceMiner:', err);
        if (isDev && retry > 0) {
            console.log('Retrying installation of GameSentenceMiner...');
            await runCommand(
                pythonPath,
                ['-m', 'pip', 'install', '--no-warn-script-location', '.'],
                true,
                true
            );
            console.log('after run command');
            await ensureAndRunGSM(pythonPath, retry - 1);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    restartingGSM = false;
}

async function processArgs() {
    const args = process.argv.slice(1);
    let gameName: string | undefined;
    let windowName: string | undefined;
    let runOCR = false;

    await getOBSConnection();

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--scene' && args[i + 1]) {
            await setOBSScene(args[i + 1]);
            i++;
        } else if (args[i] === '--game' && args[i + 1]) {
            gameName = args[i + 1];
            i++;
        } else if (args[i] === '--window' && args[i + 1]) {
            windowName = args[i + 1];
            i++;
        } else if (args[i] === '--ocr') {
            runOCR = true;
        }
    }

    if (windowName) {
        setWindowName(windowName);
    }
    if (gameName) {
        await launchSteamGameID(gameName);
    }
    if (runOCR) {
        await startOCR();
    }
}

app.disableHardwareAcceleration();
app.setPath('userData', path.join(BASE_DIR, 'electron'));

if (!app.requestSingleInstanceLock()) {
    app.whenReady().then(() => {
        dialog.showMessageBoxSync({
            type: 'warning',
            title: 'GSM Running',
            message: 'Another instance of GSM is already running.',
            buttons: ['OK'],
        });
        app.quit();
    });
} else {
    app.whenReady().then(async () => {
        processArgs().then((_) => console.log('Processed Args'));
        if (getAutoUpdateElectron()) {
            if (await isConnected()) {
                console.log('Checking for updates...');
                await autoUpdate();
            }
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
                try {
                    ensureAndRunGSM(pythonPath).then(async () => {
                        if (!isUpdating) {
                            quit();
                        }
                    });
                } catch (err) {
                    console.log('Failed to run GSM, attempting repair of python package...', err);
                    await updateGSM(true, true);
                }
            });

            checkForUpdates().then(({ updateAvailable, latestVersion }) => {
                if (updateAvailable) {
                    const notification = new Notification({
                        title: 'Update Available',
                        body: `A new version of ${APP_NAME} python package is available: ${latestVersion}. Click here to update.`,
                        timeoutType: 'default',
                    });

                    notification.on('click', async () => {
                        console.log('Notification Clicked, Updating GSM...');
                        await update(true, false);
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

export async function runPipInstall(packageName: string): Promise<void> {
    const pythonPath = await getOrInstallPython();
    await closeGSM();

    console.log(`Running pip install for package: ${packageName}`);
    try {
        console.log(`Running command: ${pythonPath} -m pip install --upgrade ${packageName}`);
        await new Promise<void>((resolve, reject) => {
            const child = execFile(pythonPath, [
                '-m',
                'pip',
                'install',
                '--upgrade',
                '--force-reinstall',
                packageName,
            ]);
            child.stdout?.on('data', (data) => {
                console.log(data.toString());
            });
            child.stderr?.on('data', (data) => {
                console.error(data.toString());
            });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`pip install exited with code ${code}`));
                }
            });
        });
        console.log(`Package ${packageName} installed successfully.`);
    } catch (error) {
        console.error(`Failed to install package ${packageName}:`, error);
        throw error;
    }
    await ensureAndRunGSM(pythonPath);
}

async function closeGSM(): Promise<void> {
    restartingGSM = true;
    const messageSent = await webSocketManager.sendQuitMessage();
    if (messageSent) {
        console.log('Quit message sent to GSM.');
    } else {
        console.log('Killing');
        pyProc?.kill();
    }
}

async function restartGSM(): Promise<void> {
    restartingGSM = true;
    webSocketManager.sendQuitMessage().then(() => {
        ensureAndRunGSM(pythonPath).then(() => {
            console.log('GSM Successfully Restarted!');
        });
    });
}

async function stopScripts(): Promise<void> {
    if (window_transparency_process && !window_transparency_process.killed) {
        console.log('Stopping existing Window Transparency Tool process');
        window_transparency_process.stdin.write('exit\n');
        setTimeout(() => {
            window_transparency_process.kill();
        }, 1000);
    }
}

async function quit(): Promise<void> {
    await stopScripts();
    if (pyProc != null) {
        await closeGSM();
        await webSocketManager.stopServer();
        app.quit();
    } else {
        await webSocketManager.stopServer();
        app.quit();
    }
}

async function restart(): Promise<void> {
    await closeGSM();
    app.relaunch();
    app.quit();
}
