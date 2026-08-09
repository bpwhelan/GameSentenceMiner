import archiver from 'archiver';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    HOSHIDICTS_MINING_FIELD_MARKERS,
    MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH,
    MAX_HOSHIDICTS_TAB_GROUPS_BYTES,
} from '../../../shared/features/hoshidicts.js';

vi.mock('electron', () => ({
    app: { isPackaged: false },
}));
import {
    defaultHoshidictsAudioProfile,
    defaultHoshidictsMiningProfile,
    HOSHIDICTS_CUSTOM_DICTIONARY_ID,
    HOSHIDICTS_CUSTOM_DICTIONARY_TITLE,
    HoshidictsManager,
    inspectHoshidictsArchive,
    normalizeHoshidictsMiningProfile,
    normalizeHoshidictsAudioProfile,
    RECOMMENDED_HOSHIDICTS_DICTIONARIES,
    type ArchiveInspection,
    type HoshidictsImportReport,
    type HoshidictsManagerDependencies,
    type HoshidictsRemoteIndex,
} from './manager.js';

interface TestArchive {
    title: string;
    revision: string;
    sourceLanguage?: string | null;
    japanese?: boolean;
    terms?: number;
    frequencies?: number;
    pitches?: number;
    kanji?: number;
    frequencyMode?: 'occurrence-based' | 'rank-based' | null;
    media?: number;
    omitGeneratedMediaCount?: boolean;
    isUpdatable?: boolean;
    indexUrl?: string;
    downloadUrl?: string;
}

type RecommendedDictionary =
    (typeof RECOMMENDED_HOSHIDICTS_DICTIONARIES)[number];

function archiveForRecommended(
    recommended: RecommendedDictionary
): TestArchive {
    const titles: Record<RecommendedDictionary['id'], string> = {
        jitendex: 'Jitendex.org [2026-08-08]',
        jmdict: 'JMdict [2026-08-08]',
        jmnedict: 'JMnedict [2026-08-08]',
        bccwj: 'BCCWJ',
        'jpdbv2-kana': 'JPDBv2㋕',
        jiten: 'Jiten',
        'kanjium-pitch': 'Kanjium Pitch Accents',
        kanjidic: 'KANJIDIC [2026-220]',
    };
    const title =
        recommended.expectedTitle ?? titles[recommended.id];
    return {
        title,
        revision: `${recommended.id}.2026-08-08`,
        sourceLanguage: 'ja',
        terms: recommended.kind === 'term' ? 1 : 0,
        frequencies: recommended.kind === 'frequency' ? 1 : 0,
        pitches: recommended.kind === 'pitch' ? 1 : 0,
        kanji: recommended.kind === 'kanji' ? 1 : 0,
        isUpdatable: recommended.indexUrl !== null,
        indexUrl: recommended.indexUrl ?? undefined,
        downloadUrl: recommended.downloadUrl,
    };
}

function writeRecommendedArchive(
    outputPath: string,
    recommended: RecommendedDictionary
): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
        outputPath,
        JSON.stringify(archiveForRecommended(recommended)),
        'utf8'
    );
}

const tempDirs: string[] = [];

function makeTempDir(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-hoshidicts-'));
    tempDirs.push(directory);
    return directory;
}

function writeArchive(root: string, fileName: string, archive: TestArchive): string {
    const archivePath = path.join(root, fileName);
    fs.writeFileSync(archivePath, JSON.stringify(archive), 'utf8');
    return archivePath;
}

function readArchive(archivePath: string): TestArchive {
    return JSON.parse(fs.readFileSync(archivePath, 'utf8')) as TestArchive;
}

async function writeZipArchive(
    root: string,
    fileName: string,
    entries: Record<string, unknown>
): Promise<string> {
    const archivePath = path.join(root, fileName);
    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(archivePath);
        const archive = archiver('zip');
        output.once('close', resolve);
        output.once('error', reject);
        archive.once('error', reject);
        archive.pipe(output);
        for (const [entryName, contents] of Object.entries(entries)) {
            archive.append(JSON.stringify(contents), { name: entryName });
        }
        void archive.finalize().catch(reject);
    });
    return archivePath;
}

function readHoshidictsJson(baseDir: string, fileName: string): any {
    return JSON.parse(
        fs.readFileSync(
            path.join(baseDir, 'dictionaries', 'hoshidicts', fileName),
            'utf8'
        )
    );
}

function readManifest(baseDir: string): any {
    return readHoshidictsJson(baseDir, 'manifest.json');
}

function writeManifest(baseDir: string, manifest: unknown): void {
    fs.writeFileSync(
        path.join(baseDir, 'dictionaries', 'hoshidicts', 'manifest.json'),
        JSON.stringify(manifest),
        'utf8'
    );
}

function readMiningProfile(baseDir: string): any {
    return readHoshidictsJson(baseDir, 'mining-profile.json');
}

function readAudioProfile(baseDir: string): any {
    return readHoshidictsJson(baseDir, 'audio-profile.json');
}

function writeImportedDictionary(outputDir: string, archive: TestArchive): void {
    const dictionaryDir = path.join(outputDir, archive.title);
    fs.mkdirSync(dictionaryDir, { recursive: true });
    for (const fileName of ['.hoshidicts_3', 'hash.table', 'bloom.filter', 'blobs.bin']) {
        fs.writeFileSync(path.join(dictionaryDir, fileName), fileName, 'utf8');
    }
    if ((archive.media ?? 0) > 0) {
        fs.writeFileSync(path.join(dictionaryDir, 'media.idx'), 'media-index', 'utf8');
        fs.writeFileSync(path.join(dictionaryDir, 'media.bin'), 'media-data', 'utf8');
    }
    const counts: Record<string, unknown> = {
        terms: { total: archive.terms ?? 1 },
        termMeta: {
            total: (archive.frequencies ?? 0) + (archive.pitches ?? 0),
            freq: archive.frequencies ?? 0,
            pitch: archive.pitches ?? 0,
        },
        kanji: { total: archive.kanji ?? 0 },
    };
    if (!archive.omitGeneratedMediaCount) {
        counts.media = { total: archive.media ?? 0 };
    }
    fs.writeFileSync(
        path.join(dictionaryDir, 'index.json'),
        JSON.stringify({
            title: archive.title,
            revision: archive.revision,
            sourceLanguage: archive.sourceLanguage,
            isUpdatable: archive.isUpdatable === true,
            indexUrl: archive.indexUrl,
            downloadUrl: archive.downloadUrl,
            frequencyMode: archive.frequencyMode,
            importDate: Date.now(),
            counts,
        }),
        'utf8'
    );
}

function createHarness(baseDir: string, overrides: Partial<HoshidictsManagerDependencies> = {}) {
    let sequence = 0;
    const reloadNative = vi.fn(async () => 1);
    const fetchRemoteIndex = vi.fn(
        async (): Promise<HoshidictsRemoteIndex> => ({
            revision: 'same',
            downloadUrl: null,
        })
    );
    const downloadArchive = vi.fn(async () => {
        throw new Error('Unexpected download.');
    });
    const inspectArchive = vi.fn(
        async (archivePath: string): Promise<ArchiveInspection> => {
            const archive = readArchive(archivePath);
            return {
                sourceLanguage: archive.sourceLanguage ?? null,
                hasSupportedBank:
                    (archive.terms ?? 1) +
                        (archive.frequencies ?? 0) +
                        (archive.pitches ?? 0) +
                        (archive.kanji ?? 0) >
                    0,
                hasJapaneseEntry: archive.japanese !== false,
            };
        }
    );
    const runImport = vi.fn(
        async (
            archivePath: string,
            outputDir: string
        ): Promise<HoshidictsImportReport> => {
            const archive = readArchive(archivePath);
            writeImportedDictionary(outputDir, archive);
            return {
                success: true,
                title: archive.title,
                termCount: archive.terms ?? 1,
                mediaCount: archive.media ?? 0,
                error: '',
            };
        }
    );
    const writeCustomArchive = vi.fn(
        async (
            outputPath: string,
            title: string,
            revision: string,
            entries: readonly unknown[]
        ): Promise<void> => {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(
                outputPath,
                JSON.stringify({
                    title,
                    revision,
                    sourceLanguage: 'ja',
                    terms: entries.length,
                }),
                'utf8'
            );
        }
    );
    const dependencies: Partial<HoshidictsManagerDependencies> = {
        now: () => new Date(Date.now()),
        randomId: () => `test-${sequence++}`,
        inspectArchive,
        runImport,
        reloadNative,
        fetchRemoteIndex,
        downloadArchive,
        writeCustomArchive,
        ...overrides,
    };
    return {
        manager: new HoshidictsManager(baseDir, dependencies),
        reloadNative,
        fetchRemoteIndex,
        downloadArchive,
        inspectArchive,
        runImport,
        writeCustomArchive,
    };
}

beforeEach(() => {
    vi.useRealTimers();
});

