import { exec, spawn } from 'child_process';
import { dialog, ipcMain, BrowserWindow, screen, IpcMainEvent, clipboard, shell } from 'electron';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp,
    getOCRConfig,
    getPythonPath,
    getStartConsoleMinimized,
    setAreaSelectOcrHotkey,
    setFuriganaFilterSensitivity,
    setManualOcrHotkey,
    setOCR1,
    setOCR2,
    setOCRConfig,
    setOCRLanguage,
    setOCRScanRate,
    setSendToClipboard,
    setShouldOCRScreenshots,
    setTwoPassOCR,
    setOptimizeSecondScan,
    setKeepNewline,
    setAdvancedMode,
} from '../store.js';
import { getSanitizedPythonEnv } from '../util.js';
import { closeAllPythonProcesses, isQuitting, mainWindow, restartGSM } from '../main.js';
import { getCurrentScene, ObsScene } from './obs.js';
import { OCRStdoutManager } from '../communication/ocrIPC.js';
import {
    BASE_DIR,
    getAssetsDir,
    getPlatform,
    isWindows,
    runPythonScript,
    sanitizeFilename,
} from '../util.js';
import path, { resolve } from 'path';
import * as fs from 'node:fs';
import * as os from 'os';

let ocrProcess: any = null;
let ocrStdoutManager: OCRStdoutManager | null = null;

function requestOcrConfigReload(reason: string, options?: { reloadArea?: boolean; reloadElectron?: boolean; changes?: Record<string, any> }) {
    if (!ocrStdoutManager) {
        console.warn(`[OCR] Skipping reload config (${reason}) - no active OCR process`);
        return;
    }

    const payload: Record<string, any> = {
        reason,
        reload_area: options?.reloadArea ?? true,
        reload_electron: options?.reloadElectron ?? true,
    };

    if (options?.changes && Object.keys(options.changes).length > 0) {
        payload.changes = options.changes;
    }

    ocrStdoutManager.reloadConfig(payload);
    console.log(`[OCR] Sent reload config (${reason})`);
}

