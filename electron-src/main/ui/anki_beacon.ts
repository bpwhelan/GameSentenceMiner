import axios from 'axios';
import { app, ipcMain, shell } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const ANKI_BEACON_ADDON_URL =
    'https://github.com/bpwhelan/AnkiBeacon/releases/latest/download/Anki.Beacon.ankiaddon';

export interface AnkiBeaconInstallResult {
    success: boolean;
    filePath?: string;
    error?: string;
}

function errorToMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error || 'Unknown error');
}

export async function installAnkiBeaconAddon(): Promise<AnkiBeaconInstallResult> {
    const installDir = path.join(app.getPath('temp'), 'GameSentenceMiner');
    const filePath = path.join(installDir, 'Anki.Beacon.ankiaddon');

    try {
        await fs.mkdir(installDir, { recursive: true });
        const response = await axios.get<ArrayBuffer>(ANKI_BEACON_ADDON_URL, {
            responseType: 'arraybuffer',
            timeout: 60_000,
        });
        await fs.writeFile(filePath, Buffer.from(response.data));

        const openError = await shell.openPath(filePath);
        if (openError) {
            return { success: false, error: openError };
        }

        return { success: true, filePath };
    } catch (error) {
        return { success: false, error: errorToMessage(error) };
    }
}

export function registerAnkiBeaconIPC(): void {
    ipcMain.handle('ankiBeacon.install', async () => installAnkiBeaconAddon());
}
