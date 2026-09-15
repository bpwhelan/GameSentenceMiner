import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return { ...actual, homedir: vi.fn(actual.homedir) };
});
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
    vi.mocked(os.homedir).mockReturnValue(path.join(dir, 'home'));
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
        fs.mkdirSync(path.dirname(getPointerFilePath()), { recursive: true });
        fs.writeFileSync(getPointerFilePath(), JSON.stringify({ dataDir: target }), 'utf-8');
        expect(resolveDataDir()).toBe(target);
    });

    it('reports an invalid saved location instead of silently resetting data', () => {
        fs.mkdirSync(path.dirname(getPointerFilePath()), { recursive: true });
        fs.writeFileSync(getPointerFilePath(), JSON.stringify({ dataDir: '   ' }), 'utf-8');
        expect(() => resolveDataDir()).toThrow('data_dir.json');
    });

    it('reports malformed saved JSON instead of silently resetting data', () => {
        fs.mkdirSync(path.dirname(getPointerFilePath()), { recursive: true });
        fs.writeFileSync(getPointerFilePath(), 'not json', 'utf-8');
        expect(() => resolveDataDir()).toThrow('data_dir.json');
    });

    it('stores the pointer outside AppData and survives deletion of the original folder', () => {
        expect(getPointerFilePath()).toBe(path.join(os.homedir(), '.config', 'GameSentenceMiner', 'data_dir.json'));
        const legacy = path.join(getDefaultBaseDir(), 'data_dir.json');
        const target = path.join(os.homedir(), '日本語 GSM');
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, '\uFEFF' + JSON.stringify({ dataDir: target }));
        expect(resolveDataDir()).toBe(target);
        expect(JSON.parse(fs.readFileSync(getPointerFilePath(), 'utf8'))).toMatchObject({
            dataDir: target, version: 2, legacyDatabaseDir: getDefaultBaseDir(),
        });
        fs.rmSync(getDefaultBaseDir(), { recursive: true });
        expect(resolveDataDir()).toBe(target);
    });

    it('prefers the stable pointer over a stale legacy pointer', () => {
        fs.mkdirSync(getDefaultBaseDir(), { recursive: true });
        fs.writeFileSync(path.join(getDefaultBaseDir(), 'data_dir.json'), JSON.stringify({ dataDir: path.join(os.homedir(), 'old') }));
        writeDataDirPointer(path.join(os.homedir(), 'new'));
        expect(resolveDataDir()).toBe(path.join(os.homedir(), 'new'));
        writeDataDirPointer(getDefaultBaseDir());
        expect(resolveDataDir()).toBe(getDefaultBaseDir());
    });

    it('rejects relative paths', () => {
        expect(() => writeDataDirPointer('relative/data')).toThrow();
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

    it('records an explicit default so an old pointer cannot become active again', () => {
        writeDataDirPointer(path.join(os.tmpdir(), 'gsm-custom-loc'));
        expect(fs.existsSync(getPointerFilePath())).toBe(true);
        writeDataDirPointer(getDefaultBaseDir());
        expect(fs.existsSync(getPointerFilePath())).toBe(true);
        expect(resolveDataDir()).toBe(getDefaultBaseDir());
    });
});
