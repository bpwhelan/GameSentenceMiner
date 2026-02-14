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
    getLockFile,
    getLockProjectVersion,
    getInstalledPackageVersion,
    resolveRequestedExtras,
    stagedSyncAndInstallWithRollback,
} from './python_ops.js';

type EnsureAndRunFn = (pythonPath: string) => Promise<void>;
type CloseAllFn = () => Promise<void>;
type PythonPathGetter = () => string;

interface UpdateManagerDependencies {
    getPythonPath: PythonPathGetter;
    closeAllPythonProcesses: CloseAllFn;
    ensureAndRunGSM: EnsureAndRunFn;
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
    private gsmUpdatePromise: Promise<void> = Promise.resolve();

    public constructor(private readonly deps: UpdateManagerDependencies) {}

    public get updateInProgress(): boolean {
        return this.isUpdating;
    }

    public async autoUpdate(forceUpdate: boolean = false): Promise<void> {
        const autoUpdater = getAutoUpdater(forceUpdate);

        // Avoid duplicate listeners if checks are re-triggered.
        autoUpdater.removeAllListeners('update-downloaded');
        autoUpdater.removeAllListeners('error');

        autoUpdater.on('update-downloaded', async () => {
            log.info(
                'Application update downloaded. Waiting for Python update process to finish (if any)...'
            );

            await this.gsmUpdatePromise;

            log.info('Python process is stable. Proceeding with application restart.');

            const updateFilePath = path.join(BASE_DIR, 'update_python.flag');
            fs.writeFileSync(updateFilePath, '');
            autoUpdater.quitAndInstall();
        });

        autoUpdater.on('error', (err: any) => {
            log.error(`Auto-update error: ${String(err?.message ?? err)}`);
        });

        try {
            log.info('Checking for application updates...');
            const result = await autoUpdater.checkForUpdates();

            if ((result !== null && result.updateInfo.version !== app.getVersion()) || (result !== null && forceUpdate)) {
                log.info(`New application version available: ${result.updateInfo.version}`);
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
        }
    }

    public async runUpdateChecks(
        shouldRestart: boolean = false,
        force: boolean = false,
        forceDev: boolean = false
    ): Promise<void> {
        log.info('Starting full update process...');
        await this.updateGSM(shouldRestart, force);
        log.info('Python backend update check is complete.');
        await this.autoUpdate(forceDev);
        log.info('Application update check is complete.');
    }

    public async updateGSM(
        shouldRestart: boolean = false,
        force: boolean = false,
        preRelease: boolean = false
    ): Promise<void> {
        this.gsmUpdatePromise = this.updateGSMInternal(shouldRestart, force, preRelease);
        await this.gsmUpdatePromise;
    }

    private async updateGSMInternal(
        shouldRestart: boolean = false,
        force: boolean = false,
        preRelease: boolean = false
    ): Promise<void> {
        this.isUpdating = true;
        log.info('Starting Python update internal process...');

        const pythonPath = this.deps.getPythonPath();
        if (!pythonPath) {
            log.warn('Skipping Python update because pythonPath is not initialized yet.');
            this.isUpdating = false;
            return;
        }

        let packageName = PACKAGE_NAME;
        if (preRelease) {
            packageName = 'git+https://github.com/bpwhelan/GameSentenceMiner@develop';
        } else if (isDev) {
            packageName = '.';
        }

        try {
            const { updateAvailable, latestVersion } = await checkForUpdates();
            const installedVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
            const targetVersion = latestVersion ?? installedVersion;
            const lockInfo = await getLockFile(targetVersion, preRelease);
            const lockProjectVersion = getLockProjectVersion(lockInfo);
            const { selectedExtras, ignoredExtras, allowedExtras } = resolveRequestedExtras(
                lockInfo,
                getPythonExtras()
            );
            if (ignoredExtras.length > 0) {
                setPythonExtras(selectedExtras);
                log.warn(
                    `Dropped unsupported extras for strict sync (${ignoredExtras.join(', ')}). Allowed extras: ${
                        allowedExtras && allowedExtras.length > 0 ? allowedExtras.join(', ') : 'none'
                    }.`
                );
            }

            if (updateAvailable || force) {
                await this.deps.closeAllPythonProcesses();
                await new Promise((resolve) => setTimeout(resolve, 3000));

                log.info(`Updating GSM Python Application to ${targetVersion ?? latestVersion}...`);
                await checkAndInstallUV(pythonPath);

                if (!preRelease && !targetVersion) {
                    throw new Error('Unable to determine target package version for strict update.');
                }

                if (
                    !preRelease &&
                    updateAvailable &&
                    targetVersion &&
                    lockInfo.source !== 'release' &&
                    (lockInfo.matchesRequestedVersion === false ||
                        !lockProjectVersion ||
                        lockProjectVersion !== targetVersion)
                ) {
                    log.warn(
                        `Skipping backend update to ${targetVersion}: release-locked artifacts are missing. Available lock source is "${lockInfo.source}" (${lockProjectVersion ?? 'unknown'}).`
                    );
                    return;
                }

                if (!lockInfo.hasLockfile) {
                    throw new Error(
                        'Strict update failed: uv.lock + pyproject artifacts were not available.'
                    );
                }

                const strictVersion = lockProjectVersion ?? targetVersion;
                const packageSpecifier = !preRelease && strictVersion
                    ? `${PACKAGE_NAME}==${strictVersion}`
                    : packageName;

                log.info(
                    `Performing staged strict sync from ${lockInfo.source} lockfile (${lockInfo.lockfilePath}) with extras: ${
                        selectedExtras.length > 0 ? selectedExtras.join(', ') : 'none'
                    }`
                );

                try {
                    await stagedSyncAndInstallWithRollback({
                        pythonPath,
                        projectPath: lockInfo.projectPath,
                        packageSpecifier,
                        extras: selectedExtras,
                    });
                } catch (err) {
                    log.error('Staged update failed, cleaning uv cache and retrying once.', err);
                    await cleanUvCache(pythonPath);
                    await stagedSyncAndInstallWithRollback({
                        pythonPath,
                        projectPath: lockInfo.projectPath,
                        packageSpecifier,
                        extras: selectedExtras,
                    });
                }

                new Notification({
                    title: 'Update Successful',
                    body: `${APP_NAME} backend has been updated successfully.`,
                    timeoutType: 'default',
                }).show();

                if (shouldRestart) {
                    await this.deps.ensureAndRunGSM(pythonPath);
                    log.info('GSM successfully restarted after update.');
                }
            } else {
                log.info('Python backend is already up-to-date.');
            }
        } catch (error) {
            log.error('An error occurred during the Python update process:', error);
        } finally {
            this.isUpdating = false;
            log.info('Finished Python update internal process.');
        }
    }
}
