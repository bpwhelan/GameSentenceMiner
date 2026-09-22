// electron-src/main/ui/texthook_downloader.ts
//
// On-demand download and update management for the texthook engine binaries
// (Luna Hook and Textractor CLI builds). These files are not bundled with the
// app to avoid antivirus false-positive triggers from the DLL injection code.
//
// Files are fetched from an R2 manifest, with a pinned GitHub fallback, and stored under
// %APPDATA%/GameSentenceMiner/texthook/ (same sub-path structure as the old
// bundled assets dir so getEngineCliPath() can check both transparently).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { net } from 'electron';
import { BASE_DIR } from '../util.js';
import { mainWindow } from '../main.js';
import fallbackSnapshot from './texthook_fallback_manifest.js';

const MANIFEST_URL = 'https://r2.gamesentenceminer.com/texthook/texthook_manifest.json';
const FILES_BASE_URL = 'https://r2.gamesentenceminer.com/texthook';
// The tiny manifest ships with GSM; the executable files still download on demand.
// Regenerate with scripts/generate-texthook-fallback.mjs when publishing new engines.
const FALLBACK_BASE_URL = `https://raw.githubusercontent.com/bpwhelan/GameSentenceMiner/${fallbackSnapshot.revision}/electron-src/assets/texthook`;
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

interface TexhookManifest {
    version: string;
    files: ManifestEntry[];
}

export interface EngineStatus {
    installed: boolean;
    version: string | null;
    updateAvailable: boolean;
    remoteVersion: string | null;
}

export interface EngineDownloadProgress {
    file: string;
    fileIndex: number;
    totalFiles: number;
    bytesDownloaded: number;
    bytesTotal: number | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadLocalManifest(): TexhookManifest | null {
    try {
        if (!fs.existsSync(LOCAL_MANIFEST_PATH)) return null;
        return validateManifest(JSON.parse(fs.readFileSync(LOCAL_MANIFEST_PATH, 'utf-8')));
    } catch {
        return null;
    }
}

function validateManifest(value: unknown): TexhookManifest {
    if (!value || typeof value !== 'object') throw new Error('Invalid texthook manifest: expected an object.');
    const manifest = value as Record<string, unknown>;
    if (typeof manifest.version !== 'string' || !manifest.version.trim() || !Array.isArray(manifest.files)) {
        throw new Error('Invalid texthook manifest: missing version or files.');
    }
    const paths = new Set<string>();
    const files = manifest.files.map((entry: unknown): ManifestEntry => {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid texthook manifest entry.');
        const file = entry as Record<string, unknown>;
        if (typeof file.path !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(file.path)
            || file.path.split('/').some((part) => part === '.' || part === '..' || part.endsWith('.'))
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
    return { version: manifest.version, files };
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
        return validateManifest(await response.json());
    });
}

export function isTexthookInstalled(): boolean {
    return SENTINEL_FILES.every((f) => fs.existsSync(path.join(TEXTHOOK_DOWNLOAD_DIR, f)));
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
    const local = loadLocalManifest();
    const installed = isTexthookInstalled();
    const remote = await fetchRemoteManifest().catch(() => null);
    return {
        installed,
        version: local?.version ?? null,
        remoteVersion: remote?.version ?? null,
        updateAvailable: installed && !!remote && !!local && remote.version !== local.version,
    };
}

/**
 * Downloads all texthook engine files listed in the remote manifest.
 * Verifies SHA-256 of each file after download.
 * Emits `texthook.engineDownloadProgress` events to the renderer as work progresses.
 */
export async function downloadTexthookEngines(
    onProgress?: (progress: EngineDownloadProgress) => void,
): Promise<void> {
    const local = loadLocalManifest();
    let remote: TexhookManifest | undefined;
    let primaryError: unknown;
    try {
        remote = await fetchRemoteManifest();
        await downloadManifestFiles(remote, FILES_BASE_URL, onProgress);
        return;
    } catch (error) {
        primaryError = error;
    }

    const fallback = validateManifest(fallbackSnapshot);
    const targetVersion = remote?.version ?? local?.version;
    // A bundled snapshot must never silently replace another engine version.
    if (targetVersion && targetVersion !== fallback.version) {
        throw new Error(`${describeError(primaryError)}. Bundled fallback v${fallback.version} cannot replace engine version ${targetVersion}.`);
    }
    console.warn(`[texthook] R2 download failed; using bundled manifest v${fallback.version} and GitHub: ${describeError(primaryError)}`);
    try {
        // Switch the complete manifest: even NOTICE.md has its own verified hash.
        await downloadManifestFiles(fallback, FALLBACK_BASE_URL, onProgress);
    } catch (error) {
        throw new Error(`Could not download texthook engines. R2: ${describeError(primaryError)}. GitHub fallback: ${describeError(error)}`, { cause: error });
    }
}

async function downloadManifestFiles(
    manifest: TexhookManifest,
    baseUrl: string,
    onProgress?: (progress: EngineDownloadProgress) => void,
): Promise<void> {
    fs.mkdirSync(TEXTHOOK_DOWNLOAD_DIR, { recursive: true });

    const files = manifest.files;
    console.log(`[texthook] Downloading ${files.length} engine files (v${manifest.version}) to ${TEXTHOOK_DOWNLOAD_DIR}`);

    for (let i = 0; i < files.length; i++) {
        const entry = files[i];
        const destPath = path.join(TEXTHOOK_DOWNLOAD_DIR, entry.path);
        const url = `${baseUrl}/${entry.path}`;

        // Resume partial installs and avoid fetching binaries already verified on disk.
        if (await fileMatchesManifest(destPath, entry.sha256)) continue;

        console.log(`[texthook] (${i + 1}/${files.length}) ${entry.path}`);
        await downloadSingleFile(url, destPath, entry.sha256, (bytesDownloaded, bytesTotal) => {
            onProgress?.({
                file: path.basename(entry.path),
                fileIndex: i,
                totalFiles: files.length,
                bytesDownloaded,
                bytesTotal: bytesTotal ?? null,
            });
        });
        console.log(`[texthook] verified ${entry.path}`);
    }

    console.log(`[texthook] All engine files downloaded successfully.`);
    fs.writeFileSync(LOCAL_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Called once at startup (after the window is ready).
 * Silently checks if a newer manifest version is available and, if so,
 * emits `texthook.engineUpdateAvailable` so the UI can surface a badge.
 */
export async function checkForTexthookUpdates(): Promise<void> {
    if (!isTexthookInstalled()) return;
    const local = loadLocalManifest();
    if (!local) return;
    try {
        const remote = await fetchRemoteManifest();
        if (remote && remote.version !== local.version) {
            mainWindow?.webContents.send('texthook.engineUpdateAvailable', {
                remoteVersion: remote.version,
                localVersion: local.version,
            });
        }
    } catch {
        // Network error on startup — silently ignore.
    }
}
