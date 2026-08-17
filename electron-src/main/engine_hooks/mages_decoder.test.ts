import { describe, expect, it } from 'vitest';

import {
    decodeMagesLayout,
    parseMagesCompoundMap,
    type MagesPositionedCode,
} from './mages_decoder.js';

const charset = ' ABCDE\ue000';

function glyph(
    engineIndex: number,
    code: number,
    x: number,
    y: number,
    width = 20,
    height = 30,
): MagesPositionedCode {
    return { engineIndex, code, x, y, width, height };
}

describe('MAGES layout decoder', () => {
    it('decodes engine codes and groups wrapped glyphs into positioned lines', () => {
        const result = decodeMagesLayout(
            [
                glyph(0, 0x0001, 100, 200),
                glyph(1, 0x0002, 120, 200),
                glyph(2, 0x8000, 140, 200, 0, 0),
                glyph(3, 0x0003, 100, 240),
            ],
            charset,
            new Map(),
        );

        expect(result.text).toBe('AB C');
        expect(result.glyphs).toEqual([
            { engineIndex: 0, text: 'A', x: 100, y: 200, width: 20, height: 30 },
            { engineIndex: 1, text: 'B', x: 120, y: 200, width: 20, height: 30 },
            { engineIndex: 3, text: 'C', x: 100, y: 240, width: 20, height: 30 },
        ]);
        expect(result.lines).toEqual([
            { bounds: { x: 100, y: 200, width: 40, height: 30 }, glyphStart: 0, glyphEnd: 2 },
            { bounds: { x: 100, y: 240, width: 20, height: 30 }, glyphStart: 2, glyphEnd: 3 },
        ]);
    });

    it('keeps base text and suppresses ruby readings', () => {
        const result = decodeMagesLayout(
            [
                glyph(0, 0x8009, 0, 0, 0, 0),
                glyph(1, 0x0001, 100, 200),
                glyph(2, 0x800a, 0, 0, 0, 0),
                glyph(3, 0x0002, 100, 180, 10, 12),
                glyph(4, 0x800b, 0, 0, 0, 0),
                glyph(5, 0x0003, 120, 200),
            ],
            charset,
            new Map(),
        );

        expect(result.text).toBe('AC');
        expect(result.glyphs.map((entry) => entry.engineIndex)).toEqual([1, 5]);
    });

    it('marks a leading speaker segment without inventing glyph boxes for brackets', () => {
        const result = decodeMagesLayout(
            [
                glyph(0, 0x8001, 0, 0, 0, 0),
                glyph(1, 0x0001, 100, 160),
                glyph(2, 0x8002, 0, 0, 0, 0),
                glyph(3, 0x0002, 100, 200),
            ],
            charset,
            new Map(),
        );

        expect(result.text).toBe('【A】B');
        expect(result.glyphs.map((entry) => entry.text)).toEqual(['A', 'B']);
    });

    it('expands compound-character mappings from the game profile', () => {
        const compounds = parseMagesCompoundMap('[E000]=キタ\n[E001-E002]=?\n');
        const result = decodeMagesLayout(
            [glyph(0, 0x0006, 100, 200)],
            charset,
            compounds,
        );

        expect(result.text).toBe('キタ');
        expect(result.glyphs[0]?.text).toBe('キタ');
        expect(compounds.get('\ue001')).toBe('?');
        expect(compounds.get('\ue002')).toBe('?');
    });

    it('rejects unknown character codes instead of emitting corrupt text', () => {
        expect(() => decodeMagesLayout([glyph(0, 0x1234, 0, 0)], charset, new Map())).toThrow(
            /outside the configured charset/u,
        );
    });
});
