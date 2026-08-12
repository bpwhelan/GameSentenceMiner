import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    HOSHIDICTS_CHANNELS,
    type HoshidictsReaderPreferencesRequest,
} from '../../../shared/features/hoshidicts.js';
import {
    createHoshidictsIpcDependencies,
    makeHoshidictsDictionary,
    makeHoshidictsMiningOptions,
    makeHoshidictsReaderPreferences,
    makeHoshidictsSnapshot,
} from './test_helpers.js';

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
    overlayRunning: true,
    enabledAtLaunch: false as boolean | null,
    /** The preferences the running overlay is using, or null when unknown. */
    appliedReaderPreferences: null as HoshidictsReaderPreferencesRequest | null,
    audioProfileRestartRequired: false,
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

const snapshot = makeHoshidictsSnapshot();
const defaultPreferences = makeHoshidictsReaderPreferences();

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
    const getMiningOptions = vi.fn(async () => makeHoshidictsMiningOptions());
    const { registerHoshidictsIPC } = await import('./ipc.js');
    registerHoshidictsIPC(
        createHoshidictsIpcDependencies({
            getMainWindow: () => mainWindow as any,
            getSettingsWindow: () => settingsWindow as any,
            openSettingsWindow: openSettingsWindow as any,
            getOverlayRuntimeState: () => ({
                isRunning: harness.overlayRunning,
                source: 'manual',
            }),
            getConfiguredFeatureEnabled: () => harness.configuredEnabled,
            getOverlayFeatureEnabledAtLaunch: () => harness.enabledAtLaunch,
            getAppliedReaderPreferences: () =>
                harness.appliedReaderPreferences,
            getOverlayAudioProfileRestartRequired: () =>
                harness.audioProfileRestartRequired,
            applyReaderPreferences,
            applyAudioProfile,
            getMiningOptions,
            restartOverlay,
        })
    );

    return {
        foreignContents,
        mainContents,
        openSettingsWindow,
        restartOverlay,
        settingsContents,
        settingsWindow,
        settingsEvent: { sender: settingsContents },
        getMiningOptions,
        applyReaderPreferences,
        applyAudioProfile,
    };
}

