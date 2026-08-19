import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    app: { isPackaged: false },
}));

import {
    defaultHoshidictsAudioProfile,
    defaultHoshidictsMiningProfile,
    HoshidictsManager,
} from './manager.js';

const temporaryDirectories: string[] = [];

function makeBaseDirectory(): string {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gsm-hoshidicts-backend-profiles-')
    );
    temporaryDirectories.push(directory);
    return directory;
}

function makeManager(
    baseDirectory: string,
    reloadNative: () => Promise<void> = async () => undefined
): HoshidictsManager {
    let sequence = 0;
    return new HoshidictsManager(baseDirectory, {
        now: () => new Date('2026-08-08T12:00:00.000Z'),
        randomId: () => `backend-profiles-${sequence++}`,
        reloadNative,
    });
}

async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as unknown;
}

afterEach(async () => {
    while (temporaryDirectories.length > 0) {
        const directory = temporaryDirectories.pop();
        if (directory) {
            await fsp.rm(directory, { recursive: true, force: true });
        }
    }
});

/**
 * Writes a manifest with one installed dictionary and two profiles that enable
 * different dictionaries, so switchProfile takes the native-reload path.
 */
async function writeTwoProfileRoot(baseDirectory: string): Promise<string> {
    const root = path.join(baseDirectory, 'dictionaries', 'hoshidicts');
    const dictionaryRoot = path.join(root, 'generations', 'alpha', 'gen-1');
    await fsp.mkdir(dictionaryRoot, { recursive: true });
    await Promise.all([
        fsp.writeFile(path.join(dictionaryRoot, '.hoshidicts_4'), 'marker'),
        fsp.writeFile(path.join(dictionaryRoot, 'hash.table'), 'hash-table'),
        fsp.writeFile(path.join(dictionaryRoot, 'bloom.filter'), 'bloom-filter'),
        fsp.writeFile(path.join(dictionaryRoot, 'blobs.bin'), 'blobs'),
        fsp.writeFile(
            path.join(dictionaryRoot, 'index.json'),
            JSON.stringify({
                title: 'Alpha',
                revision: 'rev-1',
                sourceLanguage: 'ja',
                isUpdatable: false,
                indexUrl: null,
                downloadUrl: null,
                counts: {
                    terms: { total: 1 },
                    termMeta: {},
                    kanji: { total: 0 },
                    media: { total: 0 },
                },
            })
        ),
    ]);

    const profile = (id: string, name: string, deck: string, enabled: string[]) => ({
        id,
        name,
        reader: {},
        mining: { ...defaultHoshidictsMiningProfile(), deck },
        audio: defaultHoshidictsAudioProfile(),
        tabGroups: [],
        enabledDictionaryIds: enabled,
    });

    await fsp.writeFile(
        path.join(root, 'manifest.json'),
        JSON.stringify({
            version: 1,
            activeProfileId: 'second',
            profiles: [
                profile('default', 'Default', 'Original deck', ['alpha']),
                profile('second', 'Second', 'Second deck', []),
            ],
            schedule: 'off',
            lastCheck: null,
            nextCheck: null,
            lastError: null,
            dictionaries: [
                {
                    id: 'alpha',
                    path: 'generations/alpha/gen-1',
                    enabled: false,
                    favorite: false,
                    displayName: null,
                    recommendedId: null,
                    title: 'Alpha',
                    revision: 'rev-1',
                    isUpdatable: false,
                    indexUrl: null,
                    downloadUrl: null,
                    language: 'ja',
                    termCount: 1,
                    frequencyCount: 0,
                    pitchCount: 0,
                    kanjiCount: 0,
                    frequencyMode: null,
                    installedAt: '2026-08-08T00:00:00.000Z',
                    updateScheduleOverride: null,
                    lastUpdateCheck: null,
                },
            ],
        })
    );
    return root;
}

