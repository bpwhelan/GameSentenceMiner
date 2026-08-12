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
    HoshidictsDictionaryTabGroup,
    HoshidictsDictionaryState,
    HoshidictsFrequencyMode,
    HoshidictsManagerSnapshot,
    HoshidictsLookupMode,
    HoshidictsMiningProfile,
    HoshidictsProgress,
    HoshidictsProgressPhase,
    HoshidictsReaderPreferencesRequest,
    HoshidictsRecommendedDictionaryId,
    HoshidictsRecommendedDictionaryState,
    HoshidictsSchedule,
    HoshidictsYomitanDictionaryPreference,
} from '../../../shared/features/hoshidicts.js';
import {
    MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES,
    MAX_HOSHIDICTS_PROFILE_NAME_LENGTH,
    MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH,
    assertHoshidictsReaderPreferences,
    createDefaultHoshidictsReaderPreferences,
    hoshidictsReaderPreferencesEqual,
    normalizeHoshidictsReaderPreferences,
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
import {
    commitPreparedHoshidictsBackupRestore,
    disposePreparedHoshidictsBackupRestore,
    exportHoshidictsBackup,
    prepareHoshidictsBackupRestore,
} from './hoshidicts-backup.js';

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
    HoshidictsDictionaryTabGroup,
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
    HoshidictsSortFrequencyDictionaryOrder,
} from '../../../shared/features/hoshidicts.js';

interface PersistedDictionary extends HoshidictsDictionaryState {
    path: string;
    enabled: boolean;
    displayName: string | null;
    recommendedId: HoshidictsRecommendedDictionaryId | null;
}

type PersistedReaderPreferences = HoshidictsReaderPreferencesRequest;

interface PersistedSettingsProfile {
    id: string;
    name: string;
    reader: PersistedReaderPreferences;
    mining: HoshidictsMiningProfile;
    audio: HoshidictsAudioProfile;
    tabGroups: HoshidictsDictionaryTabGroup[];
    enabledDictionaryIds: string[];
}

/**
 * The active profile owns every setting; the manifest never mirrors its reader
 * preferences, so there is nothing to keep in sync.
 */
interface PersistedManifest {
    version: 1;
    activeProfileId: string;
    profiles: PersistedSettingsProfile[];
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
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    schedulerMaxDelayMs: number;
}

const MANIFEST_FILE_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;
const MAX_GENERATED_INDEX_BYTES = 1024 * 1024;
// Matches MAX_PROFILE_BYTES in the Python backend, which reads these files.
const MAX_BACKEND_PROFILE_BYTES = 64 * 1024;
const MAX_TAB_GROUP_COUNT = 256;
const MAX_TAB_GROUP_DICTIONARIES = 256;
const MAX_ARCHIVE_INDEX_BYTES = 1024 * 1024;
const MAX_TERM_BANK_BYTES = 32 * 1024 * 1024;
const MAX_SCANNED_TERM_BANKS = 32;
const MAX_REMOTE_INDEX_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_IMPORT_OUTPUT_BYTES = 1024 * 1024;
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
const RELOAD_TIMEOUT_MS = 15 * 1000;
const RELOAD_CONNECT_RETRY_MS = 100;
const SCHEDULER_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const REQUIRED_DICTIONARY_FILES = ['hash.table', 'bloom.filter', 'blobs.bin'] as const;
const REQUIRED_MEDIA_FILES = ['media.idx', 'media.bin'] as const;
const HOSHIDICTS_MARKERS = [
    '.hoshidicts_4',
    '.hoshidicts_3',
    '.hoshidicts_2',
    '.hoshidicts_1',
] as const;
const JAPANESE_TEXT_PATTERN =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const INVALID_DICTIONARY_DISPLAY_NAME_PATTERN = /[\p{Cc}\p{Cf}]/u;
const MAX_DICTIONARY_DISPLAY_NAME_CODE_POINTS = 128;

interface PersistedTabGroups {
    version: 1;
    groups: HoshidictsDictionaryTabGroup[];
}

type RecommendedHoshidictsDictionaryKind =
    | 'term'
    | 'frequency'
    | 'pitch'
    | 'kanji';

/** Reads a JSON file this manager wrote, so only its presence is checked. */
async function readJsonFile(
    filePath: string,
    label: string,
    defaultValue: () => unknown
): Promise<unknown> {
    let raw: string;
    try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile() || stat.size === 0) {
            throw new Error(`${label} is empty or not a file.`);
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

const HOSHIDICTS_CUSTOM_DICTIONARY_FILE_NAME = 'custom-dictionary.txt';
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
    hourly: 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
};

function emptyManifest(): PersistedManifest {
    const profile: PersistedSettingsProfile = {
        id: 'default',
        name: 'Default',
        reader: createDefaultHoshidictsReaderPreferences(),
        mining: defaultHoshidictsMiningProfile(),
        audio: defaultHoshidictsAudioProfile(),
        tabGroups: [],
        enabledDictionaryIds: [],
    };
    return {
        version: MANIFEST_VERSION,
        activeProfileId: profile.id,
        profiles: [profile],
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

function tabGroupNameKey(name: string): string {
    return name.normalize('NFC').trim().toLowerCase();
}

function normalizeTabGroupName(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('Tab group name is invalid.');
    }
    const name = value.normalize('NFC').trim();
    if (!name) {
        throw new Error('Tab group name cannot be empty.');
    }
    if (name.length > MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH) {
        throw new Error('Tab group name is too long.');
    }
    if (tabGroupNameKey(name) === 'all') {
        throw new Error('Tab group name cannot be All.');
    }
    return name;
}

function normalizePersistedTabGroups(value: unknown): PersistedTabGroups {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.groups)) {
        throw new Error('Hoshidicts tab groups file is invalid.');
    }
    if (value.groups.length > MAX_TAB_GROUP_COUNT) {
        throw new Error('Hoshidicts tab groups file has too many groups.');
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    const groups = value.groups.map((candidate) => {
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== 'string' ||
            !SAFE_ID_PATTERN.test(candidate.id) ||
            !Array.isArray(candidate.dictionaryIds)
        ) {
            throw new Error('Hoshidicts tab group is invalid.');
        }
        const name = normalizeTabGroupName(candidate.name);
        const nameKey = tabGroupNameKey(name);
        if (ids.has(candidate.id) || names.has(nameKey)) {
            throw new Error('Hoshidicts tab groups must have unique names and ids.');
        }
        ids.add(candidate.id);
        names.add(nameKey);
        const dictionaryIds = Array.from(
            new Set(
                candidate.dictionaryIds.map((dictionaryId) => {
                    if (
                        typeof dictionaryId !== 'string' ||
                        !SAFE_ID_PATTERN.test(dictionaryId)
                    ) {
                        throw new Error('Hoshidicts tab group dictionary id is invalid.');
                    }
                    return dictionaryId;
                })
            )
        );
        if (dictionaryIds.length > MAX_TAB_GROUP_DICTIONARIES) {
            throw new Error('Hoshidicts tab group has too many dictionaries.');
        }
        return { id: candidate.id, name, dictionaryIds };
    });
    return { version: 1, groups };
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
    return value === 'hourly' ||
        value === 'daily' ||
        value === 'weekly' ||
        value === 'monthly'
        ? value
        : 'off';
}

