import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeGpuRuntime } from './gpu_install.js';

function fixture() {
    const events = new EventEmitter();
    let connected = false;
    let spawned: (() => void) | undefined;
    const phases: string[] = [];
    const deps = {
        stop: vi.fn(async () => {}),
        apply: vi.fn(async () => {}),
        launch: vi.fn((onSpawn: () => void) => {
            spawned = onSpawn;
            return new Promise<void>(() => {}); // Resolves only when the real backend exits.
        }),
        bus: {
            isConnected: () => connected,
            on: (event: 'client-connected', listener: (id: string) => void) => {
                events.on(event, listener);
                return () => { events.off(event, listener); };
            },
        },
        onPhase: (phase: string) => phases.push(phase),
        startupTimeoutMs: 1000,
    };
    async function ready() {
        await vi.waitFor(() => expect(deps.launch).toHaveBeenCalled());
        spawned?.();
        connected = true;
        events.emit('client-connected', 'backend');
    }
    return { deps, ready, events, phases };
}

afterEach(() => vi.useRealTimers());

describe('GPU runtime changes', () => {
    it('completes when the new backend reconnects without waiting for its exit', async () => {
        const { deps, ready, events, phases } = fixture();
        const finished = changeGpuRuntime(deps);
        await ready();
        await finished;
        expect(phases).toEqual(['stopping', 'installing', 'starting']);
        expect(events.listenerCount('client-connected')).toBe(0);
    });
    it('restarts GSM after a failed install, then reports the installation error', async () => {
        const { deps, ready } = fixture();
        deps.apply.mockRejectedValueOnce(new Error('Download failed'));
        const finished = changeGpuRuntime(deps);
        const rejected = expect(finished).rejects.toThrow('Download failed');
        await ready();
        await rejected;
        expect(deps.launch).toHaveBeenCalledOnce();
    });
    it('reports startup errors instead of leaving the operation pending', async () => {
        const { deps, events } = fixture();
        deps.launch.mockRejectedValueOnce(new Error('Could not start GSM'));
        await expect(changeGpuRuntime(deps)).rejects.toThrow('Could not start GSM');
        expect(events.listenerCount('client-connected')).toBe(0);
    });
    it('bounds the wait for backend reconnection and removes its listener', async () => {
        vi.useFakeTimers();
        const { deps, events } = fixture();
        const finished = changeGpuRuntime(deps);
        const rejected = expect(finished).rejects.toThrow('reconnect');
        await vi.advanceTimersByTimeAsync(1000);
        await rejected;
        expect(events.listenerCount('client-connected')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('rejects overlapping package changes', async () => {
        const { deps, ready } = fixture();
        const first = changeGpuRuntime(deps);
        await expect(changeGpuRuntime(deps)).rejects.toThrow('already');
        await ready();
        await first;
    });
});
