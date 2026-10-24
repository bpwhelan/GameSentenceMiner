import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { showWindowsOBSWindow } from './windows_obs_window.js';

const runCommand = promisify(execFile);
const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
);

// Run the actual Windows helper against a native fixture. Merely checking
// IsWindowVisible cannot catch the blank Qt window this test reproduces.
describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('Windows OBS tray restore', () => {
    let directory: string;
    let executable: string;
    let journal: string;
    let fixture: ChildProcess | undefined;

    beforeAll(async () => {
        directory = await mkdtemp(path.join(tmpdir(), 'gsm-obs-tray-test-'));
        executable = path.join(directory, 'obs64.exe');
        journal = path.join(directory, 'events.txt');
        const source = fileURLToPath(new URL('../test/fixtures/obs_tray_window.cs', import.meta.url));
        await runCommand(compiler, ['/nologo', '/target:winexe', `/out:${executable}`, source], {
            windowsHide: true, timeout: 15_000,
        });
        fixture = spawn(executable, [journal], { windowsHide: true, stdio: 'ignore' });
        const deadline = Date.now() + 5_000;
        while (!existsSync(journal)) {
            if (fixture.exitCode !== null || Date.now() > deadline) throw new Error('OBS tray fixture did not start.');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }, 20_000);

    afterAll(async () => {
        if (fixture && fixture.exitCode === null) {
            const exited = once(fixture, 'exit');
            fixture.kill(); // Only this test's own fixture process.
            await exited;
        }
        // Remove only the explicitly created test files; no recursive cleanup.
        if (directory) {
            await rm(executable, { force: true });
            await rm(journal, { force: true });
            await rmdir(directory);
        }
    });

    it('restores the interface through the tray and leaves an already visible window shown', async () => {
        expect(await readFile(journal, 'utf8')).toBe('ready\n');

        await showWindowsOBSWindow(fixture!.pid!, runCommand);
        const restored = await readFile(journal, 'utf8');
        expect(restored).toContain('tray-selected\ninterface-visible\n');

        await showWindowsOBSWindow(fixture!.pid!, runCommand);
        expect(await readFile(journal, 'utf8')).toBe(restored);
    }, 30_000);
});
