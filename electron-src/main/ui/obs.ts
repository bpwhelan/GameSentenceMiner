/** Compatibility calls for application services that have not moved to Rust yet.
 * OBS state, retries, files, devices, scenes, processes and updates are native.
 * Renderer OBS requests bypass this module entirely.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { BASE_DIR, getGSMBaseDir } from '../util.js';
import { getDefaultRecordingsDir } from '../data_dir.js';
import { syncProcessPausingTargetForScene } from '../services/process_pausing_target.js';
import { installSessionManager } from '../services/install_session_state.js';
import type { WindowSceneSwitcherSuggestion } from '../../shared/window_scene_switcher.js';
type ObsCaptureMode = 'window_capture' | 'game_capture';
export { getGameInfoFromWindow, shouldFilterWindow } from '../../shared/capture_window_policy.js';
export interface ObsScene { name: string; id: string }
export interface ObsScenePreviewSnapshot { sceneName: string; sceneId: string; sourceName: string | null; captureMode: ObsCaptureMode | null; imageData: string | null }
interface ProcessOptions { forceRestart?: boolean; ignoreOpenConfig?: boolean; ignoreCloseConfig?: boolean; allowPathFallback?: boolean; reason?: string }
interface ProcessResult { status: 'launched'|'already-running'|'skipped'|'missing'|'failed'|'closed'|'not-running'; pid?: number; error?: string }
const require = createRequire(import.meta.url);
let transport: any;
let initialized = false;
const sceneListeners = new Set<(scene: ObsScene) => void>();
function native() {
    transport ??= require(path.join(process.env.GSM_APP_ROOT || process.cwd(), 'desktop-runtime/transport.cjs'));
    if (!initialized) {
        transport.callSync('obs.initialize', {
            baseDir: BASE_DIR, recordingsDir: getDefaultRecordingsDir(),
            policyPath: path.resolve(getGSMBaseDir(), 'resources/assets/obs-release-policy.json'),
            coordinateClients: true,
        });
        initialized = true;
        transport.events.on('message', (message: any) => {
            if (message.type !== 'obs-controller') return;
            if (message.event === 'obs.sceneChanged') {
                for (const listener of sceneListeners) listener(message.data);
                void syncProcessPausingTargetForScene(message.data).catch(console.warn);
            }
            if (message.event === 'obs.install.progress') installSessionManager.updateStage(message.data);
            if (message.event === 'obs.runtime.progress' && message.data.phase !== 'idle') {
                installSessionManager.updateStage({ stageId: 'obs', status: message.data.phase === 'error' ? 'failed' : 'running', progressKind: 'estimated', progress: message.data.progress, message: 'Preparing OBS Studio...', error: message.data.error });
            }
        });
    }
    return transport;
}
export const nativeOBS = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => native().call('obs.invoke', { channel, args });
export const onNativeOBSSceneChanged = (listener: (scene: ObsScene) => void) => { sceneListeners.add(listener); return () => { sceneListeners.delete(listener); }; };
export const forwardOBSForeground = (snapshot: unknown): void => { void native().call('obs.foreground', snapshot).catch(console.warn); };
export const isOBSConnected = (): boolean => native().callSync('obs.state').connected;
export const isObsRuntimeUpdateInProgress = (): boolean => native().callSync('obs.state').updating;
export const getElectronOBSStartupConfig = (): any => native().callSync('obs.startupConfig');
export const waitForObsRuntimeUpdate = (): Promise<void> => nativeOBS('obs.runtime.wait');
export const ensureObsInstalled = (): Promise<string> => nativeOBS('obs.ensureInstalled');
export const ensureObsInstalledAndLaunch = async (options: ProcessOptions = {}): Promise<void> => { await nativeOBS('obs.ensureInstalledAndLaunch', options); };
export const launchOBSFromElectron = (options: ProcessOptions = {}): Promise<ProcessResult> => nativeOBS('obs.launchManaged', options);
export const closeOBSFromElectron = (options: ProcessOptions = {}): Promise<ProcessResult> => nativeOBS('obs.close', options);
export const getOBSConnection = (): Promise<void> => nativeOBS('obs.connect');
export const waitForOBSFrontend = (): Promise<void> => nativeOBS('obs.ready');
export const registerOBSIPC = async (): Promise<void> => { native(); };
export const getOBSScenes = (): Promise<ObsScene[]> => nativeOBS('obs.getScenes');
export const getOBSScenesForSceneSwitcher = getOBSScenes;
export const getCurrentScene = (): Promise<ObsScene> => nativeOBS('obs.getActiveScene');
export const getCurrentOBSSceneCollectionName = (): Promise<string> => nativeOBS('obs.getCollection');
export const getExecutableNameFromSource = (id: string): Promise<string | null> => nativeOBS('obs.getExecutableNameFromSource', id);
export const getWindowTitleFromSource = (id: string): Promise<string | null> => nativeOBS('obs.getWindowTitleFromSource', id);
export const sceneHasVisibleOutput = (scene: Pick<ObsScene, 'name'>): Promise<boolean | null> => nativeOBS('obs.sceneHasVisibleOutput', scene);
export const getSceneCaptureMode = (id: string): Promise<ObsCaptureMode | null> => nativeOBS('obs.getSceneCaptureMode', id);
export const getScenePreviewSnapshot = (id?: string | null): Promise<ObsScenePreviewSnapshot | null> => nativeOBS('obs.getScenePreviewSnapshot', id);
export const switchOBSSceneCaptureMode = (id: string, mode: ObsCaptureMode): Promise<ObsCaptureMode | null> => nativeOBS('obs.switchSceneCaptureMode', { sceneUuid: id, targetMode: mode });
export const setOBSScene = (name: string): Promise<void> => nativeOBS('obs.switchScene', name);
export const setOBSSceneByUuid = (id: string): Promise<void> => nativeOBS('obs.switchScene.id', id);
export const renameOBSScene = (id: string, name: string): Promise<void> => nativeOBS('obs.renameScene', { sceneUuid: id, newSceneName: name });
export const suggestWindowSceneSwitcherRule = (id: string): Promise<WindowSceneSwitcherSuggestion | null> => nativeOBS('scene-switcher.suggestRule', id);
export const syncProcessPausingTargetForCurrentScene = (force = false): void => {
    void getCurrentScene().then(scene => syncProcessPausingTargetForScene(scene, { force })).catch(console.warn);
};
