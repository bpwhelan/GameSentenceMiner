import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    makeHoshidictsDictionary,
    makeHoshidictsReaderPreferences,
    makeHoshidictsSnapshot,
} from './test_helpers.js';

const harness = vi.hoisted(() => ({
    controlConnected: true,
    controlHandlers: null as null | {
        openSettings: () => Promise<unknown>;
        addCustomEntry: (value: unknown) => Promise<unknown>;
        onReaderReady?: () => void;
    },
    openWindow: vi.fn(async () => ({})),
    registerIPC: vi.fn(),
    configureRuntime: vi.fn(),
    enabledAtLaunch: false as boolean | null,
    appliedReaderPreferences: null as unknown,
    audioRestartRequired: false,
    markPreferencesApplied: vi.fn(() => true),
    markAudioApplied: vi.fn(() => true),
    markAudioSyncFailed: vi.fn(() => true),
    controlRequest: vi.fn(async () => ({ applied: true })),
    startControl: vi.fn(async () => 4567),
    stopControl: vi.fn(async () => undefined),
    startManager: vi.fn(async () => undefined),
    stopManager: vi.fn(async () => undefined),
    syncCustomDictionary: vi.fn(async () => ({
        text: '',
        revision: 'empty',
        exists: false,
        filePath: '/tmp/custom-dictionary.txt',
    })),
    addCustomEntry: vi.fn(async () => ({})),
    managerSnapshot: null as unknown,
}));

vi.mock('./control_channel.js', () => ({
    HOSHIDICTS_CONTROL_METHODS: {
        openSettings: 'hoshidicts.openSettings',
        readerPreferences: 'hoshidicts.readerPreferences',
        audioProfile: 'hoshidicts.audioProfile',
        addCustomEntry: 'hoshidicts.addCustomEntry',
    },
    configureHoshidictsControlChannel: vi.fn((handlers) => {
        harness.controlHandlers = handlers;
    }),
    isHoshidictsReaderControlConnected: () => harness.controlConnected,
    requestHoshidictsReader: harness.controlRequest,
    startHoshidictsControlChannel: harness.startControl,
    stopHoshidictsControlChannel: harness.stopControl,
}));

vi.mock('../../gsm_config.js', () => ({
    getConfiguredHoshidictsEnabled: () => true,
    getConfiguredSinglePort: () => 7275,
}));

vi.mock('../../ui/front.js', () => ({
    getOverlayRuntimeState: () => ({ isRunning: false, source: null }),
    restartOverlay: vi.fn(async () => true),
}));

vi.mock('./runtime_state.js', () => ({
    configureHoshidictsRuntime: harness.configureRuntime,
    getHoshidictsEnabledAtLaunch: () => harness.enabledAtLaunch,
    getAppliedHoshidictsReaderPreferences: () =>
        harness.appliedReaderPreferences,
    isHoshidictsAudioRestartRequired: () => harness.audioRestartRequired,
    markHoshidictsReaderPreferencesApplied: harness.markPreferencesApplied,
    markHoshidictsAudioProfileApplied: harness.markAudioApplied,
    markHoshidictsAudioProfileSyncFailed: harness.markAudioSyncFailed,
}));

vi.mock('./ipc.js', () => ({
    registerHoshidictsIPC: harness.registerIPC,
}));

vi.mock('./manager.js', () => ({
    getHoshidictsManager: () => ({
        getSnapshot: vi.fn(async () => harness.managerSnapshot),
        syncCustomDictionary: harness.syncCustomDictionary,
        addCustomEntry: harness.addCustomEntry,
    }),
    startHoshidictsManager: harness.startManager,
    stopHoshidictsManager: harness.stopManager,
}));

vi.mock('./window.js', () => ({
    getHoshidictsSettingsWindow: () => null,
    openHoshidictsSettingsWindow: harness.openWindow,
}));

/**
 * The stored reader preferences the mocked manager persists. Every consumer
 * round-trips this opaquely; no individual field is asserted, and the
 * hoshidictsReaderPreferencesFromSnapshot projection is pinned over a full
 * non-default set in ipc.test.ts.
 */
const readerPreferences = makeHoshidictsReaderPreferences({
    lookupMode: 'hover',
    sortFrequencyDictionary: 'Frequency only',
    theme: 'autumn',
});

/** The dictionary context the overlay is told about alongside the preferences. */
const readerDictionaryContext = {
    dictionaryPresentation: [
        { title: 'Primary', favorite: true, displayName: 'Core lexicon' },
        {
            title: 'Frequency only',
            favorite: true,
            frequencyMode: 'rank-based',
        },
        { title: 'Backup', favorite: false },
    ],
    frequencyDictionaries: ['Frequency only'],
    dictionaryTabGroups: [],
};

