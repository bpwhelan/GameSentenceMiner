export interface BgiPositionedGlyph {
    engineIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DecodedBgiGlyph {
    engineIndex: number;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DecodedBgiLine {
    bounds: { x: number; y: number; width: number; height: number };
    glyphStart: number;
    glyphEnd: number;
}

export interface DecodedBgiRuby {
    reading: string;
    baseStart: number;
    baseEnd: number;
    bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface DecodedBgiLayout {
    text: string;
    glyphs: DecodedBgiGlyph[];
    lines: DecodedBgiLine[];
    ruby: DecodedBgiRuby[];
}

export interface BgiMarkup {
    text: string;
    ruby: { reading: string; baseStart: number; baseEnd: number }[];
}

const TAG = /<(\/?)([A-Za-z]+)([^>]*)>/gu;

/**
 * Splits engine markup into displayed text and ruby spans. Offsets index the
 * displayed text in code points, which is the unit the engine draws in.
 */
export function parseBgiMarkup(raw: string): BgiMarkup {
    const characters: string[] = [];
    const ruby: BgiMarkup['ruby'] = [];
    let openReading: string | null = null;
    let openStart = 0;
    let cursor = 0;

    TAG.lastIndex = 0;
    for (let match = TAG.exec(raw); match !== null; match = TAG.exec(raw)) {
        characters.push(...Array.from(raw.slice(cursor, match.index)));
        cursor = match.index + match[0].length;
        const closing = match[1] === '/';
        const name = match[2].toLowerCase();
        if (name !== 'r') continue;
        if (closing) {
            if (openReading === null) continue;
            ruby.push({ reading: openReading, baseStart: openStart, baseEnd: characters.length });
            openReading = null;
            continue;
        }
        openReading = match[3];
        openStart = characters.length;
    }
    characters.push(...Array.from(raw.slice(cursor)));

    // An unterminated ruby tag would silently swallow the rest of the line, so its
    // reading is dropped rather than guessed at.
    return { text: characters.join(''), ruby };
}

function bodyHeightOf(glyphs: readonly BgiPositionedGlyph[]): number {
    return Math.max(...glyphs.map((glyph) => glyph.height));
}

function boundsFor(
    boxes: readonly { x: number; y: number; width: number; height: number }[],
): DecodedBgiLine['bounds'] {
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Orders glyphs the way they read: rows top to bottom, then left to right within a
 * row. Draw order cannot be used, because the engine interleaves ruby with base
 * text and repeats passes over the same line.
 */
function readingOrder(glyphs: readonly BgiPositionedGlyph[]): BgiPositionedGlyph[] {
    return [...glyphs].sort((left, right) => left.y - right.y || left.x - right.x);
}

function groupRows(glyphs: readonly DecodedBgiGlyph[]): DecodedBgiLine[] {
    const lines: DecodedBgiLine[] = [];
    let start = 0;
    for (let index = 1; index <= glyphs.length; index += 1) {
        if (index < glyphs.length && glyphs[index].y === glyphs[start].y) continue;
        lines.push({
            bounds: boundsFor(glyphs.slice(start, index)),
            glyphStart: start,
            glyphEnd: index,
        });
        start = index;
    }
    return lines;
}

/**
 * Pairs a captured message with the glyphs the engine drew for it.
 *
 * Returns null when the two cannot be reconciled. That is the only defence against
 * mispairing: the engine emits several text events per displayed line — ruby
 * readings and unrelated internal strings among them — and which one is the
 * dialogue differs per build, so the pairing is proven by glyph count rather than
 * assumed from the call site.
 */
export function decodeBgiLayout(
    raw: string,
    positionedGlyphs: readonly BgiPositionedGlyph[],
): DecodedBgiLayout | null {
    const markup = parseBgiMarkup(raw);
    const characters = Array.from(markup.text);
    const expectedRuby = markup.ruby.reduce((total, span) => total + Array.from(span.reading).length, 0);
    if (positionedGlyphs.length !== characters.length + expectedRuby) return null;
    if (characters.length === 0) return null;

    // Ruby is drawn in a smaller cell than body text, so the body is the tallest
    // class and no font metric has to be configured. Counting instead of measuring
    // would fail on a line whose readings outnumber the characters they annotate.
    const bodyHeight = bodyHeightOf(positionedGlyphs);
    const baseGlyphs = expectedRuby === 0
        ? [...positionedGlyphs]
        : positionedGlyphs.filter((glyph) => glyph.height === bodyHeight);
    const rubyGlyphs = expectedRuby === 0
        ? []
        : positionedGlyphs.filter((glyph) => glyph.height !== bodyHeight);
    if (baseGlyphs.length !== characters.length || rubyGlyphs.length !== expectedRuby) return null;

    const glyphs = readingOrder(baseGlyphs).map((glyph, index) => ({
        engineIndex: glyph.engineIndex,
        text: characters[index],
        x: glyph.x,
        y: glyph.y,
        width: glyph.width,
        height: glyph.height,
    }));

    const lines = groupRows(glyphs);
    const ruby = markup.ruby.map((span) => {
        const covered = glyphs.slice(span.baseStart, span.baseEnd);
        const above = rubyGlyphs.filter(
            (glyph) =>
                covered.length > 0 &&
                glyph.y < covered[0].y &&
                glyph.x + glyph.width > covered[0].x &&
                glyph.x < covered[covered.length - 1].x + covered[covered.length - 1].width,
        );
        return {
            reading: span.reading,
            baseStart: span.baseStart,
            baseEnd: span.baseEnd,
            bounds: above.length > 0 ? boundsFor(above) : null,
        };
    });

    return { text: markup.text, glyphs, lines, ruby };
}

/**
 * Picks the captured message that the drawn glyphs belong to, from the text events
 * seen since the previous line, **in the order the engine emitted them**.
 *
 * Glyph count alone does not identify the message: a line of three characters and
 * an internal string of three characters reconcile equally well. Order breaks the
 * tie, because the engine always emits the dialogue first and the ruby readings and
 * internal strings afterwards. The caller must therefore drop the buffer once a
 * line has been paired, or a stale message can win on the next one.
 */
export function selectBgiLayout(
    candidates: readonly string[],
    positionedGlyphs: readonly BgiPositionedGlyph[],
): DecodedBgiLayout | null {
    for (const candidate of candidates) {
        const decoded = decodeBgiLayout(candidate, positionedGlyphs);
        if (decoded) return decoded;
    }
    return null;
}

/**
 * Collapses the engine's repeated draw passes. A glyph is one screen position: the
 * typewriter reveal redraws the whole line every frame, and some builds draw each
 * character twice, once for the outline and once for the fill.
 */
export function dedupeBgiGlyphs(
    positionedGlyphs: readonly BgiPositionedGlyph[],
): BgiPositionedGlyph[] {
    const seen = new Set<string>();
    const result: BgiPositionedGlyph[] = [];
    for (const glyph of positionedGlyphs) {
        const key = `${glyph.x},${glyph.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(glyph);
    }
    return result;
}
