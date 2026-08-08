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
export type HoshidictsDefinitionBlurRevealMode = 'timed' | 'hover';
export const DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS = 300;
export const MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS = 5000;
export const MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD = 1;
export const MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD = 1_000_000;
export const MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS = 1000;
export const MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS = 3_600_000;
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

export interface HoshidictsReaderPreferences {
    lookupMode: HoshidictsLookupMode;
    popupHideDelayMs: number;
    definitionBlur: HoshidictsDefinitionBlurPreferences;
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
    popupHideDelayMs: number;
    definitionBlur: HoshidictsDefinitionBlurPreferences;
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
