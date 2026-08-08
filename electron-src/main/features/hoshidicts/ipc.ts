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
    assertHoshidictsReaderPreferences,
    hoshidictsReaderPreferencesEqual,
    normalizeHoshidictsReaderPreferences,
    HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    hoshidictsReaderPreferencesFromSnapshot,
    MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES,
    MAX_HOSHIDICTS_PROFILE_NAME_LENGTH,
    type HoshidictsActionResult,
    type HoshidictsAudioProfile,
    type HoshidictsAudioSourceTestRequest,
    type HoshidictsAudioSourceTestResult,
    type HoshidictsBulkDictionaryActionRequest,
    type HoshidictsSaveCustomDictionaryRequest,
    type HoshidictsDesktopSnapshot,
    type HoshidictsDictionaryEnabledRequest,
    type HoshidictsDictionaryPresentationRequest,
    type HoshidictsDictionaryScheduleRequest,
    type HoshidictsCreateTabGroupRequest,
    type HoshidictsCreateProfileRequest,
    type HoshidictsSetTabGroupMembershipRequest,
    type HoshidictsRenameTabGroupRequest,
    type HoshidictsDeleteTabGroupRequest,
    type HoshidictsMoveTabGroupRequest,
    type HoshidictsInstallRecommendedRequest,
    type HoshidictsManagerSnapshot,
    type HoshidictsLookupMode,
    type HoshidictsMiningOptions,
    type HoshidictsMoveDictionaryRequest,
    type HoshidictsMoveDirection,
    type HoshidictsMoveDictionaryToPositionRequest,
    type HoshidictsReaderPreferences,
    type HoshidictsReaderPreferencesRequest,
    type HoshidictsProfileIdRequest,
    type HoshidictsRenameProfileRequest,
    type HoshidictsRenameDictionaryRequest,
    type HoshidictsRecommendedDictionaryId,
    type HoshidictsSchedule,
} from '../../../shared/features/hoshidicts.js';
import { getHoshidictsManager, type HoshidictsManager } from './manager.js';
import { fetchHoshidictsAudioSourceTest } from './audio_source_test.js';

export interface HoshidictsIPCDependencies {
    getMainWindow: () => BrowserWindow | null;
    getSettingsWindow: () => BrowserWindow | null;
    openSettingsWindow: () => Promise<BrowserWindow>;
    getOverlayRuntimeState: () => OverlayRuntimeState;
    getConfiguredFeatureEnabled: () => boolean;
    getOverlayFeatureEnabledAtLaunch: () => boolean | null;
    /** The preferences the running overlay is currently using, if any. */
    getAppliedReaderPreferences: () => HoshidictsReaderPreferencesRequest | null;
    getOverlayAudioProfileRestartRequired: () => boolean;
    applyReaderPreferences: (
        preferences: HoshidictsReaderPreferences
    ) => Promise<boolean>;
    applyAudioProfile: (profile: HoshidictsAudioProfile) => Promise<boolean>;
    getMiningOptions: (model?: string) => Promise<HoshidictsMiningOptions>;
    restartOverlay: () => Promise<boolean>;
}

/**
 * The ordinary manager operations all share one shape: validate the request,
 * call the manager, optionally push the result to a running reader, and report
 * one outcome. Describing them in a table keeps that boilerplate out of the
 * eighteen handlers that used to repeat it. Handlers with their own
 * requirements, such as file selection and audio source tests, stay
 * handwritten below.
 */
interface HoshidictsManagerAction {
    /** Message returned when the request is malformed; omit if it cannot be. */
    invalid?: string;
    accepts?: (request: never) => boolean;
    run: (
        request: never,
        deps: HoshidictsIPCDependencies
    ) => Promise<HoshidictsManagerSnapshot>;
    /** Deliver the resulting dictionary context to a running reader. */
    refreshesReader?: boolean;
    outcome: NonNullable<HoshidictsActionResult['outcome']>;
}

function isRequestRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyProfileName(value: unknown): boolean {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= MAX_HOSHIDICTS_PROFILE_NAME_LENGTH
    );
}

function isMoveDirection(value: unknown): value is HoshidictsMoveDirection {
    return value === -1 || value === 1;
}

function hoshidictsManagerActions(
    manager: HoshidictsManager
): Record<string, HoshidictsManagerAction> {
    return {
        [HOSHIDICTS_CHANNELS.createProfile]: {
            invalid: 'Profile name is invalid.',
            accepts: (request: Partial<HoshidictsCreateProfileRequest>) =>
                isNonEmptyProfileName(request.name),
            run: (request: HoshidictsCreateProfileRequest) =>
                manager.createProfile(request.name),
            outcome: { code: 'profileCreated' },
        },
        [HOSHIDICTS_CHANNELS.switchProfile]: {
            invalid: 'Profile switch request is invalid.',
            accepts: (request: Partial<HoshidictsProfileIdRequest>) =>
                typeof request.id === 'string',
            run: async (request: HoshidictsProfileIdRequest, deps) => {
                const state = await manager.switchProfile(request.id);
                await applyReaderAndAudioSnapshot(
                    state,
                    deps,
                    'The profile was switched, but its settings could not be applied to the running overlay. Restart the overlay to use the selected profile.'
                );
                return state;
            },
            outcome: { code: 'profileSwitched' },
        },
        [HOSHIDICTS_CHANNELS.renameProfile]: {
            invalid: 'Profile rename request is invalid.',
            accepts: (request: Partial<HoshidictsRenameProfileRequest>) =>
                typeof request.id === 'string' &&
                isNonEmptyProfileName(request.name),
            run: (request: HoshidictsRenameProfileRequest) =>
                manager.renameProfile(request.id, request.name),
            outcome: { code: 'profileRenamed' },
        },
        [HOSHIDICTS_CHANNELS.deleteProfile]: {
            invalid: 'Profile delete request is invalid.',
            accepts: (request: Partial<HoshidictsProfileIdRequest>) =>
                typeof request.id === 'string',
            run: async (request: HoshidictsProfileIdRequest, deps) => {
                const before = await manager.getSnapshot();
                const state = await manager.deleteProfile(request.id);
                if (before.activeProfileId === request.id) {
                    await applyReaderAndAudioSnapshot(
                        state,
                        deps,
                        'The profile was deleted, but the replacement profile could not be applied to the running overlay. Restart the overlay to use it.'
                    );
                }
                return state;
            },
            outcome: { code: 'profileDeleted' },
        },
        [HOSHIDICTS_CHANNELS.setSchedule]: {
            invalid: 'Dictionary update schedule is invalid.',
            accepts: isSchedule,
            run: (schedule: HoshidictsSchedule) =>
                manager.setSchedule(schedule),
            outcome: { code: 'preferencesSaved' },
        },
        [HOSHIDICTS_CHANNELS.setDictionarySchedule]: {
            invalid: 'Dictionary update schedule request is invalid.',
            accepts: (request: Partial<HoshidictsDictionaryScheduleRequest>) =>
                typeof request.id === 'string' &&
                (request.schedule === null || isSchedule(request.schedule)),
            run: (request: HoshidictsDictionaryScheduleRequest) =>
                manager.setDictionarySchedule(request.id, request.schedule),
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.setLookupMode]: {
            invalid: 'Hoshidicts lookup mode is invalid.',
            accepts: isLookupMode,
            run: (lookupMode: HoshidictsLookupMode) =>
                manager.setLookupMode(lookupMode),
            outcome: { code: 'preferencesSaved' },
        },
        [HOSHIDICTS_CHANNELS.setMiningProfile]: {
            // The manager validates the profile and reports its own message.
            run: (profile: unknown) => manager.setMiningProfile(profile),
            outcome: { code: 'miningProfileSaved' },
        },
        [HOSHIDICTS_CHANNELS.setDictionaryEnabled]: {
            invalid: 'Dictionary enable request is invalid.',
            accepts: (request: Partial<HoshidictsDictionaryEnabledRequest>) =>
                typeof request.id === 'string' &&
                typeof request.enabled === 'boolean',
            run: (request: HoshidictsDictionaryEnabledRequest) =>
                manager.setDictionaryEnabled(request.id, request.enabled),
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.setDictionaryPresentation]: {
            invalid: 'Dictionary presentation request is invalid.',
            accepts: (
                request: Partial<HoshidictsDictionaryPresentationRequest>
            ) =>
                typeof request.id === 'string' &&
                typeof request.favorite === 'boolean',
            run: (request: HoshidictsDictionaryPresentationRequest) =>
                manager.setDictionaryPresentation(request.id, request.favorite),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.createTabGroup]: {
            invalid: 'Tab group create request is invalid.',
            accepts: (request: Partial<HoshidictsCreateTabGroupRequest>) =>
                typeof request.name === 'string' &&
                (request.dictionaryId === undefined ||
                    typeof request.dictionaryId === 'string'),
            run: (request: HoshidictsCreateTabGroupRequest) =>
                manager.createTabGroup(request.name, request.dictionaryId),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.setTabGroupMembership]: {
            invalid: 'Tab group membership request is invalid.',
            accepts: (
                request: Partial<HoshidictsSetTabGroupMembershipRequest>
            ) =>
                typeof request.groupId === 'string' &&
                typeof request.dictionaryId === 'string' &&
                typeof request.member === 'boolean',
            run: (request: HoshidictsSetTabGroupMembershipRequest) =>
                manager.setTabGroupMembership(
                    request.groupId,
                    request.dictionaryId,
                    request.member
                ),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.renameTabGroup]: {
            invalid: 'Tab group rename request is invalid.',
            accepts: (request: Partial<HoshidictsRenameTabGroupRequest>) =>
                typeof request.groupId === 'string' &&
                typeof request.name === 'string',
            run: (request: HoshidictsRenameTabGroupRequest) =>
                manager.renameTabGroup(request.groupId, request.name),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.deleteTabGroup]: {
            invalid: 'Tab group delete request is invalid.',
            accepts: (request: Partial<HoshidictsDeleteTabGroupRequest>) =>
                typeof request.groupId === 'string',
            run: (request: HoshidictsDeleteTabGroupRequest) =>
                manager.deleteTabGroup(request.groupId),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.moveTabGroup]: {
            invalid: 'Tab group move request is invalid.',
            accepts: (request: Partial<HoshidictsMoveTabGroupRequest>) =>
                typeof request.groupId === 'string' &&
                isMoveDirection(request.direction),
            run: (request: HoshidictsMoveTabGroupRequest) =>
                manager.moveTabGroup(request.groupId, request.direction),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.renameDictionary]: {
            invalid: 'Dictionary rename request is invalid.',
            accepts: (request: Partial<HoshidictsRenameDictionaryRequest>) =>
                typeof request.id === 'string' &&
                (request.displayName === null ||
                    typeof request.displayName === 'string'),
            run: (request: HoshidictsRenameDictionaryRequest) =>
                manager.renameDictionary(request.id, request.displayName),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.moveDictionary]: {
            invalid: 'Dictionary move request is invalid.',
            accepts: (request: Partial<HoshidictsMoveDictionaryRequest>) =>
                typeof request.id === 'string' &&
                isMoveDirection(request.direction),
            run: (request: HoshidictsMoveDictionaryRequest) =>
                manager.moveDictionary(request.id, request.direction),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
        [HOSHIDICTS_CHANNELS.moveDictionaryToPosition]: {
            invalid: 'Dictionary position request is invalid.',
            accepts: (
                request: Partial<HoshidictsMoveDictionaryToPositionRequest>
            ) =>
                typeof request.id === 'string' &&
                Number.isInteger(request.position) &&
                (request.position as number) >= 1,
            run: (request: HoshidictsMoveDictionaryToPositionRequest) =>
                manager.moveDictionaryToPosition(request.id, request.position),
            refreshesReader: true,
            outcome: { code: 'dictionaryChanged' },
        },
    };
}

function registerHoshidictsManagerActions(
    manager: HoshidictsManager,
    deps: HoshidictsIPCDependencies
): void {
    for (const [channel, action] of Object.entries(
        hoshidictsManagerActions(manager)
    )) {
        ipcMain.handle(channel, async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            if (
                action.accepts &&
                !(
                    (isRequestRecord(request) ||
                        typeof request === 'string') &&
                    (action.accepts as (value: unknown) => boolean)(request)
                )
            ) {
                return await failedResult(deps, action.invalid);
            }
            return await runAction(
                deps,
                async () => {
                    const state = await (
                        action.run as (
                            value: unknown,
                            dependencies: HoshidictsIPCDependencies
                        ) => Promise<HoshidictsManagerSnapshot>
                    )(request, deps);
                    if (action.refreshesReader) {
                        await applyReaderSnapshot(state, deps);
                    }
                    return state;
                },
                // Copied so one invocation can never alter the table's entry.
                { ...action.outcome }
            );
        });
    }
}

