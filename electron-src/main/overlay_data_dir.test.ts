import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ base: '', defaultBase: '' }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('./data_dir.js', () => ({
    getBaseDir: () => dirs.base,
    getDefaultBaseDir: () => dirs.defaultBase,
    getProfileDir: () => process.env.GSM_PROFILE_DIR || null,
}));
import { getOverlayDataPath } from './overlay_data_dir.js';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(fs.existsSync).mockReset();
});

describe('overlay settings location shared by the overlay and input server', () => {
    it('keeps explicit profiles within their root', () => {
        dirs.base = dirs.defaultBase = path.resolve('appdata', 'GameSentenceMiner');
        vi.stubEnv('GSM_PROFILE_DIR', dirs.base);
        expect(getOverlayDataPath()).toBe(path.join(dirs.base, 'gsm_overlay'));
    });

    it('prefers the consolidated Windows profile once migration publishes it', () => {
        vi.stubEnv('APPDATA', path.resolve('appdata'));
        dirs.base = dirs.defaultBase = path.join(process.env.APPDATA!, 'GameSentenceMiner');
        vi.mocked(fs.existsSync).mockReturnValue(true);
        expect(getOverlayDataPath()).toBe(process.platform === 'win32'
            ? path.join(dirs.base, 'Overlay') : path.join(process.env.APPDATA!, 'gsm_overlay'));
    });

    it('falls back to an existing legacy directory until migration succeeds', () => {
        vi.stubEnv('APPDATA', path.resolve('appdata'));
        dirs.base = dirs.defaultBase = path.join(process.env.APPDATA!, 'GameSentenceMiner');
        const legacy = path.join(process.env.APPDATA!, 'gsm_overlay');
        vi.mocked(fs.existsSync).mockImplementation((candidate) => candidate === legacy);
        expect(getOverlayDataPath()).toBe(legacy);
    });

    it('keeps an existing relocated overlay inside the selected directory', () => {
        dirs.defaultBase = path.resolve('appdata', 'GameSentenceMiner');
        dirs.base = path.resolve('relocated-gsm');
        const existing = path.join(dirs.base, 'gsm_overlay');
        vi.mocked(fs.existsSync).mockImplementation((candidate) => candidate === existing);
        expect(getOverlayDataPath()).toBe(existing);
    });

    it('does not change the legacy Unix config directory', () => {
        if (process.platform === 'win32') return;
        vi.stubEnv('APPDATA', '');
        dirs.base = dirs.defaultBase = path.join(os.homedir(), '.config', 'GameSentenceMiner');
        expect(getOverlayDataPath()).toBe(path.join(os.homedir(), '.config', 'gsm_overlay'));
    });
});