// The Python backend loads dictionaries/hoshidicts/mining-profile.json and
// audio-profile.json from disk. Nothing else publishes them, so the manager has
// to keep them in step with the active profile in the manifest.
describe('Hoshidicts backend profile files', () => {
    it('publishes the active mining profile where the Python backend reads it', async () => {
        const baseDirectory = makeBaseDirectory();
        const manager = makeManager(baseDirectory);

        await manager.setMiningProfile({
            ...defaultHoshidictsMiningProfile(),
            enabled: true,
            deck: 'Mining',
            model: 'Japanese',
        });

        expect(await readJson(manager.miningProfilePath)).toMatchObject({
            version: 3,
            enabled: true,
            deck: 'Mining',
            model: 'Japanese',
        });
    });

    it('publishes the active audio profile where the Python backend reads it', async () => {
        const baseDirectory = makeBaseDirectory();
        const manager = makeManager(baseDirectory);

        await manager.setAudioProfile({
            ...defaultHoshidictsAudioProfile(),
            autoPlay: true,
        });

        expect(await readJson(manager.audioProfilePath)).toEqual({
            version: 1,
            autoPlay: true,
            sources: [],
        });
    });

    it('republishes both profiles after switching to another profile', async () => {
        const baseDirectory = makeBaseDirectory();
        const manager = makeManager(baseDirectory);

        await manager.setMiningProfile({
            ...defaultHoshidictsMiningProfile(),
            deck: 'Original',
        });
        const created = await manager.createProfile('Second');
        await manager.setMiningProfile({
            ...defaultHoshidictsMiningProfile(),
            deck: 'Second deck',
        });
        expect(await readJson(manager.miningProfilePath)).toMatchObject({
            deck: 'Second deck',
        });

        const original = created.profiles.find(({ name }) => name !== 'Second');
        expect(original).toBeDefined();
        await manager.switchProfile(original!.id);

        expect(await readJson(manager.miningProfilePath)).toMatchObject({
            deck: 'Original',
        });
    });

    it('backfills the profile files for an install that only has a manifest', async () => {
        const baseDirectory = makeBaseDirectory();
        const manager = makeManager(baseDirectory);
        await manager.setMiningProfile({
            ...defaultHoshidictsMiningProfile(),
            deck: 'Backfilled',
        });
        await fsp.rm(manager.miningProfilePath);
        await fsp.rm(manager.audioProfilePath);

        await manager.syncBackendProfiles();

        expect(await readJson(manager.miningProfilePath)).toMatchObject({
            deck: 'Backfilled',
        });
        expect(await readJson(manager.audioProfilePath)).toMatchObject({
            version: 1,
        });
    });
    // A failed native reload rolls the manifest back. The profile files must roll
    // back with it, or the backend keeps mining with the abandoned profile.
    it('republishes the restored profile when a native reload rolls the manifest back', async () => {
        const baseDirectory = makeBaseDirectory();
        await writeTwoProfileRoot(baseDirectory);
        let failReload = false;
        const manager = makeManager(baseDirectory, async () => {
            if (failReload) {
                throw new Error('native reload failed');
            }
        });

        // Publish the starting point: the active profile is "second".
        await manager.syncBackendProfiles();
        expect(await readJson(manager.miningProfilePath)).toMatchObject({
            deck: 'Second deck',
        });

        // Switching enables a dictionary, so this takes the native-reload path.
        failReload = true;
        await expect(manager.switchProfile('default')).rejects.toThrow(
            /reload failed/u
        );

        // The manifest rolled back to "second", so the published profile must too.
        expect(await readJson(manager.miningProfilePath)).toMatchObject({
            deck: 'Second deck',
        });
        expect((await manager.getSnapshot()).miningProfile.deck).toBe(
            'Second deck'
        );
    });

    // The profile files cap at 64 KiB to match the Python reader, well below the
    // manifest's 1 MiB. That must reject the save up front, not after committing.
    it('rejects an oversized mining profile without committing the manifest', async () => {
        const baseDirectory = makeBaseDirectory();
        const manager = makeManager(baseDirectory);
        await manager.setSchedule('weekly');
        const before = await fsp.readFile(
            path.join(baseDirectory, 'dictionaries', 'hoshidicts', 'manifest.json'),
            'utf8'
        );

        await expect(
            manager.setMiningProfile({
                ...defaultHoshidictsMiningProfile(),
                deck: 'Too big',
                fieldTemplates: Object.fromEntries(
                    Array.from({ length: 40 }, (_unused, index) => [
                        `field-${index}`,
                        { value: 'x'.repeat(2000), overwriteMode: 'coalesce' },
                    ])
                ),
            })
        ).rejects.toThrow('Hoshidicts mining profile exceeded its size limit.');

        // Nothing was written, so an unrelated later save still succeeds.
        expect(
            await fsp.readFile(
                path.join(baseDirectory, 'dictionaries', 'hoshidicts', 'manifest.json'),
                'utf8'
            )
        ).toBe(before);
        await expect(manager.setSchedule('daily')).resolves.toMatchObject({
            schedule: 'daily',
        });
    });
});
