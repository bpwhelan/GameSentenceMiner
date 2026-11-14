import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ call: vi.fn(), sync: vi.fn(), listener: null as any }));
vi.mock('./native_runtime.js', () => ({ runtimeCall: native.call, runtimeSync: native.sync, runtimeEvents: (fn: any) => { native.listener = fn; return () => {}; } }));
import { ProcessManager } from './process_manager.js';
beforeEach(() => { vi.clearAllMocks(); native.call.mockResolvedValue(null); native.sync.mockReturnValue({ state: 'stopped', pid: null }); });
function manager(blocked = false) { return new ProcessManager({ baseEnv: () => ({ PATH: 'base', EXISTING: 'yes' }), launchBlocked: () => blocked, resolveExecutable: () => 'named-python' }); }
it('passes resolved OCR configuration to Rust without spawning a Node child', async () => {
    const pm = manager(); pm.register({ id: 'ocr', buildCommand: () => ({ command: 'python', args: ['-m', 'gsm_ocr'] }), env: () => ({ EXTRA: 'yes' }), priority: () => 'low', gracefulStop: { topic: 'ocr.command', data: { stop: true }, timeoutMs: 1000 } });
    await pm.start('ocr'); expect(native.call).toHaveBeenCalledWith('process.start', expect.objectContaining({ id: 'ocr', command: 'named-python', args: ['-m', 'gsm_ocr'], env: { PATH: 'base', EXISTING: 'yes', EXTRA: 'yes' }, priority: 'low' }));
    const state = vi.fn(), ready = vi.fn(); pm.on('state-changed', state); pm.on('ready', ready);
    native.listener('process.state', { id: 'ocr', state: 'ready' }); expect(state).toHaveBeenCalledWith('ocr', 'ready'); expect(ready).toHaveBeenCalledWith('ocr');
});
it('does not launch during updates and only stops registered processes', async () => {
    const pm = manager(true); pm.register({ id: 'ocr', buildCommand: () => ({ command: 'python', args: [] }) });
    await pm.start('ocr'); expect(native.call).not.toHaveBeenCalled();
    await pm.stopAll(); expect(native.call).toHaveBeenCalledExactlyOnceWith('process.stop', { id: 'ocr' });
});
it('awaits native shutdown before asking for a replacement', async () => {
    const pm = manager(); pm.register({ id: 'ocr', buildCommand: () => ({ command: 'python', args: [] }) });
    let finish!: () => void; native.call.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const restart = pm.restart('ocr', { gracefulStopData: { reason: 'switch' } });
    expect(native.call).toHaveBeenCalledTimes(1); finish(); await restart;
    expect(native.call.mock.calls.map(call => call[0])).toEqual(['process.stop', 'process.start']);
});
