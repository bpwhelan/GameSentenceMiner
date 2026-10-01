import * as fs from 'node:fs';
import log from 'electron-log/main.js';

import type { UpdateManager } from './update_manager.js';

interface StartupBackendUpdateOptions {
    appVersionChanged: boolean;
    updateFlagPath: string;
    autoUpdateEnabled: boolean;
    hasPendingDesktopUpdate: boolean;
    forceUpdate: boolean;
}

type StartupUpdater = Pick<UpdateManager,
    'updateGSM' | 'lastBackendUpdateWasSuccessful' | 'lastBackendUpdateFailureReason'>;

/** Returns whether startup may record this desktop version as successfully synced. */
export async function syncStartupBackend(
    options: StartupBackendUpdateOptions,
    updater: StartupUpdater,
): Promise<boolean> {
    const updateFlagExists = fs.existsSync(options.updateFlagPath);
    const force = updateFlagExists || options.appVersionChanged || options.forceUpdate;
    // Unread release notes survive a quit, but install sessions do not. Run the
    // normal version check so the restored dialog gets a terminal sync result
    // even when automatic updates are disabled. An up-to-date backend is reused.
    if (!force && !options.autoUpdateEnabled && !options.hasPendingDesktopUpdate) {
        return true;
    }

    await updater.updateGSM(false, force);
    if (!updater.lastBackendUpdateWasSuccessful) {
        log.warn(
            `Backend update reported failure. Keeping the previous desktop version and any update marker for retry. Reason: ${updater.lastBackendUpdateFailureReason ?? 'unknown'}`
        );
        return false;
    }

    if (updateFlagExists) {
        try {
            if (fs.existsSync(options.updateFlagPath)) {
                fs.unlinkSync(options.updateFlagPath);
                log.info(`Cleared backend update marker: ${options.updateFlagPath}`);
            }
        } catch (error) {
            log.warn(`Failed to clear backend update marker (${options.updateFlagPath}):`, error);
        }
    }
    return true;
}
