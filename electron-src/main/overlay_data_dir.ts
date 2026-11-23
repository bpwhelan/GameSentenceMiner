import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getBaseDir, getDefaultBaseDir, getProfileDir } from './data_dir.js';

// The native desktop consolidates the Windows default profile before opening it.
export function getOverlayDataPath(): string {
    const baseDir = getBaseDir();
    const nested = path.join(baseDir, 'gsm_overlay');
    if (getProfileDir()) return nested;
    const legacy = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'gsm_overlay');
    const isDefault = path.resolve(baseDir) === path.resolve(getDefaultBaseDir());
    if (process.platform !== 'win32') return isDefault ? legacy : nested;

    const target = path.join(baseDir, 'Overlay');
    if (existsSync(target)) return target;
    if (isDefault) return existsSync(legacy) ? legacy : target;
    return existsSync(nested) ? nested : target;
}
