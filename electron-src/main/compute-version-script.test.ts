import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    computeStableVersion,
    computePreReleaseVersion,
} = require('../../scripts/compute-version.cjs') as {
    computeStableVersion: (options?: { tags?: string[] }) => string;
    computePreReleaseVersion: (options: {
        preReleaseId?: string;
        tags?: string[];
    }) => string;
};

describe('compute-version script', () => {
    it('increments the patch segment from the latest stable release tag', () => {
        expect(computeStableVersion({ tags: ['v2026.3.22.2', 'v2026.3.23', 'v2026.3.23-beta.2'] })).toBe(
            '2026.3.24',
        );
    });

    it('starts beta prereleases from the next patch after the latest stable release', () => {
        expect(
            computePreReleaseVersion({
                preReleaseId: 'beta',
                tags: ['v2026.3.22.2', 'v2026.3.22-beta.2', 'v2026.3.23'],
            }),
        ).toBe('2026.3.24-beta.1');
    });

    it('increments beta prereleases that already exist for the next patch version', () => {
        expect(
            computePreReleaseVersion({
                preReleaseId: 'beta',
                tags: ['v2026.3.22.2', 'v2026.3.22.3-beta.1', 'v2026.3.22.3-beta.4', 'v2026.3.22.3-rc.1'],
            }),
        ).toBe('2026.3.22.3-beta.5');
    });

    it('keeps pre-release counters isolated per preid', () => {
        expect(
            computePreReleaseVersion({
                preReleaseId: 'rc',
                tags: ['v2026.3.22.2', 'v2026.3.22.3-beta.1', 'v2026.3.22.3-rc.2'],
            }),
        ).toBe('2026.3.22.3-rc.3');
    });
});
