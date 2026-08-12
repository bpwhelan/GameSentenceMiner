import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    app: { isPackaged: false },
}));

import { exportHoshidictsBackup } from './hoshidicts-backup.js';
import {
    defaultHoshidictsAudioProfile,
    defaultHoshidictsMiningProfile,
    HoshidictsManager,
    type ArchiveInspection,
    type HoshidictsImportReport,
    type HoshidictsManagerDependencies,
} from './manager.js';
import { makeHoshidictsReaderPreferences } from './test_helpers.js';

interface TestArchive {
    title: string;
    revision: string;
    sourceLanguage?: string | null;
    terms?: number;
    frequencies?: number;
    frequencyMode?: 'occurrence-based' | 'rank-based' | null;
    isUpdatable?: boolean;
    indexUrl?: string | null;
    downloadUrl?: string | null;
}

const tempDirectories: string[] = [];

function makeTempDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirectories.push(directory);
    return directory;
}

function writeArchive(directory: string, fileName: string, archive: TestArchive): string {
    fs.mkdirSync(directory, { recursive: true });
    const archivePath = path.join(directory, fileName);
    fs.writeFileSync(archivePath, JSON.stringify(archive), 'utf8');
    return archivePath;
}

function readArchive(archivePath: string): TestArchive {
    return JSON.parse(fs.readFileSync(archivePath, 'utf8')) as TestArchive;
}

function writeImportedDictionary(outputDirectory: string, archive: TestArchive): void {
    const dictionaryDirectory = path.join(outputDirectory, archive.title);
    fs.mkdirSync(dictionaryDirectory, { recursive: true });
    for (const fileName of ['.hoshidicts_4', 'hash.table', 'bloom.filter', 'blobs.bin']) {
        fs.writeFileSync(path.join(dictionaryDirectory, fileName), fileName);
    }
    fs.writeFileSync(
        path.join(dictionaryDirectory, 'index.json'),
        JSON.stringify({
            title: archive.title,
            revision: archive.revision,
            sourceLanguage: archive.sourceLanguage ?? 'ja',
            isUpdatable: archive.isUpdatable === true,
            indexUrl: archive.indexUrl ?? null,
            downloadUrl: archive.downloadUrl ?? null,
            frequencyMode: archive.frequencyMode ?? null,
            importDate: Date.parse('2026-08-08T00:00:00.000Z'),
            counts: {
                terms: { total: archive.terms ?? 1 },
                termMeta: {
                    total: archive.frequencies ?? 0,
                    freq: archive.frequencies ?? 0,
                    pitch: 0,
                },
                kanji: { total: 0 },
                media: { total: 0 },
            },
        }),
        'utf8',
    );
}

function createHarness(
    baseDirectory: string,
    label: string,
): {
    manager: HoshidictsManager;
    reloadNative: ReturnType<typeof vi.fn<() => Promise<number>>>;
} {
    let sequence = 0;
    const reloadNative = vi.fn(async () => 1);
    const inspectArchive = async (archivePath: string): Promise<ArchiveInspection> => {
        const archive = readArchive(archivePath);
        return {
            sourceLanguage: archive.sourceLanguage ?? 'ja',
            hasSupportedBank:
                (archive.terms ?? 1) + (archive.frequencies ?? 0) > 0,
            hasJapaneseEntry: true,
        };
    };
    const runImport = async (
        archivePath: string,
        outputDirectory: string,
    ): Promise<HoshidictsImportReport> => {
        const archive = readArchive(archivePath);
        writeImportedDictionary(outputDirectory, archive);
        return {
            success: true,
            title: archive.title,
            termCount: archive.terms ?? 1,
            mediaCount: 0,
            error: '',
        };
    };
    const writeCustomArchive: HoshidictsManagerDependencies['writeCustomArchive'] = async (
        outputPath,
        title,
        revision,
        entries,
    ) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(
            outputPath,
            JSON.stringify({
                title,
                revision,
                sourceLanguage: 'ja',
                terms: entries.length,
            }),
            'utf8',
        );
    };
    return {
        manager: new HoshidictsManager(baseDirectory, {
            now: () => new Date('2026-08-08T12:00:00.000Z'),
            randomId: () => `${label}-${sequence++}`,
            inspectArchive,
            runImport,
            reloadNative,
            writeCustomArchive,
        }),
        reloadNative,
    };
}