function normalizeScheduleOverride(value: unknown): HoshidictsSchedule | null {
    return value === 'off' ||
        value === 'hourly' ||
        value === 'daily' ||
        value === 'weekly' ||
        value === 'monthly'
        ? value
        : null;
}

function normalizeProfileName(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('Profile name is invalid.');
    }
    const name = value.normalize('NFC').trim();
    if (!name) {
        throw new Error('Profile name cannot be empty.');
    }
    if (name.length > MAX_HOSHIDICTS_PROFILE_NAME_LENGTH) {
        throw new Error('Profile name is too long.');
    }
    return name;
}

function profileNameKey(name: string): string {
    return name.normalize('NFC').trim().toLowerCase();
}

function normalizeReaderPreferences(
    value: unknown,
    dictionaries: readonly PersistedDictionary[],
    enabledDictionaryIds: ReadonlySet<string>
): PersistedReaderPreferences {
    if (!isRecord(value)) {
        throw new Error('Hoshidicts profile reader settings are invalid.');
    }
    const reader = normalizeHoshidictsReaderPreferences(value);
    return {
        ...reader,
        sortFrequencyDictionary: usableSortFrequencyDictionary(
            reader.sortFrequencyDictionary,
            dictionaries,
            (dictionary) => enabledDictionaryIds.has(dictionary.id)
        ),
    };
}

/** Frequency sorting only works while its dictionary is installed and enabled. */
function usableSortFrequencyDictionary(
    title: string | null,
    dictionaries: readonly PersistedDictionary[],
    isEnabled: (dictionary: PersistedDictionary) => boolean = (dictionary) =>
        dictionary.enabled
): string | null {
    return title !== null &&
        dictionaries.some(
            (dictionary) =>
                dictionary.title === title &&
                isEnabled(dictionary) &&
                dictionary.frequencyCount > 0
        )
        ? title
        : null;
}

function normalizePersistedProfiles(
    value: unknown,
    activeProfileId: unknown,
    dictionaries: readonly PersistedDictionary[]
): { activeProfileId: string; profiles: PersistedSettingsProfile[] } {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('Hoshidicts profiles are invalid.');
    }
    const installedIds = new Set(dictionaries.map(({ id }) => id));
    const ids = new Set<string>();
    const names = new Set<string>();
    const profiles = value.map((candidate): PersistedSettingsProfile => {
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== 'string' ||
            !SAFE_ID_PATTERN.test(candidate.id) ||
            !Array.isArray(candidate.enabledDictionaryIds)
        ) {
            throw new Error('Hoshidicts profile is invalid.');
        }
        const name = normalizeProfileName(candidate.name);
        const nameKey = profileNameKey(name);
        if (ids.has(candidate.id) || names.has(nameKey)) {
            throw new Error('Hoshidicts profiles must have unique names and ids.');
        }
        ids.add(candidate.id);
        names.add(nameKey);
        const enabledDictionaryIds = Array.from(
            new Set(
                candidate.enabledDictionaryIds.map((id) => {
                    if (typeof id !== 'string' || !SAFE_ID_PATTERN.test(id)) {
                        throw new Error(
                            'Hoshidicts profile dictionary id is invalid.'
                        );
                    }
                    return id;
                })
            )
        ).filter(
            (id) =>
                id !== HOSHIDICTS_CUSTOM_DICTIONARY_ID &&
                installedIds.has(id)
        );
        const enabledIds = new Set(enabledDictionaryIds);
        const tabGroups = normalizePersistedTabGroups({
            version: 1,
            groups: candidate.tabGroups,
        }).groups.map((group) => ({
            ...group,
            dictionaryIds: group.dictionaryIds.filter((id) =>
                installedIds.has(id)
            ),
        }));
        return {
            id: candidate.id,
            name,
            reader: normalizeReaderPreferences(
                candidate.reader,
                dictionaries,
                enabledIds
            ),
            mining: normalizeHoshidictsMiningProfile(candidate.mining),
            audio: normalizeHoshidictsAudioProfile(candidate.audio),
            tabGroups,
            enabledDictionaryIds,
        };
    });
    if (
        typeof activeProfileId !== 'string' ||
        !profiles.some(({ id }) => id === activeProfileId)
    ) {
        throw new Error('Hoshidicts active profile is invalid.');
    }
    return { activeProfileId, profiles };
}

function activeProfile(manifest: PersistedManifest): PersistedSettingsProfile {
    const profile = manifest.profiles.find(
        ({ id }) => id === manifest.activeProfileId
    );
    if (!profile) {
        throw new Error('Hoshidicts active profile does not exist.');
    }
    return profile;
}

function activeReader(manifest: PersistedManifest): PersistedReaderPreferences {
    return activeProfile(manifest).reader;
}

interface SerializedBackendProfiles {
    mining: Buffer;
    audio: Buffer;
}

function serializeBackendProfile(value: unknown, label: string): Buffer {
    const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (serialized.length > MAX_BACKEND_PROFILE_BYTES) {
        throw new Error(`${label} exceeded its size limit.`);
    }
    return serialized;
}

/** Rejects a profile the Python backend would refuse to read. */
function serializeBackendProfiles(
    profile: PersistedSettingsProfile
): SerializedBackendProfiles {
    return {
        mining: serializeBackendProfile(
            profile.mining,
            'Hoshidicts mining profile'
        ),
        audio: serializeBackendProfile(
            profile.audio,
            'Hoshidicts audio profile'
        ),
    };
}

function cloneProfile(profile: PersistedSettingsProfile): PersistedSettingsProfile {
    return structuredClone(profile);
}

function replaceActiveProfile(
    manifest: PersistedManifest,
    profile: PersistedSettingsProfile
): PersistedManifest {
    return {
        ...manifest,
        profiles: manifest.profiles.map((candidate) =>
            candidate.id === manifest.activeProfileId
                ? cloneProfile(profile)
                : cloneProfile(candidate)
        ),
    };
}

