import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileAsync = vi.fn();
const mockExtractZip = vi.fn();
const mockTarExtract = vi.fn();
const mockShowMessageBox = vi.fn(async () => ({ response: 0 }));
const mockOpenExternal = vi.fn();
const mockNotificationSend = vi.fn();
const mockFetch = vi.fn();

const BASE_DIR = 'C:\\Users\\Tester\\AppData\\Roaming\\GameSentenceMiner';
const UV_DIR = path.join(BASE_DIR, 'uv');
const VENV_DIR = path.join(BASE_DIR, 'python_venv');
const UV_PATH = path.join(UV_DIR, 'uv.exe');
const PYTHON_PATH = path.join(VENV_DIR, 'Scripts', 'python.exe');
const EXTRACTED_DIR = path.join(UV_DIR, 'uv-x86_64-pc-windows-msvc');
const EXTRACTED_UV_PATH = path.join(EXTRACTED_DIR, 'uv.exe');

const existingPaths = new Set<string>();
const removePathFromSet = (targetPath: string) => {
    for (const entry of Array.from(existingPaths)) {
        if (entry === targetPath || entry.startsWith(`${targetPath}\\`) || entry.startsWith(`${targetPath}/`)) {
            existingPaths.delete(entry);
        }
    }
};

const fsMock = {
    existsSync: vi.fn((targetPath: string) => existingPaths.has(targetPath)),
    mkdirSync: vi.fn(),
    renameSync: vi.fn((sourcePath: string, destPath: string) => {
        existingPaths.delete(sourcePath);
        existingPaths.add(destPath);
    }),
    rmSync: vi.fn((targetPath: string) => removePathFromSet(targetPath)),
    writeFileSync: vi.fn((targetPath: string) => {
        existingPaths.add(targetPath);
    }),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn((targetPath: string) => {
        existingPaths.delete(targetPath);
    }),
    readdirSync: vi.fn(() => [] as string[]),
};

vi.mock('fs', () => fsMock);
vi.mock('extract-zip', () => ({
    default: async (...args: unknown[]) => mockExtractZip(...args),
}));
vi.mock('tar', () => ({
    x: async (...args: unknown[]) => mockTarExtract(...args),
}));
vi.mock('../util.js', () => ({
    BASE_DIR,
    execFileAsync: mockExecFileAsync,
    getPlatform: () => 'win32',
    isWindows: () => true,
    isMacOS: () => false,
}));
vi.mock('../main.js', () => ({
    mainWindow: {
        webContents: {
            send: mockNotificationSend,
        },
    },
}));
vi.mock('electron', () => ({
    dialog: {
        showMessageBox: mockShowMessageBox,
    },
    shell: {
        openExternal: mockOpenExternal,
    },
}));

