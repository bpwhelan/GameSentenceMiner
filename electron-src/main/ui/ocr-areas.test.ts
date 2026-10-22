import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOcrAreaSaver } from './ocr-areas.js';
import { getOcrAreaRevision } from '../../shared/ocr_areas.js';

describe('saving areas drawn in the preview', () => {
    let directory: string;
    let configPath: string;
    const scene = { id: 'game', name: 'Game' };
    const rectangle = { coordinates: [0.1, 0.7, 0.8, 0.2], is_secondary: true };
    const getScene = vi.fn();
    const backup = vi.fn();
    const reload = vi.fn();
    let save: ReturnType<typeof createOcrAreaSaver>;
    beforeEach(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'gsm-ocr-areas-'));
        configPath = path.join(directory, 'areas.json');
        getScene.mockReset().mockResolvedValue(scene);
        backup.mockReset().mockResolvedValue(undefined);
        reload.mockReset();
        save = createOcrAreaSaver({ getScene, getPath: () => configPath, backup, reload });
    });
    afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
    const request = (config: any = null) => ({
        sceneId: scene.id, sceneName: scene.name,
        expectedRevision: getOcrAreaRevision(config), rectangles: [rectangle]
    });

    it('creates a percentage config compatible with the Python selector and reloads OCR', async () => {
        expect((await save(request())).success).toBe(true);
        const saved = JSON.parse(await readFile(configPath, 'utf8'));
        expect(saved).toMatchObject({ scene: 'Game', coordinate_system: 'percentage', rectangles: [
            { ...rectangle, monitor: { index: 0 }, is_excluded: false, is_black_hole: false, is_exclusive: false }
        ] });
        expect(reload).toHaveBeenCalledOnce();
    });

    it('backs up the old layout and preserves unrelated settings and area metadata', async () => {
        const original = { scene: 'Game', window: 'Window', coordinate_system: 'percentage',
            rectangles: [], language: 'ja', window_geometry: { left: 10, top: 20, width: 1920, height: 1080 } };
        await writeFile(configPath, JSON.stringify(original));
        const metadata = { ...rectangle, monitor: { index: 2, left: 1920 }, custom: 'preserve' };
        await save({ ...request(original), rectangles: [metadata] });
        expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({ ...original, rectangles: [metadata] });
        expect(backup).toHaveBeenCalledWith(configPath);
    });

    it('rejects stale scenes and conflicting edits without overwriting the saved layout', async () => {
        getScene.mockResolvedValue({ id: 'other', name: 'Other' });
        expect(await save(request())).toEqual({ success: false, error: 'sceneChanged' });
        getScene.mockResolvedValue(scene);
        const original = { coordinate_system: 'percentage', rectangles: [rectangle] };
        await writeFile(configPath, JSON.stringify(original));
        expect(await save(request())).toEqual({ success: false, error: 'conflict' });
        expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(original);
        expect(reload).not.toHaveBeenCalled();
    });

    it.each([[0, 0, -1, 1], [0.8, 0, 0.5, 1], [0, 0, NaN, 1], [0, 0, 0, 1]])(
        'rejects invalid coordinates %j', async (...coordinates) => {
            expect(await save({ ...request(), rectangles: [{ coordinates }] })).toEqual({ success: false, error: 'invalid' });
            expect(backup).not.toHaveBeenCalled();
        }
    );

    it('does not overwrite an unreadable config or an unsupported legacy layout', async () => {
        await writeFile(configPath, 'broken json');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await save(request())).toEqual({ success: false, error: 'failed' });
        expect(await readFile(configPath, 'utf8')).toBe('broken json');
        const legacy = { rectangles: [{ coordinates: [10, 10, 100, 100] }] };
        await writeFile(configPath, JSON.stringify(legacy));
        expect(await save(request(legacy))).toEqual({ success: false, error: 'invalid' });
    });

    it('serializes simultaneous saves so only one can replace the same revision', async () => {
        const results = await Promise.all([save(request()), save(request())]);
        expect(results.map((result) => result.success)).toEqual([true, false]);
        expect(results[1]).toEqual({ success: false, error: 'conflict' });
    });
});
