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
    isWindows,
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
    getRunOverlayOnStartup,
    getRunWindowTransparencyToolOnStartup,
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
import {
    registerSettingsIPC,
    runWindowTransparencyTool,
    stopWindowTransparencyTool,
    window_transparency_process,
} from './ui/settings.js';
import { registerOCRUtilsIPC, startOCR, stopOCR } from './ui/ocr.js';
import * as fs from 'node:fs';
import archiver from 'archiver';
import { registerFrontPageIPC, runOverlay } from './ui/front.js';
import { registerPythonIPC } from './ui/python.js';
import { registerStateIPC } from './communication/state.js';
import { execFile } from 'node:child_process';
import { c } from 'tar';

// Global error handling setup - catches all unhandled errors to prevent crashes
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    const errorMessage = `Unhandled Promise Rejection: ${reason}`;
    log.error('Unhandled Promise Rejection:', errorMessage);
    console.error('Unhandled Promise Rejection:', reason);

    // Show error dialog to user but don't crash
    if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox(
            'Application Error',
            'An unexpected error occurred. The application will continue running. Check the logs for details.'
        );
    }
});

process.on('uncaughtException', (error: Error) => {
    const errorMessage = `Uncaught Exception: ${error.message}`;
    log.error('Uncaught Exception:', errorMessage);
    log.error('Stack:', error.stack);
    console.error('Uncaught Exception:', error);

    // Show error dialog but don't crash
    if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox(
            'Critical Error',
            `A critical error occurred: ${error.message}\n\nThe application will continue running. Please check the logs and consider restarting.`
        );
    }
});

// Handle Electron-specific errors
app.on('render-process-gone', (event, webContents, details) => {
    const errorMessage = `Render process crashed: ${details.reason} (exit code: ${details.exitCode})`;
    log.error('Render Process Error:', errorMessage);
    console.error('Render Process Error:', errorMessage);

    dialog.showErrorBox(
        'Window Crashed',
        'The application window crashed but will be restarted automatically.'
    );

    // Recreate window if it was destroyed
    if (mainWindow && mainWindow.isDestroyed()) {
        createWindow().catch((err) => log.error('Failed to recreate window:', err));
    }
});

app.on('child-process-gone', (event, details) => {
    const errorMessage = `Child process crashed: ${details.type} - ${details.reason} (exit code: ${details.exitCode})`;
    log.error('Child Process Error:', errorMessage);
    console.error('Child Process Error:', errorMessage);
});

export let mainWindow: BrowserWindow | null = null;
let tray: Tray;
export let pyProc: ChildProcessWithoutNullStreams;
export let isQuitting = false;
let isUpdating: boolean = false;
let restartingGSM: boolean = false;
let pythonPath: string;
let pythonUpdating: boolean = false;
const originalLog = console.log;
const originalError = console.error;

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

function getAutoUpdater(forceDev: boolean = false): AppUpdater {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = false; // Disable auto download
    autoUpdater.allowPrerelease = getPullPreReleases(); // Enable pre-releases
    autoUpdater.allowDowngrade = true; // Allow downgrades
    
    // Force update if forceDev is true - configure for dev mode
    if (forceDev) {
        autoUpdater.allowDowngrade = true;
        autoUpdater.forceDevUpdateConfig = true; // Force dev update config
        // Set the update URL to the GitHub releases
        autoUpdater.setFeedURL({
            provider: 'github',
            owner: 'bpwhelan',
            repo: 'GameSentenceMiner',
            private: false,
            releaseType: getPullPreReleases() ? 'prerelease' : 'release'
        });
    }
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
    registerPythonIPC();
    registerStateIPC();
}

let gsmUpdatePromise: Promise<void> = Promise.resolve();

// --- Your refactored functions ---

/**
 * Checks for and downloads updates for the main Electron application.
 */
