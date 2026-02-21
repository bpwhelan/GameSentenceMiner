import { afterEach, describe, expect, it } from 'vitest';

import { devFaultInjector } from './dev_fault_injection.js';
import {
    runUpdateChaosHarness,
    type UpdateChaosHarnessDeps,
} from './update_chaos_harness.js';

function createFakeDeps(): UpdateChaosHarnessDeps {
    let lastBackendUpdateSucceeded = true;
    let lastBackendUpdateError: string | null = null;
    let backendRunning = false;

    return {
        updateGSM: async () => {
            try {
                devFaultInjector.maybeFail('update.check_for_updates');
                lastBackendUpdateSucceeded = true;
                lastBackendUpdateError = null;
            } catch (error) {
                lastBackendUpdateSucceeded = false;
                lastBackendUpdateError = error instanceof Error ? error.message : String(error);
            }
        },
        ensureAndRunGSM: async () => {
            devFaultInjector.maybeFail('startup.run_gsm');
            backendRunning = true;
            return await new Promise<void>(() => {
                // Long-running backend process.
            });
        },
        closeAllPythonProcesses: async () => {
            backendRunning = false;
        },
        getPythonPath: () => 'python',
        wasLastBackendUpdateSuccessful: () => lastBackendUpdateSucceeded,
        getLastBackendUpdateFailureReason: () => lastBackendUpdateError,
        getBackendProcessState: () => ({
            running: backendRunning,
            pid: backendRunning ? 1234 : undefined,
        }),
    };
}

describe('runUpdateChaosHarness', () => {
    afterEach(() => {
        devFaultInjector.clearScenario();
    });

    it('recovers from update and startup checkpoint failures', async () => {
        const summary = await runUpdateChaosHarness(createFakeDeps(), {
            checkpoints: ['update.check_for_updates', 'startup.run_gsm'],
            launchWaitTimeoutMs: 2000,
        });

        expect(summary.total).toBe(3); // 2 checkpoints + baseline
        expect(summary.failed).toBe(0);
        expect(summary.passed).toBe(3);
    });
});
