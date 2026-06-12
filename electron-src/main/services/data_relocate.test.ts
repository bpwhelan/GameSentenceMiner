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
});

describe('performDataMove', () => {
    it('moves data, skips venv/uv, and commits the pointer', async () => {
        const oldDir = getDefaultBaseDir(); // use default so the pointer logic is exercised
        fs.mkdirSync(path.join(oldDir, 'logs'), { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'config.json'), '{"a":1}', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'gsm.db'), 'db', 'utf-8');
        fs.writeFileSync(path.join(oldDir, 'logs', 'app.log'), 'log', 'utf-8');
        fs.mkdirSync(path.join(oldDir, 'python_venv'), { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'python_venv', 'pyvenv.cfg'), 'x', 'utf-8');
        fs.mkdirSync(path.join(oldDir, 'uv'), { recursive: true });

        const newDir = path.join(makeTempDir('gsm-target-'), 'data');
        await performDataMove(oldDir, newDir);

        // Moved entries exist at the new location.
        expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8')).toBe('{"a":1}');
        expect(fs.readFileSync(path.join(newDir, 'gsm.db'), 'utf-8')).toBe('db');
        expect(fs.readFileSync(path.join(newDir, 'logs', 'app.log'), 'utf-8')).toBe('log');

        // venv/uv are NOT copied (they get rebuilt).
        expect(fs.existsSync(path.join(newDir, 'python_venv'))).toBe(false);
        expect(fs.existsSync(path.join(newDir, 'uv'))).toBe(false);

        // Old copies + venv/uv are removed from the source.
        expect(fs.existsSync(path.join(oldDir, 'config.json'))).toBe(false);
        expect(fs.existsSync(path.join(oldDir, 'python_venv'))).toBe(false);
        expect(fs.existsSync(path.join(oldDir, 'uv'))).toBe(false);

        // Pointer committed and resolves to the new location.
        expect(fs.existsSync(getPointerFilePath())).toBe(true);
        expect(resolveDataDir()).toBe(path.resolve(newDir));
    });

    it('moves the legacy sibling overlay dir under the new data dir', async () => {
        const oldDir = getDefaultBaseDir();
        fs.mkdirSync(oldDir, { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'config.json'), '{}', 'utf-8');

        const overlayDir = path.join(process.env.APPDATA as string, 'gsm_overlay');
        fs.mkdirSync(overlayDir, { recursive: true });
        fs.writeFileSync(path.join(overlayDir, 'settings.json'), '{"fontSize":42}', 'utf-8');

        const newDir = path.join(makeTempDir('gsm-target2-'), 'data');
        await performDataMove(oldDir, newDir);

        expect(fs.readFileSync(path.join(newDir, 'gsm_overlay', 'settings.json'), 'utf-8')).toBe(
            '{"fontSize":42}',
        );
        expect(fs.existsSync(overlayDir)).toBe(false);
    });
});
