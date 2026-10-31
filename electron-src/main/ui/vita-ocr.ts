import type { VitaModelStatus } from '../../shared/vita_ocr.js';

interface ModelBus {
    isConnected(client: string): boolean;
    request(client: string, topic: string, data: unknown, timeoutMs: number): Promise<unknown>;
}

export function createVitaModelService(bus: ModelBus) {
    return async (request: unknown = {}): Promise<VitaModelStatus> => {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid model request');
        const model = (request as Record<string, unknown>).model;
        if (model !== undefined && !['small', 'normal', 'large'].includes(String(model))) {
            throw new Error('Invalid VOCR model size');
        }
        if (!bus.isConnected('backend')) throw new Error('The GSM backend is not connected.');
        const result = await bus.request('backend', 'ocr.vita_model', model === undefined ? {} : { model }, model === undefined ? 5000 : 300_000);
        if (!result || typeof result !== 'object' || !['small', 'normal', 'large'].includes((result as VitaModelStatus).model)) {
            throw new Error('Invalid VOCR model status');
        }
        return result as VitaModelStatus;
    };
}
