import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    getPullPreReleases: vi.fn(() => false),
    showMessageBox: vi.fn(),
    getInstalledPackageVersion: vi.fn(),
}));

vi.mock('electron', () => ({
    app: { getVersion: () => '2026.9.4' },
    dialog: { showMessageBox: mocks.showMessageBox, showErrorBox: vi.fn() },
    Notification: vi.fn(),
}));
vi.mock('electron-updater', () => ({
    default: {
        autoUpdater: Object.assign(new EventEmitter(), {
            checkForUpdates: mocks.checkForUpdates,
            downloadUpdate: mocks.downloadUpdate,
            quitAndInstall: mocks.quitAndInstall,
            setFeedURL: vi.fn(),
        }),
    },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('electron-log/main.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../util.js', () => ({ APP_NAME: 'GSM', BASE_DIR: 'unused', PACKAGE_NAME: 'GameSentenceMiner' }));
vi.mock('../store.js', () => ({
    getPullPreReleases: mocks.getPullPreReleases,
    getPythonExtras: vi.fn(),
    setPythonExtras: vi.fn(),
}));
vi.mock('../update_checker.js', () => ({ checkForUpdates: vi.fn() }));
vi.mock('./python_ops.js', () => ({
    getInstalledPackageVersion: mocks.getInstalledPackageVersion,
    checkAndInstallUV: vi.fn(),
    cleanUvCache: vi.fn(),
    getBundledBackendSpecifier: vi.fn(),
    installPackageNoDeps: vi.fn(),
    resolveRequestedExtras: vi.fn(),
    syncLockedEnvironment: vi.fn(),
}));
vi.mock('./install_session_state.js', () => ({ installSessionManager: {} }));
vi.mock('./managed_python_repair.js', () => ({ shouldAutoRebuildManagedPythonEnv: vi.fn() }));

import { UpdateManager } from './update_manager.js';
import electronUpdater from 'electron-updater';
import log from 'electron-log/main.js';

describe('desktop update offers', () => {
    let manager: UpdateManager;
    const onStatus = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getPullPreReleases.mockReturnValue(false);
        mocks.checkForUpdates.mockResolvedValue({ updateInfo: { version: '2026.10.0' } });
        mocks.downloadUpdate.mockResolvedValue([]);
        manager = new UpdateManager({
            getPythonPath: () => '',
            closeAllPythonProcesses: vi.fn(),
            closeAllForAppUpdate: vi.fn(),
            ensureAndRunGSM: vi.fn(),
            reinstallPython: vi.fn(),
        });
        manager.setAppUpdateStatusListener(onStatus);
    });

    it('publishes a startup offer without a native prompt or download', async () => {
        await manager.checkAppUpdateStatus();
        expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
            latestVersion: '2026.10.0', updateAvailable: true, checking: false,
        }));
        expect(mocks.showMessageBox).not.toHaveBeenCalled();
        expect(mocks.downloadUpdate).not.toHaveBeenCalled();
        expect(manager.getAppUpdateStatus().updateAvailable).toBe(true);
        expect(mocks.getInstalledPackageVersion).not.toHaveBeenCalled();
    });

    it('uses the persistent logger and logs download progress without accumulating listeners', async () => {
        await manager.checkAppUpdateStatus();
        await manager.installAppUpdate('2026.10.0');
        const updater = electronUpdater.autoUpdater;
        expect(updater.logger).toBe(log);
        vi.mocked(log.info).mockClear();
        for (let percent = 0; percent <= 100; percent++) {
            updater.emit('download-progress', { percent, transferred: percent * 1000, total: 100000, bytesPerSecond: 5000 });
        }
        expect(updater.listenerCount('download-progress')).toBe(1);
        expect(log.info).toHaveBeenCalledTimes(11);
        expect(vi.mocked(log.info).mock.calls.flat().join('\n')).toContain('100%');
    });

    it('keeps updater failure stacks in diagnostics', async () => {
        const error = new Error('Installer failed');
        mocks.downloadUpdate.mockRejectedValueOnce(error);
        await expect(manager.installAppUpdate('2026.10.0')).rejects.toThrow('Installer failed');
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Application update failed'), error);
    });

    it('refuses to install a version the user has not reviewed', async () => {
        await expect(manager.installAppUpdate('2026.9.5')).rejects.toThrow();
        expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    });

    it('tracks the accepted download and rejects duplicate installation work', async () => {
        await manager.installAppUpdate('2026.10.0');
        expect(manager.getAppUpdateStatus().downloading).toBe(true);
        expect(manager.anyUpdateInProgress).toBe(true);
        await manager.installAppUpdate('2026.10.0');
        expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it('publishes download errors and allows retrying', async () => {
        mocks.downloadUpdate.mockRejectedValueOnce(new Error('Offline'));
        await expect(manager.installAppUpdate('2026.10.0')).rejects.toThrow('Offline');
        expect(manager.getAppUpdateStatus()).toMatchObject({ downloading: false, error: 'Offline' });
        expect(manager.anyUpdateInProgress).toBe(false);
        await manager.installAppUpdate('2026.10.0');
        expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2);
    });

    it('hides stale offers when the release channel changes', async () => {
        await manager.checkAppUpdateStatus();
        mocks.getPullPreReleases.mockReturnValue(true);
        expect(manager.getAppUpdateStatus()).toMatchObject({ updateAvailable: false, latestVersion: null, channel: 'beta' });
    });

    it('does not relabel a check result when the channel changes during the request', async () => {
        let resolveCheck!: (value: unknown) => void;
        mocks.checkForUpdates.mockImplementationOnce(() => new Promise((resolve) => { resolveCheck = resolve; }));
        const checking = manager.checkAppUpdateStatus();
        mocks.getPullPreReleases.mockReturnValue(true);
        resolveCheck({ updateInfo: { version: '2026.10.0' } });
        await checking;
        expect(manager.getAppUpdateStatus()).toMatchObject({ updateAvailable: false, latestVersion: null, channel: 'beta' });
    });

    it('keeps a known offer retryable when the install recheck is offline', async () => {
        await manager.checkAppUpdateStatus();
        mocks.checkForUpdates.mockRejectedValueOnce(new Error('Offline'));
        await expect(manager.installAppUpdate('2026.10.0')).rejects.toThrow('Offline');
        expect(manager.getAppUpdateStatus()).toMatchObject({ updateAvailable: true, downloading: false });
        expect(mocks.downloadUpdate).not.toHaveBeenCalled();
        await manager.installAppUpdate('2026.10.0');
        expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it('unblocks the app when finalizing the installer emits an error', async () => {
        await manager.installAppUpdate('2026.10.0');
        electronUpdater.autoUpdater.emit('error', new Error('Could not launch installer'));
        expect(manager.getAppUpdateStatus()).toMatchObject({ downloading: false, error: 'Could not launch installer' });
        expect(manager.anyUpdateInProgress).toBe(false);
    });
});
