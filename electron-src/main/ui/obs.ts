// electron-src/main/launchers/obs.ts
import { BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import {
    BASE_DIR,
    execFileAsync,
    getAssetsDir,
    isLinux,
    isMacOS,
    isWindows,
    isWindows10OrHigher,
} from '../util.js';
import { isQuitting } from '../main.js';
import { spawn, type ChildProcess } from 'child_process';
import OBSWebSocket from 'obs-websocket-js';
import Store from 'electron-store';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { homedir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { sendStartOBS } from '../main.js';
import axios from 'axios';
import extract from 'extract-zip';
import { installSessionManager } from '../services/install_session_state.js';
import type {
    InstallProgressKind,
    InstallStageStatus,
} from '../../shared/install_session.js';
import {
    OBS_BROWSER_CEF_FILES,
    OBS_DEFAULT_SCENE_JSON,
    buildObsGlobalIni,
    buildObsReplayBufferProfileIni,
    packObsVersion,
} from './obs_default_config.js';
import {
    OBS_DSHOW_INPUT_KIND,
    OBS_WASAPI_INPUT_CAPTURE_KIND,
    buildCaptureCardOptions,
    buildLinuxSceneCaptureInputs,
    getObsWindowTitle,
    buildWindowsSceneCaptureInputs,
    buildWindowsVideoCaptureInput,
    mergeObsWindowItems,
    type ObsCaptureMode,
    type ObsDevicePropertyItem,
    type ObsSceneCaptureInput,
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

export interface ObsScenePreviewSnapshot {
    sceneName: string;
    sceneId: string;
    sourceName: string | null;
    captureMode: ObsCaptureMode | null;
    imageData: string | null;
}

const OBS_OUTPUT_PROBE_WIDTH = 8;
const OBS_OUTPUT_PROBE_HEIGHT = 8;
const OBS_PREVIEW_SCREENSHOT_WIDTH = 960;
const OBS_PREVIEW_SCREENSHOT_HEIGHT = 540;

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
    { titlePattern: /^Desktop @ QRect/i },
    { titlePattern: "(null)" },

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
    port: 7274, // OBS_DEFAULT_WEBSOCKET_PORT (declared below); overlaid at connect time.
    password: '',
};

const OBS_CONFIG_PATH = path.join(BASE_DIR, 'obs-studio');
const SCENE_CONFIG_PATH = path.join(OBS_CONFIG_PATH, 'config', 'obs-studio', 'basic', 'scenes');
const AUTO_SCENE_SWITCHER_MODULE_NAME = 'auto-scene-switcher';
let obs = new OBSWebSocket();
let obsConnected = false;
const OLD_HELPER_SCENE = "GSM Helper";
const HELPER_SCENE = 'GSM Helper - DONT TOUCH';
const WINDOW_GETTER_INPUT = 'window_getter';
const GAME_WINDOW_INPUT = 'game_window_getter';
const CAPTURE_CARD_GETTER_INPUT = 'capture_card_getter';
const AUDIO_INPUT_GETTER_INPUT = 'audio_input_getter';
const HELPER_INPUT_NAMES = new Set([
    WINDOW_GETTER_INPUT,
    GAME_WINDOW_INPUT,
    CAPTURE_CARD_GETTER_INPUT,
    AUDIO_INPUT_GETTER_INPUT,
]);
const CAPTURE_CARD_HELPER_INPUT_NAMES = new Set([
    CAPTURE_CARD_GETTER_INPUT,
    AUDIO_INPUT_GETTER_INPUT,
]);
let sceneSwitcherRegistered = false;
let captureCardProbeEnabled = false;
let captureCardProbeInputsSynced = false;

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
const OBS_HEARTBEAT_INTERVAL_MS = 30000;
const OBS_CALL_TIMEOUT_MS = 7000;
const OBS_CONNECT_TIMEOUT_MS = 10000;
const OBS_DISCONNECT_TIMEOUT_MS = 3000;
const OBS_SCENE_SWITCHER_PRE_QUIT_DELAY_MS = 250;
const OBS_SCENE_SWITCHER_SHUTDOWN_DELAY_MS = 1000;
const VIDEO_CAPTURE_INPUT_KINDS = new Set([
    'window_capture',
    'game_capture',
    'monitor_capture',
    'xcomposite_input',
]);
const OBS_PID_FILE = path.join(BASE_DIR, 'obs_pid.txt');

type ElectronOBSProcessStatus =
    | 'idle'
    | 'launched'
    | 'already-running'
    | 'skipped'
    | 'missing'
    | 'failed'
    | 'closed'
    | 'not-running';

interface ElectronOBSProcessResult {
    status: Exclude<ElectronOBSProcessStatus, 'idle'>;
    pid?: number;
    error?: string;
}

interface ElectronOBSProcessOptions {
    forceRestart?: boolean;
    ignoreOpenConfig?: boolean;
    ignoreCloseConfig?: boolean;
    allowPathFallback?: boolean;
    reason?: string;
}

interface ElectronOBSStartupConfig {
    openObs: boolean;
    closeObs: boolean;
    allowAutomaticUpdates: boolean;
    disableRecording: boolean;
    obsPath: string;
    port: number;
    password: string;
}

interface OBSLaunchCommand {
    command: string;
    args: string[];
    cwd?: string;
}

let electronOBSLaunchPromise: Promise<ElectronOBSProcessResult> | null = null;
let electronOBSLaunchStatus: ElectronOBSProcessStatus = 'idle';
let electronOBSProcess: ChildProcess | null = null;

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
    if (obsWindow) {
        return obsWindow;
    }

    const maybeGetFocusedWindow = (BrowserWindow as typeof BrowserWindow & {
        getFocusedWindow?: () => BrowserWindow | null;
    }).getFocusedWindow;

    return typeof maybeGetFocusedWindow === 'function'
        ? maybeGetFocusedWindow() ?? undefined
        : undefined;
}

function getSceneCollectionPath(sceneCollectionName: string): string {
    return path.join(SCENE_CONFIG_PATH, `${sceneCollectionName}.json`.replace(/ /g, '_'));
}

function getOrCreateAutoSceneSwitcherModule(
    sceneCollection: Record<string, any>
): Record<string, any> {
    if (!sceneCollection.modules || typeof sceneCollection.modules !== 'object') {
        sceneCollection.modules = {};
    }

    if (
        !sceneCollection.modules[AUTO_SCENE_SWITCHER_MODULE_NAME] ||
        typeof sceneCollection.modules[AUTO_SCENE_SWITCHER_MODULE_NAME] !== 'object'
    ) {
        sceneCollection.modules[AUTO_SCENE_SWITCHER_MODULE_NAME] = {
            interval: 300,
            non_matching_scene: '',
            switch_if_not_matching: false,
            active: true,
            switches: [],
        };
    }

    const autoSceneSwitcher = sceneCollection.modules[
        AUTO_SCENE_SWITCHER_MODULE_NAME
    ] as Record<string, any>;

    if (!Array.isArray(autoSceneSwitcher.switches)) {
        autoSceneSwitcher.switches = [];
    }

    return autoSceneSwitcher;
}

function upsertAutoSceneSwitcherRule(
    autoSceneSwitcher: Record<string, any>,
    sceneName: string,
    windowTitleRegex: string
): void {
    const switchEntry = {
        scene: sceneName,
        window_title: windowTitleRegex,
    };
    const existingSwitchIndex = autoSceneSwitcher.switches.findIndex(
        (candidate: any) => candidate?.scene === sceneName
    );

    if (existingSwitchIndex >= 0) {
        autoSceneSwitcher.switches[existingSwitchIndex] = switchEntry;
        return;
    }

    autoSceneSwitcher.switches.push(switchEntry);
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
    const base = (pythonConfig?.get('configs.Default.obs') as ObsConfig) || {
        host: 'localhost',
        port: OBS_DEFAULT_WEBSOCKET_PORT,
        password: '',
    };
    obsConfig = { ...base, host: base.host || 'localhost' };

    // When GSM manages the bundled portable OBS (Windows-only), its
    // websocket config.json holds the port we chose for this launch (7274 or
    // an ephemeral fallback). Trust it over the stored config so a dynamic port
    // is picked up automatically. System OBS on macOS/Linux reads its own
    // config dir, so leave its configured port alone there.
    if (isWindows() && getElectronOBSStartupConfig().openObs) {
        const server = readObsWebSocketServerConfig();
        if (server) {
            obsConfig.port = server.port;
            if (!base.password || base.password === 'your_password') {
                obsConfig.password = server.password;
            }
        }
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferOBSLaunchWork(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function getDefaultOBSExecutablePath(): string {
    if (isWindows()) {
        return path.join(BASE_DIR, 'obs-studio', 'bin', '64bit', 'obs64.exe');
    }
    if (isMacOS()) {
        return '/opt/homebrew/bin/obs';
    }
    return '/usr/bin/obs';
}

function getCurrentProfileConfig(config: any): any {
    if (!config || typeof config !== 'object') {
        return {};
    }

    const configs = config.configs;
    if (configs && typeof configs === 'object') {
        const currentProfile =
            typeof config.current_profile === 'string' && config.current_profile
                ? config.current_profile
                : 'Default';
        return configs[currentProfile] ?? configs.Default ?? {};
    }

    return config;
}

function coercePort(value: unknown, fallback: number): number {
    const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(port) && port > 0 ? port : fallback;
}

// Preferred OBS websocket port. Kept as the default so existing setups are
// unaffected, but we fall back into the ephemeral range when it is taken.
const OBS_DEFAULT_WEBSOCKET_PORT = 7274;
const OBS_EPHEMERAL_PORT_MIN = 49152;
const OBS_EPHEMERAL_PORT_MAX = 65535;

// True if nothing is currently bound to the port on loopback (i.e. OBS can take
// it). A failure to bind (EADDRINUSE/EACCES) means the port is unavailable.
function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });
        tester.listen(port, '127.0.0.1');
    });
}

