import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileAsync, mockResolvePreReleaseMetadata } = vi.hoisted(() => ({
    mockExecFileAsync: vi.fn(),
    mockResolvePreReleaseMetadata: vi.fn(),
}));

vi.mock('../util.js', () => ({
    BACKEND_GITHUB_REPO_URL: 'https://github.com/bpwhelan/GameSentenceMiner',
    execFileAsync: mockExecFileAsync,
    getResourcesDir: () => 'C:\\Users\\Tester\\GSM\\GameSentenceMiner',
    getSanitizedPythonEnv: () => ({}),
    isDev: false,
    PACKAGE_NAME: 'GameSentenceMiner',
    resolvePreReleaseMetadata: mockResolvePreReleaseMetadata,
}));

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

describe('prerelease backend installation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('uses the fork commit recorded by the packaged app', async () => {
        const commit = '9c458553c662f7680faad08478655d06dd9e2e69';
        mockResolvePreReleaseMetadata.mockReturnValue({
            branch: 'feat/hoshidicts-v1',
            repository: 'bee-san/GameSentenceMiner',
            commit,
        });

        const { getBundledBackendSpecifier } = await import('./python_ops.js');

        expect(getBundledBackendSpecifier()).toBe(
            `https://github.com/bee-san/GameSentenceMiner/archive/${commit}.zip`
        );
    });

    it('reads the PEP 610 source URL for an installed backend', async () => {
        const sourceUrl =
            'https://github.com/bee-san/GameSentenceMiner/archive/9c458553c662f7680faad08478655d06dd9e2e69.zip';
        mockExecFileAsync.mockResolvedValue({
            stdout: `${JSON.stringify({ url: sourceUrl })}\n`,
            stderr: '',
        });

        const { getInstalledPackageDirectUrl } = await import('./python_ops.js');

        await expect(
            getInstalledPackageDirectUrl('python.exe', 'GameSentenceMiner')
        ).resolves.toBe(sourceUrl);
        expect(mockExecFileAsync).toHaveBeenCalledWith(
            'python.exe',
            ['-c', expect.any(String), 'GameSentenceMiner']
        );
        const script = mockExecFileAsync.mock.calls[0][1][1] as string;
        expect(script).toContain('distributions(name=sys.argv[1])');
    });

    it('replaces a stable backend with the packaged prerelease source', async () => {
        const packageSpecifier =
            'https://github.com/bee-san/GameSentenceMiner/archive/9c458553c662f7680faad08478655d06dd9e2e69.zip';
        const { planBundledBackendInstall } = await import('./python_ops.js');

        expect(
            planBundledBackendInstall({
                installedVersion: '2026.7.4',
                bundledVersion: '1.16.6-beta.2',
                packageSpecifier,
                isPreRelease: true,
                installedDirectUrl: null,
            })
        ).toEqual({
            shouldInstall: true,
            forceReinstall: true,
            reason: 'source-mismatch',
        });
    });

    it('does not redownload an already-matching prerelease backend', async () => {
        const packageSpecifier =
            'https://github.com/bee-san/GameSentenceMiner/archive/9c458553c662f7680faad08478655d06dd9e2e69.zip';
        const { planBundledBackendInstall } = await import('./python_ops.js');

        expect(
            planBundledBackendInstall({
                installedVersion: '2026.7.4',
                bundledVersion: '1.16.6-beta.2',
                packageSpecifier,
                isPreRelease: true,
                installedDirectUrl: packageSpecifier,
            })
        ).toEqual({
            shouldInstall: false,
            forceReinstall: false,
            reason: 'current',
        });
    });

    it('does not force-reinstall a matching local development checkout', async () => {
        const { planBundledBackendInstall } = await import('./python_ops.js');

        expect(
            planBundledBackendInstall({
                installedVersion: '2026.7.4',
                bundledVersion: '2026.7.4',
                packageSpecifier: '/home/tester/GameSentenceMiner',
                isPreRelease: false,
                isDevelopment: true,
                installedDirectUrl: 'file:///home/tester/GameSentenceMiner',
            })
        ).toEqual({
            shouldInstall: true,
            forceReinstall: false,
            reason: 'post-release-check',
        });
    });

    it('replaces a prerelease source install when returning to stable', async () => {
        const { planBundledBackendInstall } = await import('./python_ops.js');

        expect(
            planBundledBackendInstall({
                installedVersion: '2026.7.4',
                bundledVersion: '2026.7.4',
                packageSpecifier:
                    'GameSentenceMiner>=2026.7.4,<2026.7.5',
                isPreRelease: false,
                installedDirectUrl:
                    'https://github.com/bee-san/GameSentenceMiner/archive/9c458553c662f7680faad08478655d06dd9e2e69.zip',
            })
        ).toEqual({
            shouldInstall: true,
            forceReinstall: true,
            reason: 'source-mismatch',
        });
    });
});
