import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createObsSettingsSnapshot } from './obs_settings_snapshot.js';

let directory: string;
let config: string;
let backups: string;

beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-obs-snapshot-'));
    config = path.join(directory, 'obs-config');
    backups = path.join(directory, 'backups');
});

afterEach(async () => {
    vi.useRealTimers();
    // directory is the absolute path returned by mkdtemp for this test alone.
    await fs.rm(directory, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<void> {
    const file = path.join(config, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
}

describe('OBS settings snapshots', () => {
    it('preserves scene and recording files exactly without copying runtime logs', async () => {
        const scene = '{"name":"Sentence Mining","sources":[{"name":"日本語"}]}';
        await write('basic/scenes/Sentence_Mining.json', scene);
        await write('basic/profiles/GSM/basic.ini', '[SimpleOutput]\nRecRBTime=180\n');
        await write('user.ini', '[Basic]\nProfile=GSM\n');
        await write('global.ini', '[General]\nFirstRun=true\n');
        await write('logs/session.log', 'unneeded runtime log');
        const snapshot = await createObsSettingsSnapshot(config, backups, 'before-close');
        expect(snapshot?.fileCount).toBe(4);
        expect(await fs.readFile(path.join(snapshot!.path, 'basic/scenes/Sentence_Mining.json'), 'utf-8')).toBe(scene);
        expect(await fs.readFile(path.join(snapshot!.path, 'basic/profiles/GSM/basic.ini'), 'utf-8'))
            .toBe('[SimpleOutput]\nRecRBTime=180\n');
        expect(await fs.readdir(snapshot!.path)).not.toContain('logs');
        const manifest = JSON.parse(await fs.readFile(path.join(snapshot!.path, 'snapshot.json'), 'utf-8'));
        expect(manifest.reason).toBe('before-close');
    });

    it('keeps the earlier settings after OBS saves a changed scene collection', async () => {
        await write('basic/scenes/Game.json', '{"sources":["old game"]}');
        const before = await createObsSettingsSnapshot(config, backups, 'before-close');
        await write('basic/scenes/Game.json', '{"sources":[]}');
        const after = await createObsSettingsSnapshot(config, backups, 'after-close');
        expect(before?.path).not.toBe(after?.path);
        expect(await fs.readFile(path.join(before!.path, 'basic/scenes/Game.json'), 'utf-8'))
            .toBe('{"sources":["old game"]}');
        expect(await fs.readFile(path.join(after!.path, 'basic/scenes/Game.json'), 'utf-8'))
            .toBe('{"sources":[]}');
    });

    it('rotates only its own old snapshots and preserves unrelated backup directories', async () => {
        await write('user.ini', '[Basic]\nProfile=GSM\n');
        await fs.mkdir(path.join(backups, 'manual-backup'), { recursive: true });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-20T01:00:00Z'));
        const first = await createObsSettingsSnapshot(config, backups, 'before-close', { keepCount: 2 });
        vi.setSystemTime(new Date('2026-10-20T02:00:00Z'));
        const second = await createObsSettingsSnapshot(config, backups, 'after-close', { keepCount: 2 });
        vi.setSystemTime(new Date('2026-10-20T03:00:00Z'));
        const third = await createObsSettingsSnapshot(config, backups, 'before-launch', { keepCount: 2 });
        await expect(fs.access(first!.path)).rejects.toThrow();
        await expect(fs.access(second!.path)).resolves.toBeUndefined();
        await expect(fs.access(third!.path)).resolves.toBeUndefined();
        await expect(fs.access(path.join(backups, 'manual-backup'))).resolves.toBeUndefined();
    });

    it('does not create a misleading empty snapshot for a fresh installation', async () => {
        expect(await createObsSettingsSnapshot(config, backups, 'before-launch')).toBeNull();
        await expect(fs.access(backups)).rejects.toThrow();
    });

    it('preserves GSM scene rules alongside their matching OBS collection', async () => {
        await write('basic/scenes/Game.json', '{"name":"Game"}');
        const settings = path.join(directory, 'electron.json');
        const contents = '{"windowSceneSwitcher":{"collections":[{"rules":[{"sceneName":"Game"}]}]}}';
        await fs.writeFile(settings, contents, 'utf-8');
        const snapshot = await createObsSettingsSnapshot(config, backups, 'before-close', {
            relatedFiles: [{ sourcePath: settings, snapshotPath: 'gsm/electron-config.json' }],
        });
        expect(snapshot?.fileCount).toBe(2);
        expect(await fs.readFile(path.join(snapshot!.path, 'gsm/electron-config.json'), 'utf-8')).toBe(contents);
    });
});
