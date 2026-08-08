import archiver from 'archiver';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

export const HOSHIDICTS_BACKUP_MANIFEST_FILE_NAME = 'hoshidicts-backup.json';
export const HOSHIDICTS_BACKUP_VERSION = 1;

const HOSHIDICTS_BACKUP_FORMAT = 'gsm-hoshidicts-backup';
const PAYLOAD_DIRECTORY = 'data';
const MANAGER_MANIFEST_FILE_NAME = 'manifest.json';
const MINING_PROFILE_FILE_NAME = 'mining-profile.json';
const AUDIO_PROFILE_FILE_NAME = 'audio-profile.json';
const CUSTOM_DICTIONARY_FILE_NAME = 'custom-dictionary.txt';
const STATE_FILE_NAMES = [
    MANAGER_MANIFEST_FILE_NAME,
    MINING_PROFILE_FILE_NAME,
    AUDIO_PROFILE_FILE_NAME,
    CUSTOM_DICTIONARY_FILE_NAME,
] as const;
const REQUIRED_DICTIONARY_FILES = ['hash.table', 'bloom.filter', 'blobs.bin'] as const;
const REQUIRED_MEDIA_FILES = ['media.idx', 'media.bin'] as const;
const HOSHIDICTS_MARKERS = ['.hoshidicts_3', '.hoshidicts_2', '.hoshidicts_1'] as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_MANAGER_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_GENERATED_INDEX_BYTES = 1024 * 1024;
const MAX_BACKUP_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_BACKUP_FILE_COUNT = 100_000;
const MAX_BACKUP_ENTRY_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES = 256 * 1024 * 1024 * 1024;

export interface HoshidictsBackupFileMetadata {
    path: string;
    size: number;
    sha256: string;
}

export interface HoshidictsBackupDictionaryReference {
    id: string;
    path: string;
}

export interface HoshidictsBackupStateReferences {
    manifest: typeof MANAGER_MANIFEST_FILE_NAME;
    miningProfile: typeof MINING_PROFILE_FILE_NAME | null;
    audioProfile: typeof AUDIO_PROFILE_FILE_NAME | null;
    customDictionary: typeof CUSTOM_DICTIONARY_FILE_NAME | null;
}

export interface HoshidictsBackupManifest {
    format: typeof HOSHIDICTS_BACKUP_FORMAT;
    version: typeof HOSHIDICTS_BACKUP_VERSION;
    createdAt: string;
    state: HoshidictsBackupStateReferences;
    dictionaries: HoshidictsBackupDictionaryReference[];
    files: HoshidictsBackupFileMetadata[];
}

export interface ExportHoshidictsBackupOptions {
    rootDir: string;
    outputPath: string;
    now?: () => Date;
}

export interface ExportedHoshidictsBackup {
    outputPath: string;
    manifest: HoshidictsBackupManifest;
}

export interface PrepareHoshidictsBackupRestoreOptions {
    archivePath: string;
    stagingParent?: string;
}

export interface PreparedHoshidictsBackupRestore {
    archivePath: string;
    stagingRoot: string;
    payloadRoot: string;
    manifest: HoshidictsBackupManifest;
    managerManifest: Record<string, unknown>;
    dictionaries: HoshidictsBackupDictionaryReference[];
}

export interface CommitPreparedHoshidictsBackupRestoreOptions {
    targetRootDir: string;
    freshGenerationId?: (dictionary: HoshidictsBackupDictionaryReference, index: number) => string;
    activate?: () => Promise<void>;
}

export interface CommittedHoshidictsBackupRestore {
    managerManifest: Record<string, unknown>;
    installedGenerationRoots: string[];
    previousDictionaryPaths: string[];
}

export class HoshidictsBackupCommitError extends Error {
    constructor(
        message: string,
        readonly rollbackRestored: boolean,
    ) {
        super(message);
        this.name = 'HoshidictsBackupCommitError';
    }
}

interface ManagerManifestInspection {
    value: Record<string, unknown>;
    dictionaries: HoshidictsBackupDictionaryReference[];
}

interface SourceFile {
    path: string;
    absolutePath: string;
}

interface StateSnapshot {
    fileName: (typeof STATE_FILE_NAMES)[number];
    existed: boolean;
    backupPath: string;
}

interface InstalledGeneration {
    root: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeRelativePath(value: unknown, label: string): string {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 8192 ||
        value.includes('\\') ||
        /[\u0000-\u001f\u007f]/u.test(value) ||
        path.posix.isAbsolute(value) ||
        path.win32.isAbsolute(value) ||
        /^[A-Za-z]:/u.test(value)
    ) {
        throw new Error(`${label} is not a normalized relative path: ${String(value)}`);
    }
    const components = value.split('/');
    if (
        components.some(
            (component) => component.length === 0 || component === '.' || component === '..',
        ) ||
        path.posix.normalize(value) !== value
    ) {
        throw new Error(`${label} is not a normalized relative path: ${value}`);
    }
    return value;
}

