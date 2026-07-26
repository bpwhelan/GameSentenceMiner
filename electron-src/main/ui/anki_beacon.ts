import axios from 'axios';
import { app, ipcMain, shell } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DEFAULT_GSM_SINGLE_PORT, getConfiguredSinglePort } from '../gsm_config.js';
import { writeConfiguredAnkiBeaconAddon } from './anki_beacon_package.js';

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
        const addonBytes = Buffer.from(response.data);
        const gsmPort = getConfiguredSinglePort();
        if (gsmPort === DEFAULT_GSM_SINGLE_PORT) {
            await fs.writeFile(filePath, addonBytes);
        } else {
            await writeConfiguredAnkiBeaconAddon(addonBytes, filePath, gsmPort);
        }

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
