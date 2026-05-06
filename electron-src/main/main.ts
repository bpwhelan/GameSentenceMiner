import {
    app,
    BrowserWindow,
    dialog,
    Menu,
    MenuItem,
    Notification,
    nativeImage,
    shell,
    Tray,
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
    isRunningAsAdmin,
    restartAsAdmin,
    PACKAGE_NAME,
} from './util.js';
import { fileURLToPath } from 'node:url';

import log from 'electron-log/main.js';
import {
    getAutoUpdateGSMApp,
    getPullPreReleases,
    getPreReleaseMetadataAutoEnableApplied,
    getPythonExtras,
    getRunOverlayOnStartup,
    getRunWindowTransparencyToolOnStartup,
    getStartConsoleMinimized,
    getElectronAppVersion,
    setPythonPath,
    setElectronAppVersion,
    getIconStyle,
    setPythonExtras,
    setPullPreReleases,
    setPreReleaseMetadataAutoEnableApplied,
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
import { runOverlay, runOverlayWithSource } from './ui/front.js';
import { execFile } from 'node:child_process';
import { autoLauncher } from './auto_launcher.js';
import { registerMainIPC } from './services/main_ipc.js';
import { installSessionManager } from './services/install_session_state.js';
import { UpdateManager } from './services/update_manager.js';
import type { UpdateStatusSnapshot } from './services/update_manager.js';
import { devFaultInjector } from './services/dev_fault_injection.js';
import { runUpdateChaosHarness } from './services/update_chaos_harness.js';
import {
    getStatusTrayIconPath,
    getTrayBaseIconPath,
    getTrayTooltip,
    resolveTrayVisualState,
    type TrayVisualState,
} from './tray_icons.js';
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
import type {
    InstallProgressKind,
    InstallSessionOrigin,
    InstallStageId,
} from '../shared/install_session.js';
import { INSTALL_STAGE_IDS } from '../shared/install_session.js';

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

function getConfiguredPreReleaseBranch(): string | null {
    if (!getPullPreReleases()) {
        return null;
    }
    return getPreReleaseBranch();
}

function bootstrapPreReleaseSettingsFromMetadata(): void {
    if (getPreReleaseMetadataAutoEnableApplied()) {
        return;
    }

    const preReleaseBranch = getPreReleaseBranch();
    if (!preReleaseBranch) {
        return;
    }

    if (!getPullPreReleases()) {
        log.info(
            `Detected pre-release metadata (branch: ${preReleaseBranch}); enabling beta updates in settings.`
        );
        setPullPreReleases(true);
    }

    setPreReleaseMetadataAutoEnableApplied(true);
}

function getPreReleasePackageSpecifier(): string | null {
    const preReleaseBranch = getConfiguredPreReleaseBranch();
    if (!preReleaseBranch) {
        return null;
    }
    return `https://github.com/bpwhelan/GameSentenceMiner/archive/refs/heads/${preReleaseBranch}.zip`;
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
let tray: Tray | null = null;
export let pyProc: ChildProcessWithoutNullStreams;
let gsmStdoutManager: GSMStdoutManager | null = null;
export let isQuitting = false;
let restartingGSM: boolean = false;
let reopenSettingsAfterBackendRestart: boolean = false;
let pythonPath: string;
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
let cleanupComplete = false;
let backendExitRequestedFromPython = false;
let textIntakePaused = false;
let pythonIpcConnected = false;
let backendStatusReady = false;
let pausedTrayFallbackIconCache: Electron.NativeImage | null = null;
let loadingTrayFallbackIconCache: Electron.NativeImage | null = null;
let readyTrayFallbackIconCache: Electron.NativeImage | null = null;
let backendStatusPollTimer: ReturnType<typeof setInterval> | null = null;
let trayReadyIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
let trayReadyIndicatorExpiresAt = 0;
const UPDATE_PROGRESS_PREFIX = 'UpdateProgress:';
const STARTUP_REPAIR_WINDOW_MS = 15_000;
const TRAY_READY_INDICATOR_MS = 10_000;
const BACKEND_STATUS_POLL_MS = 2_000;
const BACKEND_STATUS_URL = 'http://localhost:7275/get_status';
const SIMULATED_STARTUP_FAILURE_MESSAGE = 'Simulated failure before starting GSM';
let simulatedStartupFailureTriggered = false;
let terminalLogSendDepth = 0;

function canSendToMainWindow(): boolean {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return false;
    }
    const contents = mainWindow.webContents;
    if (!contents || contents.isDestroyed()) {
        return false;
    }
    if (typeof contents.isCrashed === 'function' && contents.isCrashed()) {
        return false;
    }
    return true;
}

function safeSendToMainWindow(channel: string, payload: unknown): boolean {
    if (!canSendToMainWindow()) {
        return false;
    }
    try {
        mainWindow!.webContents.send(channel, payload);
        return true;
    } catch (error) {
        log.warn(`Failed to send "${channel}" to renderer: ${formatConsoleArg(error)}`);
        return false;
    }
}

installSessionManager.setSnapshotListener((channel, snapshot) => {
    safeSendToMainWindow(channel, snapshot);
});

function ensureInstallSession(
    origin: InstallSessionOrigin,
    retryHandler?: () => Promise<void>
): string {
    return installSessionManager.ensureSession(origin, retryHandler).id;
}

function updateInstallStage(
    stageId: InstallStageId,
    status?: 'pending' | 'running' | 'completed' | 'skipped' | 'failed',
    progressKind?: InstallProgressKind,
    progress?: number | null,
    message?: string,
    extras?: {
        downloadedBytes?: number | null;
        totalBytes?: number | null;
        error?: string | null;
    }
): void {
    installSessionManager.updateStage({
        stageId,
        status,
        progressKind,
        progress,
        message,
        downloadedBytes: extras?.downloadedBytes,
        totalBytes: extras?.totalBytes,
        error: extras?.error,
    });
}

function finishInstallSession(
    status: 'completed' | 'failed',
    message?: string,
    error?: string | null
): void {
    installSessionManager.finishActive(status, message, error);
}

function isInstallStageId(value: unknown): value is InstallStageId {
    return typeof value === 'string' && INSTALL_STAGE_IDS.includes(value as InstallStageId);
}

function isInstallProgressKind(value: unknown): value is InstallProgressKind {
    return value === 'bytes' || value === 'estimated' || value === 'indeterminate';
}

function handleBackendInstallProgressMessage(data: Record<string, unknown> | undefined): void {
    if (!data) {
        return;
    }
    const activeSession = installSessionManager.getActiveSnapshot();
    if (!activeSession) {
        return;
    }
    const sessionId = typeof data.session_id === 'string' ? data.session_id : '';
    if (sessionId && sessionId !== activeSession.id) {
        return;
    }
    const stageId = data.stage_id;
    if (!isInstallStageId(stageId)) {
        return;
    }
    const status =
        data.status === 'pending' ||
        data.status === 'running' ||
        data.status === 'completed' ||
        data.status === 'skipped' ||
        data.status === 'failed'
            ? data.status
            : undefined;
    const progressKind = isInstallProgressKind(data.progress_kind)
        ? data.progress_kind
        : undefined;
    const progress =
        typeof data.progress === 'number' && Number.isFinite(data.progress)
            ? data.progress
            : null;
    const message = typeof data.message === 'string' ? data.message : undefined;
    const downloadedBytes =
        typeof data.downloaded_bytes === 'number' && Number.isFinite(data.downloaded_bytes)
            ? data.downloaded_bytes
            : null;
    const totalBytes =
        typeof data.total_bytes === 'number' && Number.isFinite(data.total_bytes)
            ? data.total_bytes
            : null;
    const error = typeof data.error === 'string' ? data.error : null;
    updateInstallStage(stageId, status, progressKind, progress, message, {
        downloadedBytes,
        totalBytes,
        error,
    });
}

function formatBackendExitCode(code: number | null): string {
    if (code === null || code === undefined) {
        return 'unknown';
    }

    const unsigned = code >>> 0;
    if (isWindows() && unsigned === 0xc0000135) {
        return `${unsigned} (0x${unsigned.toString(16).toUpperCase()}: STATUS_DLL_NOT_FOUND)`;
    }

    if (isWindows()) {
        return `${unsigned} (0x${unsigned.toString(16).toUpperCase()})`;
    }

    return String(code);
}

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

function shouldPromoteConsoleLogToBasic(message: string): boolean {
    const clean = stripAnsi(message).trim();
    if (!clean) {
        return false;
    }

    if (clean.startsWith(UPDATE_PROGRESS_PREFIX)) {
        return true;
    }

    return [
        /download/i,
        /extract/i,
        /install/i,
        /ensurepip/i,
        /\bpip ensured\b/i,
        /\buv\b/i,
        /\bvenv\b/i,
        /virtual environment/i,
        /python runtime bootstrap/i,
        /python environment/i,
        /lockfile/i,
        /^cleaning up downloaded archive:/i,
        /^starting gamesentenceminer/i,
        /^\[startup/i,
        /backend update/i,
    ].some((pattern) => pattern.test(clean));
}

function formatConsoleArg(arg: unknown): string {
    if (arg instanceof Error) {
        const maybeCode = (arg as Error & { code?: unknown }).code;
        const codeSuffix = maybeCode !== undefined ? ` code=${String(maybeCode)}` : '';
        const formatted = `${arg.name}: ${arg.message}${codeSuffix}\n${arg.stack ?? ''}`.trim();
        return formatted.length > 6000 ? `${formatted.slice(0, 6000)}… [truncated]` : formatted;
    }
    if (typeof arg === 'string') {
        return arg.length > 6000 ? `${arg.slice(0, 6000)}… [truncated]` : arg;
    }
    if (arg === undefined) {
        return 'undefined';
    }
    if (arg === null) {
        return 'null';
    }
    if (typeof arg === 'object') {
        try {
            const serialized = JSON.stringify(arg, (_key, value) => {
                if (value instanceof Error) {
                    const maybeErrCode = (value as Error & { code?: unknown }).code;
                    return {
                        name: value.name,
                        message: value.message,
                        code: maybeErrCode !== undefined ? String(maybeErrCode) : undefined,
                        stack: value.stack,
                    };
                }
                return value;
            });
            if (!serialized) {
                return String(arg);
            }
            return serialized.length > 6000
                ? `${serialized.slice(0, 6000)}… [truncated]`
                : serialized;
        } catch {
            return String(arg);
        }
    }
    return String(arg);
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
    if (terminalLogSendDepth > 0) {
        return;
    }

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

    if (normalized.channel !== 'background' || normalized.level === 'ERROR' || normalized.level === 'WARNING') {
        installSessionManager.appendLog({
            message,
            level,
            stream,
            source: normalized.source,
        });
    }

    if (!canSendToMainWindow()) {
        return;
    }

    terminalLogSendDepth += 1;
    try {
        safeSendToMainWindow(stream === 'stderr' ? 'terminal-error' : 'terminal-output', normalized);
    } finally {
        terminalLogSendDepth -= 1;
    }
}

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

const updateManager = new UpdateManager({
    getPythonPath: () => pythonPath,
    closeAllPythonProcesses: async () => closeAllPythonProcesses(),
    ensureAndRunGSM: async (pyPath: string) =>
        ensureAndRunGSM(pyPath, 1, { allowDuringUpdate: true, origin: 'backend_update' }),
    reinstallPython: async () => reinstallPython(),
});

export function isPythonLaunchBlockedByUpdate(): boolean {
    return updateManager.anyUpdateInProgress;
}

export async function waitForPythonLaunchReadiness(context: string): Promise<void> {
    if (!updateManager.anyUpdateInProgress) {
        return;
    }
    console.log(
        `[Update Guard] Delaying ${context} until active updates complete.`
    );
    await updateManager.waitForNoActiveUpdates();
}

async function autoUpdate(forceUpdate: boolean = false): Promise<void> {
    await updateManager.autoUpdate(forceUpdate);
}

async function runUpdateChecks(
    shouldRestart: boolean = false,
    force: boolean = false,
    forceDev: boolean = false
): Promise<void> {
    await updateManager.runUpdateChecks(
        shouldRestart,
        force,
        forceDev,
        getConfiguredPreReleaseBranch()
    );
}

async function updateGSM(
    shouldRestart: boolean = false,
    force: boolean = false
): Promise<void> {
    await updateManager.updateGSM(shouldRestart, force, getConfiguredPreReleaseBranch());
}

async function getUpdateStatus(): Promise<UpdateStatusSnapshot> {
    return await updateManager.getUpdateStatus(getConfiguredPreReleaseBranch());
}

async function checkForAvailableUpdates(): Promise<UpdateStatusSnapshot> {
    return await updateManager.checkForAvailableUpdates(getConfiguredPreReleaseBranch());
}

async function updateAvailableTargets(): Promise<UpdateStatusSnapshot> {
    return await updateManager.updateAvailableTargets(
        true,
        getConfiguredPreReleaseBranch()
    );
}

function getGSMModulePath(): string {
    return 'GameSentenceMiner.gsm';
}

function wantsChaosHarnessRun(): boolean {
    return process.argv.includes('--dev-chaos-update');
}

function shouldSimulateStartupFailureOnce(): boolean {
    return (
        process.env.GSM_SIMULATE_STARTUP_FAILURE_ONCE === '1' ||
        process.argv.includes('--simulate-startup-failure-once')
    );
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
    const extension: 'ico' | 'png' = isWindows() ? 'ico' : 'png';
    if (forTray) {
        return getTrayBaseIconPath({
            assetsDir: getAssetsDir(),
            configuredIconStyle: getIconStyle(),
            resolvedRandomStyle: iconStyle,
            extension,
        });
    }
    if (useRareIcon) {
        return path.join(getAssetsDir(), isWindows() ? 'gsm_rare.ico' : 'gsm_rare.png');
    }
    style = style.replace(/\[.*\]/, ''); // Remove any [.*] suffix if present
    let filename = `${style}.${extension}`;
    return path.join(getAssetsDir(), filename);
}

function createPausedTrayFallbackIcon(): Electron.NativeImage {
    if (pausedTrayFallbackIconCache && !pausedTrayFallbackIconCache.isEmpty()) {
        return pausedTrayFallbackIconCache;
    }

    const pausedIconSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="28" fill="#C63B33"/>
            <rect x="21" y="18" width="8" height="28" rx="3" fill="#FFFFFF"/>
            <rect x="35" y="18" width="8" height="28" rx="3" fill="#FFFFFF"/>
        </svg>
    `.trim();
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(pausedIconSvg).toString('base64')}`;
    pausedTrayFallbackIconCache = nativeImage.createFromDataURL(dataUrl);
    return pausedTrayFallbackIconCache;
}

function createLoadingTrayFallbackIcon(): Electron.NativeImage {
    if (loadingTrayFallbackIconCache && !loadingTrayFallbackIconCache.isEmpty()) {
        return loadingTrayFallbackIconCache;
    }

    const loadingIconSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="28" fill="#1D4ED8"/>
            <circle cx="32" cy="32" r="16" fill="none" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round"
                stroke-dasharray="56 30" transform="rotate(-40 32 32)"/>
        </svg>
    `.trim();
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(loadingIconSvg).toString('base64')}`;
    loadingTrayFallbackIconCache = nativeImage.createFromDataURL(dataUrl);
    return loadingTrayFallbackIconCache;
}

function createReadyTrayFallbackIcon(): Electron.NativeImage {
    if (readyTrayFallbackIconCache && !readyTrayFallbackIconCache.isEmpty()) {
        return readyTrayFallbackIconCache;
    }

    const readyIconSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="28" fill="#15803D"/>
            <path d="M19 33.5 28 42.5 46 23.5" fill="none" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `.trim();
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(readyIconSvg).toString('base64')}`;
    readyTrayFallbackIconCache = nativeImage.createFromDataURL(dataUrl);
    return readyTrayFallbackIconCache;
}

function isReadyTrayIndicatorActive(): boolean {
    return trayReadyIndicatorExpiresAt > Date.now();
}

function clearTrayReadyIndicatorTimer(): void {
    if (trayReadyIndicatorTimer) {
        clearTimeout(trayReadyIndicatorTimer);
        trayReadyIndicatorTimer = null;
    }
}

function clearBackendStatusPollTimer(): void {
    if (backendStatusPollTimer) {
        clearInterval(backendStatusPollTimer);
        backendStatusPollTimer = null;
    }
}

function getCurrentTrayVisualState(): TrayVisualState {
    return resolveTrayVisualState({
        pythonIpcConnected,
        backendStatusReady,
        readyIndicatorActive: isReadyTrayIndicatorActive(),
        textIntakePaused,
    });
}

function getHardcodedStatusTrayIconPath(state: Exclude<TrayVisualState, 'normal'>): string {
    return getStatusTrayIconPath({
        assetsDir: getAssetsDir(),
        state,
        extension: isWindows() ? 'ico' : 'png',
    });
}

function maybeActivateReadyTrayIndicator(): void {
    if (!pythonIpcConnected || !backendStatusReady || trayReadyIndicatorExpiresAt > 0) {
        return;
    }

    trayReadyIndicatorExpiresAt = Date.now() + TRAY_READY_INDICATOR_MS;
    clearTrayReadyIndicatorTimer();
    trayReadyIndicatorTimer = setTimeout(() => {
        trayReadyIndicatorExpiresAt = 0;
        trayReadyIndicatorTimer = null;
        refreshTrayPresentation();
    }, TRAY_READY_INDICATOR_MS);
    refreshTrayPresentation();
}

async function pollBackendStatusOnce(): Promise<void> {
    if (backendStatusReady) {
        clearBackendStatusPollTimer();
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    try {
        const response = await fetch(BACKEND_STATUS_URL, { signal: controller.signal });
        if (!response.ok) {
            return;
        }
        backendStatusReady = true;
        clearBackendStatusPollTimer();
        maybeActivateReadyTrayIndicator();
        refreshTrayPresentation();
    } catch {
        // Keep polling until ready.
    } finally {
        clearTimeout(timeoutId);
    }
}

function startBackendStatusPolling(): void {
    clearBackendStatusPollTimer();
    void pollBackendStatusOnce();
    backendStatusPollTimer = setInterval(() => {
        void pollBackendStatusOnce();
    }, BACKEND_STATUS_POLL_MS);
}

function resetStartupTrayState(): void {
    pythonIpcConnected = false;
    backendStatusReady = false;
    trayReadyIndicatorExpiresAt = 0;
    clearTrayReadyIndicatorTimer();
    clearBackendStatusPollTimer();
    refreshTrayPresentation();
}

function markPythonIPCConnected(): void {
    if (pythonIpcConnected) {
        return;
    }
    pythonIpcConnected = true;
    maybeActivateReadyTrayIndicator();
    refreshTrayPresentation();
}

function getPausedTrayIcon(): string | Electron.NativeImage {
    const pausedIconPath = getHardcodedStatusTrayIconPath('paused');

    if (fs.existsSync(pausedIconPath)) {
        return pausedIconPath;
    }

    return createPausedTrayFallbackIcon();
}

function getLoadingTrayIcon(): string | Electron.NativeImage {
    const loadingIconPath = getHardcodedStatusTrayIconPath('loading');
    if (fs.existsSync(loadingIconPath)) {
        return loadingIconPath;
    }
    return createLoadingTrayFallbackIcon();
}

function getReadyTrayIcon(): string | Electron.NativeImage {
    const readyIconPath = getHardcodedStatusTrayIconPath('ready');
    if (fs.existsSync(readyIconPath)) {
        return readyIconPath;
    }
    return createReadyTrayFallbackIcon();
}

function getTrayIcon(): string | Electron.NativeImage {
    switch (getCurrentTrayVisualState()) {
        case 'loading':
            return getLoadingTrayIcon();
        case 'ready':
            return getReadyTrayIcon();
        case 'paused':
            return getPausedTrayIcon();
        default:
            return getIconPath(true);
    }
}

function refreshTrayPresentation(): void {
    if (!tray) {
        return;
    }

    const trayIcon = getTrayIcon();
    tray.setImage(trayIcon);
    tray.setToolTip(getTrayTooltip(getCurrentTrayVisualState()));
}

function setTextIntakePausedState(paused: boolean): void {
    textIntakePaused = paused;
    refreshTrayPresentation();
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
        const activeInstallSessionId = installSessionManager.getActiveSnapshot()?.id ?? '';
        const taskManagerCommand = getWindowsNamedPythonExecutable(command, APP_NAME);
        const proc = spawn(taskManagerCommand, args, {
            env: {
                ...getSanitizedPythonEnv(),
                GSM_ELECTRON: '1',
                GSM_INSTALL_SESSION_ID: activeInstallSessionId,
            }
        });

        pyProc = proc;
        writeManagedGSMProcessState(taskManagerCommand, args, proc.pid);
        resetStartupTrayState();
        setTextIntakePausedState(false);
        startBackendStatusPolling();

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
            if (msg.function === 'text_intake_state') {
                setTextIntakePausedState(Boolean(msg.data?.paused));
            }
            if (msg.function === 'on_connect') {
                markPythonIPCConnected();
            }
            if (msg.function === 'install_progress') {
                handleBackendInstallProgressMessage(msg.data);
            }
            if (msg.function === 'initialized') {
                markPythonIPCConnected();
                updateInstallStage(
                    'backend_boot',
                    'completed',
                    'estimated',
                    1,
                    'GSM backend is running.'
                );
                const activeInstallSession = installSessionManager.getActiveSnapshot();
                if (activeInstallSession) {
                    const finalizeStage = activeInstallSession.stages.find(
                        (stage) => stage.id === 'finalize'
                    );
                    if (finalizeStage && finalizeStage.status === 'pending') {
                        updateInstallStage(
                            'finalize',
                            'completed',
                            'estimated',
                            1,
                            'Setup complete.'
                        );
                    }
                    finishInstallSession('completed', 'Setup complete.');
                }
                safeSendToMainWindow('gsm-initialized', msg.data ?? {});
                updateTrayMenu();
                refreshTrayPresentation();
                if (reopenSettingsAfterBackendRestart) {
                    reopenSettingsAfterBackendRestart = false;
                    setTimeout(() => {
                        gsmStdoutManager?.sendOpenSettings();
                    }, 200);
                }
            }
            if (msg.function === 'cleanup_complete') {
                console.log('Received cleanup_complete message from Python.');
                cleanupComplete = true;
            }
            if (msg.function === 'python_exit_requested') {
                const source = String(msg.data?.source ?? '');
                backendExitRequestedFromPython = source === 'pickaxe_icon';
                if (backendExitRequestedFromPython) {
                    console.log('Python requested full app shutdown via pickaxe icon.');
                }
            }
            if (msg.function === 'restart_python_app') {
                console.log('Received restart request from Python IPC. Restarting GSM backend...');
                const openSettings = msg.data?.open_settings !== false;
                if (openSettings) {
                    reopenSettingsAfterBackendRestart = true;
                }
                void restartGSM();
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
            resetStartupTrayState();
            setTextIntakePausedState(false);
            const shouldQuitForPickaxeExit =
                code === 0 &&
                backendExitRequestedFromPython &&
                !restartingGSM &&
                !updateManager.anyUpdateInProgress;
            backendExitRequestedFromPython = false;
            if (restartingGSM) {
                restartingGSM = false;
                return;
            }
            if (code === 0) {
                resolve();
                if (shouldQuitForPickaxeExit) {
                    setTimeout(() => {
                        void quit();
                    }, 0);
                }
            } else {
                reject(new Error(`Command failed with exit code ${formatBackendExitCode(code)}`));
            }
        });

        proc.on('error', (err) => {
            clearManagedGSMProcessState();
            resetStartupTrayState();
            setTextIntakePausedState(false);
            reject(err);
        });
    });
}