afterEach(() => {
    vi.useRealTimers();
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('Hoshidicts immutable generations', () => {
    it('imports multiple selected archives in order with aggregate progress', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const archivePaths = ['Alpha', 'Beta', 'Gamma'].map((title) =>
            writeArchive(archivesDir, `${title}.zip`, {
                title,
                revision: 'one',
                sourceLanguage: 'ja',
            })
        );
        const { manager, runImport } = createHarness(baseDir);
        const progress: Array<{ completed?: number; total?: number }> = [];
        manager.subscribe((state) => {
            if (state.progress.phase === 'importing') {
                progress.push(state.progress);
            }
        });

        const snapshot = await manager.importDictionaries(archivePaths);
        await vi.waitFor(() => {
            expect(progress).toContainEqual(
                expect.objectContaining({ completed: 2, total: 3 })
            );
        });

        expect(
            snapshot.dictionaries.map((dictionary) => dictionary.title)
        ).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(runImport.mock.calls.map(([archivePath]) => archivePath)).toEqual(
            archivePaths
        );
        expect(progress).toContainEqual(
            expect.objectContaining({ completed: 0, total: 3 })
        );
    });

    it('applies Yomitan dictionary order and enabled preferences without removing extras', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const { manager, reloadNative } = createHarness(baseDir);
        for (const title of ['Alpha', 'Beta', 'Gamma']) {
            await manager.importDictionary(
                writeArchive(archivesDir, `${title}.zip`, {
                    title,
                    revision: 'one',
                    sourceLanguage: 'ja',
                })
            );
        }
        reloadNative.mockClear();

        const snapshot = await manager.applyYomitanDictionaryPreferences([
            { title: 'Beta', enabled: false },
            { title: 'Alpha', enabled: true },
            { title: 'Missing', enabled: false },
        ]);

        expect(
            snapshot.dictionaries.map(({ title, enabled }) => ({
                title,
                enabled,
            }))
        ).toEqual([
            { title: 'Beta', enabled: false },
            { title: 'Alpha', enabled: true },
            { title: 'Gamma', enabled: true },
        ]);
        expect(reloadNative).toHaveBeenCalledOnce();
    });

    it('replaces a reimported dictionary without changing its ordering, enabled state, or presentation', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const first = writeArchive(archivesDir, 'alpha-1.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const second = writeArchive(archivesDir, 'beta.zip', {
            title: 'Beta',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const replacement = writeArchive(archivesDir, 'alpha-2.zip', {
            title: 'Alpha',
            revision: 'two',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);

        await manager.importDictionary(first);
        await manager.importDictionary(second);
        const alphaId = (await manager.getSnapshot()).dictionaries[0].id;
        await manager.setDictionaryEnabled(alphaId, false);
        await manager.setDictionaryPresentation(alphaId, true);
        await manager.renameDictionary(alphaId, 'Primary reference');
        const oldManifest = readManifest(baseDir);
        const oldAlphaPath = oldManifest.dictionaries[0].path;
        await manager.importDictionary(replacement);

        const snapshot = await manager.getSnapshot();
        expect(snapshot.dictionaries.map((dictionary) => dictionary.title)).toEqual([
            'Alpha',
            'Beta',
        ]);
        expect(snapshot.dictionaries.map((dictionary) => dictionary.revision)).toEqual([
            'two',
            'one',
        ]);
        expect(snapshot.dictionaries.map((dictionary) => dictionary.enabled)).toEqual([
            false,
            true,
        ]);
        expect(snapshot.dictionaries[0].favorite).toBe(true);
        expect(snapshot.dictionaries[0].displayName).toBe('Primary reference');
        expect(snapshot.dictionaries[0]).toMatchObject({
            termCount: 1,
            frequencyCount: 0,
            frequencyMode: null,
        });

        const manifest = readManifest(baseDir);
        expect(manifest.dictionaries[0].path).not.toBe(oldAlphaPath);
        expect(
            fs.existsSync(
                path.join(
                    baseDir,
                    'dictionaries',
                    'hoshidicts',
                    ...oldAlphaPath.split('/')
                )
            )
        ).toBe(false);
    });

    it('restores the prior manifest and generation when native reload fails', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const first = writeArchive(archivesDir, 'alpha-1.zip', {
            title: 'Alpha',
            revision: 'working',
            sourceLanguage: 'ja',
        });
        const replacement = writeArchive(archivesDir, 'alpha-2.zip', {
            title: 'Alpha',
            revision: 'broken',
            sourceLanguage: 'ja',
        });
        let reloadCount = 0;
        const { manager } = createHarness(baseDir, {
            reloadNative: async () => {
                reloadCount += 1;
                if (reloadCount === 2) {
                    throw new Error('replacement rejected');
                }
                return 1;
            },
        });

        await manager.importDictionary(first);
        const previousManifest = readManifest(baseDir);
        await expect(manager.importDictionary(replacement)).rejects.toThrow(
            'previous dictionaries were restored'
        );

        const snapshot = await manager.getSnapshot();
        expect(snapshot.dictionaries).toHaveLength(1);
        expect(snapshot.dictionaries[0].revision).toBe('working');
        expect(readManifest(baseDir).dictionaries[0].path).toBe(
            previousManifest.dictionaries[0].path
        );
        expect(reloadCount).toBe(3);
    });

    it('retains a generation when manifest rollback fails after publication', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const first = writeArchive(archivesDir, 'alpha-1.zip', {
            title: 'Alpha',
            revision: 'working',
            sourceLanguage: 'ja',
        });
        const replacement = writeArchive(archivesDir, 'alpha-2.zip', {
            title: 'Alpha',
            revision: 'published-but-not-loaded',
            sourceLanguage: 'ja',
        });
        let reloadCount = 0;
        const { manager } = createHarness(baseDir, {
            reloadNative: async () => {
                reloadCount += 1;
                if (reloadCount === 2) {
                    throw new Error('replacement rejected');
                }
                return 1;
            },
        });

        await manager.importDictionary(first);
        fs.writeFileSync(
            path.join(
                baseDir,
                'dictionaries',
                'hoshidicts',
                '.manifest-test-4.tmp'
            ),
            'block rollback temp creation',
            'utf8'
        );

        await expect(manager.importDictionary(replacement)).rejects.toThrow(
            'generation was retained for recovery'
        );

        const manifest = readManifest(baseDir);
        expect(manifest.dictionaries[0].revision).toBe(
            'published-but-not-loaded'
        );
        expect(
            fs.existsSync(
                path.join(
                    baseDir,
                    'dictionaries',
                    'hoshidicts',
                    ...manifest.dictionaries[0].path.split('/')
                )
            )
        ).toBe(true);
        expect(reloadCount).toBe(2);
    });

    it('serializes simultaneous imports', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const alpha = writeArchive(archivesDir, 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const beta = writeArchive(archivesDir, 'beta.zip', {
            title: 'Beta',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        let activeImports = 0;
        let maximumActiveImports = 0;
        const { manager } = createHarness(baseDir, {
            runImport: async (archivePath, outputDir) => {
                activeImports += 1;
                maximumActiveImports = Math.max(maximumActiveImports, activeImports);
                await new Promise((resolve) => setTimeout(resolve, 5));
                const archive = readArchive(archivePath);
                writeImportedDictionary(outputDir, archive);
                activeImports -= 1;
                return {
                    success: true,
                    title: archive.title,
                    termCount: archive.terms ?? 1,
                    mediaCount: archive.media ?? 0,
                    error: '',
                };
            },
        });

        await Promise.all([
            manager.importDictionary(alpha),
            manager.importDictionary(beta),
        ]);

        expect(maximumActiveImports).toBe(1);
        expect((await manager.getSnapshot()).dictionaries).toHaveLength(2);
    });

    it('enables and reorders dictionaries through atomic native reloads', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const alpha = writeArchive(archivesDir, 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const beta = writeArchive(archivesDir, 'beta.zip', {
            title: 'Beta',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager, reloadNative } = createHarness(baseDir);

        await manager.importDictionary(alpha);
        await manager.importDictionary(beta);
        const initial = await manager.getSnapshot();
        const alphaId = initial.dictionaries[0].id;
        const betaId = initial.dictionaries[1].id;

        await manager.setDictionaryEnabled(alphaId, false);
        await manager.moveDictionary(betaId, -1);

        const snapshot = await manager.getSnapshot();
        expect(snapshot.dictionaries.map((dictionary) => dictionary.id)).toEqual([
            betaId,
            alphaId,
        ]);
        expect(snapshot.dictionaries.map((dictionary) => dictionary.enabled)).toEqual([
            true,
            false,
        ]);
        expect(readManifest(baseDir).dictionaries.map((dictionary: any) => dictionary.id)).toEqual([
            betaId,
            alphaId,
        ]);
        expect(reloadNative).toHaveBeenCalledTimes(4);
    });

    it('moves a dictionary directly to a one-based search position', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const alpha = writeArchive(archivesDir, 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const beta = writeArchive(archivesDir, 'beta.zip', {
            title: 'Beta',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const gamma = writeArchive(archivesDir, 'gamma.zip', {
            title: 'Gamma',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);

        await manager.importDictionary(alpha);
        await manager.importDictionary(beta);
        await manager.importDictionary(gamma);
        const initial = await manager.getSnapshot();
        const gammaId = initial.dictionaries[2].id;

        await manager.moveDictionaryToPosition(gammaId, 1);

        expect(
            (await manager.getSnapshot()).dictionaries.map(
                (dictionary) => dictionary.title
            )
        ).toEqual(['Gamma', 'Alpha', 'Beta']);
        await expect(
            manager.moveDictionaryToPosition(gammaId, 4)
        ).rejects.toThrow('Dictionary position must be between 1 and 3.');
    });

    it('uses visible search positions when the managed custom dictionary is installed', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const alpha = writeArchive(archivesDir, 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const beta = writeArchive(archivesDir, 'beta.zip', {
            title: 'Beta',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);
        const missing = await manager.getCustomDictionaryDocument();
        await manager.saveCustomDictionary(
            '自作, じさく, Custom\n',
            missing.revision
        );
        await manager.importDictionary(alpha);
        await manager.importDictionary(beta);
        const initial = await manager.getSnapshot();
        const betaId = initial.dictionaries[1].id;

        await manager.moveDictionaryToPosition(betaId, 1);

        expect(
            (await manager.getSnapshot()).dictionaries.map(
                (dictionary) => dictionary.title
            )
        ).toEqual(['Beta', 'Alpha']);
        expect(
            readManifest(baseDir).dictionaries.map(
                (dictionary: { id: string; title: string }) =>
                    dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID
                        ? dictionary.id
                        : dictionary.title
            )
        ).toEqual([HOSHIDICTS_CUSTOM_DICTIONARY_ID, 'Beta', 'Alpha']);
        await expect(
            manager.moveDictionaryToPosition(betaId, 3)
        ).rejects.toThrow('Dictionary position must be between 1 and 2.');
    });

    it('persists dictionary presentation without reloading native dictionaries', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager, reloadNative } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const dictionaryId = (await manager.getSnapshot()).dictionaries[0].id;
        reloadNative.mockClear();

        const snapshot = await manager.setDictionaryPresentation(dictionaryId, true);

        expect(snapshot.dictionaries[0].favorite).toBe(true);
        expect(readManifest(baseDir).dictionaries[0].favorite).toBe(true);
        expect(reloadNative).not.toHaveBeenCalled();
    });

    it('persists ordered tab groups with multiple dictionary memberships', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const { manager, reloadNative } = createHarness(baseDir);
        await manager.importDictionary(
            writeArchive(archivesDir, 'alpha.zip', {
                title: 'Alpha',
                revision: 'one',
                sourceLanguage: 'ja',
            })
        );
        await manager.importDictionary(
            writeArchive(archivesDir, 'beta.zip', {
                title: 'Beta',
                revision: 'one',
                sourceLanguage: 'ja',
            })
        );
        const [alpha, beta] = (await manager.getSnapshot()).dictionaries;
        reloadNative.mockClear();

        let state = await manager.createTabGroup('  Grammar  ', alpha.id);
        const grammarId = state.tabGroups[0].id;
        state = await manager.createTabGroup('Notes');
        const notesId = state.tabGroups[1].id;
        await manager.setTabGroupMembership(grammarId, beta.id, true);
        await manager.setTabGroupMembership(notesId, alpha.id, true);
        await manager.renameTabGroup(notesId, 'Reference');
        state = await manager.moveTabGroup(notesId, -1);

        expect(state.tabGroups).toEqual([
            { id: notesId, name: 'Reference', dictionaryIds: [alpha.id] },
            {
                id: grammarId,
                name: 'Grammar',
                dictionaryIds: [alpha.id, beta.id],
            },
        ]);
        expect(reloadNative).not.toHaveBeenCalled();
        expect(
            JSON.parse(fs.readFileSync(manager.tabGroupsPath, 'utf8')).groups
        ).toEqual(state.tabGroups);
        expect((await createHarness(baseDir).manager.getSnapshot()).tabGroups)
            .toEqual(state.tabGroups);

        state = await manager.deleteTabGroup(grammarId);
        expect(state.tabGroups).toEqual([
            { id: notesId, name: 'Reference', dictionaryIds: [alpha.id] },
        ]);
        await expect(manager.createTabGroup('reference')).rejects.toThrow(
            'already exists'
        );
        await expect(manager.createTabGroup('All')).rejects.toThrow(
            'cannot be All'
        );
    });

    it('enforces tab group count and name boundaries used by the reader bridge', async () => {
        const { manager } = createHarness(makeTempDir());
        const maximumName = 'g'.repeat(MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH);

        let state = await manager.createTabGroup(maximumName);
        expect(state.tabGroups[0].name).toBe(maximumName);
        await expect(
            manager.createTabGroup(
                'g'.repeat(MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH + 1)
            )
        ).rejects.toThrow('too long');

        for (let index = 1; index < 256; index += 1) {
            state = await manager.createTabGroup(`Group ${index}`);
        }
        expect(state.tabGroups).toHaveLength(256);
        await expect(manager.createTabGroup('Group 257')).rejects.toThrow(
            'too many groups'
        );
        expect((await manager.getSnapshot()).tabGroups).toHaveLength(256);

        const maximumId = 'd'.repeat(128);
        const maximumState = {
            version: 1,
            groups: Array.from({ length: 256 }, (_, groupIndex) => ({
                id: `group-${groupIndex}`,
                name: `${'g'.repeat(
                    MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH -
                        String(groupIndex).length
                )}${groupIndex}`,
                dictionaryIds: Array.from(
                    { length: 256 },
                    (_, dictionaryIndex) =>
                        `${maximumId.slice(
                            0,
                            128 - String(dictionaryIndex).length
                        )}${dictionaryIndex}`
                ),
            })),
        };
        const maximumStateBytes = Buffer.byteLength(
            JSON.stringify(maximumState),
            'utf8'
        );
        expect(maximumStateBytes).toBeLessThanOrEqual(
            MAX_HOSHIDICTS_TAB_GROUPS_BYTES
        );
    });

    it('removes retained tab group membership after its dictionary is uninstalled', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const dictionaryId = (await manager.getSnapshot()).dictionaries[0].id;
        let state = await manager.createTabGroup('Grammar', dictionaryId);
        const groupId = state.tabGroups[0].id;

        state = await manager.removeDictionary(dictionaryId);
        expect(state.tabGroups[0].dictionaryIds).toEqual([dictionaryId]);

        state = await manager.setTabGroupMembership(groupId, dictionaryId, false);
        expect(state.tabGroups[0].dictionaryIds).toEqual([]);
    });

    it('persists a normalized dictionary display name without reloading native dictionaries', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager, reloadNative } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const dictionaryId = (await manager.getSnapshot()).dictionaries[0].id;
        reloadNative.mockClear();

        const renamed = await manager.renameDictionary(
            dictionaryId,
            '  Cafe\u0301 reference  '
        );

        expect(renamed.dictionaries[0].displayName).toBe('Caf\u00e9 reference');
        expect(readManifest(baseDir).dictionaries[0].displayName).toBe(
            'Caf\u00e9 reference'
        );
        expect(reloadNative).not.toHaveBeenCalled();

        expect(
            (await manager.renameDictionary(dictionaryId, 'Alpha')).dictionaries[0]
                .displayName
        ).toBeNull();
        expect(readManifest(baseDir).dictionaries[0].displayName).toBeNull();

        await manager.renameDictionary(dictionaryId, 'Temporary name');
        expect(
            (await manager.renameDictionary(dictionaryId, null)).dictionaries[0]
                .displayName
        ).toBeNull();
        expect(reloadNative).not.toHaveBeenCalled();
    });

    it('defaults favorite state from older version-one manifests', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const manifest = readManifest(baseDir);
        delete manifest.dictionaries[0].favorite;
        delete manifest.dictionaries[0].displayName;
        writeManifest(baseDir, manifest);

        expect((await manager.getSnapshot()).dictionaries[0].favorite).toBe(false);
        expect((await manager.getSnapshot()).dictionaries[0].displayName).toBeNull();
    });

    it('validates dictionary display names by Unicode code point', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const dictionaryId = (await manager.getSnapshot()).dictionaries[0].id;

        await expect(
            manager.renameDictionary('not a valid id', 'Alias')
        ).rejects.toThrow('Dictionary id is invalid');
        await expect(
            manager.renameDictionary(HOSHIDICTS_CUSTOM_DICTIONARY_ID, 'Alias')
        ).rejects.toThrow('custom dictionary');
        await expect(
            manager.renameDictionary(dictionaryId, 42 as unknown as string)
        ).rejects.toThrow('display name is invalid');
        await expect(
            manager.renameDictionary(dictionaryId, 'Line\nBreak')
        ).rejects.toThrow('control or format');
        await expect(
            manager.renameDictionary(dictionaryId, 'Zero\u200bWidth')
        ).rejects.toThrow('control or format');

        const boundary = '\ud83c\udf38'.repeat(128);
        expect(
            (await manager.renameDictionary(dictionaryId, boundary)).dictionaries[0]
                .displayName
        ).toBe(boundary);
        await expect(
            manager.renameDictionary(dictionaryId, `${boundary}\ud83c\udf38`)
        ).rejects.toThrow('128 Unicode code points');
        await expect(
            manager.renameDictionary('missing', 'Alias')
        ).rejects.toThrow('not installed');
    });

    it('validates dictionary presentation changes', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const dictionaryId = (await manager.getSnapshot()).dictionaries[0].id;

        await expect(
            manager.setDictionaryPresentation('missing', false)
        ).rejects.toThrow('not installed');
        await expect(
            manager.setDictionaryPresentation(
                dictionaryId,
                'yes' as unknown as boolean
            )
        ).rejects.toThrow('favorite state is invalid');
    });

    it('rolls back a failed dictionary enablement reload', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        let reloadCount = 0;
        const { manager } = createHarness(baseDir, {
            reloadNative: async () => {
                reloadCount += 1;
                if (reloadCount === 2) {
                    throw new Error('disabled state rejected');
                }
                return 1;
            },
        });

        await manager.importDictionary(archive);
        const dictionaryId = (await manager.getSnapshot()).dictionaries[0].id;

        await expect(
            manager.setDictionaryEnabled(dictionaryId, false)
        ).rejects.toThrow('previous dictionaries were restored');

        expect((await manager.getSnapshot()).dictionaries[0].enabled).toBe(true);
        expect(readManifest(baseDir).dictionaries[0].enabled).toBe(true);
        expect(reloadCount).toBe(3);
    });
});

