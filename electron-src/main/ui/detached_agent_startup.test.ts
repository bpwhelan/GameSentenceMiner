import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ launched: false, requests: 0, readyAt: 0, error: null as string | null }));
vi.mock('electron', () => ({ app: { getAppPath: () => 'C:\\GSM' } }));
vi.mock('../data_dir.js', () => ({ getBaseDir: () => 'C:\\GSM' }));
vi.mock('node:fs', () => ({
    readFileSync: () => {
        if (!state.launched) throw new Error('No host yet');
        return JSON.stringify({ version: 1, hostPid: 12, port: 3456, token: 'test', startedAt: 1 });
    },
    mkdirSync: vi.fn(), rmSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({
    execFile: (_command: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) =>
        callback(null, 'INFO: No tasks are running.'),
    spawn: () => { state.launched = true; return { unref: vi.fn() }; },
}));
vi.mock('node:net', async () => {
    const { EventEmitter } = await import('node:events');
    return {
        createConnection: () => {
            class Socket extends EventEmitter {
                destroyed = false;
                unref() { return this; }
                setEncoding() { return this; }
                write(line: string) {
                    const request = JSON.parse(line);
                    if (request.kind !== 'request') return;
                    state.requests++;
                    queueMicrotask(() => this.emit('data', `${JSON.stringify({
                        kind: 'response', id: request.id, success: true,
                        result: {
                            status: { running: true, pid: 1234, exeName: 'eden.exe', engine: 'agent', arch: 'x64' },
                            hooks: { hooks: [], selectedHookId: null },
                            ...(state.error ? { startResult: { success: false, error: state.error } } :
                                state.requests > 1 && Date.now() >= state.readyAt ? { startResult: { success: true } } : {}),
                        },
                    })}\n`));
                }
                destroy() { this.destroyed = true; this.emit('close'); }
            }
            const socket = new Socket();
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        },
    };
});

const platform = process.platform;
beforeEach(() => {
    vi.resetModules();
    state.launched = false;
    state.requests = 0;
    state.readyAt = 0;
    state.error = null;
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});
afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: platform });
});

it('does not report attachment ready until the detached host finishes loading the script', async () => {
    const { startDetachedAgentHookSession } = await import('./detached_agent_client.js');
    const completed = vi.fn();
    const pending = startDetachedAgentHookSession({
        pid: 1234, exeName: 'eden.exe', arch: 'x64', source: 'auto-launcher',
        scriptPath: 'C:\\scripts\\game.js', flushDelayMs: 0, copyToClipboard: false, maxBufferSize: 3000,
    }).then(completed);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.requests).toBe(1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(completed).toHaveBeenCalledWith({ success: true, pid: 1234, exeName: 'eden.exe', arch: 'x64' });
});

it('allows Unity startup retries to run longer than the old ten-second connection timeout', async () => {
    state.readyAt = Date.now() + 15_000;
    const { startDetachedAgentHookSession } = await import('./detached_agent_client.js');
    const pending = startDetachedAgentHookSession({
        pid: 1234, exeName: 'game.exe', arch: 'x64', source: 'auto-launcher',
        scriptPath: 'C:\\scripts\\game.js', flushDelayMs: 0, copyToClipboard: false, maxBufferSize: 3000,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ success: true });
});

it('surfaces initialization failures that occurred before the client connected', async () => {
    state.error = 'Unity hooks did not become ready. Load the game and attach again.';
    const { startDetachedAgentHookSession, configureDetachedAgentCallbacks } = await import('./detached_agent_client.js');
    const onEvent = vi.fn();
    configureDetachedAgentCallbacks({ onEvent });
    const pending = startDetachedAgentHookSession({
        pid: 1234, exeName: 'game.exe', arch: 'x64', source: 'auto-launcher',
        scriptPath: 'C:\\scripts\\game.js', flushDelayMs: 0, copyToClipboard: false, maxBufferSize: 3000,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ success: false, error: state.error });
    expect(onEvent).toHaveBeenCalledWith('texthook.agentError', { error: state.error });
});

it('cancels a pending detached startup when Stop is requested', async () => {
    state.readyAt = Date.now() + 15_000;
    const { startDetachedAgentHookSession, stopDetachedAgentHookSession } = await import('./detached_agent_client.js');
    const pending = startDetachedAgentHookSession({
        pid: 1234, exeName: 'game.exe', arch: 'x64', source: 'auto-launcher',
        scriptPath: 'C:\\scripts\\game.js', flushDelayMs: 0, copyToClipboard: false, maxBufferSize: 3000,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await stopDetachedAgentHookSession()).toMatchObject({ success: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('cancelled') });
});
