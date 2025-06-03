import {exec, spawn} from 'child_process';
import {dialog, ipcMain} from 'electron';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp,
    getOCRConfig,
    getPythonPath, getStartConsoleMinimized,
    setOCR1,
    setOCR2, setOCRConfig, setOCRLanguage, setOCRScanRate, setRequiresOpenWindow, setTwoPassOCR,
    setWindowName
} from "../store.js";
import {mainWindow} from "../main.js";
import {getCurrentScene, ObsScene} from "./obs.js";
import {BASE_DIR, getPlatform, sanitizeFilename} from "../util.js";
import path, {resolve} from "path";
import * as fs from "node:fs";
import { windowManager, Window } from 'node-window-manager'; // Import the library

let ocrProcess: any = null;

async function runScreenSelector(windowTitle: string) {
    const ocr_config = getOCRConfig();
    await new Promise((resolve, reject) => {
        const process = spawn(getPythonPath(), ['-m', 'GameSentenceMiner.ocr.owocr_area_selector', windowTitle], {
            detached: false,
            stdio: 'ignore'
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve(null);
            } else {
                reject(new Error(`Screen selector process exited with code ${code}`));
            }
        });

        process.on('error', (err) => {
            reject(err);
        });
    });
    mainWindow?.webContents.send('terminal-output', `Running screen area selector in background...`);
}

function runOCR(command: string) {
    ocrProcess = spawn('cmd', ['/c', 'start', 'cmd', '/k', command], {detached: false}); // Open in new cmd window

    console.log(`Starting OCR process with command: ${command}`);

    ocrProcess.on('exit', (code: any, signal: any) => {
        ocrProcess = null;
        console.log(`OCR process exited with code: ${code}, signal: ${signal}`);
    });

    ocrProcess.on('error', (err: any) => {
        console.log(`OCR process error: ${err}`);
        ocrProcess = null;
    });
}

