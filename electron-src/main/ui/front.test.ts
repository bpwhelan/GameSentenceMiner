import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultHoshidictsReaderPreferences } from '../../shared/features/hoshidicts.js';
import { makeHoshidictsReaderPreferences } from '../features/hoshidicts/test_helpers.js';

/** Mirrors buildHoshidictsOverlayEnvironment: everything but customPopupCss. */
function hoshidictsEnvironmentFor(
    preferences: Record<string, unknown>
): { GSM_HOSHIDICTS_READER_PREFERENCES: string } {
    const { customPopupCss: _customPopupCss, ...carried } = preferences;
    return { GSM_HOSHIDICTS_READER_PREFERENCES: JSON.stringify(carried) };
}

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

/**
 * Must be called after loadFrontModule so the test shares the runtime-state
 * instance front.js configured with its overlay-liveness provider.
 */
async function loadHoshidictsRuntime() {
    return import('../features/hoshidicts/runtime_state.js');
}

/** The launch environment produced by the default reader preferences. */
const DEFAULT_HOSHIDICTS_ENVIRONMENT = hoshidictsEnvironmentFor(
    createDefaultHoshidictsReaderPreferences()
);

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
                ...DEFAULT_HOSHIDICTS_ENVIRONMENT,
                GSM_HOSHIDICTS_CONTROL_PORT: '4567',
                GSM_HOSHIDICTS_ENABLED: '0',
            }),
        });
        expect(
            spawnMock.mock.calls[0][2].env.GSM_HOSHIDICTS_POPUP_BUTTONS
        ).toBeUndefined();
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
        expect(process.env).toMatchObject({
            ...DEFAULT_HOSHIDICTS_ENVIRONMENT,
            GSM_HOSHIDICTS_ENABLED: '1',
            GSM_HOSHIDICTS_CONTROL_PORT: '4567',
        });
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
        const runtime = await loadHoshidictsRuntime();
        const syncCustomDictionary = vi.fn(async () => undefined);
        const configured = makeHoshidictsReaderPreferences({
            lookupMode: 'hover',
            scanLength: 24,
            maxResults: 48,
            sortFrequencyDictionary: 'Frequency',
            sortFrequencyDictionaryOrder: 'ascending',
            averageFrequency: true,
            showFrequencyDictionaryNames: false,
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupHideDelayMs: 850,
            showLookupCounts: false,
            showCompactDefinitionSummary: true,
            compactDefinitionSummaryCount: 5,
            compactDefinitionSummaryDictionary: 'Jitendex',
            showPitchAccentFurigana: false,
            pitchAccentFuriganaDictionary: 'Kanjium Pitch Accents',
            showPitchAccentBadge: true,
            hidePopupGrammarTags: false,
            popupNestingMaxDepth: 4,
            definitionBlur: {
                enabled: true,
                lookupThreshold: 8,
                revealMode: 'hover',
                revealDelayMs: 7000,
            },
            popupWidthPx: 720,
            popupHeightPx: 520,
            popupColumns: 3,
            theme: 'cyberpunk',
            popupOpacityPercent: 70,
            popupBackdropBlurPx: 24,
            popupToolbarPosition: 'bottom',
        });
        runtime.configureHoshidictsRuntime({
            readerPreferences: async () => configured,
            customDictionarySync: syncCustomDictionary,
        });

        await expect(front.runOverlayWithSource('manual')).resolves.toBe(true);

        expect(spawnMock.mock.calls[0][2].env).toMatchObject({
            GSM_HOSHIDICTS_ENABLED: '1',
            ...hoshidictsEnvironmentFor(configured),
        });
        expect(runtime.getHoshidictsEnabledAtLaunch()).toBe(true);
        expect(runtime.getAppliedHoshidictsReaderPreferences()).toEqual(
            configured
        );
        expect(syncCustomDictionary).toHaveBeenCalledOnce();

        expect(runtime.isHoshidictsAudioRestartRequired()).toBe(false);
        expect(runtime.markHoshidictsAudioProfileSyncFailed()).toBe(true);
        expect(runtime.isHoshidictsAudioRestartRequired()).toBe(true);
        expect(runtime.markHoshidictsAudioProfileApplied()).toBe(true);
        expect(runtime.isHoshidictsAudioRestartRequired()).toBe(false);

        const applied = makeHoshidictsReaderPreferences({
            lookupMode: 'shift',
            scanLength: 12,
            maxResults: 20,
            popupHideDelayMs: 1200,
            activationKey: 'Space',
            compactDefinitionSummaryCount: 2,
            popupNestingMaxDepth: 0,
            definitionBlur: {
                enabled: false,
                lookupThreshold: 10,
                revealMode: 'timed',
                revealDelayMs: 9000,
            },
            popupWidthPx: 680,
            popupHeightPx: 480,
            popupColumns: 2,
            theme: 'autumn',
            popupOpacityPercent: 65,
            popupBackdropBlurPx: 6,
            popupButtons: {
                addToAnki: false,
                audio: true,
                customDefinition: false,
                viewInAnki: true,
                customLinks: [
                    {
                        label: 'Jisho',
                        url: 'https://jisho.org/search/%w?sentence=%s',
                    },
                ],
            },
            customPopupCss: ':scope { color: hotpink; }',
        });
        expect(
            runtime.markHoshidictsReaderPreferencesApplied(applied)
        ).toBe(true);
        expect(runtime.getAppliedHoshidictsReaderPreferences()).toEqual(applied);

        processHandle.emit('exit');
        expect(runtime.getAppliedHoshidictsReaderPreferences()).toBeNull();
        expect(runtime.getHoshidictsEnabledAtLaunch()).toBeNull();
        expect(runtime.isHoshidictsAudioRestartRequired()).toBe(false);
        expect(
            runtime.markHoshidictsReaderPreferencesApplied(applied)
        ).toBe(false);
        expect(runtime.markHoshidictsAudioProfileApplied()).toBe(false);
        expect(runtime.markHoshidictsAudioProfileSyncFailed()).toBe(false);
    });

    it('keeps the launch configuration at defaults while the feature is off', async () => {
        isDevValue = true;
        hoshidictsEnabledValue = false;
        existsSyncMock.mockReturnValue(true);
        spawnMock.mockReturnValue(createProcessHandle());

        const front = await loadFrontModule();
        const runtime = await loadHoshidictsRuntime();
        const readerPreferences = vi.fn(async () =>
            makeHoshidictsReaderPreferences({ lookupMode: 'hover' })
        );
        const syncCustomDictionary = vi.fn(async () => undefined);
        runtime.configureHoshidictsRuntime({
            readerPreferences,
            customDictionarySync: syncCustomDictionary,
        });

        await expect(front.runOverlayWithSource('manual')).resolves.toBe(true);

        expect(readerPreferences).not.toHaveBeenCalled();
        expect(syncCustomDictionary).not.toHaveBeenCalled();
        expect(spawnMock.mock.calls[0][2].env).toMatchObject({
            ...DEFAULT_HOSHIDICTS_ENVIRONMENT,
            GSM_HOSHIDICTS_ENABLED: '0',
        });
        expect(runtime.getHoshidictsEnabledAtLaunch()).toBe(false);
    });

    it('falls back to safe launch defaults for out-of-range preferences', async () => {
        isDevValue = true;
        hoshidictsEnabledValue = true;
        existsSyncMock.mockReturnValue(true);
        spawnMock.mockReturnValue(createProcessHandle());

        const front = await loadFrontModule();
        const runtime = await loadHoshidictsRuntime();
        runtime.configureHoshidictsRuntime({
            readerPreferences: async () =>
                makeHoshidictsReaderPreferences({
                    definitionBlur: {
                        enabled: true,
                        lookupThreshold: 0,
                        revealMode: 'hover',
                        revealDelayMs: 999,
                    },
                    compactDefinitionSummaryDictionary: '   ',
                    compactDefinitionSummaryCount: 99,
                }),
        });

        await expect(front.runOverlayWithSource('manual')).resolves.toBe(true);

        // buildHoshidictsOverlayEnvironment normalizes before serializing, so a
        // field the spec table rejects reaches the overlay as its default.
        const carried = JSON.parse(
            spawnMock.mock.calls[0][2].env.GSM_HOSHIDICTS_READER_PREFERENCES
        );
        const defaults = createDefaultHoshidictsReaderPreferences();
        expect(carried.definitionBlur).toEqual(defaults.definitionBlur);
        expect(carried.compactDefinitionSummaryCount).toBe(
            defaults.compactDefinitionSummaryCount
        );
        expect(carried.compactDefinitionSummaryDictionary).toBe(
            defaults.compactDefinitionSummaryDictionary
        );
    });

    it('falls back to launch defaults when the preference provider rejects', async () => {
        isDevValue = true;
        hoshidictsEnabledValue = true;
        existsSyncMock.mockReturnValue(true);
        spawnMock.mockReturnValue(createProcessHandle());
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const front = await loadFrontModule();
        const runtime = await loadHoshidictsRuntime();
        runtime.configureHoshidictsRuntime({
            readerPreferences: async () => {
                throw new Error('manifest unreadable');
            },
        });

        await expect(front.runOverlayWithSource('manual')).resolves.toBe(true);

        expect(spawnMock.mock.calls[0][2].env).toMatchObject({
            ...DEFAULT_HOSHIDICTS_ENVIRONMENT,
            GSM_HOSHIDICTS_ENABLED: '1',
        });
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('using defaults'),
            expect.any(Error)
        );
        warn.mockRestore();
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
        const runtime = await loadHoshidictsRuntime();
        runtime.configureHoshidictsRuntime({
            customDictionarySync: syncCustomDictionary,
        });

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
        const runtime = await loadHoshidictsRuntime();
        runtime.configureHoshidictsRuntime({
            customDictionarySync: async () => {
                throw new Error('custom refresh failed');
            },
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
