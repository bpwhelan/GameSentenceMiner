import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    BASE_DIR,
    getOverlayAppAsarPath,
    getOverlayExecName,
    getOverlayPath,
    getOverlayResourcesPath,
    getResourcesDir,
    isDev,
    OVERLAY_RESOURCES_ENV,
} from '../util.js';
import {
    getFrontPageState,
    getSteamGames,
    getVNs,
    getYuzuRomsPath,
    LaunchableGame,
    HookableGameType,
    OCRGame,
    setFrontPageState,
} from '../store.js';
import { getConfiguredYuzuGames, getYuzuGames } from './yuzu.js';
import { getOBSConnection, getOBSScenes } from './obs.js';
import { getSceneOCRConfig } from './ocr.js';
import { sendOpenTexthooker, sendStopOverlay } from '../main.js';
import { USE_IN_PROCESS_OVERLAY } from '../overlay_runtime_config.js';
import {
    isInProcessOverlayRunning,
    startInProcessOverlay,
    stopInProcessOverlay,
    waitForInProcessOverlayShutdown,
} from '../overlay_runtime.js';

const OCR_CONFIG_DIR = path.join(BASE_DIR, 'ocr_config');
let overlayProcess: ChildProcess | null = null;
export type OverlayLaunchSource = 'manual' | 'startup' | 'auto-launcher';
let overlayLaunchSource: OverlayLaunchSource | null = null;
let overlayLaunchId: string | null = null;
let overlayExitPromise: Promise<void> | null = null;
let overlayStopRequested = false;
let overlayShutdownTimer: NodeJS.Timeout | null = null;
const OVERLAY_SHUTDOWN_GRACE_MS = 5000;
const OVERLAY_SHUTDOWN_TIMEOUT_MS = 15000;

export interface OverlayRuntimeState {
    isRunning: boolean;
    source: OverlayLaunchSource | null;
}

interface StopOverlayOptions {
    onlyIfSource?: OverlayLaunchSource;
}

export function registerFrontPageIPC() {
    // Save the front page state
    ipcMain.handle('front.saveState', async (_, state: any) => {
        try {
            const { hookableGames, ocrGames, ...restState } = state;
            setFrontPageState(restState); // Use the store method to save the state without hookableGames and ocrGames
            return { status: 'success', message: 'State saved successfully' };
        } catch (error) {
            console.error('Error saving front page state:', error);
            return { status: 'error', message: 'Failed to save state' };
        }
    });

    // Get the saved front page state
    ipcMain.handle('front.getSavedState', async () => {
        try {
            const state = getFrontPageState(); // Use the store method to retrieve the state
            const vns = getVNs();
            const steamGames = getSteamGames();
            const yuzuGames = getConfiguredYuzuGames();
            // Combine the games into a single array for hookable games

            state.launchableGames = [
                {
                    name: 'Game',
                    id: '0',
                    type: HookableGameType.None,
                    isHeader: true,
                    scene: undefined,
                },
                ...steamGames.map((game) => ({
                    name: game.name,
                    id: String(game.id),
                    type: HookableGameType.Steam,
                    scene: game.scene,
                })),
                // {name: "Misc/VN", id: "0", type: HookableGameType.None, isHeader: true, scene: undefined},
                // ...vns.map(vn => ({name: vn.path, id: vn.path, type: HookableGameType.VN, scene: vn.scene})),
                {
                    name: 'Yuzu',
                    id: '0',
                    type: HookableGameType.None,
                    isHeader: true,
                    scene: undefined,
                },
                ...yuzuGames.map((game) => ({
                    name: game.name,
                    id: game.id,
                    type: HookableGameType.Yuzu,
                    scene: game.scene,
                })),
            ];

            return state || null;
        } catch (error) {
            console.error('Error retrieving saved front page state:', error);
            return null;
        }
    });

    // Get all OCR configs
    ipcMain.handle('front.getAllOCRConfigs', async () => {
        return await getAllOCRConfigs();
    });

    ipcMain.handle('open-external-link', async (_, url: string) => {
        const { shell } = await import('electron');
        await shell.openExternal(url);
    });

    ipcMain.handle('openTexthooker', async () => {
        sendOpenTexthooker();
    });

    ipcMain.handle('runOverlay', async () => {
        await runOverlay();
    });

    ipcMain.handle('getOverlayStatus', () => {
        return getOverlayRuntimeState();
    });
}

