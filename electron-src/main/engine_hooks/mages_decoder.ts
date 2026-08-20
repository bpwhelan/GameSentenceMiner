export interface MagesPositionedCode {
    engineIndex: number;
    code: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DecodedMagesGlyph {
    engineIndex: number;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DecodedMagesLine {
    bounds: { x: number; y: number; width: number; height: number };
    glyphStart: number;
    glyphEnd: number;
}

export interface DecodedMagesLayout {
    text: string;
    glyphs: DecodedMagesGlyph[];
    lines: DecodedMagesLine[];
}

const CONTROL_MASK = 0x8000;
const CONTROL_SPACE = 0x00;
const CONTROL_SPEAKER_START = 0x01;
const CONTROL_SPEAKER_END = 0x02;
const CONTROL_RUBY_START = 0x09;
const CONTROL_RUBY_TEXT_START = 0x0a;
const CONTROL_RUBY_END = 0x0b;

export function applyMagesCharsetOverrides(
    charsetContents: string,
    overrides: unknown,
): string {
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
        throw new Error('MAGES charset overrides must be an object.');
    }

    const charset = Array.from(charsetContents.replace(/[\r\n]+$/u, ''));
    for (const [rawCode, replacement] of Object.entries(overrides)) {
        if (!/^0x[0-9a-f]{4}$/iu.test(rawCode)) {
            throw new Error(`Invalid MAGES charset override code: ${rawCode}`);
        }
        if (typeof replacement !== 'string' || Array.from(replacement).length !== 1) {
            throw new Error(`MAGES charset override ${rawCode} must contain one character.`);
        }
        const index = Number.parseInt(rawCode.slice(2), 16) - 0x8000;
        if (index < 0 || index >= charset.length) {
            throw new Error(`MAGES charset override ${rawCode} is outside the configured charset.`);
        }
        charset[index] = replacement;
    }
    return charset.join('');
}

export function parseMagesCompoundMap(contents: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const rawLine of contents.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = /^\[([0-9a-f]{4})(?:-([0-9a-f]{4}))?\]=(.*)$/iu.exec(line);
        if (!match) throw new Error(`Invalid MAGES compound mapping: ${rawLine}`);
        const start = Number.parseInt(match[1], 16);
        const end = Number.parseInt(match[2] ?? match[1], 16);
        if (end < start) throw new Error(`Invalid MAGES compound range: ${rawLine}`);
        for (let codePoint = start; codePoint <= end; codePoint += 1) {
            result.set(String.fromCodePoint(codePoint), match[3]);
        }
    }
    return result;
}

function decodeCharacter(code: number, charset: string[], compounds: ReadonlyMap<string, string>): string {
    const index = code & 0x7fff;
    const character = charset[index];
    if (character === undefined) {
        throw new Error(`MAGES character code 0x${code.toString(16)} is outside the configured charset.`);
    }
    return compounds.get(character) ?? character;
}

function boundsFor(glyphs: DecodedMagesGlyph[]): DecodedMagesLine['bounds'] {
    const left = Math.min(...glyphs.map((glyph) => glyph.x));
    const top = Math.min(...glyphs.map((glyph) => glyph.y));
    const right = Math.max(...glyphs.map((glyph) => glyph.x + glyph.width));
    const bottom = Math.max(...glyphs.map((glyph) => glyph.y + glyph.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function groupLines(glyphs: DecodedMagesGlyph[]): DecodedMagesLine[] {
    if (glyphs.length === 0) return [];
    const groups: DecodedMagesGlyph[][] = [];
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
        if (Math.abs(glyphCenter - currentCenter) <= tolerance) current.push(glyph);
        else groups.push([glyph]);
    }

    let glyphOffset = 0;
    return groups.map((group) => {
        const glyphStart = glyphOffset;
        glyphOffset += group.length;
        return { bounds: boundsFor(group), glyphStart, glyphEnd: glyphOffset };
    });
}

export function decodeMagesLayout(
    positionedCodes: readonly MagesPositionedCode[],
    charsetContents: string,
    compounds: ReadonlyMap<string, string>,
): DecodedMagesLayout {
    const charset = Array.from(charsetContents.replace(/[\r\n]+$/u, ''));
    const glyphs: DecodedMagesGlyph[] = [];
    const textParts: string[] = [];
    let inSpeaker = false;
    let inRubyReading = false;

    for (const entry of positionedCodes) {
        if ((entry.code & CONTROL_MASK) !== 0) {
            const control = entry.code & 0xff;
            if (control === CONTROL_SPACE && !inRubyReading) textParts.push(' ');
            else if (control === CONTROL_SPEAKER_START) {
                inSpeaker = true;
                textParts.push('【');
            } else if (control === CONTROL_SPEAKER_END && inSpeaker) {
                inSpeaker = false;
                textParts.push('】');
            } else if (control === CONTROL_RUBY_START) {
                inRubyReading = false;
            } else if (control === CONTROL_RUBY_TEXT_START) {
                inRubyReading = true;
            } else if (control === CONTROL_RUBY_END) {
                inRubyReading = false;
            }
            continue;
        }

        const text = decodeCharacter(entry.code, charset, compounds);
        if (inRubyReading) continue;
        textParts.push(text);
        if (entry.width > 0 && entry.height > 0) {
            glyphs.push({
                engineIndex: entry.engineIndex,
                text,
                x: entry.x,
                y: entry.y,
                width: entry.width,
                height: entry.height,
            });
        }
    }

    return { text: textParts.join(''), glyphs, lines: groupLines(glyphs) };
}
