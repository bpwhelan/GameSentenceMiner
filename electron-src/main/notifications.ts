import { Notification, shell } from 'electron';
import { getIconPath } from './main.js';
import {
    NOTIFICATION_EVENT_IDS, normalizeNotificationPreferences, resolveNotificationDelivery,
    type NotificationPreferences, type NotificationSound,
} from '../shared/notifications.js';

interface NotificationDeliveryDependencies {
    getPreferences: () => NotificationPreferences;
    playSound: (sound: NotificationSound, volume: number) => Promise<void>;
}
const delivery: NotificationDeliveryDependencies = {
    getPreferences: () => normalizeNotificationPreferences(null),
    playSound: async () => {},
};

export function configureNotificationDelivery(dependencies: Partial<NotificationDeliveryDependencies>): void {
    Object.assign(delivery, dependencies);
}

// Utility logger (replace with your own logger if needed)
const logger = {
    info: console.log,
    error: console.error,
};

export enum NotificationType {
    AnkiCardUpdated = 'Anki Card Updated',
    AnkiEnhancementFailed = 'Card error',
    AnkiCardOpened = 'Anki Card Opened',
    AnkiBrowserOpened = 'Anki Browser Opened',
    ScreenshotSaved = 'Screenshot Saved',
    AudioGenerated = 'Audio Generated',
    CheckOBS = 'Check OBS',
    Error = 'Error',
    GSMReady = 'GSM Ready',
    GSMCrashed = 'GSM crashed',
    GSMStillRunning = 'GSM Still Running',
    GSMTextIntakePaused = 'GSM Text Intake Paused',
    GSMTextIntakeResumed = 'GSM Text Intake Resumed',
    OCRPaused = 'OCR paused',
    OCRResumed = 'OCR resumed',
    PendingSessionReviews = 'Anki reviews pending',
}

// Show a notification, optionally with a click handler
function sendNotification(
    type: NotificationType,
    message: string,
    timeout: number = 5000,
    onClick?: () => void,
    actions: Array<{ text: string; onAction: () => void }> = [],
) {
    const event = NOTIFICATION_EVENT_IDS.find((key) => NotificationType[key] === type);
    if (event) {
        const preferences = delivery.getPreferences();
        const { banner, sound } = resolveNotificationDelivery(event, preferences);
        if (sound) {
            void delivery.playSound(sound, preferences.volume).catch((error) => logger.error('Notification sound failed:', error));
        }
        if (!banner) return;
    }
    const notif = new Notification({
        icon: getIconPath(),
        title: type,
        body: message,
        silent: Boolean(event),
        actions: process.platform === 'win32' || process.platform === 'darwin'
            ? actions.map(({ text }) => ({ type: 'button' as const, text }))
            : undefined,
    });

    if (onClick) {
        notif.on('click', onClick);
    }
    if (actions.length > 0) {
        notif.on('action', (event) => {
            actions[event.actionIndex]?.onAction();
        });
    }

    notif.show();

    // Electron notifications auto-dismiss, but you can manually close after timeout if needed
    setTimeout(() => notif.close(), timeout);
}

// Open Anki browser window for a note or query
export async function openBrowserWindow(noteId: number, query?: string) {
    const data = {
        action: 'guiBrowse',
        version: 6,
        params: {
            query: query || `nid:${noteId}`,
        },
    };

    try {
        if (query) {
            // Blank request to force browser refresh
            const blankReqData = {
                action: 'guiBrowse',
                version: 6,
                params: { query: 'nid:1' },
            };
            await invokeAnki(blankReqData);
        }
        const result = await invokeAnki(data);

        if (result) {
            if (query) {
                logger.info(`Opened Anki browser with query: ${query}`);
            } else {
                logger.info(`Opened Anki note in browser with ID ${noteId}`);
            }
        } else {
            logger.error(`Failed to open Anki note with ID ${noteId}`);
        }
    } catch (e) {
        logger.info(`Error connecting to AnkiConnect: ${e}`);
    }
}

