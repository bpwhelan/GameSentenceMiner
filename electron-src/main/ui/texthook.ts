// electron-src/main/ui/texthook.ts
//
// Text Hooking integration for GameSentenceMiner.
//
// Spawns the bundled Textractor or Luna Hook CLI to attach to a running game
// process (auto-detected from the active OBS scene capture), enumerates hook
// candidates, and forwards text from a selected hook to the Python backend
// over the existing GSMSTDIN/GSMMSG IPC channel.
//
// Inspired by the Sugoi Hook project (https://github.com/sugoi-toolkit-official/sugoi-hook),
// rewritten from scratch to fit the GSM Electron architecture. Bundled
// Textractor and Luna Hook binaries are GPL-3.0; see assets/texthook/NOTICE.md.

import { spawn, ChildProcessWithoutNullStreams, execFile, exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'node:fs';
import { ipcMain } from 'electron';
import {
    BASE_DIR,
    getAssetsDir,
    isWindows,
    sanitizeFilename,
} from '../util.js';
import { mainWindow, sendTextHookLine } from '../main.js';
import {
    getCurrentScene,
    getExecutableNameFromSource,
} from './obs.js';
import {
    getAgentHookRuntimeStatus,
    isAgentHookRunning,
    listAgentHooks,
    setAgentFlushDelayMs,
    startAgentHookSession,
    stopAgentHookSession,
} from './agent.js';

const execFileAsync = promisify(execFile);

export type TextHookEngine = 'textractor' | 'luna' | 'agent';
export type TextHookArchitecture = 'x86' | 'x64';

export interface TextHookProfile {
    /** Lower-case executable name (e.g. "game.exe") used as the lookup key. */
    exeName: string;
    engine: TextHookEngine;
    /** Auto-attach to the saved hook the moment it appears. */
    autoHook: boolean;
    /** Debounce window before forwarding selected hook output to GSM. */
    flushDelayMs: number;
    /** Stored hook id from the engine output. */
    hookId?: string | null;
    /** Function/thread name shown in the hook list, used as a fallback when ids change. */
    hookFunction?: string | null;
    /** Manual H-/R-code, when set the engine is asked to attach this hook directly. */
    manualHookCode?: string | null;
    /** Agent script path used when engine is "agent". */
    agentScriptPath?: string | null;
    lastUsed: number;
}

interface HookEntry {
    id: string;
    function: string;
    preview: string;
    samples: string[];
}

interface ActiveSession {
    proc: ChildProcessWithoutNullStreams;
    engine: Exclude<TextHookEngine, 'agent'>;
    arch: TextHookArchitecture;
    pid: number;
    exeName: string;
    selectedHookId: string | null;
    hooks: Map<string, HookEntry>;
    /** Hook id we will auto-select when it shows up (loaded from a profile). */
    autoSelectHookId: string | null;
    /** Function name we will auto-select if id no longer matches. */
    autoSelectHookFunction: string | null;
    /** Manual hook code to attach once after process attach (from saved profile). */
    pendingManualHookCode: string | null;
    /** Pending raw stdout bytes (UTF-16LE half-character carry over). */
    stdoutCarry: Buffer;
    /** Pending UTF-16 decoded line carry. */
    lineCarry: string;
    /** Last hook line, used for multiline hook text continuations. */
    lastHookForContinuation: { id: string; function: string; ignored: boolean } | null;
    /** Debounced selected-hook text waiting to be forwarded. */
    outputCollector: TextHookOutputPayload[];
    outputFlushTimer: NodeJS.Timeout | null;
    flushDelayMs: number;
    pidWatcher?: NodeJS.Timeout;
}

let session: ActiveSession | null = null;

const TEXTRACTOR_HOOK_LINE = /^\[([0-9a-fA-F]+):([^:]+):([^:]+):([^:]+):([^:]+):([^:]+):([^\]]+)\] (.*)$/;
const LUNA_HOOK_LINE = /^\[#([0-9a-fA-F]+)\|([^\]]+)\] (.*)$/;
const LUNA_HOOK_CREATED_LINE = /^\[Hook #([0-9a-fA-F]+) created\] Handle: ([0-9a-fA-F]+)$/;
const CONSOLE_LINE = /^\[Console\] (.+)$/;

const PROFILES_FILE = path.join(BASE_DIR, 'texthook', 'profiles.json');
const DEFAULT_FLUSH_DELAY_MS = 100;
const MAX_FLUSH_DELAY_MS = 5000;

interface TextHookOutputPayload {
    text: string;
    hookId: string;
    hookFunction: string;
    engine: Exclude<TextHookEngine, 'agent'>;
    exeName: string;
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

function emitStatus(): void {
    emitToRenderer('texthook.status', getRuntimeStatus());
}

function emitLog(message: string, level: 'info' | 'error' | 'warn' = 'info'): void {
    emitToRenderer('texthook.log', { message, level, ts: Date.now() });
}

function emitHooks(): void {
    if (!session) {
        emitToRenderer('texthook.hooks', { hooks: [], selectedHookId: null });
        return;
    }
    emitToRenderer('texthook.hooks', {
        hooks: Array.from(session.hooks.values()),
        selectedHookId: session.selectedHookId,
    });
}

// ---------------------------------------------------------------------------
// Asset paths
// ---------------------------------------------------------------------------

function getEngineCliPath(engine: TextHookEngine, arch: TextHookArchitecture): string {
    const base = path.join(getAssetsDir(), 'texthook');
    if (engine === 'luna') {
        return path.join(base, 'luna_builds', arch === 'x86' ? 'LunaHostCLI32.exe' : 'LunaHostCLI64.exe');
    }
    return path.join(
        base,
        'textractor_builds',
        arch === 'x86' ? '_x86' : '_x64',
        'TextractorCLI.exe',
    );
}

// ---------------------------------------------------------------------------
// Process detection (Windows-first via tasklist)
// ---------------------------------------------------------------------------

interface ProcessEntry {
    pid: number;
    exeName: string;
    arch: TextHookArchitecture;
}

/** Read the PE header from disk to determine bitness — same approach as auto_launcher.ts. */
function readPortableExecutableBitness(executablePath: string): TextHookArchitecture {
    let fd: number | null = null;
    try {
        fd = fs.openSync(executablePath, 'r');
        const dosHeader = Buffer.alloc(64);
        fs.readSync(fd, dosHeader, 0, 64, 0);
        if (dosHeader.readUInt16LE(0) !== 0x5a4d) return 'x64'; // not MZ
        const peOffset = dosHeader.readUInt32LE(0x3c);
        const peHeader = Buffer.alloc(6);
        fs.readSync(fd, peHeader, 0, 6, peOffset);
        if (peHeader.toString('ascii', 0, 4) !== 'PE\u0000\u0000') return 'x64';
        const machine = peHeader.readUInt16LE(4);
        return machine === 0x14c ? 'x86' : 'x64';
    } catch {
        return 'x64';
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
}

/** Resolve the on-disk path for a running PID via PowerShell Get-Process.Path. */
async function getProcessExecutablePath(pid: number): Promise<string | null> {
    if (!isWindows() || pid <= 0) return null;
    const cmd = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.Path) { $p.Path }`;
    try {
        const { stdout } = await execFileAsync(
            'powershell',
            ['-NoLogo', '-NoProfile', '-Command', cmd],
            { windowsHide: true, timeout: 4000 },
        );
        const p = stdout.trim();
        return p.length > 0 ? p : null;
    } catch {
        return null;
    }
}

/**
 * Detect process architecture by reading the PE header from the executable on
 * disk. Mirrors the same logic used in auto_launcher.ts getPortableExecutableBitness.
 */
async function detectProcessArch(pid: number): Promise<TextHookArchitecture> {
    if (!isWindows()) return 'x64';
    const exePath = await getProcessExecutablePath(pid);
    if (exePath) return readPortableExecutableBitness(exePath);
    return 'x64';
}

/**
 * Find the best matching process for a given exe name.
 * Mirrors auto_launcher.ts: filters small system processes (mem ≤ 20 KB),
 * then picks the highest-memory candidate so launchers/helpers are skipped.
 */
async function findProcessByExeName(exeName: string): Promise<ProcessEntry | null> {
    if (!isWindows()) {
        emitLog('Process detection is currently only implemented on Windows.', 'warn');
        return null;
    }
    const target = exeName.toLowerCase();
    try {
        const { stdout } = await execFileAsync(
            'tasklist',
            ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${exeName}`],
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        );
        const candidates: Array<{ pid: number; name: string; memory: number }> = [];
        for (const line of stdout.split(/\r?\n/)) {
            // CSV: "Image","PID","Session","Session#","MemUsage"
            const match = line.match(/"([^"]+)",\s*"(\d+)",\s*"[^"]*",\s*"[^"]*",\s*"([^"]+)"/);
            if (!match) continue;
            const name = match[1];
            const pid = parseInt(match[2], 10);
            const memStr = match[3].replace(/[^\d]/g, '');
            const memory = parseInt(memStr, 10);
            if (!Number.isFinite(pid) || pid <= 0) continue;
            if (name.toLowerCase() !== target) continue;
            if (memory <= 20000) continue; // skip tiny system/helper processes
            candidates.push({ pid, name, memory: isNaN(memory) ? 0 : memory });
        }
        if (candidates.length === 0) return null;
        // Pick highest-memory process — most likely the game, not a helper.
        candidates.sort((a, b) => b.memory - a.memory);
        const best = candidates[0];
        const arch = await detectProcessArch(best.pid);
        return { pid: best.pid, exeName: best.name, arch };
    } catch (err) {
        emitLog(`Process lookup failed: ${(err as Error).message}`, 'error');
    }
    return null;
}

