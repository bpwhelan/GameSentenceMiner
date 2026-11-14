import * as fs from 'node:fs';
import {describe, expect, it} from 'vitest';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const bundle = JSON.parse(fs.readFileSync('src-tauri/tauri.bundle.conf.json', 'utf8'));

describe('native desktop distribution contract', () => {
    it('uses the native launcher for normal and watched development', () => {
        expect(packageJson.scripts.start).toContain('scripts/start-tauri.mjs');
        expect(packageJson.scripts.dev).toContain('dev:desktop');
        expect(packageJson.scripts['dev:desktop']).toContain('scripts/build-native-dev.mjs');
        expect(packageJson.scripts['dev:desktop']).not.toContain('electron');
    });

    it('keeps Electron outside production dependencies and bundles one owned service tree', () => {
        for (const name of ['electron', 'electron-log', 'electron-store', 'electron-updater', 'electron-builder']) {
            expect(packageJson.dependencies[name]).toBeUndefined();
        }
        expect(bundle.bundle.resources).toEqual({'../build/native-desktop/app/': 'app/'});
        const compiler = JSON.parse(fs.readFileSync('tsconfig.electron.json', 'utf8'));
        expect(compiler.include).toContain('electron-src/shared/**/*');
        expect(compiler.exclude).toContain('electron-src/main/**/*.test.ts');
    });

    it('preserves installation identity and requires version-bound signed updates', () => {
        expect(config.identifier).toBe('com.beangate.gamesentenceminer');
        expect(config.plugins.updater.requireSignedVersion).toBe(true);
        const publicKey = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8');
        expect(publicKey).toMatch(/^untrusted comment: minisign public key/);
        expect(bundle.bundle.windows.nsis.installerHooks).toBe('windows-installer.nsh');
    });

    it('keeps local packaging separate from coordinated publication', () => {
        expect(packageJson.scripts['app:dist']).toContain('build-native-desktop.mjs');
        expect(packageJson.scripts['app:deploy']).toBeUndefined();
        const release = fs.readFileSync('.github/workflows/native_desktop.yml', 'utf8');
        for (const platform of ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64']) expect(release).toContain(platform);
        expect(release).toContain('needs: [version, build]');
        expect(release).toContain('scripts/merge-native-updates.mjs');
        expect(release).toContain('scripts/sign-native-assets.mjs');
    });

    it('lets CMake select the installed Visual Studio generator for Windows speech helpers', () => {
        const source = fs.readFileSync('scripts/build-windows-speech-helper.mjs', 'utf8');
        expect(source).not.toContain('Visual Studio 17 2022');
        expect(source).not.toContain("'-A', 'x64'");
    });
});
