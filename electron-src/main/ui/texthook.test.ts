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

    it('distinguishes Luna hooks that share a name by their ctx address', async () => {
        const { __test } = await import('./texthook.js');

        // Two hooks with the same name/hook code/module differing only in ctx.
        const a = __test.parseLunaContext('3', '2:49D4:F0AB70:6BF80:0:Pal:ENHSX-C@6AB70:totsulover.exe');
        const b = __test.parseLunaContext('1', '0:49D4:F0AB70:6C1C5:0:Pal:ENHSX-C@6AB70:totsulover.exe');

        expect(a.function).toBe('Pal (6BF80:0)');
        expect(b.function).toBe('Pal (6C1C5:0)');
        expect(a.function).not.toBe(b.function);

        // A richer context with a trailing module function still labels by name + ctx.
        const c = __test.parseLunaContext(
            '2',
            '1:49D4:100AB8C0:6B653:0:PalFontDrawText:HS8@0:Pal.dll:PalFontDrawText',
        );
        expect(c.function).toBe('PalFontDrawText (6B653:0)');

        // Malformed/short contexts fall back without throwing.
        expect(__test.parseLunaContext('5', 'Unknown').function).toBe('Unknown');
    });

    it('matches old profiles saved with the bare hook name', async () => {
        const { __test } = await import('./texthook.js');

        // New profile: exact full-label match.
        expect(__test.hookFunctionMatches('Pal (6BF80:0)', 'Pal (6BF80:0)')).toBe(true);
        // Legacy profile saved only the bare name -> still matches via base name.
        expect(__test.hookFunctionMatches('Pal', 'Pal (6BF80:0)')).toBe(true);
        expect(__test.hookFunctionMatches('Pal', 'Pal (6C1C5:0)')).toBe(true);
        // Different name must not match.
        expect(__test.hookFunctionMatches('PalFontDrawText', 'Pal (6BF80:0)')).toBe(false);
        // Empty/undefined saved value never matches.
        expect(__test.hookFunctionMatches(null, 'Pal (6BF80:0)')).toBe(false);
        expect(__test.hookFunctionMatches('', 'Pal (6BF80:0)')).toBe(false);
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

describe('game process resolution', () => {
    // LAUNCHER_MEMORY_FLOOR is 20 MB; pick values comfortably above/below it.
    const heavy = 200 * 1024 * 1024;
    const tiny = 5 * 1024 * 1024;

    it('keeps the launcher floor at 20 MB', async () => {
        const { __test } = await import('./texthook.js');
        expect(__test.LAUNCHER_MEMORY_FLOOR).toBe(20 * 1024 * 1024);
    });

    it('strips the final extension for base-name comparison', async () => {
        const { __test } = await import('./texthook.js');
        expect(__test.processBaseName('Game.BIN')).toBe('game');
        expect(__test.processBaseName('game.log')).toBe('game');
        expect(__test.processBaseName('game')).toBe('game');
        expect(__test.processBaseName('my.game.exe')).toBe('my.game');
    });

    it('matches a non-.exe game image such as game.log directly', async () => {
        const { __test } = await import('./texthook.js');
        // Mirrors a real captured game on this machine (YU-RIS engine .log image).
        const procs = [
            { pid: 77064, ppid: 464, name: 'サメと生きる七日間.log', memory: heavy },
            { pid: 55536, ppid: 59380, name: 'obs64.exe', memory: heavy * 2 },
        ];
        const chosen = __test.selectGameProcess(procs, 'サメと生きる七日間.log');
        expect(chosen?.pid).toBe(77064);
        expect(chosen?.name).toBe('サメと生きる七日間.log');
    });

    it('does not mangle .bin names by assuming a .exe extension', async () => {
        const { __test } = await import('./texthook.js');
        // Regression: the old code appended ".exe" (-> "Tartarus.bin.exe") and never matched.
        const procs = [{ pid: 7, ppid: 0, name: 'Tartarus.bin', memory: heavy }];
        expect(__test.selectGameProcess(procs, 'Tartarus.bin')?.pid).toBe(7);
    });

    it('follows a thin launcher to its heaviest child', async () => {
        const { __test } = await import('./texthook.js');
        const procs = [
            { pid: 10, ppid: 4, name: 'launcher.exe', memory: tiny },
            { pid: 11, ppid: 10, name: 'engine.bin', memory: heavy },
            { pid: 12, ppid: 10, name: 'helper.exe', memory: tiny },
        ];
        const chosen = __test.selectGameProcess(procs, 'launcher.exe');
        expect(chosen?.pid).toBe(11);
        expect(chosen?.name).toBe('engine.bin');
    });

    it('resolves same-base-name engines when PID reuse hides the parent link', async () => {
        const { __test } = await import('./texthook.js');
        // Windows can report cyclic ParentProcessId values after PID reuse.
        const procs = [
            { pid: 1052, ppid: 26116, name: 'game.log', memory: tiny },
            { pid: 26116, ppid: 1052, name: 'game.bin', memory: heavy },
        ];
        // Captured the light launcher; expect the heavy engine of the same base.
        expect(__test.selectGameProcess(procs, 'game.log')?.pid).toBe(26116);
    });

    it('does not loop forever on cyclic parent references', async () => {
        const { __test } = await import('./texthook.js');
        const procs = [
            { pid: 1, ppid: 2, name: 'a.exe', memory: tiny },
            { pid: 2, ppid: 1, name: 'b.exe', memory: tiny },
        ];
        const descendants = __test.collectDescendants(procs, [1]);
        expect(descendants.map((p) => p.pid)).toEqual([2]);
    });

    it('falls back to the heaviest exact match when nothing clears the floor', async () => {
        const { __test } = await import('./texthook.js');
        const procs = [
            { pid: 1, ppid: 0, name: 'game.exe', memory: tiny },
            { pid: 2, ppid: 0, name: 'game.exe', memory: tiny * 2 },
        ];
        expect(__test.selectGameProcess(procs, 'game.exe')?.pid).toBe(2);
    });

    it('returns null when no process matches at all', async () => {
        const { __test } = await import('./texthook.js');
        const procs = [{ pid: 1, ppid: 0, name: 'other.exe', memory: heavy }];
        expect(__test.selectGameProcess(procs, 'game.bin')).toBeNull();
    });
});
