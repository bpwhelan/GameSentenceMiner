import { ipcMain } from 'electron';
import { execFile } from 'child_process';
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
import { sendOpenTexthooker } from '../main.js';
import { USE_IN_PROCESS_OVERLAY } from '../overlay_runtime_config.js';
import {
    isInProcessOverlayRunning,
    startInProcessOverlay,
    stopInProcessOverlay,
    waitForInProcessOverlayShutdown,
} from '../overlay_runtime.js';
import { getBusConnectInfo } from '../runtime/bus_client.js';
import { getConfiguredHoshidictsEnabled } from '../gsm_config.js';
import {
    DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
    DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
    isHoshidictsActivationKey,
    MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    type HoshidictsActivationKey,
    type HoshidictsLookupMode,
    type HoshidictsReaderPreferences,
} from '../../shared/features/hoshidicts.js';

const OCR_CONFIG_DIR = path.join(BASE_DIR, 'ocr_config');
let overlayProcess: ChildProcess | null = null;
export type OverlayLaunchSource = 'manual' | 'startup' | 'auto-launcher';
let overlayLaunchSource: OverlayLaunchSource | null = null;
let overlayHoshidictsEnabledAtLaunch: boolean | null = null;
let overlayHoshidictsLookupModeAtLaunch: HoshidictsLookupMode | null = null;
let overlayHoshidictsActivationKeyAtLaunch: HoshidictsActivationKey | null = null;
let overlayHoshidictsSourceHighlightEnabledAtLaunch: boolean | null = null;
let overlayHoshidictsPopupHideDelayAtLaunch: number | null = null;
let hoshidictsLookupModeProvider: () => Promise<HoshidictsLookupMode> =
    async () => 'shift';
let hoshidictsActivationKeyProvider: () => Promise<HoshidictsActivationKey> =
    async () => DEFAULT_HOSHIDICTS_ACTIVATION_KEY;
let hoshidictsSourceHighlightProvider: () => Promise<boolean> = async () =>
    DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED;
let hoshidictsPopupHideDelayProvider: () => Promise<number> =
    async () => DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS;

export interface OverlayRuntimeState {
    isRunning: boolean;
    source: OverlayLaunchSource | null;
}

export function configureHoshidictsLookupModeProvider(
    provider: () => Promise<HoshidictsLookupMode>
): void {
    hoshidictsLookupModeProvider = provider;
}

export function configureHoshidictsActivationKeyProvider(
    provider: () => Promise<HoshidictsActivationKey>
): void {
    hoshidictsActivationKeyProvider = provider;
}

export function configureHoshidictsSourceHighlightProvider(
    provider: () => Promise<boolean>
): void {
    hoshidictsSourceHighlightProvider = provider;
}

export function configureHoshidictsPopupHideDelayProvider(
    provider: () => Promise<number>
): void {
    hoshidictsPopupHideDelayProvider = provider;
}

interface StopOverlayOptions {
    onlyIfSource?: OverlayLaunchSource;
}

function joinRuntimePath(basePath: string, ...parts: string[]): string {
    return /^[A-Za-z]:[\\/]/u.test(basePath) || basePath.startsWith('\\\\')
        ? path.win32.join(basePath, ...parts)
        : path.join(basePath, ...parts);
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
        overlayHoshidictsEnabledAtLaunch = null;
        overlayHoshidictsLookupModeAtLaunch = null;
        overlayHoshidictsActivationKeyAtLaunch = null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
        overlayHoshidictsPopupHideDelayAtLaunch = null;
    }
    return {
        isRunning,
        source: overlayLaunchSource,
    };
}

export function getOverlayHoshidictsEnabledAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsEnabledAtLaunch;
}

export function getOverlayHoshidictsLookupModeAtLaunch(): HoshidictsLookupMode | null {
    getOverlayRuntimeState();
    return overlayHoshidictsLookupModeAtLaunch;
}

export function getOverlayHoshidictsActivationKeyAtLaunch(): HoshidictsActivationKey | null {
    getOverlayRuntimeState();
    return overlayHoshidictsActivationKeyAtLaunch;
}