describe('getOrInstallPython', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
        existingPaths.clear();
        let shouldFailUvValidation = true;

        vi.stubGlobal('fetch', mockFetch);

        fsMock.rmSync.mockImplementation((targetPath: string) => removePathFromSet(targetPath));

        existingPaths.add(UV_DIR);
        existingPaths.add(UV_PATH);

        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            arrayBuffer: async () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer,
        });

        mockExtractZip.mockImplementation(async () => {
            existingPaths.add(EXTRACTED_DIR);
            existingPaths.add(EXTRACTED_UV_PATH);
        });

        mockTarExtract.mockResolvedValue(undefined);

        mockExecFileAsync.mockImplementation(async (command: string, args: string[]) => {
            if (command === UV_PATH && args[0] === '--version' && shouldFailUvValidation) {
                shouldFailUvValidation = false;
                throw Object.assign(new Error(`spawn ${UV_PATH} EFTYPE`), { code: 'EFTYPE' });
            }

            if (command === UV_PATH && args[0] === '--version') {
                return { stdout: 'uv 0.9.22', stderr: '' };
            }

            if (command === UV_PATH && args[0] === 'python' && args[1] === 'install') {
                return { stdout: '', stderr: '' };
            }

            if (command === UV_PATH && args[0] === 'venv') {
                existingPaths.add(VENV_DIR);
                existingPaths.add(path.dirname(PYTHON_PATH));
                existingPaths.add(PYTHON_PATH);
                return { stdout: '', stderr: '' };
            }

            if (command === PYTHON_PATH && args[0] === '--version') {
                return { stdout: 'Python 3.13.2', stderr: '' };
            }

            if (command === PYTHON_PATH && args[0] === '-m' && args[1] === 'ensurepip') {
                return { stdout: '', stderr: '' };
            }

            throw new Error(`Unexpected execFileAsync call: ${command} ${args.join(' ')}`);
        });
    });

    it('reinstalls a cached uv binary when it is present but not runnable', async () => {
        const { getOrInstallPython } = await import('./python_downloader.js');

        const pythonPath = await getOrInstallPython();

        expect(pythonPath).toBe(PYTHON_PATH);
        expect(fsMock.rmSync).toHaveBeenCalledWith(UV_DIR, { recursive: true, force: true });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockExecFileAsync).toHaveBeenCalledWith(UV_PATH, ['python', 'install', '3.13.2']);
        expect(mockExecFileAsync).toHaveBeenCalledWith(UV_PATH, ['venv', '--python', '3.13.2', '--seed', VENV_DIR]);
    });

    it('shares a single install operation across concurrent callers', async () => {
        let resolveVenvCreation: (() => void) | null = null;

        mockExecFileAsync.mockImplementation(async (command: string, args: string[]) => {
            if (command === UV_PATH && args[0] === '--version') {
                return { stdout: 'uv 0.9.22', stderr: '' };
            }

            if (command === UV_PATH && args[0] === 'python' && args[1] === 'install') {
                return { stdout: '', stderr: '' };
            }

            if (command === UV_PATH && args[0] === 'venv') {
                return await new Promise((resolve) => {
                    resolveVenvCreation = () => {
                        existingPaths.add(VENV_DIR);
                        existingPaths.add(path.dirname(PYTHON_PATH));
                        existingPaths.add(PYTHON_PATH);
                        resolve({ stdout: '', stderr: '' });
                    };
                });
            }

            if (command === PYTHON_PATH && args[0] === '--version') {
                return { stdout: 'Python 3.13.2', stderr: '' };
            }

            if (command === PYTHON_PATH && args[0] === '-m' && args[1] === 'ensurepip') {
                return { stdout: '', stderr: '' };
            }

            throw new Error(`Unexpected execFileAsync call: ${command} ${args.join(' ')}`);
        });

        const { getOrInstallPython } = await import('./python_downloader.js');

        const firstCall = getOrInstallPython();
        const secondCall = getOrInstallPython();

        await vi.waitFor(() => {
            expect(
                mockExecFileAsync.mock.calls.filter(
                    (call) => call[0] === UV_PATH && Array.isArray(call[1]) && call[1][0] === 'venv'
                ).length
            ).toBe(1);
        });
        expect(mockShowMessageBox).toHaveBeenCalledTimes(1);

        resolveVenvCreation?.();

        await expect(firstCall).resolves.toBe(PYTHON_PATH);
        await expect(secondCall).resolves.toBe(PYTHON_PATH);
    });

    it('retries venv creation after a transient Windows file-lock failure', async () => {
        vi.useFakeTimers();

        let venvAttemptCount = 0;
        mockExecFileAsync.mockImplementation(async (command: string, args: string[]) => {
            if (command === UV_PATH && args[0] === '--version') {
                return { stdout: 'uv 0.9.22', stderr: '' };
            }

            if (command === UV_PATH && args[0] === 'python' && args[1] === 'install') {
                return { stdout: '', stderr: '' };
            }

            if (command === UV_PATH && args[0] === 'venv') {
                venvAttemptCount += 1;
                if (venvAttemptCount === 1) {
                    existingPaths.add(VENV_DIR);
                    existingPaths.add(path.dirname(PYTHON_PATH));
                    existingPaths.add(PYTHON_PATH);
                    throw Object.assign(
                        new Error(
                            `failed to copy file from venvlauncher.exe to ${PYTHON_PATH}: The process cannot access the file because it is being used by another process. (os error 32)`
                        ),
                        { code: 'EPERM' }
                    );
                }

                existingPaths.add(VENV_DIR);
                existingPaths.add(path.dirname(PYTHON_PATH));
                existingPaths.add(PYTHON_PATH);
                return { stdout: '', stderr: '' };
            }

            if (command === PYTHON_PATH && args[0] === '--version') {
                if (venvAttemptCount === 0) {
                    throw Object.assign(new Error(`spawn ${PYTHON_PATH} ENOENT`), { code: 'ENOENT' });
                }
                if (venvAttemptCount === 1 && existingPaths.has(PYTHON_PATH)) {
                    throw Object.assign(new Error(`spawn ${PYTHON_PATH} EBUSY`), { code: 'EBUSY' });
                }
                return { stdout: 'Python 3.13.2', stderr: '' };
            }

            if (command === PYTHON_PATH && args[0] === '-m' && args[1] === 'ensurepip') {
                return { stdout: '', stderr: '' };
            }

            throw new Error(`Unexpected execFileAsync call: ${command} ${args.join(' ')}`);
        });

        const { getOrInstallPython } = await import('./python_downloader.js');

        const installPromise = getOrInstallPython();
        await vi.runAllTimersAsync();

        await expect(installPromise).resolves.toBe(PYTHON_PATH);
        expect(venvAttemptCount).toBe(2);
        expect(
            fsMock.rmSync.mock.calls.filter((call) => call[0] === VENV_DIR && call[1]?.recursive && call[1]?.force)
                .length
        ).toBeGreaterThanOrEqual(1);
    });

    it('retries Python venv removal when Windows briefly locks a managed executable', async () => {
        existingPaths.add(VENV_DIR);
        existingPaths.add(path.dirname(PYTHON_PATH));
        existingPaths.add(PYTHON_PATH);

        let firstVenvRemovalAttempt = true;
        fsMock.rmSync.mockImplementation((targetPath: string, options?: { recursive?: boolean; force?: boolean }) => {
            if (targetPath === VENV_DIR && firstVenvRemovalAttempt) {
                firstVenvRemovalAttempt = false;
                const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
                throw error;
            }
            removePathFromSet(targetPath);
        });

        const { reinstallPython } = await import('./python_downloader.js');

        await reinstallPython();

        expect(
            fsMock.rmSync.mock.calls.filter((call) => call[0] === VENV_DIR && call[1]?.recursive && call[1]?.force)
                .length
        ).toBeGreaterThanOrEqual(2);
        expect(existingPaths.has(VENV_DIR)).toBe(true);
        expect(existingPaths.has(PYTHON_PATH)).toBe(true);
    });
});
