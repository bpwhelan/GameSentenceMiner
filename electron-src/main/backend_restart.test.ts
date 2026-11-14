import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendProcessError } from './services/managed_python_repair.js';

function child() {
    const proc = Object.assign(new EventEmitter(), {
        pid: 12564,
        exitCode: null as number | null,
        signalCode: null as string | null,
        killed: false,
        beforeInitialization: true,
        stop: vi.fn(async () => { exit(proc); }),
        kill: vi.fn(() => true),
    });
    return proc;
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
        BackendProcessError,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        setTimeout, clearTimeout,
        markStartup: vi.fn(),
        pyProc: proc,
        pythonPath: 'python.exe',
        restartingGSM: false,
        isQuitting: false,
        cleanupComplete: false,
        gsmStopPromise: null,
        intentionalBackendStops: new WeakSet(),
        bus: { isConnected: vi.fn(() => true) },
        sendBackendCommand: vi.fn(),
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
        NativePythonProcess: vi.fn(function () { return proc; }),
        sendGSMCrashNotification: vi.fn(),
        writeManagedGSMProcessState: vi.fn(),
        resetStartupTrayState: vi.fn(),
        setTextIntakePausedState: vi.fn(),
        startBackendStatusPolling: vi.fn(),
        attachBackendLogForwarding: vi.fn(),
        backendExitRequestedFromPython: false,
        backendInitialized: false,
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
    it('asks the native owner to perform the whole restart', async () => {
        const { context, proc, launch } = loadLifecycle();
        await context.restartGSM();
        expect(proc.stop).not.toHaveBeenCalled();
        expect(launch).toHaveBeenCalledWith('python.exe', 1, expect.objectContaining({ restart: true }));
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

    it('treats a native exit as proof that workers have already been reaped', async () => {
        const { context, proc } = loadLifecycle(); exit(proc); await context.closeGSM();
        expect(proc.stop).not.toHaveBeenCalled();
    });
});

describe('backend process lifetime', () => {
    it.each([false, true])('preserves initialization state on failure before resetting it (initialized=%s)', async (initialized) => {
        const { context, proc } = loadLifecycle();
        context.resetStartupTrayState.mockImplementation(() => { context.backendInitialized = false; });
        const run = context.runGSM('python.exe', []);
        context.backendInitialized = initialized;
        proc.beforeInitialization = !initialized;
        proc.exitCode = 1;
        proc.emit('exit', 1);
        await expect(run).rejects.toMatchObject({ beforeInitialization: !initialized });
    });

    it('passes backend launch configuration to the native supervisor', async () => {
        const { context, proc } = loadLifecycle();
        context.isWindows = () => false;
        const run = context.runGSM('python', []);
        expect(context.NativePythonProcess).toHaveBeenCalledWith(expect.objectContaining({ pythonPath: 'python', restart: false }));
        exit(proc);
        await run;
    });

    it('does not spawn or restart a backend once app shutdown has started', async () => {
        const { context, launch } = loadLifecycle();
        context.isQuitting = true;
        await context.runGSM('python', []);
        await context.restartGSM();
        expect(context.NativePythonProcess).not.toHaveBeenCalled();
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
