import { describe, expect, it, vi } from 'vitest';
import { createMeikiModelService } from './meiki-ocr.js';

describe('Meiki OCR model settings', () => {
    it('uses the backend selection for both status and changes', async () => {
        const status = { model: 'large', available: true, busy: false, installed: ['large'] };
        const bus = { isConnected: vi.fn(() => true), request: vi.fn(async () => status) };
        const request = createMeikiModelService(bus);
        expect(await request()).toEqual(status);
        await request({ model: 'large' });
        expect(bus.request).toHaveBeenNthCalledWith(1, 'backend', 'ocr.meiki_model', {}, 5000);
        expect(bus.request).toHaveBeenNthCalledWith(2, 'backend', 'ocr.meiki_model', { model: 'large' }, 120000);
    });
    it('rejects invalid choices and offline changes without queueing them', async () => {
        const bus = { isConnected: () => false, request: vi.fn() };
        const request = createMeikiModelService(bus);
        await expect(request({ model: '../other' })).rejects.toThrow('model size');
        await expect(request({ model: 'large' })).rejects.toThrow('not connected');
        expect(bus.request).not.toHaveBeenCalled();
    });
});
