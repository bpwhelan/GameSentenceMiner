import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextHookUpdateManager } from './texthook_updates.js';

function setup() {
    let local = { installed: true, version: '1.0.0', remoteVersion: null, updateAvailable: false };
    let automatic = true;
    const candidate = { version: '2.0.0' };
    const deps = {
        localStatus: () => local,
        remoteStatus: vi.fn(async () => ({ ...local, remoteVersion: '2.0.0', updateAvailable: true })),
        prepare: vi.fn(async () => candidate),
        activate: vi.fn(async () => { local = { ...local, version: '2.0.0' }; }),
        discard: vi.fn(async () => {}),
        version: (value: typeof candidate) => value.version,
        isBusy: vi.fn(() => false),
        automaticEnabled: () => automatic,
        setAutomatic: (value: boolean) => { automatic = value; },
        onState: vi.fn(),
    };
    const manager = new TextHookUpdateManager(deps);
    return { manager, deps };
}

afterEach(() => vi.useRealTimers());

describe('automatic text hook updates', () => {
    it('automatically prepares a newer package and installs it while idle', async () => {
        const { manager, deps } = setup();
        await manager.check();
        await manager.waitForOperation();
        expect(deps.prepare).toHaveBeenCalledOnce();
        expect(deps.activate).toHaveBeenCalledOnce();
        expect(manager.getState()).toMatchObject({ version: '2.0.0', phase: 'idle', updateAvailable: false });
    });

    it('downloads in the background but waits until a hook stops before activation', async () => {
        const { manager, deps } = setup();
        deps.isBusy.mockReturnValue(true);
        await manager.check();
        await manager.waitForOperation();
        expect(deps.prepare).toHaveBeenCalledOnce();
        expect(deps.activate).not.toHaveBeenCalled();
        expect(manager.getState()).toMatchObject({ version: '1.0.0', phase: 'waiting', pendingVersion: '2.0.0' });
        deps.isBusy.mockReturnValue(false);
        manager.notifyIdle();
        await manager.waitForOperation();
        expect(deps.activate).toHaveBeenCalledOnce();
    });

    it('blocks new attachments only during final verification and activation', async () => {
        const { manager, deps } = setup();
        let finish!: () => void;
        deps.activate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
        await manager.check();
        await Promise.resolve();
        expect(manager.isInstalling()).toBe(true);
        finish();
        await manager.waitForOperation();
        expect(manager.isInstalling()).toBe(false);
    });

    it('respects automatic updates being disabled but allows a manual repair', async () => {
        const { manager, deps } = setup();
        manager.setAutomatic(false);
        await manager.check();
        expect(deps.prepare).not.toHaveBeenCalled();
        expect((await manager.download()).success).toBe(true);
        expect(deps.activate).toHaveBeenCalledOnce();
    });

    it('discards a queued automatic update if automatic updates are turned off', async () => {
        const { manager, deps } = setup();
        deps.isBusy.mockReturnValue(true);
        await manager.check();
        await manager.waitForOperation();
        manager.setAutomatic(false);
        await manager.waitForOperation();
        deps.isBusy.mockReturnValue(false);
        manager.notifyIdle();
        await manager.waitForOperation();
        expect(deps.activate).not.toHaveBeenCalled();
        expect(deps.discard).toHaveBeenCalledOnce();
    });

    it('keeps the installed version usable on a verification failure and supports retry', async () => {
        const { manager, deps } = setup();
        deps.prepare.mockRejectedValueOnce(new Error('hash mismatch'));
        await manager.check();
        await manager.waitForOperation();
        expect(deps.activate).not.toHaveBeenCalled();
        expect(manager.getState()).toMatchObject({ phase: 'error', installed: true, version: '1.0.0', error: 'hash mismatch' });
        expect((await manager.download()).success).toBe(true);
    });

    it('deduplicates manual and automatic requests', async () => {
        const { manager, deps } = setup();
        const [first, second] = await Promise.all([manager.download(), manager.download()]);
        expect(first.success && second.success).toBe(true);
        expect(deps.prepare).toHaveBeenCalledOnce();
        expect(deps.activate).toHaveBeenCalledOnce();
    });

    it('does not fetch engine binaries for someone who has never used hooking', async () => {
        const { manager, deps } = setup();
        deps.remoteStatus.mockResolvedValueOnce({ installed: false, version: '1.0.0', remoteVersion: '2.0.0', updateAvailable: false });
        await manager.check();
        await manager.waitForOperation();
        expect(deps.prepare).not.toHaveBeenCalled();
    });

    it('checks periodically without requiring the text hook tab to be opened', async () => {
        vi.useFakeTimers();
        const { manager, deps } = setup();
        manager.setAutomatic(false);
        manager.start();
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
        expect(deps.remoteStatus).toHaveBeenCalledTimes(2);
        manager.dispose();
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
        expect(deps.remoteStatus).toHaveBeenCalledTimes(2);
    });
});
