import archiver from 'archiver';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import parserStream from 'stream-json';
import Assembler from 'stream-json/assembler.js';
import type { Token } from 'stream-json/parser.js';

import {
    HOSHIDICTS_AUDIO_SOURCE_TYPES,
    HOSHIDICTS_DUPLICATE_BEHAVIORS,
    HOSHIDICTS_DUPLICATE_SCOPES,
    HOSHIDICTS_FIELD_OVERWRITE_MODES,
    MAX_HOSHIDICTS_MAX_RESULTS,
    MAX_HOSHIDICTS_SCAN_LENGTH,
    MAX_HOSHIDICTS_AUDIO_SOURCES,
    MIN_HOSHIDICTS_MAX_RESULTS,
    MIN_HOSHIDICTS_SCAN_LENGTH,
    type HoshidictsActivationKey,
    type HoshidictsAudioProfile,
    type HoshidictsAudioSource,
    type HoshidictsAudioSourceType,
    type HoshidictsManagerSnapshot,
    type HoshidictsFieldOverwriteMode,
    type HoshidictsMiningFieldTemplates,
    type HoshidictsMiningProfile,
    type HoshidictsReaderPreferences,
    type HoshidictsYomitanDictionaryPreference,
    type HoshidictsYomitanSettingsGroup,
} from '../../../shared/features/hoshidicts.js';
import { normalizeHoshidictsAudioProfile } from './audio_profile.js';
import { createJsonScalarLimitTransform } from './json_scalar_limit.js';
import { normalizeHoshidictsMiningProfile } from './profile.js';

type JsonRecord = Record<string, unknown>;
type BankEntry = unknown[];
type BankKey = keyof YomitanDictionaryBanks;

const BANK_FILES: Array<[BankKey, string]> = [
    ['term', 'term_bank'],
    ['termMeta', 'term_meta_bank'],
    ['kanji', 'kanji_bank'],
    ['kanjiMeta', 'kanji_meta_bank'],
    ['tag', 'tag_bank'],
];
const MAX_BANK_ENTRIES = 1_000;
const MAX_BANK_BYTES = 32 * 1024 * 1024;
const MAX_JSON_VALUE_BYTES = 32 * 1024 * 1024;
const MAX_OPEN_SPOOL_FILES = 16;
const MAX_SPOOL_BUFFER_BYTES = 256 * 1024;
const MAX_NATIVE_ZIP_BYTES = 0xffff_ffff;
const MAX_NATIVE_MEDIA_PATH_BYTES = 0xffff;
const READ_PROGRESS_INTERVAL_MS = 250;
const MIN_ETA_ELAPSED_MS = 1_000;

interface YomitanDictionaryBanks {
    term: BankEntry[];
    termMeta: BankEntry[];
    kanji: BankEntry[];
    kanjiMeta: BankEntry[];
    tag: BankEntry[];
}

interface YomitanDictionarySummary {
    title: string;
    index: JsonRecord;
    styles: string;
}

export interface ParsedYomitanDictionary {
    title: string;
    index: JsonRecord;
    banks: YomitanDictionaryBanks;
    styles: string;
    media: Map<string, Buffer>;
}

export interface ParsedYomitanSettings {
    profileName: string | null;
    dictionaries: HoshidictsYomitanDictionaryPreference[];
    readerPreferences: HoshidictsReaderPreferences | null;
    miningProfile: HoshidictsMiningProfile | null;
    audioProfile: HoshidictsAudioProfile | null;
    groups: HoshidictsYomitanSettingsGroup[];
    warnings: string[];
}

export interface PreparedYomitanBackup {
    dictionaries: Array<{ title: string; archivePath: string }>;
    settings: ParsedYomitanSettings | null;
    cleanup: () => Promise<void>;
}

export interface YomitanDictionaryPreparationProgress {
    current: number;
    total: number;
    title: string;
}

export interface YomitanDictionaryReadingProgress {
    completedBytes: number;
    totalBytes: number;
    estimatedSecondsRemaining: number | null;
}

