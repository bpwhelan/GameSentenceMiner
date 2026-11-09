import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('os', async (original) => ({
    ...await original<typeof import('os')>(), homedir: vi.fn(),
}));
import {
    getDefaultBaseDir, getPointerFilePath, getProfileDir, resolveDataDir,
    resolveSharedDataDir, writeDataDirPointer, isLegacyDatabaseMigrationPending,
} from './data_dir.js';

let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-profile-'));
    vi.mocked(os.homedir).mockReturnValue(path.join(root, 'home'));
    vi.stubEnv('APPDATA', path.join(root, 'appdata'));
    vi.stubEnv('GSM_PROFILE_DIR', '');
    vi.stubEnv('GSM_SHARED_DATA_DIR', '');
});
afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('portable profiles', () => {
    it.each(['-profile', '--profile'])('accepts %s with relative, spaced and Unicode paths', (flag) => {
        expect(getProfileDir([flag, 'profiles/日本語 GSM'], {}, root))
            .toBe(path.join(root, 'profiles', '日本語 GSM'));
        expect(getProfileDir([`${flag}=~/GSM profile`], {}, root))
            .toBe(path.join(os.homedir(), 'GSM profile'));
    });

    it.each([['-profile'], ['--profile='], ['-profile', '--other'], ['-profile', ' ']])(
        'rejects a missing profile folder: %j', (...args) => {
            expect(() => getProfileDir(args, {}, root)).toThrow(/profile/i);
        },
    );

    it('prefers a command-line profile to the inherited profile', () => {
        expect(getProfileDir(['-profile', 'new'], { GSM_PROFILE_DIR: path.join(root, 'old') }, root))
            .toBe(path.join(root, 'new'));
    });

    it('uses only the profile for mutable data even with a broken saved location', () => {
        fs.mkdirSync(path.dirname(getPointerFilePath()), { recursive: true });
        fs.writeFileSync(getPointerFilePath(), 'broken');
        vi.stubEnv('GSM_PROFILE_DIR', path.join(root, 'profile'));
        expect(resolveDataDir()).toBe(path.join(root, 'profile'));
        expect(isLegacyDatabaseMigrationPending(resolveDataDir())).toBe(false);
        expect(() => writeDataDirPointer(path.join(root, 'other'))).toThrow(/profile/i);
        expect(fs.readFileSync(getPointerFilePath(), 'utf8')).toBe('broken');
    });

    it('reuses the normal installation without migrating its legacy pointer', () => {
        const shared = path.join(root, 'moved');
        const legacy = path.join(getDefaultBaseDir(), 'data_dir.json');
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, JSON.stringify({ dataDir: shared }));
        vi.stubEnv('GSM_PROFILE_DIR', path.join(root, 'profile'));
        expect(resolveDataDir()).toBe(path.join(root, 'profile'));
        expect(resolveSharedDataDir()).toBe(shared);
        expect(fs.existsSync(getPointerFilePath())).toBe(false);
    });

    it('shares the original runtime folder when no relocation exists', () => {
        vi.stubEnv('GSM_PROFILE_DIR', path.join(root, 'profile'));
        expect(resolveSharedDataDir()).toBe(getDefaultBaseDir());
        expect(fs.existsSync(getPointerFilePath())).toBe(false);
    });
});
