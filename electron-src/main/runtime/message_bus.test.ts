import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { MessageBroker } from './message_bus.js';
import { BusMessage, MAIN_CLIENT_ID } from './bus_protocol.js';

const TOKEN = 'test-token';

let broker: MessageBroker;
let port: number;
const openClients: TestClient[] = [];

/**
 * A test client that buffers every received frame in an inbox so assertions
 * never race the network (welcome acks can arrive before a per-call listener
 * would be attached).
 */
class TestClient {
    readonly inbox: BusMessage[] = [];
    private readonly waiters: Array<{ predicate: (m: BusMessage) => boolean; resolve: (m: BusMessage) => void }> = [];

    constructor(public readonly id: string, public readonly socket: WebSocket) {
        socket.on('message', (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as BusMessage;
            this.inbox.push(msg);
            for (let i = this.waiters.length - 1; i >= 0; i--) {
                if (this.waiters[i].predicate(msg)) {
                    this.waiters.splice(i, 1)[0].resolve(msg);
                }
            }
        });
    }

    waitFor(predicate: (m: BusMessage) => boolean): Promise<BusMessage> {
        const existing = this.inbox.find(predicate);
        if (existing) {
            return Promise.resolve(existing);
        }
        return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
    }

    waitTopic(topic: string): Promise<BusMessage> {
        return this.waitFor((m) => m.topic === topic);
    }

    send(msg: Partial<BusMessage> & { dst: string; kind: BusMessage['kind']; topic: string }): void {
        this.socket.send(JSON.stringify({ v: 1, id: `m-${Math.random()}`, src: this.id, ...msg }));
    }
}

beforeEach(async () => {
    broker = new MessageBroker({ token: TOKEN });
    const info = await broker.start();
    port = info.port;
});

afterEach(async () => {
    for (const client of openClients.splice(0)) {
        try {
            client.socket.close();
        } catch {
            // ignore
        }
    }
    await broker.stop();
});

async function connectClient(id: string, token = TOKEN): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new TestClient(id, socket);
    openClients.push(client);
    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    socket.send(
        JSON.stringify({
            v: 1,
            id: `hello-${id}`,
            src: id,
            dst: MAIN_CLIENT_ID,
            kind: 'hello',
            topic: 'bus.hello',
            data: { token },
        })
    );
    return client;
}

describe('MessageBroker', () => {
    it('accepts a client after a valid hello and reports it connected', async () => {
        const client = await connectClient('ocr');
        await client.waitTopic('bus.welcome');
        expect(broker.isClientConnected('ocr')).toBe(true);
        expect(broker.connectedClients()).toContain('ocr');
    });

    it('rejects a client with a bad token', async () => {
        const client = await connectClient('ocr', 'wrong');
        await new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
        expect(broker.isClientConnected('ocr')).toBe(false);
    });

    it('routes a directed message to the addressed client', async () => {
        const ocr = await connectClient('ocr');
        const overlay = await connectClient('overlay');
        await ocr.waitTopic('bus.welcome');
        await overlay.waitTopic('bus.welcome');

        const received = overlay.waitTopic('ocr.result');
        ocr.send({ dst: 'overlay', kind: 'event', topic: 'ocr.result', data: { text: 'hi' } });

        const msg = await received;
        expect(msg.src).toBe('ocr');
        expect((msg.data as { text: string }).text).toBe('hi');
    });

    it('broadcasts to all clients except the sender', async () => {
        const a = await connectClient('a');
        const b = await connectClient('b');
        await a.waitTopic('bus.welcome');
        await b.waitTopic('bus.welcome');

        const bGot = b.waitTopic('ping');
        a.send({ dst: '*', kind: 'event', topic: 'ping', data: 1 });
        const msg = await bGot;
        expect(msg.data).toBe(1);
    });

    it('delivers main-subscribed events and answers main-handled requests', async () => {
        const events: BusMessage[] = [];
        broker.subscribe('client.event', (m) => events.push(m));
        broker.handle('client.ask', (m) => ({ echo: (m.data as { n: number }).n * 2 }));

        const client = await connectClient('c');
        await client.waitTopic('bus.welcome');

        client.send({ dst: MAIN_CLIENT_ID, kind: 'event', topic: 'client.event', data: { hi: true } });
        const response = client.waitFor((m) => m.kind === 'response');
        client.send({ dst: MAIN_CLIENT_ID, kind: 'request', topic: 'client.ask', data: { n: 21 } });

        const reply = await response;
        expect(reply.ok).toBe(true);
        expect((reply.data as { echo: number }).echo).toBe(42);
        expect(events.some((e) => e.topic === 'client.event')).toBe(true);
    });

    it('resolves a main-issued request to a client', async () => {
        const client = await connectClient('worker');
        await client.waitTopic('bus.welcome');
        client.socket.on('message', (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as BusMessage;
            if (msg.kind === 'request' && msg.topic === 'do.work') {
                client.send({
                    dst: MAIN_CLIENT_ID,
                    kind: 'response',
                    topic: 'do.work',
                    corr: msg.id,
                    data: { done: true },
                });
            }
        });

        const result = await broker.request<{ done: boolean }>('worker', 'do.work', { x: 1 });
        expect(result.done).toBe(true);
    });

    it('times out a request to an unreachable client', async () => {
        await expect(broker.request('ghost', 'noop', {}, 100)).rejects.toThrow(/timed out/);
    });

    it('buffers messages for a not-yet-connected client and flushes on connect', async () => {
        broker.publish('late', 'queued.msg', { seq: 1 });
        broker.publish('late', 'queued.msg', { seq: 2 });

        const late = await connectClient('late');
        const first = await late.waitFor((m) => m.topic === 'queued.msg' && (m.data as { seq: number }).seq === 1);
        const second = await late.waitFor((m) => m.topic === 'queued.msg' && (m.data as { seq: number }).seq === 2);
        expect(first.data).toEqual({ seq: 1 });
        expect(second.data).toEqual({ seq: 2 });
    });

    it('re-associates a client id on reconnect', async () => {
        const first = await connectClient('rejoin');
        await first.waitTopic('bus.welcome');
        expect(broker.isClientConnected('rejoin')).toBe(true);

        const second = await connectClient('rejoin');
        await second.waitTopic('bus.welcome');
        expect(broker.isClientConnected('rejoin')).toBe(true);

        const received = second.waitTopic('after.reconnect');
        broker.publish('rejoin', 'after.reconnect', { ok: true });
        const msg = await received;
        expect(msg.data).toEqual({ ok: true });
    });
});
