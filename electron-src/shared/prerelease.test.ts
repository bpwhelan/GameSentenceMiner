import { describe, expect, it } from 'vitest';

import { getPreReleaseArchiveUrl, parsePreReleaseMetadata } from './prerelease.js';

const COMMIT = '9c458553c662f7680faad08478655d06dd9e2e69';

describe('prerelease backend metadata', () => {
    it('pins the backend archive to the repository and commit that produced the app', () => {
        const metadata = parsePreReleaseMetadata({
            branch: 'feat/hoshidicts-v1',
            repository: 'bee-san/GameSentenceMiner',
            commit: COMMIT,
        });

        expect(metadata).toEqual({
            branch: 'feat/hoshidicts-v1',
            repository: 'bee-san/GameSentenceMiner',
            commit: COMMIT,
        });
        expect(
            getPreReleaseArchiveUrl(metadata, 'https://github.com/bpwhelan/GameSentenceMiner'),
        ).toBe(`https://github.com/bee-san/GameSentenceMiner/archive/${COMMIT}.zip`);
    });

    it('keeps legacy branch-only metadata compatible', () => {
        const metadata = parsePreReleaseMetadata({
            branch: 'develop/preview',
        });

        expect(
            getPreReleaseArchiveUrl(metadata, 'https://github.com/bpwhelan/GameSentenceMiner'),
        ).toBe(
            'https://github.com/bpwhelan/GameSentenceMiner/archive/refs/heads/develop/preview.zip',
        );
    });

    it('rejects malformed metadata instead of constructing an unsafe URL', () => {
        expect(
            parsePreReleaseMetadata({
                branch: '../main',
                repository: 'https://example.test/repo',
                commit: 'not-a-commit',
            }),
        ).toBeNull();
    });

    it('does not fall back to upstream when pinned source metadata is incomplete', () => {
        expect(
            parsePreReleaseMetadata({
                branch: 'feat/hoshidicts-v1',
                repository: 'bee-san/GameSentenceMiner',
                commit: 'not-a-commit',
            }),
        ).toBeNull();
        expect(
            parsePreReleaseMetadata({
                branch: 'feat/hoshidicts-v1',
                repository: '../GameSentenceMiner',
                commit: COMMIT,
            }),
        ).toBeNull();
    });
});
