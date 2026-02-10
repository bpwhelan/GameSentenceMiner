import {
    app,
    BrowserWindow,
    dialog,
    Menu,
    MenuItem,
    shell,
    Tray,
    Notification,
} from 'electron';
import { sendNotificationFromPython } from './notifications.js';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { getOrInstallPython } from './python/python_downloader.js';
import {
    APP_NAME,
    BASE_DIR,
    execFileAsync,
    getAssetsDir,
    getRendererEntryPath,
    getSecureWebPreferences,
    getSanitizedPythonEnv,
    getWindowsNamedPythonExecutable,
    isConnected,
    isDev,
    isWindows,
    PACKAGE_NAME,
} from './util.js';
import { fileURLToPath } from 'node:url';

import log from 'electron-log/main.js';
import {
    getAutoUpdateGSMApp,
    getPythonExtras,
    getRunOverlayOnStartup,
    getRunWindowTransparencyToolOnStartup,
    getStartConsoleMinimized,
    getElectronAppVersion,
    setPythonPath,
    setElectronAppVersion,
    getIconStyle,
    setPythonExtras,
} from './store.js';
import { checkForUpdates } from './update_checker.js';
import { launchSteamGameID } from './ui/steam.js';
import { GSMStdoutManager } from './communication/pythonIPC.js';
import { getOBSConnection, setOBSScene } from './ui/obs.js';
import {
    runWindowTransparencyTool,
    stopWindowTransparencyTool,
    window_transparency_process,
} from './ui/settings.js';
import { startOCR, stopOCR } from './ui/ocr.js';
import * as fs from 'node:fs';
import { runOverlay } from './ui/front.js';
import { execFile } from 'node:child_process';
import { autoLauncher } from './auto_launcher.js';
import { registerMainIPC } from './services/main_ipc.js';
import { exportLogsArchive } from './services/log_export.js';
import { UpdateManager } from './services/update_manager.js';
import {
    checkAndInstallPython311,
    checkAndInstallUV,
    cleanUvCache,
    getLockFile,
    getLockProjectVersion,
    getInstalledPackageVersion,
    installPackageNoDeps,
    isPackageInstalled,
    resolveRequestedExtras,
    syncLockedEnvironment,
} from './services/python_ops.js';

export class FeatureFlags {
    static PRE_RELEASE_VERSION = false;
    /**
     * Controls whether the Agent auto-launcher is enabled by default.
     *
     * When set to true, GSM will automatically start the Agent/auto-launcher
     * process on application startup (where supported) instead of requiring
     * the user to start it manually. This can change startup behavior,
     * background resource usage, and how quickly Agent-dependent features
     * become available after launch.
     *
     * Toggle this flag with care in releases and keep user-facing release
     * notes in sync with its behavior.
     */
    static AUTO_AGENT_LAUNCHER = true;
    static ALWAYS_UPDATE_IN_DEV = false;
    static DISABLE_GPU_INSTALLS = true;
}

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
let gsmStdoutManager: GSMStdoutManager | null = null;
export let isQuitting = false;
let restartingGSM: boolean = false;
let pythonPath: string;
const originalLog = console.log;
const originalError = console.error;
let cleanupComplete = false;

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

const updateManager = new UpdateManager({
    getPythonPath: () => pythonPath,
    closeAllPythonProcesses: async () => closeAllPythonProcesses(),
    ensureAndRunGSM: async (pyPath: string) => ensureAndRunGSM(pyPath),
});

async function autoUpdate(forceUpdate: boolean = false): Promise<void> {
    await updateManager.autoUpdate(forceUpdate);
}

async function runUpdateChecks(
    shouldRestart: boolean = false,
    force: boolean = false,
    forceDev: boolean = false
): Promise<void> {
    await updateManager.runUpdateChecks(shouldRestart, force, forceDev);
}

async function updateGSM(
    shouldRestart: boolean = false,
    force: boolean = false,
    preRelease: boolean = false
): Promise<void> {
    await updateManager.updateGSM(shouldRestart, force, preRelease);
}

function getGSMModulePath(): string {
    return 'GameSentenceMiner.gsm';
}

