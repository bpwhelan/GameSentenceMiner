import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real pointer logic but stub the Windows registry write (it shells out to reg.exe).
vi.mock('../data_dir.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../data_dir.js')>();
    return { ...actual, writeDataDirRegistry: vi.fn() };
});

import { performDataMove, validateTargetDir } from './data_relocate.js';
import { getDefaultBaseDir, getPointerFilePath, resolveDataDir } from '../data_dir.js';

const tempRoots: string[] = [];
let originalAppData: string | undefined;

function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
}

beforeEach(() => {
    originalAppData = process.env.APPDATA;
    // Default base dir lives under APPDATA; isolate it so the pointer file lands in a temp dir.
    process.env.APPDATA = makeTempDir('gsm-appdata-');
});

afterEach(() => {
    if (originalAppData === undefined) {
        delete process.env.APPDATA;
    } else {
        process.env.APPDATA = originalAppData;
    }
    for (const dir of tempRoots.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('validateTargetDir', () => {
    it('rejects the same directory', async () => {
        const dir = makeTempDir('gsm-same-');
        const result = await validateTargetDir(dir, dir);
        expect(result.ok).toBe(false);
    });

    it('rejects a target nested inside the current data dir', async () => {
        const dir = makeTempDir('gsm-nested-');
        const result = await validateTargetDir(dir, path.join(dir, 'inner'));
        expect(result.ok).toBe(false);
    });

    it('accepts a writable sibling directory', async () => {
        const oldDir = makeTempDir('gsm-old-');
        const newDir = path.join(makeTempDir('gsm-new-parent-'), 'data');
        const result = await validateTargetDir(oldDir, newDir);
        expect(result.ok).toBe(true);
    });

    it('rejects a destination that already contains GSM data without overwriting it', async () => {
        const oldDir = makeTempDir('gsm-old-');
        fs.writeFileSync(path.join(oldDir, 'config.json'), '{"source":true}', 'utf-8');
        const newDir = makeTempDir('gsm-existing-target-');
        fs.writeFileSync(path.join(newDir, 'config.json'), '{"keep":true}', 'utf-8');

        const result = await validateTargetDir(oldDir, newDir);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('config.json');
        expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8')).toBe('{"keep":true}');
    });
});

describe('performDataMove', () => {
    it('retargets managed OBS paths in the copied config without changing custom paths or the source', async () => {
        const oldDir = makeTempDir('gsm-source-');
        const managedObsPath = path.join(oldDir, 'obs-studio', 'bin', '64bit', 'obs64.exe');
        const customObsPath = path.join('D:\\', 'Apps', 'OBS', 'bin', '64bit', 'obs64.exe');
        const sourceConfig = {
            configs: {
                Managed: { obs: { obs_path: managedObsPath } },
                Custom: { obs: { obs_path: customObsPath } },
            },
        };
        fs.writeFileSync(path.join(oldDir, 'config.json'), JSON.stringify(sourceConfig), 'utf-8');

        const newDir = path.join(makeTempDir('gsm-target-'), 'data');
        await performDataMove(oldDir, newDir);

        const copiedConfig = JSON.parse(
            fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8'),
        );
        expect(copiedConfig.configs.Managed.obs.obs_path).toBe(
            path.join(newDir, 'obs-studio', 'bin', '64bit', 'obs64.exe'),
        );
        expect(copiedConfig.configs.Custom.obs.obs_path).toBe(customObsPath);
        expect(JSON.parse(fs.readFileSync(path.join(oldDir, 'config.json'), 'utf-8'))).toEqual(
            sourceConfig,
        );
    });

    it('copies only GSM configs and the database, keeps the source, and commits the pointer', async () => {
        const oldDir = getDefaultBaseDir(); // use default so the pointer logic is exercised
        fs.mkdirSync(path.join(oldDir, 'logs'), { recursive: true });
        fs.mkdirSync(path.join(oldDir, 'config'), { recursive: true });
        fs.mkdirSync(path.join(oldDir, 'ocr_config'), { recursive: true });
        fs.mkdirSync(path.join(oldDir, 'electron'), { recursive: true });
        fs.mkdirSync(path.join(oldDir, 'electron', 'Local Storage'), { recursive: true });
        fs.mkdirSync(path.join(oldDir, 'electron', 'Session Storage'), { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'config.json'), '{"a":1}', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'gsm.db'), 'db', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'gsm.db-wal'), 'wal', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'shared_config.json'), '{"port":1}', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'config', 'text_replacements.json'), '[]', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'ocr_config', 'game.json'), '{}', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'logs', 'app.log'), 'log', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'electron', 'config.json'), '{"theme":"dark"}', 'utf-8');
        fs.writeFileSync(
            path.join(oldDir, 'electron', 'overlay_settings.json'),
            '{"overlay":true}',
            'utf-8',
        );
        fs.writeFileSync(path.join(oldDir, 'electron', 'Preferences'), 'chromium', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'electron', 'Local Storage', 'state'), 'local', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'electron', 'Session Storage', 'state'), 'session', 'utf-8');
        fs.mkdirSync(path.join(oldDir, 'python_venv'), { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'python_venv', 'pyvenv.cfg'), 'x', 'utf-8');
        fs.mkdirSync(path.join(oldDir, 'uv'), { recursive: true });

        const newDir = path.join(makeTempDir('gsm-target-'), 'data');
        await performDataMove(oldDir, newDir);

        // GSM config and database artifacts are copied to the new location.
        expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8')).toBe('{"a":1}');
        expect(fs.readFileSync(path.join(newDir, 'gsm.db'), 'utf-8')).toBe('db');
        expect(fs.readFileSync(path.join(newDir, 'gsm.db-wal'), 'utf-8')).toBe('wal');
        expect(fs.readFileSync(path.join(newDir, 'shared_config.json'), 'utf-8')).toBe('{"port":1}');
        expect(fs.readFileSync(path.join(newDir, 'config', 'text_replacements.json'), 'utf-8')).toBe('[]');
        expect(fs.readFileSync(path.join(newDir, 'ocr_config', 'game.json'), 'utf-8')).toBe('{}');

        // Electron app configs are copied, but Chromium/session data is not.
        expect(fs.existsSync(path.join(newDir, 'logs'))).toBe(false);
        expect(fs.readFileSync(path.join(newDir, 'electron', 'config.json'), 'utf-8')).toBe(
            '{"theme":"dark"}',
        );
        expect(fs.readFileSync(path.join(newDir, 'electron', 'overlay_settings.json'), 'utf-8')).toBe(
            '{"overlay":true}',
        );
        expect(fs.existsSync(path.join(newDir, 'electron', 'Preferences'))).toBe(false);
        expect(fs.existsSync(path.join(newDir, 'electron', 'Local Storage'))).toBe(false);
        expect(fs.existsSync(path.join(newDir, 'electron', 'Session Storage'))).toBe(false);
        expect(fs.existsSync(path.join(newDir, 'python_venv'))).toBe(false);
        expect(fs.existsSync(path.join(newDir, 'uv'))).toBe(false);

        // Nothing is deleted from the source; cleanup is the user's responsibility.
        expect(fs.readFileSync(path.join(oldDir, 'config.json'), 'utf-8')).toBe('{"a":1}');
        expect(fs.readFileSync(path.join(oldDir, 'logs', 'app.log'), 'utf-8')).toBe('log');
        expect(fs.readFileSync(path.join(oldDir, 'electron', 'config.json'), 'utf-8')).toBe(
            '{"theme":"dark"}',
        );
        expect(fs.existsSync(path.join(oldDir, 'python_venv'))).toBe(true);
        expect(fs.existsSync(path.join(oldDir, 'uv'))).toBe(true);

        // Pointer committed and resolves to the new location.
        expect(fs.existsSync(getPointerFilePath())).toBe(true);
        expect(resolveDataDir()).toBe(path.resolve(newDir));
    });

    it('copies overlay settings while leaving Yomitan storage in place', async () => {
        const oldDir = getDefaultBaseDir();
        fs.mkdirSync(oldDir, { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'config.json'), '{}', 'utf-8');

        const overlayDir = path.join(process.env.APPDATA as string, 'gsm_overlay');
        fs.mkdirSync(overlayDir, { recursive: true });
        fs.mkdirSync(path.join(overlayDir, 'IndexedDB', 'yomitan'), { recursive: true });
        fs.writeFileSync(path.join(overlayDir, 'settings.json'), '{"fontSize":42}', 'utf-8');
        fs.writeFileSync(path.join(overlayDir, 'IndexedDB', 'yomitan', 'dict'), 'dictionary', 'utf-8');

        const newDir = path.join(makeTempDir('gsm-target2-'), 'data');
        await performDataMove(oldDir, newDir);

        expect(fs.readFileSync(path.join(newDir, 'gsm_overlay', 'settings.json'), 'utf-8')).toBe(
            '{"fontSize":42}',
        );
        expect(fs.existsSync(path.join(newDir, 'gsm_overlay', 'IndexedDB'))).toBe(false);
        expect(fs.readFileSync(path.join(overlayDir, 'settings.json'), 'utf-8')).toBe(
            '{"fontSize":42}',
        );
        expect(fs.readFileSync(path.join(overlayDir, 'IndexedDB', 'yomitan', 'dict'), 'utf-8')).toBe(
            'dictionary',
        );
    });

    it('copies OBS settings without startup markers or other runtime artifacts', async () => {
        const oldDir = makeTempDir('gsm-source-');
        const obsConfigDir = path.join(oldDir, 'obs-studio', 'config', 'obs-studio');
        fs.mkdirSync(path.join(obsConfigDir, '.sentinel'), { recursive: true });
        fs.mkdirSync(path.join(obsConfigDir, 'logs'), { recursive: true });
        fs.mkdirSync(
            path.join(obsConfigDir, 'plugin_config', 'advanced-scene-switcher'),
            { recursive: true },
        );
        fs.writeFileSync(path.join(oldDir, 'config.json'), '{}', 'utf-8');
        fs.writeFileSync(path.join(obsConfigDir, 'user.ini'), '[General]', 'utf-8');
        fs.writeFileSync(path.join(obsConfigDir, 'logs', 'current.txt'), 'log', 'utf-8');
        fs.writeFileSync(
            path.join(obsConfigDir, 'plugin_config', 'advanced-scene-switcher', '.running'),
            'running',
            'utf-8',
        );

        const newDir = path.join(makeTempDir('gsm-target-'), 'data');
        await performDataMove(oldDir, newDir);

        const copiedObsConfigDir = path.join(newDir, 'obs-studio', 'config', 'obs-studio');
        expect(fs.readFileSync(path.join(copiedObsConfigDir, 'user.ini'), 'utf-8')).toBe(
            '[General]',
        );
        expect(fs.existsSync(path.join(copiedObsConfigDir, '.sentinel'))).toBe(false);
        expect(fs.existsSync(path.join(copiedObsConfigDir, 'logs'))).toBe(false);
        expect(
            fs.existsSync(
                path.join(
                    copiedObsConfigDir,
                    'plugin_config',
                    'advanced-scene-switcher',
                    '.running',
                ),
            ),
        ).toBe(false);

        expect(fs.existsSync(path.join(obsConfigDir, '.sentinel'))).toBe(true);
        expect(fs.existsSync(path.join(obsConfigDir, 'logs', 'current.txt'))).toBe(true);
        expect(
            fs.existsSync(
                path.join(
                    obsConfigDir,
                    'plugin_config',
                    'advanced-scene-switcher',
                    '.running',
                ),
            ),
        ).toBe(true);
    });

    it('refuses to overwrite a destination file even if validation is skipped', async () => {
        const oldDir = makeTempDir('gsm-source-');
        fs.writeFileSync(path.join(oldDir, 'config.json'), '{"source":true}', 'utf-8');
        const newDir = makeTempDir('gsm-target-');
        fs.writeFileSync(path.join(newDir, 'config.json'), '{"keep":true}', 'utf-8');

        await expect(performDataMove(oldDir, newDir)).rejects.toThrow('config.json');

        expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8')).toBe('{"keep":true}');
        expect(fs.readFileSync(path.join(oldDir, 'config.json'), 'utf-8')).toBe('{"source":true}');
    });
});
