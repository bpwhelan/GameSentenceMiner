import { afterEach, describe, expect, it, vi } from 'vitest';
import { GamePrivilegeMonitor } from './game_privileges.js';

const game = { pid: 123, exeName: 'game.exe', startedAt: 'session-1', elevated: true };
const result = (overrides = {}) => ({ gsmElevated: false, processes: [game], ...overrides });

afterEach(() => vi.useRealTimers());

describe('game privilege warnings', () => {
    function setup(platform: NodeJS.Platform = 'win32') {
        const probe = vi.fn().mockResolvedValue(result());
        const publish = vi.fn();
        const monitor = new GamePrivilegeMonitor({ probe, publish, platform });
        return { monitor, probe, publish };
    }

    it('checks immediately when capture is identified and throttles repeated discoveries and focus events', async () => {
        vi.useFakeTimers();
        const { monitor, probe, publish } = setup();
        monitor.setTarget('capture', { exeName: 'game.exe' });
        await monitor.check();
        expect(monitor.snapshot()).toMatchObject({ exeName: 'game.exe', pid: 123 });
        expect(publish).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 10; ++i) {
            monitor.setTarget('capture', { exeName: 'game.exe' });
            monitor.handleForeground({ pid: 123, executableName: 'game.exe' });
            await monitor.check();
        }
        expect(probe).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30_000);
        await monitor.check();
        expect(probe).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenCalledTimes(1);
    });

    it('checks a newly focused game process immediately without probing unrelated admin apps', async () => {
        const { monitor, probe } = setup();
        probe.mockResolvedValueOnce(result({ processes: [] }));
        monitor.setTarget('capture', { exeName: 'game.exe' });
        await monitor.check();
        monitor.handleForeground({ pid: 999, executableName: 'other.exe' });
        await monitor.check();
        expect(probe).toHaveBeenCalledTimes(1);
        monitor.handleForeground({ pid: 123, executableName: 'GAME.EXE' });
        await monitor.check();
        expect(probe).toHaveBeenCalledTimes(2);
        expect(monitor.snapshot()?.pid).toBe(123);
    });

    it.each([
        result({ gsmElevated: true }),
        result({ gsmElevated: null }),
        result({ processes: [{ ...game, elevated: false }] }),
        result({ processes: [{ ...game, elevated: null }] }),
        result({ processes: [] }),
    ])('requires confirmed elevation mismatch: %j', async (value) => {
        const { monitor, probe, publish } = setup();
        probe.mockResolvedValue(value);
        monitor.setTarget('texthook', { exeName: 'game.exe', pid: 123 });
        await monitor.check();
        expect(monitor.snapshot()).toBeNull();
        expect(publish).not.toHaveBeenCalled();
    });

    it('remembers dismissal for that process across polls and scene switches, but warns for a new run', async () => {
        vi.useFakeTimers();
        const { monitor, probe } = setup();
        monitor.setTarget('capture', { exeName: 'game.exe' });
        await monitor.check();
        const warning = monitor.snapshot()!;
        monitor.dismiss(warning.id);
        monitor.setTarget('capture', null);
        monitor.setTarget('capture', { exeName: 'game.exe' });
        await vi.advanceTimersByTimeAsync(30_000);
        await monitor.check();
        expect(monitor.snapshot()).toBeNull();
        probe.mockResolvedValue(result({ processes: [{ ...game, startedAt: 'session-2' }] }));
        await vi.advanceTimersByTimeAsync(30_000);
        await monitor.check();
        expect(monitor.snapshot()?.id).not.toBe(warning.id);
    });

    it('clears resolved warnings and ignores stale dismissals', async () => {
        vi.useFakeTimers();
        const { monitor, probe } = setup();
        monitor.setTarget('capture', { exeName: 'game.exe' });
        await monitor.check();
        monitor.dismiss('old-warning');
        expect(monitor.snapshot()).not.toBeNull();
        probe.mockResolvedValue(result({ processes: [] }));
        await vi.advanceTimersByTimeAsync(30_000);
        await monitor.check();
        expect(monitor.snapshot()).toBeNull();
    });

    it('coalesces probes and discards a result if the selected game changes while checking', async () => {
        const { monitor, probe } = setup();
        let resolve!: (value: unknown) => void;
        probe.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        monitor.setTarget('capture', { exeName: 'game.exe' });
        const first = monitor.check();
        monitor.setTarget('capture', { exeName: 'new.exe' });
        probe.mockResolvedValue(result({ processes: [{ ...game, exeName: 'new.exe', pid: 456 }] }));
        const second = monitor.check();
        expect(probe).toHaveBeenCalledTimes(1);
        resolve(result());
        await Promise.all([first, second]);
        expect(monitor.snapshot()?.exeName).toBe('new.exe');
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('treats failed probes as unknown and retries only after the interval', async () => {
        const { monitor, probe } = setup();
        probe.mockRejectedValue(new Error('Access denied'));
        monitor.setTarget('capture', { exeName: 'game.exe' });
        await monitor.check();
        await monitor.check();
        expect(monitor.snapshot()).toBeNull();
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('does no work on unsupported systems or without a game target', async () => {
        const windows = setup();
        await windows.monitor.check();
        expect(windows.probe).not.toHaveBeenCalled();
        const linux = setup('linux');
        linux.monitor.setTarget('capture', { exeName: 'game.exe' });
        await linux.monitor.check();
        expect(linux.probe).not.toHaveBeenCalled();
    });

    it('stops querying tokens once GSM itself is confirmed elevated', async () => {
        vi.useFakeTimers();
        const { monitor, probe } = setup();
        probe.mockResolvedValue(result({ gsmElevated: true }));
        monitor.setTarget('capture', { exeName: 'game.exe' });
        await monitor.check();
        await vi.advanceTimersByTimeAsync(60_000);
        monitor.setTarget('texthook', { exeName: 'another.exe', pid: 456 });
        await monitor.check();
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('keeps the exact hook target when another process with the same executable is focused', async () => {
        const { monitor, probe } = setup();
        monitor.setTarget('texthook', { exeName: 'game.exe', pid: 123 });
        await monitor.check();
        monitor.handleForeground({ executableName: 'game.exe', pid: 456 });
        await monitor.check();
        expect(probe).toHaveBeenCalledTimes(1);
        expect(monitor.snapshot()?.pid).toBe(123);
    });
});