const managerSnapshot = makeHoshidictsSnapshot({
    ...readerPreferences,
    dictionaries: [
        makeHoshidictsDictionary({
            id: 'primary',
            title: 'Primary',
            displayName: 'Core lexicon',
            favorite: true,
        }),
        makeHoshidictsDictionary({
            id: 'frequency-only',
            title: 'Frequency only',
            termCount: 0,
            favorite: true,
            frequencyCount: 12,
            frequencyMode: 'rank-based',
        }),
        makeHoshidictsDictionary({ id: 'backup', title: 'Backup' }),
    ],
    audioProfile: {
        version: 1,
        enabled: true,
        autoPlay: false,
        volume: 100,
        sources: [{ id: 'jpod101', type: 'jpod101', url: '', voice: '' }],
    },
});
harness.managerSnapshot = managerSnapshot;

/** Preferences plus the derived dictionary context, as delivered to the reader. */
const deliveredPreferences = {
    ...readerPreferences,
    ...readerDictionaryContext,
};

function ipcDependencies(): any {
    return harness.registerIPC.mock.calls[0][0];
}

describe('Hoshidicts feature registration', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.controlConnected = true;
        harness.controlHandlers = null;
        harness.enabledAtLaunch = false;
        harness.appliedReaderPreferences = null;
        harness.audioRestartRequired = false;
    });

    it('registers local IPC and preserves every overlay control operation', async () => {
        const { registerHoshidictsFeature, startHoshidictsManager } =
            await import('./index.js');
        await startHoshidictsManager();
        registerHoshidictsFeature({
            getMainWindow: () => null,
        });
        expect(harness.registerIPC).toHaveBeenCalledOnce();
        const deps = ipcDependencies();

        // The desktop state getters are now one object plus two flags.
        expect(deps.getConfiguredFeatureEnabled()).toBe(true);
        expect(deps.getOverlayFeatureEnabledAtLaunch()).toBe(false);
        expect(deps.getAppliedReaderPreferences()).toBeNull();
        expect(deps.getOverlayAudioProfileRestartRequired()).toBe(false);
        harness.appliedReaderPreferences = readerPreferences;
        harness.enabledAtLaunch = true;
        harness.audioRestartRequired = true;
        expect(deps.getAppliedReaderPreferences()).toEqual(readerPreferences);
        expect(deps.getOverlayFeatureEnabledAtLaunch()).toBe(true);
        expect(deps.getOverlayAudioProfileRestartRequired()).toBe(true);

        await expect(
            deps.applyReaderPreferences(deliveredPreferences)
        ).resolves.toBe(true);
        expect(harness.controlRequest).toHaveBeenCalledWith(
            'hoshidicts.readerPreferences',
            deliveredPreferences,
            2000
        );
        expect(harness.markPreferencesApplied).toHaveBeenCalledWith(
            deliveredPreferences
        );

        await expect(
            deps.applyAudioProfile(managerSnapshot.audioProfile)
        ).resolves.toBe(true);
        expect(harness.controlRequest).toHaveBeenCalledWith(
            'hoshidicts.audioProfile',
            managerSnapshot.audioProfile,
            2000
        );
        expect(harness.markAudioApplied).toHaveBeenCalledWith();

        await expect(
            harness.controlHandlers?.openSettings()
        ).resolves.toEqual({ opened: true });
        expect(harness.openWindow).toHaveBeenCalledOnce();

        harness.controlRequest.mockClear();
        harness.controlHandlers?.onReaderReady?.();
        await vi.waitFor(() => {
            expect(harness.controlRequest).toHaveBeenCalledWith(
                'hoshidicts.readerPreferences',
                deliveredPreferences,
                2000
            );
            expect(harness.controlRequest).toHaveBeenCalledWith(
                'hoshidicts.audioProfile',
                managerSnapshot.audioProfile,
                2000
            );
        });

        await expect(
            harness.controlHandlers?.addCustomEntry({
                term: ' 猫 ',
                reading: ' ねこ ',
                definition: ' cat ',
            })
        ).resolves.toEqual({ saved: true });
        expect(harness.addCustomEntry).toHaveBeenCalledWith({
            term: ' 猫 ',
            reading: ' ねこ ',
            definition: ' cat ',
        });
    });

    it('wires the persisted preferences into overlay launches after startup', async () => {
        const { startHoshidictsManager } = await import('./index.js');

        await startHoshidictsManager();

        expect(harness.startManager).toHaveBeenCalledOnce();
        expect(harness.syncCustomDictionary).toHaveBeenCalledOnce();
        expect(
            harness.syncCustomDictionary.mock.invocationCallOrder[0]
        ).toBeLessThan(harness.startManager.mock.invocationCallOrder[0]);
        expect(harness.configureRuntime).toHaveBeenCalledOnce();

        // One runtime configuration replaces the per-preference providers.
        const providers = harness.configureRuntime.mock.calls[0][0];
        expect(Object.keys(providers).sort()).toEqual([
            'customDictionarySync',
            'readerPreferences',
        ]);
        await expect(providers.readerPreferences()).resolves.toEqual(
            deliveredPreferences
        );
        await expect(providers.customDictionarySync()).resolves.toBeUndefined();
        expect(harness.syncCustomDictionary).toHaveBeenCalledTimes(2);
        expect(harness.startControl).toHaveBeenCalledOnce();
    });

    it('keeps startup available when the custom source cannot be synchronized', async () => {
        const failure = new Error('custom source is not valid UTF-8');
        harness.syncCustomDictionary.mockRejectedValueOnce(failure);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { startHoshidictsManager } = await import('./index.js');

        await expect(startHoshidictsManager()).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('during startup'),
            failure
        );
        expect(harness.configureRuntime).toHaveBeenCalledOnce();
    });

    it('does not hold application startup open while custom import is running', async () => {
        let finishSync!: () => void;
        harness.syncCustomDictionary.mockReturnValueOnce(
            new Promise((resolve) => {
                finishSync = () =>
                    resolve({
                        text: '',
                        revision: 'empty',
                        exists: false,
                        filePath: '/tmp/custom-dictionary.txt',
                    });
            })
        );
        const { startHoshidictsManager } = await import('./index.js');

        await expect(startHoshidictsManager()).resolves.toBeUndefined();

        expect(harness.syncCustomDictionary).toHaveBeenCalledOnce();
        expect(harness.startManager).toHaveBeenCalledOnce();
        finishSync();
        await Promise.resolve();
    });

    it('marks a running reader stale when live audio delivery fails', async () => {
        harness.controlRequest.mockRejectedValueOnce(new Error('reader unavailable'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { registerHoshidictsFeature } = await import('./index.js');

        registerHoshidictsFeature({ getMainWindow: () => null });

        await expect(
            ipcDependencies().applyAudioProfile(managerSnapshot.audioProfile)
        ).resolves.toBe(false);
        expect(harness.markAudioSyncFailed).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('audio settings'),
            expect.any(Error)
        );
    });

    it('marks a disconnected reader stale without contacting it', async () => {
        harness.controlConnected = false;
        const { registerHoshidictsFeature } = await import('./index.js');

        registerHoshidictsFeature({ getMainWindow: () => null });

        await expect(
            ipcDependencies().applyAudioProfile(managerSnapshot.audioProfile)
        ).resolves.toBe(false);
        await expect(
            ipcDependencies().applyReaderPreferences(deliveredPreferences)
        ).resolves.toBe(false);
        expect(harness.markAudioSyncFailed).toHaveBeenCalledOnce();
        expect(harness.markPreferencesApplied).not.toHaveBeenCalled();
        expect(harness.controlRequest).not.toHaveBeenCalled();
    });

    it('does not overwrite a live audio update with an older connection snapshot', async () => {
        let finishInitialPreferences!: () => void;
        harness.controlRequest
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishInitialPreferences = () =>
                            resolve({ applied: true });
                    })
            )
            .mockResolvedValue({ applied: true });
        const { registerHoshidictsFeature, startHoshidictsManager } =
            await import('./index.js');
        await startHoshidictsManager();
        registerHoshidictsFeature({ getMainWindow: () => null });

        harness.controlHandlers?.onReaderReady?.();
        await vi.waitFor(() => {
            expect(harness.controlRequest).toHaveBeenCalledTimes(1);
        });

        const liveProfile = {
            ...managerSnapshot.audioProfile,
            volume: 42,
        };
        await expect(
            ipcDependencies().applyAudioProfile(liveProfile)
        ).resolves.toBe(true);
        finishInitialPreferences();
        await vi.waitFor(() => {
            expect(harness.markPreferencesApplied).toHaveBeenCalledOnce();
        });

        expect(harness.controlRequest).toHaveBeenCalledTimes(2);
        expect(harness.controlRequest).toHaveBeenLastCalledWith(
            'hoshidicts.audioProfile',
            liveProfile,
            2000
        );
        expect(harness.markAudioApplied).toHaveBeenCalledWith();
        expect(harness.markAudioSyncFailed).not.toHaveBeenCalled();
    });

    it('keeps local settings IPC available if the loopback channel failed to start', async () => {
        harness.startControl.mockRejectedValueOnce(new Error('bind failed'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { registerHoshidictsFeature, startHoshidictsManager } =
            await import('./index.js');

        await expect(startHoshidictsManager()).resolves.toBeUndefined();

        registerHoshidictsFeature({
            getMainWindow: () => null,
        });

        expect(harness.registerIPC).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('loopback control channel'),
            expect.any(Error)
        );
    });

    it('stops the manager even when control-channel shutdown fails', async () => {
        const failure = new Error('close failed');
        harness.stopControl.mockRejectedValueOnce(failure);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { stopHoshidictsManager } = await import('./index.js');

        await expect(stopHoshidictsManager()).resolves.toBeUndefined();

        expect(harness.stopControl).toHaveBeenCalledOnce();
        expect(harness.stopManager).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('control channel'),
            failure
        );
    });
});