export interface YomitanPreparedDictionary {
    title: string;
    archivePath: string;
    current: number;
    total: number;
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function unwrapTypeson(value: unknown): unknown {
    if (isRecord(value) && '$' in value && '$types' in value) {
        return value.$;
    }
    return value;
}

function createReadingProgressReporter(
    totalBytes: number,
    onProgress: (progress: YomitanDictionaryReadingProgress) => void
): (completedBytes: number, force?: boolean) => void {
    const startedAt = Date.now();
    let lastReportedAt = startedAt;
    let lastCompletedBytes = -1;

    return (completedBytes, force = false) => {
        const boundedCompletedBytes = Math.max(
            0,
            Math.min(completedBytes, totalBytes)
        );
        const now = Date.now();
        if (
            boundedCompletedBytes === lastCompletedBytes ||
            (!force && now - lastReportedAt < READ_PROGRESS_INTERVAL_MS)
        ) {
            return;
        }

        const elapsedMs = now - startedAt;
        const estimatedSecondsRemaining =
            boundedCompletedBytes > 0 &&
            boundedCompletedBytes < totalBytes &&
            elapsedMs >= MIN_ETA_ELAPSED_MS
                ? Math.max(
                      1,
                      Math.ceil(
                          ((totalBytes - boundedCompletedBytes) * elapsedMs) /
                              boundedCompletedBytes /
                              1_000
                      )
                  )
                : null;
        onProgress({
            completedBytes: boundedCompletedBytes,
            totalBytes,
            estimatedSecondsRemaining,
        });
        lastReportedAt = now;
        lastCompletedBytes = boundedCompletedBytes;
    };
}

function createTrackedReadStream(
    filePath: string,
    onBytesRead?: (bytesRead: number) => void
): fs.ReadStream {
    const source = fs.createReadStream(filePath);
    if (onBytesRead) {
        const report = () => onBytesRead(source.bytesRead);
        source.on('data', report);
        source.once('close', () => source.off('data', report));
    }
    return source;
}

function exportRowValue(row: unknown, inbound: boolean): unknown {
    const unwrapped = unwrapTypeson(row);
    if (inbound) {
        return unwrapTypeson(unwrapped);
    }
    if (!Array.isArray(unwrapped) || unwrapped.length < 2) {
        return null;
    }
    return unwrapTypeson(unwrapped[1]);
}

function tableRows(root: JsonRecord): Array<{
    tableName: string;
    inbound: boolean;
    rows: unknown[];
}> {
    const data = isRecord(root.data) ? root.data : null;
    if (
        root.formatName !== 'dexie' ||
        root.formatVersion !== 1 ||
        data?.databaseName !== 'dict' ||
        !Array.isArray(data.data)
    ) {
        throw new Error('The selected file is not a Yomitan dictionary backup.');
    }
    return data.data.flatMap((value) => {
        if (!isRecord(value) || typeof value.tableName !== 'string' || !Array.isArray(value.rows)) {
            return [];
        }
        return [
            {
                tableName: value.tableName,
                inbound: value.inbound === true,
                rows: value.rows,
            },
        ];
    });
}

function copyIndexString(target: JsonRecord, source: JsonRecord, key: string): void {
    if (typeof source[key] === 'string' && source[key].length > 0) {
        target[key] = source[key];
    }
}

function dictionaryIndex(summary: JsonRecord): JsonRecord {
    const title = stringValue(summary.title);
    const index: JsonRecord = {
        title,
        revision: stringValue(summary.revision) || '1',
        format: 3,
        sequenced: summary.sequenced === true,
    };
    for (const key of [
        'author',
        'url',
        'description',
        'attribution',
        'sourceLanguage',
        'targetLanguage',
        'frequencyMode',
    ]) {
        copyIndexString(index, summary, key);
    }
    if (
        summary.isUpdatable === true &&
        typeof summary.indexUrl === 'string' &&
        typeof summary.downloadUrl === 'string'
    ) {
        index.isUpdatable = true;
        index.indexUrl = summary.indexUrl;
        index.downloadUrl = summary.downloadUrl;
    }
    return index;
}

function restoreImageDimensions(value: JsonRecord): JsonRecord {
    const result: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
        if (
            key === 'preferredWidth' ||
            key === 'preferredHeight' ||
            key === 'width' ||
            key === 'height'
        ) {
            continue;
        }
        result[key] = restoreGlossaryValue(item);
    }
    if (typeof value.preferredWidth === 'number') {
        result.width = value.preferredWidth;
    }
    if (typeof value.preferredHeight === 'number') {
        result.height = value.preferredHeight;
    }
    return result;
}

function restoreGlossaryValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(restoreGlossaryValue);
    }
    if (!isRecord(value)) {
        return value;
    }
    if (value.type === 'image' || value.tag === 'img') {
        return restoreImageDimensions(value);
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, restoreGlossaryValue(item)]),
    );
}

function emptyBanks(): YomitanDictionaryBanks {
    return { term: [], termMeta: [], kanji: [], kanjiMeta: [], tag: [] };
}

function mediaBuffer(value: unknown): Buffer | null {
    if (typeof value === 'string') {
        return Buffer.from(value, 'base64');
    }
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value);
    }
    return null;
}

function parseDictionarySummary(
    row: unknown,
    inbound: boolean
): YomitanDictionarySummary | null {
    const summary = exportRowValue(row, inbound);
    if (!isRecord(summary)) {
        return null;
    }
    const title = stringValue(summary.title);
    if (!title) {
        return null;
    }
    return {
        title,
        index: dictionaryIndex(summary),
        styles: stringValue(summary.styles),
    };
}

function addDictionarySummary(
    dictionaries: Map<string, ParsedYomitanDictionary>,
    row: unknown,
    inbound: boolean
): void {
    const summary = parseDictionarySummary(row, inbound);
    if (!summary) {
        return;
    }
    dictionaries.set(summary.title, {
        ...summary,
        banks: emptyBanks(),
        media: new Map(),
    });
}

type ParsedDictionaryRow =
    | {
          kind: 'bank';
          dictionary: string;
          bank: BankKey;
          entry: BankEntry;
      }
    | {
          kind: 'media';
          dictionary: string;
          mediaPath: string;
          content: Buffer;
      };

function parseDictionaryRow(
    tableName: string,
    row: unknown,
    inbound: boolean
): ParsedDictionaryRow | null {
    const item = exportRowValue(row, inbound);
    if (!isRecord(item)) {
        return null;
    }
    const dictionary = stringValue(item.dictionary);
    if (!dictionary) {
        return null;
    }
    switch (tableName) {
        case 'terms':
            return {
                kind: 'bank',
                dictionary,
                bank: 'term',
                entry: [
                    stringValue(item.expression),
                    stringValue(item.reading),
                    stringValue(item.definitionTags ?? item.tags),
                    stringValue(item.rules),
                    typeof item.score === 'number' ? item.score : 0,
                    Array.isArray(item.glossary)
                        ? restoreGlossaryValue(item.glossary)
                        : [],
                    typeof item.sequence === 'number' ? item.sequence : -1,
                    stringValue(item.termTags),
                ],
            };
        case 'termMeta':
            return {
                kind: 'bank',
                dictionary,
                bank: 'termMeta',
                entry: [
                    stringValue(item.expression),
                    stringValue(item.mode),
                    item.data,
                ],
            };
        case 'kanji':
            return {
                kind: 'bank',
                dictionary,
                bank: 'kanji',
                entry: [
                    stringValue(item.character),
                    stringValue(item.onyomi),
                    stringValue(item.kunyomi),
                    stringValue(item.tags),
                    Array.isArray(item.meanings) ? item.meanings : [],
                    isRecord(item.stats) ? item.stats : {},
                ],
            };
        case 'kanjiMeta':
            return {
                kind: 'bank',
                dictionary,
                bank: 'kanjiMeta',
                entry: [
                    stringValue(item.character),
                    stringValue(item.mode),
                    item.data,
                ],
            };
        case 'tagMeta':
            return {
                kind: 'bank',
                dictionary,
                bank: 'tag',
                entry: [
                    stringValue(item.name),
                    stringValue(item.category),
                    typeof item.order === 'number' ? item.order : 0,
                    stringValue(item.notes),
                    typeof item.score === 'number' ? item.score : 0,
                ],
            };
        case 'media': {
            const content = mediaBuffer(item.content);
            const mediaPath = stringValue(item.path);
            if (content && mediaPath) {
                return {
                    kind: 'media',
                    dictionary,
                    mediaPath,
                    content,
                };
            }
            return null;
        }
        default:
            return null;
    }
}

