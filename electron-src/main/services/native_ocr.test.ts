import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeOcrService } from './native_ocr.js';

const setup = () => {
    const deps = {
        call: vi.fn(async (_message: any) => ({ paused: false })),
        context: vi.fn(async () => ({ scene: 'Game', target_id: 42, available: true })),
        configuration: vi.fn(async () => ({ profile: 'test', settings: { ocr1: 'screenai', ocr2: 'screenai', manualOcrHotkey: 'Ctrl+G' } })),
        ingest: vi.fn(async (_data: any) => ({ status: 'accepted' })),
        emit: vi.fn(), state: vi.fn(), register: vi.fn(() => true), unregister: vi.fn(), addArea: vi.fn(async () => {}),
    };
    return { deps, service: createNativeOcrService(deps) };
};
afterEach(() => vi.useRealTimers());

describe('native OCR lifecycle and text ingress', () => {
    it.each(['Ctrl+G', 'Alt+Shift+G', 'Cmd+G', 'Super+G', ...Array.from({ length: 12 }, (_, i) => `F${i + 13}`)])('routes %s to Rust without reserving the OS key', async (key) => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        deps.configuration.mockResolvedValue({ profile: 'test', settings: { ocr1: 'screenai', ocr2: 'screenai', manualOcrHotkey: key } });
        await service.start('manual');
        expect(deps.register).not.toHaveBeenCalled();
        expect(deps.call).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ settings: expect.objectContaining({ manualOcrHotkey: key }) }) }));
        await service.stop();
    });
    it.each(['`', '~', 'Shift+~', 'Shift+A', 'F8', 'Space'])('never reserves %s as an OS global shortcut', async (key) => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        deps.configuration.mockResolvedValue({ profile: 'test', settings: { ocr1: 'screenai', ocr2: 'screenai', manualOcrHotkey: key } });
        await service.start('manual');
        expect(deps.register).not.toHaveBeenCalled();
        expect(deps.call).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ settings: expect.objectContaining({ manualOcrHotkey: key }) }) }));
        await service.stop();
    });
    it('updates Rust bindings when changed from a modified to a plain key', async () => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        await service.start('manual');
        deps.configuration.mockResolvedValue({ profile: 'test', settings: { ocr1: 'screenai', ocr2: 'screenai', manualOcrHotkey: '`' } });
        deps.register.mockClear();
        await service.reload();
        expect(deps.call).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'configure', config: expect.objectContaining({ settings: expect.objectContaining({ manualOcrHotkey: '`' }) }) }));
        expect(deps.register).not.toHaveBeenCalled();
        await service.stop();
    });
    it('passes formerly-fallback features to Rust without substituting engines', async () => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        deps.configuration.mockResolvedValue({ profile: 'test', settings: { ocr1: 'meiki_text_detector', ocr2: 'bing', manualOcrHotkey: '', gamepadHotkeysEnabled: true, manualOcrGamepad: 'LB+A', advancedMode: true, ocr_screenshots: true, compactBoxes: true }, areas: { rectangles: [{ is_exclusive: true }, { is_black_hole: true }] }, replacements: [['re:(?<=日)本', '本']] } as any);
        await service.start('auto');
        expect(deps.call).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', config: expect.objectContaining({ settings: expect.objectContaining({ ocr2: 'bing', compactBoxes: true, ocr_screenshots: true }) }) }));
        await service.stop();
    });
    it('waits for native stop acknowledgement and rejects obsolete results', async () => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        await service.start('auto');
        const oldSession = deps.call.mock.calls[0][0].session;
        service.receive({ session: oldSession, event: 'ocr_result', data: { text: '日本語', observationId: 'one' } });
        await Promise.resolve(); await Promise.resolve();
        expect(deps.ingest).toHaveBeenCalledTimes(1);
        await service.stop();
        expect(deps.call).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'stop' }));
        expect(service.running).toBe(false);
        await service.start('manual');
        service.receive({ session: oldSession, event: 'ocr_result', data: { text: 'stale' } });
        expect(deps.ingest).toHaveBeenCalledTimes(1);
        expect(deps.call.mock.calls.find(([call]) => call.action === 'stop')).toBeDefined();
        await service.stop();
    });
    it('does not claim shutdown succeeded when an inference fails to stop', async () => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        await service.start('auto');
        deps.call.mockRejectedValueOnce(Error('still finishing inference'));
        await expect(service.stop()).rejects.toThrow('still finishing');
        expect(service.running).toBe(true);
        expect(deps.state).not.toHaveBeenCalledWith(false);
        await service.stop();
    });
    it('resolves the new scene areas before refreshing capture identity', async () => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        await service.start('auto');
        deps.context.mockResolvedValue({ scene: 'New game', target_id: 43, available: true });
        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.configuration).toHaveBeenLastCalledWith(expect.objectContaining({ scene: 'New game' }));
        expect(deps.call).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'configure', config: expect.objectContaining({ scene: 'New game', target_id: 43 }) }));
        await service.stop();
        const calls = deps.context.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10000);
        expect(deps.context).toHaveBeenCalledTimes(calls);
    });
    it('logs a context retry and reports when automatic scanning resumes', async () => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        const scanning = { paused: false, auto_activity: 'scanning' };
        const filtered = { paused: false, auto_activity: 'furigana_filtered' };
        deps.call.mockResolvedValueOnce(scanning);
        await service.start('auto');
        deps.emit.mockClear();

        deps.context.mockRejectedValueOnce(new Error('Capture context timed out'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.emit).toHaveBeenCalledWith('log', expect.objectContaining({ message: expect.stringContaining('Capture context timed out') }));
        expect(deps.emit).not.toHaveBeenCalledWith('error', expect.anything());

        deps.call.mockResolvedValue(filtered);
        await vi.advanceTimersByTimeAsync(2000);
        expect(deps.emit.mock.calls.filter(([event]) => event === 'status')).toEqual([['status', filtered]]);
        await service.stop();
    });
    it('keeps OBS sources and advanced configuration on the Rust worker', async () => {
        vi.useFakeTimers();
        const { service, deps } = setup();
        await service.start('auto');
        deps.context.mockResolvedValue({ scene: 'Video source', target_id: 0, available: false, capture_kind: 'obs' } as any);
        await vi.advanceTimersByTimeAsync(1000);
        expect(service.running).toBe(true);
        expect(deps.call).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'configure', config: expect.objectContaining({ capture_kind: 'obs' }) }));
        await service.stop();
    });
});
