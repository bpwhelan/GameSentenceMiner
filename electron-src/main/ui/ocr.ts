import { exec, spawn } from 'child_process';
import { dialog, ipcMain, BrowserWindow, screen, IpcMainEvent, clipboard, shell } from 'electron';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp,
    getOCRConfig,
    getPythonPath,
    getStartConsoleMinimized,
    setAreaSelectOcrHotkey,
    setManualOcrHotkey,
    setOCR1,
    setOCR2,
    setOCRConfig,
    setOCRLanguage,
    setOCRScanRate,
    setSendToClipboard,
    setShouldOCRScreenshots,
    setTwoPassOCR,
    setOptimizeSecondScan,
    setKeepNewline,
    setAdvancedMode,
} from '../store.js';
import { getSanitizedPythonEnv, getWindowsNamedPythonExecutable } from '../util.js';
import {
    closeAllPythonProcesses,
    isPythonLaunchBlockedByUpdate,
    isQuitting,
    mainWindow,
    restartGSM,
    sendOcrStatus,
} from '../main.js';
import { getCurrentScene, ObsScene } from './obs.js';
import { bus } from '../runtime/bus_client.js';
import { getProcessManager } from '../runtime/process_supervisor.js';
import {
    BASE_DIR,
    getAssetsDir,
    getPlatform,
    getSecureWebPreferences,
    isWindows,
    runPythonScript,
    sanitizeFilename,
} from '../util.js';
import path, { resolve } from 'path';
import * as fs from 'node:fs';
import * as os from 'os';

// OCR is now a bus-managed process: the ProcessManager owns its lifecycle and
// the message bus carries events (ocr.event) and commands (ocr.command). See
// runtime/process_supervisor.ts and util/communication/ocr_ipc.py.
const OCR_CLIENT_ID = 'ocr';
let pendingOcrLaunch: { command: string; args: string[]; windowsHide: boolean } | null = null;
let ocrSupervisorWired = false;
let ocrStopRequested = false;
export type OCRStartSource = 'user' | 'auto-launcher';
type OCRRunMode = 'auto' | 'manual';
type OCRProcessPriority = 'low' | 'below_normal' | 'normal' | 'above_normal' | 'high';
type OCRConfigChanges = Record<string, [unknown, unknown]>;
let activeOcrSource: OCRStartSource | null = null;
let activeOcrRunMode: OCRRunMode | null = null;
const OCR_GRACEFUL_STOP_TIMEOUT_MS = 2000;
const OCR_PROCESS_PRIORITIES: OCRProcessPriority[] = ['low', 'below_normal', 'normal', 'above_normal', 'high'];

function diffOcrConfigValues(previousConfig: Record<string, any>, nextConfig: Record<string, any>): OCRConfigChanges {
    const changes: OCRConfigChanges = {};
    const keys = new Set([...Object.keys(previousConfig || {}), ...Object.keys(nextConfig || {})]);

    for (const key of keys) {
        if (previousConfig?.[key] !== nextConfig?.[key]) {
            changes[key] = [previousConfig?.[key], nextConfig?.[key]];
        }
    }

    return changes;
}

function blockOcrStartDuringUpdate(action: string): boolean {
    if (!isPythonLaunchBlockedByUpdate()) {
        return false;
    }
    const message = `[Update Guard] Skipping ${action} while updates are in progress.`;
    console.warn(message);
    sendToMainWindowFrames('ocr-log', message);
    return true;
}

function setActiveOcrSession(source: OCRStartSource, mode: OCRRunMode) {
    activeOcrSource = source;
    activeOcrRunMode = mode;
}

function clearActiveOcrSession() {
    activeOcrSource = null;
    activeOcrRunMode = null;
}

function normalizeOcrProcessPriority(value: unknown): OCRProcessPriority {
    if (typeof value !== 'string') {
        return 'normal';
    }

    const normalized = value.toLowerCase() as OCRProcessPriority;
    if (!OCR_PROCESS_PRIORITIES.includes(normalized)) {
        return 'normal';
    }

    return normalized;
}

function getWindowsPriorityValue(priority: OCRProcessPriority): number {
    switch (priority) {
        case 'low':
            return os.constants.priority.PRIORITY_LOW;
        case 'below_normal':
            return os.constants.priority.PRIORITY_BELOW_NORMAL;
        case 'above_normal':
            return os.constants.priority.PRIORITY_ABOVE_NORMAL;
        case 'high':
            return os.constants.priority.PRIORITY_HIGH;
        case 'normal':
        default:
            return os.constants.priority.PRIORITY_NORMAL;
    }
}

function applyWindowsOcrProcessPriority(pid: number | undefined) {
    if (!isWindows() || typeof pid !== 'number' || pid <= 0) {
        return;
    }

    const configuredPriority = normalizeOcrProcessPriority(getOCRConfig().processPriority);
    const priorityValue = getWindowsPriorityValue(configuredPriority);

    try {
        os.setPriority(pid, priorityValue);
        console.log(`[OCR] Applied Windows process priority "${configuredPriority}" to PID=${pid}`);
    } catch (error) {
        console.warn(
            `[OCR] Failed to apply process priority "${configuredPriority}" to PID=${pid}:`,
            error
        );
    }
}

export function getOCRRuntimeState() {
    return {
        isRunning: getProcessManager().isRunning(OCR_CLIENT_ID),
        source: activeOcrSource,
        mode: activeOcrRunMode,
    };
}

function sendToMainWindowFrames(channel: string, ...args: any[]) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    try {
        const frames = mainWindow.webContents.mainFrame.framesInSubtree;
        for (const frame of frames) {
            if (!frame.detached) {
                frame.send(channel, ...args);
            }
        }
    } catch (error) {
        console.error(`Failed to broadcast "${channel}" to renderer frames:`, error);
    }
}