let useRareIcon: boolean = Math.random() < .01;
let iconStyle = "";

const availableIcons = ['gsm', 'gsm_cute', 'gsm_jacked', 'gsm_cursed'];

if (getIconStyle().includes('random')) {
    const randomIndex = Math.floor(Math.random() * availableIcons.length);
    const selectedIcon = availableIcons[randomIndex];
    iconStyle = selectedIcon;
}

export function getIconPath(forTray: boolean = false): string {
    let style = getIconStyle().includes('random') ? iconStyle : getIconStyle();
    let extension = isWindows() ? 'ico' : 'png';
    if (forTray) {
        if (getIconStyle().includes('[tray]')) {
            style = style.replace('[tray]', '');
            return path.join(getAssetsDir(), `${style}.${extension}`);
        }
        return path.join(getAssetsDir(), isWindows() ? 'gsm.ico' : 'gsm.png');
    }
    if (useRareIcon) {
        return path.join(getAssetsDir(), isWindows() ? 'gsm_rare.ico' : 'gsm_rare.png');
    }
    style = style.replace(/\[.*\]/, ''); // Remove any [.*] suffix if present
    let filename = `${style}.${extension}`;
    return path.join(getAssetsDir(), filename);
}

/**
 * Runs a command and returns a promise that resolves when the command exits.
 * @param command The command to run.
 * @param args The arguments to pass.
 */
function runGSM(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const taskManagerCommand = getWindowsNamedPythonExecutable(command, APP_NAME);
        const proc = spawn(taskManagerCommand, args, {
            env: { ...getSanitizedPythonEnv(), GSM_ELECTRON: '1' }
        });

        pyProc = proc;

        // Attach GSMStdoutManager
        gsmStdoutManager = new GSMStdoutManager(proc);
        gsmStdoutManager.on('message', (msg) => {
            // Handle structured GSM messages here
            // console.log('GSMMSG:', msg);
            if (msg.function === 'notification' && msg.data) {
                try {
                    sendNotificationFromPython(msg.data);
                } catch (e) {
                    console.error('Failed to route notification from Python:', e);
                }
            }
            if (msg.function === 'initialized') {
                mainWindow?.webContents.send('gsm-initialized', msg.data ?? {});
            }
            if (msg.function === 'cleanup_complete') {
                console.log('Received cleanup_complete message from Python.');
                cleanupComplete = true;
            }
            // mainWindow?.webContents.send('gsm-message', msg);
        });
        gsmStdoutManager.on('log', (log) => {
            // Forward logs to renderer or handle as needed
            if (log.type === 'stdout') {
                mainWindow?.webContents.send('terminal-output', log.message + '\r\n');
            } else if (log.type === 'stderr') {
                mainWindow?.webContents.send('terminal-error', log.message + '\r\n');
            } else if (log.type === 'parse-error') {
                mainWindow?.webContents.send('terminal-error', '[GSMMSG parse error] ' + log.message + '\r\n');
            }
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
            if (!updateManager.updateInProgress) {
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
    const windowTitle = `${APP_NAME} v${app.getVersion()}`;

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 1000,
        icon: getIconPath(),
        // Start hidden; show when ready for consistent taskbar icon
        show: false,
        webPreferences: getSecureWebPreferences({
            nodeIntegrationInSubFrames: true,
        }),
        title: windowTitle,
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url).catch((error) => {
                console.error('Failed to open external link:', error);
            });
        }
        return { action: 'deny' };
    });

    mainWindow.on('page-title-updated', (event) => {
        event.preventDefault();
        mainWindow?.setTitle(windowTitle);
    });

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow?.setTitle(windowTitle);
    });

    registerMainIPC({
        getMainWindow: () => mainWindow,
        restartApplication: async () => {
            await closeAllPythonProcesses();
            app.relaunch();
            app.exit(0);
        },
    });

    // Reveal window only after renderer signals it's ready
    mainWindow.once('ready-to-show', () => {
        if (!getStartConsoleMinimized() && mainWindow) {
            mainWindow.show();
        }
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
        await mainWindow.loadURL(devServerUrl);
    } else {
        await mainWindow.loadFile(getRendererEntryPath());
    }

    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'File',
            submenu: [
                { label: 'Update GSM', click: () => runUpdateChecks(true, true) },
                { label: 'Restart Python App', click: () => restartGSM() },
                { label: 'Open GSM Folder', click: () => shell.openPath(BASE_DIR) },
                { label: 'Export Logs', click: () => exportLogsArchive(mainWindow) },
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
                        shell.openExternal('https://docs.gamesentenceminer.com/docs/overview');
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
    ];

    if (process.platform === 'darwin') {
        const fileMenu = template.find((item) => item.label === 'File');
        if (fileMenu && Array.isArray(fileMenu.submenu)) {
            // Remove Quit from File menu on macOS
            fileMenu.submenu = fileMenu.submenu.filter((item: any) => item.label !== 'Quit');
        }

        template.unshift({
            label: APP_NAME,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { label: 'Quit', click: async () => await quit() },
            ],
        });
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

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
        // Re-set application menu after append
        Menu.setApplicationMenu(menu);
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
    try {
        const iconPath = getIconPath(true);

        // Check if icon file exists before creating tray
        if (!fs.existsSync(iconPath)) {
            console.warn(`Tray icon not found at ${iconPath}, skipping tray creation`);
            return;
        }

        tray = new Tray(iconPath);
        let template = [
            { label: 'Update GSM', click: () => runUpdateChecks(true, true) },
            { label: 'Restart Python App', click: () => restartGSM() },
            { label: 'Open GSM Folder', click: () => shell.openPath(BASE_DIR) },
            { label: 'Quit', click: () => quit() },
        ]

        if (isDev) {
            template.push({
                label: 'Restart App', click: async () => {
                    closeAllPythonProcesses().then(() => {
                        app.relaunch();
                        app.exit(0);
                    });
                }
            });
        }

        const contextMenu = Menu.buildFromTemplate(template);

        tray.setToolTip('GameSentenceMiner');
        tray.setContextMenu(contextMenu);

        tray.on('click', () => {
            showWindow();
        });
    } catch (error) {
        console.error('Failed to create tray:', error);
        // Don't throw - tray is optional, app can continue without it
    }
}

