import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadRawHourFormatter(): (hours: number) => string {
    const source = readFileSync(
        resolve(process.cwd(), 'GameSentenceMiner/web/static/js/shared.js'),
        'utf8',
    );
    const match = source.match(/window\.formatTimeRaw = function\(hours\) \{[\s\S]*?\n\};/);

    expect(match).not.toBeNull();

    const loadFormatter = new Function(
        'window',
        `${match![0]}\nreturn window.formatTimeRaw;`,
    );

    return loadFormatter({}) as (hours: number) => string;
}

describe('shared raw hour formatting', () => {
    it('formats sub-hour durations as minutes instead of decimal hours', () => {
        const formatTimeRaw = loadRawHourFormatter();

        expect(formatTimeRaw(0.09)).toBe('5m');
        expect(formatTimeRaw(0.25)).toBe('15m');
        expect(formatTimeRaw(2.5)).toBe('2.5h');
        expect(formatTimeRaw(1500)).toBe('1500h');
    });
});