describe('Hoshidicts managed custom dictionary', () => {
    it('compiles valid rows as a hidden, highest-priority managed dictionary', async () => {
        const baseDir = makeTempDir();
        const regularArchive = writeArchive(makeTempDir(), 'regular.zip', {
            title: 'Regular',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager, writeCustomArchive } = createHarness(baseDir);
        await manager.importDictionary(regularArchive);
        const original = await manager.getCustomDictionaryDocument();

        const document = await manager.saveCustomDictionary(
            '螺旋丸, らせんがん, Rotating chakra sphere attack\n',
            original.revision
        );

        expect(document).toMatchObject({
            exists: true,
            filePath: manager.customDictionaryPath,
        });
        expect(writeCustomArchive).toHaveBeenCalledWith(
            expect.any(String),
            HOSHIDICTS_CUSTOM_DICTIONARY_TITLE,
            expect.stringMatching(/^[a-f0-9]{64}$/u),
            [
                {
                    term: '螺旋丸',
                    reading: 'らせんがん',
                    definition: 'Rotating chakra sphere attack',
                },
            ]
        );
        const manifest = readManifest(baseDir);
        expect(manifest.dictionaries.map((dictionary: any) => dictionary.id)).toEqual([
            HOSHIDICTS_CUSTOM_DICTIONARY_ID,
            expect.any(String),
        ]);
        expect(manifest.dictionaries[0]).toMatchObject({
            title: HOSHIDICTS_CUSTOM_DICTIONARY_TITLE,
            enabled: true,
        });

        const snapshot = await manager.getSnapshot();
        expect(snapshot.dictionaries.map((dictionary) => dictionary.title)).toEqual([
            'Regular',
        ]);
        expect(snapshot.customDictionaryActive).toBe(true);
    });

    it('rejects a compiled generation if the importer drops valid source rows', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir, {
            runImport: async (archivePath, outputDir) => {
                const archive = readArchive(archivePath);
                writeImportedDictionary(outputDir, { ...archive, terms: 1 });
                return {
                    success: true,
                    title: archive.title,
                    termCount: 1,
                    error: '',
                };
            },
        });
        const missing = await manager.getCustomDictionaryDocument();

        await expect(
            manager.saveCustomDictionary(
                '一, いち, One\n二, に, Two\n',
                missing.revision
            )
        ).rejects.toThrow('did not match its source entries');

        expect(fs.existsSync(manager.customDictionaryPath)).toBe(false);
    });

    it('saves source-only edits without recompiling unchanged semantic entries', async () => {
        const baseDir = makeTempDir();
        const { manager, reloadNative, writeCustomArchive } = createHarness(baseDir);
        const missing = await manager.getCustomDictionaryDocument();
        const first = await manager.saveCustomDictionary(
            '千鳥, ちどり, Lightning chakra thrust attack\n',
            missing.revision
        );

        const second = await manager.saveCustomDictionary(
            '# Personal notes\r\n\r\n千鳥,ちどり,Lightning chakra thrust attack\r\n',
            first.revision
        );

        expect(second.revision).not.toBe(first.revision);
        expect(writeCustomArchive).toHaveBeenCalledTimes(1);
        expect(reloadNative).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(manager.customDictionaryPath, 'utf8')).toBe(second.text);
    });

    it('rejects stale full-editor saves without replacing external edits', async () => {
        const baseDir = makeTempDir();
        const { manager, writeCustomArchive } = createHarness(baseDir);
        const opened = await manager.getCustomDictionaryDocument();
        fs.mkdirSync(path.dirname(manager.customDictionaryPath), { recursive: true });
        fs.writeFileSync(
            manager.customDictionaryPath,
            '外部, がいぶ, External edit\n',
            'utf8'
        );

        await expect(
            manager.saveCustomDictionary(
                '上書き, うわがき, Stale overwrite\n',
                opened.revision
            )
        ).rejects.toThrow('changed after it was opened');

        expect(fs.readFileSync(manager.customDictionaryPath, 'utf8')).toContain(
            'External edit'
        );
        expect(writeCustomArchive).not.toHaveBeenCalled();
    });

    it('rechecks the source immediately before replacing it after compilation', async () => {
        const baseDir = makeTempDir();
        let announceCompile!: () => void;
        let resumeCompile!: () => void;
        const compileStarted = new Promise<void>((resolve) => {
            announceCompile = resolve;
        });
        const compileMayFinish = new Promise<void>((resolve) => {
            resumeCompile = resolve;
        });
        const { manager } = createHarness(baseDir, {
            writeCustomArchive: async (
                outputPath,
                title,
                revision,
                entries
            ) => {
                announceCompile();
                await compileMayFinish;
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(
                    outputPath,
                    JSON.stringify({
                        title,
                        revision,
                        sourceLanguage: 'ja',
                        terms: entries.length,
                    }),
                    'utf8'
                );
            },
        });
        const opened = await manager.getCustomDictionaryDocument();
        const saving = manager.saveCustomDictionary(
            '準備, じゅんび, Prepared\n',
            opened.revision
        );
        await compileStarted;
        fs.mkdirSync(path.dirname(manager.customDictionaryPath), {
            recursive: true,
        });
        fs.writeFileSync(
            manager.customDictionaryPath,
            '外部, がいぶ, External during compile\n',
            'utf8'
        );
        resumeCompile();

        await expect(saving).rejects.toThrow(
            'changed while the update was being prepared'
        );
        expect(fs.readFileSync(manager.customDictionaryPath, 'utf8')).toContain(
            'External during compile'
        );
        expect(fs.existsSync(manager.manifestPath)).toBe(false);
    });

    it('serializes simultaneous note appends against the latest file contents', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        await Promise.all([
            manager.addCustomEntry({
                term: '影分身の術',
                reading: 'かげぶんしんのじゅつ',
                definition: 'Creates solid shadow clones',
            }),
            manager.addCustomEntry({
                term: '千鳥',
                reading: 'ちどり',
                definition: 'Lightning chakra thrust attack',
            }),
        ]);

        const document = await manager.getCustomDictionaryDocument();
        expect(document.text).toContain(
            '影分身の術, かげぶんしんのじゅつ, Creates solid shadow clones'
        );
        expect(document.text).toContain(
            '千鳥, ちどり, Lightning chakra thrust attack'
        );
        expect(readManifest(baseDir).dictionaries[0].termCount).toBe(2);
    });

    it('does not notice external source edits until an explicit synchronization', async () => {
        const baseDir = makeTempDir();
        const { manager, writeCustomArchive } = createHarness(baseDir);
        const opened = await manager.getCustomDictionaryDocument();
        await manager.saveCustomDictionary(
            '最初, さいしょ, First\n',
            opened.revision
        );
        fs.writeFileSync(
            manager.customDictionaryPath,
            '変更, へんこう, Changed externally\n',
            'utf8'
        );

        await manager.getSnapshot();
        expect(writeCustomArchive).toHaveBeenCalledTimes(1);

        const synced = await manager.syncCustomDictionary();
        expect(synced.text).toContain('Changed externally');
        expect(writeCustomArchive).toHaveBeenCalledTimes(2);
    });

    it('removes compiled state for an empty source while preserving the text file', async () => {
        const baseDir = makeTempDir();
        const { manager, reloadNative } = createHarness(baseDir);
        const missing = await manager.getCustomDictionaryDocument();
        const installed = await manager.saveCustomDictionary(
            '螺旋丸, らせんがん, Attack\n',
            missing.revision
        );

        const empty = await manager.saveCustomDictionary('', installed.revision);

        expect(empty.exists).toBe(true);
        expect(fs.existsSync(manager.customDictionaryPath)).toBe(true);
        expect(fs.readFileSync(manager.customDictionaryPath, 'utf8')).toBe('');
        expect(readManifest(baseDir).dictionaries).toEqual([]);
        expect((await manager.getSnapshot()).customDictionaryActive).toBe(false);
        expect(reloadNative).toHaveBeenCalledTimes(2);
    });

    it('removes compiled state when explicit sync observes a deleted source file', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);
        const missing = await manager.getCustomDictionaryDocument();
        await manager.saveCustomDictionary(
            '削除, さくじょ, Delete\n',
            missing.revision
        );
        fs.unlinkSync(manager.customDictionaryPath);

        const synced = await manager.syncCustomDictionary();

        expect(synced).toMatchObject({ exists: false, text: '' });
        expect(readManifest(baseDir).dictionaries).toEqual([]);
    });

    it('protects the custom dictionary from generic remove, disable, and reorder actions', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);
        const missing = await manager.getCustomDictionaryDocument();
        await manager.saveCustomDictionary(
            '自作, じさく, Custom\n',
            missing.revision
        );
        const regularArchive = writeArchive(makeTempDir(), 'regular.zip', {
            title: 'Regular',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        await manager.importDictionary(regularArchive);
        const regularId = (await manager.getSnapshot()).dictionaries[0].id;

        await expect(
            manager.removeDictionary(HOSHIDICTS_CUSTOM_DICTIONARY_ID)
        ).rejects.toThrow('managed from its editor');
        await expect(
            manager.setDictionaryEnabled(HOSHIDICTS_CUSTOM_DICTIONARY_ID, false)
        ).rejects.toThrow('always enabled');
        await expect(manager.moveDictionary(regularId, -1)).rejects.toThrow(
            'always first'
        );
        expect(readManifest(baseDir).dictionaries[0].id).toBe(
            HOSHIDICTS_CUSTOM_DICTIONARY_ID
        );
    });

    it('keeps an ordinary same-title dictionary separate from the managed one', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'ordinary.zip', {
            title: HOSHIDICTS_CUSTOM_DICTIONARY_TITLE,
            revision: 'user-owned',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const ordinaryId = (await manager.getSnapshot()).dictionaries[0].id;
        const missing = await manager.getCustomDictionaryDocument();
        await manager.saveCustomDictionary(
            '自作, じさく, Managed entry\n',
            missing.revision
        );

        const manifest = readManifest(baseDir);
        expect(manifest.dictionaries.map((dictionary: any) => dictionary.id)).toEqual([
            HOSHIDICTS_CUSTOM_DICTIONARY_ID,
            ordinaryId,
        ]);
        expect((await manager.getSnapshot()).dictionaries).toMatchObject([
            { id: ordinaryId, title: HOSHIDICTS_CUSTOM_DICTIONARY_TITLE },
        ]);
    });

    it('restores source, manifest, and native state when a custom reload fails', async () => {
        const baseDir = makeTempDir();
        let reloadCount = 0;
        const { manager } = createHarness(baseDir, {
            reloadNative: async () => {
                reloadCount += 1;
                if (reloadCount === 2) {
                    throw new Error('new custom dictionary rejected');
                }
                return 1;
            },
        });
        const missing = await manager.getCustomDictionaryDocument();
        const working = await manager.saveCustomDictionary(
            '動作, どうさ, Working\n',
            missing.revision
        );
        const previousManifest = readManifest(baseDir);

        await expect(
            manager.saveCustomDictionary(
                '故障, こしょう, Broken\n',
                working.revision
            )
        ).rejects.toThrow('previous dictionaries were restored');

        const restored = await manager.getCustomDictionaryDocument();
        expect(restored.text).toBe(working.text);
        expect(readManifest(baseDir).dictionaries[0].path).toBe(
            previousManifest.dictionaries[0].path
        );
        expect(reloadCount).toBe(3);
    });

    it('retains the matching new source when manifest rollback cannot be published', async () => {
        const baseDir = makeTempDir();
        let reloadCount = 0;
        const { manager } = createHarness(baseDir, {
            reloadNative: async () => {
                reloadCount += 1;
                if (reloadCount === 2) {
                    throw new Error('replacement rejected');
                }
                return 1;
            },
        });
        const missing = await manager.getCustomDictionaryDocument();
        const working = await manager.saveCustomDictionary(
            '動作, どうさ, Working\n',
            missing.revision
        );
        const previousManifest = readManifest(baseDir);
        fs.writeFileSync(
            path.join(
                baseDir,
                'dictionaries',
                'hoshidicts',
                '.manifest-test-8.tmp'
            ),
            'block rollback temp creation',
            'utf8'
        );
        const replacementText = '公開, こうかい, Published for recovery\n';

        await expect(
            manager.saveCustomDictionary(replacementText, working.revision)
        ).rejects.toThrow('generation was retained for recovery');

        const retainedManifest = readManifest(baseDir);
        expect(retainedManifest.dictionaries[0].path).not.toBe(
            previousManifest.dictionaries[0].path
        );
        expect(fs.readFileSync(manager.customDictionaryPath, 'utf8')).toBe(
            replacementText
        );
        expect(reloadCount).toBe(2);
    });

    it('does not leave a source file or generation after an initial reload failure', async () => {
        const baseDir = makeTempDir();
        let reloadCount = 0;
        const { manager } = createHarness(baseDir, {
            reloadNative: async () => {
                reloadCount += 1;
                if (reloadCount === 1) {
                    throw new Error('initial custom dictionary rejected');
                }
                return 0;
            },
        });
        const missing = await manager.getCustomDictionaryDocument();

        await expect(
            manager.saveCustomDictionary(
                '失敗, しっぱい, Failure\n',
                missing.revision
            )
        ).rejects.toThrow('previous dictionaries were restored');

        expect(fs.existsSync(manager.customDictionaryPath)).toBe(false);
        expect(fs.existsSync(manager.manifestPath)).toBe(false);
        expect(reloadCount).toBe(2);
    });
});

