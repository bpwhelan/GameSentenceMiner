import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let running = false;
const startOverlayAppMock = vi.fn(async () => {
    running = true;
});
const stopOverlayAppMock = vi.fn(async () => {
    running = false;
});
const openSettingsMock = vi.fn();
const overlayModuleMock = {
    startOverlayApp: startOverlayAppMock,
    stopOverlayApp: stopOverlayAppMock,
    isOverlayRunning: () => running,
    openSettings: openSettingsMock,
};
const requireMock = Object.assign(vi.fn(() => overlayModuleMock), {
    cache: {} as Record<string, unknown>,
});
const existsSyncMock = vi.fn(() => true);

vi.mock('node:module', () => ({
    createRequire: () => requireMock,
}));

vi.mock('node:fs', () => ({
    existsSync: existsSyncMock,
}));

vi.mock('./data_dir.js', () => ({
    getBaseDir: () => 'C:\gsm-data',
    getDefaultBaseDir: () => 'C:\default-gsm-data',
}));

vi.mock('./util.js', () => ({
    getOverlayAppAsarPath: () => 'C:\overlay-out\resources\app.asar',
    getOverlayResourcesPath: () => 'C:\overlay-out\resources',
    getResourcesDir: () => 'C:\repo',
    isDev: true,
    OVERLAY_RESOURCES_ENV: 'GSM_OVERLAY_RESOURCES_PATH',
}));

describe('in-process overlay runtime', () => {
    const environmentKeys = [
        'GSM_OVERLAY_IN_PROCESS',
        'GSM_OVERLAY_SHARED_RUNTIME',
        'GSM_OVERLAY_RESOURCES_PATH',
        'GSM_OVERLAY_DATA_PATH',
    ];
    let originalEnvironment: Record<string, string | undefined>;

    beforeEach(() => {
        running = false;
        startOverlayAppMock.mockClear();
        stopOverlayAppMock.mockClear();
        openSettingsMock.mockClear();
        requireMock.mockClear();
        existsSyncMock.mockReturnValue(true);
        originalEnvironment = Object.fromEntries(
            environmentKeys.map((key) => [key, process.env[key]]),
        );
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(originalEnvironment)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it('loads, stops, and removes the overlay module from the require cache', async () => {
        const entryPath = path.join('C:\repo', 'GSM_Overlay', 'main.js');
        requireMock.cache[entryPath] = { id: entryPath };
        const runtime = await import('./overlay_runtime.js');

        await expect(runtime.startInProcessOverlay()).resolves.toBe(true);

        expect(requireMock).toHaveBeenCalledWith(entryPath);
        expect(startOverlayAppMock).toHaveBeenCalledTimes(1);
        expect(process.env.GSM_OVERLAY_IN_PROCESS).toBe('1');
        expect(process.env.GSM_OVERLAY_DATA_PATH).toBe(path.join('C:\gsm-data', 'gsm_overlay'));
        expect(runtime.isInProcessOverlayRunning()).toBe(true);

        expect(runtime.stopInProcessOverlay()).toBe(true);
        await runtime.waitForInProcessOverlayShutdown();

        expect(stopOverlayAppMock).toHaveBeenCalledTimes(1);
        expect(requireMock.cache[entryPath]).toBeUndefined();
        expect(runtime.isInProcessOverlayRunning()).toBe(false);
        expect(process.env.GSM_OVERLAY_IN_PROCESS).toBe(originalEnvironment.GSM_OVERLAY_IN_PROCESS);
    });

    it('restarts with a fresh module and restores the System settings tab', async () => {
        const runtime = await import('./overlay_runtime.js');
        await runtime.startInProcessOverlay();
        const host = (globalThis as any)[Symbol.for('gsm.overlay.host')];
        const restart = host.requestRestart('system');
        const duplicate = host.requestRestart('system');
        await expect(restart).resolves.toBe(true);
        await expect(duplicate).resolves.toBe(true);
        expect(stopOverlayAppMock).toHaveBeenCalledTimes(1);
        expect(startOverlayAppMock).toHaveBeenCalledTimes(2);
        expect(requireMock).toHaveBeenCalledTimes(2);
        expect(openSettingsMock).toHaveBeenCalledExactlyOnceWith('system');
        expect(runtime.isInProcessOverlayRunning()).toBe(true);
        runtime.stopInProcessOverlay();
        await runtime.waitForInProcessOverlayShutdown();
    });

    it('does not restart after a later stop request during shutdown', async () => {
        const runtime = await import('./overlay_runtime.js');
        await runtime.startInProcessOverlay();
        const host = (globalThis as any)[Symbol.for('gsm.overlay.host')];
        const restart = host.requestRestart('system');
        runtime.stopInProcessOverlay();
        await expect(restart).resolves.toBe(false);
        expect(startOverlayAppMock).toHaveBeenCalledTimes(1);
        expect(openSettingsMock).not.toHaveBeenCalled();
        expect(runtime.isInProcessOverlayRunning()).toBe(false);
    });

    it('reports a failed replacement instead of treating it as a successful switch', async () => {
        const runtime = await import('./overlay_runtime.js');
        await runtime.startInProcessOverlay();
        const host = (globalThis as any)[Symbol.for('gsm.overlay.host')];
        startOverlayAppMock.mockRejectedValueOnce(new Error('extension load failed'));
        await expect(host.requestRestart('system')).rejects.toThrow('Could not restart the overlay');
        expect(openSettingsMock).not.toHaveBeenCalled();
        expect(runtime.isInProcessOverlayRunning()).toBe(false);
    });
});
