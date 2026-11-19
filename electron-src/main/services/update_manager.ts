import { app, dialog } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';

import log from 'electron-log/main.js';
import {
    APP_NAME,
    BASE_DIR,
    PACKAGE_NAME,
} from '../util.js';
import { getPullPreReleases, getPythonExtras } from '../store.js';
import { checkForUpdates } from '../update_checker.js';
import { getInstalledPackageVersion } from './python_ops.js';
import {pythonCall} from '../runtime/native_python_install.js';
import { devFaultInjector } from './dev_fault_injection.js';
import Logger from 'electron-log';
import { installSessionManager } from './install_session_state.js';
import type { AppUpdateStatus } from '../../shared/app_update.js';

export type { AppUpdateStatus } from '../../shared/app_update.js';

type EnsureAndRunFn = (pythonPath: string) => Promise<void>;
type CloseAllFn = () => Promise<void>;
type PythonPathGetter = () => string;

interface UpdateManagerDependencies {
    getPythonPath: PythonPathGetter;
    closeAllPythonProcesses: CloseAllFn;
    closeAllForAppUpdate: CloseAllFn;
    ensureAndRunGSM: EnsureAndRunFn;
}

export interface BackendUpdateStatus {
    currentVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    checkedAt: string | null;
    error: string | null;
    checking: boolean;
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

function startBackendUpdateSession(retryHandler: () => Promise<void>) {
    const session=installSessionManager.ensureSession('backend_update', retryHandler);
    updateInstallStage('prepare', 'completed', 'estimated', 1, 'Backend update session prepared.');
    updateInstallStage('python', 'skipped', 'indeterminate', 1, 'Managed Python runtime already installed.');
    updateInstallStage('venv', 'skipped', 'indeterminate', 1, 'Virtual environment already exists.');
    return {sessionId:session.id,attempt:session.attempt ?? 1};
}

function getAutoUpdater(forceDev: boolean = false): AppUpdater {
    const { autoUpdater } = electronUpdater;
    autoUpdater.logger = log;
    const wantPreRelease = getPullPreReleases();
    const configuredChannel = wantPreRelease ? 'beta' : 'latest';
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
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
    private isDownloadingAppUpdate = false;
    private appCheckPromise: Promise<AppUpdateStatus> | null = null;
    private appStatusListener: ((status: AppUpdateStatus) => void) | null = null;
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
    };
    private appStatusCache: AppUpdateStatus = {
        currentVersion: app.getVersion(),
        latestVersion: null,
        updateAvailable: false,
        checkedAt: null,
        error: null,
        checking: false,
        downloading: false,
        channel: getPullPreReleases() ? 'beta' : 'latest',
    };

    public constructor(private readonly deps: UpdateManagerDependencies) {}

    public get updateInProgress(): boolean {
        return this.isUpdating;
    }

    public get anyUpdateInProgress(): boolean {
        return this.isUpdating || this.isCheckingAppUpdate || this.isDownloadingAppUpdate;
    }

    public setAppUpdateStatusListener(listener: (status: AppUpdateStatus) => void): void {
        this.appStatusListener = listener;
    }

    public getAppUpdateStatus(): AppUpdateStatus {
        const channel = getPullPreReleases() ? 'beta' : 'latest';
        const channelChanged = channel !== this.appStatusCache.channel && !this.isDownloadingAppUpdate;
        return {
            ...this.appStatusCache,
            ...(channelChanged ? { latestVersion: null, updateAvailable: false, checkedAt: null, error: null } : {}),
            currentVersion: app.getVersion(),
            checking: this.isCheckingAppUpdate,
            downloading: this.isDownloadingAppUpdate,
            channel: this.isDownloadingAppUpdate ? this.appStatusCache.channel : channel,
        };
    }

    private emitAppUpdateStatus(): void {
        this.appStatusListener?.(this.getAppUpdateStatus());
    }

    public async installAppUpdate(expectedVersion: string): Promise<AppUpdateStatus> {
        if (this.isDownloadingAppUpdate) {
            return this.getAppUpdateStatus();
        }
        const status = await this.checkAppUpdateStatus();
        if (status.error) {
            throw new Error(status.error);
        }
        if (!status.updateAvailable || status.latestVersion !== expectedVersion) {
            throw new Error('The available update has changed. Reopen the release notes and try again.');
        }
        await this.downloadAppUpdate(false, status);
        return this.getAppUpdateStatus();
    }