// Open Anki card editor for a note
export async function openAnkiCard(noteId: number) {
    const data = {
        action: 'guiEditNote',
        version: 6,
        params: { note: noteId },
    };

    try {
        const result = await invokeAnki(data);

        logger.info(result);

        if (result) {
            logger.info(`Opened Anki note with ID ${noteId}`);
        } else {
            logger.error(`Failed to open Anki note with ID ${noteId}`);
        }
    } catch (e) {
        logger.info(`Error connecting to AnkiConnect: ${e}`);
    }
}

// Helper function to make AnkiConnect requests. Prefer `fetch` when available,
// otherwise fall back to Node's `http.request`. Returns parsed JSON on success
// or `null` on failure.
async function invokeAnki(data: any): Promise<any> {
    const postData = JSON.stringify(data);

    // Try fetch first (available in modern Node/Electron runtimes)
    try {
        const res = await fetch('http://localhost:8765/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: postData,
        });
        const text = await res.text();
        if (res.status === 200) {
            try {
                return JSON.parse(text);
            } catch (e) {
                return text;
            }
        } else {
            logger.error(`AnkiConnect request failed (fetch) status=${res.status} body=${text}`);
            // fallthrough to http fallback for robustness
        }
    } catch (e) {
        logger.error(`Fetch to AnkiConnect failed: ${e}`);
        return null;
    }
}

// Take in a message.data and parse the json
export function sendNotificationFromPython(data: any, openPendingReviews?: () => void) {
    const { type, message, noteId, path } = data;
    switch (NotificationType[type as keyof typeof NotificationType]) {
        case NotificationType.AnkiCardUpdated:
            sendNoteUpdated(message, noteId, message);
            break;
        case NotificationType.AnkiEnhancementFailed:
            sendAnkiEnhancementFailed(message);
            break;
        case NotificationType.ScreenshotSaved:
            sendScreenshotSaved(path, message);
            break;
        case NotificationType.AudioGenerated:
            sendAudioGeneratedNotification(path, message);
            break;
        case NotificationType.CheckOBS:
            sendNotification(NotificationType.CheckOBS, message, 5000);
            break;
        case NotificationType.Error:
            sendErrorNotification(message);
            break;
        case NotificationType.GSMReady:
            sendGSMReadyNotification(message);
            break;
        case NotificationType.PendingSessionReviews:
            sendNotification(
                NotificationType.PendingSessionReviews,
                message,
                15000,
                openPendingReviews,
                openPendingReviews ? [{ text: 'Review cards', onAction: openPendingReviews }] : [],
            );
            break;
        case NotificationType.GSMTextIntakePaused:
            sendTextIntakePausedNotification(message);
            break;
        case NotificationType.GSMTextIntakeResumed:
            sendTextIntakeResumedNotification(message);
            break;
        case NotificationType.OCRPaused:
        case NotificationType.OCRResumed:
            sendNotification(NotificationType[type as keyof typeof NotificationType], message);
            break;
        default:
            console.warn(`Unknown notification type: ${type}`);
    }
}

// Notification helpers
export function sendNoteUpdated(noteID: number | string, noteId?: number, message?: string) {
    const parsed = Number(noteId ?? noteID);
    const openCard = Number.isSafeInteger(parsed) && parsed > 0 ? () => { void openAnkiCard(parsed); } : undefined;
    sendNotification(
        NotificationType.AnkiCardUpdated,
        message || `Audio and/or Screenshot added to note: ${noteID}`,
        5000,
        openCard,
        openCard ? [{ text: 'Open Card', onAction: openCard }] : [],
    );
}

export function sendScreenshotUpdated(noteID: number) {
    const openCard = () => openAnkiCard(noteID);
    sendNotification(
        NotificationType.AnkiCardUpdated,
        `Screenshot updated on note: ${noteID}`,
        5000,
        openCard,
        [{ text: 'Open Card', onAction: openCard }],
    );
}

export function sendAnkiEnhancementFailed(message: string) {
    sendNotification(
        NotificationType.AnkiEnhancementFailed,
        message || 'Anki card enhancement failed. Check the console for details.',
        5000
    );
}

export function sendScreenshotSaved(path?: string, message?: string) {
    sendNotification(NotificationType.ScreenshotSaved, message || `Screenshot saved to: ${path}`, 5000, path ? () =>
        shell.openPath(path) : undefined
    );
}

