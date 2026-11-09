import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    handles: new Map<string, (...args: any[]) => any>(),
    profiles: {} as Record<string, unknown>,
    getWindows: vi.fn(), getName: vi.fn(), getTitle: vi.fn(), getScene: vi.fn(), browse: vi.fn(), spawn: vi.fn(),
    stat: vi.fn(), quit: vi.fn(),
}));
vi.mock('electron', () => ({
    app: { once: (_event: string, callback: () => void) => mocks.quit.mockImplementation(callback) },
    dialog: { showOpenDialog: mocks.browse },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handles.set(name, handler) },
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }));
vi.mock('../store.js', () => ({ store: {
    get: () => mocks.profiles,
    set: (_key: string, value: Record<string, unknown>) => { mocks.profiles = value; },
} }));
vi.mock('../ui/obs.js', () => ({ getCurrentScene: mocks.getScene, getExecutableNameFromSource: mocks.getName, getWindowTitleFromSource: mocks.getTitle }));
vi.mock('node-window-manager', () => ({ windowManager: { getWindows: mocks.getWindows } }));

import { registerGameLauncherIPC } from './game_launcher_runtime.js';

const game = 'C:\\Games\\月姫\\game.exe';
const call = (channel: string, ...args: unknown[]) => mocks.handles.get(`game-launcher.${channel}`)!({}, ...args);
const originalPlatform = process.platform;

describe('game launcher IPC integration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mocks.profiles = {};
        mocks.handles.clear();
        mocks.getName.mockResolvedValue('game.exe');
        mocks.getTitle.mockResolvedValue('月姫');
        mocks.getScene.mockResolvedValue({ id: 'scene-a', name: 'Game' });
        mocks.getWindows.mockReturnValue([{ path: game, getTitle: () => '月姫' }]);
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

    it('offers a manual fallback if the Windows addon is unavailable, and handles a cancelled file picker', async () => {
        mocks.getWindows.mockImplementation(() => { throw new Error('Addon unavailable'); });
        mocks.browse.mockResolvedValue({ canceled: true, filePaths: [] });
        registerGameLauncherIPC();
        expect((await call('getOptions', 'scene-a')).executablePath).toBe('');
        expect(await call('browse', 'executable')).toBeNull();
        expect(await call('save', 'scene-a', { executablePath: game })).toEqual({ success: true });
        expect((await call('getOptions', 'scene-a')).executablePath).toBe(game);
    });

    it('returns a structured Windows error instead of reporting a failed spawn as successful', async () => {
        mocks.spawn.mockImplementation(() => {
            const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
            Promise.resolve().then(() => child.emit('error', new Error('Access denied')));
            return child;
        });
        registerGameLauncherIPC();
        expect(await call('launch', 'scene-a')).toEqual({ success: false, code: 'failed', error: 'Access denied' });
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