function addDictionaryRow(
    dictionaries: Map<string, ParsedYomitanDictionary>,
    tableName: string,
    row: unknown,
    inbound: boolean
): void {
    const parsed = parseDictionaryRow(tableName, row, inbound);
    if (!parsed) {
        return;
    }
    const dictionary = dictionaries.get(parsed.dictionary);
    if (!dictionary) {
        return;
    }
    if (parsed.kind === 'bank') {
        dictionary.banks[parsed.bank].push(parsed.entry);
    } else {
        dictionary.media.set(parsed.mediaPath, parsed.content);
    }
}

export function parseYomitanDictionaryBackup(value: unknown): ParsedYomitanDictionary[] {
    if (!isRecord(value)) {
        throw new Error('The selected file is not a Yomitan dictionary backup.');
    }
    const tables = tableRows(value);
    const dictionaries = new Map<string, ParsedYomitanDictionary>();
    for (const table of tables) {
        if (table.tableName !== 'dictionaries') {
            continue;
        }
        for (const row of table.rows) {
            addDictionarySummary(dictionaries, row, table.inbound);
        }
    }
    if (dictionaries.size === 0) {
        throw new Error('The Yomitan backup does not contain dictionaries.');
    }

    for (const table of tables) {
        if (table.tableName === 'dictionaries') {
            continue;
        }
        for (const row of table.rows) {
            addDictionaryRow(dictionaries, table.tableName, row, table.inbound);
        }
    }
    return [...dictionaries.values()];
}

interface DictionaryBackupSignature {
    formatName: string;
    formatVersion: number | null;
    databaseName: string;
}

function isTableContext(assembler: Assembler): boolean {
    return (
        assembler.depth === 4 &&
        assembler.stack[1] === 'data' &&
        assembler.stack[3] === 'data' &&
        Array.isArray(assembler.stack[4])
    );
}

function isRowContext(assembler: Assembler): boolean {
    return (
        assembler.depth === 6 &&
        assembler.stack[1] === 'data' &&
        assembler.stack[3] === 'data' &&
        Array.isArray(assembler.stack[4]) &&
        assembler.stack[7] === 'rows' &&
        Array.isArray(assembler.stack[8])
    );
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
    return (
        typeof value === 'object' &&
        value !== null &&
        'then' in value &&
        typeof value.then === 'function'
    );
}

function continueWith<T>(
    value: T | PromiseLike<T>,
    continuation: (resolved: T) => void | PromiseLike<void>
): void | Promise<void> {
    if (!isPromiseLike<T>(value)) {
        const result = continuation(value);
        return isPromiseLike<void>(result) ? Promise.resolve(result) : undefined;
    }
    return Promise.resolve(value).then(continuation);
}

async function streamDictionaryRows(
    source: Readable,
    onRow: (
        tableName: string,
        inbound: boolean,
        row: unknown
    ) => void | Promise<void>
): Promise<DictionaryBackupSignature> {
    const scalarLimit = createJsonScalarLimitTransform(MAX_JSON_VALUE_BYTES);
    const tokens = parserStream({
        streamKeys: false,
        packKeys: true,
        streamStrings: false,
        packStrings: true,
        streamNumbers: false,
        packNumbers: true,
    });
    const assembler = new Assembler();
    const signature: DictionaryBackupSignature = {
        formatName: '',
        formatVersion: null,
        databaseName: '',
    };
    let tableName = '';
    let inbound = false;
    let pendingRow: PromiseLike<void> | null = null;
    let tokensEnded = false;

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let failure: { reason: unknown } | null = null;
        const finish = (): void => {
            if (settled || pendingRow) {
                return;
            }
            if (failure) {
                settled = true;
                reject(failure.reason);
                return;
            }
            if (!tokensEnded) {
                return;
            }
            settled = true;
            resolve();
        };
        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            if (!failure) {
                failure = { reason: error };
                source.unpipe(scalarLimit);
                scalarLimit.unpipe(tokens);
                source.destroy();
                scalarLimit.destroy();
                tokens.destroy();
            }
            finish();
        };
        const clearCompletedRow = (): void => {
            if (Array.isArray(assembler.current)) {
                assembler.current.length = 0;
            }
        };
        const consume = (rawToken: unknown): void | PromiseLike<void> => {
            const token = rawToken as Token;
            const currentKey = assembler.key;
            if (token.name === 'stringValue') {
                if (assembler.depth === 1 && currentKey === 'formatName') {
                    signature.formatName = token.value;
                } else if (
                    assembler.depth === 2 &&
                    assembler.stack[1] === 'data' &&
                    currentKey === 'databaseName'
                ) {
                    signature.databaseName = token.value;
                } else if (isTableContext(assembler) && currentKey === 'tableName') {
                    tableName = token.value;
                }
            } else if (
                token.name === 'numberValue' &&
                assembler.depth === 1 &&
                currentKey === 'formatVersion'
            ) {
                signature.formatVersion = Number(token.value);
            } else if (
                (token.name === 'trueValue' || token.name === 'falseValue') &&
                isTableContext(assembler) &&
                currentKey === 'inbound'
            ) {
                inbound = token.name === 'trueValue';
            }

            if (
                (token.name === 'endObject' || token.name === 'endArray') &&
                isRowContext(assembler)
            ) {
                const row = assembler.current;
                assembler.consume(token);
                const result = onRow(tableName, inbound, row);
                if (isPromiseLike<void>(result)) {
                    return Promise.resolve(result).then(clearCompletedRow);
                }
                clearCompletedRow();
                return;
            }

            const closingTable =
                token.name === 'endObject' && isTableContext(assembler);
            assembler.consume(token);
            if (closingTable) {
                if (Array.isArray(assembler.current)) {
                    assembler.current.length = 0;
                }
                tableName = '';
                inbound = false;
            }
        };

        source.once('error', fail);
        scalarLimit.once('error', fail);
        tokens.once('error', fail);
        tokens.on('data', (token: unknown) => {
            if (settled || failure) {
                return;
            }
            try {
                const result = consume(token);
                if (!isPromiseLike<void>(result)) {
                    return;
                }
                tokens.pause();
                pendingRow = result;
                void Promise.resolve(result).then(
                    () => {
                        pendingRow = null;
                        if (settled) {
                            return;
                        }
                        if (tokensEnded || failure) {
                            finish();
                        } else {
                            tokens.resume();
                        }
                    },
                    (error) => {
                        pendingRow = null;
                        fail(error);
                    }
                );
            } catch (error) {
                fail(error);
            }
        });
        tokens.once('end', () => {
            tokensEnded = true;
            finish();
        });
        source.pipe(scalarLimit).pipe(tokens);
    });
    if (
        signature.formatName !== 'dexie' ||
        signature.formatVersion !== 1 ||
        signature.databaseName !== 'dict'
    ) {
        throw new Error('The selected file is not a Yomitan dictionary backup.');
    }
    return signature;
}

