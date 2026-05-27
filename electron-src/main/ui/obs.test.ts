import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_BASE_DIR = 'C:\\test-gsm';
const SCENE_COLLECTION_PATH =
    'C:\\test-gsm\\obs-studio\\config\\obs-studio\\basic\\scenes\\Collection_1.json';

const obsCallMock = vi.fn();
const obsConnectMock = vi.fn();
const obsDisconnectMock = vi.fn();
const obsOnMock = vi.fn();
const obsRemoveAllListenersMock = vi.fn();
const ipcHandleMock = vi.fn();
const showMessageBoxMock = vi.fn();
const mergeObsWindowItemsMock = vi.fn(() => []);
const buildCaptureCardOptionsMock = vi.fn(() => []);
const buildWindowsSceneCaptureInputsMock = vi.fn();
const buildWindowsVideoCaptureInputMock = vi.fn();
const existsSyncMock = vi.fn();
const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const sendStartOBSMock = vi.fn();
const sendQuitOBSMock = vi.fn();
const execFileAsyncMock = vi.fn();
const execMock = vi.fn();
const spawnMock = vi.fn();
const storeData = new Map<string, unknown>();
const storeSetMock = vi.fn<(key: string, value: unknown) => void>();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

const UNIFORM_PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAkSURBVChThcihAQAACIAw/n9asxAMKwOYR8ISlrCEJSxhiWMBgkg/wTHeyiUAAAAASUVORK5CYII=';
const NON_UNIFORM_PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAVSURBVChTY2BgYPiPjP+jYYaRoQAAI4hfoUYt8SsAAAAASUVORK5CYII=';

vi.mock('electron', () => ({
    BrowserWindow: class BrowserWindow {},
    dialog: {
        showMessageBox: showMessageBoxMock,
    },
    ipcMain: {
        handle: ipcHandleMock,
    },
}));

vi.mock('child_process', () => ({
    exec: execMock,
    spawn: spawnMock,
}));

vi.mock('electron-store', () => ({
    default: class Store {
        get(key?: string): unknown {
            return key ? storeData.get(key) : undefined;
        }

        set(key: string, value: unknown): void {
            storeSetMock(key, value);
            storeData.set(key, value);
        }
    },
}));

vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
    },
}));

vi.mock('../main.js', () => ({
    isQuitting: false,
    sendStartOBS: sendStartOBSMock,
    sendQuitOBS: sendQuitOBSMock,
}));

vi.mock('../util.js', () => ({
    BASE_DIR: TEST_BASE_DIR,
    execFileAsync: execFileAsyncMock,
    getAssetsDir: () => 'C:\\test-gsm\\assets',
    isMacOS: () => false,
    isLinux: () => false,
    isWindows: () => true,
    isWindows10OrHigher: () => true,
}));

vi.mock('./obs-capture.js', () => ({
    OBS_DSHOW_INPUT_KIND: 'dshow_input',
    OBS_WASAPI_INPUT_CAPTURE_KIND: 'wasapi_input_capture',
    OBS_XCOMPOSITE_INPUT_KIND: 'xcomposite_input',
    buildCaptureCardOptions: buildCaptureCardOptionsMock,
    buildLinuxSceneCaptureInputs: vi.fn(),
    buildWindowsSceneCaptureInputs: buildWindowsSceneCaptureInputsMock,
    buildWindowsVideoCaptureInput: buildWindowsVideoCaptureInputMock,
    getObsWindowTitle: vi.fn((title: string) => title),
    mergeObsWindowItems: mergeObsWindowItemsMock,
}));

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        existsSync: existsSyncMock,
        readFileSync: readFileSyncMock,
        writeFileSync: writeFileSyncMock,
        rmSync: rmSyncMock,
        mkdirSync: mkdirSyncMock,
        promises: {
            ...actual.promises,
            readFile: readFileMock,
            writeFile: writeFileMock,
        },
    };
});

vi.mock('obs-websocket-js', () => ({
    default: class OBSWebSocket {
        call = obsCallMock;
        connect = obsConnectMock;
        disconnect = obsDisconnectMock;
        on = obsOnMock;
        removeAllListeners = obsRemoveAllListenersMock;
    },
}));

