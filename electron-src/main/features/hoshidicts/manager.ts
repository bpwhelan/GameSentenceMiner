import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import WebSocket from 'ws';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { getBaseDir } from '../../data_dir.js';
import {
    DEFAULT_INPUT_SERVER_PORT,
    resolveInputServerExecutable,
} from '../../services/input_server.js';
import type {
    HoshidictsDictionaryState,
    HoshidictsManagerSnapshot,
    HoshidictsMiningProfile,
    HoshidictsProgress,
    HoshidictsProgressPhase,
    HoshidictsRecommendedDictionaryId,
    HoshidictsRecommendedDictionaryState,
    HoshidictsSchedule,
} from '../../../shared/features/hoshidicts.js';

export type {
    HoshidictsDictionaryState,
    HoshidictsManagerSnapshot,
    HoshidictsMiningFields,
    HoshidictsMiningProfile,
    HoshidictsProgress,
    HoshidictsProgressPhase,
    HoshidictsRecommendedDictionaryId,
    HoshidictsRecommendedDictionaryState,
    HoshidictsSchedule,
} from '../../../shared/features/hoshidicts.js';

interface PersistedDictionary extends HoshidictsDictionaryState {
    path: string;
    enabled: boolean;
}

interface PersistedManifest {
    version: 1;
    featureEnabled: boolean;
    schedule: HoshidictsSchedule;
    lastCheck: string | null;
    nextCheck: string | null;
    lastError: string | null;
    dictionaries: PersistedDictionary[];
}

interface GeneratedIndex {
    title: string;
    revision: string;
    isUpdatable: boolean;
    indexUrl: string | null;
    downloadUrl: string | null;
    sourceLanguage: string | null;
    termCount: number;
    importDate: number | null;
}

export interface ArchiveInspection {
    sourceLanguage: string | null;
    hasTermBank: boolean;
    hasJapaneseTerm: boolean;
}

export interface HoshidictsImportReport {
    success: boolean;
    title: string;
    termCount: number;
    error: string;
}

interface StagedDictionary {
    dictionary: PersistedDictionary;
    generationRoot: string;
}

export interface HoshidictsRemoteIndex {
    revision: string;
    downloadUrl: string | null;
}

export interface HoshidictsManagerDependencies {
    now: () => Date;
    randomId: () => string;
    inspectArchive: (archivePath: string) => Promise<ArchiveInspection>;
    runImport: (
        archivePath: string,
        outputDir: string
    ) => Promise<HoshidictsImportReport>;
    reloadNative: () => Promise<number>;
    fetchRemoteIndex: (url: string) => Promise<HoshidictsRemoteIndex>;
    downloadArchive: (url: string, outputPath: string) => Promise<void>;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    schedulerIntervalMs: number;
}

const MANIFEST_FILE_NAME = 'manifest.json';
export const HOSHIDICTS_MINING_PROFILE_FILE_NAME = 'mining-profile.json';
const MANIFEST_VERSION = 1;
const MINING_PROFILE_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MINING_PROFILE_BYTES = 64 * 1024;
const MAX_ARCHIVE_INDEX_BYTES = 1024 * 1024;
const MAX_TERM_BANK_BYTES = 32 * 1024 * 1024;
const MAX_SCANNED_TERM_BANKS = 32;
const MAX_REMOTE_INDEX_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_IMPORT_OUTPUT_BYTES = 1024 * 1024;
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
const RELOAD_TIMEOUT_MS = 15 * 1000;
const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;
const REQUIRED_DICTIONARY_FILES = ['hash.table', 'bloom.filter', 'blobs.bin'] as const;
const HOSHIDICTS_MARKERS = ['.hoshidicts_3', '.hoshidicts_2', '.hoshidicts_1'] as const;
const JAPANESE_TEXT_PATTERN =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

interface RecommendedHoshidictsDictionary {
    id: HoshidictsRecommendedDictionaryId;
    indexUrl: string;
    downloadUrl: string;
}

export const RECOMMENDED_HOSHIDICTS_DICTIONARIES: readonly RecommendedHoshidictsDictionary[] =
    [
        {
            id: 'jmdict',
            indexUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english_without_proper_names.json',
            downloadUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english_without_proper_names.zip',
        },
        {
            id: 'jmnedict',
            indexUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.json',
            downloadUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip',
        },
    ];

const SCHEDULE_INTERVALS: Record<Exclude<HoshidictsSchedule, 'off'>, number> = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
};

function emptyManifest(): PersistedManifest {
    return {
        version: MANIFEST_VERSION,
        featureEnabled: false,
        schedule: 'off',
        lastCheck: null,
        nextCheck: null,
        lastError: null,
        dictionaries: [],
    };
}

