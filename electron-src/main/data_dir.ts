import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';

// Leaf module: only imports Node built-ins. Must NOT import electron or main.js
// so it can be used by util.ts/store.ts/gsm_config.ts without an import cycle.

const APP_NAME = 'GameSentenceMiner';

// Bootstrap configuration is independent of the data folder and the installation.
const POINTER_FILE_NAME = 'data_dir.json';

/** The default %APPDATA%/GameSentenceMiner (Windows) or ~/.config/GameSentenceMiner (mac/Linux). */
export function getDefaultBaseDir(): string {
    return process.env.APPDATA
        ? path.join(process.env.APPDATA, APP_NAME)
        : path.join(os.homedir(), '.config', APP_NAME);
}

/** Small, permanent bootstrap file, including on Windows. Do not move with app data. */
export function getPointerFilePath(): string {
    return path.join(os.homedir(), '.config', APP_NAME, POINTER_FILE_NAME);
}

function normalizeDataDir(value: unknown): string {
    let dataDir = typeof value === 'string' ? value.trim() : '';
    if (/^~([/\\]|$)/.test(dataDir)) {
        dataDir = path.join(os.homedir(), dataDir.slice(2));
    }
    if (!dataDir || !path.isAbsolute(dataDir) || dataDir.includes('\0')) {
        throw new Error('dataDir must be an absolute folder path.');
    }
    return path.normalize(dataDir);
}

function readPointer(pointerPath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(pointerPath, 'utf8').replace(/^\uFEFF/, ''));
        return { ...parsed, dataDir: normalizeDataDir(parsed?.dataDir) };
    } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw new Error(`Cannot read GSM data location from ${pointerPath}: ${error.message}`);
    }
}

function writePointer(config: Record<string, unknown>, onlyIfMissing = false): void {
    const pointerPath = getPointerFilePath();
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    const temporary = `${pointerPath}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', flush: true });
        if (onlyIfMissing) {
            // Publish a complete file without overwriting a concurrently saved selection.
            try {
                fs.linkSync(temporary, pointerPath);
            } catch (error: any) {
                if (error?.code !== 'EEXIST') throw error;
            }
        } else {
            fs.renameSync(temporary, pointerPath);
        }
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

/** Resolve before app ready. A missing target stays selected; never fall back to old data. */
export function resolveDataDir(): string {
    const pointerPath = getPointerFilePath();
    const legacyPath = path.join(getDefaultBaseDir(), POINTER_FILE_NAME);
    let pointer = readPointer(pointerPath);
    if (pointer && (pointerPath !== legacyPath || pointer.version === 2)) {
        return pointer.dataDir as string;
    }
    if (!pointer) {
        try {
            pointer = readPointer(legacyPath);
        } catch {
            // Preserve the historical fallback for invalid *legacy* files only.
            return getDefaultBaseDir();
        }
    }
    if (!pointer) return getDefaultBaseDir();

    const dataDir = pointer.dataDir as string;
    // Old backends always used the original database, even after copying the data folder.
    // Let Python recover that database once, using SQLite's WAL-aware backup API.
    const migrated = { ...pointer, version: 2, ...(dataDir !== getDefaultBaseDir()
        ? { legacyDatabaseDir: getDefaultBaseDir() } : {}) };
    writePointer(migrated, pointerPath !== legacyPath);
    return readPointer(pointerPath)!.dataDir as string;
}

let cachedBaseDir: string | null = null;

/** Memoized active data dir. Fixed for the process lifetime (a move forces a relaunch). */
export function getBaseDir(): string {
    if (cachedBaseDir == null) {
        cachedBaseDir = resolveDataDir();
    }
    return cachedBaseDir;
}

/** Always persist the selection, including the default, to supersede stale legacy files. */
export function writeDataDirPointer(dataDir: string): void {
    writePointer({ version: 2, dataDir: normalizeDataDir(dataDir) });
}

export function isLegacyDatabaseMigrationPending(dataDir: string): boolean {
    const pointer = readPointer(getPointerFilePath());
    return Boolean(pointer?.legacyDatabaseDir && path.relative(pointer.dataDir as string, dataDir) === '');
}

/**
 * Mirror the location for existing Windows integrations and diagnostics. Best-effort;
 * the bootstrap file remains authoritative and uninstallers must preserve user data.
 */
export function writeDataDirRegistry(dataDir: string): void {
    if (process.platform !== 'win32') {
        return;
    }
    execFile(
        'reg',
        ['add', 'HKCU\\Software\\GameSentenceMiner', '/v', 'DataDir', '/t', 'REG_SZ', '/d', dataDir, '/f'],
        { windowsHide: true },
        (err) => {
            if (err) {
                console.warn('Failed to write DataDir registry value:', err.message);
            }
        },
    );
}
