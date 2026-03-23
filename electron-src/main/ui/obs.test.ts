import { beforeEach, describe, expect, it, vi } from 'vitest';

const obsCallMock = vi.fn();
const obsConnectMock = vi.fn();
const obsDisconnectMock = vi.fn();
const obsOnMock = vi.fn();
const obsRemoveAllListenersMock = vi.fn();

const UNIFORM_PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAkSURBVChThcihAQAACIAw/n9asxAMKwOYR8ISlrCEJSxhiWMBgkg/wTHeyiUAAAAASUVORK5CYII=';
const NON_UNIFORM_PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAVSURBVChTY2BgYPiPjP+jYYaRoQAAI4hfoUYt8SsAAAAASUVORK5CYII=';

vi.mock('electron', () => ({
    BrowserWindow: class BrowserWindow {},
    dialog: {
        showMessageBox: vi.fn(),
    },
    ipcMain: {
        handle: vi.fn(),
    },
}));

vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

vi.mock('electron-store', () => ({
    default: class Store {
        get(): undefined {
            return undefined;
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
    sendStartOBS: vi.fn(),
    sendQuitOBS: vi.fn(),
}));

vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm',
    getAssetsDir: () => 'C:\\test-gsm\\assets',
    isLinux: () => false,
    isWindows: () => true,
    isWindows10OrHigher: () => true,
}));

vi.mock('./obs-capture.js', () => ({
    OBS_XCOMPOSITE_INPUT_KIND: 'xcomposite_input',
    buildLinuxSceneCaptureInputs: vi.fn(),
    buildWindowsSceneCaptureInputs: vi.fn(),
    mergeObsWindowItems: vi.fn(),
}));

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

describe('renameOBSScene', () => {
    beforeEach(() => {
        obsCallMock.mockReset();
        obsConnectMock.mockReset();
        obsDisconnectMock.mockReset();
        obsOnMock.mockReset();
        obsRemoveAllListenersMock.mockReset();

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
});

describe('sceneHasVisibleOutput', () => {
    it('detects visible scene output from a non-uniform screenshot', async () => {
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
    });

    it('treats a uniform screenshot as no visible output', async () => {
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
});
