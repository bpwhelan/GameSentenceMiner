import * as os from 'os';
import path from "path";
import {promisify} from "util";
import {execFile, spawn} from "child_process";
import {app} from "electron";
import {__dirname} from "./main.js";

export type SupportedPlatform = 'linux' | 'darwin' | 'win32';
export const isMac = process.platform === 'darwin';
export const cpuModel = os.cpus()[0]?.model || null;
export const isArmMac: boolean = isMac && !!cpuModel && /Apple M\d/i.test(cpuModel);

export const APP_NAME = 'GameSentenceMiner';
export const PACKAGE_NAME = "GameSentenceMiner";
export const execFileAsync = promisify(execFile);

export const isDev = !app.isPackaged;

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

export function isWindows(): boolean {
    return getPlatform() === 'win32';
}

export function isLinux(): boolean {
    return getPlatform() === 'linux';
}

export function isMacOS(): boolean {
    return getPlatform() === 'darwin';
}

export function isWindows10OrHigher(): boolean {
    return isWindows() && parseInt(process.getSystemVersion().split('.')[0]) >= 10;
}

/**
 * Get the base directory for assets.
 * Handles both development and production (ASAR) environments.
 * @returns {string} - Path to the assets directory.
 */
export function getAssetsDir(): string {
    return isDev
        ? path.join(__dirname, "../../electron-src/assets") // Development path
        : path.join(process.resourcesPath, "assets"); // Production (ASAR-safe)
}

export function getGSMBaseDir(): string {
    return isDev
        ? "./" // Development path
        : process.resourcesPath
}

export function getResourcesDir(): string {
    return isDev
        ? path.join(__dirname, "../../") // Development path
        : path.join(process.resourcesPath, "resources"); // Production (ASAR-safe)
}

export function getOverlayPath(): string {
    return isDev
        ? path.join(__dirname, "../../GSM_Overlay/out/gsm_overlay-win32-x64") // Development path
        : path.join(process.resourcesPath, "GSM_Overlay/gsm_overlay-win32-x64"); // Production (ASAR-safe)
}

export function sanitizeFilename(filename: string): string {
    return filename.replace(/[ <>:"/\\|?*\x00-\x1F]/g, '');
}

export async function isConnected() {
    try {
        const isConnected = await fetch("https://www.google.com", { method: "HEAD" });
        return isConnected.ok;
    } catch (err) {
        return false;
    }
}

export async function runPythonScript(pythonPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const process = spawn(pythonPath, args);

        let output = '';
        process.stdout.on('data', (data) => {
            output += data.toString();
        });

        process.stderr.on('data', (data) => {
            console.error(`[Python STDERR]: ${data}`);
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`Python script exited with code ${code}`));
            }
        });
    });
}