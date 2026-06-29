import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateConfiguration } from 'app-builder-lib/out/util/config/config.js';
import { describe, expect, it } from 'vitest';

describe('Electron build configuration', () => {
    it('compiles and packages shared modules used by the main process', () => {
        const repoRoot = process.cwd();
        const electronTsconfig = JSON.parse(
            fs.readFileSync(path.join(repoRoot, 'tsconfig.electron.json'), 'utf8'),
        ) as { exclude?: string[]; include?: string[] };
        const packageJson = JSON.parse(
            fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
        ) as { build?: { files?: string[] }; main?: string };

        expect(packageJson.main).toBe('dist/main/bootstrap.js');
        expect(electronTsconfig.include).toContain('electron-src/shared/**/*');
        expect(electronTsconfig.exclude).toEqual(
            expect.arrayContaining(['electron-src/main/**/*.test.ts', 'electron-src/main/test/**/*']),
        );
        expect(packageJson.build?.files).toContain('dist/shared/**/*');
    });

    it('packages staged overlay resources so the nested app shares the outer Electron runtime', () => {
        const repoRoot = process.cwd();
        const packageJson = JSON.parse(
            fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
        ) as {
            build?: { extraFiles?: Array<{ from?: string; filter?: string[]; to?: string }> };
            scripts?: Record<string, string>;
        };

        const overlayCopy = packageJson.build?.extraFiles?.find(
            (entry) => entry.from === 'build/overlay',
        );

        expect(packageJson.scripts?.['stage:overlay']).toBe('node scripts/stage-overlay-build.mjs');
        expect(packageJson.scripts?.['verify:overlay-package']).toBe('node scripts/verify-overlay-package.mjs');
        expect(packageJson.scripts?.['app:dist']).toContain('npm run stage:overlay');
        expect(overlayCopy).toBeDefined();
        expect(overlayCopy?.to).toBe('resources/GSM_Overlay');
        expect(overlayCopy?.filter).toEqual(['**/*']);
    });

    it('uses an electron-builder configuration accepted by the installed schema', async () => {
        const repoRoot = process.cwd();
        const packageJson = JSON.parse(
            fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
        ) as { build?: Parameters<typeof validateConfiguration>[0]; scripts?: Record<string, string> };

        expect(packageJson.build).toBeDefined();
        await validateConfiguration(packageJson.build!, {
            isEnabled: false,
            add: () => undefined,
        });
    });

    it('keeps release upload explicit instead of relying on CI auto-publish', () => {
        const repoRoot = process.cwd();
        const packageJson = JSON.parse(
            fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
        ) as { scripts?: Record<string, string> };

        expect(packageJson.scripts?.['app:dist']).toContain('--publish=never');
        expect(packageJson.scripts?.['app:deploy']).toContain('--publish=always');
    });
});
