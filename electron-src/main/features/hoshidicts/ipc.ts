import {
    BrowserWindow,
    dialog,
    ipcMain,
    type IpcMainInvokeEvent,
    type OpenDialogOptions,
    type SaveDialogOptions,
} from 'electron';

import type { OverlayRuntimeState } from '../../ui/front.js';
import {
    HOSHIDICTS_CHANNELS,
    DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    hoshidictsReaderPreferencesFromSnapshot,
    isHoshidictsActivationKey,
    isHoshidictsTheme,
    MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES,
    MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
    MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
    MAX_HOSHIDICTS_POPUP_WIDTH_PX,
    MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
    MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
    MIN_HOSHIDICTS_POPUP_WIDTH_PX,
    type HoshidictsActionResult,
    type HoshidictsActivationKey,
    type HoshidictsAudioProfile,
    type HoshidictsDefinitionBlurPreferences,
    type HoshidictsSaveCustomDictionaryRequest,
    type HoshidictsDesktopSnapshot,
    type HoshidictsDictionaryEnabledRequest,
    type HoshidictsDictionaryPresentationRequest,
    type HoshidictsInstallRecommendedRequest,
    type HoshidictsManagerSnapshot,
    type HoshidictsLookupMode,
    type HoshidictsMiningOptions,
    type HoshidictsMoveDictionaryRequest,
    type HoshidictsMoveDictionaryToPositionRequest,
    type HoshidictsReaderPreferences,
    type HoshidictsReaderPreferencesRequest,
    type HoshidictsRenameDictionaryRequest,
    type HoshidictsRecommendedDictionaryId,
    type HoshidictsSchedule,
    type HoshidictsTheme,
    type HoshidictsYomitanImportReport,
} from '../../../shared/features/hoshidicts.js';
import { getHoshidictsManager } from './manager.js';
import {
    prepareYomitanDictionaryBackup,
    prepareYomitanSettingsBackup,
} from './yomitan_backup.js';

export interface HoshidictsIPCDependencies {
    getMainWindow: () => BrowserWindow | null;
    getSettingsWindow: () => BrowserWindow | null;
    openSettingsWindow: () => Promise<BrowserWindow>;
    getOverlayRuntimeState: () => OverlayRuntimeState;
    getConfiguredFeatureEnabled: () => boolean;
    getOverlayFeatureEnabledAtLaunch: () => boolean | null;
    getOverlayLookupModeAtLaunch: () => HoshidictsLookupMode | null;
    getOverlayActivationKeyAtLaunch: () => HoshidictsActivationKey | null;
    getOverlaySourceHighlightEnabledAtLaunch: () => boolean | null;
    getOverlayPopupHideDelayAtLaunch: () => number | null;
    getOverlayShowLookupCountsAtLaunch: () => boolean | null;
    getOverlayAudioProfileRestartRequired: () => boolean;
    getOverlayPopupNestingMaxDepthAtLaunch: () => number | null;
    getOverlayDefinitionBlurAtLaunch: () =>
        | HoshidictsDefinitionBlurPreferences
        | null;
    getOverlayPopupWidthAtLaunch: () => number | null;
    getOverlayPopupHeightAtLaunch: () => number | null;
    getOverlayThemeAtLaunch: () => HoshidictsTheme | null;
    applyReaderPreferences: (
        preferences: HoshidictsReaderPreferences
    ) => Promise<boolean>;
    applyAudioProfile: (profile: HoshidictsAudioProfile) => Promise<boolean>;
    getMiningOptions: (model?: string) => Promise<HoshidictsMiningOptions>;
    restartOverlay: () => Promise<boolean>;
}

let ipcRegistered = false;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isSchedule(value: unknown): value is HoshidictsSchedule {
    return (
        value === 'off' ||
        value === 'daily' ||
        value === 'weekly' ||
        value === 'monthly'
    );
}

function isLookupMode(value: unknown): value is HoshidictsLookupMode {
    return value === 'shift' || value === 'hover';
}

