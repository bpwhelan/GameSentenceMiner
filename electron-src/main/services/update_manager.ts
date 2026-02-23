import { app, dialog, Notification } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import * as fs from 'node:fs';
import * as path from 'node:path';

import log from 'electron-log/main.js';
import {
    APP_NAME,
    BASE_DIR,
    isDev,
    PACKAGE_NAME,
} from '../util.js';
import { getPullPreReleases, getPythonExtras, setPythonExtras } from '../store.js';
import { checkForUpdates } from '../update_checker.js';
import {
    checkAndInstallUV,
    cleanUvCache,
    getInstalledPackageVersion,
    installPackageNoDeps,
    resolveRequestedExtras,
    syncLockedEnvironment,
} from './python_ops.js';
import { devFaultInjector } from './dev_fault_injection.js';

type EnsureAndRunFn = (pythonPath: string) => Promise<void>;
type CloseAllFn = () => Promise<void>;
type PythonPathGetter = () => string;

interface UpdateManagerDependencies {
    getPythonPath: PythonPathGetter;
    closeAllPythonProcesses: CloseAllFn;
    ensureAndRunGSM: EnsureAndRunFn;
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function emitUpdateProgress(current: number, total: number, label: string): void {
    const safeTotal = Math.max(1, total);
    const safeCurrent = Math.max(0, Math.min(current, safeTotal));
    const text = label.trim();
    console.log(`UpdateProgress: ${safeCurrent}/${safeTotal} ${text}`);
}

function getPreReleasePackageSpecifier(branch: string): string {
    return `git+https://github.com/bpwhelan/GameSentenceMiner@${branch}`;
}

function getAutoUpdater(forceDev: boolean = false): AppUpdater {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.allowPrerelease = getPullPreReleases();
    autoUpdater.allowDowngrade = true;

    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'bpwhelan',
        repo: 'GameSentenceMiner',
        private: false,
        releaseType: getPullPreReleases() ? 'prerelease' : 'release',
    });

    if (forceDev) {
        autoUpdater.forceDevUpdateConfig = true;
    }

    return autoUpdater;
}

export class UpdateManager {
    private isUpdating = false;
    private isCheckingAppUpdate = false;
    private gsmUpdatePromise: Promise<void> = Promise.resolve();
    private lastBackendUpdateSucceeded = true;
    private lastBackendUpdateError: string | null = null;

    public constructor(private readonly deps: UpdateManagerDependencies) {}

    public get updateInProgress(): boolean {
        return this.isUpdating;
    }

    public get anyUpdateInProgress(): boolean {
        return this.isUpdating || this.isCheckingAppUpdate;
    }

    public get lastBackendUpdateWasSuccessful(): boolean {
        return this.lastBackendUpdateSucceeded;
    }

    public get lastBackendUpdateFailureReason(): string | null {
        return this.lastBackendUpdateError;
    }

    public async waitForNoActiveUpdates(pollIntervalMs: number = 200): Promise<void> {
        while (this.anyUpdateInProgress) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
    }

