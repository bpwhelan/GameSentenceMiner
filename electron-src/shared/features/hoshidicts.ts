export const HOSHIDICTS_CHANNELS = {
    openSettings: 'hoshidicts.openSettings',
    getState: 'hoshidicts.getState',
    progress: 'hoshidicts.progress',
    importDictionary: 'hoshidicts.import',
    importYomitanDictionaries: 'hoshidicts.importYomitanDictionaries',
    importYomitanSettings: 'hoshidicts.importYomitanSettings',
    exportBackup: 'hoshidicts.exportBackup',
    restoreBackup: 'hoshidicts.restoreBackup',
    installAllRecommended: 'hoshidicts.installAllRecommended',
    installRecommended: 'hoshidicts.installRecommended',
    checkUpdates: 'hoshidicts.checkUpdates',
    removeDictionary: 'hoshidicts.remove',
    setSchedule: 'hoshidicts.setSchedule',
    setLookupMode: 'hoshidicts.setLookupMode',
    setReaderPreferences: 'hoshidicts.setReaderPreferences',
    setMiningProfile: 'hoshidicts.setMiningProfile',
    setAudioProfile: 'hoshidicts.setAudioProfile',
    getMiningOptions: 'hoshidicts.getMiningOptions',
    setDictionaryEnabled: 'hoshidicts.setDictionaryEnabled',
    setDictionaryPresentation: 'hoshidicts.setDictionaryPresentation',
    renameDictionary: 'hoshidicts.renameDictionary',
    moveDictionary: 'hoshidicts.moveDictionary',
    moveDictionaryToPosition: 'hoshidicts.moveDictionaryToPosition',
    getCustomDictionary: 'hoshidicts.getCustomDictionary',
    saveCustomDictionary: 'hoshidicts.saveCustomDictionary',
    restartOverlay: 'hoshidicts.restartOverlay',
} as const;

export type HoshidictsSchedule = 'off' | 'daily' | 'weekly' | 'monthly';
export type HoshidictsLookupMode = 'shift' | 'hover';
export type HoshidictsDefinitionBlurRevealMode = 'timed' | 'hover';
export type HoshidictsFrequencyMode = 'occurrence-based' | 'rank-based';
export const HOSHIDICTS_ACTIVATION_KEYS = [
    'Ctrl',
    'Alt',
    'Shift',
    'Cmd',
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    'K',
    'L',
    'M',
    'N',
    'O',
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
    'V',
    'W',
    'X',
    'Y',
    'Z',
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'Space',
    'Return',
    'Escape',
    'Backspace',
    'Delete',
    'Tab',
    'Up',
    'Down',
    'Left',
    'Right',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Insert',
    'F1',
    'F2',
    'F3',
    'F4',
    'F5',
    'F6',
    'F7',
    'F8',
    'F9',
    'F10',
    'F11',
    'F12',
    'F13',
    'F14',
    'F15',
    'F16',
    'F17',
    'F18',
    'F19',
    'F20',
    'F21',
    'F22',
    'F23',
    'F24',
    '-',
    '=',
    '[',
    ']',
    '\\',
    ';',
    "'",
    ',',
    '.',
    '/',
    '`',
] as const;
export type HoshidictsActivationKey =
    (typeof HOSHIDICTS_ACTIVATION_KEYS)[number];
export const DEFAULT_HOSHIDICTS_ACTIVATION_KEY: HoshidictsActivationKey =
    'Shift';
const HOSHIDICTS_ACTIVATION_KEY_SET = new Set<string>(
    HOSHIDICTS_ACTIVATION_KEYS
);