async function loadObsModule() {
    vi.resetModules();
    return import('./obs.js');
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('launchOBSFromElectron', () => {
    const CONFIG_PATH = 'C:\\test-gsm\\config.json';
    const DEFAULT_OBS_PATH = 'C:\\test-gsm\\obs-studio\\bin\\64bit\\obs64.exe';

    beforeEach(() => {
        existsSyncMock.mockReset();
        readFileSyncMock.mockReset();
        writeFileSyncMock.mockReset();
        rmSyncMock.mockReset();
        mkdirSyncMock.mockReset();
        execMock.mockReset();
        spawnMock.mockReset();
        obsCallMock.mockReset();
        obsConnectMock.mockReset();
        obsDisconnectMock.mockReset();
        obsOnMock.mockReset();
        obsRemoveAllListenersMock.mockReset();
        storeData.clear();
        readFileSyncMock.mockReturnValue('{}');
        spawnMock.mockReturnValue({ pid: 4242, once: vi.fn(), unref: vi.fn() });
    });

    it('skips startup launch when the active Python profile disables open_obs', async () => {
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === CONFIG_PATH);
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                current_profile: 'Default',
                configs: {
                    Default: {
                        obs: {
                            open_obs: false,
                        },
                    },
                },
            })
        );
        const { launchOBSFromElectron } = await loadObsModule();

        const result = await launchOBSFromElectron({ reason: 'test' });

        expect(result.status).toBe('skipped');
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('allows manual launch when the active Python profile disables open_obs', async () => {
        existsSyncMock.mockImplementation((targetPath: string) =>
            targetPath === CONFIG_PATH || targetPath === DEFAULT_OBS_PATH
        );
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                current_profile: 'Default',
                configs: {
                    Default: {
                        obs: {
                            open_obs: false,
                        },
                    },
                },
            })
        );
        const { launchOBSFromElectron } = await loadObsModule();

        const startupResult = await launchOBSFromElectron({ reason: 'startup test' });
        const manualResult = await launchOBSFromElectron({
            ignoreOpenConfig: true,
            reason: 'manual test',
        });

        expect(startupResult.status).toBe('skipped');
        expect(manualResult).toEqual({ status: 'launched', pid: 4242 });
        expect(spawnMock).toHaveBeenCalledOnce();
    });

    it('launches the portable OBS runtime with GSM startup flags', async () => {
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === DEFAULT_OBS_PATH);
        const { launchOBSFromElectron } = await loadObsModule();

        const result = await launchOBSFromElectron({ reason: 'test' });

        expect(result).toEqual({ status: 'launched', pid: 4242 });
        expect(spawnMock).toHaveBeenCalledWith(
            DEFAULT_OBS_PATH,
            expect.arrayContaining([
                '--disable-shutdown-check',
                '--portable',
                '--disable-updater',
                '--startreplaybuffer',
            ]),
            expect.objectContaining({
                cwd: 'C:\\test-gsm\\obs-studio\\bin\\64bit',
                detached: false,
                shell: false,
                stdio: 'ignore',
            })
        );
        expect(writeFileSyncMock).toHaveBeenCalledWith(
            'C:\\test-gsm\\obs_pid.txt',
            '4242',
            'utf-8'
        );
    });

    it('rechecks the managed OBS pid before using a cached launched state', async () => {
        const obsPidPath = 'C:\\test-gsm\\obs_pid.txt';
        let pidFileExists = false;
        let storedPid = '';
        const notRunningError = new Error('not running') as NodeJS.ErrnoException;
        notRunningError.code = 'ESRCH';
        const killSpy = vi
            .spyOn(process, 'kill')
            .mockImplementation((() => {
                throw notRunningError;
            }) as typeof process.kill);

        try {
            existsSyncMock.mockImplementation((targetPath: string) =>
                targetPath === DEFAULT_OBS_PATH || (targetPath === obsPidPath && pidFileExists)
            );
            readFileSyncMock.mockImplementation((targetPath: string) =>
                targetPath === obsPidPath ? storedPid : '{}'
            );
            writeFileSyncMock.mockImplementation((targetPath: string, value: string) => {
                if (targetPath === obsPidPath) {
                    pidFileExists = true;
                    storedPid = value;
                }
            });
            rmSyncMock.mockImplementation((targetPath: string) => {
                if (targetPath === obsPidPath) {
                    pidFileExists = false;
                    storedPid = '';
                }
            });
            spawnMock
                .mockReturnValueOnce({ pid: 4242, once: vi.fn(), unref: vi.fn() })
                .mockReturnValueOnce({ pid: 5151, once: vi.fn(), unref: vi.fn() });
            const { launchOBSFromElectron } = await loadObsModule();

            await expect(launchOBSFromElectron({ reason: 'first launch' })).resolves.toEqual({
                status: 'launched',
                pid: 4242,
            });
            await expect(launchOBSFromElectron({ reason: 'manual relaunch' })).resolves.toEqual({
                status: 'launched',
                pid: 5151,
            });

            expect(spawnMock).toHaveBeenCalledTimes(2);
            expect(rmSyncMock).toHaveBeenCalledWith(obsPidPath, { force: true });
        } finally {
            killSpy.mockRestore();
        }
    });

    it('opens OBS from IPC even when startup auto-open is disabled', async () => {
        existsSyncMock.mockImplementation((targetPath: string) =>
            targetPath === CONFIG_PATH || targetPath === DEFAULT_OBS_PATH
        );
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                current_profile: 'Default',
                configs: {
                    Default: {
                        obs: {
                            open_obs: false,
                        },
                    },
                },
            })
        );
        const { registerOBSIPC } = await loadObsModule();

        await registerOBSIPC();
        const openOBSHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'openOBS'
        )?.[1];

        expect(openOBSHandler).toBeTypeOf('function');
        await expect(openOBSHandler({})).resolves.toEqual({
            status: 'launched',
            pid: 4242,
        });
        expect(spawnMock).toHaveBeenCalledOnce();
    });

    it('uses managed spawn fallback for obs.launch instead of exec', async () => {
        existsSyncMock.mockReturnValue(false);
        const { registerOBSIPC } = await loadObsModule();

        await registerOBSIPC();
        const launchHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'obs.launch'
        )?.[1];

        expect(launchHandler).toBeTypeOf('function');
        await expect(launchHandler({})).resolves.toEqual({
            status: 'launched',
            pid: 4242,
        });
        expect(spawnMock).toHaveBeenCalledWith(
            'obs',
            expect.arrayContaining(['--disable-shutdown-check', '--portable']),
            expect.objectContaining({
                detached: false,
                shell: false,
                stdio: 'ignore',
            })
        );
        expect(execMock).not.toHaveBeenCalled();
    });

    it('does not perform launch filesystem work synchronously', async () => {
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === DEFAULT_OBS_PATH);
        const { launchOBSFromElectron } = await loadObsModule();

        const launchPromise = launchOBSFromElectron({ reason: 'test' });

        expect(existsSyncMock).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();

        await launchPromise;
    });

    it('reports missing when the configured OBS executable is unavailable', async () => {
        existsSyncMock.mockReturnValue(false);
        const { launchOBSFromElectron } = await loadObsModule();

        const result = await launchOBSFromElectron({ reason: 'test' });

        expect(result.status).toBe('missing');
        expect(spawnMock).not.toHaveBeenCalled();
    });
});

