import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
    canEditOcrAreas, getOcrAreaRevision, isOcrAreaRectangle,
    type OcrAreaSaveRequest, type OcrAreaSaveResult,
} from '../../shared/ocr_areas.js';
import type { ObsScene } from './obs.js';

export function createOcrAreaSaver(dependencies: {
    getScene: () => Promise<ObsScene>;
    getPath: (scene: ObsScene) => string;
    backup: (configPath: string) => Promise<void>;
    reload: () => void;
}) {
    // Serialize preview writes so two clients cannot both replace the same revision.
    let pending: Promise<unknown> = Promise.resolve();
    async function save(request: OcrAreaSaveRequest): Promise<OcrAreaSaveResult> {
        try {
            if (!request || typeof request.sceneId !== 'string' || !request.sceneId ||
                typeof request.sceneName !== 'string' || !request.sceneName ||
                typeof request.expectedRevision !== 'string' || !Array.isArray(request.rectangles) ||
                !request.rectangles.every(isOcrAreaRectangle)) return { success: false, error: 'invalid' };
            const scene = await dependencies.getScene();
            if (scene.id !== request.sceneId || scene.name !== request.sceneName)
                return { success: false, error: 'sceneChanged' };
            const configPath = dependencies.getPath(scene);
            let current = null;
            try {
                current = JSON.parse(await fs.readFile(configPath, 'utf8'));
                if (!current || typeof current !== 'object' || Array.isArray(current))
                    return { success: false, error: 'invalid' };
            } catch (error: any) {
                if (error.code !== 'ENOENT') throw error;
            }
            if (getOcrAreaRevision(current) !== request.expectedRevision)
                return { success: false, error: 'conflict' };
            if (!canEditOcrAreas(current)) return { success: false, error: 'invalid' };
            const config = {
                ...current,
                scene: scene.name,
                coordinate_system: 'percentage',
                rectangles: request.rectangles.map((rectangle) => ({
                    ...rectangle,
                    monitor: rectangle.monitor ?? { index: 0 },
                    is_excluded: Boolean(rectangle.is_excluded),
                    is_secondary: Boolean(rectangle.is_secondary),
                    is_exclusive: Boolean(rectangle.is_exclusive),
                    is_black_hole: Boolean(rectangle.is_black_hole),
                })),
            };
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await dependencies.backup(configPath);
            // Replace atomically so OCR never reads a partially written layout.
            const temporaryPath = configPath + '.preview-tmp';
            try {
                await fs.writeFile(temporaryPath, JSON.stringify(config, null, 4), 'utf8');
                await fs.rename(temporaryPath, configPath);
            } finally {
                await fs.rm(temporaryPath, { force: true });
            }
            dependencies.reload();
            return { success: true, config };
        } catch (error) {
            console.error('[OCR] Failed to save preview areas:', error);
            return { success: false, error: 'failed' };
        }
    }
    return (request: OcrAreaSaveRequest): Promise<OcrAreaSaveResult> => {
        const result = pending.then(() => save(request));
        pending = result;
        return result;
    };
}