export async function parseYomitanDictionaryBackupStream(
    createSource: () => Readable
): Promise<ParsedYomitanDictionary[]> {
    const dictionaries = new Map<string, ParsedYomitanDictionary>();
    const summarized = new Set<string>();
    const result: ParsedYomitanDictionary[] = [];
    await streamDictionaryRows(createSource(), (tableName, inbound, row) => {
        if (tableName === 'dictionaries') {
            const summary = parseDictionarySummary(row, inbound);
            if (!summary) {
                return;
            }
            let dictionary = dictionaries.get(summary.title);
            if (dictionary) {
                dictionary.index = summary.index;
                dictionary.styles = summary.styles;
            } else {
                dictionary = {
                    ...summary,
                    banks: emptyBanks(),
                    media: new Map(),
                };
                dictionaries.set(summary.title, dictionary);
            }
            if (!summarized.has(summary.title)) {
                summarized.add(summary.title);
                result.push(dictionary);
            }
            return;
        }
        const parsed = parseDictionaryRow(tableName, row, inbound);
        if (!parsed) {
            return;
        }
        let dictionary = dictionaries.get(parsed.dictionary);
        if (!dictionary) {
            dictionary = {
                title: parsed.dictionary,
                index: {},
                banks: emptyBanks(),
                styles: '',
                media: new Map(),
            };
            dictionaries.set(parsed.dictionary, dictionary);
        }
        if (parsed.kind === 'bank') {
            dictionary.banks[parsed.bank].push(parsed.entry);
        } else {
            dictionary.media.set(parsed.mediaPath, parsed.content);
        }
    });
    if (result.length === 0) {
        throw new Error('The Yomitan backup does not contain dictionaries.');
    }
    return result;
}

function templateValue(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    return isRecord(value) ? stringValue(value.value) : '';
}

function templateOverwriteMode(value: unknown): HoshidictsFieldOverwriteMode {
    const mode = isRecord(value) ? value.overwriteMode : undefined;
    return HOSHIDICTS_FIELD_OVERWRITE_MODES.includes(
        mode as HoshidictsFieldOverwriteMode
    )
        ? (mode as HoshidictsFieldOverwriteMode)
        : 'coalesce';
}

function miningProfile(anki: JsonRecord): HoshidictsMiningProfile | null {
    const modern = Array.isArray(anki.cardFormats)
        ? anki.cardFormats.find(
              (value) =>
                  isRecord(value) &&
                  value.type === 'term' &&
                  stringValue(value.deck).trim() &&
                  stringValue(value.model).trim(),
          )
        : null;
    const legacy = isRecord(anki.terms) ? anki.terms : null;
    const card = isRecord(modern) ? modern : legacy;
    if (!card) {
        return null;
    }
    const rawFields = isRecord(card.fields) ? card.fields : {};
    const fieldTemplates: HoshidictsMiningFieldTemplates = {};
    for (const [target, rawTemplate] of Object.entries(rawFields)) {
        fieldTemplates[target] = {
            value: templateValue(rawTemplate),
            overwriteMode: templateOverwriteMode(rawTemplate),
        };
    }
    const duplicateScope = HOSHIDICTS_DUPLICATE_SCOPES.includes(
        anki.duplicateScope as HoshidictsMiningProfile['duplicateScope']
    )
        ? (anki.duplicateScope as HoshidictsMiningProfile['duplicateScope'])
        : 'collection';
    const duplicateBehavior = HOSHIDICTS_DUPLICATE_BEHAVIORS.includes(
        anki.duplicateBehavior as HoshidictsMiningProfile['duplicateBehavior']
    )
        ? (anki.duplicateBehavior as HoshidictsMiningProfile['duplicateBehavior'])
        : 'new';
    return normalizeHoshidictsMiningProfile({
        version: 3,
        enabled: anki.enable === true,
        deck: stringValue(card.deck) || 'Default',
        model: stringValue(card.model),
        fieldTemplates,
        tags: Array.isArray(anki.tags)
            ? anki.tags.filter((value): value is string => typeof value === 'string')
            : [],
        checkForDuplicates: anki.checkForDuplicates !== false,
        duplicateScope,
        duplicateScopeCheckAllModels:
            anki.duplicateScopeCheckAllModels === true,
        duplicateBehavior,
    });
}

function audioProfile(audio: JsonRecord, warnings: string[]): HoshidictsAudioProfile {
    const sources: HoshidictsAudioSource[] = [];
    const supported = new Set<string>(HOSHIDICTS_AUDIO_SOURCE_TYPES);
    const rawSources = Array.isArray(audio.sources) ? audio.sources : [];
    for (let index = 0; index < rawSources.length; index += 1) {
        const raw = rawSources[index];
        if (!isRecord(raw) || typeof raw.type !== 'string') {
            continue;
        }
        if (!supported.has(raw.type)) {
            warnings.push(`Skipped unsupported Yomitan audio source: ${raw.type}.`);
            continue;
        }
        const type = raw.type as HoshidictsAudioSourceType;
        const isUrl = type === 'custom' || type === 'custom-json';
        const isTts = type === 'text-to-speech' || type === 'text-to-speech-reading';
        sources.push({
            id: `${type}-${index + 1}`,
            type,
            url: isUrl
                ? stringValue(raw.url).replaceAll('{expression}', '{term}')
                : '',
            voice: isTts ? stringValue(raw.voice) : '',
        });
    }
    if (audio.enableDefaultAudioSources === true) {
        for (const type of ['jpod101', 'language-pod-101', 'jisho'] as const) {
            if (!sources.some((source) => source.type === type)) {
                sources.push({ id: type, type, url: '', voice: '' });
            }
        }
    }
    return normalizeHoshidictsAudioProfile({
        version: 1,
        enabled: audio.enabled !== false,
        autoPlay: audio.autoPlay === true,
        volume: Number.isInteger(audio.volume) ? audio.volume : 100,
        sources: sources.slice(0, MAX_HOSHIDICTS_AUDIO_SOURCES),
    });
}

