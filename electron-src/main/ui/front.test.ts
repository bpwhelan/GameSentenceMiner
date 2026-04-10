import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const spawnMock = vi.fn();
let isDevValue = false;

vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn(),
    },
}));

vi.mock('fs', () => ({
    existsSync: existsSyncMock,
}));

vi.mock('child_process', () => ({
    spawn: spawnMock,
}));

vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm',
    getOverlayExecName: () => 'gsm_overlay.exe',
    getOverlayPath: () => 'C:\\overlay-out',
    getResourcesDir: () => 'C:\\repo',
    get isDev() {
        return isDevValue;
    },
}));

vi.mock('../store.js', () => ({
    HookableGameType: {
        None: 'none',
        Steam: 'steam',
        Yuzu: 'yuzu',
    },
    getFrontPageState: vi.fn(),
    getSteamGames: vi.fn(() => []),
    getVNs: vi.fn(() => []),
    getYuzuRomsPath: vi.fn(),
    setFrontPageState: vi.fn(),
}));

vi.mock('./yuzu.js', () => ({
    getConfiguredYuzuGames: vi.fn(() => []),
    getYuzuGames: vi.fn(() => []),
}));

vi.mock('./obs.js', () => ({
    getOBSConnection: vi.fn(),
    getOBSScenes: vi.fn(() => []),
}));

vi.mock('./ocr.js', () => ({
    getSceneOCRConfig: vi.fn(),
}));

vi.mock('../main.js', () => ({
    sendOpenTexthooker: vi.fn(),
}));

function createProcessHandle() {
    const listeners: Record<string, ((...args: any[]) => void) | undefined> = {};
    return {
        exitCode: null,
        kill: vi.fn(),
        once: vi.fn((event: string, callback: (...args: any[]) => void) => {
            listeners[event] = callback;
        }),
        emit(event: string, ...args: any[]) {
            listeners[event]?.(...args);
        },
    };
}

async function loadFrontModule() {
    vi.resetModules();
    return import('./front.js');
}

describe('runOverlayWithSource', () => {
    beforeEach(() => {
        isDevValue = false;
        existsSyncMock.mockReset();
        spawnMock.mockReset();
    });

    it('runs npm start in GSM_Overlay when launched from source', async () => {
        isDevValue = true;
        existsSyncMock.mockReturnValue(true);
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);

        const { runOverlayWithSource, getOverlayRuntimeState } = await loadFrontModule();

        await expect(runOverlayWithSource('startup')).resolves.toBe(true);

        expect(existsSyncMock).toHaveBeenCalledWith('C:\\repo\\GSM_Overlay\\package.json');
        expect(spawnMock).toHaveBeenCalledWith('cmd.exe', ['/d', '/s', '/c', 'npm run start'], {
            cwd: 'C:\\repo\\GSM_Overlay',
            detached: false,
            stdio: 'ignore',
        });
        expect(getOverlayRuntimeState()).toEqual({
            isRunning: true,
            source: 'startup',
        });
    });

    it('runs the packaged overlay executable outside source mode', async () => {
        existsSyncMock.mockReturnValue(true);
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);

        const { runOverlayWithSource, getOverlayRuntimeState } = await loadFrontModule();

        await expect(runOverlayWithSource('manual')).resolves.toBe(true);

        expect(existsSyncMock).toHaveBeenCalledWith('C:\\overlay-out\\gsm_overlay.exe');
        expect(spawnMock).toHaveBeenCalledWith('C:\\overlay-out\\gsm_overlay.exe', [], {
            detached: false,
            stdio: 'ignore',
        });
        expect(getOverlayRuntimeState()).toEqual({
            isRunning: true,
            source: 'manual',
        });
    });
});
