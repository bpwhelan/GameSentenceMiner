import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createPortalBindPendingTracker } = require(
    path.resolve(process.cwd(), 'GSM_Overlay/portal_bind_state.js')
) as {
    createPortalBindPendingTracker: (options?: {
        watchdogMs?: number;
        schedule?: typeof setTimeout;
        cancel?: typeof clearTimeout;
        onChange?: (pending: boolean, details: Record<string, unknown>) => void;
        onTimeout?: () => void;
    }) => {
        handle: (message: { state?: string; ok?: boolean }) => boolean;
        reset: (reason?: string) => boolean;
        isPending: () => boolean;
    };
};

describe('portal bind pending tracker', () => {
    it('resets pending state when an input-server socket closes', () => {
        const changes: Array<[boolean, Record<string, unknown>]> = [];
        const tracker = createPortalBindPendingTracker({
            onChange: (pending, details) => changes.push([pending, details]),
        });

        expect(tracker.handle({ state: 'pending' })).toBe(true);
        expect(tracker.isPending()).toBe(true);
        expect(tracker.reset('manual-hotkey-socket-close')).toBe(true);
        expect(tracker.isPending()).toBe(false);
        expect(changes.at(-1)).toEqual([
            false,
            { reason: 'manual-hotkey-socket-close', reset: true },
        ]);
    });

    it('fails safe after the watchdog deadline and ignores duplicate pending messages', () => {
        vi.useFakeTimers();
        try {
            const onTimeout = vi.fn();
            const onChange = vi.fn();
            const tracker = createPortalBindPendingTracker({
                watchdogMs: 100,
                onChange,
                onTimeout,
            });

            expect(tracker.handle({ state: 'pending' })).toBe(true);
            expect(tracker.handle({ state: 'pending' })).toBe(false);
            vi.advanceTimersByTime(100);

            expect(tracker.isPending()).toBe(false);
            expect(onTimeout).toHaveBeenCalledOnce();
            expect(onChange).toHaveBeenLastCalledWith(false, {
                reason: 'watchdog-timeout',
                timedOut: true,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels the watchdog after a resolved message', () => {
        vi.useFakeTimers();
        try {
            const onTimeout = vi.fn();
            const tracker = createPortalBindPendingTracker({ watchdogMs: 100, onTimeout });
            tracker.handle({ state: 'pending' });
            expect(tracker.handle({ state: 'resolved', ok: true })).toBe(true);
            vi.advanceTimersByTime(100);
            expect(onTimeout).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