let ipcRegistered = false;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isSchedule(value: unknown): value is HoshidictsSchedule {
    return (
        value === 'off' ||
        value === 'hourly' ||
        value === 'daily' ||
        value === 'weekly' ||
        value === 'monthly'
    );
}

function isLookupMode(value: unknown): value is HoshidictsLookupMode {
    return value === 'shift' || value === 'hover';
}

/** A running overlay only needs a restart when it is using something else. */
function readerPreferencesMatchOverlay(
    preferences: HoshidictsReaderPreferencesRequest,
    deps: HoshidictsIPCDependencies
): boolean {
    return hoshidictsReaderPreferencesEqual(
        preferences,
        deps.getAppliedReaderPreferences()
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

async function applyReaderAndAudioSnapshot(
    snapshot: HoshidictsManagerSnapshot,
    deps: HoshidictsIPCDependencies,
    failureMessage: string
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
        throw new Error(failureMessage);
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

/** Returns the settings window, which is by definition the verified sender. */
function assertSettingsSender(
    event: IpcMainInvokeEvent,
    deps: HoshidictsIPCDependencies
): BrowserWindow {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow !== deps.getSettingsWindow()) {
        throw new Error('Hoshidicts settings request came from an invalid window.');
    }
    return senderWindow;
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
    const appliedPreferences = deps.getAppliedReaderPreferences();
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
                        appliedPreferences !== null &&
                        !hoshidictsReaderPreferencesEqual(
                            normalizeHoshidictsReaderPreferences(snapshot),
                            appliedPreferences
                        )) ||
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

async function failedResult(
    deps: HoshidictsIPCDependencies,
    error: string | undefined
): Promise<HoshidictsActionResult> {
    return { success: false, error, state: await currentState(deps) };
}

async function canceledResult(
    deps: HoshidictsIPCDependencies
): Promise<HoshidictsActionResult> {
    return { success: false, canceled: true, state: await currentState(deps) };
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
        return await failedResult(deps, errorMessage(error));
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

    registerHoshidictsManagerActions(manager, deps);

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
                return await failedResult(deps, 'Custom dictionary save request is invalid or too large.');
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
                return await failedResult(deps, errorMessage(error));
            }
        }
    );

    ipcMain.handle(HOSHIDICTS_CHANNELS.importDictionary, async (event) => {
        const settingsWindow = assertSettingsSender(event, deps);
        const options: OpenDialogOptions = {
            title: 'Import Hoshidicts Dictionaries',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Yomitan Dictionary', extensions: ['zip'] }],
        };
        const result = await dialog.showOpenDialog(settingsWindow, options);
        if (result.canceled || result.filePaths.length === 0) {
            return await canceledResult(deps);
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

    ipcMain.handle(HOSHIDICTS_CHANNELS.exportBackup, async (event) => {
        const settingsWindow = assertSettingsSender(event, deps);
        const options: SaveDialogOptions = {
            title: 'Export Hoshidicts Backup',
            defaultPath: backupDefaultFileName(),
            filters: [{ name: 'Hoshidicts Backup', extensions: ['zip'] }],
        };
        const result = await dialog.showSaveDialog(settingsWindow, options);
        if (result.canceled || !result.filePath) {
            return await canceledResult(deps);
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
            return await failedResult(deps, errorMessage(error));
        }
    });

    ipcMain.handle(HOSHIDICTS_CHANNELS.restoreBackup, async (event) => {
        const settingsWindow = assertSettingsSender(event, deps);
        const options: OpenDialogOptions = {
            title: 'Restore Hoshidicts Backup',
            properties: ['openFile'],
            filters: [{ name: 'Hoshidicts Backup', extensions: ['zip'] }],
        };
        const result = await dialog.showOpenDialog(settingsWindow, options);
        if (result.canceled || result.filePaths.length === 0) {
            return await canceledResult(deps);
        }

        const confirmation = await dialog.showMessageBox(settingsWindow, {
            type: 'warning',
            title: 'Restore Hoshidicts Backup',
            message: 'Replace all Hoshidicts data with this backup?',
            detail: 'This replaces all installed dictionaries, tab groups, reader settings, mining and audio settings, and the custom dictionary. The restore cannot be undone unless you export the current Hoshidicts data first.',
            buttons: ['Restore Backup', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        });
        if (confirmation.response !== 0) {
            return await canceledResult(deps);
        }

        try {
            const state = await manager.restoreBackup(result.filePaths[0]);
            await applyReaderAndAudioSnapshot(
                state,
                deps,
                'Backup was restored, but its settings could not be applied to the running overlay. Restart the overlay to use the restored settings.'
            );
            return {
                success: true,
                outcome: { code: 'backupRestored' },
                state: withDesktopState(state, deps),
            } satisfies HoshidictsActionResult;
        } catch (error) {
            return await failedResult(deps, errorMessage(error));
        }
    });

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.installAllRecommended,
        async (event) => {
            assertSettingsSender(event, deps);
            const before = await manager.getSnapshot();
            const missingCount = before.recommendedDictionaries.filter(
                (dictionary) => !dictionary.installed
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
                return await failedResult(deps, 'Recommended dictionary id is invalid.');
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
            const settingsWindow = assertSettingsSender(event, deps);
            if (typeof id !== 'string') {
                return await failedResult(deps, 'Dictionary id is invalid.');
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
            const options = {
                type: 'warning' as const,
                title: 'Remove Hoshidicts Dictionary',
                message: `Remove "${dictionary.title}"?`,
                detail: 'The dictionary will be removed from lookups immediately.',
                buttons: ['Remove', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            };
            const confirmation = await dialog.showMessageBox(settingsWindow, options);
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
        HOSHIDICTS_CHANNELS.setReaderPreferences,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            let requestPreferences: HoshidictsReaderPreferencesRequest;
            try {
                requestPreferences = assertHoshidictsReaderPreferences(request);
            } catch {
                return await failedResult(deps, 'Hoshidicts reader preferences are invalid.');
            }
            return await runAction(
                deps,
                async () => {
                    const state =
                        await manager.setReaderPreferences(requestPreferences);
                    // Deliver what was actually saved. Overlaying the request
                    // back on top would push a value the manager had coerced,
                    // leaving the restart banner permanently disagreeing with it.
                    const preferences =
                        hoshidictsReaderPreferencesFromSnapshot(state);
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
        HOSHIDICTS_CHANNELS.testAudioSource,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as
                | Partial<HoshidictsAudioSourceTestRequest>
                | null;
            if (
                !value ||
                !value.profile ||
                typeof value.profile !== 'object' ||
                typeof value.sourceId !== 'string' ||
                !/^[A-Za-z0-9._-]{1,128}$/u.test(value.sourceId)
            ) {
                return {
                    success: false,
                    error: 'Hoshidicts audio source test request is invalid.',
                    state: await currentState(deps),
                } satisfies HoshidictsAudioSourceTestResult;
            }

            let savedState: HoshidictsManagerSnapshot | null = null;
            try {
                savedState = await manager.setAudioProfile(value.profile);
                await deps.applyAudioProfile(savedState.audioProfile);
                const source = savedState.audioProfile.sources.find(
                    ({ id }) => id === value.sourceId
                );
                if (!source) {
                    throw new Error(
                        'The selected Hoshidicts audio source no longer exists.'
                    );
                }
                if (
                    source.type === 'text-to-speech' ||
                    source.type === 'text-to-speech-reading'
                ) {
                    throw new Error(
                        'This source uses local speech synthesis and must be tested in the settings window.'
                    );
                }
                const audio = await fetchHoshidictsAudioSourceTest(source.id);
                return {
                    success: true,
                    audio,
                    state: withDesktopState(savedState, deps),
                } satisfies HoshidictsAudioSourceTestResult;
            } catch (error) {
                return {
                    success: false,
                    error: errorMessage(error),
                    state: savedState
                        ? withDesktopState(savedState, deps)
                        : await currentState(deps),
                } satisfies HoshidictsAudioSourceTestResult;
            }
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
        HOSHIDICTS_CHANNELS.bulkDictionaryAction,
        async (event, request: unknown) => {
            assertSettingsSender(event, deps);
            const value = request as
                | Partial<HoshidictsBulkDictionaryActionRequest>
                | null;
            if (
                !value ||
                (value.action !== 'enable' &&
                    value.action !== 'disable' &&
                    value.action !== 'favorite' &&
                    value.action !== 'unfavorite' &&
                    value.action !== 'update') ||
                !Array.isArray(value.ids) ||
                value.ids.length === 0 ||
                value.ids.length > 4096 ||
                value.ids.some(
                    (id) =>
                        typeof id !== 'string' ||
                        !/^[A-Za-z0-9._-]{1,128}$/u.test(id)
                )
            ) {
                return await failedResult(deps, 'Bulk dictionary action request is invalid.');
            }
            const ids = [...new Set(value.ids)];
            const action = value.action;
            return await runAction(
                deps,
                async () => {
                    const applyAction = async (): Promise<HoshidictsManagerSnapshot> => {
                        switch (action) {
                            case 'enable':
                                return await manager.setDictionariesEnabled(
                                    ids,
                                    true
                                );
                            case 'disable':
                                return await manager.setDictionariesEnabled(
                                    ids,
                                    false
                                );
                            case 'favorite':
                                return await manager.setDictionariesPresentation(
                                    ids,
                                    true
                                );
                            case 'unfavorite':
                                return await manager.setDictionariesPresentation(
                                    ids,
                                    false
                                );
                            case 'update':
                                return await manager.checkForUpdates(true, ids);
                        }
                        throw new Error('Bulk dictionary action is invalid.');
                    };
                    const state = await applyAction();
                    await applyReaderSnapshot(state, deps);
                    if (action === 'update' && state.lastError) {
                        throw new Error(state.lastError);
                    }
                    return state;
                },
                {
                    code:
                        action === 'update'
                            ? 'updatesChecked'
                            : 'dictionaryChanged',
                    count: ids.length,
                }
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
            return await failedResult(deps, errorMessage(error));
        }
    });
}