export function isHoshidictsActivationKey(
    value: unknown
): value is HoshidictsActivationKey {
    return (
        typeof value === 'string' &&
        HOSHIDICTS_ACTIVATION_KEY_SET.has(value)
    );
}
export const DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS = 300;
export const DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED = false;
export const MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS = 5000;
export const DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX = 560;
export const DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX = 420;
export const MIN_HOSHIDICTS_POPUP_WIDTH_PX = 280;
export const MAX_HOSHIDICTS_POPUP_WIDTH_PX = 1200;
export const MIN_HOSHIDICTS_POPUP_HEIGHT_PX = 200;
export const MAX_HOSHIDICTS_POPUP_HEIGHT_PX = 900;
export const HOSHIDICTS_THEMES = [
    'default',
    'high-contrast',
    'autumn',
    'cyberpunk',
] as const;
export type HoshidictsTheme = (typeof HOSHIDICTS_THEMES)[number];
export const DEFAULT_HOSHIDICTS_THEME: HoshidictsTheme = 'default';
const HOSHIDICTS_THEME_SET = new Set<string>(HOSHIDICTS_THEMES);

export function isHoshidictsTheme(value: unknown): value is HoshidictsTheme {
    return typeof value === 'string' && HOSHIDICTS_THEME_SET.has(value);
}
export const MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD = 1;
export const MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD = 1_000_000;
export const MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS = 1000;
export const MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS = 3_600_000;
export const DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH = 10;
export const HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS = [
    'jitendex',
    'jmdict',
    'jmnedict',
    'bccwj',
    'jpdbv2-kana',
    'jiten',
    'kanjium-pitch',
    'kanjidic',
] as const;
export type HoshidictsRecommendedDictionaryId =
    (typeof HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS)[number];
export const DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS = [
    'jitendex',
    'jmnedict',
    'bccwj',
    'jpdbv2-kana',
    'jiten',
    'kanjium-pitch',
    'kanjidic',
] as const satisfies readonly HoshidictsRecommendedDictionaryId[];
export const MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES = 16 * 1024 * 1024;
export const MAX_HOSHIDICTS_CUSTOM_TERM_BYTES = 4 * 1024;
export const MAX_HOSHIDICTS_CUSTOM_READING_BYTES = 4 * 1024;
// The native bridge retains up to 64 glossaries across 16 results. Their custom
// definitions consume at most half of its 256 KiB response; the rest is reserved
// for terms, readings, and JSON metadata.
export const MAX_HOSHIDICTS_CUSTOM_DEFINITION_BYTES = 2 * 1024;

export interface HoshidictsCustomDictionaryEntry {
    term: string;
    reading: string;
    definition: string;
}

export interface HoshidictsCustomDictionaryParseResult {
    entries: HoshidictsCustomDictionaryEntry[];
    ignoredLines: number[];
    ignoredLineCount: number;
}

const UTF8_ENCODER = new TextEncoder();
const MAX_REPORTED_HOSHIDICTS_CUSTOM_IGNORED_LINES = 20;

function isJsonStringWithinUtf8Limit(value: string, maxBytes: number): boolean {
    // Count the representation placed in the native JSON response so quotes,
    // backslashes, and control characters cannot expand past the byte budget.
    return UTF8_ENCODER.encode(JSON.stringify(value)).length <= maxBytes + 2;
}

function decodeCustomDefinition(value: string): string {
    return value.replace(/\\\\|\\n/gu, (escape) =>
        escape === '\\n' ? '\n' : '\\'
    );
}

export function isHoshidictsCustomEntryWithinLimits(
    entry: HoshidictsCustomDictionaryEntry
): boolean {
    return (
        isJsonStringWithinUtf8Limit(
            entry.term,
            MAX_HOSHIDICTS_CUSTOM_TERM_BYTES
        ) &&
        isJsonStringWithinUtf8Limit(
            entry.reading,
            MAX_HOSHIDICTS_CUSTOM_READING_BYTES
        ) &&
        isJsonStringWithinUtf8Limit(
            entry.definition,
            MAX_HOSHIDICTS_CUSTOM_DEFINITION_BYTES
        )
    );
}