async function createWindow() {
    const adminSuffix = isRunningAsAdmin() ? ' (Admin)' : '';
    const windowTitle = `${APP_NAME} v${app.getVersion()}${adminSuffix}`;

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
        getUpdateStatus: async () => await getUpdateStatus(),
        checkForUpdates: async () => await checkForAvailableUpdates(),
        updateNow: async () => await updateAvailableTargets(),
        getActiveInstallSession: () => installSessionManager.getActiveSnapshot(),
        retryInstallSession: async () => await installSessionManager.retryLastFailedSession(),
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
                ...(process.platform === 'win32' && !isRunningAsAdmin()
                    ? [{
                        label: 'Restart as Admin',
                        click: async () => {
                            await closeAllPythonProcesses();
                            restartAsAdmin();
                        },
                    } satisfies Electron.MenuItemConstructorOptions,
                    { type: 'separator' as const }]
                    : []),
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
        const message = args.map((arg) => formatConsoleArg(arg)).join(' ');
        sendTerminalLog({
            message: `${message}\r\n`,
            stream: 'stdout',
            source: 'electron',
            channel: shouldPromoteConsoleLogToBasic(message) ? 'basic' : 'background',
        });
        originalLog.apply(console, args);
    };

    console.warn = function (...args) {
        const message = args.map((arg) => formatConsoleArg(arg)).join(' ');
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
        const message = args.map((arg) => formatConsoleArg(arg)).join(' ');
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

        tray = new Tray(getTrayIcon());
        refreshTrayPresentation();
        updateTrayMenu();

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

interface GSMTrayProfileState {
    currentProfile: string | null;
    profileNames: string[];
}

function loadGSMTrayProfileState(): GSMTrayProfileState {
    const configPath = path.join(BASE_DIR, 'config.json');
    if (!fs.existsSync(configPath)) {
        return { currentProfile: null, profileNames: [] };
    }

    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw) as {
            current_profile?: unknown;
            configs?: Record<string, unknown>;
        };
        const configs =
            parsed && typeof parsed.configs === 'object' && parsed.configs !== null
                ? parsed.configs
                : {};
        const profileNames = Object.keys(configs);
        const currentProfile =
            typeof parsed.current_profile === 'string' ? parsed.current_profile : null;

        return { currentProfile, profileNames };
    } catch (error) {
        console.warn('Failed to load GSM profile data for tray menu:', error);
        return { currentProfile: null, profileNames: [] };
    }
}

