import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
    configureHoshidictsControlChannel,
    getHoshidictsControlPort,
    HOSHIDICTS_CONTROL_METHODS,
    HoshidictsControlChannel,
    startHoshidictsControlChannel,
    stopHoshidictsControlChannel,
} from './control_channel.js';

const channels: HoshidictsControlChannel[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
    for (const socket of sockets.splice(0)) {
        socket.terminate();
    }
    await Promise.all(channels.splice(0).map(async (channel) => channel.stop()));
    await stopHoshidictsControlChannel();
});

async function openSocket(port: number): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return socket;
}

async function openBrowserOriginSocket(port: number): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: 'https://example.test',
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return socket;
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        socket.once('message', (raw) => {
            try {
                resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
            } catch (error) {
                reject(error);
            }
        });
        socket.once('error', reject);
    });
}

function nextClose(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => {
        socket.once('close', (code) => resolve(code));
    });
}

async function readyReader(channel: HoshidictsControlChannel): Promise<WebSocket> {
    const port = channel.port;
    if (!port) throw new Error('Test channel did not start.');
    const socket = await openSocket(port);
    const ready = nextFrame(socket);
    socket.send(JSON.stringify({ version: 1, kind: 'reader-ready' }));
    await expect(ready).resolves.toMatchObject({
        version: 1,
        kind: 'reader-ready',
    });
    return socket;
}

function createChannel(
    handlers: Partial<ConstructorParameters<typeof HoshidictsControlChannel>[0]> = {}
): HoshidictsControlChannel {
    const channel = new HoshidictsControlChannel({
        openSettings: handlers.openSettings ?? (() => ({ opened: true })),
        addCustomEntry: handlers.addCustomEntry ?? (() => ({ saved: true })),
        onReaderReady: handlers.onReaderReady,
    });
    channels.push(channel);
    return channel;
}

