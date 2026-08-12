import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('prerelease build contract', () => {
    it('builds, bundles, and uploads a native backend wheel for every release platform', () => {
        const workflow = fs.readFileSync(
            path.join(process.cwd(), '.github', 'workflows', 'dev_release_exe.yml'),
            'utf8'
        );

        expect(workflow.match(/Build prerelease backend wheel/g)).toHaveLength(3);
        expect(workflow.match(/write-prerelease-metadata\.mjs/g)).toHaveLength(3);
        expect(workflow.match(/electron-src\/assets\/python\/\*\.whl/g)).toHaveLength(3);
    });

    it('does not install beta backends from mutable branch archives', () => {
        const pythonOps = fs.readFileSync(
            path.join(process.cwd(), 'electron-src', 'main', 'services', 'python_ops.ts'),
            'utf8'
        );

        expect(pythonOps).not.toContain('/archive/refs/heads/');
    });
});