async function autoUpdate(forceUpdate: boolean = false): Promise<void> {
    const autoUpdater = getAutoUpdater(forceUpdate);

    autoUpdater.on('update-downloaded', async () => {
        log.info(
            'Application update downloaded. Waiting for Python update process to finish (if any)...'
        );

        await gsmUpdatePromise;

        log.info('Python process is stable. Proceeding with application restart.');

        const updateFilePath = path.join(BASE_DIR, 'update_python.flag');
        fs.writeFileSync(updateFilePath, '');
        autoUpdater.quitAndInstall();
    });

    autoUpdater.on('error', (err: any) => {
        log.error('Auto-update error: ' + err.message);
    });

    try {
        log.info('Checking for application updates...');
        const result = await autoUpdater.checkForUpdates();

        if (result !== null && result.updateInfo.version !== app.getVersion() || (result !== null && forceUpdate)) {
            log.info(`New application version available: ${result.updateInfo.version}`);
            const dialogResult = await dialog.showMessageBox({
                type: 'question',
                title: 'Update Available',
                message:
                    'A new version of the GSM Application is available. Would you like to download and install it now?',
                buttons: ['Yes', 'No'],
            });

            if (dialogResult.response === 0) {
                // "Yes" button
                log.info('User accepted. Downloading application update...');
                await autoUpdater.downloadUpdate();
                log.info('Application update download started in the background.');
            } else {
                log.info('User declined the application update.');
            }
        } else {
            log.info('Application is up to date. Current version: ' + app.getVersion());
        }
    } catch (err: any) {
        log.error('Failed to check for application updates: ' + err.message);
    }
}

/**
 * The main entry point to run all update checks in the correct order.
 * @param shouldRestart - Whether to restart the Python process after updating.
 * @param force - Force the Python update even if versions match.
 */
async function runUpdateChecks(
    shouldRestart: boolean = false,
    force: boolean = false,
    forceDev: boolean = false
): Promise<void> {
    log.info('Starting full update process...');

    // **IMPROVEMENT**: Run the Python update FIRST and wait for it to complete.
    await updateGSM(true, force);
    log.info('Python backend update check is complete.');

    // **IMPROVEMENT**: Only AFTER the Python update is done, check for the main app update.
    await autoUpdate(forceDev);
    log.info('Application update check is complete.');

}

/**
 * Manages and runs the update process for the Python backend (GSM).
 */
async function updateGSM(shouldRestart: boolean = false, force: boolean = false): Promise<void> {
    // **IMPROVEMENT**: The execution of the internal logic is assigned to our tracker promise.
    // Anyone awaiting gsmUpdatePromise will now wait for this specific operation to finish.
    gsmUpdatePromise = _updateGSMInternal(shouldRestart, force);
    await gsmUpdatePromise;
}

/**
 * The internal implementation of the Python update logic.
 */