    public get lastBackendUpdateWasSuccessful(): boolean {
        return this.lastBackendUpdateSucceeded;
    }

    public get lastBackendUpdateFailureReason(): string | null {
        return this.lastBackendUpdateError;
    }

    public get checkedBackendVersion(): string | null | undefined {
        return this.backendStatusCache.checkedAt
            ? this.backendStatusCache.currentVersion
            : undefined;
    }

    public async waitForNoActiveUpdates(pollIntervalMs: number = 200): Promise<void> {
        while (this.anyUpdateInProgress) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
    }

    public async getUpdateStatus(): Promise<UpdateStatusSnapshot> {
        const pythonPath = this.deps.getPythonPath();
        const backendCurrentVersion = pythonPath
            ? await getInstalledPackageVersion(pythonPath, PACKAGE_NAME)
            : null;

        return {
            backend: {
                ...this.backendStatusCache,
                currentVersion: backendCurrentVersion,
                checking: this.isUpdating,
            },
            app: this.getAppUpdateStatus(),
            anyUpdateInProgress: this.anyUpdateInProgress,
        };
    }

    public async checkForAvailableUpdates(
        forceDev: boolean = false
    ): Promise<UpdateStatusSnapshot> {
        await this.checkBackendUpdateStatus();
        await this.checkAppUpdateStatus(forceDev);
        return await this.getUpdateStatus();
    }

    public async updateAvailableTargets(
        shouldRestart: boolean = true,
        forceDev: boolean = false
    ): Promise<UpdateStatusSnapshot> {
        const status = await this.checkForAvailableUpdates(forceDev);

        if (status.app.updateAvailable) {
            await this.downloadAppUpdate(forceDev, status.app);
        } else if (status.backend.updateAvailable) {
            await this.updateGSM(shouldRestart);
        }

        return await this.getUpdateStatus();
    }

    public async autoUpdate(forceUpdate: boolean = false): Promise<void> {
        const status = await this.checkAppUpdateStatus(forceUpdate);
        if (status.error || status.downloading) {
            return;
        }
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
        _shouldRestart: boolean = false,
        _force: boolean = false,
        forceDev: boolean = false
    ): Promise<void> {
        // Only check for an Electron app update here. Compatible Python post
        // releases are applied automatically by the startup flow in main.ts.
        log.info('Starting application update check...');
        await this.autoUpdate(forceDev);
        log.info('Application update check is complete.');
    }

    public async updateGSM(
        shouldRestart: boolean = false,
        force: boolean = false
    ): Promise<void> {
        if (this.isUpdating) {
            log.warn('Backend update already in progress. Waiting for current update run to finish.');
            await this.gsmUpdatePromise;
            return;
        }
        this.gsmUpdatePromise = this.updateGSMInternal(shouldRestart, force);
        await this.gsmUpdatePromise;
    }

