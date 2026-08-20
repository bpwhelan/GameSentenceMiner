export interface TextGeometryRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface TextGeometryGlyph {
    engineIndex: number;
    text?: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface TextGeometryLine {
    bounds: TextGeometryRect;
    glyphStart: number;
    glyphEnd: number;
}

export interface TextGeometryV1 {
    schema: 'gsm_text_geometry_v1';
    coordinateSpace: {
        kind: 'engine-logical';
        width: number;
        height: number;
    };
    bounds: TextGeometryRect;
    lines: TextGeometryLine[];
    glyphs?: TextGeometryGlyph[];
    producer: {
        kind: 'engine-hook';
        version: 1;
        integrationId: string;
    };
}

interface OverlayBoundingRect {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    x3: number;
    y3: number;
    x4: number;
    y4: number;
}

export interface PrecomputedOverlayCoordinatesV1 {
    schema: 'gsm_overlay_coords_v1';
    coordinate_space: {
        source_width: number;
        source_height: number;
        mode: 'source_content';
    };
    lines: Array<{
        text: string;
        bounding_rect: OverlayBoundingRect;
        words: Array<{
            text: string;
            bounding_rect: OverlayBoundingRect;
        }>;
    }>;
    producer: TextGeometryV1['producer'];
    bypass_ocr: true;
}

const MAX_GEOMETRY_GLYPHS = 2000;
const MAX_COORDINATE_SPACE = 16_384;
const MAX_ABSOLUTE_COORDINATE = 32_768;
const MAX_GLYPH_DIMENSION = 4096;
const MAX_GLYPH_TEXT_LENGTH = 32;
const MAX_INTEGRATION_ID_LENGTH = 128;

function sanitizeInteger(value: unknown, minimum: number, maximum: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return null;
    }
    if (value < minimum || value > maximum) return null;
    return value;
}

function sanitizeRect(value: unknown, maxDimension = MAX_COORDINATE_SPACE): TextGeometryRect | null {
    if (!value || typeof value !== 'object') return null;
    const rect = value as Partial<TextGeometryRect>;
    const x = sanitizeInteger(rect.x, -MAX_ABSOLUTE_COORDINATE, MAX_ABSOLUTE_COORDINATE);
    const y = sanitizeInteger(rect.y, -MAX_ABSOLUTE_COORDINATE, MAX_ABSOLUTE_COORDINATE);
    const width = sanitizeInteger(rect.width, 1, maxDimension);
    const height = sanitizeInteger(rect.height, 1, maxDimension);
    if (x === null || y === null || width === null || height === null) return null;
    return { x, y, width, height };
}

