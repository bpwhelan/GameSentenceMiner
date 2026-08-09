import archiver from 'archiver';
import extract from 'extract-zip';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getBaseDir, getDefaultBaseDir } from '../data_dir.js';

const BACKUP_FORMAT_VERSION = 1;
const MANIFEST_NAME = 'gsm-backup-manifest.json';

const GSM_ARCHIVE_ROOT = 'GameSentenceMiner';
const OVERLAY_ARCHIVE_ROOT = 'gsm_overlay';
const HOME_ARCHIVE_ROOT = 'home';
const OWOCR_HOME_RELATIVE_PATH = '.config/owocr_config_gsm.ini';
const HOSHIDICTS_TAB_GROUPS_FILE_NAME = 'tab-groups.json';
const HOSHIDICTS_TAB_GROUPS_RELATIVE_PATH =
    `dictionaries/hoshidicts/${HOSHIDICTS_TAB_GROUPS_FILE_NAME}`;
const EMPTY_HOSHIDICTS_TAB_GROUPS = Buffer.from('{"version":1,"groups":[]}\n');

const GSM_TOP_LEVEL_FILES = new Set([
    'config.json',
    'gsm.db',
    'gsm.db-shm',
    'gsm.db-wal',
    'multi-mine-window-config.json',
    'plugins.py',
    'scene_config.json',
    'shared_config.json',
    'window_layout.json',
]);

const GSM_TRAVERSABLE_DIRS = new Set([
    'agent-scripts',
    'config',
    'dictionaries',
    'electron',
    'obs-studio',
    'ocr_config',
    'scripts',
    'texthook',
]);

const ELECTRON_SETTINGS_FILES = new Set([
    'config.json',
    'overlay_settings.json',
]);

const HOSHIDICTS_SETTINGS_FILES = new Set([
    'audio-profile.json',
    'custom-dictionary.txt',
    'mining-profile.json',
    HOSHIDICTS_TAB_GROUPS_FILE_NAME,
]);

const OBS_EXCLUDED_CONFIG_DIRS = new Set([
    '.sentinel',
    'crashes',
    'logs',
    'profiler_data',
    'updates',
]);

const TEXTHOOK_SETTINGS_FILES = new Set([
    'profiles.json',
    'texthook_manifest.json',
]);

const OVERLAY_TOP_LEVEL_FILES = new Set([
    'migration_complete.json',
    'Preferences',
    'settings.json',
]);

const OVERLAY_STORAGE_DIRS = new Set([
    'IndexedDB',
    'Local Extension Settings',
    'Local Storage',
    'Partitions',
    'WebStorage',
]);

const OVERLAY_EXCLUDED_DIRS = new Set([
    'blob_storage',
    'Cache',
    'Code Cache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'GPUCache',
    'Network',
    'Service Worker',
    'Session Storage',
    'Shared Dictionary',
]);

const RUNTIME_FILE_NAMES = new Set([
    'LOCK',
    'LOG.old',
]);

export interface BackupManifest {
    format: 'gsm-settings-backup';
    version: number;
    createdAt: string;
    roots: Array<'gsm' | 'overlay' | 'home'>;
    fileCount: number;
    totalBytes: number;
}

export type SettingsBackupOperation = 'create' | 'restore';

export type SettingsBackupProgressPhase =
    | 'scanning'
    | 'archiving'
    | 'extracting'
    | 'stopping-obs'
    | 'stopping-python'
    | 'restoring'
    | 'restarting-python'
    | 'done'
    | 'error';

export interface SettingsBackupProgressEvent {
    operation: SettingsBackupOperation;
    phase: SettingsBackupProgressPhase;
    fileName?: string;
    completed?: number;
    total?: number;
    progress?: number | null;
}

export type SettingsBackupProgressReporter = (progress: SettingsBackupProgressEvent) => void;

export interface BackupArchiveOptions {
    outputPath: string;
    baseDir?: string;
    overlayDir?: string;
    homeConfigPath?: string;
    onProgress?: SettingsBackupProgressReporter;
}

