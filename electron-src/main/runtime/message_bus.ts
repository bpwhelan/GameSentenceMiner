/** Main-address compatibility client. Rust owns the server, authentication,
 * routing, request correlation, disconnects and timeouts. */
import { EventEmitter } from 'node:events';
import { runtimeCall, runtimeSync, runtimeEvents } from './native_runtime.js';
import type { BusMessage } from './bus_protocol.js';
export interface BrokerStartInfo { port: number; token: string }
type Handler = (message: BusMessage) => unknown | Promise<unknown>;
export class MessageBroker extends EventEmitter {
    private info: BrokerStartInfo | null = null;
    private unsubscribe: (() => void) | null = null;
    private subscribers = new Map<string, Set<Handler>>();
    private handlers = new Map<string, Handler>();
    constructor(private options: { host?: string; port?: number; token?: string } = {}) { super(); }
    get port(): number { return this.info?.port ?? 0; }
    get token(): string { return this.info?.token ?? ''; }
    async start(): Promise<BrokerStartInfo> {
        if (this.info) return this.info;
        this.unsubscribe = runtimeEvents((event, data) => {
            if (event === 'bus.connected') this.emit('client-connected', data.id, { pid: data.pid, version: data.version });
            else if (event === 'bus.disconnected') this.emit('client-disconnected', data.id);
            else if (event === 'bus.message') void this.dispatch(data);
        });
        try { return this.info = await runtimeCall<BrokerStartInfo>('bus.start', this.options); }
        catch (error) { this.unsubscribe(); this.unsubscribe = null; throw error; }
    }
    async stop(): Promise<void> { await runtimeCall('bus.stop'); this.unsubscribe?.(); this.unsubscribe = null; this.info = null; }
    subscribe(topic: string, handler: Handler): () => void {
        let set = this.subscribers.get(topic); if (!set) this.subscribers.set(topic, set = new Set());
        set.add(handler); return () => { set.delete(handler); };
    }
    handle(topic: string, handler: Handler): () => void {
        this.handlers.set(topic, handler); return () => { if (this.handlers.get(topic) === handler) this.handlers.delete(topic); };
    }
    publish(dst: string, topic: string, data?: unknown, kind: 'event' | 'command' = 'event'): void {
        void runtimeCall('bus.publish', { dst, topic, data, kind }).catch(error => console.warn('[NativeBus] publish failed:', error));
    }
    request<T = unknown>(dst: string, topic: string, data?: unknown, timeoutMs = 15000): Promise<T> { return runtimeCall('bus.request', { dst, topic, data, timeoutMs }); }
    isClientConnected(client: string): boolean { return this.connectedClients().includes(client); }
    connectedClients(): string[] { return this.info ? runtimeSync('bus.clients') : []; }
    private async dispatch(message: BusMessage): Promise<void> {
        this.emit('message', message);
        if (message.kind === 'request') {
            const reply = { ...message, dst: message.src, corr: message.id, ok: true, data: undefined as unknown, error: undefined as string | undefined };
            try {
                const handler = this.handlers.get(message.topic);
                if (!handler) throw Error(`No main handler for "${message.topic}"`);
                reply.data = await handler(message);
            } catch (error) { reply.ok = false; reply.error = error instanceof Error ? error.message : String(error); }
            await runtimeCall('bus.reply', reply).catch(error => console.warn('[NativeBus] reply failed:', error));
        } else for (const handler of this.subscribers.get(message.topic) ?? []) {
            try { await handler(message); } catch (error) { console.warn('[NativeBus] subscriber failed:', error); }
        }
    }
}