function projectActiveProfile(manifest: PersistedManifest): PersistedManifest {
    const enabledIds = new Set(activeProfile(manifest).enabledDictionaryIds);
    return pinCustomDictionary({
        ...manifest,
        dictionaries: manifest.dictionaries.map((dictionary) => ({
            ...dictionary,
            enabled:
                dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID ||
                enabledIds.has(dictionary.id),
        })),
    });
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

function normalizeDictionaryDisplayName(
    value: unknown,
    canonicalTitle: string
): string | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new Error('Dictionary display name is invalid.');
    }
    const normalized = value.normalize('NFC');
    if (INVALID_DICTIONARY_DISPLAY_NAME_PATTERN.test(normalized)) {
        throw new Error(
            'Dictionary display name cannot contain control or format characters.'
        );
    }
    const trimmed = normalized.trim();
    if ([...trimmed].length > MAX_DICTIONARY_DISPLAY_NAME_CODE_POINTS) {
        throw new Error(
            `Dictionary display name cannot exceed ${MAX_DICTIONARY_DISPLAY_NAME_CODE_POINTS} Unicode code points.`
        );
    }
    if (
        trimmed.length === 0 ||
        trimmed === canonicalTitle.normalize('NFC')
    ) {
        return null;
    }
    return trimmed;
}

