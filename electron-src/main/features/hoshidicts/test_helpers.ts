// Hoshidicts-private test factories. Deliberately not shared with unrelated GSM
// tests, and deliberately free of vitest imports so the Electron build can
// compile this directory without pulling a test framework into dist/.
import type { BrowserWindow } from 'electron';

import {
    createDefaultHoshidictsAudioProfile,
    createDefaultHoshidictsFieldOverwriteModes,
    createDefaultHoshidictsReaderPreferences,
    HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    type HoshidictsDictionaryState,
    type HoshidictsManagerSnapshot,
    type HoshidictsMiningFields,
    type HoshidictsMiningOptions,
    type HoshidictsMiningProfile,
    type HoshidictsReaderPreferencesRequest,
} from '../../../shared/features/hoshidicts.js';
import type { HoshidictsIPCDependencies } from './ipc.js';

/**
 * Overrides are intentionally typed as `unknown` values so rejection tests can
 * supply out-of-contract data while still having their field names checked.
 */
export type HoshidictsReaderPreferenceOverrides = Partial<
    Record<keyof HoshidictsReaderPreferencesRequest, unknown>
>;

export function makeHoshidictsReaderPreferences(
    overrides: HoshidictsReaderPreferenceOverrides = {}
): HoshidictsReaderPreferencesRequest {
    return {
        ...createDefaultHoshidictsReaderPreferences(),
        ...overrides,
    } as HoshidictsReaderPreferencesRequest;
}

export function makeHoshidictsDictionary(
    overrides: Partial<HoshidictsDictionaryState> = {}
): HoshidictsDictionaryState {
    return {
        id: 'alpha',
        title: 'Alpha',
        displayName: null,
        enabled: true,
        favorite: false,
        revision: 'one',
        isUpdatable: false,
        indexUrl: null,
        downloadUrl: null,
        language: 'ja',
        termCount: 1,
        frequencyCount: 0,
        pitchCount: 0,
        kanjiCount: 0,
        mediaCount: 0,
        frequencyMode: null,
        installedAt: '2026-08-08T00:00:00.000Z',
        updateScheduleOverride: null,
        lastUpdateCheck: null,
        ...overrides,
    };
}

function emptyMiningFields(): HoshidictsMiningFields {
    return {
        expression: '',
        reading: '',
        definition: '',
        sentence: '',
        frequency: '',
        pitch: '',
        audio: '',
    };
}

export function makeHoshidictsMiningProfile(
    overrides: Partial<HoshidictsMiningProfile> = {}
): HoshidictsMiningProfile {
    return {
        version: 3,
        enabled: true,
        deck: 'Default',
        model: '',
        fields: emptyMiningFields(),
        disabledFields: [],
        tags: ['hoshidicts'],
        checkForDuplicates: true,
        duplicateScope: 'collection',
        duplicateScopeCheckAllModels: false,
        duplicateBehavior: 'prevent',
        fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes(),
        fieldTemplates: null,
        ...overrides,
    };
}

export function makeHoshidictsMiningOptions(
    overrides: Partial<HoshidictsMiningOptions> = {}
): HoshidictsMiningOptions {
    return {
        connected: true,
        gsmAnkiEnabled: true,
        decks: ['Mining'],
        noteTypes: ['Kiku'],
        selectedNoteType: 'Kiku',
        fields: ['Expression'],
        suggestedFields: { ...emptyMiningFields(), expression: 'Expression' },
        resolvedFields: { ...emptyMiningFields(), expression: 'Expression' },
        suggestedFieldTemplates: { Expression: '{expression}' },
        resolvedFieldTemplates: {
            Expression: { value: '{expression}', overwriteMode: 'coalesce' },
        },
        warnings: [],
        error: null,
        ...overrides,
    };
}

/** A manager snapshot: the reader preferences plus the surrounding state. */
export function makeHoshidictsSnapshot(
    overrides: Partial<HoshidictsManagerSnapshot> = {}
): HoshidictsManagerSnapshot {
    return {
        ...makeHoshidictsReaderPreferences(),
        revision: 1,
        activeProfileId: 'default',
        profiles: [{ id: 'default', name: 'Default' }],
        dictionaries: [],
        tabGroups: [],
        customDictionaryActive: false,
        recommendedDictionaries:
            HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.map((id) => ({
                id,
                installed: false,
            })),
        miningProfile: makeHoshidictsMiningProfile(),
        audioProfile: createDefaultHoshidictsAudioProfile(),
        schedule: 'off',
        lastCheck: null,
        nextCheck: null,
        lastError: null,
        busy: false,
        progress: { phase: 'idle' },
        ...overrides,
    };
}

/**
 * The slim IPC dependency set. Callers override only what their case exercises;
 * anything they want to assert on should be passed in as their own spy.
 */
export function createHoshidictsIpcDependencies(
    overrides: Partial<HoshidictsIPCDependencies> = {}
): HoshidictsIPCDependencies {
    return {
        getMainWindow: () => null,
        getSettingsWindow: () => null,
        openSettingsWindow: async () => null as unknown as BrowserWindow,
        getOverlayRuntimeState: () => ({ isRunning: true, source: 'manual' }),
        getConfiguredFeatureEnabled: () => true,
        getOverlayFeatureEnabledAtLaunch: () => null,
        getAppliedReaderPreferences: () => null,
        getOverlayAudioProfileRestartRequired: () => false,
        applyReaderPreferences: async () => true,
        applyAudioProfile: async () => true,
        getMiningOptions: async () => makeHoshidictsMiningOptions(),
        restartOverlay: async () => true,
        ...overrides,
    };
}
