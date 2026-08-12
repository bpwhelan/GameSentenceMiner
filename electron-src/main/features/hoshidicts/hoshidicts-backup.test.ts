import archiver from 'archiver';
import extract from 'extract-zip';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    commitPreparedHoshidictsBackupRestore,
    disposePreparedHoshidictsBackupRestore,
    exportHoshidictsBackup,
    HOSHIDICTS_BACKUP_MANIFEST_FILE_NAME,
    prepareHoshidictsBackupRestore,
    type PreparedHoshidictsBackupRestore,
} from './hoshidicts-backup.js';

const tempDirectories: string[] = [];

function makeTempDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        tempDirectories
            .splice(0)
            .map(async (directory) => await fsp.rm(directory, { recursive: true, force: true })),
    );
});

interface TestRootOptions {
    generation?: string;
    id?: string;
    title?: string;
    includeOptionalState?: boolean;
    media?: boolean;
}

async function writeTestRoot(
    rootDir: string,
    options: TestRootOptions = {},
): Promise<{ dictionaryPath: string; manifest: Record<string, unknown> }> {
    const id = options.id ?? 'jitendex';
    const generation = options.generation ?? 'original-generation';
    const title = options.title ?? 'Jitendex.org [test]';
    const dictionaryPath = path.posix.join('generations', id, generation, title);
    const dictionaryRoot = path.join(rootDir, ...dictionaryPath.split('/'));
    await fsp.mkdir(path.join(dictionaryRoot, 'nested'), { recursive: true });
    await Promise.all([
        fsp.writeFile(path.join(dictionaryRoot, '.hoshidicts_3'), '3'),
        fsp.writeFile(path.join(dictionaryRoot, 'hash.table'), 'hash-table'),
        fsp.writeFile(path.join(dictionaryRoot, 'bloom.filter'), 'bloom-filter'),
        fsp.writeFile(path.join(dictionaryRoot, 'blobs.bin'), 'dictionary-blobs'),
        fsp.writeFile(path.join(dictionaryRoot, 'nested', 'extra.bin'), 'extra-data'),
        fsp.writeFile(
            path.join(dictionaryRoot, 'index.json'),
            JSON.stringify({
                title,
                revision: 'test-revision',
                sourceLanguage: 'ja',
                isUpdatable: true,
                indexUrl: 'https://dict.example/index.json',
                downloadUrl: 'https://dict.example/dictionary.zip',
                counts: {
                    terms: { total: 1 },
                    termMeta: {},
                    kanji: { total: 0 },
                    media: { total: options.media === false ? 0 : 1 },
                },
            }),
        ),
    ]);
    if (options.media !== false) {
        await Promise.all([
            fsp.writeFile(path.join(dictionaryRoot, 'media.idx'), 'media-index'),
            fsp.writeFile(path.join(dictionaryRoot, 'media.bin'), 'media-data'),
        ]);
    }

    const manifest = {
        version: 1,
        lookupMode: 'hover',
        activationKey: 'Alt',
        sourceHighlightEnabled: true,
        popupHideDelayMs: 250,
        showLookupCounts: true,
        showCompactDefinitionSummary: true,
        compactDefinitionSummaryDictionary: 'Jitendex.org',
        hidePopupGrammarTags: false,
        popupNestingMaxDepth: 3,
        definitionBlur: {
            enabled: true,
            lookupThreshold: 2,
            revealMode: 'delay',
            revealDelayMs: 1500,
        },
        schedule: 'weekly',
        lastCheck: '2026-08-08T00:00:00.000Z',
        nextCheck: '2026-08-15T00:00:00.000Z',
        lastError: null,
        dictionaries: [
            {
                id,
                path: dictionaryPath,
                enabled: true,
                favorite: true,
                recommendedId: id === 'jitendex' ? 'jitendex' : null,
                title,
                revision: 'test-revision',
                isUpdatable: true,
                indexUrl: 'https://dict.example/index.json',
                downloadUrl: 'https://dict.example/dictionary.zip',
                language: 'ja',
                termCount: 1,
                frequencyCount: 0,
                pitchCount: 0,
                kanjiCount: 0,
                frequencyMode: null,
                installedAt: '2026-08-08T00:00:00.000Z',
                updateScheduleOverride: 'hourly',
                lastUpdateCheck: '2026-08-08T11:00:00.000Z',
            },
        ],
    };
    await fsp.mkdir(rootDir, { recursive: true });
    await fsp.writeFile(path.join(rootDir, 'manifest.json'), JSON.stringify(manifest));
    if (options.includeOptionalState !== false) {
        await Promise.all([
            fsp.writeFile(
                path.join(rootDir, 'mining-profile.json'),
                JSON.stringify({ version: 1, deck: 'Mining' }),
            ),
            fsp.writeFile(
                path.join(rootDir, 'audio-profile.json'),
                JSON.stringify({ version: 1, sources: [{ type: 'jpod101' }] }),
            ),
            fsp.writeFile(path.join(rootDir, 'custom-dictionary.txt'), '# custom\n猫, ねこ, cat\n'),
        ]);
    }
    return { dictionaryPath, manifest };
}