// Ask the OS for a free ephemeral port by binding to 0 and reading it back.
function getOSAssignedPort(): Promise<number | null> {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(null));
        tester.listen(0, '127.0.0.1', () => {
            const address = tester.address();
            const port =
                address && typeof address === 'object' ? address.port : null;
            tester.close(() => resolve(port));
        });
    });
}

/**
 * Resolve the OBS websocket port to bind this launch: prefer the configured
 * port (7274 by default), and only when it is already taken fall back to a
 * free port in the ephemeral range. The chosen port is written into OBS's own
 * websocket config.json before launch, which both Electron (refreshObsConfig)
 * and the Python backend (get_obs_websocket_config_values) read back, so the
 * whole stack stays in sync without a hard-coded port.
 */
async function resolveObsWebSocketPort(preferredPort: number): Promise<number> {
    if (await isPortAvailable(preferredPort)) {
        return preferredPort;
    }

    for (let attempt = 0; attempt < 20; attempt++) {
        const candidate =
            OBS_EPHEMERAL_PORT_MIN +
            Math.floor(
                Math.random() * (OBS_EPHEMERAL_PORT_MAX - OBS_EPHEMERAL_PORT_MIN + 1)
            );
        if (await isPortAvailable(candidate)) {
            return candidate;
        }
    }

    const osPort = await getOSAssignedPort();
    return osPort ?? preferredPort;
}

export function getElectronOBSStartupConfig(): ElectronOBSStartupConfig {
    const fallbackObsPath = getDefaultOBSExecutablePath();
    const configPath = path.join(BASE_DIR, 'config.json');
    let obsConfigFromDisk: any = {};

    if (fs.existsSync(configPath)) {
        try {
            const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const profileConfig = getCurrentProfileConfig(rawConfig);
            obsConfigFromDisk =
                profileConfig && typeof profileConfig === 'object'
                    ? profileConfig.obs ?? {}
                    : {};
        } catch (error) {
            logObsError('Failed to read OBS startup config:', error);
        }
    }

    const configuredObsPath =
        typeof obsConfigFromDisk.obs_path === 'string' && obsConfigFromDisk.obs_path.trim()
            ? obsConfigFromDisk.obs_path.trim()
            : fallbackObsPath;

    return {
        openObs: obsConfigFromDisk.open_obs !== false,
        closeObs: obsConfigFromDisk.close_obs !== false,
        allowAutomaticUpdates: obsConfigFromDisk.allow_automatic_updates === true,
        disableRecording: obsConfigFromDisk.disable_recording === true,
        obsPath: configuredObsPath,
        port: coercePort(obsConfigFromDisk.port, OBS_DEFAULT_WEBSOCKET_PORT),
        password:
            typeof obsConfigFromDisk.password === 'string'
                ? obsConfigFromDisk.password
                : 'your_password',
    };
}

function splitCommandLine(value: string): string[] {
    const matches = value.match(/"([^"]*)"|'([^']*)'|[^\s]+/g) ?? [];
    return matches.map((part) => {
        if (
            (part.startsWith('"') && part.endsWith('"')) ||
            (part.startsWith("'") && part.endsWith("'"))
        ) {
            return part.slice(1, -1);
        }
        return part;
    });
}

function commandLooksLikePath(command: string): boolean {
    return (
        path.isAbsolute(command) ||
        command.includes('/') ||
        command.includes('\\') ||
        command.toLowerCase().endsWith('.exe')
    );
}

export function resolveElectronOBSLaunchCommand(obsPath: string): OBSLaunchCommand | null {
    if (!obsPath.trim()) {
        return null;
    }

    if (fs.existsSync(obsPath)) {
        return {
            command: obsPath,
            args: [],
            cwd: path.dirname(obsPath),
        };
    }

    const parts = splitCommandLine(obsPath);
    if (parts.length === 0) {
        return null;
    }

    const [command, ...args] = parts;
    if (fs.existsSync(command)) {
        return {
            command,
            args,
            cwd: path.dirname(command),
        };
    }

    if (commandLooksLikePath(command)) {
        return null;
    }

    return { command, args };
}

