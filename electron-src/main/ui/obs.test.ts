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
const storeData = new Map<string, unknown>();
const storeSetMock = vi.fn<(key: string, value: unknown) => void>();

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
    exec: vi.fn(),
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
        storeSetMock.mockReset();
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
        showMessageBoxMock.mockResolvedValue({ response: 0, checkboxChecked: false });
        execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

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
            expect(sendQuitOBSMock).toHaveBeenCalledTimes(1);
            expect(sendStartOBSMock).toHaveBeenCalledTimes(1);
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

describe('sceneHasVisibleOutput', () => {
    it('detects visible scene output from a non-uniform screenshot', async () => {
        const { sceneHasVisibleOutput } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSceneItemList') {
                return {
                    sceneItems: [
                        {
                            sourceName: 'Octopath Traveler 0',
                            inputKind: 'window_capture',
                        },
                    ],
                };
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
    });

    it('treats a uniform screenshot as no visible output', async () => {
        const { sceneHasVisibleOutput } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'GetSceneItemList') {
                return {
                    sceneItems: [
                        {
                            sourceName: 'Empty Scene',
                            inputKind: 'window_capture',
                        },
                    ],
                };
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
