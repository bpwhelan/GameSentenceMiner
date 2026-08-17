import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEV_PYPROJECT_SYNC_STAMP = '.gsm-dev-pyproject.sha256';

export interface DevPyprojectSyncState {
    changed: boolean;
    fingerprint: string;
}

/**
 * Compare the current pyproject contents with the last version successfully
 * synced into this particular managed environment.
 */
export function getDevPyprojectSyncState(
    projectPath: string,
    venvPath: string
): DevPyprojectSyncState {
    const pyproject = fs.readFileSync(path.join(projectPath, 'pyproject.toml'));
    const fingerprint = createHash('sha256').update(pyproject).digest('hex');
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

/** Record a successful sync without letting a marker-write failure block startup. */
export function markDevPyprojectSynced(venvPath: string, fingerprint: string): void {
    const stampPath = path.join(venvPath, DEV_PYPROJECT_SYNC_STAMP);
    try {
        fs.writeFileSync(stampPath, `${fingerprint}\n`, 'utf8');
    } catch (error) {
        console.warn(`Failed to record the development pyproject sync at ${stampPath}:`, error);
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
