import { getConfiguredHoshidictsEnabled } from '../../gsm_config.js';
import {
    cloneHoshidictsReaderPreferences,
    createDefaultHoshidictsPopupButtons,
    createDefaultHoshidictsReaderPreferences,
    DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
    normalizeHoshidictsReaderPreferences,
    type HoshidictsReaderPreferences,
    type HoshidictsReaderPreferencesRequest,
} from '../../../shared/features/hoshidicts.js';
import {
    getHoshidictsControlPort,
    HOSHIDICTS_CONTROL_ENV,
} from './control_channel.js';

export interface HoshidictsLaunchConfiguration {
    enabled: boolean;
    preferences: HoshidictsReaderPreferencesRequest;
}

/**
 * Everything the desktop app remembers about the overlay's Hoshidicts session.
 * Reader preferences are held as one object so the overlay and the settings
 * window compare and reset the same thing.
 */
interface HoshidictsRuntimeState {
    enabledAtLaunch: boolean | null;
    appliedReaderPreferences: HoshidictsReaderPreferencesRequest | null;
    audioRestartRequired: boolean;
}

const state: HoshidictsRuntimeState = {
    enabledAtLaunch: null,
    appliedReaderPreferences: null,
    audioRestartRequired: false,
};

let isOverlayRunning: () => boolean = () => false;
let readerPreferencesProvider: () => Promise<HoshidictsReaderPreferencesRequest> =
    async () => createDefaultHoshidictsReaderPreferences();
let customDictionarySyncProvider: () => Promise<void> = async () => undefined;

export interface HoshidictsRuntimeProviders {
    /** Reports overlay liveness without mutating runtime state. */
    overlayRunning?: () => boolean;
    readerPreferences?: () => Promise<HoshidictsReaderPreferencesRequest>;
    customDictionarySync?: () => Promise<void>;
}

export function configureHoshidictsRuntime(
    providers: HoshidictsRuntimeProviders
): void {
    isOverlayRunning = providers.overlayRunning ?? isOverlayRunning;
    readerPreferencesProvider =
        providers.readerPreferences ?? readerPreferencesProvider;
    customDictionarySyncProvider =
        providers.customDictionarySync ?? customDictionarySyncProvider;
}

export function resetHoshidictsRuntimeState(): void {
    state.enabledAtLaunch = null;
    state.appliedReaderPreferences = null;
    state.audioRestartRequired = false;
}

/** A stopped overlay has no applied state, so drop it before answering. */
function overlayIsLive(): boolean {
    if (isOverlayRunning()) {
        return true;
    }
    resetHoshidictsRuntimeState();
    return false;
}

function warnCustomDictionarySyncFailure(error: unknown): void {
    console.warn(
        '[Hoshidicts] Could not refresh the custom dictionary before overlay launch; using the last active version.',
        error
    );
}

export async function resolveHoshidictsLaunchConfiguration(): Promise<HoshidictsLaunchConfiguration> {
    const enabled = getConfiguredHoshidictsEnabled();
    if (!enabled) {
        return {
            enabled,
            preferences: createDefaultHoshidictsReaderPreferences(),
        };
    }
    try {
        void customDictionarySyncProvider().catch(
            warnCustomDictionarySyncFailure
        );
    } catch (error) {
        warnCustomDictionarySyncFailure(error);
    }
    try {
        return {
            enabled,
            preferences: normalizeHoshidictsReaderPreferences(
                await readerPreferencesProvider()
            ),
        };
    } catch (error) {
        console.warn(
            '[Hoshidicts] Could not load reader preferences; using defaults.',
            error
        );
        return {
            enabled,
            preferences: createDefaultHoshidictsReaderPreferences(),
        };
    }
}

export function markHoshidictsOverlayLaunched(
    configuration: HoshidictsLaunchConfiguration
): void {
    state.enabledAtLaunch = configuration.enabled;
    // The launch environment cannot carry popup buttons or custom CSS, so the
    // overlay really does start with their defaults. Recording anything else
    // here would hide the restart prompt when the control channel never
    // delivers the saved values.
    state.appliedReaderPreferences = {
        ...cloneHoshidictsReaderPreferences(configuration.preferences),
        popupButtons: createDefaultHoshidictsPopupButtons(),
        customPopupCss: DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
    };
    state.audioRestartRequired = false;
}

export function getHoshidictsEnabledAtLaunch(): boolean | null {
    return overlayIsLive() ? state.enabledAtLaunch : null;
}

export function getAppliedHoshidictsReaderPreferences(): HoshidictsReaderPreferencesRequest | null {
    if (!overlayIsLive() || state.appliedReaderPreferences === null) {
        return null;
    }
    return cloneHoshidictsReaderPreferences(state.appliedReaderPreferences);
}

