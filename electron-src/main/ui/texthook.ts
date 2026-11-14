// electron-src/main/ui/texthook.ts
//
// Text Hooking integration for GameSentenceMiner.
//
// Coordinates app settings and Agent/Frida hooks. LunaHook/Textractor live
// sessions are owned by Rust (native/gsm-texthook), including processes,
// decoding, buffering, selection, architecture recovery and target lifetime.
// Native output is forwarded unchanged to the existing Python text ingress.
//
// Inspired by the Sugoi Hook project (https://github.com/sugoi-toolkit-official/sugoi-hook),
// rewritten from scratch to fit the GSM Electron architecture. Bundled
// Textractor and Luna Hook binaries are GPL-3.0; see assets/texthook/NOTICE.md.

import { settingsSync } from '../runtime/native_settings.js';
import { configureNativeTextHookEvents, nativeTextHook, nativeTextHookSync } from './native_texthook.js';
import * as path from 'path';
import * as fs from 'node:fs';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import {
    BASE_DIR,
    getAssetsDir,
    isWindows,
    isLinux,
    sanitizeFilename,
} from '../util.js';
import { resolveWineLaunch, findLinuxGamePid, type WineLaunchContext } from './linux_wine.js';
import { getConfiguredTargetLanguage, gsmBackendUrl } from '../gsm_config.js';
import {
    getGameExePathForScene,
    setGameExePathForScene,
} from '../store.js';
import { mainWindow, sendReloadSettings, sendTextHookLine, sendTextHookStatus } from '../main.js';
import {
    getTexthookRuntimeDir,
    FORCE_TEXTHOOK_DOWNLOAD,
    downloadTexthookEngines,
    isTexthookInstalled,
} from './texthook_downloader.js';
import { nativeHookUpdates, reserveHookAttachment, releaseHookAttachment } from '../runtime/native_hook_updates.js';
import { gamePrivilegeMonitor } from '../services/game_privileges.js';
import {
    getCurrentScene,
    getExecutableNameFromSource,
    getWindowTitleFromSource,
    syncProcessPausingTargetForCurrentScene,
} from './obs.js';
import {
    callAgentUiRpc as callLocalAgentUiRpc,
    configureAgentHookCallbacks,
    getAgentHookRuntimeStatus as getLocalAgentHookRuntimeStatus,
    isAgentHookRunning as isLocalAgentHookRunning,
    listAgentHooks as listLocalAgentHooks,
    sendAgentUiRpc as sendLocalAgentUiRpc,
    setAgentCopyToClipboard as setLocalAgentCopyToClipboard,
    setAgentFlushDelayMs as setLocalAgentFlushDelayMs,
    showAgentScriptUi as showLocalAgentScriptUi,
    startAgentHookSession,
    stopAgentHookSession as stopLocalAgentHookSession,
} from './agent.js';
import {
    callDetachedAgentUiRpc,
    configureDetachedAgentCallbacks,
    getDetachedAgentHookRuntimeStatus,
    isDetachedAgentHookRunning,
    listDetachedAgentHooks,
    reconnectDetachedAgentHookSession,
    sendDetachedAgentUiRpc,
    setDetachedAgentCopyToClipboard,
    setDetachedAgentFlushDelayMs,
    setDetachedAgentMaxBufferSize,
    showDetachedAgentScriptUi,
    shutdownDetachedAgentHostForUpdate,
    startDetachedAgentHookSession,
    stopDetachedAgentHookSession,
} from './detached_agent_client.js';
import {
    DEFAULT_MAX_BUFFER_SIZE,
    HARD_TEXT_HOOK_REJECTION_LIMIT,
    MAX_JAPANESE_QUOTE_PAIRS,
    MAX_TEXT_HOOK_MAX_BUFFER_SIZE,
    normalizeTextHookMaxBufferSize,
    sanitizeTextHookText,
    setRuntimeTextHookMaxBufferSize,
} from './text_hook_sanitize.js';



export type TextHookEngine = 'textractor' | 'luna' | 'agent' | 'mages';
type CliTextHookEngine = Exclude<TextHookEngine, 'agent' | 'mages'>;
export type TextHookArchitecture = 'x86' | 'x64';
/** Who started the session: a manual user action or the auto-launcher. */
export type TextHookStartSource = 'user' | 'auto-launcher';
type DetectedTextHookArchitecture = TextHookArchitecture | 'unknown';

export interface TextHookProfile {
    /** OBS scene id used as the canonical lookup key. */
    sceneId?: string;
    /** Lower-case executable name, retained for display and legacy lookup without a scene id. */
    exeName: string;
    engine: TextHookEngine;
    /** Auto-attach to the saved hook the moment it appears. */
    autoHook: boolean;
    /** Provisional revision window used by Python after immediate forwarding. */
    flushDelayMs: number;
    /** Stored hook id from the engine output. */
    hookId?: string | null;
    /** Function/thread name shown in the hook list, used as a fallback when ids change. */
    hookFunction?: string | null;
    /** Manual H-/R-code, when set the engine is asked to attach this hook directly. */
    manualHookCode?: string | null;
    /** Agent script path used when engine is "agent". */
    agentScriptPath?: string | null;
    /** Keep the Agent host alive when GSM exits so a later instance can reconnect. */
    agentDetached?: boolean;
    /** Copy processed text to clipboard after forwarding to Python. */
    copyToClipboard?: boolean;
    lastUsed: number;
}

interface NativeCliStatus {
    running: boolean; engine?: CliTextHookEngine; arch?: TextHookArchitecture;
    pid?: number; exeName?: string; source?: TextHookStartSource;
    selectedHookId?: string | null; hookCount?: number; flushDelayMs?: number;
    copyToClipboard?: boolean;
}
let nativeEventsConfigured = false;
let startGeneration = 0;
function forwardTextHookLine(payload: Parameters<typeof sendTextHookLine>[0] & { nativeIngress?: boolean }): void {
    if (payload.nativeIngress) return;
    const generation = startGeneration;
    const sessionId = payload.sessionId ?? (payload.engine === 'agent' ? getAgentHookRuntimeStatus()?.sessionId : undefined);
    sendTextHookLine({ ...payload, ...(sessionId ? { sessionId } : {}) }, (line) => {
        if (generation === startGeneration) emitToRenderer('texthook.processed', line);
    });
}
function ensureNativeEvents(): void {
    if (nativeEventsConfigured) return;
    configureNativeTextHookEvents((channel, payload) => {
        if (channel === 'texthook.output') forwardTextHookLine(payload);
        else if (channel === 'texthook.status') {
            emitStatus();
        } else emitToRenderer(channel, payload);
    });
    nativeEventsConfigured = true;
}
function nativeCliStatus(): NativeCliStatus {
    return nativeTextHookSync<NativeCliStatus>('status');
}
let hookStartInProgress = false;
const engineUpdates = nativeHookUpdates;
function getEngineUpdates() { return nativeHookUpdates; }

