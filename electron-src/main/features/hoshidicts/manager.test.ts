import archiver from 'archiver';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    defaultHoshidictsMiningProfile,
    HoshidictsManager,
    inspectHoshidictsArchive,
    normalizeHoshidictsMiningProfile,
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
    isUpdatable?: boolean;
    indexUrl?: string;
    downloadUrl?: string;
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

function readManifest(baseDir: string): any {
    return JSON.parse(
        fs.readFileSync(
            path.join(baseDir, 'dictionaries', 'hoshidicts', 'manifest.json'),
            'utf8'
        )
    );
}

function readMiningProfile(baseDir: string): any {
    return JSON.parse(
        fs.readFileSync(
            path.join(
                baseDir,
                'dictionaries',
                'hoshidicts',
                'mining-profile.json'
            ),
            'utf8'
        )
    );
}

function writeImportedDictionary(outputDir: string, archive: TestArchive): void {
    const dictionaryDir = path.join(outputDir, archive.title);
    fs.mkdirSync(dictionaryDir, { recursive: true });
    for (const fileName of ['.hoshidicts_3', 'hash.table', 'bloom.filter', 'blobs.bin']) {
        fs.writeFileSync(path.join(dictionaryDir, fileName), fileName, 'utf8');
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
            importDate: Date.now(),
            counts: {
                terms: { total: archive.terms ?? 1 },
                termMeta: {},
                kanji: { total: 0 },
            },
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
                hasTermBank: (archive.terms ?? 1) > 0,
                hasJapaneseTerm: archive.japanese !== false,
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
                error: '',
            };
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
        ...overrides,
    };
    return {
        manager: new HoshidictsManager(baseDir, dependencies),
        reloadNative,
        fetchRemoteIndex,
        downloadArchive,
        inspectArchive,
        runImport,
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
    it('replaces a reimported dictionary without changing its ordering or enabled state', async () => {
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

describe('Hoshidicts feature state', () => {
    it('migrates the legacy toggle into an existing manifest exactly once', async () => {
        const baseDir = makeTempDir();
        const archive = writeArchive(makeTempDir(), 'alpha.zip', {
            title: 'Alpha',
            revision: 'one',
            sourceLanguage: 'ja',
        });
        const { manager } = createHarness(baseDir);
        await manager.importDictionary(archive);
        const legacyManifest = readManifest(baseDir);
        delete legacyManifest.featureEnabled;
        fs.writeFileSync(
            manager.manifestPath,
            `${JSON.stringify(legacyManifest, null, 2)}\n`,
            'utf8'
        );

        await manager.initializeFeatureState(true);
        expect((await manager.getSnapshot()).featureEnabled).toBe(true);
        expect(readManifest(baseDir).featureEnabled).toBe(true);

        await manager.initializeFeatureState(false);
        expect((await manager.getSnapshot()).featureEnabled).toBe(true);
        expect((await manager.getSnapshot()).dictionaries).toHaveLength(1);
    });

    it('persists a dedicated feature switch independently of dictionary state', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        await manager.initializeFeatureState(false);
        expect((await manager.getSnapshot()).featureEnabled).toBe(false);

        const snapshot = await manager.setFeatureEnabled(true);
        expect(snapshot.featureEnabled).toBe(true);
        expect(snapshot.dictionaries).toEqual([]);
        expect(readManifest(baseDir).featureEnabled).toBe(true);
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
            version: 1,
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
            },
            tags: ['hoshidicts', 'custom'],
            duplicatePolicy: 'allow',
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

    it('rejects unsupported duplicate policies', () => {
        expect(() =>
            normalizeHoshidictsMiningProfile({
                duplicatePolicy: 'overwrite',
            })
        ).toThrow('duplicate policy is invalid');
    });
});

describe('Hoshidicts import policy', () => {
    it('installs one selected recommended dictionary', async () => {
        const baseDir = makeTempDir();
        const downloadArchive = vi.fn(async (url: string, outputPath: string) => {
            const recommended = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
                (dictionary) => dictionary.downloadUrl === url
            );
            if (!recommended) {
                throw new Error(`Unexpected recommended dictionary URL: ${url}`);
            }
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(
                outputPath,
                JSON.stringify({
                    title: 'JMdict',
                    revision: 'jmdict.2026-08-06',
                    sourceLanguage: 'ja',
                    isUpdatable: true,
                    indexUrl: recommended.indexUrl,
                    downloadUrl: recommended.downloadUrl,
                }),
                'utf8'
            );
        });
        const { manager } = createHarness(baseDir, { downloadArchive });

        const snapshot = await manager.installRecommendedDictionary('jmdict');

        expect(downloadArchive).toHaveBeenCalledTimes(1);
        expect(downloadArchive).toHaveBeenCalledWith(
            RECOMMENDED_HOSHIDICTS_DICTIONARIES[0].downloadUrl,
            expect.any(String)
        );
        expect(snapshot.recommendedDictionaries).toEqual([
            { id: 'jmdict', installed: true },
            { id: 'jmnedict', installed: false },
        ]);
    });

    it('installs the recommended JMdict and JMnedict pair without KANJIDIC', async () => {
        const baseDir = makeTempDir();
        const downloadArchive = vi.fn(async (url: string, outputPath: string) => {
            const recommended = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
                (dictionary) => dictionary.downloadUrl === url
            );
            if (!recommended) {
                throw new Error(`Unexpected recommended dictionary URL: ${url}`);
            }
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(
                outputPath,
                JSON.stringify({
                    title:
                        recommended.id === 'jmdict'
                            ? 'JMdict [2026-08-05]'
                            : 'JMnedict [2026-08-05]',
                    revision: `${recommended.id}.2026-08-05`,
                    sourceLanguage: 'ja',
                    isUpdatable: true,
                    indexUrl: recommended.indexUrl,
                    downloadUrl: recommended.downloadUrl,
                }),
                'utf8'
            );
        });
        const { manager } = createHarness(baseDir, { downloadArchive });

        const snapshot = await manager.installRecommendedDictionaries();

        expect(
            RECOMMENDED_HOSHIDICTS_DICTIONARIES.map(
                (dictionary) => dictionary.downloadUrl
            )
        ).toEqual([
            expect.stringContaining('JMdict_english_without_proper_names.zip'),
            expect.stringContaining('JMnedict.zip'),
        ]);
        expect(
            RECOMMENDED_HOSHIDICTS_DICTIONARIES.some((dictionary) =>
                dictionary.downloadUrl.includes('KANJIDIC')
            )
        ).toBe(false);
        expect(downloadArchive).toHaveBeenCalledTimes(2);
        expect(snapshot.dictionaries.map((dictionary) => dictionary.title)).toEqual([
            'JMdict [2026-08-05]',
            'JMnedict [2026-08-05]',
        ]);
        expect(snapshot.recommendedDictionaries).toEqual([
            { id: 'jmdict', installed: true },
            { id: 'jmnedict', installed: true },
        ]);

        await manager.installRecommendedDictionaries();
        expect(downloadArchive).toHaveBeenCalledTimes(2);
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
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(
                outputPath,
                JSON.stringify({
                    title:
                        recommended.id === 'jmdict'
                            ? 'JMdict [2026-08-05]'
                            : 'JMnedict [2026-08-05]',
                    revision: `${recommended.id}.2026-08-05`,
                    sourceLanguage: 'ja',
                    isUpdatable: true,
                    indexUrl: recommended.indexUrl,
                    downloadUrl: recommended.downloadUrl,
                }),
                'utf8'
            );
        });
        const { manager } = createHarness(baseDir, { downloadArchive });

        await expect(manager.installRecommendedDictionaries()).rejects.toThrow(
            'temporary download failure'
        );
        expect((await manager.getSnapshot()).recommendedDictionaries).toEqual([
            { id: 'jmdict', installed: true },
            { id: 'jmnedict', installed: false },
        ]);

        await manager.installRecommendedDictionaries();

        expect(
            downloadArchive.mock.calls.filter(
                ([url]) =>
                    url === RECOMMENDED_HOSHIDICTS_DICTIONARIES[0].downloadUrl
            )
        ).toHaveLength(1);
        expect(
            downloadArchive.mock.calls.filter(
                ([url]) =>
                    url === RECOMMENDED_HOSHIDICTS_DICTIONARIES[1].downloadUrl
            )
        ).toHaveLength(2);
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
            hasTermBank: true,
            hasJapaneseTerm: true,
        });
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
            'must contain Japanese terms'
        );
        expect(runImport).not.toHaveBeenCalled();
    });

    it('rejects archives without term entries', async () => {
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
                hasTermBank: true,
                hasJapaneseTerm: true,
            }),
        });

        await expect(manager.importDictionary(archive)).rejects.toThrow(
            'does not contain term entries'
        );
        expect((await manager.getSnapshot()).dictionaries).toEqual([]);
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
                error: '',
            }),
        });

        await expect(manager.importDictionary(archive)).rejects.toThrow(
            'cannot be used as a directory name'
        );
    });
});

describe('Hoshidicts updates and schedule', () => {
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