export function defaultHoshidictsMiningProfile(): HoshidictsMiningProfile {
    return {
        version: MINING_PROFILE_VERSION,
        enabled: true,
        deck: 'Default',
        model: '',
        fields: {
            expression: '',
            reading: '',
            definition: '',
            sentence: '',
            frequency: '',
            pitch: '',
        },
        tags: ['hoshidicts'],
        duplicatePolicy: 'prevent',
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeSchedule(value: unknown): HoshidictsSchedule {
    return value === 'daily' || value === 'weekly' || value === 'monthly'
        ? value
        : 'off';
}

function normalizeDate(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function normalizeOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeProfileString(
    value: unknown,
    label: string,
    fallback = ''
): string {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (
        typeof value !== 'string' ||
        value.length > 255 ||
        value.includes('\0')
    ) {
        throw new Error(`${label} is invalid.`);
    }
    return value.trim();
}

export function normalizeHoshidictsMiningProfile(
    value: unknown
): HoshidictsMiningProfile {
    if (!isRecord(value)) {
        throw new Error('Hoshidicts mining profile must be an object.');
    }
    if (
        value.version !== undefined &&
        value.version !== MINING_PROFILE_VERSION
    ) {
        throw new Error('Hoshidicts mining profile version is unsupported.');
    }
    const rawFields = value.fields ?? {};
    if (!isRecord(rawFields)) {
        throw new Error('Hoshidicts mining fields must be an object.');
    }
    const rawTags = value.tags ?? ['hoshidicts'];
    if (!Array.isArray(rawTags) || rawTags.length > 32) {
        throw new Error('Hoshidicts mining tags are invalid.');
    }
    const tags: string[] = [];
    const seenTags = new Set<string>();
    for (const rawTag of rawTags) {
        const tag = normalizeProfileString(
            rawTag,
            'Hoshidicts mining tag'
        );
        const key = tag.toLocaleLowerCase();
        if (tag && !seenTags.has(key)) {
            seenTags.add(key);
            tags.push(tag);
        }
    }
    if (
        value.duplicatePolicy !== undefined &&
        value.duplicatePolicy !== 'prevent' &&
        value.duplicatePolicy !== 'allow'
    ) {
        throw new Error('Hoshidicts duplicate policy is invalid.');
    }
    const duplicatePolicy =
        value.duplicatePolicy === 'allow' ? 'allow' : 'prevent';
    return {
        version: MINING_PROFILE_VERSION,
        enabled: value.enabled !== false,
        deck:
            normalizeProfileString(
                value.deck,
                'Hoshidicts mining deck',
                'Default'
            ) || 'Default',
        model: normalizeProfileString(
            value.model,
            'Hoshidicts mining note type'
        ),
        fields: {
            expression: normalizeProfileString(
                rawFields.expression,
                'Hoshidicts expression field'
            ),
            reading: normalizeProfileString(
                rawFields.reading,
                'Hoshidicts reading field'
            ),
            definition: normalizeProfileString(
                rawFields.definition,
                'Hoshidicts definition field'
            ),
            sentence: normalizeProfileString(
                rawFields.sentence,
                'Hoshidicts sentence field'
            ),
            frequency: normalizeProfileString(
                rawFields.frequency,
                'Hoshidicts frequency field'
            ),
            pitch: normalizeProfileString(
                rawFields.pitch,
                'Hoshidicts pitch field'
            ),
        },
        tags,
        duplicatePolicy,
    };
}

function normalizeRelativePath(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
        throw new Error('Dictionary manifest path is empty or too long.');
    }
    const normalized = value.replaceAll('\\', '/');
    const components = normalized.split('/');
    if (
        path.posix.isAbsolute(normalized) ||
        components.some(
            (component) => component.length === 0 || component === '.' || component === '..'
        )
    ) {
        throw new Error(`Dictionary manifest path is not a normalized relative path: ${value}`);
    }
    return components.join('/');
}

function dictionaryDirectoryName(title: string): string {
    if (
        title.length === 0 ||
        title.length > 255 ||
        title === '.' ||
        title === '..' ||
        title.includes('/') ||
        title.includes('\\') ||
        path.isAbsolute(title) ||
        path.win32.isAbsolute(title)
    ) {
        throw new Error('Dictionary title cannot be used as a directory name.');
    }
    return title;
}

function parseHttpsUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }
    try {
        const parsed = new URL(value.trim());
        if (
            parsed.protocol !== 'https:' ||
            parsed.username.length > 0 ||
            parsed.password.length > 0 ||
            parsed.hostname.length === 0
        ) {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function recommendedDictionaryStates(
    manifest: PersistedManifest
): HoshidictsRecommendedDictionaryState[] {
    return RECOMMENDED_HOSHIDICTS_DICTIONARIES.map((recommended) => ({
        id: recommended.id,
        installed: manifest.dictionaries.some(
            (dictionary) =>
                parseHttpsUrl(dictionary.indexUrl) === recommended.indexUrl
        ),
    }));
}

export function getHoshidictsScheduleIntervalMs(
    schedule: HoshidictsSchedule
): number | null {
    return schedule === 'off' ? null : SCHEDULE_INTERVALS[schedule];
}

export function getNextHoshidictsCheck(
    schedule: HoshidictsSchedule,
    lastCheck: string | null,
    now: Date
): string | null {
    const interval = getHoshidictsScheduleIntervalMs(schedule);
    if (interval === null) {
        return null;
    }
    if (!lastCheck) {
        return now.toISOString();
    }
    const previous = new Date(lastCheck);
    if (Number.isNaN(previous.getTime())) {
        return now.toISOString();
    }
    return new Date(previous.getTime() + interval).toISOString();
}

export function isHoshidictsCheckDue(
    schedule: HoshidictsSchedule,
    nextCheck: string | null,
    now: Date
): boolean {
    if (schedule === 'off') {
        return false;
    }
    if (!nextCheck) {
        return true;
    }
    const next = new Date(nextCheck);
    return Number.isNaN(next.getTime()) || next.getTime() <= now.getTime();
}

export function stableHoshidictsDictionaryId(title: string): string {
    return createHash('sha256').update(title.normalize('NFC'), 'utf8').digest('hex').slice(0, 32);
}

function installedAtFromIndex(index: GeneratedIndex, fallback: Date): string {
    if (index.importDate !== null && Number.isFinite(index.importDate)) {
        const imported = new Date(index.importDate);
        if (!Number.isNaN(imported.getTime())) {
            return imported.toISOString();
        }
    }
    return fallback.toISOString();
}

async function readGeneratedIndex(dictionaryPath: string): Promise<GeneratedIndex> {
    const indexPath = path.join(dictionaryPath, 'index.json');
    const stat = await fsp.stat(indexPath).catch((error) => {
        throw new Error(`Dictionary is missing generated index.json: ${errorMessage(error)}`);
    });
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MANIFEST_BYTES) {
        throw new Error('Dictionary generated index.json is empty, oversized, or not a file.');
    }
    const parsed: unknown = JSON.parse(
        (await fsp.readFile(indexPath, 'utf8')).replace(/^\uFEFF/, '')
    );
    if (!isRecord(parsed) || typeof parsed.title !== 'string' || !parsed.title.trim()) {
        throw new Error('Dictionary generated index.json has no title.');
    }
    const counts = isRecord(parsed.counts) ? parsed.counts : {};
    const terms = isRecord(counts.terms) ? counts.terms : {};
    const termCount =
        typeof terms.total === 'number' && Number.isFinite(terms.total)
            ? Math.max(0, Math.trunc(terms.total))
            : 0;
    return {
        title: parsed.title,
        revision: typeof parsed.revision === 'string' ? parsed.revision : '',
        isUpdatable: parsed.isUpdatable === true,
        indexUrl: normalizeOptionalString(parsed.indexUrl),
        downloadUrl: normalizeOptionalString(parsed.downloadUrl),
        sourceLanguage: normalizeOptionalString(parsed.sourceLanguage),
        termCount,
        importDate:
            typeof parsed.importDate === 'number' && Number.isFinite(parsed.importDate)
                ? parsed.importDate
                : null,
    };
}

async function validateNativeDictionaryFiles(dictionaryPath: string): Promise<void> {
    const markerChecks = await Promise.all(
        HOSHIDICTS_MARKERS.map(async (marker) => {
            try {
                return (await fsp.stat(path.join(dictionaryPath, marker))).isFile();
            } catch {
                return false;
            }
        })
    );
    if (!markerChecks.some(Boolean)) {
        throw new Error('Dictionary is missing a Hoshidicts format marker.');
    }

    for (const fileName of REQUIRED_DICTIONARY_FILES) {
        const filePath = path.join(dictionaryPath, fileName);
        const stat = await fsp.stat(filePath).catch((error) => {
            throw new Error(`Dictionary is missing ${fileName}: ${errorMessage(error)}`);
        });
        if (!stat.isFile() || stat.size === 0) {
            throw new Error(`Dictionary file ${fileName} is empty or not a file.`);
        }
    }
}

function dictionaryStateFromIndex(
    id: string,
    relativePath: string,
    enabled: boolean,
    index: GeneratedIndex,
    fallbackDate: Date
): PersistedDictionary {
    if (index.termCount === 0) {
        throw new Error(`Dictionary "${index.title}" does not contain term entries.`);
    }
    return {
        id,
        path: relativePath,
        enabled,
        title: index.title,
        revision: index.revision,
        isUpdatable: index.isUpdatable,
        indexUrl: index.indexUrl,
        downloadUrl: index.downloadUrl,
        language: index.sourceLanguage,
        termCount: index.termCount,
        installedAt: installedAtFromIndex(index, fallbackDate),
    };
}

async function readZipEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
    if (entry.uncompressedSize > maxBytes) {
        throw new Error(`Archive entry ${entry.fileName} is too large.`);
    }
    return await new Promise<Buffer>((resolve, reject) => {
        zip.openReadStream(entry, (openError, stream) => {
            if (openError || !stream) {
                reject(openError ?? new Error(`Could not open ${entry.fileName}.`));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxBytes) {
                    stream.destroy(new Error(`Archive entry ${entry.fileName} is too large.`));
                    return;
                }
                chunks.push(chunk);
            });
            stream.once('error', reject);
            stream.once('end', () => resolve(Buffer.concat(chunks)));
        });
    });
}

