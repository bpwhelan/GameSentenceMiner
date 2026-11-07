import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import extract from './zip_extract.js';
import { OBS_BROWSER_CEF_FILES } from '../ui/obs_default_config.js';
import type { ObsRuntimePhase, ObsRuntimeStatus } from '../../shared/obs_runtime.js';

const VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_API = 'https://api.github.com/repos/obsproject/obs-studio/releases';

interface ObsRelease {
    tag_name?: string;
    prerelease?: boolean;
    assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }>;
}

export interface ObsRuntimeDependencies {
    baseDir: string;
    platform: string;
    arch: string;
    getOptions: () => { managed: boolean; automatic: boolean; pinnedVersion: string | null };
    readVersion?: (executable: string) => Promise<string | null>;
    fetchRelease?: (version: string | null) => Promise<ObsRelease>;
    download?: (url: string, destination: string, progress: (value: number | null) => void) => Promise<void>;
    extract?: (archive: string, destination: string) => Promise<void>;
    assertIdle: () => Promise<void>;
    stop: () => Promise<boolean>;
    validate: (version: string, restart: boolean) => Promise<void>;
    suspendClients?: () => Promise<() => Promise<void>>;
    onChange?: (status: ObsRuntimeStatus) => void;
}

export function readObsPinnedVersion(policy: string): Promise<string | null> {
    return fs.readFile(policy, 'utf8').then(raw => {
        const value = JSON.parse(raw).version;
        if (value === null) return null;
        if (typeof value !== 'string' || !VERSION.test(value)) throw new Error('Invalid OBS release policy.');
        return value;
    });
}

