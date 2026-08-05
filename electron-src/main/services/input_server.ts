import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

import { getBaseDir } from '../data_dir.js';

export const DEFAULT_INPUT_SERVER_PORT = 7276;
const INPUT_SERVER_HOST = '127.0.0.1';
const RESTART_DELAY_MS = 1000;

interface InputServerCandidateOptions {
    isDev: boolean;
    resourcesDir: string;
    overlayResourcesDir: string;
    platform: NodeJS.Platform;
}

export function getInputServerExecutableCandidates(
    options: InputServerCandidateOptions
): string[] {
    const pathImpl = options.platform === 'win32' ? path.win32 : path.posix;
    const executableName =
        options.platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
    if (!options.isDev) {
        return [pathImpl.join(options.overlayResourcesDir, executableName)];
    }
    const inputServerDir = pathImpl.join(
        options.resourcesDir,
        'GSM_Overlay',
        'input_server'
    );
    return [
        pathImpl.join(inputServerDir, 'target', 'debug', executableName),
        pathImpl.join(inputServerDir, 'target', 'release', executableName),
        pathImpl.join(inputServerDir, 'bin', executableName),
    ];
}

export function buildInputServerEnvironment(port: number): Record<string, string> {
    return {
        GSM_INPUT_SERVER_MANAGED: '1',
        GSM_INPUT_SERVER_PORT: String(port),
        GSM_INPUT_SERVER_URL: `ws://${INPUT_SERVER_HOST}:${port}`,
    };
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

function publishInputServerEnvironment(port = DEFAULT_INPUT_SERVER_PORT): void {
    Object.assign(process.env, buildInputServerEnvironment(port));
}

export function resolveInputServerExecutable(): string | null {
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

export async function startInputServer(): Promise<boolean> {
    publishInputServerEnvironment();
    stopping = false;
    if (inputServerProcess && inputServerProcess.exitCode === null) {
        return true;
    }
    if (startPromise) {
        return startPromise;
    }

    startPromise = Promise.resolve().then(() => {
        const executable = resolveInputServerExecutable();
        if (!executable) {
            console.error('[InputService] Binary not found; gamepad hotkeys will be unavailable.');
            return false;
        }

        const port = DEFAULT_INPUT_SERVER_PORT;
        const child = spawn(
            executable,
            ['--host', INPUT_SERVER_HOST, '--port', String(port)],
            {
                detached: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    ...buildInputServerEnvironment(port),
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
        console.log(`[InputService] Started ${executable} at ws://${INPUT_SERVER_HOST}:${port}.`);
        return true;
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
}

publishInputServerEnvironment();
