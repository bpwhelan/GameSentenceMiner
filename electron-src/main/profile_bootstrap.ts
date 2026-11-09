import * as fs from 'node:fs';
import * as path from 'node:path';
import type { App } from 'electron';
import { getBaseDir, getProfileDir, getSharedBaseDir } from './data_dir.js';

/** Run synchronously before app.ready, stores, Chromium sessions, or any children. */
export function configureDataPaths(app: Pick<App, 'setPath'>): void {
    const base = getBaseDir();
    const userData = path.join(base, 'electron');
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
    app.setPath('sessionData', userData);
    process.env.GSM_DATA_DIR = base;
    process.env.GSM_SHARED_DATA_DIR = getSharedBaseDir();
    if (!getProfileDir()) return;

    // Canonicalize relative CLI paths once so helpers and relaunches keep the
    // same identity even when their working directory differs from the launcher.
    process.env.GSM_PROFILE_DIR = base;
    process.env.GSM_OVERLAY_DATA_PATH = path.join(base, 'gsm_overlay');
    const temporary = path.join(base, 'temp', 'runtime');
    for (const [name, directory] of [
        ['temp', temporary], ['logs', path.join(base, 'logs')],
        ['crashDumps', path.join(base, 'electron', 'Crashpad')],
        ['downloads', path.join(base, 'downloads')], ['videos', path.join(base, 'recordings')],
    ] as const) {
        fs.mkdirSync(directory, { recursive: true });
        app.setPath(name, directory);
    }
    // Python's tempfile and managed subprocesses inherit profile-local scratch space.
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = temporary;
}
