import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    busInfo: { port: 1234, token: 'token' } as {
        port: number;
        token: string;
    } | null,
    busHandlers: new Map<
        string,
        (message: { src: string; data?: unknown }) => Promise<unknown>
    >(),
    openWindow: vi.fn(async () => ({})),
    registerIPC: vi.fn(),
    configureLookupModeProvider: vi.fn(),
    configurePopupHideDelayProvider: vi.fn(),
    configureCustomSyncProvider: vi.fn(),
    markPreferencesApplied: vi.fn(() => true),
    busRequest: vi.fn(async () => ({ applied: true })),
    startManager: vi.fn(async () => undefined),
    syncCustomDictionary: vi.fn(async () => ({
        text: '',
        revision: 'empty',
        exists: false,
        filePath: '/tmp/custom-dictionary.txt',
    })),
    addCustomEntry: vi.fn(async () => ({})),
    managerSnapshot: { lookupMode: 'hover', popupHideDelayMs: 850 },
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
    },
    getBusConnectInfo: () => harness.busInfo,
}));

vi.mock('../../gsm_config.js', () => ({
    getConfiguredHoshidictsEnabled: () => true,
    getConfiguredSinglePort: () => 7275,
}));

vi.mock('../../ui/front.js', () => ({
    configureHoshidictsLookupModeProvider: harness.configureLookupModeProvider,
    configureHoshidictsPopupHideDelayProvider:
        harness.configurePopupHideDelayProvider,
    configureHoshidictsCustomDictionarySyncProvider:
        harness.configureCustomSyncProvider,
    getOverlayHoshidictsEnabledAtLaunch: () => false,
    getOverlayHoshidictsLookupModeAtLaunch: () => 'shift',
    getOverlayHoshidictsPopupHideDelayAtLaunch: () => 300,
    getOverlayRuntimeState: () => ({
        isRunning: false,
        source: null,
    }),
    restartOverlay: vi.fn(async () => true),
    markOverlayHoshidictsReaderPreferencesApplied:
        harness.markPreferencesApplied,
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
        harness.busHandlers.clear();
        harness.configureLookupModeProvider.mockReset();
        harness.configurePopupHideDelayProvider.mockReset();
        harness.configureCustomSyncProvider.mockReset();
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
                popupHideDelayMs: 850,
            })
        ).resolves.toBe(true);
        expect(harness.busRequest).toHaveBeenCalledWith(
            'overlay.hoshidicts-reader',
            'hoshidicts.readerPreferences',
            { lookupMode: 'hover', popupHideDelayMs: 850 },
            2000
        );
        expect(harness.markPreferencesApplied).toHaveBeenCalledWith({
            lookupMode: 'hover',
            popupHideDelayMs: 850,
        });
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
        expect(
            harness.configurePopupHideDelayProvider
        ).toHaveBeenCalledOnce();
        const delayProvider =
            harness.configurePopupHideDelayProvider.mock.calls[0][0];
        await expect(delayProvider()).resolves.toBe(850);
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
