// electron-src/main/launchers/obs.ts
import { BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import {
    BASE_DIR,
    execFileAsync,
    getAssetsDir,
    isLinux,
    isWindows,
    isWindows10OrHigher,
} from '../util.js';
import { isQuitting } from '../main.js';
import { exec } from 'child_process';
import OBSWebSocket from 'obs-websocket-js';
import Store from 'electron-store';
import * as fs from 'node:fs';
import { inflateSync } from 'node:zlib';
import { sendStartOBS, sendQuitOBS } from '../main.js';
import axios from 'axios';
import {
    OBS_DSHOW_INPUT_KIND,
    OBS_WASAPI_INPUT_CAPTURE_KIND,
    buildCaptureCardOptions,
    buildLinuxSceneCaptureInputs,
    getObsWindowTitle,
    buildWindowsSceneCaptureInputs,
    mergeObsWindowItems,
    type ObsCaptureMode,
    type ObsDevicePropertyItem,
    type ObsSceneCaptureWindowSelection,
    type ObsWindowOption,
    type ObsWindowPropertyItem,
} from './obs-capture.js';

interface ObsConfig {
    host: string;
    port: number;
    password: string;
}

export interface ObsScene {
    name: string;
    id: string;
}

const OBS_OUTPUT_PROBE_WIDTH = 8;
const OBS_OUTPUT_PROBE_HEIGHT = 8;

// -------------------------------------------------------------------------
// WINDOW FILTER CONFIGURATION
// -------------------------------------------------------------------------

interface WindowFilter {
    exeName?: string; // Executable name (e.g., "Code.exe", "cmd.exe")
    windowClass?: string; // Window class (e.g., "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS")
    titlePattern?: string | RegExp; // Title pattern (exact match or regex)
    // If multiple properties are specified, ALL must match (AND logic)
}

/**
 * List of windows to filter out from the window list.
 * Can filter by exe name, window class, or window title.
 * If multiple properties are specified in a single filter, ALL must match (AND logic).
 * MANY OF THESE ARE FOR ME, AND MAY NOT BE RELEVANT TO OTHER USERS. THIS IS NOT AN EXHAUSTIVE LIST.
 */
const WINDOW_FILTERS: WindowFilter[] = [
    // Developer tools and IDEs
    { exeName: 'Code.exe' }, // Visual Studio Code
    // System tools
    { exeName: 'cmd.exe' },
    { windowClass: 'ConsoleWindowClass' },
    { windowClass: 'CASCADIA_HOSTING_WINDOW_CLASS' },
    // Audio editors
    { exeName: 'ocenaudio.exe' },
    // Specific applications
    { exeName: 'SKIF.exe' }, // Special K
    { exeName: 'EpicGamesLauncher.exe' }, // Epic Games Launcher
    { titlePattern: 'Epic Games Launcher' }, // Epic Games Launcher by title
    { exeName: 'LunaTranslator.exe' }, // LunaTranslator
    { titlePattern: 'LunaTranslator' }, // LunaTranslator by title
    // Windows Search
    { exeName: 'SearchHost.exe' }, // Windows Search Host
    { titlePattern: 'Search' }, // Windows Search by title
    // ShareX
    { exeName: 'ShareX.exe' }, // ShareX
    { titlePattern: 'ShareX' }, // ShareX by title
    // Flydigi Space Station (must match both exe and title)
    { exeName: 'Flydigi Space Station.exe' }, // Flydigi only
    // Anki (must match both pythonw.exe AND have Anki in title)
    { exeName: 'pythonw.exe', titlePattern: '- Anki' }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: 'Browse (' }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: /^Edit$/ }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: 'Preview' }, // Anki only
    // Exact title match
    { exeName: 'GameSentenceMiner.exe'},
    { titlePattern: 'GSM Overlay' },
    { titlePattern: 'GitHub Desktop' },
    { titlePattern: 'OBS Studio' },
    { titlePattern: 'iCUE' },
    { titlePattern: 'Magpie' },
    { titlePattern: 'Calculator' },
    { titlePattern: '[Select a window to capture]' },
    { titlePattern: 'Microsoft Edge Game Assist' },
    { titlePattern: /^.*Prism Launcher .*$/ },
    { titlePattern: /^.*mRemoteNG.*$/ },
    { titlePattern: "Task Manager" },
    { windowClass: 'obs' },
    { windowClass: 'plasmashell' },
    { titlePattern: /^Desktop @ QRect/i }

];

// -------------------------------------------------------------------------
// GAME TITLE PARSING CONFIGURATION
// -------------------------------------------------------------------------

interface TitleMatcher {
    name: string; // Identifier for debugging
    pattern: RegExp; // Regex to test if the window belongs to this category
    // Logic to extract the clean name from the MatchArray
    getName: (match: RegExpMatchArray) => string;
    // Logic to create the OBS Auto Switcher Regex based on the extracted name
    getSwitcherPattern: (cleanName: string) => string;
    priority?: number; // Lower numbers = higher priority. Default: 50. Use 100+ for fallback matchers.
}

/**
 * Expandable list of regex patterns for Emulators and Games.
 * The system checks these in order. The first match wins.
 */
