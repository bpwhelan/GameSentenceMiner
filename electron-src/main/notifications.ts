import { Notification, shell, NotificationAction } from 'electron';

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
    const url = 'http://localhost:8765';
    const headers = { 'Content-Type': 'application/json' };

    const data = {
        action: 'guiBrowse',
        version: 6,
        params: {
            query: query ? query : `nid:${noteId}`,
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
            await fetch(url, { method: 'POST', headers, body: JSON.stringify(blankReqData) });
        }
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) });
        if (response.ok) {
            logger.info(`Opened Anki browser with query: ${query || `nid:${noteId}`}`);
            sendNotification(
                NotificationType.AnkiBrowserOpened,
                `Opened Anki browser for ${query ? `query: ${query}` : `note ID: ${noteId}`}`,
                5000,
                () => shell.openExternal(url)
            );
        } else {
            logger.error(`Failed to open Anki note with ID ${noteId}`);
            sendNotification(
                NotificationType.Error,
                `Failed to open Anki note with ID ${noteId}`,
                5000
            );
        }
    } catch (e) {
        logger.error(`Error connecting to AnkiConnect: ${e}`);
        sendNotification(NotificationType.Error, `Error connecting to AnkiConnect: ${e}`, 5000);
    }
}

// Open Anki card editor for a note
export async function openAnkiCard(noteId: number) {
    const url = 'http://localhost:8765';
    const headers = { 'Content-Type': 'application/json' };

    const data = {
        action: 'guiEditNote',
        version: 6,
        params: { note: noteId },
    };

    try {
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) });
        if (response.ok) {
            logger.info(`Opened Anki note with ID ${noteId}`);
            sendNotification(
                NotificationType.AnkiCardOpened,
                `Opened Anki note with ID ${noteId}`,
                5000,
                () => shell.openExternal(url)
            );
        } else {
            logger.error(`Failed to open Anki note with ID ${noteId}`);
            sendNotification(
                NotificationType.Error,
                `Failed to open Anki note with ID ${noteId}`,
                5000
            );
        }
    } catch (e) {
        logger.error(`Error connecting to AnkiConnect: ${e}`);
        sendNotification(NotificationType.Error, `Error connecting to AnkiConnect: ${e}`, 5000);
    }
}

// Take in a message.data and parse the json
export function sendNotificationFromPython(data: any) {
    const { type, message } = data;
    switch (NotificationType[type as keyof typeof NotificationType]) {
        case NotificationType.AnkiCardUpdated:
            sendNoteUpdated(message);
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
export function sendNoteUpdated(noteID: number) {
    sendNotification(
        NotificationType.AnkiCardUpdated,
        `Audio and/or Screenshot added to note: ${noteID}`,
        5000,
        () => openAnkiCard(noteID)
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
