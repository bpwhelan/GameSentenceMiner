// settings.ts
import { ipcMain, dialog } from 'electron';
import { spawn } from 'child_process';
import {
    getRunWindowTransparencyToolOnStartup,
    getAutoUpdateElectron,
    getAutoUpdateGSMApp,
    getCustomPythonPackage,
    getPythonPath,
    getShowYuzuTab,
    getStartConsoleMinimized,
    getWindowTransparencyTarget,
    getWindowTransparencyToolHotkey,
    setRunWindowTransparencyToolOnStartup,
    setAutoUpdateElectron,
    setAutoUpdateGSMApp,
    setCustomPythonPackage,
    setObsOcrScenes,
    setRunOverlayOnStartup,
    setShowYuzuTab,
    setStartConsoleMinimized,
    setWindowTransparencyTarget,
    setWindowTransparencyToolHotkey,
    store,
    getRunOverlayOnStartup,
} from '../store.js';
import { webSocketManager } from '../communication/websocket.js';
import { reinstallPython } from '../python/python_downloader.js';
import { runPipInstall } from '../main.js';

export let window_transparency_process: any = null; // Process for the Window Transparency Tool

export function registerSettingsIPC() {
    ipcMain.handle('settings.getSettings', async () => {
        return {
            autoUpdateGSMApp: getAutoUpdateGSMApp(),
            autoUpdateElectron: getAutoUpdateElectron(),
            // pythonPath: getPythonPath(),
            // agentScriptsPath: getAgentScriptsPath(),
            startConsoleMinimized: getStartConsoleMinimized(),
            customPythonPackage: getCustomPythonPackage(),
            showYuzuTab: getShowYuzuTab(),
            windowTransparencyToolHotkey: getWindowTransparencyToolHotkey(),
            windowTransparencyTarget: store.get('windowTransparencyTarget') || '', // Default to empty string if not set
            runWindowTransparencyToolOnStartup: getRunWindowTransparencyToolOnStartup(),
            runOverlayOnStartup: getRunOverlayOnStartup(),
            obsOcrScenes: store.get('obsOcrScenes') || [], // Default to empty array if not set
        };
    });

    ipcMain.handle('settings.saveSettings', async (_, settings: any) => {
        setAutoUpdateGSMApp(settings.autoUpdateGSMApp);
        setAutoUpdateElectron(settings.autoUpdateElectron);
        setStartConsoleMinimized(settings.startConsoleMinimized);
        setCustomPythonPackage(settings.customPythonPackage);
        setShowYuzuTab(settings.showYuzuTab);
        setWindowTransparencyToolHotkey(settings.windowTransparencyToolHotkey);
        setWindowTransparencyTarget(settings.windowTransparencyTarget);
        setRunWindowTransparencyToolOnStartup(settings.runWindowTransparencyToolOnStartup);
        setRunOverlayOnStartup(settings.runOverlayOnStartup);
        setObsOcrScenes(settings.obsOcrScenes || []); // Ensure it's always an array
        return { success: true };
    });

    ipcMain.handle('settings.setAutoUpdateGSMApp', async (_, value: boolean) => {
        setAutoUpdateGSMApp(value);
    });

    ipcMain.handle('settings.setAutoUpdateElectron', async (_, value: boolean) => {
        setAutoUpdateElectron(value);
    });

    ipcMain.handle('settings.openGSMSettings', async () => {
        console.error('Opening GSM settings');
        await webSocketManager.sendOpenSettings();
    });

    ipcMain.handle('settings.reinstallPython', async () => {
        // Pop box saying are you sure you want to, and then reinstall Python
        const response = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Yes', 'No'],
            title: 'Reinstall Python',
            message:
                'Are you sure you want to reinstall Python? This will remove the current installation and install a fresh copy.',
        });
        if (response.response === 0) {
            // Yes
            try {
                await reinstallPython();
                return { success: true, message: 'Python reinstalled successfully.' };
            } catch (error) {
                console.error('Failed to reinstall Python:', error);
                return { success: false, message: 'Failed to reinstall Python.' };
            }
        }
    });

    ipcMain.handle('settings.runWindowTransparencyTool', async () => {
        runWindowTransparencyTool();
    });

    ipcMain.handle('settings.runPipInstall', async (_, pkg: string) => {
        try {
            await runPipInstall(pkg);
            return { success: true };
        } catch (error: any) {
            console.error('Failed to run pip install:', error);
            return { success: false, error: error.message };
        }
    });

    // ipcMain.handle('settings.selectPythonPath', async () => {
    //     const result = await dialog.showOpenDialog({
    //         properties: ['openFile'],
    //         filters: [
    //             { name: 'Executables', extensions: ['exe'] },
    //             { name: 'All Files', extensions: ['*'] },
    //         ],
    //     });
    //
    //     if (!result.canceled && result.filePaths.length > 0) {
    //         setPythonPath(result.filePaths[0]);
    //         return { filePath: result.filePaths[0] };
    //     }
    //
    //     return null;
    // });
    //
    // ipcMain.handle('settings.selectAgentScriptsPath', async () => {
    //     const result = await dialog.showOpenDialog({
    //         properties: ['openDirectory'],
    //     });
    //
    //     if (!result.canceled && result.filePaths.length > 0) {
    //         setAgentScriptsPath(result.filePaths[0]);
    //         return { filePath: result.filePaths[0] };
    //     }
    //
    //     return null;
    // });

    ipcMain.handle('settings.setStartConsoleMinimized', async (_, value: boolean) => {
        setStartConsoleMinimized(value);
    });
}

export function runWindowTransparencyTool() {
    const hotkey = getWindowTransparencyToolHotkey();
    if (window_transparency_process && !window_transparency_process.killed) {
        console.log('Stopping existing Window Transparency Tool process');
        window_transparency_process.kill();
    }
    console.log(
        `Starting Window Transparency Tool with hotkey: ${hotkey} and target: ${getWindowTransparencyTarget()}`
    );
    window_transparency_process = spawn(getPythonPath(), [
        '-m',
        'GameSentenceMiner.tools.window_transparency',
        '--hotkey',
        hotkey,
        '--window',
        getWindowTransparencyTarget(),
    ]);
    window_transparency_process.stdout.on('data', (data: any) => {
        console.log(`Window Transparency Tool: ${data}`);
    });
    window_transparency_process.stderr.on('data', (data: any) => {
        console.error(`Window Transparency Tool Error: ${data}`);
    });
}

export function stopWindowTransparencyTool() {
    if (window_transparency_process) {
        window_transparency_process.kill();
        window_transparency_process = null;
    }
}