const TITLE_MATCHERS: TitleMatcher[] = [
    {
        name: 'Vita3K',
        // Pattern: Vita3K [ver] | Game Name (ID) | ...
        pattern: /^Vita3K.*?\|\s*(.+?)\s*\(/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `Vita3K.*?\\|.*${escapeRegexCharacters(n.trim())}.*\\(.*`
    },
    {
        name: 'Eden/Yuzu/Suyu (extra segments)',
        // Pattern: Eden | v0.0.4-rc1 | MSVC ... | Game Name (64-bit) | ... | ...
        // Allows additional pipe-separated segments between version and game name, and after the game name.
        // Captures the segment containing (64-bit) or (32-bit), which marks the game title.
        pattern: /^(?:Eden|yuzu|suyu)\s*\|\s*v[^|]+\s*(?:\|[^|]*)*\|\s*([^|]+?)\s*\((?:64|32)-bit\)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `(?:Eden|yuzu|suyu).*\\|.*?\\|.*${escapeRegexCharacters(n.trim())}.*`,
        priority: 45,
    },
    {
        name: 'Eden/Yuzu/Suyu',
        // Pattern: Eden | v0.0.3 | Game Name (64-bit) | ...
        // Pattern: yuzu | v0.0.3 | Game Name (64-bit) | ...
        // Pattern: suyu | v0.0.3 | Game Name (64-bit) | ...
        pattern: /^(?:Eden|yuzu|suyu)\s*\|\s*v[\d.]+\s*\|\s*(.+?)\s*(\(64-bit\)|\(32-bit\)|\||$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `(?:Eden|yuzu|suyu).*\\|.*?\\|.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'RPCS3',
        // Pattern: FPS: 30.22 | Vulkan | 0.0.38 | Demon's Souls [BLES00932]
        // Updated to use greedy matching (.*) before the pipe to skip 'Vulkan'/'Version' segments
        pattern: /^FPS:.*\|\s*([^|]+?)\s*\[\w+\]$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `FPS:.*\\|.*${escapeRegexCharacters(n.trim())}.*\\[\\w+\\]`
    },
    {
        name: 'Cemu',
        // Pattern: Cemu ... [TitleId: 000...] Breath of the Wild [US v208]
        // Anchors on the [TitleId: ...] block
        pattern: /^Cemu.*?\[TitleId:[^\]]+\]\s*(.+?)(?:\s*\[|$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `Cemu.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'Dolphin',
        // Pattern: Dolphin 5.0 | JIT | ... | Game Name (GAMEID)
        // Anchors to the Game ID in parens at the very end
        pattern: /^Dolphin.*?\|\s*([^|]+?)\s*\([A-Z0-9]{6}\)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `Dolphin.*?\\|.*${escapeRegexCharacters(n.trim())}.*\\([A-Z0-9]{6}\\)`
    },
    {
        name: 'PPSSPP',
        // Pattern: PPSSPP v1.19.3 - ULJS00186 : Game Name
        pattern: /^PPSSPP.*?-[A-Z0-9\s]+:\s*(.+)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `PPSSPP.*?:.*${escapeRegexCharacters(n.trim())}`
    },
    {
        name: 'Simple Pipe-Separated (Citra/DeSmuME)',
        // Pattern: Azahar ... | Game Name 
        // Pattern: DeSmuME ... | Game Name
        // Covers: Citra, Azahar, Lime3DS, Mandarine, DeSmuME
        pattern: /^(?:Azahar|Citra|Lime3DS|Mandarine|DeSmuME).*?\|\s*(.+?)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `(?:Azahar|Citra|Lime3DS|Mandarine|DeSmuME).*?\\|.*${escapeRegexCharacters(n.trim())}`
    },
    {
        name: 'Prefix Dash-Separated (mGBA/Flycast/Mesen)',
        // Pattern: mGBA - Game Name (Japan)
        // Pattern: Flycast - Game Name (USA)
        // Pattern: Mesen - Game Name [!]
        // Captures name, stopping before (Region) or [Flags]
        pattern: /^(?:mGBA|Flycast|Mesen)\s*-\s*(.+?)(?:\s*[\(\[].*|$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `(?:mGBA|Flycast|Mesen).*-.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'Suffix Dash-Separated (VBA-M/PJ64/Snes9x/RMG)',
        // Pattern: Game Name (U) [!] - Emulator Name ...
        // Covers: VisualBoyAdvance-M, Project64, Snes9x, Rosalie's Mupen GUI
        pattern: /^(.+?)(?:\s*[\(\[].*?)?\s*-\s*(?:VisualBoyAdvance|Project64|Snes9x|Rosalie's Mupen)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `${escapeRegexCharacters(n.trim())}.*-.*(?:VisualBoyAdvance|Project64|Snes9x|Rosalie's Mupen).*`
    },
    {
        name: 'Generic Version Suffix',
        // Pattern: Game Name - Ver1.0.0 OR Game Name ver1.00
        // Kept at the bottom as a catch-all
        pattern: /^(.+?)\s*(?:-|)\s*ver\d/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `${escapeRegexCharacters(n.trim())}.*`,
        priority: 90
    },
    {
        name: "Generic Suffix",
        // Pattern: Game Name followed by various separators and text (e.g., "Kanon プロローグ" -> "Kanon")
        // Covers: patterns with space followed by Japanese/descriptive text, or other common suffixes
        pattern: /^(.+?)\s+(?:プロローグ|エピローグ|体験版|デモ版|demo)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `.*${escapeRegexCharacters(n.trim())}.*`,
        priority: 100
    }
    // {
    //     name: 'MPV',
    //     // Pattern: .* - mpv
    //     pattern: /^(.+?)\s*-\s*mpv$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*mpv$`
    // },
    // {
    //     name: 'VLC',
    //     // Pattern: MyAnimeTitle - VLC.*
    //     pattern: /^(.+?)\s*-\s*VLC.*$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*VLC.*$`
    // },
    // {
    //     name: 'Memento',
    //     // Pattern: MyAnimeTitle - Memento
    //     pattern: /^(.+?)\s*-\s*Memento$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*Memento$`
    // }
];

// Helper to determine Scene Name and Switcher Pattern from a raw Window Title
function getGameInfoFromWindow(rawTitle: string): { sceneName: string; switcherRegex: string } {
    // Sort matchers by priority (lower number = higher priority)
    const sortedMatchers = [...TITLE_MATCHERS].sort((a, b) => {
        const priorityA = a.priority ?? 50;
        const priorityB = b.priority ?? 50;
        return priorityA - priorityB;
    });

    for (const matcher of sortedMatchers) {
        const match = rawTitle.match(matcher.pattern);
        if (match) {
            try {
                const cleanName = matcher.getName(match);
                if (cleanName) {
                    console.log(`[OBS] Title Match Found (${matcher.name}): "${cleanName}"`);
                    return {
                        sceneName: cleanName,
                        switcherRegex: matcher.getSwitcherPattern(cleanName)
                    };
                }
            } catch (e) {
                logObsError(`[OBS] Error processing matcher ${matcher.name}:`, e);
            }
        }
    }

    // Fallback: Use a generic base title segment to better tolerate title changes
    const genericBaseTitle = rawTitle
        .split('|')[0]
        .split(' - ')[0]
        .trim() || rawTitle.trim();

    console.log(`[OBS] No matcher found for: "${rawTitle}". Using generic base title: "${genericBaseTitle}".`);
    return {
        sceneName: rawTitle,
        switcherRegex: `.*${escapeRegexCharacters(genericBaseTitle)}.*`
    };
}

// -------------------------------------------------------------------------

export let pythonConfig: Store | null = null;
try {
    pythonConfig = new Store();
} catch (error) {
    logObsError('Failed to load pythonConfig store, using empty config.', error);
    // pythonConfig = new Store({defaults: {}});
}

let obsConfig: ObsConfig = (pythonConfig?.get('configs.Default.obs') as ObsConfig) || {
    host: 'localhost',
    port: 7274,
    password: '',
};

const OBS_CONFIG_PATH = path.join(BASE_DIR, 'obs-studio');
const SCENE_CONFIG_PATH = path.join(OBS_CONFIG_PATH, 'config', 'obs-studio', 'basic', 'scenes');
let obs = new OBSWebSocket();
let obsConnected = false;
const OLD_HELPER_SCENE = "GSM Helper";
const HELPER_SCENE = 'GSM Helper - DONT TOUCH';
const WINDOW_GETTER_INPUT = 'window_getter';
const GAME_WINDOW_INPUT = 'game_window_getter';
const CAPTURE_CARD_GETTER_INPUT = 'capture_card_getter';
const AUDIO_INPUT_GETTER_INPUT = 'audio_input_getter';
let sceneSwitcherRegistered = false;

let connectionPromise: Promise<void> | null = null;
let resetPromise: Promise<void> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let obsLifecycleRegistered = false;
let reconnectDelayMs = 1000;

const OBS_RECONNECT_MIN_DELAY_MS = 1000;
const OBS_RECONNECT_MAX_DELAY_MS = 30000;
const OBS_CONNECT_RETRY_COUNT = 5;
const OBS_CONNECT_RETRY_DELAY_MS = 1000;
const OBS_HEARTBEAT_INTERVAL_MS = 15000;
const OBS_CALL_TIMEOUT_MS = 7000;
const OBS_CONNECT_TIMEOUT_MS = 10000;
const OBS_DISCONNECT_TIMEOUT_MS = 3000;
const VIDEO_CAPTURE_INPUT_KINDS = new Set([
    'window_capture',
    'game_capture',
    'monitor_capture',
    'xcomposite_input',
]);

// Utility function to escape regex special characters in window titles
function escapeRegexCharacters(str: string): string {
    // Escape all regex special characters that could break the auto scene switcher
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Check if a window item should be filtered out
function shouldFilterWindow(item: any): boolean {
    const windowValue = item.itemValue || '';
    const itemName = item.itemName || '';
    let exeName = '';
    let windowClass = '';
    let title = '';

    if (typeof windowValue === 'string' && windowValue.includes('\r\n')) {
        const [, encodedTitle = '', encodedWindowClass = ''] = windowValue
            .split(/\r?\n/)
            .map((part) => part.trim());
        title = itemName.trim() || encodedTitle;
        windowClass = encodedWindowClass;
    } else {
        // Parse window value format: "Title:ClassName:ExeName.exe"
        const parts = windowValue.split(':');
        exeName = parts[parts.length - 1]?.trim() || '';
        windowClass = parts[parts.length - 2]?.trim() || '';
        title = getObsWindowTitle(itemName);
    }

    for (const filter of WINDOW_FILTERS) {
        let matches = true; // Assume match unless proven otherwise

        // Check exe name filter (if specified)
        if (filter.exeName) {
            if (exeName.toLowerCase() !== filter.exeName.toLowerCase()) {
                matches = false;
            }
        }

        // Check window class filter (if specified)
        if (filter.windowClass && matches) {
            if (windowClass !== filter.windowClass) {
                matches = false;
            }
        }

        // Check title pattern filter (if specified)
        if (filter.titlePattern && matches) {
            if (typeof filter.titlePattern === 'string') {
                // Substring match for string patterns
                if (!title.includes(filter.titlePattern)) {
                    matches = false;
                }
            } else if (filter.titlePattern instanceof RegExp) {
                // Regex match for RegExp patterns
                if (!filter.titlePattern.test(title)) {
                    matches = false;
                }
            }
        }

        // If all specified conditions match, filter this window
        if (matches) {
            return true;
        }
    }

    return false;
}

function parseLinuxXCompositeWindowValue(windowValue: string): {
    windowId: string;
    title: string;
    windowClass: string;
} {
    const [windowId = '', title = '', windowClass = ''] = windowValue
        .split(/\r?\n/)
        .map((part) => part.trim());
    return { windowId, title, windowClass };
}

function encodeLinuxXCompositeWindowValue(
    windowId: string,
    title: string,
    windowClass: string
): string {
    return [windowId.trim(), title.trim(), windowClass.trim()].join('\r\n');
}

function decodeXPropStringValue(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
        return '';
    }

    const jsonCandidate = `[${trimmed}]`;
    try {
        const parsed = JSON.parse(jsonCandidate);
        const firstValue = parsed.find(
            (value: unknown) => typeof value === 'string' && value.trim().length > 0
        );
        return typeof firstValue === 'string' ? firstValue.trim() : '';
    } catch {
        return trimmed.replace(/^"+|"+$/g, '').trim();
    }
}

async function listLinuxX11WindowIds(): Promise<
    Array<{ xpropWindowId: string; obsWindowId: string }>
> {
    const { stdout } = await execFileAsync('xprop', ['-root', '_NET_CLIENT_LIST']);
    const ids = stdout.match(/0x[0-9a-fA-F]+/g) ?? [];

    return ids
        .map((xpropWindowId) => {
            try {
                return {
                    xpropWindowId,
                    obsWindowId: BigInt(xpropWindowId).toString(10),
                };
            } catch {
                return null;
            }
        })
        .filter(
            (
                windowId
            ): windowId is { xpropWindowId: string; obsWindowId: string } =>
                windowId !== null
        );
}

async function getLinuxX11WindowDetails(windowId: string): Promise<{
    title: string;
    windowClass: string;
} | null> {
    try {
        const { stdout } = await execFileAsync('xprop', [
            '-id',
            windowId,
            '_NET_WM_NAME',
            'WM_NAME',
            'WM_CLASS',
        ]);
        const lines = stdout.split(/\r?\n/);
        const titleLine =
            lines.find((line) => line.startsWith('_NET_WM_NAME')) ??
            lines.find((line) => line.startsWith('WM_NAME'));
        const classLine = lines.find((line) => line.startsWith('WM_CLASS'));

        const title = titleLine ? decodeXPropStringValue(titleLine.split('=').slice(1).join('=')) : '';
        const windowClass = classLine
            ? decodeXPropStringValue(classLine.split('=').slice(1).join('='))
            : '';

        if (!title || !windowClass) {
            return null;
        }

        return { title, windowClass };
    } catch {
        return null;
    }
}

// Generate a random fallback window name
function generateFallbackWindowName(): string {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `Scene-${dateStr}`;
}

function getObsDialogParent(): BrowserWindow | undefined {
    return obsWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
}

function getObsErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function logObsError(...args: unknown[]): void {
    // Intentionally no-op: OBS errors in this module are suppressed.
}

function refreshObsConfig(): void {
    obsConfig = (pythonConfig?.get('configs.Default.obs') as ObsConfig) || {
        host: 'localhost',
        port: 7274,
        password: '',
    };
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class OBSTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`);
        this.name = 'OBSTimeoutError';
    }
}

function isOBSTimeoutError(error: unknown): error is OBSTimeoutError {
    return error instanceof OBSTimeoutError;
}

function isOBSInitializingError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
        return (error as any).code === 207;
    }
    return false;
}

function withTimeout<T>(
    operation: string,
    timeoutMs: number,
    promiseFactory: () => Promise<T>
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new OBSTimeoutError(operation, timeoutMs));
        }, timeoutMs);

        void promiseFactory()
            .then((result) => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch((error) => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

function isVideoCaptureSceneItem(item: { inputKind?: unknown }): boolean {
    return VIDEO_CAPTURE_INPUT_KINDS.has(String(item.inputKind ?? ''));
}

async function resetOBSClient(reason: string): Promise<void> {
    if (resetPromise) {
        return resetPromise;
    }

    resetPromise = (async () => {
        logObsError(`[OBS] Resetting websocket client (${reason})`);
        clearReconnectTimer();

        const staleClient = obs;
        obs = new OBSWebSocket();
        obsConnected = false;
        obsLifecycleRegistered = false;
        sceneSwitcherRegistered = false;

        try {
            staleClient.removeAllListeners();
            await withTimeout('OBS disconnect', OBS_DISCONNECT_TIMEOUT_MS, () =>
                staleClient.disconnect()
            );
        } catch (error) {
            const errorMessage = getObsErrorMessage(error);
            if (
                !isOBSTimeoutError(error) &&
                !errorMessage.toLowerCase().includes('not connected')
            ) {
                logObsError(
                    `[OBS] Failed to disconnect stale websocket: ${errorMessage}`
                );
            }
        }

        registerOBSLifecycleHandlers();
    })().finally(() => {
        resetPromise = null;
    });

    return resetPromise;
}

async function callOBS<T = any>(
    requestType: string,
    requestData?: Record<string, unknown>,
    timeoutMs = OBS_CALL_TIMEOUT_MS
): Promise<T> {
    try {
        return await withTimeout(`OBS request ${requestType}`, timeoutMs, () =>
            obs.call(requestType as any, requestData as any)
        );
    } catch (error) {
        if (isOBSTimeoutError(error)) {
            obsConnected = false;
            await resetOBSClient(`${requestType} request timeout`);
        }

        throw error;
    }
}

function clearReconnectTimer(): void {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleOBSReconnect(reason: string): void {
    if (isQuitting || reconnectTimer || connectionPromise) {
        return;
    }

    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, OBS_RECONNECT_MAX_DELAY_MS);

    logObsError(`[OBS] Scheduling reconnect in ${delay}ms (${reason})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        void getOBSConnection().catch((error) => {
            logObsError(
                `[OBS] Background reconnect attempt failed: ${getObsErrorMessage(error)}`
            );
            scheduleOBSReconnect('background retry');
        });
    }, delay);
}

function startOBSHeartbeat(): void {
    if (heartbeatTimer) {
        return;
    }

    heartbeatTimer = setInterval(() => {
        if (!obsConnected || connectionPromise || isQuitting) {
            return;
        }

        void callOBS('GetVersion').catch((error) => {
            obsConnected = false;
            logObsError(`[OBS] Heartbeat failed: ${getObsErrorMessage(error)}`);
            scheduleOBSReconnect('heartbeat failure');
        });
    }, OBS_HEARTBEAT_INTERVAL_MS);
}

function registerOBSLifecycleHandlers(): void {
    if (obsLifecycleRegistered) {
        return;
    }

    obs.on('ConnectionClosed', (error) => {
        obsConnected = false;
        logObsError(`[OBS] Connection closed: ${getObsErrorMessage(error)}`);
        scheduleOBSReconnect('connection closed');
    });

    obs.on('ConnectionError', (error) => {
        obsConnected = false;
        logObsError(`[OBS] Connection error: ${getObsErrorMessage(error)}`);
        scheduleOBSReconnect('connection error');
    });

    obsLifecycleRegistered = true;
    startOBSHeartbeat();
}

async function isOBSHealthy(): Promise<boolean> {
    if (!obsConnected) {
        return false;
    }

    try {
        await callOBS('GetVersion');
        return true;
    } catch (error) {
        obsConnected = false;
        return false;
    }
}

// Shared scene creation logic
async function createSceneWithCapture(window: ObsSceneCaptureWindowSelection): Promise<void> {
    if (!isWindows() && !isLinux()) {
        throw new Error(
            'Automatic OBS capture setup is currently only supported on Windows and Linux XComposite.'
        );
    }

    await getOBSConnection();

    const targetKind =
        window.targetKind === 'capture_card' || typeof window.videoDeviceId === 'string'
            ? 'capture_card'
            : 'window';
    const rawWindowTitle =
        typeof window.title === 'string' && window.title.trim()
            ? window.title.trim()
            : generateFallbackWindowName();
    const requestedSceneName =
        typeof window.sceneName === 'string' && window.sceneName.trim()
            ? window.sceneName.trim()
            : rawWindowTitle;
    const detectedWindowSceneInfo =
        targetKind === 'window' ? getGameInfoFromWindow(rawWindowTitle) : null;
    const sceneInfo =
        targetKind === 'window'
            ? {
                  sceneName:
                      requestedSceneName === rawWindowTitle
                          ? (detectedWindowSceneInfo?.sceneName ?? requestedSceneName)
                          : requestedSceneName,
                  switcherRegex:
                      isWindows() ? detectedWindowSceneInfo?.switcherRegex ?? null : null,
              }
            : {
                  sceneName: requestedSceneName,
                  switcherRegex: null,
              };
    const sceneName = sceneInfo.sceneName.trim() || generateFallbackWindowName();

    let sceneExisted = false;
    try {
        // Try to create the scene
        await callOBS('CreateScene', { sceneName });
    } catch (error: any) {
        // If the scene already exists, wipe all sources from the scene
        if (error && error.code === 601) {
            sceneExisted = true;
        } else {
            return;
        }
    }

    // If the scene existed, remove all sources from it
    if (sceneExisted) {
        try {
            const sceneItems = await callOBS('GetSceneItemList', { sceneName });
            for (const item of sceneItems.sceneItems) {
                if (typeof item.sceneItemId === 'number') {
                    try {
                        await callOBS('RemoveSceneItem', {
                            sceneName,
                            sceneItemId: item.sceneItemId,
                        });
                    } catch {
                        // Ignore errors if a scene item cannot be removed.
                    }
                }
            }
        } catch (wipeErr) {
            // Ignore errors wiping scene
        }
    }

    // Set the new scene as the current program scene
    await callOBS('SetCurrentProgramScene', { sceneName });

    const captureInputs = isWindows()
        ? buildWindowsSceneCaptureInputs(sceneName, window, {
              isWindows: isWindows(),
              isWindows10OrHigher: isWindows10OrHigher(),
          })
        : buildLinuxSceneCaptureInputs(sceneName, window, {
              isLinux: isLinux(),
          });

    // Create the fallback source first so the preferred game capture lands on top.
    for (const captureInput of captureInputs) {
        try {
            await callOBS('GetInputSettings', { inputName: captureInput.inputName });
            await callOBS('SetInputSettings', {
                inputName: captureInput.inputName,
                inputSettings: captureInput.inputSettings,
                overlay: false,
            });

            let existingSceneItemId: number | null = null;
            try {
                const sceneItem = await callOBS('GetSceneItemId', {
                    sceneName,
                    sourceName: captureInput.inputName,
                });
                if (typeof sceneItem.sceneItemId === 'number') {
                    existingSceneItemId = sceneItem.sceneItemId;
                }
            } catch {
                existingSceneItemId = null;
            }

            if (existingSceneItemId === null) {
                await callOBS('CreateSceneItem', {
                    sceneName,
                    sourceName: captureInput.inputName,
                    sceneItemEnabled: captureInput.sceneItemEnabled,
                });
            } else {
                await callOBS('SetSceneItemEnabled', {
                    sceneName,
                    sceneItemId: existingSceneItemId,
                    sceneItemEnabled: captureInput.sceneItemEnabled,
                });
            }
        } catch {
            await callOBS('CreateInput', {
                sceneName,
                ...captureInput,
            });
        }
    }

    if (sceneInfo.switcherRegex) {
        // Configure auto scene switcher with the generated REGEX pattern.
        await modifyAutoSceneSwitcherInJSON(sceneName, sceneInfo.switcherRegex);
    } else if (targetKind === 'capture_card') {
        const audioWasConfigured = captureInputs.some(
            (captureInput) =>
                captureInput.inputKind === OBS_WASAPI_INPUT_CAPTURE_KIND ||
                (captureInput.inputKind === OBS_DSHOW_INPUT_KIND &&
                    typeof captureInput.inputSettings.audio_device_id === 'string' &&
                    captureInput.inputSettings.audio_device_id.length > 0)
        );

        const guidanceLines = [
            'Capture-card scenes do not get an automatic window-title scene-switch rule.',
            audioWasConfigured
                ? 'Audio was paired automatically with this capture device.'
                : 'Audio was not auto-detected. If your card carries audio, add it in OBS using the new source properties or a separate Audio Input Capture source.',
        ];

        const dialogOptions = {
            type: 'info' as const,
            title: 'Capture Card Scene Created',
            message: `Created "${sceneName}" using a Video Capture Device source.`,
            detail: guidanceLines.join('\n'),
        };
        const dialogParent = getObsDialogParent();
        if (dialogParent) {
            await dialog.showMessageBox(dialogParent, dialogOptions);
        } else {
            await dialog.showMessageBox(dialogOptions);
        }
    }

    console.log(
        `Scene and capture setup for ${targetKind}: "${rawWindowTitle}" -> Scene: "${sceneName}"`
    );
}

async function modifyAutoSceneSwitcherInJSON(
    sceneName: string,
    windowTitleRegex: string
): Promise<void> {
    try {
        await getOBSConnection();
        
        const currentSceneCollection = await callOBS('GetSceneCollectionList');
        const sceneCollectionName = currentSceneCollection.currentSceneCollectionName;

        const sceneCollectionPath = path.join(
            SCENE_CONFIG_PATH,
            `${sceneCollectionName}.json`.replace(' ', '_')
        );

        // Verify the file exists before proceeding
        if (!fs.existsSync(sceneCollectionPath)) {
            logObsError(`Scene collection file not found: ${sceneCollectionPath}`);
            return;
        }

        sendQuitOBS();
        
        // Wait a bit for OBS to close gracefully
        await new Promise(resolve => setTimeout(resolve, 1000));

        const fileContent = await fs.promises.readFile(sceneCollectionPath, 'utf-8');
        const sceneCollection = JSON.parse(fileContent);

        // Initialize modules object if it doesn't exist
        if (!sceneCollection['modules']) {
            sceneCollection['modules'] = {};
        }

        let autoSceneSwitcher = sceneCollection['modules']['auto-scene-switcher'];

        if (!autoSceneSwitcher) {
            sceneCollection['modules']['auto-scene-switcher'] = {
                interval: 300,
                non_matching_scene: '',
                switch_if_not_matching: false,
                active: true,
                switches: [],
            };
            autoSceneSwitcher = sceneCollection['modules']['auto-scene-switcher'];
        }

        // Ensure switches array exists
        if (!Array.isArray(autoSceneSwitcher.switches)) {
            autoSceneSwitcher.switches = [];
        }

        // NOTE: We do NOT escape characters here anymore, because `windowTitleRegex`
        // is now passed in as a complete regex string from `getGameInfoFromWindow`.

        // Check if this scene already has a switch configured
        const existingSwitchIndex = autoSceneSwitcher.switches.findIndex(
            (s: any) => s.scene === sceneName
        );

        if (!autoSceneSwitcher.active) {
            const response = await dialog.showMessageBox(obsWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 0,
                title: 'Enable Auto Scene Switcher',
                message: 'Do you want to enable the auto scene switcher?',
            });

            if (response.response === 0) {
                autoSceneSwitcher.active = true;
            }
        }

        // Add or update the switch entry
        const switchEntry = {
            scene: sceneName,
            window_title: windowTitleRegex,
        };

        if (existingSwitchIndex >= 0) {
            autoSceneSwitcher.switches[existingSwitchIndex] = switchEntry;
        } else {
            autoSceneSwitcher.switches.push(switchEntry);
        }

        sceneCollection['modules']['auto-scene-switcher'] = autoSceneSwitcher;

        const updatedContent = JSON.stringify(sceneCollection, null, 2);
        
        // Write the updated content to both files
        await fs.promises.writeFile(sceneCollectionPath, updatedContent, 'utf-8');
        await fs.promises.writeFile(
            path.join(BASE_DIR, 'scene_config.json'),
            updatedContent,
            'utf-8'
        );

        console.log(`Auto-scene-switcher settings updated for "${sceneName}" with pattern: ${windowTitleRegex}`);
        
        // Restart OBS and reconnect
        sendStartOBS();
        
        // Wait for OBS to start before attempting to reconnect
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        try {
            await connectOBSWebSocket();
        } catch (reconnectError) {
            logObsError('Initial reconnection failed, OBS may still be starting up:', reconnectError);
            // Don't throw here - the getOBSConnection retry logic will handle it
        }
    } catch (error: any) {
        logObsError(`Error modifying auto-scene-switcher settings:`, error.message);
        
        // Attempt to restart OBS even if there was an error
        try {
            sendStartOBS();
        } catch (startError) {
            logObsError('Failed to restart OBS after error:', startError);
        }

        return;
    }
}

async function connectOBSWebSocket(
    retries = OBS_CONNECT_RETRY_COUNT,
    delay = OBS_CONNECT_RETRY_DELAY_MS
): Promise<void> {
    registerOBSLifecycleHandlers();

    if (await isOBSHealthy()) {
        return;
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
        refreshObsConfig();

        try {
            await withTimeout('OBS websocket connect', OBS_CONNECT_TIMEOUT_MS, () =>
                obs.connect(`ws://${obsConfig.host}:${obsConfig.port}`, obsConfig.password)
            );
            obsConnected = true;
            reconnectDelayMs = OBS_RECONNECT_MIN_DELAY_MS;
            clearReconnectTimer();

            if (!sceneSwitcherRegistered) {
                setOBSSceneSwitcherCallback();
                sceneSwitcherRegistered = true;
            }

            return;
        } catch (error) {
            lastError = error;
            obsConnected = false;

            if (isOBSTimeoutError(error)) {
                await resetOBSClient(`connect attempt ${attempt} timed out`);
            }

            logObsError(
                `[OBS] Connect attempt ${attempt}/${retries} failed: ${getObsErrorMessage(error)}`
            );

            if (attempt < retries) {
                await wait(delay * attempt);
            }
        }
    }

    logObsError(lastError ?? new Error('Unknown OBS connection failure'));
}

export async function getOBSConnection(): Promise<void> {
    registerOBSLifecycleHandlers();

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = (async () => {
        if (await isOBSHealthy()) {
            return;
        }

        try {
            await callOBS('GetVersion');
            obsConnected = true;
            reconnectDelayMs = OBS_RECONNECT_MIN_DELAY_MS;
            clearReconnectTimer();
            return;
        } catch (error) {
            obsConnected = false;
        }

        await connectOBSWebSocket();
    })()
        .catch((error) => {
            scheduleOBSReconnect('connection attempt failed');
            return;
        })
        .finally(() => {
            connectionPromise = null;
        });

    return connectionPromise;
}

export function isOBSConnected(): boolean {
    return obsConnected;
}

export let obsWindow: BrowserWindow | null = null;

export function openOBSWindow() {
    if (obsWindow) {
        obsWindow.show();
        obsWindow.focus();
        return;
    }

    obsWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
        },
    });

    obsWindow.loadFile(path.join(getAssetsDir(), 'home.html'));

    obsWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            obsWindow?.hide();
        } else {
            obsWindow = null;
        }
    });

    registerOBSIPC();
}

