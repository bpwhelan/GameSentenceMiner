import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('renderer content security policy', () => {
    it('allows blob-backed pronunciation audio playback', () => {
        const html = fs.readFileSync(
            path.resolve(process.cwd(), 'electron-src/renderer/index.html'),
            'utf8'
        );
        const policy = html.match(
            /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u
        )?.[1];

        expect(policy).toBeDefined();
        expect(policy).toMatch(/(?:^|;)\s*media-src\s+[^;]*\bblob:/u);
    });
});