function removeOBSStartupArtifact(targetPath: string): void {
    if (!fs.existsSync(targetPath)) {
        return;
    }

    try {
        fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (error) {
        logObsError(`Failed to delete OBS startup artifact ${targetPath}:`, error);
    }
}

function cleanupOBSStartupArtifacts(): void {
    const baseConfigDir = path.join(BASE_DIR, 'obs-studio', 'config', 'obs-studio');
    removeOBSStartupArtifact(path.join(baseConfigDir, '.sentinel'));
    removeOBSStartupArtifact(
        path.join(
            baseConfigDir,
            'plugin_config',
            'advanced-scene-switcher',
            '.running'
        )
    );
}

function getObsWebSocketConfigPath(): string {
    return path.join(
        BASE_DIR,
        'obs-studio',
        'config',
        'obs-studio',
        'plugin_config',
        'obs-websocket',
        'config.json'
    );
}

// Read the port/password OBS is actually configured to serve. This is the
// source of truth once we've written a (possibly dynamic) port for this launch.
function readObsWebSocketServerConfig(): { port: number; password: string } | null {
    const websocketConfigPath = getObsWebSocketConfigPath();
    try {
        if (!fs.existsSync(websocketConfigPath)) {
            return null;
        }
        const raw = JSON.parse(fs.readFileSync(websocketConfigPath, 'utf-8'));
        const port = coercePort(raw?.server_port, 0);
        if (!port) {
            return null;
        }
        return {
            port,
            password:
                typeof raw?.server_password === 'string' ? raw.server_password : '',
        };
    } catch {
        return null;
    }
}

function writeElectronOBSWebSocketConfig(config: ElectronOBSStartupConfig): void {
    const websocketConfigPath = getObsWebSocketConfigPath();
    const websocketConfigDir = path.dirname(websocketConfigPath);

    try {
        fs.mkdirSync(websocketConfigDir, { recursive: true });

        let existingConfig: Record<string, unknown> = {};
        if (fs.existsSync(websocketConfigPath)) {
            try {
                existingConfig = JSON.parse(fs.readFileSync(websocketConfigPath, 'utf-8'));
            } catch {
                existingConfig = {};
            }
        }

        const nextConfig = {
            alerts_enabled: false,
            first_load: false,
            ...existingConfig,
            auth_required: false,
            server_enabled: true,
            server_password:
                typeof existingConfig.server_password === 'string'
                    ? existingConfig.server_password
                    : config.password,
            server_port: config.port,
        };

        fs.writeFileSync(websocketConfigPath, JSON.stringify(nextConfig, null, 4), 'utf-8');
    } catch (error) {
        logObsError('Failed to write OBS websocket startup config:', error);
    }
}

// -------------------------------------------------------------------------
// ELECTRON-MANAGED OBS DOWNLOAD
// -------------------------------------------------------------------------
// Electron owns downloading + seeding the bundled portable OBS so that the
// process that fetches OBS is also the one that launches it — no cross-process
// "OBS is ready" handshake with the Python backend. The Python downloader
// remains as a fallback for standalone (non-Electron) runs.

const OBS_LATEST_RELEASE_API =
    'https://api.github.com/repos/obsproject/obs-studio/releases/latest';
const OBS_DOWNLOAD_ARCHIVE_PATH = path.join(BASE_DIR, 'downloads', 'OBS.zip');

type ObsEnsureStatus = 'already-installed' | 'installed' | 'unsupported' | 'failed';

interface ObsGithubAsset {
    name?: string;
    browser_download_url?: string;
}

interface ObsGithubRelease {
    tag_name?: string;
    assets?: ObsGithubAsset[];
}

let obsEnsurePromise: Promise<ObsEnsureStatus> | null = null;

function reportObsInstallStage(
    status: InstallStageStatus,
    progressKind: InstallProgressKind,
    progress: number | null,
    message: string,
    extras?: {
        downloadedBytes?: number | null;
        totalBytes?: number | null;
        error?: string | null;
    }
): void {
    // No-ops when there is no active install session, so this is safe to call
    // on every launch (e.g. a normal startup where OBS is already present).
    installSessionManager.updateStage({
        stageId: 'obs',
        status,
        progressKind,
        progress,
        message,
        downloadedBytes: extras?.downloadedBytes,
        totalBytes: extras?.totalBytes,
        error: extras?.error,
    });
}

function isObsInstalled(): boolean {
    return fs.existsSync(getDefaultOBSExecutablePath());
}

async function fetchLatestObsRelease(): Promise<ObsGithubRelease | null> {
    try {
        const response = await axios.get<ObsGithubRelease>(OBS_LATEST_RELEASE_API, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'GameSentenceMiner',
            },
            timeout: 20000,
        });
        return response.data ?? null;
    } catch (error) {
        console.warn('Failed to fetch latest OBS release info:', error);
        return null;
    }
}

function pickWindowsObsAssetUrl(release: ObsGithubRelease): string | null {
    const suffix = process.arch === 'arm64' ? 'Windows-arm64.zip' : 'Windows-x64.zip';
    const match = (release.assets ?? []).find((asset) =>
        asset.name?.endsWith(suffix)
    );
    return match?.browser_download_url ?? null;
}

async function downloadObsArchive(url: string, destPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tempPath = `${destPath}.download`;
    if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
    }

    const totalHeader = response.headers.get('content-length');
    const totalBytes = totalHeader ? Number.parseInt(totalHeader, 10) : null;
    const body = response.body as ReadableStream<Uint8Array> | null;

    if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        const chunks: Buffer[] = [];
        let downloaded = 0;
        let lastReportMs = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const chunk = Buffer.from(value);
            chunks.push(chunk);
            downloaded += chunk.length;
            const now = Date.now();
            if (now - lastReportMs > 250) {
                lastReportMs = now;
                reportObsInstallStage(
                    'running',
                    'bytes',
                    totalBytes ? downloaded / totalBytes : null,
                    'Downloading OBS Studio...',
                    { downloadedBytes: downloaded, totalBytes }
                );
            }
        }
        fs.writeFileSync(tempPath, Buffer.concat(chunks));
    } else {
        fs.writeFileSync(tempPath, Buffer.from(await response.arrayBuffer()));
    }

    if (fs.existsSync(destPath)) {
        fs.rmSync(destPath, { force: true });
    }
    fs.renameSync(tempPath, destPath);
}

/**
 * Seed the bundled portable OBS config (websocket server, GSM profile, default
 * scene collection, first-run-skip global/user.ini). Mirrors write_obs_configs
 * in download_tools.py. Every writer is guarded by skip-if-exists so an existing
 * user-configured OBS is never overwritten.
 */
function writeObsSeedConfigs(packedVersion: number | null): void {
    const obsStudioConfigDir = path.join(OBS_CONFIG_PATH, 'config', 'obs-studio');
    fs.mkdirSync(obsStudioConfigDir, { recursive: true });

    // global.ini / user.ini — skips the first-run wizard and boots into GSM profile.
    const globalIni = buildObsGlobalIni(packedVersion);
    for (const fileName of ['user.ini', 'global.ini']) {
        const target = path.join(obsStudioConfigDir, fileName);
        if (!fs.existsSync(target)) {
            fs.writeFileSync(target, globalIni, 'utf-8');
        }
    }

    // Replay-buffer profiles (GSM + Untitled).
    const profileIni = buildObsReplayBufferProfileIni(
        `${homedir()}/Videos/GSM`
    );
    for (const profileName of ['GSM', 'Untitled']) {
        const profileDir = path.join(
            obsStudioConfigDir,
            'basic',
            'profiles',
            profileName
        );
        const target = path.join(profileDir, 'basic.ini');
        if (!fs.existsSync(target)) {
            fs.mkdirSync(profileDir, { recursive: true });
            fs.writeFileSync(target, profileIni, 'utf-8');
        }
    }

    // Default "Untitled" scene collection with GSM helper + capture probes.
    fs.mkdirSync(SCENE_CONFIG_PATH, { recursive: true });
    const sceneTarget = path.join(SCENE_CONFIG_PATH, 'Untitled.json');
    if (!fs.existsSync(sceneTarget)) {
        fs.writeFileSync(sceneTarget, OBS_DEFAULT_SCENE_JSON, 'utf-8');
    }

    // WebSocket server config (reuses the existing writer).
    writeElectronOBSWebSocketConfig(getElectronOBSStartupConfig());
}

/**
 * Trim a downloaded OBS install down to what GSM uses: drop all *.pdb debug
 * symbols and the obs-browser CEF runtime (~275MB). Mirrors prune_obs_directory
 * in download_tools.py.
 */
