import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('prerelease build contract', () => {
    it('packages overlay-server binaries built from the exact input-server source tree', () => {
        const prereleaseWorkflow = fs.readFileSync(
            path.join(process.cwd(), '.github', 'workflows', 'dev_release_exe.yml'),
            'utf8'
        );
        const overlayServerWorkflow = fs.readFileSync(
            path.join(process.cwd(), '.github', 'workflows', 'build_overlay_server.yml'),
            'utf8'
        );

        expect(prereleaseWorkflow).toContain(
            'git rev-parse HEAD:GSM_Overlay/input_server'
        );
        expect(prereleaseWorkflow).toContain('wait-for-overlay-server');
        expect(prereleaseWorkflow).toContain('overlay-server-source-tree.txt');
        expect(overlayServerWorkflow).toContain(
            'git rev-parse HEAD:GSM_Overlay/input_server'
        );
        expect(overlayServerWorkflow).toContain('overlay-server-source-tree.txt');
    });

    it('builds, bundles, and uploads a native backend wheel for every release platform', () => {
        const workflow = fs.readFileSync(
            path.join(process.cwd(), '.github', 'workflows', 'dev_release_exe.yml'),
            'utf8'
        );

        expect(workflow.match(/Build prerelease backend wheel/g)).toHaveLength(3);
        expect(workflow.match(/write-prerelease-metadata\.mjs/g)).toHaveLength(3);
        expect(workflow.match(/electron-src\/assets\/python\/\*\.whl/g)).toHaveLength(3);
    });

    it('builds one app-targeted wheel and skips whole-wheel native repair on Unix', () => {
        const workflow = fs.readFileSync(
            path.join(process.cwd(), '.github', 'workflows', 'dev_release_exe.yml'),
            'utf8'
        );

        expect(workflow).toContain('CIBW_BUILD: cp310-manylinux_x86_64');
        expect(workflow).toContain('CIBW_REPAIR_WHEEL_COMMAND_LINUX: ""');
        expect(workflow).toContain('CIBW_BUILD: cp310-macosx_arm64');
        expect(workflow).toContain('CIBW_REPAIR_WHEEL_COMMAND_MACOS: ""');
        expect(workflow.match(/CIBW_BUILD: cp310-\*/g)).toHaveLength(1);
    });

    it('builds one stable PyPI wheel per platform and repairs Linux without following MeCab', () => {
        const workflow = fs.readFileSync(
            path.join(process.cwd(), '.github', 'workflows', 'pypi_release.yml'),
            'utf8'
        );

        expect(workflow).toContain(
            'CIBW_REPAIR_WHEEL_COMMAND_LINUX: "auditwheel repair --exclude libmecab.so.1 -w {dest_dir} {wheel}"'
        );
        expect(workflow).toContain('cibw_build: cp310-win_amd64');
        expect(workflow).toContain('cibw_build: cp310-manylinux_x86_64');
        expect(workflow).toContain('cibw_build: cp310-macosx_arm64');
        expect(workflow).toContain('CIBW_BUILD: ${{ matrix.cibw_build }}');
        expect(workflow).not.toContain('CIBW_BUILD: cp310-*');
        expect(workflow).toContain('CIBW_REPAIR_WHEEL_COMMAND_MACOS: ""');
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
