import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    BrowserWindow: class BrowserWindow {},
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

    it('erases known hook noise from output text', async () => {
        const { __test } = await import('./texthook.js');

        expect(__test.eraseTextHookNoise('%D$vl123;')).toBe('');
        expect(__test.eraseTextHookNoise('before%D$vl456;after')).toBe('beforeafter');
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

    it('does not treat unreadable PE bitness as x64', async () => {
        const { __test } = await import('./texthook.js');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-texthook-'));
        const invalidExe = path.join(tmpDir, 'not-a-pe.exe');
        const x86Exe = path.join(tmpDir, 'x86.exe');
        const x64Exe = path.join(tmpDir, 'x64.exe');
        fs.writeFileSync(invalidExe, 'not a portable executable');
        const writeMinimalPe = (filePath: string, machine: number) => {
            const buf = Buffer.alloc(0x86);
            buf.writeUInt16LE(0x5a4d, 0);
            buf.writeUInt32LE(0x80, 0x3c);
            buf.write('PE\0\0', 0x80, 'ascii');
            buf.writeUInt16LE(machine, 0x84);
            fs.writeFileSync(filePath, buf);
        };
        writeMinimalPe(x86Exe, 0x14c);
        writeMinimalPe(x64Exe, 0x8664);

        try {
            expect(__test.readPortableExecutableBitness(x86Exe)).toBe('x86');
            expect(__test.readPortableExecutableBitness(x64Exe)).toBe('x64');
            expect(__test.readPortableExecutableBitness(invalidExe)).toBe('unknown');
            expect(__test.readPortableExecutableBitness(path.join(tmpDir, 'missing.exe'))).toBe(
                'unknown',
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('parses architecture mismatch recovery messages', async () => {
        const { __test } = await import('./texthook.js');

        expect(
            __test.getRequiredArchitectureFromMismatchMessage(
                'Textractor: architecture mismatch: only Textractor x86 can inject this process',
            ),
        ).toBe('x86');
        expect(
            __test.getRequiredArchitectureFromMismatchMessage(
                'architecture mismatch: only Textractor x64 can inject this process',
            ),
        ).toBe('x64');
        expect(__test.getRequiredArchitectureFromMismatchMessage('Attached successfully')).toBeNull();
    });
});
