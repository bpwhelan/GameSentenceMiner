import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    busInfo: { port: 1234, token: 'token' } as {
        port: number;
        token: string;
    } | null,
    busHandler: null as ((message: { src: string }) => Promise<unknown>) | null,
    openWindow: vi.fn(async () => ({})),
    registerIPC: vi.fn(),
    configureLookupModeProvider: vi.fn(),
    startManager: vi.fn(async () => undefined),
    managerSnapshot: { lookupMode: 'hover' },
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
    },
    getBusConnectInfo: () => harness.busInfo,
}));

vi.mock('../../gsm_config.js', () => ({
    getConfiguredHoshidictsEnabled: () => true,
    getConfiguredSinglePort: () => 7275,
}));

vi.mock('../../ui/front.js', () => ({
    configureHoshidictsLookupModeProvider: harness.configureLookupModeProvider,
    getOverlayHoshidictsEnabledAtLaunch: () => false,
    getOverlayHoshidictsLookupModeAtLaunch: () => 'shift',
    getOverlayRuntimeState: () => ({
        isRunning: false,
        source: null,
    }),
    restartOverlay: vi.fn(async () => true),
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
        harness.configureLookupModeProvider.mockReset();
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
    });

    it('wires the persisted lookup mode into overlay launches after startup', async () => {
        const { startHoshidictsManager } = await import('./index.js');

        await startHoshidictsManager();

        expect(harness.startManager).toHaveBeenCalledOnce();
        expect(harness.configureLookupModeProvider).toHaveBeenCalledOnce();
        const provider = harness.configureLookupModeProvider.mock.calls[0][0];
        await expect(provider()).resolves.toBe('hover');
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