function hoshidictsRoot(baseDirectory: string): string {
    return path.join(baseDirectory, 'dictionaries', 'hoshidicts');
}

function statePath(baseDirectory: string, fileName: string): string {
    return path.join(hoshidictsRoot(baseDirectory), fileName);
}

async function readManifest(baseDirectory: string): Promise<any> {
    return JSON.parse(await fsp.readFile(statePath(baseDirectory, 'manifest.json'), 'utf8'));
}

async function readStateFiles(baseDirectory: string): Promise<Record<string, Buffer | null>> {
    const result: Record<string, Buffer | null> = {};
    for (const fileName of [
        'manifest.json',
        'mining-profile.json',
        'audio-profile.json',
        'custom-dictionary.txt',
    ]) {
        try {
            result[fileName] = await fsp.readFile(statePath(baseDirectory, fileName));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            result[fileName] = null;
        }
    }
    return result;
}

async function listGenerationRoots(baseDirectory: string): Promise<string[]> {
    const generationsDirectory = path.join(hoshidictsRoot(baseDirectory), 'generations');
    let dictionaryIds: string[];
    try {
        dictionaryIds = await fsp.readdir(generationsDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    const roots: string[] = [];
    for (const dictionaryId of dictionaryIds) {
        const dictionaryDirectory = path.join(generationsDirectory, dictionaryId);
        for (const generation of await fsp.readdir(dictionaryDirectory)) {
            roots.push(path.join(dictionaryDirectory, generation));
        }
    }
    return roots.sort();
}

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        tempDirectories
            .splice(0)
            .map(async (directory) => await fsp.rm(directory, { recursive: true, force: true })),
    );
});

