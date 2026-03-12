import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Electron build configuration', () => {
    it('compiles and packages shared modules used by the main process', () => {
        const repoRoot = process.cwd();
        const electronTsconfig = JSON.parse(
            fs.readFileSync(path.join(repoRoot, 'tsconfig.electron.json'), 'utf8'),
        ) as { exclude?: string[]; include?: string[] };
        const packageJson = JSON.parse(
            fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
        ) as { build?: { files?: string[] } };

        expect(electronTsconfig.include).toContain('electron-src/shared/**/*');
        expect(electronTsconfig.exclude).toEqual(
            expect.arrayContaining(['electron-src/main/**/*.test.ts', 'electron-src/main/test/**/*']),
        );
        expect(packageJson.build?.files).toContain('dist/shared/**/*');
    });
});
