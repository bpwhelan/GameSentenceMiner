import { gsmBackendUrl } from '../gsm_config.js';
import { getSceneLaunchProfileForScene } from '../store.js';
import type { ObsScene } from '../ui/obs.js';

export interface ProcessPausingTargetDeps {
    platform?: NodeJS.Platform;
    fetchImpl?: typeof fetch;
    /** Resend even if unchanged: a restarted backend has lost the value it held. */
    force?: boolean;
}

let lastSyncedExePath: string | null = null;
let pendingSync: Promise<unknown> = Promise.resolve();

async function postSceneTarget(exePath: string, fetchImpl: typeof fetch): Promise<void> {
    const response = await fetchImpl(gsmBackendUrl('/linux/set_scene_target_process'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: exePath }),
    });
    if (!response.ok) {
        throw new Error(`backend answered HTTP ${response.status}`);
    }
}

/**
 * Point process pausing at the scene's Game executable (Home tab). The backend holds it in memory
 * over process_pausing.linux_target_process, and a scene without one falls back to that setting.
 * Syncs run one at a time in call order, so the last scene switched to wins.
 */
export function syncProcessPausingTargetForScene(
    scene: ObsScene,
    deps: ProcessPausingTargetDeps = {}
): Promise<boolean> {
    const run = async (): Promise<boolean> => {
        if ((deps.platform ?? process.platform) !== 'linux' || !scene.name) {
            return false;
        }
        const exePath = (getSceneLaunchProfileForScene(scene)?.gameExecutablePath ?? '').trim();
        if (!deps.force && exePath === lastSyncedExePath) {
            return false;
        }
        await postSceneTarget(exePath, deps.fetchImpl ?? fetch);
        lastSyncedExePath = exePath;
        return true;
    };
    const result = pendingSync.then(run);
    pendingSync = result.catch(() => undefined);
    return result;
}