    private async updateGSMInternal(shouldRestart=false, force=false): Promise<void> {
        const lease=startBackendUpdateSession(() => this.updateGSM(shouldRestart, force));
        this.isUpdating = true;
        this.lastBackendUpdateSucceeded = false;
        this.lastBackendUpdateError = null;
        this.backendStatusCache = {...this.backendStatusCache,checking:true,error:null};
        try {
            const pythonPath=this.deps.getPythonPath();
            if(!pythonPath)throw new Error('pythonPath is not initialized');
            devFaultInjector.maybeFail('update.check_for_updates');
            const check=await pythonCall<{currentVersion:string|null;latestVersion:string;updateAvailable:boolean}>('updateCheck',{pythonPath,force});
            this.backendStatusCache={...this.backendStatusCache,...check,checkedAt:new Date().toISOString()};
            if(check.updateAvailable){
                devFaultInjector.maybeFail('update.close_running_processes');
                await this.deps.closeAllPythonProcesses();
                const result=await pythonCall<{pythonPath:string;installedVersion:string|null;latestVersion:string}>('maintain',{mode:'update',pythonPath,force,extras:getPythonExtras()});
                this.backendStatusCache={...this.backendStatusCache,currentVersion:result.installedVersion,latestVersion:result.latestVersion,updateAvailable:false};
                if(shouldRestart){
                    devFaultInjector.maybeFail('update.restart_backend');
                    // This adapter still coordinates the application's launch.
                    // Native session events report when initialization completes.
                    void this.deps.ensureAndRunGSM(result.pythonPath).catch(error=>{
                        log.error('Backend launch after update failed',error);
                        installSessionManager.finishAttempt(lease,'failed','Backend restart failed.',toErrorMessage(error));
                    });
                }else installSessionManager.finishActive('completed','Backend update complete.');
            }else installSessionManager.finishActive('completed','Python backend is already up to date.');
            this.lastBackendUpdateSucceeded=true;
        }catch(error){
            this.lastBackendUpdateError=toErrorMessage(error);
            this.backendStatusCache={...this.backendStatusCache,error:this.lastBackendUpdateError,updateAvailable:false,checkedAt:new Date().toISOString()};
            installSessionManager.finishActive('failed','Backend update failed.',this.lastBackendUpdateError);
            log.error('Python backend update failed',error);
        }finally{
            this.isUpdating=false;
            this.backendStatusCache={...this.backendStatusCache,checking:false};
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
            downloading: this.isDownloadingAppUpdate,
            channel: getPullPreReleases() ? 'beta' : 'latest',
        };
    }

    private configureAutoUpdater(forceDev: boolean = false): AppUpdater {
        const autoUpdater = getAutoUpdater(forceDev);

        autoUpdater.removeAllListeners('update-downloaded');
        autoUpdater.removeAllListeners('error');
        autoUpdater.removeAllListeners('download-progress');

        let lastProgressBucket = -1;
        autoUpdater.on('download-progress', (progress) => {
            const bucket = Math.floor(progress.percent / 10);
            if (bucket <= lastProgressBucket) return;
            lastProgressBucket = bucket;
            log.info(`[Updater] Download ${Math.floor(progress.percent)}%: ${progress.transferred}/${progress.total} bytes (${progress.bytesPerSecond} bytes/sec)`);
        });

        autoUpdater.on('update-downloaded', async (info) => {
            log.info('[Updater] Download ready:', { version: info?.version, downloadedFile: info?.downloadedFile });
            log.info(
                'Application update downloaded. Waiting for Python update process to finish (if any)...'
            );

            try {
                devFaultInjector.maybeFail(
                    'autoupdate.await_backend_update',
                    'before waiting for backend update promise'
                );
                await this.gsmUpdatePromise;

                log.info('Python process is stable. Proceeding with application restart.');
                await this.deps.closeAllForAppUpdate();
                const updateFilePath = path.join(BASE_DIR, 'update_python.flag');
                devFaultInjector.maybeFail(
                    'autoupdate.write_update_flag',
                    'before writing backend update marker'
                );
                fs.writeFileSync(updateFilePath, '');
                log.info(`Wrote backend update marker: ${updateFilePath}`);
                // Run the same NSIS installer silently for updates and relaunch GSM afterward.
                log.info('[Updater] Handing off to the application installer (silent=true, relaunch=true).');
                autoUpdater.quitAndInstall(true, true);
            } catch (err) {
                this.failAppUpdate(err);
                dialog.showErrorBox(
                    'Update Error',
                    'Downloaded app update could not be finalized. Restart and try again.'
                );
            }
        });

        autoUpdater.on('error', (err: any) => {
            if (this.isDownloadingAppUpdate) {
                this.failAppUpdate(err);
                return;
            }
            log.error(`Auto-update error: ${String(err?.message ?? err)}`, err);
        });

        return autoUpdater;
    }

    public async checkAppUpdateStatus(forceUpdate: boolean = false): Promise<AppUpdateStatus> {
        if (this.isDownloadingAppUpdate) {
            return this.getAppUpdateStatus();
        }
        if (!this.appCheckPromise) {
            this.appCheckPromise = this.checkAppUpdateStatusInternal(forceUpdate).finally(() => {
                this.appCheckPromise = null;
            });
        }
        await this.appCheckPromise;
        return this.getAppUpdateStatus();
    }

