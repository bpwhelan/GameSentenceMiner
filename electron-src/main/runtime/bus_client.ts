/**
 * Main-process facade over the MessageBroker singleton.
 *
 * Other main modules import { bus } and call subscribe/handle/publish/request
 * without touching the broker class directly. `main` is an in-process client, so
 * these calls never go over a socket — they dispatch straight through the broker.
 *
 * Lifecycle (startBus/stopBus) is owned here and driven from main.ts during app
 * init / quit. The resolved port + token are exposed via getBusConnectInfo() so
 * spawned children can be told where to connect (see process_manager.ts).
 */

import { BrokerStartInfo, MessageBroker } from './message_bus.js';
import type { BusMessage } from './bus_protocol.js';

let broker: MessageBroker | null = null;
let connectInfo: BrokerStartInfo | null = null;

export async function startBus(options?: { host?: string; port?: number; token?: string }): Promise<BrokerStartInfo> {
    if (broker && connectInfo) {
        return connectInfo;
    }
    broker = new MessageBroker(options);
    connectInfo = await broker.start();
    console.log(`[MessageBus] broker listening on ${options?.host ?? '127.0.0.1'}:${connectInfo.port}`);
    return connectInfo;
}

export async function stopBus(): Promise<void> {
    const current = broker;
    broker = null;
    connectInfo = null;
    if (current) {
        await current.stop();
    }
}

export function getBroker(): MessageBroker {
    if (!broker) {
        throw new Error('Message bus not started. Call startBus() during app init first.');
    }
    return broker;
}

export function getBusConnectInfo(): BrokerStartInfo | null {
    return connectInfo;
}

/** Ergonomic API for main modules. All methods are no-ops-safe before startBus(). */
export const bus = {
    subscribe(topic: string, handler: (msg: BusMessage) => void): () => void {
        return getBroker().subscribe(topic, handler);
    },
    handle(topic: string, handler: (msg: BusMessage) => unknown | Promise<unknown>): () => void {
        return getBroker().handle(topic, handler);
    },
    publish(dst: string, topic: string, data?: unknown, kind: 'event' | 'command' = 'event'): void {
        getBroker().publish(dst, topic, data, kind);
    },
    request<T = unknown>(dst: string, topic: string, data?: unknown, timeoutMs?: number): Promise<T> {
        return getBroker().request<T>(dst, topic, data, timeoutMs);
    },
    isConnected(clientId: string): boolean {
        return broker?.isClientConnected(clientId) ?? false;
    },
    connectedClients(): string[] {
        return broker?.connectedClients() ?? [];
    },
    on(event: 'client-connected' | 'client-disconnected' | 'message', listener: (...args: any[]) => void): () => void {
        const b = getBroker();
        b.on(event, listener);
        return () => b.off(event, listener);
    },
};
