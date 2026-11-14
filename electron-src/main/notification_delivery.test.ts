import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeNotificationPreferences } from '../shared/notifications.js';

const state = vi.hoisted(() => ({ options: [] as any[], notifications: [] as any[] }));
vi.mock('electron', () => ({
    shell: { openPath: vi.fn() },
    Notification: class extends EventEmitter {
        constructor(options: unknown) { super(); state.options.push(options); state.notifications.push(this); }
        show = vi.fn(); close = vi.fn();
    },
}));
vi.mock('./main.js', () => ({ getIconPath: () => 'gsm.ico' }));
import { configureNotificationDelivery, sendAudioGeneratedNotification, sendNoteUpdated, sendNotificationFromPython } from './notifications.js';
import { shell } from 'electron';

const playSound = vi.fn(async () => {});
beforeEach(() => {
    vi.useFakeTimers(); state.options = []; state.notifications = [];
    configureNotificationDelivery({ getPreferences: () => normalizeNotificationPreferences(null), playSound });
});
afterEach(() => vi.useRealTimers());

describe('notification delivery', () => {
    it('delivers card errors with their own title and settings independently of other categories', () => {
        configureNotificationDelivery({ getPreferences: () => normalizeNotificationPreferences({ categories: {
            confirmation: { mode: 'off' }, cardError: { mode: 'both', sound: 'double-tap' }, appAlert: { mode: 'off' },
        } }) });
        sendNoteUpdated(123);
        sendNotificationFromPython({ type: 'Error', message: 'General app error' });
        sendNotificationFromPython({ type: 'AnkiEnhancementFailed', message: 'Could not upload audio to Anki' });
        expect(state.options).toHaveLength(1);
        expect(state.options[0]).toMatchObject({ title: 'Card error', body: 'Could not upload audio to Anki', silent: true });
        expect(playSound).toHaveBeenCalledExactlyOnceWith('double-tap', 15);
    });
    it('plays a quiet confirmation without constructing a desktop notification', () => {
        sendNoteUpdated(123);
        expect(playSound).toHaveBeenCalledExactlyOnceWith('soft-ping', 15);
        expect(state.options).toEqual([]);
    });

    it('checks settings for direct helpers and IPC messages, including stale queued messages', () => {
        configureNotificationDelivery({ getPreferences: () => normalizeNotificationPreferences({ categories: { confirmation: { mode: 'off' } } }) });
        sendNoteUpdated(123);
        sendAudioGeneratedNotification('C:/audio.wav');
        sendNotificationFromPython({ type: 'AnkiCardUpdated', message: 'Audio added', noteId: 123 });
        sendNotificationFromPython({ type: 'AudioGenerated', message: 'Audio trimmed', path: 'C:/audio.wav' });
        expect(playSound).not.toHaveBeenCalled();
        expect(state.options).toEqual([]);
    });

    it('preserves Python messages and note click actions with a silent custom-sound banner', () => {
        configureNotificationDelivery({ getPreferences: () => normalizeNotificationPreferences({ events: { AnkiCardUpdated: { mode: 'both', sound: 'bubble' } } }) });
        sendNotificationFromPython({ type: 'AnkiCardUpdated', message: 'Screenshot updated on note: 123', noteId: 123 });
        expect(state.options[0]).toMatchObject({ body: 'Screenshot updated on note: 123', silent: true });
        expect(state.options[0].body).not.toContain('NaN');
        expect(playSound).toHaveBeenCalledExactlyOnceWith('bubble', 15);
        expect(state.notifications[0].listenerCount('click')).toBe(1);
    });

    it('opens a structured audio path instead of the formatted notification text', () => {
        configureNotificationDelivery({ getPreferences: () => normalizeNotificationPreferences({ events: { AudioGenerated: { mode: 'banner' } } }) });
        sendNotificationFromPython({ type: 'AudioGenerated', message: 'Audio trimmed and placed at C:/audio.wav', path: 'C:/audio.wav' });
        expect(state.options[0].body).toBe('Audio trimmed and placed at C:/audio.wav');
        state.notifications[0].emit('click');
        expect(shell.openPath).toHaveBeenCalledWith('C:/audio.wav');
    });
});
