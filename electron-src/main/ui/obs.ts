// electron-src/main/launchers/obs.ts
import {BrowserWindow, dialog, ipcMain} from 'electron';
import path from 'path';
import {BASE_DIR, getAssetsDir} from '../util.js';
import {isQuitting} from '../main.js';
import {exec} from 'child_process';
import OBSWebSocket from 'obs-websocket-js';
import Store from "electron-store";
import * as fs from "node:fs";
import {webSocketManager} from "../communication/websocket.js";

let store = new Store()

interface ObsConfig {
    host: string;
    port: number;
    password: string;
}

const obsConfig: ObsConfig = store.get('configs.Default.obs') as ObsConfig || {
    host: 'localhost',
    port: 7274,
    password: ''
};

const OBS_CONFIG_PATH = path.join(BASE_DIR, 'obs-studio');
const SCENE_CONFIG_PATH = path.join(OBS_CONFIG_PATH, 'config', 'obs-studio', 'basic', 'scenes');
let obs = new OBSWebSocket();
let obsConnected = false;
const obsPort = obsConfig.port;
const obsPassword = obsConfig.password;
const HELPER_SCENE = 'GSM Helper';
const WINDOW_GETTER_INPUT = 'window_getter';

async function connectOBSWebSocket(retries = 5, delay = 2000): Promise<void> {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(obsConfig);
            await obs.connect(`ws://${obsConfig.host}:${obsPort}`, obsPassword);
            obsConnected = true;
            console.log('Connected to OBS WebSocket');
            return;
        } catch (error: any) {
            console.error(`Error connecting to OBS WebSocket (attempt ${i + 1} of ${retries}):`);
            if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw new Error('Failed to connect to OBS WebSocket after multiple attempts');
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

    obsWindow.loadFile(path.join(getAssetsDir(), 'obs.html'));

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

async function waitForObsConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
            obs.call("GetVersion").then((version) => {
                clearInterval(interval);
                setTimeout(() => {
                    resolve();
                }, 3000);
            }).catch(async () => {
                await connectOBSWebSocket()
                console.error('OBS not connected yet, retrying...');
            });
        }, 1000);
    });
}

