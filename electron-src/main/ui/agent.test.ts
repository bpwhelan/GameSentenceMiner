import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ agentState: vi.fn(), nativeAgentSync: vi.fn(), nativeAgent: vi.fn(), startNativeAgent: vi.fn(), configureNativeAgent: vi.fn() }));
vi.mock('./native_agent.js', () => native);
import { stopAgentHookSession, startAgentHookSession, showAgentScriptUi } from './agent.js';
describe('native Agent compatibility boundary', () => {
    beforeEach(() => vi.resetAllMocks());
    it('preserves detached sessions when the local shutdown path runs', () => {
        native.agentState.mockReturnValue({ status: null });
        stopAgentHookSession();
        expect(native.agentState).toHaveBeenCalledWith(false);
        expect(native.nativeAgentSync).not.toHaveBeenCalled();
    });
    it('stops a local session even while it is still initializing', () => {
        native.agentState.mockReturnValue({ status: { running: true, agentPhase: 'starting' } });
        stopAgentHookSession();expect(native.nativeAgentSync).toHaveBeenCalledWith('stop');
    });
    it('propagates native initialization failures without claiming a running session', async () => {
        native.startNativeAgent.mockResolvedValue({ success: false, error: 'Script initialization failed' });
        const options = { pid: 123, exeName: 'game.exe', arch: 'x64' as const, source: 'user' as const, scriptPath: 'game.js', flushDelayMs: 100, copyToClipboard: false };
        expect(await startAgentHookSession(options)).toEqual({ success: false, error: 'Script initialization failed' });
        expect(native.startNativeAgent).toHaveBeenCalledWith(options, false);
    });
    it('reports a missing script UI to the existing renderer contract', async () => {
        native.nativeAgent.mockRejectedValue(new Error('Script has no UI'));
        expect(await showAgentScriptUi()).toEqual({ success: false, error: 'Script has no UI' });
    });
});