export function parseHoshidictsCustomDictionary(
    text: string
): HoshidictsCustomDictionaryParseResult {
    const entries: HoshidictsCustomDictionaryEntry[] = [];
    const ignoredLines: number[] = [];
    let ignoredLineCount = 0;
    const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);

    const ignoreLine = (lineNumber: number): void => {
        ignoredLineCount += 1;
        if (
            ignoredLines.length <
            MAX_REPORTED_HOSHIDICTS_CUSTOM_IGNORED_LINES
        ) {
            ignoredLines.push(lineNumber);
        }
    };

    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index].replace(/\r$/u, '');
        const trimmedLine = rawLine.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }

        const firstComma = rawLine.indexOf(',');
        const secondComma =
            firstComma < 0 ? -1 : rawLine.indexOf(',', firstComma + 1);
        if (secondComma < 0) {
            ignoreLine(index + 1);
            continue;
        }

        const entry = {
            term: rawLine.slice(0, firstComma).trim(),
            reading: rawLine.slice(firstComma + 1, secondComma).trim(),
            definition: decodeCustomDefinition(
                rawLine.slice(secondComma + 1).trim()
            ),
        };
        if (
            !entry.term ||
            !entry.reading ||
            !entry.definition ||
            !isHoshidictsCustomEntryWithinLimits(entry)
        ) {
            ignoreLine(index + 1);
            continue;
        }
        entries.push(entry);
    }

    return { entries, ignoredLines, ignoredLineCount };
}
export type HoshidictsMoveDirection = -1 | 1;
export const HOSHIDICTS_AUDIO_SOURCE_TYPES = [
    'jpod101',
    'language-pod-101',
    'jisho',
    'custom',
    'custom-json',
    'text-to-speech',
    'text-to-speech-reading',
] as const;
export const MAX_HOSHIDICTS_AUDIO_SOURCES = 32;
export type HoshidictsAudioSourceType =
    (typeof HOSHIDICTS_AUDIO_SOURCE_TYPES)[number];
export type HoshidictsProgressPhase =
    | 'idle'
    | 'importing'
    | 'checking'
    | 'downloading'
    | 'reloading'
    | 'removing'
    | 'saving';

export interface HoshidictsMiningFields {
    expression: string;
    reading: string;
    definition: string;
    sentence: string;
    frequency: string;
    pitch: string;
    audio: string;
}

export type HoshidictsMiningFieldName = keyof HoshidictsMiningFields;

export const HOSHIDICTS_DUPLICATE_SCOPES = [
    'collection',
    'deck',
    'deck-root',
] as const;
export type HoshidictsDuplicateScope =
    (typeof HOSHIDICTS_DUPLICATE_SCOPES)[number];
export const HOSHIDICTS_DUPLICATE_BEHAVIORS = [
    'prevent',
    'overwrite',
    'new',
] as const;
export type HoshidictsDuplicateBehavior =
    (typeof HOSHIDICTS_DUPLICATE_BEHAVIORS)[number];
export const HOSHIDICTS_FIELD_OVERWRITE_MODES = [
    'coalesce',
    'coalesce-new',
    'skip',
    'append',
    'prepend',
    'overwrite',
] as const;
export type HoshidictsFieldOverwriteMode =
    (typeof HOSHIDICTS_FIELD_OVERWRITE_MODES)[number];
export type HoshidictsFieldOverwriteModes = Record<
    HoshidictsMiningFieldName,
    HoshidictsFieldOverwriteMode
>;

export function createDefaultHoshidictsFieldOverwriteModes(): HoshidictsFieldOverwriteModes {
    return {
        expression: 'coalesce',
        reading: 'coalesce',
        definition: 'coalesce',
        sentence: 'coalesce',
        frequency: 'coalesce',
        pitch: 'coalesce',
        audio: 'coalesce',
    };
}

export interface HoshidictsDefinitionBlurPreferences {
    enabled: boolean;
    lookupThreshold: number;
    revealMode: HoshidictsDefinitionBlurRevealMode;
    revealDelayMs: number;
}

export const DEFAULT_HOSHIDICTS_DEFINITION_BLUR = {
    enabled: false,
    lookupThreshold: 5,
    revealMode: 'timed',
    revealDelayMs: 5000,
} as const satisfies HoshidictsDefinitionBlurPreferences;