describe('Hoshidicts loopback control channel', () => {
    it('binds atomically to loopback and starts idempotently', async () => {
        const channel = createChannel();

        const [firstPort, secondPort] = await Promise.all([
            channel.start(),
            channel.start(),
        ]);

        expect(firstPort).toBeGreaterThan(0);
        expect(secondPort).toBe(firstPort);
        expect(channel.port).toBe(firstPort);
        await expect(openSocket(firstPort)).resolves.toBeInstanceOf(WebSocket);
    });

    it('handles settings and custom-entry requests on its narrow method set', async () => {
        const opened = vi.fn(async () => ({ opened: true }));
        const added = vi.fn(async (value: unknown) => ({ saved: value }));
        const channel = createChannel({
            openSettings: opened,
            addCustomEntry: added,
        });
        const port = await channel.start();
        const settingsSocket = await openSocket(port);
        const settingsResponse = nextFrame(settingsSocket);
        settingsSocket.send(JSON.stringify({
            version: 1,
            kind: 'request',
            id: 'settings-1',
            method: HOSHIDICTS_CONTROL_METHODS.openSettings,
        }));

        await expect(settingsResponse).resolves.toMatchObject({
            kind: 'response',
            id: 'settings-1',
            ok: true,
            data: { opened: true },
        });
        expect(opened).toHaveBeenCalledOnce();

        const rejectedResponse = nextFrame(settingsSocket);
        settingsSocket.send(JSON.stringify({
            version: 1,
            kind: 'request',
            id: 'custom-from-settings',
            method: HOSHIDICTS_CONTROL_METHODS.addCustomEntry,
            data: { term: '猫' },
        }));
        await expect(rejectedResponse).resolves.toMatchObject({
            kind: 'response',
            id: 'custom-from-settings',
            ok: false,
        });

        const reader = await readyReader(channel);
        const customResponse = nextFrame(reader);
        const entry = { term: '猫', reading: 'ねこ', definition: 'cat' };
        reader.send(JSON.stringify({
            version: 1,
            kind: 'request',
            id: 'custom-1',
            method: HOSHIDICTS_CONTROL_METHODS.addCustomEntry,
            data: entry,
        }));
        await expect(customResponse).resolves.toMatchObject({
            kind: 'response',
            id: 'custom-1',
            ok: true,
            data: { saved: entry },
        });
        expect(added).toHaveBeenCalledWith(entry);
    });

    it('rejects browser-originated connections', async () => {
        const channel = createChannel();
        const port = await channel.start();
        const socket = await openBrowserOriginSocket(port);

        await expect(nextClose(socket)).resolves.toBe(1008);
    });

    it('correlates reader updates and rejects pending work on disconnect', async () => {
        const channel = createChannel();
        await channel.start();
        const reader = await readyReader(channel);

        const requestFrame = nextFrame(reader);
        const request = channel.requestReader(
            HOSHIDICTS_CONTROL_METHODS.readerPreferences,
            { lookupMode: 'hover' },
            1000
        );
        const delivered = await requestFrame;
        expect(delivered).toMatchObject({
            kind: 'request',
            method: HOSHIDICTS_CONTROL_METHODS.readerPreferences,
            data: { lookupMode: 'hover' },
        });
        reader.send(JSON.stringify({
            version: 1,
            kind: 'response',
            id: delivered.id,
            ok: true,
            data: { applied: true },
        }));
        await expect(request).resolves.toEqual({ applied: true });

        const pendingFrame = nextFrame(reader);
        const pending = channel.requestReader(
            HOSHIDICTS_CONTROL_METHODS.audioProfile,
            { version: 1, autoPlay: true, sources: [] },
            1000
        );
        await pendingFrame;
        reader.close();
        await expect(pending).rejects.toThrow('closed');
        expect(channel.isReaderConnected()).toBe(false);
    });

    it('keeps the replacement reader registered after the stale socket closes', async () => {
        const channel = createChannel();
        await channel.start();
        const first = await readyReader(channel);
        const second = await readyReader(channel);

        await nextClose(first);
        expect(channel.isReaderConnected()).toBe(true);

        const frame = nextFrame(second);
        const request = channel.requestReader(
            HOSHIDICTS_CONTROL_METHODS.audioProfile,
            { version: 1, autoPlay: false, sources: [] },
            1000
        );
        const delivered = await frame;
        second.send(JSON.stringify({
            version: 1,
            kind: 'response',
            id: delivered.id,
            ok: true,
            data: { applied: true },
        }));
        await expect(request).resolves.toEqual({ applied: true });
    });

    it('rejects malformed and oversized frames and stops with idle sockets open', async () => {
        const channel = createChannel();
        const port = await channel.start();

        const malformed = await openSocket(port);
        const malformedClose = nextClose(malformed);
        malformed.send('{');
        await expect(malformedClose).resolves.toBe(1003);

        const oversized = await openSocket(port);
        const oversizedClose = nextClose(oversized);
        oversized.send('x'.repeat(1024 * 1024 + 1));
        await expect(oversizedClose).resolves.toBe(1009);

        await openSocket(port);
        await expect(channel.stop()).resolves.toBeUndefined();
        expect(channel.port).toBeNull();
    });

    it('supports stop, restart, and reconfiguration of the singleton lifecycle', async () => {
        configureHoshidictsControlChannel({
            openSettings: () => ({ opened: true }),
            addCustomEntry: () => ({ saved: true }),
        });
        const firstPort = await startHoshidictsControlChannel();
        expect(getHoshidictsControlPort()).toBe(firstPort);
        await stopHoshidictsControlChannel();
        expect(getHoshidictsControlPort()).toBeNull();

        const restartedPort = await startHoshidictsControlChannel();
        expect(restartedPort).toBeGreaterThan(0);
        await stopHoshidictsControlChannel();

        configureHoshidictsControlChannel({
            openSettings: () => ({ opened: 'new' }),
            addCustomEntry: () => ({ saved: 'new' }),
        });
        await expect(startHoshidictsControlChannel()).resolves.toBeGreaterThan(0);
    });

    it('waits for an in-flight stop before starting a replacement server', async () => {
        const channel = createChannel();

        const firstStart = channel.start();
        const stopping = channel.stop();
        const replacementStart = channel.start();

        await firstStart;
        await stopping;
        const replacementPort = await replacementStart;
        expect(channel.port).toBe(replacementPort);
        await expect(openSocket(replacementPort)).resolves.toBeInstanceOf(
            WebSocket
        );
    });
});