function appendHotkeyArgs(command: string[], ocr_config: ReturnType<typeof getOCRConfig>) {
    // Always pass explicit values so empty strings can disable hotkeys.
    command.push('--area_select_ocr_hotkey', `${ocr_config.areaSelectOcrHotkey ?? ''}`);
    command.push('--manual_ocr_hotkey', `${ocr_config.manualOcrHotkey ?? ''}`);
    command.push('--whole_window_ocr_hotkey', `${ocr_config.wholeWindowOcrHotkey ?? ''}`);
    command.push('--global_pause_hotkey', `${ocr_config.globalPauseHotkey ?? ''}`);
}

function shouldEnableLegacyKeepNewlineFlag(ocr_config: ReturnType<typeof getOCRConfig>): boolean {
    const sourceSpecificValues = [
        ocr_config.keep_newline_auto,
        ocr_config.keep_newline_menu,
        ocr_config.keep_newline_area_select,
    ].filter((value): value is boolean => typeof value === 'boolean');

    if (sourceSpecificValues.length > 0) {
        return sourceSpecificValues.some(Boolean);
    }

    if (!ocr_config.advancedMode) {
        return true;
    }

    return Boolean(ocr_config.keep_newline);
}

function requestOcrConfigReload(reason: string, options?: { reloadArea?: boolean; reloadElectron?: boolean; changes?: Record<string, any> }) {
    if (!getProcessManager().isRunning(OCR_CLIENT_ID)) {
        console.warn(`[OCR] Skipping reload config (${reason}) - no active OCR process`);
        return;
    }

    const payload: Record<string, any> = {
        reason,
        reload_area: options?.reloadArea ?? true,
        reload_electron: options?.reloadElectron ?? true,
    };

    if (options?.changes && Object.keys(options.changes).length > 0) {
        payload.changes = options.changes;
    }

    sendOcrCommand('reload_config', payload);
    console.log(`[OCR] Sent reload config (${reason})`);
}

function getOcrConfigRestartReason(changes: OCRConfigChanges): string | null {
    if ('globalPauseHotkey' in changes) {
        return 'the global pause hotkey change';
    }

    if ('ocr_screenshots' in changes) {
        return 'clipboard screenshot input changes';
    }

    if (activeOcrRunMode === 'manual' && 'manualOcrHotkey' in changes) {
        return 'the manual capture hotkey change';
    }

    return null;
}

async function restartActiveOcrSessionForConfigChange(reason: string) {
    if (!getProcessManager().isRunning(OCR_CLIENT_ID) || !activeOcrRunMode) {
        return;
    }

    const source = activeOcrSource ?? 'user';
    sendToMainWindowFrames(
        'ocr-log',
        `[OCR] Restarting active ${activeOcrRunMode} session to apply ${reason}.`
    );

    if (activeOcrRunMode === 'manual') {
        startManualOCR({ source });
        return;
    }

    await startOCR({ promptForAreaSelection: false, source });
}

function shouldHideOcrConsole(options?: { source?: OCRStartSource; mode?: OCRRunMode }): boolean {
    if (!isWindows()) {
        return false;
    }

    if (options?.source === 'auto-launcher') {
        return true;
    }

    return getStartConsoleMinimized();
}

/** Send a control command to the OCR process over the bus. */
function sendOcrCommand(command: string, data?: Record<string, any>): void {
    if (!getProcessManager().isRunning(OCR_CLIENT_ID)) {
        console.warn(`[OCR] Cannot send "${command}" - no active OCR process`);
        return;
    }
    const payload: Record<string, any> = { command };
    if (data && Object.keys(data).length > 0) {
        payload.data = data;
    }
    bus.publish(OCR_CLIENT_ID, 'ocr.command', payload, 'command');
}

/** Forward an OCR bus event to the renderer, mirroring the old stdout manager. */
function handleOcrEvent(event: string, data: any): void {
    sendToMainWindowFrames('ocr-ipc-message', { event, data });
    switch (event) {
        case 'started':
            sendToMainWindowFrames('ocr-ipc-started');
            break;
        case 'stopped':
            sendToMainWindowFrames('ocr-ipc-stopped');
            break;
        case 'paused':
            sendToMainWindowFrames('ocr-ipc-paused', data);
            break;
        case 'unpaused':
            sendToMainWindowFrames('ocr-ipc-unpaused', data);
            break;
        case 'status':
            sendToMainWindowFrames('ocr-ipc-status', data);
            break;
        case 'ocr_result':
            // Backend receives the result directly via the ocr.event broadcast;
            // main only forwards it to the renderer (ocr-ipc-message above).
            break;
        case 'error':
            sendToMainWindowFrames('ocr-ipc-error', data?.error ?? 'Unknown error');
            break;
        case 'config_reloaded':
            sendToMainWindowFrames('ocr-ipc-config-reloaded');
            break;
        case 'force_stable_changed':
            sendToMainWindowFrames('ocr-ipc-force-stable-changed', data);
            break;
    }
}

/** Forward OCR stdout/stderr to the renderer, filtering noisy native banners. */
function forwardOcrLog(stream: string, rawMessage: string): void {
    const message = (rawMessage || '').toString();
    const lowerMessage = message.toLowerCase();
    const trimmedMessage = message.trim();
    const isNativeInfoLog = /^I\d{4}\s/.test(trimmedMessage) || /^W\d{4}\s/.test(trimmedMessage);
    const isIgnorableScreenAIWarning =
        lowerMessage.includes('standard_text_reorderer.cc:401') ||
        lowerMessage.includes('invalid alignment between pre-joined atoms and icu symbols');
    const isIgnorableScreenAIInfo =
        isNativeInfoLog &&
        (
            lowerMessage.includes('group_rpn_detector_utils') ||
            lowerMessage.includes('tflite_model_pooled') ||
            lowerMessage.includes('multi_pass_line_recognition_mutator') ||
            lowerMessage.includes('mobile_langid') ||
            lowerMessage.includes('scheduler.cc:692') ||
            lowerMessage.includes('coarse_classifier_calculator')
        );
    const isIgnorableTfLiteBanner = lowerMessage.includes('created tensorflow lite xnnpack delegate for cpu');
    if (isIgnorableScreenAIWarning || isIgnorableScreenAIInfo || isIgnorableTfLiteBanner) {
        return;
    }

    if (stream === 'stderr') {
        console.error(`[OCR STDERR]: ${message}`);
    } else {
        console.log(`[OCR STDOUT]: ${message}`);
    }
    sendToMainWindowFrames('ocr-log', message);
}