describe('Hoshidicts mining profile', () => {
    it('uses defaults until an override profile is saved atomically', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        expect((await manager.getSnapshot()).miningProfile).toEqual(
            defaultHoshidictsMiningProfile()
        );

        const snapshot = await manager.setMiningProfile({
            enabled: false,
            deck: ' Mining ',
            model: ' Custom ',
            fields: {
                expression: ' Front ',
                reading: ' Kana ',
            },
            tags: [' hoshidicts ', 'HOSHIDICTS', 'custom'],
            duplicatePolicy: 'allow',
        });

        expect(snapshot.miningProfile).toEqual({
            version: 3,
            enabled: false,
            deck: 'Mining',
            model: 'Custom',
            fields: {
                expression: 'Front',
                reading: 'Kana',
                definition: '',
                sentence: '',
                frequency: '',
                pitch: '',
                audio: '',
            },
            disabledFields: [],
            tags: ['hoshidicts', 'custom'],
            checkForDuplicates: true,
            duplicateScope: 'collection',
            duplicateScopeCheckAllModels: false,
            duplicateBehavior: 'new',
            fieldOverwriteModes: {
                expression: 'coalesce',
                reading: 'coalesce',
                definition: 'coalesce',
                sentence: 'coalesce',
                frequency: 'coalesce',
                pitch: 'coalesce',
                audio: 'coalesce',
            },
            fieldTemplates: null,
        });
        expect(readMiningProfile(baseDir)).toEqual(snapshot.miningProfile);
        expect(
            fs.readdirSync(path.join(baseDir, 'dictionaries', 'hoshidicts'))
        ).toEqual(['mining-profile.json']);
    });

    it('reports a malformed saved profile without hiding dictionary state', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);
        await manager.setMiningProfile(defaultHoshidictsMiningProfile());
        fs.writeFileSync(manager.miningProfilePath, '{broken', 'utf8');

        const snapshot = await manager.getSnapshot();

        expect(snapshot.miningProfile).toEqual(defaultHoshidictsMiningProfile());
        expect(snapshot.lastError).toContain('JSON');
        expect(snapshot.dictionaries).toEqual([]);
    });

    it('normalizes Yomitan duplicate options and rejects unsupported values', () => {
        expect(
            normalizeHoshidictsMiningProfile({
                version: 2,
                checkForDuplicates: false,
                duplicateScope: 'deck-root',
                duplicateScopeCheckAllModels: true,
                duplicateBehavior: 'overwrite',
                fieldOverwriteModes: {
                    expression: 'overwrite',
                    reading: 'skip',
                },
            })
        ).toMatchObject({
            version: 3,
            checkForDuplicates: false,
            duplicateScope: 'deck-root',
            duplicateScopeCheckAllModels: true,
            duplicateBehavior: 'overwrite',
            fieldOverwriteModes: {
                expression: 'overwrite',
                reading: 'skip',
                definition: 'coalesce',
            },
            fieldTemplates: null,
        });
        expect(() =>
            normalizeHoshidictsMiningProfile({ duplicateScope: 'note' })
        ).toThrow('duplicate scope is invalid');
        expect(() =>
            normalizeHoshidictsMiningProfile({ duplicateBehavior: 'allow' })
        ).toThrow('duplicate behavior is invalid');
        expect(() =>
            normalizeHoshidictsMiningProfile({
                fieldOverwriteModes: { expression: 'replace' },
            })
        ).toThrow('overwrite mode is invalid');
    });

    it('normalizes explicit do-not-fill mining fields without pinning automatic fields', () => {
        expect(
            normalizeHoshidictsMiningProfile({
                fields: { expression: '', reading: 'Kana' },
                disabledFields: ['definition', 'definition', 'pitch'],
            })
        ).toMatchObject({
            fields: { expression: '', reading: 'Kana' },
            disabledFields: ['definition', 'pitch'],
        });
        expect(() =>
            normalizeHoshidictsMiningProfile({ disabledFields: ['unknown'] })
        ).toThrow('disabled mining field is invalid');
    });

    it('normalizes target-keyed templates including explicit blanks and literals', () => {
        expect(
            normalizeHoshidictsMiningProfile({
                version: 3,
                fieldTemplates: {
                    Expression: {
                        value: '{expression}',
                        overwriteMode: 'overwrite',
                    },
                    Notes: { value: 'x', overwriteMode: 'skip' },
                    Unused: { value: '', overwriteMode: 'coalesce' },
                },
            }).fieldTemplates
        ).toEqual({
            Expression: {
                value: '{expression}',
                overwriteMode: 'overwrite',
            },
            Notes: { value: 'x', overwriteMode: 'skip' },
            Unused: { value: '', overwriteMode: 'coalesce' },
        });
        expect(() =>
            normalizeHoshidictsMiningProfile({
                version: 3,
                fieldTemplates: {
                    Notes: { value: 42, overwriteMode: 'coalesce' },
                },
            })
        ).toThrow('field template is invalid');
        expect(() =>
            normalizeHoshidictsMiningProfile({
                version: 3,
                fieldTemplates: {
                    Notes: { value: 'before\0after', overwriteMode: 'coalesce' },
                },
            })
        ).toThrow('field template value is invalid');
        expect(() =>
            normalizeHoshidictsMiningProfile({
                version: 3,
                fieldTemplates: {
                    Notes: { value: 'x', overwriteMode: 'replace' },
                },
            })
        ).toThrow('overwrite mode is invalid');
        expect(
            normalizeHoshidictsMiningProfile({
                version: 3,
                fieldTemplates: {},
            }).fieldTemplates
        ).toEqual({});
        expect(
            normalizeHoshidictsMiningProfile({
                version: 2,
                fields: { reading: 'Kana' },
                fieldTemplates: {
                    Ignored: { value: 'x', overwriteMode: 'skip' },
                },
            })
        ).toMatchObject({
            version: 3,
            fields: { reading: 'Kana' },
            fieldTemplates: null,
        });
    });

    it('exports every canonical mining marker in menu order', () => {
        expect(HOSHIDICTS_MINING_FIELD_MARKERS).toEqual([
            { id: 'expression', value: '{expression}' },
            { id: 'reading', value: '{reading}' },
            { id: 'definition', value: '{definition}' },
            { id: 'sentence', value: '{sentence}' },
            { id: 'frequency', value: '{frequency}' },
            { id: 'pitch', value: '{pitch}' },
            { id: 'pitch-position', value: '{pitch-position}' },
            { id: 'audio', value: '{audio}' },
        ]);
    });
});

