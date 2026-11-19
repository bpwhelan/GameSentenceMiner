import { activeGame } from './active_game.js';
import { attachHomeDictionary, homeReaderSession, preserveHomePreferences } from './services/reader_dictionary.js';
import { gamePrivilegeMonitor } from './services/game_privileges.js';
import { refreshGamePrivilegeCapture, startGamePrivilegeChecks, stopGamePrivilegeChecks } from './services/game_privileges_runtime.js';
import { getActiveCapture } from './ui/texthook.js';
import { startGameBackgroundHooks, stopGameBackgroundHooks } from './services/game_background_runtime.js';
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    screen,
    shell,
    Tray,
} from 'electron';
import {
    configureNotificationDelivery,
    sendAgentRestartNotification,
    sendGSMCrashNotification,
    sendGSMReadyNotification,
    sendGamePrivilegeWarningNotification,
    sendGSMStillRunningInTrayNotification,
    sendNotificationFromPython,
} from './notifications.js';
import * as path from 'path';
import { NativePythonProcess } from './runtime/native_python.js';
import {
    getOrInstallPython,
    hasManagedPythonInstall,
} from './python/python_downloader.js';
import {
    APP_NAME,
    BASE_DIR,
    execFileAsync,
    getAssetsDir,
    getRendererEntryPath,
    getResourcesDir,
    resolvePreReleaseBranch,
    getSecureWebPreferences,
    isConnected,
    isDev,
    isWindows,
    isRunningAsAdmin,
    restartAsAdmin,
} from './util.js';
import {
    getDefaultBaseDir,
    getPointerFilePath,
    getProfileDir,
    writeDataDirPointer,
    writeDataDirRegistry,
} from './data_dir.js';
import { performDataMove, validateTargetDir, type RelocateProgress } from './services/data_relocate.js';
import { getWindowsAppDetails, getWindowsAppId } from './windows_app_identity.js';
import { fileURLToPath } from 'node:url';

import log from 'electron-log/main.js';
import { recordProcessOutput } from './services/logging.js';
import {
    getNotificationPreferences,
    getAutoUpdateGSMApp,
    getPullPreReleases,
    getPreReleaseMetadataAutoEnableApplied,
    getPendingDesktopChangelog,
    getPythonExtras,
    getQuitOnWindowClose,
    getRunOverlayOnStartup,
    getStartConsoleMinimized,
    getElectronAppVersion,
    getHasCompletedSetup,
    setPythonPath,
    setElectronAppVersion,
    setHasCompletedSetup,
    getIconStyle,
    getSeasonalEffectsDisabled,
    setIconStyle,
    setPendingDesktopChangelog,
    clearPendingDesktopChangelog,
    hasSeenDesktopChangelog,
    markDesktopChangelogSeen,
    setPullPreReleases,
    setPreReleaseMetadataAutoEnableApplied,
} from './store.js';
import { getSeasonalEvent, resolveSeasonalIconStyle } from '../shared/seasonal.js';
import { playNotificationSound } from './services/notification_sound.js';
import { launchSteamGameID } from './ui/steam.js';
import { bus, getBroker, getBusConnectInfo, startBus, stopBus } from './runtime/bus_client.js';
import { AGENT_RESTART_ARG, agentRelaunchArgs, startAgentControl } from './services/agent_control.js';
import { getProcessManager, setLaunchBlockedCheck, stopManagedProcesses } from './runtime/process_supervisor.js';
import { getWindowsSystemExecutable } from './runtime/windows_tools.js';
import { submitTextObservation } from './runtime/text_ingress.js';
import {
    textGeometryToOverlayPayload,
    type TextGeometryV1,
} from './ui/text_geometry.js';
import {
    closeOBSFromElectron,
    ensureObsInstalledAndLaunch,
    isObsRuntimeUpdateInProgress,
    waitForObsRuntimeUpdate,
    isOBSConnected,
    launchOBSFromElectron,
    setOBSScene,
    syncProcessPausingTargetForCurrentScene,
} from './ui/obs.js';
import {
    configureWindowSceneSwitcherRuntime,
    handleForegroundWindowSnapshot,
    setForegroundWindowHookStatus,
    shutdownWindowSceneSwitcher,
} from './services/window_scene_switcher.js';
import type {
    ForegroundWindowSnapshot,
    WindowSceneSwitcherHookStatus,
} from '../shared/window_scene_switcher.js';
import { startOCR, startManualOCR, stopOCR, getOCRRuntimeState, waitForOCRShutdown } from './ui/ocr.js';
import * as fs from 'node:fs';
import {
    setOverlayEnabled,
    runOverlayWithSource,
    stopOverlay,
    waitForOverlayShutdown,
} from './ui/front.js';
import { configureInProcessOverlayHost } from './overlay_runtime.js';
import { execFile } from 'node:child_process';
import { autoLauncher } from './auto_launcher.js';
import { registerMainIPC } from './services/main_ipc.js';
import { installSessionManager } from './services/install_session_state.js';
import { UpdateManager } from './services/update_manager.js';
import { syncStartupBackend } from './services/startup_backend_update.js';
import { markStartup } from './services/startup_timing.js';
import type { UpdateStatusSnapshot } from './services/update_manager.js';
import { APP_UPDATE_STATUS_CHANNEL } from '../shared/app_update.js';
import { DevUpdatePreview } from './services/dev_update_preview.js';
import { DevOcrBenchmark } from './services/ocr_benchmark.js';
import { DevVadDebug } from './services/vad_debug.js';
import { devFaultInjector } from './services/dev_fault_injection.js';
import { runUpdateChaosHarness } from './services/update_chaos_harness.js';
import {
    DesktopChangelogManager,
    getDesktopUpdateChangelogTarget,
} from './services/desktop_changelog.js';
import { registerChangelogProtocolHandler } from './services/changelog_protocol.js';
import { startInputServer, stopInputServer } from './services/input_server.js';
import { getConfiguredSinglePort } from './gsm_config.js';
import {
    getStatusTrayIconPath,
    getTrayBaseIconPath,
    getTrayTooltip,
    resolveTrayVisualState,
    type TrayVisualState,
} from './tray_icons.js';
import {
    checkAndInstallUV,
    getBundledBackendVersion,
    getInstalledPackageVersion,
    getProjectPath,
    getVenvDirFromPythonPath,
    isPackageInstalled,
} from './services/python_ops.js';
import { BackendProcessError } from './services/managed_python_repair.js';
import type {
    InstallProgressKind,
    InstallSessionOrigin,
    InstallStageId,
} from '../shared/install_session.js';
import { pythonCall } from './runtime/native_python_install.js';

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

const YOUTUBE_EMBED_REFERER = 'https://github.com/bpwhelan/GameSentenceMiner/';
let cachedPreReleaseBranch: string | null | undefined = undefined;

function configureYouTubeEmbedHeaders(window: BrowserWindow): void {
    window.webContents.session.webRequest.onBeforeSendHeaders(
        {
            urls: [
                'https://youtube.com/*',
                'https://*.youtube.com/*',
                'https://www.youtube-nocookie.com/*',
                'https://*.youtube-nocookie.com/*',
            ],
        },
        (details, callback) => {
            const requestHeaders = { ...details.requestHeaders };
            for (const header of Object.keys(requestHeaders)) {
                if (header.toLowerCase() === 'referer') {
                    delete requestHeaders[header];
                }
            }
            requestHeaders.Referer = YOUTUBE_EMBED_REFERER;
            callback({ requestHeaders });
        },
    );
}

