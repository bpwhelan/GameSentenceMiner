import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { changeGpuRuntime } from '../services/gpu_install.js';
import { GPU_INSTALL_PROGRESS_CHANNEL } from '../../shared/gpu.js';

function registerHandler(channel: string, dependencies: Record<string, unknown>) {
    // Exercise the real handler without importing Electron's app bootstrap.
    const source = fs.readFileSync(path.resolve('electron-src/main/ui/python.ts'), 'utf8');
    const parsed = ts.createSourceFile('python.ts', source, ts.ScriptTarget.Latest, true);
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const snippets: string[] = [];
    function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'ipcMain.handle'
            && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) snippets.push(node.getText(parsed));
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    const context = vm.createContext({
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<any>) => handlers.set(name, handler) },
        ...dependencies,
    });
    vm.runInContext(ts.transpile(snippets.join(';'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context);
    return handlers.get(channel)!;
}

describe('GPU package IPC completion', () => {
    it.each([
        { channel: 'python.installCudaPackage', options: {}, extras: ['lens', 'gpu'] },
        { channel: 'python.installCudaPackage', options: { bundledLibraries: true }, extras: ['lens', 'gpu', 'gpu-libs'] },
        { channel: 'python.uninstallCudaPackage', options: {}, extras: ['lens'] },
    ])('finishes $channel after reconnection while GSM stays running', async ({ channel, options, extras }) => {
        const events = new EventEmitter();
        let connected = false;
        const launch = vi.fn((_python, _retry, opts) => {
            opts.onSpawn();
            connected = true;
            events.emit('client-connected', 'backend');
            return new Promise<void>(() => {});
        });
        const sync = vi.fn(async () => {});
        const saveExtras = vi.fn();
        const handler = registerHandler(channel, {
            FeatureFlags: { DISABLE_GPU_INSTALLS: false },
            getOrInstallPython: async () => 'managed-python',
            closeAllPythonProcesses: async () => {},
            getPythonExtras: () => ['lens', 'gpu'],
            resolveRequestedExtras: (requested: string[]) => ({ selectedExtras: [...new Set(requested)], ignoredExtras: [], allowedExtras: ['lens', 'gpu', 'gpu-libs'] }),
            setPythonExtras: saveExtras,
            checkAndInstallUV: async () => {},
            syncLockedEnvironment: sync,
            changeGpuRuntime,
            GPU_INSTALL_PROGRESS_CHANNEL,
            bus: {
                isConnected: () => connected,
                on: (event: string, callback: (...args: any[]) => void) => {
                    events.on(event, callback);
                    return () => events.off(event, callback);
                },
            },
            require: () => ({ ensureAndRunGSM: launch }),
        });
        const send = vi.fn();
        const result = await handler({ sender: { isDestroyed: () => false, send } }, options);
        expect(result.success).toBe(true);
        expect(launch).toHaveBeenCalledOnce();
        expect(sync).toHaveBeenCalledWith('managed-python', extras, false);
        expect(saveExtras).toHaveBeenCalledWith(extras);
        expect(send.mock.calls.map((call) => call[1].phase)).toEqual(['stopping', 'installing', 'starting']);
    }, 2000);
});

describe('Python dependency recovery IPC completion', () => {
    it.each([false, true])('finishes on launch or reports a launch error (failure: %s)', async (failLaunch) => {
        const launch = vi.fn((_python, _retry, options) => {
            if (failLaunch) return Promise.reject(new Error('Launch failed'));
            options.onSpawn?.();
            return new Promise<void>(() => {});
        });
        const sync = vi.fn(async () => {});
        const finishSession = vi.fn();
        const handler = registerHandler('python.resetDependencies', {
            setTimeout: (callback: () => void) => { callback(); return 0; },
            getOrInstallPython: async () => 'managed-python',
            closeAllPythonProcesses: async () => {},
            pyProc: null,
            getPythonExtras: () => ['gpu'],
            resolveRequestedExtras: (extras: string[]) => ({ selectedExtras: extras, ignoredExtras: [] }),
            checkAndInstallUV: async () => {},
            syncLockedEnvironment: sync,
            startManualInstallSession: vi.fn(),
            updateInstallStage: vi.fn(),
            installSessionManager: { finishActive: finishSession },
            require: () => ({ ensureAndRunGSM: launch }),
        });
        const result = await handler();
        expect(sync).toHaveBeenCalledWith('managed-python', ['gpu'], false, expect.any(Function));
        expect(result.success).toBe(!failLaunch);
        if (failLaunch) {
            expect(result.message).toContain('Launch failed');
            expect(finishSession).toHaveBeenCalledWith('failed', expect.any(String), 'Launch failed');
        } else {
            expect(launch).toHaveBeenCalledWith('managed-python', 1, expect.objectContaining({ origin: 'reset_dependencies', onSpawn: expect.any(Function) }));
        }
    }, 1000);
});
