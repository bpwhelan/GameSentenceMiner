import { BackendProcessError } from './managed_python_repair.js';

const MAX_CRASH_RESTARTS = 3;
const CRASH_RESTART_WINDOW_MS = 60_000;
const CRASH_RESTART_DELAY_MS = 1_000;

interface CrashRecoveryOptions {
    /** A quit, update, or manual restart supersedes this process lifetime. */
    canRestart: () => boolean;
    notify: (restarting: boolean, error: BackendProcessError) => void;
}

/** Restart initialized backends without touching their installed environment. */
export async function runBackendWithCrashRecovery(
    run: () => Promise<void>,
    options: CrashRecoveryOptions,
): Promise<void> {
    let recentRestarts: number[] = [];
    for (;;) {
        try {
            return await run();
        } catch (error) {
            // Only initialization failures belong to the install/repair flow.
            if (!(error instanceof BackendProcessError) || error.beforeInitialization) {
                throw error;
            }
            if (!options.canRestart()) return;

            const now = Date.now();
            recentRestarts = recentRestarts.filter((time) => now - time < CRASH_RESTART_WINDOW_MS);
            const restarting = recentRestarts.length < MAX_CRASH_RESTARTS;
            try {
                options.notify(restarting, error);
            } catch (notificationError) {
                console.warn('Could not show the backend crash notification:', notificationError);
            }
            if (!restarting) throw error;

            recentRestarts.push(now);
            await new Promise((resolve) => setTimeout(resolve, CRASH_RESTART_DELAY_MS));
            if (!options.canRestart()) return;
        }
    }
}
