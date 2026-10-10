import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isDev: false,
    readFileSync: vi.fn(),
    execFileSync: vi.fn(),
    fetch: vi.fn(),
}));

vi.mock('node:fs', () => ({ readFileSync: mocks.readFileSync }));
vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./store.js', () => ({ getPythonPath: () => 'managed-python' }));
vi.mock('./services/python_ops.js', () => ({ getProjectPath: () => '/gsm-project' }));
vi.mock('./util.js', () => ({ get isDev() { return mocks.isDev; } }));

import { checkForUpdates } from './update_checker.js';

describe('backend update source selection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isDev = false;
        mocks.readFileSync.mockReturnValue('[project]\nversion = "2026.10.0"\n');
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                releases: {
                    '2026.10.0': [{ yanked: false }],
                    '2026.10.0.post1': [{ yanked: false }],
                },
            }),
        });
        vi.stubGlobal('fetch', mocks.fetch);
    });

    afterEach(() => vi.unstubAllGlobals());

    it('uses one PyPI request and reuses the installed version supplied by startup', async () => {
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ releases: { '2026.10.0': [{ yanked: false }] } }),
        });

        await expect(checkForUpdates(false, '2026.10.0')).resolves.toEqual({
            updateAvailable: false,
            latestVersion: '2026.10.0',
        });
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(mocks.execFileSync).not.toHaveBeenCalled();
    });

    it('reuses the local backend on repeated launches even when PyPI has a post release', async () => {
        mocks.isDev = true;

        for (let launch = 0; launch < 2; launch++) {
            await expect(checkForUpdates(false, '2026.10.0')).resolves.toEqual({
                updateAvailable: false,
                latestVersion: '2026.10.0',
            });
        }

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.execFileSync).not.toHaveBeenCalled();
    });

    it.each([null, '2026.9.4'])('still installs a missing or incompatible local backend (%s)', async (installed) => {
        mocks.isDev = true;

        await expect(checkForUpdates(false, installed)).resolves.toEqual({
            updateAvailable: true,
            latestVersion: '2026.10.0',
        });
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('still allows an explicit local backend repair', async () => {
        mocks.isDev = true;

        await expect(checkForUpdates(true, '2026.10.0')).resolves.toEqual({
            updateAvailable: true,
            latestVersion: '2026.10.0',
        });
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('keeps compatible PyPI hotfix updates enabled for packaged releases', async () => {
        await expect(checkForUpdates(false, '2026.10.0')).resolves.toEqual({
            updateAvailable: true,
            latestVersion: '2026.10.0.post1',
        });
        expect(mocks.fetch).toHaveBeenCalledOnce();
    });

    it('does not reinstall a packaged hotfix that is already current', async () => {
        await expect(checkForUpdates(false, '2026.10.0.post1')).resolves.toEqual({
            updateAvailable: false,
            latestVersion: '2026.10.0.post1',
        });
    });
});