    public async autoUpdate(forceUpdate: boolean = false): Promise<void> {
        this.isCheckingAppUpdate = true;
        const autoUpdater = getAutoUpdater(forceUpdate);

        // Avoid duplicate listeners if checks are re-triggered.
        autoUpdater.removeAllListeners('update-downloaded');
        autoUpdater.removeAllListeners('error');

        autoUpdater.on('update-downloaded', async () => {
            log.info(
                'Application update downloaded. Waiting for Python update process to finish (if any)...'
            );

            try {
                devFaultInjector.maybeFail(
                    'autoupdate.await_backend_update',
                    'before waiting for backend update promise'
                );
                await this.gsmUpdatePromise;
            } catch (err) {
                log.error(
                    `Refusing to install app update because backend update promise rejected: ${toErrorMessage(
                        err
                    )}`
                );
                return;
            }

            log.info('Python process is stable. Proceeding with application restart.');

            const updateFilePath = path.join(BASE_DIR, 'update_python.flag');
            try {
                devFaultInjector.maybeFail(
                    'autoupdate.write_update_flag',
                    'before writing backend update marker'
                );
                fs.writeFileSync(updateFilePath, '');
                log.info(`Wrote backend update marker: ${updateFilePath}`);
            } catch (err) {
                const message = `Failed to write backend update marker at ${updateFilePath}: ${toErrorMessage(
                    err
                )}`;
                log.error(message);
                dialog.showErrorBox(
                    'Update Error',
                    'Downloaded app update could not be finalized because backend update state could not be persisted. Restart and try again.'
                );
                return;
            }

            autoUpdater.quitAndInstall();
        });

        autoUpdater.on('error', (err: any) => {
            log.error(`Auto-update error: ${String(err?.message ?? err)}`);
        });

        try {
            log.info('Checking for application updates...');
            const result = await autoUpdater.checkForUpdates();
            if (!result) {
                log.warn('Update check returned no result.');
                return;
            }

            const latestVersion = result.updateInfo.version;
            const currentVersion = app.getVersion();
            const shouldOfferUpdate = forceUpdate || latestVersion !== currentVersion;

            log.info(
                `Application update check completed. current=${currentVersion}, latest=${latestVersion}, force=${forceUpdate}`
            );

            if (shouldOfferUpdate) {
                log.info(`New application version available: ${latestVersion}`);
                const dialogResult = await dialog.showMessageBox({
                    type: 'question',
                    title: 'Update Available',
                    message:
                        'A new version of the GSM Application is available. Would you like to download and install it now?',
                    buttons: ['Yes', 'No'],
                });

                if (dialogResult.response === 0) {
                    log.info('User accepted. Downloading application update...');
                    await autoUpdater.downloadUpdate();
                    log.info('Application update download started in the background.');
                } else {
                    log.info('User declined the application update.');
                }
            } else {
                log.info(`Application is up to date. Current version: ${app.getVersion()}`);
            }
        } catch (err: any) {
            log.error(`Failed to check for application updates: ${String(err?.message ?? err)}`);
        } finally {
            this.isCheckingAppUpdate = false;
        }
    }

    public async runUpdateChecks(
        shouldRestart: boolean = false,
        force: boolean = false,
        forceDev: boolean = false,
        preReleaseBranch: string | null = null
    ): Promise<void> {
        log.info('Starting full update process...');
        await this.updateGSM(shouldRestart, force, preReleaseBranch);
        if (!this.lastBackendUpdateSucceeded) {
            log.warn(
                `Skipping application update check because backend update failed: ${
                    this.lastBackendUpdateError ?? 'unknown reason'
                }`
            );
            return;
        }
        log.info('Python backend update check is complete.');
        await this.autoUpdate(forceDev);
        log.info('Application update check is complete.');
    }

    public async updateGSM(
        shouldRestart: boolean = false,
        force: boolean = false,
        preReleaseBranch: string | null = null
    ): Promise<void> {
        if (this.isUpdating) {
            log.warn('Backend update already in progress. Waiting for current update run to finish.');
            await this.gsmUpdatePromise;
            return;
        }
        this.gsmUpdatePromise = this.updateGSMInternal(shouldRestart, force, preReleaseBranch);
        await this.gsmUpdatePromise;
    }