function sendTrayCommand(description: string, callback: (manager: GSMStdoutManager) => void): boolean {
    if (!gsmStdoutManager) {
        console.warn(`Cannot ${description}: Python IPC is not ready.`);
        return false;
    }

    callback(gsmStdoutManager);
    return true;
}

function refreshTrayMenuSoon(delayMs: number = 250): void {
    setTimeout(() => {
        updateTrayMenu();
    }, delayMs);
}

function buildProfileTraySubmenu(): Electron.MenuItemConstructorOptions[] {
    const { currentProfile, profileNames } = loadGSMTrayProfileState();
    if (profileNames.length === 0) {
        return [{ label: 'No Profiles Found', enabled: false }];
    }

    return profileNames.map((profileName) => ({
        label: profileName,
        type: 'radio',
        checked: profileName === currentProfile,
        click: () => {
            if (profileName === currentProfile) {
                return;
            }

            if (
                sendTrayCommand(`switch profile to ${profileName}`, (manager) =>
                    manager.sendSwitchProfile(profileName)
                )
            ) {
                refreshTrayMenuSoon();
            }
        },
    }));
}

function buildDevTraySubmenu(): Electron.MenuItemConstructorOptions[] {
    return [
        {
            label: 'Anki Confirmation Dialog',
            click: () => {
                sendTrayCommand('open Anki confirmation test window', (manager) =>
                    manager.sendTestAnkiConfirmation()
                );
            },
        },
        {
            label: 'Screenshot Selector',
            click: () => {
                sendTrayCommand('open screenshot selector test window', (manager) =>
                    manager.sendTestScreenshotSelector()
                );
            },
        },
        {
            label: 'Furigana Filter Preview',
            click: () => {
                sendTrayCommand('open furigana filter test window', (manager) =>
                    manager.sendTestFuriganaFilter()
                );
            },
        },
        {
            label: 'Area Selector',
            click: () => {
                sendTrayCommand('open area selector test window', (manager) =>
                    manager.sendTestAreaSelector()
                );
            },
        },
        {
            label: 'Screen Cropper',
            click: () => {
                sendTrayCommand('open screen cropper test window', (manager) =>
                    manager.sendTestScreenCropper()
                );
            },
        },
    ];
}

function buildTrayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Open Settings',
            click: () => {
                if (!sendTrayCommand('open settings', (manager) => manager.sendOpenSettings())) {
                    showWindow();
                }
            },
        },
        {
            label: 'Open Text Feed',
            click: () => {
                sendTrayCommand('open texthooker', (manager) => manager.sendOpenTexthooker());
            },
        },
        { type: 'separator' },
        {
            label: 'Switch Profile',
            submenu: buildProfileTraySubmenu(),
        },
    ];

    if (isDev) {
        template.push({
            label: 'Test Windows',
            submenu: buildDevTraySubmenu(),
        });
    }

    template.push(
        { type: 'separator' },
        { label: 'Update GSM', click: () => runUpdateChecks(true, true) },
        { label: 'Restart Python App', click: () => restartGSM() },
        { label: 'Open GSM Folder', click: () => shell.openPath(BASE_DIR) }
    );

    if (process.platform === 'win32' && !isRunningAsAdmin()) {
        template.push({
            label: 'Restart as Admin',
            click: async () => {
                await closeAllPythonProcesses();
                restartAsAdmin();
            },
        });
    }

    if (isDev) {
        template.push({
            label: 'Restart App',
            click: async () => {
                closeAllPythonProcesses().then(() => {
                    app.relaunch();
                    app.exit(0);
                });
            },
        });
    }

    template.push(
        { type: 'separator' },
        {
            label: 'Exit',
            click: () => {
                void quit();
            },
        }
    );

    return template;
}

