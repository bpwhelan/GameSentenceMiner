import { describe, expect, it } from 'vitest';

import {
    dedupeBgiGlyphs,
    decodeBgiLayout,
    parseBgiMarkup,
    selectBgiLayout,
    type BgiPositionedGlyph,
} from './bgi_decoder.js';

function glyph(engineIndex: number, x: number, y: number, height: number, width = 28): BgiPositionedGlyph {
    return { engineIndex, x, y, width, height };
}

// Captured from Jewelry Hearts Academia: the draw order the engine used, with the
// body row at y=13 and the ruby reading at y=0 in a 15-pixel cell.
const RUBY_LINE_RAW = '「<rアルベア>愚者の構え</r>──霧雨・サジタリウス」';
const RUBY_LINE_DRAWS: BgiPositionedGlyph[] = [
    [33, 13],
    [45, 13],
    [55, 0],
    [72, 13],
    [90, 0],
    [101, 13],
    [128, 13],
    [125, 0],
    [157, 13],
    [160, 0],
    [184, 13],
    [212, 13],
    [240, 13],
    [269, 13],
    [307, 13],
    [324, 13],
    [354, 13],
    [381, 13],
    [413, 13],
    [438, 13],
    [464, 13],
    [494, 13],
].map(([x, y], index) => glyph(index, x, y, y === 0 ? 15 : 42, y === 0 ? 16 : 28));

describe('BGI markup parsing', () => {
    it('separates ruby readings from displayed text', () => {
        const markup = parseBgiMarkup(RUBY_LINE_RAW);

        expect(markup.text).toBe('「愚者の構え──霧雨・サジタリウス」');
        expect(markup.ruby).toEqual([{ reading: 'アルベア', baseStart: 1, baseEnd: 6 }]);
    });

    it('handles several ruby spans in one line', () => {
        const markup = parseBgiMarkup('だが<rカーメイル>ｋｍ</r>先の<rセリオン>獣人</r>だ');

        expect(markup.text).toBe('だがｋｍ先の獣人だ');
        expect(markup.ruby).toEqual([
            { reading: 'カーメイル', baseStart: 2, baseEnd: 4 },
            { reading: 'セリオン', baseStart: 6, baseEnd: 8 },
        ]);
    });

    it('drops other markup without treating it as text', () => {
        expect(parseBgiMarkup('待って<ns>くれ').text).toBe('待ってくれ');
    });

    it('discards an unterminated ruby reading rather than guessing its extent', () => {
        const markup = parseBgiMarkup('<rよみ>本文');

        expect(markup.text).toBe('本文');
        expect(markup.ruby).toEqual([]);
    });
});