function pruneObsDirectory(): void {
    let removedBytes = 0;

    const rmFile = (target: string): void => {
        try {
            removedBytes += fs.statSync(target).size;
            fs.rmSync(target, { force: true });
        } catch {
            // Best-effort cleanup only.
        }
    };

    const rmTree = (target: string): void => {
        try {
            if (!fs.statSync(target).isDirectory()) {
                return;
            }
        } catch {
            return;
        }
        fs.rmSync(target, { recursive: true, force: true });
    };

    const walkFiles = (dir: string, onFile: (file: string) => void): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkFiles(full, onFile);
            } else {
                onFile(full);
            }
        }
    };

    // Debug symbols, everywhere.
    walkFiles(OBS_CONFIG_PATH, (file) => {
        if (file.toLowerCase().endsWith('.pdb')) {
            rmFile(file);
        }
    });

    // obs-browser plugin + its CEF runtime.
    const plugins64bit = path.join(OBS_CONFIG_PATH, 'obs-plugins', '64bit');
    try {
        for (const name of fs.readdirSync(plugins64bit)) {
            if (OBS_BROWSER_CEF_FILES.has(name.toLowerCase())) {
                rmFile(path.join(plugins64bit, name));
            }
        }
    } catch {
        // No plugins dir; nothing to prune.
    }
    rmTree(path.join(plugins64bit, 'locales'));
    rmTree(path.join(OBS_CONFIG_PATH, 'data', 'obs-plugins', 'obs-browser'));

    if (removedBytes > 0) {
        console.log(
            `Pruned OBS install, freed ${Math.round(removedBytes / (1024 * 1024))} MB.`
        );
    }
}

async function ensureObsInstalledInternal(): Promise<ObsEnsureStatus> {
    // Electron-managed OBS download is Windows-only; macOS/Linux use system OBS.
    if (!isWindows()) {
        return 'unsupported';
    }

    if (isObsInstalled()) {
        // Existing install: keep configs seeded and trim dead weight, but never
        // re-download.
        try {
            writeObsSeedConfigs(packObsVersion(null));
            pruneObsDirectory();
        } catch (error) {
            console.warn('Failed to refresh existing OBS install:', error);
        }
        return 'already-installed';
    }

    reportObsInstallStage(
        'running',
        'indeterminate',
        0.05,
        'Checking OBS runtime files...'
    );

    const release = await fetchLatestObsRelease();
    const downloadUrl = release ? pickWindowsObsAssetUrl(release) : null;
    if (!downloadUrl) {
        const message = 'Could not find an OBS download for this platform.';
        reportObsInstallStage('failed', 'indeterminate', null, message, {
            error: message,
        });
        console.warn(message);
        return 'failed';
    }

    try {
        reportObsInstallStage('running', 'bytes', 0, 'Downloading OBS Studio...');
        await downloadObsArchive(downloadUrl, OBS_DOWNLOAD_ARCHIVE_PATH);

        reportObsInstallStage(
            'running',
            'estimated',
            0.9,
            'Extracting OBS Studio...'
        );
        fs.mkdirSync(OBS_CONFIG_PATH, { recursive: true });
        await extract(OBS_DOWNLOAD_ARCHIVE_PATH, {
            dir: path.resolve(OBS_CONFIG_PATH),
        });

        // portable_mode marker so OBS uses the bundled config dir.
        fs.writeFileSync(path.join(OBS_CONFIG_PATH, 'portable_mode'), '', 'utf-8');

        reportObsInstallStage('running', 'estimated', 0.96, 'Configuring OBS...');
        writeObsSeedConfigs(packObsVersion(release?.tag_name));
        pruneObsDirectory();

        reportObsInstallStage(
            'completed',
            'estimated',
            1,
            'OBS runtime is ready.'
        );
        console.log('Electron installed OBS Studio.');
        return 'installed';
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportObsInstallStage('failed', 'estimated', null, 'Failed to install OBS.', {
            error: message,
        });
        console.warn('Failed to download/extract OBS:', error);
        return 'failed';
    } finally {
        try {
            if (fs.existsSync(OBS_DOWNLOAD_ARCHIVE_PATH)) {
                fs.rmSync(OBS_DOWNLOAD_ARCHIVE_PATH, { force: true });
            }
        } catch {
            // Best-effort cleanup only.
        }
    }
}

/**
 * Ensure the bundled portable OBS is downloaded + configured. Deduplicated so
 * concurrent callers share one download. Idempotent: a no-op (beyond config
 * refresh) when OBS is already installed.
 */
export function ensureObsInstalled(): Promise<ObsEnsureStatus> {
    if (obsEnsurePromise) {
        return obsEnsurePromise;
    }
    obsEnsurePromise = ensureObsInstalledInternal().finally(() => {
        obsEnsurePromise = null;
    });
    return obsEnsurePromise;
}

/**
 * Download/seed OBS if needed, then launch it. This is the authoritative startup
 * path: because the same process downloads and launches, there is no dependency
 * on a backend "OBS is ready" signal.
 */
export async function ensureObsInstalledAndLaunch(
    options: ElectronOBSProcessOptions = {}
): Promise<void> {
    const status = await ensureObsInstalled();
    if (status === 'failed') {
        // Don't attempt to launch a missing OBS; the failed stage already
        // surfaced the error.
        return;
    }
    try {
        await launchOBSFromElectron(options);
    } catch (error) {
        console.warn('launchOBSFromElectron failed after ensure:', error);
    }
}

