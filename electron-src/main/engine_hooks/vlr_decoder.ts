export interface VlrLayoutRecord {
    engineIndex: number;
    type: number;
    code: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DecodedVlrGlyph {
    engineIndex: number;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DecodedVlrLine {
    bounds: { x: number; y: number; width: number; height: number };
    glyphStart: number;
    glyphEnd: number;
}

export interface DecodedVlrLayout {
    text: string;
    glyphs: DecodedVlrGlyph[];
    lines: DecodedVlrLine[];
}

const MAX_GLYPHS = 512;
const MAX_COORDINATE = 32_768;
const MAX_DIMENSION = 4096;

export function cleanVlrDisplayedText(raw: string): string {
    return raw
        .split('<N>')
        .map((part) => part.trim())
        .join('')
        .replace(/<[^>]+>/gu, '')
        .trim();
}

export function isVlrDisplayedDialogue(raw: unknown): raw is string {
    if (typeof raw !== 'string' || !/[\u3040-\u30ff\u3400-\u9fff]/u.test(raw)) return false;
    if (!/<(?:K|P)>$/u.test(raw.trim()) || /<N>/u.test(raw)) return false;
    const text = cleanVlrDisplayedText(raw);
    return text.length > 0 && text !== 'はい' && text !== 'いいえ';
}

function boundsFor(glyphs: DecodedVlrGlyph[]): DecodedVlrLine['bounds'] {
    const left = Math.min(...glyphs.map((glyph) => glyph.x));
    const top = Math.min(...glyphs.map((glyph) => glyph.y));
    const right = Math.max(...glyphs.map((glyph) => glyph.x + glyph.width));
    const bottom = Math.max(...glyphs.map((glyph) => glyph.y + glyph.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function groupLines(glyphs: DecodedVlrGlyph[]): DecodedVlrLine[] {
    if (glyphs.length === 0) return [];
    const groups: DecodedVlrGlyph[][] = [];
    for (const glyph of glyphs) {
        const current = groups.at(-1);
        if (!current) {
            groups.push([glyph]);
            continue;
        }
        const currentBounds = boundsFor(current);
        const currentCenter = currentBounds.y + currentBounds.height / 2;
        const glyphCenter = glyph.y + glyph.height / 2;
        const tolerance = Math.max(4, Math.min(currentBounds.height, glyph.height) * 0.4);
        const overlapsVertically =
            glyph.y < currentBounds.y + currentBounds.height &&
            glyph.y + glyph.height > currentBounds.y;
        if (overlapsVertically || Math.abs(glyphCenter - currentCenter) <= tolerance) {
            current.push(glyph);
        } else groups.push([glyph]);
    }

    let glyphOffset = 0;
    return groups.map((group) => {
        const glyphStart = glyphOffset;
        glyphOffset += group.length;
        return { bounds: boundsFor(group), glyphStart, glyphEnd: glyphOffset };
    });
}

function validInteger(value: number, minimum: number, maximum: number): boolean {
    return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function scaledMetric(value: number, measured: number, reference: number): number {
    return Math.max(1, Math.round((value * measured) / reference));
}

function vlrFontInkBox(record: VlrLayoutRecord): Pick<DecodedVlrGlyph, 'x' | 'y' | 'width' | 'height'> {
    const metric = (value: number, measured: number, reference: number) =>
        scaledMetric(value, measured, reference);
    const horizontalOffset = metric(1, record.width, 28);
    const normalWidth = Math.max(1, record.width - horizontalOffset * 2);
    const normalHeight = metric(26, record.height, 34);

    switch (record.code) {
        case 0x3001: // 、
            return {
                x: record.x + metric(5, record.width, 28),
                y: record.y + metric(16, record.height, 34),
                width: metric(8, record.width, 28),
                height: metric(8, record.height, 34),
            };
        case 0x3002: // 。
            return {
                x: record.x + metric(3, record.width, 28),
                y: record.y + metric(14, record.height, 34),
                width: metric(10, record.width, 28),
                height: metric(12, record.height, 34),
            };
        case 0x2026: // …
            return {
                x: record.x + horizontalOffset,
                y: record.y + metric(11, record.height, 34),
                width: normalWidth,
                height: metric(6, record.height, 34),
            };
        case 0x2014: // —
        case 0x2015: // ―
            return {
                x: record.x + horizontalOffset,
                y: record.y + metric(11, record.height, 34),
                width: normalWidth,
                height: metric(5, record.height, 34),
            };
        case 0x30fb: // ・
            return {
                x: record.x + metric(9, record.width, 28),
                y: record.y + metric(10, record.height, 34),
                width: metric(10, record.width, 28),
                height: metric(10, record.height, 34),
            };
        default:
            return {
                x: record.x + horizontalOffset,
                y: record.y,
                width: normalWidth,
                height: normalHeight,
            };
    }
}

export function decodeVlrLayout(records: readonly VlrLayoutRecord[]): DecodedVlrLayout {
    if (!Array.isArray(records) || records.length > MAX_GLYPHS) {
        throw new Error(`VLR glyph count must be between zero and ${MAX_GLYPHS}.`);
    }

    const glyphs: DecodedVlrGlyph[] = [];
    for (const record of records) {
        if (record.type !== 1) continue;
        if (!validInteger(record.engineIndex, 0, MAX_GLYPHS - 1)) {
            throw new Error('VLR record contains an invalid engine index.');
        }
        if (!validInteger(record.code, 0, 0x10ffff)) {
            throw new Error('VLR record contains an invalid Unicode code point.');
        }
        if (
            !validInteger(record.x, -MAX_COORDINATE, MAX_COORDINATE) ||
            !validInteger(record.y, -MAX_COORDINATE, MAX_COORDINATE)
        ) {
            throw new Error('VLR record contains an invalid glyph coordinate.');
        }
        if (
            !validInteger(record.width, 1, MAX_DIMENSION) ||
            !validInteger(record.height, 1, MAX_DIMENSION)
        ) {
            throw new Error('VLR record contains an invalid glyph dimension.');
        }
        const inkBox = vlrFontInkBox(record);
        glyphs.push({
            engineIndex: record.engineIndex,
            text: String.fromCodePoint(record.code),
            ...inkBox,
        });
    }

    return {
        text: glyphs.map((glyph) => glyph.text).join(''),
        glyphs,
        lines: groupLines(glyphs),
    };
}
