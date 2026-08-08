import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultHoshidictsAudioProfile } from '../../../shared/features/hoshidicts.js';

const harness = vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => any>(),
    fromWebContents: vi.fn(),
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    prepareYomitanDictionaryBackup: vi.fn(),
    prepareYomitanSettingsBackup: vi.fn(),
    subscriber: null as ((snapshot: any) => void) | null,
    configuredEnabled: true,
    enabledAtLaunch: false as boolean | null,
    lookupModeAtLaunch: 'shift' as 'shift' | 'hover' | null,
    activationKeyAtLaunch: 'Shift' as string | null,
    sourceHighlightEnabledAtLaunch: false as boolean | null,
    popupHideDelayAtLaunch: 300 as number | null,
    showLookupCountsAtLaunch: true as boolean | null,
    audioProfileRestartRequired: false,
    popupNestingMaxDepthAtLaunch: 10 as number | null,
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
        importDictionaries: vi.fn(),
        applyYomitanDictionaryPreferences: vi.fn(),
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
        setDictionaryPresentation: vi.fn(),
        moveDictionary: vi.fn(),
        moveDictionaryToPosition: vi.fn(),
        getCustomDictionaryDocument: vi.fn(),
        saveCustomDictionary: vi.fn(),
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

vi.mock('./yomitan_backup.js', () => ({
    prepareYomitanDictionaryBackup: harness.prepareYomitanDictionaryBackup,
    prepareYomitanSettingsBackup: harness.prepareYomitanSettingsBackup,
}));