const DEFAULT_FLUSH_DELAY_MS = 100;
const MAX_FLUSH_DELAY_MS = 5000;
const DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE = DEFAULT_MAX_BUFFER_SIZE;
const GSM_CONFIG_FILE = path.join(BASE_DIR, 'config.json');

let textHookMaxBufferSize = loadTextHookMaxBufferSize();

interface TextHookOutputPayload {
    text: string;
    hookId: string;
    hookFunction: string;
    engine: CliTextHookEngine;
    exeName: string;
    copyToClipboard: boolean;
    capturedAt?: number;
    revisionWindowMs?: number;
    mergeFragments?: boolean;
}

type TextHookRuntimeStatus = ReturnType<typeof getRuntimeStatus>;
type TextHookUserActionListener = (status: TextHookRuntimeStatus) => void;

let userStartListener: TextHookUserActionListener | null = null;
let userStopListener: TextHookUserActionListener | null = null;

// ---------------------------------------------------------------------------
// Renderer messaging helpers
// ---------------------------------------------------------------------------

function emitToRenderer(channel: string, payload: unknown): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    try {
        mainWindow.webContents.send(channel, payload);
    } catch (err) {
        console.warn(`[TextHook] Failed to send "${channel}" to renderer:`, err);
    }
}

let lastBackendRunning: boolean | null = null;

function emitStatus(): void {
    const status = getRuntimeStatus();
    emitToRenderer('texthook.status', status);
    // Notify the backend only when the running state actually changes, so it can
    // pause/resume clipboard polling like a connected websocket source.
    const running = Boolean(status.running);
    if (!running) engineUpdates?.notifyIdle();
    if (running !== lastBackendRunning) {
        lastBackendRunning = running;
        try {
            sendTextHookStatus(running);
        } catch (err) {
            console.warn('[TextHook] Failed to notify backend of hook status:', err);
        }
    }
}

function emitLog(message: string, level: 'info' | 'error' | 'warn' = 'info'): void {
    emitToRenderer('texthook.log', { message, level, ts: Date.now() });
}

function emitHooks(): void {
    if (isAgentHookRunning()) {
        emitToRenderer('texthook.hooks', listAgentHooks());
        return;
    }
    emitToRenderer('texthook.hooks', nativeTextHookSync('hooks'));
}

function isAgentHookRunning(): boolean {
    return isDetachedAgentHookRunning() || isLocalAgentHookRunning();
}

function getAgentHookRuntimeStatus() {
    return getDetachedAgentHookRuntimeStatus() ?? getLocalAgentHookRuntimeStatus();
}

function listAgentHooks() {
    return isDetachedAgentHookRunning() ? listDetachedAgentHooks() : listLocalAgentHooks();
}

function stopAgentHookSession(): void {
    if (isDetachedAgentHookRunning()) {
        void stopDetachedAgentHookSession();
        return;
    }
    stopLocalAgentHookSession();
}

async function stopAgentHookSessionAndWait(): Promise<{ success: boolean; error?: string }> {
    if (isDetachedAgentHookRunning()) {
        return stopDetachedAgentHookSession();
    }
    stopLocalAgentHookSession();
    return { success: true };
}

function shutdownAgentHookSession(): void {
    if (isDetachedAgentHookRunning()) {
        return;
    }
    stopLocalAgentHookSession();
}

function setAgentFlushDelayMs(value: number) {
    return isDetachedAgentHookRunning()
        ? setDetachedAgentFlushDelayMs(value)
        : setLocalAgentFlushDelayMs(value);
}

function setAgentCopyToClipboard(value: boolean) {
    return isDetachedAgentHookRunning()
        ? setDetachedAgentCopyToClipboard(value)
        : setLocalAgentCopyToClipboard(value);
}

function showAgentScriptUi() {
    return isDetachedAgentHookRunning()
        ? showDetachedAgentScriptUi()
        : showLocalAgentScriptUi();
}

function callAgentUiRpc(func: string, args: unknown[]) {
    return isDetachedAgentHookRunning()
        ? callDetachedAgentUiRpc(func, args)
        : callLocalAgentUiRpc(func, args);
}

function sendAgentUiRpc(func: string, args: unknown[]) {
    return isDetachedAgentHookRunning()
        ? sendDetachedAgentUiRpc(func, args)
        : sendLocalAgentUiRpc(func, args);
}

// ---------------------------------------------------------------------------
// Asset paths
// ---------------------------------------------------------------------------

function getEngineCliPath(engine: CliTextHookEngine, arch: TextHookArchitecture): string {
    const rel =
        engine === 'luna'
            ? path.join('luna_builds', arch === 'x86' ? 'LunaHostCLI32.exe' : 'LunaHostCLI64.exe')
            : path.join('textractor_builds', arch === 'x86' ? '_x86' : '_x64', 'TextractorCLI.exe');

    const downloaded = path.join(getTexthookRuntimeDir(), rel);
    if (fs.existsSync(downloaded)) return downloaded;
    // When forced, skip the bundled-assets fallback so startHookSession
    // triggers the real download even in dev (GSM_FORCE_TEXTHOOK_DOWNLOAD=1).
    if (FORCE_TEXTHOOK_DOWNLOAD) return downloaded;
    return path.join(getAssetsDir(), 'texthook', rel);
}

// ---------------------------------------------------------------------------
// Process detection (native Windows metadata)
// ---------------------------------------------------------------------------

interface ProcessEntry {
    pid: number;
    exeName: string;
    arch: TextHookArchitecture;
}

