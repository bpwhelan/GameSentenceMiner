import type { BrowserWindow } from 'electron';

import { getConfiguredHoshidictsEnabled } from '../../gsm_config.js';
import { getOverlayRuntimeState, restartOverlay } from '../../ui/front.js';
import {
    configureHoshidictsRuntime,
    getAppliedHoshidictsReaderPreferences,
    getHoshidictsEnabledAtLaunch,
    isHoshidictsAudioRestartRequired,
    markHoshidictsAudioProfileApplied,
    markHoshidictsAudioProfileSyncFailed,
    markHoshidictsReaderPreferencesApplied,
} from './runtime_state.js';
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
import { serializeCustomDictionaryEntry } from './custom_dictionary.js';
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
        return markHoshidictsReaderPreferencesApplied(preferences);
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
        markHoshidictsAudioProfileSyncFailed();
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
        return markHoshidictsAudioProfileApplied();
    } catch (error) {
        markHoshidictsAudioProfileSyncFailed();
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
        getOverlayFeatureEnabledAtLaunch: getHoshidictsEnabledAtLaunch,
        getAppliedReaderPreferences: getAppliedHoshidictsReaderPreferences,
        getOverlayAudioProfileRestartRequired: isHoshidictsAudioRestartRequired,
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
    configureHoshidictsRuntime({
        readerPreferences: async () =>
            hoshidictsReaderPreferencesFromSnapshot(await manager.getSnapshot()),
        customDictionarySync: async () => {
            await manager.syncCustomDictionary();
        },
    });
    configureHoshidictsControlChannel({
        async openSettings() {
            await openHoshidictsSettingsWindow();
            return { opened: true };
        },
        async addCustomEntry(value) {
            // serializeCustomDictionaryEntry validates every field, and
            // handleClientRequest turns any throw into { ok: false, error }.
            // Validate synchronously so a malformed entry still fails the request,
            // then let the recompile finish off the reader's critical path: it
            // rebuilds every entry and reloads the native engine, which is seconds
            // the popup should not sit through. addCustomEntry re-reads the source
            // inside the operation queue, so queued saves still append in order.
            const request = value as HoshidictsCustomEntryRequest;
            serializeCustomDictionaryEntry(request);
            void manager.addCustomEntry(request).catch((error) => {
                console.warn(
                    '[Hoshidicts] Could not add the custom dictionary entry.',
                    error
                );
            });
            return { saved: true };
        },
        onReaderReady() {
            void synchronizeConnectedReader().catch((error) => {
                markHoshidictsAudioProfileSyncFailed();
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
