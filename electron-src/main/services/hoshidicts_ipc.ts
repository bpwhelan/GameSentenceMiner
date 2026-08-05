import { dialog, ipcMain, type BrowserWindow } from 'electron';

import { getConfiguredHoshidictsEnabled } from '../gsm_config.js';
import {
    getHoshidictsManager,
    type HoshidictsManagerSnapshot,
    type HoshidictsSchedule,
} from './hoshidicts_manager.js';

interface HoshidictsIPCDependencies {
    getMainWindow: () => BrowserWindow | null;
}

export interface HoshidictsDesktopSnapshot extends HoshidictsManagerSnapshot {
    effectiveEnabled: boolean;
}

let ipcRegistered = false;

function withEffectiveState(
    snapshot: HoshidictsManagerSnapshot
): HoshidictsDesktopSnapshot {
    return {
        ...snapshot,
        effectiveEnabled: getConfiguredHoshidictsEnabled(),
    };
}

function isSchedule(value: unknown): value is HoshidictsSchedule {
    return (
        value === 'off' ||
        value === 'daily' ||
        value === 'weekly' ||
        value === 'monthly'
    );
}

export function registerHoshidictsIPC(deps: HoshidictsIPCDependencies): void {
    if (ipcRegistered) {
        return;
    }
    ipcRegistered = true;

    const manager = getHoshidictsManager();
    manager.subscribe((snapshot) => {
        const mainWindow = deps.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
                'hoshidicts.progress',
                withEffectiveState(snapshot)
            );
        }
    });

    ipcMain.handle('hoshidicts.getState', async () => {
        return withEffectiveState(await manager.getSnapshot());
    });

    ipcMain.handle('hoshidicts.import', async () => {
        const mainWindow = deps.getMainWindow();
        const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, {
                  title: 'Import Hoshidicts Dictionary',
                  properties: ['openFile'],
                  filters: [
                      { name: 'Yomitan Dictionary', extensions: ['zip'] },
                  ],
              })
            : await dialog.showOpenDialog({
                  title: 'Import Hoshidicts Dictionary',
                  properties: ['openFile'],
                  filters: [
                      { name: 'Yomitan Dictionary', extensions: ['zip'] },
                  ],
              });
        if (result.canceled || result.filePaths.length === 0) {
            return {
                success: false,
                canceled: true,
                state: withEffectiveState(await manager.getSnapshot()),
            };
        }
        try {
            return {
                success: true,
                state: withEffectiveState(
                    await manager.importDictionary(result.filePaths[0])
                ),
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                state: withEffectiveState(await manager.getSnapshot()),
            };
        }
    });

    ipcMain.handle('hoshidicts.remove', async (_event, id: unknown) => {
        if (typeof id !== 'string') {
            return {
                success: false,
                error: 'Dictionary id is invalid.',
                state: withEffectiveState(await manager.getSnapshot()),
            };
        }
        const currentState = await manager.getSnapshot();
        const dictionary = currentState.dictionaries.find((entry) => entry.id === id);
        if (!dictionary) {
            return {
                success: false,
                error: 'Dictionary is not installed.',
                state: withEffectiveState(currentState),
            };
        }
        const mainWindow = deps.getMainWindow();
        const confirmationOptions = {
            type: 'warning' as const,
            title: 'Remove Hoshidicts Dictionary',
            message: `Remove "${dictionary.title}"?`,
            detail: 'The dictionary will be removed from the overlay immediately.',
            buttons: ['Remove', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        };
        const confirmation = mainWindow
            ? await dialog.showMessageBox(mainWindow, confirmationOptions)
            : await dialog.showMessageBox(confirmationOptions);
        if (confirmation.response !== 0) {
            return {
                success: false,
                canceled: true,
                state: withEffectiveState(currentState),
            };
        }
        try {
            return {
                success: true,
                state: withEffectiveState(await manager.removeDictionary(id)),
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                state: withEffectiveState(await manager.getSnapshot()),
            };
        }
    });

    ipcMain.handle('hoshidicts.checkUpdates', async () => {
        try {
            const state = await manager.checkForUpdates(true);
            return {
                success: state.lastError === null,
                error: state.lastError,
                state: withEffectiveState(state),
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                state: withEffectiveState(await manager.getSnapshot()),
            };
        }
    });

    ipcMain.handle('hoshidicts.setSchedule', async (_event, schedule: unknown) => {
        if (!isSchedule(schedule)) {
            return {
                success: false,
                error: 'Dictionary update schedule is invalid.',
                state: withEffectiveState(await manager.getSnapshot()),
            };
        }
        try {
            return {
                success: true,
                state: withEffectiveState(await manager.setSchedule(schedule)),
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                state: withEffectiveState(await manager.getSnapshot()),
            };
        }
    });
}
