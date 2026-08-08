import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => any>(),
    fromWebContents: vi.fn(),
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    subscriber: null as ((snapshot: any) => void) | null,
    configuredEnabled: true,
    enabledAtLaunch: false as boolean | null,
    lookupModeAtLaunch: 'shift' as 'shift' | 'hover' | null,
    popupHideDelayAtLaunch: 300 as number | null,
    definitionBlurAtLaunch: {
        enabled: false,
        lookupThreshold: 5,
        revealMode: 'timed' as 'timed' | 'hover',
        revealDelayMs: 5000,
    } as {
        enabled: boolean;
        lookupThreshold: number;
        revealMode: 'timed' | 'hover';
        revealDelayMs: number;
    } | null,
    manager: {
        subscribe: vi.fn(),
        getSnapshot: vi.fn(),
        importDictionary: vi.fn(),
        installRecommendedDictionaries: vi.fn(),
        installRecommendedDictionary: vi.fn(),
        checkForUpdates: vi.fn(),
        removeDictionary: vi.fn(),
        setSchedule: vi.fn(),
        setLookupMode: vi.fn(),
        setReaderPreferences: vi.fn(),
        setMiningProfile: vi.fn(),
        setDictionaryEnabled: vi.fn(),
        moveDictionary: vi.fn(),
    },
}));

vi.mock('electron', () => ({
    BrowserWindow: class BrowserWindow {
        static fromWebContents(sender: unknown) {
            return harness.fromWebContents(sender);
        }
    },
    dialog: {
        showMessageBox: harness.showMessageBox,
        showOpenDialog: harness.showOpenDialog,
    },
    ipcMain: {
        handle: vi.fn(
            (channel: string, handler: (...args: any[]) => unknown) => {
                harness.handlers.set(channel, handler);
            }
        ),
    },
}));

vi.mock('./manager.js', () => ({
    getHoshidictsManager: () => harness.manager,
}));

const snapshot = {
    revision: 1,
    dictionaries: [],
    recommendedDictionaries: [
        { id: 'jmdict', installed: false },
        { id: 'jmnedict', installed: false },
    ],
    miningProfile: {
        version: 1,
        enabled: true,
        deck: 'Default',
        model: '',
        fields: {
            expression: '',
            reading: '',
            definition: '',
            sentence: '',
            frequency: '',
            pitch: '',
        },
        disabledFields: [],
        tags: ['hoshidicts'],
        duplicatePolicy: 'prevent',
    },
    lookupMode: 'shift',
    popupHideDelayMs: 300,
    definitionBlur: {
        enabled: false,
        lookupThreshold: 5,
        revealMode: 'timed',
        revealDelayMs: 5000,
    },
    schedule: 'off',
    lastCheck: null,
    nextCheck: null,
    lastError: null,
    busy: false,
    progress: { phase: 'idle' },
} as const;

