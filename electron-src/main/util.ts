import * as os from 'os';
import * as path from "path";
import {promisify} from "util";
import {execFile} from "child_process";

export type SupportedPlatform = 'linux' | 'darwin' | 'win32';
export const isMac = process.platform === 'darwin';
export const cpuModel = os.cpus()[0]?.model || null;
export const isArmMac: boolean = isMac && !!cpuModel && /Apple M\d/i.test(cpuModel);

export const APP_NAME = 'GameSentenceMiner';
export const execFileAsync = promisify(execFile);

export const BASE_DIR = process.env.APPDATA
    ? path.join(process.env.APPDATA, APP_NAME) // Windows
    : path.join(os.homedir(), '.config', APP_NAME); // macOS/Linux

export const getPlatform = (): SupportedPlatform => {
    const platform = os.platform();
    switch (platform) {
        case 'win32':
        case 'linux':
        case 'darwin':
            return platform;
        default:
            throw new Error(
                `Unsupported platform: ${platform}. Please report this to us and we may add support.`
            );
    }
};