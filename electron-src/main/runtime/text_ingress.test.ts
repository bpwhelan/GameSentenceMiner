import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ sync: vi.fn(), listener: null as any }));
vi.mock('./native_runtime.js', () => ({ runtimeCall: vi.fn(), runtimeSync: native.sync, runtimeEvents: (fn: any) => { native.listener = fn; return () => {}; } }));
import { clearPendingTextObservations, submitTextObservation } from './text_ingress.js';
beforeEach(() => { clearPendingTextObservations(); vi.clearAllMocks(); native.sync.mockReturnValue('observation'); });
it('delivers the native filtered acknowledgement once', () => {
    const onAck = vi.fn(); submitTextObservation({ text: '日本語', source: 'texthook' }, onAck);
    const ack = { status: 'accepted', processed_text: '日本語' };
    native.listener('text.ack', { id: 'observation', ack }); native.listener('text.ack', { id: 'observation', ack });
    expect(onAck).toHaveBeenCalledExactlyOnceWith(ack);
});
it('does not deliver old previews after clearing the native outbox', () => {
    const onAck = vi.fn(); submitTextObservation({ text: 'old', source: 'texthook' }, onAck); clearPendingTextObservations();
    native.listener('text.ack', { id: 'observation', ack: { status: 'accepted' } }); expect(onAck).not.toHaveBeenCalled();
});
it('surfaces native queue admission errors instead of silently dropping text', () => {
    native.sync.mockImplementationOnce(() => { throw Error('Text queue is full'); });
    expect(() => submitTextObservation({ text: 'overflow', source: 'texthook' })).toThrow('Text queue is full');
});