describe('Hoshidicts audio profile', () => {
    it('uses defaults until an ordered audio profile is saved atomically', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        expect((await manager.getSnapshot()).audioProfile).toEqual(
            defaultHoshidictsAudioProfile()
        );

        const snapshot = await manager.setAudioProfile({
            enabled: true,
            autoPlay: true,
            volume: 45,
            sources: [
                {
                    id: 'local',
                    type: 'custom-json',
                    url: 'http://127.0.0.1:9000/{term}',
                },
                {
                    id: 'term-tts',
                    type: 'text-to-speech',
                    voice: 'ja-JP',
                },
            ],
        });

        expect(snapshot.audioProfile).toEqual({
            version: 1,
            enabled: true,
            autoPlay: true,
            volume: 45,
            sources: [
                {
                    id: 'local',
                    type: 'custom-json',
                    url: 'http://127.0.0.1:9000/{term}',
                    voice: '',
                },
                {
                    id: 'term-tts',
                    type: 'text-to-speech',
                    url: '',
                    voice: 'ja-JP',
                },
            ],
        });
        expect(snapshot.progress).toEqual({ phase: 'idle', scope: 'audio' });
        expect(readAudioProfile(baseDir)).toEqual(snapshot.audioProfile);
        expect(
            fs.readdirSync(path.join(baseDir, 'dictionaries', 'hoshidicts'))
        ).toEqual(['audio-profile.json']);
    });

    it('falls back to defaults and reports malformed saved audio profiles', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);
        await manager.setAudioProfile(defaultHoshidictsAudioProfile());
        fs.writeFileSync(manager.audioProfilePath, '{broken', 'utf8');

        const snapshot = await manager.getSnapshot();

        expect(snapshot.audioProfile).toEqual(defaultHoshidictsAudioProfile());
        expect(snapshot.lastError).toContain('JSON');
        expect(snapshot.dictionaries).toEqual([]);
    });

    it('rejects unsupported source configuration before writing a profile', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        expect(() =>
            normalizeHoshidictsAudioProfile({
                sources: [{ id: 'bad id', type: 'jisho' }],
            })
        ).toThrow('source id is invalid');
        await expect(
            manager.setAudioProfile({
                sources: [{ id: 'custom', type: 'custom', url: 'ftp://example.test' }],
            })
        ).rejects.toThrow('source URL is invalid');
        expect(fs.existsSync(manager.audioProfilePath)).toBe(false);
    });
});

describe('Hoshidicts reader preferences', () => {
    it('loads legacy manifests with Shift lookup and lookup counts enabled', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);
        fs.mkdirSync(path.dirname(manager.manifestPath), { recursive: true });
        fs.writeFileSync(
            manager.manifestPath,
            JSON.stringify({
                version: 1,
                schedule: 'off',
                lastCheck: null,
                nextCheck: null,
                lastError: null,
                dictionaries: [],
            }),
            'utf8'
        );

        const snapshot = await manager.getSnapshot();
        expect(snapshot.lookupMode).toBe('shift');
        expect(snapshot.activationKey).toBe('Shift');
        expect(snapshot.sourceHighlightEnabled).toBe(false);
        expect(snapshot.showLookupCounts).toBe(true);
        expect(snapshot.popupNestingMaxDepth).toBe(10);
        expect(snapshot.popupWidthPx).toBe(560);
        expect(snapshot.popupHeightPx).toBe(420);
        expect(snapshot.theme).toBe('default');
        expect(snapshot.definitionBlur).toEqual({
            enabled: false,
            lookupThreshold: 5,
            revealMode: 'timed',
            revealDelayMs: 5000,
        });
    });

    it('defaults new state to Shift and persists hover lookup', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        expect((await manager.getSnapshot()).lookupMode).toBe('shift');
        expect((await manager.getSnapshot()).activationKey).toBe('Shift');
        expect((await manager.getSnapshot()).sourceHighlightEnabled).toBe(false);
        expect((await manager.getSnapshot()).popupHideDelayMs).toBe(300);
        expect((await manager.getSnapshot()).showLookupCounts).toBe(true);
        expect((await manager.getSnapshot()).popupNestingMaxDepth).toBe(10);
        expect((await manager.getSnapshot()).popupWidthPx).toBe(560);
        expect((await manager.getSnapshot()).popupHeightPx).toBe(420);
        expect((await manager.getSnapshot()).theme).toBe('default');
        expect((await manager.getSnapshot()).definitionBlur).toEqual({
            enabled: false,
            lookupThreshold: 5,
            revealMode: 'timed',
            revealDelayMs: 5000,
        });

        const snapshot = await manager.setReaderPreferences(
            'hover',
            850,
            'F8',
            true,
            12,
            {
                enabled: true,
                lookupThreshold: 8,
                revealMode: 'hover',
                revealDelayMs: 7000,
            },
            false,
            720,
            520,
            'girlypop'
        );

        expect(snapshot.lookupMode).toBe('hover');
        expect(snapshot.activationKey).toBe('F8');
        expect(snapshot.sourceHighlightEnabled).toBe(true);
        expect(snapshot.popupHideDelayMs).toBe(850);
        expect(snapshot.showLookupCounts).toBe(false);
        expect(snapshot.popupNestingMaxDepth).toBe(12);
        expect(snapshot.popupWidthPx).toBe(720);
        expect(snapshot.popupHeightPx).toBe(520);
        expect(snapshot.theme).toBe('girlypop');
        expect(snapshot.definitionBlur).toEqual({
            enabled: true,
            lookupThreshold: 8,
            revealMode: 'hover',
            revealDelayMs: 7000,
        });
        expect(readManifest(baseDir).lookupMode).toBe('hover');
        expect(readManifest(baseDir).activationKey).toBe('F8');
        expect(readManifest(baseDir).sourceHighlightEnabled).toBe(true);
        expect(readManifest(baseDir).popupHideDelayMs).toBe(850);
        expect(readManifest(baseDir).showLookupCounts).toBe(false);
        expect(readManifest(baseDir).popupNestingMaxDepth).toBe(12);
        expect(readManifest(baseDir).popupWidthPx).toBe(720);
        expect(readManifest(baseDir).popupHeightPx).toBe(520);
        expect(readManifest(baseDir).theme).toBe('girlypop');
        expect(readManifest(baseDir).definitionBlur).toEqual({
            enabled: true,
            lookupThreshold: 8,
            revealMode: 'hover',
            revealDelayMs: 7000,
        });

        const reloaded = createHarness(baseDir).manager;
        expect((await reloaded.getSnapshot()).lookupMode).toBe('hover');
        expect((await reloaded.getSnapshot()).activationKey).toBe('F8');
        expect((await reloaded.getSnapshot()).sourceHighlightEnabled).toBe(true);
        expect((await reloaded.getSnapshot()).popupHideDelayMs).toBe(850);
        expect((await reloaded.getSnapshot()).showLookupCounts).toBe(false);
        expect((await reloaded.getSnapshot()).popupNestingMaxDepth).toBe(12);
        expect((await reloaded.getSnapshot()).popupWidthPx).toBe(720);
        expect((await reloaded.getSnapshot()).popupHeightPx).toBe(520);
        expect((await reloaded.getSnapshot()).theme).toBe('girlypop');
        expect((await reloaded.getSnapshot()).definitionBlur).toEqual({
            enabled: true,
            lookupThreshold: 8,
            revealMode: 'hover',
            revealDelayMs: 7000,
        });

        const shifted = await reloaded.setLookupMode('shift');
        expect(shifted.lookupMode).toBe('shift');
        expect(shifted.activationKey).toBe('F8');
        expect(shifted.sourceHighlightEnabled).toBe(true);
        expect(shifted.showLookupCounts).toBe(false);
        expect(readManifest(baseDir).showLookupCounts).toBe(false);
        expect(shifted.popupNestingMaxDepth).toBe(12);
        expect(shifted.popupWidthPx).toBe(720);
        expect(shifted.popupHeightPx).toBe(520);
        expect(shifted.theme).toBe('girlypop');
        expect(shifted.definitionBlur).toEqual({
            enabled: true,
            lookupThreshold: 8,
            revealMode: 'hover',
            revealDelayMs: 7000,
        });
    });

    it('rejects unsupported lookup modes', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        await expect(
            manager.setLookupMode('automatic' as never)
        ).rejects.toThrow('lookup mode is invalid');
    });

    it('rejects popup hide delays outside the reader preference bounds', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        await expect(manager.setReaderPreferences('hover', -1, 'Shift')).rejects.toThrow(
            'hide delay is invalid'
        );
        await expect(manager.setReaderPreferences('hover', 5001, 'Shift')).rejects.toThrow(
            'hide delay is invalid'
        );
    });

    it('rejects popup dimensions and themes outside appearance bounds', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        await expect(
            manager.setReaderPreferences(
                'hover', 300, 'Shift', false, 10, undefined, true, 279
            )
        ).rejects.toThrow('popup width is invalid');
        await expect(
            manager.setReaderPreferences(
                'hover', 300, 'Shift', false, 10, undefined, true, 560, 901
            )
        ).rejects.toThrow('popup height is invalid');
        await expect(
            manager.setReaderPreferences(
                'hover', 300, 'Shift', false, 10, undefined, true, 560, 420,
                'neon' as never
            )
        ).rejects.toThrow('theme is invalid');
    });

    it('rejects unsupported activation keys', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        await expect(
            manager.setReaderPreferences('shift', 300, 'MediaPlayPause' as never)
        ).rejects.toThrow('activation key is invalid');
    });

    it('rejects non-boolean source highlighting preferences', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        await expect(
            manager.setReaderPreferences('shift', 300, 'Shift', 'yes' as never)
        ).rejects.toThrow('source highlight preference is invalid');
    });

    it('rejects non-boolean lookup count preferences', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        await expect(
            manager.setReaderPreferences(
                'shift',
                300,
                'Shift',
                false,
                10,
                undefined,
                'yes' as never
            )
        ).rejects.toThrow('lookup count preference is invalid');
    });

    it('defaults invalid persisted popup nesting depths and rejects invalid updates', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);
        fs.mkdirSync(path.dirname(manager.manifestPath), { recursive: true });
        fs.writeFileSync(
            manager.manifestPath,
            JSON.stringify({
                version: 1,
                lookupMode: 'hover',
                popupHideDelayMs: 850,
                popupNestingMaxDepth: -1,
                schedule: 'off',
                lastCheck: null,
                nextCheck: null,
                lastError: null,
                dictionaries: [],
            }),
            'utf8'
        );

        expect((await manager.getSnapshot()).popupNestingMaxDepth).toBe(10);
        await expect(
            manager.setReaderPreferences('hover', 850, 'Shift', false, -1)
        ).rejects.toThrow('nesting depth is invalid');
        await expect(
            manager.setReaderPreferences('hover', 850, 'Shift', false, 1.5)
        ).rejects.toThrow('nesting depth is invalid');
        await expect(
            manager.setReaderPreferences(
                'hover',
                850,
                'Shift',
                false,
                Number.MAX_SAFE_INTEGER + 1
            )
        ).rejects.toThrow('nesting depth is invalid');
    });

    it('rejects invalid definition blur preference bounds', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);
        const definitionBlur = {
            enabled: true,
            lookupThreshold: 5,
            revealMode: 'timed' as const,
            revealDelayMs: 5000,
        };

        await expect(
            manager.setReaderPreferences('shift', 300, 'Shift', false, 10, {
                ...definitionBlur,
                lookupThreshold: 0,
            })
        ).rejects.toThrow('lookup threshold is invalid');
        await expect(
            manager.setReaderPreferences('shift', 300, 'Shift', false, 10, {
                ...definitionBlur,
                lookupThreshold: 1_000_001,
            })
        ).rejects.toThrow('lookup threshold is invalid');
        await expect(
            manager.setReaderPreferences('shift', 300, 'Shift', false, 10, {
                ...definitionBlur,
                revealDelayMs: 999,
            })
        ).rejects.toThrow('reveal delay is invalid');
        await expect(
            manager.setReaderPreferences('shift', 300, 'Shift', false, 10, {
                ...definitionBlur,
                revealDelayMs: 3_600_001,
            })
        ).rejects.toThrow('reveal delay is invalid');
    });
});

