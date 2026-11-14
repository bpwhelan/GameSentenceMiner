import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ agentState: vi.fn(), nativeAgentSync: vi.fn(), nativeAgent: vi.fn(), startNativeAgent: vi.fn(), configureNativeAgent: vi.fn(), reconnectNativeAgent: vi.fn(), stopNativeAgentForUpdate: vi.fn() }));
vi.mock('./native_agent.js', () => native);
import { shutdownDetachedAgentHostForUpdate, reconnectDetachedAgentHookSession } from './detached_agent_client.js';
describe('native detached Agent boundary', () => {
    beforeEach(() => vi.resetAllMocks());
    it('blocks an update if the native host cannot stop', async () => {
        native.reconnectNativeAgent.mockResolvedValue(true);
        native.agentState.mockReturnValue({ status: { running: true } });
        native.stopNativeAgentForUpdate.mockRejectedValue(new Error('Native host did not stop'));
        await expect(shutdownDetachedAgentHostForUpdate()).rejects.toThrow('Native host did not stop');
    });
    it('uses native reconnect state without fabricating a live session', async () => {
        native.reconnectNativeAgent.mockResolvedValue(false);
        expect(await reconnectDetachedAgentHookSession()).toBe(false);
        expect(native.nativeAgent).not.toHaveBeenCalled();
    });
});
