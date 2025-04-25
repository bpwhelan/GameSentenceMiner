import express from 'express';
import path from 'path';
import open from 'open';
import {getAssetsDir} from "../util.js";

interface EventItem {
    id: number;
    text: string;
    time: string;
    checked: boolean;
}

const events: EventItem[] = [];

export async function startWebServer(): Promise<void> {
    console.log("Starting web server...");
    const webApp = express();
    webApp.use(express.json({limit: '50mb'}));

    webApp.get('/', (_, res) => {
        res.sendFile(path.join(getAssetsDir(), 'utility.html'));
    });

    webApp.get('/data', (_, res) => {
        res.json(events);
    });

    webApp.post('/event', (req, res) => {
        const { text, time } = req.body;
        const newEvent: EventItem = {
            id: Date.now(),
            text,
            time,
            checked: false
        };
        events.push(newEvent);
        res.sendStatus(200);
    });

    webApp.post('/update', (req, res) => {
        const { id, checked } = req.body;
        const event = events.find(e => e.id === id);
        if (event) event.checked = checked;
        res.sendStatus(200);
    });

    // @ts-ignore
    webApp.post('/store-events', (req, res) => {
        const { events } = req.body;

        if (!Array.isArray(events)) {
            return res.status(400).json({ error: 'Invalid data format. Expected an array of events.' });
        }

        for (const event of events) {
            if (
                typeof event.id !== 'number' ||
                typeof event.text !== 'string' ||
                typeof event.time !== 'string' ||
                typeof event.checked !== 'boolean'
            ) {
                return res.status(400).json({ error: 'Invalid event structure.' });
            }
        }

        res.status(200).json({ message: 'Events successfully stored on server.', receivedEvents: events });
    });

    const port = 3000;
    webApp.listen(port, () => {
        console.log(`Web server running on http://localhost:${port}`);
        open(`http://localhost:${port}`); // 👈 opens default browser
    });
}