async function runScreenSelector() {
    const ocr_config = getOCRConfig();
    await new Promise((resolve, reject) => {
        let args = ['-m', 'GameSentenceMiner.ocr.owocr_area_selector_qt', '--obs'];

        console.log(`Running screen selector with args: ${args.join(' ')}`);

        const process = spawn(getPythonPath(), args, {
            detached: false,
            env: getSanitizedPythonEnv()
        });

        process.stdout?.on('data', (data: Buffer) => {
            const log = data.toString().trim();
            console.log(`[Screen Selector STDOUT]: ${log}`);
            mainWindow?.webContents.send('ocr-log', log);
        });

        process.on('close', (code) => {
            console.log(`Screen selector exited with code ${code}`);
            if (code === 0) {
                mainWindow?.webContents.send('ocr-log', 'Screen selector completed successfully.');
                mainWindow?.webContents.send('ocr-log', 'COMMAND_FINISHED');
                requestOcrConfigReload('screen-selector', { reloadArea: true, reloadElectron: false });
                resolve(null);
            } else {
                reject(new Error(`Screen selector process exited with code ${code}`));
            }
        });

        process.on('error', (err) => {
            reject(err);
        });
    });
    mainWindow?.webContents.send(
        'terminal-output',
        `Running screen area selector in background...`
    );
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
    const newOcrProcess = spawn(executable, args, {
        env: getSanitizedPythonEnv()
    });
    ocrProcess = newOcrProcess; // Assign to the global variable.

    // Attach OCRStdoutManager for IPC communication
    ocrStdoutManager = new OCRStdoutManager(newOcrProcess);

    // Forward structured OCR events to renderer
    ocrStdoutManager.on('message', (msg) => {
        console.log('[OCR IPC]:', msg);
        mainWindow?.webContents.send('ocr-ipc-message', msg);
    });

    // Forward specific events for convenience
    ocrStdoutManager.on('started', () => {
        console.log('[OCR] Process started');
        mainWindow?.webContents.send('ocr-ipc-started');
    });

    ocrStdoutManager.on('stopped', () => {
        console.log('[OCR] Process stopped');
        mainWindow?.webContents.send('ocr-ipc-stopped');
    });

    ocrStdoutManager.on('paused', (data) => {
        console.log('[OCR] Paused:', data);
        mainWindow?.webContents.send('ocr-ipc-paused', data);
    });

    ocrStdoutManager.on('unpaused', (data) => {
        console.log('[OCR] Unpaused:', data);
        mainWindow?.webContents.send('ocr-ipc-unpaused', data);
    });

    ocrStdoutManager.on('status', (status) => {
        console.log('[OCR] Status:', status);
        mainWindow?.webContents.send('ocr-ipc-status', status);
    });

    ocrStdoutManager.on('error', (error) => {
        console.error('[OCR] Error:', error);
        mainWindow?.webContents.send('ocr-ipc-error', error);
    });

    ocrStdoutManager.on('config_reloaded', () => {
        console.log('[OCR] Config reloaded');
        mainWindow?.webContents.send('ocr-ipc-config-reloaded');
    });

    ocrStdoutManager.on('force_stable_changed', (data) => {
        console.log('[OCR] Force stable changed:', data);
        mainWindow?.webContents.send('ocr-ipc-force-stable-changed', data);
    });

    // 4. Capture and log standard output from the process.
    ocrStdoutManager.on('log', (log) => {
        if (log.type === 'stdout') {
            console.log(`[OCR STDOUT]: ${log.message}`);
            mainWindow?.webContents.send('ocr-log', log.message);
        } else if (log.type === 'stderr') {
            console.error(`[OCR STDERR]: ${log.message}`);
            mainWindow?.webContents.send('ocr-log', log.message);
        } else if (log.type === 'parse-error') {
            console.error(`[OCR Parse Error]: ${log.message}`);
            mainWindow?.webContents.send('ocr-log', '[Parse Error] ' + log.message);
        }
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
            ocrStdoutManager = null;
        }
    });

    // 7. Handle errors during process spawning (e.g., command not found).
    newOcrProcess.on('error', (err: Error) => {
        console.error(`Failed to start OCR process: ${err.message}`);
        mainWindow?.webContents.send('ocr-stopped');
        if (ocrProcess === newOcrProcess) {
            ocrProcess = null;
            ocrStdoutManager = null;
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
        const process = spawn(executable, args, {
            env: getSanitizedPythonEnv()
        });

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
        const config = await getActiveOCRConfig();
        const twoPassOCR = ocr_config.advancedMode ? ocr_config.twoPassOCR : true;
        console.log(config);
        if (!config) {
            const response = await dialog.showMessageBox(mainWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 1,
                title: 'No OCR Found',
                message: `No OCR found for current scene, run area selector?`,
            });

            if (response.response === 0) {
                // 'Yes' button
                await runScreenSelector();
            } else {
                // Do nothing, just run OCR on the entire window
            }
        }
        const ocr1 = twoPassOCR ? `${ocr_config.ocr1}` : `${ocr_config.ocr2}`;
        const command = [
            `${getPythonPath()}`,
            `-m`,
            `GameSentenceMiner.ocr.owocr_helper`,
            `--language`,
            `${ocr_config.language}`,
            `--ocr1`,
            `${ocr1}`,
            `--ocr2`,
            `${ocr_config.ocr2}`,
            `--twopassocr`,
            `${twoPassOCR ? 1 : 0}`,
            `--obs_ocr`,
        ];

        if (ocr_config.ocr_screenshots && ocr_config.advancedMode) command.push('--clipboard');
        if (ocr_config.sendToClipboard) command.push('--clipboard-output');
        if (ocr_config.furigana_filter_sensitivity > 0)
            command.push(
                '--furigana_filter_sensitivity',
                `${ocr_config.furigana_filter_sensitivity}`
            );
        if (ocr_config.areaSelectOcrHotkey)
            command.push('--area_select_ocr_hotkey', `${ocr_config.areaSelectOcrHotkey}`);
        if (ocr_config.optimize_second_scan || !ocr_config.advancedMode) command.push('--optimize_second_scan');
        if (ocr_config.keep_newline) command.push('--keep_newline');
        if (ocr_config.globalPauseHotkey)
            command.push('--global_pause_hotkey', `${ocr_config.globalPauseHotkey}`);

        runOCR(command);
    }
}

