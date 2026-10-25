import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    baseDir: '',
    attach: vi.fn(),
}));
vi.mock('frida', () => ({
    default: { attach: mocks.attach },
    MessageType: { Send: 'send', Error: 'error' },
    ScriptRuntime: { QJS: 'qjs' },
}));
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));
vi.mock('../data_dir.js', () => ({ getBaseDir: () => mocks.baseDir }));
vi.mock('node:child_process', () => ({
    exec: (_command: string, _options: unknown, callback: (error: null, stdout: string) => void) => callback(null, '"game.exe","1234"'),
}));

class FakeScript {
    onMessage?: (message: any, data: null) => void;
    logHandler?: (level: string, text: string) => void;
    message = { connect: (handler: FakeScript['onMessage']) => { this.onMessage = handler; } };
    unload = vi.fn(async () => {});
    post = vi.fn();
    load = vi.fn(async () => {});
    send(payload: object) { this.onMessage?.({ type: 'send', payload }, null); }
    initialized() { this.send({ cmd: '__gsm_agent_initialized' }); }
    fail(description: string) { this.onMessage?.({ type: 'error', description }, null); }
}

describe('Agent initialization', () => {
    let agent: typeof import('./agent.js');
    let scripts: FakeScript[];
    let onLoad: (script: FakeScript, attempt: number) => void | Promise<void>;
    let detach: ReturnType<typeof vi.fn>;
    let events: Array<[string, any]>;
    let text: ReturnType<typeof vi.fn>;
    let scriptPath: string;
    const platform = process.platform;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        mocks.baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-agent-test-'));
        scriptPath = path.join(mocks.baseDir, 'game.js');
        fs.writeFileSync(scriptPath, '// game');
        fs.writeFileSync(path.join(mocks.baseDir, 'libLoader.js'), '// loader');
        scripts = [];
        events = [];
        text = vi.fn();
        detach = vi.fn(async () => {});
        onLoad = (script) => script.initialized();
        mocks.attach.mockResolvedValue({
            createScript: vi.fn(async () => {
                const script = new FakeScript();
                scripts.push(script);
                script.load.mockImplementation(async () => { await onLoad(script, scripts.length); });
                return script;
            }),
            detached: { connect: vi.fn() },
            detach,
        });
        agent = await import('./agent.js');
        agent.configureAgentHookCallbacks({ onEvent: (channel, payload) => events.push([channel, payload]), onText: text });
    });

    afterEach(async () => {
        agent.stopAgentHookSession();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
        Object.defineProperty(process, 'platform', { value: platform });
        fs.rmSync(mocks.baseDir, { recursive: true, force: true });
    });

    function start() {
        return agent.startAgentHookSession({
            pid: 1234, exeName: 'game.exe', arch: 'x64', scriptPath,
            flushDelayMs: 100, copyToClipboard: false, source: 'user',
        });
    }

    it('rejects an initialization exception even when Frida load resolves', async () => {
        onLoad = (script) => script.fail('Error: broken game script');
        const result = await start();
        expect(result).toMatchObject({ success: false, error: expect.stringContaining('broken game script') });
        expect(agent.isAgentHookRunning()).toBe(false);
        expect(detach).toHaveBeenCalledOnce();
        expect(events).toContainEqual(['texthook.agentError', expect.objectContaining({ error: expect.stringContaining('broken game script') })]);
    });

    it('waits for initialization messages delivered after load resolves', async () => {
        onLoad = (script) => { setTimeout(() => script.fail('Error: delayed initialization failure'), 1); };
        const pending = start();
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('delayed initialization failure') });
    });

    it('keeps startup distinct from an initialized session and times out a missing completion marker', async () => {
        onLoad = () => {};
        const pending = start();
        await vi.advanceTimersByTimeAsync(1);
        expect(agent.getAgentHookRuntimeStatus()).toMatchObject({ agentPhase: 'starting', hookCount: 0 });
        expect(agent.listAgentHooks()).toEqual({ hooks: [], selectedHookId: null });
        await vi.advanceTimersByTimeAsync(5000);
        expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('Timed out') });
    });

    it('allows a valid script to spend more than five seconds scanning during load', async () => {
        onLoad = async (script) => {
            await new Promise((resolve) => setTimeout(resolve, 6000));
            script.initialized();
        };
        const pending = start();
        await vi.advanceTimersByTimeAsync(6000);
        expect(await pending).toMatchObject({ success: true });
    });

    it('reloads an early Unity failure without detaching from the game', async () => {
        onLoad = (script, attempt) => {
            if (attempt === 1) {
                script.logHandler?.('warning', 'Error: Mono not found!');
                script.fail("TypeError: cannot read property 'setHook' of undefined");
            } else script.initialized();
        };
        const pending = start();
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ success: true });
        expect(scripts).toHaveLength(2);
        expect(scripts[0].unload).toHaveBeenCalledOnce();
        expect(mocks.attach).toHaveBeenCalledOnce();
        expect(detach).not.toHaveBeenCalled();
        expect(agent.getAgentHookRuntimeStatus()).toMatchObject({ agentPhase: 'waiting' });
    });

    it('retries when Mono is loaded but its domain is not usable yet', async () => {
        onLoad = (script, attempt) => {
            if (attempt === 1) script.fail('Error: access violation accessing 0x0\n    at monoInit (C:\\scripts\\libMono.js:389)');
            else script.initialized();
        };
        const pending = start();
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ success: true });
        expect(scripts).toHaveLength(2);
    });

    it.each([false, true])('handles missing Mono hooks with another hook attached = %s', async (partiallyAttached) => {
        onLoad = (script, attempt) => {
            if (attempt === 1) {
                script.logHandler?.('warning', 'Hook not found!  messageController.showMessageCor');
                if (partiallyAttached) script.logHandler?.('warning', 'Attach: 0x1234');
            }
            script.initialized();
        };
        const pending = start();
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ success: true });
        expect(scripts).toHaveLength(partiallyAttached ? 1 : 2);
    });

    it('bounds Unity retries and returns an actionable error', async () => {
        onLoad = (script) => {
            script.logHandler?.('warning', 'Error: Mono not found!');
            script.fail("TypeError: cannot read property 'setHook' of undefined");
        };
        const pending = start();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('game') });
        expect(scripts.length).toBeGreaterThan(1);
        expect(scripts.length).toBeLessThanOrEqual(41);
        expect(agent.isAgentHookRunning()).toBe(false);
    });

    it('cancels a pending retry when stopped', async () => {
        onLoad = (script) => {
            script.logHandler?.('warning', 'Hook not found!  messageController.showMessageCor');
            script.initialized();
        };
        const pending = start();
        await vi.advanceTimersByTimeAsync(100);
        agent.stopAgentHookSession();
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ success: false });
        expect(scripts).toHaveLength(1);
        expect(agent.isAgentHookRunning()).toBe(false);
        expect(events.filter(([channel]) => channel === 'texthook.agentError')).toHaveLength(0);
    });

    it('marks live text as receiving and ignores messages from an unloaded attempt', async () => {
        onLoad = (script, attempt) => {
            if (attempt === 1) {
                script.logHandler?.('warning', 'Hook not found!  messageController.showMessageCor');
            }
            script.initialized();
        };
        const pending = start();
        await vi.advanceTimersByTimeAsync(500);
        await pending;
        scripts[0].send({ cmd: 'copy', text: 'stale attempt' });
        scripts.at(-1)!.send({ cmd: 'copy', text: 'new dialogue' });
        expect(text).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'new dialogue' }));
        expect(agent.getAgentHookRuntimeStatus()).toMatchObject({ agentPhase: 'receiving', sessionId: expect.any(String) });
        const output = events.filter(([channel]) => channel === 'texthook.text').at(-1)![1];
        expect(output.sessionId).toBe(agent.getAgentHookRuntimeStatus()?.sessionId);
    });
});
