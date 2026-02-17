import log from 'electron-log/main.js';

import { devFaultInjector } from './dev_fault_injection.js';

export interface BackendProcessState {
    running: boolean;
    pid?: number;
}

export interface UpdateChaosHarnessDeps {
    updateGSM: (shouldRestart?: boolean, force?: boolean) => Promise<void>;
    ensureAndRunGSM: (pythonPath: string) => Promise<void>;
    closeAllPythonProcesses: () => Promise<void>;
    getPythonPath: () => string;
    wasLastBackendUpdateSuccessful: () => boolean;
    getLastBackendUpdateFailureReason: () => string | null;
    getBackendProcessState: () => BackendProcessState;
}

export interface ChaosHarnessOptions {
    checkpoints?: string[];
    launchWaitTimeoutMs?: number;
}

export interface ChaosScenarioResult {
    scenario: string;
    checkpoint: string | null;
    injectedFailureObserved: boolean;
    recoverySucceeded: boolean;
    backendReachedRunningState: boolean;
    success: boolean;
    durationMs: number;
    error?: string;
}

export interface ChaosHarnessSummary {
    total: number;
    passed: number;
    failed: number;
    results: ChaosScenarioResult[];
}

const DEFAULT_CHECKPOINTS = [
    'update.check_for_updates',
    'update.close_running_processes',
    'update.ensure_uv',
    'update.sync_lockfile',
    'update.install_package',
    'update.retry.clean_uv_cache',
    'update.retry.sync_lockfile',
    'update.retry.install_package',
    'update.restart_backend',
    'startup.check_and_ensure_pip',
    'startup.check_and_install_uv',
    'startup.sync_lock_check',
    'startup.sync_lock_apply',
    'startup.install_package',
    'startup.run_gsm',
    'startup.repair.clean_uv_cache',
    'startup.repair.sync_lock',
    'startup.repair.install_package',
] as const;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCheckpoints(custom?: string[]): string[] {
    const fromEnv = process.env.GSM_CHAOS_SCENARIOS;
    const envList = fromEnv
        ? fromEnv
              .split(',')
              .map((token) => token.trim())
              .filter((token) => token.length > 0)
        : [];
    const source = custom && custom.length > 0 ? custom : envList;
    if (source && source.length > 0) {
        return Array.from(new Set(source));
    }
    return Array.from(DEFAULT_CHECKPOINTS);
}

async function stopBackendBestEffort(closeAllPythonProcesses: () => Promise<void>): Promise<void> {
    try {
        await closeAllPythonProcesses();
    } catch (error) {
        log.warn('[Chaos] Failed to stop backend during cleanup:', error);
    }
}

async function launchAndVerifyBackend(
    deps: UpdateChaosHarnessDeps,
    launchWaitTimeoutMs: number
): Promise<boolean> {
    const pythonPath = deps.getPythonPath();
    if (!pythonPath) {
        throw new Error('pythonPath is not initialized.');
    }

    let startupError: unknown = null;
    const runPromise = deps.ensureAndRunGSM(pythonPath).catch((error) => {
        startupError = error;
    });

    const deadline = Date.now() + launchWaitTimeoutMs;
    let running = false;
    while (Date.now() < deadline) {
        if (startupError) {
            throw startupError instanceof Error ? startupError : new Error(String(startupError));
        }
        const state = deps.getBackendProcessState();
        if (state.running && !!state.pid) {
            running = true;
            break;
        }
        await delay(400);
    }

    if (!running) {
        if (startupError) {
            throw startupError instanceof Error ? startupError : new Error(String(startupError));
        }
        throw new Error(
            `Backend process did not reach running state within ${launchWaitTimeoutMs}ms.`
        );
    }

    await stopBackendBestEffort(deps.closeAllPythonProcesses);
    // Run promise already has internal catch; do not await it because backend is long-lived.
    void runPromise;
    return true;
}

