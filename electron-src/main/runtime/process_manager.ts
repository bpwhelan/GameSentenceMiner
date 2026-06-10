/**
 * ProcessManager — single supervisor/registry for GSM's long-lived child
 * processes (Python backend, OCR, frida helper, ...). It replaces the scattered
 * per-module spawn/kill/restart globals (`pyProc`, `ocrProcess`, ...) and the
 * duplicated graceful-stop timers + `taskkill /T /F` escalation that lived in
 * main.ts and ui/ocr.ts.
 *
 * Liveness is event-driven off the message bus: a process is "ready" once it
 * sends its `hello` (bus client-connected), not by polling its pid. Graceful
 * stop is a bus command on a per-spec topic, escalating to SIGTERM and then a
 * force kill if the process doesn't exit in time.
 */

import { execFile, ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { BrokerStartInfo } from './message_bus.js';

// Kept dependency-free on purpose: util.ts statically imports main.ts, so pulling
// it in here would drag the whole app graph (and its circular init) into anything
// that uses the ProcessManager — including unit tests. Platform specifics that
// the manager can't infer (e.g. Task-Manager-friendly exe names) are injected via
// options instead (see ProcessManagerOptions.resolveExecutable).
const IS_WINDOWS = process.platform === 'win32';
const execFileAsync = promisify(execFile);

export type ProcessState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed';

export type ProcessPriority = 'low' | 'below_normal' | 'normal' | 'above_normal' | 'high';

export interface ProcessSpec {
    /** Stable id; also the bus client id this process connects with. */
    id: string;
    /** Build the executable + args at spawn time (so config changes are picked up). */
    buildCommand: () => { command: string; args: string[] };
    /** Extra env merged over the base spawn env. */
    env?: () => NodeJS.ProcessEnv;
    cwd?: string;
    windowsHide?: boolean | (() => boolean);
    /** Label used to give the Windows process a recognizable name in Task Manager. */
    namedExecutableLabel?: string;
    /** Optional process priority applied after spawn (Windows). */
    priority?: () => ProcessPriority;
    /** How readiness is determined. Default 'hello' (waits for bus connect). */
    readyOn?: 'hello' | 'spawn';
    /** Graceful stop: a bus command (with optional payload) sent before escalating to signals. */
    gracefulStop?: { topic: string; data?: unknown; timeoutMs: number };
    /** Auto-restart policy on unexpected exit. */
    autoRestart?: {
        enabled: boolean;
        initialDelayMs?: number;
        maxDelayMs?: number;
        maxRetries?: number;
    };
    /** Extra substrings used to recognize a stale instance of this process at boot. */
    matchTokens?: string[];
}

/** Minimal surface the manager needs from the broker (kept narrow for testability). */
export interface ReadinessSource {
    isClientConnected(id: string): boolean;
    publish(dst: string, topic: string, data?: unknown, kind?: 'event' | 'command'): void;
    on(event: 'client-connected' | 'client-disconnected', listener: (id: string) => void): unknown;
    off(event: 'client-connected' | 'client-disconnected', listener: (id: string) => void): unknown;
}

export interface ProcessManagerOptions {
    bus: ReadinessSource;
    /** Provides the broker connect info injected into each child's env. */
    getConnectInfo: () => BrokerStartInfo | null;
    /** Base env for every spawn (e.g. getSanitizedPythonEnv()). */
    baseEnv?: () => NodeJS.ProcessEnv;
    /** Returns true when launches/restarts must be suppressed (e.g. updating). */
    launchBlocked?: () => boolean;
    /** Where to persist managed-pid state for stale cleanup. */
    stateFile: string;
    /** Resolve the executable to spawn given a spec's command + label. Defaults to
     *  identity; main.ts passes getWindowsNamedPythonExecutable for friendly names. */
    resolveExecutable?: (command: string, label: string | undefined) => string;
}

interface ManagedEntry {
    spec: ProcessSpec;
    proc: ChildProcess | null;
    state: ProcessState;
    /** True while an intentional stop is in flight (suppresses auto-restart). */
    stopping: boolean;
    stopTimer: NodeJS.Timeout | null;
    forceTimer: NodeJS.Timeout | null;
    restartTimer: NodeJS.Timeout | null;
    restartAttempts: number;
}

interface PersistedProcess {
    pid: number;
    command: string;
    args: string[];
    matchTokens: string[];
}

const SIGTERM_ESCALATION_MS = 1500;
const DEFAULT_RESTART_INITIAL_MS = 1000;
const DEFAULT_RESTART_MAX_MS = 30_000;

const WINDOWS_PRIORITY: Record<ProcessPriority, number> = {
    low: os.constants.priority.PRIORITY_LOW,
    below_normal: os.constants.priority.PRIORITY_BELOW_NORMAL,
    normal: os.constants.priority.PRIORITY_NORMAL,
    above_normal: os.constants.priority.PRIORITY_ABOVE_NORMAL,
    high: os.constants.priority.PRIORITY_HIGH,
};

export class ProcessManager extends EventEmitter {
    private readonly entries = new Map<string, ManagedEntry>();
    private readonly options: ProcessManagerOptions;
    private readonly stateFile: string;

    constructor(options: ProcessManagerOptions) {
        super();
        this.options = options;
        this.stateFile = options.stateFile;
        options.bus.on('client-connected', this.onClientConnected);
        options.bus.on('client-disconnected', this.onClientDisconnected);
    }

    dispose(): void {
        this.options.bus.off('client-connected', this.onClientConnected);
        this.options.bus.off('client-disconnected', this.onClientDisconnected);
    }

    register(spec: ProcessSpec): void {
        if (this.entries.has(spec.id)) {
            throw new Error(`Process "${spec.id}" already registered`);
        }
        this.entries.set(spec.id, {
            spec,
            proc: null,
            state: 'stopped',
            stopping: false,
            stopTimer: null,
            forceTimer: null,
            restartTimer: null,
            restartAttempts: 0,
        });
    }

    getState(id: string): ProcessState {
        return this.entries.get(id)?.state ?? 'stopped';
    }

    getPid(id: string): number | undefined {
        return this.entries.get(id)?.proc?.pid;
    }

    getStatus(): Record<string, { state: ProcessState; pid?: number }> {
        const status: Record<string, { state: ProcessState; pid?: number }> = {};
        for (const [id, entry] of this.entries) {
            status[id] = { state: entry.state, pid: entry.proc?.pid };
        }
        return status;
    }

    isRunning(id: string): boolean {
        const entry = this.entries.get(id);
        return Boolean(entry?.proc && entry.proc.exitCode === null && !entry.proc.killed);
    }

    start(id: string): void {
        const entry = this.requireEntry(id);
        if (this.options.launchBlocked?.()) {
            console.warn(`[ProcessManager] launch of "${id}" blocked (update in progress).`);
            return;
        }
        if (this.isRunning(id)) {
            return;
        }
        this.clearRestartTimer(entry);
        this.spawnEntry(entry);
    }

    async stop(id: string): Promise<void> {
        const entry = this.requireEntry(id);
        this.clearRestartTimer(entry);
        if (!entry.proc || entry.proc.exitCode !== null) {
            this.setState(entry, 'stopped');
            return;
        }
        entry.stopping = true;
        this.setState(entry, 'stopping');
        await this.gracefulStop(entry);
    }

    async restart(id: string): Promise<void> {
        await this.stop(id);
        this.start(id);
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
    }

    /** Kill any leftover managed processes from a previous app run. */
    async cleanupStale(): Promise<void> {
        const persisted = this.readState();
        if (persisted.length === 0) {
            return;
        }
        for (const item of persisted) {
            try {
                const commandLine = await getProcessCommandLine(item.pid);
                if (commandLine && looksLikeManagedCommand(commandLine, item)) {
                    if (IS_WINDOWS) {
                        await execFileAsync('taskkill', ['/PID', String(item.pid), '/T', '/F']);
                    } else {
                        await execFileAsync('kill', ['-9', String(item.pid)]);
                    }
                }
            } catch {
                // Silent best-effort cleanup.
            }
        }
        this.writeState();
    }

    // -- spawning -----------------------------------------------------------

    private spawnEntry(entry: ManagedEntry): void {
        const { command, args } = entry.spec.buildCommand();
        const resolve = this.options.resolveExecutable ?? ((cmd) => cmd);
        const executable = resolve(command, entry.spec.namedExecutableLabel);

        const windowsHide =
            typeof entry.spec.windowsHide === 'function'
                ? entry.spec.windowsHide()
                : entry.spec.windowsHide ?? false;
        const proc = spawn(executable, args, {
            cwd: entry.spec.cwd,
            windowsHide,
            env: this.buildEnv(entry.spec),
        });

        entry.proc = proc;
        entry.stopping = false;
        this.setState(entry, 'starting');
        this.applyPriority(entry, proc);
        this.recordPid(entry, executable, args, proc.pid);

        proc.stdout?.on('data', (data: Buffer) => {
            this.emit('log', entry.spec.id, { stream: 'stdout', message: data.toString() });
        });
        proc.stderr?.on('data', (data: Buffer) => {
            this.emit('log', entry.spec.id, { stream: 'stderr', message: data.toString() });
        });

        proc.on('close', (code, signal) => {
            this.handleExit(entry, proc, code, signal);
        });
        proc.on('error', (err) => {
            this.emit('log', entry.spec.id, { stream: 'stderr', message: `spawn error: ${err.message}` });
            this.handleExit(entry, proc, 1, null);
        });

        // readyOn 'spawn' means the process has no bus handshake.
        if ((entry.spec.readyOn ?? 'hello') === 'spawn') {
            this.setState(entry, 'ready');
        } else if (this.options.bus.isClientConnected(entry.spec.id)) {
            // Already connected from a previous socket (reconnect race).
            this.setState(entry, 'ready');
        }
    }

    private buildEnv(spec: ProcessSpec): NodeJS.ProcessEnv {
        const base = this.options.baseEnv?.() ?? process.env;
        const connect = this.options.getConnectInfo();
        const busEnv: NodeJS.ProcessEnv = connect
            ? {
                  GSM_BROKER_PORT: String(connect.port),
                  GSM_BROKER_TOKEN: connect.token,
                  GSM_CLIENT_ID: spec.id,
              }
            : {};
        return { ...base, ...busEnv, ...(spec.env?.() ?? {}) };
    }

    private applyPriority(entry: ManagedEntry, proc: ChildProcess): void {
        if (!IS_WINDOWS || !entry.spec.priority || typeof proc.pid !== 'number' || proc.pid <= 0) {
            return;
        }
        const priority = entry.spec.priority();
        try {
            os.setPriority(proc.pid, WINDOWS_PRIORITY[priority]);
        } catch (err) {
            console.warn(`[ProcessManager] failed to set priority for "${entry.spec.id}":`, err);
        }
    }

    // -- stopping -----------------------------------------------------------

    private async gracefulStop(entry: ManagedEntry): Promise<void> {
        const proc = entry.proc;
        if (!proc) {
            return;
        }
        const exited = new Promise<void>((resolve) => proc.once('close', () => resolve()));

        const graceful = entry.spec.gracefulStop;
        if (graceful && this.options.bus.isClientConnected(entry.spec.id)) {
            this.options.bus.publish(entry.spec.id, graceful.topic, graceful.data, 'command');
            entry.stopTimer = setTimeout(() => this.signalTerminate(entry), graceful.timeoutMs);
        } else {
            this.signalTerminate(entry);
        }
        await exited;
    }

    private signalTerminate(entry: ManagedEntry): void {
        const proc = entry.proc;
        if (!proc || proc.exitCode !== null) {
            return;
        }
        try {
            proc.kill('SIGTERM');
        } catch (err) {
            console.warn(`[ProcessManager] SIGTERM failed for "${entry.spec.id}":`, err);
        }
        const pid = proc.pid;
        entry.forceTimer = setTimeout(() => {
            if (proc.exitCode !== null || !pid) {
                return;
            }
            if (IS_WINDOWS) {
                execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {
                    /* best-effort */
                });
            } else {
                try {
                    process.kill(pid, 'SIGKILL');
                } catch {
                    /* best-effort */
                }
            }
        }, SIGTERM_ESCALATION_MS);
    }

    // -- exit / restart -----------------------------------------------------

    private handleExit(
        entry: ManagedEntry,
        proc: ChildProcess,
        code: number | null,
        signal: NodeJS.Signals | null
    ): void {
        if (entry.proc !== proc) {
            // A newer process already replaced this one; ignore the stale close.
            return;
        }
        this.clearStopTimers(entry);
        entry.proc = null;
        this.recordPid(entry, '', [], undefined);

        const wasStopping = entry.stopping;
        entry.stopping = false;

        if (wasStopping) {
            this.setState(entry, 'stopped');
            this.emit('exit', entry.spec.id, code);
            return;
        }

        this.setState(entry, 'crashed');
        this.emit('crashed', entry.spec.id, code, signal);
        this.emit('exit', entry.spec.id, code);
        this.scheduleRestart(entry);
    }

    private scheduleRestart(entry: ManagedEntry): void {
        const policy = entry.spec.autoRestart;
        if (!policy?.enabled) {
            return;
        }
        if (policy.maxRetries !== undefined && entry.restartAttempts >= policy.maxRetries) {
            console.warn(`[ProcessManager] "${entry.spec.id}" hit max restart retries.`);
            return;
        }
        if (this.options.launchBlocked?.()) {
            return;
        }
        const initial = policy.initialDelayMs ?? DEFAULT_RESTART_INITIAL_MS;
        const max = policy.maxDelayMs ?? DEFAULT_RESTART_MAX_MS;
        const delay = Math.min(max, initial * 2 ** entry.restartAttempts);
        entry.restartAttempts += 1;
        entry.restartTimer = setTimeout(() => {
            entry.restartTimer = null;
            if (!this.isRunning(entry.spec.id)) {
                this.spawnEntry(entry);
            }
        }, delay);
    }

    // -- readiness ----------------------------------------------------------

    private onClientConnected = (id: string): void => {
        const entry = this.entries.get(id);
        if (!entry) {
            return;
        }
        entry.restartAttempts = 0;
        if (entry.state === 'starting' || entry.state === 'crashed') {
            this.setState(entry, 'ready');
        }
    };

    private onClientDisconnected = (id: string): void => {
        const entry = this.entries.get(id);
        if (!entry || entry.stopping) {
            return;
        }
        // Process may still be alive (its `close` is the authority on death);
        // a disconnect while running just means it's no longer ready.
        if (entry.state === 'ready' && this.isRunning(id)) {
            this.setState(entry, 'starting');
        }
    };

    // -- state file ---------------------------------------------------------

    private recordPid(
        entry: ManagedEntry,
        command: string,
        args: string[],
        pid: number | undefined
    ): void {
        entry._persisted =
            pid && Number.isInteger(pid) && pid > 0
                ? {
                      pid,
                      command,
                      args,
                      matchTokens: entry.spec.matchTokens ?? [],
                  }
                : undefined;
        this.writeState();
    }

    private writeState(): void {
        try {
            const items: PersistedProcess[] = [];
            for (const entry of this.entries.values()) {
                if (entry._persisted) {
                    items.push(entry._persisted);
                }
            }
            fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
            fs.writeFileSync(this.stateFile, JSON.stringify(items), 'utf8');
        } catch {
            // Best-effort tracking only.
        }
    }

    private readState(): PersistedProcess[] {
        try {
            if (!fs.existsSync(this.stateFile)) {
                return [];
            }
            const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as unknown;
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed
                .map((item) => item as Partial<PersistedProcess>)
                .filter(
                    (item): item is PersistedProcess =>
                        typeof item.pid === 'number' &&
                        Number.isInteger(item.pid) &&
                        item.pid > 0 &&
                        typeof item.command === 'string' &&
                        Array.isArray(item.args)
                )
                .map((item) => ({
                    pid: item.pid,
                    command: item.command,
                    args: item.args.map(String),
                    matchTokens: Array.isArray(item.matchTokens) ? item.matchTokens.map(String) : [],
                }));
        } catch {
            return [];
        }
    }

    // -- helpers ------------------------------------------------------------

    private requireEntry(id: string): ManagedEntry {
        const entry = this.entries.get(id);
        if (!entry) {
            throw new Error(`Process "${id}" is not registered`);
        }
        return entry;
    }

    private setState(entry: ManagedEntry, state: ProcessState): void {
        if (entry.state === state) {
            return;
        }
        entry.state = state;
        this.emit('state-changed', entry.spec.id, state);
        if (state === 'ready') {
            this.emit('ready', entry.spec.id);
        }
    }

    private clearStopTimers(entry: ManagedEntry): void {
        if (entry.stopTimer) {
            clearTimeout(entry.stopTimer);
            entry.stopTimer = null;
        }
        if (entry.forceTimer) {
            clearTimeout(entry.forceTimer);
            entry.forceTimer = null;
        }
    }

    private clearRestartTimer(entry: ManagedEntry): void {
        if (entry.restartTimer) {
            clearTimeout(entry.restartTimer);
            entry.restartTimer = null;
        }
        entry.restartAttempts = 0;
    }
}

// Augment ManagedEntry with the persisted snapshot without widening the public type.
interface ManagedEntry {
    _persisted?: PersistedProcess;
}

function looksLikeManagedCommand(commandLine: string, item: PersistedProcess): boolean {
    const normalized = commandLine.toLowerCase();
    const expectedExeName = path.basename(item.command).toLowerCase();
    if (expectedExeName && !normalized.includes(expectedExeName)) {
        return false;
    }
    for (const token of [...item.args, ...item.matchTokens]) {
        if (token && !normalized.includes(token.toLowerCase())) {
            return false;
        }
    }
    return true;
}

async function getProcessCommandLine(pid: number): Promise<string | null> {
    if (IS_WINDOWS) {
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
        const itemParsed = Array.isArray(parsed) ? parsed[0] : parsed;
        return typeof itemParsed?.CommandLine === 'string' ? itemParsed.CommandLine : null;
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
