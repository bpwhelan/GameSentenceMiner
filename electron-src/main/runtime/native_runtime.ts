/** Private pipe client. No sockets, subprocesses, retry queues or lifecycle timers. */
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let transport: any;
function native() {
    return transport ??= require(path.join(process.env.GSM_APP_ROOT || process.cwd(), 'desktop-runtime/transport.cjs'));
}
export function runtimeCall<T = any>(action: string, params: unknown = {}): Promise<T> { return native().call('runtime.call', { action, params }); }
export function runtimeSync<T = any>(action: string, params: unknown = {}): T { return native().callSync('runtime.call', { action, params }); }
export function runtimeEvents(listener: (event: string, data: any) => void): () => void {
    const handler = (message: any) => { if (message.type === 'native-runtime') listener(message.event, message.data); };
    native().events.on('message', handler);
    return () => native().events.off('message', handler);
}

export function backendCall<T = any>(action: string, params: unknown = {}): Promise<T> { return native().call('backend.call', { action, params }); }
export function backendSync<T = any>(action: string, params: unknown = {}): T { return native().callSync('backend.call', { action, params }); }
export function backendEvents(listener: (event: string, data: any) => void): () => void {
    const handler = (message: any) => { if (message.type === 'native-backend') listener(message.event, message.data); };
    native().events.on('message', handler);
    return () => native().events.off('message', handler);
}
