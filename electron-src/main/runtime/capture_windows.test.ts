import { describe, expect, it, vi } from 'vitest';
const sources = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ desktopCapturer: { getSources: sources } }));
import { listCaptureWindows } from './capture_windows.js';

describe('native capture window identity', () => {
    it('uses native executable paths without capturing pixels or guessing inaccessible processes', async () => {
        sources.mockResolvedValue([
            { name: '月姫', processPath: 'C:\\Games\\game.exe' },
            { name: 'Protected game', processPath: null },
            { name: 'Closed window' },
        ]);
        expect(await listCaptureWindows()).toEqual([{ title: '月姫', path: 'C:\\Games\\game.exe' }]);
        expect(sources).toHaveBeenCalledWith({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    });
    it('propagates native capture errors for callers to handle', async () => {
        sources.mockRejectedValue(new Error('Window enumeration unavailable'));
        await expect(listCaptureWindows()).rejects.toThrow('Window enumeration unavailable');
    });
});
