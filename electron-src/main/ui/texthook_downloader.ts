// electron-src/main/ui/texthook_downloader.ts
//
// On-demand download and update management for the texthook engine binaries
// (Luna Hook and Textractor CLI builds). These files are not bundled with the
// app to avoid antivirus false-positive triggers from the DLL injection code.
//
// A verified ZIP is fetched from R2 and its runtime files are stored under
// %APPDATA%/GameSentenceMiner/texthook/ (same sub-path structure as the old
// bundled assets dir so getEngineCliPath() can check both transparently).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { net } from 'electron';
import semver from 'semver';
import extract from 'extract-zip';
import { BASE_DIR } from '../util.js';
import type { EngineStatus, EngineDownloadProgress } from '../../shared/texthook_updates.js';
export type { EngineStatus, EngineDownloadProgress } from '../../shared/texthook_updates.js';

const FILES_BASE_URL = 'https://r2.gamesentenceminer.com/texthook/zip';
const MANIFEST_URL = `${FILES_BASE_URL}/texthook_manifest.json`;
const MANIFEST_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 120_000;
const DOWNLOAD_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

/** Writable directory that mirrors the old assets/texthook/ structure. */
export const TEXTHOOK_DOWNLOAD_DIR = path.join(BASE_DIR, 'texthook');

/**
 * Set GSM_FORCE_TEXTHOOK_DOWNLOAD=1 in the environment to skip the bundled-assets
 * fallback in dev, forcing the on-demand download path even when the DLLs are
 * checked out locally.
 */
export const FORCE_TEXTHOOK_DOWNLOAD = true;
const LOCAL_MANIFEST_PATH = path.join(TEXTHOOK_DOWNLOAD_DIR, 'texthook_manifest.json');
const PACKAGES_DIR = path.join(TEXTHOOK_DOWNLOAD_DIR, 'packages');
const PACKAGE_DIRECTORY_PATTERN = /^packages\/[a-f\d]{32}$/;

