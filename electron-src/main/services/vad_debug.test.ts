import { describe, expect, it, vi } from 'vitest';
import { DevVadDebug, VAD_DEBUG_TOPIC } from './vad_debug.js';

function fixture(isDev = true) {
    const deps = {
        isDev,
        bus: { isConnected: vi.fn(() => true), request: vi.fn(async () => ({ enabled: true })) },
        openFolder: vi.fn(async () => {}), onStatus: vi.fn(), onError: vi.fn(),
    };
    return { deps, service: new DevVadDebug(deps) };
}

describe('VAD debug development menu', () => {
    it('is absent and inactive in packaged builds', async () => {
        const { deps, service } = fixture(false);
        expect(service.menuItems()).toEqual([]);
        await service.refresh();
        expect(deps.bus.request).not.toHaveBeenCalled();
    });

    it('checks the switch after backend confirmation and toggles back off', async () => {
        const { deps, service } = fixture();
        const click = service.menuItems()[0].click!;
        const item = { checked: true, enabled: true } as any;
        const pending = click(item, undefined as any, undefined as any);
        expect(item.checked).toBe(false);
        expect(item.enabled).toBe(false);
        await pending;
        expect(deps.bus.request).toHaveBeenLastCalledWith('backend', VAD_DEBUG_TOPIC, { enabled: true }, 5000);
        expect(item.checked).toBe(true);
        deps.bus.request.mockResolvedValueOnce({ enabled: false });
        await click(item, undefined as any, undefined as any);
        expect(item.checked).toBe(false);
        expect(item.enabled).toBe(true);
    });

    it('reconciles a lost acknowledgement and refreshes after backend restarts', async () => {
        const { deps, service } = fixture();
        deps.bus.request.mockRejectedValueOnce(new Error('timeout'));
        const item = { checked: false, enabled: true } as any;
        await service.menuItems()[0].click!(item, undefined as any, undefined as any);
        expect(item.checked).toBe(true);
        expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('timeout'));
        deps.bus.request.mockResolvedValueOnce({ enabled: false });
        await service.refresh();
        expect(service.menuItems()[0].checked).toBe(false);
    });

    it('refuses to queue recording while disconnected', async () => {
        const { deps, service } = fixture();
        deps.bus.isConnected.mockReturnValue(false);
        await service.menuItems()[0].click!({ checked: true } as any, undefined as any, undefined as any);
        expect(deps.bus.request).not.toHaveBeenCalled();
        expect(deps.onError).toHaveBeenCalledOnce();
    });

    it('opens the audio library and reports folder errors', async () => {
        const { deps, service } = fixture();
        const click = service.menuItems()[1].click!;
        await click(undefined as any, undefined as any, undefined as any);
        expect(deps.openFolder).toHaveBeenCalledOnce();
        deps.openFolder.mockRejectedValueOnce(new Error('folder unavailable'));
        await click(undefined as any, undefined as any, undefined as any);
        expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('folder unavailable'));
    });
});
