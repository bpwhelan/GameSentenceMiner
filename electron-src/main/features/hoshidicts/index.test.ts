import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    controlConnected: true,
    controlHandlers: null as null | {
        openSettings: () => Promise<unknown>;
        addCustomEntry: (value: unknown) => Promise<unknown>;
        onReaderReady?: () => void;
    },
    openWindow: vi.fn(async () => ({})),
    registerIPC: vi.fn(),
    configureLookupModeProvider: vi.fn(),
    configureActivationKeyProvider: vi.fn(),
    configureSourceHighlightProvider: vi.fn(),
    configurePopupHideDelayProvider: vi.fn(),
    configureShowLookupCountsProvider: vi.fn(),
    configureCustomSyncProvider: vi.fn(),
    configurePopupNestingMaxDepthProvider: vi.fn(),
    configureDefinitionBlurProvider: vi.fn(),
    configurePopupWidthProvider: vi.fn(),
    configurePopupHeightProvider: vi.fn(),
    configureThemeProvider: vi.fn(),
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
    managerSnapshot: {
        dictionaries: [
            {
                title: 'Primary',
                termCount: 1,
                favorite: true,
            },
            {
                title: 'Frequency only',
                termCount: 0,
                favorite: true,
            },
            {
                title: 'Backup',
                termCount: 1,
                favorite: false,
            },
        ],
        lookupMode: 'hover',
        activationKey: 'F8',
        sourceHighlightEnabled: true,
        popupHideDelayMs: 850,
        showLookupCounts: false,
        popupNestingMaxDepth: 4,
        popupWidthPx: 680,
        popupHeightPx: 500,
        theme: 'autumn' as const,
        definitionBlur: {
            enabled: true,
            lookupThreshold: 9,
            revealMode: 'hover' as const,
            revealDelayMs: 7500,
        },
        audioProfile: {
            version: 1 as const,
            enabled: true,
            autoPlay: false,
            volume: 100,
            sources: [
                {
                    id: 'jpod101',
                    type: 'jpod101' as const,
                    url: '',
                    voice: '',
                },
            ],
        },
    },
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
    configureHoshidictsLookupModeProvider: harness.configureLookupModeProvider,
    configureHoshidictsActivationKeyProvider:
        harness.configureActivationKeyProvider,
    configureHoshidictsSourceHighlightProvider:
        harness.configureSourceHighlightProvider,
    configureHoshidictsPopupHideDelayProvider:
        harness.configurePopupHideDelayProvider,
    configureHoshidictsShowLookupCountsProvider:
        harness.configureShowLookupCountsProvider,
    configureHoshidictsCustomDictionarySyncProvider:
        harness.configureCustomSyncProvider,
    configureHoshidictsPopupNestingMaxDepthProvider:
        harness.configurePopupNestingMaxDepthProvider,
    configureHoshidictsDefinitionBlurProvider:
        harness.configureDefinitionBlurProvider,
    configureHoshidictsPopupWidthProvider: harness.configurePopupWidthProvider,
    configureHoshidictsPopupHeightProvider:
        harness.configurePopupHeightProvider,
    configureHoshidictsThemeProvider: harness.configureThemeProvider,
    getOverlayHoshidictsEnabledAtLaunch: () => false,
    getOverlayHoshidictsLookupModeAtLaunch: () => 'shift',
    getOverlayHoshidictsActivationKeyAtLaunch: () => 'Shift',
    getOverlayHoshidictsSourceHighlightEnabledAtLaunch: () => false,
    getOverlayHoshidictsPopupHideDelayAtLaunch: () => 300,
    getOverlayHoshidictsShowLookupCountsAtLaunch: () => true,
    getOverlayHoshidictsAudioProfileRestartRequired: () => false,
    getOverlayHoshidictsPopupNestingMaxDepthAtLaunch: () => 10,
    getOverlayHoshidictsDefinitionBlurAtLaunch: () => ({
        enabled: false,
        lookupThreshold: 5,
        revealMode: 'timed',
        revealDelayMs: 5000,
    }),
    getOverlayHoshidictsPopupWidthAtLaunch: () => 560,
    getOverlayHoshidictsPopupHeightAtLaunch: () => 420,
    getOverlayHoshidictsThemeAtLaunch: () => 'default',
    getOverlayRuntimeState: () => ({
        isRunning: false,
        source: null,
    }),
    restartOverlay: vi.fn(async () => true),
    markOverlayHoshidictsReaderPreferencesApplied:
        harness.markPreferencesApplied,
    markOverlayHoshidictsAudioProfileApplied: harness.markAudioApplied,
    markOverlayHoshidictsAudioProfileSyncFailed:
        harness.markAudioSyncFailed,
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

