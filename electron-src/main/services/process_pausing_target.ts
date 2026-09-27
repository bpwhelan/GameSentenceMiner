import { getConfiguredSinglePort } from '../gsm_config.js';
import { getGameExePathForScene } from '../store.js';

export interface ProcessPausingTargetDeps {
    platform?: NodeJS.Platform;
    fetchImpl?: typeof fetch;
}

/** Write an executable path through to process_pausing.linux_target_process; the backend keeps its basename. */
export async function syncProcessPausingTarget(
    exePath: string,
    deps: ProcessPausingTargetDeps = {}
): Promise<void> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    await fetchImpl(`http://localhost:${getConfiguredSinglePort()}/linux/set_target_process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: exePath }),
    });
}

/**
 * Point process pausing at the scene's game executable, so switching OBS scenes switches the
 * game GSM pauses. A scene without one leaves the target alone, keeping a value set by hand.
 */
export async function syncProcessPausingTargetForScene(
    sceneName: string,
    deps: ProcessPausingTargetDeps = {}
): Promise<boolean> {
    if ((deps.platform ?? process.platform) !== 'linux') {
        return false;
    }
    const exePath = getGameExePathForScene(sceneName).trim();
    if (!exePath) {
        return false;
    }
    await syncProcessPausingTarget(exePath, deps);
    return true;
}
