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
    setTwoPassOCR, setOptimizeSecondScan,
    setWindowName, setUseWindowForConfig, setLastWindowSelected, setKeepNewline, setUseObsAsSource
} from "../store.js";
import {isQuitting, mainWindow} from "../main.js";
import {getCurrentScene, ObsScene} from "./obs.js";
import {BASE_DIR, getAssetsDir, getPlatform, isWindows, sanitizeFilename} from "../util.js";
import path, {resolve} from "path";
import * as fs from "node:fs";
import {windowManager, Window} from 'node-window-manager'; // Import the library

let ocrProcess: any = null;

async function runScreenSelector(windowTitle: string) {
    if (windowTitle === "") {
        windowTitle = "OBS";
    }
    const ocr_config = getOCRConfig();
    await new Promise((resolve, reject) => {
        let args = ['-m', 'GameSentenceMiner.ocr.owocr_area_selector', windowTitle];

        if (ocr_config.useWindowForConfig) {
            args.push('--use_window_for_config');
        }
        if (ocr_config.useObsAsSource) {
            args.push('--obs_ocr');
        }

        console.log(`Running screen selector with args: ${args.join(' ')}`);

        const process = spawn(getPythonPath(), args, {
            detached: false,
            stdio: 'ignore'
        });

        process.on('close', (code) => {
            console.log(`Screen selector exited with code ${code}`);
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

/**
 * Runs the OCR command, ensuring only one instance is active at a time.
 * The command is executed directly, without a detached cmd window.
 *
 * @param command - An array where the first element is the executable
 *                  and the rest are its arguments (e.g., ['tesseract', 'image.png', 'stdout']).
 */
function runOCR(command: string[]) {
    // 1. If an OCR process is already running, terminate it gracefully.
    if (ocrProcess) {
        console.log('An OCR process is already running. Terminating the old one...');
        // Sending SIGTERM. The 'close' handler of the old process will eventually fire.
        // The new logic in the 'close' handler prevents it from interfering with a new process.
        ocrProcess.kill();
    }

    // 2. Separate the executable from its arguments.
    const [executable, ...args] = command;

    if (!executable) {
        console.error('Error: Command is empty. Cannot start OCR process.');
        return;
    }

    console.log(`Starting OCR process with command: ${executable} ${args.join(' ')}`);
    mainWindow?.webContents.send('ocr-started');

    // 3. Spawn the new process and store it in a local variable.
    const newOcrProcess = spawn(executable, args);
    ocrProcess = newOcrProcess; // Assign to the global variable.

    // 4. Capture and log standard output from the process.
    newOcrProcess.stdout?.on('data', (data: Buffer) => {
        const log = data.toString().trim();
        console.log(`[OCR STDOUT]: ${log}`);
        mainWindow?.webContents.send('ocr-log', log);
    });

    // 5. Capture and log standard error from the process.
    newOcrProcess.stderr?.on('data', (data: Buffer) => {
        const errorLog = data.toString().trim();
        console.error(`[OCR STDERR]: ${errorLog}`);
        mainWindow?.webContents.send('ocr-log', errorLog);
    });

    // 6. Handle the process exiting.
    newOcrProcess.on('close', (code: number) => {
        console.log(`OCR process exited with code: ${code}`);
        mainWindow?.webContents.send('ocr-stopped');
        // Clear the global reference only if it's this specific process instance.
        // This prevents a race condition where an old process's close event
        // nullifies the reference to a newer, active process.
        if (ocrProcess === newOcrProcess) {
            ocrProcess = null;
        }
    });

    // 7. Handle errors during process spawning (e.g., command not found).
    newOcrProcess.on('error', (err: Error) => {
        console.error(`Failed to start OCR process: ${err.message}`);
        mainWindow?.webContents.send('ocr-stopped');
        if (ocrProcess === newOcrProcess) {
            ocrProcess = null;
        }
    });
}

async function runCommandAndLog(command: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const [executable, ...args] = command;

        if (!executable) {
            const errorMsg = 'Error: Command is empty. Cannot start process.';
            console.error(errorMsg);
            reject(new Error(errorMsg));
            return;
        }

        console.log(`Starting process with command: ${executable} ${args.join(' ')}`);
        const process = spawn(executable, args);

        process.stdout?.on('data', (data: Buffer) => {
            const log = data.toString().trim();
            console.log(`[STDOUT]: ${log}`);
            mainWindow?.webContents.send('ocr-log', log);
        });

        process.stderr?.on('data', (data: Buffer) => {
            const errorLog = data.toString().trim();
            console.error(`[STDERR]: ${errorLog}`);
            mainWindow?.webContents.send('ocr-log', errorLog);
        });

        process.on('close', (code: number) => {
            console.log(`Process exited with code: ${code}`);
            mainWindow?.webContents.send('ocr-log', `Process exited with code: ${code}`);
            resolve();
        });

        process.on('error', (err: Error) => {
            console.error(`Failed to start process: ${err.message}`);
            mainWindow?.webContents.send('ocr-log', `Failed to start process: ${err.message}`);
            reject(err);
        });
    });
}

export async function startOCR() {
    // This should never happen, but just in case
    if (ocrProcess) {
        ocrProcess.kill('SIGTERM'); // terminate it gracefully if running
        ocrProcess = null;
    }
    if (!ocrProcess) {
        const ocr_config = getOCRConfig();
        const config = await getActiveOCRCOnfig(getOCRConfig().useWindowForConfig)
        console.log(config);
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
        if (ocr_config.optimize_second_scan) command.push("--optimize_second_scan");
        if (ocr_config.useWindowForConfig) command.push("--use_window_for_config");
        if (ocr_config.keep_newline) command.push("--keep_newline");
        if (ocr_config.useObsAsSource) command.push('--obs_ocr')

        runOCR(command);
    }
}

export function registerOCRUtilsIPC() {
    ipcMain.on('ocr.install-recommended-deps', async () => {
        const pythonPath = getPythonPath();
        mainWindow?.webContents.send('ocr-log', `Downloading OneOCR files...`);
        const dependencies = [
            "jaconv",
            "loguru",
            "numpy",
            "Pillow>=10.0.0",
            "pyperclipfix",
            "pynput<=1.7.8",
            "websockets>=14.0",
            "desktop-notifier>=6.1.0",
            "mss",
            "pysbd",
            "langid",
            "psutil",
            "requests",
            "pywin32;platform_system=='Windows'",
            "pyobjc;platform_system=='Darwin'"
        ];
        const promises: Promise<void>[] = [];
        if (isWindows()) {
            await runCommandAndLog([pythonPath, '-m', 'GameSentenceMiner.util.downloader.oneocr_dl']);
            await runCommandAndLog([pythonPath, '-m', 'pip', 'install', '--upgrade', '--no-warn-script-location', 'oneocr']);
        }
        await runCommandAndLog([pythonPath, '-m', 'pip', 'install', '--upgrade', '--no-warn-script-location', ...dependencies]);
        mainWindow?.webContents.send('ocr-log', `Installing recommended dependencies...`);
        await runCommandAndLog([pythonPath, '-m', 'pip', 'install', '--upgrade', '--no-warn-script-location', 'betterproto==2.0.0b7']);

        // Wait for all promises to settle before closing the console
        await Promise.allSettled(promises);
        // Wrap the message in ASCII green text (using ANSI escape codes)
        mainWindow?.webContents.send('ocr-log', `\x1b[32mAll recommended dependencies installed successfully.\x1b[0m`);
        mainWindow?.webContents.send('ocr-log', `\x1b[32mYou can now close this console.\x1b[0m`);
        // setTimeout(() => mainWindow?.webContents.send('ocr-log', 'COMMAND_FINISHED'), 5000);
    });

    ipcMain.on('ocr.install-selected-dep', async (_, dependency: string) => {
        const pythonPath = getPythonPath();
        let command: string[];
        if (dependency.includes("pip")) {
            command = [pythonPath, '-m', ...dependency.split(' '), '--upgrade', '--no-warn-script-location'];
        } else {
            command = [pythonPath, '-m', dependency];
        }
        mainWindow?.webContents.send('ocr-log', `Installing ${dependency} dependencies...`);
        await runCommandAndLog(command);
        mainWindow?.webContents.send('ocr-log', `\x1b[32mInstalled ${dependency} successfully.\x1b[0m`);
        mainWindow?.webContents.send('ocr-log', `\x1b[32mYou can now close this console.\x1b[0m`);
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
            const command = [getPythonPath(), '-m', 'pip', 'uninstall', '-y', dependency];
            mainWindow?.webContents.send('ocr-log', `Uninstalling ${dependency} dependencies...`);
            await runCommandAndLog(command);
            mainWindow?.webContents.send('ocr-log', `\x1b[32mUninstalled ${dependency} successfully.\x1b[0m`);
            mainWindow?.webContents.send('ocr-log', `\x1b[32mYou can now close this console.\x1b[0m`);
        } else {
            mainWindow?.webContents.send('ocr-log', `Uninstall canceled for ${dependency}.`);
        }
    });

    ipcMain.on('ocr.run-screen-selector', async (_, window_title: string) => {
        // if (window_title === "") {
        //     const response = await dialog.showMessageBox(mainWindow!, {
        //         type: 'warning',
        //         buttons: ['OK'],
        //         defaultId: 0,
        //         title: 'No Window Selected',
        //         message: 'Please select a window to run the area selector on.'
        //     });
        //     return;
        // }
        await runScreenSelector(window_title);
    });

    ipcMain.handle('ocr.open-config-json', async () => {
        try {
            const ocrConfigPath = await getActiveOCRConfigPath(getOCRConfig().useWindowForConfig);
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
        await startOCR();
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
            if (ocr_config.useWindowForConfig) command.push("--use_window_for_config");
            if (ocr_config.keep_newline) command.push("--keep_newline");
            if (ocr_config.useObsAsSource) command.push("--obs_ocr");
            runOCR(command);
        }
    });

    ipcMain.on('ocr.kill-ocr', () => {
        if (ocrProcess) {
            mainWindow?.webContents.send('ocr-log', 'Stopping OCR process...');
            ocrProcess.kill(); // Sends SIGTERM by default, which is a graceful shutdown.
        }
    });

    ipcMain.on('ocr.stdin', (_, data) => {
        if (ocrProcess) {
            console.log("Sending to OCR stdin:", data);
            ocrProcess.stdin.write(data);
        }
    });

    ipcMain.on('ocr.restart-ocr', () => {
        if (ocrProcess) {
            mainWindow?.webContents.send('terminal-output', `Restarting OCR Process...`);
            ocrProcess.kill(); // Terminate the existing process
            ocrProcess = null; // Clear the reference
        }
        ipcMain.emit('ocr.start-ocr'); // Start a new OCR process
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
        setOptimizeSecondScan(config.optimize_second_scan);
        setUseWindowForConfig(config.useWindowForConfig);
        setLastWindowSelected(config.lastWindowSelected);
        setKeepNewline(config.keep_newline);
        setUseObsAsSource(config.useObsAsSource);
        console.log(`OCR config saved: ${JSON.stringify(config)}`);
    })

    ipcMain.handle('ocr.getActiveOCRConfig', async () => {
        return await getActiveOCRCOnfig(getOCRConfig().useWindowForConfig);
    });

    ipcMain.handle('ocr.getActiveOCRConfigWindowName', async () => {
        const config = getOCRConfig();
        const ocrConfig = await getActiveOCRCOnfig(config.useWindowForConfig);
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


export async function getActiveOCRCOnfig(useWindow: boolean) {
    const sceneConfigPath = await getActiveOCRConfigPath(useWindow);
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

export async function getActiveOCRConfigPath(useWindow: boolean) {
    if (useWindow) {
        const ocrConfig = getOCRConfig();
        return path.join(BASE_DIR, 'ocr_config', `${sanitizeFilename(ocrConfig.window_name)}.json`);
    }
    const currentScene = await getCurrentScene();
    return getSceneOCRConfig(currentScene);
}

export function getSceneOCRConfig(scene: ObsScene) {
    return path.join(BASE_DIR, 'ocr_config', `${sanitizeFilename(scene.name)}.json`);
}
