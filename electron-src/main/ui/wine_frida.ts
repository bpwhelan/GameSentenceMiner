// Frida bridge for Windows processes running inside a Linux Wine/Proton prefix.
//
// Frida's Node client talks to the Linux host, while frida-server.exe must run
// in the Wine world that contains the game. This module starts that server with
// the game's captured environment and exposes the corresponding remote Device
// plus Windows PID to the hook implementations.

import frida from 'frida';
import type { Device, Process } from 'frida';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBaseDir } from '../data_dir.js';
import type { WineLaunchContext } from './linux_wine.js';

const BASE_DIR = getBaseDir();

// Keep this equal to the installed `frida` npm package. A server/client version
// mismatch is not recoverable at attach time. The package is currently 17.10.1;
// this can become a package.json lookup when Frida is upgraded.
const FRIDA_SERVER_VERSION = '17.10.1';
const SERVER_DOWNLOAD_BASE = `https://github.com/frida/frida/releases/download/${FRIDA_SERVER_VERSION}`;
const SERVER_START_TIMEOUT_MS = 12_000;
const SERVER_POLL_INTERVAL_MS = 250;

export interface WineProcessConnection {
    device: Device;
    windowsPid: number;
    remoteAddress: string;
    serverProcess: ChildProcess;
    close: () => Promise<void>;
}

function serverFileName(arch: 'x86' | 'x64'): string {
    return `frida-server-${FRIDA_SERVER_VERSION}-windows-${arch === 'x86' ? 'x86' : 'x86_64'}.exe`;
}

function serverOverride(arch: 'x86' | 'x64'): string {
    const key = arch === 'x86' ? 'GSM_FRIDA_SERVER_X86_PATH' : 'GSM_FRIDA_SERVER_X64_PATH';
    return process.env[key]?.trim() ?? '';
}

function assetServerPath(arch: 'x86' | 'x64'): string {
    return path.join(getWineAssetsDir(), 'texthook', 'frida-server', serverFileName(arch));
}

function getWineAssetsDir(): string {
    const packagedAssets = path.join(process.resourcesPath ?? '', 'assets');
    if (packagedAssets && fs.existsSync(packagedAssets)) return packagedAssets;
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
    const archivePath = `${destination}.xz`;
    const url = `${SERVER_DOWNLOAD_BASE}/${serverFileName(arch)}.xz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Frida server download failed (${response.status} ${response.statusText}).`);
    const archive = Buffer.from(await response.arrayBuffer());
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(archivePath, archive, { mode: 0o600 });

    // Use xz as a subprocess so the compressed archive is never decoded as
    // UTF-8 by Node. The binary is written atomically after decompression.
    const temporaryOutput = `${destination}.tmp-${process.pid}`;
    await new Promise<void>((resolve, reject) => {
        const decoder = spawn('xz', ['-dc', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let stderr = '';
        decoder.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
        decoder.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        decoder.on('error', reject);
        decoder.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Could not decompress frida-server with xz (exit ${code}): ${stderr.trim()}`));
                return;
            }
            void fs.promises.writeFile(temporaryOutput, Buffer.concat(chunks), { mode: 0o755 })
                .then(() => fs.promises.rename(temporaryOutput, destination))
                .then(() => fs.promises.chmod(destination, 0o755))
                .then(() => resolve(), reject);
        });
    });
    await fs.promises.rm(archivePath, { force: true });
}

const serverDownloads = new Map<string, Promise<string>>();

export async function ensureWineFridaServer(arch: 'x86' | 'x64'): Promise<string> {
    const override = existingFile(serverOverride(arch));
    if (override) return override;
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

async function waitForServerSocket(port: number): Promise<void> {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    let lastError = '';
    while (Date.now() < deadline) {
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
    try { child.kill(); } catch { /* The Wine wrapper may already have exited. */ }
}

/** Start frida-server.exe inside the game's Wine environment and map its exe name to a Windows PID. */
export async function startWineFridaConnection(
    launch: WineLaunchContext,
    exeName: string,
    arch: 'x86' | 'x64',
    onLog?: (message: string, level?: 'info' | 'warn' | 'error') => void,
): Promise<WineProcessConnection> {
    if (!launch.wineBinary) {
        throw new Error('Could not resolve the Wine launcher for this game. Set WINE/WINELOADER or install Wine/Proton.');
    }
    const serverPath = await ensureWineFridaServer(arch);
    const port = await findFreePort();
    const remoteAddress = `127.0.0.1:${port}`;
    const env = { ...launch.env };
    if (launch.isUmu) env.PROTON_VERB = 'run';
    const cwd = env.STEAM_COMPAT_INSTALL_PATH && fs.existsSync(env.STEAM_COMPAT_INSTALL_PATH)
        ? env.STEAM_COMPAT_INSTALL_PATH
        : path.dirname(serverPath);
    onLog?.(`Starting Frida server (${arch}) in ${launch.isUmu ? 'UMU' : 'Wine/Proton'} at ${remoteAddress}.`);

    const serverProcess = spawn(launch.wineBinary, [serverPath, '--listen', remoteAddress], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.on('error', (error) => {
        onLog?.(`[frida-server] ${error.message}`, 'error');
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
    let closed = false;
    const manager = frida.getDeviceManager();
    try {
        // addRemoteDevice can return a Device before the endpoint is actually
        // ready. Probe TCP first so the first enumerate call performs the real
        // Frida handshake instead of permanently caching a disconnected device.
        await waitForServerSocket(port);
        device = await manager.addRemoteDevice(remoteAddress);
        const target = await waitForTarget(device, exeName);
        const windowsPid = Number(target.pid);
        if (!Number.isFinite(windowsPid) || windowsPid <= 0) throw new Error(`Invalid Windows PID for ${exeName}.`);
        onLog?.(`Frida sees ${target.name} as Windows PID ${windowsPid}.`);
        const connectedDevice = device;
        const close = async () => {
            if (closed) return;
            closed = true;
            try { await manager.removeRemoteDevice(remoteAddress); } catch { /* already removed */ }
            stopProcess(serverProcess);
        };
        return { device: connectedDevice, windowsPid, remoteAddress, serverProcess, close };
    } catch (error) {
        if (device) {
            try { await manager.removeRemoteDevice(remoteAddress); } catch { /* ignore cleanup failure */ }
        }
        stopProcess(serverProcess);
        throw error;
    }
}
