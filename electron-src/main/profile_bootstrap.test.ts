import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '', shared: '', profile: true }));
vi.mock('./data_dir.js', () => ({
    getBaseDir: () => state.base,
    getSharedBaseDir: () => state.shared,
    getProfileDir: () => state.profile ? state.base : null,
}));
import { configureDataPaths } from './profile_bootstrap.js';

let root: string;
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
    environment = { ...process.env };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-bootstrap-profile-'));
    state.base = path.join(root, '日本語 profile');
    state.shared = path.join(root, 'shared');
    state.profile = true;
});
afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    fs.rmSync(root, { recursive: true, force: true });
});

describe('early profile bootstrap', () => {
    it('redirects Chromium and child processes before their first writes', () => {
        const setPath = vi.fn((_name: string, directory: string) => {
            expect(fs.statSync(directory).isDirectory()).toBe(true);
        });
        configureDataPaths({ setPath });
        expect(Object.fromEntries(setPath.mock.calls)).toEqual({
            userData: path.join(state.base, 'electron'),
            sessionData: path.join(state.base, 'electron'),
            temp: path.join(state.base, 'temp', 'runtime'),
            logs: path.join(state.base, 'logs'),
            crashDumps: path.join(state.base, 'electron', 'Crashpad'),
            downloads: path.join(state.base, 'downloads'),
            videos: path.join(state.base, 'recordings'),
        });
        expect(process.env.GSM_DATA_DIR).toBe(state.base);
        expect(process.env.GSM_PROFILE_DIR).toBe(state.base);
        expect(process.env.GSM_OVERLAY_DATA_PATH).toBe(path.join(state.base, 'gsm_overlay'));
        expect(process.env.GSM_SHARED_DATA_DIR).toBe(state.shared);
        expect(process.env.TEMP).toBe(path.join(state.base, 'temp', 'runtime'));
        expect(process.env.TMPDIR).toBe(process.env.TEMP);
        expect(fs.existsSync(state.shared)).toBe(false);
    });
});
