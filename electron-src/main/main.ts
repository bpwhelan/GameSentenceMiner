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
import { getOrInstallPython, reinstallPython } from './python/python_downloader.js';
import {
    APP_NAME,
    BASE_DIR,
    execFileAsync,
    getAssetsDir,
    getResourcesDir,
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
import { UpdateManager } from './services/update_manager.js';
import { devFaultInjector } from './services/dev_fault_injection.js';
import { runUpdateChaosHarness } from './services/update_chaos_harness.js';
import {
    checkAndInstallPython311,
    checkAndInstallUV,
    checkAndEnsurePip,
    cleanUvCache,
    installPackageNoDeps,
    isPackageInstalled,
    resolveRequestedExtras,
    syncLockedEnvironment,
} from './services/python_ops.js';

export class FeatureFlags {
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
    static DISABLE_GPU_INSTALLS = false;
}

let cachedPreReleaseBranch: string | null | undefined = undefined;

function resolvePreReleaseBranchFromMetadata(): string | null {
    const candidates = [
        path.join(getResourcesDir(), 'prerelease.json'),
        path.join(getAssetsDir(), 'prerelease.json'),
        path.join(getResourcesDir(), 'assets', 'prerelease.json'),
    ];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (!candidate || seen.has(candidate)) {
            continue;
        }
        seen.add(candidate);
        if (!fs.existsSync(candidate)) {
            continue;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { branch?: unknown };
            if (typeof parsed.branch !== 'string' || parsed.branch.trim().length === 0) {
                console.warn(`Ignoring prerelease metadata without a valid "branch" field: ${candidate}`);
                continue;
            }
            const branch = parsed.branch.trim();
            console.log(`Detected prerelease metadata at ${candidate} (branch: ${branch})`);
            return branch;
        } catch (error) {
            console.warn(`Failed to parse prerelease metadata at ${candidate}:`, error);
        }
    }
    return null;
}

function getPreReleaseBranch(): string | null {
    if (cachedPreReleaseBranch !== undefined) {
        return cachedPreReleaseBranch;
    }
    cachedPreReleaseBranch = resolvePreReleaseBranchFromMetadata();
    return cachedPreReleaseBranch;
}

function getPreReleasePackageSpecifier(): string | null {
    const preReleaseBranch = getPreReleaseBranch();
    if (!preReleaseBranch) {
        return null;
    }
    return `git+https://github.com/bpwhelan/GameSentenceMiner@${preReleaseBranch}`;
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
const originalWarn = console.warn;
let cleanupComplete = false;
const UPDATE_PROGRESS_PREFIX = 'UpdateProgress:';

type TerminalStream = 'stdout' | 'stderr';
type TerminalChannel = 'basic' | 'background';
type TerminalSource = 'python' | 'electron' | 'system';

interface TerminalLogPayload {
    message: string;
    stream?: TerminalStream;
    channel?: TerminalChannel;
    level?: string;
    source?: TerminalSource;
}

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function shouldSuppressTerminalLog(message: string): boolean {
    const clean = stripAnsi(message).trim();
    // Route OCR subsystem chatter to the OCR channel only.
    if (
        /^\[OCR(?:\s|\]|:|\b)/i.test(clean) ||
        /^\[OCR IPC\]/i.test(clean) ||
        /^\[Screen Selector STDOUT\]/i.test(clean) ||
        /^An OCR process is already running\./i.test(clean) ||
        /^Starting OCR process with command:/i.test(clean) ||
        /^OCR process exited with code:/i.test(clean) ||
        /^Screen selector exited with code/i.test(clean) ||
        /^Failed to start OCR process:/i.test(clean) ||
        /Furigana filter sensitivity added to OCR config/i.test(clean) ||
        /Error writing OCR config file/i.test(clean)
    ) {
        return true;
    }

    // Keep noisy OCR parser chatter out of unified logs.
    if (
        /^\[OCR\s+(STDOUT|STDERR|Parse Error)\]/i.test(clean) ||
        /OCR Run \d+: Text recognized/i.test(clean)
    ) {
        return true;
    }

    // Keep noisy OBS reconnect/error loop chatter out of unified logs.
    if (
        /^\[OBS\]\s+(Connection error|Connection closed|Connect attempt|Scheduling reconnect|Heartbeat failed|Background reconnect attempt failed|Initial OBS connection attempt failed|Resetting websocket client|Failed to disconnect stale websocket)/i.test(
            clean
        )
    ) {
        return true;
    }
    return false;
}

function parsePythonLogLevel(message: string): string | null {
    const clean = stripAnsi(message);
    const match = clean.match(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+\|\s+[^|]+\|\s+([A-Z_]+)\s+\|/
    );
    return match ? match[1] : null;
}

function inferTerminalChannel(
    message: string,
    level: string | undefined,
    stream: TerminalStream
): TerminalChannel {
    const normalizedLevel = (level || parsePythonLogLevel(message) || '').toUpperCase();
    if (normalizedLevel === 'BACKGROUND' || normalizedLevel === 'DEBUG' || normalizedLevel === 'TRACE') {
        return 'background';
    }

    const clean = stripAnsi(message);
    if (clean.startsWith(UPDATE_PROGRESS_PREFIX)) {
        return 'basic';
    }

    if (stream === 'stderr') {
        return 'basic';
    }

    return 'basic';
}

function sendTerminalLog(payload: TerminalLogPayload): void {
    const stream = payload.stream ?? 'stdout';
    const message = payload.message ?? '';
    if (shouldSuppressTerminalLog(message)) {
        return;
    }
    const level = payload.level ? payload.level.toUpperCase() : undefined;
    const channel = payload.channel ?? inferTerminalChannel(message, level, stream);
    const normalized: TerminalLogPayload = {
        message,
        stream,
        level,
        channel,
        source: payload.source ?? 'system',
    };

    if (stream === 'stderr') {
        mainWindow?.webContents.send('terminal-error', normalized);
    } else {
        mainWindow?.webContents.send('terminal-output', normalized);
    }
}

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
    await updateManager.runUpdateChecks(shouldRestart, force, forceDev, getPreReleaseBranch());
}

