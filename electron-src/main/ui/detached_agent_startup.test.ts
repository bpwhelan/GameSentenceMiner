import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ launched: false, requests: 0 }));
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
    execFile: vi.fn(),
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
                            ...(state.requests > 1 ? { startResult: { success: true } } : {}),
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
afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: platform });
});

it('does not report attachment ready until the detached host finishes loading the script', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
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
