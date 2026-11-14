/** Text acknowledgement/retry storage belongs to Rust. This only delivers UI callbacks. */
import { runtimeCall, runtimeSync, runtimeEvents } from './native_runtime.js';
export interface TextIngressPayload {
    text: string;
    source: string;
    sourceInstance?: string;
    sourceDisplayName?: string;
    capturedAt?: number | string;
    emittedAt?: number | string;
    observationId?: string;
    sourceSequence?: number;
    revisionWindowMs?: number;
    mergeFragments?: boolean;
    copyToClipboard?: boolean;
    [key: string]: unknown;
}

export interface TextIngressAck {
    status: 'accepted' | 'duplicate' | 'stale_excluded' | 'backpressured' | 'rejected';
    observation_id: string;
    line_id?: string | null;
    stream_sequence?: number | null;
    revision?: number | null;
    reason?: string;
    raw_text?: string;
    processed_text?: string;
}


const callbacks = new Map<string, (ack: TextIngressAck) => void>();
let listening = false;
export function submitTextObservation(payload: TextIngressPayload, onAck?: (ack: TextIngressAck) => void): string {
    if (!listening) {
        listening = true;
        runtimeEvents((event, data) => {
            if (event !== 'text.ack') return;
            const callback = callbacks.get(data.id); callbacks.delete(data.id);
            try { callback?.(data.ack); } catch (error) { console.warn('[TextIngress] preview callback failed:', error); }
        });
    }
    const id = runtimeSync<string>('text.submit', payload);
    if (onAck) callbacks.set(id, onAck);
    return id;
}
export function clearPendingTextObservations(): void { callbacks.clear(); runtimeSync('text.clear'); }
export function getPendingTextObservationCount(): number { return runtimeSync('text.count'); }