async function updateGSM(
    shouldRestart: boolean = false,
    force: boolean = false
): Promise<void> {
    await updateManager.updateGSM(shouldRestart, force, getPreReleaseBranch());
}

function getGSMModulePath(): string {
    return 'GameSentenceMiner.gsm';
}

function wantsChaosHarnessRun(): boolean {
    return process.argv.includes('--dev-chaos-update');
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

interface ManagedGSMProcessState {
    pid: number;
    command: string;
    args: string[];
}

const GSM_PROCESS_STATE_FILE = path.join(BASE_DIR, 'electron', 'gsm_managed_process.json');

function writeManagedGSMProcessState(command: string, args: string[], pid: number | undefined): void {
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(GSM_PROCESS_STATE_FILE), { recursive: true });
        const state: ManagedGSMProcessState = { pid, command, args };
        fs.writeFileSync(GSM_PROCESS_STATE_FILE, JSON.stringify(state), 'utf8');
    } catch {
        // Best-effort tracking only; never block startup/launch.
    }
}

function readManagedGSMProcessState(): ManagedGSMProcessState | null {
    try {
        if (!fs.existsSync(GSM_PROCESS_STATE_FILE)) {
            return null;
        }
        const raw = fs.readFileSync(GSM_PROCESS_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as Partial<ManagedGSMProcessState>;
        const pid = typeof parsed?.pid === 'number' ? parsed.pid : NaN;
        if (
            !parsed ||
            !Number.isInteger(pid) ||
            pid <= 0 ||
            typeof parsed.command !== 'string' ||
            !Array.isArray(parsed.args)
        ) {
            return null;
        }
        return {
            pid,
            command: parsed.command,
            args: parsed.args.map((arg) => String(arg)),
        };
    } catch {
        return null;
    }
}

function clearManagedGSMProcessState(): void {
    try {
        if (fs.existsSync(GSM_PROCESS_STATE_FILE)) {
            fs.unlinkSync(GSM_PROCESS_STATE_FILE);
        }
    } catch {
        // Best-effort cleanup only.
    }
}

function looksLikeManagedGSMCommand(commandLine: string, state: ManagedGSMProcessState): boolean {
    const normalized = commandLine.toLowerCase();
    const expectedExeName = path.basename(state.command).toLowerCase();
    const moduleToken = getGSMModulePath().toLowerCase();
    if (!normalized.includes(moduleToken)) {
        return false;
    }
    if (expectedExeName && !normalized.includes(expectedExeName)) {
        return false;
    }
    // Keep matching conservative; require the same argument tokens we launched with.
    for (const arg of state.args) {
        const token = arg.toLowerCase();
        if (!normalized.includes(token)) {
            return false;
        }
    }
    return true;
}

async function getProcessCommandLine(pid: number): Promise<string | null> {
    if (isWindows()) {
        const psScript = [
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object CommandLine`,
            `if ($null -ne $p) { $p | ConvertTo-Json -Compress }`,
        ].join('; ');
        const { stdout } = await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            psScript,
        ]);
        const raw = stdout.trim();
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as { CommandLine?: string } | Array<{ CommandLine?: string }>;
        const item = Array.isArray(parsed) ? parsed[0] : parsed;
        return typeof item?.CommandLine === 'string' ? item.CommandLine : null;
    }

    try {
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
        const commandLine = stdout.trim();
        return commandLine.length > 0 ? commandLine : null;
    } catch (err: any) {
        if (err?.code === 1) {
            return null;
        }
        throw err;
    }
}

async function cleanupStaleManagedGSMProcess(): Promise<void> {
    const state = readManagedGSMProcessState();
    if (!state) {
        return;
    }

    let clearStateFile = true;
    try {
        if (pyProc && pyProc.pid === state.pid && !pyProc.killed) {
            clearStateFile = false;
            return;
        }

        const commandLine = await getProcessCommandLine(state.pid);
        if (!commandLine || !looksLikeManagedGSMCommand(commandLine, state)) {
            return;
        }

        if (isWindows()) {
            await execFileAsync('taskkill', ['/PID', String(state.pid), '/T', '/F']);
        } else {
            await execFileAsync('kill', ['-9', String(state.pid)]);
        }
    } catch {
        // Silent best-effort cleanup.
    } finally {
        if (clearStateFile) {
            clearManagedGSMProcessState();
        }
    }
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
        writeManagedGSMProcessState(taskManagerCommand, args, proc.pid);

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
                sendTerminalLog({
                    message: log.message + '\r\n',
                    stream: 'stdout',
                    source: 'python',
                    level: parsePythonLogLevel(log.message) ?? undefined,
                });
            } else if (log.type === 'stderr') {
                sendTerminalLog({
                    message: log.message + '\r\n',
                    stream: 'stderr',
                    source: 'python',
                });
            } else if (log.type === 'parse-error') {
                sendTerminalLog({
                    message: '[GSMMSG parse error] ' + log.message + '\r\n',
                    stream: 'stderr',
                    source: 'python',
                    level: 'ERROR',
                });
            }
        });

        proc.on('close', (code) => {
            clearManagedGSMProcessState();
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
            clearManagedGSMProcessState();
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
        sendTerminalLog({
            message: `${message}\r\n`,
            stream: 'stdout',
            source: 'electron',
            channel: stripAnsi(message).startsWith(UPDATE_PROGRESS_PREFIX) ? 'basic' : 'background',
        });
        originalLog.apply(console, args);
    };

    console.warn = function (...args) {
        const message = args
            .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg))
            .join(' ');
        sendTerminalLog({
            message: `${message}\r\n`,
            stream: 'stdout',
            source: 'electron',
            channel: 'basic',
            level: 'WARNING',
        });
        originalWarn.apply(console, args);
    };

    console.error = function (...args) {
        const message = args
            .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg))
            .join(' ');
        sendTerminalLog({
            message: `${message}\r\n`,
            stream: 'stderr',
            source: 'electron',
            channel: 'basic',
            level: 'ERROR',
        });
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
    // Best-effort cleanup for a stale backend process previously spawned by GSM.
    await cleanupStaleManagedGSMProcess();
    devFaultInjector.maybeFail('startup.ensure_and_run_enter');

    let runtimePythonPath = pythonPath;
    const preReleasePackageSpecifier = getPreReleasePackageSpecifier();
    const preReleaseEnabled = preReleasePackageSpecifier !== null;
    let isInstalled = await isPackageInstalled(runtimePythonPath, APP_NAME);

    try {
        devFaultInjector.maybeFail('startup.check_and_ensure_pip');
        await checkAndEnsurePip(runtimePythonPath);
        devFaultInjector.maybeFail('startup.check_and_install_uv');
        await checkAndInstallUV(runtimePythonPath);
    } catch (error) {
        console.warn(
            'Python runtime bootstrap failed (pip/uv). Reinitializing python_venv from scratch...',
            error
        );
        await closeAllPythonProcesses();
        await reinstallPython();
        runtimePythonPath = await getOrInstallPython();
        pythonPath = runtimePythonPath;
        setPythonPath(runtimePythonPath);
        await checkAndEnsurePip(runtimePythonPath);
        await checkAndInstallUV(runtimePythonPath);
        isInstalled = await isPackageInstalled(runtimePythonPath, APP_NAME);
    }

    // Resolve extras and persist any pruned options.
    const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
        getPythonExtras()
    );
    if (ignoredExtras.length > 0) {
        setPythonExtras(selectedExtras);
        console.warn(
            `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed: ${
                allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
            }.`
        );
    }

    // Sync environment from the bundled uv.lock.
    if (!preReleaseEnabled) {
        try {
            devFaultInjector.maybeFail('startup.sync_lock_check');
            await syncLockedEnvironment(runtimePythonPath, selectedExtras, true);
            console.log('Python environment already matches lockfile.');
        } catch {
            console.log(
                `Syncing Python environment with lockfile, extras: ${
                    selectedExtras.length > 0 ? selectedExtras.join(', ') : 'none'
                }`
            );
            devFaultInjector.maybeFail('startup.sync_lock_apply');
            await syncLockedEnvironment(runtimePythonPath, selectedExtras, false);
        }
    }

    // Install the package itself if not present.
    if (!isInstalled) {
        const packageSpecifier = isDev
            ? '.'
            : (preReleasePackageSpecifier ?? PACKAGE_NAME);
        console.log(`${APP_NAME} is not installed. Installing ${packageSpecifier}...`);
        devFaultInjector.maybeFail('startup.install_package');
        await installPackageNoDeps(runtimePythonPath, packageSpecifier, true);
        console.log('Installation complete.');
    }

    console.log('Starting GameSentenceMiner...');
    try {
        const args = ['-m', getGSMModulePath()];
        if (isDev) {
            args.push('--dev');
        }
        devFaultInjector.maybeFail('startup.run_gsm');
        return await runGSM(runtimePythonPath, args);
    } catch (err) {
        console.error('Failed to start GameSentenceMiner:', err);
        if (!isDev && retry > 0) {
            console.log(
                "Looks like something's broken with GSM, attempting to repair the installation..."
            );
            await closeAllPythonProcesses();
            devFaultInjector.maybeFail('startup.repair.clean_uv_cache');
            await cleanUvCache(runtimePythonPath);

            if (!preReleaseEnabled) {
                devFaultInjector.maybeFail('startup.repair.sync_lock');
                await syncLockedEnvironment(runtimePythonPath, selectedExtras, false);
            }

            const repairSpecifier = isDev
                ? '.'
                : (preReleasePackageSpecifier ?? PACKAGE_NAME);
            devFaultInjector.maybeFail('startup.repair.install_package');
            await installPackageNoDeps(runtimePythonPath, repairSpecifier, true);

            console.log('reinstall complete, retrying to start GSM...');
            return await ensureAndRunGSM(runtimePythonPath, retry - 1);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        throw err instanceof Error ? err : new Error(String(err));
    } finally {
        restartingGSM = false;
    }
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
        try {
            const pyPath = await getOrInstallPython();
            pythonPath = pyPath;
            setPythonPath(pythonPath);

            if (wantsChaosHarnessRun()) {
                if (!isDev) {
                    console.warn(
                        '[Chaos] --dev-chaos-update is only enabled in development builds.'
                    );
                } else {
                    console.log('[Chaos] Starting dev update chaos harness...');
                    const summary = await runUpdateChaosHarness({
                        updateGSM: async (shouldRestart = false, force = false) => {
                            await updateManager.updateGSM(
                                shouldRestart,
                                force,
                                getPreReleaseBranch()
                            );
                        },
                        ensureAndRunGSM: async (py) => ensureAndRunGSM(py),
                        closeAllPythonProcesses: async () => closeAllPythonProcesses(),
                        getPythonPath: () => pythonPath,
                        wasLastBackendUpdateSuccessful: () =>
                            updateManager.lastBackendUpdateWasSuccessful,
                        getLastBackendUpdateFailureReason: () =>
                            updateManager.lastBackendUpdateFailureReason,
                        getBackendProcessState: () => ({
                            pid: pyProc?.pid,
                            running: Boolean(pyProc && pyProc.pid && !pyProc.killed),
                        }),
                    });

                    const failedScenarios = summary.results.filter((entry) => !entry.success);
                    const detailLines = failedScenarios
                        .slice(0, 6)
                        .map((entry) => `- ${entry.scenario}: ${entry.error ?? 'unknown error'}`);
                    const detailText =
                        detailLines.length > 0
                            ? `\n\nFailures:\n${detailLines.join('\n')}`
                            : '';

                    await dialog.showMessageBox({
                        type: failedScenarios.length > 0 ? 'warning' : 'info',
                        title: 'GSM Update Chaos Harness',
                        message: `Completed ${summary.total} scenario(s). Passed: ${summary.passed}. Failed: ${summary.failed}.`,
                        detail:
                            'This is a development-only stress harness.' + detailText,
                        buttons: ['OK'],
                    });

                    await closeAllPythonProcesses();
                    app.quit();
                    return;
                }
            }

            const currentVersion = app.getVersion();
            const storedVersion = getElectronAppVersion();
            const appVersionChanged = storedVersion !== '' && storedVersion !== currentVersion;
            const updateFlagPath = path.join(BASE_DIR, 'update_python.flag');
            if (appVersionChanged) {
                log.info(
                    `Detected Electron app version change (${storedVersion} -> ${currentVersion}). Forcing Python update before launch.`
                );
            }
            if (fs.existsSync(updateFlagPath)) {
                await updateGSM(false, true);
                if (updateManager.lastBackendUpdateWasSuccessful) {
                    try {
                        if (fs.existsSync(updateFlagPath)) {
                            fs.unlinkSync(updateFlagPath);
                            log.info(`Cleared backend update marker: ${updateFlagPath}`);
                        }
                    } catch (unlinkErr) {
                        log.warn(
                            `Failed to clear backend update marker (${updateFlagPath}):`,
                            unlinkErr
                        );
                    }
                } else {
                    log.warn(
                        `Backend update reported failure. Keeping ${updateFlagPath} for retry. Reason: ${
                            updateManager.lastBackendUpdateFailureReason ?? 'unknown'
                        }`
                    );
                }
            } else if (appVersionChanged) {
                await updateGSM(false, true);
            } else if (getAutoUpdateGSMApp()) {
                await updateGSM(false, false);
            }
            if (isDev && FeatureFlags.ALWAYS_UPDATE_IN_DEV) {
                await updateGSM(false, true);
            }
            const preReleaseBranch = getPreReleaseBranch();
            if (preReleaseBranch) {
                console.log(
                    `Pre-release backend enabled (branch: ${preReleaseBranch}), forcing backend update...`
                );
                void updateGSM(false, true);
            }
            if (storedVersion !== currentVersion) {
                setElectronAppVersion(currentVersion);
            }

            // Launch backend before UI/module initialization, then continue startup.
            void ensureAndRunGSM(pythonPath)
                .then(async () => {
                    if (!updateManager.updateInProgress) {
                        await quit();
                    }
                })
                .catch(async (err) => {
                    console.log('Failed to run GSM, attempting repair of python package...', err);
                    await updateGSM(true, true);
                });
        } catch (error) {
            console.error('Failed to initialize Python runtime on startup:', error);
        }

        processArgsAndStartSettings()
            .then((_) => console.log('Processed Args'))
            .catch((error) => console.warn('Failed to process startup args:', error));
        if (!getPreReleaseBranch() && getAutoUpdateGSMApp()) {
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

async function closeAllPythonProcesses(closeGSMFlag: boolean = true): Promise<void> {
    if (closeGSMFlag) {
        await closeGSM();
    }
    await stopOCR();
    await stopWindowTransparencyTool();
}

async function closeGSM(): Promise<void> {
    if (!pyProc) {
        clearManagedGSMProcessState();
        return;
    }
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
export function sendOpenTexthooker() { gsmStdoutManager?.sendOpenTexthooker(); }
