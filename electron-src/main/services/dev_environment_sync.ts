import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEV_PYPROJECT_SYNC_STAMP = '.gsm-environment-v2.sha256';

export interface DevPyprojectSyncState {
    changed: boolean;
    fingerprint: string;
}

/**
 * Compare every input that selects the managed dependency set with the last
 * version successfully synced into this environment.
 */
export function getDevPyprojectSyncState(
    projectPath: string,
    venvPath: string,
    extras: string[] = []
): DevPyprojectSyncState {
    const pyproject = fs.readFileSync(path.join(projectPath, 'pyproject.toml'));
    const lockfile = fs.readFileSync(path.join(projectPath, 'uv.lock'));
    const pythonVersion = fs.readFileSync(path.join(projectPath, '.python-version'));
    const normalizedExtras = Array.from(
        new Set(
            extras
                .map((extra) => extra.trim().toLowerCase())
                .filter((extra) => extra.length > 0)
        )
    ).sort();
    const fingerprint = createHash('sha256')
        .update('gsm-managed-environment-v2\0')
        .update('pyproject.toml\0')
        .update(pyproject)
        .update('\0uv.lock\0')
        .update(lockfile)
        .update('\0.python-version\0')
        .update(pythonVersion)
        .update('\0extras\0')
        .update(JSON.stringify(normalizedExtras))
        .digest('hex');
    const stampPath = path.join(venvPath, DEV_PYPROJECT_SYNC_STAMP);

    let lastSyncedFingerprint: string | null = null;
    try {
        lastSyncedFingerprint = fs.readFileSync(stampPath, 'utf8').trim();
    } catch (error) {
        if (!isMissingFileError(error)) {
            throw error;
        }
    }

    return {
        changed: lastSyncedFingerprint !== fingerprint,
        fingerprint,
    };
}

/** Record a successful full lock sync without letting a marker-write failure block startup. */
export function markDevPyprojectSynced(venvPath: string, fingerprint: string): void {
    const stampPath = path.join(venvPath, DEV_PYPROJECT_SYNC_STAMP);
    try {
        fs.writeFileSync(stampPath, `${fingerprint}\n`, 'utf8');
    } catch (error) {
        console.warn(`Failed to record the managed environment sync at ${stampPath}:`, error);
    }
}

function isMissingFileError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
    );
}
