import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createLinuxX11BoundsRepairController } = require(
    path.resolve(process.cwd(), 'GSM_Overlay/linux_x11_bounds_repair.js')
) as { createLinuxX11BoundsRepairController: (options: Record<string, unknown>) => any };

describe('Linux X11 bounds repair controller', () => {
    it('backs off, caps repairs, and resumes after a display reset', () => {
        vi.useFakeTimers();
        let bounds = { x: 0, y: 29, width: 100, height: 100 };
        const expected = { x: 0, y: 0, width: 100, height: 100 };
        const repair = vi.fn(() => { bounds = { ...bounds, y: 29 }; });
        const warn = vi.fn();
        const controller = createLinuxX11BoundsRepairController({ getBounds: () => bounds, getExpectedBounds: () => expected, repair, warn, maxRepairs: 2, baseDelayMs: 10, selfEventSettleMs: 1 });
        controller.onBoundsEvent('move'); vi.advanceTimersByTime(10);
        vi.advanceTimersByTime(1);
        vi.advanceTimersByTime(1);
        expect(repair).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1);
        controller.reset();
        controller.onBoundsEvent('move'); vi.advanceTimersByTime(10);
        expect(repair).toHaveBeenCalledTimes(3);
        vi.useRealTimers();
    });

    it('suppresses a synchronous move event caused by its own setBounds call', () => {
        vi.useFakeTimers();
        let bounds = { x: 0, y: 29, width: 100, height: 100 };
        const expected = { x: 0, y: 0, width: 100, height: 100 };
        let controller: any;
        const repair = vi.fn(() => {
            controller.onBoundsEvent('move');
            setTimeout(() => controller.onBoundsEvent('resize'), 1);
            bounds = expected;
        });
        controller = createLinuxX11BoundsRepairController({ getBounds: () => bounds, getExpectedBounds: () => expected, repair, baseDelayMs: 1, selfEventSettleMs: 5 });
        controller.onBoundsEvent('move'); vi.advanceTimersByTime(1);
        vi.advanceTimersByTime(5);
        expect(repair).toHaveBeenCalledTimes(1);
        expect(controller.state.scheduled).toBe(false);
        vi.useRealTimers();
    });

    it('does not reset its global budget when geometry briefly matches', () => {
        vi.useFakeTimers();
        let bounds = { x: 0, y: 29, width: 100, height: 100 };
        const expected = { x: 0, y: 0, width: 100, height: 100 };
        const repair = vi.fn(() => { bounds = expected; });
        const warn = vi.fn();
        const controller = createLinuxX11BoundsRepairController({ getBounds: () => bounds, getExpectedBounds: () => expected, repair, warn, maxRepairs: 1, baseDelayMs: 1, selfEventSettleMs: 5 });
        controller.onBoundsEvent('move');
        vi.advanceTimersByTime(6);
        expect(controller.state.repairCount).toBe(1);
        bounds = { ...bounds, y: 29 };
        controller.onBoundsEvent('move');
        vi.advanceTimersByTime(2);
        expect(repair).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });
});