    private async updateGSMInternal(
        shouldRestart: boolean = false,
        force: boolean = false,
        preReleaseBranch: string | null = null
    ): Promise<void> {
        this.isUpdating = true;
        this.lastBackendUpdateSucceeded = false;
        this.lastBackendUpdateError = null;

        const pythonPath = this.deps.getPythonPath();
        if (!pythonPath) {
            this.lastBackendUpdateError = 'pythonPath is not initialized';
            log.warn('Skipping Python update because pythonPath is not initialized yet.');
            this.isUpdating = false;
            return;
        }

        const normalizedPreReleaseBranch =
            typeof preReleaseBranch === 'string' ? preReleaseBranch.trim() : '';
        const preRelease = normalizedPreReleaseBranch.length > 0;
        log.info(
            `Starting Python update internal process. force=${force}, restart=${shouldRestart}, prerelease=${preRelease}`
        );

        try {
            const totalSteps = shouldRestart ? 7 : 6;
            emitUpdateProgress(1, totalSteps, 'Checking for backend updates');

            devFaultInjector.maybeFail('update.check_for_updates');
            const { updateAvailable, latestVersion } = await checkForUpdates();
            const installedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
            log.info(
                `Backend version check: installed=${installedVersion ?? 'not installed'}, latest=${
                    latestVersion ?? 'unknown'
                }, updateAvailable=${updateAvailable}, force=${force}`
            );

            // Resolve extras once and warn about any unsupported ones.
            const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
                getPythonExtras()
            );
            if (ignoredExtras.length > 0) {
                setPythonExtras(selectedExtras);
                log.warn(
                    `Dropped unsupported extras (${ignoredExtras.join(', ')}). Allowed: ${
                        allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
                    }.`
                );
            }

            if (updateAvailable || force) {
                emitUpdateProgress(2, totalSteps, 'Stopping running backend processes');
                devFaultInjector.maybeFail('update.close_running_processes');
                await this.deps.closeAllPythonProcesses();
                await new Promise((resolve) => setTimeout(resolve, 3000));

                emitUpdateProgress(3, totalSteps, 'Ensuring uv runtime tooling');
                devFaultInjector.maybeFail('update.ensure_uv');
                await checkAndInstallUV(pythonPath);

                // Determine what package specifier to install.
                let packageSpecifier: string;
                if (preRelease) {
                    packageSpecifier = getPreReleasePackageSpecifier(normalizedPreReleaseBranch);
                } else if (isDev) {
                    packageSpecifier = '.';
                } else if (latestVersion) {
                    packageSpecifier = `${PACKAGE_NAME}==${latestVersion}`;
                } else {
                    packageSpecifier = PACKAGE_NAME;
                }

                log.info(
                    `Syncing environment and installing ${packageSpecifier} with extras: ${
                        selectedExtras.length > 0 ? selectedExtras.join(', ') : 'none'
                    }`
                );

                try {
                    emitUpdateProgress(4, totalSteps, 'Syncing dependencies from lockfile');
                    devFaultInjector.maybeFail('update.sync_lockfile');
                    await syncLockedEnvironment(pythonPath, selectedExtras, false);
                    devFaultInjector.maybeFail('update.install_package');
                    await installPackageNoDeps(pythonPath, packageSpecifier, true);
                } catch (err) {
                    log.error('Sync failed, cleaning uv cache and retrying once.', err);
                    emitUpdateProgress(4, totalSteps, 'Retrying sync after cache clean');
                    devFaultInjector.maybeFail('update.retry.clean_uv_cache');
                    await cleanUvCache(pythonPath);
                    devFaultInjector.maybeFail('update.retry.sync_lockfile');
                    await syncLockedEnvironment(pythonPath, selectedExtras, false);
                    devFaultInjector.maybeFail('update.retry.install_package');
                    await installPackageNoDeps(pythonPath, packageSpecifier, true);
                }

                const updatedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
                log.info(
                    `Backend version after update attempt: ${
                        updatedVersion ?? 'unknown (pip show did not return a version)'
                    }`
                );

                emitUpdateProgress(5, totalSteps, 'Finalizing backend update');
                new Notification({
                    title: 'Update Successful',
                    body: `${APP_NAME} backend has been updated successfully.`,
                    timeoutType: 'default',
                }).show();

                if (shouldRestart) {
                    emitUpdateProgress(6, totalSteps, 'Restarting backend process');
                    devFaultInjector.maybeFail('update.restart_backend');
                    await this.deps.ensureAndRunGSM(pythonPath);
                    log.info('GSM successfully restarted after update.');
                    emitUpdateProgress(7, totalSteps, 'Update complete');
                } else {
                    emitUpdateProgress(6, totalSteps, 'Update complete');
                }
            } else {
                log.info('Python backend is already up-to-date.');
                emitUpdateProgress(1, 1, 'Python backend is already up to date');
            }
            this.lastBackendUpdateSucceeded = true;
            this.lastBackendUpdateError = null;
        } catch (error) {
            this.lastBackendUpdateSucceeded = false;
            this.lastBackendUpdateError = toErrorMessage(error);
            log.error(
                `An error occurred during the Python update process: ${this.lastBackendUpdateError}`,
                error
            );
            emitUpdateProgress(1, 1, 'Python backend update failed');
            try {
                new Notification({
                    title: 'Update Failed',
                    body: `${APP_NAME} backend update failed. Check logs for details.`,
                    timeoutType: 'default',
                }).show();
            } catch (notificationError) {
                log.warn(
                    `Failed to display update failure notification: ${toErrorMessage(
                        notificationError
                    )}`
                );
            }
        } finally {
            this.isUpdating = false;
            log.info('Finished Python update internal process.');
        }
    }
}
