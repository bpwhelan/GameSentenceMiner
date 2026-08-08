import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

export const HOSHIDICTS_CONTROL_HOST = '127.0.0.1';
export const HOSHIDICTS_CONTROL_ENV = 'GSM_HOSHIDICTS_CONTROL_PORT';
export const HOSHIDICTS_CONTROL_METHODS = {
    openSettings: 'hoshidicts.openSettings',
    readerPreferences: 'hoshidicts.readerPreferences',
    audioProfile: 'hoshidicts.audioProfile',
    addCustomEntry: 'hoshidicts.addCustomEntry',
} as const;

const CONTROL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

type ControlMethod =
    (typeof HOSHIDICTS_CONTROL_METHODS)[keyof typeof HOSHIDICTS_CONTROL_METHODS];

interface ControlFrame {
    version: number;
    kind: 'reader-ready' | 'request' | 'response';
    id?: string;
    method?: ControlMethod | string;
    data?: unknown;
    ok?: boolean;
    error?: string;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export interface HoshidictsControlChannelHandlers {
    openSettings: () => unknown | Promise<unknown>;
    addCustomEntry: (value: unknown) => unknown | Promise<unknown>;
    onReaderReady?: () => void;
}

export function isHoshidictsLoopbackAddress(
    address: string | undefined
): boolean {
    return (
        address === HOSHIDICTS_CONTROL_HOST ||
        address === '::1' ||
        address === `::ffff:${HOSHIDICTS_CONTROL_HOST}`
    );
}

function parseControlFrame(raw: RawData): ControlFrame | null {
    let parsed: unknown;
    try {
        let bytes: Buffer;
        if (Array.isArray(raw)) {
            bytes = Buffer.concat(raw);
        } else if (raw instanceof ArrayBuffer) {
            bytes = Buffer.from(new Uint8Array(raw));
        } else {
            bytes = Buffer.from(raw);
        }
        parsed = JSON.parse(bytes.toString());
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const frame = parsed as Partial<ControlFrame>;
    if (
        frame.version !== CONTROL_VERSION ||
        (frame.kind !== 'reader-ready' &&
            frame.kind !== 'request' &&
            frame.kind !== 'response')
    ) {
        return null;
    }
    return frame as ControlFrame;
}

export class HoshidictsControlChannel {
    private server: WebSocketServer | null = null;
    private startPromise: Promise<number> | null = null;
    private stopPromise: Promise<void> | null = null;
    private resolvedPort = 0;
    private readerSocket: WebSocket | null = null;
    private readonly pending = new Map<string, PendingRequest>();

    constructor(
        private readonly handlers: HoshidictsControlChannelHandlers,
        private readonly requestedPort = 0
    ) {}

    get port(): number | null {
        return this.resolvedPort > 0 ? this.resolvedPort : null;
    }

    isReaderConnected(): boolean {
        return this.readerSocket?.readyState === WebSocket.OPEN;
    }

    async start(): Promise<number> {
        if (this.stopPromise) {
            await this.stopPromise;
        }
        if (this.server && this.resolvedPort > 0) {
            return this.resolvedPort;
        }
        if (this.startPromise) {
            return await this.startPromise;
        }

        const server = new WebSocketServer({
            host: HOSHIDICTS_CONTROL_HOST,
            port: this.requestedPort,
            maxPayload: MAX_CONTROL_FRAME_BYTES,
        });
        this.server = server;
        server.on('connection', (socket, request) => {
            if (!isHoshidictsLoopbackAddress(request.socket.remoteAddress)) {
                socket.terminate();
                return;
            }
            if (request.headers.origin) {
                socket.close(
                    1008,
                    'Browser-originated Hoshidicts control connections are unsupported'
                );
                return;
            }
            this.handleConnection(socket);
        });

        this.startPromise = new Promise<number>((resolve, reject) => {
            const onError = (error: Error): void => {
                server.off('listening', onListening);
                if (this.server === server) {
                    this.server = null;
                    this.resolvedPort = 0;
                }
                reject(error);
            };
            const onListening = (): void => {
                server.off('error', onError);
                server.on('error', (error) => {
                    console.warn(
                        '[Hoshidicts] Loopback control channel reported an error.',
                        error
                    );
                });
                this.resolvedPort = (server.address() as AddressInfo).port;
                resolve(this.resolvedPort);
            };
            server.once('error', onError);
            server.once('listening', onListening);
        });

        try {
            return await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async stop(): Promise<void> {
        if (this.stopPromise) {
            return await this.stopPromise;
        }
        this.stopPromise = this.stopChannel();
        try {
            await this.stopPromise;
        } finally {
            this.stopPromise = null;
        }
    }

    private async stopChannel(): Promise<void> {
        if (this.startPromise) {
            try {
                await this.startPromise;
            } catch {
                // Startup already reset the channel state.
            }
        }

        this.rejectPending(new Error('Hoshidicts control channel is stopping.'));
        this.readerSocket = null;
        const server = this.server;
        this.server = null;
        this.resolvedPort = 0;
        if (!server) {
            return;
        }
        for (const socket of server.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    requestReader(
        method:
            | typeof HOSHIDICTS_CONTROL_METHODS.readerPreferences
            | typeof HOSHIDICTS_CONTROL_METHODS.audioProfile,
        data: unknown,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
    ): Promise<unknown> {
        const socket = this.readerSocket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(
                new Error('Hoshidicts reader control channel is unavailable.')
            );
        }

        const id = randomUUID();
        const frame: ControlFrame = {
            version: CONTROL_VERSION,
            kind: 'request',
            id,
            method,
            data,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new Error(
                        `Hoshidicts reader request "${method}" timed out.`
                    )
                );
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                socket.send(JSON.stringify(frame));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private handleConnection(socket: WebSocket): void {
        socket.on('message', (raw, isBinary) => {
            if (isBinary) {
                socket.close(
                    1003,
                    'Binary Hoshidicts control frames are unsupported'
                );
                return;
            }
            const frame = parseControlFrame(raw);
            if (!frame) {
                socket.close(1003, 'Invalid Hoshidicts control frame');
                return;
            }
            if (frame.kind === 'reader-ready') {
                this.registerReader(socket);
                return;
            }
            if (frame.kind === 'response') {
                this.handleReaderResponse(socket, frame);
                return;
            }
            this.handleClientRequest(socket, frame);
        });
        socket.on('close', () => {
            if (this.readerSocket === socket) {
                this.readerSocket = null;
                this.rejectPending(
                    new Error('Hoshidicts reader control channel closed.')
                );
            }
        });
        socket.on('error', () => {
            // The close event owns cleanup.
        });
    }

    private registerReader(socket: WebSocket): void {
        const previous = this.readerSocket;
        if (previous && previous !== socket) {
            previous.close(1000, 'Hoshidicts reader replaced');
            this.rejectPending(
                new Error('Hoshidicts reader control channel was replaced.')
            );
        }
        this.readerSocket = socket;
        this.send(socket, {
            version: CONTROL_VERSION,
            kind: 'reader-ready',
        });
        this.handlers.onReaderReady?.();
    }

    private handleReaderResponse(socket: WebSocket, frame: ControlFrame): void {
        if (
            socket !== this.readerSocket ||
            typeof frame.id !== 'string' ||
            !this.pending.has(frame.id)
        ) {
            return;
        }
        const pending = this.pending.get(frame.id)!;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok === false) {
            pending.reject(
                new Error(
                    typeof frame.error === 'string'
                        ? frame.error
                        : 'Hoshidicts reader request failed.'
                )
            );
        } else {
            pending.resolve(frame.data);
        }
    }

    private handleClientRequest(socket: WebSocket, frame: ControlFrame): void {
        if (typeof frame.id !== 'string' || typeof frame.method !== 'string') {
            socket.close(1003, 'Invalid Hoshidicts control request');
            return;
        }

        let operation: Promise<unknown>;
        if (frame.method === HOSHIDICTS_CONTROL_METHODS.openSettings) {
            operation = Promise.resolve().then(() => this.handlers.openSettings());
        } else if (
            frame.method === HOSHIDICTS_CONTROL_METHODS.addCustomEntry &&
            socket === this.readerSocket
        ) {
            operation = Promise.resolve().then(() =>
                this.handlers.addCustomEntry(frame.data)
            );
        } else {
            operation = Promise.reject(
                new Error(
                    `Unsupported Hoshidicts control request "${frame.method}".`
                )
            );
        }

        operation.then(
            (data) =>
                this.send(socket, {
                    version: CONTROL_VERSION,
                    kind: 'response',
                    id: frame.id,
                    ok: true,
                    data,
                }),
            (error) =>
                this.send(socket, {
                    version: CONTROL_VERSION,
                    kind: 'response',
                    id: frame.id,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                })
        );
    }

    private send(socket: WebSocket, frame: ControlFrame): void {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(frame));
        }
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}

let defaultChannel: HoshidictsControlChannel | null = null;

export function configureHoshidictsControlChannel(
    handlers: HoshidictsControlChannelHandlers
): void {
    if (defaultChannel?.port) {
        throw new Error('Hoshidicts control channel is already running.');
    }
    defaultChannel = new HoshidictsControlChannel(handlers);
}

export async function startHoshidictsControlChannel(): Promise<number> {
    if (!defaultChannel) {
        throw new Error('Hoshidicts control channel is not configured.');
    }
    return await defaultChannel.start();
}

export async function stopHoshidictsControlChannel(): Promise<void> {
    await defaultChannel?.stop();
}

export function getHoshidictsControlPort(): number | null {
    return defaultChannel?.port ?? null;
}

export function isHoshidictsReaderControlConnected(): boolean {
    return defaultChannel?.isReaderConnected() ?? false;
}

export function requestHoshidictsReader(
    method:
        | typeof HOSHIDICTS_CONTROL_METHODS.readerPreferences
        | typeof HOSHIDICTS_CONTROL_METHODS.audioProfile,
    data: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<unknown> {
    if (!defaultChannel) {
        return Promise.reject(
            new Error('Hoshidicts control channel is unavailable.')
        );
    }
    return defaultChannel.requestReader(method, data, timeoutMs);
}
