import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    busInfo: { port: 1234, token: 'token' } as {
        port: number;
        token: string;
    } | null,
    busHandler: null as ((message: { src: string }) => Promise<unknown>) | null,
    busConnectedHandler: null as ((clientId: string) => void) | null,
    openWindow: vi.fn(async () => ({})),
    registerIPC: vi.fn(),
    configureLookupModeProvider: vi.fn(),
    configureActivationKeyProvider: vi.fn(),
    configureSourceHighlightProvider: vi.fn(),
    configurePopupHideDelayProvider: vi.fn(),
    markPreferencesApplied: vi.fn(() => true),
    markAudioApplied: vi.fn(() => true),
    markAudioSyncFailed: vi.fn(() => true),
    busRequest: vi.fn(async () => ({ applied: true })),
    startManager: vi.fn(async () => undefined),
    managerSnapshot: {
        lookupMode: 'hover',
        activationKey: 'F8',
        sourceHighlightEnabled: true,
        popupHideDelayMs: 850,
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
                _topic: string,
                handler: (message: { src: string }) => Promise<unknown>
            ) => {
                harness.busHandler = handler;
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
    getOverlayHoshidictsEnabledAtLaunch: () => false,
    getOverlayHoshidictsLookupModeAtLaunch: () => 'shift',
    getOverlayHoshidictsActivationKeyAtLaunch: () => 'Shift',
    getOverlayHoshidictsSourceHighlightEnabledAtLaunch: () => false,
    getOverlayHoshidictsPopupHideDelayAtLaunch: () => 300,
    getOverlayHoshidictsAudioProfileRestartRequired: () => false,
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
        harness.busHandler = null;
        harness.busConnectedHandler = null;
        harness.configureLookupModeProvider.mockReset();
        harness.configureActivationKeyProvider.mockReset();
        harness.configureSourceHighlightProvider.mockReset();
        harness.configurePopupHideDelayProvider.mockReset();
        harness.startManager.mockClear();
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
            },
            2000
        );
        expect(harness.markPreferencesApplied).toHaveBeenCalledWith({
            lookupMode: 'hover',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupHideDelayMs: 850,
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
        expect(harness.busHandler).not.toBeNull();

        await expect(
            harness.busHandler?.({ src: 'backend' })
        ).rejects.toThrow('Only the GSM overlay');
        await expect(
            harness.busHandler?.({
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
    });

    it('wires the persisted lookup mode into overlay launches after startup', async () => {
        const { startHoshidictsManager } = await import('./index.js');

        await startHoshidictsManager();

        expect(harness.startManager).toHaveBeenCalledOnce();
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
        expect(harness.busHandler).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('message bus is unavailable')
        );
    });
});
