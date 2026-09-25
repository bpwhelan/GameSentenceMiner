import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ supported: true, notification: null as any, options: null as any }));
vi.mock('electron', () => ({
    shell: {},
    Notification: class extends EventEmitter {
        static isSupported() { return state.supported; }
        constructor(options: unknown) { super(); state.notification = this; state.options = options; }
        show = vi.fn();
        close = vi.fn();
    },
}));
vi.mock('./main.js', () => ({ getIconPath: () => 'gsm.ico' }));
import { sendAgentRestartNotification } from './notifications.js';

beforeEach(() => { state.supported = true; state.notification = null; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('agent restart warning', () => {
    it('waits for a native notification to be shown before confirming delivery', async () => {
        const displayed = vi.fn();
        const warning = sendAgentRestartNotification('OCR fix is ready', 10).then(displayed);
        expect(state.options.body).toContain('10 seconds');
        expect(state.options.body).toContain('OCR fix is ready');
        expect(state.notification.show).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1000);
        expect(displayed).not.toHaveBeenCalled();
        state.notification.emit('show');
        await warning;
        expect(displayed).toHaveBeenCalledOnce();
    });

    it('fails instead of silently restarting when notifications are unsupported', async () => {
        state.supported = false;
        await expect(sendAgentRestartNotification('Changes ready', 5)).rejects.toThrow(/notification/i);
    });

    it('reports a delivery failure or timeout', async () => {
        const failed = sendAgentRestartNotification('Changes ready', 5);
        state.notification.emit('failed', {}, 'Desktop notifications disabled');
        await expect(failed).rejects.toThrow(/disabled/);
        const timeout = expect(sendAgentRestartNotification('Changes ready', 5)).rejects.toThrow(/notification/i);
        await vi.advanceTimersByTimeAsync(10_000);
        await timeout;
    });
});