function isDefinitionBlurPreferences(
    value: unknown
): value is HoshidictsDefinitionBlurPreferences {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const preferences = value as Partial<HoshidictsDefinitionBlurPreferences>;
    return (
        typeof preferences.enabled === 'boolean' &&
        Number.isInteger(preferences.lookupThreshold) &&
        (preferences.lookupThreshold as number) >=
            MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD &&
        (preferences.lookupThreshold as number) <=
            MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD &&
        (preferences.revealMode === 'timed' ||
            preferences.revealMode === 'hover') &&
        Number.isInteger(preferences.revealDelayMs) &&
        (preferences.revealDelayMs as number) >=
            MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS &&
        (preferences.revealDelayMs as number) <=
            MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS
    );
}

function definitionBlurPreferencesEqual(
    left: HoshidictsDefinitionBlurPreferences,
    right: HoshidictsDefinitionBlurPreferences
): boolean {
    return (
        left.enabled === right.enabled &&
        left.lookupThreshold === right.lookupThreshold &&
        left.revealMode === right.revealMode &&
        left.revealDelayMs === right.revealDelayMs
    );
}

function readerPreferencesMatchOverlay(
    preferences: HoshidictsReaderPreferences,
    deps: HoshidictsIPCDependencies
): boolean {
    const definitionBlurAtLaunch = deps.getOverlayDefinitionBlurAtLaunch();
    return (
        deps.getOverlayLookupModeAtLaunch() === preferences.lookupMode &&
        deps.getOverlayActivationKeyAtLaunch() === preferences.activationKey &&
        deps.getOverlaySourceHighlightEnabledAtLaunch() ===
            preferences.sourceHighlightEnabled &&
        deps.getOverlayPopupHideDelayAtLaunch() ===
            preferences.popupHideDelayMs &&
        deps.getOverlayShowLookupCountsAtLaunch() ===
            preferences.showLookupCounts &&
        deps.getOverlayPopupNestingMaxDepthAtLaunch() ===
            preferences.popupNestingMaxDepth &&
        deps.getOverlayPopupWidthAtLaunch() === preferences.popupWidthPx &&
        deps.getOverlayPopupHeightAtLaunch() === preferences.popupHeightPx &&
        deps.getOverlayThemeAtLaunch() === preferences.theme &&
        definitionBlurAtLaunch !== null &&
        definitionBlurPreferencesEqual(
            definitionBlurAtLaunch,
            preferences.definitionBlur
        )
    );
}

async function applyReaderSnapshot(
    snapshot: HoshidictsManagerSnapshot,
    deps: HoshidictsIPCDependencies
): Promise<void> {
    const applied = await deps.applyReaderPreferences(
        hoshidictsReaderPreferencesFromSnapshot(snapshot)
    );
    if (
        !applied &&
        deps.getConfiguredFeatureEnabled() &&
        deps.getOverlayRuntimeState().isRunning
    ) {
        let restarted = false;
        try {
            restarted = await deps.restartOverlay();
        } catch {
            // Report the same actionable error for a rejected restart and a
            // restart operation which returned false.
        }
        if (!restarted) {
            throw new Error(
                'Dictionary changes were saved, but could not be applied to the running overlay. Restart the overlay to use them.'
            );
        }
    }
}

async function applyRestoredSnapshot(
    snapshot: HoshidictsManagerSnapshot,
    deps: HoshidictsIPCDependencies
): Promise<void> {
    let readerApplied = false;
    let audioApplied = false;
    try {
        readerApplied = await deps.applyReaderPreferences(
            hoshidictsReaderPreferencesFromSnapshot(snapshot)
        );
    } catch {
        // A running overlay can still recover by restarting below.
    }
    try {
        audioApplied = await deps.applyAudioProfile(snapshot.audioProfile);
    } catch {
        // A running overlay can still recover by restarting below.
    }
    if (
        (readerApplied && audioApplied) ||
        !deps.getConfiguredFeatureEnabled() ||
        !deps.getOverlayRuntimeState().isRunning
    ) {
        return;
    }

    let restarted = false;
    try {
        restarted = await deps.restartOverlay();
    } catch {
        // Use the same actionable message for rejected and failed restarts.
    }
    if (!restarted) {
        throw new Error(
            'Backup was restored, but its settings could not be applied to the running overlay. Restart the overlay to use the restored settings.'
        );
    }
}

function backupDefaultFileName(now = new Date()): string {
    const timestamp = now
        .toISOString()
        .replace(/\.\d{3}Z$/u, '')
        .replace(/:/gu, '-');
    return `hoshidicts-backup-${timestamp}.zip`;
}

