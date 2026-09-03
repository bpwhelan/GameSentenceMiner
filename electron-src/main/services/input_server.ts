import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

import { getBaseDir } from '../data_dir.js';

// Port 0 asks the OS to reserve an available ephemeral port atomically. Never
// probe a port in Electron and bind it later in Rust: that leaves a race for
// another process to claim it between those two steps.
export const DEFAULT_INPUT_SERVER_PORT = 0;
const INPUT_SERVER_HOST = '127.0.0.1';
const RESTART_DELAY_MS = 1000;
const INPUT_SERVER_READY_PREFIX = 'GSM_INPUT_SERVER_READY:';
const INPUT_SERVER_READY_TIMEOUT_MS = 10_000;

interface InputServerCandidateOptions {
    isDev: boolean;
    resourcesDir: string;
    overlayResourcesDir: string;
    platform: NodeJS.Platform;
}

export function getInputServerExecutableCandidates(
    options: InputServerCandidateOptions
): string[] {
    const platformPath = options.platform === 'win32' ? path.win32 : path;
    const executableName =
        options.platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
    if (!options.isDev) {
        return [platformPath.join(options.overlayResourcesDir, executableName)];
    }
    const inputServerDir = platformPath.join(
        options.resourcesDir,
        'GSM_Overlay',
        'input_server'
    );
    return [
        platformPath.join(inputServerDir, 'target', 'debug', executableName),
        platformPath.join(inputServerDir, 'target', 'release', executableName),
        platformPath.join(inputServerDir, 'bin', executableName),
    ];
}

export function buildInputServerEnvironment(port: number): Record<string, string> {
    return {
        GSM_INPUT_SERVER_MANAGED: '1',
        GSM_INPUT_SERVER_PORT: String(port),
        GSM_INPUT_SERVER_URL: `ws://${INPUT_SERVER_HOST}:${port}`,
    };
}

/**
 * Parses the ready line emitted by the Rust server only after its TCP listener
 * is bound. Restricting this to our loopback endpoint prevents arbitrary child
 * output from changing the endpoint inherited by overlay processes.
 */
export function parseInputServerReadyLine(message: string): number | null {
    if (!message.startsWith(INPUT_SERVER_READY_PREFIX)) {
        return null;
    }

    try {
        const payload: unknown = JSON.parse(message.slice(INPUT_SERVER_READY_PREFIX.length));
        if (!payload || typeof payload !== 'object') {
            return null;
        }
        const { host, port } = payload as { host?: unknown; port?: unknown };
        if (
            host !== INPUT_SERVER_HOST ||
            typeof port !== 'number' ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65535
        ) {
            return null;
        }
        return port;
    } catch {
        return null;
    }
}

export function selectNewestInputServerExecutable(
    candidates: string[],
    getModifiedTime: (candidate: string) => number
): string | null {
    let newest: { path: string; modifiedTime: number } | null = null;
    for (const candidate of candidates) {
        try {
            const modifiedTime = getModifiedTime(candidate);
            if (!newest || modifiedTime > newest.modifiedTime) {
                newest = { path: candidate, modifiedTime };
            }
        } catch {
            // Missing or unreadable build candidates are expected in development.
        }
    }
    return newest?.path ?? null;
}

function publishInputServerEnvironment(port: number): void {
    Object.assign(process.env, buildInputServerEnvironment(port));
}

function clearInputServerEnvironment(): void {
    delete process.env.GSM_INPUT_SERVER_MANAGED;
    delete process.env.GSM_INPUT_SERVER_PORT;
    delete process.env.GSM_INPUT_SERVER_URL;
}

function resolveInputServerExecutable(): string | null {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const resourcesDir = app.isPackaged
        ? process.resourcesPath
        : path.resolve(moduleDir, '..', '..', '..');
    const overlayDirName = `gsm_overlay-${process.platform}-${process.arch}`;
    const overlayResourcesDir = app.isPackaged
        ? path.join(process.resourcesPath, 'GSM_Overlay', overlayDirName, 'resources')
        : path.join(resourcesDir, 'GSM_Overlay', 'out', overlayDirName, 'resources');
    const candidates = getInputServerExecutableCandidates({
        isDev: !app.isPackaged,
        resourcesDir,
        overlayResourcesDir,
        platform: process.platform,
    });
    return selectNewestInputServerExecutable(
        candidates,
        (candidate) => fs.statSync(candidate).mtimeMs
    );
}

let inputServerProcess: ChildProcess | null = null;
let startPromise: Promise<boolean> | null = null;
let stopping = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let inputServerPort: number | null = null;

function scheduleRestart(): void {
    if (stopping || restartTimer) {
        return;
    }
    restartTimer = setTimeout(() => {
        restartTimer = null;
        void startInputServer();
    }, RESTART_DELAY_MS);
}

