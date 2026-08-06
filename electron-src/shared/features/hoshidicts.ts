export const HOSHIDICTS_CHANNELS = {
    openSettings: 'hoshidicts.openSettings',
    getState: 'hoshidicts.getState',
    progress: 'hoshidicts.progress',
    importDictionary: 'hoshidicts.import',
    installRecommended: 'hoshidicts.installRecommended',
    checkUpdates: 'hoshidicts.checkUpdates',
    removeDictionary: 'hoshidicts.remove',
    setSchedule: 'hoshidicts.setSchedule',
    setMiningProfile: 'hoshidicts.setMiningProfile',
    setFeatureEnabled: 'hoshidicts.setFeatureEnabled',
    setDictionaryEnabled: 'hoshidicts.setDictionaryEnabled',
    moveDictionary: 'hoshidicts.moveDictionary',
    restartOverlay: 'hoshidicts.restartOverlay',
} as const;

export const HOSHIDICTS_BUS_TOPICS = {
    openSettings: 'hoshidicts.openSettings',
} as const;

export type HoshidictsSchedule = 'off' | 'daily' | 'weekly' | 'monthly';
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

export interface HoshidictsMiningProfile {
    version: 1;
    enabled: boolean;
    deck: string;
    model: string;
    fields: HoshidictsMiningFields;
    tags: string[];
    duplicatePolicy: HoshidictsDuplicatePolicy;
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
    title?: string;
    completed?: number;
    total?: number;
}

export interface HoshidictsManagerSnapshot {
    featureEnabled: boolean;
    dictionaries: HoshidictsDictionaryState[];
    recommendedDictionaries: HoshidictsRecommendedDictionaryState[];
    miningProfile: HoshidictsMiningProfile;
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
    state: HoshidictsDesktopSnapshot;
}

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
