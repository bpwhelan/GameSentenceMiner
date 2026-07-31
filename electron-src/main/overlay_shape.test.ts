import { createRequire } from 'node:module';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildShapeRects, INTERACTIVE_ELEMENT_SELECTOR } = require(
    path.resolve(process.cwd(), 'GSM_Overlay/overlay_shape.js')
) as {
    INTERACTIVE_ELEMENT_SELECTOR: string;
    buildShapeRects: (
        rects: Array<Record<string, number>>,
        options: { padding: number; viewportWidth: number; viewportHeight: number }
    ) => Array<{ x: number; y: number; width: number; height: number }>;
};

describe('overlay shape regions', () => {
    it('selects OCR regions, toolbar buttons, and Yomitan popup frames', () => {
        const document = new JSDOM(`
            <span class="interactive text-box"></span>
            <button id="btn-settings"></button>
            <iframe class="yomitan-popup"></iframe>
            <div id="non-interactive"></div>
        `).window.document;

        expect(
            Array.from(document.querySelectorAll(INTERACTIVE_ELEMENT_SELECTOR), (element) => element.id || element.className)
        ).toEqual(['interactive text-box', 'btn-settings', 'yomitan-popup']);
    });

    it('keeps CSS-pixel coordinates in DIP units without device-scale multiplication', () => {
        expect(
            buildShapeRects(
                [{ left: 100.25, top: 50.5, right: 200.75, bottom: 80.25 }],
                { padding: 10, viewportWidth: 1920, viewportHeight: 1080 }
            )
        ).toEqual([{ x: 90, y: 40, width: 121, height: 51 }]);
    });

    it('clips padded regions to the renderer viewport and drops empty rectangles', () => {
        expect(
            buildShapeRects(
                [
                    { left: -5, top: -5, right: 6, bottom: 6 },
                    { left: 20, top: 20, right: 20, bottom: 25 },
                ],
                { padding: 10, viewportWidth: 25, viewportHeight: 25 }
            )
        ).toEqual([{ x: 0, y: 0, width: 16, height: 16 }]);
    });

    it('returns an empty region set when no interactive elements are visible', () => {
        expect(
            buildShapeRects([], { padding: 10, viewportWidth: 1920, viewportHeight: 1080 })
        ).toEqual([]);
    });
});
