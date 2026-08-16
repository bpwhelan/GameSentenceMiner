import { describe, expect, it } from 'vitest';

import {
    cleanVlrDisplayedText,
    decodeVlrLayout,
    isVlrDisplayedDialogue,
    type VlrLayoutRecord,
} from './vlr_decoder.js';

function record(
    engineIndex: number,
    code: number,
    x: number,
    y: number,
    width = 28,
    height = 34,
    type = 1,
): VlrLayoutRecord {
    return { engineIndex, type, code, x, y, width, height };
}

describe("Virtue's Last Reward layout decoder", () => {
    it('recognizes only the Agent dialogue lifecycle and excludes instruction controls', () => {
        expect(isVlrDisplayedDialogue('痛てっ……。<K>')).toBe(true);
        expect(isVlrDisplayedDialogue('痛てっ……。<K><P>')).toBe(true);
        expect(isVlrDisplayedDialogue('背景を調べて下さい。<N>')).toBe(false);
        expect(isVlrDisplayedDialogue('はい<K>')).toBe(false);
        expect(isVlrDisplayedDialogue('FOT-RodinCattleya Pro')).toBe(false);
    });

    it('strips VLR tags without joining separate displayed lines', () => {
        expect(cleanVlrDisplayedText('  これは<K><P>  ')).toBe('これは');
        expect(cleanVlrDisplayedText('文字<N>通り')).toBe('文字通り');
    });

    it('decodes Unicode glyph records and preserves multiline geometry', () => {
        const result = decodeVlrLayout([
            record(0, 0x3053, 0, 34),
            record(1, 0x308c, 28, 34),
            record(2, 0x306f, 56, 34),
            record(3, 0x6587, 0, 68),
            record(4, 0x5b57, 28, 68),
            record(5, 0x3002, 56, 68, 19),
            record(6, 0x3002, 0, 0, 0, 0, 6),
        ]);

        expect(result.text).toBe('これは文字。');
        expect(result.glyphs[0]).toEqual({
            engineIndex: 0,
            text: 'こ',
            x: 1,
            y: 34,
            width: 26,
            height: 26,
        });
        expect(result.lines).toEqual([
            { bounds: { x: 1, y: 34, width: 82, height: 26 }, glyphStart: 0, glyphEnd: 3 },
            { bounds: { x: 1, y: 68, width: 64, height: 26 }, glyphStart: 3, glyphEnd: 6 },
        ]);
    });

    it('converts advance cells into calibrated VLR font ink boxes', () => {
        const result = decodeVlrLayout([
            record(0, 0x3055, 95, 423),
            record(1, 0x3001, 123, 423),
            record(2, 0x3002, 151, 423),
            record(3, 0x2026, 179, 423),
        ]);

        expect(result.glyphs).toEqual([
            { engineIndex: 0, text: 'さ', x: 96, y: 423, width: 26, height: 26 },
            { engineIndex: 1, text: '、', x: 128, y: 439, width: 8, height: 8 },
            { engineIndex: 2, text: '。', x: 154, y: 437, width: 10, height: 12 },
            { engineIndex: 3, text: '…', x: 180, y: 434, width: 26, height: 6 },
        ]);
        expect(result.lines).toEqual([
            { bounds: { x: 96, y: 423, width: 110, height: 26 }, glyphStart: 0, glyphEnd: 4 },
        ]);
    });

    it('fails closed on corrupt Unicode or geometry', () => {
        expect(() => decodeVlrLayout([record(0, 0x110000, 0, 34)])).toThrow(/Unicode code point/u);
        expect(() => decodeVlrLayout([record(0, 0x3042, Number.NaN, 34)])).toThrow(
            /invalid glyph coordinate/u,
        );
        expect(() => decodeVlrLayout([record(0, 0x3042, 0, 34, 0, 34)])).toThrow(
            /invalid glyph dimension/u,
        );
        expect(() => decodeVlrLayout([record(512, 0x3042, 0, 34)])).toThrow(
            /invalid engine index/u,
        );
    });
});
