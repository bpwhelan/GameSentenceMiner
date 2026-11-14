import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ call: vi.fn(), sync: vi.fn(), listen: vi.fn(), listener: null as any }));
vi.mock('./native_runtime.js', () => ({ runtimeCall: native.call, runtimeSync: native.sync, runtimeEvents: (fn: any) => { native.listener = fn; return native.listen; } }));
import { MessageBroker } from './message_bus.js';
beforeEach(() => { vi.clearAllMocks(); native.call.mockResolvedValue({ port: 1234, token: 'fixture' }); native.sync.mockReturnValue(['backend']); });
it('keeps the main address API while Rust owns requests and connection state', async () => {
    const broker = new MessageBroker(); await broker.start();
    expect(broker.isClientConnected('backend')).toBe(true);
    native.call.mockResolvedValueOnce({ text: '字幕' });
    expect(await broker.request('backend', 'echo', {}, 500)).toEqual({ text: '字幕' });
    expect(native.call).toHaveBeenLastCalledWith('bus.request', { dst: 'backend', topic: 'echo', data: {}, timeoutMs: 500 });
    await broker.stop(); expect(native.listen).toHaveBeenCalledOnce();
});
it('answers Python requests with correlation intact and reports missing handlers', async () => {
    const broker = new MessageBroker(); await broker.start(); broker.handle('echo', message => message.data);
    const message = { v: 1, id: 'request-7', src: 'backend', dst: 'main', kind: 'request', topic: 'echo', data: { text: '日本語' } };
    native.listener('bus.message', message); await vi.waitFor(() => expect(native.call).toHaveBeenCalledWith('bus.reply', expect.objectContaining({ corr: 'request-7', dst: 'backend', ok: true, data: message.data })));
    native.listener('bus.message', { ...message, topic: 'missing' });
    await vi.waitFor(() => expect(native.call).toHaveBeenLastCalledWith('bus.reply', expect.objectContaining({ ok: false, error: 'No main handler for "missing"' })));
});
it('forwards connection and subscribed events without subscribing twice', async () => {
    const broker = new MessageBroker(); await broker.start(); await broker.start();
    const connected = vi.fn(), event = vi.fn(); broker.on('client-connected', connected); const off = broker.subscribe('backend.event', event);
    native.listener('bus.connected', { id: 'backend', pid: 123 }); native.listener('bus.message', { kind: 'event', topic: 'backend.event', data: { ready: true } });
    expect(connected).toHaveBeenCalledOnce(); expect(event).toHaveBeenCalledOnce(); off();
    native.listener('bus.message', { kind: 'event', topic: 'backend.event' }); expect(event).toHaveBeenCalledOnce();
});
