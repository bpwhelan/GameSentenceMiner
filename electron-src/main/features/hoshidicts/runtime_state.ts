import { getConfiguredHoshidictsEnabled } from '../../gsm_config.js';
import {
    cloneHoshidictsReaderPreferences,
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
    // The launch environment cannot carry custom CSS, so the overlay really
    // does start with its default. Recording anything else here would hide the
    // restart prompt when the control channel never delivers the saved value.
    state.appliedReaderPreferences = {
        ...cloneHoshidictsReaderPreferences(configuration.preferences),
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

/**
 * The overlay is a separate process, so its launch settings travel as
 * environment variables. Preferences are already normalized here, and the
 * overlay re-parses them through the same shared spec table, so one JSON
 * variable carries the whole set.
 *
 * customPopupCss is excluded: it may be up to
 * MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH (32 KiB), and Windows caps a single
 * environment variable at 32,767 characters. The control channel delivers it.
 */
export function buildHoshidictsOverlayEnvironment(
    configuration: HoshidictsLaunchConfiguration
): Record<string, string> {
    const { customPopupCss: _customPopupCss, ...preferences } =
        normalizeHoshidictsReaderPreferences(configuration.preferences);
    return {
        GSM_HOSHIDICTS_ENABLED: configuration.enabled ? '1' : '0',
        GSM_HOSHIDICTS_READER_PREFERENCES: JSON.stringify(preferences),
    };
}

export function buildHoshidictsControlEnvironment(): Record<string, string> {
    const port = getHoshidictsControlPort();
    return port ? { [HOSHIDICTS_CONTROL_ENV]: String(port) } : {};
}