describe('renameOBSScene', () => {
    beforeEach(() => {
        obsCallMock.mockReset();
        obsConnectMock.mockReset();
        obsDisconnectMock.mockReset();
        obsOnMock.mockReset();
        obsRemoveAllListenersMock.mockReset();
        ipcHandleMock.mockReset();
        showMessageBoxMock.mockReset();
        mergeObsWindowItemsMock.mockReset();
        buildCaptureCardOptionsMock.mockReset();
        buildWindowsSceneCaptureInputsMock.mockReset();
        buildWindowsVideoCaptureInputMock.mockReset();
        existsSyncMock.mockReset();
        readFileMock.mockReset();
        writeFileMock.mockReset();
        sendStartOBSMock.mockReset();
        sendQuitOBSMock.mockReset();
        execFileAsyncMock.mockReset();
        execMock.mockReset();
        spawnMock.mockReset();
        storeSetMock.mockReset();
        readFileSyncMock.mockReset();
        writeFileSyncMock.mockReset();
        rmSyncMock.mockReset();
        mkdirSyncMock.mockReset();
        storeData.clear();
        mergeObsWindowItemsMock.mockReturnValue([]);
        buildCaptureCardOptionsMock.mockReturnValue([]);
        buildWindowsSceneCaptureInputsMock.mockReturnValue([]);
        buildWindowsVideoCaptureInputMock.mockImplementation(
            (sceneName: string, captureMode: string, windowValue: string) => ({
                inputName:
                    captureMode === 'game_capture'
                        ? `${sceneName} - Game Capture`
                        : `${sceneName} - Window Capture`,
                inputKind: captureMode,
                inputSettings:
                    captureMode === 'game_capture'
                        ? {
                              window: windowValue,
                              capture_mode: 'window',
                              capture_cursor: false,
                          }
                        : {
                              window: windowValue,
                              mode: 'window',
                              cursor: false,
                              method: 2,
                          },
                sceneItemEnabled: true,
            })
        );
        existsSyncMock.mockImplementation((targetPath: string) => {
            if (targetPath === SCENE_COLLECTION_PATH) {
                return true;
            }
            return false;
        });
        readFileMock.mockImplementation(async (targetPath: string) => {
            if (targetPath === SCENE_COLLECTION_PATH) {
                return JSON.stringify({
                    modules: {
                        'auto-scene-switcher': {
                            active: true,
                            switches: [],
                        },
                    },
                });
            }
            return '[]';
        });
        writeFileMock.mockResolvedValue(undefined);
        readFileSyncMock.mockReturnValue('{}');
        showMessageBoxMock.mockResolvedValue({ response: 0, checkboxChecked: false });
        execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
        spawnMock.mockReturnValue({ pid: 4242, once: vi.fn(), unref: vi.fn() });

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            return {};
        });
        obsConnectMock.mockResolvedValue(undefined);
        obsDisconnectMock.mockResolvedValue(undefined);
    });

    it('renames the OBS scene by UUID using SetSceneName only', async () => {
        const { renameOBSScene } = await loadObsModule();

        await renameOBSScene('scene-123', 'Renamed Scene');

        expect(obsCallMock.mock.calls.map(([requestType]) => requestType)).toEqual([
            'GetVersion',
            'SetSceneName',
        ]);
        expect(obsCallMock).toHaveBeenLastCalledWith('SetSceneName', {
            sceneUuid: 'scene-123',
            newSceneName: 'Renamed Scene',
        });
    });

    it('ignores blank rename requests', async () => {
        const { renameOBSScene } = await loadObsModule();

        await renameOBSScene('scene-123', '   ');

        expect(obsCallMock).not.toHaveBeenCalled();
    });

    it('updates auto-scene-switcher settings in realtime and restarts OBS when creating a window scene', async () => {
        vi.useFakeTimers();

        try {
            const defaultObsPath = `${TEST_BASE_DIR}\\obs-studio\\bin\\64bit\\obs64.exe`;
            const obsPidPath = `${TEST_BASE_DIR}\\obs_pid.txt`;
            existsSyncMock.mockImplementation((targetPath: string) =>
                targetPath === SCENE_COLLECTION_PATH ||
                targetPath === defaultObsPath ||
                targetPath === obsPidPath
            );
            readFileSyncMock.mockImplementation((targetPath: string) =>
                targetPath === obsPidPath ? '4242' : '{}'
            );

            const { registerOBSIPC } = await loadObsModule();

            buildWindowsSceneCaptureInputsMock.mockReturnValue([
                {
                    inputName: 'My Scene - Game Capture',
                    inputKind: 'game_capture',
                    inputSettings: { window: 'Game Window:WindowClass:game.exe' },
                    sceneItemEnabled: true,
                },
            ]);

            obsCallMock.mockImplementation(async (requestType: string) => {
                if (requestType === 'GetVersion') {
                    return {};
                }
                if (requestType === 'GetInputSettings') {
                    throw new Error('No source was found');
                }
                if (requestType === 'GetSceneCollectionList') {
                    return {
                        currentSceneCollectionName: 'Collection 1',
                    };
                }
                return {};
            });

            await registerOBSIPC();

            const createSceneHandler = ipcHandleMock.mock.calls.find(
                ([channel]) => channel === 'obs.createScene'
            )?.[1];

            expect(createSceneHandler).toBeTypeOf('function');

            const createScenePromise = createSceneHandler({}, {
                title: 'Game Window',
                sceneName: 'My Scene',
            });
            await vi.advanceTimersByTimeAsync(1_250);
            await Promise.resolve();
            await vi.runOnlyPendingTimersAsync();

            await expect(createScenePromise).resolves.toBeUndefined();

            expect(writeFileMock).toHaveBeenCalledWith(
                SCENE_COLLECTION_PATH,
                expect.stringContaining('"scene": "My Scene"'),
                'utf-8'
            );
            expect(writeFileMock).toHaveBeenCalledWith(
                `${TEST_BASE_DIR}\\scene_config.json`,
                expect.stringContaining('"scene": "My Scene"'),
                'utf-8'
            );
            expect(sendQuitOBSMock).not.toHaveBeenCalled();
            expect(sendStartOBSMock).not.toHaveBeenCalled();
            expect(spawnMock).toHaveBeenCalledWith(
                defaultObsPath,
                expect.arrayContaining(['--portable', '--startreplaybuffer']),
                expect.objectContaining({ detached: false, shell: false })
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('detects the enabled capture mode for a mixed scene', async () => {
        const { getSceneCaptureMode } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSceneItemList') {
                return {
                    sceneItems: [
                        {
                            sourceName: 'My Scene - Game Capture',
                            inputKind: 'game_capture',
                            sceneItemEnabled: false,
                            sceneItemId: 10,
                        },
                        {
                            sourceName: 'My Scene - Window Capture',
                            inputKind: 'window_capture',
                            sceneItemEnabled: true,
                            sceneItemId: 11,
                        },
                    ],
                };
            }
            return {};
        });

        await expect(getSceneCaptureMode('scene-123')).resolves.toBe(
            'window_capture'
        );
    });

    it('switches a scene from window capture to game capture', async () => {
        const { switchOBSSceneCaptureMode } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string, requestData?: any) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSceneList') {
                return {
                    scenes: [
                        {
                            sceneName: 'My Scene',
                            sceneUuid: 'scene-123',
                        },
                    ],
                };
            }
            if (requestType === 'GetSceneItemList') {
                return {
                    sceneItems: [
                        {
                            sourceUuid: 'window-source',
                            sourceName: 'My Scene - Window Capture',
                            inputKind: 'window_capture',
                            sceneItemEnabled: true,
                            sceneItemId: 11,
                        },
                    ],
                };
            }
            if (
                requestType === 'GetInputSettings' &&
                requestData?.inputUuid === 'window-source'
            ) {
                return {
                    inputSettings: {
                        window: 'Game Window:GameClass:game.exe',
                    },
                };
            }
            if (
                requestType === 'GetInputSettings' &&
                requestData?.inputName === 'My Scene - Game Capture'
            ) {
                throw new Error('No source was found');
            }
            return {};
        });

        await expect(
            switchOBSSceneCaptureMode('scene-123', 'game_capture')
        ).resolves.toBe('game_capture');

        expect(obsCallMock).toHaveBeenCalledWith('CreateInput', {
            sceneName: 'My Scene',
            inputName: 'My Scene - Game Capture',
            inputKind: 'game_capture',
            inputSettings: {
                window: 'Game Window:GameClass:game.exe',
                capture_mode: 'window',
                capture_cursor: false,
            },
            sceneItemEnabled: true,
        });
        expect(obsCallMock).toHaveBeenCalledWith('RemoveSceneItem', {
            sceneName: 'My Scene',
            sceneItemId: 11,
        });
    });

    it('forces helper sources to stay disabled when enumerating OBS windows', async () => {
        const { registerOBSIPC } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string, requestData?: any) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper - DONT TOUCH'
            ) {
                const sceneItems = [
                    {
                        sceneItemId: 17,
                        sourceName: 'window_getter',
                        sceneItemEnabled: true,
                    },
                ];
                if (
                    obsCallMock.mock.calls.some(
                        ([type, data]) =>
                            type === 'CreateInput' &&
                            data?.inputName === 'game_window_getter'
                    )
                ) {
                    sceneItems.push({
                        sceneItemId: 23,
                        sourceName: 'game_window_getter',
                        sceneItemEnabled: true,
                    });
                }
                return {
                    sceneItems,
                };
            }
            if (requestType === 'GetInputPropertiesListPropertyItems') {
                if (requestData?.inputName === 'window_getter') {
                    return { propertyItems: [] };
                }
                if (requestData?.inputName === 'game_window_getter') {
                    if (
                        obsCallMock.mock.calls.filter(
                            ([type, data]) =>
                                type === 'CreateInput' &&
                                data?.inputName === 'game_window_getter'
                        ).length === 0
                    ) {
                        throw new Error('No source was found');
                    }
                    return { propertyItems: [] };
                }
            }
            return {};
        });

        await registerOBSIPC();
        await flushPromises();

        const getWindowsHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'obs.getWindows'
        )?.[1];

        expect(getWindowsHandler).toBeTypeOf('function');

        await expect(getWindowsHandler({}, { quick: true })).resolves.toEqual([]);

        expect(obsCallMock).toHaveBeenCalledWith('SetSceneItemEnabled', {
            sceneName: 'GSM Helper - DONT TOUCH',
            sceneItemId: 17,
            sceneItemEnabled: false,
        });
        expect(obsCallMock).toHaveBeenCalledWith('SetSceneItemEnabled', {
            sceneName: 'GSM Helper - DONT TOUCH',
            sceneItemId: 23,
            sceneItemEnabled: false,
        });
        expect(obsCallMock).toHaveBeenCalledWith('CreateInput', {
            sceneName: 'GSM Helper - DONT TOUCH',
            inputName: 'game_window_getter',
            inputKind: 'game_capture',
            inputSettings: {},
            sceneItemEnabled: false,
        });
    });

    it('forces capture-card helper sources to stay disabled during full enumeration', async () => {
        const { registerOBSIPC } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string, requestData?: any) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper - DONT TOUCH'
            ) {
                return {
                    sceneItems: [
                        {
                            sceneItemId: 31,
                            sourceName: 'capture_card_getter',
                            sceneItemEnabled: true,
                        },
                        {
                            sceneItemId: 32,
                            sourceName: 'audio_input_getter',
                            sceneItemEnabled: true,
                        },
                    ],
                };
            }
            if (requestType === 'GetInputPropertiesListPropertyItems') {
                if (
                    requestData?.inputName === 'capture_card_getter' ||
                    requestData?.inputName === 'audio_input_getter'
                ) {
                    if (
                        obsCallMock.mock.calls.filter(
                            ([type, data]) =>
                                type === 'CreateInput' &&
                                data?.inputName === requestData.inputName
                        ).length === 0
                    ) {
                        throw new Error('No source was found');
                    }
                    return { propertyItems: [] };
                }

                if (
                    requestData?.inputName === 'window_getter' ||
                    requestData?.inputName === 'game_window_getter'
                ) {
                    return { propertyItems: [] };
                }
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper'
            ) {
                throw new Error('No source was found');
            }
            return {};
        });

        await registerOBSIPC();
        await flushPromises();

        const setProbeHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'obs.setCaptureCardProbeEnabled'
        )?.[1];
        const getWindowsHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'obs.getWindows'
        )?.[1];

        expect(setProbeHandler).toBeTypeOf('function');
        expect(getWindowsHandler).toBeTypeOf('function');

        await expect(setProbeHandler({}, true)).resolves.toBe(true);
        obsCallMock.mockClear();

        await expect(getWindowsHandler({}, { quick: false })).resolves.toEqual([]);

        expect(obsCallMock).toHaveBeenCalledWith('SetSceneItemEnabled', {
            sceneName: 'GSM Helper - DONT TOUCH',
            sceneItemId: 31,
            sceneItemEnabled: false,
        });
        expect(obsCallMock).toHaveBeenCalledWith('SetSceneItemEnabled', {
            sceneName: 'GSM Helper - DONT TOUCH',
            sceneItemId: 32,
            sceneItemEnabled: false,
        });
    });

    it('creates capture-card helper inputs only when capture-card probing is enabled', async () => {
        const { registerOBSIPC } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string, requestData?: any) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetInputSettings') {
                throw new Error('No source was found');
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper - DONT TOUCH'
            ) {
                return {
                    sceneItems: [
                        {
                            sceneItemId: 31,
                            sourceName: 'capture_card_getter',
                            sceneItemEnabled: true,
                        },
                        {
                            sceneItemId: 32,
                            sourceName: 'audio_input_getter',
                            sceneItemEnabled: true,
                        },
                    ],
                };
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper'
            ) {
                throw new Error('No source was found');
            }
            return {};
        });

        await registerOBSIPC();
        await flushPromises();

        const setProbeHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'obs.setCaptureCardProbeEnabled'
        )?.[1];

        expect(setProbeHandler).toBeTypeOf('function');

        await expect(setProbeHandler({}, true)).resolves.toBe(true);

        expect(obsCallMock).toHaveBeenCalledWith('CreateInput', {
            sceneName: 'GSM Helper - DONT TOUCH',
            inputName: 'capture_card_getter',
            inputKind: 'dshow_input',
            inputSettings: {},
            sceneItemEnabled: false,
        });
        expect(obsCallMock).toHaveBeenCalledWith('CreateInput', {
            sceneName: 'GSM Helper - DONT TOUCH',
            inputName: 'audio_input_getter',
            inputKind: 'wasapi_input_capture',
            inputSettings: { device_id: 'default' },
            sceneItemEnabled: false,
        });
        expect(obsCallMock).toHaveBeenCalledWith('SetSceneItemEnabled', {
            sceneName: 'GSM Helper - DONT TOUCH',
            sceneItemId: 31,
            sceneItemEnabled: false,
        });
        expect(obsCallMock).toHaveBeenCalledWith('SetSceneItemEnabled', {
            sceneName: 'GSM Helper - DONT TOUCH',
            sceneItemId: 32,
            sceneItemEnabled: false,
        });
    });

    it('removes capture-card helper inputs when capture-card probing is disabled', async () => {
        const { registerOBSIPC } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string, requestData?: any) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetInputSettings') {
                throw new Error('No source was found');
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper - DONT TOUCH'
            ) {
                return {
                    sceneItems: [
                        {
                            sceneItemId: 31,
                            sourceName: 'capture_card_getter',
                            sceneItemEnabled: true,
                        },
                        {
                            sceneItemId: 32,
                            sourceName: 'audio_input_getter',
                            sceneItemEnabled: true,
                        },
                    ],
                };
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper'
            ) {
                throw new Error('No source was found');
            }
            return {};
        });

        await registerOBSIPC();
        await flushPromises();

        const setProbeHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'obs.setCaptureCardProbeEnabled'
        )?.[1];

        expect(setProbeHandler).toBeTypeOf('function');

        await expect(setProbeHandler({}, true)).resolves.toBe(true);
        obsCallMock.mockClear();

        await expect(setProbeHandler({}, false)).resolves.toBe(false);

        expect(obsCallMock).toHaveBeenCalledWith('RemoveInput', {
            inputName: 'capture_card_getter',
        });
        expect(obsCallMock).toHaveBeenCalledWith('RemoveInput', {
            inputName: 'audio_input_getter',
        });
    });

    it('removes stale capture-card helper inputs on first connect when probing is disabled', async () => {
        const { registerOBSIPC } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string, requestData?: any) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper - DONT TOUCH'
            ) {
                return {
                    sceneItems: [
                        {
                            sceneItemId: 31,
                            sourceName: 'capture_card_getter',
                            sceneItemEnabled: true,
                        },
                        {
                            sceneItemId: 32,
                            sourceName: 'audio_input_getter',
                            sceneItemEnabled: true,
                        },
                    ],
                };
            }
            if (
                requestType === 'GetSceneItemList' &&
                requestData?.sceneName === 'GSM Helper'
            ) {
                throw new Error('No source was found');
            }
            return {};
        });

        await registerOBSIPC();
        await flushPromises();

        const getProbeHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'obs.getCaptureCardProbeEnabled'
        )?.[1];

        expect(getProbeHandler).toBeTypeOf('function');

        await expect(getProbeHandler({},)).resolves.toBe(false);

        expect(obsCallMock).toHaveBeenCalledWith('RemoveInput', {
            inputName: 'capture_card_getter',
        });
        expect(obsCallMock).toHaveBeenCalledWith('RemoveInput', {
            inputName: 'audio_input_getter',
        });
    });
});

