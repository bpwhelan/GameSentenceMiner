import type { BrowserWindow } from 'electron';

import { getConfiguredHoshidictsEnabled } from '../../gsm_config.js';
import { bus, getBusConnectInfo } from '../../runtime/bus_client.js';
import {
    configureHoshidictsActivationKeyProvider,
    configureHoshidictsLookupModeProvider,
    configureHoshidictsPopupHideDelayProvider,
    configureHoshidictsSourceHighlightProvider,
    getOverlayHoshidictsEnabledAtLaunch,
    getOverlayHoshidictsActivationKeyAtLaunch,
    getOverlayHoshidictsLookupModeAtLaunch,
    getOverlayHoshidictsPopupHideDelayAtLaunch,
    getOverlayHoshidictsSourceHighlightEnabledAtLaunch,
    getOverlayHoshidictsAudioProfileRestartRequired,
    getOverlayRuntimeState,
    markOverlayHoshidictsAudioProfileApplied,
    markOverlayHoshidictsAudioProfileSyncFailed,
    markOverlayHoshidictsReaderPreferencesApplied,
    restartOverlay,
} from '../../ui/front.js';
import {
    HOSHIDICTS_BUS_TOPICS,
    HOSHIDICTS_READER_CLIENT_ID,
    type HoshidictsAudioProfile,
    type HoshidictsReaderPreferences,
} from '../../../shared/features/hoshidicts.js';
import { registerHoshidictsIPC } from './ipc.js';
import { fetchHoshidictsMiningOptions } from './mining_options.js';
import {
    getHoshidictsManager,
    startHoshidictsManager as startManager,
    stopHoshidictsManager,
} from './manager.js';
import {
    getHoshidictsSettingsWindow,
    openHoshidictsSettingsWindow,
} from './window.js';

let featureRegistered = false;

async function applyReaderPreferences(
    preferences: HoshidictsReaderPreferences
): Promise<boolean> {
    if (!getBusConnectInfo() || !bus.isConnected(HOSHIDICTS_READER_CLIENT_ID)) {
        return false;
    }
    try {
        await bus.request(
            HOSHIDICTS_READER_CLIENT_ID,
            HOSHIDICTS_BUS_TOPICS.readerPreferences,
            preferences,
            2000
        );
        return markOverlayHoshidictsReaderPreferencesApplied(preferences);
    } catch (error) {
        console.warn('[Hoshidicts] Could not update the running reader.', error);
        return false;
    }
}

async function applyAudioProfile(
    profile: HoshidictsAudioProfile
): Promise<boolean> {
    if (!getBusConnectInfo() || !bus.isConnected(HOSHIDICTS_READER_CLIENT_ID)) {
        markOverlayHoshidictsAudioProfileSyncFailed();
        return false;
    }
    try {
        await bus.request(
            HOSHIDICTS_READER_CLIENT_ID,
            HOSHIDICTS_BUS_TOPICS.audioProfile,
            profile,
            2000
        );
        return markOverlayHoshidictsAudioProfileApplied(profile);
    } catch (error) {
        markOverlayHoshidictsAudioProfileSyncFailed();
        console.warn('[Hoshidicts] Could not update reader audio settings.', error);
        return false;
    }
}

async function synchronizeConnectedReader(): Promise<void> {
    const snapshot = await getHoshidictsManager().getSnapshot();
    await applyReaderPreferences({
        lookupMode: snapshot.lookupMode,
        activationKey: snapshot.activationKey,
        sourceHighlightEnabled: snapshot.sourceHighlightEnabled,
        popupHideDelayMs: snapshot.popupHideDelayMs,
    });
    await applyAudioProfile(snapshot.audioProfile);
}

export function isHoshidictsOverlaySettingsClient(clientId: string): boolean {
    return clientId.startsWith('overlay.hoshidicts-settings.');
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
        getOverlayActivationKeyAtLaunch:
            getOverlayHoshidictsActivationKeyAtLaunch,
        getOverlaySourceHighlightEnabledAtLaunch:
            getOverlayHoshidictsSourceHighlightEnabledAtLaunch,
        getOverlayPopupHideDelayAtLaunch:
            getOverlayHoshidictsPopupHideDelayAtLaunch,
        getOverlayAudioProfileRestartRequired:
            getOverlayHoshidictsAudioProfileRestartRequired,
        applyReaderPreferences,
        applyAudioProfile,
        getMiningOptions: fetchHoshidictsMiningOptions,
        restartOverlay,
    });

    if (getBusConnectInfo()) {
        bus.on('client-connected', (clientId: string) => {
            if (clientId !== HOSHIDICTS_READER_CLIENT_ID) {
                return;
            }
            void synchronizeConnectedReader().catch((error) => {
                markOverlayHoshidictsAudioProfileSyncFailed();
                console.warn(
                    '[Hoshidicts] Could not initialize the connected reader.',
                    error
                );
            });
        });
        bus.handle(HOSHIDICTS_BUS_TOPICS.openSettings, async (message) => {
            if (!isHoshidictsOverlaySettingsClient(message.src)) {
                throw new Error(
                    'Only the GSM overlay may open Hoshidicts settings.'
                );
            }
            await openHoshidictsSettingsWindow();
            return { opened: true };
        });
    } else {
        console.warn(
            '[Hoshidicts] Desktop message bus is unavailable; overlay settings shortcut is disabled.'
        );
    }
}

export async function startHoshidictsManager(): Promise<void> {
    await startManager();
    configureHoshidictsLookupModeProvider(
        async () => (await getHoshidictsManager().getSnapshot()).lookupMode
    );
    configureHoshidictsActivationKeyProvider(
        async () => (await getHoshidictsManager().getSnapshot()).activationKey
    );
    configureHoshidictsSourceHighlightProvider(
        async () =>
            (await getHoshidictsManager().getSnapshot())
                .sourceHighlightEnabled
    );
    configureHoshidictsPopupHideDelayProvider(
        async () =>
            (await getHoshidictsManager().getSnapshot()).popupHideDelayMs
    );
}

export { getHoshidictsManager, stopHoshidictsManager };
export {
    getHoshidictsSettingsWindow,
    openHoshidictsSettingsWindow,
} from './window.js';
