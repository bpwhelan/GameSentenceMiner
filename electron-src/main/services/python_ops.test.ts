import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileAsync = vi.fn();

vi.mock('../util.js', () => ({
    execFileAsync: mockExecFileAsync,
    getResourcesDir: () => 'C:\\Users\\Tester\\GSM\\GameSentenceMiner',
    getSanitizedPythonEnv: () => ({}),
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
