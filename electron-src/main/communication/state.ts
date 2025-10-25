/**
 * IPC handlers for runtime state management
 * Provides cross-window/iframe state synchronization
 */

import { ipcMain } from 'electron';
import { runtimeState } from '../store.js';

export function registerStateIPC(): void {
    // Get a state value
    ipcMain.handle('state.get', (_event, key: string) => {
        return runtimeState.get(key);
    });

    // Set a state value
    ipcMain.handle('state.set', (_event, key: string, value: any) => {
        runtimeState.set(key, value);
    });

    // Remove a state value
    ipcMain.handle('state.remove', (_event, key: string) => {
        runtimeState.remove(key);
    });

    // Get all state
    ipcMain.handle('state.getAll', () => {
        return runtimeState.getAll();
    });

    // Clear all state
    ipcMain.handle('state.clear', () => {
        runtimeState.clear();
    });
}
