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
import { sendGamePrivilegeWarningNotification } from './notifications.js';

beforeEach(() => {
    vi.useFakeTimers();
    state.supported = true;
    state.notification = null;
    const testProcess = Object.create(process);
    Object.defineProperty(testProcess, 'platform', { value: 'win32' });
    vi.stubGlobal('process', testProcess);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('game administrator notification', () => {
    it('explains the mismatch and opens GSM on click without an automatic close timer', async () => {
        const onClick = vi.fn();
        const dispose = sendGamePrivilegeWarningNotification('game.exe', onClick);
        expect(state.options).toMatchObject({ icon: 'gsm.ico', title: 'Restart GSM as administrator', silent: false });
        expect(state.options.body).toContain('game.exe is running as administrator, but GSM is not');
        expect(state.options.body).toContain('may be affected');
        expect(state.notification.show).toHaveBeenCalledOnce();
        expect(onClick).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(state.notification.close).not.toHaveBeenCalled();
        state.notification.emit('click');
        expect(onClick).toHaveBeenCalledOnce();
        dispose();
    });

    it('removes the notification and its click handler when the warning is cleared', () => {
        const onClick = vi.fn();
        const dispose = sendGamePrivilegeWarningNotification('game.exe', onClick);
        dispose();
        expect(state.notification.close).toHaveBeenCalledOnce();
        state.notification.emit('click');
        expect(onClick).not.toHaveBeenCalled();
    });

    it('does not create a notification if Windows notifications are unavailable', () => {
        state.supported = false;
        const dispose = sendGamePrivilegeWarningNotification('game.exe', vi.fn());
        expect(state.notification).toBeNull();
        expect(dispose).not.toThrow();
    });
});
