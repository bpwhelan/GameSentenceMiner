import { describe, expect, it, vi } from 'vitest';
import { createGpuService } from './gpu.js';

describe('GPU settings service', () => {
    it('sends validated explicit preferences to the connected backend', async () => {
        const status = { settings: { meiki: true }, diagnostics: {} };
        const bus = { isConnected: () => true, request: vi.fn(async () => status) };
        expect(await createGpuService(bus)({ settings: { meiki: true } })).toBe(status);
        expect(bus.request).toHaveBeenCalledWith('backend', 'gpu.settings', { settings: { meiki: true }, refresh: false }, 15000);
    });
    it.each([{ settings: { meiki: 'false' } }, { settings: [] }, { settings: { unknown: true } }])('rejects invalid settings', async (request) => {
        const bus = { isConnected: () => true, request: vi.fn() };
        await expect(createGpuService(bus)(request)).rejects.toThrow('Invalid GPU');
        expect(bus.request).not.toHaveBeenCalled();
    });
    it('does not queue changes for an absent backend', async () => {
        const bus = { isConnected: () => false, request: vi.fn() };
        await expect(createGpuService(bus)({ settings: { whisper: true } })).rejects.toThrow('not connected');
        expect(bus.request).not.toHaveBeenCalled();
    });
});