    private async checkAppUpdateStatusInternal(forceUpdate: boolean): Promise<AppUpdateStatus> {
        const checkedChannel = getPullPreReleases() ? 'beta' : 'latest';
        this.isCheckingAppUpdate = true;
        this.appStatusCache = {
            ...this.getAppUpdateStatus(),
            currentVersion: app.getVersion(),
            checking: true,
            error: null,
            channel: getPullPreReleases() ? 'beta' : 'latest',
        };
        this.emitAppUpdateStatus();

        try {
            log.info('Checking for application updates...');
            const autoUpdater = this.configureAutoUpdater(forceUpdate);
            const result = await autoUpdater.checkForUpdates();
            if (!result) {
                throw new Error('Update check returned no result.');
            }
            if (checkedChannel !== (getPullPreReleases() ? 'beta' : 'latest')) {
                this.appStatusCache = this.createAppStatus(null, false);
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
            log.error(`Failed to check for application updates: ${errorMessage}`, err);
            this.appStatusCache = {
                ...this.getAppUpdateStatus(),
                checkedAt: new Date().toISOString(),
                error: errorMessage,
            };
            return this.appStatusCache;
        } finally {
            this.isCheckingAppUpdate = false;
            this.appStatusCache = {
                ...this.appStatusCache,
                checking: false,
                channel: getPullPreReleases() ? 'beta' : 'latest',
            };
            this.emitAppUpdateStatus();
        }
    }

    private async checkBackendUpdateStatus(): Promise<BackendUpdateStatus> {
        const pythonPath = this.deps.getPythonPath();

        if (!pythonPath) {
            this.backendStatusCache = {
                currentVersion: null,
                latestVersion: null,
                updateAvailable: false,
                checkedAt: new Date().toISOString(),
                error: 'pythonPath is not initialized',
                checking: false,
            };
            return this.backendStatusCache;
        }

        try {
            const currentVersion = await getInstalledPackageVersion(pythonPath, PACKAGE_NAME);
            const versionCheck = await checkForUpdates(false, currentVersion);
            this.backendStatusCache = {
                currentVersion,
                latestVersion: versionCheck.latestVersion,
                updateAvailable: versionCheck.updateAvailable,
                checkedAt: new Date().toISOString(),
                error: versionCheck.latestVersion ? null : 'Could not determine bundled backend version.',
                checking: false,
            };
            return this.backendStatusCache;
        } catch (error) {
            this.backendStatusCache = {
                currentVersion: await getInstalledPackageVersion(pythonPath, PACKAGE_NAME),
                latestVersion: null,
                updateAvailable: false,
                checkedAt: new Date().toISOString(),
                error: toErrorMessage(error),
                checking: false,
            };
            return this.backendStatusCache;
        }
    }

    private async downloadAppUpdate(
        forceDev: boolean = false,
        knownStatus?: AppUpdateStatus
    ): Promise<boolean> {
        const status = knownStatus ?? (await this.checkAppUpdateStatus(forceDev));
        if (!status.updateAvailable || status.error || this.isDownloadingAppUpdate) {
            return false;
        }

        this.isDownloadingAppUpdate = true;
        this.appStatusCache = { ...status, checking: false, error: null };
        this.emitAppUpdateStatus();
        try {
            const autoUpdater = this.configureAutoUpdater(forceDev);
            log.info(`[Updater] Starting download: current=${status.currentVersion}, target=${status.latestVersion}, channel=${status.channel}`);
            await autoUpdater.downloadUpdate();
            // Keep the install guard active until quitAndInstall, including cleanup.
            return true;
        } catch (error) {
            this.failAppUpdate(error);
            throw error;
        }
    }

    private failAppUpdate(error: unknown): void {
        this.isDownloadingAppUpdate = false;
        this.appStatusCache = { ...this.appStatusCache, error: toErrorMessage(error) };
        log.error(`Application update failed: ${toErrorMessage(error)}`, error);
        this.emitAppUpdateStatus();
    }
}