async function _updateGSMInternal(
    shouldRestart: boolean = false,
    force: boolean = false
): Promise<void> {
    // The pythonUpdating flag is no longer needed for coordination.
    isUpdating = true;
    try {
        const { updateAvailable, latestVersion } = await checkForUpdates();
        if (updateAvailable || force) {
            if (pyProc) {
                await closeAllPythonProcesses();
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
            log.info(`Updating GSM Python Application to ${latestVersion}...`);

            await checkAndInstallUV(pythonPath);

            try {
                await runCommand(
                    pythonPath,
                    ['-m', 'uv', 'pip', 'install', '--upgrade', '--prerelease=allow', PACKAGE_NAME],
                    true,
                    true
                );
            } catch (err) {
                log.error(
                    'Failed to install custom Python package. Falling back to default package and forcing upgrade.',
                    err
                );
                await cleanCache();
                await runCommand(
                    pythonPath,
                    ['-m', 'uv', 'pip', 'install', '--upgrade', '--prerelease=allow', PACKAGE_NAME],
                    true,
                    true
                );
            }

            log.info('Python update completed successfully.');
            new Notification({
                title: 'Update Successful',
                body: `${APP_NAME} backend has been updated successfully.`,
                timeoutType: 'default',
            }).show();

            if (shouldRestart) {
                await ensureAndRunGSM(pythonPath);
                log.info('GSM Successfully Restarted after update!');
            }
        } else {
            log.info('Python backend is already up-to-date.');
        }
    } catch (error) {
        log.error('An error occurred during the Python update process:', error);
        // Optionally re-throw or display an error to the user
    } finally {
        // **IMPROVEMENT**: Use a finally block to ensure state is always cleaned up.
        isUpdating = false;
        log.info('Finished Python update internal process.');
    }
}

function getGSMModulePath(): string {
    return 'GameSentenceMiner.gsm';
}

function getIconPath(size: number = 0): string {
    let filename = 'icon.png';
    if (isWindows()) {
        filename = 'gsm.ico';
    }
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

async function cleanCache(): Promise<void> {
    await runCommand(pythonPath, ['-m', 'uv', 'cache', 'clean'], true, true);
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
                setTimeout(() => {
                    app.quit();
                }, 2000);
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

    // Remove menu from any new windows created via window.open (e.g. target="_blank")
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
        child.setMenu(null); // Remove menu
        child.loadURL(url);
        return { action: 'deny' }; // Prevent Electron's default window creation
    });

    registerIPC();

    mainWindow.loadFile(path.join(getAssetsDir(), 'index.html'));

    const menu = Menu.buildFromTemplate([
        {
            label: 'File',
            submenu: [
                { label: 'Update GSM', click: () => runUpdateChecks(true, true) },
                { label: 'Restart Python App', click: () => restartGSM() },
                { label: 'Open GSM Folder', click: () => shell.openPath(BASE_DIR) },
                { label: 'Export Logs', click: () => zipLogs() },
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

    console.error = function (...args) {
        const message = args
            .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg))
            .join(' ');
        mainWindow?.webContents.send('terminal-error', `${message}\r\n`);
        originalError.apply(console, args);
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

function createTray() {
    tray = new Tray(getIconPath(32)); // Replace with a valid icon path
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Update GSM', click: () => runUpdateChecks(true, true) },
        { label: 'Restart Python App', click: () => restartGSM() },
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

export async function isPackageInstalled(
    pythonPath: string,
    packageName: string
): Promise<boolean> {
    try {
        await runCommand(pythonPath, ['-m', 'pip', 'show', packageName], false, false);
        return true;
    } catch {
        return false;
    }
}

async function startWebSocketServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        webSocketManager
            .startServer()
            .then((port) => {
                console.log(`WebSocket server started on port ${port}`);
                resolve();
            })
            .catch((error) => {
                console.error('Failed to start WebSocket server:', error);
                reject(error);
            });
    });
}

export async function checkAndInstallUV(pythonPath: string): Promise<void> {
    const isuvInstalled = await isPackageInstalled(pythonPath, 'uv');
    if (!isuvInstalled) {
        console.log(`uv is not installed. Installing now...`);
        try {
            await execFileAsync(pythonPath, [
                '-m',
                'pip',
                'install',
                '--no-warn-script-location',
                'uv',
            ]);
            console.log('uv installation complete.');
        } catch (err) {
            console.error('Failed to install uv:', err);
            process.exit(1);
        }
    }
}

/**
 * Ensures GameSentenceMiner is installed before running it.
 */
async function ensureAndRunGSM(pythonPath: string, retry = 1): Promise<void> {
    const isInstalled = await isPackageInstalled(pythonPath, APP_NAME);

    await checkAndInstallUV(pythonPath);

    if (!isInstalled) {
        console.log(`${APP_NAME} is not installed. Installing now...`);
        try {
            await runCommand(
                pythonPath,
                ['-m', 'uv', 'pip', 'install', '--prerelease=allow', PACKAGE_NAME],
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
        if (!isDev && retry > 0) {
            console.log(
                "Looks like something's broken with GSM, attempting to repair the installation..."
            );
            await cleanCache();
            await runCommand(
                pythonPath,
                [
                    '-m',
                    'uv',
                    'pip',
                    'install',
                    '--force-reinstall',
                    '--prerelease=allow',
                    PACKAGE_NAME,
                ],
                true,
                true
            );
            console.log('reinstall complete, retrying to start GSM...');
            await ensureAndRunGSM(pythonPath, retry - 1);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    restartingGSM = false;
}

async function processArgsAndStartSettings() {
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
        } else if (args[i] === '--force-python-update') {
            await updateGSM(true, true);
        } else if (args[i] === '--force-all-updates') {
            await runUpdateChecks(true, true, true);
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

    if (getRunOverlayOnStartup()) {
        runOverlay();
    }

    if (getRunWindowTransparencyToolOnStartup()) {
        runWindowTransparencyTool();
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
        processArgsAndStartSettings().then((_) => console.log('Processed Args'));
        if (getAutoUpdateGSMApp()) {
            if (await isConnected()) {
                console.log('Checking for updates...');
                await autoUpdate();
            }
        }
        createWindow().then(async () => {
            createTray();
            startWebSocketServer().then(() => {
                console.log('WebSocket server started successfully.');
            });
            const pyPath = await getOrInstallPython();
            pythonPath = pyPath;
            setPythonPath(pythonPath);
            if (fs.existsSync(path.join(BASE_DIR, 'update_python.flag'))) {
                await updateGSM(false, true);
                if (fs.existsSync(path.join(BASE_DIR, 'update_python.flag'))) {
                    fs.unlinkSync(path.join(BASE_DIR, 'update_python.flag'));
                }
            } else if (getAutoUpdateGSMApp()) {
                await updateGSM(false, false);
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

            checkForUpdates().then(({ updateAvailable, latestVersion }) => {
                if (updateAvailable) {
                    const notification = new Notification({
                        title: 'Update Available',
                        body: `A new version of ${APP_NAME} python package is available: ${latestVersion}. Click here to update.`,
                        timeoutType: 'default',
                    });

                    notification.on('click', async () => {
                        console.log('Notification Clicked, Updating GSM...');
                        await runUpdateChecks(true, false);
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
        console.log(`Running command: ${pythonPath} -m uv pip install --upgrade ${packageName}`);
        await new Promise<void>((resolve, reject) => {
            const child = execFile(pythonPath, [
                '-m',
                'uv',
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

async function closeAllPythonProcesses(): Promise<void> {
    await closeGSM();
    await stopOCR();
    await stopWindowTransparencyTool();
}

async function closeGSM(): Promise<void> {
    if (!pyProc) return;
    restartingGSM = true;
    stopScripts();
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

export { closeGSM, restartGSM };

export async function stopScripts(): Promise<void> {
    if (window_transparency_process && !window_transparency_process.killed) {
        console.log('Stopping existing Window Transparency Tool process');
        window_transparency_process.stdin.write('exit\n');
        setTimeout(() => {
            window_transparency_process.kill();
        }, 1000);
    }
}

async function zipLogs(): Promise<void> {
    try {
        // Get the logs directory path
        const logsDir = path.join(BASE_DIR, 'logs');

        // Pop dialog to ask if they want to include temp files like OCR Screenshots, Anki Screenshots, Anki Audio, etc.
        const { response } = await dialog.showMessageBox(mainWindow!, {
            type: 'question',
            title: 'Include Temporary Files?',
            message:
                'Do you want to include temporary files like OCR Screenshots, GSM-Created Screenshots, GSM-Created Audio, etc. in the export? This may help with debugging but will increase the size of the export.\n\nPlease be aware of the privacy implications of including these files. They should mostly just be screenshots of your game or application, but please review them if you have any concerns.',
            buttons: ['Yes', 'No'],
        });

        const tempDir = path.join(BASE_DIR, 'temp');

        // Check if logs directory exists
        if (!fs.existsSync(logsDir)) {
            dialog.showErrorBox(
                'No Logs Found',
                'No logs directory found. No logs have been generated yet.'
            );
            return;
        }

        // Read all files in logs directory
        const files = fs
            .readdirSync(logsDir)
            .filter((file) => file.includes('.log') || file.includes('.txt'));

        // Read all files in temp directory
        let tempFiles: string[] = [];
        if (fs.existsSync(tempDir) && response === 0) {
            tempFiles = fs
                .readdirSync(tempDir)
                .filter((file) => fs.statSync(path.join(tempDir, file)).isFile());
        }

        if (files.length === 0) {
            dialog.showErrorBox('No Log Files', 'No log files found in the logs directory.');
            return;
        }

        // Show save dialog
        const downloadsDir = app.getPath('downloads');
        const result = await dialog.showSaveDialog(mainWindow!, {
            title: 'Save GSM Logs Archive',
            defaultPath: path.join(
                downloadsDir,
                `GSM_Logs_${new Date().toISOString().slice(0, 10)}.zip`
            ),
            filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        });

        if (result.canceled || !result.filePath) {
            return;
        }

        // Create archive
        const output = fs.createWriteStream(result.filePath);
        const archive = archiver('zip', {
            zlib: { level: 9 }, // Sets the compression level
        });

        // Handle archive events
        output.on('close', () => {
            console.log(`Archive created successfully: ${archive.pointer()} total bytes`);
            dialog
                .showMessageBox(mainWindow!, {
                    type: 'info',
                    title: 'Logs Exported',
                    message: `Logs successfully exported to:\n${result.filePath}`,
                    buttons: ['OK', 'Open Folder'],
                })
                .then((response) => {
                    if (response.response === 1) {
                        // Open folder containing the zip file
                        shell.showItemInFolder(result.filePath!);
                    }
                });
        });

        archive.on('error', (err: Error) => {
            console.error('Archive error:', err);
            dialog.showErrorBox('Export Failed', `Failed to create logs archive: ${err.message}`);
        });

        // Pipe archive data to the file
        archive.pipe(output);

        // Add all log files to the archive
        files.forEach((file) => {
            const filePath = path.join(logsDir, file);
            archive.file(filePath, { name: file });
        });

        tempFiles.forEach((file) => {
            const filePath = path.join(tempDir, file);
            archive.file(filePath, { name: `temp/${file}` });
        });

        // Finalize the archive
        await archive.finalize();
    } catch (error) {
        console.error('Error zipping logs:', error);
        dialog.showErrorBox('Export Failed', `Failed to export logs: ${(error as Error).message}`);
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
