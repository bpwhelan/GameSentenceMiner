import { describe, expect, it, vi } from 'vitest';
import { createVitaModelService } from './vita-ocr.js';

describe('Vita OCR model settings', () => {
    it('uses the backend selection for both status and changes', async () => {
        const status = { model: 'normal', available: true, busy: false, installed: ['normal'] };
        const bus = { isConnected: vi.fn(() => true), request: vi.fn(async () => status) };
        const request = createVitaModelService(bus);
        expect(await request()).toEqual(status);
        await request({ model: 'large' });
        expect(bus.request).toHaveBeenNthCalledWith(1, 'backend', 'ocr.vita_model', {}, 5000);
        expect(bus.request).toHaveBeenNthCalledWith(2, 'backend', 'ocr.vita_model', { model: 'large' }, 300000);
    });
    it('rejects invalid choices and offline changes without queueing them', async () => {
        const bus = { isConnected: () => false, request: vi.fn() };
        const request = createVitaModelService(bus);
        await expect(request({ model: '../other' })).rejects.toThrow('model size');
        await expect(request({ model: 'large' })).rejects.toThrow('not connected');
        expect(bus.request).not.toHaveBeenCalled();
    });
    it('silently skips status checks until the backend connects', async () => {
        const status = { model: 'large', available: true, busy: false, installed: ['large'] };
        const bus = { isConnected: vi.fn(() => false), request: vi.fn(async () => status) };
        const request = createVitaModelService(bus);
        await expect(request()).resolves.toBeNull();
        await expect(request({})).resolves.toBeNull();
        expect(bus.request).not.toHaveBeenCalled();

        bus.isConnected.mockReturnValue(true);
        await expect(request()).resolves.toEqual(status);
        expect(bus.request).toHaveBeenCalledExactlyOnceWith('backend', 'ocr.vita_model', {}, 5000);
    });
    it('still reports backend request failures when connected', async () => {
        const bus = { isConnected: () => true, request: vi.fn().mockRejectedValue(new Error('Model status failed')) };
        await expect(createVitaModelService(bus)()).rejects.toThrow('Model status failed');
    });
});