async function isPidAlive(pid: number): Promise<boolean> {
    // process.kill(pid, 0) is unreliable on Windows when the target process runs
    // under a different security context or with different privileges.  Use
    // tasklist /FI "PID eq ..." instead — the same approach used in auto_launcher.ts.
    if (isWindows()) {
        return new Promise((resolve) => {
            exec(
                `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
                { windowsHide: true, encoding: 'utf8' },
                (error, stdout) => {
                    if (error) { resolve(false); return; }
                    const out = stdout.trim().toLowerCase();
                    if (out.includes('no tasks are running') || out.length === 0) {
                        resolve(false);
                        return;
                    }
                    // A matching line contains the PID quoted, e.g. "foo.exe","108800",...
                    resolve(out.includes(`"${pid}"`));
                },
            );
        });
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Active capture detection
// ---------------------------------------------------------------------------

export interface ActiveCaptureInfo {
    sceneName: string;
    sceneId: string;
    exeName: string | null;
}

export async function getActiveCapture(): Promise<ActiveCaptureInfo> {
    const scene = await getCurrentScene();
    let exeName: string | null = null;
    if (scene && scene.id) {
        try {
            const found = await getExecutableNameFromSource(scene.id);
            if (typeof found === 'string' && found.trim().length > 0) {
                exeName = found.trim();
            }
        } catch (err) {
            emitLog(`Could not infer executable from active scene: ${(err as Error).message}`, 'warn');
        }
    }
    return {
        sceneName: scene?.name ?? '',
        sceneId: scene?.id ?? '',
        exeName,
    };
}

// ---------------------------------------------------------------------------
// Profile storage
// ---------------------------------------------------------------------------

function ensureProfilesDir(): void {
    fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
}

function loadAllProfiles(): Record<string, TextHookProfile> {
    try {
        if (!fs.existsSync(PROFILES_FILE)) return {};
        const raw = fs.readFileSync(PROFILES_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out: Record<string, TextHookProfile> = {};
        for (const [key, value] of Object.entries(parsed)) {
            const profile = normalizeProfile(value);
            if (profile) {
                out[key.toLowerCase()] = profile;
            }
        }
        return out;
    } catch (err) {
        emitLog(`Failed to load text hook profiles: ${(err as Error).message}`, 'error');
        return {};
    }
}

function normalizeProfile(value: unknown): TextHookProfile | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Partial<TextHookProfile>;
    if (typeof v.exeName !== 'string' || v.exeName.trim().length === 0) return null;
    const engine: TextHookEngine =
        v.engine === 'textractor' || v.engine === 'agent' ? v.engine : 'luna';
    return {
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

function saveAllProfiles(profiles: Record<string, TextHookProfile>): void {
    try {
        ensureProfilesDir();
        fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
    } catch (err) {
        emitLog(`Failed to write text hook profiles: ${(err as Error).message}`, 'error');
    }
}

export function getProfileFor(exeName: string): TextHookProfile | null {
    if (!exeName) return null;
    const profiles = loadAllProfiles();
    return profiles[exeName.toLowerCase()] ?? null;
}

export function upsertProfile(profile: TextHookProfile): TextHookProfile {
    const all = loadAllProfiles();
    const normalized: TextHookProfile = {
        ...profile,
        exeName: profile.exeName.toLowerCase(),
        flushDelayMs: normalizeFlushDelayMs(profile.flushDelayMs),
        lastUsed: Date.now(),
    };
    all[normalized.exeName] = normalized;
    saveAllProfiles(all);
    return normalized;
}

export function deleteProfile(exeName: string): void {
    const all = loadAllProfiles();
    if (delete all[exeName.toLowerCase()]) {
        saveAllProfiles(all);
    }
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

function isIgnorableEngineLine(line: string): boolean {
    return (
        line.startsWith('Usage:') ||
        line.startsWith('After attaching,') ||
        line.startsWith('After 10 texts,') ||
        line === 'Commands:' ||
        line.startsWith('attach -P') ||
        line.startsWith('detach -P') ||
        line.startsWith('select <handle>') ||
        line.startsWith('showall') ||
        line === '=== HOOK SELECTION ===' ||
        line === "You've seen text from multiple hooks above." ||
        line.startsWith('To select specific hooks') ||
        line.startsWith('Example: select') ||
        line.startsWith('To see all hooks') ||
        line.startsWith('To continue with current selection') ||
        line === '======================' ||
        line === 'Now showing text from all hooks.' ||
        line === 'Now showing text only from selected hook.' ||
        /^Selected hook #[0-9a-fA-F]+(?: \(Handle: [0-9a-fA-F]+\))?(?:Now showing text only from selected hook\.)?$/.test(line)
    );
}

function isIgnoredTextractorHook(fn: string, hookCode: string): boolean {
    // Textractor exposes host internals as normal text threads. Console lines
    // are status messages, and Clipboard often echoes unrelated copied text.
    return fn === 'Console' || fn === 'Clipboard' || hookCode === 'HB0@0';
}

function parseLunaContext(hookNumber: string, context: string): { id: string; function: string } {
    const parts = context.split(':');
    const functionName = parts.length > 5 ? parts[5] : parts[parts.length - 2] || 'Unknown';
    return { id: hookNumber, function: functionName || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Output parsing (UTF-16LE)
// ---------------------------------------------------------------------------

function decodeStdout(chunk: Buffer): string {
    if (!session) return '';
    const buf = Buffer.concat([session.stdoutCarry, chunk]);
    // Keep a trailing odd byte for the next round so we never split a UTF-16 unit.
    const usableLen = buf.length - (buf.length % 2);
    const decoded = buf.slice(0, usableLen).toString('utf16le');
    session.stdoutCarry = buf.slice(usableLen);
    return decoded;
}

function consumeLines(text: string): string[] {
    if (!session) return [];
    const combined = session.lineCarry + text;
    const lines = combined.split(/\r?\n/);
    session.lineCarry = lines.pop() ?? '';
    return lines.map((l) => l.replace(/\u0000+$/, ''));
}

function handleStdoutChunk(chunk: Buffer): void {
    if (!session) return;
    const decoded = decodeStdout(chunk);
    if (!decoded) return;
    const lines = consumeLines(decoded);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        handleLine(line);
    }
}

function handleLine(line: string): void {
    if (!session) return;
    if (isIgnorableEngineLine(line)) {
        session.lastHookForContinuation = null;
        return;
    }

    const consoleMatch = CONSOLE_LINE.exec(line);
    if (consoleMatch) {
        emitLog(`[Engine] ${consoleMatch[1]}`);
        session.lastHookForContinuation = null;
        return;
    }

    if (session.engine === 'textractor') {
        const m = TEXTRACTOR_HOOK_LINE.exec(line);
        if (!m) {
            if (session.lastHookForContinuation && !line.startsWith('[')) {
                const last = session.lastHookForContinuation;
                if (!last.ignored) {
                    recordHookEvent(last.id, last.function, line);
                }
                return;
            }
            // Log raw unmatched output so format issues can be diagnosed.
            emitLog(`[raw] ${line}`);
            session.lastHookForContinuation = null;
            return;
        }
        const fn = m[6];
        const hookCode = m[7];
        const text = m[8];
        if (fn === 'Console') {
            emitLog(`[Engine] ${text}`);
            session.lastHookForContinuation = null;
            return;
        }
        const ignored = isIgnoredTextractorHook(fn, hookCode);
        session.lastHookForContinuation = { id: m[1], function: fn, ignored };
        if (!ignored) {
            recordHookEvent(m[1], fn, text);
        }
    } else {
        const created = LUNA_HOOK_CREATED_LINE.exec(line);
        if (created) {
            recordHookEvent(created[1], `Hook #${created[1]}`, '');
            session.lastHookForContinuation = null;
            return;
        }
        const m = LUNA_HOOK_LINE.exec(line);
        if (!m) {
            if (session.lastHookForContinuation && !line.startsWith('[')) {
                const last = session.lastHookForContinuation;
                recordHookEvent(last.id, last.function, line);
                return;
            }
            emitLog(`[raw] ${line}`);
            session.lastHookForContinuation = null;
            return;
        }
        const parsed = parseLunaContext(m[1], m[2]);
        session.lastHookForContinuation = { id: parsed.id, function: parsed.function, ignored: false };
        recordHookEvent(parsed.id, parsed.function, m[3]);
    }
}

function recordHookEvent(hookId: string, fn: string, text: string): void {
    if (!session) return;
    let entry = session.hooks.get(hookId);
    if (!entry) {
        entry = {
            id: hookId,
            function: fn,
            preview: '',
            samples: [],
        };
        session.hooks.set(hookId, entry);
    } else if (fn && entry.function !== fn && /^Hook #/.test(entry.function)) {
        entry.function = fn;
    }
    if (text) {
        entry.preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
        if (entry.samples.length < 3) {
            entry.samples.push(text);
        }
    }
    emitHooks();

    if (!session.selectedHookId) {
        const functionMatches =
            !session.autoSelectHookFunction || entry.function === session.autoSelectHookFunction;
        const idMatches = Boolean(session.autoSelectHookId && hookId === session.autoSelectHookId);
        const functionFallbackMatches = Boolean(
            session.autoSelectHookFunction &&
                entry.function === session.autoSelectHookFunction &&
                (!session.autoSelectHookId || !idMatches),
        );

        if ((idMatches && functionMatches) || functionFallbackMatches) {
            void selectHook(hookId, { silent: true });
        }
    }

    if (session.selectedHookId === hookId && text) {
        queueSelectedHookText({
            text,
            hookId,
            hookFunction: fn,
            engine: session.engine,
            exeName: session.exeName,
        });
    }
}

function sendSelectedHookText(payload: TextHookOutputPayload): void {
    sendTextHookLine(payload);
    emitToRenderer('texthook.text', {
        hookId: payload.hookId,
        text: payload.text,
        ts: Date.now(),
    });
}

function flushSelectedHookText(): void {
    if (!session) return;
    if (session.outputFlushTimer) {
        clearTimeout(session.outputFlushTimer);
        session.outputFlushTimer = null;
    }
    if (session.outputCollector.length === 0) return;

    const pending = session.outputCollector;
    session.outputCollector = [];
    const merged = mergeTextHookOutput(pending);
    if (merged) sendSelectedHookText(merged);
}

function mergeTextHookOutput(pending: TextHookOutputPayload[]): TextHookOutputPayload | null {
    if (pending.length === 0) return null;
    if (pending.length === 1) return pending[0];
    const last = pending[pending.length - 1];
    return {
        ...last,
        text: pending.map((item) => item.text).join('\n'),
    };
}

function queueSelectedHookText(payload: TextHookOutputPayload): void {
    if (!session) return;
    const delayMs = normalizeFlushDelayMs(session.flushDelayMs);
    if (delayMs <= 0) {
        sendSelectedHookText(payload);
        return;
    }

    session.outputCollector.push(payload);
    if (session.outputFlushTimer) {
        clearTimeout(session.outputFlushTimer);
    }
    session.outputFlushTimer = setTimeout(() => {
        flushSelectedHookText();
    }, delayMs);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function writeEngineCommand(
    proc: ChildProcessWithoutNullStreams,
    command: string,
): Promise<Error | null> {
    return new Promise((resolve) => {
        proc.stdin.write(Buffer.from(command, 'utf16le'), (err) => resolve(err ?? null));
    });
}

function queueEngineCommand(
    proc: ChildProcessWithoutNullStreams,
    command: string,
    onError: (err: Error) => void,
): void {
    proc.stdin.write(Buffer.from(command, 'utf16le'), (err) => {
        if (err) onError(err);
    });
}

export interface StartHookOptions {
    engine?: TextHookEngine;
    exeName?: string | null;
    flushDelayMs?: number;
    agentScriptPath?: string | null;
    /** Override the auto-detected PID (mainly for tests). */
    pidOverride?: number;
}

export interface StartHookResult {
    success: boolean;
    error?: string;
    pid?: number;
    exeName?: string;
    arch?: TextHookArchitecture;
}

export async function startHookSession(options: StartHookOptions = {}): Promise<StartHookResult> {
    if (session || isAgentHookRunning()) {
        return { success: false, error: 'A text hook session is already running.' };
    }
    if (!isWindows()) {
        return { success: false, error: 'Text hooking is currently only available on Windows.' };
    }

    const engine: TextHookEngine =
        options.engine === 'textractor' || options.engine === 'agent' ? options.engine : 'luna';
    let exeName = (options.exeName ?? '').trim();
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

    const target =
        typeof options.pidOverride === 'number' && options.pidOverride > 0
            ? {
                  pid: options.pidOverride,
                  exeName,
                  arch: await detectProcessArch(options.pidOverride),
              }
            : await findProcessByExeName(exeName);
    if (!target) {
        return {
            success: false,
            error: `Could not find a running process named "${exeName}". Is the game running?`,
        };
    }

    const profile = getProfileFor(exeName);
    const flushDelayMs = normalizeFlushDelayMs(options.flushDelayMs ?? profile?.flushDelayMs);
    if (engine === 'agent') {
        const scriptPath =
            typeof options.agentScriptPath === 'string' && options.agentScriptPath.trim().length > 0
                ? options.agentScriptPath.trim()
                : profile?.engine === 'agent'
                    ? profile.agentScriptPath ?? ''
                    : '';
        return startAgentHookSession({
            pid: target.pid,
            exeName,
            arch: target.arch,
            scriptPath,
            flushDelayMs,
        });
    }

    const cliPath = getEngineCliPath(engine, target.arch);
    if (!fs.existsSync(cliPath)) {
        return { success: false, error: `Hook engine binary missing: ${cliPath}` };
    }

    const cliDir = path.dirname(cliPath);
    let proc: ChildProcessWithoutNullStreams;
    try {
        proc = spawn(cliPath, [], {
            cwd: cliDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, PATH: `${cliDir};${process.env.PATH ?? ''}` },
        });
    } catch (err) {
        return { success: false, error: `Failed to spawn hook engine: ${(err as Error).message}` };
    }

    if (!proc.pid) {
        return { success: false, error: 'Failed to spawn hook engine (no pid).' };
    }

    session = {
        proc,
        engine,
        arch: target.arch,
        pid: target.pid,
        exeName,
        selectedHookId: null,
        hooks: new Map(),
        autoSelectHookId: profile && profile.engine === engine && profile.autoHook ? profile.hookId ?? null : null,
        autoSelectHookFunction:
            profile && profile.engine === engine && profile.autoHook ? profile.hookFunction ?? null : null,
        pendingManualHookCode:
            profile && profile.engine === engine && profile.autoHook ? profile.manualHookCode ?? null : null,
        stdoutCarry: Buffer.alloc(0),
        lineCarry: '',
        lastHookForContinuation: null,
        outputCollector: [],
        outputFlushTimer: null,
        flushDelayMs,
    };

    proc.stdout.on('data', handleStdoutChunk);
    proc.stderr.on('data', (data: Buffer) => emitLog(`[stderr] ${data.toString('utf-8')}`, 'warn'));
    proc.on('exit', (code, signal) => {
        emitLog(`Hook engine exited (code=${code ?? 'null'} signal=${signal ?? 'null'}).`);
        teardownSession();
    });
    proc.on('error', (err) => {
        emitLog(`Hook engine error: ${err.message}`, 'error');
    });

    // Attach to the target PID. These CLI builds read stdin as UTF-16LE wide
    // text, matching Sugoi Hook's subprocess encoding.
    const attachErr = await writeEngineCommand(proc, `attach -P${target.pid}\n`);
    if (attachErr) {
        teardownSession();
        return { success: false, error: `Failed to attach: ${attachErr.message}` };
    }
    if (!session) return { success: false, error: 'Session torn down during attach.' };

    // If a saved manual hook code exists, queue it after a short delay so the engine
    // has time to finish attaching before we push the H-/R-code in.
    if (session.pendingManualHookCode) {
        const code = session.pendingManualHookCode;
        setTimeout(() => {
            if (session && session.proc === proc) {
                try {
                    queueEngineCommand(proc, `${code} -P${target.pid}\n`, (err) => {
                        emitLog(`Failed to push manual hook code: ${err.message}`, 'error');
                    });
                    emitLog(`Auto-applied saved manual hook: ${code}`);
                } catch (err) {
                    emitLog(`Failed to push manual hook code: ${(err as Error).message}`, 'error');
                }
            }
        }, 1500);
    }

    if (engine === 'luna') {
        setTimeout(() => {
            if (session && session.proc === proc) {
                queueEngineCommand(proc, 'showall\n', (err) => {
                    emitLog(`Failed to enable all Luna hooks: ${err.message}`, 'warn');
                });
            }
        }, 1000);
    }

    // Watch the target process; tear down if it dies.
    session.pidWatcher = setInterval(() => {
        void (async () => {
            if (!session) return;
            const alive = await isPidAlive(session.pid);
            if (!alive) {
                emitLog(`Target PID ${session.pid} (${session.exeName}) is no longer running.`);
                stopHookSession();
            }
        })();
    }, 4000);

    emitLog(`Attached ${engine} (${target.arch}) to ${exeName} (PID ${target.pid}).`);
    emitStatus();
    emitHooks();
    return { success: true, pid: target.pid, exeName, arch: target.arch };
}

function teardownSession(): void {
    if (!session) return;
    flushSelectedHookText();
    if (session.pidWatcher) {
        clearInterval(session.pidWatcher);
        session.pidWatcher = undefined;
    }
    if (session.outputFlushTimer) {
        clearTimeout(session.outputFlushTimer);
        session.outputFlushTimer = null;
    }
    try {
        if (!session.proc.killed) {
            session.proc.kill();
        }
    } catch {
        // ignore
    }
    session = null;
    emitStatus();
    emitHooks();
}

export function stopHookSession(): void {
    teardownSession();
    stopAgentHookSession();
}

export interface SelectHookOptions {
    silent?: boolean;
}

export async function selectHook(hookId: string, options: SelectHookOptions = {}): Promise<boolean> {
    if (isAgentHookRunning()) {
        return hookId === 'agent';
    }
    if (!session) return false;
    if (!session.hooks.has(hookId)) return false;
    flushSelectedHookText();
    try {
        queueEngineCommand(session.proc, `select ${hookId}\n`, (err) => {
            emitLog(`Failed to select hook ${hookId}: ${err.message}`, 'error');
        });
    } catch (err) {
        emitLog(`Failed to select hook ${hookId}: ${(err as Error).message}`, 'error');
        return false;
    }
    session.selectedHookId = hookId;
    if (!options.silent) {
        const entry = session.hooks.get(hookId);
        emitLog(`Selected hook ${hookId}${entry ? ` (${entry.function})` : ''}.`);
    }
    emitHooks();
    return true;
}

export function attachManualHookCode(code: string): { success: boolean; error?: string } {
    if (isAgentHookRunning()) {
        return { success: false, error: 'Manual H/R-code hooks are not used by Agent sessions.' };
    }
    if (!session) return { success: false, error: 'No active text hook session.' };
    const trimmed = code.trim();
    if (!isValidHookCode(trimmed)) {
        return {
            success: false,
            error: 'Invalid hook code. Expected H- or R-code, e.g. "HB4@0" or "RS@401000".',
        };
    }
    try {
        queueEngineCommand(session.proc, `${trimmed} -P${session.pid}\n`, (err) => {
            emitLog(`Failed to push manual hook code: ${err.message}`, 'error');
        });
        emitLog(`Pushed manual hook code: ${trimmed}`);
        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function getRuntimeStatus() {
    const agentStatus = getAgentHookRuntimeStatus();
    if (agentStatus) {
        return agentStatus;
    }
    if (!session) {
        return { running: false as const };
    }
    return {
        running: true as const,
        engine: session.engine,
        arch: session.arch,
        pid: session.pid,
        exeName: session.exeName,
        selectedHookId: session.selectedHookId,
        hookCount: session.hooks.size,
        flushDelayMs: session.flushDelayMs,
    };
}

export function setFlushDelayMs(value: number): { success: boolean; flushDelayMs?: number; error?: string } {
    if (isAgentHookRunning()) {
        return setAgentFlushDelayMs(normalizeFlushDelayMs(value));
    }
    if (!session) return { success: false, error: 'No active text hook session.' };
    const flushDelayMs = normalizeFlushDelayMs(value);
    session.flushDelayMs = flushDelayMs;
    if (flushDelayMs <= 0) {
        flushSelectedHookText();
    } else if (session.outputCollector.length > 0) {
        if (session.outputFlushTimer) {
            clearTimeout(session.outputFlushTimer);
        }
        session.outputFlushTimer = setTimeout(() => {
            flushSelectedHookText();
        }, flushDelayMs);
    }
    emitStatus();
    return { success: true, flushDelayMs };
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
    ipcMain.handle('texthook.getStatus', async () => getRuntimeStatus());

    ipcMain.handle('texthook.getActiveCapture', async () => {
        try {
            return await getActiveCapture();
        } catch (err) {
            return {
                sceneName: '',
                sceneId: '',
                exeName: null,
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
        stopHookSession();
        if (statusBeforeStop.running) {
            notifyTextHookUserStop(statusBeforeStop);
        }
        return { success: true };
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

    ipcMain.handle('texthook.listHooks', async () => {
        if (isAgentHookRunning()) return listAgentHooks();
        if (!session) return { hooks: [], selectedHookId: null };
        return {
            hooks: Array.from(session.hooks.values()),
            selectedHookId: session.selectedHookId,
        };
    });

    ipcMain.handle(
        'texthook.saveProfile',
        async (
            _event,
            payload:
                | {
                      exeName?: string;
                      engine?: TextHookEngine;
                      autoHook?: boolean;
                      flushDelayMs?: number;
                      hookId?: string | null;
                      hookFunction?: string | null;
                      manualHookCode?: string | null;
                      agentScriptPath?: string | null;
                  }
                | undefined,
        ) => {
            if (!payload || typeof payload.exeName !== 'string' || payload.exeName.trim().length === 0) {
                return { success: false, error: 'exeName is required' };
            }
            const engine: TextHookEngine =
                payload.engine === 'textractor' || payload.engine === 'agent' ? payload.engine : 'luna';
            const profile = upsertProfile({
                exeName: payload.exeName,
                engine,
                autoHook: payload.autoHook !== false,
                flushDelayMs: normalizeFlushDelayMs(payload.flushDelayMs),
                hookId: payload.hookId ?? null,
                hookFunction: payload.hookFunction ?? null,
                manualHookCode: payload.manualHookCode ?? null,
                agentScriptPath: payload.agentScriptPath ?? null,
                lastUsed: Date.now(),
            });
            return { success: true, profile };
        },
    );

    ipcMain.handle('texthook.getProfile', async (_event, exeName: string) =>
        getProfileFor(String(exeName ?? '')),
    );

    ipcMain.handle('texthook.deleteProfile', async (_event, exeName: string) => {
        deleteProfile(String(exeName ?? ''));
        return { success: true };
    });

    ipcMain.handle('texthook.getAllProfiles', async () => loadAllProfiles());
}

// Used by main.ts on app shutdown to make sure the CLI process is killed.
export function shutdownTextHook(): void {
    teardownSession();
    stopAgentHookSession();
}

// Exported for tests.
export const __test = {
    sanitizeFilename,
    isValidHookCode,
    isIgnorableEngineLine,
    normalizeFlushDelayMs,
    mergeTextHookOutput,
    DEFAULT_FLUSH_DELAY_MS,
    MAX_FLUSH_DELAY_MS,
    TEXTRACTOR_HOOK_LINE,
    LUNA_HOOK_LINE,
    LUNA_HOOK_CREATED_LINE,
};
