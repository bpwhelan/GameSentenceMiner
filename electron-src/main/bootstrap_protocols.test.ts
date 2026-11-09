import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function bootstrapHarness(inProcessOverlay: boolean) {
    let ready = false;
    let finishRuntime!: (executable: string) => void;
    const runtimeReady = new Promise<string>((resolve) => { finishRuntime = resolve; });
    const ensureDevElectron = vi.fn(() => runtimeReady);
    const importedMain = vi.fn();
    const configureDataPaths = vi.fn();
    const startupError = vi.fn();
    const registerSchemesAsPrivileged = vi.fn((_schemes: Array<{ scheme: string }>) => {
        if (ready) throw new Error('protocol registration happened after ready');
    });
    const electron = {
        app: {
            isPackaged: false,
            getAppPath: () => 'C:\\GSM',
            getVersion: () => '1.0.0',
            on: vi.fn(), exit: vi.fn(), relaunch: vi.fn(),
        },
        dialog: { showErrorBox: startupError },
        protocol: { registerSchemesAsPrivileged },
    };
    const load = (file: string) => {
        const source = fs.readFileSync(path.resolve('electron-src/main', file), 'utf8')
            .replaceAll('import.meta.url', JSON.stringify('file:///C:/GSM/dist/main/bootstrap.js'));
        const output = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText;
        const exports = {};
        vm.runInNewContext(output, {
            exports, require: requireMock,
            process: { platform: 'win32', arch: 'x64', execPath: 'C:\\runtime\\electron.exe', argv: ['electron.exe', '.'], env: {} },
            console: { error: vi.fn() },
        }, { filename: file });
        return exports;
    };
    const requireMock = (specifier: string): unknown => {
        switch (specifier) {
            case 'electron': return electron;
            case 'node:fs': return fs;
            case 'node:path': return path;
            case 'node:url': return { pathToFileURL: vi.fn() };
            case 'node:module': return { createRequire: () => () => ({ ensureDevElectron }) };
            case './services/startup_timing.js': return { markStartup: vi.fn() };
            case './linux_desktop_identity.js': return { configureLinuxDesktopIdentity: vi.fn() };
            case './overlay_runtime_config.js': return { USE_IN_PROCESS_OVERLAY: inProcessOverlay };
            case './data_dir.js': return { getBaseDir: () => 'C:\\GSM-data' };
            case './profile_bootstrap.js': return { configureDataPaths };
            case './services/logging.js': return { captureRendererDiagnostics: vi.fn(), initializeDesktopLogging: vi.fn() };
            case './services/changelog_protocol.js': return load('services/changelog_protocol.ts');
            case './main.js': importedMain(); return {};
            default: throw new Error(`Unexpected bootstrap import: ${specifier}`);
        }
    };
    load('bootstrap.ts');
    return {
        ensureDevElectron, importedMain, startupError, registerSchemesAsPrivileged, configureDataPaths,
        finishRuntime: () => { ready = true; finishRuntime('C:\\runtime\\electron.exe'); },
    };
}

describe('bootstrap protocol registration', () => {
    it.each([false, true])('registers desktop schemes before delayed dev preparation (in-process overlay: %s)', async (inProcessOverlay) => {
        const harness = bootstrapHarness(inProcessOverlay);
        expect(harness.ensureDevElectron).toHaveBeenCalledOnce();
        expect(harness.configureDataPaths).toHaveBeenCalledOnce();
        expect(harness.configureDataPaths.mock.invocationCallOrder[0])
            .toBeLessThan(harness.ensureDevElectron.mock.invocationCallOrder[0]);
        expect(harness.registerSchemesAsPrivileged).toHaveBeenCalledOnce();
        const schemes = harness.registerSchemesAsPrivileged.mock.calls[0][0];
        expect(schemes).toContainEqual({
            scheme: 'gsm-changelog',
            privileges: { standard: true, secure: true, supportFetchAPI: true },
        });
        expect(schemes.map((entry: { scheme: string }) => entry.scheme)).toEqual(
            inProcessOverlay ? ['gsm-changelog', 'chrome-extension'] : ['gsm-changelog'],
        );
        harness.finishRuntime();
        await vi.waitFor(() => expect(harness.importedMain).toHaveBeenCalledOnce());
        expect(harness.startupError).not.toHaveBeenCalled();
        expect(harness.registerSchemesAsPrivileged).toHaveBeenCalledOnce();
    });
});