export function registerOBSIPC() {
    ipcMain.handle('obs.launch', async () => {
        exec('obs', (error: any) => {
            if (error) {
                console.error('Error launching OBS:', error);
            }
        });
    });

    ipcMain.handle('obs.saveReplay', async () => {
        try {
            await waitForObsConnection();
            await obs.call('SaveReplayBuffer');
        } catch (error) {
            console.error('Error saving replay buffer:', error);
        }
    });

    ipcMain.handle('obs.switchScene', async (_, sceneName) => {
        try {
            await waitForObsConnection();
            await obs.call('SetCurrentProgramScene', {sceneName});
        } catch (error) {
            console.error('Error switching scene:', error);
        }
    });

    ipcMain.handle('obs.startRecording', async (_, windowName) => {
        try {
            await waitForObsConnection();
            await obs.call('StartRecord');
        } catch (error) {
            console.error('Error starting recording:', error);
        }
    });

    ipcMain.handle('obs.getScenes', async () => {
        try {
            await waitForObsConnection();
            const {scenes} = await obs.call('GetSceneList');
            return scenes.map((scene: any) => scene.sceneName);
        } catch (error) {
            console.error('Error getting scenes:', error);
            return [];
        }
    });

    ipcMain.handle('obs.createScene', async (_, window) => {
        try {
            await waitForObsConnection();
            // Create a new scene
            const sceneName = `${window.sceneName}`;
            await obs.call('CreateScene', {sceneName});

            // Set the new scene as the current program scene
            await obs.call('SetCurrentProgramScene', {sceneName});

            // Add a game capture source to the new scene
            await obs.call('CreateInput', {
                sceneName,
                inputName: `${window.title} - Capture`,
                inputKind: 'window_capture',
                inputSettings: {
                    mode: 'window',
                    window: window.value,
                    capture_audio: true,
                    capture_cursor: false,
                }
            });

            await modifyAutoSceneSwitcherInJSON(sceneName, window.title)

            console.log(`Scene and game capture setup for window: ${window.title}`);
        } catch (error) {
            console.error('Error setting up scene and game capture:', error);
        }
    });

    ipcMain.handle('obs.createScene.Game', async (_, window) => {
        try {
            await waitForObsConnection();
            // Create a new scene
            const sceneName = `${window.sceneName}`;
            await obs.call('CreateScene', {sceneName});

            // Set the new scene as the current program scene
            await obs.call('SetCurrentProgramScene', {sceneName});

            // Add a game capture source to the new scene
            await obs.call('CreateInput', {
                sceneName,
                inputName: `${window.title} - Game Capture`,
                inputKind: 'game_capture',
                inputSettings: {
                    capture_mode: 'window',
                    window: window.value,
                    capture_audio: true,
                    capture_cursor: false,
                }
            });

            await modifyAutoSceneSwitcherInJSON(sceneName, window.title)

            console.log(`Scene and game capture setup for window: ${window.title}`);
        } catch (error) {
            console.error('Error setting up scene and game capture:', error);
        }
    });

    ipcMain.handle('obs.removeScene', async (_, sceneName) => {
        try {
            await waitForObsConnection();
            await obs.call('RemoveScene', {sceneName});
        } catch (error) {
            console.error('Error removing scene:', error);
        }
    });


    async function getWindowList(): Promise<any[]> {
        try {
            await waitForObsConnection();
            const response = await obs.call('GetInputPropertiesListPropertyItems', {
                inputName: WINDOW_GETTER_INPUT,
                propertyName: 'window',
            });
            return response.propertyItems;
        } catch (error: any) {
            if (error.message.includes('No source was found')) {
                try {
                    await obs.call('GetSceneItemList', {sceneName: HELPER_SCENE});
                } catch (sceneError: any) {
                    if (sceneError.message.includes('No source was found')) {
                        await obs.call('CreateScene', {sceneName: HELPER_SCENE});
                    }
                }

                // Create the 'window_getter' input
                await obs.call('CreateInput', {
                    sceneName: HELPER_SCENE,
                    inputName: WINDOW_GETTER_INPUT,
                    inputKind: 'window_capture',
                    inputSettings: {},
                });

                // Retry getting the window list
                const retryResponse = await obs.call('GetInputPropertiesListPropertyItems', {
                    inputName: WINDOW_GETTER_INPUT,
                    propertyName: 'window',
                });
                return retryResponse.propertyItems;
            } else {
                throw error;
            }
        }
    }

    async function modifyAutoSceneSwitcherInJSON(sceneName: string, windowTitle: string): Promise<void> {
        try {
            await waitForObsConnection();
            webSocketManager.sendQuitOBS();
            const currentSceneCollection = await obs.call('GetSceneCollectionList');
            const sceneCollectionName = currentSceneCollection.currentSceneCollectionName;

            const sceneCollectionPath = path.join(SCENE_CONFIG_PATH, `${sceneCollectionName}.json`.replace(' ', '_'));

            const fileContent = await fs.promises.readFile(sceneCollectionPath, 'utf-8');
            const sceneCollection = JSON.parse(fileContent);

            let autoSceneSwitcher = sceneCollection["modules"]["auto-scene-switcher"];

            if (!autoSceneSwitcher) {
                sceneCollection["modules"]["auto-scene-switcher"] = {
                    interval: 300,
                    non_matching_scene: "",
                    switch_if_not_matching: false,
                    active: true,
                    switches: [],
                };
            }


            if (!autoSceneSwitcher.active) {
                dialog.showMessageBox(obsWindow!, {
                    type: 'question',
                    buttons: ['Yes', 'No'],
                    defaultId: 0,
                    title: 'Enable Auto Scene Switcher',
                    message: 'Do you want to enable the auto scene switcher?',
                }).then(async (response) => {
                    if (response.response === 0) {
                        autoSceneSwitcher.active = true;
                    }
                    autoSceneSwitcher.switches.push({
                        scene: sceneName,
                        window_title: windowTitle,
                    });

                    sceneCollection["modules"]["auto-scene-switcher"] = autoSceneSwitcher;


                    const updatedContent = JSON.stringify(sceneCollection, null, 2);
                    await fs.promises.writeFile(sceneCollectionPath, updatedContent, 'utf-8');
                    await fs.promises.writeFile(path.join(BASE_DIR, "scene_config.json"), updatedContent, 'utf-8');

                    console.log(`Auto-scene-switcher settings updated for "${sceneName}" in JSON.`);
                    webSocketManager.sendStartOBS();
                    await connectOBSWebSocket();
                });
            } else {
                autoSceneSwitcher.switches.push({
                    scene: sceneName,
                    window_title: windowTitle,
                });

                sceneCollection["modules"]["auto-scene-switcher"] = autoSceneSwitcher;


                const updatedContent = JSON.stringify(sceneCollection, null, 2);
                await fs.promises.writeFile(sceneCollectionPath, updatedContent, 'utf-8');
                await fs.promises.writeFile(path.join(BASE_DIR, "scene_config.json"), updatedContent, 'utf-8');

                console.log(`Auto-scene-switcher settings updated for "${sceneName}" in JSON.`);
                webSocketManager.sendStartOBS();
                await connectOBSWebSocket();
            }


        } catch (error: any) {
            console.error(`Error modifying auto-scene-switcher settings:`, error.message);
            throw error;
        }
    }

    ipcMain.handle('obs.getWindows', async () => {
        try {
            await waitForObsConnection();
            const response = await getWindowList();
            return response.map((item: any) => ({
                title: item.itemName.split(':').slice(1).join(':').trim(),
                value: item.itemValue
            }));
        } catch (error) {
            console.error('Error getting windows:', error);
            return [];
        }
    });

    connectOBSWebSocket().then(() => {
    });
}