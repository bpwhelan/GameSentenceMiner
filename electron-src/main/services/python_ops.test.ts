import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileAsync = vi.fn();

vi.mock('../util.js', () => ({
    execFileAsync: mockExecFileAsync,
    getResourcesDir: () => 'C:\\Users\\Tester\\GSM\\GameSentenceMiner',
    getSanitizedPythonEnv: () => ({}),
}));

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
