import { randomUUID } from 'node:crypto';

import { bus } from './bus_client.js';

const TEXT_INGRESS_TOPIC = 'text.ingress.v2';
const MAX_UNACKED = 256;
const RETRY_DELAYS_MS = [50, 100, 200, 400];

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
}

interface PendingObservation {
    payload: TextIngressPayload;
    retryIndex: number;
    timer: NodeJS.Timeout | null;
}

const pending = new Map<string, PendingObservation>();

function scheduleRetry(observationId: string): void {
    const entry = pending.get(observationId);
    if (!entry) return;
    const delay = RETRY_DELAYS_MS[Math.min(entry.retryIndex, RETRY_DELAYS_MS.length - 1)];
    entry.retryIndex += 1;
    entry.timer = setTimeout(() => void deliver(observationId), delay);
}

async function deliver(observationId: string): Promise<void> {
    const entry = pending.get(observationId);
    if (!entry) return;
    if (!bus.isConnected('backend')) {
        scheduleRetry(observationId);
        return;
    }
    try {
        const ack = await bus.request<TextIngressAck>('backend', TEXT_INGRESS_TOPIC, entry.payload, 350);
        if (ack.status === 'backpressured') {
            scheduleRetry(observationId);
            return;
        }
        pending.delete(observationId);
    } catch {
        scheduleRetry(observationId);
    }
}

export function submitTextObservation(payload: TextIngressPayload): string {
    const observationId = payload.observationId || randomUUID();
    const now = Date.now();
    if (pending.size >= MAX_UNACKED) {
        console.warn(`[TextIngress] rejected observation ${observationId}: unacknowledged outbox is full`);
        return observationId;
    }
    pending.set(observationId, {
        payload: {
            ...payload,
            observationId,
            emittedAt: payload.emittedAt ?? now,
            capturedAt: payload.capturedAt ?? now,
        },
        retryIndex: 0,
        timer: null,
    });
    void deliver(observationId);
    return observationId;
}

export function clearPendingTextObservations(): void {
    for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
    }
    pending.clear();
}

export function getPendingTextObservationCount(): number {
    return pending.size;
}
