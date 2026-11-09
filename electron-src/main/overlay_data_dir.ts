import * as os from 'node:os';
import * as path from 'node:path';
import { getBaseDir, getDefaultBaseDir, getProfileDir } from './data_dir.js';

// The default installation retains the legacy sibling overlay directory.
// Relocated installations keep overlay data inside the selected GSM directory.
export function getOverlayDataPath(): string {
    const baseDir = getBaseDir();
    return !getProfileDir() && path.resolve(baseDir) === path.resolve(getDefaultBaseDir())
        ? path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'gsm_overlay')
        : path.join(baseDir, 'gsm_overlay');
}
