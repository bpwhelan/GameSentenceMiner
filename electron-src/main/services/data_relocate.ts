import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    getDefaultBaseDir,
    writeDataDirPointer,
    writeDataDirRegistry,
} from '../data_dir.js';

// Entries that are NOT moved with the rest of the data:
//  - python_venv / uv: platform-specific and full of absolute paths; rebuilt at the new
//    location instead (the missing venv triggers the existing auto-install on next boot).
//  - data_dir.json: the pointer file must stay at the fixed default location.
const EXCLUDED_ENTRIES = new Set(['python_venv', 'uv', 'data_dir.json']);
const REBUILT_ENTRIES = ['python_venv', 'uv'];

export interface RelocateProgress {
    phase: 'validating' | 'copying' | 'finalizing' | 'cleanup' | 'done';
    message: string;
    completed?: number;
    total?: number;
}

export type ProgressCallback = (progress: RelocateProgress) => void;

export interface ValidateResult {
    ok: boolean;
    error?: string;
}

/** Legacy overlay dir is a sibling of the default data dir; once relocated it lives under it. */
function legacyOverlayDir(): string {
    return path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'gsm_overlay');
}

function overlayDirFor(baseDir: string): string {
    return path.resolve(baseDir) === path.resolve(getDefaultBaseDir())
        ? legacyOverlayDir()
        : path.join(baseDir, 'gsm_overlay');
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await fsp.access(p);
        return true;
    } catch {
        return false;
    }
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
        const probe = path.join(resolvedNew, '.gsm_write_probe');
        await fsp.writeFile(probe, 'ok');
        await fsp.rm(probe, { force: true });
    } catch (err: any) {
        return { ok: false, error: `Cannot write to the selected folder: ${err?.message ?? err}` };
    }

    return { ok: true };
}

/** Move one entry: fast rename on the same volume, copy+delete across volumes (EXDEV). */
async function moveEntry(src: string, dst: string): Promise<void> {
    await fsp.rm(dst, { recursive: true, force: true });
    try {
        await fsp.rename(src, dst);
    } catch (err: any) {
        if (err?.code !== 'EXDEV') {
            throw err;
        }
        // Cross-volume: copy fully first, only then remove the source.
        await fsp.cp(src, dst, { recursive: true, force: true });
        await fsp.rm(src, { recursive: true, force: true });
    }
}

/**
 * Relocate all GSM data from oldDir to newDir. Crash-safe ordering:
 *   1. Copy every entry (and the overlay dir) to the new location — nothing deleted yet.
 *   2. Commit by writing the pointer + registry value (this is the point of no return).
 *   3. Delete the old copies + the rebuilt-from-scratch venv/uv.
 * A crash before step 2 leaves the old data fully intact (pointer still references it).
 *
 * Process holding file handles (backend, overlay, OBS) MUST be stopped by the caller first.
 */
export async function performDataMove(
    oldDir: string,
    newDir: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    const resolvedOld = path.resolve(oldDir);
    const resolvedNew = path.resolve(newDir);

    onProgress?.({ phase: 'validating', message: 'Preparing to move…' });
    await fsp.mkdir(resolvedNew, { recursive: true });

    const entries = (await fsp.readdir(resolvedOld)).filter((e) => !EXCLUDED_ENTRIES.has(e));
    const oldOverlay = overlayDirFor(resolvedOld);
    const newOverlay = path.join(resolvedNew, 'gsm_overlay');
    const hasOverlay = path.resolve(oldOverlay) !== path.resolve(newOverlay) && (await pathExists(oldOverlay));

    const total = entries.length + (hasOverlay ? 1 : 0);
    let completed = 0;

    // Phase 1: copy everything (no deletes yet) so a failure leaves the old dir intact.
    for (const entry of entries) {
        onProgress?.({ phase: 'copying', message: `Copying ${entry}…`, completed, total });
        await fsp.cp(path.join(resolvedOld, entry), path.join(resolvedNew, entry), {
            recursive: true,
            force: true,
        });
        completed += 1;
    }
    if (hasOverlay) {
        onProgress?.({ phase: 'copying', message: 'Copying overlay settings…', completed, total });
        await fsp.cp(oldOverlay, newOverlay, { recursive: true, force: true });
        completed += 1;
    }

    // Phase 2: commit. From here on, the app resolves to the new location.
    onProgress?.({ phase: 'finalizing', message: 'Updating data location…', completed, total });
    writeDataDirPointer(resolvedNew);
    writeDataDirRegistry(resolvedNew);

    // Phase 3: remove the old copies and the venv/uv (which will be rebuilt fresh).
    onProgress?.({ phase: 'cleanup', message: 'Cleaning up old files…', completed, total });
    for (const entry of [...entries, ...REBUILT_ENTRIES]) {
        await fsp.rm(path.join(resolvedOld, entry), { recursive: true, force: true });
    }
    if (hasOverlay) {
        await fsp.rm(oldOverlay, { recursive: true, force: true });
    }

    onProgress?.({ phase: 'done', message: 'Move complete. Restarting…', completed: total, total });
}