export function stopOCR() {
    if (ocrProcess) {
        ocrProcess.kill();
        ocrProcess = null;
    }
}

export function startManualOCR() {
    if (!ocrProcess) {
        const ocr_config = getOCRConfig();
        const command = [
            `${getPythonPath()}`,
            `-m`,
            `GameSentenceMiner.ocr.owocr_helper`,
            `--language`,
            `${ocr_config.language}`,
            `--ocr1`,
            `${ocr_config.ocr2}`,
            `--ocr2`,
            `${ocr_config.ocr2}`,
            `--manual`,
            `--obs_ocr`,
        ];
        if (ocr_config.ocr_screenshots && ocr_config.advancedMode) command.push('--clipboard');
        if (ocr_config.sendToClipboard) command.push('--clipboard-output');
        if (ocr_config.furigana_filter_sensitivity > 0)
            command.push(
                '--furigana_filter_sensitivity',
                `${ocr_config.furigana_filter_sensitivity}`
            );
        if (ocr_config.areaSelectOcrHotkey)
            command.push('--area_select_ocr_hotkey', `${ocr_config.areaSelectOcrHotkey}`);
        if (ocr_config.manualOcrHotkey)
            command.push('--manual_ocr_hotkey', `${ocr_config.manualOcrHotkey}`);
        if (ocr_config.keep_newline) command.push('--keep_newline');
        if (ocr_config.globalPauseHotkey)
            command.push('--global_pause_hotkey', `${ocr_config.globalPauseHotkey}`);
        runOCR(command);
    }
}

