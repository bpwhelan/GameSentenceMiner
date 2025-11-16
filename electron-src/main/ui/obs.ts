// electron-src/main/launchers/obs.ts
import { BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import { BASE_DIR, getAssetsDir, isLinux, isWindows, isWindows10OrHigher } from '../util.js';
import { isQuitting } from '../main.js';
import { exec } from 'child_process';
import OBSWebSocket from 'obs-websocket-js';
import Store from 'electron-store';
import * as fs from 'node:fs';
import { sendStartOBS, sendQuitOBS } from '../main.js';
import axios from 'axios';
import { getObsOcrScenes } from '../store.js';
import { startOCR } from './ocr.js';

interface ObsConfig {
    host: string;
    port: number;
    password: string;
}

export interface ObsScene {
    name: string;
    id: string;
}

export let pythonConfig: Store | null = null;
try {
    pythonConfig = new Store();
} catch (error) {
    console.error('Failed to load pythonConfig store, using empty config.', error);
    // pythonConfig = new Store({defaults: {}});
}

let obsConfig: ObsConfig = (pythonConfig?.get('configs.Default.obs') as ObsConfig) || {
    host: 'localhost',
    port: 7274,
    password: '',
};

const OBS_CONFIG_PATH = path.join(BASE_DIR, 'obs-studio');
const SCENE_CONFIG_PATH = path.join(OBS_CONFIG_PATH, 'config', 'obs-studio', 'basic', 'scenes');
let obs = new OBSWebSocket();
let obsConnected = false;
const HELPER_SCENE = 'GSM Helper';
const WINDOW_GETTER_INPUT = 'window_getter';
const GAME_WINDOW_INPUT = 'game_window_getter';
let sceneSwitcherRegistered = false;

let connectionPromise: Promise<void> | null = null;

// Utility function to escape regex special characters in window titles
function escapeRegexCharacters(str: string): string {
    // Escape all regex special characters that could break the auto scene switcher
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Generate a random fallback window name
function generateFallbackWindowName(): string {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `Scene-${dateStr}`;
}

// Shared scene creation logic
async function createSceneWithCapture(window: any, captureType: 'window' | 'game'): Promise<void> {
    await getOBSConnection();

    const windowTitle = window.title;
    const sceneName = `${window.sceneName}`;
    let sceneExisted = false;
    try {
        // Try to create the scene
        await obs.call('CreateScene', { sceneName });
    } catch (error: any) {
        // If the scene already exists, wipe all sources from the scene
        if (error && error.code === 601) {
            sceneExisted = true;
        } else {
            throw error;
        }
    }

    // If the scene existed, remove all sources from it
    if (sceneExisted) {
        try {
            const sceneItems = await obs.call('GetSceneItemList', { sceneName });
            for (const item of sceneItems.sceneItems) {
                // Remove each input/source from the scene
                if (typeof item.sourceName === 'string') {
                    try {
                        await obs.call('RemoveInput', { inputName: item.sourceName });
                    } catch (removeErr) {
                        // Ignore errors if input doesn't exist or can't be removed
                    }
                }
            }
        } catch (wipeErr) {
            // Ignore errors wiping scene
        }
    }

    // Set the new scene as the current program scene
    await obs.call('SetCurrentProgramScene', { sceneName });

    // Configure input settings based on capture type
    let request: any = {
        sceneName,
        inputName: `${windowTitle} - ${captureType === 'window' ? 'Capture' : 'Game Capture'}`,
        inputKind: captureType === 'window' ? 'window_capture' : 'game_capture',
        inputSettings: {
            window: window.value,
            capture_audio: true,
        },
    };

    if (captureType === 'window') {
        request.inputSettings.mode = 'window';
        request.inputSettings.cursor = false;

        if (isWindows10OrHigher()) {
            request.inputSettings.method = 2;
        }
    } else {
        request.inputSettings.capture_mode = 'window';
        request.inputSettings.capture_cursor = false;
    }

    // Always create the input now (scene is fresh)
    await obs.call('CreateInput', request);

    // Configure auto scene switcher with escaped window title
    await modifyAutoSceneSwitcherInJSON(sceneName, windowTitle);

    console.log(`Scene and ${captureType} capture setup for window: ${windowTitle}`);
}

async function modifyAutoSceneSwitcherInJSON(
    sceneName: string,
    windowTitle: string
): Promise<void> {
    try {
        await getOBSConnection();
        sendQuitOBS();
        const currentSceneCollection = await obs.call('GetSceneCollectionList');
        const sceneCollectionName = currentSceneCollection.currentSceneCollectionName;

        const sceneCollectionPath = path.join(
            SCENE_CONFIG_PATH,
            `${sceneCollectionName}.json`.replace(' ', '_')
        );

        const fileContent = await fs.promises.readFile(sceneCollectionPath, 'utf-8');
        const sceneCollection = JSON.parse(fileContent);

        let autoSceneSwitcher = sceneCollection['modules']['auto-scene-switcher'];

        if (!autoSceneSwitcher) {
            sceneCollection['modules']['auto-scene-switcher'] = {
                interval: 300,
                non_matching_scene: '',
                switch_if_not_matching: false,
                active: true,
                switches: [],
            };
            autoSceneSwitcher = sceneCollection['modules']['auto-scene-switcher'];
        }

        // Escape regex special characters in the window title
        const escapedWindowTitle = escapeRegexCharacters(windowTitle);

        if (!autoSceneSwitcher.active) {
            dialog
                .showMessageBox(obsWindow!, {
                    type: 'question',
                    buttons: ['Yes', 'No'],
                    defaultId: 0,
                    title: 'Enable Auto Scene Switcher',
                    message: 'Do you want to enable the auto scene switcher?',
                })
                .then(async (response) => {
                    if (response.response === 0) {
                        autoSceneSwitcher.active = true;
                    }
                    autoSceneSwitcher.switches.push({
                        scene: sceneName,
                        window_title: escapedWindowTitle,
                    });

                    sceneCollection['modules']['auto-scene-switcher'] = autoSceneSwitcher;

                    const updatedContent = JSON.stringify(sceneCollection, null, 2);
                    await fs.promises.writeFile(sceneCollectionPath, updatedContent, 'utf-8');
                    await fs.promises.writeFile(
                        path.join(BASE_DIR, 'scene_config.json'),
                        updatedContent,
                        'utf-8'
                    );

                    console.log(`Auto-scene-switcher settings updated for "${sceneName}" in JSON.`);
                    sendStartOBS();
                    await connectOBSWebSocket();
                });
        } else {
            autoSceneSwitcher.switches.push({
                scene: sceneName,
                window_title: escapedWindowTitle,
            });

            sceneCollection['modules']['auto-scene-switcher'] = autoSceneSwitcher;

            const updatedContent = JSON.stringify(sceneCollection, null, 2);
            await fs.promises.writeFile(sceneCollectionPath, updatedContent, 'utf-8');
            await fs.promises.writeFile(
                path.join(BASE_DIR, 'scene_config.json'),
                updatedContent,
                'utf-8'
            );

            console.log(`Auto-scene-switcher settings updated for "${sceneName}" in JSON.`);
            sendStartOBS();
            await connectOBSWebSocket();
        }
    } catch (error: any) {
        console.error(`Error modifying auto-scene-switcher settings:`, error.message);
        throw error;
    }
}

async function connectOBSWebSocket(retries = 5, delay = 2000): Promise<void> {
    await obs.connect(`ws://${obsConfig.host}:${obsConfig.port}`, obsConfig.password);
    const obsOcrScenes = getObsOcrScenes();
    if (obsOcrScenes && obsOcrScenes.length > 0) {
        getCurrentScene().then((scene) => {
            if (obsOcrScenes.includes(scene.name)) {
                startOCR();
            }
        });
    }
    if (!sceneSwitcherRegistered) {
        setOBSSceneSwitcherCallback();
        sceneSwitcherRegistered = true;
    }
    obsConnected = true;
    return;
}

export async function getOBSConnection(): Promise<void> {
    if (connectionPromise) {
        return connectionPromise;
    }

    // Create a new connection attempt
    connectionPromise = new Promise(async (resolve, reject) => {
        try {
            // Try to connect immediately
            await obs.call('GetVersion');
            connectionPromise = null;
            resolve();
            return;
        } catch (error) {
            console.warn('Immediate connection attempt failed, starting retry interval...');
        }

        const interval = setInterval(async () => {
            try {
                await obs.call('GetVersion');
                clearInterval(interval);
                connectionPromise = null;
                resolve();
            } catch (error) {
                try {
                    obsConfig = (pythonConfig?.get('configs.Default.obs') as ObsConfig) || {
                        host: 'localhost',
                        port: 7274,
                        password: '',
                    };
                    await connectOBSWebSocket();
                } catch (connectError) {}
            }
        }, 1000);
    });

    return connectionPromise;
}

// async function connectOBSWebSocket() {
//     try {
//         await obs.connect(`ws://${obsConfig.host}:${obsPort}`, obsPassword);
//         console.log('Connected to OBS WebSocket');
//     } catch (error) {
//         console.error('Error connecting to OBS WebSocket:', error);
//         setTimeout(connectOBSWebSocket, 5000); // Retry after 5 seconds
//     }
// }
//
// connectOBSWebSocket();

export let obsWindow: BrowserWindow | null = null;

export function openOBSWindow() {
    if (obsWindow) {
        obsWindow.show();
        obsWindow.focus();
        return;
    }

    obsWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
        },
    });

    obsWindow.loadFile(path.join(getAssetsDir(), 'home.html'));

    obsWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            obsWindow?.hide();
        } else {
            obsWindow = null;
        }
    });

    registerOBSIPC();
}

