import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createDefaultHoshidictsAudioProfile,
    createDefaultHoshidictsFieldOverwriteModes,
    createDefaultHoshidictsPopupButtons,
    HOSHIDICTS_CHANNELS,
    type HoshidictsTheme,
} from '../../../shared/features/hoshidicts.js';

const harness = vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => any>(),
    fromWebContents: vi.fn(),
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    prepareYomitanDictionaryBackup: vi.fn(),
    prepareYomitanSettingsBackup: vi.fn(),
    testAudioSource: vi.fn(),
    subscriber: null as ((snapshot: any) => void) | null,
    configuredEnabled: true,
    enabledAtLaunch: false as boolean | null,
    lookupModeAtLaunch: 'shift' as 'shift' | 'hover' | null,
    lookupControlsAtLaunch: {
        scanLength: 16,
        maxResults: 32,
        sortFrequencyDictionary: null as string | null,
        sortFrequencyDictionaryOrder: 'descending' as
            | 'ascending'
            | 'descending',
    } as {
        scanLength: number;
        maxResults: number;
        sortFrequencyDictionary: string | null;
        sortFrequencyDictionaryOrder: 'ascending' | 'descending';
    } | null,
    activationKeyAtLaunch: 'Shift' as string | null,
    sourceHighlightEnabledAtLaunch: false as boolean | null,
    onlyScanJapaneseTextAtLaunch: true as boolean | null,
    popupHideDelayAtLaunch: 300 as number | null,
    showLookupCountsAtLaunch: true as boolean | null,
    showCompactDefinitionSummaryAtLaunch: false as boolean | null,
    compactDefinitionSummaryCountAtLaunch: 3 as number | null,
    compactDefinitionSummaryDictionaryAtLaunch: null as string | null,
    showPitchAccentFuriganaAtLaunch: true as boolean | null,
    pitchAccentFuriganaDictionaryAtLaunch: null as string | null,
    showPitchAccentBadgeAtLaunch: false as boolean | null,
    hidePopupGrammarTagsAtLaunch: true as boolean | null,
    audioProfileRestartRequired: false,
    popupNestingMaxDepthAtLaunch: 10 as number | null,
    popupWidthAtLaunch: 560 as number | null,
    popupHeightAtLaunch: 420 as number | null,
    popupColumnsAtLaunch: 1 as number | null,
    themeAtLaunch: 'default' as HoshidictsTheme | null,
    popupOpacityPercentAtLaunch: 85 as number | null,
    popupToolbarPositionAtLaunch: 'top' as 'top' | 'bottom' | null,
    popupButtonsApplied: {
        addToAnki: true,
        audio: true,
        customDefinition: true,
        viewInAnki: false,
        customLinks: [] as Array<{ label: string; url: string }>,
    },
    customPopupCssApplied: '',
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
        exportBackup: vi.fn(),
        restoreBackup: vi.fn(),
        applyYomitanDictionaryPreferences: vi.fn(),
        installRecommendedDictionaries: vi.fn(),
        installRecommendedDictionary: vi.fn(),
        checkForUpdates: vi.fn(),
        removeDictionary: vi.fn(),
        setSchedule: vi.fn(),
        setDictionarySchedule: vi.fn(),
        setLookupMode: vi.fn(),
        setReaderPreferences: vi.fn(),
        setMiningProfile: vi.fn(),
        setAudioProfile: vi.fn(),
        createProfile: vi.fn(),
        switchProfile: vi.fn(),
        renameProfile: vi.fn(),
        deleteProfile: vi.fn(),
        setDictionaryEnabled: vi.fn(),
        setDictionariesEnabled: vi.fn(),
        setDictionaryPresentation: vi.fn(),
        setDictionariesPresentation: vi.fn(),
        createTabGroup: vi.fn(),
        setTabGroupMembership: vi.fn(),
        renameTabGroup: vi.fn(),
        deleteTabGroup: vi.fn(),
        moveTabGroup: vi.fn(),
        renameDictionary: vi.fn(),
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
        showSaveDialog: harness.showSaveDialog,
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

vi.mock('./audio_source_test.js', () => ({
    fetchHoshidictsAudioSourceTest: harness.testAudioSource,
}));