describe('getScenePreviewSnapshot', () => {
    beforeEach(() => {
        obsCallMock.mockReset();
        obsConnectMock.mockReset();
        obsDisconnectMock.mockReset();
        obsOnMock.mockReset();
        obsRemoveAllListenersMock.mockReset();
        obsConnectMock.mockResolvedValue(undefined);
    });

    it('screenshots the OBS scene composite when no preview source is recognized', async () => {
        const { getScenePreviewSnapshot } = await loadObsModule();
        const imageData = 'data:image/jpeg;base64,preview';

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSceneList') {
                return {
                    scenes: [
                        {
                            sceneName: 'Webcam Scene',
                            sceneUuid: 'scene-webcam',
                        },
                    ],
                };
            }
            if (requestType === 'GetVideoSettings') {
                return { baseWidth: 1920, baseHeight: 1080 };
            }
            if (requestType === 'GetSceneItemList') {
                return {
                    sceneItems: [
                        {
                            sceneItemId: 7,
                            sourceName: 'Webcam',
                            inputKind: 'dshow_input',
                            sceneItemEnabled: true,
                        },
                    ],
                };
            }
            if (requestType === 'GetSourceScreenshot') {
                return { imageData };
            }
            return {};
        });

        await expect(getScenePreviewSnapshot('scene-webcam')).resolves.toEqual({
            sceneName: 'Webcam Scene',
            sceneId: 'scene-webcam',
            sourceName: null,
            captureMode: null,
            imageData,
        });

        expect(obsCallMock).toHaveBeenCalledWith('GetSourceScreenshot', {
            sourceName: 'Webcam Scene',
            imageFormat: 'jpg',
            imageWidth: 960,
            imageHeight: 540,
        });
    });
});

