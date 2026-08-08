import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { inflateRaw } from 'node:zlib';

import WebSocket from 'ws';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { getBaseDir } from '../../data_dir.js';
import {
    DEFAULT_INPUT_SERVER_PORT,
    resolveInputServerExecutable,
} from '../../services/input_server.js';
import type {
    HoshidictsAudioProfile,
    HoshidictsCustomDictionaryEntry,
    HoshidictsCustomDictionaryDocument,
    HoshidictsCustomEntryRequest,
    HoshidictsDictionaryState,
    HoshidictsDefinitionBlurPreferences,
    HoshidictsActivationKey,
    HoshidictsFrequencyMode,
    HoshidictsManagerSnapshot,
    HoshidictsLookupMode,
    HoshidictsMiningProfile,
    HoshidictsProgress,
    HoshidictsProgressPhase,
    HoshidictsRecommendedDictionaryId,
    HoshidictsRecommendedDictionaryState,
    HoshidictsSchedule,
    HoshidictsYomitanDictionaryPreference,
} from '../../../shared/features/hoshidicts.js';
import {
    DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
    DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
    DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
    DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
    isHoshidictsActivationKey,
    MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES,
    MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
    MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
} from '../../../shared/features/hoshidicts.js';
import {
    defaultHoshidictsAudioProfile,
    HOSHIDICTS_AUDIO_PROFILE_FILE_NAME,
    normalizeHoshidictsAudioProfile,
} from './audio_profile.js';
import {
    customDictionarySourceRevision,
    parseCustomDictionary,
    serializeCustomDictionaryEntry,
    writeCustomDictionaryArchive,
    type ParsedCustomDictionary,
} from './custom_dictionary.js';
import {
    defaultHoshidictsMiningProfile,
    HOSHIDICTS_MINING_PROFILE_FILE_NAME,
    normalizeHoshidictsMiningProfile,
} from './profile.js';

export {
    defaultHoshidictsAudioProfile,
    HOSHIDICTS_AUDIO_PROFILE_FILE_NAME,
    normalizeHoshidictsAudioProfile,
} from './audio_profile.js';
export {
    defaultHoshidictsMiningProfile,
    HOSHIDICTS_MINING_PROFILE_FILE_NAME,
    normalizeHoshidictsMiningProfile,
} from './profile.js';

export type {
    HoshidictsAudioProfile,
    HoshidictsAudioSource,
    HoshidictsAudioSourceType,
    HoshidictsCustomDictionaryDocument,
    HoshidictsCustomEntryRequest,
    HoshidictsDictionaryState,
    HoshidictsDefinitionBlurPreferences,
    HoshidictsFrequencyMode,
    HoshidictsManagerSnapshot,
    HoshidictsLookupMode,
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
    recommendedId: HoshidictsRecommendedDictionaryId | null;
}

interface PersistedManifest {
    version: 1;
    lookupMode: HoshidictsLookupMode;
    activationKey: HoshidictsActivationKey;
    sourceHighlightEnabled: boolean;
    popupHideDelayMs: number;
    showLookupCounts: boolean;
    popupNestingMaxDepth: number;
    definitionBlur: HoshidictsDefinitionBlurPreferences;
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
    frequencyCount: number;
    pitchCount: number;
    kanjiCount: number;
    frequencyMode: HoshidictsFrequencyMode | null;
    mediaCount: number;
    importDate: number | null;
}

export interface ArchiveInspection {
    sourceLanguage: string | null;
    hasSupportedBank: boolean;
    hasJapaneseEntry: boolean;
}

export interface HoshidictsImportReport {
    success: boolean;
    title: string;
    termCount: number;
    mediaCount?: number;
    error: string;
}

interface StagedDictionary {
    dictionary: PersistedDictionary;
    generationRoot: string;
}

interface CustomDictionarySource {
    text: string;
    raw: Buffer | null;
    parsed: ParsedCustomDictionary;
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
    writeCustomArchive: (
        outputPath: string,
        title: string,
        revision: string,
        entries: readonly HoshidictsCustomDictionaryEntry[]
    ) => Promise<void>;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    schedulerIntervalMs: number;
}

const MANIFEST_FILE_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MINING_PROFILE_BYTES = 64 * 1024;
const MAX_AUDIO_PROFILE_BYTES = 64 * 1024;
const MAX_ARCHIVE_INDEX_BYTES = 1024 * 1024;
const MAX_TERM_BANK_BYTES = 32 * 1024 * 1024;
const MAX_SCANNED_TERM_BANKS = 32;
const MAX_REMOTE_INDEX_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_IMPORT_OUTPUT_BYTES = 1024 * 1024;
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
const RELOAD_TIMEOUT_MS = 15 * 1000;
const RELOAD_CONNECT_RETRY_MS = 100;
const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;
const REQUIRED_DICTIONARY_FILES = ['hash.table', 'bloom.filter', 'blobs.bin'] as const;
const REQUIRED_MEDIA_FILES = ['media.idx', 'media.bin'] as const;
const HOSHIDICTS_MARKERS = ['.hoshidicts_3', '.hoshidicts_2', '.hoshidicts_1'] as const;
const JAPANESE_TEXT_PATTERN =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

type RecommendedHoshidictsDictionaryKind =
    | 'term'
    | 'frequency'
    | 'pitch'
    | 'kanji';

async function readBoundedJsonFile(
    filePath: string,
    maximumBytes: number,
    label: string,
    defaultValue: () => unknown
): Promise<unknown> {
    let raw: string;
    try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile() || stat.size === 0 || stat.size > maximumBytes) {
            throw new Error(`${label} is empty, oversized, or not a file.`);
        }
        raw = await fsp.readFile(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return defaultValue();
        }
        throw error;
    }
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
}

export const HOSHIDICTS_CUSTOM_DICTIONARY_FILE_NAME = 'custom-dictionary.txt';
export const HOSHIDICTS_CUSTOM_DICTIONARY_TITLE = 'GSM Custom Dictionary';
export const HOSHIDICTS_CUSTOM_DICTIONARY_ID = 'gsm-managed-custom-dictionary-v1';

interface RecommendedHoshidictsDictionary {
    id: HoshidictsRecommendedDictionaryId;
    kind: RecommendedHoshidictsDictionaryKind;
    indexUrl: string | null;
    downloadUrl: string;
    expectedTitle: string | null;
}