const snapshot = {
    revision: 1,
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: 'Default' }],
    dictionaries: [],
    tabGroups: [],
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
        version: 3,
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
        checkForDuplicates: true,
        duplicateScope: 'collection',
        duplicateScopeCheckAllModels: false,
        duplicateBehavior: 'prevent',
        fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes(),
        fieldTemplates: null,
    },
    audioProfile: createDefaultHoshidictsAudioProfile(),
    lookupMode: 'shift',
    scanLength: 16,
    maxResults: 32,
    sortFrequencyDictionary: null,
    sortFrequencyDictionaryOrder: 'descending',
    activationKey: 'Shift',
    sourceHighlightEnabled: false,
    onlyScanJapaneseText: true,
    popupHideDelayMs: 300,
    showLookupCounts: true,
    showCompactDefinitionSummary: false,
    compactDefinitionSummaryCount: 3,
    compactDefinitionSummaryDictionary: null,
    showPitchAccentFurigana: true,
    pitchAccentFuriganaDictionary: null,
    showPitchAccentBadge: false,
    hidePopupGrammarTags: true,
    popupNestingMaxDepth: 10,
    popupWidthPx: 560,
    popupHeightPx: 420,
    popupColumns: 1,
    theme: 'default',
    popupOpacityPercent: 85,
    popupToolbarPosition: 'top',
    popupButtons: createDefaultHoshidictsPopupButtons(),
    customPopupCss: '',
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
    harness.manager.exportBackup.mockResolvedValue(undefined);
    harness.manager.restoreBackup.mockResolvedValue(snapshot);
    harness.manager.applyYomitanDictionaryPreferences.mockResolvedValue(
        snapshot
    );
    harness.manager.installRecommendedDictionaries.mockResolvedValue(snapshot);
    harness.manager.installRecommendedDictionary.mockResolvedValue(snapshot);
    harness.manager.checkForUpdates.mockResolvedValue(snapshot);
    harness.manager.removeDictionary.mockResolvedValue(snapshot);
    harness.manager.setSchedule.mockResolvedValue(snapshot);
    harness.manager.setDictionarySchedule.mockResolvedValue(snapshot);
    harness.manager.setLookupMode.mockResolvedValue(snapshot);
    harness.manager.setReaderPreferences.mockResolvedValue(snapshot);
    harness.manager.setAudioProfile.mockResolvedValue(snapshot);
    harness.manager.createProfile.mockResolvedValue(snapshot);
    harness.manager.switchProfile.mockResolvedValue(snapshot);
    harness.manager.renameProfile.mockResolvedValue(snapshot);
    harness.manager.deleteProfile.mockResolvedValue(snapshot);
    harness.testAudioSource.mockResolvedValue({
        bytes: Uint8Array.from([1, 2, 3]),
        contentType: 'audio/mpeg',
        candidateName: 'kiku',
    });
    harness.manager.setMiningProfile.mockResolvedValue(snapshot);
    harness.manager.setDictionariesEnabled.mockResolvedValue(snapshot);
    harness.manager.setDictionaryPresentation.mockResolvedValue(snapshot);
    harness.manager.setDictionariesPresentation.mockResolvedValue(snapshot);
    harness.manager.createTabGroup.mockResolvedValue(snapshot);
    harness.manager.setTabGroupMembership.mockResolvedValue(snapshot);
    harness.manager.renameTabGroup.mockResolvedValue(snapshot);
    harness.manager.deleteTabGroup.mockResolvedValue(snapshot);
    harness.manager.moveTabGroup.mockResolvedValue(snapshot);
    harness.manager.renameDictionary.mockResolvedValue(snapshot);
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
        suggestedFieldTemplates: { Expression: '{expression}' },
        resolvedFieldTemplates: {
            Expression: {
                value: '{expression}',
                overwriteMode: 'coalesce' as const,
            },
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
        getOverlayLookupControlsAtLaunch: () =>
            harness.lookupControlsAtLaunch,
        getOverlayActivationKeyAtLaunch: () =>
            harness.activationKeyAtLaunch,
        getOverlaySourceHighlightEnabledAtLaunch: () =>
            harness.sourceHighlightEnabledAtLaunch,
        getOverlayOnlyScanJapaneseTextAtLaunch: () =>
            harness.onlyScanJapaneseTextAtLaunch,
        getOverlayPopupHideDelayAtLaunch: () =>
            harness.popupHideDelayAtLaunch,
        getOverlayShowLookupCountsAtLaunch: () =>
            harness.showLookupCountsAtLaunch,
        getOverlayShowCompactDefinitionSummaryAtLaunch: () =>
            harness.showCompactDefinitionSummaryAtLaunch,
        getOverlayCompactDefinitionSummaryCountAtLaunch: () =>
            harness.compactDefinitionSummaryCountAtLaunch,
        getOverlayCompactDefinitionSummaryDictionaryAtLaunch: () =>
            harness.compactDefinitionSummaryDictionaryAtLaunch,
        getOverlayShowPitchAccentFuriganaAtLaunch: () =>
            harness.showPitchAccentFuriganaAtLaunch,
        getOverlayPitchAccentFuriganaDictionaryAtLaunch: () =>
            harness.pitchAccentFuriganaDictionaryAtLaunch,
        getOverlayShowPitchAccentBadgeAtLaunch: () =>
            harness.showPitchAccentBadgeAtLaunch,
        getOverlayHidePopupGrammarTagsAtLaunch: () =>
            harness.hidePopupGrammarTagsAtLaunch,
        getOverlayAudioProfileRestartRequired: () =>
            harness.audioProfileRestartRequired,
        getOverlayPopupNestingMaxDepthAtLaunch: () =>
            harness.popupNestingMaxDepthAtLaunch,
        getOverlayDefinitionBlurAtLaunch: () =>
            harness.definitionBlurAtLaunch,
        getOverlayPopupWidthAtLaunch: () => harness.popupWidthAtLaunch,
        getOverlayPopupHeightAtLaunch: () => harness.popupHeightAtLaunch,
        getOverlayPopupColumnsAtLaunch: () =>
            harness.popupColumnsAtLaunch,
        getOverlayThemeAtLaunch: () => harness.themeAtLaunch,
        getOverlayPopupOpacityPercentAtLaunch: () =>
            harness.popupOpacityPercentAtLaunch,
        getOverlayPopupToolbarPositionAtLaunch: () =>
            harness.popupToolbarPositionAtLaunch,
        getOverlayPopupButtonsApplied: () =>
            harness.popupButtonsApplied,
        getOverlayCustomPopupCssApplied: () =>
            harness.customPopupCssApplied,
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
        harness.lookupControlsAtLaunch = {
            scanLength: 16,
            maxResults: 32,
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'descending',
        };
        harness.activationKeyAtLaunch = 'Shift';
        harness.sourceHighlightEnabledAtLaunch = false;
        harness.onlyScanJapaneseTextAtLaunch = true;
        harness.popupHideDelayAtLaunch = 300;
        harness.showLookupCountsAtLaunch = true;
        harness.showCompactDefinitionSummaryAtLaunch = false;
        harness.compactDefinitionSummaryCountAtLaunch = 3;
        harness.compactDefinitionSummaryDictionaryAtLaunch = null;
        harness.showPitchAccentFuriganaAtLaunch = true;
        harness.pitchAccentFuriganaDictionaryAtLaunch = null;
        harness.showPitchAccentBadgeAtLaunch = false;
        harness.hidePopupGrammarTagsAtLaunch = true;
        harness.audioProfileRestartRequired = false;
        harness.popupNestingMaxDepthAtLaunch = 10;
        harness.popupWidthAtLaunch = 560;
        harness.popupHeightAtLaunch = 420;
        harness.popupColumnsAtLaunch = 1;
        harness.themeAtLaunch = 'default';
        harness.popupOpacityPercentAtLaunch = 85;
        harness.popupToolbarPositionAtLaunch = 'top';
        harness.popupButtonsApplied = createDefaultHoshidictsPopupButtons();
        harness.customPopupCssApplied = '';
        harness.definitionBlurAtLaunch = {
            enabled: false,
            lookupThreshold: 5,
            revealMode: 'timed',
            revealDelayMs: 5000,
        };
    });

    it('validates profile requests and applies switched profiles live', async () => {
        const context = await registerHarness();
        const switched = {
            ...snapshot,
            revision: 2,
            activeProfileId: 'persona',
            profiles: [
                { id: 'default', name: 'Default' },
                { id: 'persona', name: 'Persona' },
            ],
            lookupMode: 'hover' as const,
            audioProfile: {
                ...snapshot.audioProfile,
                volume: 25,
            },
        };
        harness.manager.createProfile.mockResolvedValueOnce(switched);
        harness.manager.switchProfile.mockResolvedValueOnce(switched);

        await expect(
            harness.handlers.get(HOSHIDICTS_CHANNELS.createProfile)?.(
                { sender: context.settingsContents },
                { name: 'Persona' },
            ),
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'profileCreated' },
        });
        expect(harness.manager.createProfile).toHaveBeenCalledWith('Persona');

        await expect(
            harness.handlers.get(HOSHIDICTS_CHANNELS.switchProfile)?.(
                { sender: context.settingsContents },
                { id: 'persona' },
            ),
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'profileSwitched' },
            state: { activeProfileId: 'persona' },
        });
        expect(harness.manager.switchProfile).toHaveBeenCalledWith('persona');
        expect(context.applyReaderPreferences).toHaveBeenCalledOnce();
        expect(context.applyAudioProfile).toHaveBeenCalledWith(
            switched.audioProfile,
        );

        await expect(
            harness.handlers.get(HOSHIDICTS_CHANNELS.createProfile)?.(
                { sender: context.settingsContents },
                { name: '   ' },
            ),
        ).resolves.toMatchObject({
            success: false,
            error: 'Profile name is invalid.',
        });
        expect(harness.manager.createProfile).toHaveBeenCalledOnce();
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
        harness.prepareYomitanDictionaryBackup.mockImplementationOnce(
            async (
                _filePath,
                onProgress,
                onPreparedDictionary,
                onReadingProgress
            ) => {
                onReadingProgress?.({
                    completedBytes: 100,
                    totalBytes: 400,
                    estimatedSecondsRemaining: 18,
                });
                onProgress?.({ current: 1, total: 1, title: 'JMdict' });
                await onPreparedDictionary?.({
                    title: 'JMdict',
                    archivePath: '/tmp/jmdict.zip',
                    current: 1,
                    total: 1,
                });
                return {
                    dictionaries: [],
                    settings: null,
                    cleanup,
                };
            }
        );
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
        expect(
            context.settingsWindow.webContents.send.mock.calls
                .filter(
                    ([channel]) =>
                        channel === HOSHIDICTS_CHANNELS.yomitanImportProgress
                )
                .map(([, progress]) => progress)
        ).toEqual([
            {
                phase: 'reading',
                completedBytes: 100,
                totalBytes: 400,
                estimatedSecondsRemaining: 18,
            },
            {
                phase: 'preparing',
                current: 1,
                total: 1,
                title: 'JMdict',
            },
            {
                phase: 'importing',
                current: 1,
                total: 1,
                title: 'JMdict',
            },
            null,
        ]);
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('advances Yomitan progress after a failed dictionary and imports the rest', async () => {
        const cleanup = vi.fn(async () => undefined);
        harness.prepareYomitanDictionaryBackup.mockImplementationOnce(
            async (_filePath, _onProgress, onPreparedDictionary) => {
                await onPreparedDictionary?.({
                    title: 'Broken',
                    archivePath: '/tmp/broken.zip',
                    current: 1,
                    total: 2,
                });
                await onPreparedDictionary?.({
                    title: 'JMdict',
                    archivePath: '/tmp/jmdict.zip',
                    current: 2,
                    total: 2,
                });
                return {
                    dictionaries: [],
                    settings: null,
                    cleanup,
                };
            }
        );
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/tmp/yomitan-dictionaries.json'],
        });
        harness.manager.importDictionary.mockRejectedValueOnce(
            new Error('broken dictionary')
        );
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.importYomitanDictionaries')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: true,
            yomitanReport: { imported: 1, replaced: 0, failed: 1 },
        });
        expect(
            context.settingsWindow.webContents.send.mock.calls
                .filter(
                    ([channel]) =>
                        channel === HOSHIDICTS_CHANNELS.yomitanImportProgress
                )
                .map(([, progress]) => progress)
        ).toEqual([
            {
                phase: 'importing',
                current: 1,
                total: 2,
                title: 'Broken',
            },
            {
                phase: 'importing',
                current: 2,
                total: 2,
                title: 'JMdict',
            },
            null,
        ]);
        expect(harness.manager.importDictionary).toHaveBeenCalledTimes(2);
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('imports Yomitan settings and applies local audio server sources live', async () => {
        const cleanup = vi.fn(async () => undefined);
        const localAudioProfile = {
            version: 1 as const,
            enabled: true,
            autoPlay: false,
            volume: 100,
            sources: [
                {
                    id: 'custom-json-1',
                    type: 'custom-json' as const,
                    url: 'http://127.0.0.1:5050/?term={term}&reading={reading}',
                    voice: '',
                },
            ],
        };
        harness.prepareYomitanSettingsBackup.mockResolvedValueOnce({
            dictionaries: [],
            settings: {
                profileName: 'Mining',
                dictionaries: [],
                readerPreferences: null,
                miningProfile: snapshot.miningProfile,
                audioProfile: localAudioProfile,
                groups: ['anki', 'audio'],
                warnings: [],
            },
            cleanup,
        });
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/tmp/yomitan-settings.json'],
        });
        harness.manager.setAudioProfile.mockImplementationOnce(
            async (profile) => ({ ...snapshot, audioProfile: profile })
        );
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.importYomitanSettings')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'yomitanSettingsImported', count: 2 },
            yomitanReport: { settings: ['anki', 'audio'] },
        });
        expect(harness.manager.setMiningProfile).toHaveBeenCalledWith(
            snapshot.miningProfile
        );
        expect(harness.manager.setAudioProfile).toHaveBeenCalledWith(
            localAudioProfile
        );
        expect(context.applyAudioProfile).toHaveBeenCalledWith(
            localAudioProfile
        );
        expect(harness.manager.importDictionary).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('exports a complete Hoshidicts backup with a ZIP save dialog', async () => {
        harness.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/hoshidicts-backup',
        });
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.exportBackup')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'backupExported' },
        });
        expect(harness.showSaveDialog).toHaveBeenCalledWith(
            context.settingsWindow,
            expect.objectContaining({
                title: 'Export Hoshidicts Backup',
                defaultPath: expect.stringMatching(
                    /^hoshidicts-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/u
                ),
                filters: [
                    {
                        name: 'Hoshidicts Backup',
                        extensions: ['zip'],
                    },
                ],
            })
        );
        expect(harness.manager.exportBackup).toHaveBeenCalledWith(
            '/tmp/hoshidicts-backup.zip'
        );
    });

    it('returns a canceled action when backup export or restore is canceled', async () => {
        harness.showSaveDialog.mockResolvedValueOnce({
            canceled: true,
            filePath: undefined,
        });
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/tmp/hoshidicts-backup.zip'],
        });
        harness.showMessageBox.mockResolvedValueOnce({ response: 1 });
        const context = await registerHarness();
        const settingsEvent = { sender: context.settingsContents };

        await expect(
            harness.handlers.get('hoshidicts.exportBackup')?.(settingsEvent)
        ).resolves.toMatchObject({ success: false, canceled: true });
        await expect(
            harness.handlers.get('hoshidicts.restoreBackup')?.(settingsEvent)
        ).resolves.toMatchObject({ success: false, canceled: true });
        expect(harness.manager.exportBackup).not.toHaveBeenCalled();
        expect(harness.manager.restoreBackup).not.toHaveBeenCalled();
        expect(harness.showMessageBox).toHaveBeenCalledWith(
            context.settingsWindow,
            expect.objectContaining({
                type: 'warning',
                message: 'Replace all Hoshidicts data with this backup?',
                detail: expect.stringContaining('tab groups'),
                buttons: ['Restore Backup', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            })
        );
    });

    it('restores a complete backup and applies reader and audio settings live', async () => {
        const restoredAudio = {
            ...snapshot.audioProfile,
            volume: 64,
        };
        const restored = {
            ...snapshot,
            revision: 2,
            lookupMode: 'hover' as const,
            audioProfile: restoredAudio,
        };
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/tmp/hoshidicts-backup.zip'],
        });
        harness.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const context = await registerHarness();
        harness.manager.restoreBackup.mockResolvedValueOnce(restored);

        await expect(
            harness.handlers.get('hoshidicts.restoreBackup')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'backupRestored' },
            state: { revision: 2, lookupMode: 'hover' },
        });
        expect(harness.showOpenDialog).toHaveBeenCalledWith(
            context.settingsWindow,
            expect.objectContaining({
                title: 'Restore Hoshidicts Backup',
                properties: ['openFile'],
                filters: [
                    {
                        name: 'Hoshidicts Backup',
                        extensions: ['zip'],
                    },
                ],
            })
        );
        expect(harness.manager.restoreBackup).toHaveBeenCalledWith(
            '/tmp/hoshidicts-backup.zip'
        );
        expect(context.applyReaderPreferences).toHaveBeenCalledWith(
            expect.objectContaining({ lookupMode: 'hover' })
        );
        expect(context.applyAudioProfile).toHaveBeenCalledWith(restoredAudio);
        expect(context.restartOverlay).not.toHaveBeenCalled();
    });

    it('reports an actionable error when restored settings cannot restart the overlay', async () => {
        const restored = {
            ...snapshot,
            revision: 2,
        };
        harness.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: ['/tmp/hoshidicts-backup.zip'],
        });
        harness.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const context = await registerHarness();
        harness.manager.restoreBackup.mockResolvedValueOnce(restored);
        harness.manager.getSnapshot.mockResolvedValue(restored);
        context.applyReaderPreferences.mockResolvedValueOnce(false);
        context.applyAudioProfile.mockResolvedValueOnce(false);
        context.restartOverlay.mockResolvedValueOnce(false);

        await expect(
            harness.handlers.get('hoshidicts.restoreBackup')?.({
                sender: context.settingsContents,
            })
        ).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining(
                'Backup was restored, but its settings could not be applied'
            ),
            state: { revision: 2 },
        });
        expect(harness.manager.restoreBackup).toHaveBeenCalledOnce();
        expect(context.applyReaderPreferences).toHaveBeenCalledOnce();
        expect(context.applyAudioProfile).toHaveBeenCalledOnce();
        expect(context.restartOverlay).toHaveBeenCalledOnce();
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

    it('saves edited audio sources before testing kiku and returns playable media', async () => {
        const context = await registerHarness();
        const profile = {
            ...snapshot.audioProfile,
            sources: [
                {
                    id: 'edited-custom',
                    type: 'custom' as const,
                    url: 'http://127.0.0.1:5050/?term={term}',
                    voice: '',
                },
            ],
        };
        const savedSnapshot = { ...snapshot, audioProfile: profile };
        harness.manager.setAudioProfile.mockResolvedValueOnce(savedSnapshot);

        await expect(
            harness.handlers.get('hoshidicts.testAudioSource')?.(
                { sender: context.settingsContents },
                { profile, sourceId: 'edited-custom' }
            )
        ).resolves.toMatchObject({
            success: true,
            audio: {
                bytes: Uint8Array.from([1, 2, 3]),
                contentType: 'audio/mpeg',
                candidateName: 'kiku',
            },
            state: { audioProfile: profile },
        });
        expect(harness.manager.setAudioProfile).toHaveBeenCalledWith(profile);
        expect(context.applyAudioProfile).toHaveBeenCalledWith(profile);
        expect(harness.testAudioSource).toHaveBeenCalledWith('edited-custom');
        expect(
            context.applyAudioProfile.mock.invocationCallOrder[0]
        ).toBeLessThan(harness.testAudioSource.mock.invocationCallOrder[0]);
    });

    it('returns saved state and a provider error when an audio source test fails', async () => {
        const context = await registerHarness();
        const profile = snapshot.audioProfile;
        harness.testAudioSource.mockRejectedValueOnce(
            new Error('No pronunciation audio was found.')
        );

        await expect(
            harness.handlers.get('hoshidicts.testAudioSource')?.(
                { sender: context.settingsContents },
                { profile, sourceId: 'jisho' }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'No pronunciation audio was found.',
            state: { audioProfile: profile },
        });
        expect(harness.manager.setAudioProfile).toHaveBeenCalledWith(profile);
        expect(context.applyAudioProfile).toHaveBeenCalledWith(profile);
    });

    it('persists text-to-speech sources but explains that their test is renderer-local', async () => {
        const context = await registerHarness();
        const profile = {
            ...snapshot.audioProfile,
            sources: [
                {
                    id: 'local-tts',
                    type: 'text-to-speech-reading' as const,
                    url: '',
                    voice: 'ja-JP',
                },
            ],
        };
        harness.manager.setAudioProfile.mockResolvedValueOnce({
            ...snapshot,
            audioProfile: profile,
        });

        await expect(
            harness.handlers.get('hoshidicts.testAudioSource')?.(
                { sender: context.settingsContents },
                { profile, sourceId: 'local-tts' }
            )
        ).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('local speech synthesis'),
            state: { audioProfile: profile },
        });
        expect(harness.manager.setAudioProfile).toHaveBeenCalledWith(profile);
        expect(context.applyAudioProfile).toHaveBeenCalledWith(profile);
        expect(harness.testAudioSource).not.toHaveBeenCalled();
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

        harness.lookupControlsAtLaunch = {
            scanLength: 10,
            maxResults: 32,
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'descending',
        };
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });
        harness.lookupControlsAtLaunch.scanLength = 16;

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

        harness.showCompactDefinitionSummaryAtLaunch = true;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.showCompactDefinitionSummaryAtLaunch = false;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });

        harness.compactDefinitionSummaryCountAtLaunch = 4;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.compactDefinitionSummaryCountAtLaunch = 3;

        harness.compactDefinitionSummaryDictionaryAtLaunch = 'Jitendex';
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.compactDefinitionSummaryDictionaryAtLaunch = null;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });

        harness.hidePopupGrammarTagsAtLaunch = false;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.hidePopupGrammarTagsAtLaunch = null;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });

        harness.hidePopupGrammarTagsAtLaunch = true;
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
                    scanLength: 16,
                    maxResults: 32,
                    sortFrequencyDictionary: null,
                    sortFrequencyDictionaryOrder: 'descending',
                    activationKey: 'Shift',
                    sourceHighlightEnabled: false,
                    onlyScanJapaneseText: true,
                    popupHideDelayMs: 300,
                    showLookupCounts: true,
                    showCompactDefinitionSummary: false,
                    compactDefinitionSummaryCount: 3,
                    compactDefinitionSummaryDictionary: null,
                    showPitchAccentFurigana: true,
                    pitchAccentFuriganaDictionary: null,
                    showPitchAccentBadge: false,
                    hidePopupGrammarTags: true,
                    popupNestingMaxDepth: 10,
                    popupWidthPx: 560,
                    popupHeightPx: 420,
                    popupColumns: 1,
                    theme: 'girlypop',
                    popupOpacityPercent: 70,
                    popupToolbarPosition: 'bottom',
                    popupButtons: snapshot.popupButtons,
                    definitionBlur: snapshot.definitionBlur,
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
        });
        expect(context.restartOverlay).toHaveBeenCalledOnce();
    });

    it('restarts when hiding popup grammar tags cannot apply live', async () => {
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
                    ...snapshot,
                    hidePopupGrammarTags: false,
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
        });
        expect(context.restartOverlay).toHaveBeenCalledOnce();
    });

    it('only compares the compact definition dictionary after launch state is known', async () => {
        harness.enabledAtLaunch = true;
        harness.showCompactDefinitionSummaryAtLaunch = null;
        const context = await registerHarness();
        harness.manager.getSnapshot.mockResolvedValue({
            ...snapshot,
            compactDefinitionSummaryDictionary: 'Jitendex',
        });
        const getState = harness.handlers.get('hoshidicts.getState');

        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });

        harness.showCompactDefinitionSummaryAtLaunch = false;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });
    });

    it('restarts when a lookup-control change cannot apply live', async () => {
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
                    scanLength: 24,
                    maxResults: 32,
                    sortFrequencyDictionary: null,
                    sortFrequencyDictionaryOrder: 'descending',
                    activationKey: 'Shift',
                    sourceHighlightEnabled: false,
                    onlyScanJapaneseText: true,
                    popupHideDelayMs: 300,
                    showLookupCounts: true,
                    showCompactDefinitionSummary: false,
                    compactDefinitionSummaryCount: 3,
                    compactDefinitionSummaryDictionary: null,
                    showPitchAccentFurigana: true,
                    pitchAccentFuriganaDictionary: null,
                    showPitchAccentBadge: false,
                    hidePopupGrammarTags: true,
                    popupNestingMaxDepth: 10,
                    popupWidthPx: 560,
                    popupHeightPx: 420,
                    popupColumns: 1,
                    theme: 'default',
                    popupOpacityPercent: 85,
                    popupToolbarPosition: 'top',
                    popupButtons: snapshot.popupButtons,
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
                    scanLength: 16,
                    maxResults: 32,
                    sortFrequencyDictionary: null,
                    sortFrequencyDictionaryOrder: 'descending',
                    activationKey: 'Shift',
                    sourceHighlightEnabled: false,
                    onlyScanJapaneseText: true,
                    popupHideDelayMs: 300,
                    showLookupCounts: true,
                    showCompactDefinitionSummary: false,
                    compactDefinitionSummaryCount: 3,
                    compactDefinitionSummaryDictionary: null,
                    showPitchAccentFurigana: true,
                    pitchAccentFuriganaDictionary: null,
                    showPitchAccentBadge: false,
                    hidePopupGrammarTags: true,
                    popupNestingMaxDepth: 10,
                    popupWidthPx: 560,
                    popupHeightPx: 420,
                    popupColumns: 1,
                    theme: 'default',
                    popupOpacityPercent: 85,
                    popupToolbarPosition: 'top',
                    popupButtons: snapshot.popupButtons,
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

        harness.popupColumnsAtLaunch = 2;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.popupColumnsAtLaunch = 1;
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

    it('tracks popup buttons from control delivery without an environment setting', async () => {
        harness.enabledAtLaunch = true;
        const changedPopupButtons = {
            ...snapshot.popupButtons,
            viewInAnki: true,
        };
        const context = await registerHarness();
        harness.manager.getSnapshot.mockResolvedValue({
            ...snapshot,
            popupButtons: changedPopupButtons,
        });
        const getState = harness.handlers.get('hoshidicts.getState');

        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.popupButtonsApplied = changedPopupButtons;
        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });
    });

    it('requires a restart when custom popup CSS was not applied live', async () => {
        harness.enabledAtLaunch = true;
        const context = await registerHarness();
        harness.manager.getSnapshot.mockResolvedValue({
            ...snapshot,
            customPopupCss: ':scope { color: hotpink; }',
        });
        const getState = harness.handlers.get('hoshidicts.getState');

        await expect(
            getState?.({ sender: context.settingsContents })
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });

        harness.customPopupCssApplied = ':scope { color: hotpink; }';
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
        const setDictionarySchedule = harness.handlers.get(
            'hoshidicts.setDictionarySchedule'
        );
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
            setDictionarySchedule?.(
                { sender: context.foreignContents },
                { id: 'alpha', schedule: 'hourly' }
            )
        ).rejects.toThrow('invalid window');
        await expect(
            openSettings?.({ sender: context.settingsContents })
        ).rejects.toThrow('invalid window');
        expect(harness.manager.setSchedule).not.toHaveBeenCalled();
        expect(
            harness.manager.setDictionarySchedule
        ).not.toHaveBeenCalled();
        expect(context.openSettingsWindow).not.toHaveBeenCalled();
    });

    it('accepts hourly global schedules and per-dictionary cadence overrides', async () => {
        const context = await registerHarness();
        const setSchedule = harness.handlers.get('hoshidicts.setSchedule');
        const setDictionarySchedule = harness.handlers.get(
            'hoshidicts.setDictionarySchedule'
        );

        await expect(
            setSchedule?.({ sender: context.settingsContents }, 'hourly')
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
        });
        expect(harness.manager.setSchedule).toHaveBeenCalledWith('hourly');

        await expect(
            setDictionarySchedule?.(
                { sender: context.settingsContents },
                { id: 'alpha', schedule: 'hourly' }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
        });
        expect(harness.manager.setDictionarySchedule).toHaveBeenCalledWith(
            'alpha',
            'hourly'
        );
    });

    it('uses null for inherited dictionary schedules and rejects malformed requests', async () => {
        const context = await registerHarness();
        const setDictionarySchedule = harness.handlers.get(
            'hoshidicts.setDictionarySchedule'
        );

        await expect(
            setDictionarySchedule?.(
                { sender: context.settingsContents },
                { id: 'alpha', schedule: null }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
        });
        expect(harness.manager.setDictionarySchedule).toHaveBeenCalledWith(
            'alpha',
            null
        );

        for (const request of [
            null,
            { id: 42, schedule: 'daily' },
            { id: 'alpha' },
            { id: 'alpha', schedule: 'inherit' },
            { id: 'alpha', schedule: 'fortnightly' },
        ]) {
            await expect(
                setDictionarySchedule?.(
                    { sender: context.settingsContents },
                    request
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Dictionary update schedule request is invalid.',
            });
        }
        expect(harness.manager.setDictionarySchedule).toHaveBeenCalledOnce();
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

    it('validates and dispatches bulk dictionary actions as one manager call', async () => {
        const context = await registerHarness();
        const bulkAction = harness.handlers.get(
            'hoshidicts.bulkDictionaryAction'
        );

        await expect(
            bulkAction?.(
                { sender: context.settingsContents },
                { action: 'disable', ids: ['alpha', 'beta', 'alpha'] }
            )
        ).resolves.toMatchObject({ success: true });
        expect(harness.manager.setDictionariesEnabled).toHaveBeenCalledOnce();
        expect(harness.manager.setDictionariesEnabled).toHaveBeenCalledWith(
            ['alpha', 'beta'],
            false
        );

        await bulkAction?.(
            { sender: context.settingsContents },
            { action: 'favorite', ids: ['alpha', 'beta'] }
        );
        expect(
            harness.manager.setDictionariesPresentation
        ).toHaveBeenCalledWith(['alpha', 'beta'], true);

        await bulkAction?.(
            { sender: context.settingsContents },
            { action: 'update', ids: ['beta'] }
        );
        expect(harness.manager.checkForUpdates).toHaveBeenCalledWith(true, [
            'beta',
        ]);

        for (const request of [
            null,
            { action: 'delete', ids: ['alpha'] },
            { action: 'enable', ids: [] },
            { action: 'enable', ids: ['not valid'] },
        ]) {
            await expect(
                bulkAction?.({ sender: context.settingsContents }, request)
            ).resolves.toMatchObject({
                success: false,
                error: 'Bulk dictionary action request is invalid.',
            });
        }
        expect(harness.manager.setDictionariesEnabled).toHaveBeenCalledOnce();
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
                    displayName: 'Frequency ranks',
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
                    {
                        title: 'Frequency only',
                        favorite: true,
                        displayName: 'Frequency ranks',
                        frequencyMode: 'rank-based',
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

    it('manages tab groups and applies them to the reader live', async () => {
        const groupedState = {
            ...snapshot,
            dictionaries: [
                definitionDictionary('alpha', 'Alpha', true),
                definitionDictionary('beta', 'Beta', false),
            ],
            tabGroups: [
                {
                    id: 'group-grammar',
                    name: 'Grammar',
                    dictionaryIds: ['alpha', 'beta'],
                },
            ],
        } as const;
        const context = await registerHarness();
        harness.manager.createTabGroup.mockResolvedValue(groupedState);
        harness.manager.setTabGroupMembership.mockResolvedValue(groupedState);
        harness.manager.renameTabGroup.mockResolvedValue(groupedState);
        harness.manager.moveTabGroup.mockResolvedValue(groupedState);
        harness.manager.deleteTabGroup.mockResolvedValue(groupedState);
        const sender = { sender: context.settingsContents };

        await harness.handlers.get('hoshidicts.createTabGroup')?.(sender, {
            name: 'Grammar',
            dictionaryId: 'alpha',
        });
        await harness.handlers.get('hoshidicts.setTabGroupMembership')?.(
            sender,
            { groupId: 'group-grammar', dictionaryId: 'beta', member: true }
        );
        await harness.handlers.get('hoshidicts.renameTabGroup')?.(sender, {
            groupId: 'group-grammar',
            name: 'Reference',
        });
        await harness.handlers.get('hoshidicts.moveTabGroup')?.(sender, {
            groupId: 'group-grammar',
            direction: -1,
        });
        await harness.handlers.get('hoshidicts.deleteTabGroup')?.(sender, {
            groupId: 'group-grammar',
        });

        expect(harness.manager.createTabGroup).toHaveBeenCalledWith(
            'Grammar',
            'alpha'
        );
        expect(harness.manager.setTabGroupMembership).toHaveBeenCalledWith(
            'group-grammar',
            'beta',
            true
        );
        expect(harness.manager.renameTabGroup).toHaveBeenCalledWith(
            'group-grammar',
            'Reference'
        );
        expect(harness.manager.moveTabGroup).toHaveBeenCalledWith(
            'group-grammar',
            -1
        );
        expect(harness.manager.deleteTabGroup).toHaveBeenCalledWith(
            'group-grammar'
        );
        expect(context.applyReaderPreferences).toHaveBeenCalledWith(
            expect.objectContaining({
                dictionaryTabGroups: [
                    {
                        id: 'group-grammar',
                        name: 'Grammar',
                        dictionaries: ['Alpha', 'Beta'],
                    },
                ],
            })
        );

        await expect(
            harness.handlers.get('hoshidicts.createTabGroup')?.(sender, {
                name: 42,
            })
        ).resolves.toMatchObject({
            success: false,
            error: 'Tab group create request is invalid.',
        });
    });

    it('renames a dictionary for presentation without changing its canonical title', async () => {
        const renamedState = {
            ...snapshot,
            dictionaries: [
                {
                    ...definitionDictionary('alpha', 'Alpha Dictionary', true),
                    displayName: 'Friendly Alpha',
                },
            ],
        } as const;
        const context = await registerHarness();
        harness.manager.renameDictionary.mockResolvedValueOnce(renamedState);
        const renameDictionary = harness.handlers.get(
            'hoshidicts.renameDictionary'
        );

        await expect(
            renameDictionary?.(
                { sender: context.settingsContents },
                { id: 'alpha', displayName: 'Friendly Alpha' }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
            state: {
                dictionaries: [
                    {
                        id: 'alpha',
                        title: 'Alpha Dictionary',
                        displayName: 'Friendly Alpha',
                    },
                ],
            },
        });
        expect(harness.manager.renameDictionary).toHaveBeenCalledWith(
            'alpha',
            'Friendly Alpha'
        );
        expect(context.applyReaderPreferences).toHaveBeenCalledWith(
            expect.objectContaining({
                dictionaryPresentation: [
                    {
                        title: 'Alpha Dictionary',
                        favorite: true,
                        displayName: 'Friendly Alpha',
                    },
                ],
            })
        );

        await expect(
            renameDictionary?.(
                { sender: context.settingsContents },
                { id: 'alpha', displayName: null }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
        });
        expect(harness.manager.renameDictionary).toHaveBeenLastCalledWith(
            'alpha',
            null
        );

        await expect(
            renameDictionary?.(
                { sender: context.settingsContents },
                { id: 'alpha', displayName: 42 }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Dictionary rename request is invalid.',
        });
        expect(harness.manager.renameDictionary).toHaveBeenCalledTimes(2);
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
                    scanLength: 24,
                    maxResults: 48,
                    sortFrequencyDictionary: null,
                    sortFrequencyDictionaryOrder: 'ascending',
                    activationKey: 'F8',
                    sourceHighlightEnabled: true,
                    onlyScanJapaneseText: true,
                    popupHideDelayMs: 850,
                    showLookupCounts: 'yes',
                    showCompactDefinitionSummary: false,
                    compactDefinitionSummaryCount: 3,
                    compactDefinitionSummaryDictionary: null,
                    hidePopupGrammarTags: true,
                    popupNestingMaxDepth: 4,
                    popupWidthPx: 560,
                    popupHeightPx: 420,
                    popupColumns: 1,
                    theme: 'default',
                    popupOpacityPercent: 85,
                    popupToolbarPosition: 'top',
                    definitionBlur: snapshot.definitionBlur,
                }
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Hoshidicts reader preferences are invalid.',
        });
        expect(harness.manager.setReaderPreferences).not.toHaveBeenCalled();

        harness.manager.setReaderPreferences.mockResolvedValueOnce({
            ...snapshot,
            dictionaries: [definitionDictionary('alpha', 'Alpha', true)],
            tabGroups: [
                {
                    id: 'group-grammar',
                    name: 'Grammar',
                    dictionaryIds: ['alpha'],
                },
            ],
        });
        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'hover',
                    scanLength: 24,
                    maxResults: 48,
                    sortFrequencyDictionary: null,
                    sortFrequencyDictionaryOrder: 'ascending',
                    activationKey: 'F8',
                    sourceHighlightEnabled: true,
                    onlyScanJapaneseText: true,
                    popupHideDelayMs: 850,
                    showLookupCounts: false,
                    showCompactDefinitionSummary: true,
                    compactDefinitionSummaryCount: 3,
                    compactDefinitionSummaryDictionary: 'Jitendex',
                    showPitchAccentFurigana: true,
                    pitchAccentFuriganaDictionary: 'Pitch',
                    showPitchAccentBadge: false,
                    hidePopupGrammarTags: false,
                    popupNestingMaxDepth: 4,
                    popupWidthPx: 560,
                    popupHeightPx: 420,
                    popupColumns: 3,
                    theme: 'girlypop',
                    popupOpacityPercent: 70,
                    popupToolbarPosition: 'bottom',
                    popupButtons: {
                        addToAnki: false,
                        audio: true,
                        customDefinition: false,
                        viewInAnki: true,
                        customLinks: [
                            {
                                label: '  Jisho  ',
                                url: '  https://jisho.org/search/%w  ',
                            },
                        ],
                    },
                    customPopupCss: ':scope { color: hotpink; }',
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
            false,
            560,
            420,
            'girlypop',
            70,
            true,
            'bottom',
            24,
            48,
            null,
            'ascending',
            {
                addToAnki: false,
                audio: true,
                customDefinition: false,
                viewInAnki: true,
                customLinks: [
                    {
                        label: 'Jisho',
                        url: 'https://jisho.org/search/%w',
                    },
                ],
            },
            3,
            true,
            3,
            'Jitendex',
            false,
            true,
            'Pitch',
            false,
            ':scope { color: hotpink; }',
            false,
            true,
            16
        );
        expect(context.applyReaderPreferences).toHaveBeenCalledWith({
            lookupMode: 'hover',
            scanLength: 24,
            maxResults: 48,
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'ascending',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            onlyScanJapaneseText: true,
            popupHideDelayMs: 850,
            showLookupCounts: false,
            averageFrequency: false,
            showFrequencyDictionaryNames: true,
            showCompactDefinitionSummary: true,
            compactDefinitionSummaryCount: 3,
            compactDefinitionSummaryDictionary: 'Jitendex',
            showPitchAccentFurigana: true,
            pitchAccentFuriganaDictionary: 'Pitch',
            showPitchAccentBadge: false,
            hidePopupGrammarTags: false,
            popupNestingMaxDepth: 4,
            popupWidthPx: 560,
            popupHeightPx: 420,
            popupColumns: 3,
            theme: 'girlypop',
            popupOpacityPercent: 70,
            popupBackdropBlurPx: 16,
            popupToolbarPosition: 'bottom',
            popupButtons: {
                addToAnki: false,
                audio: true,
                customDefinition: false,
                viewInAnki: true,
                customLinks: [
                    {
                        label: 'Jisho',
                        url: 'https://jisho.org/search/%w',
                    },
                ],
            },
            customPopupCss: ':scope { color: hotpink; }',
            definitionBlur: {
                enabled: true,
                lookupThreshold: 7,
                revealMode: 'hover',
                revealDelayMs: 6000,
            },
            dictionaryPresentation: [
                {
                    title: 'Alpha',
                    favorite: true,
                },
            ],
            frequencyDictionaries: [],
            dictionaryTabGroups: [
                {
                    id: 'group-grammar',
                    name: 'Grammar',
                    dictionaries: ['Alpha'],
                },
            ],
        });

        await expect(
            setReaderPreferences?.(
                { sender: context.settingsContents },
                {
                    lookupMode: 'hover',
                    popupHideDelayMs: 850,
                    popupNestingMaxDepth: Number.MAX_SAFE_INTEGER + 1,
                    popupWidthPx: 560,
                    popupHeightPx: 420,
                    popupColumns: 1,
                    theme: 'default',
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

        await expect(
            getMiningOptions?.({ sender: context.settingsContents }, '')
        ).resolves.toMatchObject({ connected: true, noteTypes: ['Kiku'] });
        expect(context.getMiningOptions).toHaveBeenCalledWith('');
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

    it('rejects malformed compact definition dictionary preferences', async () => {
        const context = await registerHarness();
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        const valid = {
            lookupMode: 'hover',
            scanLength: 16,
            maxResults: 32,
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'descending',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            onlyScanJapaneseText: true,
            popupHideDelayMs: 850,
            showLookupCounts: true,
            showCompactDefinitionSummary: true,
            compactDefinitionSummaryCount: 3,
            compactDefinitionSummaryDictionary: null,
            showPitchAccentFurigana: true,
            pitchAccentFuriganaDictionary: null,
            showPitchAccentBadge: false,
            hidePopupGrammarTags: true,
            popupNestingMaxDepth: 4,
            popupWidthPx: 560,
            popupHeightPx: 420,
            popupColumns: 1,
            theme: 'default',
            popupOpacityPercent: 85,
            popupToolbarPosition: 'top',
            popupButtons: snapshot.popupButtons,
            definitionBlur: snapshot.definitionBlur,
        };

        for (const compactDefinitionSummaryDictionary of [
            undefined,
            '',
            '   ',
            'x'.repeat(4097),
            42,
        ]) {
            await expect(
                setReaderPreferences?.(
                    { sender: context.settingsContents },
                    { ...valid, compactDefinitionSummaryDictionary }
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Hoshidicts reader preferences are invalid.',
            });
        }
        for (const compactDefinitionSummaryCount of [0, 7, 1.5, '3']) {
            await expect(
                setReaderPreferences?.(
                    { sender: context.settingsContents },
                    { ...valid, compactDefinitionSummaryCount }
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Hoshidicts reader preferences are invalid.',
            });
        }
        for (const hidePopupGrammarTags of [undefined, 'yes', 1]) {
            await expect(
                setReaderPreferences?.(
                    { sender: context.settingsContents },
                    { ...valid, hidePopupGrammarTags }
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Hoshidicts reader preferences are invalid.',
            });
        }
        for (const showPitchAccentBadge of [undefined, 'yes', 1]) {
            await expect(
                setReaderPreferences?.(
                    { sender: context.settingsContents },
                    { ...valid, showPitchAccentBadge }
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Hoshidicts reader preferences are invalid.',
            });
        }
        expect(harness.manager.setReaderPreferences).not.toHaveBeenCalled();
        expect(context.applyReaderPreferences).not.toHaveBeenCalled();
    });

    it('rejects malformed definition blur reader preferences', async () => {
        const context = await registerHarness();
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        const valid = {
            lookupMode: 'hover',
            scanLength: 16,
            maxResults: 32,
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'descending',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            onlyScanJapaneseText: true,
            popupHideDelayMs: 850,
            showLookupCounts: true,
            showCompactDefinitionSummary: false,
            compactDefinitionSummaryCount: 3,
            compactDefinitionSummaryDictionary: null,
            showPitchAccentFurigana: true,
            pitchAccentFuriganaDictionary: null,
            showPitchAccentBadge: false,
            hidePopupGrammarTags: true,
            popupNestingMaxDepth: 4,
            popupWidthPx: 560,
            popupHeightPx: 420,
            popupColumns: 1,
            theme: 'default',
            popupOpacityPercent: 85,
            popupToolbarPosition: 'top',
            popupButtons: snapshot.popupButtons,
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

    it('rejects malformed popup button preferences', async () => {
        const context = await registerHarness();
        const setReaderPreferences = harness.handlers.get(
            'hoshidicts.setReaderPreferences'
        );
        const valid = {
            lookupMode: 'hover',
            scanLength: 16,
            maxResults: 32,
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'descending',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            onlyScanJapaneseText: true,
            popupHideDelayMs: 850,
            showLookupCounts: true,
            showCompactDefinitionSummary: false,
            compactDefinitionSummaryCount: 3,
            compactDefinitionSummaryDictionary: null,
            showPitchAccentFurigana: true,
            pitchAccentFuriganaDictionary: null,
            showPitchAccentBadge: false,
            hidePopupGrammarTags: true,
            popupNestingMaxDepth: 4,
            popupWidthPx: 560,
            popupHeightPx: 420,
            popupColumns: 1,
            theme: 'default',
            popupOpacityPercent: 85,
            popupToolbarPosition: 'top',
            definitionBlur: snapshot.definitionBlur,
            popupButtons: snapshot.popupButtons,
        };

        for (const popupButtons of [
            {
                ...snapshot.popupButtons,
                addToAnki: 'yes',
            },
            {
                ...snapshot.popupButtons,
                customLinks: [{ label: '', url: 'https://example.com/%w' }],
            },
            {
                ...snapshot.popupButtons,
                customLinks: [
                    { label: 'Unsafe', url: 'https://user:pass@example.com/%s' },
                ],
            },
        ]) {
            await expect(
                setReaderPreferences?.(
                    { sender: context.settingsContents },
                    { ...valid, popupButtons }
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
