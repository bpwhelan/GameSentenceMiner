import { app, dialog, Notification } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';

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
import Logger from 'electron-log';
import { shouldAutoRebuildManagedPythonEnv } from './managed_python_repair.js';
import { installSessionManager } from './install_session_state.js';

type EnsureAndRunFn = (pythonPath: string) => Promise<void>;
type CloseAllFn = () => Promise<void>;
type PythonPathGetter = () => string;
type ReinstallPythonFn = () => Promise<void>;

interface UpdateManagerDependencies {
    getPythonPath: PythonPathGetter;
    closeAllPythonProcesses: CloseAllFn;
    ensureAndRunGSM: EnsureAndRunFn;
    reinstallPython: ReinstallPythonFn;
}

export interface BackendUpdateStatus {
    currentVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    checkedAt: string | null;
    error: string | null;
    checking: boolean;
    source: 'pypi' | 'prerelease-branch';
    branch: string | null;
}

export interface AppUpdateStatus {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    checkedAt: string | null;
    error: string | null;
    checking: boolean;
    channel: 'latest' | 'beta';
}

export interface UpdateStatusSnapshot {
    backend: BackendUpdateStatus;
    app: AppUpdateStatus;
    anyUpdateInProgress: boolean;
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

function updateInstallStage(
    stageId: 'prepare' | 'uv' | 'python' | 'venv' | 'verify_runtime' | 'lock_sync' | 'gsm_package' | 'backend_boot' | 'obs' | 'ffmpeg' | 'oneocr' | 'finalize',
    status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed',
    progressKind: 'bytes' | 'estimated' | 'indeterminate',
    progress: number | null,
    message: string,
    error?: string | null
): void {
    installSessionManager.updateStage({
        stageId,
        status,
        progressKind,
        progress,
        message,
        error: error ?? null,
    });
}

function startBackendUpdateSession(retryHandler: () => Promise<void>): void {
    installSessionManager.ensureSession('backend_update', retryHandler);
    updateInstallStage('prepare', 'completed', 'estimated', 1, 'Backend update session prepared.');
    updateInstallStage('python', 'skipped', 'indeterminate', 1, 'Managed Python runtime already installed.');
    updateInstallStage('venv', 'skipped', 'indeterminate', 1, 'Virtual environment already exists.');
}

function getPreReleasePackageSpecifier(branch: string): string {
    return `https://github.com/bpwhelan/GameSentenceMiner/archive/refs/heads/${branch}.zip`;
}

function getAutoUpdater(forceDev: boolean = false): AppUpdater {
    const { autoUpdater } = electronUpdater;
    const wantPreRelease = getPullPreReleases();
    const configuredChannel = wantPreRelease ? 'beta' : 'latest';
    autoUpdater.autoDownload = false;
    autoUpdater.allowPrerelease = wantPreRelease;

    // Always set channel explicitly to avoid sticky channel state between checks.
    autoUpdater.channel = configuredChannel;
    // When looking at pre-releases, never allow downgrading from a newer stable version.
    // Must be set after assigning channel because setting channel auto-enables downgrade.
    autoUpdater.allowDowngrade = !wantPreRelease;

    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'bpwhelan',
        repo: 'GameSentenceMiner',
        private: false,
        releaseType: wantPreRelease ? 'prerelease' : 'release',
    });

    if (forceDev) {
        autoUpdater.forceDevUpdateConfig = true;
    }

    log.info(
        `[Updater] current=${app.getVersion()} prereleaseEnabled=${wantPreRelease} ` +
        `channel=${configuredChannel} releaseType=${wantPreRelease ? 'prerelease' : 'release'}`
    );

    return autoUpdater;
}

export class UpdateManager {
    private isUpdating = false;
    private isCheckingAppUpdate = false;
    private gsmUpdatePromise: Promise<void> = Promise.resolve();
    private lastBackendUpdateSucceeded = true;
    private lastBackendUpdateError: string | null = null;
    private backendStatusCache: BackendUpdateStatus = {
        currentVersion: null,
        latestVersion: null,
        updateAvailable: false,
        checkedAt: null,
        error: null,
        checking: false,
        source: 'pypi',
        branch: null,
    };
    private appStatusCache: AppUpdateStatus = {
        currentVersion: app.getVersion(),
        latestVersion: null,
        updateAvailable: false,
        checkedAt: null,
        error: null,
        checking: false,
        channel: getPullPreReleases() ? 'beta' : 'latest',
    };

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

