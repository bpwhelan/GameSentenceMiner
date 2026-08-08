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
    getOverlayRuntimeState,
    markOverlayHoshidictsReaderPreferencesApplied,
    restartOverlay,
} from '../../ui/front.js';
import {
    HOSHIDICTS_BUS_TOPICS,
    HOSHIDICTS_READER_CLIENT_ID,
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
        applyReaderPreferences,
        getMiningOptions: fetchHoshidictsMiningOptions,
        restartOverlay,
    });

    if (getBusConnectInfo()) {
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