async function createZipFromDirectory(sourceDir: string, outputPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outputPath, { flags: 'wx' });
        const archive = archiver('zip', { zlib: { level: 1 } });
        output.once('close', resolve);
        output.once('error', reject);
        archive.once('error', reject);
        archive.pipe(output);
        archive.directory(sourceDir, false);
        void archive.finalize().catch(reject);
    });
}

async function prepareRoundTrip(
    workspace: string,
    sourceRoot: string,
): Promise<PreparedHoshidictsBackupRestore> {
    const archivePath = path.join(workspace, 'hoshidicts-backup.zip');
    await exportHoshidictsBackup({
        rootDir: sourceRoot,
        outputPath: archivePath,
        now: () => new Date('2026-08-08T12:00:00.000Z'),
    });
    return await prepareHoshidictsBackupRestore({
        archivePath,
        stagingParent: workspace,
    });
}

describe('Hoshidicts full backups', () => {
    it('atomically replaces an existing backup destination', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-replace-');
        const sourceRoot = path.join(workspace, 'source');
        await writeTestRoot(sourceRoot);
        const archivePath = path.join(workspace, 'existing-backup.zip');
        await fsp.writeFile(archivePath, 'previous backup bytes');

        await exportHoshidictsBackup({ rootDir: sourceRoot, outputPath: archivePath });

        await expect(fsp.readFile(archivePath, 'utf8')).resolves.not.toBe(
            'previous backup bytes',
        );
        const prepared = await prepareHoshidictsBackupRestore({
            archivePath,
            stagingParent: workspace,
        });
        await disposePreparedHoshidictsBackupRestore(prepared);
        expect(await fsp.readdir(workspace)).not.toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^\.existing-backup\.zip\.hoshidicts-backup-.*\.tmp$/u),
            ]),
        );
    });

    it('cleans its temporary archive when atomic replacement fails', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-replace-failure-');
        const sourceRoot = path.join(workspace, 'source');
        await writeTestRoot(sourceRoot);
        const archivePath = path.join(workspace, 'existing-backup.zip');
        await fsp.mkdir(archivePath);
        await fsp.writeFile(
            path.join(archivePath, 'previous-backup'),
            'known-good previous backup',
        );

        await expect(
            exportHoshidictsBackup({ rootDir: sourceRoot, outputPath: archivePath }),
        ).rejects.toThrow();

        await expect(
            fsp.readFile(path.join(archivePath, 'previous-backup'), 'utf8'),
        ).resolves.toBe('known-good previous backup');
        expect(await fsp.readdir(workspace)).not.toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^\.existing-backup\.zip\.hoshidicts-backup-.*\.tmp$/u),
            ]),
        );
    });

    it('round-trips manager state, settings, custom source, and dictionary files into fresh generations', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-roundtrip-');
        const sourceRoot = path.join(workspace, 'source');
        const targetRoot = path.join(workspace, 'target');
        const { dictionaryPath } = await writeTestRoot(sourceRoot);
        await writeTestRoot(targetRoot, {
            generation: 'target-old-generation',
            includeOptionalState: false,
        });

        const archivePath = path.join(workspace, 'backup.zip');
        const exported = await exportHoshidictsBackup({
            rootDir: sourceRoot,
            outputPath: archivePath,
            now: () => new Date('2026-08-08T12:00:00.000Z'),
        });
        expect(exported.manifest.version).toBe(1);
        expect(exported.manifest.createdAt).toBe('2026-08-08T12:00:00.000Z');
        expect(exported.manifest.dictionaries).toEqual([{ id: 'jitendex', path: dictionaryPath }]);
        expect(
            exported.manifest.files.find((file) => file.path.endsWith('/blobs.bin'))?.sha256,
        ).toMatch(/^[a-f0-9]{64}$/u);

        const prepared = await prepareHoshidictsBackupRestore({
            archivePath,
            stagingParent: workspace,
        });
        const activate = vi.fn(async () => undefined);
        try {
            const committed = await commitPreparedHoshidictsBackupRestore(prepared, {
                targetRootDir: targetRoot,
                freshGenerationId: () => 'restored-generation',
                activate,
            });

            expect(activate).toHaveBeenCalledTimes(1);
            expect(committed.installedGenerationRoots).toEqual([
                path.join(targetRoot, 'generations', 'jitendex', 'restored-generation'),
            ]);
            const restoredManifest = JSON.parse(
                await fsp.readFile(path.join(targetRoot, 'manifest.json'), 'utf8'),
            ) as {
                showCompactDefinitionSummary: boolean;
                compactDefinitionSummaryDictionary: string | null;
                hidePopupGrammarTags: boolean;
                dictionaries: Array<{
                    path: string;
                    updateScheduleOverride: string | null;
                    lastUpdateCheck: string | null;
                }>;
            };
            expect(restoredManifest.showCompactDefinitionSummary).toBe(true);
            expect(restoredManifest.compactDefinitionSummaryDictionary).toBe(
                'Jitendex.org'
            );
            expect(restoredManifest.hidePopupGrammarTags).toBe(false);
            expect(restoredManifest.dictionaries[0]?.path).toBe(
                'generations/jitendex/restored-generation/Jitendex.org [test]',
            );
            expect(restoredManifest.dictionaries[0]).toMatchObject({
                updateScheduleOverride: 'hourly',
                lastUpdateCheck: '2026-08-08T11:00:00.000Z',
            });
            await expect(
                fsp.readFile(
                    path.join(
                        targetRoot,
                        ...restoredManifest.dictionaries[0].path.split('/'),
                        'nested',
                        'extra.bin',
                    ),
                    'utf8',
                ),
            ).resolves.toBe('extra-data');
            await expect(
                fsp.readFile(path.join(targetRoot, 'mining-profile.json'), 'utf8'),
            ).resolves.toContain('Mining');
            await expect(
                fsp.readFile(path.join(targetRoot, 'audio-profile.json'), 'utf8'),
            ).resolves.toContain('jpod101');
            await expect(
                fsp.readFile(path.join(targetRoot, 'custom-dictionary.txt'), 'utf8'),
            ).resolves.toContain('猫, ねこ, cat');
            await expect(
                fsp.stat(path.join(targetRoot, 'generations', 'jitendex', 'target-old-generation')),
            ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
        } finally {
            await disposePreparedHoshidictsBackupRestore(prepared);
        }
    });

    it('streams a large dictionary file while keeping the JSON manifest metadata small', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-large-');
        const sourceRoot = path.join(workspace, 'source');
        const { dictionaryPath } = await writeTestRoot(sourceRoot, { media: false });
        const bloomPath = path.join(sourceRoot, ...dictionaryPath.split('/'), 'bloom.filter');
        const blobPath = path.join(sourceRoot, ...dictionaryPath.split('/'), 'blobs.bin');
        const bloomBytes = Buffer.alloc(2_097_168);
        let bloomState = 0x12345678;
        for (let offset = 0; offset < bloomBytes.length; offset += 4) {
            bloomState ^= bloomState << 13;
            bloomState ^= bloomState >>> 17;
            bloomState ^= bloomState << 5;
            bloomBytes.writeUInt32LE(bloomState >>> 0, offset);
        }
        await fsp.writeFile(bloomPath, bloomBytes);
        const handle = await fsp.open(blobPath, 'w');
        const chunk = Buffer.alloc(64 * 1024, 0x5a);
        try {
            for (let index = 0; index < 128; index += 1) {
                await handle.write(chunk);
            }
        } finally {
            await handle.close();
        }

        const archivePath = path.join(workspace, 'large.zip');
        const result = await exportHoshidictsBackup({
            rootDir: sourceRoot,
            outputPath: archivePath,
        });
        const blobMetadata = result.manifest.files.find(
            (file) => file.path === `${dictionaryPath}/blobs.bin`,
        );
        expect(blobMetadata?.size).toBe(8 * 1024 * 1024);
        expect(
            result.manifest.files.find(
                (file) => file.path === `${dictionaryPath}/bloom.filter`,
            )?.size,
        ).toBe(2_097_168);
        expect(JSON.stringify(result.manifest).length).toBeLessThan(20_000);

        const prepared = await prepareHoshidictsBackupRestore({
            archivePath,
            stagingParent: workspace,
        });
        try {
            await expect(
                fsp.stat(
                    path.join(prepared.payloadRoot, ...dictionaryPath.split('/'), 'blobs.bin'),
                ),
            ).resolves.toMatchObject({ size: 8 * 1024 * 1024 });
            await expect(
                fsp.stat(
                    path.join(prepared.payloadRoot, ...dictionaryPath.split('/'), 'bloom.filter'),
                ),
            ).resolves.toMatchObject({ size: 2_097_168 });
        } finally {
            await disposePreparedHoshidictsBackupRestore(prepared);
        }
    });

    it.each([
        [
            'tampered',
            async (payloadPath: string) => await fsp.writeFile(payloadPath, 'tampered-data!'),
        ],
        ['missing', async (payloadPath: string) => await fsp.rm(payloadPath)],
    ])('rejects a %s payload entry before restore', async (_label, mutate) => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-invalid-');
        const sourceRoot = path.join(workspace, 'source');
        const { dictionaryPath } = await writeTestRoot(sourceRoot);
        const validArchive = path.join(workspace, 'valid.zip');
        await exportHoshidictsBackup({ rootDir: sourceRoot, outputPath: validArchive });
        const extracted = path.join(workspace, 'extracted');
        await fsp.mkdir(extracted);
        await extract(validArchive, { dir: extracted });
        await mutate(path.join(extracted, 'data', ...dictionaryPath.split('/'), 'blobs.bin'));
        const invalidArchive = path.join(workspace, 'invalid.zip');
        await createZipFromDirectory(extracted, invalidArchive);

        await expect(
            prepareHoshidictsBackupRestore({
                archivePath: invalidArchive,
                stagingParent: workspace,
            }),
        ).rejects.toThrow(/hash|missing|size|entry/iu);
    });

    it('rejects dictionary references which disagree with the backed-up manager state', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-references-');
        const sourceRoot = path.join(workspace, 'source');
        await writeTestRoot(sourceRoot);
        const validArchive = path.join(workspace, 'valid.zip');
        await exportHoshidictsBackup({ rootDir: sourceRoot, outputPath: validArchive });
        const extracted = path.join(workspace, 'extracted');
        await fsp.mkdir(extracted);
        await extract(validArchive, { dir: extracted });
        const backupManifestPath = path.join(extracted, HOSHIDICTS_BACKUP_MANIFEST_FILE_NAME);
        const backupManifest = JSON.parse(await fsp.readFile(backupManifestPath, 'utf8')) as {
            dictionaries: Array<{ path: string }>;
        };
        backupManifest.dictionaries[0].path =
            'generations/jitendex/different-generation/Jitendex.org [test]';
        await fsp.writeFile(backupManifestPath, JSON.stringify(backupManifest));
        const inconsistentArchive = path.join(workspace, 'inconsistent.zip');
        await createZipFromDirectory(extracted, inconsistentArchive);

        await expect(
            prepareHoshidictsBackupRestore({
                archivePath: inconsistentArchive,
                stagingParent: workspace,
            }),
        ).rejects.toThrow(/references do not match manager state/iu);
    });

    it('rejects path traversal entries without writing outside staging', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-traversal-');
        const safeRoot = path.join(workspace, 'safe-zip');
        await fsp.mkdir(path.join(safeRoot, 'data', 'aa'), { recursive: true });
        await fsp.writeFile(path.join(safeRoot, 'data', 'aa', 'escape.txt'), 'escape');
        const archivePath = path.join(workspace, 'traversal.zip');
        await createZipFromDirectory(safeRoot, archivePath);
        const archive = await fsp.readFile(archivePath);
        const safeName = Buffer.from('data/aa/escape.txt');
        const traversalName = Buffer.from('data/../escape.txt');
        let replacements = 0;
        for (
            let offset = archive.indexOf(safeName);
            offset >= 0;
            offset = archive.indexOf(safeName, offset + traversalName.length)
        ) {
            traversalName.copy(archive, offset);
            replacements += 1;
        }
        expect(replacements).toBeGreaterThanOrEqual(2);
        await fsp.writeFile(archivePath, archive);

        await expect(
            prepareHoshidictsBackupRestore({
                archivePath,
                stagingParent: workspace,
            }),
        ).rejects.toThrow(/relative path|invalid|entry/iu);
        await expect(fsp.stat(path.join(workspace, 'escape.txt'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('removes optional target state when the backup explicitly records it as absent', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-absence-');
        const sourceRoot = path.join(workspace, 'source');
        const targetRoot = path.join(workspace, 'target');
        await writeTestRoot(sourceRoot, { includeOptionalState: false });
        await writeTestRoot(targetRoot, { generation: 'target-with-optional-state' });
        const prepared = await prepareRoundTrip(workspace, sourceRoot);
        try {
            expect(prepared.manifest.state).toMatchObject({
                miningProfile: null,
                audioProfile: null,
                customDictionary: null,
            });
            await commitPreparedHoshidictsBackupRestore(prepared, {
                targetRootDir: targetRoot,
                freshGenerationId: () => 'restore-without-optional-state',
            });
            for (const fileName of [
                'mining-profile.json',
                'audio-profile.json',
                'custom-dictionary.txt',
            ]) {
                await expect(fsp.stat(path.join(targetRoot, fileName))).rejects.toMatchObject({
                    code: 'ENOENT',
                });
            }
        } finally {
            await disposePreparedHoshidictsBackupRestore(prepared);
        }
    });

    it('restores old state and removes fresh generations when activation fails', async () => {
        const workspace = makeTempDirectory('gsm-hoshidicts-backup-rollback-');
        const sourceRoot = path.join(workspace, 'source');
        const targetRoot = path.join(workspace, 'target');
        await writeTestRoot(sourceRoot, { includeOptionalState: false });
        const target = await writeTestRoot(targetRoot, {
            generation: 'live-before-restore',
            title: 'Target Dictionary',
        });
        const originalManifest = await fsp.readFile(path.join(targetRoot, 'manifest.json'));
        const originalMining = await fsp.readFile(path.join(targetRoot, 'mining-profile.json'));
        const originalAudio = await fsp.readFile(path.join(targetRoot, 'audio-profile.json'));
        const originalCustom = await fsp.readFile(path.join(targetRoot, 'custom-dictionary.txt'));
        const prepared = await prepareRoundTrip(workspace, sourceRoot);
        const activate = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('native reload failed'))
            .mockResolvedValueOnce(undefined);
        try {
            await expect(
                commitPreparedHoshidictsBackupRestore(prepared, {
                    targetRootDir: targetRoot,
                    freshGenerationId: () => 'failed-restore',
                    activate,
                }),
            ).rejects.toMatchObject({ rollbackRestored: true });
            expect(activate).toHaveBeenCalledTimes(2);
            await expect(fsp.readFile(path.join(targetRoot, 'manifest.json'))).resolves.toEqual(
                originalManifest,
            );
            await expect(
                fsp.readFile(path.join(targetRoot, 'mining-profile.json')),
            ).resolves.toEqual(originalMining);
            await expect(
                fsp.readFile(path.join(targetRoot, 'audio-profile.json')),
            ).resolves.toEqual(originalAudio);
            await expect(
                fsp.readFile(path.join(targetRoot, 'custom-dictionary.txt')),
            ).resolves.toEqual(originalCustom);
            await expect(
                fsp.stat(path.join(targetRoot, 'generations', 'jitendex', 'failed-restore')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(
                fsp.stat(path.join(targetRoot, ...target.dictionaryPath.split('/'))),
            ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
        } finally {
            await disposePreparedHoshidictsBackupRestore(prepared);
        }
    });

});
