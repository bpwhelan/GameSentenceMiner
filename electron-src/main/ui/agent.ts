/** Local Agent compatibility API. Runtime ownership is native Rust. */
import type { StartHookResult, TextHookArchitecture, TextHookStartSource } from './texthook.js';
import type { WineLaunchContext } from './linux_wine.js';
import { agentState, configureNativeAgent, nativeAgent, nativeAgentSync, startNativeAgent, type AgentCallbacks } from './native_agent.js';
export interface StartAgentHookOptions {
    pid: number; exeName: string; arch: TextHookArchitecture; scriptPath: string;
    flushDelayMs: number; copyToClipboard: boolean; source: TextHookStartSource;
    maxBufferSize?: number; wineLaunch?: WineLaunchContext;
}
export function configureAgentHookCallbacks(callbacks: AgentCallbacks): void { configureNativeAgent(false, callbacks); }
export function startAgentHookSession(options: StartAgentHookOptions): Promise<StartHookResult> { return startNativeAgent(options, false); }
export function stopAgentHookSession(): void { if (isAgentHookRunning()) nativeAgentSync('stop'); }
export function isAgentHookRunning(): boolean { return !!agentState(false).status?.running; }
export function getAgentHookRuntimeStatus(): any | null { return agentState(false).status; }
export function listAgentHooks(): { hooks: any[]; selectedHookId: string | null } { return agentState(false).hooks; }
export async function showAgentScriptUi(): Promise<{ success: boolean; error?: string }> {
    try { return await nativeAgent('showUi'); } catch (error) { return { success: false, error: (error as Error).message }; }
}
export function callAgentUiRpc(func: string, args: unknown[]): Promise<unknown> { return nativeAgent('rpcCall', { func, args }); }
export function sendAgentUiRpc(func: string, args: unknown[]): { success: boolean; error?: string } {
    try { return nativeAgentSync('rpcSend', { func, args }); } catch (error) { return { success: false, error: (error as Error).message }; }
}
export function setAgentFlushDelayMs(value: number): { success: boolean; flushDelayMs?: number; error?: string } { return nativeAgentSync('setFlushDelay', { value }); }
export function setAgentCopyToClipboard(value: boolean): { success: boolean; copyToClipboard?: boolean; error?: string } { return nativeAgentSync('setCopyToClipboard', { value }); }