    public async getUpdateStatus(
        preReleaseBranch: string | null = null
    ): Promise<UpdateStatusSnapshot> {
        const pythonPath = this.deps.getPythonPath();
        const backendCurrentVersion = pythonPath
            ? await getInstalledPackageVersion(pythonPath, PACKAGE_NAME)
            : null;
        const normalizedPreReleaseBranch =
            typeof preReleaseBranch === 'string' ? preReleaseBranch.trim() : '';
        const backendSource = normalizedPreReleaseBranch ? 'prerelease-branch' : 'pypi';

        return {
            backend: {
                ...this.backendStatusCache,
                currentVersion: backendCurrentVersion,
                checking: this.isUpdating,
                source: backendSource,
                branch: normalizedPreReleaseBranch || null,
            },
            app: {
                ...this.appStatusCache,
                currentVersion: app.getVersion(),
                checking: this.isCheckingAppUpdate,
                channel: getPullPreReleases() ? 'beta' : 'latest',
            },
            anyUpdateInProgress: this.anyUpdateInProgress,
        };
    }

    public async checkForAvailableUpdates(
        preReleaseBranch: string | null = null,
        forceDev: boolean = false
    ): Promise<UpdateStatusSnapshot> {
        await this.checkBackendUpdateStatus(preReleaseBranch);
        await this.checkAppUpdateStatus(forceDev);
        return await this.getUpdateStatus(preReleaseBranch);
    }

    public async updateAvailableTargets(
        shouldRestart: boolean = true,
        preReleaseBranch: string | null = null,
        forceDev: boolean = false
    ): Promise<UpdateStatusSnapshot> {
        const status = await this.checkForAvailableUpdates(preReleaseBranch, forceDev);

        if (status.backend.updateAvailable) {
            await this.updateGSM(shouldRestart, false, preReleaseBranch);
        }

        if (status.app.updateAvailable) {
            await this.downloadAppUpdate(forceDev, status.app);
        }

        return await this.getUpdateStatus(preReleaseBranch);
    }