export function markHoshidictsReaderPreferencesApplied(
    preferences: HoshidictsReaderPreferences
): boolean {
    if (!overlayIsLive()) {
        return false;
    }
    state.appliedReaderPreferences = cloneHoshidictsReaderPreferences(
        normalizeHoshidictsReaderPreferences(preferences)
    );
    return true;
}

export function markHoshidictsAudioProfileApplied(): boolean {
    if (!overlayIsLive()) {
        return false;
    }
    state.audioRestartRequired = false;
    return true;
}

export function markHoshidictsAudioProfileSyncFailed(): boolean {
    if (!overlayIsLive()) {
        return false;
    }
    state.audioRestartRequired = true;
    return true;
}

export function isHoshidictsAudioRestartRequired(): boolean {
    return overlayIsLive() && state.audioRestartRequired;
}

function flag(value: boolean): string {
    return value ? '1' : '0';
}

/**
 * The overlay is a separate process, so its launch settings travel as
 * environment variables. Preferences are already normalized here.
 */
export function buildHoshidictsOverlayEnvironment(
    configuration: HoshidictsLaunchConfiguration
): Record<string, string> {
    const preferences = normalizeHoshidictsReaderPreferences(
        configuration.preferences
    );
    return {
        GSM_HOSHIDICTS_ENABLED: flag(configuration.enabled),
        GSM_HOSHIDICTS_LOOKUP_MODE: preferences.lookupMode,
        GSM_HOSHIDICTS_ACTIVATION_KEY: preferences.activationKey,
        GSM_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED: flag(
            preferences.sourceHighlightEnabled
        ),
        GSM_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT: flag(
            preferences.onlyScanJapaneseText
        ),
        GSM_HOSHIDICTS_POPUP_HIDE_DELAY_MS: String(
            preferences.popupHideDelayMs
        ),
        GSM_HOSHIDICTS_SHOW_LOOKUP_COUNTS: flag(preferences.showLookupCounts),
        GSM_HOSHIDICTS_SHOW_COMPACT_DEFINITION_SUMMARY: flag(
            preferences.showCompactDefinitionSummary
        ),
        GSM_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT: String(
            preferences.compactDefinitionSummaryCount
        ),
        GSM_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_DICTIONARY:
            preferences.compactDefinitionSummaryDictionary ?? '',
        GSM_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA: flag(
            preferences.showPitchAccentFurigana
        ),
        GSM_HOSHIDICTS_PITCH_ACCENT_FURIGANA_DICTIONARY:
            preferences.pitchAccentFuriganaDictionary ?? '',
        GSM_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE: flag(
            preferences.showPitchAccentBadge
        ),
        GSM_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS: flag(
            preferences.hidePopupGrammarTags
        ),
        GSM_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH: String(
            preferences.popupNestingMaxDepth
        ),
        GSM_HOSHIDICTS_DEFINITION_BLUR_ENABLED: flag(
            preferences.definitionBlur.enabled
        ),
        GSM_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD: String(
            preferences.definitionBlur.lookupThreshold
        ),
        GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_MODE:
            preferences.definitionBlur.revealMode,
        GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS: String(
            preferences.definitionBlur.revealDelayMs
        ),
        GSM_HOSHIDICTS_POPUP_WIDTH_PX: String(preferences.popupWidthPx),
        GSM_HOSHIDICTS_POPUP_HEIGHT_PX: String(preferences.popupHeightPx),
        GSM_HOSHIDICTS_POPUP_COLUMNS: String(preferences.popupColumns),
        GSM_HOSHIDICTS_THEME: preferences.theme,
        GSM_HOSHIDICTS_POPUP_OPACITY_PERCENT: String(
            preferences.popupOpacityPercent
        ),
        GSM_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX: String(
            preferences.popupBackdropBlurPx
        ),
        GSM_HOSHIDICTS_POPUP_TOOLBAR_POSITION: preferences.popupToolbarPosition,
        GSM_HOSHIDICTS_SCAN_LENGTH: String(preferences.scanLength),
        GSM_HOSHIDICTS_MAX_RESULTS: String(preferences.maxResults),
        GSM_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY:
            preferences.sortFrequencyDictionary ?? '',
        GSM_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER:
            preferences.sortFrequencyDictionaryOrder,
        GSM_HOSHIDICTS_AVERAGE_FREQUENCY: flag(preferences.averageFrequency),
        GSM_HOSHIDICTS_SHOW_FREQUENCY_DICTIONARY_NAMES: flag(
            preferences.showFrequencyDictionaryNames
        ),
    };
}

export function buildHoshidictsControlEnvironment(): Record<string, string> {
    const port = getHoshidictsControlPort();
    return port ? { [HOSHIDICTS_CONTROL_ENV]: String(port) } : {};
}
