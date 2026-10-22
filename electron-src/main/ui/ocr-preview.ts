import type {
    OcrPreviewBox,
    OcrPreviewFrame,
    OcrPreviewRequest,
} from '../../shared/ocr_preview.js';

interface PreviewBus {
    isConnected(client: string): boolean;
    request(client: string, topic: string, data: unknown, timeoutMs: number): Promise<unknown>;
}

function matchingBoxes(value: unknown, frame: OcrPreviewFrame): OcrPreviewBox[] {
    if (!value || typeof value !== 'object') return [];
    const data = value as Record<string, any>;
    if (
        data.sceneName !== frame.sceneName ||
        data.sourceName !== frame.sourceName ||
        !Number.isFinite(data.sourceWidth) ||
        !Number.isFinite(data.sourceHeight) ||
        !(data.sourceWidth > 0) ||
        !(data.sourceHeight > 0) ||
        Math.abs(data.sourceWidth / data.sourceHeight - frame.width / frame.height) > 0.03 ||
        !Array.isArray(data.boxes)
    )
        return [];
    return data.boxes
        .slice(0, 200)
        .filter(
            (box: any) =>
                Array.isArray(box?.points) &&
                box.points.length === 4 &&
                box.points.every(
                    (p: unknown) =>
                        Array.isArray(p) &&
                        p.length === 2 &&
                        p.every(
                            (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1,
                        ),
                ),
        )
        .map((box: any) => ({ points: box.points, text: String(box.text ?? '').slice(0, 256) }));
}

export function createOcrPreviewService(bus: PreviewBus) {
    let pending: { key: string; result: Promise<OcrPreviewFrame | null> } | null = null;
    let cached: { key: string; at: number; frame: OcrPreviewFrame | null } | null = null;
    return (request: OcrPreviewRequest): Promise<OcrPreviewFrame | null> => {
        if (
            !request ||
            typeof request.sceneId !== 'string' ||
            !request.sceneId ||
            typeof request.sceneName !== 'string' ||
            !request.sceneName ||
            !bus.isConnected('backend')
        )
            return Promise.resolve(null);
        const key = JSON.stringify([
            request.sceneId,
            request.sceneName,
            Boolean(request.includeBoxes),
        ]);
        const sceneKey = JSON.stringify([request.sceneId, request.sceneName]);
        if (pending) {
            if (pending.key !== sceneKey) return Promise.resolve(null);
            return pending.result.then((frame) =>
                frame && !request.includeBoxes ? { ...frame, boxes: [] } : frame,
            );
        }
        if (cached?.key === key && Date.now() - cached.at < 500)
            return Promise.resolve(cached.frame);
        const result = (async (): Promise<OcrPreviewFrame | null> => {
            const [capture, geometry] = await Promise.allSettled([
                bus.request(
                    'backend',
                    'capture.preview',
                    { sceneId: request.sceneId, sceneName: request.sceneName },
                    4000,
                ),
                bus.isConnected('ocr')
                    ? bus.request(
                          'ocr',
                          'ocr.preview',
                          { enabled: Boolean(request.includeBoxes), sceneName: request.sceneName },
                          1500,
                      )
                    : Promise.resolve(null),
            ]);
            const frame =
                capture.status === 'fulfilled' ? (capture.value as OcrPreviewFrame | null) : null;
            if (
                !frame ||
                frame.sceneId !== request.sceneId ||
                frame.sceneName !== request.sceneName ||
                typeof frame.sourceName !== 'string' ||
                typeof frame.imageData !== 'string' ||
                !frame.imageData.startsWith('data:image/jpeg;base64,') ||
                frame.imageData.length > 3_000_000 ||
                !Number.isFinite(frame.width) ||
                !Number.isFinite(frame.height) ||
                frame.width <= 0 ||
                frame.height <= 0
            )
                return null;
            return {
                ...frame,
                boxes:
                    request.includeBoxes && geometry.status === 'fulfilled'
                        ? matchingBoxes(geometry.value, frame)
                        : [],
            };
        })()
            .catch(() => null)
            .then((frame) => {
                cached = { key, at: Date.now(), frame };
                return frame;
            })
            .finally(() => {
                pending = null;
            });
        pending = { key: sceneKey, result };
        return result;
    };
}
