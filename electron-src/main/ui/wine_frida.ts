// Frida bridge for Windows processes running inside a Linux Wine/Proton prefix.
//
// Frida's Node client talks to the Linux host, while frida-server.exe must run
// in the Wine world that contains the game. This module starts that server with
// the game's captured environment and exposes the corresponding remote Device
// plus Windows PID to the hook implementations.

import frida from 'frida';
import type { Device, Process } from 'frida';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { getBaseDir } from '../data_dir.js';
import type { WineLaunchContext } from './linux_wine.js';

const BASE_DIR = getBaseDir();
const moduleRequire = createRequire(import.meta.url);

function getInstalledFridaVersion(): string {
    try {
        const entryPath = moduleRequire.resolve('frida');
        const packagePath = path.resolve(path.dirname(entryPath), '../../package.json');
        const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
        if (
            typeof metadata.version !== 'string' ||
            !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)
        ) {
            throw new Error(`Invalid version in ${packagePath}.`);
        }
        return metadata.version;
    } catch (error) {
        throw new Error(`Could not determine the installed Frida version: ${(error as Error).message}`);
    }
}

// The remote server and local client must have exactly the same version.
const FRIDA_SERVER_VERSION = getInstalledFridaVersion();
const SERVER_DOWNLOAD_BASE = `https://github.com/frida/frida/releases/download/${FRIDA_SERVER_VERSION}`;
const SERVER_START_TIMEOUT_MS = 12_000;
const SERVER_POLL_INTERVAL_MS = 250;
const SERVER_DOWNLOAD_TIMEOUT_MS = 120_000;

export interface WineProcessConnection {
    device: Device;
    windowsPid: number;
    close: () => Promise<void>;
}

function serverFileName(arch: 'x86' | 'x64'): string {
    return `frida-server-${FRIDA_SERVER_VERSION}-windows-${arch === 'x86' ? 'x86' : 'x86_64'}.exe`;
}

function serverOverride(arch: 'x86' | 'x64'): { key: string; value: string } {
    const key = arch === 'x86' ? 'GSM_FRIDA_SERVER_X86_PATH' : 'GSM_FRIDA_SERVER_X64_PATH';
    return { key, value: process.env[key]?.trim() ?? '' };
}

function assetServerPath(arch: 'x86' | 'x64'): string {
    return path.join(getWineAssetsDir(), 'texthook', 'frida-server', serverFileName(arch));
}

function getWineAssetsDir(): string {
    if (process.resourcesPath) {
        const packagedAssets = path.join(process.resourcesPath, 'assets');
        if (fs.existsSync(packagedAssets)) return packagedAssets;
    }
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../electron-src/assets');
}

function downloadedServerPath(arch: 'x86' | 'x64'): string {
    return path.join(BASE_DIR, 'texthook', 'frida-server', serverFileName(arch));
}

function existingFile(filePath: string): string | null {
    try {
        return fs.statSync(filePath).isFile() ? filePath : null;
    } catch {
        return null;
    }
}

async function downloadServer(arch: 'x86' | 'x64', destination: string): Promise<void> {
    const downloadId = randomUUID();
    const archivePath = `${destination}.${downloadId}.xz`;
    const temporaryOutput = `${destination}.${downloadId}.tmp`;
    const url = `${SERVER_DOWNLOAD_BASE}/${serverFileName(arch)}.xz`;
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(SERVER_DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`Frida server download failed (${response.status} ${response.statusText}).`);
        }
        await fs.promises.writeFile(archivePath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });

        // Frida publishes Windows servers as xz archives. Stream the decoded
        // executable to a temporary file so a large release never gets buffered
        // twice in the Electron main process.
        const decoder = spawn('xz', ['-dc', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        decoder.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        if (!decoder.stdout) throw new Error('Could not read decompressed Frida server output.');
        const decoderExit = new Promise<number>((resolve, reject) => {
            decoder.once('error', reject);
            decoder.once('close', (code) => resolve(code ?? -1));
        });
        const [, exitCode] = await Promise.all([
            pipeline(decoder.stdout, fs.createWriteStream(temporaryOutput, { mode: 0o700 })),
            decoderExit,
        ]);
        if (exitCode !== 0) {
            throw new Error(`Could not decompress frida-server with xz (exit ${exitCode}): ${stderr.trim()}`);
        }
        await fs.promises.rename(temporaryOutput, destination);
        await fs.promises.chmod(destination, 0o700);
    } finally {
        await Promise.all([
            fs.promises.rm(archivePath, { force: true }),
            fs.promises.rm(temporaryOutput, { force: true }),
        ]);
    }
}

const serverDownloads = new Map<string, Promise<string>>();

export async function ensureWineFridaServer(arch: 'x86' | 'x64'): Promise<string> {
    const override = serverOverride(arch);
    if (override.value) {
        const overridePath = existingFile(override.value);
        if (!overridePath) {
            throw new Error(`${override.key} does not point to a readable file: ${override.value}`);
        }
        return overridePath;
    }
    const bundled = existingFile(assetServerPath(arch));
    if (bundled) return bundled;
    const destination = downloadedServerPath(arch);
    const existing = existingFile(destination);
    if (existing) return existing;

    const pending = serverDownloads.get(destination);
    if (pending) return pending;
    const download = downloadServer(arch, destination).then(() => destination).finally(() => {
        serverDownloads.delete(destination);
    });
    serverDownloads.set(destination, download);
    return download;
}