function getPreReleaseBranch(): string | null {
    if (cachedPreReleaseBranch !== undefined) {
        return cachedPreReleaseBranch;
    }
    const branch = resolvePreReleaseBranch();
    cachedPreReleaseBranch = branch;
    if (branch) {
        console.log(`Detected prerelease metadata (branch: ${branch})`);
    }
    return branch;
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
export let pyProc: NativePythonProcess;
export let isQuitting = false;
let restartingGSM: boolean = false;
let gsmStopPromise: Promise<void> | null = null;
const intentionalBackendStops = new WeakSet<NativePythonProcess>();
let reopenSettingsAfterBackendRestart: boolean = false;
let pythonPath: string;
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
let backendExitRequestedFromPython = false;
let textIntakePaused = false;
let pythonIpcConnected = false;
let backendStatusReady = false;
let backendInitialized = false;
let agentControl: ReturnType<typeof startAgentControl> | null = null;
const agentRestartId = process.argv
    .find((arg) => arg.startsWith(AGENT_RESTART_ARG))?.slice(AGENT_RESTART_ARG.length) ?? null;
let agentRestartReadyNotified = false;
let pausedTrayFallbackIconCache: Electron.NativeImage | null = null;
let loadingTrayFallbackIconCache: Electron.NativeImage | null = null;
let readyTrayFallbackIconCache: Electron.NativeImage | null = null;
let backendStatusPollTimer: ReturnType<typeof setInterval> | null = null;
let trayReadyIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
let trayReadyIndicatorExpiresAt = 0;
let hasShownCloseToTrayNotification = false;
let quitFromWindowCloseInProgress = false;
let quitPromise: Promise<void> | null = null;
let quitCleanupComplete = false;
const UPDATE_PROGRESS_PREFIX = 'UpdateProgress:';
const TRAY_READY_INDICATOR_MS = 10_000;
const BACKEND_STATUS_POLL_MS = 2_000;
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

let desktopChangelogManager: DesktopChangelogManager;

function ensureInstallSession(
    origin: InstallSessionOrigin,
    retryHandler?: () => Promise<void>
): string {
    return installSessionManager.ensureSession(origin, retryHandler).id;
}

function markStartupInstallComplete(reason: string): void {
    if (getHasCompletedSetup()) {
        return;
    }
    setHasCompletedSetup(true);
    log.info(`Marked first install complete: ${reason}`);
}

function shouldTrackStartupInstallSession(): boolean {
    if (getHasCompletedSetup()) {
        return false;
    }

    return !hasManagedPythonInstall();
}

function startStartupInstallSession(): void {
    ensureInstallSession('startup', async () => {
        const retryPythonPath = pythonPath || (await getOrInstallPython());
        pythonPath = retryPythonPath;
        setPythonPath(retryPythonPath);
        await ensureAndRunGSM(retryPythonPath, 1, {
            origin: 'startup',
            trackInstallSession: true,
        });
    });
    updateInstallStage(
        'prepare',
        'running',
        'estimated',
        0.05,
        'Preparing first-run startup workflow...'
    );
}

async function resolveStartupInstallSessionAfterPythonReady(
    runtimePythonPath: string
): Promise<boolean> {
    if (getHasCompletedSetup()) {
        return false;
    }

    try {
        if (await isPackageInstalled(runtimePythonPath, APP_NAME)) {
            markStartupInstallComplete('managed backend package already exists');
            return false;
        }
    } catch (error) {
        console.warn('Unable to inspect existing backend package before startup:', error);
    }

    startStartupInstallSession();
    return true;
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
    const snapshot = installSessionManager.finishActive(status, message, error);
    if (snapshot?.origin === 'startup' && status === 'completed') {
        markStartupInstallComplete(message || 'startup install session completed');
    }
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

const ORIGIN_PREFIX_RE =
    /^((?:\u001b\[[0-9;]*m)*)\[((?:py|python|rust|electron|renderer|frida|system)(?::[a-zA-Z0-9._/-]+)?)\](?:\u001b\[[0-9;]*m)*(\s+|$)/i;

function parsePythonLogLevel(message: string): string | null {
    const clean = stripAnsi(message).trimStart().replace(ORIGIN_PREFIX_RE, '');
    const threeField = clean.match(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?\s+\|\s+[^|]+\|\s+([A-Z_]+)\s+\|/
    );
    if (threeField) return threeField[1];
    const twoField = clean.match(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?\s+\|\s+([A-Z_]+)\s+\|/
    );
    return twoField ? twoField[1] : null;
}

function ensureTerminalOrigin(source: string | undefined, message: string): string {
    if (!message.trim() || ORIGIN_PREFIX_RE.test(message)) {
        return message;
    }
    const clean = stripAnsi(message);
    if (clean.startsWith(UPDATE_PROGRESS_PREFIX)) {
        return message;
    }
    const origin =
        source === 'python'
            ? 'py:backend'
            : source === 'electron'
              ? 'electron:main'
              : source && source.trim()
                ? source.trim()
                : 'system';
    return `[${origin}] ${message}`;
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

    const clean = stripAnsi(message).trimStart().replace(ORIGIN_PREFIX_RE, '');
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
    const rawMessage = payload.message ?? '';
    if (shouldSuppressTerminalLog(rawMessage)) {
        return;
    }
    const source = payload.source ?? 'system';
    const message = ensureTerminalOrigin(source, rawMessage);
    const level = payload.level ? payload.level.toUpperCase() : undefined;
    const channel = payload.channel ?? inferTerminalChannel(message, level, stream);
    const normalized: TerminalLogPayload = {
        message,
        stream,
        level,
        channel,
        source,
    };

    if (normalized.source !== 'python' && (normalized.channel !== 'background' || normalized.level === 'ERROR' || normalized.level === 'WARNING')) {
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

desktopChangelogManager = new DesktopChangelogManager(
    {
        getPending: () => getPendingDesktopChangelog(),
        setPending: (record) => setPendingDesktopChangelog(record),
        clearPending: (toVersion) => clearPendingDesktopChangelog(toVersion),
        hasSeen: (version) => hasSeenDesktopChangelog(version),
        markSeen: (version) => markDesktopChangelogSeen(version),
    },
    {
        assetsDir: getAssetsDir(),
    }
);

desktopChangelogManager.setSnapshotListener((snapshot) => {
    safeSendToMainWindow('changelog.snapshot', snapshot);
});

desktopChangelogManager.setManualSnapshotListener((snapshot) => {
    safeSendToMainWindow('changelog.manualSnapshot', snapshot);
});

const updateManager = new UpdateManager({
    getPythonPath: () => pythonPath,
    closeAllPythonProcesses: async () => closeAllPythonProcesses(),
    closeAllForAppUpdate: async () => {
        await waitForObsRuntimeUpdate();
        await closeAllPythonProcesses();
        const { shutdownTextHookForUpdate } = await import('./ui/texthook.js');
        await shutdownTextHookForUpdate();
    },
    ensureAndRunGSM: async (pyPath: string) =>
        ensureAndRunGSM(pyPath, 1, { allowDuringUpdate: true, origin: 'backend_update' }),
});

const devUpdatePreview = new DevUpdatePreview(isDev, () => {
    safeSendToMainWindow(APP_UPDATE_STATUS_CHANNEL, devUpdatePreview.apply(updateManager.getAppUpdateStatus()));
});

updateManager.setAppUpdateStatusListener((status) => {
    if (status.downloading) devUpdatePreview.clear();
    safeSendToMainWindow(APP_UPDATE_STATUS_CHANNEL, devUpdatePreview.apply(status));
});

export function isApplicationUpdateInProgress(): boolean { return updateManager.anyUpdateInProgress; }

export function isPythonLaunchBlockedByUpdate(): boolean {
    return updateManager.anyUpdateInProgress || isObsRuntimeUpdateInProgress();
}

export async function waitForPythonLaunchReadiness(context: string): Promise<void> {
    if (isObsRuntimeUpdateInProgress()) await waitForObsRuntimeUpdate();
    if (!updateManager.anyUpdateInProgress) {
        return;
    }
    console.log(
        `[Update Guard] Delaying ${context} until active updates complete.`
    );
    await updateManager.waitForNoActiveUpdates();
}

async function runUpdateChecks(
    shouldRestart: boolean = false,
    force: boolean = false,
    forceDev: boolean = false
): Promise<void> {
    if (isObsRuntimeUpdateInProgress()) await waitForObsRuntimeUpdate();
    await updateManager.runUpdateChecks(
        shouldRestart,
        force,
        forceDev
    );
}

async function updateGSM(
    shouldRestart: boolean = false,
    force: boolean = false
): Promise<void> {
    if (isObsRuntimeUpdateInProgress()) await waitForObsRuntimeUpdate();
    await updateManager.updateGSM(shouldRestart, force);
}

async function getUpdateStatus(): Promise<UpdateStatusSnapshot> {
    return await updateManager.getUpdateStatus();
}

async function checkForAvailableUpdates(): Promise<UpdateStatusSnapshot> {
    return await updateManager.checkForAvailableUpdates();
}

async function updateAvailableTargets(): Promise<UpdateStatusSnapshot> {
    if (isObsRuntimeUpdateInProgress()) await waitForObsRuntimeUpdate();
    return await updateManager.updateAvailableTargets(true);
}

function showUpdateChangelogPreview(input: {
    fromVersion: string;
    toVersion: string;
    includePrereleases?: boolean;
}) {
    return desktopChangelogManager.startUpdatePreview(
        {
            fromVersion: input.fromVersion,
            toVersion: input.toVersion,
        },
        {
            includePrereleases: input.includePrereleases,
        }
    );
}

function wantsChaosHarnessRun(): boolean {
    return process.argv.includes('--dev-chaos-update');
}

let useRareIcon: boolean = Math.random() < .01;
let iconStyle = "";

const availableIcons = ['gsm', 'gsm_cute', 'gsm_jacked', 'gsm_cursed'];

function selectRandomIconStyle(): string {
    const randomIndex = Math.floor(Math.random() * availableIcons.length);
    return availableIcons[randomIndex];
}

function refreshResolvedRandomIconStyle(configuredIconStyle: string = getIconStyle()): void {
    iconStyle = configuredIconStyle.includes('random') ? selectRandomIconStyle() : "";
}

function getResolvedIconStyle(configuredIconStyle: string = getIconStyle()): string {
    if (!configuredIconStyle.includes('random')) {
        return configuredIconStyle;
    }
    if (!iconStyle) {
        refreshResolvedRandomIconStyle(configuredIconStyle);
    }
    return iconStyle;
}

refreshResolvedRandomIconStyle();

function getActiveSeasonalEvent() {
    return getSeasonalEvent(getSeasonalEffectsDisabled());
}

let lastSeasonalEvent = getActiveSeasonalEvent();

function refreshSeasonalPresentation(): void {
    const nextEvent = getActiveSeasonalEvent();
    if (nextEvent === lastSeasonalEvent) return;
    lastSeasonalEvent = nextEvent;
    refreshIconPresentation();
}

export function getIconPath(forTray: boolean = false): string {
    const configuredIconStyle = getIconStyle();
    let style = getResolvedIconStyle(configuredIconStyle);
    const extension: 'ico' | 'png' = isWindows() ? 'ico' : 'png';
    const seasonalEvent = getActiveSeasonalEvent();
    if (forTray) {
        return getTrayBaseIconPath({
            assetsDir: getAssetsDir(),
            configuredIconStyle,
            resolvedRandomStyle: iconStyle,
            extension,
            seasonalEvent,
        });
    }
    style = style.replace(/\[.*\]/, ''); // Remove any [.*] suffix if present
    const seasonalStyle = resolveSeasonalIconStyle(style, seasonalEvent);
    if (useRareIcon && seasonalStyle === style) {
        return path.join(getAssetsDir(), isWindows() ? 'gsm_rare.ico' : 'gsm_rare.png');
    }
    const filename = `${seasonalStyle}.${extension}`;
    return path.join(getAssetsDir(), filename);
}

export function applyIconStyle(nextIconStyle?: string): void {
    if (typeof nextIconStyle === 'string') {
        setIconStyle(nextIconStyle || 'gsm');
    }

    refreshResolvedRandomIconStyle();
    refreshIconPresentation();
}

function applyMainWindowAppDetails(): void {
    if (!isWindows() || !mainWindow || mainWindow.isDestroyed()) return;
    // Windows taskbar groups/pinned entries also need shell metadata; setIcon
    // alone only changes the native window icon.
    mainWindow.setAppDetails(getWindowsAppDetails({
        profileDir: getProfileDir(),
        isPackaged: app.isPackaged,
        executable: process.execPath,
        appPath: app.getAppPath(),
        iconPath: getIconPath(),
    }));
}

function refreshIconPresentation(): void {
    const windowIconPath = getIconPath();

    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.setIcon(windowIconPath);
            applyMainWindowAppDetails();
        } catch (error) {
            console.warn('Failed to update main window icon:', error);
        }
    }

    if (process.platform === 'darwin') {
        try {
            app.dock?.setIcon(windowIconPath);
        } catch (error) {
            console.warn('Failed to update dock icon:', error);
        }
    }

    refreshTrayPresentation();
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
        seasonalEvent: getActiveSeasonalEvent(),
    });
}

function maybeActivateReadyTrayIndicator(): void {
    maybeNotifyAgentRestartReady();
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

function maybeNotifyAgentRestartReady(): void {
    if (!agentRestartId || agentRestartReadyNotified || !backendInitialized || !backendStatusReady || isQuitting) {
        return;
    }
    agentRestartReadyNotified = true;
    sendGSMReadyNotification('GSM has restarted. Your new changes are ready to try.');
}

async function pollBackendStatusOnce(): Promise<void> {
    if (backendStatusReady && backendInitialized) {
        clearBackendStatusPollTimer();
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    try {
        const response = await fetch(`http://localhost:${getConfiguredSinglePort()}/get_status`, {
            signal: controller.signal,
        });
        if (!response.ok) {
            return;
        }
        const status = await response.json() as {ready?:boolean};
        if (!backendStatusReady) {
            backendStatusReady = true;
            markStartup('backend HTTP available');
        }
        // Startup can finish before the authenticated bus connects. Recover
        // its dropped one-shot announcement from the backend's durable state.
        if (!backendInitialized && status.ready === true && bus.isConnected('backend')) {
            handleBackendMessage({function:'initialized',data:{status:'ready'}});
        }
        if (backendInitialized) clearBackendStatusPollTimer();
        maybeActivateReadyTrayIndicator();
        refreshTrayPresentation();
        syncProcessPausingTargetForCurrentScene(true);
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
    backendInitialized = false;
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
    markStartup('backend IPC connected');
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

// ---------------------------------------------------------------------------
// Backend message bus bridge
//
// The backend (gsm.py) is a bus client 'backend'. It sends structured messages
// on topic 'backend.event' ({function, data}) and receives commands on topic
// 'backend.command'. main.ts subscribes once (wireBackendBus) and dispatches the
// same handlers that previously lived on GSMStdoutManager's stdout 'message'.
// ---------------------------------------------------------------------------

interface BackendMessage {
    function?: string;
    data?: any;
}

let backendBusWired = false;

/** Send a command to the backend over the bus. Returns whether it's connected
 *  now (the broker buffers to a not-yet-connected backend regardless). */
function sendBackendCommand(fn: string, data?: Record<string, unknown>): boolean {
    bus.publish('backend', 'backend.command', data ? { function: fn, data } : { function: fn }, 'command');
    return bus.isConnected('backend');
}

let ocrHookRedundantDialogShown = false;

const devOcrBenchmark = new DevOcrBenchmark({
    isDev,
    bus,
    openFolder: async () => {
        const directory = path.join(BASE_DIR, 'ocr-benchmarks');
        await fs.promises.mkdir(directory, { recursive: true });
        const error = await shell.openPath(directory);
        if (error) throw new Error(error);
    },
    onStatus: (status) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('dev-ocr-benchmark');
        if (item) item.checked = status.enabled;
    },
    onError: (message) => dialog.showErrorBox('OCR benchmark', message),
});

const devVadDebug = new DevVadDebug({
    isDev,
    bus,
    openFolder: async () => {
        const directory = path.join(BASE_DIR, 'vad-debug');
        await fs.promises.mkdir(directory, { recursive: true });
        const error = await shell.openPath(directory);
        if (error) throw new Error(error);
    },
    onStatus: (status) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('dev-vad-debug');
        if (item) item.checked = status.enabled;
    },
    onError: (message) => dialog.showErrorBox('VAD debug', message),
});

/** Warn once that running auto OCR alongside a text hook is usually redundant,
 *  and offer to stop OCR. The backend only emits this after several OCR lines
 *  are dropped as echoes of hook lines. */
async function showOcrHookRedundantDialog(): Promise<void> {
    if (ocrHookRedundantDialogShown) {
        return;
    }
    ocrHookRedundantDialogShown = true;
    try {
        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        const options: Electron.MessageBoxOptions = {
            type: 'question',
            buttons: ['Stop OCR', 'Keep Both Running'],
            defaultId: 0,
            cancelId: 1,
            title: 'OCR and text hook both running',
            message: "GSM noticed you're using a text hook and also have Auto OCR running.",
            detail:
                'Running both is usually unnecessary — the hook already captures the text.\n\n' +
                'If you only kept OCR on for the overlay: the overlay is triggered by any text ' +
                'source, so it works from the hook alone without Auto OCR running.\n\n' +
                'If you want to keep OCR on for Area Select OCR or menu text capture, I recommend using "Manual OCR" instead.\n\n' +
                'Stop OCR?',
        };
        const result = parent
            ? await dialog.showMessageBox(parent, options)
            : await dialog.showMessageBox(options);
        if (result.response === 0) {
            stopOCR({ reason: 'text-hook-redundancy-confirmed' });
        }
    } catch (e) {
        console.error('Failed to show OCR/hook redundancy dialog:', e);
    }
}

function handleBackendMessage(msg: BackendMessage): void {
    if (msg.function === 'active_game_state') {
        activeGame.update(msg.data);
    }
    if (msg.function === 'foreground_window_hook_status') {
        const allowedStatuses = new Set<WindowSceneSwitcherHookStatus>([
            'unsupported',
            'starting',
            'running',
            'stopped',
            'failed',
        ]);
        const status = msg.data?.status as WindowSceneSwitcherHookStatus;
        if (allowedStatuses.has(status)) {
            setForegroundWindowHookStatus(status, String(msg.data?.error ?? ''));
        }
    }
    if (msg.function === 'notification' && msg.data) {
        try {
            sendNotificationFromPython(msg.data, () => { sendBackendCommand('open_session_review'); });
        } catch (e) {
            console.error('Failed to route notification from Python:', e);
        }
    }
    if (msg.function === 'ocr_hook_redundant') {
        void showOcrHookRedundantDialog();
    }
    if (isDev && msg.function === 'ocr_benchmark_error') {
        dialog.showErrorBox('OCR benchmark recording failed',
            `${String(msg.data?.error ?? 'Could not write the benchmark CSV.')}\n\nAutomatic OCR remains suppressed until you stop recording from the Development menu.`);
    }
    if (isDev && msg.function === 'vad_debug_error') {
        void devVadDebug.refresh().catch((error) => console.warn('Could not refresh VAD debug state:', error));
        dialog.showErrorBox('VAD debug recording stopped', String(msg.data?.error ?? 'Could not save VAD debug audio.'));
    }
    if (msg.function === 'text_intake_state') {
        setTextIntakePausedState(Boolean(msg.data?.paused));
    }
    if (msg.function === 'on_connect') {
        markPythonIPCConnected();
    }
    if (msg.function === 'start_obs') {
        // The backend asks us to launch OBS once its runtime is in place.
        // On a fresh install OBS doesn't exist yet when Electron first tries
        // to launch it at startup, so this is how the launch actually happens.
        void launchOBSFromElectron({ reason: 'backend start_obs request' }).catch((launchError) => {
            console.warn('Failed to launch OBS on backend request:', launchError);
        });
    }
    if (msg.function === 'initialized') {
        void devOcrBenchmark.refresh().catch((error) => console.warn('Could not refresh OCR benchmark state:', error));
        void devVadDebug.refresh().catch((error) => console.warn('Could not refresh VAD debug state:', error));
        markStartup('backend initialized');
        backendInitialized = true;
        markPythonIPCConnected();
        maybeNotifyAgentRestartReady();
        safeSendToMainWindow('gsm-initialized', msg.data ?? {});
        updateTrayMenu();
        refreshTrayPresentation();
        if (reopenSettingsAfterBackendRestart) {
            reopenSettingsAfterBackendRestart = false;
            setTimeout(() => {
                sendBackendCommand('open_settings');
            }, 200);
        }
    }
    if (msg.function === 'cleanup_complete') {
        console.log('Received cleanup_complete message from Python.');
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
}

/** Forward the backend child's stdout/stderr to the renderer terminal as logs. */
function attachBackendLogForwarding(proc: NativePythonProcess): void {
    let stdoutBuffer = '';
    proc.stdout.on('data', (data: Buffer) => {
        recordProcessOutput('backend', 'stdout', data.toString());
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
            sendTerminalLog({
                message: line + '\r\n',
                stream: 'stdout',
                source: 'python',
                level: parsePythonLogLevel(line) ?? undefined,
            });
        }
    });
    proc.stderr.on('data', (data: Buffer) => {
        recordProcessOutput('backend', 'stderr', data.toString());
        sendTerminalLog({
            message: data.toString() + '\r\n',
            stream: 'stderr',
            source: 'python',
        });
    });
}

/** Subscribe to backend bus events once (persists across backend restarts). */
function wireBackendBus(): void {
    if (backendBusWired) {
        return;
    }
    backendBusWired = true;
    bus.subscribe('backend.event', (m) => handleBackendMessage((m.data ?? {}) as BackendMessage));
}

function initializeAgentControl(): void {
    try {
        agentControl = startAgentControl({
            broker: getBroker(),
            connection: getBusConnectInfo()!,
            userDataPath: app.getPath('userData'),
            appPath: app.getAppPath(),
            isPackaged: app.isPackaged,
            restartId: agentRestartId,
            isReady: () => backendInitialized && backendStatusReady && bus.isConnected('backend')
                && isChildProcessActive(pyProc) && !isQuitting,
            getBlockedReason: () => {
                if (isQuitting) return 'GSM is shutting down.';
                if (restartingGSM) return 'The Python backend is already restarting.';
                if (isPythonLaunchBlockedByUpdate() || isObsRuntimeUpdateInProgress() || installSessionManager.getActiveSnapshot()?.status === 'running') {
                    return 'An update or installation is in progress.';
                }
                if (process.env.VITE_DEV_SERVER_URL) {
                    return 'Agent restarts require GSM launched with npm start; npm run dev manages its own restarts.';
                }
                return null;
            },
            notify: sendAgentRestartNotification,
            restart: (requestId) => quit(agentRelaunchArgs(process.argv.slice(process.env.GSM_NATIVE_SERVICE ? 2 : 1), requestId)),
        });
    } catch (error) {
        // Agent discovery must not prevent the normal runtime from starting.
        console.warn('Could not enable agent restart control:', error);
    }
}

/**
 * Runs a command and returns a promise that resolves when the command exits.
 * @param command The command to run.
 * @param args The arguments to pass.
 */
function runGSM(command: string, _args: string[], onSpawn?: () => void, preparation: Record<string, unknown> = {}, restart = false): Promise<void> {
    if (isQuitting) {
        onSpawn?.();
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const proc = new NativePythonProcess({ pythonPath: command, ...preparation, restart });

        pyProc = proc;
        resetStartupTrayState();
        setTextIntakePausedState(false);
        startBackendStatusPolling();

        // Backend stdout/stderr are pure logs now — control travels over the bus.
        attachBackendLogForwarding(proc);
        proc.on('spawn', () => {
            resetStartupTrayState();
            startBackendStatusPolling();
            markStartup('backend process spawned');
            onSpawn?.();
        });
        proc.on('crash', (event) => {
            if (event.beforeInitialization) return;
            console.error(event.restarting ? 'GSM crashed; the native supervisor is restarting it.' : 'GSM keeps crashing; automatic restarts stopped.', event.code);
            sendGSMCrashNotification(event.restarting);
            if (event.restarting) { resetStartupTrayState(); setTextIntakePausedState(false); }
        });

        proc.on('exit', async (code) => {
            // resetStartupTrayState clears this flag; preserve it before any
            // cleanup so slow initialization failures remain eligible for repair.
            const beforeInitialization = proc.beforeInitialization;
            // Rust emits exit only after the owned worker tree has been reaped.
            const intentionallyStopped = intentionalBackendStops.has(proc) || proc.killed;
            if (pyProc === proc) {
                resetStartupTrayState();
                setTextIntakePausedState(false);
            }
            const shouldQuitForPickaxeExit =
                code === 0 &&
                pyProc === proc &&
                backendExitRequestedFromPython &&
                !intentionallyStopped &&
                !restartingGSM &&
                !updateManager.anyUpdateInProgress;
            if (pyProc === proc) {
                backendExitRequestedFromPython = false;
            }
            if (intentionallyStopped) {
                resolve();
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
                reject(new BackendProcessError(proc.failureMessage || `Command failed with exit code ${formatBackendExitCode(code)}`, beforeInitialization));
            }
        });

        proc.on('error', (err) => {
            if (pyProc === proc) {
                resetStartupTrayState();
                setTextIntakePausedState(false);
            }
            reject(new BackendProcessError(err.message, true, { cause: err }));
        });
    });
}

export async function createWindow() {
    const adminSuffix = isRunningAsAdmin() ? ' (Admin)' : '';
    const windowTitle = `${APP_NAME} v${app.getVersion()}${adminSuffix}`;

    // Clamp the initial size to the work area so the window never opens taller
    // than the screen (e.g. Steam Deck at 1280x800), which would push the OCR
    // sticky footer / start buttons off-screen until the window is maximized.
    const { width: workWidth, height: workHeight } =
        screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: Math.min(1280, workWidth),
        height: Math.min(1000, workHeight),
        minWidth: 800,
        minHeight: 500,
        icon: getIconPath(),
        // Start hidden; show when ready for consistent taskbar icon
        show: false,
        webPreferences: getSecureWebPreferences({
            session: homeReaderSession(),
            additionalArguments: ['--gsm-home-reader'],
            nodeIntegrationInSubFrames: true,
            // Let hidden/minimized desktop pages report visibility correctly so
            // previews can stop capturing and Chromium can suspend idle paints.
            backgroundThrottling: true,
        }),
        title: windowTitle,
    });
    await preserveHomePreferences(mainWindow);
    if (process.env.GSM_NATIVE_SERVICE && process.platform === 'win32' && process.env.GSM_PORTABLE_DICTIONARIES !== '1') {
        await attachHomeDictionary(mainWindow.webContents);
    }
    applyMainWindowAppDetails();
    configureYouTubeEmbedHeaders(mainWindow);

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

    configureWindowSceneSwitcherRuntime({
        onSceneChanged: () => {
            autoLauncher.handleOBSSceneChanged();
            refreshGamePrivilegeCapture();
        },
    });

    if (!process.env.GSM_NATIVE_SERVICE) {
        startGamePrivilegeChecks({
            getMainWindow: () => mainWindow,
            getCapture: async () => isOBSConnected() ? getActiveCapture() : null,
            restartAsAdmin: async () => { await restartAsAdmin(); },
            notifyWarning: (warning, onClick) => sendGamePrivilegeWarningNotification(warning.exeName, onClick),
        });
    }

    registerMainIPC({
        getMainWindow: () => mainWindow,
        applyIconStyle,
        refreshSeasonalEffects: refreshSeasonalPresentation,
        getUpdateStatus: async () => await getUpdateStatus(),
        checkForUpdates: async () => await checkForAvailableUpdates(),
        updateNow: async () => await updateAvailableTargets(),
        getAppUpdateStatus: () => devUpdatePreview.apply(updateManager.getAppUpdateStatus()),
        getAppUpdateChangelog: async () => {
            const preview = devUpdatePreview.getChangelog();
            if (preview) return preview;
            const status = updateManager.getAppUpdateStatus();
            if (!status.updateAvailable || !status.latestVersion) {
                return null;
            }
            return await desktopChangelogManager.getUpdatePreview(
                { fromVersion: status.currentVersion, toVersion: status.latestVersion },
                { includePrereleases: status.channel === 'beta' }
            );
        },
        installAppUpdate: async (version) => {
            if (devUpdatePreview.getChangelog()) {
                throw new Error('Installation is disabled for the development update preview.');
            }
            if (isObsRuntimeUpdateInProgress()) await waitForObsRuntimeUpdate();
            return updateManager.installAppUpdate(version);
        },
        showUpdateChangelogPreview,
        getPendingDesktopUpdateChangelog: () => desktopChangelogManager.getPendingSnapshot(),
        markDesktopUpdateChangelogSeen: async (toVersion?: string) =>
            desktopChangelogManager.markSeen(toVersion),
        clearManualDesktopChangelog: () => desktopChangelogManager.clearManualDisplay(),
        applyChangelogSettingChoice,
    });
    registerDataRelocateIPC();

    // Reveal window only after renderer signals it's ready
    mainWindow.once('ready-to-show', () => {
        markStartup('desktop window ready');
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
                            await restartAsAdmin();
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
                    label: "What's Changed",
                    click: () => {
                        showManualDesktopChangelog();
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
                { label: 'Quit', accelerator: 'Command+Q', click: async () => await quit() },
            ],
        });
    }

    if (isDev) {
        template.push({
            label: 'Development',
            submenu: [
                {
                    label: 'Show Update Available (Latest Online Changelog)',
                    click: () => { void showDevUpdatePreview(); },
                },
                {
                    label: 'Clear Update Preview',
                    click: () => devUpdatePreview.clear(),
                },
                { type: 'separator' },
                ...devOcrBenchmark.menuItems(),
                { type: 'separator' },
                ...devVadDebug.menuItems(),
                { type: 'separator' },
                { label: 'Reload UI', role: 'reload' },
                { label: 'Toggle Developer Tools', role: 'toggleDevTools' },
            ],
        });
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
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
            if (getQuitOnWindowClose()) {
                event.preventDefault();
                if (!quitFromWindowCloseInProgress) {
                    quitFromWindowCloseInProgress = true;
                    void quit().finally(() => {
                        quitFromWindowCloseInProgress = false;
                    });
                }
                return;
            }

            event.preventDefault();
            mainWindow?.hide();
            if (!hasShownCloseToTrayNotification) {
                hasShownCloseToTrayNotification = true;
                sendGSMStillRunningInTrayNotification();
            }
            //             createTray();
            return;
        }
        mainWindow = null;
    });
}

