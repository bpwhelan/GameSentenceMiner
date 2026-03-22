import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    computeStableVersion,
    computePreReleaseVersion,
} = require('../../scripts/compute-version.cjs') as {
    computeStableVersion: (options?: { now?: Date }) => string;
    computePreReleaseVersion: (options: {
        now?: Date;
        preReleaseId?: string;
        tags?: string[];
    }) => string;
};

describe('compute-version script', () => {
    it('uses the UTC calendar date for stable versions', () => {
        expect(computeStableVersion({ now: new Date('2026-03-17T23:59:59Z') })).toBe('2026.3.17');
    });

    it('starts beta prereleases from the UTC calendar date', () => {
        expect(
            computePreReleaseVersion({
                now: new Date('2026-03-17T04:00:00Z'),
                preReleaseId: 'beta',
                tags: ['v2026.3.14-beta.1', 'v2026.3.14-beta.2', 'v2026.3.16'],
            }),
        ).toBe('2026.3.17-beta.1');
    });

    it('increments beta prereleases that already exist for the same UTC date', () => {
        expect(
            computePreReleaseVersion({
                now: new Date('2026-03-17T12:00:00Z'),
                preReleaseId: 'beta',
                tags: ['v2026.3.17-beta.1', 'v2026.3.17-beta.4', 'v2026.3.17-rc.1'],
            }),
        ).toBe('2026.3.17-beta.5');
    });

    it('keeps pre-release counters isolated per preid', () => {
        expect(
            computePreReleaseVersion({
                now: new Date('2026-03-17T12:00:00Z'),
                preReleaseId: 'rc',
                tags: ['v2026.3.17-beta.1', 'v2026.3.17-rc.2'],
            }),
        ).toBe('2026.3.17-rc.3');
    });
});
