import type { BrowserWindow } from 'electron';

import { bus, getBusConnectInfo } from '../../runtime/bus_client.js';
import {
    getOverlayHoshidictsEnabledAtLaunch,
    getOverlayRuntimeState,
    restartOverlay,
} from '../../ui/front.js';
import {
    HOSHIDICTS_BUS_TOPICS,
} from '../../../shared/features/hoshidicts.js';
import { registerHoshidictsIPC } from './ipc.js';
import {
    getHoshidictsSettingsWindow,
    openHoshidictsSettingsWindow,
} from './window.js';

let featureRegistered = false;

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
        getOverlayFeatureEnabledAtLaunch:
            getOverlayHoshidictsEnabledAtLaunch,
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

export {
    getHoshidictsManager,
    startHoshidictsManager,
    stopHoshidictsManager,
} from './manager.js';
export {
    getHoshidictsSettingsWindow,
    openHoshidictsSettingsWindow,
} from './window.js';
