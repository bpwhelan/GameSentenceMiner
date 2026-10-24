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
const buildWaylandPipewireOptionMock = vi.fn(() => null);
const buildLinuxSceneCaptureInputsMock = vi.fn(() => []);
const buildWindowsSceneCaptureInputsMock = vi.fn();
const buildWindowsVideoCaptureInputMock = vi.fn();
const isLinuxMock = vi.fn(() => false);
const isWindowsMock = vi.fn(() => true);
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
const createObsSettingsSnapshotMock = vi.fn();

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

vi.mock('../data_dir.js', () => ({
    getBaseDir: () => TEST_BASE_DIR,
}));

vi.mock('../services/obs_settings_snapshot.js', () => ({
    createObsSettingsSnapshot: createObsSettingsSnapshotMock,
}));

vi.mock('../util.js', () => ({
    BASE_DIR: TEST_BASE_DIR,
    execFileAsync: execFileAsyncMock,
    getAssetsDir: () => 'C:\\test-gsm\\assets',
    isMacOS: () => false,
    isLinux: isLinuxMock,
    isWindows: isWindowsMock,
    isWindows10OrHigher: () => true,
}));

vi.mock('./obs-capture.js', async () => ({
    ...await vi.importActual<typeof import('./obs-capture.js')>('./obs-capture.js'),
    OBS_DSHOW_INPUT_KIND: 'dshow_input',
    OBS_PIPEWIRE_DESKTOP_INPUT_KIND: 'pipewire-desktop-capture-source',
    OBS_PIPEWIRE_SCREEN_INPUT_KIND: 'pipewire-screen-capture-source',
    OBS_PIPEWIRE_WINDOW_INPUT_KIND: 'pipewire-window-capture-source',
    OBS_WASAPI_INPUT_CAPTURE_KIND: 'wasapi_input_capture',
    OBS_XCOMPOSITE_INPUT_KIND: 'xcomposite_input',
    buildCaptureCardOptions: buildCaptureCardOptionsMock,
    buildWaylandPipewireOption: buildWaylandPipewireOptionMock,
    buildLinuxSceneCaptureInputs: buildLinuxSceneCaptureInputsMock,
    buildWindowsSceneCaptureInputs: buildWindowsSceneCaptureInputsMock,
    buildWindowsVideoCaptureInput: buildWindowsVideoCaptureInputMock,
    getObsWindowTitle: vi.fn((title: string) => title),
    mergeObsWindowItems: mergeObsWindowItemsMock,
    parseObsWindowValue: vi.fn((value: string) => ({
        title: value.split(':')[0] ?? '',
        windowClass: value.split(':')[1] ?? '',
        executable: value.split(':').at(-1) ?? '',
    })),
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

beforeEach(() => {
    isLinuxMock.mockReturnValue(false);
    isWindowsMock.mockReturnValue(true);
    buildLinuxSceneCaptureInputsMock.mockReset();
    buildLinuxSceneCaptureInputsMock.mockReturnValue([]);
});

describe('getGameInfoFromWindow', () => {
    it('extracts game names from yuzu Early Access titles', async () => {
        const { getGameInfoFromWindow } = await loadObsModule();
        const rawTitle =
            'yuzu Early Access 4175 | ANONYMOUS;CODE (64-bit) | 1.0.0 | NVIDIA';

        const result = getGameInfoFromWindow(rawTitle);
        const switcherPattern = new RegExp(result.switcherRegex, 'i');

        expect(result.sceneName).toBe('ANONYMOUS;CODE');
        expect(result.switcherRegex).not.toContain('4175');
        expect(rawTitle).toMatch(switcherPattern);
        expect(
            'yuzu Early Access 5000 | ANONYMOUS;CODE (64-bit) | 1.1.0 | AMD'
        ).toMatch(switcherPattern);
    });
});

describe('shouldFilterWindow', () => {
    it.each([
        ['Eden Configuration', 'Eden.exe'],
        ['yuzu Configuration', 'yuzu.exe'],
    ])('filters the %s dialog', async (title, executable) => {
        const { shouldFilterWindow } = await loadObsModule();

        expect(
            shouldFilterWindow({
                itemName: title,
                itemValue: `${title}:Qt5152QWindowIcon:${executable}`,
            })
        ).toBe(true);
    });

    it('keeps an Eden game window available', async () => {
        const { shouldFilterWindow } = await loadObsModule();

        expect(
            shouldFilterWindow({
                itemName: 'Eden | v0.0.4 | ANONYMOUS;CODE (64-bit)',
                itemValue: 'Eden | v0.0.4 | ANONYMOUS;CODE (64-bit):Qt5152QWindowIcon:Eden.exe',
            })
        ).toBe(false);
    });
});

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
        execFileAsyncMock.mockReset();
        execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
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

    it('preserves Windows paths and quoted option values when resolving a launch command', async () => {
        const executable = String.raw`C:\Users\Sam %TEMP% & 日本語\obs64.exe`;
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === executable);
        const { resolveElectronOBSLaunchCommand } = await loadObsModule();

        const result = resolveElectronOBSLaunchCommand(
            `"${executable}" --profile="Sam's $1 [GSM]" --collection="日本語 game"`,
        );

        expect(result?.command).toBe(executable);
        expect(result?.args).toEqual(["--profile=Sam's $1 [GSM]", '--collection=日本語 game']);
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
            ]),
            expect.objectContaining({
                cwd: 'C:\\test-gsm\\obs-studio\\bin\\64bit',
                detached: false,
                shell: false,
                stdio: 'ignore',
            })
        );
        expect(spawnMock.mock.calls[0]?.[1]).not.toContain('--startreplaybuffer');
        expect(writeFileSyncMock).toHaveBeenCalledWith(
            'C:\\test-gsm\\obs_pid.txt',
            '4242',
            'utf-8'
        );
    });

    it('removes startup artifacts beside the configured portable OBS executable', async () => {
        const movedFromObsPath =
            'C:\\old-gsm\\obs-studio\\bin\\64bit\\obs64.exe';
        const movedFromSentinel =
            'C:\\old-gsm\\obs-studio\\config\\obs-studio\\.sentinel';
        const movedFromRunningFile =
            'C:\\old-gsm\\obs-studio\\config\\obs-studio\\plugin_config\\advanced-scene-switcher\\.running';
        existsSyncMock.mockImplementation(
            (targetPath: string) =>
                targetPath === CONFIG_PATH ||
                targetPath === movedFromObsPath ||
                targetPath === movedFromSentinel ||
                targetPath === movedFromRunningFile
        );
        readFileSyncMock.mockImplementation((targetPath: string) =>
            targetPath === CONFIG_PATH
                ? JSON.stringify({ obs: { obs_path: movedFromObsPath } })
                : '{}'
        );
        const { launchOBSFromElectron } = await loadObsModule();

        const result = await launchOBSFromElectron({ reason: 'after data move' });

        expect(result).toEqual({ status: 'launched', pid: 4242 });
        expect(rmSyncMock).toHaveBeenCalledWith(movedFromSentinel, {
            recursive: true,
            force: true,
        });
        expect(rmSyncMock).toHaveBeenCalledWith(movedFromRunningFile, {
            recursive: true,
            force: true,
        });
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
        expect(execFileAsyncMock).toHaveBeenCalledWith(
            expect.stringMatching(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i),
            expect.arrayContaining(['-EncodedCommand']),
            { windowsHide: true, timeout: 15_000 },
        );
    });

    it('restores the existing managed OBS window from the tray when opened from Home', async () => {
        const obsPidPath = 'C:\\test-gsm\\obs_pid.txt';
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === obsPidPath);
        readFileSyncMock.mockImplementation((targetPath: string) =>
            targetPath === obsPidPath ? '4242' : '{}'
        );
        execFileAsyncMock.mockResolvedValue({ stdout: '"obs64.exe","4242"', stderr: '' });
        vi.spyOn(process, 'kill').mockImplementation(() => true);
        const { registerOBSIPC } = await loadObsModule();

        await registerOBSIPC();
        const openOBSHandler = ipcHandleMock.mock.calls.find(([channel]) => channel === 'openOBS')?.[1];
        await expect(openOBSHandler({})).resolves.toEqual({ status: 'already-running', pid: 4242 });

        expect(spawnMock).not.toHaveBeenCalled();
        const [executable, args, options] = execFileAsyncMock.mock.calls.at(-1)!;
        expect(executable).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        expect(script).toContain('Get-Process -Id 4242');
        expect(script).toContain('EnumWindows');
        expect(script).toContain('GetWindowThreadProcessId');
        expect(script).toContain('TrayIconMessageWindowClass');
        expect(script).toContain('SendMessageTimeout');
        expect(script).toContain('ActivateTrayIcon(trayWindow)');
        expect(script).toContain('0x8065');
        expect(script).toContain('0x0400');
        expect(script).not.toContain('IsIconic(window) ? 9 : 5');
        expect(script).toContain('SetForegroundWindow');
        expect(options).toEqual({ windowsHide: true, timeout: 15_000 });
    });

    it('does not launch another OBS when restoring its window fails', async () => {
        const obsPidPath = 'C:\\test-gsm\\obs_pid.txt';
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === obsPidPath);
        readFileSyncMock.mockImplementation((targetPath: string) =>
            targetPath === obsPidPath ? '4242' : '{}'
        );
        execFileAsyncMock.mockImplementation(async (executable: string) => {
            if (executable === 'tasklist') return { stdout: '"obs64.exe","4242"', stderr: '' };
            throw new Error('OBS window is unavailable');
        });
        vi.spyOn(process, 'kill').mockImplementation(() => true);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { registerOBSIPC } = await loadObsModule();

        await registerOBSIPC();
        const openOBSHandler = ipcHandleMock.mock.calls.find(([channel]) => channel === 'openOBS')?.[1];
        await expect(openOBSHandler({})).resolves.toMatchObject({
            status: 'failed',
            pid: 4242,
            error: expect.stringContaining('OBS window is unavailable'),
        });
        expect(spawnMock).not.toHaveBeenCalled();
        expect(sendStartOBSMock).not.toHaveBeenCalled();
    });

    it('keeps automatic startup from restoring the OBS window', async () => {
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === DEFAULT_OBS_PATH);
        const { launchOBSFromElectron } = await loadObsModule();

        await expect(launchOBSFromElectron({ reason: 'startup' })).resolves.toEqual({
            status: 'launched', pid: 4242,
        });
        expect(execFileAsyncMock).not.toHaveBeenCalled();
    });

    it('preserves manual OBS launch on other platforms', async () => {
        isWindowsMock.mockReturnValue(false);
        isLinuxMock.mockReturnValue(true);
        const { registerOBSIPC } = await loadObsModule();

        await registerOBSIPC();
        const openOBSHandler = ipcHandleMock.mock.calls.find(([channel]) => channel === 'openOBS')?.[1];
        await expect(openOBSHandler({})).resolves.toEqual({ status: 'launched', pid: 4242 });
        expect(execFileAsyncMock).not.toHaveBeenCalled();
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

describe('closeOBSFromElectron', () => {
    const OBS_PID_PATH = 'C:\\test-gsm\\obs_pid.txt';
    const DEFAULT_OBS_PATH = 'C:\\test-gsm\\obs-studio\\bin\\64bit\\obs64.exe';

    beforeEach(() => {
        existsSyncMock.mockReset();
        readFileSyncMock.mockReset();
        writeFileSyncMock.mockReset();
        rmSyncMock.mockReset();
        mkdirSyncMock.mockReset();
        execFileAsyncMock.mockReset();
        createObsSettingsSnapshotMock.mockReset();
        obsCallMock.mockReset();
        obsCallMock.mockResolvedValue({ outputActive: false });
        obsConnectMock.mockReset();
        obsConnectMock.mockResolvedValue({});
        obsDisconnectMock.mockReset();
        obsDisconnectMock.mockResolvedValue(undefined);
        spawnMock.mockReset();
        storeData.clear();
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === OBS_PID_PATH);
        readFileSyncMock.mockImplementation((targetPath: string) =>
            targetPath === OBS_PID_PATH ? '4242' : '{}'
        );
        execFileAsyncMock.mockResolvedValue({ stdout: '"obs64.exe","4242"', stderr: '' });
        vi.spyOn(process, 'kill').mockImplementation(() => true);
    });

    it('requests a graceful close of the exact OBS process and waits for it to save and exit', async () => {
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'closed', pid: 4242 });

        const [executable, args, options] = execFileAsyncMock.mock.calls.at(-1)!;
        expect(executable).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
        expect(args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        expect(script).toContain('Get-Process -Id 4242');
        expect(script).toContain("'^obs(32|64)?$'");
        expect(script).toContain('CloseMainWindow()');
        expect(script).toContain('EnumWindows');
        expect(script).toContain('GetWindowThreadProcessId');
        expect(script).toContain('WaitForExit(10000)');
        expect(script).not.toMatch(/taskkill|Stop-Process|TerminateProcess/i);
        expect(options).toEqual({ windowsHide: true, timeout: 20_000 });
        expect(process.kill).toHaveBeenCalledWith(4242, 0);
        expect(rmSyncMock).toHaveBeenCalledWith(OBS_PID_PATH, { force: true });
    });

    it('keeps PID tracking until OBS has actually exited', async () => {
        let completeClose!: (value: { stdout: string; stderr: string }) => void;
        const closed = new Promise<{ stdout: string; stderr: string }>((resolve) => {
            completeClose = resolve;
        });
        execFileAsyncMock.mockImplementation(async (executable: string) =>
            executable === 'tasklist' ? { stdout: '"obs64.exe","4242"', stderr: '' } : closed
        );
        const { closeOBSFromElectron } = await loadObsModule();

        const closing = closeOBSFromElectron();
        await flushPromises();
        expect(rmSyncMock).not.toHaveBeenCalled();
        completeClose({ stdout: '', stderr: '' });
        await expect(closing).resolves.toEqual({ status: 'closed', pid: 4242 });
        expect(rmSyncMock).toHaveBeenCalledWith(OBS_PID_PATH, { force: true });
    });

    it('finalizes recording and waits for the replay buffer to stop before requesting close', async () => {
        const order: string[] = [];
        let recording = true;
        let replayChecks = 0;
        obsCallMock.mockImplementation(async (request: string) => {
            order.push(request);
            if (request === 'GetStreamStatus') return { outputActive: false };
            if (request === 'GetRecordStatus') return { outputActive: recording };
            if (request === 'GetReplayBufferStatus') return { outputActive: ++replayChecks < 3 };
            if (request === 'StopRecord') { recording = false; return { outputPath: 'recording.mkv' }; }
        });
        execFileAsyncMock.mockImplementation(async (executable: string) => {
            if (executable !== 'tasklist') {
                expect(recording).toBe(false);
                expect(replayChecks).toBeGreaterThanOrEqual(3);
                order.push('close window');
            }
            return { stdout: '"obs64.exe","4242"', stderr: '' };
        });
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'closed', pid: 4242 });
        expect(order.indexOf('StopRecord')).toBeLessThan(order.indexOf('close window'));
        expect(order.indexOf('StopReplayBuffer')).toBeLessThan(order.indexOf('close window'));
        expect(obsDisconnectMock).toHaveBeenCalledOnce();
    });

    it('leaves OBS open when an output cannot be stopped', async () => {
        obsCallMock.mockImplementation(async (request: string) => {
            if (request === 'StopRecord') throw new Error('Recording is still finalizing.');
            return { outputActive: request === 'GetRecordStatus' };
        });
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toMatchObject({ status: 'failed', error: 'Recording is still finalizing.' });
        expect(execFileAsyncMock).toHaveBeenCalledOnce();
        expect(rmSyncMock).not.toHaveBeenCalled();
        expect(obsDisconnectMock).toHaveBeenCalledOnce();
    });

    it('leaves an active stream running without requesting a close', async () => {
        obsCallMock.mockResolvedValue({ outputActive: true });
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/streaming/i) });
        expect(obsCallMock).not.toHaveBeenCalledWith('StopRecord');
        expect(obsCallMock).not.toHaveBeenCalledWith('StopReplayBuffer');
        expect(execFileAsyncMock).toHaveBeenCalledOnce();
        expect(rmSyncMock).not.toHaveBeenCalled();
    });

    it('does not close OBS when its websocket cannot be reached', async () => {
        obsConnectMock.mockRejectedValue(new Error('OBS websocket unavailable.'));
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toMatchObject({ status: 'failed', error: 'OBS websocket unavailable.' });
        expect(execFileAsyncMock).toHaveBeenCalledOnce();
        expect(rmSyncMock).not.toHaveBeenCalled();
    });

    it('closes safely when the recording profile has replay buffering disabled', async () => {
        obsCallMock.mockImplementation(async (request: string) => {
            if (request === 'GetReplayBufferStatus') throw Object.assign(new Error('Replay buffer is not available.'), { code: 604 });
            return { outputActive: false };
        });
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'closed', pid: 4242 });
        expect(obsCallMock).not.toHaveBeenCalledWith('StopRecord');
        expect(obsCallMock).not.toHaveBeenCalledWith('StopReplayBuffer');
    });

    it('accepts a concurrent manual stop but verifies that outputs have stopped', async () => {
        let checks = 0;
        obsCallMock.mockImplementation(async (request: string) => {
            if (request === 'GetRecordStatus') return { outputActive: ++checks === 1 };
            if (request === 'StopRecord') throw Object.assign(new Error('Output is not running.'), { code: 501 });
            return { outputActive: false };
        });
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'closed', pid: 4242 });
        expect(checks).toBe(2);
    });

    it('leaves OBS open if outputs remain active after the stop deadline', async () => {
        obsCallMock.mockImplementation(async (request: string) => ({ outputActive: request === 'GetReplayBufferStatus' }));
        const { closeOBSFromElectron } = await loadObsModule();
        vi.useFakeTimers();
        try {
            const closing = closeOBSFromElectron();
            await vi.advanceTimersByTimeAsync(16_000);
            await expect(closing).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/outputs did not finish stopping/) });
            expect(execFileAsyncMock).toHaveBeenCalledOnce();
            expect(rmSyncMock).not.toHaveBeenCalled();
            expect(obsDisconnectMock).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(['OBS did not exit before the timeout.', 'OBS has no main window to close.'])(
        'leaves OBS and PID tracking intact when graceful shutdown fails: %s',
        async (message) => {
            execFileAsyncMock.mockImplementation(async (executable: string) => {
                if (executable === 'tasklist') return { stdout: '"obs64.exe","4242"', stderr: '' };
                throw new Error(message);
            });
            const { closeOBSFromElectron } = await loadObsModule();

            await expect(closeOBSFromElectron()).resolves.toEqual({
                status: 'failed',
                pid: 4242,
                error: message,
            });
            expect(rmSyncMock).not.toHaveBeenCalled();
            expect(process.kill).toHaveBeenCalledExactlyOnceWith(4242, 0);
            expect(execFileAsyncMock.mock.calls.some(([executable]) => /taskkill/i.test(executable))).toBe(false);
        }
    );

    it.each(['notepad.exe', 'obsidian.exe'])('does not close %s when it reused the saved PID', async (image) => {
        execFileAsyncMock.mockResolvedValue({ stdout: `"${image}","4242"`, stderr: '' });
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'not-running', pid: 4242 });
        expect(execFileAsyncMock).toHaveBeenCalledExactlyOnceWith('tasklist', [
            '/NH', '/FO', 'CSV', '/FI', 'PID eq 4242',
        ]);
        expect(process.kill).toHaveBeenCalledExactlyOnceWith(4242, 0);
    });

    it('rejects a malformed saved PID before looking up or closing any process', async () => {
        readFileSyncMock.mockReturnValue('4242-unrelated');
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'not-running' });
        expect(execFileAsyncMock).not.toHaveBeenCalled();
        expect(process.kill).not.toHaveBeenCalled();
    });

    it('backs up settings before closing OBS and again after its exit flushes changes', async () => {
        const order: string[] = [];
        createObsSettingsSnapshotMock.mockImplementation(async (_source, _target, reason) => {
            order.push(reason);
            return null;
        });
        execFileAsyncMock.mockImplementation(async (executable: string) => {
            if (executable !== 'tasklist') order.push('exit confirmed');
            return { stdout: '"obs64.exe","4242"', stderr: '' };
        });
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'closed', pid: 4242 });
        expect(order).toEqual(['before OBS shutdown', 'exit confirmed', 'after OBS shutdown']);
        expect(createObsSettingsSnapshotMock).toHaveBeenCalledWith(
            'C:\\test-gsm\\obs-studio\\config\\obs-studio',
            'C:\\test-gsm\\backup\\obs',
            'before OBS shutdown',
            {
                relatedFiles: [
                    { sourcePath: 'C:\\test-gsm\\config.json', snapshotPath: 'gsm/config.json' },
                    { sourcePath: 'C:\\test-gsm\\electron\\config.json', snapshotPath: 'gsm/electron-config.json' },
                ],
            }
        );
    });

    it('does not prevent a graceful close when a settings snapshot cannot be written', async () => {
        createObsSettingsSnapshotMock.mockRejectedValue(new Error('Backup disk is unavailable.'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { closeOBSFromElectron } = await loadObsModule();

        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'closed', pid: 4242 });
        expect(createObsSettingsSnapshotMock).toHaveBeenCalledTimes(2);
    });

    it('backs up existing settings before startup creates or repairs seed files', async () => {
        const order: string[] = [];
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === DEFAULT_OBS_PATH);
        createObsSettingsSnapshotMock.mockImplementation(async () => {
            order.push('snapshot');
            return null;
        });
        writeFileSyncMock.mockImplementation(() => { order.push('write'); });
        const { ensureObsInstalled } = await loadObsModule();

        await expect(ensureObsInstalled()).resolves.toBe('already-installed');
        expect(order[0]).toBe('snapshot');
        expect(order).toContain('write');
    });

    it('does not launch a second OBS instance when restart cannot close the first', async () => {
        existsSyncMock.mockImplementation((targetPath: string) => targetPath === DEFAULT_OBS_PATH);
        spawnMock.mockReturnValue({ pid: 4242, once: vi.fn(), unref: vi.fn() });
        const { launchOBSFromElectron, closeOBSFromElectron } = await loadObsModule();
        await expect(launchOBSFromElectron()).resolves.toEqual({ status: 'launched', pid: 4242 });
        execFileAsyncMock.mockRejectedValue(new Error('OBS is still saving.'));

        await expect(launchOBSFromElectron({ forceRestart: true })).resolves.toEqual({
            status: 'failed', pid: 4242, error: 'OBS is still saving.',
        });
        expect(spawnMock).toHaveBeenCalledOnce();
        expect(rmSyncMock).not.toHaveBeenCalledWith(OBS_PID_PATH, { force: true });

        execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
        await expect(closeOBSFromElectron()).resolves.toEqual({ status: 'closed', pid: 4242 });
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

    it('stores an in-house switch rule without restarting OBS when creating a window scene', async () => {
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
                if (requestType === 'CreateScene') {
                    return { sceneUuid: 'scene-my-game' };
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
                captureValues: {
                    game_capture: 'Game Window:WindowClass:game.exe',
                },
            });
            await expect(createScenePromise).resolves.toBeUndefined();
            expect(storeSetMock).toHaveBeenCalledWith(
                'windowSceneSwitcher',
                expect.objectContaining({
                    collections: [
                        expect.objectContaining({
                            collectionName: 'Collection 1',
                            rules: [
                                expect.objectContaining({
                                    sceneUuid: 'scene-my-game',
                                    sceneName: 'My Scene',
                                    titlePattern: '.*Game Window.*',
                                    executableName: 'game.exe',
                                    enabled: true,
                                    source: 'gsm-generated',
                                }),
                            ],
                        }),
                    ],
                })
            );
            expect(writeFileMock).not.toHaveBeenCalled();
            expect(sendQuitOBSMock).not.toHaveBeenCalled();
            expect(sendStartOBSMock).not.toHaveBeenCalled();
            expect(spawnMock).not.toHaveBeenCalled();
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

    it.each([true, false])('lists monitors with capture-card probing disabled (quick: %s)', async (quick) => {
        const { registerOBSIPC } = await loadObsModule();
        let monitorHelperCreated = false;
        obsCallMock.mockImplementation(async (requestType: string, requestData?: any) => {
            if (requestType === 'CreateInput' && requestData?.inputName === 'monitor_getter') {
                monitorHelperCreated = true;
            }
            if (requestType === 'GetSceneItemList' && requestData?.sceneName === 'GSM Helper - DONT TOUCH') {
                return { sceneItems: monitorHelperCreated ? [
                    { sceneItemId: 42, sourceName: 'monitor_getter', sceneItemEnabled: true },
                ] : [] };
            }
            if (requestType === 'GetInputPropertiesListPropertyItems' && requestData?.inputName === 'monitor_getter') {
                if (!monitorHelperCreated) throw new Error('No source was found');
                return { propertyItems: [
                    { itemName: 'Display 2: 2560x1440 @ 1920,0', itemValue: 'display-2', itemEnabled: true },
                ] };
            }
            return {};
        });
        await registerOBSIPC();
        const getWindows = ipcHandleMock.mock.calls.find(([channel]) => channel === 'obs.getWindows')![1];
        await expect(getWindows({}, { quick })).resolves.toEqual([
            {
                title: 'Display 2: 2560x1440 @ 1920,0',
                value: '["monitor","display-2"]', targetKind: 'monitor', monitorId: 'display-2',
            },
        ]);
        expect(obsCallMock).toHaveBeenCalledWith('GetInputPropertiesListPropertyItems', {
            inputName: 'monitor_getter', propertyName: 'monitor_id',
        });
        expect(obsCallMock).toHaveBeenCalledWith('CreateInput', {
            sceneName: 'GSM Helper - DONT TOUCH', inputName: 'monitor_getter',
            inputKind: 'monitor_capture', inputSettings: {}, sceneItemEnabled: false,
        });
        expect(obsCallMock).toHaveBeenCalledWith('SetSceneItemEnabled', {
            sceneName: 'GSM Helper - DONT TOUCH', sceneItemId: 42, sceneItemEnabled: false,
        });
        expect(buildCaptureCardOptionsMock).not.toHaveBeenCalled();
    });

    it('keeps windows available when OBS cannot create the monitor probe', async () => {
        const { registerOBSIPC } = await loadObsModule();
        const { mergeObsWindowItems } = await vi.importActual<typeof import('./obs-capture.js')>('./obs-capture.js');
        mergeObsWindowItemsMock.mockImplementation(mergeObsWindowItems);
        obsCallMock.mockImplementation(async (requestType: string, requestData?: any) => {
            if (requestType === 'GetInputPropertiesListPropertyItems') {
                if (requestData?.inputName === 'monitor_getter') {
                    throw new Error('No source was found');
                }
                if (requestData?.inputName === 'window_getter') {
                    return { propertyItems: [
                        { itemName: 'Window: Example Game', itemValue: 'Example Game:Class:game.exe' },
                    ] };
                }
            }
            if (requestType === 'CreateInput' && requestData?.inputName === 'monitor_getter') {
                throw new Error('Input kind is not supported');
            }
            return {};
        });
        await registerOBSIPC();
        const getWindows = ipcHandleMock.mock.calls.find(([channel]) => channel === 'obs.getWindows')![1];

        await expect(getWindows({}, { quick: true })).resolves.toEqual([
            expect.objectContaining({ title: 'Example Game', targetKind: 'window' }),
        ]);
    });

    it('rejects an invalid monitor before creating or replacing an OBS scene', async () => {
        const { buildWindowsSceneCaptureInputs } = await vi.importActual<typeof import('./obs-capture.js')>('./obs-capture.js');
        buildWindowsSceneCaptureInputsMock.mockImplementation(buildWindowsSceneCaptureInputs);
        const { registerOBSIPC } = await loadObsModule();
        await registerOBSIPC();
        const createScene = ipcHandleMock.mock.calls.find(([channel]) => channel === 'obs.createScene')![1];

        await createScene({}, { title: 'Display 2', sceneName: 'Existing Scene', targetKind: 'monitor' });

        for (const requestType of ['CreateScene', 'RemoveSceneItem', 'SetCurrentProgramScene', 'CreateInput']) {
            expect(obsCallMock).not.toHaveBeenCalledWith(requestType, expect.anything());
        }
    });

    it('creates and fits a monitor scene with default desktop audio without changing global audio or adding a window rule', async () => {
        const actualCapture = await vi.importActual<typeof import('./obs-capture.js')>('./obs-capture.js');
        buildWindowsSceneCaptureInputsMock.mockImplementation(actualCapture.buildWindowsSceneCaptureInputs);
        const { registerOBSIPC } = await loadObsModule();
        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'CreateScene') return { sceneUuid: 'scene-monitor' };
            if (requestType === 'GetInputSettings') throw new Error('No source was found');
            if (requestType === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080 };
            if (requestType === 'GetSceneItemList') return { sceneItems: [
                { sceneItemId: 3, sourceName: 'Freeflow - Monitor Capture', inputKind: 'monitor_capture' },
            ] };
            if (requestType === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Collection 1' };
            return {};
        });
        await registerOBSIPC();
        const createScene = ipcHandleMock.mock.calls.find(([channel]) => channel === 'obs.createScene')![1];
        await createScene({}, { title: 'Display 2', sceneName: 'Freeflow', targetKind: 'monitor', monitorId: 'display-2' });
        expect(obsCallMock).toHaveBeenCalledWith('CreateInput', {
            sceneName: 'Freeflow', inputName: 'Freeflow - Monitor Capture', inputKind: 'monitor_capture',
            inputSettings: { monitor_id: 'display-2', method: 0, capture_cursor: false }, sceneItemEnabled: true,
        });
        expect(obsCallMock).toHaveBeenCalledWith('CreateInput', {
            sceneName: 'Freeflow', inputName: 'Freeflow - Desktop Audio', inputKind: 'wasapi_output_capture',
            inputSettings: { device_id: 'default' }, sceneItemEnabled: true,
        });
        expect(obsCallMock).toHaveBeenCalledWith('SetSceneItemTransform', expect.objectContaining({
            sceneUuid: 'scene-monitor', sceneItemId: 3,
            sceneItemTransform: expect.objectContaining({ boundsWidth: 1920, boundsHeight: 1080, boundsType: 'OBS_BOUNDS_SCALE_INNER' }),
        }));
        expect(obsCallMock).not.toHaveBeenCalledWith('SetInputMute', expect.anything());
        expect(storeSetMock).not.toHaveBeenCalledWith('windowSceneSwitcher', expect.anything());
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

describe('Wayland PipeWire scene setup', () => {
    beforeEach(() => {
        obsCallMock.mockReset();
        obsConnectMock.mockReset();
        obsDisconnectMock.mockReset();
        obsOnMock.mockReset();
        obsRemoveAllListenersMock.mockReset();
        ipcHandleMock.mockReset();
        showMessageBoxMock.mockReset();
        showMessageBoxMock.mockResolvedValue({ response: 0, checkboxChecked: false });
        obsConnectMock.mockResolvedValue(undefined);
        obsDisconnectMock.mockResolvedValue(undefined);
        isLinuxMock.mockReturnValue(true);
        isWindowsMock.mockReturnValue(false);
        buildLinuxSceneCaptureInputsMock.mockReturnValue([
            {
                inputName: 'Wayland Game - Screen Capture (PipeWire)',
                inputKind: 'pipewire-screen-capture-source',
                inputSettings: { ShowCursor: false },
                sceneItemEnabled: true,
            },
        ]);
    });

    it('shows selector instructions after creating the PipeWire source', async () => {
        const { registerOBSIPC } = await loadObsModule();

        obsCallMock.mockImplementation(async (requestType: string) => {
            if (requestType === 'GetVersion') {
                return {};
            }
            if (requestType === 'CreateScene') {
                return { sceneUuid: 'scene-wayland' };
            }
            if (requestType === 'GetInputSettings') {
                throw new Error('No source was found');
            }
            return {};
        });

        await registerOBSIPC();
        const createSceneHandler = ipcHandleMock.mock.calls.find(
            ([channel]) => channel === 'obs.createScene'
        )?.[1];

        expect(createSceneHandler).toBeTypeOf('function');

        await expect(
            createSceneHandler({}, {
                title: 'Screen Capture (PipeWire)',
                value: 'pipewire-screen-capture-source',
                sceneName: 'Wayland Game',
                targetKind: 'wayland_pipewire',
                pipewireInputKind: 'pipewire-screen-capture-source',
            })
        ).resolves.toBeUndefined();

        expect(obsCallMock).toHaveBeenCalledWith('CreateInput', {
            sceneName: 'Wayland Game',
            inputName: 'Wayland Game - Screen Capture (PipeWire)',
            inputKind: 'pipewire-screen-capture-source',
            inputSettings: { ShowCursor: false },
            sceneItemEnabled: true,
        });
        expect(showMessageBoxMock).toHaveBeenCalledWith({
            type: 'info',
            title: 'Wayland Capture Setup',
            message: 'Select the game window in OBS',
            detail: [
                'The Screen Capture (PipeWire) source has been added to the new scene.',
                '',
                'In OBS:',
                '1. Click the Screen Capture (PipeWire) source.',
                '2. Click Properties.',
                '3. Click Open Selector.',
                '4. Select the actual window you want to capture.',
                '5. Optional: To remove a title bar or other edge content, press Ctrl+E, or right-click the source and choose Transform > Edit Transform. Adjust the Crop section at the bottom.',
                '',
                'Note: Cropping is not needed for fullscreen capture. Be careful when switching to fullscreen afterward—the cropped area may still remain cropped.',
            ].join('\n'),
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
