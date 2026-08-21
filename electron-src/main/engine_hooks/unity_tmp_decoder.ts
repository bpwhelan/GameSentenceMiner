export interface UnityTmpPositionedGlyph {
    engineIndex: number;
    code: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DecodedUnityTmpGlyph {
    engineIndex: number;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DecodedUnityTmpLine {
    bounds: { x: number; y: number; width: number; height: number };
    glyphStart: number;
    glyphEnd: number;
}

export interface DecodedUnityTmpLayout {
    text: string;
    glyphs: DecodedUnityTmpGlyph[];
    lines: DecodedUnityTmpLine[];
}

/**
 * Characters TextMeshPro places in its layout but never draws: the line breaks and
 * zero-width marks it keeps so that indices still line up with the source string.
 * They carry a position, so leaving them in would put empty cells over the text.
 */
function isNonDrawable(code: number): boolean {
    return (
        code < 0x20 ||
        code === 0x7f ||
        code === 0x200b ||
        code === 0x200c ||
        code === 0x200d ||
        code === 0xfeff ||
        code === 0x2028 ||
        code === 0x2029
    );
}

function isSpace(code: number): boolean {
    return code === 0x20 || code === 0x3000 || code === 0xa0;
}

function boundsFor(
    glyphs: readonly { x: number; y: number; width: number; height: number }[],
): DecodedUnityTmpLine['bounds'] {
    const left = Math.min(...glyphs.map((glyph) => glyph.x));
    const top = Math.min(...glyphs.map((glyph) => glyph.y));
    const right = Math.max(...glyphs.map((glyph) => glyph.x + glyph.width));
    const bottom = Math.max(...glyphs.map((glyph) => glyph.y + glyph.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Splits the reported cells into lines.
 *
 * The payload gives every cell on a line the same vertical band, taken from the
 * line's own ascender and descender, so a change of `y` is exactly a line break.
 * Runs are used rather than grouping by value: a centred line and the line under it
 * can share a band only by the engine returning to it, which is still a new line.
 */
function splitLines(
    glyphs: readonly UnityTmpPositionedGlyph[],
): UnityTmpPositionedGlyph[][] {
    const lines: UnityTmpPositionedGlyph[][] = [];
    let current: UnityTmpPositionedGlyph[] = [];
    for (const glyph of glyphs) {
        const previous = current[current.length - 1];
        if (previous && (previous.y !== glyph.y || previous.height !== glyph.height)) {
            lines.push(current);
            current = [];
        }
        current.push(glyph);
    }
    if (current.length > 0) lines.push(current);
    return lines;
}

/** Drops the padding cells at both ends of a line without touching interior spaces. */
function trimSpaces(glyphs: readonly UnityTmpPositionedGlyph[]): UnityTmpPositionedGlyph[] {
    let start = 0;
    let end = glyphs.length;
    while (start < end && isSpace(glyphs[start].code)) start += 1;
    while (end > start && isSpace(glyphs[end - 1].code)) end -= 1;
    return glyphs.slice(start, end);
}

/**
 * Turns the cells TextMeshPro laid out into displayed text and exact glyph boxes.
 *
 * Unlike the engines that hand over a code stream, TMP already names the character
 * at every position, so nothing has to be reconciled or looked up in a table. The
 * decoder's whole job is to drop what the engine lays out but does not draw and to
 * recover the line structure that the flat cell list lost.
 */
export function decodeUnityTmpLayout(
    positionedGlyphs: readonly UnityTmpPositionedGlyph[],
): DecodedUnityTmpLayout | null {
    const drawable = positionedGlyphs.filter((glyph) => !isNonDrawable(glyph.code));
    if (drawable.length === 0) return null;

    const glyphs: DecodedUnityTmpGlyph[] = [];
    const lines: DecodedUnityTmpLine[] = [];
    const lineTexts: string[] = [];
    for (const rawLine of splitLines(drawable)) {
        const line = trimSpaces(rawLine);
        if (line.length === 0) continue;
        const glyphStart = glyphs.length;
        for (const glyph of line) {
            glyphs.push({
                engineIndex: glyph.engineIndex,
                text: String.fromCodePoint(glyph.code),
                x: glyph.x,
                y: glyph.y,
                width: glyph.width,
                height: glyph.height,
            });
        }
        lines.push({ bounds: boundsFor(line), glyphStart, glyphEnd: glyphs.length });
        lineTexts.push(glyphs.slice(glyphStart).map((glyph) => glyph.text).join(''));
    }
    if (glyphs.length === 0) return null;

    return { text: lineTexts.join('\n'), glyphs, lines };
}