async function runScenario(
    deps: UpdateChaosHarnessDeps,
    scenario: string,
    checkpoint: string | null,
    launchWaitTimeoutMs: number
): Promise<ChaosScenarioResult> {
    const started = Date.now();
    let injectedFailureObserved = false;
    let recoverySucceeded = false;
    let backendReachedRunningState = false;

    try {
        await stopBackendBestEffort(deps.closeAllPythonProcesses);

        if (checkpoint) {
            devFaultInjector.configureScenario(scenario, { [checkpoint]: 1 });
        } else {
            devFaultInjector.clearScenario();
        }

        await deps.updateGSM(false, true);
        if (deps.wasLastBackendUpdateSuccessful()) {
            try {
                await launchAndVerifyBackend(deps, launchWaitTimeoutMs);
            } catch (faultPhaseError) {
                log.info(
                    `[Chaos] Fault phase observed launch/startup error for scenario ${scenario}: ${
                        faultPhaseError instanceof Error
                            ? faultPhaseError.message
                            : String(faultPhaseError)
                    }`
                );
            }
        }
        if (checkpoint) {
            const injected = devFaultInjector.getLastInjectedFailure();
            injectedFailureObserved = injected?.scenario === scenario;
            if (!injectedFailureObserved) {
                throw new Error(
                    `Scenario did not inject at checkpoint "${checkpoint}". The checkpoint may not have been reached.`
                );
            }
        }

        devFaultInjector.clearScenario();

        await deps.updateGSM(false, true);
        recoverySucceeded = deps.wasLastBackendUpdateSuccessful();
        if (!recoverySucceeded) {
            throw new Error(
                `Recovery update failed: ${deps.getLastBackendUpdateFailureReason() ?? 'unknown reason'}`
            );
        }

        backendReachedRunningState = await launchAndVerifyBackend(deps, launchWaitTimeoutMs);

        return {
            scenario,
            checkpoint,
            injectedFailureObserved,
            recoverySucceeded,
            backendReachedRunningState,
            success: true,
            durationMs: Date.now() - started,
        };
    } catch (error) {
        return {
            scenario,
            checkpoint,
            injectedFailureObserved,
            recoverySucceeded,
            backendReachedRunningState,
            success: false,
            durationMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        devFaultInjector.clearScenario();
        await stopBackendBestEffort(deps.closeAllPythonProcesses);
    }
}

export async function runUpdateChaosHarness(
    deps: UpdateChaosHarnessDeps,
    options: ChaosHarnessOptions = {}
): Promise<ChaosHarnessSummary> {
    const checkpoints = resolveCheckpoints(options.checkpoints);
    const launchWaitTimeoutMs = Math.max(5000, options.launchWaitTimeoutMs ?? 25000);
    const results: ChaosScenarioResult[] = [];

    log.info(
        `[Chaos] Starting update chaos harness. scenarios=${checkpoints.length}, launchTimeoutMs=${launchWaitTimeoutMs}`
    );

    for (const checkpoint of checkpoints) {
        const scenario = `fail:${checkpoint}`;
        log.info(`[Chaos] Running scenario ${scenario}`);
        const result = await runScenario(deps, scenario, checkpoint, launchWaitTimeoutMs);
        results.push(result);
        if (result.success) {
            log.info(
                `[Chaos] Scenario PASSED: ${scenario} (${result.durationMs}ms)`
            );
        } else {
            log.error(
                `[Chaos] Scenario FAILED: ${scenario} (${result.durationMs}ms) :: ${result.error}`
            );
        }
    }

    // Final baseline pass with no injected failure.
    const baselineScenario = 'baseline:no_faults';
    log.info(`[Chaos] Running scenario ${baselineScenario}`);
    const baselineResult = await runScenario(
        deps,
        baselineScenario,
        null,
        launchWaitTimeoutMs
    );
    results.push(baselineResult);

    const passed = results.filter((entry) => entry.success).length;
    const failed = results.length - passed;
    const summary: ChaosHarnessSummary = {
        total: results.length,
        passed,
        failed,
        results,
    };

    log.info(
        `[Chaos] Harness complete. passed=${summary.passed}, failed=${summary.failed}, total=${summary.total}`
    );
    return summary;
}
