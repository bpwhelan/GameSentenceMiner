import { describe, expect, it, vi } from 'vitest';
import { GameBackgroundService } from './game_background.js';
import { chooseGameBackgroundTarget, normalizeGameBackgroundOptions, type GameBackgroundTarget } from '../../shared/game_background.js';

const target: GameBackgroundTarget = { pid: 123, hwnd: '456', path: 'C:\\Games\\game.exe', title: 'Game', arch: 'x64', specialK: false };
function setup() {
    let current: GameBackgroundTarget | undefined = target;
    const profiles = new Map<string, ReturnType<typeof normalizeGameBackgroundOptions>>();
    const stop = vi.fn(async () => undefined);
    const configure = vi.fn();
    let emit: (message: any) => void = () => undefined;
    let exit: (error?: string) => void = () => undefined;
    const launch = vi.fn((_target, _options, onStatus, onExit) => {
        emit = onStatus; exit = onExit;
        return { configure, stop };
    });
    const service = new GameBackgroundService({
        resolve: async () => ({ sceneId: 'scene', target: current, reason: current ? undefined : 'notRunning' }),
        load: path => profiles.get(path) ?? normalizeGameBackgroundOptions(undefined),
        save: (path, value) => { profiles.set(path, value); },
        launch,
    });
    return { service, launch, stop, configure, emit: (x: any) => emit(x), exit: (x?: string) => exit(x),
        current: (value: GameBackgroundTarget | undefined) => { current = value; } };
}
const enabled = { enabled: true, keepRendering: true, blockGamepad: true };
describe('game background hooks', () => {
    it('defaults to explicit per-game opt-in and refuses ambiguous windows', () => {
        expect(normalizeGameBackgroundOptions(null).enabled).toBe(false);
        expect(normalizeGameBackgroundOptions({ enabled: 'true' }).enabled).toBe(false);
        expect(normalizeGameBackgroundOptions({ ...enabled, keepRendering: false, blockGamepad: false }).enabled).toBe(false);
        expect(chooseGameBackgroundTarget([target, { ...target, pid: 8 }], 'Game')).toBeUndefined();
    });
    it('does not inject before opt-in, attaches once and updates both options live', async () => {
        const x = setup();
        await x.service.refresh();
        expect(x.launch).not.toHaveBeenCalled();
        await x.service.save('scene', target, enabled);
        await x.service.refresh();
        expect(x.launch).toHaveBeenCalledTimes(1);
        x.emit({ effective: 3, inputHooks: 2, errors: 0 });
        expect(x.service.snapshot().phase).toBe('active');
        await x.service.save('scene', target, { ...enabled, keepRendering: false });
        expect(x.configure).toHaveBeenLastCalledWith({ ...enabled, keepRendering: false });
        await x.service.save('scene', target, { ...enabled, enabled: false });
        expect(x.stop).toHaveBeenCalledTimes(1);
    });
    it('rejects a stale UI target before saving or injecting', async () => {
        const x = setup();
        x.current({ ...target, pid: 999 });
        await expect(x.service.save('scene', target, enabled)).rejects.toThrow(/changed/);
        expect(x.launch).not.toHaveBeenCalled();
    });
    it('remembers only the opted-in executable and follows its new process after relaunch', async () => {
        const x = setup();
        await x.service.save('scene', target, enabled);
        x.current({ ...target, pid: 99, path: 'C:\\Other\\game.exe' });
        await x.service.refresh();
        expect(x.stop).toHaveBeenCalledTimes(1);
        expect(x.launch).toHaveBeenCalledTimes(1);
        x.current({ ...target, pid: 456 });
        await x.service.refresh();
        expect(x.launch).toHaveBeenCalledTimes(2);
    });
    it('will not stack hooks on Special K', async () => {
        const x = setup();
        x.current({ ...target, specialK: true });
        await x.service.save('scene', target, enabled);
        expect(x.launch).not.toHaveBeenCalled();
        expect(x.service.snapshot().reason).toBe('specialK');
    });
    it('stops on target loss and latches failures until an explicit retry', async () => {
        const x = setup();
        await x.service.save('scene', target, enabled);
        x.exit('injection failed');
        await x.service.refresh();
        expect(x.launch).toHaveBeenCalledTimes(1);
        expect(x.service.snapshot().error).toBe('injection failed');
        await x.service.save('scene', target, enabled);
        expect(x.launch).toHaveBeenCalledTimes(2);
        x.current(undefined);
        await x.service.refresh();
        expect(x.stop).toHaveBeenCalled();
    });
    it('serializes polling with shutdown and prevents later attachments', async () => {
        const x = setup();
        await x.service.save('scene', target, enabled);
        await x.service.shutdown();
        await x.service.refresh();
        expect(x.stop).toHaveBeenCalledTimes(1);
        expect(x.launch).toHaveBeenCalledTimes(1);
    });
    it('coalesces slow polls instead of building a shutdown-blocking queue', async () => {
        const x = setup();
        const first = x.service.refresh();
        expect(x.service.refresh()).toBe(first);
        await first;
        expect(x.service.refresh()).not.toBe(first);
    });
    it('ignores old helper events after reattaching to the same game', async () => {
        const x = setup();
        await x.service.save('scene', target, enabled);
        const [, , oldStatus, oldExit] = x.launch.mock.calls[0];
        await x.service.save('scene', target, { ...enabled, enabled: false });
        await x.service.save('scene', target, enabled);
        oldStatus({ effective: 3 });
        oldExit('old controller failure');
        expect(x.service.snapshot().phase).toBe('attaching');
        expect(x.service.snapshot().error).toBeUndefined();
    });
});