function showWindow() {
    mainWindow?.show();
    //     tray.destroy();
}

// Removed legacy WebSocket server startup; stdout IPC now used.

/**
 * Ensures GameSentenceMiner is installed before running it.
 */
async function ensureAndRunGSM(pythonPath: string, retry = 1): Promise<void> {
    // Kill any leftover GSM processes before starting
    await killAllGSMProcesses();

    const isInstalled = await isPackageInstalled(pythonPath, APP_NAME);
    await checkAndInstallUV(pythonPath);
    const installedVersion = await getInstalledPackageVersion(pythonPath, APP_NAME);
    let requestedVersion = installedVersion;
    if (!requestedVersion) {
        const { latestVersion } = await checkForUpdates();
        requestedVersion = latestVersion ?? null;
    }
    const lockInfo = await getLockFile(requestedVersion, FeatureFlags.PRE_RELEASE_VERSION);
    const lockProjectVersion = getLockProjectVersion(lockInfo);
    const strictMode = !FeatureFlags.PRE_RELEASE_VERSION;
    const lockMatchesRequested = lockInfo.matchesRequestedVersion !== false;
    const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
        lockInfo,
        getPythonExtras()
    );
    if (ignoredExtras.length > 0) {
        setPythonExtras(selectedExtras);
        console.warn(
            `Dropped unsupported extras for strict sync (${ignoredExtras.join(', ')}). Allowed extras: ${
                allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
            }.`
        );
    }
    const targetVersion = lockMatchesRequested
        ? lockProjectVersion ?? requestedVersion
        : requestedVersion;

    if (strictMode) {
        if (!lockInfo.hasLockfile) {
            throw new Error(
                'Strict runtime mode requires uv.lock + pyproject artifacts, but none were available.'
            );
        }

        if (!lockMatchesRequested) {
            const mismatchMessage = `Strict lock mismatch: requested backend version ${
                requestedVersion ?? 'unknown'
            }, lock project version ${lockProjectVersion ?? 'unknown'} from ${lockInfo.source}.`;
            if (!isInstalled) {
                throw new Error(
                    `${mismatchMessage} Cannot perform strict first install without matching lock artifacts.`
                );
            }
            console.warn(`${mismatchMessage} Skipping strict sync for this launch.`);
        } else {
            try {
                await syncLockedEnvironment(pythonPath, lockInfo.projectPath, selectedExtras, true);
                console.log('Python environment already matches lockfile.');
            } catch {
                console.log(
                    `Syncing Python environment with strict lockfile (${lockInfo.source}) and extras: ${
                        selectedExtras.length > 0 ? selectedExtras.join(', ') : 'none'
                    }`
                );
                await syncLockedEnvironment(pythonPath, lockInfo.projectPath, selectedExtras, false);
            }
        }
    }

    if (!isInstalled) {
        if (strictMode && !isDev && !targetVersion) {
            throw new Error('Unable to determine target backend version for strict installation.');
        }
        if (strictMode && !isDev && !lockMatchesRequested) {
            throw new Error(
                'Strict installation requires release lock artifacts that match the target backend version.'
            );
        }
        const packageSpecifier = isDev
            ? '.'
            : targetVersion && strictMode
              ? `${PACKAGE_NAME}==${targetVersion}`
              : PACKAGE_NAME;
        console.log(`${APP_NAME} is not installed. Installing ${packageSpecifier}...`);
        await installPackageNoDeps(pythonPath, packageSpecifier, true);
        console.log('Installation complete.');
    }

    console.log('Starting GameSentenceMiner...');
    try {
        const args = ['-m', getGSMModulePath()];
        if (isDev) {
            args.push('--dev');
        }
        return await runGSM(pythonPath, args);
    } catch (err) {
        console.error('Failed to start GameSentenceMiner:', err);
        if (!isDev && retry > 0) {
            console.log(
                "Looks like something's broken with GSM, attempting to repair the installation..."
            );
            await closeAllPythonProcesses();
            await cleanUvCache(pythonPath);

            if (strictMode && lockInfo.hasLockfile && lockMatchesRequested) {
                await syncLockedEnvironment(pythonPath, lockInfo.projectPath, selectedExtras, false);
            }
            if (strictMode && !isDev && !targetVersion) {
                throw new Error('Unable to determine target backend version for strict repair.');
            }
            if (strictMode && !isDev && !lockMatchesRequested) {
                throw new Error(
                    'Strict repair requires lock artifacts that match the requested backend version.'
                );
            }
            const repairSpecifier = isDev
                ? '.'
                : targetVersion && strictMode
                  ? `${PACKAGE_NAME}==${targetVersion}`
                  : PACKAGE_NAME;
            await installPackageNoDeps(pythonPath, repairSpecifier, true);

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
    let runOCR = false;

    await getOBSConnection();

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--scene' && args[i + 1]) {
            await setOBSScene(args[i + 1]);
            i++;
        } else if (args[i] === '--game' && args[i + 1]) {
            gameName = args[i + 1];
            i++;
        } else if (args[i] === '--ocr') {
            runOCR = true;
        } else if (args[i] === '--force-python-update') {
            await updateGSM(true, true);
        } else if (args[i] === '--force-all-updates') {
            await runUpdateChecks(true, true, true);
        }
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

app.setPath('userData', path.join(BASE_DIR, 'electron'));
if (isWindows()) {
    app.setAppUserModelId('GameSentenceMiner');
}

// Fix for name and icon on macOS
if (process.platform === 'darwin') {
    app.setName(APP_NAME);
    app.dock?.setIcon(getIconPath());
}

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
        if (!FeatureFlags.PRE_RELEASE_VERSION && getAutoUpdateGSMApp()) {
            if (await isConnected()) {
                console.log('Checking for updates...');
                await autoUpdate();
            }
        }
        createWindow().then(async () => {
            createTray();
            autoLauncher.startPolling();
            // setTimeout(async () => {
            //     await checkAndRunWizard(true);
            // }, 1000);
            const pyPath = await getOrInstallPython();
            pythonPath = pyPath;
            setPythonPath(pythonPath);
            const currentVersion = app.getVersion();
            const storedVersion = getElectronAppVersion();
            const appVersionChanged =
                storedVersion !== '' && storedVersion !== currentVersion;
            if (appVersionChanged) {
                log.info(
                    `Detected Electron app version change (${storedVersion} -> ${currentVersion}). Forcing Python update before launch.`
                );
            }
            if (fs.existsSync(path.join(BASE_DIR, 'update_python.flag'))) {
                await updateGSM(false, true);
                if (fs.existsSync(path.join(BASE_DIR, 'update_python.flag'))) {
                    fs.unlinkSync(path.join(BASE_DIR, 'update_python.flag'));
                }
            } else if (appVersionChanged) {
                await updateGSM(false, true);
            } else if (getAutoUpdateGSMApp()) {
                await updateGSM(false, false);
            }
            if (isDev && FeatureFlags.ALWAYS_UPDATE_IN_DEV) {
                await updateGSM(false, true);
            }
            if (FeatureFlags.PRE_RELEASE_VERSION) {
                console.log('Pre-release version detected, updating python package to development version...');
                updateGSM(false, true, true);
            }
            if (storedVersion !== currentVersion) {
                setElectronAppVersion(currentVersion);
            }
            try {
                await ensureAndRunGSM(pythonPath);
                if (!updateManager.updateInProgress) {
                    await quit();
                }
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

            // Start scene-driven auto-launch polling.
            autoLauncher.startPolling();
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                quit();
            }
        });

        app.on('before-quit', () => {
            isQuitting = true;
        });

        app.on('will-quit', () => {
            autoLauncher.stopPolling();
        });
    });
}

