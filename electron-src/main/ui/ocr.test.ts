import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { manager, send, sendOcrStatus, handlers, openPath, baseDir } = vi.hoisted(() => ({
    manager: { isRunning: vi.fn(), stop: vi.fn() },
    send: vi.fn(),
    sendOcrStatus: vi.fn(),
    handlers: new Map<string, (...args: any[]) => any>(),
    openPath: vi.fn(),
    baseDir: String.raw`C:\Users\Sam %TEMP% & O'Brien 日本語\GSM`,
}));

vi.mock('electron', () => ({
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), on: vi.fn() },
    shell: { openPath },
}));
vi.mock('../store.js', () => ({}));
vi.mock('../util.js', () => ({ BASE_DIR: baseDir, sanitizeFilename: (name: string) => name }));
vi.mock('../main.js', () => ({
    mainWindow: {
        isDestroyed: () => false,
        webContents: { mainFrame: { framesInSubtree: [{ detached: false, send }] } },
    },
    sendOcrStatus,
}));
vi.mock('./obs.js', () => ({ getCurrentScene: async () => ({ name: '$1 [GSM]' }) }));
vi.mock('../runtime/bus_client.js', () => ({}));
vi.mock('../runtime/process_supervisor.js', () => ({ getProcessManager: () => manager }));
vi.mock('../services/python_ops.js', () => ({}));

import { getOCRRuntimeState, registerOCRUtilsIPC, stopOCR } from './ocr.js';

beforeEach(() => {
    manager.isRunning.mockReturnValue(true);
    manager.stop.mockReset().mockResolvedValue(undefined);
});

describe('opening OCR configuration paths', () => {
    beforeEach(() => {
        handlers.clear();
        openPath.mockReset().mockResolvedValue('');
        registerOCRUtilsIPC();
    });

    it.each([
        ['ocr.open-config-json', path.join(baseDir, 'ocr_config', '$1 [GSM].json')],
        ['ocr.open-config-folder', path.join(baseDir, 'ocr_config')],
    ])('opens %s as a literal path', async (channel, expectedPath) => {
        await expect(handlers.get(channel)!()).resolves.toBe(true);
        expect(openPath).toHaveBeenCalledWith(expectedPath);
    });

    it('reports a failed file association instead of reporting success', async () => {
        openPath.mockResolvedValue('No application is associated with this file');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(handlers.get('ocr.open-config-json')!()).rejects.toThrow('No application is associated');
    });
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
