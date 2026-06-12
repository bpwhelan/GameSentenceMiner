import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

// Leaf module: only imports fs/os/path/child_process. Must NOT import electron or main.js
// so it can be used by util.ts/store.ts/gsm_config.ts without an import cycle.

const APP_NAME = 'GameSentenceMiner';

// The pointer file always lives at the fixed default location so it can be found before
// the (possibly relocated) data dir is known. It records where the real data dir lives.
const POINTER_FILE_NAME = 'data_dir.json';

/** The default %APPDATA%/GameSentenceMiner (Windows) or ~/.config/GameSentenceMiner (mac/Linux). */
export function getDefaultBaseDir(): string {
    return process.env.APPDATA
        ? path.join(process.env.APPDATA, APP_NAME)
        : path.join(os.homedir(), '.config', APP_NAME);
}

/** Absolute path of the pointer file at the fixed default location. */
export function getPointerFilePath(): string {
    return path.join(getDefaultBaseDir(), POINTER_FILE_NAME);
}

/**
 * Resolve the active data dir: pointer file at the default location, else the default.
 * Synchronous + dependency-free so it can run at module-import time and before app ready.
 */
export function resolveDataDir(): string {
    try {
        const raw = fs.readFileSync(getPointerFilePath(), 'utf-8');
        const parsed = JSON.parse(raw);
        const dataDir = typeof parsed?.dataDir === 'string' ? parsed.dataDir.trim() : '';
        if (dataDir) {
            return dataDir;
        }
    } catch {
        // Missing/unreadable/malformed pointer → default location (backward compatible).
    }
    return getDefaultBaseDir();
}

let cachedBaseDir: string | null = null;

/** Memoized active data dir. Fixed for the process lifetime (a move forces a relaunch). */
export function getBaseDir(): string {
    if (cachedBaseDir == null) {
        cachedBaseDir = resolveDataDir();
    }
    return cachedBaseDir;
}

/** Write (or clear) the pointer file. Pass the default dir to remove the pointer. */
export function writeDataDirPointer(dataDir: string): void {
    const pointerPath = getPointerFilePath();
    fs.mkdirSync(getDefaultBaseDir(), { recursive: true });
    const isDefault = path.resolve(dataDir) === path.resolve(getDefaultBaseDir());
    if (isDefault) {
        try {
            fs.rmSync(pointerPath, { force: true });
        } catch {
            // ignore
        }
        return;
    }
    fs.writeFileSync(pointerPath, JSON.stringify({ dataDir }, null, 2), 'utf-8');
}

/**
 * Mirror the data dir into HKCU\Software\GameSentenceMiner\DataDir so the NSIS uninstaller
 * can find and offer to delete a relocated data dir. Windows-only; best-effort.
 */
export function writeDataDirRegistry(dataDir: string): void {
    if (process.platform !== 'win32') {
        return;
    }
    execFile(
        'reg',
        ['add', 'HKCU\\Software\\GameSentenceMiner', '/v', 'DataDir', '/t', 'REG_SZ', '/d', dataDir, '/f'],
        (err) => {
            if (err) {
                console.warn('Failed to write DataDir registry value:', err.message);
            }
        },
    );
}
