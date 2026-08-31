import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { app } from 'electron';
import { getBaseDir } from '../data_dir.js';
import type { StartHookResult } from './texthook.js';
import {
    AGENT_HOST_ARG,
    AGENT_HOST_OPTIONS_ARG,
    AGENT_HOST_PROTOCOL_VERSION,
    type AgentHostEvent,
    type AgentHostMessage,
    type AgentHostMetadata,
    type AgentHostResponse,
    type DetachedAgentStartOptions,
} from './agent_host_protocol.js';

interface DetachedAgentCallbacks {
    onEvent?: (channel: string, payload: unknown) => void;
    onText?: (payload: unknown) => void;
}

interface DetachedAgentState {
    status: any;
    hooks: { hooks: any[]; selectedHookId: string | null };
    startResult?: StartHookResult;
}

const METADATA_FILE = path.join(getBaseDir(), 'texthook', 'agent-host.json');
const CONNECT_TIMEOUT_MS = 10_000;

let callbacks: DetachedAgentCallbacks = {};
let socket: net.Socket | null = null;
let receiveBuffer = '';
let cachedStatus: any = null;
let cachedHooks: { hooks: any[]; selectedHookId: string | null } = {
    hooks: [],
    selectedHookId: null,
};
let nextRequestId = 1;
let connectedMetadata: AgentHostMetadata | null = null;
let connectPromise: Promise<boolean> | null = null;
const pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>();

export function configureDetachedAgentCallbacks(nextCallbacks: DetachedAgentCallbacks): void {
    callbacks = nextCallbacks;
}

function readMetadata(): AgentHostMetadata | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')) as Partial<AgentHostMetadata>;
        if (
            parsed.version !== AGENT_HOST_PROTOCOL_VERSION ||
            typeof parsed.hostPid !== 'number' ||
            typeof parsed.port !== 'number' ||
            typeof parsed.token !== 'string'
        ) {
            return null;
        }
        return parsed as AgentHostMetadata;
    } catch {
        return null;
    }
}

function runProcessQuery(command: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(command, args, { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
            resolve(error ? null : String(stdout));
        });
    });
}

async function isProcessAlive(pid: number): Promise<boolean> {
    if (pid <= 0) return false;
    if (process.platform === 'win32') {
        const stdout = await runProcessQuery('tasklist.exe', [
            '/FI',
            `PID eq ${pid}`,
            '/FO',
            'CSV',
            '/NH',
        ]);
        if (stdout === null) return true;
        const output = stdout.trim().toLowerCase();
        return output.length > 0 && !output.includes('no tasks are running') && output.includes(`"${pid}"`);
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function isVerifiedHostProcess(metadata: AgentHostMetadata): Promise<boolean | null> {
    if (process.platform !== 'win32') return false;
    const script = [
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${metadata.hostPid}" -ErrorAction SilentlyContinue`,
        'if ($null -ne $process) { [Console]::Out.Write($process.CommandLine) }',
    ].join('; ');
    const commandLine = await runProcessQuery('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
    ]);
    if (commandLine === null) return null;
    return matchesAgentHostCommandLine(commandLine, metadata);
}

function matchesAgentHostCommandLine(
    commandLine: string | null,
    metadata: AgentHostMetadata,
): boolean {
    const args = commandLine
        ?.match(/(?:[^\s"]+|"[^"]*")+/g)
        ?.map((value) => value.replace(/^"|"$/g, '')) ?? [];
    return args.includes(AGENT_HOST_ARG) && args.includes(`--gsm-agent-host-token=${metadata.token}`);
}

async function waitForHostExit(pid: number, timeoutMs: number = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await isProcessAlive(pid))) return true;
        await delay(100);
    }
    return !(await isProcessAlive(pid));
}

function removeMatchingMetadata(metadata: AgentHostMetadata): void {
    try {
        const current = readMetadata();
        if (current?.hostPid === metadata.hostPid && current.token === metadata.token) {
            fs.rmSync(METADATA_FILE, { force: true });
        }
    } catch {
        // Best effort stale-state cleanup.
    }
}

async function terminateHostProcess(
    metadata: AgentHostMetadata,
    authenticated: boolean,
): Promise<boolean> {
    if (!(await isProcessAlive(metadata.hostPid))) {
        removeMatchingMetadata(metadata);
        return true;
    }
    if (!authenticated && (await isVerifiedHostProcess(metadata)) !== true) return false;
    try {
        process.kill(metadata.hostPid, 'SIGTERM');
    } catch {
        return false;
    }
    const exited = await waitForHostExit(metadata.hostPid);
    if (exited) removeMatchingMetadata(metadata);
    return exited;
}

function clearPendingRequests(reason: string): void {
    for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
    }
    pendingRequests.clear();
}

function resetConnection(): void {
    const wasRunning = Boolean(cachedStatus?.running);
    socket = null;
    receiveBuffer = '';
    cachedStatus = null;
    cachedHooks = { hooks: [], selectedHookId: null };
    connectedMetadata = null;
    clearPendingRequests('Detached Agent host disconnected.');
    if (wasRunning) {
        callbacks.onEvent?.('texthook.status', { running: false });
        callbacks.onEvent?.('texthook.hooks', cachedHooks);
    }
}