// Must all exist for the engines to be considered installed.
const SENTINEL_FILES = [
    'luna_builds/LunaHook32.dll',
    'luna_builds/LunaHook64.dll',
    'luna_builds/LunaHost32.dll',
    'luna_builds/LunaHost64.dll',
    'luna_builds/LunaHostCLI32.exe',
    'luna_builds/LunaHostCLI64.exe',
    'textractor_builds/_x64/TextractorCLI.exe',
    'textractor_builds/_x64/texthook.dll',
    'textractor_builds/_x64/LoaderDll.dll',
    'textractor_builds/_x64/LocaleEmulator.dll',
    'textractor_builds/_x86/TextractorCLI.exe',
    'textractor_builds/_x86/texthook.dll',
    'textractor_builds/_x86/LoaderDll.dll',
    'textractor_builds/_x86/LocaleEmulator.dll',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManifestEntry {
    /** Relative path within the texthook dir, e.g. "luna_builds/LunaHook32.dll" */
    path: string;
    sha256: string;
}

export interface TexhookManifest {
    version: string;
    /** Absent only in manifests from installations made before ZIP downloads. */
    archive?: ManifestEntry;
    files: ManifestEntry[];
}

interface LocalManifest extends TexhookManifest {
    packageDirectory?: string;
    previousPackageDirectory?: string;
}

export interface PreparedTexthookUpdate {
    manifest: TexhookManifest;
    directory: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadLocalManifest(): LocalManifest | null {
    try {
        if (!fs.existsSync(LOCAL_MANIFEST_PATH)) return null;
        const data = JSON.parse(fs.readFileSync(LOCAL_MANIFEST_PATH, 'utf-8'));
        const manifest: LocalManifest = validateManifest(data);
        for (const key of ['packageDirectory', 'previousPackageDirectory'] as const) {
            if (data[key] !== undefined) {
                if (typeof data[key] !== 'string' || !PACKAGE_DIRECTORY_PATTERN.test(data[key])) return null;
                manifest[key] = data[key];
            }
        }
        return manifest;
    } catch {
        return null;
    }
}

function validateManifest(value: unknown): TexhookManifest {
    if (!value || typeof value !== 'object') throw new Error('Invalid texthook manifest: expected an object.');
    const manifest = value as Record<string, unknown>;
    if (typeof manifest.version !== 'string' || !semver.valid(manifest.version) || !Array.isArray(manifest.files)) {
        throw new Error('Invalid texthook manifest: missing version or files.');
    }
    const paths = new Set<string>();
    const files = manifest.files.map((entry: unknown): ManifestEntry => {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid texthook manifest entry.');
        const file = entry as Record<string, unknown>;
        if (typeof file.path !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(file.path)
            || file.path.split('/').some((part) => part === '.' || part === '..' || part.endsWith('.'))
            || !/^(NOTICE\.md|(?:luna_builds|textractor_builds)\/.+)$/.test(file.path)
            || paths.has(file.path.toLowerCase())
            || typeof file.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256)) {
            throw new Error('Invalid texthook manifest: unsafe path, duplicate file or invalid SHA-256.');
        }
        paths.add(file.path.toLowerCase());
        return { path: file.path, sha256: file.sha256.toLowerCase() };
    });
    if (!SENTINEL_FILES.every((file) => paths.has(file.toLowerCase()))) {
        throw new Error('Invalid texthook manifest: required engine files are missing.');
    }
    let archive: ManifestEntry | undefined;
    if (manifest.archive !== undefined) {
        const entry = manifest.archive as ManifestEntry | null;
        if (!entry || entry.path !== 'texthook.zip'
            || typeof entry.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(entry.sha256)) {
            throw new Error('Invalid texthook manifest: invalid archive path or SHA-256.');
        }
        archive = { path: entry.path, sha256: entry.sha256.toLowerCase() };
    }
    return { version: manifest.version, files, ...(archive ? { archive } : {}) };
}

function describeError(error: unknown, depth = 0): string {
    if (!(error instanceof Error)) return String(error);
    const code = (error as NodeJS.ErrnoException).code;
    const detail = `${code ? `${code}: ` : ''}${error.message}`;
    return error.cause && depth < 3 ? `${detail} (${describeError(error.cause, depth + 1)})` : detail;
}

class HttpDownloadError extends Error {
    constructor(readonly status: number, statusText: string) {
        super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    }
}

async function withDownloadRetries<T>(
    url: string,
    timeoutMs: number,
    download: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        try {
            // Keep the timeout active until the response body has been consumed too.
            return await download(controller.signal);
        } catch (error) {
            const cause = controller.signal.aborted ? controller.signal.reason : error;
            const detail = `${url} — ${describeError(cause)}`;
            console.warn(`[texthook] Download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed: ${detail}`);
            const permanentHttpError = error instanceof HttpDownloadError
                && error.status < 500 && error.status !== 408 && error.status !== 429;
            if (attempt >= DOWNLOAD_ATTEMPTS || permanentHttpError) {
                throw new Error(detail, { cause });
            }
        } finally {
            clearTimeout(timeout);
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
}

async function fetchResponse(url: string, signal: AbortSignal): Promise<Response> {
    // Chromium networking respects the user's system proxy configuration.
    const response = await net.fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
    if (!response.ok) {
        await response.body?.cancel();
        throw new HttpDownloadError(response.status, response.statusText);
    }
    return response;
}

async function fetchRemoteManifest(): Promise<TexhookManifest> {
    return withDownloadRetries(MANIFEST_URL, MANIFEST_TIMEOUT_MS, async (signal) => {
        const response = await fetchResponse(MANIFEST_URL, signal);
        const manifest = validateManifest(await response.json());
        if (!manifest.archive) throw new Error('Invalid texthook manifest: missing ZIP archive.');
        return manifest;
    });
}

export function isTexthookInstalled(): boolean {
    const directory = getTexthookRuntimeDir();
    const files = loadLocalManifest()?.files.map((entry) => entry.path) ?? SENTINEL_FILES;
    return files.every((f) => fs.existsSync(path.join(directory, f)));
}

/** Legacy installs stay usable until the first complete, verified package is activated. */
export function getTexthookRuntimeDir(): string {
    const local = loadLocalManifest();
    return local?.packageDirectory ? path.join(TEXTHOOK_DOWNLOAD_DIR, local.packageDirectory) : TEXTHOOK_DOWNLOAD_DIR;
}

export function isNewerEngineVersion(remote: string | null, local: string | null): boolean {
    return !!remote && !!local && !!semver.valid(remote) && !!semver.valid(local) && semver.gt(remote, local);
}

export function getLocalEngineStatus(): EngineStatus {
    return { installed: isTexthookInstalled(), version: loadLocalManifest()?.version ?? null, remoteVersion: null, updateAvailable: false };
}

/**
 * Streams a single file to disk, hashing chunks as they arrive so we never hold
 * the whole file in memory and never do a synchronous full-file write or a
 * second full-file read to verify. Keeping every step async + chunked is what
 * stops the download from blocking the Electron main-process event loop (and
 * thus freezing the UI). A file replaces its destination only after verification.
 */
async function downloadSingleFile(
    url: string,
    destPath: string,
    expectedSha256: string,
    onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const tempPath = `${destPath}.download`;

    await withDownloadRetries(url, FILE_TIMEOUT_MS, async (signal) => {
        await fs.promises.rm(tempPath, { force: true });
        try {
            const resp = await fetchResponse(url, signal);
            const totalBytes = resp.headers.get('content-length')
                ? Number(resp.headers.get('content-length'))
                : undefined;
            if (!resp.body) throw new Error('Download response has no body.');
            const hash = crypto.createHash('sha256');
            let downloaded = 0;
            await pipeline(
                Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream<Uint8Array>),
                new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                        hash.update(chunk);
                        downloaded += chunk.length;
                        onProgress?.(downloaded, totalBytes);
                        callback(null, chunk);
                    },
                }),
                fs.createWriteStream(tempPath),
                { signal },
            );
            if (hash.digest('hex') !== expectedSha256) {
                throw new Error(`Integrity check failed for ${path.basename(destPath)} (hash mismatch). The file may be corrupted.`);
            }
            await fs.promises.rename(tempPath, destPath);
        } finally {
            // pipeline closes the writer before cleanup, including on Windows.
            await fs.promises.rm(tempPath, { force: true });
        }
    });
}

