import * as os from 'node:os';
import * as path from 'node:path';
import { getBaseDir, getDefaultBaseDir } from './data_dir.js';

// The default installation retains the legacy sibling overlay directory.
// Relocated installations keep overlay data inside the selected GSM directory.
export function getOverlayDataPath(): string {
    const baseDir = getBaseDir();
    return path.resolve(baseDir) === path.resolve(getDefaultBaseDir())
        ? path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'gsm_overlay')
        : path.join(baseDir, 'gsm_overlay');
}
