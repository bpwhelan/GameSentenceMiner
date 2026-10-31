import type { MeikiModelStatus } from '../../shared/meiki_ocr.js';

interface ModelBus {
    isConnected(client: string): boolean;
    request(client: string, topic: string, data: unknown, timeoutMs: number): Promise<unknown>;
}

export function createMeikiModelService(bus: ModelBus) {
    return async (request: unknown = {}): Promise<MeikiModelStatus> => {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid model request');
        const model = (request as Record<string, unknown>).model;
        if (model !== undefined && model !== 'small' && model !== 'large') {
            throw new Error('Invalid MeikiOCR model size');
        }
        if (!bus.isConnected('backend')) throw new Error('The GSM backend is not connected.');
        const result = await bus.request('backend', 'ocr.meiki_model', model === undefined ? {} : { model }, model === undefined ? 5000 : 120_000);
        if (!result || typeof result !== 'object' || !['small', 'large'].includes((result as MeikiModelStatus).model)) {
            throw new Error('Invalid MeikiOCR model status');
        }
        return result as MeikiModelStatus;
    };
}
