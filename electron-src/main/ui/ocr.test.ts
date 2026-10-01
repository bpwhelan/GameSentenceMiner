import { beforeEach, describe, expect, it, vi } from 'vitest';

const { manager, send, sendOcrStatus } = vi.hoisted(() => ({
    manager: { isRunning: vi.fn(), stop: vi.fn() },
    send: vi.fn(),
    sendOcrStatus: vi.fn(),
}));

vi.mock('electron', () => ({}));
vi.mock('../store.js', () => ({}));
vi.mock('../util.js', () => ({ BASE_DIR: 'test-data' }));
vi.mock('../main.js', () => ({
    mainWindow: {
        isDestroyed: () => false,
        webContents: { mainFrame: { framesInSubtree: [{ detached: false, send }] } },
    },
    sendOcrStatus,
}));
vi.mock('./obs.js', () => ({}));
vi.mock('../runtime/bus_client.js', () => ({}));
vi.mock('../runtime/process_supervisor.js', () => ({ getProcessManager: () => manager }));
vi.mock('../services/python_ops.js', () => ({}));

import { getOCRRuntimeState, stopOCR } from './ocr.js';

beforeEach(() => {
    manager.isRunning.mockReturnValue(true);
    manager.stop.mockReset().mockResolvedValue(undefined);
});

describe('OCR stop requests', () => {
    it('reports a failed stop to the OCR panel without an unhandled rejection or a false stopped event', async () => {
        const error = Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' });
        manager.stop.mockRejectedValue(error);
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(stopOCR({ reason: 'user-stop-request' })).toBe(true);
        // Let the fire-and-forget request settle; Vitest also fails on unhandled rejections.
        await new Promise((resolve) => setImmediate(resolve));

        expect(logged).toHaveBeenCalledWith('[OCR] Failed to stop process:', error);
        expect(send).toHaveBeenCalledWith('ocr-ipc-error', 'Failed to stop OCR: spawn taskkill ENOENT');
        expect(send).not.toHaveBeenCalledWith('ocr-stopped');
        expect(sendOcrStatus).not.toHaveBeenCalledWith(false);
        expect(getOCRRuntimeState().isRunning).toBe(true);

        manager.stop.mockResolvedValue(undefined);
        expect(stopOCR({ reason: 'retry' })).toBe(true);
        await new Promise((resolve) => setImmediate(resolve));
        expect(manager.stop).toHaveBeenCalledTimes(2);
    });

    it('preserves the graceful stop reason and waits for lifecycle events to report completion', async () => {
        expect(stopOCR({ reason: 'user-stop-request' })).toBe(true);
        await Promise.resolve();

        expect(manager.stop).toHaveBeenCalledWith('ocr', {
            gracefulStopData: { command: 'stop', data: { reason: 'user-stop-request' } },
        });
        expect(send).not.toHaveBeenCalled();
    });

    it('does not stop an inactive process or a different source', () => {
        manager.isRunning.mockReturnValue(false);
        expect(stopOCR({ reason: 'user-stop-request' })).toBe(false);
        manager.isRunning.mockReturnValue(true);
        expect(stopOCR({ reason: 'automation-stop', onlyIfSource: 'auto-launcher' })).toBe(false);
        expect(manager.stop).not.toHaveBeenCalled();
    });
});
