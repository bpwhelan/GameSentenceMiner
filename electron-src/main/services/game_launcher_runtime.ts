import { app, dialog, ipcMain } from 'electron';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { store } from '../store.js';
import { getCurrentScene, getExecutableNameFromSource, getWindowTitleFromSource } from '../ui/obs.js';
import { chooseGameExecutable, GameLaunchError, GameLauncherService } from './game_launcher.js';
import type { GameLaunchOptions, GameLaunchResult } from '../../shared/game_launcher.js';
import { launchGameAsUser } from '../runtime/windows_game_launcher.js';
import { listCaptureWindows } from '../runtime/capture_windows.js';

async function getLegacyYuzuOptions(sceneId: string): Promise<Partial<GameLaunchOptions> | null> {
    const config = store.get('yuzu');
    const game = config?.games?.find(game => game.scene?.id === sceneId);
    if (!game || !config.emuPath || !config.romsPath) return null;
    try {
        const files = await readdir(config.romsPath, { withFileTypes: true });
        const matches = files.filter(file => file.isFile() && /\.(nsp|xci|nca|nro|nso)$/i.test(file.name) &&
            /[\[(](\w+)[\])]/.exec(file.name)?.[1].toLowerCase() === game.id.toLowerCase());
        // Do not choose between duplicate ROMs or editions with the same title ID.
        if (matches.length !== 1) return null;
        return { mode: 'yuzu', executablePath: config.emuPath, romPath: path.win32.join(config.romsPath, matches[0].name) };
    } catch { return null; }
}

async function detectCapturedExecutable(sceneId: string): Promise<string | null> {
    try {
        const [name, title] = await Promise.all([getExecutableNameFromSource(sceneId), getWindowTitleFromSource(sceneId)]);
        if (!name) return null;
        const windows = await listCaptureWindows();
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
        defaults: getLegacyYuzuOptions,
        isFile,
        isDirectory: async filename => { try { return (await stat(filename)).isDirectory(); } catch { return false; } },
        launch: launchGameAsUser,
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
    ipcMain.handle('game-launcher.browse', async (_event, kind: 'executable' | 'directory' | 'rom') => {
        if (process.platform !== 'win32') throw new GameLaunchError('unsupported');
        const picked = await dialog.showOpenDialog({
            properties: [kind === 'directory' ? 'openDirectory' : 'openFile'],
            ...(kind === 'directory' ? {} : { filters: [
                kind === 'rom' ? { name: 'Switch ROM', extensions: ['nsp', 'xci', 'nca', 'nro', 'nso'] }
                    : { name: 'Windows executable', extensions: ['exe', 'com'] },
                { name: 'All files', extensions: ['*'] },
            ] }),
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