function openZip(archivePath: string): Promise<ZipFile> {
    return new Promise((resolve, reject) => {
        yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (error, zip) => {
            if (error || !zip) {
                reject(error ?? new Error('Could not open dictionary archive.'));
                return;
            }
            resolve(zip);
        });
    });
}

function termBankContainsJapanese(value: unknown): boolean {
    if (!Array.isArray(value)) {
        return false;
    }
    return value.some((entry) => {
        if (!Array.isArray(entry)) {
            return false;
        }
        return [entry[0], entry[1]].some(
            (term) => typeof term === 'string' && JAPANESE_TEXT_PATTERN.test(term)
        );
    });
}

export async function inspectHoshidictsArchive(
    archivePath: string
): Promise<ArchiveInspection> {
    const zip = await openZip(archivePath);
    return await new Promise<ArchiveInspection>((resolve, reject) => {
        let sourceLanguage: string | null = null;
        let foundIndex = false;
        let hasTermBank = false;
        let hasJapaneseTerm = false;
        let scannedTermBanks = 0;
        let settled = false;

        const fail = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            zip.close();
            reject(error);
        };

        zip.once('error', fail);
        zip.once('end', () => {
            if (settled) {
                return;
            }
            settled = true;
            if (!foundIndex) {
                reject(new Error('Dictionary archive does not contain index.json.'));
                return;
            }
            resolve({ sourceLanguage, hasTermBank, hasJapaneseTerm });
        });
        zip.on('entry', (entry: Entry) => {
            void (async () => {
                const normalizedName = entry.fileName.replaceAll('\\', '/');
                if (normalizedName === 'index.json') {
                    const contents = await readZipEntry(zip, entry, MAX_ARCHIVE_INDEX_BYTES);
                    const parsed: unknown = JSON.parse(
                        contents.toString('utf8').replace(/^\uFEFF/, '')
                    );
                    if (!isRecord(parsed)) {
                        throw new Error('Dictionary index.json must contain a JSON object.');
                    }
                    foundIndex = true;
                    sourceLanguage = normalizeOptionalString(parsed.sourceLanguage);
                } else if (/^term_bank_\d+\.json$/u.test(normalizedName)) {
                    hasTermBank = true;
                    if (
                        sourceLanguage === null &&
                        !hasJapaneseTerm &&
                        scannedTermBanks < MAX_SCANNED_TERM_BANKS &&
                        entry.uncompressedSize <= MAX_TERM_BANK_BYTES
                    ) {
                        scannedTermBanks += 1;
                        const contents = await readZipEntry(zip, entry, MAX_TERM_BANK_BYTES);
                        const parsed: unknown = JSON.parse(
                            contents.toString('utf8').replace(/^\uFEFF/, '')
                        );
                        hasJapaneseTerm = termBankContainsJapanese(parsed);
                    }
                }
                zip.readEntry();
            })().catch(fail);
        });
        zip.readEntry();
    });
}

function parseImportReport(stdout: string): HoshidictsImportReport {
    const line = stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .at(-1);
    if (!line) {
        throw new Error('Hoshidicts importer did not emit a JSON result.');
    }
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
        throw new Error('Hoshidicts importer emitted an invalid JSON result.');
    }
    return {
        success: parsed.success === true,
        title: typeof parsed.title === 'string' ? parsed.title : '',
        termCount:
            typeof parsed.termCount === 'number' && Number.isFinite(parsed.termCount)
                ? Math.max(0, Math.trunc(parsed.termCount))
                : 0,
        error: typeof parsed.error === 'string' ? parsed.error : '',
    };
}

export async function runHoshidictsImport(
    archivePath: string,
    outputDir: string
): Promise<HoshidictsImportReport> {
    const executable = resolveInputServerExecutable();
    if (!executable) {
        throw new Error('The bundled Hoshidicts importer is not available.');
    }

    return await new Promise<HoshidictsImportReport>((resolve, reject) => {
        const child = spawn(
            executable,
            [
                'hoshidicts-import',
                '--archive',
                archivePath,
                '--output-dir',
                outputDir,
            ],
            {
                detached: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
            }
        );
        let stdout = '';
        let stderr = '';
        let exceededOutputLimit = false;
        const append = (current: string, chunk: Buffer): string => {
            const next = current + chunk.toString('utf8');
            if (Buffer.byteLength(next, 'utf8') > MAX_IMPORT_OUTPUT_BYTES) {
                exceededOutputLimit = true;
                child.kill();
            }
            return next;
        };
        child.stdout.on('data', (chunk: Buffer) => {
            stdout = append(stdout, chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = append(stderr, chunk);
        });
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('Hoshidicts import timed out.'));
        }, IMPORT_TIMEOUT_MS);
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            if (exceededOutputLimit) {
                reject(new Error('Hoshidicts importer output exceeded its size limit.'));
                return;
            }
            try {
                const report = parseImportReport(stdout);
                if (code !== 0 && report.success) {
                    reject(
                        new Error(
                            stderr.trim() ||
                                `Hoshidicts importer exited with code ${String(code)}.`
                        )
                    );
                    return;
                }
                resolve(report);
            } catch (error) {
                reject(
                    new Error(
                        stderr.trim() ||
                            `Could not read Hoshidicts import result: ${errorMessage(error)}`
                    )
                );
            }
        });
    });
}

