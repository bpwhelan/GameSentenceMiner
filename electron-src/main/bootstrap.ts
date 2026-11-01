import { markStartup } from './services/startup_timing.js';
import electron from 'electron';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { configureLinuxDesktopIdentity } from './linux_desktop_identity.js';
import { USE_IN_PROCESS_OVERLAY } from './overlay_runtime_config.js';
import { getBaseDir } from './data_dir.js';
import { captureRendererDiagnostics, initializeDesktopLogging } from './services/logging.js';
import { CHANGELOG_PROTOCOL_SCHEME } from './services/changelog_protocol.js';

const { app, dialog } = electron;
const OVERLAY_CHILD_ARG = '--gsm-overlay-child';
const OVERLAY_RESOURCES_ARG = '--gsm-overlay-resources';
const OVERLAY_RESOURCES_ENV = 'GSM_OVERLAY_RESOURCES_PATH';
const AGENT_HOST_ARG = '--gsm-agent-host';

// Portals identify an unpackaged Linux process by its installed .desktop file.
// Resolve that identity before Electron is ready and pass the matching app ID to
// the shared input service that owns the Wayland shortcut session.
configureLinuxDesktopIdentity(app);

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
    return `gsm_overlay-${process.platform}-${process.arch}`;
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

if (!isOverlayChildProcess() && !process.argv.includes(AGENT_HOST_ARG)) {
    // Register every desktop scheme together before asynchronous preparation can
    // let Electron become ready. main.ts may be imported after that point.
    electron.protocol.registerSchemesAsPrivileged([
        CHANGELOG_PROTOCOL_SCHEME,
        ...(USE_IN_PROCESS_OVERLAY ? [{
            scheme: 'chrome-extension',
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                corsEnabled: true,
                bypassCSP: true,
            },
        }] : []),
    ]);
}

if (process.argv.includes(AGENT_HOST_ARG)) {
    app.setPath('userData', path.join(app.getPath('userData'), 'agent-host'));
    void import('./ui/agent_host.js')
        .then(({ runDetachedAgentHost }) => runDetachedAgentHost())
        .catch((error) => {
            console.error('Detached Agent host failed:', error);
            app.exit(1);
        });
} else if (isOverlayChildProcess()) {
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
    void startMainApp().catch((error) => {
        console.error('GSM startup failed:', error);
        dialog.showErrorBox('GSM Startup Failed', error instanceof Error ? error.message : String(error));
        app.exit(1);
    });
}

async function startMainApp(): Promise<void> {
    // Also cover direct `electron .` launches and restarts from an older dev
    // instance. Switch before taking the single-instance lock or starting helpers.
    if (process.platform === 'win32' && !app.isPackaged) {
        const { ensureDevElectron } = createRequire(import.meta.url)(
            path.join(app.getAppPath(), 'scripts', 'electron-dev-runtime.cjs'),
        ) as { ensureDevElectron: () => Promise<string> };
        const executable = await ensureDevElectron();
        if (path.resolve(process.execPath).toLowerCase() !== path.resolve(executable).toLowerCase()) {
            app.relaunch({ execPath: executable, args: process.argv.slice(1) });
            app.exit(0);
            return;
        }
    }
    initializeDesktopLogging(getBaseDir(), {
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
    });
    markStartup('desktop bootstrap');
    app.on('web-contents-created', (_event, contents) => captureRendererDiagnostics(contents));
    traceOverlayBootstrap('main app mode detected');
    await import('./main.js');
}
