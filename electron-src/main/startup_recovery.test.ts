import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendProcessError } from './services/managed_python_repair.js';

function loadRecovery() {
    const parsed = ts.createSourceFile('main.ts', fs.readFileSync('electron-src/main/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const names = new Set(['ensureAndRunGSM', 'handleBackendStartupFailure']);
    const functions = parsed.statements
        .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
        .map((node) => node.getText(parsed)).join('\n');
    let now = 0;
    const context = vm.createContext({
        Error, BackendProcessError,
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
        pythonCall: vi.fn(async () => ({pythonPath:'python',installedVersion:'2026.10.3',selectedExtras:['gpu'],ignoredExtras:[]})),
        setPythonExtras: vi.fn(),
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

describe('native startup adapter', () => {
    it('submits one native lifetime with the existing environment choices', async () => {
        const { context } = loadRecovery();
        await context.ensureAndRunGSM('python', 1, { knownInstalledVersion: '2026.10.3', restart: true });
        expect(context.runGSM).toHaveBeenCalledExactlyOnceWith('python', [], undefined, {
            extras: ['gpu'], knownInstalledVersion: '2026.10.3', isPreRelease: false, repairOnFailure: true,
        }, true);
        expect(context.pythonCall).not.toHaveBeenCalled();
    });
    it.each([true, false])('never starts a second Node repair after native failure (before initialization=%s)', async beforeInitialization => {
        const { context } = loadRecovery();
        context.runGSM.mockRejectedValue(new BackendProcessError('Native lifetime exhausted', beforeInitialization));
        await context.ensureAndRunGSM('python').catch(context.handleBackendStartupFailure);
        expect(context.runGSM).toHaveBeenCalledOnce();
        expect(context.pythonCall).not.toHaveBeenCalled();
        expect(context.updateGSM).not.toHaveBeenCalled();
    });
    it('keeps launch gating for ongoing app updates', async () => {
        const { context } = loadRecovery();
        await context.ensureAndRunGSM('python', 0, { allowDuringUpdate: true });
        expect(context.waitForPythonLaunchReadiness).not.toHaveBeenCalled();
        expect(context.runGSM.mock.calls[0][3].repairOnFailure).toBe(false);
    });
});