/** A running process as enumerated from Win32_Process (extension preserved). */
interface RawProcess {
    pid: number;
    ppid: number;
    /** Full image name including the real extension, e.g. "game.bin" / "game.log" / "game.exe". */
    name: string;
    /** Working set in bytes. */
    memory: number;
}

// Processes at or below this size are treated as thin launchers/helpers rather
// than the game itself. Many games ship a tiny launcher .exe that spawns the
// real engine under a .bin/.log image; we look past those to find the heavy one.
const LAUNCHER_MEMORY_FLOOR = 20 * 1024 * 1024;

/** Read the PE header from disk to determine bitness. */
function readPortableExecutableBitness(executablePath: string): DetectedTextHookArchitecture {
    let fd: number | null = null;
    try {
        fd = fs.openSync(executablePath, 'r');
        const dosHeader = Buffer.alloc(64);
        fs.readSync(fd, dosHeader, 0, 64, 0);
        if (dosHeader.readUInt16LE(0) !== 0x5a4d) return 'unknown';
        const peOffset = dosHeader.readUInt32LE(0x3c);
        const peHeader = Buffer.alloc(6);
        fs.readSync(fd, peHeader, 0, 6, peOffset);
        if (peHeader.toString('ascii', 0, 4) !== 'PE\u0000\u0000') return 'unknown';
        const machine = peHeader.readUInt16LE(4);
        if (machine === 0x14c) return 'x86';
        if (machine === 0x8664) return 'x64';
        return 'unknown';
    } catch {
        return 'unknown';
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
}

async function getProcessExecutablePath(pid: number): Promise<string | null> {
    try { return (await nativeTextHook<{ path: string | null }>('processInfo', { pid })).path; }
    catch { return null; }
}
async function detectProcessArch(pid: number): Promise<TextHookArchitecture> {
    try {
        const info = await nativeTextHook<{ arch: string }>('processInfo', { pid });
        if (info.arch === 'x86' || info.arch === 'x64') return info.arch;
    } catch { /* PE fallback for inaccessible process metadata. */ }
    const exePath = await getProcessExecutablePath(pid);
    if (exePath && readPortableExecutableBitness(exePath) === 'x86') return 'x86';
    return 'x64';
}

/** Lower-cased image name with its final extension stripped (e.g. "game.bin" -> "game"). */
function processBaseName(name: string): string {
    const dot = name.lastIndexOf('.');
    return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/**
 * Breadth-first collect every descendant of the given root PIDs.
 * Guards against the cyclic / reused ParentProcessId values Windows hands out
 * (e.g. a launcher and its child reporting each other as parent after PID reuse).
 */
function collectDescendants(processes: RawProcess[], rootPids: number[]): RawProcess[] {
    const byParent = new Map<number, RawProcess[]>();
    for (const proc of processes) {
        const siblings = byParent.get(proc.ppid);
        if (siblings) siblings.push(proc);
        else byParent.set(proc.ppid, [proc]);
    }
    const seen = new Set<number>(rootPids);
    const out: RawProcess[] = [];
    const queue = [...rootPids];
    while (queue.length > 0) {
        const pid = queue.shift() as number;
        for (const child of byParent.get(pid) ?? []) {
            if (seen.has(child.pid)) continue;
            seen.add(child.pid);
            out.push(child);
            queue.push(child.pid);
        }
    }
    return out;
}

/**
 * Pick the real game process for a captured executable name.
 *
 * OBS reports whatever image owns the captured window — which may be the game
 * itself (often a non-.exe image like "game.bin"/"game.log") or a thin launcher
 * .exe that spawned it. Resolution order:
 *   1. Heaviest exact-name match above the launcher floor (the game directly).
 *   2. Heaviest descendant of an exact match (captured a thin launcher).
 *   3. Heaviest process sharing the base name, different extension
 *      (e.g. captured "game.exe" but the engine runs as "game.bin").
 *   4. Heaviest exact match even if tiny (last resort).
 *
 * Exported via __test for unit coverage.
 */
function selectGameProcess(processes: RawProcess[], exeName: string): RawProcess | null {
    const target = exeName.toLowerCase();
    const targetBase = processBaseName(exeName);
    const byMemoryDesc = (a: RawProcess, b: RawProcess) => b.memory - a.memory;

    const exact = processes.filter((p) => p.name.toLowerCase() === target);

    // 1. The game is usually the heaviest process matching the captured name.
    const heavyExact = exact.filter((p) => p.memory > LAUNCHER_MEMORY_FLOOR).sort(byMemoryDesc);
    if (heavyExact.length > 0) return heavyExact[0];

    // 2. We captured a thin launcher — follow it down to the heaviest child.
    if (exact.length > 0) {
        const descendants = collectDescendants(processes, exact.map((p) => p.pid))
            .filter((p) => p.memory > LAUNCHER_MEMORY_FLOOR)
            .sort(byMemoryDesc);
        if (descendants.length > 0) return descendants[0];
    }

    // 3. Same base name under a different extension (launcher.exe -> engine.bin),
    //    even when PID reuse hid the parent/child link.
    const baseMatches = processes
        .filter((p) => processBaseName(p.name) === targetBase && p.memory > LAUNCHER_MEMORY_FLOOR)
        .sort(byMemoryDesc);
    if (baseMatches.length > 0) return baseMatches[0];

    // 4. Nothing heavy found; fall back to the heaviest exact match regardless of size.
    if (exact.length > 0) return [...exact].sort(byMemoryDesc)[0];

    return null;
}

/**
 * Enumerate running processes via Win32_Process. Unlike Get-Process (whose Name
 * is the .NET ProcessName with the extension stripped), CIM preserves the real
 * image name — so non-.exe games like "game.bin"/"game.log" match correctly.
 * Explicit UTF-8 output keeps Unicode (e.g. Japanese) names intact.
 */
async function listWindowsProcesses(): Promise<RawProcess[] | null> {
    try { return await nativeTextHook<RawProcess[]>('processes'); }
    catch (error) {
        emitLog(`Process lookup failed: ${(error as Error).message}`, 'error');
        return null;
    }
}

/**
 * Find the best matching process for a given exe name, transparently resolving
 * thin-launcher setups (a small .exe spawning the real engine as .bin/.log).
 */
async function findProcessByExeName(exeName: string): Promise<ProcessEntry | null> {
    if (!isWindows()) {
        emitLog('Process detection is currently only implemented on Windows.', 'warn');
        return null;
    }
    const processes = await listWindowsProcesses();
    if (!processes) return null;
    const chosen = selectGameProcess(processes, exeName);
    if (!chosen) return null;
    if (chosen.name.toLowerCase() !== exeName.toLowerCase()) {
        emitLog(`Resolved "${exeName}" to game process ${chosen.name} (PID ${chosen.pid}).`);
    }
    const arch = await detectProcessArch(chosen.pid);
    return { pid: chosen.pid, exeName: chosen.name, arch };
}

// ---------------------------------------------------------------------------
// Active capture detection
// ---------------------------------------------------------------------------

export interface ActiveCaptureInfo {
    sceneName: string;
    sceneId: string;
    exeName: string | null;
    windowTitle: string | null;
    // Linux only: the running game process resolved from the per-scene exe, for pre-start display.
    pid?: number | null;
    arch?: 'x86' | 'x64' | null;
}

export async function getActiveCapture(): Promise<ActiveCaptureInfo> {
    const scene = await getCurrentScene();
    let exeName: string | null = null;
    let windowTitle: string | null = null;
    if (scene && scene.id) {
        try {
            const found = await getExecutableNameFromSource(scene.id);
            if (typeof found === 'string' && found.trim().length > 0) {
                exeName = found.trim();
            }
        } catch (err) {
            emitLog(`Could not infer executable from active scene: ${(err as Error).message}`, 'warn');
        }
        try {
            const found = await getWindowTitleFromSource(scene.id);
            if (typeof found === 'string' && found.trim().length > 0) {
                windowTitle = found.trim();
            }
        } catch (err) {
            emitLog(`Could not infer window title from active scene: ${(err as Error).message}`, 'warn');
        }
    }
    // OBS window capture yields no executable on Linux, so fall back to the per-scene
    // game executable the user configured (Home tab → Game executable), and resolve the
    // running process so the UI can show the exe + PID before attaching.
    let pid: number | null = null;
    let arch: 'x86' | 'x64' | null = null;
    if (isLinux() && scene?.name) {
        const exePath = getGameExePathForScene(scene.name).trim();
        if (exePath) {
            if (!exeName) exeName = path.basename(exePath.replace(/\\/g, '/'));
            const linuxPid = findLinuxGamePid(exePath);
            if (linuxPid > 0) {
                pid = linuxPid;
                const bitness = readPortableExecutableBitness(exePath);
                arch = bitness === 'x86' ? 'x86' : bitness === 'x64' ? 'x64' : null;
            }
        }
    }
    gamePrivilegeMonitor.setTarget('capture', exeName ? { exeName } : null);
    void gamePrivilegeMonitor.check();
    return {
        sceneName: scene?.name ?? '',
        sceneId: scene?.id ?? '',
        exeName,
        windowTitle,
        pid,
        arch,
    };
}

// ---------------------------------------------------------------------------
// Profile storage
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCurrentGsmProfile(config: Record<string, unknown>): Record<string, unknown> | null {
    const configs = config.configs;
    if (!isRecord(configs)) {
        return config;
    }
    const currentProfile = typeof config.current_profile === 'string' ? config.current_profile : 'Default';
    const profile = configs[currentProfile] ?? configs.Default;
    return isRecord(profile) ? profile : null;
}

function loadTextHookMaxBufferSize(): number {
    try {
        if (!fs.existsSync(GSM_CONFIG_FILE)) {
            return DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;
        }
        const config = JSON.parse(fs.readFileSync(GSM_CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, ''));
        if (!isRecord(config)) {
            return DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;
        }
        const profile = getCurrentGsmProfile(config);
        const general = profile?.general;
        return isRecord(general)
            ? normalizeTextHookMaxBufferSize(general.texthook_max_buffer_size)
            : DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;
    } catch {
        return DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;
    }
}

function saveTextHookMaxBufferSize(value: number): boolean {
    try {
        const config = fs.existsSync(GSM_CONFIG_FILE)
            ? JSON.parse(fs.readFileSync(GSM_CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, ''))
            : {};
        if (!isRecord(config)) {
            return false;
        }

        const configs = config.configs;
        const profiles = isRecord(configs) ? Object.values(configs) : [config];
        let updated = false;
        for (const profile of profiles) {
            if (!isRecord(profile)) continue;
            const general = isRecord(profile.general) ? profile.general : {};
            general.texthook_max_buffer_size = value;
            profile.general = general;
            updated = true;
        }
        if (!updated) {
            return false;
        }

        fs.writeFileSync(GSM_CONFIG_FILE, JSON.stringify(config, null, 4), 'utf-8');
        return true;
    } catch (error) {
        emitLog(`Failed to save text hook buffer limit: ${(error as Error).message}`, 'error');
        return false;
    }
}

function setTextHookMaxBufferSize(value: unknown): {
    success: boolean;
    maxBufferSize?: number;
    error?: string;
} {
    const maxBufferSize = normalizeTextHookMaxBufferSize(value);
    if (!saveTextHookMaxBufferSize(maxBufferSize)) {
        return { success: false, error: 'Could not save the text hook buffer limit.' };
    }
    textHookMaxBufferSize = maxBufferSize;
    setRuntimeTextHookMaxBufferSize(maxBufferSize);
    setDetachedAgentMaxBufferSize(maxBufferSize);
    nativeTextHookSync('configure', { maxBufferSize });
    sendReloadSettings();
    return { success: true, maxBufferSize };
}

function loadAllProfiles(): Record<string, TextHookProfile> {
    return settingsSync('profiles.list');
}

function normalizeProfile(value: unknown): TextHookProfile | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Partial<TextHookProfile>;
    if (typeof v.exeName !== 'string' || v.exeName.trim().length === 0) return null;
    const engine: TextHookEngine =
        v.engine === 'textractor' || v.engine === 'agent' || v.engine === 'mages'
            ? v.engine
            : 'luna';
    return {
        sceneId: typeof v.sceneId === 'string' && v.sceneId.trim() ? v.sceneId.trim() : undefined,
        exeName: v.exeName.trim().toLowerCase(),
        engine,
        autoHook: v.autoHook !== false,
        flushDelayMs: normalizeFlushDelayMs(v.flushDelayMs),
        hookId: typeof v.hookId === 'string' ? v.hookId : null,
        hookFunction: typeof v.hookFunction === 'string' ? v.hookFunction : null,
        manualHookCode:
            typeof v.manualHookCode === 'string' && v.manualHookCode.trim().length > 0
                ? v.manualHookCode.trim()
                : null,
        agentScriptPath:
            typeof v.agentScriptPath === 'string' && v.agentScriptPath.trim().length > 0
                ? v.agentScriptPath.trim()
                : null,
        agentDetached: engine === 'agent' ? v.agentDetached !== false : false,
        copyToClipboard: v.copyToClipboard === true,
        lastUsed: typeof v.lastUsed === 'number' ? v.lastUsed : Date.now(),
    };
}

function normalizeFlushDelayMs(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_FLUSH_DELAY_MS;
    }
    return Math.min(MAX_FLUSH_DELAY_MS, Math.max(0, Math.round(parsed)));
}

