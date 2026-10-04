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

describe('text hook engine update integration', () => {
    const handler = (name: string): ((...args: unknown[]) => any) =>
        mocks.handle.mock.calls.find(([channel]) => channel === name)![1];

    beforeEach(async () => {
        vi.resetModules();
        vi.resetAllMocks();
        mocks.reconnect.mockResolvedValue(false);
        mocks.runtime.mockReturnValue(null);
        mocks.automatic.mockReturnValue(true);
        mocks.setAutomatic.mockImplementation((enabled) => mocks.automatic.mockReturnValue(enabled));
        mocks.local.mockReturnValue({ installed: true, version: '1.0.0', remoteVersion: null, updateAvailable: false });
        mocks.remote.mockResolvedValue({ installed: true, version: '1.0.0', remoteVersion: '2.0.0', updateAvailable: true });
        mocks.prepare.mockResolvedValue({ directory: 'prepared', manifest: { version: '2.0.0', files: [] } });
        mocks.activate.mockResolvedValue(undefined);
        mocks.discard.mockResolvedValue(undefined);
        const { registerTextHookIPC } = await import('./texthook.js');
        registerTextHookIPC();
    });

    it('prepares while attached, then applies when the runtime reports idle', async () => {
        mocks.runtime.mockReturnValue({ running: true, engine: 'agent' });
        expect(await handler('texthook.downloadEngines')()).toEqual({ success: true, deferred: true });
        expect(mocks.prepare).toHaveBeenCalledOnce();
        expect(mocks.activate).not.toHaveBeenCalled();
        expect(handler('texthook.getEngineStatus')()).toMatchObject({ phase: 'waiting' });
        mocks.runtime.mockReturnValue(null);
        mocks.configureCallbacks.mock.calls[0][0].onEvent('texthook.status', {});
        await handler('texthook.downloadEngines')();
        expect(mocks.activate).toHaveBeenCalledOnce();
    });

    it('prevents an attachment during the final package switch', async () => {
        let finish!: () => void;
        mocks.activate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
        const updating = handler('texthook.downloadEngines')();
        await Promise.resolve();
        const { startHookSession } = await import('./texthook.js');
        const blocked = await startHookSession();
        finish();
        await updating;
        expect(blocked).toMatchObject({ success: false, error: expect.stringMatching(/being prepared/) });
        expect(handler('texthook.getEngineStatus')()).toMatchObject({ phase: 'idle' });
    });

    it('checks manually through the same automatic update service and broadcasts its state', async () => {
        await handler('texthook.checkEngineUpdates')();
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.remote).toHaveBeenCalledOnce();
        expect(mocks.prepare).toHaveBeenCalledOnce();
        expect(mocks.send).toHaveBeenCalledWith('texthook.engineUpdateState', expect.objectContaining({ phase: 'installing' }));
    });

    it('persists the automatic update preference and validates the IPC input', () => {
        expect(handler('texthook.setAutomaticEngineUpdates')({}, false)).toMatchObject({ automatic: false });
        expect(mocks.setAutomatic).toHaveBeenCalledWith(false);
        expect(() => handler('texthook.setAutomaticEngineUpdates')({}, 'false')).toThrow(/preference/);
    });

    it('reports a failed verification and allows retry without losing the installed status', async () => {
        mocks.prepare.mockRejectedValueOnce(new Error('hash mismatch'));
        expect(await handler('texthook.downloadEngines')()).toEqual({ success: false, error: 'hash mismatch' });
        expect(handler('texthook.getEngineStatus')()).toMatchObject({ installed: true, version: '1.0.0', phase: 'error' });
        expect(mocks.activate).not.toHaveBeenCalled();
        expect(await handler('texthook.downloadEngines')()).toEqual({ success: true });
    });
});
