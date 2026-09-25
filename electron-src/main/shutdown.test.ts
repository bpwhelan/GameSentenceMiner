import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function loadShutdown() {
    const source = fs.readFileSync(path.resolve('electron-src/main/main.ts'), 'utf8');
    const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
    const names = new Set(['closeAllPythonProcesses', 'runQuit', 'quit']);
    const functions = parsed.statements
        .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
        .map((node) => node.getText(parsed));
    const handlers: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'app.on' &&
            node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
            ['before-quit', 'will-quit', 'window-all-closed'].includes(node.arguments[0].text)) {
            handlers.push(node.getText(parsed));
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);

    const app = Object.assign(new EventEmitter(), { quit: vi.fn(), relaunch: vi.fn() });
    const context = vm.createContext({
        app, process: { platform: 'linux' },
        exports: {},
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        pyProc: undefined,
        isQuitting: false,
        quitCleanupComplete: false,
        quitPromise: null,
        agentControl: { dispose: vi.fn(), fail: vi.fn() },
        autoLauncher: { stopPolling: vi.fn() },
        shutdownWindowSceneSwitcher: vi.fn(),
        hideUserFacingShutdownSurfaces: vi.fn(() => { context.isQuitting = true; }),
        closeGSM: vi.fn(async () => {}),
        stopOverlay: vi.fn(),
        waitForOverlayShutdown: vi.fn(async () => {}),
        stopScripts: vi.fn(async () => {}),
        stopOCR: vi.fn(() => true),
        stopManagedProcesses: vi.fn(async () => {}),
        stopWindowTransparencyTool: vi.fn(async () => {}),
        stopInputServer: vi.fn(async () => {}),
        closeOBSFromElectron: vi.fn(async () => {}),
        stopBus: vi.fn(async () => {}),
        require: () => ({ shutdownTextHook: vi.fn() }),
    });
    vm.runInContext(ts.transpile([...functions, ...handlers].join('\n'), {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    }), context);
    context.quit = context.exports.quit;
    return { context, app };
}

describe('application shutdown', () => {
    it('relaunches only after all app-owned processes and the bus have stopped', async () => {
        const { context, app } = loadShutdown();
        const stopping = deferred();
        context.stopManagedProcesses.mockReturnValue(stopping.promise);
        const result = context.quit(['.', '--gsm-agent-restarted=test-request']);
        await vi.waitFor(() => expect(context.stopManagedProcesses).toHaveBeenCalledOnce());
        expect(app.relaunch).not.toHaveBeenCalled();
        expect(app.quit).not.toHaveBeenCalled();
        stopping.resolve();
        await result;
        expect(context.stopBus.mock.invocationCallOrder[0]).toBeLessThan(app.relaunch.mock.invocationCallOrder[0]);
        expect(app.relaunch).toHaveBeenCalledExactlyOnceWith({ args: ['.', '--gsm-agent-restarted=test-request'] });
        expect(app.quit).toHaveBeenCalledOnce();
    });

    it('refuses to relaunch if cleanup fails and reports the failure to the waiting agent', async () => {
        const { context, app } = loadShutdown();
        context.stopManagedProcesses.mockRejectedValue(new Error('Worker did not exit'));
        await context.quit(['.', '--gsm-agent-restarted=test-request']);
        expect(app.relaunch).not.toHaveBeenCalled();
        expect(context.agentControl.fail).toHaveBeenCalledOnce();
        expect(context.stopInputServer).toHaveBeenCalledOnce();
        expect(context.stopBus).toHaveBeenCalledOnce();
        expect(app.quit).toHaveBeenCalledOnce();
    });

    it('defers a direct Electron quit and coalesces requests until child cleanup finishes', async () => {
        const { context, app } = loadShutdown();
        const stopping = deferred();
        context.stopManagedProcesses.mockReturnValue(stopping.promise);
        const event = { preventDefault: vi.fn() };

        app.emit('before-quit', event);
        app.emit('before-quit', event);
        await vi.waitFor(() => expect(context.stopManagedProcesses).toHaveBeenCalledOnce());
        expect(event.preventDefault).toHaveBeenCalledTimes(2);
        expect(app.quit).not.toHaveBeenCalled();
        expect(context.stopBus).not.toHaveBeenCalled();

        stopping.resolve();
        await context.quitPromise;
        expect(app.quit).toHaveBeenCalledOnce();
        expect(context.stopBus).toHaveBeenCalledOnce();

        event.preventDefault.mockClear();
        app.emit('before-quit', event);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it.each([undefined, { killed: true }])('stops OCR and helpers without a live backend (%s)', async (pyProc) => {
        const { context, app } = loadShutdown();
        context.pyProc = pyProc;
        await context.quit();

        expect(context.stopManagedProcesses).toHaveBeenCalledOnce();
        expect(context.stopOCR).toHaveBeenCalledOnce();
        expect(context.stopWindowTransparencyTool).toHaveBeenCalledOnce();
        expect(context.stopInputServer).toHaveBeenCalledOnce();
        expect(app.quit).toHaveBeenCalledOnce();
    });

    it('attempts every cleanup even when one process fails to stop', async () => {
        const { context, app } = loadShutdown();
        context.pyProc = { killed: false };
        context.closeGSM.mockRejectedValue(new Error('backend stop failed'));
        await context.quit();

        expect(context.stopManagedProcesses).toHaveBeenCalledOnce();
        expect(context.stopInputServer).toHaveBeenCalledOnce();
        expect(context.closeOBSFromElectron).toHaveBeenCalledOnce();
        expect(context.stopBus).toHaveBeenCalledOnce();
        expect(app.quit).toHaveBeenCalledOnce();
    });
});
