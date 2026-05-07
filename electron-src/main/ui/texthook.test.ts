import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn(),
    },
}));

vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm',
    getAssetsDir: () => 'C:\\test-gsm\\assets',
    isWindows: () => true,
    sanitizeFilename: (value: string) => value.replace(/[<>:"/\\|?*]/g, '_'),
}));

vi.mock('../main.js', () => ({
    mainWindow: null,
    sendTextHookLine: vi.fn(),
}));

vi.mock('./obs.js', () => ({
    getCurrentScene: vi.fn(),
    getExecutableNameFromSource: vi.fn(),
}));

describe('text hook flush delay helpers', () => {
    it('normalizes flush delay values to the supported range', async () => {
        const { __test } = await import('./texthook.js');

        expect(__test.normalizeFlushDelayMs(undefined)).toBe(__test.DEFAULT_FLUSH_DELAY_MS);
        expect(__test.normalizeFlushDelayMs(Number.NaN)).toBe(__test.DEFAULT_FLUSH_DELAY_MS);
        expect(__test.normalizeFlushDelayMs(-10)).toBe(0);
        expect(__test.normalizeFlushDelayMs('125')).toBe(125);
        expect(__test.normalizeFlushDelayMs(42.6)).toBe(43);
        expect(__test.normalizeFlushDelayMs(__test.MAX_FLUSH_DELAY_MS + 1)).toBe(
            __test.MAX_FLUSH_DELAY_MS,
        );
    });

    it('merges pending selected-hook output into one forwarded payload', async () => {
        const { __test } = await import('./texthook.js');
        const first = {
            text: 'line one',
            hookId: '1',
            hookFunction: 'A',
            engine: 'luna' as const,
            exeName: 'game.exe',
        };
        const second = {
            text: 'line two',
            hookId: '1',
            hookFunction: 'A',
            engine: 'luna' as const,
            exeName: 'game.exe',
        };

        expect(__test.mergeTextHookOutput([])).toBeNull();
        expect(__test.mergeTextHookOutput([first])).toBe(first);
        expect(__test.mergeTextHookOutput([first, second])).toEqual({
            ...second,
            text: 'line one\nline two',
        });
    });

    it('suppresses hook engine selection status lines', async () => {
        const { __test } = await import('./texthook.js');

        expect(__test.isIgnorableEngineLine('Now showing text only from selected hook.')).toBe(true);
        expect(__test.isIgnorableEngineLine('Selected hook #4 (Handle: 3)')).toBe(true);
        expect(
            __test.isIgnorableEngineLine(
                'Selected hook #4 (Handle: 3)Now showing text only from selected hook.',
            ),
        ).toBe(true);
    });
});