function currentReaderPreferences(current: HoshidictsManagerSnapshot): HoshidictsReaderPreferences {
    return {
        lookupMode: current.lookupMode,
        scanLength: current.scanLength,
        maxResults: current.maxResults,
        sortFrequencyDictionary: current.sortFrequencyDictionary,
        sortFrequencyDictionaryOrder: current.sortFrequencyDictionaryOrder,
        activationKey: current.activationKey,
        sourceHighlightEnabled: current.sourceHighlightEnabled,
        onlyScanJapaneseText: current.onlyScanJapaneseText,
        popupHideDelayMs: current.popupHideDelayMs,
        showLookupCounts: current.showLookupCounts,
        showCompactDefinitionSummary: current.showCompactDefinitionSummary,
        compactDefinitionSummaryDictionary:
            current.compactDefinitionSummaryDictionary,
        showPitchAccentFurigana: current.showPitchAccentFurigana,
        pitchAccentFuriganaDictionary:
            current.pitchAccentFuriganaDictionary,
        showPitchAccentBadge: current.showPitchAccentBadge,
        hidePopupGrammarTags: current.hidePopupGrammarTags,
        popupNestingMaxDepth: current.popupNestingMaxDepth,
        definitionBlur: { ...current.definitionBlur },
        popupWidthPx: current.popupWidthPx,
        popupHeightPx: current.popupHeightPx,
        popupColumns: current.popupColumns,
        theme: current.theme,
        popupOpacityPercent: current.popupOpacityPercent,
        popupToolbarPosition: current.popupToolbarPosition,
        popupButtons: {
            ...current.popupButtons,
            customLinks: current.popupButtons.customLinks.map((link) => ({
                ...link,
            })),
        },
        customPopupCss: current.customPopupCss,
    };
}

function readerPreferences(
    general: JsonRecord,
    scanning: JsonRecord,
    current: HoshidictsManagerSnapshot,
    dictionaryPreferences: HoshidictsYomitanDictionaryPreference[],
    warnings: string[],
): HoshidictsReaderPreferences {
    const result = currentReaderPreferences(current);
    if (
        Number.isInteger(scanning.length) &&
        (scanning.length as number) >= MIN_HOSHIDICTS_SCAN_LENGTH &&
        (scanning.length as number) <= MAX_HOSHIDICTS_SCAN_LENGTH
    ) {
        result.scanLength = scanning.length as number;
    } else if (Object.prototype.hasOwnProperty.call(scanning, 'length')) {
        warnings.push("Skipped Yomitan's invalid scan length.");
    }
    if (
        Number.isInteger(general.maxResults) &&
        (general.maxResults as number) >= MIN_HOSHIDICTS_MAX_RESULTS &&
        (general.maxResults as number) <= MAX_HOSHIDICTS_MAX_RESULTS
    ) {
        result.maxResults = general.maxResults as number;
    } else if (Object.prototype.hasOwnProperty.call(general, 'maxResults')) {
        warnings.push("Skipped Yomitan's invalid maximum result count.");
    }
    if (
        general.sortFrequencyDictionary === null ||
        (typeof general.sortFrequencyDictionary === 'string' &&
            general.sortFrequencyDictionary.length > 0)
    ) {
        const title = general.sortFrequencyDictionary as string | null;
        const installedDictionary =
            title === null
                ? null
                : current.dictionaries.find(
                      (dictionary) => dictionary.title === title
                  );
        const importedPreference =
            title === null
                ? null
                : dictionaryPreferences.find(
                      (dictionary) => dictionary.title === title
                  );
        if (
            title === null ||
            (installedDictionary !== null &&
                installedDictionary !== undefined &&
                installedDictionary.frequencyCount > 0 &&
                (importedPreference?.enabled ?? installedDictionary.enabled))
        ) {
            result.sortFrequencyDictionary = title;
        } else {
            warnings.push(
                `Skipped unavailable Yomitan frequency sort dictionary: ${title}.`
            );
        }
    } else if (
        Object.prototype.hasOwnProperty.call(
            general,
            'sortFrequencyDictionary'
        )
    ) {
        warnings.push("Skipped Yomitan's invalid frequency sort dictionary.");
    }
    if (
        general.sortFrequencyDictionaryOrder === 'ascending' ||
        general.sortFrequencyDictionaryOrder === 'descending'
    ) {
        result.sortFrequencyDictionaryOrder =
            general.sortFrequencyDictionaryOrder;
    } else if (
        Object.prototype.hasOwnProperty.call(
            general,
            'sortFrequencyDictionaryOrder'
        )
    ) {
        warnings.push("Skipped Yomitan's invalid frequency sort order.");
    }
    if (
        Number.isSafeInteger(scanning.popupNestingMaxDepth) &&
        (scanning.popupNestingMaxDepth as number) >= 0
    ) {
        result.popupNestingMaxDepth = scanning.popupNestingMaxDepth as number;
    }
    if (
        scanning.hidePopupOnCursorExit === true &&
        Number.isInteger(scanning.hidePopupOnCursorExitDelay) &&
        (scanning.hidePopupOnCursorExitDelay as number) >= 0
    ) {
        result.popupHideDelayMs = scanning.hidePopupOnCursorExitDelay as number;
    }
    const mouseInput = Array.isArray(scanning.inputs)
        ? scanning.inputs.find(
              (value) => isRecord(value) && isRecord(value.types) && value.types.mouse === true,
          )
        : null;
    if (isRecord(mouseInput)) {
        const include = stringValue(mouseInput.include).trim().toLowerCase();
        const activationKeys: Record<string, HoshidictsActivationKey> = {
            shift: 'Shift',
            ctrl: 'Ctrl',
            alt: 'Alt',
            meta: 'Cmd',
        };
        if (!include) {
            result.lookupMode = 'hover';
        } else if (activationKeys[include]) {
            result.lookupMode = 'shift';
            result.activationKey = activationKeys[include];
        } else {
            warnings.push("Skipped Yomitan's complex scanning input.");
        }
    }
    return result;
}