export async function runPipInstall(packageName: string): Promise<void> {
    const pythonPath = await getOrInstallPython();
    await closeGSM();

    console.log(`Running uv add for package: ${packageName}`);
    try {
        console.log(`Running command: ${pythonPath} -m uv add ${packageName}`);
        await new Promise<void>((resolve, reject) => {
            const child = execFile(pythonPath, [
                '-m',
                'uv',
                'add',
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

/**
 * Finds and kills all lingering GameSentenceMiner Python processes on the system.
 * This is more aggressive than closeAllPythonProcesses and searches for any
 * python.exe processes running GameSentenceMiner modules.
 */
async function killAllGSMProcesses(): Promise<void> {
    console.log('Checking for leftover GSM processes...');
    try {
        if (isWindows()) {
            // Use PowerShell with Get-CimInstance (WMIC is deprecated on newer Windows)
            // This query gets all python.exe processes and their command lines in one shot
            const psScript = `
                Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | 
                    Where-Object { $_.CommandLine -match 'GameSentenceMiner' } | 
                    Select-Object ProcessId | 
                    ForEach-Object { $_.ProcessId }
            `.replace(/\s+/g, ' ').trim();

            try {
                const { stdout } = await execFileAsync('powershell.exe', [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    psScript
                ]);

                const pids = stdout.trim().split(/\r?\n/).filter(pid => pid && /^\d+$/.test(pid.trim()));

                if (pids.length === 0) {
                    console.log('No leftover GSM processes found.');
                    return;
                }

                for (const pid of pids) {
                    const trimmedPid = pid.trim();
                    try {
                        console.log(`Found leftover GSM process (PID: ${trimmedPid}), killing...`);
                        await execFileAsync('taskkill', ['/PID', trimmedPid, '/F']);
                        console.log(`Killed process ${trimmedPid}`);
                    } catch (err) {
                        // Process might have already exited or we don't have permission
                        console.warn(`Could not kill process ${trimmedPid}:`, err);
                    }
                }
            } catch (psErr: any) {
                // PowerShell command may fail if no processes match - this is normal
                if (psErr.code !== 0) {
                    console.log('No leftover GSM processes found (or PowerShell query returned empty).');
                } else {
                    throw psErr;
                }
            }
        } else {
            // Unix-like systems (macOS, Linux)
            try {
                const { stdout } = await execFileAsync('pgrep', ['-f', 'GameSentenceMiner']);
                const pids = stdout.trim().split('\n').filter(pid => pid);

                if (pids.length === 0) {
                    console.log('No leftover GSM processes found.');
                    return;
                }

                for (const pid of pids) {
                    try {
                        console.log(`Found leftover GSM process (PID: ${pid}), killing...`);
                        await execFileAsync('kill', ['-9', pid]);
                        console.log(`Killed process ${pid}`);
                    } catch (err) {
                        console.warn(`Could not kill process ${pid}:`, err);
                    }
                }
            } catch (pgrepErr: any) {
                // pgrep exits with code 1 if no processes match - this is normal
                if (pgrepErr.code === 1) {
                    console.log('No leftover GSM processes found.');
                } else {
                    throw pgrepErr;
                }
            }
        }
        console.log('Finished checking for leftover GSM processes.');
    } catch (err) {
        // Don't let process cleanup failures block GSM startup
        console.error('Error while checking for leftover processes (continuing anyway):', err);
    }
}

async function closeAllPythonProcesses(closeGSMFlag: boolean = true): Promise<void> {
    if (closeGSMFlag) {
        await closeGSM();
    }
    await stopOCR();
    await stopWindowTransparencyTool();
}

async function closeGSM(): Promise<void> {
    if (!pyProc) return;
    restartingGSM = true;
    stopScripts();
    // Prefer graceful quit via IPC command; fall back to kill.
    if (gsmStdoutManager) {
        gsmStdoutManager.sendQuitMessage();
        cleanupComplete = false;
        console.log('Sent quit command to GSM via stdout IPC.');
        gsmStdoutManager.once('message', (msg) => {
            if (msg.function === 'cleanup_complete') {
                cleanupComplete = true;
                console.log('Received cleanup_complete message from Python.');
            }
        });
        // Wait up to 5 seconds for cleanup_complete, checking every 100ms, then force kill if needed
        const timeoutMs = 5000;
        const intervalMs = 100;
        let waited = 0;
        while (!cleanupComplete && waited < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            waited += intervalMs;
        }
        if (pyProc && !pyProc.killed && !cleanupComplete) {
            pyProc.kill();
            console.log('Force killed GSM after timeout.');
        } else {
            console.log('GSM closed gracefully.');
        }
    } else {
        console.log('No IPC manager, killing process directly.');
        pyProc?.kill();
    }
}

async function restartGSM(): Promise<void> {
    if (pyProc.killed) {
        ensureAndRunGSM(pythonPath).then(() => {
            console.log('GSM Successfully Restarted!');
        });
        return;
    }
    restartingGSM = true;
    if (gsmStdoutManager) {
        gsmStdoutManager.sendQuitMessage();
    }
    gsmStdoutManager?.once('message', (msg) => {
        if (msg.function === 'cleanup_complete') {
            console.log('Received cleanup_complete message from Python, restarting GSM...');
            ensureAndRunGSM(pythonPath).then(() => {
                console.log('GSM Successfully Restarted!');
            });
        }
    });
}

export { closeGSM, restartGSM, closeAllPythonProcesses, ensureAndRunGSM };
export { checkAndInstallPython311, checkAndInstallUV, isPackageInstalled };

export async function stopScripts(): Promise<void> {
    if (window_transparency_process && !window_transparency_process.killed) {
        console.log('Stopping existing Window Transparency Tool process');
        window_transparency_process.stdin.write('exit\n');
        setTimeout(() => {
            window_transparency_process.kill();
        }, 1000);
    }
}

async function quit(): Promise<void> {
    autoLauncher.stopPolling();
    await stopScripts();
    if (pyProc != null && !pyProc.killed) {
        await closeAllPythonProcesses();
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

// Helper command wrappers replacing previous WebSocket-based ones
export function sendStartOBS() { gsmStdoutManager?.sendStartOBS(); }
export function sendQuitOBS() { gsmStdoutManager?.sendQuitOBS(); }
export function sendOpenSettings() { gsmStdoutManager?.sendOpenSettings(); }
