import fs from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';

describe('prerelease build contract',()=>{
    it('records native prerelease metadata without building a backend wheel',()=>{
        const workflow=fs.readFileSync('.github/workflows/native_desktop.yml','utf8');
        expect(workflow).not.toContain('npm run build:qt-host');
        expect(workflow).toContain('scripts/write-prerelease-metadata.mjs --desktop-only');
        expect(workflow).toContain('if: inputs.prerelease');
        const preview=fs.readFileSync('.github/workflows/dev_release_exe.yml','utf8');
        expect(preview).toContain('prerelease: true');
        expect(preview).toContain('uses: ./.github/workflows/native_desktop.yml');
    });

    it('does not install beta backends from mutable branch archives', () => {
        const pythonOps = fs.readFileSync(
            path.join(process.cwd(), 'electron-src', 'main', 'services', 'python_ops.ts'),
            'utf8'
        );

        expect(pythonOps).not.toContain('/archive/refs/heads/');
    });
});
