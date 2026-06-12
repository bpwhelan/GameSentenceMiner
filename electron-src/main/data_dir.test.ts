import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    getDefaultBaseDir,
    getPointerFilePath,
    resolveDataDir,
    writeDataDirPointer,
} from './data_dir.js';

const tempDirs: string[] = [];
let originalAppData: string | undefined;

beforeEach(() => {
    originalAppData = process.env.APPDATA;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-datadir-test-'));
    tempDirs.push(dir);
    // getDefaultBaseDir() keys off APPDATA on Windows; point it at a throwaway dir.
    process.env.APPDATA = dir;
});

afterEach(() => {
    if (originalAppData === undefined) {
        delete process.env.APPDATA;
    } else {
        process.env.APPDATA = originalAppData;
    }
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('resolveDataDir', () => {
    it('returns the default location when no pointer file exists', () => {
        expect(resolveDataDir()).toBe(getDefaultBaseDir());
    });

    it('returns the dir recorded in the pointer file', () => {
        const target = path.join(os.tmpdir(), 'gsm-relocated-xyz');
        fs.mkdirSync(getDefaultBaseDir(), { recursive: true });
        fs.writeFileSync(getPointerFilePath(), JSON.stringify({ dataDir: target }), 'utf-8');
        expect(resolveDataDir()).toBe(target);
    });

    it('falls back to the default when the pointer is empty', () => {
        fs.mkdirSync(getDefaultBaseDir(), { recursive: true });
        fs.writeFileSync(getPointerFilePath(), JSON.stringify({ dataDir: '   ' }), 'utf-8');
        expect(resolveDataDir()).toBe(getDefaultBaseDir());
    });

    it('falls back to the default when the pointer is malformed JSON', () => {
        fs.mkdirSync(getDefaultBaseDir(), { recursive: true });
        fs.writeFileSync(getPointerFilePath(), 'not json', 'utf-8');
        expect(resolveDataDir()).toBe(getDefaultBaseDir());
    });
});

describe('backward compatibility (existing/new installs unaffected)', () => {
    // The exact expression BASE_DIR / get_app_directory used before this feature existed.
    function legacyBaseDir(): string {
        return process.env.APPDATA
            ? path.join(process.env.APPDATA, 'GameSentenceMiner')
            : path.join(os.homedir(), '.config', 'GameSentenceMiner');
    }

    it('default base dir is byte-for-byte the legacy hardcoded location', () => {
        expect(getDefaultBaseDir()).toBe(legacyBaseDir());
    });

    it('with no pointer file and no env override, resolves to the legacy location', () => {
        // No pointer written (fresh/existing install) -> identical to pre-feature behavior.
        expect(fs.existsSync(getPointerFilePath())).toBe(false);
        expect(resolveDataDir()).toBe(legacyBaseDir());
    });
});

describe('writeDataDirPointer', () => {
    it('writes the pointer for a custom location', () => {
        const target = path.join(os.tmpdir(), 'gsm-custom-loc');
        writeDataDirPointer(target);
        const parsed = JSON.parse(fs.readFileSync(getPointerFilePath(), 'utf-8'));
        expect(parsed.dataDir).toBe(target);
        expect(resolveDataDir()).toBe(target);
    });

    it('removes the pointer when set back to the default location', () => {
        writeDataDirPointer(path.join(os.tmpdir(), 'gsm-custom-loc'));
        expect(fs.existsSync(getPointerFilePath())).toBe(true);
        writeDataDirPointer(getDefaultBaseDir());
        expect(fs.existsSync(getPointerFilePath())).toBe(false);
        expect(resolveDataDir()).toBe(getDefaultBaseDir());
    });
});
