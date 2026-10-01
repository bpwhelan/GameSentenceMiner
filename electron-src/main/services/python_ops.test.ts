import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';

const mockExecFileAsync = vi.fn();
const mockResolvePreReleaseBackendWheelPath = vi.fn<() => string | null>();
const mockSpawn = vi.fn();
const mockMarkSynced = vi.fn();
const mockRecordProcessOutput = vi.fn();

vi.mock('child_process', () => ({ spawn: mockSpawn }));
vi.mock('./logging.js', () => ({ recordProcessOutput: mockRecordProcessOutput }));
vi.mock('./dev_environment_sync.js', () => ({
    getDevPyprojectSyncState: () => ({ changed: true, fingerprint: 'locked-inputs' }),
    markDevPyprojectSynced: mockMarkSynced,
}));

vi.mock('../util.js', () => ({
    execFileAsync: mockExecFileAsync,
    getResourcesDir: () => 'C:\\Users\\Tester\\GSM\\GameSentenceMiner',
    getSanitizedPythonEnv: () => ({}),
    isDev: false,
    resolvePreReleaseBackendWheelPath: mockResolvePreReleaseBackendWheelPath,
}));

describe('getBundledBackendSpecifier', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('installs prerelease backends from the bundled platform wheel', async () => {
        const wheelPath =
            'C:\\Program Files\\GameSentenceMiner\\resources\\assets\\python\\gamesentenceminer-2026.8.13b1-cp310-abi3-win_amd64.whl';
        mockResolvePreReleaseBackendWheelPath.mockReturnValue(wheelPath);

        const { getBundledBackendSpecifier } = await import('./python_ops.js');

        expect(getBundledBackendSpecifier()).toBe(wheelPath);
    });
});

describe('parseUvProgressText', () => {
    it('recognizes major uv milestones and strips ANSI sequences', async () => {
        const { parseUvProgressText } = await import('./python_ops.js');

        expect(parseUvProgressText('\u001b[32mResolved 15 packages\u001b[0m', 0.1)).toEqual({
            progress: 0.25,
            message: 'Resolved 15 packages',
        });
        expect(parseUvProgressText('Downloading wheels...', 0.25)).toEqual({
            progress: 0.45,
            message: 'Downloading wheels...',
        });
        expect(parseUvProgressText('Installed 3 packages', 0.45)).toEqual({
            progress: 0.85,
            message: 'Installed 3 packages',
        });
    });

    it('keeps generic progress moving forward without regressing', async () => {
        const { parseUvProgressText } = await import('./python_ops.js');

        expect(parseUvProgressText('Using cached wheel', 0.5)).toEqual({
            progress: 0.52,
            message: 'Using cached wheel',
        });
    });
});

