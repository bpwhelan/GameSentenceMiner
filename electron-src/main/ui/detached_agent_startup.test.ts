import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ call: vi.fn(), callSync: vi.fn(), receive: undefined as undefined | ((message: any) => void) }));
vi.mock('../data_dir.js', () => ({ getBaseDir: () => 'C:/test-gsm' }));
vi.mock('node:module', () => ({ createRequire: () => () => ({ call: native.call, callSync: native.callSync, events: { on: (_name: string, receive: (message: any) => void) => { native.receive = receive; } } }) }));
const options = { pid: 1234, exeName: 'game.exe', arch: 'x64' as const, source: 'user' as const, scriptPath: 'game.js', flushDelayMs: 100, copyToClipboard: false };
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); native.receive = undefined; });
afterEach(() => vi.useRealTimers());
it('waits for the native initialization result instead of reporting attachment as ready', async () => {
    let finish!: (value: unknown) => void;
    native.call.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { startDetachedAgentHookSession } = await import('./detached_agent_client.js');
    const completed = vi.fn(); const pending = startDetachedAgentHookSession(options).then(completed);
    await Promise.resolve(); expect(completed).not.toHaveBeenCalled();
    expect(native.call).toHaveBeenCalledWith('agent.command', expect.objectContaining({ action: 'start', params: expect.objectContaining({ detached: true, pid: 1234 }) }));
    finish({ success: true }); await pending; expect(completed).toHaveBeenCalledWith({ success: true });
});
it('does not impose the old ten-second timeout on native Unity retries', async () => {
    vi.useFakeTimers(); let finish!: (value: unknown) => void;
    native.call.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { startDetachedAgentHookSession } = await import('./detached_agent_client.js');
    const completed = vi.fn(); const pending = startDetachedAgentHookSession(options).then(completed);
    await vi.advanceTimersByTimeAsync(16000); expect(completed).not.toHaveBeenCalled();
    finish({ success: true }); await pending; expect(completed).toHaveBeenCalledWith({ success: true });
});
it('forwards a native startup failure and its renderer event', async () => {
    const failure = { success: false, error: 'Unity hooks did not become ready' };
    native.call.mockResolvedValue(failure);
    const { startDetachedAgentHookSession, configureDetachedAgentCallbacks } = await import('./detached_agent_client.js');
    const onEvent = vi.fn(); configureDetachedAgentCallbacks({ onEvent });
    expect(await startDetachedAgentHookSession(options)).toEqual(failure);
    native.receive?.({ type: 'agent-controller', detached: true, event: 'texthook.agentError', data: { error: failure.error } });
    expect(onEvent).toHaveBeenCalledWith('texthook.agentError', { error: failure.error });
});
it('lets Stop reach the native supervisor while startup is pending', async () => {
    let cancel!: (error: Error) => void;
    native.call.mockImplementation((_method, { action }) => action === 'start' ? new Promise((_resolve, reject) => { cancel = reject; }) : (cancel(new Error('Agent startup cancelled')), Promise.resolve({ success: true })));
    const { startDetachedAgentHookSession, stopDetachedAgentHookSession } = await import('./detached_agent_client.js');
    const pending = startDetachedAgentHookSession(options);
    expect(await stopDetachedAgentHookSession()).toEqual({ success: true });
    expect(await pending).toEqual({ success: false, error: 'Agent startup cancelled' });
});
