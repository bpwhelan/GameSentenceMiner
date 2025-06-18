import {exec, spawn} from 'child_process';
import {dialog, ipcMain, BrowserWindow, screen } from 'electron';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp,
    getOCRConfig,
    getPythonPath,
    getStartConsoleMinimized, setAreaSelectOcrHotkey, setFuriganaFilterSensitivity, setManualOcrHotkey,
    setOCR1,
    setOCR2,
    setOCRConfig,
    setOCRLanguage,
    setOCRScanRate,
    setRequiresOpenWindow, setSendToClipboard,
    setShouldOCRScreenshots,
    setTwoPassOCR,
    setWindowName
} from "../store.js";
import {isQuitting, mainWindow} from "../main.js";
import {getCurrentScene, ObsScene} from "./obs.js";
import {BASE_DIR, getAssetsDir, getPlatform, sanitizeFilename} from "../util.js";
import path, {resolve} from "path";
import * as fs from "node:fs";
import {windowManager, Window} from 'node-window-manager'; // Import the library

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

function runOCR(command: string[]) {
    ocrProcess = spawn('cmd', ['/c', 'start', 'cmd', '/k', ...command], {detached: false}); // Open in new cmd window

    ocrProcess.on('exit', (code: any, signal: any) => {
        ocrProcess = null;
        // console.log(`OCR process exited with code: ${code}, signal: ${signal}`);
    });

    ocrProcess.on('error', (err: any) => {
        // console.log(`OCR process error: ${err}`);
        ocrProcess = null;
    });

    console.log(`Starting OCR process with command: ${command.join(' ')}`);
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
            spawn('cmd', ['/c', 'start', 'cmd', '/k', command], {detached: false}); // Open in new cmd window
            mainWindow?.webContents.send('terminal-output', `Uninstalling ${dependency} dependencies in new terminal...`);
        } else {
            mainWindow?.webContents.send('terminal-output', `Uninstall canceled for ${dependency}.`);
        }
    });

    ipcMain.on('ocr.run-screen-selector', async (_, window_title: string) => {
        if (window_title === "") {
            const response = await dialog.showMessageBox(mainWindow!, {
                type: 'warning',
                buttons: ['OK'],
                defaultId: 0,
                title: 'No Window Selected',
                message: 'Please select a window to run the area selector on.'
            });
            return;
        }
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
            const config = await getActiveOCRCOnfig()
            if (!config) {
                const response = await dialog.showMessageBox(mainWindow!, {
                    type: 'question',
                    buttons: ['Yes', 'No'],
                    defaultId: 1,
                    title: 'No OCR Found',
                    message: `No OCR found for scene, run area selector on currently selected window: ${ocr_config.window_name}? ("No" will ocr the entire window)`
                });

                if (response.response === 0) { // 'Yes' button
                    await runScreenSelector(ocr_config.window_name)
                } else {
                    // Do nothing, just run OCR on the entire window
                }
            }
            const command = [
                `${getPythonPath()}`, `-m`, `GameSentenceMiner.ocr.owocr_helper`,
                `--language`, `${ocr_config.language}`,
                `--ocr1`, `${ocr_config.ocr1}`,
                `--ocr2`, `${ocr_config.ocr2}`,
                `--twopassocr`, `${ocr_config.twoPassOCR ? 1 : 0}`,
            ];

            if (ocr_config.ocr_screenshots) command.push("--clipboard");
            if (ocr_config.sendToClipboard) command.push("--clipboard-output")
            if (ocr_config.window_name) command.push("--window", `${ocr_config.window_name}`);
            if (ocr_config.furigana_filter_sensitivity > 0) command.push("--furigana_filter_sensitivity", `${ocr_config.furigana_filter_sensitivity}`);
            if (ocr_config.areaSelectOcrHotkey) command.push("--area_select_ocr_hotkey", `${ocr_config.areaSelectOcrHotkey}`);

            runOCR(command);
        }
    });

    ipcMain.on('ocr.start-ocr-ss-only', () => {
        if (!ocrProcess) {
            const ocr_config = getOCRConfig();
            const command = [
                `${getPythonPath()}`, `-m`, `GameSentenceMiner.ocr.owocr_helper`,
                `--language`, `${ocr_config.language}`,
                `--ocr1`, `${ocr_config.ocr2}`,
                `--ocr2`, `${ocr_config.ocr2}`,
                `--window`, `${ocr_config.window_name}`,
                `--manual`
            ];
            if (ocr_config.ocr_screenshots) command.push("--clipboard");
            if (ocr_config.sendToClipboard) command.push("--clipboard-output")
            if (ocr_config.furigana_filter_sensitivity > 0) command.push("--furigana_filter_sensitivity", `${ocr_config.furigana_filter_sensitivity}`);
            if (ocr_config.areaSelectOcrHotkey) command.push("--area_select_ocr_hotkey", `${ocr_config.areaSelectOcrHotkey}`);
            if (ocr_config.manualOcrHotkey) command.push("--manual_ocr_hotkey", `${ocr_config.manualOcrHotkey}`);
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
        setShouldOCRScreenshots(config.ocr_screenshots);
        setFuriganaFilterSensitivity(config.furigana_filter_sensitivity);
        setManualOcrHotkey(config.manualOcrHotkey);
        setSendToClipboard(config.sendToClipboard);
        setAreaSelectOcrHotkey(config.areaSelectOcrHotkey);
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

    ipcMain.on('run-furigana-window', async (_, args: { char: string; fontSize: number }) => {
        const { char, fontSize } = args;
        if (!furiganaWindow) {
            furiganaWindow = createFuriganaWindow();
            furiganaWindow.webContents.send('set-furigana-character', char, fontSize);
        } else {
            if (furiganaWindow.isVisible()) {
                furiganaWindow.hide();
            } else {
                furiganaWindow.show();
                furiganaWindow.webContents.send('set-furigana-character', char, fontSize);
                furiganaWindow.focus();
            }
        }
    });

    ipcMain.on('update-furigana-character', (_, char: string, fontSize: number) => {
        if (furiganaWindow) {
            furiganaWindow.webContents.send('set-furigana-character', char, fontSize);
        }
    });

    ipcMain.on('close-furigana-window', () => {
        if (furiganaWindow) {
            furiganaWindow.hide();
        }
    });
}

let furiganaWindow: BrowserWindow | null = null;

function createFuriganaWindow(): BrowserWindow {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    furiganaWindow = new BrowserWindow({
        width: 150,
        height: 150,
        x: Math.floor(width / 2) - 25,
        y: Math.floor(height / 2) - 25,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    furiganaWindow.loadFile(path.join(getAssetsDir(), 'furigana.html'));

    furiganaWindow.webContents.on('did-finish-load', () => {
        if (furiganaWindow) { // Check if window still exists before setting
            // furiganaWindow.setIgnoreMouseEvents(true);
        }
    });

    furiganaWindow.on('close', (event: any) => {
        if (isQuitting) {
            furiganaWindow = null; // Allow the window to be garbage collected
            return;
        }
        event.preventDefault();
        furiganaWindow?.hide();
    });

    return furiganaWindow;

    // Optional: for debugging, open DevTools
    // furiganaWindow.webContents.openDevTools({ mode: 'detach' });
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