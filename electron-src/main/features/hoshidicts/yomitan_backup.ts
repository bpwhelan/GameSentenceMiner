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
    MAX_HOSHIDICTS_AUDIO_SOURCES,
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
import { normalizeHoshidictsMiningProfile } from './profile.js';

type JsonRecord = Record<string, unknown>;
type BankEntry = unknown[];

interface YomitanDictionaryBanks {
    term: BankEntry[];
    termMeta: BankEntry[];
    kanji: BankEntry[];
    kanjiMeta: BankEntry[];
    tag: BankEntry[];
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

function addDictionarySummary(
    dictionaries: Map<string, ParsedYomitanDictionary>,
    row: unknown,
    inbound: boolean
): void {
    const summary = exportRowValue(row, inbound);
    if (!isRecord(summary)) {
        return;
    }
    const title = stringValue(summary.title);
    if (!title) {
        return;
    }
    dictionaries.set(title, {
        title,
        index: dictionaryIndex(summary),
        banks: emptyBanks(),
        styles: stringValue(summary.styles),
        media: new Map(),
    });
}

function addDictionaryRow(
    dictionaries: Map<string, ParsedYomitanDictionary>,
    tableName: string,
    row: unknown,
    inbound: boolean
): void {
    const item = exportRowValue(row, inbound);
    if (!isRecord(item)) {
        return;
    }
    const dictionary = dictionaries.get(stringValue(item.dictionary));
    if (!dictionary) {
        return;
    }
    switch (tableName) {
        case 'terms':
            dictionary.banks.term.push([
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
            ]);
            break;
        case 'termMeta':
            dictionary.banks.termMeta.push([
                stringValue(item.expression),
                stringValue(item.mode),
                item.data,
            ]);
            break;
        case 'kanji':
            dictionary.banks.kanji.push([
                stringValue(item.character),
                stringValue(item.onyomi),
                stringValue(item.kunyomi),
                stringValue(item.tags),
                Array.isArray(item.meanings) ? item.meanings : [],
                isRecord(item.stats) ? item.stats : {},
            ]);
            break;
        case 'kanjiMeta':
            dictionary.banks.kanjiMeta.push([
                stringValue(item.character),
                stringValue(item.mode),
                item.data,
            ]);
            break;
        case 'tagMeta':
            dictionary.banks.tag.push([
                stringValue(item.name),
                stringValue(item.category),
                typeof item.order === 'number' ? item.order : 0,
                stringValue(item.notes),
                typeof item.score === 'number' ? item.score : 0,
            ]);
            break;
        case 'media': {
            const content = mediaBuffer(item.content);
            const mediaPath = stringValue(item.path);
            if (content && mediaPath) {
                dictionary.media.set(mediaPath, content);
            }
            break;
        }
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

function isTablePath(pathValue: readonly (string | number)[]): boolean {
    return (
        pathValue.length === 3 &&
        pathValue[0] === 'data' &&
        pathValue[1] === 'data' &&
        typeof pathValue[2] === 'number'
    );
}

function isRowPath(pathValue: readonly (string | number)[]): boolean {
    return (
        pathValue.length === 5 &&
        isTablePath(pathValue.slice(0, 3)) &&
        pathValue[3] === 'rows' &&
        typeof pathValue[4] === 'number'
    );
}

async function streamDictionaryRows(
    source: Readable,
    onRow: (tableName: string, inbound: boolean, row: unknown) => void
): Promise<DictionaryBackupSignature> {
    const tokens = source.pipe(
        parserStream({
            streamKeys: false,
            packKeys: true,
            streamValues: false,
            packValues: true,
        })
    );
    const assembler = new Assembler();
    const signature: DictionaryBackupSignature = {
        formatName: '',
        formatVersion: null,
        databaseName: '',
    };
    let tableName = '';
    let inbound = false;

    for await (const rawToken of tokens) {
        const token = rawToken as Token;
        const currentPath = assembler.path;
        const currentKey = assembler.key;
        if (token.name === 'stringValue') {
            if (currentPath.length === 0 && currentKey === 'formatName') {
                signature.formatName = token.value;
            } else if (
                currentPath.length === 1 &&
                currentPath[0] === 'data' &&
                currentKey === 'databaseName'
            ) {
                signature.databaseName = token.value;
            } else if (isTablePath(currentPath) && currentKey === 'tableName') {
                tableName = token.value;
            }
        } else if (
            token.name === 'numberValue' &&
            currentPath.length === 0 &&
            currentKey === 'formatVersion'
        ) {
            signature.formatVersion = Number(token.value);
        } else if (
            (token.name === 'trueValue' || token.name === 'falseValue') &&
            isTablePath(currentPath) &&
            currentKey === 'inbound'
        ) {
            inbound = token.name === 'trueValue';
        }

        if (
            (token.name === 'endObject' || token.name === 'endArray') &&
            isRowPath(currentPath)
        ) {
            const row = assembler.current;
            assembler.consume(token);
            onRow(tableName, inbound, row);
            if (Array.isArray(assembler.current)) {
                assembler.current.length = 0;
            }
            continue;
        }

        const closingTable =
            token.name === 'endObject' && isTablePath(currentPath);
        assembler.consume(token);
        if (closingTable) {
            if (Array.isArray(assembler.current)) {
                assembler.current.length = 0;
            }
            tableName = '';
            inbound = false;
        }
    }
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
    await streamDictionaryRows(createSource(), (tableName, inbound, row) => {
        if (tableName === 'dictionaries') {
            addDictionarySummary(dictionaries, row, inbound);
        }
    });
    if (dictionaries.size === 0) {
        throw new Error('The Yomitan backup does not contain dictionaries.');
    }
    await streamDictionaryRows(createSource(), (tableName, inbound, row) => {
        if (tableName !== 'dictionaries') {
            addDictionaryRow(dictionaries, tableName, row, inbound);
        }
    });
    return [...dictionaries.values()];
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
        activationKey: current.activationKey,
        sourceHighlightEnabled: current.sourceHighlightEnabled,
        popupHideDelayMs: current.popupHideDelayMs,
        showLookupCounts: current.showLookupCounts,
        popupNestingMaxDepth: current.popupNestingMaxDepth,
        definitionBlur: { ...current.definitionBlur },
        popupWidthPx: current.popupWidthPx,
        popupHeightPx: current.popupHeightPx,
        theme: current.theme,
    };
}

function readerPreferences(
    scanning: JsonRecord,
    current: HoshidictsManagerSnapshot,
    warnings: string[],
): HoshidictsReaderPreferences {
    const result = currentReaderPreferences(current);
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
    const parsedReader = isRecord(options.scanning)
        ? readerPreferences(options.scanning, current, warnings)
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

async function writeDictionaryArchive(
    dictionary: ParsedYomitanDictionary,
    outputPath: string,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.once('close', resolve);
        output.once('error', reject);
        archive.once('error', reject);
        archive.pipe(output);
        archive.append(JSON.stringify(dictionary.index), { name: 'index.json' });
        const bankNames: Array<[keyof YomitanDictionaryBanks, string]> = [
            ['term', 'term_bank'],
            ['termMeta', 'term_meta_bank'],
            ['kanji', 'kanji_bank'],
            ['kanjiMeta', 'kanji_meta_bank'],
            ['tag', 'tag_bank'],
        ];
        for (const [key, filePrefix] of bankNames) {
            const entries = dictionary.banks[key];
            for (
                let offset = 0, bankNumber = 1;
                offset < entries.length;
                offset += 1_000, bankNumber += 1
            ) {
                const end = Math.min(offset + 1_000, entries.length);
                const chunks = (function* (): Generator<string> {
                    yield '[';
                    for (let index = offset; index < end; index += 1) {
                        if (index > offset) yield ',';
                        yield JSON.stringify(entries[index]);
                    }
                    yield ']';
                })();
                archive.append(Readable.from(chunks), {
                    name: `${filePrefix}_${bankNumber}.json`,
                });
            }
        }
        if (dictionary.styles) {
            archive.append(dictionary.styles, { name: 'styles.css' });
        }
        for (const [mediaPath, content] of dictionary.media) {
            archive.append(content, { name: mediaPath });
        }
        void archive.finalize().catch(reject);
    });
}

export async function prepareYomitanDictionaryBackup(
    filePath: string
): Promise<PreparedYomitanBackup> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gsm-yomitan-'));
    try {
        const dictionaries: Array<{ title: string; archivePath: string }> = [];
        const parsed = await parseYomitanDictionaryBackupStream(() =>
            fs.createReadStream(filePath)
        );
        for (let index = 0; index < parsed.length; index += 1) {
            const archivePath = path.join(root, `dictionary-${index + 1}.zip`);
            await writeDictionaryArchive(parsed[index], archivePath);
            dictionaries.push({ title: parsed[index].title, archivePath });
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
