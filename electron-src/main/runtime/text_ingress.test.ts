import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const busMock = vi.hoisted(() => ({
    isConnected: vi.fn(() => false),
    request: vi.fn(),
}));

vi.mock('./bus_client.js', () => ({ bus: busMock }));

import {
    clearPendingTextObservations,
    getPendingTextObservationCount,
    submitTextObservation,
} from './text_ingress.js';

describe('text ingress outbox', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        busMock.isConnected.mockReturnValue(false);
        busMock.request.mockReset();
        clearPendingTextObservations();
    });

    afterEach(() => {
        clearPendingTextObservations();
        vi.useRealTimers();
    });

    it('retains an observation until the backend connects', async () => {
        submitTextObservation({ text: 'during startup', source: 'texthook', observationId: 'startup-line' });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(getPendingTextObservationCount()).toBe(1);

        busMock.isConnected.mockReturnValue(true);
        busMock.request.mockResolvedValue({ status: 'accepted', observation_id: 'startup-line' });
        await vi.advanceTimersByTimeAsync(400);

        expect(busMock.request).toHaveBeenCalledOnce();
        expect(getPendingTextObservationCount()).toBe(0);
    });
});
