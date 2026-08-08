export const HOSHIDICTS_CHANNELS = {
    openSettings: 'hoshidicts.openSettings',
    getState: 'hoshidicts.getState',
    progress: 'hoshidicts.progress',
    importDictionary: 'hoshidicts.import',
    installAllRecommended: 'hoshidicts.installAllRecommended',
    installRecommended: 'hoshidicts.installRecommended',
    checkUpdates: 'hoshidicts.checkUpdates',
    removeDictionary: 'hoshidicts.remove',
    setSchedule: 'hoshidicts.setSchedule',
    setLookupMode: 'hoshidicts.setLookupMode',
    setReaderPreferences: 'hoshidicts.setReaderPreferences',
    setMiningProfile: 'hoshidicts.setMiningProfile',
    getMiningOptions: 'hoshidicts.getMiningOptions',
    setDictionaryEnabled: 'hoshidicts.setDictionaryEnabled',
    moveDictionary: 'hoshidicts.moveDictionary',
    getCustomDictionary: 'hoshidicts.getCustomDictionary',
    saveCustomDictionary: 'hoshidicts.saveCustomDictionary',
    restartOverlay: 'hoshidicts.restartOverlay',
} as const;

export const HOSHIDICTS_BUS_TOPICS = {
    openSettings: 'hoshidicts.openSettings',
    readerPreferences: 'hoshidicts.readerPreferences',
    addCustomEntry: 'hoshidicts.addCustomEntry',
} as const;

export const HOSHIDICTS_READER_CLIENT_ID = 'overlay.hoshidicts-reader';

export type HoshidictsSchedule = 'off' | 'daily' | 'weekly' | 'monthly';
export type HoshidictsLookupMode = 'shift' | 'hover';
export const DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS = 300;
export const MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS = 5000;
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

export type HoshidictsRecommendedDictionaryId = 'jmdict' | 'jmnedict';
export type HoshidictsMoveDirection = -1 | 1;
export type HoshidictsDuplicatePolicy = 'prevent' | 'allow';
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
}

export type HoshidictsMiningFieldName = keyof HoshidictsMiningFields;

export interface HoshidictsReaderPreferences {
    lookupMode: HoshidictsLookupMode;
    popupHideDelayMs: number;
}

export interface HoshidictsMiningProfile {
    version: 1;
    enabled: boolean;
    deck: string;
    model: string;
    fields: HoshidictsMiningFields;
    disabledFields: HoshidictsMiningFieldName[];
    tags: string[];
    duplicatePolicy: HoshidictsDuplicatePolicy;
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
    enabled: boolean;
    revision: string;
    isUpdatable: boolean;
    indexUrl: string | null;
    downloadUrl: string | null;
    language: string | null;
    termCount: number;
    installedAt: string;
}

export interface HoshidictsRecommendedDictionaryState {
    id: HoshidictsRecommendedDictionaryId;
    installed: boolean;
}

export interface HoshidictsProgress {
    phase: HoshidictsProgressPhase;
    scope?: 'dictionary' | 'preferences' | 'mining' | 'custom';
    title?: string;
    completed?: number;
    total?: number;
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
    lookupMode: HoshidictsLookupMode;
    popupHideDelayMs: number;
    schedule: HoshidictsSchedule;
    lastCheck: string | null;
    nextCheck: string | null;
    lastError: string | null;
    busy: boolean;
    progress: HoshidictsProgress;
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
            | 'dictionaryImported'
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
    state: HoshidictsDesktopSnapshot;
}

export type HoshidictsReaderPreferencesRequest = HoshidictsReaderPreferences;

export interface HoshidictsDictionaryEnabledRequest {
    id: string;
    enabled: boolean;
}

export interface HoshidictsMoveDictionaryRequest {
    id: string;
    direction: HoshidictsMoveDirection;
}

export interface HoshidictsInstallRecommendedRequest {
    id: HoshidictsRecommendedDictionaryId;
}

export interface HoshidictsSaveCustomDictionaryRequest {
    text: string;
    expectedRevision: string;
}

export type HoshidictsCustomEntryRequest = HoshidictsCustomDictionaryEntry;
