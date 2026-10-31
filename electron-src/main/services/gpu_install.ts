import type { GpuInstallPhase } from '../../shared/gpu.js';

interface GpuRuntimeChange {
    stop(): Promise<void>;
    apply(): Promise<void>;
    /** This promise follows the child until exit; onSpawn signals only launch. */
    launch(onSpawn: () => void): Promise<void>;
    bus: {
        isConnected(client: string): boolean;
        on(event: 'client-connected', listener: (client: string) => void): () => void;
    };
    onPhase(phase: GpuInstallPhase): void;
    startupTimeoutMs?: number;
}

let changingRuntime = false;

function waitForBackendStart(deps: GpuRuntimeChange): Promise<void> {
    return new Promise((resolve, reject) => {
        let spawned = false;
        let settled = false;
        let unsubscribe = () => {};
        const timer = setTimeout(() => finish(new Error('GSM did not reconnect after changing the GPU runtime. Reopen GSM to retry.')),
            deps.startupTimeoutMs ?? 60_000);
        function finish(error?: unknown) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            if (error) reject(error);
            else resolve();
        }
        function checkReady() {
            if (spawned && deps.bus.isConnected('backend')) finish();
        }
        try {
            unsubscribe = deps.bus.on('client-connected', (client) => {
                if (client === 'backend') checkReady();
            });
            void deps.launch(() => { spawned = true; checkReady(); }).then(
                () => { if (!settled) finish(new Error('GSM stopped before it could reconnect.')); },
                (error) => { if (!settled) finish(error); },
            );
        } catch (error) {
            finish(error);
        }
    });
}

export async function changeGpuRuntime(deps: GpuRuntimeChange): Promise<void> {
    if (changingRuntime) throw new Error('A GPU runtime change is already in progress.');
    changingRuntime = true;
    try {
        deps.onPhase('stopping');
        await deps.stop();
        let applyError: unknown;
        try {
            deps.onPhase('installing');
            await deps.apply();
        } catch (error) {
            applyError = error;
        }
        // Bring GSM back even if a download or package check failed.
        deps.onPhase('starting');
        try {
            await waitForBackendStart(deps);
        } catch (startError) {
            if (applyError) throw new AggregateError([applyError, startError],
                `GPU runtime change failed and GSM could not restart: ${String(applyError)}; ${String(startError)}`);
            throw startError;
        }
        if (applyError) throw applyError;
    } finally {
        changingRuntime = false;
    }
}
