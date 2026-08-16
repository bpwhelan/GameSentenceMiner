import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { sanitizeEngineHookMessage } from '../protocol.js';
import { loadEngineHookSupport, type EngineHookSupport } from '../support.js';
import { getEngineHookDecoder, listEngineHookDecoderIds } from './index.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetsDirectory = path.resolve(currentDirectory, '../../../assets/engine_hooks');

function textLayout(
    positionedCodes: { engineIndex: number; code: number; x: number; y: number; width: number; height: number }[],
    candidates?: string[],
) {
    const message = sanitizeEngineHookMessage({
        schema: 'gsm_engine_hook_message_v1',
        type: 'text-layout',
        integrationId: 'test',
        sequence: 1,
        capturedAt: 1,
        callerOffset: null,
        mode: 0,
        style: 0,
        coordinateSpace: {
            kind: 'scaled-window-client',
            clientWidth: 1280,
            clientHeight: 720,
            scaleX: 1,
            scaleY: 1,
        },
        positionedCodes,
        ...(candidates ? { candidates } : {}),
    });
    if (!message || message.type !== 'text-layout') throw new Error('Expected a text-layout message.');
    return message;
}

function supportStub(decoder: string): EngineHookSupport {
    return {
        directory: '',
        payloadSource: '',
        manifest: { decoder } as EngineHookSupport['manifest'],
    };
}

describe('engine-hook decoder registry', () => {
    it('registers every shipped decoder id', () => {
        expect(listEngineHookDecoderIds()).toEqual(['bgi-v1', 'mages-v1', 'vlr-v1']);
    });

    it('refuses an unknown decoder instead of falling back to one', () => {
        expect(() => getEngineHookDecoder('not-an-engine-v1')).toThrow(
            /Unsupported engine-hook decoder/u,
        );
        expect(() => getEngineHookDecoder(undefined)).toThrow(/Unsupported engine-hook decoder/u);
    });

    it('decodes a MAGES layout through the registry using package resources', () => {
        const support = loadEngineHookSupport(path.join(assetsDirectory, 'mages-steins-gate-steam'));
        const message = textLayout(
            [0x0301, 0x0729, 0x0a9e, 0x0aa9, 0x0afe, 0x051b].map((code, engineIndex) => ({
                engineIndex,
                code,
                x: engineIndex * 20,
                y: 0,
                width: 20,
                height: 30,
            })),
        );

        const decoded = getEngineHookDecoder(support.manifest.decoder).decodeLayout(message, support);

        expect(decoded?.text).toBe('日曰褄棲凪風');
        expect(decoded?.glyphs).toHaveLength(6);
        expect(decoded?.lines).toHaveLength(1);
    });

    it('decodes a VLR layout through the registry', () => {
        const message = textLayout(
            [0x3053, 0x308c, 0x306f].map((code, engineIndex) => ({
                engineIndex,
                code,
                x: engineIndex * 28,
                y: 34,
                width: 28,
                height: 34,
            })),
        );

        const decoded = getEngineHookDecoder('vlr-v1').decodeLayout(message, supportStub('vlr-v1'));

        expect(decoded?.text).toBe('これは');
        expect(decoded?.lines).toHaveLength(1);
    });

    it('decodes a BGI layout through the registry by pairing a candidate string', () => {
        const message = textLayout(
            [10, 40, 70].map((x, engineIndex) => ({
                engineIndex,
                code: 0,
                x,
                y: 13,
                width: 28,
                height: 42,
            })),
            ['メデューサ兵', 'あいう'],
        );

        const decoded = getEngineHookDecoder('bgi-v1').decodeLayout(message, supportStub('bgi-v1'));

        expect(decoded?.text).toBe('あいう');
    });
});
