import { Notification, shell } from 'electron';

// Utility logger (replace with your own logger if needed)
const logger = {
    info: console.log,
    error: console.error,
};

// Show a notification, optionally with a click handler
function sendNotification(title: string, message: string, timeout: number = 5000, onClick?: () => void) {
    const notif = new Notification({
        title,
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
    const url = "http://localhost:8765";
    const headers = { 'Content-Type': 'application/json' };

    const data = {
        action: "guiBrowse",
        version: 6,
        params: {
            query: query ? query : `nid:${noteId}`,
        }
    };

    try {
        if (query) {
            // Blank request to force browser refresh
            const blankReqData = {
                action: "guiBrowse",
                version: 6,
                params: { query: "nid:1" }
            };
            await fetch(url, { method: 'POST', headers, body: JSON.stringify(blankReqData) });
        }
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) });
        if (response.ok) {
            logger.info(`Opened Anki browser with query: ${query || `nid:${noteId}`}`);
            sendNotification(
                "Anki Browser Opened",
                `Opened Anki browser for ${query ? `query: ${query}` : `note ID: ${noteId}`}`,
                5000,
                () => shell.openExternal(url)
            );
        } else {
            logger.error(`Failed to open Anki note with ID ${noteId}`);
            sendNotification("Error", `Failed to open Anki note with ID ${noteId}`, 5000);
        }
    } catch (e) {
        logger.error(`Error connecting to AnkiConnect: ${e}`);
        sendNotification("Error", `Error connecting to AnkiConnect: ${e}`, 5000);
    }
}

// Open Anki card editor for a note
export async function openAnkiCard(noteId: number) {
    const url = "http://localhost:8765";
    const headers = { 'Content-Type': 'application/json' };

    const data = {
        action: "guiEditNote",
        version: 6,
        params: { note: noteId }
    };

    try {
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) });
        if (response.ok) {
            logger.info(`Opened Anki note with ID ${noteId}`);
            sendNotification(
                "Anki Card Opened",
                `Opened Anki note with ID ${noteId}`,
                5000,
                () => shell.openExternal(url)
            );
        } else {
            logger.error(`Failed to open Anki note with ID ${noteId}`);
            sendNotification("Error", `Failed to open Anki note with ID ${noteId}`, 5000);
        }
    } catch (e) {
        logger.error(`Error connecting to AnkiConnect: ${e}`);
        sendNotification("Error", `Error connecting to AnkiConnect: ${e}`, 5000);
    }
}

// Notification helpers
export function sendNoteUpdated(tango: string) {
    sendNotification("Anki Card Updated", `Audio and/or Screenshot added to note: ${tango}`, 5000);
}

export function sendScreenshotUpdated(tango: string) {
    sendNotification("Anki Card Updated", `Screenshot updated on note: ${tango}`, 5000);
}

export function sendScreenshotSaved(path: string) {
    sendNotification("Screenshot Saved", `Screenshot saved to: ${path}`, 5000, () => shell.openPath(path));
}

export function sendAudioGeneratedNotification(audioPath: string) {
    sendNotification("Audio Trimmed", `Audio trimmed and placed at ${audioPath}`, 5000, () => shell.openPath(audioPath));
}

export function sendCheckObsNotification(reason: string) {
    sendNotification("OBS Replay Invalid", `Check OBS Settings! Reason: ${reason}`, 5000);
}

export function sendErrorNoAnkiUpdate() {
    sendNotification("Error", "Anki Card not updated, Check Console for Reason!", 5000);
}

export function sendErrorNotification(message: string) {
    sendNotification("Error", message, 5000);
}