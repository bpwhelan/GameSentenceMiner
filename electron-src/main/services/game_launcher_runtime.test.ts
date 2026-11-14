import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    handles: new Map<string, (...args: any[]) => any>(),
    profiles: {} as Record<string, unknown>,
    getWindows: vi.fn(), getName: vi.fn(), getTitle: vi.fn(), getScene: vi.fn(), browse: vi.fn(), launch: vi.fn(),
    stat: vi.fn(), readdir: vi.fn(), quit: vi.fn(), yuzu: {} as Record<string, unknown>,
}));
vi.mock('electron', () => ({
    app: { once: (_event: string, callback: () => void) => mocks.quit.mockImplementation(callback) },
    dialog: { showOpenDialog: mocks.browse },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handles.set(name, handler) },
}));
vi.mock('../runtime/windows_game_launcher.js', () => ({ launchGameAsUser: mocks.launch }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, readdir: mocks.readdir }));
vi.mock('../store.js', () => ({ store: {
    get: (key: string) => key === 'yuzu' ? mocks.yuzu : mocks.profiles,
    set: (_key: string, value: Record<string, unknown>) => { mocks.profiles = value; },
} }));
vi.mock('../ui/obs.js', () => ({ getCurrentScene: mocks.getScene, getExecutableNameFromSource: mocks.getName, getWindowTitleFromSource: mocks.getTitle }));
vi.mock('../runtime/capture_windows.js', () => ({ listCaptureWindows: mocks.getWindows }));

import { registerGameLauncherIPC } from './game_launcher_runtime.js';

const game = 'C:\\Games\\月姫\\game.exe';
const call = (channel: string, ...args: unknown[]) => mocks.handles.get(`game-launcher.${channel}`)!({}, ...args);
const originalPlatform = process.platform;

describe('game launcher IPC integration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mocks.profiles = {};
        mocks.yuzu = {};
        mocks.launch.mockReset().mockResolvedValue(1234);
        mocks.handles.clear();
        mocks.getName.mockResolvedValue('game.exe');
        mocks.getTitle.mockResolvedValue('月姫');
        mocks.getScene.mockResolvedValue({ id: 'scene-a', name: 'Game' });
        mocks.getWindows.mockReturnValue([{ path: game, title: '月姫' }]);
        mocks.stat.mockResolvedValue({ isFile: () => true, isDirectory: () => true });
    });
    afterEach(() => {
        mocks.quit();
        vi.useRealTimers();
        Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('remembers the captured path in the background, independently of the Home tab', async () => {
        registerGameLauncherIPC();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mocks.profiles['scene-a']).toEqual(expect.objectContaining({ executablePath: game }));
        mocks.getWindows.mockReturnValue([]);
        expect((await call('getOptions', 'scene-a')).executablePath).toBe(game);
        expect(await call('detect', 'scene-a')).toBeNull();
    });

    it('offers a manual fallback if the native window discovery is unavailable, and handles a cancelled file picker', async () => {
        mocks.getWindows.mockImplementation(() => { throw new Error('Window discovery unavailable'); });
        mocks.browse.mockResolvedValue({ canceled: true, filePaths: [] });
        registerGameLauncherIPC();
        expect((await call('getOptions', 'scene-a')).executablePath).toBe('');
        expect(await call('browse', 'executable')).toBeNull();
        expect(await call('save', 'scene-a', { executablePath: game })).toEqual({ success: true });
        expect((await call('getOptions', 'scene-a')).executablePath).toBe(game);
    });

    it('returns a structured Windows error instead of reporting a failed spawn as successful', async () => {
        mocks.launch.mockRejectedValue(new Error('Access denied'));
        registerGameLauncherIPC();
        expect(await call('launch', 'scene-a')).toEqual({ success: false, code: 'failed', error: 'Access denied' });
    });

    it('reuses an existing scene-linked Yuzu ROM and launches it as the desktop user', async () => {
        mocks.yuzu = { emuPath: 'C:\\Yuzu\\yuzu.exe', romsPath: 'D:\\ROMs', games: [{ id: '0100ABCD', scene: { id: 'scene-a' } }] };
        mocks.readdir.mockResolvedValue([{ name: '月姫 [0100abcd].nsp', isFile: () => true }]);
        registerGameLauncherIPC();
        expect(await call('getOptions', 'scene-a')).toMatchObject({ mode: 'yuzu', executablePath: 'C:\\Yuzu\\yuzu.exe', romPath: 'D:\\ROMs\\月姫 [0100abcd].nsp' });
        expect(await call('launch', 'scene-a')).toEqual({ success: true });
        expect(mocks.launch).toHaveBeenCalledWith({ executable: 'C:\\Yuzu\\yuzu.exe', args: ['-g', 'D:\\ROMs\\月姫 [0100abcd].nsp'], cwd: 'C:\\Yuzu' });
    });

    it('does not guess between duplicate ROMs and offers a ROM file picker', async () => {
        mocks.yuzu = { emuPath: 'C:\\Yuzu\\yuzu.exe', romsPath: 'D:\\ROMs', games: [{ id: '0100ABCD', scene: { id: 'scene-a' } }] };
        mocks.readdir.mockResolvedValue(['a', 'b'].map(name => ({ name: `${name} [0100ABCD].nsp`, isFile: () => true })));
        mocks.browse.mockResolvedValue({ canceled: false, filePaths: ['D:\\ROMs\\chosen.xci'] });
        registerGameLauncherIPC();
        expect((await call('getOptions', 'scene-a')).mode).toBe('executable');
        expect(await call('browse', 'rom')).toBe('D:\\ROMs\\chosen.xci');
        expect(mocks.browse).toHaveBeenCalledWith(expect.objectContaining({ filters: expect.arrayContaining([
            expect.objectContaining({ extensions: ['nsp', 'xci', 'nca', 'nro', 'nso'] }),
        ]) }));
    });

    it('rejects launch, save and picker requests on other platforms without probing windows', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        registerGameLauncherIPC();
        expect(await call('launch', 'scene-a')).toEqual(expect.objectContaining({ success: false, code: 'unsupported' }));
        expect(await call('save', 'scene-a', {})).toEqual(expect.objectContaining({ success: false, code: 'unsupported' }));
        await expect(call('browse', 'directory')).rejects.toThrow('unsupported');
        expect(mocks.getWindows).not.toHaveBeenCalled();
    });
});
