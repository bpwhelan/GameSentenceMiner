import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendProcessError } from './services/managed_python_repair.js';
import { runBackendWithCrashRecovery } from './services/backend_recovery.js';

function loadRecovery() {
    const parsed = ts.createSourceFile('main.ts', fs.readFileSync('electron-src/main/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const names = new Set(['ensureAndRunGSM', 'handleBackendStartupFailure']);
    const functions = parsed.statements
        .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
        .map((node) => node.getText(parsed)).join('\n');
    let now = 0;
    const context = vm.createContext({
        Error, BackendProcessError, runBackendWithCrashRecovery,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        Date: { now: () => now },
        setTimeout, clearTimeout,
        isQuitting: false,
        isDev: false,
        APP_NAME: 'GameSentenceMiner',
        restartingGSM: false,
        pyProc: null,
        intentionalBackendStops: new WeakSet(),
        updateManager: { anyUpdateInProgress: false },
        sendGSMCrashNotification: vi.fn(),
        installSessionManager: { getActiveSnapshot: () => null },
        ensureInstallSession: vi.fn(),
        updateInstallStage: vi.fn(),
        finishInstallSession: vi.fn(),
        waitForPythonLaunchReadiness: vi.fn(async () => {}),
        cleanupStaleManagedGSMProcess: vi.fn(async () => {}),
        devFaultInjector: { maybeFail: vi.fn() },
        getInstalledPackageVersion: vi.fn(async () => '2026.10.3'),
        getBundledBackendVersion: () => '2026.10.3',
        resolvePreReleaseBranch: () => null,
        isBackendVersionCompatible: () => true,
        requiresBackendStartupPreparation: () => false,
        getPythonExtras: () => ['gpu'],
        resolveRequestedExtras: () => ({ selectedExtras: ['gpu'], ignoredExtras: [] }),
        getDevPyprojectSyncState: () => ({ changed: false }),
        getProjectPath: () => 'project',
        getVenvDirFromPythonPath: () => 'managed',
        checkAndEnsurePip: vi.fn(async () => {}),
        checkAndInstallUV: vi.fn(async () => {}),
        closeAllPythonProcesses: vi.fn(async () => {}),
        cleanUvCache: vi.fn(async () => {}),
        syncLockedEnvironment: vi.fn(async () => {}),
        getBundledBackendSpecifier: () => 'GameSentenceMiner>=2026.10.3,<2026.10.4',
        installPackageNoDeps: vi.fn(async () => {}),
        getGSMModulePath: () => 'GameSentenceMiner.gsm',
        shouldSimulateStartupFailureOnce: () => false,
        formatConsoleArg: String,
        runGSM: vi.fn(async () => {}),
        updateGSM: vi.fn(async () => {}),
    });
    vm.runInContext(ts.transpile(functions, { target: ts.ScriptTarget.ES2022 }), context);
    return { context, advance: (ms: number) => { now += ms; } };
}

afterEach(() => vi.useRealTimers());

describe('startup recovery', () => {
    it('does no additional dependency work on a successful unchanged launch', async () => {
        const { context } = loadRecovery();
        await context.ensureAndRunGSM('python');
        expect(context.runGSM).toHaveBeenCalledOnce();
        expect(context.checkAndEnsurePip).not.toHaveBeenCalled();
        expect(context.checkAndInstallUV).not.toHaveBeenCalled();
        expect(context.syncLockedEnvironment).not.toHaveBeenCalled();
        expect(context.installPackageNoDeps).not.toHaveBeenCalled();
    });

    it('repairs an initialization failure even after the old 15-second window', async () => {
        const { context, advance } = loadRecovery();
        context.runGSM.mockImplementationOnce(async () => {
            advance(60_000);
            throw new BackendProcessError('idna is damaged', true);
        });
        await context.ensureAndRunGSM('python');
        expect(context.runGSM).toHaveBeenCalledTimes(2);
        expect(context.syncLockedEnvironment).toHaveBeenCalledExactlyOnceWith(
            'python', ['gpu'], false, expect.any(Function), { deferValidation: true, reinstall: true }
        );
        expect(context.installPackageNoDeps).toHaveBeenCalledExactlyOnceWith(
            'python', 'GameSentenceMiner>=2026.10.3,<2026.10.4', true, expect.any(Function), ['gpu']
        );
    });

    it('stops after one repair when initialization still fails', async () => {
        vi.useFakeTimers();
        const { context } = loadRecovery();
        context.runGSM.mockRejectedValue(new BackendProcessError('idna is damaged', true));
        const startup = context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        await vi.runAllTimersAsync();
        await startup;
        expect(context.runGSM).toHaveBeenCalledTimes(2);
        expect(context.syncLockedEnvironment).toHaveBeenCalledOnce();
        expect(context.updateGSM).not.toHaveBeenCalled();
        expect(context.finishInstallSession).toHaveBeenCalledWith('failed', expect.any(String), 'idna is damaged');
    });

    it('does not start a second update/repair when dependency repair itself fails', async () => {
        const { context } = loadRecovery();
        context.runGSM.mockRejectedValue(new BackendProcessError('idna is damaged', true));
        context.syncLockedEnvironment.mockRejectedValue(new Error('download failed'));
        await context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        expect(context.runGSM).toHaveBeenCalledOnce();
        expect(context.syncLockedEnvironment).toHaveBeenCalledOnce();
        expect(context.installPackageNoDeps).not.toHaveBeenCalled();
        expect(context.updateGSM).not.toHaveBeenCalled();
        expect(context.finishInstallSession).toHaveBeenCalledWith('failed', expect.any(String), expect.stringContaining('download failed'));
    });

    it('keeps the existing update fallback for environment preparation failures', async () => {
        const { context } = loadRecovery();
        context.cleanupStaleManagedGSMProcess.mockRejectedValue(new Error('preparation failed'));
        await context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        expect(context.updateGSM).toHaveBeenCalledExactlyOnceWith(true, true);
    });

    it.each([500, 60_000])('notifies and restarts an initialized backend after %i ms without repair', async (runtimeMs) => {
        vi.useFakeTimers();
        const { context, advance } = loadRecovery();
        context.runGSM.mockImplementationOnce(async () => {
            advance(runtimeMs);
            throw new BackendProcessError('runtime error', false);
        });
        context.runGSM.mockImplementationOnce(async () => {
            expect(context.sendGSMCrashNotification).toHaveBeenCalledExactlyOnceWith(true);
        });
        const startup = context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        await vi.runAllTimersAsync();
        await startup;
        expect(context.runGSM).toHaveBeenCalledTimes(2);
        expect(context.syncLockedEnvironment).not.toHaveBeenCalled();
        expect(context.installPackageNoDeps).not.toHaveBeenCalled();
        expect(context.updateGSM).not.toHaveBeenCalled();
        expect(context.finishInstallSession).not.toHaveBeenCalled();
    });

    it('only repairs after a crash restart fails to initialize', async () => {
        vi.useFakeTimers();
        const { context } = loadRecovery();
        context.runGSM
            .mockRejectedValueOnce(new BackendProcessError('Qt crashed', false))
            .mockRejectedValueOnce(new BackendProcessError('cannot initialize', true));
        const startup = context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        await vi.runAllTimersAsync();
        await startup;
        expect(context.runGSM).toHaveBeenCalledTimes(3);
        expect(context.sendGSMCrashNotification).toHaveBeenCalledExactlyOnceWith(true);
        expect(context.syncLockedEnvironment).toHaveBeenCalledOnce();
        expect(context.updateGSM).not.toHaveBeenCalled();
    });

    it('stops a rapid runtime crash loop without reinstalling dependencies', async () => {
        vi.useFakeTimers();
        const { context } = loadRecovery();
        context.runGSM.mockRejectedValue(new BackendProcessError('Qt crashed', false));
        const startup = context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        await vi.runAllTimersAsync();
        await startup;
        expect(context.runGSM).toHaveBeenCalledTimes(4);
        expect(context.sendGSMCrashNotification.mock.calls).toEqual([[true], [true], [true], [false]]);
        expect(context.syncLockedEnvironment).not.toHaveBeenCalled();
        expect(context.updateGSM).not.toHaveBeenCalled();
    });

    it.each(['quit', 'manual restart', 'update', 'replacement backend'])('does not relaunch after %s during the crash restart delay', async (action) => {
        vi.useFakeTimers();
        const { context } = loadRecovery();
        context.runGSM.mockRejectedValueOnce(new BackendProcessError('Qt crashed', false));
        const startup = context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        setTimeout(() => {
            if (action === 'quit') context.isQuitting = true;
            if (action === 'manual restart') context.restartingGSM = true;
            if (action === 'update') context.updateManager.anyUpdateInProgress = true;
            if (action === 'replacement backend') context.pyProc = {};
        }, 200);
        await vi.runAllTimersAsync();
        await startup;
        expect(context.runGSM).toHaveBeenCalledOnce();
        expect(context.syncLockedEnvironment).not.toHaveBeenCalled();
    });

    it('allows recovery again after a stable runtime outside the crash loop window', async () => {
        vi.useFakeTimers();
        const { context } = loadRecovery();
        let failures = 0;
        context.runGSM.mockImplementation(async () => {
            if (failures++ < 5) {
                vi.setSystemTime(Date.now() + 61_000);
                throw new BackendProcessError('later crash', false);
            }
        });
        const startup = context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        await vi.runAllTimersAsync();
        await startup;
        expect(context.runGSM).toHaveBeenCalledTimes(6);
        expect(context.sendGSMCrashNotification.mock.calls).toEqual(Array(5).fill([true]));
        expect(context.syncLockedEnvironment).not.toHaveBeenCalled();
    });
});
