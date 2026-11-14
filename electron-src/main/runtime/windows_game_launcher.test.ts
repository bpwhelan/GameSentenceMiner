import { beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteWindowsArgument } from '../windows_command_line.js';

const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => run }));
import { launchGameAsUser } from './windows_game_launcher.js';

beforeEach(() => run.mockReset().mockResolvedValue({ stdout: '1234\r\n' }));

describe('Windows user game launch', () => {
    const command = { executable: "C:\\Games\\O'Brien & 月姫\\game.exe", args: ['', '$env:TEMP', 'a"b', 'C:\\Save Folder\\'], cwd: 'D:\\Working Folder' };

    it('passes paths and arguments as data through a bounded hidden desktop launcher', async () => {
        expect(await launchGameAsUser(command)).toBe(1234);
        const [file, args, options] = run.mock.calls[0];
        expect(file).toMatch(/System32\\WindowsPowerShell\\v1.0\\powershell.exe$/);
        expect(options).toMatchObject({ windowsHide: true, timeout: 15_000 });
        expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', expect.any(String)]);
        const script = args.at(-1);
        expect(script).not.toContain(command.executable);
        const payload = script.match(/\$requestBase64 = '([^']+)'/)![1];
        expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toEqual({
            executable: command.executable, arguments: command.args.map(quoteWindowsArgument).join(' '), cwd: command.cwd,
        });
        expect(script).not.toContain('CreateProcessWithTokenW');
        expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
    });

    it('keeps PowerShell transport output out of launch errors', async () => {
        run.mockRejectedValueOnce(Object.assign(new Error('Command failed'), {
            stdout: JSON.stringify({ error: 'Access is denied' }),
            stderr: '#< CLIXML\r\n<Objs><Obj>Preparing modules for first use.</Obj></Objs>',
        }));
        await expect(launchGameAsUser(command)).rejects.toThrow(/^Access is denied$/);
        run.mockRejectedValueOnce(Object.assign(new Error('Command failed'), {
            stderr: '#< CLIXML\r\nAccess is denied <Objs><Obj>Preparing modules for first use.</Obj></Objs>',
        }));
        await expect(launchGameAsUser(command)).rejects.toThrow(/^Access is denied$/);
    });

    it('reports helper failures and invalid acknowledgements without retrying as admin', async () => {
        run.mockRejectedValueOnce(Object.assign(new Error('Command failed: powershell.exe -EncodedCommand lots-of-data'), { stderr: 'No desktop user token\r\n' }));
        await expect(launchGameAsUser(command)).rejects.toThrow('No desktop user token');
        expect(run).toHaveBeenCalledOnce();
        run.mockResolvedValueOnce({ stdout: '' });
        await expect(launchGameAsUser(command)).rejects.toThrow('Invalid game process ID');
    });
});
