import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

function child() {
    return Object.assign(new EventEmitter(), {
        pid: 12564,
        exitCode: null as number | null,
        signalCode: null as string | null,
        killed: false,
        kill: vi.fn(() => true),
    });
}

function loadLifecycle() {
    const source = fs.readFileSync(path.resolve('electron-src/main/main.ts'), 'utf8');
    const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
    const names = new Set([
        'hasChildProcessExited', 'isChildProcessActive', 'waitForChildProcessExit',
        'closeGSM', 'waitForBackendCleanup', 'restartGSM', 'stopGSMProcess',
        'forceTerminateGSMProcess', 'runGSM',
    ]);
    const functions = parsed.statements
        .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
        .map((node) => node.getText(parsed)).join('\n');
    const proc = child();
    const launch = vi.fn(async (_python: string, _retry?: number, options?: { onSpawn?: () => void }) => {
        options?.onSpawn?.();
    });
    const context = vm.createContext({
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        setTimeout, clearTimeout,
        pyProc: proc,
        pythonPath: 'python.exe',
        restartingGSM: false,
        isQuitting: false,
        cleanupComplete: false,
        gsmStopPromise: null,
        intentionalBackendStops: new WeakSet(),
        bus: { isConnected: vi.fn(() => true) },
        sendBackendCommand: vi.fn(),
        stopScripts: vi.fn(async () => {}),
        clearManagedGSMProcessState: vi.fn(),
        ensureAndRunGSM: launch,
        execFileAsync: vi.fn(async () => {}),
        terminateProcessTree: vi.fn(async (target: ReturnType<typeof child>) => {
            if (target.exitCode === null && target.signalCode === null) {
                exit(target);
            }
        }),
        isWindows: () => true,
        installSessionManager: { getActiveSnapshot: () => null },
        getWindowsNamedPythonExecutable: (command: string) => command,
        getSanitizedPythonEnv: () => ({}),
        getBusConnectInfo: () => null,
        getResourcesDir: () => 'resources',
        APP_NAME: 'GameSentenceMiner',
        BASE_DIR: 'test-data',
        path,
        spawn: vi.fn(() => proc),
        writeManagedGSMProcessState: vi.fn(),
        resetStartupTrayState: vi.fn(),
        setTextIntakePausedState: vi.fn(),
        startBackendStatusPolling: vi.fn(),
        attachBackendLogForwarding: vi.fn(),
        backendExitRequestedFromPython: false,
        updateManager: { anyUpdateInProgress: false },
        formatBackendExitCode: String,
    });
    vm.runInContext(ts.transpile(functions, { target: ts.ScriptTarget.ES2022 }), context);
    return { context, proc, launch };
}

function exit(proc: ReturnType<typeof child>) {
    proc.exitCode = 0;
    proc.emit('exit', 0);
    proc.emit('close', 0);
}

afterEach(() => vi.useRealTimers());

