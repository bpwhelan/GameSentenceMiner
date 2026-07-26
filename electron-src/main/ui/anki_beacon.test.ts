import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosGetMock = vi.fn();
const mkdirMock = vi.fn();
const writeFileMock = vi.fn();
const openPathMock = vi.fn();
const ipcHandleMock = vi.fn();
const getConfiguredSinglePortMock = vi.fn();
const writeConfiguredAnkiBeaconAddonMock = vi.fn();

vi.mock('axios', () => ({
    default: {
        get: axiosGetMock,
    },
}));

vi.mock('node:fs/promises', () => ({
    mkdir: mkdirMock,
    writeFile: writeFileMock,
}));

vi.mock('electron', () => ({
    app: {
        getPath: vi.fn(() => 'C:\\temp'),
    },
    ipcMain: {
        handle: ipcHandleMock,
    },
    shell: {
        openPath: openPathMock,
    },
}));

vi.mock('../gsm_config.js', () => ({
    DEFAULT_GSM_SINGLE_PORT: 7275,
    getConfiguredSinglePort: getConfiguredSinglePortMock,
}));

vi.mock('./anki_beacon_package.js', () => ({
    writeConfiguredAnkiBeaconAddon: writeConfiguredAnkiBeaconAddonMock,
}));

async function loadAnkiBeaconModule() {
    vi.resetModules();
    return import('./anki_beacon.js');
}

describe('AnkiBeacon installer IPC', () => {
    beforeEach(() => {
        axiosGetMock.mockReset();
        mkdirMock.mockReset();
        writeFileMock.mockReset();
        openPathMock.mockReset();
        ipcHandleMock.mockReset();
        getConfiguredSinglePortMock.mockReset();
        getConfiguredSinglePortMock.mockReturnValue(7275);
        writeConfiguredAnkiBeaconAddonMock.mockReset();
        writeConfiguredAnkiBeaconAddonMock.mockResolvedValue(undefined);
    });

    it('downloads the latest ankiaddon and opens it with the OS handler', async () => {
        axiosGetMock.mockResolvedValue({ data: Buffer.from('addon') });
        openPathMock.mockResolvedValue('');

        const { installAnkiBeaconAddon } = await loadAnkiBeaconModule();

        await expect(installAnkiBeaconAddon()).resolves.toMatchObject({
            success: true,
            filePath: 'C:\\temp\\GameSentenceMiner\\Anki.Beacon.ankiaddon',
        });

        expect(axiosGetMock).toHaveBeenCalledWith(
            'https://github.com/bpwhelan/AnkiBeacon/releases/latest/download/Anki.Beacon.ankiaddon',
            expect.objectContaining({ responseType: 'arraybuffer' }),
        );
        expect(mkdirMock).toHaveBeenCalledWith('C:\\temp\\GameSentenceMiner', { recursive: true });
        expect(writeFileMock).toHaveBeenCalledWith(
            'C:\\temp\\GameSentenceMiner\\Anki.Beacon.ankiaddon',
            Buffer.from('addon'),
        );
        expect(openPathMock).toHaveBeenCalledWith('C:\\temp\\GameSentenceMiner\\Anki.Beacon.ankiaddon');
        expect(writeConfiguredAnkiBeaconAddonMock).not.toHaveBeenCalled();
    });

    it('preconfigures the downloaded add-on when GSM uses a nondefault port', async () => {
        const addonBytes = Buffer.from('addon');
        axiosGetMock.mockResolvedValue({ data: addonBytes });
        getConfiguredSinglePortMock.mockReturnValue(6001);
        openPathMock.mockResolvedValue('');

        const { installAnkiBeaconAddon } = await loadAnkiBeaconModule();

        await expect(installAnkiBeaconAddon()).resolves.toMatchObject({
            success: true,
            filePath: 'C:\\temp\\GameSentenceMiner\\Anki.Beacon.ankiaddon',
        });

        expect(writeConfiguredAnkiBeaconAddonMock).toHaveBeenCalledWith(
            addonBytes,
            'C:\\temp\\GameSentenceMiner\\Anki.Beacon.ankiaddon',
            6001,
        );
        expect(writeFileMock).not.toHaveBeenCalled();
        expect(openPathMock).toHaveBeenCalledWith('C:\\temp\\GameSentenceMiner\\Anki.Beacon.ankiaddon');
    });

    it('reports shell-open failures so the renderer can show manual instructions', async () => {
        axiosGetMock.mockResolvedValue({ data: Buffer.from('addon') });
        openPathMock.mockResolvedValue('No application is associated with the file.');

        const { installAnkiBeaconAddon } = await loadAnkiBeaconModule();

        await expect(installAnkiBeaconAddon()).resolves.toEqual({
            success: false,
            error: 'No application is associated with the file.',
        });
    });

    it('registers the install IPC handler', async () => {
        const { registerAnkiBeaconIPC } = await loadAnkiBeaconModule();

        registerAnkiBeaconIPC();

        expect(ipcHandleMock).toHaveBeenCalledWith('ankiBeacon.install', expect.any(Function));
    });
});
