import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ notification: null as any, options: null as any }));
vi.mock('electron', () => ({
    shell: {},
    Notification: class extends EventEmitter {
        constructor(options: unknown) { super(); state.notification = this; state.options = options; }
        show = vi.fn();
        close = vi.fn();
    },
}));
vi.mock('./main.js', () => ({ getIconPath: () => 'gsm.ico' }));
import { sendNotificationFromPython } from './notifications.js';

beforeEach(() => { state.notification = null; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('pending review startup notification', () => {
    it.each(['click', 'action'])('opens the queue from %s without opening it automatically', (event) => {
        const open = vi.fn();
        sendNotificationFromPython({ type: 'PendingSessionReviews', message: '3 cards waiting for review.', count: 3 }, open);
        expect(state.notification.show).toHaveBeenCalledOnce();
        expect(state.options.title).toBe('Anki reviews pending');
        expect(state.options.body).toContain('3 cards');
        if (process.platform === 'win32' || process.platform === 'darwin') {
            expect(state.options.actions).toEqual([{ type: 'button', text: 'Review cards' }]);
        }
        expect(open).not.toHaveBeenCalled();
        state.notification.emit(event, { actionIndex: 0 });
        expect(open).toHaveBeenCalledOnce();
    });
});