describe('sceneHasVisibleOutput', () => {
    it('detects visible scene output from the OBS scene composite screenshot', async () => {
        const { sceneHasVisibleOutput } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSourceScreenshot') {
                return { imageData: NON_UNIFORM_PNG_DATA_URL };
            }
            return {};
        });

        await expect(
            sceneHasVisibleOutput({ id: 'scene-123', name: 'Octopath Traveler 0' })
        ).resolves.toBe(true);

        expect(obsCallMock).toHaveBeenLastCalledWith('GetSourceScreenshot', {
            sourceName: 'Octopath Traveler 0',
            imageFormat: 'png',
            imageWidth: 8,
            imageHeight: 8,
        });
        expect(obsCallMock.mock.calls.map(([requestType]) => requestType)).not.toContain(
            'GetSceneItemList'
        );
    });

    it('treats a uniform scene composite screenshot as no visible output', async () => {
        const { sceneHasVisibleOutput } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSourceScreenshot') {
                return { imageData: UNIFORM_PNG_DATA_URL };
            }
            return {};
        });

        await expect(
            sceneHasVisibleOutput({ id: 'scene-123', name: 'Empty Scene' })
        ).resolves.toBe(false);
    });

    it('returns null when the OBS scene composite cannot be captured', async () => {
        const { sceneHasVisibleOutput } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSourceScreenshot') {
                throw new Error('No source was found');
            }
            return {};
        });

        await expect(
            sceneHasVisibleOutput({ id: 'scene-123', name: 'Missing Scene' })
        ).resolves.toBeNull();
    });
});

