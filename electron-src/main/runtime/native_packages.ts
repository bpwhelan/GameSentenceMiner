import {createRequire} from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
function transport() { return require(path.join(process.env.GSM_APP_ROOT || process.cwd(), 'desktop-runtime/transport.cjs')); }
export function packagesSync<T = any>(action: string, params: unknown = {}): T { return transport().callSync('packages.call', {action, params}); }
export function packagesCall<T = any>(action: string, params: unknown = {}): Promise<T> { return transport().call('packages.call', {action, params}); }
export function packageEvents(operation: string, callback: (event: string, data: any) => void): () => void {
    const listener = (message: any) => { if (message.type === 'native-packages' && message.operation === operation) callback(message.event, message.data); };
    transport().events.on('message', listener);
    return () => transport().events.off('message', listener);
}
