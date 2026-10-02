import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', () => ({ execFile, spawn: vi.fn(), execSync: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./main.js', () => ({ __dirname: 'test-data' }));
vi.mock('./data_dir.js', () => ({ getBaseDir: () => 'test-data' }));

import { getPidByProcessName } from './util.js';

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