function isRecommendedDictionaryId(
    value: unknown
): value is HoshidictsRecommendedDictionaryId {
    return HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.some(
        (dictionaryId) => dictionaryId === value
    );
}

function assertSettingsSender(
    event: IpcMainInvokeEvent,
    deps: HoshidictsIPCDependencies
): void {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow !== deps.getSettingsWindow()) {
        throw new Error('Hoshidicts settings request came from an invalid window.');
    }
}

function assertMainSender(
    event: IpcMainInvokeEvent,
    deps: HoshidictsIPCDependencies
): void {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow !== deps.getMainWindow()) {
        throw new Error('Hoshidicts open request came from an invalid window.');
    }
}

function withDesktopState(
    snapshot: HoshidictsManagerSnapshot,
    deps: HoshidictsIPCDependencies
): HoshidictsDesktopSnapshot {
    const overlay = deps.getOverlayRuntimeState();
    const enabledAtLaunch = deps.getOverlayFeatureEnabledAtLaunch();
    const lookupModeAtLaunch = deps.getOverlayLookupModeAtLaunch();
    const activationKeyAtLaunch = deps.getOverlayActivationKeyAtLaunch();
    const sourceHighlightEnabledAtLaunch =
        deps.getOverlaySourceHighlightEnabledAtLaunch();
    const popupHideDelayAtLaunch = deps.getOverlayPopupHideDelayAtLaunch();
    const showLookupCountsAtLaunch =
        deps.getOverlayShowLookupCountsAtLaunch();
    const popupNestingMaxDepthAtLaunch =
        deps.getOverlayPopupNestingMaxDepthAtLaunch();
    const definitionBlurAtLaunch = deps.getOverlayDefinitionBlurAtLaunch();
    const popupWidthAtLaunch = deps.getOverlayPopupWidthAtLaunch();
    const popupHeightAtLaunch = deps.getOverlayPopupHeightAtLaunch();
    const themeAtLaunch = deps.getOverlayThemeAtLaunch();
    const effectiveEnabled = deps.getConfiguredFeatureEnabled();
    return {
        ...snapshot,
        effectiveEnabled,
        overlay: {
            running: overlay.isRunning,
            restartRequired:
                overlay.isRunning &&
                ((enabledAtLaunch !== null &&
                    enabledAtLaunch !== effectiveEnabled) ||
                    (effectiveEnabled &&
                        lookupModeAtLaunch !== null &&
                        lookupModeAtLaunch !== snapshot.lookupMode) ||
                    (effectiveEnabled &&
                        activationKeyAtLaunch !== null &&
                        activationKeyAtLaunch !== snapshot.activationKey) ||
                    (effectiveEnabled &&
                        sourceHighlightEnabledAtLaunch !== null &&
                        sourceHighlightEnabledAtLaunch !==
                            snapshot.sourceHighlightEnabled) ||
                    (effectiveEnabled &&
                        popupHideDelayAtLaunch !== null &&
                        popupHideDelayAtLaunch !== snapshot.popupHideDelayMs) ||
                    (effectiveEnabled &&
                        showLookupCountsAtLaunch !== null &&
                        showLookupCountsAtLaunch !== snapshot.showLookupCounts) ||
                    (effectiveEnabled &&
                        popupNestingMaxDepthAtLaunch !== null &&
                        popupNestingMaxDepthAtLaunch !==
                            snapshot.popupNestingMaxDepth) ||
                    (effectiveEnabled &&
                        definitionBlurAtLaunch !== null &&
                        !definitionBlurPreferencesEqual(
                            definitionBlurAtLaunch,
                            snapshot.definitionBlur
                        )) ||
                    (effectiveEnabled &&
                        popupWidthAtLaunch !== null &&
                        popupWidthAtLaunch !== snapshot.popupWidthPx) ||
                    (effectiveEnabled &&
                        popupHeightAtLaunch !== null &&
                        popupHeightAtLaunch !== snapshot.popupHeightPx) ||
                    (effectiveEnabled &&
                        themeAtLaunch !== null &&
                        themeAtLaunch !== snapshot.theme) ||
                    (effectiveEnabled &&
                        deps.getOverlayAudioProfileRestartRequired())),
        },
    };
}

async function currentState(
    deps: HoshidictsIPCDependencies
): Promise<HoshidictsDesktopSnapshot> {
    return withDesktopState(
        await getHoshidictsManager().getSnapshot(),
        deps
    );
}

