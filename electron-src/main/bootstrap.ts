import electron from 'electron';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const { app, dialog } = electron;
const OVERLAY_CHILD_ARG = '--gsm-overlay-child';
const OVERLAY_RESOURCES_ARG = '--gsm-overlay-resources';
const OVERLAY_RESOURCES_ENV = 'GSM_OVERLAY_RESOURCES_PATH';

function traceOverlayBootstrap(message: string): void {
    const tracePath = process.env.GSM_OVERLAY_BOOTSTRAP_TRACE;
    if (!tracePath) {
        return;
    }
    try {
        fs.appendFileSync(tracePath, `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch {
        // Tracing is best-effort only.
    }
}

function getArgValue(name: string): string | null {
    const equalsPrefix = `${name}=`;
    for (let index = 0; index < process.argv.length; index += 1) {
        const arg = process.argv[index];
        if (arg.startsWith(equalsPrefix)) {
            return arg.slice(equalsPrefix.length);
        }
        if (arg === name) {
            const next = process.argv[index + 1];
            if (next && !next.startsWith('--')) {
                return next;
            }
        }
    }
    return null;
}

function getOverlayPlatformDirName(): string {
    const arch = process.arch === 'x64' || process.arch === 'arm64'
        ? process.arch
        : process.arch;
    return `gsm_overlay-${process.platform}-${arch}`;
}

function isOverlayChildProcess(): boolean {
    return process.env.GSM_OVERLAY_CHILD === '1' || process.argv.includes(OVERLAY_CHILD_ARG);
}

function resolveOverlayResourcesPath(): string {
    const argPath = getArgValue(OVERLAY_RESOURCES_ARG);
    if (argPath) {
        return path.resolve(argPath);
    }

    const envPath = process.env[OVERLAY_RESOURCES_ENV];
    if (envPath) {
        return path.resolve(envPath);
    }

    return path.join(process.resourcesPath, 'GSM_Overlay', getOverlayPlatformDirName(), 'resources');
}

function failOverlayBootstrap(message: string, error?: unknown): never {
    const detail = error instanceof Error ? `${message}\n\n${error.stack ?? error.message}` : message;
    console.error(detail);
    try {
        dialog.showErrorBox('GSM Overlay Startup Failed', detail);
    } catch {
        // If Electron is not ready for dialogs, the console error still preserves the failure.
    }
    app.exit(1);
    throw new Error(detail);
}

if (isOverlayChildProcess()) {
    traceOverlayBootstrap('child mode detected');
    const overlayResourcesPath = resolveOverlayResourcesPath();
    const overlayAppAsarPath = path.join(overlayResourcesPath, 'app.asar');

    process.env[OVERLAY_RESOURCES_ENV] = overlayResourcesPath;
    process.env.GSM_OVERLAY_SHARED_RUNTIME = '1';
    traceOverlayBootstrap(`overlay resources: ${overlayResourcesPath}`);

    if (!fs.existsSync(overlayAppAsarPath)) {
        failOverlayBootstrap(`Overlay app bundle not found at ${overlayAppAsarPath}`);
    }

    try {
        traceOverlayBootstrap(`requiring ${path.join(overlayAppAsarPath, 'main.js')}`);
        createRequire(import.meta.url)(path.join(overlayAppAsarPath, 'main.js'));
        traceOverlayBootstrap('overlay require returned');
    } catch (error) {
        failOverlayBootstrap(`Failed to boot overlay app from ${overlayAppAsarPath}`, error);
    }
} else {
    traceOverlayBootstrap('main app mode detected');
    void import('./main.js');
}
