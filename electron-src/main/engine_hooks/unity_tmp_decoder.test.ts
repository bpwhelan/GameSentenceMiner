import { describe, expect, it } from 'vitest';

import { decodeUnityTmpLayout, type UnityTmpPositionedGlyph } from './unity_tmp_decoder.js';

/** One line of same-height cells, the shape the payload reports. */
function line(text: string, y: number, options: { start?: number; x?: number } = {}) {
    const startIndex = options.start ?? 0;
    const startX = options.x ?? 100;
    return Array.from(text).map((character, index) => ({
        engineIndex: startIndex + index,
        code: character.codePointAt(0) ?? 0,
        x: startX + index * 40,
        y,
        width: 40,
        height: 56,
    }));
}

describe('Unity TextMeshPro layout decoder', () => {
    it('joins one line of cells into the displayed text', () => {
        const decoded = decodeUnityTmpLayout(line('これは', 600));

        expect(decoded?.text).toBe('これは');
        expect(decoded?.glyphs).toHaveLength(3);
        expect(decoded?.glyphs[0]).toEqual({
            engineIndex: 0,
            text: 'こ',
            x: 100,
            y: 600,
            width: 40,
            height: 56,
        });
        expect(decoded?.lines).toEqual([
            { bounds: { x: 100, y: 600, width: 120, height: 56 }, glyphStart: 0, glyphEnd: 3 },
        ]);
    });

    it('separates wrapped lines by their shared vertical band, not by a newline character', () => {
        const decoded = decodeUnityTmpLayout([
            ...line('あい', 600),
            ...line('うえ', 660, { start: 2 }),
        ]);

        expect(decoded?.text).toBe('あい\nうえ');
        expect(decoded?.lines).toEqual([
            { bounds: { x: 100, y: 600, width: 80, height: 56 }, glyphStart: 0, glyphEnd: 2 },
            { bounds: { x: 100, y: 660, width: 80, height: 56 }, glyphStart: 2, glyphEnd: 4 },
        ]);
    });

    it('keeps a repeated vertical band separate when the engine returns to it', () => {
        // Line bands are contiguous runs, so a y value that reappears starts a new
        // line rather than being merged into the earlier one.
        const decoded = decodeUnityTmpLayout([
            ...line('あ', 600),
            ...line('い', 660, { start: 1 }),
            ...line('う', 600, { start: 2 }),
        ]);

        expect(decoded?.lines).toHaveLength(3);
        expect(decoded?.text).toBe('あ\nい\nう');
    });

    it('drops leading and trailing spaces from a line but keeps interior ones', () => {
        const decoded = decodeUnityTmpLayout(line('  a b  ', 600));

        expect(decoded?.text).toBe('a b');
        expect(decoded?.glyphs).toHaveLength(3);
        expect(decoded?.glyphs[0].x).toBe(180);
        expect(decoded?.lines[0].bounds).toEqual({ x: 180, y: 600, width: 120, height: 56 });
    });

    it('drops control characters the engine lays out but never draws', () => {
        const decoded = decodeUnityTmpLayout([
            ...line('あ', 600),
            { engineIndex: 1, code: 0x0a, x: 140, y: 600, width: 0, height: 56 },
            { engineIndex: 2, code: 0x200b, x: 140, y: 600, width: 0, height: 56 },
            ...line('い', 600, { start: 3, x: 140 }),
        ]);

        expect(decoded?.text).toBe('あい');
        expect(decoded?.glyphs).toHaveLength(2);
    });

    it('preserves astral code points as one glyph', () => {
        const decoded = decodeUnityTmpLayout([
            { engineIndex: 0, code: 0x1f600, x: 100, y: 600, width: 40, height: 56 },
        ]);

        expect(decoded?.text).toBe('😀');
        expect(decoded?.glyphs[0].text).toBe('😀');
    });

    it('refuses a layout with nothing drawable in it', () => {
        expect(decodeUnityTmpLayout([])).toBeNull();
        expect(decodeUnityTmpLayout(line('   ', 600))).toBeNull();
        expect(
            decodeUnityTmpLayout([{ engineIndex: 0, code: 0x0a, x: 1, y: 1, width: 0, height: 1 }]),
        ).toBeNull();
    });

    it('keeps reading order rather than sorting by position', () => {
        // The engine already reports characters in reading order; a right-to-left or
        // centre-aligned line must not be reordered by x.
        const glyphs: UnityTmpPositionedGlyph[] = [
            { engineIndex: 0, code: 0x3042, x: 300, y: 10, width: 40, height: 56 },
            { engineIndex: 1, code: 0x3044, x: 100, y: 10, width: 40, height: 56 },
        ];

        expect(decodeUnityTmpLayout(glyphs)?.text).toBe('あい');
        expect(decodeUnityTmpLayout(glyphs)?.lines[0].bounds).toEqual({
            x: 100,
            y: 10,
            width: 240,
            height: 56,
        });
    });
});