export async function runOverlay() {
    return runOverlayWithSource('manual');
}

export function getOverlayRuntimeState(): OverlayRuntimeState {
    const isRunning = USE_IN_PROCESS_OVERLAY
        ? isInProcessOverlayRunning()
        : Boolean(overlayProcess && overlayProcess.exitCode === null);
    if (!isRunning) {
        overlayLaunchSource = null;
    }
    return {
        isRunning,
        source: overlayLaunchSource,
    };
}

export function stopOverlay(options: StopOverlayOptions = {}): boolean {
    if (USE_IN_PROCESS_OVERLAY) {
        if (!isInProcessOverlayRunning()) {
            overlayLaunchSource = null;
            return false;
        }
        if (options.onlyIfSource && overlayLaunchSource !== options.onlyIfSource) {
            return false;
        }
        const stopRequested = stopInProcessOverlay();
        if (stopRequested) {
            overlayLaunchSource = null;
        }
        return stopRequested;
    }

    if (!overlayProcess || overlayProcess.exitCode !== null) {
        overlayProcess = null;
        overlayLaunchSource = null;
        return false;
    }

    if (options.onlyIfSource && overlayLaunchSource !== options.onlyIfSource) {
        return false;
    }

    if (overlayStopRequested) {
        return true;
    }

    const processHandle = overlayProcess;
    try {
        overlayStopRequested = true;
        if (overlayLaunchId && sendStopOverlay(overlayLaunchId)) {
            overlayShutdownTimer = setTimeout(() => {
                overlayShutdownTimer = null;
                if (overlayProcess !== processHandle || processHandle.exitCode !== null) return;
                console.warn('Overlay did not quit gracefully; stopping its managed process tree.');
                try {
                    terminateOverlayProcess(processHandle);
                } catch (error) {
                    console.error('Failed to stop unresponsive overlay process:', error);
                }
            }, OVERLAY_SHUTDOWN_GRACE_MS);
        } else {
            terminateOverlayProcess(processHandle);
        }
        return true;
    } catch (error) {
        overlayStopRequested = false;
        console.error('Failed to stop overlay process:', error);
        return false;
    }
}

export async function waitForOverlayShutdown(): Promise<void> {
    if (USE_IN_PROCESS_OVERLAY) {
        await waitForInProcessOverlayShutdown();
        return;
    }
    if (!overlayStopRequested || !overlayExitPromise) return;

    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            overlayExitPromise,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error('Timed out waiting for overlay shutdown.')),
                    OVERLAY_SHUTDOWN_TIMEOUT_MS
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

function terminateOverlayProcess(processHandle: ChildProcess): void {
    if (process.platform === 'win32' && processHandle.pid) {
        execFile(
            'taskkill',
            ['/PID', String(processHandle.pid), '/T', '/F'],
            { windowsHide: true },
            (error) => {
                if (error && processHandle.exitCode === null && !processHandle.killed) {
                    processHandle.kill();
                }
            }
        );
        return;
    }

    processHandle.kill();
}

function registerOverlayProcess(processHandle: ChildProcess, source: OverlayLaunchSource, launchId: string): void {
    overlayProcess = processHandle;
    overlayLaunchSource = source;
    overlayLaunchId = launchId;
    overlayStopRequested = false;
    overlayExitPromise = new Promise<void>((resolve) => {
        const onExit = () => {
            if (overlayProcess === processHandle) {
                if (overlayShutdownTimer) clearTimeout(overlayShutdownTimer);
                overlayShutdownTimer = null;
                overlayProcess = null;
                overlayLaunchSource = null;
                overlayLaunchId = null;
                overlayStopRequested = false;
            }
            resolve();
        };
        processHandle.once('exit', onExit);
        processHandle.once('error', (error: Error) => {
            console.error('Overlay process error:', error);
            onExit();
        });
    });
}

function spawnOverlayFromSource(overlayDir: string, launchId: string) {
    const env = { ...process.env, GSM_OVERLAY_LAUNCH_ID: launchId };
    if (process.platform === 'win32') {
        return {
            command: 'cmd.exe',
            args: ['/d', '/s', '/c', 'npm run start'],
            options: {
                cwd: overlayDir,
                detached: false,
                stdio: 'ignore' as const,
                env,
            },
        };
    }

    return {
        command: 'npm',
        args: ['run', 'start'],
        options: {
            cwd: overlayDir,
            detached: false,
            stdio: 'ignore' as const,
            env,
        },
    };
}