export function getOverlayHoshidictsSourceHighlightEnabledAtLaunch(): boolean | null {
    getOverlayRuntimeState();
    return overlayHoshidictsSourceHighlightEnabledAtLaunch;
}

export function getOverlayHoshidictsPopupHideDelayAtLaunch(): number | null {
    getOverlayRuntimeState();
    return overlayHoshidictsPopupHideDelayAtLaunch;
}

export function markOverlayHoshidictsReaderPreferencesApplied(
    preferences: HoshidictsReaderPreferences
): boolean {
    if (!getOverlayRuntimeState().isRunning) {
        return false;
    }
    overlayHoshidictsLookupModeAtLaunch = preferences.lookupMode;
    overlayHoshidictsActivationKeyAtLaunch = preferences.activationKey;
    overlayHoshidictsSourceHighlightEnabledAtLaunch =
        preferences.sourceHighlightEnabled;
    overlayHoshidictsPopupHideDelayAtLaunch = preferences.popupHideDelayMs;
    return true;
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
            overlayHoshidictsEnabledAtLaunch = null;
            overlayHoshidictsLookupModeAtLaunch = null;
            overlayHoshidictsActivationKeyAtLaunch = null;
            overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
            overlayHoshidictsPopupHideDelayAtLaunch = null;
        }
        return stopRequested;
    }

    if (!overlayProcess || overlayProcess.exitCode !== null) {
        overlayProcess = null;
        overlayLaunchSource = null;
        overlayHoshidictsEnabledAtLaunch = null;
        overlayHoshidictsLookupModeAtLaunch = null;
        overlayHoshidictsActivationKeyAtLaunch = null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
        overlayHoshidictsPopupHideDelayAtLaunch = null;
        return false;
    }

    if (options.onlyIfSource && overlayLaunchSource !== options.onlyIfSource) {
        return false;
    }

    const processHandle = overlayProcess;
    try {
        terminateOverlayProcess(processHandle);
        return true;
    } catch (error) {
        console.error('Failed to stop overlay process:', error);
        return false;
    }
}

export async function waitForOverlayShutdown(): Promise<void> {
    if (USE_IN_PROCESS_OVERLAY) {
        await waitForInProcessOverlayShutdown();
        return;
    }

    const processHandle = overlayProcess;
    if (!processHandle || processHandle.exitCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timeout);
            processHandle.removeListener('exit', done);
            processHandle.removeListener('error', done);
            resolve();
        };
        const timeout = setTimeout(done, 10_000);
        processHandle.once('exit', done);
        processHandle.once('error', done);
    });
}

