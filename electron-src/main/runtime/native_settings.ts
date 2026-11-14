/** Native persistence owns hook profiles. Python configuration has a separate owner. */
import {createRequire} from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
function transport() { return require(path.join(process.env.GSM_APP_ROOT || process.cwd(), 'desktop-runtime/transport.cjs')); }
export function settingsSync<T = any>(action: string, params: unknown = {}): T { return transport().callSync('settings.call', {action, params}); }
export function settingsCall<T = any>(action: string, params: unknown = {}): Promise<T> { return transport().call('settings.call', {action, params}); }
