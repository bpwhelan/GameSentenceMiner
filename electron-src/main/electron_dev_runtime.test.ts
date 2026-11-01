import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const resedit = createRequire(require.resolve('app-builder-lib/package.json'))('resedit');
const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('development Electron runtime', () => {
    it('brands a separate executable, preserves Electron, caches it, and refreshes changed branding', async () => {
        const { ensureDevElectron } = require('../../scripts/electron-dev-runtime.cjs');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-dev-runtime-'));
        tempDirs.push(directory);
        const sourceDirectory = path.join(directory, 'dist');
        fs.mkdirSync(path.join(sourceDirectory, 'resources'), { recursive: true });
        const electronBinary = path.join(sourceDirectory, 'electron.exe');
        fs.writeFileSync(path.join(sourceDirectory, 'resources', 'default_app.asar'), 'default app');
        fs.writeFileSync(path.join(sourceDirectory, 'ffmpeg.dll'), 'matching library');
        const original = Buffer.from(resedit.NtExecutable.createEmpty(false, false).generate());
        fs.writeFileSync(electronBinary, original);
        const options = {
            platform: 'win32', electronBinary,
            iconPath: path.resolve('electron-src/assets/gsm.ico'),
            productName: 'GameSentenceMiner', version: '2026.10.3',
        };
        const branded = await ensureDevElectron(options);
        expect(branded).toBe(path.join(directory, 'gsm-dev-runtime', 'electron.exe'));
        expect(fs.readFileSync(electronBinary)).toEqual(original);
        expect(fs.readFileSync(path.join(path.dirname(branded), 'resources', 'default_app.asar'), 'utf8')).toBe('default app');
        expect(fs.readFileSync(path.join(path.dirname(branded), 'ffmpeg.dll'), 'utf8')).toBe('matching library');

        const readResources = () => resedit.NtExecutableResource.from(
            resedit.NtExecutable.from(fs.readFileSync(branded)),
        );
        const resources = readResources();
        const version = resedit.Resource.VersionInfo.fromEntries(resources.entries)[0];
        expect(version.getStringValues({ lang: 1033, codepage: 1200 })).toMatchObject({
            FileDescription: 'GameSentenceMiner', ProductName: 'GameSentenceMiner',
            OriginalFilename: 'electron.exe',
        });
        const group = resedit.Resource.IconGroupEntry.fromEntries(resources.entries)[0];
        const expectedIcons = resedit.Data.IconFile.from(fs.readFileSync(options.iconPath)).icons;
        const iconBytes = (icon: { bin?: ArrayBuffer; generate?: () => ArrayBuffer }) =>
            Buffer.from(icon.bin ?? icon.generate!());
        expect(group.getIconItemsFromEntries(resources.entries).map(iconBytes))
            .toEqual(expectedIcons.map((icon: { data: Parameters<typeof iconBytes>[0] }) => iconBytes(icon.data)));

        // A cache hit must not rewrite an executable that may already be running.
        const before = fs.statSync(branded).mtimeMs;
        expect(await ensureDevElectron(options)).toBe(branded);
        expect(fs.statSync(branded).mtimeMs).toBe(before);
        await ensureDevElectron({ ...options, productName: 'GSM test' });
        expect(resedit.Resource.VersionInfo.fromEntries(readResources().entries)[0]
            .getStringValues({ lang: 1033, codepage: 1200 }).ProductName).toBe('GSM test');
    });

    it('uses the original runtime on other platforms', async () => {
        const { ensureDevElectron } = require('../../scripts/electron-dev-runtime.cjs');
        expect(await ensureDevElectron({ platform: 'linux', electronBinary: '/electron' })).toBe('/electron');
        expect(await ensureDevElectron({ platform: 'darwin', electronBinary: '/Electron.app' })).toBe('/Electron.app');
    });
});