function setOBSSceneSwitcherCallback() {
    obs.on('CurrentProgramSceneChanged', (data) => {
        console.log(`Switched to OBS scene: ${data.sceneName}`);
    });
}

export async function registerOBSIPC() {
    ipcMain.handle('obs.launch', async () => {
        exec('obs', (error: any) => {
            if (error) {
                logObsError('Error launching OBS:', error);
            }
        });
    });

    ipcMain.handle('obs.saveReplay', async () => {
        try {
            await getOBSConnection();
            await callOBS('SaveReplayBuffer');
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error saving replay buffer:', error);
            }
        }
    });

    ipcMain.handle('obs.switchScene', async (_, sceneName) => {
        try {
            await getOBSConnection();
            await callOBS('SetCurrentProgramScene', { sceneName });
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error switching scene:', error);
            }
        }
    });

    ipcMain.handle('obs.switchScene.id', async (_, sceneUuid) => {
        try {
            await getOBSConnection();
            await callOBS('SetCurrentProgramScene', { sceneUuid });
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error switching scene:', error);
            }
        }
    });

    ipcMain.handle('obs.startRecording', async (_, windowName) => {
        try {
            await getOBSConnection();
            await callOBS('StartRecord');
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error starting recording:', error);
            }
        }
    });

    ipcMain.handle('obs.getScenes', async () => {
        try {
            await getOBSConnection();
            return await getOBSScenes();
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting scenes:', error);
            }
            return [];
        }
    });

    ipcMain.handle('obs.createScene', async (_, window) => {
        try {
            await createSceneWithCapture(window);
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error setting up scene capture:', error);
            }
        }
    });

    ipcMain.handle('obs.createScene.Game', async (_, window) => {
        try {
            await createSceneWithCapture(window);
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error setting up scene capture:', error);
            }
        }
    });

    ipcMain.handle(
        'obs.renameScene',
        async (
            _,
            payload: { sceneUuid?: string; newSceneName?: string } | null | undefined
        ) => {
            try {
                await renameOBSScene(payload?.sceneUuid ?? '', payload?.newSceneName ?? '');
            } catch (error) {
                if (!isOBSInitializingError(error)) {
                    logObsError('Error renaming scene:', error);
                }
            }
        }
    );

    ipcMain.handle('obs.removeScene', async (_, sceneUuid) => {
        try {
            const response = await dialog.showMessageBox(obsWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 1,
                title: 'Confirm Scene Removal',
                message: 'Are you sure you want to remove this scene?',
            });

            if (response.response === 0) {
                // User clicked 'Yes'
                await getOBSConnection();
                await callOBS('RemoveScene', { sceneUuid });
            }
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error removing scene:', error);
            }
        }
    });

    ipcMain.handle('obs.getActiveScene', async () => {
        try {
            return await getCurrentScene();
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting active scene:', error);
            }
            return null;
        }
    });

    ipcMain.handle('obs.getSceneActiveWindow', async () => {
        const currentScene = await getCurrentScene();
        try {
            return await getWindowTitleFromSource(currentScene.id);
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting active window from current scene:', error);
            }
            return null;
        }
    });

    ipcMain.handle('obs.getExecutableNameFromSource', async (_, obsSceneID: string) => {
        try {
            return await getExecutableNameFromSource(obsSceneID);
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting executable name from source:', error);
            }
            return null;
        }
    });

    ipcMain.handle('get_gsm_status', async () => {
        try {
            const texthookerPort =
                pythonConfig?.get('configs.Default.general.texthooker_port') || 7275;
            const response = await axios.get(`http://localhost:${texthookerPort}/get_status`);
            return response.data;
        } catch (error) {
            // console.error('Error fetching GSM status:', error);
            return null;
        }
    });

    ipcMain.handle('openOBS', async () => {
        sendStartOBS();
    });

    const inputPropertyItemsPromises = new Map<string, Promise<ObsDevicePropertyItem[]>>();

    async function ensureHelperSceneExists(): Promise<void> {
        try {
            await callOBS('GetSceneItemList', { sceneName: HELPER_SCENE });
        } catch (sceneError: any) {
            const sceneErrorMessage = getObsErrorMessage(sceneError);
            if (sceneErrorMessage.includes('No source was found')) {
                await callOBS('CreateScene', { sceneName: HELPER_SCENE });
            }
        }

        try {
            await callOBS('GetSceneItemList', { sceneName: OLD_HELPER_SCENE });
            await callOBS('RemoveScene', { sceneName: OLD_HELPER_SCENE });
        } catch {
            // Ignore stale helper scene cleanup failures.
        }
    }

    async function getInputPropertyItems(
        inputName: string,
        inputKind: string,
        propertyName: string,
        inputSettings: Record<string, unknown> = {}
    ): Promise<ObsDevicePropertyItem[]> {
        const requestKey = JSON.stringify([
            inputName,
            inputKind,
            propertyName,
            inputSettings,
        ]);
        const existingPromise = inputPropertyItemsPromises.get(requestKey);
        if (existingPromise) {
            return existingPromise;
        }

        const requestPromise = (async () => {
            try {
                await getOBSConnection();
                const response = await callOBS('GetInputPropertiesListPropertyItems', {
                    inputName,
                    propertyName,
                });
                return (response.propertyItems ?? []) as ObsDevicePropertyItem[];
            } catch (error: any) {
                const errorMessage = getObsErrorMessage(error);
                if (!errorMessage.includes('No source was found')) {
                    return [];
                }

                await ensureHelperSceneExists();
                await callOBS('CreateInput', {
                    sceneName: HELPER_SCENE,
                    inputName,
                    inputKind,
                    inputSettings,
                });

                const retryResponse = await callOBS('GetInputPropertiesListPropertyItems', {
                    inputName,
                    propertyName,
                });
                return (retryResponse.propertyItems ?? []) as ObsDevicePropertyItem[];
            }
        })();

        inputPropertyItemsPromises.set(requestKey, requestPromise);
        try {
            return await requestPromise;
        } finally {
            inputPropertyItemsPromises.delete(requestKey);
        }
    }

    async function getWindowsFromSource(
        sourceName: string,
        capture_mode: ObsCaptureMode
    ): Promise<ObsWindowPropertyItem[]> {
        const propertyItems = await getInputPropertyItems(
            sourceName,
            capture_mode,
            'window'
        );
        return propertyItems.map((item) => ({
            ...item,
            captureMode: capture_mode,
        }));
    }

    async function getLinuxXCompositeWindows(): Promise<ObsWindowOption[]> {
        const windowIds = await listLinuxX11WindowIds();
        const windows = await Promise.all(
            windowIds.map(async ({ xpropWindowId, obsWindowId }) => {
                const details = await getLinuxX11WindowDetails(xpropWindowId);
                if (!details) {
                    return null;
                }

                const itemValue = encodeLinuxXCompositeWindowValue(
                    obsWindowId,
                    details.title,
                    details.windowClass
                );
                const item = {
                    itemName: details.title,
                    itemValue,
                };

                if (shouldFilterWindow(item)) {
                    return null;
                }

                return {
                    title: details.title,
                    value: itemValue,
                    targetKind: 'window' as const,
                    captureValues: {
                        xcomposite_input: itemValue,
                    },
                };
            })
        );

        const windowsByValue = new Map<string, ObsWindowOption>();
        for (const window of windows) {
            if (!window) {
                continue;
            }
            windowsByValue.set(window.value, window);
        }

        return [...windowsByValue.values()].sort((left, right) =>
            left.title.localeCompare(right.title)
        );
    }

    async function getCaptureCardList(): Promise<ObsWindowOption[]> {
        const [videoDevices, directShowAudioDevices, wasapiInputDevices] =
            await Promise.all([
                getInputPropertyItems(
                    CAPTURE_CARD_GETTER_INPUT,
                    OBS_DSHOW_INPUT_KIND,
                    'video_device_id'
                ),
                getInputPropertyItems(
                    CAPTURE_CARD_GETTER_INPUT,
                    OBS_DSHOW_INPUT_KIND,
                    'audio_device_id'
                ),
                getInputPropertyItems(
                    AUDIO_INPUT_GETTER_INPUT,
                    OBS_WASAPI_INPUT_CAPTURE_KIND,
                    'device_id',
                    { device_id: 'default' }
                ),
            ]);

        return buildCaptureCardOptions(
            videoDevices,
            directShowAudioDevices,
            wasapiInputDevices.filter(
                (device) => device.itemValue !== 'default'
            )
        );
    }

    async function getWindowList(): Promise<ObsWindowOption[]> {
        try {
            if (isLinux()) {
                return await getLinuxXCompositeWindows();
            }

            const [windowCaptureWindows, gameCaptureWindows, captureCards] =
                await Promise.all([
                    getWindowsFromSource(WINDOW_GETTER_INPUT, 'window_capture'),
                    getWindowsFromSource(GAME_WINDOW_INPUT, 'game_capture'),
                    getCaptureCardList(),
                ]);
            const allWindows = [...windowCaptureWindows, ...gameCaptureWindows].filter(
                (item) => !shouldFilterWindow(item)
            );
            return [...mergeObsWindowItems(allWindows), ...captureCards].sort((left, right) =>
                left.title.localeCompare(right.title)
            );
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting window list:', error);
            }
            return [];
        }
    }

    ipcMain.handle('obs.getWindows', async () => {
        try {
            if (!isWindows() && !isLinux()) {
                return [];
            }
            await getOBSConnection();
            return await getWindowList();
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting windows:', error);
            }
            return [];
        }
    });

    void getOBSConnection().catch((error) => {
        logObsError(
            `[OBS] Initial OBS connection attempt failed: ${getObsErrorMessage(error)}`
        );
    });
}