function normalizePersistedDictionaryDisplayName(
    value: unknown,
    canonicalTitle: string
): string | null {
    return value === undefined
        ? null
        : normalizeDictionaryDisplayName(value, canonicalTitle);
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

function getHoshidictsScheduleIntervalMs(
    schedule: HoshidictsSchedule
): number | null {
    return schedule === 'off' ? null : SCHEDULE_INTERVALS[schedule];
}

function getNextHoshidictsCheck(
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

function isHoshidictsCheckDue(
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

function effectiveDictionarySchedule(
    dictionary: PersistedDictionary,
    globalSchedule: HoshidictsSchedule
): HoshidictsSchedule {
    return dictionary.updateScheduleOverride ?? globalSchedule;
}

function isDictionaryUpdateCandidate(dictionary: PersistedDictionary): boolean {
    return (
        dictionary.isUpdatable &&
        parseHttpsUrl(dictionary.indexUrl) !== null &&
        parseHttpsUrl(dictionary.downloadUrl) !== null
    );
}

function nextDictionaryUpdateCheck(
    dictionary: PersistedDictionary,
    globalSchedule: HoshidictsSchedule,
    now: Date
): string | null {
    if (!isDictionaryUpdateCandidate(dictionary)) {
        return null;
    }
    return getNextHoshidictsCheck(
        effectiveDictionarySchedule(dictionary, globalSchedule),
        dictionary.lastUpdateCheck,
        now
    );
}

function aggregateNextUpdateCheck(
    manifest: PersistedManifest,
    now: Date
): string | null {
    let nextCheck: string | null = null;
    let nextCheckTime = Number.POSITIVE_INFINITY;
    for (const dictionary of manifest.dictionaries) {
        const candidate = nextDictionaryUpdateCheck(
            dictionary,
            manifest.schedule,
            now
        );
        if (!candidate) {
            continue;
        }
        const candidateTime = new Date(candidate).getTime();
        if (candidateTime < nextCheckTime) {
            nextCheck = candidate;
            nextCheckTime = candidateTime;
        }
    }
    return nextCheck;
}

function stableHoshidictsDictionaryId(title: string): string {
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
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_GENERATED_INDEX_BYTES) {
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

async function requireNonEmptyDictionaryFiles(
    dictionaryPath: string,
    fileNames: readonly string[]
): Promise<void> {
    for (const fileName of fileNames) {
        const filePath = path.join(dictionaryPath, fileName);
        const stat = await fsp.stat(filePath).catch((error) => {
            throw new Error(`Dictionary is missing ${fileName}: ${errorMessage(error)}`);
        });
        if (!stat.isFile() || stat.size === 0) {
            throw new Error(`Dictionary file ${fileName} is empty or not a file.`);
        }
    }
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
    await requireNonEmptyDictionaryFiles(dictionaryPath, REQUIRED_DICTIONARY_FILES);
}

async function validateNativeMediaFiles(
    dictionaryPath: string,
    mediaCount: number
): Promise<void> {
    if (mediaCount > 0) {
        await requireNonEmptyDictionaryFiles(dictionaryPath, REQUIRED_MEDIA_FILES);
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
        displayName: null,
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
        updateScheduleOverride: null,
        lastUpdateCheck: null,
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

async function runHoshidictsImport(
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

async function reloadHoshidictsNativeState(): Promise<number> {
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

async function fetchHoshidictsRemoteIndex(
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

async function downloadHoshidictsArchive(
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
        setTimeout,
        clearTimeout,
        schedulerMaxDelayMs: SCHEDULER_MAX_DELAY_MS,
    };
}

type SnapshotListener = (snapshot: HoshidictsManagerSnapshot) => void;

export class HoshidictsManager {
    readonly rootDir: string;
    readonly manifestPath: string;
    readonly customDictionaryPath: string;
    readonly miningProfilePath: string;
    readonly audioProfilePath: string;

    private readonly deps: HoshidictsManagerDependencies;
    private operationQueue: Promise<void> = Promise.resolve();
    private snapshotQueue: Promise<void> = Promise.resolve();
    private snapshotRevision = 0;
    private progress: HoshidictsProgress = { phase: 'idle' };
    private runtimeError: string | null = null;
    private listeners = new Set<SnapshotListener>();
    private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
    private schedulerRunning = false;

    constructor(
        baseDir = getBaseDir(),
        dependencies: Partial<HoshidictsManagerDependencies> = {}
    ) {
        this.rootDir = path.join(baseDir, 'dictionaries', 'hoshidicts');
        this.manifestPath = path.join(this.rootDir, MANIFEST_FILE_NAME);
        this.customDictionaryPath = path.join(
            this.rootDir,
            HOSHIDICTS_CUSTOM_DICTIONARY_FILE_NAME
        );
        this.miningProfilePath = path.join(
            this.rootDir,
            HOSHIDICTS_MINING_PROFILE_FILE_NAME
        );
        this.audioProfilePath = path.join(
            this.rootDir,
            HOSHIDICTS_AUDIO_PROFILE_FILE_NAME
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
        return this.snapshotFromManifest(manifest, manifestError);
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
            const dictionaries = [...ordered, ...remaining];
            const profile = cloneProfile(activeProfile(manifest));
            profile.enabledDictionaryIds = dictionaries
                .filter(
                    (dictionary) =>
                        dictionary.enabled &&
                        dictionary.id !== HOSHIDICTS_CUSTOM_DICTIONARY_ID
                )
                .map(({ id }) => id);
            const previousSortFrequencyDictionary =
                profile.reader.sortFrequencyDictionary;
            profile.reader.sortFrequencyDictionary =
                usableSortFrequencyDictionary(
                    previousSortFrequencyDictionary,
                    dictionaries
                );
            const next = replaceActiveProfile(
                { ...manifest, dictionaries },
                profile
            );
            if (
                JSON.stringify(projectActiveProfile(next).dictionaries) !==
                    JSON.stringify(manifest.dictionaries) ||
                profile.reader.sortFrequencyDictionary !==
                    previousSortFrequencyDictionary
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
            const profiles = manifest.profiles.map((profile) => ({
                ...cloneProfile(profile),
                reader: {
                    ...profile.reader,
                    sortFrequencyDictionary:
                        profile.reader.sortFrequencyDictionary === existing.title
                            ? null
                            : profile.reader.sortFrequencyDictionary,
                },
                enabledDictionaryIds: profile.enabledDictionaryIds.filter(
                    (dictionaryId) => dictionaryId !== id
                ),
                tabGroups: profile.tabGroups.map((group) => ({
                    ...group,
                    dictionaryIds: group.dictionaryIds.filter(
                        (dictionaryId) => dictionaryId !== id
                    ),
                })),
            }));
            const next: PersistedManifest = {
                ...manifest,
                profiles,
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
        return await this.setDictionariesEnabled([id], enabled);
    }

    async setDictionariesEnabled(
        ids: readonly string[],
        enabled: boolean
    ): Promise<HoshidictsManagerSnapshot> {
        if (typeof enabled !== 'boolean') {
            throw new Error('Dictionary enabled state is invalid.');
        }
        return await this.setDictionariesBooleanState(ids, 'enabled', enabled);
    }

    async setDictionaryPresentation(
        id: string,
        favorite: boolean
    ): Promise<HoshidictsManagerSnapshot> {
        return await this.setDictionariesPresentation([id], favorite);
    }

    async setDictionariesPresentation(
        ids: readonly string[],
        favorite: boolean
    ): Promise<HoshidictsManagerSnapshot> {
        if (typeof favorite !== 'boolean') {
            throw new Error('Dictionary favorite state is invalid.');
        }
        return await this.setDictionariesBooleanState(ids, 'favorite', favorite);
    }

    private async setDictionariesBooleanState(
        ids: readonly string[],
        field: 'enabled' | 'favorite',
        value: boolean
    ): Promise<HoshidictsManagerSnapshot> {
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new Error('At least one dictionary must be selected.');
        }
        const uniqueIds = [...new Set(ids)];
        for (const id of uniqueIds) {
            if (id === HOSHIDICTS_CUSTOM_DICTIONARY_ID) {
                throw new Error(
                    field === 'enabled'
                        ? 'The custom dictionary is always enabled.'
                        : 'The custom dictionary presentation is managed automatically.'
                );
            }
        }

        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            const selectedIds = new Set(uniqueIds);
            if (
                uniqueIds.some(
                    (id) =>
                        !manifest.dictionaries.some(
                            (dictionary) => dictionary.id === id
                        )
                )
            ) {
                throw new Error('Dictionary is not installed.');
            }
            if (
                !manifest.dictionaries.some(
                    (dictionary) =>
                        selectedIds.has(dictionary.id) &&
                        dictionary[field] !== value
                )
            ) {
                return;
            }
            const dictionaries = manifest.dictionaries.map((dictionary) =>
                selectedIds.has(dictionary.id)
                    ? { ...dictionary, [field]: value }
                    : { ...dictionary }
            );
            const activeSortFrequencyDictionary =
                activeReader(manifest).sortFrequencyDictionary;
            const sortFrequencyDictionary =
                field === 'enabled' &&
                !value &&
                dictionaries.some(
                    (dictionary) =>
                        selectedIds.has(dictionary.id) &&
                        activeSortFrequencyDictionary === dictionary.title
                )
                    ? null
                    : activeSortFrequencyDictionary;
            if (field === 'enabled') {
                const profile = cloneProfile(activeProfile(manifest));
                const enabledIds = new Set(profile.enabledDictionaryIds);
                for (const id of uniqueIds) {
                    if (value) {
                        enabledIds.add(id);
                    } else {
                        enabledIds.delete(id);
                    }
                }
                profile.enabledDictionaryIds = [...enabledIds];
                profile.reader.sortFrequencyDictionary =
                    sortFrequencyDictionary;
                const next = replaceActiveProfile(
                    { ...manifest, dictionaries },
                    profile
                );
                await this.commitManifestChange(manifest, next, null, null);
            } else {
                // Presentation is renderer-only. Avoid a native reload while still
                // using the manifest's atomic persistence path.
                await this.atomicWriteManifest({ ...manifest, dictionaries });
            }
        });
        return await this.getSnapshot();
    }

    async createTabGroup(
        name: string,
        dictionaryId?: string
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const normalizedName = normalizeTabGroupName(name);
            const manifest = await this.readManifest();
            if (dictionaryId !== undefined) {
                const dictionary = manifest.dictionaries.find(
                    ({ id }) => id === dictionaryId
                );
                if (
                    !dictionary ||
                    dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID ||
                    dictionary.termCount <= 0
                ) {
                    throw new Error('Dictionary cannot be added to a tab group.');
                }
            }
            const profile = cloneProfile(activeProfile(manifest));
            const groups = profile.tabGroups;
            if (groups.length >= MAX_TAB_GROUP_COUNT) {
                throw new Error('Hoshidicts tab groups file has too many groups.');
            }
            const nameKey = tabGroupNameKey(normalizedName);
            if (groups.some((group) => tabGroupNameKey(group.name) === nameKey)) {
                throw new Error('A tab group with that name already exists.');
            }
            let id = '';
            do {
                id = `group-${this.deps.randomId()}`;
            } while (groups.some((group) => group.id === id));
            groups.push({
                id,
                name: normalizedName,
                dictionaryIds: dictionaryId ? [dictionaryId] : [],
            });
            profile.tabGroups = groups;
            await this.atomicWriteManifest(
                replaceActiveProfile(manifest, profile)
            );
        });
        return await this.getSnapshot();
    }

    async setTabGroupMembership(
        groupId: string,
        dictionaryId: string,
        member: boolean
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            if (typeof member !== 'boolean') {
                throw new Error('Tab group membership is invalid.');
            }
            const manifest = await this.readManifest();
            const profile = cloneProfile(activeProfile(manifest));
            const groups = profile.tabGroups;
            const index = groups.findIndex(({ id }) => id === groupId);
            if (index < 0) {
                throw new Error('Tab group does not exist.');
            }
            const current = groups[index].dictionaryIds.includes(dictionaryId);
            if (current === member) {
                return;
            }
            if (member) {
                if (
                    groups[index].dictionaryIds.length >=
                    MAX_TAB_GROUP_DICTIONARIES
                ) {
                    throw new Error(
                        'Hoshidicts tab group has too many dictionaries.'
                    );
                }
                const dictionary = manifest.dictionaries.find(
                    ({ id }) => id === dictionaryId
                );
                if (
                    !dictionary ||
                    dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID ||
                    dictionary.termCount <= 0
                ) {
                    throw new Error('Dictionary cannot be added to a tab group.');
                }
            }
            groups[index] = {
                ...groups[index],
                dictionaryIds: member
                    ? [...groups[index].dictionaryIds, dictionaryId]
                    : groups[index].dictionaryIds.filter(
                          (id) => id !== dictionaryId
                      ),
            };
            profile.tabGroups = groups;
            await this.atomicWriteManifest(
                replaceActiveProfile(manifest, profile)
            );
        });
        return await this.getSnapshot();
    }

    async renameTabGroup(
        groupId: string,
        name: string
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const normalizedName = normalizeTabGroupName(name);
            const manifest = await this.readManifest();
            const profile = cloneProfile(activeProfile(manifest));
            const groups = profile.tabGroups;
            const index = groups.findIndex(({ id }) => id === groupId);
            if (index < 0) {
                throw new Error('Tab group does not exist.');
            }
            const nameKey = tabGroupNameKey(normalizedName);
            if (
                groups.some(
                    (group, candidateIndex) =>
                        candidateIndex !== index &&
                        tabGroupNameKey(group.name) === nameKey
                )
            ) {
                throw new Error('A tab group with that name already exists.');
            }
            if (groups[index].name === normalizedName) {
                return;
            }
            groups[index] = { ...groups[index], name: normalizedName };
            profile.tabGroups = groups;
            await this.atomicWriteManifest(
                replaceActiveProfile(manifest, profile)
            );
        });
        return await this.getSnapshot();
    }

    async deleteTabGroup(groupId: string): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            const profile = cloneProfile(activeProfile(manifest));
            const groups = profile.tabGroups;
            const next = groups.filter(({ id }) => id !== groupId);
            if (next.length === groups.length) {
                throw new Error('Tab group does not exist.');
            }
            profile.tabGroups = next;
            await this.atomicWriteManifest(
                replaceActiveProfile(manifest, profile)
            );
        });
        return await this.getSnapshot();
    }

    async moveTabGroup(
        groupId: string,
        direction: -1 | 1
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            if (direction !== -1 && direction !== 1) {
                throw new Error('Tab group move is invalid.');
            }
            const manifest = await this.readManifest();
            const profile = cloneProfile(activeProfile(manifest));
            const groups = profile.tabGroups;
            const index = groups.findIndex(({ id }) => id === groupId);
            if (index < 0) {
                throw new Error('Tab group does not exist.');
            }
            const target = index + direction;
            if (target < 0 || target >= groups.length) {
                return;
            }
            const [group] = groups.splice(index, 1);
            groups.splice(target, 0, group);
            profile.tabGroups = groups;
            await this.atomicWriteManifest(
                replaceActiveProfile(manifest, profile)
            );
        });
        return await this.getSnapshot();
    }

    async renameDictionary(
        id: string,
        displayName: string | null
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            if (id === HOSHIDICTS_CUSTOM_DICTIONARY_ID) {
                throw new Error(
                    'The custom dictionary name is managed automatically.'
                );
            }
            const manifest = await this.readManifest();
            const index = manifest.dictionaries.findIndex(
                (dictionary) => dictionary.id === id
            );
            if (index < 0) {
                throw new Error('Dictionary is not installed.');
            }
            const normalized = normalizeDictionaryDisplayName(
                displayName,
                manifest.dictionaries[index].title
            );
            if (manifest.dictionaries[index].displayName === normalized) {
                return;
            }
            const dictionaries = manifest.dictionaries.map((dictionary) => ({
                ...dictionary,
            }));
            dictionaries[index].displayName = normalized;
            // Display aliases do not affect the native dictionary engine.
            await this.atomicWriteManifest({ ...manifest, dictionaries });
        });
        return await this.getSnapshot();
    }

    async moveDictionary(
        id: string,
        direction: -1 | 1
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
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
            const visibleDictionaries = manifest.dictionaries.filter(
                (dictionary) =>
                    dictionary.id !== HOSHIDICTS_CUSTOM_DICTIONARY_ID
            );
            if (position > visibleDictionaries.length) {
                throw new Error(
                    `Dictionary position must be between 1 and ${visibleDictionaries.length}.`
                );
            }
            const currentVisibleIndex = visibleDictionaries.findIndex(
                (dictionary) => dictionary.id === id
            );
            const targetVisibleIndex = position - 1;
            if (currentVisibleIndex === targetVisibleIndex) {
                return;
            }
            const reorderedVisible = visibleDictionaries.map((dictionary) => ({
                ...dictionary,
            }));
            const [dictionary] = reorderedVisible.splice(currentVisibleIndex, 1);
            reorderedVisible.splice(targetVisibleIndex, 0, dictionary);
            let visibleIndex = 0;
            const dictionaries = manifest.dictionaries.map((current) =>
                current.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID
                    ? { ...current }
                    : reorderedVisible[visibleIndex++]
            );
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
            if (!['off', 'hourly', 'daily', 'weekly', 'monthly'].includes(schedule)) {
                throw new Error('Dictionary update schedule is invalid.');
            }
            const manifest = await this.readManifest();
            // atomicWriteManifest recomputes nextCheck from the schedule it writes.
            await this.atomicWriteManifest({ ...manifest, schedule });
        }, 'preferences');
        return await this.getSnapshot();
    }

    async setDictionarySchedule(
        id: string,
        schedule: HoshidictsSchedule | null
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            if (
                schedule !== null &&
                !['off', 'hourly', 'daily', 'weekly', 'monthly'].includes(schedule)
            ) {
                throw new Error('Dictionary update schedule is invalid.');
            }
            const manifest = await this.readManifest();
            const index = manifest.dictionaries.findIndex(
                (dictionary) => dictionary.id === id
            );
            if (index < 0) {
                throw new Error('Dictionary is not installed.');
            }
            if (!manifest.dictionaries[index].isUpdatable) {
                throw new Error('Dictionary does not support automatic updates.');
            }
            if (
                manifest.dictionaries[index].updateScheduleOverride === schedule
            ) {
                return;
            }
            const dictionaries = manifest.dictionaries.map((dictionary) => ({
                ...dictionary,
            }));
            dictionaries[index].updateScheduleOverride = schedule;
            await this.atomicWriteManifest({ ...manifest, dictionaries });
        }, 'preferences');
        return await this.getSnapshot();
    }

    async setMiningProfile(value: unknown): Promise<HoshidictsManagerSnapshot> {
        const mining = normalizeHoshidictsMiningProfile(value);
        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            const profile = cloneProfile(activeProfile(manifest));
            profile.mining = mining;
            await this.atomicWriteManifest(
                replaceActiveProfile(manifest, profile)
            );
        }, 'mining');
        return await this.getSnapshot();
    }

    async setAudioProfile(value: unknown): Promise<HoshidictsManagerSnapshot> {
        const audio = normalizeHoshidictsAudioProfile(value);
        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            const profile = cloneProfile(activeProfile(manifest));
            profile.audio = audio;
            await this.atomicWriteManifest(
                replaceActiveProfile(manifest, profile)
            );
        }, 'audio');
        return await this.getSnapshot();
    }

    async createProfile(name: string): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const normalizedName = normalizeProfileName(name);
            const manifest = await this.readManifest();
            if (
                manifest.profiles.some(
                    (profile) =>
                        profileNameKey(profile.name) ===
                        profileNameKey(normalizedName)
                )
            ) {
                throw new Error('A profile with that name already exists.');
            }
            let id = '';
            do {
                id = `profile-${this.deps.randomId()}`;
            } while (manifest.profiles.some((profile) => profile.id === id));
            const profile = {
                ...cloneProfile(activeProfile(manifest)),
                id,
                name: normalizedName,
            };
            await this.atomicWriteManifest({
                ...manifest,
                activeProfileId: id,
                profiles: [...manifest.profiles.map(cloneProfile), profile],
            });
        }, 'preferences');
        return await this.getSnapshot();
    }

    async switchProfile(id: string): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            if (manifest.activeProfileId === id) {
                return;
            }
            if (!manifest.profiles.some((profile) => profile.id === id)) {
                throw new Error('Profile does not exist.');
            }
            const next = projectActiveProfile({
                ...manifest,
                activeProfileId: id,
            });
            const enabledChanged = next.dictionaries.some(
                (dictionary, index) =>
                    dictionary.enabled !==
                    manifest.dictionaries[index]?.enabled
            );
            if (enabledChanged) {
                await this.commitManifestChange(manifest, next, null, null);
            } else {
                await this.atomicWriteManifest(next);
            }
        }, 'preferences');
        return await this.getSnapshot();
    }

    async renameProfile(
        id: string,
        name: string
    ): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const normalizedName = normalizeProfileName(name);
            const manifest = await this.readManifest();
            const index = manifest.profiles.findIndex(
                (profile) => profile.id === id
            );
            if (index < 0) {
                throw new Error('Profile does not exist.');
            }
            if (
                manifest.profiles.some(
                    (profile, candidateIndex) =>
                        candidateIndex !== index &&
                        profileNameKey(profile.name) ===
                            profileNameKey(normalizedName)
                )
            ) {
                throw new Error('A profile with that name already exists.');
            }
            if (manifest.profiles[index].name === normalizedName) {
                return;
            }
            const profiles = manifest.profiles.map(cloneProfile);
            profiles[index].name = normalizedName;
            await this.atomicWriteManifest({ ...manifest, profiles });
        }, 'preferences');
        return await this.getSnapshot();
    }

    async deleteProfile(id: string): Promise<HoshidictsManagerSnapshot> {
        await this.enqueue('saving', async () => {
            const manifest = await this.readManifest();
            if (manifest.profiles.length === 1) {
                throw new Error('The final profile cannot be deleted.');
            }
            const profiles = manifest.profiles
                .filter((profile) => profile.id !== id)
                .map(cloneProfile);
            if (profiles.length === manifest.profiles.length) {
                throw new Error('Profile does not exist.');
            }
            const next = projectActiveProfile({
                ...manifest,
                activeProfileId:
                    manifest.activeProfileId === id
                        ? profiles[0].id
                        : manifest.activeProfileId,
                profiles,
            });
            const enabledChanged = next.dictionaries.some(
                (dictionary, index) =>
                    dictionary.enabled !==
                    manifest.dictionaries[index]?.enabled
            );
            if (enabledChanged) {
                await this.commitManifestChange(manifest, next, null, null);
            } else {
                await this.atomicWriteManifest(next);
            }
        }, 'preferences');
        return await this.getSnapshot();
    }

    async exportBackup(outputPath: string): Promise<void> {
        if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
            throw new Error('Hoshidicts backup destination is invalid.');
        }
        await this.enqueue(
            'saving',
            async () => {
                // A brand-new installation has useful in-memory defaults but no
                // files yet. Persist normalized state so its first backup is a
                // complete, restorable snapshot too.
                const manifest = await this.readManifest();
                await this.atomicWriteManifest(manifest);
                await exportHoshidictsBackup({
                    rootDir: this.rootDir,
                    outputPath,
                    now: this.deps.now,
                });
            },
            'preferences',
        );
    }

    async restoreBackup(archivePath: string): Promise<HoshidictsManagerSnapshot> {
        if (typeof archivePath !== 'string' || archivePath.trim().length === 0) {
            throw new Error('Hoshidicts backup archive is invalid.');
        }
        await this.enqueue('importing', async () => {
            const prepared = await prepareHoshidictsBackupRestore({
                archivePath,
                stagingParent: path.join(this.rootDir, '.staging'),
            });
            try {
                const committed = await commitPreparedHoshidictsBackupRestore(prepared, {
                    targetRootDir: this.rootDir,
                    freshGenerationId: (_dictionary, index) =>
                        `restore-${this.deps
                            .now()
                            .getTime()
                            .toString(36)}-${index}-${this.deps.randomId()}`,
                    activate: async () => {
                        this.setProgress({ phase: 'reloading' });
                        // Keep manager-level schema and native-file validation
                        // inside the transaction so any failure still rolls
                        // all state and generations back together.
                        await this.readManifest();
                        await this.deps.reloadNative();
                    },
                });
                await this.removeUnreferencedBackupGenerations(
                    committed.previousDictionaryPaths,
                    committed.installedGenerationRoots,
                );
            } finally {
                await disposePreparedHoshidictsBackupRestore(prepared);
            }
        });
        // Restoration replaces the manifest outside atomicWriteManifest, so the
        // backend profile files still have to catch up.
        await this.syncBackendProfiles();
        return await this.getSnapshot();
    }

    async setLookupMode(
        lookupMode: HoshidictsLookupMode
    ): Promise<HoshidictsManagerSnapshot> {
        if (lookupMode !== 'shift' && lookupMode !== 'hover') {
            throw new Error('Hoshidicts lookup mode is invalid.');
        }
        const snapshot = await this.getSnapshot();
        return await this.setReaderPreferences({
            ...normalizeHoshidictsReaderPreferences(snapshot),
            lookupMode,
        });
    }

    async setReaderPreferences(
        request: HoshidictsReaderPreferencesRequest
    ): Promise<HoshidictsManagerSnapshot> {
        const reader = assertHoshidictsReaderPreferences(request);
        await this.enqueue(
            'saving',
            async () => {
                const manifest = await this.readManifest();
                if (
                    reader.sortFrequencyDictionary !== null &&
                    usableSortFrequencyDictionary(
                        reader.sortFrequencyDictionary,
                        manifest.dictionaries
                    ) === null
                ) {
                    throw new Error(
                        'Hoshidicts frequency sort dictionary is not installed.'
                    );
                }
                if (
                    hoshidictsReaderPreferencesEqual(
                        reader,
                        activeReader(manifest)
                    )
                ) {
                    return;
                }
                const profile = cloneProfile(activeProfile(manifest));
                profile.reader = reader;
                await this.atomicWriteManifest(
                    replaceActiveProfile(manifest, profile)
                );
            },
            'preferences'
        );
        return await this.getSnapshot();
    }

    async checkForUpdates(
        force = true,
        dictionaryIds?: readonly string[]
    ): Promise<HoshidictsManagerSnapshot> {
        if (
            dictionaryIds !== undefined &&
            (!Array.isArray(dictionaryIds) || dictionaryIds.length === 0)
        ) {
            throw new Error('At least one dictionary must be selected.');
        }
        const selectedIds =
            dictionaryIds === undefined
                ? null
                : new Set<string>(dictionaryIds);
        await this.enqueue('checking', async () => {
            let manifest = await this.readManifest();
            if (
                selectedIds &&
                [...selectedIds].some(
                    (id) =>
                        !manifest.dictionaries.some(
                            (dictionary) => dictionary.id === id
                        )
                )
            ) {
                throw new Error('Dictionary is not installed.');
            }
            const now = this.deps.now();
            const candidates = manifest.dictionaries.filter(
                (dictionary) =>
                    (selectedIds === null || selectedIds.has(dictionary.id)) &&
                    isDictionaryUpdateCandidate(dictionary) &&
                    (force ||
                        isHoshidictsCheckDue(
                            effectiveDictionarySchedule(
                                dictionary,
                                manifest.schedule
                            ),
                            nextDictionaryUpdateCheck(
                                dictionary,
                                manifest.schedule,
                                now
                            ),
                            now
                        ))
            );
            if (!force && candidates.length === 0) {
                return;
            }
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
                dictionaries: manifest.dictionaries.map((dictionary) =>
                    candidates.some(
                        (candidate) => candidate.id === dictionary.id
                    )
                        ? {
                              ...dictionary,
                              lastUpdateCheck: checkedAt.toISOString(),
                          }
                        : dictionary
                ),
                lastCheck: checkedAt.toISOString(),
                nextCheck: null,
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
        if (this.schedulerRunning) {
            return;
        }
        this.schedulerRunning = true;
        void this.checkForUpdates(false).catch((error) => {
            console.warn('[Hoshidicts] Startup update check failed:', error);
        });
    }

    async stopScheduler(): Promise<void> {
        this.schedulerRunning = false;
        if (this.schedulerTimer) {
            this.deps.clearTimeout(this.schedulerTimer);
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
                await this.rearmScheduler();
            }
        });
        this.operationQueue = run.then(
            () => undefined,
            () => undefined
        );
        return await run;
    }

    private async rearmScheduler(): Promise<void> {
        if (!this.schedulerRunning) {
            return;
        }
        if (this.schedulerTimer) {
            this.deps.clearTimeout(this.schedulerTimer);
            this.schedulerTimer = null;
        }

        let delay = this.deps.schedulerMaxDelayMs;
        try {
            const now = this.deps.now();
            const manifest = await this.readManifest();
            const nextCheck = aggregateNextUpdateCheck(manifest, now);
            if (nextCheck) {
                delay = Math.max(
                    0,
                    Math.min(
                        this.deps.schedulerMaxDelayMs,
                        new Date(nextCheck).getTime() - now.getTime()
                    )
                );
            }
        } catch (error) {
            console.warn('[Hoshidicts] Could not schedule the next update check:', error);
        }
        if (!this.schedulerRunning) {
            return;
        }
        this.schedulerTimer = this.deps.setTimeout(() => {
            this.schedulerTimer = null;
            if (!this.schedulerRunning) {
                return;
            }
            void this.checkForUpdates(false).catch((error) => {
                console.warn('[Hoshidicts] Scheduled update check failed:', error);
            });
        }, delay);
        this.schedulerTimer.unref?.();
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
        profileError: string | null = null
    ): HoshidictsManagerSnapshot {
        const profile = activeProfile(manifest);
        const customDictionary = manifest.dictionaries.find(
            (dictionary) => dictionary.id === HOSHIDICTS_CUSTOM_DICTIONARY_ID
        );
        return {
            revision: ++this.snapshotRevision,
            activeProfileId: manifest.activeProfileId,
            profiles: manifest.profiles.map(({ id, name }) => ({ id, name })),
            dictionaries: manifest.dictionaries
                .filter(
                    (dictionary) =>
                        dictionary.id !== HOSHIDICTS_CUSTOM_DICTIONARY_ID
                )
                // PersistedDictionary adds only these two to HoshidictsDictionaryState.
                .map(({ path, recommendedId, ...dictionary }) => dictionary),
            tabGroups: profile.tabGroups.map(({ id, name, dictionaryIds }) => ({
                id,
                name,
                dictionaryIds: [...dictionaryIds],
            })),
            customDictionaryActive: customDictionary?.enabled === true,
            recommendedDictionaries: recommendedDictionaryStates(manifest),
            miningProfile: structuredClone(profile.mining),
            audioProfile: structuredClone(profile.audio),
            ...normalizeHoshidictsReaderPreferences(profile.reader),
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

    private async readManifest(): Promise<PersistedManifest> {
        const parsed = await readJsonFile(
            this.manifestPath,
            'Hoshidicts manifest',
            emptyManifest
        );
        if (!isRecord(parsed) || parsed.version !== MANIFEST_VERSION) {
            throw new Error('Hoshidicts manifest has an unsupported version.');
        }
        if (!Array.isArray(parsed.dictionaries) || parsed.dictionaries.length > 256) {
            throw new Error('Hoshidicts manifest has an invalid dictionary list.');
        }
        const schedule = normalizeSchedule(parsed.schedule);
        const legacyLastCheck = normalizeDate(parsed.lastCheck);

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
                displayName: normalizePersistedDictionaryDisplayName(
                    value.displayName,
                    index.title
                ),
                updateScheduleOverride: normalizeScheduleOverride(
                    value.updateScheduleOverride
                ),
                lastUpdateCheck: Object.prototype.hasOwnProperty.call(
                    value,
                    'lastUpdateCheck'
                )
                    ? normalizeDate(value.lastUpdateCheck)
                    : index.isUpdatable
                      ? legacyLastCheck
                      : null,
            });
        }

        const profileState = normalizePersistedProfiles(
            parsed.profiles,
            parsed.activeProfileId,
            dictionaries
        );
        let manifest: PersistedManifest = {
            version: MANIFEST_VERSION,
            ...profileState,
            schedule,
            lastCheck: legacyLastCheck,
            nextCheck: null,
            lastError: normalizeOptionalString(parsed.lastError),
            dictionaries,
        };
        manifest = projectActiveProfile(manifest);
        manifest.nextCheck = aggregateNextUpdateCheck(manifest, this.deps.now());
        return manifest;
    }

    private async readManifestPreferences(): Promise<PersistedManifest> {
        const parsed = await readJsonFile(
            this.manifestPath,
            'Hoshidicts manifest',
            emptyManifest
        );
        if (!isRecord(parsed) || parsed.version !== MANIFEST_VERSION) {
            throw new Error('Hoshidicts manifest has an unsupported version.');
        }
        const profileState = normalizePersistedProfiles(
            parsed.profiles,
            parsed.activeProfileId,
            []
        );
        return projectActiveProfile({
            version: MANIFEST_VERSION,
            ...profileState,
            schedule: normalizeSchedule(parsed.schedule),
            lastCheck: normalizeDate(parsed.lastCheck),
            nextCheck: normalizeDate(parsed.nextCheck),
            lastError: normalizeOptionalString(parsed.lastError),
            dictionaries: [],
        });
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
                displayName: dictionaries[existingIndex].displayName,
                updateScheduleOverride:
                    dictionaries[existingIndex].updateScheduleOverride,
                lastUpdateCheck: dictionaries[existingIndex].lastUpdateCheck,
            };
        } else {
            dictionaries.push(staged.dictionary);
        }
        let next: PersistedManifest = { ...manifest, dictionaries };
        if (
            existingIndex < 0 &&
            staged.dictionary.id !== HOSHIDICTS_CUSTOM_DICTIONARY_ID
        ) {
            const profile = cloneProfile(activeProfile(next));
            profile.enabledDictionaryIds = [
                ...profile.enabledDictionaryIds,
                staged.dictionary.id,
            ];
            next = replaceActiveProfile(next, profile);
        }
        next = projectActiveProfile(next);
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

    private async removeUnreferencedBackupGenerations(
        previousDictionaryPaths: readonly string[],
        installedGenerationRoots: readonly string[],
    ): Promise<void> {
        let current: PersistedManifest;
        try {
            current = await this.readManifest();
        } catch (error) {
            console.warn(
                '[Hoshidicts] Could not verify restored dictionary references; retaining old generations:',
                error,
            );
            return;
        }

        const generationRoot = (relativePath: string): string | null => {
            const components = normalizeRelativePath(relativePath).split('/');
            if (
                components.length !== 4 ||
                components[0] !== 'generations' ||
                !SAFE_ID_PATTERN.test(components[1]) ||
                !SAFE_ID_PATTERN.test(components[2])
            ) {
                return null;
            }
            return path.resolve(this.rootDir, ...components.slice(0, 3));
        };
        const referencedRoots = new Set(
            current.dictionaries
                .map((dictionary) => generationRoot(dictionary.path))
                .filter((value): value is string => value !== null),
        );
        const protectedRoots = new Set(installedGenerationRoots.map((root) => path.resolve(root)));
        const removedRoots = new Set<string>();
        for (const previousPath of previousDictionaryPaths) {
            let root: string | null;
            try {
                root = generationRoot(previousPath);
            } catch (error) {
                console.warn(
                    `[Hoshidicts] Could not validate old backup generation path ${previousPath}:`,
                    error,
                );
                continue;
            }
            if (
                root === null ||
                referencedRoots.has(root) ||
                protectedRoots.has(root) ||
                removedRoots.has(root)
            ) {
                continue;
            }
            removedRoots.add(root);
            await fsp.rm(root, { recursive: true, force: true }).catch((error) => {
                console.warn(`[Hoshidicts] Could not clean old backup generation ${root}:`, error);
            });
        }
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
            await Promise.all([
                fsp.rm(this.miningProfilePath, { force: true }),
                fsp.rm(this.audioProfilePath, { force: true }),
            ]);
            return;
        }
        await this.atomicWriteBuffer(raw);
        // The abandoned profile must not stay published to the Python backend.
        await this.publishBackendProfiles(
            serializeBackendProfiles(activeProfile(previous))
        );
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
        const projected = projectActiveProfile(manifest);
        const next = {
            ...projected,
            nextCheck: aggregateNextUpdateCheck(projected, this.deps.now()),
        };
        // The backend profile files have a tighter size limit than the manifest,
        // so serialize them first: an oversized profile must fail the save
        // before it commits rather than after.
        const backendProfiles = serializeBackendProfiles(activeProfile(next));
        await this.atomicWriteJson(next, this.manifestPath, '.manifest-');
        await this.publishBackendProfiles(backendProfiles);
    }

    /**
     * The Python backend reads the active mining and audio profiles from their
     * own files, so mirror them out of the manifest whenever it changes.
     */
    async syncBackendProfiles(): Promise<void> {
        await this.writeBackendProfiles(
            activeProfile(await this.readManifest())
        );
    }

    private async writeBackendProfiles(
        profile: PersistedSettingsProfile
    ): Promise<void> {
        await this.publishBackendProfiles(serializeBackendProfiles(profile));
    }

    /**
     * Only reached once the manifest itself is committed, so a write failure
     * here cannot fail the save. The manifest stays authoritative and the next
     * save or startup sync republishes.
     */
    private async publishBackendProfiles(
        profiles: SerializedBackendProfiles
    ): Promise<void> {
        try {
            await this.atomicWriteBuffer(
                profiles.mining,
                this.miningProfilePath,
                '.mining-profile-'
            );
            await this.atomicWriteBuffer(
                profiles.audio,
                this.audioProfilePath,
                '.audio-profile-'
            );
        } catch (error) {
            console.warn(
                '[Hoshidicts] Could not publish the mining and audio profiles for the backend; the manifest is saved and they will be republished on the next save or restart.',
                error
            );
        }
    }

    private async atomicWriteJson(
        value: unknown,
        destination: string,
        temporaryPrefix: string
    ): Promise<void> {
        await this.atomicWriteBuffer(
            Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
            destination,
            temporaryPrefix
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

export async function startHoshidictsManager(): Promise<void> {
    const manager = getHoshidictsManager();
    // An install whose manifest predates the backend profile files still needs
    // them written before the Python backend reads them.
    try {
        await manager.syncBackendProfiles();
    } catch (error) {
        console.warn(
            '[Hoshidicts] Could not publish the mining and audio profiles for the backend.',
            error
        );
    }
    manager.startScheduler();
}

export async function stopHoshidictsManager(): Promise<void> {
    if (defaultManager) {
        await defaultManager.stopScheduler();
    }
}