describe('Hoshidicts manager full backups', () => {
    it('round-trips dictionaries and all manager settings, then removes replaced generations', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-manager-backup-');
        const sourceBase = path.join(workspace, 'source');
        const targetBase = path.join(workspace, 'target');
        const archivesDirectory = path.join(workspace, 'archives');
        const { manager: source } = createHarness(sourceBase, 'source');
        await source.importDictionaries([
            writeArchive(archivesDirectory, 'alpha.zip', {
                title: 'Alpha',
                revision: 'one',
            }),
            writeArchive(archivesDirectory, 'beta.zip', {
                title: 'Beta',
                revision: 'two',
                isUpdatable: true,
                indexUrl: 'https://dict.example/beta-index.json',
                downloadUrl: 'https://dict.example/beta.zip',
                frequencies: 3,
                frequencyMode: 'rank-based',
            }),
        ]);
        let sourceSnapshot = await source.getSnapshot();
        const alpha = sourceSnapshot.dictionaries.find(
            (dictionary) => dictionary.title === 'Alpha',
        );
        const beta = sourceSnapshot.dictionaries.find((dictionary) => dictionary.title === 'Beta');
        expect(alpha).toBeDefined();
        expect(beta).toBeDefined();
        await source.setDictionaryEnabled(alpha!.id, false);
        await source.setDictionaryPresentation(beta!.id, true);
        await source.renameDictionary(beta!.id, 'Main definitions');
        await source.moveDictionaryToPosition(beta!.id, 1);
        let tabGroupSnapshot = await source.createTabGroup('Grammar', alpha!.id);
        const grammarGroup = tabGroupSnapshot.tabGroups.find(({ name }) => name === 'Grammar');
        expect(grammarGroup).toBeDefined();
        await source.setTabGroupMembership(grammarGroup!.id, beta!.id, true);
        tabGroupSnapshot = await source.createTabGroup('Empty');
        const emptyGroup = tabGroupSnapshot.tabGroups.find(({ name }) => name === 'Empty');
        expect(emptyGroup).toBeDefined();
        await source.moveTabGroup(emptyGroup!.id, -1);
        const readerPreferences = makeHoshidictsReaderPreferences({
            lookupMode: 'hover',
            popupHideDelayMs: 850,
            activationKey: 'F8',
            sourceHighlightEnabled: true,
            popupNestingMaxDepth: 12,
            definitionBlur: {
                enabled: true,
                lookupThreshold: 8,
                revealMode: 'hover',
                revealDelayMs: 7000,
            },
            showLookupCounts: false,
            popupWidthPx: 720,
            popupHeightPx: 520,
            theme: 'girlypop',
            popupOpacityPercent: 70,
            onlyScanJapaneseText: true,
            popupToolbarPosition: 'top',
            scanLength: 24,
            maxResults: 48,
            sortFrequencyDictionary: 'Beta',
            sortFrequencyDictionaryOrder: 'ascending',
            popupColumns: 3,
            showCompactDefinitionSummary: true,
            compactDefinitionSummaryDictionary: 'Jitendex.org',
            showPitchAccentFurigana: false,
            pitchAccentFuriganaDictionary: 'Kanjium Pitch Accents',
            showPitchAccentBadge: true,
            hidePopupGrammarTags: false,
        });
        await source.setReaderPreferences(readerPreferences);
        await source.setSchedule('weekly');
        await source.setDictionarySchedule(beta!.id, 'hourly');
        const miningProfile = {
            ...defaultHoshidictsMiningProfile(),
            deck: 'Japanese::Mining',
            model: 'Japanese',
            tags: ['hoshidicts', 'backup'],
            duplicateScope: 'deck-root' as const,
            duplicateScopeCheckAllModels: true,
            duplicateBehavior: 'overwrite' as const,
            fieldTemplates: {
                Expression: {
                    value: '{expression}',
                    overwriteMode: 'coalesce' as const,
                },
                Meaning: {
                    value: '{definition}',
                    overwriteMode: 'append' as const,
                },
                Notes: {
                    value: 'x',
                    overwriteMode: 'skip' as const,
                },
                Unused: {
                    value: '',
                    overwriteMode: 'coalesce-new' as const,
                },
            },
        };
        await source.setMiningProfile(miningProfile);
        const audioProfile = {
            ...defaultHoshidictsAudioProfile(),
            autoPlay: true,
            volume: 37,
            sources: [
                {
                    id: 'local-audio',
                    type: 'custom-json' as const,
                    url: 'http://127.0.0.1:5050/?term={term}&reading={reading}',
                    voice: '',
                },
            ],
        };
        await source.setAudioProfile(audioProfile);
        const persona = await source.createProfile('Persona');
        await source.setAudioProfile({
            ...audioProfile,
            volume: 22,
        });
        await source.setDictionaryEnabled(alpha!.id, true);
        await source.switchProfile('default');
        const custom = await source.getCustomDictionaryDocument();
        await source.saveCustomDictionary('# Personal terms\n猫, ねこ, cat\n', custom.revision);
        sourceSnapshot = await source.getSnapshot();
        const sourceManifest = await readManifest(sourceBase);
        const backupPath = path.join(workspace, 'complete-backup.zip');
        await source.exportBackup(backupPath);

        const { manager: target, reloadNative } = createHarness(targetBase, 'target');
        await target.importDictionary(
            writeArchive(archivesDirectory, 'old.zip', {
                title: 'Old Dictionary',
                revision: 'old',
            }),
        );
        const oldManifest = await readManifest(targetBase);
        const oldPath = oldManifest.dictionaries[0].path as string;
        const oldGenerationRoot = path.join(
            hoshidictsRoot(targetBase),
            ...oldPath.split('/').slice(0, 3),
        );
        reloadNative.mockClear();

        const restored = await target.restoreBackup(backupPath);

        expect(reloadNative).toHaveBeenCalledOnce();
        expect(
            restored.dictionaries.map(({ title, displayName, enabled, favorite }) => ({
                title,
                displayName,
                enabled,
                favorite,
            })),
        ).toEqual([
            {
                title: 'Beta',
                displayName: 'Main definitions',
                enabled: true,
                favorite: true,
            },
            {
                title: 'Alpha',
                displayName: null,
                enabled: false,
                favorite: false,
            },
        ]);
        expect(restored).toMatchObject({
            activeProfileId: 'default',
            profiles: [
                { id: 'default', name: 'Default' },
                { id: persona.activeProfileId, name: 'Persona' },
            ],
            tabGroups: [
                { id: emptyGroup!.id, name: 'Empty', dictionaryIds: [] },
                {
                    id: grammarGroup!.id,
                    name: 'Grammar',
                    dictionaryIds: [alpha!.id, beta!.id],
                },
            ],
            customDictionaryActive: true,
            miningProfile,
            audioProfile,
            // Every reader preference round-trips, not just a sampled subset.
            ...readerPreferences,
            schedule: 'weekly',
        });
        await expect(target.getCustomDictionaryDocument()).resolves.toMatchObject({
            text: '# Personal terms\n猫, ねこ, cat\n',
        });
        const restoredManifest = await readManifest(targetBase);
        expect(restoredManifest.profiles).toEqual(sourceManifest.profiles);
        expect(
            restoredManifest.dictionaries.map((dictionary: { id: string }) => dictionary.id),
        ).toEqual(sourceManifest.dictionaries.map((dictionary: { id: string }) => dictionary.id));
        expect(
            restoredManifest.dictionaries.find(
                (dictionary: { id: string }) => dictionary.id === beta!.id,
            )?.displayName,
        ).toBe('Main definitions');
        expect(
            restoredManifest.dictionaries.find(
                (dictionary: { id: string }) => dictionary.id === beta!.id,
            ),
        ).toMatchObject({
            updateScheduleOverride: 'hourly',
            lastUpdateCheck: null,
        });
        for (const [index, dictionary] of restoredManifest.dictionaries.entries()) {
            expect(dictionary.path).not.toBe(sourceManifest.dictionaries[index].path);
            expect(dictionary.path).toMatch(/^generations\/[A-Za-z0-9._-]+\/restore-/u);
            await expect(
                fsp.stat(path.join(hoshidictsRoot(targetBase), ...dictionary.path.split('/'))),
            ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
        }
        await expect(fsp.stat(oldGenerationRoot)).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect(sourceSnapshot.dictionaries.map(({ id }) => id)).toEqual(
            restored.dictionaries.map(({ id }) => id),
        );
    });

    it('rejects export when persisted tab groups fail manager schema validation', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-manager-backup-invalid-export-');
        const sourceBase = path.join(workspace, 'source');
        const archivesDirectory = path.join(workspace, 'archives');
        const { manager: source } = createHarness(sourceBase, 'source');
        await source.importDictionary(
            writeArchive(archivesDirectory, 'source.zip', {
                title: 'Source Dictionary',
                revision: 'new',
            }),
        );
        const manifest = await readManifest(sourceBase);
        manifest.profiles[0].tabGroups = 'invalid';
        await fsp.writeFile(
            statePath(sourceBase, 'manifest.json'),
            JSON.stringify(manifest),
        );
        const backupPath = path.join(workspace, 'invalid.zip');

        await expect(source.exportBackup(backupPath)).rejects.toThrow(/tab groups.*invalid/iu);
        await expect(fsp.stat(backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rolls back restore when archived tab groups fail manager schema validation', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-manager-backup-invalid-restore-');
        const archivesDirectory = path.join(workspace, 'archives');
        const sourceBase = path.join(workspace, 'source');
        const { manager: source } = createHarness(sourceBase, 'source');
        await source.importDictionary(
            writeArchive(archivesDirectory, 'source.zip', {
                title: 'Source Dictionary',
                revision: 'new',
            }),
        );
        const manifest = await readManifest(sourceBase);
        manifest.profiles[0].tabGroups = 'invalid';
        await fsp.writeFile(
            statePath(sourceBase, 'manifest.json'),
            JSON.stringify(manifest),
        );
        const backupPath = path.join(workspace, 'invalid.zip');
        await exportHoshidictsBackup({
            rootDir: hoshidictsRoot(sourceBase),
            outputPath: backupPath,
        });

        const targetBase = path.join(workspace, 'target');
        const { manager: target, reloadNative } = createHarness(targetBase, 'target');
        await target.importDictionary(
            writeArchive(archivesDirectory, 'target.zip', {
                title: 'Target Dictionary',
                revision: 'live',
            }),
        );
        const targetSnapshot = await target.getSnapshot();
        await target.createTabGroup('Live group', targetSnapshot.dictionaries[0].id);
        const previousState = await readStateFiles(targetBase);
        const previousGenerations = await listGenerationRoots(targetBase);
        reloadNative.mockClear();

        await expect(target.restoreBackup(backupPath)).rejects.toMatchObject({
            rollbackRestored: true,
        });

        expect(reloadNative).toHaveBeenCalledOnce();
        expect(await readStateFiles(targetBase)).toEqual(previousState);
        expect(await listGenerationRoots(targetBase)).toEqual(previousGenerations);
        expect(await target.getSnapshot()).toMatchObject({
            dictionaries: [{ title: 'Target Dictionary' }],
            tabGroups: [
                {
                    name: 'Live group',
                    dictionaryIds: [targetSnapshot.dictionaries[0].id],
                },
            ],
        });
    });

    it('rolls back every state file and fresh generation when native activation fails', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-manager-backup-rollback-');
        const archivesDirectory = path.join(workspace, 'archives');
        const sourceBase = path.join(workspace, 'source');
        const { manager: source } = createHarness(sourceBase, 'source');
        await source.importDictionary(
            writeArchive(archivesDirectory, 'source.zip', {
                title: 'Source Dictionary',
                revision: 'new',
            }),
        );
        await source.setMiningProfile({
            ...defaultHoshidictsMiningProfile(),
            deck: 'Source Deck',
        });
        const backupPath = path.join(workspace, 'backup.zip');
        await source.exportBackup(backupPath);

        const targetBase = path.join(workspace, 'target');
        const { manager: target, reloadNative } = createHarness(targetBase, 'target');
        await target.importDictionary(
            writeArchive(archivesDirectory, 'target.zip', {
                title: 'Target Dictionary',
                revision: 'live',
            }),
        );
        await target.setMiningProfile({
            ...defaultHoshidictsMiningProfile(),
            deck: 'Live Deck',
        });
        await target.setAudioProfile({
            ...defaultHoshidictsAudioProfile(),
            volume: 64,
        });
        const custom = await target.getCustomDictionaryDocument();
        await target.saveCustomDictionary('犬, いぬ, dog\n', custom.revision);
        const targetSnapshot = await target.getSnapshot();
        await target.createTabGroup('Live group', targetSnapshot.dictionaries[0].id);
        const previousState = await readStateFiles(targetBase);
        const previousGenerations = await listGenerationRoots(targetBase);
        reloadNative.mockClear();
        reloadNative
            .mockRejectedValueOnce(new Error('native reload failed'))
            .mockResolvedValueOnce(1);

        await expect(target.restoreBackup(backupPath)).rejects.toMatchObject({
            rollbackRestored: true,
        });

        expect(reloadNative).toHaveBeenCalledTimes(2);
        expect(await readStateFiles(targetBase)).toEqual(previousState);
        expect(await listGenerationRoots(targetBase)).toEqual(previousGenerations);
        const restoredSnapshot = await target.getSnapshot();
        expect(restoredSnapshot.dictionaries).toHaveLength(1);
        expect(restoredSnapshot.dictionaries[0].title).toBe('Target Dictionary');
        expect(restoredSnapshot.miningProfile.deck).toBe('Live Deck');
        expect(restoredSnapshot.audioProfile.volume).toBe(64);
        await expect(target.getCustomDictionaryDocument()).resolves.toMatchObject({
            text: '犬, いぬ, dog\n',
        });
    });

    it('restores over a malformed live manifest and conservatively retains unknown generations', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-manager-backup-recovery-');
        const archivesDirectory = path.join(workspace, 'archives');
        const sourceBase = path.join(workspace, 'source');
        const { manager: source } = createHarness(sourceBase, 'source');
        await source.importDictionary(
            writeArchive(archivesDirectory, 'source.zip', {
                title: 'Recovery Dictionary',
                revision: 'new',
            }),
        );
        const backupPath = path.join(workspace, 'backup.zip');
        await source.exportBackup(backupPath);

        const targetBase = path.join(workspace, 'target');
        const targetRoot = hoshidictsRoot(targetBase);
        const unknownGeneration = path.join(
            targetRoot,
            'generations',
            'unknown-dictionary',
            'unknown-generation',
        );
        await fsp.mkdir(unknownGeneration, { recursive: true });
        await fsp.writeFile(path.join(unknownGeneration, 'recovery.txt'), 'retain me');
        await fsp.writeFile(path.join(targetRoot, 'manifest.json'), '{"version":1,"dictionaries":');
        const { manager: target, reloadNative } = createHarness(targetBase, 'target');

        const restored = await target.restoreBackup(backupPath);

        expect(reloadNative).toHaveBeenCalledOnce();
        expect(restored.dictionaries.map(({ title }) => title)).toEqual(['Recovery Dictionary']);
        await expect(
            fsp.readFile(path.join(unknownGeneration, 'recovery.txt'), 'utf8'),
        ).resolves.toBe('retain me');
    });

    it('restores malformed raw state exactly when recovery activation fails', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-manager-backup-recovery-rollback-');
        const archivesDirectory = path.join(workspace, 'archives');
        const sourceBase = path.join(workspace, 'source');
        const { manager: source } = createHarness(sourceBase, 'source');
        await source.importDictionary(
            writeArchive(archivesDirectory, 'source.zip', {
                title: 'Recovery Dictionary',
                revision: 'new',
            }),
        );
        const backupPath = path.join(workspace, 'backup.zip');
        await source.exportBackup(backupPath);

        const targetBase = path.join(workspace, 'target');
        const targetRoot = hoshidictsRoot(targetBase);
        const unknownGeneration = path.join(
            targetRoot,
            'generations',
            'unknown-dictionary',
            'unknown-generation',
        );
        await fsp.mkdir(unknownGeneration, { recursive: true });
        await fsp.writeFile(path.join(unknownGeneration, 'recovery.txt'), 'retain me');
        const malformedManifest = Buffer.from('{"version":1,"dictionaries":');
        await fsp.writeFile(path.join(targetRoot, 'manifest.json'), malformedManifest);
        await fsp.writeFile(path.join(targetRoot, 'mining-profile.json'), '{broken mining');
        await fsp.writeFile(path.join(targetRoot, 'audio-profile.json'), '{broken audio');
        await fsp.writeFile(path.join(targetRoot, 'custom-dictionary.txt'), 'raw custom bytes\n');
        const previousState = await readStateFiles(targetBase);
        const { manager: target, reloadNative } = createHarness(targetBase, 'target');
        reloadNative.mockRejectedValueOnce(new Error('native reload failed'));

        await expect(target.restoreBackup(backupPath)).rejects.toMatchObject({
            rollbackRestored: true,
        });

        expect(reloadNative).toHaveBeenCalledOnce();
        expect(await readStateFiles(targetBase)).toEqual(previousState);
        await expect(
            fsp.readFile(path.join(unknownGeneration, 'recovery.txt'), 'utf8'),
        ).resolves.toBe('retain me');
        expect(
            (await listGenerationRoots(targetBase)).filter(
                (root) => root !== unknownGeneration,
            ),
        ).toEqual([]);
    });

    it('rejects malformed archives without mutating persisted state', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-manager-backup-malformed-');
        const baseDirectory = path.join(workspace, 'live');
        const archivesDirectory = path.join(workspace, 'archives');
        const { manager, reloadNative } = createHarness(baseDirectory, 'live');
        await manager.importDictionary(
            writeArchive(archivesDirectory, 'live.zip', {
                title: 'Live Dictionary',
                revision: 'one',
            }),
        );
        await manager.exportBackup(path.join(workspace, 'known-good.zip'));
        const previousState = await readStateFiles(baseDirectory);
        const previousGenerations = await listGenerationRoots(baseDirectory);
        const malformedPath = path.join(workspace, 'malformed.zip');
        await fsp.writeFile(malformedPath, 'this is not a zip archive');
        reloadNative.mockClear();

        await expect(manager.restoreBackup(malformedPath)).rejects.toThrow();

        expect(reloadNative).not.toHaveBeenCalled();
        expect(await readStateFiles(baseDirectory)).toEqual(previousState);
        expect(await listGenerationRoots(baseDirectory)).toEqual(previousGenerations);
    });

    it('exports and restores normalized defaults before any dictionary is installed', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-manager-backup-empty-');
        const sourceBase = path.join(workspace, 'source');
        const { manager: source } = createHarness(sourceBase, 'source');
        const backupPath = path.join(workspace, 'empty.zip');

        await source.exportBackup(backupPath);

        await expect(fsp.stat(backupPath)).resolves.toMatchObject({
            isFile: expect.any(Function),
        });
        const persisted = await readManifest(sourceBase);
        expect(persisted).toMatchObject({
            version: 1,
            activeProfileId: 'default',
            dictionaries: [],
        });
        expect(persisted.profiles).toHaveLength(1);
        // The active profile is the only owner of reader settings; the manifest
        // root no longer mirrors them.
        expect(persisted.profiles[0]).toMatchObject({
            id: 'default',
            name: 'Default',
            reader: makeHoshidictsReaderPreferences(),
            mining: defaultHoshidictsMiningProfile(),
            audio: defaultHoshidictsAudioProfile(),
            tabGroups: [],
            enabledDictionaryIds: [],
        });
        expect(Object.keys(persisted)).not.toContain('lookupMode');
        // The backend mirrors of the active profile are written alongside it.
        await expect(
            fsp.stat(statePath(sourceBase, 'mining-profile.json')),
        ).resolves.toMatchObject({ isFile: expect.any(Function) });
        await expect(
            fsp.stat(statePath(sourceBase, 'audio-profile.json')),
        ).resolves.toMatchObject({ isFile: expect.any(Function) });

        const targetBase = path.join(workspace, 'target');
        const { manager: target, reloadNative } = createHarness(targetBase, 'target');
        const restored = await target.restoreBackup(backupPath);

        expect(reloadNative).toHaveBeenCalledOnce();
        expect(restored.dictionaries).toEqual([]);
        expect(restored.miningProfile).toEqual(defaultHoshidictsMiningProfile());
        expect(restored.audioProfile).toEqual(defaultHoshidictsAudioProfile());
        expect(restored).toMatchObject({
            customDictionaryActive: false,
            ...makeHoshidictsReaderPreferences(),
        });
    });
});