describe('Hoshidicts snapshots', () => {
    it('publishes monotonically increasing revisions', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        const first = await manager.getSnapshot();
        const second = await manager.getSnapshot();

        expect(second.revision).toBeGreaterThan(first.revision);
    });

    it('preserves reader and mining preferences when dictionary hydration fails', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);
        await manager.setReaderPreferences('hover', 900, 'Space', true, 0, {
            enabled: true,
            lookupThreshold: 12,
            revealMode: 'hover',
            revealDelayMs: 6000,
        }, false);
        await manager.setMiningProfile({
            deck: 'Mining',
            model: 'Kiku',
            fields: {},
            disabledFields: ['frequency'],
        });
        await manager.setAudioProfile({
            enabled: false,
            autoPlay: true,
            volume: 20,
            sources: [],
        });
        const manifest = readManifest(baseDir);
        manifest.dictionaries = [
            {
                id: 'broken',
                path: 'missing-generation',
                enabled: true,
            },
        ];
        fs.writeFileSync(manager.manifestPath, JSON.stringify(manifest), 'utf8');

        const snapshot = await manager.getSnapshot();

        expect(snapshot.lookupMode).toBe('hover');
        expect(snapshot.activationKey).toBe('Space');
        expect(snapshot.sourceHighlightEnabled).toBe(true);
        expect(snapshot.popupHideDelayMs).toBe(900);
        expect(snapshot.showLookupCounts).toBe(false);
        expect(snapshot.popupNestingMaxDepth).toBe(0);
        expect(snapshot.definitionBlur).toEqual({
            enabled: true,
            lookupThreshold: 12,
            revealMode: 'hover',
            revealDelayMs: 6000,
        });
        expect(snapshot.miningProfile).toMatchObject({
            deck: 'Mining',
            model: 'Kiku',
            disabledFields: ['frequency'],
        });
        expect(snapshot.audioProfile).toMatchObject({
            enabled: false,
            autoPlay: true,
            volume: 20,
            sources: [],
        });
        expect(snapshot.lastError).toMatch(/missing|dictionary/i);
    });
});