export function getProfileFor(exeName: string, sceneId?: string | null): TextHookProfile | null {
    return settingsSync('profiles.get', { exeName, sceneId });
}

export function upsertProfile(profile: TextHookProfile): TextHookProfile {
    return settingsSync('profiles.upsert', profile);
}

export function deleteProfile(exeName: string, sceneId?: string | null): void {
    settingsSync('profiles.delete', { exeName, sceneId });
}

// ---------------------------------------------------------------------------
// Hook code validation
// ---------------------------------------------------------------------------

function isValidHookCode(code: string): boolean {
    if (!code) return false;
    if (!/^[HhRr]/.test(code)) return false;
    if (!code.includes('@')) return false;
    return true;
}

function sendSelectedHookText(
    payload: TextHookOutputPayload,
): { text: string; truncated: boolean } | null {
    const sanitizedText = sanitizeTextHookText(payload.text);
    if (!sanitizedText) {
        if (payload.text.length <= HARD_TEXT_HOOK_REJECTION_LIMIT) {
            emitLog(
                `Blocked text from hook #${payload.hookId}: more than ${MAX_JAPANESE_QUOTE_PAIRS} Japanese quote pairs.`,
                'warn',
            );
        }
        return null;
    }
    const guardedPayload = {
        ...payload,
        text: sanitizedText.text,
        copyToClipboard: payload.copyToClipboard,
    };
    forwardTextHookLine(guardedPayload);
    emitToRenderer('texthook.text', {
        hookId: guardedPayload.hookId,
        text: guardedPayload.text,
        ts: Date.now(),
    });
    return sanitizedText;
}

