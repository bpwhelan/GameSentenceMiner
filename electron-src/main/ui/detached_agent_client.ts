/** Detached Agent compatibility API. Rust owns the helper and reconnect state. */
import type { StartHookResult } from './texthook.js';
import type { StartAgentHookOptions } from './agent.js';
import { agentState, configureNativeAgent, nativeAgent, nativeAgentSync, reconnectNativeAgent, startNativeAgent, stopNativeAgentForUpdate, type AgentCallbacks } from './native_agent.js';
export function configureDetachedAgentCallbacks(callbacks: AgentCallbacks): void { configureNativeAgent(true, callbacks); }
export function reconnectDetachedAgentHookSession(): Promise<boolean> { return reconnectNativeAgent(); }
export function startDetachedAgentHookSession(options: StartAgentHookOptions): Promise<StartHookResult> { return startNativeAgent(options, true); }
export function isDetachedAgentHookRunning(): boolean { return !!agentState(true).status?.running; }
export function getDetachedAgentHookRuntimeStatus(): any | null { return agentState(true).status; }
export function listDetachedAgentHooks(): { hooks: any[]; selectedHookId: string | null } { return agentState(true).hooks; }
export async function stopDetachedAgentHookSession(): Promise<{ success: boolean; error?: string }> {
    try { return await nativeAgent('stop'); } catch (error) { return { success: false, error: (error as Error).message }; }
}
export function shutdownDetachedAgentHostForUpdate(): Promise<void> { return stopNativeAgentForUpdate(); }
export function setDetachedAgentFlushDelayMs(value: number): { success: boolean; flushDelayMs: number } { return nativeAgentSync('setFlushDelay', { value }); }
export function setDetachedAgentCopyToClipboard(value: boolean): { success: boolean; copyToClipboard: boolean } { return nativeAgentSync('setCopyToClipboard', { value }); }
export function setDetachedAgentMaxBufferSize(value: number): void { nativeAgentSync('setMaxBufferSize', { value }); }
export async function showDetachedAgentScriptUi(): Promise<{ success: boolean; error?: string }> {
    try { return await nativeAgent('showUi'); } catch (error) { return { success: false, error: (error as Error).message }; }
}
export function callDetachedAgentUiRpc(func: string, args: unknown[]): Promise<unknown> { return nativeAgent('rpcCall', { func, args }); }
export function sendDetachedAgentUiRpc(func: string, args: unknown[]): { success: boolean; error?: string } {
    try { return nativeAgentSync('rpcSend', { func, args }); } catch (error) { return { success: false, error: (error as Error).message }; }
}
