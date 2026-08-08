import archiver from 'archiver';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS } from '../../../shared/features/hoshidicts.js';
import {
    defaultHoshidictsAudioProfile,
    defaultHoshidictsMiningProfile,
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
            counts: {
                terms: { total: archive.terms ?? 1 },
                termMeta: {
                    total: (archive.frequencies ?? 0) + (archive.pitches ?? 0),
                    freq: archive.frequencies ?? 0,
                    pitch: archive.pitches ?? 0,
                },
                kanji: { total: archive.kanji ?? 0 },
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
                audio: '',
            },
            disabledFields: [],
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

describe('Hoshidicts lookup mode', () => {
    it('loads manifests created before lookup mode was introduced as Shift', async () => {
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
    });

    it('defaults new state to Shift and persists hover lookup', async () => {
        const baseDir = makeTempDir();
        const { manager } = createHarness(baseDir);

        expect((await manager.getSnapshot()).lookupMode).toBe('shift');
        expect((await manager.getSnapshot()).activationKey).toBe('Shift');
        expect((await manager.getSnapshot()).sourceHighlightEnabled).toBe(false);
        expect((await manager.getSnapshot()).popupHideDelayMs).toBe(300);

        const snapshot = await manager.setReaderPreferences(
            'hover',
            850,
            'F8',
            true
        );

        expect(snapshot.lookupMode).toBe('hover');
        expect(snapshot.activationKey).toBe('F8');
        expect(snapshot.sourceHighlightEnabled).toBe(true);
        expect(snapshot.popupHideDelayMs).toBe(850);
        expect(readManifest(baseDir).lookupMode).toBe('hover');
        expect(readManifest(baseDir).activationKey).toBe('F8');
        expect(readManifest(baseDir).sourceHighlightEnabled).toBe(true);
        expect(readManifest(baseDir).popupHideDelayMs).toBe(850);

        const reloaded = createHarness(baseDir).manager;
        expect((await reloaded.getSnapshot()).lookupMode).toBe('hover');
        expect((await reloaded.getSnapshot()).activationKey).toBe('F8');
        expect((await reloaded.getSnapshot()).sourceHighlightEnabled).toBe(true);
        expect((await reloaded.getSnapshot()).popupHideDelayMs).toBe(850);

        const shifted = await reloaded.setLookupMode('shift');
        expect(shifted.lookupMode).toBe('shift');
        expect(shifted.activationKey).toBe('F8');
        expect(shifted.sourceHighlightEnabled).toBe(true);
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
        await manager.setReaderPreferences('hover', 900, 'Space', true);
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