export interface StartHookOptions {
    engine?: TextHookEngine;
    exeName?: string | null;
    sceneId?: string | null;
    flushDelayMs?: number;
    agentScriptPath?: string | null;
    agentDetached?: boolean;
    copyToClipboard?: boolean;
    /** Who is starting the session; defaults to a manual user action. */
    source?: TextHookStartSource;
    /** Override the auto-detected host PID (used by the auto-launcher). */
    pidOverride?: number;
    /** Architecture from native process metadata, or an internal recovery override. */
    archOverride?: TextHookArchitecture;
    /** Internal recovery path: prevent architecture retry loops. */
    architectureFallbackAttempted?: boolean;
}

export interface StartHookResult {
    success: boolean;
    error?: string;
    pid?: number;
    exeName?: string;
    arch?: TextHookArchitecture;
}

export async function startHookSession(options: StartHookOptions = {}): Promise<StartHookResult> {
    if (hookStartInProgress) {
        return { success: false, error: 'A text hook session is already starting.' };
    }
    let reservation: string;
    try { reservation = reserveHookAttachment(); }
    catch (error) { return { success: false, error: (error as Error).message }; }
    // Reserve the start before any asynchronous target discovery. Manual updates
    // must not replace the CLI/DLLs while an auto-launcher attachment is starting.
    hookStartInProgress = true;
    const generation = ++startGeneration;
    try {
        ensureNativeEvents();
        const result = await startHookSessionInternal(options, generation);
        return generation === startGeneration ? result : { success: false, error: 'Text hook start was cancelled.' };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    } finally {
        hookStartInProgress = false;
        releaseHookAttachment(reservation);
        engineUpdates.notifyIdle();
    }
}

