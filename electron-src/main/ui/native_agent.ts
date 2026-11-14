/** Compatibility facade; all Agent process, Frida and script ownership is Rust. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { getBaseDir } from '../data_dir.js';
const require = createRequire(import.meta.url);
export interface AgentCallbacks { onEvent?: (channel: string, payload: any) => void; onText?: (payload: any) => void }
let transport: any;
const callbacks = new Map<boolean, AgentCallbacks>();
function native() {
    if (!transport) {
        transport = require(path.join(process.env.GSM_APP_ROOT || process.cwd(), 'desktop-runtime/transport.cjs'));
        transport.events.on('message', (message: any) => {
            if (message.type !== 'agent-controller') return;
            const target = callbacks.get(!!message.detached);
            if (message.event === 'agent.text') target?.onText?.(message.data);
            else if (message.event.startsWith('texthook.')) target?.onEvent?.(message.event, message.data);
        });
    }
    return transport;
}
export function configureNativeAgent(detached: boolean, value: AgentCallbacks): void { callbacks.set(detached, value); native(); }
export function nativeAgent<T = any>(action: string, params: unknown = {}): Promise<T> { return native().call('agent.command', { action, params }); }
export function nativeAgentSync<T = any>(action: string, params: unknown = {}): T { return native().callSync('agent.command', { action, params }); }
export function agentState(detached: boolean): any {
    const state = nativeAgentSync('state');
    return state.status?.agentDetached === detached ? state : { status: null, hooks: { hooks: [], selectedHookId: null } };
}
export async function startNativeAgent(options: unknown, detached: boolean): Promise<any> {
    try { return await nativeAgent('start', { ...(options as object), detached, baseDir: getBaseDir() }); }
    catch (error) { return { success: false, error: String((error as Error).message || error) }; }
}
export async function reconnectNativeAgent(): Promise<boolean> { return nativeAgent('reconnect', { baseDir: getBaseDir() }); }

export async function stopNativeAgentForUpdate(): Promise<void> {
    const result = await nativeAgent("stopForUpdate", { baseDir: getBaseDir() });
    if (!result.success) throw new Error(result.error || "Agent host did not stop.");
}
