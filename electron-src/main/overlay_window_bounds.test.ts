import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    getOverlayWindowBoundsForCapability,
    getOverlayWindowBoundsForDisplay,
} = require(
    path.resolve(process.cwd(), 'GSM_Overlay/overlay_window_bounds.js')
) as {
    getOverlayWindowBoundsForDisplay: (
        display: { bounds?: { x?: number; y?: number; width?: number; height?: number } },
        options?: { fullDisplayBounds?: boolean }
    ) => { x: number; y: number; width: number; height: number };
    getOverlayWindowBoundsForCapability: (
        display: { bounds?: { x?: number; y?: number; width?: number; height?: number } },
        capabilityEnabled: boolean
    ) => { x: number; y: number; width: number; height: number };
};

describe('overlay window bounds', () => {
    const display = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };

    it('uses the complete display bounds for fullscreen overlay windows', () => {
        expect(getOverlayWindowBoundsForDisplay(display, { fullDisplayBounds: true })).toEqual(display.bounds);
    });

    it('preserves the legacy one-pixel height reduction for non-fullscreen overlay windows', () => {
        expect(getOverlayWindowBoundsForDisplay(display)).toEqual({
            x: -1920,
            y: 0,
            width: 1920,
            height: 1079,
        });
    });

    it('selects base bounds whenever the capability gate is false', () => {
        expect(getOverlayWindowBoundsForCapability(display, false)).toEqual({
            x: -1920,
            y: 0,
            width: 1920,
            height: 1079,
        });
        expect(getOverlayWindowBoundsForCapability(display, true)).toEqual(display.bounds);
    });
});