async function fileMatchesManifest(destPath: string, expectedSha256: string): Promise<boolean> {
    try {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(destPath)) hash.update(chunk);
        return hash.digest('hex') === expectedSha256;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns install state + whether a remote update is available. */
export async function getEngineStatus(): Promise<EngineStatus> {
    const local = getLocalEngineStatus();
    const remote = await fetchRemoteManifest().catch(() => null);
    return {
        ...local,
        remoteVersion: remote?.version ?? null,
        updateAvailable: local.installed && isNewerEngineVersion(remote?.version ?? null, local.version),
    };
}

/**
 * Downloads and verifies the ZIP, then verifies each extracted runtime file.
 * Emits `texthook.engineDownloadProgress` events to the renderer as work progresses.
 */
export async function downloadTexthookEngines(
    onProgress?: (progress: EngineDownloadProgress) => void,
): Promise<void> {
    const prepared = await prepareTexthookUpdate(onProgress);
    try {
        await activateTexthookUpdate(prepared);
    } catch (error) {
        await discardTexthookUpdate(prepared);
        throw error;
    }
}

/** Download into a private package. Never modify the active engines during preparation. */
export async function prepareTexthookUpdate(
    onProgress?: (progress: EngineDownloadProgress) => void,
    onVerifying?: () => void,
): Promise<PreparedTexthookUpdate> {
    const local = loadLocalManifest();
    const manifest = await fetchRemoteManifest();
    if (isNewerEngineVersion(local?.version ?? null, manifest.version)) {
        throw new Error(`Refusing to downgrade hook engines from ${local!.version} to ${manifest.version}.`);
    }
    const archive = manifest.archive!;
    const directory = path.join(PACKAGES_DIR, crypto.randomBytes(16).toString('hex'));
    await fs.promises.mkdir(directory, { recursive: true });
    const prepared = { directory, manifest };
    const zipPath = path.join(directory, archive.path);
    try {
        await downloadSingleFile(`${FILES_BASE_URL}/${archive.path}`, zipPath, archive.sha256, (bytesDownloaded, bytesTotal) => {
            onProgress?.({ file: archive.path, fileIndex: 0, totalFiles: 1, bytesDownloaded, bytesTotal: bytesTotal ?? null });
        });
        onVerifying?.();
        const expectedFiles = new Set(manifest.files.map(entry => entry.path));
        await extract(zipPath, {
            dir: directory,
            onEntry(entry) {
                const symlink = ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
                if (symlink || !expectedFiles.delete(entry.fileName)) {
                    throw new Error(`Unexpected or duplicate ZIP entry: ${entry.fileName}`);
                }
            },
        });
        await fs.promises.rm(zipPath);
        await verifyPreparedPackage(prepared);
        await fs.promises.writeFile(path.join(directory, 'texthook_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
        return prepared;
    } catch (error) {
        await discardTexthookUpdate(prepared);
        throw error;
    }
}

function assertPackageDirectory(directory: string): void {
    if (path.dirname(path.resolve(directory)) !== path.resolve(PACKAGES_DIR)
        || !/^[a-f\d]{32}$/.test(path.basename(directory))) {
        throw new Error('Invalid engine package directory.');
    }
}

async function verifyPreparedPackage(prepared: PreparedTexthookUpdate, flush = false): Promise<void> {
    assertPackageDirectory(prepared.directory);
    const manifest = validateManifest(prepared.manifest);
    for (const entry of manifest.files) {
        if (!await fileMatchesManifest(path.join(prepared.directory, entry.path), entry.sha256)) {
            throw new Error(`Integrity check failed for ${entry.path} (hash mismatch). Active engines were not changed.`);
        }
        if (flush) {
            const file = await fs.promises.open(path.join(prepared.directory, entry.path), 'r+');
            try { await file.sync(); } finally { await file.close(); }
        }
    }
}

export async function discardTexthookUpdate(prepared: PreparedTexthookUpdate): Promise<void> {
    assertPackageDirectory(prepared.directory);
    // Never delete the active generation, even after an error in a caller.
    if (path.resolve(prepared.directory) === path.resolve(getTexthookRuntimeDir())) return;
    await fs.promises.rm(prepared.directory, { recursive: true, force: true }).catch((error) => {
        console.warn('[texthook] Could not remove unused engine package:', describeError(error));
    });
}

/** The only commit is an atomic manifest replacement; old binaries are never overwritten. */
export async function activateTexthookUpdate(prepared: PreparedTexthookUpdate): Promise<void> {
    // Re-read every staged byte after a possible wait for an active hook to stop.
    await verifyPreparedPackage(prepared, true);
    const local = loadLocalManifest();
    if (isNewerEngineVersion(local?.version ?? null, prepared.manifest.version)) {
        throw new Error('Refusing to downgrade hook engines during activation.');
    }
    const next: LocalManifest = {
        ...validateManifest(prepared.manifest),
        packageDirectory: `packages/${path.basename(prepared.directory)}`,
        ...(local?.packageDirectory ? { previousPackageDirectory: local.packageDirectory } : {}),
    };
    if (local) await writeManifestAtomic(path.join(TEXTHOOK_DOWNLOAD_DIR, 'texthook_manifest.previous.json'), local);
    await writeManifestAtomic(LOCAL_MANIFEST_PATH, next);
    // Retain the immediately previous package for recovery. Cleanup is best-effort
    // because a game may still hold a DLL from an older session open on Windows.
    if (local?.previousPackageDirectory && local.previousPackageDirectory !== next.packageDirectory
        && local.previousPackageDirectory !== next.previousPackageDirectory) {
        await discardTexthookUpdate({ directory: path.join(TEXTHOOK_DOWNLOAD_DIR, local.previousPackageDirectory), manifest: next });
    }
}

async function writeManifestAtomic(destination: string, manifest: LocalManifest): Promise<void> {
    const temporaryManifest = path.join(TEXTHOOK_DOWNLOAD_DIR, `.manifest-${crypto.randomBytes(16).toString('hex')}.tmp`);
    try {
        const file = await fs.promises.open(temporaryManifest, 'wx');
        try {
            await file.writeFile(JSON.stringify(manifest, null, 2), 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await fs.promises.rename(temporaryManifest, destination);
    } finally {
        await fs.promises.rm(temporaryManifest, { force: true }).catch(() => {});
    }
}