export function parseYomitanSettingsBackup(
    value: unknown,
    current: HoshidictsManagerSnapshot,
): ParsedYomitanSettings {
    if (!isRecord(value) || !isRecord(value.options)) {
        throw new Error('The selected file is not a Yomitan settings backup.');
    }
    const profiles = value.options.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) {
        throw new Error('The Yomitan settings backup does not contain profiles.');
    }
    const profileIndex =
        value.options.profileCurrent === undefined ? 0 : value.options.profileCurrent;
    if (
        !Number.isInteger(profileIndex) ||
        (profileIndex as number) < 0 ||
        (profileIndex as number) >= profiles.length
    ) {
        throw new Error('The active Yomitan profile is invalid.');
    }
    const profile = profiles[profileIndex as number];
    if (!isRecord(profile) || !isRecord(profile.options)) {
        throw new Error('The active Yomitan profile is invalid.');
    }
    const options = profile.options;
    const warnings: string[] = [];
    const groups: HoshidictsYomitanSettingsGroup[] = [];
    const dictionaries = Array.isArray(options.dictionaries)
        ? options.dictionaries.flatMap((item) => {
              if (!isRecord(item) || !stringValue(item.name)) {
                  return [];
              }
              return [
                  {
                      title: stringValue(item.name),
                      enabled: item.enabled !== false,
                  },
              ];
          })
        : [];
    if (dictionaries.length > 0) groups.push('dictionaries');

    const parsedMining = isRecord(options.anki) ? miningProfile(options.anki) : null;
    if (parsedMining) groups.push('anki');
    const parsedAudio = isRecord(options.audio) ? audioProfile(options.audio, warnings) : null;
    if (parsedAudio) groups.push('audio');
    const parsedReader = isRecord(options.scanning) || isRecord(options.general)
        ? readerPreferences(
              isRecord(options.general) ? options.general : {},
              isRecord(options.scanning) ? options.scanning : {},
              current,
              dictionaries,
              warnings,
          )
        : null;
    if (parsedReader) groups.push('reader');

    return {
        profileName: stringValue(profile.name) || null,
        dictionaries,
        readerPreferences: parsedReader,
        miningProfile: parsedMining,
        audioProfile: parsedAudio,
        groups,
        warnings,
    };
}

interface SpoolFile {
    sourcePath: string;
    archiveName: string;
}

interface BufferedSpoolFile {
    stream: fs.WriteStream;
    failure: Error | null;
}

interface BankSpool {
    prefix: string;
    files: SpoolFile[];
    currentPath: string | null;
    bankNumber: number;
    entryCount: number;
    byteCount: number;
}

interface SpoolDictionary {
    title: string;
    hasSummary: boolean;
    directory: string;
    indexPath: string;
    stylesPath: string | null;
    banks: Record<BankKey, BankSpool>;
    media: Map<string, { sourcePath: string; recordBytes: number }>;
    mediaNumber: number;
    mediaRecordBytes: number;
}

class BoundedFileAppender {
    private readonly handles = new Map<string, BufferedSpoolFile>();

    public append(filePath: string, value: string): void | Promise<void> {
        let entry = this.handles.get(filePath);
        if (entry) {
            this.handles.delete(filePath);
            this.handles.set(filePath, entry);
        } else {
            if (this.handles.size >= MAX_OPEN_SPOOL_FILES) {
                const oldest = this.handles.entries().next();
                if (!oldest.done) {
                    const [oldestPath, oldestEntry] = oldest.value;
                    this.handles.delete(oldestPath);
                    return this.closeEntry(oldestEntry).then(() =>
                        this.append(filePath, value)
                    );
                }
            }
            const created: BufferedSpoolFile = {
                stream: fs.createWriteStream(filePath, {
                    flags: 'a',
                    encoding: 'utf8',
                    highWaterMark: MAX_SPOOL_BUFFER_BYTES,
                }),
                failure: null,
            };
            created.stream.on('error', (error) => {
                created.failure ??= error;
            });
            entry = created;
            this.handles.set(filePath, entry);
        }
        if (entry.failure) {
            return Promise.reject(entry.failure);
        }
        if (!entry.stream.write(value, 'utf8')) {
            return this.waitForDrain(entry);
        }
    }

    public close(filePath: string): void | Promise<void> {
        const entry = this.handles.get(filePath);
        if (!entry) {
            return;
        }
        this.handles.delete(filePath);
        return this.closeEntry(entry);
    }

    public async closeAll(): Promise<void> {
        const entries = [...this.handles.values()];
        this.handles.clear();
        const results = await Promise.allSettled(
            entries.map(async (entry) => await this.closeEntry(entry))
        );
        const failure = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === 'rejected'
        );
        if (failure) {
            throw failure.reason;
        }
    }

    private waitForDrain(entry: BufferedSpoolFile): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
                entry.stream.off('drain', onDrain);
                entry.stream.off('error', onError);
            };
            const onDrain = (): void => {
                cleanup();
                if (entry.failure) {
                    reject(entry.failure);
                } else {
                    resolve();
                }
            };
            const onError = (error: Error): void => {
                cleanup();
                reject(error);
            };
            entry.stream.once('drain', onDrain);
            entry.stream.once('error', onError);
            if (entry.failure) {
                onError(entry.failure);
            }
        });
    }

    private closeEntry(entry: BufferedSpoolFile): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const finish = (): void => {
                if (entry.failure) {
                    reject(entry.failure);
                } else {
                    resolve();
                }
            };
            if (entry.stream.closed) {
                finish();
                return;
            }
            entry.stream.once('close', finish);
            entry.stream.end();
        });
    }
}

