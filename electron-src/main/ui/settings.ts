// settings.ts
import { ipcMain, dialog } from 'electron';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp, getCustomPythonPackage, getShowYuzuTab, getStartConsoleMinimized,
    setAutoUpdateElectron,
    setAutoUpdateGSMApp, setCustomPythonPackage, setShowYuzuTab,
    setStartConsoleMinimized,
    store
} from "../store.js";
import {webSocketManager} from "../communication/websocket.js";
import {reinstallPython} from "../python/python_downloader.js";

export function registerSettingsIPC() {
    ipcMain.handle('settings.getSettings', async () => {
        return {
            autoUpdateGSMApp: getAutoUpdateGSMApp(),
            autoUpdateElectron: getAutoUpdateElectron(),
            // pythonPath: getPythonPath(),
            // agentScriptsPath: getAgentScriptsPath(),
            startConsoleMinimized: getStartConsoleMinimized(),
            customPythonPackage: getCustomPythonPackage(),
            showYuzuTab: getShowYuzuTab()
        };
    });

    ipcMain.handle('settings.saveSettings', async (_, settings: any) => {
        setAutoUpdateGSMApp(settings.autoUpdateGSMApp);
        setAutoUpdateElectron(settings.autoUpdateElectron);
        setStartConsoleMinimized(settings.startConsoleMinimized);
        setCustomPythonPackage(settings.customPythonPackage);
        setShowYuzuTab(settings.showYuzuTab);
        return { success: true };
    });

    ipcMain.handle('settings.setAutoUpdateGSMApp', async (_, value: boolean) => {
        setAutoUpdateGSMApp(value);
    });

    ipcMain.handle('settings.setAutoUpdateElectron', async (_, value: boolean) => {
        setAutoUpdateElectron(value);
    });

    ipcMain.handle('settings.openGSMSettings', async () => {
        console.error("Opening GSM settings");
        await webSocketManager.sendOpenSettings();
    });

    ipcMain.handle('settings.reinstallPython', async () => {
        // Pop box saying are you sure you want to, and then reinstall Python
        const response = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Yes', 'No'],
            title: 'Reinstall Python',
            message: 'Are you sure you want to reinstall Python? This will remove the current installation and install a fresh copy.',
        });
        if (response.response === 0) { // Yes
            try {
                await reinstallPython();
                return { success: true, message: 'Python reinstalled successfully.' };
            } catch (error) {
                console.error('Failed to reinstall Python:', error);
                return { success: false, message: 'Failed to reinstall Python.' };
            }
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