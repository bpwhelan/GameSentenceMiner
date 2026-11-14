import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as any[], options: [] as any[], load: () => Promise.resolve(), quit: null as null | (() => void) }));
const nativeCall = vi.hoisted(() => vi.fn(async () => null));
vi.mock('node:module', () => ({ createRequire: () => () => ({ call: nativeCall }) }));
vi.mock('electron', () => ({
    app: { once: vi.fn((_event, callback) => { state.quit = callback; }) },
    BrowserWindow: class {
        destroyed = false;
        constructor(options: unknown) { state.windows.push(this); state.options.push(options); }
        loadURL = vi.fn(() => state.load());
        isDestroyed = () => this.destroyed;
        destroy = vi.fn(() => { this.destroyed = true; });
        webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn(async () => {}) });
    },
}));
beforeEach(() => { vi.resetModules(); state.windows = []; state.options = []; state.quit = null; state.load = () => Promise.resolve(); });

describe('Tauri notification sound player', () => {
    it('sends tones and normalized volume directly to the native host', async () => {
        vi.stubEnv('GSM_NATIVE_SERVICE', '1');
        try {
            const { playNotificationSound } = await import('./notification_sound.js');
            const { NOTIFICATION_TONES } = await import('../../shared/notifications.js');
            await playNotificationSound('soft-ping', 0);
            await expect(playNotificationSound('invalid' as any, 10)).rejects.toThrow('Unknown');
            await playNotificationSound('pause-resume', 15.3);
            expect(nativeCall).toHaveBeenCalledExactlyOnceWith('notification.play-sound', {
                tones: NOTIFICATION_TONES['pause-resume'], volume: 15,
            });
            expect(state.windows).toEqual([]);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe('Electron notification sound player', () => {
    it('waits for one hidden, non-focusing audio window and reuses it for concurrent events', async () => {
        let finish!: () => void;
        state.load = () => new Promise<void>((resolve) => { finish = resolve; });
        const { playNotificationSound } = await import('./notification_sound.js');
        const first = playNotificationSound('soft-ping', 15);
        const second = playNotificationSound('chime', 9);
        expect(state.windows).toHaveLength(1);
        expect(state.windows[0].webContents.executeJavaScript).not.toHaveBeenCalled();
        expect(state.options[0]).toMatchObject({ show: false, focusable: false, skipTaskbar: true,
            webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, sandbox: true, nodeIntegration: false } });
        finish(); await Promise.all([first, second]);
        expect(state.windows[0].webContents.executeJavaScript).toHaveBeenCalledTimes(2);
    });

    it('validates sound IDs and leaves the audio window unopened at zero volume', async () => {
        const { playNotificationSound } = await import('./notification_sound.js');
        await playNotificationSound('soft-ping', 0);
        await expect(playNotificationSound('invalid' as any, 10)).rejects.toThrow('Unknown');
        expect(state.windows).toEqual([]);
    });

    it('recovers from a failed page load and from an audio renderer crash', async () => {
        const { playNotificationSound } = await import('./notification_sound.js');
        state.load = () => Promise.reject(new Error('load failed'));
        await expect(playNotificationSound('soft-ping', 15)).rejects.toThrow('load failed');
        expect(state.windows[0].destroyed).toBe(true);
        state.load = () => Promise.resolve();
        await playNotificationSound('soft-ping', 15);
        state.windows[1].webContents.emit('render-process-gone');
        await playNotificationSound('bell', 15);
        expect(state.windows).toHaveLength(3);
    });

    it('destroys its window on quit and prevents late notifications from reopening it', async () => {
        const { playNotificationSound } = await import('./notification_sound.js');
        await playNotificationSound('soft-ping', 15);
        state.quit!();
        expect(state.windows[0].destroyed).toBe(true);
        await expect(playNotificationSound('soft-ping', 15)).rejects.toThrow('shutting down');
        expect(state.windows).toHaveLength(1);
    });
});
