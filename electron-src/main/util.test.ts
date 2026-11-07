import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFile, app } = vi.hoisted(() => ({
    execFile: vi.fn(),
    app: { isPackaged: false, getPath: vi.fn(() => 'C:\\GSM\\electron.exe'), quit: vi.fn(), exit: vi.fn() },
}));
vi.mock('child_process', () => ({ execFile, spawn: vi.fn(), execSync: vi.fn() }));
vi.mock('electron', () => ({ app }));
vi.mock('./main.js', () => ({ __dirname: 'test-data' }));
vi.mock('./data_dir.js', () => ({ getBaseDir: () => 'test-data' }));

import { getPidByProcessName, restartAsAdmin } from './util.js';

const originalPlatform = process.platform;
afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }));

describe('process name lookup', () => {
    it('passes Windows executable names as literal arguments', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const name = "Sam's %TEMP% & [日本語].exe";
        execFile.mockImplementation((_file: string, _args: string[], callback: Function) => {
            callback(null, `"${name}","1234","Console","1","100,000 K"`);
        });

        await expect(getPidByProcessName(name)).resolves.toBe(1234);
        expect(execFile).toHaveBeenCalledWith('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], expect.any(Function));
    });

    it('matches punctuation in Unix executable names literally', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        execFile.mockImplementation((_file: string, _args: string[], callback: Function) => callback(null, '1234\n'));

        await expect(getPidByProcessName('Sam [1] $game')).resolves.toBe(1234);
        expect(execFile).toHaveBeenCalledWith('pgrep', [String.raw`^Sam \[1\] \$game$`], expect.any(Function));
    });
});

describe('administrator restart', () => {
    it('leaves the app running while UAC is pending or cancelled', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let complete!: (error: Error | null) => void;
        execFile.mockImplementation((_file: string, _args: string[], options: unknown, callback: typeof complete) => {
            expect(options).toEqual({ windowsHide: true });
            complete = callback;
        });
        const pending = restartAsAdmin();
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.exit).not.toHaveBeenCalled();
        complete(new Error('UAC cancelled'));
        await expect(pending).resolves.toBe(false);
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.exit).not.toHaveBeenCalled();
    });

    it('uses normal app shutdown only after Windows accepts the elevation request', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Function) => callback(null));
        await expect(restartAsAdmin()).resolves.toBe(true);
        expect(app.quit).toHaveBeenCalledTimes(1);
        expect(app.exit).not.toHaveBeenCalled();
        const [executable, args] = execFile.mock.calls[0];
        expect(executable).toContain('System32\\WindowsPowerShell');
        expect(args.at(-1)).toContain('-WindowStyle Hidden -Verb RunAs');
    });
});