describe('Hoshidicts settings IPC', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        harness.configuredEnabled = true;
        harness.overlayRunning = true;
        harness.enabledAtLaunch = false;
        harness.appliedReaderPreferences = null;
        harness.audioProfileRestartRequired = false;
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
                context.settingsEvent,
                { name: 'Persona' },
            ),
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'profileCreated' },
        });
        expect(harness.manager.createProfile).toHaveBeenCalledWith('Persona');

        await expect(
            harness.handlers.get(HOSHIDICTS_CHANNELS.switchProfile)?.(
                context.settingsEvent,
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
                context.settingsEvent,
                { name: '   ' },
            ),
        ).resolves.toMatchObject({
            success: false,
            error: 'Profile name is invalid.',
        });
        expect(harness.manager.createProfile).toHaveBeenCalledOnce();
    });

    it.each([
        [
            HOSHIDICTS_CHANNELS.createProfile,
            'createProfile',
            [null, {}, { name: '  ' }, { name: 42 }, { name: 'x'.repeat(129) }],
            'Profile name is invalid.',
        ],
        [
            HOSHIDICTS_CHANNELS.switchProfile,
            'switchProfile',
            [null, {}, { id: 42 }],
            'Profile switch request is invalid.',
        ],
        [
            HOSHIDICTS_CHANNELS.renameProfile,
            'renameProfile',
            [null, { id: 'persona' }, { id: 42, name: 'Persona' }, { id: 'persona', name: '  ' }],
            'Profile rename request is invalid.',
        ],
        [
            HOSHIDICTS_CHANNELS.deleteProfile,
            'deleteProfile',
            [null, {}, { id: 42 }],
            'Profile delete request is invalid.',
        ],
    ])(
        '%s rejects malformed requests',
        async (channel, method, requests, error) => {
            const context = await registerHarness();

            for (const request of requests) {
                await expect(
                    harness.handlers.get(channel)?.(
                        context.settingsEvent,
                        request
                    )
                ).resolves.toMatchObject({ success: false, error });
            }
            expect(
                harness.manager[method as 'createProfile']
            ).not.toHaveBeenCalled();
        }
    );

    it('renames and deletes profiles, applying a replacement profile live', async () => {
        const context = await registerHarness();
        const replacement = { ...snapshot, activeProfileId: 'default' };
        harness.manager.getSnapshot.mockResolvedValueOnce({
            ...snapshot,
            activeProfileId: 'persona',
        });
        harness.manager.deleteProfile.mockResolvedValueOnce(replacement);

        await expect(
            harness.handlers.get(HOSHIDICTS_CHANNELS.renameProfile)?.(
                context.settingsEvent,
                { id: 'persona', name: 'Renamed' }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'profileRenamed' },
        });
        expect(harness.manager.renameProfile).toHaveBeenCalledWith(
            'persona',
            'Renamed'
        );

        await expect(
            harness.handlers.get(HOSHIDICTS_CHANNELS.deleteProfile)?.(
                context.settingsEvent,
                { id: 'persona' }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'profileDeleted' },
        });
        expect(harness.manager.deleteProfile).toHaveBeenCalledWith('persona');
        expect(context.applyReaderPreferences).toHaveBeenCalledOnce();
        expect(context.applyAudioProfile).toHaveBeenCalledOnce();
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
            harness.handlers.get('hoshidicts.import')?.(context.settingsEvent)
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
            harness.handlers.get('hoshidicts.importYomitanDictionaries')?.(
                context.settingsEvent
            )
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
            harness.handlers.get('hoshidicts.importYomitanDictionaries')?.(
                context.settingsEvent
            )
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
            harness.handlers.get('hoshidicts.importYomitanSettings')?.(
                context.settingsEvent
            )
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

    it('saves imported Yomitan reader preferences and drops unavailable frequency sorting', async () => {
        const cleanup = vi.fn(async () => undefined);
        const readerPreferences = makeHoshidictsReaderPreferences({
            lookupMode: 'hover',
            sortFrequencyDictionary: 'Missing frequency',
        });
        harness.prepareYomitanSettingsBackup.mockResolvedValueOnce({
            dictionaries: [],
            settings: {
                profileName: 'Mining',
                dictionaries: [],
                readerPreferences,
                miningProfile: null,
                audioProfile: null,
                groups: ['reader'],
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
            harness.handlers.get('hoshidicts.importYomitanSettings')?.(
                context.settingsEvent
            )
        ).resolves.toMatchObject({
            success: true,
            yomitanReport: {
                settings: ['reader'],
                warnings: [
                    'Turned off unavailable frequency sorting dictionary: Missing frequency.',
                ],
            },
        });
        expect(harness.manager.setReaderPreferences).toHaveBeenCalledWith({
            ...readerPreferences,
            sortFrequencyDictionary: null,
        });
    });

    it('exports a complete Hoshidicts backup with a ZIP save dialog', async () => {
        harness.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/hoshidicts-backup',
        });
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.exportBackup')?.(
                context.settingsEvent
            )
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

        await expect(
            harness.handlers.get('hoshidicts.exportBackup')?.(
                context.settingsEvent
            )
        ).resolves.toMatchObject({ success: false, canceled: true });
        await expect(
            harness.handlers.get('hoshidicts.restoreBackup')?.(
                context.settingsEvent
            )
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
            harness.handlers.get('hoshidicts.restoreBackup')?.(
                context.settingsEvent
            )
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
            harness.handlers.get('hoshidicts.restoreBackup')?.(
                context.settingsEvent
            )
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
            setAudioProfile?.(context.settingsEvent, snapshot.audioProfile)
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
            getState?.(context.settingsEvent)
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
                context.settingsEvent,
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
                context.settingsEvent,
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
                context.settingsEvent,
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

    it.each([
        [null],
        [{ sourceId: 'jisho' }],
        [{ profile: 'nope', sourceId: 'jisho' }],
        [{ profile: {}, sourceId: 42 }],
        [{ profile: {}, sourceId: 'not valid' }],
    ])('rejects a malformed audio source test request (%j)', async (request) => {
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.testAudioSource')?.(
                context.settingsEvent,
                request
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Hoshidicts audio source test request is invalid.',
        });
        expect(harness.manager.setAudioProfile).not.toHaveBeenCalled();
    });

    // Every stored reader preference now counts towards the restart banner,
    // including popup opacity, backdrop blur, and toolbar position.
    it.each([
        ['lookupMode', 'hover'],
        ['scanLength', 10],
        ['maxResults', 64],
        ['sortFrequencyDictionary', 'Frequency'],
        ['sortFrequencyDictionaryOrder', 'ascending'],
        ['activationKey', 'F8'],
        ['sourceHighlightEnabled', true],
        ['onlyScanJapaneseText', false],
        ['popupHideDelayMs', 900],
        ['showLookupCounts', false],
        ['averageFrequency', true],
        ['showFrequencyDictionaryNames', false],
        ['showCompactDefinitionSummary', true],
        ['compactDefinitionSummaryCount', 4],
        ['compactDefinitionSummaryDictionary', 'Jitendex'],
        ['showPitchAccentFurigana', false],
        ['pitchAccentFuriganaDictionary', 'Pitch'],
        ['showPitchAccentBadge', true],
        ['hidePopupGrammarTags', false],
        ['popupNestingMaxDepth', 4],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 5,
                revealMode: 'timed',
                revealDelayMs: 5000,
            },
        ],
        ['popupWidthPx', 600],
        ['popupHeightPx', 500],
        ['popupColumns', 2],
        ['theme', 'girlypop'],
        ['popupOpacityPercent', 70],
        ['popupBackdropBlurPx', 24],
        ['popupToolbarPosition', 'bottom'],
        [
            'popupButtons',
            { ...defaultPreferences.popupButtons, viewInAnki: true },
        ],
        ['customPopupCss', ':scope { color: hotpink; }'],
    ])(
        'requires an overlay restart while the overlay runs a different %s',
        async (field, launched) => {
            harness.enabledAtLaunch = true;
            const context = await registerHarness();
            const getState = harness.handlers.get('hoshidicts.getState');

            harness.appliedReaderPreferences = makeHoshidictsReaderPreferences({
                [field]: launched,
            });
            await expect(
                getState?.(context.settingsEvent)
            ).resolves.toMatchObject({
                overlay: { running: true, restartRequired: true },
            });

            harness.appliedReaderPreferences = makeHoshidictsReaderPreferences();
            await expect(
                getState?.(context.settingsEvent)
            ).resolves.toMatchObject({
                overlay: { running: true, restartRequired: false },
            });
        }
    );

    it('only compares preferences once the launch state is known', async () => {
        harness.enabledAtLaunch = true;
        const context = await registerHarness();
        harness.manager.getSnapshot.mockResolvedValue({
            ...snapshot,
            compactDefinitionSummaryDictionary: 'Jitendex',
        });
        const getState = harness.handlers.get('hoshidicts.getState');

        await expect(
            getState?.(context.settingsEvent)
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: false },
        });

        harness.appliedReaderPreferences = makeHoshidictsReaderPreferences();
        await expect(
            getState?.(context.settingsEvent)
        ).resolves.toMatchObject({
            overlay: { running: true, restartRequired: true },
        });
    });

    it.each([
        [
            'the feature was turned on since launch',
            () => {
                harness.enabledAtLaunch = false;
                harness.configuredEnabled = true;
            },
            true,
        ],
        [
            'the feature was turned off since launch',
            () => {
                harness.enabledAtLaunch = true;
                harness.configuredEnabled = false;
            },
            true,
        ],
        [
            'a live audio profile update failed',
            () => {
                harness.enabledAtLaunch = true;
                harness.audioProfileRestartRequired = true;
            },
            true,
        ],
        [
            'the feature is off, so preference drift is irrelevant',
            () => {
                harness.enabledAtLaunch = false;
                harness.configuredEnabled = false;
                harness.appliedReaderPreferences =
                    makeHoshidictsReaderPreferences({ lookupMode: 'hover' });
            },
            false,
        ],
        [
            'the overlay is not running',
            () => {
                harness.overlayRunning = false;
                harness.enabledAtLaunch = true;
                harness.configuredEnabled = false;
            },
            false,
        ],
    ])(
        'reports restartRequired=%s when %s',
        async (_reason, arrange, restartRequired) => {
            arrange();
            const context = await registerHarness();

            await expect(
                harness.handlers.get('hoshidicts.getState')?.(
                    context.settingsEvent
                )
            ).resolves.toMatchObject({
                overlay: {
                    running: harness.overlayRunning,
                    restartRequired,
                },
            });
        }
    );

    it.each([
        ['lookupMode', 'hover'],
        ['hidePopupGrammarTags', false],
        ['scanLength', 24],
        ['theme', 'girlypop'],
        ['popupOpacityPercent', 70],
    ])(
        'restarts a running overlay when a changed %s cannot apply live',
        async (field, value) => {
            harness.enabledAtLaunch = true;
            const context = await registerHarness();
            context.applyReaderPreferences.mockResolvedValueOnce(false);

            await expect(
                harness.handlers.get('hoshidicts.setReaderPreferences')?.(
                    context.settingsEvent,
                    makeHoshidictsReaderPreferences({ [field]: value })
                )
            ).resolves.toMatchObject({
                success: true,
                outcome: { code: 'preferencesSaved' },
            });
            expect(context.restartOverlay).toHaveBeenCalledOnce();
        }
    );

    it('does not restart when the running overlay already uses the saved preferences', async () => {
        harness.enabledAtLaunch = true;
        harness.appliedReaderPreferences = makeHoshidictsReaderPreferences();
        const context = await registerHarness();
        context.applyReaderPreferences.mockResolvedValueOnce(false);

        await expect(
            harness.handlers.get('hoshidicts.setReaderPreferences')?.(
                context.settingsEvent,
                makeHoshidictsReaderPreferences()
            )
        ).resolves.toMatchObject({ success: true });
        expect(context.restartOverlay).not.toHaveBeenCalled();
    });

    it('keeps preferences saved when an automatic overlay restart fails', async () => {
        harness.enabledAtLaunch = true;
        const context = await registerHarness();
        context.applyReaderPreferences.mockResolvedValueOnce(false);
        context.restartOverlay.mockResolvedValueOnce(false);
        harness.manager.setReaderPreferences.mockResolvedValueOnce({
            ...snapshot,
            lookupMode: 'hover',
        });
        harness.appliedReaderPreferences = makeHoshidictsReaderPreferences();

        await expect(
            harness.handlers.get('hoshidicts.setReaderPreferences')?.(
                context.settingsEvent,
                makeHoshidictsReaderPreferences({ lookupMode: 'hover' })
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
            openSettings?.(context.settingsEvent)
        ).rejects.toThrow('invalid window');
        expect(harness.manager.setSchedule).not.toHaveBeenCalled();
        expect(
            harness.manager.setDictionarySchedule
        ).not.toHaveBeenCalled();
        expect(context.openSettingsWindow).not.toHaveBeenCalled();
    });

    it.each(['off', 'hourly', 'daily', 'weekly', 'monthly'])(
        'accepts the %s global update schedule',
        async (schedule) => {
            const context = await registerHarness();

            await expect(
                harness.handlers.get('hoshidicts.setSchedule')?.(
                    context.settingsEvent,
                    schedule
                )
            ).resolves.toMatchObject({
                success: true,
                outcome: { code: 'preferencesSaved' },
            });
            expect(harness.manager.setSchedule).toHaveBeenCalledWith(schedule);
        }
    );

    it.each([undefined, null, 'fortnightly', 42])(
        'rejects the invalid global update schedule %j',
        async (schedule) => {
            const context = await registerHarness();

            await expect(
                harness.handlers.get('hoshidicts.setSchedule')?.(
                    context.settingsEvent,
                    schedule
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Dictionary update schedule is invalid.',
            });
            expect(harness.manager.setSchedule).not.toHaveBeenCalled();
        }
    );

    it.each(['hourly', 'daily', 'weekly', 'monthly', 'off', null])(
        'accepts the %j per-dictionary cadence override',
        async (schedule) => {
            const context = await registerHarness();

            await expect(
                harness.handlers.get('hoshidicts.setDictionarySchedule')?.(
                    context.settingsEvent,
                    { id: 'alpha', schedule }
                )
            ).resolves.toMatchObject({
                success: true,
                outcome: { code: 'dictionaryChanged' },
            });
            expect(harness.manager.setDictionarySchedule).toHaveBeenCalledWith(
                'alpha',
                schedule
            );
        }
    );

    it.each([
        null,
        { id: 42, schedule: 'daily' },
        { id: 'alpha' },
        { id: 'alpha', schedule: 'inherit' },
        { id: 'alpha', schedule: 'fortnightly' },
    ])(
        'rejects the malformed per-dictionary schedule request %j',
        async (request) => {
            const context = await registerHarness();

            await expect(
                harness.handlers.get('hoshidicts.setDictionarySchedule')?.(
                    context.settingsEvent,
                    request
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Dictionary update schedule request is invalid.',
            });
            expect(
                harness.manager.setDictionarySchedule
            ).not.toHaveBeenCalled();
        }
    );

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
            getState?.(context.settingsEvent)
        ).resolves.toMatchObject({
            effectiveEnabled: true,
            overlay: {
                running: true,
                restartRequired: true,
            },
        });

        await expect(
            setDictionaryEnabled?.(context.settingsEvent, {
                id: 42,
                enabled: true,
            })
        ).resolves.toMatchObject({
            success: false,
            error: 'Dictionary enable request is invalid.',
        });
        expect(
            harness.manager.setDictionaryEnabled
        ).not.toHaveBeenCalled();

        expect(harness.handlers.has('hoshidicts.setFeatureEnabled')).toBe(false);

        await expect(
            restartOverlay?.(context.settingsEvent)
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

    it('reports a failed manual overlay restart', async () => {
        const context = await registerHarness();
        context.restartOverlay.mockResolvedValueOnce(false);

        await expect(
            harness.handlers.get('hoshidicts.restartOverlay')?.(
                context.settingsEvent
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'The overlay could not be restarted.',
        });
    });

    it.each([
        ['enable', 'setDictionariesEnabled', ['alpha', 'beta'], true],
        ['disable', 'setDictionariesEnabled', ['alpha', 'beta'], false],
        ['favorite', 'setDictionariesPresentation', ['alpha', 'beta'], true],
        ['unfavorite', 'setDictionariesPresentation', ['alpha', 'beta'], false],
    ])(
        'dispatches the %s bulk dictionary action as one manager call',
        async (action, method, ids, flag) => {
            const context = await registerHarness();

            await expect(
                harness.handlers.get('hoshidicts.bulkDictionaryAction')?.(
                    context.settingsEvent,
                    { action, ids: [...ids, ids[0]] }
                )
            ).resolves.toMatchObject({
                success: true,
                outcome: { code: 'dictionaryChanged', count: ids.length },
            });
            expect(
                harness.manager[method as 'setDictionariesEnabled']
            ).toHaveBeenCalledOnce();
            expect(
                harness.manager[method as 'setDictionariesEnabled']
            ).toHaveBeenCalledWith(ids, flag);
        }
    );

    it('dispatches the update bulk dictionary action as an update check', async () => {
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.bulkDictionaryAction')?.(
                context.settingsEvent,
                { action: 'update', ids: ['beta'] }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'updatesChecked', count: 1 },
        });
        expect(harness.manager.checkForUpdates).toHaveBeenCalledWith(true, [
            'beta',
        ]);
    });

    it.each([
        null,
        { action: 'delete', ids: ['alpha'] },
        { action: 'enable', ids: [] },
        { action: 'enable', ids: ['not valid'] },
        { action: 'enable', ids: [42] },
    ])('rejects the malformed bulk dictionary request %j', async (request) => {
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.bulkDictionaryAction')?.(
                context.settingsEvent,
                request
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Bulk dictionary action request is invalid.',
        });
        expect(harness.manager.setDictionariesEnabled).not.toHaveBeenCalled();
        expect(harness.manager.checkForUpdates).not.toHaveBeenCalled();
    });

    it('validates, persists, and applies ordered dictionary presentation live', async () => {
        const presentationState = {
            ...snapshot,
            dictionaries: [
                makeHoshidictsDictionary({
                    id: 'alpha',
                    title: 'Alpha',
                    favorite: true,
                }),
                makeHoshidictsDictionary({
                    id: 'frequency',
                    title: 'Frequency only',
                    displayName: 'Frequency ranks',
                    favorite: true,
                    termCount: 0,
                    frequencyCount: 1,
                    frequencyMode: 'rank-based',
                }),
            ],
        };
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
            setPresentation?.(context.settingsEvent, {
                id: 'alpha',
                favorite: true,
            })
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
                frequencyDictionaries: ['Frequency only'],
            })
        );

        await expect(
            setPresentation?.(context.settingsEvent, {
                id: 'alpha',
                favorite: 'yes',
            })
        ).resolves.toMatchObject({
            success: false,
            error: 'Dictionary presentation request is invalid.',
        });
        expect(harness.manager.setDictionaryPresentation).toHaveBeenCalledOnce();

        harness.manager.moveDictionary.mockResolvedValueOnce(presentationState);
        context.applyReaderPreferences.mockResolvedValueOnce(false);
        await expect(
            moveDictionary?.(context.settingsEvent, {
                id: 'alpha',
                direction: 1,
            })
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
            moveDictionaryToPosition?.(context.settingsEvent, {
                id: 'alpha',
                position: 3,
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
        });
        expect(
            harness.manager.moveDictionaryToPosition
        ).toHaveBeenCalledWith('alpha', 3);

        await expect(
            moveDictionaryToPosition?.(context.settingsEvent, {
                id: 'alpha',
                position: 0,
            })
        ).resolves.toMatchObject({
            success: false,
            error: 'Dictionary position request is invalid.',
        });
        expect(
            harness.manager.moveDictionaryToPosition
        ).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'hoshidicts.moveDictionary',
            'moveDictionary',
            [null, { id: 'alpha' }, { id: 'alpha', direction: 0 }, { id: 42, direction: 1 }],
            'Dictionary move request is invalid.',
        ],
        [
            'hoshidicts.moveTabGroup',
            'moveTabGroup',
            [null, { groupId: 'g' }, { groupId: 'g', direction: 2 }],
            'Tab group move request is invalid.',
        ],
        [
            'hoshidicts.setTabGroupMembership',
            'setTabGroupMembership',
            [
                null,
                { groupId: 'g', dictionaryId: 'alpha' },
                { groupId: 'g', dictionaryId: 42, member: true },
            ],
            'Tab group membership request is invalid.',
        ],
        [
            'hoshidicts.renameTabGroup',
            'renameTabGroup',
            [null, { groupId: 'g' }, { groupId: 42, name: 'Grammar' }],
            'Tab group rename request is invalid.',
        ],
        [
            'hoshidicts.deleteTabGroup',
            'deleteTabGroup',
            [null, {}, { groupId: 42 }],
            'Tab group delete request is invalid.',
        ],
        [
            'hoshidicts.createTabGroup',
            'createTabGroup',
            [null, { name: 42 }, { name: 'Grammar', dictionaryId: 42 }],
            'Tab group create request is invalid.',
        ],
    ])('%s rejects malformed requests', async (channel, method, requests, error) => {
        const context = await registerHarness();

        for (const request of requests) {
            await expect(
                harness.handlers.get(channel)?.(context.settingsEvent, request)
            ).resolves.toMatchObject({ success: false, error });
        }
        expect(
            harness.manager[method as 'moveDictionary']
        ).not.toHaveBeenCalled();
    });

    it('manages tab groups and applies them to the reader live', async () => {
        const groupedState = {
            ...snapshot,
            dictionaries: [
                makeHoshidictsDictionary({
                    id: 'alpha',
                    title: 'Alpha',
                    favorite: true,
                }),
                makeHoshidictsDictionary({ id: 'beta', title: 'Beta' }),
            ],
            tabGroups: [
                {
                    id: 'group-grammar',
                    name: 'Grammar',
                    dictionaryIds: ['alpha', 'beta'],
                },
            ],
        };
        const context = await registerHarness();
        harness.manager.createTabGroup.mockResolvedValue(groupedState);
        harness.manager.setTabGroupMembership.mockResolvedValue(groupedState);
        harness.manager.renameTabGroup.mockResolvedValue(groupedState);
        harness.manager.moveTabGroup.mockResolvedValue(groupedState);
        harness.manager.deleteTabGroup.mockResolvedValue(groupedState);
        const sender = context.settingsEvent;

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
    });

    it('renames a dictionary for presentation without changing its canonical title', async () => {
        const renamedState = {
            ...snapshot,
            dictionaries: [
                makeHoshidictsDictionary({
                    id: 'alpha',
                    title: 'Alpha Dictionary',
                    favorite: true,
                    displayName: 'Friendly Alpha',
                }),
            ],
        };
        const context = await registerHarness();
        harness.manager.renameDictionary.mockResolvedValueOnce(renamedState);
        const renameDictionary = harness.handlers.get(
            'hoshidicts.renameDictionary'
        );

        await expect(
            renameDictionary?.(context.settingsEvent, {
                id: 'alpha',
                displayName: 'Friendly Alpha',
            })
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
            renameDictionary?.(context.settingsEvent, {
                id: 'alpha',
                displayName: null,
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'dictionaryChanged' },
        });
        expect(harness.manager.renameDictionary).toHaveBeenLastCalledWith(
            'alpha',
            null
        );

        await expect(
            renameDictionary?.(context.settingsEvent, {
                id: 'alpha',
                displayName: 42,
            })
        ).resolves.toMatchObject({
            success: false,
            error: 'Dictionary rename request is invalid.',
        });
        expect(harness.manager.renameDictionary).toHaveBeenCalledTimes(2);
    });

    it('refreshes live presentation after every dictionary collection mutation', async () => {
        const primary = makeHoshidictsDictionary({
            id: 'primary',
            title: 'Primary',
            favorite: true,
        });
        const backup = makeHoshidictsDictionary({
            id: 'backup',
            title: 'Backup',
        });
        const initialState = {
            ...snapshot,
            dictionaries: [primary, backup],
        };
        const renamedState = {
            ...snapshot,
            dictionaries: [{ ...primary, title: 'Primary 2026' }, backup],
        };
        const removedAnchorState = {
            ...snapshot,
            dictionaries: [backup],
        };
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

        const settingsEvent = context.settingsEvent;
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

    it.each([
        ['a canceled removal confirmation', 1, { canceled: true }],
        ['a confirmed removal', 0, { success: true }],
    ])(
        'honours %s',
        async (_label, response, expected) => {
            const primary = makeHoshidictsDictionary({
                id: 'primary',
                title: 'Primary',
            });
            harness.showMessageBox.mockResolvedValueOnce({ response });
            const context = await registerHarness();
            harness.manager.getSnapshot.mockResolvedValue({
                ...snapshot,
                dictionaries: [primary],
            });

            await expect(
                harness.handlers.get('hoshidicts.remove')?.(
                    context.settingsEvent,
                    primary.id
                )
            ).resolves.toMatchObject(expected);
        }
    );

    it.each([
        [42, 'Dictionary id is invalid.'],
        ['missing', 'Dictionary is not installed.'],
    ])('rejects removing %j', async (id, error) => {
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.remove')?.(
                context.settingsEvent,
                id
            )
        ).resolves.toMatchObject({ success: false, error });
        expect(harness.manager.removeDictionary).not.toHaveBeenCalled();
    });

    it('reports when a saved dictionary mutation cannot refresh the running overlay', async () => {
        const primary = makeHoshidictsDictionary({
            id: 'primary',
            title: 'Primary',
            favorite: true,
        });
        const backup = makeHoshidictsDictionary({
            id: 'backup',
            title: 'Backup',
        });
        const initialState = {
            ...snapshot,
            dictionaries: [primary, backup],
        };
        const removedAnchorState = {
            ...snapshot,
            dictionaries: [backup],
        };
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
                context.settingsEvent,
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
        const partialUpdateState = {
            ...snapshot,
            dictionaries: [
                makeHoshidictsDictionary({
                    id: 'primary',
                    title: 'Primary 2026',
                    favorite: true,
                }),
            ],
            lastError: 'Backup dictionary update failed.',
        };
        const context = await registerHarness();
        harness.manager.checkForUpdates.mockResolvedValueOnce(
            partialUpdateState
        );

        await expect(
            harness.handlers.get('hoshidicts.checkUpdates')?.(
                context.settingsEvent
            )
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

    it('installs all recommendations and validates the lookup mode shortcut', async () => {
        const context = await registerHarness();

        await expect(
            harness.handlers.get('hoshidicts.installAllRecommended')?.(
                context.settingsEvent
            )
        ).resolves.toMatchObject({ success: true });
        expect(
            harness.manager.installRecommendedDictionaries
        ).toHaveBeenCalledOnce();

        await expect(
            harness.handlers.get('hoshidicts.setLookupMode')?.(
                context.settingsEvent,
                'automatic'
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Hoshidicts lookup mode is invalid.',
        });
        expect(harness.manager.setLookupMode).not.toHaveBeenCalled();

        await expect(
            harness.handlers.get('hoshidicts.setLookupMode')?.(
                context.settingsEvent,
                'hover'
            )
        ).resolves.toMatchObject({ success: true });
        expect(harness.manager.setLookupMode).toHaveBeenCalledWith('hover');
    });

    it('saves a complete reader preferences request and applies it with dictionary context', async () => {
        const context = await registerHarness();
        const request = makeHoshidictsReaderPreferences({
            lookupMode: 'hover',
            scanLength: 24,
            maxResults: 48,
            sortFrequencyDictionaryOrder: 'ascending',
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupHideDelayMs: 850,
            showLookupCounts: false,
            showCompactDefinitionSummary: true,
            compactDefinitionSummaryDictionary: 'Jitendex',
            pitchAccentFuriganaDictionary: 'Pitch',
            hidePopupGrammarTags: false,
            popupNestingMaxDepth: 4,
            popupColumns: 3,
            theme: 'girlypop',
            popupOpacityPercent: 70,
            popupToolbarPosition: 'bottom',
            customPopupCss: ':scope { color: hotpink; }',
            definitionBlur: {
                enabled: true,
                lookupThreshold: 7,
                revealMode: 'hover',
                revealDelayMs: 6000,
            },
            popupButtons: {
                addToAnki: false,
                audio: true,
                customDefinition: false,
                viewInAnki: true,
                customLinks: [
                    { label: 'Jisho', url: 'https://jisho.org/search/%w' },
                ],
            },
        });
        // What reaches the overlay is the saved snapshot, not the raw request,
        // so the manager mock has to answer with the preferences it stored.
        harness.manager.setReaderPreferences.mockResolvedValueOnce({
            ...snapshot,
            ...request,
            dictionaries: [
                makeHoshidictsDictionary({
                    id: 'alpha',
                    title: 'Alpha',
                    favorite: true,
                }),
            ],
            tabGroups: [
                {
                    id: 'group-grammar',
                    name: 'Grammar',
                    dictionaryIds: ['alpha'],
                },
            ],
        });

        await expect(
            harness.handlers.get('hoshidicts.setReaderPreferences')?.(
                context.settingsEvent,
                {
                    ...request,
                    // Custom link fields are canonicalized before storage.
                    popupButtons: {
                        ...request.popupButtons,
                        customLinks: [
                            {
                                label: '  Jisho  ',
                                url: '  https://jisho.org/search/%w  ',
                            },
                        ],
                    },
                }
            )
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'preferencesSaved' },
        });
        // One object argument replaces the former positional parameter list.
        expect(harness.manager.setReaderPreferences).toHaveBeenCalledWith(
            request
        );
        expect(context.applyReaderPreferences).toHaveBeenCalledWith({
            ...request,
            dictionaryPresentation: [{ title: 'Alpha', favorite: true }],
            frequencyDictionaries: [],
            dictionaryTabGroups: [
                {
                    id: 'group-grammar',
                    name: 'Grammar',
                    dictionaries: ['Alpha'],
                },
            ],
        });
    });

    // The renderer must send a complete request; there is no per-field fallback
    // to the stored value any more.
    it.each(
        Object.keys(defaultPreferences) as (keyof typeof defaultPreferences)[]
    )('rejects a reader preferences request without %s', async (field) => {
        const context = await registerHarness();
        const request: Record<string, unknown> =
            makeHoshidictsReaderPreferences();
        delete request[field];

        await expect(
            harness.handlers.get('hoshidicts.setReaderPreferences')?.(
                context.settingsEvent,
                request
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Hoshidicts reader preferences are invalid.',
        });
        expect(harness.manager.setReaderPreferences).not.toHaveBeenCalled();
        expect(context.applyReaderPreferences).not.toHaveBeenCalled();
    });

    it.each([
        ['lookupMode', 'automatic'],
        ['scanLength', 0],
        ['scanLength', 65],
        ['maxResults', 257],
        ['sortFrequencyDictionary', ''],
        ['sortFrequencyDictionaryOrder', 'random'],
        ['activationKey', 'MediaPlayPause'],
        ['sourceHighlightEnabled', 'yes'],
        ['onlyScanJapaneseText', 'yes'],
        ['popupHideDelayMs', 5001],
        ['showLookupCounts', 'yes'],
        ['averageFrequency', 'yes'],
        ['showFrequencyDictionaryNames', 'yes'],
        ['showCompactDefinitionSummary', 'yes'],
        ['compactDefinitionSummaryCount', 0],
        ['compactDefinitionSummaryCount', 7],
        ['compactDefinitionSummaryCount', 1.5],
        ['compactDefinitionSummaryCount', '3'],
        ['compactDefinitionSummaryDictionary', ''],
        ['compactDefinitionSummaryDictionary', '   '],
        ['compactDefinitionSummaryDictionary', 'x'.repeat(4097)],
        ['compactDefinitionSummaryDictionary', 42],
        ['showPitchAccentFurigana', 'yes'],
        ['pitchAccentFuriganaDictionary', '   '],
        ['showPitchAccentBadge', 'yes'],
        ['showPitchAccentBadge', 1],
        ['hidePopupGrammarTags', 'yes'],
        ['hidePopupGrammarTags', 1],
        ['popupNestingMaxDepth', Number.MAX_SAFE_INTEGER + 1],
        ['popupWidthPx', 279],
        ['popupHeightPx', 901],
        ['popupColumns', 5],
        ['theme', 'neon'],
        ['popupOpacityPercent', 101],
        ['popupBackdropBlurPx', 33],
        ['popupToolbarPosition', 'side'],
        ['customPopupCss', 42],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 0,
                revealMode: 'timed',
                revealDelayMs: 5000,
            },
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 1_000_001,
                revealMode: 'timed',
                revealDelayMs: 5000,
            },
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 5,
                revealMode: 'click',
                revealDelayMs: 5000,
            },
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 5,
                revealMode: 'timed',
                revealDelayMs: 999,
            },
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 5,
                revealMode: 'timed',
                revealDelayMs: 3_600_001,
            },
        ],
        [
            'popupButtons',
            { ...defaultPreferences.popupButtons, addToAnki: 'yes' },
        ],
        [
            'popupButtons',
            {
                ...defaultPreferences.popupButtons,
                customLinks: [{ label: '', url: 'https://example.com/%w' }],
            },
        ],
        [
            'popupButtons',
            {
                ...defaultPreferences.popupButtons,
                customLinks: [
                    {
                        label: 'Unsafe',
                        url: 'https://user:pass@example.com/%s',
                    },
                ],
            },
        ],
    ])(
        'rejects a reader preferences request with %s = %j',
        async (field, value) => {
            const context = await registerHarness();

            await expect(
                harness.handlers.get('hoshidicts.setReaderPreferences')?.(
                    context.settingsEvent,
                    makeHoshidictsReaderPreferences({ [field]: value })
                )
            ).resolves.toMatchObject({
                success: false,
                error: 'Hoshidicts reader preferences are invalid.',
            });
            expect(harness.manager.setReaderPreferences).not.toHaveBeenCalled();
            expect(context.applyReaderPreferences).not.toHaveBeenCalled();
        }
    );

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
                installRecommended?.(context.settingsEvent, { id })
            ).resolves.toMatchObject({ success: true });
        }
        expect(
            harness.manager.installRecommendedDictionary.mock.calls.map(
                ([id]) => id
            )
        ).toEqual(ids);

        for (const request of [null, {}, { id: 'unknown' }, { id: 42 }]) {
            await expect(
                installRecommended?.(context.settingsEvent, request)
            ).resolves.toMatchObject({
                success: false,
                error: 'Recommended dictionary id is invalid.',
            });
        }
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
            getCustom?.(context.settingsEvent)
        ).resolves.toMatchObject({
            revision: 'empty-revision',
            exists: false,
        });
        await expect(
            getCustom?.({ sender: context.foreignContents })
        ).rejects.toThrow('invalid window');

        await expect(
            saveCustom?.(context.settingsEvent, {
                text: '猫, ねこ, cat\n',
                expectedRevision: 'empty-revision',
            })
        ).resolves.toMatchObject({
            success: true,
            outcome: { code: 'customDictionarySaved' },
            document: { exists: true, text: '猫, ねこ, cat\n' },
        });
        expect(harness.manager.saveCustomDictionary).toHaveBeenCalledWith(
            '猫, ねこ, cat\n',
            'empty-revision'
        );

        for (const request of [
            null,
            { text: '猫, ねこ, cat', expectedRevision: 42 },
            { text: 42, expectedRevision: 'empty-revision' },
            {
                text: 'x'.repeat(16 * 1024 * 1024 + 1),
                expectedRevision: 'empty-revision',
            },
        ]) {
            await expect(
                saveCustom?.(context.settingsEvent, request)
            ).resolves.toMatchObject({
                success: false,
                error: 'Custom dictionary save request is invalid or too large.',
            });
        }
        expect(harness.manager.saveCustomDictionary).toHaveBeenCalledOnce();
    });

    it('validates the mining options note type before discovering Anki state', async () => {
        const context = await registerHarness();
        const getMiningOptions = harness.handlers.get(
            'hoshidicts.getMiningOptions'
        );

        await expect(
            getMiningOptions?.(context.settingsEvent, 'Kiku')
        ).resolves.toMatchObject({ connected: true, noteTypes: ['Kiku'] });
        expect(context.getMiningOptions).toHaveBeenCalledWith('Kiku');

        await expect(
            getMiningOptions?.(context.settingsEvent, '')
        ).resolves.toMatchObject({ connected: true, noteTypes: ['Kiku'] });
        expect(context.getMiningOptions).toHaveBeenCalledWith('');

        await expect(
            getMiningOptions?.(context.settingsEvent, undefined)
        ).resolves.toMatchObject({ connected: true });
        expect(context.getMiningOptions).toHaveBeenCalledWith(undefined);

        for (const model of [42, 'x'.repeat(256), 'Kiku\0']) {
            await expect(
                getMiningOptions?.(context.settingsEvent, model)
            ).rejects.toThrow('Hoshidicts note type is invalid.');
        }
    });
});