export interface HoshidictsReaderPreferencesRequest {
    lookupMode: HoshidictsLookupMode;
    activationKey: HoshidictsActivationKey;
    sourceHighlightEnabled: boolean;
    popupHideDelayMs: number;
    showLookupCounts: boolean;
    popupNestingMaxDepth: number;
    definitionBlur: HoshidictsDefinitionBlurPreferences;
    popupWidthPx: number;
    popupHeightPx: number;
    theme: HoshidictsTheme;
}

export interface HoshidictsDictionaryPresentation {
    title: string;
    favorite: boolean;
    displayName?: string;
}

export interface HoshidictsReaderPreferences
    extends HoshidictsReaderPreferencesRequest {
    // Optional at the cross-process boundary for compatibility with an older
    // overlay. Current desktop deliveries always include a normalized array.
    dictionaryPresentation?: HoshidictsDictionaryPresentation[];
}

export interface HoshidictsAudioSource {
    id: string;
    type: HoshidictsAudioSourceType;
    url: string;
    voice: string;
}

export interface HoshidictsAudioProfile {
    version: 1;
    enabled: boolean;
    autoPlay: boolean;
    volume: number;
    sources: HoshidictsAudioSource[];
}

export function createDefaultHoshidictsAudioProfile(): HoshidictsAudioProfile {
    return {
        version: 1,
        enabled: true,
        autoPlay: false,
        volume: 100,
        sources: [
            { id: 'jpod101', type: 'jpod101', url: '', voice: '' },
            {
                id: 'language-pod-101',
                type: 'language-pod-101',
                url: '',
                voice: '',
            },
            { id: 'jisho', type: 'jisho', url: '', voice: '' },
        ],
    };
}

export function isHoshidictsAudioSourceType(
    value: unknown
): value is HoshidictsAudioSourceType {
    return (
        typeof value === 'string' &&
        (HOSHIDICTS_AUDIO_SOURCE_TYPES as readonly string[]).includes(value)
    );
}

export interface HoshidictsMiningProfile {
    version: 2;
    enabled: boolean;
    deck: string;
    model: string;
    fields: HoshidictsMiningFields;
    disabledFields: HoshidictsMiningFieldName[];
    tags: string[];
    checkForDuplicates: boolean;
    duplicateScope: HoshidictsDuplicateScope;
    duplicateScopeCheckAllModels: boolean;
    duplicateBehavior: HoshidictsDuplicateBehavior;
    fieldOverwriteModes: HoshidictsFieldOverwriteModes;
}

export interface HoshidictsMiningOptions {
    connected: boolean;
    gsmAnkiEnabled: boolean;
    decks: string[];
    noteTypes: string[];
    selectedNoteType: string;
    fields: string[];
    suggestedFields: HoshidictsMiningFields;
    resolvedFields: HoshidictsMiningFields;
    warnings: string[];
    error: string | null;
}

export interface HoshidictsDictionaryState {
    id: string;
    title: string;
    displayName: string | null;
    enabled: boolean;
    favorite: boolean;
    revision: string;
    isUpdatable: boolean;
    indexUrl: string | null;
    downloadUrl: string | null;
    language: string | null;
    termCount: number;
    frequencyCount: number;
    pitchCount: number;
    kanjiCount: number;
    frequencyMode: HoshidictsFrequencyMode | null;
    installedAt: string;
}

export interface HoshidictsRecommendedDictionaryState {
    id: HoshidictsRecommendedDictionaryId;
    installed: boolean;
}

export interface HoshidictsProgress {
    phase: HoshidictsProgressPhase;
    scope?: 'dictionary' | 'preferences' | 'mining' | 'audio' | 'custom';
    title?: string;
    completed?: number;
    total?: number;
}

export interface HoshidictsYomitanDictionaryPreference {
    title: string;
    enabled: boolean;
}

export type HoshidictsYomitanSettingsGroup =
    | 'dictionaries'
    | 'reader'
    | 'anki'
    | 'audio';

export interface HoshidictsYomitanImportReport {
    imported: number;
    replaced: number;
    failed: number;
    settings: HoshidictsYomitanSettingsGroup[];
    warnings: string[];
}

