/** Application notifications only. Native OBS owns foreground observation,
 * rule storage, migration, reconciliation, switching and the conflict picker. */
import { forwardOBSForeground, onNativeOBSSceneChanged } from '../ui/obs.js';
import type { ForegroundWindowSnapshot, WindowSceneSwitcherHookStatus } from '../../shared/window_scene_switcher.js';
let unsubscribe: (() => void) | undefined;
export function configureWindowSceneSwitcherRuntime(options: { onSceneChanged?: () => void }): void {
    unsubscribe?.();
    unsubscribe = onNativeOBSSceneChanged(() => options.onSceneChanged?.());
}
export function handleForegroundWindowSnapshot(snapshot: ForegroundWindowSnapshot): void { forwardOBSForeground(snapshot); }
// Hook status belongs to the backend; the native switcher also polls independently.
export function setForegroundWindowHookStatus(_status: WindowSceneSwitcherHookStatus, _error?: string): void {}
export function registerWindowSceneSwitcherIPC(): void {}
export function shutdownWindowSceneSwitcher(): void { unsubscribe?.(); unsubscribe = undefined; }