function spawnSharedOverlayRuntime(spawn: typeof import('child_process').spawn, launchId: string): ChildProcess {
    const overlayResourcesPath = getOverlayResourcesPath();
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GSM_OVERLAY_CHILD: '1',
        GSM_OVERLAY_SHARED_RUNTIME: '1',
        GSM_OVERLAY_LAUNCH_ID: launchId,
        [OVERLAY_RESOURCES_ENV]: overlayResourcesPath,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    return spawn(
        process.execPath,
        [],
        {
            detached: false,
            stdio: 'ignore',
            env,
        }
    );
}

export async function runOverlayWithSource(
    source: OverlayLaunchSource = 'manual'
): Promise<boolean> {
    if (USE_IN_PROCESS_OVERLAY) {
        if (isInProcessOverlayRunning()) {
            console.log('Overlay is already running.');
            return true;
        }
        const started = await startInProcessOverlay();
        overlayLaunchSource = started ? source : null;
        return started;
    }

    if (overlayStopRequested) {
        await waitForOverlayShutdown();
    }

    if (overlayProcess && overlayProcess.exitCode === null) {
        console.log('Overlay is already running.');
        return true;
    }

    const { spawn } = await import('child_process');
    const launchId = randomUUID();

    if (isDev) {
        const overlayDir = path.join(getResourcesDir(), 'GSM_Overlay');
        const overlayPackagePath = path.join(overlayDir, 'package.json');

        if (!fs.existsSync(overlayPackagePath)) {
            console.error('Overlay package.json not found at:', overlayPackagePath);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }

        const sourceLaunch = spawnOverlayFromSource(overlayDir, launchId);
        let processHandle: ChildProcess;
        try {
            processHandle = spawn(
                sourceLaunch.command,
                sourceLaunch.args,
                sourceLaunch.options
            );
        } catch (error) {
            console.error('Failed to launch overlay from source:', error);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }

        registerOverlayProcess(processHandle, source, launchId);
        console.log('Overlay launched successfully from source.');
        return true;
    }

    const overlayAppAsarPath = getOverlayAppAsarPath();
    if (fs.existsSync(overlayAppAsarPath)) {
        try {
            const processHandle = spawnSharedOverlayRuntime(spawn, launchId);
            registerOverlayProcess(processHandle, source, launchId);
            console.log('Overlay launched successfully with shared Electron runtime.');
            return true;
        } catch (error) {
            console.error('Failed to launch overlay with shared Electron runtime:', error);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }
    }

    const overlayPath = path.join(getOverlayPath(), getOverlayExecName());
    if (fs.existsSync(overlayPath)) {
        try {
            const processHandle = spawn(overlayPath, [], {
                detached: false,
                stdio: 'ignore',
                env: { ...process.env, GSM_OVERLAY_LAUNCH_ID: launchId },
            });
            registerOverlayProcess(processHandle, source, launchId);
            console.log('Overlay launched successfully with legacy standalone runtime.');
            return true;
        } catch (error) {
            console.error('Failed to launch overlay executable:', error);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }
    } else {
        console.error('Overlay app bundle not found at:', overlayAppAsarPath);
        console.error('Overlay executable not found at:', overlayPath);
        overlayProcess = null;
        overlayLaunchSource = null;
        return false;
    }
}

async function getAllOCRConfigs(): Promise<OCRGame[]> {
    // try {
    await getOBSConnection();
    const scenes = await getOBSScenes();
    return scenes
        .filter((scene) => fs.existsSync(getSceneOCRConfig(scene)))
        .map((scene) => {
            return {
                scene: scene,
                configPath: getSceneOCRConfig(scene),
            } as OCRGame;
        });
    //     const files = await fs.promises.readdir(OCR_CONFIG_DIR);
    //
    //     const configs = await Promise.all(
    //         files
    //             .filter(file => file.endsWith('.json'))
    //             .map(async file => {
    //             const filePath = path.join(OCR_CONFIG_DIR, file);
    //             const content = await fs.promises.readFile(filePath, 'utf-8');
    //             const json = JSON.parse(content);
    //             if (json.scene) {
    //                     return { scene: json.scene, configPath: filePath };
    //         }
    //                 return null;
    //             })
    //     );
    //
    //     // Filter out any null values
    //     return configs.filter(config => config !== null) as OCRGame[];
    // } catch (error) {
    //     console.error('Error getting OCR configs:', error);
    //     return [];
    // }
}