export async function getExecutableNameFromSource(
    obsSceneID: string
): Promise<string | undefined | null> {
    try {
        await getOBSConnection();

        // Get the list of scene items for the given scene
        const sceneItems = await callOBS('GetSceneItemList', { sceneUuid: obsSceneID });
        const candidateItems = sceneItems.sceneItems.filter(isVideoCaptureSceneItem);

        // Find the first input source with a window property
        for (const item of candidateItems.length ? candidateItems : sceneItems.sceneItems) {
            const inputProperties = await callOBS('GetInputSettings', {
                inputUuid: item.sourceUuid as string,
            });
            if (inputProperties.inputSettings?.window) {
                const windowValue = inputProperties.inputSettings.window as string;

                return windowValue.split(':').at(-1)?.trim();
            }

            if (inputProperties.inputSettings?.capture_window) {
                const captureWindowValue = inputProperties.inputSettings
                    .capture_window as string;

                return parseLinuxXCompositeWindowValue(captureWindowValue).windowClass || null;
            }
        }

        return null;
    } catch (error: any) {
        logObsError(
            `Error getting executable name from source in scene "${obsSceneID}":`,
            error.message
        );
        return null;
    }
}

export async function getWindowTitleFromSource(
    obsSceneID: string
): Promise<string | undefined | null> {
    try {
        await getOBSConnection();

        // Get the list of scene items for the given scene
        const sceneItems = await callOBS('GetSceneItemList', { sceneUuid: obsSceneID });
        const candidateItems = sceneItems.sceneItems.filter(isVideoCaptureSceneItem);

        // Find the first input source with a window property
        for (const item of candidateItems.length ? candidateItems : sceneItems.sceneItems) {
            const inputProperties = await callOBS('GetInputSettings', {
                inputUuid: item.sourceUuid as string,
            });

            if (inputProperties.inputSettings?.window) {
                const windowValue = inputProperties.inputSettings.window as string;

                // Try to fetch the live window list for this input to get the current title
                try {
                    const propertyItemsResponse = await callOBS('GetInputPropertiesListPropertyItems', {
                        inputName: item.sourceName as string,
                        propertyName: 'window',
                    });

                    const match = propertyItemsResponse.propertyItems?.find(
                        (prop: any) => prop.itemValue === windowValue
                    );

                    if (match?.itemName) {
                        const parsedTitle = (match.itemName as string)
                            .split(':')
                            .slice(1)
                            .join(':')
                            .trim();
                        if (parsedTitle) return parsedTitle;
                    }
                } catch (propErr: any) {
                    // If fetching live properties fails, fall back to stored value
                    logObsError(
                        `Warning: Could not fetch live window title for source "${item.sourceName}":`,
                        propErr?.message ?? propErr
                    );
                }

                // Fallback to the stored (possibly stale) window title
                return windowValue.split(':').at(0)?.trim();
            }

            if (inputProperties.inputSettings?.capture_window) {
                const captureWindowValue = inputProperties.inputSettings
                    .capture_window as string;
                return parseLinuxXCompositeWindowValue(captureWindowValue).title || null;
            }
        }

        return null;
    } catch (error: any) {
        logObsError(
            `Error getting window title from source in scene "${obsSceneID}":`,
            error.message
        );
        return null;
    }
}

