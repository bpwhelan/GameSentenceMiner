import { describe, expect, it } from 'vitest';
import { getSeasonalEvent, resolveSeasonalIconStyle } from './seasonal.js';

describe('seasonal effects', () => {
    it.each([
        [2026, 9, 23, 23, 59, null],
        [2026, 9, 24, 0, 0, 'halloween'],
        [2026, 9, 31, 23, 59, 'halloween'],
        [2026, 10, 1, 0, 0, 'halloween'],
        [2026, 10, 7, 23, 59, 'halloween'],
        [2026, 10, 8, 0, 0, null],
        [2026, 0, 1, 0, 0, null],
        [2027, 9, 14, 23, 59, null],
        [2027, 9, 15, 0, 0, 'halloween'],
        [2027, 9, 31, 23, 59, 'halloween'],
        [2027, 10, 1, 23, 59, 'halloween'],
        [2027, 10, 2, 0, 0, null],
        [2027, 10, 7, 12, 0, null],
        [2028, 9, 15, 0, 0, 'halloween'],
        [2028, 10, 1, 23, 59, 'halloween'],
        [2028, 10, 2, 0, 0, null],
    ] as const)('uses local calendar boundaries (%s/%s/%s %s:%s)', (year, month, day, hour, minute, expected) => {
        expect(getSeasonalEvent(false, new Date(year, month, day, hour, minute))).toBe(expected);
    });

    it('recurs every year and honors the blanket opt out', () => {
        for (const halloween of [new Date(2026, 10, 7), new Date(2027, 10, 1)]) {
            expect(getSeasonalEvent(false, halloween)).toBe('halloween');
            expect(getSeasonalEvent(true, halloween)).toBeNull();
        }
        expect(getSeasonalEvent(false, new Date('invalid'))).toBeNull();
    });

    it('decorates the default icon while preserving custom icon choices', () => {
        expect(resolveSeasonalIconStyle('gsm', 'halloween')).toBe('gsm-halloween');
        expect(resolveSeasonalIconStyle('gsm', null)).toBe('gsm');
        expect(resolveSeasonalIconStyle('gsm_cute', 'halloween')).toBe('gsm_cute');
        expect(resolveSeasonalIconStyle('gsm_rare', 'halloween')).toBe('gsm_rare');
    });
});
