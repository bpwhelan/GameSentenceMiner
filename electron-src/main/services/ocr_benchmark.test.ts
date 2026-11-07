import { describe, expect, it, vi } from 'vitest';
import { DevOcrBenchmark, OCR_BENCHMARK_TOPIC } from './ocr_benchmark.js';

function fixture(isDev = true) {
    const deps = {
        isDev,
        bus: { isConnected: vi.fn(() => true), request: vi.fn(async () => ({ enabled: true, csv_path: '/data/events.csv' })) },
        openFolder: vi.fn(async () => {}), onStatus: vi.fn(), onError: vi.fn(),
    };
    return { deps, service: new DevOcrBenchmark(deps) };
}

describe('developer OCR benchmark menu', () => {
    it('is absent and does not contact the backend in packaged builds', async () => {
        const { deps, service } = fixture(false);
        expect(service.menuItems()).toEqual([]);
        await service.refresh();
        expect(deps.bus.request).not.toHaveBeenCalled();
    });

    it('checks the switch only after backend confirmation and toggles it off', async () => {
        const { deps, service } = fixture();
        const click = service.menuItems()[0].click!;
        const item = { checked: true, enabled: true } as any;
        const pending = click(item, undefined as any, undefined as any);
        expect(item.checked).toBe(false);
        expect(item.enabled).toBe(false);
        await pending;
        expect(deps.bus.request).toHaveBeenLastCalledWith('backend', OCR_BENCHMARK_TOPIC, { enabled: true }, 5000);
        expect(item.checked).toBe(true);
        expect(item.enabled).toBe(true);
        deps.bus.request.mockResolvedValueOnce({ enabled: false, csv_path: '/data/events.csv' });
        await click(item, undefined as any, undefined as any);
        expect(deps.bus.request).toHaveBeenLastCalledWith('backend', OCR_BENCHMARK_TOPIC, { enabled: false }, 5000);
        expect(item.checked).toBe(false);
    });

    it('preserves confirmed state when a request fails', async () => {
        const { deps, service } = fixture();
        const click = service.menuItems()[0].click!;
        const item = { checked: false, enabled: true } as any;
        await click(item, undefined as any, undefined as any);
        deps.bus.request.mockRejectedValueOnce(new Error('disk unavailable'));
        await click(item, undefined as any, undefined as any);
        expect(item.checked).toBe(true);
        expect(item.enabled).toBe(true);
        expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'));
    });

    it('refuses to queue a start while the backend is disconnected', async () => {
        const { deps, service } = fixture();
        deps.bus.isConnected.mockReturnValue(false);
        await service.menuItems()[0].click!({ checked: true } as any, undefined as any, undefined as any);
        expect(deps.bus.request).not.toHaveBeenCalled();
        expect(deps.onError).toHaveBeenCalled();
    });

    it('refreshes the checkbox after a backend restart and opens the output folder', async () => {
        const { deps, service } = fixture();
        await service.refresh();
        deps.bus.request.mockResolvedValueOnce({ enabled: false, csv_path: '' });
        await service.refresh();
        expect(service.menuItems()[0].checked).toBe(false);
        await service.menuItems()[1].click!(undefined as any, undefined as any, undefined as any);
        expect(deps.openFolder).toHaveBeenCalledOnce();
    });
});
