import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ call: vi.fn(), callSync: vi.fn(), on: vi.fn(), syncTarget: vi.fn(), updateStage: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => () => ({ call: mocks.call, callSync: mocks.callSync, events: { on: mocks.on } }) }));
vi.mock('../util.js', () => ({ BASE_DIR: 'C:/profile', getGSMBaseDir: () => 'C:/app' }));
vi.mock('../data_dir.js', () => ({ getDefaultRecordingsDir: () => 'C:/recordings' }));
vi.mock('../services/process_pausing_target.js', () => ({ syncProcessPausingTargetForScene: mocks.syncTarget }));
vi.mock('../services/install_session_state.js', () => ({ installSessionManager: { updateStage: mocks.updateStage } }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.call.mockResolvedValue(null); mocks.callSync.mockReturnValue({ connected: true, updating: false, launchStatus: 'launched' }); mocks.syncTarget.mockResolvedValue(true); });
describe('native OBS application boundary', () => {
  it('initializes once and forwards lifecycle without owning OBS processes', async () => {
    const obs = await import('./obs.js');
    await obs.launchOBSFromElectron({ reason: 'startup' });
    await obs.closeOBSFromElectron({ ignoreCloseConfig: true });
    expect(mocks.callSync).toHaveBeenCalledTimes(1);
    expect(mocks.callSync.mock.calls[0][0]).toBe('obs.initialize');
    expect(mocks.call).toHaveBeenNthCalledWith(1, 'obs.invoke', { channel: 'obs.launchManaged', args: [{ reason: 'startup' }] });
    expect(mocks.call).toHaveBeenNthCalledWith(2, 'obs.invoke', { channel: 'obs.close', args: [{ ignoreCloseConfig: true }] });
  });
  it('surfaces native failure without a Node fallback or retry', async () => {
    const obs = await import('./obs.js'); mocks.call.mockRejectedValue(new Error('OBS is disconnected'));
    await expect(obs.setOBSSceneByUuid('game')).rejects.toThrow('OBS is disconnected');
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it('routes native scene notifications to other application services', async () => {
    const obs = await import('./obs.js'); const changed = vi.fn(); const unsubscribe = obs.onNativeOBSSceneChanged(changed);
    await obs.registerOBSIPC();
    const receive = mocks.on.mock.calls[0][1]; const scene = { name: '日本語', id: 'game' };
    receive({ type: 'obs-controller', event: 'obs.sceneChanged', data: scene });
    expect(changed).toHaveBeenCalledWith(scene); expect(mocks.syncTarget).toHaveBeenCalledWith(scene);
    unsubscribe(); receive({ type: 'obs-controller', event: 'obs.sceneChanged', data: scene }); expect(changed).toHaveBeenCalledTimes(1);
  });
  it('reads connection and update state from Rust', async () => {
    const obs = await import('./obs.js'); expect(obs.isOBSConnected()).toBe(true); expect(obs.isObsRuntimeUpdateInProgress()).toBe(false);
    expect(mocks.callSync).toHaveBeenLastCalledWith('obs.state');
  });
});
