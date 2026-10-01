import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ base: '', defaultBase: '' }));
vi.mock('./data_dir.js', () => ({
    getBaseDir: () => dirs.base,
    getDefaultBaseDir: () => dirs.defaultBase,
}));
import { getOverlayDataPath } from './overlay_data_dir.js';

afterEach(() => vi.unstubAllEnvs());

describe('overlay settings location shared by the overlay and input server', () => {
    it('preserves the sibling overlay settings directory for default installations', () => {
        vi.stubEnv('APPDATA', path.resolve('appdata'));
        dirs.base = dirs.defaultBase = path.join(process.env.APPDATA!, 'GameSentenceMiner');
        expect(getOverlayDataPath()).toBe(path.join(process.env.APPDATA!, 'gsm_overlay'));
    });

    it('uses the selected GSM directory after relocation', () => {
        dirs.defaultBase = path.resolve('appdata', 'GameSentenceMiner');
        dirs.base = path.resolve('relocated-gsm');
        expect(getOverlayDataPath()).toBe(path.join(dirs.base, 'gsm_overlay'));
    });

    it('uses the legacy config directory without APPDATA', () => {
        vi.stubEnv('APPDATA', '');
        dirs.base = dirs.defaultBase = path.join(os.homedir(), '.config', 'GameSentenceMiner');
        expect(getOverlayDataPath()).toBe(path.join(os.homedir(), '.config', 'gsm_overlay'));
    });
});