function getScreenshotPayload(imageData: string): string {
    const trimmed = imageData.trim();
    const delimiterIndex = trimmed.indexOf(',');
    return delimiterIndex >= 0 ? trimmed.slice(delimiterIndex + 1) : trimmed;
}

function getPngBytesPerPixel(colorType: number): number {
    switch (colorType) {
        case 0:
            return 1;
        case 2:
            return 3;
        case 6:
            return 4;
        default:
            return 0;
    }
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
    const initial = left + above - upperLeft;
    const leftDistance = Math.abs(initial - left);
    const aboveDistance = Math.abs(initial - above);
    const upperLeftDistance = Math.abs(initial - upperLeft);

    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
        return left;
    }
    if (aboveDistance <= upperLeftDistance) {
        return above;
    }
    return upperLeft;
}

function isPngPayloadEffectivelyEmpty(payload: string): boolean {
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return payload.length < 32;
    }

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlaceMethod = 0;
    const idatChunks: Buffer[] = [];

    for (let offset = 8; offset + 8 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) {
            break;
        }

        if (type === 'IHDR') {
            width = bytes.readUInt32BE(dataStart);
            height = bytes.readUInt32BE(dataStart + 4);
            bitDepth = bytes[dataStart + 8];
            colorType = bytes[dataStart + 9];
            interlaceMethod = bytes[dataStart + 12];
        } else if (type === 'IDAT') {
            idatChunks.push(bytes.subarray(dataStart, dataEnd));
        } else if (type === 'IEND') {
            break;
        }

        offset = dataEnd + 4;
    }

    const bytesPerPixel = getPngBytesPerPixel(colorType);
    if (
        width <= 0 ||
        height <= 0 ||
        bitDepth !== 8 ||
        interlaceMethod !== 0 ||
        bytesPerPixel === 0 ||
        idatChunks.length === 0
    ) {
        return payload.length < 32;
    }

    const inflated = inflateSync(Buffer.concat(idatChunks));
    const stride = width * bytesPerPixel;
    const expectedLength = height * (stride + 1);
    if (inflated.length < expectedLength) {
        return payload.length < 32;
    }

    const previousRow = Buffer.alloc(stride);
    const currentRow = Buffer.alloc(stride);
    let firstPixel: number[] | null = null;

    for (let row = 0; row < height; row += 1) {
        const rowOffset = row * (stride + 1);
        const filterType = inflated[rowOffset];

        for (let column = 0; column < stride; column += 1) {
            const raw = inflated[rowOffset + 1 + column];
            const left = column >= bytesPerPixel ? currentRow[column - bytesPerPixel] : 0;
            const above = previousRow[column];
            const upperLeft =
                column >= bytesPerPixel ? previousRow[column - bytesPerPixel] : 0;

            let value = raw;
            switch (filterType) {
                case 0:
                    break;
                case 1:
                    value = (raw + left) & 0xff;
                    break;
                case 2:
                    value = (raw + above) & 0xff;
                    break;
                case 3:
                    value = (raw + Math.floor((left + above) / 2)) & 0xff;
                    break;
                case 4:
                    value = (raw + paethPredictor(left, above, upperLeft)) & 0xff;
                    break;
                default:
                    return payload.length < 32;
            }

            currentRow[column] = value;
        }

        for (let column = 0; column < stride; column += bytesPerPixel) {
            const pixel = Array.from(currentRow.subarray(column, column + bytesPerPixel));
            if (firstPixel === null) {
                firstPixel = pixel;
                continue;
            }

            if (pixel.some((channel, index) => channel !== firstPixel?.[index])) {
                return false;
            }
        }

        currentRow.copy(previousRow);
    }

    return true;
}

