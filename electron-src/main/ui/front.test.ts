import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const spawnMock = vi.fn();
const execFileMock = vi.fn();
const sendStopOverlayMock = vi.fn();
const startInProcessOverlayMock = vi.fn();
const stopInProcessOverlayMock = vi.fn();
const isInProcessOverlayRunningMock = vi.fn();
const waitForInProcessOverlayShutdownMock = vi.fn();
let isDevValue = false;
let useInProcessOverlayValue = false;
const originalPlatform = process.platform;

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
    sendStopOverlay: sendStopOverlayMock,
}));

function createProcessHandle() {
    const listeners: Record<string, ((...args: any[]) => void) | undefined> = {};
    return {
        pid: 1234,
        exitCode: null as number | null,
        kill: vi.fn(),
        once: vi.fn((event: string, callback: (...args: any[]) => void) => {
            listeners[event] = callback;
        }),
        emit(event: string, ...args: any[]) {
            if (event === 'exit') this.exitCode = args[0] ?? 0;
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
        sendStopOverlayMock.mockReset().mockReturnValue(false);
        startInProcessOverlayMock.mockReset();
        stopInProcessOverlayMock.mockReset();
        isInProcessOverlayRunningMock.mockReset();
        waitForInProcessOverlayShutdownMock.mockReset();
        Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true,
        });
    });

    afterEach(() => vi.useRealTimers());

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
            env: expect.objectContaining({ GSM_OVERLAY_LAUNCH_ID: expect.any(String) }),
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
        existsSyncMock.mockReturnValue(true);
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);

        const { runOverlayWithSource, getOverlayRuntimeState } = await loadFrontModule();

        await expect(runOverlayWithSource('manual')).resolves.toBe(true);

        expect(existsSyncMock).toHaveBeenCalledWith('C:\\overlay-out\\resources\\app.asar');
        expect(spawnMock).toHaveBeenCalledWith(process.execPath, [], {
            detached: false,
            stdio: 'ignore',
            env: expect.objectContaining({
                GSM_OVERLAY_CHILD: '1',
                GSM_OVERLAY_SHARED_RUNTIME: '1',
                GSM_OVERLAY_RESOURCES_PATH: 'C:\\overlay-out\\resources',
                GSM_OVERLAY_LAUNCH_ID: expect.any(String),
            }),
        });
        expect(spawnMock.mock.calls[0][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(getOverlayRuntimeState()).toEqual({
            isRunning: true,
            source: 'manual',
        });
    });

    it('falls back to the standalone overlay executable when only the legacy package exists', async () => {
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
            env: expect.objectContaining({ GSM_OVERLAY_LAUNCH_ID: expect.any(String) }),
        });
        expect(getOverlayRuntimeState()).toEqual({
            isRunning: true,
            source: 'manual',
        });
    });

    it('requests a targeted graceful quit and waits for process exit without force-killing', async () => {
        vi.useFakeTimers();
        isDevValue = true;
        existsSyncMock.mockReturnValue(true);
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);
        sendStopOverlayMock.mockReturnValue(true);
        const { runOverlayWithSource, stopOverlay, waitForOverlayShutdown, getOverlayRuntimeState } = await loadFrontModule();
        await runOverlayWithSource('auto-launcher');
        const launchId = spawnMock.mock.calls[0][2].env?.GSM_OVERLAY_LAUNCH_ID;
        expect(launchId).toEqual(expect.any(String));

        expect(stopOverlay({ onlyIfSource: 'startup' })).toBe(false);
        expect(sendStopOverlayMock).not.toHaveBeenCalled();
        expect(stopOverlay({ onlyIfSource: 'auto-launcher' })).toBe(true);
        expect(stopOverlay({ onlyIfSource: 'auto-launcher' })).toBe(true);
        expect(sendStopOverlayMock).toHaveBeenCalledExactlyOnceWith(launchId);
        const finished = vi.fn();
        const waiting = waitForOverlayShutdown().then(finished);
        await vi.advanceTimersByTimeAsync(4999);
        expect(finished).not.toHaveBeenCalled();
        expect(execFileMock).not.toHaveBeenCalled();

        processHandle.emit('exit', 0);
        await waiting;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(execFileMock).not.toHaveBeenCalled();
        expect(processHandle.kill).not.toHaveBeenCalled();
        expect(getOverlayRuntimeState()).toEqual({ isRunning: false, source: null });
    });

    it('falls back to stopping the managed process tree if the overlay does not quit', async () => {
        vi.useFakeTimers();
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        existsSyncMock.mockReturnValue(true);
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);
        sendStopOverlayMock.mockReturnValue(true);
        const { runOverlayWithSource, stopOverlay, waitForOverlayShutdown } = await loadFrontModule();
        await runOverlayWithSource('auto-launcher');

        stopOverlay();
        expect(execFileMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5000);
        expect(execFileMock).toHaveBeenCalledWith(
            'taskkill', ['/PID', '1234', '/T', '/F'], { windowsHide: true }, expect.any(Function)
        );
        processHandle.emit('exit', 1);
        await waitForOverlayShutdown();
    });

    it('waits for a graceful shutdown before starting another overlay with a fresh launch id', async () => {
        vi.useFakeTimers();
        existsSyncMock.mockReturnValue(true);
        const previous = createProcessHandle();
        const next = createProcessHandle();
        spawnMock.mockReturnValueOnce(previous).mockReturnValueOnce(next);
        sendStopOverlayMock.mockReturnValue(true);
        const { runOverlayWithSource, stopOverlay, getOverlayRuntimeState } = await loadFrontModule();
        await runOverlayWithSource('auto-launcher');
        stopOverlay();

        const starting = runOverlayWithSource('manual');
        await vi.advanceTimersByTimeAsync(100);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        previous.emit('exit', 0);
        await expect(starting).resolves.toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(2);
        expect(spawnMock.mock.calls[1][2].env.GSM_OVERLAY_LAUNCH_ID)
            .not.toBe(spawnMock.mock.calls[0][2].env.GSM_OVERLAY_LAUNCH_ID);
        expect(getOverlayRuntimeState()).toEqual({ isRunning: true, source: 'manual' });
    });

    it('reports shutdown failure if the managed process never exits', async () => {
        vi.useFakeTimers();
        existsSyncMock.mockReturnValue(true);
        spawnMock.mockReturnValue(createProcessHandle());
        sendStopOverlayMock.mockReturnValue(true);
        const { runOverlayWithSource, stopOverlay, waitForOverlayShutdown } = await loadFrontModule();
        await runOverlayWithSource('auto-launcher');
        stopOverlay();
        const waiting = expect(waitForOverlayShutdown()).rejects.toThrow('Timed out waiting for overlay shutdown.');
        await vi.advanceTimersByTimeAsync(15_000);
        await waiting;
    });
});