export function registerOCRUtilsIPC() {
    ipcMain.on('ocr.install-recommended-deps', async () => {
        const pythonPath = getPythonPath();
        await closeAllPythonProcesses();
        mainWindow?.webContents.send('ocr-log', `Downloading OneOCR files...`);
        const dependencies = [
            'jaconv',
            'loguru',
            'numpy==2.2.6',
            'Pillow>=10.0.0',
            'pyperclipfix',
            'pynput<=1.7.8',
            'websockets>=14.0',
            'desktop-notifier>=6.1.0',
            'mss',
            'pysbd',
            'langid',
            'psutil',
            'requests',
            "pywin32;platform_system=='Windows'",
            "pyobjc;platform_system=='Darwin'",
        ];
        const promises: Promise<void>[] = [];
        if (isWindows()) {
            await runCommandAndLog([
                pythonPath,
                '-m',
                'GameSentenceMiner.util.downloader.oneocr_dl',
            ]);
            await runCommandAndLog([
                pythonPath,
                '-m',
                'uv',
                '--no-progress',
                'pip',
                'install',
                '--upgrade',
                'oneocr',
            ]);
        }
        await runCommandAndLog([
            pythonPath,
            '-m',
            'uv',
            '--no-progress',
            'pip',
            'install',
            '--upgrade',
            ...dependencies,
        ]);
        mainWindow?.webContents.send('ocr-log', `Installing recommended dependencies...`);
        await runCommandAndLog([
            pythonPath,
            '-m',
            'uv',
            '--no-progress',
            'pip',
            'install',
            '--upgrade',
            'betterproto==2.0.0b7',
        ]);

        // Wait for all promises to settle before closing the console
        await Promise.allSettled(promises);
        // Wrap the message in ASCII green text (using ANSI escape codes)
        mainWindow?.webContents.send(
            'ocr-log',
            `\x1b[32mAll recommended dependencies installed successfully.\x1b[0m`
        );
        mainWindow?.webContents.send('ocr-log', `\x1b[32mYou can now close this console.\x1b[0m`);
        await restartGSM();
        // setTimeout(() => mainWindow?.webContents.send('ocr-log', 'COMMAND_FINISHED'), 5000);
    });

    ipcMain.on('ocr.install-selected-dep', async (_, dependency: string) => {
        const pythonPath = getPythonPath();
        await closeAllPythonProcesses();
        let command: string[];
        if (dependency.includes('pip')) {
            command = [
                pythonPath,
                '-m',
                'uv',
                '--no-progress',
                ...dependency.split(' '),
                'numpy==2.2.6',
                '--upgrade',
            ];
        } else {
            command = [pythonPath, '-m', 'uv', '--no-progress', dependency];
        }
        mainWindow?.webContents.send('ocr-log', `Installing ${dependency} dependencies...`);
        await runCommandAndLog(command);
        mainWindow?.webContents.send(
            'ocr-log',
            `\x1b[32mInstalled ${dependency} successfully.\x1b[0m`
        );
        mainWindow?.webContents.send('ocr-log', `\x1b[32mYou can now close this console.\x1b[0m`);
        await restartGSM();
    });

    ipcMain.on('ocr.uninstall-selected-dep', async (_, dependency: string) => {
        const pythonPath = getPythonPath();
        await closeAllPythonProcesses();
        const response = await dialog.showMessageBox(mainWindow!, {
            type: 'question',
            buttons: ['Yes', 'No'],
            defaultId: 1,
            title: 'Confirm Uninstall',
            message: `Are you sure you want to uninstall the dependency: ${dependency}?`,
        });

        if (response.response === 0) {
            // 'Yes' button
            const command = [
                getPythonPath(),
                '-m',
                'uv',
                '--no-progress',
                'pip',
                'uninstall',
                dependency,
            ];
            mainWindow?.webContents.send('ocr-log', `Uninstalling ${dependency} dependencies...`);
            await runCommandAndLog(command);
            mainWindow?.webContents.send(
                'ocr-log',
                `\x1b[32mUninstalled ${dependency} successfully.\x1b[0m`
            );
            mainWindow?.webContents.send(
                'ocr-log',
                `\x1b[32mYou can now close this console.\x1b[0m`
            );
        } else {
            mainWindow?.webContents.send('ocr-log', `Uninstall canceled for ${dependency}.`);
        }
        await restartGSM();
    });

    ipcMain.on('ocr.run-screen-selector', async () => {
        await runScreenSelector();
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

    ipcMain.handle('ocr.open-global-owocr-config', async () => {
        try {
            const configPath = path.join(os.homedir(), '.config', 'owocr_config.ini');

            // Check if file exists, create it if it doesn't
            if (!fs.existsSync(configPath)) {
                const configDir = path.dirname(configPath);
                if (!fs.existsSync(configDir)) {
                    fs.mkdirSync(configDir, { recursive: true });
                }
                // Create empty config file
                fs.writeFileSync(configPath, '# OWOCR Global Configuration\n');
            }

            await shell.openPath(configPath);
            return true;
        } catch (error: any) {
            console.error('Error opening global OWOCR config:', error.message);
            throw error;
        }
    });

    ipcMain.on('ocr.start-ocr', async () => {
        await startOCR();
    });

    ipcMain.on('ocr.start-ocr-ss-only', () => {
        if (!ocrProcess) {
            const ocr_config = getOCRConfig();
            const ocr1 = ocr_config.twoPassOCR ? `${ocr_config.ocr1}` : `${ocr_config.ocr2}`;
            const command = [
                `${getPythonPath()}`,
                `-m`,
                `GameSentenceMiner.ocr.owocr_helper`,
                `--language`,
                `${ocr_config.language}`,
                `--ocr1`,
                `${ocr_config.ocr2}`,
                `--ocr2`,
                `${ocr_config.ocr2}`,
                `--manual`,
                `--obs_ocr`,
            ];
            if (ocr_config.ocr_screenshots) command.push('--clipboard');
            if (ocr_config.sendToClipboard) command.push('--clipboard-output');
            if (ocr_config.furigana_filter_sensitivity > 0)
                command.push(
                    '--furigana_filter_sensitivity',
                    `${ocr_config.furigana_filter_sensitivity}`
                );
            if (ocr_config.areaSelectOcrHotkey)
                command.push('--area_select_ocr_hotkey', `${ocr_config.areaSelectOcrHotkey}`);
            if (ocr_config.manualOcrHotkey)
                command.push('--manual_ocr_hotkey', `${ocr_config.manualOcrHotkey}`);
            if (ocr_config.keep_newline) command.push('--keep_newline');
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
            console.log('Sending to OCR stdin:', data);
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

    ipcMain.on('ocr.save-ocr-config', (_, config: any) => {
        // Update the main store with the new config values
        const currentConfig = getOCRConfig();
        const newConfig = { ...currentConfig, ...config };
        setOCRConfig(newConfig);
        updateFuriganaFilterSensitivity(newConfig.furigana_filter_sensitivity);
        console.log(`OCR config saved: ${JSON.stringify(newConfig)}`);
        requestOcrConfigReload('save-ocr-config', { reloadArea: false, reloadElectron: true });
    });

    ipcMain.handle('ocr.getActiveOCRConfig', async () => {
        return await getActiveOCRConfig();
    });

    ipcMain.handle('ocr.getActiveOCRConfigWindowName', async () => {
        const ocrConfig = await getActiveOCRConfig();
        return ocrConfig ? ocrConfig.window : '';
    });

    ipcMain.handle('ocr.get-ocr-config', () => {
        const ocr_config = getOCRConfig();
        return ocr_config;
        // return {
        //     ocr1: ocr_config.ocr1,
        //     ocr2: ocr_config.ocr2,
        //     twoPassOCR: ocr_config.twoPassOCR,
        //     window_name: ocr_config.window_name,
        // }
    });

    ipcMain.handle('ocr.get-running-state', () => {
        return {
            isRunning: ocrProcess !== null,
        };
    });

    ipcMain.handle('run-furigana-window', async (): Promise<number> => {
        const pythonPath = getPythonPath();
        const ocr_config = getOCRConfig();
        // Run the Python script with the specified sensitivity
        const result = await runPythonScript(pythonPath, [
            '-m',
            'GameSentenceMiner.ui.furigana_filter_preview_qt',
            String(ocr_config.furigana_filter_sensitivity),
        ]);
        const match = result.match(/RESULT:\[(.*?)\]/);
        const extractedResult = match ? match[1] : null;
        mainWindow?.webContents.send('furigana-script-result', extractedResult);
        console.log('Furigana script result:', extractedResult);
        return Number(extractedResult || ocr_config.furigana_filter_sensitivity);
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

    ipcMain.handle('ocr.export-ocr-config', async () => {
        try {
            const config = await getActiveOCRConfig();
            if (!config) {
                return { success: false, message: 'No active OCR config found' };
            }

            // Only export rectangles and coordinate_system
            const exportConfig = {
                rectangles: config.rectangles || [],
                coordinate_system: config.coordinate_system || '',
            };

            const configJson = JSON.stringify(exportConfig, null, 2);
            clipboard.writeText(configJson);

            return {
                success: true,
                message: 'OCR config (rectangles & coordinate system) exported to clipboard',
            };
        } catch (error: any) {
            console.error('Error exporting OCR config:', error.message);
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle('ocr.import-ocr-config', async () => {
        try {
            const clipboardText = clipboard.readText();

            if (!clipboardText.trim()) {
                return { success: false, message: 'Clipboard is empty' };
            }

            let importedData;
            try {
                importedData = JSON.parse(clipboardText);
            } catch (parseError) {
                return { success: false, message: 'Invalid JSON in clipboard' };
            }

            // Basic validation
            if (!importedData || typeof importedData !== 'object') {
                return { success: false, message: 'Invalid config format' };
            }

            // Get current config or create base structure
            const currentConfig =
                (await getActiveOCRConfig()) || {};

            // Merge only rectangles and coordinate_system from imported data
            const updatedConfig = {
                ...currentConfig,
                scene: '',
                window: '',
                coordinate_system: importedData.coordinate_system || '',
                window_geometry: {
                    left: 0,
                    top: 0,
                    width: 0,
                    height: 0,
                },
                rectangles: importedData.rectangles || [],
                furiganaFilterSensitivity: 0,
            };

            // Show Dialogue about how many rectangles are in the config, and ask for confirmation to proceed
            const response = await dialog.showMessageBox(mainWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                title: 'Import OCR Config',
                message: `This config contains ${importedData.rectangles?.length || 0
                    } rectangles. This will overwrite the current Area configuration. Proceed with import?`,
            });

            if (response.response !== 0) {
                return { success: false, message: 'Import cancelled by user' };
            }

            const sceneConfigPath = await getActiveOCRConfigPath();
            await fs.promises.writeFile(
                sceneConfigPath,
                JSON.stringify(updatedConfig, null, 4),
                'utf-8'
            );

            requestOcrConfigReload('import-ocr-config', { reloadArea: true, reloadElectron: false });
            return { success: true, message: 'OCR config imported successfully' };
        } catch (error: any) {
            console.error('Error importing OCR config:', error.message);
            return { success: false, message: error.message };
        }
    });

    // OCR IPC Command Handlers
    ipcMain.on('ocr.pause', () => {
        if (ocrStdoutManager) {
            ocrStdoutManager.pause();
            console.log('[OCR] Sent pause command');
        } else {
            console.warn('[OCR] Cannot pause - no active OCR process');
        }
    });

    ipcMain.on('ocr.unpause', () => {
        if (ocrStdoutManager) {
            ocrStdoutManager.unpause();
            console.log('[OCR] Sent unpause command');
        } else {
            console.warn('[OCR] Cannot unpause - no active OCR process');
        }
    });

    ipcMain.on('ocr.toggle-pause', () => {
        if (ocrStdoutManager) {
            ocrStdoutManager.togglePause();
            console.log('[OCR] Sent toggle pause command');
        } else {
            console.warn('[OCR] Cannot toggle pause - no active OCR process');
        }
    });

    ipcMain.on('ocr.get-status', () => {
        if (ocrStdoutManager) {
            ocrStdoutManager.getStatus();
            console.log('[OCR] Requested status');
        } else {
            console.warn('[OCR] Cannot get status - no active OCR process');
            mainWindow?.webContents.send('ocr-ipc-error', 'No active OCR process');
        }
    });

    ipcMain.on('ocr.reload-config', (_, data?: Record<string, any>) => {
        if (ocrStdoutManager) {
            ocrStdoutManager.reloadConfig(data);
            console.log('[OCR] Sent reload config command');
        } else {
            console.warn('[OCR] Cannot reload config - no active OCR process');
        }
    });

    ipcMain.on('ocr.toggle-force-stable', () => {
        if (ocrStdoutManager) {
            ocrStdoutManager.toggleForceStable();
            console.log('[OCR] Sent toggle force stable command');
        } else {
            console.warn('[OCR] Cannot toggle force stable - no active OCR process');
        }
    });

    ipcMain.on('ocr.set-force-stable', (_, enabled: boolean) => {
        if (ocrStdoutManager) {
            ocrStdoutManager.setForceStable(enabled);
            console.log(`[OCR] Sent set force stable command: ${enabled}`);
        } else {
            console.warn('[OCR] Cannot set force stable - no active OCR process');
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
        },
    });

    furiganaWindow.loadFile(path.join(getAssetsDir(), 'furigana.html'));

    furiganaWindow.webContents.on('did-finish-load', () => {
        if (furiganaWindow) {
            // Check if window still exists before setting
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

export async function updateFuriganaFilterSensitivity(sensitivity: number) {
    sensitivity = Number(sensitivity);
    const activeOCR = await getActiveOCRConfig();
    if (!activeOCR) {
        console.warn('No active OCR config found.');
        return;
    }

    activeOCR.furiganaFilterSensitivity = sensitivity; // Use provided sensitivity
    const sceneConfigPath = await getActiveOCRConfigPath();
    try {
        await fs.promises.writeFile(sceneConfigPath, JSON.stringify(activeOCR, null, 4), 'utf-8');
        console.log(`Furigana filter sensitivity added to OCR config at ${sceneConfigPath}`);
        requestOcrConfigReload('update-furigana-filter', { reloadArea: false, reloadElectron: true });
    } catch (error: any) {
        console.error(`Error writing OCR config file at ${sceneConfigPath}:`, error.message);
    }
}

export async function getActiveOCRConfig() {
    const sceneConfigPath = await getActiveOCRConfigPath();
    if (!fs.existsSync(sceneConfigPath)) {
        // console.warn(`OCR config file does not exist at ${sceneConfigPath}`);
        return null;
    }
    try {
        const fileContent = await fs.promises.readFile(sceneConfigPath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error: any) {
        console.error(
            `Error reading or parsing OCR config file at ${sceneConfigPath}:`,
            error.message
        );
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