describe('Hoshidicts import policy', () => {
    it('offers the Japanese dictionaries curated by Yomitan plus Kanjium pitch accents', () => {
        expect(
            RECOMMENDED_HOSHIDICTS_DICTIONARIES.map((dictionary) => dictionary.id)
        ).toEqual([
            'jitendex',
            'jmdict',
            'jmnedict',
            'bccwj',
            'jpdbv2-kana',
            'jiten',
            'kanjium-pitch',
            'kanjidic',
        ]);
        expect(
            RECOMMENDED_HOSHIDICTS_DICTIONARIES.map(
                (dictionary) => dictionary.downloadUrl
            )
        ).toEqual([
            expect.stringContaining('jitendex-yomitan.zip'),
            expect.stringContaining('JMdict_english_without_proper_names.zip'),
            expect.stringContaining('JMnedict.zip'),
            expect.stringContaining('BCCWJ_SUW_LUW_combined.zip'),
            expect.stringContaining('JPDB_v2.2_Frequency_Kana.zip'),
            expect.stringContaining('jiten.moe/api/frequency-list/download'),
            expect.stringContaining('kanjium_pitch_accents.zip'),
            expect.stringContaining('KANJIDIC_english.zip'),
        ]);
        expect(
            DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.every((id) =>
                RECOMMENDED_HOSHIDICTS_DICTIONARIES.some(
                    (dictionary) => dictionary.id === id
                )
            )
        ).toBe(true);
    });

    it.each([
        ['frequency', 'term_meta_bank_1.json', [['食べる', 'freq', 123]]],
        [
            'pitch',
            'term_meta_bank_1.json',
            [['食べる', 'pitch', { reading: 'たべる', pitches: [{ position: 2 }] }]],
        ],
        ['kanji', 'kanji_bank_1.json', [['食', 'ショク', 'た.べる', '', [], {}]]],
    ])(
        'recognizes a Japanese %s-only Yomitan archive as supported',
        async (_kind, bankName, bank) => {
            const archive = await writeZipArchive(makeTempDir(), `${_kind}.zip`, {
                'index.json': { title: _kind, revision: 'one' },
                [bankName]: bank,
            });

            await expect(inspectHoshidictsArchive(archive)).resolves.toMatchObject({
                sourceLanguage: null,
                hasSupportedBank: true,
                hasJapaneseEntry: true,
            });
        }
    );

    it('installs one selected recommended dictionary', async () => {
        const baseDir = makeTempDir();
        const downloadArchive = vi.fn(async (url: string, outputPath: string) => {
            const recommended = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
                (dictionary) => dictionary.downloadUrl === url
            );
            if (!recommended) {
                throw new Error(`Unexpected recommended dictionary URL: ${url}`);
            }
            writeRecommendedArchive(outputPath, recommended);
        });
        const { manager } = createHarness(baseDir, { downloadArchive });

        const snapshot = await manager.installRecommendedDictionary('jmdict');
        const jmdict = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
            (dictionary) => dictionary.id === 'jmdict'
        );

        expect(downloadArchive).toHaveBeenCalledTimes(1);
        expect(downloadArchive).toHaveBeenCalledWith(
            jmdict?.downloadUrl,
            expect.any(String)
        );
        expect(
            snapshot.recommendedDictionaries.find(
                (dictionary) => dictionary.id === 'jmdict'
            )
        ).toEqual({ id: 'jmdict', installed: true });
    });

    it('trusts a catalog download with an oversized legacy bank only after import kind validation', async () => {
        const baseDir = makeTempDir();
        const bccwj = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
            (dictionary) => dictionary.id === 'bccwj'
        );
        const downloadArchive = vi.fn(async (_url: string, outputPath: string) => {
            writeRecommendedArchive(outputPath, bccwj!);
        });
        const { manager } = createHarness(baseDir, {
            downloadArchive,
            inspectArchive: async () => ({
                sourceLanguage: null,
                hasSupportedBank: true,
                hasJapaneseEntry: false,
            }),
        });

        const snapshot = await manager.installRecommendedDictionary('bccwj');

        expect(snapshot.dictionaries[0]).toMatchObject({
            title: 'BCCWJ',
            termCount: 0,
            frequencyCount: 1,
        });
    });

    it('installs the expanded default bundle without the duplicate JMdict alternative', async () => {
        const baseDir = makeTempDir();
        const downloadArchive = vi.fn(async (url: string, outputPath: string) => {
            const recommended = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
                (dictionary) => dictionary.downloadUrl === url
            );
            if (!recommended) {
                throw new Error(`Unexpected recommended dictionary URL: ${url}`);
            }
            writeRecommendedArchive(outputPath, recommended);
        });
        const { manager } = createHarness(baseDir, { downloadArchive });

        const snapshot = await manager.installRecommendedDictionaries();
        const defaults = RECOMMENDED_HOSHIDICTS_DICTIONARIES.filter(
            (dictionary) =>
                DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.some(
                    (id) => id === dictionary.id
                )
        );

        expect(
            downloadArchive.mock.calls.map(([url]) => url)
        ).toEqual(defaults.map((dictionary) => dictionary.downloadUrl));
        expect(downloadArchive).toHaveBeenCalledTimes(7);
        expect(snapshot.dictionaries).toHaveLength(7);
        expect(snapshot.recommendedDictionaries).toEqual(
            RECOMMENDED_HOSHIDICTS_DICTIONARIES.map((dictionary) => ({
                id: dictionary.id,
                installed: DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.some(
                    (id) => id === dictionary.id
                ),
            }))
        );

        await manager.installRecommendedDictionaries();
        expect(downloadArchive).toHaveBeenCalledTimes(7);
    });

    it('resumes a partial recommended install without downloading completed dictionaries again', async () => {
        const baseDir = makeTempDir();
        let jmnedictAttempts = 0;
        const downloadArchive = vi.fn(async (url: string, outputPath: string) => {
            const recommended = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
                (dictionary) => dictionary.downloadUrl === url
            );
            if (!recommended) {
                throw new Error(`Unexpected recommended dictionary URL: ${url}`);
            }
            if (recommended.id === 'jmnedict' && jmnedictAttempts++ === 0) {
                throw new Error('temporary download failure');
            }
            writeRecommendedArchive(outputPath, recommended);
        });
        const { manager } = createHarness(baseDir, { downloadArchive });

        await expect(manager.installRecommendedDictionaries()).rejects.toThrow(
            'temporary download failure'
        );
        const partial = await manager.getSnapshot();
        expect(
            partial.recommendedDictionaries.find(
                (dictionary) => dictionary.id === 'jitendex'
            )?.installed
        ).toBe(true);
        expect(
            partial.recommendedDictionaries.find(
                (dictionary) => dictionary.id === 'jmnedict'
            )?.installed
        ).toBe(false);

        await manager.installRecommendedDictionaries();

        const attempts = (id: RecommendedDictionary['id']) => {
            const recommended = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
                (dictionary) => dictionary.id === id
            );
            return downloadArchive.mock.calls.filter(
                ([url]) => url === recommended?.downloadUrl
            ).length;
        };
        expect(attempts('jitendex')).toBe(1);
        expect(attempts('jmnedict')).toBe(2);
    });

    it('inspects source language and Japanese terms from a real ZIP archive', async () => {
        const archive = await writeZipArchive(makeTempDir(), 'japanese.zip', {
            'index.json': {
                title: 'Japanese',
                revision: 'one',
            },
            'term_bank_1.json': [['食べる', 'たべる', '', '', 0, ['to eat'], 1, '']],
        });

        await expect(inspectHoshidictsArchive(archive)).resolves.toEqual({
            sourceLanguage: null,
            hasSupportedBank: true,
            hasJapaneseEntry: true,
        });
    });

    it('inspects a highly-compressible Yomitan bank without stalling', async () => {
        const archive = await writeZipArchive(makeTempDir(), 'compressed.zip', {
            'index.json': {
                title: 'Compressed',
                revision: 'one',
            },
            'term_bank_1.json': [
                ['猫', 'ねこ', '', '', 0, ['x'.repeat(8 * 1024 * 1024)], 1, ''],
            ],
        });

        await expect(inspectHoshidictsArchive(archive)).resolves.toEqual({
            sourceLanguage: null,
            hasSupportedBank: true,
            hasJapaneseEntry: true,
        });
    });

    it('imports and rehydrates frequency-only state from generated index metadata', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'frequency.zip', {
            title: 'Frequency',
            revision: 'one',
            sourceLanguage: null,
            japanese: true,
            terms: 0,
            frequencies: 17,
            frequencyMode: 'rank-based',
        });
        const { manager } = createHarness(baseDir);

        const imported = await manager.importDictionary(archive);

        const rehydrated = await createHarness(baseDir).manager.getSnapshot();
        for (const snapshot of [imported, rehydrated]) {
            expect(snapshot.dictionaries[0]).toMatchObject({
                termCount: 0,
                frequencyCount: 17,
                frequencyMode: 'rank-based',
            });
        }
    });

    it('rejects explicit non-Japanese and unverifiable legacy dictionaries', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const english = writeArchive(archivesDir, 'english.zip', {
            title: 'English',
            revision: 'one',
            sourceLanguage: 'en',
        });
        const legacy = writeArchive(archivesDir, 'legacy.zip', {
            title: 'Legacy',
            revision: 'one',
            sourceLanguage: null,
            japanese: false,
        });
        const { manager, runImport } = createHarness(baseDir);

        await expect(manager.importDictionary(english)).rejects.toThrow(
            'source language must be ja'
        );
        await expect(manager.importDictionary(legacy)).rejects.toThrow(
            'must contain Japanese entries'
        );
        expect(runImport).not.toHaveBeenCalled();
    });

    it('rejects archives without supported entries', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'empty.zip', {
            title: 'Empty',
            revision: 'one',
            sourceLanguage: 'ja',
            terms: 0,
        });
        const { manager } = createHarness(baseDir, {
            inspectArchive: async () => ({
                sourceLanguage: 'ja',
                hasSupportedBank: true,
                hasJapaneseEntry: true,
            }),
        });

        await expect(manager.importDictionary(archive)).rejects.toThrow(
            'does not contain supported entries'
        );
        expect((await manager.getSnapshot()).dictionaries).toEqual([]);
    });

    it('accepts a legacy generated index without a media count or media files', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'legacy-no-media.zip', {
            title: 'Legacy no media',
            revision: 'one',
            sourceLanguage: 'ja',
            omitGeneratedMediaCount: true,
        });
        const { manager } = createHarness(baseDir);

        await manager.importDictionary(archive);

        expect((await manager.getSnapshot()).dictionaries).toHaveLength(1);
    });

    it.each([
        ['media.idx', 'missing'],
        ['media.bin', 'missing'],
        ['media.idx', 'empty'],
        ['media.bin', 'empty'],
    ])(
        'rejects a generated media dictionary when %s is %s before publication',
        async (mediaFile, condition) => {
            const baseDir = makeTempDir();
            const archive = writeArchive(makeTempDir(), 'media.zip', {
                title: 'Media dictionary',
                revision: 'one',
                sourceLanguage: 'ja',
                media: 1,
            });
            const { manager, reloadNative } = createHarness(baseDir, {
                runImport: async (archivePath, outputDir) => {
                    const imported = readArchive(archivePath);
                    writeImportedDictionary(outputDir, imported);
                    const mediaPath = path.join(outputDir, imported.title, mediaFile);
                    if (condition === 'missing') {
                        fs.rmSync(mediaPath);
                    } else {
                        fs.writeFileSync(mediaPath, '');
                    }
                    return {
                        success: true,
                        title: imported.title,
                        termCount: imported.terms ?? 1,
                        mediaCount: imported.media ?? 0,
                        error: '',
                    };
                },
            });

            await expect(manager.importDictionary(archive)).rejects.toThrow(
                condition === 'missing'
                    ? `Dictionary is missing ${mediaFile}`
                    : `Dictionary file ${mediaFile} is empty or not a file.`
            );

            expect(reloadNative).not.toHaveBeenCalled();
            expect((await manager.getSnapshot()).dictionaries).toEqual([]);
        }
    );

    it('keeps the working generation when replacement media validation fails', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const working = writeArchive(archivesDir, 'working.zip', {
            title: 'Media replacement',
            revision: 'working',
            sourceLanguage: 'ja',
        });
        const broken = writeArchive(archivesDir, 'broken.zip', {
            title: 'Media replacement',
            revision: 'broken',
            sourceLanguage: 'ja',
            media: 1,
        });
        const { manager, reloadNative } = createHarness(baseDir, {
            runImport: async (archivePath, outputDir) => {
                const imported = readArchive(archivePath);
                writeImportedDictionary(outputDir, imported);
                if ((imported.media ?? 0) > 0) {
                    fs.rmSync(path.join(outputDir, imported.title, 'media.bin'));
                }
                return {
                    success: true,
                    title: imported.title,
                    termCount: imported.terms ?? 1,
                    mediaCount: imported.media ?? 0,
                    error: '',
                };
            },
        });

        await manager.importDictionary(working);
        const previousManifest = readManifest(baseDir);

        await expect(manager.importDictionary(broken)).rejects.toThrow(
            'Dictionary is missing media.bin'
        );

        const snapshot = await manager.getSnapshot();
        expect(snapshot.dictionaries).toHaveLength(1);
        expect(snapshot.dictionaries[0].revision).toBe('working');
        expect(readManifest(baseDir)).toEqual(previousManifest);
        expect(reloadNative).toHaveBeenCalledTimes(1);
    });

    it('honors the importer media count when the generated index omits it', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'reported-media.zip', {
            title: 'Reported media',
            revision: 'one',
            sourceLanguage: 'ja',
            media: 1,
            omitGeneratedMediaCount: true,
        });
        const { manager, reloadNative } = createHarness(baseDir, {
            runImport: async (archivePath, outputDir) => {
                const imported = readArchive(archivePath);
                writeImportedDictionary(outputDir, imported);
                fs.rmSync(path.join(outputDir, imported.title, 'media.idx'));
                return {
                    success: true,
                    title: imported.title,
                    termCount: imported.terms ?? 1,
                    mediaCount: imported.media ?? 0,
                    error: '',
                };
            },
        });

        await expect(manager.importDictionary(archive)).rejects.toThrow(
            'Dictionary is missing media.idx'
        );
        expect(reloadNative).not.toHaveBeenCalled();
    });

    it('rejects an installed media generation after a required media file is lost', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'media.zip', {
            title: 'Media dictionary',
            revision: 'one',
            sourceLanguage: 'ja',
            media: 2,
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const manifest = readManifest(baseDir);
        const dictionaryPath = path.join(
            baseDir,
            'dictionaries',
            'hoshidicts',
            ...manifest.dictionaries[0].path.split('/')
        );
        fs.rmSync(path.join(dictionaryPath, 'media.bin'));

        const snapshot = await manager.getSnapshot();

        expect(snapshot.dictionaries).toEqual([]);
        expect(snapshot.lastError).toContain('Dictionary is missing media.bin');
    });

    it('rejects importer titles which escape the staging directory', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'unsafe.zip', {
            title: 'Unsafe',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir, {
            runImport: async () => ({
                success: true,
                title: '../Unsafe',
                termCount: 1,
                mediaCount: 0,
                error: '',
            }),
        });

        await expect(manager.importDictionary(archive)).rejects.toThrow(
            'cannot be used as a directory name'
        );
    });
});

