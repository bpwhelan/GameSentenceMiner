import {
    BrowserWindow,
    dialog,
    ipcMain,
    type IpcMainInvokeEvent,
    type OpenDialogOptions,
} from 'electron';

import type { OverlayRuntimeState } from '../../ui/front.js';
import {
    HOSHIDICTS_CHANNELS,
    type HoshidictsActionResult,
    type HoshidictsDesktopSnapshot,
    type HoshidictsDictionaryEnabledRequest,
    type HoshidictsInstallRecommendedRequest,
    type HoshidictsManagerSnapshot,
    type HoshidictsLookupMode,
    type HoshidictsMiningOptions,
    type HoshidictsMoveDictionaryRequest,
    type HoshidictsRecommendedDictionaryId,
    type HoshidictsSchedule,
} from '../../../shared/features/hoshidicts.js';
import { getHoshidictsManager } from './manager.js';

export interface HoshidictsIPCDependencies {
    getMainWindow: () => BrowserWindow | null;
    getSettingsWindow: () => BrowserWindow | null;
    openSettingsWindow: () => Promise<BrowserWindow>;
    getOverlayRuntimeState: () => OverlayRuntimeState;
    getConfiguredFeatureEnabled: () => boolean;
    getOverlayFeatureEnabledAtLaunch: () => boolean | null;
    getOverlayLookupModeAtLaunch: () => HoshidictsLookupMode | null;
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

function isRecommendedDictionaryId(
    value: unknown
): value is HoshidictsRecommendedDictionaryId {
    return value === 'jmdict' || value === 'jmnedict';
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
                        lookupModeAtLaunch !== snapshot.lookupMode)),
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
    action: () => Promise<HoshidictsManagerSnapshot>
): Promise<HoshidictsActionResult> {
    try {
        return {
            success: true,
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

    ipcMain.handle(HOSHIDICTS_CHANNELS.importDictionary, async (event) => {
        assertSettingsSender(event, deps);
        const settingsWindow = deps.getSettingsWindow();
        const options: OpenDialogOptions = {
            title: 'Import Hoshidicts Dictionary',
            properties: ['openFile'],
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
            async () => await manager.importDictionary(result.filePaths[0])
        );
    });

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.installAllRecommended,
        async (event) => {
            assertSettingsSender(event, deps);
            return await runAction(
                deps,
                async () => await manager.installRecommendedDictionaries()
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
                async () => await manager.installRecommendedDictionary(id)
            );
        }
    );

    ipcMain.handle(HOSHIDICTS_CHANNELS.checkUpdates, async (event) => {
        assertSettingsSender(event, deps);
        return await runAction(deps, async () => {
            const state = await manager.checkForUpdates(true);
            if (state.lastError) {
                throw new Error(state.lastError);
            }
            return state;
        });
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
                async () => await manager.removeDictionary(id)
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
                async () => await manager.setSchedule(schedule)
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
                async () => await manager.setLookupMode(lookupMode)
            );
        }
    );

    ipcMain.handle(
        HOSHIDICTS_CHANNELS.setMiningProfile,
        async (event, profile: unknown) => {
            assertSettingsSender(event, deps);
            return await runAction(
                deps,
                async () => await manager.setMiningProfile(profile)
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
                    )
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
                async () =>
                    await manager.moveDictionary(
                        value.id as string,
                        value.direction as -1 | 1
                    )
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