function isScreenshotImageDataEffectivelyEmpty(imageData: string): boolean {
    if (typeof imageData !== 'string' || imageData.trim().length === 0) {
        return true;
    }

    try {
        return isPngPayloadEffectivelyEmpty(getScreenshotPayload(imageData));
    } catch {
        return getScreenshotPayload(imageData).length < 32;
    }
}

export async function sceneHasVisibleOutput(
    scene: Pick<ObsScene, 'name'>
): Promise<boolean | null> {
    const sceneName = scene.name?.trim();
    if (!sceneName || sceneName.toLowerCase() === HELPER_SCENE.toLowerCase()) {
        return null;
    }

    try {
        await getOBSConnection();
        const response = await callOBS('GetSourceScreenshot', {
            sourceName: sceneName,
            imageFormat: 'png',
            imageWidth: OBS_OUTPUT_PROBE_WIDTH,
            imageHeight: OBS_OUTPUT_PROBE_HEIGHT,
        });
        if (!response?.imageData) {
            return null;
        }

        return !isScreenshotImageDataEffectivelyEmpty(response.imageData);
    } catch (error: any) {
        logObsError(`Error probing scene output for "${sceneName}":`, error?.message ?? error);
        return null;
    }
}

export async function setOBSScene(sceneName: string): Promise<void> {
    try {
    await getOBSConnection();
    await callOBS('SetCurrentProgramScene', { sceneName });
    } catch (error: any) {
        logObsError(`Error setting OBS scene to "${sceneName}":`, error.message);
        return;
    }
}