describe('Hoshidicts updates and schedule', () => {
    it('rejects a wrong-kind update for an installed recommendation', async () => {
        const baseDir = makeTempDir();
        const jitendex = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
            (dictionary) => dictionary.id === 'jitendex'
        )!;
        let downloadCount = 0;
        const downloadArchive = vi.fn(async (_url: string, outputPath: string) => {
            const archive =
                downloadCount++ === 0
                    ? archiveForRecommended(jitendex)
                    : {
                          ...archiveForRecommended(jitendex),
                          revision: 'wrong-kind-update',
                          terms: 0,
                          frequencies: 1,
                      };
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, JSON.stringify(archive), 'utf8');
        });
        const { manager } = createHarness(baseDir, {
            downloadArchive,
            fetchRemoteIndex: async () => ({
                revision: 'wrong-kind-update',
                downloadUrl: jitendex.downloadUrl,
            }),
        });

        await manager.installRecommendedDictionary('jitendex');
        const snapshot = await manager.checkForUpdates();

        expect(snapshot.lastError).toContain('did not contain term entries');
        expect(snapshot.dictionaries[0]).toMatchObject({
            revision: 'jitendex.2026-08-08',
            termCount: 1,
            frequencyCount: 0,
        });
    });

    it('rejects a manual wrong-kind replacement of an installed recommendation', async () => {
        const baseDir = makeTempDir();
        const jitendex = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
            (dictionary) => dictionary.id === 'jitendex'
        )!;
        const downloadArchive = vi.fn(async (_url: string, outputPath: string) => {
            writeRecommendedArchive(outputPath, jitendex);
        });
        const { manager } = createHarness(baseDir, { downloadArchive });
        await manager.installRecommendedDictionary('jitendex');
        const wrongKind = writeArchive(makeTempDir(), 'wrong-kind.zip', {
            ...archiveForRecommended(jitendex),
            revision: 'manual-wrong-kind',
            terms: 0,
            frequencies: 1,
        });

        await expect(manager.importDictionary(wrongKind)).rejects.toThrow(
            'did not contain term entries'
        );
        expect((await manager.getSnapshot()).dictionaries[0]).toMatchObject({
            revision: 'jitendex.2026-08-08',
            termCount: 1,
            frequencyCount: 0,
        });
    });

    it('treats revisions as opaque and updates through the staged import path', async () => {
        const baseDir = makeTempDir();
        const archivesDir = makeTempDir();
        const archive = writeArchive(archivesDir, 'updatable.zip', {
            title: 'Updatable',
            revision: 'revision-2',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://dict.example/index.json',
            downloadUrl: 'https://dict.example/dictionary.zip',
        });
        const update: TestArchive = {
            title: 'Updatable [new release]',
            revision: 'revision-10-beta',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://dict.example/index.json',
            downloadUrl: 'https://dict.example/dictionary.zip',
        };
        const fetchRemoteIndex = vi.fn(async () => ({
            revision: 'revision-10-beta',
            downloadUrl: 'https://cdn.example/dictionary.zip',
        }));
        const downloadArchive = vi.fn(async (_url: string, outputPath: string) => {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, JSON.stringify(update), 'utf8');
        });
        const { manager } = createHarness(baseDir, {
            fetchRemoteIndex,
            downloadArchive,
        });

        await manager.importDictionary(archive);
        const dictionaryId = (await manager.getSnapshot()).dictionaries[0].id;
        await manager.renameDictionary(dictionaryId, 'My updateable dictionary');
        await manager.setDictionarySchedule(dictionaryId, 'hourly');
        await manager.checkForUpdates();

        expect(fetchRemoteIndex).toHaveBeenCalledWith(
            'https://dict.example/index.json'
        );
        expect(downloadArchive).toHaveBeenCalledWith(
            'https://cdn.example/dictionary.zip',
            expect.any(String)
        );
        const updated = (await manager.getSnapshot()).dictionaries[0];
        expect(updated.revision).toBe('revision-10-beta');
        expect(updated.title).toBe('Updatable [new release]');
        expect(updated.displayName).toBe('My updateable dictionary');
        expect(updated.updateScheduleOverride).toBe('hourly');
        expect(updated.lastUpdateCheck).not.toBeNull();
        expect(readManifest(baseDir).dictionaries[0]).toMatchObject({
            updateScheduleOverride: 'hourly',
            lastUpdateCheck: updated.lastUpdateCheck,
        });
    });

    it('never requests updates from non-HTTPS metadata', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'insecure.zip', {
            title: 'Insecure',
            revision: 'one',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'http://dict.example/index.json',
            downloadUrl: 'https://dict.example/dictionary.zip',
        });
        const { manager, fetchRemoteIndex } = createHarness(baseDir);

        await manager.importDictionary(archive);
        await manager.checkForUpdates();

        expect(fetchRemoteIndex).not.toHaveBeenCalled();
    });

    it('retains an update generation when manifest rollback cannot be verified', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'updatable.zip', {
            title: 'Updatable',
            revision: 'working',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://dict.example/index.json',
            downloadUrl: 'https://dict.example/dictionary.zip',
        });
        const update: TestArchive = {
            title: 'Updatable',
            revision: 'published-but-not-loaded',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://dict.example/index.json',
            downloadUrl: 'https://dict.example/dictionary.zip',
        };
        let reloadCount = 0;
        const { manager } = createHarness(baseDir, {
            reloadNative: async () => {
                reloadCount += 1;
                if (reloadCount === 2) {
                    throw new Error('replacement rejected');
                }
                return 1;
            },
            fetchRemoteIndex: async () => ({
                revision: update.revision,
                downloadUrl: update.downloadUrl ?? null,
            }),
            downloadArchive: async (_url, outputPath) => {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, JSON.stringify(update), 'utf8');
            },
        });

        await manager.importDictionary(archive);
        fs.writeFileSync(
            path.join(
                baseDir,
                'dictionaries',
                'hoshidicts',
                '.manifest-test-5.tmp'
            ),
            'block rollback temp creation',
            'utf8'
        );

        const snapshot = await manager.checkForUpdates();

        expect(snapshot.dictionaries[0].revision).toBe('working');
        expect(snapshot.lastError).toContain('generation was retained for recovery');
        const dictionaryId = readManifest(baseDir).dictionaries[0].id;
        const generations = fs.readdirSync(
            path.join(
                baseDir,
                'dictionaries',
                'hoshidicts',
                'generations',
                dictionaryId
            )
        );
        expect(generations).toHaveLength(2);
        expect(reloadCount).toBe(2);
    });

    it('persists dictionary overrides while inheriting the global schedule by default', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
        const baseDir = makeTempDir();
        const updatableArchive = writeArchive(makeTempDir(), 'updatable.zip', {
            title: 'Updatable',
            revision: 'same',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://updatable.example/index.json',
            downloadUrl: 'https://updatable.example/dictionary.zip',
        });
        const manualArchive = writeArchive(makeTempDir(), 'manual.zip', {
            title: 'Manual',
            revision: 'same',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionaries([updatableArchive, manualArchive]);
        const [updatable, manual] = (await manager.getSnapshot()).dictionaries;

        let snapshot = await manager.setSchedule('daily');
        expect(snapshot.nextCheck).toBe('2026-08-05T12:00:00.000Z');
        expect(snapshot.dictionaries[0]).toMatchObject({
            updateScheduleOverride: null,
            lastUpdateCheck: null,
        });

        snapshot = await manager.setDictionarySchedule(updatable.id, 'hourly');
        expect(snapshot.dictionaries[0].updateScheduleOverride).toBe('hourly');
        expect(readManifest(baseDir).dictionaries[0]).toMatchObject({
            updateScheduleOverride: 'hourly',
            lastUpdateCheck: null,
        });

        snapshot = await manager.setDictionarySchedule(updatable.id, null);
        expect(snapshot.dictionaries[0].updateScheduleOverride).toBeNull();
        await expect(
            manager.setDictionarySchedule(manual.id, 'hourly')
        ).rejects.toThrow('does not support automatic updates');
        await expect(
            manager.setDictionarySchedule('missing', 'hourly')
        ).rejects.toThrow('not installed');
    });

    it('migrates legacy global check time into inherited dictionary state', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'legacy-scheduled.zip', {
            title: 'Legacy scheduled',
            revision: 'same',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://legacy.example/index.json',
            downloadUrl: 'https://legacy.example/dictionary.zip',
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const legacyManifest = readManifest(baseDir);
        delete legacyManifest.dictionaries[0].updateScheduleOverride;
        delete legacyManifest.dictionaries[0].lastUpdateCheck;
        legacyManifest.schedule = 'daily';
        legacyManifest.lastCheck = '2026-08-05T06:00:00.000Z';
        legacyManifest.nextCheck = '2026-08-06T06:00:00.000Z';
        writeManifest(baseDir, legacyManifest);

        const reloaded = createHarness(baseDir).manager;
        const migrated = await reloaded.getSnapshot();
        expect(migrated.dictionaries[0]).toMatchObject({
            updateScheduleOverride: null,
            lastUpdateCheck: '2026-08-05T06:00:00.000Z',
        });
        expect(migrated.nextCheck).toBe('2026-08-06T06:00:00.000Z');

        await reloaded.setDictionarySchedule(
            migrated.dictionaries[0].id,
            'hourly'
        );
        expect(readManifest(baseDir).dictionaries[0]).toMatchObject({
            updateScheduleOverride: 'hourly',
            lastUpdateCheck: '2026-08-05T06:00:00.000Z',
        });
    });

    it('checks only individually due dictionaries and manually forces all of them', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
        const baseDir = makeTempDir();
        const hourlyArchive = writeArchive(makeTempDir(), 'hourly.zip', {
            title: 'Hourly',
            revision: 'same',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://hourly.example/index.json',
            downloadUrl: 'https://hourly.example/dictionary.zip',
        });
        const inheritedArchive = writeArchive(makeTempDir(), 'inherited.zip', {
            title: 'Inherited',
            revision: 'same',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://inherited.example/index.json',
            downloadUrl: 'https://inherited.example/dictionary.zip',
        });
        const { manager, fetchRemoteIndex } = createHarness(baseDir);
        await manager.importDictionaries([hourlyArchive, inheritedArchive]);
        const hourlyId = (await manager.getSnapshot()).dictionaries[0].id;
        await manager.setSchedule('daily');
        await manager.setDictionarySchedule(hourlyId, 'hourly');

        manager.startScheduler();
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledTimes(2);
        expect((await manager.getSnapshot()).nextCheck).toBe(
            '2026-08-05T13:00:00.000Z'
        );

        await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60 * 1000);
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledTimes(3);
        expect(fetchRemoteIndex).toHaveBeenLastCalledWith(
            'https://hourly.example/index.json'
        );
        expect(
            (await manager.getSnapshot()).dictionaries.map(
                (dictionary) => dictionary.lastUpdateCheck
            )
        ).toEqual([
            '2026-08-05T13:00:00.000Z',
            '2026-08-05T12:00:00.000Z',
        ]);

        await manager.setSchedule('off');
        fetchRemoteIndex.mockClear();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledOnce();
        expect(fetchRemoteIndex).toHaveBeenLastCalledWith(
            'https://hourly.example/index.json'
        );

        await manager.setDictionarySchedule(hourlyId, 'off');
        fetchRemoteIndex.mockClear();
        await manager.checkForUpdates();
        expect(fetchRemoteIndex).toHaveBeenCalledTimes(2);
        await manager.stopScheduler();
    });

    it('rearms a one-shot timer at the exact due time with a 24-hour maximum delay', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'monthly.zip', {
            title: 'Monthly',
            revision: 'same',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://monthly.example/index.json',
            downloadUrl: 'https://monthly.example/dictionary.zip',
        });
        const trackedSetTimeout = vi.fn(globalThis.setTimeout);
        const { manager, fetchRemoteIndex } = createHarness(baseDir, {
            setTimeout: trackedSetTimeout as typeof setTimeout,
        });
        await manager.importDictionary(archive);
        await manager.setSchedule('monthly');

        manager.startScheduler();
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledOnce();
        expect(trackedSetTimeout.mock.calls.at(-1)?.[1]).toBe(
            24 * 60 * 60 * 1000
        );

        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledOnce();
        expect(trackedSetTimeout.mock.calls.at(-1)?.[1]).toBe(
            24 * 60 * 60 * 1000
        );
        await manager.stopScheduler();
    });

    it('checks once at startup and then hourly only when work is due', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'scheduled.zip', {
            title: 'Scheduled',
            revision: 'same',
            sourceLanguage: 'ja',
            isUpdatable: true,
            indexUrl: 'https://dict.example/index.json',
            downloadUrl: 'https://dict.example/dictionary.zip',
        });
        const { manager, fetchRemoteIndex } = createHarness(baseDir);
        await manager.importDictionary(archive);
        await manager.setSchedule('daily');

        manager.startScheduler();
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        await manager.waitForIdle();
        expect(fetchRemoteIndex).toHaveBeenCalledTimes(2);
        await manager.stopScheduler();
    });
});