export function shouldSuppressInputServerLine(message: string): boolean {
    return (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+INFO\s+client (?:connected|disconnected):\s+\S+$/.test(
            message
        ) ||
        message.startsWith(INPUT_SERVER_READY_PREFIX) ||
        /^GSMPROGRESS:\{(?:"percent":100,"stage":"ready"|"stage":"ready","percent":100")\}$/.test(
            message
        )
    );
}

function logServerOutput(prefix: string, data: Buffer): void {
    for (const line of data.toString('utf8').split(/\r?\n/)) {
        const message = line.trim();
        if (message && !shouldSuppressInputServerLine(message)) {
            console.log(`[InputService:${prefix}] ${message}`);
        }
    }
}

function waitForInputServerReady(child: ChildProcess): Promise<number> {
    const stdout = child.stdout;
    if (!stdout) {
        return Promise.reject(new Error('Input server stdout is unavailable.'));
    }

    return new Promise((resolve, reject) => {
        let bufferedOutput = '';
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            stdout.off('data', onData);
            child.off('error', onError);
            child.off('exit', onExit);
            callback();
        };
        const fail = (error: Error) => finish(() => reject(error));
        const onData = (data: Buffer) => {
            bufferedOutput += data.toString('utf8');
            const lines = bufferedOutput.split(/\r?\n/);
            bufferedOutput = lines.pop() ?? '';
            for (const line of lines) {
                const port = parseInputServerReadyLine(line.trim());
                if (port !== null) {
                    finish(() => resolve(port));
                    return;
                }
            }
        };
        const onError = (error: Error) => fail(error);
        const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
            fail(
                new Error(
                    `Input server exited before reporting its endpoint (code=${String(code)}, signal=${String(signal)}).`
                )
            );
        const timeout = setTimeout(() => {
            fail(new Error('Timed out waiting for the input server to bind its endpoint.'));
        }, INPUT_SERVER_READY_TIMEOUT_MS);

        stdout.on('data', onData);
        child.once('error', onError);
        child.once('exit', onExit);
    });
}

export async function startInputServer(): Promise<boolean> {
    stopping = false;
    if (startPromise) {
        return startPromise;
    }
    if (inputServerProcess && inputServerProcess.exitCode === null) {
        return true;
    }

    startPromise = Promise.resolve().then(async () => {
        const executable = resolveInputServerExecutable();
        if (!executable) {
            console.error('[InputService] Binary not found; gamepad hotkeys will be unavailable.');
            clearInputServerEnvironment();
            return false;
        }

        // Reuse a known endpoint after a crash so already-running overlays can
        // reconnect. The initial launch always lets the OS choose one.
        const requestedPort = inputServerPort ?? DEFAULT_INPUT_SERVER_PORT;
        const child = spawn(
            executable,
            ['--host', INPUT_SERVER_HOST, '--port', String(requestedPort)],
            {
                detached: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    GSM_OVERLAY_DATA_PATH: path.join(getBaseDir(), 'gsm_overlay'),
                },
            }
        );
        inputServerProcess = child;
        child.stdout.on('data', (data: Buffer) => logServerOutput('stdout', data));
        child.stderr.on('data', (data: Buffer) => logServerOutput('stderr', data));
        child.once('error', (error) => {
            console.error('[InputService] Failed to start:', error);
            if (inputServerProcess === child) {
                inputServerProcess = null;
            }
            scheduleRestart();
        });
        child.once('exit', (code, signal) => {
            if (inputServerProcess === child) {
                inputServerProcess = null;
            }
            console.warn(
                `[InputService] Exited (code=${String(code)}, signal=${String(signal)}).`
            );
            scheduleRestart();
        });
        try {
            const port = await waitForInputServerReady(child);
            inputServerPort = port;
            publishInputServerEnvironment(port);
            console.log(`[InputService] Started ${executable} at ws://${INPUT_SERVER_HOST}:${port}.`);
            return true;
        } catch (error) {
            console.error('[InputService] Failed to become ready:', error);
            if (child.exitCode === null) {
                try {
                    child.kill();
                } catch {
                    // The process may have exited between the state check and kill.
                }
            }
            return false;
        }
    }).finally(() => {
        startPromise = null;
    });
    return startPromise;
}

export async function stopInputServer(): Promise<void> {
    stopping = true;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    if (startPromise) {
        await startPromise;
    }
    const child = inputServerProcess;
    inputServerProcess = null;
    if (!child || child.exitCode !== null) {
        inputServerPort = null;
        clearInputServerEnvironment();
        return;
    }

    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        child.once('exit', finish);
        child.once('error', finish);
        try {
            child.kill();
        } catch {
            finish();
        }
        setTimeout(finish, 2000);
    });
    inputServerPort = null;
    clearInputServerEnvironment();
}
