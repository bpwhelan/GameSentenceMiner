import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => run }));
import { probeWindowsProcessPrivileges } from './windows_process_privileges.js';

beforeEach(() => run.mockResolvedValue({ stdout: JSON.stringify({ gsmElevated: false, processes: [] }) }));

describe('Windows process token probe', () => {
    it('bounds a hidden read-only query and encodes executable names as data', async () => {
        const targets = [{ exeName: "O'Brien $env:TEMP & 日本語.exe", pid: 123 }];
        await probeWindowsProcessPrivileges(targets);
        const [executable, args, options] = run.mock.calls[0];
        expect(executable).toMatch(/System32\\WindowsPowerShell\\v1.0\\powershell.exe$/);
        expect(options).toMatchObject({ windowsHide: true, timeout: 8_000 });
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        expect(script).not.toContain(targets[0].exeName);
        const payload = script.match(/FromBase64String\('([^']+)'\)/)![1];
        expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toEqual({ gsmPid: process.pid, targets });
        expect(script).toContain('OpenProcess(0x1000, false, pid)');
        expect(script).toContain('GetTokenInformation(token, 20');
    });

    it('reads the real executable image name for games using .bin or .log', async () => {
        await probeWindowsProcessPrivileges([{ exeName: 'game.bin', pid: 123 }]);
        const script = Buffer.from(run.mock.calls[0][1].at(-1), 'base64').toString('utf16le');
        expect(script).toContain('QueryFullProcessImageName');
        expect(script).not.toContain("$candidate.ProcessName + '.exe'");
        expect(script).toContain('GetProcessesByName($target.exeName)');
    });

    it('retains unknown token results and filters malformed identities', async () => {
        run.mockResolvedValue({ stdout: '\uFEFF' + JSON.stringify({ gsmElevated: null, processes: [
            { pid: 123, exeName: 'game.exe', startedAt: '1', elevated: null },
            { pid: 0, exeName: 'game.exe', startedAt: '1', elevated: true },
            { pid: 123, exeName: 'game.exe', startedAt: null, elevated: true },
        ] }) });
        expect(await probeWindowsProcessPrivileges([])).toEqual({ gsmElevated: null, processes: [
            { pid: 123, exeName: 'game.exe', startedAt: '1', elevated: null },
        ] });
    });

    it('does not treat invalid output as evidence of elevation', async () => {
        run.mockResolvedValue({ stdout: '{}' });
        await expect(probeWindowsProcessPrivileges([])).rejects.toThrow('Invalid GSM token result');
    });
});
