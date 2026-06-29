/**
 * Shared wire protocol for the GSM message bus.
 *
 * One envelope is used for every direction and every transport (the Electron
 * main broker, Node clients, Python clients, and renderer clients). Keeping the
 * shape identical everywhere is what makes the bus uniform — see the broker in
 * message_bus.ts and the Python client in bus_client.py.
 */

export const BUS_PROTOCOL_VERSION = 1;

/** Well-known client ids. Long-lived processes use a stable id so the broker can
 *  re-associate them across reconnects. */
export const MAIN_CLIENT_ID = 'main';
export const BROADCAST = '*';

export type BusKind =
    | 'hello' // first frame a client sends to identify + authenticate
    | 'event' // fire-and-forget notification
    | 'command' // imperative request with no expected response
    | 'request' // expects a matching 'response'
    | 'response' // reply to a 'request' (carries `corr`)
    | 'ack' // broker acknowledgement of a hello
    | 'error'; // transport/routing level error

export interface BusMessage<T = unknown> {
    v: number;
    /** Unique id for this message (crypto.randomUUID()). */
    id: string;
    /** Sender client id. */
    src: string;
    /** Target: a client id, MAIN_CLIENT_ID, or BROADCAST. */
    dst: string;
    kind: BusKind;
    /** Routing/dispatch key, e.g. "ocr.event.result". */
    topic: string;
    data?: T;
    /** For responses: the id of the request being answered. */
    corr?: string;
    /** For responses: success flag. */
    ok?: boolean;
    /** For responses/errors: human-readable error. */
    error?: string;
}

export interface HelloData {
    pid?: number;
    version?: string;
    /** Shared per-launch token; the broker rejects mismatches. */
    token: string;
}

export function isBusMessage(value: unknown): value is BusMessage {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const msg = value as Record<string, unknown>;
    return (
        typeof msg.id === 'string' &&
        typeof msg.src === 'string' &&
        typeof msg.dst === 'string' &&
        typeof msg.kind === 'string' &&
        typeof msg.topic === 'string'
    );
}
