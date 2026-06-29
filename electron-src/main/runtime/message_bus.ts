/**
 * MessageBus broker — the single localhost WebSocket hub hosted by the Electron
 * main process. Every long-lived process (Python backend, OCR, frida agent,
 * overlay/renderer) connects as a client and addresses messages to any other
 * client by id, so e.g. OCR -> overlay is a first-class path instead of hopping
 * through bespoke stdio/ws bridges.
 *
 * Design notes:
 *  - Binds 127.0.0.1 on an ephemeral port; the resolved port + a random
 *    per-launch token are handed to children via env (see process_manager.ts).
 *  - Clients must send a `hello` carrying the token before any other frame.
 *    The hello is also what marks a process "ready" (event-driven liveness,
 *    replacing the old pid-polling).
 *  - `main` is an in-process pseudo-client: main modules publish/subscribe and
 *    answer requests directly without a socket (see bus_client.ts facade).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

import {
    BROADCAST,
    BUS_PROTOCOL_VERSION,
    BusMessage,
    HelloData,
    MAIN_CLIENT_ID,
    isBusMessage,
} from './bus_protocol.js';

const HELLO_TIMEOUT_MS = 10_000;
const BUFFER_TTL_MS = 15_000;
const MAX_BUFFERED_PER_CLIENT = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type MainHandler = (msg: BusMessage) => void;
type MainRequestHandler = (msg: BusMessage) => unknown | Promise<unknown>;

interface BufferedMessage {
    msg: BusMessage;
    expiresAt: number;
}

interface PendingRequest {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface ConnectedClient {
    id: string;
    socket: WebSocket;
    pid?: number;
    version?: string;
}

export interface BrokerStartInfo {
    port: number;
    token: string;
}

export class MessageBroker extends EventEmitter {
    private server: WebSocketServer | null = null;
    private readonly host: string;
    private readonly requestedPort: number;
    private resolvedPort = 0;
    private readonly authToken: string;

    private readonly clients = new Map<string, ConnectedClient>();
    private readonly buffers = new Map<string, BufferedMessage[]>();
    private readonly pending = new Map<string, PendingRequest>();
    private readonly subscribers = new Map<string, Set<MainHandler>>();
    private readonly requestHandlers = new Map<string, MainRequestHandler>();

    constructor(options: { host?: string; port?: number; token?: string } = {}) {
        super();
        this.host = options.host ?? '127.0.0.1';
        this.requestedPort = options.port ?? 0;
        this.authToken = options.token ?? randomBytes(32).toString('hex');
    }

    get port(): number {
        return this.resolvedPort;
    }

    get token(): string {
        return this.authToken;
    }

    async start(): Promise<BrokerStartInfo> {
        if (this.server) {
            return { port: this.resolvedPort, token: this.authToken };
        }

        await new Promise<void>((resolve, reject) => {
            const server = new WebSocketServer({ host: this.host, port: this.requestedPort });
            const onError = (err: Error) => {
                server.off('listening', onListening);
                reject(err);
            };
            const onListening = () => {
                server.off('error', onError);
                this.resolvedPort = (server.address() as AddressInfo).port;
                this.server = server;
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.on('connection', (socket) => this.handleConnection(socket));
        });

        return { port: this.resolvedPort, token: this.authToken };
    }

    async stop(): Promise<void> {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Message bus shutting down'));
        }
        this.pending.clear();
        this.buffers.clear();

        for (const client of this.clients.values()) {
            try {
                client.socket.close();
            } catch {
                // Best-effort during teardown.
            }
        }
        this.clients.clear();

        const server = this.server;
        this.server = null;
        if (!server) {
            return;
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // -- main-side (in-process) API ----------------------------------------

    /** Receive events/commands addressed to `main` or broadcast on a topic. */
    subscribe(topic: string, handler: MainHandler): () => void {
        let set = this.subscribers.get(topic);
        if (!set) {
            set = new Set();
            this.subscribers.set(topic, set);
        }
        set.add(handler);
        return () => {
            set?.delete(handler);
        };
    }

    /** Answer `request` frames addressed to `main` on a topic. */
    handle(topic: string, handler: MainRequestHandler): () => void {
        this.requestHandlers.set(topic, handler);
        return () => {
            if (this.requestHandlers.get(topic) === handler) {
                this.requestHandlers.delete(topic);
            }
        };
    }

    /** Send a fire-and-forget event/command from main to a target. */
    publish(
        dst: string,
        topic: string,
        data?: unknown,
        kind: 'event' | 'command' = 'event'
    ): void {
        this.route(this.envelope({ dst, topic, data, kind }));
    }

    /** Send a request from main and await the matching response. */
    request<T = unknown>(
        dst: string,
        topic: string,
        data?: unknown,
        timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
    ): Promise<T> {
        const msg = this.envelope({ dst, topic, data, kind: 'request' });
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(msg.id);
                reject(new Error(`Request "${topic}" to "${dst}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(msg.id, {
                resolve: resolve as (data: unknown) => void,
                reject,
                timer,
            });
            this.route(msg);
        });
    }

    isClientConnected(clientId: string): boolean {
        return this.clients.has(clientId);
    }

    connectedClients(): string[] {
        return [...this.clients.keys()];
    }

    // -- connection handling ------------------------------------------------

    private handleConnection(socket: WebSocket): void {
        let clientId: string | null = null;
        const helloTimer = setTimeout(() => {
            if (!clientId) {
                this.closeWithError(socket, 'Handshake timeout: no hello received');
            }
        }, HELLO_TIMEOUT_MS);

        socket.on('message', (raw) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw.toString());
            } catch {
                this.closeWithError(socket, 'Invalid JSON frame');
                return;
            }
            if (!isBusMessage(parsed)) {
                this.closeWithError(socket, 'Malformed bus message');
                return;
            }
            const msg = parsed as BusMessage;

            if (!clientId) {
                if (msg.kind !== 'hello') {
                    this.closeWithError(socket, 'Expected hello as first frame');
                    return;
                }
                const hello = (msg.data ?? {}) as HelloData;
                if (hello.token !== this.authToken) {
                    this.closeWithError(socket, 'Invalid token');
                    return;
                }
                clearTimeout(helloTimer);
                clientId = msg.src;
                this.registerClient({
                    id: clientId,
                    socket,
                    pid: hello.pid,
                    version: hello.version,
                });
                this.sendRaw(socket, this.envelope({ dst: clientId, topic: 'bus.welcome', kind: 'ack' }));
                return;
            }

            // Ensure src can't be spoofed once identified.
            msg.src = clientId;
            this.route(msg);
        });

        socket.on('close', () => {
            clearTimeout(helloTimer);
            if (clientId) {
                this.unregisterClient(clientId, socket);
            }
        });
        socket.on('error', () => {
            // 'close' will follow; nothing extra to do.
        });
    }

    private registerClient(client: ConnectedClient): void {
        const existing = this.clients.get(client.id);
        if (existing && existing.socket !== client.socket) {
            // Reconnect: drop the stale socket and re-associate by id.
            try {
                existing.socket.close();
            } catch {
                // ignore
            }
        }
        this.clients.set(client.id, client);
        this.flushBuffer(client.id);
        this.emit('client-connected', client.id, { pid: client.pid, version: client.version });
    }

    private unregisterClient(clientId: string, socket: WebSocket): void {
        const current = this.clients.get(clientId);
        if (current && current.socket === socket) {
            this.clients.delete(clientId);
            this.emit('client-disconnected', clientId);
        }
    }

    // -- routing ------------------------------------------------------------

    private route(msg: BusMessage): void {
        this.emit('message', msg);

        // Responses to a main-issued request resolve the pending promise.
        if (msg.kind === 'response' && msg.dst === MAIN_CLIENT_ID && msg.corr) {
            const pending = this.pending.get(msg.corr);
            if (pending) {
                this.pending.delete(msg.corr);
                clearTimeout(pending.timer);
                if (msg.ok === false) {
                    pending.reject(new Error(msg.error || 'Request failed'));
                } else {
                    pending.resolve(msg.data);
                }
                return;
            }
        }

        if (msg.dst === BROADCAST) {
            for (const client of this.clients.values()) {
                if (client.id !== msg.src) {
                    this.sendRaw(client.socket, msg);
                }
            }
            this.dispatchToMain(msg);
            return;
        }

        if (msg.dst === MAIN_CLIENT_ID) {
            this.dispatchToMain(msg);
            return;
        }

        const target = this.clients.get(msg.dst);
        if (target) {
            this.sendRaw(target.socket, msg);
        } else {
            this.bufferForClient(msg.dst, msg);
        }
    }

    private dispatchToMain(msg: BusMessage): void {
        if (msg.kind === 'request') {
            const handler = this.requestHandlers.get(msg.topic);
            if (!handler) {
                this.route(
                    this.envelope({
                        dst: msg.src,
                        topic: msg.topic,
                        kind: 'response',
                        corr: msg.id,
                        ok: false,
                        error: `No main handler for "${msg.topic}"`,
                    })
                );
                return;
            }
            Promise.resolve()
                .then(() => handler(msg))
                .then((data) => {
                    this.route(
                        this.envelope({
                            dst: msg.src,
                            topic: msg.topic,
                            kind: 'response',
                            corr: msg.id,
                            ok: true,
                            data,
                        })
                    );
                })
                .catch((err: unknown) => {
                    this.route(
                        this.envelope({
                            dst: msg.src,
                            topic: msg.topic,
                            kind: 'response',
                            corr: msg.id,
                            ok: false,
                            error: err instanceof Error ? err.message : String(err),
                        })
                    );
                });
            return;
        }

        const handlers = this.subscribers.get(msg.topic);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(msg);
                } catch (err) {
                    console.error(`[MessageBus] main subscriber for "${msg.topic}" threw:`, err);
                }
            }
        }
    }

    // -- buffering ----------------------------------------------------------

    private bufferForClient(clientId: string, msg: BusMessage): void {
        // Only buffer deliverable kinds; never queue responses (the requester is gone).
        if (msg.kind === 'response') {
            return;
        }
        const now = Date.now();
        let queue = this.buffers.get(clientId);
        if (!queue) {
            queue = [];
            this.buffers.set(clientId, queue);
        }
        queue.push({ msg, expiresAt: now + BUFFER_TTL_MS });
        while (queue.length > MAX_BUFFERED_PER_CLIENT) {
            queue.shift();
        }
    }

    private flushBuffer(clientId: string): void {
        const queue = this.buffers.get(clientId);
        if (!queue) {
            return;
        }
        this.buffers.delete(clientId);
        const now = Date.now();
        const client = this.clients.get(clientId);
        if (!client) {
            return;
        }
        for (const entry of queue) {
            if (entry.expiresAt >= now) {
                this.sendRaw(client.socket, entry.msg);
            }
        }
    }

    // -- helpers ------------------------------------------------------------

    private envelope(partial: Partial<BusMessage> & { dst: string; topic: string; kind: BusMessage['kind'] }): BusMessage {
        return {
            v: BUS_PROTOCOL_VERSION,
            id: randomUUID(),
            src: MAIN_CLIENT_ID,
            ...partial,
        };
    }

    private sendRaw(socket: WebSocket, msg: BusMessage): void {
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            socket.send(JSON.stringify(msg));
        } catch (err) {
            console.error('[MessageBus] failed to send frame:', err);
        }
    }

    private closeWithError(socket: WebSocket, reason: string): void {
        try {
            this.sendRaw(
                socket,
                this.envelope({ dst: 'unknown', topic: 'bus.error', kind: 'error', error: reason })
            );
            socket.close(1008, reason.slice(0, 120));
        } catch {
            // ignore
        }
    }
}
