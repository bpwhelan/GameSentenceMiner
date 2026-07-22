import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { getBaseDir, getDefaultBaseDir } from './data_dir.js';
import {
    getOverlayAppAsarPath,
    getOverlayResourcesPath,
    getResourcesDir,
    isDev,
    OVERLAY_RESOURCES_ENV,
} from './util.js';

const OVERLAY_IN_PROCESS_ENV = 'GSM_OVERLAY_IN_PROCESS';
const OVERLAY_DATA_PATH_ENV = 'GSM_OVERLAY_DATA_PATH';
const OVERLAY_HOST_SYMBOL = Symbol.for('gsm.overlay.host');
const overlayRequire = createRequire(import.meta.url);

interface OverlayModule {
    startOverlayApp(): Promise<void> | void;
    stopOverlayApp(): Promise<void> | void;
    isOverlayRunning?(): boolean;
}

interface OverlayHost {
    requestStop(): void;
}

interface EnvironmentBackup {
    key: string;
    value: string | undefined;
}

let overlayModule: OverlayModule | null = null;
let overlayModuleRoot: string | null = null;
let overlayStartPromise: Promise<boolean> | null = null;
let overlayStopPromise: Promise<void> | null = null;
let environmentBackup: EnvironmentBackup[] | null = null;

function getOverlayDataPath(): string {
    const baseDir = getBaseDir();
    return path.resolve(baseDir) === path.resolve(getDefaultBaseDir())
        ? path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'gsm_overlay')
        : path.join(baseDir, 'gsm_overlay');
}

function resolveOverlayModule(): { entryPath: string; rootPath: string } {
    if (isDev) {
        const rootPath = path.join(getResourcesDir(), 'GSM_Overlay');
        return {
            entryPath: path.join(rootPath, 'main.js'),
            rootPath,
        };
    }

    const rootPath = getOverlayAppAsarPath();
    return {
        entryPath: path.join(rootPath, 'main.js'),
        rootPath,
    };
}

function installOverlayEnvironment(): void {
    if (environmentBackup) {
        return;
    }

    const updates: Record<string, string> = {
        [OVERLAY_IN_PROCESS_ENV]: '1',
        GSM_OVERLAY_SHARED_RUNTIME: '1',
        [OVERLAY_RESOURCES_ENV]: getOverlayResourcesPath(),
        [OVERLAY_DATA_PATH_ENV]: getOverlayDataPath(),
    };
    environmentBackup = Object.keys(updates).map((key) => ({
        key,
        value: process.env[key],
    }));
    for (const [key, value] of Object.entries(updates)) {
        process.env[key] = value;
    }
}

function restoreOverlayEnvironment(): void {
    if (!environmentBackup) {
        return;
    }
    for (const entry of environmentBackup) {
        if (entry.value === undefined) {
            delete process.env[entry.key];
        } else {
            process.env[entry.key] = entry.value;
        }
    }
    environmentBackup = null;
}

function isWithinOverlayModuleRoot(filename: string, rootPath: string): boolean {
    const normalizedFilename = path.resolve(filename).toLowerCase();
    const normalizedRoot = path.resolve(rootPath).toLowerCase();
    return normalizedFilename === normalizedRoot || normalizedFilename.startsWith(`${normalizedRoot}${path.sep}`);
}

function unloadOverlayModules(rootPath: string | null): void {
    if (!rootPath) {
        return;
    }
    for (const filename of Object.keys(overlayRequire.cache)) {
        if (isWithinOverlayModuleRoot(filename, rootPath)) {
            delete overlayRequire.cache[filename];
        }
    }
}

function clearOverlayHost(): void {
    const globals = globalThis as typeof globalThis & { [OVERLAY_HOST_SYMBOL]?: OverlayHost };
    delete globals[OVERLAY_HOST_SYMBOL];
}

function installOverlayHost(): void {
    const globals = globalThis as typeof globalThis & { [OVERLAY_HOST_SYMBOL]?: OverlayHost };
    globals[OVERLAY_HOST_SYMBOL] = {
        requestStop: () => {
            stopInProcessOverlay();
        },
    };
}

function validateOverlayModule(candidate: unknown): OverlayModule {
    const runtime = candidate as Partial<OverlayModule> | null;
    if (!runtime || typeof runtime.startOverlayApp !== 'function' || typeof runtime.stopOverlayApp !== 'function') {
        throw new Error('Overlay module does not expose startOverlayApp() and stopOverlayApp().');
    }
    return runtime as OverlayModule;
}

export function isInProcessOverlayRunning(): boolean {
    if (!overlayModule) {
        return false;
    }
    return overlayModule.isOverlayRunning?.() ?? true;
}

export async function startInProcessOverlay(): Promise<boolean> {
    if (overlayStopPromise) {
        await overlayStopPromise;
    }
    if (isInProcessOverlayRunning()) {
        return true;
    }
    if (overlayStartPromise) {
        return overlayStartPromise;
    }

    overlayStartPromise = (async () => {
        const resolved = resolveOverlayModule();
        if (!fs.existsSync(resolved.entryPath)) {
            console.error('Overlay module not found at:', resolved.entryPath);
            return false;
        }

        overlayModuleRoot = resolved.rootPath;
        installOverlayEnvironment();
        installOverlayHost();

        try {
            overlayModule = validateOverlayModule(overlayRequire(resolved.entryPath));
            await overlayModule.startOverlayApp();
            console.log('Overlay loaded successfully in the main Electron process.');
            return true;
        } catch (error) {
            console.error('Failed to load overlay in the main Electron process:', error);
            const failedModule = overlayModule;
            overlayModule = null;
            try {
                await failedModule?.stopOverlayApp();
            } catch (cleanupError) {
                console.error('Failed to clean up partially loaded overlay:', cleanupError);
            }
            unloadOverlayModules(overlayModuleRoot);
            overlayModuleRoot = null;
            clearOverlayHost();
            restoreOverlayEnvironment();
            return false;
        }
    })().finally(() => {
        overlayStartPromise = null;
    });

    return overlayStartPromise;
}

export function stopInProcessOverlay(): boolean {
    if (!overlayModule && !overlayStartPromise) {
        return false;
    }
    if (overlayStopPromise) {
        return true;
    }

    const runtime = overlayModule;
    overlayModule = null;
    overlayStopPromise = Promise.resolve(overlayStartPromise)
        .catch(() => false)
        .then(async () => {
            const loadedRuntime = runtime ?? overlayModule;
            overlayModule = null;
            await loadedRuntime?.stopOverlayApp();
        })
        .catch((error) => {
            console.error('Failed to unload overlay from the main Electron process:', error);
        })
        .finally(() => {
            unloadOverlayModules(overlayModuleRoot);
            overlayModuleRoot = null;
            clearOverlayHost();
            restoreOverlayEnvironment();
            overlayStopPromise = null;
            console.log('Overlay unloaded from the main Electron process.');
        });
    return true;
}

export async function waitForInProcessOverlayShutdown(): Promise<void> {
    await overlayStopPromise;
}