function readOBSProcessPid(): number | null {
    if (!fs.existsSync(OBS_PID_FILE)) {
        return null;
    }

    try {
        const rawPid = fs.readFileSync(OBS_PID_FILE, 'utf-8').trim();
        const pid = Number.parseInt(rawPid, 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

function clearOBSProcessPid(): void {
    try {
        fs.rmSync(OBS_PID_FILE, { force: true });
    } catch {
        // Best effort cleanup only.
    }
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === 'EPERM';
    }
}

function getOwnedOBSProcessPid(): number | null {
    if (!electronOBSProcess?.pid) {
        return null;
    }

    if (electronOBSProcess.exitCode != null || electronOBSProcess.signalCode != null) {
        return null;
    }

    return electronOBSProcess.pid;
}

function clearOwnedOBSProcess(
    obsProcess: ChildProcess,
    status: ElectronOBSProcessStatus = 'not-running'
): void {
    if (electronOBSProcess !== obsProcess) {
        return;
    }

    const pid = obsProcess.pid;
    electronOBSProcess = null;

    if (pid === undefined || readOBSProcessPid() === pid) {
        clearOBSProcessPid();
    }

    electronOBSLaunchStatus = status;
}

function trackOwnedOBSProcess(obsProcess: ChildProcess): void {
    electronOBSProcess = obsProcess;

    obsProcess.once('error', (error) => {
        logObsError('Electron-managed OBS launch failed:', error);
        clearOwnedOBSProcess(obsProcess, 'failed');
    });

    obsProcess.once('exit', () => {
        clearOwnedOBSProcess(obsProcess);
    });
}

/**
 * Verify that the process behind a PID is actually OBS.
 *
 * `isProcessRunning` only tells us a PID is alive — on Windows that PID may have
 * been reused by an unrelated process after our OBS exited (e.g. after a manual
 * close or an app update orphaned the previous instance). Mirrors the original
 * Python behaviour (`"obs" in process.exe()`) so a stale/reused PID in
 * `obs_pid.txt` cannot masquerade as a running OBS and block a fresh launch.
 */
async function processImageIsObs(pid: number): Promise<boolean> {
    try {
        if (isWindows()) {
            const { stdout } = await execFileAsync('tasklist', [
                '/NH',
                '/FO',
                'CSV',
                '/FI',
                `PID eq ${pid}`,
            ]);
            return /obs/i.test(stdout ?? '');
        }
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=']);
        return /obs/i.test(stdout ?? '');
    } catch (error) {
        // If we can't determine the image name, assume it is NOT our OBS so a
        // stale/reused PID does not permanently block launching a fresh one.
        logObsError(`Failed to verify OBS process image for pid ${pid}:`, error);
        return false;
    }
}

async function getRunningManagedOBSPid(): Promise<number | null> {
    const ownedPid = getOwnedOBSProcessPid();
    if (ownedPid) {
        // We spawned this process ourselves, so it is trusted to be OBS.
        if (isProcessRunning(ownedPid)) {
            return ownedPid;
        }

        if (electronOBSProcess) {
            clearOwnedOBSProcess(electronOBSProcess);
        }
    }

    const pid = readOBSProcessPid();
    if (!pid) {
        return null;
    }

    if (isProcessRunning(pid) && (await processImageIsObs(pid))) {
        return pid;
    }

    // PID is dead, or has been reused by a non-OBS process. Treat the pid file
    // as stale so a fresh OBS launch is allowed.
    clearOBSProcessPid();
    return null;
}

function buildOBSLaunchArgs(baseArgs: string[], config: ElectronOBSStartupConfig): string[] {
    const args = [...baseArgs, '--disable-shutdown-check', '--portable'];
    if (!config.allowAutomaticUpdates) {
        args.push('--disable-updater');
    }
    if (!config.disableRecording) {
        args.push('--startreplaybuffer');
    }
    return args;
}

async function launchOBSFromElectronInternal(
    options: ElectronOBSProcessOptions = {}
): Promise<ElectronOBSProcessResult> {
    const config = getElectronOBSStartupConfig();
    if (!config.openObs && !options.ignoreOpenConfig) {
        electronOBSLaunchStatus = 'skipped';
        return { status: 'skipped' };
    }

    const existingPid = await getRunningManagedOBSPid();
    if (existingPid) {
        if (!options.forceRestart) {
            electronOBSLaunchStatus = 'already-running';
            return { status: 'already-running', pid: existingPid };
        }
        await closeOBSFromElectron({ ignoreCloseConfig: true, reason: options.reason });
    }

    let launchCommand = resolveElectronOBSLaunchCommand(config.obsPath);
    if (!launchCommand && options.allowPathFallback) {
        launchCommand = resolveElectronOBSLaunchCommand('obs');
    }
    if (!launchCommand) {
        electronOBSLaunchStatus = 'missing';
        return { status: 'missing', error: `OBS executable not found: ${config.obsPath}` };
    }

    try {
        cleanupOBSStartupArtifacts();
        // For the bundled portable OBS (Windows), pick the websocket port for
        // this launch (prefer 7274, fall back into the ephemeral range if it's
        // taken) and write it before OBS binds it. System OBS elsewhere keeps
        // its user-configured port.
        if (isWindows()) {
            config.port = await resolveObsWebSocketPort(config.port);
        }
        writeElectronOBSWebSocketConfig(config);
        const obsProcess = spawn(
            launchCommand.command,
            buildOBSLaunchArgs(launchCommand.args, config),
            {
                cwd: launchCommand.cwd,
                detached: false,
                shell: false,
                stdio: 'ignore',
            }
        );

        trackOwnedOBSProcess(obsProcess);

        if (obsProcess.pid) {
            fs.writeFileSync(OBS_PID_FILE, String(obsProcess.pid), 'utf-8');
        }

        electronOBSLaunchStatus = 'launched';
        console.log(
            `Electron launched OBS${options.reason ? ` (${options.reason})` : ''}.`
        );
        return { status: 'launched', pid: obsProcess.pid };
    } catch (error) {
        electronOBSLaunchStatus = 'failed';
        return {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function shouldRetryElectronManagedOBSLaunch(): boolean {
    return (
        electronOBSLaunchStatus === 'idle' ||
        electronOBSLaunchStatus === 'missing' ||
        electronOBSLaunchStatus === 'failed'
    );
}

export function launchOBSFromElectron(
    options: ElectronOBSProcessOptions = {}
): Promise<ElectronOBSProcessResult> {
    if (electronOBSLaunchPromise && !options.forceRestart) {
        return electronOBSLaunchPromise;
    }

    electronOBSLaunchPromise = (async () => {
        if (!options.forceRestart) {
            if (
                electronOBSLaunchStatus === 'launched' ||
                electronOBSLaunchStatus === 'already-running'
            ) {
                const runningPid = await getRunningManagedOBSPid();
                if (runningPid) {
                    return { status: 'already-running', pid: runningPid } as const;
                }
                electronOBSLaunchStatus = 'not-running';
            }

            if (electronOBSLaunchStatus === 'skipped' && !options.ignoreOpenConfig) {
                return { status: 'skipped' } as const;
            }
        }

        await deferOBSLaunchWork();
        return launchOBSFromElectronInternal(options);
    })().finally(() => {
        electronOBSLaunchPromise = null;
    });
    return electronOBSLaunchPromise;
}

export async function closeOBSFromElectron(
    options: ElectronOBSProcessOptions = {}
): Promise<ElectronOBSProcessResult> {
    const config = getElectronOBSStartupConfig();
    if (!options.ignoreCloseConfig && !config.closeObs) {
        electronOBSProcess?.unref();
        return { status: 'skipped' };
    }

    const ownedProcess = electronOBSProcess;
    const ownedPid = getOwnedOBSProcessPid();
    const pid = ownedPid ?? readOBSProcessPid();
    if (!pid) {
        electronOBSLaunchStatus = 'not-running';
        return { status: 'not-running' };
    }

    if (!isProcessRunning(pid)) {
        if (ownedProcess?.pid === pid) {
            electronOBSProcess = null;
        }
        clearOBSProcessPid();
        electronOBSLaunchStatus = 'not-running';
        return { status: 'not-running', pid };
    }

    // For a PID we didn't spawn this session (read from obs_pid.txt), confirm it
    // is actually OBS before killing it — Windows may have reused the PID for an
    // unrelated process after our OBS exited.
    if (!ownedPid && !(await processImageIsObs(pid))) {
        clearOBSProcessPid();
        electronOBSLaunchStatus = 'not-running';
        return { status: 'not-running', pid };
    }

    try {
        if (isWindows()) {
            await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
        } else if (ownedProcess?.pid === pid) {
            ownedProcess.kill('SIGTERM');
        } else {
            process.kill(pid, 'SIGTERM');
        }
        if (ownedProcess?.pid === pid) {
            electronOBSProcess = null;
        }
        clearOBSProcessPid();
        electronOBSLaunchStatus = 'closed';
        console.log(`Electron closed OBS${options.reason ? ` (${options.reason})` : ''}.`);
        return { status: 'closed', pid };
    } catch (error) {
        electronOBSLaunchStatus = 'failed';
        return {
            status: 'failed',
            pid,
            error: error instanceof Error ? error.message : String(error),
        };
    }
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

function isSwitchableCaptureMode(value: unknown): value is ObsCaptureMode {
    return value === 'window_capture' || value === 'game_capture';
}

function chooseSwitchableCaptureItem(sceneItems: any[]): any | null {
    const captureItems = sceneItems.filter((item) =>
        isSwitchableCaptureMode(item.inputKind)
    );

    if (captureItems.length === 0) {
        return null;
    }

    const enabledItems = captureItems.filter(
        (item) => item.sceneItemEnabled !== false
    );
    const candidates = enabledItems.length > 0 ? enabledItems : captureItems;

    return (
        candidates.find((item) => item.inputKind === 'game_capture') ??
        candidates[0] ??
        null
    );
}

function choosePreviewCaptureItem(sceneItems: any[]): any | null {
    const videoItems = sceneItems.filter(isVideoCaptureSceneItem);
    if (videoItems.length === 0) {
        return null;
    }

    return chooseSwitchableCaptureItem(videoItems) ?? videoItems[0] ?? null;
}

async function findSceneByUuid(sceneUuid: string): Promise<ObsScene | null> {
    const trimmedSceneUuid = sceneUuid.trim();
    if (!trimmedSceneUuid) {
        return null;
    }

    const { scenes } = await callOBS('GetSceneList');
    const scene = (scenes ?? []).find(
        (candidate: any) => candidate.sceneUuid === trimmedSceneUuid
    );
    if (!scene) {
        return null;
    }

    return { name: scene.sceneName, id: scene.sceneUuid };
}

async function resolveSceneForPreview(sceneUuid?: string | null): Promise<ObsScene | null> {
    const trimmedSceneUuid = typeof sceneUuid === 'string' ? sceneUuid.trim() : '';
    if (trimmedSceneUuid) {
        return await findSceneByUuid(trimmedSceneUuid);
    }

    return await getCurrentScene();
}

function getNumericDimension(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
}

async function fitSceneItemsToPreview(scene: ObsScene): Promise<any[]> {
    const [videoSettings, sceneItemsResponse] = await Promise.all([
        callOBS('GetVideoSettings'),
        callOBS('GetSceneItemList', { sceneUuid: scene.id }),
    ]);

    const canvasWidth =
        getNumericDimension(videoSettings?.baseWidth) ??
        getNumericDimension(videoSettings?.base_width);
    const canvasHeight =
        getNumericDimension(videoSettings?.baseHeight) ??
        getNumericDimension(videoSettings?.base_height);
    const sceneItems = Array.isArray(sceneItemsResponse?.sceneItems)
        ? sceneItemsResponse.sceneItems
        : [];

    if (!canvasWidth || !canvasHeight || sceneItems.length === 0) {
        return sceneItems;
    }

    const transform = {
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        alignment: 5,
        boundsWidth: canvasWidth,
        boundsHeight: canvasHeight,
        positionX: 0,
        positionY: 0,
    };

    await Promise.all(
        sceneItems
            .filter((item: any) => typeof item.sceneItemId === 'number')
            .map((item: any) =>
                callOBS('SetSceneItemTransform', {
                    sceneUuid: scene.id,
                    sceneItemId: item.sceneItemId,
                    sceneItemTransform: transform,
                }).catch((error) => {
                    logObsError(
                        `Error fitting scene item "${String(item.sourceName ?? '')}" to preview:`,
                        error
                    );
                })
            )
    );

    return sceneItems;
}

async function getInputSettingsForSceneItem(
    sceneItem: any
): Promise<Record<string, unknown>> {
    const requestData =
        typeof sceneItem.sourceUuid === 'string' && sceneItem.sourceUuid.trim()
            ? { inputUuid: sceneItem.sourceUuid as string }
            : { inputName: String(sceneItem.sourceName ?? '') };

    const response = await callOBS('GetInputSettings', requestData);
    return response?.inputSettings ?? {};
}

async function upsertSceneInput(
    sceneName: string,
    captureInput: ObsSceneCaptureInput
): Promise<void> {
    let inputExists = false;
    try {
        await callOBS('GetInputSettings', { inputName: captureInput.inputName });
        inputExists = true;
    } catch {
        inputExists = false;
    }

    if (!inputExists) {
        await callOBS('CreateInput', {
            sceneName,
            ...captureInput,
        });
        return;
    }

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

    for (const captureInput of captureInputs) {
        await upsertSceneInput(sceneName, captureInput);
    }

    if (sceneInfo.switcherRegex) {
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
    let shouldRestartOBS = false;

    try {
        await getOBSConnection();

        const currentSceneCollection = await callOBS('GetSceneCollectionList');
        const sceneCollectionName = String(
            currentSceneCollection.currentSceneCollectionName ?? ''
        ).trim();
        if (!sceneCollectionName) {
            logObsError('Current scene collection name was empty while updating auto-scene-switcher settings.');
            return;
        }

        const sceneCollectionPath = getSceneCollectionPath(sceneCollectionName);
        if (!fs.existsSync(sceneCollectionPath)) {
            logObsError(`Scene collection file not found: ${sceneCollectionPath}`);
            return;
        }

        await wait(OBS_SCENE_SWITCHER_PRE_QUIT_DELAY_MS);

        await closeOBSFromElectron({
            ignoreCloseConfig: true,
            reason: 'auto-scene-switcher update',
        });
        shouldRestartOBS = true;

        await wait(OBS_SCENE_SWITCHER_SHUTDOWN_DELAY_MS);
        await resetOBSClient('auto-scene-switcher update restart');

        const fileContent = await fs.promises.readFile(sceneCollectionPath, 'utf-8');
        const sceneCollection = JSON.parse(fileContent) as Record<string, any>;
        const autoSceneSwitcher = getOrCreateAutoSceneSwitcherModule(sceneCollection);

        if (!autoSceneSwitcher.active) {
            const dialogOptions = {
                type: 'question' as const,
                buttons: ['Yes', 'No'],
                defaultId: 0,
                cancelId: 1,
                title: 'Enable Auto Scene Switcher',
                message: 'Do you want to enable the auto scene switcher?',
            };
            const dialogParent = getObsDialogParent();
            const response = dialogParent
                ? await dialog.showMessageBox(dialogParent, dialogOptions)
                : await dialog.showMessageBox(dialogOptions);

            if (response.response === 0) {
                autoSceneSwitcher.active = true;
            }
        }

        upsertAutoSceneSwitcherRule(autoSceneSwitcher, sceneName, windowTitleRegex);
        sceneCollection.modules[AUTO_SCENE_SWITCHER_MODULE_NAME] = autoSceneSwitcher;

        const updatedContent = JSON.stringify(sceneCollection, null, 2);
        await fs.promises.writeFile(sceneCollectionPath, updatedContent, 'utf-8');
        await fs.promises.writeFile(
            path.join(BASE_DIR, 'scene_config.json'),
            updatedContent,
            'utf-8'
        );

        console.log(
            `Auto-scene-switcher settings updated for "${sceneName}" with pattern: ${windowTitleRegex}`
        );
    } catch (error: any) {
        logObsError(
            'Error modifying auto-scene-switcher settings:',
            error?.message ?? error
        );
    } finally {
        if (!shouldRestartOBS) {
            return;
        }

        try {
            await launchOBSFromElectron({
                forceRestart: true,
                reason: 'auto-scene-switcher update',
            });
        } catch (startError) {
            logObsError('Failed to restart OBS after auto-scene-switcher update:', startError);
            return;
        }

        try {
            await connectOBSWebSocket();
        } catch (reconnectError) {
            logObsError(
                'Initial reconnection failed, OBS may still be starting up:',
                reconnectError
            );
        }
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

let obsIPCRegistered = false;

export async function registerOBSIPC() {
    if (obsIPCRegistered) {
        return;
    }
    obsIPCRegistered = true;

    ipcMain.handle('obs.launch', async () => {
        return await launchOBSFromElectron({
            ignoreOpenConfig: true,
            allowPathFallback: true,
            reason: 'ipc obs.launch',
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

    ipcMain.handle('obs.getSceneCaptureMode', async (_, sceneUuid: string) => {
        try {
            return await getSceneCaptureMode(String(sceneUuid ?? ''));
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting scene capture mode:', error);
            }
            return null;
        }
    });

    ipcMain.handle('obs.getScenePreviewSnapshot', async (_, sceneUuid?: string) => {
        return await getScenePreviewSnapshot(
            typeof sceneUuid === 'string' ? sceneUuid : null
        );
    });

    ipcMain.handle(
        'obs.switchSceneCaptureMode',
        async (
            _,
            payload:
                | { sceneUuid?: string; targetMode?: ObsCaptureMode }
                | null
                | undefined
        ) => {
            try {
                const targetMode = payload?.targetMode;
                if (!isSwitchableCaptureMode(targetMode)) {
                    return null;
                }
                return await switchOBSSceneCaptureMode(
                    payload?.sceneUuid ?? '',
                    targetMode
                );
            } catch (error) {
                if (!isOBSInitializingError(error)) {
                    logObsError('Error switching scene capture mode:', error);
                }
                return null;
            }
        }
    );

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
        const result = await launchOBSFromElectron({
            ignoreOpenConfig: true,
            allowPathFallback: true,
            reason: 'openOBS ipc',
        });
        if (result.status === 'missing' || result.status === 'failed') {
            sendStartOBS();
        }
        return result;
    });

    const inputPropertyItemsPromises = new Map<string, Promise<ObsDevicePropertyItem[]>>();
    // Track probe inputs created in the helper scene so we can remove them after use.
    const createdProbeInputs = new Set<string>();

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

    /**
     * Remove all probe inputs created in the helper scene.
     * Called after a full window-list query so that dshow_input / wasapi_input_capture
     * sources do not linger with open device handles.
     */
    async function cleanupProbeInputs(): Promise<void> {
        for (const inputName of createdProbeInputs) {
            try {
                await callOBS('RemoveInput', { inputName });
            } catch {
                // Input may already have been removed or never fully created.
            }
        }
        createdProbeInputs.clear();
    }

    async function ensureHelperInputExists(
        inputName: string,
        inputKind: string,
        inputSettings: Record<string, unknown> = {}
    ): Promise<void> {
        try {
            await callOBS('GetInputSettings', { inputName });
        } catch (error: any) {
            const errorMessage = getObsErrorMessage(error);
            if (!errorMessage.includes('No source was found')) {
                throw error;
            }

            await ensureHelperSceneExists();
            await callOBS('CreateInput', {
                sceneName: HELPER_SCENE,
                inputName,
                inputKind,
                inputSettings,
                sceneItemEnabled: false,
            });
        }

        await forceDisableHelperSceneInputs([inputName]);
    }

    async function setCaptureCardProbeInputsEnabled(enabled: boolean): Promise<boolean> {
        captureCardProbeEnabled = enabled;

        if (!isWindows()) {
            return captureCardProbeEnabled;
        }

        if (enabled) {
            await ensureHelperInputExists(
                CAPTURE_CARD_GETTER_INPUT,
                OBS_DSHOW_INPUT_KIND
            );
            await ensureHelperInputExists(
                AUDIO_INPUT_GETTER_INPUT,
                OBS_WASAPI_INPUT_CAPTURE_KIND,
                { device_id: 'default' }
            );
            await forceDisableHelperSceneInputs(CAPTURE_CARD_HELPER_INPUT_NAMES);
        } else {
            for (const inputName of CAPTURE_CARD_HELPER_INPUT_NAMES) {
                try {
                    await callOBS('RemoveInput', { inputName });
                } catch {
                    // Ignore missing helper inputs during disable.
                }
                createdProbeInputs.delete(inputName);
                inputPropertyItemsPromises.forEach((_, key) => {
                    if (key.includes(`"${inputName}"`)) {
                        inputPropertyItemsPromises.delete(key);
                    }
                });
            }
        }

        windowListFullCache = null;
        windowListFastCache = null;
        return captureCardProbeEnabled;
    }

    async function syncCaptureCardProbeInputsToStateOnce(): Promise<void> {
        if (captureCardProbeInputsSynced) {
            return;
        }

        await setCaptureCardProbeInputsEnabled(captureCardProbeEnabled);
        captureCardProbeInputsSynced = true;
    }

    async function forceDisableHelperSceneInputs(
        inputNames?: Iterable<string>
    ): Promise<void> {
        try {
            const targetInputNames =
                inputNames === undefined ? HELPER_INPUT_NAMES : new Set(inputNames);
            const response = await callOBS('GetSceneItemList', {
                sceneName: HELPER_SCENE,
            });

            for (const sceneItem of response.sceneItems ?? []) {
                const sourceName = sceneItem.sourceName as string | undefined;
                if (!sourceName || !HELPER_INPUT_NAMES.has(sourceName)) {
                    continue;
                }
                if (!targetInputNames.has(sourceName)) {
                    continue;
                }
                if (typeof sceneItem.sceneItemId !== 'number') {
                    continue;
                }
                if (sceneItem.sceneItemEnabled === false) {
                    continue;
                }

                await callOBS('SetSceneItemEnabled', {
                    sceneName: HELPER_SCENE,
                    sceneItemId: sceneItem.sceneItemId,
                    sceneItemEnabled: false,
                });
            }
        } catch {
            // Ignore missing helper scenes or scene-item lookup failures.
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
                await forceDisableHelperSceneInputs([inputName]);
                const response = await callOBS('GetInputPropertiesListPropertyItems', {
                    inputName,
                    propertyName,
                });
                await forceDisableHelperSceneInputs([inputName]);
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
                    sceneItemEnabled: false,
                });
                createdProbeInputs.add(inputName);
                await forceDisableHelperSceneInputs([inputName]);

                const retryResponse = await callOBS('GetInputPropertiesListPropertyItems', {
                    inputName,
                    propertyName,
                });
                await forceDisableHelperSceneInputs([inputName]);
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
        if (!captureCardProbeEnabled) {
            return [];
        }

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

    // Cache for getWindowList results to avoid hammering OBS with device
    // enumeration every poll cycle.
    // "fast" = window/game capture only (cheap), "full" = also capture cards (expensive probes).
    const WINDOW_LIST_FAST_CACHE_TTL_MS = 3_000;
    const WINDOW_LIST_FULL_CACHE_TTL_MS = 30_000;
    let windowListFastCache: { data: ObsWindowOption[]; timestamp: number } | null = null;
    let windowListFullCache: { data: ObsWindowOption[]; timestamp: number } | null = null;

    /**
     * Fetch only window_capture + game_capture lists (cheap OBS calls, no device probing).
     */
    async function getWindowListFast(): Promise<ObsWindowOption[]> {
        try {
            if (isLinux()) {
                return await getLinuxXCompositeWindows();
            }

            await forceDisableHelperSceneInputs();

            const [windowCaptureWindows, gameCaptureWindows] =
                await Promise.all([
                    getWindowsFromSource(WINDOW_GETTER_INPUT, 'window_capture'),
                    getWindowsFromSource(GAME_WINDOW_INPUT, 'game_capture'),
                ]);

            const allWindows = [...windowCaptureWindows, ...gameCaptureWindows].filter(
                (item) => !shouldFilterWindow(item)
            );

            // Merge in the last-known capture card list so the dropdown stays complete.
            const cachedCaptureCards = windowListFullCache?.data.filter(
                (item) => item.targetKind === 'capture_card'
            ) ?? [];

            return [...mergeObsWindowItems(allWindows), ...cachedCaptureCards].sort((left, right) =>
                left.title.localeCompare(right.title)
            );
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting window list (fast):', error);
            }
            return [];
        }
    }

    /**
     * Full fetch including capture card / device enumeration (expensive).
     */
    async function getWindowListFull(): Promise<ObsWindowOption[]> {
        try {
            if (isLinux()) {
                return await getLinuxXCompositeWindows();
            }

            await forceDisableHelperSceneInputs();

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

    // Annotate window options with the cleaned game name so the renderer can
    // default the "override scene name" field to the parsed title instead of the
    // raw window title (e.g. "Eden | v0.2.0 | ... | ファミコン探偵倶楽部 ... (64-bit) | ...").
    function withSuggestedSceneNames(options: ObsWindowOption[]): ObsWindowOption[] {
        return options.map((option) => {
            if (option.targetKind !== 'window') {
                return option;
            }
            const suggestedSceneName = getGameInfoFromWindow(option.title).sceneName;
            return { ...option, suggestedSceneName };
        });
    }

    ipcMain.handle('obs.getWindows', async (_, options?: { quick?: boolean }) => {
        try {
            if (!isWindows() && !isLinux()) {
                return [];
            }

            const quick = options?.quick === true;

            if (quick) {
                if (
                    windowListFastCache &&
                    Date.now() - windowListFastCache.timestamp < WINDOW_LIST_FAST_CACHE_TTL_MS
                ) {
                    return windowListFastCache.data;
                }
                await getOBSConnection();
                await syncCaptureCardProbeInputsToStateOnce();
                const result = withSuggestedSceneNames(await getWindowListFast());
                windowListFastCache = { data: result, timestamp: Date.now() };
                return result;
            }

            // Full query (includes capture cards).
            if (
                windowListFullCache &&
                Date.now() - windowListFullCache.timestamp < WINDOW_LIST_FULL_CACHE_TTL_MS
            ) {
                return windowListFullCache.data;
            }

            await getOBSConnection();
            await syncCaptureCardProbeInputsToStateOnce();
            const result = withSuggestedSceneNames(await getWindowListFull());
            windowListFullCache = { data: result, timestamp: Date.now() };
            // Also refresh the fast cache so the next quick poll is instant.
            windowListFastCache = { data: result, timestamp: Date.now() };
            return result;
        } catch (error) {
            if (!isOBSInitializingError(error)) {
                logObsError('Error getting windows:', error);
            }
            return [];
        }
    });

    ipcMain.handle('obs.getCaptureCardProbeEnabled', async () => {
        try {
            await getOBSConnection();
            await syncCaptureCardProbeInputsToStateOnce();
        } catch {
            // Ignore connection failures here and return the remembered toggle state.
        }
        return captureCardProbeEnabled;
    });

    ipcMain.handle(
        'obs.setCaptureCardProbeEnabled',
        async (_, enabled: boolean) => {
            try {
                await getOBSConnection();
                return await setCaptureCardProbeInputsEnabled(Boolean(enabled));
            } catch (error) {
                if (!isOBSInitializingError(error)) {
                    logObsError('Error toggling capture-card helper inputs:', error);
                }
                return captureCardProbeEnabled;
            }
        }
    );

    void getOBSConnection().catch((error) => {
        logObsError(
            `[OBS] Initial OBS connection attempt failed: ${getObsErrorMessage(error)}`
        );
    });
    void getOBSConnection()
        .then(() => syncCaptureCardProbeInputsToStateOnce())
        .catch(() => {
            // Ignore startup sync failures; normal IPC paths will retry.
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
            return false;
        }

        return !isScreenshotImageDataEffectivelyEmpty(response.imageData);
    } catch (error: any) {
        logObsError(`Error probing scene output for "${sceneName}":`, error?.message ?? error);
        return null;
    }
}

export async function getSceneCaptureMode(
    sceneUuid: string
): Promise<ObsCaptureMode | null> {
    const trimmedSceneUuid = sceneUuid.trim();
    if (!trimmedSceneUuid) {
        return null;
    }

    try {
        await getOBSConnection();
        const sceneItems = await callOBS('GetSceneItemList', {
            sceneUuid: trimmedSceneUuid,
        });
        const captureItem = chooseSwitchableCaptureItem(
            sceneItems?.sceneItems ?? []
        );
        return isSwitchableCaptureMode(captureItem?.inputKind)
            ? captureItem.inputKind
            : null;
    } catch (error: any) {
        logObsError(
            `Error detecting capture mode for scene "${trimmedSceneUuid}":`,
            error?.message ?? error
        );
        return null;
    }
}

export async function getScenePreviewSnapshot(
    sceneUuid?: string | null
): Promise<ObsScenePreviewSnapshot | null> {
    try {
        await getOBSConnection();
        const scene = await resolveSceneForPreview(sceneUuid);
        if (!scene || !scene.id || !scene.name) {
            return null;
        }

        const sceneItems = await fitSceneItemsToPreview(scene);
        const previewItem = choosePreviewCaptureItem(sceneItems);
        const sourceName =
            typeof previewItem?.sourceName === 'string' ? previewItem.sourceName : null;
        const captureMode = isSwitchableCaptureMode(previewItem?.inputKind)
            ? previewItem.inputKind
            : null;

        let imageData: string | null = null;
        try {
            const response = await callOBS('GetSourceScreenshot', {
                sourceName: scene.name,
                imageFormat: 'jpg',
                imageWidth: OBS_PREVIEW_SCREENSHOT_WIDTH,
                imageHeight: OBS_PREVIEW_SCREENSHOT_HEIGHT,
            });
            imageData = typeof response?.imageData === 'string' ? response.imageData : null;
        } catch (sceneScreenshotError) {
            if (!sourceName) {
                logObsError(
                    `Error screenshotting OBS scene "${scene.name}":`,
                    sceneScreenshotError
                );
            } else {
                logObsError(
                    `Error screenshotting OBS scene "${scene.name}", falling back to source "${sourceName}":`,
                    sceneScreenshotError
                );
                const response = await callOBS('GetSourceScreenshot', {
                    sourceName,
                    imageFormat: 'jpg',
                    imageWidth: OBS_PREVIEW_SCREENSHOT_WIDTH,
                    imageHeight: OBS_PREVIEW_SCREENSHOT_HEIGHT,
                });
                imageData = typeof response?.imageData === 'string' ? response.imageData : null;
            }
        }

        return {
            sceneName: scene.name,
            sceneId: scene.id,
            sourceName,
            captureMode,
            imageData,
        };
    } catch (error: any) {
        logObsError('Error getting scene preview screenshot:', error?.message ?? error);
        return null;
    }
}

export async function switchOBSSceneCaptureMode(
    sceneUuid: string,
    targetMode: ObsCaptureMode
): Promise<ObsCaptureMode | null> {
    const trimmedSceneUuid = sceneUuid.trim();
    if (!trimmedSceneUuid || !isSwitchableCaptureMode(targetMode) || !isWindows()) {
        return null;
    }

    try {
        await getOBSConnection();
        const scene = await findSceneByUuid(trimmedSceneUuid);
        if (!scene) {
            return null;
        }

        const sceneItemsResponse = await callOBS('GetSceneItemList', {
            sceneUuid: trimmedSceneUuid,
        });
        const sceneItems = sceneItemsResponse?.sceneItems ?? [];
        const switchableItems = sceneItems.filter((item: any) =>
            isSwitchableCaptureMode(item.inputKind)
        );
        const currentItem = chooseSwitchableCaptureItem(sceneItems);

        if (!currentItem) {
            return null;
        }

        const sourceSettings = await getInputSettingsForSceneItem(currentItem);
        const windowValue = sourceSettings.window;
        if (typeof windowValue !== 'string' || !windowValue.trim()) {
            return null;
        }

        const targetInput = buildWindowsVideoCaptureInput(
            scene.name,
            targetMode,
            windowValue,
            {
                isWindows: isWindows(),
                isWindows10OrHigher: isWindows10OrHigher(),
            }
        );

        await upsertSceneInput(scene.name, targetInput);

        for (const item of switchableItems) {
            if (item.inputKind === targetMode || typeof item.sceneItemId !== 'number') {
                continue;
            }
            try {
                await callOBS('RemoveSceneItem', {
                    sceneName: scene.name,
                    sceneItemId: item.sceneItemId,
                });
            } catch {
                // Ignore item removal failures and report the requested mode.
            }
        }

        return targetMode;
    } catch (error: any) {
        logObsError(
            `Error switching capture mode for scene "${trimmedSceneUuid}":`,
            error?.message ?? error
        );
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