export const RECOMMENDED_HOSHIDICTS_DICTIONARIES: readonly RecommendedHoshidictsDictionary[] =
    [
        {
            id: 'jitendex',
            kind: 'term',
            indexUrl: 'https://jitendex.org/static/yomitan.json',
            downloadUrl:
                'https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip',
            expectedTitle: null,
        },
        {
            id: 'jmdict',
            kind: 'term',
            indexUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english_without_proper_names.json',
            downloadUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english_without_proper_names.zip',
            expectedTitle: null,
        },
        {
            id: 'jmnedict',
            kind: 'term',
            indexUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.json',
            downloadUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip',
            expectedTitle: null,
        },
        {
            id: 'bccwj',
            kind: 'frequency',
            indexUrl: null,
            downloadUrl:
                'https://github.com/Kuuuube/yomitan-dictionaries/releases/download/yomitan-permalink/BCCWJ_SUW_LUW_combined.zip',
            expectedTitle: 'BCCWJ',
        },
        {
            id: 'jpdbv2-kana',
            kind: 'frequency',
            indexUrl: null,
            downloadUrl:
                'https://github.com/Kuuuube/yomitan-dictionaries/releases/download/yomitan-permalink/JPDB_v2.2_Frequency_Kana.zip',
            expectedTitle: 'JPDBv2㋕',
        },
        {
            id: 'jiten',
            kind: 'frequency',
            indexUrl: 'https://api.jiten.moe/api/frequency-list/index',
            downloadUrl:
                'https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan',
            expectedTitle: null,
        },
        {
            id: 'kanjium-pitch',
            kind: 'pitch',
            indexUrl: null,
            downloadUrl:
                'https://github.com/toasted-nutbread/yomichan-pitch-accent-dictionary/releases/download/1.0.0/kanjium_pitch_accents.zip',
            expectedTitle: 'Kanjium Pitch Accents',
        },
        {
            id: 'kanjidic',
            kind: 'kanji',
            indexUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/KANJIDIC_english.json',
            downloadUrl:
                'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/KANJIDIC_english.zip',
            expectedTitle: null,
        },
    ];

// The bundled Yomitan catalog also contains GSM Character Dictionary. It is
// intentionally managed by Yomitan's existing sync path because it is generated
// dynamically from a loopback-only HTTP endpoint; Hoshidicts downloads remain
// HTTPS-only.

const SCHEDULE_INTERVALS: Record<Exclude<HoshidictsSchedule, 'off'>, number> = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
};

function emptyManifest(): PersistedManifest {
    return {
        version: MANIFEST_VERSION,
        lookupMode: 'shift',
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled:
            DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
        popupHideDelayMs: DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
        showLookupCounts: true,
        popupNestingMaxDepth: DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
        definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
        schedule: 'off',
        lastCheck: null,
        nextCheck: null,
        lastError: null,
        dictionaries: [],
    };
}

