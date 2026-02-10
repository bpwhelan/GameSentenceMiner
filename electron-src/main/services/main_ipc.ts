import { BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { registerStateIPC } from '../communication/state.js';
import { registerPythonIPC } from '../ui/python.js';
import { registerFrontPageIPC } from '../ui/front.js';
import { registerOCRUtilsIPC } from '../ui/ocr.js';
import { registerSettingsIPC } from '../ui/settings.js';
import { registerSteamIPC } from '../ui/steam.js';
import { registerOBSIPC } from '../ui/obs.js';
import { registerYuzuIPC } from '../ui/yuzu.js';
import { registerVNIPC } from '../ui/vn.js';

interface MainIPCDependencies {
    getMainWindow: () => BrowserWindow | null;
    restartApplication: () => Promise<void>;
}

let ipcRegistered = false;

export function registerMainIPC(deps: MainIPCDependencies): void {
    if (ipcRegistered) {
        return;
    }
    ipcRegistered = true;

    registerVNIPC();
    registerYuzuIPC();
    registerOBSIPC();
    registerSteamIPC();
    registerSettingsIPC();
    registerOCRUtilsIPC();
    registerFrontPageIPC();
    registerPythonIPC();
    registerStateIPC();

    ipcMain.handle('show-error-box', async (_event, { title, message, detail }) => {
        const mainWindow = deps.getMainWindow();
        const response = mainWindow
            ? await dialog.showMessageBox(mainWindow, {
                  type: 'error',
                  title,
                  message,
                  detail,
                  buttons: ['OK'],
              })
            : await dialog.showMessageBox({
                  type: 'error',
                  title,
                  message,
                  detail,
                  buttons: ['OK'],
              });
        return response;
    });

    ipcMain.handle('show-message-box', async (_event, options) => {
        const mainWindow = deps.getMainWindow();
        const response = mainWindow
            ? await dialog.showMessageBox(mainWindow, options)
            : await dialog.showMessageBox(options);
        return response;
    });

    ipcMain.handle('open-external', async (_event, url) => {
        try {
            await shell.openExternal(url);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err && err.message ? err.message : String(err) };
        }
    });

    ipcMain.handle('get-platform', async () => {
        return process.platform;
    });

    ipcMain.on('settings.iconStyleChanged', async () => {
        const mainWindow = deps.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        const response = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Restart Required',
            message: 'Changing the icon requires restarting the app. Restart now?',
            buttons: ['Restart', 'Later'],
            defaultId: 0,
            cancelId: 1,
        });

        if (response.response === 0) {
            await deps.restartApplication();
        }
    });
}
