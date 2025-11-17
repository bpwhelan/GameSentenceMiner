import { Notification, shell, NotificationAction } from 'electron';
import { getIconPath } from './main.js';

// Utility logger (replace with your own logger if needed)
const logger = {
    info: console.log,
    error: console.error,
};

export enum NotificationType {
    AnkiCardUpdated = 'Anki Card Updated',
    AnkiCardOpened = 'Anki Card Opened',
    AnkiBrowserOpened = 'Anki Browser Opened',
    ScreenshotSaved = 'Screenshot Saved',
    AudioGenerated = 'Audio Generated',
    CheckOBS = 'Check OBS',
    Error = 'Error',
}

// Show a notification, optionally with a click handler
function sendNotification(
    type: NotificationType,
    message: string,
    timeout: number = 5000,
    onClick?: () => void
) {
    const notif = new Notification({
        icon: getIconPath(),
        title: type,
        body: message,
        silent: false,
    });

    if (onClick) {
        notif.on('click', onClick);
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
export function sendNotificationFromPython(data: any) {
    const { type, message, noteId } = data;
    switch (NotificationType[type as keyof typeof NotificationType]) {
        case NotificationType.AnkiCardUpdated:
            sendNoteUpdated(message, noteId);
            break;
        case NotificationType.ScreenshotSaved:
            sendScreenshotSaved(message);
            break;
        case NotificationType.AudioGenerated:
            sendAudioGeneratedNotification(message);
            break;
        case NotificationType.CheckOBS:
            sendCheckObsNotification(message);
            break;
        case NotificationType.Error:
            sendErrorNotification(message);
            break;
        default:
            console.warn(`Unknown notification type: ${type}`);
    }
}

// Notification helpers
export function sendNoteUpdated(noteID: number | string, noteId?: number) {
    const parsed = noteId ?? (typeof noteID === 'number' ? noteID : parseInt(String(noteID)));
    sendNotification(
        NotificationType.AnkiCardUpdated,
        `Audio and/or Screenshot added to note: ${noteID}\n\n Click here to open card.`,
        5000,
        () => {
            if (parsed && !Number.isNaN(parsed)) {
                openAnkiCard(parsed);
            }
        }
    );
}

export function sendScreenshotUpdated(noteID: number) {
    sendNotification(
        NotificationType.AnkiCardUpdated,
        `Screenshot updated on note: ${noteID}`,
        5000,
        () => openAnkiCard(noteID)
    );
}

export function sendScreenshotSaved(path: string) {
    sendNotification(NotificationType.ScreenshotSaved, `Screenshot saved to: ${path}`, 5000, () =>
        shell.openPath(path)
    );
}

export function sendAudioGeneratedNotification(audioPath: string) {
    sendNotification(
        NotificationType.AudioGenerated,
        `Audio trimmed and placed at ${audioPath}`,
        5000,
        () => shell.openPath(audioPath)
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

export function sendErrorNotification(message: string) {
    sendNotification(NotificationType.Error, message, 5000);
}
