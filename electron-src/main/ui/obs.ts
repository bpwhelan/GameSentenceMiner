// electron-src/main/launchers/obs.ts
import {BrowserWindow, ipcMain} from 'electron';
import path from 'path';
import {getAssetsDir} from '../util.js';
import {isQuitting} from '../main.js';
import {exec} from 'child_process';
import OBSWebSocket from 'obs-websocket-js';
import Store from "electron-store";

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
let obs = new OBSWebSocket();
const obsPort = obsConfig.port;
const obsPassword = obsConfig.password;

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

function registerOBSIPC() {
    ipcMain.handle('obs.launch', async () => {
        exec('obs', (error: any) => {
            if (error) {
                console.error('Error launching OBS:', error);
            }
        });
    });

    ipcMain.handle('obs.saveReplay', async () => {
        try {
            await obs.call('SaveReplayBuffer');
        } catch (error) {
            console.error('Error saving replay buffer:', error);
        }
    });

    ipcMain.handle('obs.switchScene', async (_, sceneName) => {
        try {
            await obs.call('SetCurrentProgramScene', {sceneName});
        } catch (error) {
            console.error('Error switching scene:', error);
        }
    });

    ipcMain.handle('obs.startRecording', async (_, windowName) => {
        try {
            await obs.call('StartRecord');
        } catch (error) {
            console.error('Error starting recording:', error);
        }
    });

    ipcMain.handle('obs.getScenes', async () => {
        try {
            const {scenes} = await obs.call('GetSceneList');
            return scenes.map((scene: any) => scene.sceneName);
        } catch (error) {
            console.error('Error getting scenes:', error);
            return [];
        }
    });

    ipcMain.handle('obs.createScene', async (_, window) => {
        try {
            console.log(window.title)
            console.log(window.value)
            // Create a new scene
            const sceneName = `${window.title}`;
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
                    method: 2
                }
            });
            console.log(window.value)

            console.log(`Scene and game capture setup for window: ${window.title}`);
        } catch (error) {
            console.error('Error setting up scene and game capture:', error);
        }
    });

    ipcMain.handle('obs.getWindows', async () => {
        try {
            const response = await obs.call('GetInputPropertiesListPropertyItems', {
                inputName: 'window_getter',
                propertyName: 'window'
            });
            const windows = response.propertyItems.map((item: any) => ({
                title: item.itemName.split(': ')[1],
                value: item.itemValue
            }));
            console.log(windows);
            return windows;
        } catch (error) {
            console.error('Error getting windows:', error);
            return [];
        }
    });

    // Connect to OBS WebSocket
    obs.connect(`ws://${obsConfig.host}:${obsPort}`, obsPassword).catch((error: any) => {
        console.error('Error connecting to OBS WebSocket:', error);
    });
}