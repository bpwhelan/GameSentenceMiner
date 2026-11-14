import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import {
    isNotificationSound, normalizeNotificationVolume, NOTIFICATION_TONES, synthesizeNotificationSound,
    type NotificationSound, type NotificationTone,
} from '../../shared/notifications.js';

const require = createRequire(import.meta.url);

let audioWindow: BrowserWindow | null = null;
let loading: Promise<void> | null = null;
let quitting = false;
let cleanupRegistered = false;

export function disposeNotificationAudio(): void {
    quitting = true;
    const window = audioWindow;
    audioWindow = null;
    loading = null;
    if (window && !window.isDestroyed()) window.destroy();
}

async function getAudioWindow(): Promise<BrowserWindow> {
    if (quitting) throw new Error('Notification audio is shutting down.');
    if (!cleanupRegistered) {
        // A before-quit request can be cancelled while GSM saves/stops OBS.
        app.once('will-quit', disposeNotificationAudio);
        cleanupRegistered = true;
    }
    if (!audioWindow || audioWindow.isDestroyed()) {
        const window = new BrowserWindow({
            show: false, skipTaskbar: true, focusable: false, width: 1, height: 1,
            webPreferences: {
                nodeIntegration: false, contextIsolation: true, sandbox: true,
                backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
            },
        });
        audioWindow = window;
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"><script>
            const synthesize = ${synthesizeNotificationSound.toString()};
            const context = new AudioContext();
            window.playNotificationSound = async (tones, volume) => {
                await context.resume();
                synthesize(context, tones, volume);
            };
        </script>`;
        loading = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((error) => {
            if (audioWindow === window) { audioWindow = null; loading = null; }
            if (!window.isDestroyed()) window.destroy();
            throw error;
        });
        window.webContents.on('render-process-gone', () => {
            if (audioWindow === window) { audioWindow = null; loading = null; }
            if (!window.isDestroyed()) window.destroy();
        });
    }
    const window = audioWindow;
    await loading;
    if (!window || window.isDestroyed()) throw new Error('Notification audio is unavailable.');
    return window;
}

/** Runs independently of the main renderer, including while GSM is hidden in the tray. */
export async function playNotificationSound(sound: NotificationSound, volume: number): Promise<void> {
    if (!isNotificationSound(sound)) throw new Error('Unknown notification sound.');
    const normalizedVolume = normalizeNotificationVolume(volume);
    if (normalizedVolume === 0) return;
    const tones = NOTIFICATION_TONES[sound];
    if (process.env.GSM_NATIVE_SERVICE === '1') {
        const transport: { call(method: string, params: { tones: NotificationTone[]; volume: number }): Promise<unknown> } =
            require('../../../desktop-runtime/transport.cjs');
        await transport.call('notification.play-sound', { tones, volume: normalizedVolume });
        return;
    }
    const window = await getAudioWindow();
    await window.webContents.executeJavaScript(`window.playNotificationSound(${JSON.stringify(tones)}, ${normalizedVolume})`);
}