function updateTrayMenu(): void {
    if (!tray) {
        return;
    }

    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
}

// Removed legacy WebSocket server startup; stdout IPC now used.

/**
 * Ensures GameSentenceMiner is installed before running it.
 */
interface EnsureAndRunOptions {
    allowDuringUpdate?: boolean;
    origin?: InstallSessionOrigin;
}

async function ensureAndRunGSM(
    pythonPath: string,
    retry = 1,
    options?: EnsureAndRunOptions
): Promise<void> {
    const origin = options?.origin ?? 'startup';
    ensureInstallSession(origin, async () => {
        await ensureAndRunGSM(pythonPath, 1, {
            ...options,
            allowDuringUpdate: true,
            origin,
        });
    });
    updateInstallStage('prepare', 'running', 'estimated', 0.2, 'Preparing install session...');

    if (!options?.allowDuringUpdate) {
        await waitForPythonLaunchReadiness('GSM backend startup');
    }

    // Best-effort cleanup for a stale backend process previously spawned by GSM.
    await cleanupStaleManagedGSMProcess();
    updateInstallStage('prepare', 'completed', 'estimated', 1, 'Install session prepared.');
    devFaultInjector.maybeFail('startup.ensure_and_run_enter');

    let runtimePythonPath = pythonPath;
    const preReleasePackageSpecifier = getPreReleasePackageSpecifier();
    const preReleaseEnabled = preReleasePackageSpecifier !== null;
    let isInstalled = await isPackageInstalled(runtimePythonPath, APP_NAME);

    try {
        updateInstallStage(
            'verify_runtime',
            'running',
            'estimated',
            0.2,
            'Verifying Python runtime and pip tooling...'
        );
        devFaultInjector.maybeFail('startup.check_and_ensure_pip');
        await checkAndEnsurePip(runtimePythonPath);
        devFaultInjector.maybeFail('startup.check_and_install_uv');
        await checkAndInstallUV(runtimePythonPath);
        updateInstallStage(
            'verify_runtime',
            'completed',
            'estimated',
            1,
            'Python runtime tooling verified.'
        );
    } catch (error) {
        console.warn(
            'Python runtime bootstrap failed (pip/uv). Reinitializing python_venv from scratch...',
            error
        );
        updateInstallStage(
            'verify_runtime',
            'running',
            'estimated',
            0.45,
            'Python runtime verification failed. Rebuilding managed Python environment...'
        );
        await closeAllPythonProcesses();
        await reinstallPython();
        runtimePythonPath = await getOrInstallPython();
        pythonPath = runtimePythonPath;
        setPythonPath(runtimePythonPath);
        await checkAndEnsurePip(runtimePythonPath);
        await checkAndInstallUV(runtimePythonPath);
        isInstalled = await isPackageInstalled(runtimePythonPath, APP_NAME);
        updateInstallStage(
            'verify_runtime',
            'completed',
            'estimated',
            1,
            'Python runtime tooling rebuilt and verified.'
        );
    }

    // Resolve extras and persist any pruned options.
    const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
        getPythonExtras()
    );
    if (ignoredExtras.length > 0) {
        setPythonExtras(selectedExtras);
        console.warn(
            `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed: ${allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
            }.`
        );
    }

    // Sync environment from the bundled uv.lock.
    if (!preReleaseEnabled) {
        try {
            devFaultInjector.maybeFail('startup.sync_lock_check');
            updateInstallStage(
                'lock_sync',
                'running',
                'estimated',
                0.1,
                'Checking whether the Python environment matches the lockfile...'
            );
            await syncLockedEnvironment(runtimePythonPath, selectedExtras, true);
            console.log('Python environment already matches lockfile.');
            updateInstallStage(
                'lock_sync',
                'skipped',
                'estimated',
                1,
                'Python environment already matches the lockfile.'
            );
        } catch {
            console.log(
                `Syncing Python environment with lockfile, extras: ${selectedExtras.length > 0 ? selectedExtras.join(', ') : 'none'
                }`
            );
            devFaultInjector.maybeFail('startup.sync_lock_apply');
            updateInstallStage(
                'lock_sync',
                'running',
                'estimated',
                0.15,
                'Syncing Python environment with the bundled lockfile...'
            );
            await syncLockedEnvironment(runtimePythonPath, selectedExtras, false, (event) => {
                updateInstallStage(
                    'lock_sync',
                    'running',
                    'estimated',
                    event.progress,
                    event.message
                );
            });
            updateInstallStage(
                'lock_sync',
                'completed',
                'estimated',
                1,
                'Python environment synced to the lockfile.'
            );
        }
    } else {
        updateInstallStage(
            'lock_sync',
            'skipped',
            'estimated',
            1,
            'Skipped lockfile sync because pre-release backend mode is enabled.'
        );
    }

    // Install the package itself if not present.
    if (!isInstalled) {
        const packageSpecifier = isDev
            ? '.'
            : (preReleasePackageSpecifier ?? PACKAGE_NAME);
        console.log(`${APP_NAME} is not installed. Installing ${packageSpecifier}...`);
        updateInstallStage(
            'gsm_package',
            'running',
            'estimated',
            0.1,
            `Installing ${APP_NAME} backend package...`
        );
        devFaultInjector.maybeFail('startup.install_package');
        await installPackageNoDeps(runtimePythonPath, packageSpecifier, true, (event) => {
            updateInstallStage(
                'gsm_package',
                'running',
                'estimated',
                event.progress,
                event.message
            );
        });
        console.log('Installation complete.');
        updateInstallStage(
            'gsm_package',
            'completed',
            'estimated',
            1,
            `${APP_NAME} backend package installed.`
        );
    } else {
        updateInstallStage(
            'gsm_package',
            'skipped',
            'estimated',
            1,
            `${APP_NAME} backend package is already installed.`
        );
    }

    console.log('Starting GameSentenceMiner...');
    const backendLaunchStartedAt = Date.now();
    try {
        const args = ['-m', getGSMModulePath()];
        if (isDev) {
            args.push('--dev');
        }
        devFaultInjector.maybeFail('startup.run_gsm');
        updateInstallStage(
            'backend_boot',
            'running',
            'estimated',
            0.15,
            'Starting the GSM backend process...'
        );
        if (shouldSimulateStartupFailureOnce() && !simulatedStartupFailureTriggered) {
            simulatedStartupFailureTriggered = true;
            throw new Error(SIMULATED_STARTUP_FAILURE_MESSAGE);
        }
        return await runGSM(runtimePythonPath, args);
    } catch (err) {
        console.error('Failed to start GameSentenceMiner:', err);
        console.log(`[Startup] Failed to start GameSentenceMiner: ${formatConsoleArg(err)}`);
        const backendRuntimeMs = Date.now() - backendLaunchStartedAt;
        const failedSoonAfterLaunch = backendRuntimeMs <= STARTUP_REPAIR_WINDOW_MS;
        const startupFailureDetails = `[Startup] Backend launch failure details: retryRemaining=${retry}, runtimeMs=${backendRuntimeMs}, withinRepairWindow=${failedSoonAfterLaunch}, thresholdMs=${STARTUP_REPAIR_WINDOW_MS}, preRelease=${preReleaseEnabled}, pythonPath=${runtimePythonPath}`;
        console.error(startupFailureDetails);
        console.log(startupFailureDetails);
        if (retry > 0 && failedSoonAfterLaunch) {
            const repairStartedAt = Date.now();
            const repairSpecifier = isDev
                ? '.'
                : (preReleasePackageSpecifier ?? PACKAGE_NAME);
            console.log(
                `[Startup Repair] Starting repair flow: retryRemaining=${retry}, runtimeMs=${backendRuntimeMs}, specifier=${repairSpecifier}, extras=${selectedExtras.length > 0 ? selectedExtras.join(', ') : 'none'
                }, preRelease=${preReleaseEnabled}`
            );
            try {
                console.log('[Startup Repair] Step 1/4: Closing running backend-related processes.');
                await closeAllPythonProcesses();

                console.log('[Startup Repair] Step 2/4: Cleaning uv cache.');
                updateInstallStage(
                    'backend_boot',
                    'running',
                    'estimated',
                    0.25,
                    'Backend launch failed. Cleaning uv cache before retry...'
                );
                devFaultInjector.maybeFail('startup.repair.clean_uv_cache');
                await cleanUvCache(runtimePythonPath);

                if (!preReleaseEnabled) {
                    console.log('[Startup Repair] Step 3/4: Re-syncing lockfile dependencies.');
                    devFaultInjector.maybeFail('startup.repair.sync_lock');
                    updateInstallStage(
                        'lock_sync',
                        'running',
                        'estimated',
                        0.2,
                        'Re-syncing the lockfile after launch failure...'
                    );
                    await syncLockedEnvironment(runtimePythonPath, selectedExtras, false, (event) => {
                        updateInstallStage(
                            'lock_sync',
                            'running',
                            'estimated',
                            event.progress,
                            event.message
                        );
                    });
                    updateInstallStage(
                        'lock_sync',
                        'completed',
                        'estimated',
                        1,
                        'Lockfile dependencies refreshed after launch failure.'
                    );
                } else {
                    console.log('[Startup Repair] Step 3/4: Skipped lockfile sync (pre-release mode).');
                }

                console.log('[Startup Repair] Step 4/4: Reinstalling GSM backend package.');
                devFaultInjector.maybeFail('startup.repair.install_package');
                updateInstallStage(
                    'gsm_package',
                    'running',
                    'estimated',
                    0.2,
                    'Reinstalling the GSM backend package after launch failure...'
                );
                await installPackageNoDeps(runtimePythonPath, repairSpecifier, true, (event) => {
                    updateInstallStage(
                        'gsm_package',
                        'running',
                        'estimated',
                        event.progress,
                        event.message
                    );
                });
                updateInstallStage(
                    'gsm_package',
                    'completed',
                    'estimated',
                    1,
                    'GSM backend package reinstalled after launch failure.'
                );
            } catch (repairError) {
                const repairDurationMs = Date.now() - repairStartedAt;
                console.error(
                    `[Startup Repair] Repair flow failed after ${repairDurationMs}ms; backend will not be retried automatically.`,
                    repairError
                );
                console.log(
                    `[Startup Repair] Repair flow failed after ${repairDurationMs}ms; error=${formatConsoleArg(
                        repairError
                    )}`
                );
                updateInstallStage(
                    'backend_boot',
                    'failed',
                    'estimated',
                    null,
                    'Backend repair failed.',
                    {
                        error: repairError instanceof Error ? repairError.message : String(repairError),
                    }
                );
                throw repairError;
            }

            const repairDurationMs = Date.now() - repairStartedAt;
            console.log(
                `[Startup Repair] Repair completed in ${repairDurationMs}ms. Retrying backend launch (remaining retries after this: ${retry - 1
                }).`
            );
            return await ensureAndRunGSM(runtimePythonPath, retry - 1, options);
        }
        if (retry > 0 && !failedSoonAfterLaunch) {
            console.warn(
                `Skipping automatic repair because backend failed after ${backendRuntimeMs}ms (threshold ${STARTUP_REPAIR_WINDOW_MS}ms).`
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        updateInstallStage(
            'backend_boot',
            'failed',
            'estimated',
            null,
            'Failed to start the GSM backend process.',
            {
                error: err instanceof Error ? err.message : String(err),
            }
        );
        finishInstallSession(
            'failed',
            'Failed to start the GSM backend process.',
            err instanceof Error ? err.message : String(err)
        );
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
        runOverlayWithSource('startup');
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
            bootstrapPreReleaseSettingsFromMetadata();
            ensureInstallSession('startup', async () => {
                if (pythonPath) {
                    await ensureAndRunGSM(pythonPath, 1, { origin: 'startup' });
                }
            });
            updateInstallStage(
                'prepare',
                'running',
                'estimated',
                0.05,
                'Preparing first-run startup workflow...'
            );
            createWindow().then(async () => {
                createTray();
                autoLauncher.startPolling();
                // setTimeout(async () => {
                //     await checkAndRunWizard(true);
                // }, 1000);
                if (!getConfiguredPreReleaseBranch()) {
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
                } else {
                    log.info(
                        'Skipping PyPI backend update notification check because pre-release backend mode is enabled.'
                    );
                }
            });

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
                                getConfiguredPreReleaseBranch()
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
            const preReleaseBranch = getConfiguredPreReleaseBranch();
            let backendUpdatedDuringStartup = false;
            const updateFlagPath = path.join(BASE_DIR, 'update_python.flag');
            if (appVersionChanged) {
                log.info(
                    `Detected Electron app version change (${storedVersion} -> ${currentVersion}). Forcing Python update before launch.`
                );
            }
            if (fs.existsSync(updateFlagPath)) {
                await updateGSM(false, true);
                backendUpdatedDuringStartup = true;
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
                        `Backend update reported failure. Keeping ${updateFlagPath} for retry. Reason: ${updateManager.lastBackendUpdateFailureReason ?? 'unknown'
                        }`
                    );
                }
            } else if (appVersionChanged) {
                await updateGSM(false, true);
                backendUpdatedDuringStartup = true;
            } else if (!preReleaseBranch && getAutoUpdateGSMApp()) {
                await updateGSM(false, false);
                backendUpdatedDuringStartup = true;
            }
            if (isDev && FeatureFlags.ALWAYS_UPDATE_IN_DEV) {
                await updateGSM(false, true);
                backendUpdatedDuringStartup = true;
            }
            if (preReleaseBranch) {
                if (!backendUpdatedDuringStartup) {
                    console.log(
                        `Pre-release backend enabled (branch: ${preReleaseBranch}), forcing backend update...`
                    );
                    await updateGSM(false, true);
                    backendUpdatedDuringStartup = true;
                } else {
                    log.info(
                        `Pre-release backend update already ran during startup (branch: ${preReleaseBranch}). Skipping duplicate run.`
                    );
                }
            }
            if (storedVersion !== currentVersion) {
                setElectronAppVersion(currentVersion);
            }

            // Launch backend before UI/module initialization, then continue startup.
            void ensureAndRunGSM(pythonPath, 1, { origin: 'startup' }).catch(async (err) => {
                console.log('Failed to run GSM, attempting repair of python package...', err);
                await updateGSM(true, true);
            });
        } catch (error) {
            console.error('Failed to initialize Python runtime on startup:', error);
            finishInstallSession(
                'failed',
                'Failed to initialize the managed Python runtime.',
                error instanceof Error ? error.message : String(error)
            );
        }

        processArgsAndStartSettings()
            .then((_) => console.log('Processed Args'))
            .catch((error) => console.warn('Failed to process startup args:', error));
        if (getAutoUpdateGSMApp()) {
            if (await isConnected()) {
                if (getPullPreReleases()) {
                    console.log('Checking for pre-release app updates...');
                } else {
                    console.log('Checking for updates...');
                }
                await autoUpdate();
            }
        }

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
    if (restartingGSM) {
        console.log('GSM restart already in progress. Ignoring duplicate request.');
        return;
    }
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
export function sendOpenSettings(data?: Record<string, unknown>) {
    gsmStdoutManager?.sendOpenSettings(data);
}
export function sendOpenOverlaySettings() {
    if (!gsmStdoutManager) {
        return false;
    }
    gsmStdoutManager.sendOpenOverlaySettings();
    return true;
}
export function sendOpenTexthooker() { gsmStdoutManager?.sendOpenTexthooker(); }