function pinCustomDictionary(manifest: PersistedManifest): PersistedManifest {
    const customIndex = manifest.dictionaries.findIndex(
        (dictionary) => dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID
    );
    if (customIndex < 0) {
        return manifest;
    }
    if (customIndex === 0 && manifest.dictionaries[0].enabled) {
        return manifest;
    }
    const dictionaries = [...manifest.dictionaries];
    const [custom] = dictionaries.splice(customIndex, 1);
    dictionaries.unshift({ ...custom, enabled: true });
    return { ...manifest, dictionaries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

class ManifestCommitError extends Error {
    constructor(
        message: string,
        readonly manifestRollbackRestored: boolean
    ) {
        super(message);
        this.name = 'ManifestCommitError';
    }
}

function customSourcesMatch(
    first: CustomDictionarySource,
    second: CustomDictionarySource
): boolean {
    if (first.raw === null || second.raw === null) {
        return first.raw === second.raw;
    }
    return first.raw.equals(second.raw);
}

function normalizeSchedule(value: unknown): HoshidictsSchedule {
    return value === 'daily' || value === 'weekly' || value === 'monthly'
        ? value
        : 'off';
}

function normalizePopupHideDelay(value: unknown): number {
    return Number.isInteger(value) &&
        (value as number) >= 0 &&
        (value as number) <= MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS
        ? (value as number)
        : DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS;
}

function normalizePopupNestingMaxDepth(value: unknown): number {
    return Number.isSafeInteger(value) && (value as number) >= 0
        ? (value as number)
        : DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH;
}

function normalizeDefinitionBlur(
    value: unknown
): HoshidictsDefinitionBlurPreferences {
    if (!isRecord(value)) {
        return { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR };
    }
    return {
        enabled:
            typeof value.enabled === 'boolean'
                ? value.enabled
                : DEFAULT_HOSHIDICTS_DEFINITION_BLUR.enabled,
        lookupThreshold:
            Number.isInteger(value.lookupThreshold) &&
            (value.lookupThreshold as number) >=
                MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD &&
            (value.lookupThreshold as number) <=
                MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD
                ? (value.lookupThreshold as number)
                : DEFAULT_HOSHIDICTS_DEFINITION_BLUR.lookupThreshold,
        revealMode: value.revealMode === 'hover' ? 'hover' : 'timed',
        revealDelayMs:
            Number.isInteger(value.revealDelayMs) &&
            (value.revealDelayMs as number) >=
                MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS &&
            (value.revealDelayMs as number) <=
                MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS
                ? (value.revealDelayMs as number)
                : DEFAULT_HOSHIDICTS_DEFINITION_BLUR.revealDelayMs,
    };
}

function definitionBlurPreferencesEqual(
    left: HoshidictsDefinitionBlurPreferences,
    right: HoshidictsDefinitionBlurPreferences
): boolean {
    return (
        left.enabled === right.enabled &&
        left.lookupThreshold === right.lookupThreshold &&
        left.revealMode === right.revealMode &&
        left.revealDelayMs === right.revealDelayMs
    );
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

function normalizeCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

function normalizeFrequencyMode(value: unknown): HoshidictsFrequencyMode | null {
    return value === 'occurrence-based' || value === 'rank-based' ? value : null;
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

function manifestHasRecommendedDictionary(
    manifest: PersistedManifest,
    recommended: RecommendedHoshidictsDictionary
): boolean {
    return manifest.dictionaries.some(
        (dictionary) =>
            dictionary.recommendedId === recommended.id ||
            (recommended.indexUrl !== null &&
                parseHttpsUrl(dictionary.indexUrl) === recommended.indexUrl)
    );
}

function recommendedDictionaryForPersisted(
    dictionary: PersistedDictionary
): RecommendedHoshidictsDictionary | null {
    return (
        RECOMMENDED_HOSHIDICTS_DICTIONARIES.find(
            (recommended) =>
                dictionary.recommendedId === recommended.id ||
                (recommended.indexUrl !== null &&
                    parseHttpsUrl(dictionary.indexUrl) === recommended.indexUrl)
        ) ?? null
    );
}

function isDefaultRecommendedDictionary(
    id: HoshidictsRecommendedDictionaryId
): boolean {
    return DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.some(
        (defaultId) => defaultId === id
    );
}

function recommendedDictionaryStates(
    manifest: PersistedManifest
): HoshidictsRecommendedDictionaryState[] {
    return RECOMMENDED_HOSHIDICTS_DICTIONARIES.map((recommended) => ({
        id: recommended.id,
        installed: manifestHasRecommendedDictionary(manifest, recommended),
    }));
}

function isRecommendedDictionaryId(
    value: unknown
): value is HoshidictsRecommendedDictionaryId {
    return RECOMMENDED_HOSHIDICTS_DICTIONARIES.some(
        (dictionary) => dictionary.id === value
    );
}

function generatedIndexEntryCount(index: GeneratedIndex): number {
    return (
        index.termCount +
        index.frequencyCount +
        index.pitchCount +
        index.kanjiCount
    );
}

function generatedIndexMatchesKind(
    index: GeneratedIndex,
    kind: RecommendedHoshidictsDictionaryKind
): boolean {
    switch (kind) {
        case 'term':
            return index.termCount > 0;
        case 'frequency':
            return index.frequencyCount > 0;
        case 'pitch':
            return index.pitchCount > 0;
        case 'kanji':
            return index.kanjiCount > 0;
    }
}

function generatedIndexMatchesRecommendationIdentity(
    index: GeneratedIndex,
    recommended: RecommendedHoshidictsDictionary
): boolean {
    return recommended.indexUrl !== null
        ? parseHttpsUrl(index.indexUrl) === recommended.indexUrl
        : index.title === recommended.expectedTitle;
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
    const termMeta = isRecord(counts.termMeta) ? counts.termMeta : {};
    const kanji = isRecord(counts.kanji) ? counts.kanji : {};
    const media = isRecord(counts.media) ? counts.media : {};
    const termCount = normalizeCount(terms.total);
    const frequencyCount = normalizeCount(termMeta.freq);
    const pitchCount =
        normalizeCount(termMeta.pitch) + normalizeCount(termMeta.ipa);
    const kanjiCount = normalizeCount(kanji.total);
    const mediaCount = normalizeCount(media.total);
    return {
        title: parsed.title,
        revision: typeof parsed.revision === 'string' ? parsed.revision : '',
        isUpdatable: parsed.isUpdatable === true,
        indexUrl: normalizeOptionalString(parsed.indexUrl),
        downloadUrl: normalizeOptionalString(parsed.downloadUrl),
        sourceLanguage: normalizeOptionalString(parsed.sourceLanguage),
        termCount,
        frequencyCount,
        pitchCount,
        kanjiCount,
        frequencyMode: normalizeFrequencyMode(parsed.frequencyMode),
        mediaCount,
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

async function validateNativeMediaFiles(
    dictionaryPath: string,
    mediaCount: number
): Promise<void> {
    if (mediaCount <= 0) {
        return;
    }
    for (const fileName of REQUIRED_MEDIA_FILES) {
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
    fallbackDate: Date,
    recommendedId: HoshidictsRecommendedDictionaryId | null = null
): PersistedDictionary {
    if (generatedIndexEntryCount(index) === 0) {
        throw new Error(
            `Dictionary "${index.title}" does not contain supported entries.`
        );
    }
    return {
        id,
        path: relativePath,
        enabled,
        favorite: false,
        recommendedId,
        title: index.title,
        revision: index.revision,
        isUpdatable: index.isUpdatable,
        indexUrl: index.indexUrl,
        downloadUrl: index.downloadUrl,
        language: index.sourceLanguage,
        termCount: index.termCount,
        frequencyCount: index.frequencyCount,
        pitchCount: index.pitchCount,
        kanjiCount: index.kanjiCount,
        frequencyMode: index.frequencyMode,
        installedAt: installedAtFromIndex(index, fallbackDate),
    };
}

function inflateZipEntry(contents: Buffer, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        inflateRaw(contents, { maxOutputLength: maxBytes }, (error, result) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(result);
        });
    });
}

async function readZipEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
    if (entry.uncompressedSize > maxBytes) {
        throw new Error(`Archive entry ${entry.fileName} is too large.`);
    }
    // Reading deflated data through yauzl's streaming inflater can stall on
    // highly-compressible Yomitan banks. Read the bounded compressed bytes first,
    // then inflate them with Node's buffered API and verify the declared size.
    const compressed = entry.compressionMethod === 8;
    const maxCompressedBytes = maxBytes + 64 * 1024;
    if (entry.compressedSize > maxCompressedBytes) {
        throw new Error(`Archive entry ${entry.fileName} is too large.`);
    }
    const contents = await new Promise<Buffer>((resolve, reject) => {
        const onOpen = (openError: Error | null, stream: Readable) => {
            if (openError || !stream) {
                reject(openError ?? new Error(`Could not open ${entry.fileName}.`));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxCompressedBytes) {
                    reject(new Error(`Archive entry ${entry.fileName} is too large.`));
                    stream.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            stream.once('error', reject);
            stream.once('end', () => resolve(Buffer.concat(chunks, size)));
        };
        if (compressed) {
            zip.openReadStream(
                entry,
                { decompress: false, decrypt: null, start: null, end: null },
                onOpen
            );
        } else {
            zip.openReadStream(entry, onOpen);
        }
    });
    const result = compressed
        ? await inflateZipEntry(contents, maxBytes)
        : contents;
    if (result.length !== entry.uncompressedSize) {
        throw new Error(
            `Archive entry ${entry.fileName} has an invalid uncompressed size.`
        );
    }
    return result;
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

function dictionaryBankContainsJapanese(
    value: unknown,
    bankType: 'term' | 'termMeta' | 'kanji'
): boolean {
    if (!Array.isArray(value)) {
        return false;
    }
    return value.some((entry) => {
        if (!Array.isArray(entry)) {
            return false;
        }
        const candidates = bankType === 'term' ? [entry[0], entry[1]] : [entry[0]];
        return candidates.some(
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
        let hasSupportedBank = false;
        let hasJapaneseEntry = false;
        let scannedBanks = 0;
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
            resolve({
                sourceLanguage,
                hasSupportedBank,
                hasJapaneseEntry,
            });
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
                } else {
                    const bankMatch = /^(term_bank|term_meta_bank|kanji_bank)_\d+\.json$/u.exec(
                        normalizedName
                    );
                    if (!bankMatch) {
                        zip.readEntry();
                        return;
                    }
                    const bankType =
                        bankMatch[1] === 'term_bank'
                            ? 'term'
                            : bankMatch[1] === 'term_meta_bank'
                              ? 'termMeta'
                              : 'kanji';
                    hasSupportedBank = true;
                    if (
                        sourceLanguage === null &&
                        !hasJapaneseEntry &&
                        scannedBanks < MAX_SCANNED_TERM_BANKS &&
                        entry.uncompressedSize <= MAX_TERM_BANK_BYTES
                    ) {
                        scannedBanks += 1;
                        const contents = await readZipEntry(zip, entry, MAX_TERM_BANK_BYTES);
                        const parsed: unknown = JSON.parse(
                            contents.toString('utf8').replace(/^\uFEFF/, '')
                        );
                        hasJapaneseEntry = dictionaryBankContainsJapanese(
                            parsed,
                            bankType
                        );
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
        termCount: normalizeCount(parsed.termCount),
        mediaCount: normalizeCount(parsed.mediaCount),
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
        let socket: WebSocket | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        const finish = (error: Error | null, dictionaryCount = 0) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            socket?.close();
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

        const connect = () => {
            if (settled) {
                return;
            }
            const nextSocket = new WebSocket(url);
            socket = nextSocket;
            let retryScheduled = false;
            const retry = () => {
                if (settled || retryScheduled) {
                    return;
                }
                retryScheduled = true;
                if (socket === nextSocket) {
                    socket = null;
                }
                try {
                    nextSocket.close();
                } catch {
                    // A connection attempt may fail before the socket can close cleanly.
                }
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    connect();
                }, RELOAD_CONNECT_RETRY_MS);
            };
            nextSocket.once('open', () => {
                try {
                    nextSocket.send(
                        JSON.stringify({
                            type: 'configure_features',
                            features: ['hoshidicts'],
                        })
                    );
                    nextSocket.send(
                        JSON.stringify({
                            type: 'hoshidicts_reload',
                            requestId,
                        })
                    );
                } catch {
                    retry();
                }
            });
            nextSocket.on('message', (data) => {
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
            nextSocket.once('error', retry);
            nextSocket.once('close', retry);
        };

        connect();
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
        writeCustomArchive: writeCustomDictionaryArchive,
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
    readonly audioProfilePath: string;
    readonly customDictionaryPath: string;

    private readonly deps: HoshidictsManagerDependencies;
    private operationQueue: Promise<void> = Promise.resolve();
    private snapshotQueue: Promise<void> = Promise.resolve();
    private snapshotRevision = 0;
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
        this.audioProfilePath = path.join(
            this.rootDir,
            HOSHIDICTS_AUDIO_PROFILE_FILE_NAME
        );
        this.customDictionaryPath = path.join(
            this.rootDir,
            HOSHIDICTS_CUSTOM_DICTIONARY_FILE_NAME
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
        const read = this.snapshotQueue.then(async () => await this.readSnapshot());
        this.snapshotQueue = read.then(
            () => undefined,
            () => undefined
        );
        return await read;
    }

    private async readSnapshot(): Promise<HoshidictsManagerSnapshot> {
        let manifest: PersistedManifest;
        let manifestError: string | null = null;
        try {
            manifest = await this.readManifest();
        } catch (error) {
            manifestError = errorMessage(error);
            manifest = await this.readManifestPreferences().catch(() => emptyManifest());
        }
        let miningProfile = defaultHoshidictsMiningProfile();
        let miningProfileError: string | null = null;
        try {
            miningProfile = await this.readMiningProfile();
        } catch (error) {
            miningProfileError = errorMessage(error);
        }
        let audioProfile = defaultHoshidictsAudioProfile();
        let audioProfileError: string | null = null;
        try {
            audioProfile = await this.readAudioProfile();
        } catch (error) {
            audioProfileError = errorMessage(error);
        }
        return this.snapshotFromManifest(
            manifest,
            miningProfile,
            audioProfile,
            manifestError ?? miningProfileError ?? audioProfileError
        );
    }

    async getCustomDictionaryDocument(): Promise<HoshidictsCustomDictionaryDocument> {
        return await this.enqueueRead(async () => {
            const source = await this.readCustomDictionarySource();
            return this.customDictionaryDocument(source);
        });
    }

    async saveCustomDictionary(
        text: string,
        expectedRevision: string
    ): Promise<HoshidictsCustomDictionaryDocument> {
        return await this.enqueue(
            'saving',
            async () => {
                const previous = await this.readCustomDictionarySource();
                if (
                    customDictionarySourceRevision(
                        previous.text,
                        previous.raw !== null
                    ) !== expectedRevision
                ) {
                    throw new Error(
                        'The custom dictionary changed after it was opened. Reload it before saving.'
                    );
                }
                const next = this.customDictionarySourceFromText(text, true);
                await this.applyCustomDictionarySource(next, previous, true);
                return this.customDictionaryDocument(next);
            },
            'custom'
        );
    }

    async addCustomEntry(
        entry: HoshidictsCustomEntryRequest
    ): Promise<HoshidictsCustomDictionaryDocument> {
        const serializedEntry = serializeCustomDictionaryEntry(entry);
        return await this.enqueue(
            'saving',
            async () => {
                // Read after entering the operation queue so simultaneous note saves append
                // to the latest successfully committed source.
                const previous = await this.readCustomDictionarySource();
                const newline = previous.text.includes('\r\n') ? '\r\n' : '\n';
                const separator =
                    previous.text.length === 0 || /[\r\n]$/u.test(previous.text)
                        ? ''
                        : newline;
                const next = this.customDictionarySourceFromText(
                    `${previous.text}${separator}${serializedEntry}${newline}`,
                    true
                );
                await this.applyCustomDictionarySource(next, previous, true);
                return this.customDictionaryDocument(next);
            },
            'custom'
        );
    }

    async syncCustomDictionary(): Promise<HoshidictsCustomDictionaryDocument> {
        return await this.enqueue(
            'saving',
            async () => {
                const source = await this.readCustomDictionarySource();
                await this.applyCustomDictionarySource(source, source, false);
                return this.customDictionaryDocument(source);
            },
            'custom'
        );
    }

    async importDictionary(archivePath: string): Promise<HoshidictsManagerSnapshot> {
        return await this.importDictionaries([archivePath]);
    }

    async importDictionaries(
        selectedArchivePaths: readonly string[]
    ): Promise<HoshidictsManagerSnapshot> {
        const archivePaths = [...selectedArchivePaths];
        if (archivePaths.length === 0) {
            throw new Error('No dictionary archives were selected.');
        }
        await this.enqueue('importing', async () => {
            let manifest = await this.readManifest();
            for (let index = 0; index < archivePaths.length; index += 1) {
                const archivePath = archivePaths[index];
                this.setProgress({
                    phase: 'importing',
                    title: path.basename(archivePath),
                    completed: index,
                    total: archivePaths.length,
                });
                const staged = await this.stageArchive(
                    archivePath,
                    manifest.dictionaries
                );
                try {
                    manifest = await this.installStagedDictionary(
                        manifest,
                        staged
                    );
                } catch (error) {
                    await this.discardStagedDictionaryIfUnreferenced(staged);
                    throw error;
                }
            }
            this.setProgress({
                phase: 'importing',
                completed: archivePaths.length,
                total: archivePaths.length,
            });
        });
        return await this.getSnapshot();
    }

    async applyYomitanDictionaryPreferences(
        preferences: readonly HoshidictsYomitanDictionaryPreference[]
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            const remaining = manifest.dictionaries.map((dictionary) => ({
                ...dictionary,
            }));
            const ordered: PersistedDictionary[] = [];
            for (const preference of preferences) {
                const index = remaining.findIndex(
                    (dictionary) => dictionary.title === preference.title
                );
                if (index < 0) {
                    continue;
                }
                const [dictionary] = remaining.splice(index, 1);
                ordered.push({ ...dictionary, enabled: preference.enabled });
            }
            const next = {
                ...manifest,
                dictionaries: [...ordered, ...remaining],
            };
            if (
                JSON.stringify(next.dictionaries) !==
                JSON.stringify(manifest.dictionaries)
            ) {
                await this.commitManifestChange(manifest, next, null, null);
            }
        }, 'dictionary');
        return await this.getSnapshot();
    }

    async installRecommendedDictionaries(): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('downloading', async () => {
            let manifest = await this.readManifest();
            const missing = RECOMMENDED_HOSHIDICTS_DICTIONARIES.filter(
                (recommended) =>
                    isDefaultRecommendedDictionary(recommended.id) &&
                    !manifestHasRecommendedDictionary(manifest, recommended)
            );
            for (let index = 0; index < missing.length; index += 1) {
                const recommended = missing[index];
                manifest = await this.installRecommendedDictionaryLocked(
                    manifest,
                    recommended,
                    index,
                    missing.length
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
            const installed = manifestHasRecommendedDictionary(
                manifest,
                recommended
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
            if (id === HOSHIDICTS_CUSTOM_DICTIONARY_ID) {
                throw new Error('The custom dictionary is managed from its editor.');
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
            if (id === HOSHIDICTS_CUSTOM_DICTIONARY_ID) {
                throw new Error('The custom dictionary is always enabled.');
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

    async setDictionaryPresentation(
        id: string,
        favorite: boolean
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            if (!SAFE_ID_PATTERN.test(id)) {
                throw new Error('Dictionary id is invalid.');
            }
            if (id === HOSHIDICTS_CUSTOM_DICTIONARY_ID) {
                throw new Error(
                    'The custom dictionary presentation is managed automatically.'
                );
            }
            if (typeof favorite !== 'boolean') {
                throw new Error('Dictionary favorite state is invalid.');
            }
            const manifest = await this.readManifest();
            const index = manifest.dictionaries.findIndex(
                (dictionary) => dictionary.id === id
            );
            if (index < 0) {
                throw new Error('Dictionary is not installed.');
            }
            const current = manifest.dictionaries[index];
            if (current.favorite === favorite) {
                return;
            }
            const dictionaries = manifest.dictionaries.map((dictionary) => ({
                ...dictionary,
            }));
            dictionaries[index].favorite = favorite;
            // Presentation is renderer-only. Avoid a native reload while still
            // using the manifest's atomic persistence path.
            await this.atomicWriteManifest({ ...manifest, dictionaries });
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
            if (id === HOSHIDICTS_CUSTOM_DICTIONARY_ID) {
                throw new Error('The custom dictionary is always first.');
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
            if (
                manifest.dictionaries[targetIndex].id ===
                HOSHIDICTS_CUSTOM_DICTIONARY_ID
            ) {
                throw new Error('The custom dictionary is always first.');
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

    async moveDictionaryToPosition(
        id: string,
        position: number
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            if (!SAFE_ID_PATTERN.test(id)) {
                throw new Error('Dictionary id is invalid.');
            }
            if (id === HOSHIDICTS_CUSTOM_DICTIONARY_ID) {
                throw new Error('The custom dictionary is always first.');
            }
            if (!Number.isInteger(position) || position < 1) {
                throw new Error('Dictionary position is invalid.');
            }
            const manifest = await this.readManifest();
            const currentIndex = manifest.dictionaries.findIndex(
                (dictionary) => dictionary.id === id
            );
            if (currentIndex < 0) {
                throw new Error('Dictionary is not installed.');
            }
            if (position > manifest.dictionaries.length) {
                throw new Error(
                    `Dictionary position must be between 1 and ${manifest.dictionaries.length}.`
                );
            }
            const targetIndex = position - 1;
            if (currentIndex === targetIndex) {
                return;
            }
            if (
                manifest.dictionaries[targetIndex].id ===
                HOSHIDICTS_CUSTOM_DICTIONARY_ID
            ) {
                throw new Error('The custom dictionary is always first.');
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
        await this.enqueue('saving', async () => {
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
        }, 'preferences');
        return await this.getSnapshot();
    }

    async setMiningProfile(value: unknown): Promise<HoshidictsManagerSnapshot> {
        const profile = normalizeHoshidictsMiningProfile(value);
        await this.enqueue('saving', async () => {
            await this.atomicWriteMiningProfile(profile);
        }, 'mining');
        return await this.getSnapshot();
    }

    async setAudioProfile(value: unknown): Promise<HoshidictsManagerSnapshot> {
        const profile = normalizeHoshidictsAudioProfile(value);
        await this.enqueue('saving', async () => {
            await this.atomicWriteAudioProfile(profile);
        }, 'audio');
        return await this.getSnapshot();
    }

    async setLookupMode(
        lookupMode: HoshidictsLookupMode
    ): Promise<HoshidictsManagerSnapshot> {
        if (lookupMode !== 'shift' && lookupMode !== 'hover') {
            throw new Error('Hoshidicts lookup mode is invalid.');
        }
        const snapshot = await this.getSnapshot();
        return await this.setReaderPreferences(
            lookupMode,
            snapshot.popupHideDelayMs,
            snapshot.activationKey,
            snapshot.sourceHighlightEnabled,
            snapshot.popupNestingMaxDepth,
            undefined,
            snapshot.showLookupCounts
        );
    }

    async setReaderPreferences(
        lookupMode: HoshidictsLookupMode,
        popupHideDelayMs: number,
        activationKey: HoshidictsActivationKey,
        sourceHighlightEnabled: boolean =
            DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
        popupNestingMaxDepth: number =
            DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
        definitionBlur?: HoshidictsDefinitionBlurPreferences,
        showLookupCounts = true
    ): Promise<HoshidictsManagerSnapshot> {
        if (lookupMode !== 'shift' && lookupMode !== 'hover') {
            throw new Error('Hoshidicts lookup mode is invalid.');
        }
        if (
            !Number.isInteger(popupHideDelayMs) ||
            popupHideDelayMs < 0 ||
            popupHideDelayMs > MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS
        ) {
            throw new Error('Hoshidicts popup hide delay is invalid.');
        }
        if (!isHoshidictsActivationKey(activationKey)) {
            throw new Error('Hoshidicts activation key is invalid.');
        }
        if (typeof sourceHighlightEnabled !== 'boolean') {
            throw new Error(
                'Hoshidicts source highlight preference is invalid.'
            );
        }
        if (typeof showLookupCounts !== 'boolean') {
            throw new Error('Hoshidicts lookup count preference is invalid.');
        }
        if (
            !Number.isSafeInteger(popupNestingMaxDepth) ||
            popupNestingMaxDepth < 0
        ) {
            throw new Error('Hoshidicts popup nesting depth is invalid.');
        }
        if (
            definitionBlur !== undefined &&
            typeof definitionBlur.enabled !== 'boolean'
        ) {
            throw new Error(
                'Hoshidicts definition blur enabled state is invalid.'
            );
        }
        if (
            definitionBlur !== undefined &&
            (!Number.isInteger(definitionBlur.lookupThreshold) ||
                definitionBlur.lookupThreshold <
                    MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD ||
                definitionBlur.lookupThreshold >
                    MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD)
        ) {
            throw new Error(
                'Hoshidicts definition blur lookup threshold is invalid.'
            );
        }
        if (
            definitionBlur !== undefined &&
            definitionBlur.revealMode !== 'timed' &&
            definitionBlur.revealMode !== 'hover'
        ) {
            throw new Error('Hoshidicts definition blur reveal mode is invalid.');
        }
        if (
            definitionBlur !== undefined &&
            (!Number.isInteger(definitionBlur.revealDelayMs) ||
                definitionBlur.revealDelayMs <
                    MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS ||
                definitionBlur.revealDelayMs >
                    MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS)
        ) {
            throw new Error(
                'Hoshidicts definition blur reveal delay is invalid.'
            );
        }
        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            const effectiveDefinitionBlur =
                definitionBlur ?? manifest.definitionBlur;
            if (
                manifest.lookupMode !== lookupMode ||
                manifest.popupHideDelayMs !== popupHideDelayMs ||
                manifest.activationKey !== activationKey ||
                manifest.sourceHighlightEnabled !== sourceHighlightEnabled ||
                manifest.showLookupCounts !== showLookupCounts ||
                manifest.popupNestingMaxDepth !== popupNestingMaxDepth ||
                !definitionBlurPreferencesEqual(
                    manifest.definitionBlur,
                    effectiveDefinitionBlur
                )
            ) {
                await this.atomicWriteManifest({
                    ...manifest,
                    lookupMode,
                    activationKey,
                    sourceHighlightEnabled,
                    popupHideDelayMs,
                    showLookupCounts,
                    popupNestingMaxDepth,
                    definitionBlur: { ...effectiveDefinitionBlur },
                });
            }
        }, 'preferences');
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
                        const recommendation =
                            recommendedDictionaryForPersisted(current);
                        const staged = await this.stageArchive(
                            archivePath,
                            manifest.dictionaries,
                            current.id,
                            recommendation
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
        operation: () => Promise<T>,
        scope: HoshidictsProgress['scope'] = 'dictionary'
    ): Promise<T> {
        const run = this.operationQueue.then(async () => {
            this.runtimeError = null;
            this.setProgress({ phase: initialPhase, scope });
            try {
                return await operation();
            } catch (error) {
                this.runtimeError = errorMessage(error);
                throw error;
            } finally {
                this.setProgress({ phase: 'idle', scope });
            }
        });
        this.operationQueue = run.then(
            () => undefined,
            () => undefined
        );
        return await run;
    }

    private async enqueueRead<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.operationQueue.then(operation);
        this.operationQueue = run.then(
            () => undefined,
            () => undefined
        );
        return await run;
    }

    private setProgress(progress: HoshidictsProgress): void {
        const scope = progress.scope ?? this.progress.scope;
        this.progress = scope ? { ...progress, scope } : progress;
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
        audioProfile: HoshidictsAudioProfile,
        profileError: string | null = null
    ): HoshidictsManagerSnapshot {
        const customDictionary = manifest.dictionaries.find(
            (dictionary) => dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID
        );
        return {
            revision: ++this.snapshotRevision,
            dictionaries: manifest.dictionaries
                .filter(
                    (dictionary) =>
                        dictionary.id !== HOSHIDICTS_CUSTOM_DICTIONARY_ID
                )
                .map(
                    ({
                        id,
                        title,
                        enabled,
                        favorite,
                        revision,
                        isUpdatable,
                        indexUrl,
                        downloadUrl,
                        language,
                        termCount,
                        frequencyCount,
                        pitchCount,
                        kanjiCount,
                        frequencyMode,
                        installedAt,
                    }) => ({
                        id,
                        title,
                        enabled,
                        favorite,
                        revision,
                        isUpdatable,
                        indexUrl,
                        downloadUrl,
                        language,
                        termCount,
                        frequencyCount,
                        pitchCount,
                        kanjiCount,
                        frequencyMode,
                        installedAt,
                    })
                ),
            customDictionaryActive: customDictionary?.enabled === true,
            recommendedDictionaries: recommendedDictionaryStates(manifest),
            miningProfile,
            audioProfile,
            lookupMode: manifest.lookupMode,
            activationKey: manifest.activationKey,
            sourceHighlightEnabled: manifest.sourceHighlightEnabled,
            popupHideDelayMs: manifest.popupHideDelayMs,
            showLookupCounts: manifest.showLookupCounts,
            popupNestingMaxDepth: manifest.popupNestingMaxDepth,
            definitionBlur: { ...manifest.definitionBlur },
            schedule: manifest.schedule,
            lastCheck: manifest.lastCheck,
            nextCheck: manifest.nextCheck,
            lastError: this.runtimeError ?? profileError ?? manifest.lastError,
            busy: this.progress.phase !== 'idle',
            progress: { ...this.progress },
        };
    }

    private validateCustomDictionaryText(text: string): void {
        if (typeof text !== 'string') {
            throw new Error('Custom dictionary text must be a string.');
        }
        if (
            Buffer.byteLength(text, 'utf8') >
            MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES
        ) {
            throw new Error('Custom dictionary file exceeded its size limit.');
        }
    }

    private customDictionarySourceFromText(
        text: string,
        exists: boolean
    ): CustomDictionarySource {
        this.validateCustomDictionaryText(text);
        return {
            text,
            raw: exists ? Buffer.from(text, 'utf8') : null,
            parsed: parseCustomDictionary(text),
        };
    }

    private async readCustomDictionarySource(): Promise<CustomDictionarySource> {
        let handle: fsp.FileHandle | null = null;
        let raw: Buffer;
        try {
            const openFlags =
                fsConstants.O_RDONLY |
                (process.platform === 'win32' ? 0 : fsConstants.O_NONBLOCK);
            handle = await fsp.open(this.customDictionaryPath, openFlags);
            const stat = await handle.stat();
            if (
                !stat.isFile() ||
                stat.size > MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES
            ) {
                throw new Error(
                    'Custom dictionary is oversized or is not a regular file.'
                );
            }
            raw = await handle.readFile();
            if (raw.length > MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES) {
                throw new Error('Custom dictionary file exceeded its size limit.');
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return this.customDictionarySourceFromText('', false);
            }
            throw error;
        } finally {
            await handle?.close();
        }

        let text: string;
        try {
            text = new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: true,
            }).decode(raw);
        } catch {
            throw new Error('Custom dictionary must contain valid UTF-8 text.');
        }
        return {
            text,
            raw,
            parsed: parseCustomDictionary(text),
        };
    }

    private customDictionaryDocument(
        source: CustomDictionarySource
    ): HoshidictsCustomDictionaryDocument {
        return {
            text: source.text,
            revision: customDictionarySourceRevision(
                source.text,
                source.raw !== null
            ),
            exists: source.raw !== null,
            filePath: this.customDictionaryPath,
        };
    }

    private async stageCustomDictionary(
        source: CustomDictionarySource,
        manifest: PersistedManifest
    ): Promise<StagedDictionary> {
        const archiveRoot = path.join(
            this.rootDir,
            '.staging',
            `custom-${this.deps.randomId()}`
        );
        const archivePath = path.join(archiveRoot, 'custom-dictionary.zip');
        try {
            await this.deps.writeCustomArchive(
                archivePath,
                HOSHIDICTS_CUSTOM_DICTIONARY_TITLE,
                source.parsed.semanticRevision,
                source.parsed.entries
            );
            const existing = manifest.dictionaries.some(
                (dictionary) =>
                    dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID
            );
            const staged = await this.stageArchive(
                archivePath,
                manifest.dictionaries,
                existing ? HOSHIDICTS_CUSTOM_DICTIONARY_ID : undefined,
                null,
                true
            );
            if (
                staged.dictionary.revision !== source.parsed.semanticRevision ||
                staged.dictionary.termCount !== source.parsed.entries.length
            ) {
                await this.discardStagedDictionary(staged);
                throw new Error(
                    'Compiled custom dictionary did not match its source entries.'
                );
            }
            return staged;
        } finally {
            await fsp.rm(archiveRoot, { recursive: true, force: true });
        }
    }

    private async applyCustomDictionarySource(
        source: CustomDictionarySource,
        previousSource: CustomDictionarySource,
        writeSource: boolean
    ): Promise<void> {
        const manifest = await this.readManifest();
        const existingIndex = manifest.dictionaries.findIndex(
            (dictionary) => dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID
        );
        const existing = manifest.dictionaries[existingIndex];
        const needsGeneration =
            source.parsed.entries.length > 0 &&
            (!existing ||
                existing.title !== HOSHIDICTS_CUSTOM_DICTIONARY_TITLE ||
                existing.revision !== source.parsed.semanticRevision);
        const needsPin =
            existing !== undefined &&
            (existingIndex !== 0 || existing.enabled !== true);
        let staged: StagedDictionary | null = null;
        if (needsGeneration) {
            staged = await this.stageCustomDictionary(source, manifest);
        }

        const sourceChanged =
            writeSource && !customSourcesMatch(source, previousSource);
        try {
            if (writeSource) {
                const currentSource = await this.readCustomDictionarySource();
                if (!customSourcesMatch(currentSource, previousSource)) {
                    throw new Error(
                        'The custom dictionary changed while the update was being prepared. Try again.'
                    );
                }
                if (sourceChanged && source.raw) {
                    await this.atomicWriteBuffer(
                        source.raw,
                        this.customDictionaryPath,
                        '.custom-dictionary-'
                    );
                }
            }
        } catch (error) {
            if (staged) {
                await this.discardStagedDictionary(staged);
            }
            throw error;
        }

        try {
            if (source.parsed.entries.length === 0 && existing) {
                const next: PersistedManifest = {
                    ...manifest,
                    dictionaries: manifest.dictionaries.filter(
                        (dictionary) =>
                            dictionary.id !== HOSHIDICTS_CUSTOM_DICTIONARY_ID
                    ),
                };
                await this.commitManifestChange(
                    manifest,
                    next,
                    null,
                    existing.path
                );
            } else if (staged) {
                await this.installStagedDictionary(manifest, staged);
            } else if (needsPin) {
                await this.commitManifestChange(
                    manifest,
                    pinCustomDictionary(manifest),
                    null,
                    null
                );
            }
        } catch (error) {
            let sourceRollbackError: unknown = null;
            const manifestKeptNewSource =
                error instanceof ManifestCommitError &&
                !error.manifestRollbackRestored;
            if (sourceChanged && !manifestKeptNewSource) {
                try {
                    await this.restoreCustomDictionarySource(previousSource.raw);
                } catch (rollbackError) {
                    sourceRollbackError = rollbackError;
                }
            }
            if (staged) {
                await this.discardStagedDictionaryIfUnreferenced(staged);
            }
            if (sourceRollbackError) {
                throw new Error(
                    `Custom dictionary update failed and its source rollback failed: ${errorMessage(
                        error
                    )}. Source rollback error: ${errorMessage(sourceRollbackError)}`
                );
            }
            throw error;
        }
    }

    private async restoreCustomDictionarySource(raw: Buffer | null): Promise<void> {
        if (raw === null) {
            await fsp.rm(this.customDictionaryPath, { force: true });
            return;
        }
        await this.atomicWriteBuffer(
            raw,
            this.customDictionaryPath,
            '.custom-dictionary-rollback-'
        );
    }

    private async readMiningProfile(): Promise<HoshidictsMiningProfile> {
        return normalizeHoshidictsMiningProfile(
            await readBoundedJsonFile(
                this.miningProfilePath,
                MAX_MINING_PROFILE_BYTES,
                'Hoshidicts mining profile',
                defaultHoshidictsMiningProfile
            )
        );
    }

    private async readAudioProfile(): Promise<HoshidictsAudioProfile> {
        return normalizeHoshidictsAudioProfile(
            await readBoundedJsonFile(
                this.audioProfilePath,
                MAX_AUDIO_PROFILE_BYTES,
                'Hoshidicts audio profile',
                defaultHoshidictsAudioProfile
            )
        );
    }

    private async readManifest(): Promise<PersistedManifest> {
        const parsed = await readBoundedJsonFile(
            this.manifestPath,
            MAX_MANIFEST_BYTES,
            'Hoshidicts manifest',
            emptyManifest
        );
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
            const recommendedId = isRecommendedDictionaryId(value.recommendedId)
                ? value.recommendedId
                : null;
            await validateNativeMediaFiles(dictionaryPath, index.mediaCount);
            dictionaries.push({
                ...dictionaryStateFromIndex(
                    value.id,
                    relativePath,
                    value.enabled !== false,
                    index,
                    this.deps.now(),
                    recommendedId
                ),
                favorite: value.favorite === true,
            });
        }

        return {
            version: MANIFEST_VERSION,
            lookupMode: parsed.lookupMode === 'hover' ? 'hover' : 'shift',
            activationKey: isHoshidictsActivationKey(parsed.activationKey)
                ? parsed.activationKey
                : DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
            sourceHighlightEnabled: parsed.sourceHighlightEnabled === true,
            popupHideDelayMs: normalizePopupHideDelay(parsed.popupHideDelayMs),
            showLookupCounts: parsed.showLookupCounts !== false,
            popupNestingMaxDepth: normalizePopupNestingMaxDepth(
                parsed.popupNestingMaxDepth
            ),
            definitionBlur: normalizeDefinitionBlur(parsed.definitionBlur),
            schedule: normalizeSchedule(parsed.schedule),
            lastCheck: normalizeDate(parsed.lastCheck),
            nextCheck: normalizeDate(parsed.nextCheck),
            lastError: normalizeOptionalString(parsed.lastError),
            dictionaries,
        };
    }

    private async readManifestPreferences(): Promise<PersistedManifest> {
        const parsed = await readBoundedJsonFile(
            this.manifestPath,
            MAX_MANIFEST_BYTES,
            'Hoshidicts manifest',
            emptyManifest
        );
        if (!isRecord(parsed) || parsed.version !== MANIFEST_VERSION) {
            throw new Error('Hoshidicts manifest has an unsupported version.');
        }
        return {
            version: MANIFEST_VERSION,
            lookupMode: parsed.lookupMode === 'hover' ? 'hover' : 'shift',
            activationKey: isHoshidictsActivationKey(parsed.activationKey)
                ? parsed.activationKey
                : DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
            sourceHighlightEnabled: parsed.sourceHighlightEnabled === true,
            popupHideDelayMs: normalizePopupHideDelay(parsed.popupHideDelayMs),
            showLookupCounts: parsed.showLookupCounts !== false,
            popupNestingMaxDepth: normalizePopupNestingMaxDepth(
                parsed.popupNestingMaxDepth
            ),
            definitionBlur: normalizeDefinitionBlur(parsed.definitionBlur),
            schedule: normalizeSchedule(parsed.schedule),
            lastCheck: normalizeDate(parsed.lastCheck),
            nextCheck: normalizeDate(parsed.nextCheck),
            lastError: normalizeOptionalString(parsed.lastError),
            dictionaries: [],
        };
    }

    private async stageArchive(
        archivePath: string,
        installedDictionaries: PersistedDictionary[] = [],
        expectedId?: string,
        recommended: RecommendedHoshidictsDictionary | null = null,
        customDictionary = false
    ): Promise<StagedDictionary> {
        const inspection = await this.deps.inspectArchive(archivePath);
        const explicitLanguage = inspection.sourceLanguage?.toLowerCase() ?? null;
        if (explicitLanguage !== null && explicitLanguage !== 'ja') {
            throw new Error(
                `Dictionary source language must be ja, not ${inspection.sourceLanguage}.`
            );
        }
        if (!inspection.hasSupportedBank) {
            throw new Error('Dictionary archive does not contain supported entries.');
        }
        if (
            explicitLanguage === null &&
            !inspection.hasJapaneseEntry &&
            recommended === null
        ) {
            throw new Error(
                'Legacy dictionaries without sourceLanguage must contain Japanese entries.'
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
            if (!report.title) {
                throw new Error('Dictionary archive does not contain supported entries.');
            }
            const directoryName = dictionaryDirectoryName(report.title);
            const outputDictionaryPath = path.join(outputDir, directoryName);
            await validateNativeDictionaryFiles(outputDictionaryPath);
            const index = await readGeneratedIndex(outputDictionaryPath);
            await validateNativeMediaFiles(
                outputDictionaryPath,
                Math.max(index.mediaCount, normalizeCount(report.mediaCount))
            );
            if (index.title !== report.title) {
                throw new Error('Imported dictionary title did not match generated index.json.');
            }
            if (generatedIndexEntryCount(index) === 0) {
                throw new Error('Dictionary archive does not contain supported entries.');
            }
            const generatedLanguage = index.sourceLanguage?.toLowerCase() ?? null;
            if (generatedLanguage !== null && generatedLanguage !== 'ja') {
                throw new Error(
                    `Dictionary source language must be ja, not ${index.sourceLanguage}.`
                );
            }

            const generatedId = stableHoshidictsDictionaryId(index.title);
            if (
                customDictionary &&
                index.title !== HOSHIDICTS_CUSTOM_DICTIONARY_TITLE
            ) {
                throw new Error('Compiled custom dictionary identity did not match.');
            }
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
                  : installedDictionaries.find(
                        (dictionary) => dictionary.id === generatedId
                    );
            if (expectedId && !existing) {
                throw new Error('Updated dictionary is not installed.');
            }
            const associatedRecommendation =
                recommended ??
                (existing ? recommendedDictionaryForPersisted(existing) : null);
            if (
                associatedRecommendation &&
                !generatedIndexMatchesKind(index, associatedRecommendation.kind)
            ) {
                throw new Error(
                    `Downloaded ${associatedRecommendation.id} archive did not contain ${associatedRecommendation.kind} entries.`
                );
            }
            if (
                associatedRecommendation &&
                !generatedIndexMatchesRecommendationIdentity(
                    index,
                    associatedRecommendation
                )
            ) {
                throw new Error(
                    `Downloaded ${associatedRecommendation.id} archive did not match its trusted identity.`
                );
            }
            if (existing && !customDictionary) {
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
            const id = customDictionary
                ? HOSHIDICTS_CUSTOM_DICTIONARY_ID
                : (existing?.id ?? generatedId);
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
            const dictionary = dictionaryStateFromIndex(
                id,
                relativePath,
                true,
                index,
                this.deps.now(),
                associatedRecommendation?.id ?? null
            );
            await fsp.mkdir(finalGenerationRoot, { recursive: true });
            await fsp.rename(outputDictionaryPath, finalDictionaryPath);
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
                favorite: dictionaries[existingIndex].favorite,
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
                manifest.dictionaries,
                undefined,
                recommended
            );
            const identityMatches =
                recommended.indexUrl !== null
                    ? parseHttpsUrl(staged.dictionary.indexUrl) ===
                      recommended.indexUrl
                    : staged.dictionary.title === recommended.expectedTitle;
            if (!identityMatches) {
                await this.discardStagedDictionary(staged);
                throw new Error(
                    `Downloaded ${recommended.id} archive did not match its trusted identity.`
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
        next = pinCustomDictionary(next);
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
                throw new ManifestCommitError(
                    `Native Hoshidicts reload failed and manifest rollback failed: ${errorMessage(
                        reloadError
                    )}. The new dictionary generation was retained for recovery. Rollback error: ${errorMessage(
                        rollbackError
                    )}`,
                    false
                );
            }
            const suffix = rollbackError
                ? ` Native rollback reload also failed: ${errorMessage(rollbackError)}.`
                : '';
            throw new ManifestCommitError(
                `Native Hoshidicts reload failed; the previous dictionaries were restored: ${errorMessage(
                    reloadError
                )}.${suffix}`,
                true
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
        await this.atomicWriteJson(
            manifest,
            this.manifestPath,
            MAX_MANIFEST_BYTES,
            'Hoshidicts manifest',
            '.manifest-'
        );
    }

    private async atomicWriteMiningProfile(
        profile: HoshidictsMiningProfile
    ): Promise<void> {
        await this.atomicWriteJson(
            profile,
            this.miningProfilePath,
            MAX_MINING_PROFILE_BYTES,
            'Hoshidicts mining profile',
            '.mining-profile-'
        );
    }

    private async atomicWriteAudioProfile(
        profile: HoshidictsAudioProfile
    ): Promise<void> {
        await this.atomicWriteJson(
            profile,
            this.audioProfilePath,
            MAX_AUDIO_PROFILE_BYTES,
            'Hoshidicts audio profile',
            '.audio-profile-'
        );
    }

    private async atomicWriteJson(
        value: unknown,
        destination: string,
        maximumBytes: number,
        label: string,
        temporaryPrefix: string
    ): Promise<void> {
        const serialized = Buffer.from(
            `${JSON.stringify(value, null, 2)}\n`,
            'utf8'
        );
        if (serialized.length > maximumBytes) {
            throw new Error(`${label} exceeded its size limit.`);
        }
        await this.atomicWriteBuffer(serialized, destination, temporaryPrefix);
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

export async function startHoshidictsManager(): Promise<void> {
    const manager = getHoshidictsManager();
    manager.startScheduler();
}

export async function stopHoshidictsManager(): Promise<void> {
    if (defaultManager) {
        await defaultManager.stopScheduler();
    }
}
