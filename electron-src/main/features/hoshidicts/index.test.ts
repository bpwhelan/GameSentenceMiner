import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    busInfo: { port: 1234, token: 'token' } as {
        port: number;
        token: string;
    } | null,
    busConnectedHandler: null as ((clientId: string) => void) | null,
    busHandlers: new Map<
        string,
        (message: { src: string; data?: unknown }) => Promise<unknown>
    >(),
    openWindow: vi.fn(async () => ({})),
    registerIPC: vi.fn(),
    configureLookupModeProvider: vi.fn(),
    configureActivationKeyProvider: vi.fn(),
    configureSourceHighlightProvider: vi.fn(),
    configurePopupHideDelayProvider: vi.fn(),
    configureCustomSyncProvider: vi.fn(),
    configurePopupNestingMaxDepthProvider: vi.fn(),
    markPreferencesApplied: vi.fn(() => true),
    markAudioApplied: vi.fn(() => true),
    markAudioSyncFailed: vi.fn(() => true),
    busRequest: vi.fn(async () => ({ applied: true })),
    startManager: vi.fn(async () => undefined),
    syncCustomDictionary: vi.fn(async () => ({
        text: '',
        revision: 'empty',
        exists: false,
        filePath: '/tmp/custom-dictionary.txt',
    })),
    addCustomEntry: vi.fn(async () => ({})),
    managerSnapshot: {
        lookupMode: 'hover',
        activationKey: 'F8',
        sourceHighlightEnabled: true,
        popupHideDelayMs: 850,
        popupNestingMaxDepth: 4,
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

vi.mock('../../runtime/bus_client.js', () => ({
    bus: {
        handle: vi.fn(
            (
                topic: string,
                handler: (message: { src: string; data?: unknown }) => Promise<unknown>
            ) => {
                harness.busHandlers.set(topic, handler);
                return () => {};
            }
        ),
        isConnected: vi.fn(() => true),
        request: harness.busRequest,
        on: vi.fn(
            (
                event: string,
                handler: (clientId: string) => void
            ) => {
                if (event === 'client-connected') {
                    harness.busConnectedHandler = handler;
                }
                return () => {};
            }
        ),
    },
    getBusConnectInfo: () => harness.busInfo,
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
    configureHoshidictsCustomDictionarySyncProvider:
        harness.configureCustomSyncProvider,
    configureHoshidictsPopupNestingMaxDepthProvider:
        harness.configurePopupNestingMaxDepthProvider,
    getOverlayHoshidictsEnabledAtLaunch: () => false,
    getOverlayHoshidictsLookupModeAtLaunch: () => 'shift',
    getOverlayHoshidictsActivationKeyAtLaunch: () => 'Shift',
    getOverlayHoshidictsSourceHighlightEnabledAtLaunch: () => false,
    getOverlayHoshidictsPopupHideDelayAtLaunch: () => 300,
    getOverlayHoshidictsAudioProfileRestartRequired: () => false,
    getOverlayHoshidictsPopupNestingMaxDepthAtLaunch: () => 10,
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
    stopHoshidictsManager: vi.fn(),
}));

vi.mock('./window.js', () => ({
    getHoshidictsSettingsWindow: () => null,
    openHoshidictsSettingsWindow: harness.openWindow,
}));

describe('Hoshidicts feature registration', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.busInfo = { port: 1234, token: 'token' };
        harness.busConnectedHandler = null;
        harness.busHandlers.clear();
        harness.configureLookupModeProvider.mockReset();
        harness.configureActivationKeyProvider.mockReset();
        harness.configureSourceHighlightProvider.mockReset();
        harness.configurePopupHideDelayProvider.mockReset();
        harness.configureCustomSyncProvider.mockReset();
        harness.configurePopupNestingMaxDepthProvider.mockReset();
        harness.startManager.mockClear();
        harness.syncCustomDictionary.mockClear();
        harness.addCustomEntry.mockClear();
    });

    it('accepts only the authenticated one-shot overlay client identity', async () => {
        const {
            isHoshidictsOverlaySettingsClient,
            registerHoshidictsFeature,
        } = await import('./index.js');

        expect(
            isHoshidictsOverlaySettingsClient(
                'overlay.hoshidicts-settings.10.uuid'
            )
        ).toBe(true);
        expect(isHoshidictsOverlaySettingsClient('overlay')).toBe(false);
        expect(isHoshidictsOverlaySettingsClient('backend')).toBe(false);

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
        await expect(
            harness.registerIPC.mock.calls[0][0].applyReaderPreferences({
                lookupMode: 'hover',
                activationKey: 'F8',
                sourceHighlightEnabled: true,
                popupHideDelayMs: 850,
                popupNestingMaxDepth: 4,
            })
        ).resolves.toBe(true);
        expect(harness.busRequest).toHaveBeenCalledWith(
            'overlay.hoshidicts-reader',
            'hoshidicts.readerPreferences',
            {
                lookupMode: 'hover',
                activationKey: 'F8',
                sourceHighlightEnabled: true,
                popupHideDelayMs: 850,
                popupNestingMaxDepth: 4,
            },
            2000
        );
        expect(harness.markPreferencesApplied).toHaveBeenCalledWith({
            lookupMode: 'hover',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupHideDelayMs: 850,
            popupNestingMaxDepth: 4,
        });
        await expect(
            harness.registerIPC.mock.calls[0][0].applyAudioProfile(
                harness.managerSnapshot.audioProfile
            )
        ).resolves.toBe(true);
        expect(harness.busRequest).toHaveBeenCalledWith(
            'overlay.hoshidicts-reader',
            'hoshidicts.audioProfile',
            harness.managerSnapshot.audioProfile,
            2000
        );
        expect(harness.markAudioApplied).toHaveBeenCalledWith(
            harness.managerSnapshot.audioProfile
        );
        const openHandler = harness.busHandlers.get('hoshidicts.openSettings');
        expect(openHandler).toBeDefined();

        await expect(
            openHandler?.({ src: 'backend' })
        ).rejects.toThrow('Only the GSM overlay');
        await expect(
            openHandler?.({
                src: 'overlay.hoshidicts-settings.10.uuid',
            })
        ).resolves.toEqual({ opened: true });
        expect(harness.openWindow).toHaveBeenCalledOnce();

        harness.busRequest.mockClear();
        harness.busConnectedHandler?.('backend');
        expect(harness.busRequest).not.toHaveBeenCalled();
        harness.busConnectedHandler?.('overlay.hoshidicts-reader');
        await vi.waitFor(() => {
            expect(harness.busRequest).toHaveBeenCalledWith(
                'overlay.hoshidicts-reader',
                'hoshidicts.readerPreferences',
                {
                    lookupMode: 'hover',
                    activationKey: 'F8',
                    sourceHighlightEnabled: true,
                    popupHideDelayMs: 850,
                    popupNestingMaxDepth: 4,
                },
                2000
            );
            expect(harness.busRequest).toHaveBeenCalledWith(
                'overlay.hoshidicts-reader',
                'hoshidicts.audioProfile',
                harness.managerSnapshot.audioProfile,
                2000
            );
        });

        const addHandler = harness.busHandlers.get('hoshidicts.addCustomEntry');
        await expect(
            addHandler?.({
                src: 'backend',
                data: { term: '猫', reading: 'ねこ', definition: 'cat' },
            })
        ).rejects.toThrow('Only the Hoshidicts overlay reader');
        await expect(
            addHandler?.({
                src: 'overlay.hoshidicts-reader',
                data: { term: ' 猫 ', reading: ' ねこ ', definition: ' cat ' },
            })
        ).resolves.toEqual({ saved: true });
        expect(harness.addCustomEntry).toHaveBeenCalledWith({
            term: ' 猫 ',
            reading: ' ねこ ',
            definition: ' cat ',
        });
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
            harness.configurePopupNestingMaxDepthProvider
        ).toHaveBeenCalledOnce();
        const depthProvider =
            harness.configurePopupNestingMaxDepthProvider.mock.calls[0][0];
        await expect(depthProvider()).resolves.toBe(4);
        expect(harness.configureCustomSyncProvider).toHaveBeenCalledOnce();
        const syncProvider = harness.configureCustomSyncProvider.mock.calls[0][0];
        await expect(syncProvider()).resolves.toBeUndefined();
        expect(harness.syncCustomDictionary).toHaveBeenCalledTimes(2);
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
        harness.busRequest.mockRejectedValueOnce(new Error('reader unavailable'));
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

    it('keeps local settings IPC available if the desktop bus failed to start', async () => {
        harness.busInfo = null;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { registerHoshidictsFeature } = await import('./index.js');

        registerHoshidictsFeature({
            getMainWindow: () => null,
        });

        expect(harness.registerIPC).toHaveBeenCalledOnce();
        expect(harness.busHandlers.size).toBe(0);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('message bus is unavailable')
        );
    });
});