async function startHookSessionInternal(options: StartHookOptions, generation: number): Promise<StartHookResult> {
    // Preserve saved experimental profiles, but never silently run another engine for them.
    if (options.engine === 'mages') return { success: false, error: 'Built-in engine hooks are currently unavailable. Choose LunaHook, Textractor, or Agent.' };
    await reconnectDetachedAgentHookSession();
    if (nativeCliStatus().running || isAgentHookRunning()) {
        return { success: false, error: 'A text hook session is already running.' };
    }
    const onLinux = isLinux();
    if (!isWindows() && !onLinux) {
        return { success: false, error: 'Text hooking is only available on Windows and Linux.' };
    }

    const engine: TextHookEngine =
        options.engine === 'textractor' || options.engine === 'agent'
            ? options.engine
            : 'luna';
    const source: TextHookStartSource =
        options.source === 'auto-launcher' ? 'auto-launcher' : 'user';
    const archOverride =
        options.archOverride === 'x86' || options.archOverride === 'x64' ? options.archOverride : null;

    let exeName = (options.exeName ?? '').trim();
    // The Wine/Proton launch context the hooker must spawn inside (Linux only).
    let wineLaunch: WineLaunchContext | null = null;
    let target: { pid: number; exeName: string; arch: TextHookArchitecture } | null;

    if (onLinux) {
        // OBS window capture yields no executable on Linux, so use the per-scene game
        // executable the user pointed GSM at (Home tab → Game executable).
        const capture = await getActiveCapture();
        const exePath = getGameExePathForScene(capture.sceneName).trim();
        if (!exePath) {
            return {
                success: false,
                error: 'Set the game executable for this scene first (Home tab → Game executable).',
            };
        }
        if (!exeName) {
            exeName = path.basename(exePath.replace(/\\/g, '/'));
        }
        wineLaunch = resolveWineLaunch(exePath, '/proc', process.pid, options.pidOverride);
        if (wineLaunch.linuxPid <= 0) {
            return {
                success: false,
                error: `Could not find a running process for "${exeName}". Is the game running?`,
            };
        }
        if (!wineLaunch.launcherPath) {
            return {
                success: false,
                error: 'Could not resolve the Wine/Proton launcher for this game. Check the running game environment and Wine installation.',
            };
        }
        const arch: TextHookArchitecture =
            archOverride ?? (readPortableExecutableBitness(exePath) === 'x86' ? 'x86' : 'x64');
        target = { pid: wineLaunch.linuxPid, exeName, arch };
        emitLog(
            `Linux Wine target: PID ${wineLaunch.linuxPid}, prefix=${wineLaunch.winePrefix || '(unknown)'}, ` +
                `launcher=${wineLaunch.launcherPath} (${wineLaunch.launcherKind}) for ${exeName} (${arch}).`,
        );
    } else {
        if (!exeName) {
            const capture = await getActiveCapture();
            if (!capture.exeName) {
                return {
                    success: false,
                    error: 'Could not determine the active capture executable. Set up an OBS capture first.',
                };
            }
            exeName = capture.exeName;
        }
        const foundTarget =
            typeof options.pidOverride === 'number' && options.pidOverride > 0
                ? {
                      pid: options.pidOverride,
                      exeName,
                      arch: archOverride ?? (await detectProcessArch(options.pidOverride)),
                  }
                : await findProcessByExeName(exeName);
        target = foundTarget && archOverride ? { ...foundTarget, arch: archOverride } : foundTarget;
    }

    if (!target) {
        return {
            success: false,
            error: `Could not find a running process named "${exeName}". Is the game running?`,
        };
    }

    // Keep this independent of attachment success: elevation can be why attaching fails.
    gamePrivilegeMonitor.setTarget('texthook', { exeName: target.exeName, pid: target.pid });
    void gamePrivilegeMonitor.check();

    let sceneId = options.sceneId?.trim() ?? '';
    if (!sceneId) {
        sceneId = (await getCurrentScene())?.id ?? '';
    }
    const profile = getProfileFor(exeName, sceneId);
    const flushDelayMs = normalizeFlushDelayMs(options.flushDelayMs ?? profile?.flushDelayMs);
    if (generation !== startGeneration) return { success: false, error: 'Text hook start was cancelled.' };
    if (engine === 'agent') {
        const scriptPath =
            typeof options.agentScriptPath === 'string' && options.agentScriptPath.trim().length > 0
                ? options.agentScriptPath.trim()
                : profile?.engine === 'agent'
                    ? profile.agentScriptPath ?? ''
                    : '';
        const agentOptions = {
            pid: target.pid,
            exeName,
            arch: target.arch,
            scriptPath,
            flushDelayMs,
            copyToClipboard: options.copyToClipboard ?? profile?.copyToClipboard ?? false,
            source,
            maxBufferSize: textHookMaxBufferSize,
            wineLaunch: wineLaunch ?? undefined,
        };
        const runDetached =
            isWindows() &&
            (options.agentDetached ?? (profile?.engine === 'agent' ? profile.agentDetached !== false : true));
        if (runDetached) {
            return startDetachedAgentHookSession({
                pid: agentOptions.pid,
                exeName: agentOptions.exeName,
                arch: agentOptions.arch,
                scriptPath: agentOptions.scriptPath,
                flushDelayMs: agentOptions.flushDelayMs,
                copyToClipboard: agentOptions.copyToClipboard,
                source: agentOptions.source,
                maxBufferSize: agentOptions.maxBufferSize,
            });
        }
        return startAgentHookSession(agentOptions);
    }

    let cliPath = getEngineCliPath(engine, target.arch);
    if (!fs.existsSync(cliPath) || !isTexthookInstalled()) {
        mainWindow?.webContents.send('texthook.engineDownloadStarted', {});
        try {
            await downloadTexthookEngines((progress) => {
                mainWindow?.webContents.send('texthook.engineDownloadProgress', progress);
            });
            mainWindow?.webContents.send('texthook.engineDownloadComplete', { success: true });
        } catch (err) {
            const error = (err as Error).message;
            mainWindow?.webContents.send('texthook.engineDownloadComplete', { success: false, error });
            return { success: false, error: `Hook engine download failed: ${error}` };
        }
        cliPath = getEngineCliPath(engine, target.arch);
        if (!fs.existsSync(cliPath)) {
            return { success: false, error: 'Hook engine binary still missing after download.' };
        }
    }

    if (generation !== startGeneration) return { success: false, error: 'Text hook start was cancelled.' };
    try {
        return await nativeTextHook<StartHookResult>('start', {
            engine, cliPath, cliPaths: { x86: getEngineCliPath(engine, 'x86'), x64: getEngineCliPath(engine, 'x64') },
            arch: target.arch, pid: target.pid, attachPid: target.pid,
            exeName, source, flushDelayMs, maxBufferSize: textHookMaxBufferSize,
            copyToClipboard: options.copyToClipboard ?? profile?.copyToClipboard ?? false,
            autoSelectHookId: profile?.engine === engine && profile.autoHook ? profile.hookId : null,
            autoSelectHookFunction: profile?.engine === engine && profile.autoHook ? profile.hookFunction : null,
            manualHookCode: profile?.engine === engine && profile.autoHook ? profile.manualHookCode : null,
            architectureFallbackAttempted: options.architectureFallbackAttempted === true,
            launcherPath: wineLaunch?.launcherPath, env: wineLaunch?.env, wineLaunch, baseDir: BASE_DIR,
        });
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

function teardownSession(): void {
    ++startGeneration;
    nativeTextHookSync('stop');
}

export function stopHookSession(): void {
    gamePrivilegeMonitor.setTarget('texthook', null);
    teardownSession();
    stopAgentHookSession();
}

export async function stopHookSessionAndWait(): Promise<{ success: boolean; error?: string }> {
    gamePrivilegeMonitor.setTarget('texthook', null);
    teardownSession();
    return stopAgentHookSessionAndWait();
}

export interface SelectHookOptions {
    silent?: boolean;
}

export async function selectHook(hookId: string, options: SelectHookOptions = {}): Promise<boolean> {
    if (isAgentHookRunning()) {
        return listAgentHooks().selectedHookId === hookId;
    }
    const result = await nativeTextHook<boolean>('select', { hookId });
    if (result && !options.silent) emitLog(`Selected hook ${hookId}.`);
    return result;
}

export function attachManualHookCode(code: string): { success: boolean; error?: string } {
    if (isAgentHookRunning()) {
        return { success: false, error: 'Manual H/R-code hooks are not used by Agent sessions.' };
    }
    try { return nativeTextHookSync('manual', { code }); }
    catch (error) { return { success: false, error: (error as Error).message }; }
}

export function getRuntimeStatus() {
    const agentStatus = getAgentHookRuntimeStatus();
    if (agentStatus) {
        return agentStatus;
    }
    return nativeCliStatus();
}

export function setFlushDelayMs(value: number): { success: boolean; flushDelayMs?: number; error?: string } {
    const normalizedValue = normalizeFlushDelayMs(value);
    if (isAgentHookRunning()) {
        return setAgentFlushDelayMs(normalizedValue);
    }
    if (!nativeCliStatus().running) return { success: false, error: 'No active text hook session.' };
    nativeTextHookSync('configure', { flushDelayMs: normalizedValue });
    return { success: true, flushDelayMs: normalizedValue };
}

export function setCopyToClipboard(value: boolean): { success: boolean; copyToClipboard?: boolean; error?: string } {
    if (isAgentHookRunning()) {
        return setAgentCopyToClipboard(value);
    }
    if (!nativeCliStatus().running) return { success: false, error: 'No active text hook session.' };
    nativeTextHookSync('configure', { copyToClipboard: value });
    return { success: true, copyToClipboard: value };
}

export function setTextHookUserStartListener(listener: TextHookUserActionListener | null): void {
    userStartListener = listener;
}

export function setTextHookUserStopListener(listener: TextHookUserActionListener | null): void {
    userStopListener = listener;
}

function notifyTextHookUserStart(status: TextHookRuntimeStatus): void {
    try {
        userStartListener?.(status);
    } catch (err) {
        emitLog(`Text hook user-start listener failed: ${(err as Error).message}`, 'warn');
    }
}

function notifyTextHookUserStop(status: TextHookRuntimeStatus): void {
    try {
        userStopListener?.(status);
    } catch (err) {
        emitLog(`Text hook user-stop listener failed: ${(err as Error).message}`, 'warn');
    }
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function registerTextHookIPC(): void {
    ensureNativeEvents();
    setRuntimeTextHookMaxBufferSize(textHookMaxBufferSize);
    configureAgentHookCallbacks({
        onEvent: (channel, payload) => {
            if (channel === 'texthook.status') emitStatus();
            else emitToRenderer(channel, payload);
        },
        onText: forwardTextHookLine,
    });
    configureDetachedAgentCallbacks({
        onEvent: (channel, payload) => {
            if (channel === 'texthook.status') emitStatus();
            else emitToRenderer(channel, payload);
        },
        onText: (payload) =>
            forwardTextHookLine(payload as Parameters<typeof sendTextHookLine>[0]),
    });
    void reconnectDetachedAgentHookSession().then((connected) => {
        if (connected) {
            emitStatus();
            emitHooks();
        }
    });
    ipcMain.handle('texthook.getStatus', async () => {
        await reconnectDetachedAgentHookSession();
        return getRuntimeStatus();
    });
    ipcMain.handle('texthook.getSettings', async () => ({
        maxBufferSize: textHookMaxBufferSize,
        targetLanguage: getConfiguredTargetLanguage(GSM_CONFIG_FILE),
    }));
    ipcMain.handle('texthook.setMaxBufferSize', async (_event, value: unknown) =>
        setTextHookMaxBufferSize(value),
    );

    ipcMain.handle('texthook.getActiveCapture', async () => {
        try {
            return await getActiveCapture();
        } catch (err) {
            return {
                sceneName: '',
                sceneId: '',
                exeName: null,
                windowTitle: null,
                error: (err as Error).message,
            };
        }
    });

    ipcMain.handle('texthook.start', async (_event, options: StartHookOptions | undefined) => {
        const result = await startHookSession(options ?? {});
        if (result.success) {
            notifyTextHookUserStart(getRuntimeStatus());
        }
        return result;
    });

    ipcMain.handle('texthook.stop', async () => {
        const statusBeforeStop = getRuntimeStatus();
        const result = await stopHookSessionAndWait();
        if (result.success && statusBeforeStop.running) {
            notifyTextHookUserStop(statusBeforeStop);
        }
        return result;
    });

    ipcMain.handle('texthook.selectHook', async (_event, hookId: string) => {
        const ok = await selectHook(String(hookId ?? ''));
        return { success: ok };
    });

    ipcMain.handle('texthook.attachManualHook', async (_event, code: string) =>
        attachManualHookCode(String(code ?? '')),
    );

    ipcMain.handle('texthook.setFlushDelay', async (_event, value: number) =>
        setFlushDelayMs(Number(value)),
    );

    ipcMain.handle('texthook.setCopyToClipboard', async (_event, value: boolean) =>
        setCopyToClipboard(Boolean(value)),
    );

    ipcMain.handle('texthook.listHooks', async () => {
        if (isAgentHookRunning()) return listAgentHooks();
        return nativeTextHook('hooks');
    });

    // The experimental runtime is retired; its sources, support scripts and documentation remain.
    ipcMain.handle('texthook.builtInHookTargets', async () => []);
    ipcMain.handle('texthook.advance', async () => ({ success: false, error: 'Built-in engine hooks are unavailable.' }));

    ipcMain.handle('texthook.showAgentUi', async () => showAgentScriptUi());

    ipcMain.handle('texthook.devSendLargePayload', async (_event, text: unknown) => {
        const payload = typeof text === 'string' ? text : '';
        if (!payload) {
            return { success: false };
        }
        const hookId = 'dev-large-payload';
        const result = sendSelectedHookText({
            text: payload,
            hookId,
            hookFunction: hookId,
            engine: 'luna',
            exeName: hookId,
            copyToClipboard: false,
        });
        if (!result) {
            return {
                success: false,
                blockedByHardLimit: payload.length > HARD_TEXT_HOOK_REJECTION_LIMIT,
                limit: HARD_TEXT_HOOK_REJECTION_LIMIT,
            };
        }
        return {
            success: true,
            length: result.text.length,
            originalLength: payload.length,
            truncated: result.truncated,
        };
    });

    ipcMain.handle('texthook.agentUiRpcCall', async (_event, func: string, args: unknown[] | undefined) =>
        callAgentUiRpc(String(func ?? ''), Array.isArray(args) ? args : []),
    );

    ipcMain.handle('texthook.agentUiRpcSend', async (_event, func: string, args: unknown[] | undefined) =>
        sendAgentUiRpc(String(func ?? ''), Array.isArray(args) ? args : []),
    );

    ipcMain.handle(
        'texthook.saveProfile',
        async (
            _event,
            payload:
                | {
                      exeName?: string;
                      sceneId?: string;
                      engine?: TextHookEngine;
                      autoHook?: boolean;
                      flushDelayMs?: number;
                      hookId?: string | null;
                      hookFunction?: string | null;
                      manualHookCode?: string | null;
                      agentScriptPath?: string | null;
                      agentDetached?: boolean;
                      copyToClipboard?: boolean;
                  }
                | undefined,
        ) => {
            if (!payload || typeof payload.exeName !== 'string' || payload.exeName.trim().length === 0) {
                return { success: false, error: 'exeName is required' };
            }
            const engine: TextHookEngine =
                payload.engine === 'textractor' || payload.engine === 'agent' || payload.engine === 'mages'
                    ? payload.engine
                    : 'luna';
            const profile = upsertProfile({
                exeName: payload.exeName,
                sceneId: payload.sceneId?.trim() || undefined,
                engine,
                autoHook: payload.autoHook !== false,
                flushDelayMs: normalizeFlushDelayMs(payload.flushDelayMs),
                hookId: payload.hookId ?? null,
                hookFunction: payload.hookFunction ?? null,
                manualHookCode: payload.manualHookCode ?? null,
                agentScriptPath: payload.agentScriptPath ?? null,
                agentDetached: engine === 'agent' ? payload.agentDetached !== false : false,
                copyToClipboard: payload.copyToClipboard === true,
                lastUsed: Date.now(),
            });
            return { success: true, profile };
        },
    );

    ipcMain.handle('texthook.getProfile', async (_event, payload: string | { exeName?: string; sceneId?: string }) =>
        typeof payload === 'string'
            ? getProfileFor(payload)
            : getProfileFor(String(payload?.exeName ?? ''), String(payload?.sceneId ?? '')),
    );

    ipcMain.handle('texthook.deleteProfile', async (_event, payload: string | { exeName?: string; sceneId?: string }) => {
        if (typeof payload === 'string') deleteProfile(payload);
        else deleteProfile(String(payload?.exeName ?? ''), String(payload?.sceneId ?? ''));
        return { success: true };
    });

    ipcMain.handle('texthook.getAllProfiles', async () => loadAllProfiles());

    ipcMain.handle('texthook.getGameExePath', async (_event, sceneName: string) =>
        getGameExePathForScene(String(sceneName ?? '')),
    );

    ipcMain.handle(
        'texthook.setGameExePath',
        async (_event, payload: { sceneName?: string; path?: string } | undefined) => {
            const sceneName = String(payload?.sceneName ?? '').trim();
            const exePath = String(payload?.path ?? '').trim();
            if (!sceneName) {
                return { success: false, error: 'sceneName is required' };
            }
            setGameExePathForScene(sceneName, exePath);
            // Only the active scene drives process pausing, and editing another scene leaves it alone.
            syncProcessPausingTargetForCurrentScene();
            return { success: true };
        },
    );

    ipcMain.handle('texthook.browseGameExe', async () => {
        const options: Electron.OpenDialogOptions = {
            title: 'Select the game executable',
            properties: ['openFile'],
            filters: [
                { name: 'Executables', extensions: ['exe'] },
                { name: 'All Files', extensions: ['*'] },
            ],
        };
        const result =
            mainWindow instanceof BrowserWindow
                ? await dialog.showOpenDialog(mainWindow, options)
                : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
            return { canceled: true, path: '' };
        }
        return { canceled: false, path: result.filePaths[0] };
    });

    ipcMain.handle('texthook.autoDetectGameExe', async () => {
        try {
            const resp = await fetch(gsmBackendUrl('/linux/detect_game_exe'));
            if (!resp.ok) {
                return { path: '', error: `HTTP ${resp.status}` };
            }
            const data = (await resp.json()) as { path?: string };
            return { path: typeof data?.path === 'string' ? data.path : '' };
        } catch (err) {
            return { path: '', error: (err as Error).message };
        }
    });

    ipcMain.handle('texthook.getEngineStatus', () => getEngineUpdates().getState());
    ipcMain.handle('texthook.checkEngineUpdates', () => getEngineUpdates().check(false));
    ipcMain.handle('texthook.installEngineVersion', (_event, version: unknown) => {
        if (typeof version !== 'string') throw new Error('Invalid engine package version.');
        return getEngineUpdates().downloadVersion(version);
    });
    ipcMain.handle('texthook.downloadEngines', () => getEngineUpdates().download());
    ipcMain.handle('texthook.setAutomaticEngineUpdates', (_event, enabled: unknown) => {
        if (typeof enabled !== 'boolean') throw new Error('Expected an automatic updates preference.');
        getEngineUpdates().setAutomatic(enabled);
        return getEngineUpdates().getState();
    });
}

export function checkForTexthookUpdates(): void {
    getEngineUpdates().start();
}

// Used by main.ts on app shutdown to make sure the CLI process is killed.
export function shutdownTextHook(): void {
    engineUpdates?.dispose();
    teardownSession();
    shutdownAgentHookSession();
}

export async function shutdownTextHookForUpdate(): Promise<void> {
    engineUpdates?.dispose();
    teardownSession();
    stopLocalAgentHookSession();
    await shutdownDetachedAgentHostForUpdate();
}

// Exported for tests.
export const __test = {
    normalizeProfile,
    sanitizeFilename,
    isValidHookCode,
    readPortableExecutableBitness,
    normalizeFlushDelayMs,
    normalizeTextHookMaxBufferSize,
    sanitizeTextHookText,
    selectGameProcess,
    collectDescendants,
    processBaseName,
    LAUNCHER_MEMORY_FLOOR,
    DEFAULT_FLUSH_DELAY_MS,
    MAX_FLUSH_DELAY_MS,
    DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE,
    HARD_TEXT_HOOK_REJECTION_LIMIT,
    MAX_JAPANESE_QUOTE_PAIRS,
};