export async function reloadHoshidictsNativeState(): Promise<number> {
    const requestId = `desktop-reload-${randomUUID()}`;
    const url = `ws://127.0.0.1:${DEFAULT_INPUT_SERVER_PORT}`;
    return await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(url);
        let settled = false;
        const finish = (error: Error | null, dictionaryCount = 0) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            socket.close();
            if (error) {
                reject(error);
            } else {
                resolve(dictionaryCount);
            }
        };
        const timeout = setTimeout(
            () => finish(new Error('Timed out reloading native Hoshidicts state.')),
            RELOAD_TIMEOUT_MS
        );
        socket.once('open', () => {
            socket.send(
                JSON.stringify({
                    type: 'configure_features',
                    features: ['hoshidicts'],
                })
            );
            socket.send(
                JSON.stringify({
                    type: 'hoshidicts_reload',
                    requestId,
                })
            );
        });
        socket.on('message', (data) => {
            try {
                const parsed: unknown = JSON.parse(data.toString());
                if (
                    !isRecord(parsed) ||
                    parsed.type !== 'hoshidicts_reload_result' ||
                    parsed.requestId !== requestId
                ) {
                    return;
                }
                if (parsed.success !== true) {
                    finish(
                        new Error(
                            typeof parsed.error === 'string'
                                ? parsed.error
                                : 'Native Hoshidicts reload failed.'
                        )
                    );
                    return;
                }
                finish(
                    null,
                    typeof parsed.dictionaryCount === 'number'
                        ? Math.max(0, Math.trunc(parsed.dictionaryCount))
                        : 0
                );
            } catch {
                // Other service messages are unrelated to this correlated reload.
            }
        });
        socket.once('error', (error) => finish(error));
        socket.once('close', () => {
            if (!settled) {
                finish(new Error('Input service closed before Hoshidicts reload completed.'));
            }
        });
    });
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
    if (!response.body) {
        throw new Error('HTTP response did not contain a body.');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error('HTTP response exceeded its size limit.');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            return Buffer.concat(chunks);
        }
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw new Error('HTTP response exceeded its size limit.');
        }
        chunks.push(Buffer.from(value));
    }
}

export async function fetchHoshidictsRemoteIndex(
    url: string
): Promise<HoshidictsRemoteIndex> {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
        throw new Error(`Dictionary index request failed with HTTP ${response.status}.`);
    }
    if (!parseHttpsUrl(response.url)) {
        throw new Error('Dictionary index redirected to a non-HTTPS URL.');
    }
    const parsed: unknown = JSON.parse(
        (await readResponseBytes(response, MAX_REMOTE_INDEX_BYTES))
            .toString('utf8')
            .replace(/^\uFEFF/, '')
    );
    if (!isRecord(parsed) || typeof parsed.revision !== 'string') {
        throw new Error('Dictionary update index has no string revision.');
    }
    return {
        revision: parsed.revision,
        downloadUrl: normalizeOptionalString(parsed.downloadUrl),
    };
}

