import type { BrowserWindow } from 'electron';

import { getConfiguredHoshidictsEnabled } from '../../gsm_config.js';
import {
    configureHoshidictsActivationKeyProvider,
    configureHoshidictsDefinitionBlurProvider,
    configureHoshidictsLookupControlsProvider,
    configureHoshidictsLookupModeProvider,
    configureHoshidictsOnlyScanJapaneseTextProvider,
    configureHoshidictsPopupHideDelayProvider,
    configureHoshidictsPopupHeightProvider,
    configureHoshidictsPopupColumnsProvider,
    configureHoshidictsPopupNestingMaxDepthProvider,
    configureHoshidictsPopupOpacityPercentProvider,
    configureHoshidictsPopupToolbarPositionProvider,
    configureHoshidictsPopupWidthProvider,
    configureHoshidictsShowLookupCountsProvider,
    configureHoshidictsSourceHighlightProvider,
    configureHoshidictsThemeProvider,
    configureHoshidictsCustomDictionarySyncProvider,
    getOverlayHoshidictsEnabledAtLaunch,
    getOverlayHoshidictsActivationKeyAtLaunch,
    getOverlayHoshidictsDefinitionBlurAtLaunch,
    getOverlayHoshidictsLookupControlsAtLaunch,
    getOverlayHoshidictsLookupModeAtLaunch,
    getOverlayHoshidictsOnlyScanJapaneseTextAtLaunch,
    getOverlayHoshidictsPopupHideDelayAtLaunch,
    getOverlayHoshidictsPopupHeightAtLaunch,
    getOverlayHoshidictsPopupColumnsAtLaunch,
    getOverlayHoshidictsPopupNestingMaxDepthAtLaunch,
    getOverlayHoshidictsPopupOpacityPercentAtLaunch,
    getOverlayHoshidictsPopupToolbarPositionAtLaunch,
    getOverlayHoshidictsPopupButtonsApplied,
    getOverlayHoshidictsShowLookupCountsAtLaunch,
    getOverlayHoshidictsSourceHighlightEnabledAtLaunch,
    getOverlayHoshidictsPopupWidthAtLaunch,
    getOverlayHoshidictsThemeAtLaunch,
    getOverlayHoshidictsAudioProfileRestartRequired,
    getOverlayRuntimeState,
    markOverlayHoshidictsAudioProfileApplied,
    markOverlayHoshidictsAudioProfileSyncFailed,
    markOverlayHoshidictsReaderPreferencesApplied,
    restartOverlay,
} from '../../ui/front.js';
import {
    hoshidictsReaderPreferencesFromSnapshot,
    type HoshidictsAudioProfile,
    type HoshidictsCustomEntryRequest,
    type HoshidictsReaderPreferences,
} from '../../../shared/features/hoshidicts.js';
import {
    configureHoshidictsControlChannel,
    HOSHIDICTS_CONTROL_METHODS,
    isHoshidictsReaderControlConnected,
    requestHoshidictsReader,
    startHoshidictsControlChannel,
    stopHoshidictsControlChannel,
} from './control_channel.js';
import { registerHoshidictsIPC } from './ipc.js';
import { fetchHoshidictsMiningOptions } from './mining_options.js';
import {
    getHoshidictsManager,
    startHoshidictsManager as startManager,
    stopHoshidictsManager as stopManager,
} from './manager.js';
import {
    getHoshidictsSettingsWindow,
    openHoshidictsSettingsWindow,
} from './window.js';

let featureRegistered = false;
let readerPreferencesRevision = 0;
let audioProfileRevision = 0;

function customEntryFromPayload(value: unknown): HoshidictsCustomEntryRequest {
    if (!value || typeof value !== 'object') {
        throw new Error('Custom dictionary entry must be an object.');
    }
    const candidate = value as Partial<HoshidictsCustomEntryRequest>;
    if (
        typeof candidate.term !== 'string' ||
        typeof candidate.reading !== 'string' ||
        typeof candidate.definition !== 'string'
    ) {
        throw new Error('Custom dictionary entry fields must be strings.');
    }
    return {
        term: candidate.term,
        reading: candidate.reading,
        definition: candidate.definition,
    };
}