export async function restartOverlay(): Promise<boolean> {
    const state = getOverlayRuntimeState();
    const source = state.source ?? 'manual';
    if (state.isRunning) {
        if (!stopOverlay()) {
            return false;
        }
        await waitForOverlayShutdown();
        if (getOverlayRuntimeState().isRunning) {
            return false;
        }
    }
    return await runOverlayWithSource(source);
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

function registerOverlayProcess(
    processHandle: ChildProcess,
    source: OverlayLaunchSource,
    hoshidictsEnabled: boolean,
    hoshidictsLookupMode: HoshidictsLookupMode,
    hoshidictsPopupHideDelayMs: number,
    hoshidictsActivationKey: HoshidictsActivationKey,
    hoshidictsSourceHighlightEnabled: boolean
): void {
    overlayProcess = processHandle;
    overlayLaunchSource = source;
    overlayHoshidictsEnabledAtLaunch = hoshidictsEnabled;
    overlayHoshidictsLookupModeAtLaunch = hoshidictsLookupMode;
    overlayHoshidictsActivationKeyAtLaunch = hoshidictsActivationKey;
    overlayHoshidictsSourceHighlightEnabledAtLaunch =
        hoshidictsSourceHighlightEnabled;
    overlayHoshidictsPopupHideDelayAtLaunch = hoshidictsPopupHideDelayMs;
    overlayProcess.once('exit', () => {
        overlayProcess = null;
        overlayLaunchSource = null;
        overlayHoshidictsEnabledAtLaunch = null;
        overlayHoshidictsLookupModeAtLaunch = null;
        overlayHoshidictsActivationKeyAtLaunch = null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
        overlayHoshidictsPopupHideDelayAtLaunch = null;
    });
    overlayProcess.once('error', (error: Error) => {
        console.error('Overlay process error:', error);
        overlayProcess = null;
        overlayLaunchSource = null;
        overlayHoshidictsEnabledAtLaunch = null;
        overlayHoshidictsLookupModeAtLaunch = null;
        overlayHoshidictsActivationKeyAtLaunch = null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = null;
        overlayHoshidictsPopupHideDelayAtLaunch = null;
    });
}

export function buildHoshidictsOverlayEnvironment(
    enabled: boolean,
    lookupMode: HoshidictsLookupMode = 'shift',
    popupHideDelayMs = DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    activationKey: HoshidictsActivationKey = DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
    sourceHighlightEnabled = DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED
): Record<string, string> {
    return {
        GSM_HOSHIDICTS_ENABLED: enabled ? '1' : '0',
        GSM_HOSHIDICTS_LOOKUP_MODE: lookupMode,
        GSM_HOSHIDICTS_ACTIVATION_KEY: activationKey,
        GSM_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED:
            sourceHighlightEnabled ? '1' : '0',
        GSM_HOSHIDICTS_POPUP_HIDE_DELAY_MS: String(popupHideDelayMs),
    };
}

export function buildOverlayDesktopBusEnvironment(): Record<string, string> {
    const connectInfo = getBusConnectInfo();
    if (!connectInfo) {
        return {};
    }
    return {
        GSM_BROKER_PORT: String(connectInfo.port),
        GSM_BROKER_TOKEN: connectInfo.token,
        GSM_CLIENT_ID: 'overlay',
    };
}

function spawnOverlayFromSource(
    overlayDir: string,
    env: NodeJS.ProcessEnv
) {
    if (
        process.platform === 'win32' ||
        /^[A-Za-z]:[\\/]/u.test(overlayDir) ||
        overlayDir.startsWith('\\\\')
    ) {
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

function spawnSharedOverlayRuntime(
    spawn: typeof import('child_process').spawn,
    hoshidictsEnvironment: Record<string, string>
): ChildProcess {
    const overlayResourcesPath = getOverlayResourcesPath();
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GSM_OVERLAY_CHILD: '1',
        GSM_OVERLAY_SHARED_RUNTIME: '1',
        [OVERLAY_RESOURCES_ENV]: overlayResourcesPath,
        ...hoshidictsEnvironment,
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
    const hoshidictsEnabled = getConfiguredHoshidictsEnabled();
    let hoshidictsLookupMode: HoshidictsLookupMode = 'shift';
    let hoshidictsActivationKey = DEFAULT_HOSHIDICTS_ACTIVATION_KEY;
    let hoshidictsSourceHighlightEnabled =
        DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED;
    let hoshidictsPopupHideDelayMs = DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS;
    if (hoshidictsEnabled) {
        try {
            hoshidictsLookupMode =
                (await hoshidictsLookupModeProvider()) === 'hover'
                    ? 'hover'
                    : 'shift';
            const configuredActivationKey =
                await hoshidictsActivationKeyProvider();
            hoshidictsActivationKey = isHoshidictsActivationKey(
                configuredActivationKey
            )
                ? configuredActivationKey
                : DEFAULT_HOSHIDICTS_ACTIVATION_KEY;
            hoshidictsSourceHighlightEnabled =
                (await hoshidictsSourceHighlightProvider()) === true;
            const configuredHideDelay = await hoshidictsPopupHideDelayProvider();
            hoshidictsPopupHideDelayMs =
                Number.isInteger(configuredHideDelay) &&
                configuredHideDelay >= 0 &&
                configuredHideDelay <= MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS
                    ? configuredHideDelay
                    : DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS;
        } catch (error) {
            console.warn(
                '[Hoshidicts] Could not load lookup mode; using Shift lookup.',
                error
            );
        }
    }
    const hoshidictsEnvironment = buildHoshidictsOverlayEnvironment(
        hoshidictsEnabled,
        hoshidictsLookupMode,
        hoshidictsPopupHideDelayMs,
        hoshidictsActivationKey,
        hoshidictsSourceHighlightEnabled
    );
    const desktopBusEnvironment = buildOverlayDesktopBusEnvironment();
    if (USE_IN_PROCESS_OVERLAY) {
        if (isInProcessOverlayRunning()) {
            console.log('Overlay is already running.');
            return true;
        }
        Object.assign(
            process.env,
            hoshidictsEnvironment,
            desktopBusEnvironment
        );
        const started = await startInProcessOverlay();
        overlayLaunchSource = started ? source : null;
        overlayHoshidictsEnabledAtLaunch = started
            ? hoshidictsEnabled
            : null;
        overlayHoshidictsLookupModeAtLaunch = started
            ? hoshidictsLookupMode
            : null;
        overlayHoshidictsActivationKeyAtLaunch = started
            ? hoshidictsActivationKey
            : null;
        overlayHoshidictsSourceHighlightEnabledAtLaunch = started
            ? hoshidictsSourceHighlightEnabled
            : null;
        overlayHoshidictsPopupHideDelayAtLaunch = started
            ? hoshidictsPopupHideDelayMs
            : null;
        return started;
    }

    if (overlayProcess && overlayProcess.exitCode === null) {
        console.log('Overlay is already running.');
        return true;
    }

    const { spawn } = await import('child_process');

    if (isDev) {
        const overlayDir = joinRuntimePath(getResourcesDir(), 'GSM_Overlay');
        const overlayPackagePath = joinRuntimePath(overlayDir, 'package.json');

        if (!fs.existsSync(overlayPackagePath)) {
            console.error('Overlay package.json not found at:', overlayPackagePath);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }

        const sourceLaunch = spawnOverlayFromSource(overlayDir, {
            ...process.env,
            ...hoshidictsEnvironment,
            ...desktopBusEnvironment,
        });
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

        registerOverlayProcess(
            processHandle,
            source,
            hoshidictsEnabled,
            hoshidictsLookupMode,
            hoshidictsPopupHideDelayMs,
            hoshidictsActivationKey,
            hoshidictsSourceHighlightEnabled
        );
        console.log('Overlay launched successfully from source.');
        return true;
    }

    const overlayAppAsarPath = getOverlayAppAsarPath();
    if (fs.existsSync(overlayAppAsarPath)) {
        try {
            const processHandle = spawnSharedOverlayRuntime(
                spawn,
                {
                    ...hoshidictsEnvironment,
                    ...desktopBusEnvironment,
                }
            );
            registerOverlayProcess(
                processHandle,
                source,
                hoshidictsEnabled,
                hoshidictsLookupMode,
                hoshidictsPopupHideDelayMs,
                hoshidictsActivationKey,
                hoshidictsSourceHighlightEnabled
            );
            console.log('Overlay launched successfully with shared Electron runtime.');
            return true;
        } catch (error) {
            console.error('Failed to launch overlay with shared Electron runtime:', error);
            overlayProcess = null;
            overlayLaunchSource = null;
            return false;
        }
    }

    const overlayPath = joinRuntimePath(getOverlayPath(), getOverlayExecName());
    if (fs.existsSync(overlayPath)) {
        try {
            const processHandle = spawn(overlayPath, [], {
                detached: false,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    ...hoshidictsEnvironment,
                    ...desktopBusEnvironment,
                },
            });
            registerOverlayProcess(
                processHandle,
                source,
                hoshidictsEnabled,
                hoshidictsLookupMode,
                hoshidictsPopupHideDelayMs,
                hoshidictsActivationKey,
                hoshidictsSourceHighlightEnabled
            );
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
