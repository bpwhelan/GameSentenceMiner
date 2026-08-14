import { describe, expect, it } from 'vitest';

import { deriveEngineLogicalCoordinateSpace, sanitizeEngineHookMessage } from './protocol.js';

const coordinateSpace = (
    clientWidth = 1920,
    clientHeight = 1080,
    scaleX = 1.5,
    scaleY = 1.5,
) => ({
    kind: 'scaled-window-client',
    clientWidth,
    clientHeight,
    scaleX,
    scaleY,
});

describe('engine-hook protocol', () => {
    it('accepts a bounded text-layout message', () => {
        const message = sanitizeEngineHookMessage({
            schema: 'gsm_engine_hook_message_v1',
            type: 'text-layout',
            integrationId: 'mages-steins-gate-steam',
            sequence: 4,
            capturedAt: 123,
            callerOffset: '0x47c71',
            mode: 0,
            style: 8,
            coordinateSpace: coordinateSpace(),
            positionedCodes: [
                { engineIndex: 0, code: 1, x: 100, y: 200, width: 20, height: 30 },
            ],
        });

        expect(message?.type).toBe('text-layout');
    });

    it('derives logical dimensions from each live window and engine-scale measurement', () => {
        expect(deriveEngineLogicalCoordinateSpace(coordinateSpace(1280, 720, 1, 1))).toEqual({
            kind: 'engine-logical',
            width: 1280,
            height: 720,
        });
        expect(deriveEngineLogicalCoordinateSpace(coordinateSpace(1920, 1080, 1.5, 1.5))).toEqual({
            kind: 'engine-logical',
            width: 1280,
            height: 720,
        });
        expect(deriveEngineLogicalCoordinateSpace(coordinateSpace(1600, 900, 1.25, 1.25))).toEqual({
            kind: 'engine-logical',
            width: 1280,
            height: 720,
        });
        expect(
            deriveEngineLogicalCoordinateSpace({ kind: 'window-client', width: 1920, height: 1080 }),
        ).toBeNull();
        expect(deriveEngineLogicalCoordinateSpace(coordinateSpace(1920, 1080, 0, 1.5))).toBeNull();
        expect(
            deriveEngineLogicalCoordinateSpace(coordinateSpace(1920, 1080, Number.NaN, 1.5)),
        ).toBeNull();
    });

    it('normalizes scaled client measurements and rejects fixed coordinate claims', () => {
        const message = (measuredCoordinateSpace: unknown) => ({
            schema: 'gsm_engine_hook_message_v1',
            type: 'text-layout',
            integrationId: 'mages-steins-gate-steam',
            sequence: 4,
            capturedAt: 123,
            callerOffset: '0x47c71',
            mode: 0,
            style: 8,
            coordinateSpace: measuredCoordinateSpace,
            positionedCodes: [
                { engineIndex: 0, code: 1, x: 100, y: 200, width: 20, height: 30 },
            ],
        });

        expect(sanitizeEngineHookMessage(message(coordinateSpace()))?.coordinateSpace).toEqual({
            kind: 'engine-logical',
            width: 1280,
            height: 720,
        });
        expect(
            sanitizeEngineHookMessage(
                message({ kind: 'fixed', width: 1280, height: 720 }),
            ),
        ).toBeNull();
    });

    it('rejects malformed or oversized target data', () => {
        expect(
            sanitizeEngineHookMessage({
                schema: 'gsm_engine_hook_message_v1',
                type: 'text-layout',
                integrationId: 'mages-steins-gate-steam',
                sequence: 1,
                capturedAt: 1,
                callerOffset: null,
                mode: 0,
                style: 8,
                coordinateSpace: coordinateSpace(),
                positionedCodes: [
                    { engineIndex: 0, code: 1, x: Number.NaN, y: 0, width: 20, height: 30 },
                ],
            }),
        ).toBeNull();

        expect(
            sanitizeEngineHookMessage({
                schema: 'gsm_engine_hook_message_v1',
                type: 'text-layout',
                integrationId: 'mages-steins-gate-steam',
                sequence: 1,
                capturedAt: 1,
                callerOffset: null,
                mode: 0,
                style: 8,
                coordinateSpace: coordinateSpace(),
                positionedCodes: Array.from({ length: 2001 }, (_, engineIndex) => ({
                    engineIndex,
                    code: 1,
                    x: 0,
                    y: 0,
                    width: 20,
                    height: 30,
                })),
            }),
        ).toBeNull();
    });
});
