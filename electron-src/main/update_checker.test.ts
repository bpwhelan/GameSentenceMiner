import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execFileSync: vi.fn(),
    fetch: vi.fn(),
}));

vi.mock('child_process', () => ({
    execFileSync: mocks.execFileSync,
}));

vi.mock('node:fs', () => ({
    readFileSync: () => '[project]\nversion = "2026.7.4"\n',
}));

vi.mock('electron-log', () => ({
    default: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('./store.js', () => ({
    getPythonPath: () => 'C:\\managed\\python.exe',
}));

vi.mock('./services/python_ops.js', () => ({
    getProjectPath: () => 'C:\\bundled',
}));

describe('checkForUpdates', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mocks.fetch);
    });

    it('uses one PyPI request and reuses the installed version supplied by startup', async () => {
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                releases: {
                    '2026.7.4': [{ yanked: false }],
                },
            }),
        });

        const { checkForUpdates } = await import('./update_checker.js');
        const result = await checkForUpdates(false, '2026.7.4');

        expect(result).toEqual({
            updateAvailable: false,
            latestVersion: '2026.7.4',
        });
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.execFileSync).not.toHaveBeenCalled();
    });
});