export interface BackupArchiveResult {
    filePath: string;
    fileCount: number;
    totalBytes: number;
    roots: BackupManifest['roots'];
}

export interface RestoreArchiveOptions {
    archivePath: string;
    baseDir?: string;
    overlayDir?: string;
    homeConfigPath?: string;
    onProgress?: SettingsBackupProgressReporter;
}

export interface RestoreArchiveResult {
    fileCount: number;
    totalBytes: number;
    roots: BackupManifest['roots'];
}

interface CollectedFile {
    archivePath: string;
    size: number;
    source:
        | { type: 'file'; absolutePath: string }
        | { type: 'buffer'; contents: Buffer };
}

interface RestoreFile {
    sourcePath: string;
    destinationPath: string;
    displayPath: string;
}

interface BackupSourceRoot {
    key: BackupManifest['roots'][number];
    absolutePath: string;
    archiveRoot: string;
    include: (relativePath: string, isDirectory: boolean) => boolean;
}

function normalizeArchivePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function getUnitProgress(completed: number, total: number): number | null {
    if (!Number.isFinite(total) || total <= 0) {
        return null;
    }
    return Math.max(0, Math.min(1, completed / total));
}

function reportProgress(
    reporter: SettingsBackupProgressReporter | undefined,
    progress: SettingsBackupProgressEvent,
): void {
    reporter?.(progress);
}

function splitRelativePath(relativePath: string): string[] {
    return normalizeArchivePath(relativePath)
        .split('/')
        .filter((part) => part.length > 0);
}

function isRuntimeFileName(name: string): boolean {
    const lower = name.toLowerCase();
    return (
        RUNTIME_FILE_NAMES.has(name) ||
        lower.endsWith('.tmp') ||
        lower.endsWith('.temp') ||
        lower.endsWith('~') ||
        lower === 'thumbs.db' ||
        lower === '.ds_store'
    );
}

function isSqliteDatabaseFile(name: string): boolean {
    return name === 'gsm.db' || name === 'gsm.db-shm' || name === 'gsm.db-wal';
}

export function getOverlayDataDir(baseDir: string = getBaseDir()): string {
    const defaultBaseDir = getDefaultBaseDir();
    return path.resolve(baseDir) === path.resolve(defaultBaseDir)
        ? path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'gsm_overlay')
        : path.join(baseDir, 'gsm_overlay');
}

export function getOwocrConfigPath(): string {
    return path.join(os.homedir(), '.config', 'owocr_config_gsm.ini');
}

export function shouldIncludeGsmBackupPath(relativePath: string, isDirectory: boolean): boolean {
    const parts = splitRelativePath(relativePath);
    if (parts.length === 0) {
        return false;
    }

    const [first, second] = parts;

    if (first === 'gsm_overlay') {
        return false;
    }

    if (parts.length === 1) {
        if (isDirectory) {
            return GSM_TRAVERSABLE_DIRS.has(first);
        }
        return GSM_TOP_LEVEL_FILES.has(first) || isSqliteDatabaseFile(first);
    }

    if (first === 'electron') {
        if (parts.length === 2 && !isDirectory) {
            return ELECTRON_SETTINGS_FILES.has(second);
        }
        return false;
    }

    if (first === 'dictionaries') {
        if (parts.length === 2 && second === 'hoshidicts' && isDirectory) {
            return true;
        }
        return (
            parts.length === 3 &&
            second === 'hoshidicts' &&
            !isDirectory &&
            HOSHIDICTS_SETTINGS_FILES.has(parts[2])
        );
    }

    if (first === 'ocr_config') {
        if (second === 'backup') {
            return false;
        }
        return isDirectory || !isRuntimeFileName(parts[parts.length - 1]);
    }

    if (first === 'obs-studio') {
        if (second !== 'config') {
            return false;
        }
        if (parts.length >= 4 && OBS_EXCLUDED_CONFIG_DIRS.has(parts[3])) {
            return false;
        }
        return isDirectory || !isRuntimeFileName(parts[parts.length - 1]);
    }

    if (first === 'texthook') {
        if (parts.length === 2 && !isDirectory) {
            return TEXTHOOK_SETTINGS_FILES.has(second);
        }
        return false;
    }

    if (first === 'config' || first === 'agent-scripts' || first === 'scripts') {
        return isDirectory || !isRuntimeFileName(parts[parts.length - 1]);
    }

    return false;
}

