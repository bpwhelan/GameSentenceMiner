import { constants as fsConstants } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    getDefaultBaseDir,
    writeDataDirPointer,
    writeDataDirRegistry,
} from '../data_dir.js';

// Relocation deliberately copies user configuration and the GSM database. Only the
// Electron app's explicit JSON configs are included; its Chromium profile/storage is not.
// Source files are retained for the user to clean up.
const RELOCATED_DATA_PATHS = [
    'config',
    'config.json',
    'electron/config.json',
    'electron/overlay_settings.json',
    'gsm.db',
    'gsm.db-shm',
    'gsm.db-wal',
    'multi-mine-window-config.json',
    'obs-studio/config',
    'ocr_config',
    'plugins.py',
    'scene_config.json',
    'shared_config.json',
    'texthook/profiles.json',
    'texthook/texthook_manifest.json',
    'window_layout.json',
] as const;

const OBS_RUNTIME_CONFIG_DIRS = new Set([
    '.sentinel',
    'crashes',
    'logs',
    'profiler_data',
    'updates',
]);

interface RelocationEntry {
    label: string;
    source: string;
    destination: string;
}

export interface RelocateProgress {
    phase: 'validating' | 'copying' | 'finalizing' | 'done';
    message: string;
    completed?: number;
    total?: number;
}

export type ProgressCallback = (progress: RelocateProgress) => void;

export interface ValidateResult {
    ok: boolean;
    error?: string;
}