function createBankSpool(prefix: string): BankSpool {
    return {
        prefix,
        files: [],
        currentPath: null,
        bankNumber: 0,
        entryCount: 0,
        byteCount: 0,
    };
}

function createBankSpools(): Record<BankKey, BankSpool> {
    return {
        term: createBankSpool('term_bank'),
        termMeta: createBankSpool('term_meta_bank'),
        kanji: createBankSpool('kanji_bank'),
        kanjiMeta: createBankSpool('kanji_meta_bank'),
        tag: createBankSpool('tag_bank'),
    };
}

async function createSpoolDictionary(
    root: string,
    title: string,
    dictionaryNumber: number
): Promise<SpoolDictionary> {
    const directory = path.join(root, `spool-${dictionaryNumber}`);
    await fsp.mkdir(path.join(directory, 'banks'), { recursive: true });
    await fsp.mkdir(path.join(directory, 'media'));
    const indexPath = path.join(directory, 'index.json');
    return {
        title,
        hasSummary: false,
        directory,
        indexPath,
        stylesPath: null,
        banks: createBankSpools(),
        media: new Map(),
        mediaNumber: 0,
        mediaRecordBytes: 0,
    };
}

async function applySpoolDictionarySummary(
    dictionary: SpoolDictionary,
    summary: YomitanDictionarySummary
): Promise<void> {
    await fsp.writeFile(
        dictionary.indexPath,
        JSON.stringify(summary.index),
        'utf8'
    );
    if (summary.styles) {
        const stylesPath =
            dictionary.stylesPath ?? path.join(dictionary.directory, 'styles.css');
        await fsp.writeFile(stylesPath, summary.styles, 'utf8');
        dictionary.stylesPath = stylesPath;
    } else if (dictionary.stylesPath) {
        await fsp.rm(dictionary.stylesPath, { force: true });
        dictionary.stylesPath = null;
    }
    dictionary.hasSummary = true;
}

function finishBankFile(
    bank: BankSpool,
    appender: BoundedFileAppender
): void | Promise<void> {
    if (!bank.currentPath) {
        return;
    }
    const currentPath = bank.currentPath;
    const appended = appender.append(currentPath, ']');
    bank.currentPath = null;
    bank.entryCount = 0;
    bank.byteCount = 0;
    return continueWith(appended, () => appender.close(currentPath));
}

function appendBankEntry(
    dictionary: SpoolDictionary,
    bankKey: BankKey,
    entry: BankEntry,
    appender: BoundedFileAppender
): void | Promise<void> {
    const bank = dictionary.banks[bankKey];
    const serialized = JSON.stringify(entry);
    const entryBytes = Buffer.byteLength(serialized);
    if (entryBytes + 2 > MAX_BANK_BYTES) {
        throw new Error(
            `Dictionary ${dictionary.title} contains a ${bank.prefix} entry ` +
                'which exceeds the supported 32 MiB bank size.'
        );
    }
    const nextEntryBytes = (bank.entryCount > 0 ? 1 : 0) + entryBytes;
    if (
        bank.currentPath &&
        bank.entryCount > 0 &&
        (bank.entryCount >= MAX_BANK_ENTRIES ||
            bank.byteCount + nextEntryBytes + 1 > MAX_BANK_BYTES)
    ) {
        return continueWith(finishBankFile(bank, appender), () =>
            appendBankEntry(dictionary, bankKey, entry, appender)
        );
    }
    if (!bank.currentPath) {
        bank.bankNumber += 1;
        const archiveName = `${bank.prefix}_${bank.bankNumber}.json`;
        bank.currentPath = path.join(dictionary.directory, 'banks', archiveName);
        bank.files.push({ sourcePath: bank.currentPath, archiveName });
        bank.byteCount = 1;
    }
    const separator = bank.entryCount > 0 ? ',' : '';
    const appended = appender.append(
        bank.currentPath,
        `${bank.entryCount > 0 ? separator : '['}${serialized}`
    );
    bank.entryCount += 1;
    bank.byteCount += (separator ? 1 : 0) + entryBytes;
    if (
        bank.entryCount >= MAX_BANK_ENTRIES ||
        bank.byteCount + 1 >= MAX_BANK_BYTES
    ) {
        return continueWith(appended, () => finishBankFile(bank, appender));
    }
    return appended;
}

async function spoolMedia(
    dictionary: SpoolDictionary,
    mediaPath: string,
    content: Buffer
): Promise<void> {
    const mediaPathBytes = Buffer.byteLength(mediaPath);
    if (mediaPathBytes > MAX_NATIVE_MEDIA_PATH_BYTES) {
        throw new Error(
            `Dictionary ${dictionary.title} contains a media path which is too long for Hoshidicts.`
        );
    }
    const recordBytes = 2 + mediaPathBytes + 4 + content.byteLength;
    const previous = dictionary.media.get(mediaPath);
    const totalRecordBytes =
        dictionary.mediaRecordBytes - (previous?.recordBytes ?? 0) + recordBytes;
    if (
        content.byteLength >= MAX_NATIVE_ZIP_BYTES ||
        totalRecordBytes > MAX_NATIVE_ZIP_BYTES
    ) {
        throw new Error(
            `Dictionary ${dictionary.title} contains more media data than Hoshidicts can import.`
        );
    }
    dictionary.mediaNumber += 1;
    const sourcePath = path.join(
        dictionary.directory,
        'media',
        `${dictionary.mediaNumber}.bin`
    );
    await fsp.writeFile(sourcePath, content);
    if (previous) {
        await fsp.rm(previous.sourcePath, { force: true });
    }
    dictionary.media.set(mediaPath, { sourcePath, recordBytes });
    dictionary.mediaRecordBytes = totalRecordBytes;
}

