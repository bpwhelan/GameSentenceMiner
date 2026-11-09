import { app, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { store } from '../store.js';
import { getCurrentScene, getExecutableNameFromSource, getWindowTitleFromSource } from '../ui/obs.js';
import { chooseGameExecutable, GameLaunchError, GameLauncherService } from './game_launcher.js';
import type { GameLaunchOptions, GameLaunchResult } from '../../shared/game_launcher.js';

async function detectCapturedExecutable(sceneId: string): Promise<string | null> {
    try {
        const [name, title] = await Promise.all([getExecutableNameFromSource(sceneId), getWindowTitleFromSource(sceneId)]);
        if (!name) return null;
        // Load the Windows addon only on Windows, and tolerate inaccessible processes.
        const { windowManager } = await import('node-window-manager');
        const windows = windowManager.getWindows().flatMap(window => {
            try { return [{ path: window.path, title: window.getTitle() }]; }
            catch { return []; }
        });
        return chooseGameExecutable(windows, name, title ?? '');
    } catch { return null; }
}

async function isFile(filename: string): Promise<boolean> {
    try { return (await stat(filename)).isFile(); } catch { return false; }
}

export function registerGameLauncherIPC(): void {
    const service = new GameLauncherService({
        platform: process.platform,
        load: sceneId => store.get('gameLaunchProfiles', {})[sceneId],
        save: (sceneId, options) => store.set('gameLaunchProfiles', { ...store.get('gameLaunchProfiles', {}), [sceneId]: options }),
        detect: detectCapturedExecutable,
        isFile,
        isDirectory: async filename => { try { return (await stat(filename)).isDirectory(); } catch { return false; } },
        spawn,
    });
    ipcMain.handle('game-launcher.getOptions', (_event, sceneId: string) => service.getOptions(sceneId));
    ipcMain.handle('game-launcher.detect', (_event, sceneId: string) => service.detect(sceneId));
    const result = async (work: () => Promise<unknown>): Promise<GameLaunchResult> => {
        try { await work(); return { success: true }; }
        catch (error) {
            return { success: false, code: error instanceof GameLaunchError ? error.code : 'failed', error: String((error as Error).message ?? error) };
        }
    };
    ipcMain.handle('game-launcher.save', (_event, sceneId: string, options: GameLaunchOptions) => result(() => service.saveOptions(sceneId, options)));
    ipcMain.handle('game-launcher.launch', (_event, sceneId: string) => result(() => service.launch(sceneId)));
    ipcMain.handle('game-launcher.browse', async (_event, kind: 'executable' | 'directory') => {
        if (process.platform !== 'win32') throw new GameLaunchError('unsupported');
        const picked = await dialog.showOpenDialog({
            properties: [kind === 'directory' ? 'openDirectory' : 'openFile'],
            ...(kind === 'directory' ? {} : { filters: [{ name: 'Windows executable', extensions: ['exe', 'com'] }, { name: 'All files', extensions: ['*'] }] }),
        });
        return picked.canceled ? null : picked.filePaths[0] ?? null;
    });

    if (process.platform !== 'win32') return;
    // Remember the active capture even while Home is closed. Discovery never launches anything.
    let polling = false;
    const remember = async () => {
        if (polling) return;
        polling = true;
        try {
            const scene = await getCurrentScene();
            if (scene?.id) await service.getOptions(scene.id);
        } catch { /* OBS or the game may be unavailable. Browse remains available. */ }
        finally { polling = false; }
    };
    const timer = setInterval(() => void remember(), 10_000);
    timer.unref();
    app.once('will-quit', () => clearInterval(timer));
}
