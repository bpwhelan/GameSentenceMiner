import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    handles: new Map<string, (...args: any[]) => any>(),
    monitor: { check: vi.fn(async () => {}), setTarget: vi.fn(), snapshot: vi.fn(), dismiss: vi.fn() },
    publisher: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => mocks.handles.set(channel, handler) } }));
vi.mock('./game_privileges.js', () => ({
    GAME_PRIVILEGE_CHECK_INTERVAL_MS: 30_000,
    gamePrivilegeMonitor: mocks.monitor,
    setGamePrivilegeWarningPublisher: mocks.publisher,
}));
import { refreshGamePrivilegeCapture, startGamePrivilegeChecks, stopGamePrivilegeChecks } from './game_privileges_runtime.js';

beforeEach(() => {
    vi.useFakeTimers();
    const testProcess = Object.create(process);
    Object.defineProperty(testProcess, 'platform', { value: 'win32' });
    vi.stubGlobal('process', testProcess);
});
afterEach(() => { stopGamePrivilegeChecks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('desktop privilege checks', () => {
    const webContents = { send: vi.fn(), isDestroyed: () => false };
    const window = {
        webContents, isDestroyed: () => false, isMinimized: vi.fn(() => true),
        restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    } as any;
    const getCapture = vi.fn(async () => ({ exeName: 'game.exe' }));
    const restartAsAdmin = vi.fn(async () => {});
    const closeNotification = vi.fn();
    const notifyWarning = vi.fn((_warning: unknown, _onClick: () => void) => closeNotification);
    const start = () => startGamePrivilegeChecks({ getMainWindow: () => window, getCapture, restartAsAdmin, notifyWarning });
    const publish = (warning: unknown) => mocks.publisher.mock.calls[0][0](warning);

    it('checks on startup, scene changes, and every 30 seconds, then stops cleanly', async () => {
        start();
        await vi.advanceTimersByTimeAsync(0);
        expect(getCapture).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(getCapture).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(getCapture).toHaveBeenCalledTimes(2);
        refreshGamePrivilegeCapture();
        await vi.advanceTimersByTimeAsync(0);
        expect(getCapture).toHaveBeenCalledTimes(3);
        stopGamePrivilegeChecks();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getCapture).toHaveBeenCalledTimes(3);
    });

    it('keeps elevation actions restricted to the main app and the current warning', async () => {
        start();
        mocks.monitor.snapshot.mockReturnValue({ id: 'current' });
        const restart = mocks.handles.get('game-privileges.restartAsAdmin')!;
        await expect(restart({ sender: {} }, 'current')).rejects.toThrow('Only the GSM desktop');
        await restart({ sender: webContents }, 'old');
        expect(restartAsAdmin).not.toHaveBeenCalled();
        await restart({ sender: webContents }, 'current');
        expect(restartAsAdmin).toHaveBeenCalledTimes(1);
    });

    it('notifies once per game process even if the warning clears and returns on a scene switch', () => {
        start();
        const warning = { id: 'dedup:session-1', pid: 123, exeName: 'game.exe' };
        publish(warning);
        publish(warning);
        expect(notifyWarning).toHaveBeenCalledTimes(1);
        expect(closeNotification).not.toHaveBeenCalled();
        publish(null);
        expect(closeNotification).toHaveBeenCalledTimes(1);
        publish(warning);
        expect(notifyWarning).toHaveBeenCalledTimes(1);
        expect(webContents.send).toHaveBeenLastCalledWith('game-privileges.warning', warning);
        publish({ ...warning, id: 'dedup:session-2' });
        expect(notifyWarning).toHaveBeenCalledTimes(2);
    });

    it('opens the main GSM warning when clicked without requesting elevation', () => {
        start();
        const warning = { id: 'click:session-1', pid: 123, exeName: 'game.exe' };
        mocks.monitor.snapshot.mockReturnValue(warning);
        publish(warning);
        expect(window.show).not.toHaveBeenCalled();
        const onClick = notifyWarning.mock.calls[0][1];
        onClick();
        expect(window.restore).toHaveBeenCalledTimes(1);
        expect(window.show).toHaveBeenCalledTimes(1);
        expect(window.focus).toHaveBeenCalledTimes(1);
        expect(restartAsAdmin).not.toHaveBeenCalled();
        mocks.monitor.snapshot.mockReturnValue(null);
        onClick();
        expect(window.show).toHaveBeenCalledTimes(1);
    });

    it('keeps the desktop warning working if native notifications fail', () => {
        start();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        notifyWarning.mockImplementationOnce(() => { throw new Error('Notifications disabled'); });
        const warning = { id: 'failed:session-1', pid: 123, exeName: 'game.exe' };
        expect(() => publish(warning)).not.toThrow();
        expect(webContents.send).toHaveBeenLastCalledWith('game-privileges.warning', warning);
        publish(warning);
        expect(notifyWarning).toHaveBeenCalledTimes(1);
    });

    it('closes the native notification during shutdown', () => {
        start();
        publish({ id: 'shutdown:session-1', pid: 123, exeName: 'game.exe' });
        stopGamePrivilegeChecks();
        expect(closeNotification).toHaveBeenCalledTimes(1);
    });
});
