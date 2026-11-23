import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('prerelease metadata writer', () => {
    it('writes desktop prerelease metadata without a wheel directory', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-prerelease-metadata-'));
        temporaryDirectories.push(directory);
        const output = path.join(directory, 'prerelease.json');

        execFileSync(process.execPath, [
            path.resolve('scripts/write-prerelease-metadata.mjs'), '--desktop-only',
            '--wheel-dir', path.join(directory, 'missing'), '--out', output,
            '--branch', 'develop', '--commit', '0123456789abcdef', '--version', '2026.11.0-beta.1',
        ]);

        const metadata = JSON.parse(fs.readFileSync(output, 'utf8'));
        expect(metadata).toMatchObject({
            branch: 'develop', commit: '0123456789abcdef', version: '2026.11.0-beta.1',
        });
        expect(metadata).not.toHaveProperty('backendWheel');
    });

    it('records the immutable wheel filename, commit, and digest', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-prerelease-metadata-'));
        temporaryDirectories.push(directory);
        const wheelPath = path.join(
            directory,
            'gamesentenceminer-2026.8.13b1-cp310-abi3-win_amd64.whl'
        );
        fs.writeFileSync(wheelPath, 'native wheel bytes');

        const { buildPreReleaseMetadata } = await import(
            '../../scripts/write-prerelease-metadata.mjs'
        );
        const metadata = buildPreReleaseMetadata({
            branch: 'develop',
            commit: '0123456789abcdef',
            version: '2026.8.13-beta.1',
            wheelPath,
            generatedAt: '2026-08-12T21:00:00.000Z',
        });

        expect(metadata).toMatchObject({
            schemaVersion: 2,
            branch: 'develop',
            commit: '0123456789abcdef',
            version: '2026.8.13-beta.1',
            backendWheel: {
                fileName: path.basename(wheelPath),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
        });
    });
});
