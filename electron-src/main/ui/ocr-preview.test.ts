import { describe, expect, it, vi } from 'vitest';
import { createOcrPreviewService } from './ocr-preview.js';

const frame = {
    sceneId: 'scene',
    sceneName: 'Game',
    sourceName: 'Window',
    imageData: 'data:image/jpeg;base64,YQ==',
    width: 960,
    height: 540,
};
const detection = {
    sceneName: 'Game',
    sourceName: 'Window',
    sourceWidth: 1920,
    sourceHeight: 1080,
    boxes: [
        {
            points: [
                [0.1, 0.7],
                [0.8, 0.7],
                [0.8, 0.9],
                [0.1, 0.9],
            ],
            text: 'Dialogue',
        },
    ],
};
const request = { sceneId: 'scene', sceneName: 'Game', includeBoxes: true };
function setup(boxes = detection) {
    const bus = {
        isConnected: vi.fn(() => true),
        request: vi.fn(async (client: string) => (client === 'backend' ? frame : boxes)),
    };
    return { bus, service: createOcrPreviewService(bus) };
}

describe('OCR capture previews', () => {
    it('combines the source image and OCR geometry without starting recognition', async () => {
        const { bus, service } = setup();
        expect(await service(request)).toMatchObject({ ...frame, boxes: detection.boxes });
        expect(bus.request).toHaveBeenCalledWith(
            'backend',
            'capture.preview',
            expect.objectContaining({ sceneName: 'Game' }),
            4000,
        );
        expect(bus.request).toHaveBeenCalledWith(
            'ocr',
            'ocr.preview',
            { enabled: true, sceneName: 'Game' },
            1500,
        );
    });

    it.each([
        { ...detection, sourceName: 'Other window' },
        { ...detection, sceneName: 'Other game' },
        { ...detection, sourceWidth: 1000, sourceHeight: 1000 },
    ])('does not overlay mismatched source geometry', async (boxes) => {
        const { service } = setup(boxes);
        expect(await service(request)).toMatchObject({ imageData: frame.imageData, boxes: [] });
    });

    it('can show the game without an OCR process and handles unavailable capture', async () => {
        const { bus, service } = setup();
        bus.isConnected.mockImplementation((client?: string) => client !== 'ocr');
        expect(await service(request)).toMatchObject({ boxes: [], imageData: frame.imageData });
        expect(bus.request).toHaveBeenCalledTimes(1);
        const unavailable = setup();
        unavailable.bus.request.mockRejectedValue(new Error('offline'));
        expect(await unavailable.service(request)).toBeNull();
    });

    it('coalesces pending captures and rejects late frames from a different scene', async () => {
        const { bus, service } = setup();
        let resolve!: (value: any) => void;
        bus.request.mockImplementation((client: string) =>
            client === 'backend'
                ? new Promise((done) => {
                      resolve = done;
                  })
                : Promise.resolve(detection),
        );
        const first = service(request);
        const second = service(request);
        resolve({ ...frame, sceneId: 'previous' });
        expect(await first).toBeNull();
        expect(await second).toBeNull();
        expect(bus.request.mock.calls.filter((call) => call[0] === 'backend')).toHaveLength(1);
    });

    it('keeps a pending frame available when text boxes are toggled', async () => {
        const { bus, service } = setup();
        let resolve!: (value: any) => void;
        bus.request.mockImplementation((client: string) =>
            client === 'backend'
                ? new Promise((done) => {
                      resolve = done;
                  })
                : Promise.resolve(detection),
        );
        const withBoxes = service(request);
        const withoutBoxes = service({ ...request, includeBoxes: false });
        resolve(frame);
        expect(await withBoxes).toMatchObject({
            imageData: frame.imageData,
            boxes: detection.boxes,
        });
        expect(await withoutBoxes).toMatchObject({ imageData: frame.imageData, boxes: [] });
        expect(bus.request.mock.calls.filter((call) => call[0] === 'backend')).toHaveLength(1);
    });
});