export async function fetchObsRelease(version: string | null): Promise<ObsRelease> {
    if (version !== null && !VERSION.test(version)) throw new Error('Invalid OBS version.');
    const response = await fetch(`${RELEASE_API}/${version ? `tags/${version}` : 'latest'}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GameSentenceMiner' },
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`OBS release lookup failed (HTTP ${response.status}).`);
    return response.json() as Promise<ObsRelease>;
}

export async function readObsExecutableVersion(executable: string): Promise<string | null> {
    if (!(await exists(executable))) return null;
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        '[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:GSM_OBS_VERSION_FILE).ProductVersion'], {
        env: { ...process.env, GSM_OBS_VERSION_FILE: executable }, windowsHide: true, timeout: 10000,
    });
    const version = stdout.trim();
    if (!VERSION.test(version)) throw new Error('Could not read the installed OBS version.');
    return version;
}

/** Match the executable path, including portable OBS launched outside this GSM session. */
export async function findWindowsObsProcess(executable: string): Promise<number | null> {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name = 'obs64.exe'\" | Where-Object { $_.ExecutablePath -eq $env:GSM_OBS_VERSION_FILE } | ForEach-Object { $_.ProcessId }"], {
        env: { ...process.env, GSM_OBS_VERSION_FILE: executable }, windowsHide: true, timeout: 10000,
    });
    const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    if (pids.length > 1 || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new Error('Close extra copies of GSM’s portable OBS before updating.');
    return pids[0] ?? null;
}

async function exists(target: string): Promise<boolean> {
    try { await fs.access(target); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

async function renameDirectory(source: string, destination: string): Promise<void> {
    // Windows can briefly retain image/directory handles after OBS reports exit.
    for (let attempt = 0; ; attempt++) {
        try { await fs.rename(source, destination); return; }
        catch (error: any) {
            if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
            await delay(250);
        }
    }
}

function newer(candidate: string, installed: string | null): boolean {
    if (!installed) return true;
    const a = candidate.split('.').map(Number), b = installed.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
    return false;
}

async function downloadArchive(url: string, destination: string, progress: (value: number | null) => void): Promise<void> {
    const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`OBS download failed (HTTP ${response.status}).`);
    const total = Number(response.headers.get('content-length'));
    let received = 0, lastReport = 0;
    await pipeline(Readable.fromWeb(response.body as any), new Transform({
        transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (Date.now() - lastReport > 250) {
                progress(total > 0 ? Math.min(1, received / total) : null);
                lastReport = Date.now();
            }
            callback(null, chunk);
        },
    }), createWriteStream(destination, { flags: 'wx' }));
}

/** OBS 33 stops loading later core modules if any required module is missing. */
export async function pruneObsRuntime(root: string): Promise<void> {
    const visit = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdb')) await fs.unlink(file);
        }
    };
    await visit(root);
    const legacy = path.join(root, 'obs-plugins/64bit');
    for (const name of OBS_BROWSER_CEF_FILES) await fs.rm(path.join(legacy, name), { force: true });
    for (const relative of ['obs-plugins/64bit/locales', 'data/obs-plugins/obs-browser']) {
        const target = path.resolve(root, relative);
        if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid OBS cleanup path.');
        await fs.rm(target, { recursive: true, force: true });
    }
}

// These shipped modules must not be copied back as legacy third-party plugins.
const CORE_MODULES = new Set(['aja', 'aja-output-ui', 'coreaudio-encoder', 'decklink', 'decklink-captions',
    'decklink-output-ui', 'frontend-tools', 'image-source', 'obs-browser', 'obs-ffmpeg', 'obs-filters',
    'obs-nvenc', 'obs-outputs', 'obs-qsv11', 'obs-text', 'obs-transitions', 'obs-vst', 'obs-websocket',
    'obs-x264', 'obs-webrtc', 'nv-filters', 'rtmp-services', 'text-freetype2', 'vlc-video', 'win-capture', 'win-dshow', 'win-wasapi']);

async function preserveUserData(source: string, destination: string): Promise<void> {
    for (const relative of ['config', 'plugins']) {
        if (await exists(path.join(source, relative))) await fs.cp(path.join(source, relative), path.join(destination, relative), { recursive: true });
    }
    // Preserve third-party legacy plugins, while leaving the new release's core modules authoritative.
    for (const relative of ['obs-plugins', 'data/obs-plugins']) {
        const from = path.join(source, relative);
        if (!(await exists(from))) continue;
        await fs.cp(from, path.join(destination, relative), { recursive: true, filter: file => {
            const name = path.basename(file).toLowerCase();
            if (name.endsWith('.pdb')) return false;
            const parts = path.relative(from, file).split(path.sep);
            if (relative === 'obs-plugins' && parts.length === 2 && parts[0] === '64bit') {
                return !CORE_MODULES.has(name.replace(/\.dll$/, '')) && !OBS_BROWSER_CEF_FILES.has(name) && name !== 'locales';
            }
            if (relative === 'data/obs-plugins' && parts.length === 1) return !CORE_MODULES.has(name);
            return true;
        } });
    }
    await fs.writeFile(path.join(destination, 'portable_mode'), '');
}

export class ObsRuntimeManager {
    private root: string;
    private previous: string;
    private swap: string;
    private operation: Promise<ObsRuntimeStatus> | null = null;
    private checking: Promise<ObsRuntimeStatus> | null = null;
    private release: ObsRelease | null = null;
    private phase: ObsRuntimePhase = 'idle';
    private progress: number | null = null;
    private checkedAt: string | null = null;
    private error: string | null = null;
    private lastStatus: ObsRuntimeStatus | null = null;
    private resumeClients: (() => Promise<void>) | null = null;
    private resumingClients = false;

    constructor(private deps: ObsRuntimeDependencies) {
        this.root = path.resolve(deps.baseDir, 'obs-studio');
        this.previous = path.resolve(deps.baseDir, 'obs-studio.previous');
        this.swap = path.resolve(deps.baseDir, '.obs-runtime-swap');
    }

    get busy(): boolean { return this.operation !== null && !this.resumingClients; }
    async waitForIdle(): Promise<void> { await this.operation?.catch(() => {}); }
    private version(root: string) { return (this.deps.readVersion ?? readObsExecutableVersion)(path.join(root, 'bin/64bit/obs64.exe')); }
    private async remove(target: string) {
        if (path.dirname(path.resolve(target)) !== path.resolve(this.deps.baseDir) || target === this.root) throw new Error('Invalid OBS temporary path.');
        await fs.rm(target, { recursive: true, force: true });
    }

    async recover(): Promise<void> {
        if (this.busy) return;
        if (!(await exists(this.root)) && await exists(this.previous)) await renameDirectory(this.previous, this.root);
        if (await exists(this.swap) && await exists(this.root) && !(await exists(this.previous))) await renameDirectory(this.swap, this.previous);
    }

    async status(): Promise<ObsRuntimeStatus> {
        await this.recover();
        const options = this.deps.getOptions();
        const supported = this.deps.platform === 'win32';
        const [installedVersion, rollbackVersion] = supported
            ? await Promise.all([this.version(this.root), this.version(this.previous)]) : [null, null];
        const targetVersion = this.release?.tag_name ?? options.pinnedVersion;
        return this.lastStatus = { supported, ...options, installedVersion, rollbackVersion, targetVersion,
            updateAvailable: Boolean(targetVersion && newer(targetVersion, installedVersion)),
            phase: this.phase, progress: this.progress, checkedAt: this.checkedAt, error: this.error };
    }

    private emit(phase: ObsRuntimePhase, progress: number | null = null) {
        this.phase = phase; this.progress = progress;
        if (this.lastStatus) this.deps.onChange?.({ ...this.lastStatus, phase, progress, error: this.error });
    }

    check(): Promise<ObsRuntimeStatus> {
        if (this.operation && !this.checking) return this.status();
        if (this.checking) return this.checking;
        this.checking = this.checkInternal().finally(() => { this.checking = null; });
        return this.checking;
    }

    private async checkInternal(): Promise<ObsRuntimeStatus> {
        const status = await this.status();
        if (!status.supported || !status.managed) return status;
        this.error = null; this.emit('checking');
        try {
            this.release = await (this.deps.fetchRelease ?? fetchObsRelease)(status.pinnedVersion);
            if (!this.release.tag_name || !VERSION.test(this.release.tag_name) || this.release.prerelease ||
                (status.pinnedVersion && this.release.tag_name !== status.pinnedVersion)) throw new Error('OBS returned an unexpected stable release.');
            this.checkedAt = new Date().toISOString();
            this.emit('idle');
            return await this.status();
        } catch (error) { this.error = String((error as Error).message); this.emit('error'); throw error; }
    }

    update(): Promise<ObsRuntimeStatus> {
        if (this.operation) return this.operation;
        this.operation = this.updateInternal().finally(() => this.finishOperation());
        return this.operation;
    }

    private async finishOperation() {
        this.resumingClients = true;
        try { await this.resumeClients?.(); }
        catch (error) { this.error = `OBS is installed, but GSM capture clients could not resume: ${(error as Error).message}`; this.emit('error'); throw new Error(this.error); }
        finally { this.resumeClients = null; this.resumingClients = false; this.operation = null; }
    }

    private async updateInternal(): Promise<ObsRuntimeStatus> {
        const staging = path.resolve(this.deps.baseDir, `.obs-update-${randomUUID()}`);
        const archive = `${staging}.zip`;
        let stopped = false, restart = false, swapped = false;
        let original: string | null = null;
        try {
            await this.recoverBeforeOperation();
            const options = this.deps.getOptions();
            if (this.deps.platform !== 'win32' || !options.managed) throw new Error('Updates are available only for GSM’s portable OBS on Windows.');
            // Always resolve again at the user's action; never trust an old settings-page result.
            await this.checking;
            const status = await this.checkInternal();
            original = status.installedVersion;
            if (!status.updateAvailable) return status;
            await this.deps.assertIdle();
            const version = this.release!.tag_name!;
            const suffix = this.deps.arch === 'arm64' ? 'Windows-arm64.zip' : 'Windows-x64.zip';
            const asset = this.release!.assets?.find(item => item.name?.endsWith(suffix));
            const expectedUrl = `https://github.com/obsproject/obs-studio/releases/download/${version}/${asset?.name}`;
            if (!asset?.browser_download_url || asset.browser_download_url !== expectedUrl || !/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '')) {
                throw new Error('OBS release is missing an official download or SHA-256 checksum.');
            }
            await fs.mkdir(this.deps.baseDir, { recursive: true });
            this.emit('downloading', 0);
            await (this.deps.download ?? downloadArchive)(asset.browser_download_url, archive, value => this.emit('downloading', value));
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(archive)) hash.update(chunk);
            if (`sha256:${hash.digest('hex')}` !== asset.digest!.toLowerCase()) throw new Error('OBS archive checksum did not match.');
            this.emit('extracting');
            await (this.deps.extract ?? ((file, dir) => extract(file, { dir })))(archive, staging);
            if (await this.version(staging) !== version) throw new Error('Downloaded OBS executable has an unexpected version.');
            await pruneObsRuntime(staging);
            if (Number(version.split('.')[0]) >= 33) {
                for (const module of ['obs-browser', 'obs-websocket']) {
                    if (!(await exists(path.join(staging, 'core', module, `${module}.dll`)))) {
                        throw new Error(`OBS is missing the required core module ${module}.`);
                    }
                }
            }
            await this.deps.assertIdle();
            this.emit('stopping');
            this.resumeClients = await this.deps.suspendClients?.() ?? null;
            restart = await this.deps.stop(); stopped = true;
            if (await exists(this.root)) await preserveUserData(this.root, staging);
            else await fs.writeFile(path.join(staging, 'portable_mode'), '');
            this.emit('installing');
            await this.remove(this.previous);
            if (await exists(this.root)) await renameDirectory(this.root, this.previous);
            try { await renameDirectory(staging, this.root); swapped = true; }
            catch (error) { if (await exists(this.previous)) await renameDirectory(this.previous, this.root); throw error; }
            this.emit('validating');
            await this.deps.validate(version, restart);
            this.error = null; this.emit('idle');
            const result = await this.status(); this.deps.onChange?.(result); return result;
        } catch (error) {
            const message = (error as Error).message;
            try {
                if (swapped && await exists(this.previous)) {
                    await this.deps.stop();
                    await renameDirectory(this.root, staging);
                    await renameDirectory(this.previous, this.root);
                }
                if (stopped && original) await this.deps.validate(original, restart);
            } catch (restoreError) {
                this.error = `${message} Recovery failed: ${(restoreError as Error).message}. Previous OBS is retained at ${this.previous}.`;
                this.emit('error'); throw new Error(this.error);
            }
            this.error = message; this.emit('error'); throw error;
        } finally {
            await this.remove(archive).catch(() => {});
            await this.remove(staging).catch(() => {});
        }
    }

    private async recoverBeforeOperation() {
        if (!(await exists(this.root)) && await exists(this.previous)) await renameDirectory(this.previous, this.root);
        if (await exists(this.swap) && !(await exists(this.previous))) await renameDirectory(this.swap, this.previous);
    }

    rollback(): Promise<ObsRuntimeStatus> {
        if (this.operation) return this.operation;
        this.operation = this.rollbackInternal().finally(() => this.finishOperation());
        return this.operation;
    }

    private async swapInstallations() {
        await renameDirectory(this.root, this.swap);
        try { await renameDirectory(this.previous, this.root); }
        catch (error) { await renameDirectory(this.swap, this.root); throw error; }
        await renameDirectory(this.swap, this.previous);
    }

    private async rollbackInternal(): Promise<ObsRuntimeStatus> {
        let swapped = false, stopped = false, restart = false;
        let original: string | null = null;
        try {
            await this.recoverBeforeOperation();
            const status = await this.status();
            if (!status.supported || !status.managed || !status.rollbackVersion) throw new Error('No previous portable OBS installation is available.');
            original = status.installedVersion;
            await this.deps.assertIdle();
            this.error = null; this.emit('stopping');
            this.resumeClients = await this.deps.suspendClients?.() ?? null;
            restart = await this.deps.stop(); stopped = true;
            this.emit('installing');
            await this.swapInstallations(); swapped = true;
            this.emit('validating');
            await this.deps.validate(status.rollbackVersion, restart);
            this.emit('idle');
            const result = await this.status(); this.deps.onChange?.(result); return result;
        } catch (error) {
            try {
                if (swapped) { await this.deps.stop(); await this.swapInstallations(); }
                if (stopped && original) await this.deps.validate(original, restart);
            } catch (restoreError) {
                this.error = `${(error as Error).message} Recovery failed: ${(restoreError as Error).message}`;
                this.emit('error'); throw new Error(this.error);
            }
            this.error = (error as Error).message; this.emit('error'); throw error;
        }
    }
}
