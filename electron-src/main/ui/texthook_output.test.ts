import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    request: vi.fn(), sync: vi.fn(), events: vi.fn(),
    sendTextHookLine: vi.fn(),
    send: vi.fn(),
}));

vi.mock('./native_texthook.js', () => ({ nativeTextHook: mocks.request, nativeTextHookSync: mocks.sync, configureNativeTextHookEvents: mocks.events }));
vi.mock('../runtime/native_hook_updates.js', () => ({nativeHookUpdates: {notifyIdle: vi.fn()}, reserveHookAttachment: () => 'lease', releaseHookAttachment: vi.fn()}));
vi.mock('../runtime/native_settings.js', () => ({ settingsSync: () => null }));
vi.mock('../services/game_privileges.js', () => ({ gamePrivilegeMonitor: { setTarget: vi.fn(), check: vi.fn() } }));
vi.mock('child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn(), exec: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: (filename: string) => filename.endsWith('.exe') }));
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: { handle: vi.fn() } }));
vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm',
    getAssetsDir: () => 'C:\\test-gsm\\assets',
    isWindows: () => true,
    isLinux: () => false,
    sanitizeFilename: (value: string) => value,
}));
vi.mock('../main.js', () => ({
    mainWindow: { isDestroyed: () => false, webContents: { send: mocks.send } },
    sendTextHookLine: mocks.sendTextHookLine,
    sendTextHookStatus: vi.fn(),
}));
vi.mock('../store.js', () => ({}));
vi.mock('../gsm_config.js', () => ({}));
vi.mock('./obs.js', () => ({}));
vi.mock('./linux_wine.js', () => ({}));
vi.mock('./wine_frida.js', () => ({}));
vi.mock('./texthook_downloader.js', () => ({
    getTexthookRuntimeDir: () => 'C:\\test-gsm\\texthook',
    FORCE_TEXTHOOK_DOWNLOAD: false,
    isTexthookInstalled: () => true,
}));
vi.mock('./agent.js', () => ({
    getAgentHookRuntimeStatus: () => null,
    isAgentHookRunning: () => false,
    stopAgentHookSession: vi.fn(),
}));
vi.mock('./detached_agent_client.js', () => ({
    reconnectDetachedAgentHookSession: async () => false,
    getDetachedAgentHookRuntimeStatus: () => null,
    isDetachedAgentHookRunning: () => false,
}));
vi.mock('../engine_hooks/session.js', () => ({
    getEngineHookRuntimeStatus: () => null,
    isEngineHookRunning: () => false,
    stopEngineHookSession: vi.fn(),
}));
vi.mock('../engine_hooks/support.js', () => ({}));

// Parsing, buffering and engine lifetime contracts now live in gsm-texthook's
// Rust tests. These cover the remaining application-service boundary.
describe('native CLI text hook coordination', () => {
    beforeEach(() => {
        vi.resetModules(); vi.clearAllMocks();
        mocks.sync.mockReturnValue({ running: false });
        mocks.request.mockResolvedValue({ success: true, pid: 4567, arch: 'x64' });
    });
    it.each(['luna', 'textractor'] as const)('starts %s through Rust without spawning a Node child', async (engine) => {
        const hook = await import('./texthook.js');
        expect(await hook.startHookSession({ engine, exeName: 'game.exe', sceneId: 'scene-1', pidOverride: 4567, archOverride: 'x64', flushDelayMs: 125, copyToClipboard: true })).toMatchObject({ success: true });
        expect(mocks.request).toHaveBeenCalledWith('start', expect.objectContaining({ engine, pid: 4567, attachPid: 4567, flushDelayMs: 125, copyToClipboard: true, maxBufferSize: 3000, cliPaths: expect.objectContaining({ x86: expect.any(String), x64: expect.any(String) }) }));
        expect(mocks.spawn).not.toHaveBeenCalled();
        hook.stopHookSession();
        expect(mocks.sync).toHaveBeenCalledWith('stop');
    });
    it('forwards native output unchanged and delivers previews without parsing them', async () => {
        const hook = await import('./texthook.js');
        await hook.startHookSession({ exeName: 'game.exe', sceneId: 's', pidOverride: 4567, archOverride: 'x64' });
        const onEvent = mocks.events.mock.calls[0][0];
        const output = { text: '日本語🦀', hookId: '43', engine: 'luna', capturedAt: 42, mergeFragments: false, revisionWindowMs: 0 };
        onEvent('texthook.output', output);
        expect(mocks.sendTextHookLine).toHaveBeenCalledExactlyOnceWith(output, expect.any(Function));
        expect(mocks.send).not.toHaveBeenCalledWith('texthook.processed', expect.anything());
        const processed = { text: '日本語', originalText: output.text, hookId: '43', ts: 42 };
        const onProcessed = mocks.sendTextHookLine.mock.calls[0][1];
        onProcessed(processed);
        expect(mocks.send).toHaveBeenCalledWith('texthook.processed', processed);
        mocks.send.mockClear();
        hook.stopHookSession();
        onProcessed(processed);
        expect(mocks.send).not.toHaveBeenCalledWith('texthook.processed', expect.anything());
        onEvent('texthook.hooks', { hooks: [{ id: '43' }], selectedHookId: '43' });
        expect(mocks.send).toHaveBeenCalledWith('texthook.hooks', { hooks: [{ id: '43' }], selectedHookId: '43' });
    });
    it('reports a native start failure without a JavaScript engine fallback', async () => {
        mocks.request.mockRejectedValue(new Error('Target process has exited'));
        const hook = await import('./texthook.js');
        expect(await hook.startHookSession({ exeName: 'game.exe', sceneId: 's', pidOverride: 4567, archOverride: 'x64' })).toEqual({ success: false, error: 'Target process has exited' });
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it('cancels a pending start before native attachment', async () => {
        const hook = await import('./texthook.js');
        const start = hook.startHookSession({ exeName: 'game.exe', sceneId: 's', pidOverride: 4567, archOverride: 'x64' });
        hook.stopHookSession();
        expect(await start).toMatchObject({ success: false, error: 'Text hook start was cancelled.' });
        expect(mocks.request).not.toHaveBeenCalledWith('start', expect.anything());
    });
});