describe('setup command diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('retains suppressed dependency output, the command, and its exit status', async () => {
        const proc = Object.assign(new EventEmitter(), {
            pid: 1234,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        });
        mockSpawn.mockReturnValueOnce(proc);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { runCommand } = await import('./python_ops.js');
        const finished = runCommand('python', ['-m', 'uv', 'sync'], true, true, 'Sync: ', {
            suppressOutput: true, cwd: 'setup-directory',
        });
        proc.stdout.emit('data', Buffer.from('Resolved 42 packages\n'));
        proc.stderr.emit('data', Buffer.from('Downloaded dependency-wheel\n'));
        proc.emit('close', 0, null);
        await finished;

        const diagnostics = mockRecordProcessOutput.mock.calls.flat().join('\n');
        expect(diagnostics).toContain('python -m uv sync');
        expect(diagnostics).toContain('setup-directory');
        expect(diagnostics).toContain('1234');
        expect(diagnostics).toContain('Resolved 42 packages');
        expect(diagnostics).toContain('Downloaded dependency-wheel');
        expect(diagnostics).toContain('exit code 0');
        expect(consoleLog).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });

    it.each(['exit', 'signal', 'spawn'] as const)('records a %s failure before rejecting', async (failure) => {
        const proc = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        mockSpawn.mockReturnValueOnce(proc);
        const { runCommand } = await import('./python_ops.js');
        const finished = runCommand('python', ['-m', 'pip', 'check'], true, true, '', { suppressOutput: true });
        if (failure === 'spawn') proc.emit('error', new Error('ENOENT'));
        else proc.emit('close', failure === 'exit' ? 17 : null, failure === 'signal' ? 'SIGTERM' : null);
        const expected = failure === 'exit' ? 'exit code 17' : failure === 'signal' ? 'SIGTERM' : 'ENOENT';
        await expect(finished).rejects.toThrow(expected);
        expect(mockRecordProcessOutput.mock.calls.flat().join('\n')).toContain(expected);
    });

    it('retains output from buffered uv bootstrap commands', async () => {
        mockExecFileAsync.mockResolvedValueOnce({ stdout: 'Version: 0.1.0\n', stderr: '' });
        mockExecFileAsync.mockResolvedValueOnce({ stdout: 'Installed uv==0.12.4', stderr: 'Retrying package download' });
        const { checkAndInstallUV } = await import('./python_ops.js');
        await checkAndInstallUV('python');
        const diagnostics = mockRecordProcessOutput.mock.calls.flat().join('\n');
        expect(diagnostics).toContain('Installed uv==0.12.4');
        expect(diagnostics).toContain('Retrying package download');
    });

    it('retains buffered failure output that is missing from the exception message', async () => {
        mockExecFileAsync.mockResolvedValueOnce({ stdout: 'Version: 0.1.0\n', stderr: '' });
        mockExecFileAsync.mockRejectedValueOnce(Object.assign(new Error('pip failed'), {
            stdout: 'Attempted index mirror', stderr: 'Certificate validation failed',
        }));
        const { checkAndInstallUV } = await import('./python_ops.js');
        await expect(checkAndInstallUV('python')).rejects.toThrow('pip failed');
        const diagnostics = mockRecordProcessOutput.mock.calls.flat().join('\n');
        expect(diagnostics).toContain('Attempted index mirror');
        expect(diagnostics).toContain('Certificate validation failed');
    });

    it('records synchronous launch errors and clears the progress timer', async () => {
        vi.useFakeTimers();
        try {
            mockSpawn.mockImplementationOnce(() => { throw new Error('Invalid command path'); });
            const { runCommand } = await import('./python_ops.js');
            await expect(runCommand('python', [], true, true, '', { onProgress: vi.fn() }))
                .rejects.toThrow('Invalid command path');
            expect(mockRecordProcessOutput.mock.calls.flat().join('\n')).toContain('Invalid command path');
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('checkAndEnsurePip', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('fails fast when ensurepip succeeds but pip is still unusable', async () => {
        const pipBrokenError = new Error("ModuleNotFoundError: No module named 'pip._internal'");

        mockExecFileAsync
            .mockRejectedValueOnce(pipBrokenError)
            .mockResolvedValueOnce({ stdout: '', stderr: '' })
            .mockRejectedValueOnce(pipBrokenError);

        const { checkAndEnsurePip } = await import('./python_ops.js');

        await expect(
            checkAndEnsurePip('C:\\Users\\Tester\\AppData\\Roaming\\GameSentenceMiner\\python_venv\\Scripts\\python.exe')
        ).rejects.toThrow(/Failed to bootstrap pip via ensurepip/);

        expect(mockExecFileAsync).toHaveBeenNthCalledWith(1, expect.any(String), ['-m', 'pip', '--version']);
        expect(mockExecFileAsync).toHaveBeenNthCalledWith(2, expect.any(String), ['-m', 'ensurepip', '--upgrade']);
        expect(mockExecFileAsync).toHaveBeenNthCalledWith(3, expect.any(String), ['-m', 'pip', '--version']);
    });
});

describe('checkAndInstallUV', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('keeps the exact lock-compatible uv version', async () => {
        mockExecFileAsync.mockResolvedValueOnce({
            stdout: 'Name: uv\nVersion: 0.12.4\n',
            stderr: '',
        });

        const { checkAndInstallUV } = await import('./python_ops.js');
        await checkAndInstallUV('C:\\managed\\python.exe');

        expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    });

    it.each(['0.9.22', '0.11.33'])(
        'replaces incompatible uv %s with the exact lock-compatible version',
        async (installedVersion) => {
            mockExecFileAsync
                .mockResolvedValueOnce({
                    stdout: `Name: uv\nVersion: ${installedVersion}\n`,
                    stderr: '',
                })
                .mockResolvedValueOnce({ stdout: '', stderr: '' });

            const { checkAndInstallUV } = await import('./python_ops.js');
            await checkAndInstallUV('C:\\managed\\python.exe');

            expect(mockExecFileAsync).toHaveBeenLastCalledWith(
                'C:\\managed\\python.exe',
                [
                    '-m',
                    'pip',
                    'install',
                    '--no-warn-script-location',
                    'uv==0.12.4',
                ]
            );
        }
    );
});

describe('locked environment validation', () => {
    const venvPath = path.resolve('managed');
    const pythonPath = path.join(venvPath, 'Scripts', 'python.exe');
    let backendReplaced: boolean;
    let brokenDependency: boolean;

    beforeEach(() => {
        vi.clearAllMocks();
        backendReplaced = false;
        brokenDependency = false;
        mockSpawn.mockImplementation((_command: string, args: string[]) => {
            const proc = Object.assign(new EventEmitter(), {
                stdout: new EventEmitter(),
                stderr: new EventEmitter(),
            });
            queueMicrotask(() => {
                if (args.includes('install')) backendReplaced = true;
                const failsCheck = args.join(' ') === '-m pip check' &&
                    (!backendReplaced || brokenDependency);
                if (failsCheck) {
                    proc.stdout.emit('data', Buffer.from('GameSentenceMiner requires uv<0.12.0'));
                }
                proc.emit('close', failsCheck ? 1 : 0, null);
            });
            return proc;
        });
    });

    it('validates and stamps upgrades only after replacing the old backend metadata', async () => {
        const { syncLockedEnvironment, installPackageNoDeps } = await import('./python_ops.js');

        await syncLockedEnvironment(pythonPath, ['gpu'], false, undefined, { deferValidation: true });
        expect(mockMarkSynced).not.toHaveBeenCalled();
        await installPackageNoDeps(pythonPath, 'GameSentenceMiner==2026.8.3', true, undefined, ['gpu']);

        expect(mockSpawn.mock.calls.map((call) => call[1].slice(0, 4))).toEqual([
            ['-m', 'uv', 'sync', '--active'],
            ['-m', 'uv', 'pip', 'install'],
            ['-m', 'pip', 'check'],
        ]);
        expect(mockMarkSynced).toHaveBeenCalledWith(venvPath, 'locked-inputs');
    });

    it('still rejects broken dependencies and leaves the environment unstamped after installation', async () => {
        brokenDependency = true;
        const { syncLockedEnvironment, installPackageNoDeps } = await import('./python_ops.js');

        await syncLockedEnvironment(pythonPath, [], false, undefined, { deferValidation: true });
        await expect(
            installPackageNoDeps(pythonPath, 'GameSentenceMiner==2026.8.3', true, undefined, [])
        ).rejects.toThrow('failed with exit code 1');
        expect(mockMarkSynced).not.toHaveBeenCalled();
    });

    it('continues validating ordinary dependency-only syncs', async () => {
        const { syncLockedEnvironment } = await import('./python_ops.js');

        await expect(syncLockedEnvironment(pythonPath)).rejects.toThrow('failed with exit code 1');
        expect(mockMarkSynced).not.toHaveBeenCalled();
    });
});
