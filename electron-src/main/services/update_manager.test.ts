import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    getPullPreReleases: vi.fn(() => false),
    showMessageBox: vi.fn(),
    getInstalledPackageVersion: vi.fn(),
    pythonCall: vi.fn(),
    sessionFinish: vi.fn(),
    finishAttempt: vi.fn(),
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
vi.mock('./install_session_state.js', () => ({ installSessionManager: {ensureSession:vi.fn(()=>({id:'update-session',attempt:2})),updateStage:vi.fn(),finishActive:mocks.sessionFinish,finishAttempt:mocks.finishAttempt} }));
vi.mock('../runtime/native_python_install.js',()=>({pythonCall:mocks.pythonCall}));

import { UpdateManager } from './update_manager.js';
import electronUpdater from 'electron-updater';
import log from 'electron-log/main.js';

describe('native backend maintenance adapter',()=>{
    beforeEach(()=>{vi.clearAllMocks();mocks.pythonCall.mockReset();});
    function setup(){
        const stop=vi.fn(async()=>{}), launch=vi.fn(()=>new Promise<void>(()=>{}));
        const manager=new UpdateManager({getPythonPath:()=> 'python',closeAllPythonProcesses:stop,closeAllForAppUpdate:vi.fn(),ensureAndRunGSM:launch});
        return {manager,stop,launch};
    }
    it('applies a backend-only update requested from settings', async () => {
        const {manager, stop, launch} = setup();
        vi.spyOn(manager, 'checkForAvailableUpdates').mockResolvedValue({
            backend: {updateAvailable: true}, app: {updateAvailable: false},
        } as Awaited<ReturnType<UpdateManager['checkForAvailableUpdates']>>);
        mocks.pythonCall.mockResolvedValueOnce({updateAvailable: true, latestVersion: '2026.11.0.post1'})
            .mockResolvedValueOnce({pythonPath: 'python', installedVersion: '2026.11.0.post1', latestVersion: '2026.11.0.post1'});
        await manager.updateAvailableTargets(true);
        expect(stop).toHaveBeenCalledOnce();
        expect(launch).toHaveBeenCalledExactlyOnceWith('python');
    });
    it('leaves a running backend alone when native policy says it is current',async()=>{
        const {manager,stop,launch}=setup();
        mocks.pythonCall.mockResolvedValue({currentVersion:'2026.11.0',latestVersion:'2026.11.0',updateAvailable:false});
        await manager.updateGSM(true);
        expect(stop).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();
        expect(manager.lastBackendUpdateWasSuccessful).toBe(true);
        expect(mocks.sessionFinish).toHaveBeenCalledWith('completed',expect.any(String));
    });
    it('stops before one native workflow and returns while the replacement backend remains running',async()=>{
        const {manager,stop,launch}=setup();
        mocks.pythonCall.mockResolvedValueOnce({updateAvailable:true,latestVersion:'2026.11.0'}).mockImplementationOnce(async()=>{
            expect(stop).toHaveBeenCalledOnce();return {pythonPath:'repaired-python',installedVersion:'2026.11.0',latestVersion:'2026.11.0'};
        });
        await manager.updateGSM(true,true);
        expect(mocks.pythonCall.mock.calls.map(([action])=>action)).toEqual(['updateCheck','maintain']);
        expect(launch).toHaveBeenCalledExactlyOnceWith('repaired-python');
        expect(manager.lastBackendUpdateWasSuccessful).toBe(true);
    });
    it('retains native failures without starting a competing Node retry or launch',async()=>{
        const {manager,launch}=setup();
        mocks.pythonCall.mockResolvedValueOnce({updateAvailable:true}).mockRejectedValueOnce(Error('Native retries exhausted'));
        await manager.updateGSM(true);
        expect(mocks.pythonCall).toHaveBeenCalledTimes(2);expect(launch).not.toHaveBeenCalled();
        expect(manager.lastBackendUpdateWasSuccessful).toBe(false);
        expect(manager.lastBackendUpdateFailureReason).toBe('Native retries exhausted');
        expect(manager.updateInProgress).toBe(false);
    });
    it('coalesces simultaneous update requests',async()=>{
        const {manager}=setup();let resolve!:(value:unknown)=>void;
        mocks.pythonCall.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
        const first=manager.updateGSM(),second=manager.updateGSM();
        resolve({updateAvailable:false});await Promise.all([first,second]);
        expect(mocks.pythonCall).toHaveBeenCalledOnce();
    });
    it('ties a later backend launch failure to the original update attempt',async()=>{
        const {manager,launch}=setup();let fail!:(error:Error)=>void;
        launch.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
        mocks.pythonCall.mockResolvedValueOnce({updateAvailable:true}).mockResolvedValueOnce({pythonPath:'python'});
        await manager.updateGSM(true);fail(Error('Later backend failure'));
        await vi.waitFor(()=>expect(mocks.finishAttempt).toHaveBeenCalledWith({sessionId:'update-session',attempt:2},'failed','Backend restart failed.','Later backend failure'));
        expect(mocks.sessionFinish).not.toHaveBeenCalled();
    });
});

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