describe('linux xcomposite scene metadata', () => {
    beforeEach(() => {
        obsCallMock.mockReset();
        obsConnectMock.mockReset();
        obsDisconnectMock.mockReset();
        obsOnMock.mockReset();
        obsRemoveAllListenersMock.mockReset();
        obsConnectMock.mockResolvedValue(undefined);
        obsDisconnectMock.mockResolvedValue(undefined);
    });

    it('parses the window class from capture_window settings', async () => {
        const { getExecutableNameFromSource } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSceneItemList') {
                return {
                    sceneItems: [
                        {
                            sourceUuid: 'source-1',
                            sourceName: 'NineSols - XComposite Window Capture',
                        },
                    ],
                };
            }
            if (requestType === 'GetInputSettings') {
                return {
                    inputSettings: {
                        capture_window:
                            '161480705\r\nNineSols\r\nsteam_app_1809540',
                    },
                };
            }
            return {};
        });

        await expect(getExecutableNameFromSource('scene-123')).resolves.toBe(
            'steam_app_1809540'
        );
    });

    it('parses the title from capture_window settings', async () => {
        const { getWindowTitleFromSource } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSceneItemList') {
                return {
                    sceneItems: [
                        {
                            sourceUuid: 'source-1',
                            sourceName: 'NineSols - XComposite Window Capture',
                        },
                    ],
                };
            }
            if (requestType === 'GetInputSettings') {
                return {
                    inputSettings: {
                        capture_window:
                            '161480705\r\nNineSols\r\nsteam_app_1809540',
                    },
                };
            }
            return {};
        });

        await expect(getWindowTitleFromSource('scene-123')).resolves.toBe('NineSols');
    });
});
