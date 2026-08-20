import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const spawnMock = vi.fn();
const execFileMock = vi.fn();
const startInProcessOverlayMock = vi.fn();
const stopInProcessOverlayMock = vi.fn();
const isInProcessOverlayRunningMock = vi.fn();
const waitForInProcessOverlayShutdownMock = vi.fn();
let isDevValue = false;
let useInProcessOverlayValue = false;
const originalPlatform = process.platform;
const ozoneEnvironmentKeys = [
    'XDG_SESSION_TYPE',
    'XDG_CURRENT_DESKTOP',
    'GSM_OVERLAY_XWAYLAND_FEATURES',
    'ELECTRON_OZONE_PLATFORM_HINT',
] as const;
const originalOzoneEnvironment = Object.fromEntries(
    ozoneEnvironmentKeys.map((key) => [key, process.env[key]])
);

vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn(),
    },
}));

vi.mock('fs', () => ({
    existsSync: existsSyncMock,
}));

vi.mock('child_process', () => ({
    execFile: execFileMock,
    spawn: spawnMock,
}));

vi.mock('../overlay_runtime_config.js', () => ({
    get USE_IN_PROCESS_OVERLAY() {
        return useInProcessOverlayValue;
    },
}));

vi.mock('../overlay_runtime.js', () => ({
    startInProcessOverlay: startInProcessOverlayMock,
    stopInProcessOverlay: stopInProcessOverlayMock,
    isInProcessOverlayRunning: isInProcessOverlayRunningMock,
    waitForInProcessOverlayShutdown: waitForInProcessOverlayShutdownMock,
}));

vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm',
    getOverlayAppAsarPath: () => 'C:\\overlay-out\\resources\\app.asar',
    getOverlayExecName: () => 'gsm_overlay.exe',
    getOverlayPath: () => 'C:\\overlay-out',
    getOverlayResourcesPath: () => 'C:\\overlay-out\\resources',
    getResourcesDir: () => 'C:\\repo',
    OVERLAY_RESOURCES_ENV: 'GSM_OVERLAY_RESOURCES_PATH',
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
        pid: 1234,
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
        useInProcessOverlayValue = false;
        existsSyncMock.mockReset();
        spawnMock.mockReset();
        execFileMock.mockReset();
        startInProcessOverlayMock.mockReset();
        stopInProcessOverlayMock.mockReset();
        isInProcessOverlayRunningMock.mockReset();
        waitForInProcessOverlayShutdownMock.mockReset();
        Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true,
        });
    });

    afterEach(() => {
        for (const key of ozoneEnvironmentKeys) {
            const value = originalOzoneEnvironment[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('selects supervised X11 launch arguments only for GNOME Wayland by default', async () => {
        const { resolveOverlayOzoneArgs } = await loadFrontModule();

        expect(resolveOverlayOzoneArgs({
            platform: 'linux',
            env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' },
            argv: ['gsm'],
        })).toEqual(['--ozone-platform=x11']);
        expect(resolveOverlayOzoneArgs({
            platform: 'linux',
            env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' },
            argv: ['gsm'],
        })).toEqual([]);
        expect(resolveOverlayOzoneArgs({
            platform: 'darwin',
            env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' },
            argv: ['gsm'],
        })).toEqual([]);
    });

    it('respects explicit backend preferences and compositor opt-in', async () => {
        const { resolveOverlayOzoneArgs } = await loadFrontModule();

        expect(resolveOverlayOzoneArgs({
            platform: 'linux',
            env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' },
            argv: ['gsm', '--ozone-platform=wayland'],
        })).toEqual([]);
        expect(resolveOverlayOzoneArgs({
            platform: 'linux',
            env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' },
            argv: ['gsm', '--ozone-platform=x11'],
        })).toEqual(['--ozone-platform=x11']);
        expect(resolveOverlayOzoneArgs({
            platform: 'linux',
            env: {
                XDG_SESSION_TYPE: 'wayland',
                XDG_CURRENT_DESKTOP: 'COSMIC',
                GSM_OVERLAY_XWAYLAND_FEATURES: '1',
            },
            argv: ['gsm'],
        })).toEqual(['--ozone-platform=x11']);
    });

    it('runs npm start in GSM_Overlay when launched from source', async () => {
        Object.defineProperty(process, 'platform', {
            value: 'win32',
            configurable: true,
        });
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

    it('loads and unloads the overlay in the main Electron process when enabled', async () => {
        useInProcessOverlayValue = true;
        isInProcessOverlayRunningMock.mockReturnValue(false);
        startInProcessOverlayMock.mockImplementation(async () => {
            isInProcessOverlayRunningMock.mockReturnValue(true);
            return true;
        });
        stopInProcessOverlayMock.mockReturnValue(true);

        const { runOverlayWithSource, getOverlayRuntimeState, stopOverlay, waitForOverlayShutdown } = await loadFrontModule();

        await expect(runOverlayWithSource('startup')).resolves.toBe(true);

        expect(startInProcessOverlayMock).toHaveBeenCalledTimes(1);
        expect(spawnMock).not.toHaveBeenCalled();
        expect(getOverlayRuntimeState()).toEqual({
            isRunning: true,
            source: 'startup',
        });

        expect(stopOverlay({ onlyIfSource: 'manual' })).toBe(false);
        expect(stopInProcessOverlayMock).not.toHaveBeenCalled();
        expect(stopOverlay({ onlyIfSource: 'startup' })).toBe(true);
        expect(stopInProcessOverlayMock).toHaveBeenCalledTimes(1);
        await waitForOverlayShutdown();
        expect(waitForInProcessOverlayShutdownMock).toHaveBeenCalledTimes(1);
    });

    it('stops the whole Windows process tree for source-launched overlays', async () => {
        Object.defineProperty(process, 'platform', {
            value: 'win32',
            configurable: true,
        });
        isDevValue = true;
        existsSyncMock.mockReturnValue(true);
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);
        execFileMock.mockImplementation((_command, _args, _options, callback) => callback(null));

        const { runOverlayWithSource, stopOverlay } = await loadFrontModule();

        await expect(runOverlayWithSource('manual')).resolves.toBe(true);

        expect(stopOverlay()).toBe(true);
        expect(execFileMock).toHaveBeenCalledWith(
            'taskkill',
            ['/PID', '1234', '/T', '/F'],
            { windowsHide: true },
            expect.any(Function)
        );
        expect(processHandle.kill).not.toHaveBeenCalled();
    });

    it('runs the packaged overlay app through the shared Electron runtime outside source mode', async () => {
        Object.defineProperty(process, 'platform', {
            value: 'linux',
            configurable: true,
        });
        process.env.XDG_SESSION_TYPE = 'wayland';
        process.env.XDG_CURRENT_DESKTOP = 'GNOME';
        delete process.env.GSM_OVERLAY_XWAYLAND_FEATURES;
        delete process.env.ELECTRON_OZONE_PLATFORM_HINT;
        existsSyncMock.mockReturnValue(true);
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);

        const { runOverlayWithSource, getOverlayRuntimeState } = await loadFrontModule();

        await expect(runOverlayWithSource('manual')).resolves.toBe(true);

        expect(existsSyncMock).toHaveBeenCalledWith('C:\\overlay-out\\resources\\app.asar');
        expect(spawnMock).toHaveBeenCalledWith(process.execPath, ['--ozone-platform=x11'], {
            detached: false,
            stdio: 'ignore',
            env: expect.objectContaining({
                GSM_OVERLAY_CHILD: '1',
                GSM_OVERLAY_SHARED_RUNTIME: '1',
                GSM_OVERLAY_RESOURCES_PATH: 'C:\\overlay-out\\resources',
            }),
        });
        expect(spawnMock.mock.calls[0][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(getOverlayRuntimeState()).toEqual({
            isRunning: true,
            source: 'manual',
        });
    });

    it('falls back to the standalone overlay executable when only the legacy package exists', async () => {
        Object.defineProperty(process, 'platform', {
            value: 'win32',
            configurable: true,
        });
        existsSyncMock.mockImplementation((candidate: string) => candidate === 'C:\\overlay-out\\gsm_overlay.exe');
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);

        const { runOverlayWithSource, getOverlayRuntimeState } = await loadFrontModule();

        await expect(runOverlayWithSource('manual')).resolves.toBe(true);

        expect(existsSyncMock).toHaveBeenCalledWith('C:\\overlay-out\\resources\\app.asar');
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