    public async autoUpdate(forceUpdate: boolean = false): Promise<void> {
        const status = await this.checkAppUpdateStatus(forceUpdate);
        if (!status.updateAvailable) {
            log.info(`Application is up to date. Current version: ${app.getVersion()}`);
            return;
        }

        Logger.info(`New application version available: ${status.latestVersion ?? 'unknown'}`);
        const dialogResult = await dialog.showMessageBox({
            type: 'question',
            title: 'Update Available',
            message:
                'A new version of the GSM Application is available. Would you like to download and install it now?',
            buttons: ['Yes', 'No'],
        });

        if (dialogResult.response === 0) {
            log.info('User accepted. Downloading application update...');
            await this.downloadAppUpdate(forceUpdate, status);
            log.info('Application update download started in the background.');
        } else {
            log.info('User declined the application update.');
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
                `Backend update failed before application update check: ${
                    this.lastBackendUpdateError ?? 'unknown reason'
                }`
            );
            log.info('Continuing with application update check despite backend update failure.');
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
        preReleaseBranch: string | null = null,
        autoRepairAttemptsRemaining: number = 1
    ): Promise<void> {
        startBackendUpdateSession(async () => {
            await this.updateGSMInternal(shouldRestart, force, preReleaseBranch, 1);
        });
        this.isUpdating = true;
        this.lastBackendUpdateSucceeded = false;
        this.lastBackendUpdateError = null;
        this.backendStatusCache = {
            ...this.backendStatusCache,
            checking: true,
            error: null,
        };

        const pythonPath = this.deps.getPythonPath();
        if (!pythonPath) {
            this.lastBackendUpdateError = 'pythonPath is not initialized';
            this.backendStatusCache = {
                ...this.backendStatusCache,
                checkedAt: new Date().toISOString(),
                error: this.lastBackendUpdateError,
                updateAvailable: false,
                checking: false,
            };
            log.warn('Skipping Python update because pythonPath is not initialized yet.');
            updateInstallStage('finalize', 'failed', 'estimated', null, 'Backend update failed.', this.lastBackendUpdateError);
            installSessionManager.finishActive('failed', 'Backend update failed.', this.lastBackendUpdateError);
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
            while (true) {
                const totalSteps = shouldRestart ? 7 : 6;
                emitUpdateProgress(1, totalSteps, 'Checking for backend updates');

                const installedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
                let updateAvailable = false;
                let latestVersion: string | null = null;

                if (preRelease) {
                    updateAvailable = force;
                    log.info(
                        `Pre-release backend mode enabled (branch: ${normalizedPreReleaseBranch}). ` +
                            `Skipping PyPI version check.`
                    );
                } else {
                    devFaultInjector.maybeFail('update.check_for_updates');
                    const versionCheck = await checkForUpdates();
                    updateAvailable = versionCheck.updateAvailable;
                    latestVersion = versionCheck.latestVersion;
                }

                log.info(
                    `Backend version check: installed=${installedVersion ?? 'not installed'}, latest=${
                        preRelease ? `branch:${normalizedPreReleaseBranch}` : latestVersion ?? 'unknown'
                    }, updateAvailable=${updateAvailable}, force=${force}, source=${
                        preRelease ? 'prerelease-branch' : 'pypi'
                    }`
                );
                this.backendStatusCache = {
                    currentVersion: installedVersion,
                    latestVersion: preRelease ? normalizedPreReleaseBranch : latestVersion,
                    updateAvailable: updateAvailable || force,
                    checkedAt: new Date().toISOString(),
                    error: null,
                    checking: true,
                    source: preRelease ? 'prerelease-branch' : 'pypi',
                    branch: preRelease ? normalizedPreReleaseBranch : null,
                };

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
                    updateInstallStage(
                        'verify_runtime',
                        'running',
                        'estimated',
                        0.1,
                        'Stopping running backend processes before updating...'
                    );
                    devFaultInjector.maybeFail('update.close_running_processes');
                    await this.deps.closeAllPythonProcesses();
                    await new Promise((resolve) => setTimeout(resolve, 3000));

                    emitUpdateProgress(3, totalSteps, 'Ensuring uv runtime tooling');
                    devFaultInjector.maybeFail('update.ensure_uv');
                    updateInstallStage(
                        'verify_runtime',
                        'running',
                        'estimated',
                        0.35,
                        'Ensuring uv runtime tooling...'
                    );
                    await checkAndInstallUV(pythonPath);
                    updateInstallStage(
                        'verify_runtime',
                        'completed',
                        'estimated',
                        1,
                        'uv runtime tooling is ready.'
                    );

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
                        updateInstallStage(
                            'lock_sync',
                            'running',
                            'estimated',
                            0.15,
                            'Syncing dependencies from the lockfile...'
                        );
                        await syncLockedEnvironment(pythonPath, selectedExtras, false, (event) => {
                            updateInstallStage(
                                'lock_sync',
                                'running',
                                'estimated',
                                event.progress,
                                event.message
                            );
                        });
                        updateInstallStage(
                            'lock_sync',
                            'completed',
                            'estimated',
                            1,
                            'Dependencies synced from the lockfile.'
                        );
                        devFaultInjector.maybeFail('update.install_package');
                        updateInstallStage(
                            'gsm_package',
                            'running',
                            'estimated',
                            0.15,
                            `Installing ${packageSpecifier}...`
                        );
                        await installPackageNoDeps(pythonPath, packageSpecifier, true, (event) => {
                            updateInstallStage(
                                'gsm_package',
                                'running',
                                'estimated',
                                event.progress,
                                event.message
                            );
                        });
                        updateInstallStage(
                            'gsm_package',
                            'completed',
                            'estimated',
                            1,
                            'Backend package updated.'
                        );
                    } catch (err) {
                        log.error('Sync failed, cleaning uv cache and retrying once.', err);
                        emitUpdateProgress(4, totalSteps, 'Retrying sync after cache clean');
                        devFaultInjector.maybeFail('update.retry.clean_uv_cache');
                        updateInstallStage(
                            'lock_sync',
                            'running',
                            'estimated',
                            0.25,
                            'Retrying dependency sync after cleaning the uv cache...'
                        );
                        await cleanUvCache(pythonPath);
                        devFaultInjector.maybeFail('update.retry.sync_lockfile');
                        await syncLockedEnvironment(pythonPath, selectedExtras, false, (event) => {
                            updateInstallStage(
                                'lock_sync',
                                'running',
                                'estimated',
                                event.progress,
                                event.message
                            );
                        });
                        updateInstallStage(
                            'lock_sync',
                            'completed',
                            'estimated',
                            1,
                            'Dependencies synced from the lockfile.'
                        );
                        devFaultInjector.maybeFail('update.retry.install_package');
                        updateInstallStage(
                            'gsm_package',
                            'running',
                            'estimated',
                            0.2,
                            `Installing ${packageSpecifier} after retry...`
                        );
                        await installPackageNoDeps(pythonPath, packageSpecifier, true, (event) => {
                            updateInstallStage(
                                'gsm_package',
                                'running',
                                'estimated',
                                event.progress,
                                event.message
                            );
                        });
                        updateInstallStage(
                            'gsm_package',
                            'completed',
                            'estimated',
                            1,
                            'Backend package updated.'
                        );
                    }

                    const updatedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
                    log.info(
                        `Backend version after update attempt: ${
                            updatedVersion ?? 'unknown (pip show did not return a version)'
                        }`
                    );
                    this.backendStatusCache = {
                        currentVersion: updatedVersion,
                        latestVersion: preRelease ? normalizedPreReleaseBranch : latestVersion,
                        updateAvailable: false,
                        checkedAt: new Date().toISOString(),
                        error: null,
                        checking: true,
                        source: preRelease ? 'prerelease-branch' : 'pypi',
                        branch: preRelease ? normalizedPreReleaseBranch : null,
                    };

                    emitUpdateProgress(5, totalSteps, 'Finalizing backend update');
                    new Notification({
                        title: 'Update Successful',
                        body: `${APP_NAME} backend has been updated successfully.`,
                        timeoutType: 'default',
                    }).show();

                    if (shouldRestart) {
                        emitUpdateProgress(6, totalSteps, 'Restarting backend process');
                        devFaultInjector.maybeFail('update.restart_backend');
                        updateInstallStage(
                            'backend_boot',
                            'running',
                            'estimated',
                            0.15,
                            'Restarting the GSM backend process...'
                        );
                        void this.deps
                            .ensureAndRunGSM(pythonPath)
                            .then(() => {
                                log.info('GSM backend process exited after update-triggered restart.');
                            })
                            .catch((restartError) => {
                                log.error(
                                    `Failed to restart GSM backend after update: ${toErrorMessage(
                                        restartError
                                    )}`
                                );
                            });
                        log.info('GSM backend restart initiated after update.');
                        emitUpdateProgress(7, totalSteps, 'Update complete');
                    } else {
                        updateInstallStage('backend_boot', 'skipped', 'indeterminate', 1, 'Backend restart was not requested.');
                        updateInstallStage('obs', 'skipped', 'indeterminate', 1, 'OBS dependency checks were skipped.');
                        updateInstallStage('ffmpeg', 'skipped', 'indeterminate', 1, 'FFmpeg dependency checks were skipped.');
                        updateInstallStage('oneocr', 'skipped', 'indeterminate', 1, 'OneOCR dependency checks were skipped.');
                        updateInstallStage('finalize', 'completed', 'estimated', 1, 'Backend update complete.');
                        installSessionManager.finishActive('completed', 'Backend update complete.');
                        emitUpdateProgress(6, totalSteps, 'Update complete');
                    }
                } else {
                    log.info('Python backend is already up-to-date.');
                    this.backendStatusCache = {
                        currentVersion: installedVersion,
                        latestVersion: preRelease ? normalizedPreReleaseBranch : latestVersion,
                        updateAvailable: false,
                        checkedAt: new Date().toISOString(),
                        error: null,
                        checking: true,
                        source: preRelease ? 'prerelease-branch' : 'pypi',
                        branch: preRelease ? normalizedPreReleaseBranch : null,
                    };
                    updateInstallStage('verify_runtime', 'skipped', 'indeterminate', 1, 'No backend update was required.');
                    updateInstallStage('lock_sync', 'skipped', 'indeterminate', 1, 'Dependencies are already up to date.');
                    updateInstallStage('gsm_package', 'skipped', 'indeterminate', 1, 'Backend package is already up to date.');
                    updateInstallStage('backend_boot', 'skipped', 'indeterminate', 1, 'Backend restart was not required.');
                    updateInstallStage('obs', 'skipped', 'indeterminate', 1, 'OBS dependency checks were skipped.');
                    updateInstallStage('ffmpeg', 'skipped', 'indeterminate', 1, 'FFmpeg dependency checks were skipped.');
                    updateInstallStage('oneocr', 'skipped', 'indeterminate', 1, 'OneOCR dependency checks were skipped.');
                    updateInstallStage('finalize', 'completed', 'estimated', 1, 'Backend update complete.');
                    installSessionManager.finishActive('completed', 'Backend update complete.');
                    emitUpdateProgress(1, 1, 'Python backend is already up to date');
                }

                this.lastBackendUpdateSucceeded = true;
                this.lastBackendUpdateError = null;
                return;
            }

        } catch (error) {
            if (
                autoRepairAttemptsRemaining > 0 &&
                shouldAutoRebuildManagedPythonEnv(error)
            ) {
                const originalErrorMessage = toErrorMessage(error);
                log.warn(
                    `Backend update hit a broken managed Python environment. Rebuilding python_venv and retrying once. Reason: ${originalErrorMessage}`
                );

                try {
                    emitUpdateProgress(1, 1, 'Repairing managed Python environment');
                    await this.deps.closeAllPythonProcesses();
                    await this.deps.reinstallPython();
                    log.info('Managed Python environment rebuilt successfully. Retrying backend update.');
                    return await this.updateGSMInternal(
                        shouldRestart,
                        force,
                        preReleaseBranch,
                        autoRepairAttemptsRemaining - 1
                    );
                } catch (repairError) {
                    const repairMessage = toErrorMessage(repairError);
                    error = new Error(
                        `Automatic python_venv rebuild failed after update error "${originalErrorMessage}": ${repairMessage}`
                    );
                    log.error(String(error), repairError);
                }
            }

            this.lastBackendUpdateSucceeded = false;
            this.lastBackendUpdateError = toErrorMessage(error);
            updateInstallStage('finalize', 'failed', 'estimated', null, 'Backend update failed.', this.lastBackendUpdateError);
            installSessionManager.finishActive('failed', 'Backend update failed.', this.lastBackendUpdateError);
            this.backendStatusCache = {
                ...this.backendStatusCache,
                checkedAt: new Date().toISOString(),
                error: this.lastBackendUpdateError,
                updateAvailable: false,
            };
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
            this.backendStatusCache = {
                ...this.backendStatusCache,
                checking: false,
            };
            log.info('Finished Python update internal process.');
        }
    }

    private createAppStatus(
        latestVersion: string | null,
        updateAvailable: boolean,
        error: string | null = null
    ): AppUpdateStatus {
        return {
            currentVersion: app.getVersion(),
            latestVersion,
            updateAvailable,
            checkedAt: new Date().toISOString(),
            error,
            checking: this.isCheckingAppUpdate,
            channel: getPullPreReleases() ? 'beta' : 'latest',
        };
    }

    private configureAutoUpdater(forceDev: boolean = false): AppUpdater {
        const autoUpdater = getAutoUpdater(forceDev);

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
            await this.deps.closeAllPythonProcesses();
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

        return autoUpdater;
    }

    private async checkAppUpdateStatus(forceUpdate: boolean = false): Promise<AppUpdateStatus> {
        this.isCheckingAppUpdate = true;
        this.appStatusCache = {
            ...this.appStatusCache,
            currentVersion: app.getVersion(),
            checking: true,
            error: null,
            channel: getPullPreReleases() ? 'beta' : 'latest',
        };

        try {
            log.info('Checking for application updates...');
            const autoUpdater = this.configureAutoUpdater(forceUpdate);
            const result = await autoUpdater.checkForUpdates();
            if (!result) {
                log.warn('Update check returned no result.');
                this.appStatusCache = this.createAppStatus(null, false, 'Update check returned no result.');
                return this.appStatusCache;
            }

            const latestVersion = result.updateInfo.version;
            const currentVersion = app.getVersion();
            const prereleaseEnabled = getPullPreReleases();

            Logger.info(`Current app version: ${currentVersion}, latest version: ${latestVersion}`);
            const isNewer = semver.valid(latestVersion) && semver.valid(currentVersion)
                ? semver.gt(latestVersion, currentVersion)
                : latestVersion !== currentVersion;
            const currentIsPrerelease = Boolean(
                semver.valid(currentVersion) && semver.prerelease(currentVersion)
            );
            const shouldOfferDowngradeToStable =
                !prereleaseEnabled && currentIsPrerelease && latestVersion !== currentVersion;
            const shouldOfferUpdate = forceUpdate || isNewer || shouldOfferDowngradeToStable;

            Logger.info(
                `Is update available: ${shouldOfferUpdate} (isNewer=${isNewer}, downgradeToStable=${shouldOfferDowngradeToStable}, force=${forceUpdate})`
            );
            Logger.info(
                `Application update check completed. current=${currentVersion}, latest=${latestVersion}, force=${forceUpdate}`
            );

            this.appStatusCache = this.createAppStatus(latestVersion, shouldOfferUpdate);
            return this.appStatusCache;
        } catch (err: any) {
            const errorMessage = String(err?.message ?? err);
            log.error(`Failed to check for application updates: ${errorMessage}`);
            this.appStatusCache = this.createAppStatus(null, false, errorMessage);
            return this.appStatusCache;
        } finally {
            this.isCheckingAppUpdate = false;
            this.appStatusCache = {
                ...this.appStatusCache,
                checking: false,
                channel: getPullPreReleases() ? 'beta' : 'latest',
            };
        }
    }

    private async checkBackendUpdateStatus(
        preReleaseBranch: string | null = null
    ): Promise<BackendUpdateStatus> {
        const pythonPath = this.deps.getPythonPath();
        const normalizedPreReleaseBranch =
            typeof preReleaseBranch === 'string' ? preReleaseBranch.trim() : '';
        const preRelease = normalizedPreReleaseBranch.length > 0;

        if (!pythonPath) {
            this.backendStatusCache = {
                currentVersion: null,
                latestVersion: preRelease ? normalizedPreReleaseBranch : null,
                updateAvailable: false,
                checkedAt: new Date().toISOString(),
                error: 'pythonPath is not initialized',
                checking: false,
                source: preRelease ? 'prerelease-branch' : 'pypi',
                branch: preRelease ? normalizedPreReleaseBranch : null,
            };
            return this.backendStatusCache;
        }

        try {
            const currentVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
            if (preRelease) {
                this.backendStatusCache = {
                    currentVersion,
                    latestVersion: normalizedPreReleaseBranch,
                    updateAvailable: false,
                    checkedAt: new Date().toISOString(),
                    error: null,
                    checking: false,
                    source: 'prerelease-branch',
                    branch: normalizedPreReleaseBranch,
                };
                return this.backendStatusCache;
            }

            const versionCheck = await checkForUpdates();
            this.backendStatusCache = {
                currentVersion,
                latestVersion: versionCheck.latestVersion,
                updateAvailable: versionCheck.updateAvailable,
                checkedAt: new Date().toISOString(),
                error: versionCheck.latestVersion ? null : 'Could not determine latest backend version.',
                checking: false,
                source: 'pypi',
                branch: null,
            };
            return this.backendStatusCache;
        } catch (error) {
            this.backendStatusCache = {
                currentVersion: await getInstalledPackageVersion(pythonPath, PACKAGE_NAME),
                latestVersion: preRelease ? normalizedPreReleaseBranch : null,
                updateAvailable: false,
                checkedAt: new Date().toISOString(),
                error: toErrorMessage(error),
                checking: false,
                source: preRelease ? 'prerelease-branch' : 'pypi',
                branch: preRelease ? normalizedPreReleaseBranch : null,
            };
            return this.backendStatusCache;
        }
    }

    private async downloadAppUpdate(
        forceDev: boolean = false,
        knownStatus?: AppUpdateStatus
    ): Promise<boolean> {
        const status = knownStatus ?? (await this.checkAppUpdateStatus(forceDev));
        if (!status.updateAvailable) {
            return false;
        }

        const autoUpdater = this.configureAutoUpdater(forceDev);
        await autoUpdater.downloadUpdate();
        this.appStatusCache = {
            ...status,
            checking: false,
        };
        return true;
    }
}
