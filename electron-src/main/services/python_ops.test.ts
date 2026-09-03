import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileAsync = vi.fn();
const mockResolvePreReleaseBackendWheelPath = vi.fn<() => string | null>();

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