function handleHostEvent(message: AgentHostEvent): void {
    if (message.channel === 'agent.text') {
        callbacks.onText?.(message.payload);
        return;
    }
    if (message.channel === 'texthook.status') {
        const status = message.payload as any;
        cachedStatus = status?.running ? { ...status, agentDetached: true } : null;
    } else if (message.channel === 'texthook.hooks') {
        cachedHooks = message.payload as typeof cachedHooks;
    }
    callbacks.onEvent?.(message.channel, message.payload);
}

function handleHostMessage(message: AgentHostMessage): void {
    if (message.kind === 'event') {
        handleHostEvent(message);
        return;
    }
    if (message.kind !== 'response') return;
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    pendingRequests.delete(message.id);
    clearTimeout(pending.timer);
    if (message.success) {
        pending.resolve(message.result);
    } else {
        pending.reject(new Error(message.error || 'Detached Agent host request failed.'));
    }
}

function attachSocket(nextSocket: net.Socket): void {
    socket = nextSocket;
    receiveBuffer = '';
    nextSocket.unref();
    nextSocket.setEncoding('utf8');
    nextSocket.on('data', (chunk: string) => {
        receiveBuffer += chunk;
        let newlineIndex = receiveBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = receiveBuffer.slice(0, newlineIndex).trim();
            receiveBuffer = receiveBuffer.slice(newlineIndex + 1);
            if (line) {
                try {
                    handleHostMessage(JSON.parse(line) as AgentHostMessage);
                } catch {
                    // Ignore malformed host output.
                }
            }
            newlineIndex = receiveBuffer.indexOf('\n');
        }
    });
    nextSocket.once('close', () => {
        if (socket === nextSocket) resetConnection();
    });
    nextSocket.once('error', () => {
        nextSocket.destroy();
    });
}