export function registerOCRUtilsIPC() {
    ipcMain.on('ocr.install-owocr-deps', () => {
        const command = `${getPythonPath()} -m pip install --upgrade owocr & exit`;
        spawn('cmd', ['/c', 'start', 'cmd', '/k', command], {detached: false}); // Open in new cmd window
        mainWindow?.webContents.send('terminal-output', `Installing OWOCR dependencies in new terminal...`);
    });

    ipcMain.on('ocr.install-selected-dep', (_, dependency: string) => {
        const command = `${getPythonPath()} -m  ${dependency} --upgrade & exit`;
        spawn('cmd', ['/c', 'start', 'cmd', '/k', command], {detached: false}); // Open in new cmd window
        mainWindow?.webContents.send('terminal-output', `Installing ${dependency} dependencies in new terminal...`);
    });

    ipcMain.on('ocr.uninstall-selected-dep', async (_, dependency: string) => {
        const response = await dialog.showMessageBox(mainWindow!, {
            type: 'question',
            buttons: ['Yes', 'No'],
            defaultId: 1,
            title: 'Confirm Uninstall',
            message: `Are you sure you want to uninstall the dependency: ${dependency}?`
        });

        if (response.response === 0) { // 'Yes' button
            const command = `${getPythonPath()} -m pip uninstall -y ${dependency}`;
            spawn('cmd', ['/c', 'start', 'cmd', '/k', command], { detached: false }); // Open in new cmd window
            mainWindow?.webContents.send('terminal-output', `Uninstalling ${dependency} dependencies in new terminal...`);
        } else {
            mainWindow?.webContents.send('terminal-output', `Uninstall canceled for ${dependency}.`);
        }
    });

    ipcMain.on('ocr.run-screen-selector', async (_, window_title: string) => {
        await runScreenSelector(window_title);
    });

    ipcMain.handle('ocr.open-config-json', async () => {
        try {
            const ocrConfigPath = await getActiveOCRConfigPath();
            console.log(ocrConfigPath);
            exec(`start "" "${ocrConfigPath}"`); // Opens the file with the default editor
            return true;
        } catch (error: any) {
            console.error('Error opening config file:', error.message);
            throw error;
        }
    });

    ipcMain.handle('ocr.open-config-folder', async () => {
        try {
            exec(`start "" "${path.join(BASE_DIR, 'ocr_config')}"`); // Opens the folder in Explorer
            return true;
        } catch (error: any) {
            console.error('Error opening config folder:', error.message);
            throw error;
        }
    });

    ipcMain.on('ocr.start-ocr', async () => {
        if (!ocrProcess) {
            const ocr_config = getOCRConfig();
            const config =  await getActiveOCRCOnfig()
            if (!config) {
                const response = await dialog.showMessageBox(mainWindow!, {
                    type: 'question',
                    buttons: ['Yes', 'No'],
                    defaultId: 1,
                    title: 'No OCR Found',
                    message: 'No OCR found for scene, run area selector on currently selected window? (Do Ctrl+S if you dont want to ocr the entire window)'
                });

                if (response.response === 0) { // 'Yes' button
                    await runScreenSelector(ocr_config.window_name)
                } else {
                    return;
                }
            }
            const command = `${getPythonPath()} -m GameSentenceMiner.ocr.owocr_helper ${ocr_config.language} ${ocr_config.ocr1} ${ocr_config.ocr2} ${ocr_config.twoPassOCR ? "1" : "0"}`;
            runOCR(command);
        }
    });

    ipcMain.on('ocr.start-ocr-ss-only', () => {
        if (!ocrProcess) {
            const ocr_config = getOCRConfig();
            const command = `${getPythonPath()} -m GameSentenceMiner.ocr.owocr_helper ${ocr_config.language} ${ocr_config.ocr1} ${ocr_config.ocr2} ${ocr_config.twoPassOCR ? "1" : "0"} --ssonly`;
            runOCR(command);
        }
    });

    ipcMain.on('ocr.kill-ocr', () => {
        if (ocrProcess) {
            exec(`taskkill /F /PID ${ocrProcess.pid}`, (error, stdout, stderr) => {
                if (error) {
                    mainWindow?.webContents.send('terminal-error', `Error killing OCR process: ${stderr}`);
                }
                mainWindow?.webContents.send('terminal-output', `Killing OCR Process...`);
            });
            ocrProcess = null;
        }
    });

    ipcMain.on('ocr.restart-ocr', () => {
        if (ocrProcess) {
            exec(`taskkill /F /PID ${ocrProcess.pid}`, (error, stdout, stderr) => {
                if (error) {
                    mainWindow?.webContents.send('terminal-error', `Error killing OCR process: ${stderr}`);
                }
                mainWindow?.webContents.send('terminal-output', `Restarting OCR Process...`);
            });
            ocrProcess = null;
        }
        ipcMain.emit('ocr.start-ocr');
    });

    ipcMain.on('ocr.save-two-pass', (_, twoPass: boolean) => {
        setTwoPassOCR(twoPass); // Save to persistent storage
        console.debug(`two-pass OCR saved: ${twoPass}`);
    });

    ipcMain.on('ocr.save-window-name', (_, windowName: string) => {
        setWindowName(windowName); // Save to persistent storage
        mainWindow?.webContents.send('terminal-output', `Window name saved: ${windowName}`);
    });

    // Save OCR option 1
    ipcMain.on('ocr.save-ocr1', (_, ocr1: string) => {
        setOCR1(ocr1); // Save to persistent storage
        mainWindow?.webContents.send('terminal-output', `OCR Option 1 saved: ${ocr1}`);
    });

    // Save OCR option 2
    ipcMain.on('ocr.save-ocr2', (_, ocr2: string) => {
        setOCR2(ocr2); // Save to persistent storage
        mainWindow?.webContents.send('terminal-output', `OCR Option 2 saved: ${ocr2}`);
    });

    ipcMain.on('ocr.save-ocr-config', (_, config: any) => {
        setOCR1(config.ocr1);
        setOCR2(config.ocr2);
        setTwoPassOCR(config.twoPassOCR);
        setWindowName(config.window_name);
        setRequiresOpenWindow(config.requiresOpenWindow);
        setOCRScanRate(config.scanRate);
        setOCRLanguage(config.language);
        console.log(`OCR config saved: ${JSON.stringify(config)}`);
    })

    ipcMain.handle('ocr.getActiveOCRConfig', async () => {
        return await getActiveOCRCOnfig();
    });

    ipcMain.handle('ocr.getActiveOCRConfigWindowName', async () => {
        const ocrConfig = await getActiveOCRCOnfig();
        return ocrConfig ? ocrConfig.window : "";
    });

    ipcMain.handle("ocr.get-ocr-config", () => {
        const ocr_config = getOCRConfig();
        return ocr_config;
        // return {
        //     ocr1: ocr_config.ocr1,
        //     ocr2: ocr_config.ocr2,
        //     twoPassOCR: ocr_config.twoPassOCR,
        //     window_name: ocr_config.window_name,
        // }
    });

    ipcMain.handle('ocr.getWindows', async (): Promise<string[]> => {
        const windowsList: LibraryWindowInfo[] = getWindowsListWithLibrary();
        return windowsList.map(window => window.title).sort((a, b) => a.localeCompare(b));
    });
}

// Check library docs for exact properties. Example:
interface LibraryWindowInfo {
    title: string;
    path: string; // Executable path
}

function getWindowsListWithLibrary(): LibraryWindowInfo[] {
    // Ensure you only get visible windows with titles if needed
    const windows = windowManager.getWindows();
    const uniqueTitles = new Set<string>();
    return windows
        .filter(win => win.isVisible() && win.getTitle()?.length > 0) // Example filter
        .map(win => ({ // Map to your desired structure
            title: win.getTitle(),
            path: win.path,
            // Add other properties as needed: win.getBounds(), win.processId etc.
        }))
        .filter(win => {
            if (uniqueTitles.has(win.title)) {
                return false;
            }
            uniqueTitles.add(win.title);
            return true;
        });
}


export async function getActiveOCRCOnfig() {
    const sceneConfigPath = await getActiveOCRConfigPath();
    if (!fs.existsSync(sceneConfigPath)) {
        console.warn(`OCR config file does not exist at ${sceneConfigPath}`);
        return null;
    }
    try {
        const fileContent = await fs.promises.readFile(sceneConfigPath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error: any) {
        console.error(`Error reading or parsing OCR config file at ${sceneConfigPath}:`, error.message);
        return null;
    }
}

export async function getActiveOCRConfigPath() {
    const currentScene = await getCurrentScene();
    return getSceneOCRConfig(currentScene);
}

export function getSceneOCRConfig(scene: ObsScene) {
    return path.join(BASE_DIR, 'ocr_config', `${sanitizeFilename(scene.name)}.json`);
}