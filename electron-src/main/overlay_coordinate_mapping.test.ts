import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    getLegacyViewportRect,
    mapPercentBoundsToViewport,
    shouldUseWindowRelativeCoordinateMapping,
} = require(
    path.resolve(process.cwd(), 'GSM_Overlay/overlay_coordinate_mapping.js')
) as {
    mapPercentBoundsToViewport: (options: Record<string, unknown>) => {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
        usedFallback: boolean;
    } | null;
    getLegacyViewportRect: (...args: number[]) => Record<string, number | boolean>;
    shouldUseWindowRelativeCoordinateMapping: (displayInfo: Record<string, unknown>) => boolean;
};

const displayInfo = (overlayWindowBounds?: Record<string, number>) => ({
    xwaylandOverlayFeatures: true,
    coordinateMapping: 'linux-x11-window',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    ...(overlayWindowBounds ? { overlayWindowBounds } : {}),
});

const map = (overrides: Record<string, unknown> = {}) => mapPercentBoundsToViewport({
    x1: 10,
    y1: 20,
    x3: 30,
    y3: 40,
    offsetX: 0,
    offsetY: 0,
    viewportWidth: 1920,
    viewportHeight: 1080,
    displayInfo: displayInfo({ x: 0, y: 0, width: 1920, height: 1080 }),
    ...overrides,
});

describe('overlay coordinate mapping', () => {
    it('selects legacy mapping unless main explicitly signals the capability', () => {
        expect(shouldUseWindowRelativeCoordinateMapping({
            coordinateMapping: 'linux-x11-window',
            overlayWindowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
        })).toBe(false);
        expect(shouldUseWindowRelativeCoordinateMapping(displayInfo({
            x: 0, y: 0, width: 1920, height: 1080,
        }))).toBe(true);
    });

    it('matches legacy viewport percentages when the window covers the display', () => {
        expect(map()).toMatchObject({
            left: 192,
            top: 216,
            right: 576,
            bottom: 432,
            width: 384,
            height: 216,
            usedFallback: false,
        });
    });

    it.each([
        [{ x: 0, y: 29, width: 1920, height: 1080 }, 187],
        [{ x: 1, y: 32, width: 1920, height: 1080 }, 184],
    ])('accounts for a compositor panel offset (%o)', (overlayWindowBounds, expectedTop) => {
        expect(map({ displayInfo: displayInfo(overlayWindowBounds) })).toMatchObject({
            left: 192 - overlayWindowBounds.x,
            top: expectedTop,
            right: 576 - overlayWindowBounds.x,
            bottom: 432 - overlayWindowBounds.y,
            usedFallback: false,
        });
    });

    it('scales screen coordinates into a smaller compositor-managed window', () => {
        expect(map({
            x1: 50,
            y1: 50,
            x3: 75,
            y3: 75,
            viewportWidth: 1919,
            viewportHeight: 1079,
            displayInfo: displayInfo({ x: 0, y: 0, width: 1919, height: 1079 }),
        })).toMatchObject({
            // The captured display remains 1920x1080. Mapping via it puts
            // the midpoint at 960x540, unlike legacy viewport percentages
            // (959.5x539.5) in a 1919x1079 window.
            left: 960,
            top: 540,
            right: 1440,
            bottom: 810,
            usedFallback: false,
        });
    });

    it('composes user calibration offsets in screen percentage space', () => {
        const result = map({
            offsetX: 2,
            offsetY: -1,
            displayInfo: displayInfo({ x: 1, y: 32, width: 1920, height: 1080 }),
        });
        expect(result?.left).toBeCloseTo(229.4);
        expect(result?.top).toBeCloseTo(173.2);
        expect(result?.right).toBeCloseTo(613.4);
        expect(result?.bottom).toBeCloseTo(389.2);
        expect(result?.usedFallback).toBe(false);
    });

    it('falls back to legacy viewport percentages for missing or implausible bounds', () => {
        for (const displayInfoValue of [
            displayInfo(),
            displayInfo({ x: 0, y: 0, width: 100, height: 100 }),
            displayInfo({ x: 3000, y: 0, width: 1920, height: 1080 }),
        ]) {
            expect(map({ displayInfo: displayInfoValue })).toMatchObject({
                left: 192,
                top: 216,
                right: 576,
                bottom: 432,
                usedFallback: true,
            });
        }
    });

    it('uses legacy mapping when the explicit capability is false even with valid window bounds', () => {
        expect(map({
            displayInfo: {
                ...displayInfo({ x: 1, y: 32, width: 1920, height: 1080 }),
                xwaylandOverlayFeatures: false,
            },
        })).toMatchObject({
            left: 192,
            top: 216,
            right: 576,
            bottom: 432,
            usedFallback: true,
        });
    });

    it('shares the exact legacy fallback with the renderer', () => {
        expect(getLegacyViewportRect(10, 20, 30, 40, 0, 0, 1920, 1080)).toMatchObject({
            left: 192,
            top: 216,
            right: 576,
            bottom: 432,
            usedFallback: true,
        });
    });
});