async function findFreePort(): Promise<number> {
    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => resolve());
    });
    const address = listener.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    if (!port) throw new Error('Could not reserve a local Frida port.');
    return port;
}

function normalizeProcessName(value: string): string {
    return path.basename(value.replace(/\\/g, '/')).toLowerCase();
}

function findTargetProcess(processes: Process[], exeName: string): Process | null {
    const target = normalizeProcessName(exeName);
    const exact = processes.find((process) => normalizeProcessName(process.name) === target);
    if (exact) return exact;
    const targetStem = target.replace(/\.exe$/i, '');
    return processes.find((process) => normalizeProcessName(process.name).replace(/\.exe$/i, '') === targetStem) ?? null;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerSocket(port: number, getStartupFailure: () => Error | null): Promise<void> {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    let lastError = '';
    while (Date.now() < deadline) {
        const startupFailure = getStartupFailure();
        if (startupFailure) throw startupFailure;
        try {
            await new Promise<void>((resolve, reject) => {
                const probe = net.createConnection({ host: '127.0.0.1', port });
                probe.once('connect', () => {
                    probe.destroy();
                    resolve();
                });
                probe.once('error', (error) => {
                    probe.destroy();
                    reject(error);
                });
            });
            return;
        } catch (error) {
            lastError = (error as Error).message;
            await delay(SERVER_POLL_INTERVAL_MS);
        }
    }
    const startupFailure = getStartupFailure();
    if (startupFailure) throw startupFailure;
    throw new Error(`Frida server did not open ${port}${lastError ? `: ${lastError}` : '.'}`);
}

async function waitForTarget(device: Device, exeName: string): Promise<Process> {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    let lastError = '';
    while (Date.now() < deadline) {
        try {
            const processes = await device.enumerateProcesses();
            const target = findTargetProcess(processes, exeName);
            if (target) return target;
        } catch (error) {
            lastError = (error as Error).message;
        }
        await delay(SERVER_POLL_INTERVAL_MS);
    }
    throw new Error(`Windows process "${exeName}" did not appear through Wine Frida${lastError ? `: ${lastError}` : '.'}`);
}

function stopProcess(child: ChildProcess): void {
    if (child.killed || child.exitCode !== null) return;
    try {
        child.kill();
    } catch {
        // The Wine wrapper may already have exited.
    }
}

/** Start frida-server.exe inside the game's Wine environment and map its exe name to a Windows PID. */
export async function startWineFridaConnection(
    launch: WineLaunchContext,
    exeName: string,
    arch: 'x86' | 'x64',
    onLog?: (message: string, level?: 'info' | 'warn' | 'error') => void,
): Promise<WineProcessConnection> {
    if (!launch.launcherPath) {
        throw new Error('Could not resolve the Wine launcher for this game. Set WINE/WINELOADER or install Wine/Proton.');
    }
    const serverPath = await ensureWineFridaServer(arch);
    const port = await findFreePort();
    const remoteAddress = `127.0.0.1:${port}`;
    const env = { ...launch.env };
    if (launch.launcherKind === 'umu') env.PROTON_VERB = 'run';
    const cwd = env.STEAM_COMPAT_INSTALL_PATH && fs.existsSync(env.STEAM_COMPAT_INSTALL_PATH)
        ? env.STEAM_COMPAT_INSTALL_PATH
        : path.dirname(serverPath);
    const launcherName = launch.launcherKind === 'umu' ? 'UMU' : 'Wine/Proton';
    onLog?.(`Starting Frida server (${arch}) through ${launcherName} at ${remoteAddress}.`);

    const serverProcess = spawn(launch.launcherPath, [serverPath, '--listen', remoteAddress], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startupFailure: Error | null = null;
    let closed = false;
    serverProcess.on('error', (error) => {
        startupFailure = new Error(`Could not start the Wine Frida server: ${error.message}`);
        onLog?.(`[frida-server] ${error.message}`, 'error');
    });
    serverProcess.on('exit', (code, signal) => {
        if (!closed) {
            startupFailure = new Error(
                `Wine Frida server exited before connecting (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`,
            );
        }
    });
    serverProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf8').trim();
        if (text) onLog?.(`[frida-server] ${text}`, 'info');
    });
    serverProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf8').trim();
        if (text) onLog?.(`[frida-server] ${text}`, 'warn');
    });

    let device: Device | null = null;
    const manager = frida.getDeviceManager();
    try {
        // addRemoteDevice can return a Device before the endpoint is actually
        // ready. Probe TCP first so the first enumerate call performs the real
        // Frida handshake instead of permanently caching a disconnected device.
        await waitForServerSocket(port, () => startupFailure);
        device = await manager.addRemoteDevice(remoteAddress);
        const target = await waitForTarget(device, exeName);
        const windowsPid = Number(target.pid);
        if (!Number.isFinite(windowsPid) || windowsPid <= 0) {
            throw new Error(`Invalid Windows PID for ${exeName}.`);
        }
        onLog?.(`Frida sees ${target.name} as Windows PID ${windowsPid}.`);
        const connectedDevice = device;
        const close = async () => {
            if (closed) return;
            closed = true;
            try {
                await manager.removeRemoteDevice(remoteAddress);
            } catch {
                // The remote device may already have been removed.
            }
            stopProcess(serverProcess);
        };
        return { device: connectedDevice, windowsPid, close };
    } catch (error) {
        if (device) {
            try {
                await manager.removeRemoteDevice(remoteAddress);
            } catch {
                // Preserve the original startup error.
            }
        }
        stopProcess(serverProcess);
        throw error;
    }
}