export function sendAudioGeneratedNotification(audioPath?: string, message?: string) {
    sendNotification(
        NotificationType.AudioGenerated,
        message || `Audio trimmed and placed at ${audioPath}`,
        5000,
        audioPath ? () => shell.openPath(audioPath) : undefined
    );
}

export function sendCheckObsNotification(reason: string) {
    sendNotification(NotificationType.CheckOBS, `Check OBS Settings! Reason: ${reason}`, 5000);
}

export function sendErrorNoAnkiUpdate() {
    sendNotification(
        NotificationType.Error,
        'Anki Card not updated, Check Console for Reason!',
        5000
    );
}

export function sendGSMReadyNotification(message: string) {
    sendNotification(NotificationType.GSMReady, message, 5000);
}

export function sendGSMCrashNotification(restarting: boolean) {
    sendNotification(
        NotificationType.GSMCrashed,
        restarting
            ? 'GSM crashed. Restarting…'
            : 'GSM keeps crashing. Automatic restarts have stopped. Open GSM and check the logs.',
        8000,
    );
}

/** Keep this available in Windows Notification Center until the warning is resolved. */
export function sendGamePrivilegeWarningNotification(exeName: string, openGSM: () => void): () => void {
    if (process.platform !== 'win32' || !Notification.isSupported()) return () => {};
    const notification = new Notification({
        icon: getIconPath(),
        title: 'Restart GSM as administrator',
        body: `${exeName} is running as administrator, but GSM is not. Capture, text hooks, the overlay, or hotkeys may be affected. Click to open GSM.`,
        silent: false,
    });
    notification.once('click', openGSM);
    notification.once('failed', (_event, message) => {
        console.warn('Game administrator notification failed:', message);
    });
    notification.show();
    return () => {
        notification.removeAllListeners('click');
        notification.close();
    };
}

/** Confirm OS delivery before the restart countdown begins. */
export async function sendAgentRestartNotification(
    reason: string,
    seconds: number,
    restartNow: () => void = () => {},
    cancelRestart: () => void = () => {},
): Promise<void> {
    if (!Notification.isSupported()) {
        throw new Error('Desktop notifications are unavailable; GSM was not restarted.');
    }
    const notification = new Notification({
        icon: getIconPath(),
        title: 'GSM restarting soon',
        body: `GSM will restart in ${seconds} seconds to load new changes.\n${reason}`,
        silent: false,
        timeoutType: 'never',
        actions: process.platform === 'win32' || process.platform === 'darwin'
            ? [
                { type: 'button', text: 'Restart Now' },
                { type: 'button', text: 'Cancel Restart' },
            ]
            : undefined,
    });
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => fail('Timed out displaying the restart notification.'), 10_000);
        const fail = (message: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            notification.close();
            reject(new Error(message));
        };
        notification.once('failed', (_event, message) => fail(`Restart notification failed: ${message}`));
        notification.once('action', (event) => {
            if (event.actionIndex === 0) {
                notification.close();
                restartNow();
            } else if (event.actionIndex === 1) {
                notification.close();
                cancelRestart();
            }
        });
        notification.once('show', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            setTimeout(() => notification.close(), seconds * 1000);
            resolve();
        });
        try { notification.show(); } catch (error) {
            fail(`Restart notification failed: ${String(error)}`);
        }
    });
}

export function sendGSMStillRunningInTrayNotification() {
    sendNotification(
        NotificationType.GSMStillRunning,
        'GSM is still running in the system tray. Use the tray icon to open or exit GSM.',
        5000
    );
}

export function sendErrorNotification(message: string) {
    sendNotification(NotificationType.Error, message, 5000);
}

export function sendTextIntakePausedNotification(message: string) {
    sendNotification(
        NotificationType.GSMTextIntakePaused,
        message || 'Clipboard and websocket text intake is paused.',
        5000
    );
}

export function sendTextIntakeResumedNotification(message: string) {
    sendNotification(
        NotificationType.GSMTextIntakeResumed,
        message || 'Clipboard and websocket text intake resumed.',
        5000
    );
}