export interface HoshidictsCustomDictionaryDocument {
    text: string;
    revision: string;
    exists: boolean;
    filePath: string;
}

export interface HoshidictsManagerSnapshot {
    revision: number;
    dictionaries: HoshidictsDictionaryState[];
    customDictionaryActive: boolean;
    recommendedDictionaries: HoshidictsRecommendedDictionaryState[];
    miningProfile: HoshidictsMiningProfile;
    audioProfile: HoshidictsAudioProfile;
    lookupMode: HoshidictsLookupMode;
    activationKey: HoshidictsActivationKey;
    sourceHighlightEnabled: boolean;
    popupHideDelayMs: number;
    showLookupCounts: boolean;
    popupNestingMaxDepth: number;
    definitionBlur: HoshidictsDefinitionBlurPreferences;
    popupWidthPx: number;
    popupHeightPx: number;
    theme: HoshidictsTheme;
    schedule: HoshidictsSchedule;
    lastCheck: string | null;
    nextCheck: string | null;
    lastError: string | null;
    busy: boolean;
    progress: HoshidictsProgress;
}

export function hoshidictsReaderPreferencesFromSnapshot(
    snapshot: HoshidictsManagerSnapshot
): HoshidictsReaderPreferences {
    return {
        lookupMode: snapshot.lookupMode,
        activationKey: snapshot.activationKey,
        sourceHighlightEnabled: snapshot.sourceHighlightEnabled,
        popupHideDelayMs: snapshot.popupHideDelayMs,
        showLookupCounts: snapshot.showLookupCounts,
        popupNestingMaxDepth: snapshot.popupNestingMaxDepth,
        definitionBlur: { ...snapshot.definitionBlur },
        popupWidthPx: snapshot.popupWidthPx,
        popupHeightPx: snapshot.popupHeightPx,
        theme: snapshot.theme,
        dictionaryPresentation: (snapshot.dictionaries ?? [])
            .filter((dictionary) => dictionary.termCount > 0)
            .map(({ title, displayName, favorite }) =>
                displayName
                    ? { title, favorite, displayName }
                    : { title, favorite }
            ),
    };
}

export interface HoshidictsDesktopSnapshot extends HoshidictsManagerSnapshot {
    effectiveEnabled: boolean;
    overlay: {
        running: boolean;
        restartRequired: boolean;
    };
}

export interface HoshidictsActionResult {
    success: boolean;
    canceled?: boolean;
    error?: string | null;
    outcome?: {
        code:
            | 'preferencesSaved'
            | 'miningProfileSaved'
            | 'audioProfileSaved'
            | 'dictionaryImported'
            | 'yomitanDictionariesImported'
            | 'yomitanSettingsImported'
            | 'backupExported'
            | 'backupRestored'
            | 'recommendedInstalled'
            | 'updatesChecked'
            | 'dictionaryRemoved'
            | 'dictionaryChanged'
            | 'customDictionarySaved'
            | 'overlayRestarted';
        count?: number;
        title?: string;
    };
    document?: HoshidictsCustomDictionaryDocument;
    yomitanReport?: HoshidictsYomitanImportReport;
    state: HoshidictsDesktopSnapshot;
}

export interface HoshidictsDictionaryEnabledRequest {
    id: string;
    enabled: boolean;
}

export interface HoshidictsDictionaryPresentationRequest {
    id: string;
    favorite: boolean;
}

export interface HoshidictsRenameDictionaryRequest {
    id: string;
    displayName: string | null;
}

export interface HoshidictsMoveDictionaryRequest {
    id: string;
    direction: HoshidictsMoveDirection;
}

export interface HoshidictsMoveDictionaryToPositionRequest {
    id: string;
    position: number;
}

export interface HoshidictsInstallRecommendedRequest {
    id: HoshidictsRecommendedDictionaryId;
}

export interface HoshidictsSaveCustomDictionaryRequest {
    text: string;
    expectedRevision: string;
}

export type HoshidictsCustomEntryRequest = HoshidictsCustomDictionaryEntry;
