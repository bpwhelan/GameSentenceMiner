import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { BASE_DIR, getOverlayPath, getResourcesDir, isDev } from '../util.js';
import {
    getFrontPageState,
    getSteamGames,
    getVNs,
    getYuzuRomsPath,
    LaunchableGame,
    HookableGameType,
    OCRGame,
    setFrontPageState,
} from '../store.js';
import { getConfiguredYuzuGames, getYuzuGames } from './yuzu.js';
import { getOBSConnection, getOBSScenes } from './obs.js';
import { getSceneOCRConfig } from './ocr.js';

const OCR_CONFIG_DIR = path.join(BASE_DIR, 'ocr_config');

export function registerFrontPageIPC() {
    // Save the front page state
    ipcMain.handle('front.saveState', async (_, state: any) => {
        try {
            const { hookableGames, ocrGames, ...restState } = state;
            setFrontPageState(restState); // Use the store method to save the state without hookableGames and ocrGames
            return { status: 'success', message: 'State saved successfully' };
        } catch (error) {
            console.error('Error saving front page state:', error);
            return { status: 'error', message: 'Failed to save state' };
        }
    });

    // Get the saved front page state
    ipcMain.handle('front.getSavedState', async () => {
        try {
            const state = getFrontPageState(); // Use the store method to retrieve the state
            const vns = getVNs();
            const steamGames = getSteamGames();
            const yuzuGames = getConfiguredYuzuGames();
            // Combine the games into a single array for hookable games

            state.launchableGames = [
                {
                    name: 'Game',
                    id: '0',
                    type: HookableGameType.None,
                    isHeader: true,
                    scene: undefined,
                },
                ...steamGames.map((game) => ({
                    name: game.name,
                    id: String(game.id),
                    type: HookableGameType.Steam,
                    scene: game.scene,
                })),
                // {name: "Misc/VN", id: "0", type: HookableGameType.None, isHeader: true, scene: undefined},
                // ...vns.map(vn => ({name: vn.path, id: vn.path, type: HookableGameType.VN, scene: vn.scene})),
                {
                    name: 'Yuzu',
                    id: '0',
                    type: HookableGameType.None,
                    isHeader: true,
                    scene: undefined,
                },
                ...yuzuGames.map((game) => ({
                    name: game.name,
                    id: game.id,
                    type: HookableGameType.Yuzu,
                    scene: game.scene,
                })),
            ];

            return state || null;
        } catch (error) {
            console.error('Error retrieving saved front page state:', error);
            return null;
        }
    });

    // Get all OCR configs
    ipcMain.handle('front.getAllOCRConfigs', async () => {
        return await getAllOCRConfigs();
    });

    ipcMain.handle('open-external-link', async (_, url: string) => {
        const { shell } = await import('electron');
        await shell.openExternal(url);
    });

    let overlayProcess: any = null;

    ipcMain.handle('runOverlay', async () => {
        if (overlayProcess && overlayProcess.exitCode === null) {
            console.log('Overlay is already running.');
            return;
        }
        // if (isDev) {
        //     const { spawn } = await import('child_process');
        //     console.log(path.join(getResourcesDir(), 'GSM_Overlay'))
        //     const overlayDir = path.join(getResourcesDir(), 'GSM_Overlay');
        //     if (!fs.existsSync(overlayDir)) {
        //         console.error('Overlay directory does not exist:', overlayDir);
        //         return;
        //     }
        //     overlayProcess = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start'], { detached: false, stdio: ['ignore', 'ignore', 'ignore'], cwd: overlayDir });
        // } else {
        const overlayPath = path.join(getOverlayPath(), 'overlay.exe');
        if (fs.existsSync(overlayPath)) {
            const { spawn } = await import('child_process');
            overlayProcess = spawn(overlayPath, [], { detached: false, stdio: 'ignore' });
            console.log('Overlay launched successfully.');
        } else {
            console.error('Overlay executable not found at:', overlayPath);
        }
        // }
    });
}

async function getAllOCRConfigs(): Promise<OCRGame[]> {
    // try {
    await getOBSConnection();
    const scenes = await getOBSScenes();
    return scenes
        .filter((scene) => fs.existsSync(getSceneOCRConfig(scene)))
        .map((scene) => {
            return {
                scene: scene,
                configPath: getSceneOCRConfig(scene),
            } as OCRGame;
        });
    //     const files = await fs.promises.readdir(OCR_CONFIG_DIR);
    //
    //     const configs = await Promise.all(
    //         files
    //             .filter(file => file.endsWith('.json'))
    //             .map(async file => {
    //             const filePath = path.join(OCR_CONFIG_DIR, file);
    //             const content = await fs.promises.readFile(filePath, 'utf-8');
    //             const json = JSON.parse(content);
    //             if (json.scene) {
    //                     return { scene: json.scene, configPath: filePath };
    //         }
    //                 return null;
    //             })
    //     );
    //
    //     // Filter out any null values
    //     return configs.filter(config => config !== null) as OCRGame[];
    // } catch (error) {
    //     console.error('Error getting OCR configs:', error);
    //     return [];
    // }
}