function sendRequest<T>(command: string, args: unknown[] = []): Promise<T> {
    const currentSocket = socket;
    if (!currentSocket || currentSocket.destroyed) {
        return Promise.reject(new Error('Detached Agent host is not connected.'));
    }
    const id = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Detached Agent host timed out handling ${command}.`));
        }, 5000);
        pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        currentSocket.write(`${JSON.stringify({ kind: 'request', id, command, args })}\n`);
    });
}

function applyState(state: DetachedAgentState): void {
    cachedStatus = state.status?.running ? { ...state.status, agentDetached: true } : null;
    cachedHooks = state.hooks ?? { hooks: [], selectedHookId: null };
}

async function connectWithMetadata(metadata: AgentHostMetadata): Promise<DetachedAgentState> {
    const nextSocket = net.createConnection({ host: '127.0.0.1', port: metadata.port });
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Connection timed out.')), 1500);
        nextSocket.once('connect', () => {
            clearTimeout(timer);
            resolve();
        });
        nextSocket.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
    attachSocket(nextSocket);
    connectedMetadata = metadata;
    nextSocket.write(`${JSON.stringify({ kind: 'hello', token: metadata.token })}\n`);
    const state = await sendRequest<DetachedAgentState>('state');
    applyState(state);
    return state;
}

export async function reconnectDetachedAgentHookSession(): Promise<boolean> {
    if (socket && !socket.destroyed) return Boolean(cachedStatus?.running);
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
        const metadata = readMetadata();
        if (!metadata) return false;
        try {
            const state = await connectWithMetadata(metadata);
            return Boolean(state.status?.running);
        } catch {
            socket?.destroy();
            resetConnection();
            const processAlive = await isProcessAlive(metadata.hostPid);
            const verifiedHost = processAlive ? await isVerifiedHostProcess(metadata) : false;
            if (!processAlive || verifiedHost === false) {
                try {
                    fs.rmSync(METADATA_FILE, { force: true });
                } catch {
                    // Best effort stale-state cleanup.
                }
            }
            return false;
        }
    })();
    try {
        return await connectPromise;
    } finally {
        connectPromise = null;
    }
}

function encodedHostOptions(options: DetachedAgentStartOptions): string {
    return Buffer.from(JSON.stringify(options), 'utf8').toString('base64url');
}

function launchHost(options: DetachedAgentStartOptions): void {
    const token = randomBytes(32).toString('hex');
    const launchArgs = process.defaultApp ? [app.getAppPath()] : [];
    launchArgs.push(
        AGENT_HOST_ARG,
        `${AGENT_HOST_OPTIONS_ARG}=${encodedHostOptions(options)}`,
        `--gsm-agent-host-token=${token}`,
    );
    const child = spawn(process.execPath, launchArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, GSM_AGENT_HOST_TOKEN: token },
    });
    child.unref();
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startDetachedAgentHookSession(
    options: DetachedAgentStartOptions,
): Promise<StartHookResult> {
    if (process.platform !== 'win32') {
        return { success: false, error: 'Detached Agent sessions are currently available on Windows only.' };
    }
    if (await reconnectDetachedAgentHookSession()) {
        return { success: false, error: 'A detached Agent hook session is already running.' };
    }
    if (socket && !socket.destroyed) {
        const state = await sendRequest<DetachedAgentState>('state');
        applyState(state);
        if (!state.startResult) {
            return { success: false, error: 'The detached Agent host is still starting.' };
        }
        if (!state.startResult.success) return state.startResult;
    }
    const existingMetadata = readMetadata();
    if (existingMetadata && (await isProcessAlive(existingMetadata.hostPid))) {
        return {
            success: false,
            error: 'A detached Agent host is running, but GSM could not reconnect to it.',
        };
    }
    try {
        fs.mkdirSync(path.dirname(METADATA_FILE), { recursive: true });
        fs.rmSync(METADATA_FILE, { force: true });
        launchHost(options);
    } catch (error) {
        return { success: false, error: `Failed to launch detached Agent host: ${(error as Error).message}` };
    }

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            let state: DetachedAgentState | null = null;
            if (socket && !socket.destroyed) {
                state = await sendRequest<DetachedAgentState>('state');
                applyState(state);
            } else {
                const metadata = readMetadata();
                if (metadata) state = await connectWithMetadata(metadata);
            }
            if (state?.startResult && !state.startResult.success) return state.startResult;
            if (cachedStatus?.running) {
                return {
                    success: true,
                    pid: cachedStatus.pid,
                    exeName: cachedStatus.exeName,
                    arch: cachedStatus.arch,
                };
            }
        } catch {
            socket?.destroy();
            resetConnection();
        }
        await delay(100);
    }
    return { success: false, error: 'Timed out waiting for the detached Agent host to start.' };
}

export function isDetachedAgentHookRunning(): boolean {
    return Boolean(cachedStatus?.running);
}

export function getDetachedAgentHookRuntimeStatus(): any | null {
    return cachedStatus;
}

export function listDetachedAgentHooks(): { hooks: any[]; selectedHookId: string | null } {
    return cachedHooks;
}

export async function stopDetachedAgentHookSession(): Promise<{ success: boolean; error?: string }> {
    const currentSocket = socket;
    const metadata = connectedMetadata ?? readMetadata();
    if (!currentSocket || currentSocket.destroyed) {
        return { success: false, error: 'Detached Agent host is not connected.' };
    }
    try {
        await sendRequest('stop');
        if (metadata && !(await waitForHostExit(metadata.hostPid))) {
            if (!(await terminateHostProcess(metadata, true))) {
                throw new Error('Detached Agent host acknowledged Stop but did not exit.');
            }
        }
    } catch (error) {
        if (!metadata || !(await terminateHostProcess(metadata, true))) {
            return { success: false, error: (error as Error).message };
        }
    }
    cachedStatus = null;
    cachedHooks = { hooks: [], selectedHookId: null };
    callbacks.onEvent?.('texthook.status', { running: false });
    callbacks.onEvent?.('texthook.hooks', cachedHooks);
    return { success: true };
}

export async function shutdownDetachedAgentHostForUpdate(): Promise<void> {
    const metadata = connectedMetadata ?? readMetadata();
    if (!metadata) return;
    await reconnectDetachedAgentHookSession();
    if (socket && !socket.destroyed) {
        const result = await stopDetachedAgentHookSession();
        if (result.success) return;
    }
    if (!(await terminateHostProcess(metadata, false))) {
        throw new Error('Could not verify and stop the detached Agent host for application update.');
    }
}

export function setDetachedAgentFlushDelayMs(value: number): { success: boolean; flushDelayMs: number } {
    if (cachedStatus) cachedStatus = { ...cachedStatus, flushDelayMs: value };
    void sendRequest('setFlushDelay', [value]).catch(() => undefined);
    return { success: true, flushDelayMs: value };
}

export function setDetachedAgentCopyToClipboard(value: boolean): { success: boolean; copyToClipboard: boolean } {
    if (cachedStatus) cachedStatus = { ...cachedStatus, copyToClipboard: value };
    void sendRequest('setCopyToClipboard', [value]).catch(() => undefined);
    return { success: true, copyToClipboard: value };
}

export function setDetachedAgentMaxBufferSize(value: number): void {
    if (!isDetachedAgentHookRunning()) return;
    void sendRequest('setMaxBufferSize', [value]).catch(() => undefined);
}

export async function showDetachedAgentScriptUi(): Promise<{ success: boolean; error?: string }> {
    return sendRequest('showUi');
}

export async function callDetachedAgentUiRpc(func: string, args: unknown[]): Promise<unknown> {
    return sendRequest('rpcCall', [func, args]);
}

export function sendDetachedAgentUiRpc(func: string, args: unknown[]): { success: boolean; error?: string } {
    void sendRequest('rpcSend', [func, args]).catch(() => undefined);
    return { success: true };
}

export const __test = {
    METADATA_FILE,
    readMetadata,
    isProcessAlive,
    matchesAgentHostCommandLine,
};