export function shouldIncludeOverlayBackupPath(relativePath: string, isDirectory: boolean): boolean {
    const parts = splitRelativePath(relativePath);
    if (parts.length === 0) {
        return false;
    }

    const [first] = parts;

    if (parts.length === 1) {
        if (isDirectory) {
            return OVERLAY_STORAGE_DIRS.has(first) && !OVERLAY_EXCLUDED_DIRS.has(first);
        }
        return OVERLAY_TOP_LEVEL_FILES.has(first);
    }

    if (OVERLAY_STORAGE_DIRS.has(first)) {
        return isDirectory || !isRuntimeFileName(parts[parts.length - 1]);
    }

    return false;
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fsp.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function collectFilesForRoot(root: BackupSourceRoot): Promise<CollectedFile[]> {
    if (!(await pathExists(root.absolutePath))) {
        return [];
    }

    const files: CollectedFile[] = [];

    async function walk(currentDirectory: string): Promise<void> {
        const entries = await fsp.readdir(currentDirectory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }

            const absolutePath = path.join(currentDirectory, entry.name);
            const relativePath = path.relative(root.absolutePath, absolutePath);
            const archiveRelativePath = normalizeArchivePath(relativePath);

            if (entry.isDirectory()) {
                if (root.include(archiveRelativePath, true)) {
                    await walk(absolutePath);
                }
                continue;
            }

            if (!entry.isFile() || !root.include(archiveRelativePath, false)) {
                continue;
            }

            const stat = await fsp.stat(absolutePath);
            files.push({
                archivePath: `${root.archiveRoot}/${archiveRelativePath}`,
                size: stat.size,
                source: { type: 'file', absolutePath },
            });
        }
    }

    await walk(root.absolutePath);
    return files;
}

async function collectStandaloneFile(
    absolutePath: string,
    archivePath: string,
): Promise<CollectedFile[]> {
    if (!(await pathExists(absolutePath))) {
        return [];
    }
    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) {
        return [];
    }
    return [
        {
            archivePath,
            size: stat.size,
            source: { type: 'file', absolutePath },
        },
    ];
}

async function collectBackupFiles(options: BackupArchiveOptions): Promise<{
    files: CollectedFile[];
    roots: BackupManifest['roots'];
}> {
    const baseDir = options.baseDir ?? getBaseDir();
    const overlayDir = options.overlayDir ?? getOverlayDataDir(baseDir);
    const homeConfigPath = options.homeConfigPath ?? getOwocrConfigPath();

    const roots: BackupSourceRoot[] = [
        {
            key: 'gsm',
            absolutePath: baseDir,
            archiveRoot: GSM_ARCHIVE_ROOT,
            include: shouldIncludeGsmBackupPath,
        },
        {
            key: 'overlay',
            absolutePath: overlayDir,
            archiveRoot: OVERLAY_ARCHIVE_ROOT,
            include: shouldIncludeOverlayBackupPath,
        },
    ];

    const collected: CollectedFile[] = [];
    const includedRoots = new Set<BackupManifest['roots'][number]>();
    for (const root of roots) {
        const files = await collectFilesForRoot(root);
        if (files.length > 0) {
            includedRoots.add(root.key);
            collected.push(...files);
        }
    }

    const tabGroupsArchivePath =
        `${GSM_ARCHIVE_ROOT}/${HOSHIDICTS_TAB_GROUPS_RELATIVE_PATH}`;
    if (!collected.some(({ archivePath }) => archivePath === tabGroupsArchivePath)) {
        includedRoots.add('gsm');
        collected.push({
            archivePath: tabGroupsArchivePath,
            size: EMPTY_HOSHIDICTS_TAB_GROUPS.byteLength,
            source: { type: 'buffer', contents: EMPTY_HOSHIDICTS_TAB_GROUPS },
        });
    }

    const homeFiles = await collectStandaloneFile(
        homeConfigPath,
        `${HOME_ARCHIVE_ROOT}/${OWOCR_HOME_RELATIVE_PATH}`,
    );
    if (homeFiles.length > 0) {
        includedRoots.add('home');
        collected.push(...homeFiles);
    }

    return {
        files: collected.sort((left, right) => left.archivePath.localeCompare(right.archivePath)),
        roots: Array.from(includedRoots).sort() as BackupManifest['roots'],
    };
}

