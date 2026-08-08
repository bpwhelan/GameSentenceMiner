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
    restartOverlay: 'hoshidicts.restartOverlay',
} as const;

export const HOSHIDICTS_BUS_TOPICS = {
    openSettings: 'hoshidicts.openSettings',
    readerPreferences: 'hoshidicts.readerPreferences',
} as const;

export const HOSHIDICTS_READER_CLIENT_ID = 'overlay.hoshidicts-reader';

export type HoshidictsSchedule = 'off' | 'daily' | 'weekly' | 'monthly';
export type HoshidictsLookupMode = 'shift' | 'hover';
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
    activationKey: HoshidictsActivationKey;
    sourceHighlightEnabled: boolean;
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
    frequencyCount: number;
    pitchCount: number;
    kanjiCount: number;
    installedAt: string;
}

export interface HoshidictsRecommendedDictionaryState {
    id: HoshidictsRecommendedDictionaryId;
    installed: boolean;
}

export interface HoshidictsProgress {
    phase: HoshidictsProgressPhase;
    scope?: 'dictionary' | 'preferences' | 'mining';
    title?: string;
    completed?: number;
    total?: number;
}

export interface HoshidictsManagerSnapshot {
    revision: number;
    dictionaries: HoshidictsDictionaryState[];
    recommendedDictionaries: HoshidictsRecommendedDictionaryState[];
    miningProfile: HoshidictsMiningProfile;
    lookupMode: HoshidictsLookupMode;
    activationKey: HoshidictsActivationKey;
    sourceHighlightEnabled: boolean;
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
            | 'overlayRestarted';
        count?: number;
        title?: string;
    };
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