function setOBSSceneSwitcherCallback() {
    obs.on('CurrentProgramSceneChanged', (data) => {
        const ocrScenes = getObsOcrScenes();
        if (ocrScenes && ocrScenes.length > 0 && ocrScenes.includes(data.sceneName)) {
            startOCR();
        }
        console.log(`Switched to OBS scene: ${data.sceneName}`);
    });
}

export async function registerOBSIPC() {
    ipcMain.handle('obs.launch', async () => {
        exec('obs', (error: any) => {
            if (error) {
                console.error('Error launching OBS:', error);
            }
        });
    });

    ipcMain.handle('obs.saveReplay', async () => {
        try {
            await getOBSConnection();
            await obs.call('SaveReplayBuffer');
        } catch (error) {
            console.error('Error saving replay buffer:', error);
        }
    });

    ipcMain.handle('obs.switchScene', async (_, sceneName) => {
        try {
            await getOBSConnection();
            await obs.call('SetCurrentProgramScene', { sceneName });
        } catch (error) {
            console.error('Error switching scene:', error);
        }
    });

    ipcMain.handle('obs.switchScene.id', async (_, sceneUuid) => {
        try {
            await getOBSConnection();
            await obs.call('SetCurrentProgramScene', { sceneUuid });
        } catch (error) {
            console.error('Error switching scene:', error);
        }
    });

    ipcMain.handle('obs.startRecording', async (_, windowName) => {
        try {
            await getOBSConnection();
            await obs.call('StartRecord');
        } catch (error) {
            console.error('Error starting recording:', error);
        }
    });

    ipcMain.handle('obs.getScenes', async () => {
        try {
            await getOBSConnection();
            return await getOBSScenes();
        } catch (error) {
            console.error('Error getting scenes:', error);
            return [];
        }
    });

    ipcMain.handle('obs.createScene', async (_, window) => {
        try {
            // if (window.captureSource === 'game_capture') {
            //     const response = await dialog.showMessageBox(obsWindow!, {
            //         type: 'warning',
            //         defaultId: 1,
            //         title: 'Game Capture Warning',
            //         message: 'This game was detected as game capture instead of Window Capture, the scene will be created as game capture.',
            //     });
            //     await createSceneWithCapture(window, 'game');
            // } else {
                await createSceneWithCapture(window, 'window');
            // }
        } catch (error) {
            console.error('Error setting up scene and window capture:', error);
        }
    });

    ipcMain.handle('obs.createScene.Game', async (_, window) => {
        try {
            // Show warning dialog before proceeding
            const response = await dialog.showMessageBox(obsWindow!, {
                type: 'warning',
                buttons: ['Yes', 'No'],
                defaultId: 1,
                title: 'Game Capture Warning',
                message: 'Game Capture is NOT recommended for most games.',
                detail: 'Most games should use Window Capture. Only use Game Capture for games that run in EXCLUSIVE fullscreen and have special OBS support. Visual Novels (VNs) should almost never use Game Capture.\n\nAre you sure you want to continue with Game Capture?',
            });
            if (response.response !== 0) {
                // User chose 'No', do not proceed
                return;
            }
            await createSceneWithCapture(window, 'game');
        } catch (error) {
            console.error('Error setting up scene and game capture:', error);
        }
    });

    ipcMain.handle('obs.removeScene', async (_, sceneUuid) => {
        try {
            const response = await dialog.showMessageBox(obsWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 1,
                title: 'Confirm Scene Removal',
                message: 'Are you sure you want to remove this scene?',
            });

            if (response.response === 0) {
                // User clicked 'Yes'
                await getOBSConnection();
                await obs.call('RemoveScene', { sceneUuid });
            }
        } catch (error) {
            console.error('Error removing scene:', error);
        }
    });

    ipcMain.handle('obs.getActiveScene', async () => {
        return await getCurrentScene();
    });

    ipcMain.handle('obs.getSceneActiveWindow', async () => {
        const currentScene = await getCurrentScene();
        try {
            return await getWindowTitleFromSource(currentScene.id);
        } catch (error) {
            console.error('Error getting active window from current scene:', error);
            return null;
        }
    });

    ipcMain.handle('obs.getExecutableNameFromSource', async (_, obsSceneID: string) => {
        try {
            return await getExecutableNameFromSource(obsSceneID);
        } catch (error) {
            console.error('Error getting executable name from source:', error);
            return null;
        }
    });

    ipcMain.handle('get_gsm_status', async () => {
        try {
            const texthookerPort =
                pythonConfig?.get('configs.Default.general.texthooker_port') || 55000;
            const response = await axios.get(`http://localhost:${texthookerPort}/get_status`);
            return response.data;
        } catch (error) {
            // console.error('Error fetching GSM status:', error);
            return null;
        }
    });

    ipcMain.handle('openOBS', async () => {
        sendStartOBS();
    });

    async function getExecutableNameFromSource(
        obsSceneID: string
    ): Promise<string | undefined | null> {
        try {
            await getOBSConnection();

            // Get the list of scene items for the given scene
            const sceneItems = await obs.call('GetSceneItemList', { sceneUuid: obsSceneID });

            // Find the first input source with a window property
            for (const item of sceneItems.sceneItems) {
                const inputProperties = await obs.call('GetInputSettings', {
                    inputUuid: item.sourceUuid as string,
                });
                if (inputProperties.inputSettings?.window) {
                    const windowValue = inputProperties.inputSettings.window as string;

                    return windowValue.split(':').at(-1)?.trim();
                }
            }

            console.warn(`No window input found in scene: ${obsSceneID}`);
            return null;
        } catch (error: any) {
            console.error(
                `Error getting executable name from source in scene "${obsSceneID}":`,
                error.message
            );
            throw error;
        }
    }

    async function getWindowTitleFromSource(
        obsSceneID: string
    ): Promise<string | undefined | null> {
        try {
            await getOBSConnection();

            // Get the list of scene items for the given scene
            const sceneItems = await obs.call('GetSceneItemList', { sceneUuid: obsSceneID });

            // Find the first input source with a window property
            for (const item of sceneItems.sceneItems) {
                const inputProperties = await obs.call('GetInputSettings', {
                    inputUuid: item.sourceUuid as string,
                });
                if (inputProperties.inputSettings?.window) {
                    const windowValue = inputProperties.inputSettings.window as string;

                    return windowValue.split(':').at(0)?.trim();
                }
            }

            console.warn(`No window input found in scene: ${obsSceneID}`);
            return null;
        } catch (error: any) {
            console.error(
                `Error getting executable name from source in scene "${obsSceneID}":`,
                error.message
            );
            throw error;
        }
    }

    // Only allow one getWindowsFromSource to run at a time
    let getWindowsFromSourcePromise: Promise<any[]> | null = null;

    interface ObsWindowItem {
        itemName: string;
        itemValue: string;
        captureMode: string;
        [key: string]: any; // for any additional properties from OBS
    }

    async function getWindowsFromSource(sourceName: string, capture_mode: string): Promise<ObsWindowItem[]> {
        if (getWindowsFromSourcePromise) {
            return getWindowsFromSourcePromise;
        }
        getWindowsFromSourcePromise = (async () => {
            try {
                await getOBSConnection();
                const response = await obs.call('GetInputPropertiesListPropertyItems', {
                    inputName: sourceName,
                    propertyName: 'window',
                });
                return response.propertyItems.map((item: any) => ({ ...item, captureMode: capture_mode }));
            } catch (error: any) {
                if (error.message.includes('No source was found')) {
                    try {
                        await obs.call('GetSceneItemList', { sceneName: HELPER_SCENE });
                    } catch (sceneError: any) {
                        if (sceneError.message.includes('No source was found')) {
                            await obs.call('CreateScene', { sceneName: HELPER_SCENE });
                        }
                    }

                    // Create the 'window_getter' input
                    await obs.call('CreateInput', {
                        sceneName: HELPER_SCENE,
                        inputName: sourceName,
                        inputKind: capture_mode,
                        inputSettings: {},
                    });

                    // Retry getting the window list
                    const retryResponse = await obs.call('GetInputPropertiesListPropertyItems', {
                        inputName: sourceName,
                        propertyName: 'window',
                    });
                    return retryResponse.propertyItems.map((item: any) => ({ ...item, captureMode: capture_mode }));
                } else {
                    throw error;
                }
            }
        })();

        try {
            return await getWindowsFromSourcePromise;
        } finally {
            getWindowsFromSourcePromise = null;
        }
    }

    async function getWindowList(): Promise<any[]> {
        try {
            const windowCaptureWindows = await getWindowsFromSource(
                WINDOW_GETTER_INPUT,
                'window_capture'
            );
            const gameCaptureWindows = await getWindowsFromSource(
                GAME_WINDOW_INPUT,
                'game_capture'
            );
            return [
                ...windowCaptureWindows.filter(
                    (windowCapture) =>
                        !gameCaptureWindows.some(
                            (gameWindow) => gameWindow.value === windowCapture.value
                        )
                ),
                ...gameCaptureWindows,
            ].sort((a, b) => a.itemName.localeCompare(b.itemName));
        } catch (error) {
            console.error('Error getting window list:', error);
            return []; // Return an empty array in case of an error
        }
    }

    ipcMain.handle('obs.getWindows', async () => {
        try {
            if (!isWindows()) {
                return ["Not Supported"];
            }
            await getOBSConnection();
            const response = await getWindowList();
            return response.map((item: any) => ({
                title: item.itemName.split(':').slice(1).join(':').trim(),
                value: item.itemValue,
            }));
        } catch (error) {
            console.error('Error getting windows:', error);
            return [];
        }
    });

    await getOBSConnection();
}

export async function setOBSScene(sceneName: string): Promise<void> {
    await getOBSConnection();
    await obs.call('SetCurrentProgramScene', { sceneName });
}

export async function getOBSScenes(): Promise<ObsScene[]> {
    const { scenes } = await obs.call('GetSceneList');
    return scenes
        .filter((scene: any) => scene.sceneName.toLowerCase() !== 'gsm helper')
        .map((scene: any) => ({ name: scene.sceneName, id: scene.sceneUuid } as ObsScene));
}

export async function getCurrentScene(): Promise<ObsScene> {
    await getOBSConnection();
    const response = await obs.call('GetCurrentProgramScene');
    return { name: response.sceneName, id: response.sceneUuid };
}