async function registerHarness() {
    vi.resetModules();
    harness.handlers.clear();
    harness.subscriber = null;
    harness.manager.subscribe.mockImplementation((listener) => {
        harness.subscriber = listener;
        return () => {};
    });
    harness.manager.getSnapshot.mockResolvedValue(snapshot);
    harness.manager.installRecommendedDictionaries.mockResolvedValue(snapshot);
    harness.manager.setLookupMode.mockResolvedValue(snapshot);
    harness.manager.setReaderPreferences.mockResolvedValue(snapshot);

    const settingsContents = { id: 'settings' };
    const mainContents = { id: 'main' };
    const foreignContents = { id: 'foreign' };
    const settingsWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
    };
    const mainWindow = { webContents: mainContents };
    harness.fromWebContents.mockImplementation((sender) => {
        if (sender === settingsContents) return settingsWindow;
        if (sender === mainContents) return mainWindow;
        return null;
    });

    const openSettingsWindow = vi.fn(async () => settingsWindow);
    const restartOverlay = vi.fn(async () => true);
    const applyReaderPreferences = vi.fn(async () => true);
    const getMiningOptions = vi.fn(async () => ({
        connected: true,
        gsmAnkiEnabled: true,
        decks: ['Mining'],
        noteTypes: ['Kiku'],
        selectedNoteType: 'Kiku',
        fields: ['Expression'],
        suggestedFields: {
            expression: 'Expression',
            reading: '',
            definition: '',
            sentence: '',
            frequency: '',
            pitch: '',
        },
        resolvedFields: {
            expression: 'Expression',
            reading: '',
            definition: '',
            sentence: '',
            frequency: '',
            pitch: '',
        },
        warnings: [],
        error: null,
    }));
    const { registerHoshidictsIPC } = await import('./ipc.js');
    registerHoshidictsIPC({
        getMainWindow: () => mainWindow as any,
        getSettingsWindow: () => settingsWindow as any,
        openSettingsWindow: openSettingsWindow as any,
        getOverlayRuntimeState: () => ({
            isRunning: true,
            source: 'manual',
        }),
        getConfiguredFeatureEnabled: () => harness.configuredEnabled,
        getOverlayFeatureEnabledAtLaunch: () => harness.enabledAtLaunch,
        getOverlayLookupModeAtLaunch: () => harness.lookupModeAtLaunch,
        getOverlayPopupHideDelayAtLaunch: () =>
            harness.popupHideDelayAtLaunch,
        getOverlayDefinitionBlurAtLaunch: () =>
            harness.definitionBlurAtLaunch,
        applyReaderPreferences,
        getMiningOptions,
        restartOverlay,
    });

    return {
        foreignContents,
        mainContents,
        openSettingsWindow,
        restartOverlay,
        settingsContents,
        settingsWindow,
        getMiningOptions,
        applyReaderPreferences,
    };
}