/** Register the OCR process spec and wire its lifecycle/bus listeners once. */
function ensureOcrSupervisorWired(): void {
    if (ocrSupervisorWired) {
        return;
    }
    ocrSupervisorWired = true;
    const pm = getProcessManager();

    pm.register({
        id: OCR_CLIENT_ID,
        buildCommand: () => {
            if (!pendingOcrLaunch) {
                throw new Error('OCR launch requested with no pending command');
            }
            return { command: pendingOcrLaunch.command, args: pendingOcrLaunch.args };
        },
        windowsHide: () => pendingOcrLaunch?.windowsHide ?? false,
        namedExecutableLabel: 'OCR',
        priority: () => normalizeOcrProcessPriority(getOCRConfig().processPriority),
        gracefulStop: {
            topic: 'ocr.command',
            data: { command: 'stop' },
            timeoutMs: OCR_GRACEFUL_STOP_TIMEOUT_MS,
        },
        matchTokens: ['gsm_ocr'],
    });

    pm.on('state-changed', (id: string, state: string) => {
        if (id !== OCR_CLIENT_ID) {
            return;
        }
        if (state === 'starting') {
            sendToMainWindowFrames('ocr-started');
            sendOcrStatus(true);
        } else if (state === 'stopped') {
            // Quiet during a restart's intermediate stop; only report a real stop.
            if (ocrStopRequested) {
                sendToMainWindowFrames('ocr-stopped');
                sendOcrStatus(false);
                clearActiveOcrSession();
                ocrStopRequested = false;
            }
        } else if (state === 'crashed') {
            console.log('[OCR] Process exited unexpectedly');
            sendToMainWindowFrames('ocr-stopped');
            // Crash-safe: resume clipboard polling even though Python never sent a stop.
            sendOcrStatus(false);
            clearActiveOcrSession();
            ocrStopRequested = false;
        }
    });

    pm.on('ready', (id: string) => {
        if (id !== OCR_CLIENT_ID) {
            return;
        }
        console.log('[OCR] Process connected to bus');
        applyWindowsOcrProcessPriority(pm.getPid(OCR_CLIENT_ID));
    });

    pm.on('log', (id: string, log: { stream: string; message: string }) => {
        if (id === OCR_CLIENT_ID) {
            forwardOcrLog(log.stream, log.message);
        }
    });

    bus.subscribe('ocr.event', (msg) => {
        const payload = (msg.data ?? {}) as { event?: string; data?: unknown };
        if (typeof payload.event === 'string') {
            handleOcrEvent(payload.event, payload.data);
        }
    });
}

async function runScreenSelector() {
    if (blockOcrStartDuringUpdate('OCR screen selector')) {
        sendToMainWindowFrames('ocr-log', 'COMMAND_FINISHED');
        return;
    }
    const ocr_config = getOCRConfig();
    await new Promise((resolve, reject) => {
        let args = ['-m', 'GameSentenceMiner.ocr.owocr_area_selector_qt', '--obs'];
        const pythonExecutable = getWindowsNamedPythonExecutable(
            getPythonPath(),
            'OCR'
        );

        console.log(`Running screen selector with args: ${args.join(' ')}`);

        const process = spawn(pythonExecutable, args, {
            detached: false,
            env: getSanitizedPythonEnv()
        });

        process.stdout?.on('data', (data: Buffer) => {
            const log = data.toString().trim();
            console.log(`[Screen Selector STDOUT]: ${log}`);
            sendToMainWindowFrames('ocr-log', log);
        });

        process.on('close', (code) => {
            console.log(`Screen selector exited with code ${code}`);
            if (code === 0) {
                sendToMainWindowFrames('ocr-log', 'Screen selector completed successfully.');
                sendToMainWindowFrames('ocr-log', 'COMMAND_FINISHED');
                requestOcrConfigReload('screen-selector', { reloadArea: true, reloadElectron: false });
                resolve(null);
            } else {
                sendToMainWindowFrames('ocr-log', `Screen selector process exited with code ${code}`);
                sendToMainWindowFrames('ocr-log', 'COMMAND_FINISHED');
                reject(new Error(`Screen selector process exited with code ${code}`));
            }
        });

        process.on('error', (err) => {
            sendToMainWindowFrames('ocr-log', `Screen selector failed: ${err.message}`);
            sendToMainWindowFrames('ocr-log', 'COMMAND_FINISHED');
            reject(err);
        });
    });
    sendToMainWindowFrames('ocr-log', `Running screen area selector in background...`);
}

/**
 * Runs the OCR command, ensuring only one instance is active at a time.
 * The command is executed directly, without a detached cmd window.
 *
 * @param command - An array where the first element is the executable
 *                  and the rest are its arguments (e.g., ['tesseract', 'image.png', 'stdout']).
 */
function runOCR(command: string[], options?: { source?: OCRStartSource; mode?: OCRRunMode }) {
    if (blockOcrStartDuringUpdate('OCR process launch')) {
        sendToMainWindowFrames('ocr-stopped');
        return;
    }

    const [executable, ...args] = command;
    if (!executable) {
        console.error('Error: Command is empty. Cannot start OCR process.');
        return;
    }

    const startSource = options?.source ?? 'user';
    const runMode = options?.mode ?? 'auto';

    // The ProcessManager owns spawn/kill/restart; we just stage the launch and
    // let restart() gracefully replace any existing OCR process. Lifecycle and
    // event/log forwarding are wired once in ensureOcrSupervisorWired().
    pendingOcrLaunch = {
        command: executable,
        args,
        windowsHide: shouldHideOcrConsole({ source: startSource, mode: runMode }),
    };
    ocrStopRequested = false;
    setActiveOcrSession(startSource, runMode);
    ensureOcrSupervisorWired();

    console.log(`Starting OCR process (source=${startSource}, mode=${runMode}).`);
    void getProcessManager()
        .restart(OCR_CLIENT_ID)
        .catch((err) => {
            console.error('[OCR] Failed to (re)start process:', err);
            sendToMainWindowFrames('ocr-stopped');
        });
}

