import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => any>(),
    post: vi.fn(), get: vi.fn(), set: vi.fn(), start: vi.fn(), stop: vi.fn(), wait: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) } }));
vi.mock('axios', () => ({ default: { post: mocks.post, isAxiosError: (error: any) => error?.isAxiosError === true } }));
vi.mock('../store.js', () => ({ store: { get: mocks.get, set: mocks.set }, getLocale: () => 'en' }));
vi.mock('../gsm_config.js', () => ({ getConfiguredTargetLanguage: () => 'ja', gsmBackendUrl: (path: string) => `http://localhost:7272${path}` }));
vi.mock('../ui/front.js', () => ({ runOverlay: mocks.start, stopOverlay: mocks.stop, waitForOverlayShutdown: mocks.wait }));
import { registerOnboardingIPC } from './onboarding.js';

describe('desktop onboarding bridge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.start.mockResolvedValue(true);
        mocks.wait.mockResolvedValue(undefined);
        mocks.post.mockResolvedValue({ data: { reader: 'yomitan', installed: [], busy: false } });
        registerOnboardingIPC();
    });
    afterEach(() => vi.useRealTimers());
    const invoke = (name: string, value?: unknown) => mocks.handlers.get(`settings.onboarding.${name}`)!(null, value);

    it('persists guide completion without changing the dependency installer flag', () => {
        invoke('save', { step: 'finish', status: 'completed', version: 2 });
        expect(mocks.set.mock.calls).toEqual([
            ['onboarding', { step: 'finish', status: 'completed', version: 2 }],
            ['setupWizardVersion', 2],
        ]);
        expect(() => invoke('save', { step: 'invalid', status: 'completed' })).toThrow();
        expect(mocks.set).toHaveBeenCalledTimes(2);
    });

    it('keeps dictionary status reads from restarting a running overlay', async () => {
        await invoke('dictionary', { action: 'status' });
        expect(mocks.start).toHaveBeenCalledOnce();
        expect(mocks.stop).not.toHaveBeenCalled();
    });

    it('waits for shutdown before relaunching a changed reader', async () => {
        mocks.post.mockResolvedValueOnce({ data: { restarting: true } });
        let finishShutdown!: () => void;
        mocks.wait.mockReturnValueOnce(new Promise<void>(resolve => { finishShutdown = resolve; }));
        const request = invoke('dictionary', { action: 'select', reader: 'hachidori' });
        await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce());
        expect(mocks.stop).toHaveBeenCalledOnce();
        expect(mocks.start).toHaveBeenCalledOnce();
        finishShutdown();
        await request;
        expect(mocks.start).toHaveBeenCalledTimes(2);
    });

    it('retries startup readiness but surfaces actual installation errors', async () => {
        vi.useFakeTimers();
        mocks.post.mockRejectedValueOnce({ isAxiosError: true, response: { data: { code: 'overlay_starting' } } });
        const request = invoke('dictionary', { action: 'install' });
        await vi.runAllTimersAsync();
        await request;
        expect(mocks.post).toHaveBeenCalledTimes(2);
        mocks.post.mockRejectedValueOnce(new Error('import failed'));
        await expect(invoke('dictionary', { action: 'install' })).rejects.toThrow('import failed');
        expect(mocks.post).toHaveBeenCalledTimes(3);
    });

    it('does not submit a dictionary action when the overlay cannot start', async () => {
        mocks.start.mockResolvedValueOnce(false);
        await expect(invoke('dictionary', { action: 'install' })).rejects.toThrow('could not start');
        expect(mocks.post).not.toHaveBeenCalled();
    });
});
