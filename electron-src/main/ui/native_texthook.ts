/** Compatibility transport for the native CLI engine owner. No engine process,
 * pipe decoding, hook selection or buffering belongs in this module. */
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let transport: any;
let onEvent: ((channel: string, data: any) => void) | undefined;
function native() {
    if (!transport) {
        transport = require(path.join(process.env.GSM_APP_ROOT || process.cwd(), 'desktop-runtime/transport.cjs'));
        transport.events.on('message', (message: any) => {
            if (message.type === 'texthook-controller') onEvent?.(message.event, message.data);
        });
    }
    return transport;
}
export function configureNativeTextHookEvents(callback: (channel: string, data: any) => void): void {
    onEvent = callback;
    native();
}
export function nativeTextHook<T = any>(action: string, params: unknown = {}): Promise<T> {
    return native().call('texthook.command', { action, params });
}
export function nativeTextHookSync<T = any>(action: string, params: unknown = {}): T {
    return native().callSync('texthook.command', { action, params });
}