export async function createBackupArchive(
    options: BackupArchiveOptions,
): Promise<BackupArchiveResult> {
    reportProgress(options.onProgress, {
        operation: 'create',
        phase: 'scanning',
        completed: 0,
        progress: null,
    });

    const { files, roots } = await collectBackupFiles(options);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const manifest: BackupManifest = {
        format: 'gsm-settings-backup',
        version: BACKUP_FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        roots,
        fileCount: files.length,
        totalBytes,
    };

    await fsp.mkdir(path.dirname(options.outputPath), { recursive: true });

    reportProgress(options.onProgress, {
        operation: 'create',
        phase: 'archiving',
        completed: 0,
        total: files.length,
        progress: getUnitProgress(0, files.length),
    });

    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(options.outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        let archivedFiles = 0;

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.on('entry', (entry) => {
            if (entry.name === MANIFEST_NAME) {
                return;
            }

            archivedFiles += 1;
            reportProgress(options.onProgress, {
                operation: 'create',
                phase: 'archiving',
                fileName: entry.name,
                completed: archivedFiles,
                total: files.length,
                progress: getUnitProgress(archivedFiles, files.length),
            });
        });

        archive.pipe(output);
        archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_NAME });
        for (const file of files) {
            if (file.source.type === 'file') {
                archive.file(file.source.absolutePath, { name: file.archivePath });
            } else {
                archive.append(file.source.contents, { name: file.archivePath });
            }
        }

        void archive.finalize();
    });

    reportProgress(options.onProgress, {
        operation: 'create',
        phase: 'done',
        completed: files.length,
        total: files.length,
        progress: 1,
    });

    return {
        filePath: options.outputPath,
        fileCount: files.length,
        totalBytes,
        roots,
    };
}

function parseManifest(value: unknown): BackupManifest {
    if (!value || typeof value !== 'object') {
        throw new Error('The selected archive is missing a GSM backup manifest.');
    }
    const manifest = value as Partial<BackupManifest>;
    if (
        manifest.format !== 'gsm-settings-backup' ||
        manifest.version !== BACKUP_FORMAT_VERSION ||
        !Array.isArray(manifest.roots)
    ) {
        throw new Error('The selected archive is not a supported GSM settings backup.');
    }
    return {
        format: manifest.format,
        version: manifest.version,
        createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
        roots: manifest.roots.filter(
            (root): root is BackupManifest['roots'][number] =>
                root === 'gsm' || root === 'overlay' || root === 'home',
        ),
        fileCount:
            typeof manifest.fileCount === 'number' && Number.isFinite(manifest.fileCount)
                ? manifest.fileCount
                : 0,
        totalBytes:
            typeof manifest.totalBytes === 'number' && Number.isFinite(manifest.totalBytes)
                ? manifest.totalBytes
                : 0,
    };
}

async function readExtractedManifest(extractDir: string): Promise<BackupManifest> {
    const manifestPath = path.join(extractDir, MANIFEST_NAME);
    const raw = await fsp.readFile(manifestPath, 'utf8');
    return parseManifest(JSON.parse(raw));
}

async function removeIfExists(targetPath: string): Promise<void> {
    await fsp.rm(targetPath, { recursive: true, force: true });
}

