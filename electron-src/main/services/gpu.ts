import type { GpuStatus } from '../../shared/gpu.js';

interface GpuBus {
    isConnected(client: string): boolean;
    request(client: string, topic: string, data: unknown, timeout: number): Promise<unknown>;
}

export function createGpuService(bus: GpuBus) {
    return async (request: unknown = {}): Promise<GpuStatus> => {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid GPU request');
        const { settings, refresh } = request as Record<string, unknown>;
        if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings)
            || Object.entries(settings).some(([key, value]) => !['meiki', 'firered', 'whisper'].includes(key) || typeof value !== 'boolean'))) {
            throw new Error('Invalid GPU settings');
        }
        if (!bus.isConnected('backend')) throw new Error('The GSM backend is not connected.');
        const result = await bus.request('backend', 'gpu.settings', { ...(settings === undefined ? {} : { settings }), refresh: refresh === true }, 15_000);
        if (!result || typeof result !== 'object') throw new Error('Invalid GPU response');
        if ('error' in result) throw new Error(String(result.error));
        if (!('settings' in result) || !('diagnostics' in result)) throw new Error('Invalid GPU status');
        return result as GpuStatus;
    };
}