export function sanitizeTextGeometry(value: unknown): TextGeometryV1 | null {
    if (!value || typeof value !== 'object') return null;
    const geometry = value as Partial<TextGeometryV1>;
    if (geometry.schema !== 'gsm_text_geometry_v1') return null;

    const coordinateSpace = geometry.coordinateSpace;
    if (!coordinateSpace || coordinateSpace.kind !== 'engine-logical') return null;
    const coordinateWidth = sanitizeInteger(coordinateSpace.width, 1, MAX_COORDINATE_SPACE);
    const coordinateHeight = sanitizeInteger(coordinateSpace.height, 1, MAX_COORDINATE_SPACE);
    if (coordinateWidth === null || coordinateHeight === null) return null;

    const bounds = sanitizeRect(geometry.bounds);
    if (!bounds || !Array.isArray(geometry.lines) || geometry.lines.length === 0) return null;
    if (geometry.lines.length > MAX_GEOMETRY_GLYPHS) return null;

    const glyphs: TextGeometryGlyph[] = [];
    if (geometry.glyphs !== undefined) {
        if (!Array.isArray(geometry.glyphs) || geometry.glyphs.length > MAX_GEOMETRY_GLYPHS) return null;
        for (const candidate of geometry.glyphs) {
            if (!candidate || typeof candidate !== 'object') return null;
            const glyph = candidate as Partial<TextGeometryGlyph>;
            const engineIndex = sanitizeInteger(glyph.engineIndex, 0, MAX_GEOMETRY_GLYPHS - 1);
            const glyphBounds = sanitizeRect(glyph, MAX_GLYPH_DIMENSION);
            const text = glyph.text;
            if (
                engineIndex === null ||
                !glyphBounds ||
                (text !== undefined &&
                    (typeof text !== 'string' || text.length === 0 || text.length > MAX_GLYPH_TEXT_LENGTH))
            ) {
                return null;
            }
            glyphs.push({ engineIndex, ...(text === undefined ? {} : { text }), ...glyphBounds });
        }
    }

    const lines: TextGeometryLine[] = [];
    for (const candidate of geometry.lines) {
        if (!candidate || typeof candidate !== 'object') return null;
        const line = candidate as Partial<TextGeometryLine>;
        const lineBounds = sanitizeRect(line.bounds);
        const glyphStart = sanitizeInteger(line.glyphStart, 0, glyphs.length || MAX_GEOMETRY_GLYPHS);
        const glyphEnd = sanitizeInteger(line.glyphEnd, 0, glyphs.length || MAX_GEOMETRY_GLYPHS);
        if (!lineBounds || glyphStart === null || glyphEnd === null || glyphEnd <= glyphStart) return null;
        if (glyphs.length > 0 && glyphEnd > glyphs.length) return null;
        lines.push({ bounds: lineBounds, glyphStart, glyphEnd });
    }

    const producer = geometry.producer;
    if (
        !producer ||
        producer.kind !== 'engine-hook' ||
        producer.version !== 1 ||
        typeof producer.integrationId !== 'string' ||
        producer.integrationId.length === 0 ||
        producer.integrationId.length > MAX_INTEGRATION_ID_LENGTH
    ) {
        return null;
    }

    return {
        schema: 'gsm_text_geometry_v1',
        coordinateSpace: {
            kind: 'engine-logical',
            width: coordinateWidth,
            height: coordinateHeight,
        },
        bounds,
        lines,
        ...(glyphs.length > 0 ? { glyphs } : {}),
        producer: {
            kind: 'engine-hook',
            version: 1,
            integrationId: producer.integrationId,
        },
    };
}

function toBoundingRect(rect: TextGeometryRect): OverlayBoundingRect {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    return {
        x1: rect.x,
        y1: rect.y,
        x2: right,
        y2: rect.y,
        x3: right,
        y3: bottom,
        x4: rect.x,
        y4: bottom,
    };
}

export function textGeometryToOverlayPayload(
    text: string,
    geometry: TextGeometryV1,
): PrecomputedOverlayCoordinatesV1 | null {
    const characters = Array.from(text);
    const glyphs = geometry.glyphs ?? [];
    const totalGeometryGlyphs = Math.max(
        1,
        ...geometry.lines.map((line) => line.glyphEnd),
    );
    const lines = geometry.lines.map((line, lineIndex) => {
        const isLastLine = lineIndex === geometry.lines.length - 1;
        const textStart = Math.round((line.glyphStart / totalGeometryGlyphs) * characters.length);
        const textEnd = isLastLine
            ? characters.length
            : Math.round((line.glyphEnd / totalGeometryGlyphs) * characters.length);
        const lineGlyphs = glyphs.slice(line.glyphStart, line.glyphEnd);
        const hasExactGlyphText = lineGlyphs.length > 0 && lineGlyphs.every((glyph) => glyph.text);
        const lineCharacters = characters.slice(textStart, textEnd);
        const lineText = hasExactGlyphText
            ? lineGlyphs.map((glyph) => glyph.text).join('')
            : lineCharacters.join('');
        const words = hasExactGlyphText
            ? lineGlyphs.map((glyph) => ({
                  text: glyph.text ?? '',
                  bounding_rect: toBoundingRect(glyph),
              }))
            : lineGlyphs.length > 0 && lineGlyphs.length === lineCharacters.length
              ? lineGlyphs.map((glyph, glyphIndex) => ({
                    text: lineCharacters[glyphIndex] ?? '',
                    bounding_rect: toBoundingRect(glyph),
                }))
              : [{ text: lineText, bounding_rect: toBoundingRect(line.bounds) }];

        return {
            text: lineText,
            bounding_rect: toBoundingRect(line.bounds),
            words: words.filter((word) => word.text.length > 0),
        };
    }).filter((line) => line.text.length > 0 && line.words.length > 0);

    if (lines.length === 0) return null;
    return {
        schema: 'gsm_overlay_coords_v1',
        coordinate_space: {
            source_width: geometry.coordinateSpace.width,
            source_height: geometry.coordinateSpace.height,
            mode: 'source_content',
        },
        lines,
        producer: geometry.producer,
        bypass_ocr: true,
    };
}