async function runCommandAndLog(command: string[]): Promise<void> {
    if (blockOcrStartDuringUpdate('OCR dependency command')) {
        throw new Error('Update in progress');
    }

    return new Promise((resolve, reject) => {
        const [executable, ...args] = command;

        if (!executable) {
            const errorMsg = 'Error: Command is empty. Cannot start process.';
            console.error(errorMsg);
            reject(new Error(errorMsg));
            return;
        }

        console.log(`Starting process with command: ${executable} ${args.join(' ')}`);
        const process = spawn(executable, args, {
            env: getSanitizedPythonEnv()
        });

        process.stdout?.on('data', (data: Buffer) => {
            const log = data.toString().trim();
            console.log(`[STDOUT]: ${log}`);
            sendToMainWindowFrames('ocr-log', log);
        });

        process.stderr?.on('data', (data: Buffer) => {
            const errorLog = data.toString().trim();
            console.error(`[STDERR]: ${errorLog}`);
            sendToMainWindowFrames('ocr-log', errorLog);
        });

        process.on('close', (code: number) => {
            console.log(`Process exited with code: ${code}`);
            sendToMainWindowFrames('ocr-log', `Process exited with code: ${code}`);
            resolve();
        });

        process.on('error', (err: Error) => {
            console.error(`Failed to start process: ${err.message}`);
            sendToMainWindowFrames('ocr-log', `Failed to start process: ${err.message}`);
            reject(err);
        });
    });
}

export async function startOCR(
    options?: { scene?: ObsScene; promptForAreaSelection?: boolean; source?: OCRStartSource }
) {
    if (blockOcrStartDuringUpdate('OCR start request')) {
        return;
    }

    // The ProcessManager replaces any running OCR process when we (re)start below.
    {
        const promptForAreaSelection = options?.promptForAreaSelection ?? true;
        const ocr_config = getOCRConfig();
        const config = await getActiveOCRConfig(options?.scene);
        const twoPassOCR = ocr_config.advancedMode ? ocr_config.twoPassOCR : true;
        if (!config && promptForAreaSelection) {
            const response = await dialog.showMessageBox(mainWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 1,
                title: 'No OCR Found',
                message: `No OCR found for current scene, run area selector?`,
            });

            if (response.response === 0) {
                // 'Yes' button
                await runScreenSelector();
            } else {
                // Do nothing, just run OCR on the entire window
            }
        }
        const ocr1 = twoPassOCR ? `${ocr_config.ocr1}` : `${ocr_config.ocr2}`;
        const command = [
            `${getPythonPath()}`,
            `-m`,
            `GameSentenceMiner.ocr.gsm_ocr`,
            `--language`,
            `${ocr_config.language}`,
            `--ocr1`,
            `${ocr1}`,
            `--ocr2`,
            `${ocr_config.ocr2}`,
            `--twopassocr`,
            `${twoPassOCR ? 1 : 0}`,
            `--obs_ocr`,
        ];

        if (ocr_config.ocr_screenshots && ocr_config.advancedMode) command.push('--clipboard');
        if (ocr_config.sendToClipboard) command.push('--clipboard-output');
        if (ocr_config.furigana_filter_sensitivity > 0)
            command.push(
                '--furigana_filter_sensitivity',
                `${ocr_config.furigana_filter_sensitivity}`
            );
        appendHotkeyArgs(command, ocr_config);
        if (ocr_config.optimize_second_scan || !ocr_config.advancedMode) command.push('--optimize_second_scan');
        if (shouldEnableLegacyKeepNewlineFlag(ocr_config)) command.push('--keep_newline');

        runOCR(command, { source: options?.source ?? 'user', mode: 'auto' });
    }
}

export function stopOCR(options?: { onlyIfSource?: OCRStartSource }): boolean {
    if (
        options?.onlyIfSource &&
        (!activeOcrSource || activeOcrSource !== options.onlyIfSource)
    ) {
        return false;
    }

    if (getProcessManager().isRunning(OCR_CLIENT_ID)) {
        ocrStopRequested = true;
        void getProcessManager().stop(OCR_CLIENT_ID);
        return true;
    }

    return false;
}

export function startManualOCR(options?: { source?: OCRStartSource }) {
    if (blockOcrStartDuringUpdate('manual OCR start request')) {
        return;
    }

    // The ProcessManager replaces any running OCR process when we (re)start below.
    {
        const ocr_config = getOCRConfig();
        const command = [
            `${getPythonPath()}`,
            `-m`,
            `GameSentenceMiner.ocr.gsm_ocr`,
            `--language`,
            `${ocr_config.language}`,
            `--ocr1`,
            `${ocr_config.ocr2}`,
            `--ocr2`,
            `${ocr_config.ocr2}`,
            `--manual`,
            `--obs_ocr`,
        ];
        if (ocr_config.ocr_screenshots && ocr_config.advancedMode) command.push('--clipboard');
        if (ocr_config.sendToClipboard) command.push('--clipboard-output');
        if (ocr_config.furigana_filter_sensitivity > 0)
            command.push(
                '--furigana_filter_sensitivity',
                `${ocr_config.furigana_filter_sensitivity}`
            );
        appendHotkeyArgs(command, ocr_config);
        if (shouldEnableLegacyKeepNewlineFlag(ocr_config)) command.push('--keep_newline');
        runOCR(command, { source: options?.source ?? 'user', mode: 'manual' });
    }
}

const OCR_REPLACEMENTS_FILE = path.join(BASE_DIR, 'config', 'ocr_replacements.json');