function resolveInside(root: string, relativePath: string): string {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Backup path escaped its root: ${relativePath}`);
    }
    return resolved;
}

function normalizeDictionaryReference(
    idValue: unknown,
    pathValue: unknown,
    label: string,
): HoshidictsBackupDictionaryReference {
    if (typeof idValue !== 'string' || !SAFE_ID_PATTERN.test(idValue)) {
        throw new Error(`${label} has an invalid dictionary id.`);
    }
    const relativePath = normalizeRelativePath(pathValue, `${label} path`);
    const components = relativePath.split('/');
    if (
        components.length !== 4 ||
        components[0] !== 'generations' ||
        components[1] !== idValue ||
        !SAFE_ID_PATTERN.test(components[2])
    ) {
        throw new Error(`${label} does not reference an immutable dictionary generation.`);
    }
    return { id: idValue, path: relativePath };
}

function inspectManagerManifest(value: unknown): ManagerManifestInspection {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.dictionaries)) {
        throw new Error('Hoshidicts manager manifest is invalid or unsupported.');
    }
    if (value.dictionaries.length > 256) {
        throw new Error('Hoshidicts manager manifest contains too many dictionaries.');
    }
    const ids = new Set<string>();
    const paths = new Set<string>();
    const dictionaries = value.dictionaries.map((dictionary, index) => {
        if (!isRecord(dictionary)) {
            throw new Error('Hoshidicts manager manifest contains an invalid dictionary.');
        }
        const reference = normalizeDictionaryReference(
            dictionary.id,
            dictionary.path,
            `Hoshidicts manager dictionary ${index + 1}`,
        );
        const idKey = reference.id.toLowerCase();
        const pathKey = reference.path.toLowerCase();
        if (ids.has(idKey) || paths.has(pathKey)) {
            throw new Error(
                'Hoshidicts manager manifest contains duplicate dictionary references.',
            );
        }
        ids.add(idKey);
        paths.add(pathKey);
        return reference;
    });
    return { value, dictionaries };
}

async function readBoundedJsonFile(
    filePath: string,
    maximumBytes: number,
    label: string,
): Promise<unknown> {
    const stat = await fsp.stat(filePath).catch((error) => {
        throw new Error(`${label} could not be read: ${errorMessage(error)}`);
    });
    if (!stat.isFile() || stat.size === 0 || stat.size > maximumBytes) {
        throw new Error(`${label} is empty, oversized, or not a file.`);
    }
    return JSON.parse((await fsp.readFile(filePath, 'utf8')).replace(/^\uFEFF/u, '')) as unknown;
}

async function validateOptionalJsonState(
    payloadRoot: string,
    state: HoshidictsBackupStateReferences,
): Promise<void> {
    for (const [reference, label] of [
        [state.miningProfile, 'Hoshidicts mining profile'],
        [state.audioProfile, 'Hoshidicts audio profile'],
    ] as const) {
        if (reference !== null) {
            await readBoundedJsonFile(
                resolveInside(payloadRoot, reference),
                MAX_PROFILE_BYTES,
                label,
            );
        }
    }
}

async function fileMetadata(filePath: string): Promise<Omit<HoshidictsBackupFileMetadata, 'path'>> {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_BACKUP_ENTRY_BYTES) {
            throw new Error(`Backup file is too large: ${filePath}`);
        }
        hash.update(bytes);
    }
    return { size, sha256: hash.digest('hex') };
}

class HashingTransform extends Transform {
    private readonly hash = createHash('sha256');
    private byteLength = 0;

    constructor(private readonly maximumBytes: number) {
        super();
    }

    override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null, data?: Buffer) => void,
    ): void {
        this.byteLength += chunk.byteLength;
        if (this.byteLength > this.maximumBytes) {
            callback(new Error('Backup archive entry exceeded its size limit.'));
            return;
        }
        this.hash.update(chunk);
        callback(null, chunk);
    }

    metadata(): Omit<HoshidictsBackupFileMetadata, 'path'> {
        return { size: this.byteLength, sha256: this.hash.digest('hex') };
    }
}

async function streamToNewFile(
    readable: Readable,
    outputPath: string,
    maximumBytes: number,
): Promise<Omit<HoshidictsBackupFileMetadata, 'path'>> {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    const hashing = new HashingTransform(maximumBytes);
    try {
        await pipeline(
            readable,
            hashing,
            fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
        );
        return hashing.metadata();
    } catch (error) {
        await fsp.rm(outputPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function copyFileWithMetadata(
    sourcePath: string,
    outputPath: string,
): Promise<Omit<HoshidictsBackupFileMetadata, 'path'>> {
    return await streamToNewFile(
        fs.createReadStream(sourcePath),
        outputPath,
        MAX_BACKUP_ENTRY_BYTES,
    );
}

async function collectDirectoryFiles(
    rootDir: string,
    relativeRoot: string,
    output: SourceFile[],
): Promise<void> {
    const absoluteRoot = resolveInside(rootDir, relativeRoot);
    const rootStat = await fsp.lstat(absoluteRoot).catch((error) => {
        throw new Error(
            `Installed dictionary generation is missing: ${relativeRoot}: ${errorMessage(error)}`,
        );
    });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Installed dictionary path is not a regular directory: ${relativeRoot}`);
    }

    const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
        const entries = await fsp.readdir(absoluteDirectory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (entry.name.includes('\\') || /[\u0000-\u001f\u007f]/u.test(entry.name)) {
                throw new Error(
                    `Dictionary generation contains an invalid file name: ${entry.name}`,
                );
            }
            const relativePath = normalizeRelativePath(
                path.posix.join(relativeDirectory, entry.name),
                'Dictionary generation file',
            );
            const absolutePath = path.join(absoluteDirectory, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error(`Dictionary generation contains a symbolic link: ${relativePath}`);
            }
            if (entry.isDirectory()) {
                await visit(absolutePath, relativePath);
                continue;
            }
            if (!entry.isFile()) {
                throw new Error(`Dictionary generation contains a non-file entry: ${relativePath}`);
            }
            output.push({ path: relativePath, absolutePath });
        }
    };
    await visit(absoluteRoot, relativeRoot);
}