describe('BGI layout decoder', () => {
    it('pairs a ruby line with its glyphs in reading order', () => {
        const result = decodeBgiLayout(RUBY_LINE_RAW, RUBY_LINE_DRAWS);

        expect(result).not.toBeNull();
        expect(result?.text).toBe('「愚者の構え──霧雨・サジタリウス」');
        expect(result?.glyphs).toHaveLength(18);
        expect(result?.glyphs.map((entry) => entry.text).join('')).toBe(
            '「愚者の構え──霧雨・サジタリウス」',
        );
        // Ruby is interleaved with the body in draw order, so the body glyphs must
        // come out ordered by position rather than by when they were drawn.
        expect(result?.glyphs.map((entry) => entry.x)).toEqual([
            33, 45, 72, 101, 128, 157, 184, 212, 240, 269, 307, 324, 354, 381, 413, 438, 464, 494,
        ]);
        expect(result?.glyphs.every((entry) => entry.y === 13)).toBe(true);
    });

    it('reports the ruby span over the base characters it annotates', () => {
        const result = decodeBgiLayout(RUBY_LINE_RAW, RUBY_LINE_DRAWS);

        expect(result?.ruby).toEqual([
            {
                reading: 'アルベア',
                baseStart: 1,
                baseEnd: 6,
                bounds: { x: 55, y: 0, width: 121, height: 15 },
            },
        ]);
    });

    it('groups a wrapped message into one line per row', () => {
        const result = decodeBgiLayout('あいうえ', [
            glyph(0, 10, 13, 42),
            glyph(1, 40, 13, 42),
            glyph(2, 70, 13, 42),
            glyph(3, 10, 56, 42),
        ]);

        expect(result?.lines).toEqual([
            { bounds: { x: 10, y: 13, width: 88, height: 42 }, glyphStart: 0, glyphEnd: 3 },
            { bounds: { x: 10, y: 56, width: 28, height: 42 }, glyphStart: 3, glyphEnd: 4 },
        ]);
        expect(result?.glyphs.map((entry) => entry.text)).toEqual(['あ', 'い', 'う', 'え']);
    });

    it('refuses a message whose length does not match the glyphs drawn', () => {
        expect(decodeBgiLayout('ソーマ', [glyph(0, 10, 13, 42), glyph(1, 40, 13, 42)])).toBeNull();
        expect(decodeBgiLayout('', [])).toBeNull();
    });

    it('separates ruby from body when the readings outnumber the characters', () => {
        // Captured shape: 12 body characters carrying 13 characters of reading.
        const raw = '──<rオニキス>黒瑪瑙</r>。──<rアレキサンドライト>金緑石</r>。';
        const body = [136, 164, 193, 220, 248, 278, 304, 332, 360, 388, 416, 446].map((x, index) =>
            glyph(index, x, 594, 42),
        );
        const readings = [196, 217, 238, 259, 338, 352, 367, 382, 396, 411, 425, 440, 454].map((x, index) =>
            glyph(100 + index, x, 581, 15, 16),
        );

        const result = decodeBgiLayout(raw, [...body, ...readings]);

        expect(result?.text).toBe('──黒瑪瑙。──金緑石。');
        expect(result?.glyphs).toHaveLength(12);
        expect(result?.ruby.map((entry) => entry.reading)).toEqual(['オニキス', 'アレキサンドライト']);
    });

    it('refuses a ruby line whose smaller glyphs do not account for the reading', () => {
        const draws = RUBY_LINE_DRAWS.map((entry) => ({ ...entry, height: 42 }));

        expect(decodeBgiLayout(RUBY_LINE_RAW, draws)).toBeNull();
    });
});

describe('BGI candidate selection', () => {
    it('takes the dialogue over a later decoy of the same length', () => {
        const draws = [glyph(0, 10, 13, 42), glyph(1, 40, 13, 42), glyph(2, 70, 13, 42)];

        // '・・・' reconciles by count just as well, and the engine really does emit
        // strings like it after every line; only emission order separates them.
        const result = selectBgiLayout(['あいう', 'ソーマ', '・・・'], draws);

        expect(result?.text).toBe('あいう');
    });

    it('skips leading candidates that cannot be reconciled', () => {
        const draws = [glyph(0, 10, 13, 42), glyph(1, 40, 13, 42), glyph(2, 70, 13, 42)];

        expect(selectBgiLayout(['メデューサ兵', 'あいう'], draws)?.text).toBe('あいう');
    });

    it('yields nothing when no candidate fits', () => {
        expect(selectBgiLayout(['あい', 'うえお'], [glyph(0, 10, 13, 42)])).toBeNull();
    });
});

describe('BGI draw deduplication', () => {
    it('keeps one glyph per screen position across repeated passes', () => {
        const result = dedupeBgiGlyphs([
            glyph(0, 10, 13, 42),
            glyph(1, 10, 13, 42),
            glyph(2, 40, 13, 42),
            glyph(3, 10, 13, 42),
            glyph(4, 40, 56, 42),
        ]);

        expect(result.map((entry) => entry.engineIndex)).toEqual([0, 2, 4]);
    });
});
