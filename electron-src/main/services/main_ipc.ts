import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { registerStateIPC } from '../communication/state.js';
import { registerPythonIPC } from '../ui/python.js';
import { registerFrontPageIPC } from '../ui/front.js';
import { registerOCRUtilsIPC } from '../ui/ocr.js';
import { registerSettingsIPC } from '../ui/settings.js';
import { registerSteamIPC } from '../ui/steam.js';
import { registerOBSIPC } from '../ui/obs.js';
import { registerYuzuIPC } from '../ui/yuzu.js';
import { registerVNIPC } from '../ui/vn.js';
import { exportLogsArchive } from './log_export.js';
import { BASE_DIR } from '../util.js';
import { isAllowedDocsUrl } from '../../shared/docs.js';
import type { InstallSessionSnapshot } from '../../shared/install_session.js';

interface MainIPCDependencies {
    getMainWindow: () => BrowserWindow | null;
    restartApplication: () => Promise<void>;
    getUpdateStatus: () => Promise<unknown>;
    checkForUpdates: () => Promise<unknown>;
    updateNow: () => Promise<unknown>;
    getActiveInstallSession: () => InstallSessionSnapshot | null;
    retryInstallSession: () => Promise<boolean>;
}

let ipcRegistered = false;
const docsWindows = new Set<BrowserWindow>();

function openDocsWindow(url: string, parentWindow: BrowserWindow | null): BrowserWindow {
    const docsWindow = new BrowserWindow({
        width: 1280,
        height: 920,
        minWidth: 900,
        minHeight: 640,
        autoHideMenuBar: true,
        title: 'GameSentenceMiner Documentation',
        parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    docsWindow.removeMenu();
    docsWindows.add(docsWindow);

    docsWindow.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
        if (isAllowedDocsUrl(nextUrl)) {
            void docsWindow.loadURL(nextUrl);
        } else {
            void shell.openExternal(nextUrl);
        }
        return { action: 'deny' };
    });

    docsWindow.webContents.on('will-navigate', (event, nextUrl) => {
        if (!isAllowedDocsUrl(nextUrl)) {
            event.preventDefault();
            void shell.openExternal(nextUrl);
        }
    });

    docsWindow.on('closed', () => {
        docsWindows.delete(docsWindow);
    });

    void docsWindow.loadURL(url);
    return docsWindow;
}

export function registerMainIPC(deps: MainIPCDependencies): void {
    if (ipcRegistered) {
        return;
    }
    ipcRegistered = true;

    registerVNIPC();
    registerYuzuIPC();
    registerOBSIPC();
    registerSteamIPC();
    registerSettingsIPC({
        getUpdateStatus: deps.getUpdateStatus,
        checkForUpdates: deps.checkForUpdates,
        updateNow: deps.updateNow,
    });
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

    ipcMain.handle('docs.openWindow', async (event, payload) => {
        const requestedUrl =
            typeof payload === 'string'
                ? payload
                : payload && typeof payload === 'object'
                  ? (payload as { url?: unknown }).url
                  : undefined;

        if (!isAllowedDocsUrl(requestedUrl)) {
            return { success: false, error: 'Invalid documentation URL.' };
        }

        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const parentWindow = senderWindow && !senderWindow.isDestroyed()
            ? senderWindow
            : deps.getMainWindow();

        openDocsWindow(requestedUrl, parentWindow);
        return { success: true };
    });

    ipcMain.handle('get-platform', async () => {
        return process.platform;
    });

    ipcMain.handle('logs.openFolder', async () => {
        try {
            const logsDir = path.join(BASE_DIR, 'logs');
            fs.mkdirSync(logsDir, { recursive: true });
            const openResult = await shell.openPath(logsDir);
            if (openResult) {
                return { success: false, error: openResult };
            }
            return { success: true, path: logsDir };
        } catch (err: any) {
            return { success: false, error: err?.message ?? String(err) };
        }
    });

    ipcMain.handle('logs.export', async () => {
        try {
            await exportLogsArchive(deps.getMainWindow());
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message ?? String(err) };
        }
    });

    ipcMain.handle('install-session.getActive', async () => {
        return deps.getActiveInstallSession();
    });

    ipcMain.handle('install-session.retry', async () => {
        return { success: await deps.retryInstallSession() };
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
