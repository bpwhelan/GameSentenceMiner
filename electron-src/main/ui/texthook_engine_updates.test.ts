import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    handle: vi.fn(), prepare: vi.fn(), activate: vi.fn(), discard: vi.fn(), send: vi.fn(),
    reconnect: vi.fn(), runtime: vi.fn(), local: vi.fn(), remote: vi.fn(), automatic: vi.fn(),
    setAutomatic: vi.fn(), configureCallbacks: vi.fn(),
}));

vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: { handle: mocks.handle } }));
vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm', getAssetsDir: () => 'C:\\test-gsm\\assets',
    isWindows: () => false, isLinux: () => false, sanitizeFilename: (value: string) => value,
}));
vi.mock('../main.js', () => ({
    mainWindow: { isDestroyed: () => false, webContents: { send: mocks.send } },
    sendTextHookLine: vi.fn(), sendTextHookStatus: vi.fn(),
}));
vi.mock('../store.js', () => ({
    getAutoUpdateTexthook: mocks.automatic, setAutoUpdateTexthook: mocks.setAutomatic,
}));
vi.mock('./obs.js', () => ({}));
vi.mock('./native_texthook.js', () => ({
    configureNativeTextHookEvents: vi.fn(), nativeTextHook: vi.fn(),
    nativeTextHookSync: () => ({ running: false }),
}));
vi.mock('./texthook_downloader.js', () => ({
    getTexthookRuntimeDir: () => 'C:\\test-gsm\\texthook', FORCE_TEXTHOOK_DOWNLOAD: true,
    downloadTexthookEngines: vi.fn(), getEngineStatus: mocks.remote, getLocalEngineStatus: mocks.local,
    isTexthookInstalled: () => mocks.local().installed,
    prepareTexthookUpdate: mocks.prepare, activateTexthookUpdate: mocks.activate, discardTexthookUpdate: mocks.discard,
}));
vi.mock('./agent.js', () => ({
    configureAgentHookCallbacks: mocks.configureCallbacks,
    getAgentHookRuntimeStatus: mocks.runtime, isAgentHookRunning: () => !!mocks.runtime(),
}));
vi.mock('./detached_agent_client.js', () => ({
    configureDetachedAgentCallbacks: vi.fn(), reconnectDetachedAgentHookSession: mocks.reconnect,
    getDetachedAgentHookRuntimeStatus: () => null, isDetachedAgentHookRunning: () => false,
}));
vi.mock('../engine_hooks/session.js', () => ({
    getEngineHookRuntimeStatus: () => null, isEngineHookRunning: () => false,
}));

vi.mock('../runtime/native_hook_updates.js', () => ({
    nativeHookUpdates: {
        getState: mocks.local, check: mocks.remote, download: mocks.prepare,
        downloadVersion: mocks.activate, setAutomatic: mocks.setAutomatic,
        notifyIdle: vi.fn(), start: vi.fn(), dispose: vi.fn(),
    },
    reserveHookAttachment: mocks.discard, releaseHookAttachment: vi.fn(),
}));
// Scheduling and package lifetimes are tested against the native updater.
describe('native hook update compatibility commands', () => {
    const handler = (name: string): ((...args: any[]) => any) => mocks.handle.mock.calls.find(([channel]) => channel === name)![1];
    beforeEach(async () => {
        vi.resetModules(); vi.resetAllMocks();
        mocks.local.mockReturnValue({phase: 'waiting', automatic: false});
        mocks.reconnect.mockResolvedValue(false);
        mocks.runtime.mockReturnValue(null);
        const {registerTextHookIPC} = await import('./texthook.js'); registerTextHookIPC();
    });
    it('returns native state and forwards checks and explicit versions', async () => {
        expect(handler('texthook.getEngineStatus')()).toEqual({phase: 'waiting', automatic: false});
        await handler('texthook.checkEngineUpdates')(); expect(mocks.remote).toHaveBeenCalledWith(false);
        await handler('texthook.installEngineVersion')({}, '1.0.0'); expect(mocks.activate).toHaveBeenCalledWith('1.0.0');
        expect(() => handler('texthook.installEngineVersion')({}, {})).toThrow(/version/);
    });
    it('persists update preferences through the native owner', () => {
        expect(handler('texthook.setAutomaticEngineUpdates')({}, false)).toMatchObject({automatic: false});
        expect(mocks.setAutomatic).toHaveBeenCalledWith(false);
        expect(() => handler('texthook.setAutomaticEngineUpdates')({}, 'false')).toThrow(/preference/);
    });
    it('honors native attachment exclusion before target discovery', async () => {
        mocks.discard.mockImplementation(() => {throw Error('Hook engines are being prepared.');});
        const {startHookSession} = await import('./texthook.js');
        expect(await startHookSession()).toMatchObject({success:false,error:expect.stringMatching(/being prepared/)});
    });
});