async function clearChildrenExcept(targetDir: string, excludedNames: Set<string>): Promise<void> {
    if (!(await pathExists(targetDir))) {
        return;
    }
    const entries = await fsp.readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
        if (excludedNames.has(entry.name)) {
            continue;
        }
        await removeIfExists(path.join(targetDir, entry.name));
    }
}

async function collectRestoreFiles(
    sourceDir: string,
    destinationDir: string,
    displayRoot: string,
): Promise<RestoreFile[]> {
    if (!(await pathExists(sourceDir))) {
        return [];
    }

    const files: RestoreFile[] = [];

    async function walk(currentDirectory: string): Promise<void> {
        const entries = await fsp.readdir(currentDirectory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }

            const sourcePath = path.join(currentDirectory, entry.name);
            const relativePath = path.relative(sourceDir, sourcePath);
            if (entry.isDirectory()) {
                await walk(sourcePath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            files.push({
                sourcePath,
                destinationPath: path.join(destinationDir, relativePath),
                displayPath: normalizeArchivePath(path.join(displayRoot, relativePath)),
            });
        }
    }

    await walk(sourceDir);
    return files.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

async function collectHomeRestoreFile(
    sourceDir: string,
    homeConfigPath: string,
): Promise<RestoreFile[]> {
    const sourcePath = path.join(sourceDir, OWOCR_HOME_RELATIVE_PATH);
    if (!(await pathExists(sourcePath))) {
        return [];
    }
    return [
        {
            sourcePath,
            destinationPath: homeConfigPath,
            displayPath: `${HOME_ARCHIVE_ROOT}/${OWOCR_HOME_RELATIVE_PATH}`,
        },
    ];
}

async function copyRestoreFiles(
    files: RestoreFile[],
    onProgress?: SettingsBackupProgressReporter,
): Promise<void> {
    let completed = 0;
    const total = files.length;

    for (const file of files) {
        reportProgress(onProgress, {
            operation: 'restore',
            phase: 'restoring',
            fileName: file.displayPath,
            completed,
            total,
            progress: getUnitProgress(completed, total),
        });

        await fsp.mkdir(path.dirname(file.destinationPath), { recursive: true });
        await fsp.copyFile(file.sourcePath, file.destinationPath);
        completed += 1;

        reportProgress(onProgress, {
            operation: 'restore',
            phase: 'restoring',
            fileName: file.displayPath,
            completed,
            total,
            progress: getUnitProgress(completed, total),
        });
    }
}

async function prepareGsmRestoreTarget(sourceDir: string, baseDir: string): Promise<void> {
    if (!(await pathExists(sourceDir))) {
        return;
    }

    for (const fileName of GSM_TOP_LEVEL_FILES) {
        if (await pathExists(path.join(sourceDir, fileName))) {
            await removeIfExists(path.join(baseDir, fileName));
        }
    }

    if (await pathExists(path.join(sourceDir, 'config'))) {
        await removeIfExists(path.join(baseDir, 'config'));
    }
    if (await pathExists(path.join(sourceDir, 'agent-scripts'))) {
        await removeIfExists(path.join(baseDir, 'agent-scripts'));
    }
    if (await pathExists(path.join(sourceDir, 'scripts'))) {
        await removeIfExists(path.join(baseDir, 'scripts'));
    }
    if (await pathExists(path.join(sourceDir, 'ocr_config'))) {
        await fsp.mkdir(path.join(baseDir, 'ocr_config'), { recursive: true });
        await clearChildrenExcept(path.join(baseDir, 'ocr_config'), new Set(['backup']));
    }
    if (await pathExists(path.join(sourceDir, 'electron'))) {
        await fsp.mkdir(path.join(baseDir, 'electron'), { recursive: true });
        for (const fileName of ELECTRON_SETTINGS_FILES) {
            await removeIfExists(path.join(baseDir, 'electron', fileName));
        }
    }
    if (await pathExists(path.join(sourceDir, 'obs-studio', 'config', 'obs-studio'))) {
        const obsConfigDir = path.join(baseDir, 'obs-studio', 'config', 'obs-studio');
        await fsp.mkdir(obsConfigDir, { recursive: true });
        await clearChildrenExcept(obsConfigDir, OBS_EXCLUDED_CONFIG_DIRS);
    }
    if (await pathExists(path.join(sourceDir, 'texthook'))) {
        await fsp.mkdir(path.join(baseDir, 'texthook'), { recursive: true });
        for (const fileName of TEXTHOOK_SETTINGS_FILES) {
            await removeIfExists(path.join(baseDir, 'texthook', fileName));
        }
    }
}

async function prepareOverlayRestoreTarget(sourceDir: string, overlayDir: string): Promise<void> {
    if (!(await pathExists(sourceDir))) {
        return;
    }
    await fsp.mkdir(overlayDir, { recursive: true });
    const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        await removeIfExists(path.join(overlayDir, entry.name));
    }
}

export async function restoreBackupArchive(
    options: RestoreArchiveOptions,
): Promise<RestoreArchiveResult> {
    const baseDir = options.baseDir ?? getBaseDir();
    const overlayDir = options.overlayDir ?? getOverlayDataDir(baseDir);
    const homeConfigPath = options.homeConfigPath ?? getOwocrConfigPath();
    const extractDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gsm-settings-restore-'));

    try {
        reportProgress(options.onProgress, {
            operation: 'restore',
            phase: 'extracting',
            completed: 0,
            progress: null,
        });

        await extract(options.archivePath, {
            dir: extractDir,
            onEntry: (entry) => {
                if (entry.fileName === MANIFEST_NAME || entry.fileName.endsWith('/')) {
                    return;
                }

                reportProgress(options.onProgress, {
                    operation: 'restore',
                    phase: 'extracting',
                    fileName: entry.fileName,
                    progress: null,
                });
            },
        });
        const manifest = await readExtractedManifest(extractDir);
        const gsmSourceDir = path.join(extractDir, GSM_ARCHIVE_ROOT);
        const overlaySourceDir = path.join(extractDir, OVERLAY_ARCHIVE_ROOT);
        const homeSourceDir = path.join(extractDir, HOME_ARCHIVE_ROOT);
        const restoreFiles: RestoreFile[] = [];

        if (manifest.roots.includes('gsm')) {
            await prepareGsmRestoreTarget(gsmSourceDir, baseDir);
            restoreFiles.push(
                ...(await collectRestoreFiles(gsmSourceDir, baseDir, GSM_ARCHIVE_ROOT)),
            );
        }
        if (manifest.roots.includes('overlay')) {
            await prepareOverlayRestoreTarget(overlaySourceDir, overlayDir);
            restoreFiles.push(
                ...(await collectRestoreFiles(
                    overlaySourceDir,
                    overlayDir,
                    OVERLAY_ARCHIVE_ROOT,
                )),
            );
        }
        if (manifest.roots.includes('home')) {
            restoreFiles.push(...(await collectHomeRestoreFile(homeSourceDir, homeConfigPath)));
        }

        restoreFiles.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
        reportProgress(options.onProgress, {
            operation: 'restore',
            phase: 'restoring',
            completed: 0,
            total: restoreFiles.length,
            progress: getUnitProgress(0, restoreFiles.length),
        });
        await copyRestoreFiles(restoreFiles, options.onProgress);

        reportProgress(options.onProgress, {
            operation: 'restore',
            phase: 'done',
            completed: restoreFiles.length,
            total: restoreFiles.length,
            progress: 1,
        });

        return {
            fileCount: manifest.fileCount,
            totalBytes: manifest.totalBytes,
            roots: manifest.roots,
        };
    } finally {
        await fsp.rm(extractDir, { recursive: true, force: true });
    }
}

export function getDefaultBackupFileName(now = new Date()): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `GSM_Backup_${stamp}.zip`;
}