export async function downloadHoshidictsArchive(
    url: string,
    outputPath: string
): Promise<void> {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!response.ok || !response.body) {
        throw new Error(`Dictionary download failed with HTTP ${response.status}.`);
    }
    if (!parseHttpsUrl(response.url)) {
        throw new Error('Dictionary download redirected to a non-HTTPS URL.');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new Error('Dictionary archive exceeded its size limit.');
    }

    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    try {
        const handle = await fsp.open(outputPath, 'wx');
        const reader = response.body.getReader();
        let size = 0;
        let position = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                size += value.byteLength;
                if (size > MAX_DOWNLOAD_BYTES) {
                    await reader.cancel();
                    throw new Error('Dictionary archive exceeded its size limit.');
                }
                await handle.write(value, 0, value.byteLength, position);
                position += value.byteLength;
            }
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        await fsp.rm(outputPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

function defaultDependencies(): HoshidictsManagerDependencies {
    return {
        now: () => new Date(),
        randomId: randomUUID,
        inspectArchive: inspectHoshidictsArchive,
        runImport: runHoshidictsImport,
        reloadNative: reloadHoshidictsNativeState,
        fetchRemoteIndex: fetchHoshidictsRemoteIndex,
        downloadArchive: downloadHoshidictsArchive,
        setInterval,
        clearInterval,
        schedulerIntervalMs: SCHEDULER_INTERVAL_MS,
    };
}

type SnapshotListener = (snapshot: HoshidictsManagerSnapshot) => void;

export class HoshidictsManager {
    readonly rootDir: string;
    readonly manifestPath: string;
    readonly miningProfilePath: string;

    private readonly deps: HoshidictsManagerDependencies;
    private operationQueue: Promise<void> = Promise.resolve();
    private progress: HoshidictsProgress = { phase: 'idle' };
    private runtimeError: string | null = null;
    private listeners = new Set<SnapshotListener>();
    private schedulerTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        baseDir = getBaseDir(),
        dependencies: Partial<HoshidictsManagerDependencies> = {}
    ) {
        this.rootDir = path.join(baseDir, 'dictionaries', 'hoshidicts');
        this.manifestPath = path.join(this.rootDir, MANIFEST_FILE_NAME);
        this.miningProfilePath = path.join(
            this.rootDir,
            HOSHIDICTS_MINING_PROFILE_FILE_NAME
        );
        this.deps = { ...defaultDependencies(), ...dependencies };
    }

    subscribe(listener: SnapshotListener): () => void {
        this.listeners.add(listener);
        void this.getSnapshot().then(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async getSnapshot(): Promise<HoshidictsManagerSnapshot> {
        let manifest: PersistedManifest;
        try {
            manifest = await this.readManifest();
        } catch (error) {
            return {
                featureEnabled: false,
                dictionaries: [],
                recommendedDictionaries:
                    RECOMMENDED_HOSHIDICTS_DICTIONARIES.map(({ id }) => ({
                        id,
                        installed: false,
                    })),
                miningProfile: defaultHoshidictsMiningProfile(),
                schedule: 'off',
                lastCheck: null,
                nextCheck: null,
                lastError: this.runtimeError ?? errorMessage(error),
                busy: this.progress.phase !== 'idle',
                progress: { ...this.progress },
            };
        }
        let miningProfile = defaultHoshidictsMiningProfile();
        let profileError: string | null = null;
        try {
            miningProfile = await this.readMiningProfile();
        } catch (error) {
            profileError = errorMessage(error);
        }
        return this.snapshotFromManifest(
            manifest,
            miningProfile,
            profileError
        );
    }

    async initializeFeatureState(
        legacyFeatureEnabled: boolean
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const raw = await this.readManifestRaw();
            if (raw !== null) {
                const parsed: unknown = JSON.parse(
                    raw.toString('utf8').replace(/^\uFEFF/, '')
                );
                if (
                    isRecord(parsed) &&
                    typeof parsed.featureEnabled === 'boolean'
                ) {
                    return;
                }
            }

            const manifest = await this.readManifest();
            await this.atomicWriteManifest({
                ...manifest,
                featureEnabled: legacyFeatureEnabled,
            });
        });
        return await this.getSnapshot();
    }

    async setFeatureEnabled(enabled: boolean): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            if (manifest.featureEnabled === enabled) {
                return;
            }
            await this.atomicWriteManifest({
                ...manifest,
                featureEnabled: enabled,
            });
        });
        return await this.getSnapshot();
    }

    async importDictionary(archivePath: string): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('importing', async () => {
            const manifest = await this.readManifest();
            const staged = await this.stageArchive(
                archivePath,
                manifest.dictionaries
            );
            try {
                await this.installStagedDictionary(manifest, staged);
            } catch (error) {
                await this.discardStagedDictionaryIfUnreferenced(staged);
                throw error;
            }
        });
        return await this.getSnapshot();
    }

    async installRecommendedDictionaries(): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('downloading', async () => {
            let manifest = await this.readManifest();
            for (
                let index = 0;
                index < RECOMMENDED_HOSHIDICTS_DICTIONARIES.length;
                index += 1
            ) {
                const recommended = RECOMMENDED_HOSHIDICTS_DICTIONARIES[index];
                const installed = manifest.dictionaries.some(
                    (dictionary) =>
                        parseHttpsUrl(dictionary.indexUrl) ===
                        recommended.indexUrl
                );
                if (installed) {
                    continue;
                }

                manifest = await this.installRecommendedDictionaryLocked(
                    manifest,
                    recommended,
                    index,
                    RECOMMENDED_HOSHIDICTS_DICTIONARIES.length
                );
            }
        });
        return await this.getSnapshot();
    }

    async installRecommendedDictionary(
        id: HoshidictsRecommendedDictionaryId
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('downloading', async () => {
            const recommended = RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
                (dictionary) => dictionary.id === id
            );
            if (!recommended) {
                throw new Error('Recommended dictionary id is invalid.');
            }
            const manifest = await this.readManifest();
            const installed = manifest.dictionaries.some(
                (dictionary) =>
                    parseHttpsUrl(dictionary.indexUrl) === recommended.indexUrl
            );
            if (!installed) {
                await this.installRecommendedDictionaryLocked(
                    manifest,
                    recommended,
                    0,
                    1
                );
            }
        });
        return await this.getSnapshot();
    }

    async removeDictionary(id: string): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('removing', async () => {
            if (!SAFE_ID_PATTERN.test(id)) {
                throw new Error('Dictionary id is invalid.');
            }
            const manifest = await this.readManifest();
            const existingIndex = manifest.dictionaries.findIndex(
                (dictionary) => dictionary.id === id
            );
            if (existingIndex < 0) {
                throw new Error('Dictionary is not installed.');
            }
            const existing = manifest.dictionaries[existingIndex];
            const next: PersistedManifest = {
                ...manifest,
                dictionaries: manifest.dictionaries.filter(
                    (dictionary) => dictionary.id !== id
                ),
            };
            await this.commitManifestChange(manifest, next, null, existing.path);
        });
        return await this.getSnapshot();
    }

    async setDictionaryEnabled(
        id: string,
        enabled: boolean
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            if (!SAFE_ID_PATTERN.test(id)) {
                throw new Error('Dictionary id is invalid.');
            }
            const manifest = await this.readManifest();
            const index = manifest.dictionaries.findIndex(
                (dictionary) => dictionary.id === id
            );
            if (index < 0) {
                throw new Error('Dictionary is not installed.');
            }
            if (manifest.dictionaries[index].enabled === enabled) {
                return;
            }
            const dictionaries = manifest.dictionaries.map((dictionary) => ({
                ...dictionary,
            }));
            dictionaries[index].enabled = enabled;
            await this.commitManifestChange(
                manifest,
                { ...manifest, dictionaries },
                null,
                null
            );
        });
        return await this.getSnapshot();
    }

    async moveDictionary(
        id: string,
        direction: -1 | 1
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            if (!SAFE_ID_PATTERN.test(id)) {
                throw new Error('Dictionary id is invalid.');
            }
            if (direction !== -1 && direction !== 1) {
                throw new Error('Dictionary move direction is invalid.');
            }
            const manifest = await this.readManifest();
            const currentIndex = manifest.dictionaries.findIndex(
                (dictionary) => dictionary.id === id
            );
            if (currentIndex < 0) {
                throw new Error('Dictionary is not installed.');
            }
            const targetIndex = currentIndex + direction;
            if (targetIndex < 0 || targetIndex >= manifest.dictionaries.length) {
                return;
            }
            const dictionaries = manifest.dictionaries.map((dictionary) => ({
                ...dictionary,
            }));
            const [dictionary] = dictionaries.splice(currentIndex, 1);
            dictionaries.splice(targetIndex, 0, dictionary);
            await this.commitManifestChange(
                manifest,
                { ...manifest, dictionaries },
                null,
                null
            );
        });
        return await this.getSnapshot();
    }

    async setSchedule(schedule: HoshidictsSchedule): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('checking', async () => {
            if (!['off', 'daily', 'weekly', 'monthly'].includes(schedule)) {
                throw new Error('Dictionary update schedule is invalid.');
            }
            const manifest = await this.readManifest();
            const next: PersistedManifest = {
                ...manifest,
                schedule,
                nextCheck: getNextHoshidictsCheck(
                    schedule,
                    manifest.lastCheck,
                    this.deps.now()
                ),
            };
            await this.atomicWriteManifest(next);
        });
        return await this.getSnapshot();
    }

    async setMiningProfile(value: unknown): Promise<HoshidictsManagerSnapshot> {
        const profile = normalizeHoshidictsMiningProfile(value);
        await this.enqueue('saving', async () => {
            await this.atomicWriteMiningProfile(profile);
        });
        return await this.getSnapshot();
    }

    async checkForUpdates(force = true): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('checking', async () => {
            let manifest = await this.readManifest();
            const now = this.deps.now();
            if (
                !force &&
                !isHoshidictsCheckDue(manifest.schedule, manifest.nextCheck, now)
            ) {
                return;
            }

            const candidates = manifest.dictionaries.filter(
                (dictionary) =>
                    dictionary.isUpdatable &&
                    parseHttpsUrl(dictionary.indexUrl) !== null &&
                    parseHttpsUrl(dictionary.downloadUrl) !== null
            );
            const errors: string[] = [];

            for (let index = 0; index < candidates.length; index += 1) {
                const currentCandidate = candidates[index];
                const current = manifest.dictionaries.find(
                    (dictionary) => dictionary.id === currentCandidate.id
                );
                if (!current) {
                    continue;
                }
                this.setProgress({
                    phase: 'checking',
                    title: current.title,
                    completed: index,
                    total: candidates.length,
                });
                try {
                    const indexUrl = parseHttpsUrl(current.indexUrl);
                    const localDownloadUrl = parseHttpsUrl(current.downloadUrl);
                    if (!indexUrl || !localDownloadUrl) {
                        continue;
                    }
                    const remote = await this.deps.fetchRemoteIndex(indexUrl);
                    if (remote.revision === current.revision) {
                        continue;
                    }
                    const downloadUrl =
                        remote.downloadUrl === null
                            ? localDownloadUrl
                            : parseHttpsUrl(remote.downloadUrl);
                    if (!downloadUrl) {
                        throw new Error('Update index returned a non-HTTPS download URL.');
                    }

                    const downloadRoot = path.join(
                        this.rootDir,
                        '.staging',
                        `download-${this.deps.randomId()}`
                    );
                    const archivePath = path.join(downloadRoot, 'dictionary.zip');
                    this.setProgress({
                        phase: 'downloading',
                        title: current.title,
                        completed: index,
                        total: candidates.length,
                    });
                    try {
                        await this.deps.downloadArchive(downloadUrl, archivePath);
                        const staged = await this.stageArchive(
                            archivePath,
                            manifest.dictionaries,
                            current.id
                        );
                        if (staged.dictionary.revision !== remote.revision) {
                            await this.discardStagedDictionary(staged);
                            throw new Error(
                                'Downloaded dictionary revision did not match its update index.'
                            );
                        }
                        try {
                            manifest = await this.installStagedDictionary(manifest, staged);
                        } catch (error) {
                            await this.discardStagedDictionaryIfUnreferenced(staged);
                            throw error;
                        }
                    } finally {
                        await fsp.rm(downloadRoot, { recursive: true, force: true });
                    }
                } catch (error) {
                    errors.push(`${current.title}: ${errorMessage(error)}`);
                }
            }

            const checkedAt = this.deps.now();
            manifest = {
                ...manifest,
                lastCheck: checkedAt.toISOString(),
                nextCheck: getNextHoshidictsCheck(
                    manifest.schedule,
                    checkedAt.toISOString(),
                    checkedAt
                ),
                lastError: errors.length > 0 ? errors.join('\n') : null,
            };
            await this.atomicWriteManifest(manifest);
            this.setProgress({
                phase: 'checking',
                completed: candidates.length,
                total: candidates.length,
            });
        });
        return await this.getSnapshot();
    }

    startScheduler(): void {
        if (this.schedulerTimer) {
            return;
        }
        void this.checkForUpdates(false).catch((error) => {
            console.warn('[Hoshidicts] Startup update check failed:', error);
        });
        this.schedulerTimer = this.deps.setInterval(() => {
            void this.checkForUpdates(false).catch((error) => {
                console.warn('[Hoshidicts] Scheduled update check failed:', error);
            });
        }, this.deps.schedulerIntervalMs);
        this.schedulerTimer.unref?.();
    }

    async stopScheduler(): Promise<void> {
        if (this.schedulerTimer) {
            this.deps.clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        }
        await this.waitForIdle();
    }

    async waitForIdle(): Promise<void> {
        await this.operationQueue;
    }

    private async enqueue<T>(
        initialPhase: HoshidictsProgressPhase,
        operation: () => Promise<T>
    ): Promise<T> {
        const run = this.operationQueue.then(async () => {
            this.runtimeError = null;
            this.setProgress({ phase: initialPhase });
            try {
                return await operation();
            } catch (error) {
                this.runtimeError = errorMessage(error);
                throw error;
            } finally {
                this.setProgress({ phase: 'idle' });
            }
        });
        this.operationQueue = run.then(
            () => undefined,
            () => undefined
        );
        return await run;
    }

    private setProgress(progress: HoshidictsProgress): void {
        this.progress = progress;
        this.emitSnapshot();
    }

    private emitSnapshot(): void {
        if (this.listeners.size === 0) {
            return;
        }
        void this.getSnapshot().then((snapshot) => {
            for (const listener of this.listeners) {
                listener(snapshot);
            }
        });
    }

    private snapshotFromManifest(
        manifest: PersistedManifest,
        miningProfile: HoshidictsMiningProfile,
        profileError: string | null = null
    ): HoshidictsManagerSnapshot {
        return {
            featureEnabled: manifest.featureEnabled,
            dictionaries: manifest.dictionaries.map(
                ({
                    id,
                    title,
                    enabled,
                    revision,
                    isUpdatable,
                    indexUrl,
                    downloadUrl,
                    language,
                    termCount,
                    installedAt,
                }) => ({
                    id,
                    title,
                    enabled,
                    revision,
                    isUpdatable,
                    indexUrl,
                    downloadUrl,
                    language,
                    termCount,
                    installedAt,
                })
            ),
            recommendedDictionaries: recommendedDictionaryStates(manifest),
            miningProfile,
            schedule: manifest.schedule,
            lastCheck: manifest.lastCheck,
            nextCheck: manifest.nextCheck,
            lastError: this.runtimeError ?? profileError ?? manifest.lastError,
            busy: this.progress.phase !== 'idle',
            progress: { ...this.progress },
        };
    }

    private async readMiningProfile(): Promise<HoshidictsMiningProfile> {
        let raw: string;
        try {
            const stat = await fsp.stat(this.miningProfilePath);
            if (
                !stat.isFile() ||
                stat.size === 0 ||
                stat.size > MAX_MINING_PROFILE_BYTES
            ) {
                throw new Error(
                    'Hoshidicts mining profile is empty, oversized, or not a file.'
                );
            }
            raw = await fsp.readFile(this.miningProfilePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return defaultHoshidictsMiningProfile();
            }
            throw error;
        }
        return normalizeHoshidictsMiningProfile(
            JSON.parse(raw.replace(/^\uFEFF/, ''))
        );
    }

    private async readManifest(): Promise<PersistedManifest> {
        let raw: string;
        try {
            const stat = await fsp.stat(this.manifestPath);
            if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MANIFEST_BYTES) {
                throw new Error('Hoshidicts manifest is empty, oversized, or not a file.');
            }
            raw = await fsp.readFile(this.manifestPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return emptyManifest();
            }
            throw error;
        }

        const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
        if (!isRecord(parsed) || parsed.version !== MANIFEST_VERSION) {
            throw new Error('Hoshidicts manifest has an unsupported version.');
        }
        if (!Array.isArray(parsed.dictionaries) || parsed.dictionaries.length > 256) {
            throw new Error('Hoshidicts manifest has an invalid dictionary list.');
        }

        const ids = new Set<string>();
        const paths = new Set<string>();
        const dictionaries: PersistedDictionary[] = [];
        for (const value of parsed.dictionaries) {
            if (!isRecord(value) || typeof value.id !== 'string' || !SAFE_ID_PATTERN.test(value.id)) {
                throw new Error('Hoshidicts manifest contains an invalid dictionary id.');
            }
            if (ids.has(value.id)) {
                throw new Error('Hoshidicts manifest contains a duplicate dictionary id.');
            }
            ids.add(value.id);
            const relativePath = normalizeRelativePath(value.path);
            if (paths.has(relativePath)) {
                throw new Error('Hoshidicts manifest contains a duplicate dictionary path.');
            }
            paths.add(relativePath);

            const dictionaryPath = path.join(this.rootDir, ...relativePath.split('/'));
            await validateNativeDictionaryFiles(dictionaryPath);
            const index = await readGeneratedIndex(dictionaryPath);
            dictionaries.push(
                dictionaryStateFromIndex(
                    value.id,
                    relativePath,
                    value.enabled !== false,
                    index,
                    this.deps.now()
                )
            );
        }

        return {
            version: MANIFEST_VERSION,
            featureEnabled: parsed.featureEnabled === true,
            schedule: normalizeSchedule(parsed.schedule),
            lastCheck: normalizeDate(parsed.lastCheck),
            nextCheck: normalizeDate(parsed.nextCheck),
            lastError: normalizeOptionalString(parsed.lastError),
            dictionaries,
        };
    }

    private async stageArchive(
        archivePath: string,
        installedDictionaries: PersistedDictionary[] = [],
        expectedId?: string
    ): Promise<StagedDictionary> {
        const inspection = await this.deps.inspectArchive(archivePath);
        const explicitLanguage = inspection.sourceLanguage?.toLowerCase() ?? null;
        if (explicitLanguage !== null && explicitLanguage !== 'ja') {
            throw new Error(
                `Dictionary source language must be ja, not ${inspection.sourceLanguage}.`
            );
        }
        if (!inspection.hasTermBank) {
            throw new Error('Dictionary archive does not contain term entries.');
        }
        if (explicitLanguage === null && !inspection.hasJapaneseTerm) {
            throw new Error(
                'Legacy dictionaries without sourceLanguage must contain Japanese terms.'
            );
        }

        const operationId = this.deps.randomId();
        const stagingRoot = path.join(this.rootDir, '.staging', `import-${operationId}`);
        const outputDir = path.join(stagingRoot, 'output');
        let finalGenerationRoot: string | null = null;
        try {
            await fsp.mkdir(outputDir, { recursive: true });
            const report = await this.deps.runImport(archivePath, outputDir);
            if (!report.success) {
                throw new Error(report.error || 'Hoshidicts import failed.');
            }
            if (!report.title || report.termCount === 0) {
                throw new Error('Dictionary archive does not contain term entries.');
            }
            const directoryName = dictionaryDirectoryName(report.title);
            const outputDictionaryPath = path.join(outputDir, directoryName);
            await validateNativeDictionaryFiles(outputDictionaryPath);
            const index = await readGeneratedIndex(outputDictionaryPath);
            if (index.title !== report.title) {
                throw new Error('Imported dictionary title did not match generated index.json.');
            }
            if (index.termCount === 0) {
                throw new Error('Dictionary archive does not contain term entries.');
            }
            const generatedLanguage = index.sourceLanguage?.toLowerCase() ?? null;
            if (generatedLanguage !== null && generatedLanguage !== 'ja') {
                throw new Error(
                    `Dictionary source language must be ja, not ${index.sourceLanguage}.`
                );
            }

            const generatedId = stableHoshidictsDictionaryId(index.title);
            const generatedIndexUrl = parseHttpsUrl(index.indexUrl);
            const existing = expectedId
                ? installedDictionaries.find(
                      (dictionary) => dictionary.id === expectedId
                  )
                : generatedIndexUrl
                  ? installedDictionaries.find(
                        (dictionary) =>
                            parseHttpsUrl(dictionary.indexUrl) ===
                            generatedIndexUrl
                    )
                  : undefined;
            if (expectedId && !existing) {
                throw new Error('Updated dictionary is not installed.');
            }
            if (existing) {
                const existingIndexUrl = parseHttpsUrl(existing.indexUrl);
                const sameDictionary =
                    existingIndexUrl !== null
                        ? generatedIndexUrl === existingIndexUrl
                        : generatedId === existing.id;
                if (!sameDictionary) {
                    throw new Error(
                        'Updated archive does not match the installed dictionary.'
                    );
                }
            }
            const id = existing?.id ?? generatedId;
            const generation = `${this.deps.now().getTime().toString(36)}-${operationId}`;
            const relativePath = path.posix.join(
                'generations',
                id,
                generation,
                directoryName
            );
            finalGenerationRoot = path.join(
                this.rootDir,
                'generations',
                id,
                generation
            );
            const finalDictionaryPath = path.join(finalGenerationRoot, directoryName);
            await fsp.mkdir(finalGenerationRoot, { recursive: true });
            await fsp.rename(outputDictionaryPath, finalDictionaryPath);
            const dictionary = dictionaryStateFromIndex(
                id,
                relativePath,
                true,
                index,
                this.deps.now()
            );
            return { dictionary, generationRoot: finalGenerationRoot };
        } catch (error) {
            if (finalGenerationRoot) {
                await fsp.rm(finalGenerationRoot, { recursive: true, force: true });
            }
            throw error;
        } finally {
            await fsp.rm(stagingRoot, { recursive: true, force: true });
        }
    }

    private async installStagedDictionary(
        manifest: PersistedManifest,
        staged: StagedDictionary
    ): Promise<PersistedManifest> {
        const existingIndex = manifest.dictionaries.findIndex(
            (dictionary) => dictionary.id === staged.dictionary.id
        );
        const dictionaries = manifest.dictionaries.map((dictionary) => ({ ...dictionary }));
        let oldPath: string | null = null;
        if (existingIndex >= 0) {
            oldPath = dictionaries[existingIndex].path;
            dictionaries[existingIndex] = {
                ...staged.dictionary,
                enabled: dictionaries[existingIndex].enabled,
            };
        } else {
            dictionaries.push(staged.dictionary);
        }
        const next: PersistedManifest = { ...manifest, dictionaries };
        await this.commitManifestChange(
            manifest,
            next,
            staged.generationRoot,
            oldPath
        );
        return next;
    }

    private async installRecommendedDictionaryLocked(
        manifest: PersistedManifest,
        recommended: RecommendedHoshidictsDictionary,
        completed: number,
        total: number
    ): Promise<PersistedManifest> {
        this.setProgress({
            phase: 'downloading',
            title: recommended.id,
            completed,
            total,
        });
        const downloadRoot = path.join(
            this.rootDir,
            '.staging',
            `recommended-${this.deps.randomId()}`
        );
        const archivePath = path.join(downloadRoot, `${recommended.id}.zip`);
        try {
            await this.deps.downloadArchive(
                recommended.downloadUrl,
                archivePath
            );
            this.setProgress({
                phase: 'importing',
                title: recommended.id,
                completed,
                total,
            });
            const staged = await this.stageArchive(
                archivePath,
                manifest.dictionaries
            );
            if (
                parseHttpsUrl(staged.dictionary.indexUrl) !==
                recommended.indexUrl
            ) {
                await this.discardStagedDictionary(staged);
                throw new Error(
                    `Downloaded ${recommended.id} archive did not match its trusted update URL.`
                );
            }
            try {
                return await this.installStagedDictionary(manifest, staged);
            } catch (error) {
                await this.discardStagedDictionaryIfUnreferenced(staged);
                throw error;
            }
        } finally {
            await fsp.rm(downloadRoot, {
                recursive: true,
                force: true,
            });
        }
    }

    private async commitManifestChange(
        previous: PersistedManifest,
        next: PersistedManifest,
        newGenerationRoot: string | null,
        oldDictionaryPath: string | null
    ): Promise<void> {
        const previousRaw = await this.readManifestRaw();
        await this.atomicWriteManifest(next);
        this.setProgress({ phase: 'reloading' });
        try {
            await this.deps.reloadNative();
        } catch (reloadError) {
            let rollbackError: unknown = null;
            let rollbackManifestRestored = false;
            try {
                await this.restoreManifest(previousRaw, previous);
                rollbackManifestRestored = true;
                await this.deps.reloadNative();
            } catch (error) {
                rollbackError = error;
            }
            if (newGenerationRoot && rollbackManifestRestored) {
                await fsp.rm(newGenerationRoot, { recursive: true, force: true });
            }
            if (!rollbackManifestRestored) {
                throw new Error(
                    `Native Hoshidicts reload failed and manifest rollback failed: ${errorMessage(
                        reloadError
                    )}. The new dictionary generation was retained for recovery. Rollback error: ${errorMessage(
                        rollbackError
                    )}`
                );
            }
            const suffix = rollbackError
                ? ` Native rollback reload also failed: ${errorMessage(rollbackError)}.`
                : '';
            throw new Error(
                `Native Hoshidicts reload failed; the previous dictionaries were restored: ${errorMessage(
                    reloadError
                )}.${suffix}`
            );
        }

        if (oldDictionaryPath) {
            await this.removeGenerationForDictionaryPath(oldDictionaryPath);
        }
    }

    private async discardStagedDictionary(staged: StagedDictionary): Promise<void> {
        await fsp.rm(staged.generationRoot, { recursive: true, force: true });
    }

    private async discardStagedDictionaryIfUnreferenced(
        staged: StagedDictionary
    ): Promise<void> {
        try {
            const manifest = await this.readManifest();
            if (
                manifest.dictionaries.some(
                    (dictionary) => dictionary.path === staged.dictionary.path
                )
            ) {
                console.warn(
                    `[Hoshidicts] Retaining generation referenced by the manifest: ${staged.generationRoot}`
                );
                return;
            }
        } catch (error) {
            console.warn(
                `[Hoshidicts] Could not verify whether the failed import generation is referenced; retaining ${staged.generationRoot}:`,
                error
            );
            return;
        }
        await this.discardStagedDictionary(staged);
    }

    private async removeGenerationForDictionaryPath(relativePath: string): Promise<void> {
        const components = normalizeRelativePath(relativePath).split('/');
        if (components[0] !== 'generations' || components.length < 4) {
            return;
        }
        const generationRoot = path.join(this.rootDir, ...components.slice(0, 3));
        await fsp.rm(generationRoot, { recursive: true, force: true }).catch((error) => {
            console.warn(
                `[Hoshidicts] Could not clean old immutable generation ${generationRoot}:`,
                error
            );
        });
    }

    private async readManifestRaw(): Promise<Buffer | null> {
        try {
            return await fsp.readFile(this.manifestPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    private async restoreManifest(
        raw: Buffer | null,
        previous: PersistedManifest
    ): Promise<void> {
        if (raw === null) {
            await fsp.rm(this.manifestPath, { force: true });
            return;
        }
        await this.atomicWriteBuffer(raw);
        // Verify the restored bytes before asking native code to consume them.
        const restored = await this.readManifest();
        if (
            restored.dictionaries.length !== previous.dictionaries.length ||
            restored.dictionaries.some(
                (dictionary, index) =>
                    dictionary.id !== previous.dictionaries[index]?.id ||
                    dictionary.path !== previous.dictionaries[index]?.path
            )
        ) {
            throw new Error('Restored Hoshidicts manifest did not match prior state.');
        }
    }

    private async atomicWriteManifest(manifest: PersistedManifest): Promise<void> {
        const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        if (serialized.length > MAX_MANIFEST_BYTES) {
            throw new Error('Hoshidicts manifest exceeded its size limit.');
        }
        await this.atomicWriteBuffer(serialized);
    }

    private async atomicWriteMiningProfile(
        profile: HoshidictsMiningProfile
    ): Promise<void> {
        const serialized = Buffer.from(
            `${JSON.stringify(profile, null, 2)}\n`,
            'utf8'
        );
        if (serialized.length > MAX_MINING_PROFILE_BYTES) {
            throw new Error('Hoshidicts mining profile exceeded its size limit.');
        }
        await this.atomicWriteBuffer(
            serialized,
            this.miningProfilePath,
            '.mining-profile-'
        );
    }

    private async atomicWriteBuffer(
        contents: Buffer,
        destination = this.manifestPath,
        temporaryPrefix = '.manifest-'
    ): Promise<void> {
        await fsp.mkdir(this.rootDir, { recursive: true });
        const temporaryPath = path.join(
            this.rootDir,
            `${temporaryPrefix}${this.deps.randomId()}.tmp`
        );
        const handle = await fsp.open(temporaryPath, 'wx');
        try {
            await handle.writeFile(contents);
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await fsp.rename(temporaryPath, destination);
        } catch (error) {
            await fsp.rm(temporaryPath, { force: true });
            throw error;
        }
    }
}

let defaultManager: HoshidictsManager | null = null;

export function getHoshidictsManager(): HoshidictsManager {
    defaultManager ??= new HoshidictsManager();
    return defaultManager;
}

export async function startHoshidictsManager(
    legacyFeatureEnabled = false
): Promise<void> {
    const manager = getHoshidictsManager();
    await manager.initializeFeatureState(legacyFeatureEnabled);
    manager.startScheduler();
}

export async function stopHoshidictsManager(): Promise<void> {
    if (defaultManager) {
        await defaultManager.stopScheduler();
    }
}