async function runAction(
    deps: HoshidictsIPCDependencies,
    action: () => Promise<HoshidictsManagerSnapshot>,
    outcome?: HoshidictsActionResult['outcome']
): Promise<HoshidictsActionResult> {
    try {
        return {
            success: true,
            outcome,
            state: withDesktopState(await action(), deps),
        };
    } catch (error) {
        return {
            success: false,
            error: errorMessage(error),
            state: await currentState(deps),
        };
    }
}

export function registerHoshidictsIPC(
    deps: HoshidictsIPCDependencies
): void {
    if (ipcRegistered) {
        return;
    }
    ipcRegistered = true;

    const manager = getHoshidictsManager();
    manager.subscribe((snapshot) => {
        const window = deps.getSettingsWindow();
        if (window && !window.isDestroyed()) {
            window.webContents.send(
                HOSHIDICTS_CHANNELS.progress,
                withDesktopState(snapshot, deps)
            );
        }
    });

    ipcMain.handle(HOSHIDICTS_CHANNELS.openSettings, async (event) => {
        assertMainSender(event, deps);
        await deps.openSettingsWindow();
        return { success: true };
    });

    ipcMain.handle(HOSHIDICTS_CHANNELS.getState, async (event) => {
        assertSettingsSender(event, deps);
        return await currentState(deps);
    });

    ipcMain.handle(HOSHIDICTS_CHANNELS.getCustomDictionary, async (event) => {
        assertSettingsSender(event, deps);
        return await manager.getCustomDictionaryDocument();
    });

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.saveCustomDictionary,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as
                | Partial<HoshidictsSaveCustomDictionaryRequest>
                | null;
            if (
                !value ||
                typeof value.text !== 'string' ||
                typeof value.expectedRevision !== 'string' ||
                Buffer.byteLength(value.text, 'utf8') >
                    MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES
            ) {
                return {
                    success: false,
                    error: 'Custom dictionary save request is invalid or too large.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            try {
                const document = await manager.saveCustomDictionary(
                    value.text,
                    value.expectedRevision
                );
                return {
                    success: true,
                    outcome: { code: 'customDictionarySaved' },
                    document,
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            } catch (error) {
                return {
                    success: false,
                    error: errorMessage(error),
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
        }
    );

    ipcMain.handle(HOSHIDICTS_CHANNELS.importDictionary, async (event) => {
        assertSettingsSender(event, deps);
        const settingsWindow = deps.getSettingsWindow();
        const options: OpenDialogOptions = {
            title: 'Import Hoshidicts Dictionaries',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Yomitan Dictionary', extensions: ['zip'] }],
        };
        const result = settingsWindow
            ? await dialog.showOpenDialog(settingsWindow, options)
            : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
            return {
                success: false,
                canceled: true,
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }
        return await runAction(
            deps,
            async () => {
                const state = await manager.importDictionaries(result.filePaths);
                await applyReaderSnapshot(state, deps);
                return state;
            },
            { code: 'dictionaryImported', count: result.filePaths.length }
        );
    });

    ipcMain.handle(HOSHIDICTS_CHANNELS.importYomitanDictionaries, async (event) => {
        assertSettingsSender(event, deps);
        const settingsWindow = deps.getSettingsWindow();
        const options: OpenDialogOptions = {
            title: 'Import Dictionaries from Yomitan',
            properties: ['openFile'],
            filters: [{ name: 'Yomitan Dictionary Backup', extensions: ['json'] }],
        };
        const result = settingsWindow
            ? await dialog.showOpenDialog(settingsWindow, options)
            : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
            return {
                success: false,
                canceled: true,
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }

        let prepared: Awaited<
            ReturnType<typeof prepareYomitanDictionaryBackup>
        > | null = null;
        try {
            const before = await manager.getSnapshot();
            prepared = await prepareYomitanDictionaryBackup(result.filePaths[0]);
            const installedTitles = new Set(
                before.dictionaries.map((dictionary) => dictionary.title)
            );
            const report: HoshidictsYomitanImportReport = {
                imported: 0,
                replaced: 0,
                failed: 0,
                settings: [],
                warnings: [],
            };
            let state = before;
            for (const dictionary of prepared.dictionaries) {
                try {
                    state = await manager.importDictionary(
                        dictionary.archivePath
                    );
                    if (installedTitles.has(dictionary.title)) {
                        report.replaced += 1;
                    } else {
                        report.imported += 1;
                        installedTitles.add(dictionary.title);
                    }
                } catch (error) {
                    report.failed += 1;
                    report.warnings.push(
                        `${dictionary.title}: ${errorMessage(error)}`
                    );
                }
            }

            await applyReaderSnapshot(state, deps);
            if (report.imported + report.replaced === 0) {
                throw new Error(
                    report.warnings[0] ||
                        'The Yomitan backup did not contain dictionaries to import.'
                );
            }
            return {
                success: true,
                outcome: {
                    code: 'yomitanDictionariesImported',
                    count: report.imported + report.replaced,
                },
                yomitanReport: report,
                state: withDesktopState(state, deps),
            } satisfies HoshidictsActionResult;
        } catch (error) {
            return {
                success: false,
                error: errorMessage(error),
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        } finally {
            await prepared?.cleanup();
        }
    });

    ipcMain.handle(HOSHIDICTS_CHANNELS.importYomitanSettings, async (event) => {
        assertSettingsSender(event, deps);
        const settingsWindow = deps.getSettingsWindow();
        const options: OpenDialogOptions = {
            title: 'Import Settings from Yomitan',
            properties: ['openFile'],
            filters: [{ name: 'Yomitan Settings Backup', extensions: ['json'] }],
        };
        const result = settingsWindow
            ? await dialog.showOpenDialog(settingsWindow, options)
            : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
            return {
                success: false,
                canceled: true,
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }

        let prepared: Awaited<ReturnType<typeof prepareYomitanSettingsBackup>> | null = null;
        try {
            let state = await manager.getSnapshot();
            prepared = await prepareYomitanSettingsBackup(result.filePaths[0], state);
            const settings = prepared.settings;
            if (!settings || settings.groups.length === 0) {
                throw new Error('The Yomitan backup did not contain supported settings to import.');
            }
            const report: HoshidictsYomitanImportReport = {
                imported: 0,
                replaced: 0,
                failed: 0,
                settings: settings.groups,
                warnings: [...settings.warnings],
            };
            if (settings.dictionaries.length > 0) {
                state = await manager.applyYomitanDictionaryPreferences(settings.dictionaries);
            }
            if (settings.miningProfile) {
                state = await manager.setMiningProfile(settings.miningProfile);
            }
            if (settings.audioProfile) {
                state = await manager.setAudioProfile(settings.audioProfile);
                await deps.applyAudioProfile(state.audioProfile);
            }
            if (settings.readerPreferences) {
                const reader = settings.readerPreferences;
                state = await manager.setReaderPreferences(
                    reader.lookupMode,
                    reader.popupHideDelayMs,
                    reader.activationKey,
                    reader.sourceHighlightEnabled,
                    reader.popupNestingMaxDepth,
                    reader.definitionBlur,
                    reader.showLookupCounts,
                    reader.popupWidthPx,
                    reader.popupHeightPx,
                    reader.theme
                );
            }
            await applyReaderSnapshot(state, deps);
            return {
                success: true,
                outcome: {
                    code: 'yomitanSettingsImported',
                    count: report.settings.length,
                },
                yomitanReport: report,
                state: withDesktopState(state, deps),
            } satisfies HoshidictsActionResult;
        } catch (error) {
            return {
                success: false,
                error: errorMessage(error),
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        } finally {
            await prepared?.cleanup();
        }
    });

    ipcMain.handle(HOSHIDICTS_CHANNELS.exportBackup, async (event) => {
        assertSettingsSender(event, deps);
        const settingsWindow = deps.getSettingsWindow();
        const options: SaveDialogOptions = {
            title: 'Export Hoshidicts Backup',
            defaultPath: backupDefaultFileName(),
            filters: [{ name: 'Hoshidicts Backup', extensions: ['zip'] }],
        };
        const result = settingsWindow
            ? await dialog.showSaveDialog(settingsWindow, options)
            : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) {
            return {
                success: false,
                canceled: true,
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }

        try {
            const outputPath = result.filePath.toLowerCase().endsWith('.zip')
                ? result.filePath
                : `${result.filePath}.zip`;
            await manager.exportBackup(outputPath);
            return {
                success: true,
                outcome: { code: 'backupExported' },
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        } catch (error) {
            return {
                success: false,
                error: errorMessage(error),
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }
    });

    ipcMain.handle(HOSHIDICTS_CHANNELS.restoreBackup, async (event) => {
        assertSettingsSender(event, deps);
        const settingsWindow = deps.getSettingsWindow();
        const options: OpenDialogOptions = {
            title: 'Restore Hoshidicts Backup',
            properties: ['openFile'],
            filters: [{ name: 'Hoshidicts Backup', extensions: ['zip'] }],
        };
        const result = settingsWindow
            ? await dialog.showOpenDialog(settingsWindow, options)
            : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
            return {
                success: false,
                canceled: true,
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }

        const confirmationOptions = {
            type: 'warning' as const,
            title: 'Restore Hoshidicts Backup',
            message: 'Replace all Hoshidicts data with this backup?',
            detail: 'This replaces all installed dictionaries, reader settings, mining and audio settings, and the custom dictionary. The restore cannot be undone unless you export the current Hoshidicts data first.',
            buttons: ['Restore Backup', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        };
        const confirmation = settingsWindow
            ? await dialog.showMessageBox(
                  settingsWindow,
                  confirmationOptions
              )
            : await dialog.showMessageBox(confirmationOptions);
        if (confirmation.response !== 0) {
            return {
                success: false,
                canceled: true,
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }

        try {
            const state = await manager.restoreBackup(result.filePaths[0]);
            await applyRestoredSnapshot(state, deps);
            return {
                success: true,
                outcome: { code: 'backupRestored' },
                state: withDesktopState(state, deps),
            } satisfies HoshidictsActionResult;
        } catch (error) {
            return {
                success: false,
                error: errorMessage(error),
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }
    });

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.installAllRecommended,
        async (event) => {
            assertSettingsSender(event, deps);
            const before = await manager.getSnapshot();
            const missingCount = before.recommendedDictionaries.filter(
                (dictionary) =>
                    DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.some(
                        (dictionaryId) => dictionaryId === dictionary.id
                    ) && !dictionary.installed
            ).length;
            return await runAction(
                deps,
                async () => {
                    const state =
                        await manager.installRecommendedDictionaries();
                    await applyReaderSnapshot(state, deps);
                    return state;
                },
                { code: 'recommendedInstalled', count: missingCount }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.installRecommended,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const id =
                request &&
                typeof request === 'object' &&
                'id' in request
                    ? (request as HoshidictsInstallRecommendedRequest).id
                    : null;
            if (!isRecommendedDictionaryId(id)) {
                return {
                    success: false,
                    error: 'Recommended dictionary id is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => {
                    const state =
                        await manager.installRecommendedDictionary(id);
                    await applyReaderSnapshot(state, deps);
                    return state;
                },
                { code: 'recommendedInstalled', count: 1 }
            );
        }
    );

    ipcMain.handle(HOSHIDICTS_CHANNELS.checkUpdates, async (event) => {
        assertSettingsSender(event, deps);
        return await runAction(deps, async () => {
            const state = await manager.checkForUpdates(true);
            // Earlier dictionaries may already have updated even when a later
            // update reports an error, so publish the returned ordering/titles
            // before surfacing that error to settings.
            await applyReaderSnapshot(state, deps);
            if (state.lastError) {
                throw new Error(state.lastError);
            }
            return state;
        }, { code: 'updatesChecked' });
    });

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.removeDictionary,
        async (event, id: unknown) => {
            assertSettingsSender(event, deps);
            if (typeof id !== 'string') {
                return {
                    success: false,
                    error: 'Dictionary id is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            const state = await manager.getSnapshot();
            const dictionary = state.dictionaries.find(
                (entry) => entry.id === id
            );
            if (!dictionary) {
                return {
                    success: false,
                    error: 'Dictionary is not installed.',
                    state: withDesktopState(state, deps),
                } satisfies HoshidictsActionResult;
            }
            const settingsWindow = deps.getSettingsWindow();
            const options = {
                type: 'warning' as const,
                title: 'Remove Hoshidicts Dictionary',
                message: `Remove "${dictionary.title}"?`,
                detail: 'The dictionary will be removed from lookups immediately.',
                buttons: ['Remove', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            };
            const confirmation = settingsWindow
                ? await dialog.showMessageBox(settingsWindow, options)
                : await dialog.showMessageBox(options);
            if (confirmation.response !== 0) {
                return {
                    success: false,
                    canceled: true,
                    state: withDesktopState(state, deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => {
                    const next = await manager.removeDictionary(id);
                    await applyReaderSnapshot(next, deps);
                    return next;
                },
                { code: 'dictionaryRemoved', title: dictionary.title }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.setSchedule,
        async (event, schedule: unknown) => {
            assertSettingsSender(event, deps);
            if (!isSchedule(schedule)) {
                return {
                    success: false,
                    error: 'Dictionary update schedule is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => await manager.setSchedule(schedule),
                { code: 'preferencesSaved' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.setLookupMode,
        async (event, lookupMode: unknown) => {
            assertSettingsSender(event, deps);
            if (!isLookupMode(lookupMode)) {
                return {
                    success: false,
                    error: 'Hoshidicts lookup mode is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => await manager.setLookupMode(lookupMode),
                { code: 'preferencesSaved' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.setReaderPreferences,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as Partial<HoshidictsReaderPreferencesRequest> | null;
            if (
                !value ||
                !isLookupMode(value.lookupMode) ||
                !isHoshidictsActivationKey(value.activationKey) ||
                typeof value.sourceHighlightEnabled !== 'boolean' ||
                typeof value.showLookupCounts !== 'boolean' ||
                !Number.isInteger(value.popupHideDelayMs) ||
                (value.popupHideDelayMs as number) < 0 ||
                (value.popupHideDelayMs as number) >
                    MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS ||
                !Number.isSafeInteger(value.popupNestingMaxDepth) ||
                (value.popupNestingMaxDepth as number) < 0 ||
                !Number.isInteger(value.popupWidthPx) ||
                (value.popupWidthPx as number) <
                    MIN_HOSHIDICTS_POPUP_WIDTH_PX ||
                (value.popupWidthPx as number) >
                    MAX_HOSHIDICTS_POPUP_WIDTH_PX ||
                !Number.isInteger(value.popupHeightPx) ||
                (value.popupHeightPx as number) <
                    MIN_HOSHIDICTS_POPUP_HEIGHT_PX ||
                (value.popupHeightPx as number) >
                    MAX_HOSHIDICTS_POPUP_HEIGHT_PX ||
                !isHoshidictsTheme(value.theme) ||
                !isDefinitionBlurPreferences(value.definitionBlur)
            ) {
                return {
                    success: false,
                    error: 'Hoshidicts reader preferences are invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => {
                    const requestPreferences: HoshidictsReaderPreferencesRequest = {
                        lookupMode: value.lookupMode as HoshidictsLookupMode,
                        activationKey: value.activationKey as HoshidictsActivationKey,
                        sourceHighlightEnabled:
                            value.sourceHighlightEnabled as boolean,
                        popupHideDelayMs: value.popupHideDelayMs as number,
                        showLookupCounts: value.showLookupCounts as boolean,
                        popupNestingMaxDepth:
                            value.popupNestingMaxDepth as number,
                        definitionBlur: {
                            ...value.definitionBlur,
                        } as HoshidictsDefinitionBlurPreferences,
                        popupWidthPx: value.popupWidthPx as number,
                        popupHeightPx: value.popupHeightPx as number,
                        theme: value.theme as HoshidictsTheme,
                    };
                    const state = await manager.setReaderPreferences(
                        requestPreferences.lookupMode,
                        requestPreferences.popupHideDelayMs,
                        requestPreferences.activationKey,
                        requestPreferences.sourceHighlightEnabled,
                        requestPreferences.popupNestingMaxDepth,
                        requestPreferences.definitionBlur,
                        requestPreferences.showLookupCounts,
                        requestPreferences.popupWidthPx,
                        requestPreferences.popupHeightPx,
                        requestPreferences.theme
                    );
                    const preferences: HoshidictsReaderPreferences = {
                        ...requestPreferences,
                        dictionaryPresentation:
                            hoshidictsReaderPreferencesFromSnapshot(state)
                                .dictionaryPresentation,
                    };
                    const applied = await deps.applyReaderPreferences(
                        preferences
                    );
                    if (
                        !applied &&
                        deps.getOverlayRuntimeState().isRunning &&
                        !readerPreferencesMatchOverlay(preferences, deps)
                    ) {
                        await deps.restartOverlay();
                    }
                    return state;
                },
                { code: 'preferencesSaved' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.setMiningProfile,
        async (event, profile: unknown) => {
            assertSettingsSender(event, deps);
            return await runAction(
                deps,
                async () => await manager.setMiningProfile(profile),
                { code: 'miningProfileSaved' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.setAudioProfile,
        async (event, profile: unknown) => {
            assertSettingsSender(event, deps);
            return await runAction(
                deps,
                async () => {
                    const state = await manager.setAudioProfile(profile);
                    await deps.applyAudioProfile(state.audioProfile);
                    return state;
                },
                { code: 'audioProfileSaved' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.getMiningOptions,
        async (event, model: unknown) => {
            assertSettingsSender(event, deps);
            if (
                model !== undefined &&
                (typeof model !== 'string' ||
                    model.length > 255 ||
                    model.includes('\0'))
            ) {
                throw new Error('Hoshidicts note type is invalid.');
            }
            return await deps.getMiningOptions(
                typeof model === 'string' ? model : undefined
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.setDictionaryEnabled,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as
                | Partial<HoshidictsDictionaryEnabledRequest>
                | null;
            if (
                !value ||
                typeof value.id !== 'string' ||
                typeof value.enabled !== 'boolean'
            ) {
                return {
                    success: false,
                    error: 'Dictionary enable request is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () =>
                    await manager.setDictionaryEnabled(
                        value.id as string,
                        value.enabled as boolean
                    ),
                { code: 'dictionaryChanged' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.setDictionaryPresentation,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as
                | Partial<HoshidictsDictionaryPresentationRequest>
                | null;
            if (
                !value ||
                typeof value.id !== 'string' ||
                typeof value.favorite !== 'boolean'
            ) {
                return {
                    success: false,
                    error: 'Dictionary presentation request is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => {
                    const state = await manager.setDictionaryPresentation(
                        value.id as string,
                        value.favorite as boolean
                    );
                    await applyReaderSnapshot(state, deps);
                    return state;
                },
                { code: 'dictionaryChanged' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.renameDictionary,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as
                | Partial<HoshidictsRenameDictionaryRequest>
                | null;
            if (
                !value ||
                typeof value.id !== 'string' ||
                (value.displayName !== null &&
                    typeof value.displayName !== 'string')
            ) {
                return {
                    success: false,
                    error: 'Dictionary rename request is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => {
                    const state = await manager.renameDictionary(
                        value.id as string,
                        value.displayName as string | null
                    );
                    await applyReaderSnapshot(state, deps);
                    return state;
                },
                { code: 'dictionaryChanged' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.moveDictionary,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as
                | Partial<HoshidictsMoveDictionaryRequest>
                | null;
            if (
                !value ||
                typeof value.id !== 'string' ||
                (value.direction !== -1 && value.direction !== 1)
            ) {
                return {
                    success: false,
                    error: 'Dictionary move request is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => {
                    const state = await manager.moveDictionary(
                        value.id as string,
                        value.direction as -1 | 1
                    );
                    await applyReaderSnapshot(state, deps);
                    return state;
                },
                { code: 'dictionaryChanged' }
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.moveDictionaryToPosition,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as
                | Partial<HoshidictsMoveDictionaryToPositionRequest>
                | null;
            if (
                !value ||
                typeof value.id !== 'string' ||
                !Number.isInteger(value.position) ||
                (value.position as number) < 1
            ) {
                return {
                    success: false,
                    error: 'Dictionary position request is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsActionResult;
            }
            return await runAction(
                deps,
                async () => {
                    const state = await manager.moveDictionaryToPosition(
                        value.id as string,
                        value.position as number
                    );
                    await applyReaderSnapshot(state, deps);
                    return state;
                },
                { code: 'dictionaryChanged' }
            );
        }
    );

    ipcMain.handle(HOSHIDICTS_CHANNELS.restartOverlay, async (event) => {
        assertSettingsSender(event, deps);
        try {
            const success = await deps.restartOverlay();
            return {
                success,
                error: success ? null : 'The overlay could not be restarted.',
                outcome: success ? { code: 'overlayRestarted' } : undefined,
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        } catch (error) {
            return {
                success: false,
                error: errorMessage(error),
                state: await currentState(deps),
            } satisfies HoshidictsActionResult;
        }
    });
}