function readOCRReplacements(): Record<string, string> {
    fs.mkdirSync(path.dirname(OCR_REPLACEMENTS_FILE), { recursive: true });

    if (!fs.existsSync(OCR_REPLACEMENTS_FILE)) {
        const initialData = {
            enabled: true,
            args: {
                replacements: {},
            },
        };
        fs.writeFileSync(OCR_REPLACEMENTS_FILE, JSON.stringify(initialData, null, 4), 'utf-8');
        return {};
    }

    const raw = fs.readFileSync(OCR_REPLACEMENTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const replacements = parsed?.args?.replacements;
    return replacements && typeof replacements === 'object' ? replacements : {};
}

function writeOCRReplacements(replacements: Record<string, string>) {
    const current = fs.existsSync(OCR_REPLACEMENTS_FILE)
        ? JSON.parse(fs.readFileSync(OCR_REPLACEMENTS_FILE, 'utf-8'))
        : {};

    const next = {
        ...current,
        args: {
            ...(current.args || {}),
            replacements,
        },
    };

    fs.mkdirSync(path.dirname(OCR_REPLACEMENTS_FILE), { recursive: true });
    fs.writeFileSync(OCR_REPLACEMENTS_FILE, JSON.stringify(next, null, 4), 'utf-8');
}

export function registerOCRUtilsIPC() {
    ipcMain.handle('ocr-replacements.load', async () => {
        try {
            return readOCRReplacements();
        } catch (error) {
            console.error('Failed to load OCR replacements:', error);
            return {};
        }
    });

    ipcMain.handle('ocr-replacements.save', async (_, replacements: Record<string, string>) => {
        try {
            writeOCRReplacements(replacements || {});
            return { success: true };
        } catch (error: any) {
            console.error('Failed to save OCR replacements:', error);
            return { success: false, message: error?.message || String(error) };
        }
    });

    ipcMain.on('ocr.install-recommended-deps', async () => {
        const pythonPath = getPythonPath();
        await closeAllPythonProcesses();
        sendToMainWindowFrames('ocr-log', `Downloading OneOCR files...`);
        const dependencies = [
            'jaconv',
            'loguru',
            'numpy==2.2.6',
            'Pillow>=10.0.0',
            'pyperclipfix',
            'pynput<=1.7.8',
            'websockets>=14.0',
            'desktop-notifier>=6.1.0',
            'mss',
            'pysbd',
            'langid',
            'psutil',
            'requests',
            "pywin32;platform_system=='Windows'",
            "pyobjc;platform_system=='Darwin'",
        ];
        const promises: Promise<void>[] = [];
        if (isWindows()) {
            await runCommandAndLog([
                pythonPath,
                '-m',
                'GameSentenceMiner.util.downloader.oneocr_dl',
            ]);
            await runCommandAndLog([
                pythonPath,
                '-m',
                'uv',
                '--no-progress',
                'pip',
                'install',
                '--upgrade',
                'oneocr',
            ]);
        }
        await runCommandAndLog([
            pythonPath,
            '-m',
            'uv',
            '--no-progress',
            'pip',
            'install',
            '--upgrade',
            ...dependencies,
        ]);
        sendToMainWindowFrames('ocr-log', `Installing recommended dependencies...`);
        await runCommandAndLog([
            pythonPath,
            '-m',
            'uv',
            '--no-progress',
            'pip',
            'install',
            '--upgrade',
            'protobuf>=6.33.2',
        ]);

        // Wait for all promises to settle before closing the console
        await Promise.allSettled(promises);
        // Wrap the message in ASCII green text (using ANSI escape codes)
        sendToMainWindowFrames(
            'ocr-log',
            `\x1b[32mAll recommended dependencies installed successfully.\x1b[0m`
        );
        sendToMainWindowFrames('ocr-log', `\x1b[32mYou can now close this console.\x1b[0m`);
        await restartGSM();
        // setTimeout(() => sendToMainWindowFrames('ocr-log', 'COMMAND_FINISHED'), 5000);
    });

    ipcMain.on('ocr.install-selected-dep', async (_, dependency: string) => {
        const pythonPath = getPythonPath();
        await closeAllPythonProcesses();
        let command: string[];
        if (dependency.includes('pip')) {
            command = [
                pythonPath,
                '-m',
                'uv',
                '--no-progress',
                ...dependency.split(' '),
                'numpy==2.2.6',
                '--upgrade',
            ];
        } else {
            command = [pythonPath, '-m', 'uv', '--no-progress', dependency];
        }
        sendToMainWindowFrames('ocr-log', `Installing ${dependency} dependencies...`);
        await runCommandAndLog(command);
        sendToMainWindowFrames(
            'ocr-log',
            `\x1b[32mInstalled ${dependency} successfully.\x1b[0m`
        );
        sendToMainWindowFrames('ocr-log', `\x1b[32mYou can now close this console.\x1b[0m`);
        await restartGSM();
    });

    ipcMain.on('ocr.uninstall-selected-dep', async (_, dependency: string) => {
        const pythonPath = getPythonPath();
        await closeAllPythonProcesses();
        const response = await dialog.showMessageBox(mainWindow!, {
            type: 'question',
            buttons: ['Yes', 'No'],
            defaultId: 1,
            title: 'Confirm Uninstall',
            message: `Are you sure you want to uninstall the dependency: ${dependency}?`,
        });

        if (response.response === 0) {
            // 'Yes' button
            const command = [
                getPythonPath(),
                '-m',
                'uv',
                '--no-progress',
                'pip',
                'uninstall',
                dependency,
            ];
            sendToMainWindowFrames('ocr-log', `Uninstalling ${dependency} dependencies...`);
            await runCommandAndLog(command);
            sendToMainWindowFrames(
                'ocr-log',
                `\x1b[32mUninstalled ${dependency} successfully.\x1b[0m`
            );
            sendToMainWindowFrames(
                'ocr-log',
                `\x1b[32mYou can now close this console.\x1b[0m`
            );
        } else {
            sendToMainWindowFrames('ocr-log', `Uninstall canceled for ${dependency}.`);
        }
        await restartGSM();
    });

    ipcMain.on('ocr.run-screen-selector', async () => {
        try {
            await runScreenSelector();
        } catch (error) {
            console.error('Failed to run screen selector:', error);
        }
    });

    ipcMain.handle('ocr.open-config-json', async () => {
        try {
            const ocrConfigPath = await getActiveOCRConfigPath();
            exec(`start "" "${ocrConfigPath}"`); // Opens the file with the default editor
            return true;
        } catch (error: any) {
            console.error('Error opening config file:', error.message);
            throw error;
        }
    });

    ipcMain.handle('ocr.open-config-folder', async () => {
        try {
            exec(`start "" "${path.join(BASE_DIR, 'ocr_config')}"`); // Opens the folder in Explorer
            return true;
        } catch (error: any) {
            console.error('Error opening config folder:', error.message);
            throw error;
        }
    });

    ipcMain.handle('ocr.open-global-owocr-config', async () => {
        try {
            const configPath = path.join(os.homedir(), '.config', 'owocr_config_gsm.ini');

            // Check if file exists, create it if it doesn't
            if (!fs.existsSync(configPath)) {
                const configDir = path.dirname(configPath);
                if (!fs.existsSync(configDir)) {
                    fs.mkdirSync(configDir, { recursive: true });
                }
                // Create empty config file
                fs.writeFileSync(configPath, '# OWOCR Global Configuration\n');
            }

            await shell.openPath(configPath);
            return true;
        } catch (error: any) {
            console.error('Error opening global OWOCR config:', error.message);
            throw error;
        }
    });

    ipcMain.on('ocr.start-ocr', async () => {
        await startOCR({ source: 'user' });
    });

    ipcMain.on('ocr.start-ocr-ss-only', () => {
        {
            const ocr_config = getOCRConfig();
            const ocr1 = ocr_config.twoPassOCR ? `${ocr_config.ocr1}` : `${ocr_config.ocr2}`;
            const command = [
                `${getPythonPath()}`,
                `-m`,
                `GameSentenceMiner.ocr.gsm_ocr`,
                `--language`,
                `${ocr_config.language}`,
                `--ocr1`,
                `${ocr_config.ocr2}`,
                `--ocr2`,
                `${ocr_config.ocr2}`,
                `--manual`,
                `--obs_ocr`,
            ];
            if (ocr_config.ocr_screenshots) command.push('--clipboard');
            if (ocr_config.sendToClipboard) command.push('--clipboard-output');
            if (ocr_config.furigana_filter_sensitivity > 0)
                command.push(
                    '--furigana_filter_sensitivity',
                    `${ocr_config.furigana_filter_sensitivity}`
                );
            appendHotkeyArgs(command, ocr_config);
            if (shouldEnableLegacyKeepNewlineFlag(ocr_config)) command.push('--keep_newline');
            runOCR(command, { source: 'user', mode: 'manual' });
        }
    });

    ipcMain.on('ocr.kill-ocr', () => {
        if (getProcessManager().isRunning(OCR_CLIENT_ID)) {
            sendToMainWindowFrames('ocr-log', 'Stopping OCR process...');
            stopOCR();
        }
    });

    ipcMain.on('ocr.stdin', () => {
        // OCR control now travels over the message bus, not the child's stdin.
        console.warn('[OCR] ocr.stdin is deprecated; use bus commands instead.');
    });

    ipcMain.on('ocr.restart-ocr', () => {
        // runOCR()/ProcessManager.restart() replaces any running instance.
        sendToMainWindowFrames('ocr-log', `Restarting OCR Process...`);
        ipcMain.emit('ocr.start-ocr');
    });

    ipcMain.on('ocr.save-ocr-config', async (_, config: any) => {
        // Update the main store with the new config values
        const currentConfig = getOCRConfig();
        const newConfig = { ...currentConfig, ...config };
        const changes = diffOcrConfigValues(currentConfig ?? {}, newConfig ?? {});
        setOCRConfig(newConfig);
        // Persist furigana sensitivity to the per-scene settings file
        try {
            await writeSceneSettings({
                furigana_filter_sensitivity: Number(newConfig.furigana_filter_sensitivity) || 0,
            });
        } catch (err: any) {
            console.warn(`[OCR] Failed to write scene settings: ${err.message}`);
        }
        if ('processPriority' in changes && getProcessManager().isRunning(OCR_CLIENT_ID)) {
            applyWindowsOcrProcessPriority(getProcessManager().getPid(OCR_CLIENT_ID));
        }

        const restartReason = getProcessManager().isRunning(OCR_CLIENT_ID)
            ? getOcrConfigRestartReason(changes)
            : null;
        if (restartReason) {
            await restartActiveOcrSessionForConfigChange(restartReason);
            return;
        }

        if (Object.keys(changes).length > 0) {
            requestOcrConfigReload('save-ocr-config', {
                reloadArea: false,
                reloadElectron: true,
                changes,
            });
        }
    });

    ipcMain.handle('ocr.getActiveOCRConfig', async () => {
        try {
            return await getActiveOCRConfig();
        } catch {
            return null;
        }
    });

    ipcMain.handle('ocr.getActiveSceneSettings', async () => {
        try {
            return await readSceneSettings();
        } catch {
            return getSceneSettingsDefaults();
        }
    });

    ipcMain.handle('ocr.getActiveOCRConfigWindowName', async () => {
        const ocrConfig = await getActiveOCRConfig();
        return ocrConfig ? ocrConfig.window : '';
    });

    ipcMain.handle('ocr.get-ocr-config', () => {
        const ocr_config = getOCRConfig();
        return ocr_config;
        // return {
        //     ocr1: ocr_config.ocr1,
        //     ocr2: ocr_config.ocr2,
        //     twoPassOCR: ocr_config.twoPassOCR,
        //     window_name: ocr_config.window_name,
        // }
    });

    ipcMain.handle('ocr.get-running-state', () => {
        return {
            isRunning: getProcessManager().isRunning(OCR_CLIENT_ID),
            source: activeOcrSource,
            mode: activeOcrRunMode,
        };
    });

    ipcMain.handle('run-furigana-window', async (): Promise<number> => {
        const pythonPath = getPythonPath();
        const ocr_config = getOCRConfig();
        if (blockOcrStartDuringUpdate('furigana preview')) {
            return Number(ocr_config.furigana_filter_sensitivity);
        }
        // Run the Python script with the specified sensitivity
        const result = await runPythonScript(pythonPath, [
            '-m',
            'GameSentenceMiner.ui.furigana_filter_preview_qt',
            String(ocr_config.furigana_filter_sensitivity),
        ]);
        const match = result.match(/RESULT:\[(.*?)\]/);
        const extractedResult = match ? match[1] : null;
        sendToMainWindowFrames('furigana-script-result', extractedResult);
        console.log('Furigana script result:', extractedResult);
        return Number(extractedResult || ocr_config.furigana_filter_sensitivity);
    });

    ipcMain.on('update-furigana-character', (_, char: string, fontSize: number) => {
        if (furiganaWindow) {
            furiganaWindow.webContents.send('set-furigana-character', char, fontSize);
        }
    });

    ipcMain.on('close-furigana-window', () => {
        if (furiganaWindow) {
            furiganaWindow.hide();
        }
    });

    ipcMain.handle('ocr.export-ocr-config', async () => {
        try {
            const config = await getActiveOCRConfig();
            if (!config) {
                return { success: false, message: 'No active OCR config found' };
            }

            // Only export rectangles and coordinate_system
            const exportConfig = {
                rectangles: config.rectangles || [],
                coordinate_system: config.coordinate_system || '',
            };

            const configJson = JSON.stringify(exportConfig, null, 2);
            clipboard.writeText(configJson);

            return {
                success: true,
                message: 'OCR config (rectangles & coordinate system) exported to clipboard',
            };
        } catch (error: any) {
            console.error('Error exporting OCR config:', error.message);
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle('ocr.import-ocr-config', async () => {
        try {
            const clipboardText = clipboard.readText();

            if (!clipboardText.trim()) {
                return { success: false, message: 'Clipboard is empty' };
            }

            let importedData;
            try {
                importedData = JSON.parse(clipboardText);
            } catch (parseError) {
                return { success: false, message: 'Invalid JSON in clipboard' };
            }

            // Basic validation
            if (!importedData || typeof importedData !== 'object') {
                return { success: false, message: 'Invalid config format' };
            }

            // Get current config or create base structure
            const currentConfig =
                (await getActiveOCRConfig()) || {};

            // Merge only rectangles and coordinate_system from imported data
            const updatedConfig = {
                ...currentConfig,
                scene: '',
                window: '',
                coordinate_system: importedData.coordinate_system || '',
                window_geometry: {
                    left: 0,
                    top: 0,
                    width: 0,
                    height: 0,
                },
                rectangles: importedData.rectangles || [],
                furiganaFilterSensitivity: 0,
            };

            // Show Dialogue about how many rectangles are in the config, and ask for confirmation to proceed
            const response = await dialog.showMessageBox(mainWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                title: 'Import OCR Config',
                message: `This config contains ${importedData.rectangles?.length || 0
                    } rectangles. This will overwrite the current Area configuration. Proceed with import?`,
            });

            if (response.response !== 0) {
                return { success: false, message: 'Import cancelled by user' };
            }

            const sceneConfigPath = await getActiveOCRConfigPath();
            await backupOCRConfig(sceneConfigPath);
            await fs.promises.writeFile(
                sceneConfigPath,
                JSON.stringify(updatedConfig, null, 4),
                'utf-8'
            );

            requestOcrConfigReload('import-ocr-config', { reloadArea: true, reloadElectron: false });
            return { success: true, message: 'OCR config imported successfully' };
        } catch (error: any) {
            console.error('Error importing OCR config:', error.message);
            return { success: false, message: error.message };
        }
    });

    // OCR IPC Command Handlers — all routed over the message bus.
    ipcMain.on('ocr.pause', () => {
        sendOcrCommand('pause');
    });

    ipcMain.on('ocr.unpause', () => {
        sendOcrCommand('unpause');
    });

    ipcMain.on('ocr.toggle-pause', () => {
        sendOcrCommand('toggle_pause');
    });

    ipcMain.on('ocr.get-status', () => {
        if (!getProcessManager().isRunning(OCR_CLIENT_ID)) {
            sendToMainWindowFrames('ocr-ipc-error', 'No active OCR process');
            return;
        }
        sendOcrCommand('get_status');
    });

    ipcMain.on('ocr.reload-config', (_, data?: Record<string, any>) => {
        sendOcrCommand('reload_config', data);
    });

    ipcMain.on('ocr.toggle-force-stable', () => {
        sendOcrCommand('toggle_force_stable');
    });

    ipcMain.on('ocr.set-force-stable', (_, enabled: boolean) => {
        sendOcrCommand('set_force_stable', { enabled });
    });
}

let furiganaWindow: BrowserWindow | null = null;

function createFuriganaWindow(): BrowserWindow {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    furiganaWindow = new BrowserWindow({
        width: 150,
        height: 150,
        x: Math.floor(width / 2) - 25,
        y: Math.floor(height / 2) - 25,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: true,
        webPreferences: getSecureWebPreferences(),
    });

    furiganaWindow.loadFile(path.join(getAssetsDir(), 'furigana.html'));

    furiganaWindow.webContents.on('did-finish-load', () => {
        if (furiganaWindow) {
            // Check if window still exists before setting
            // furiganaWindow.setIgnoreMouseEvents(true);
        }
    });

    furiganaWindow.on('close', (event: any) => {
        if (isQuitting) {
            furiganaWindow = null; // Allow the window to be garbage collected
            return;
        }
        event.preventDefault();
        furiganaWindow?.hide();
    });

    return furiganaWindow;

    // Optional: for debugging, open DevTools
    // furiganaWindow.webContents.openDevTools({ mode: 'detach' });
}

async function backupOCRConfig(configPath: string): Promise<void> {
    if (!fs.existsSync(configPath)) return;
    try {
        const sceneName = path.basename(configPath, '.json');
        const backupDir = path.join(path.dirname(configPath), 'backup', sceneName);
        fs.mkdirSync(backupDir, { recursive: true });
        const dateStr = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = path.join(backupDir, `${sceneName}_${dateStr}.json`);
        fs.copyFileSync(configPath, backupPath);
        console.log(`[OCR] Backed up config to ${backupPath}`);
    } catch (err: any) {
        console.warn(`[OCR] Failed to backup OCR config: ${err.message}`);
    }
}

export async function getActiveOCRConfig(scene?: ObsScene) {
    const sceneConfigPath = await getActiveOCRConfigPath(scene);
    if (!fs.existsSync(sceneConfigPath)) {
        // console.warn(`OCR config file does not exist at ${sceneConfigPath}`);
        return null;
    }
    try {
        const fileContent = await fs.promises.readFile(sceneConfigPath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error: any) {
        console.error(
            `Error reading or parsing OCR config file at ${sceneConfigPath}:`,
            error.message
        );
        return null;
    }
}

export async function getActiveOCRConfigPath(scene?: ObsScene) {
    const currentScene = scene ?? (await getCurrentScene());
    return getSceneOCRConfig(currentScene);
}

export function getSceneOCRConfig(scene: ObsScene) {
    return path.join(BASE_DIR, 'ocr_config', `${sanitizeFilename(scene.name)}.json`);
}

// ---------------------------------------------------------------------------
// Per-scene settings  ({scene}_config.json)
// Lightweight settings file (furigana, etc.) that lives alongside the area config.
// ---------------------------------------------------------------------------

function getSceneSettingsDefaults(): Record<string, any> {
    const ocrConfig = getOCRConfig();
    const value = Number(ocrConfig?.defaultSceneFuriganaFilterSensitivity);
    return {
        furigana_filter_sensitivity: Number.isFinite(value) ? value : 0,
    };
}

const SCENE_SETTINGS_WRITE_DEBOUNCE_MS = 500;

type PendingSceneSettingsWrite = {
    timer: NodeJS.Timeout | null;
    pendingPatch: Record<string, any>;
    resolvers: Array<() => void>;
    rejecters: Array<(error: unknown) => void>;
};

const sceneSettingsWriteState = new Map<string, PendingSceneSettingsWrite>();
const sceneSettingsWriteChains = new Map<string, Promise<void>>();

export function getSceneSettingsPath(scene: ObsScene): string {
    return path.join(BASE_DIR, 'ocr_config', `${sanitizeFilename(scene.name)}_config.json`);
}

export async function getActiveSceneSettingsPath(scene?: ObsScene): Promise<string> {
    const currentScene = scene ?? (await getCurrentScene());
    return getSceneSettingsPath(currentScene);
}

export async function readSceneSettings(scene?: ObsScene): Promise<Record<string, any>> {
    const settingsPath = await getActiveSceneSettingsPath(scene);
    return await readSceneSettingsFromPath(settingsPath);
}

async function readSceneSettingsFromPath(settingsPath: string): Promise<Record<string, any>> {
    const result = getSceneSettingsDefaults();
    if (!fs.existsSync(settingsPath)) return result;
    try {
        const content = await fs.promises.readFile(settingsPath, 'utf-8');
        return { ...result, ...JSON.parse(content) };
    } catch (error: any) {
        console.warn(`[OCR] Failed reading scene settings at ${settingsPath}: ${error.message}`);
        return result;
    }
}

async function flushSceneSettingsWrite(settingsPath: string, patch: Record<string, any>): Promise<void> {
    const current = await readSceneSettingsFromPath(settingsPath);
    const merged = { ...current, ...patch };
    await fs.promises.writeFile(settingsPath, JSON.stringify(merged, null, 4), 'utf-8');
    console.log(`[OCR] Wrote scene settings to ${settingsPath}`);
}

function scheduleSceneSettingsWrite(settingsPath: string, patch: Record<string, any>): Promise<void> {
    let state = sceneSettingsWriteState.get(settingsPath);
    if (!state) {
        state = {
            timer: null,
            pendingPatch: {},
            resolvers: [],
            rejecters: [],
        };
        sceneSettingsWriteState.set(settingsPath, state);
    }

    state.pendingPatch = { ...state.pendingPatch, ...patch };

    if (state.timer) {
        clearTimeout(state.timer);
    }

    const resultPromise = new Promise<void>((resolve, reject) => {
        state!.resolvers.push(resolve);
        state!.rejecters.push(reject);
    });

    state.timer = setTimeout(() => {
        const pending = sceneSettingsWriteState.get(settingsPath);
        if (!pending) {
            return;
        }

        const patchToWrite = { ...pending.pendingPatch };
        const batchResolvers = pending.resolvers.splice(0, pending.resolvers.length);
        const batchRejecters = pending.rejecters.splice(0, pending.rejecters.length);
        pending.pendingPatch = {};
        pending.timer = null;

        const previousChain = sceneSettingsWriteChains.get(settingsPath) ?? Promise.resolve();
        const nextChain = previousChain
            .catch(() => {
                // Keep chain alive even if a previous write failed.
            })
            .then(async () => {
                await flushSceneSettingsWrite(settingsPath, patchToWrite);
            })
            .then(() => {
                for (const resolve of batchResolvers) {
                    resolve();
                }
            })
            .catch((error) => {
                for (const reject of batchRejecters) {
                    reject(error);
                }
            });

        sceneSettingsWriteChains.set(settingsPath, nextChain);
    }, SCENE_SETTINGS_WRITE_DEBOUNCE_MS);

    return resultPromise;
}

export async function writeSceneSettings(settings: Record<string, any>, scene?: ObsScene): Promise<void> {
    const settingsPath = await getActiveSceneSettingsPath(scene);
    await scheduleSceneSettingsWrite(settingsPath, settings);
}