async function optionalSourceFile(rootDir: string, fileName: string): Promise<SourceFile | null> {
    const absolutePath = path.join(rootDir, fileName);
    let stat;
    try {
        stat = await fsp.lstat(absolutePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Hoshidicts state file is not a regular file: ${fileName}`);
    }
    return { path: fileName, absolutePath };
}

function assertUniqueFiles(files: readonly SourceFile[]): void {
    const names = new Set<string>();
    for (const file of files) {
        const key = file.path.toLowerCase();
        if (names.has(key)) {
            throw new Error(`Backup contains duplicate file paths: ${file.path}`);
        }
        names.add(key);
    }
}

async function validateNativeDictionary(
    payloadRoot: string,
    reference: HoshidictsBackupDictionaryReference,
    files: ReadonlySet<string>,
): Promise<void> {
    const prefix = `${reference.path}/`;
    if (![...files].some((file) => file.startsWith(prefix))) {
        throw new Error(`Backup is missing dictionary files for ${reference.id}.`);
    }
    if (!HOSHIDICTS_MARKERS.some((marker) => files.has(`${prefix}${marker}`))) {
        throw new Error(`Backup dictionary ${reference.id} is missing a Hoshidicts marker.`);
    }
    for (const fileName of REQUIRED_DICTIONARY_FILES) {
        const relativePath = `${prefix}${fileName}`;
        if (!files.has(relativePath)) {
            throw new Error(`Backup dictionary ${reference.id} is missing ${fileName}.`);
        }
        const stat = await fsp.stat(resolveInside(payloadRoot, relativePath));
        if (!stat.isFile() || stat.size === 0) {
            throw new Error(`Backup dictionary ${reference.id} has an invalid ${fileName}.`);
        }
    }
    const indexRelativePath = `${prefix}index.json`;
    if (!files.has(indexRelativePath)) {
        throw new Error(`Backup dictionary ${reference.id} is missing index.json.`);
    }
    const index = await readBoundedJsonFile(
        resolveInside(payloadRoot, indexRelativePath),
        MAX_GENERATED_INDEX_BYTES,
        `Backup dictionary ${reference.id} index`,
    );
    if (!isRecord(index) || typeof index.title !== 'string' || index.title.trim().length === 0) {
        throw new Error(`Backup dictionary ${reference.id} has an invalid index.json.`);
    }
    if (index.title !== reference.path.split('/')[3]) {
        throw new Error(`Backup dictionary ${reference.id} title does not match its path.`);
    }
    const counts = isRecord(index.counts) ? index.counts : {};
    const media = isRecord(counts.media) ? counts.media : {};
    const mediaCount =
        typeof media.total === 'number' && Number.isFinite(media.total)
            ? Math.max(0, Math.trunc(media.total))
            : 0;
    if (mediaCount > 0) {
        for (const fileName of REQUIRED_MEDIA_FILES) {
            const relativePath = `${prefix}${fileName}`;
            if (!files.has(relativePath)) {
                throw new Error(`Backup dictionary ${reference.id} is missing ${fileName}.`);
            }
            const stat = await fsp.stat(resolveInside(payloadRoot, relativePath));
            if (!stat.isFile() || stat.size === 0) {
                throw new Error(`Backup dictionary ${reference.id} has an invalid ${fileName}.`);
            }
        }
    }
}

function parseBackupManifest(value: unknown): HoshidictsBackupManifest {
    if (
        !isRecord(value) ||
        value.format !== HOSHIDICTS_BACKUP_FORMAT ||
        value.version !== HOSHIDICTS_BACKUP_VERSION ||
        typeof value.createdAt !== 'string' ||
        Number.isNaN(new Date(value.createdAt).getTime()) ||
        !isRecord(value.state) ||
        !Array.isArray(value.dictionaries) ||
        !Array.isArray(value.files) ||
        value.dictionaries.length > 256 ||
        value.files.length > MAX_BACKUP_FILE_COUNT
    ) {
        throw new Error('The selected archive is not a supported Hoshidicts backup.');
    }
    const state: HoshidictsBackupStateReferences = {
        manifest:
            value.state.manifest === MANAGER_MANIFEST_FILE_NAME
                ? MANAGER_MANIFEST_FILE_NAME
                : (() => {
                      throw new Error(
                          'Hoshidicts backup has an invalid manager manifest reference.',
                      );
                  })(),
        miningProfile:
            value.state.miningProfile === null ||
            value.state.miningProfile === MINING_PROFILE_FILE_NAME
                ? value.state.miningProfile
                : (() => {
                      throw new Error('Hoshidicts backup has an invalid mining profile reference.');
                  })(),
        audioProfile:
            value.state.audioProfile === null ||
            value.state.audioProfile === AUDIO_PROFILE_FILE_NAME
                ? value.state.audioProfile
                : (() => {
                      throw new Error('Hoshidicts backup has an invalid audio profile reference.');
                  })(),
        customDictionary:
            value.state.customDictionary === null ||
            value.state.customDictionary === CUSTOM_DICTIONARY_FILE_NAME
                ? value.state.customDictionary
                : (() => {
                      throw new Error(
                          'Hoshidicts backup has an invalid custom dictionary reference.',
                      );
                  })(),
    };
    const dictionaries = value.dictionaries.map((dictionary, index) => {
        if (!isRecord(dictionary)) {
            throw new Error('Hoshidicts backup has an invalid dictionary reference.');
        }
        return normalizeDictionaryReference(
            dictionary.id,
            dictionary.path,
            `Hoshidicts backup dictionary ${index + 1}`,
        );
    });
    const dictionaryIds = new Set<string>();
    const dictionaryPaths = new Set<string>();
    for (const dictionary of dictionaries) {
        const id = dictionary.id.toLowerCase();
        const dictionaryPath = dictionary.path.toLowerCase();
        if (dictionaryIds.has(id) || dictionaryPaths.has(dictionaryPath)) {
            throw new Error('Hoshidicts backup has duplicate dictionary references.');
        }
        dictionaryIds.add(id);
        dictionaryPaths.add(dictionaryPath);
    }

    let totalBytes = 0;
    const fileNames = new Set<string>();
    const files = value.files.map((file) => {
        if (
            !isRecord(file) ||
            !Number.isSafeInteger(file.size) ||
            (file.size as number) < 0 ||
            (file.size as number) > MAX_BACKUP_ENTRY_BYTES ||
            typeof file.sha256 !== 'string' ||
            !SHA256_PATTERN.test(file.sha256)
        ) {
            throw new Error('Hoshidicts backup has invalid file metadata.');
        }
        const relativePath = normalizeRelativePath(file.path, 'Hoshidicts backup file');
        const key = relativePath.toLowerCase();
        if (fileNames.has(key)) {
            throw new Error(`Hoshidicts backup contains duplicate files: ${relativePath}`);
        }
        fileNames.add(key);
        totalBytes += file.size as number;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BACKUP_TOTAL_BYTES) {
            throw new Error('Hoshidicts backup exceeds its total size limit.');
        }
        return {
            path: relativePath,
            size: file.size as number,
            sha256: file.sha256,
        };
    });
    return {
        format: HOSHIDICTS_BACKUP_FORMAT,
        version: HOSHIDICTS_BACKUP_VERSION,
        createdAt: new Date(value.createdAt).toISOString(),
        state,
        dictionaries,
        files,
    };
}

async function validateBackupContents(
    payloadRoot: string,
    manifest: HoshidictsBackupManifest,
    actualFiles: ReadonlyMap<string, Omit<HoshidictsBackupFileMetadata, 'path'>>,
): Promise<ManagerManifestInspection> {
    const expectedFiles = new Map(manifest.files.map((file) => [file.path, file]));
    if (expectedFiles.size !== actualFiles.size) {
        throw new Error('Hoshidicts backup has missing or unlisted payload entries.');
    }
    for (const [relativePath, expected] of expectedFiles) {
        const actual = actualFiles.get(relativePath);
        if (!actual) {
            throw new Error(`Hoshidicts backup is missing payload entry: ${relativePath}`);
        }
        if (actual.size !== expected.size) {
            throw new Error(`Hoshidicts backup payload size mismatch: ${relativePath}`);
        }
        if (actual.sha256 !== expected.sha256) {
            throw new Error(`Hoshidicts backup payload hash mismatch: ${relativePath}`);
        }
    }

    const expectedStateFiles = new Set<string>();
    for (const reference of [
        manifest.state.manifest,
        manifest.state.miningProfile,
        manifest.state.audioProfile,
        manifest.state.customDictionary,
    ]) {
        if (reference !== null) {
            expectedStateFiles.add(reference);
        }
    }
    for (const fileName of STATE_FILE_NAMES) {
        if (expectedFiles.has(fileName) !== expectedStateFiles.has(fileName)) {
            throw new Error(`Hoshidicts backup state reference is inconsistent: ${fileName}`);
        }
    }

    const managerManifest = inspectManagerManifest(
        await readBoundedJsonFile(
            resolveInside(payloadRoot, manifest.state.manifest),
            MAX_MANAGER_MANIFEST_BYTES,
            'Hoshidicts manager manifest',
        ),
    );
    if (
        managerManifest.dictionaries.length !== manifest.dictionaries.length ||
        managerManifest.dictionaries.some(
            (dictionary, index) =>
                dictionary.id !== manifest.dictionaries[index]?.id ||
                dictionary.path !== manifest.dictionaries[index]?.path,
        )
    ) {
        throw new Error('Hoshidicts backup dictionary references do not match manager state.');
    }

    for (const file of manifest.files) {
        if (expectedStateFiles.has(file.path)) {
            continue;
        }
        if (
            !manifest.dictionaries.some((dictionary) => file.path.startsWith(`${dictionary.path}/`))
        ) {
            throw new Error(
                `Hoshidicts backup contains an unreferenced payload file: ${file.path}`,
            );
        }
    }
    const fileSet = new Set(expectedFiles.keys());
    for (const dictionary of manifest.dictionaries) {
        await validateNativeDictionary(payloadRoot, dictionary, fileSet);
    }
    await validateOptionalJsonState(payloadRoot, manifest.state);
    return managerManifest;
}

async function writeArchive(
    outputPath: string,
    manifest: HoshidictsBackupManifest,
    files: readonly SourceFile[],
): Promise<void> {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    let outputCreated = false;
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const output = fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
            const archive = archiver('zip', { zlib: { level: 6 } });
            const fail = (error: unknown) => {
                if (!settled) {
                    settled = true;
                    output.destroy();
                    reject(error);
                }
            };
            output.once('open', () => {
                outputCreated = true;
            });
            output.once('close', () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            });
            output.once('error', fail);
            archive.once('error', fail);
            archive.once('warning', fail);
            archive.pipe(output);
            archive.append(`${JSON.stringify(manifest, null, 2)}\n`, {
                name: HOSHIDICTS_BACKUP_MANIFEST_FILE_NAME,
            });
            for (const file of files) {
                archive.file(file.absolutePath, {
                    name: path.posix.join(PAYLOAD_DIRECTORY, file.path),
                });
            }
            void archive.finalize().catch(fail);
        });
    } catch (error) {
        if (outputCreated) {
            await fsp.rm(outputPath, { force: true }).catch(() => undefined);
        }
        throw error;
    }
}

export async function exportHoshidictsBackup(
    options: ExportHoshidictsBackupOptions,
): Promise<ExportedHoshidictsBackup> {
    const rootDir = path.resolve(options.rootDir);
    const outputPath = path.resolve(options.outputPath);
    const managerManifestPath = path.join(rootDir, MANAGER_MANIFEST_FILE_NAME);
    const manager = inspectManagerManifest(
        await readBoundedJsonFile(
            managerManifestPath,
            MAX_MANAGER_MANIFEST_BYTES,
            'Hoshidicts manager manifest',
        ),
    );
    const files: SourceFile[] = [
        { path: MANAGER_MANIFEST_FILE_NAME, absolutePath: managerManifestPath },
    ];
    const miningProfile = await optionalSourceFile(rootDir, MINING_PROFILE_FILE_NAME);
    const audioProfile = await optionalSourceFile(rootDir, AUDIO_PROFILE_FILE_NAME);
    const customDictionary = await optionalSourceFile(rootDir, CUSTOM_DICTIONARY_FILE_NAME);
    for (const file of [miningProfile, audioProfile, customDictionary]) {
        if (file) {
            files.push(file);
        }
    }
    for (const dictionary of manager.dictionaries) {
        await collectDirectoryFiles(rootDir, dictionary.path, files);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    assertUniqueFiles(files);
    if (files.length > MAX_BACKUP_FILE_COUNT) {
        throw new Error('Hoshidicts backup contains too many files.');
    }

    const fileManifest: HoshidictsBackupFileMetadata[] = [];
    let totalBytes = 0;
    for (const file of files) {
        const metadata = await fileMetadata(file.absolutePath);
        totalBytes += metadata.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BACKUP_TOTAL_BYTES) {
            throw new Error('Hoshidicts backup exceeds its total size limit.');
        }
        fileManifest.push({ path: file.path, ...metadata });
    }
    const state: HoshidictsBackupStateReferences = {
        manifest: MANAGER_MANIFEST_FILE_NAME,
        miningProfile: miningProfile ? MINING_PROFILE_FILE_NAME : null,
        audioProfile: audioProfile ? AUDIO_PROFILE_FILE_NAME : null,
        customDictionary: customDictionary ? CUSTOM_DICTIONARY_FILE_NAME : null,
    };
    const manifest: HoshidictsBackupManifest = {
        format: HOSHIDICTS_BACKUP_FORMAT,
        version: HOSHIDICTS_BACKUP_VERSION,
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        state,
        dictionaries: manager.dictionaries,
        files: fileManifest,
    };
    await validateBackupContents(
        rootDir,
        manifest,
        new Map(fileManifest.map(({ path: filePath, ...metadata }) => [filePath, metadata])),
    );
    await writeArchive(outputPath, manifest, files);
    return { outputPath, manifest };
}

class NativeFileRandomAccessReader extends yauzl.RandomAccessReader {
    constructor(private readonly archivePath: string) {
        super();
    }

    override _readStreamForRange(start: number, end: number): Readable {
        return fs.createReadStream(this.archivePath, { start, end: end - 1 });
    }
}

async function openZip(archivePath: string): Promise<ZipFile> {
    const archiveStat = await fsp.stat(archivePath);
    if (!archiveStat.isFile() || !Number.isSafeInteger(archiveStat.size)) {
        throw new Error('Hoshidicts backup archive is not a regular file.');
    }
    return await new Promise((resolve, reject) => {
        // yauzl 2.x normally delegates range reads to fd-slicer 1.x. That legacy
        // stream can stop one chunk before EOF on large files in modern Node,
        // leaving a restore promise permanently unsettled. Native range streams
        // preserve yauzl's ZIP parsing and validation without that compatibility bug.
        yauzl.fromRandomAccessReader(
            new NativeFileRandomAccessReader(archivePath),
            archiveStat.size,
            { lazyEntries: true, autoClose: true, validateEntrySizes: true },
            (error, zip) => {
                if (error || !zip) {
                    reject(error ?? new Error('Could not open Hoshidicts backup archive.'));
                    return;
                }
                resolve(zip);
            },
        );
    });
}

function openZipEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
                reject(error ?? new Error(`Could not read backup entry ${entry.fileName}.`));
                return;
            }
            resolve(stream);
        });
    });
}

function isSymbolicLinkEntry(entry: Entry): boolean {
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    return (unixMode & 0o170000) === 0o120000;
}

async function extractBackupArchive(
    archivePath: string,
    stagingRoot: string,
    payloadRoot: string,
): Promise<Map<string, Omit<HoshidictsBackupFileMetadata, 'path'>>> {
    const zip = await openZip(archivePath);
    const actualFiles = new Map<string, Omit<HoshidictsBackupFileMetadata, 'path'>>();
    const archiveNames = new Set<string>();
    let manifestFound = false;
    let entryCount = 0;
    let totalBytes = 0;

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            if (error) {
                zip.close();
                reject(error);
            } else {
                resolve();
            }
        };
        zip.once('error', finish);
        zip.once('end', () => finish());
        zip.on('entry', (entry) => {
            void (async () => {
                const directory = entry.fileName.endsWith('/');
                const rawName = directory ? entry.fileName.slice(0, -1) : entry.fileName;
                const archiveName = normalizeRelativePath(rawName, 'Hoshidicts backup entry');
                const archiveKey = archiveName.toLowerCase();
                if (archiveNames.has(archiveKey)) {
                    throw new Error(`Hoshidicts backup contains duplicate entries: ${archiveName}`);
                }
                archiveNames.add(archiveKey);
                if (directory) {
                    if (
                        archiveName !== PAYLOAD_DIRECTORY &&
                        !archiveName.startsWith(`${PAYLOAD_DIRECTORY}/`)
                    ) {
                        throw new Error(
                            `Hoshidicts backup has an unexpected directory: ${archiveName}`,
                        );
                    }
                    zip.readEntry();
                    return;
                }
                entryCount += 1;
                if (entryCount > MAX_BACKUP_FILE_COUNT + 1 || isSymbolicLinkEntry(entry)) {
                    throw new Error('Hoshidicts backup contains an invalid archive entry.');
                }
                if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
                    throw new Error(`Hoshidicts backup entry has an invalid size: ${archiveName}`);
                }
                const isManifest = archiveName === HOSHIDICTS_BACKUP_MANIFEST_FILE_NAME;
                const maximumBytes = isManifest
                    ? MAX_BACKUP_MANIFEST_BYTES
                    : MAX_BACKUP_ENTRY_BYTES;
                if (entry.uncompressedSize > maximumBytes) {
                    throw new Error(`Hoshidicts backup entry is too large: ${archiveName}`);
                }
                totalBytes += entry.uncompressedSize;
                if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BACKUP_TOTAL_BYTES) {
                    throw new Error('Hoshidicts backup exceeds its total size limit.');
                }

                let outputPath: string;
                let payloadPath: string | null = null;
                if (isManifest) {
                    if (manifestFound) {
                        throw new Error('Hoshidicts backup contains duplicate manifests.');
                    }
                    manifestFound = true;
                    outputPath = path.join(stagingRoot, HOSHIDICTS_BACKUP_MANIFEST_FILE_NAME);
                } else {
                    const prefix = `${PAYLOAD_DIRECTORY}/`;
                    if (!archiveName.startsWith(prefix)) {
                        throw new Error(
                            `Hoshidicts backup has an unexpected entry: ${archiveName}`,
                        );
                    }
                    payloadPath = normalizeRelativePath(
                        archiveName.slice(prefix.length),
                        'Hoshidicts backup payload entry',
                    );
                    outputPath = resolveInside(payloadRoot, payloadPath);
                }
                const metadata = await streamToNewFile(
                    await openZipEntry(zip, entry),
                    outputPath,
                    maximumBytes,
                );
                if (metadata.size !== entry.uncompressedSize) {
                    throw new Error(`Hoshidicts backup entry size changed: ${archiveName}`);
                }
                if (payloadPath !== null) {
                    actualFiles.set(payloadPath, metadata);
                }
                zip.readEntry();
            })().catch(finish);
        });
        zip.readEntry();
    });
    if (!manifestFound) {
        throw new Error(`Hoshidicts backup is missing ${HOSHIDICTS_BACKUP_MANIFEST_FILE_NAME}.`);
    }
    return actualFiles;
}

export async function prepareHoshidictsBackupRestore(
    options: PrepareHoshidictsBackupRestoreOptions,
): Promise<PreparedHoshidictsBackupRestore> {
    const archivePath = path.resolve(options.archivePath);
    const stagingParent = path.resolve(options.stagingParent ?? os.tmpdir());
    await fsp.mkdir(stagingParent, { recursive: true });
    const stagingRoot = await fsp.mkdtemp(path.join(stagingParent, 'gsm-hoshidicts-restore-'));
    const payloadRoot = path.join(stagingRoot, PAYLOAD_DIRECTORY);
    try {
        await fsp.mkdir(payloadRoot);
        const actualFiles = await extractBackupArchive(archivePath, stagingRoot, payloadRoot);
        const manifest = parseBackupManifest(
            await readBoundedJsonFile(
                path.join(stagingRoot, HOSHIDICTS_BACKUP_MANIFEST_FILE_NAME),
                MAX_BACKUP_MANIFEST_BYTES,
                'Hoshidicts backup manifest',
            ),
        );
        const manager = await validateBackupContents(payloadRoot, manifest, actualFiles);
        return {
            archivePath,
            stagingRoot,
            payloadRoot,
            manifest,
            managerManifest: manager.value,
            dictionaries: manager.dictionaries,
        };
    } catch (error) {
        await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

export async function disposePreparedHoshidictsBackupRestore(
    prepared: Pick<PreparedHoshidictsBackupRestore, 'stagingRoot'>,
): Promise<void> {
    await fsp.rm(prepared.stagingRoot, { recursive: true, force: true });
}

async function copyAndRevalidatePreparedPayload(
    prepared: PreparedHoshidictsBackupRestore,
    outputRoot: string,
): Promise<ManagerManifestInspection> {
    const actualFiles = new Map<string, Omit<HoshidictsBackupFileMetadata, 'path'>>();
    for (const file of prepared.manifest.files) {
        const metadata = await copyFileWithMetadata(
            resolveInside(prepared.payloadRoot, file.path),
            resolveInside(outputRoot, file.path),
        );
        actualFiles.set(file.path, metadata);
    }
    return await validateBackupContents(outputRoot, prepared.manifest, actualFiles);
}

async function snapshotStateFiles(
    targetRootDir: string,
    rollbackRoot: string,
): Promise<StateSnapshot[]> {
    await fsp.mkdir(rollbackRoot, { recursive: true });
    const snapshots: StateSnapshot[] = [];
    for (const fileName of STATE_FILE_NAMES) {
        const targetPath = path.join(targetRootDir, fileName);
        const backupPath = path.join(rollbackRoot, fileName);
        try {
            const stat = await fsp.lstat(targetPath);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new Error(`Live Hoshidicts state is not a regular file: ${fileName}`);
            }
            await fsp.copyFile(targetPath, backupPath, fsConstants.COPYFILE_EXCL);
            snapshots.push({ fileName, existed: true, backupPath });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            snapshots.push({ fileName, existed: false, backupPath });
        }
    }
    return snapshots;
}

async function atomicReplaceFromFile(
    sourcePath: string,
    destinationPath: string,
    token: string,
): Promise<void> {
    const temporaryPath = path.join(
        path.dirname(destinationPath),
        `.${path.basename(destinationPath)}.${token}.tmp`,
    );
    await fsp.copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL);
    const handle = await fsp.open(temporaryPath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await fsp.rename(temporaryPath, destinationPath);
    } catch (error) {
        await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function installStateFiles(
    targetRootDir: string,
    pendingRoot: string,
    state: HoshidictsBackupStateReferences,
    token: string,
): Promise<void> {
    for (const [fileName, included] of [
        [MINING_PROFILE_FILE_NAME, state.miningProfile !== null],
        [AUDIO_PROFILE_FILE_NAME, state.audioProfile !== null],
        [CUSTOM_DICTIONARY_FILE_NAME, state.customDictionary !== null],
    ] as const) {
        const targetPath = path.join(targetRootDir, fileName);
        if (included) {
            await atomicReplaceFromFile(path.join(pendingRoot, fileName), targetPath, token);
        } else {
            await fsp.rm(targetPath, { force: true });
        }
    }
    await atomicReplaceFromFile(
        path.join(pendingRoot, MANAGER_MANIFEST_FILE_NAME),
        path.join(targetRootDir, MANAGER_MANIFEST_FILE_NAME),
        token,
    );
}

async function restoreStateFiles(
    targetRootDir: string,
    snapshots: readonly StateSnapshot[],
    token: string,
): Promise<void> {
    const manifestSnapshot = snapshots.find(
        (snapshot) => snapshot.fileName === MANAGER_MANIFEST_FILE_NAME,
    );
    const ordered = [
        ...snapshots.filter((snapshot) => snapshot !== manifestSnapshot),
        ...(manifestSnapshot ? [manifestSnapshot] : []),
    ];
    for (const snapshot of ordered) {
        const targetPath = path.join(targetRootDir, snapshot.fileName);
        if (snapshot.existed) {
            await atomicReplaceFromFile(snapshot.backupPath, targetPath, `${token}-rollback`);
        } else {
            await fsp.rm(targetPath, { force: true });
        }
    }
}

async function currentDictionaryPaths(targetRootDir: string): Promise<string[]> {
    const manifestPath = path.join(targetRootDir, MANAGER_MANIFEST_FILE_NAME);
    try {
        await fsp.stat(manifestPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    try {
        const manifest = inspectManagerManifest(
            await readBoundedJsonFile(
                manifestPath,
                MAX_MANAGER_MANIFEST_BYTES,
                'Current Hoshidicts manager manifest',
            ),
        );
        return manifest.dictionaries.map((dictionary) => dictionary.path);
    } catch (error) {
        throw new Error(`Current Hoshidicts state cannot be replaced: ${errorMessage(error)}`);
    }
}

function defaultFreshGenerationId(): string {
    return `restore-${Date.now().toString(36)}-${randomUUID()}`;
}

export async function commitPreparedHoshidictsBackupRestore(
    prepared: PreparedHoshidictsBackupRestore,
    options: CommitPreparedHoshidictsBackupRestoreOptions,
): Promise<CommittedHoshidictsBackupRestore> {
    const targetRootDir = path.resolve(options.targetRootDir);
    await fsp.mkdir(path.join(targetRootDir, '.staging'), { recursive: true });
    const token = `hoshidicts-backup-${randomUUID()}`;
    const transactionRoot = path.join(targetRootDir, '.staging', token);
    const verifiedRoot = path.join(transactionRoot, 'verified');
    const pendingRoot = path.join(transactionRoot, 'pending-state');
    const rollbackRoot = path.join(transactionRoot, 'rollback-state');
    const stagedGenerationsRoot = path.join(transactionRoot, 'new-generations');
    const installed: InstalledGeneration[] = [];
    let snapshots: StateSnapshot[] = [];
    let stateMutationStarted = false;
    let activationAttempted = false;
    try {
        await fsp.mkdir(verifiedRoot, { recursive: true });
        const manager = await copyAndRevalidatePreparedPayload(prepared, verifiedRoot);
        const previousDictionaryPaths = await currentDictionaryPaths(targetRootDir);
        const dictionaryPaths = new Map<string, string>();
        await fsp.mkdir(stagedGenerationsRoot, { recursive: true });
        for (const [index, dictionary] of manager.dictionaries.entries()) {
            const generation =
                options.freshGenerationId?.(dictionary, index) ?? defaultFreshGenerationId();
            if (!SAFE_ID_PATTERN.test(generation)) {
                throw new Error('Fresh Hoshidicts restore generation id is invalid.');
            }
            const directoryName = dictionary.path.split('/')[3];
            const relativePath = path.posix.join(
                'generations',
                dictionary.id,
                generation,
                directoryName,
            );
            const stagedRoot = path.join(stagedGenerationsRoot, dictionary.id, generation);
            const stagedDictionary = path.join(stagedRoot, directoryName);
            await fsp.mkdir(stagedRoot, { recursive: true });
            await fsp.rename(resolveInside(verifiedRoot, dictionary.path), stagedDictionary);
            dictionaryPaths.set(dictionary.id, relativePath);
        }

        const restoredDictionaries = (manager.value.dictionaries as Record<string, unknown>[]).map(
            (dictionary) => ({
                ...dictionary,
                path: dictionaryPaths.get(String(dictionary.id)),
            }),
        );
        const restoredManagerManifest: Record<string, unknown> = {
            ...manager.value,
            dictionaries: restoredDictionaries,
        };
        const serializedManagerManifest = Buffer.from(
            `${JSON.stringify(restoredManagerManifest, null, 2)}\n`,
            'utf8',
        );
        if (serializedManagerManifest.byteLength > MAX_MANAGER_MANIFEST_BYTES) {
            throw new Error('Restored Hoshidicts manager manifest is too large.');
        }
        await fsp.mkdir(pendingRoot, { recursive: true });
        await fsp.writeFile(
            path.join(pendingRoot, MANAGER_MANIFEST_FILE_NAME),
            serializedManagerManifest,
            { flag: 'wx', mode: 0o600 },
        );
        for (const reference of [
            prepared.manifest.state.miningProfile,
            prepared.manifest.state.audioProfile,
            prepared.manifest.state.customDictionary,
        ]) {
            if (reference !== null) {
                await fsp.copyFile(
                    resolveInside(verifiedRoot, reference),
                    path.join(pendingRoot, reference),
                    fsConstants.COPYFILE_EXCL,
                );
            }
        }

        snapshots = await snapshotStateFiles(targetRootDir, rollbackRoot);
        for (const dictionary of manager.dictionaries) {
            const relativePath = dictionaryPaths.get(dictionary.id);
            if (!relativePath) {
                throw new Error(`Fresh generation path is missing for ${dictionary.id}.`);
            }
            const components = relativePath.split('/');
            const finalRoot = path.join(targetRootDir, ...components.slice(0, 3));
            const stagedRoot = path.join(stagedGenerationsRoot, dictionary.id, components[2]);
            await fsp.mkdir(path.dirname(finalRoot), { recursive: true });
            try {
                await fsp.lstat(finalRoot);
                throw new Error(`Fresh Hoshidicts generation already exists: ${relativePath}`);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
            await fsp.rename(stagedRoot, finalRoot);
            installed.push({ root: finalRoot });
        }

        stateMutationStarted = true;
        await installStateFiles(targetRootDir, pendingRoot, prepared.manifest.state, token);
        if (options.activate) {
            activationAttempted = true;
            await options.activate();
        }
        return {
            managerManifest: restoredManagerManifest,
            installedGenerationRoots: installed.map((generation) => generation.root),
            previousDictionaryPaths,
        };
    } catch (commitError) {
        let rollbackError: unknown = null;
        let rollbackRestored = !stateMutationStarted;
        if (stateMutationStarted) {
            try {
                await restoreStateFiles(targetRootDir, snapshots, token);
                rollbackRestored = true;
            } catch (error) {
                rollbackError = error;
                rollbackRestored = false;
            }
            if (rollbackRestored && activationAttempted && options.activate) {
                try {
                    await options.activate();
                } catch (error) {
                    rollbackError ??= error;
                }
            }
        }
        if (rollbackRestored) {
            await Promise.all(
                installed.map(
                    async (generation) =>
                        await fsp.rm(generation.root, { recursive: true, force: true }),
                ),
            );
        }
        const retained = rollbackRestored
            ? ''
            : ' Fresh dictionary generations were retained for recovery.';
        const rollbackSuffix = rollbackError
            ? ` Rollback error: ${errorMessage(rollbackError)}.`
            : '';
        throw new HoshidictsBackupCommitError(
            `Hoshidicts backup restore failed: ${errorMessage(commitError)}.${retained}${rollbackSuffix}`,
            rollbackRestored,
        );
    } finally {
        await fsp.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
