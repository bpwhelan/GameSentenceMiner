// electron-src/main/ui/texthook_downloader.ts
//
// On-demand download and update management for the texthook engine binaries
// (Luna Hook and Textractor CLI builds). These files are not bundled with the
// app to avoid antivirus false-positive triggers from the DLL injection code.
//
// Files are fetched from a versioned S3 manifest and stored under
// %APPDATA%/GameSentenceMiner/texthook/ (same sub-path structure as the old
// bundled assets dir so getEngineCliPath() can check both transparently).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { once } from 'node:events';
import { BASE_DIR } from '../util.js';
import { mainWindow } from '../main.js';

const MANIFEST_URL = 'https://r2.gamesentenceminer.com/texthook/texthook_manifest.json';
const FILES_BASE_URL = 'https://r2.gamesentenceminer.com/texthook';

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
        return JSON.parse(fs.readFileSync(LOCAL_MANIFEST_PATH, 'utf-8')) as TexhookManifest;
    } catch {
        return null;
    }
}

async function fetchRemoteManifest(): Promise<TexhookManifest | null> {
    try {
        const resp = await fetch(MANIFEST_URL);
        if (!resp.ok) return null;
        return (await resp.json()) as TexhookManifest;
    } catch {
        return null;
    }
}

export function isTexthookInstalled(): boolean {
    return SENTINEL_FILES.every((f) => fs.existsSync(path.join(TEXTHOOK_DOWNLOAD_DIR, f)));
}

/**
 * Streams a single file to disk, hashing chunks as they arrive so we never hold
 * the whole file in memory and never do a synchronous full-file write or a
 * second full-file read to verify. Keeping every step async + chunked is what
 * stops the download from blocking the Electron main-process event loop (and
 * thus freezing the UI). The verified SHA-256 is returned to the caller.
 */
async function downloadSingleFile(
    url: string,
    destPath: string,
    expectedSha256: string,
    onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const tempPath = `${destPath}.download`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);
    const totalBytes = resp.headers.get('content-length')
        ? Number(resp.headers.get('content-length'))
        : undefined;

    await fs.promises.rm(tempPath, { force: true });
    const hash = crypto.createHash('sha256');
    const fileStream = fs.createWriteStream(tempPath);
    let downloaded = 0;

    try {
        if (resp.body) {
            const reader = resp.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = Buffer.from(value);
                hash.update(chunk);
                downloaded += chunk.length;
                // Respect backpressure so a slow disk can't blow up memory.
                if (!fileStream.write(chunk)) {
                    await once(fileStream, 'drain');
                }
                onProgress?.(downloaded, totalBytes);
            }
        } else {
            const buf = Buffer.from(await resp.arrayBuffer());
            hash.update(buf);
            downloaded = buf.length;
            if (!fileStream.write(buf)) {
                await once(fileStream, 'drain');
            }
            onProgress?.(downloaded, totalBytes);
        }
        await new Promise<void>((resolve, reject) => {
            fileStream.once('error', reject);
            fileStream.end(() => resolve());
        });
    } catch (err) {
        fileStream.destroy();
        await fs.promises.rm(tempPath, { force: true });
        throw err;
    }

    const actualHash = hash.digest('hex');
    if (actualHash !== expectedSha256) {
        await fs.promises.rm(tempPath, { force: true });
        throw new Error(
            `Integrity check failed for ${path.basename(destPath)} (hash mismatch). The file may be corrupted.`,
        );
    }

    await fs.promises.rm(destPath, { force: true });
    await fs.promises.rename(tempPath, destPath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns install state + whether a remote update is available. */
export async function getEngineStatus(): Promise<EngineStatus> {
    const local = loadLocalManifest();
    const installed = isTexthookInstalled();
    const remote = await fetchRemoteManifest();
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
    const manifest = await fetchRemoteManifest();
    if (!manifest) throw new Error('Could not reach the texthook engine manifest — check your internet connection.');

    fs.mkdirSync(TEXTHOOK_DOWNLOAD_DIR, { recursive: true });

    const files = manifest.files;
    console.log(`[texthook] Downloading ${files.length} engine files (v${manifest.version}) to ${TEXTHOOK_DOWNLOAD_DIR}`);

    for (let i = 0; i < files.length; i++) {
        const entry = files[i];
        const destPath = path.join(TEXTHOOK_DOWNLOAD_DIR, entry.path);
        const url = `${FILES_BASE_URL}/${entry.path}`;

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
