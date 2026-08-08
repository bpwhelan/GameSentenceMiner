import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultHoshidictsAudioProfile } from '../../../shared/features/hoshidicts.js';

const harness = vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => any>(),
    fromWebContents: vi.fn(),
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    subscriber: null as ((snapshot: any) => void) | null,
    configuredEnabled: true,
    enabledAtLaunch: false as boolean | null,
    lookupModeAtLaunch: 'shift' as 'shift' | 'hover' | null,
    activationKeyAtLaunch: 'Shift' as string | null,
    sourceHighlightEnabledAtLaunch: false as boolean | null,
    popupHideDelayAtLaunch: 300 as number | null,
    audioProfileRestartRequired: false,
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
        setAudioProfile: vi.fn(),
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
        { id: 'jitendex', installed: false },
        { id: 'jmdict', installed: false },
        { id: 'jmnedict', installed: false },
        { id: 'bccwj', installed: false },
        { id: 'jpdbv2-kana', installed: false },
        { id: 'jiten', installed: false },
        { id: 'kanjium-pitch', installed: false },
        { id: 'kanjidic', installed: false },
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
            audio: '',
        },
        disabledFields: [],
        tags: ['hoshidicts'],
        duplicatePolicy: 'prevent',
    },
    audioProfile: createDefaultHoshidictsAudioProfile(),
    lookupMode: 'shift',
    activationKey: 'Shift',
    sourceHighlightEnabled: false,
    popupHideDelayMs: 300,
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
    harness.manager.installRecommendedDictionary.mockResolvedValue(snapshot);
    harness.manager.setLookupMode.mockResolvedValue(snapshot);
    harness.manager.setReaderPreferences.mockResolvedValue(snapshot);
    harness.manager.setAudioProfile.mockResolvedValue(snapshot);

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
    const applyAudioProfile = vi.fn(async () => true);
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
            audio: '',
        },
        resolvedFields: {
            expression: 'Expression',
            reading: '',
            definition: '',
            sentence: '',
            frequency: '',
            pitch: '',
            audio: '',
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
        getOverlayActivationKeyAtLaunch: () =>
            harness.activationKeyAtLaunch,
        getOverlaySourceHighlightEnabledAtLaunch: () =>
            harness.sourceHighlightEnabledAtLaunch,
        getOverlayPopupHideDelayAtLaunch: () =>
            harness.popupHideDelayAtLaunch,
        getOverlayAudioProfileRestartRequired: () =>
            harness.audioProfileRestartRequired,
        applyReaderPreferences,
        applyAudioProfile,
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
        applyAudioProfile,
    };
}

describe('Hoshidicts settings IPC', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        harness.configuredEnabled = true;
        harness.enabledAtLaunch = false;
        harness.lookupModeAtLaunch = 'shift';
        harness.activationKeyAtLaunch = 'Shift';
        harness.sourceHighlightEnabledAtLaunch = false;
        harness.popupHideDelayAtLaunch = 300;
        harness.audioProfileRestartRequired = false;
    });

    it('saves audio profiles, applies them live, and exposes failed sync restart state', async () => {
        harness.enabledAtLaunch = true;
        const context = await registerHarness();
        const setAudioProfile = harness.handlers.get(
            'hoshidicts.setAudioProfile'
        );
        const getState = harness.handlers.get('hoshidicts.getState');

        await expect(
            setAudioProfile?.(
                { sender: context.settingsContents },
                snapshot.audioProfile
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'audioProfileSaved' },
        });
        expect(harness.manager.setAudioProfile).toHaveBeenCalledWith(
            snapshot.audioProfile
        );
        expect(context.applyAudioProfile).toHaveBeenCalledWith(
            snapshot.audioProfile
        );

        harness.audioProfileRestartRequired = true;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });
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

        harness.activationKeyAtLaunch = 'F8';
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.activationKeyAtLaunch = 'Shift';
        harness.sourceHighlightEnabledAtLaunch = true;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
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
                    activationKey: 'F8',
                    sourceHighlightEnabled: true,
                    popupHideDelayMs: 850,
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
        });
        expect(harness.manager.setReaderPreferences).toHaveBeenCalledWith(
            'hover',
            850,
            'F8',
            true
        );
        expect(context.applyReaderPreferences).toHaveBeenCalledWith({
            lookupMode: 'hover',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupHideDelayMs: 850,
        });

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'shift',
                    activationKey: 'MediaPlayPause',
                    sourceHighlightEnabled: false,
                    popupHideDelayMs: 300,
                }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Hoshidicts reader preferences are invalid.',
        });

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'shift',
                    activationKey: 'Shift',
                    sourceHighlightEnabled: 'yes',
                    popupHideDelayMs: 300,
                }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Hoshidicts reader preferences are invalid.',
        });

        await expect(
            getMiningOptions?.(
                { sender: context.settingsContents },
                'Kiku'
            )
        ).resolves.toMatchObject({ connected: true, noteTypes: ['Kiku'] });
        expect(context.getMiningOptions).toHaveBeenCalledWith('Kiku');
    });

    it('accepts every curated recommendation id and rejects unknown ids', async () => {
        const context = await registerHarness();
        const installRecommended = harness.handlers.get(
            'hoshidicts.installRecommended'
        );
        const ids = [
            'jitendex',
            'jmdict',
            'jmnedict',
            'bccwj',
            'jpdbv2-kana',
            'jiten',
            'kanjium-pitch',
            'kanjidic',
        ];

        for (const id of ids) {
            await expect(
                installRecommended?.(
                    { sender: context.settingsContents },
                    { id }
                )
            ).resolves.toMatchObject({ success: true });
        }
        expect(
            harness.manager.installRecommendedDictionary.mock.calls.map(
                ([id]) => id
            )
        ).toEqual(ids);

        await expect(
            installRecommended?.(
                { sender: context.settingsContents },
                { id: 'unknown' }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Recommended dictionary id is invalid.',
        });
    });
});