describe('Hoshidicts feature registration', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.controlConnected = true;
        harness.controlHandlers = null;
        harness.configureLookupModeProvider.mockReset();
        harness.configureActivationKeyProvider.mockReset();
        harness.configureSourceHighlightProvider.mockReset();
        harness.configurePopupHideDelayProvider.mockReset();
        harness.configureShowLookupCountsProvider.mockReset();
        harness.configureCustomSyncProvider.mockReset();
        harness.configurePopupNestingMaxDepthProvider.mockReset();
        harness.configureDefinitionBlurProvider.mockReset();
        harness.configurePopupWidthProvider.mockReset();
        harness.configurePopupHeightProvider.mockReset();
        harness.configureThemeProvider.mockReset();
        harness.startManager.mockClear();
        harness.stopManager.mockClear();
        harness.startControl.mockClear();
        harness.stopControl.mockClear();
        harness.controlRequest.mockClear();
        harness.syncCustomDictionary.mockClear();
        harness.addCustomEntry.mockClear();
    });

    it('registers local IPC and preserves every overlay control operation', async () => {
        const { registerHoshidictsFeature, startHoshidictsManager } =
            await import('./index.js');
        await startHoshidictsManager();
        registerHoshidictsFeature({
            getMainWindow: () => null,
        });
        expect(harness.registerIPC).toHaveBeenCalledOnce();
        expect(
            harness.registerIPC.mock.calls[0][0].getConfiguredFeatureEnabled()
        ).toBe(true);
        expect(
            harness.registerIPC.mock.calls[0][0].getOverlayLookupModeAtLaunch()
        ).toBe('shift');
        expect(
            harness.registerIPC.mock.calls[0][0]
                .getOverlayShowLookupCountsAtLaunch()
        ).toBe(true);
        await expect(
            harness.registerIPC.mock.calls[0][0].applyReaderPreferences({
                lookupMode: 'hover',
                activationKey: 'F8',
                sourceHighlightEnabled: true,
                popupHideDelayMs: 850,
                showLookupCounts: false,
                popupNestingMaxDepth: 4,
                definitionBlur: harness.managerSnapshot.definitionBlur,
                popupWidthPx: 680,
                popupHeightPx: 500,
                theme: 'autumn',
            })
        ).resolves.toBe(true);
        expect(harness.controlRequest).toHaveBeenCalledWith(
            'hoshidicts.readerPreferences',
            {
                lookupMode: 'hover',
                activationKey: 'F8',
                sourceHighlightEnabled: true,
                popupHideDelayMs: 850,
                showLookupCounts: false,
                popupNestingMaxDepth: 4,
                definitionBlur: harness.managerSnapshot.definitionBlur,
                popupWidthPx: 680,
                popupHeightPx: 500,
                theme: 'autumn',
            },
            2000
        );
        expect(harness.markPreferencesApplied).toHaveBeenCalledWith({
            lookupMode: 'hover',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupHideDelayMs: 850,
            showLookupCounts: false,
            popupNestingMaxDepth: 4,
            definitionBlur: harness.managerSnapshot.definitionBlur,
            popupWidthPx: 680,
            popupHeightPx: 500,
            theme: 'autumn',
        });
        await expect(
            harness.registerIPC.mock.calls[0][0].applyAudioProfile(
                harness.managerSnapshot.audioProfile
            )
        ).resolves.toBe(true);
        expect(harness.controlRequest).toHaveBeenCalledWith(
            'hoshidicts.audioProfile',
            harness.managerSnapshot.audioProfile,
            2000
        );
        expect(harness.markAudioApplied).toHaveBeenCalledWith(
            harness.managerSnapshot.audioProfile
        );
        await expect(
            harness.controlHandlers?.openSettings()
        ).resolves.toEqual({ opened: true });
        expect(harness.openWindow).toHaveBeenCalledOnce();

        harness.controlRequest.mockClear();
        harness.controlHandlers?.onReaderReady?.();
        await vi.waitFor(() => {
            expect(harness.controlRequest).toHaveBeenCalledWith(
                'hoshidicts.readerPreferences',
                {
                    lookupMode: 'hover',
                    activationKey: 'F8',
                    sourceHighlightEnabled: true,
                    popupHideDelayMs: 850,
                    showLookupCounts: false,
                    popupNestingMaxDepth: 4,
                    definitionBlur: harness.managerSnapshot.definitionBlur,
                    popupWidthPx: 680,
                    popupHeightPx: 500,
                    theme: 'autumn',
                    dictionaryPresentation: [
                        {
                            title: 'Primary',
                            favorite: true,
                        },
                        {
                            title: 'Backup',
                            favorite: false,
                        },
                    ],
                },
                2000
            );
            expect(harness.controlRequest).toHaveBeenCalledWith(
                'hoshidicts.audioProfile',
                harness.managerSnapshot.audioProfile,
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
        await expect(
            harness.controlHandlers?.addCustomEntry({ term: '猫' })
        ).rejects.toThrow('fields must be strings');
    });

    it('wires the persisted lookup mode into overlay launches after startup', async () => {
        const { startHoshidictsManager } = await import('./index.js');

        await startHoshidictsManager();

        expect(harness.startManager).toHaveBeenCalledOnce();
        expect(harness.syncCustomDictionary).toHaveBeenCalledOnce();
        expect(
            harness.syncCustomDictionary.mock.invocationCallOrder[0]
        ).toBeLessThan(harness.startManager.mock.invocationCallOrder[0]);
        expect(harness.configureLookupModeProvider).toHaveBeenCalledOnce();
        const provider = harness.configureLookupModeProvider.mock.calls[0][0];
        await expect(provider()).resolves.toBe('hover');
        expect(harness.configureActivationKeyProvider).toHaveBeenCalledOnce();
        const activationKeyProvider =
            harness.configureActivationKeyProvider.mock.calls[0][0];
        await expect(activationKeyProvider()).resolves.toBe('F8');
        expect(harness.configureSourceHighlightProvider).toHaveBeenCalledOnce();
        const sourceHighlightProvider =
            harness.configureSourceHighlightProvider.mock.calls[0][0];
        await expect(sourceHighlightProvider()).resolves.toBe(true);
        expect(
            harness.configurePopupHideDelayProvider
        ).toHaveBeenCalledOnce();
        const delayProvider =
            harness.configurePopupHideDelayProvider.mock.calls[0][0];
        await expect(delayProvider()).resolves.toBe(850);
        expect(
            harness.configureShowLookupCountsProvider
        ).toHaveBeenCalledOnce();
        const showLookupCountsProvider =
            harness.configureShowLookupCountsProvider.mock.calls[0][0];
        await expect(showLookupCountsProvider()).resolves.toBe(false);
        expect(
            harness.configurePopupNestingMaxDepthProvider
        ).toHaveBeenCalledOnce();
        const depthProvider =
            harness.configurePopupNestingMaxDepthProvider.mock.calls[0][0];
        await expect(depthProvider()).resolves.toBe(4);
        expect(
            harness.configureDefinitionBlurProvider
        ).toHaveBeenCalledOnce();
        const definitionBlurProvider =
            harness.configureDefinitionBlurProvider.mock.calls[0][0];
        await expect(definitionBlurProvider()).resolves.toEqual({
            enabled: true,
            lookupThreshold: 9,
            revealMode: 'hover',
            revealDelayMs: 7500,
        });
        expect(harness.configurePopupWidthProvider).toHaveBeenCalledOnce();
        await expect(
            harness.configurePopupWidthProvider.mock.calls[0][0]()
        ).resolves.toBe(680);
        expect(harness.configurePopupHeightProvider).toHaveBeenCalledOnce();
        await expect(
            harness.configurePopupHeightProvider.mock.calls[0][0]()
        ).resolves.toBe(500);
        expect(harness.configureThemeProvider).toHaveBeenCalledOnce();
        await expect(
            harness.configureThemeProvider.mock.calls[0][0]()
        ).resolves.toBe('autumn');
        expect(harness.configureCustomSyncProvider).toHaveBeenCalledOnce();
        const syncProvider = harness.configureCustomSyncProvider.mock.calls[0][0];
        await expect(syncProvider()).resolves.toBeUndefined();
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
        expect(harness.configureLookupModeProvider).toHaveBeenCalledOnce();
        expect(harness.configureCustomSyncProvider).toHaveBeenCalledOnce();
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
            harness.registerIPC.mock.calls[0][0].applyAudioProfile(
                harness.managerSnapshot.audioProfile
            )
        ).resolves.toBe(false);
        expect(harness.markAudioSyncFailed).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('audio settings'),
            expect.any(Error)
        );
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
            ...harness.managerSnapshot.audioProfile,
            volume: 42,
        };
        await expect(
            harness.registerIPC.mock.calls[0][0].applyAudioProfile(liveProfile)
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
        expect(harness.markAudioApplied).toHaveBeenCalledWith(liveProfile);
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