export async function renameOBSScene(
    sceneUuid: string,
    newSceneName: string
): Promise<void> {
    const trimmedSceneUuid = sceneUuid.trim();
    const trimmedNewSceneName = newSceneName.trim();

    if (!trimmedSceneUuid || !trimmedNewSceneName) {
        return;
    }

    try {
        await getOBSConnection();
        await callOBS('SetSceneName', {
            sceneUuid: trimmedSceneUuid,
            newSceneName: trimmedNewSceneName,
        });
    } catch (error: any) {
        logObsError(
            `Error renaming OBS scene "${trimmedSceneUuid}" to "${trimmedNewSceneName}":`,
            error.message
        );
        return;
    }
}

export async function getOBSScenes(): Promise<ObsScene[]> {
    try {
        const { scenes } = await callOBS('GetSceneList');
        return scenes
            .filter((scene: any) => scene.sceneName.toLowerCase() !== HELPER_SCENE.toLowerCase())
            .map((scene: any) => ({ name: scene.sceneName, id: scene.sceneUuid } as ObsScene));
    } catch (error) {
        logObsError('Error getting OBS scene list:', error);
        return [];
    }
}

export async function getCurrentScene(): Promise<ObsScene> {
    try {
        await getOBSConnection();
        const response = await callOBS('GetCurrentProgramScene');
        return { name: response.sceneName, id: response.sceneUuid };
    } catch (error) {
        logObsError('Error getting current OBS scene:', error);
        return { name: '', id: '' };
    }
}