async function showDevUpdatePreview(): Promise<void> {
    if (!isDev || updateManager.anyUpdateInProgress) return;
    try {
        await devUpdatePreview.show(() => desktopChangelogManager.getLatestOnlinePreview(
            app.getVersion(),
            { includePrereleases: getPullPreReleases() }
        ));
        showWindow();
    } catch (error) {
        console.error('Failed to load development update preview:', error);
        dialog.showErrorBox('Update Preview', `Could not load the latest online changelog.\n\n${error instanceof Error ? error.message : String(error)}`);
    }
}

function showManualDesktopChangelog(): void {
    const currentVersion = app.getVersion();
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        if (!mainWindow.isVisible()) {
            mainWindow.show();
        }
        mainWindow.focus();
    }

    desktopChangelogManager.startManualDisplay({
        fromVersion: currentVersion,
        toVersion: currentVersion,
    });
}

export function createTray() {
    configureInProcessOverlayHost({
        requestStop: () => {
            void setOverlayEnabled(false).catch(error => console.error('Could not turn off overlay:', error));
        },
    });
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

function destroyTray(): void {
    if (!tray) {
        return;
    }

    try {
        tray.destroy();
    } catch (error) {
        console.warn('Failed to destroy tray during shutdown:', error);
    } finally {
        tray = null;
    }
}

function hideUserFacingShutdownSurfaces(): void {
    isQuitting = true;
    clearTrayReadyIndicatorTimer();
    clearBackendStatusPollTimer();
    trayReadyIndicatorExpiresAt = 0;

    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.hide();
        } catch (error) {
            console.warn('Failed to hide main window during shutdown:', error);
        }
    }

    destroyTray();
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