async function deliverReaderPreferences(
    preferences: HoshidictsReaderPreferences,
    revision: number
): Promise<boolean> {
    if (
        revision !== readerPreferencesRevision ||
        !isHoshidictsReaderControlConnected()
    ) {
        return false;
    }
    try {
        await requestHoshidictsReader(
            HOSHIDICTS_CONTROL_METHODS.readerPreferences,
            preferences,
            2000
        );
        if (revision !== readerPreferencesRevision) {
            return false;
        }
        return markOverlayHoshidictsReaderPreferencesApplied(preferences);
    } catch (error) {
        console.warn('[Hoshidicts] Could not update the running reader.', error);
        return false;
    }
}

async function applyReaderPreferences(
    preferences: HoshidictsReaderPreferences
): Promise<boolean> {
    readerPreferencesRevision += 1;
    return await deliverReaderPreferences(
        preferences,
        readerPreferencesRevision
    );
}

async function deliverAudioProfile(
    profile: HoshidictsAudioProfile,
    revision: number
): Promise<boolean> {
    if (revision !== audioProfileRevision) {
        return false;
    }
    if (!isHoshidictsReaderControlConnected()) {
        markOverlayHoshidictsAudioProfileSyncFailed();
        return false;
    }
    try {
        await requestHoshidictsReader(
            HOSHIDICTS_CONTROL_METHODS.audioProfile,
            profile,
            2000
        );
        if (revision !== audioProfileRevision) {
            return false;
        }
        return markOverlayHoshidictsAudioProfileApplied(profile);
    } catch (error) {
        markOverlayHoshidictsAudioProfileSyncFailed();
        console.warn('[Hoshidicts] Could not update reader audio settings.', error);
        return false;
    }
}

async function applyAudioProfile(
    profile: HoshidictsAudioProfile
): Promise<boolean> {
    audioProfileRevision += 1;
    return await deliverAudioProfile(profile, audioProfileRevision);
}

async function synchronizeConnectedReader(): Promise<void> {
    const preferencesRevision = readerPreferencesRevision;
    const profileRevision = audioProfileRevision;
    const snapshot = await getHoshidictsManager().getSnapshot();
    await deliverReaderPreferences(
        hoshidictsReaderPreferencesFromSnapshot(snapshot),
        preferencesRevision
    );
    await deliverAudioProfile(snapshot.audioProfile, profileRevision);
}

export function registerHoshidictsFeature(deps: {
    getMainWindow: () => BrowserWindow | null;
}): void {
    if (featureRegistered) {
        return;
    }
    featureRegistered = true;

    registerHoshidictsIPC({
        getMainWindow: deps.getMainWindow,
        getSettingsWindow: getHoshidictsSettingsWindow,
        openSettingsWindow: openHoshidictsSettingsWindow,
        getOverlayRuntimeState,
        getConfiguredFeatureEnabled: getConfiguredHoshidictsEnabled,
        getOverlayFeatureEnabledAtLaunch:
            getOverlayHoshidictsEnabledAtLaunch,
        getOverlayLookupModeAtLaunch:
            getOverlayHoshidictsLookupModeAtLaunch,
        getOverlayLookupControlsAtLaunch:
            getOverlayHoshidictsLookupControlsAtLaunch,
        getOverlayActivationKeyAtLaunch:
            getOverlayHoshidictsActivationKeyAtLaunch,
        getOverlaySourceHighlightEnabledAtLaunch:
            getOverlayHoshidictsSourceHighlightEnabledAtLaunch,
        getOverlayOnlyScanJapaneseTextAtLaunch:
            getOverlayHoshidictsOnlyScanJapaneseTextAtLaunch,
        getOverlayPopupHideDelayAtLaunch:
            getOverlayHoshidictsPopupHideDelayAtLaunch,
        getOverlayShowLookupCountsAtLaunch:
            getOverlayHoshidictsShowLookupCountsAtLaunch,
        getOverlayAudioProfileRestartRequired:
            getOverlayHoshidictsAudioProfileRestartRequired,
        getOverlayPopupNestingMaxDepthAtLaunch:
            getOverlayHoshidictsPopupNestingMaxDepthAtLaunch,
        getOverlayDefinitionBlurAtLaunch:
            getOverlayHoshidictsDefinitionBlurAtLaunch,
        getOverlayPopupWidthAtLaunch:
            getOverlayHoshidictsPopupWidthAtLaunch,
        getOverlayPopupHeightAtLaunch:
            getOverlayHoshidictsPopupHeightAtLaunch,
        getOverlayPopupColumnsAtLaunch:
            getOverlayHoshidictsPopupColumnsAtLaunch,
        getOverlayThemeAtLaunch: getOverlayHoshidictsThemeAtLaunch,
        getOverlayPopupOpacityPercentAtLaunch:
            getOverlayHoshidictsPopupOpacityPercentAtLaunch,
        getOverlayPopupToolbarPositionAtLaunch:
            getOverlayHoshidictsPopupToolbarPositionAtLaunch,
        getOverlayPopupButtonsApplied:
            getOverlayHoshidictsPopupButtonsApplied,
        applyReaderPreferences,
        applyAudioProfile,
        getMiningOptions: fetchHoshidictsMiningOptions,
        restartOverlay,
    });
}

