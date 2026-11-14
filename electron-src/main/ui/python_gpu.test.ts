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
    const snippets=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&['runPythonMaintenance','registerPythonIPC'].includes(node.name.text)).map(node=>node.getText(parsed).replace(/^export /,''));
    const context = vm.createContext({
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<any>) => handlers.set(name, handler) },
        ...dependencies,
    });
    vm.runInContext(ts.transpile(snippets.join(';')+';registerPythonIPC();', { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context);
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
    it.each(['python.resetDependencies','python.repairGSM'])('returns on spawn while %s keeps its backend running',async channel=>{
        const operations:string[]=[];
        const native=vi.fn(async()=>{operations.push('native');return {pythonPath:'repaired-python'};});
        const launch=vi.fn((_python,_retry,options)=>{operations.push('launch');options.onSpawn();return new Promise<void>(()=>{});});
        const handler=registerHandler(channel,{
            closeAllPythonProcesses:async()=>{operations.push('stop');},getPythonExtras:()=>['gpu'],pythonCall:native,
            startManualInstallSession:vi.fn(),installSessionManager:{finishActive:vi.fn()},
            require:()=>({ensureAndRunGSM:launch}),
        });
        expect(await handler()).toMatchObject({success:true});
        expect(operations).toEqual(['stop','native','launch']);
        const mode=channel==='python.repairGSM'?'repair':'reset_dependencies';
        expect(native).toHaveBeenCalledExactlyOnceWith('maintain',{mode,extras:['gpu']});
        expect(launch).toHaveBeenCalledWith('repaired-python',1,expect.objectContaining({origin:mode,onSpawn:expect.any(Function)}));
    },1000);
    it.each(['stop','native','launch'])('reports %s errors without continuing maintenance',async failure=>{
        const native=vi.fn(async()=>{if(failure==='native')throw Error('Native failure');return {pythonPath:'python'};});
        const launch=vi.fn(async()=>{throw Error('Launch failure');});
        const finish=vi.fn();
        const handler=registerHandler('python.repairGSM',{
            closeAllPythonProcesses:async()=>{if(failure==='stop')throw Error('Stop failure');},getPythonExtras:()=>[],pythonCall:native,
            startManualInstallSession:vi.fn(),installSessionManager:{finishActive:finish},
            require:()=>({ensureAndRunGSM:launch}),
        });
        expect(await handler()).toMatchObject({success:false,message:expect.stringContaining('failure')});
        expect(finish).toHaveBeenCalledWith('failed','Python maintenance failed.',expect.any(String));
        if(failure==='stop')expect(native).not.toHaveBeenCalled();
        if(failure!=='launch')expect(launch).not.toHaveBeenCalled();
    });
});