function sendTrayCommand(description: string, fn: string, data?: Record<string, unknown>): boolean {
    if (!bus.isConnected('backend')) {
        console.warn(`Cannot ${description}: backend is not ready.`);
        return false;
    }
    sendBackendCommand(fn, data);
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
                sendTrayCommand(`switch profile to ${profileName}`, 'switch_profile', {
                    profile_name: profileName,
                })
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
                sendTrayCommand('open Anki confirmation test window', 'test_anki_confirmation');
            },
        },
        {
            label: 'Screenshot Selector',
            click: () => {
                sendTrayCommand('open screenshot selector test window', 'test_screenshot_selector');
            },
        },
        {
            label: 'Furigana Filter Preview',
            click: () => {
                sendTrayCommand('open furigana filter test window', 'test_furigana_filter');
            },
        },
        {
            label: 'Area Selector',
            click: () => {
                sendTrayCommand('open area selector test window', 'test_area_selector');
            },
        },
        {
            label: 'Screen Cropper',
            click: () => {
                sendTrayCommand('open screen cropper test window', 'test_screen_cropper');
            },
        },
    ];
}

function buildTrayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Open Settings',
            click: () => {
                if (!sendTrayCommand('open settings', 'open_settings')) {
                    showWindow();
                }
            },
        },
        {
            label: 'Open Text Feed',
            click: () => {
                sendTrayCommand('open texthooker', 'open_texthooker');
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
                await restartAsAdmin();
            },
        });
    }

    if (isDev) {
        template.push({
            label: 'Restart App',
            click: async () => {
                await closeAllPythonProcesses();
                app.relaunch();
                await quit();
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
    restart?: boolean;
    knownInstalledVersion?: string | null;
    origin?: InstallSessionOrigin;
    trackInstallSession?: boolean;
    /** Signals launch without waiting for the backend's entire lifetime. */
    onSpawn?: () => void;
}

async function ensureAndRunGSM(
    pythonPath: string,
    retry = 1,
    options?: EnsureAndRunOptions
): Promise<void> {
    if (isQuitting) {
        options?.onSpawn?.();
        return;
    }
    const origin = options?.origin ?? 'startup';
    const trackInstallSession =
        options?.trackInstallSession ??
        (origin !== 'startup' || installSessionManager.getActiveSnapshot()?.origin === 'startup');

    if (trackInstallSession) {
        ensureInstallSession(origin, async () => {
            await ensureAndRunGSM(pythonPath, 1, {
                ...options,
                allowDuringUpdate: true,
                origin,
                trackInstallSession: true,
            });
        });
        updateInstallStage('prepare', 'running', 'estimated', 0.2, 'Preparing install session...');
    }

    if (!options?.allowDuringUpdate) {
        await waitForPythonLaunchReadiness('GSM backend startup');
    }

    updateInstallStage('prepare', 'completed', 'estimated', 1, 'Install session prepared.');
    devFaultInjector.maybeFail('startup.ensure_and_run_enter');

    // Rust carries preparation, launch and bounded initialization recovery through
    // to completion. This promise only tracks that lifetime for the existing UI.
    devFaultInjector.maybeFail('startup.run_gsm');
    return runGSM(pythonPath, [], options?.onSpawn, {
        extras: getPythonExtras(),
        knownInstalledVersion: options?.knownInstalledVersion,
        isPreRelease: resolvePreReleaseBranch() !== null,
        repairOnFailure: retry > 0,
    }, options?.restart ?? false);
}

async function handleBackendStartupFailure(error: unknown): Promise<void> {
    // Native recovery already recorded the result against its own session
    // attempt. A delayed UI callback must not finish a newer installation.
    console.error('GSM backend process failed:', error);
}

async function processArgsAndStartSettings() {
    const args = process.argv.slice(1);
    let gameName: string | undefined;
    let runOCR = false;

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

    if (getRunOverlayOnStartup()) {
        void runOverlayWithSource('startup').catch((error) => console.warn('Failed to start overlay:', error));
    }

    if (gameName) {
        await launchSteamGameID(gameName);
    }
    if (runOCR) {
        await startOCR();
    }
}

async function startDesktopDependencies(): Promise<void> {
    // Neither service depends on the other. Children must still wait for both
    // so they inherit the bound input endpoint and the authenticated bus.
    await Promise.all([
        ...(process.env.GSM_NATIVE_SERVICE
            ? []
            : [startInputServer().then((ready) => markStartup(ready ? 'input service ready' : 'input service unavailable'))]),
        startBus().then(() => {
            markStartup('message bus ready');
            wireBackendBus();
            setLaunchBlockedCheck(() => isQuitting || isPythonLaunchBlockedByUpdate());
            initializeAgentControl();
        }).catch((error) => console.error('Failed to start message bus broker:', error)),
    ]);
}

app.setName(APP_NAME);
app.setPath('userData', path.join(BASE_DIR, 'electron'));
// Expose the resolved data dir to every spawned child (overlay binary, python) via inherited env.
process.env.GSM_DATA_DIR = BASE_DIR;
// Keep the legacy registry mirror current for Windows integrations and diagnostics.
writeDataDirRegistry(BASE_DIR);
if (isWindows()) {
    app.setAppUserModelId(getWindowsAppId(app.isPackaged));
}

// macOS uses a separate dock icon.
if (process.platform === 'darwin') {
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
    // Install before asynchronous startup/update work so early quits also wait.
    registerShutdownHandlers();
    app.whenReady().then(async () => {
        if (isQuitting) {
            return;
        }
        try {
            markStartup('Electron ready');
            // Migrate before Python loads/saves its config without the retired switches.
            getNotificationPreferences();
            configureNotificationDelivery({
                getPreferences: getNotificationPreferences,
                playSound: playNotificationSound,
            });
            // Recheck the local date across midnight, timezone changes, and sleep.
            setInterval(refreshSeasonalPresentation, 60_000).unref();
            app.on('browser-window-focus', refreshSeasonalPresentation);
            bootstrapPreReleaseSettingsFromMetadata();
            registerChangelogProtocolHandler(getAssetsDir());
            let trackStartupInstallSession = shouldTrackStartupInstallSession();
            if (trackStartupInstallSession) {
                startStartupInstallSession();
            }
            // Start the install session first so OBS download progress (if a
            // download is needed) renders in the install-progress UI. Rust owns
            // OBS installation and launch; this only requests application startup.
            void ensureObsInstalledAndLaunch({ reason: 'startup' }).then(() => {
                markStartup('OBS launch checked');
            }).catch((error) => {
                console.warn('Native OBS startup ensure/launch failed:', error);
            });
            await startDesktopDependencies();
            if (isQuitting) return;
            createWindow().then(async () => {
                createTray();
                if (!process.env.GSM_NATIVE_SERVICE) autoLauncher.startPolling();
                if (!isQuitting && !process.env.GSM_NATIVE_SERVICE) startGameBackgroundHooks();
                // setTimeout(async () => {
                //     await checkAndRunWizard(true);
                // }, 1000);
                const { checkForTexthookUpdates } = await import('./ui/texthook.js');
                void checkForTexthookUpdates();
            });

            const pyPath = await getOrInstallPython();
            markStartup('Python runtime ready');
            pythonPath = pyPath;
            setPythonPath(pythonPath);
            if (!trackStartupInstallSession) {
                trackStartupInstallSession = await resolveStartupInstallSessionAfterPythonReady(
                    pythonPath
                );
            }

            if (wantsChaosHarnessRun()) {
                if (!isDev) {
                    console.warn(
                        '[Chaos] --dev-chaos-update is only enabled in development builds.'
                    );
                } else {
                    console.log('[Chaos] Starting dev update chaos harness...');
                    const summary = await runUpdateChaosHarness({
                        updateGSM: async (shouldRestart = false, force = false) => {
                            await updateManager.updateGSM(shouldRestart, force);
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
            const updateFlagExists = fs.existsSync(updateFlagPath);
            if (appVersionChanged) {
                log.info(
                    `Detected Electron app version change (${storedVersion} -> ${currentVersion}). Forcing Python update before launch.`
                );
            }
            const changelogTarget = getDesktopUpdateChangelogTarget({
                storedVersion,
                currentVersion,
                updateFlagExists,
                existingPending: desktopChangelogManager.getPendingRecord(),
                isSeen: (version) => hasSeenDesktopChangelog(version),
            });
            if (changelogTarget) {
                desktopChangelogManager.startDesktopUpdate(changelogTarget);
            }

            const backendSyncSucceeded = await syncStartupBackend({
                appVersionChanged,
                updateFlagPath,
                autoUpdateEnabled: getAutoUpdateGSMApp(),
                hasPendingDesktopUpdate: changelogTarget !== null,
                forceUpdate: isDev && FeatureFlags.ALWAYS_UPDATE_IN_DEV,
            }, updateManager);
            markStartup('backend update check complete');
            if (backendSyncSucceeded && storedVersion !== currentVersion) {
                setElectronAppVersion(currentVersion);
            }

            // Launch backend before UI/module initialization, then continue startup.
            void ensureAndRunGSM(pythonPath, 1, {
                knownInstalledVersion: updateManager.checkedBackendVersion,
                origin: 'startup',
                trackInstallSession: trackStartupInstallSession,
            }).catch(handleBackendStartupFailure);
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
                await updateManager.checkAppUpdateStatus();
            }
        }

    });
}

function registerShutdownHandlers(): void {
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin' && !isQuitting) {
            void quit();
        }
    });
    app.on('before-quit', (event) => {
        if (!quitCleanupComplete) {
            event.preventDefault();
            void quit();
        }
    });
    app.on('will-quit', () => autoLauncher.stopPolling());
    if (process.platform !== 'win32') {
        process.once('SIGTERM', () => { void quit(); });
        process.once('SIGINT', () => { void quit(); });
    }
}

export async function runPipInstall(packageName: string): Promise<void> {
    await closeAllPythonProcesses();
    const pythonPath=await getOrInstallPython();
    await pythonCall('packageInstall',{pythonPath,requirement:packageName});
    await restartGSM();
}

async function closeAllPythonProcesses(closeGSMFlag: boolean = true): Promise<void> {
    const stops: Array<() => unknown> = [
        async () => {
            stopOverlay();
            await waitForOverlayShutdown();
        },
        async () => {
            stopOCR({ reason: 'python-process-group-shutdown' });
            await waitForOCRShutdown();
            // stopOCR reports whether a request was made; it is not an exit promise.
            await stopManagedProcesses();
        },
        async () => {
            const { shutdownTextHook } = await import('./ui/texthook.js');
            await shutdownTextHook();
        },
    ];
    if (closeGSMFlag) {
        stops.push(() => closeGSM());
    }
    const results = await Promise.allSettled(stops.map((stop) => Promise.resolve().then(stop)));
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to stop backend-related processes.');
    }
}

function hasChildProcessExited(proc: NativePythonProcess): boolean {
    return proc.exitCode !== null || proc.signalCode !== null;
}

function isChildProcessActive(
    proc: NativePythonProcess | undefined
): proc is NativePythonProcess {
    return Boolean(proc && !hasChildProcessExited(proc));
}

/** Release capture clients before OBS unloads its WebSocket server. */
export async function suspendObsClientsForUpdate(): Promise<() => Promise<void>> {
    const backendWasRunning = isChildProcessActive(pyProc);
    const ocr = getOCRRuntimeState();
    const resume = async () => {
        if (isQuitting) return;
        if (backendWasRunning) {
            await new Promise<void>((resolve, reject) => {
                void ensureAndRunGSM(pythonPath, 1, { onSpawn: resolve }).catch(reject);
            });
        }
        if (ocr.isRunning) {
            const options = { source: ocr.source ?? 'user' as const, restartReason: 'OBS updated' };
            if (ocr.mode === 'manual') startManualOCR(options);
            else await startOCR({ ...options, promptForAreaSelection: false });
        }
    };
    try {
        if (ocr.isRunning) {
            stopOCR({ reason: 'managed-obs-update' });
            await waitForOCRShutdown();
            await getProcessManager().stop('ocr');
        }
        if (backendWasRunning) await closeGSM();
        return resume;
    } catch (error) {
        await resume();
        throw error;
    }
}

async function closeGSM(): Promise<void> {
    if (gsmStopPromise) {
        return gsmStopPromise;
    }
    const procToClose = pyProc;
    if (!isChildProcessActive(procToClose)) {
        return;
    }
    gsmStopPromise = stopGSMProcess(procToClose).finally(() => {
        gsmStopPromise = null;
    });
    return gsmStopPromise;
}

async function stopGSMProcess(procToClose: NativePythonProcess): Promise<void> {
    intentionalBackendStops.add(procToClose);
    await procToClose.stop();
}

async function restartGSM(): Promise<void> {
    if (restartingGSM || isQuitting) {
        console.log('GSM restart already in progress. Ignoring duplicate request.');
        return;
    }
    restartingGSM = true;
    try {
        await new Promise<void>((resolve, reject) => {
            // ensureAndRunGSM follows the child until exit; release the restart
            // guard once it spawns so subsequent restart requests can proceed.
            void ensureAndRunGSM(pythonPath, 1, { onSpawn: resolve, restart: true }).catch((error) => {
                console.error('Failed to run GSM after restart:', error);
                reject(error);
            });
        });
        console.log('GSM backend relaunched.');
    } catch (error) {
        console.error('Failed to restart GSM:', error);
    } finally {
        restartingGSM = false;
    }
}

export { closeGSM, restartGSM, closeAllPythonProcesses, ensureAndRunGSM };
export { checkAndInstallUV, isPackageInstalled };

async function runQuit(relaunchArgs?: string[]): Promise<void> {
    await waitForObsRuntimeUpdate();
    hideUserFacingShutdownSurfaces();
    stopGamePrivilegeChecks();
    autoLauncher.stopPolling();
    shutdownWindowSceneSwitcher();

    try {
        const results = await Promise.allSettled([
            stopGameBackgroundHooks(),
            stopInputServer(),
            closeAllPythonProcesses().then(async () => {
                // The backend automatically starts replay buffering for an active
                // game. Stop that manager before asking OBS to stop its outputs.
                const result = await closeOBSFromElectron({ reason: 'app quit' });
                if (result.status === 'failed') {
                    throw new Error(result.error ?? 'OBS could not close safely.');
                }
            }),
        ]);
        const cleanupErrors: unknown[] = [];
        for (const result of results) {
            if (result.status === 'rejected') {
                console.error('Error during app shutdown cleanup:', result.reason);
                cleanupErrors.push(result.reason);
            }
        }
        await stopBus().catch((err) => {
            console.warn('Failed to stop message bus:', err);
            cleanupErrors.push(err);
        });
        if (relaunchArgs) {
            if (cleanupErrors.length > 0) {
                throw new Error('GSM could not stop all background processes; restart cancelled. Check the GSM logs before starting again.');
            }
            // Schedule the replacement only after every owned child has exited.
            app.relaunch({ args: relaunchArgs });
        }
    } catch (error) {
        console.error('Error during app shutdown cleanup:', error);
        if (relaunchArgs) agentControl?.fail(error);
    } finally {
        agentControl?.dispose();
        quitCleanupComplete = true;
        app.quit();
    }
}

export async function quit(relaunchArgs?: string[]): Promise<void> {
    if (!quitPromise) {
        quitPromise = runQuit(relaunchArgs);
    }
    return quitPromise;
}

// Stop everything that holds handles in the data dir, without quitting the app (used before a
// data-folder relocation). Mirrors quit() minus app.quit().
async function stopAllChildrenForRelocation(): Promise<void> {
    await waitForObsRuntimeUpdate();
    await stopGameBackgroundHooks();
    autoLauncher.stopPolling();
    shutdownWindowSceneSwitcher();
    stopOverlay();
    await waitForOverlayShutdown();
    await closeAllPythonProcesses();
    await stopInputServer();
    const obsResult = await closeOBSFromElectron({ reason: 'data relocation' });
    if (obsResult.status === 'failed') {
        throw new Error(obsResult.error ?? 'OBS could not close safely; data relocation was cancelled.');
    }
    await stopBus().catch((err) => console.warn('Failed to stop message bus during relocation:', err));
}

let dataRelocateRegistered = false;

function registerDataRelocateIPC(): void {
    if (dataRelocateRegistered) {
        return;
    }
    dataRelocateRegistered = true;

    ipcMain.handle('data.getCurrentDir', () => BASE_DIR);
    ipcMain.handle('data.getDefaultDir', () => getDefaultBaseDir());
    ipcMain.handle('data.getPointerPath', () => getPointerFilePath());

    ipcMain.handle('data.relocate', async () => {
        if (getProfileDir()) {
            return { success: false, error: 'This launch uses -profile. Close GSM and launch with a different profile folder to change it.' };
        }
        const win = mainWindow ?? undefined;

        const picked = await dialog.showOpenDialog(win as BrowserWindow, {
            title: 'Choose a new GSM data folder',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (picked.canceled || picked.filePaths.length === 0) {
            return { success: false, canceled: true };
        }
        const newDir = picked.filePaths[0];

        const validation = await validateTargetDir(BASE_DIR, newDir);
        if (!validation.ok) {
            return { success: false, error: validation.error };
        }

        const confirm = await dialog.showMessageBox(win as BrowserWindow, {
            type: 'warning',
            buttons: ['Copy and Restart', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            title: 'Change GSM Data Folder',
            message: `Copy GSM configs and database to:\n${newDir}`,
            detail: 'GSM will copy its desktop and overlay settings, then stop and restart. Chromium session/storage and Yomitan data will not be copied, so export/import Yomitan dictionaries yourself. Source files will not be deleted; remove them manually after verifying the new folder.',
        });
        if (confirm.response !== 0) {
            return { success: false, canceled: true };
        }

        const sendProgress = (p: RelocateProgress) => {
            mainWindow?.webContents.send('data.relocate.progress', p);
        };

        try {
            sendProgress({ phase: 'validating', message: 'Stopping GSM…' });
            await stopAllChildrenForRelocation();
            await performDataMove(BASE_DIR, newDir, sendProgress);
        } catch (err: any) {
            return { success: false, error: err?.message ?? String(err) };
        }

        // New location is committed; relaunch so every path resolves to it and the venv rebuilds.
        app.relaunch();
        await quit();
        return { success: true };
    });

    ipcMain.handle('data.restoreDefault', async () => {
        if (getProfileDir()) {
            return { success: false, error: 'This launch uses -profile. Close GSM and launch without -profile to use your normal data folder.' };
        }
        const defaultDir = getDefaultBaseDir();
        if (path.resolve(BASE_DIR) === path.resolve(defaultDir)) {
            return { success: true };
        }

        const win = mainWindow ?? undefined;
        const confirm = await dialog.showMessageBox(win as BrowserWindow, {
            type: 'warning',
            buttons: ['Use Original Folder and Restart', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            title: 'Use Original GSM Data Folder',
            message: `Return to the original GSM data folder:\n${defaultDir}`,
            detail: `GSM will use the data already stored in this folder. Changes from the current custom folder will not be copied. The custom folder will remain untouched:\n${BASE_DIR}`,
        });
        if (confirm.response !== 0) {
            return { success: false, canceled: true };
        }

        const sendProgress = (p: RelocateProgress) => {
            mainWindow?.webContents.send('data.relocate.progress', p);
        };

        try {
            sendProgress({ phase: 'validating', message: 'Stopping GSM…' });
            await stopAllChildrenForRelocation();
            sendProgress({
                phase: 'finalizing',
                message: 'Restoring the original GSM data folder…',
            });
            writeDataDirPointer(defaultDir);
            writeDataDirRegistry(defaultDir);
            sendProgress({
                phase: 'done',
                message: 'Original GSM data folder restored. Restarting…',
            });
        } catch (err: any) {
            return { success: false, error: err?.message ?? String(err) };
        }

        app.relaunch();
        await quit();
        return { success: true };
    });
}

async function restart(): Promise<void> {
    await closeGSM();
    app.relaunch();
    app.quit();
}

// Helper command wrappers — all routed to the backend over the message bus.
export function sendStartOBS() { sendBackendCommand('start_obs'); }
export function sendQuitOBS() { sendBackendCommand('quit_obs'); }
export function sendOpenSettings(data?: Record<string, unknown>) {
    sendBackendCommand('open_settings', data);
}
export function sendReloadSettings() {
    sendBackendCommand('reload_settings');
}
const CHANGELOG_SETTING_CHOICES = new Set([
    'review-after-session:enable',
    'overlay-presence-invalidation:enable',
    'overlay-presence-invalidation:disable',
]);

export function applyChangelogSettingChoice(choice: string): boolean {
    if (!CHANGELOG_SETTING_CHOICES.has(choice)) {
        return false;
    }
    return sendBackendCommand('apply_changelog_setting_choice', { choice });
}
export function sendOpenOverlaySettings() {
    return sendBackendCommand('open_overlay_settings');
}
export function sendStopOverlay(launchId: string): boolean {
    return sendBackendCommand('stop_overlay', { launchId });
}
export function sendOpenTexthooker() { sendBackendCommand('open_texthooker'); }
export function sendRelateSceneToProfile(scene: string, profileName: string, createNew = false) {
    return sendBackendCommand('relate_scene_to_profile', {
        scene,
        profile_name: profileName,
        create_new: createNew,
    });
}

export interface TextHookLinePayload {
    text: string;
    sessionId?: string;
    hookId?: string;
    hookFunction?: string;
    engine?: 'textractor' | 'luna' | 'agent' | 'mages';
    exeName?: string;
    copyToClipboard?: boolean;
    capturedAt?: number;
    sourceSequence?: number;
    revisionWindowMs?: number;
    mergeFragments?: boolean;
    textGeometry?: TextGeometryV1;
}

export interface ProcessedTextHookLine {
    text: string;
    originalText: string;
    hookId?: string;
    sessionId?: string;
    ts: number;
}

export function sendTextHookLine(payload: TextHookLinePayload, onProcessed?: (line: ProcessedTextHookLine) => void): void {
    const displayParts = [payload.engine, payload.exeName, payload.hookId ? `#${payload.hookId}` : ''].filter(Boolean);
    const precomputedOverlayPayload = payload.textGeometry
        ? textGeometryToOverlayPayload(payload.text, payload.textGeometry)
        : null;
    const capturedAt = payload.capturedAt ?? Date.now();
    submitTextObservation({
        ...payload,
        ...(precomputedOverlayPayload ? { dict_from_ocr: precomputedOverlayPayload } : {}),
        source: 'texthook',
        sourceInstance: payload.hookId || `${payload.engine ?? 'hook'}:${payload.exeName ?? ''}`,
        sourceDisplayName: displayParts.join(' · '),
        capturedAt,
        revisionWindowMs: 0,
        mergeFragments: false,
    }, (ack) => {
        if (typeof ack.processed_text !== 'string' || typeof ack.raw_text !== 'string') return;
        onProcessed?.({
            text: ack.processed_text,
            originalText: ack.raw_text,
            hookId: payload.hookId,
            sessionId: payload.sessionId,
            ts: capturedAt,
        });
    });
}

// Tell the backend when text hooking starts/stops so it can pause clipboard
// polling while active (mirrors a connected websocket source).
export function sendTextHookStatus(active: boolean): void {
    sendBackendCommand('texthook_status', { active });
}

// Same as above for the OCR process. Driven from the OCR lifecycle so a crash
// (not just a graceful stop) still resumes clipboard polling.
export function sendOcrStatus(active: boolean): void {
    sendBackendCommand('ocr_status', { active });
}

export async function handleNativeTrayAction(action: string): Promise<void> {
    switch (action) {
        case 'update-gsm':
            await runUpdateChecks(true, true);
            break;
        case 'restart-python':
            await restartGSM();
            break;
        case 'restart-as-admin':
            await restartAsAdmin();
            break;
        case 'restart-app':
            await closeAllPythonProcesses();
            app.relaunch();
            await quit();
            break;
        case 'quit':
            await quit();
            break;
    }
}

export async function handleNativeLifecycleAction(action: string): Promise<void> {
    switch (action) {
        case 'stop-for-relocation':
            await stopAllChildrenForRelocation();
            break;
        case 'stop-python':
            await closeAllPythonProcesses();
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (pyProc && pyProc.exitCode === null && pyProc.signalCode === null) {
                throw new Error(
                    'Timed out waiting for the GSM Python backend to stop. Restore was not applied so the database would not be copied while locked.'
                );
            }
            break;
        case 'restart-python':
            await restartGSM();
            break;
        default:
            throw new Error(`Unknown lifecycle operation: ${action}`);
    }
}