async function spoolDictionaryBackup(
    filePath: string,
    root: string,
    onBytesRead?: (bytesRead: number) => void
): Promise<SpoolDictionary[]> {
    const spooled = new Map<string, SpoolDictionary>();
    const dictionaries: SpoolDictionary[] = [];
    let dictionaryNumber = 0;
    const appender = new BoundedFileAppender();
    const getDictionary = (
        title: string
    ): SpoolDictionary | Promise<SpoolDictionary> => {
        const existing = spooled.get(title);
        if (existing) {
            return existing;
        }
        dictionaryNumber += 1;
        return createSpoolDictionary(root, title, dictionaryNumber).then(
            (dictionary) => {
                spooled.set(title, dictionary);
                return dictionary;
            }
        );
    };
    try {
        await streamDictionaryRows(
            createTrackedReadStream(filePath, onBytesRead),
            (tableName, inbound, row) => {
                if (tableName === 'dictionaries') {
                    const summary = parseDictionarySummary(row, inbound);
                    if (!summary) {
                        return;
                    }
                    return continueWith(
                        getDictionary(summary.title),
                        (dictionary) => {
                            const firstSummary = !dictionary.hasSummary;
                            return continueWith(
                                applySpoolDictionarySummary(dictionary, summary),
                                () => {
                                    if (firstSummary) {
                                        dictionaries.push(dictionary);
                                    }
                                }
                            );
                        }
                    );
                }
                const parsed = parseDictionaryRow(tableName, row, inbound);
                if (!parsed) {
                    return;
                }
                return continueWith(
                    getDictionary(parsed.dictionary),
                    (dictionary) =>
                        parsed.kind === 'bank'
                            ? appendBankEntry(
                                  dictionary,
                                  parsed.bank,
                                  parsed.entry,
                                  appender
                              )
                            : spoolMedia(
                                  dictionary,
                                  parsed.mediaPath,
                                  parsed.content
                              )
                );
            }
        );
        for (const dictionary of spooled.values()) {
            for (const [bankKey] of BANK_FILES) {
                await finishBankFile(dictionary.banks[bankKey], appender);
            }
        }
    } finally {
        await appender.closeAll();
    }
    return dictionaries;
}

async function writeDictionaryArchive(
    dictionary: SpoolDictionary,
    outputPath: string
): Promise<void> {
    const files: SpoolFile[] = [
        { sourcePath: dictionary.indexPath, archiveName: 'index.json' },
    ];
    for (const [bankKey] of BANK_FILES) {
        files.push(...dictionary.banks[bankKey].files);
    }
    if (dictionary.stylesPath) {
        files.push({
            sourcePath: dictionary.stylesPath,
            archiveName: 'styles.css',
        });
    }
    for (const [mediaPath, media] of dictionary.media) {
        files.push({ sourcePath: media.sourcePath, archiveName: mediaPath });
    }
    for (const file of files) {
        if ((await fsp.stat(file.sourcePath)).size >= MAX_NATIVE_ZIP_BYTES) {
            throw new Error(
                `Dictionary ${dictionary.title} contains an entry which is too large ` +
                    `for Hoshidicts: ${file.archiveName}`
            );
        }
    }
    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        let failure: Error | null = null;
        const fail = (error: unknown): void => {
            if (failure) {
                return;
            }
            failure =
                error instanceof Error ? error : new Error(String(error));
            try {
                void archive.abort();
            } catch {
                // The original archive or output error is more useful.
            }
            output.destroy();
        };
        output.once('close', () => {
            if (failure) {
                reject(failure);
            } else {
                resolve();
            }
        });
        output.once('error', fail);
        archive.once('error', fail);
        archive.pipe(output);
        try {
            for (const file of files) {
                archive.file(file.sourcePath, { name: file.archiveName });
            }
            void archive.finalize().catch(fail);
        } catch (error) {
            fail(error);
        }
    });
    const archiveSize = (await fsp.stat(outputPath)).size;
    if (archiveSize >= MAX_NATIVE_ZIP_BYTES) {
        throw new Error(
            `Dictionary ${dictionary.title} is too large for Hoshidicts' ZIP importer. ` +
                'Split it into smaller dictionaries before importing.'
        );
    }
}

export async function prepareYomitanDictionaryBackup(
    filePath: string,
    onProgress?: (progress: YomitanDictionaryPreparationProgress) => void,
    onPreparedDictionary?: (
        dictionary: YomitanPreparedDictionary
    ) => Promise<void>,
    onReadingProgress?: (
        progress: YomitanDictionaryReadingProgress
    ) => void
): Promise<PreparedYomitanBackup> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gsm-yomitan-'));
    try {
        const dictionaries: Array<{ title: string; archivePath: string }> = [];
        const fileSize = onReadingProgress
            ? (await fsp.stat(filePath)).size
            : 0;
        const reportReadingProgress = onReadingProgress
            ? createReadingProgressReporter(fileSize, onReadingProgress)
            : null;
        reportReadingProgress?.(0, true);
        const spooled = await spoolDictionaryBackup(
            filePath,
            root,
            reportReadingProgress
                ? (bytesRead) => reportReadingProgress(bytesRead)
                : undefined
        );
        reportReadingProgress?.(fileSize, true);
        if (spooled.length === 0) {
            throw new Error('The Yomitan backup does not contain dictionaries.');
        }
        const total = spooled.length;
        let index = 0;
        for (const dictionary of spooled) {
            index += 1;
            onProgress?.({
                current: index,
                total,
                title: dictionary.title,
            });
            const archivePath = path.join(root, `dictionary-${index}.zip`);
            await writeDictionaryArchive(dictionary, archivePath);
            await fsp.rm(dictionary.directory, { recursive: true, force: true });
            if (onPreparedDictionary) {
                try {
                    await onPreparedDictionary({
                        title: dictionary.title,
                        archivePath,
                        current: index,
                        total,
                    });
                } finally {
                    await fsp.rm(archivePath, { force: true });
                }
            } else {
                dictionaries.push({ title: dictionary.title, archivePath });
            }
        }
        return {
            dictionaries,
            settings: null,
            cleanup: async () => {
                await fsp.rm(root, { recursive: true, force: true });
            },
        };
    } catch (error) {
        await fsp.rm(root, { recursive: true, force: true });
        throw error;
    }
}

export async function prepareYomitanSettingsBackup(
    filePath: string,
    current: HoshidictsManagerSnapshot
): Promise<PreparedYomitanBackup> {
    const value: unknown = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    return {
        dictionaries: [],
        settings: parseYomitanSettingsBackup(value, current),
        cleanup: async () => undefined,
    };
}
