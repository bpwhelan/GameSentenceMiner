import { describe, expect, it } from 'vitest';

import { sanitizeTextGeometry, textGeometryToOverlayPayload } from './text_geometry.js';

const geometry = {
    schema: 'gsm_text_geometry_v1',
    coordinateSpace: { kind: 'engine-logical', width: 1280, height: 720 },
    bounds: { x: 100, y: 200, width: 80, height: 30 },
    lines: [{ bounds: { x: 100, y: 200, width: 80, height: 30 }, glyphStart: 0, glyphEnd: 3 }],
    glyphs: [
        { engineIndex: 2, text: 'Ａ', x: 100, y: 200, width: 20, height: 30 },
        { engineIndex: 3, text: 'キタ', x: 120, y: 200, width: 40, height: 30 },
        { engineIndex: 4, text: '。', x: 160, y: 200, width: 20, height: 30 },
    ],
    producer: { kind: 'engine-hook', version: 1, integrationId: 'mages-steins-gate-steam' },
} as const;

describe('engine text geometry', () => {
    it('sanitizes standalone engine-hook geometry', () => {
        expect(sanitizeTextGeometry(geometry)).toEqual(geometry);
    });

    it('uses exact engine glyph text instead of proportionally guessing text positions', () => {
        const sanitized = sanitizeTextGeometry(geometry);
        expect(sanitized).not.toBeNull();

        const result = textGeometryToOverlayPayload('【Ａキタ。】', sanitized!);

        expect(result?.lines[0]?.text).toBe('Ａキタ。');
        expect(result?.lines[0]?.words.map((word) => word.text)).toEqual(['Ａ', 'キタ', '。']);
        expect(result?.coordinate_space).toEqual({
            source_width: 1280,
            source_height: 720,
            mode: 'source_content',
        });
        expect(result?.producer.integrationId).toBe('mages-steins-gate-steam');
    });

    it('rejects legacy Agent-owned coordinate provenance', () => {
        expect(
            sanitizeTextGeometry({
                ...geometry,
                producer: { kind: 'mages-agent', version: 1 },
            }),
        ).toBeNull();
    });
});
