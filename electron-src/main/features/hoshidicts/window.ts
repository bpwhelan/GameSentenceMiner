import { BrowserWindow, shell } from 'electron';

import {
    getRendererEntryPath,
    getSecureWebPreferences,
} from '../../util.js';

const HOSHIDICTS_WINDOW_QUERY = 'hoshidicts-settings';

let settingsWindow: BrowserWindow | null = null;

function isExternalUrl(url: string): boolean {
    return url.startsWith('https://') || url.startsWith('http://');
}

export function getHoshidictsSettingsWindow(): BrowserWindow | null {
    if (settingsWindow?.isDestroyed()) {
        settingsWindow = null;
    }
    return settingsWindow;
}

export async function openHoshidictsSettingsWindow(): Promise<BrowserWindow> {
    const existing = getHoshidictsSettingsWindow();
    if (existing) {
        if (existing.isMinimized()) {
            existing.restore();
        }
        existing.show();
        existing.focus();
        return existing;
    }

    const window = new BrowserWindow({
        width: 1040,
        height: 820,
        minWidth: 760,
        minHeight: 600,
        show: false,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        title: 'Hoshidicts Settings',
        backgroundColor: '#1a1a1a',
        webPreferences: getSecureWebPreferences(),
    });
    settingsWindow = window;
    window.removeMenu();
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isExternalUrl(url)) {
            void shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (url !== window.webContents.getURL()) {
            event.preventDefault();
            if (isExternalUrl(url)) {
                void shell.openExternal(url);
            }
        }
    });
    window.on('closed', () => {
        if (settingsWindow === window) {
            settingsWindow = null;
        }
    });
    window.once('ready-to-show', () => {
        if (!window.isDestroyed()) {
            window.show();
        }
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
        const url = new URL(devServerUrl);
        url.searchParams.set('window', HOSHIDICTS_WINDOW_QUERY);
        await window.loadURL(url.toString());
    } else {
        await window.loadFile(getRendererEntryPath(), {
            query: { window: HOSHIDICTS_WINDOW_QUERY },
        });
    }

    return window;
}
