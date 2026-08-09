import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const spawnMock = vi.fn();
const execFileMock = vi.fn();
const startInProcessOverlayMock = vi.fn();
const stopInProcessOverlayMock = vi.fn();
const isInProcessOverlayRunningMock = vi.fn();
const waitForInProcessOverlayShutdownMock = vi.fn();
let isDevValue = false;
let useInProcessOverlayValue = false;
let hoshidictsEnabledValue = false;
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
}));

vi.mock('../features/hoshidicts/control_channel.js', () => ({
    getHoshidictsControlPort: () => 4567,
    HOSHIDICTS_CONTROL_ENV: 'GSM_HOSHIDICTS_CONTROL_PORT',
}));

vi.mock('../gsm_config.js', () => ({
    getConfiguredHoshidictsEnabled: () => hoshidictsEnabledValue,
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
        hoshidictsEnabledValue = false;
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

    it('strips inherited desktop-control state from overlay environments', async () => {
        const { buildOverlayProcessEnvironment } = await loadFrontModule();

        expect(
            buildOverlayProcessEnvironment({
                PATH: 'safe-path',
                GSM_BROKER_PORT: '1234',
                GSM_BROKER_SESSION: 'not-for-the-overlay',
                GSM_CLIENT_ID: 'desktop',
                GSM_HOSHIDICTS_CONTROL_PORT: 'stale-port',
            })
        ).toEqual({ PATH: 'safe-path' });
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
            env: expect.objectContaining({
                GSM_HOSHIDICTS_CONTROL_PORT: '4567',
                GSM_HOSHIDICTS_ENABLED: '0',
                GSM_HOSHIDICTS_LOOKUP_MODE: 'shift',
                GSM_HOSHIDICTS_ACTIVATION_KEY: 'Shift',
                GSM_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED: '0',
                GSM_HOSHIDICTS_SHOW_LOOKUP_COUNTS: '1',
                GSM_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH: '10',
                GSM_HOSHIDICTS_POPUP_WIDTH_PX: '560',
                GSM_HOSHIDICTS_POPUP_HEIGHT_PX: '420',
                GSM_HOSHIDICTS_THEME: 'default',
                GSM_HOSHIDICTS_POPUP_OPACITY_PERCENT: '85',
                GSM_HOSHIDICTS_DEFINITION_BLUR_ENABLED: '0',
                GSM_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD: '5',
                GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_MODE: 'timed',
                GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS: '5000',
            }),
        });
        expect(getOverlayRuntimeState()).toEqual({
            isRunning: true,
            source: 'startup',
        });
    });

    it('loads and unloads the overlay in the main Electron process when enabled', async () => {
        useInProcessOverlayValue = true;
        hoshidictsEnabledValue = true;
        isInProcessOverlayRunningMock.mockReturnValue(false);
        startInProcessOverlayMock.mockImplementation(async () => {
            isInProcessOverlayRunningMock.mockReturnValue(true);
            return true;
        });
        stopInProcessOverlayMock.mockReturnValue(true);

        const { runOverlayWithSource, getOverlayRuntimeState, stopOverlay, waitForOverlayShutdown } = await loadFrontModule();

        await expect(runOverlayWithSource('startup')).resolves.toBe(true);

        expect(startInProcessOverlayMock).toHaveBeenCalledTimes(1);
        expect(process.env.GSM_HOSHIDICTS_ENABLED).toBe('1');
        expect(process.env.GSM_HOSHIDICTS_LOOKUP_MODE).toBe('shift');
        expect(process.env.GSM_HOSHIDICTS_ACTIVATION_KEY).toBe('Shift');
        expect(process.env.GSM_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED).toBe('0');
        expect(process.env.GSM_HOSHIDICTS_SHOW_LOOKUP_COUNTS).toBe('1');
        expect(process.env.GSM_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH).toBe('10');
        expect(process.env.GSM_HOSHIDICTS_POPUP_WIDTH_PX).toBe('560');
        expect(process.env.GSM_HOSHIDICTS_POPUP_HEIGHT_PX).toBe('420');
        expect(process.env.GSM_HOSHIDICTS_THEME).toBe('default');
        expect(process.env.GSM_HOSHIDICTS_POPUP_OPACITY_PERCENT).toBe('85');
        expect(process.env.GSM_HOSHIDICTS_DEFINITION_BLUR_ENABLED).toBe('0');
        expect(process.env.GSM_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD).toBe('5');
        expect(process.env.GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_MODE).toBe('timed');
        expect(process.env.GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS).toBe('5000');
        expect(process.env.GSM_HOSHIDICTS_CONTROL_PORT).toBe('4567');
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

    it('launches with and records configured Hoshidicts reader preferences', async () => {
        isDevValue = true;
        hoshidictsEnabledValue = true;
        existsSyncMock.mockReturnValue(true);
        const processHandle = createProcessHandle();
        spawnMock.mockReturnValue(processHandle);

        const front = await loadFrontModule();
        const syncCustomDictionary = vi.fn(async () => undefined);
        front.configureHoshidictsLookupModeProvider(async () => 'hover');
        front.configureHoshidictsActivationKeyProvider(async () => 'F8');
        front.configureHoshidictsSourceHighlightProvider(async () => true);
        front.configureHoshidictsPopupHideDelayProvider(async () => 850);
        front.configureHoshidictsShowLookupCountsProvider(async () => false);
        front.configureHoshidictsCustomDictionarySyncProvider(
            syncCustomDictionary
        );
        front.configureHoshidictsPopupNestingMaxDepthProvider(async () => 4);
        front.configureHoshidictsDefinitionBlurProvider(async () => ({
            enabled: true,
            lookupThreshold: 8,
            revealMode: 'hover',
            revealDelayMs: 7000,
        }));
        front.configureHoshidictsPopupWidthProvider(async () => 720);
        front.configureHoshidictsPopupHeightProvider(async () => 520);
        front.configureHoshidictsThemeProvider(async () => 'cyberpunk');
        front.configureHoshidictsPopupOpacityPercentProvider(async () => 70);

        await expect(front.runOverlayWithSource('manual')).resolves.toBe(true);

        expect(spawnMock.mock.calls[0][2].env).toMatchObject({
            GSM_HOSHIDICTS_ENABLED: '1',
            GSM_HOSHIDICTS_LOOKUP_MODE: 'hover',
            GSM_HOSHIDICTS_ACTIVATION_KEY: 'F8',
            GSM_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED: '1',
            GSM_HOSHIDICTS_POPUP_HIDE_DELAY_MS: '850',
            GSM_HOSHIDICTS_SHOW_LOOKUP_COUNTS: '0',
            GSM_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH: '4',
            GSM_HOSHIDICTS_POPUP_WIDTH_PX: '720',
            GSM_HOSHIDICTS_POPUP_HEIGHT_PX: '520',
            GSM_HOSHIDICTS_THEME: 'cyberpunk',
            GSM_HOSHIDICTS_POPUP_OPACITY_PERCENT: '70',
            GSM_HOSHIDICTS_DEFINITION_BLUR_ENABLED: '1',
            GSM_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD: '8',
            GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_MODE: 'hover',
            GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS: '7000',
        });
        expect(front.getOverlayHoshidictsLookupModeAtLaunch()).toBe('hover');
        expect(front.getOverlayHoshidictsActivationKeyAtLaunch()).toBe('F8');
        expect(front.getOverlayHoshidictsSourceHighlightEnabledAtLaunch()).toBe(true);
        expect(front.getOverlayHoshidictsPopupHideDelayAtLaunch()).toBe(850);
        expect(front.getOverlayHoshidictsShowLookupCountsAtLaunch()).toBe(false);
        expect(front.getOverlayHoshidictsPopupNestingMaxDepthAtLaunch()).toBe(4);
        expect(front.getOverlayHoshidictsPopupWidthAtLaunch()).toBe(720);
        expect(front.getOverlayHoshidictsPopupHeightAtLaunch()).toBe(520);
        expect(front.getOverlayHoshidictsThemeAtLaunch()).toBe('cyberpunk');
        expect(front.getOverlayHoshidictsPopupOpacityPercentAtLaunch()).toBe(70);
        expect(front.getOverlayHoshidictsDefinitionBlurAtLaunch()).toEqual({
            enabled: true,
            lookupThreshold: 8,
            revealMode: 'hover',
            revealDelayMs: 7000,
        });
        expect(syncCustomDictionary).toHaveBeenCalledOnce();
        expect(
            front.getOverlayHoshidictsAudioProfileRestartRequired()
        ).toBe(false);
        expect(front.markOverlayHoshidictsAudioProfileSyncFailed()).toBe(true);
        expect(
            front.getOverlayHoshidictsAudioProfileRestartRequired()
        ).toBe(true);
        expect(
            front.markOverlayHoshidictsAudioProfileApplied({
                version: 1,
                enabled: true,
                autoPlay: false,
                volume: 100,
                sources: [],
            })
        ).toBe(true);
        expect(
            front.getOverlayHoshidictsAudioProfileRestartRequired()
        ).toBe(false);
        expect(
            front.markOverlayHoshidictsReaderPreferencesApplied({
                lookupMode: 'shift',
                activationKey: 'Space',
                sourceHighlightEnabled: false,
                onlyScanJapaneseText: true,
                popupHideDelayMs: 1200,
                showLookupCounts: true,
                popupNestingMaxDepth: 0,
                definitionBlur: {
                    enabled: false,
                    lookupThreshold: 10,
                    revealMode: 'timed',
                    revealDelayMs: 9000,
                },
                popupWidthPx: 680,
                popupHeightPx: 480,
                theme: 'autumn',
                popupOpacityPercent: 65,
            })
        ).toBe(true);
        expect(front.getOverlayHoshidictsLookupModeAtLaunch()).toBe('shift');
        expect(front.getOverlayHoshidictsActivationKeyAtLaunch()).toBe('Space');
        expect(front.getOverlayHoshidictsSourceHighlightEnabledAtLaunch()).toBe(false);
        expect(front.getOverlayHoshidictsPopupHideDelayAtLaunch()).toBe(1200);
        expect(front.getOverlayHoshidictsShowLookupCountsAtLaunch()).toBe(true);
        expect(front.getOverlayHoshidictsPopupNestingMaxDepthAtLaunch()).toBe(0);
        expect(front.getOverlayHoshidictsPopupWidthAtLaunch()).toBe(680);
        expect(front.getOverlayHoshidictsPopupHeightAtLaunch()).toBe(480);
        expect(front.getOverlayHoshidictsThemeAtLaunch()).toBe('autumn');
        expect(front.getOverlayHoshidictsPopupOpacityPercentAtLaunch()).toBe(65);
        expect(front.getOverlayHoshidictsDefinitionBlurAtLaunch()).toEqual({
            enabled: false,
            lookupThreshold: 10,
            revealMode: 'timed',
            revealDelayMs: 9000,
        });
    });

    it('falls back to safe definition blur launch defaults for invalid providers', async () => {
        isDevValue = true;
        hoshidictsEnabledValue = true;
        existsSyncMock.mockReturnValue(true);
        spawnMock.mockReturnValue(createProcessHandle());

        const front = await loadFrontModule();
        front.configureHoshidictsDefinitionBlurProvider(async () => ({
            enabled: true,
            lookupThreshold: 0,
            revealMode: 'hover',
            revealDelayMs: 999,
        }));

        await expect(front.runOverlayWithSource('manual')).resolves.toBe(true);

        expect(spawnMock.mock.calls[0][2].env).toMatchObject({
            GSM_HOSHIDICTS_DEFINITION_BLUR_ENABLED: '0',
            GSM_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD: '5',
            GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_MODE: 'timed',
            GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS: '5000',
        });
    });

    it('does not wait for custom dictionary synchronization before launching', async () => {
        isDevValue = true;
        hoshidictsEnabledValue = true;
        existsSyncMock.mockReturnValue(true);
        spawnMock.mockReturnValue(createProcessHandle());
        let finishSync!: () => void;
        const syncCustomDictionary = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishSync = resolve;
                })
        );
        const front = await loadFrontModule();
        front.configureHoshidictsCustomDictionarySyncProvider(
            syncCustomDictionary
        );

        const launch = front.runOverlayWithSource('manual');

        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(syncCustomDictionary).toHaveBeenCalledOnce();
            expect(spawnMock).toHaveBeenCalledOnce();
            await expect(launch).resolves.toBe(true);
        } finally {
            finishSync();
        }
    });

    it('uses the last compiled custom dictionary if pre-launch synchronization fails', async () => {
        isDevValue = true;
        hoshidictsEnabledValue = true;
        existsSyncMock.mockReturnValue(true);
        spawnMock.mockReturnValue(createProcessHandle());
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const front = await loadFrontModule();
        front.configureHoshidictsCustomDictionarySyncProvider(async () => {
            throw new Error('custom refresh failed');
        });

        await expect(front.runOverlayWithSource('manual')).resolves.toBe(true);

        expect(spawnMock).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('last active version'),
            expect.any(Error)
        );
        warn.mockRestore();
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
                GSM_HOSHIDICTS_CONTROL_PORT: '4567',
                GSM_OVERLAY_CHILD: '1',
                GSM_OVERLAY_SHARED_RUNTIME: '1',
                GSM_OVERLAY_RESOURCES_PATH: 'C:\\overlay-out\\resources',
                GSM_HOSHIDICTS_ENABLED: '0',
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
            env: expect.objectContaining({
                GSM_HOSHIDICTS_CONTROL_PORT: '4567',
                GSM_HOSHIDICTS_ENABLED: '0',
            }),
        });
        expect(getOverlayRuntimeState()).toEqual({
            isRunning: true,
            source: 'manual',
        });
    });
});