describe('Python backend restart', () => {
    it('stops the process tree even after cleanup_complete, then waits before launching', async () => {
        vi.useFakeTimers();
        const { context, proc, launch } = loadLifecycle();
        context.sendBackendCommand.mockImplementation(() => { context.cleanupComplete = true; });

        const restart = context.restartGSM();
        await vi.advanceTimersByTimeAsync(20_000);
        await restart;

        expect(context.terminateProcessTree).toHaveBeenCalledWith(proc);
        expect(proc.kill).not.toHaveBeenCalled();
        expect(launch).toHaveBeenCalledOnce();
        expect(proc.exitCode).toBe(0);
    });

    it('does not launch a replacement when the old process survives termination', async () => {
        vi.useFakeTimers();
        const { context, launch } = loadLifecycle();
        context.sendBackendCommand.mockImplementation(() => { context.cleanupComplete = true; });
        context.terminateProcessTree.mockRejectedValue(new Error('Access denied'));

        const restart = context.restartGSM().catch(() => {});
        await vi.advanceTimersByTimeAsync(20_000);
        await restart;

        expect(launch).not.toHaveBeenCalled();
        expect(context.restartingGSM).toBe(false);
    });

    it('finishes a graceful restart on process exit without waiting for a cleanup acknowledgement', async () => {
        vi.useFakeTimers();
        const { context, proc, launch } = loadLifecycle();
        const restart = context.restartGSM();
        await vi.advanceTimersByTimeAsync(0);
        exit(proc);
        await vi.advanceTimersByTimeAsync(0);

        expect(launch).toHaveBeenCalledOnce();
        expect(context.execFileAsync).not.toHaveBeenCalled();
        expect(proc.kill).not.toHaveBeenCalled();
        await restart;
    });

    it('coalesces restart requests while preparing a launch with no running backend', async () => {
        const { context, proc, launch } = loadLifecycle();
        exit(proc);
        let finishLaunch!: () => void;
        launch.mockImplementation((_python, _retry, options) => new Promise<void>((resolve) => {
            finishLaunch = () => { options?.onSpawn?.(); resolve(); };
        }));

        const first = context.restartGSM();
        await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
        const duplicate = context.restartGSM();
        expect(launch).toHaveBeenCalledOnce();
        finishLaunch();
        await Promise.all([first, duplicate]);
        expect(context.restartingGSM).toBe(false);
    });

    it('allows a later restart once the replacement has spawned', async () => {
        vi.useFakeTimers();
        const { context, proc, launch } = loadLifecycle();
        context.sendBackendCommand.mockImplementation(() => { exit(proc); });
        launch.mockImplementation(async (_python, _retry, options) => {
            proc.exitCode = null;
            options?.onSpawn?.();
            // The backend lifetime continues after spawning.
            await new Promise<void>(() => {});
        });

        await context.restartGSM();
        await context.restartGSM();

        expect(launch).toHaveBeenCalledTimes(2);
        expect(context.restartingGSM).toBe(false);
    });

    it('releases the restart guard after launch failure so a retry is possible', async () => {
        const { context, proc, launch } = loadLifecycle();
        exit(proc);
        launch.mockRejectedValueOnce(new Error('spawn failed'));

        await context.restartGSM();
        expect(context.restartingGSM).toBe(false);
        await context.restartGSM();
        expect(launch).toHaveBeenCalledTimes(2);
    });

    it('waits for worker cleanup even after the backend itself has exited', async () => {
        const { context, proc } = loadLifecycle();
        exit(proc);
        let finish!: () => void;
        context.terminateProcessTree.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
        const settled = vi.fn();
        const stop = context.closeGSM().then(settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        expect(context.clearManagedGSMProcessState).not.toHaveBeenCalled();
        finish();
        await stop;
        expect(settled).toHaveBeenCalledOnce();
    });
});

describe('backend process lifetime', () => {
    it('isolates the Linux backend and its workers in an owned process group', async () => {
        const { context, proc } = loadLifecycle();
        context.isWindows = () => false;
        const run = context.runGSM('python', []);
        expect(context.spawn).toHaveBeenCalledWith('python', [], expect.objectContaining({ detached: true }));
        exit(proc);
        await run;
    });

    it('does not spawn or restart a backend once app shutdown has started', async () => {
        const { context, launch } = loadLifecycle();
        context.isQuitting = true;
        await context.runGSM('python', []);
        await context.restartGSM();
        expect(context.spawn).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
    });

    it('settles an intentional stop without resetting the restart guard', async () => {
        const { context, proc } = loadLifecycle();
        const spawned = vi.fn();
        const run = context.runGSM('python.exe', [], spawned);
        const settled = vi.fn();
        run.then(settled);
        proc.emit('spawn');
        expect(spawned).toHaveBeenCalledOnce();
        expect(settled).not.toHaveBeenCalled();

        context.restartingGSM = true;
        context.intentionalBackendStops.add(proc);
        exit(proc);
        await run;

        expect(settled).toHaveBeenCalledOnce();
        expect(context.restartingGSM).toBe(true);
    });

    it('ignores stale close events when clearing the replacement process state', async () => {
        const { context, proc } = loadLifecycle();
        const run = context.runGSM('python.exe', []);
        const replacement = child();
        context.pyProc = replacement;
        context.resetStartupTrayState.mockClear();
        context.setTextIntakePausedState.mockClear();

        exit(proc);
        await run;

        expect(context.clearManagedGSMProcessState).not.toHaveBeenCalled();
        expect(context.resetStartupTrayState).not.toHaveBeenCalled();
        expect(context.setTextIntakePausedState).not.toHaveBeenCalled();
    });
});
