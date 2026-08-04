import { describe, expect, it } from 'vitest';

import { compareProvenance } from '../../scripts/verify-hoshidicts-provenance.mjs';

const expected = {
    source: {
        commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        files: {
            LICENSE: 'license-hash',
        },
    },
    dependencies: [
        {
            path: 'external/example',
            commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            licenseSha256: 'dependency-license-hash',
        },
    ],
};

function validObserved() {
    return {
        gitlinkCommit: expected.source.commit,
        sourceCommit: expected.source.commit,
        sourceDirty: false,
        sourceFiles: {
            LICENSE: 'license-hash',
        },
        dependencies: {
            'external/example': {
                state: ' ',
                commit: expected.dependencies[0].commit,
                dirty: false,
                licenseSha256: 'dependency-license-hash',
            },
        },
    };
}

describe('HoshiDicts provenance verification', () => {
    it('accepts the exact source, dependency, and license pins', () => {
        expect(compareProvenance(expected, validObserved())).toEqual([]);
    });

    it('rejects source commit and license drift', () => {
        const observed = validObserved();
        observed.sourceCommit = 'cccccccccccccccccccccccccccccccccccccccc';
        observed.sourceFiles.LICENSE = 'changed-license';

        expect(compareProvenance(expected, observed)).toEqual([
            'checked-out HoshiDicts commit is cccccccccccccccccccccccccccccccccccccccc; expected aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'source file LICENSE has SHA-256 changed-license; expected license-hash',
        ]);
    });

    it('rejects missing, dirty, or unexpected recursive dependencies', () => {
        const observed = validObserved();
        observed.dependencies['external/example'].state = '+';
        observed.dependencies['external/example'].dirty = true;
        observed.dependencies['external/unexpected'] = {
            state: ' ',
            commit: 'dddddddddddddddddddddddddddddddddddddddd',
            dirty: false,
            licenseSha256: 'unexpected',
        };

        expect(compareProvenance(expected, observed)).toEqual([
            'recursive submodule set is ["external/example","external/unexpected"]; expected ["external/example"]',
            'dependency external/example has submodule state "+"; expected a clean initialized checkout',
            'dependency external/example contains tracked worktree changes',
        ]);
    });

    it('rejects tracked changes in the selected source checkout', () => {
        const observed = validObserved();
        observed.sourceDirty = true;

        expect(compareProvenance(expected, observed)).toEqual([
            'checked-out HoshiDicts source contains tracked worktree changes',
        ]);
    });
});
