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

    it('builds one stable PyPI wheel per platform without legacy tokenizer payloads', () => {
        const workflow = fs.readFileSync(
            path.join(process.cwd(), '.github', 'workflows', 'pypi_release.yml'),
            'utf8'
        );

        expect(workflow).not.toContain('libmecab');
        expect(workflow).toContain('cibw_build: cp311-win_amd64');
        expect(workflow).toContain('cibw_build: cp311-manylinux_x86_64');
        expect(workflow).toContain('cibw_build: cp311-macosx_arm64');
        expect(workflow).toContain('CIBW_BUILD: ${{ matrix.cibw_build }}');
        expect(workflow).not.toContain('CIBW_BUILD: cp311-*');
        expect(workflow).not.toContain('CIBW_REPAIR_WHEEL_COMMAND_MACOS: ""');
        expect(workflow).not.toContain('CIBW_TEST_COMMAND:');
        expect(workflow).toContain('node scripts/smoke-test-wheel.mjs wheelhouse');
    });

    it('does not install beta backends from mutable branch archives', () => {
        const pythonOps = fs.readFileSync(
            path.join(process.cwd(), 'electron-src', 'main', 'services', 'python_ops.ts'),
            'utf8'
        );

        expect(pythonOps).not.toContain('/archive/refs/heads/');
    });
});