export async function startHoshidictsManager(): Promise<void> {
    const manager = getHoshidictsManager();
    void manager.syncCustomDictionary().catch((error) => {
        console.warn(
            '[Hoshidicts] Could not synchronize the custom dictionary during startup; using the last active version.',
            error
        );
    });
    await startManager();
    configureHoshidictsLookupModeProvider(
        async () => (await manager.getSnapshot()).lookupMode
    );
    configureHoshidictsLookupControlsProvider(async () => {
        const snapshot = await manager.getSnapshot();
        return {
            scanLength: snapshot.scanLength,
            maxResults: snapshot.maxResults,
            sortFrequencyDictionary: snapshot.sortFrequencyDictionary,
            sortFrequencyDictionaryOrder:
                snapshot.sortFrequencyDictionaryOrder,
        };
    });
    configureHoshidictsActivationKeyProvider(
        async () => (await getHoshidictsManager().getSnapshot()).activationKey
    );
    configureHoshidictsSourceHighlightProvider(
        async () =>
            (await getHoshidictsManager().getSnapshot())
                .sourceHighlightEnabled
    );
    configureHoshidictsOnlyScanJapaneseTextProvider(
        async () =>
            (await getHoshidictsManager().getSnapshot())
                .onlyScanJapaneseText
    );
    configureHoshidictsPopupHideDelayProvider(
        async () => (await manager.getSnapshot()).popupHideDelayMs
    );
    configureHoshidictsShowLookupCountsProvider(
        async () => (await manager.getSnapshot()).showLookupCounts
    );
    configureHoshidictsPopupNestingMaxDepthProvider(
        async () =>
            (await getHoshidictsManager().getSnapshot()).popupNestingMaxDepth
    );
    configureHoshidictsDefinitionBlurProvider(
        async () => (await manager.getSnapshot()).definitionBlur
    );
    configureHoshidictsPopupWidthProvider(
        async () => (await manager.getSnapshot()).popupWidthPx
    );
    configureHoshidictsPopupHeightProvider(
        async () => (await manager.getSnapshot()).popupHeightPx
    );
    configureHoshidictsPopupColumnsProvider(
        async () => (await manager.getSnapshot()).popupColumns
    );
    configureHoshidictsThemeProvider(
        async () => (await manager.getSnapshot()).theme
    );
    configureHoshidictsPopupOpacityPercentProvider(
        async () => (await manager.getSnapshot()).popupOpacityPercent
    );
    configureHoshidictsPopupToolbarPositionProvider(
        async () => (await manager.getSnapshot()).popupToolbarPosition
    );
    configureHoshidictsCustomDictionarySyncProvider(async () => {
        await manager.syncCustomDictionary();
    });
    configureHoshidictsControlChannel({
        async openSettings() {
            await openHoshidictsSettingsWindow();
            return { opened: true };
        },
        async addCustomEntry(value) {
            await manager.addCustomEntry(customEntryFromPayload(value));
            return { saved: true };
        },
        onReaderReady() {
            void synchronizeConnectedReader().catch((error) => {
                markOverlayHoshidictsAudioProfileSyncFailed();
                console.warn(
                    '[Hoshidicts] Could not initialize the connected reader.',
                    error
                );
            });
        },
    });
    try {
        await startHoshidictsControlChannel();
    } catch (error) {
        console.warn(
            '[Hoshidicts] Could not start the loopback control channel; live overlay controls are unavailable.',
            error
        );
    }
}

export async function stopHoshidictsManager(): Promise<void> {
    try {
        await stopHoshidictsControlChannel();
    } catch (error) {
        console.warn(
            '[Hoshidicts] Could not stop the loopback control channel cleanly.',
            error
        );
    }
    await stopManager();
}

export { getHoshidictsManager };
export {
    getHoshidictsSettingsWindow,
    openHoshidictsSettingsWindow,
} from './window.js';
