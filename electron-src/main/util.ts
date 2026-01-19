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

export const DOWNLOAD_DIR = path.join(BASE_DIR, 'downloads');

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
        : path.join(process.resourcesPath); // Production (ASAR-safe)
}

export function getOverlayPath(): string {
    // Overlay builds are produced per-platform into folders named like
    // gsm_overlay-<platform>-<arch> (e.g. gsm_overlay-win32-x64, gsm_overlay-linux-x64).
    const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
    const platformName = getPlatform();
    const dirName = `gsm_overlay-${platformName}-${arch}`;
    return isDev
        ? path.join(__dirname, `../../GSM_Overlay/out/${dirName}`) // Development path
        : path.join(process.resourcesPath, `GSM_Overlay/${dirName}`); // Production (ASAR-safe)
}

export function getOverlayExecName(): string {
    // On Windows the executable ends with .exe, on other platforms it's a naked executable.
    return isWindows() ? 'gsm_overlay.exe' : 'gsm_overlay';
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

/**
 * Creates a sanitized environment for running managed Python instances.
 * Removes environment variables that could interfere with the isolated Python installation.
 */
export function getSanitizedPythonEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    
    // Remove Python-specific variables that could cause conflicts
    const varsToRemove = [
        // Tk/Tcl libraries
        'TCL_LIBRARY',
        'TK_LIBRARY',
        // Python paths
        'PYTHONPATH',
        'PYTHONHOME',
        'PYTHONSTARTUP',
        'PYTHONUSERBASE',
        // Virtual environments
        'VIRTUAL_ENV',
        'CONDA_PREFIX',
        'CONDA_DEFAULT_ENV',
        'CONDA_PYTHON_EXE',
        'CONDA_SHLVL',
        // Python version managers
        'PYENV_ROOT',
        'PYENV_VERSION',
        'PYENV_SHELL',
        'PYENV_VIRTUAL_ENV',
        // Poetry
        'POETRY_ACTIVE',
        'POETRY_HOME',
        // Pip configuration
        'PIP_CONFIG_FILE',
        'PIP_REQUIRE_VIRTUALENV',
    ];
    
    varsToRemove.forEach(varName => {
        delete env[varName];
    });
    
    // Set variables to isolate the Python instance
    // env['PYTHONNOUSERSITE'] = '1';  // Prevent loading user site-packages
    env['PYTHONIOENCODING'] = 'utf-8';  // Ensure consistent encoding
    
    return env;
}

import {exec} from "child_process";

export async function getPidByProcessName(processName: string): Promise<number> {
    return new Promise((resolve, reject) => {
        let command: string;

        if (process.platform === "win32") {
            command = `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`;
        } else {
            command = `pgrep ${processName}`;
        }

        const startTime = Date.now();
        const retryInterval = 1000; // Retry every second
        const timeout = 5000; // Timeout after 5 seconds (Reduced from 30s for quick check)

        const tryGetPid = () => {
            exec(command, (error, stdout) => {
                if (error) {
                    if (Date.now() - startTime >= timeout) {
                        return resolve(-1);
                    } else {
                        // console.log("Error getting PID, Retrying...");
                        return setTimeout(tryGetPid, retryInterval);
                    }
                }

                const pids = stdout
                    .trim()
                    .split("\n")
                    .map(line => {
                        if (process.platform === "win32") {
                            const match = line.match(/"([^"]+)",\s*"(\d+)"/);
                            return match ? parseInt(match[2], 10) : -1;
                        }
                        return parseInt(line.trim(), 10);
                    })
                    .filter(pid => pid !== -1) as number[];

                if (pids.length > 0) {
                    return resolve(pids[0]);
                } else if (Date.now() - startTime >= timeout) {
                    return resolve(-1);
                } else {
                    // console.log("PID not found yet, Retrying...");
                    setTimeout(tryGetPid, retryInterval);
                }
            });
        };

        tryGetPid();
    });
}

export async function runPythonScript(pythonPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const process = spawn(pythonPath, args, {
            env: getSanitizedPythonEnv()
        });

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