const snapshot = {
    revision: 1,
    dictionaries: [],
    customDictionaryActive: false,
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
    showLookupCounts: true,
    popupNestingMaxDepth: 10,
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

function definitionDictionary(
    id: string,
    title: string,
    favorite: boolean
) {
    return {
        id,
        title,
        enabled: true,
        favorite,
        revision: 'one',
        isUpdatable: false,
        indexUrl: null,
        downloadUrl: null,
        language: 'ja',
        termCount: 1,
        frequencyCount: 0,
        pitchCount: 0,
        kanjiCount: 0,
        frequencyMode: null,
        installedAt: '2026-08-08T00:00:00.000Z',
    } as const;
}

async function registerHarness() {
    vi.resetModules();
    harness.handlers.clear();
    harness.subscriber = null;
    harness.manager.subscribe.mockImplementation((listener) => {
        harness.subscriber = listener;
        return () => {};
    });
    harness.manager.getSnapshot.mockResolvedValue(snapshot);
    harness.manager.importDictionary.mockResolvedValue(snapshot);
    harness.manager.importDictionaries.mockResolvedValue(snapshot);
    harness.manager.applyYomitanDictionaryPreferences.mockResolvedValue(
        snapshot
    );
    harness.manager.installRecommendedDictionaries.mockResolvedValue(snapshot);
    harness.manager.installRecommendedDictionary.mockResolvedValue(snapshot);
    harness.manager.checkForUpdates.mockResolvedValue(snapshot);
    harness.manager.removeDictionary.mockResolvedValue(snapshot);
    harness.manager.setLookupMode.mockResolvedValue(snapshot);
    harness.manager.setReaderPreferences.mockResolvedValue(snapshot);
    harness.manager.setAudioProfile.mockResolvedValue(snapshot);
    harness.manager.setMiningProfile.mockResolvedValue(snapshot);
    harness.manager.setDictionaryPresentation.mockResolvedValue(snapshot);
    harness.manager.moveDictionary.mockResolvedValue(snapshot);
    harness.manager.moveDictionaryToPosition.mockResolvedValue(snapshot);
    const customDocument = {
        text: '',
        revision: 'empty-revision',
        exists: false,
        filePath: '/tmp/custom-dictionary.txt',
    };
    harness.manager.getCustomDictionaryDocument.mockResolvedValue(
        customDocument
    );
    harness.manager.saveCustomDictionary.mockResolvedValue({
        ...customDocument,
        text: '猫, ねこ, cat\n',
        revision: 'saved-revision',
        exists: true,
    });

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
        getOverlayShowLookupCountsAtLaunch: () =>
            harness.showLookupCountsAtLaunch,
        getOverlayAudioProfileRestartRequired: () =>
            harness.audioProfileRestartRequired,
        getOverlayPopupNestingMaxDepthAtLaunch: () =>
            harness.popupNestingMaxDepthAtLaunch,
        getOverlayDefinitionBlurAtLaunch: () =>
            harness.definitionBlurAtLaunch,
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
        harness.showLookupCountsAtLaunch = true;
        harness.audioProfileRestartRequired = false;
        harness.popupNestingMaxDepthAtLaunch = 10;
        harness.definitionBlurAtLaunch = {
            enabled: false,
            lookupThreshold: 5,
            revealMode: 'timed',
            revealDelayMs: 5000,
        };
    });

    it('selects and imports multiple Yomitan ZIP dictionaries as one batch', async () => {
        const filePaths = [
            '/tmp/jmdict.zip',
            '/tmp/jmnedict.zip',
            '/tmp/kanjidic.zip',
        ];
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths,
        });
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.import')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryImported', count: 3 },
        });
        expect(harness.showOpenDialog).toHaveBeenCalledWith(
            context.settingsWindow,
            expect.objectContaining({
                title: 'Import Hoshidicts Dictionaries',
                properties: ['openFile', 'multiSelections'],
            })
        );
        expect(harness.manager.importDictionaries).toHaveBeenCalledWith(
            filePaths
        );
        expect(harness.manager.importDictionary).not.toHaveBeenCalled();
        expect(context.applyReaderPreferences).toHaveBeenCalledOnce();
    });

    it('imports a selected Yomitan dictionary backup through the existing manager', async () => {
        const cleanup = vi.fn(async () => undefined);
        harness.prepareYomitanDictionaryBackup.mockResolvedValueOnce({
            dictionaries: [
                { title: 'JMdict', archivePath: '/tmp/jmdict.zip' },
            ],
            settings: null,
            cleanup,
        });
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/tmp/yomitan-dictionaries.json'],
        });
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.importYomitanDictionaries')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'yomitanDictionariesImported', count: 1 },
            yomitanReport: { imported: 1, replaced: 0, failed: 0 },
        });
        expect(harness.manager.importDictionary).toHaveBeenCalledWith(
            '/tmp/jmdict.zip'
        );
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('imports a selected Yomitan settings backup without importing dictionaries', async () => {
        const cleanup = vi.fn(async () => undefined);
        harness.prepareYomitanSettingsBackup.mockResolvedValueOnce({
            dictionaries: [],
            settings: {
                profileName: 'Mining',
                dictionaries: [],
                readerPreferences: null,
                miningProfile: snapshot.miningProfile,
                audioProfile: null,
                groups: ['anki'],
                warnings: [],
            },
            cleanup,
        });
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/tmp/yomitan-settings.json'],
        });
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.importYomitanSettings')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'yomitanSettingsImported', count: 1 },
            yomitanReport: { settings: ['anki'] },
        });
        expect(harness.manager.setMiningProfile).toHaveBeenCalledWith(
            snapshot.miningProfile
        );
        expect(harness.manager.importDictionary).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
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

        harness.sourceHighlightEnabledAtLaunch = false;
        harness.showLookupCountsAtLaunch = false;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.showLookupCountsAtLaunch = true;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });
    });

    it('restarts a running overlay when disabling Shift cannot apply live', async () => {
        harness.enabledAtLaunch = true;
        const context = await registerHarness();
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        context.applyReaderPreferences.mockResolvedValueOnce(false);

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'hover',
                    activationKey: 'Shift',
                    sourceHighlightEnabled: false,
                    popupHideDelayMs: 300,
                    showLookupCounts: true,
                    popupNestingMaxDepth: 10,
                    definitionBlur: snapshot.definitionBlur,
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
        });
        expect(context.restartOverlay).toHaveBeenCalledOnce();
    });

    it('restarts when any running reader preference cannot apply live', async () => {
        harness.enabledAtLaunch = true;
        const context = await registerHarness();
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        context.applyReaderPreferences.mockResolvedValueOnce(false);

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'shift',
                    activationKey: 'Shift',
                    sourceHighlightEnabled: true,
                    popupHideDelayMs: 300,
                    showLookupCounts: true,
                    popupNestingMaxDepth: 10,
                    definitionBlur: snapshot.definitionBlur,
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
        });
        expect(context.restartOverlay).toHaveBeenCalledOnce();
    });

    it('keeps preferences saved when an automatic overlay restart fails', async () => {
        harness.enabledAtLaunch = true;
        const context = await registerHarness();
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        context.applyReaderPreferences.mockResolvedValueOnce(false);
        context.restartOverlay.mockResolvedValueOnce(false);
        harness.manager.setReaderPreferences.mockResolvedValueOnce({
            ...snapshot,
            lookupMode: 'hover',
        });

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'hover',
                    activationKey: 'Shift',
                    sourceHighlightEnabled: false,
                    popupHideDelayMs: 300,
                    showLookupCounts: true,
                    popupNestingMaxDepth: 10,
                    definitionBlur: snapshot.definitionBlur,
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
            state: {
                lookupMode: 'hover',
                overlay: { running: true, restartRequired: true },
            },
        });
        expect(context.restartOverlay).toHaveBeenCalledOnce();
    });

    it('requires an overlay restart when the persisted nesting depth changed', async () => {
        harness.enabledAtLaunch = true;
        harness.popupNestingMaxDepthAtLaunch = 4;
        const context = await registerHarness();
        const getState = harness.handlers.get('hoshidicts.getState');

        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.popupNestingMaxDepthAtLaunch = 10;
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

    it('validates, persists, and applies ordered dictionary presentation live', async () => {
        const presentationState = {
            ...snapshot,
            dictionaries: [
                {
                    id: 'alpha',
                    title: 'Alpha',
                    enabled: true,
                    favorite: true,
                    revision: 'one',
                    isUpdatable: false,
                    indexUrl: null,
                    downloadUrl: null,
                    language: 'ja',
                    termCount: 1,
                    frequencyCount: 0,
                    pitchCount: 0,
                    kanjiCount: 0,
                    frequencyMode: null,
                    installedAt: '2026-08-08T00:00:00.000Z',
                },
                {
                    id: 'frequency',
                    title: 'Frequency only',
                    enabled: true,
                    favorite: true,
                    revision: 'one',
                    isUpdatable: false,
                    indexUrl: null,
                    downloadUrl: null,
                    language: 'ja',
                    termCount: 0,
                    frequencyCount: 1,
                    pitchCount: 0,
                    kanjiCount: 0,
                    frequencyMode: 'rank-based',
                    installedAt: '2026-08-08T00:00:00.000Z',
                },
            ],
        } as const;
        harness.manager.setDictionaryPresentation.mockResolvedValueOnce(
            presentationState
        );
        const context = await registerHarness();
        const setPresentation = harness.handlers.get(
            'hoshidicts.setDictionaryPresentation'
        );
        const moveDictionary = harness.handlers.get(
            'hoshidicts.moveDictionary'
        );

        await expect(
            setPresentation?.(
                { sender: context.settingsContents },
                { id: 'alpha', favorite: true }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
        });
        expect(harness.manager.setDictionaryPresentation).toHaveBeenCalledWith(
            'alpha',
            true
        );
        expect(context.applyReaderPreferences).toHaveBeenCalledWith(
            expect.objectContaining({
                dictionaryPresentation: [
                    {
                        title: 'Alpha',
                        favorite: true,
                    },
                ],
            })
        );

        await expect(
            setPresentation?.(
                { sender: context.settingsContents },
                { id: 'alpha', favorite: 'yes' }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Dictionary presentation request is invalid.',
        });
        expect(harness.manager.setDictionaryPresentation).toHaveBeenCalledOnce();

        harness.manager.moveDictionary.mockResolvedValueOnce(presentationState);
        context.applyReaderPreferences.mockResolvedValueOnce(false);
        await expect(
            moveDictionary?.(
                { sender: context.settingsContents },
                { id: 'alpha', direction: 1 }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
        });
        expect(harness.manager.moveDictionary).toHaveBeenCalledWith('alpha', 1);
        expect(context.applyReaderPreferences).toHaveBeenLastCalledWith(
            expect.objectContaining({
                dictionaryPresentation: expect.any(Array),
            })
        );
        expect(context.restartOverlay).toHaveBeenCalledOnce();

        const moveDictionaryToPosition = harness.handlers.get(
            'hoshidicts.moveDictionaryToPosition'
        );
        harness.manager.moveDictionaryToPosition.mockResolvedValueOnce(
            presentationState
        );
        await expect(
            moveDictionaryToPosition?.(
                { sender: context.settingsContents },
                { id: 'alpha', position: 3 }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
        });
        expect(
            harness.manager.moveDictionaryToPosition
        ).toHaveBeenCalledWith('alpha', 3);

        await expect(
            moveDictionaryToPosition?.(
                { sender: context.settingsContents },
                { id: 'alpha', position: 0 }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Dictionary position request is invalid.',
        });
        expect(
            harness.manager.moveDictionaryToPosition
        ).toHaveBeenCalledOnce();
    });

    it('refreshes live presentation after every dictionary collection mutation', async () => {
        const primary = definitionDictionary('primary', 'Primary', true);
        const backup = definitionDictionary('backup', 'Backup', false);
        const initialState = {
            ...snapshot,
            dictionaries: [primary, backup],
        } as const;
        const renamedState = {
            ...snapshot,
            dictionaries: [
                { ...primary, title: 'Primary 2026' },
                backup,
            ],
        } as const;
        const removedAnchorState = {
            ...snapshot,
            dictionaries: [backup],
        } as const;
        const context = await registerHarness();
        harness.manager.getSnapshot.mockResolvedValue(initialState);
        harness.manager.importDictionaries.mockResolvedValueOnce(initialState);
        harness.manager.installRecommendedDictionaries.mockResolvedValueOnce(
            initialState
        );
        harness.manager.installRecommendedDictionary.mockResolvedValueOnce(
            initialState
        );
        harness.manager.checkForUpdates.mockResolvedValueOnce(renamedState);
        harness.manager.removeDictionary.mockResolvedValueOnce(
            removedAnchorState
        );
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/tmp/import.zip'],
        });
        harness.showMessageBox.mockResolvedValueOnce({ response: 0 });

        const settingsEvent = { sender: context.settingsContents };
        await expect(
            harness.handlers.get('hoshidicts.import')?.(settingsEvent)
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryImported' },
        });
        await expect(
            harness.handlers.get('hoshidicts.installAllRecommended')?.(
                settingsEvent
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'recommendedInstalled' },
        });
        await expect(
            harness.handlers.get('hoshidicts.installRecommended')?.(
                settingsEvent,
                { id: 'jitendex' }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'recommendedInstalled', count: 1 },
        });
        await expect(
            harness.handlers.get('hoshidicts.checkUpdates')?.(settingsEvent)
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'updatesChecked' },
        });
        await expect(
            harness.handlers.get('hoshidicts.remove')?.(
                settingsEvent,
                primary.id
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: {
                code: 'dictionaryRemoved',
                title: primary.title,
            },
        });

        expect(harness.manager.importDictionaries).toHaveBeenCalledOnce();
        expect(
            harness.manager.installRecommendedDictionaries
        ).toHaveBeenCalledOnce();
        expect(
            harness.manager.installRecommendedDictionary
        ).toHaveBeenCalledOnce();
        expect(harness.manager.checkForUpdates).toHaveBeenCalledOnce();
        expect(harness.manager.removeDictionary).toHaveBeenCalledOnce();
        expect(context.applyReaderPreferences).toHaveBeenCalledTimes(5);
        expect(context.applyReaderPreferences.mock.calls[3]?.[0]).toMatchObject({
            dictionaryPresentation: [
                expect.objectContaining({ title: 'Primary 2026' }),
                expect.objectContaining({ title: 'Backup' }),
            ],
        });
        expect(context.applyReaderPreferences).toHaveBeenLastCalledWith(
            expect.objectContaining({
                dictionaryPresentation: [
                    {
                        title: 'Backup',
                        favorite: false,
                    },
                ],
            })
        );
    });

    it('reports when a saved dictionary mutation cannot refresh the running overlay', async () => {
        const primary = definitionDictionary('primary', 'Primary', true);
        const backup = definitionDictionary('backup', 'Backup', false);
        const initialState = {
            ...snapshot,
            dictionaries: [primary, backup],
        } as const;
        const removedAnchorState = {
            ...snapshot,
            dictionaries: [backup],
        } as const;
        const context = await registerHarness();
        harness.manager.getSnapshot
            .mockResolvedValueOnce(initialState)
            .mockResolvedValue(removedAnchorState);
        harness.manager.removeDictionary.mockResolvedValueOnce(
            removedAnchorState
        );
        harness.showMessageBox.mockResolvedValueOnce({ response: 0 });
        context.applyReaderPreferences.mockResolvedValueOnce(false);
        context.restartOverlay.mockResolvedValueOnce(false);

        await expect(
            harness.handlers.get('hoshidicts.remove')?.(
                { sender: context.settingsContents },
                primary.id
            )
        ).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining(
                'changes were saved, but could not be applied'
            ),
            state: { dictionaries: [backup] },
        });
        expect(harness.manager.removeDictionary).toHaveBeenCalledOnce();
        expect(context.applyReaderPreferences).toHaveBeenCalledOnce();
        expect(context.restartOverlay).toHaveBeenCalledOnce();
    });

    it('publishes partially successful update changes before reporting a later failure', async () => {
        const updated = definitionDictionary('primary', 'Primary 2026', true);
        const partialUpdateState = {
            ...snapshot,
            dictionaries: [updated],
            lastError: 'Backup dictionary update failed.',
        } as const;
        const context = await registerHarness();
        harness.manager.checkForUpdates.mockResolvedValueOnce(
            partialUpdateState
        );

        await expect(
            harness.handlers.get('hoshidicts.checkUpdates')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: false,
            error: 'Backup dictionary update failed.',
        });
        expect(context.applyReaderPreferences).toHaveBeenCalledWith(
            expect.objectContaining({
                dictionaryPresentation: [
                    {
                        title: 'Primary 2026',
                        favorite: true,
                    },
                ],
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
                    showLookupCounts: 'yes',
                    popupNestingMaxDepth: 4,
                    definitionBlur: snapshot.definitionBlur,
                }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Hoshidicts reader preferences are invalid.',
        });
        expect(harness.manager.setReaderPreferences).not.toHaveBeenCalled();

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'hover',
                    activationKey: 'F8',
                    sourceHighlightEnabled: true,
                    popupHideDelayMs: 850,
                    showLookupCounts: false,
                    popupNestingMaxDepth: 4,
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
        expect(harness.manager.setReaderPreferences).toHaveBeenCalledWith(
            'hover',
            850,
            'F8',
            true,
            4,
            {
                enabled: true,
                lookupThreshold: 7,
                revealMode: 'hover',
                revealDelayMs: 6000,
            },
            false
        );
        expect(context.applyReaderPreferences).toHaveBeenCalledWith({
            lookupMode: 'hover',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupHideDelayMs: 850,
            showLookupCounts: false,
            popupNestingMaxDepth: 4,
            definitionBlur: {
                enabled: true,
                lookupThreshold: 7,
                revealMode: 'hover',
                revealDelayMs: 6000,
            },
            dictionaryPresentation: [],
        });

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'hover',
                    popupHideDelayMs: 850,
                    popupNestingMaxDepth: Number.MAX_SAFE_INTEGER + 1,
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

    it('loads and explicitly saves the managed custom dictionary document', async () => {
        const context = await registerHarness();
        const getCustom = harness.handlers.get(
            'hoshidicts.getCustomDictionary'
        );
        const saveCustom = harness.handlers.get(
            'hoshidicts.saveCustomDictionary'
        );

        await expect(
            getCustom?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            revision: 'empty-revision',
            exists: false,
        });
        await expect(
            getCustom?.({ sender: context.foreignContents })
        ).rejects.toThrow('invalid window');

        await expect(
            saveCustom?.(
                { sender: context.settingsContents },
                {
                    text: '猫, ねこ, cat\n',
                    expectedRevision: 'empty-revision',
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'customDictionarySaved' },
            document: { exists: true, text: '猫, ねこ, cat\n' },
        });
        expect(harness.manager.saveCustomDictionary).toHaveBeenCalledWith(
            '猫, ねこ, cat\n',
            'empty-revision'
        );

        await expect(
            saveCustom?.(
                { sender: context.settingsContents },
                { text: '猫, ねこ, cat', expectedRevision: 42 }
            )
        ).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('invalid'),
        });
    });

    it('rejects malformed definition blur reader preferences', async () => {
        const context = await registerHarness();
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        const valid = {
            lookupMode: 'hover',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupHideDelayMs: 850,
            showLookupCounts: true,
            popupNestingMaxDepth: 4,
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