describe('Hoshidicts settings IPC', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        harness.configuredEnabled = true;
        harness.enabledAtLaunch = false;
        harness.lookupModeAtLaunch = 'shift';
        harness.popupHideDelayAtLaunch = 300;
        harness.definitionBlurAtLaunch = {
            enabled: false,
            lookupThreshold: 5,
            revealMode: 'timed',
            revealDelayMs: 5000,
        };
    });

    it('requires an overlay restart when the persisted lookup mode changed', async () => {
        harness.enabledAtLaunch = true;
        harness.lookupModeAtLaunch = 'hover';
        const context = await registerHarness();
        const getState = harness.handlers.get('hoshidicts.getState');

        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.lookupModeAtLaunch = 'shift';
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });
    });

    it('requires an overlay restart when definition blur was not applied live', async () => {
        harness.enabledAtLaunch = true;
        harness.definitionBlurAtLaunch = {
            enabled: true,
            lookupThreshold: 5,
            revealMode: 'timed',
            revealDelayMs: 5000,
        };
        const context = await registerHarness();
        const getState = harness.handlers.get('hoshidicts.getState');

        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.definitionBlurAtLaunch = { ...snapshot.definitionBlur };
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });
    });

    it('rejects requests from unrelated renderer windows', async () => {
        const context = await registerHarness();
        const getState = harness.handlers.get('hoshidicts.getState');
        const setSchedule = harness.handlers.get('hoshidicts.setSchedule');
        const openSettings = harness.handlers.get(
            'hoshidicts.openSettings'
        );

        await expect(
            getState?.({ sender: context.foreignContents })
        ).rejects.toThrow('invalid window');
        await expect(
            setSchedule?.(
                { sender: context.foreignContents },
                'daily'
            )
        ).rejects.toThrow('invalid window');
        await expect(
            openSettings?.({ sender: context.settingsContents })
        ).rejects.toThrow('invalid window');
        expect(harness.manager.setSchedule).not.toHaveBeenCalled();
        expect(context.openSettingsWindow).not.toHaveBeenCalled();
    });

    it('serves the standalone window and validates typed actions', async () => {
        const context = await registerHarness();
        const getState = harness.handlers.get('hoshidicts.getState');
        const setDictionaryEnabled = harness.handlers.get(
            'hoshidicts.setDictionaryEnabled'
        );
        const openSettings = harness.handlers.get(
            'hoshidicts.openSettings'
        );
        const restartOverlay = harness.handlers.get(
            'hoshidicts.restartOverlay'
        );

        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            effectiveEnabled: true,
            overlay: {
                running: true,
                restartRequired: true,
            },
        });

        await expect(
            setDictionaryEnabled?.(
                { sender: context.settingsContents },
                { id: 42, enabled: true }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Dictionary enable request is invalid.',
        });
        expect(
            harness.manager.setDictionaryEnabled
        ).not.toHaveBeenCalled();

        expect(harness.handlers.has('hoshidicts.setFeatureEnabled')).toBe(false);

        await expect(
            restartOverlay?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({ success: true });
        expect(context.restartOverlay).toHaveBeenCalledOnce();

        await expect(
            openSettings?.({ sender: context.mainContents })
        ).resolves.toEqual({ success: true });
        expect(context.openSettingsWindow).toHaveBeenCalledOnce();

        harness.subscriber?.(snapshot);
        expect(context.settingsWindow.webContents.send).toHaveBeenCalledWith(
            'hoshidicts.progress',
            expect.objectContaining({
                effectiveEnabled: true,
            })
        );
    });

    it('installs all recommendations, validates lookup mode, and discovers Anki options', async () => {
        const context = await registerHarness();
        const installAll = harness.handlers.get(
            'hoshidicts.installAllRecommended'
        );
        const setLookupMode = harness.handlers.get('hoshidicts.setLookupMode');
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        const getMiningOptions = harness.handlers.get(
            'hoshidicts.getMiningOptions'
        );

        await expect(
            installAll?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({ success: true });
        expect(
            harness.manager.installRecommendedDictionaries
        ).toHaveBeenCalledOnce();

        await expect(
            setLookupMode?.(
                { sender: context.settingsContents },
                'automatic'
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Hoshidicts lookup mode is invalid.',
        });
        expect(harness.manager.setLookupMode).not.toHaveBeenCalled();

        await expect(
            setLookupMode?.({ sender: context.settingsContents }, 'hover')
        ).resolves.toMatchObject({ success: true });
        expect(harness.manager.setLookupMode).toHaveBeenCalledWith('hover');

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'hover',
                    popupHideDelayMs: 850,
                    definitionBlur: {
                        enabled: true,
                        lookupThreshold: 7,
                        revealMode: 'hover',
                        revealDelayMs: 6000,
                    },
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
        });
        expect(harness.manager.setReaderPreferences).toHaveBeenCalledWith({
            lookupMode: 'hover',
            popupHideDelayMs: 850,
            definitionBlur: {
                enabled: true,
                lookupThreshold: 7,
                revealMode: 'hover',
                revealDelayMs: 6000,
            },
        });
        expect(context.applyReaderPreferences).toHaveBeenCalledWith({
            lookupMode: 'hover',
            popupHideDelayMs: 850,
            definitionBlur: {
                enabled: true,
                lookupThreshold: 7,
                revealMode: 'hover',
                revealDelayMs: 6000,
            },
        });

        await expect(
            getMiningOptions?.(
                { sender: context.settingsContents },
                'Kiku'
            )
        ).resolves.toMatchObject({ connected: true, noteTypes: ['Kiku'] });
        expect(context.getMiningOptions).toHaveBeenCalledWith('Kiku');
    });

    it('rejects malformed definition blur reader preferences', async () => {
        const context = await registerHarness();
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        const valid = {
            lookupMode: 'hover',
            popupHideDelayMs: 850,
            definitionBlur: {
                enabled: true,
                lookupThreshold: 5,
                revealMode: 'timed',
                revealDelayMs: 5000,
            },
        };

        for (const definitionBlur of [
            { ...valid.definitionBlur, lookupThreshold: 0 },
            { ...valid.definitionBlur, lookupThreshold: 1_000_001 },
            { ...valid.definitionBlur, revealMode: 'click' },
            { ...valid.definitionBlur, revealDelayMs: 999 },
            { ...valid.definitionBlur, revealDelayMs: 3_600_001 },
        ]) {
            await expect(
                setReaderPreferences?.(
                    { sender: context.settingsContents },
                    { ...valid, definitionBlur }
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Hoshidicts reader preferences are invalid.',
            });
        }
        expect(harness.manager.setReaderPreferences).not.toHaveBeenCalled();
        expect(context.applyReaderPreferences).not.toHaveBeenCalled();
    });
});
