// settings.ts
import { ipcMain, dialog } from 'electron';
import {
    getAutoUpdateElectron,
    getAutoUpdateGSMApp, getCustomPythonPackage, getStartConsoleMinimized,
    setAutoUpdateElectron,
    setAutoUpdateGSMApp, setCustomPythonPackage,
    setStartConsoleMinimized,
    store
} from "../store.js";

export function registerSettingsIPC() {
    ipcMain.handle('settings.getSettings', async () => {
        return {
            autoUpdateGSMApp: getAutoUpdateGSMApp(),
            autoUpdateElectron: getAutoUpdateElectron(),
            // pythonPath: getPythonPath(),
            // agentScriptsPath: getAgentScriptsPath(),
            startConsoleMinimized: getStartConsoleMinimized(),
            customPythonPackage: getCustomPythonPackage(),
        };
    });

    ipcMain.handle('settings.setAutoUpdateGSMApp', async (_, value: boolean) => {
        setAutoUpdateGSMApp(value);
    });

    ipcMain.handle('settings.setAutoUpdateElectron', async (_, value: boolean) => {
        setAutoUpdateElectron(value);
    });

    ipcMain.handle('settings.saveSettings', async (_, settings: any) => {
        setAutoUpdateGSMApp(settings.autoUpdateGSMApp);
        setAutoUpdateElectron(settings.autoUpdateElectron);
        setStartConsoleMinimized(settings.startConsoleMinimized);
        setCustomPythonPackage(settings.customPythonPackage);

        return { success: true };
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