async function pathExists(candidate: string): Promise<boolean> {
    try {
        await fsp.lstat(candidate);
        return true;
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function overlayDirFor(baseDir: string): string {
    return path.resolve(baseDir) === path.resolve(getDefaultBaseDir())
        ? path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'gsm_overlay')
        : path.join(baseDir, 'gsm_overlay');
}

async function getExistingRelocationEntries(
    oldDir: string,
    newDir: string,
): Promise<RelocationEntry[]> {
    const existing: RelocationEntry[] = [];
    for (const relativePath of RELOCATED_DATA_PATHS) {
        const source = path.join(oldDir, relativePath);
        if (await pathExists(source)) {
            existing.push({
                label: relativePath,
                source,
                destination: path.join(newDir, relativePath),
            });
        }
    }

    const overlaySettingsSource = path.join(overlayDirFor(oldDir), 'settings.json');
    const overlaySettingsDestination = path.join(overlayDirFor(newDir), 'settings.json');
    if (
        path.resolve(overlaySettingsSource) !== path.resolve(overlaySettingsDestination) &&
        (await pathExists(overlaySettingsSource))
    ) {
        existing.push({
            label: 'gsm_overlay/settings.json',
            source: overlaySettingsSource,
            destination: overlaySettingsDestination,
        });
    }

    return existing;
}

async function findDestinationConflict(oldDir: string, newDir: string): Promise<string | null> {
    const entries = await getExistingRelocationEntries(oldDir, newDir);
    for (const entry of entries) {
        if (await pathExists(entry.destination)) {
            return entry.label;
        }
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function relocatedManagedObsPath(
    configuredPath: string,
    oldDir: string,
    newDir: string,
): string | null {
    // GSM runs on Windows, but using the configured path's style keeps this testable on
    // other platforms and handles configs containing either slash style.
    const pathImpl = path.win32.isAbsolute(configuredPath) ? path.win32 : path;
    if (!pathImpl.isAbsolute(configuredPath)) {
        return null;
    }

    const oldObsDir = pathImpl.resolve(oldDir, 'obs-studio');
    const configuredResolved = pathImpl.resolve(configuredPath);
    const relativePath = pathImpl.relative(oldObsDir, configuredResolved);
    const isInsideOldObsDir =
        relativePath === '' ||
        (!relativePath.startsWith(`..${pathImpl.sep}`) &&
            relativePath !== '..' &&
            !pathImpl.isAbsolute(relativePath));
    if (!isInsideOldObsDir) {
        return null;
    }

    return pathImpl.join(pathImpl.resolve(newDir, 'obs-studio'), relativePath);
}

function retargetProfileObsPath(profile: unknown, oldDir: string, newDir: string): boolean {
    if (!isRecord(profile) || !isRecord(profile.obs)) {
        return false;
    }

    const configuredPath = profile.obs.obs_path;
    if (typeof configuredPath !== 'string' || configuredPath.length === 0) {
        return false;
    }

    const relocatedPath = relocatedManagedObsPath(configuredPath, oldDir, newDir);
    if (relocatedPath === null || relocatedPath === configuredPath) {
        return false;
    }

    profile.obs.obs_path = relocatedPath;
    return true;
}

async function retargetCopiedManagedObsPaths(oldDir: string, newDir: string): Promise<void> {
    const copiedConfigPath = path.join(newDir, 'config.json');
    if (!(await pathExists(copiedConfigPath))) {
        return;
    }

    const rawConfig = await fsp.readFile(copiedConfigPath, 'utf-8');
    const parsedConfig: unknown = JSON.parse(rawConfig.replace(/^\uFEFF/, ''));
    if (!isRecord(parsedConfig)) {
        return;
    }

    let changed = retargetProfileObsPath(parsedConfig, oldDir, newDir);
    if (isRecord(parsedConfig.configs)) {
        for (const profile of Object.values(parsedConfig.configs)) {
            changed = retargetProfileObsPath(profile, oldDir, newDir) || changed;
        }
    }

    if (changed) {
        await fsp.writeFile(copiedConfigPath, `${JSON.stringify(parsedConfig, null, 4)}\n`, 'utf-8');
    }
}

function shouldCopyObsConfigPath(obsConfigRoot: string, sourcePath: string): boolean {
    const relativePath = path.relative(obsConfigRoot, sourcePath);
    if (!relativePath) {
        return true;
    }

    const parts = relativePath.split(path.sep).map((part) => part.toLowerCase());
    if (parts[0] === 'obs-studio' && OBS_RUNTIME_CONFIG_DIRS.has(parts[1] ?? '')) {
        return false;
    }

    return !(
        parts[0] === 'obs-studio' &&
        parts[1] === 'plugin_config' &&
        parts[2] === 'advanced-scene-switcher' &&
        parts.at(-1) === '.running'
    );
}

export async function validateTargetDir(oldDir: string, newDir: string): Promise<ValidateResult> {
    const resolvedOld = path.resolve(oldDir);
    const resolvedNew = path.resolve(newDir);

    if (resolvedOld === resolvedNew) {
        return { ok: false, error: 'The selected folder is already the current data location.' };
    }

    // Reject a target nested inside the current data dir (would copy into itself).
    const rel = path.relative(resolvedOld, resolvedNew);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return { ok: false, error: 'The new location cannot be inside the current data folder.' };
    }

    try {
        await fsp.mkdir(resolvedNew, { recursive: true });
        await fsp.access(resolvedNew, fsConstants.W_OK);
    } catch (error: any) {
        return {
            ok: false,
            error: `Cannot write to the selected folder: ${error?.message ?? error}`,
        };
    }

    try {
        const conflict = await findDestinationConflict(resolvedOld, resolvedNew);
        if (conflict) {
            return {
                ok: false,
                error: `The selected folder already contains ${conflict}. Remove it or choose another folder; GSM will not overwrite or delete files.`,
            };
        }
    } catch (error: any) {
        return {
            ok: false,
            error: `Cannot inspect the selected folder: ${error?.message ?? error}`,
        };
    }

    return { ok: true };
}

/**
 * Change the active GSM data directory by copying configuration and database files, then
 * committing the new pointer. Explicit desktop/overlay config files are included, while
 * Chromium session/storage, Yomitan data, caches, logs, installed tools, and other runtime
 * data are not copied. Nothing in the source is deleted.
 *
 * Processes holding database/config handles MUST be stopped by the caller first.
 */
export async function performDataMove(
    oldDir: string,
    newDir: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    const resolvedOld = path.resolve(oldDir);
    const resolvedNew = path.resolve(newDir);

    onProgress?.({ phase: 'validating', message: 'Checking the new data location…' });
    const validation = await validateTargetDir(resolvedOld, resolvedNew);
    if (!validation.ok) {
        throw new Error(validation.error ?? 'The selected data folder is not valid.');
    }

    const entries = await getExistingRelocationEntries(resolvedOld, resolvedNew);
    const total = entries.length;
    let completed = 0;

    for (const entry of entries) {
        onProgress?.({
            phase: 'copying',
            message: `Copying ${entry.label}…`,
            completed,
            total,
        });
        await fsp.mkdir(path.dirname(entry.destination), { recursive: true });
        await fsp.cp(entry.source, entry.destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
            filter:
                entry.label === 'obs-studio/config'
                    ? (sourcePath) => shouldCopyObsConfigPath(entry.source, sourcePath)
                    : undefined,
        });
        completed += 1;
    }

    onProgress?.({
        phase: 'finalizing',
        message: 'Updating the GSM data location…',
        completed,
        total,
    });
    await retargetCopiedManagedObsPaths(resolvedOld, resolvedNew);
    writeDataDirPointer(resolvedNew);
    writeDataDirRegistry(resolvedNew);

    onProgress?.({
        phase: 'done',
        message: 'Data location updated. Restarting…',
        completed: total,
        total,
    });
}
